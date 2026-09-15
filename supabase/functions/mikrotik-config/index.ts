// ============================================================
// Edge Function: mikrotik-config
// ------------------------------------------------------------
// Permite que el ADMINISTRADOR guarde, edite, liste y elimine los
// datos de conexión de los routers MikroTik de cada empresa (para el
// monitoreo de WAN/LAN en tiempo real).
//
// Por seguridad, esta función corre en el servidor de Supabase, no en
// el navegador: usa la llave "service_role" (secreta) para leer/escribir
// la tabla mikrotik_routers, que no tiene ninguna política de acceso
// directo (ni siquiera el admin puede leerla con su sesión normal).
// La contraseña del router nunca se devuelve al navegador — solo se
// puede reemplazar, no consultar de vuelta.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ------------------------------------------------------------
// Cliente mínimo del API binario de MikroTik (RouterOS) — el mismo
// protocolo que usa "mikrotik-estado", copiado aquí porque cada Edge
// Function de este proyecto es un archivo independiente (se pegan por
// separado en el panel de Supabase, no comparten módulos). Solo se usa
// para la acción "reiniciar": conectar, iniciar sesión y mandar un
// comando sin esperar una respuesta larga (el router corta la conexión
// en cuanto empieza a reiniciar, eso es lo esperado, no un error).
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

  private async asegurarBytes(n: number, timeoutMs = 8000) {
    while (this.buffer.length < n) {
      const chunk = new Uint8Array(4096);
      const leidos = await Promise.race([
        this.conn.read(chunk),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("El router dejó de responder.")), timeoutMs)
        ),
      ]);
      if (leidos === null) throw new Error("El router cerró la conexión.");
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const callerToken = authHeader.replace("Bearer ", "");

    if (!callerToken) {
      return json({ error: "No autenticado." }, 401);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: callerData, error: callerError } = await admin.auth.getUser(callerToken);
    if (callerError || !callerData?.user) {
      return json({ error: "Sesión inválida." }, 401);
    }

    const { data: perfil, error: perfilError } = await admin
      .from("usuarios_perfil")
      .select("rol")
      .eq("id", callerData.user.id)
      .maybeSingle();

    if (perfilError || perfil?.rol !== "admin") {
      return json({ error: "Solo un administrador puede configurar routers." }, 403);
    }

    const body = await req.json();
    const accion = body.accion;

    // ---------------- Listar ----------------
    if (accion === "listar") {
      if (!body.empresa_id) {
        return json({ error: "Falta la empresa." }, 400);
      }
      const { data, error } = await admin
        .from("mikrotik_routers")
        .select("id, empresa_id, nombre, host, puerto, ssl, wan_interface, lan_interface, usuario")
        .eq("empresa_id", body.empresa_id)
        .order("nombre");

      if (error) return json({ error: error.message }, 400);
      return json({ routers: data || [] });
    }

    // ---------------- Guardar (crear o editar) ----------------
    if (accion === "guardar") {
      const empresaId = body.empresa_id;
      const host = (body.host || "").trim();
      const usuario = (body.usuario || "").trim();
      const password = (body.password || "").trim();

      if (!empresaId || !host || !usuario) {
        return json({ error: "Faltan datos del router (empresa, host o usuario)." }, 400);
      }
      if (!body.id && !password) {
        return json({ error: "Escribe la contraseña del router." }, 400);
      }

      const fila: Record<string, unknown> = {
        empresa_id: empresaId,
        nombre: (body.nombre || "Router principal").trim(),
        host,
        puerto: parseInt(body.puerto, 10) || 8728,
        usuario,
        ssl: !!body.ssl,
        wan_interface: (body.wan_interface || "ether1").trim(),
        lan_interface: (body.lan_interface || "bridge").trim(),
      };
      if (password) fila.password = password;

      if (body.id) {
        const { error } = await admin.from("mikrotik_routers").update(fila).eq("id", body.id);
        if (error) return json({ error: error.message }, 400);
      } else {
        fila.password = password;
        const { error } = await admin.from("mikrotik_routers").insert(fila);
        if (error) return json({ error: error.message }, 400);
      }

      return json({ ok: true });
    }

    // ---------------- Eliminar ----------------
    if (accion === "eliminar") {
      if (!body.id) return json({ error: "Falta el router a eliminar." }, 400);
      const { error } = await admin.from("mikrotik_routers").delete().eq("id", body.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // ---------------- Reiniciar ----------------
    // Se conecta al router de verdad (igual que "mikrotik-estado") y le
    // manda "/system/reboot". Es normal que, apenas se manda el comando,
    // el router corte la conexión sin llegar a mandar "!done" — por eso
    // esa parte se trata como éxito, no como error.
    if (accion === "reiniciar") {
      if (!body.id) return json({ error: "Falta el router a reiniciar." }, 400);

      const { data: router, error: routerError } = await admin
        .from("mikrotik_routers")
        .select("*")
        .eq("id", body.id)
        .maybeSingle();

      if (routerError) return json({ error: routerError.message }, 400);
      if (!router) return json({ error: "No se encontró ese router." }, 404);

      let api: MikrotikApi | null = null;
      try {
        api = await MikrotikApi.conectar(router.host, router.puerto, router.ssl);
        await api.login(router.usuario, router.password);
        try {
          await api.comando(["/system/reboot"], 5000);
        } catch (_e) {
          // Esperado: el router se desconecta antes de responder "!done".
        }
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e?.message || e) }, 500);
      } finally {
        api?.cerrar();
      }
    }

    return json({ error: "Acción no reconocida." }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
