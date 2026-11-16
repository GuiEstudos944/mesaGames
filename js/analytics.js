// Analytics: Google Tag Manager com consentimento LGPD.
//
// - O GTM SÓ é injetado após o usuário aceitar os cookies.
// - Nenhum script do Google carrega antes do "Aceitar".
// - Eventos disparados antes do consentimento ficam em fila e são descartados
//   se o usuário recusar.
// - Sem PII: nenhum e-mail, apelido ou id de usuário vai para o dataLayer.
//
// CSP: sem 'unsafe-inline' — nenhum style="" nem setAttribute("style").
import { ANALYTICS_ID, ANALYTICS_ENABLED } from "./config.js";

const CONSENT_KEY = "mesagames_cookie_consent";
let consent = null;          // null = indeciso, "accepted", "rejected"
let gtmLoaded = false;
const queue = [];            // eventos pendentes enquanto o usuário decide

/* ---------------------------------------------------- consentimento */
function loadConsent() {
  try {
    const v = globalThis.localStorage?.getItem(CONSENT_KEY);
    if (v === "accepted" || v === "rejected") consent = v;
  } catch { /* storage indisponível */ }
}

function saveConsent(value) {
  try { globalThis.localStorage?.setItem(CONSENT_KEY, value); } catch { /* storage indisponível */ }
  consent = value;
}

/* ---------------------------------------------------- GTM */
/** Injeta o script do GTM. Chamado SOMENTE após o consentimento. */
function injectGTM() {
  if (gtmLoaded || !ANALYTICS_ID) return;
  gtmLoaded = true;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ "gtm.start": new Date().getTime(), event: "gtm.js" });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${ANALYTICS_ID}`;
  // Se o adblock bloquear, o site continua funcionando (erro só no console do navegador).
  document.head.appendChild(script);
}

function pushToDataLayer(event, params) {
  if (!window.dataLayer) window.dataLayer = [];
  window.dataLayer.push({ event, ...params });
}

function flushQueue() {
  if (consent === "accepted") {
    while (queue.length) {
      const item = queue.shift();
      pushToDataLayer(item.event, item.params);
    }
  } else {
    queue.length = 0;
  }
}

/* ---------------------------------------------------- API pública */
/**
 * Dispara um evento de analytics. Sem PII.
 * Antes do consentimento: enfileira (se indeciso) ou descarta (se recusou).
 */
export function track(event, params = {}) {
  if (!ANALYTICS_ENABLED || !ANALYTICS_ID) return;
  if (consent === "rejected") return;
  if (consent === "accepted") {
    pushToDataLayer(event, params);
  } else {
    queue.push({ event, params });
  }
}

export function hasConsent() {
  return consent === "accepted";
}

/* ---------------------------------------------------- banner LGPD */
const BANNER_HTML = `
  <div class="cookie-card" role="dialog" aria-labelledby="cookie-title" aria-describedby="cookie-text">
    <p id="cookie-title" class="cookie-title">Cookies e medição</p>
    <p id="cookie-text" class="cookie-text">
      Usamos cookies para entender como o site é usado e melhorar a experiência.
      Nada de dados pessoais: só medimos ações como criar sala e rolar dados.
    </p>
    <p id="cookie-details" class="cookie-details" hidden>
      O que medimos: criação e entrada em salas, rolagem de dados, adição de
      jogadores, início do cronômetro e abertura da ajuda. Não coletamos nome,
      e-mail nem identificador de usuário.
    </p>
    <div class="cookie-actions">
      <button type="button" class="cookie-link" data-cookie-more aria-expanded="false" aria-controls="cookie-details">
        Saiba mais
      </button>
      <div class="cookie-buttons">
        <button type="button" class="cookie-button secondary" data-cookie-reject>Recusar</button>
        <button type="button" class="cookie-button primary" data-cookie-accept>Aceitar</button>
      </div>
    </div>
  </div>`;

let bannerEl = null;

function createBanner() {
  const el = document.createElement("div");
  el.className = "cookie-banner";
  el.innerHTML = BANNER_HTML;
  el.hidden = true;
  document.body.appendChild(el);
  return el;
}

function showBanner() {
  if (!bannerEl) bannerEl = createBanner();
  bannerEl.hidden = false;
  // Move o foco para o primeiro botão interativo do banner.
  window.requestAnimationFrame(() => {
    bannerEl.querySelector('[data-cookie-accept]')?.focus({ preventScroll: true });
  });
}

function hideBanner() {
  if (bannerEl) bannerEl.hidden = true;
}

function decide(accepted) {
  saveConsent(accepted ? "accepted" : "rejected");
  hideBanner();
  if (accepted) {
    injectGTM();
    flushQueue();
  } else {
    flushQueue(); // descarta a fila
  }
}

function bindBanner() {
  if (!bannerEl) return;
  bannerEl.addEventListener("click", event => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.dataset.cookieAccept !== undefined) decide(true);
    else if (target.dataset.cookieReject !== undefined) decide(false);
    else if (target.dataset.cookieMore !== undefined) {
      const details = document.getElementById("cookie-details");
      const expanded = target.getAttribute("aria-expanded") === "true";
      target.setAttribute("aria-expanded", String(!expanded));
      details.hidden = expanded;
    }
  });
}

/* Permite reabrir as preferências pelo rodapé. */
export function openCookiePreferences() {
  showBanner();
}

/* ---------------------------------------------------- init */
function init() {
  loadConsent();

  // Se já aceitou, injeta o GTM imediatamente (e enfileira eventos do primeiro paint).
  if (consent === "accepted") {
    injectGTM();
    flushQueue();
  } else if (consent === null) {
    // Indeciso: mostra o banner (mas só se o analytics estiver habilitado).
    if (ANALYTICS_ENABLED && ANALYTICS_ID) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => { showBanner(); bindBanner(); }, { once: true });
      } else {
        showBanner();
        bindBanner();
      }
    }
  }
  // Se recusou: nada faz. Eventos futuros são descartados por track().

  // Expõe a API global para módulos que não importam diretamente (ex.: help.js).
  globalThis.mesagamesAnalytics = { track, hasConsent, openCookiePreferences };

  // Link "Preferências de cookies" no rodapé reabre o banner.
  document.addEventListener("click", event => {
    const trigger = event.target.closest("[data-cookie-prefs]");
    if (trigger) {
      event.preventDefault();
      showBanner();
      bindBanner();
    }
  });
}

init();
