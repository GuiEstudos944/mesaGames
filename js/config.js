// Configuração pública do MesaGames.
//
// NENHUM valor real (URL, chave, e-mail) fica escrito neste arquivo. Tudo vem
// de variáveis de ambiente, injetadas em `js/env.js` pelo script
// `scripts/generate-config.mjs` (rode antes do deploy — a Vercel já faz isso no
// Build Command).
//
// A chave `anon` / `publishable` do Supabase é PÚBLICA por design: ela só
// permite o que as políticas de RLS autorizarem. A segurança NÃO depende de
// escondê-la. NUNCA coloque a `service_role` (ou qualquer chave secreta) aqui.
const injected = globalThis.MESAGAMES_ENV || {};

function normalizeUrl(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")        // remove barra final
    .replace(/\/rest\/v1$/, ""); // aceita URL colada com "/rest/v1"
}

export const SUPABASE_URL = normalizeUrl(injected.SUPABASE_URL || "");
export const SUPABASE_ANON_KEY = String(injected.SUPABASE_ANON_KEY || "").trim();

// Para onde o Supabase devolve o usuário após confirmar e-mail / redefinir senha.
// Precisa estar na lista "Redirect URLs" do projeto Supabase. Sem valor, usa a
// própria origem onde o site está aberto (funciona em localhost e em produção).
export const AUTH_REDIRECT_URL = String(injected.AUTH_REDIRECT_URL || "").trim()
  || `${location.origin}${location.pathname}`;

export const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

// Único e-mail autorizado a ver a seção "Configurações / Dados e Banco".
// Vem da variável de ambiente ADMIN_EMAIL. Vazio = a seção não aparece para
// ninguém. Atenção: esta checagem é apenas visual (ver README > Segurança).
export const ADMIN_EMAIL = String(injected.ADMIN_EMAIL || "").trim();
