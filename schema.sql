-- ============================================================
-- Helpdesk TI — esquema de base de datos para Supabase
-- ============================================================
-- Cómo usar: entra a tu proyecto de Supabase -> "SQL Editor" ->
-- "New query" -> pega TODO este archivo -> Run. Se puede correr
-- una sola vez (crea tablas, seguridad y el disparador de usuarios
-- nuevos).
-- ============================================================

-- Empresas (clientes)
create table if not exists empresas (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  created_at timestamptz default now()
);

-- Perfil de cada usuario que inicia sesión (técnico o admin)
create table if not exists usuarios_perfil (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text,
  rol text not null default 'tecnico' check (rol in ('admin','tecnico')),
  created_at timestamptz default now()
);

-- Inventario de equipos
create table if not exists equipos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  tipo_equipo text,
  nombre_red text,
  sitio text,
  responsable text,
  referencia text,
  serial text,
  procesador text,
  memoria_ram text,
  tipo_memoria text,
  disco_duro text,
  tipo_disco text,
  licencia_so text,
  tipo_licencia text,
  comentarios text,
  registrado_por text,
  created_at timestamptz default now()
);

-- Contraseñas / credenciales administrativas por empresa (visibles para
-- cualquier usuario logueado — técnicos incluidos).
create table if not exists credenciales (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  servicio text not null,   -- ej: "Correo administrativo", "Router principal", "cPanel"
  usuario text,
  password text,
  notas text,
  created_at timestamptz default now()
);

-- Contraseñas PERSONALES: cada usuario tiene las suyas, privadas —
-- nadie más las ve, ni siquiera el admin.
create table if not exists credenciales_personales (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  servicio text not null,
  usuario text,
  password text,
  notas text,
  created_at timestamptz default now()
);

-- ------------------------------------------------------------
-- Seguridad (Row Level Security): solo usuarios que iniciaron
-- sesión pueden leer/escribir, y solo el ADMIN puede ver o tocar
-- las contraseñas.
-- ------------------------------------------------------------

alter table empresas enable row level security;
alter table usuarios_perfil enable row level security;
alter table equipos enable row level security;
alter table credenciales enable row level security;
alter table credenciales_personales enable row level security;

create or replace function is_admin() returns boolean as $$
  select exists (
    select 1 from usuarios_perfil where id = auth.uid() and rol = 'admin'
  );
$$ language sql security definer;

-- Empresas: cualquier usuario logueado puede ver la lista;
-- solo el admin agrega/edita/borra empresas.
drop policy if exists empresas_select on empresas;
create policy empresas_select on empresas for select
  using (auth.role() = 'authenticated');

drop policy if exists empresas_write on empresas;
create policy empresas_write on empresas for all
  using (is_admin()) with check (is_admin());

-- Perfil: cada quien ve (y edita) su propio perfil; el admin ve todos.
drop policy if exists perfil_select on usuarios_perfil;
create policy perfil_select on usuarios_perfil for select
  using (auth.uid() = id or is_admin());

drop policy if exists perfil_update on usuarios_perfil;
create policy perfil_update on usuarios_perfil for update
  using (auth.uid() = id);

-- Equipos: cualquier usuario logueado puede ver y agregar;
-- solo el admin puede borrar.
drop policy if exists equipos_select on equipos;
create policy equipos_select on equipos for select
  using (auth.role() = 'authenticated');

drop policy if exists equipos_insert on equipos;
create policy equipos_insert on equipos for insert
  with check (auth.role() = 'authenticated');

drop policy if exists equipos_delete on equipos;
create policy equipos_delete on equipos for delete
  using (is_admin());

-- Credenciales de empresas: cualquier usuario logueado puede ver y
-- agregar (correo, routers, etc. de los clientes); solo el admin borra.
drop policy if exists credenciales_all on credenciales;
drop policy if exists credenciales_select on credenciales;
drop policy if exists credenciales_insert on credenciales;
drop policy if exists credenciales_delete on credenciales;

create policy credenciales_select on credenciales for select
  using (auth.role() = 'authenticated');

create policy credenciales_insert on credenciales for insert
  with check (auth.role() = 'authenticated');

create policy credenciales_delete on credenciales for delete
  using (is_admin());

-- Credenciales PERSONALES: cada quien ve y administra únicamente las
-- suyas. Ni otros técnicos ni el admin pueden verlas.
drop policy if exists credenciales_personales_all on credenciales_personales;
create policy credenciales_personales_all on credenciales_personales for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- Cuando alguien inicia sesión por primera vez (usuario creado
-- desde Authentication -> Users), se le crea automáticamente un
-- perfil con rol "tecnico". Tú (el dueño) debes entrar luego a
-- Table Editor -> usuarios_perfil y cambiar tu propia fila a
-- rol = 'admin' para ver las contraseñas.
-- ------------------------------------------------------------

create or replace function public.handle_new_user() returns trigger as $$
begin
  insert into public.usuarios_perfil (id, nombre, rol)
  values (new.id, coalesce(new.raw_user_meta_data->>'nombre', new.email), 'tecnico')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ------------------------------------------------------------
-- Monitoreo MikroTik: routers por empresa, para ver el estado de
-- WAN/LAN en tiempo real desde la pestaña "Monitoreo".
--
-- A propósito esta tabla NO tiene ninguna política de seguridad
-- (RLS activado pero sin policies): así nadie puede leer ni escribir
-- aquí directo desde el navegador, ni siquiera el admin con su sesión
-- normal — incluida la contraseña del router. Solo las Edge Functions
-- (que usan la llave secreta "service_role") pueden tocar esta tabla.
-- ------------------------------------------------------------
create table if not exists mikrotik_routers (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nombre text not null default 'Router principal',
  host text not null,
  puerto integer not null default 8728,
  usuario text not null,
  password text not null,
  ssl boolean not null default false,
  wan_interface text not null default 'ether1',
  lan_interface text not null default 'bridge',
  created_at timestamptz default now()
);

alter table mikrotik_routers enable row level security;

-- ------------------------------------------------------------
-- Auto-registro de equipos: el admin genera, por empresa, un "token"
-- de instalación desde la pestaña Inventario. Ese token se pega una
-- sola vez en el equipo del cliente (Windows o Mac) y de ahí en
-- adelante el equipo se anota (y se mantiene actualizado) solo en el
-- inventario, sin que haya que digitarlo a mano.
--
-- Igual que con mikrotik_routers: RLS activado pero con política solo
-- para el admin (para poder generarlos/verlos/desactivarlos desde la
-- app) — el equipo del cliente nunca ve ni usa esta tabla directo, le
-- llega el token una sola vez al instalar y de ahí en adelante solo
-- habla con la Edge Function "agente-inventario", que es la única que
-- valida tokens usando la llave "service_role".
-- ------------------------------------------------------------
create table if not exists equipos_tokens (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  token text not null unique,
  activo boolean not null default true,
  creado_por text,
  created_at timestamptz default now()
);

alter table equipos_tokens enable row level security;

drop policy if exists equipos_tokens_admin on equipos_tokens;
create policy equipos_tokens_admin on equipos_tokens for all
  using (is_admin()) with check (is_admin());

-- Columnas nuevas en equipos para distinguir lo agregado a mano de lo
-- que reporta el agente instalado, y saber cuándo fue la última vez
-- que un equipo "se conectó" (para detectar equipos que llevan tiempo
-- sin reportarse).
alter table equipos add column if not exists origen text not null default 'manual' check (origen in ('manual','agente'));
alter table equipos add column if not exists actualizado_en timestamptz;
