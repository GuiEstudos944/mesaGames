// Aplica o tema ANTES do primeiro paint para evitar "flash" (FOUC).
// Precisa ser um script clássico e síncrono no <head> (não pode ser módulo),
// por isso fica em arquivo próprio: o CSP não permite mais <script> inline.
(function () {
  try {
    var saved = localStorage.getItem("mesagames_theme");
    var theme = null;
    if (saved === "light" || saved === "dark") {
      theme = saved;
    } else {
      // Compatibilidade: lê o tema salvo no estado do jogo (escopo local).
      try {
        var scope = localStorage.getItem("mesa-active-scope-v1") || "local";
        var raw = localStorage.getItem("mesa-boardgame-state-v1:" + scope);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && (parsed.theme === "light" || parsed.theme === "dark")) theme = parsed.theme;
        }
      } catch (e) { /* ignora estado corrompido */ }
    }
    if (!theme) {
      var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      theme = prefersDark ? "dark" : "light";
    }
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.style.colorScheme = theme;
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
