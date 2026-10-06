# ============================================================
# Helpdesk TI - instalar.ps1
# ------------------------------------------------------------
# Instala el agente de auto-registro de inventario en este equipo
# (Windows). Se corre UNA SOLA VEZ, con PowerShell como Administrador,
# pegando el comando que genera la app en la pestana Inventario -> el
# comando ya trae el token de la empresa correcta, algo asi:
#
#   $env:HDESKTI_TOKEN="xxxxx"; irm https://zanetti10.github.io/PROGRAMAINVENTARIOEMPRESAS/agente/instalar.ps1 | iex
#
# Que hace:
#  1. Guarda el token en C:\ProgramData\HelpdeskTI\token.txt
#  2. Pregunta el nombre de quien usa este equipo (para que el
#     inventario quede organizado por responsable, no solo por nombre
#     de red/serial) y lo guarda en responsable.txt. Es opcional: Enter
#     en blanco lo deja sin asignar y se puede poner despues a mano
#     desde la app. Tambien se puede pasar sin que pregunte nada con
#     $env:HDESKTI_RESPONSABLE="Nombre" antes del comando.
#  3. Descarga reportar.ps1 (el que de verdad recolecta y envia los
#     datos) a esa misma carpeta.
#  4. Crea una Tarea Programada que corre reportar.ps1 al iniciar
#     sesion y cada 6 horas, como SYSTEM (para que siga reportando
#     aunque nadie haya iniciado sesion) -- asi queda "instalado" de
#     forma permanente, sin que haya que volver a correr nada.
#  5. Corre reportar.ps1 una vez de inmediato, para que el equipo
#     aparezca en el inventario ya mismo, sin esperar la primera vez
#     que corra la tarea programada.
# ============================================================

$ErrorActionPreference = "Stop"

$esAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $esAdmin) {
  Write-Host "Este instalador necesita PowerShell como Administrador." -ForegroundColor Red
  Write-Host "Cierra esta ventana, abre PowerShell con 'Ejecutar como administrador' y vuelve a pegar el comando." -ForegroundColor Red
  exit 1
}

if (-not $env:HDESKTI_TOKEN) {
  Write-Host "Falta el token de instalacion. Usa el comando completo que te dio la app, algo como:" -ForegroundColor Red
  Write-Host '  $env:HDESKTI_TOKEN="..."; irm .../agente/instalar.ps1 | iex' -ForegroundColor Yellow
  exit 1
}

$dir = "$env:ProgramData\HelpdeskTI"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Set-Content -Path (Join-Path $dir "token.txt") -Value $env:HDESKTI_TOKEN.Trim() -NoNewline -Encoding ascii

$responsable = $env:HDESKTI_RESPONSABLE
if (-not $responsable) {
  Write-Host ""
  $responsable = Read-Host "Nombre de quien usa este equipo (para el inventario, Enter para dejarlo en blanco)"
}
$responsablePath = Join-Path $dir "responsable.txt"
if ($responsable -and $responsable.Trim()) {
  Set-Content -Path $responsablePath -Value $responsable.Trim() -NoNewline -Encoding UTF8
} else {
  Remove-Item -Path $responsablePath -Force -ErrorAction SilentlyContinue
}

Write-Host "Descargando el agente..." -ForegroundColor Cyan
$reportarUrl = "https://zanetti10.github.io/PROGRAMAINVENTARIOEMPRESAS/agente/reportar.ps1"
$reportarPath = Join-Path $dir "reportar.ps1"
Invoke-WebRequest -Uri $reportarUrl -OutFile $reportarPath -UseBasicParsing

$taskName = "HelpdeskTI-Inventario"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$accion = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$reportarPath`""
$disparadorInicio = New-ScheduledTaskTrigger -AtStartup
$disparadorPeriodico = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration ([TimeSpan]::MaxValue)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

Register-ScheduledTask -TaskName $taskName -Action $accion -Trigger @($disparadorInicio, $disparadorPeriodico) -Principal $principal -Settings $config -Description "Helpdesk TI: reporta este equipo al inventario automaticamente." -Force | Out-Null

Write-Host "Agente instalado. Registrando este equipo en el inventario ahora..." -ForegroundColor Green
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reportarPath

$logPath = Join-Path $dir "reportar.log"
if (Test-Path $logPath) {
  Write-Host "--- Ultima linea del registro ---" -ForegroundColor Cyan
  Get-Content -Path $logPath -Tail 1
}

Write-Host "Listo. Este equipo va a seguir reportandose solo cada 6 horas y en cada inicio." -ForegroundColor Green
