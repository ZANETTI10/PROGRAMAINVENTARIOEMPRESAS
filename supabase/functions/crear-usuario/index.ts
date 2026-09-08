// ============================================================
// Edge Function: crear-usuario
// ------------------------------------------------------------
// Permite que el ADMINISTRADOR cree usuarios nuevos (colaboradores)
// desde dentro de la app, sin tener que entrar a Supabase.
//
// Por seguridad, esta función corre en el servidor de Supabase, no
// en el navegador: usa la llave "service_role" (secreta) para crear
// la cuenta, y esa llave NUNCA se expone al cliente. Antes de crear
// nada, verifica que quien está llamando ya tenga rol 'admin'.
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

    // Cliente con la llave de servicio (acceso total) — solo se usa
    // en el servidor, nunca llega al navegador.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1. Verificar quién llama y que sea admin.
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
      return json({ error: "Solo un administrador puede crear usuarios." }, 403);
    }

    // 2. Leer los datos del nuevo usuario.
    const body = await req.json();
    const usuario = (body.usuario || "").trim();
    const password = (body.password || "").trim();
    const nombre = (body.nombre || usuario).trim();
    const rol = body.rol === "admin" ? "admin" : "tecnico";
    const dominio = body.dominio || "sag.local";

    if (!usuario || !password) {
      return json({ error: "Falta el usuario o la contraseña." }, 400);
    }
    if (password.length < 6) {
      return json({ error: "La contraseña debe tener al menos 6 caracteres." }, 400);
    }

    const email = usuario.includes("@") ? usuario : `${usuario}@${dominio}`;

    // 3. Crear la cuenta (ya confirmada, lista para usar).
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { nombre },
    });

    if (createError) {
      return json({ error: createError.message }, 400);
    }

    // 4. Ajustar nombre y rol en usuarios_perfil (el trigger ya creó
    // la fila con rol 'tecnico' por defecto).
    if (created.user) {
      await admin
        .from("usuarios_perfil")
        .update({ nombre, rol })
        .eq("id", created.user.id);
    }

    return json({ ok: true, email });
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
