// Rodadas e turnos.
// Um TURNO é a vez de um jogador; a RODADA fecha quando todos os jogadores
// jogaram (com 4 jogadores, a rodada termina no 4º turno).
import { state, saveLocalState } from "./state.js";
import { confirmarModal, toast } from "./modal.js";
import { saveGameState } from "./supabase.js";

const playerCount = () => Math.max(1, state.players.length);

/** Jogador da vez — a ordem da rodada começa em quem inicia (starterIndex). */
export function currentPlayer() {
  return state.players[(state.starterIndex + state.turn - 1) % playerCount()] || null;
}

export function initRounds() {
  document.getElementById("next-turn").addEventListener("click", () => {
    const n = playerCount();
    if (state.turn < n) {
      state.turn++;
      update();
      return;
    }
    // Todos já jogaram: fecha a rodada e o próximo jogador inicia a seguinte.
    state.round++;
    state.turn = 1;
    state.starterIndex = (state.starterIndex + 1) % n;
    update();
    toast(`Rodada ${state.round} começou.`);
  });

  // Pular turnos restantes e ir direto para a próxima rodada.
  document.getElementById("next-round").addEventListener("click", () => {
    state.round++;
    state.turn = 1;
    state.starterIndex = (state.starterIndex + 1) % playerCount();
    update();
  });

  document.getElementById("previous-round").addEventListener("click", () => {
    const n = playerCount();
    state.round = Math.max(1, state.round - 1);
    state.turn = 1;
    state.starterIndex = (state.starterIndex - 1 + n) % n;
    update();
  });

  document.getElementById("reset-round").addEventListener("click", async () => {
    if (await confirmarModal({ title: "Reiniciar rodadas?", message: "A rodada voltará para 1 e o primeiro jogador iniciará novamente.", confirmText: "Reiniciar", danger: true })) {
      state.round = 1;
      state.turn = 1;
      state.starterIndex = 0;
      update();
      toast("Rodadas reiniciadas.");
    }
  });

  renderRounds();
}

function update() {
  saveLocalState();
  renderRounds();
  saveGameState();
}

export function renderRounds() {
  const n = playerCount();
  // Jogadores podem ser removidos: mantém o turno dentro da faixa válida.
  if (state.turn > n) state.turn = n;
  document.getElementById("round-number").textContent = String(state.round).padStart(2, "0");
  const turnLabel = document.getElementById("turn-label");
  if (turnLabel) turnLabel.textContent = `Turno ${state.turn} de ${n}`;
  document.getElementById("starter-label").textContent = `Vez de: ${currentPlayer()?.name || "—"}`;
}
