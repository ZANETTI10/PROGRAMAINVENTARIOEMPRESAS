# ============================================================
# Helpdesk TI - reportar.ps1
# ------------------------------------------------------------
# Recolecta los datos basicos del equipo (procesador, RAM, disco,
# sistema operativo, serial, etc.) y los envia al inventario. Este
# script lo instala "instalar.ps1" (no se corre a mano normalmente):
# queda guardado en C:\ProgramData\HelpdeskTI\reportar.ps1 y una Tarea
# Programada lo ejecuta solo, en cada inicio de sesion y cada 6 horas,
# para que el inventario se mantenga actualizado sin que nadie tenga
# que volver a hacer nada.
#
# No hay contrasenas de nada aqui: el "token" identifica la empresa,
# no da acceso a otra cosa que anotar ESTE equipo en SU inventario.
# ============================================================

$ErrorActionPreference = "Continue"

$dir = "$env:ProgramData\HelpdeskTI"
$tokenPath = Join-Path $dir "token.txt"
$logPath = Join-Path $dir "reportar.log"

function Log($msg) {
  try {
    $linea = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $logPath -Value $linea -ErrorAction SilentlyContinue
  } catch {}
}

if (-not (Test-Path $tokenPath)) {
  Log "No se encontro el token en $tokenPath. Este equipo no esta instalado correctamente, hay que volver a correr instalar.ps1."
  exit 1
}

$token = (Get-Content -Path $tokenPath -Raw).Trim()
if (-not $token) {
  Log "El archivo de token esta vacio."
  exit 1
}

function Obtener-TipoEquipo {
  try {
    $tipo = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).PCSystemType
    switch ($tipo) {
      2 { return "Portatil" }
      1 { return "Escritorio" }
      3 { return "Servidor (Tower)" }
      4 { return "Servidor (Rack)" }
      5 { return "Servidor (Blade)" }
      default { return "Equipo" }
    }
  } catch { return "Equipo" }
}

function Obtener-TipoDisco {
  try {
    $pd = Get-PhysicalDisk -ErrorAction Stop | Select-Object -First 1
    if ($pd -and $pd.MediaType -and "$($pd.MediaType)" -ne "Unspecified") { return "$($pd.MediaType)" }
  } catch {}
  return $null
}

try {
  $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
  $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction SilentlyContinue
  $bios = Get-CimInstance -ClassName Win32_BIOS -ErrorAction SilentlyContinue
  $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
  $discos = Get-CimInstance -ClassName Win32_DiskDrive -ErrorAction SilentlyContinue
  $memoriaTotalBytes = (Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction SilentlyContinue | Measure-Object -Property Capacity -Sum).Sum
  $discoTotalBytes = ($discos | Measure-Object -Property Size -Sum).Sum

  $memoriaTexto = $null
  if ($memoriaTotalBytes) { $memoriaTexto = "$([math]::Round($memoriaTotalBytes / 1GB)) GB" }

  $discoTexto = $null
  if ($discoTotalBytes) { $discoTexto = "$([math]::Round($discoTotalBytes / 1GB)) GB" }

  $datos = @{
    token       = $token
    tipo_equipo = Obtener-TipoEquipo
    nombre_red  = $env:COMPUTERNAME
    procesador  = if ($cpu) { $cpu.Name.Trim() } else { $null }
    memoria_ram = $memoriaTexto
    disco_duro  = $discoTexto
    tipo_disco  = Obtener-TipoDisco
    licencia_so = if ($os) { "$($os.Caption) ($($os.Version))" } else { $null }
    serial      = if ($bios) { $bios.SerialNumber } else { $null }
    comentarios = "Registrado automaticamente por el agente instalado (Windows)."
  }

  $json = $datos | ConvertTo-Json -Depth 3

  $headers = @{
    "apikey"       = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZXFwd3pyaWNzaHlpYnF5b3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTEyMTYsImV4cCI6MjEwNDQ2NzIxNn0.PvylLQ1jhmMKyJZTj6EnwSrWcsXdMnUmOs9bhs9TXJA"
    "Content-Type" = "application/json"
  }

  $resp = Invoke-RestMethod -Uri "https://jkeqpwzricshyibqyose.supabase.co/functions/v1/agente-inventario" -Method Post -Headers $headers -Body $json -TimeoutSec 25
  Log "OK: $($resp | ConvertTo-Json -Compress)"
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
