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
# Ademas del inventario, en cada reporte manda el ESTADO DE SEGURIDAD
# del equipo: que antivirus tiene (Defender o uno de terceros como
# ESET), si la proteccion en tiempo real esta prendida, de cuando son
# las firmas, cuando fue el ultimo analisis, el firewall de Windows, la
# ultima actualizacion instalada y las amenazas que Defender ha
# detectado en los ultimos 60 dias. Con eso la app arma la consola de
# seguridad (semaforo por equipo y por empresa).
#
# Y manda tambien lo que influye en el RENDIMIENTO: uso de procesador
# y memoria, ranuras de RAM, tipo y salud de los discos, dias sin
# reiniciar, programas de inicio y procesos mas pesados. Con eso la app
# dibuja el esquema del equipo y las recomendaciones para el cliente.
#
# No hay contrasenas de nada aqui: el "token" identifica la empresa,
# no da acceso a otra cosa que anotar ESTE equipo en SU inventario.
# ============================================================

$ErrorActionPreference = "Continue"

# Version del agente: se manda en cada reporte para que la app sepa que
# equipos tienen ya el modulo de seguridad y cuales hay que actualizar.
$AgenteVersion = "2.0"

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

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

function A-Iso($fecha) {
  # Fecha a texto ISO en UTC. Windows devuelve fechas del ano 1601 (o
  # vacias) cuando algo "nunca" ha pasado: esas se mandan como vacio.
  try {
    if ($fecha) {
      $f = [datetime]$fecha
      if ($f.Year -ge 2000) { return $f.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ") }
    }
  } catch {}
  return $null
}

function Obtener-ProductosSeguridad($clase) {
  # Windows (el "Centro de seguridad") lleva la lista de antivirus y
  # firewalls instalados, sean de Microsoft o de terceros, y si cada uno
  # esta activo y al dia. No existe en Windows Server: ahi devuelve vacio.
  $lista = @()
  try {
    $productos = Get-CimInstance -Namespace "root/SecurityCenter2" -ClassName $clase -ErrorAction Stop
    foreach ($p in $productos) {
      $estado = [int]$p.productState
      $lista += @{
        nombre = "$($p.displayName)"
        activo = [bool]($estado -band 0x1000)
        al_dia = (($estado -band 0x10) -eq 0)
      }
    }
  } catch {}
  return $lista
}

function Obtener-Defender {
  try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    if (-not $mp) { return $null }
    $dias = $null
    try { $d = [long]$mp.AntivirusSignatureAge; if ($d -ge 0 -and $d -lt 100000) { $dias = $d } } catch {}
    return @{
      modo                     = "$($mp.AMRunningMode)"
      servicio_activo          = [bool]$mp.AMServiceEnabled
      antivirus_activo         = [bool]$mp.AntivirusEnabled
      tiempo_real              = [bool]$mp.RealTimeProtectionEnabled
      proteccion_manipulacion  = [bool]$mp.IsTamperProtected
      firmas_version           = "$($mp.AntivirusSignatureVersion)"
      firmas_fecha             = A-Iso $mp.AntivirusSignatureLastUpdated
      firmas_dias              = $dias
      analisis_rapido_fecha    = A-Iso $mp.QuickScanEndTime
      analisis_completo_fecha  = A-Iso $mp.FullScanEndTime
      version_motor            = "$($mp.AMProductVersion)"
    }
  } catch { return $null }
}

function Obtener-Firewall {
  $fw = @{ dominio = $null; privado = $null; publico = $null }
  try {
    foreach ($pf in (Get-NetFirewallProfile -ErrorAction Stop)) {
      $prendido = ("$($pf.Enabled)" -eq "True")
      switch ("$($pf.Name)") {
        "Domain"  { $fw.dominio = $prendido }
        "Private" { $fw.privado = $prendido }
        "Public"  { $fw.publico = $prendido }
      }
    }
  } catch {}
  # Si hay un firewall de terceros activo (el del antivirus, por
  # ejemplo), el de Windows suele quedar apagado a proposito.
  $terceros = @(Obtener-ProductosSeguridad "FirewallProduct" | Where-Object { $_.activo } | ForEach-Object { $_.nombre })
  if ($terceros.Count -gt 0) { $fw.terceros = ($terceros -join ", ") }
  return $fw
}

function Obtener-UltimaActualizacionWindows {
  try {
    $ultimo = Get-HotFix -ErrorAction Stop | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1
    if ($ultimo) { return A-Iso $ultimo.InstalledOn }
  } catch {}
  return $null
}

function Obtener-Seguridad {
  return @{
    antivirus             = @(Obtener-ProductosSeguridad "AntiVirusProduct")
    defender              = Obtener-Defender
    firewall              = Obtener-Firewall
    ultima_actualizacion  = Obtener-UltimaActualizacionWindows
  }
}

function Obtener-Amenazas {
  # Lo que Defender ha detectado en este equipo en los ultimos 60 dias
  # (maximo 40). Las detecciones de un antivirus de terceros no quedan
  # aca: esas solo se ven en la consola de ese fabricante.
  $resultado = @()
  try {
    $catalogo = @{}
    Get-MpThreat -ErrorAction SilentlyContinue | ForEach-Object { $catalogo["$($_.ThreatID)"] = $_ }
    $desde = (Get-Date).AddDays(-60)
    $detecciones = Get-MpThreatDetection -ErrorAction Stop |
      Where-Object { $_.InitialDetectionTime -ge $desde } |
      Sort-Object InitialDetectionTime -Descending |
      Select-Object -First 40
    foreach ($d in $detecciones) {
      $info = $catalogo["$($d.ThreatID)"]
      $recurso = $null
      if ($d.Resources) { $recurso = "$(@($d.Resources)[0])" }
      $resultado += @{
        deteccion_id = "$($d.DetectionID)"
        nombre       = if ($info) { "$($info.ThreatName)" } else { "Amenaza $($d.ThreatID)" }
        severidad_id = if ($info) { [int]$info.SeverityID } else { $null }
        estado_id    = [int]$d.ThreatStatusID
        recurso      = $recurso
        detectado_en = A-Iso $d.InitialDetectionTime
      }
    }
  } catch {}
  return $resultado
}

function Obtener-AntivirusEstado($seg) {
  # Resumen en una linea (el mismo campo que ya mostraba el inventario),
  # ahora teniendo en cuenta antivirus de terceros y no solo Defender.
  $activos = @($seg.antivirus | Where-Object { $_.activo })
  $terceros = @($activos | Where-Object { $_.nombre -notlike "*Defender*" })
  if ($terceros.Count -gt 0) {
    $t = $terceros[0]
    if ($t.al_dia) { return "$($t.nombre) activo" }
    return "$($t.nombre) activo, desactualizado"
  }
  $def = $seg.defender
  if ($def) {
    if ($def.antivirus_activo -and $def.tiempo_real) { return "Defender activo" }
    if ($def.antivirus_activo) { return "Defender instalado, proteccion en tiempo real apagada" }
    return "Defender desactivado"
  }
  if (@($seg.antivirus).Count -gt 0) { return "$($seg.antivirus[0].nombre) desactivado" }
  return $null
}

function Obtener-Rendimiento {
  # Lo que influye en que el equipo ande rapido o lento: carga del
  # procesador y de la memoria en este momento, como esta repartida la
  # RAM en las ranuras, el tipo y la salud de cada disco, cuanto lleva
  # sin reiniciarse, cuantos programas arrancan con Windows y que
  # procesos estan gastando mas memoria. Con esto la app arma el esquema
  # del equipo y las recomendaciones para el cliente.
  $r = @{}

  try {
    $cpus = @(Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop)
    $r.cpu_nucleos = [int](($cpus | Measure-Object -Property NumberOfCores -Sum).Sum)
    $r.cpu_hilos   = [int](($cpus | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum)
    $r.cpu_mhz     = [int]$cpus[0].MaxClockSpeed
    # Promedio de 3 muestras, para no quedarse con un pico de un segundo.
    $muestras = @()
    for ($i = 0; $i -lt 3; $i++) {
      $m = (Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Measure-Object -Property LoadPercentage -Average).Average
      if ($null -ne $m) { $muestras += $m }
      if ($i -lt 2) { Start-Sleep -Seconds 2 }
    }
    if ($muestras.Count -gt 0) { $r.cpu_uso_pct = [int][math]::Round(($muestras | Measure-Object -Average).Average) }
  } catch {}

  try {
    $so = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    if ($so.TotalVisibleMemorySize -gt 0) {
      $r.ram_total_gb = [math]::Round($so.TotalVisibleMemorySize / 1MB, 1)
      $r.ram_uso_pct  = [int][math]::Round((1 - ($so.FreePhysicalMemory / $so.TotalVisibleMemorySize)) * 100)
    }
    if ($so.LastBootUpTime) { $r.dias_encendido = [int][math]::Floor(((Get-Date) - $so.LastBootUpTime).TotalDays) }
  } catch {}

  try {
    $ranuras = (Get-CimInstance -ClassName Win32_PhysicalMemoryArray -ErrorAction Stop | Measure-Object -Property MemoryDevices -Sum).Sum
    if ($ranuras) { $r.ram_ranuras = [int]$ranuras }
    $modulos = @()
    foreach ($m in (Get-CimInstance -ClassName Win32_PhysicalMemory -ErrorAction Stop)) {
      $modulos += @{
        gb        = [int][math]::Round($m.Capacity / 1GB)
        mhz       = if ($m.Speed) { [int]$m.Speed } else { $null }
        ranura    = "$($m.DeviceLocator)"
        fabricante = "$($m.Manufacturer)".Trim()
      }
    }
    $r.ram_modulos = $modulos
  } catch {}

  try {
    $discos = @()
    foreach ($d in (Get-PhysicalDisk -ErrorAction Stop)) {
      $discos += @{
        modelo = "$($d.FriendlyName)".Trim()
        tipo   = "$($d.MediaType)"
        bus    = "$($d.BusType)"
        gb     = [int][math]::Round($d.Size / 1GB)
        salud  = "$($d.HealthStatus)"
      }
    }
    $r.discos = $discos
  } catch {}

  try {
    $unidades = @()
    foreach ($u in (Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DriveType=3" -ErrorAction Stop)) {
      if ($u.Size -gt 0) {
        $unidades += @{
          letra     = "$($u.DeviceID)"
          gb        = [int][math]::Round($u.Size / 1GB)
          libre_gb  = [int][math]::Round($u.FreeSpace / 1GB)
          libre_pct = [int][math]::Round(($u.FreeSpace / $u.Size) * 100)
        }
      }
    }
    $r.unidades = $unidades
  } catch {}

  try {
    $r.programas_inicio = @(Get-CimInstance -ClassName Win32_StartupCommand -ErrorAction Stop).Count
  } catch {}

  try {
    $procesos = @()
    Get-Process -ErrorAction Stop | Group-Object -Property ProcessName | ForEach-Object {
      New-Object PSObject -Property @{ nombre = $_.Name; mb = [int][math]::Round((($_.Group | Measure-Object -Property WorkingSet64 -Sum).Sum) / 1MB) }
    } | Sort-Object mb -Descending | Select-Object -First 5 | ForEach-Object {
      $procesos += @{ nombre = "$($_.nombre)"; mb = $_.mb }
    }
    $r.procesos_top = $procesos
  } catch {}

  try {
    # Windows deja estas marcas cuando hay un reinicio pendiente por
    # actualizaciones a medio instalar.
    $pendiente = (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") -or
                 (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending")
    $r.reinicio_pendiente = [bool]$pendiente
  } catch {}

  try {
    # Solo portatiles: cuanto aguanta hoy la bateria frente a cuando era nueva.
    $diseno = (Get-CimInstance -Namespace "root/wmi" -ClassName BatteryStaticData -ErrorAction Stop | Select-Object -First 1).DesignedCapacity
    $actual = (Get-CimInstance -Namespace "root/wmi" -ClassName BatteryFullChargedCapacity -ErrorAction Stop | Select-Object -First 1).FullChargedCapacity
    if ($diseno -gt 0 -and $actual -gt 0) { $r.bateria_salud_pct = [int][math]::Min(100, [math]::Round(($actual / $diseno) * 100)) }
  } catch {}

  try {
    $cs2 = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
    $r.fabricante = "$($cs2.Manufacturer)".Trim()
    $r.modelo     = "$($cs2.Model)".Trim()
  } catch {}

  return $r
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

  $seguridad = Obtener-Seguridad

  $datos = @{
    token       = $token
    agente_version = $AgenteVersion
    seguridad   = $seguridad
    rendimiento = Obtener-Rendimiento
    amenazas    = @(Obtener-Amenazas)
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
    antivirus_estado = Obtener-AntivirusEstado $seguridad
    comentarios = "Registrado automaticamente por el agente instalado (Windows)."
  }

  $json = $datos | ConvertTo-Json -Depth 6
  # Se manda como bytes UTF-8: Windows PowerShell 5.1, si se le pasa el
  # texto directo, dana las tildes y las enes (nombres de usuario,
  # rutas de archivos de una amenaza, etc.).
  $cuerpo = [System.Text.Encoding]::UTF8.GetBytes($json)

  $headers = @{
    "apikey"       = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZXFwd3pyaWNzaHlpYnF5b3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTEyMTYsImV4cCI6MjEwNDQ2NzIxNn0.PvylLQ1jhmMKyJZTj6EnwSrWcsXdMnUmOs9bhs9TXJA"
    "Content-Type" = "application/json; charset=utf-8"
  }

  $resp = Invoke-RestMethod -Uri "https://jkeqpwzricshyibqyose.supabase.co/functions/v1/agente-inventario" -Method Post -Headers $headers -Body $cuerpo -TimeoutSec 25
  Log "OK: $($resp | ConvertTo-Json -Compress)"
} catch {
  Log "ERROR: $($_.Exception.Message)"
}
