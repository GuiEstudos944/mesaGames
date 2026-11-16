import { state, loadLocalState, saveLocalState, resetGameState } from "./state.js";
import { initScore, renderScore, addPlayer, resetScores } from "./score.js";
import { initRounds, renderRounds } from "./rounds.js";
import { initTimer } from "./timer.js";
import { initDice, renderDiceHistory } from "./dice.js";
import {
  confirmarModal, toast, informativoModal, setConnectionStatus, setSessionPill,
  registerModalLayer, unregisterModalLayer
} from "./modal.js";
import { isSupabaseConfigured, scheduleSync, setSyncStatusListener } from "./supabase.js";
import { initAccount, isAdmin } from "./account.js";

// Painéis que o usuário pode exibir ou ocultar em "Personalizar painéis".
const PANELS = [
  { key: "score", label: "Placar", description: "Contador de pontos dos jogadores", selector: ".score-panel" },
  { key: "rounds", label: "Rodadas", description: "Controle de turnos e rodadas", selector: ".rounds-panel" },
  { key: "timer", label: "Relógio", description: "Cronômetro e temporizador", selector: ".timer-panel" },
  { key: "dice", label: "Dados", description: "Rolagens de dados", selector: ".dice-panel" }
];

// Rótulos do indicador de sincronização (topo da página).
const STATUS = {
  local: ["offline", "Local · sem conta"],
  saving: ["syncing", "Salvando…"],
  saved: ["online", "Salvo"],
  offline: ["offline", "Offline"],
  error: ["offline", "Erro ao sincronizar"]
};

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = state.theme === "dark" ? "#191D27" : "#f2f4f7";
  // role="switch": aria-checked reflete o estado (true = claro, já que o switch "liga" o claro).
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.setAttribute("aria-checked", state.theme === "light" ? "true" : "false");
  // Persiste a preferência para o script do <head> aplicar antes do paint.
  try { globalThis.localStorage?.setItem("mesagames_theme", state.theme); } catch { /* storage indisponível */ }
}
function initTheme() {
  // Sincroniza o estado com o tema que o script do <head> já aplicou (evita FOUC).
  const headTheme = document.documentElement.getAttribute("data-theme");
  if (headTheme === "light" || headTheme === "dark") state.theme = headTheme;
  applyTheme();

  const toggle = document.getElementById("theme-toggle");
  const toggleTheme = () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    toggle.classList.add("is-toggling");
    applyTheme();
    saveLocalState();
    scheduleSync();
    window.setTimeout(() => toggle.classList.remove("is-toggling"), 600);
  };
  toggle.addEventListener("click", toggleTheme);
  // role="switch": Enter e Espaço acionam o botão (comportamento padrão de <button>),
  // mas garantimos que Espaço não faça scroll da página.
  toggle.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Spacebar" || event.key === "Enter") {
      event.preventDefault();
      toggleTheme();
    }
  });
}
function renderAll() {
  applyTheme();
  applyPanelVisibility();
  renderScore();
  renderRounds();
  renderDiceHistory();
}

/* --------------------------------------------------- personalizar painéis */
/** Mostra ou esconde cada painel conforme a preferência salva na partida. */
function applyPanelVisibility() {
  PANELS.forEach(panel => {
    const element = document.querySelector(panel.selector);
    if (element) element.hidden = state.panels[panel.key] === false;
  });
  document.querySelectorAll(".dashboard-column").forEach(column => {
    column.hidden = !Array.from(column.children).some(panel => !panel.hidden);
  });
}

function renderLayoutOptions() {
  const box = document.getElementById("layout-options");
  if (!box) return;
  box.replaceChildren();
  PANELS.forEach(panel => {
    const label = document.createElement("label");
    label.className = "layout-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.panels[panel.key] !== false;
    input.addEventListener("change", () => {
      state.panels[panel.key] = input.checked;
      applyPanelVisibility();
      saveLocalState();
      scheduleSync();
      toast(input.checked ? `Painel "${panel.label}" exibido.` : `Painel "${panel.label}" ocultado.`);
    });
    const text = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = panel.label;
    const description = document.createElement("small");
    description.textContent = panel.description;
    text.append(title, description);
    label.append(input, text);
    box.append(label);
  });
}

function initLayout() {
  const dialog = document.getElementById("layout-dialog");
  if (!dialog) return;
  const close = () => {
    if (dialog.hidden) return;
    dialog.hidden = true;
    unregisterModalLayer("layout-dialog");
  };
  document.getElementById("layout-open").addEventListener("click", () => {
    renderLayoutOptions();
    dialog.hidden = false;
    registerModalLayer("layout-dialog", dialog, close);
  });
  document.getElementById("layout-close").addEventListener("click", close);
  dialog.addEventListener("click", event => {
    if (event.target instanceof HTMLElement && event.target.dataset.close !== undefined) close();
  });
  document.getElementById("layout-show-all").addEventListener("click", () => {
    PANELS.forEach(panel => { state.panels[panel.key] = true; });
    applyPanelVisibility();
    renderLayoutOptions();
    saveLocalState();
    scheduleSync();
    toast("Todos os painéis foram exibidos.");
  });
}

function bindSyncIndicator() {
  setSyncStatusListener((status, detail) => {
    const info = STATUS[status];
    if (!info) return;
    setConnectionStatus(info[0], info[1]);
    if (status === "error") {
      toast(`Erro ao sincronizar: ${detail?.message || "verifique a conexão"}. Seus dados continuam salvos neste navegador.`, "error", 5000);
    }
    if (status === "offline") {
      toast("Sem conexão. As alterações ficam salvas neste navegador e sincronizam depois.", "error", 4500);
    }
  });
}

async function runManagedAction(button, action) {
  button.classList.add("loading");
  button.disabled = true;
  try { await action(); }
  catch (error) { console.error(error); toast(`Não foi possível concluir: ${error.message || "erro desconhecido"}`, "error", 4500); }
  finally { button.classList.remove("loading"); button.disabled = false; }
}

function initManagement() {
  // Ações destrutivas e exportação são exclusivas do administrador.
  // O painel já fica oculto para quem não é admin (applyAdminVisibility), mas
  // esta verificação é a defesa em profundidade: se alguém acionar o botão
  // pelo console ou por um link quebrado, recebe o modal de acesso restrito.
  const requireAdmin = async () => {
    if (!isAdmin()) {
      await informativoModal(
        "Acesso restrito",
        "Esta operação é exclusiva do administrador. Entre com a conta autorizada para continuar."
      );
      return false;
    }
    return true;
  };

  document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", () => runManagedAction(button, async () => {
    if (!await requireAdmin()) return;
    const configs = {
      "clear-dice": { title: "Limpar histórico de dados?", message: "Todas as rolagens salvas serão apagadas.", confirmText: "Limpar" },
      "clear-score-history": { title: "Limpar histórico de pontuação?", message: "O registro de alterações de pontos será apagado.", confirmText: "Limpar" },
      "zero-all-scores": { title: "Zerar pontos de todos?", message: "Todos os jogadores ficarão com zero pontos.", confirmText: "Zerar" },
      "reset-rounds": { title: "Resetar rodadas?", message: "A partida voltará para a rodada 1.", confirmText: "Resetar" },
      "remove-all-players": { title: "Remover todos os jogadores?", message: "Os jogadores atuais serão substituídos por quatro jogadores padrão. Digite LIMPAR para confirmar.", confirmText: "Remover", danger: true, requireWord: "LIMPAR" },
      "reset-all": { title: "Limpar TODAS as tabelas?", message: "Isso apagará os dados desta partida e recriará o estado inicial. Digite LIMPAR para confirmar.", confirmText: "Limpar tudo", danger: true, requireWord: "LIMPAR" }
    };
    const action = button.dataset.action;
    const config = configs[action];
    if (!config || !await confirmarModal(config)) return;

    if (action === "clear-dice") state.diceHistory = [];
    if (action === "clear-score-history") state.scoreHistory = [];
    if (action === "zero-all-scores") state.players.forEach(player => { player.score = 0; });
    if (action === "reset-rounds") { state.round = 1; state.turn = 1; state.starterIndex = 0; }
    if (action === "remove-all-players") { resetGameState(); state.scoreHistory = []; }
    if (action === "reset-all") { resetGameState(); }
    if (action !== "remove-all-players" && action !== "reset-all") saveLocalState();
    scheduleSync();
    renderAll();
    toast("Operação concluída com sucesso.");
  })));

  document.getElementById("export-json").addEventListener("click", async () => {
    if (!await requireAdmin()) return;
    const payload = {
      exported_at: new Date().toISOString(),
      players: state.players,
      game_state: { round: state.round, turn: state.turn, starter_index: state.starterIndex },
      dice_rolls: state.diceHistory,
      score_history: state.scoreHistory
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mesa-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast("Backup JSON exportado.");
  });
}

// A troca de partida acontece no módulo de conta; aqui só re-renderizamos a mesa.
document.addEventListener("mesa:session-loaded", event => {
  renderAll();
  const name = event.detail?.name;
  if (name) setSessionPill(name.toUpperCase());
});

async function init() {
  loadLocalState();
  renderAll();
  bindSyncIndicator();
  initTheme();
  // Sempre que o placar muda (adicionar/remover jogador), os turnos se atualizam junto.
  initScore(() => renderRounds());
  initRounds();
  initTimer();
  initDice();
  initManagement();
  initLayout();
  document.getElementById("add-player").addEventListener("click", addPlayer);
  document.getElementById("reset-scores").addEventListener("click", resetScores);

  if (!isSupabaseConfigured()) setConnectionStatus("offline", "Local · sem conta");
  setSessionPill("SESSÃO LOCAL");

  await initAccount();
  renderAll();
  hideLoader();
}

/* ------------------------------------------------------------- loader */
// Remove o loader de carregamento quando a página + conta/Supabase estiverem prontos.
// Respeita tempo mínimo de 600ms e máximo de 4s (fallback do localStorage).
const LOADER_MIN_MS = 600;
const LOADER_MAX_MS = 4000;
const loaderStart = Date.now();
let loaderHidden = false;

function hideLoader() {
  if (loaderHidden) return;
  const elapsed = Date.now() - loaderStart;
  const wait = Math.max(0, LOADER_MIN_MS - elapsed);
  window.setTimeout(() => doHideLoader(), wait);
}

function doHideLoader() {
  if (loaderHidden) return;
  loaderHidden = true;
  const loader = document.getElementById("app-loader");
  if (loader) {
    loader.classList.add("is-hidden");
    window.setTimeout(() => {
      loader.remove();
      document.body.classList.remove("is-loading");
      document.body.removeAttribute("aria-busy");
    }, 400);
  } else {
    document.body.classList.remove("is-loading");
    document.body.removeAttribute("aria-busy");
  }
}

// Fallback: se o Supabase demorar demais, esconde o loader após 4s.
window.setTimeout(doHideLoader, LOADER_MAX_MS);

// Também espera o evento window "load" (todos os recursos carregados).
if (document.readyState === "complete") {
  // já carregou antes do módulo rodar
} else {
  window.addEventListener("load", () => {
    // Só adianta o hide se a conta já estiver pronta; init() chama hideLoader ao final.
  }, { once: true });
}

init().catch(async error => {
  console.error(error);
  setConnectionStatus("offline", "Local · sem conta");
  await informativoModal("Não foi possível iniciar", "A aplicação continuará disponível com armazenamento local.");
  hideLoader();
});
