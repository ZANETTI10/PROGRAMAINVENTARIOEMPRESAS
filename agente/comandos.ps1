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
# No hace falta ningun usuario ni contrasena para esto: la Tarea
# Programada corre como SYSTEM (igual que reportar.ps1), que ya tiene
# permisos de sobra para las cuatro acciones. El "token" de este
# archivo identifica el equipo/empresa, no da acceso a nada mas.
# ============================================================

$ErrorActionPreference = "Continue"

$dir = "$env:ProgramData\HelpdeskTI"
$tokenPath = Join-Path $dir "token.txt"
$logPath = Join-Path $dir "comandos.log"

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
  "Content-Type" = "application/json"
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
    try {
      switch ($accion) {
        "liberar_memoria"   { $resultado = Ejecutar-LiberarMemoria }
        "limpiar_temporales" { $resultado = Ejecutar-LimpiarTemporales }
        "reiniciar_explorer" { $resultado = Ejecutar-ReiniciarExplorer }
        "reiniciar_equipo"   { $resultado = Ejecutar-ReiniciarEquipo }
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

    Invoke-RestMethod -Uri $urlBase -Method Post -Headers $headers -Body $bodyCompletar -TimeoutSec 20 | Out-Null
  }

  # ---- Impresoras y routers MikroTik sin IP publica de esta empresa:
  # se revisan por la red local de este PC (ping / conexion al puerto
  # de la API), nunca desde la nube -- por eso hace falta un agente acá. ----
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
