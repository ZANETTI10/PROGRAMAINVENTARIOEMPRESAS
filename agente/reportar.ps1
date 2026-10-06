# ============================================================
# Helpdesk TI - reportar.ps1
# ------------------------------------------------------------
# Recolecta los datos basicos del equipo (procesador, RAM y su tipo,
# disco y su tipo, sistema operativo, serial, etc.) y los envia al
# inventario, junto con el "responsable" (quien usa el equipo) que se
# haya guardado al instalar, si lo pusieron. Este script lo instala
# "instalar.ps1" (no se corre a mano normalmente): queda guardado en
# C:\ProgramData\HelpdeskTI\reportar.ps1 y una Tarea Programada lo
# ejecuta solo, en cada inicio de sesion y cada 6 horas, para que el
# inventario se mantenga actualizado sin que nadie tenga que volver a
# hacer nada.
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

function Obtener-TipoMemoria {
  try {
    $modulo = Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction Stop | Select-Object -First 1
    switch ($modulo.SMBIOSMemoryType) {
      20 { return "DDR" }
      21 { return "DDR2" }
      24 { return "DDR3" }
      26 { return "DDR4" }
      34 { return "DDR5" }
      default { return $null }
    }
  } catch { return $null }
}

function Obtener-Responsable {
  $ruta = Join-Path $dir "responsable.txt"
  if (Test-Path $ruta) {
    $valor = (Get-Content -Path $ruta -Raw -ErrorAction SilentlyContinue)
    if ($valor) { return $valor.Trim() }
  }
  return $null
}

function Obtener-DiscoLibrePct {
  try {
    $unidad = Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'" -ErrorAction Stop
    if ($unidad -and $unidad.Size -gt 0) {
      return [string][math]::Round(($unidad.FreeSpace / $unidad.Size) * 100)
    }
  } catch {}
  return $null
}

function Obtener-IpLocal {
  try {
    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
      Select-Object -First 1
    if ($ip) { return $ip.IPAddress }
  } catch {}
  return $null
}

function Obtener-UsuarioSesion {
  # Usuario con sesion iniciada en este momento (puede ser distinto del
  # "responsable" asignado a mano). Esto funciona aunque el script lo
  # corra la Tarea Programada como SYSTEM: la propiedad refleja quien
  # tiene abierta la sesion de consola, no la identidad del proceso.
  try {
    $u = (Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop).UserName
    if ($u) { return $u }
  } catch {}
  return $null
}

function Obtener-UltimoReinicio {
  try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    if ($os.LastBootUpTime) { return $os.LastBootUpTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
  } catch {}
  return $null
}

function Obtener-WindowsActivado {
  try {
    $lic = Get-CimInstance -ClassName SoftwareLicensingProduct -ErrorAction Stop |
      Where-Object { $_.PartialProductKey -and $_.Name -like "Windows*" } |
      Select-Object -First 1
    if ($lic) {
      if ($lic.LicenseStatus -eq 1) { return "Activado" }
      return "No activado"
    }
  } catch {}
  return $null
}

function Obtener-AntivirusEstado {
  try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    if ($mp) {
      if ($mp.AntivirusEnabled -and $mp.RealTimeProtectionEnabled) { return "Defender activo" }
      if ($mp.AntivirusEnabled) { return "Defender instalado, proteccion en tiempo real apagada" }
      return "Defender desactivado"
    }
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
    responsable = Obtener-Responsable
    procesador  = if ($cpu) { $cpu.Name.Trim() } else { $null }
    memoria_ram = $memoriaTexto
    tipo_memoria = Obtener-TipoMemoria
    disco_duro  = $discoTexto
    tipo_disco  = Obtener-TipoDisco
    disco_libre_pct = Obtener-DiscoLibrePct
    licencia_so = if ($os) { "$($os.Caption) ($($os.Version))" } else { $null }
    serial      = if ($bios) { $bios.SerialNumber } else { $null }
    ip_local        = Obtener-IpLocal
    usuario_sesion  = Obtener-UsuarioSesion
    ultimo_reinicio = Obtener-UltimoReinicio
    windows_activado = Obtener-WindowsActivado
    antivirus_estado = Obtener-AntivirusEstado
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
