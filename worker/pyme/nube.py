"""Cliente mínimo de Supabase (Auth + PostgREST) para el proceso de carga."""
import keyring
import requests

DOMINIO = "@tiemposdac.local"


class Supabase:
    def __init__(self, cfg: dict):
        if not cfg.get("url") or not cfg.get("anon_key"):
            raise RuntimeError("Falta url / anon_key de Supabase en worker/config.toml")
        self.url, self.key = cfg["url"].rstrip("/"), cfg["anon_key"]
        clave = keyring.get_password(cfg["servicio_credenciales"], cfg["usuario"])
        if not clave:
            raise RuntimeError(f"No hay contraseña del usuario '{cfg['usuario']}' en keyring '{cfg['servicio_credenciales']}'")
        r = requests.post(f"{self.url}/auth/v1/token?grant_type=password", timeout=30,
                          headers={"apikey": self.key},
                          json={"email": cfg["usuario"] + DOMINIO, "password": clave})
        if r.status_code != 200:
            raise ConnectionError(f"Supabase rechazó el ingreso del usuario de sistema: {r.text[:200]}")
        self.h = {"apikey": self.key, "Authorization": f"Bearer {r.json()['access_token']}",
                  "Content-Type": "application/json"}

    def _ok(self, r):
        if r.status_code >= 300:
            raise RuntimeError(f"Supabase {r.status_code}: {r.text[:300]}")
        return r.json() if r.text else None

    def leer(self, tabla: str, filtro: str = "", columnas: str = "*") -> list[dict]:
        return self._ok(requests.get(f"{self.url}/rest/v1/{tabla}?select={columnas}{filtro}", headers=self.h, timeout=60))

    def rpc(self, funcion: str, args: dict):
        return self._ok(requests.post(f"{self.url}/rest/v1/rpc/{funcion}", headers=self.h, json=args, timeout=300))
