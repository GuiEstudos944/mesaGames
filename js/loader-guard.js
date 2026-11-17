// Rede de segurança do loader.
//
// Por que existe: o app esconde o loader quando a inicialização termina, mas se
// um MÓDULO falhar ao carregar (bloqueado por CSP/adblock, rede fora, erro de
// sintaxe), o grafo de módulos inteiro não roda e o loader ficaria preso para
// sempre. Este arquivo é um script CLÁSSICO e independente: não importa nada e
// é o primeiro a rodar, então garante que o loader sempre desapareça.
//
// Estratégia: dispara o esconder no DOMContentLoaded (não em window.load, que
// espera imagens/GTM) com um teto de 3 segundos. Script próprio porque o CSP
// proíbe <script> inline.
(function () {
  var MAX_MS = 3000;
  var done = false;

  function forceHide() {
    if (done) return;
    done = true;
    var loader = document.getElementById("app-loader");
    function finish() {
      var el = document.getElementById("app-loader");
      if (el && el.parentNode) el.parentNode.removeChild(el);
      document.body.classList.remove("is-loading");
      document.body.removeAttribute("aria-busy");
    }
    if (loader) {
      loader.classList.add("is-hidden");
      window.setTimeout(finish, 320);
    } else {
      finish();
    }
  }

  function arm() {
    window.setTimeout(forceHide, MAX_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", arm, { once: true });
  } else {
    arm();
  }

  // O app pode marcar que já escondeu o loader (evita trabalho redundante).
  window.__mesaLoaderGuard = {
    forceHide: forceHide,
    markHidden: function () { done = true; }
  };
})();
