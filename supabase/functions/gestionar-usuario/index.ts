// ============================================================
// Edge Function: gestionar-usuario
// ------------------------------------------------------------
// Permite que el ADMINISTRADOR edite (nombre, rol, contraseña) o
// elimine cuentas de colaboradores desde dentro de la app.
//
// Por seguridad, esta función corre en el servidor de Supabase, no
// en el navegador: usa la llave "service_role" (secreta), y esa
// llave NUNCA se expone al cliente. Antes de hacer nada, verifica
// que quien está llamando ya tenga rol 'admin'.
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

    const { data: perfilCaller, error: perfilCallerError } = await admin
      .from("usuarios_perfil")
      .select("rol")
      .eq("id", callerData.user.id)
      .maybeSingle();

    if (perfilCallerError || perfilCaller?.rol !== "admin") {
      return json({ error: "Solo un administrador puede hacer esto." }, 403);
    }

    const body = await req.json();
    const accion = body.accion;
    const userId = body.userId;

    if (!userId) {
      return json({ error: "Falta indicar el usuario." }, 400);
    }

    // ---------------- Eliminar ----------------
    if (accion === "eliminar") {
      if (userId === callerData.user.id) {
        return json({ error: "No puedes eliminar tu propia cuenta." }, 400);
      }

      const { error: delError } = await admin.auth.admin.deleteUser(userId);
      if (delError) {
        return json({ error: delError.message }, 400);
      }
      // La fila en usuarios_perfil se borra sola (ON DELETE CASCADE).
      return json({ ok: true });
    }

    // ---------------- Editar ----------------
    if (accion === "editar") {
      const nombre = (body.nombre || "").trim();
      const rol = body.rol === "admin" ? "admin" : "tecnico";
      const password = (body.password || "").trim();

      if (userId === callerData.user.id && rol !== "admin") {
        return json({ error: "No puedes quitarte tu propio rol de administrador." }, 400);
      }

      if (password) {
        if (password.length < 6) {
          return json({ error: "La contraseña debe tener al menos 6 caracteres." }, 400);
        }
        const { error: pwError } = await admin.auth.admin.updateUser(userId, { password });
        if (pwError) {
          return json({ error: pwError.message }, 400);
        }
      }

      const cambios: Record<string, string> = { rol };
      if (nombre) cambios.nombre = nombre;

      const { error: updError } = await admin
        .from("usuarios_perfil")
        .update(cambios)
        .eq("id", userId);

      if (updError) {
        return json({ error: updError.message }, 400);
      }

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
