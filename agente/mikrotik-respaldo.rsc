# ============================================================
# Helpdesk TI - respaldo mensual de MikroTik
# ------------------------------------------------------------
# Exporta la configuracion del router y la manda a la app de
# Helpdesk TI. La primera vez que corre, el router queda
# registrado SOLO en la app (no hace falta crearlo a mano) -- se
# identifica por el serial del equipo, nunca por su IP.
#
# El respaldo que llega a la app es TEXTO (configuracion exportada
# con /export), no el archivo binario .backup: mas facil de leer y
# de restaurar (import), y evita el limite de tamano de un archivo
# binario dentro de una variable de RouterOS. En RouterOS 6, ese
# limite es de unos 4KB -- si la configuracion es muy grande, el
# respaldo puede llegar recortado; en RouterOS 7 el limite es mucho
# mayor.
#
# INSTALACION (una sola vez, pegando esto completo en Terminal o en
# "New Terminal" de WinBox):
#   1. Reemplazar TOKEN_AQUI por el token que te dio la app (boton
#      "Generar token de respaldo" en Monitoreo > Routers).
#   2. Pegar todo el bloque de aqui abajo (los 3 comandos: crear el
#      script, correrlo una vez ya mismo, y dejarlo programado cada
#      mes).
# ============================================================

/system script add name="helpdeskti-respaldo" source={
  :local token "TOKEN_AQUI";
  :local urlBase "https://jkeqpwzricshyibqyose.supabase.co/functions/v1/mikrotik-respaldo";
  :local apikey "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZXFwd3pyaWNzaHlpYnF5b3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTEyMTYsImV4cCI6MjEwNDQ2NzIxNn0.PvylLQ1jhmMKyJZTj6EnwSrWcsXdMnUmOs9bhs9TXJA";
  :local archivoBase "helpdeskti-respaldo";
  /export file=$archivoBase;
  :delay 2s;
  :local archivo ($archivoBase . ".rsc");
  :local contenido [/file get [/file find name=$archivo] contents];
  :local identidad [/system identity get name];
  :local modelo "desconocido";
  :local serial "desconocido";
  :do {
    :set modelo [/system routerboard get model];
    :set serial [/system routerboard get serial-number];
  } on-error={};
  :local version [/system resource get version];
  :local headers "apikey:$apikey,Content-Type:text/plain,X-Token:$token,X-Identidad:$identidad,X-Serial:$serial,X-Modelo:$modelo,X-Version:$version";
  /tool fetch url=$urlBase http-method=post http-data=$contenido http-header-field=$headers output=none;
  /file remove [/file find name=$archivo];
}
/system script run helpdeskti-respaldo
/system scheduler add name="helpdeskti-respaldo" interval=4w start-time=startup on-event=helpdeskti-respaldo

# ------------------------------------------------------------
# Para revisar manualmente que quedo bien instalado:
#   /system script print
#   /system scheduler print
#   /log print where topics~"script"
#
# Para forzar un respaldo fuera de lo programado (por ejemplo justo
# despues de cambiar algo en el router):
#   /system script run helpdeskti-respaldo
#
# Para desinstalarlo:
#   /system scheduler remove helpdeskti-respaldo
#   /system script remove helpdeskti-respaldo
# ------------------------------------------------------------
