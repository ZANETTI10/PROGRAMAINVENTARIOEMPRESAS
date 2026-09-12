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
