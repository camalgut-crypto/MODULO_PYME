"""Conexión a SQL Server; credenciales en el Administrador de credenciales de Windows (keyring)."""
import re
import tomllib
from pathlib import Path

import keyring
import pandas as pd

import sys

# Empaquetado como .exe (PyInstaller): la carpeta del .exe hace de raíz (ahí van worker/config.toml y worker/sql)
RAIZ = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent.parent
CLAVE_USUARIO = "__usuario__"
LEGACY = "SQL Server"  # viene con Windows: sirve en PCs sin SQL Server ni drivers instalados


def leer_config(ruta: Path = RAIZ / "worker" / "config.toml") -> dict:
    with open(ruta, "rb") as f:
        return tomllib.load(f)


def _driver(configurado: str, instalados: list[str]) -> str:
    if configurado in instalados:
        return configurado
    odbc = sorted((d for d in instalados if re.fullmatch(r"ODBC Driver \d+ for SQL Server", d)),
                  key=lambda d: int(re.search(r"\d+", d).group()))
    if odbc:
        return odbc[-1]
    if LEGACY in instalados:
        return LEGACY
    raise ConnectionError(f"No está instalado '{configurado}' ni otro driver ODBC de SQL Server.")


def conectar(cfg: dict):
    import pyodbc

    usuario = keyring.get_password(cfg["servicio_credenciales"], CLAVE_USUARIO)
    contrasena = keyring.get_password(cfg["servicio_credenciales"], usuario) if usuario else None
    if not usuario or not contrasena:
        raise RuntimeError(f"No hay credenciales SQL guardadas en keyring '{cfg['servicio_credenciales']}'. "
                           "Configúrelas con: ModuloPYME_Carga.exe --configurar (o actualizar.py --configurar).")
    driver = _driver(cfg["driver"], pyodbc.drivers())
    # El driver de Windows no negocia el TLS moderno del servidor: con él la conexión va sin cifrar (red interna)
    cifrado = "" if driver == LEGACY else "Encrypt=yes;TrustServerCertificate=yes;"
    cadena = (f"DRIVER={{{driver}}};SERVER={cfg['server']};DATABASE={cfg['database']};{cifrado}"
              f"UID={usuario};PWD={contrasena};")
    try:
        return pyodbc.connect(cadena, timeout=30)
    except pyodbc.Error as e:
        # No se repite la cadena de conexión para no exponer la contraseña.
        raise ConnectionError(f"No se pudo conectar a {cfg['server']}: {e.args[-1]}") from None


def consultar(cfg: dict, sql: str) -> pd.DataFrame:
    with conectar(cfg) as cn:
        cur = cn.cursor()
        cur.execute(sql)
        while cur.description is None and cur.nextset():  # salta los pasos que no devuelven filas
            pass
        columnas = [c[0] for c in cur.description]
        filas = cur.fetchall()
    return pd.DataFrame.from_records([tuple(f) for f in filas], columns=columnas)
