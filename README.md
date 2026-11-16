# MesaGames

Utilidades para jogos de tabuleiro e cartas: placar com pontuação, controle de
rodadas, cronômetro/temporizador e dados 2D. Aplicação **estática** (HTML, CSS e
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
| `public.rooms` | Uma linha por **sala online**. A coluna `state` (JSONB) guarda o mesmo documento da partida e é replicada em tempo real para todos os jogadores da sala. |
| `public.room_members` | Quem está em cada sala, com o papel (`host` ou `guest`). |
| Índices únicos | `game_sessions_user_updated_idx` (listagem rápida) e `profiles_display_name_unique_idx` (apelido único). |
| Políticas **RLS** | Cada usuário só vê/altera/exclui as **próprias** linhas; nas salas, só quem é membro lê/grava. Acesso anônimo é negado. |
| Triggers | `updated_at` automático, criação do perfil ao cadastrar (`handle_new_user`), revisão da sala e proteção das configurações da sala contra convidados. |
| Função `is_nickname_available` | Verifica, **sem expor dados**, se um apelido está em uso (usada no cadastro). A checagem de e-mail foi removida para evitar enumeração de contas. |
| Funções `list_public_rooms`, `join_room_by_code`, `list_room_members` | Listar salas abertas, entrar por código (inclusive em salas privadas) e ver os jogadores da sala. |

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

Nenhum valor real (URL, chave, e-mail) fica escrito no código. Tudo vem de
variáveis de ambiente, injetadas em `js/env.js` durante o build.
`js/env.js` **não é versionado** (está no `.gitignore`).

### Como funciona (importante)

Este é um site **estático**: variáveis de ambiente da Vercel **não** chegam ao
navegador em tempo de execução. A solução adotada é **injetar** a chave pública
em `js/env.js` durante o deploy, com o script `scripts/generate-config.mjs`
(sem dependências externas — é o "build mínimo" equivalente ao do Vite).

- `js/env.js` é carregado **antes** de `js/config.js` (veja `index.html`).
- `js/config.js` apenas lê `globalThis.MESAGAMES_ENV`. Sem valores, o app roda
  normalmente em **modo local** (localStorage), sem nuvem.

### Localmente

1. Copie `.env.example` para `.env` e preencha:

   ```
   SUPABASE_URL=https://seu-projeto.supabase.co
   SUPABASE_ANON_KEY=sua-chave-anon-ou-publishable
   ADMIN_EMAIL=admin@exemplo.com
   AUTH_REDIRECT_URL=http://localhost:5500/
   ```

2. Rode `node scripts/generate-config.mjs`. Ele grava `js/env.js`.

### Na Vercel

Defina as mesmas variáveis em **Settings → Environment Variables** e mantenha o
comando de build (já configurado em `vercel.json`):

```
node scripts/generate-config.mjs
```

### Segurança dos segredos

- A chave **anon/publishable** é **pública por design** — a proteção real vem do
  **RLS** no banco.
- **Nunca** coloque a chave `service_role` (nem chaves de API pagas, tokens ou
  senhas) aqui ou em qualquer arquivo do frontend. O gerador **recusa a
  execução** se detectar algo parecido com `service_role`/`secret`.
- Se um dia o projeto precisar de um segredo real, ele deve ficar em uma função
  **`/api`** da Vercel (roda no servidor) — o navegador chama a rota, nunca vê a
  chave. Enquanto não houver segredos, não há necessidade de `/api`.
- `.env` e `js/env.js` estão no `.gitignore`. Não versione credenciais.

---

## 6. Publicar na Vercel

1. Suba o projeto para um repositório Git.
2. Na Vercel: **Add New → Project** e importe o repositório.
3. **Framework Preset:** *Other*. Build Command e Output Directory já vêm do
   `vercel.json` (`node scripts/generate-config.mjs` e `.`).
4. Em **Environment Variables**, adicione `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `ADMIN_EMAIL` (opcional) e `AUTH_REDIRECT_URL` (com a URL final de produção).
   Marque as três opções **Production**, **Preview** e **Development**.
5. **Deploy**.
6. Volte ao Supabase e adicione a URL de produção em **Redirect URLs** (seção 4).

O `vercel.json` também define cabeçalhos de segurança HTTP (CSP,
`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`,
`Permissions-Policy`, `Strict-Transport-Security`).

---

## 7. Testar depois de publicar

Confira, em **HTTPS** e também no celular:

1. O site abre sem login e o placar, cronômetro, rodadas e dados funcionam.
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
12. **Cadastro duplicado:** tentar criar conta com um e-mail já usado → o app avisa
    ("Este e-mail já está cadastrado…"). O mesmo para um **apelido** já em uso.
    O aviso aparece já ao digitar, sem precisar enviar o formulário.
13. **Salas online:** criar uma sala, abrir o app em outro navegador/dispositivo
    logado em outra conta, entrar pelo código e conferir que placar, rodadas e
    dados se sincronizam nos dois lados em tempo real (seção 8).

### Segurança (RLS)

Para confirmar que o RLS bloqueia acesso cruzado, com dois usuários `A` e `B`:

- Crie uma partida com `A`, copie o `id` dela.
- Logado como `B`, tente `select * from game_sessions where id = '<id de A>'`
  no SQL Editor com a role `authenticated` (ou pelo cliente) → deve retornar
  **vazio** / sem permissão. O mesmo para `update` e `delete`.

---

## 8. Salas online

A aba **Salas online** (dentro de "Conta e partidas") permite jogar junto:
encontrar salas abertas, entrar pelo **código** ou criar a sua. Dentro de uma
sala, o mesmo documento da partida (placar, rodadas, dados e preferências) é
**sincronizado em tempo real** entre todos os jogadores conectados.

Como funciona:

- **Criar sala:** escolha um nome e se ela aparece na lista de **salas abertas**.
  Desmarque para criar uma **sala privada** — só entra quem tiver o código.
- **Entrar:** clique em *Entrar* em uma sala da lista ou informe o código (a
  entrada por código funciona também nas salas privadas).
- **Sincronização:** cada alteração feita por um jogador é gravada na sala
  (com debounce) e replicada aos demais via **Supabase Realtime**. O app ignora
  o "eco" da própria gravação e só aplica mudanças realmente mais recentes.
- **Sair:** convidados apenas saem; o **host** encerra a sala para todos.

Segurança:

- O acesso é **somente para quem está conectado**; a listagem de salas abertas é
  feita pela função `list_public_rooms` (não expõe salas privadas).
- **RLS** limita leitura e escrita a **membros da sala** (verificado por
  `is_room_member`, para evitar recursão de políticas).
- Um trigger impede que **convidados** alterem as configurações da sala
  (nome, código, visibilidade, dono) — eles só atualizam o estado da partida.

---

## 9. Segurança

Resumo do modelo de segurança do app:

- **Nenhum segredo no front-end.** O site só usa a chave **pública** do Supabase.
  A única forma de um segredo real existir é dentro de uma função `/api` da
  Vercel (servidor). O script de build **recusa** subir algo parecido com
  `service_role`/`secret`.
- **RLS em todas as tabelas** (`profiles`, `game_sessions`, `rooms`,
  `room_members`). Cada usuário só acessa as próprias partidas; nas salas, só os
  membros. O acesso anônimo é negado.
- **Sem XSS.** Nomes de jogador, nomes de sala e mensagens entram no DOM apenas
  via `textContent`. Não há `eval`, `new Function` nem `document.write`. A CSP do
  `vercel.json` também bloqueia scripts de terceiros que não o `cdn.jsdelivr.net`
  (usado pelo cliente do Supabase) e o Supabase.
- **Validação em profundidade.** Entradas são limitadas no HTML (`maxlength`,
  `type=number`, `min`/`max`), no JS (pontos, quantidade de dados, tempo) e no
  banco (`CHECK`s de tamanho/valor e tipos JSONB).
- **Aleatoriedade segura.** As rolagens usam `crypto.getRandomValues`; os IDs de
  jogador usam `crypto.randomUUID`.

### Limitações conhecidas (aceitas de propósito)

- **A seção "Configurações / Dados e Banco" é apenas visual** (`ADMIN_EMAIL`).
  Um usuário pode revelá-la pelas ferramentas do navegador, mas as ações agem
  **apenas nos próprios dados**, que já são protegidos por RLS — não há risco de
  afetar a mesa de outra pessoa. Autorização "de verdade" só existe no servidor.
- **Verificação de apelido é pública** (`is_nickname_available`), pois o
  cadastro precisa avisar antes do login se o apelido já está em uso. A
  verificação de **e-mail** deixou de existir: o cadastro responde de forma
  genérica e nunca revela se um e-mail já tem conta (evita enumeração).
- **Rate limit** não é aplicado no front-end; use as **Rate Limits** do Supabase
  (Authentication) e/ou um proxy `/api` se isso virar um problema.

### Rotação de chaves

Se a chave `anon`/`publishable` ou qualquer outro valor já esteve escrita no
código e foi enviada ao Git, **considere-a vazada**. Apagar do arquivo não
remove o valor do histórico do Git. Nesse caso: gere uma nova chave no Supabase
(**Project Settings → API Keys → Rotate**) e atualize `.env` e as variáveis da
Vercel. Os valores atuais **não** são secretos (a chave anon é pública por
design), então a rotação é opcional nesse caso.

---

## Estrutura de arquivos

```
index.html                  # marcação + diálogo de conta e salas
css/style.css               # estilos (tema claro/escuro)
css/dice.css                # estilos dos dados 2D (chips, mesa, animação)
js/main.js                  # orquestra os módulos
js/state.js                 # estado + persistência local por "escopo" (partida/sala)
js/config.js                # lê a config do ambiente (não contém valores reais)
js/env.js                   # config injetada a partir do .env (gerada; NÃO versionada)
js/supabase.js              # auth + partidas + salas + sincronização com debounce
js/account.js               # UI de conta, partidas salvas e cadastro
js/rooms.js                 # UI de salas online em tempo real
js/score.js                 # placar e pontuação
js/rounds.js                # rodadas
js/timer.js                 # cronômetro/temporizador
js/dice.js                  # dados 2D + histórico
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
