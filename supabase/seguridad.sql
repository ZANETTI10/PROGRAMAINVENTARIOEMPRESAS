-- ============================================================
-- Helpdesk TI - modulo de seguridad y rendimiento
-- ------------------------------------------------------------
-- Se corre UNA sola vez en Supabase -> SQL Editor (es seguro volver a
-- correrlo: no borra nada). Agrega lo que necesita la consola de
-- seguridad y la ficha del equipo:
--   - en "equipos": lo que el agente reporta de seguridad y de
--     rendimiento, y el semaforo ya calculado;
--   - la tabla "equipos_amenazas": una fila por cada deteccion del
--     antivirus;
--   - en "empresas": el interruptor de la respuesta automatica;
--   - las acciones remotas nuevas (analisis, firmas, etc.).
-- ============================================================

alter table public.equipos
  add column if not exists seguridad jsonb,
  add column if not exists seguridad_nivel text,
  add column if not exists seguridad_actualizado_en timestamptz,
  add column if not exists rendimiento jsonb,
  add column if not exists agente_version text;

alter table public.equipos drop constraint if exists equipos_seguridad_nivel_check;
alter table public.equipos add constraint equipos_seguridad_nivel_check
  check (seguridad_nivel is null or seguridad_nivel in ('protegido', 'advertencia', 'riesgo'));

alter table public.empresas
  add column if not exists seguridad_auto boolean not null default true;

create table if not exists public.equipos_amenazas (
  id uuid primary key default gen_random_uuid(),
  equipo_id uuid not null references public.equipos(id) on delete cascade,
  deteccion_id text not null,
  nombre text,
  severidad text,
  estado text,
  resuelta boolean not null default false,
  recurso text,
  detectado_en timestamptz,
  created_at timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (equipo_id, deteccion_id)
);
create index if not exists equipos_amenazas_equipo_idx
  on public.equipos_amenazas (equipo_id, detectado_en desc);

alter table public.equipos_amenazas enable row level security;

-- Las amenazas las escribe solo el agente (por la Edge Function, con la
-- llave de servicio). Desde la app se pueden ver; borrar, solo el admin.
drop policy if exists equipos_amenazas_select on public.equipos_amenazas;
create policy equipos_amenazas_select on public.equipos_amenazas
  for select using (auth.role() = 'authenticated');

drop policy if exists equipos_amenazas_delete on public.equipos_amenazas;
create policy equipos_amenazas_delete on public.equipos_amenazas
  for delete using (public.is_admin());

alter table public.equipos_comandos drop constraint if exists equipos_comandos_accion_check;
alter table public.equipos_comandos add constraint equipos_comandos_accion_check
  check (accion in (
    'liberar_memoria', 'limpiar_temporales', 'reiniciar_explorer', 'reiniciar_equipo', 'script_personalizado',
    'analisis_rapido', 'analisis_completo', 'actualizar_firmas', 'activar_proteccion', 'eliminar_amenazas'
  ));
