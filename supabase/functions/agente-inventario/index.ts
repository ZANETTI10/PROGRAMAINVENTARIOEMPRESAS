// ============================================================
// Edge Function: agente-inventario
// ------------------------------------------------------------
// Recibe los datos de un equipo (Windows o Mac) reportados por el
// agente instalado en el equipo del cliente, junto con el "token" de
// instalación de esa empresa, y lo anota (o actualiza, si ya existía)
// en el inventario — sin que nadie tenga que digitarlo a mano.
//
// IMPORTANTE al crear esta función en el panel de Supabase: hay que
// DESACTIVAR "Verify JWT" / "Enforce JWT Verification" para esta
// función. El equipo del cliente no tiene sesión de usuario (no puede
// iniciar sesión en la app), así que si Supabase exige un JWT válido
// antes de dejar pasar la petición, esta función nunca recibiría nada
// y siempre respondería 401 sin llegar a correr el código de abajo.
// La seguridad real no depende de eso: depende de que el "token" que
// manda el equipo sea válido y esté activo (se valida abajo).
//
// A diferencia de mikrotik-estado/mikrotik-config (que exigen sesión
// de un usuario de la app), esta función valida en cambio el "token"
// de instalación contra la tabla equipos_tokens usando la llave
// "service_role", y con eso resuelve a qué empresa pertenece. Un
// token inválido o desactivado no anota nada.
//
// El mismo equipo, en reportes siguientes (el agente se sigue
// ejecutando solo, periódicamente), actualiza SU MISMA fila en vez de
// crear una nueva: se busca primero por (empresa, serial) y si no hay
// serial (poco común, pero pasa en algunas VMs/equipos viejos) por
// (empresa, nombre de red).
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Campos del inventario que el agente puede llenar. Cualquier otra
// cosa que venga en el cuerpo se ignora (nunca se confía en lo que
// manda el equipo cliente para cosas como el id o la empresa — eso
// solo lo decide el token).
const CAMPOS_PERMITIDOS = [
  "tipo_equipo",
  "nombre_red",
  "sitio",
  "procesador",
  "memoria_ram",
  "tipo_memoria",
  "disco_duro",
  "tipo_disco",
  "licencia_so",
  "tipo_licencia",
  "serial",
  "comentarios",
] as const;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const token = String(body.token || "").trim();
    if (!token) return json({ error: "Falta el token de instalación." }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: tokenRow, error: tokenError } = await admin
      .from("equipos_tokens")
      .select("empresa_id, activo")
      .eq("token", token)
      .maybeSingle();

    if (tokenError) return json({ error: tokenError.message }, 400);
    if (!tokenRow || !tokenRow.activo) {
      return json({ error: "Token inválido o desactivado." }, 401);
    }

    const empresaId = tokenRow.empresa_id as string;

    const equipo: Record<string, string> = {};
    for (const campo of CAMPOS_PERMITIDOS) {
      const valor = (body as Record<string, unknown>)[campo];
      if (valor !== undefined && valor !== null && String(valor).trim() !== "") {
        equipo[campo] = String(valor).trim();
      }
    }

    const nombreRed = equipo.nombre_red;
    const serial = equipo.serial;

    if (!serial && !nombreRed) {
      return json({ error: "Faltan datos del equipo (serial o nombre de red)." }, 400);
    }

    // ---- Buscar si este equipo ya existía, para actualizar en vez de
    // duplicar ----
    let existente: { id: string } | null = null;
    if (serial) {
      const { data } = await admin
        .from("equipos")
        .select("id")
        .eq("empresa_id", empresaId)
        .eq("serial", serial)
        .maybeSingle();
      existente = data;
    }
    if (!existente && nombreRed) {
      const { data } = await admin
        .from("equipos")
        .select("id")
        .eq("empresa_id", empresaId)
        .eq("nombre_red", nombreRed)
        .maybeSingle();
      existente = data;
    }

    const ahora = new Date().toISOString();

    if (existente) {
      const { error } = await admin
        .from("equipos")
        .update({ ...equipo, origen: "agente", actualizado_en: ahora })
        .eq("id", existente.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, accion: "actualizado", id: existente.id });
    }

    const { data: nuevo, error: insertError } = await admin
      .from("equipos")
      .insert({
        ...equipo,
        empresa_id: empresaId,
        origen: "agente",
        registrado_por: "Agente automático",
        actualizado_en: ahora,
      })
      .select("id")
      .single();

    if (insertError) return json({ error: insertError.message }, 400);
    return json({ ok: true, accion: "creado", id: nuevo.id });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
