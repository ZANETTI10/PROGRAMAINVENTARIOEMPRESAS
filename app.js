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
// Equipo (solo admin): crear colaboradores sin salir de la app.
// Llama a la Edge Function "crear-usuario", que corre en el
// servidor de Supabase con la llave secreta — esa llave nunca
// llega al navegador.
// ------------------------------------------------------------

$("btnCrearUsuario").addEventListener("click", async () => {
  $("usuarioError").textContent = "";
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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.nombre)}</td>
      <td><span class="pill">${r.rol === "admin" ? "Administrador" : "Técnico"}</span></td>`;
    tbody.appendChild(tr);
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
