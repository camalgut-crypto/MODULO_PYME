"""Carga diaria del Módulo PYME: ejecuta la consulta de cartera del equipo y la sube a Supabase.

Uso:
  actualizar.py --escuchar              queda encendido en una PC de la red: atiende el botón Actualizar de la app y la
                                        carga diaria de las 7:30 (pueden ser varias PCs; Supabase reparte el trabajo)
  actualizar.py --una-vez               carga ahora mismo (manual)
  actualizar.py --configurar            guarda y prueba las credenciales (ventanas; para instalar en otra PC)
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


def atender(cfg: dict, sb, trabajo: dict):
    """Un trabajo tomado de la cola: botón Actualizar o un intento de la carga diaria."""
    intentos = int(cfg.get("intentos", 3))
    boton = trabajo["tipo"] == "boton"
    i = trabajo["intento"] or 1
    inicio = datetime.now().astimezone().isoformat()
    try:
        # El botón carga lo disponible aunque una fuente no sea del día (queda con aviso en la app)
        estado, n, msg, fuentes = un_intento(cfg, sb, ultimo=boton or i >= intentos)
        logging.info("%s (intento %s): %s — %s", "Botón" if boton else "Carga diaria", i, estado, msg)
        sb.rpc("pyme_registrar_carga", {"p_inicio": inicio, "p_estado": estado, "p_intento": i, "p_filas": n,
                                        "p_mensaje": msg, "p_fuentes": fuentes})
        sb.rpc("pyme_terminar_trabajo", {"p_id": trabajo["id"], "p_estado": "ok", "p_mensaje": msg})
    except Exception as e:
        logging.exception("%s (intento %s) falló", "Botón" if boton else "Carga diaria", i)
        msg = str(e)[:1000]
        if not boton and i < intentos:
            msg += f" — se reintenta en {cfg.get('espera_minutos', 10)} minutos"
        sb.rpc("pyme_registrar_carga", {"p_inicio": inicio, "p_estado": "error", "p_intento": i, "p_filas": None,
                                        "p_mensaje": msg, "p_fuentes": getattr(e, "fuentes", None)})
        sb.rpc("pyme_terminar_trabajo", {"p_id": trabajo["id"], "p_estado": "error", "p_mensaje": msg})


def escuchar(cfg: dict):
    """Queda encendido: atiende el botón Actualizar y la carga diaria. Puede correr en varias PCs a la vez."""
    import socket
    from pyme.nube import Supabase
    equipo = socket.gethostname()
    logging.info("Escuchando en %s (carga diaria %s)", equipo, cfg.get("hora_diaria", "07:30"))
    while True:
        try:
            sb = Supabase(cfg["supabase"])  # nuevo token en cada vuelta: no caduca aunque quede días encendido
            trabajos = sb.rpc("pyme_tomar_trabajo", {
                "p_equipo": equipo, "p_hora_diaria": cfg.get("hora_diaria", "07:30"),
                "p_intentos": int(cfg.get("intentos", 3)), "p_espera_minutos": int(cfg.get("espera_minutos", 10))})
            for t in trabajos or []:
                atender(cfg, sb, t)
        except Exception:
            logging.exception("Vuelta con error; se reintenta")
        reloj.sleep(20)


def configurar(cfg: dict):
    """Ventanas para guardar las credenciales en el Administrador de credenciales de Windows y probarlas.
    Se usa al instalar el proceso en otra PC (no hace falta consola ni SQL Server instalado)."""
    import tkinter as tk
    from tkinter import messagebox, simpledialog

    import keyring

    from pyme.conexion import CLAVE_USUARIO, conectar
    from pyme.nube import Supabase

    raiz = tk.Tk()
    raiz.withdraw()
    titulo = "Módulo PYME · Proceso de carga"
    srv, sup = cfg["servidor"], cfg["supabase"]
    actual = keyring.get_password(srv["servicio_credenciales"], CLAVE_USUARIO) or ""
    usuario = simpledialog.askstring(titulo, f"Usuario SQL para {srv['server']}:", initialvalue=actual, parent=raiz)
    if usuario is None:
        return
    clave = simpledialog.askstring(titulo, f"Contraseña SQL del usuario {usuario}\n(vacío = dejar la que ya está guardada):",
                                   show="•", parent=raiz)
    if clave is None:
        return
    usuario = usuario.strip()
    if clave:
        keyring.set_password(srv["servicio_credenciales"], CLAVE_USUARIO, usuario)
        keyring.set_password(srv["servicio_credenciales"], usuario, clave)
    clave_sb = simpledialog.askstring(titulo, f"Contraseña del usuario '{sup['usuario']}' de Supabase (Tiempos DAC)\n"
                                              "(vacío = dejar la que ya está guardada):", show="•", parent=raiz)
    if clave_sb is None:
        return
    if clave_sb:
        keyring.set_password(sup["servicio_credenciales"], sup["usuario"], clave_sb)
    resultado = []
    try:
        with conectar(srv) as cn:
            driver = cn.getinfo(6)  # SQL_DRIVER_NAME
            cn.cursor().execute("SELECT 1").fetchall()
        resultado.append(f"✔ SQL ({srv['server']}): conexión correcta (driver {driver})")
    except Exception as e:
        resultado.append(f"✘ SQL: {e}")
    try:
        Supabase(sup)
        resultado.append("✔ Supabase: ingreso correcto")
    except Exception as e:
        resultado.append(f"✘ Supabase: {e}")
    bien = all(r.startswith("✔") for r in resultado)
    (messagebox.showinfo if bien else messagebox.showerror)(titulo, "\n\n".join(resultado), parent=raiz)
    sys.exit(0 if bien else 1)


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
    g.add_argument("--escuchar", action="store_true")
    g.add_argument("--configurar", action="store_true")
    g.add_argument("--prueba", nargs="*", metavar="CEDULA")
    g.add_argument("--local", nargs="+", metavar="CEDULA")
    a = ap.parse_args()
    LOG.parent.mkdir(exist_ok=True)
    manejadores = [logging.FileHandler(LOG, encoding="utf-8")]
    if sys.stderr:  # el .exe sin consola no tiene stderr
        manejadores.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=manejadores)
    cfg = leer_config()
    if a.configurar:
        configurar(cfg)
    elif a.local:
        local(cfg, a.local)
    elif a.prueba is not None:
        prueba(cfg, a.prueba)
    elif a.escuchar:
        escuchar(cfg)
    else:
        sys.exit(0 if una_vez(cfg) else 1)


if __name__ == "__main__":
    main()
