// ============================================================
// Configuración de Supabase
// ------------------------------------------------------------
// 1. Crea un proyecto gratis en https://supabase.com
// 2. Ve a Project Settings -> API
// 3. Copia "Project URL" y pégalo abajo en SUPABASE_URL
// 4. Copia la llave "anon public" y pégala abajo en SUPABASE_ANON_KEY
//    (esta llave es pública/segura de exponer en el navegador —
//    la seguridad real la dan las políticas RLS de schema.sql)
// ============================================================

const SUPABASE_URL = "https://jkeqpwzricshyibqyose.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZXFwd3pyaWNzaHlpYnF5b3NlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4OTEyMTYsImV4cCI6MjEwNDQ2NzIxNn0.PvylLQ1jhmMKyJZTj6EnwSrWcsXdMnUmOs9bhs9TXJA";

// Supabase exige que cada cuenta tenga formato de correo (algo@algo).
// Para que tú y tus colaboradores puedan escribir solo un nombre de
// usuario (ej. "santiago.agudelo") en vez de un correo completo, la app
// le agrega este dominio por detrás automáticamente. No tiene que ser un
// dominio real — nunca se envía correo a esta dirección.
const USUARIO_DOMINIO = "sag.local";
