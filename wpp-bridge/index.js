// ============================================================
// Helpdesk TI - Puente WhatsApp <-> n8n
// ------------------------------------------------------------
// Este script se conecta al WhatsApp de la empresa exactamente como lo
// hace WhatsApp Web (escaneando un QR una sola vez), y hace de puente
// en los dos sentidos con n8n:
//
//   WhatsApp -> n8n: cada mensaje que le llega a la empresa se manda
//   como POST a N8N_WEBHOOK_URL, para que n8n decida que hacer con el
//   (responder solo, avisar a alguien, guardarlo, lo que sea).
//
//   n8n -> WhatsApp: n8n le pide a este script que mande un mensaje
//   llamando a POST /enviar (protegido con una clave secreta).
//
// IMPORTANTE - esto NO es la API oficial de WhatsApp Business de Meta:
// es una libreria (Baileys) que imita el protocolo de WhatsApp Web. Es
// gratis y usa el mismo numero que ya tiene la empresa, pero al no ser
// oficial hay un riesgo bajo (pero real) de que WhatsApp bloquee el
// numero si detecta comportamiento de bot -- por eso este puente esta
// pensado para volumes normales de una empresa chica (avisos, alguna
// respuesta automatica puntual), NUNCA para mandar mensajes masivos o
// publicitarios.
//
// La carpeta "auth_info_baileys" que se crea al conectar por primera
// vez ES la sesion de WhatsApp -- equivale a tener el WhatsApp abierto.
// Nunca se debe subir a git ni compartir (ya esta en .gitignore).
// ============================================================

import "dotenv/config";
import express from "express";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";

const PUERTO = process.env.PORT || 3005;
const CLAVE_API = process.env.BRIDGE_API_KEY || "";
const WEBHOOK_N8N = process.env.N8N_WEBHOOK_URL || "";

const logger = pino({ level: "warn" }); // Baileys es ruidoso en "info"; con "warn" solo se ven problemas reales.

let socketActual = null;
let estaConectado = false;

// ------------------------------------------------------------
// Conexion a WhatsApp
// ------------------------------------------------------------
async function conectarWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false, // lo mostramos nosotros con qrcode-terminal, mas legible
  });

  socketActual = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (actualizacion) => {
    const { connection, lastDisconnect, qr } = actualizacion;

    if (qr) {
      console.log("\nEscanea este QR desde el WhatsApp de la empresa (Ajustes > Dispositivos vinculados > Vincular un dispositivo):\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      estaConectado = false;
      const razon = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : null;
      const debeReconectar = razon !== DisconnectReason.loggedOut;

      console.log(`Conexion cerrada (motivo: ${razon || "desconocido"}).`);

      if (debeReconectar) {
        console.log("Reconectando en 5 segundos...");
        setTimeout(conectarWhatsApp, 5000);
      } else {
        console.log("Se cerro la sesion desde el telefono (o se desvinculo el dispositivo). Borra la carpeta 'auth_info_baileys' y vuelve a correr el script para escanear un QR nuevo.");
      }
    } else if (connection === "open") {
      estaConectado = true;
      console.log("Conectado a WhatsApp correctamente. El puente ya esta activo.");
    }
  });

  // Mensajes entrantes: se los pasamos a n8n para que decida que hacer.
  sock.ev.on("messages.upsert", async (evento) => {
    if (evento.type !== "notify") return;

    for (const mensaje of evento.messages) {
      if (mensaje.key.fromMe) continue; // ignorar lo que la propia empresa manda
      if (!mensaje.message) continue; // notificaciones sin contenido (reacciones, etc.)

      const numero = mensaje.key.remoteJid || "";
      const esGrupo = numero.endsWith("@g.us");
      const texto =
        mensaje.message.conversation ||
        mensaje.message.extendedTextMessage?.text ||
        mensaje.message.imageMessage?.caption ||
        mensaje.message.videoMessage?.caption ||
        "";

      const datos = {
        numero,
        esGrupo,
        nombreContacto: mensaje.pushName || "",
        texto,
        timestamp: Number(mensaje.messageTimestamp) || Math.floor(Date.now() / 1000),
      };

      console.log(`Mensaje de ${datos.nombreContacto || datos.numero}: ${datos.texto}`);

      if (!WEBHOOK_N8N) continue; // sin webhook configurado, solo se deja el log en consola

      try {
        await fetch(WEBHOOK_N8N, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(datos),
        });
      } catch (error) {
        console.log("No se pudo avisar a n8n del mensaje entrante:", error.message);
      }
    }
  });

  return sock;
}

// ------------------------------------------------------------
// API local para que n8n pueda mandar mensajes
// ------------------------------------------------------------
const app = express();
app.use(express.json());

app.get("/estado", (_req, res) => {
  res.json({ conectado: estaConectado });
});

app.post("/enviar", async (req, res) => {
  if (!CLAVE_API || req.headers["x-api-key"] !== CLAVE_API) {
    return res.status(401).json({ error: "Falta la clave de acceso o esta mal (header x-api-key)." });
  }

  if (!estaConectado || !socketActual) {
    return res.status(503).json({ error: "El puente todavia no esta conectado a WhatsApp." });
  }

  const { numero, mensaje } = req.body || {};
  if (!numero || !mensaje) {
    return res.status(400).json({ error: "Falta 'numero' (ej: 573001234567) o 'mensaje'." });
  }

  // Acepta tanto "573001234567" como el jid completo "573001234567@s.whatsapp.net".
  const jid = numero.includes("@") ? numero : `${numero.replace(/\D/g, "")}@s.whatsapp.net`;

  try {
    await socketActual.sendMessage(jid, { text: mensaje });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.listen(PUERTO, () => {
  console.log(`API del puente escuchando en el puerto ${PUERTO} (POST /enviar, GET /estado).`);
});

conectarWhatsApp();
