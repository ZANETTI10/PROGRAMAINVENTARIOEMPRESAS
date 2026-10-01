# Puente WhatsApp <-> n8n (Soporte TI)

Script que conecta el WhatsApp de la empresa con n8n, para poder automatizar
respuestas, avisos, etc. Se conecta a WhatsApp igual que lo hace WhatsApp
Web (escaneando un QR), no usa la API oficial de Meta.

**Antes de usarlo, ten claro esto:** no es oficial de WhatsApp. Sirve muy
bien para volumen de una empresa chica (contestar clientes, mandar un
aviso puntual), pero si se usa para mandar mensajes masivos o parecidos a
publicidad, hay riesgo de que WhatsApp bloquee el numero. Usalo solo para
conversacion real con clientes.

## Donde debe correr

Este script tiene que quedar **prendido todo el tiempo** (es el que
mantiene la conexion con WhatsApp abierta) -- no es como la pagina de
Helpdesk TI que vive en GitHub Pages. Necesita un compu o servidor que se
quede encendido:

- Lo mas simple: un PC o servidor de la oficina que ya se deja prendido,
  con Node.js instalado.
- Tambien puede ir en un VPS baratito (DigitalOcean, un servidor casero,
  etc.) si prefieres no depender de un compu fisico.

Si el proceso se cae o se apaga el equipo, WhatsApp sigue recibiendo
mensajes normal (no se pierde nada), pero mientras el script no vuelva a
estar corriendo, n8n no se entera de los mensajes nuevos ni puede
contestar.

## Primer uso

1. Instala Node.js (18 o mas nuevo) en el equipo donde va a correr esto.
2. Copia esta carpeta `wpp-bridge` a ese equipo.
3. Copia `.env.example` a `.env` y complétalo:
   - `BRIDGE_API_KEY`: invéntate una clave larga (para que solo n8n pueda
     pedirle al puente que mande mensajes).
   - `N8N_WEBHOOK_URL`: la URL del webhook de n8n que va a recibir los
     mensajes entrantes (puedes dejarlo vacío al principio y agregarlo
     después).
4. Abre una terminal en la carpeta y corre:
   ```
   npm install
   npm start
   ```
5. Va a aparecer un código QR en la terminal. Ábre WhatsApp en el
   **teléfono de la empresa** (el que ya usan para atender clientes) →
   Ajustes → Dispositivos vinculados → Vincular un dispositivo → escanea
   ese QR.
6. Cuando veas "Conectado a WhatsApp correctamente", ya quedó
   funcionando. La sesión se guarda en la carpeta `auth_info_baileys`
   (no la borres, no la subas a ningún lado) para no tener que volver a
   escanear el QR cada vez que reinicies el script.

Para dejarlo corriendo siempre, aunque cierres la terminal o se reinicie
el equipo, lo ideal es usar algo como [pm2](https://pm2.keymetrics.io/)
o una tarea programada / servicio del sistema — si quieres, luego
armamos eso también.

## Cómo lo usa n8n

**Para recibir mensajes:** en n8n, crea un flujo que empiece con un nodo
"Webhook", copia la URL que te da, y ponla en `N8N_WEBHOOK_URL` en el
`.env` (y reinicia el script). Cada mensaje que le llegue al WhatsApp de
la empresa va a llegar a ese webhook como JSON:

```json
{
  "numero": "573001234567@s.whatsapp.net",
  "esGrupo": false,
  "nombreContacto": "Juan Pérez",
  "texto": "Hola, se me cayó internet",
  "timestamp": 1758000000
}
```

**Para mandar mensajes:** desde n8n, agrega un nodo "HTTP Request" que
haga:

```
POST http://<ip-del-equipo>:3005/enviar
Header: x-api-key: <la misma clave que pusiste en BRIDGE_API_KEY>
Body (JSON): { "numero": "573001234567", "mensaje": "Ya vamos a revisar tu caso." }
```

Con esos dos nodos (Webhook + HTTP Request) n8n ya puede leer y contestar
por WhatsApp — el resto (qué contestar, a quién, cuándo) se arma dentro
del flujo de n8n.

## Revisar que sigue conectado

`GET http://<ip-del-equipo>:3005/estado` devuelve `{"conectado": true}` o
`{"conectado": false}` — útil para que n8n (o cualquier cosa) chequee que
el puente sigue vivo.
