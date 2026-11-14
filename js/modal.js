const root = document.getElementById("modal-root");
const toastRegion = document.getElementById("toast-region");
const modalLayers = [];
let savedBodyOverflow = "";
let bodyScrollLocked = false;
let lastInvokingElement = null;

document.addEventListener("pointerdown", event => {
  const trigger = event.target.closest?.('button, a[href], input, select, textarea, [role="button"]');
  if (trigger) lastInvokingElement = trigger;
}, true);

document.addEventListener("click", event => {
  const trigger = event.target.closest?.('button, a[href], input, select, textarea, [role="button"]');
  if (trigger) lastInvokingElement = trigger;
}, true);

document.addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const trigger = event.target.closest?.('button, a[href], input, select, textarea, [role="button"]');
  if (trigger) lastInvokingElement = trigger;
}, true);

function focusOrigin() {
  return document.activeElement !== document.body
    ? document.activeElement
    : lastInvokingElement;
}

function focusableWithin(element) {
  return [...element.querySelectorAll(
    'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'
  )].filter(item => !item.hidden && item.getClientRects().length && !item.closest("[inert]"));
}

function syncModalLayers() {
  const hasLayers = modalLayers.length > 0;
  if (hasLayers && !bodyScrollLocked) {
    savedBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    bodyScrollLocked = true;
    document.addEventListener("keydown", onModalKeydown, true);
  } else if (!hasLayers && bodyScrollLocked) {
    document.body.style.overflow = savedBodyOverflow;
    savedBodyOverflow = "";
    bodyScrollLocked = false;
    document.removeEventListener("keydown", onModalKeydown, true);
  }

  modalLayers.forEach((layer, index) => {
    const isTop = index === modalLayers.length - 1;
    layer.element.inert = !isTop;
    layer.element.setAttribute("aria-hidden", String(!isTop));
    layer.element.style.zIndex = String(100 + index * 10);
    layer.element.classList.toggle("is-underlay", !isTop);
  });
}

function removeLayer(layer) {
  const index = modalLayers.indexOf(layer);
  if (index < 0) return;
  modalLayers.splice(index, 1);
  if (layer.type === "custom") {
    layer.element.classList.remove("open");
    layer.element.inert = true;
    layer.element.setAttribute("aria-hidden", "true");
    window.setTimeout(() => layer.element.remove(), 180);
  } else {
    layer.element.hidden = true;
  }
  syncModalLayers();
  if (layer.previousFocus?.isConnected && !layer.previousFocus.closest("[inert]")) {
    layer.previousFocus.focus?.({ preventScroll: true });
  }
}

function onModalKeydown(event) {
  const top = modalLayers.at(-1);
  if (!top) return;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    top.close(false);
    return;
  }

  if (event.key !== "Tab") return;
  const focusable = focusableWithin(top.element);
  if (!focusable.length) {
    event.preventDefault();
    top.element.querySelector('[role="dialog"]')?.focus?.();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !top.element.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !top.element.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

/** Registra um diálogo HTML existente na mesma pilha dos modais customizados. */
export function registerModalLayer(key, element, close) {
  if (!element || modalLayers.some(layer => layer.key === key)) return;
  const layer = {
    key,
    type: "external",
    element,
    close,
    previousFocus: focusOrigin()
  };
  modalLayers.push(layer);
  syncModalLayers();
  window.requestAnimationFrame(() => focusableWithin(element)[0]?.focus());
}

export function unregisterModalLayer(key) {
  const layer = modalLayers.find(item => item.key === key);
  if (layer) removeLayer(layer);
}

export function hasOpenModal() {
  return modalLayers.length > 0;
}

function openModal({ title, message, confirmText = "Confirmar", cancelText = "Cancelar", danger = false, requireWord = null, input = null, info = false, onConfirm = null }) {
  const previous = focusOrigin();
  const id = `dialog-${Math.random().toString(36).slice(2)}`;
  // Estrutura fixa: nenhum dado dinâmico é interpolado em HTML (evita XSS).
  // `id` é aleatório em hexadecimal e `danger` é booleano; todo texto entra
  // depois por textContent. `title`/`message` são usados só em textContent.
  const wrapper = document.createElement("div");
  wrapper.innerHTML = `<div class="modal-overlay" data-overlay><section class="modal-box" role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="${id}-title" aria-describedby="${id}-message"><h3 id="${id}-title"></h3><p id="${id}-message"></p><div data-extra></div><p class="modal-form-error" data-error role="alert" hidden></p><div class="modal-actions"><button class="button secondary" data-cancel type="button"></button><button class="button ${danger ? "danger" : "primary"}" data-confirm type="button"></button></div></section></div>`;
  const overlay = wrapper.firstElementChild;
  overlay.querySelector("h3").textContent = title;
  overlay.querySelector("p").textContent = message;
  const extra = overlay.querySelector("[data-extra]");
  const cancel = overlay.querySelector("[data-cancel]");
  const confirm = overlay.querySelector("[data-confirm]");
  const errorMessage = overlay.querySelector("[data-error]");
  cancel.textContent = cancelText; confirm.textContent = confirmText;
  if (input) {
    const field = document.createElement("input"); field.className = "modal-input"; field.value = input.value ?? ""; field.placeholder = input.placeholder ?? ""; field.maxLength = input.maxLength ?? 60; field.setAttribute("aria-label", input.label || "Novo nome");
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
    if (settled) return;
    settled = true;
    removeLayer(layer);
    window.setTimeout(() => resolvePromise(value), 180);
  };
  const submit = async () => {
    if (settled || confirm.disabled) return;
    if (typeof onConfirm === "function") {
      confirm.disabled = true;
      errorMessage.hidden = true;
      errorMessage.textContent = "";
      try {
        if (await onConfirm(input?.field?.value?.trim()) === false) return;
      } catch (error) {
        errorMessage.textContent = error?.message || "Não foi possível concluir. Revise os dados e tente novamente.";
        errorMessage.hidden = false;
        return;
      } finally {
        if (!settled) confirm.disabled = false;
      }
    }
    finish(true);
  };
  const layer = { key: `custom-${id}`, type: "custom", element: overlay, close: finish, previousFocus: previous };
  cancel.addEventListener("click", () => finish(false));
  confirm.addEventListener("click", submit);
  overlay.addEventListener("click", e => { if (e.target === overlay) finish(false); });
  root.append(overlay);
  modalLayers.push(layer);
  syncModalLayers();
  window.requestAnimationFrame(() => {
    overlay.classList.add("open");
    (cancel.hidden ? confirm : cancel).focus();
  });
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
    label: options.label || "Nome do jogador",
    maxLength: options.maxLength ?? 60
  };
  const promise = openModal({
    title: options.title || "Editar jogador",
    message: options.message || "Escolha como este jogador será chamado.",
    confirmText: options.confirmText || "Salvar",
    input,
    onConfirm: options.onSubmit
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
