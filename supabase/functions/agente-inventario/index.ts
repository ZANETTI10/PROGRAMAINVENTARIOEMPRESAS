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
// Además del inventario, el agente manda tres bloques más:
//   - "seguridad": antivirus instalados, estado de Defender, firewall
//     y última actualización de Windows;
//   - "amenazas": lo que Defender detectó en los últimos 60 días;
//   - "rendimiento": uso de CPU/RAM, ranuras de memoria, discos,
//     programas de inicio, procesos más pesados.
// El equipo solo manda los DATOS; el semáforo (protegido / advertencia
// / riesgo), los motivos y las recomendaciones se calculan aquí, para
// poder ajustar los criterios sin tener que reinstalar nada en los
// equipos de los clientes.
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
  "responsable",
  "procesador",
  "memoria_ram",
  "tipo_memoria",
  "disco_duro",
  "tipo_disco",
  "licencia_so",
  "tipo_licencia",
  "serial",
  "comentarios",
  "disco_libre_pct",
  // Datos "en vivo" del equipo en el momento del reporte (no son specs
  // fijas como las de arriba, cambian de un reporte a otro).
  "ip_local",
  "usuario_sesion",
  "ultimo_reinicio",
  "windows_activado",
  "antivirus_estado",
] as const;


// ------------------------------------------------------------
// Seguridad: limpiar lo que manda el agente y calcular el semáforo
// ------------------------------------------------------------

type Json = Record<string, unknown>;

function txt(v: unknown, max = 200): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function num(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  return null;
}
function fecha(v: unknown): string | null {
  const s = txt(v, 40);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function lista(v: unknown, max: number): Json[] {
  // PowerShell a veces manda un solo elemento suelto en vez de una lista.
  const arr = Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : []);
  return arr.flat().filter((x) => x && typeof x === "object").slice(0, max) as Json[];
}
function diasDesde(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

const SEVERIDADES: Record<number, string> = { 1: "Baja", 2: "Moderada", 4: "Alta", 5: "Grave" };
const ESTADOS_AMENAZA: Record<number, string> = {
  1: "Detectada", 2: "Limpiada", 3: "En cuarentena", 4: "Eliminada", 5: "Permitida", 6: "Bloqueada",
  102: "No se pudo limpiar", 103: "No se pudo poner en cuarentena", 104: "No se pudo eliminar",
  105: "No se pudo permitir", 106: "Abandonada", 107: "No se pudo bloquear",
};
const ESTADOS_SIN_RESOLVER = new Set([1, 102, 103, 104, 107]);

function limpiarAmenazas(v: unknown) {
  return lista(v, 40).map((a) => {
    const estadoId = num(a.estado_id);
    const sevId = num(a.severidad_id);
    return {
      deteccion_id: txt(a.deteccion_id, 120),
      nombre: txt(a.nombre, 200),
      severidad: sevId !== null ? (SEVERIDADES[sevId] || null) : null,
      estado: estadoId !== null ? (ESTADOS_AMENAZA[estadoId] || `Estado ${estadoId}`) : null,
      resuelta: estadoId !== null ? !ESTADOS_SIN_RESOLVER.has(estadoId) : false,
      recurso: txt(a.recurso, 300),
      detectado_en: fecha(a.detectado_en),
    };
  }).filter((a) => a.deteccion_id);
}

function evaluarSeguridad(v: unknown, amenazas: ReturnType<typeof limpiarAmenazas>) {
  const s = (v && typeof v === "object" ? v : {}) as Json;
  const d = (s.defender && typeof s.defender === "object" ? s.defender : null) as Json | null;
  const f = (s.firewall && typeof s.firewall === "object" ? s.firewall : {}) as Json;

  const antivirus = lista(s.antivirus, 6).map((p) => ({
    nombre: txt(p.nombre, 80), activo: p.activo === true, al_dia: p.al_dia === true,
  })).filter((p) => p.nombre);

  const defender = d ? {
    modo: txt(d.modo, 40),
    servicio_activo: bool(d.servicio_activo),
    antivirus_activo: bool(d.antivirus_activo),
    tiempo_real: bool(d.tiempo_real),
    proteccion_manipulacion: bool(d.proteccion_manipulacion),
    firmas_version: txt(d.firmas_version, 40),
    firmas_fecha: fecha(d.firmas_fecha),
    firmas_dias: num(d.firmas_dias),
    analisis_rapido_fecha: fecha(d.analisis_rapido_fecha),
    analisis_completo_fecha: fecha(d.analisis_completo_fecha),
    version_motor: txt(d.version_motor, 40),
  } : null;

  const firewall = {
    dominio: bool(f.dominio), privado: bool(f.privado), publico: bool(f.publico), terceros: txt(f.terceros, 120),
  };
  const ultimaActualizacion = fecha(s.ultima_actualizacion);

  // ---- ¿Quién protege este equipo? ----
  const tercero = antivirus.find((p) => p.activo && !/defender/i.test(p.nombre || ""));
  const defenderProtege = !!defender && defender.antivirus_activo === true && defender.tiempo_real === true;
  let protector: string | null = null;
  if (tercero) protector = tercero.nombre;
  else if (defenderProtege) protector = "Microsoft Defender";

  const riesgos: string[] = [];
  const avisos: string[] = [];

  if (!protector) {
    if (defender && defender.antivirus_activo === true && defender.tiempo_real === false) {
      riesgos.push("La protección en tiempo real del antivirus está apagada.");
    } else {
      riesgos.push("No hay ningún antivirus activo en este equipo.");
    }
  } else if (tercero) {
    if (!tercero.al_dia) avisos.push(`${tercero.nombre} reporta que no está al día.`);
  } else if (defender) {
    const dias = defender.firmas_dias;
    if (dias !== null && dias >= 7) riesgos.push(`Las firmas del antivirus tienen ${dias} días sin actualizarse.`);
    else if (dias !== null && dias >= 3) avisos.push(`Las firmas del antivirus tienen ${dias} días sin actualizarse.`);

    const ultimoAnalisis = [defender.analisis_rapido_fecha, defender.analisis_completo_fecha]
      .filter(Boolean).sort().pop() || null;
    const diasAnalisis = diasDesde(ultimoAnalisis);
    if (diasAnalisis === null) avisos.push("Este equipo no registra ningún análisis de antivirus.");
    else if (diasAnalisis > 14) avisos.push(`El último análisis de antivirus fue hace ${diasAnalisis} días.`);
  }

  const hace14 = Date.now() - 14 * 86400000;
  const sinResolver = amenazas.filter((a) => !a.resuelta && a.detectado_en && new Date(a.detectado_en).getTime() >= hace14);
  if (sinResolver.length) {
    riesgos.push(sinResolver.length === 1
      ? `Hay una amenaza detectada sin resolver: ${sinResolver[0].nombre || "sin nombre"}.`
      : `Hay ${sinResolver.length} amenazas detectadas sin resolver.`);
  }

  if (!firewall.terceros) {
    const apagados = [["dominio", firewall.dominio], ["privado", firewall.privado], ["público", firewall.publico]]
      .filter(([, v]) => v === false).map(([n]) => n as string);
    if (apagados.length === 3) avisos.push("El firewall de Windows está apagado.");
    else if (apagados.length) avisos.push(`El firewall de Windows está apagado en el perfil ${apagados.join(" y ")}.`);
  }

  const diasAct = diasDesde(ultimaActualizacion);
  if (diasAct !== null && diasAct > 90) avisos.push(`Windows no instala actualizaciones hace ${diasAct} días.`);

  const nivel = riesgos.length ? "riesgo" : (avisos.length ? "advertencia" : "protegido");
  const amenazas30 = amenazas.filter((a) => a.detectado_en && new Date(a.detectado_en).getTime() >= Date.now() - 30 * 86400000).length;

  return {
    nivel,
    datos: {
      protector, antivirus, defender, firewall,
      ultima_actualizacion: ultimaActualizacion,
      motivos: [...riesgos, ...avisos],
      amenazas_30d: amenazas30,
      amenazas_sin_resolver: sinResolver.length,
    },
  };
}

// ------------------------------------------------------------
// Rendimiento: limpiar los datos y armar las recomendaciones que se
// le muestran al cliente en la ficha del equipo.
// ------------------------------------------------------------

function evaluarRendimiento(v: unknown) {
  const r = (v && typeof v === "object" ? v : {}) as Json;

  const modulos = lista(r.ram_modulos, 16).map((m) => ({
    gb: num(m.gb), mhz: num(m.mhz), ranura: txt(m.ranura, 40), fabricante: txt(m.fabricante, 40),
  }));
  const discos = lista(r.discos, 12).map((d) => ({
    modelo: txt(d.modelo, 80), tipo: txt(d.tipo, 20), bus: txt(d.bus, 20), gb: num(d.gb), salud: txt(d.salud, 20),
  }));
  const unidades = lista(r.unidades, 12).map((u) => ({
    letra: txt(u.letra, 4), gb: num(u.gb), libre_gb: num(u.libre_gb), libre_pct: num(u.libre_pct),
  }));
  const procesos = lista(r.procesos_top, 5).map((p) => ({ nombre: txt(p.nombre, 60), mb: num(p.mb) }));

  const datos = {
    fabricante: txt(r.fabricante, 60), modelo: txt(r.modelo, 80),
    cpu_nucleos: num(r.cpu_nucleos), cpu_hilos: num(r.cpu_hilos), cpu_mhz: num(r.cpu_mhz), cpu_uso_pct: num(r.cpu_uso_pct),
    ram_total_gb: num(r.ram_total_gb), ram_uso_pct: num(r.ram_uso_pct), ram_ranuras: num(r.ram_ranuras), ram_modulos: modulos,
    discos, unidades,
    dias_encendido: num(r.dias_encendido), programas_inicio: num(r.programas_inicio),
    procesos_top: procesos, reinicio_pendiente: bool(r.reinicio_pendiente), bateria_salud_pct: num(r.bateria_salud_pct),
  };

  // Cada recomendación: qué pasa, qué se recomienda y qué tan urgente es.
  const rec: { nivel: "alta" | "media"; titulo: string; detalle: string }[] = [];

  const discoMalo = discos.find((d) => d.salud && !/^healthy$/i.test(d.salud));
  if (discoMalo) rec.push({ nivel: "alta", titulo: "Disco con fallas", detalle: `El disco ${discoMalo.modelo || ""} reporta problemas de salud. Hay que respaldar la información y cambiarlo cuanto antes.`.replace("  ", " ") });

  const discoSistema = unidades.find((u) => (u.letra || "").toUpperCase() === "C:") || unidades[0];
  if (discoSistema && discoSistema.libre_pct !== null) {
    if (discoSistema.libre_pct < 10) rec.push({ nivel: "alta", titulo: "Disco casi lleno", detalle: `Al disco ${discoSistema.letra} le queda ${discoSistema.libre_pct}% libre. Con tan poco espacio Windows se pone lento y deja de actualizarse.` });
    else if (discoSistema.libre_pct < 20) rec.push({ nivel: "media", titulo: "Poco espacio en disco", detalle: `Al disco ${discoSistema.letra} le queda ${discoSistema.libre_pct}% libre. Conviene liberar espacio.` });
  }

  const soloMecanico = discos.length > 0 && discos.every((d) => /hdd/i.test(d.tipo || "")) ;
  if (soloMecanico) rec.push({ nivel: "alta", titulo: "Disco mecánico (HDD)", detalle: "Este equipo arranca y abre programas desde un disco mecánico. Cambiarlo por un disco sólido (SSD) es la mejora que más se nota en velocidad." });

  if (datos.ram_total_gb !== null) {
    const libres = datos.ram_ranuras !== null ? datos.ram_ranuras - modulos.length : null;
    const sufijo = libres !== null && libres > 0 ? ` Tiene ${libres} ranura${libres === 1 ? "" : "s"} libre${libres === 1 ? "" : "s"} para ampliarla.` : "";
    if (datos.ram_total_gb < 7) rec.push({ nivel: "alta", titulo: "Poca memoria RAM", detalle: `Tiene ${Math.round(datos.ram_total_gb)} GB de RAM, que hoy se queda corta para Windows y un navegador con varias pestañas.${sufijo}` });
    else if (datos.ram_uso_pct !== null && datos.ram_uso_pct >= 85) rec.push({ nivel: "media", titulo: "Memoria RAM al límite", detalle: `En el último reporte la memoria estaba al ${datos.ram_uso_pct}%. Si pasa seguido, conviene ampliarla.${sufijo}` });
  }

  if (datos.cpu_uso_pct !== null && datos.cpu_uso_pct >= 85) rec.push({ nivel: "media", titulo: "Procesador muy ocupado", detalle: `En el último reporte el procesador estaba al ${datos.cpu_uso_pct}%. Hay que revisar qué programa lo está ocupando.` });

  if (datos.dias_encendido !== null && datos.dias_encendido >= 14) rec.push({ nivel: "media", titulo: "Muchos días sin reiniciar", detalle: `Lleva ${datos.dias_encendido} días encendido sin reiniciar. Reiniciar libera memoria y termina de instalar actualizaciones.` });
  else if (datos.reinicio_pendiente === true) rec.push({ nivel: "media", titulo: "Reinicio pendiente", detalle: "Windows tiene actualizaciones a medio instalar y necesita un reinicio para terminarlas." });

  if (datos.programas_inicio !== null && datos.programas_inicio > 12) rec.push({ nivel: "media", titulo: "Muchos programas al inicio", detalle: `${datos.programas_inicio} programas arrancan junto con Windows. Quitar los que no hacen falta acelera el encendido.` });

  if (datos.bateria_salud_pct !== null && datos.bateria_salud_pct < 60) rec.push({ nivel: "media", titulo: "Batería desgastada", detalle: `La batería ya solo carga el ${datos.bateria_salud_pct}% de lo que cargaba nueva.` });

  return { ...datos, recomendaciones: rec };
}

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

    // Los agentes viejos (sin módulo de seguridad) no mandan estos
    // bloques: en ese caso no se toca lo que ya hubiera guardado.
    // deno-lint-ignore no-explicit-any
    const extras: Record<string, any> = {};
    const agenteVersion = txt((body as Json).agente_version, 20);
    if (agenteVersion) extras.agente_version = agenteVersion;

    const traeSeguridad = (body as Json).seguridad && typeof (body as Json).seguridad === "object";
    const amenazas = traeSeguridad ? limpiarAmenazas((body as Json).amenazas) : [];
    if (traeSeguridad) {
      const ev = evaluarSeguridad((body as Json).seguridad, amenazas);
      extras.seguridad = ev.datos;
      extras.seguridad_nivel = ev.nivel;
      extras.seguridad_actualizado_en = new Date().toISOString();
    }
    if ((body as Json).rendimiento && typeof (body as Json).rendimiento === "object") {
      extras.rendimiento = evaluarRendimiento((body as Json).rendimiento);
    }

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

    // Ademas de actualizar la fila del equipo, se guarda un renglon de
    // historial con el disco libre de este reporte -- asi el panel de
    // detalle puede mostrar una tendencia en vez de solo el ultimo dato.
    async function guardarHistorial(equipoId: string) {
      if (traeSeguridad && amenazas.length) {
        // Una fila por detección: si ya existía (mismo equipo y misma
        // detección) solo se actualiza su estado.
        await admin.from("equipos_amenazas").upsert(
          amenazas.map((a) => ({ ...a, equipo_id: equipoId, actualizado_en: ahora })),
          { onConflict: "equipo_id,deteccion_id" },
        );
      }
      if (!equipo.disco_libre_pct) return;
      await admin.from("equipos_historial").insert({
        equipo_id: equipoId,
        disco_libre_pct: equipo.disco_libre_pct,
        creado_en: ahora,
      });
    }

    if (existente) {
      const { error } = await admin
        .from("equipos")
        .update({ ...equipo, ...extras, origen: "agente", actualizado_en: ahora })
        .eq("id", existente.id);
      if (error) return json({ error: error.message }, 400);
      await guardarHistorial(existente.id);
      return json({ ok: true, accion: "actualizado", id: existente.id });
    }

    const { data: nuevo, error: insertError } = await admin
      .from("equipos")
      .insert({
        ...equipo,
        ...extras,
        empresa_id: empresaId,
        origen: "agente",
        registrado_por: "Agente automático",
        actualizado_en: ahora,
      })
      .select("id")
      .single();

    if (insertError) return json({ error: insertError.message }, 400);
    await guardarHistorial(nuevo.id);
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
