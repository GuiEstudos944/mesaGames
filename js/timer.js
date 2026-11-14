import { informativoModal, toast } from "./modal.js";
let mode = "stopwatch", running = false, startAt = 0, elapsed = 0, target = 300000, raf = 0, finished = false;
const display = document.getElementById("timer-display");
const toggle = document.getElementById("timer-toggle");
function format(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
  return h > 0 ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}` : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function currentElapsed() { return elapsed + (running ? performance.now() - startAt : 0); }
function draw() {
  const value = currentElapsed();
  display.textContent = format(mode === "countdown" ? target - value : value);
  display.classList.toggle("finished", finished);
}
function tick() {
  const value = currentElapsed();
  if (mode === "countdown" && value >= target) { elapsed = target; running = false; finished = true; toggle.textContent = "▶ Iniciar"; draw(); beep(); informativoModal("Tempo esgotado!", "O tempo configurado para esta rodada terminou."); return; }
  draw(); if (running) raf = requestAnimationFrame(tick);
}
function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)(), osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = "sine"; osc.frequency.value = 880; gain.gain.setValueAtTime(.0001, ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.18, ctx.currentTime + .03); gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .45);
    osc.connect(gain); gain.connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + .5); osc.onended = () => ctx.close();
  } catch (e) { console.warn("Áudio não disponível:", e); }
}
export function initTimer() {
  // Escopo restrito ao painel do relógio: o diálogo de conta também usa ".tab".
  const timerTabs = () => document.querySelectorAll(".timer-panel .tab");
  timerTabs().forEach(tab => tab.addEventListener("click", () => {
    if (running) pause(); mode = tab.dataset.mode; timerTabs().forEach(t => { const active = t === tab; t.classList.toggle("active", active); t.setAttribute("aria-selected", String(active)); });
    document.getElementById("timer-config").hidden = mode !== "countdown"; document.getElementById("timer-hint").textContent = mode === "countdown" ? "Defina a duração antes de iniciar." : "Conte o tempo da sua partida.";
    reset(false);
  }));
  toggle.addEventListener("click", () => running ? pause() : start());
  document.getElementById("timer-reset").addEventListener("click", () => reset(true));
  ["timer-minutes","timer-seconds"].forEach(id => document.getElementById(id).addEventListener("change", updateTarget));
  updateTarget(); draw();
}
function updateTarget() { const min = Math.min(999, Math.max(0, Number(document.getElementById("timer-minutes").value) || 0)); const sec = Math.min(59, Math.max(0, Number(document.getElementById("timer-seconds").value) || 0)); target = (min * 60 + sec) * 1000; if (!running && mode === "countdown") draw(); }
function start() { if (mode === "countdown") updateTarget(); if (mode === "countdown" && target <= 0) return toast("Defina um tempo maior que zero.", "error"); if (finished) reset(false); running = true; startAt = performance.now(); toggle.textContent = "Ⅱ Pausar"; cancelAnimationFrame(raf); raf = requestAnimationFrame(tick); }
function pause() { elapsed = currentElapsed(); running = false; cancelAnimationFrame(raf); toggle.textContent = "▶ Iniciar"; draw(); }
function reset(showToast) { running = false; cancelAnimationFrame(raf); elapsed = 0; finished = false; display.classList.remove("finished"); toggle.textContent = "▶ Iniciar"; if (mode === "countdown") updateTarget(); draw(); if (showToast) toast("Relógio zerado."); }
