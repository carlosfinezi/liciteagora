# Arquitetura, MVP e roadmap — app móvel de vendas

Data: 2026-08-26 · Caixa 3. Base:
[`01-pedido-ponta-a-ponta.md`](01-pedido-ponta-a-ponta.md) e
[`02-acesso-dados-e-apis.md`](02-acesso-dados-e-apis.md).

**Somente planejamento.** Nenhum código, banco, migration, nginx, API ou serviço
foi tocado. Nenhum commit. Único arquivo criado: este.

Convenção: o que é fato vem com `arquivo:linha` das auditorias anteriores; o que
é suposição está marcado **HIPÓTESE** e não deve ser tratado como confirmado.

### Verificações novas feitas nesta caixa (leitura pura, sem efeito colateral)

Três fatos que as caixas 1 e 2 não tinham e que mudam recomendações desta:

1. **O HTTP é servido por um único processo Node, sem cluster.**
   `systemctl show consulta-licitacoes.service` → `MainPID=1388723`,
   `ExecStart=/usr/bin/node --max-old-space-size=4096 server.js`;
   `ps -eo pid,cmd` confirma **um** processo. Não há `cluster.fork`,
   `worker_threads` nem pm2 em `server.js`/`role-dispatch.js`.
   Isso decide as seções 7 (numeração), 8 (transação) e 10 (estoque concorrente).
2. **`better-sqlite3` v12.5.0**, com `journal_mode = WAL` e
   `busy_timeout = 5000` por tenant (`tenant-manager.js:495-496`).
3. **Host inválido e credencial inválida são distinguíveis pelo app.** Medido com
   `curl` (GET, sem autenticar):

   | Host | `GET /api/usuarios/me` |
   |---|---|
   | `1bit.liciteagora.app` | **401** `application/json` — `{"error":"Não autenticado"}` |
   | `naoexiste.liciteagora.app` | **404** `text/html` — "Tenant não encontrado" |

   `/login.html` responde **200 em qualquer host**, porque o static de
   `public/auth` é montado por `applyBaseMiddleware` (`server.js:13`) **antes** do
   middleware de tenant (`server.js:54`). Logo, `/login.html` **não serve** para
   validar empresa; `/api/usuarios/me` serve.

---

## 1. ARQUITETURA RECOMENDADA

### 1.1 Confirmação

**Sim — a arquitetura que você descreveu é a recomendada, e por uma razão que não
é preferência: ela é a única que não duplica lógica de negócio.**

```
┌─────────────────────┐
│   APP MÓVEL         │  React Native + Expo (§17)
│   (Android → iOS)   │  UI, carrinho local, cache de sessão
└──────────┬──────────┘
           │ HTTPS  (cookie liciteagora.sid, httpOnly, secure)
           │ Host: <slug>.liciteagora.app
           ▼
┌─────────────────────┐
│  nginx (vhost tenant)│  TLS, proxy_pass → :3000
└──────────┬──────────┘
           ▼
┌──────────────────────────────────────────────────────┐
│  server.js — processo ÚNICO, ROLE=worker             │
│                                                      │
│  1. applyBaseMiddleware  (server.js:13)              │
│  2. tenantMiddleware     (server.js:54)  ← resolve   │
│     tenant-middleware.js:174-207          o BANCO    │
│  3. session + requireAuth (auth-bootstrap.js:56,76)  │
│  4. criarGateAcesso RBAC  (auth-bootstrap.js:132)    │
│  5. rotas de negócio      (route-registry.js)        │
└──────────┬───────────────────────────────────────────┘
           ▼
┌──────────────────────────────────────────────────────┐
│  data/tenants/<slug>/pncp.db   (SQLite, WAL)         │
│  pedidos · pedido_itens · pessoas · produtos ·       │
│  reservas_estoque · movimentacoes_estoque · faturas  │
└──────────────────────────────────────────────────────┘
           ▼
   COMERCIAL → Pedidos  →  confirmar → entregar → faturar → NF-e
   (o MESMO fluxo, sem ramo especial — Caixa 1 §7.5)
```

O app é a **quinta porta de entrada** do mesmo pedido comercial. As outras quatro
já existem e estão em produção (Caixa 1 §7.5): loja virtual
(`loja-routes.js:340`), Mercado Livre (`marketplaces-ml.js:300`), marketplaces
genérico (`marketplaces-routes.js:152`) e OS (`os-routes.js:2246`).

### 1.2 Onde fica a lógica de negócio

**Toda ela fica no backend, e isso não é uma escolha de estilo — é o que a
arquitetura atual já impõe.** As regras vivem dentro dos handlers Express e das
funções auxiliares, não em uma camada de serviço reaproveitável por outro
processo:

| Regra | Onde vive | O app pode reimplementar? |
|---|---|---|
| Numeração `PED-2026-00015` | `gerarNumero()` — `pedidos-routes.js:91-101` | **Nunca.** É `UNIQUE` no banco |
| Preço (4 níveis) | `resolverPreco()` — `precos-routes.js:127-165` | Não. Consultar, sim |
| CFOP | `sugerirCFOP()` — `tipos-operacao-routes.js:295` | Não |
| Condição de pagamento | `resolverPoliticaPedido()` — `pedidos-routes.js:37-50` | Não |
| Meio de pagamento permitido | `meios-pagamento.js` | Não |
| Reserva de estoque | `criarReservasPedido()` — `reservas-routes.js:133-202` | Não |
| Baixa de estoque | `consumirReservasPedido()` — `reservas-routes.js:370-415` | Não |
| Faturamento / CR / parcelas | `faturas-routes.js:149-385` | Não |

### 1.3 O que fica no app

Somente o que **não é regra**:

- navegação, formulários, teclado numérico, feedback visual;
- **carrinho em memória antes de enviar** — o vendedor monta a lista offline-ish e o app só cria o pedido ao final (§8);
- cache de sessão e de resultados de busca recentes (§18);
- exibição do preço e do disponível que o **servidor** calculou;
- retry de rede e tratamento de 401/403/409.

O app **não** decide preço, CFOP, número, reserva, nem status.

### 1.4 O que obrigatoriamente fica no backend

Tudo que, se calculado no cliente, poderia ser mentira:

1. **Preço gravado** — hoje é aceito do cliente (Caixa 1 §5.3); §5 propõe corrigir.
2. **`vendedorId`** — hoje o corpo vence a sessão (`pedidos-routes.js:348`); §6 propõe corrigir.
3. **Número do pedido** — já é exclusivo do backend (Caixa 1 §4).
4. **CFOP** — `sugerirCFOP` no `POST /:id/itens` (§9).
5. **Disponibilidade e reserva** — `criarReservasPedido` decide, e é ela que dá o 409 (§10).
6. **Status** — o app só chama `POST /:id/confirmar`; quem muda status é o backend.

### 1.5 Como o tenant é resolvido

**Pelo header `Host`, antes de qualquer rota** (Caixa 2 §4.1-4.3):
`resolveFromHost()` (`tenant-manager.js:217-235`) → `manager.getDb(slug)`
(`tenant-manager.js:482-526`) → `AsyncLocalStorage` (`tenant-middleware.js:201`).

Para o app isso significa uma regra e nenhuma outra: **a URL base é
`https://<slug>.liciteagora.app` e faz parte da identidade da conta salva no
aparelho.** Não há header de tenant, não há `?tenant=`, e não existe endpoint
"descubra minha empresa pelo login" — nem poderia existir sem varrer os 12 bancos
(Caixa 2 §4.8).

### 1.6 Como usuário/vendedor é identificado

**`users.id`**, obtido da sessão como `req.session.userId` / `req.user.id`
(Caixa 2 §3.11). Não existe tabela de vendedores: vendedor é
`users.ehVendedor = 1` (Caixa 2 §3.2).

O caminho é: `POST /api/login` grava `req.session.userId` (`auth-routes.js:102`)
→ `requireAuth` popula `req.user` a cada request (`auth.js:311-316`) →
`POST /api/pedidos` usa `req.session?.userId` como default de `vendedorId`
(`pedidos-routes.js:348`).

---

## 2. AUTENTICAÇÃO DO APP

### 2.1 Fluxo

```
1.  [Tela 1] Empresa:  [ minhaempresa            ]
              → app monta baseUrl = https://minhaempresa.liciteagora.app
              → GET {baseUrl}/api/usuarios/me     (ping de validação, §3.4)
                 404 html → "Empresa não encontrada"
                 402      → "Conta suspensa — fale com o suporte"
                 401 json → empresa existe → segue
                 200 json → já há sessão válida → pula para a Home

2.  [Tela 2] Usuário:  [ guilherme               ]     ← username, NÃO e-mail
             Senha:    [ ••••••••                ]

3.  POST {baseUrl}/api/login   { username, password }
       200 { success:true, username, nome, role }  + Set-Cookie: liciteagora.sid
       401 { success:false, error:'Usuário ou senha incorretos' }
       429 { error:'Muitas tentativas...' } + Retry-After

4.  app guarda: baseUrl + cookie (cookie-jar persistente)
5.  GET {baseUrl}/api/usuarios/me → { id, username, nome, role, estabelecimentoId }
       → app guarda o `id` como identidade de exibição (NÃO para enviar, §4)
6.  todas as chamadas seguintes: mesmo baseUrl, mesmo cookie-jar
```

**Atenção — é `username`, não e-mail.** `auth-routes.js:77` faz
`SELECT * FROM users WHERE username = ?`. A coluna `users.email` existe mas
**não é usada no login**. A tela deve dizer "Usuário", não "E-mail". Se o produto
quiser login por e-mail, é mudança de backend, não do app.

### 2.2 Armazenamento seguro

Duas coisas ficam no aparelho, com tratamentos diferentes:

| O quê | Onde | Por quê |
|---|---|---|
| `baseUrl` (slug da empresa) | armazenamento comum (`AsyncStorage`) | não é segredo; é conveniência para não redigitar |
| **cookie de sessão** | armazenamento **criptografado** do SO — Android Keystore via `EncryptedSharedPreferences`; iOS Keychain (`expo-secure-store`) | é credencial de acesso: quem o tem, é o vendedor |
| senha | **em lugar nenhum** | o app nunca guarda senha. Se quiser "entrar rápido", usa biometria para **desbloquear o cookie**, não para recuperar senha |

**Nunca** gravar cookie em `AsyncStorage` puro, arquivo em `/sdcard`, nem em log.

### 2.3 Cookie jar

O cookie é `httpOnly` + `secure` + `sameSite=lax`, sem `domain`
(`auth-bootstrap.js:62-69`). Para um cliente nativo isso é irrelevante como
obstáculo — o `httpOnly` só bloqueia JS de página, não o cookie-jar do cliente
HTTP.

Requisitos do jar:
- **persistente entre execuções** (senão o vendedor reloga a cada abertura);
- **isolado por `baseUrl`** — o cookie de `empresaA` nunca pode ir para `empresaB`. Como o cookie não tem `domain`, a semântica correta é host-only, e qualquer jar padrão já faz isso; ainda assim o app deve manter **um jar por empresa** quando suportar múltiplas contas (§2.7);
- **limpo no logout** e ao trocar de empresa.

Em React Native, `fetch` no Android usa OkHttp por baixo e o `CookieManager`
persiste em memória do processo; para persistência entre execuções é preciso um
jar próprio ou uma lib de cookies. **HIPÓTESE:** a combinação exata
(`expo` + persistência de cookie no Android/iOS) precisa de uma prova de conceito
de meio dia antes de fechar a arquitetura — é o único ponto técnico do app que eu
não consigo confirmar por leitura de código deste repositório. Ver §17.4.

### 2.4 Expiração de 7 dias

Fato (Caixa 2 §1.4): `maxAge` de 7 dias, o store grava
`expired = Date.now() + maxAge` no `set` (`auth.js:90-92`), **não há `touch`**
(`auth.js:80-107`) e **não há `rolling`**. Consequência: a sessão morre 7 dias
depois do **login**, mesmo com uso diário.

Como o app trata:
- guarda `loginAt` junto do cookie e, a partir do **6º dia**, mostra um aviso discreto ("sua sessão expira amanhã");
- **não tenta adivinhar**: a fonte da verdade é o 401;
- em qualquer 401 de `/api/*`, o app: descarta o cookie → volta para a tela de senha **mantendo empresa e usuário preenchidos** → após relogar, **retoma exatamente onde estava**, inclusive com o carrinho em memória intacto.

Esse último ponto é o que separa um app tolerável de um irritante: expirar no meio
de um pedido não pode custar o pedido.

### 2.5 Logout

`POST /api/logout` (`auth-routes.js:109-118`) — público, idempotente, sem CSRF.
O app deve, **nesta ordem**: chamar o endpoint (best-effort, ignorando falha de
rede) → limpar o cookie-jar → limpar cache de dados do usuário → **preservar
`baseUrl` e `username`** para o próximo login.

### 2.6 Sessão expirada vs. sessão revogada

O app não distingue, e **não precisa** — os dois chegam como 401. A diferença
importa para o suporte:

| Causa | Sinal | Origem |
|---|---|---|
| 7 dias venceram | 401 | `auth.js:82` (`expired > ?`) |
| admin desativou o usuário | 401 **imediato**, na requisição seguinte | `auth.js:311-317` destrói a sessão quando `users.ativo = 0` |
| serviço reiniciado | **não desloga** — a sessão está no SQLite, não em memória | `auth.js:28-109` |

A segunda linha é a peça mais valiosa que a sessão dá de graça e a API Key não
daria: **revogação imediata, sem esperar expirar**.

### 2.7 Troca de empresa

Cenário real: representante que atende duas empresas clientes do Licite Agora.

Regra: **trocar de empresa é trocar de conta inteira.** O app mantém uma lista de
contas `{ baseUrl, username, cookieRef }` e, ao trocar, **não** reaproveita nada —
nem cookie, nem cache de clientes, nem carrinho. Isso espelha o isolamento do
servidor (Caixa 2 §4.8): o cookie de A é inválido em B, e um carrinho de A com
`produtoId` de A não significa nada em B.

**Para o MVP: uma conta por vez.** Multi-conta entra depois, se aparecer demanda.

### 2.8 Dispositivo perdido

Caminho disponível hoje, sem nenhuma mudança: **admin desativa o usuário**
(`users.ativo = 0`, via `DELETE /api/usuarios/:id`, `usuarios-routes.js:269`) →
a sessão morre na próxima requisição (`auth.js:311-317`).

Limitação real (Caixa 2 §10, risco 6): é tudo-ou-nada — derruba também o acesso
web do mesmo vendedor, e não existe "encerrar só este dispositivo" porque a tabela
`sessions` tem apenas `sid`, `sess`, `expired`, sem identificação de aparelho.

Mitigação **do lado do app**, sem tocar no servidor: PIN/biometria para abrir o
app. Não impede quem extrai o cookie do storage de um aparelho rooteado, mas cobre
o caso comum (celular perdido, não atacado).

**Não propor X-Api-Key** — Caixa 2 §2.10.

---

## 3. COMO O APP DESCOBRE A EMPRESA

### 3.1 As três alternativas

**A) Slug da empresa** — campo "Empresa: `minhaempresa`", app monta
`https://minhaempresa.liciteagora.app`.

**B) Código da empresa** — um código curto (numérico ou alfanumérico) que o app
troca por uma URL consultando um serviço central.

**C) URL completa** — o vendedor digita `https://minhaempresa.liciteagora.app`.

### 3.2 Comparação

| Critério | A) Slug | B) Código | C) URL completa |
|---|---|---|---|
| Digitação | curta, uma palavra | curta | longa, com `https://` e ponto |
| Erro de digitação | detectável (404, §3.4) | detectável | alto — protocolo, barra, `.app` vs `.com` |
| Precisa de backend novo | **não** | **sim** — endpoint público no apex que mapeie código→slug, lendo `control.db` | **não** |
| Superfície de ataque nova | nenhuma | **sim** — endpoint público não autenticado que enumera clientes do Licite Agora | nenhuma |
| Risco de apontar para host errado | baixo (sufixo fixo no app) | baixo | **alto** — o vendedor pode digitar um domínio de terceiro e mandar a senha para lá |
| Muda a arquitetura atual | não | sim | não |
| O vendedor já conhece o valor? | **sim** — é o que ele digita no navegador hoje | não, seria novo | sim |

### 3.3 Recomendação: **A — slug, com o sufixo fixo no app**

```
┌────────────────────────────────┐
│  Empresa                       │
│  ┌──────────────┬────────────┐ │
│  │ minhaempresa │.liciteagora│ │   ← sufixo fixo, não editável
│  └──────────────┴────────────┘ │
└────────────────────────────────┘
```

Motivos, em ordem de peso:

1. **É o único que não cria superfície nova.** O código da empresa (B) exigiria um endpoint público no apex, sem autenticação, que responde "esta empresa existe" — exatamente o tipo de coisa que permite enumerar a base de clientes do Licite Agora. Não vale a conveniência.
2. **Fixar o sufixo no binário elimina o pior erro possível.** Com a opção C, um vendedor induzido a digitar `minhaempresa.liciteagora.com.br` (domínio de um atacante) entregaria usuário e senha. Com o sufixo fixo, o app só fala com `*.liciteagora.app`.
3. **O valor já é conhecido.** É o que está na barra de endereço do navegador que o vendedor já usa.
4. **Zero mudança de backend.**

**Normalização obrigatória no app** (antes de montar a URL): `trim`, minúsculas,
remover `https://`, remover `.liciteagora.app` se o usuário colar a URL inteira,
recusar espaço e `/`. O slug válido do servidor é
`/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/` (`tenant-manager.js:237-239`) — o app deve
aplicar **a mesma** regex e recusar `www`, `admin`, `api`, `static`, `cdn`
(`RESERVED_SLUGS`, `tenant-manager.js:35`) com uma mensagem clara.

**Aceitar C como entrada, não como campo.** Se o vendedor colar a URL completa, o
app extrai o slug e segue — sem exigir que ele apague o `https://`.

### 3.4 Validação da empresa antes de pedir a senha

Medido nesta caixa (curl, GET):

| Resposta a `GET {baseUrl}/api/usuarios/me` | Significado | Mensagem ao vendedor |
|---|---|---|
| **404** `text/html` | tenant não existe (`tenant-middleware.js:186-188`) | "Empresa não encontrada. Confira o nome." |
| **402** | tenant `SUSPENDED`/`CANCELLED` (`tenant-middleware.js:189-191`) — *não testado, lido no código* | "Conta suspensa. Fale com o suporte." |
| **401** `application/json` | empresa existe, falta logar | segue para a senha |
| **200** `application/json` | já logado | pula direto para a Home |
| erro de rede/DNS | — | "Sem conexão" — **não** dizer "empresa não existe" |

Por que `/api/usuarios/me` e não `/login.html`: **`/login.html` responde 200 em
qualquer host**, porque o static de `public/auth` é montado por
`applyBaseMiddleware` (`server.js:13`) antes do middleware de tenant
(`server.js:54`). Usar `/login.html` como ping daria "empresa existe" para
qualquer texto digitado.

`/api/usuarios` está em `LIBERADOS` (`perfis-api-map.js:29-30`), então esse ping
não é barrado pelo RBAC de perfil.

---

## 4. IDENTIFICAÇÃO DO VENDEDOR — regra oficial do app

### 4.1 A regra

> **O app NUNCA envia `vendedorId`.**
> O vendedor do pedido é `req.session.userId`, determinado pelo backend.

Isso funciona hoje, sem nenhuma mudança: `pedidos-routes.js:348` já usa
`req.session?.userId` quando `vendedorId` não vem no corpo. E o campo **não está**
em `CAMPOS_PEDIDO` como obrigatório — o `PUT` só o aplica se for enviado
(`pedidos-routes.js:563-567`).

Corolários para o app:
- não enviar `vendedorId` no `POST /api/pedidos`;
- não enviar `vendedorId` no `PUT /api/pedidos/:id` (o `coletarBody()` da tela web envia — `pedido.html:1515` — o app **não deve copiar esse comportamento**);
- nunca chamar `GET /api/usuarios?vendedor=1` para montar um seletor de vendedor. No app não existe esse seletor.

### 4.2 O backend deve ignorar sempre, ou só para quem não tem permissão?

O enunciado oferece duas saídas. **Nenhuma das duas isolada é a certa** — e a
razão está no código: os mesmos handlers atendem o app, a tela web, a loja
virtual, o PDV e a OS. Uma regra "ignore sempre `vendedorId`" quebraria a tela web
de propósito, onde atribuir pedido a outro vendedor é função legítima e usada
(`POST /api/pedidos/acao-massa` com `acao:'vendedor'`,
`pedidos-routes.js:284-334`, existe exatamente para isso).

**Recomendação: regra por permissão, aplicada no handler compartilhado.**

```
ao gravar vendedorId (POST /api/pedidos e PUT /api/pedidos/:id):

  se NÃO há sessão (X-Api-Key):
      → manter comportamento atual (aceita o corpo)      ← não quebra Electron/integrações

  se há sessão E o corpo traz vendedorId:
      se vendedorId === req.session.userId   → aceita (é ele mesmo)
      senão se usuário PODE delegar          → aceita, e REGISTRA em audit_log
      senão                                  → IGNORA o corpo e usa req.session.userId
                                               (ignorar, não 403 — ver abaixo)

  se há sessão E o corpo NÃO traz vendedorId:
      → req.session.userId    (comportamento de hoje)
```

**Por que ignorar em vez de devolver 403:** um 403 quebraria a tela web atual para
qualquer usuário não-admin no instante em que a regra subisse — a tela **sempre**
manda `vendedorId` no `PUT`, mesmo quando é o próprio usuário. Ignorar
silenciosamente converge para o valor correto sem regressão visível. **HIPÓTESE:**
que nenhum outro consumidor dependa de delegar `vendedorId` sem permissão — não
levantei todos os chamadores do `PUT` fora da tela de pedido.

**Quem "pode delegar" — proposta:** `req.user.role === 'admin'`, ou perfil que
tenha a página `comercial-metas` / `comissoes` (quem administra meta e comissão é
quem legitimamente reatribui venda). A decisão final é de produto; o mecanismo
existe (`acessoDoUsuario`, `perfis-acesso.js:99-107`).

### 4.3 Ponto de atenção que não é do app

Mesmo com a regra acima, `pedidos.vendedorId` **continua sem FK e sem validação
de `ehVendedor`** (Caixa 2 §3.3, §3.6). Um `vendedorId` delegado por um admin
pode apontar para um `users.id` inativo ou inexistente. Isso é dívida existente,
não criada pelo app — vale corrigir junto (§6), não antes.

---

## 5. PREÇO — proposta de correção

### 5.1 O problema, em uma frase

O backend grava o `precoUnitario` que o cliente HTTP mandar, sem comparar com
nada (`pedidos-routes.js:361-363`, `:719-721`, `:744-746` — Caixa 1 §5.3). Com o
app, quem controla esse valor passa a ser um binário num celular que o próprio
vendedor pode instrumentar.

### 5.2 A forma da correção

**Recomendo VALIDAR, não recalcular cegamente** — com recálculo como *default* e
o valor enviado tratado como *intenção de desconto*:

```
POST /api/pedidos/:id/itens
   { produtoId, quantidade, precoUnitario? , descricao?, motivoDesconto? }

servidor:
  1. se NÃO há produtoId  → item livre (serviço, desconto de capa):
        mantém o comportamento atual, sem resolução de preço.        ← ver 5.5
  2. senão:
        precoSugerido = resolverPreco(db, produtoId, {
             pessoaId : pedido.clienteId,          ← do PEDIDO, não do corpo
             quantidade,
             tabelaId : pedido.tabelaPrecoId       ← do PEDIDO, não do corpo
        })
  3. se precoUnitario NÃO veio  → grava precoSugerido.               ← caminho do app
  4. se precoUnitario veio:
        se >= precoSugerido                 → aceita (venda acima da tabela é livre)
        se >= piso E usuário pode descontar → aceita + registra desconto
        senão                               → 422 com { precoSugerido, piso, fonte }
```

**O contexto de preço vem do pedido, nunca do corpo.** Esse é o ponto que fecha o
buraco: `pessoaId` e `tabelaId` lidos de `pedidos.clienteId` e
`pedidos.tabelaPrecoId` — se viessem do corpo, o cliente escolheria a tabela mais
barata e a validação viraria teatro.

### 5.3 Resposta direta ao que foi perguntado

> "Defina se a futura criação de item deve receber productId, quantidade,
> cliente, tabela de preço/contexto, e então o servidor calcular o preço."

**Sim para `produtoId` e `quantidade`. Não para cliente e tabela.** Cliente e
tabela **já estão no pedido** e o servidor os lê de lá. Mandá-los no corpo seria
reintroduzir pelo contexto o mesmo problema que se está fechando pelo preço.

### 5.4 Como preservar o preço manual autorizado

Três camadas, todas com peça já existente no repositório:

| Camada | Fonte | Estado hoje |
|---|---|---|
| **Piso** | `produtos.precoMinimoVenda` | existe; validado só no cadastro (`produtos-routes.js:149-156`). Cobertura desigual: `produtosbomgosto` 76/76, `raeldouglas` 19/20, `1bit` 7/132 (Caixa 2 §7.7) |
| **Permissão de descontar** | perfil (`perfis_acesso`) | mecanismo existe; **não há permissão por campo** hoje (Caixa 2 §3.9) — seria nova |
| **Rastro** | `audit_log` via `logAction` | existe (`audit-log.js:19`); grava desde que haja `req.user` — o que é o caso com sessão |

**Quando `precoMinimoVenda` é nulo** (a maioria no `1bit`): a regra **não** pode
bloquear, senão trava o tenant inteiro. Proposta: piso ausente → aceita, mas
**registra** o desconto em `audit_log` com o `precoSugerido` para o gestor ver.
Assim a regra tem valor mesmo onde o cadastro é fraco, e o cliente ganha um
incentivo concreto para preencher o mínimo.

### 5.5 O que NÃO pode ser quebrado

- **Item sem `produtoId`** — serviço e desconto de capa entram assim (`pedido_itens.produtoId` nullable, Caixa 1 §2.2). Sem resolução de preço para eles.
- **Preço negativo** — é como a OS lança desconto de capa (`os-routes.js:2265-2268`). Bloquear negativo quebraria o faturamento de OS.
- **Os outros consumidores** — tela web, PDV, loja virtual e OS passam pelos **mesmos handlers**. Recomendação: a validação nasce **ligada por configuração** (`config.preco_validar = '0'` por padrão) e é ligada por tenant, começando pelo tenant do piloto. Sem isso, uma regra nova entra em produção para 12 empresas de uma vez.

**Não implementar nesta etapa.**

---

## 6. `vendedorId` — proposta de correção

Especificação em §4.2. Aqui, o complemento de permissões e integridade.

### 6.1 Permissões recomendadas

| Papel | Pode gravar `vendedorId` diferente do próprio? |
|---|---|
| `role = 'admin'` | **sim** (é irrestrito por definição — `perfis-acesso.js:104`) |
| Perfil com página `comercial-metas` ou `comissoes` | **sim** — quem administra meta/comissão reatribui venda |
| Demais perfis (inclusive o vendedor) | **não** — corpo ignorado, vale `req.session.userId` |
| Sem sessão (X-Api-Key) | mantém o comportamento atual — não quebra Electron/integrações |

### 6.2 Pontos de aplicação (todos precisam da mesma regra)

1. `POST /api/pedidos` — `pedidos-routes.js:348`
2. `PUT /api/pedidos/:id` — via `CAMPOS_PEDIDO` (`pedidos-routes.js:62-78`, aplicação em `:563-567`)
3. `POST /api/pedidos/acao-massa` com `acao:'vendedor'` — `pedidos-routes.js:308-311`
4. `POST /api/pedidos/importar-participacao/:id` — `pedidos-routes.js:501-502`

Deixar qualquer um de fora torna a regra decorativa: o vendedor usaria o caminho
não coberto.

### 6.3 Integridade, junto

Enquanto se mexe nisso, vale validar que o `vendedorId` gravado **existe, está
`ativo = 1` e tem `ehVendedor = 1`** — hoje `Number(x) || null` aceita qualquer
inteiro e não há FK (Caixa 2 §3.3). Um `vendedorId` inválido contamina
`metas_vendas` e `comissoes_apuracao` silenciosamente.

**Não implementar nesta etapa.**

---

## 7. NUMERAÇÃO — há risco de corrida?

### 7.1 Resposta: hoje não, e a razão é frágil

`gerarNumero()` (`pedidos-routes.js:91-101`) faz `SELECT ... ORDER BY id DESC
LIMIT 1` e o `POST /api/pedidos` insere logo depois, **fora de transação**
(`pedidos-routes.js:350-355`).

Isso **não** produz corrida hoje porque:

1. `better-sqlite3` (v12.5.0) é **síncrono** — cada `prepare().get()/run()` bloqueia o event loop;
2. **não há `await` entre `gerarNumero()` e o `INSERT`**;
3. **o HTTP roda em um único processo Node, sem cluster** — verificado nesta caixa (`MainPID=1388723`, `ps` mostra um processo, sem `cluster.fork`).

Logo, gerar e inserir é uma **seção crítica de fato**, garantida pelo modelo de
concorrência do Node — não por desenho.

### 7.2 Por que isso é frágil

A garantia se perde com qualquer uma destas mudanças, todas plausíveis:

| Mudança | Efeito |
|---|---|
| Ligar cluster / segundo worker HTTP | duas requisições realmente simultâneas → mesmo número → `UNIQUE constraint failed: pedidos.numero` → HTTP 500 |
| Um `await` entrar entre gerar e inserir | idem, mesmo com um processo |
| Um job do `scheduler.js` passar a criar pedido | idem (hoje ele não cria) |

E há um segundo defeito, independente de concorrência (Caixa 1 §4): a função usa
`ORDER BY id DESC`, **não `MAX(numero)`**. Um número maior num `id` menor —
possível via `converter-modo` (`pedidos-routes.js:673`), que regera o número de um
pedido antigo — faz a sequência repetir um número já usado. Não reproduzido:
**HIPÓTESE**.

### 7.3 Solução proposta

Duas medidas, ambas pequenas:

**(a) Envolver geração + inserção numa transação `IMMEDIATE`.** É o que a loja
virtual já faz (`loja-routes.js:338-350` usa `db.transaction()`), e é o padrão
correto para o SQLite: `BEGIN IMMEDIATE` pega o lock de escrita **antes** do
`SELECT`, então dois processos serializam em vez de colidirem — com
`busy_timeout = 5000` (`tenant-manager.js:496`) o segundo espera em vez de falhar.

**(b) Trocar `ORDER BY id DESC` por um cálculo sobre o próprio número.** Extrair o
maior sufixo numérico do prefixo do ano em vez de confiar na ordem de inserção.

Cobre painel + app + loja + marketplace de uma vez, porque `gerarNumero` é
exportada (`pedidos-routes.js:1471`) e a loja já a importa
(`loja-routes.js:24`).

**Ressalva:** Mercado Livre (`marketplaces-ml.js:298-302`), marketplaces
(`marketplaces-routes.js:149-153`) e OS (`os-routes.js:2194`) **não usam
`gerarNumero`** — têm numeração própria. Não colidem com `PED-` (prefixos
diferentes), mas cada uma tem o mesmo padrão "último + 1" e o mesmo defeito. Não
é urgente; é dívida a registrar.

**Prioridade: ANTES DA PRODUÇÃO, não antes do MVP.** Com um processo só, o app não
introduz o risco. Mas é barato e deve entrar antes de qualquer conversa sobre
escalar o servidor.

---

## 8. TRANSAÇÃO — qual o fluxo ideal para o pedido do app

### 8.1 O que existe hoje

- `POST /api/pedidos` — **sem transação** (Caixa 1 §1.2). INSERT do pedido, INSERTs de itens e UPDATE do total são operações soltas.
- `POST /:id/itens` — sem transação (um INSERT + recálculos).
- `POST /:id/confirmar` — **com transação** (`pedidos-routes.js:815-820`): reserva + mudança de status, com rollback se faltar saldo.

### 8.2 Recomendação: **manter em etapas para o MVP; um endpoint agregador depois**

O fluxo que o app deve usar no MVP é o que a Caixa 1 §7.5 já validou:

```
POST /api/pedidos                 → cria rascunho (vazio)     → pedidoId
PUT  /api/pedidos/:id             → cliente, tipoOperacao, meio, política, frete
POST /api/pedidos/:id/itens  ×N   → um por item (aqui roda sugerirCFOP)
POST /api/pedidos/:id/confirmar   → transação: reserva + status
```

**Por que não fazer tudo numa transação única agora**, apesar de a pergunta
sugerir isso:

1. **A parte que precisa de atomicidade já é atômica.** O `confirmar` — que reserva estoque e muda status — já roda em transação com rollback (`pedidos-routes.js:815-829`). É lá que uma falha parcial custaria caro (reserva sem pedido confirmado). Isso está resolvido.
2. **O rascunho parcial não é um estado inválido.** Um pedido em `rascunho` com 3 de 5 itens é exatamente o que a tela web produz o tempo todo. Ele não reserva, não movimenta estoque, não gera financeiro (Caixa 1 §6.1) e é excluível (`DELETE /api/pedidos/:id`, `pedidos-routes.js:648`). O custo de uma falha no meio é um rascunho órfão — visível e apagável, não uma inconsistência.
3. **O `sugerirCFOP` só roda no `POST /:id/itens`** (`pedidos-routes.js:709-717`). Um endpoint agregador teria de reimplementar ou chamar essa lógica; enquanto isso não existe, ir por `/itens` é o caminho que produz o item **completo** (§9).
4. **Etapas dão feedback melhor no celular.** Rede móvel cai no meio. Com etapas, o app sabe exatamente o que já foi gravado e retoma; com uma chamada monolítica, um timeout deixa o app sem saber se o pedido nasceu — que é precisamente o cenário de duplicação (§18).

### 8.3 O agregador que eu recomendo — para a fase 2, não para o MVP

```
POST /api/pedidos/completo
  { cliente:{id}, itens:[{produtoId, quantidade, precoUnitario?}],
    tipoOperacaoId, meioPagamento, politicaPrazoId, frete{...},
    observacao, confirmar:true, clientRequestId:"uuid" }

  BEGIN IMMEDIATE
    gerarNumero + INSERT pedidos           (vendedorId = req.session.userId)
    para cada item: resolverPreco + sugerirCFOP + INSERT pedido_itens
    recalcularTotal
    se confirmar: criarReservasPedido → se insuficiente e !forcar → ROLLBACK 409
    UPDATE status = 'confirmado'
  COMMIT
  → { pedidoId, numero, valorTotal, itens:[{precoAplicado, fonte, cfop}] }
```

Ganhos concretos: uma ida e volta em vez de N+3; atomicidade real de ponta a
ponta; e o lugar natural para `clientRequestId` (§18) e para a validação de preço
(§5). **Não é pré-requisito do MVP** — é a otimização que faz sentido depois que
o fluxo em etapas provar o produto em campo.

---

## 9. CFOP / DADOS FISCAIS DOS ITENS

### 9.1 O fato

Itens criados **junto** com o pedido (`POST /api/pedidos` com `itens[]`) nascem com
`cfop = NULL` — o handler não chama `sugerirCFOP` (`pedidos-routes.js:361-363`).
Itens criados por `POST /api/pedidos/:id/itens` **recebem CFOP**
(`pedidos-routes.js:709-717`). No faturamento, o item cai em
`it.cfop || it.prodCfop` (`faturas-routes.js:228`) — se o produto não tiver
`cfopPadrao`, o item vai à SEFAZ sem CFOP (Caixa 1 §7.5).

### 9.2 Regra para o app

> **O app nunca envia `cfop`, nunca envia `itens[]` no `POST /api/pedidos`, e
> sempre adiciona item por `POST /api/pedidos/:id/itens`.**

Com isso, o problema **não existe para o app** — sem nenhuma mudança de backend.
É a razão pela qual a Caixa 2 (matriz #16) já recomendava esse endpoint.

O app também **não deve** entender NCM, CST, origem ou CFOP. Tudo isso é
resolvido no faturamento a partir do cadastro do produto
(`faturas-routes.js:167`, `:233-236`).

### 9.3 Onde a lógica deve ficar

**Onde já está:** `sugerirCFOP()` em `tipos-operacao-routes.js:295`, alimentada
por `pedidos.tipoOperacaoId` + `pedidos.clienteId` + `pedidos.ufEntrega` +
`produtoId`.

Uma observação de ordem que o app precisa respeitar: `sugerirCFOP` lê o
`tipoOperacaoId` **do pedido** (`pedidos-routes.js:710-715`). Se o app adicionar
itens **antes** de gravar o `tipoOperacaoId` pelo `PUT`, o CFOP sai calculado com
o tipo padrão. **Ordem correta: `POST /api/pedidos` → `PUT` (com
`tipoOperacaoId` e `clienteId`) → `POST /itens`.** Existe rede de segurança
manual (`POST /api/pedidos/:id/itens/:itemId/recalcular-cfop`,
`pedidos-routes.js:757`), mas o app não deveria precisar dela.

**Melhoria opcional, fora do MVP:** fazer o `POST /api/pedidos` chamar
`sugerirCFOP` para os itens que receber, igualando os dois caminhos. Beneficia
todos os consumidores, não só o app.

---

## 10. ESTOQUE NO APP

### 10.1 O que mostrar

O vendedor precisa de **uma** informação: posso vender esta quantidade agora?

```
┌──────────────────────────────────────┐
│ TEMP-01  Tempero verde 500g          │
│ R$ 12,50 /UN     ★ Tabela do cliente │
│ ● Disponível: 18 UN                  │
└──────────────────────────────────────┘
```

**Mostrar `disponivel`. Não mostrar `saldo` nem `reservado` na tela principal.**
Motivo prático: `saldo` é o número que engana — um produto com saldo 20 e 18
reservados tem 2 vendáveis, e mostrar 20 produz uma venda que o `confirmar`
recusa com 409 (Caixa 2 §8.1).

`saldo` e `reservado` podem aparecer num detalhe secundário (toque longo), para o
vendedor experiente entender *por que* há pouco disponível. **Nunca** na lista.

Semáforo sugerido: `disponivel >= quantidade` verde · `0 < disponivel <
quantidade` âmbar com "só N disponíveis" · `<= 0` cinza "sem estoque".
Truncar negativo em 0 na exibição — `/api/estoque` pode devolver negativo
(`estoque-routes.js:431`, sem `Math.max`), enquanto a loja trunca
(`loja-routes.js:122`).

### 10.2 De onde vem o número

`POST /api/estoque/verificar-disponibilidade` (`reservas-routes.js:641-677`),
chamado com o carrinho inteiro:

```
{ itens: [ {produtoId, quantidade}, ... ] }
→ { tudoDisponivel, itens:[{produtoId, sku, saldo, reservado, disponivel,
                            suficiente, faltando}], insuficientes:[...] }
```

Uma chamada para o carrinho todo, no momento da revisão. **Não** chamar por item
a cada tecla digitada — a busca de produto já traz o suficiente para a lista, e
esse endpoint é para a conferência antes de enviar.

É o mesmo cálculo que `criarReservasPedido` usará no `confirmar`
(`reservas-routes.js:172-179`), então o que o app mostra e o que o servidor decide
não divergem. **Depende da liberação de RBAC descrita em §12.**

### 10.3 Dois vendedores nas últimas unidades

**Não há corrida, e a razão é verificável.** O HTTP roda em **um processo Node,
sem cluster** (verificado nesta caixa), e `better-sqlite3` é síncrono. As duas
confirmações são serializadas pelo event loop: a segunda só começa depois que a
primeira terminou de gravar a reserva.

Sequência real com 2 unidades disponíveis e dois pedidos de 2:

```
t0  Vendedor A: POST /confirmar
      BEGIN → saldoFisico=2, reservado=0 → disponivel=2 ≥ 2 ✓
            → INSERT reservas_estoque (2, 'ativa')
            → UPDATE pedidos SET status='confirmado'
      COMMIT                                                 → 200 OK

t1  Vendedor B: POST /confirmar
      BEGIN → saldoFisico=2, reservado=2 → disponivel=0 < 2 ✗
            → insuficiencias=[{faltando:2}]  → throw 'INSUFICIENTE'
      ROLLBACK                                               → 409
```

O 409 traz a lista `insuficiencias` com `sku`, `saldo`, `reservado`,
`disponivel`, `faltando` (`pedidos-routes.js:824-827`).

**Como o app trata o 409** — e isto é decisão de produto:

| Opção | Comportamento | Quando |
|---|---|---|
| **Ajustar** (recomendada no MVP) | mostra "só sobrou 0 de TEMP-01" e oferece corrigir a quantidade ou remover o item | padrão |
| **Insistir** | reenvia com `{forcar:true}` — confirma com estoque negativo (`pedidos-routes.js:813-818`) | só para quem tem alçada; **fora do MVP** |
| **Deixar em rascunho** | não confirma; o pedido fica salvo para o escritório resolver | alternativa razoável em campo |

**Não colocar `forcar:true` no app do vendedor no MVP.** Quem decide vender sem
estoque é o escritório, na tela web, que já tem esse botão.

### 10.4 Duas ressalvas herdadas (não são do app)

- O saldo é calculado **globalmente, sem recorte de depósito** (`reservas-routes.js:172-177`) mesmo com `depositoId` gravado. O app não deve prometer "disponível na filial X".
- **Reserva não expira.** Um pedido confirmado e abandonado segura estoque indefinidamente. Com o app criando mais pedidos, isso tende a aparecer. Dívida existente; registrar, não resolver agora.

---

## 11. "MEUS PEDIDOS" — adaptação mínima

### 11.1 O problema

`GET /api/pedidos` (`pedidos-routes.js:182-232`) não aceita `vendedorId` e não
tem `LIMIT` (`:226-227`). Sem mudança, "meus pedidos" obrigaria a baixar todos os
pedidos da empresa para o celular — vazamento por desenho (Caixa 2 §10, risco 7).

### 11.2 Adaptação proposta — a menor possível

Dois parâmetros novos no handler existente, sem endpoint novo:

```
GET /api/pedidos?meus=1&limit=20&offset=0
```

| Parâmetro | Semântica |
|---|---|
| `meus=1` | `AND p.vendedorId = req.session.userId`. **Ignora qualquer `vendedorId` do query** — a fonte é a sessão |
| `vendedorId=N` | só aceito para quem pode ver outros (§11.3); caso contrário **ignorado** (mesma política de §4.2) |
| `limit` / `offset` | default `limit=50`, teto `200`. Sem eles, comportamento atual preservado |

Manter os filtros atuais (`status`, `busca`, `clienteId`…) funcionando junto.

Índice: já existe `idx_pedidos_status` e `idx_pedidos_cliente`, mas **não há
índice em `vendedorId`** (Caixa 1 §2.1). Com volumes atuais (57 pedidos no
sistema inteiro) é irrelevante; ao crescer, um índice em
`(vendedorId, dataPedido)` resolve. Registrar, não fazer agora.

### 11.3 Perfis superiores

| Papel | Vê |
|---|---|
| Vendedor (perfil restrito) | **só os próprios** — `meus=1` implícito; `vendedorId` do query ignorado |
| `role='admin'` ou perfil com `comercial-metas`/`comissoes` | todos, e pode filtrar por `vendedorId=N` |
| Sem sessão (X-Api-Key) | comportamento atual (tudo) — não quebra integrações |

**Ponto de honestidade:** para o vendedor, o filtro deveria ser **imposto**, não
opcional — senão ele omite `meus=1` e vê tudo. Impor exige decidir "quem é
vendedor para efeito de restrição", e a resposta natural (`ehVendedor = 1`) hoje
**não é uma permissão** (Caixa 2 §3.9). **HIPÓTESE de desenho:** tratar
`ehVendedor = 1 AND role != 'admin'` como "restrito a si mesmo" — precisa de
validação com o produto, porque muda o comportamento da tela web para esses
usuários também.

Para o MVP, o app envia `meus=1` sempre; a imposição server-side entra junto da
correção de `vendedorId` (§6), que é a mesma discussão de permissão.

---

## 12. ACESSO A ESTOQUE — menor privilégio

### 12.1 O problema

`POST /api/estoque/verificar-disponibilidade` mora em `reservas-routes.js:641`,
mas o RBAC casa por **prefixo de caminho** — `'/api/' + path.split('/')[2]`
(`perfis-acesso.js:152`). Como o caminho começa com `/api/estoque`, ele cai na
lista de `perfis-api-map.js:92`, que **não inclui a página `pedidos`**. O perfil
real "Comercial Flash" leva 403 (Caixa 2 §8.4).

### 12.2 As três saídas, e por que duas são ruins

| Opção | O que faz | Avaliação |
|---|---|---|
| **A.** Adicionar `'pedidos'` ao array de `/api/estoque` (`perfis-api-map.js:92`) | uma palavra | **Ruim.** Libera **todo** `/api/estoque` para o vendedor: `/movimentacoes` (extrato), `/valorizacao` e `/abc` e `/cmv` (**custo e margem**), `POST /movimentacoes` (**criar movimentação de estoque**). Viola menor privilégio de forma grosseira |
| **B.** Dar ao perfil do vendedor a página `estoque` | zero código | **Ruim pelo mesmo motivo**, e ainda coloca a tela de estoque no menu dele |
| **C.** Expor a consulta sob um prefixo que o vendedor já tem | rota nova, lógica existente | **Recomendada** |

### 12.3 Recomendação: opção C

> Expor a mesma função sob **`POST /api/produtos/disponibilidade`**.

Por que resolve com o mínimo:

1. O prefixo passa a ser `/api/produtos`, que **já inclui a página `pedidos`** (`perfis-api-map.js:161`, confirmado na Caixa 2 §6.1). **Zero alteração no mapa de RBAC.**
2. O vendedor ganha **exatamente uma** capacidade nova — perguntar quanto há disponível de uma lista de produtos. Não ganha extrato, não ganha custo, não ganha margem, não ganha escrita.
3. A lógica não é duplicada: o handler atual (`reservas-routes.js:641-677`) já é autocontido — usa `saldoReservado()` (`:50-57`) e uma soma sobre `movimentacoes_estoque`. Registrar a mesma função em dois caminhos é trivial e mantém uma fonte só.
4. **Semanticamente é onde deveria estar.** "Quanto tem deste produto" é pergunta sobre produto.

**Reduzir ainda mais a resposta (opcional):** para o app, devolver só
`{produtoId, sku, disponivel, suficiente, faltando}`, omitindo `saldo` e
`reservado`. Menos informação de negócio no aparelho, e é o que a tela precisa
(§10.1). **HIPÓTESE:** que nenhum consumidor atual dependa do caminho antigo com
todos os campos — o caminho `/api/estoque/verificar-disponibilidade` permanece
como está, então não há regressão.

**Prioridade: ANTES DO MVP.** Sem isso, o app não mostra estoque em tenant com
perfil cadastrado — e é justamente o cenário do segundo piloto.

---

## 13. RATE LIMIT DE LOGIN

### 13.1 O defeito

`auth-routes.js:51-54` lê `X-Forwarded-For` **cru** e pega o primeiro elemento:

```js
const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
```

O nginx usa `$proxy_add_x_forwarded_for` (`/etc/nginx/nginx.conf:54`), que
**anexa** ao header enviado pelo cliente. Se o cliente manda
`X-Forwarded-For: 9.9.9.9`, o header chega `9.9.9.9, <ip real>` e a função escolhe
`9.9.9.9`. O contador de tentativas passa a ser indexado por um valor que o
atacante controla.

### 13.2 Correção proposta

**Usar `req.ip` e apagar a leitura manual do header.** `server.js:8` já faz
`app.set('trust proxy', 1)`, então o Express calcula `req.ip` corretamente:
descarta o último salto confiável e devolve o IP real do cliente.

```js
function _loginClientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
```

Um detalhe importa: **`trust proxy` = 1 significa "confie em UM proxy"**. Isso
está certo para a topologia atual (cliente → nginx → node). Se o Cloudflare
entrar na frente, passam a existir dois saltos e o valor precisa virar `2` —
**ou**, melhor, o vhost do tenant passa a incluir `set_real_ip_from` para as
faixas da Cloudflare, corrigindo o header antes do Node.

Estado atual verificado (Caixa 2): **`/etc/nginx/conf.d/cloudflare.inc` existe mas
não é incluído por nenhum vhost de tenant** — nada reescreve o header hoje.

### 13.3 Duas melhorias que valem junto

1. **Limitar por conta, não só por IP.** Contador por `username` (ex.: 10 falhas/15 min) — sobrevive à troca de IP e é o que realmente protege a senha de um vendedor.
2. **Estado fora da memória do processo.** Hoje o `Map` (`auth-routes.js:35`) zera a cada restart. Uma tabela no tenant resolveria, ao custo de escrita por tentativa. **Opcional.**

### 13.4 Classificação: **ANTES DA PRODUÇÃO**

Não é "antes do MVP" porque durante o piloto (uma empresa, 1-2 vendedores,
acompanhamento próximo) o risco é gerenciável e um brute-force seria percebido.

Não é "pós-MVP" porque o app **multiplica as contas com acesso real ao ERP** e as
tira do perímetro conhecido. Liberar para vários clientes com o limitador
contornável seria escalar um problema conhecido — e a correção é de duas linhas.

**Regra: pode desenvolver e pilotar sem; não pode abrir para o segundo cliente
sem.**

---

## 14. ESPECIFICAÇÃO FUNCIONAL DAS APIs DO MVP

Autenticação de **todas**: cookie de sessão `liciteagora.sid` + `Host` do tenant.
Nenhuma usa X-Api-Key.

| # | Função | Método · Rota | Situação | Parâmetros principais | Retorno esperado |
|---|---|---|---|---|---|
| 1 | **Login** | `POST /api/login` | **Reutilizar** | `{ username, password }` | `200 {success, username, nome, role}` + `Set-Cookie`; `401` credencial; `429` + `Retry-After` |
| 2 | **Ping de empresa** | `GET /api/usuarios/me` | **Reutilizar** | — | `401` = existe, deslogado; `404` html = empresa inexistente; `402` = suspensa; `200` = logado |
| 3 | **Usuário logado** | `GET /api/usuarios/me` | **Adaptar** | — | `{id, username, nome, role, ativo, estabelecimentoId}` — falta **`ehVendedor`** (`auth.js:257`) |
| 4 | **Logout** | `POST /api/logout` | **Reutilizar** | — | `{success:true}` |
| 5 | **Buscar cliente** | `GET /api/pessoas/autocomplete` | **Reutilizar** | `q` (≥2 chars) | até **10**: `id, cpfCnpj, tipo, razaoSocial, nomeFantasia, endereco…, telefone, email` |
| 6 | **Detalhe do cliente** | `GET /api/pessoas/:id` | **Reutilizar** | — | ficha completa — necessário para `tabelaPrecoId`/`politicaPrazoId`, que o autocomplete não traz |
| 7 | **Condições de pagamento** | `GET /api/pessoas/condicoes-pagamento` | **Reutilizar** | `pessoaId`, `onde=vendas` | `{permitidos:[tPag], prazo:[30,60], rotulos, politica}` — evita o 400 do `PUT` |
| 8 | **Criar cliente** | `POST /api/pessoas` | **Reutilizar** | `cpfCnpj`, `razaoSocial` (únicos obrigatórios) + endereço | `{success, pessoa}`; `409` duplicado (com a pessoa no corpo); `{reativada:true}` se estava inativo |
| 9 | **Buscar produto** | `GET /api/produtos/autocomplete` | **Reutilizar** | `q` | até **20**: `id, sku, descricao, unidade, precoVenda, rastreiaLote, rastreiaSerial` |
| 10 | **Preço** | `GET /api/precos/resolver` | **Reutilizar** | `produtoId`, `quantidade`, `pessoaId`, `tabelaId` | `{preco, fonte, tabelaId?, tabelaNome?}`. **`preco:0` é ambíguo** (Caixa 2 §7.5) |
| 11 | **Disponibilidade** | `POST /api/produtos/disponibilidade` | **Criar** (§12 — reexpõe `reservas-routes.js:641`) | `{itens:[{produtoId, quantidade}]}` | `{tudoDisponivel, itens:[{produtoId, sku, disponivel, suficiente, faltando}]}` |
| 12 | **Tipos de operação** | `GET /api/tipos-operacao?usoPedido=1` | **Reutilizar** | — | lista com `emiteNFe`, `geraFinanceiro`, `movimentaEstoque` |
| 13 | **Criar pedido** | `POST /api/pedidos` | **Reutilizar** | `{modoDocumento:'pedido'}` — **sem `vendedorId`, sem `itens[]`** | `{success, pedido:{id, numero, …}}` |
| 14 | **Cabeçalho** | `PUT /api/pedidos/:id` | **Reutilizar** | `clienteId`, `tipoOperacaoId`, `meioPagamento`, `politicaPrazoId`, `tipoFrete`, `valorFrete`, `observacao` | `{success, pedido}`; `400` se a política do cliente for contrariada |
| 15 | **Adicionar item** | `POST /api/pedidos/:id/itens` | **Reutilizar** (**Adaptar** em §5) | `produtoId`, `descricao`, `quantidade`, `precoUnitario` | `{success, item, pedido}` — **calcula CFOP** |
| 16 | **Alterar/remover item** | `PUT` / `DELETE /api/pedidos/:id/itens/:itemId` | **Reutilizar** | `quantidade`, `precoUnitario` | `{success, pedido}` |
| 17 | **Confirmar** | `POST /api/pedidos/:id/confirmar` | **Reutilizar** | `{}` (**sem `forcar`** no MVP) | `200 {pedido}`; **`409 {insuficiencias:[…]}`** |
| 18 | **Meus pedidos** | `GET /api/pedidos?meus=1&limit=&offset=` | **Adaptar** (§11) | `meus`, `limit`, `offset`, `status` | lista com `numero, clienteNome, valorTotal, status, dataPedido` |
| 19 | **Detalhe do pedido** | `GET /api/pedidos/:id` | **Reutilizar** | — | cabeçalho + `itens[]` + `clienteNome` + `vendedorNome` |
| 20 | **Histórico** | `GET /api/pedidos/:id/historico` | **Reutilizar** | — | só tem linhas de cancelar/reabrir (Caixa 1 §1.3) |
| 21 | **PDF** | `GET /api/pedidos/:id/pdf` | **Reutilizar** | — | `application/pdf` — para compartilhar com o cliente |
| 22 | **Excluir rascunho** | `DELETE /api/pedidos/:id` | **Reutilizar** | — | `{success}`; só `rascunho`; `409` se houver vínculo |

**Contagem: 19 reutilizar · 2 adaptar (#3, #18) · 1 criar (#11).**
Nenhum endpoint novo de **escrita** — confirmando Caixa 1 §7.5.

---

## 15. MVP DO APP

### 15.1 Avaliação da sua proposta

Sua lista está boa. Eu tiraria três itens e acrescentaria dois.

**Manter como está:** Login · Home · Novo pedido (cliente → produtos → quantidade
→ preço → estoque → revisar → enviar) · Meus pedidos · Detalhe.

**Tirar do MVP:**

| Item | Por quê |
|---|---|
| **Frete** (passo 7) | `tipoFrete`/`valorFrete` são campos livres sem validação (Caixa 1 §2.10) e frete é decisão de expedição, não do vendedor em campo. Entra na v2 se o piloto pedir |
| **"Clientes" e "Produtos" como itens de menu** | No MVP, cliente e produto se acessam **de dentro do pedido**. Uma tela de catálogo separada é navegação a mais para zero venda. Consulta rápida entra na v2 |
| **Condição de pagamento como passo próprio** | Não some — vira parte da revisão, com o valor **já preenchido** por `GET /api/pessoas/condicoes-pagamento`. Vira um passo só quando o cliente tem várias opções |

**Acrescentar:**

| Item | Por quê |
|---|---|
| **Criar cliente durante a venda** | O vendedor está na frente de um cliente novo. Sem isso ele volta com o pedido não lançado — que é exatamente o problema que o app existe para resolver. `POST /api/pessoas` exige só `cpfCnpj` + `razaoSocial` |
| **Compartilhar o PDF do pedido** | `GET /api/pedidos/:id/pdf` já existe. É o que fecha a visita: o cliente recebe a confirmação no WhatsApp na hora |

### 15.2 MVP resultante

```
LOGIN
  empresa (slug) → usuário → senha

HOME
  [ + NOVO PEDIDO ]           ← botão dominante
  Meus pedidos (últimos 5)
  ⟳ sincronizar · sair

NOVO PEDIDO
  1. Cliente        buscar (≥2 chars) · selecionar · [+ novo cliente]
  2. Itens          buscar produto → quantidade → preço (do servidor) → adicionar
                    carrinho sempre visível (rodapé: N itens · R$ total)
  3. Revisar        itens editáveis · condição de pagamento (pré-preenchida)
                    observação · conferência de disponibilidade
  4. [ ENVIAR PEDIDO ]
                    → cria + cabeçalho + itens + confirma
                    → sucesso: "PED-2026-00042 confirmado" [compartilhar PDF]
                    → 409: "só sobraram N de X" [ajustar] [salvar como rascunho]

MEUS PEDIDOS
  lista: número · cliente · valor · status(cor) · data
  filtro: rascunho | confirmado | faturado

DETALHE
  cabeçalho · itens · total · status · [compartilhar PDF]
  se rascunho: [continuar] [excluir]
```

### 15.3 O que **não** entra no MVP

Entregar · faturar · emitir NF-e · cancelar · orçamento (`modoDocumento`) ·
parcelas heterogêneas · `forcar:true` · desconto de capa · múltiplos depósitos ·
tabela de preço forçada · offline · push · código de barras.

Nada disso está bloqueado — tudo tem endpoint. É escopo, e o critério é: **o MVP
prova que o vendedor consegue lançar um pedido correto do celular.** O resto do
ciclo (entregar, faturar, NF-e) já é feito pelo escritório na tela web e não
precisa migrar.

---

## 16. UX PARA USO EM CAMPO

### 16.1 Contexto real

O vendedor está de pé, no balcão do cliente, com uma mão no celular e outra
segurando algo, luz forte, rede ruim, pressa. Não está sentado.

### 16.2 Princípios

1. **Uma decisão por tela.** Nunca pedir cliente + produto + pagamento juntos.
2. **Busca com foco automático e teclado já aberto.** Ao entrar em "Cliente" e em "Produto", o cursor já está no campo. Debounce ~300 ms e mínimo de 2 chars — que é o que `GET /api/pessoas/autocomplete` exige (`financeiro-routes.js:404`).
3. **Alvos grandes.** Mínimo 48 dp de altura. "Adicionar" e "Enviar pedido" ocupam a largura toda.
4. **Carrinho sempre acessível.** Barra fixa no rodapé — "3 itens · R$ 487,50" — tocável de qualquer passo. É a âncora do fluxo.
5. **Quantidade sem teclado quando der.** `[−] 3 [+]` ao lado do campo. Toque no número abre teclado **numérico**. Erro de quantidade é o erro mais caro e mais comum.
6. **Preço vem preenchido e é read-only por padrão.** Editar exige um toque explícito ("alterar preço"), e a origem fica visível — "★ Tabela do cliente", como a tela web já faz (`pedido.html:1688-1693`). Isso reduz digitação e prepara o terreno para a validação de §5.
7. **Estoque como cor, não como texto longo.** Verde/âmbar/cinza (§10.1). O vendedor lê o semáforo em meio segundo.
8. **Erro do servidor vira frase de negócio.** "Cliente tem condição obrigatória 'Boleto 30 dias'" (`pedidos-routes.js:47`) é uma boa mensagem — repassar. Já `500 SQLITE_CONSTRAINT` vira "Não foi possível salvar. Tente de novo."
9. **Nada se perde.** Carrinho persiste ao fechar o app, ao perder rede e ao expirar sessão (§2.4). Um pedido perdido no fim da visita não é bug — é o vendedor abandonando o app.
10. **Confirmação só no envio.** Nenhum "tem certeza?" ao adicionar item. Um único ponto de confirmação, no fim.
11. **Modo claro, alto contraste.** Uso ao ar livre. Fonte mínima 16 sp para valores.
12. **Estados visíveis, sempre.** Toda ação de rede mostra progresso e resultado. Nada de botão que "não faz nada" porque a rede caiu.

### 16.3 Contagem de toques do caminho feliz

```
Home → Novo pedido            1
Buscar cliente (digitar 3)    +1 seleção
Buscar produto (digitar 3)    +1 seleção
Quantidade [+][+]             2
Adicionar                     1
(repetir por item)            ~5 por item adicional
Revisar                       1
Enviar                        1
                              ─────
pedido de 1 item: ~8 toques + 2 buscas digitadas
```

**Meta: pedido de 3 itens em menos de 90 segundos.** É a métrica de UX do piloto
(§21).

---

## 17. TECNOLOGIA

### 17.1 Comparação

| Critério | React Native + Expo | Flutter | PWA |
|---|---|---|---|
| **Android primeiro** | ✅ excelente | ✅ excelente | ✅ excelente |
| **iOS depois** | ✅ mesmo código | ✅ mesmo código | ⚠️ o pior dos três: instalação obscura ("Compartilhar → Adicionar à Tela"), sem loja |
| **Cookie/sessão** | ⚠️ funciona; persistência entre execuções exige jar próprio | ✅ `dio` + `cookie_jar` — o mais limpo dos três | ✅ **trivial** — é o navegador, o cookie funciona sozinho |
| **Manutenção** | ✅ JS/TS — **mesma linguagem do backend** | ⚠️ Dart, linguagem nova para a equipe | ✅ JS, e é o mesmo estilo do `public/` atual |
| **Velocidade até o MVP** | ✅ alta | ⚠️ média (curva do Dart) | ✅ **a mais alta** |
| **Atualização** | ✅ EAS Update — OTA sem loja | ⚠️ Shorebird ou loja | ✅ instantânea, é um deploy |
| **Câmera / código de barras** | ✅ `expo-camera` + `expo-barcode-scanner` | ✅ nativo | ⚠️ `getUserMedia` funciona; no iOS é historicamente instável |
| **Offline** | ✅ SQLite/MMKV local | ✅ | ⚠️ Service Worker — possível, e mais frágil |
| **Push** | ✅ `expo-notifications` | ✅ | ❌ Android sim; **iOS só ≥16.4 e só se "instalado"** |
| **Distribuição** | loja ou APK direto | idem | URL — sem loja, sem revisão |
| **Custo de infra novo** | nenhum | nenhum | ⚠️ precisa servir o shell **antes** do `requireAuth` — hoje `public/` é estático **protegido** (`auth-bootstrap.js:133`); só `public/auth` (`base-middleware.js:41`) e `/loja` (`pre-auth-routes.js:63`) são públicos |

### 17.2 O caso honesto a favor do PWA

Para **só o MVP**, o PWA ganharia: cookie de sessão funciona sem nenhuma
engenharia (é o mesmo mecanismo da tela web), a atualização é um deploy, não há
loja, e a stack é a que o repositório já usa — HTML+JS sem build (Caixa 1 §1.1).
O vendedor acessaria `https://minhaempresa.liciteagora.app/vendas` e a
descoberta de empresa (§3) desapareceria como problema, porque a URL **é** a
empresa.

### 17.3 Por que ainda assim recomendo React Native + Expo

Os requisitos que você mesmo listou como futuros — **iOS, push, offline,
câmera/código de barras** — são exatamente os quatro pontos onde o PWA é fraco, e
três deles são fracos **especificamente no iOS**. Escolher PWA é escolher
reescrever quando esses requisitos chegarem, e a reescrita cairia justamente
quando o app já estiver em uso por vários clientes.

Sobre Flutter: é tecnicamente sólido e resolve o cookie melhor. Perde por
**manutenção**: introduzir Dart num projeto que é 100% JavaScript/CommonJS
(Caixa 1) cria uma segunda cultura de código num repositório mantido por uma
equipe pequena. O ganho técnico não paga esse custo.

### 17.4 Recomendação única

> **React Native + Expo (managed workflow), TypeScript, distribuição inicial por
> APK direto para o piloto e loja depois.**

Com uma condição prévia, explícita: **fazer uma prova de conceito de meio dia
apenas para persistência de cookie de sessão em Android e iOS** antes de escrever
qualquer tela. É o único risco técnico real da escolha, é barato de eliminar, e o
resultado dele é a única coisa que poderia mudar esta recomendação. **HIPÓTESE**
até essa PoC existir.

---

## 18. OFFLINE FUTURO (fora do MVP)

### 18.1 O que preparar desde já — sem implementar

Três decisões de arquitetura que, tomadas agora, tornam o offline barato depois — e
que **não custam nada** no MVP:

1. **Carrinho já é local.** No MVP o app monta o pedido em memória e só chama a API no "Enviar" (§8.2). Isso já é a estrutura de dados de um rascunho offline — falta só persistir.
2. **Toda entidade guardada localmente carrega o `id` do servidor.** Nunca inventar id local para cliente ou produto. Um rascunho offline referencia `produtoId` e `clienteId` reais.
3. **Todo cache carrega `baseUrl` + `userId` na chave.** Impede que a troca de empresa (§2.7) misture catálogos.

### 18.2 O que caberia depois

| Dado | Estratégia | Observação |
|---|---|---|
| Catálogo | sincronização incremental por `dataAtualizacao` | `GET /api/produtos` **não serve** — sem paginação e com subconsulta de saldo por linha (Caixa 2 §6.4). Precisaria de endpoint próprio |
| Clientes | só os recentes/da carteira | mesma limitação em `GET /api/pessoas` |
| Preço | **não cachear como verdade** | tabela tem vigência (`precos-routes.js:116-121`); preço em cache **vence**. Cachear para exibir, revalidar ao enviar |
| Estoque | **nunca cachear** | muda a cada venda de qualquer canal |
| Rascunho | fila local, envio quando houver rede | §18.3 |

### 18.3 Pedido duplicado — o problema central

Cenário que **acontece**, com ou sem offline: o app envia, o servidor grava, a
resposta se perde na rede. O app não sabe se nasceu. Se reenviar, nascem dois
pedidos; se não reenviar, o vendedor perde a venda.

Hoje **não há proteção nenhuma**: não existe idempotency key, nonce nem
`clientRequestId` em endpoint algum (Caixa 2 §10, risco 11).

**Proposta: `clientRequestId` (UUID v4 gerado pelo app).**

```
POST /api/pedidos  (ou /api/pedidos/completo)
Header: Idempotency-Key: 6f1c...  (ou campo clientRequestId no corpo)

servidor:
  SELECT id FROM pedidos WHERE clientRequestId = ?
    achou  → devolve o MESMO pedido, 200 (não cria outro)
    não    → cria normalmente, gravando clientRequestId
```

Requisitos: coluna `clientRequestId TEXT` em `pedidos` com **índice UNIQUE
parcial** (`WHERE clientRequestId IS NOT NULL`) — o padrão já usado neste
repositório em `vendas_perdidas` (`precos-routes.js:98-99`). O UUID é gerado **uma
vez por pedido** no app e reusado em todas as tentativas do mesmo pedido.

**Isso vale a pena mesmo sem offline**, porque rede móvel instável produz o mesmo
cenário. **Recomendo incluir junto do endpoint agregador (§8.3)**, não antes.

---

## 19. SEGURANÇA — riscos, gravidade, mitigação, quando

| # | Risco | Gravidade | Mitigação | Quando corrigir |
|---|---|:--:|---|---|
| 1 | **Alteração de preço** — backend grava o que o cliente manda (`pedidos-routes.js:361,719,744`) | **CRÍTICO** | Validar server-side com `resolverPreco` + piso `precoMinimoVenda` + permissão de desconto + `audit_log` (§5). Ligar por tenant | **Antes do 2º cliente.** Piloto pode rodar sem, com acompanhamento dos preços |
| 2 | **API Key no app** | **CRÍTICO** *(se escolhida)* | **Não usar.** Sessão (§2). Risco eliminado por decisão de arquitetura | **Já decidido** |
| 3 | **`vendedorId` adulterado** — corpo vence sessão (`pedidos-routes.js:348`) | **ALTO** | App não envia (§4). Backend ignora de quem não pode delegar, nos 4 pontos de §6.2 | **Antes da produção** |
| 4 | **Brute force no login** — `X-Forwarded-For` controlável (`auth-routes.js:51-54`) | **ALTO** | `req.ip` + limite por conta (§13) | **Antes do 2º cliente** |
| 5 | **Sessão roubada** | **ALTO** | TLS + `secure` já garantem trânsito (`auth-bootstrap.js:66`). Falta: encerrar sessão por dispositivo. Mitigação hoje: `users.ativo=0` | **Pós-MVP** |
| 6 | **Dispositivo perdido** | **ALTO** | Hoje: desativar usuário (`auth.js:311-317`) — derruba tudo dele. App: PIN/biometria. Depois: sessões por dispositivo | **PIN no MVP** · sessões por dispositivo pós-MVP |
| 7 | **Sem "meus pedidos"** — app baixaria os pedidos da empresa toda | **ALTO** | `meus=1` + paginação (§11) | **Antes do MVP** |
| 8 | **Falta de auditoria** | **ALTO** *(só com API Key)* | Com sessão, `logAction` grava (`audit-log.js:19`). Faltaria auditar criação de pedido, que hoje não é logada (Caixa 1 §1.3) | Auditar criação: **antes da produção** |
| 9 | **Enumeração de IDs** — `/api/pessoas/:id` etc. sem titularidade | **MÉDIO** | Entre tenants é impossível (Caixa 2 §4.8). Dentro do tenant: rate limit por sessão + monitorar volume | **Pós-MVP** |
| 10 | **Tenant incorreto** | **BAIXO** | Estrutural (Caixa 2 §4.8). App: sufixo `.liciteagora.app` fixo no binário (§3.3); jar de cookie por empresa (§2.7) | **Coberto no desenho** |
| 11 | **Pedido duplicado** | **MÉDIO** | `clientRequestId` + UNIQUE parcial (§18.3). Paliativo no MVP: botão "Enviar" trava após o toque; em timeout, o app **consulta** antes de reenviar | **Paliativo no MVP** · definitivo com o agregador |
| 12 | **Estoque concorrente** | **BAIXO** | Já resolvido: processo único + `better-sqlite3` síncrono + transação no `confirmar` → o segundo recebe 409 (§10.3) | **Nada a fazer.** Reavaliar **se** houver cluster |
| 13 | **CFOP ausente** | **MÉDIO** | App usa `POST /:id/itens` (calcula CFOP) e nunca manda `itens[]` no POST (§9) | **Coberto pela regra do app** |
| 14 | **Excesso de permissões** — RBAC fail-open; vendedor sem perfil vê tudo (`perfis-acesso.js:104`) | **MÉDIO** | Cadastrar perfil de vendedor no tenant **antes** de instalar o app. É configuração, não código | **Antes do MVP**, por tenant |
| 15 | **Liberar estoque demais** | **MÉDIO** | `POST /api/produtos/disponibilidade` em vez de abrir `/api/estoque` (§12) | **Antes do MVP** |
| 16 | **Sem rate limit fora do login** | **MÉDIO** | Teto por sessão nos endpoints de busca | **Pós-MVP** |
| 17 | **Sem recuperação de senha** | **ALTO** *(operacional)* | Hoje: admin reseta. Vira problema com dezenas de vendedores | **Antes do 3º cliente** |

---

## 20. ORDEM DE IMPLEMENTAÇÃO

### FASE 0 — Backend obrigatório *(bloqueia o MVP)*

**Objetivo:** o app poder existir sem vazar dados nem mostrar 403.

| Mudança | Onde | Tamanho |
|---|---|---|
| `meus=1` + `limit`/`offset` em `GET /api/pedidos` | `pedidos-routes.js:182-232` | pequeno |
| `POST /api/produtos/disponibilidade` (reexpõe `reservas-routes.js:641`) | rota nova, lógica existente | pequeno |
| `ehVendedor` no `SELECT` de `req.user` | `auth.js:257` | 1 palavra |
| Cadastrar perfil de vendedor no tenant do piloto | `perfis_acesso` (cadastro) | configuração |

**Riscos:** `meus=1` mal aplicado quebra a listagem da tela web — testar os
filtros existentes juntos. Incluir `ehVendedor` em `req.user` toca o caminho de
autenticação de **todos** os requests: revisar com cuidado, mesmo sendo trivial.

**Critério de conclusão:** com um usuário de perfil comercial restrito,
`curl` autenticado devolve (a) só os pedidos dele em `?meus=1`, (b) 200 em
`/api/produtos/disponibilidade`, (c) `ehVendedor` em `/api/usuarios/me`.

---

### FASE 1 — Endurecimento *(pode correr em paralelo com a Fase 2)*

**Objetivo:** fechar o que o app amplia.

- `vendedorId`: ignorar do corpo para quem não pode delegar, nos 4 pontos (§6.2)
- Rate limit: `req.ip` em vez do header cru (§13.2)
- Auditar criação de pedido (`logAction` no `POST /api/pedidos`)
- Numeração: transação `IMMEDIATE` + `MAX(numero)` (§7.3)

**Riscos:** o `vendedorId` é o mais delicado — a tela web **sempre** envia o
campo. Por isso a regra é *ignorar*, não *rejeitar* (§4.2).

**Critério:** um `PUT` com `vendedorId` de terceiro, feito por usuário sem
permissão, grava o `userId` da sessão; a tela web continua funcionando idêntica
para admin.

---

### FASE 2 — App: login e esqueleto

**Objetivo:** logar, identificar-se, sair — e a PoC de cookie resolvida.

- **PoC de persistência de cookie** (§17.4) — **primeiro de tudo**
- Projeto Expo + TS, navegação, tema
- Telas: empresa → usuário/senha → Home vazia
- Cliente HTTP: `baseUrl` fixo, cookie-jar persistente, interceptor de 401
- Armazenamento seguro (`expo-secure-store`)

**Riscos:** se a PoC falhar, a escolha de tecnologia volta à mesa (§17.4).

**Critério:** login em `1bit.liciteagora.app`, fechar o app, reabrir e **continuar
logado**. Nome do vendedor na Home. Logout limpa tudo.

---

### FASE 3 — Clientes e produtos

- Busca de cliente (`/api/pessoas/autocomplete`) + detalhe
- Criar cliente (`POST /api/pessoas`) com tratamento de 409 e `reativada`
- Busca de produto (`/api/produtos/autocomplete`)
- Preço (`/api/precos/resolver`) com rótulo de fonte
- Disponibilidade (`/api/produtos/disponibilidade`)

**Riscos:** `preco:0` ambíguo (Caixa 2 §7.5) — o app deve destacar, não esconder.
`q` com menos de 2 chars volta vazio, não erro (`financeiro-routes.js:404`) — a UI
precisa dizer "digite ao menos 2 letras".

**Critério:** buscar "TEMPERO", ver preço e disponível corretos, conferidos contra
a tela web para o mesmo cliente.

---

### FASE 4 — Pedido

- Carrinho local persistente
- Envio: `POST /api/pedidos` → `PUT` → `POST /itens` ×N → `POST /confirmar`
- Tratamento de 409 com tela de ajuste (§10.3)
- Sucesso com número + compartilhar PDF

**Riscos:** **a ordem importa** — `PUT` antes dos itens, senão o CFOP sai errado
(§9.3). Falha no meio deixa rascunho órfão: o app precisa saber retomá-lo.

**Critério:** pedido criado no app aparece em COMERCIAL → Pedidos com cliente,
itens, valores, **`vendedorId` correto** e CFOP preenchido — indistinguível de um
pedido feito na tela, exceto pelo canal.

---

### FASE 5 — Meus pedidos

- Lista paginada com `?meus=1`, filtro por status, pull-to-refresh
- Detalhe + PDF + continuar/excluir rascunho

**Critério:** o vendedor vê **apenas** os próprios pedidos — verificado com dois
usuários no mesmo tenant.

---

### FASE 6 — Testes

- Fluxo completo em rede ruim (avião, 3G lento, túnel)
- Sessão expirada no meio do pedido → carrinho preservado (§2.4)
- 409 de estoque com dois aparelhos simultâneos
- Cliente duplicado (409), cliente inativo (reativação)
- **Teste de não-regressão da tela web** — todos os endpoints tocados são compartilhados
- Conferência contábil: pedido do app → entregar → faturar → NF-e autorizada

**Critério:** um pedido do app percorre até NF-e autorizada sem intervenção
manual.

---

### FASE 7 — Piloto

§21.

---

### Fora de fase (quando a demanda aparecer)

Validação de preço server-side (§5) · endpoint agregador + `clientRequestId`
(§8.3, §18.3) · offline · push · código de barras · sessões por dispositivo ·
recuperação de senha.

---

## 21. PILOTO

### 21.1 Desenho

Sua preferência está certa. Concretizando:

| Item | Escolha | Por quê |
|---|---|---|
| Empresa | **`1bit`** | É a sua. Erro sai caro em confiança, não em cliente. Tem catálogo real (132 produtos), 27 pedidos e **1 vendedor com `ehVendedor=1`** (`guilherme`) — Caixa 2 §3.5 |
| Vendedores | 1 no início, 2 na 2ª semana | Um valida o fluxo; dois validam o isolamento de "meus pedidos" |
| Plataforma | **Android, APK direto** | Sem loja, sem revisão, atualização no mesmo dia |
| Pedidos | **reais**, acompanhados diariamente | Pedido de teste não revela o que quebra |
| Saída de emergência | **a tela web, sempre** | O app não substitui nada — é porta adicional. Se travar, o vendedor liga para o escritório e o pedido entra pela web |

### 21.2 Um cuidado que quase passa despercebido

**O `1bit` tem `perfis_acesso` vazio** (Caixa 2 §8.4), e o RBAC é **fail-open**
(`perfis-acesso.js:104`). Ou seja: hoje, `guilherme` é irrestrito — o app
funcionaria mesmo **sem** a mudança de estoque da Fase 0, e o piloto **não
testaria o caminho real** dos outros clientes.

**Portanto: cadastrar um perfil de vendedor restrito no `1bit` antes de começar o
piloto.** Sem isso, o piloto valida um cenário que nenhum cliente com RBAC vai
viver, e o primeiro cliente de verdade descobre os 403 em produção.

O segundo piloto deveria ser o **`josecarloscostafilho`** — 2 vendedores e o
perfil "Comercial Flash" já cadastrado e restrito (Caixa 2 §8.4). É o teste real
de RBAC.

### 21.3 Métricas

**Produto** (o app serve?)
- pedidos pelo app / pedidos totais do vendedor por semana
- tempo médio do "Novo pedido" até "confirmado" — **meta < 90 s** para 3 itens (§16.3)
- pedidos abandonados no rascunho (>24 h sem confirmar)
- retorno ao web: quantas vezes o vendedor desistiu e ligou para o escritório

**Correção** (o app acerta?)
- **pedidos com `vendedorId` NULL: meta = 0** — o teste direto de §4
- itens com `cfop` NULL vindos do app: **meta = 0** — o teste direto de §9
- pedidos do app que falharam ao faturar
- divergência entre o preço mostrado no app e o gravado: **meta = 0**
- 409 de estoque por semana (calibra §10.3)

**Estabilidade**
- taxa de erro 5xx por 100 requisições
- reautenticações não planejadas (expiração antes dos 7 dias)
- crashes por sessão

### 21.4 Critérios para liberar ao 2º cliente

Todos, sem exceção:

1. **4 semanas** com ao menos **30 pedidos reais** pelo app
2. **Zero** pedido com `vendedorId` NULL e **zero** item sem CFOP
3. **Zero** divergência de preço entre app e banco
4. **Zero** pedido do app que precisou de correção manual para faturar
5. Fases 0 **e** 1 concluídas (`vendedorId` server-side + rate limit por `req.ip`)
6. Validação de preço (§5) **decidida** — implementada ou explicitamente adiada, por escrito
7. O vendedor prefere o app ao web para pedido simples — perguntado, não inferido

### 21.5 Critérios de parada

Interromper e voltar ao web se: pedido incorreto chegar ao faturamento; qualquer
vazamento entre vendedores; ou o vendedor lançar pelo web "porque é mais rápido"
duas semanas seguidas.

---

## 22. CONCLUSÃO

### 1. É possível construir o app usando o pedido comercial atual sem duplicar lógica?

**Sim, e essa é a conclusão mais sólida das três caixas.** O caminho completo —
logar → achar cliente → achar produto → preço → criar pedido → itens → confirmar
→ ver pedido — está inteiramente coberto por endpoints existentes (Caixa 2 §9).
Não é necessário **nenhum endpoint novo de escrita**.

O pedido nasce na mesma tabela `pedidos`, com o mesmo `gerarNumero()`, e segue
para COMERCIAL → Pedidos e para o faturamento pelo fluxo normal. Quatro
integrações já fazem exatamente isso hoje em produção (Caixa 1 §7.5).

### 2. Qual tecnologia recomendo?

**React Native + Expo (managed), TypeScript, APK direto no piloto.**

Com uma condição prévia explícita: **PoC de meio dia para persistência de cookie
de sessão em Android e iOS**, antes de qualquer tela. É o único risco técnico da
escolha e o único resultado que poderia mudá-la (§17.4).

Registro honesto do trade-off: **para o MVP isolado, o PWA seria mais rápido** — o
cookie funcionaria sem engenharia nenhuma e a URL já resolveria a descoberta de
empresa. A recomendação muda por causa dos requisitos que você declarou como
futuros — iOS, push, offline e código de barras — que são exatamente os quatro
pontos fracos do PWA, três deles especificamente no iOS.

### 3. Quais mudanças de backend são obrigatórias antes do primeiro pedido feito pelo app?

**Três, todas pequenas, todas na Fase 0:**

1. **`meus=1` + paginação em `GET /api/pedidos`** (`pedidos-routes.js:182-232`) — sem isso, "meus pedidos" baixa os pedidos de toda a empresa para o celular.
2. **`POST /api/produtos/disponibilidade`** — reexpor `reservas-routes.js:641-677` sob o prefixo `/api/produtos`, que o vendedor já alcança. Sem isso, o app mostra 403 onde deveria mostrar "Disponível: 18 UN", em qualquer tenant com perfil cadastrado.
3. **`ehVendedor` no `SELECT` de `req.user`** (`auth.js:257`) — uma palavra; sem ela o app não confirma pela identidade que quem logou é vendedor.

Mais uma que **não é código**: cadastrar o perfil de acesso do vendedor no tenant
antes de instalar o app — inclusive no `1bit`, que hoje está fail-open (§21.2).

Fora disso, três correções são **obrigatórias antes de abrir para o segundo
cliente**, não antes do primeiro pedido: `vendedorId` server-side (§6), rate limit
por `req.ip` (§13) e a decisão sobre validação de preço (§5).

### 4. O que pode ser reutilizado sem alteração?

**19 dos 22 endpoints do MVP** (§14): login, logout, ping de empresa, busca e
detalhe de cliente, condições de pagamento, criar cliente, busca de produto,
preço, tipos de operação, criar pedido, cabeçalho, adicionar/alterar/remover
item, confirmar, detalhe, histórico, PDF e excluir rascunho.

E mais do que endpoints: **toda a lógica de negócio** — numeração, preço, CFOP,
condição de pagamento, reserva, baixa de estoque, faturamento e NF-e. O app não
reimplementa nada disso.

### 5. Qual seria a menor versão realmente utilizável?

**Login → escolher cliente → adicionar produtos com preço e disponível do
servidor → enviar → pedido confirmado no ERP, com o PDF para compartilhar.**

Concretamente: as telas de §15.2 menos frete, menos catálogo avulso, menos
condição de pagamento como passo próprio — mas **com** criar cliente durante a
venda e **com** compartilhar PDF. Esses dois não são luxo: sem o primeiro, o
vendedor volta com a venda não lançada; sem o segundo, ele não tem como fechar a
visita.

O MVP prova uma coisa só, e é a coisa certa: **o vendedor consegue lançar, do
celular e na frente do cliente, um pedido que o escritório fatura sem tocar em
nada.**

---

## O que nesta caixa é HIPÓTESE

1. **Persistência de cookie em RN/Expo** (§2.3, §17.4) — não verificável neste repositório; exige PoC.
2. **Colisão de número por `converter-modo`** (§7.2) — caminho existe no código (`pedidos-routes.js:673`), não reproduzido.
3. **Nenhum consumidor depende de delegar `vendedorId` sem permissão** (§4.2) — não levantei todos os chamadores do `PUT /api/pedidos/:id` fora da tela de pedido.
4. **`ehVendedor = 1 AND role != 'admin'` como critério de "restrito a si mesmo"** (§11.3) — desenho proposto, não regra existente; muda o comportamento da tela web para esses usuários.
5. **Nenhum consumidor atual depende de `/api/estoque/verificar-disponibilidade` com todos os campos** (§12.3) — o caminho antigo permaneceria intacto, então a hipótese é conservadora.
6. **402 para tenant suspenso** (§3.4) — lido em `tenant-middleware.js:189-191`, não testado (não há tenant suspenso para testar sem alterar dados).
7. **Meta de 90 s para 3 itens** (§16.3, §21.3) — alvo de projeto, não medição.
