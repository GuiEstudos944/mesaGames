// Estado da mesa + persistência local por "escopo".
// Um escopo é a mesa anônima ("local") ou o id de uma partida salva na nuvem.
// Isso garante que cada partida tenha seu próprio rascunho local, sem misturar dados.

const COLORS = ["#a8ed69", "#70b7ff", "#ff9d71", "#c49bff", "#f2d36b", "#63d6c4", "#ff82b2", "#a7b4c8", "#e08fef", "#8bcf8b", "#f0a45c", "#72c9e9"];
const MAX_DICE_HISTORY = 10;
const MAX_SCORE_HISTORY = 500;
const SCOPE_KEY = "mesa-active-scope-v1";
const STORAGE_PREFIX = "mesa-boardgame-state-v1";
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `p-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function safeStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
const storage = safeStorage();

export function createDefaultPlayers() {
  return Array.from({ length: 4 }, (_, i) => ({ id: makeId(), name: `Jogador ${i + 1}`, score: 0, color: COLORS[i] }));
}

export const state = {
  players: createDefaultPlayers(),
  round: 1,
  turn: 1,
  starterIndex: 0,
  diceHistory: [],
  scoreHistory: [],
  timer: { mode: "stopwatch", elapsed: 0 },
  theme: "dark",
  // Quais painéis ficam visíveis na mesa (o usuário escolhe em "Personalizar").
  panels: { score: true, rounds: true, timer: true, dice: true },
  persistence: "local",
  version: 1,
  updatedAt: new Date().toISOString(),
  dirty: false
};

let activeScope = "local";
try { activeScope = storage?.getItem(SCOPE_KEY) || "local"; } catch { /* storage indisponível */ }

export function getLocalScope() { return activeScope; }
export function setLocalScope(scope) {
  activeScope = typeof scope === "string" && scope ? scope : "local";
  try { storage?.setItem(SCOPE_KEY, activeScope); } catch { /* storage indisponível */ }
  return activeScope;
}
const scopeKey = scope => `${STORAGE_PREFIX}:${scope}`;
export function localScopeKey(scope) { return scopeKey(scope); }

export function playerColors() { return COLORS; }

/** Marca o estado como alterado (para o auto-save e para a detecção de conflitos). */
export function touch() {
  state.updatedAt = new Date().toISOString();
  state.dirty = true;
}
export function markDirty() { state.dirty = true; }
export function markClean() { state.dirty = false; }

/** Documento completo que é enviado para a nuvem / salvo localmente. */
export function snapshot() {
  return {
    version: state.version,
    players: state.players,
    round: state.round,
    turn: state.turn,
    starterIndex: state.starterIndex,
    diceHistory: state.diceHistory.slice(0, MAX_DICE_HISTORY),
    scoreHistory: state.scoreHistory.slice(-MAX_SCORE_HISTORY),
    theme: state.theme,
    panels: { ...state.panels },
    updatedAt: state.updatedAt
  };
}

/** Aplica um documento vindo da nuvem/local no estado em memória. */
export function applySnapshot(data) {
  if (!data || typeof data !== "object") return false;
  if (Array.isArray(data.players) && data.players.length) {
    state.players = data.players.map((p, i) => ({
      id: typeof p?.id === "string" && p.id ? p.id : makeId(),
      name: String(p?.name ?? `Jogador ${i + 1}`).slice(0, 20),
      score: Number.isFinite(Number(p?.score)) ? Math.trunc(Number(p.score)) : 0,
      color: typeof p?.color === "string" && p.color ? p.color : COLORS[i % COLORS.length]
    }));
  }
  state.round = Math.max(1, Math.trunc(Number(data.round)) || 1);
  // Turnos escritos antes desta versão não existem no documento: começam no 1.
  state.turn = Math.max(1, Math.trunc(Number(data.turn)) || 1);
  state.starterIndex = Math.max(0, Math.trunc(Number(data.starterIndex)) || 0) % Math.max(1, state.players.length);
  state.diceHistory = Array.isArray(data.diceHistory) ? data.diceHistory.slice(0, MAX_DICE_HISTORY) : [];
  state.scoreHistory = Array.isArray(data.scoreHistory) ? data.scoreHistory.slice(-MAX_SCORE_HISTORY) : [];
  if (data.theme === "light" || data.theme === "dark") state.theme = data.theme;
  // Documentos antigos não têm `panels`: nesse caso todos os painéis ficam visíveis.
  const panels = data.panels && typeof data.panels === "object" ? data.panels : {};
  state.panels = {
    score: panels.score !== false,
    rounds: panels.rounds !== false,
    timer: panels.timer !== false,
    dice: panels.dice !== false
  };
  state.updatedAt = Number.isNaN(Date.parse(data.updatedAt)) ? new Date().toISOString() : new Date(data.updatedAt).toISOString();
  state.dirty = false;
  return true;
}

function writeLocal() {
  if (!storage) return;
  try {
    storage.setItem(scopeKey(activeScope), JSON.stringify({ ...snapshot(), dirty: state.dirty }));
  } catch (error) {
    console.warn("Falha ao salvar no armazenamento local:", error);
  }
}
/** Salva o estado atual no rascunho local e marca como pendente de sincronização. */
export function saveLocalState() { touch(); writeLocal(); }
/** Persiste sem marcar alteração (usado depois de aplicar dados da nuvem). */
export function persistLocal() { writeLocal(); }

export function readLocalSnapshot(scope) {
  if (!storage) return null;
  try { return JSON.parse(storage.getItem(scopeKey(scope)) || "null"); } catch { return null; }
}

export function loadLocalState() {
  const saved = readLocalSnapshot(activeScope);
  if (!saved) return false;
  applySnapshot(saved);
  state.dirty = Boolean(saved.dirty);
  return true;
}

export function resetGameState() {
  state.players = createDefaultPlayers();
  state.round = 1;
  state.turn = 1;
  state.starterIndex = 0;
  state.diceHistory = [];
  state.scoreHistory = [];
  saveLocalState();
}
