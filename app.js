// ============================================================
// Helpdesk TI — lógica de la app (usa Supabase como backend)
// ============================================================

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let sesion = null;
let perfil = null; // { rol: 'admin' | 'tecnico', nombre }
let empresas = [];
let empresaInvActual = null;
let empresaCredActual = null;

const $ = (id) => document.getElementById(id);

function toast(msg, isError) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast visible" + (isError ? " error" : "");
  setTimeout(() => { t.className = "toast"; }, 3500);
}

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------

async function init() {
  const { data } = await sb.auth.getSession();
  if (data.session) {
    await entrarApp(data.session);
  } else {
    mostrarLogin();
  }
}

function mostrarLogin() {
  $("loginWrap").style.display = "flex";
  $("appShell").classList.remove("visible");
}

async function entrarApp(session) {
  sesion = session;

  const { data: perfilData, error } = await sb
    .from("usuarios_perfil")
    .select("rol, nombre")
    .eq("id", session.user.id)
    .maybeSingle();

  if (error) {
    console.error(error);
  }
  perfil = perfilData || { rol: "tecnico", nombre: session.user.email };

  $("loginWrap").style.display = "none";
  $("appShell").classList.add("visible");
  $("userEmail").textContent = emailAUsuario(session.user.email);
  $("rolBadge").textContent = perfil.rol === "admin" ? "administrador" : "técnico";

  const nombrePersonal = (perfil.nombre || emailAUsuario(session.user.email) || "MI").toString().toUpperCase();
  $("navPersonalLabel").textContent = nombrePersonal + " PERSONAL";
  $("personalTitulo").textContent = nombrePersonal + " PERSONAL";
  $("personalNombre").value = perfil.nombre || "";

  $("navEquipo").style.display = perfil.rol === "admin" ? "flex" : "none";

  await cargarEmpresas();
  await cargarPersonal();
  if (perfil.rol === "admin") await cargarUsuarios();
  cargarDashboard();
}

function usuarioAEmail(valor) {
  valor = valor.trim();
  if (!valor) return valor;
  return valor.includes("@") ? valor : `${valor}@${USUARIO_DOMINIO}`;
}

// Para mostrar en pantalla: si es del dominio interno, muestra solo el
// nombre de usuario en vez del correo falso completo.
function emailAUsuario(email) {
  if (!email) return "";
  const sufijo = "@" + USUARIO_DOMINIO;
  return email.endsWith(sufijo) ? email.slice(0, -sufijo.length) : email;
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loginError").textContent = "";
  $("loginBtn").disabled = true;
  const email = usuarioAEmail($("loginEmail").value);
  const password = $("loginPassword").value;

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  $("loginBtn").disabled = false;

  if (error) {
    $("loginError").textContent = "Correo o contraseña incorrectos.";
    return;
  }
  await entrarApp(data.session);
});

$("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
  sesion = null;
  perfil = null;
  mostrarLogin();
});

// ------------------------------------------------------------
// Navegación entre vistas
// ------------------------------------------------------------

document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn[data-view]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    $("view-" + btn.dataset.view).classList.add("active");
  });
});

// ------------------------------------------------------------
// Dashboard general — resumen del estado de TODAS las empresas de un
// vistazo (usa la misma Edge Function "mikrotik-estado", en modo
// liviano con { todas: true }, que consulta todos los routers en
// paralelo entre sí sin medir tráfico de cada interfaz, para que sea
// rápido aunque haya muchas empresas).
// ------------------------------------------------------------

$("btnActualizarDashboard").addEventListener("click", cargarDashboard);

async function cargarDashboard() {
  $("btnActualizarDashboard").disabled = true;
  $("btnActualizarDashboard").textContent = "Actualizando…";
  $("dashMensaje").style.display = "none";

  const { data, error } = await sb.functions.invoke("mikrotik-estado", { body: { todas: true } });

  $("btnActualizarDashboard").disabled = false;
  $("btnActualizarDashboard").textContent = "Actualizar estado";

  if (error || data?.error) {
    $("dashMensaje").style.display = "block";
    $("dashMensaje").textContent = "Error: " + (data?.error || error.message);
    $("dashGrid").innerHTML = "";
    return;
  }

  const items = data.empresas || [];
  if (items.length === 0) {
    $("dashMensaje").style.display = "block";
    $("dashMensaje").textContent = "Todavía no hay empresas registradas.";
    $("dashGrid").innerHTML = "";
    return;
  }

  $("dashGrid").innerHTML = items.map(pintarDashCard).join("");
  $("dashActualizado").style.display = "inline";
  $("dashActualizado").textContent = "Actualizado a las " + new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });

  $("dashGrid").querySelectorAll("[data-dash-empresa]").forEach((el) => {
    el.addEventListener("click", () => irAMonitoreoDesdeDashboard(el.dataset.dashEmpresa));
  });
}

function pintarDashCard(item) {
  const routers = item.routers || [];

  if (routers.length === 0) {
    return `
      <div class="dash-card dash-sin-router" data-dash-empresa="${item.empresa_id}">
        <div class="dash-card-top"><h4>${escapeHtml(item.empresa_nombre)}</h4><span class="pill">Sin router</span></div>
        <div class="dash-card-sub">No tiene un router MikroTik configurado todavía.</div>
      </div>`;
  }

  let alertas = 0, advertencias = 0, fuera = 0;
  routers.forEach((r) => {
    if (!r || !r.conectado) { fuera++; return; }
    (r.diagnostico || []).forEach((d) => { if (d.nivel === "alerta") alertas++; else advertencias++; });
  });

  let nivel = "ok";
  if (fuera > 0 || alertas > 0) nivel = "alerta";
  else if (advertencias > 0) nivel = "advertencia";

  const estadoClase = nivel === "alerta" ? "pill-bad" : (nivel === "advertencia" ? "pill-warn" : "pill-ok");
  const estadoTxt = fuera > 0
    ? `${fuera} de ${routers.length} sin conexión`
    : (nivel === "ok" ? "Todo bien" : `${alertas + advertencias} hallazgo${(alertas + advertencias) > 1 ? "s" : ""}`);

  const badges = [];
  if (alertas > 0) badges.push(`<span class="pill pill-bad">⛔ ${alertas}</span>`);
  if (advertencias > 0) badges.push(`<span class="pill pill-warn">⚠️ ${advertencias}</span>`);
  if (badges.length === 0 && fuera === 0) badges.push(`<span class="pill pill-ok">✓ Sin problemas</span>`);

  return `
    <div class="dash-card dash-${nivel}" data-dash-empresa="${item.empresa_id}">
      <div class="dash-card-top"><h4>${escapeHtml(item.empresa_nombre)}</h4><span class="pill ${estadoClase}">${estadoTxt}</span></div>
      <div class="dash-card-sub">${routers.length} router${routers.length > 1 ? "es" : ""} configurado${routers.length > 1 ? "s" : ""}</div>
      <div class="dash-badges">${badges.join("")}</div>
    </div>`;
}

function irAMonitoreoDesdeDashboard(empresaId) {
  $("navMonitoreo").click();
  $("monEmpresaSelect").value = empresaId;
  $("monEmpresaSelect").dispatchEvent(new Event("change"));
  setTimeout(() => $("btnVerificarMonitoreo").click(), 60);
}

// ------------------------------------------------------------
// Empresas
// ------------------------------------------------------------

async function cargarEmpresas() {
  const { data, error } = await sb.from("empresas").select("*").order("nombre");
  if (error) { toast("No se pudo cargar empresas: " + error.message, true); return; }
  empresas = data || [];

  // Contadores para la tabla de empresas
  const [{ data: eq }, credRes] = await Promise.all([
    sb.from("equipos").select("empresa_id"),
    sb.from("credenciales").select("empresa_id"),
  ]);
  const cred = credRes.data || [];

  const contarEq = (id) => (eq || []).filter((r) => r.empresa_id === id).length;
  const contarCred = (id) => cred.filter((r) => r.empresa_id === id).length;

  if ($("statEmpresas")) $("statEmpresas").textContent = empresas.length;
  if ($("statEquipos")) $("statEquipos").textContent = (eq || []).length;
  if ($("statCredenciales")) $("statCredenciales").textContent = cred.length;

  const tbody = $("tablaEmpresas");
  tbody.innerHTML = "";
  empresas.forEach((emp) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(emp.nombre)}</td>
      <td><span class="pill">${contarEq(emp.id)}</span></td>
      <td><span class="pill">${contarCred(emp.id)}</span></td>
      <td class="actions-cell">
        ${perfil.rol === "admin" ? `<button class="icon-btn danger" data-borrar-empresa="${emp.id}">Borrar</button>` : ""}
      </td>`;
    tbody.appendChild(tr);
  });
  $("empresasEmpty").style.display = empresas.length ? "none" : "block";

  document.querySelectorAll("[data-borrar-empresa]").forEach((b) => {
    b.addEventListener("click", () => borrarEmpresa(b.dataset.borrarEmpresa));
  });

  // Poblar selects
  const opciones = `<option value="">Selecciona…</option>` +
    empresas.map((e) => `<option value="${e.id}">${escapeHtml(e.nombre)}</option>`).join("");
  $("invEmpresaSelect").innerHTML = opciones;
  $("credEmpresaSelect").innerHTML = opciones;
  $("monEmpresaSelect").innerHTML = opciones;

  $("empresaFormCard").style.display = perfil.rol === "admin" ? "block" : "none";
}

$("btnCrearEmpresa").addEventListener("click", async () => {
  const nombre = $("nuevaEmpresaNombre").value.trim();
  if (!nombre) { toast("Escribe el nombre de la empresa.", true); return; }
  const { error } = await sb.from("empresas").insert({ nombre });
  if (error) { toast("Error al crear: " + error.message, true); return; }
  $("nuevaEmpresaNombre").value = "";
  toast("Empresa agregada.");
  await cargarEmpresas();
});

async function borrarEmpresa(id) {
  const { error } = await sb.from("empresas").delete().eq("id", id);
  if (error) { toast("Error al borrar: " + error.message, true); return; }
  toast("Empresa eliminada.");
  await cargarEmpresas();
}

// ------------------------------------------------------------
// Inventario
// ------------------------------------------------------------

$("invEmpresaSelect").addEventListener("change", async (e) => {
  empresaInvActual = e.target.value || null;
  await cargarEquipos();
});

const CAMPOS_EQUIPO = [
  ["tipoEquipo", "eqTipo"], ["nombreRed", "eqNombreRed"], ["sitio", "eqSitio"],
  ["responsable", "eqResponsable"], ["referencia", "eqReferencia"], ["serial", "eqSerial"],
  ["procesador", "eqProcesador"], ["memoriaRam", "eqRam"], ["tipoMemoria", "eqTipoMemoria"],
  ["discoDuro", "eqDisco"], ["tipoDisco", "eqTipoDisco"], ["licenciaSo", "eqLicenciaSO"],
  ["tipoLicencia", "eqTipoLicencia"], ["comentarios", "eqComentarios"], ["registradoPor", "eqRegistradoPor"],
];

$("btnGuardarEquipo").addEventListener("click", async () => {
  $("equipoError").textContent = "";
  if (!empresaInvActual) { $("equipoError").textContent = "Selecciona una empresa primero."; return; }

  const valores = {};
  CAMPOS_EQUIPO.forEach(([campo, id]) => { valores[campo] = $(id).value.trim(); });

  if (!valores.tipoEquipo) { $("equipoError").textContent = "Selecciona el tipo de equipo."; return; }
  if (!valores.nombreRed && !valores.serial) {
    $("equipoError").textContent = "Ingresa al menos el nombre de red o el serial.";
    return;
  }

  const { error } = await sb.from("equipos").insert({
    empresa_id: empresaInvActual,
    tipo_equipo: valores.tipoEquipo,
    nombre_red: valores.nombreRed,
    sitio: valores.sitio,
    responsable: valores.responsable,
    referencia: valores.referencia,
    serial: valores.serial,
    procesador: valores.procesador,
    memoria_ram: valores.memoriaRam,
    tipo_memoria: valores.tipoMemoria,
    disco_duro: valores.discoDuro,
    tipo_disco: valores.tipoDisco,
    licencia_so: valores.licenciaSo,
    tipo_licencia: valores.tipoLicencia,
    comentarios: valores.comentarios,
    registrado_por: valores.registradoPor || sesion.user.email,
  });

  if (error) { $("equipoError").textContent = "Error al guardar: " + error.message; return; }

  CAMPOS_EQUIPO.forEach(([, id]) => { if (id !== "eqRegistradoPor") $(id).value = ""; });
  toast("Equipo guardado.");
  await cargarEquipos();
  await cargarEmpresas();
});

async function cargarEquipos() {
  const tbody = $("tablaEquipos");
  tbody.innerHTML = "";
  if (!empresaInvActual) { $("equiposEmpty").style.display = "block"; $("equiposEmpty").textContent = "Selecciona una empresa arriba."; return; }

  const { data, error } = await sb
    .from("equipos").select("*")
    .eq("empresa_id", empresaInvActual)
    .order("created_at", { ascending: false });

  if (error) { toast("Error al cargar equipos: " + error.message, true); return; }

  $("equiposEmpty").style.display = (data && data.length) ? "none" : "block";
  $("equiposEmpty").textContent = "Sin equipos para esta empresa todavía.";

  (data || []).forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtFecha(r.created_at)}</td><td>${escapeHtml(r.tipo_equipo)}</td>
      <td>${escapeHtml(r.nombre_red)}</td><td>${escapeHtml(r.sitio)}</td>
      <td>${escapeHtml(r.responsable)}</td><td>${escapeHtml(r.referencia)}</td>
      <td>${escapeHtml(r.serial)}</td><td>${escapeHtml(r.procesador)}</td>
      <td>${escapeHtml(r.memoria_ram)}</td><td>${escapeHtml(r.tipo_memoria)}</td>
      <td>${escapeHtml(r.disco_duro)}</td><td>${escapeHtml(r.tipo_disco)}</td>
      <td>${escapeHtml(r.licencia_so)}</td><td>${escapeHtml(r.tipo_licencia)}</td>
      <td>${escapeHtml(r.comentarios)}</td><td>${escapeHtml(r.registrado_por)}</td>
      <td class="actions-cell">${perfil.rol === "admin" ? `<button class="icon-btn danger" data-borrar-equipo="${r.id}">Borrar</button>` : ""}</td>`;
    tbody.appendChild(tr);
  });

  document.querySelectorAll("[data-borrar-equipo]").forEach((b) => {
    b.addEventListener("click", async () => {
      const { error } = await sb.from("equipos").delete().eq("id", b.dataset.borrarEquipo);
      if (error) { toast("Error al borrar: " + error.message, true); return; }
      await cargarEquipos();
      await cargarEmpresas();
    });
  });
}

$("btnExportarInventario").addEventListener("click", async () => {
  if (!empresaInvActual) { toast("Selecciona una empresa primero.", true); return; }
  const { data, error } = await sb.from("equipos").select("*").eq("empresa_id", empresaInvActual).order("created_at");
  if (error) { toast("Error al exportar: " + error.message, true); return; }
  const nombreEmpresa = empresas.find((e) => e.id === empresaInvActual)?.nombre || "empresa";

  const filas = (data || []).map((r) => ({
    Fecha: fmtFecha(r.created_at), "Tipo de Equipo": r.tipo_equipo, "Nombre de red": r.nombre_red,
    Sitio: r.sitio, Responsable: r.responsable, Referencia: r.referencia, Serial: r.serial,
    Procesador: r.procesador, "Memoria RAM": r.memoria_ram, "Tipo de memoria": r.tipo_memoria,
    "Disco duro": r.disco_duro, "Tipo de disco": r.tipo_disco, "Sistema operativo": r.licencia_so,
    "Tipo de licencia": r.tipo_licencia, Comentarios: r.comentarios, "Registrado por": r.registrado_por,
  }));
  exportarExcel(filas, `Inventario - ${nombreEmpresa}.xlsx`, "Inventario");
});

// ------------------------------------------------------------
// Credenciales de empresas (visibles para todo el equipo; solo el
// admin puede borrarlas)
// ------------------------------------------------------------

$("credEmpresaSelect").addEventListener("change", async (e) => {
  empresaCredActual = e.target.value || null;
  await cargarCredenciales();
});

$("btnGuardarCredencial").addEventListener("click", async () => {
  $("credencialError").textContent = "";
  if (!empresaCredActual) { $("credencialError").textContent = "Selecciona una empresa primero."; return; }
  const servicio = $("credServicio").value.trim();
  if (!servicio) { $("credencialError").textContent = "Indica a qué servicio pertenece (ej: correo, router)."; return; }

  const { error } = await sb.from("credenciales").insert({
    empresa_id: empresaCredActual,
    servicio,
    usuario: $("credUsuario").value.trim(),
    password: $("credPassword").value,
    notas: $("credNotas").value.trim(),
  });
  if (error) { $("credencialError").textContent = "Error al guardar: " + error.message; return; }

  $("credServicio").value = ""; $("credUsuario").value = ""; $("credPassword").value = ""; $("credNotas").value = "";
  toast("Credencial guardada.");
  await cargarCredenciales();
  await cargarEmpresas();
});

async function cargarCredenciales() {
  const tbody = $("tablaCredenciales");
  tbody.innerHTML = "";
  if (!empresaCredActual) { $("credencialesEmpty").style.display = "block"; $("credencialesEmpty").textContent = "Selecciona una empresa arriba."; return; }

  const { data, error } = await sb
    .from("credenciales").select("*")
    .eq("empresa_id", empresaCredActual)
    .order("created_at", { ascending: false });

  if (error) { toast("Error al cargar credenciales: " + error.message, true); return; }

  $("credencialesEmpty").style.display = (data && data.length) ? "none" : "block";
  $("credencialesEmpty").textContent = "Sin credenciales para esta empresa todavía.";

  (data || []).forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.servicio)}</td><td>${escapeHtml(r.usuario)}</td>
      <td class="pw-cell">
        <span class="pw-value" data-pw-hidden="${escapeAttr(r.password || "")}">••••••••</span>
        <button class="reveal-btn" data-toggle-pw>ver</button>
      </td>
      <td>${escapeHtml(r.notas)}</td>
      <td class="actions-cell">${perfil.rol === "admin" ? `<button class="icon-btn danger" data-borrar-cred="${r.id}">Borrar</button>` : ""}</td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-toggle-pw]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const span = btn.previousElementSibling;
      const shown = span.dataset.shown === "1";
      span.textContent = shown ? "••••••••" : (span.dataset.pwHidden || "(vacía)");
      span.dataset.shown = shown ? "0" : "1";
      btn.textContent = shown ? "ver" : "ocultar";
    });
  });

  document.querySelectorAll("[data-borrar-cred]").forEach((b) => {
    b.addEventListener("click", async () => {
      const { error } = await sb.from("credenciales").delete().eq("id", b.dataset.borrarCred);
      if (error) { toast("Error al borrar: " + error.message, true); return; }
      await cargarCredenciales();
      await cargarEmpresas();
    });
  });
}

$("btnExportarCredenciales").addEventListener("click", async () => {
  if (!empresaCredActual) { toast("Selecciona una empresa primero.", true); return; }
  const { data, error } = await sb.from("credenciales").select("*").eq("empresa_id", empresaCredActual).order("created_at");
  if (error) { toast("Error al exportar: " + error.message, true); return; }
  const nombreEmpresa = empresas.find((e) => e.id === empresaCredActual)?.nombre || "empresa";

  const filas = (data || []).map((r) => ({
    Servicio: r.servicio, Usuario: r.usuario, Contraseña: r.password, Notas: r.notas,
  }));
  exportarExcel(filas, `Credenciales - ${nombreEmpresa}.xlsx`, "Credenciales");
});

// ------------------------------------------------------------
// Monitoreo (WAN/LAN en tiempo real vía MikroTik, por empresa).
// "Verificar ahora" llama a la Edge Function "mikrotik-estado", que se
// conecta al router desde el servidor (nunca desde el navegador) y
// devuelve el estado. Configurar el router (solo admin) usa la Edge
// Function "mikrotik-config" — la contraseña del router jamás se puede
// leer de vuelta desde la app, solo reemplazar.
// ------------------------------------------------------------

let empresaMonitoreoActual = null;
let routerEditandoId = null;

$("monEmpresaSelect").addEventListener("change", async (e) => {
  empresaMonitoreoActual = e.target.value || null;
  $("monResultado").innerHTML = "";
  $("monMensaje").style.display = "block";
  $("monMensaje").textContent = empresaMonitoreoActual ? "Da clic en \"Verificar ahora\" para ver el estado." : "Selecciona una empresa arriba.";

  if (perfil.rol === "admin") {
    $("monConfigCard").style.display = empresaMonitoreoActual ? "block" : "none";
    cancelarEdicionRouter();
    if (empresaMonitoreoActual) await cargarRoutersConfigurados();
  }
});

$("btnVerificarMonitoreo").addEventListener("click", async () => {
  if (!empresaMonitoreoActual) { toast("Selecciona una empresa primero.", true); return; }

  $("btnVerificarMonitoreo").disabled = true;
  $("btnVerificarMonitoreo").textContent = "Verificando…";
  $("monMensaje").style.display = "none";
  $("monResultado").innerHTML = "";

  const { data, error } = await sb.functions.invoke("mikrotik-estado", {
    body: { empresa_id: empresaMonitoreoActual },
  });

  $("btnVerificarMonitoreo").disabled = false;
  $("btnVerificarMonitoreo").textContent = "Verificar ahora";

  if (error || data?.error) {
    $("monMensaje").style.display = "block";
    $("monMensaje").textContent = "Error: " + (data?.error || error.message);
    return;
  }

  if (!data.routers || data.routers.length === 0) {
    $("monMensaje").style.display = "block";
    $("monMensaje").textContent = "Esta empresa todavía no tiene un router MikroTik configurado.";
    return;
  }

  $("monResultado").innerHTML = data.routers.map(pintarRouterEstado).join("");
});

function formatBps(bps) {
  if (bps === null || bps === undefined) return "—";
  if (bps >= 1000000) return (bps / 1000000).toFixed(1) + " Mbps";
  if (bps >= 1000) return (bps / 1000).toFixed(0) + " Kbps";
  return bps + " bps";
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(1) + " GB";
  return mb.toFixed(0) + " MB";
}

function pintarInterfaz(titulo, info) {
  if (!info) return `<div class="mon-row"><span>${titulo}</span><span class="pill pill-bad">No configurada</span></div>`;
  if (info.error) return `<div class="mon-row"><span>${titulo}</span><span class="pill pill-bad">${escapeHtml(info.error)}</span></div>`;
  const activa = info.activa && !info.deshabilitada;
  const estado = info.deshabilitada ? "Deshabilitada" : (activa ? "Activa" : "Caída");
  const ip = info.ip ? ` <span class="mon-if-name">· ${escapeHtml(info.ip)}</span>` : "";
  return `
    <div class="mon-row">
      <span>${titulo} <span class="mon-if-name">(${escapeHtml(info.interfaz)})</span>${ip}</span>
      <span class="pill ${activa ? "pill-ok" : "pill-bad"}">${estado}</span>
      <span class="mon-speed">↓ ${formatBps(info.rx_bps)} · ↑ ${formatBps(info.tx_bps)}</span>
    </div>`;
}

function pintarInterfazFila(i) {
  const estado = i.deshabilitada ? "Deshabilitada" : (i.activa ? "Activa" : "Caída");
  const clase = i.deshabilitada ? "pill-bad" : (i.activa ? "pill-ok" : "pill-bad");
  const velocidad = i.deshabilitada ? "" : `↓ ${formatBps(i.rx_bps)} · ↑ ${formatBps(i.tx_bps)}`;
  const esVlan = i.tipo === "vlan";
  const detalleVlan = esVlan ? ` <span class="mon-if-name">· VLAN ${escapeHtml(i.vlan_id || "?")} sobre ${escapeHtml(i.vlan_padre || "?")}</span>` : "";
  return `
    <div class="mon-row">
      <span>${esVlan ? "📶 " : ""}${escapeHtml(i.nombre)} <span class="mon-if-name">(${escapeHtml(i.tipo || "?")})</span>${detalleVlan}</span>
      <span class="pill ${clase}">${estado}</span>
      <span class="mon-speed">${velocidad}</span>
    </div>`;
}

function pintarDiagnostico(diagnostico, logs) {
  const items = diagnostico || [];
  if (items.length === 0) {
    return `<div class="stat-label" style="margin:18px 0 4px;">Diagnóstico</div><div class="diag-ok">✓ No se detectaron problemas.</div>`;
  }
  const filas = items.map((d) => {
    const clase = d.nivel === "alerta" ? "pill-bad" : "pill-warn";
    const icono = d.nivel === "alerta" ? "⛔" : "⚠️";
    return `
      <div class="diag-row">
        <span class="pill ${clase}">${icono}</span>
        <span class="diag-msg">${escapeHtml(d.mensaje)}</span>
      </div>`;
  }).join("");
  return `<div class="stat-label" style="margin:18px 0 4px;">Diagnóstico (${items.length})</div>${filas}`;
}

function pintarRouterEstado(r) {
  if (!r.conectado) {
    return `
      <div class="card mon-card">
        <h3>${escapeHtml(r.nombre)} <span class="pill pill-bad">Sin conexión</span></h3>
        <div class="error-msg" style="margin-top:0;">${escapeHtml(r.error || "No se pudo conectar al router.")}</div>
      </div>`;
  }
  const dispositivos = r.dispositivos_conectados >= 0 ? r.dispositivos_conectados : "No disponible";
  const sis = r.sistema;
  const infoSistema = sis ? `
    <div class="mon-row"><span>Equipo</span><span>${escapeHtml(sis.modelo || "—")} · RouterOS ${escapeHtml(sis.version || "—")}</span></div>
    <div class="mon-row"><span>Encendido hace</span><span>${escapeHtml(sis.uptime || "—")}</span></div>
    <div class="mon-row"><span>CPU / RAM libre</span><span>${sis.cpu_carga ?? "—"}% · ${formatBytes(sis.memoria_libre)} de ${formatBytes(sis.memoria_total)}</span></div>
  ` : "";
  const salud = r.salud || {};
  const infoSalud = (salud.temperature || salud.voltage) ? `
    <div class="mon-row"><span>Temperatura / Voltaje</span><span>${salud.temperature ? salud.temperature + " °C" : "—"} · ${salud.voltage ? salud.voltage + " V" : "—"}</span></div>
  ` : "";
  const interfacesLista = (r.interfaces || []).map(pintarInterfazFila).join("");
  const diagnosticoHtml = pintarDiagnostico(r.diagnostico, r.logs);

  return `
    <div class="card mon-card">
      <h3>${escapeHtml(r.nombre)}${r.identidad ? ` <span class="mon-if-name">(${escapeHtml(r.identidad)})</span>` : ""} <span class="pill pill-ok">En línea</span></h3>
      ${infoSistema}
      ${infoSalud}
      ${pintarInterfaz("WAN", r.wan)}
      ${pintarInterfaz("LAN", r.lan)}
      <div class="mon-row"><span>Dispositivos conectados (DHCP)</span><span class="pill">${dispositivos}</span></div>
      ${diagnosticoHtml}
      <div class="stat-label" style="margin:18px 0 4px;">Todas las interfaces</div>
      ${interfacesLista}
    </div>`;
}

// ---- Configurar routers MikroTik (solo admin) ----

$("btnGuardarRouter").addEventListener("click", async () => {
  $("routerError").textContent = "";
  if (!empresaMonitoreoActual) { $("routerError").textContent = "Selecciona una empresa arriba."; return; }

  const host = $("routerHost").value.trim();
  const usuario = $("routerUsuario").value.trim();
  const password = $("routerPassword").value;

  if (!host) { $("routerError").textContent = "Escribe la IP o dominio del router."; return; }
  if (!usuario) { $("routerError").textContent = "Escribe el usuario del router."; return; }
  if (!routerEditandoId && !password) { $("routerError").textContent = "Escribe la contraseña del router."; return; }

  const cuerpo = {
    accion: "guardar",
    id: routerEditandoId || undefined,
    empresa_id: empresaMonitoreoActual,
    nombre: $("routerNombre").value.trim() || "Router principal",
    host,
    puerto: $("routerPuerto").value.trim() || "8728",
    usuario,
    password,
    ssl: $("routerSsl").checked,
    wan_interface: $("routerWan").value.trim() || "ether1",
    lan_interface: $("routerLan").value.trim() || "bridge",
  };

  $("btnGuardarRouter").disabled = true;
  const { data, error } = await sb.functions.invoke("mikrotik-config", { body: cuerpo });
  $("btnGuardarRouter").disabled = false;

  if (error || data?.error) {
    $("routerError").textContent = "Error: " + (data?.error || error.message);
    return;
  }

  toast(routerEditandoId ? "Router actualizado." : "Router guardado.");
  cancelarEdicionRouter();
  await cargarRoutersConfigurados();
});

$("btnCancelarEdicionRouter").addEventListener("click", cancelarEdicionRouter);

function cancelarEdicionRouter() {
  routerEditandoId = null;
  $("routerNombre").value = "Router principal";
  $("routerHost").value = "";
  $("routerPuerto").value = "8728";
  $("routerUsuario").value = "";
  $("routerPassword").value = "";
  $("routerPassword").placeholder = "Contraseña del router";
  $("routerSsl").checked = false;
  $("routerWan").value = "ether1";
  $("routerLan").value = "bridge";
  $("routerFormTitulo").textContent = "Agregar router";
  $("btnGuardarRouter").textContent = "Guardar router";
  $("btnCancelarEdicionRouter").style.display = "none";
  $("routerError").textContent = "";
}

async function cargarRoutersConfigurados() {
  const tbody = $("tablaRouters");
  if (!tbody) return;
  tbody.innerHTML = "";

  const { data, error } = await sb.functions.invoke("mikrotik-config", {
    body: { accion: "listar", empresa_id: empresaMonitoreoActual },
  });

  if (error || data?.error) { toast("Error al cargar routers: " + (data?.error || error.message), true); return; }

  const routers = data.routers || [];
  $("routersEmpty").style.display = routers.length ? "none" : "block";

  routers.forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.nombre)}</td>
      <td>${escapeHtml(r.host)}:${escapeHtml(String(r.puerto))}</td>
      <td>${escapeHtml(r.wan_interface)} / ${escapeHtml(r.lan_interface)}</td>
      <td class="actions-cell">
        <button class="icon-btn" data-editar-router="${r.id}">Editar</button>
        <button class="icon-btn danger" data-borrar-router="${r.id}">Eliminar</button>
      </td>`;
    tbody.appendChild(tr);
    tr.dataset.routerJson = JSON.stringify(r);
  });

  tbody.querySelectorAll("[data-editar-router]").forEach((b) => {
    b.addEventListener("click", () => {
      const r = JSON.parse(b.closest("tr").dataset.routerJson);
      routerEditandoId = r.id;
      $("routerNombre").value = r.nombre || "";
      $("routerHost").value = r.host || "";
      $("routerPuerto").value = r.puerto || 8728;
      $("routerUsuario").value = r.usuario || "";
      $("routerPassword").value = "";
      $("routerPassword").placeholder = "Deja en blanco para no cambiarla";
      $("routerSsl").checked = !!r.ssl;
      $("routerWan").value = r.wan_interface || "ether1";
      $("routerLan").value = r.lan_interface || "bridge";
      $("routerFormTitulo").textContent = "Editar router";
      $("btnGuardarRouter").textContent = "Guardar cambios";
      $("btnCancelarEdicionRouter").style.display = "inline-block";
      $("routerError").textContent = "";
    });
  });

  tbody.querySelectorAll("[data-borrar-router]").forEach((b) => {
    b.addEventListener("click", async () => {
      if (!confirm("¿Eliminar este router?")) return;
      const { data: delData, error: delError } = await sb.functions.invoke("mikrotik-config", {
        body: { accion: "eliminar", id: b.dataset.borrarRouter },
      });
      if (delError || delData?.error) { toast("Error al eliminar: " + (delData?.error || delError.message), true); return; }
      toast("Router eliminado.");
      cancelarEdicionRouter();
      await cargarRoutersConfigurados();
    });
  });
}

// ------------------------------------------------------------
// Equipo (solo admin): crear, editar y eliminar colaboradores sin
// salir de la app. Llama a las Edge Functions "crear-usuario" y
// "gestionar-usuario", que corren en el servidor de Supabase con
// la llave secreta — esa llave nunca llega al navegador.
// ------------------------------------------------------------

let usuarioEditandoId = null;

$("btnCrearUsuario").addEventListener("click", async () => {
  $("usuarioError").textContent = "";

  // ---- Modo edición: guardar cambios de un usuario existente ----
  if (usuarioEditandoId) {
    const nombre = $("nuevoNombre").value.trim();
    const password = $("nuevoPassword").value.trim();
    const rol = $("nuevoRol").value;

    if (password && password.length < 6) {
      $("usuarioError").textContent = "La contraseña debe tener al menos 6 caracteres.";
      return;
    }

    $("btnCrearUsuario").disabled = true;
    const { data, error } = await sb.functions.invoke("gestionar-usuario", {
      body: { accion: "editar", userId: usuarioEditandoId, nombre, rol, password },
    });
    $("btnCrearUsuario").disabled = false;

    if (error || data?.error) {
      $("usuarioError").textContent = "Error: " + (data?.error || error.message);
      return;
    }

    toast("Usuario actualizado.");
    cancelarEdicionUsuario();
    await cargarUsuarios();
    return;
  }

  // ---- Modo crear: usuario nuevo ----
  const usuario = $("nuevoUsuario").value.trim();
  const nombre = $("nuevoNombre").value.trim() || usuario;
  const password = $("nuevoPassword").value.trim();
  const rol = $("nuevoRol").value;

  if (!usuario) { $("usuarioError").textContent = "Escribe un usuario."; return; }
  if (password.length < 6) { $("usuarioError").textContent = "La contraseña debe tener al menos 6 caracteres."; return; }

  $("btnCrearUsuario").disabled = true;
  const { data, error } = await sb.functions.invoke("crear-usuario", {
    body: { usuario, nombre, password, rol, dominio: USUARIO_DOMINIO },
  });
  $("btnCrearUsuario").disabled = false;

  if (error || data?.error) {
    $("usuarioError").textContent = "Error: " + (data?.error || error.message);
    return;
  }

  $("nuevoUsuario").value = ""; $("nuevoNombre").value = ""; $("nuevoPassword").value = "";
  $("nuevoRol").value = "tecnico";
  toast("Usuario creado: " + data.email);
  await cargarUsuarios();
});

$("btnCancelarEdicionUsuario").addEventListener("click", cancelarEdicionUsuario);

function iniciarEdicionUsuario(id, nombre, rol) {
  usuarioEditandoId = id;
  $("nuevoUsuario").value = "";
  $("nuevoUsuario").disabled = true;
  $("nuevoUsuario").placeholder = "No se puede cambiar aquí";
  $("nuevoNombre").value = nombre || "";
  $("nuevoPassword").value = "";
  $("nuevoPassword").placeholder = "Deja en blanco para no cambiarla";
  $("nuevoRol").value = rol === "admin" ? "admin" : "tecnico";
  $("usuarioFormTitulo").textContent = "Editar usuario";
  $("btnCrearUsuario").textContent = "Guardar cambios";
  $("btnCancelarEdicionUsuario").style.display = "inline-block";
  $("usuarioError").textContent = "";
  $("view-equipo").scrollIntoView({ behavior: "smooth", block: "start" });
}

function cancelarEdicionUsuario() {
  usuarioEditandoId = null;
  $("nuevoUsuario").disabled = false;
  $("nuevoUsuario").placeholder = "Ej: maria.perez";
  $("nuevoUsuario").value = "";
  $("nuevoNombre").value = "";
  $("nuevoPassword").value = "";
  $("nuevoPassword").placeholder = "Mínimo 6 caracteres";
  $("nuevoRol").value = "tecnico";
  $("usuarioFormTitulo").textContent = "Crear usuario nuevo";
  $("btnCrearUsuario").textContent = "Crear usuario";
  $("btnCancelarEdicionUsuario").style.display = "none";
  $("usuarioError").textContent = "";
}

async function eliminarUsuario(id) {
  if (!confirm("¿Eliminar este usuario? Esta acción no se puede deshacer.")) return;

  const { data, error } = await sb.functions.invoke("gestionar-usuario", {
    body: { accion: "eliminar", userId: id },
  });

  if (error || data?.error) {
    toast("Error al eliminar: " + (data?.error || error.message), true);
    return;
  }

  if (usuarioEditandoId === id) cancelarEdicionUsuario();
  toast("Usuario eliminado.");
  await cargarUsuarios();
}

async function cargarUsuarios() {
  const tbody = $("tablaUsuarios");
  if (!tbody) return;
  tbody.innerHTML = "";

  const { data, error } = await sb
    .from("usuarios_perfil")
    .select("id, nombre, rol")
    .order("nombre");

  if (error) { toast("Error al cargar usuarios: " + error.message, true); return; }

  $("usuariosEmpty").style.display = (data && data.length) ? "none" : "block";

  (data || []).forEach((r) => {
    const esYo = sesion && r.id === sesion.user.id;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.nombre)}</td>
      <td><span class="pill">${r.rol === "admin" ? "Administrador" : "Técnico"}</span></td>
      <td class="actions-cell">
        <button class="icon-btn" data-editar-usuario="${r.id}" data-nombre="${escapeAttr(r.nombre || "")}" data-rol="${r.rol}">Editar</button>
        ${esYo ? "" : `<button class="icon-btn danger" data-borrar-usuario="${r.id}">Eliminar</button>`}
      </td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-editar-usuario]").forEach((b) => {
    b.addEventListener("click", () => {
      iniciarEdicionUsuario(b.dataset.editarUsuario, b.dataset.nombre, b.dataset.rol);
    });
  });

  tbody.querySelectorAll("[data-borrar-usuario]").forEach((b) => {
    b.addEventListener("click", () => eliminarUsuario(b.dataset.borrarUsuario));
  });
}

// ------------------------------------------------------------
// Personal (privado por usuario — nadie más lo ve, ni el admin)
// ------------------------------------------------------------

$("btnGuardarNombrePersonal").addEventListener("click", async () => {
  const nombre = $("personalNombre").value.trim();
  if (!nombre) { toast("Escribe un nombre para tu apartado.", true); return; }
  const { error } = await sb.from("usuarios_perfil").update({ nombre }).eq("id", sesion.user.id);
  if (error) { toast("Error al guardar: " + error.message, true); return; }
  perfil.nombre = nombre;
  const etiqueta = nombre.toUpperCase() + " PERSONAL";
  $("navPersonalLabel").textContent = etiqueta;
  $("personalTitulo").textContent = etiqueta;
  toast("Nombre guardado.");
});

$("btnGuardarPersonal").addEventListener("click", async () => {
  $("personalError").textContent = "";
  const servicio = $("persServicio").value.trim();
  if (!servicio) { $("personalError").textContent = "Indica a qué servicio pertenece (ej: correo personal)."; return; }

  const { error } = await sb.from("credenciales_personales").insert({
    user_id: sesion.user.id,
    servicio,
    usuario: $("persUsuario").value.trim(),
    password: $("persPassword").value,
    notas: $("persNotas").value.trim(),
  });
  if (error) { $("personalError").textContent = "Error al guardar: " + error.message; return; }

  $("persServicio").value = ""; $("persUsuario").value = ""; $("persPassword").value = ""; $("persNotas").value = "";
  toast("Guardado.");
  await cargarPersonal();
});

async function cargarPersonal() {
  const tbody = $("tablaPersonal");
  tbody.innerHTML = "";

  const { data, error } = await sb
    .from("credenciales_personales").select("*")
    .eq("user_id", sesion.user.id)
    .order("created_at", { ascending: false });

  if (error) { toast("Error al cargar tus contraseñas: " + error.message, true); return; }

  $("personalEmpty").style.display = (data && data.length) ? "none" : "block";

  (data || []).forEach((r) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.servicio)}</td><td>${escapeHtml(r.usuario)}</td>
      <td class="pw-cell">
        <span class="pw-value" data-pw-hidden="${escapeAttr(r.password || "")}">••••••••</span>
        <button class="reveal-btn" data-toggle-pw>ver</button>
      </td>
      <td>${escapeHtml(r.notas)}</td>
      <td class="actions-cell"><button class="icon-btn danger" data-borrar-personal="${r.id}">Borrar</button></td>`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-toggle-pw]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const span = btn.previousElementSibling;
      const shown = span.dataset.shown === "1";
      span.textContent = shown ? "••••••••" : (span.dataset.pwHidden || "(vacía)");
      span.dataset.shown = shown ? "0" : "1";
      btn.textContent = shown ? "ver" : "ocultar";
    });
  });

  document.querySelectorAll("[data-borrar-personal]").forEach((b) => {
    b.addEventListener("click", async () => {
      const { error } = await sb.from("credenciales_personales").delete().eq("id", b.dataset.borrarPersonal);
      if (error) { toast("Error al borrar: " + error.message, true); return; }
      await cargarPersonal();
    });
  });
}

// ------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------

function exportarExcel(filas, nombreArchivo, hoja) {
  if (!filas.length) { toast("No hay datos para exportar todavía.", true); return; }
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, hoja);
  XLSX.writeFile(wb, nombreArchivo);
}

function fmtFecha(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("es-CO", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, "&quot;"); }

init();
