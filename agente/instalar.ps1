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
# Para que quien este presente no vea una ventana de PowerShell llena
# de texto tecnico (parece que le estan "hackeando" el equipo), en
# cuanto el token es valido esta consola se oculta y en su lugar
# aparece una ventanita con la marca de Soporte TI mostrando el avance
# -- eso es lo unico que se ve.
#
# Que hace:
#  1. Guarda el token en C:\ProgramData\HelpdeskTI\token.txt
#  2. Pregunta (en la ventanita, no en la consola) el nombre de quien
#     usa este equipo. Es opcional: se puede dejar en blanco y se
#     asigna despues a mano desde la app, o se puede pasar sin
#     preguntar nada con $env:HDESKTI_RESPONSABLE="Nombre" antes del
#     comando. Si no se dice nada aqui, mas adelante
#     preguntar-responsable.ps1 vuelve a preguntar de vez en cuando.
#  3. Descarga reportar.ps1, comandos.ps1 y preguntar-responsable.ps1 a
#     esa misma carpeta, y le da permiso de escritura a los usuarios
#     normales sobre esa carpeta (lo necesita preguntar-responsable.ps1
#     para poder anotar quien usa el equipo sin pedir permisos de
#     administrador cada vez).
#  4. Crea TRES Tareas Programadas:
#       - HelpdeskTI-Inventario (SYSTEM): corre reportar.ps1 al iniciar
#         sesion y cada 6 horas.
#       - HelpdeskTI-Comandos (SYSTEM): corre comandos.ps1 cada 15
#         minutos (acciones remotas, autoactualizacion del agente).
#       - HelpdeskTI-Responsable (el usuario que inicia sesion): corre
#         preguntar-responsable.ps1 al iniciar sesion, para confirmar
#         de vez en cuando quien usa el equipo.
#     Asi queda instalado de forma permanente, sin que haya que volver
#     a correr nada.
#  5. Corre reportar.ps1 una vez de inmediato, para que el equipo
#     aparezca en el inventario ya mismo.
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

$tokenInstalacion = $env:HDESKTI_TOKEN.Trim()
$responsableInicial = $env:HDESKTI_RESPONSABLE

$dir = "$env:ProgramData\HelpdeskTI"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$logPath = Join-Path $dir "instalar.log"
function Log($msg) {
  try { Add-Content -Path $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" -ErrorAction SilentlyContinue } catch {}
}

# ---- Ocultar la consola y mostrar la ventanita de Soporte TI ----
try {
  Add-Type -Name ConsoleWin -Namespace HelpdeskTI -MemberDefinition '
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  ' -ErrorAction Stop
  $ventanaConsola = [HelpdeskTI.ConsoleWin]::GetConsoleWindow()
  if ($ventanaConsola -ne [IntPtr]::Zero) { [HelpdeskTI.ConsoleWin]::ShowWindow($ventanaConsola, 0) | Out-Null }
} catch { Log "No se pudo ocultar la consola: $($_.Exception.Message)" }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$colorFondo   = [System.Drawing.Color]::FromArgb(5, 7, 10)
$colorTarjeta = [System.Drawing.Color]::FromArgb(18, 21, 28)
$colorAccento = [System.Drawing.Color]::FromArgb(63, 169, 255)
$colorTexto   = [System.Drawing.Color]::FromArgb(233, 236, 243)
$colorTenue   = [System.Drawing.Color]::FromArgb(137, 145, 163)
$colorOk      = [System.Drawing.Color]::FromArgb(48, 217, 150)
$colorError   = [System.Drawing.Color]::FromArgb(255, 85, 102)
$fuenteTitulo = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
$fuenteTexto  = New-Object System.Drawing.Font("Segoe UI", 10)
$fuenteChica  = New-Object System.Drawing.Font("Segoe UI", 9)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Soporte TI"
$form.Size = New-Object System.Drawing.Size(420, 320)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true
$form.BackColor = $colorFondo

$titulo = New-Object System.Windows.Forms.Label
$titulo.Text = "Soporte TI"
$titulo.Font = $fuenteTitulo
$titulo.ForeColor = $colorAccento
$titulo.AutoSize = $true
$titulo.Location = New-Object System.Drawing.Point(24, 20)
$form.Controls.Add($titulo)

$subtitulo = New-Object System.Windows.Forms.Label
$subtitulo.Text = "Registro de este equipo en el inventario"
$subtitulo.Font = $fuenteChica
$subtitulo.ForeColor = $colorTenue
$subtitulo.AutoSize = $true
$subtitulo.Location = New-Object System.Drawing.Point(24, 52)
$form.Controls.Add($subtitulo)

# ---- Panel 1: preguntar quien usa el equipo (si no vino por variable) ----
$panelNombre = New-Object System.Windows.Forms.Panel
$panelNombre.Location = New-Object System.Drawing.Point(0, 90)
$panelNombre.Size = New-Object System.Drawing.Size(420, 190)
$panelNombre.BackColor = $colorFondo
$form.Controls.Add($panelNombre)

$etiquetaNombre = New-Object System.Windows.Forms.Label
$etiquetaNombre.Text = "Quien usa este equipo? (opcional)"
$etiquetaNombre.Font = $fuenteTexto
$etiquetaNombre.ForeColor = $colorTexto
$etiquetaNombre.AutoSize = $true
$etiquetaNombre.Location = New-Object System.Drawing.Point(24, 10)
$panelNombre.Controls.Add($etiquetaNombre)

$cajaNombre = New-Object System.Windows.Forms.TextBox
$cajaNombre.Font = $fuenteTexto
$cajaNombre.ForeColor = $colorTexto
$cajaNombre.BackColor = $colorTarjeta
$cajaNombre.BorderStyle = "FixedSingle"
$cajaNombre.Location = New-Object System.Drawing.Point(24, 38)
$cajaNombre.Size = New-Object System.Drawing.Size(372, 26)
if ($responsableInicial) { $cajaNombre.Text = $responsableInicial }
$panelNombre.Controls.Add($cajaNombre)

$botonContinuar = New-Object System.Windows.Forms.Button
$botonContinuar.Text = "Continuar"
$botonContinuar.Font = $fuenteTexto
$botonContinuar.ForeColor = [System.Drawing.Color]::FromArgb(4, 20, 26)
$botonContinuar.BackColor = $colorAccento
$botonContinuar.FlatStyle = "Flat"
$botonContinuar.FlatAppearance.BorderSize = 0
$botonContinuar.Size = New-Object System.Drawing.Size(130, 34)
$botonContinuar.Location = New-Object System.Drawing.Point(24, 90)
$panelNombre.Controls.Add($botonContinuar)

$botonOmitir = New-Object System.Windows.Forms.LinkLabel
$botonOmitir.Text = "Asignar despues desde la app"
$botonOmitir.Font = $fuenteChica
$botonOmitir.LinkColor = $colorTenue
$botonOmitir.ActiveLinkColor = $colorAccento
$botonOmitir.AutoSize = $true
$botonOmitir.Location = New-Object System.Drawing.Point(24, 135)
$panelNombre.Controls.Add($botonOmitir)

# ---- Panel 2: progreso de la instalacion ----
$panelProgreso = New-Object System.Windows.Forms.Panel
$panelProgreso.Location = New-Object System.Drawing.Point(0, 90)
$panelProgreso.Size = New-Object System.Drawing.Size(420, 190)
$panelProgreso.BackColor = $colorFondo
$panelProgreso.Visible = $false
$form.Controls.Add($panelProgreso)

$etiquetaEstado = New-Object System.Windows.Forms.Label
$etiquetaEstado.Text = "Preparando..."
$etiquetaEstado.Font = $fuenteTexto
$etiquetaEstado.ForeColor = $colorTexto
$etiquetaEstado.AutoSize = $false
$etiquetaEstado.Size = New-Object System.Drawing.Size(372, 50)
$etiquetaEstado.Location = New-Object System.Drawing.Point(24, 14)
$panelProgreso.Controls.Add($etiquetaEstado)

$barra = New-Object System.Windows.Forms.ProgressBar
$barra.Style = "Marquee"
$barra.MarqueeAnimationSpeed = 30
$barra.Location = New-Object System.Drawing.Point(24, 68)
$barra.Size = New-Object System.Drawing.Size(372, 10)
$panelProgreso.Controls.Add($barra)

$botonCerrar = New-Object System.Windows.Forms.Button
$botonCerrar.Text = "Cerrar"
$botonCerrar.Font = $fuenteTexto
$botonCerrar.ForeColor = $colorTexto
$botonCerrar.BackColor = $colorTarjeta
$botonCerrar.FlatStyle = "Flat"
$botonCerrar.FlatAppearance.BorderSize = 0
$botonCerrar.Size = New-Object System.Drawing.Size(130, 34)
$botonCerrar.Location = New-Object System.Drawing.Point(24, 100)
$botonCerrar.Visible = $false
$botonCerrar.Add_Click({ $form.Close() })
$panelProgreso.Controls.Add($botonCerrar)

function Actualizar-Estado($texto, $color) {
  $etiquetaEstado.Text = $texto
  $etiquetaEstado.ForeColor = $color
  [System.Windows.Forms.Application]::DoEvents()
}

function Ejecutar-Instalacion($responsableTexto) {
  $panelNombre.Visible = $false
  $panelProgreso.Visible = $true
  [System.Windows.Forms.Application]::DoEvents()

  try {
    Actualizar-Estado "Guardando el token de esta empresa..." $colorTexto
    Set-Content -Path (Join-Path $dir "token.txt") -Value $tokenInstalacion -NoNewline -Encoding ascii

    $responsablePath = Join-Path $dir "responsable.txt"
    if ($responsableTexto -and $responsableTexto.Trim()) {
      Set-Content -Path $responsablePath -Value $responsableTexto.Trim() -NoNewline -Encoding UTF8
      Set-Content -Path (Join-Path $dir "responsable_confirmado.txt") -Value (Get-Date -Format "yyyy-MM-dd") -Encoding ascii
    } else {
      Remove-Item -Path $responsablePath -Force -ErrorAction SilentlyContinue
    }

    Actualizar-Estado "Descargando el agente..." $colorTexto
    $base = "https://zanetti10.github.io/PROGRAMAINVENTARIOEMPRESAS/agente"
    $reportarPath = Join-Path $dir "reportar.ps1"
    $comandosPath = Join-Path $dir "comandos.ps1"
    $preguntarPath = Join-Path $dir "preguntar-responsable.ps1"
    Invoke-WebRequest -Uri "$base/reportar.ps1" -OutFile $reportarPath -UseBasicParsing
    Invoke-WebRequest -Uri "$base/comandos.ps1" -OutFile $comandosPath -UseBasicParsing
    Invoke-WebRequest -Uri "$base/preguntar-responsable.ps1" -OutFile $preguntarPath -UseBasicParsing

    Actualizar-Estado "Ajustando permisos..." $colorTexto
    try { icacls "$dir" /grant "*S-1-5-32-545:(OI)(CI)M" /T /Q | Out-Null } catch {}

    Actualizar-Estado "Programando las tareas automaticas..." $colorTexto
    $config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

    $principalSistema = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    Unregister-ScheduledTask -TaskName "HelpdeskTI-Inventario" -Confirm:$false -ErrorAction SilentlyContinue
    $accionInv = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$reportarPath`""
    $disparadorInicio = New-ScheduledTaskTrigger -AtStartup
    $disparadorPeriodico = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName "HelpdeskTI-Inventario" -Action $accionInv -Trigger @($disparadorInicio, $disparadorPeriodico) -Principal $principalSistema -Settings $config -Description "Helpdesk TI: reporta este equipo al inventario automaticamente." -Force | Out-Null

    Unregister-ScheduledTask -TaskName "HelpdeskTI-Comandos" -Confirm:$false -ErrorAction SilentlyContinue
    $accionCmd = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$comandosPath`""
    $disparadorCmd = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 3650)
    Register-ScheduledTask -TaskName "HelpdeskTI-Comandos" -Action $accionCmd -Trigger $disparadorCmd -Principal $principalSistema -Settings $config -Description "Helpdesk TI: revisa cada 15 min si hay una accion remota pendiente." -Force | Out-Null

    Unregister-ScheduledTask -TaskName "HelpdeskTI-Responsable" -Confirm:$false -ErrorAction SilentlyContinue
    $principalGrupo = New-ScheduledTaskPrincipal -GroupId "BUILTIN\Users" -LogonType Group
    $accionResp = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$preguntarPath`""
    $disparadorResp = New-ScheduledTaskTrigger -AtLogOn
    $configResp = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName "HelpdeskTI-Responsable" -Action $accionResp -Trigger $disparadorResp -Principal $principalGrupo -Settings $configResp -Description "Helpdesk TI: pregunta de vez en cuando (en una ventanita, no en consola) si sigue siendo la misma persona la que usa este equipo." -Force | Out-Null

    Actualizar-Estado "Enviando el primer reporte..." $colorTexto
    $procesoReporte = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$reportarPath`"" -WindowStyle Hidden -PassThru
    $inicioEspera = Get-Date
    while (-not $procesoReporte.HasExited -and ((Get-Date) - $inicioEspera).TotalSeconds -lt 30) {
      Start-Sleep -Milliseconds 200
      [System.Windows.Forms.Application]::DoEvents()
    }

    $ultimaLinea = ""
    $rutaLogReportar = Join-Path $dir "reportar.log"
    if (Test-Path $rutaLogReportar) { $ultimaLinea = (Get-Content -Path $rutaLogReportar -Tail 1) }
    Log "Instalacion terminada. $ultimaLinea"

    $barra.Visible = $false
    Actualizar-Estado "Listo. Este equipo ya aparece en el inventario de Soporte TI." $colorOk
    $botonCerrar.Visible = $true

    $temporizador = New-Object System.Windows.Forms.Timer
    $temporizador.Interval = 5000
    $temporizador.Add_Tick({ $temporizador.Stop(); $form.Close() })
    $temporizador.Start()
  } catch {
    Log "ERROR durante la instalacion: $($_.Exception.Message)"
    $barra.Visible = $false
    Actualizar-Estado "Algo fallo durante la instalacion: $($_.Exception.Message)" $colorError
    $botonCerrar.Visible = $true
  }
}

$botonContinuar.Add_Click({ Ejecutar-Instalacion $cajaNombre.Text })
$botonOmitir.Add_Click({ Ejecutar-Instalacion $null })

if ($responsableInicial -and $responsableInicial.Trim()) {
  $panelNombre.Visible = $false
  $panelProgreso.Visible = $true
  $form.Add_Shown({ Ejecutar-Instalacion $responsableInicial })
}

[System.Windows.Forms.Application]::Run($form)
