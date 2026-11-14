// ============================================================================
// Dados 2D do MesaGames
// ----------------------------------------------------------------------------
// • Um chip por tipo (d4, d6, d8, d10, d12, d20 e d100).
// • Dá para misturar tipos na mesma rolagem (ex.: 2d6 + 1d20).
// • Cada dado é um SVG com a forma do tipo e o número no centro.
// • Animação só com CSS/Web Animations API (sem Three.js, sem bibliotecas).
// ============================================================================

import { state, saveLocalState } from "./state.js";
import { confirmarModal, toast } from "./modal.js";
import { insertDiceRoll, scheduleSync } from "./supabase.js";

/* --------------------------------------------------------------- constantes */

const SVG_NS = "http://www.w3.org/2000/svg";

// Cada tipo tem faces, rótulo e uma cor própria (identificação rápida na mesa).
const DICE_TYPES = [
  { sides: 4,   label: "d4",   color: "#ff8a5c" },
  { sides: 6,   label: "d6",   color: "#6aa4ff" },
  { sides: 8,   label: "d8",   color: "#5fd6c4" },
  { sides: 10,  label: "d10",  color: "#a8ed69" },
  { sides: 12,  label: "d12",  color: "#c49bff" },
  { sides: 20,  label: "d20",  color: "#f2d36b" },
  { sides: 100, label: "d100", color: "#ff82b2" }
];
const TYPE_BY_SIDES = new Map(DICE_TYPES.map(type => [type.sides, type]));

// Formas SVG (viewBox 0 0 100 100): triângulo (d4), quadrado (d6), losango (d8),
// pentágono (d10 e d12), hexágono (d20). O d100 usa o contorno do d10.
const DIE_SHAPES = {
  4: "50,8 90,80 10,80",
  6: "16,16 84,16 84,84 16,84",
  8: "50,4 92,50 50,96 8,50",
  10: "50,7 89,37 74,84 26,84 11,37",
  12: "50,7 89,37 74,84 26,84 11,37",
  20: "50,6 88,28 88,72 50,94 12,72 12,28",
  100: "50,7 89,37 74,84 26,84 11,37"
};

const MAX_PER_TYPE = 6;      // máximo de dados de um mesmo tipo
const MAX_TOTAL = 12;        // máximo somando todos os tipos
const ROLL_DURATION = 950;   // duração base da animação (ms)
const STAGGER = 90;          // atraso entre dados (efeito cascata)

/* ------------------------------------------------------------ estado local */

const pool = new Map();      // sides -> quantidade escolhida
const chipRefs = new Map();  // sides -> { chip, count, remove }
let rolling = false;         // trava enquanto anima
let currentRoll = null;      // { specs, dice, modifier } da última rolagem

/* --------------------------------------------------------------- utilidades */

const reducaoMovimento = () =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

/** Inteiro uniforme de 1 a `faces` (sem viés) usando crypto.getRandomValues. */
function aleatorio(faces) {
  if (faces <= 1) return 1;
  const buffer = new Uint32Array(1);
  const faixa = 0x100000000;              // 2^32
  const limite = faixa - (faixa % faces); // descarta a "cauda" enviesada
  let n;
  do { crypto.getRandomValues(buffer); n = buffer[0]; } while (n >= limite);
  return (n % faces) + 1;
}

/** d100 = dois d10 (dezenas e unidades). "00 + 0" vale 100. */
function rolarD100() {
  const dezenas = aleatorio(10) - 1;
  const unidades = aleatorio(10) - 1;
  const total = dezenas * 10 + unidades;
  return total === 0 ? 100 : total;
}

/** Valor final de um dado conforme o tipo. */
function rolarValor(sides) { return sides === 100 ? rolarD100() : aleatorio(sides); }

/** Monta a notação "2d6 + 1d20 + 3" a partir de um mapa sides -> quantidade. */
function formatarNotacao(grupos, modifier = 0) {
  const partes = [];
  DICE_TYPES.forEach(type => {
    const count = grupos.get(type.sides) || 0;
    if (count) partes.push(`${count}${type.label}`);
  });
  let texto = partes.join(" + ");
  if (modifier > 0) texto += (texto ? " + " : "") + modifier;
  else if (modifier < 0) texto += `${texto ? " " : ""}− ${Math.abs(modifier)}`;
  return texto;
}

function gruposDeSpecs(specs) {
  const grupos = new Map();
  specs.forEach(spec => grupos.set(spec.sides, (grupos.get(spec.sides) || 0) + 1));
  return grupos;
}

function limitarModificador(valor) {
  const n = Math.trunc(Number(valor) || 0);
  return Math.max(-999, Math.min(999, n));
}

/* ---------------------------------------------------------------- SVG */

/** SVG com a forma do dado (reutilizado no chip pequeno e no dado da mesa). */
function svgDaForma(sides, className) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  const poly = document.createElementNS(SVG_NS, "polygon");
  poly.setAttribute("points", DIE_SHAPES[sides] || DIE_SHAPES[6]);
  poly.setAttribute("class", className);
  svg.append(poly);
  return svg;
}

/** Cria um dado da mesa: SVG (forma + número) dentro de um botão clicável. */
function criarDado({ sides, value = null }) {
  const die = document.createElement("button");
  die.type = "button";
  die.className = "die" + (sides === 100 ? " die-percentile" : "");
  die.dataset.sides = String(sides);
  die.title = "Clique para rolar só este dado";
  die.setAttribute("aria-label", `d${sides}${value == null ? "" : `: ${value}`}. Clique para rolar novamente.`);

  const svg = svgDaForma(sides, "die-shape");
  const texto = document.createElementNS(SVG_NS, "text");
  texto.setAttribute("x", "50");
  texto.setAttribute("y", sides === 4 ? "60" : "55");
  texto.setAttribute("text-anchor", "middle");
  texto.setAttribute("dominant-baseline", "central");
  texto.setAttribute("class", "die-number");
  texto.textContent = value == null ? "?" : String(value);
  svg.append(texto);

  die.append(svg);
  return die;
}

/** Troca (rapidamente, durante a animação) o número mostrado no dado. */
function definirNumero(die, valor) {
  const texto = die.querySelector(".die-number");
  if (texto) texto.textContent = valor == null ? "?" : String(valor);
}

/** Marca resultado máximo (dourado) e mínimo (vermelho/tremida). */
function aplicarDestaque(die, valor, sides) {
  die.classList.remove("is-max", "is-min");
  const maximo = sides === 100 ? 100 : sides;
  if (valor === maximo) die.classList.add("is-max");
  else if (valor === 1) die.classList.add("is-min");
}

/* ------------------------------------------------------------- animação 2D */

/** Anima um dado (pulo + giro em 2D) e trava o número final. */
function animarDado(die, valorFinal, { delay = 0, duration = ROLL_DURATION } = {}) {
  const sides = Number(die.dataset.sides) || 6;

  // Acessibilidade: sem movimento, apenas um fade com o resultado final.
  if (reducaoMovimento()) {
    definirNumero(die, valorFinal);
    return die.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay, fill: "none" }).finished;
  }

  const voltas = sides >= 20 ? 3 : 2;
  const totalDeg = voltas * 360;
  // Antecipação: leve encolhimento + rotação contrária antes do pulo principal.
  const quadros = [
    { transform: "translateY(0) rotate(0deg) scale(1)", offset: 0 },
    { transform: "translateY(2px) rotate(-12deg) scale(.88)", offset: 0.08 }, // antecipação
    { transform: `translateY(-36px) rotate(${totalDeg * 0.25}deg) scale(1.22)`, offset: 0.28 }, // salto alto
    { transform: `translateY(6px) rotate(${totalDeg * 0.5}deg) scale(0.92)`, offset: 0.52 }, // impacto no "chão"
    { transform: `translateY(-18px) rotate(${totalDeg * 0.75}deg) scale(1.1)`, offset: 0.74 }, // segundo pulo menor
    { transform: `translateY(0) rotate(${totalDeg}deg) scale(1)`, offset: 0.92 }, // pouso
    { transform: `translateY(0) rotate(${totalDeg}deg) scale(1.12)`, offset: 0.96 }, // squash no impacto
    { transform: `translateY(0) rotate(${totalDeg}deg) scale(1)`, offset: 1 } // relaxa
  ];
  const animacao = die.animate(quadros, {
    duration: duration + (sides >= 20 ? 180 : 0),
    delay,
    easing: "cubic-bezier(.25, .1, .25, 1)",
    fill: "none"
  });

  // Efeito "embaralhar": o número troca rápido, acelerando no meio da rolagem.
  let embaralharTimer = null;
  const intervalos = [110, 85, 60, 45, 55, 70, 95];
  let i = 0;
  const embaralhar = () => {
    definirNumero(die, rolarValor(sides));
    i = Math.min(i + 1, intervalos.length - 1);
    embaralharTimer = setTimeout(embaralhar, intervalos[i]);
  };
  embaralharTimer = setTimeout(embaralhar, 40);

  const parar = () => {
    clearTimeout(embaralharTimer);
    definirNumero(die, valorFinal);
    // Pulso de chegada: leve escala para destacar o resultado travado.
    die.animate(
      [
        { transform: `scale(1)` },
        { transform: `scale(1.18)` },
        { transform: `scale(1)` }
      ],
      { duration: 280, easing: "ease-out", fill: "none" }
    );
  };
  return animacao.finished.then(parar, parar);
}

/* ------------------------------------------------------- seletor (chips) */

function construirChip(type) {
  const slot = document.createElement("div");
  slot.className = "dice-chip-slot";
  slot.style.setProperty("--die-color", type.color);

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "dice-chip";
  chip.dataset.sides = String(type.sides);

  const forma = document.createElement("span");
  forma.className = "dice-chip-shape";
  forma.append(svgDaForma(type.sides, "dice-chip-poly"));

  const rotulo = document.createElement("span");
  rotulo.className = "dice-chip-label";
  rotulo.textContent = type.label;

  const contador = document.createElement("span");
  contador.className = "dice-chip-count";
  contador.textContent = "0";

  chip.append(forma, rotulo, contador);

  const remover = document.createElement("button");
  remover.type = "button";
  remover.className = "dice-chip-remove";
  remover.textContent = "−";
  remover.hidden = true;
  remover.tabIndex = -1;

  chip.addEventListener("click", () => adicionarDado(type.sides));
  remover.addEventListener("click", () => removerDado(type.sides));

  slot.append(chip, remover);
  chipRefs.set(type.sides, { chip, count: contador, remove: remover });
  return slot;
}

/** Cria os chips uma única vez. */
function renderPoolChips() {
  const container = document.getElementById("dice-pool");
  if (!container) return;
  container.replaceChildren();
  chipRefs.clear();
  DICE_TYPES.forEach(type => container.append(construirChip(type)));
}

/** Atualiza contadores, notação, botão de rolar e botões de remover. */
function renderPool() {
  DICE_TYPES.forEach(type => {
    const ref = chipRefs.get(type.sides);
    if (!ref) return;
    const count = pool.get(type.sides) || 0;
    ref.count.textContent = String(count);
    ref.chip.classList.toggle("has-dice", count > 0);
    ref.chip.setAttribute("aria-label", count
      ? `${type.label}: ${count} selecionado(s). Toque para adicionar outro.`
      : `Adicionar um ${type.label}`);
    ref.remove.hidden = count === 0;
    ref.remove.setAttribute("aria-label", `Remover um ${type.label}`);
  });

  const total = totalDados();
  const notation = document.getElementById("dice-pool-notation");
  if (notation) {
    notation.textContent = total ? formatarNotacao(pool) : "Escolha os dados";
    notation.classList.toggle("is-empty", total === 0);
  }
  atualizarBotaoRolar();
}

function atualizarBotaoRolar() {
  const botao = document.getElementById("roll-dice");
  if (botao) botao.disabled = rolling || totalDados() === 0;
}

function totalDados() {
  let total = 0;
  pool.forEach(count => { total += count; });
  return total;
}

function adicionarDado(sides) {
  if (rolling) return;
  const type = TYPE_BY_SIDES.get(sides);
  const atual = pool.get(sides) || 0;
  if (atual >= MAX_PER_TYPE) { toast(`Máximo de ${MAX_PER_TYPE} dados ${type?.label || ""} por rolagem.`, "error"); return; }
  if (totalDados() >= MAX_TOTAL) { toast(`Máximo de ${MAX_TOTAL} dados por rolagem.`, "error"); return; }
  pool.set(sides, atual + 1);
  renderPool();
}

function removerDado(sides) {
  if (rolling) return;
  const atual = pool.get(sides) || 0;
  if (atual <= 1) pool.delete(sides);
  else pool.set(sides, atual - 1);
  renderPool();
}

function limparSelecao() {
  if (rolling) return;
  pool.clear();
  renderPool();
}

/** Habilita/desabilita o seletor inteiro durante a animação. */
function alternarSeletor(desabilitado) {
  document
    .querySelectorAll("#dice-pool button, #dice-pool input, .dice-modifier button, .dice-modifier input, #dice-pool-clear")
    .forEach(el => { el.disabled = desabilitado; });
}

/* ------------------------------------------------------------ modificador */

function iniciarModificador() {
  const input = document.getElementById("dice-modifier");
  if (!input) return;
  input.addEventListener("change", () => { input.value = limitarModificador(input.value); });
  document.querySelectorAll(".dice-modifier [data-mod]").forEach(botao => {
    botao.addEventListener("click", () => {
      input.value = limitarModificador(limitarModificador(input.value) + Number(botao.dataset.mod));
    });
  });
}

/* --------------------------------------------------------------- rolagem */

/** Lê o seletor e devolve a lista (na ordem dos tipos) dos dados a rolar. */
function dadosSelecionados() {
  const specs = [];
  DICE_TYPES.forEach(type => {
    const count = pool.get(type.sides) || 0;
    for (let i = 0; i < count; i++) specs.push({ sides: type.sides });
  });
  return specs;
}

async function rolarDados() {
  if (rolling) return;
  const specs = dadosSelecionados();
  if (!specs.length) { toast("Escolha pelo menos um dado para rolar.", "error"); return; }

  const modifier = limitarModificador(document.getElementById("dice-modifier")?.value);
  rolling = true;
  atualizarBotaoRolar();
  alternarSeletor(true);

  // Sorteia os valores finais antes da animação (revelados só no fim).
  specs.forEach(spec => { spec.value = rolarValor(spec.sides); });

  const stage = document.getElementById("dice-stage");
  stage.replaceChildren();
  const dice = specs.map(spec => criarDado({ sides: spec.sides }));
  dice.forEach((die, index) => {
    die.addEventListener("click", () => rerrolarDado(index));
    stage.append(die);
  });

  currentRoll = { specs, dice, modifier };

  // Efeito cascata: cada dado começa um pouco depois do anterior.
  await Promise.all(dice.map((die, index) =>
    animarDado(die, specs[index].value, { delay: index * STAGGER })
  ));

  finalizarRolagem(specs, modifier, { registrar: true });

  rolling = false;
  alternarSeletor(false);
  atualizarBotaoRolar();
}

/** Rerrola apenas o dado clicado, mantendo os demais intactos. */
async function rerrolarDado(index) {
  if (rolling || !currentRoll) return;
  const { specs, dice, modifier } = currentRoll;
  const spec = specs[index];
  const die = dice[index];
  if (!spec || !die) return;

  rolling = true;
  atualizarBotaoRolar();

  spec.value = rolarValor(spec.sides);
  await animarDado(die, spec.value, { delay: 0 });

  finalizarRolagem(specs, modifier, { registrar: false });
  atualizarUltimoHistorico(specs, modifier);

  rolling = false;
  atualizarBotaoRolar();
}

/** Aplica números finais, destaques, totais e (opcional) grava no histórico. */
function finalizarRolagem(specs, modifier, { registrar }) {
  currentRoll?.dice.forEach((die, index) => {
    const spec = specs[index];
    if (!spec) return;
    definirNumero(die, spec.value);
    aplicarDestaque(die, spec.value, spec.sides);
  });

  const valores = specs.map(spec => spec.value);
  const total = valores.reduce((soma, valor) => soma + valor, 0) + modifier;
  mostrarResultado(specs, valores, modifier, total);

  if (!registrar) return;
  const entrada = {
    notation: formatarNotacao(gruposDeSpecs(specs), modifier),
    dice: specs.map(spec => ({ sides: spec.sides, value: spec.value })),
    results: valores,
    modifier,
    total,
    at: new Date().toISOString()
  };
  state.diceHistory.unshift(entrada);
  state.diceHistory = state.diceHistory.slice(0, 10);
  saveLocalState();
  renderHistory();
  insertDiceRoll(entrada).catch(error => {
    console.error(error);
    toast("Rolagem salva localmente; falha ao sincronizar.", "error");
  });
}

/** Atualiza a área "RESULTADO" e a lista individual (ex.: 4 + 3 + 17 = 24). */
function mostrarResultado(specs, valores, modifier, total) {
  const totalEl = document.getElementById("dice-total");
  if (totalEl) totalEl.textContent = String(total);

  const box = document.getElementById("dice-individual");
  if (!box) return;
  box.replaceChildren();

  const notacao = document.createElement("span");
  notacao.className = "dice-individual-notation";
  notacao.textContent = formatarNotacao(gruposDeSpecs(specs), modifier) || "—";

  const linha = document.createElement("span");
  linha.className = "dice-individual-line";
  valores.forEach((valor, index) => {
    if (index) linha.append(document.createTextNode(" + "));
    const item = document.createElement("b");
    item.textContent = String(valor);
    const sides = specs[index].sides;
    if (valor === (sides === 100 ? 100 : sides)) item.classList.add("max");
    else if (valor === 1) item.classList.add("min");
    linha.append(item);
  });
  linha.append(document.createTextNode(` = ${total}`));

  box.append(notacao, linha);
}

/** Mantém o registro mais recente do histórico igual à rolagem atual. */
function atualizarUltimoHistorico(specs, modifier) {
  const ultimo = state.diceHistory[0];
  if (!ultimo) return;
  const valores = specs.map(spec => spec.value);
  ultimo.notation = formatarNotacao(gruposDeSpecs(specs), modifier);
  ultimo.dice = specs.map(spec => ({ sides: spec.sides, value: spec.value }));
  ultimo.results = valores;
  ultimo.modifier = modifier;
  ultimo.total = valores.reduce((soma, valor) => soma + valor, 0) + modifier;
  ultimo.at = new Date().toISOString();
  saveLocalState();
  renderHistory();
  scheduleSync();
}

/* ------------------------------------------------------------- histórico */

export function renderDiceHistory() { renderHistory(); }

function renderHistory() {
  const lista = document.getElementById("dice-history");
  if (!lista) return;
  lista.replaceChildren();

  if (!state.diceHistory.length) {
    const vazio = document.createElement("li");
    vazio.className = "empty-history";
    vazio.textContent = "Nenhuma rolagem ainda.";
    lista.append(vazio);
    return;
  }

  state.diceHistory.slice(0, 10).forEach(rolagem => {
    const item = document.createElement("li");

    const notacao = document.createElement("span");
    notacao.className = "history-notation";
    notacao.textContent = rolagem.notation || rolagem.type || "rolagem";

    const total = document.createElement("b");
    total.textContent = String(rolagem.total);

    const valores = document.createElement("span");
    valores.className = "history-values";
    valores.textContent = (rolagem.results || []).join(" + ");

    item.append(notacao, total, valores);
    lista.append(item);
  });
}

async function limparHistorico() {
  const confirmado = await confirmarModal({
    title: "Limpar histórico de dados?",
    message: "As últimas rolagens serão removidas permanentemente.",
    confirmText: "Limpar",
    danger: true
  });
  if (!confirmado) return;
  state.diceHistory = [];
  saveLocalState();
  scheduleSync();
  renderHistory();
  toast("Histórico de dados limpo.");
}

/* ------------------------------------------------------------------- init */

export function initDice() {
  renderPoolChips();
  renderPool();
  renderHistory();
  iniciarModificador();
  document.getElementById("roll-dice")?.addEventListener("click", rolarDados);
  document.getElementById("clear-dice-history")?.addEventListener("click", limparHistorico);
  document.getElementById("dice-pool-clear")?.addEventListener("click", limparSelecao);
}
