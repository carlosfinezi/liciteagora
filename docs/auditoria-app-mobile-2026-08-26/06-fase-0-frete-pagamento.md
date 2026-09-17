# Fase 0 — frete negativo e sincronização de pagamento

Data: 2026-09-10 · Primeira fase de implementação do projeto
**Catálogo Online + Pedidos PDV**.
Base: [`05`](05-catalogo-pdv-encaixe-erp.md) §C.6, §M.2, §T-3, §T-16 e §V (Fase 0).

> **Nenhum commit.** Nenhum serviço reiniciado. Nenhuma migration. Nenhuma
> escrita no banco de produção — todas as consultas a `data/` foram `SELECT`.

Escopo: **só os dois bloqueadores** confirmados no relatório 05. Nada de
catálogo, PDV, desconto, alçada, checkout anônimo, personalização, cupom,
upload, gateway ou PDV/NFC-e.

---

## 1. Arquivos alterados

| Arquivo | Situação | O que mudou |
|---|---|---|
| `pedidos-routes.js` | alterado | `erroValorFrete()` (nova) · `recalcularTotal()` · `PUT /api/pedidos/:id` · `module.exports` |
| `contas-receber-routes.js` | alterado | `sincronizarPagamentoPedido()` |
| `scripts/test-app-backend.js` | alterado | bloco `FR` — 7 testes de frete |
| **`scripts/test-fase0-pagamento-pedido.js`** | **novo** | 15 testes de sincronização de pagamento |
| **`docs/.../06-fase-0-frete-pagamento.md`** | **novo** | este relatório |

**Cinco arquivos, nada mais.** A árvore de trabalho tinha 160 entradas
modificadas antes desta tarefa; o §8 separa o que é meu do que já estava lá.

---

## 2. Parte A — frete negativo

### 2.1 Auditoria: todos os caminhos que escrevem `pedidos.valorFrete`

Varri o repositório inteiro. O resultado é mais simples do que o esperado:

| Caminho | Escreve `pedidos.valorFrete`? |
|---|---|
| `PUT /api/pedidos/:id` (`pedidos-routes.js:719`, via `CAMPOS_PEDIDO:67`) | **SIM — e é o único** |
| `POST /api/pedidos` (`:466`) | não — a coluna não está no INSERT |
| `POST /api/pedidos/importar-participacao/:id` (`:636`) | não |
| Loja virtual (`loja-routes.js:340`) | não |
| Marketplaces / ML (`marketplaces-routes.js:153`, `marketplaces-ml.js:300`) | não — `valorFrete` deles é de `marketplaces_pedidos`, outra tabela |
| Faturamento de OS (`os-routes.js:2526`) | não |
| `acao-massa`, `converter-modo`, ações de status | não — só `vendedorId`, `status`, `numero` |

`CAMPOS_PEDIDO` é usado em **um lugar só** (`pedidos-routes.js:711`), conferido
por grep. Ou seja: uma validação no PUT fecha o campo inteiro.

Os outros `valorFrete` do repositório (faturas, NF-e de entrada, devoluções,
patrimônio, espelho fiscal) são de **outras tabelas** e não afetam o total do
pedido.

### 2.2 Existe uso legítimo de frete negativo?

**Não.** Contei em todos os 13 tenants:

| Tenant | `valorFrete < 0` | `valorFrete <> 0` |
|---|---:|---:|
| `1bit` | **0** | 4 |
| os outros 12 | **0** | 0 |

Zero ocorrências em 100% da base. Como você preferiu na regra 3 do pedido, apliquei
a **invariável global `valorFrete >= 0`**, sem exceção por perfil. Não há fluxo
legítimo para preservar, e uma exceção para admin manteria aberta a porta que a
fase existe para fechar.

### 2.3 Comportamento anterior

```js
// recalcularTotal, pedidos-routes.js:110 (antes)
const total = row.total + (Number(ped && ped.valorFrete) || 0);
```

`valorFrete` entrava no total **com sinal**, e era gravável pelo PUT sem
validação nenhuma. Qualquer usuário que alcançasse o pedido — inclusive o
vendedor restrito — mandava `{"valorFrete": -500}` e derrubava o total. Era o
desconto sem alçada e sem registro que sobrou depois da trava de preço de
2026-09-10.

### 2.4 Comportamento novo

**Função nova** `erroValorFrete(valor)` (`pedidos-routes.js:106-127`):

| Entrada | Resultado |
|---|---|
| ausente / `null` / `''` | aceito (campo é opcional; não mexe no que está gravado) |
| `30`, `0`, `"30"` | aceito |
| `-50`, `"-50"` | **erro** — `valorFrete nao pode ser negativo — frete nao e desconto` |
| `"abc"`, `NaN`, `Infinity` | **erro** — `valorFrete invalido` |

**No `PUT /api/pedidos/:id`** (`pedidos-routes.js:672-675`): validação logo após
`const b = req.body`, antes de qualquer escrita → **422** com a mensagem.

**Recusa, não conversão silenciosa**, exatamente como você pediu: transformar em
zero esconderia de quem enviou que o valor não foi aplicado. Note que essa é a
escolha **oposta** à do `vendedorId` e à do `precoUnitario`, que são ignorados em
silêncio — e a diferença tem motivo: a tela web sempre envia aqueles dois campos,
enquanto `valorFrete` negativo nenhuma tela envia.

**Guarda em `recalcularTotal`** (`pedidos-routes.js:136`):

```js
const frete = Math.max(0, Number(ped && ped.valorFrete) || 0);
```

Isto **não** é conversão silenciosa de entrada — é guarda contra estado que não
deveria existir. Se um negativo chegar ao banco por um caminho que ainda não
existe (uma importação futura, um `UPDATE` manual), ele não reduz o total por
baixo do pano. Como não há nenhum registro negativo em produção, a guarda não
altera nenhum total existente.

`erroValorFrete` foi exportada (`module.exports`) para o Catálogo Online usar a
mesma regra quando chegar a hora — sem reimplementar uma versão divergente.

### 2.5 Outros bypasses monetários — auditados, **não corrigidos**

Você pediu para informar, não implementar. Aqui está.

#### 🔴 **QUANTIDADE NEGATIVA — bypass confirmado, idêntico ao do frete**

`POST /api/pedidos/:id/itens` valida assim (`pedidos-routes.js:855`):

```js
if (!descricao || !quantidade) { ... }     // -1 é truthy: passa
```

**Reproduzi em banco descartável**, com um vendedor restrito:

```
item 1: quantidade  2 × R$ 100 = R$  200
item 2: quantidade -1 × R$ 100 = R$ -100     ← status 200, sem erro
valorTotal do pedido: R$ 100      (seriam R$ 200)
```

O preço unitário é o **oficial** (R$ 100, resolvido pelo servidor), então a
trava de preço de 10/09 não o alcança: o que é adulterado é a quantidade. O
efeito no total é o mesmo do frete negativo.

Vale nos três caminhos de item (`POST /api/pedidos` com `itens[]`,
`POST /api/pedidos/:id/itens`, `PUT .../:itemId`) e também bagunça estoque:
`criarReservasPedido` receberia quantidade negativa.

**Recomendo fortemente incluir na próxima fase** — fechar frete e deixar
quantidade aberta resolve metade do problema.

#### Outros campos do pedido, auditados

| Campo | Pode reduzir o total? |
|---|---|
| `precoUnitario` | fechado para vendedor restrito em 10/09; ator irrestrito ainda define (por desenho) |
| item avulso com preço negativo | fechado para vendedor restrito em 10/09; irrestrito ainda pode |
| `valorFrete` | **fechado nesta fase** |
| `quantidade` | **ABERTO** — acima |
| desconto de item / de pedido | não existe coluna (relatório 05 §C.1) |
| acréscimo | não existe coluna |
| `valorTotal` do pedido | não é gravável pelo cliente: `recalcularTotal` sempre recalcula do banco |
| `valorPago` | `POST /api/pedidos/:id/registrar-pagamento` (`:1390`) soma direto, sem CR e sem movimentação financeira — ver §3.6 |

---

## 3. Parte B — sincronização de pagamento

### 3.1 Auditoria

**Onde a função é chamada** (todos em `contas-receber-routes.js`, e todos já
estavam certos — o defeito era só dentro da função):

| Chamador | Linha | Evento |
|---|---|---|
| `registrarBaixaCR` | `:232` | baixa (total ou parcial), inclusive a do webhook de boleto/Pix |
| `estornarBaixaCR` | `:295` | estorno de baixa |
| compensação de crédito | `:552` | crédito aplicado no título |
| `POST /api/contas-a-receber/:id/cancelar` | `:1042` | cancelamento de CR |
| `POST /api/contas-a-receber/:id/reabrir` | `:1053` | reabertura |
| `faturas-routes.js:355` | — | faturamento |

**Como uma CR chega ao pedido** — dois vínculos, e só um era enxergado:

1. `contas_a_receber.faturaId` → `faturas.pedidoId` — venda faturada.
2. `contas_a_receber.pedidoId` — vínculo direto, usado pela **loja virtual**
   (`loja-routes.js:155`) **e pelo faturamento de OS** (`os-routes.js`, origens
   `os_pecas` / `os_servicos`).

**O relatório 05 dizia que o (2) era só a loja. Não é: a OS também usa.** Isso
amplia o alcance da correção, e é o achado principal desta fase.

**O defeito, medido nos bancos de produção** (leitura, 2026-09-10):

| Tenant | CRs com `pedidoId` | sem `faturaId` |
|---|---:|---:|
| `josecarloscostafilho` | 6 | **6** |
| `raeldouglas` | 4 | **2** |
| outros 11 | 0 | 0 |

No `josecarloscostafilho`, **4 CRs pagas** (R$ 2.500, 3.036, 1.500 e 3.000) com
os pedidos correspondentes em `valorPago = 0` e `statusPagamento = 'pendente'`.
O dinheiro entrou; o pedido não soube.

No `raeldouglas`, o pedido 3 tem **duas CRs**: R$ 120 (peças, com `faturaId`) +
R$ 160 (serviços, direto) = R$ 280, o total exato do pedido. É o caso de
agregação que você levantou no item 3 — e a CR de peças tem **os dois vínculos**,
então não pode ser contada duas vezes.

**Como o ERP representa pagamento** (auditado antes de mexer, para não inventar
status):

| Conceito | Onde | Valores |
|---|---|---|
| status **operacional** do pedido | `pedidos.status` | `rascunho`, `confirmado`, `em_separacao`, `entregue`, `faturado`, `cancelado` (`pedidos-routes.js:32`) |
| status **financeiro** do pedido | `pedidos.statusPagamento` | `pendente`, `parcial`, `pago` (`:33`) |
| valor pago | `pedidos.valorPago` | REAL |
| status da CR | `contas_a_receber.status` | `aberta`, `parcial`, `paga`, `cancelada` |

**Os dois eixos já são separados no modelo, e continuam separados.** Nenhum
status novo foi criado. `TOTAL / PAGO / RESTA PAGAR` do futuro PDV sai de
`valorTotal`, `valorPago` e a diferença — sem campo novo.

### 3.2 Comportamento anterior

```js
const cr = db.prepare('SELECT faturaId FROM contas_a_receber WHERE id = ?').get(contaReceberId);
if (!cr || !cr.faturaId) return;        // ← abandona toda CR sem fatura
...
FROM contas_a_receber WHERE faturaId = ? AND status != 'cancelada'
```

Duas limitações: **(a)** CR sem `faturaId` era abandonada na segunda linha;
**(b)** a soma agregava por **fatura**, não por **pedido** — um pedido com CRs
por dois vínculos só via metade.

### 3.3 Comportamento novo

`contas-receber-routes.js:75-98`:

1. Resolve o pedido pelos **dois** vínculos — `cr.pedidoId` primeiro, `faturaId
   → faturas.pedidoId` como alternativa.
2. Soma **todas as CRs do pedido**, pelos dois vínculos, numa consulta só:

```sql
SELECT COALESCE(SUM(COALESCE(valorPago, 0)), 0) AS t
  FROM contas_a_receber
 WHERE status != 'cancelada'
   AND (pedidoId = ? OR faturaId IN (SELECT id FROM faturas WHERE pedidoId = ?))
```

Um mesmo `cr.id` que satisfaça as duas condições aparece **uma vez** — é um
`WHERE` sobre uma tabela só, não um `JOIN`. É o caso do `raeldouglas`.

3. `statusPagamento` derivado, com a mesma regra de antes (tolerância de R$ 0,01).
4. **Recalcula do zero** a cada chamada → idempotente por construção.

O que **não** mudou: pedido `cancelado` não é tocado; CR `cancelada` não entra na
soma; a função continua silenciando exceção com `console.warn` (tenant sem a
tabela `faturas` não quebra a baixa).

### 3.4 Idempotência, estorno e cancelamento

- **Reprocessar a mesma baixa não soma duas vezes**: a soma é sempre calculada do
  estado atual das CRs, nunca incremental. Teste `C1` chama 5 vezes seguidas.
- **Estorno**: `estornarBaixaCR` recalcula `contas_a_receber.valorPago` a partir
  dos pagamentos não estornados e já chamava a sincronização. Com a correção,
  isso passa a valer também para a CR direta. Testes `D1` e `D2`.
- **Cancelamento e reabertura**: já chamavam a sincronização; a CR cancelada sai
  da soma (teste `B3`).

### 3.5 O que a correção **não** faz: dado histórico

**Os 4 pedidos pagos do `josecarloscostafilho` continuam com `valorPago = 0`**
até que alguma baixa, estorno, cancelamento ou reabertura toque uma CR daquele
pedido — só aí a função roda. Corrigir o histórico exigiria um backfill, que é
**escrita em banco de produção** e está fora do escopo desta fase.

Fica registrado como pendência. Quando você autorizar, é um `UPDATE` derivado
das CRs, sem inventar valor nenhum.

### 3.6 Risco conhecido: `registrar-pagamento`

`POST /api/pedidos/:id/registrar-pagamento` (`pedidos-routes.js:1390`) soma
direto em `pedidos.valorPago`, **sem criar CR e sem movimentação financeira**.
Se um pedido tiver pagamento manual por essa rota **e** uma CR, a sincronização
recalcula do zero a partir das CRs e **sobrescreve** o manual.

Por que não é um problema hoje, e por que não mexi:

- **Nenhuma tela chama essa rota** — `grep -rn "registrar-pagamento" public/`
  não retorna nada.
- **Nenhum dado veio dela**: todos os 9 pedidos com `valorPago > 0` nos tenants
  (`1bit` 3, `produtosbomgosto` 6) têm CR por fatura. `cr_por_pedido = 0` em
  todos.
- Pedido **sem CR nenhuma** nunca chega à função (ela só é chamada a partir de
  uma CR), então a rota manual continua funcionando onde é usada hoje: em lugar
  nenhum.

Corrigir a rota é decisão sua e está fora deste escopo.

---

## 4. Testes

### 4.1 `scripts/test-app-backend.js` — bloco `FR` (novo)

**52 testes, 52 OK, 0 falhas** (45 anteriores + 7 de frete).

| # | Teste | Resultado |
|---|---|---|
| FR1 | restrito, frete **positivo** → aceito, total 100 + 30 = **130** | ✅ |
| FR2 | restrito, frete **zero** → aceito, total 100 | ✅ |
| FR3 | restrito, frete **negativo** → **422**, nada gravado, total intacto | ✅ |
| FR4 | pedido que já tem frete 40 → tentativa de −40 dá **422** e preserva os 40 | ✅ |
| FR5 | **ator irrestrito** (admin) também recebe **422** | ✅ |
| FR6 | frete negativo como **string** (`"-50"`) também é recusado | ✅ |
| FR7 | PUT **sem** o campo não mexe no frete já gravado | ✅ |

### 4.2 `scripts/test-fase0-pagamento-pedido.js` (novo)

**15 testes, 15 OK, 0 falhas.**

| # | Teste | Resultado |
|---|---|---|
| A1 | CR direta por `pedidoId`, **não paga** → pedido `pendente`, `valorPago = 0` | ✅ |
| A2 | pagamento **parcial** (100 de 300) → `parcial` | ✅ |
| A3 | pagamento **total** → `pago` *(era exatamente o caso quebrado)* | ✅ |
| B1 | **duas CRs diretas** somam (200 + 300 = 500), não vale a última | ✅ |
| B2 | **CR direta + CR pela fatura** no mesmo pedido = 280, **sem duplicar** a que tem os dois vínculos | ✅ |
| B3 | CR **cancelada** não entra na soma | ✅ |
| C1 | **idempotência**: 5 sincronizações seguidas mantêm 300 | ✅ |
| D1 | **estorno** total devolve o pedido a `pendente` | ✅ |
| D2 | **estorno parcial** deixa em `parcial` | ✅ |
| E1 | fluxo por **faturaId** continua funcionando (legado) | ✅ |
| E2 | **parcelas da mesma fatura** somam (300 + 300 → `parcial`; +300 → `pago`) | ✅ |
| F1 | CR **sem pedido e sem fatura** não altera pedido nenhum | ✅ |
| F2 | pedido **cancelado** não é alterado | ✅ |
| F3 | CR **inexistente** não quebra e não escreve | ✅ |
| F4 | pedido de **outra** CR não é afetado | ✅ |

### 4.3 A suíte reprova o código antigo? Sim — provado

Teste que passa não é teste que prova. Repliquei a versão **anterior** de
`sincronizarPagamentoPedido` num script em `/tmp` (sem tocar em nenhum arquivo
do repositório) e rodei o cenário `A3` — Pix da loja pago integralmente:

```
A3 com a versao ANTIGA -> valorPago=0, statusPagamento=pendente
OK: o teste A3 reprovaria a versao antiga
```

Para o frete, `FR3` e `FR5` só passam porque o 422 existe: sem a validação, o
`PUT` respondia 200 e o total caía para 50.

### 4.4 Regressão

`npm run verify` → **OK: sintaxe válida**.

| Suíte | Resultado |
|---|---|
| `test-app-backend` | **52 OK, 0 falhas** |
| `test-fase0-pagamento-pedido` | **15 OK, 0 falhas** |
| `test-reservas-pedido` | 11 OK, 0 falhas |
| `test-venda-perdida-pedido` | 16 OK, 0 falhas |
| `test-metas-bi` | 21 OK, 0 falhas |
| `test-deposito-movimentacao` | 14 OK, 0 falhas |
| `test-devolucao-venda-espelho` | 17 OK, 0 falhas |
| `test-devolucoes-credito-metas-comissao` | 22 OK, 0 falhas |
| `test-devolucoes-custo-saldo-estorno` | 22 OK, 0 falhas |
| `test-cartao-recebiveis` | 12 OK, **1 falha pré-existente** |
| `test-boletos-pagar` | **crash pré-existente** |
| `test-comissoes` | **crash pré-existente** |
| `test-pedido-compra` | **crash pré-existente** (falta `/tmp/vp-pcompra-schema.sql`) |

**As falhas pré-existentes não foram corrigidas**, conforme sua instrução.
Três delas têm a **mesma causa**, anterior a esta fase e sem relação com ela:
`no such table: fornecedores` — a tabela foi unificada em `pessoas` em 2026-08-20
e os scripts ainda a usam no seed. Todas quebram **no seed**, antes de qualquer
linha de frete ou de pagamento.

Nota: `test-boletos-pagar` também exigia `/tmp/vp-boleto-schema.sql`, que não
existia. Gerei o dump (leitura do banco) e ele passou a rodar — e aí caiu em
`fornecedores`, a mesma falha pré-existente.

---

## 5. Riscos encontrados

| Risco | Gravidade | Estado |
|---|---|---|
| **Quantidade negativa em item derruba o total** | 🔴 alta — bypass idêntico ao do frete, reproduzido | **aberto**, fora do escopo desta fase (§2.5) |
| Pedidos já pagos continuam com `valorPago = 0` | média | histórico; exige backfill em produção, não autorizado (§3.5) |
| `registrar-pagamento` pode ser sobrescrito pela sincronização | baixa | rota sem uso em tela e sem dado (§3.6) |
| Item avulso com preço negativo por ator irrestrito | baixa | por desenho; fechado para vendedor restrito em 10/09 |
| PDV/NFC-e aceita preço e desconto do navegador | alta | intocado por instrução sua |

---

## 6. Compatibilidade

| Fluxo | Efeito |
|---|---|
| **Loja virtual** (ativa no `1bit`) | **melhora**: pagamento do Pix/boleto passa a refletir em `pedidos.valorPago` e `statusPagamento`. Ela não grava `valorFrete`, então a Parte A não a alcança |
| **Faturamento de OS** | **melhora**: os pedidos gerados por OS passam a refletir o pago. Alcance maior do que o previsto no relatório 05 |
| **Faturamento normal** | inalterado — testes `E1` e `E2` cobrem o caminho legado |
| **Contas a receber** | inalterado: baixa, estorno, compensação, cancelamento e reabertura já chamavam a função; nenhum chamador mudou |
| **Tela `/comercial/pedido.html`** | inalterada: ela envia `valorFrete` só quando o usuário digita, e valor positivo continua passando. Frete negativo nenhuma tela envia |
| **Marketplaces / ML** | inalterado — não gravam `valorFrete` de pedido |
| **Hardening de 26/08 e 10/09** | **intacto**. Nada em `pedido-politicas.js`, `produtos-routes.js`, `reservas-routes.js`, `auth.js` ou `auth-routes.js` foi tocado, e os 45 testes anteriores continuam verdes |
| **Webhook de boleto/Pix** | inalterado no fluxo; passa a refletir no pedido pelo mesmo caminho de sempre |

---

## 7. O código novo não está em vigor

`pedidos-routes.js` e `contas-receber-routes.js` são carregados pelo `server.js`.
O processo em memória segue com a versão anterior — a mudança só passa a valer
com `systemctl restart consulta-licitacoes.service`, que **não** executei.

`contas-receber-routes.js` também é usado pelo `scheduler.js` (polling de
boletos), que roda no `liciteagora.service`. Na dúvida sobre qual processo
carrega o quê, os dois leem a mesma raiz flat.

---

## 8. Diff desta tarefa × alterações preexistentes

A árvore tinha **160 entradas modificadas** antes desta tarefa (271 na contagem
de 2026-08-11, ver `CLAUDE.md`). `git diff` mistura tudo. O que é **meu, hoje**:

| Arquivo | Meu diff de hoje | Já estava modificado antes? |
|---|---|---|
| `pedidos-routes.js` | **+35 −2**, em 3 pontos | **sim** — centenas de linhas de outras frentes |
| `contas-receber-routes.js` | **+40 −10**, 1 função | **sim** |
| `scripts/test-app-backend.js` | +73 (bloco `FR`) | arquivo ainda não commitado, criado em 26/08 |
| `scripts/test-fase0-pagamento-pedido.js` | arquivo novo | — |
| `docs/.../06-...md` | arquivo novo | — |

Os três pontos em `pedidos-routes.js`:

1. `erroValorFrete()` nova + `Math.max(0, …)` em `recalcularTotal` — **+28 −1**
2. validação 422 no `PUT /api/pedidos/:id` — **+6**
3. `erroValorFrete` no `module.exports` — **+1 −1**

**Cuidado ao ler `git diff` deste arquivo:** o hunk do `PUT` (ponto 2) sai
**misturado** com alterações preexistentes da árvore que estão logo abaixo, no
mesmo bloco contíguo — a validação de `politicaPrazoId` com
`resolverPoliticaPedido`/`meiosDaPoliticaPedido` e o tratamento de `vendedorId`
com `resolverVendedor`. **Nada disso é desta tarefa**: são a frente de condições
de pagamento e o hardening de 26/08, que já estavam na árvore. Minhas linhas ali
são exatamente as seis do bloco `// Frete negativo é recusado, não zerado`.

---

## 9. Confirmação

- **Serviço não reiniciado** — nenhum `systemctl` foi executado.
- **Banco de produção não alterado** — só `SELECT` e `PRAGMA`; os bancos de teste
  ficam em `/tmp`.
- **Nenhum commit** — e nenhum `git reset`, `stash` ou `clean`.
- **Nenhuma migration.** Nenhuma coluna, tabela ou índice criado.
- **Nenhuma alteração em nginx.**
- **Nenhuma alteração visual** — nada em `public/`.
