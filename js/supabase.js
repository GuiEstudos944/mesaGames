// Camada Supabase: autenticação, partidas por usuário e sincronização com debounce.
// A segurança real é aplicada no banco (RLS) — aqui só usamos a chave pública.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_CONFIGURED, AUTH_REDIRECT_URL } from "./config.js";
import {
  state, snapshot, applySnapshot, markClean, markDirty, touch,
  persistLocal, readLocalSnapshot, setLocalScope, createDefaultPlayers
} from "./state.js";

const SESSION_TABLE = "game_sessions";
const SYNC_DELAY = 700;          // debounce do auto-save
const MAX_PAYLOAD = 200_000;     // ~200 KB: acima disso o histórico é reduzido
const MAX_NAME = 60;

let client = null;
if (SUPABASE_CONFIGURED) {
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
}

let activeSessionId = null;
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
 */
export async function updateDisplayName(displayName) {
  if (!client) throw new Error("Supabase não configurado.");
  const name = String(displayName || "").trim().slice(0, MAX_NAME);
  if (!name) throw new Error("Informe um apelido.");
  const { data, error } = await client.auth.updateUser({ data: { display_name: name } });
  if (error) throw error;
  return data?.user ?? null;
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

/* ------------------------------------------------------- sincronização ------------------------------------------------------ */
export function getActiveSessionId() { return activeSessionId; }
export function setActiveSessionId(id) { activeSessionId = id || null; }

function buildPayload() {
  const doc = snapshot();
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
  if (!activeSessionId) { emitSyncStatus("local"); return false; }
  if (typeof navigator !== "undefined" && navigator.onLine === false) { emitSyncStatus("offline"); return false; }
  if (syncing) { pendingAgain = true; return false; }

  let user = null;
  try { user = await getCurrentUser(); } catch { user = null; }
  if (!user) { emitSyncStatus("local"); return false; }

  syncing = true;
  emitSyncStatus("saving");
  try {
    const payload = buildPayload();
    await saveGameSessionState(activeSessionId, payload);
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
  if (state.dirty && activeSessionId) await syncNow();
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
export function leaveRemoteSession() { activeSessionId = null; }

if (typeof window !== "undefined") {
  window.addEventListener("offline", () => emitSyncStatus("offline"));
  window.addEventListener("online", () => {
    if (!activeSessionId) return;
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
