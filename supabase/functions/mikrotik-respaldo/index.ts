// ============================================================
// Edge Function: mikrotik-respaldo
// ------------------------------------------------------------
// Recibe el respaldo mensual de configuración que manda, por su
// cuenta, un router MikroTik con el script de Helpdesk TI instalado
// (ver agente/mikrotik-respaldo.rsc). El router nunca inicia sesión
// en la app -- igual que agente-inventario/agente-comandos con los
// equipos, aquí la seguridad depende de que el "token" de instalación
// sea válido y esté activo (tabla mikrotik_tokens), no de un JWT de
// usuario. Por eso esta función debe quedar con "Verify JWT"
// DESACTIVADO en el panel de Supabase.
//
// A diferencia de los demás "agente-*", RouterOS no puede armar un
// cuerpo JSON con el contenido exportado adentro sin líos de
// escapado/tamaño, así que aquí los metadatos (token, serial,
// identidad, modelo, versión) van en encabezados HTTP y el CUERPO
// crudo de la petición es directamente el texto del respaldo
// (resultado de /export en el router).
//
// Primera vez que un router manda su respaldo (no hay fila en
// mikrotik_routers con ese serial para esta empresa): se crea sola,
// con origen "script" y sin host/usuario/contraseña -- eso lo llena
// el admin después, a mano, SOLO si además quiere monitoreo en vivo
// (mikrotik-estado). El respaldo mensual funciona sin eso.
//
// Si el router YA estaba configurado a mano (origen "manual", con
// host/usuario/contraseña para monitoreo en vivo) y además manda este
// respaldo con el mismo serial, se actualiza la fila existente sin
// tocar su configuración de monitoreo.
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-token, x-serial, x-identidad, x-modelo, x-version",
};

// Límite generoso para el texto del respaldo (RouterOS 6 en la
// práctica manda bastante menos por el límite de las variables de
// texto; RouterOS 7 puede mandar más).
const MAX_RESPALDO = 200_000;

function corto(v: string | null, max: number): string | null {
  if (!v) return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const token = (req.headers.get("x-token") || "").trim();
    if (!token) return json({ error: "Falta el token de instalación (encabezado X-Token)." }, 400);

    const serial = corto(req.headers.get("x-serial"), 100);
    if (!serial) return json({ error: "Falta el serial del router (encabezado X-Serial)." }, 400);

    const identidad = corto(req.headers.get("x-identidad"), 150);
    const modelo = corto(req.headers.get("x-modelo"), 100);
    const version = corto(req.headers.get("x-version"), 60);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: tokenRow, error: tokenError } = await admin
      .from("mikrotik_tokens")
      .select("empresa_id, activo")
      .eq("token", token)
      .maybeSingle();

    if (tokenError) return json({ error: tokenError.message }, 400);
    if (!tokenRow || !tokenRow.activo) {
      return json({ error: "Token inválido o desactivado." }, 401);
    }
    const empresaId = tokenRow.empresa_id as string;

    let config = await req.text();
    if (config && config.length > MAX_RESPALDO) config = config.slice(0, MAX_RESPALDO);

    const ahora = new Date().toISOString();

    const { data: existente } = await admin
      .from("mikrotik_routers")
      .select("id")
      .eq("empresa_id", empresaId)
      .eq("serial", serial)
      .maybeSingle();

    if (existente) {
      const { error } = await admin
        .from("mikrotik_routers")
        .update({
          identidad, modelo, routeros_version: version,
          respaldo_en: ahora, respaldo_config: config || null,
          actualizado_en: ahora,
        })
        .eq("id", existente.id);
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, accion: "actualizado" });
    }

    const { error: insertError } = await admin.from("mikrotik_routers").insert({
      empresa_id: empresaId,
      nombre: identidad || `MikroTik ${serial}`,
      host: "",
      puerto: 8728,
      usuario: "",
      password: "",
      ssl: false,
      wan_interface: "ether1",
      lan_interface: "bridge",
      via_agente: false,
      serial,
      identidad,
      modelo,
      routeros_version: version,
      origen: "script",
      respaldo_en: ahora,
      respaldo_config: config || null,
      actualizado_en: ahora,
    });
    if (insertError) return json({ error: insertError.message }, 400);
    return json({ ok: true, accion: "creado" });
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
