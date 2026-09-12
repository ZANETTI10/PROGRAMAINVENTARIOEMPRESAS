// ============================================================
// Edge Function: mikrotik-estado
// ------------------------------------------------------------
// Consulta en vivo, para una empresa, el estado de su(s) router(s)
// MikroTik: si están en línea, si la interfaz WAN y la LAN están
// activas, la velocidad de subida/bajada, y cuántos dispositivos
// están conectados (arrendamientos DHCP activos).
//
// Se conecta directamente al router por su API nativa (el mismo
// protocolo que usa WinBox), desde el servidor — nunca desde el
// navegador. Cualquier usuario logueado (técnico o admin) puede
// pedir este estado; solo el admin puede cambiar la configuración
// del router (eso lo hace la función "mikrotik-config").
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

    const interfaces = await api.comando(["/interface/print"]);
    const buscar = (nombre: string) => interfaces.find((i) => i.name === nombre);

    const wanIf = buscar(r.wan_interface);
    const lanIf = buscar(r.lan_interface);

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

    const [wanTrafico, lanTrafico] = await Promise.all([
      medirTrafico(wanIf?.name),
      medirTrafico(lanIf?.name),
    ]);

    let dispositivos = -1;
    try {
      const leases = await api.comando(["/ip/dhcp-server/lease/print"]);
      dispositivos = leases.filter((l) => l.status === "bound").length;
    } catch (_e) {
      dispositivos = -1;
    }

    return {
      ...base,
      conectado: true,
      wan: wanIf
        ? {
            interfaz: wanIf.name,
            activa: wanIf.running === "true",
            deshabilitada: wanIf.disabled === "true",
            rx_bps: wanTrafico?.rx_bps ?? null,
            tx_bps: wanTrafico?.tx_bps ?? null,
          }
        : { error: `No se encontró la interfaz "${r.wan_interface}".` },
      lan: lanIf
        ? {
            interfaz: lanIf.name,
            activa: lanIf.running === "true",
            deshabilitada: lanIf.disabled === "true",
            rx_bps: lanTrafico?.rx_bps ?? null,
            tx_bps: lanTrafico?.tx_bps ?? null,
          }
        : { error: `No se encontró la interfaz "${r.lan_interface}".` },
      dispositivos_conectados: dispositivos,
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
