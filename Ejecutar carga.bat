@echo off
rem Carga diaria del Modulo PYME (tarea programada "Modulo PYME - 7:30am"). Reintenta 3 veces y deja log en worker\logs.
cd /d "%~dp0"
".venv\Scripts\python.exe" worker\actualizar.py --una-vez
