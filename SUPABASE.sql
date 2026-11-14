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
-- 7. CONFERÊNCIA (rode depois para confirmar que está tudo certo)
-- ---------------------------------------------------------------------------
-- select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' order by tablename;
-- select tablename, policyname, roles, cmd from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
--
-- Teste de isolamento (rode com a chave anon do frontend, sem sessão):
--   select * from public.game_sessions;   -- deve retornar 0 linhas
