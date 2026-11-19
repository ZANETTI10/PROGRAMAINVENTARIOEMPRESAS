# ============================================================
# Helpdesk TI - preguntar-responsable.ps1
# ------------------------------------------------------------
# Corre en la sesion de quien inicia sesion en Windows (no como
# SYSTEM, para poder mostrar una ventanita en pantalla) y, de vez en
# cuando, pregunta si sigue siendo la misma persona guardada como
# responsable del equipo -- o quien es la persona nueva, si cambio.
# Asi el inventario de Helpdesk TI queda al dia solo, sin que alguien
# tenga que entrar a la app a editarlo a mano (y sin el riesgo de que,
# al hacerlo a mano, alguien termine creando un equipo duplicado en
# vez de editar el que ya existe: aqui SIEMPRE se actualiza el mismo
# equipo -- se identifica por su serial -- nunca se toca su nombre de
# red ni se crea uno nuevo).
#
# La ventanita usa los mismos colores de la app (fondo oscuro, acento
# azul) para que se vea como "Soporte TI" y no como un aviso generico
# de Windows.
#
# Pregunta como maximo una vez por dia (para no insistir si alguien
# cierra y abre sesion varias veces), y solo vuelve a preguntar cuando
# ya pasaron unos 30 dias desde la ultima vez que alguien confirmo
# quien lo usa.
# ============================================================

$ErrorActionPreference = "Continue"

$dir = "$env:ProgramData\HelpdeskTI"
$responsablePath  = Join-Path $dir "responsable.txt"
$confirmadoPath   = Join-Path $dir "responsable_confirmado.txt"
$preguntadoPath   = Join-Path $dir "responsable_preguntado.txt"
$historialPath    = Join-Path $dir "responsable_historial.txt"
$logPath          = Join-Path $dir "preguntar.log"
$reportarPath     = Join-Path $dir "reportar.ps1"

function Log($msg) {
  try { Add-Content -Path $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" -ErrorAction SilentlyContinue } catch {}
}

if (-not (Test-Path $dir)) { exit 0 }

$hoy = Get-Date -Format "yyyy-MM-dd"

# No preguntar dos veces el mismo dia.
if (Test-Path $preguntadoPath) {
  $ultimaPregunta = (Get-Content -Path $preguntadoPath -Raw -ErrorAction SilentlyContinue)
  if ($ultimaPregunta -and $ultimaPregunta.Trim() -eq $hoy) { exit 0 }
}

# Si ya confirmaron hace menos de 30 dias, todavia no toca preguntar.
if (Test-Path $confirmadoPath) {
  try {
    $textoConfirmado = (Get-Content -Path $confirmadoPath -Raw -ErrorAction SilentlyContinue)
    if ($textoConfirmado) {
      $fechaConfirmado = [datetime]::ParseExact($textoConfirmado.Trim(), "yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
      if (((Get-Date) - $fechaConfirmado).TotalDays -lt 30) { exit 0 }
    }
  } catch {}
}

try { Set-Content -Path $preguntadoPath -Value $hoy -Encoding ascii -ErrorAction Stop } catch { exit 0 }

try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
} catch { Log "No se pudo cargar Windows Forms: $($_.Exception.Message)"; exit 0 }

$colorFondo   = [System.Drawing.Color]::FromArgb(5, 7, 10)
$colorTarjeta = [System.Drawing.Color]::FromArgb(18, 21, 28)
$colorAccento = [System.Drawing.Color]::FromArgb(63, 169, 255)
$colorTexto   = [System.Drawing.Color]::FromArgb(233, 236, 243)
$colorTenue   = [System.Drawing.Color]::FromArgb(137, 145, 163)
$fuenteTitulo = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$fuenteTexto  = New-Object System.Drawing.Font("Segoe UI", 10)

function Nueva-Ventana($alto) {
  $f = New-Object System.Windows.Forms.Form
  $f.Text = "Soporte TI"
  $f.Size = New-Object System.Drawing.Size(380, $alto)
  $f.StartPosition = "CenterScreen"
  $f.FormBorderStyle = "FixedDialog"
  $f.MaximizeBox = $false
  $f.MinimizeBox = $false
  $f.TopMost = $true
  $f.BackColor = $colorFondo
  $tituloForm = New-Object System.Windows.Forms.Label
  $tituloForm.Text = "Soporte TI"
  $tituloForm.Font = $fuenteTitulo
  $tituloForm.ForeColor = $colorAccento
  $tituloForm.AutoSize = $true
  $tituloForm.Location = New-Object System.Drawing.Point(20, 16)
  $f.Controls.Add($tituloForm)
  return $f
}

function Mostrar-Confirmacion($mensaje) {
  $f = Nueva-Ventana 240
  $texto = New-Object System.Windows.Forms.Label
  $texto.Text = $mensaje
  $texto.Font = $fuenteTexto
  $texto.ForeColor = $colorTexto
  $texto.Size = New-Object System.Drawing.Size(336, 80)
  $texto.Location = New-Object System.Drawing.Point(20, 52)
  $f.Controls.Add($texto)

  $botonSi = New-Object System.Windows.Forms.Button
  $botonSi.Text = "Si, sigue siendo"
  $botonSi.Font = $fuenteTexto
  $botonSi.ForeColor = [System.Drawing.Color]::FromArgb(4, 20, 26)
  $botonSi.BackColor = $colorAccento
  $botonSi.FlatStyle = "Flat"
  $botonSi.FlatAppearance.BorderSize = 0
  $botonSi.Size = New-Object System.Drawing.Size(160, 34)
  $botonSi.Location = New-Object System.Drawing.Point(20, 150)
  $botonSi.DialogResult = [System.Windows.Forms.DialogResult]::Yes
  $f.Controls.Add($botonSi)

  $botonNo = New-Object System.Windows.Forms.Button
  $botonNo.Text = "No, cambio"
  $botonNo.Font = $fuenteTexto
  $botonNo.ForeColor = $colorTexto
  $botonNo.BackColor = $colorTarjeta
  $botonNo.FlatStyle = "Flat"
  $botonNo.FlatAppearance.BorderSize = 0
  $botonNo.Size = New-Object System.Drawing.Size(160, 34)
  $botonNo.Location = New-Object System.Drawing.Point(196, 150)
  $botonNo.DialogResult = [System.Windows.Forms.DialogResult]::No
  $f.Controls.Add($botonNo)

  $f.AcceptButton = $botonSi
  $resultadoDialogo = $f.ShowDialog()
  return ($resultadoDialogo -eq [System.Windows.Forms.DialogResult]::Yes)
}

function Mostrar-EntradaTexto($mensaje) {
  $f = Nueva-Ventana 270
  $texto = New-Object System.Windows.Forms.Label
  $texto.Text = $mensaje
  $texto.Font = $fuenteTexto
  $texto.ForeColor = $colorTexto
  $texto.Size = New-Object System.Drawing.Size(336, 70)
  $texto.Location = New-Object System.Drawing.Point(20, 52)
  $f.Controls.Add($texto)

  $caja = New-Object System.Windows.Forms.TextBox
  $caja.Font = $fuenteTexto
  $caja.ForeColor = $colorTexto
  $caja.BackColor = $colorTarjeta
  $caja.BorderStyle = "FixedSingle"
  $caja.Location = New-Object System.Drawing.Point(20, 126)
  $caja.Size = New-Object System.Drawing.Size(336, 26)
  $f.Controls.Add($caja)

  $botonOk = New-Object System.Windows.Forms.Button
  $botonOk.Text = "Guardar"
  $botonOk.Font = $fuenteTexto
  $botonOk.ForeColor = [System.Drawing.Color]::FromArgb(4, 20, 26)
  $botonOk.BackColor = $colorAccento
  $botonOk.FlatStyle = "Flat"
  $botonOk.FlatAppearance.BorderSize = 0
  $botonOk.Size = New-Object System.Drawing.Size(160, 34)
  $botonOk.Location = New-Object System.Drawing.Point(20, 180)
  $botonOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $f.Controls.Add($botonOk)

  $botonCancelar = New-Object System.Windows.Forms.Button
  $botonCancelar.Text = "Cancelar"
  $botonCancelar.Font = $fuenteTexto
  $botonCancelar.ForeColor = $colorTexto
  $botonCancelar.BackColor = $colorTarjeta
  $botonCancelar.FlatStyle = "Flat"
  $botonCancelar.FlatAppearance.BorderSize = 0
  $botonCancelar.Size = New-Object System.Drawing.Size(160, 34)
  $botonCancelar.Location = New-Object System.Drawing.Point(196, 180)
  $botonCancelar.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $f.Controls.Add($botonCancelar)

  $f.AcceptButton = $botonOk
  $f.CancelButton = $botonCancelar
  $f.Add_Shown({ $caja.Focus() })

  $resultadoDialogo = $f.ShowDialog()
  if ($resultadoDialogo -eq [System.Windows.Forms.DialogResult]::OK) { return $caja.Text }
  return $null
}

$responsableActual = $null
if (Test-Path $responsablePath) {
  $valor = (Get-Content -Path $responsablePath -Raw -ErrorAction SilentlyContinue)
  if ($valor) { $responsableActual = $valor.Trim() }
}

function Guardar-Nuevo($nombre, $anterior) {
  $nombre = $nombre.Trim()
  if (-not $nombre) { return $false }
  Set-Content -Path $responsablePath -Value $nombre -NoNewline -Encoding UTF8
  Set-Content -Path $confirmadoPath -Value $hoy -Encoding ascii
  try {
    $anteriorTexto = if ($anterior) { $anterior } else { "(sin asignar)" }
    Add-Content -Path $historialPath -Value "$hoy`t$anteriorTexto`t$nombre" -Encoding UTF8
  } catch {}
  Log "Responsable actualizado: '$anterior' -> '$nombre'"
  return $true
}

$cambio = $false

if (-not $responsableActual) {
  $nuevo = Mostrar-EntradaTexto "Quien usa este equipo? Lo guardamos en el inventario de Soporte TI. Puedes dejarlo en blanco si no sabes."
  if ($nuevo -and $nuevo.Trim()) {
    $cambio = Guardar-Nuevo $nuevo $null
  } else {
    Log "No se asigno responsable (en blanco o cancelado)."
  }
} else {
  $sigueIgual = Mostrar-Confirmacion "$responsableActual sigue usando este equipo?`n`nSi cambio, elige 'No, cambio' y te preguntamos quien es ahora."
  if ($sigueIgual) {
    Set-Content -Path $confirmadoPath -Value $hoy -Encoding ascii
    Log "Responsable confirmado sin cambios: $responsableActual"
  } else {
    $nuevo = Mostrar-EntradaTexto "Quien usa ahora este equipo?"
    if ($nuevo -and $nuevo.Trim() -and $nuevo.Trim() -ne $responsableActual) {
      $cambio = Guardar-Nuevo $nuevo $responsableActual
    } else {
      Log "Se indico que cambio el responsable pero no se dio un nombre nuevo; se vuelve a preguntar despues."
    }
  }
}

if ($cambio -and (Test-Path $reportarPath)) {
  try {
    Log "Enviando el inventario actualizado de inmediato."
    & $reportarPath
  } catch {
    Log "No se pudo reportar de inmediato: $($_.Exception.Message)"
  }
}
