// ============================================================
// Edge Function: mikrotik-estado
// ------------------------------------------------------------
// Consulta en vivo, para una empresa, el estado de su(s) router(s)
// MikroTik: información del equipo (modelo, RouterOS, uptime, CPU,
// RAM, temperatura/voltaje si el equipo lo reporta), la IP pública
// en la interfaz WAN, el estado y tráfico de TODAS las interfaces
// (no solo las que se configuren como WAN/LAN), y cuántos
// dispositivos están conectados (arrendamientos DHCP activos).
//
// Se conecta directamente al router por su API nativa (el mismo
// protocolo que usa WinBox), desde el servidor — nunca desde el
// navegador. Cualquier usuario logueado (técnico o admin) puede
// pedir este estado; solo el admin puede cambiar la configuración
// del router (eso lo hace la función "mikrotik-config").
//
// Importante: todas las consultas a un mismo router van UNA POR UNA
// (secuenciales), nunca en paralelo — comparten una sola conexión
// TCP y el protocolo de MikroTik no distingue aquí a cuál pregunta
// pertenece cada respuesta, así que mandar varias a la vez mezclaría
// los datos.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ------------------------------------------------------------
// Cliente mínimo del API binario de MikroTik (RouterOS). Solo
// implementa lo necesario: conectar, iniciar sesión y enviar
// comandos que devuelven filas (!re ... !done) o un error (!trap).
// ------------------------------------------------------------

type Fila = Record<string, string>;

class MikrotikApi {
  private conn: Deno.TcpConn | Deno.TlsConn;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  private constructor(conn: Deno.TcpConn | Deno.TlsConn) {
    this.conn = conn;
  }

  static async conectar(host: string, puerto: number, ssl: boolean, timeoutMs = 7000): Promise<MikrotikApi> {
    const intento = ssl
      ? Deno.connectTls({ hostname: host, port: puerto })
      : Deno.connect({ hostname: host, port: puerto });

    const conn = await Promise.race([
      intento,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("No se pudo conectar (tiempo de espera agotado). Revisa la IP, el puerto y que el firewall lo permita.")), timeoutMs)
      ),
    ]);
    return new MikrotikApi(conn as Deno.TcpConn | Deno.TlsConn);
  }

  private codificarLongitud(len: number): Uint8Array {
    if (len < 0x80) return new Uint8Array([len]);
    if (len < 0x4000) {
      const l = len | 0x8000;
      return new Uint8Array([(l >> 8) & 0xff, l & 0xff]);
    }
    if (len < 0x200000) {
      const l = len | 0xc00000;
      return new Uint8Array([(l >> 16) & 0xff, (l >> 8) & 0xff, l & 0xff]);
    }
    if (len < 0x10000000) {
      const l = len | 0xe0000000;
      return new Uint8Array([(l >>> 24) & 0xff, (l >> 16) & 0xff, (l >> 8) & 0xff, l & 0xff]);
    }
    return new Uint8Array([0xf0, (len >>> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
  }

  private async escribirPalabra(palabra: string) {
    const bytes = new TextEncoder().encode(palabra);
    const prefijo = this.codificarLongitud(bytes.length);
    const paquete = new Uint8Array(prefijo.length + bytes.length);
    paquete.set(prefijo, 0);
    paquete.set(bytes, prefijo.length);
    await this.conn.write(paquete);
  }

  private async enviarSentencia(palabras: string[]) {
    for (const p of palabras) await this.escribirPalabra(p);
    await this.conn.write(new Uint8Array([0]));
  }

  private concat(a: Uint8Array<ArrayBufferLike>, b: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  private async asegurarBytes(n: number) {
    while (this.buffer.length < n) {
      const chunk = new Uint8Array(4096);
      const leidos = await this.conn.read(chunk);
      if (leidos === null) throw new Error("El router cerró la conexión inesperadamente.");
      this.buffer = this.concat(this.buffer, chunk.slice(0, leidos));
    }
  }

  private async leerByte(): Promise<number> {
    await this.asegurarBytes(1);
    const b = this.buffer[0];
    this.buffer = this.buffer.slice(1);
    return b;
  }

  private async leerBytes(n: number): Promise<Uint8Array<ArrayBufferLike>> {
    await this.asegurarBytes(n);
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  private async leerLongitud(): Promise<number> {
    const b0 = await this.leerByte();
    if ((b0 & 0x80) === 0) return b0;
    if ((b0 & 0xc0) === 0x80) {
      const b1 = await this.leerByte();
      return ((b0 & 0x3f) << 8) | b1;
    }
    if ((b0 & 0xe0) === 0xc0) {
      const b1 = await this.leerByte();
      const b2 = await this.leerByte();
      return ((b0 & 0x1f) << 16) | (b1 << 8) | b2;
    }
    if ((b0 & 0xf0) === 0xe0) {
      const b1 = await this.leerByte();
      const b2 = await this.leerByte();
      const b3 = await this.leerByte();
      return ((b0 & 0x0f) << 24) | (b1 << 16) | (b2 << 8) | b3;
    }
    const b1 = await this.leerByte();
    const b2 = await this.leerByte();
    const b3 = await this.leerByte();
    const b4 = await this.leerByte();
    return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4;
  }

  private async leerPalabra(): Promise<string> {
    const len = await this.leerLongitud();
    if (len === 0) return "";
    const bytes = await this.leerBytes(len);
    return new TextDecoder().decode(bytes);
  }

  private async leerSentencia(): Promise<string[]> {
    const palabras: string[] = [];
    while (true) {
      const palabra = await this.leerPalabra();
      if (palabra === "") break;
      palabras.push(palabra);
    }
    return palabras;
  }

  async comando(palabras: string[], timeoutMs = 9000): Promise<Fila[]> {
    await this.enviarSentencia(palabras);
    const filas: Fila[] = [];
    const limite = Date.now() + timeoutMs;

    while (true) {
      if (Date.now() > limite) throw new Error("El router no respondió a tiempo.");
      const sentencia = await this.leerSentencia();
      const tipo = sentencia[0];

      if (tipo === "!re") {
        const fila: Fila = {};
        for (const p of sentencia.slice(1)) {
          if (p.startsWith("=")) {
            const idx = p.indexOf("=", 1);
            if (idx > 0) fila[p.slice(1, idx)] = p.slice(idx + 1);
          }
        }
        filas.push(fila);
      } else if (tipo === "!done") {
        return filas;
      } else if (tipo === "!trap") {
        const msg = sentencia.find((p) => p.startsWith("=message="));
        throw new Error(msg ? msg.slice("=message=".length) : "El router rechazó el comando.");
      }
      // otros tipos (!fatal, etc.): seguimos esperando !done/!trap.
    }
  }

  async login(usuario: string, password: string) {
    await this.comando(["/login", "=name=" + usuario, "=password=" + password]);
  }

  cerrar() {
    try {
      this.conn.close();
    } catch (_e) {
      // ya estaba cerrada
    }
  }
}

// ------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace("Bearer ", "");
    if (!callerToken) return json({ error: "No autenticado." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: callerData, error: callerError } = await admin.auth.getUser(callerToken);
    if (callerError || !callerData?.user) return json({ error: "Sesión inválida." }, 401);

    const body = await req.json();
    const empresaId = body.empresa_id;
    if (!empresaId) return json({ error: "Falta la empresa." }, 400);

    const { data: routers, error: routersError } = await admin
      .from("mikrotik_routers")
      .select("*")
      .eq("empresa_id", empresaId);

    if (routersError) return json({ error: routersError.message }, 400);
    if (!routers || routers.length === 0) return json({ routers: [] });

    const resultados = await Promise.all(routers.map((r) => consultarRouter(r)));
    return json({ routers: resultados });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

async function consultarRouter(r: Record<string, any>) {
  const base = { id: r.id, nombre: r.nombre };
  let api: MikrotikApi | null = null;

  try {
    api = await MikrotikApi.conectar(r.host, r.puerto, r.ssl);
    await api.login(r.usuario, r.password);

    // ---- Información general del equipo ----
    let sistema: Record<string, unknown> | null = null;
    try {
      const recurso = (await api.comando(["/system/resource/print"]))[0] || {};
      sistema = {
        modelo: recurso["board-name"] || null,
        version: recurso["version"] || null,
        uptime: recurso["uptime"] || null,
        cpu_carga: recurso["cpu-load"] != null ? parseInt(recurso["cpu-load"], 10) : null,
        memoria_libre: recurso["free-memory"] != null ? parseInt(recurso["free-memory"], 10) : null,
        memoria_total: recurso["total-memory"] != null ? parseInt(recurso["total-memory"], 10) : null,
      };
    } catch (_e) {
      sistema = null;
    }

    let identidad: string | null = null;
    try {
      const idRow = (await api.comando(["/system/identity/print"]))[0] || {};
      identidad = idRow.name || null;
    } catch (_e) {
      identidad = null;
    }

    // Temperatura/voltaje: no todos los equipos MikroTik lo reportan
    // (depende del modelo), así que si falla simplemente se omite.
    let salud: Record<string, string> | null = null;
    try {
      const filasSalud = await api.comando(["/system/health/print"]);
      if (filasSalud.length > 0) {
        salud = {};
        for (const f of filasSalud) {
          // RouterOS 7: cada fila trae {name, value}. RouterOS 6: una sola
          // fila con todas las claves directamente.
          if (f.name && f.value !== undefined) salud[f.name] = f.value;
          else Object.assign(salud, f);
        }
      }
    } catch (_e) {
      salud = null;
    }

    // ---- Interfaces: TODAS, con su tráfico, no solo WAN/LAN ----
    const interfaces = await api.comando(["/interface/print"]);
    const buscar = (nombre: string) => interfaces.find((i) => i.name === nombre);

    // Detalle de VLANs (ID y sobre qué interfaz física van), para poder
    // mostrarlas identificadas dentro de la lista de interfaces.
    let vlans: Record<string, string>[] = [];
    try {
      vlans = await api.comando(["/interface/vlan/print"]);
    } catch (_e) {
      vlans = [];
    }
    const vlanPorNombre = new Map(vlans.map((v) => [v.name, v]));

    const medirTrafico = async (nombreIf: string | undefined) => {
      if (!nombreIf || !api) return null;
      try {
        const res = await api.comando(["/interface/monitor-traffic", "=interface=" + nombreIf, "=once="]);
        const fila = res[0] || {};
        return {
          rx_bps: parseInt(fila["rx-bits-per-second"] || "0", 10),
          tx_bps: parseInt(fila["tx-bits-per-second"] || "0", 10),
        };
      } catch (_e) {
        return null;
      }
    };

    const todasInterfaces: Record<string, unknown>[] = [];
    for (const i of interfaces) {
      const vlanInfo = i.type === "vlan" ? vlanPorNombre.get(i.name) : undefined;
      const extraVlan = vlanInfo
        ? { vlan_id: vlanInfo["vlan-id"] || null, vlan_padre: vlanInfo["interface"] || null }
        : { vlan_id: null, vlan_padre: null };

      if (i.disabled === "true") {
        todasInterfaces.push({
          nombre: i.name,
          tipo: i.type || null,
          activa: false,
          deshabilitada: true,
          rx_bps: null,
          tx_bps: null,
          ...extraVlan,
        });
        continue;
      }
      const t = await medirTrafico(i.name);
      todasInterfaces.push({
        nombre: i.name,
        tipo: i.type || null,
        activa: i.running === "true",
        deshabilitada: false,
        rx_bps: t?.rx_bps ?? null,
        tx_bps: t?.tx_bps ?? null,
        ...extraVlan,
      });
    }

    const wanIf = buscar(r.wan_interface);
    const lanIf = buscar(r.lan_interface);
    const wanMedida = wanIf ? todasInterfaces.find((x) => x.nombre === wanIf.name) : null;
    const lanMedida = lanIf ? todasInterfaces.find((x) => x.nombre === lanIf.name) : null;

    // ---- IP pública asignada a la interfaz WAN ----
    let wanIp: string | null = null;
    if (wanIf) {
      try {
        const direcciones = await api.comando(["/ip/address/print", "?interface=" + wanIf.name]);
        if (direcciones[0]?.address) wanIp = direcciones[0].address;
      } catch (_e) {
        wanIp = null;
      }
    }

    // ---- Dispositivos conectados (arrendamientos DHCP activos) ----
    let dispositivos = -1;
    try {
      const leases = await api.comando(["/ip/dhcp-server/lease/print"]);
      dispositivos = leases.filter((l) => l.status === "bound").length;
    } catch (_e) {
      dispositivos = -1;
    }

    // ---- Registros del router con errores/advertencias recientes ----
    // Ayuda a ver "qué puede estar fallando" sin tener que abrir WinBox:
    // se revisan los últimos logs y se separan los que MikroTik marcó
    // como error o crítico (temas como "critical", "error", "firewall",
    // caídas de PPPoE, DHCP, wireless, etc.).
    let logs: Record<string, unknown>[] = [];
    try {
      const todosLogs = await api.comando(["/log/print"]);
      logs = todosLogs
        .filter((l) => /error|critical/i.test(l.topics || ""))
        .slice(-15)
        .reverse()
        .map((l) => ({ tiempo: l.time || null, temas: l.topics || null, mensaje: l.message || null }));
    } catch (_e) {
      logs = [];
    }

    // ---- Diagnóstico automático: reglas simples para detectar fallas comunes ----
    const diagnostico: { nivel: "alerta" | "advertencia"; mensaje: string }[] = [];

    if (sistema?.cpu_carga != null && (sistema.cpu_carga as number) >= 80) {
      diagnostico.push({ nivel: "alerta", mensaje: `CPU muy alta: ${sistema.cpu_carga}%.` });
    }
    if (sistema?.memoria_libre != null && sistema?.memoria_total) {
      const pctLibre = (sistema.memoria_libre as number) / (sistema.memoria_total as number);
      if (pctLibre < 0.15) {
        diagnostico.push({ nivel: "alerta", mensaje: `Memoria RAM casi agotada: ${(pctLibre * 100).toFixed(0)}% libre.` });
      }
    }
    if (salud?.temperature && parseFloat(salud.temperature) >= 65) {
      diagnostico.push({ nivel: "alerta", mensaje: `Temperatura alta: ${salud.temperature} °C.` });
    }
    if (!wanIf) {
      diagnostico.push({ nivel: "alerta", mensaje: `No se encontró la interfaz WAN configurada ("${r.wan_interface}").` });
    } else if (!(wanMedida as any)?.activa) {
      diagnostico.push({ nivel: "alerta", mensaje: `La interfaz WAN (${wanIf.name}) está caída.` });
    } else if (!wanIp) {
      diagnostico.push({ nivel: "advertencia", mensaje: `La interfaz WAN (${wanIf.name}) no tiene IP asignada.` });
    }
    if (!lanIf) {
      diagnostico.push({ nivel: "alerta", mensaje: `No se encontró la interfaz LAN configurada ("${r.lan_interface}").` });
    } else if (!(lanMedida as any)?.activa) {
      diagnostico.push({ nivel: "alerta", mensaje: `La interfaz LAN (${lanIf.name}) está caída.` });
    }
    for (const v of todasInterfaces) {
      if (v.tipo === "vlan" && !v.deshabilitada && !v.activa) {
        diagnostico.push({ nivel: "advertencia", mensaje: `La VLAN "${v.nombre}" está caída.` });
      }
    }
    for (const l of logs.slice(0, 5)) {
      const esCritico = String(l.temas || "").includes("critical");
      diagnostico.push({
        nivel: esCritico ? "alerta" : "advertencia",
        mensaje: `Registro del router${l.tiempo ? ` (${l.tiempo})` : ""}: ${l.mensaje || "sin detalle"}.`,
      });
    }

    return {
      ...base,
      conectado: true,
      identidad,
      sistema,
      salud,
      wan: wanIf
        ? {
            interfaz: wanIf.name,
            ip: wanIp,
            activa: (wanMedida as any)?.activa ?? false,
            deshabilitada: (wanMedida as any)?.deshabilitada ?? false,
            rx_bps: (wanMedida as any)?.rx_bps ?? null,
            tx_bps: (wanMedida as any)?.tx_bps ?? null,
          }
        : { error: `No se encontró la interfaz "${r.wan_interface}".` },
      lan: lanIf
        ? {
            interfaz: lanIf.name,
            activa: (lanMedida as any)?.activa ?? false,
            deshabilitada: (lanMedida as any)?.deshabilitada ?? false,
            rx_bps: (lanMedida as any)?.rx_bps ?? null,
            tx_bps: (lanMedida as any)?.tx_bps ?? null,
          }
        : { error: `No se encontró la interfaz "${r.lan_interface}".` },
      dispositivos_conectados: dispositivos,
      interfaces: todasInterfaces,
      diagnostico,
      logs,
    };
  } catch (e) {
    return { ...base, conectado: false, error: String(e?.message || e) };
  } finally {
    api?.cerrar();
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
