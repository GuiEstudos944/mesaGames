// Salas online: encontrar, criar e entrar em mesas compartilhadas em tempo real.
//
// A sala usa o MESMO documento de partida dos módulos de jogo (state.js), então
// placar, rodadas, dados e preferências funcionam sem nenhuma adaptação. A única
// diferença é o destino da sincronização: dentro de uma sala o documento vai
// para a tabela `rooms` e é replicado a todos os jogadores via Supabase Realtime.
import * as api from "./supabase.js";
import {
  state, applySnapshot, persistLocal, markClean, markDirty,
  setLocalScope, loadLocalState, resetGameState, createDefaultPlayers
} from "./state.js";
import { toast, confirmarModal } from "./modal.js";

const $ = id => document.getElementById(id);
const show = (el, visible) => { if (el) el.hidden = !visible; };
const LIST_INTERVAL = 15_000;

let room = null;         // linha atual de `rooms`
let isHost = false;
let members = [];
let unsubscribe = null;
let busy = false;
let pollTimer = null;

/* --------------------------------------------------------------- utilidades */
function setRoomsMessage(text, error = false) {
  const el = $("rooms-message");
  if (!el) return;
  el.textContent = text || "";
  el.className = error ? "account-message error" : "account-message";
}
function memberName(member) {
  const name = String(member?.display_name || "").trim();
  return name || "Jogador sem apelido";
}
function plural(value) { return value === 1 ? "1 jogador" : `${value} jogadores`; }
function roomViewerUrl() {
  if (!room) return "";
  const url = new URL("./painel.html", location.href);
  url.searchParams.set("sala", room.code);
  url.searchParams.set("modo", "painel");
  return url.href;
}

/* ----------------------------------------------------------------- renderização */
function renderMembers() {
  const list = $("room-members");
  if (!list) return;
  list.replaceChildren();
  if (!members.length) {
    const item = document.createElement("li");
    item.className = "room-empty";
    item.textContent = "Ninguém por aqui ainda.";
    list.append(item);
    return;
  }
  members.forEach(member => {
    const item = document.createElement("li");
    item.className = "room-item";
    const info = document.createElement("div");
    info.className = "room-item-info";
    const name = document.createElement("b");
    name.textContent = memberName(member);
    const role = document.createElement("small");
    role.textContent = member.role === "host" ? "Dono da sala" : "Convidado";
    info.append(name, role);
    item.append(info);
    list.append(item);
  });
}

function renderRoomList(rooms) {
  const list = $("rooms-list");
  if (!list) return;
  list.replaceChildren();
  if (!rooms.length) {
    const item = document.createElement("li");
    item.className = "room-empty";
    item.textContent = "Nenhuma sala aberta agora. Crie a sua!";
    list.append(item);
    return;
  }
  rooms.forEach(entry => {
    const item = document.createElement("li");
    item.className = "room-item";
    const info = document.createElement("div");
    info.className = "room-item-info";
    const name = document.createElement("b");
    name.textContent = entry.name;
    const meta = document.createElement("small");
    meta.textContent = `${plural(Number(entry.member_count) || 0)} · código ${entry.code}`;
    info.append(name, meta);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.textContent = "Entrar";
    button.addEventListener("click", () => guard(() => joinPublicRoom(entry.id)));
    item.append(info, button);
    list.append(item);
  });
}

function renderActiveRoom() {
  const active = Boolean(room);
  show($("rooms-main"), !active);
  show($("rooms-active"), active);
  const canOpenViewer = active && room.is_public;
  const viewerLink = $("room-viewer-open");
  if (viewerLink) {
    viewerLink.hidden = !active;
    viewerLink.title = canOpenViewer
      ? "Abrir painel da sala em nova aba"
      : "O painel sem login só está disponível para salas públicas";
    if (canOpenViewer) {
      viewerLink.href = roomViewerUrl();
      viewerLink.removeAttribute("aria-disabled");
      viewerLink.removeAttribute("tabindex");
    } else {
      viewerLink.removeAttribute("href");
      if (active) {
        viewerLink.setAttribute("aria-disabled", "true");
        viewerLink.tabIndex = -1;
      } else {
        viewerLink.removeAttribute("aria-disabled");
        viewerLink.removeAttribute("tabindex");
      }
    }
  }
  const viewerCopyButton = $("room-viewer-copy");
  if (viewerCopyButton) {
    viewerCopyButton.disabled = !canOpenViewer;
    viewerCopyButton.title = canOpenViewer
      ? "Copiar link de acompanhamento"
      : "O painel sem login só está disponível para salas públicas";
  }
  if (active) {
    const nameEl = $("active-room-name");
    const codeEl = $("active-room-code");
    const kindEl = $("active-room-kind");
    if (nameEl) nameEl.textContent = room.name;
    if (codeEl) codeEl.textContent = room.code;
    if (kindEl) kindEl.textContent = room.is_public ? "Sala pública" : "Sala privada (só com o código)";
  }
  const leave = $("room-leave");
  if (leave) leave.textContent = isHost ? "Encerrar sala" : "Sair da sala";
}

/* -------------------------------------------------------------- carregamento */
async function loadRoomList({ quiet = false } = {}) {
  const list = $("rooms-list");
  if (list && !quiet) {
    list.replaceChildren();
    const item = document.createElement("li");
    item.className = "room-empty";
    item.textContent = "Buscando salas…";
    list.append(item);
  }
  try {
    renderRoomList(await api.listPublicRooms());
  } catch (error) {
    console.error(error);
    if (!quiet) setRoomsMessage(`Não foi possível listar as salas: ${error.message}`, true);
  }
}

async function refreshMembers() {
  if (!room) return;
  try {
    members = await api.listRoomMembers(room.id);
    renderMembers();
  } catch (error) {
    console.warn(error);
  }
}

/* ------------------------------------------------------------------- entrada */
/** Liga a mesa atual à sala escolhida e passa a escutar as mudanças dos outros. */
async function enterRoom(roomId) {
  const data = await api.loadRoom(roomId);
  if (!data || data.status !== "open") throw new Error("Sala não encontrada ou já encerrada.");
  const user = await api.getCurrentUser();
  if (!user) throw new Error("É preciso estar conectado para entrar na sala.");

  room = data;
  isHost = data.host_id === user.id;

  api.setActiveSessionId(null);
  api.setActiveRoomId(roomId, isHost);
  setLocalScope(roomId);

  const doc = data.state && typeof data.state === "object" ? data.state : null;
  if (doc && Array.isArray(doc.players) && doc.players.length) {
    applySnapshot(doc);
    persistLocal();
    markClean();
    api.emitSyncStatus("saved");
  } else {
    // Sala recém-criada: começa com uma mesa nova e publica para os convidados.
    applySnapshot({ ...(doc || {}), players: createDefaultPlayers(), round: 1, turn: 1, starterIndex: 0, diceHistory: [], scoreHistory: [] });
    markDirty();
    persistLocal();
    api.scheduleSync();
  }

  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  unsubscribe = api.subscribeRoom(roomId, {
    onRoomChange: handleRoomChange,
    onMembersChange: () => { refreshMembers(); },
    onStatus: status => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        setRoomsMessage("Conexão em tempo real instável. Tentando novamente…", true);
      }
    }
  });

  renderActiveRoom();
  await refreshMembers();
  document.dispatchEvent(new CustomEvent("mesa:session-loaded", { detail: { name: `Sala ${data.name}` } }));
}

function handleRoomChange(payload) {
  if (!room) return;
  const id = payload?.new?.id || payload?.old?.id;
  if (id !== room.id) return;

  if (payload.eventType === "DELETE") {
    toast("A sala foi encerrada pelo dono.", "error", 5000);
    exitRoom("A sala foi encerrada.");
    return;
  }

  const doc = payload?.new?.state;
  const remoteAt = Date.parse(doc?.updatedAt || "") || 0;
  const localAt = Date.parse(state.updatedAt) || 0;
  // Mensagem igual à nossa = eco do próprio save; mensagem mais antiga = já temos
  // algo mais recente. Só aplicamos quando outro jogador gravou depois de nós.
  if (!doc || remoteAt <= localAt) return;

  applySnapshot(doc);
  persistLocal();
  markClean();
  room = { ...room, revision: payload.new.revision ?? room.revision };
  document.dispatchEvent(new CustomEvent("mesa:session-loaded", { detail: { name: `Sala ${room.name}` } }));
  setRoomsMessage("A mesa foi atualizada por outro jogador.");
}

/** Sai da sala e devolve o usuário para a mesa local / partida anterior. */
function exitRoom(message = "") {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  room = null;
  isHost = false;
  members = [];
  api.setActiveRoomId(null);
  if (!api.getActiveSessionId()) {
    setLocalScope("local");
    if (!loadLocalState()) resetGameState();
    document.dispatchEvent(new CustomEvent("mesa:session-loaded", { detail: { name: "MESA LOCAL" } }));
  }
  renderActiveRoom();
  setRoomsMessage(message);
  refreshRoomsPanel().catch(() => {});
  document.dispatchEvent(new CustomEvent("mesa:room-left"));
}

/* -------------------------------------------------------------------- ações */
async function guard(action) {
  if (busy) return;
  busy = true;
  try { await action(); }
  catch (error) { console.error(error); setRoomsMessage(error?.message || "Não foi possível concluir a operação.", true); }
  finally { busy = false; }
}

async function createRoom() {
  const name = $("room-name").value.trim();
  const isPublic = $("room-public").checked;
  setRoomsMessage("Criando sala…");
  const created = await api.createRoom({ name: name || "Mesa compartilhada", isPublic });
  $("room-name").value = "";
  await enterRoom(created.id);
  setRoomsMessage("");
  document.dispatchEvent(new CustomEvent("mesa:room-created"));
  toast(`Sala criada! Compartilhe o código ${created.code}.`, "success", 6000);
}

async function joinPublicRoom(id) {
  setRoomsMessage("Entrando na sala…");
  await api.joinPublicRoom(id);
  await enterRoom(id);
  setRoomsMessage("");
  toast("Você entrou na sala.");
}

async function joinByCode() {
  const code = $("room-code").value.trim();
  if (!code) { setRoomsMessage("Digite o código da sala.", true); return; }
  setRoomsMessage("Procurando a sala…");
  const id = await api.joinRoomByCode(code);
  $("room-code").value = "";
  await enterRoom(id);
  setRoomsMessage("");
  toast("Você entrou na sala.");
}

async function leaveActiveRoom() {
  if (!room) return;
  const current = room;
  if (isHost) {
    const confirmed = await confirmarModal({
      title: "Encerrar a sala?",
      message: `A sala "${current.name}" será fechada e todos os jogadores serão desconectados.`,
      confirmText: "Encerrar",
      danger: true
    });
    if (!confirmed) return;
    await api.closeRoom(current.id);
    exitRoom("Sala encerrada.");
    toast("Sala encerrada.");
    return;
  }
  await api.leaveRoom(current.id);
  exitRoom("Você saiu da sala.");
  toast("Você saiu da sala.");
}

/* -------------------------------------------------------------------- painel */
/** Mostra o estado correto da aba: sem conta, lista de salas ou sala ativa. */
export async function refreshRoomsPanel() {
  if (!api.isSupabaseConfigured()) {
    show($("rooms-signed-out"), true);
    show($("rooms-main"), false);
    show($("rooms-active"), false);
    setRoomsMessage("Sincronização indisponível: o Supabase não está configurado.", true);
    return;
  }
  let user = null;
  try { user = await api.getCurrentUser(); } catch { user = null; }
  if (!user) {
    show($("rooms-signed-out"), true);
    show($("rooms-main"), false);
    show($("rooms-active"), false);
    setRoomsMessage("");
    return;
  }
  show($("rooms-signed-out"), false);
  if (room) {
    renderActiveRoom();
    await refreshMembers();
    return;
  }
  renderActiveRoom();
  await loadRoomList();
}

/** Limpa o estado local ao sair da conta (sem navegar nem mostrar mensagens). */
export function resetRooms() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  room = null;
  isHost = false;
  members = [];
  api.setActiveRoomId(null);
  const viewerLink = $("room-viewer-open");
  if (viewerLink) {
    viewerLink.hidden = true;
    viewerLink.removeAttribute("href");
    viewerLink.removeAttribute("aria-disabled");
    viewerLink.removeAttribute("tabindex");
  }
}

export function initRooms() {
  const create = $("room-create");
  if (create) create.addEventListener("click", () => guard(createRoom));

  const join = $("room-join-code");
  if (join) join.addEventListener("click", () => guard(joinByCode));

  const code = $("room-code");
  if (code) {
    code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    code.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); guard(joinByCode); } });
  }

  const nameInput = $("room-name");
  if (nameInput) nameInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); guard(createRoom); } });

  const refresh = $("rooms-refresh");
  if (refresh) refresh.addEventListener("click", () => guard(() => loadRoomList()));

  const leave = $("room-leave");
  if (leave) leave.addEventListener("click", () => guard(leaveActiveRoom));

  const viewerCopyButton = $("room-viewer-copy");
  if (viewerCopyButton) viewerCopyButton.addEventListener("click", async () => {
    if (!room?.is_public) {
      toast("O painel de visualização sem login exige uma sala pública.", "error");
      return;
    }
    const url = roomViewerUrl();
    try {
      await navigator.clipboard.writeText(url);
      toast("Link do painel copiado. Qualquer pessoa com o link poderá acompanhar a sala.");
    } catch {
      toast(`Não foi possível copiar. Link do painel: ${url}`, "error", 7000);
    }
  });

  // Mantém a lista de salas abertas atualizada enquanto a aba estiver visível.
  if (!pollTimer) {
    pollTimer = setInterval(() => {
      const dialog = $("account-dialog");
      const view = $("account-rooms-view");
      if (!dialog || dialog.hidden || !view || view.hidden || room) return;
      loadRoomList({ quiet: true });
    }, LIST_INTERVAL);
  }
}
