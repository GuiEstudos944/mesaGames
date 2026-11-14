const root = document.getElementById("modal-root");
const toastRegion = document.getElementById("toast-region");
let activeCleanup = null;

function openModal({ title, message, confirmText = "Confirmar", cancelText = "Cancelar", danger = false, requireWord = null, input = null, info = false }) {
  if (activeCleanup) activeCleanup(false);
  const previous = document.activeElement;
  const id = `dialog-${Math.random().toString(36).slice(2)}`;
  // Estrutura fixa: nenhum dado dinâmico é interpolado em HTML (evita XSS).
  // `id` é aleatório em hexadecimal e `danger` é booleano; todo texto entra
  // depois por textContent. `title`/`message` são usados só em textContent.
  root.innerHTML = `<div class="modal-overlay" data-overlay><section class="modal-box" role="dialog" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-message"><h3 id="${id}-title"></h3><p id="${id}-message"></p><div data-extra></div><div class="modal-actions"><button class="button secondary" data-cancel type="button"></button><button class="button ${danger ? "danger" : "primary"}" data-confirm type="button"></button></div></section></div>`;
  const overlay = root.querySelector("[data-overlay]"), box = root.querySelector(".modal-box");
  root.querySelector("h3").textContent = title; root.querySelector("p").textContent = message;
  const extra = root.querySelector("[data-extra]"), cancel = root.querySelector("[data-cancel]"), confirm = root.querySelector("[data-confirm]");
  cancel.textContent = cancelText; confirm.textContent = confirmText;
  if (input) {
    const field = document.createElement("input"); field.className = "modal-input"; field.value = input.value ?? ""; field.placeholder = input.placeholder ?? ""; field.maxLength = 60; field.setAttribute("aria-label", input.label || "Novo nome");
    extra.append(field); input.field = field;
  }
  if (requireWord) {
    const label = document.createElement("label"); label.className = "modal-label"; label.textContent = `Digite ${requireWord} para liberar a confirmação`;
    const field = document.createElement("input"); field.className = "modal-input"; field.placeholder = requireWord; field.autocomplete = "off"; field.setAttribute("aria-label", `Digite ${requireWord}`);
    extra.append(label, field); confirm.disabled = true;
    field.addEventListener("input", () => { confirm.disabled = field.value.trim() !== requireWord; });
  }
  if (info) cancel.hidden = true;
  let settled = false, resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const finish = value => {
    if (settled) return; settled = true;
    overlay.classList.remove("open");
    setTimeout(() => { root.innerHTML = ""; previous?.focus?.(); resolvePromise(value); }, 180);
    document.removeEventListener("keydown", onKey);
    activeCleanup = null;
  };
  const onKey = event => {
    if (event.key === "Escape") { event.preventDefault(); finish(false); }
    if (event.key === "Enter" && !confirm.disabled) { event.preventDefault(); finish(info ? true : true); }
    if (event.key === "Tab") {
      const focusable = [...box.querySelectorAll("button:not([hidden]):not(:disabled),input:not(:disabled)")];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  cancel.addEventListener("click", () => finish(false));
  confirm.addEventListener("click", () => finish(true));
  overlay.addEventListener("click", e => { if (e.target === overlay) finish(false); });
  document.addEventListener("keydown", onKey);
  activeCleanup = finish;
  requestAnimationFrame(() => { overlay.classList.add("open"); (cancel.hidden ? confirm : cancel).focus(); });
  promise.input = input?.field;
  return promise;
}
/** Atualiza o indicador de conexão/sincronização do topo. */
export function setConnectionStatus(type, text) {
  const el = document.getElementById("connection-status");
  if (!el) return;
  el.className = `connection ${type}`;
  const label = el.querySelector("span");
  if (label) label.textContent = text;
}
/** Atualiza a etiqueta "painel da partida" com o nome da partida ativa. */
export function setSessionPill(text) {
  const el = document.getElementById("session-pill-label");
  if (el) el.textContent = text;
}
export function confirmarModal(options = {}) { return openModal(options); }
export async function editarNomeModal(currentName, options = {}) {
  const input = {
    value: currentName,
    placeholder: options.placeholder || "Nome do jogador",
    label: options.label || "Nome do jogador"
  };
  const promise = openModal({
    title: options.title || "Editar jogador",
    message: options.message || "Escolha como este jogador será chamado.",
    confirmText: options.confirmText || "Salvar",
    input
  });
  const accepted = await promise;
  return accepted ? (input.field?.value?.trim() || currentName) : null;
}
export function informativoModal(title, message) { return openModal({ title, message, confirmText: "Entendi", info: true }); }
export function toast(message, type = "success", duration = 3000) {
  const item = document.createElement("div"); item.className = `toast ${type}`; item.textContent = message;
  toastRegion.append(item);
  setTimeout(() => { item.classList.add("leaving"); setTimeout(() => item.remove(), 220); }, duration);
}
