# Arma build\ModuloPYME_Carga.zip: el proceso de carga como .exe (incluye Python) + instalador para otras PCs.
# Uso: powershell -ExecutionPolicy Bypass -File construir_paquete.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& .venv\Scripts\python -m pip install -q pyinstaller
& .venv\Scripts\pyinstaller --noconfirm --clean --noconsole --onedir --name ModuloPYME_Carga `
  --paths worker --hidden-import keyring.backends.Windows --icon NONE `
  --distpath build\dist --workpath build\work --specpath build worker\actualizar.py
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller falló' }
$pq = 'build\dist\ModuloPYME_Carga'
New-Item -ItemType Directory -Force "$pq\worker\sql" | Out-Null
Copy-Item worker\config.toml "$pq\worker\"
Copy-Item worker\sql\*.sql "$pq\worker\sql\"
Copy-Item instalador\Instalar.bat, instalador\Instalar.ps1, instalador\Desinstalar.bat, instalador\LEEME.txt $pq
Remove-Item build\ModuloPYME_Carga.zip -ErrorAction SilentlyContinue
Compress-Archive -Path $pq -DestinationPath build\ModuloPYME_Carga.zip
Write-Host "Paquete listo: $PSScriptRoot\build\ModuloPYME_Carga.zip"
