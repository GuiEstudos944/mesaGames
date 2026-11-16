-- ============================================================================
-- MesaGames — correções de segurança (idempotente)
-- Rode no SQL Editor do Supabase DEPOIS de SUPABASE.sql.
-- Seguro para reexecutar: usa DROP ... IF EXISTS / CREATE OR REPLACE.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- ETAPA 1 — room_members (achado 1)
--
-- O front-end (js/supabase.js) faz apenas INSERT e DELETE em room_members:
--   • createRoom     -> insert  { role: 'host' }
--   • joinPublicRoom -> insert  { role: 'guest' }  (upsert com ignoreDuplicates
--                                  => vira "ON CONFLICT DO NOTHING", sem UPDATE)
--   • leaveRoom      -> delete  da própria linha
-- O único UPDATE no registro (last_seen) acontece dentro da RPC
-- join_room_by_code, que é SECURITY DEFINER e não depende do GRANT de UPDATE.
-- Logo, revogar o UPDATE direto não quebra nada.
-- ----------------------------------------------------------------------------

-- 1.1 Nenhuma escrita via UPDATE pela API (authenticated).
revoke update on public.room_members from authenticated;

-- 1.2 A policy de UPDATE deixa de ser necessária. Removemos para o UPDATE
--     ficar totalmente fechado, inclusive caso o GRANT volte por engano.
drop policy if exists "room_members_update_self" on public.room_members;

-- 1.3 INSERT: só a própria linha, em sala aberta e visível para o usuário,
--     e o papel precisa ser coerente com a sala:
--       • role = 'host'  -> somente se rooms.host_id = auth.uid()
--       • role = 'guest' -> permitido para quem já pode entrar na sala
--     Isso impede que um convidado se autopromova a anfitrião.
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
    and (
      role = 'guest'
      or (
        role = 'host'
        and exists (
          select 1 from public.rooms r
          where r.id = room_id and r.host_id = auth.uid()
        )
      )
    )
  );


-- ----------------------------------------------------------------------------
-- ETAPA 3 — e-mails e RPCs (achados 3 e 4)
-- ----------------------------------------------------------------------------

-- 3.1 Remove a checagem pública de e-mail. Ela permitia descobrir (enumerar)
--     quais e-mails já têm conta. O cadastro agora responde de forma genérica.
drop function if exists public.is_email_available(text);

-- 3.2 `is_room_member` só pode falar do PRÓPRIO usuário autenticado.
--     Mantemos a assinatura (p_room, p_user) para não precisar recriar as
--     políticas que a usam, mas p_user é ignorado: a consulta sempre usa
--     auth.uid(). Assim ninguém consegue sondar a participação de terceiros.
create or replace function public.is_room_member(p_room uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select auth.uid() is not null
     and exists (
       select 1 from public.room_members m
       where m.room_id = p_room and m.user_id = auth.uid()
     );
$$;

revoke all on function public.is_room_member(uuid, uuid) from public;
grant execute on function public.is_room_member(uuid, uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- ETAPA 5 — código de sala (8 caracteres) e limite de tentativas
--
-- • O código gerado agora tem 8 caracteres. A constraint da coluna continua
--   sendo `^[A-Z0-9]{4,8}$`, ou seja, salas antigas de 6 caracteres seguem
--   válidas e acessíveis — nada é migrado nem apagado.
-- • `join_room_by_code` ganha duas travas simples:
--     1) valida o formato (4 a 8 caracteres A-Z/0-9) antes de consultar;
--     2) limita as tentativas por usuário (anti força-bruta), usando apenas
--        uma tabela mínima de carimbos de tempo, sem políticas de acesso.
-- ----------------------------------------------------------------------------

-- 5.1 Contador de tentativas (tabela mínima; sem acesso pela API).
create table if not exists public.room_code_attempts (
  user_id      uuid        not null,
  attempted_at timestamptz not null default now()
);

create index if not exists room_code_attempts_user_time_idx
  on public.room_code_attempts (user_id, attempted_at desc);

alter table public.room_code_attempts enable row level security;
revoke all on public.room_code_attempts from anon, authenticated;

-- 5.2 join_room_by_code: formato validado, limite de tentativas e resultado
--     de falha em vez de exceção.
--
--     POR QUE NÃO USAR RAISE EXCEPTION PARA "CÓDIGO ERRADO":
--     no PostgreSQL, uma exceção não tratada aborta a transação inteira. O
--     INSERT em room_code_attempts acontece antes das validações; se a função
--     lançasse exceção em seguida, o INSERT seria DESFEITO junto (rollback) e
--     as tentativas falhas nunca contariam — o limite jamais dispararia.
--
--     SOLUÇÃO: a função termina sempre com RETURN, devolvendo
--       { "ok": true,  "room_id": <uuid> }
--       { "ok": false, "error": "<mensagem em português>" }
--     Assim o INSERT é confirmado (a tentativa conta) e o front-end
--     (js/supabase.js > joinRoomByCode) transforma "ok = false" em erro de UI.
--
--     ATENÇÃO: o tipo de retorno mudou de uuid para jsonb, então a função
--     antiga é removida antes de recriar (CREATE OR REPLACE não troca de tipo).
drop function if exists public.join_room_by_code(text);

create function public.join_room_by_code(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_room     public.rooms;
  v_code     text;
  v_attempts int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Você precisa estar conectado para entrar em uma sala.');
  end if;

  -- Limite simples: no máximo 10 tentativas por usuário em 1 minuto.
  -- As linhas antigas (mais de 5 minutos) são descartadas na mesma chamada.
  delete from public.room_code_attempts where attempted_at < now() - interval '5 minutes';
  select count(*) into v_attempts
  from public.room_code_attempts
  where user_id = v_uid and attempted_at > now() - interval '1 minute';
  if v_attempts >= 10 then
    return jsonb_build_object('ok', false, 'error', 'Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.');
  end if;

  -- A tentativa é registrada AGORA e permanece: daqui para baixo a função
  -- sempre termina com RETURN, então o INSERT nunca é revertido.
  insert into public.room_code_attempts (user_id) values (v_uid);

  -- Formato aceito: 4 a 8 caracteres alfanuméricos. O piso de 4 mantém
  -- acessíveis as salas antigas, criadas com 6 caracteres.
  v_code := upper(btrim(coalesce(p_code, '')));
  if v_code !~ '^[A-Z0-9]{4,8}$' then
    return jsonb_build_object('ok', false, 'error', 'Código de sala inválido.');
  end if;

  select * into v_room
  from public.rooms r
  where r.code = v_code and r.status = 'open';
  if v_room.id is null then
    return jsonb_build_object('ok', false, 'error', 'Sala não encontrada ou já encerrada.');
  end if;

  insert into public.room_members (room_id, user_id, role)
  values (v_room.id, v_uid, case when v_room.host_id = v_uid then 'host' else 'guest' end)
  on conflict (room_id, user_id) do update set last_seen = now();

  return jsonb_build_object('ok', true, 'room_id', v_room.id);
end;
$$;

revoke all on function public.join_room_by_code(text) from public;
grant execute on function public.join_room_by_code(text) to authenticated;


-- ----------------------------------------------------------------------------
-- BLOCO (a) — concorrência e integridade em tempo real
--
-- PROBLEMA: o documento da sala (`rooms.state`) era salvo com UPDATE direto,
-- sem controle de concorrência. Dois jogadores alterando a mesa ao mesmo tempo
-- faziam "read-modify-write" cego: a última gravação vencia e a alteração do
-- outro era perdida (lost update) — clássico no placar.
--
-- SOLUÇÃO, em duas frentes:
--   1) save_room_state()   -> gravação OTIMISTA. O cliente envia a revisão que
--      conhece; se a sala já tiver avançado, a gravação é recusada e o servidor
--      devolve o estado atual (o cliente aplica o remoto em vez de sobrescrever).
--   2) add_player_score()  -> a pontuação deixa de depender do documento inteiro
--      e passa a ser aplicada por DELTA dentro de uma linha travada (`for
--      update`). Duas pessoas clicando "+1" ao mesmo tempo somam (4 -> 5 -> 6)
--      em vez de uma sobrescrever a outra.
-- ----------------------------------------------------------------------------

-- A coluna `rooms.revision` é criada em SUPABASE.sql (dentro do CREATE TABLE).
-- Como `create table if not exists` não adiciona colunas em tabelas que já
-- existem, garantimos aqui a presença dela — a gravação otimista depende disso.
alter table public.rooms add column if not exists revision bigint not null default 0;

-- (a.1) Gravação otimista do documento da sala.
create or replace function public.save_room_state(
  p_room uuid,
  p_state jsonb,
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_rev     bigint;
  v_updated timestamptz;
  v_current public.rooms;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Você precisa estar conectado para sincronizar.');
  end if;

  if not (public.is_room_member(p_room, v_uid)
          or exists (select 1 from public.rooms r where r.id = p_room and r.host_id = v_uid)) then
    return jsonb_build_object('ok', false, 'error', 'Você não participa desta sala.');
  end if;

  -- Só grava se a revisão conhecida pelo cliente ainda for a atual.
  -- p_expected_revision nulo = primeira gravação, sem revisão conhecida.
  update public.rooms
     set state = p_state
   where id = p_room
     and status = 'open'
     and (p_expected_revision is null or revision = p_expected_revision)
  returning revision, updated_at into v_rev, v_updated;

  if v_rev is not null then
    return jsonb_build_object('ok', true, 'revision', v_rev, 'updated_at', v_updated);
  end if;

  select * into v_current from public.rooms where id = p_room;
  if v_current.id is null then
    return jsonb_build_object('ok', false, 'error', 'Sala não encontrada.');
  end if;
  if v_current.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'A sala está encerrada.');
  end if;

  -- Conflito: alguém gravou entre a nossa leitura e a nossa escrita.
  return jsonb_build_object(
    'ok', false,
    'conflict', true,
    'revision', v_current.revision,
    'updated_at', v_current.updated_at,
    'state', v_current.state
  );
end;
$$;

revoke all on function public.save_room_state(uuid, jsonb, bigint) from public;
grant execute on function public.save_room_state(uuid, jsonb, bigint) to authenticated;


-- (a.2) Pontuação atômica por delta (evita "lost update" no placar).
create or replace function public.add_player_score(
  p_room uuid,
  p_player_id text,
  p_delta int,
  p_round int default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid     uuid := auth.uid();
  v_row     public.rooms;
  v_players jsonb;
  v_current numeric;
  v_final   int;
  v_delta   int;
  v_new     jsonb;
  v_history jsonb;
  v_rev     bigint;
  v_updated timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'Você precisa estar conectado.');
  end if;
  if coalesce(btrim(p_player_id), '') = '' then
    return jsonb_build_object('ok', false, 'error', 'Jogador inválido.');
  end if;

  -- Passo de cada clique limitado a ±1000 (defesa contra valor manipulado no
  -- cliente). O total do placar também tem teto (±999999), mais abaixo.
  v_delta := greatest(-1000, least(1000, coalesce(p_delta, 0)));

  if not (public.is_room_member(p_room, v_uid)
          or exists (select 1 from public.rooms r where r.id = p_room and r.host_id = v_uid)) then
    return jsonb_build_object('ok', false, 'error', 'Você não participa desta sala.');
  end if;

  -- Trava a linha da sala: chamadas simultâneas se enfileiram e cada uma
  -- enxerga o resultado da anterior (sem leitura-escrita cega).
  select * into v_row from public.rooms where id = p_room for update;
  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'Sala não encontrada.');
  end if;
  if v_row.status <> 'open' then
    return jsonb_build_object('ok', false, 'error', 'A sala está encerrada.');
  end if;

  v_players := coalesce(v_row.state->'players', '[]'::jsonb);

  select (p->>'score')::numeric into v_current
  from jsonb_array_elements(v_players) p
  where p->>'id' = p_player_id
  limit 1;

  if v_current is null then
    return jsonb_build_object('ok', false, 'error', 'Jogador não encontrado nesta sala.');
  end if;

  -- Mesmo limite defensivo usado no cliente.
  v_final := greatest(-999999, least(999999, trunc(v_current + v_delta)))::int;

  -- Reconstrói a lista de jogadores com a pontuação já atualizada.
  -- O coalesce no jsonb_agg garante '[]' quando a lista vem vazia.
  select coalesce(jsonb_agg(
           case when p->>'id' = p_player_id
                then jsonb_set(p, '{score}', to_jsonb(v_final))
                else p
           end
         ), '[]'::jsonb)
    into v_players
  from jsonb_array_elements(v_players) p;

  v_new := jsonb_set(coalesce(v_row.state, '{}'::jsonb), '{players}', v_players);

  -- Histórico (mais recente primeiro, como no cliente) com teto de 500 entradas.
  v_history := jsonb_build_array(jsonb_build_object(
                 'player_id', p_player_id,
                 'delta', v_delta,
                 'round', coalesce(p_round, 1),
                 'created_at', now()
               )) || coalesce(v_new->'scoreHistory', '[]'::jsonb);
  if jsonb_array_length(v_history) > 500 then
    select coalesce(jsonb_agg(elem), '[]'::jsonb) into v_history
    from (select elem from jsonb_array_elements(v_history) elem limit 500) t;
  end if;

  v_new := jsonb_set(v_new, '{scoreHistory}', v_history);
  v_new := jsonb_set(v_new, '{updatedAt}', to_jsonb(now()));

  update public.rooms set state = v_new where id = p_room
  returning revision, updated_at into v_rev, v_updated;

  return jsonb_build_object('ok', true, 'revision', v_rev, 'updated_at', v_updated, 'score', v_final);
end;
$$;

revoke all on function public.add_player_score(uuid, text, int, int) from public;
grant execute on function public.add_player_score(uuid, text, int, int) to authenticated;
