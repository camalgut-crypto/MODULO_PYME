# Instala el proceso de carga del Módulo PYME en esta PC (sin Python ni SQL Server: todo va en el .exe).
# Lo ejecuta Instalar.bat. Se instala para el usuario de Windows que lo ejecuta, sin permisos de administrador.
$ErrorActionPreference = 'Stop'
$origen  = $PSScriptRoot
$destino = Join-Path $env:LOCALAPPDATA 'ModuloPYME_Carga'
$tarea   = 'Modulo PYME - Proceso de carga'
$exe     = Join-Path $destino 'ModuloPYME_Carga.exe'

Write-Host "Instalando el proceso de carga del Módulo PYME en $destino ..."
if (Get-ScheduledTask -TaskName $tarea -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $tarea -ErrorAction SilentlyContinue }
Get-Process ModuloPYME_Carga -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
New-Item -ItemType Directory -Force $destino | Out-Null
# Se conservan los logs de una instalación anterior
Get-ChildItem $origen -Exclude 'Instalar.bat','Instalar.ps1','LEEME.txt' | Copy-Item -Destination $destino -Recurse -Force

Write-Host 'Guardando y probando las credenciales (se abren unas ventanas)...'
$p = Start-Process -FilePath $exe -ArgumentList '--configurar' -Wait -PassThru
if ($p.ExitCode -ne 0) {
  Write-Host 'Las credenciales no funcionaron o se canceló. Corríjalas y vuelva a ejecutar Instalar.bat.' -ForegroundColor Red
  exit 1
}

$accion  = New-ScheduledTaskAction -Execute $exe -Argument '--escuchar' -WorkingDirectory $destino
$disparo = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$ajustes = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 `
  -RestartInterval (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $tarea -Action $accion -Trigger $disparo -Settings $ajustes -Force `
  -Description 'Atiende el botón Actualizar y la carga diaria 7:30 del Módulo PYME' | Out-Null
Start-ScheduledTask -TaskName $tarea

Write-Host ''
Write-Host 'Listo. El proceso de carga queda encendido en segundo plano (sin ventanas) y arranca solo al iniciar sesión.' -ForegroundColor Green
Write-Host 'En la app, la barra de fechas muestra esta PC como "PC de carga conectada" en menos de un minuto.'
Write-Host "Registro de cargas: $destino\worker\logs\actualizar.log"
