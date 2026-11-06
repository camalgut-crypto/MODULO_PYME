-- Módulo PYME (6-nov): botón "Actualizar" y carga diaria atendidos por cualquier PC de la red.
-- Ejecutar una vez en el SQL Editor, después de schema.sql.
--
-- Cada PC con el proceso de carga (actualizar.py --escuchar) pregunta cada 20 s si hay trabajo:
--   1. un pedido del botón Actualizar, o
--   2. la carga diaria: desde las 7:30 (hora de Managua) si hoy todavía no hay una carga buena, con hasta 3 intentos
--      separados 10 minutos.
-- pyme_tomar_trabajo reparte con un candado: aunque haya varias PCs encendidas, solo una carga a la vez.

create table if not exists public.pyme_actualizaciones (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in ('boton','diaria')),
  solicitado_en timestamptz not null default now(),
  solicitado_nombre text,
  estado text not null default 'pendiente' check (estado in ('pendiente','procesando','ok','error')),
  intento integer,
  equipo text,                           -- PC que la atendió
  iniciado_en timestamptz,
  terminado_en timestamptz,
  mensaje text
);
create index if not exists pyme_actualizaciones_estado on public.pyme_actualizaciones (estado);

-- PCs con el proceso de carga encendido (la app avisa si no hay ninguna conectada)
create table if not exists public.pyme_equipos (
  equipo text primary key,
  visto_en timestamptz not null default now()
);

alter table public.pyme_actualizaciones enable row level security;
alter table public.pyme_equipos enable row level security;
drop policy if exists leer on public.pyme_actualizaciones;
create policy leer on public.pyme_actualizaciones for select to authenticated
  using (public.pyme_rol() is not null or public.pyme_es_sistema());
drop policy if exists leer on public.pyme_equipos;
create policy leer on public.pyme_equipos for select to authenticated
  using (public.pyme_rol() is not null or public.pyme_es_sistema());
revoke all on public.pyme_actualizaciones, public.pyme_equipos from anon, authenticated;
grant select on public.pyme_actualizaciones, public.pyme_equipos to authenticated;

-- Botón Actualizar (cualquier usuario del módulo). Si ya hay una en cola o en proceso, se devuelve esa.
create or replace function public.pyme_pedir_actualizacion()
returns bigint language plpgsql security definer set search_path = public as $$
declare v bigint;
begin
  if public.pyme_rol() is null then raise exception 'Sin acceso al Módulo PYME'; end if;
  perform pg_advisory_xact_lock(hashtext('pyme_trabajo'));
  select id into v from public.pyme_actualizaciones where estado in ('pendiente','procesando') order by id limit 1;
  if v is null then
    insert into public.pyme_actualizaciones (tipo, solicitado_nombre)
    values ('boton', (select nombre from public.pyme_perfiles where id = auth.uid()))
    returning id into v;
  end if;
  return v;
end $$;

-- Lo llama el proceso de carga de cada PC. Devuelve el trabajo que le toca (o nada).
create or replace function public.pyme_tomar_trabajo(p_equipo text, p_hora_diaria time default '07:30',
  p_intentos integer default 3, p_espera_minutos integer default 10)
returns table (id bigint, tipo text, intento integer) language plpgsql security definer set search_path = public as $$
declare
  hoy date := (now() at time zone 'America/Managua')::date;
  desde timestamptz := (hoy + p_hora_diaria) at time zone 'America/Managua';
  v bigint; n integer; ultimo_error timestamptz;
begin
  if not (public.pyme_es_sistema() or public.pyme_rol() = 'admin') then
    raise exception 'Solo el proceso de carga toma trabajos';
  end if;
  perform pg_advisory_xact_lock(hashtext('pyme_trabajo'));
  insert into public.pyme_equipos (equipo, visto_en) values (p_equipo, now())
    on conflict (equipo) do update set visto_en = now();

  -- Una PC que se apagó a media carga: se libera el trabajo
  update public.pyme_actualizaciones a set estado = 'error', terminado_en = now(),
         mensaje = 'La PC ' || coalesce(a.equipo, '?') || ' dejó de responder a media carga'
  where a.estado = 'procesando' and a.iniciado_en < now() - interval '20 minutes';
  if exists (select 1 from public.pyme_actualizaciones a where a.estado = 'procesando') then return; end if;

  -- 1. Botón: se atiende el más antiguo; los demás pendientes van juntos con él
  select a.id into v from public.pyme_actualizaciones a where a.estado = 'pendiente' order by a.id limit 1;
  if v is not null then
    update public.pyme_actualizaciones a set estado = 'ok', terminado_en = now(), mensaje = 'Atendida junto con la solicitud ' || v
    where a.estado = 'pendiente' and a.id <> v;
    update public.pyme_actualizaciones a set estado = 'procesando', equipo = p_equipo, iniciado_en = now(), intento = 1
    where a.id = v;
    return query select v, 'boton'::text, 1;
    return;
  end if;

  -- 2. Carga diaria: desde la hora fijada, si hoy no hay una carga buena después de esa hora
  if now() < desde then return; end if;
  if exists (select 1 from public.pyme_cargas c where c.estado in ('ok','aviso') and c.inicio >= desde) then return; end if;
  select count(*), max(a.terminado_en) into n, ultimo_error from public.pyme_actualizaciones a
  where a.tipo = 'diaria' and a.estado = 'error' and a.solicitado_en >= desde;
  if n >= p_intentos then return; end if;                                   -- ya se agotaron los intentos de hoy
  if ultimo_error is not null and ultimo_error > now() - make_interval(mins => p_espera_minutos) then return; end if;
  insert into public.pyme_actualizaciones (tipo, solicitado_nombre, estado, intento, equipo, iniciado_en)
  values ('diaria', 'Carga diaria', 'procesando', n + 1, p_equipo, now())
  returning pyme_actualizaciones.id into v;
  return query select v, 'diaria'::text, n + 1;
end $$;

create or replace function public.pyme_terminar_trabajo(p_id bigint, p_estado text, p_mensaje text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.pyme_es_sistema() or public.pyme_rol() = 'admin') then
    raise exception 'Solo el proceso de carga termina trabajos';
  end if;
  update public.pyme_actualizaciones set estado = p_estado, terminado_en = now(), mensaje = left(p_mensaje, 1000)
  where id = p_id;
  delete from public.pyme_actualizaciones where solicitado_en < now() - interval '30 days';
end $$;

revoke execute on function public.pyme_pedir_actualizacion(), public.pyme_tomar_trabajo(text, time, integer, integer),
  public.pyme_terminar_trabajo(bigint, text, text) from public, anon;
grant execute on function public.pyme_pedir_actualizacion(), public.pyme_tomar_trabajo(text, time, integer, integer),
  public.pyme_terminar_trabajo(bigint, text, text) to authenticated;
