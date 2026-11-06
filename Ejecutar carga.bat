@echo off
rem Proceso de carga del Modulo PYME (tarea programada "Modulo PYME - Proceso de carga", al iniciar sesion).
rem Queda escuchando: atiende el boton Actualizar de la app y la carga diaria de las 7:30 (3 reintentos, log en worker\logs).
rem Puede correr en varias PCs de la red a la vez: Supabase reparte el trabajo para que solo una cargue.
cd /d "%~dp0"
".venv\Scripts\python.exe" worker\actualizar.py --escuchar
