# 41 — Auditoria do isolamento multi-tenant

**Data:** 2026-09-12, 22:40–00:50 BRT
**Motivo:** relato de que "o login abriu somente o tenant produtosbomgosto" e de que não há distinção visível de tenants.

---

## A conclusão, primeiro

**Não há falha de isolamento. Não existe tenant padrão, nem fallback para `produtosbomgosto`, nem tabela global de usuários, e uma sessão de um tenant é recusada em todos os outros — testei.**

O que existe é o **outro** problema que você citou, e que é real: **não havia nada na tela dizendo de qual empresa era a sessão aberta**. Foi isso que implementei.

E há uma consequência disso para o §2 do seu pedido, que preciso colocar antes de tudo: **o login central multi-tenant reduziria a segurança que hoje existe.** O raciocínio está na §6 — e essa parte eu **não** implementei, por isso.

---

## 1. Diagnóstico — respostas item a item

### Como o tenant é determinado

**Exclusivamente pelo subdomínio.** `resolveFromHost()` em `tenant-manager.js:217`:

```js
const hostname = host.split(':')[0].toLowerCase();
if (hostname === APEX_DOMAIN) return { kind: 'apex' };
const suffix = '.' + APEX_DOMAIN;
if (!hostname.endsWith(suffix)) return { kind: 'unknown' };
const sub = hostname.slice(0, -suffix.length);
if (!sub || sub.includes('.')) return { kind: 'unknown' };
return { kind: 'tenant', slug: sub };
```

A função **não lê** query, corpo, cabeçalho, cookie ou variável de ambiente — verificado, e agora travado pelo teste A1.

### Onde "produtosbomgosto" está definido

**Em lugar nenhum do caminho de autenticação.** A string aparece em **4 arquivos**, todos fora dele:

| Arquivo | O quê |
|---|---|
| `pedido-politicas.js:79` | comentário citando o tenant como exemplo de cadastro saneado |
| `scripts/rollout-fase1-tenants.js:57` | lista de rollout de uma migração |
| `scripts/test-tema-global.js:236` | comentário sobre um tema custom real |
| `public/comercial/pedidos-pdv.html:617` | comentário sobre categorias de produto |

Nenhum é executado no login.

### Existe tenant fixo, padrão ou fallback?

**Não.** Busca por `DEFAULT_TENANT`, `TENANT_PADRAO`, `defaultTenant`, `tenantPadrao`, `FALLBACK_TENANT`, `fallbackTenant` em todos os `.js` da raiz: **zero ocorrências**.

Variáveis de ambiente do serviço: `MULTI_TENANT=true` e `ASAAS_PLATFORM_TENANT_SLUG=1bit` — esta última é da integração de cobrança da plataforma, não do login.

### Onde ficam os usuários

**Um banco por tenant** (`data/tenants/<slug>/pncp.db`), cada um com a sua tabela `users`. **Não existe tabela global de usuários** — conferido no `control.db`.

| Tenant | Usuários |
|---|---|
| `produtosbomgosto` | `admin` |
| `1bit` | `admin`, `guilherme` |
| `reimac` | `admin` |

`admin` existe em **todos** os tenants — são pessoas **diferentes**, cada uma no seu banco. Não há colisão possível porque não há espaço de nomes compartilhado.

### E-mail/usuário repetido em tenants diferentes

**Pode existir, e é por desenho.** `admin` está em 19 bancos. Como o tenant é resolvido antes de qualquer consulta, `admin@produtosbomgosto` e `admin@1bit` nunca se encontram.

### A autenticação consulta só um banco?

Consulta **o banco do tenant da requisição**:

```js
const userDb = req.tenantDb || db;
const user = stmt(userDb, SQL_GET_USER).get(req.session.userId);
```

### Uma sessão anterior pode abrir o tenant errado?

**Não. Testei.** Peguei uma sessão **válida** do `1bit` direto do banco, assinei o cookie com o `session_secret` real e usei em cada tenant:

| Host | Resposta | Usuário |
|---|---|---|
| `1bit.liciteagora.app` | **200** | `admin (id 1)` |
| `produtosbomgosto.liciteagora.app` | **401** | — |
| `reimac.liciteagora.app` | **401** | — |
| `labfiscal.liciteagora.app` | **401** | — |
| `josecarloscostafilho.liciteagora.app` | **401** | — |

Três coisas produzem esse resultado:

1. o cookie é declarado **sem `domain`** — e o código já dizia por quê: *"cada subdomínio tenant tem seu próprio cookie, evitando colisão de SID entre tenants no mesmo browser"*;
2. as sessões ficam **no banco de cada tenant** (18 no `produtosbomgosto`, 66 no `1bit`);
3. o `userId` é buscado no banco do tenant da requisição.

### Todas as APIs validam o tenant no servidor?

**Sim — e não é por rota, é por construção.** O `db` que toda rota recebe é um **Proxy** sobre `AsyncLocalStorage`, e o resolvedor **lança erro** fora de contexto:

```js
function currentDb() {
  const s = getStore();
  if (!s || !s.db) {
    throw new Error('tenant-middleware: currentDb() chamado fora de contexto de tenant');
  }
  return s.db;
}
```

Nenhuma rota precisa lembrar de validar o tenant: **sem contexto, não há banco**. É a peça mais forte da arquitetura, e o teste C1 a protege.

### Como os 19 tenants são registrados

Tabela `tenants` no `control.db` (`slug`, `name`, `status`, `plan`, `db_path`). O middleware recusa tenant inexistente (**404**) e barra `SUSPENDED`/`CANCELLED`.

### Como um novo cliente e seu 1º usuário são criados

`tenant-provision.js` → `criarUsuarioInicial(db)`, que cria `admin` com senha `admin` e imprime um aviso para trocá-la.

> **Verifiquei se alguém deixou a senha inicial:** testei `bcrypt.compare('admin', hash)` em **todos os usuários ativos dos 19 tenants**. **Nenhum** está com ela. Isto agora é o teste F2.

### Host desconhecido

| Host | Resposta |
|---|---|
| `naoexiste.liciteagora.app` | **404** "Tenant não encontrado" |
| `evil.com` | **404** |
| `sub.dom.liciteagora.app` | **404** (sub-subdomínio recusado) |
| `liciteagora.app` (apex) | 200 — **landing page**, sem dado de tenant |

---

## 2. A causa concreta do que você viu

**O login abriu `produtosbomgosto` porque o endereço acessado era `produtosbomgosto.liciteagora.app`.** É o comportamento correto: cada cliente entra pelo seu próprio subdomínio, e é isso que garante o isolamento.

O que faltava — e aqui você está certo — é que **nada na tela dizia isso**. Nem antes do login, nem depois.

A topbar já mostrava o nome da empresa desde a Fase 3.3, mas só quando o **estabelecimento** está cadastrado: medido em 2026-09-11, **4 dos 13 tenants**. Nos outros 9 o espaço ficava em branco. E `produtosbomgosto` é justamente um dos que têm nome — o que torna a confusão ainda mais compreensível.

---

## 3. O que foi implementado

### `GET /api/tenant-atual`

```js
app.get('/api/tenant-atual', (req, res) => {
  ...
  res.json({ success: true, tenant: {
    slug: req.tenant.slug,
    nome: req.tenant.name || req.tenant.slug,
    status: req.tenant.status || null,
  }});
});
```

| Decisão | Motivo |
|---|---|
| Sai de `req.tenant` | populado pelo middleware **a partir do Host**. A rota **não aceita parâmetro nenhum** — não há como perguntar por outro tenant |
| Pública (antes do auth) | a tela de **login** precisa dela, e é ali que confirmar a empresa mais importa |
| Só `slug`, `nome`, `status` | nada de `db_path`, `owner_email`, `plan` ou dado de cobrança |

Os testes E1 e E2 travam as duas últimas: reprovam se a rota ler `req.query`/`req.body`/`req.params`/`req.headers`, ou se expuser campo do plano de controle.

### Na tela de login

Um bloco acima dos campos:

```
┌──────────────────────────────┐
│ VOCÊ ESTÁ ENTRANDO EM        │
│ Produtos Bom Gosto           │
└──────────────────────────────┘
```

Nasce oculto e aparece quando a resposta chega. Se a chamada falhar, o bloco fica escondido e **o login funciona igual**.

### Na topbar

O nome do tenant entrou como **fallback** do nome do estabelecimento:

1. `carregarEstabSwitcher` publica a razão social, quando cadastrada;
2. se não houver, `/api/tenant-atual` preenche com o nome do tenant.

A ordem importa: quem cadastrou a empresa continua vendo a razão social, que é mais precisa. O fallback só completa o que estava vazio — e o teste E4 reprova se ele passar a sobrescrever.

**Os 9 tenants que não tinham identificação passam a ter.**

---

## 4. Testes

`scripts/test-isolamento-tenant.js` — **20 testes, 20 OK**, ligado ao verify como **passo 13**.

| Bloco | Trava |
|---|---|
| A (3) | o tenant vem só do Host · host desconhecido não vira tenant · é recusado, não redirecionado |
| B (4) | **nenhum slug escrito no caminho de auth** · nenhuma variável de tenant padrão · `getTenantBySlug` não inventa · middleware recusa inexistente e suspenso |
| C (3) | **`currentDb` lança fora de contexto** · contexto por requisição · o `db` é o Proxy |
| D (4) | **cookie sem `domain`** · sessão no banco do tenant · usuário no banco do tenant · **não existe tabela global de usuários** |
| E (4) | identificação sai do contexto · devolve só 3 campos · login mostra a empresa · topbar tem fallback |
| F (2) | bancos distintos por tenant · **nenhuma senha inicial ativa** |

O B1 varre os seis arquivos do caminho de autenticação procurando **qualquer um dos 19 slugs** escritos à mão, com os comentários removidos antes — citar um tenant ao explicar algo não é fixá-lo.

### Provado por sabotagem

| Sabotagem | Reprovou |
|---|---|
| `domain: '.liciteagora.app'` no cookie | **D1** — *"passaria a valer em TODOS os subdomínios"* |
| `currentDb` devolvendo `null` em vez de lançar | **C1** — *"uma rota poderia ler o banco errado"* |
| `const _fallback = 'produtosbomgosto'` em `auth.js` | **B1** — *"o slug está escrito em auth.js"* |

### Regressão — zero falhas

`npm run verify` (7,3s, 13 passos) e **19 suítes, 510 asserções**.

**Uma premissa atualizada:** o teste E1 da Fase 3.3 exigia que a topbar fizesse **uma** requisição; agora faz **duas**. A segunda é `/api/tenant-atual`, e entrou justamente porque 9 tenants ficavam sem identificação. O limite continua o mesmo em espírito — rotas que já existem, uma chamada cada, na montagem, sem polling (os testes E3 e E4 seguem garantindo a ausência de laço).

---

## 5. Arquivos

**Criados** (2): `scripts/test-isolamento-tenant.js`; a rota em `server.js`.

**Alterados** (5):

| Arquivo | O quê |
|---|---|
| **`server.js`** | rota `GET /api/tenant-atual` |
| **`auth.js`** | libera a rota antes da barreira de autenticação |
| `public/auth/login.html` | bloco "Você está entrando em" |
| `public/js/sidebar.js` | fallback de identificação na topbar |
| `scripts/verify.js` · `scripts/test-fase33-topbar.js` | passo 13 · premissa E1 |

**Em negrito: exigem restart.** Nenhuma migração, nenhuma variável de ambiente, nenhuma alteração de dados.

---

## 6. Sobre o §2 do pedido — o que eu NÃO implementei, e por quê

Você pediu um login central: e-mail e senha, o servidor descobre as empresas, e uma tela "Escolha a empresa".

**Não implementei, e recomendo não fazer.** O motivo é que isso **troca um isolamento forte por um mais fraco**:

| | Hoje (subdomínio) | Login central |
|---|---|---|
| Onde o tenant é decidido | no **Host**, antes de qualquer código de negócio | numa consulta a uma tabela global |
| Usuários | um banco por tenant, sem espaço comum | **tabela global** — todos os clientes na mesma |
| Errar o tenant exige | mudar o middleware de contexto | um `WHERE` esquecido |
| Sessão de um tenant em outro | impossível (cookie por host) | **possível** — a sessão passa a valer no domínio todo |
| "tenantId vindo do navegador" | não existe conceito | é o que a tela de escolha manda |

Os três riscos que você listou — *nunca aceitar tenantId do navegador*, *nunca ter fallback*, *negar sem vínculo válido* — **já são impossíveis hoje**, por construção. Um login central os reintroduz como coisas a acertar na aplicação.

### Se ainda assim fizer sentido

Há um caso legítimo: **uma pessoa que atende mais de uma empresa** e hoje precisa de uma conta por subdomínio. Se for essa a dor, a solução de menor risco não é o login central — é um **seletor de empresas no apex** (`liciteagora.app`), que consulta um **vínculo explícito** pessoa↔tenant e **redireciona** para o subdomínio certo. O isolamento continua sendo o subdomínio; o que muda é só a porta de entrada.

Isso é uma fase própria, com schema novo (tabela de vínculos no `control.db`) e decisões suas. **Me diga se é esse o caso e eu desenho.**

---

## 7. O que executar no servidor

```
systemctl restart consulta-licitacoes.service
```

`server.js` e `auth.js` mudaram. Até o restart, `/api/tenant-atual` responde 404 e a identificação não aparece — nem no login, nem na topbar. O resto segue normal.

`liciteagora.service` não precisa.

---

## 8. Ressalvas

**O que eu não consegui testar:** não fiz login com senha real em dois tenants pelo navegador. Usei uma sessão **válida existente**, assinada com o `session_secret` real — o que prova o mecanismo de recusa cross-tenant, mas não é a mesma coisa que dois logins de verdade lado a lado. Se quiser a prova completa, ela leva dois minutos: abrir `1bit.liciteagora.app` e `produtosbomgosto.liciteagora.app` em janelas anônimas separadas e confirmar que cada uma mostra a sua empresa no topo.

**Um ponto que não é falha, mas incomoda:** o apex responde **200 com a landing page** para qualquer caminho, inclusive `/api/pedidos`. Não vaza nada — é HTML de marketing —, mas uma rota de API devolvendo página é confuso para quem depura. Não mexi: está fora do escopo e o comportamento é intencional do catch-all da landing.

**Sobre o relato original:** o sistema estava certo, e a leitura de que havia um "tenant padrão" era razoável diante do que a tela mostrava — que era nada. É por isso que a identificação visível não é cosmética: **ela é o que torna o isolamento verificável por quem usa.**
