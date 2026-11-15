import { toast } from "./modal.js";
import { state, persistLocal } from "./state.js";
import {
  canControlActiveTimer, controlTimerState, getActiveRoomId, getActiveSessionId,
  getServerTime, getTimerState, subscribeTimerState
} from "./supabase.js";
import { displayedTimerMs, formatTimerMs, normalizeTimerState } from "./timer-core.js";
import { playTimerAlert, primeTimerAudio } from "./timer-audio.js";

const $ = id => document.getElementById(id);
let clockOffsetMs = 0;
let currentScope = null;
let activeScopeKey = "local";
let unsubscribe = null;
let scopeToken = 0;
let canControl = true;
let busy = false;
let queuedAction = null;
let finishedKey = "";
let renderedDuration = null;
let remoteTimerFailed = false;
let renderedToggleState = null;

// Ícones do Bootstrap Icons para o botão iniciar/pausar.
const ICON_PLAY = '<i class="bi bi-play-fill" aria-hidden="true"></i>';
const ICON_PAUSE = '<i class="bi bi-pause-fill" aria-hidden="true"></i>';

function durationFromInputs() {
  const minutes = Math.min(999, Math.max(0, Number($("timer-minutes")?.value) || 0));
  const seconds = Math.min(59, Math.max(0, Number($("timer-seconds")?.value) || 0));
  return (minutes * 60 + seconds) * 1000;
}

function updateDurationInputs(durationMs) {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
  if ($("timer-minutes")) $("timer-minutes").value = String(Math.floor(totalSeconds / 60));
  if ($("timer-seconds")) $("timer-seconds").value = String(totalSeconds % 60);
}

function setControlsEnabled(enabled) {
  document.querySelectorAll(".timer-panel [data-mode]").forEach(button => {
    button.disabled = !enabled || busy;
  });
  ["timer-toggle", "timer-reset"].forEach(id => {
    const control = $(id);
    if (control) control.disabled = !enabled || busy;
  });
  ["timer-minutes", "timer-seconds"].forEach(id => {
    const control = $(id);
    if (control) control.disabled = !enabled;
  });
  const hint = $("timer-hint");
  if (hint) hint.textContent = enabled
    ? (state.timer.mode === "countdown" ? "Defina a duração antes de iniciar." : "Conte o tempo da sua partida.")
    : "Somente o anfitrião pode controlar o timer desta sala.";
}

function render() {
  const timer = normalizeTimerState(state.timer);
  state.timer = timer;
  const value = displayedTimerMs(timer, Date.now(), clockOffsetMs);
  const finished = timer.mode === "countdown" && timer.status === "running" && value <= 0;
  const display = $("timer-display");
  if (display) {
    display.textContent = formatTimerMs(value);
    display.classList.toggle("finished", finished);
  }

  const toggle = $("timer-toggle");
  if (toggle) {
    const running = timer.status === "running";
    if (renderedToggleState !== running) {
      renderedToggleState = running;
      toggle.innerHTML = `${running ? ICON_PAUSE : ICON_PLAY}${running ? "Pausar" : "Iniciar"}`;
    }
  }

  const tabs = document.querySelectorAll(".timer-panel [data-mode]");
  tabs.forEach(tab => {
    const active = tab.dataset.mode === timer.mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  const config = $("timer-config");
  if (config) config.hidden = timer.mode !== "countdown";
  if (renderedDuration !== timer.duration_ms) {
    renderedDuration = timer.duration_ms;
    updateDurationInputs(timer.duration_ms);
  }
  setControlsEnabled(canControl);

  if (finished) {
    const key = `${timer.updated_at || ""}:${timer.started_at || ""}`;
    if (key && key !== finishedKey) {
      finishedKey = key;
      playTimerAlert();
      toast("Tempo esgotado!", "error", 5000);
    }
  }
}

function saveLocalTimer(next) {
  state.timer = normalizeTimerState({ ...next, updated_at: new Date().toISOString() });
  persistLocal();
  render();
}

function applyLocalAction(action, mode = null, durationMs = null) {
  const timer = normalizeTimerState(state.timer);
  const now = Date.now();
  if (action === "start") {
    if (timer.mode === "countdown" && timer.duration_ms < 1000) {
      toast("Defina um tempo maior que zero.", "error");
      return;
    }
    if (timer.mode === "countdown" && timer.elapsed_ms_when_paused >= timer.duration_ms) {
      timer.elapsed_ms_when_paused = 0;
    }
    timer.status = "running";
    timer.started_at = new Date(now).toISOString();
  } else if (action === "pause") {
    if (timer.status === "running" && timer.started_at) {
      timer.elapsed_ms_when_paused = displayedTimerMs(
        { ...timer, mode: "stopwatch" }, now, 0
      );
      if (timer.mode === "countdown") {
        timer.elapsed_ms_when_paused = Math.min(timer.elapsed_ms_when_paused, timer.duration_ms);
      }
    }
    timer.status = "paused";
    timer.started_at = null;
  } else if (action === "reset") {
    timer.status = "stopped";
    timer.started_at = null;
    timer.elapsed_ms_when_paused = 0;
  } else if (action === "mode") {
    timer.mode = mode === "countdown" ? "countdown" : "stopwatch";
    timer.status = "stopped";
    timer.started_at = null;
    timer.elapsed_ms_when_paused = 0;
    if (durationMs !== null) timer.duration_ms = durationMs;
  } else if (action === "duration") {
    timer.mode = "countdown";
    timer.duration_ms = durationMs;
    timer.status = "stopped";
    timer.started_at = null;
    timer.elapsed_ms_when_paused = 0;
  }
  saveLocalTimer(timer);
}

async function performAction(action, mode = null, durationMs = null) {
  if (!canControl) return;
  if (busy) {
    queuedAction = { action, mode, durationMs };
    return;
  }
  const scope = currentScope;
  if (!scope) {
    applyLocalAction(action, mode, durationMs);
    return;
  }

  busy = true;
  setControlsEnabled(canControl);
  try {
    const row = await controlTimerState(scope.type, scope.id, action, mode, durationMs);
    state.timer = normalizeTimerState(row);
    persistLocal();
    render();
    remoteTimerFailed = false;
  } catch {
    // Se a sincronização remota ainda não estiver disponível (ex.: a migração
    // do timer ainda não foi aplicada no banco), a ação continua funcionando
    // localmente, sem travar o usuário com erros repetidos.
    applyLocalAction(action, mode, durationMs);
    if (!remoteTimerFailed) {
      remoteTimerFailed = true;
      toast("Timer em modo local: a sincronização ainda não está ativa no banco.", "error", 5000);
    }
  } finally {
    busy = false;
    setControlsEnabled(canControl);
    if (queuedAction) {
      const next = queuedAction;
      queuedAction = null;
      queueMicrotask(() => performAction(next.action, next.mode, next.durationMs));
    }
  }
}

async function refreshRemoteTimer(scope, token) {
  const before = Date.now();
  const [serverTime, row] = await Promise.all([
    getServerTime(),
    getTimerState(scope.type, scope.id)
  ]);
  const after = Date.now();
  if (token !== scopeToken || currentScope?.id !== scope.id) return;
  const serverMs = Date.parse(serverTime);
  if (Number.isFinite(serverMs)) clockOffsetMs = serverMs - (before + after) / 2;
  state.timer = normalizeTimerState(row);
  persistLocal();
  render();
  remoteTimerFailed = false;
}

async function activateScope({ force = false } = {}) {
  const roomId = getActiveRoomId();
  const sessionId = getActiveSessionId();
  const nextScope = roomId
    ? { type: "room", id: roomId }
    : sessionId ? { type: "session", id: sessionId } : null;
  const nextKey = nextScope ? `${nextScope.type}:${nextScope.id}` : "local";
  if (nextKey === activeScopeKey && !force) return;
  const scopeChanged = nextKey !== activeScopeKey;
  activeScopeKey = nextKey;
  const token = ++scopeToken;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  currentScope = nextScope;
  canControl = currentScope ? canControlActiveTimer() : true;
  clockOffsetMs = 0;
  if (scopeChanged) finishedKey = "";

  if (!currentScope) {
    state.timer = normalizeTimerState(state.timer);
    render();
    return;
  }

  try {
    await refreshRemoteTimer(currentScope, token);
    if (token !== scopeToken) return;
    const scope = currentScope;
    unsubscribe = subscribeTimerState(scope.type, scope.id, {
      onChange: payload => {
        if (token !== scopeToken || !payload?.new) return;
        state.timer = normalizeTimerState(payload.new);
        persistLocal();
        render();
      },
      onStatus: status => {
        if (status === "SUBSCRIBED" && token === scopeToken) {
          refreshRemoteTimer(scope, token).catch(() => {});
        }
      }
    });
  } catch {
    // Mantém o estado local do timer e avisa só uma vez por falha de
    // sincronização, para não poluir a tela a cada reconexão.
    state.timer = normalizeTimerState(state.timer);
    render();
    if (!remoteTimerFailed) {
      remoteTimerFailed = true;
      toast("Não foi possível carregar o timer sincronizado. O modo local está em uso.", "error", 5000);
    }
  }
}

export function initTimer() {
  document.addEventListener("pointerdown", primeTimerAudio, { once: true });
  document.addEventListener("keydown", primeTimerAudio, { once: true });

  document.querySelectorAll(".timer-panel [data-mode]").forEach(tab => {
    tab.addEventListener("click", () => {
      const nextMode = tab.dataset.mode === "countdown" ? "countdown" : "stopwatch";
      const duration = nextMode === "countdown" ? durationFromInputs() : null;
      performAction("mode", nextMode, duration);
    });
  });

  $("timer-toggle")?.addEventListener("click", () => {
    primeTimerAudio();
    performAction(state.timer.status === "running" ? "pause" : "start");
  });
  $("timer-reset")?.addEventListener("click", () => performAction("reset"));
  ["timer-minutes", "timer-seconds"].forEach(id => {
    $(id)?.addEventListener("change", () => {
      const duration = durationFromInputs();
      if (duration < 1000) {
        toast("Defina um tempo maior que zero.", "error");
        return;
      }
      performAction("duration", "countdown", duration);
    });
  });

  document.addEventListener("mesa:session-loaded", () => activateScope());
  window.addEventListener("online", () => currentScope && activateScope({ force: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && currentScope) activateScope({ force: true });
  });

  render();
  activateScope();
  window.setInterval(render, 250);
}
