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

-- 5.2 join_room_by_code com formato validado e limite de tentativas.
create or replace function public.join_room_by_code(p_code text)
returns uuid
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
    raise exception 'Você precisa estar conectado para entrar em uma sala.';
  end if;

  -- Limite simples: no máximo 10 tentativas por usuário em 1 minuto.
  -- As linhas antigas (mais de 5 minutos) são descartadas na mesma chamada.
  delete from public.room_code_attempts where attempted_at < now() - interval '5 minutes';
  select count(*) into v_attempts
  from public.room_code_attempts
  where user_id = v_uid and attempted_at > now() - interval '1 minute';
  if v_attempts >= 10 then
    raise exception 'Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente.';
  end if;
  insert into public.room_code_attempts (user_id) values (v_uid);

  -- Formato aceito: 4 a 8 caracteres alfanuméricos. O piso de 4 mantém
  -- acessíveis as salas antigas, criadas com 6 caracteres.
  v_code := upper(btrim(coalesce(p_code, '')));
  if v_code !~ '^[A-Z0-9]{4,8}$' then
    raise exception 'Código de sala inválido.';
  end if;

  select * into v_room
  from public.rooms r
  where r.code = v_code and r.status = 'open';
  if v_room.id is null then
    raise exception 'Sala não encontrada ou já encerrada.';
  end if;

  insert into public.room_members (room_id, user_id, role)
  values (v_room.id, v_uid, case when v_room.host_id = v_uid then 'host' else 'guest' end)
  on conflict (room_id, user_id) do update set last_seen = now();
  return v_room.id;
end;
$$;

revoke all on function public.join_room_by_code(text) from public;
grant execute on function public.join_room_by_code(text) to authenticated;
