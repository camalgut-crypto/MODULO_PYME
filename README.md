# Módulo PYME

Seguimiento diario de la cartera del equipo PYME (Instacredit Nicaragua): cada crédito colocado por los promotores del
equipo, con su mora, lo pagado desde el desembolso (interés, mora, otros cargos y capital), el % amortizado y los
teléfonos y direcciones del cliente.

- App: https://camalgut-crypto.github.io/MODULO_PYME/
- Datos: Supabase de Tiempos DAC (`lzgteejsjxrbadsqlpnd`), tablas `pyme_*`. Cada carga reemplaza la cartera completa.

## Perfiles

| Perfil | Qué ve |
|---|---|
| **Promotor** | Solo los créditos que él colocó, sin saldo ni saldo pagaré. En celular, en tarjetas con teléfonos para llamar. |
| **Jefe del equipo** | Toda la cartera (con saldo pagaré y saldo), resumen por promotor, Excel y **Personal**: agrega promotores desde la lista de colocación, los activa/desactiva y restablece su contraseña. |
| **Gerente país** | Toda la cartera, resumen por promotor y Excel. |
| **Administrador** | Todo, y crea usuarios de jefatura (gerente, jefe, administrador). |

La seguridad está en Supabase (RLS): un promotor nunca recibe créditos de otro ni los saldos. Se ingresa con el nombre
completo; la contraseña temporal (12345678) se cambia en el primer ingreso. Quien ya usa Tiempos DAC o Auditores entra
con su misma contraseña.

## Datos y reglas

Consulta: `worker/sql/cartera.sql` (servidor SRV-BIJAGUA\RIESGO). Llave: `credito` del loan tape (`JAR 50131`); en la
app va con guion bajo (`JAR_50131`).

| Campo | Fuente |
|---|---|
| Llave, cédula, nombre, fecha de desembolso, NIT | Loan tape, último corte (`LOAN_TAPE.dbo.loantape_his_ni`). Solo los créditos que trae el loan. |
| Promotor | Colocación (`V_BIT_REGIONAL_COLOCACION_new`), por comprobante + consecutivo, filtrado por **cédula del promotor** |
| Cédula vacía en el loan | Se toma la de colocación |
| Empresa Genesis, cuotas pagadas, días de mora | CENDOC, último corte de Nicaragua |
| Cuotas en mora, monto cuota en mora, Dias Mora MC, saldo pagaré, saldo | MCCOLLECT, su propio último corte |
| % amortizado | 1 − saldo / saldo pagaré |
| Pagado (total, interés, mora, otros cargos, capital) | CHIRICO, pagos de clientes desde el desembolso. Cada pago se repite en cada `f_reporte`: se deja una sola versión (comprobante, recibo, crédito, fecha y monto; la del corte más reciente). Sin pagos queda vacío. |
| Teléfonos y direcciones | `Dim_Cliente` (CARTERA_REGIONAL), por NIT |

El equipo son los promotores **activos** de la pestaña Personal: no hay cédulas fijas en la consulta. La consulta arma
primero la cartera del equipo y filtra cada fuente contra ella (~11 s con 5 promotores; antes 2:36).

## Carga diaria (7:30 a. m.)

Tarea programada **"Modulo PYME - 7:30am"** → `Ejecutar carga.bat` → `worker/actualizar.py --una-vez`.

- Si falla la conexión, la consulta no trae créditos o CENDOC/MCCOLLECT/CHIRICO no son de hoy o ayer: reintenta
  3 veces cada 10 minutos (`worker/config.toml`). Cada intento queda en `worker/logs/actualizar.log` y en `pyme_cargas`.
- Con 0 créditos nunca se reemplaza la cartera. Si tras los 3 intentos las fuentes siguen sin ser del día, carga lo
  disponible y la app lo avisa.
- La app muestra siempre la fecha y hora de generación y la fecha de cada fuente, y avisa si los datos no son de hoy o
  si la última carga falló.

**La base de datos (Bijagua / Tortuguero) solo se alcanza desde la red interna.** La app y sus datos están en la nube,
pero la carga debe correr en un equipo de la red encendido a las 7:30. Para no depender de una PC personal: copiar
esta carpeta a un servidor de la red, `py -m venv .venv` y `.venv\Scripts\pip install pandas pyodbc keyring requests`,
guardar las dos credenciales (abajo) con el usuario que correrá la tarea y crear ahí la tarea programada.

Credenciales (Administrador de credenciales de Windows): SQL en keyring `modulo_garantias_sql` (el de Loan Tape);
Supabase con el usuario `sistema` de Tiempos DAC (keyring `tiempos_dac_supabase`).

`worker/actualizar.py --prueba` ejecuta las consultas y muestra un resumen sin subir nada.
`worker/actualizar.py --local CEDULA ...` genera `public/local/datos.json`; la app se revisa con
`.venv\Scripts\python -m http.server 3000 --directory public` y `http://localhost:3000/?local&rol=promotor|jefe|gerente`.

## Puesta en marcha (una vez)

1. Supabase de Tiempos DAC › SQL Editor: ejecutar `supabase/schema.sql`.
2. Ejecutar también `data/instalar_usuarios.sql` (promotores iniciales; no se sube a Git).
3. `Ejecutar carga.bat` para la primera carga.
4. Crear desde la app (Personal) al Gerente país y al Jefe del equipo.
