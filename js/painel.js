import {
  getPublicRoomByCode, getServerTime, getTimerState, subscribePublicRoom
} from "./supabase.js";
import {
  displayedTimerMs, formatTimerMs, normalizeTimerState
} from "./timer-core.js";
import { playTimerAlert, primeTimerAudio } from "./timer-audio.js";

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const roomCode = String(params.get("sala") || "").trim().toUpperCase();
const validRoute = params.get("modo") === "painel" && /^[A-Z0-9]{4,8}$/.test(roomCode);
const loaderStartedAt = Date.now();

let roomId = null;
let roomState = {};
let timerState = normalizeTimerState(null);
let clockOffsetMs = 0;
let unsubscribe = null;
let previousPlayers = [];
let finishedTimerKey = "";
let empty = false;

function setConnection(state, label) {
  const element = $("viewer-connection");
  if (!element) return;
  element.className = `viewer-connection ${state}`;
  element.querySelector("span").textContent = label;
}

function hideLoader() {
  const loader = $("app-loader");
  if (!loader) return;
  const delay = Math.max(0, 600 - (Date.now() - loaderStartedAt));
  window.setTimeout(() => {
    loader.classList.add("is-hidden");
    window.setTimeout(() => {
      loader.remove();
      document.body.classList.remove("is-loading");
      document.body.removeAttribute("aria-busy");
    }, 320);
  }, delay);
}

function showNotFound() {
  if (empty) return;
  empty = true;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  $("viewer-layout").hidden = true;
  $("viewer-empty").hidden = false;
}

function safePlayers(data) {
  if (!Array.isArray(data?.players)) return [];
  return data.players.slice(0, 12).map((player, index) => ({
    id: typeof player?.id === "string" ? player.id : `player-${index}`,
    name: String(player?.name || `Jogador ${index + 1}`).slice(0, 20),
    score: Math.max(-999999, Math.min(999999, Math.trunc(Number(player?.score) || 0)))
  }));
}

function renderRanking() {
  const list = $("viewer-ranking");
  const players = safePlayers(roomState);
  const sorted = players
    .map((player, index) => ({ ...player, originalIndex: index }))
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);
  const oldById = new Map(previousPlayers.map((player, index) => [player.id, { ...player, index }]));

  list.style.setProperty("--player-count", String(Math.max(1, sorted.length)));
  list.replaceChildren();
  $("viewer-player-count").textContent = `${sorted.length} ${sorted.length === 1 ? "jogador" : "jogadores"}`;

  sorted.forEach((player, index) => {
    const item = document.createElement("li");
    item.className = "viewer-player";
    if (index === 0) item.classList.add("is-leader");
    const old = oldById.get(player.id);
    if (old && old.index !== index) item.classList.add("is-reordered");

    const rank = document.createElement("span");
    rank.className = "viewer-rank";
    rank.textContent = String(index + 1).padStart(2, "0");

    const name = document.createElement("span");
    name.className = "viewer-player-name";
    name.textContent = player.name;
    if (index === 0 && sorted.length > 1) {
      const tag = document.createElement("small");
      tag.className = "viewer-leader-tag";
      tag.textContent = "LÍDER";
      name.append(document.createTextNode(" "));
      name.append(tag);
    }

    const score = document.createElement("strong");
    score.className = "viewer-score";
    score.textContent = String(player.score);
    if (old && old.score !== player.score) score.classList.add("is-changed");

    item.append(rank, name, score);
    list.append(item);
  });
  previousPlayers = sorted.map(({ id, name, score }) => ({ id, name, score }));
}

function renderDice() {
  const history = Array.isArray(roomState?.diceHistory) ? roomState.diceHistory.slice(0, 5) : [];
  const latest = history[0];
  const result = $("viewer-dice-result");
  const list = $("viewer-dice-history");
  list.replaceChildren();

  if (!latest) {
    result.textContent = "Aguardando rolagem";
    const item = document.createElement("li");
    item.textContent = "Nenhum resultado recente";
    list.append(item);
    return;
  }

  const latestValues = Array.isArray(latest.results)
    ? latest.results.map(value => String(Math.trunc(Number(value) || 0))).join(" + ")
    : "";
  const total = Math.trunc(Number(latest.total) || 0);
  const modifier = Math.trunc(Number(latest.modifier) || 0);
  const modifierText = modifier ? ` ${modifier > 0 ? "+" : "−"} ${Math.abs(modifier)}` : "";
  result.textContent = `${latestValues || latest.notation || "Rolagem"}${modifierText} = ${total}`;

  history.slice(0, 4).forEach((roll, index) => {
    const item = document.createElement("li");
    const values = Array.isArray(roll.results)
      ? roll.results.map(value => String(Math.trunc(Number(value) || 0))).join(" + ")
      : String(roll.notation || "Rolagem");
    const rollTotal = Math.trunc(Number(roll.total) || 0);
    item.textContent = `${index === 0 ? "Agora" : `#${index + 1}`} · ${values} = ${rollTotal}`;
    list.append(item);
  });
}

function renderRoom(data) {
  if (!data || data.status !== "open" || data.is_public !== true) {
    showNotFound();
    return;
  }
  empty = false;
  roomId = data.id;
  roomState = data.state && typeof data.state === "object" ? data.state : {};
  $("viewer-room-name").textContent = data.name || "Mesa ao vivo";
  $("viewer-round").textContent = String(Math.max(1, Math.trunc(Number(roomState.round) || 1))).padStart(2, "0");
  const players = safePlayers(roomState);
  const turn = Math.max(1, Math.trunc(Number(roomState.turn) || 1));
  const starter = players.length
    ? players[Math.max(0, Math.trunc(Number(roomState.starterIndex) || 0)) % players.length]?.name
    : "";
  $("viewer-starter").textContent = starter
    ? `Começa: ${starter} · turno ${Math.min(turn, Math.max(players.length, 1))}/${Math.max(players.length, 1)}`
    : "Aguardando jogadores";
  renderRanking();
  renderDice();
  $("viewer-layout").hidden = false;
}

async function refreshClockAndTimer() {
  if (!roomId) return;
  const before = Date.now();
  const [serverTime, row] = await Promise.all([
    getServerTime(),
    getTimerState("room", roomId)
  ]);
  const after = Date.now();
  const serverMs = Date.parse(serverTime);
  if (Number.isFinite(serverMs)) clockOffsetMs = serverMs - (before + after) / 2;
  timerState = normalizeTimerState(row);
  renderTimer();
}

function renderTimer() {
  const remaining = displayedTimerMs(timerState, Date.now(), clockOffsetMs);
  const isFinished = timerState.mode === "countdown"
    && timerState.status === "running"
    && remaining <= 0;
  $("viewer-timer-label").textContent = timerState.mode === "countdown" ? "TEMPORIZADOR" : "CRONÔMETRO";
  $("viewer-timer").textContent = formatTimerMs(remaining);
  $("viewer-timer").classList.toggle("is-finished", isFinished);
  $("viewer-timer-status").textContent = isFinished
    ? "Tempo esgotado"
    : timerState.status === "running"
      ? "Em andamento"
      : timerState.status === "paused" ? "Pausado" : "Parado";

  if (isFinished) {
    const key = timerState.updated_at || timerState.started_at;
    if (key && key !== finishedTimerKey) {
      finishedTimerKey = key;
      playTimerAlert();
    }
  }
}

async function refreshRoom() {
  if (!roomCode || empty) return;
  const data = await getPublicRoomByCode(roomCode);
  if (!data) {
    showNotFound();
    return;
  }
  renderRoom(data);
  try { await refreshClockAndTimer(); } catch { /* conserva o timer mais recente recebido */ }
}

function initRealtime() {
  unsubscribe = subscribePublicRoom(roomId, {
    onRoomChange: payload => {
      if (payload.eventType === "DELETE") {
        showNotFound();
        return;
      }
      if (payload.new) renderRoom(payload.new);
    },
    onTimerChange: payload => {
      if (payload.new) {
        timerState = normalizeTimerState(payload.new);
        renderTimer();
      } else if (payload.eventType === "DELETE") {
        timerState = normalizeTimerState(null);
        renderTimer();
      }
    },
    onStatus: status => {
      if (status === "SUBSCRIBED") {
        setConnection("is-live", "Ao vivo");
        refreshRoom().catch(() => setConnection("is-connecting", "Reconectando"));
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        setConnection("is-connecting", "Reconectando");
      }
    }
  });
}

async function init() {
  if (!validRoute) {
    showNotFound();
    hideLoader();
    return;
  }

  try {
    const room = await getPublicRoomByCode(roomCode);
    if (!room) {
      showNotFound();
      return;
    }
    renderRoom(room);
    try { await refreshClockAndTimer(); } catch { /* painel do placar continua disponível */ }
    initRealtime();
    setConnection("is-connecting", "Conectando");
  } catch {
    showNotFound();
  } finally {
    hideLoader();
  }
}

window.addEventListener("online", () => {
  setConnection("is-connecting", "Reconectando");
  refreshRoom().catch(() => {});
});
window.addEventListener("offline", () => setConnection("is-offline", "Sem conexão"));
document.addEventListener("pointerdown", primeTimerAudio, { once: true });
document.addEventListener("keydown", primeTimerAudio, { once: true });
window.setInterval(renderTimer, 250);
window.setInterval(() => {
  if (roomId && !document.hidden) refreshClockAndTimer().catch(() => {});
}, 60_000);
window.setInterval(() => {
  if (roomId && !document.hidden && !empty) {
    refreshRoom().catch(() => setConnection("is-connecting", "Reconectando"));
  }
}, 20_000);

init();
