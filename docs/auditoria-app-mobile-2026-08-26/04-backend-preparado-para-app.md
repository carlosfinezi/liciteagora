# Backend preparado para o app móvel de vendas

Data: 2026-08-26 · Caixa 4 — **primeira fase de implementação**.
Base: [`01`](01-pedido-ponta-a-ponta.md) · [`02`](02-acesso-dados-e-apis.md) ·
[`03`](03-arquitetura-mvp-e-roadmap.md).

**Nenhum commit foi feito.**

> ⚠️ **As mudanças JÁ ESTÃO NO AR — e não fui eu que as coloquei.**
>
> Eu não executei nenhum `systemctl`. Mas o `consulta-licitacoes.service` foi
> **parado às 17:01:21 e reiniciado às 17:05:25 por um comando externo a esta
> sessão** (journal: `Stopping consulta-licitacoes.service…`; `NRestarts=0`,
> logo não foi crash-loop). O processo novo (`MainPID=1433808`) leu os arquivos
> como estavam às 17:05:25 — e minhas últimas edições são de **17:02:42**.
>
> Portanto o código desta caixa está rodando em produção desde 17:05:28.
>
> Estado verificado logo depois: boot **sem nenhum erro**
> (`journalctl -p err` desde 17:05:25 → vazio), todas as rotas registradas,
> `/health` → 302, `/api/usuarios/me` no tenant `1bit` → 401 JSON. O serviço
> está saudável.
>
> Isso **antecipou** a revisão que você pediu para fazer antes. Se quiser voltar
> atrás, o caminho é reverter os arquivos e reiniciar — nada foi commitado e
> nada foi gravado em banco.

Nada foi alterado em: banco, schema, migration, nginx, `public/`, faturamento,
loja virtual, OS, marketplaces, PDV.

---

## 1. Arquivos alterados

| Arquivo | Situação | O que mudou nesta caixa |
|---|---|---|
| **`pedido-politicas.js`** | **novo** (185 linhas) | Fonte única de: preço do item, dono do pedido, escopo de listagem |
| `pedidos-routes.js` | alterado | Usa a política nos 5 pontos que gravam preço/vendedor; escopo + paginação na listagem; origem `app`; helper único de CFOP |
| `produtos-routes.js` | alterado | `POST /api/produtos/disponibilidade` |
| `reservas-routes.js` | alterado | `disponibilidadeDeItens()` extraída do handler e exportada |
| `auth.js` | alterado | `ehVendedor` no `SELECT` de `req.user`; ALTER de compat no bootstrap single-tenant |
| `auth-routes.js` | alterado | `_loginClientIp()` passa a usar `req.ip` |
| **`scripts/test-app-backend.js`** | **novo** | 31 testes cobrindo A–L |

**Segunda passada — 2026-09-10 (§4.1), três arquivos:**

| Arquivo | O que mudou |
|---|---|
| `pedido-politicas.js` | `precoDeItem()` ignora o `precoUnitario` do vendedor restrito, recusa item sem produto e recusa quando o resolver falha |
| `pedidos-routes.js` | `registrarDesconto()` passa a gravar `preco-manual-ignorado` (nenhuma rota tocada) |
| `scripts/test-app-backend.js` | bloco `P` (14 testes) + C/C2/D2/D3 migrados de ator |

**Aviso de leitura do `git diff`:** a árvore já tinha 271 entradas pendentes de
commit antes desta caixa. `git diff` compara com o HEAD, então mostra junto
alterações que **não são desta caixa** — por exemplo, o bloco `menuModo` em
`auth-routes.js` e boa parte das 240 linhas de `pedidos-routes.js`. O que é desta
caixa é exatamente o que está listado acima.

---

## 2. Princípio aplicado

Toda regra que, se decidida no cliente, poderia ser mentira, passou a ser
decidida no servidor. Nenhuma tabela nova, nenhuma segunda lógica comercial,
nenhum endpoint de escrita novo. O pedido continua sendo **o** pedido comercial.

---

## 3. Preço — comportamento anterior e novo

### Antes

Os três pontos que gravavam `precoUnitario` inseriam o número do corpo sem
comparar com nada (`pedidos-routes.js:361`, `:719`, `:744` — auditado em `01` §5.3):

```js
const qtd = Number(quantidade), pu = Number(precoUnitario);   // e vai para o INSERT
```

`resolverPreco()` existia (`precos-routes.js:127-165`) mas só era consultado
pela **tela**, para preencher o campo. `precoUnitario` era **obrigatório**.

### Agora

Fonte única: **`precoDeItem()`** em `pedido-politicas.js`. Chamada pelos três
pontos, mais o `POST /api/pedidos` com `itens[]`.

```
POST /api/pedidos/:id/itens { produtoId, descricao, quantidade, precoUnitario? }

  sem produtoId            → item livre (serviço, desconto de capa): aceita o informado
  precoUnitario ausente    → o SERVIDOR resolve  ← caminho do app
  precoUnitario presente   → comparado com o sugerido e com o piso do produto
```

> **Atualizado em 2026-09-10 (§4.1):** para o **vendedor restrito** o quadro
> acima não vale mais — o `precoUnitario` do corpo é ignorado em qualquer caso,
> e item sem `produtoId` é recusado. O quadro segue valendo para os demais
> atores.

Três garantias:

1. **`precoUnitario` deixou de ser obrigatório.** É a mudança central: quem não
   manda preço não tem como adulterá-lo. O app nunca manda.
2. **O contexto vem do PEDIDO, nunca do corpo.** `pessoaId` sai de
   `pedidos.clienteId` e `tabelaId` de `pedidos.tabelaPrecoId`. Se viessem do
   corpo, o cliente escolheria a tabela mais barata e a validação seria teatro.
3. **Desconto deixou de ser silencioso.** Preço abaixo do sugerido grava
   `audit_log` com `action='preco-abaixo-do-sugerido'`, `aplicado`, `sugerido`,
   `piso` e `fonte`.

### A política, e por que o padrão não bloqueia

`config.preco_politica` no tenant:

| Valor | Comportamento |
|---|---|
| ausente / `'auditar'` **(padrão)** | resolve quando não informado; aceita o informado; **registra** o que estiver abaixo do sugerido/piso |
| `'estrito'` | idem, e **recusa 422** abaixo do `precoMinimoVenda` para quem não pode furar |

O padrão não bloqueia porque **medi o dado antes de decidir**:

| Tenant | Itens | Com piso cadastrado | Abaixo do piso |
|---|---:|---:|---:|
| `produtosbomgosto` | 416 | 416 | **0** |
| `josecarloscostafilho` | 7 | 2 | 0 |
| `raeldouglas` | 4 | 0 | 0 |
| `jaagricola` | 1 | 0 | 0 |
| **`1bit`** | 22 | 8 | **4** |

Os 4 do `1bit` são todos o mesmo produto de teste (`SKU-001 / Produto Exemplo`,
preço 1,00 e 10,00 contra piso de 1.200,00), em rascunho/confirmado/cancelado.
Em cadastro real — `produtosbomgosto`, 416 itens, todos com piso — **a violação
é zero**.

Ligar `'estrito'` por padrão teria travado 4 de 8 itens históricos de um tenant.
Ligar por tenant, depois de sanear, é seguro e é o que recomendo para o piloto.

**Como ligar (quando você decidir):**
```sql
INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao)
VALUES ('preco_politica', 'estrito', CURRENT_TIMESTAMP);
```
*(escrita em `data/` — não executei, ver §11)*

---

## 4. Preço manual — a permissão que você pediu para eu não inventar

**Não existe hoje permissão de preço manual no sistema.** Confirmado em `02` §3.9:
o RBAC é por página, não por campo. Como você pediu para informar antes de
inventar regra nova, **não criei permissão nenhuma**. O que fiz foi reutilizar o
conceito que o sistema já tem:

```js
function podeFurarPiso(db, req) { return atorIrrestrito(db, req); }
```

`atorIrrestrito` = `admin`, ou chamada por X-Api-Key, ou usuário cujo `role` não
tem perfil cadastrado — o **mesmo fail-open** que `perfis-acesso.js:99-107` já
aplica ao sistema inteiro. Reproduzi, não inventei.

Consequência prática: **no modo padrão ninguém é bloqueado**, então o
comportamento de hoje da tela web está intacto — a única diferença é o registro
em `audit_log`. A permissão só passa a importar se você ligar `'estrito'`.

**Decisão que continua sua:** se quiser uma permissão granular de desconto
(ex.: "vendedor pode até 10%, gerente até 25%"), isso é regra nova e precisa da
sua definição. Não avancei.

---

## 4.1 Vendedor restrito não define preço manual — 2026-09-10

Última lacuna crítica da caixa 4, fechada em 2026-09-10 a pedido seu. Nenhuma
migration, nenhuma escrita em banco, `preco_politica` intocada.

### A regra anterior — e por que era lacuna

A caixa de agosto resolveu "quem não manda preço não tem como adulterá-lo".
Isso protege o app, que não manda. Não protege contra **um cliente que se diz
o app e manda mesmo assim**: bastava um `curl` com a sessão do vendedor e
`precoUnitario` no corpo para o número do corpo ir para o `INSERT`. No modo
padrão (`auditar`) ele passava com um registro em `audit_log`; no `estrito`,
passava igual acima do piso. A auditoria transformava o desconto em algo
**visível depois**, não em algo **impossível**.

### A regra nova

Para ator classificado como **vendedor restrito**, o `precoUnitario` do corpo
não tem autoridade nenhuma:

```
produtoId presente, com ou sem precoUnitario
  → preço = resolverPreco(produto, cliente do PEDIDO, tabela do PEDIDO)
  → o valor enviado, se diferente, vira audit_log e não vai para o INSERT

produtoId ausente (item avulso)
  → 422 "Item sem produto cadastrado não é permitido para vendedor."

resolverPreco indisponível (tenant sem `tabelas_preco`)
  → 422 "Não foi possível determinar o preço oficial do produto — item não gravado"
```

Desfecho, com o produto de teste a R$ 100,00 e piso R$ 80,00:

| Vendedor restrito envia | Gravado |
|---|---|
| nada | **100,00** |
| `precoUnitario: 150` | **100,00** |
| `precoUnitario: 90` | **100,00** |
| `precoUnitario: 10` (abaixo do piso) | **100,00** |
| `precoUnitario: -10` | **100,00** |

**O corpo não é recusado por existir** — é ignorado. A tela web
(`public/comercial/pedido.html:1711` e `:1757`) manda `precoUnitario` em todo
POST e em todo PUT de item, inclusive quando o valor é o próprio sugerido que
ela acabou de buscar do servidor. Um 403 nesse campo quebraria a tela para todo
vendedor restrito no instante em que isto subisse. É a mesma escolha já feita
para `vendedorId` (§5).

### Onde a regra mora

Em `pedido-politicas.js`, dentro de `precoDeItem()` — a fonte única que já
existia. **Nenhuma regra de preço foi duplicada** e nenhum endpoint ganhou
validação própria: o ator é classificado por `vendedorRestrito(db, req)`, que
também já existia, e o preço continua saindo de `resolverPreco`.

### Caminhos protegidos

Auditei **todos** os pontos que gravam em `pedido_itens`. Só três recebem preço
do corpo de um ator autenticado, e os três já passavam por `precoDeItem` — por
isso a mudança em um lugar fecha os três:

| Caminho | Onde | Como fica para o restrito |
|---|---|---|
| `POST /api/pedidos` com `itens[]` | `pedidos-routes.js:460` | preço resolvido; item avulso não entra e volta em `avisos[]` (o pedido é criado, o item não) |
| `POST /api/pedidos/:id/itens` | `pedidos-routes.js:839` | preço resolvido; item avulso → **422** |
| `PUT /api/pedidos/:id/itens/:itemId` | `pedidos-routes.js:882` | preço resolvido; editar só a quantidade preserva o preço gravado, como antes |

Os demais INSERTs em `pedido_itens` **não recebem preço do corpo** — conferido
um a um, nenhum é rota alternativa para o vendedor:

| Caminho | De onde vem o preço |
|---|---|
| `POST /api/pedidos/importar-participacao/:id` (`pedidos-routes.js:617`) | tabelas `itens` / `sniper_itens` / `valores_proposta` — o corpo só traz `clienteId`, `dataEntregaPrevista` e `modoDocumento` |
| Loja virtual (`loja-routes.js:344`) | carrinho do comprador, com preço resolvido no servidor; o ator é o cliente final, não o vendedor |
| Mercado Livre (`marketplaces-ml.js:304`) | `unit_price` da API do ML, via webhook |
| Faturamento de OS (`os-routes.js:2533`) | `os_pecas` / `os_servicos` da própria OS |

**O desconto de capa da OS não perdeu nada:** ele grava por `os-routes.js:2533`,
que não chama `precoDeItem`. Era o caso que justificava o item avulso com valor
negativo, e ele continua funcionando — sem precisar do item avulso do pedido.

### Quem é restrito e quem não é

Não criei permissão granular de preço, conforme sua instrução. Três faixas, todas
derivadas do que já existe em `perfis-acesso.js`:

| Faixa | Quem é | Preço manual | Item avulso | Piso (modo estrito) |
|---|---|---|---|---|
| **Vendedor restrito** — `vendedorRestrito()` | `req.user.ehVendedor = 1` **e** perfil cadastrado **sem** `comercial-metas`/`comissoes` | **ignorado** | **422** | não se aplica: nunca informa preço |
| **Faixa do meio** | perfil cadastrado com `ehVendedor = 0` (financeiro, compras), **ou** vendedor que administra metas/comissões | vale | permitido | **recusa 422** abaixo do piso |
| **Irrestrito** — `atorIrrestrito()` | `role = 'admin'`, chamada por `X-Api-Key` (sem `req.user`), ou usuário cujo `role` não tem perfil cadastrado (o fail-open de `perfis-acesso.js:99-107`) | vale | permitido | **fura o piso** |

A faixa do meio é o que **mantém a regra de piso viva** depois desta mudança.
Como `podeFurarPiso === atorIrrestrito`, se o único ator sujeito ao piso fosse o
vendedor restrito, o 422 do modo estrito nunca mais dispararia — a regra ficaria
escrita e morta. Não fica: é essa faixa que o teste `P-H` exercita.

### Interação com `preco_politica`

A política **continua controlando piso e auditoria**, e não foi tocada. O que
mudou é que ela deixou de ser o que decide se o vendedor restrito escolhe preço
— ele não escolhe em nenhum dos dois modos.

| Modo | Vendedor restrito | Faixa do meio | Irrestrito |
|---|---|---|---|
| `auditar` (padrão) | preço do servidor; envio divergente vira `preco-manual-ignorado` | informa; abaixo do sugerido/piso vira `preco-abaixo-do-sugerido` | informa; mesmo registro |
| `estrito` | **idêntico ao `auditar`** — não há preço dele para recusar | informa; abaixo do piso → **422** | informa; fura o piso |

Consequência prática: **ligar `'estrito'` num tenant ficou menos arriscado do que
era em agosto.** O vendedor restrito não produz mais violação de piso, então o
modo estrito passa a recair só sobre quem realmente digita preço.

### Auditoria

Ação nova, `preco-manual-ignorado` (ver §16). Não é erro nem alerta: é o rastro
de que houve tentativa. Entrou no `registrarDesconto()` que já era chamado nos
três caminhos — nenhuma estrutura nova por causa do log.

---

## 5. `vendedorId`

### Antes

```js
const vendedor = vendedorId != null ? (Number(vendedorId) || null) : (req.session?.userId || null);
```

O corpo vencia a sessão, sem nenhuma validação. Um JSON bastava para lançar a
venda — e a comissão — na conta de outra pessoa.

### Agora — `resolverVendedor()`

| Ator | `vendedorId` no corpo | Resultado |
|---|---|---|
| Sem sessão (X-Api-Key) | qualquer | **aceito** — comportamento antigo intacto |
| Qualquer um | ausente | `req.session.userId` |
| Qualquer um | = o próprio | aceito |
| Pode delegar | de outro | aceito |
| **Não pode delegar** | de outro | **ignorado**, vale a sessão, e grava `audit_log` |

**Por que ignorar e não recusar:** a tela web **sempre** envia `vendedorId` no
`PUT` (`pedido.html:1515`), mesmo quando é o próprio usuário. Um 403 quebraria a
tela para todo perfil restrito no instante em que isto subisse. Ignorar converge
para o valor certo sem regressão visível.

**Quem pode delegar:** `admin`, ator irrestrito, ou perfil que tenha a página
`comercial-metas` ou `comissoes` — quem administra meta e comissão é quem
legitimamente reatribui venda. Sai do cadastro de perfis que já existe.

### Os quatro pontos cobertos

Deixar um de fora tornaria a regra decorativa — o vendedor usaria o caminho
descoberto:

1. `POST /api/pedidos` (`pedidos-routes.js:387`)
2. `PUT /api/pedidos/:id` (via `CAMPOS_PEDIDO`)
3. `POST /api/pedidos/acao-massa` com `acao:'vendedor'` → **403 explícito** aqui, porque a ação *só* existe para delegar: ignorar o campo a esvaziaria
4. `POST /api/pedidos/importar-participacao/:id`

---

## 6. Origem do pedido

`pedidos.tipo` ganha o valor **`'app'`**, sem constraint nova (a coluna nunca teve
CHECK — `01` §8.1).

```js
const ORIGENS_CLIENTE = ['manual', 'app'];
const origem = ORIGENS_CLIENTE.includes(req.body?.origem) ? req.body.origem : 'manual';
```

- O cliente só pode declarar `manual` ou `app`.
- `licitacao`, `os` e `marketplace` **continuam sendo gravados apenas pelos caminhos internos** que os produzem. Enviar `origem:'licitacao'` cai em `manual` — testado (A3).
- Tela web: continua `manual` (não envia `origem`).
- **Nenhum ajuste de constraint foi necessário.**

---

## 7. Meus pedidos — escopo e paginação

### `GET /api/pedidos`

```
?meus=1              recorte pelo próprio usuário
?page=1&limit=20     paginação (limit teto 200); aceita ?offset= como alternativa
```

**Escopo — `escopoVendedor()`:**

| Ator | Vê |
|---|---|
| Vendedor restrito (`ehVendedor=1` e não pode delegar) | **só os próprios, sempre** — não depende de mandar `meus=1` |
| Qualquer um com `meus=1` | os próprios |
| Pode delegar / admin | todos; `?vendedorId=N` filtra |
| Sem sessão (X-Api-Key) | todos — comportamento antigo |

**`vendedorId` na query nunca amplia acesso** — só é honrado para quem já
enxergava todos (testado em H2).

**Compatibilidade:** sem `page`/`limit`, a resposta continua sendo a lista
inteira, como sempre foi (testado em H5). A tela de pedidos e a de metas dependem
disso. Quando paginado, a resposta ganha `total`, `page`, `limit`. Em ambos os
casos vem `escopo` (`proprio` | `filtrado` | `todos`).

### `GET /api/pedidos/resumo` — também recortado

Não estava na sua lista, mas ficaria incoerente: o vendedor restrito veria, nos
KPIs, o faturamento da empresa inteira que a lista lhe esconde. Mesmo escopo
aplicado (testado em H3).

---

## 8. Disponibilidade mínima

**`POST /api/produtos/disponibilidade`** — `produtos-routes.js`

```
{ "itens": [ { "produtoId": 1, "quantidade": 3 } ] }        (máx. 200 itens)

{ "success": true, "tudoDisponivel": true,
  "itens": [ { "produtoId":1, "sku":"SKU-A", "descricao":"...", "unidade":"UN",
               "saldo":10, "reservado":0, "disponivel":10,
               "suficiente":true, "faltando":0 } ] }
```

**Não expõe:** custo médio, valorização, CMV, ABC, movimentações, nem qualquer
função de escrita.

**Sem lógica duplicada:** o cálculo saiu do handler de
`/api/estoque/verificar-disponibilidade` e virou `disponibilidadeDeItens()` em
`reservas-routes.js`, exportada e chamada pelas **duas** rotas. É a mesma conta
que `criarReservasPedido` faz ao confirmar — então o que o app mostra e o que a
confirmação decide não se contradizem.

---

## 9. RBAC — por que a rota nasceu em `/api/produtos`

O gate casa por **prefixo** (`perfis-acesso.js:152`: `'/api/' + path.split('/')[2]`).

- `/api/estoque` exige páginas de estoque (`perfis-api-map.js:92`) — que um perfil comercial não tem. Liberar aquele prefixo traria junto extrato, valorização, ABC, CMV e `POST /api/estoque/movimentacoes`.
- `/api/produtos` **já inclui a página `pedidos`** (`perfis-api-map.js:161`).

Resultado: **zero alteração em `perfis-api-map.js`**. O vendedor ganha
exatamente uma capacidade nova.

Verificado no teste G, com perfil restrito real:

| Rota | Perfil vendedor |
|---|---|
| `/api/produtos/disponibilidade` | ✅ passa |
| `/api/estoque/verificar-disponibilidade` | ❌ 403 |
| `/api/estoque/valorizacao` | ❌ 403 |
| `/api/pedidos`, `/api/precos/resolver` | ✅ passa |

---

## 10. Autenticação e sessão

**Nada mudou** por decisão: sem JWT, sem X-Api-Key para vendedores.
`POST /api/login`, cookie `liciteagora.sid`, `requireAuth`, logout e tenant por
Host seguem idênticos.

Única alteração em `auth.js`: `ehVendedor` entrou no `SELECT` de `req.user`
(`SQL_GET_USER`), porque o recorte de "meus pedidos" e a recusa de assumir venda
alheia precisam desse dado a cada request. Verifiquei que a coluna existe nos
**12 tenants** antes de mexer; e acrescentei o `ALTER` correspondente ao
bootstrap single-tenant (`criarUsuarioInicial`), que não roda `initSchema` e
ficaria com o `SELECT` quebrado em dev.

Efeito colateral desejado: **`GET /api/usuarios/me` passa a devolver
`ehVendedor`** — era o item 4 da matriz de `03` §14.

### Sessão de 7 dias — comportamento final documentado

Não mexi (você pediu para propor antes). Comportamento que o app deve assumir:

- expira **7 dias após o login**, não após o último uso — não há `touch` no store (`auth.js:80-107`) nem `rolling`;
- reinício do serviço **não desloga** (a sessão está no SQLite do tenant);
- `users.ativo = 0` derruba na requisição seguinte (`auth.js:311-317`);
- o app deve tratar **401 como "relogar"**, preservando o carrinho.

**Proposta, não aplicada:** implementar `touch` no `SqliteSessionStore` +
`rolling: true` renovaria a sessão por uso. São ~10 linhas, mas mudam o
comportamento de sessão de **todos** os usuários web — por isso não fiz sem sua
decisão.

### Validação de empresa pelo app (item 12)

Comportamento **inalterado e reconfirmado ao vivo** nesta caixa:

| Host | `GET /api/usuarios/me` |
|---|---|
| tenant válido, sem login | **401** `application/json` |
| tenant inexistente | **404** `text/html` ("Tenant não encontrado") |
| tenant suspenso | **402** (lido em `tenant-middleware.js:189-191`; não testado) |

**Nenhum endpoint novo** foi criado, e nenhum endpoint enumera empresas.

---

## 11. Perfil piloto — o que configurar (NÃO aplicado)

**Não apliquei, e o motivo é regra sua:** criar o perfil é escrita em
`data/tenants/1bit/pncp.db`, e mexer nos DBs de `data/` exige sua autorização
explícita (CLAUDE.md, "Nunca faça sem perguntar").

O que precisa ser feito, exatamente:

```sql
-- tenant 1bit (data/tenants/1bit/pncp.db)
INSERT INTO perfis_acesso (slug, nome, descricao, paginas, ativo) VALUES (
  'comercial',
  'Vendedor (app)',
  'Perfil restrito do vendedor de campo — piloto do app móvel',
  '["pedidos","pessoas","produtos","comercial-tabelas-preco","meu-perfil"]',
  1
);
```

Pelo caminho da tela: **Configurações → Perfis de acesso → Novo**, slug
`comercial`, marcando apenas essas páginas.

**Por que cada página está na lista** (nenhuma é arbitrária — todas saem da
matriz de `02` §9 e do mapa `perfis-api-map.js`):

| Página | Libera | Necessária para |
|---|---|---|
| `pedidos` | `/api/pedidos`, `/api/precos`, `/api/produtos`, `/api/pessoas`, `/api/tipos-operacao`, `/api/depositos`, `/api/politicas-prazo`, `/api/adquirentes`, `/api/cnpj` | criar pedido, item, confirmar, preço, disponibilidade |
| `pessoas` | `/api/pessoas` | buscar e criar cliente |
| `produtos` | `/api/produtos` | buscar produto |
| `comercial-tabelas-preco` | `/api/tabelas-preco` | ver a tabela aplicada (opcional) |
| `meu-perfil` | `/api/usuarios/me`, trocar senha | identidade |

**Deliberadamente fora:** administração, `estoque*` (avançado), financeiro,
fiscal, configurações, `comercial-metas` e `comissoes` — estas duas últimas
porque **são o que dá o direito de delegar `vendedorId`** (§5). Um perfil de
vendedor com elas anularia a regra.

⚠️ **Atenção que vale repetir:** hoje `perfis_acesso` do `1bit` está **vazio**, e
o RBAC é fail-open — o `guilherme` é irrestrito. Sem criar este perfil, o piloto
validaria um cenário que nenhum cliente com RBAC vive, e os 403 apareceriam só no
primeiro cliente real.

---

## 12. Rate limit do login

### Revalidação da topologia (feita antes de editar)

| Peça | Estado |
|---|---|
| `app.set('trust proxy', 1)` | `server.js:8` ✅ |
| vhost do tenant | `/etc/nginx/conf.d/domains/1bit.liciteagora.app.ssl.conf:37` — `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for` (**anexa**) |
| idem | `:36` — `proxy_set_header X-Real-IP $remote_addr` (**sobrescreve**, confiável) |
| Cloudflare | `/etc/nginx/conf.d/cloudflare.inc` existe mas **nenhum vhost de tenant o inclui**; nenhum `real_ip` nos vhosts |
| Cadeia efetiva | cliente → nginx → node (**um** salto) |

### Correção aplicada

```js
// antes
const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
return fwd || req.ip || ...;
// agora
return req.ip || req.socket?.remoteAddress || 'unknown';
```

Com `trust proxy = 1`, o Express monta `[...XFF, socketAddr]`, descarta um salto
à direita e devolve o endereço que **o nginx acrescentou** — o real. Como o nginx
sempre acrescenta, o cliente não consegue empurrar esse valor.

**Nenhuma alteração em nginx foi necessária**, portanto `nginx -t` e reload não
foram executados — não havia o que testar nem recarregar. Isso é deliberado: a
correção mínima segura era de código.

**Se o Cloudflare entrar na frente**, `trust proxy` precisa virar `2` **ou** o
vhost precisa incluir `cloudflare.inc` com `set_real_ip_from`. Registrado como
decisão de infraestrutura futura — não fiz.

**Não implementado (proposta):** limite por `username` além do IP, e estado fora
da memória do processo (hoje o `Map` zera a cada restart).

---

## 13. CFOP e defaults fiscais

### Antes

Itens criados no `POST /api/pedidos` com `itens[]` nasciam com `cfop = NULL`
(`01` §7.5); só o `POST /:id/itens` chamava `sugerirCFOP`.

### Agora

Helper único no módulo — **`cfopDoItem(pedido, produtoId)`** — usado pelos
**dois** caminhos. Não há regra fiscal duplicada: ele apenas chama
`sugerirCFOP()` (`tipos-operacao-routes.js:295`), que continua sendo o único
motor fiscal.

Testado (J1/J2): item criado pelos dois caminhos nasce com o **mesmo** CFOP
(`5102` no cenário de venda interna).

**O app não envia regra fiscal** — nem `cfop`, nem NCM, nem CST. NCM, unidade e
origem continuam saindo do cadastro do produto no faturamento
(`faturas-routes.js:167`, `:233-236`), sem mudança.

**Ordem que o app deve seguir** (não mudou): `POST /api/pedidos` → `PUT` (com
`tipoOperacaoId` e `clienteId`) → `POST /itens`. O motor lê o tipo de operação
**do pedido**; adicionar item antes do `PUT` faz o CFOP sair pelo tipo padrão.

---

## 14. Criação em etapas e transação

Mantido como está (`03` §8.2): criar → itens → confirmar. **Nenhuma transação
nova.** A parte crítica continua atômica e intocada: `confirmarPedidoInterno`
(`pedidos-routes.js`) segue reservando estoque e mudando status dentro de
`db.transaction()`, com rollback e 409 quando falta saldo (testado em E e L).

---

## 15. Idempotência — avaliado, não implementado

Como você pediu: **não criei migration.**

Hoje não existe nenhuma proteção contra duplicidade (`02` §10, risco 11).
Implementar `clientRequestId` exige coluna nova em `pedidos` + índice UNIQUE
parcial — mudança estrutural, portanto fora desta caixa por instrução.

**Paliativo disponível para o app agora, sem backend:** gerar o UUID no app, e em
timeout **consultar** (`GET /api/pedidos?meus=1&limit=5`) antes de reenviar. A
proposta completa está em `03` §18.3.

---

## 16. Auditoria

`logAction` continua exigindo `req.user` (`audit-log.js:19`) — e é justamente por
isso que o app **usa sessão e não X-Api-Key**: com sessão, `req.user` existe e
toda ação sai com autor real.

Duas ações novas passam a ser registradas:

| `action` | Quando | Payload |
|---|---|---|
| `preco-abaixo-do-sugerido` | item gravado abaixo do preço resolvido | `produtoId, aplicado, sugerido, piso, fonte, abaixoDoPiso` |
| `vendedor-ignorado` | tentativa de assumir venda alheia sem permissão | `enviado, aplicado` |
| `preco-manual-ignorado` *(2026-09-10, §4.1)* | vendedor restrito mandou `precoUnitario` diferente do resolvido | `produtoId, enviado, aplicado, fonte, piso` |

Testado (M): o log sai com `userId=10`, `username='vend1'` — o usuário real.

---

## 17. Testes

`node scripts/test-app-backend.js` — **45 testes, 45 OK, 0 falhas**
(31 da caixa de agosto + 14 do bloco `P`, de 2026-09-10).

Pré-requisito: `sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/app-backend-schema.sql`

| # | Teste | Resultado |
|---|---|---|
| A | vendedor cria pedido em seu nome | ✅ |
| A2 | `origem:'app'` → `tipo='app'` | ✅ |
| A3 | origem forjada (`licitacao`) cai em `manual` | ✅ |
| B | `vendedorId` de outro no POST → ignorado | ✅ |
| B2 | idem no PUT | ✅ |
| B3 | idem em `acao-massa` → **403** | ✅ |
| B4 | **admin ainda delega** (tela web intacta) | ✅ |
| B5 | **X-Api-Key mantém comportamento antigo** | ✅ |
| C | preço adulterado → registrado em `audit_log` | ✅ |
| C2 | política `estrito` → **422** abaixo do piso | ✅ |
| C3 | política `estrito` → admin ainda fura o piso | ✅ |
| D | **preço omitido → servidor resolve** (caminho do app) | ✅ |
| D2 | preço acima da tabela passa sem registro | ✅ |
| D3 | item sem produto com preço negativo continua passando **para ator irrestrito** | ✅ |
| D4 | itens no `POST /api/pedidos` também passam pela política | ✅ |

**C, C2 e D2 mudaram de ator em 2026-09-10:** rodavam com o vendedor restrito, e
depois de §4.1 ele não produz mais desconto nenhum para auditar ou recusar. Foram
para o `GERENTE` (a faixa do meio), que é quem hoje informa preço e responde ao
piso. `D3` foi para o `ADMIN`. **Nenhum dos três perdeu o que provava** — provam
o mesmo, com o ator que ainda exerce o comportamento.

### Bloco `P` — vendedor restrito não define preço (§4.1)

| # | Teste | Resultado |
|---|---|---|
| P-A | restrito **sem** `precoUnitario` → preço oficial (100) | ✅ |
| P-B | restrito envia **150** → gravado 100 + `preco-manual-ignorado` | ✅ |
| P-C | restrito envia **90** (entre sugerido e piso) → gravado 100 | ✅ |
| P-D | restrito envia **10** (abaixo do piso) → gravado 100, **sem 422** | ✅ |
| P-E | restrito envia **−10** → gravado 100 | ✅ |
| P-F | **ator irrestrito mantém o preço manual** (150 grava 150) | ✅ |
| P-G | modo `auditar` não devolve autoridade de preço ao restrito | ✅ |
| P-H | modo `estrito`: restrito segue a 100 **e** o piso segue recusando (422) quem informa | ✅ |
| P-I | restrito com item avulso → **422** com a mensagem de produto obrigatório | ✅ |
| P-J | restrito com item avulso **negativo** → 422 e **o total do pedido não cai** | ✅ |
| P-K | `PUT` de item: preço do restrito também é ignorado | ✅ |
| P-L | `POST /api/pedidos` com `itens[]`: preço do restrito também é ignorado | ✅ |
| P-M | `POST /api/pedidos`: item avulso do restrito não entra, vira `avisos[]` | ✅ |
| P-N | `resolverPreco` indisponível não vira bypass do restrito (e **não muda** o irrestrito) | ✅ |

**A suíte discrimina de verdade:** `P-B` e `P-F` mandam o mesmo corpo
(`precoUnitario: 150`) e esperam resultados opostos — 100 para o restrito, 150
para o irrestrito. Se a regra não existisse, os dois gravariam 150 e `P-B`
reprovaria. `P-N` faz o mesmo par no caminho do resolver indisponível.
| E | sem saldo → **409 com `insuficiencias`** | ✅ |
| F | disponibilidade mínima responde e **não vaza custo** | ✅ |
| G | RBAC: alcança `/api/produtos`, **403 em `/api/estoque`** | ✅ |
| H | vendedor vê **só os próprios** | ✅ |
| H2 | `?vendedorId=` na query **não amplia** | ✅ |
| H3 | `/resumo` respeita o escopo | ✅ |
| H4 | paginação com `total` e página 2 correta | ✅ |
| H5 | **sem `page`/`limit` a lista segue completa** (compat) | ✅ |
| I | perfil superior mantém acesso amplo e filtro | ✅ |
| J1 | item por `/itens` nasce com CFOP | ✅ |
| J2 | item no `POST /api/pedidos` nasce com o **mesmo** CFOP | ✅ |
| J3 | **tenant A × tenant B: 404 e lista vazia** | ✅ |
| K | pedido do app na listagem comum, numeração `PED-2026-NNNNN` | ✅ |
| L | pedido do app confirma, **reserva estoque**, total correto | ✅ |
| M | `audit_log` com o usuário real | ✅ |
| N | unitários de `vendedorRestrito` / `podeDelegarVendedor` | ✅ |

### Não-regressão

`npm run verify` → **OK: sintaxe válida** (todos os `.js` da raiz e de `scripts/`).

Suítes existentes que tocam pedidos:

| Suíte | Resultado |
|---|---|
| `test-reservas-pedido` | 11 OK, 0 falhas |
| `test-metas-bi` | 21 OK, 0 falhas |
| `test-deposito-movimentacao` | 14 OK, 0 falhas |
| `test-venda-perdida-pedido` | 16 OK, 0 falhas |
| `test-cartao-recebiveis` | 12 OK, **1 falha pré-existente** |
| `test-comissoes` | **crash pré-existente** |

**As duas falhas têm a mesma causa e são anteriores a esta caixa:**
`no such table: fornecedores`. A tabela foi unificada em `pessoas` em 2026-08-20
e os dois testes ainda a usam no seed. Não corrigi — está fora do escopo desta
caixa e mexer em teste alheio sem pedido seria ruído.

**Reexecução em 2026-09-10**, depois de §4.1 — `npm run verify` → `OK: sintaxe
válida`:

| Suíte | Resultado |
|---|---|
| `test-app-backend` | **45 OK, 0 falhas** |
| `test-reservas-pedido` | 11 OK, 0 falhas |
| `test-venda-perdida-pedido` | 16 OK, 0 falhas |
| `test-metas-bi` | 21 OK, 0 falhas |
| `test-deposito-movimentacao` | 14 OK, 0 falhas |
| `test-devolucao-venda-espelho` | 17 OK, 0 falhas |
| `test-devolucoes-credito-metas-comissao` | 22 OK, 0 falhas |
| `test-devolucoes-custo-saldo-estorno` | 22 OK, 0 falhas |
| `test-comissoes` | **crash pré-existente** — `no such table: fornecedores`, no seed |
| `test-pedido-compra` | **crash pré-existente** — falta `/tmp/vp-pcompra-schema.sql` |

As duas que quebram param no seed, antes de qualquer linha de preço, e são as
mesmas de agosto. Nenhuma suíte regrediu.

---

## 18. Riscos restantes

| Risco | Estado | Onde resolver |
|---|---|---|
| **O código já está em produção sem sua revisão** | restart externo às 17:05:25 antecipou o deploy; boot limpo, serviço saudável | sua revisão agora — reverter é possível (sem commit, sem escrita em banco) |
| **Perfil piloto não criado** | escrita em `data/` exige sua autorização | §11 |
| ~~**Preço só audita, não bloqueia**~~ | **fechado em 2026-09-10 para o vendedor restrito** (§4.1): o preço dele é sempre do servidor, nos dois modos. Para a faixa do meio e para o irrestrito o quadro é o de antes | `preco_politica='estrito'` segue sendo sua decisão + saneamento de `precoMinimoVenda` |
| **Sem permissão granular de desconto** | não existe no sistema; não inventei | sua definição |
| **`.js` alterado em 2026-09-10 ainda não recarregado** | `pedido-politicas.js` e `pedidos-routes.js` são lidos pelo `server.js`; o processo em memória segue com a versão anterior | `systemctl restart consulta-licitacoes.service`, quando você pedir |
| **Idempotência ausente** | exige coluna + índice | próxima caixa |
| **Sessão sem renovação por uso** | 7 dias a partir do login | proposta em §10 |
| **Rate limit só por IP** | corrigido o IP; falta limite por conta | próxima caixa |
| **Corrida de numeração** | não existe hoje (processo único, `better-sqlite3` síncrono), mas é frágil | `03` §7.3 |
| **`vendedorId` sem FK nem validação de `ehVendedor`** | dívida anterior; delegação por admin pode apontar para usuário inativo | próxima caixa |
| **Reserva não expira** | pedido confirmado e abandonado segura estoque | dívida anterior |
| **`GET /api/produtos` sem paginação** | o app não deve usá-lo sem `q` | `02` §6.4 |

---

## 19. O que NÃO foi feito, por instrução

App React Native, telas, APK, push, câmera, offline, biometria · JWT ·
X-Api-Key para vendedores · migration · alteração de nginx · alteração do
faturamento · tabela paralela de pedidos · segunda lógica comercial · commit.
