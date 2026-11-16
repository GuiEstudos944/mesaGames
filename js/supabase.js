// Camada Supabase: autenticação, partidas por usuário e sincronização com debounce.
// A segurança real é aplicada no banco (RLS) — aqui só usamos a chave pública.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CONFIGURED, AUTH_REDIRECT_URL } from "./config.js";
import {
  state, snapshot, applySnapshot, markClean, markDirty, touch,
  persistLocal, readLocalSnapshot, setLocalScope, createDefaultPlayers
} from "./state.js";

const SESSION_TABLE = "game_sessions";
const ROOM_TABLE = "rooms";
const ROOM_MEMBERS_TABLE = "room_members";
const TIMER_TABLE = "timer_states";
const SYNC_DELAY = 700;          // debounce do auto-save
const MAX_PAYLOAD = 200_000;     // ~200 KB: acima disso o histórico é reduzido
const MAX_NAME = 60;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem I, O, 0 e 1

let client = null;
if (SUPABASE_CONFIGURED) {
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
}

let activeSessionId = null;
let activeRoomId = null;
let activeRoomHost = false;
let syncTimer = null;
let syncing = false;
let pendingAgain = false;
let statusListener = null;
let offlineNotified = false;

export function isSupabaseConfigured() { return Boolean(client); }
export function getClient() { return client; }

/* ------------------------------------------------------------------ status */
export function setSyncStatusListener(listener) {
  statusListener = typeof listener === "function" ? listener : null;
}
export function emitSyncStatus(status, detail) {
  if (status === "offline") { if (offlineNotified) return; offlineNotified = true; }
  else offlineNotified = false;
  if (!statusListener) return;
  try { statusListener(status, detail); } catch (error) { console.warn(error); }
}

/* -------------------------------------------------------------------- auth */
export async function getSession() {
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  return data?.session ?? null;
}
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}
export async function signUp(email, password, displayName) {
  if (!client) throw new Error("Supabase não configurado.");
  const { data, error } = await client.auth.signUp({
    email: String(email).trim(),
    password,
    options: {
      emailRedirectTo: AUTH_REDIRECT_URL,
      data: displayName ? { display_name: String(displayName).trim().slice(0, MAX_NAME) } : undefined
    }
  });
  if (error) throw error;
  return data ?? { user: null, session: null };
}
export async function signIn(email, password) {
  if (!client) throw new Error("Supabase não configurado.");
  const { data, error } = await client.auth.signInWithPassword({ email: String(email).trim(), password });
  if (error) throw error;
  return data ?? { user: null, session: null };
}
export async function signOut() {
  if (!client) return;
  const { error } = await client.auth.signOut();
  if (error) throw error;
}
export async function sendPasswordReset(email) {
  if (!client) throw new Error("Supabase não configurado.");
  const { error } = await client.auth.resetPasswordForEmail(String(email).trim(), { redirectTo: AUTH_REDIRECT_URL });
  if (error) throw error;
}
export async function updatePassword(password) {
  if (!client) throw new Error("Supabase não configurado.");
  const { error } = await client.auth.updateUser({ password });
  if (error) throw error;
}
export function onAuthStateChange(callback) {
  if (!client) return { data: { subscription: { unsubscribe() {} } } };
  return client.auth.onAuthStateChange((event, session) => {
    try { callback(event, session); } catch (error) { console.warn(error); }
  });
}
export async function getProfile() {
  if (!client) return null;
  const { data, error } = await client.from("profiles").select("*").maybeSingle();
  if (error) throw error;
  return data ?? null;
}
export async function updateProfile(preferences) {
  if (!client) return;
  const user = await getCurrentUser();
  if (!user) return;
  const { error } = await client.from("profiles")
    .upsert({ id: user.id, email: user.email, preferences, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

/* ---------------------------------------------------------------- perfil */
/**
 * Apelido do usuário. Fica no `user_metadata` do Supabase Auth, então funciona
 * mesmo antes de o SQL do banco ser executado e sobrevive a qualquer aparelho.
 * Depois de gravar, sincroniza a cópia em `public.profiles` (usada para garantir
 * apelidos únicos). Se as funções do SQL ainda não existirem, nada quebra.
 */
export async function updateDisplayName(displayName) {
  if (!client) throw new Error("Supabase não configurado.");
  const name = String(displayName || "").trim().slice(0, MAX_NAME);
  if (!name) throw new Error("Informe um apelido.");
  const { data, error } = await client.auth.updateUser({ data: { display_name: name } });
  if (error) throw error;
  try {
    const { error: syncError } = await client.rpc("set_display_name", { p_name: name });
    if (syncError && !isMissingFunction(syncError)) throw syncError;
  } catch (syncError) {
    if (!isMissingFunction(syncError)) throw syncError;
  }
  return data?.user ?? null;
}

/* ------------------------------------------------- disponibilidade pública */
/** `false` = já cadastrado; `true` = livre; `null` = não foi possível verificar. */
function availabilityResult(data) { return data === true ? true : data === false ? false : null; }
function isMissingFunction(error) {
  const code = error?.code || "";
  return code === "PGRST202" || code === "42883" || code === "404" || /could not find the function/i.test(String(error?.message || ""));
}

/** O apelido já está em uso? Usado no cadastro e ao salvar o apelido. */
export async function checkNicknameAvailable(name) {
  if (!client) return null;
  const value = String(name || "").trim();
  if (!value) return null;
  const { data, error } = await client.rpc("is_nickname_available", { p_name: value });
  if (error) { if (isMissingFunction(error)) return null; throw error; }
  return availabilityResult(data);
}

/* ---------------------------------------------------------------- partidas */
export async function listGameSessions() {
  if (!client) return [];
  const { data, error } = await client.from(SESSION_TABLE)
    .select("id,name,created_at,updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}
export async function createGameSession(name, stateDoc) {
  if (!client) throw new Error("Supabase não configurado.");
  const user = await getCurrentUser();
  if (!user) throw new Error("É preciso estar conectado para criar partidas.");
  const { data, error } = await client.from(SESSION_TABLE)
    .insert({ user_id: user.id, name: cleanName(name), state: stateDoc ?? {} })
    .select("id,name,created_at,updated_at")
    .single();
  if (error) throw error;
  return data;
}
export async function loadGameSession(id) {
  if (!client) return null;
  const { data, error } = await client.from(SESSION_TABLE)
    .select("id,name,state,created_at,updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}
export async function saveGameSessionState(id, stateDoc) {
  if (!client) return null;
  const { data, error } = await client.from(SESSION_TABLE)
    .update({ state: stateDoc, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("updated_at")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Partida não encontrada ou sem permissão.");
  return data;
}
export async function renameGameSession(id, name) {
  if (!client) throw new Error("Supabase não configurado.");
  const { error } = await client.from(SESSION_TABLE).update({ name: cleanName(name) }).eq("id", id);
  if (error) throw error;
}
export async function deleteGameSession(id) {
  if (!client) throw new Error("Supabase não configurado.");
  const { error } = await client.from(SESSION_TABLE).delete().eq("id", id);
  if (error) throw error;
}
function cleanName(name) {
  const value = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return value || "Nova partida";
}

/* ------------------------------------------------------------------- salas */
/** Código de 8 caracteres (sem I, O, 0 e 1) para compartilhar a sala.
 *  Usa apenas crypto.getRandomValues: sem aleatoriedade insegura de reserva. */
function newRoomCode(length = 8) {
  const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (!random) throw new Error("Geração segura de código indisponível neste navegador.");
  const bytes = new Uint8Array(length);
  random(bytes);
  return Array.from(bytes, byte => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
}

/** Salas públicas abertas, já com a contagem de jogadores. */
export async function listPublicRooms() {
  if (!client) return [];
  const { data, error } = await client.rpc("list_public_rooms");
  if (error) throw error;
  return data ?? [];
}

/** Cria a sala e já coloca o criador como host. */
export async function createRoom({ name, isPublic = true }) {
  if (!client) throw new Error("Supabase não configurado.");
  const user = await getCurrentUser();
  if (!user) throw new Error("É preciso estar conectado para criar salas.");
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data, error } = await client.from(ROOM_TABLE)
      .insert({ code: newRoomCode(), name: cleanName(name), host_id: user.id, is_public: Boolean(isPublic) })
      .select("id,code,name,host_id,is_public")
      .single();
    if (!error) {
      const { error: memberError } = await client.from(ROOM_MEMBERS_TABLE)
        .insert({ room_id: data.id, user_id: user.id, role: "host" });
      if (memberError) {
        await client.from(ROOM_TABLE).delete().eq("id", data.id);
        throw memberError;
      }
      return data;
    }
    lastError = error;
    if (error.code !== "23505") break; // só repete quando o código sorteado colide
  }
  throw lastError ?? new Error("Não foi possível criar a sala.");
}

/** Entra por código (funciona também em salas privadas). Devolve o id da sala. */
export async function joinRoomByCode(code) {
  if (!client) throw new Error("Supabase não configurado.");
  const { data, error } = await client.rpc("join_room_by_code", { p_code: String(code || "").trim().toUpperCase() });
  if (error) throw error;
  return data;
}

/** Entra em uma sala pública listada. */
export async function joinPublicRoom(id) {
  if (!client) throw new Error("Supabase não configurado.");
  const user = await getCurrentUser();
  if (!user) throw new Error("É preciso estar conectado para entrar em salas.");
  const { error } = await client.from(ROOM_MEMBERS_TABLE)
    .upsert({ room_id: id, user_id: user.id, role: "guest", last_seen: new Date().toISOString() },
      { onConflict: "room_id,user_id", ignoreDuplicates: true });
  if (error) throw error;
  return id;
}

export async function loadRoom(id) {
  if (!client) return null;
  const { data, error } = await client.from(ROOM_TABLE)
    .select("id,code,name,host_id,is_public,status,state,revision,updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function saveRoomState(id, stateDoc) {
  if (!client) return null;
  const { data, error } = await client.from(ROOM_TABLE)
    .update({ state: stateDoc })
    .eq("id", id)
    .select("revision")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Sala não encontrada ou sem permissão de escrita.");
  return data;
}

export async function listRoomMembers(id) {
  if (!client) return [];
  const { data, error } = await client.rpc("list_room_members", { p_room_id: id });
  if (error) throw error;
  return data ?? [];
}

/* ---------------------------------------------------------- timer compartilhado */
export async function getServerTime() {
  if (!client) return new Date().toISOString();
  const { data, error } = await client.rpc("get_server_time");
  if (error) throw error;
  return data;
}

export async function getTimerState(scopeType, scopeId) {
  if (!client || !scopeId) return null;
  const column = scopeType === "room" ? "room_id" : "session_id";
  const { data, error } = await client.from(TIMER_TABLE)
    .select("room_id,session_id,mode,status,started_at,duration_ms,elapsed_ms_when_paused,updated_at")
    .eq(column, scopeId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function controlTimerState(scopeType, scopeId, action, mode = null, durationMs = null) {
  if (!client) throw new Error("Supabase não configurado.");
  const { data, error } = await client.rpc("control_timer_state", {
    p_scope_type: scopeType,
    p_scope_id: scopeId,
    p_action: action,
    p_mode: mode,
    p_duration_ms: durationMs
  });
  if (error) throw error;
  return data;
}

export function subscribeTimerState(scopeType, scopeId, handlers = {}) {
  if (!client || !scopeId) return () => {};
  const column = scopeType === "room" ? "room_id" : "session_id";
  const channel = client.channel(`mesa-timer-${scopeType}-${scopeId}`);
  channel
    .on("postgres_changes", {
      event: "*", schema: "public", table: TIMER_TABLE, filter: `${column}=eq.${scopeId}`
    }, payload => handlers.onChange?.(payload))
    .subscribe(status => { try { handlers.onStatus?.(status); } catch (error) { console.warn(error); } });
  return () => { try { client.removeChannel(channel); } catch { /* canal já removido */ } };
}

/** Leitura segura de sala pública usada pela tela anônima de acompanhamento. */
export async function getPublicRoomByCode(code) {
  if (!client) throw new Error("Supabase não configurado.");
  const { data, error } = await client.from(ROOM_TABLE)
    .select("id,code,name,is_public,status,state,revision,updated_at")
    .eq("code", String(code || "").trim().toUpperCase())
    .eq("is_public", true)
    .eq("status", "open")
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export function subscribePublicRoom(id, handlers = {}) {
  if (!client || !id) return () => {};
  const channel = client.channel(`mesa-public-view-${id}`);
  channel
    .on("postgres_changes", {
      event: "*", schema: "public", table: ROOM_TABLE, filter: `id=eq.${id}`
    }, payload => handlers.onRoomChange?.(payload))
    .on("postgres_changes", {
      event: "*", schema: "public", table: TIMER_TABLE, filter: `room_id=eq.${id}`
    }, payload => handlers.onTimerChange?.(payload))
    .subscribe(status => { try { handlers.onStatus?.(status); } catch (error) { console.warn(error); } });
  return () => { try { client.removeChannel(channel); } catch { /* canal já removido */ } };
}

/** Remove a participação do usuário (convidado saindo). */
export async function leaveRoom(id) {
  if (!client) return;
  const user = await getCurrentUser();
  if (!user) return;
  const { error } = await client.from(ROOM_MEMBERS_TABLE).delete().eq("room_id", id).eq("user_id", user.id);
  if (error) throw error;
}

/** Encerra a sala (só o host consegue) — apaga membros em cascata. */
export async function closeRoom(id) {
  if (!client) throw new Error("Supabase não configurado.");
  const { error } = await client.from(ROOM_TABLE).delete().eq("id", id);
  if (error) throw error;
}

/** Escuta mudanças da sala (estado e jogadores) e devolve a função para cancelar. */
export function subscribeRoom(id, handlers = {}) {
  if (!client) return () => {};
  const channel = client.channel(`mesa-room-${id}`);
  channel
    .on("postgres_changes", { event: "*", schema: "public", table: ROOM_TABLE, filter: `id=eq.${id}` },
      payload => handlers.onRoomChange?.(payload))
    .on("postgres_changes", { event: "*", schema: "public", table: ROOM_MEMBERS_TABLE, filter: `room_id=eq.${id}` },
      payload => handlers.onMembersChange?.(payload))
    .subscribe(status => { try { handlers.onStatus?.(status); } catch (error) { console.warn(error); } });
  return () => { try { client.removeChannel(channel); } catch { /* canal já removido */ } };
}

/* ------------------------------------------------------- sincronização ------------------------------------------------------ */
export function getActiveSessionId() { return activeSessionId; }
export function setActiveSessionId(id) {
  activeSessionId = id || null;
  if (activeSessionId) {
    activeRoomId = null;
    activeRoomHost = false;
  }
}
export function getActiveRoomId() { return activeRoomId; }
export function setActiveRoomId(id, isHost = false) {
  activeRoomId = id || null;
  activeRoomHost = Boolean(activeRoomId && isHost);
  if (activeRoomId) activeSessionId = null;
}
export function canControlActiveTimer() {
  return activeRoomId ? activeRoomHost : Boolean(activeSessionId);
}

function buildPayload() {
  const doc = snapshot();
  delete doc.timer;
  if (JSON.stringify(doc).length > MAX_PAYLOAD) doc.scoreHistory = doc.scoreHistory.slice(-100);
  if (JSON.stringify(doc).length > MAX_PAYLOAD) doc.diceHistory = doc.diceHistory.slice(0, 3);
  return doc;
}

/** Agenda um auto-save com debounce (sem disparar requisição a cada clique). */
export function scheduleSync() {
  if (!state.dirty) touch();
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, SYNC_DELAY);
}

/** Grava imediatamente o estado atual (usado ao trocar de partida / sair). */
export async function syncNow() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (!client) { emitSyncStatus("local"); return false; }
  const target = activeRoomId || activeSessionId;
  if (!target) { emitSyncStatus("local"); return false; }
  if (typeof navigator !== "undefined" && navigator.onLine === false) { emitSyncStatus("offline"); return false; }
  if (syncing) { pendingAgain = true; return false; }

  let user = null;
  try { user = await getCurrentUser(); } catch { user = null; }
  if (!user) { emitSyncStatus("local"); return false; }

  syncing = true;
  emitSyncStatus("saving");
  try {
    const payload = buildPayload();
    // Dentro de uma sala o documento vai para a sala; fora dela, para a partida.
    if (activeRoomId) await saveRoomState(activeRoomId, payload);
    else await saveGameSessionState(activeSessionId, payload);
    markClean();
    persistLocal();
    emitSyncStatus("saved");
    return true;
  } catch (error) {
    emitSyncStatus("error", error);
    return false;
  } finally {
    syncing = false;
    if (pendingAgain) { pendingAgain = false; scheduleSync(); }
  }
}

/** Garante que nada pendente se perca antes de trocar de partida. */
export async function flushPendingSync() {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  if (state.dirty && (activeRoomId || activeSessionId)) await syncNow();
}

/**
 * Abre uma partida: busca o estado remoto, compara com o rascunho local e
 * escolhe o mais recente — nunca sobrescreve dados novos silenciosamente.
 */
export async function openSession(id) {
  if (!client) throw new Error("Supabase não configurado.");
  await flushPendingSync();

  const remote = await loadGameSession(id);
  if (!remote) throw new Error("Partida não encontrada ou sem permissão de acesso.");

  // Abrir uma partida salva significa sair de qualquer sala online.
  activeRoomId = null;
  activeRoomHost = false;
  setActiveSessionId(id);
  setLocalScope(id);

  const cached = readLocalSnapshot(id);
  const remoteDoc = remote.state && typeof remote.state === "object" ? remote.state : null;
  const remoteAt = Date.parse(remoteDoc?.updatedAt || remote.updated_at || "") || 0;
  const cacheAt = Date.parse(cached?.updatedAt || "") || 0;

  if (remoteDoc && Array.isArray(remoteDoc.players) && remoteDoc.players.length) {
    if (cached && cached.dirty && cacheAt > remoteAt) {
      applySnapshot(cached);
      markDirty();
      persistLocal();
      emitSyncStatus("saving");
      scheduleSync();
      return { source: "local", session: remote };
    }
    applySnapshot(remoteDoc);
    persistLocal();
    emitSyncStatus("saved");
    return { source: "remote", session: remote };
  }

  // Partida sem estado utilizável: recria o estado inicial e envia.
  applySnapshot({ ...(remoteDoc || {}), players: createDefaultPlayers(), round: 1, starterIndex: 0, diceHistory: [], scoreHistory: [] });
  markDirty();
  persistLocal();
  scheduleSync();
  return { source: "seeded", session: remote };
}

/** Sai da conta mantendo o rascunho local do escopo anônimo. */
export function leaveRemoteSession() {
  activeSessionId = null;
  activeRoomId = null;
  activeRoomHost = false;
}

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => emitSyncStatus("offline"));
  window.addEventListener("online", () => {
    if (!activeRoomId && !activeSessionId) return;
    if (state.dirty) scheduleSync(); else syncNow();
  });
}

/* ------------------------------------------------- compatibilidade módulos */
// Os módulos de jogo (placar, rodadas, dados) continuam chamando estas funções.
// Agora elas apenas marcam o estado como alterado: o documento inteiro da
// partida é enviado de uma vez, evitando escritas parciais e estados quebrados.
export async function savePlayers() { scheduleSync(); }
export async function saveGameState() { scheduleSync(); }
export async function insertDiceRoll() { scheduleSync(); }
export async function updatePlayerScore() { scheduleSync(); }
