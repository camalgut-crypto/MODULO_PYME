# MÃ³dulo PYME

Seguimiento diario de la cartera del equipo PYME (Instacredit Nicaragua): cada crÃ©dito colocado por los promotores del
equipo, con su mora, lo pagado desde el desembolso (interÃ©s, mora, otros cargos y capital), el % amortizado y los
telÃ©fonos y direcciones del cliente.

- App: https://camalgut-crypto.github.io/MODULO_PYME/
- Datos: Supabase de Tiempos DAC (`lzgteejsjxrbadsqlpnd`), tablas `pyme_*`. Cada carga reemplaza la cartera completa.

## Perfiles

| Perfil | QuÃ© ve |
|---|---|
| **Promotor** | Solo los crÃ©ditos que Ã©l colocÃ³, sin saldo ni saldo pagarÃ©. En celular, en tarjetas con telÃ©fonos para llamar. |
| **Jefe del equipo** | Toda la cartera (con saldo pagarÃ© y saldo), resumen por promotor, Excel y **Personal**: agrega promotores desde la lista de colocaciÃ³n, los activa/desactiva y restablece su contraseÃ±a. |
| **Gerente paÃ­s** | Toda la cartera, resumen por promotor y Excel. |
| **Administrador** | Todo, y crea usuarios de jefatura (gerente, jefe, administrador). |

La seguridad estÃ¡ en Supabase (RLS): un promotor nunca recibe crÃ©ditos de otro ni los saldos. Se ingresa con el nombre
completo; la contraseÃ±a temporal (12345678) se cambia en el primer ingreso. Quien ya usa Tiempos DAC o Auditores entra
con su misma contraseÃ±a.

## Datos y reglas

Consulta: `worker/sql/cartera.sql` (servidor SRV-BIJAGUA\RIESGO). Llave: `credito` del loan tape (`JAR 50131`); en la
app va con guion bajo (`JAR_50131`).

| Campo | Fuente |
|---|---|
| Llave, cÃ©dula, nombre, fecha de desembolso, NIT | Loan tape, Ãºltimo corte (`LOAN_TAPE.dbo.loantape_his_ni`). Solo los crÃ©ditos que trae el loan. |
| Promotor | ColocaciÃ³n (`V_BIT_REGIONAL_COLOCACION_new`), por comprobante + consecutivo, filtrado por **cÃ©dula del promotor** |
| CÃ©dula vacÃ­a en el loan | Se toma la de colocaciÃ³n |
| Empresa Genesis, cuotas pagadas, dÃ­as de mora | CENDOC, Ãºltimo corte de Nicaragua |
| Cuotas en mora, monto cuota en mora, Dias Mora MC, saldo pagarÃ©, saldo | MCCOLLECT, su propio Ãºltimo corte |
| % amortizado | 1 âˆ’ saldo / saldo pagarÃ© |
| Pagado (total, interÃ©s, mora, otros cargos, capital) | CHIRICO, pagos de clientes desde el desembolso. Cada pago se repite en cada `f_reporte`: se deja una sola versiÃ³n (comprobante, recibo, crÃ©dito, fecha y monto; la del corte mÃ¡s reciente). Sin pagos queda vacÃ­o. |
| TelÃ©fonos y direcciones | `Dim_Cliente` (CARTERA_REGIONAL), por NIT |

El equipo son los promotores **activos** de la pestaÃ±a Personal: no hay cÃ©dulas fijas en la consulta. La consulta arma
primero la cartera del equipo y filtra cada fuente contra ella (~11 s con 5 promotores; antes 2:36).

## Carga diaria (7:30 a. m.)

Tarea programada **"Modulo PYME - 7.30am"** â†’ `Ejecutar carga.bat` â†’ `worker/actualizar.py --una-vez`.

- Si falla la conexiÃ³n, la consulta no trae crÃ©ditos o CENDOC/MCCOLLECT/CHIRICO no son de hoy o ayer: reintenta
  3 veces cada 10 minutos (`worker/config.toml`). Cada intento queda en `worker/logs/actualizar.log` y en `pyme_cargas`.
- Con 0 crÃ©ditos nunca se reemplaza la cartera. Si tras los 3 intentos las fuentes siguen sin ser del dÃ­a, carga lo
  disponible y la app lo avisa.
- La app muestra siempre la fecha y hora de generaciÃ³n y la fecha de cada fuente, y avisa si los datos no son de hoy o
  si la Ãºltima carga fallÃ³.

**La base de datos (Bijagua / Tortuguero) solo se alcanza desde la red interna.** La app y sus datos estÃ¡n en la nube,
pero la carga debe correr en un equipo de la red encendido a las 7:30. Para no depender de una PC personal: copiar
esta carpeta a un servidor de la red, `py -m venv .venv` y `.venv\Scripts\pip install pandas pyodbc keyring requests`,
guardar las dos credenciales (abajo) con el usuario que correrÃ¡ la tarea y crear ahÃ­ la tarea programada.

Credenciales (Administrador de credenciales de Windows): SQL en keyring `modulo_garantias_sql` (el de Loan Tape);
Supabase con el usuario `sistema` de Tiempos DAC (keyring `tiempos_dac_supabase`).

`worker/actualizar.py --prueba` ejecuta las consultas y muestra un resumen sin subir nada.
`worker/actualizar.py --local CEDULA ...` genera `public/local/datos.json`; la app se revisa con
`.venv\Scripts\python -m http.server 3000 --directory public` y `http://localhost:3000/?local&rol=promotor|jefe|gerente`.

## Puesta en marcha (una vez)

1. Supabase de Tiempos DAC â€º SQL Editor: ejecutar `supabase/schema.sql`.
2. Ejecutar tambiÃ©n `data/instalar_usuarios.sql` (promotores iniciales; no se sube a Git).
3. `Ejecutar carga.bat` para la primera carga.
4. Crear desde la app (Personal) al Gerente paÃ­s y al Jefe del equipo.
