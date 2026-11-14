// Conta do usuário: autenticação, partidas salvas e troca de contexto local/nuvem.
// A mesa anônima continua funcionando normalmente; a conta é opcional.
import { state, setLocalScope, loadLocalState, resetGameState, readLocalSnapshot, createDefaultPlayers } from "./state.js";
import {
  toast, confirmarModal, editarNomeModal, setConnectionStatus, setSessionPill,
  registerModalLayer, unregisterModalLayer
} from "./modal.js";
import * as api from "./supabase.js";
import { ADMIN_EMAIL } from "./config.js";
import { initRooms, refreshRoomsPanel, resetRooms } from "./rooms.js";

const LAST_SESSION_KEY = "mesa-last-session-v1";
const MIN_PASSWORD = 6;
const CHECK_DELAY = 450;         // espera antes de consultar disponibilidade

let currentUser = null;
let sessions = [];
let refreshing = false;
let busy = false;
let checkTimer = null;

const $ = id => document.getElementById(id);
const show = (el, visible) => { if (el) el.hidden = !visible; };

/* ------------------------------------------------------------------- views */
function openDialog() {
  const dialog = $("account-dialog");
  if (dialog?.hidden) {
    dialog.hidden = false;
    registerModalLayer("account-dialog", dialog, () => closeDialog());
  }
  // Se o diálogo abrir já na aba de salas, garante uma lista atualizada.
  if ($("account-rooms-view") && !$("account-rooms-view").hidden) refreshRoomsPanel().catch(error => console.error(error));
}
function closeDialog() {
  const dialog = $("account-dialog");
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  unregisterModalLayer("account-dialog");
}
function message(text, error = false) {
  const el = $("account-message");
  if (!el) return;
  el.textContent = text;
  el.className = error ? "account-message error" : "account-message";
}
/** Alterna entre a aba "Conta" e a aba "Salas online". */
function showAccountTab(tab) {
  const rooms = tab === "rooms";
  show($("account-pane"), !rooms);
  show($("account-rooms-view"), rooms);
  $("account-tab-account").classList.toggle("active", !rooms);
  $("account-tab-rooms").classList.toggle("active", rooms);
  $("account-tab-account").setAttribute("aria-selected", String(!rooms));
  $("account-tab-rooms").setAttribute("aria-selected", String(rooms));
  if (rooms) refreshRoomsPanel().catch(error => console.error(error));
}
function showAuthView() {
  show($("account-auth-view"), true);
  show($("account-session-view"), false);
  show($("account-recovery-view"), false);
}
function showSessionView() {
  show($("account-auth-view"), false);
  show($("account-session-view"), true);
  show($("account-recovery-view"), false);
}
function showRecoveryView(email) {
  show($("account-auth-view"), false);
  show($("account-session-view"), false);
  show($("account-recovery-view"), true);
  if (email) $("recovery-email").textContent = email;
  const field = $("recovery-message");
  if (field) { field.textContent = ""; field.className = "account-message"; }
}
function setMode(mode) {
  const signup = mode === "signup";
  $("auth-form-title").textContent = signup ? "Crie sua conta gratuita" : "Entre na sua conta";
  $("auth-submit").textContent = signup ? "Criar conta" : "Entrar";
  $("auth-submit").dataset.mode = signup ? "signup" : "login";
  show($("auth-name-field"), signup);
  $("auth-mode-signup").classList.toggle("active", signup);
  $("auth-mode-login").classList.toggle("active", !signup);
  $("auth-mode-signup").setAttribute("aria-selected", String(signup));
  $("auth-mode-login").setAttribute("aria-selected", String(!signup));
  message("");
}

/* ------------------------------------------------------------------- estado */
function rememberSession(id) {
  try { localStorage.setItem(LAST_SESSION_KEY, id || ""); } catch { /* storage indisponível */ }
}
function lastSessionId() {
  try { return localStorage.getItem(LAST_SESSION_KEY) || ""; } catch { return ""; }
}
function notifySessionLoaded(name) {
  document.dispatchEvent(new CustomEvent("mesa:session-loaded", { detail: { name } }));
}
function hasMeaningfulData(doc) {
  if (!doc) return false;
  if (Array.isArray(doc.diceHistory) && doc.diceHistory.length) return true;
  if (Array.isArray(doc.scoreHistory) && doc.scoreHistory.length) return true;
  if (Array.isArray(doc.players) && doc.players.some((p, i) => Number(p?.score) !== 0 || (p?.name && p.name !== `Jogador ${i + 1}`))) return true;
  return false;
}

/** Rótulo do topo: nome informado no cadastro ou a parte antes do @ do e-mail. */
function userLabel() {
  const user = currentUser;
  if (!user) return "Entrar";
  const name = user.user_metadata?.display_name || user.user_metadata?.name;
  if (name && String(name).trim()) return String(name).trim();
  const email = String(user.email || "");
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  return local || "Conta";
}

/**
 * A seção "Configurações / Dados e Banco" é exclusiva desta conta.
 * Para ser admin é preciso:
 *   1. estar logado (currentUser existe);
 *   2. o e-mail ser exatamente o definido em ADMIN_EMAIL (comparação em minúsculas);
 *   3. o e-mail estar confirmado (email_confirmed_at preenchido).
 * Esta checagem é apenas conveniência visual — a proteção real está no RLS do banco.
 */
export function isAdmin() {
  const user = currentUser;
  if (!user) return false;
  const email = String(user.email || "").toLowerCase();
  const confirmed = Boolean(user.email_confirmed_at);
  return email === ADMIN_EMAIL.toLowerCase() && confirmed;
}
/** Fora da conta do administrador a seção nem aparece — nenhum aviso é emitido. */
function applyAdminVisibility() {
  const panel = $("data-panel");
  if (panel) panel.hidden = !isAdmin();
}

function showSignedOut() {
  currentUser = null;
  sessions = [];
  api.leaveRemoteSession();
  resetRooms();
  setLocalScope("local");
  if (!loadLocalState()) resetGameState();
  $("account-label").textContent = "Entrar";
  $("profile-name").value = "";
  applyAdminVisibility();
  show($("account-logout"), false);
  show($("session-tools"), false);
  const select = $("session-select");
  if (select) select.replaceChildren();
  $("active-session-name").textContent = "Sem conta conectada";
  setConnectionStatus("offline", "Local · sem conta");
  setSessionPill("SESSÃO LOCAL");
  showAuthView();
  refreshRoomsPanel().catch(error => console.error(error));
  notifySessionLoaded(null);
}

/* ------------------------------------------------ disponibilidade de cadastro */
/** Consulta o banco: true = livre, false = já usado, null = não foi possível. */
async function checkAvailability(kind, value) {
  try {
    return kind === "email" ? await api.checkEmailAvailable(value) : await api.checkNicknameAvailable(value);
  } catch (error) {
    console.warn(error);
    return null; // banco sem as funções novas: não bloqueia o cadastro
  }
}

function availabilityMessages(kind, available) {
  const taken = kind === "email" ? "Este e-mail já está cadastrado." : "Este apelido já está em uso.";
  const free = kind === "email" ? "E-mail disponível." : "Apelido disponível.";
  return available === false ? [taken, true] : [free, false];
}

/** Avisa enquanto o usuário digita se o e-mail/apelido já está em uso. */
function bindAvailability(inputId, kind) {
  const input = $(inputId);
  if (!input) return;
  input.addEventListener("input", () => {
    clearTimeout(checkTimer);
    const value = input.value.trim();
    if (!value) { message(""); return; }
    checkTimer = setTimeout(async () => {
      // Só avisa no cadastro: ao entrar, um e-mail já cadastrado é o esperado.
      if ($("auth-submit").dataset.mode !== "signup") return;
      const available = await checkAvailability(kind, value);
      if (available === null || input.value.trim() !== value) return;
      message(...availabilityMessages(kind, available));
    }, CHECK_DELAY);
  });
}

/* ----------------------------------------------------------------- partidas */
async function refreshSessions() {
  sessions = await api.listGameSessions();
  const select = $("session-select");
  const previous = select.value;
  select.replaceChildren();
  sessions.forEach(session => {
    const option = document.createElement("option");
    option.value = session.id;
    option.textContent = session.name;
    select.append(option);
  });
  if (sessions.some(s => s.id === previous)) select.value = previous;
  show($("session-tools"), true);
}

async function selectSession(id, { quiet = false } = {}) {
  setConnectionStatus("syncing", "Carregando partida…");
  const result = await api.openSession(id);
  const session = sessions.find(s => s.id === id);
  rememberSession(id);
  $("session-select").value = id;
  $("active-session-name").textContent = session?.name || "Partida";
  $("account-label").textContent = userLabel();
  notifySessionLoaded(session?.name || null);
  if (quiet) return;
  if (result.source === "local") toast("Sua versão local desta partida era mais recente e foi mantida.", "error", 5000);
  if (result.source === "seeded") toast("Partida iniciada com uma mesa nova.");
}

async function createSession(name) {
  const seed = {
    version: 1,
    players: createDefaultPlayers(),
    round: 1,
    starterIndex: 0,
    diceHistory: [],
    scoreHistory: [],
    theme: state.theme,
    updatedAt: new Date().toISOString()
  };
  const created = await api.createGameSession(name, seed);
  await refreshSessions();
  await selectSession(created.id, { quiet: true });
  return created;
}

/** Primeiro acesso: aproveita a mesa anônima local em vez de descartá-la. */
async function importLocalBoard() {
  const doc = readLocalSnapshot("local");
  if (!hasMeaningfulData(doc)) return null;
  const created = await api.createGameSession("Minha primeira partida", doc);
  toast("Sua mesa local foi enviada para a nuvem.");
  return created;
}

/* ------------------------------------------------------------- autenticação */
function bindUi() {
  $("account-open").addEventListener("click", openDialog);
  $("account-close").addEventListener("click", closeDialog);
  $("account-dialog").addEventListener("click", event => {
    if (event.target instanceof HTMLElement && event.target.dataset.close !== undefined) closeDialog();
  });
  document.addEventListener("mesa:room-created", closeDialog);
  document.addEventListener("mesa:room-left", closeDialog);

  $("account-tab-account").addEventListener("click", () => showAccountTab("account"));
  $("account-tab-rooms").addEventListener("click", () => showAccountTab("rooms"));

  $("auth-mode-signup").addEventListener("click", () => setMode("signup"));
  $("auth-mode-login").addEventListener("click", () => setMode("login"));

  // Aviso em tempo real: e-mail/apelido já em uso durante o cadastro.
  bindAvailability("auth-email", "email");
  bindAvailability("auth-name", "nickname");

  $("auth-forgot").addEventListener("click", async () => {
    const email = $("auth-email").value.trim();
    if (!email) return message("Digite seu e-mail para receber o link de recuperação.", true);
    if (busy) return;
    busy = true;
    try {
      await api.sendPasswordReset(email);
      message("Enviamos um link de recuperação para o seu e-mail.");
    } catch (error) {
      message(authError(error), true);
    } finally { busy = false; }
  });

  // Modo local: nenhuma conta, nada vai para o Supabase — só o localStorage.
  $("auth-continue").addEventListener("click", () => {
    closeDialog();
    toast("Usando sem conta. Suas partidas ficam salvas apenas neste navegador.");
  });

  $("save-profile").addEventListener("click", async () => {
    if (busy) return;
    const name = $("profile-name").value.trim();
    if (!name) return toast("Informe um apelido.", "error");
    const current = String(currentUser?.user_metadata?.display_name || "").trim();
    busy = true;
    try {
      // Só consulta o banco quando o apelido realmente muda (o próprio vale).
      if (name.toLowerCase() !== current.toLowerCase()) {
        const available = await checkAvailability("nickname", name);
        if (available === false) { toast("Este apelido já está em uso.", "error"); return; }
      }
      await api.updateDisplayName(name);
      currentUser = await api.getCurrentUser();
      $("account-label").textContent = userLabel();
      $("profile-name").value = currentUser?.user_metadata?.display_name || "";
      toast("Apelido atualizado.");
    } catch (error) {
      console.error(error);
      toast(authError(error), "error");
    } finally { busy = false; }
  });

  $("auth-submit").addEventListener("click", async () => {
    if (busy) return;
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const name = $("auth-name").value.trim();
    const mode = $("auth-submit").dataset.mode;
    if (!email || !password) return message("Preencha e-mail e senha.", true);
    if (mode === "signup" && !name) return message("Escolha um apelido para os outros jogadores te identificarem.", true);
    if (password.length < MIN_PASSWORD) return message(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`, true);

    busy = true;
    $("auth-submit").disabled = true;
    message(mode === "signup" ? "Criando conta…" : "Entrando…");
    try {
      if (mode === "signup") {
        // Avisa antes de criar: e-mail já cadastrado e apelido já usado.
        if (await checkAvailability("nickname", name) === false) {
          message("Este apelido já está em uso. Escolha outro.", true);
          return;
        }
        if (await checkAvailability("email", email) === false) {
          message("Este e-mail já está cadastrado. Entre na conta ou recupere a senha.", true);
          return;
        }
        const result = await api.signUp(email, password, name);
        if (result?.user && Array.isArray(result.user.identities) && result.user.identities.length === 0) {
          // O Supabase não revela o motivo, mas identidades vazias = e-mail já existe.
          message("Este e-mail já está cadastrado. Entre na conta ou recupere a senha.", true);
        } else if (!result?.session) {
          // Confirmação de e-mail ligada: a conta existe, mas ainda não há sessão.
          message("Conta criada! Confirme o e-mail que enviamos para ativar o acesso.");
          toast("Conta criada. Confirme o e-mail para liberar a sincronização.", "error", 6000);
        } else {
          message("");
          await refreshAccount();
          closeDialog();
          toast("Conta criada e conectada!");
        }
      } else {
        await api.signIn(email, password);
        message("");
        await refreshAccount();
        closeDialog();
        toast(`Conectado como ${email}.`);
      }
    } catch (error) {
      console.error(error);
      message(authError(error), true);
    } finally {
      busy = false;
      $("auth-submit").disabled = false;
      $("auth-password").value = "";
    }
  });

  $("account-logout").addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    try {
      await api.flushPendingSync();
      await api.signOut();
      toast("Você saiu da conta.");
    } catch (error) {
      toast(`Erro ao sair: ${authError(error)}`, "error");
    } finally {
      busy = false;
    }
  });

  $("new-session").addEventListener("click", async () => {
    if (busy) return;
    const name = await editarNomeModal("Nova partida", {
      title: "Nova partida",
      message: "Dê um nome para identificar esta partida.",
      confirmText: "Criar",
      placeholder: "Nome da partida",
      label: "Nome da partida",
      onSubmit: async value => {
        busy = true;
        try {
          await createSession(value);
          return true;
        } finally {
          busy = false;
        }
      }
    });
    if (name === null) return;
    closeDialog();
    toast("Partida criada.");
  });

  $("session-select").addEventListener("change", async event => {
    const id = event.target.value;
    if (!id) return;
    try { await selectSession(id); }
    catch (error) { toast(`Não foi possível abrir a partida: ${error.message}`, "error"); }
  });

  $("rename-session").addEventListener("click", async () => {
    if (busy) return;
    const id = $("session-select").value;
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    const name = await editarNomeModal(session.name, {
      title: "Renomear partida",
      message: "Escolha um novo nome para esta partida.",
      placeholder: "Nome da partida",
      label: "Nome da partida",
      onSubmit: async value => {
        busy = true;
        try {
          await api.renameGameSession(id, value);
          await refreshSessions();
          $("session-select").value = id;
          $("active-session-name").textContent = value;
          setSessionPill(value.toUpperCase());
          return true;
        } finally {
          busy = false;
        }
      }
    });
    if (name === null || name === session.name) return;
    toast("Partida renomeada.");
  });

  $("delete-session").addEventListener("click", async () => {
    if (busy) return;
    const id = $("session-select").value;
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    const confirmed = await confirmarModal({
      title: "Excluir partida?",
      message: `"${session.name}" e todo o histórico dela serão apagados permanentemente.`,
      confirmText: "Excluir",
      danger: true,
      requireWord: "EXCLUIR"
    });
    if (!confirmed) return;
    busy = true;
    try {
      await api.deleteGameSession(id);
      rememberSession("");
      await refreshSessions();
      if (sessions.length) await selectSession(sessions[0].id, { quiet: true });
      else {
        api.leaveRemoteSession();
        setLocalScope("local");
        if (!loadLocalState()) resetGameState();
        $("active-session-name").textContent = "Crie sua primeira partida";
        setSessionPill("SESSÃO LOCAL");
        notifySessionLoaded(null);
      }
      toast("Partida excluída.");
    } catch (error) {
      toast(`Erro ao excluir: ${error.message}`, "error");
    } finally { busy = false; }
  });

  $("recovery-submit").addEventListener("click", async () => {
    if (busy) return;
    const password = $("recovery-password").value;
    const field = $("recovery-message");
    if (password.length < MIN_PASSWORD) {
      field.textContent = `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`;
      field.className = "account-message error";
      return;
    }
    busy = true;
    $("recovery-submit").disabled = true;
    try {
      await api.updatePassword(password);
      $("recovery-message").textContent = "Senha atualizada!";
      $("recovery-message").className = "account-message";
      toast("Senha atualizada com sucesso.");
      await refreshAccount();
    } catch (error) {
      field.textContent = authError(error);
      field.className = "account-message error";
    } finally {
      busy = false;
      $("recovery-submit").disabled = false;
      $("recovery-password").value = "";
    }
  });
}

function authError(error) {
  const code = error?.code || "";
  const message = String(error?.message || "Não foi possível concluir a operação.");
  const map = {
    invalid_credentials: "E-mail ou senha incorretos.",
    email_not_confirmed: "Confirme seu e-mail antes de entrar.",
    user_already_exists: "Este e-mail já está cadastrado.",
    email_exists: "Este e-mail já está cadastrado.",
    weak_password: "Senha muito fraca. Use pelo menos 6 caracteres.",
    over_email_send_rate_limit: "Muitos envios. Aguarde alguns minutos e tente novamente.",
    same_password: "A nova senha precisa ser diferente da atual."
  };
  if (map[code]) return map[code];
  if (error instanceof TypeError) {
    return "Falha inesperada ao falar com o Supabase. Recarregue a página (Ctrl+F5) e tente novamente.";
  }
  return message;
}

async function refreshAccount() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (!api.isSupabaseConfigured()) {
      setConnectionStatus("offline", "Local · sem conta");
      return;
    }
    currentUser = await api.getCurrentUser();
    if (!currentUser) return showSignedOut();

    $("account-label").textContent = userLabel();
    $("profile-name").value = currentUser.user_metadata?.display_name || "";
    applyAdminVisibility();
    showSessionView();
    $("account-user-email").textContent = currentUser.email || "conta conectada";
    if (currentUser.email_confirmed_at === null) {
      message("");
      toast("Confirme seu e-mail para liberar a sincronização.", "error", 5000);
    }
    await refreshSessions();

    if (!sessions.length) {
      const imported = await importLocalBoard();
      if (imported) { await refreshSessions(); await selectSession(imported.id, { quiet: true }); return; }
      api.leaveRemoteSession();
      $("active-session-name").textContent = "Crie sua primeira partida";
      setSessionPill("SESSÃO LOCAL");
      setConnectionStatus("online", "Conta conectada");
      return;
    }

    const wanted = sessions.find(s => s.id === lastSessionId()) || sessions[0];
    await selectSession(wanted.id, { quiet: true });
  } finally {
    refreshing = false;
  }
}

export function initAccount() {
  bindUi();
  initRooms();
  setMode("signup");

  if (!api.isSupabaseConfigured()) {
    $("account-open").disabled = true;
    $("account-open").title = "Supabase não configurado";
    setConnectionStatus("offline", "Local · sem conta");
    showAuthView();
    return;
  }

  api.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      // O Supabase devolve o usuário pelo link do e-mail com uma sessão temporária.
      history.replaceState(null, "", location.pathname + location.search);
      openDialog();
      showRecoveryView(session?.user?.email || "sua conta");
      return;
    }
    if (event === "SIGNED_OUT") {
      queueMicrotask(() => { showSignedOut(); });
      return;
    }
    if (session?.user) {
      // Evita operações pesadas dentro do callback síncrono do Supabase Auth.
      queueMicrotask(() => refreshAccount().catch(error => toast(authError(error), "error")));
    }
  });

  refreshAccount().catch(error => {
    console.error(error);
    setConnectionStatus("offline", "Local · sem conta");
  });
}
