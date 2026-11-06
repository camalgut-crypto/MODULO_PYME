"""Carga diaria del Módulo PYME: ejecuta la consulta de cartera del equipo y la sube a Supabase.

Uso:
  actualizar.py --una-vez               carga (lo que corre la tarea programada de las 7:30)
  actualizar.py --prueba                ejecuta las consultas y muestra un resumen, sin subir nada
  actualizar.py --local [CEDULA ...]    genera public/local/datos.json para revisar la app sin Supabase

Reglas:
  - El equipo son los promotores activos del administrador de personal (pyme_perfiles).
  - Si falla la conexión, la consulta no trae créditos o CENDOC/MCCOLLECT/CHIRICO no son del día, se reintenta
    (intentos / espera_minutos en config.toml). Cada intento queda en worker/logs/actualizar.log y en pyme_cargas.
  - Con 0 créditos nunca se reemplaza la cartera. Si tras los reintentos las fuentes siguen sin ser del día, se carga
    lo que hay con estado "aviso" y la app lo muestra.
"""
import argparse
import json
import logging
import re
import sys
import time as reloj
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyme.conexion import RAIZ, consultar, leer_config  # noqa: E402

LOG = RAIZ / "worker" / "logs" / "actualizar.log"
CEDULA = re.compile(r"^[0-9A-Za-z]{4,20}$")
SALDOS = ["saldopagare", "saldo"]
FUENTES = {"f_loan_tape": "Loan tape", "f_cendoc": "CENDOC", "f_mccollect": "MCCOLLECT", "f_chirico": "CHIRICO"}
DIARIAS = ["f_cendoc", "f_mccollect", "f_chirico"]  # el loan tape es mensual: no se exige que sea del día
ENTEROS = ["dias_mora_mc", "dias_mora"]


class DatosNoFrescos(Exception):
    def __init__(self, msg, fuentes):
        super().__init__(msg)
        self.fuentes = fuentes


def _valor(v):
    if v is None or v is pd.NaT or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, Decimal):
        return float(v)
    if isinstance(v, (pd.Timestamp, datetime, date)):
        return v.strftime("%Y-%m-%d")
    if hasattr(v, "item"):
        return v.item()
    if isinstance(v, str):
        return v.strip() or None
    return v


def consulta_cartera(cfg: dict, cedulas: list[str]) -> pd.DataFrame:
    malas = [c for c in cedulas if not CEDULA.match(c)]
    if malas:  # nunca se arma SQL con un texto que no sea una cédula
        raise ValueError(f"Cédulas de promotor inválidas: {malas}")
    if not cedulas:
        raise ValueError("No hay promotores activos en el equipo")
    sql = (RAIZ / cfg["consultas"]["cartera"]).read_text(encoding="utf-8-sig")
    sql = sql.replace("/*EQUIPO*/", ",".join(f"'{c}'" for c in cedulas))
    t0 = reloj.time()
    df = consultar(cfg["servidor"], sql)
    logging.info("Consulta de cartera: %s créditos de %s promotores (%.0f s)", len(df), len(cedulas), reloj.time() - t0)
    return df


def consulta_catalogo(cfg: dict) -> list[dict]:
    df = consultar(cfg["servidor"], (RAIZ / cfg["consultas"]["promotores"]).read_text(encoding="utf-8-sig"))
    return [{k: _valor(v) for k, v in r.items()} for r in df.to_dict("records")]


def fuentes_de(df: pd.DataFrame) -> dict:
    return {k: _valor(df[k].iloc[0]) for k in FUENTES} if len(df) else {}


def revisar_frescura(fuentes: dict, tolerancia: int):
    minimo = (date.today() - timedelta(days=tolerancia)).isoformat()
    viejas = [f"{FUENTES[k]} del {fuentes[k]}" for k in DIARIAS if not fuentes.get(k) or fuentes[k] < minimo]
    if viejas:
        raise DatosNoFrescos("Datos que no son del día: " + ", ".join(viejas), fuentes)


def armar(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    df = df.copy()
    for c in ENTEROS:
        df[c] = pd.to_numeric(df[c], errors="coerce").round().astype("Int64")
    df["nit"] = df["nit"].map(lambda v: None if v is None or pd.isna(v) else str(int(v)) if float(v).is_integer() else str(v))
    cartera_cols = [c for c in df.columns if c not in SALDOS and c not in FUENTES]
    cartera = [{k: _valor(v) for k, v in r.items()} for r in df[cartera_cols].to_dict("records")]
    saldos = [{k: _valor(v) for k, v in r.items()} for r in df[["llave"] + SALDOS].to_dict("records")]
    return cartera, saldos


def equipo(sb) -> list[str]:
    filas = sb.leer("pyme_perfiles", "&rol=eq.promotor&activo=is.true", "cedula_promotor")
    return sorted({f["cedula_promotor"] for f in filas if f.get("cedula_promotor")})


def un_intento(cfg: dict, sb, ultimo: bool) -> tuple[str, int, str, dict]:
    try:
        n_cat = sb.rpc("pyme_cargar_catalogo", {"p_filas": consulta_catalogo(cfg)})
        logging.info("Catálogo de promotores: %s", n_cat)
    except Exception:  # el catálogo es de apoyo: si falla, la cartera igual se carga
        logging.exception("No se pudo actualizar el catálogo de promotores")
    df = consulta_cartera(cfg, equipo(sb))
    if df.empty:
        raise RuntimeError("La consulta no trajo créditos (no se reemplaza la cartera)")
    fuentes = fuentes_de(df)
    estado, msg = "ok", ""
    try:
        revisar_frescura(fuentes, int(cfg.get("dias_tolerancia", 1)))
    except DatosNoFrescos as e:
        if not ultimo:
            raise
        estado, msg = "aviso", f"{e}. Se cargó lo disponible tras {cfg.get('intentos', 3)} intentos."
    cartera, saldos = armar(df)
    info = {"generado": datetime.now().astimezone().isoformat(timespec="seconds"), "fuentes": fuentes,
            "estado": estado, "mensaje": msg}
    n = sb.rpc("pyme_cargar", {"p_cartera": cartera, "p_saldos": saldos, "p_info": info})
    return estado, n, msg or f"{n} créditos cargados", fuentes


def una_vez(cfg: dict) -> bool:
    from pyme.nube import Supabase
    intentos = int(cfg.get("intentos", 3))
    for i in range(1, intentos + 1):
        inicio = datetime.now().astimezone().isoformat()
        sb, fuentes = None, None
        try:
            sb = Supabase(cfg["supabase"])
            estado, n, msg, fuentes = un_intento(cfg, sb, ultimo=i == intentos)
            logging.info("Intento %s/%s: %s — %s", i, intentos, estado, msg)
            sb.rpc("pyme_registrar_carga", {"p_inicio": inicio, "p_estado": estado, "p_intento": i, "p_filas": n,
                                            "p_mensaje": msg, "p_fuentes": fuentes})
            return True
        except Exception as e:
            fuentes = getattr(e, "fuentes", None)
            logging.exception("Intento %s/%s falló", i, intentos)
            try:
                (sb or Supabase(cfg["supabase"])).rpc("pyme_registrar_carga", {
                    "p_inicio": inicio, "p_estado": "error", "p_intento": i, "p_filas": None,
                    "p_mensaje": str(e)[:1000], "p_fuentes": fuentes})
            except Exception:
                logging.exception("Tampoco se pudo registrar el error en Supabase")
            if i < intentos:
                espera = float(cfg.get("espera_minutos", 10))
                logging.info("Reintento en %s minutos", espera)
                reloj.sleep(espera * 60)
    logging.error("La carga falló %s veces: la app sigue mostrando los datos anteriores con aviso", intentos)
    return False


def prueba(cfg: dict, cedulas: list[str]):
    if not cedulas:
        from pyme.nube import Supabase
        cedulas = equipo(Supabase(cfg["supabase"]))
    cat = consulta_catalogo(cfg)
    df = consulta_cartera(cfg, cedulas)
    print(f"Catálogo: {len(cat)} promotores | Cartera: {len(df)} créditos")
    print(df.groupby("promotor").size().to_string())
    print("Fuentes:", fuentes_de(df))
    try:
        revisar_frescura(fuentes_de(df), int(cfg.get("dias_tolerancia", 1)))
        print("Frescura: ok")
    except DatosNoFrescos as e:
        print("Frescura:", e)


def local(cfg: dict, cedulas: list[str]):
    df = consulta_cartera(cfg, cedulas)
    cartera, saldos = armar(df)
    s = {r["llave"]: r for r in saldos}
    destino = RAIZ / "public" / "local" / "datos.json"
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(json.dumps({
        "cartera": [{**r, **s[r["llave"]]} for r in cartera],
        "catalogo": consulta_catalogo(cfg),
        "ultima_carga": {"generado": datetime.now().astimezone().isoformat(timespec="seconds"),
                         "fuentes": fuentes_de(df), "estado": "ok", "filas": len(cartera)},
    }, ensure_ascii=False), encoding="utf-8")
    logging.info("Escrito %s", destino)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--una-vez", action="store_true")
    g.add_argument("--prueba", nargs="*", metavar="CEDULA")
    g.add_argument("--local", nargs="+", metavar="CEDULA")
    a = ap.parse_args()
    LOG.parent.mkdir(exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.FileHandler(LOG, encoding="utf-8"), logging.StreamHandler()])
    cfg = leer_config()
    if a.local:
        local(cfg, a.local)
    elif a.prueba is not None:
        prueba(cfg, a.prueba)
    else:
        sys.exit(0 if una_vez(cfg) else 1)


if __name__ == "__main__":
    main()
