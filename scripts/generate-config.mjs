// Gera `js/env.js` a partir de variáveis de ambiente (opcional).
//
// Uso local:   node scripts/generate-config.mjs
// Na Vercel:   defina as variáveis de ambiente e use este comando como Build Command.
//
// Por que isso existe? O MesaGames é uma aplicação ESTÁTICA: variáveis de
// ambiente da Vercel NÃO chegam ao navegador em tempo de execução. Por isso a
// chave pública é "injetada" em um arquivo JS durante o deploy.
//
// Só a chave pública (anon / publishable) é gravada aqui. A chave `service_role`
// NUNCA deve ser usada neste projeto.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const envPath = resolve(root, ".env");
const outPath = resolve(root, "js", "env.js");

/** Lê um `.env` simples (KEY=VALOR) sem depender de bibliotecas externas. */
function readDotEnv(file) {
  if (!existsSync(file)) return {};
  const result = {};
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const fileEnv = readDotEnv(envPath);
const pick = key => (process.env[key] ?? fileEnv[key] ?? "").trim();

const url = pick("SUPABASE_URL");
const anonKey = pick("SUPABASE_ANON_KEY");
const redirect = pick("AUTH_REDIRECT_URL");
const adminEmail = pick("ADMIN_EMAIL");

if (process.env.VERCEL && (!url || !anonKey)) {
  console.error(
    "Configuração do Supabase ausente no build da Vercel. " +
    "Defina SUPABASE_URL e SUPABASE_ANON_KEY em Project Settings > Environment Variables e faça um novo deploy."
  );
  process.exit(1);
}

/**
 * Aceita SOMENTE chave pública: o formato novo (prefixo `sb_publishable_`) ou
 * uma JWT cujo payload tenha role `anon`. Qualquer outra role é rejeitada.
 */
function assertPublicKey(key) {
  if (!key) return; // ausente: o build decide adiante se isso é um problema
  if (key.startsWith("sb_publishable_")) return;

  const parts = key.split(".");
  if (parts.length === 3 && parts.every(Boolean)) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (payload?.role === "anon") return;
      console.error(
        `⛔ SUPABASE_ANON_KEY tem role "${payload?.role ?? "desconhecida"}". ` +
        "Use SOMENTE a chave anon/publishable — nunca a service_role."
      );
      process.exit(1);
    } catch {
      /* não era uma JWT válida: cai no erro genérico abaixo */
    }
  }

  console.error(
    "⛔ SUPABASE_ANON_KEY inválida. Use a chave pública nova (prefixo sb_publishable_...) " +
    "ou a JWT 'anon' do projeto. Nunca use a service_role."
  );
  process.exit(1);
}

assertPublicKey(anonKey);

// Nenhuma variável pode carregar um segredo do Supabase para o front-end.
for (const [key, value] of [["SUPABASE_URL", url], ["SUPABASE_ANON_KEY", anonKey], ["ADMIN_EMAIL", adminEmail]]) {
  if (/service_role|secret|private_key/i.test(value)) {
    console.error(`⛔ A variável ${key} parece conter um segredo. Só valores PÚBLICOS podem ir para o front-end.`);
    process.exit(1);
  }
}

const env = {};
if (url) env.SUPABASE_URL = url;
if (anonKey) env.SUPABASE_ANON_KEY = anonKey;
if (redirect) env.AUTH_REDIRECT_URL = redirect;
if (adminEmail) env.ADMIN_EMAIL = adminEmail;

const body = `// Arquivo gerado por scripts/generate-config.mjs — não edite manualmente.
// Contém apenas a chave PÚBLICA do Supabase (anon / publishable).
globalThis.MESAGAMES_ENV = ${JSON.stringify(env, null, 2)};
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body, "utf8");

if (Object.keys(env).length === 0) {
  console.log("Nenhuma variável encontrada. js/env.js ficou vazio; js/config.js usará os valores padrão.");
} else {
  console.log(`js/env.js gerado com: ${Object.keys(env).join(", ")}`);
}
