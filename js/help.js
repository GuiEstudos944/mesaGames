// Painel de ajuda "Como usar" + FAQ.
// O conteúdo vive sempre no HTML (indexável pelos buscadores). O abrir/fechar
// é feito só por classe CSS (.is-open): nada de `hidden` nem `display:none`,
// para o texto continuar no DOM mesmo com o painel fechado.
// CSP: sem 'unsafe-inline' — nenhum style="" nem setAttribute("style").
import { registerModalLayer, unregisterModalLayer } from "./modal.js";
import { track } from "./analytics.js";

const HELP_KEY = "help-dialog";

const dialog = document.getElementById("help-dialog");
const openButton = document.getElementById("help-open");
const closeButton = document.getElementById("help-close");

let lastFocused = null;

const isOpen = () => dialog?.classList.contains("is-open") ?? false;

/** Bloco (c): dispara evento quando o painel de ajuda é aberto. */
function trackHelpOpen() {
  track("ajuda_aberta");
}

function resetFaq() {
  dialog.querySelectorAll(".faq-item.is-open").forEach(item => {
    item.classList.remove("is-open");
    item.querySelector(".faq-question")?.setAttribute("aria-expanded", "false");
  });
}

function openHelp() {
  if (!dialog || isOpen()) return;
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : openButton;
  dialog.classList.add("is-open");
  openButton.setAttribute("aria-expanded", "true");
  document.body.classList.add("help-open");
  // O modal.js cuida do Esc, do trap de Tab, do scroll do fundo e de devolver o
  // foco — mas não usamos o `hidden` no fechamento, então o painel nunca ganha
  // o atributo `hidden` (o texto precisa continuar no DOM).
  registerModalLayer(HELP_KEY, dialog, () => closeHelp());
  trackHelpOpen();
  const panel = dialog.querySelector('[role="dialog"]');
  window.requestAnimationFrame(() => panel?.focus({ preventScroll: true }));
}

function closeHelp() {
  if (!dialog || !isOpen()) return;
  dialog.classList.remove("is-open");
  openButton.setAttribute("aria-expanded", "false");
  document.body.classList.remove("help-open");
  resetFaq();
  unregisterModalLayer(HELP_KEY);
  // removeLayer() marca `element.hidden = true`; desfazemos para o conteúdo
  // seguir no DOM. A visibilidade continua controlada por CSS (.is-open).
  dialog.hidden = false;
  (lastFocused?.isConnected ? lastFocused : openButton)?.focus({ preventScroll: true });
  lastFocused = null;
}

function toggleHelp() {
  if (isOpen()) closeHelp();
  else openHelp();
}

function bindFaq() {
  dialog?.querySelectorAll(".faq-question").forEach(button => {
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") === "true";
      button.closest(".faq-item")?.classList.toggle("is-open", !expanded);
      button.setAttribute("aria-expanded", String(!expanded));
    });
  });
}

export function initHelp() {
  if (!dialog || !openButton) return;
  openButton.addEventListener("click", toggleHelp);
  closeButton?.addEventListener("click", closeHelp);
  dialog.addEventListener("click", event => {
    if (event.target instanceof HTMLElement && event.target.dataset.close !== undefined) closeHelp();
  });
  bindFaq();
}
