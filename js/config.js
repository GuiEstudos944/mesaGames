// Configuração pública do MesaGames.
//
// A chave `anon` / `publishable` do Supabase é PÚBLICA por design: ela só permite
// o que as políticas de RLS autorizarem. NUNCA coloque a `service_role` aqui.
//
// Estes valores podem ser sobrescritos sem editar este arquivo:
//   1. por `globalThis.MESAGAMES_ENV` (injetado antes deste módulo), ou
//   2. gerando este arquivo a partir de variáveis de ambiente:
//      `node scripts/generate-config.mjs` (ver README > Variáveis de ambiente).
const injected = globalThis.MESAGAMES_ENV || {};

function normalizeUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")        // remove barra final
    .replace(/\/rest\/v1$/, ""); // aceita URL colada com "/rest/v1"
}

export const SUPABASE_URL = normalizeUrl(injected.SUPABASE_URL || "https://xhqtzhceevzficoaknzv.supabase.co");
export const SUPABASE_ANON_KEY = String(injected.SUPABASE_ANON_KEY || "sb_publishable_yM1AZOraM19MohArVk4D3Q_ogbgx_Os").trim();

// Para onde o Supabase devolve o usuário após confirmar e-mail / redefinir senha.
// Precisa estar na lista "Redirect URLs" do projeto Supabase.
export const AUTH_REDIRECT_URL = String(injected.AUTH_REDIRECT_URL || `${location.origin}${location.pathname}`);

export const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Único e-mail autorizado a ver a seção "Configurações / Dados e Banco".
// Todo o resto do app funciona para qualquer conta.
export const ADMIN_EMAIL = "guilhermebolsoni2004@gmail.com";
