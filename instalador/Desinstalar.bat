@echo off
rem Quita el proceso de carga del Modulo PYME de esta PC (la app y los datos en la nube no se tocan).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName 'Modulo PYME - Proceso de carga' -Confirm:$false -ErrorAction SilentlyContinue; Get-Process ModuloPYME_Carga -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 1; Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'ModuloPYME_Carga') -ErrorAction SilentlyContinue; Write-Host 'Proceso de carga del Modulo PYME desinstalado.'"
pause
