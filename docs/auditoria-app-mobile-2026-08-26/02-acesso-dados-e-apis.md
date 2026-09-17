# Auditoria — Acesso, dados e APIs (app móvel de vendas)

Data: 2026-08-26 · Caixa 2. Continuação de
[`01-pedido-ponta-a-ponta.md`](01-pedido-ponta-a-ponta.md).

Escopo: autenticação, multi-tenant, vendedor, clientes, produtos, preços, estoque,
matriz de APIs e riscos de segurança do app.

**Somente auditoria.** Nenhum arquivo de código, schema, migration, dependência ou
serviço foi alterado. Nenhum commit. Único arquivo criado: este relatório.

Fontes: código da árvore de trabalho (= produção) em 2026-08-26; os 12
`data/tenants/*/pncp.db` via `PRAGMA`/`SELECT` (leitura pura); `/etc/nginx/nginx.conf`
e `systemctl cat consulta-licitacoes.service` (leitura, apenas para `NODE_ENV` e
montagem de `X-Forwarded-For`). Onde não deu para confirmar, está escrito
**"não confirmado"**.

---

## 1. AUTENTICAÇÃO ATUAL

### 1.1 Peças e onde vivem

| Peça | Arquivo:linha |
|---|---|
| Tela de login | `public/auth/login.html` — `fetch('/api/login')` em `:120`, redireciona para `/` em `:130` |
| Static que serve a tela **antes** da barreira | `base-middleware.js:41` — `express.static(public/auth)` montado na raiz (por isso `/login.html` responde 200 e `/auth/login.html` responde 302) |
| Endpoint de login | `POST /api/login` — `auth-routes.js:64-106` |
| Endpoint de logout | `POST /api/logout` — `auth-routes.js:109-118` |
| Troca de senha (2 caminhos) | `POST /api/change-password` — `auth-routes.js:132-143`; `PUT /api/usuarios/me/senha` — `usuarios-routes.js:49-71` |
| Middleware de sessão | `auth-bootstrap.js:56-70` (`express-session`) |
| Store de sessão | `createSessionStore` — `auth.js:28-109` (SQLite, tabela `sessions` do tenant) |
| Barreira de autenticação | `requireAuth` — `auth.js:255-331`, instalada em `auth-bootstrap.js:76` |
| Gate RBAC (perfil) | `criarGateAcesso` — `perfis-acesso.js:180-207`, instalado em `auth-bootstrap.js:132` |
| Identidade do logado | `GET /api/usuarios/me` — `usuarios-routes.js:43-46` |

Verificado ao vivo (GET, sem autenticar):
`/login.html` → **200**, `/auth/login.html` → **302**.

### 1.2 Tabela de usuários e campos usados

`users` (schema real do `1bit`, `PRAGMA table_info`):

| Coluna | Tipo | NOT NULL | Default | Usada no login? |
|---|---|---|---|---|
| `id` | INTEGER | — | PK | sim (vira `req.session.userId`) |
| `username` | TEXT | **sim** | — (UNIQUE) | sim (`auth-routes.js:77`) |
| `passwordHash` | TEXT | **sim** | — | sim (`:78`) |
| `createdAt` | TEXT | não | CURRENT_TIMESTAMP | não |
| `nome` | TEXT | não | — | devolvido na resposta (`:104`) |
| `email` | TEXT | não | — | não |
| `role` | TEXT | **sim** | `'admin'` | sim — RBAC (`perfis-acesso.js:104`) |
| `ativo` | INTEGER | **sim** | `1` | sim (`:80` e `auth.js:313`) |
| `ultimoLogin` | TEXT | não | — | escrito em `auth-routes.js:95` |
| `especialidade`, `valorHora`, `whatsappTecnico` | — | não | — | não |
| `comissaoPercentual` | REAL | não | — | não (usada na apuração) |
| **`ehVendedor`** | INTEGER | não | `0` | **não** — ver §3 |
| `vendedorTipo` | TEXT | não | — | não |
| `cpfCnpj` | TEXT | não | — | não |
| `metaMensal` | REAL | não | — | não |
| `telefoneVendedor` | TEXT | não | — | não |
| `estabelecimentoId` | INTEGER | não | — | sim — escopo de filial (`estabelecimentos-routes.js:101-103`) |
| `tema`, `menuModo` | TEXT | não | — | preferências de UI |

### 1.3 Hash de senha

`bcryptjs`. Comparação em `auth-routes.js:78` (`bcrypt.compareSync`); geração com
**cost 10** em `auth-routes.js:140`, `usuarios-routes.js:64` e `:156`, e
`control-plane-routes.js:565`. Não há pepper nem `argon2`.

Política de senha: `PUT /api/usuarios/me/senha` valida por
`regras.avaliarSenha()` (`usuarios-routes.js:61`); `POST /api/change-password`
exige apenas **8 caracteres** (`auth-routes.js:135`). São duas regras diferentes
para a mesma operação.

### 1.4 Sessão e cookie

`auth-bootstrap.js:56-70`:

```js
app.use(session({
  store: createSessionStore(session, db, controlDb),
  secret: sessionSecret,           // do control.db, global
  name: 'liciteagora.sid',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7*24*60*60*1000, httpOnly: true, sameSite: 'lax', secure: isProd },
}));
```

- **Nome do cookie:** `liciteagora.sid`.
- **`httpOnly: true`** — inacessível a JS. Para um app nativo isso é irrelevante (o cookie fica no cookie-jar do cliente HTTP), mas impede leitura por WebView script.
- **`secure`**: `NODE_ENV === 'production'`. Confirmado na unit instalada: `Environment=NODE_ENV=production` → **o cookie só trafega em HTTPS**.
- **`sameSite: 'lax'`** — não protege chamada de API cross-site com `POST` de formulário? Protege: `lax` não envia cookie em `POST` cross-site. Mas **não há token CSRF** em nenhum lugar do código (grep por `csrf` não retorna nada nos `.js` da raiz).
- **Sem `domain`** — cookie por subdomínio, deliberadamente (comentário em `auth-bootstrap.js:16-20`). É a peça que isola tenants no mesmo navegador.
- **Expiração: 7 dias.** O store grava `expired = Date.now() + maxAge` no `set` (`auth.js:90-92`), e o `get` filtra `expired > ?` (`auth.js:82`). **Não há `touch` implementado** no `SqliteSessionStore` (`auth.js:80-107` só tem `get`/`set`/`destroy`) e não há `rolling: true`. Consequência: a sessão **não é renovada por uso** — ela morre 7 dias após o último `set`, que na prática é o login. Um app que fique 7 dias sem relogar perde o acesso.
- **Regeneração de SID no login** (`auth-routes.js:100`) — anti session-fixation.
- **Limpeza**: `DELETE FROM sessions WHERE expired < ?` a cada 15 min (`auth.js:73-75`).

### 1.5 Rate limit do login

`auth-routes.js:35-49, 64-94`: 5 falhas em 15 min por IP → HTTP 429 por 15 min.
Estado em memória (`Map`), portanto **por processo** — reinício do serviço zera.

**Como o IP é obtido** (`auth-routes.js:51-54`):

```js
const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
return fwd || req.ip || req.socket?.remoteAddress || 'unknown';
```

E o nginx usa `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
(`/etc/nginx/nginx.conf:54`), que **anexa** o IP real ao header que o cliente
mandou. Logo, se o cliente enviar `X-Forwarded-For: 9.9.9.9`, o header chega como
`9.9.9.9, <ip real>` e a função pega **`9.9.9.9`** — valor sob controle do
atacante. Variando esse header a cada tentativa, **o rate limit de login é
contornável**. Isso está confirmado por leitura do código + da config; não foi
testado por execução (e não será — é auditoria).

### 1.6 Auditoria de login

Falhas gravam em `audit_log` com `action='login_fail'` (`auth-routes.js:88-89`).
**Sucessos não são auditados** — só atualizam `users.ultimoLogin`.

### 1.7 Logout

`POST /api/logout` (`auth-routes.js:109-118`): `req.session.destroy()` +
`res.clearCookie('liciteagora.sid')`. Público (registrado antes da barreira),
idempotente, sem CSRF. **Serve ao app sem adaptação.**

### 1.8 Recuperação de senha

**Não existe para o usuário do tenant.** Grep por `esqueci`, `recuperar-senha`,
`reset-password`, `forgot` em todo o repositório retorna apenas
`control-plane-routes.js:610` — `POST /api/admin/tenants/:slug/reset-password`,
que é do **super-admin** (painel `admin.liciteagora.app`), fora do requireAuth do
tenant.

Ou seja: vendedor que esquece a senha depende de um administrador. Para um app
instalado em dezenas de celulares, isso vira suporte manual.

### 1.9 Bloqueio / inativação

- `users.ativo = 0`: o login recusa (`auth-routes.js:80`) **e** o `requireAuth` recusa a cada requisição, destruindo a sessão (`auth.js:311-317`). **Desativar um usuário derruba a sessão dele imediatamente** — propriedade valiosa para "vendedor demitido / celular perdido", desde que o app use sessão.
- `DELETE /api/usuarios/:id` (`usuarios-routes.js:269`) é soft-delete (admin only).
- Não há bloqueio por tentativas na conta (só por IP), nem expiração de senha, nem 2FA.

### 1.10 Como o tenant do usuário é determinado

**Pelo Host da requisição — não pelo usuário.** Detalhe em §4. Em resumo:
`tenant-middleware.js:174-207` resolve o subdomínio → `manager.getDb(slug)` →
todo `db.prepare()` do request cai no `pncp.db` daquele tenant. O login roda
`SELECT * FROM users WHERE username = ?` **no banco já escolhido pelo Host**
(`auth-routes.js:77`). O usuário não "pertence" a um tenant por um campo: ele
existe fisicamente dentro do arquivo de um tenant.

### 1.11 Veredito: dá para reutilizar no app?

**Dá, e é a melhor opção disponível hoje** — a autenticação é por sessão com
cookie, mas nada nela é específico de navegador:

| Requisito | Situação |
|---|---|
| Endpoint de login com JSON | `POST /api/login {username, password}` → JSON. ✅ |
| Cookie gerenciável por cliente HTTP nativo | Sim — qualquer cliente com cookie-jar (`OkHttp`/`URLSession`/`fetch` com `credentials`). ✅ |
| Sem CSRF token a replicar | Correto, não existe. ✅ |
| Sem redirect HTML no meio | Em `/api/*`, o não-autenticado recebe **401 JSON** (`auth.js:326-328`); só rota não-`/api/` redireciona para `/login.html`. ✅ |
| Identidade do logado | `GET /api/usuarios/me`. ✅ (com uma lacuna — §3.6) |
| Revogação imediata | `users.ativo = 0` derruba na hora. ✅ |
| Sessão longa | 7 dias **sem renovação por uso** — o app precisa tratar 401 e relogar. ⚠️ |
| Recuperação de senha | Não existe. ⚠️ |
| Rate limit confiável | Contornável via `X-Forwarded-For`. ⚠️ |

**Ela não foi desenhada só para navegador** — foi desenhada para sessão. O que
falta para um app é operacional (renovação, recuperação de senha), não estrutural.

---

## 2. X-API-KEY — auditoria integral

### 2.1 Onde é criada

Três caminhos, todos gerando `crypto.randomBytes(32).toString('hex')` — 64 chars hex:

| Momento | Arquivo:linha |
|---|---|
| Provisionamento do tenant (control plane) | `control-plane-routes.js:569-575` — e a chave é **devolvida em texto puro** na resposta de criação do tenant (`:588`) e exibida na tela do super-admin (`public/auth/admin/index.html:1175`) |
| Sob demanda, ao abrir a tela de Conexões | `admin-routes.js:118-128` (`GET /api/config/api-key`) — cria se não existir |
| Compat single-tenant | `getApiKey(db)` — `auth.js:234-245` |

### 2.2 Onde é armazenada

Linha da tabela `config` do **banco do tenant**: `chave = 'api_key'`,
`valor` = a chave **em texto puro** (sem hash, sem cifra).
Confirmado nos 12 tenants: **todos têm `config.api_key`**; no `1bit` o valor tem
64 caracteres e `dataAtualizacao = 2026-03-06` — ou seja, **nunca rotacionada
desde março**.

### 2.3 Como é validada

`auth.js:297-307`:

```js
const headerKey = req.headers['x-api-key'];
if (headerKey && req.tenant) {
  const row = stmt(req.tenantDb, SQL_GET_API_KEY).get();   // SELECT valor FROM config WHERE chave='api_key'
  if (row && row.valor === headerKey) return next();
}
if (headerKey && apiKey && headerKey === apiKey) return next();   // compat single-tenant
```

Comparação de string simples (`===`), sem `timingSafeEqual`. O tenant já foi
resolvido pelo Host antes disso, então a chave é comparada **contra a chave do
tenant do subdomínio** — a chave do tenant A não vale em `b.liciteagora.app`.

### 2.4 A que entidade pertence — e o que ela identifica

**Pertence ao TENANT (a empresa). Não identifica usuário nenhum.**

Consequência estrutural, e é o ponto central desta seção: quando a chave é aceita,
o `requireAuth` chama `next()` **sem popular `req.user`**. Isso produz, em cascata:

| Efeito | Onde |
|---|---|
| RBAC de perfil desligado | `perfis-acesso.js:185` — `if (!req.user) return next(); // X-Api-Key: atua como sistema` |
| RBAC de estabelecimento desligado | `estabelecimentos-routes.js:101-103` — `escopoUsuario` devolve `null` sem `req.user` → `escopoSql`/`guardEscopo` não filtram |
| `requireRole([...])` desligado | `auth.js:337` — `if (!req.user) return next(); // X-Api-Key bypass` |
| **Auditoria desligada** | `audit-log.js:19` — `if (!req || !req.user) return;` — comentário literal: *"Não loga quando req.user não existe (ex.: chamadas via X-Api-Key da extensão)"* |
| `vendedorId` do pedido vira NULL | `pedidos-routes.js:348` — `req.session?.userId` é `undefined` |

Ou seja: **X-Api-Key = root do tenant, silencioso.**

### 2.5 Permissões

Nenhuma granularidade. Não há escopos, nem lista de rotas permitidas, nem
read-only. A chave abre **todo `/api/*` do tenant**, incluindo
`POST /api/usuarios` (criar usuário admin), `DELETE /api/pessoas/:id`,
`POST /api/pedidos/:id/faturar`, `POST /api/faturas/:id/emitir-nfe`.

### 2.6 Expiração

**Não existe.** Não há coluna de validade, nem TTL, nem verificação de idade.
A chave do `1bit` está válida desde 2026-03-06.

### 2.7 Revogação e rotação

`POST /api/config/api-key/rotate` (`admin-routes.js:131-140`) — gera uma nova e
sobrescreve. Consequências:

- **É chave única por tenant**: rotacionar invalida *todos* os consumidores de uma vez (Electron, integrações, e o app, se ele a usasse). Não dá para revogar um dispositivo.
- Não há revogação seletiva, nem lista de chaves, nem histórico. `config.api_key` é uma linha só.
- A rotação exige a tela `/operacional/conexoes.html` (`public/operacional/conexoes.html:581`).

### 2.8 Logs

- **Uso da chave não é logado** em lugar nenhum (nem sucesso, nem falha).
- **Ações feitas com a chave não entram no `audit_log`** (`audit-log.js:19`).
- Não há contador de uso, último uso, nem IP de origem.

Resultado prático: com X-Api-Key, `audit_log` mostra o pedido nascendo do nada,
sem autor.

### 2.9 Endpoints que aceitam X-Api-Key

**Todos os `/api/*` protegidos pela barreira** — a validação está no
`requireAuth`, que é global (`auth-bootstrap.js:76`). Não há allow-list.

Além disso, `registrarRotasElectron(app, db, { apiKey })` (`pre-auth-routes.js:82`)
registra `/api/electron/*` **antes** da barreira, com auth própria por
X-Api-Key — e parte delas é bypass explícito (`auth.js:265-278`).

O consumidor real hoje é o cliente Electron do Comprasnet (comentário em
`pre-auth-routes.js:13-15` e `admin-routes.js:112`).

### 2.10 Veredito: X-Api-Key serve para autenticar o app do vendedor?

**Não. É inadequada, e o motivo não é teórico.**

1. **A chave seria a mesma para todos os vendedores da empresa.** Ela identifica a empresa, não a pessoa. Não há como preencher `vendedorId` a partir dela, nem filtrar "meus pedidos", nem auditar quem fez o quê.
2. **Ela é root.** Um app com essa chave pode criar usuário admin, apagar cliente, emitir NF-e. Não existe modo restrito.
3. **Extração é o cenário esperado, não o excepcional.** Chave embutida em APK/IPA é recuperável: `apktool`/`strings` no binário, `frida` em runtime, ou simplesmente proxy TLS com certificado do usuário no próprio aparelho (o dono do celular tem root sobre o próprio dispositivo). Não existe forma de esconder um segredo estático num app distribuído — o app precisa da chave em claro para usá-la, logo quem controla o aparelho a obtém. Ofuscação e keystore do SO elevam o custo, não o transformam em impossível.
4. **O estrago da extração é total e não isolável.** Chave vazada de um aparelho = acesso root à empresa inteira, e a única resposta possível é rotacionar — o que derruba todos os outros vendedores e o Electron junto.
5. **Não há rastro.** Sem log de uso e sem `audit_log`, o vazamento não é detectável nem reconstruível depois.

**Conclusão:** não colocar API Key fixa no app. Se em algum momento o app precisar
de uma credencial de máquina (ex.: chamada de sistema, não de vendedor), ela
teria de ser por-dispositivo, revogável individualmente e ligada a um usuário —
nada disso existe hoje.

---

## 3. USUÁRIO ↔ VENDEDOR

### 3.1 Tabela de usuários

`users` — §1.2.

### 3.2 Tabela de vendedores

**Não existe.** Não há tabela `vendedores`. Confirmado por varredura do
`sqlite_master` dos tenants e por grep no repositório.

Vendedor é um **atributo booleano do usuário**: `users.ehVendedor` (INTEGER,
default 0), acompanhado de `vendedorTipo` (`'interno' | 'externo' |
'representante'`, `usuarios-routes.js:37`), `cpfCnpj`, `comissaoPercentual`,
`metaMensal`, `telefoneVendedor`.

### 3.3 Relacionamento — quem aponta para `users.id`

| Tabela.coluna | FK declarada? | Onde |
|---|---|---|
| `pedidos.vendedorId` | **não** (veio de `ALTER TABLE`) | `comissoes-routes.js:36` |
| `comissoes_regras.vendedorId` | **sim** → `users(id)` | `comissoes-routes.js:62` |
| `comissoes_apuracao.vendedorId` | **sim** → `users(id)`, NOT NULL | `comissoes-routes.js:83` |
| `metas_vendas.vendedorUserId` | não declarada; **NOT NULL** | `PRAGMA table_info(metas_vendas)` |
| `vendas_perdidas.vendedorUserId` | não | `precos-routes.js:94` |
| `pessoas.vendedorId` | não | `db-schema.js:2046` — vendedor **da carteira do cliente** |

**O identificador do vendedor é, em todo o sistema, `users.id`.** Não há um "código
de vendedor" separado.

### 3.4 Todo vendedor precisa ter usuário?

**Sim, necessariamente** — não há outro lugar onde um vendedor possa existir.
`metas_vendas.vendedorUserId` é NOT NULL e `comissoes_apuracao.vendedorId` é NOT
NULL com FK para `users`. Um representante externo que venda pelo app precisa de
uma linha em `users` com `ehVendedor = 1`.

### 3.5 Um usuário pode representar um vendedor?

É exatamente o modelo: o usuário **é** o vendedor quando `ehVendedor = 1`. Não há
mapeamento N:1 nem usuário compartilhado por vários vendedores.

Estado real hoje (consulta aos 12 tenants):

| Tenant | Usuários | Com `ehVendedor=1` | Roles |
|---|---:|---:|---|
| `1bit` | 2 | 1 (`guilherme`) | `admin`, `comercial` |
| `josecarloscostafilho` | 3 | 2 (`william`, `caio`) | `admin`, `comercial`×2 |
| outros 10 | 1 cada | 0 | `admin` |

**Três vendedores cadastrados no sistema inteiro.** O app começa praticamente do zero.

### 3.6 Como `vendedorId` é determinado hoje

**Na tela**: `public/comercial/pedido.html:1365` carrega
`GET /api/usuarios?vendedor=1` num `<select>`; `coletarBody()`
(`pedido.html:1515`) envia `vendedorId` no `PUT`.

**No backend, na criação** (`pedidos-routes.js:348`):

```js
const vendedor = vendedorId != null ? (Number(vendedorId) || null) : (req.session?.userId || null);
```

Três fatos que decorrem disso:

1. **O corpo vence a sessão.** Se o cliente HTTP mandar `vendedorId`, ele é usado — sem checagem.
2. **Não há validação alguma** de que o `vendedorId` enviado existe em `users`, está ativo, ou tem `ehVendedor = 1`. `Number(x) || null` aceita qualquer inteiro. Não há FK em `pedidos.vendedorId` para barrar.
3. Qualquer usuário logado pode atribuir um pedido a outro vendedor, inclusive em massa (`POST /api/pedidos/acao-massa` com `acao: 'vendedor'`, `pedidos-routes.js:308-311`).

**Lacuna que atinge o app diretamente:** `GET /api/usuarios/me`
(`usuarios-routes.js:43-46`) devolve `req.user`, que vem de
`SQL_GET_USER` em `auth.js:257`:

```sql
SELECT id, username, nome, email, role, ativo, estabelecimentoId FROM users WHERE id = ?
```

**`ehVendedor` não está aí.** O app não consegue perguntar "sou vendedor?" pelo
endpoint de identidade. `GET /api/usuarios/:id` traz o campo
(`usuarios-routes.js:33-34`), mas é `requireRole(['admin'])`.
`GET /api/usuarios?vendedor=1` lista todos os vendedores e é acessível a
qualquer logado (`usuarios-routes.js:97-101`) — o app poderia procurar o próprio
`id` nessa lista, mas é um contorno, não uma resposta.

### 3.7 Metas

`metas_vendas` (`vendedorUserId` NN, `competencia`, `valorMeta`,
`valorMetaMargem`, `metaPedidos`) e `metas_equipe`. API em
`planejamento-routes.js`: `POST /api/metas:511`, `POST /api/metas/equipe:566`,
`GET /api/metas/atingimento:594`, `GET /api/metas/historico:778`.
O atingimento soma `pedidos.valorTotal` agrupado por `pedidos.vendedorId`
(`planejamento-routes.js:612-635`), com `WHERE vendedorId IS NOT NULL`.

**Pedido com `vendedorId` NULL simplesmente não existe para as metas.**

### 3.8 Comissões

`comissoes_regras` e `comissoes_apuracao`. A apuração
(`POST /api/comissoes/apurar`, `comissoes-routes.js:191-197`) percorre pedidos e
agrupa por `ped.vendedorId` (`:224-226`). Mesma consequência: sem `vendedorId`,
sem comissão. Escopo por estabelecimento aplicado em `comissoes-routes.js:110`.

### 3.9 Permissões ligadas a vendedor

**Nenhuma.** `ehVendedor` só controla (a) a listagem
`GET /api/usuarios?vendedor=1` e (b) quem aparece nos selects. Não existe um
perfil "vendedor" que restrinja dados. O RBAC é por página (`perfis_acesso`),
não por titularidade de registro.

### 3.10 Filtro de pedidos por vendedor

**Não existe.** `GET /api/pedidos` (`pedidos-routes.js:184`) aceita
`status, tipo, modoDocumento, clienteId, statusPagamento, busca` — **não aceita
`vendedorId`**. E não tem paginação nem `LIMIT` (`:226-227`): devolve a tabela
inteira, com joins de fatura, conta a receber e tipo de operação.

Para "meus pedidos" no app, hoje só há duas saídas ruins: baixar tudo e filtrar
no celular (vaza os pedidos dos colegas pela rede), ou criar o filtro.

### 3.11 Qual identificador o backend deve obter da autenticação

**`req.user.id`** — o `users.id`, que é o mesmo valor que `req.session.userId`.

Com login por sessão, o backend **já tem** essa informação em toda requisição, e
`pedidos-routes.js:348` já a usa como default. Ou seja: **se o app logar com
usuário e senha, o `vendedorId` correto é preenchido sozinho, sem o app enviar
nada** — desde que o app *não* envie `vendedorId` no corpo (porque o corpo vence).

O requisito "o app não deve confiar em `vendedorId` arbitrário enviado pelo
celular" é atendível hoje **por omissão**: basta o app não mandar o campo. Tornar
isso uma garantia (ignorar/validar o `vendedorId` do corpo quando há sessão) é
mudança de backend — fora do escopo desta etapa, registrada na matriz §9.

---

## 4. MULTI-TENANT

### 4.1 Como o tenant é identificado

**Exclusivamente pelo header `Host`.** `tenant-manager.js:217-235`:

```js
function resolveFromHost(host) {
  const hostname = host.split(':')[0].toLowerCase();
  if (hostname === 'liciteagora.app') return { kind: 'apex' };
  if (!hostname.endsWith('.liciteagora.app')) return { kind: 'unknown' };
  const sub = hostname.slice(0, -suffix.length);
  if (!sub || sub.includes('.')) return { kind: 'unknown' };
  if (sub === 'www') return { kind: 'apex' };
  if (sub === 'admin') return { kind: 'admin' };
  if (RESERVED_SLUGS.has(sub)) return { kind: 'reserved', slug: sub };
  return { kind: 'tenant', slug: sub };
}
```

`RESERVED_SLUGS = {www, admin, api, static, cdn}` (`tenant-manager.js:35`).

Não há `?tenant=`, header de tenant, nem tenant no corpo ou no JWT. **O
subdomínio é a única fonte.**

### 4.2 Como o banco correto é escolhido

`tenant-middleware.js:183-201`:

1. `manager.getTenantBySlug(slug)` — se não achar, 404 (`:186-188`).
2. Se `status` é `SUSPENDED`/`CANCELLED` → 402 (`:189-191`).
3. `manager.getDb(slug)` (`tenant-manager.js:482-526`) — pool lazy `Map<slug, Database>`; abre `data/tenants/<slug>/pncp.db`, aplica `initSchema` no primeiro open, liga `foreign_keys = ON` (`:511`) e faz ATTACH do catálogo.
4. `req.tenant` e `req.tenantDb` gravados; a chain segue dentro de `tenantStorage.run({kind:'tenant', tenant, db}, next)`.

O `db` que todas as ~50 rotas recebem no boot é um **Proxy** (`createDbProxy`,
`tenant-middleware.js:87-123`) que resolve, a cada acesso, para o `db` do
`AsyncLocalStorage` da requisição em curso. Um handler não tem como escolher outro
banco: ele nem enxerga o nome do arquivo.

### 4.3 Middleware responsável

`createTenantMiddleware` (`tenant-middleware.js:143-208`), montado em
`server.js:54` (`app.use(ctx.middleware)`) — **antes** de qualquer rota de
negócio e antes da barreira de autenticação.

### 4.4 Existe banco central de autenticação?

**Não.** `data/control.db` guarda metadados de tenant (`tenants`,
`tenant_billing`, `super_admins`, auditoria — `tenant-manager.js:39-55`) e o
`session_secret` global (`auth-bootstrap.js:47-48`). **Usuários e senhas vivem
dentro do `pncp.db` de cada tenant.** Não há diretório único de identidade.

A única coisa global é o `session_secret` — necessário para o Express validar a
assinatura do cookie independentemente do subdomínio.

### 4.5 Cada empresa tem banco próprio?

Sim: um arquivo SQLite por tenant em `data/tenants/<slug>/pncp.db`. 12 hoje.
O catálogo público de licitações (PostgreSQL `liciteagora_catalog`) é
compartilhado, mas contém **apenas dados públicos do PNCP** (licitações, itens,
resultados, `orgaos_lookup`) — nenhum dado comercial de tenant.

### 4.6 Como usuários são associados ao tenant

Por **localização física**: a linha em `users` existe dentro do arquivo daquele
tenant. Não há coluna `tenant_id` em `users`. O mesmo `username` pode existir em
dois tenants como duas pessoas diferentes, sem conflito.

### 4.7 Como X-Api-Key determina o tenant

**Ela não determina.** O tenant já foi resolvido pelo Host antes do
`requireAuth`; a chave é apenas comparada contra `config.api_key` **daquele**
tenant (`auth.js:299-303`). Chave do tenant A enviada para `b.liciteagora.app`
falha, e cai no caminho de sessão.

### 4.8 O cenário exigido: vendedor da Empresa A não pode ver dados da Empresa B

**Alterando IDs nas requisições: impossível.** A razão é arquitetural, não uma
verificação que alguém possa esquecer de fazer:

Um `GET /api/pedidos/999` em `a.liciteagora.app` executa
`SELECT * FROM pedidos WHERE id = 999` contra o **arquivo do tenant A**. Se o
pedido 999 é da Empresa B, ele está em outro arquivo, que essa conexão não abriu
e não tem como abrir. O resultado é 404 — não porque alguém comparou tenants, mas
porque a linha não existe naquele banco. Vale para todo ID de todo módulo:
`clienteId`, `produtoId`, `vendedorId`, `faturaId`.

**Trocando o Host: barrado pela autenticação, não pelo isolamento.** Se o
vendedor de A apontar o app para `b.liciteagora.app`, o middleware abre o banco de
B — e aí o cookie de sessão dele não vale, porque a tabela `sessions` de B não tem
aquele SID (o store grava no banco do tenant, `auth.js:62-68`). Ele recebe 401.
Para entrar em B ele precisaria de usuário e senha válidos **em B**.

**O que sustenta a garantia — e o que a quebraria:**

| Ponto | Estado |
|---|---|
| Banco por arquivo, escolhido antes das rotas | `tenant-middleware.js:192-201` ✅ |
| Sessão gravada no banco do tenant | `auth.js:62-68` ✅ |
| Cookie sem `domain` (por subdomínio) | `auth-bootstrap.js:62-69` ✅ |
| SID regenerado no login | `auth-routes.js:100` ✅ |
| API key comparada contra a chave do tenant do Host | `auth.js:299-303` ✅ |
| Host desconhecido → 404, não fallback | `tenant-middleware.js:204-206` ✅ |
| **`session_secret` é global** | `auth-bootstrap.js:47` → `getSessionSecret` (`auth.js:208-228`): `crypto.randomBytes(48)` (96 chars hex) gravado em `config.session_secret` do **`control.db`**, criado uma vez e **nunca rotacionado** (o código só gera se ausente — não há caminho de rotação, apesar do comentário em `auth-pipeline.js:12`). Um cookie forjado com esse segredo seria aceito em qualquer tenant; a proteção que resta é o SID não existir na tabela `sessions` do outro tenant. O segredo não é exposto por rota alguma. ⚠️ (risco teórico, dependente de vazamento do `control.db`) |
| Handler que chame o DB fora do contexto | `currentDb()` lança (`tenant-middleware.js:36`) — falha fechada ✅ |
| Callbacks de stream perdem o contexto | Conhecido e tratado: `reentrarContextoTenant` (`tenant-middleware.js:224-233`), usado em upload ⚠️ |

**Para o app, a consequência prática é uma só:** o app precisa fixar a URL base no
subdomínio do tenant (`https://<slug>.liciteagora.app`) e essa URL passa a ser
parte da identidade da conta. Não existe endpoint "descubra meu tenant pelo
usuário" — e não poderia existir sem varrer os 12 bancos.

---

## 5. CLIENTES

Todas as rotas de pessoas vivem em **`financeiro-routes.js`** (não há
`pessoas-routes.js`). Tabela: `pessoas` (cadastro unificado — cliente, fornecedor
e transportador na mesma tabela desde 2026-08-20).

### 5.1 Endpoints

| # | Método | URL | Arquivo:linha | Auth |
|---|---|---|---|---|
| 1 | GET | `/api/pessoas` | `financeiro-routes.js:374-399` | sessão ou X-Api-Key; RBAC: prefixo `/api/pessoas` |
| 2 | GET | `/api/pessoas/autocomplete` | `:401-418` | idem |
| 3 | GET | `/api/pessoas/condicoes-pagamento` | `:424-448` | idem |
| 4 | GET | `/api/pessoas/:id` | `:450-458` | idem |
| 5 | GET | `/api/pessoas/:id/vinculos` | `:632-637` | idem |
| 6 | POST | `/api/pessoas` | `:639-690` | idem |
| 7 | PUT | `/api/pessoas/:id` | `:792` | idem |
| 8 | DELETE | `/api/pessoas/:id` | `:848` | idem |
| 9 | POST | `/api/pessoas/acao-massa` | `:706` | idem |
| 10 | GET/POST/PUT/DELETE | `/api/pessoas/:id/contatos`, `/enderecos`, `/dados-bancarios` | `:912-1060+` | idem |

RBAC (`perfis-api-map.js:154`): `/api/pessoas` é liberado para quem tem, entre
outras, a página **`pedidos`** ou **`pessoas`**. O perfil real "Comercial Flash"
(tenant `josecarloscostafilho`) tem as duas. ✅

### 5.2 Detalhe dos três que o app usaria

**`GET /api/pessoas?q=&ativo=`** (`:374-399`)
- Retorna `SELECT *` — a ficha inteira, ~70 colunas, inclusive `limiteCredito`, `observacoes`, dados de fornecedor e campos LGPD.
- Busca: `LIKE %q%` em `cpfCnpj`, `razaoSocial`, `nomeFantasia` (`:388`).
- Filtro: `ativo` (default `ativo = 1`, `:384`).
- **Sem paginação e sem LIMIT** (`:393`). Ordena por `razaoSocial`.

**`GET /api/pessoas/autocomplete?q=`** (`:401-418`) — **este é o endpoint certo para o app**
- Exige `q` com ≥ 2 caracteres (`:404`), senão devolve lista vazia.
- **LIMIT 10** (`:411`).
- Campos: `id, cpfCnpj, tipo, razaoSocial, nomeFantasia, inscricaoMunicipal, endereco, numero, complemento, bairro, codigoMunicipio, cidade, uf, cep, telefone, email`.
- Só `ativo = 1`.
- **Não retorna `tabelaPrecoId` nem `politicaPrazoId`** — o app precisa de um `GET /api/pessoas/:id` depois, ou de `GET /api/pessoas/condicoes-pagamento?pessoaId=`.

**`GET /api/pessoas/condicoes-pagamento?pessoaId=&onde=vendas`** (`:424-448`)
- Devolve `{ permitidos, prazo, rotulos, politica }` — a whitelist de meios (tPag), o prazo (`[30,60,90]`) e a política inteira. É o que evita o 400 do `PUT /api/pedidos/:id` descrito na Caixa 1 §1.2.

### 5.3 Criação de cliente — validações reais

`POST /api/pessoas` (`financeiro-routes.js:639-690`), em ordem:

1. **`cpfCnpj` e `razaoSocial` obrigatórios** → 400 (`:641-644`). São os únicos dois.
2. `erroDominioPessoa(req.body)` (`:554-568`): valida `condicaoPagamentoPadrao` (formato de prazo), `tipoFrete` ∈ `['CIF','FOB','terceiros','sem_frete']`, `statusHomologacao` ∈ `['nao_avaliado','em_analise','homologado','bloqueado']`, `avaliacao` entre 1 e 5.
3. `cpfLimpo = cpfCnpj.replace(/\D/g,'')` — **só remove não-dígitos. Não há validação de dígito verificador de CPF/CNPJ em nenhum ponto** (grep: não existe validador no fluxo).
4. `tipo` é **derivado do tamanho** por `detectarTipoPessoa(cpfLimpo)` — não vem do corpo.
5. **Duplicidade** (`:653-671`), pela chave `pessoas.cpfCnpj` (`UNIQUE INDEX idx_pessoas_cpfcnpj`):
   - já existe e `ativo = 1` → **409** com a pessoa no corpo (`:670`);
   - já existe e `ativo = 0` → **reativa**, atualiza os campos enviados e devolve `{ success: true, reativada: true }` (`:655-668`).
6. INSERT dinâmico só com os campos presentes em `PESSOAS_CAMPOS` (`:464-500`).
7. `logAction(... 'criar', 'pessoa' ...)` (`:682`) — **não grava se a chamada veio por X-Api-Key**.

### 5.4 Campos mínimos para o app criar cliente durante a venda

**Para o `POST` passar:** `cpfCnpj` + `razaoSocial`. Só isso.

**Para o cliente servir a um pedido que vai virar NF-e** (juntando com a Caixa 1
§3.4 e `nfe-emit-routes.js:520-521`):

| Campo | Por quê |
|---|---|
| `cpfCnpj` | obrigatório no POST; vira o destinatário da NF-e |
| `razaoSocial` | obrigatório no POST; `xNome` da NF-e |
| `endereco`, `numero`, `bairro`, `cidade`, `uf`, `cep`, `codigoMunicipio` | grupo `<enderDest>` da NF-e |
| `telefone` e/ou `email` | contato e envio de cobrança/boleto |
| `inscricaoEstadual` + `indicadorIE` | contribuinte de ICMS; afeta CFOP via `sugerirCFOP` |
| `tabelaPrecoId` | define o preço do cliente (§7) — opcional |
| `politicaPrazoId` | se preenchido, **passa a ser obrigatório** no pedido (`pedidos-routes.js:46-48`) |
| `vendedorId` | carteira do cliente — não é usado para preencher o pedido |

Endereço, telefone e situação ativo/inativo: **nenhum é obrigatório no backend**.
Um cliente criado pelo app só com CPF/CNPJ e nome é aceito, entra no pedido, e
**só falha na emissão da NF-e** — no fim do fluxo, longe do vendedor.

**Ponto de atenção operacional:** o `PUT /api/pedidos/:id` valida a política de
pagamento, mas nada valida o endereço na criação do pedido nem na confirmação.

**`/api/cep` é bloqueado para o perfil comercial** (`perfis-api-map.js:55`:
apenas `estabelecimentos` e `minha-empresa`). Um app que preencha endereço por
CEP receberá **403** para o vendedor com perfil restrito. `/api/cnpj` está
liberado (`:61` inclui `pessoas`, `pedidos` e `produtos`).

---

## 6. PRODUTOS

Arquivo: `produtos-routes.js`. Tabela `produtos` (69 colunas — Caixa 1 §2.6).

### 6.1 Endpoints de leitura

| Método | URL | Arquivo:linha | Paginação | Campos |
|---|---|---|---|---|
| GET | `/api/produtos?q=&ativo=&incluirOpticos=` | `produtos-routes.js:56-91` | **nenhuma** | `p.*` + `fornecedorNome` + **`saldo`** (subconsulta por linha) |
| GET | `/api/produtos/autocomplete?q=&rastreiaLote=&rastreiaSerial=` | `:93-116` | **LIMIT 20** | `id, sku, descricao, unidade, precoVenda, rastreiaLote, rastreiaSerial` |
| GET | `/api/produtos/:id` | `:118-132` | — | `p.*` + `saldo` + `opticaSpecs` |
| GET | `/api/produtos/:id/codigos` | `:296` | — | códigos alternativos (EAN etc.) |
| GET | `/api/produtos/:id/kit` | `:347` | — | componentes do kit |

RBAC (`perfis-api-map.js:161`): `/api/produtos` inclui a página `pedidos` e
`produtos`. O perfil "Comercial Flash" tem ambas. ✅

### 6.2 Cobertura dos campos pedidos

| Pedido | Coluna real | Vem no autocomplete? | Vem no `/api/produtos`? |
|---|---|---|---|
| Código/SKU | `produtos.sku` (NN, UNIQUE) | ✅ | ✅ |
| Descrição | `produtos.descricao` (NN) | ✅ | ✅ |
| Unidade | `produtos.unidade` (default `'UN'`) | ✅ | ✅ |
| Preço | `produtos.precoVenda` (default 0) | ✅ | ✅ |
| **Preço mínimo** | `produtos.precoMinimoVenda` | ❌ | ✅ (via `p.*`) |
| Custo | `produtos.precoCusto`, `markupMinimo`, `markupVenda` | ❌ | ✅ |
| Estoque | calculado — `saldo` | ❌ | ✅ (`saldo`, **sem descontar reserva**) |
| Ativo/inativo | `produtos.ativo` | filtro fixo `ativo = 1` | filtro `?ativo=` |
| Tributação | `ncm`, `cest`, `cfopPadrao`, `origem`, `icmsAliquota`, `csosn`, `cstPIS`, `cstCOFINS`, `cstIBS`, `cstCBS`, `cClassTrib` | ❌ | ✅ |
| CFOP do item | **não vem do produto** — é calculado por `sugerirCFOP` no `POST /api/pedidos/:id/itens` (`pedidos-routes.js:709-717`) | — | — |
| Imagem | `produtos.imagemPath` | ❌ | ✅ |
| Kit | `tipoProduto = 'kit'` + `produto_kit_itens` | ✅ (`tipoProduto` não vem; só via `/api/produtos`) | ✅ |

**Imagem:** servida em `/uploads/produtos/...` por `express.static` registrado
**antes da barreira de autenticação** (`pre-auth-routes.js:53-56`), com
`maxAge: '7d'`. O comentário explica o motivo (o Mercado Livre precisa baixar a
foto). **Para o app isso é conveniente** — carrega a miniatura sem cookie — **e é
uma exposição**: qualquer pessoa com a URL vê a foto do produto de qualquer
tenant. As demais pastas de `uploads` continuam protegidas.

### 6.3 "Digitei TEMPERO e quero achar todos os correspondentes"

**Endpoint: `GET /api/produtos/autocomplete?q=TEMPERO`** (`produtos-routes.js:93-116`).

```sql
SELECT id, sku, descricao, unidade, precoVenda, rastreiaLote, rastreiaSerial
FROM produtos
WHERE ativo = 1 AND (LOWER(sku) LIKE ? OR LOWER(descricao) LIKE ?
  OR EXISTS (SELECT 1 FROM produto_codigos pc
             WHERE pc.produtoId = produtos.id AND pc.ativo = 1 AND LOWER(pc.codigo) LIKE ?))
ORDER BY descricao ASC LIMIT 20
```

- Busca por **SKU, descrição e código alternativo** (`produto_codigos` — código de barras, referência do fornecedor).
- Case-insensitive via `LOWER()` nos dois lados.
- `%TEMPERO%` — casa no meio da palavra ("MOLHO TEMPERO VERDE" aparece). ✅
- **LIMIT 20 fixo, sem offset** — se houver 50 temperos, o vendedor vê 20 e não tem como pedir os próximos. É a principal limitação do endpoint para o app.
- Não devolve `precoMinimoVenda`, `saldo`, `ncm`, `imagemPath` nem `tipoProduto`.

A alternativa `GET /api/produtos?q=TEMPERO` traz tudo isso, mas ver §6.4.

### 6.4 Paginação e desempenho para milhares de produtos

**Volume real hoje** (12 tenants):

| Tenant | Produtos | Movimentações de estoque |
|---|---:|---:|
| `1bit` | 131 | 41 |
| `produtosbomgosto` | 76 | 709 |
| `raeldouglas` | 20 | 4 |
| `jaagricola` | 4 | 5 |
| `labfiscal`, `josecarloscostafilho` | 1 | 20 / 4 |
| outros 6 | 0 | 0 |

Nenhum tenant chega perto de "milhares" hoje. A análise abaixo é **prospectiva**.

**Índices existentes em `produtos`** (`sqlite_master`): apenas
`idx_produtos_descricao ON produtos(descricao)`. Não há índice em `sku`, nem
índice de texto (FTS não existe no schema).

**Plano de execução medido** (`EXPLAIN QUERY PLAN` do autocomplete no `1bit`):

```
SCAN produtos USING INDEX idx_produtos_descricao
`--CORRELATED SCALAR SUBQUERY 1
   `--SEARCH pc USING INDEX idx_produto_codigos_produto (produtoId=? AND ativo=?)
```

Leitura: `LIKE '%...%'` **não usa índice para filtrar** — é varredura completa.
O índice de descrição serve só para entregar a ordenação já pronta, o que permite
parar no vigésimo acerto quando há muitos acertos. Com termo raro (poucos
acertos), varre a tabela toda. Para 10.000 produtos em SQLite local isso ainda é
da ordem de poucos milissegundos; para 100.000+ passa a doer, e a subconsulta
correlacionada em `produto_codigos` roda por linha.

**O problema sério não é o autocomplete — é `GET /api/produtos`:**

1. **Sem `LIMIT`** (`produtos-routes.js:85`) — devolve a tabela inteira.
2. **`SELECT p.*`** — 69 colunas por produto.
3. **Subconsulta de saldo por linha** (`:61-64`): soma toda a `movimentacoes_estoque` de cada produto. É um N+1 embutido em SQL. Com 5.000 produtos e 500.000 movimentações, é uma agregação completa por produto a cada chamada.
4. Ainda faz um `SELECT valor FROM config WHERE chave='optica_enabled'` por requisição (`:75`).

Para o app: **usar `/api/produtos/autocomplete` para busca digitada e nunca
`/api/produtos` sem `q`**. Se o app precisar de catálogo offline, esse endpoint
não serve — carregar tudo num celular por uma rota sem paginação é o pior caso
possível.

---

## 7. PREÇO — `GET /api/precos/resolver`

### 7.1 Assinatura

**`GET /api/precos/resolver`** — `precos-routes.js:398-411`.
RBAC (`perfis-api-map.js:158`): liberado para quem tem a página `pedidos`. ✅
(o perfil "Comercial Flash" tem).

| Parâmetro | Obrigatório | Tratamento |
|---|---|---|
| `produtoId` | **sim** — sem ele, 400 `'produtoId obrigatório'` (`:401`) | `Number(produtoId)` |
| `pessoaId` | não | `Number()` ou `null` — é o **cliente**, não o vendedor |
| `quantidade` | não | `Number()` ou `1` (`:404`) |
| `tabelaId` | não | `Number()` ou `null` — tabela forçada |

### 7.2 Retorno

`res.json({ success: true, ...resultado })` (`:407`), onde `resultado` vem de
`resolverPreco` (`precos-routes.js:127-165`):

```json
{ "success": true, "preco": 12.5, "fonte": "tabela_cliente", "tabelaId": 3, "tabelaNome": "Atacado" }
```

`fonte` ∈ `'tabela_forcada' | 'tabela_cliente' | 'tabela' | 'produto'`.
`tabelaId`/`tabelaNome` só aparecem quando a fonte é uma tabela.

### 7.3 Prioridade das regras (`precos-routes.js:136-164`)

| Ordem | Fonte | Condição | `fonte` |
|---|---|---|---|
| 0 | `tabelaId` do parâmetro (= `pedidos.tabelaPrecoId`) | tabela existe, vigente, tem o produto | `tabela_forcada` |
| 1 | `pessoas.tabelaPrecoId` do cliente | idem | `tabela_cliente` |
| 2 | Tabelas gerais `ativo=1`, `ORDER BY prioridade DESC, id` | primeira vigente que tenha o produto | `tabela` |
| 3 | `produtos.precoVenda` | sempre | `produto` |

**Vigência** — `tabelaVigente()` (`:116-121`): `ativo = 1` **e** hoje (data de
Brasília, `dataBrasilia()` em `:19-21`) dentro de
`vigenciaInicio`/`vigenciaFim` (nulos = sem limite).

**Faixa por quantidade** — dentro de cada tabela (`:131-134`):
```sql
SELECT preco, qtdMinima FROM tabela_preco_itens
WHERE tabelaId = ? AND produtoId = ? AND qtdMinima <= ?
ORDER BY qtdMinima DESC LIMIT 1
```
Escolhe a linha de **maior `qtdMinima` que não ultrapasse a quantidade**. Se
todas as linhas do produto tiverem `qtdMinima` maior que a quantidade pedida,
**a tabela é ignorada** e a cadeia continua para o próximo nível.

### 7.4 Preço mínimo, descontos, promoções

- **Preço mínimo:** `produtos.precoMinimoVenda` existe e é validado **apenas no cadastro do produto** — `validarPrecoMinimo()` (`produtos-routes.js:149-156`), chamada no `POST`/`PUT` de produto. **`resolverPreco` não o consulta**, e o pedido não o consulta. Um item de pedido pode sair abaixo do mínimo sem que nada reclame.
- **Desconto:** não existe conceito de desconto no resolvedor nem no pedido (Caixa 1 §5.3). Só `faturas.valorDesconto`, no faturamento.
- **Promoções:** **não existem** como entidade. O mecanismo equivalente é uma `tabelas_preco` com `vigenciaInicio`/`vigenciaFim` e `prioridade` alta. Não há tabela `promocoes` no schema.
- **Preço por cliente:** só via `pessoas.tabelaPrecoId` — não há preço individual por par (cliente, produto).

### 7.5 Comportamento quando não encontra preço

Nunca devolve erro nem 404. O nível 3 (`:163-164`) sempre responde:

```js
const p = db.prepare('SELECT precoVenda FROM produtos WHERE id = ?').get(produtoId);
return { preco: p ? (p.precoVenda || 0) : 0, fonte: 'produto' };
```

- Produto sem `precoVenda` → **`preco: 0`, `fonte: 'produto'`**.
- **`produtoId` inexistente → também `preco: 0`, `fonte: 'produto'`, com `success: true`.** Não há 404.

Isso importa para o app: **`preco: 0` não distingue "produto de graça" de
"produto sem preço" de "produto que não existe"**. O app precisa tratar o zero
como suspeito, e nunca gravar item com preço 0 sem confirmação — porque a Caixa 1
já mostrou que o backend aceita.

### 7.6 Serve como fonte oficial de preço para o app?

**Sim, para exibir.** É exatamente o que a tela usa (`pedido.html:1666-1687`), é
o mesmo `resolverPreco` que a loja virtual usa no carrinho
(`loja-routes.js:276`), e cobre as quatro fontes com a mesma precedência. Usá-lo
garante que o app mostre o mesmo preço da tela.

**Não, como garantia.** Ele é consultivo: o preço que ele devolve não é o preço
que o pedido grava. Entre a consulta e o `POST /api/pedidos/:id/itens`, o valor
passa pelo celular — e o backend aceita o que chegar (Caixa 1 §5.3). Duas
consequências reais:

1. Um app comprometido (ou um `curl` com a sessão do vendedor) grava qualquer preço.
2. Mesmo sem má-fé: se o vendedor montar o pedido offline e sincronizar horas depois, o preço enviado pode já estar vencido (tabela expirou, reajuste rodou) e ninguém percebe.

### 7.7 O que precisaria mudar para validar/recalcular no servidor

**Registro do que seria necessário — nada disto foi implementado.**

O ponto de inserção é único e já está isolado: os três lugares que gravam
`precoUnitario` — `pedidos-routes.js:361-363` (criar com itens), `:719-721`
(adicionar item) e `:744-746` (editar item). Hoje nenhum deles chama
`resolverPreco`, embora `precos-routes` **já esteja requerido** em
`pedidos-routes.js:21` (para vendas perdidas) — ou seja, a dependência já existe
e não criaria ciclo (`precos-routes` não requer `pedidos-routes`).

Decisões que teriam de ser tomadas antes de escrever qualquer linha:

| Decisão | Por que não é óbvia |
|---|---|
| Recalcular **ou** validar? | Recalcular (ignorar o preço do cliente) quebra o desconto negociado, que hoje é legítimo e usado. Validar (aceitar dentro de uma faixa) exige definir a faixa. |
| Qual o piso? | `produtos.precoMinimoVenda` **tem base real, mas desigual** (medido em 2026-08-26): `produtosbomgosto` **76/76** produtos preenchidos, `raeldouglas` **19/20**, `1bit` apenas **7/132**. Nos dois primeiros a regra teria o que aplicar; no `1bit` ela seria quase sempre inerte. Uma validação por preço mínimo precisa decidir o que fazer quando o campo é nulo — bloquear seria inviável, ignorar deixa o buraco aberto onde o cadastro é fraco. |
| Quem pode furar o piso? | Não há permissão por campo hoje; seria RBAC novo (§3.9). |
| Item sem `produtoId` | Serviço e desconto entram como item livre (`pedido_itens.produtoId` nulo) — para eles não há preço a resolver. A regra tem de os ignorar. |
| Preço negativo | Hoje é aceito e **usado** pela OS para lançar desconto de capa (`os-routes.js:2265-2268`). Bloquear negativo quebraria o faturamento de OS. |
| Efeito retroativo | Ligar validação afeta a tela, o PDV, a loja virtual e a OS — todos passam pelos mesmos handlers. |

**Nada disso deve ser implementado nesta etapa** (instrução explícita). Fica
registrado como decisão de produto, não de código.

---

## 8. ESTOQUE

### 8.1 Os quatro conceitos, e onde diferem

| Conceito | Como é calculado | Onde |
|---|---|---|
| **Saldo físico** | `SUM(entrada) - SUM(saida) + ajustes` sobre `movimentacoes_estoque`, **global, sem recorte de depósito** | `reservas-routes.js:208-215`, `produtos-routes.js:61-64` |
| **Reservado** | `SUM(quantidade)` de `reservas_estoque` com `status='ativa'` | `saldoReservado()` — `reservas-routes.js:50-57` |
| **Disponível** | `saldo físico − reservado` | `estoque-routes.js:431` (`disponivel`), `loja-routes.js:115-124` (com `Math.max(0, ...)`) |
| **Saldo do lote** | `lotes.saldoAtual`, mantido por UPDATE no consumo | `reservas-routes.js:405` |

Diferenças que o app precisa conhecer:

- **Saldo ≠ disponível.** Um produto com saldo 20 e 18 reservados tem 2 vendáveis. Mostrar "20" ao vendedor produz venda que a confirmação recusa com 409.
- **`disponivel` pode ser negativo** em `/api/estoque` (`estoque-routes.js:431` não usa `Math.max`), mas é truncado em 0 na loja (`loja-routes.js:122`). Dois cálculos, dois resultados, para o mesmo produto.
- **Saldo físico ignora depósito por padrão.** A reserva é criada olhando o saldo **global** (`reservas-routes.js:172-177`), mesmo tendo `depositoId` gravado. Ou seja: o sistema pode reservar mercadoria que está fisicamente em outro depósito.

### 8.2 Endpoints de consulta

| Método | URL | Arquivo:linha | Devolve | Serve ao app? |
|---|---|---|---|---|
| GET | `/api/estoque?q=&depositoId=&rastreiaLote=&rastreiaSerial=` | `estoque-routes.js:403-446` | lista com `saldo`, `reservado`, `disponivel`, `custoMedio`, `valorEstoque` + totais | **conceitualmente sim**, mas sem paginação e bloqueado por RBAC (§8.4) |
| GET | `/api/estoque/:produtoId/saldo-lojas` | `:393-400` | `{ lojas: [{estabelecimentoId, nome, saldo}], total }` | saldo por estabelecimento — **não desconta reserva** |
| POST | `/api/estoque/verificar-disponibilidade` | `reservas-routes.js:641-677` | por item: `saldo`, `reservado`, `disponivel`, `suficiente`, `faltando` + `tudoDisponivel` | **é o melhor endpoint para o carrinho do app** |
| GET | `/api/produtos/:id` | `produtos-routes.js:118-132` | `produto.saldo` — **saldo físico, sem reserva** | parcial |
| GET | `/api/estoque/alertas` | `:448` | abaixo do mínimo | não |
| GET | `/api/estoque/movimentacoes` | `:774` | extrato | não |
| GET | `/api/pedidos/:id/falta` | `necessidades-compra-routes.js:93` | o que falta para um pedido | útil depois de montar |

### 8.3 "Produto X — Disponível: 18 UN" sem baixar a movimentação toda

**Sim, e há dois caminhos, ambos já existentes:**

**Para um item ou um carrinho — `POST /api/estoque/verificar-disponibilidade`**
(`reservas-routes.js:641-677`). Corpo `{ itens: [{ produtoId, quantidade }] }`,
resposta por item:

```json
{ "produtoId": 7, "sku": "TEMP-01", "descricao": "Tempero verde",
  "quantidadePedida": 5, "saldo": 20, "reservado": 2, "disponivel": 18,
  "suficiente": true, "faltando": 0 }
```

É exatamente a informação pedida, calculada no servidor, sem trafegar
movimentação. É também o mesmo cálculo que a confirmação do pedido usará
(`criarReservasPedido`), então o que o app mostra e o que o `confirmar` decide
não divergem.

**Para uma lista de busca — `GET /api/estoque?q=TEMPERO`**
(`estoque-routes.js:403-446`), que já devolve `saldo`, `reservado` e `disponivel`
por produto. Ressalva: **não tem `LIMIT`** — com `q` vazio devolve o catálogo
ativo inteiro, cada linha com três subconsultas agregadas.

**O que não serve:** `GET /api/produtos/:id` devolve `saldo`, não `disponivel` —
usar esse número no app mostraria 20 onde há 18.

### 8.4 O obstáculo real: RBAC bloqueia estoque para o vendedor

`perfis-api-map.js:92`:

```js
'/api/estoque': ['aprovacoes', 'contas-a-pagar', 'estoque', 'estoque-analises',
                 'estoque-lotes', 'estoque-movimentacoes', 'manifestador'],
'/api/reservas': ['estoque-reservas'],                    // :171
```

O perfil real "Comercial Flash" (tenant `josecarloscostafilho`, usuários
`william` e `caio`, ambos `ehVendedor=1`) tem estas páginas:

```
habilitacao-certidoes, pessoas, crm-funil, pedidos, comercial-tabelas-preco,
comercial-vendas-perdidas, comercial-metas, contratos, devolucoes, produtos,
fornecedores, notas-fiscais, funcionarios, conversas, meu-perfil, usuarios, status
```

**Nenhuma delas está na lista de `/api/estoque`.** Logo, o vendedor recebe
**403** em `GET /api/estoque` — e também em
`POST /api/estoque/verificar-disponibilidade`, porque o gate casa por **prefixo
de caminho** (`perfis-acesso.js:152`: `'/api/' + pathname.split('/')[2]`), e o
caminho começa com `/api/estoque` mesmo o handler morando em
`reservas-routes.js`.

Ou seja: **hoje, um vendedor com perfil restrito não consegue consultar estoque
por nenhuma rota dedicada.** O que ele alcança é o campo `saldo` embutido em
`/api/produtos` — que é saldo físico, sem reserva.

**Nuance importante:** isso só morde quando existe perfil cadastrado.
`acessoDoUsuario` (`perfis-acesso.js:99-107`) é **fail-open**: se o `role` do
usuário não tem linha ativa em `perfis_acesso`, devolve `irrestrito: true`.
Estado real:

| Tenant | `perfis_acesso` | Efeito para o vendedor |
|---|---|---|
| `1bit` | **vazio** | `guilherme` (role `comercial`) é **irrestrito** — vê tudo, inclusive estoque |
| `josecarloscostafilho` | 1 perfil `comercial` ativo | `william` e `caio` são **restritos** — 403 em estoque |

Portanto o app se comportaria **diferente em cada tenant**, dependendo de o
administrador ter cadastrado perfil ou não. Isso é a descoberta mais acionável
desta seção: não é bug do app, é configuração — mas o app tem de tratar 403 como
resposta esperada, e a decisão "incluir `estoque` no perfil do vendedor ou incluir
`pedidos` na lista de `/api/estoque`" é do produto.

### 8.5 Estoque por estabelecimento e por depósito

- **Por estabelecimento:** `GET /api/estoque/:produtoId/saldo-lojas` → `saldoPorEstabelecimento()` (`estoque-routes.js:288-318`). Agrupa por `depositos.estabelecimentoId`, consolidando `NULL` como "Matriz". **Devolve saldo, não disponível.**
- **Por depósito:** `GET /api/estoque?depositoId=N` (`estoque-routes.js:406-407`) filtra `COALESCE(depositoId, <padrão>) = N`. Movimentação com `depositoId` nulo conta como depósito padrão.
- **Depósito do pedido:** `pedidos.depositoId`, resolvido por `resolverDeposito()` (`estoque-routes.js:234-258`). No `1bit` há 2 depósitos: `Principal` (padrão) e `DEPÓSITO TESTE`.
- **`pedidos` não tem `estabelecimentoId`** (Caixa 1 §2.1) — o escopo de filial não alcança o pedido; alcança a fatura.

---

## 9. MATRIZ: APIs EXISTENTES × FALTANTES

Legenda: **Reutilizar** = usar como está. **Adaptar** = a rota existe e responde,
mas falta algo (filtro, campo, permissão). **Criar** = não existe rota equivalente.

| # | Necessidade do app | API existente | Reutilizar | Adaptar | Criar | Observação |
|---|---|---|:--:|:--:|:--:|---|
| 1 | Login | `POST /api/login` (`auth-routes.js:64`) | ✅ | | | JSON, sem CSRF. Cookie `liciteagora.sid`, 7 dias, sem renovação por uso |
| 2 | Logout | `POST /api/logout` (`auth-routes.js:109`) | ✅ | | | |
| 3 | Identificar usuário | `GET /api/usuarios/me` (`usuarios-routes.js:43`) | | ⚠️ | | Devolve `req.user` de `auth.js:257` — **sem `ehVendedor`** |
| 4 | Identificar vendedor | — | | ⚠️ | | Contorno: achar o próprio `id` em `GET /api/usuarios?vendedor=1`. Direto: incluir `ehVendedor` em `/me` |
| 5 | Listar clientes | `GET /api/pessoas` (`financeiro-routes.js:374`) | | ⚠️ | | Sem paginação; `SELECT *` (~70 colunas) |
| 6 | Pesquisar clientes | `GET /api/pessoas/autocomplete` (`:401`) | ✅ | | | LIMIT 10, ≥2 chars. **Usar este** |
| 7 | Criar cliente | `POST /api/pessoas` (`:639`) | ✅ | | | Exige só `cpfCnpj`+`razaoSocial`; 409 se duplicado; reativa inativo. `/api/cep` dá **403** no perfil comercial |
| 8 | Condição de pagamento do cliente | `GET /api/pessoas/condicoes-pagamento` (`:424`) | ✅ | | | Evita o 400 do `PUT /api/pedidos/:id` |
| 9 | Listar produtos | `GET /api/produtos` (`produtos-routes.js:56`) | | ⚠️ | | Sem `LIMIT`, `p.*`, subconsulta de saldo por linha. Não usar sem `q` |
| 10 | Pesquisar produtos | `GET /api/produtos/autocomplete` (`:93`) | ✅ | | | SKU+descrição+código alternativo. LIMIT 20 **sem offset** |
| 11 | Consultar preço | `GET /api/precos/resolver` (`precos-routes.js:398`) | ✅ | | | Fonte oficial para **exibir**. `preco:0` é ambíguo |
| 12 | Consultar estoque (carrinho) | `POST /api/estoque/verificar-disponibilidade` (`reservas-routes.js:641`) | | ⚠️ | | Resposta ideal; **403 para perfil comercial** (prefixo `/api/estoque`) |
| 13 | Consultar estoque (lista) | `GET /api/estoque` (`estoque-routes.js:403`) | | ⚠️ | | Mesmo 403; sem paginação |
| 14 | Criar pedido | `POST /api/pedidos` (`pedidos-routes.js:336`) | ✅ | | | **Não enviar `vendedorId`** → o backend usa `req.session.userId` |
| 15 | Preencher cabeçalho | `PUT /api/pedidos/:id` (`:530`) | ✅ | | | Onde entram `tipoOperacaoId`, `meioPagamento`, `politicaPrazoId`, frete |
| 16 | Adicionar itens | `POST /api/pedidos/:id/itens` (`:693`) | ✅ | | | **Preferir a este** vs. itens no POST: só aqui roda `sugerirCFOP` |
| 17 | Confirmar pedido | `POST /api/pedidos/:id/confirmar` (`:833`) | ✅ | | | 409 + `insuficiencias` quando falta saldo; `{forcar:true}` para insistir |
| 18 | Listar pedidos do vendedor | `GET /api/pedidos` (`:182`) | | | ❌ | **Não aceita `vendedorId` e não pagina.** Única lacuna sem alternativa segura |
| 19 | Consultar pedido | `GET /api/pedidos/:id` (`:259`) | ✅ | | | `carregarPedidoCompleto` traz cabeçalho + itens + nomes |
| 20 | Tipos de operação | `GET /api/tipos-operacao?usoPedido=1` | ✅ | | | RBAC libera para `pedidos` |
| 21 | Depósitos | `GET /api/depositos` | ✅ | | | RBAC libera para `pedidos` |
| 22 | PDF do pedido | `GET /api/pedidos/:id/pdf` (`:1100`) | ✅ | | | Para o vendedor mandar ao cliente |

### 9.1 Leitura da matriz

- **Reutilizáveis sem tocar em nada: 13 das 22.** O caminho completo "logar → achar cliente → achar produto → preço → criar pedido → itens → confirmar → ver pedido" está inteiro coberto por rota existente.
- **Uma única lacuna sem alternativa segura: #18** (listar os pedidos do próprio vendedor). Hoje a opção seria baixar todos os pedidos da empresa no celular e filtrar lá — o que expõe pela rede os pedidos, valores e clientes de todos os vendedores. Não é aceitável, e não há rota alternativa.
- **Quatro "adaptar" que são de configuração, não de código:** #12 e #13 dependem de o perfil do vendedor incluir uma página de estoque (ou de `/api/estoque` passar a aceitar a página `pedidos`); #3 e #4 dependem de um campo a mais no `SELECT` de `auth.js:257`.
- **Nenhum endpoint novo de escrita é necessário** — confirmando a Caixa 1 §7.5.

---

## 10. SEGURANÇA DO FUTURO APP — riscos classificados

Contexto que muda tudo: hoje o ERP é consumido por navegador, em rede conhecida,
por um punhado de usuários. O app coloca credenciais de produção em aparelhos
pessoais, fora de qualquer perímetro, com o dono do aparelho tendo controle total
sobre ele.

### CRÍTICO

**1. API Key fixa embutida no app** *(se essa rota for escolhida)*
A chave é root do tenant, sem expiração, sem escopo, sem log
(`auth.js:299-306`; `perfis-acesso.js:185`; `audit-log.js:19`). Segredo estático
em binário distribuído é extraível — `strings`/`apktool` no pacote, `frida` em
runtime, ou proxy TLS no próprio aparelho, onde o usuário instala o próprio
certificado. Extraída, dá acesso administrativo à empresa inteira: criar usuário
admin (`POST /api/usuarios`), emitir NF-e, apagar cadastro. E não é revogável por
dispositivo: `config.api_key` é **uma linha**, então rotacionar derruba todos os
vendedores e o cliente Electron junto. **É crítico porque combina impacto máximo,
detecção nula e resposta que quebra tudo.**

**2. Preço definido pelo cliente**
`pedidos-routes.js:361-363`, `:719-721`, `:744-746` gravam `precoUnitario` sem
validar contra nada — nem `precoMinimoVenda`, nem `precoCusto`, nem desconto
máximo. Negativo é aceito. Com o app, quem controla o preço deixa de ser um
funcionário num desktop da empresa e passa a ser um binário num celular que o
próprio vendedor pode instrumentar. Um vendedor mal-intencionado (ou alguém com o
aparelho dele) vende abaixo do custo e o sistema fatura, emite NF-e e lança a
comissão sem uma única checagem. **É crítico por ser perda financeira direta,
silenciosa e legítima aos olhos do sistema.**

### ALTO

**3. `vendedorId` aceito do corpo, sem validação**
`pedidos-routes.js:348` — o corpo vence a sessão, e não há checagem de existência,
`ativo` ou `ehVendedor`. Qualquer requisição autenticada atribui o pedido a
outro vendedor, inclusive em massa
(`POST /api/pedidos/acao-massa`, `:308-311`). Isso é fraude de comissão e
contaminação de meta (`metas_vendas`, `comissoes_apuracao`) com um campo JSON.
Alto e não crítico porque exige sessão válida e o estrago é interno e auditável
depois — se houver log, o que nos leva ao risco 8.

**4. Rate limit de login contornável**
`auth-routes.js:51-54` lê `X-Forwarded-For` e pega o **primeiro** elemento; o
nginx usa `$proxy_add_x_forwarded_for` (`/etc/nginx/nginx.conf:54`), que
**anexa** — logo o primeiro elemento é o que o cliente mandou. Variando o header,
o teto de 5 tentativas/15 min não se aplica. Somado à ausência de política de
senha forte no `POST /api/change-password` (8 caracteres, `auth-routes.js:135`) e
à ausência de bloqueio por conta, isso é brute-force viável contra a senha de um
vendedor. Alto porque o app multiplica o número de contas com acesso real ao ERP.

**5. Sem recuperação de senha, e sem 2FA**
Não existe fluxo de "esqueci minha senha" para usuário de tenant (§1.8). Com
dezenas de vendedores, o resultado previsível não é o suporte crescer — é o
administrador escolher senhas fracas e repetidas, ou compartilhar credenciais.
Alto por ser um risco que se materializa por pressão operacional, não por ataque.

**6. Dispositivo perdido ou roubado**
O cookie vive 7 dias no aparelho (`auth-bootstrap.js:63`). Há uma boa resposta —
`users.ativo = 0` derruba a sessão na requisição seguinte (`auth.js:311-317`) —
mas ela é tudo-ou-nada: tira o vendedor do sistema inteiro, incluindo o
navegador. Não há "encerrar sessões deste dispositivo", nem lista de sessões
ativas, nem identificação de dispositivo na tabela `sessions` (só `sid`, `sess`,
`expired`). Alto, com atenuante real.

**7. Ausência de filtro por vendedor em `GET /api/pedidos`**
`pedidos-routes.js:182-227` — sem `vendedorId` e sem `LIMIT`. Um app que precise
de "meus pedidos" acaba baixando todos os pedidos da empresa para o celular:
valores, clientes, margens e histórico de todos os vendedores trafegando para um
aparelho pessoal e ficando em cache local. É vazamento por design, não por falha.
Alto.

**8. Ações via X-Api-Key não são auditadas**
`audit-log.js:19` retorna sem gravar quando `req.user` é indefinido. Se o app usar
chave, o `audit_log` fica cego: pedido nasce sem autor, cliente é alterado sem
autor. Alto porque destrói a capacidade de investigar qualquer um dos riscos
acima depois que acontecem. *(Deixa de existir se o app usar sessão.)*

### MÉDIO

**9. Enumeração de IDs dentro do tenant**
`GET /api/pessoas/:id`, `GET /api/produtos/:id`, `GET /api/pedidos/:id` são
sequenciais e não verificam titularidade — qualquer usuário autenticado lê
qualquer registro do próprio tenant. Médio, e não alto, porque **entre tenants é
impossível** (§4.8) e porque, dentro da empresa, esses dados já são visíveis pela
tela para quem tem a página no perfil. O que muda com o app é a escala: varrer
`/api/pessoas/1..5000` de um celular extrai a carteira inteira. O único
`guardEscopo` por `id` que existe está em `/api/faturas/:id`
(`faturas-routes.js:143`) e é por estabelecimento, não por vendedor.

**10. RBAC fail-open**
`perfis-acesso.js:104` — `role` sem linha ativa em `perfis_acesso` vira
`irrestrito: true`. É deliberado e documentado (`:20-25`), mas significa que no
`1bit`, hoje, o vendedor `guilherme` **vê o sistema inteiro** pelo app: financeiro,
custos, folha, fiscal. Médio porque a correção é cadastral (criar o perfil), não
de código — mas o app amplia a superfície de quem carrega esse acesso no bolso.

**11. Replay de requisição**
Não há nonce, timestamp, assinatura de corpo nem idempotency-key em nenhum
endpoint. Reenviar um `POST /api/pedidos/:id/itens` capturado duplica o item;
reenviar `POST /api/pedidos` cria outro pedido. Médio: exige interceptar tráfego
já autenticado (TLS + `secure` cookie dificultam), e o efeito é duplicação
visível e corrigível, não perda silenciosa. Relevante também sem atacante — app
móvel com rede instável repete requisição sozinho.

**12. Sem rate limit fora do login**
O único limitador do sistema é o do `POST /api/login`. Nenhum outro endpoint tem
teto. Um app em loop de retry, ou um cliente hostil, pode martelar
`GET /api/produtos` (sem `LIMIT`, com subconsulta de saldo por linha —
`produtos-routes.js:56-91`) e degradar o processo único que atende **todos os
tenants**. Médio, tendendo a alto conforme o catálogo cresce.

**13. Fotos de produto públicas**
`pre-auth-routes.js:53-56` serve `/uploads/produtos` antes da barreira. Bom para
o app (miniatura sem cookie), mas expõe o catálogo visual de qualquer tenant a
quem souber a URL. Médio, e é decisão consciente documentada no código.

### BAIXO

**14. Acesso entre tenants**
Estruturalmente barrado: banco por arquivo escolhido pelo Host antes de qualquer
rota, sessão gravada no banco do tenant, cookie por subdomínio (§4.8). Não
depende de nenhuma checagem que alguém possa esquecer. **Baixo** — a única via
concebível seria vazamento do `session_secret` do `control.db` combinado com
adivinhar um SID válido do outro tenant, e mesmo assim o SID precisa existir na
tabela `sessions` daquele banco.

**15. Roubo do cookie em trânsito**
`NODE_ENV=production` confirmado na unit instalada → `cookie.secure = true`
(`auth-bootstrap.js:66`): o cookie só sai em HTTPS. `httpOnly` bloqueia leitura
por script. Baixo, com a ressalva de que TLS pinning não existe — num aparelho
com certificado próprio instalado, o dono lê o próprio tráfego (o que reforça o
risco 1, não este).

**16. CSRF**
Não há token, mas `sameSite: 'lax'` (`auth-bootstrap.js:65`) impede o envio do
cookie em `POST` cross-site, e o app nativo não tem origem web. Baixo **para o
app**; permanece como observação para a tela web.

---

## RESPOSTAS ÀS CINCO PERGUNTAS

### 1. Podemos reutilizar a autenticação atual no app?

**Sim — e é a escolha certa.** `POST /api/login` recebe e devolve JSON, o cookie
é gerenciado por qualquer cliente HTTP nativo, não há CSRF token a replicar, e
rota `/api/*` não-autenticada devolve **401 JSON**, não redirect HTML
(`auth.js:326-328`). A sessão traz de graça o que a API Key não tem: identidade
do vendedor, RBAC por perfil, auditoria, e revogação imediata por
`users.ativo = 0`.

Três limitações a tratar no app, nenhuma impeditiva:
- sessão de 7 dias **sem renovação por uso** (não há `touch` no store,
  `auth.js:80-107`, e `rolling` não está ligado) → o app precisa tratar 401 e
  pedir login de novo;
- não há recuperação de senha (§1.8);
- o rate limit de login é contornável por `X-Forwarded-For` (§1.5).

**Não usar X-Api-Key** (§2.10).

### 2. Como identificar com segurança o vendedor logado?

**Pelo `users.id` da sessão — `req.session.userId`, exposto como `req.user.id`.**
É o identificador que todo o sistema usa: `pedidos.vendedorId`,
`metas_vendas.vendedorUserId` (NOT NULL), `comissoes_apuracao.vendedorId` (NOT
NULL com FK para `users`). Não existe tabela de vendedores — vendedor é
`users.ehVendedor = 1`.

Na prática, para o pedido nascer com o vendedor certo **o app não precisa fazer
nada além de não atrapalhar**: `pedidos-routes.js:348` já usa
`req.session?.userId` como default. Basta **omitir `vendedorId` do corpo** —
porque, se o campo vier, ele vence a sessão e não é validado.

Duas arestas ficam em aberto, e são de backend, não do app:
- `GET /api/usuarios/me` não devolve `ehVendedor` (o `SELECT` de `auth.js:257` não o inclui), então o app não consegue confirmar pela identidade que quem logou é vendedor;
- o `vendedorId` do corpo continua sendo aceito de qualquer cliente — transformar "o app não manda" em "o servidor não aceita" exige mudança.

### 3. Como garantir que o app só acesse o tenant correto?

**Já está garantido pela arquitetura, e a garantia não depende de código de
aplicação.** O tenant vem do `Host` (`tenant-manager.js:217-235`), o banco é
escolhido antes de qualquer rota (`tenant-middleware.js:192-201`), e cada empresa
é um arquivo SQLite separado. Um ID trocado na URL busca numa tabela que não
contém o registro do outro tenant — devolve 404 por inexistência, não por
verificação.

O que o app precisa fazer: **fixar a URL base no subdomínio do tenant**
(`https://<slug>.liciteagora.app`) e tratá-la como parte da identidade da conta.
Não existe — nem poderia existir sem varrer os 12 bancos — um endpoint "descubra
meu tenant pelo usuário". Trocar o Host não dá acesso a nada: a sessão vive na
tabela `sessions` **daquele** banco (`auth.js:62-68`), então o cookie de A é
inválido em B.

### 4. Quais APIs necessárias para o MVP já existem?

**13 das 22 da matriz, incluindo o fluxo de venda inteiro**, sem tocar em nada:

- login e logout (`/api/login`, `/api/logout`);
- buscar cliente (`GET /api/pessoas/autocomplete`) e criar cliente (`POST /api/pessoas`);
- condição de pagamento do cliente (`GET /api/pessoas/condicoes-pagamento`);
- buscar produto (`GET /api/produtos/autocomplete`);
- consultar preço (`GET /api/precos/resolver`);
- criar pedido (`POST /api/pedidos`), preencher cabeçalho (`PUT /api/pedidos/:id`), adicionar itens (`POST /api/pedidos/:id/itens`), confirmar (`POST /api/pedidos/:id/confirmar`), consultar (`GET /api/pedidos/:id`), PDF (`GET /api/pedidos/:id/pdf`);
- apoio: `GET /api/tipos-operacao?usoPedido=1`, `GET /api/depositos`.

E a consulta de estoque ideal — `POST /api/estoque/verificar-disponibilidade`
(`reservas-routes.js:641-677`) — **existe e devolve exatamente
`saldo/reservado/disponivel/suficiente/faltando`**; o obstáculo dela é
permissão, não ausência.

### 5. Quais APIs ou adaptações são realmente indispensáveis antes de desenvolver o app?

Separando o que trava o desenvolvimento do que é melhoria — e nada disto foi
implementado nesta etapa:

**Indispensável (o app não funciona ou vaza dados sem isto):**

1. **Filtro `vendedorId` + paginação em `GET /api/pedidos`** (`pedidos-routes.js:182-227`). É a única necessidade do app sem alternativa segura: sem ela, "meus pedidos" obriga a baixar os pedidos de toda a empresa para o celular.
2. **Acesso do vendedor ao estoque.** Escolher entre incluir uma página de estoque no perfil do vendedor (mudança de cadastro, zero código) ou incluir a página `pedidos` na lista de `/api/estoque` em `perfis-api-map.js:92` (mudança de uma linha). Sem uma das duas, o app mostra 403 onde deveria mostrar "Disponível: 18 UN" — em tenants que tenham perfil cadastrado.
3. **Decisão sobre autenticação — e ela já está tomada:** sessão, não API Key. Isso não é adaptação, é o que impede o projeto de nascer com um risco crítico embutido.

**Fortemente recomendado antes de liberar em campo:**

4. **`ehVendedor` em `GET /api/usuarios/me`** — um campo no `SELECT` de `auth.js:257`. Sem ele o app não confirma pela identidade que quem logou é vendedor.
5. **Ignorar `vendedorId` do corpo quando há sessão** (`pedidos-routes.js:348`) — converte "o app não manda" em garantia do servidor.
6. **Validação de preço server-side** (§7.7). O app amplia muito a exposição de um buraco que já existe. Exige decisões de produto listadas em §7.7 — não é mudança mecânica.
7. **Corrigir a leitura de IP do rate limit** (`auth-routes.js:51-54`) — usar `req.ip` (que já respeita `trust proxy`) em vez do primeiro elemento do header cru.

**Conveniência, não bloqueio:**

8. Endpoint "criar pedido completo numa chamada" — resolveria o número de idas e voltas no celular e daria atomicidade ao `POST` (que hoje não é transacional, Caixa 1 §7.5).
9. `offset` no `GET /api/produtos/autocomplete` (LIMIT 20 fixo).
10. Aceitar `tipo` no `POST /api/pedidos` para marcar o canal `'app'` (Caixa 1 §8.4).

---

## O que ficou "não confirmado"

- **Comportamento sob carga** dos endpoints sem paginação (`GET /api/produtos`, `GET /api/pedidos`, `GET /api/estoque`): a análise é do plano de query e do SQL; nenhum teste de carga foi executado. O maior tenant tem 132 produtos e 27 pedidos hoje.
- **Se o rate limit do login é de fato contornável em produção**: confirmado por leitura de `auth-routes.js:51-54` + `/etc/nginx/nginx.conf:54` (`$proxy_add_x_forwarded_for` **anexa**, não substitui), **não** por tentativa de contorno — e não será testado, isto é auditoria. O `/etc/nginx/conf.d/cloudflare.inc` (com `set_real_ip_from`, que corrigiria o header) **existe mas não é incluído por nenhum vhost de tenant** — grep em `/etc/nginx/conf.d/domains/*liciteagora*` não retorna referência a ele nem a `real_ip`. Logo, nada reescreve o header antes do Node.
- **Se existe algum consumidor de `X-Api-Key` além do cliente Electron** — os comentários do código citam só ele (`pre-auth-routes.js:13-15`, `admin-routes.js:112`); não foi feita varredura de logs de acesso para confirmar que não há outro.
- **Se o `PUT /api/pessoas/:id` e o `DELETE /api/pessoas/:id` têm validações diferentes do `POST`** — só o `POST` foi lido integralmente (`financeiro-routes.js:639-690`); os outros dois foram localizados (`:792`, `:848`) mas não auditados linha a linha.
