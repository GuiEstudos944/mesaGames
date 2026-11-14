# MesaGames

Utilidades para jogos de tabuleiro e cartas: placar com pontuação, controle de
rodadas, cronômetro/temporizador e dados 3D. Aplicação **estática** (HTML, CSS e
JavaScript com ES Modules nativos), com conta opcional via **Supabase**.

> A conta é opcional. Sem login, tudo funciona e fica salvo apenas no navegador
> (localStorage). Com login, cada partida é salva na nuvem e pode ser retomada em
> outros dispositivos.

---

## 1. Rodar localmente

O projeto usa ES Modules (`<script type="module">`), então **não abra o
`index.html` com duplo clique** (`file://`) — os módulos não carregam. Use um
servidor local:

- **VS Code (Live Server):** clique com o botão direito em `index.html` →
  *Open with Live Server*.
- **Python:** `python -m http.server 5500` e abra `http://localhost:5500`.
- **Node:** `npx serve .` e abra o endereço mostrado.

Não há passo de build obrigatório. O site roda direto.

---

## 2. Configurar o Supabase

1. Crie um projeto em <https://supabase.com>.
2. Em **Project Settings → API**, copie:
   - **Project URL** (ex.: `https://xxxxxxxx.supabase.co`)
   - **anon / publishable key** (chave **pública**)
3. **Nunca** use a chave `service_role` no frontend — ela ignora o RLS.
4. Preencha a configuração em `js/config.js` (funciona sem nenhum outro passo) ou
   use variáveis de ambiente (seção 5).

---

## 3. Executar o SQL

1. Abra **SQL Editor → New query** no painel do Supabase.
2. Cole todo o conteúdo de [`SUPABASE.sql`](./SUPABASE.sql) e clique em **Run**.
3. O script é **idempotente**: pode ser executado novamente sem perde dados.

O script cria/ajusta:

| Objeto | Para quê |
| --- | --- |
| `public.profiles` | Dados públicos do usuário (e-mail, nome, preferências). |
| `public.game_sessions` | Uma linha por **partida**. A coluna `state` (JSONB) guarda o documento completo: jogadores, pontuações, rodada, quem começa, histórico de dados, histórico de pontuação e data da última alteração. |
| Índice `game_sessions_user_updated_idx` | Listagem rápida das partidas do usuário. |
| Políticas **RLS** | Cada usuário só vê/altera/exclui as **próprias** linhas. Acesso anônimo é negado. |
| Triggers | `updated_at` automático e criação do perfil ao cadastrar (`handle_new_user`). |

> **Tabelas antigas:** se o seu projeto já tinha `players`, `game_state`,
> `dice_rolls` ou `score_history`, o script **não as apaga**. Ele apenas fecha o
> acesso anônimo. Há um bloco comentado em `SUPABASE.sql` explicando como migrar
> os dados antigos para o novo formato, se você quiser fazer isso depois.

---

## 4. Configurar autenticação e redirecionamentos

Em **Authentication → URL Configuration**:

1. **Site URL:** a URL do site (ex.: `https://seusite.vercel.app/`).
2. **Redirect URLs:** adicione as URLs para onde o Supabase pode devolver o
   usuário após **confirmar e-mail** / **redefinir senha**:
   - `https://seusite.vercel.app/`
   - `http://localhost:5500/` (desenvolvimento)

Em **Authentication → Providers → Email**:

- **Confirm email:** ligado (recomendado). O usuário recebe um link para ativar
  a conta antes de conseguir entrar.
- Se desligar o "Confirm email", o cadastro já entra logado direto.

O app usa `AUTH_REDIRECT_URL` (seção 5) como `emailRedirectTo`/`redirectTo`. Se
não for definida, usa automaticamente a origem onde o site está aberto. A URL
precisa estar na lista de **Redirect URLs** acima.

---

## 5. Variáveis de ambiente

São **opcionais**. O projeto funciona preenchendo `js/config.js` diretamente.

### Como funciona (importante)

Este é um site **estático**: variáveis de ambiente da Vercel **não** chegam ao
navegador em tempo de execução. A solução adotada é **injetar** a chave pública
em `js/env.js` durante o deploy, com o script `scripts/generate-config.mjs`.

- `js/env.js` é carregado **antes** de `js/config.js` (veja `index.html`).
- `js/config.js` lê `globalThis.MESAGAMES_ENV`. Se estiver vazio, usa os valores
  padrão definidos no próprio arquivo.

### Localmente

1. Copie `.env.example` para `.env` e preencha:

   ```
   SUPABASE_URL=https://seu-projeto.supabase.co
   SUPABASE_ANON_KEY=sua-chave-anon-ou-publishable
   AUTH_REDIRECT_URL=http://localhost:5500/
   ```

2. Rode `node scripts/generate-config.mjs` (sem dependências externas).
   Ele grava `js/env.js`.

### Na Vercel

Defina as mesmas variáveis em **Settings → Environment Variables** e mantenha o
comando de build (já configurado em `vercel.json`):

```
node scripts/generate-config.mjs
```

### Segurança dos segredos

- A chave **anon/publishable** é **pública por design** — a proteção real vem do
  **RLS** no banco.
- **Nunca** coloque a chave `service_role` aqui nem em nenhum arquivo do
  frontend. O gerador recusa a execução se detectar `service_role`.
- `.env` está no `.gitignore`. Não versione credenciais.

---

## 6. Publicar na Vercel

1. Suba o projeto para um repositório Git.
2. Na Vercel: **Add New → Project** e importe o repositório.
3. **Framework Preset:** *Other*. Build Command e Output Directory já vêm do
   `vercel.json` (`node scripts/generate-config.mjs` e `.`).
4. Em **Environment Variables**, adicione `SUPABASE_URL`,
   `SUPABASE_ANON_KEY` e `AUTH_REDIRECT_URL` (com a URL final de produção).
5. **Deploy**.
6. Volte ao Supabase e adicione a URL de produção em **Redirect URLs** (seção 4).

O `vercel.json` também define cabeçalhos de segurança HTTP (CSP,
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`, `Strict-Transport-Security`).

---

## 7. Testar depois de publicar

Confira, em **HTTPS** e também no celular:

1. O site abre sem login e o placar, cronômetro, rodadas e dados 3D funcionam.
2. Recarregar a página mantém os dados (localStorage).
3. Criar conta → confirmar e-mail → entrar.
4. Criar uma partida, adicionar jogadores, alterar pontos.
5. Recarregar a página: os dados continuam.
6. Criar uma segunda partida e confirmar que os dados são **independentes**.
7. Renomear e excluir uma partida (com confirmação).
8. Sair da conta e entrar de novo: as partidas voltam.
9. Abrir a mesma conta em **outro navegador/dispositivo**: as partidas aparecem.
10. Testar o indicador de status: **Salvando… / Salvo / Offline / Erro ao sincronizar**.
11. Testar **recuperação de senha** pelo link do e-mail.

### Segurança (RLS)

Para confirmar que o RLS bloqueia acesso cruzado, com dois usuários `A` e `B`:

- Crie uma partida com `A`, copie o `id` dela.
- Logado como `B`, tente `select * from game_sessions where id = '<id de A>'`
  no SQL Editor com a role `authenticated` (ou pelo cliente) → deve retornar
  **vazio** / sem permissão. O mesmo para `update` e `delete`.

---

## Estrutura de arquivos

```
index.html                  # marcação + diálogo de conta
css/style.css               # estilos (tema claro/escuro)
js/main.js                  # orquestra os módulos
js/state.js                 # estado + persistência local por "escopo" (partida)
js/config.js                # URL/chave pública do Supabase
js/env.js                   # config injetada (gerada; vazia por padrão)
js/supabase.js              # auth + partidas + sincronização com debounce
js/account.js               # UI de conta e partidas salvas
js/score.js                 # placar e pontuação
js/rounds.js                # rodadas
js/timer.js                 # cronômetro/temporizador
js/dice.js                  # dados 3D + histórico
js/modal.js                 # modais, toasts, indicadores de status
SUPABASE.sql                # esquema do banco (idempotente)
vercel.json                 # build + cabeçalhos de segurança
scripts/generate-config.mjs # injeta variáveis de ambiente em js/env.js
.env.example                # modelo de variáveis de ambiente
```

## Modelo de dados (resumo)

Cada partida é um **documento JSONB** na tabela `game_sessions`. Por quê?

- A gravação é **atômica**: nunca existe jogador sem partida, histórico órfão ou
  estado parcialmente gravado.
- Elimina o padrão antigo de "apagar tudo e reinserir", que era a maior fonte de
  perda de dados e de condição de corrida.
- O **RLS** protege a linha inteira: um usuário não enxerga nem altera a partida
  de outro, mesmo trocando o `id` na mão.
- Se no futuro forem necessárias consultas isoladas (ranking entre usuários,
  relatórios), crie tabelas normalizadas ligadas a `game_sessions(id)` **sem
  remover** o JSONB, que continua sendo a fonte do estado "ao vivo".
"# mesaGames" 
