import { state, playerColors, saveLocalState } from "./state.js";
import { confirmarModal, editarNomeModal, toast } from "./modal.js";
import { savePlayers, updatePlayerScore } from "./supabase.js";

let onChange = () => {};
let debounceId;
export function initScore(callback) { onChange = callback; renderScore(); }
function scheduleSave() {
  saveLocalState(); onChange();
  clearTimeout(debounceId);
  debounceId = setTimeout(async () => {
    try { await savePlayers(state.players); } catch (e) { console.error(e); toast("Não foi possível sincronizar o placar. Os dados continuam salvos neste navegador.", "error"); }
  }, 500);
}
export function renderScore() {
  const grid = document.getElementById("players-grid");
  const max = Math.max(...state.players.map(p => p.score));
  grid.innerHTML = "";
  state.players.forEach((player, index) => {
    const card = document.createElement("section"); card.className = `player-card ${player.score === max ? "leader" : ""}`;
    card.style.setProperty("--player-color", player.color || playerColors()[index % 12]);
    const top = document.createElement("div"); top.className = "player-top";
    const name = document.createElement("button"); name.className = "player-name"; name.type = "button"; name.textContent = player.name; name.setAttribute("aria-label", `Editar nome de ${player.name}`);
    name.addEventListener("click", async () => { const value = await editarNomeModal(player.name, { maxLength: 20 }); if (value && value !== player.name) { player.name = String(value).slice(0, 20); scheduleSave(); renderScore(); } });
    const remove = document.createElement("button"); remove.className = "player-remove"; remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remover ${player.name}`);
    remove.disabled = state.players.length <= 1;
    remove.addEventListener("click", async () => {
      if (state.players.length <= 1) return;
      if (await confirmarModal({ title: "Remover jogador?", message: `${player.name} e sua pontuação serão removidos da mesa.`, confirmText: "Remover", danger: true })) {
        state.players = state.players.filter(p => p.id !== player.id); state.starterIndex %= state.players.length; scheduleSave(); renderScore(); toast("Jogador removido.");
      }
    });
    top.append(name, remove);
    const score = document.createElement("div"); score.className = "player-score"; score.textContent = player.score; const unit = document.createElement("small"); unit.textContent = " pts"; score.append(unit);
    const buttons = document.createElement("div"); buttons.className = "score-buttons";
    for (const delta of [1, 5, 10, -1, -5, -10]) {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = delta > 0 ? "plus" : "minus"; btn.textContent = `${delta > 0 ? "+" : "−"}${Math.abs(delta)}`;
      btn.setAttribute("aria-label", `${delta > 0 ? "Adicionar" : "Remover"} ${Math.abs(delta)} pontos de ${player.name}`);
      btn.addEventListener("click", () => changeScore(player, delta)); buttons.append(btn);
    }
    card.append(top, score, buttons);
    if (player.score === max && state.players.length > 1) { const crown = document.createElement("span"); crown.className = "leader-mark"; crown.textContent = "♛"; crown.setAttribute("aria-label", "Líder"); card.append(crown); }
    grid.append(card);
  });
  document.getElementById("player-count").textContent = `${state.players.length}/12`;
  document.getElementById("add-player").disabled = state.players.length >= 12;
}
// Limite defensivo: nenhuma partida de tabuleiro chega perto disso, mas evita
// valores absurdos (ou manipulados) no placar e no documento salvo.
const MAX_SCORE = 999_999;
const clampScore = value => Math.max(-MAX_SCORE, Math.min(MAX_SCORE, Math.trunc(Number(value) || 0)));

async function changeScore(player, delta) {
  player.score = clampScore(player.score + delta);
  state.scoreHistory.unshift({ player_id: player.id, delta, round: state.round, created_at: new Date().toISOString() });
  scheduleSave(); renderScore();
  try { await updatePlayerScore(player.id, player.score, delta, state.round); } catch (e) { console.error(e); }
}
export async function addPlayer() {
  if (state.players.length >= 12) return toast("O limite é de 12 jogadores.", "error");
  const i = state.players.length, player = { id: crypto.randomUUID(), name: `Jogador ${i + 1}`, score: 0, color: playerColors()[i] };
  state.players.push(player); scheduleSave(); renderScore(); toast("Jogador adicionado.");
}
export async function resetScores() {
  if (!await confirmarModal({ title: "Zerar pontos?", message: "Todos os jogadores voltarão para zero pontos. Os jogadores serão mantidos.", confirmText: "Zerar pontos", danger: true })) return;
  state.players.forEach(p => p.score = 0); scheduleSave(); renderScore(); toast("Pontuações zeradas.");
}
