@echo off
rem Instala el proceso de carga del Modulo PYME para este usuario de Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Instalar.ps1"
pause
