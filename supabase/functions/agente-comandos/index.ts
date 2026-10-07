// ============================================================
// Edge Function: agente-comandos
// ------------------------------------------------------------
// Cola de acciones remotas para equipos con el agente instalado
// (liberar memoria, limpiar temporales, reiniciar explorer, reiniciar
// el equipo). El agente (comandos.ps1) la sondea cada rato con
// modo "consultar", y cuando termina de ejecutar una acción avisa
// con modo "completar".
//
// Igual que agente-inventario: no hay sesión de usuario acá (el
// equipo del cliente no inicia sesión en la app), así que esta
// función debe quedar con "Verify JWT" DESACTIVADO en el panel de
// Supabase. La seguridad depende de que el "token" de instalación sea
// válido y esté activo (se valida abajo contra equipos_tokens), igual
// que en agente-inventario.
//
// La app (con sesión de usuario, sb.from("equipos_comandos").insert)
// es quien crea las filas "pendiente" directamente — esta función
// es solo lo que usa el agente para consultarlas y marcarlas.
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
    const modo = String(body.modo || "consultar");

    if (modo === "completar") {
      const comandoId = String(body.comando_id || "").trim();
      if (!comandoId) return json({ error: "Falta comando_id." }, 400);

      // Verificar que el comando sea de un equipo de ESTA empresa (el
      // token no da acceso a tocar comandos de otra empresa).
      const { data: comando, error: errComando } = await admin
        .from("equipos_comandos")
        .select("id, equipo_id, equipos!inner(empresa_id)")
        .eq("id", comandoId)
        .maybeSingle();
      if (errComando) return json({ error: errComando.message }, 400);
      // deno-lint-ignore no-explicit-any
      if (!comando || (comando as any).equipos?.empresa_id !== empresaId) {
        return json({ error: "Comando no encontrado para este equipo." }, 404);
      }

      const exito = body.exito !== false;
      const { error: errUpdate } = await admin
        .from("equipos_comandos")
        .update({
          estado: exito ? "ejecutado" : "error",
          resultado: body.resultado ? String(body.resultado).slice(0, 2000) : null,
          ejecutado_en: new Date().toISOString(),
        })
        .eq("id", comandoId);
      if (errUpdate) return json({ error: errUpdate.message }, 400);
      return json({ ok: true });
    }

    // modo "consultar" (por defecto): resolver a qué equipo pertenece
    // este reporte (igual que agente-inventario: primero por serial,
    // si no por nombre de red) y devolver el comando pendiente más
    // viejo, si hay alguno. Uno a la vez: el agente avisa con
    // "completar" antes de que el siguiente sondeo le mande otro.
    const serial = body.serial ? String(body.serial).trim() : "";
    const nombreRed = body.nombre_red ? String(body.nombre_red).trim() : "";
    if (!serial && !nombreRed) {
      return json({ error: "Faltan datos del equipo (serial o nombre de red)." }, 400);
    }

    let equipo: { id: string } | null = null;
    if (serial) {
      const { data } = await admin
        .from("equipos")
        .select("id")
        .eq("empresa_id", empresaId)
        .eq("serial", serial)
        .maybeSingle();
      equipo = data;
    }
    if (!equipo && nombreRed) {
      const { data } = await admin
        .from("equipos")
        .select("id")
        .eq("empresa_id", empresaId)
        .eq("nombre_red", nombreRed)
        .maybeSingle();
      equipo = data;
    }

    if (!equipo) return json({ ok: true, comando: null });

    const { data: pendiente, error: errPendiente } = await admin
      .from("equipos_comandos")
      .select("id, accion")
      .eq("equipo_id", equipo.id)
      .eq("estado", "pendiente")
      .order("creado_en", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (errPendiente) return json({ error: errPendiente.message }, 400);

    return json({ ok: true, comando: pendiente || null });
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
