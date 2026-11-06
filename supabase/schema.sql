-- Módulo PYME: seguimiento de la cartera del equipo PYME (Nicaragua).
-- Tablas en el proyecto Supabase de Tiempos DAC, prefijo pyme_. Ejecutar una vez en el SQL Editor.
-- Requiere schema.sql de Tiempos DAC (dac_perfiles, dac_rol, dac_es_sql y el usuario "sistema" que hace la carga).
--
-- Perfiles:
--   admin     todo, incluida la administración de cualquier usuario
--   gerente   Gerente país: ve toda la cartera del equipo (con saldo y saldo pagaré)
--   jefe      Jefe del equipo: ve toda la cartera y administra el personal (agrega, activa/desactiva promotores)
--   promotor  ve solo los créditos que él colocó (sin saldo ni saldo pagaré)
-- Los promotores activos son los que entran en la consulta diaria: el equipo se administra desde la app.

-- ---------- Tablas ----------
create table if not exists public.pyme_perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  usuario text not null unique,          -- "alexander.antonio.jara" (correo interno usuario@tiemposdac.local)
  nombre text not null,
  rol text not null check (rol in ('admin','gerente','jefe','promotor')),
  cedula_promotor text unique check (cedula_promotor ~ '^[0-9A-Za-z]{4,20}$'),
  activo boolean not null default true,
  creado_por text,
  created_at timestamptz not null default now(),
  check (rol <> 'promotor' or cedula_promotor is not null)
);

-- Promotores de Nicaragua con colocaciones en los últimos 12 meses (lo carga el proceso; para elegir de una lista)
create table if not exists public.pyme_catalogo (
  cedula_promotor text primary key,
  promotor text,
  tipo_promotor text,
  ultima_solicitud date,
  solicitudes integer
);

-- Una fila por crédito. Datos personales (teléfonos, direcciones): solo los ve quien tiene acceso al crédito.
create table if not exists public.pyme_cartera (
  llave text primary key,                -- JAR_50131
  cedula_promotor text not null,
  promotor text,
  cedula text,
  nombre_cliente text,
  empresa_genesis text,
  cuotas_mora numeric,
  monto_cuota_mora numeric,
  cuotas_pagadas numeric,
  dias_mora_mc integer,
  fecha_desembolso date,
  total_pagado numeric,
  total_interes numeric,
  total_mora numeric,
  total_ocargos numeric,
  total_capital numeric,
  dias_mora integer,
  pct_amortizado numeric,
  tel_domicilio text,
  tel_negocio text,
  dir_domicilio text,
  dir_negocio text,
  nit text
);
create index if not exists pyme_cartera_promotor on public.pyme_cartera (cedula_promotor);

-- Saldo y saldo pagaré: solo jefe, gerente y administrador (los promotores no los ven)
create table if not exists public.pyme_saldos (
  llave text primary key,
  saldopagare numeric,
  saldo numeric
);

-- Bitácora de cargas (cada intento): para avisar en la app si los datos no son del día
create table if not exists public.pyme_cargas (
  id bigint generated always as identity primary key,
  inicio timestamptz not null default now(),
  fin timestamptz,
  estado text not null check (estado in ('ok','aviso','error')),
  intento integer,
  filas integer,
  mensaje text,
  fuentes jsonb
);

create table if not exists public.pyme_config (
  clave text primary key,
  valor jsonb
);

-- ---------- Funciones de rol ----------
create or replace function public.pyme_rol() returns text
language sql stable security definer set search_path = public as $$
  select rol from public.pyme_perfiles where id = auth.uid() and activo
$$;
create or replace function public.pyme_cedula() returns text
language sql stable security definer set search_path = public as $$
  select cedula_promotor from public.pyme_perfiles where id = auth.uid() and activo and rol = 'promotor'
$$;
create or replace function public.pyme_es_sistema() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.dac_rol() = 'sistema', false)
$$;
create or replace function public.pyme_ve_todo() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.pyme_rol() in ('admin','gerente','jefe'), false)
$$;

-- ---------- Seguridad por fila ----------
alter table public.pyme_perfiles enable row level security;
alter table public.pyme_catalogo enable row level security;
alter table public.pyme_cartera enable row level security;
alter table public.pyme_saldos enable row level security;
alter table public.pyme_cargas enable row level security;
alter table public.pyme_config enable row level security;

drop policy if exists leer on public.pyme_perfiles;
create policy leer on public.pyme_perfiles for select to authenticated
  using (id = auth.uid() or public.pyme_ve_todo() or public.pyme_es_sistema());

drop policy if exists leer on public.pyme_catalogo;
create policy leer on public.pyme_catalogo for select to authenticated
  using (public.pyme_rol() in ('admin','jefe'));

drop policy if exists leer on public.pyme_cartera;
create policy leer on public.pyme_cartera for select to authenticated
  using (public.pyme_ve_todo() or cedula_promotor = public.pyme_cedula());

drop policy if exists leer on public.pyme_saldos;
create policy leer on public.pyme_saldos for select to authenticated
  using (public.pyme_ve_todo());

drop policy if exists leer on public.pyme_cargas;
create policy leer on public.pyme_cargas for select to authenticated
  using (public.pyme_rol() is not null or public.pyme_es_sistema());

drop policy if exists leer on public.pyme_config;
create policy leer on public.pyme_config for select to authenticated
  using (public.pyme_rol() is not null or public.pyme_es_sistema());

-- Nadie escribe directo en las tablas: todo pasa por las funciones de abajo
revoke all on public.pyme_perfiles, public.pyme_catalogo, public.pyme_cartera, public.pyme_saldos,
  public.pyme_cargas, public.pyme_config from anon, authenticated;
grant select on public.pyme_perfiles, public.pyme_catalogo, public.pyme_cartera, public.pyme_saldos,
  public.pyme_cargas, public.pyme_config to authenticated;

-- ---------- Carga diaria (solo el proceso: usuario "sistema" de Tiempos DAC) ----------
-- Reemplaza la cartera completa. Si la carga trae 0 filas no se toca nada.
create or replace function public.pyme_cargar(p_cartera jsonb, p_saldos jsonb, p_info jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not (public.pyme_es_sistema() or public.pyme_rol() = 'admin') then
    raise exception 'Solo el proceso de carga puede actualizar los datos';
  end if;
  if coalesce(jsonb_array_length(p_cartera), 0) = 0 then
    raise exception 'La carga no trae créditos: no se reemplaza la cartera';
  end if;
  delete from public.pyme_cartera where true;
  delete from public.pyme_saldos where true;
  insert into public.pyme_cartera select * from jsonb_populate_recordset(null::public.pyme_cartera, p_cartera);
  get diagnostics n = row_count;
  insert into public.pyme_saldos select * from jsonb_populate_recordset(null::public.pyme_saldos, p_saldos);
  insert into public.pyme_config (clave, valor) values ('ultima_carga', p_info || jsonb_build_object('filas', n))
    on conflict (clave) do update set valor = excluded.valor;
  return n;
end $$;

create or replace function public.pyme_cargar_catalogo(p_filas jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not (public.pyme_es_sistema() or public.pyme_rol() = 'admin') then
    raise exception 'Solo el proceso de carga puede actualizar el catálogo';
  end if;
  if coalesce(jsonb_array_length(p_filas), 0) = 0 then return 0; end if;
  delete from public.pyme_catalogo where true;
  insert into public.pyme_catalogo select * from jsonb_populate_recordset(null::public.pyme_catalogo, p_filas);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.pyme_registrar_carga(p_inicio timestamptz, p_estado text, p_intento integer,
  p_filas integer, p_mensaje text, p_fuentes jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.pyme_es_sistema() or public.pyme_rol() = 'admin') then
    raise exception 'Solo el proceso de carga registra cargas';
  end if;
  insert into public.pyme_cargas (inicio, fin, estado, intento, filas, mensaje, fuentes)
  values (p_inicio, now(), p_estado, p_intento, p_filas, left(p_mensaje, 1000), p_fuentes);
  delete from public.pyme_cargas where inicio < now() - interval '60 days';
end $$;

-- ---------- Administración de personal ----------
-- admin: cualquier perfil. jefe: solo promotores. Desde el SQL Editor (dac_es_sql) también se puede.
-- Si la persona ya tiene usuario (p. ej. de Tiempos DAC o Auditores) solo se le da acceso y conserva su contraseña.
create or replace function public.pyme_crear_usuario(p_usuario text, p_nombre text, p_rol text, p_cedula text, p_password text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  uid uuid;
  u text := lower(trim(p_usuario));
  correo text := lower(trim(p_usuario)) || '@tiemposdac.local';
  ced text := nullif(upper(trim(coalesce(p_cedula, ''))), '');
begin
  if not (public.pyme_rol() = 'admin' or public.dac_es_sql() or (public.pyme_rol() = 'jefe' and p_rol = 'promotor')) then
    raise exception 'Solo el administrador puede crear este usuario (el jefe del equipo crea promotores)';
  end if;
  if u !~ '^[a-z0-9._-]+$' then raise exception 'Usuario inválido'; end if;
  if p_rol not in ('admin','gerente','jefe','promotor') then raise exception 'Perfil inválido'; end if;
  if p_rol = 'promotor' then
    if ced is null or ced !~ '^[0-9A-Z]{4,20}$' then raise exception 'Cédula del promotor inválida'; end if;
    if exists (select 1 from public.pyme_perfiles where cedula_promotor = ced) then
      raise exception 'Ese promotor ya está en el equipo (búsquelo en la lista y actívelo)';
    end if;
  else
    ced := null;
  end if;
  if exists (select 1 from public.pyme_perfiles where usuario = u) then raise exception 'Ese usuario ya existe'; end if;
  select id into uid from auth.users where email = correo;
  if uid is null then
    if length(coalesce(p_password, '')) < 8 then raise exception 'La contraseña debe tener al menos 8 caracteres'; end if;
    uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, email_change, email_change_token_new, recovery_token)
    values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', correo,
      extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}', jsonb_build_object('nombre', p_nombre), now(), now(), '', '', '', '');
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (uid::text, uid, jsonb_build_object('sub', uid::text, 'email', correo, 'email_verified', true), 'email', now(), now(), now());
  end if;
  insert into public.pyme_perfiles (id, usuario, nombre, rol, cedula_promotor, creado_por)
  values (uid, u, trim(p_nombre), p_rol, ced,
          coalesce((select nombre from public.pyme_perfiles where id = auth.uid()), 'SQL Editor'));
  return uid;
end $$;

-- admin: perfil y activo de cualquiera. jefe: solo activar/desactivar promotores.
create or replace function public.pyme_editar_usuario(p_id uuid, p_rol text, p_activo boolean)
returns void language plpgsql security definer set search_path = public as $$
declare actual text := (select rol from public.pyme_perfiles where id = p_id);
begin
  if actual is null then raise exception 'Usuario no encontrado'; end if;
  if public.pyme_rol() = 'admin' then
    if p_rol not in ('admin','gerente','jefe','promotor') then raise exception 'Perfil inválido'; end if;
    if p_rol = 'promotor' and actual <> 'promotor' then
      raise exception 'Para un promotor créelo desde "Agregar promotor" (necesita su cédula)';
    end if;
    if p_id = auth.uid() and (p_rol <> 'admin' or not p_activo) then
      raise exception 'No puede quitarse a sí mismo el rol de administrador';
    end if;
    update public.pyme_perfiles set rol = p_rol, activo = p_activo,
      cedula_promotor = case when p_rol = 'promotor' then cedula_promotor else null end
    where id = p_id;
  elsif public.pyme_rol() = 'jefe' then
    if actual <> 'promotor' or p_rol <> 'promotor' then raise exception 'El jefe del equipo solo administra promotores'; end if;
    update public.pyme_perfiles set activo = p_activo where id = p_id;
  else
    raise exception 'Sin permiso para administrar usuarios';
  end if;
end $$;

-- Solo usuarios exclusivos de este módulo: la clave de quien también usa Tiempos DAC o Auditores se administra allá
create or replace function public.pyme_restablecer_clave(p_id uuid, p_password text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not (public.pyme_rol() = 'admin'
          or (public.pyme_rol() = 'jefe' and exists (select 1 from public.pyme_perfiles where id = p_id and rol = 'promotor'))) then
    raise exception 'Sin permiso para restablecer esta contraseña';
  end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'La contraseña debe tener al menos 8 caracteres'; end if;
  if exists (select 1 from public.dac_perfiles where id = p_id)
     or (to_regclass('public.aud_perfiles') is not null and exists (select 1 from public.aud_perfiles where id = p_id)) then
    raise exception 'Este usuario también entra a otro módulo (Tiempos DAC / Auditores): su contraseña se restablece allá';
  end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')), updated_at = now()
  where id = p_id and id in (select id from public.pyme_perfiles);
end $$;

revoke execute on function public.pyme_cargar(jsonb, jsonb, jsonb), public.pyme_cargar_catalogo(jsonb),
  public.pyme_registrar_carga(timestamptz, text, integer, integer, text, jsonb),
  public.pyme_crear_usuario(text, text, text, text, text), public.pyme_editar_usuario(uuid, text, boolean),
  public.pyme_restablecer_clave(uuid, text) from public, anon;
grant execute on function public.pyme_cargar(jsonb, jsonb, jsonb), public.pyme_cargar_catalogo(jsonb),
  public.pyme_registrar_carga(timestamptz, text, integer, integer, text, jsonb),
  public.pyme_crear_usuario(text, text, text, text, text), public.pyme_editar_usuario(uuid, text, boolean),
  public.pyme_restablecer_clave(uuid, text) to authenticated;

-- ---------- Usuarios iniciales ----------
-- Administrador: el de Tiempos DAC (entra con su misma contraseña)
insert into public.pyme_perfiles (id, usuario, nombre, rol, creado_por)
select id, usuario, nombre, 'admin', 'instalación' from public.dac_perfiles
where usuario = 'carlos.manuel.alvarez.gutierrez'
on conflict (id) do nothing;

-- Los promotores iniciales se crean con data/instalar_usuarios.sql (no se sube a Git: lleva cédulas).
-- Después se administran desde la app (pestaña Personal).
select usuario, nombre, rol, cedula_promotor from public.pyme_perfiles order by rol, nombre;
