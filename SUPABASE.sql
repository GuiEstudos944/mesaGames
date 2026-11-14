-- ============================================================================
-- MesaGames — esquema Supabase (v2, multi-usuário)
-- ============================================================================
-- Como executar: Supabase Dashboard > SQL Editor > New query > cole tudo > Run.
-- O script é idempotente: pode ser executado mais de uma vez sem perder dados.
--
-- Modelo de dados
--   profiles      -> dados públicos do usuário (e-mail, nome, preferências)
--   game_sessions -> uma linha por PARTIDA. A coluna `state` (JSONB) guarda o
--                    documento completo da partida: jogadores, pontuações,
--                    rodada, quem começa, histórico de rolagens de dados,
--                    histórico de pontuação e a data da última alteração.
--   rooms         -> uma linha por SALA ONLINE compartilhada. Usa o MESMO
--                    documento em `state` e é sincronizada em tempo real
--                    (Supabase Realtime) entre todos os jogadores conectados.
--   room_members  -> quem está em cada sala (host e convidados).
--
-- Por que JSONB em vez de uma tabela por entidade?
--   O cliente atual manipula a partida como um único documento em memória e
--   salva o conjunto inteiro de uma vez. Com JSONB a gravação é ATÔMICA: nunca
--   existe jogador sem partida, histórico órfão ou estado parcialmente gravado.
--   Também elimina o padrão anterior ("apagar tudo e reinserir"), que era a
--   maior fonte de perda de dados e de condição de corrida.
--   O RLS protege a linha inteira: um usuário não enxerga nem altera a partida
--   de outro, mesmo trocando o id na mão.
--   Se no futuro for necessário consultar jogadores/rolagens isoladamente
--   (relatórios, ranking entre usuários), crie tabelas normalizadas ligadas a
--   game_sessions(id) — sem remover o JSONB, que continua sendo a fonte do
--   estado "ao vivo".
--
-- Segurança
--   * Todas as tabelas têm RLS habilitado.
--   * Nenhuma política libera acesso anônimo a dados privados.
--   * A chave `service_role` NUNCA deve ir para o frontend.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. PERFIS DE USUÁRIO
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text check (display_name is null or char_length(display_name) <= 60),
  preferences  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Sem política de DELETE: o perfil morre junto com a conta (on delete cascade).

-- ---------------------------------------------------------------------------
-- 2. PARTIDAS (uma linha por partida)
-- ---------------------------------------------------------------------------
create table if not exists public.game_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default 'Nova partida'
             check (char_length(btrim(name)) between 1 and 60),
  state      jsonb not null default '{}'::jsonb
             check (jsonb_typeof(state) = 'object' and pg_column_size(state) < 2097152),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists game_sessions_user_updated_idx
  on public.game_sessions (user_id, updated_at desc);

alter table public.game_sessions enable row level security;

drop policy if exists "game_sessions_select_own" on public.game_sessions;
create policy "game_sessions_select_own" on public.game_sessions
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "game_sessions_insert_own" on public.game_sessions;
create policy "game_sessions_insert_own" on public.game_sessions
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "game_sessions_update_own" on public.game_sessions;
create policy "game_sessions_update_own" on public.game_sessions
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "game_sessions_delete_own" on public.game_sessions;
create policy "game_sessions_delete_own" on public.game_sessions
  for delete to authenticated
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3. PERMISSÕES (defesa em profundidade)
--    O papel `anon` não recebe nenhum acesso a tabelas privadas.
-- ---------------------------------------------------------------------------
revoke all on public.game_sessions from anon;
revoke all on public.profiles from anon;
grant select, insert, update, delete on public.game_sessions to authenticated;
grant select, insert, update on public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 4. GATILHOS
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists game_sessions_set_updated_at on public.game_sessions;
create trigger game_sessions_set_updated_at
  before update on public.game_sessions
  for each row execute function public.set_updated_at();

-- Cria o perfil automaticamente quando alguém se cadastra.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, nullif(btrim(coalesce(new.raw_user_meta_data->>'display_name', '')), ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 5. TABELAS ANTIGAS (v1) — preservadas, mas FECHADAS
-- ---------------------------------------------------------------------------
-- O projeto anterior usava `players`, `game_state`, `dice_rolls` e
-- `score_history` com dados GLOBAIS (sem usuário) e liberava CRUD para a role
-- `anon`. Os dados NÃO são apagados aqui — apenas o acesso público é removido.
-- Se essas tabelas não existirem (projeto novo), o bloco abaixo não faz nada.
do $$
declare
  legacy text;
begin
  foreach legacy in array array['players', 'game_state', 'dice_rolls', 'score_history'] loop
    if to_regclass('public.' || legacy) is not null then
      execute format('alter table public.%I enable row level security', legacy);
      -- remove a política aberta criada pela versão anterior
      execute format('drop policy if exists %I on public.%I', 'anon full access ' || legacy, legacy);
      -- nenhuma política é criada: com RLS ligado e sem política, o acesso é negado
      execute format('revoke all on public.%I from anon', legacy);
      execute format('revoke all on public.%I from authenticated', legacy);
      raise notice 'Tabela antiga public.% protegida (dados preservados).', legacy;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. MIGRAR OS DADOS ANTIGOS (opcional)
-- ---------------------------------------------------------------------------
-- Os dados das tabelas v1 continuam no banco (ninguém os apaga). Para levar a
-- mesa global antiga para dentro da conta de um usuário, descomente o bloco
-- abaixo, troque o e-mail e execute. Ele cria UMA partida "Mesa importada".
-- Nada é apagado das tabelas originais.
--
-- insert into public.game_sessions (user_id, name, state)
-- select u.id,
--        'Mesa importada',
--        jsonb_build_object(
--          'version', 1,
--          'players', (
--            select coalesce(jsonb_agg(jsonb_build_object(
--              'id', p.id, 'name', p.name, 'score', p.score, 'color', p.color) order by p.position), '[]'::jsonb)
--            from public.players p
--          ),
--          'round', coalesce((select g.round from public.game_state g where g.id = 1), 1),
--          'starterIndex', coalesce((select g.starter_index from public.game_state g where g.id = 1), 0),
--          'diceHistory', (
--            select coalesce(jsonb_agg(jsonb_build_object(
--              'type', d.dice_type, 'quantity', d.quantity, 'modifier', d.modifier,
--              'results', d.results, 'total', d.total, 'at', d.created_at) order by d.created_at desc), '[]'::jsonb)
--            from (select * from public.dice_rolls order by created_at desc limit 10) d
--          ),
--          'scoreHistory', (
--            select coalesce(jsonb_agg(jsonb_build_object(
--              'player_id', s.player_id, 'delta', s.delta, 'round', s.round,
--              'created_at', s.created_at) order by s.created_at desc), '[]'::jsonb)
--            from (select * from public.score_history order by created_at desc limit 500) s
--          ),
--          'updatedAt', now()
--        )
-- from auth.users u
-- where u.email = 'seu@email.com'
--   and not exists (select 1 from public.game_sessions g where g.user_id = u.id);

-- ---------------------------------------------------------------------------
-- 7. APELIDO ÚNICO E VERIFICAÇÃO DE DISPONIBILIDADE
-- ---------------------------------------------------------------------------
-- O cadastro precisa avisar QUANDO um e-mail ou apelido já está em uso. Como as
-- tabelas envolvidas (auth.users e public.profiles) são protegidas por RLS, a
-- consulta é feita por funções SECURITY DEFINER que devolvem apenas true/false —
-- nunca expõem dados de outro usuário.
--
-- Fonte da verdade do apelido: `auth.users.raw_user_meta_data->>'display_name'`
-- (funciona em qualquer aparelho, mesmo antes do SQL ser executado). A coluna
-- `public.profiles.display_name` é mantida em sincronia pelas funções abaixo.
--
-- O índice único é criado dentro de um bloco protegido: se já existirem apelidos
-- duplicados, nada é alterado, um aviso é emitido e o script continua.
do $$
begin
  create unique index if not exists profiles_display_name_unique_idx
    on public.profiles (lower(btrim(display_name)))
    where display_name is not null and btrim(display_name) <> '';
exception when unique_violation then
  raise warning 'Existem apelidos duplicados em public.profiles: o índice único não foi criado. Ajuste os duplicados e rode o script novamente.';
end;
$$;

-- Um e-mail já cadastrado? (sem revelar nenhum outro dado)
create or replace function public.is_email_available(p_email text)
returns boolean
language sql
security definer
stable
set search_path = public, auth
as $$
  select btrim(coalesce(p_email, '')) <> ''
     and not exists (
       select 1 from auth.users u
       where lower(u.email) = lower(btrim(p_email))
     );
$$;

-- Um apelido já cadastrado? Considera o apelido atual (metadata) e o histórico
-- em public.profiles, ignorando maiúsculas/minúsculas e espaços nas pontas.
create or replace function public.is_nickname_available(p_name text)
returns boolean
language sql
security definer
stable
set search_path = public, auth
as $$
  with target as (select lower(btrim(coalesce(p_name, ''))) as key)
  select (select key from target) <> ''
     and not exists (
       select 1 from auth.users u, target t
       where lower(btrim(coalesce(u.raw_user_meta_data->>'display_name', ''))) = t.key
     )
     and not exists (
       select 1 from public.profiles p, target t
       where lower(btrim(coalesce(p.display_name, ''))) = t.key
     );
$$;

-- Atualiza o apelido do usuário logado nos dois lugares, recusando duplicados.
create or replace function public.set_display_name(p_name text)
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if v_uid is null then
    raise exception 'É preciso estar conectado para alterar o apelido.';
  end if;
  if v_name is null then
    raise exception 'Informe um apelido.';
  end if;
  if char_length(v_name) > 60 then
    raise exception 'O apelido deve ter no máximo 60 caracteres.';
  end if;
  if exists (
       select 1 from auth.users u
       where u.id <> v_uid
         and lower(btrim(coalesce(u.raw_user_meta_data->>'display_name', ''))) = lower(v_name)
     )
     or exists (
       select 1 from public.profiles p
       where p.id <> v_uid and lower(btrim(coalesce(p.display_name, ''))) = lower(v_name)
     ) then
    raise exception 'Este apelido já está em uso.' using errcode = '23505';
  end if;
  update public.profiles set display_name = v_name where id = v_uid;
end;
$$;

revoke all on function public.is_email_available(text) from public;
revoke all on function public.is_nickname_available(text) from public;
revoke all on function public.set_display_name(text) from public;
grant execute on function public.is_email_available(text) to anon, authenticated;
grant execute on function public.is_nickname_available(text) to anon, authenticated;
grant execute on function public.set_display_name(text) to authenticated;

-- O gatilho de criação de perfil passa a evitar apelido duplicado em corrida:
-- se o apelido já tiver sido tomado entre a checagem e a criação, a conta é
-- criada normalmente, apenas sem o apelido (o usuário pode definir depois).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_name text := nullif(btrim(coalesce(new.raw_user_meta_data->>'display_name', '')), '');
begin
  if v_name is not null and (
       exists (select 1 from public.profiles p where lower(btrim(p.display_name)) = lower(v_name))
       or exists (
         select 1 from auth.users u
         where u.id <> new.id
           and lower(btrim(coalesce(u.raw_user_meta_data->>'display_name', ''))) = lower(v_name)
       )
     ) then
    v_name := null;
  end if;
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, v_name)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. SALAS ONLINE (mesa compartilhada em tempo real)
-- ---------------------------------------------------------------------------
--   rooms        -> uma linha por sala. A coluna `state` (JSONB) é o MESMO
--                   documento de partida usado em `game_sessions` e é o que os
--                   aparelhos sincronizam em tempo real via Supabase Realtime.
--   room_members -> quem está em cada sala (host e convidados).
--
-- Segurança
--   * Sala pública aberta: visível (e listável) por qualquer usuário logado.
--   * Sala privada: só aparece para quem já é membro ou para o host.
--   * Só o host define nome/visibilidade e só ele pode encerrar/excluir a sala.
--   * Entrar em sala privada exige o código (função `join_room_by_code`).
--   * Convidados podem alterar o `state` (placar/rodadas) para a mesa funcionar
--     junto, mas um gatilho impede que mudem nome, código, dono, visibilidade
--     ou situação da sala.
--   * A role `anon` não recebe nenhum acesso: salas exigem login.
-- ---------------------------------------------------------------------------
create table if not exists public.rooms (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-Z0-9]{4,8}$'),
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  host_id    uuid not null references auth.users(id) on delete cascade,
  is_public  boolean not null default true,
  status     text not null default 'open' check (status in ('open', 'closed')),
  state      jsonb not null default '{}'::jsonb
             check (jsonb_typeof(state) = 'object' and pg_column_size(state) < 2097152),
  revision   bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rooms_public_idx on public.rooms (is_public, status, updated_at desc);
create index if not exists rooms_host_idx on public.rooms (host_id);

create table if not exists public.room_members (
  room_id   uuid not null references public.rooms(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null default 'guest' check (role in ('host', 'guest')),
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (room_id, user_id)
);

create index if not exists room_members_user_idx on public.room_members (user_id);

-- Verifica participação sem disparar o RLS de `room_members` (evita recursão).
create or replace function public.is_room_member(p_room uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select p_user is not null
     and exists (
       select 1 from public.room_members m
       where m.room_id = p_room and m.user_id = p_user
     );
$$;

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

drop policy if exists "rooms_select_visible" on public.rooms;
create policy "rooms_select_visible" on public.rooms
  for select to authenticated
  using (
    (is_public and status = 'open')
    or host_id = auth.uid()
    or public.is_room_member(id, auth.uid())
  );

drop policy if exists "rooms_insert_host" on public.rooms;
create policy "rooms_insert_host" on public.rooms
  for insert to authenticated
  with check (host_id = auth.uid());

drop policy if exists "rooms_update_member" on public.rooms;
create policy "rooms_update_member" on public.rooms
  for update to authenticated
  using (host_id = auth.uid() or public.is_room_member(id, auth.uid()))
  with check (host_id = auth.uid() or public.is_room_member(id, auth.uid()));

drop policy if exists "rooms_delete_host" on public.rooms;
create policy "rooms_delete_host" on public.rooms
  for delete to authenticated
  using (host_id = auth.uid());

drop policy if exists "room_members_select_members" on public.room_members;
create policy "room_members_select_members" on public.room_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_room_member(room_id, auth.uid())
    or exists (select 1 from public.rooms r where r.id = room_id and r.host_id = auth.uid())
  );

-- Entrada direta (sem código) só em sala pública aberta, ou pelo próprio host.
-- Sala privada só é acessível com o código, via `join_room_by_code`.
drop policy if exists "room_members_insert_self" on public.room_members;
create policy "room_members_insert_self" on public.room_members
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.rooms r
      where r.id = room_id
        and r.status = 'open'
        and (r.is_public or r.host_id = auth.uid())
    )
  );

drop policy if exists "room_members_update_self" on public.room_members;
create policy "room_members_update_self" on public.room_members
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "room_members_delete_self_or_host" on public.room_members;
create policy "room_members_delete_self_or_host" on public.room_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.rooms r where r.id = room_id and r.host_id = auth.uid())
  );

-- Situação da sala: `updated_at` automático + `revision` a cada mudança de estado.
drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at
  before update on public.rooms
  for each row execute function public.set_updated_at();

create or replace function public.bump_room_revision()
returns trigger
language plpgsql
as $$
begin
  if new.state is distinct from old.state then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_bump_revision on public.rooms;
create trigger rooms_bump_revision
  before update on public.rooms
  for each row execute function public.bump_room_revision();

-- Convidado só altera o `state`; o resto dos campos volta ao valor anterior.
create or replace function public.protect_room_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is distinct from old.host_id then
    new.host_id   := old.host_id;
    new.code      := old.code;
    new.name      := old.name;
    new.is_public := old.is_public;
    new.status    := old.status;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_protect_settings on public.rooms;
create trigger rooms_protect_settings
  before update on public.rooms
  for each row execute function public.protect_room_settings();

-- Lista as salas abertas (com contagem de jogadores) sem expor dados privados.
create or replace function public.list_public_rooms()
returns table (id uuid, code text, name text, host_id uuid, is_public boolean, member_count bigint, updated_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select r.id, r.code, r.name, r.host_id, r.is_public,
         (select count(*) from public.room_members m where m.room_id = r.id)::bigint as member_count,
         r.updated_at
  from public.rooms r
  where r.is_public and r.status = 'open'
  order by r.updated_at desc
  limit 100;
$$;

-- Entra em uma sala pelo código (funciona também para salas privadas).
create or replace function public.join_room_by_code(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.rooms;
begin
  if v_uid is null then
    raise exception 'Você precisa estar conectado para entrar em uma sala.';
  end if;
  select * into v_room
  from public.rooms r
  where r.code = upper(btrim(coalesce(p_code, ''))) and r.status = 'open';
  if v_room.id is null then
    raise exception 'Sala não encontrada ou já encerrada.';
  end if;
  insert into public.room_members (room_id, user_id, role)
  values (v_room.id, v_uid, case when v_room.host_id = v_uid then 'host' else 'guest' end)
  on conflict (room_id, user_id) do update set last_seen = now();
  return v_room.id;
end;
$$;

-- Quem está na sala (só para quem participa dela).
create or replace function public.list_room_members(p_room_id uuid)
returns table (user_id uuid, display_name text, role text, joined_at timestamptz)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if auth.uid() is null
     or not (public.is_room_member(p_room_id, auth.uid())
             or exists (select 1 from public.rooms r where r.id = p_room_id and r.host_id = auth.uid()))
  then
    raise exception 'Você não participa desta sala.';
  end if;
  return query
    select m.user_id, coalesce(p.display_name, '')::text, m.role, m.joined_at
    from public.room_members m
    left join public.profiles p on p.id = m.user_id
    where m.room_id = p_room_id
    order by m.joined_at asc;
end;
$$;

revoke all on function public.list_public_rooms() from public;
revoke all on function public.join_room_by_code(text) from public;
revoke all on function public.list_room_members(uuid) from public;
-- `is_room_member` é auxiliar das políticas: NÃO deve ficar exposta à role
-- `anon` (por padrão toda função é executável por PUBLIC). As políticas só se
-- aplicam a `authenticated`, então conceder apenas a ela é suficiente.
revoke all on function public.is_room_member(uuid, uuid) from public;
grant execute on function public.list_public_rooms() to authenticated;
grant execute on function public.join_room_by_code(text) to authenticated;
grant execute on function public.list_room_members(uuid) to authenticated;
grant execute on function public.is_room_member(uuid, uuid) to authenticated;

-- Permissões das tabelas (defesa em profundidade): `anon` não acessa nada.
revoke all on public.rooms from anon;
revoke all on public.room_members from anon;
grant select, insert, update, delete on public.rooms to authenticated;
grant select, insert, update, delete on public.room_members to authenticated;

-- Tempo real: publica as mudanças das duas tabelas no Supabase Realtime.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_members'
  ) then
    alter publication supabase_realtime add table public.room_members;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. CONFERÊNCIA (rode depois para confirmar que está tudo certo)
-- ---------------------------------------------------------------------------
-- select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' order by tablename;
-- select tablename, policyname, roles, cmd from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
--
-- Teste de isolamento (rode com a chave anon do frontend, sem sessão):
--   select * from public.game_sessions;   -- deve retornar 0 linhas
