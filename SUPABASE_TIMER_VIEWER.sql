-- Timer sincronizado e acesso de leitura do painel público.
-- Execute depois de SUPABASE.sql. Seguro para reexecutar.

-- 1. Estado persistente do timer: um registro por sala OU partida.
create table if not exists public.timer_states (
  id uuid primary key default gen_random_uuid(),
  room_id uuid references public.rooms(id) on delete cascade,
  session_id uuid references public.game_sessions(id) on delete cascade,
  mode text not null default 'stopwatch'
    check (mode in ('stopwatch', 'countdown')),
  status text not null default 'stopped'
    check (status in ('stopped', 'running', 'paused')),
  started_at timestamptz,
  duration_ms bigint not null default 300000
    check (duration_ms between 0 and 59999000),
  elapsed_ms_when_paused bigint not null default 0
    check (elapsed_ms_when_paused >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  constraint timer_states_one_scope check (
    (room_id is not null and session_id is null)
    or (room_id is null and session_id is not null)
  )
);

create unique index if not exists timer_states_room_unique
  on public.timer_states (room_id) where room_id is not null;
create unique index if not exists timer_states_session_unique
  on public.timer_states (session_id) where session_id is not null;

alter table public.timer_states enable row level security;
alter table public.timer_states force row level security;

-- 2. Salas públicas abertas podem ser lidas por anon, nunca alteradas.
drop policy if exists "rooms_public_viewer_select" on public.rooms;
create policy "rooms_public_viewer_select" on public.rooms
  for select to anon
  using (is_public = true and status = 'open');
grant select on public.rooms to anon;
revoke insert, update, delete, truncate, references, trigger
  on public.rooms from anon;

-- 3. SELECT do timer: anon só vê o timer de sala pública aberta;
--    authenticated vê salas em que participa e as próprias partidas.
drop policy if exists "timer_states_public_viewer_select" on public.timer_states;
create policy "timer_states_public_viewer_select" on public.timer_states
  for select to anon
  using (
    room_id is not null
    and exists (
      select 1 from public.rooms r
      where r.id = room_id and r.is_public = true and r.status = 'open'
    )
  );

drop policy if exists "timer_states_authenticated_select" on public.timer_states;
create policy "timer_states_authenticated_select" on public.timer_states
  for select to authenticated
  using (
    (
      room_id is not null
      and (
        exists (
          select 1 from public.rooms r
          where r.id = room_id and r.is_public = true and r.status = 'open'
        )
        or
        exists (select 1 from public.rooms r where r.id = room_id and r.host_id = auth.uid())
        or public.is_room_member(room_id, auth.uid())
      )
    )
    or (
      session_id is not null
      and exists (
        select 1 from public.game_sessions g
        where g.id = session_id and g.user_id = auth.uid()
      )
    )
  );

-- Sem escrita direta, inclusive para authenticated. A RPC abaixo é a única
-- entrada de escrita e valida anfitrião/dono antes de alterar o timer.
revoke all on public.timer_states from public, anon, authenticated;
grant select on public.timer_states to anon, authenticated;

-- 4. Relógio autoritativo do Postgres usado para calcular o offset dos clientes.
create or replace function public.get_server_time()
returns timestamptz
language sql
volatile
security invoker
set search_path = pg_catalog
as $$
  select clock_timestamp();
$$;
revoke all on function public.get_server_time() from public;
grant execute on function public.get_server_time() to anon, authenticated;

-- 5. Ações do timer. SECURITY DEFINER permite escrita apesar da tabela não
--    conceder INSERT/UPDATE ao cliente; a autorização é conferida aqui.
create or replace function public.control_timer_state(
  p_scope_type text,
  p_scope_id uuid,
  p_action text,
  p_mode text default null,
  p_duration_ms bigint default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_now timestamptz := clock_timestamp();
  v_host uuid;
  v_exists boolean := false;
  v_row public.timer_states%rowtype;
  v_mode text := 'stopwatch';
  v_status text := 'stopped';
  v_started_at timestamptz;
  v_duration bigint := 300000;
  v_elapsed bigint := 0;
begin
  if v_user is null then
    raise exception 'acesso negado';
  end if;

  if p_scope_type = 'room' then
    select r.host_id into v_host
      from public.rooms r
      where r.id = p_scope_id and r.status = 'open';
    if not found then raise exception 'sala não encontrada ou encerrada'; end if;
    if v_host is distinct from v_user then
      raise exception 'somente o anfitrião pode controlar o timer';
    end if;
    select * into v_row from public.timer_states where room_id = p_scope_id for update;
    v_exists := found;
  elsif p_scope_type = 'session' then
    if not exists (
      select 1 from public.game_sessions g
      where g.id = p_scope_id and g.user_id = v_user
    ) then
      raise exception 'partida não encontrada ou sem permissão';
    end if;
    select * into v_row from public.timer_states where session_id = p_scope_id for update;
    v_exists := found;
  else
    raise exception 'escopo de timer inválido';
  end if;

  if v_exists then
    v_mode := v_row.mode;
    v_status := v_row.status;
    v_started_at := v_row.started_at;
    v_duration := v_row.duration_ms;
    v_elapsed := v_row.elapsed_ms_when_paused;
  end if;

  if p_duration_ms is not null and (p_duration_ms < 0 or p_duration_ms > 59999000) then
    raise exception 'duração inválida';
  end if;

  case p_action
    when 'start' then
      if v_mode = 'countdown' and v_duration < 1000 then
        raise exception 'defina uma duração maior que zero';
      end if;
      if v_status <> 'running' then
        if v_mode = 'countdown' and v_elapsed >= v_duration then v_elapsed := 0; end if;
        v_status := 'running';
        v_started_at := v_now;
      end if;
    when 'pause' then
      if v_status = 'running' and v_started_at is not null then
        v_elapsed := v_elapsed + greatest(
          0, floor(extract(epoch from (v_now - v_started_at)) * 1000)::bigint
        );
        if v_mode = 'countdown' then v_elapsed := least(v_elapsed, v_duration); end if;
      end if;
      v_status := 'paused';
      v_started_at := null;
    when 'reset' then
      v_status := 'stopped';
      v_started_at := null;
      v_elapsed := 0;
    when 'mode' then
      if p_mode is null or p_mode not in ('stopwatch', 'countdown') then raise exception 'modo inválido'; end if;
      v_mode := p_mode;
      v_status := 'stopped';
      v_started_at := null;
      v_elapsed := 0;
      if p_duration_ms is not null then v_duration := p_duration_ms; end if;
    when 'duration' then
      if p_duration_ms is null or p_duration_ms < 1000 then
        raise exception 'defina uma duração maior que zero';
      end if;
      v_mode := 'countdown';
      v_duration := p_duration_ms;
      v_status := 'stopped';
      v_started_at := null;
      v_elapsed := 0;
    else
      raise exception 'ação de timer inválida';
  end case;

  if p_scope_type = 'room' then
    insert into public.timer_states (
      room_id, mode, status, started_at, duration_ms, elapsed_ms_when_paused, updated_at
    ) values (
      p_scope_id, v_mode, v_status, v_started_at, v_duration, v_elapsed, v_now
    )
    on conflict (room_id) where room_id is not null do update set
      mode = excluded.mode,
      status = excluded.status,
      started_at = excluded.started_at,
      duration_ms = excluded.duration_ms,
      elapsed_ms_when_paused = excluded.elapsed_ms_when_paused,
      updated_at = excluded.updated_at
    returning * into v_row;
  else
    insert into public.timer_states (
      session_id, mode, status, started_at, duration_ms, elapsed_ms_when_paused, updated_at
    ) values (
      p_scope_id, v_mode, v_status, v_started_at, v_duration, v_elapsed, v_now
    )
    on conflict (session_id) where session_id is not null do update set
      mode = excluded.mode,
      status = excluded.status,
      started_at = excluded.started_at,
      duration_ms = excluded.duration_ms,
      elapsed_ms_when_paused = excluded.elapsed_ms_when_paused,
      updated_at = excluded.updated_at
    returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.control_timer_state(text, uuid, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.control_timer_state(text, uuid, text, text, bigint)
  to authenticated;

-- 6. Publicação Realtime. A leitura continua filtrada pelas policies acima.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'timer_states'
  ) then
    alter publication supabase_realtime add table public.timer_states;
  end if;
end;
$$;

-- Conferência:
-- select tablename, rowsecurity, forcerowsecurity
-- from pg_tables where schemaname = 'public'
-- and tablename in ('rooms', 'timer_states');
--
-- Como anon: SELECT de salas/timers públicas funciona; INSERT/UPDATE falha.
-- Como jogador convidado: control_timer_state(...) falha com acesso negado.
-- Como anfitrião/dono da partida: mode/start/pause/reset funciona.
