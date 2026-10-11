// ============================================================
// Helpdesk TI — Seguridad, rendimiento y ficha del equipo
// ------------------------------------------------------------
// Todo lo que se arma con lo que reporta el agente instalado en los
// equipos (agente/reportar.ps1), además del inventario:
//
//   1. El semáforo de seguridad de cada equipo (protegido / con
//      advertencia / en riesgo) y la sección "Seguridad" del detalle,
//      con las acciones remotas de antivirus.
//   2. La vista "Seguridad": todas las empresas de un vistazo, los
//      equipos que necesitan atención, las amenazas recientes y lo que
//      la respuesta automática ha hecho sola.
//   3. La "Ficha del equipo": una hoja limpia, pensada para mostrársela
//      o entregársela al cliente (se puede imprimir o guardar en PDF),
//      con el esquema del equipo, lo que afecta su rendimiento y su
//      estado de protección. Y el "Informe de la empresa", que resume
//      todos sus equipos en una sola hoja.
//
// Este archivo se carga después de app.js y usa sus utilidades ($, sb,
// toast, escapeHtml, fmtFecha, empresas, perfil…).
//
// Importante: el semáforo y las recomendaciones NO se calculan aquí.
// Los calcula la Edge Function "agente-inventario" cada vez que un
// equipo reporta, y quedan guardados en equipos.seguridad /
// equipos.rendimiento. Aquí solo se muestran. Lo único que se decide
// aquí es si el dato ya está viejo (el equipo dejó de reportar).
// ============================================================

const VERSION_AGENTE_ACTUAL = "2.0";
const URL_AGENTE = "https://zanetti10.github.io/PROGRAMAINVENTARIOEMPRESAS/agente";

const ACCIONES_SEGURIDAD = {
  analisis_rapido: "Análisis rápido",
  analisis_completo: "Análisis completo",
  actualizar_firmas: "Actualizar firmas",
  activar_proteccion: "Activar protección",
  eliminar_amenazas: "Eliminar amenazas",
};

// Se suman a los textos de confirmación que ya usa app.js para las
// acciones remotas (mismo botón, misma cola de comandos).
Object.assign(CONFIRMACIONES_ACCION_REMOTA, {
  analisis_rapido: "¿Lanzar un análisis rápido de antivirus en este equipo? Arranca la próxima vez que el equipo consulte (hasta 15 min) y tarda unos minutos.",
  analisis_completo: "¿Lanzar un análisis COMPLETO de antivirus en este equipo?\n\nRevisa todo el disco: puede tardar varias horas y el equipo se siente más lento mientras corre. Mejor mandarlo cuando no lo estén usando.",
  actualizar_firmas: "¿Actualizar las firmas del antivirus de este equipo? Se ejecuta la próxima vez que el equipo consulte (hasta 15 min).",
  activar_proteccion: "¿Volver a prender la protección en tiempo real del antivirus en este equipo? Se ejecuta la próxima vez que el equipo consulte (hasta 15 min).",
  eliminar_amenazas: "¿Ordenarle al antivirus que elimine las amenazas detectadas en este equipo?\n\nBorra o pone en cuarentena los archivos señalados y después lanza un análisis rápido para confirmar.",
});

// Script que se manda (como "script personalizado") a los equipos que
// todavía tienen la versión anterior del agente, para que descarguen
// la nueva sin tener que ir hasta el equipo.
const SCRIPT_ACTUALIZAR_AGENTE = [
  'try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}',
  '$d = "$env:ProgramData\\HelpdeskTI"',
  `$b = "${URL_AGENTE}"`,
  'foreach ($f in "reportar.ps1", "comandos.ps1") {',
  '  $tmp = Join-Path $d "$f.nuevo"',
  '  Invoke-WebRequest -Uri "$b/$f" -OutFile $tmp -UseBasicParsing',
  '  if ((Get-Item $tmp).Length -lt 2000) { throw "La descarga de $f quedo incompleta." }',
  '  Move-Item -Path $tmp -Destination (Join-Path $d $f) -Force',
  '}',
  '& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $d "reportar.ps1") | Out-Null',
  '"Agente actualizado y reporte enviado."',
].join("\n");

// ------------------------------------------------------------
// Estado de seguridad de un equipo
// ------------------------------------------------------------

const NIVELES_SEG = {
  protegido: { etiqueta: "Protegido", icono: "✓", pill: "pill-ok", dr: "dr-ok" },
  advertencia: { etiqueta: "Con advertencia", icono: "⚠", pill: "pill-warn", dr: "dr-warn" },
  riesgo: { etiqueta: "En riesgo", icono: "⛔", pill: "pill-bad", dr: "dr-bad" },
  sin_reporte: { etiqueta: "Sin reportar", icono: "?", pill: "pill-warn", dr: "dr-muted" },
  sin_datos: { etiqueta: "Sin datos", icono: "○", pill: "", dr: "dr-muted" },
};

// Un equipo que lleva más de 2 días sin reportar no se puede dar por
// "protegido": lo último que se supo puede ya no ser cierto.
function estadoSeguridadEquipo(r) {
  if (r.origen !== "agente") return { nivel: "sin_datos", motivo: "Sin agente instalado" };
  if (!r.seguridad || !r.seguridad_nivel) return { nivel: "sin_datos", motivo: "El agente de este equipo es de la versión anterior: hay que actualizarlo" };
  const horas = r.actualizado_en ? (Date.now() - new Date(r.actualizado_en).getTime()) / 3600000 : Infinity;
  if (horas > 48) return { nivel: "sin_reporte", motivo: `No reporta ${formatearHaceTiempo(r.actualizado_en)}` };
  return { nivel: r.seguridad_nivel, motivo: (r.seguridad.motivos || [])[0] || "" };
}

function pillSeguridadHtml(r) {
  if (r.origen !== "agente") return "";
  const est = estadoSeguridadEquipo(r);
  const n = NIVELES_SEG[est.nivel];
  return ` <span class="pill ${n.pill}" title="${escapeAttr(est.motivo)}">${n.icono} ${n.etiqueta}</span>`;
}

function siNo(valor, textoSi, textoNo) {
  if (valor === true) return textoSi;
  if (valor === false) return textoNo;
  return "";
}

function textoFirewall(fw) {
  if (!fw) return "";
  if (fw.terceros) return `A cargo de ${fw.terceros}`;
  const perfiles = [["Dominio", fw.dominio], ["Privado", fw.privado], ["Público", fw.publico]].filter(([, v]) => v !== null && v !== undefined);
  if (!perfiles.length) return "";
  const apagados = perfiles.filter(([, v]) => v === false).map(([n]) => n);
  if (!apagados.length) return "Activo";
  if (apagados.length === perfiles.length) return "Apagado";
  return `Apagado en: ${apagados.join(", ")}`;
}

function ultimoAnalisis(def) {
  if (!def) return null;
  return [def.analisis_rapido_fecha, def.analisis_completo_fecha].filter(Boolean).sort().pop() || null;
}

// ------------------------------------------------------------
// Sección "Seguridad" dentro del detalle del equipo
// ------------------------------------------------------------

function seccionSeguridadHtml(r) {
  if (r.origen !== "agente") return "";
  const est = estadoSeguridadEquipo(r);
  const n = NIVELES_SEG[est.nivel];
  const s = r.seguridad;

  const botonFicha = `<button class="btn-secondary" style="width:auto;" data-abrir-ficha type="button">Ver ficha para el cliente</button>`;

  if (!s) {
    return `
      <div class="equipo-detalle-seccion">
        <h4>Seguridad</h4>
        <p class="sub" style="margin:0 0 10px;">Este equipo todavía tiene la versión anterior del agente, que no reporta seguridad ni rendimiento.</p>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          <button class="btn-secondary" style="width:auto;" data-actualizar-agente type="button">Actualizar agente en este equipo</button>
          ${botonFicha}
        </div>
      </div>`;
  }

  const def = s.defender;
  const usaDefender = s.protector === "Microsoft Defender" || (!s.protector && def);
  const motivos = (s.motivos || []).length
    ? `<ul class="seg-motivos">${s.motivos.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul>`
    : "";

  const botones = usaDefender
    ? Object.entries(ACCIONES_SEGURIDAD).map(([accion, etiqueta]) =>
        `<button class="btn-secondary" style="width:auto;" data-queue-comando="${accion}" type="button">${etiqueta}</button>`).join("")
    : `<p class="sub" style="margin:0;">Este equipo lo protege ${escapeHtml(s.protector || "otro antivirus")}: los análisis y las firmas se manejan desde la consola de ese antivirus, no desde aquí.</p>`;

  return `
    <div class="equipo-detalle-seccion">
      <h4>Seguridad</h4>
      <div style="margin-bottom:10px;"><span class="pill ${n.pill}">${n.icono} ${n.etiqueta}</span>${est.nivel === "sin_reporte" ? ` <span class="sub">${escapeHtml(est.motivo)} — lo de abajo es lo último que se supo.</span>` : ""}</div>
      ${motivos}
      <div class="equipo-detalle-grid">
        ${datoHtml("Antivirus que protege", s.protector || "Ninguno activo")}
        ${def ? datoHtml("Protección en tiempo real", siNo(def.tiempo_real, "Prendida", "Apagada")) : ""}
        ${def && usaDefender ? datoHtml("Firmas", def.firmas_fecha ? `${fmtFecha(def.firmas_fecha)}${def.firmas_dias != null ? ` (hace ${def.firmas_dias} día${def.firmas_dias === 1 ? "" : "s"})` : ""}` : "") : ""}
        ${def && usaDefender ? datoHtml("Último análisis", ultimoAnalisis(def) ? fmtFecha(ultimoAnalisis(def)) : "Nunca") : ""}
        ${datoHtml("Firewall", textoFirewall(s.firewall))}
        ${datoHtml("Última actualización de Windows", s.ultima_actualizacion ? fmtFechaCorta(s.ultima_actualizacion.slice(0, 10)) : "")}
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin:12px 0;">${botones}</div>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        ${botonFicha}
        ${r.agente_version !== VERSION_AGENTE_ACTUAL ? `<button class="btn-secondary" style="width:auto;" data-actualizar-agente type="button">Actualizar agente</button>` : ""}
      </div>
      <div id="equipoDetalleAmenazas"><div class="dash-modal-cargando">Cargando amenazas…</div></div>
    </div>`;
}

function filaAmenazaHtml(a, conEquipo) {
  const clase = a.resuelta ? "pill-ok" : "pill-bad";
  const equipo = conEquipo && a.equipos ? `<strong>${escapeHtml(a.equipos.nombre_red || "Equipo")}</strong> — ` : "";
  return `<li><span class="pill ${clase}">${escapeHtml(a.estado || (a.resuelta ? "Resuelta" : "Sin resolver"))}</span> ${equipo}${escapeHtml(a.nombre || "Amenaza")}${a.severidad ? ` · severidad ${escapeHtml(a.severidad.toLowerCase())}` : ""} — ${fmtFecha(a.detectado_en)}${a.recurso ? `<br><span class="sub" style="word-break:break-all;">${escapeHtml(a.recurso)}</span>` : ""}</li>`;
}

// Lo llama app.js al terminar de pintar el detalle de un equipo.
async function cargarAmenazasEquipo(equipoId) {
  const cont = $("equipoDetalleAmenazas");
  if (!cont) return;
  const { data, error } = await sb.from("equipos_amenazas")
    .select("nombre, severidad, estado, resuelta, recurso, detectado_en")
    .eq("equipo_id", equipoId).order("detectado_en", { ascending: false }).limit(15);
  const contAhora = $("equipoDetalleAmenazas");
  if (!contAhora || $("equipoDetalleOverlay").dataset.equipoId !== equipoId) return;
  if (error) { contAhora.innerHTML = `<p class="empty-state" style="padding:10px 0;">No se pudieron cargar las amenazas: ${escapeHtml(error.message)}</p>`; return; }
  contAhora.innerHTML = (data && data.length)
    ? `<p class="sub" style="margin:0 0 6px;">Amenazas detectadas (últimos 60 días)</p><ul class="equipo-detalle-historial" style="max-height:220px;">${data.map((a) => filaAmenazaHtml(a, false)).join("")}</ul>`
    : `<p class="sub" style="margin:0;">Sin amenazas detectadas en los últimos 60 días.</p>`;
}

async function mandarActualizacionAgente(equipoIds) {
  const { data: sesionData } = await sb.auth.getSession();
  const filas = equipoIds.map((id) => ({
    equipo_id: id,
    accion: "script_personalizado",
    script_contenido: SCRIPT_ACTUALIZAR_AGENTE,
    creado_por: sesionData?.session?.user?.email || null,
  }));
  const { error } = await sb.from("equipos_comandos").insert(filas);
  if (error) { toast("Error al mandar la actualización: " + error.message, true); return false; }
  return true;
}

$("equipoDetalleBody").addEventListener("click", async (e) => {
  const btnFicha = e.target.closest("[data-abrir-ficha]");
  if (btnFicha) {
    const id = $("equipoDetalleOverlay").dataset.equipoId;
    if (id) abrirFichaEquipo(id);
    return;
  }
  const btnAct = e.target.closest("[data-actualizar-agente]");
  if (btnAct) {
    const id = $("equipoDetalleOverlay").dataset.equipoId;
    if (!id) return;
    if (!confirm("¿Actualizar el agente de este equipo a la versión con seguridad y rendimiento?\n\nSe descarga la próxima vez que el equipo consulte (hasta 15 min).")) return;
    btnAct.disabled = true;
    if (await mandarActualizacionAgente([id])) toast("Actualización en cola — en unos minutos el equipo empieza a reportar seguridad.");
    else btnAct.disabled = false;
  }
});

// ------------------------------------------------------------
// Vista "Seguridad": todas las empresas de un vistazo
// ------------------------------------------------------------

let segEquipos = [];

function vistaSeguridadActiva() {
  return $("view-seguridad")?.classList.contains("active");
}

async function cargarSeguridad() {
  const boton = $("btnActualizarSeguridad");
  boton.disabled = true;
  try {
    const desde = new Date(Date.now() - 30 * 86400000).toISOString();
    const [eqResp, amResp, autoResp] = await Promise.all([
      sb.from("equipos").select("id, empresa_id, nombre_red, responsable, origen, actualizado_en, seguridad, seguridad_nivel, rendimiento, agente_version, antivirus_estado, disco_libre_pct"),
      sb.from("equipos_amenazas").select("nombre, severidad, estado, resuelta, recurso, detectado_en, equipos!inner(nombre_red, empresa_id)").gte("detectado_en", desde).order("detectado_en", { ascending: false }).limit(30),
      sb.from("equipos_comandos").select("accion, estado, resultado, creado_en, equipos!inner(nombre_red, empresa_id)").eq("creado_por", "Respuesta automática").order("creado_en", { ascending: false }).limit(15),
    ]);

    if (eqResp.error) {
      $("segEmpresas").innerHTML = `<p class="empty-state">No se pudo cargar la seguridad: ${escapeHtml(eqResp.error.message)}.<br>Si es la primera vez, falta correr <code>supabase/seguridad.sql</code> en Supabase.</p>`;
      $("segResumen").style.display = "none";
      return;
    }
    segEquipos = eqResp.data || [];
    pintarResumenSeguridad();
    pintarEmpresasSeguridad();
    pintarAtencionSeguridad();

    const nombreEmpresa = (id) => (empresas.find((e) => e.id === id) || {}).nombre || "";
    const amenazas = amResp.data || [];
    $("segAmenazas").innerHTML = amenazas.length
      ? `<ul class="equipo-detalle-historial" style="max-height:340px;">${amenazas.map((a) => filaAmenazaHtml({ ...a, equipos: { nombre_red: `${nombreEmpresa(a.equipos.empresa_id)} · ${a.equipos.nombre_red || "Equipo"}` } }, true)).join("")}</ul>`
      : `<p class="empty-state" style="padding:18px 0;">Ninguna amenaza detectada en los últimos 30 días.</p>`;

    const autos = autoResp.data || [];
    $("segAutomaticas").innerHTML = autos.length
      ? `<ul class="equipo-detalle-historial" style="max-height:340px;">${autos.map((c) => `<li><span class="pill ${c.estado === "error" ? "pill-bad" : "pill-ok"}">${c.estado === "error" ? "no se pudo" : "hecho"}</span> <strong>${escapeHtml(nombreEmpresa(c.equipos.empresa_id))} · ${escapeHtml(c.equipos.nombre_red || "Equipo")}</strong> — ${escapeHtml(ACCIONES_SEGURIDAD[c.accion] || c.accion)} — ${fmtFecha(c.creado_en)}${c.resultado ? `<br><span class="sub">${escapeHtml(c.resultado)}</span>` : ""}</li>`).join("")}</ul>`
      : `<p class="empty-state" style="padding:18px 0;">Todavía no ha hecho falta: ningún equipo ha necesitado que se le corrija algo solo.</p>`;
  } finally {
    boton.disabled = false;
  }
}

function contarNiveles(equipos) {
  const c = { protegido: 0, advertencia: 0, riesgo: 0, sin_reporte: 0, sin_datos: 0 };
  equipos.forEach((r) => { c[estadoSeguridadEquipo(r).nivel]++; });
  return c;
}

function pintarResumenSeguridad() {
  const c = contarNiveles(segEquipos);
  $("segResumen").innerHTML = `
    <div class="dash-resumen-item dr-ok"><div class="dr-icon">✓</div><span class="dr-num">${c.protegido}</span><span class="dr-label">Protegidos</span></div>
    <div class="dash-resumen-item dr-warn"><div class="dr-icon">⚠</div><span class="dr-num">${c.advertencia}</span><span class="dr-label">Con advertencia</span></div>
    <div class="dash-resumen-item dr-bad"><div class="dr-icon">⛔</div><span class="dr-num">${c.riesgo}</span><span class="dr-label">En riesgo</span></div>
    <div class="dash-resumen-item dr-muted"><div class="dr-icon">○</div><span class="dr-num">${c.sin_reporte + c.sin_datos}</span><span class="dr-label">Sin vigilancia</span></div>`;
  $("segResumen").style.display = "grid";

  const punto = $("navSeguridadAlerta");
  if (punto) punto.style.display = c.riesgo > 0 ? "inline-block" : "none";
}

function pintarEmpresasSeguridad() {
  const esAdmin = perfil.rol === "admin";
  const tarjetas = empresas.map((emp) => {
    const eqs = segEquipos.filter((r) => r.empresa_id === emp.id);
    if (!eqs.length) return "";
    const c = contarNiveles(eqs);
    const conAgente = eqs.filter((r) => r.origen === "agente");
    const viejos = conAgente.filter((r) => r.agente_version !== VERSION_AGENTE_ACTUAL);
    const nivelEmpresa = c.riesgo ? "riesgo" : (c.advertencia || c.sin_reporte ? "advertencia" : (c.protegido ? "protegido" : "sin_datos"));
    const n = NIVELES_SEG[nivelEmpresa];
    const auto = emp.seguridad_auto !== false;
    return `
      <div class="card seg-empresa">
        <div class="seg-empresa-head">
          <h3 style="margin:0;">${escapeHtml(emp.nombre)}</h3>
          <span class="pill ${n.pill}">${n.icono} ${n.etiqueta}</span>
        </div>
        <div class="seg-conteos">
          <span><strong>${c.protegido}</strong> protegidos</span>
          <span><strong>${c.advertencia}</strong> con advertencia</span>
          <span><strong>${c.riesgo}</strong> en riesgo</span>
          <span><strong>${c.sin_reporte + c.sin_datos}</strong> sin vigilancia</span>
        </div>
        <p class="sub" style="margin:8px 0 12px;">${conAgente.length} de ${eqs.length} equipos tienen el agente instalado.</p>
        <label class="seg-auto">
          <input type="checkbox" data-seg-auto="${emp.id}" ${auto ? "checked" : ""} ${esAdmin ? "" : "disabled"} />
          <span>Respuesta automática <span class="sub">— si apagan la protección, las firmas se quedan viejas o queda una amenaza sin resolver, el agente lo corrige solo y lo deja anotado.</span></span>
        </label>
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;">
          <button class="btn-secondary" style="width:auto;" data-seg-informe="${emp.id}" type="button">Informe para el cliente</button>
          ${viejos.length ? `<button class="btn-secondary" style="width:auto;" data-seg-actualizar="${emp.id}" type="button">Actualizar ${viejos.length} agente${viejos.length === 1 ? "" : "s"}</button>` : ""}
        </div>
      </div>`;
  }).join("");
  $("segEmpresas").innerHTML = tarjetas || `<p class="empty-state">Todavía no hay equipos registrados. Instala el agente desde Inventario para empezar a vigilar.</p>`;
}

function pintarAtencionSeguridad() {
  const orden = { riesgo: 0, sin_reporte: 1, advertencia: 2 };
  const filas = segEquipos
    .map((r) => ({ r, est: estadoSeguridadEquipo(r) }))
    .filter((x) => x.est.nivel in orden)
    .sort((a, b) => orden[a.est.nivel] - orden[b.est.nivel]);

  $("segAtencionEmpty").style.display = filas.length ? "none" : "block";
  $("segAtencionWrap").style.display = filas.length ? "block" : "none";
  $("tablaSegAtencion").innerHTML = filas.map(({ r, est }) => {
    const n = NIVELES_SEG[est.nivel];
    const motivos = est.nivel === "sin_reporte" ? [est.motivo] : (r.seguridad.motivos || []);
    return `<tr>
      <td><span class="pill ${n.pill}">${n.icono} ${n.etiqueta}</span></td>
      <td>${escapeHtml((empresas.find((e) => e.id === r.empresa_id) || {}).nombre || "")}</td>
      <td>${escapeHtml(r.nombre_red || "")}</td>
      <td>${escapeHtml(r.responsable || "")}</td>
      <td>${motivos.map(escapeHtml).join("<br>")}</td>
      <td class="actions-cell"><button class="icon-btn" data-seg-detalle="${r.id}">Detalle</button><button class="icon-btn" data-seg-ficha="${r.id}">Ficha</button></td>
    </tr>`;
  }).join("");
}

$("btnActualizarSeguridad").addEventListener("click", cargarSeguridad);

document.querySelector('.nav-btn[data-view="seguridad"]').addEventListener("click", cargarSeguridad);

// Mientras la vista está abierta se refresca sola cada minuto: un
// equipo que queda en riesgo aparece sin tener que recargar a mano.
setInterval(() => {
  if (vistaSeguridadActiva() && !$("btnActualizarSeguridad").disabled && !$("fichaOverlay").classList.contains("abierto")) cargarSeguridad();
}, 60 * 1000);

$("view-seguridad").addEventListener("click", async (e) => {
  const det = e.target.closest("[data-seg-detalle]");
  if (det) {
    const { data } = await sb.from("equipos").select("*").eq("id", det.dataset.segDetalle).maybeSingle();
    if (data) abrirDetalleEquipo(data);
    return;
  }
  const ficha = e.target.closest("[data-seg-ficha]");
  if (ficha) { abrirFichaEquipo(ficha.dataset.segFicha); return; }

  const informe = e.target.closest("[data-seg-informe]");
  if (informe) { abrirInformeEmpresa(informe.dataset.segInforme); return; }

  const act = e.target.closest("[data-seg-actualizar]");
  if (act) {
    const ids = segEquipos.filter((r) => r.empresa_id === act.dataset.segActualizar && r.origen === "agente" && r.agente_version !== VERSION_AGENTE_ACTUAL).map((r) => r.id);
    if (!ids.length) return;
    if (!confirm(`¿Actualizar el agente en ${ids.length} equipo${ids.length === 1 ? "" : "s"} de esta empresa?\n\nCada equipo descarga la versión nueva la próxima vez que consulte (hasta 15 min, si está encendido).`)) return;
    act.disabled = true;
    if (await mandarActualizacionAgente(ids)) toast("Actualización en cola para " + ids.length + " equipo(s).");
    else act.disabled = false;
  }
});

$("view-seguridad").addEventListener("change", async (e) => {
  const chk = e.target.closest("[data-seg-auto]");
  if (!chk) return;
  const { error } = await sb.from("empresas").update({ seguridad_auto: chk.checked }).eq("id", chk.dataset.segAuto);
  if (error) { toast("No se pudo guardar: " + error.message, true); chk.checked = !chk.checked; return; }
  const emp = empresas.find((x) => x.id === chk.dataset.segAuto);
  if (emp) emp.seguridad_auto = chk.checked;
  toast(chk.checked ? "Respuesta automática prendida para esta empresa." : "Respuesta automática apagada para esta empresa.");
});

// ------------------------------------------------------------
// Ficha del equipo — la hoja que se le muestra al cliente
// ------------------------------------------------------------

function barraHtml(pct, etiqueta, umbralAviso, umbralMalo) {
  if (pct == null || Number.isNaN(pct)) return `<div class="f-barra-fila"><span>${etiqueta}</span><span class="f-tenue">sin dato</span></div>`;
  const clase = pct >= umbralMalo ? "f-malo" : (pct >= umbralAviso ? "f-aviso" : "f-bien");
  return `
    <div class="f-barra-fila"><span>${etiqueta}</span><strong>${pct}%</strong></div>
    <div class="f-barra"><div class="f-barra-llena ${clase}" style="width:${Math.max(2, Math.min(100, pct))}%"></div></div>`;
}

function tipoDiscoTexto(tipo) {
  if (/ssd/i.test(tipo || "")) return "Sólido (SSD)";
  if (/hdd/i.test(tipo || "")) return "Mecánico (HDD)";
  return "";
}

function estadoBloque(nivel, texto) {
  const mapa = { bien: ["f-bien", "✓"], aviso: ["f-aviso", "⚠"], malo: ["f-malo", "⛔"], nada: ["f-nada", "○"] };
  const [clase, icono] = mapa[nivel];
  return `<span class="f-estado ${clase}">${icono} ${escapeHtml(texto)}</span>`;
}

// Resumen de rendimiento de un equipo, a partir de las recomendaciones
// que ya calculó el servidor.
function nivelRendimiento(rend) {
  if (!rend) return { nivel: "nada", texto: "Sin datos" };
  const rec = rend.recomendaciones || [];
  if (rec.some((x) => x.nivel === "alta")) return { nivel: "malo", texto: "Necesita mejoras" };
  if (rec.length) return { nivel: "aviso", texto: "Se puede mejorar" };
  return { nivel: "bien", texto: "En buen estado" };
}

function nivelSeguridadFicha(r) {
  const est = estadoSeguridadEquipo(r);
  const mapa = { protegido: "bien", advertencia: "aviso", riesgo: "malo", sin_reporte: "aviso", sin_datos: "nada" };
  return { nivel: mapa[est.nivel], texto: NIVELES_SEG[est.nivel].etiqueta };
}

function esquemaEquipoHtml(r) {
  const rend = r.rendimiento || {};
  const s = r.seguridad || {};
  const def = s.defender;

  // --- Memoria: una casilla por ranura, llena o vacía ---
  const modulos = rend.ram_modulos || [];
  const ranuras = Math.max(rend.ram_ranuras || 0, modulos.length);
  let ranurasHtml = "";
  for (let i = 0; i < ranuras; i++) {
    const m = modulos[i];
    ranurasHtml += m
      ? `<div class="f-ranura f-ranura-llena"><strong>${m.gb != null ? m.gb + " GB" : "?"}</strong><span>${m.mhz ? m.mhz + " MHz" : ""}</span></div>`
      : `<div class="f-ranura"><span>libre</span></div>`;
  }

  // --- Almacenamiento: cada disco físico y, debajo, las unidades ---
  const discos = rend.discos || [];
  const discosHtml = discos.length
    ? discos.map((d) => {
        const sano = !d.salud || /^healthy$/i.test(d.salud);
        return `<div class="f-disco">
          <div><strong>${escapeHtml(d.modelo || "Disco")}</strong><br><span class="f-tenue">${[d.gb != null ? d.gb + " GB" : "", tipoDiscoTexto(d.tipo), d.bus].filter(Boolean).map(escapeHtml).join(" · ")}</span></div>
          ${estadoBloque(sano ? "bien" : "malo", sano ? "Sano" : "Con fallas")}
        </div>`;
      }).join("")
    : `<p class="f-tenue">${escapeHtml([r.disco_duro, r.tipo_disco].filter(Boolean).join(" · ") || "Sin dato")}</p>`;
  const unidadesHtml = (rend.unidades || []).map((u) =>
    barraHtml(u.libre_pct != null ? 100 - u.libre_pct : null, `Unidad ${escapeHtml(u.letra || "")} — ${u.libre_gb != null ? u.libre_gb + " GB libres de " + u.gb : ""}`, 80, 90)).join("");

  const fw = textoFirewall(s.firewall);
  const analisis = ultimoAnalisis(def);

  return `
    <div class="f-esquema">
      <div class="f-pieza f-pieza-cpu">
        <div class="f-pieza-titulo">Procesador</div>
        <div class="f-chip"><div class="f-chip-nucleo">${rend.cpu_nucleos != null ? rend.cpu_nucleos : "–"}<span>núcleos</span></div></div>
        <p class="f-pieza-nombre">${escapeHtml(r.procesador || "Sin dato")}</p>
        <p class="f-tenue">${[rend.cpu_hilos ? rend.cpu_hilos + " hilos" : "", rend.cpu_mhz ? (rend.cpu_mhz / 1000).toFixed(1) + " GHz" : ""].filter(Boolean).join(" · ")}</p>
        ${barraHtml(rend.cpu_uso_pct, "Uso en el último reporte", 70, 85)}
      </div>

      <div class="f-pieza f-pieza-ram">
        <div class="f-pieza-titulo">Memoria RAM</div>
        <p class="f-pieza-nombre">${escapeHtml(rend.ram_total_gb != null ? Math.round(rend.ram_total_gb) + " GB" : (r.memoria_ram || "Sin dato"))} ${escapeHtml(r.tipo_memoria || "")}</p>
        ${ranuras ? `<div class="f-ranuras">${ranurasHtml}</div><p class="f-tenue">${modulos.length} de ${ranuras} ranura${ranuras === 1 ? "" : "s"} ocupada${modulos.length === 1 ? "" : "s"}</p>` : ""}
        ${barraHtml(rend.ram_uso_pct, "Uso en el último reporte", 75, 85)}
      </div>

      <div class="f-pieza f-pieza-disco">
        <div class="f-pieza-titulo">Almacenamiento</div>
        ${discosHtml}
        ${unidadesHtml}
      </div>

      <div class="f-pieza f-pieza-sistema">
        <div class="f-pieza-titulo">Sistema</div>
        <p class="f-pieza-nombre">${escapeHtml(r.licencia_so || "Sin dato")}</p>
        <dl class="f-lista">
          <dt>Licencia de Windows</dt><dd>${escapeHtml(r.windows_activado || "—")}</dd>
          <dt>Última actualización</dt><dd>${s.ultima_actualizacion ? fmtFechaCorta(s.ultima_actualizacion.slice(0, 10)) : "—"}</dd>
          <dt>Encendido sin reiniciar</dt><dd>${rend.dias_encendido != null ? rend.dias_encendido + " día" + (rend.dias_encendido === 1 ? "" : "s") : "—"}</dd>
          <dt>Programas al inicio</dt><dd>${rend.programas_inicio != null ? rend.programas_inicio : "—"}</dd>
          ${rend.bateria_salud_pct != null ? `<dt>Salud de la batería</dt><dd>${rend.bateria_salud_pct}%</dd>` : ""}
        </dl>
      </div>

      <div class="f-pieza f-pieza-seg">
        <div class="f-pieza-titulo">Protección</div>
        <p class="f-pieza-nombre">${escapeHtml(s.protector || (def && def.antivirus_activo ? "Microsoft Defender — protección apagada" : (r.seguridad ? "Sin antivirus activo" : "Sin dato")))}</p>
        <dl class="f-lista">
          ${def ? `<dt>Protección en tiempo real</dt><dd>${siNo(def.tiempo_real, "Prendida", "Apagada") || "—"}</dd>` : ""}
          ${def && s.protector === "Microsoft Defender" ? `<dt>Firmas actualizadas</dt><dd>${def.firmas_fecha ? fmtFechaCorta(def.firmas_fecha.slice(0, 10)) : "—"}</dd><dt>Último análisis</dt><dd>${analisis ? fmtFechaCorta(analisis.slice(0, 10)) : "Nunca"}</dd>` : ""}
          <dt>Firewall</dt><dd>${escapeHtml(fw || "—")}</dd>
          <dt>Amenazas en 30 días</dt><dd>${s.amenazas_30d != null ? s.amenazas_30d : "—"}</dd>
        </dl>
      </div>

      <div class="f-pieza f-pieza-red">
        <div class="f-pieza-titulo">Identificación y red</div>
        <dl class="f-lista">
          <dt>Nombre en la red</dt><dd>${escapeHtml(r.nombre_red || "—")}</dd>
          <dt>Dirección IP</dt><dd>${escapeHtml(r.ip_local || "—")}</dd>
          <dt>Marca y modelo</dt><dd>${escapeHtml([rend.fabricante, rend.modelo].filter(Boolean).join(" ") || r.referencia || "—")}</dd>
          <dt>Serial</dt><dd>${escapeHtml(r.serial || "—")}</dd>
          <dt>Tipo</dt><dd>${escapeHtml(r.tipo_equipo || "—")}</dd>
        </dl>
      </div>
    </div>`;
}

function encabezadoFichaHtml(titulo, subtitulo, empresaNombre) {
  const hoy = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  return `
    <header class="f-encabezado">
      <div>
        <div class="f-marca">Soporte TI</div>
        <h1>${escapeHtml(titulo)}</h1>
        <p>${escapeHtml(subtitulo)}</p>
      </div>
      <div class="f-encabezado-der">
        <strong>${escapeHtml(empresaNombre)}</strong>
        <span>${hoy}</span>
      </div>
    </header>`;
}

function mostrarFicha(html) {
  $("fichaHoja").innerHTML = html;
  $("fichaOverlay").classList.add("abierto");
  document.body.classList.add("ficha-abierta");
  $("fichaOverlay").scrollTop = 0;
}

function cerrarFicha() {
  $("fichaOverlay").classList.remove("abierto");
  document.body.classList.remove("ficha-abierta");
}

async function abrirFichaEquipo(equipoId) {
  mostrarFicha(`<p class="f-tenue" style="padding:40px 0; text-align:center;">Cargando…</p>`);
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const [{ data: r, error }, { data: amenazas }] = await Promise.all([
    sb.from("equipos").select("*").eq("id", equipoId).maybeSingle(),
    sb.from("equipos_amenazas").select("nombre, estado, resuelta, detectado_en").eq("equipo_id", equipoId).gte("detectado_en", desde).order("detectado_en", { ascending: false }).limit(10),
  ]);
  if (error || !r) { mostrarFicha(`<p class="f-tenue" style="padding:40px 0; text-align:center;">No se pudo cargar el equipo.</p>`); return; }

  const empresaNombre = (empresas.find((e) => e.id === r.empresa_id) || {}).nombre || "";
  const rend = r.rendimiento;
  const seg = nivelSeguridadFicha(r);
  const ren = nivelRendimiento(rend);
  const pctDisco = parseInt(r.disco_libre_pct, 10);
  const alm = Number.isNaN(pctDisco) ? { nivel: "nada", texto: "Sin datos" }
    : (pctDisco < 10 ? { nivel: "malo", texto: `${pctDisco}% libre` } : (pctDisco < 20 ? { nivel: "aviso", texto: `${pctDisco}% libre` } : { nivel: "bien", texto: `${pctDisco}% libre` }));

  const sinAgente = r.origen !== "agente";
  const avisoDatos = sinAgente
    ? `<p class="f-nota">Este equipo se registró a mano: no tiene el agente instalado, así que no hay datos en vivo de rendimiento ni de protección.</p>`
    : (!rend ? `<p class="f-nota">El agente de este equipo es de la versión anterior y todavía no reporta rendimiento ni protección. Al actualizarlo esta ficha se completa sola.</p>` : "");

  const rec = (rend && rend.recomendaciones) || [];
  const motivosSeg = (r.seguridad && r.seguridad.motivos) || [];
  const recomendacionesHtml = (rec.length || motivosSeg.length)
    ? `<ul class="f-recs">
        ${rec.map((x) => `<li class="${x.nivel === "alta" ? "f-rec-alta" : "f-rec-media"}"><strong>${escapeHtml(x.titulo)}</strong><span>${escapeHtml(x.detalle)}</span></li>`).join("")}
        ${motivosSeg.map((m) => `<li class="${r.seguridad_nivel === "riesgo" ? "f-rec-alta" : "f-rec-media"}"><strong>Protección</strong><span>${escapeHtml(m)}</span></li>`).join("")}
      </ul>`
    : (rend ? `<p class="f-ok-linea">✓ No hay nada que esté frenando este equipo ni dejándolo desprotegido.</p>` : `<p class="f-tenue">Sin datos suficientes para recomendar.</p>`);

  const procesos = (rend && rend.procesos_top) || [];
  const maxMb = Math.max(1, ...procesos.map((p) => p.mb || 0));
  const procesosHtml = procesos.length
    ? procesos.map((p) => `
        <div class="f-barra-fila"><span>${escapeHtml(p.nombre || "")}</span><strong>${p.mb >= 1024 ? (p.mb / 1024).toFixed(1) + " GB" : p.mb + " MB"}</strong></div>
        <div class="f-barra"><div class="f-barra-llena f-neutro" style="width:${Math.max(2, Math.round((p.mb / maxMb) * 100))}%"></div></div>`).join("")
    : `<p class="f-tenue">Sin dato.</p>`;

  const amenazasHtml = (amenazas && amenazas.length)
    ? `<ul class="f-amenazas">${amenazas.map((a) => `<li>${estadoBloque(a.resuelta ? "bien" : "malo", a.estado || (a.resuelta ? "Resuelta" : "Sin resolver"))} <span>${escapeHtml(a.nombre || "Amenaza")}</span> <span class="f-tenue">${fmtFechaCorta((a.detectado_en || "").slice(0, 10))}</span></li>`).join("")}</ul>`
    : `<p class="f-ok-linea">✓ Ninguna amenaza detectada en los últimos 30 días.</p>`;

  mostrarFicha(`
    ${encabezadoFichaHtml(r.nombre_red || r.serial || "Equipo", r.responsable ? `Equipo de ${r.responsable}` : "Ficha técnica del equipo", empresaNombre)}

    <section class="f-resumen">
      <div class="f-resumen-item"><span class="f-resumen-et">Protección</span>${estadoBloque(seg.nivel, seg.texto)}</div>
      <div class="f-resumen-item"><span class="f-resumen-et">Rendimiento</span>${estadoBloque(ren.nivel, ren.texto)}</div>
      <div class="f-resumen-item"><span class="f-resumen-et">Espacio en disco</span>${estadoBloque(alm.nivel, alm.texto)}</div>
    </section>
    ${avisoDatos}

    <section>
      <h2>Esquema del equipo</h2>
      ${esquemaEquipoHtml(r)}
    </section>

    <section>
      <h2>Qué conviene mejorar</h2>
      ${recomendacionesHtml}
    </section>

    <div class="f-dos">
      <section>
        <h2>Lo que más memoria está usando</h2>
        ${procesosHtml}
      </section>
      <section>
        <h2>Amenazas detectadas (30 días)</h2>
        ${sinAgente || !r.seguridad ? `<p class="f-tenue">Sin dato.</p>` : amenazasHtml}
      </section>
    </div>

    <footer class="f-pie">
      ${r.origen === "agente" && r.actualizado_en ? `Último reporte del equipo: ${fmtFecha(r.actualizado_en)} — ` : ""}El uso de procesador y memoria es el del momento del reporte, no un promedio del día.
    </footer>`);
}

// Informe de toda la empresa en una hoja: lo que se entrega cada mes.
async function abrirInformeEmpresa(empresaId) {
  mostrarFicha(`<p class="f-tenue" style="padding:40px 0; text-align:center;">Cargando…</p>`);
  const desde = new Date(Date.now() - 30 * 86400000).toISOString();
  const [{ data: equipos, error }, { data: amenazas }, { data: autos }] = await Promise.all([
    sb.from("equipos").select("*").eq("empresa_id", empresaId).order("nombre_red"),
    sb.from("equipos_amenazas").select("nombre, estado, resuelta, detectado_en, equipos!inner(nombre_red, empresa_id)").eq("equipos.empresa_id", empresaId).gte("detectado_en", desde).order("detectado_en", { ascending: false }).limit(40),
    sb.from("equipos_comandos").select("accion, estado, creado_en, equipos!inner(nombre_red, empresa_id)").eq("equipos.empresa_id", empresaId).eq("creado_por", "Respuesta automática").gte("creado_en", desde).order("creado_en", { ascending: false }).limit(40),
  ]);
  if (error) { mostrarFicha(`<p class="f-tenue" style="padding:40px 0; text-align:center;">No se pudo cargar el informe: ${escapeHtml(error.message)}</p>`); return; }

  const lista = equipos || [];
  const empresaNombre = (empresas.find((e) => e.id === empresaId) || {}).nombre || "";
  const c = contarNiveles(lista);
  const lAm = amenazas || [];
  const resueltas = lAm.filter((a) => a.resuelta).length;

  const filas = lista.map((r) => {
    const seg = nivelSeguridadFicha(r);
    const ren = nivelRendimiento(r.rendimiento);
    const rec = ((r.rendimiento && r.rendimiento.recomendaciones) || []).map((x) => x.titulo);
    const mot = (r.seguridad && r.seguridad.motivos) || [];
    return `<tr>
      <td><strong>${escapeHtml(r.nombre_red || r.serial || "Equipo")}</strong><br><span class="f-tenue">${escapeHtml(r.responsable || "")}</span></td>
      <td>${estadoBloque(seg.nivel, seg.texto)}</td>
      <td>${estadoBloque(ren.nivel, ren.texto)}</td>
      <td>${escapeHtml((r.seguridad && r.seguridad.protector) || r.antivirus_estado || "—")}</td>
      <td>${[...mot, ...rec].map(escapeHtml).join("<br>") || "—"}</td>
    </tr>`;
  }).join("");

  mostrarFicha(`
    ${encabezadoFichaHtml("Informe de equipos", "Estado de protección y rendimiento — últimos 30 días", empresaNombre)}

    <section class="f-resumen f-resumen-4">
      <div class="f-resumen-item"><span class="f-resumen-et">Equipos</span><span class="f-numero">${lista.length}</span></div>
      <div class="f-resumen-item"><span class="f-resumen-et">Protegidos</span><span class="f-numero">${c.protegido}</span></div>
      <div class="f-resumen-item"><span class="f-resumen-et">Requieren atención</span><span class="f-numero">${c.advertencia + c.riesgo}</span></div>
      <div class="f-resumen-item"><span class="f-resumen-et">Sin vigilancia</span><span class="f-numero">${c.sin_datos + c.sin_reporte}</span></div>
    </section>

    <section>
      <h2>Lo que pasó este mes</h2>
      <ul class="f-hechos">
        <li><strong>${lAm.length}</strong> amenaza${lAm.length === 1 ? "" : "s"} detectada${lAm.length === 1 ? "" : "s"}${lAm.length ? `, <strong>${resueltas}</strong> resuelta${resueltas === 1 ? "" : "s"}` : ""}.</li>
        <li><strong>${(autos || []).length}</strong> ${(autos || []).length === 1 ? "corrección" : "correcciones"} hecha${(autos || []).length === 1 ? "" : "s"} automáticamente por el agente (protección reactivada, firmas actualizadas, amenazas eliminadas).</li>
      </ul>
      ${lAm.length ? `<ul class="f-amenazas">${lAm.slice(0, 15).map((a) => `<li>${estadoBloque(a.resuelta ? "bien" : "malo", a.estado || "")} <span><strong>${escapeHtml(a.equipos.nombre_red || "Equipo")}</strong> — ${escapeHtml(a.nombre || "Amenaza")}</span> <span class="f-tenue">${fmtFechaCorta((a.detectado_en || "").slice(0, 10))}</span></li>`).join("")}</ul>` : ""}
    </section>

    <section>
      <h2>Equipo por equipo</h2>
      <div class="f-tabla-wrap">
        <table class="f-tabla">
          <thead><tr><th>Equipo</th><th>Protección</th><th>Rendimiento</th><th>Antivirus</th><th>Observaciones</th></tr></thead>
          <tbody>${filas || `<tr><td colspan="5" class="f-tenue">Sin equipos registrados.</td></tr>`}</tbody>
        </table>
      </div>
    </section>

    <footer class="f-pie">"Sin vigilancia" son equipos sin el agente instalado o que llevan más de 2 días sin reportar. Las amenazas listadas son las detectadas por Microsoft Defender; las de otros antivirus se consultan en su propia consola.</footer>`);
}

$("btnCerrarFicha").addEventListener("click", cerrarFicha);
$("btnImprimirFicha").addEventListener("click", () => window.print());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("fichaOverlay").classList.contains("abierto")) cerrarFicha();
});

// ------------------------------------------------------------
// Mantenimiento en todos los equipos de una empresa (vista Inventario)
// ------------------------------------------------------------
// Misma cola de comandos que las acciones de un solo equipo: se crea
// una fila "pendiente" por cada equipo con agente de la empresa
// seleccionada, y cada equipo la ejecuta cuando consulta.

$("mantAccion").addEventListener("change", () => {
  $("mantScriptWrap").style.display = $("mantAccion").value === "script_personalizado" ? "block" : "none";
});

$("btnMantEjecutar").addEventListener("click", async () => {
  if (!empresaInvActual) { toast("Selecciona una empresa primero.", true); return; }
  const accion = $("mantAccion").value;
  const etiqueta = $("mantAccion").selectedOptions[0].textContent.replace("…", "");
  const script = $("mantScript").value;
  if (accion === "script_personalizado" && !script.trim()) { toast("Escribe el script antes de ejecutarlo.", true); return; }

  const boton = $("btnMantEjecutar");
  boton.disabled = true;
  try {
    const { data: equipos, error } = await sb.from("equipos").select("id").eq("empresa_id", empresaInvActual).eq("origen", "agente");
    if (error) { toast("Error al buscar los equipos: " + error.message, true); return; }
    if (!equipos || !equipos.length) { toast("Esta empresa no tiene equipos con el agente instalado.", true); return; }

    const empresaNombre = (empresas.find((e) => e.id === empresaInvActual) || {}).nombre || "esta empresa";
    const n = equipos.length;
    const aviso = accion === "reiniciar_equipo"
      ? "\n\nA cada persona le aparece un aviso con 5 minutos para guardar antes de que el equipo reinicie."
      : (accion === "script_personalizado" ? "\n\nEl script corre TAL CUAL en cada equipo, con permisos de administrador. No hay deshacer." : "");
    if (!confirm(`¿${etiqueta} en ${n} equipo${n === 1 ? "" : "s"} de ${empresaNombre}?${aviso}`)) return;

    const { data: sesionData } = await sb.auth.getSession();
    const filas = equipos.map((e) => ({
      equipo_id: e.id,
      accion,
      script_contenido: accion === "script_personalizado" ? script : null,
      creado_por: sesionData?.session?.user?.email || null,
    }));
    const { error: errInsert } = await sb.from("equipos_comandos").insert(filas);
    if (errInsert) { toast("Error al mandar la acción: " + errInsert.message, true); return; }
    toast(`Acción en cola para ${n} equipo${n === 1 ? "" : "s"}. El resultado de cada uno queda en su Detalle.`);
  } finally {
    boton.disabled = false;
  }
});
