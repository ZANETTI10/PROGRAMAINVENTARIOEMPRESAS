# ============================================================
# Helpdesk TI - comandos.ps1
# ------------------------------------------------------------
# Sondea cada rato (Tarea Programada aparte, mas seguido que el
# reporte de inventario) si desde la app se mando alguna accion
# remota pendiente para este equipo -- liberar memoria, limpiar
# temporales, reiniciar el Explorador de Windows, o reiniciar el
# equipo -- la ejecuta, y le avisa a la app como quedo.
#
# En la misma pasada tambien revisa, por la red local de este PC,
# las impresoras y los routers MikroTik SIN IP publica de su misma
# empresa (si hay alguno) -- ping a cada impresora, intento de
# conexion al puerto de la API de cada router -- y reporta el
# resultado. No hace falta instalar esto en un PC especial: como
# cualquier PC de la empresa esta en la misma red, cualquiera que
# tenga el agente sirve, y si uno esta apagado otro cubre igual.
#
# Tambien ejecuta las acciones de SEGURIDAD que se manden desde la
# app (analisis rapido o completo con Defender, actualizar firmas,
# volver a prender la proteccion en tiempo real) y, en cada pasada,
# revisa si cambio algo importante de la proteccion del equipo (se
# apago el antivirus, aparecio una amenaza nueva): si cambio, manda un
# reporte de inmediato en vez de esperar las 6 horas del reporte normal.
#
# No hace falta ningun usuario ni contrasena para esto: la Tarea
# Programada corre como SYSTEM (igual que reportar.ps1), que ya tiene
# permisos de sobra para las cuatro acciones. El "token" de este
# archivo identifica el equipo/empresa, no da acceso a nada mas.
# ============================================================

$ErrorActionPreference = "Continue"

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

$dir = "$env:ProgramData\HelpdeskTI"
$tokenPath = Join-Path $dir "token.txt"
$logPath = Join-Path $dir "comandos.log"
$reportarPath = Join-Path $dir "reportar.ps1"
$huellaPath = Join-Path $dir "seguridad_huella.txt"

function Log($msg) {
  try {
    $linea = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $logPath -Value $linea -ErrorAction SilentlyContinue
  } catch {}
}

if (-not (Test-Path $tokenPath)) {
  Log "No se encontro el token en $tokenPath. Este equipo no esta instalado correctamente."
  exit 1
}
$token = (Get-Content -Path $tokenPath -Raw).Trim()
if (-not $token) { exit 1 }

$headers = @{
  "apikey"       = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZXFwd3pyaWNzaHlpYnF5b3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTEyMTYsImV4cCI6MjEwNDQ2NzIxNn0.PvylLQ1jhmMKyJZTj6EnwSrWcsXdMnUmOs9bhs9TXJA"
  "Content-Type" = "application/json; charset=utf-8"
}
$urlBase = "https://jkeqpwzricshyibqyose.supabase.co/functions/v1/agente-comandos"

function Obtener-Serial {
  try { return (Get-CimInstance -ClassName Win32_BIOS -ErrorAction Stop).SerialNumber } catch { return $null }
}

# ---- Ejecutar cada tipo de accion ----

function Ejecutar-LiberarMemoria {
  $tocados = 0
  $fallidos = 0
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      # Le pide a Windows que recorte el "working set" de cada proceso
      # a lo minimo que necesita ahora mismo -- lo mismo que hace
      # Mem Reduct en su modo "Clean working sets", sin instalar nada.
      $_.MinWorkingSet = $_.MinWorkingSet
      $tocados++
    } catch { $fallidos++ }
  }
  return "Memoria liberada en $tocados procesos ($fallidos sin permiso, normal para procesos de otro usuario/sistema)."
}

function Ejecutar-LimpiarTemporales {
  $antes = 0
  $despues = 0
  try { $antes = (Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'").FreeSpace } catch {}

  @("$env:TEMP", "$env:WINDIR\Temp") | ForEach-Object {
    if (Test-Path $_) {
      Get-ChildItem -Path $_ -Recurse -Force -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  try { Clear-RecycleBin -Force -ErrorAction SilentlyContinue } catch {}

  try { $despues = (Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='$($env:SystemDrive)'").FreeSpace } catch {}
  $liberadosMb = if ($despues -gt $antes) { [math]::Round(($despues - $antes) / 1MB) } else { 0 }
  return "Temporales y papelera limpiados. ~$liberadosMb MB liberados en $($env:SystemDrive)."
}

function Ejecutar-ReiniciarExplorer {
  try {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    return "Se reinicio el Explorador de Windows (la barra de tareas puede tardar unos segundos en volver a aparecer)."
  } catch {
    return "No se pudo reiniciar el Explorador: $($_.Exception.Message)"
  }
}

function Ejecutar-ReiniciarEquipo {
  # Aviso + cuenta regresiva de 5 minutos, para que quien este usando
  # el equipo pueda guardar lo que tenga abierto antes de que reinicie.
  shutdown.exe /r /t 300 /c "Este equipo se va a reiniciar en 5 minutos por mantenimiento remoto - Soporte TI. Por favor guarda lo que tengas abierto." /f
  return "Reinicio programado en 5 minutos, con aviso en pantalla."
}

function Ejecutar-ScriptPersonalizado($contenido) {
  # Script que el tecnico/admin escribio en la app (tabla
  # equipos_comandos.script_contenido). Se ejecuta TAL CUAL, en un
  # proceso de PowerShell aparte (para que un error o un "exit" dentro
  # del script no se lleve de paso este comandos.ps1), con permisos de
  # administrador porque la Tarea Programada corre como SYSTEM.
  if (-not $contenido -or -not $contenido.Trim()) {
    return "El comando no traia contenido de script."
  }
  $tmpFile = Join-Path $env:TEMP ("helpdeskti_script_" + [guid]::NewGuid().ToString("N") + ".ps1")
  try {
    Set-Content -Path $tmpFile -Value $contenido -Encoding UTF8
    $salida = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tmpFile 2>&1 | Out-String
    if (-not $salida -or -not $salida.Trim()) { $salida = "(el script no devolvio ninguna salida)" }
    return $salida.Trim()
  } catch {
    return "Error ejecutando el script: $($_.Exception.Message)"
  } finally {
    Remove-Item -Path $tmpFile -Force -ErrorAction SilentlyContinue
  }
}

# ---- Acciones de seguridad (Microsoft Defender) ----

function Reportar-Ahora {
  # Manda un reporte completo ya mismo (inventario + seguridad), para
  # que la app no tenga que esperar al reporte de cada 6 horas.
  try {
    if (Test-Path $reportarPath) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reportarPath | Out-Null
    }
  } catch {}
}

function Exigir-Defender {
  # Las acciones de abajo son de Microsoft Defender. Si el equipo usa
  # otro antivirus (ESET, etc.), Defender queda apagado y no aplican.
  $mp = $null
  try { $mp = Get-MpComputerStatus -ErrorAction Stop } catch {}
  if (-not $mp -or -not $mp.AMServiceEnabled) {
    throw "Microsoft Defender no esta disponible en este equipo (usa otro antivirus o esta deshabilitado). Esta accion solo aplica a Defender."
  }
  return $mp
}

function Ejecutar-Analisis($tipo) {
  # $tipo: 1 = rapido, 2 = completo. Se lanza como proceso aparte (por
  # WMI, para que no dependa de esta tarea programada, que tiene limite
  # de 5 minutos) y se devuelve de una vez: el analisis sigue corriendo
  # solo y su resultado llega en el siguiente reporte del equipo.
  Exigir-Defender | Out-Null
  $exe = Join-Path $env:ProgramFiles "Windows Defender\MpCmdRun.exe"
  if (-not (Test-Path $exe)) { throw "No se encontro MpCmdRun.exe en este equipo." }
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$exe`" -Scan -ScanType $tipo" } -ErrorAction Stop
  if ($r.ReturnValue -ne 0) { throw "Windows no dejo iniciar el analisis (codigo $($r.ReturnValue))." }
  if ($tipo -eq 2) { return "Analisis completo iniciado. Puede tardar varias horas; el resultado aparece en la app cuando termine." }
  return "Analisis rapido iniciado. Suele tardar unos minutos; el resultado aparece en la app cuando termine."
}

function Ejecutar-ActualizarFirmas {
  Exigir-Defender | Out-Null
  Update-MpSignature -ErrorAction Stop
  $mp = Get-MpComputerStatus -ErrorAction Stop
  return "Firmas actualizadas. Version $($mp.AntivirusSignatureVersion), del $($mp.AntivirusSignatureLastUpdated)."
}

function Ejecutar-ActivarProteccion {
  Exigir-Defender | Out-Null
  Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction Stop
  Start-Sleep -Seconds 4
  $mp = Get-MpComputerStatus -ErrorAction Stop
  if (-not $mp.RealTimeProtectionEnabled) {
    throw "Se mando la orden, pero la proteccion en tiempo real sigue apagada. Suele pasar cuando hay otro antivirus instalado o una politica de la empresa la bloquea: hay que revisarlo directamente en el equipo."
  }
  return "Proteccion en tiempo real activada."
}

function Ejecutar-EliminarAmenazas {
  # Le ordena a Defender eliminar/poner en cuarentena todo lo que tenga
  # detectado y sin resolver, y deja corriendo un analisis rapido para
  # confirmar que no quedo nada.
  Exigir-Defender | Out-Null
  Remove-MpThreat -ErrorAction Stop
  try { Ejecutar-Analisis 1 | Out-Null } catch {}
  return "Se ordeno eliminar las amenazas detectadas y se inicio un analisis rapido para confirmar."
}

# ---- Respuesta automatica ----
# El que vigila el equipo segundo a segundo y bloquea un virus en el
# momento es el antivirus (la proteccion en tiempo real). Lo que hace
# esto, cada 15 minutos, es asegurarse de que esa defensa siga en pie y
# terminar el trabajo cuando algo quedo a medias, sin esperar a que un
# tecnico lo vea:
#   - si apagaron la proteccion en tiempo real, la vuelve a prender;
#   - si las firmas tienen mas de 3 dias, las actualiza;
#   - si hay una amenaza detectada que no quedo resuelta, ordena
#     eliminarla y lanza un analisis.
# Cada cosa que hace queda anotada en la app. Para no insistir sin fin
# en algo que no se deja arreglar (por ejemplo una politica que impide
# prender la proteccion), cada tipo de arreglo se intenta maximo una
# vez cada 6 horas. Se puede apagar por empresa desde la app.

$ESTADOS_AMENAZA_SIN_RESOLVER = @(1, 102, 103, 104, 107)

function Puede-Intentar($clave) {
  $ruta = Join-Path $dir "auto_$clave.txt"
  try {
    if (Test-Path $ruta) {
      $ultima = [datetime](Get-Content -Path $ruta -Raw).Trim()
      if (((Get-Date) - $ultima).TotalHours -lt 6) { return $false }
    }
  } catch {}
  try { Set-Content -Path $ruta -Value (Get-Date).ToString("o") -NoNewline -Encoding ascii } catch {}
  return $true
}

function Anotar-AccionAutomatica($accion, $exito, $resultado) {
  Log "Respuesta automatica ($accion): $resultado"
  try {
    $cuerpo = @{
      token      = $token
      modo       = "accion_automatica"
      serial     = Obtener-Serial
      nombre_red = $env:COMPUTERNAME
      accion     = $accion
      exito      = $exito
      resultado  = $resultado
    } | ConvertTo-Json
    Invoke-RestMethod -Uri $urlBase -Method Post -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($cuerpo)) -TimeoutSec 20 | Out-Null
  } catch {}
}

function Intentar-AccionAutomatica($accion, $bloque) {
  if (-not (Puede-Intentar $accion)) { return $false }
  try {
    $resultado = & $bloque
    Anotar-AccionAutomatica $accion $true "$resultado"
  } catch {
    Anotar-AccionAutomatica $accion $false "$($_.Exception.Message)"
  }
  return $true
}

function Respuesta-Automatica {
  $mp = $null
  try { $mp = Get-MpComputerStatus -ErrorAction Stop } catch { return $false }
  # Si Defender no es el antivirus de este equipo (hay uno de terceros
  # y Defender esta en modo pasivo o apagado), no hay nada que hacer aca:
  # de eso se encarga el otro antivirus.
  if (-not $mp.AMServiceEnabled -or "$($mp.AMRunningMode)" -like "*Passive*" -or -not $mp.AntivirusEnabled) { return $false }

  $hizoAlgo = $false

  if (-not $mp.RealTimeProtectionEnabled) {
    if (Intentar-AccionAutomatica "activar_proteccion" { Ejecutar-ActivarProteccion }) { $hizoAlgo = $true }
  }

  $dias = 0
  try { $dias = [long]$mp.AntivirusSignatureAge } catch {}
  if ($dias -ge 3 -and $dias -lt 100000) {
    if (Intentar-AccionAutomatica "actualizar_firmas" { Ejecutar-ActualizarFirmas }) { $hizoAlgo = $true }
  }

  $desde = (Get-Date).AddDays(-14)
  $sinResolver = @(Get-MpThreatDetection -ErrorAction SilentlyContinue |
    Where-Object { $_.InitialDetectionTime -ge $desde -and ($ESTADOS_AMENAZA_SIN_RESOLVER -contains [int]$_.ThreatStatusID) })
  if ($sinResolver.Count -gt 0) {
    if (Intentar-AccionAutomatica "eliminar_amenazas" { Ejecutar-EliminarAmenazas }) { $hizoAlgo = $true }
  }

  return $hizoAlgo
}

function Obtener-HuellaSeguridad {
  # Resumen corto de lo que mas importa vigilar. Si cambia de una pasada
  # a la siguiente, se manda un reporte de inmediato.
  $partes = @()
  try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    $partes += "def:$($mp.AntivirusEnabled)/$($mp.RealTimeProtectionEnabled)"
    $partes += "det:$(@(Get-MpThreatDetection -ErrorAction SilentlyContinue).Count)"
  } catch { $partes += "def:no" }
  try {
    Get-CimInstance -Namespace "root/SecurityCenter2" -ClassName AntiVirusProduct -ErrorAction Stop |
      Sort-Object displayName |
      ForEach-Object { $partes += "$($_.displayName):$($_.productState)" }
  } catch {}
  return ($partes -join "|")
}

# ---- Sondear si hay algo pendiente ----

function Revisar-Impresora($ip) {
  try { return [bool](Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue) } catch { return $false }
}

function Revisar-RouterSinIpPublica($host_, $puerto) {
  try {
    $prueba = Test-NetConnection -ComputerName $host_ -Port ([int]$puerto) -WarningAction SilentlyContinue -ErrorAction SilentlyContinue
    return [bool]$prueba.TcpTestSucceeded
  } catch { return $false }
}

$resp = $null
try {
  $bodyConsulta = @{
    token      = $token
    serial     = Obtener-Serial
    nombre_red = $env:COMPUTERNAME
    modo       = "consultar"
  } | ConvertTo-Json

  $resp = Invoke-RestMethod -Uri $urlBase -Method Post -Headers $headers -Body $bodyConsulta -TimeoutSec 20

  # ---- Accion remota pendiente para ESTE equipo (si hay) ----
  if ($resp.comando) {
    $comandoId = $resp.comando.id
    $accion = $resp.comando.accion
    Log "Ejecutando accion pendiente: $accion (id=$comandoId)"

    $exito = $true
    $resultado = ""
    $reportarDespues = $false
    try {
      switch ($accion) {
        "liberar_memoria"   { $resultado = Ejecutar-LiberarMemoria }
        "limpiar_temporales" { $resultado = Ejecutar-LimpiarTemporales }
        "reiniciar_explorer" { $resultado = Ejecutar-ReiniciarExplorer }
        "reiniciar_equipo"   { $resultado = Ejecutar-ReiniciarEquipo }
        "script_personalizado" { $resultado = Ejecutar-ScriptPersonalizado $resp.comando.script_contenido }
        "analisis_rapido"    { $resultado = Ejecutar-Analisis 1 }
        "analisis_completo"  { $resultado = Ejecutar-Analisis 2 }
        "actualizar_firmas"  { $resultado = Ejecutar-ActualizarFirmas; $reportarDespues = $true }
        "activar_proteccion" { $resultado = Ejecutar-ActivarProteccion; $reportarDespues = $true }
        "eliminar_amenazas"  { $resultado = Ejecutar-EliminarAmenazas; $reportarDespues = $true }
        default { $exito = $false; $resultado = "Accion desconocida: $accion" }
      }
    } catch {
      $exito = $false
      $resultado = "Error ejecutando $accion : $($_.Exception.Message)"
    }

    Log "Resultado ($accion): $resultado"

    $bodyCompletar = @{
      token      = $token
      modo       = "completar"
      comando_id = $comandoId
      exito      = $exito
      resultado  = $resultado
    } | ConvertTo-Json

    Invoke-RestMethod -Uri $urlBase -Method Post -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($bodyCompletar)) -TimeoutSec 20 | Out-Null

    if ($reportarDespues) { Reportar-Ahora }
  }

  # ---- Impresoras y routers MikroTik sin IP publica de esta empresa:
  # se revisan por la red local de este PC (ping / conexion al puerto
  # de la API), nunca desde la nube -- por eso hace falta un agente aca. ----
  $resultadosImpresoras = @()
  foreach ($imp in $resp.impresoras) {
    $resultadosImpresoras += @{ id = $imp.id; en_linea = (Revisar-Impresora $imp.ip_local) }
  }

  $resultadosMikrotik = @()
  foreach ($r in $resp.mikrotik) {
    $resultadosMikrotik += @{ id = $r.id; en_linea = (Revisar-RouterSinIpPublica $r.host $r.puerto) }
  }

  if ($resultadosImpresoras.Count -gt 0 -or $resultadosMikrotik.Count -gt 0) {
    $bodyEstadoRed = @{
      token      = $token
      modo       = "estado_red"
      impresoras = $resultadosImpresoras
      mikrotik   = $resultadosMikrotik
    } | ConvertTo-Json -Depth 5

    Invoke-RestMethod -Uri $urlBase -Method Post -Headers $headers -Body $bodyEstadoRed -TimeoutSec 20 | Out-Null
    Log "Red local revisada: $($resultadosImpresoras.Count) impresora(s), $($resultadosMikrotik.Count) router(es) sin IP publica."
  }
} catch {
  Log "ERROR sondeando/ejecutando comandos: $($_.Exception.Message)"
}

# ---- Vigilancia de seguridad: si cambio algo desde la pasada anterior
# (se apago la proteccion, cambio el antivirus, hay una deteccion
# nueva), se reporta ya mismo. ----
$respondioSolo = $false
try {
  # La app dice si esta empresa tiene prendida la respuesta automatica.
  # Si no se pudo consultar (sin internet), no se hace nada por cuenta propia.
  if ($resp -and $resp.respuesta_automatica -eq $true) { $respondioSolo = Respuesta-Automatica }
} catch {
  Log "ERROR en la respuesta automatica: $($_.Exception.Message)"
}

try {
  $huella = Obtener-HuellaSeguridad
  $anterior = $null
  if (Test-Path $huellaPath) { $anterior = (Get-Content -Path $huellaPath -Raw -ErrorAction SilentlyContinue) }
  if ($anterior) { $anterior = $anterior.Trim() }
  if ($huella -ne $anterior -or $respondioSolo) {
    Set-Content -Path $huellaPath -Value $huella -NoNewline -Encoding ascii
    Log "Cambio en la seguridad del equipo: se manda reporte inmediato."
    Reportar-Ahora
  }
} catch {
  Log "ERROR revisando la seguridad: $($_.Exception.Message)"
}
