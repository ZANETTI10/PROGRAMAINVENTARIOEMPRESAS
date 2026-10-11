// ============================================================
// Edge Function: agente-comandos
// ------------------------------------------------------------
// Cola de acciones remotas para equipos con el agente instalado
// (liberar memoria, limpiar temporales, reiniciar explorer, reiniciar
// el equipo). El agente (comandos.ps1) la sondea cada rato con
// modo "consultar", y cuando termina de ejecutar una acción avisa
// con modo "completar".
//
// La misma consulta ("consultar") también devuelve, para la empresa
// del token, las impresoras y los routers MikroTik marcados
// "via_agente" (sitios sin IP pública, donde la nube no puede conectarse
// directo al router) -- cosas que el agente debe revisar por su propia
// red local cada vez que sondea (cada 15 min). El agente hace esas
// revisiones (ping a la impresora, intento de conexión al puerto de la
// API del router) y avisa el resultado con modo "estado_red". Cualquier
// PC de la empresa que tenga el agente instalado puede reportar esto --
// no hace falta designar un PC especial como "puente": todos están en la
// misma red del sitio, así que si uno está apagado otro cubre igual.
//
// Igual que agente-inventario: no hay sesión de usuario acá (el
// equipo del cliente no inicia sesión en la app), así que esta
// función debe quedar con "Verify JWT" DESACTIVADO en el panel de
// Supabase. La seguridad depende de que el "token" de instalación sea
// válido y esté activo (se valida abajo contra equipos_tokens), igual
// que en agente-inventario.
//
// Respuesta automática de seguridad: en "consultar" se le dice al
// agente si la empresa la tiene prendida (empresas.seguridad_auto). Si
// es así, el agente puede por su cuenta volver a prender la protección
// en tiempo real, actualizar firmas viejas o mandar a eliminar una
// amenaza sin resolver, y avisa lo que hizo con modo
// "accion_automatica" -- queda anotado en equipos_comandos como
// "Respuesta automática" para que se vea en la app igual que una
// acción mandada a mano.
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

    if (modo === "accion_automatica") {
      const ACCIONES_AUTO = ["activar_proteccion", "actualizar_firmas", "eliminar_amenazas"];
      const accion = String(body.accion || "");
      if (!ACCIONES_AUTO.includes(accion)) return json({ error: "Acción no permitida." }, 400);

      const equipoAuto = await buscarEquipo(admin, empresaId, body);
      if (!equipoAuto) return json({ ok: true, anotado: false });

      const ahoraAuto = new Date().toISOString();
      const { error: errAuto } = await admin.from("equipos_comandos").insert({
        equipo_id: equipoAuto.id,
        accion,
        estado: body.exito === false ? "error" : "ejecutado",
        creado_por: "Respuesta automática",
        creado_en: ahoraAuto,
        ejecutado_en: ahoraAuto,
        resultado: body.resultado ? String(body.resultado).slice(0, 2000) : null,
      });
      if (errAuto) return json({ error: errAuto.message }, 400);
      return json({ ok: true, anotado: true });
    }

    if (modo === "estado_red") {
      // El agente reporta lo que vio en SU red local: impresoras (ping)
      // y routers sin IP pública (conexión al puerto de la API). Se
      // revalida que cada id pertenezca a esta misma empresa -- el
      // token no da acceso a tocar datos de otra empresa.
      const ahora = new Date().toISOString();
      const impresoras = Array.isArray(body.impresoras) ? body.impresoras : [];
      const mikrotik = Array.isArray(body.mikrotik) ? body.mikrotik : [];

      for (const item of impresoras) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        await admin
          .from("impresoras")
          .update({ en_linea: !!item.en_linea, actualizado_en: ahora })
          .eq("id", id)
          .eq("empresa_id", empresaId);
      }

      for (const item of mikrotik) {
        const id = String(item?.id || "").trim();
        if (!id) continue;
        await admin
          .from("mikrotik_routers")
          .update({ agente_en_linea: !!item.en_linea, agente_actualizado_en: ahora })
          .eq("id", id)
          .eq("empresa_id", empresaId)
          .eq("via_agente", true);
      }

      return json({ ok: true });
    }

    // modo "consultar" (por defecto): además de la acción pendiente
    // (si hay alguna, para el equipo que reporta), siempre devuelve las
    // impresoras y los routers "via_agente" de esta empresa, para que
    // el agente los revise por su red local en esta misma pasada.
    const [{ data: impresoras }, { data: mikrotikAgente }, { data: empresaFila }] = await Promise.all([
      admin.from("impresoras").select("id, ip_local").eq("empresa_id", empresaId),
      admin.from("mikrotik_routers").select("id, host, puerto").eq("empresa_id", empresaId).eq("via_agente", true),
      admin.from("empresas").select("seguridad_auto").eq("id", empresaId).maybeSingle(),
    ]);

    const respuestaBase = {
      ok: true,
      // deno-lint-ignore no-explicit-any
      respuesta_automatica: (empresaFila as any)?.seguridad_auto === true,
      impresoras: impresoras || [],
      mikrotik: mikrotikAgente || [],
    };

    const serial = body.serial ? String(body.serial).trim() : "";
    const nombreRed = body.nombre_red ? String(body.nombre_red).trim() : "";
    if (!serial && !nombreRed) {
      // No hay forma de identificar el equipo (poco común) -- aun así
      // se devuelve lo de impresoras/mikrotik, solo que sin comando.
      return json({ ...respuestaBase, comando: null });
    }

    const equipo = await buscarEquipo(admin, empresaId, body);

    if (!equipo) return json({ ...respuestaBase, comando: null });

    const { data: pendiente, error: errPendiente } = await admin
      .from("equipos_comandos")
      .select("id, accion, script_contenido")
      .eq("equipo_id", equipo.id)
      .eq("estado", "pendiente")
      .order("creado_en", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (errPendiente) return json({ error: errPendiente.message }, 400);

    return json({ ...respuestaBase, comando: pendiente || null });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// Encuentra el equipo que está hablando: primero por serial y, si no
// tiene, por nombre de red -- siempre dentro de la empresa del token.
// deno-lint-ignore no-explicit-any
async function buscarEquipo(admin: any, empresaId: string, body: any): Promise<{ id: string } | null> {
  const serial = body.serial ? String(body.serial).trim() : "";
  const nombreRed = body.nombre_red ? String(body.nombre_red).trim() : "";
  if (serial) {
    const { data } = await admin.from("equipos").select("id").eq("empresa_id", empresaId).eq("serial", serial).maybeSingle();
    if (data) return data;
  }
  if (nombreRed) {
    const { data } = await admin.from("equipos").select("id").eq("empresa_id", empresaId).eq("nombre_red", nombreRed).maybeSingle();
    if (data) return data;
  }
  return null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
