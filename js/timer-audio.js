let audioContext = null;

function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioContext || audioContext.state === "closed") audioContext = new AudioContextClass();
  return audioContext;
}

/** Deve ser chamado durante uma interação para liberar o áudio automático. */
export function primeTimerAudio() {
  try {
    const context = getAudioContext();
    if (context?.state === "suspended") context.resume().catch(() => {});
  } catch { /* áudio indisponível neste navegador */ }
}

export function playTimerAlert() {
  try {
    const context = getAudioContext();
    if (!context) return;
    const play = () => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.5);
      oscillator.onended = () => {
        if (context.state === "running") context.suspend().catch(() => {});
      };
    };
    if (context.state === "suspended") context.resume().then(play).catch(() => {});
    else play();
  } catch { /* áudio pode estar bloqueado até uma interação do usuário */ }
}
