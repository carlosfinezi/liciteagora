# Fase 0 (extensão) — quantidade de item, rota de pagamento manual e dry-run do backfill

Data: 2026-09-10 · Extensão da Fase 0 do projeto **Catálogo Online + Pedidos PDV**.
Base: [`06`](06-fase-0-frete-pagamento.md) §2.5 (bypass da quantidade), §3.5
(backfill) e §3.6 (`registrar-pagamento`).

> **Nenhum commit.** Nenhum serviço reiniciado. Nenhuma migration. Nenhum
> backfill. Nenhuma escrita no banco de produção.

Escopo: **um** bypass corrigido (quantidade), **dois** pontos auditados sem
alteração (rota de pagamento manual e passivo histórico). Nada de Catálogo
Online, Pedidos PDV ou PDV/NFC-e.

---

## 1. Causa do problema

A validação de entrada dos itens era:

```js
if (!descricao || !quantidade) { ... }        // pedidos-routes.js, antes
```

`!quantidade` só barra `0`, `''`, `null`, `undefined` e `NaN`. **`-1` é truthy
e passava.** O restante do fluxo usava o número cru:

```js
const qtd = Number(quantidade);
... .run(pedidoId, produtoId, descricao, qtd, pu, qtd * pu, cfop);   // valorTotal = -100
```

Reproduzido em banco descartável em 2026-09-10, com um **vendedor restrito**:

```
item 1: quantidade  2 × R$ 100 = R$  200
item 2: quantidade -1 × R$ 100 = R$ -100    ← status 200, sem erro
valorTotal do pedido: R$ 100                 (seriam R$ 200)
```

O preço unitário é o **oficial** — resolvido pelo servidor, R$ 100. A trava de
preço de 10/09 não alcançava: o adulterado era a quantidade.

### 1.1 O estrago passava do total: estoque inflado

Este é o achado que o relatório 06 registrou pela metade e que a auditoria de
hoje precisou corrigir. A cadeia:

1. `criarReservasPedido` **ignora** quantidade não positiva
   (`reservas-routes.js:154`, `:300`, `:477` — `if (!(qtd > 0)) continue;`).
   Logo, o item negativo **não gera reserva**. Bom — e é exatamente o problema.
2. Na entrega (`POST /api/pedidos/:id/entregar`), há um **fallback** que gera
   saída para os itens **sem reserva** (`pedidos-routes.js:1101`), com a
   quantidade crua:

```js
.run(it.produtoId, Number(it.quantidade), ped.id, `Saída pelo pedido ... (sem reserva)`, ...)
```

3. O saldo é calculado como `CASE WHEN tipo='saida' THEN -quantidade`. Uma saída
   de **−1** entra como **+1**.

Ou seja: o item negativo escapava da reserva justamente por ser negativo, e
reaparecia na entrega como **entrada fantasma de estoque**.

> Correção ao relatório 06: lá está escrito que "`criarReservasPedido` receberia
> quantidade negativa". Recebe, mas **ignora** — e é isso que o joga no
> fallback da entrega. O efeito final é pior do que o descrito, não menor.

---

## 2. Caminhos auditados

Todos os pontos que gravam `pedido_itens.quantidade` no repositório:

| Caminho | Origem da quantidade | Risco antes | Agora |
|---|---|---|---|
| `POST /api/pedidos` com `itens[]` (`pedidos-routes.js:526`) | **corpo da requisição** | **vulnerável** | validado → vira aviso |
| `POST /api/pedidos/:id/itens` (`:911`) | **corpo da requisição** | **vulnerável** | validado → **422** |
| `PUT /api/pedidos/:id/itens/:itemId` (`:954`) | **corpo da requisição** | **vulnerável** | validado → **422** |
| `POST /api/pedidos/importar-participacao/:id` (`:684`) | tabelas `itens` / `sniper_itens` (banco) | não — `Number(it.quantidade) \|\| 1` | inalterado |
| Loja virtual (`loja-routes.js:344`) | `loja_carrinho` | **não** — `if (!(qtd > 0))` no `POST /loja/api/carrinho` (`:305`) descarta o item em vez de gravar | inalterado |
| Mercado Livre (`marketplaces-ml.js:304`) | `Number(oi.quantity) \|\| 0` da API do ML | não vem do usuário | inalterado |
| Faturamento de OS (`os-routes.js:2533`) | `os_itens_pecas` / `os_itens_servicos` | não vem do corpo do pedido | inalterado |

**Só os três caminhos que leem do corpo eram vulneráveis** — o mesmo desenho do
frete: a fronteira é pequena, e fechá-la resolve.

### 2.1 Existe uso legítimo de quantidade não positiva?

**Não.** Contagem em 2026-09-10, nos 13 tenants:

| | |
|---|---:|
| itens em `pedido_itens` | **542** |
| com `quantidade <= 0` | **0** |
| com quantidade decimal | 0 |

Nenhum registro em 100% da base.

E **devolução não depende disso**: o ERP tem fluxo próprio
(`devolucoes-routes.js`, `devolucao-venda.js`, tabelas `devolucoes` /
`devolucao_itens`), que grava em `faturas`/`fatura_itens` e em
`movimentacoes_estoque` — **nunca** em `pedido_itens`. Conferido no levantamento
de todos os `INSERT INTO pedido_itens` do repositório.

Decimal continua permitido: a coluna é `REAL`, o comportamento atual aceita, e
regra de unidade fracionária não é desta fase (§5).

---

## 3. Regra implementada

**Função nova** `erroQuantidade(valor)` — `pedidos-routes.js:154`, simétrica à
`erroValorFrete` da etapa anterior:

| Entrada | Resultado |
|---|---|
| `3`, `2.5`, `"2"` | **aceito** |
| ausente, `null`, `''` | erro — `quantidade obrigatoria` |
| `0`, `-1`, `"-3"` | erro — `quantidade deve ser maior que zero` |
| `"abc"`, `NaN`, `Infinity`, `-Infinity`, `1e400` | erro — `quantidade invalida` |

**Recusa, não conserta**: nada de `Math.abs`, nada de virar 1, nada de
`continue` silencioso.

Aplicação nos três pontos:

| Ponto | Linha | Resposta |
|---|---|---|
| `POST /api/pedidos` com `itens[]` | `:519-520` | o item **não entra** e volta em `avisos[]` |
| `POST /api/pedidos/:id/itens` | `:901` | **422** |
| `PUT /api/pedidos/:id/itens/:itemId` | `:945` | **422** |

Três decisões que valem estar explícitas:

1. **No POST de pedido, aviso em vez de silêncio.** Antes, `if (!it.descricao
   || !it.quantidade) continue;` engolia o item: o cliente recebia um pedido a
   menos sem saber por quê. Agora quantidade inválida vira `avisos[]`, o mesmo
   canal que o erro de política já usava. O item não entra nos dois casos — a
   diferença é o cliente ficar sabendo. Descrição vazia continua com `continue`.
2. **No POST de item, 422 e não 400.** A descrição obrigatória continua 400
   (contrato antigo, e é erro de forma); quantidade inválida é **422**, como os
   demais valores que o servidor recusa por regra de negócio.
3. **No PUT, valida-se a quantidade RESULTANTE**, não a enviada — é ela que vai
   para o banco e para `qtd * pu`. Consequência assumida: editar só a descrição
   de um item que já tivesse quantidade inválida passaria a exigir corrigi-la.
   Não há nenhum item assim (0 de 542), e propagar o inválido seria pior.

`erroQuantidade` foi exportada junto de `erroValorFrete`, para o Catálogo Online
e o Pedidos PDV usarem a mesma regra em vez de reimplementá-la.

---

## 4. Arquivos e funções alterados

| Arquivo | Função | O que mudou |
|---|---|---|
| `pedidos-routes.js` | **`erroQuantidade()`** (nova) | a regra |
| | `POST /api/pedidos` | valida cada item de `itens[]`; inválido vira aviso |
| | `POST /api/pedidos/:id/itens` | 422 |
| | `PUT /api/pedidos/:id/itens/:itemId` | 422, sobre a quantidade resultante |
| | `module.exports` | exporta `erroQuantidade` |
| `scripts/test-app-backend.js` | — | bloco `QT` (13 testes) |
| **`scripts/auditar-pagamento-pedidos.js`** | **novo** | dry-run somente leitura (§7) |
| **`docs/.../07-fase-0-quantidade.md`** | **novo** | este relatório |

Nada foi tocado em `pedido-politicas.js`, `reservas-routes.js`,
`produtos-routes.js`, `contas-receber-routes.js`, `auth.js`, `auth-routes.js`,
`loja-routes.js`, `os-routes.js` ou no PDV/NFC-e.

---

## 5. Impacto em reserva, total e estoque (Parte B)

Como a recusa acontece **na fronteira de escrita**, o item inválido nunca é
gravado — e por isso nada a jusante chega a vê-lo:

| Rotina | Chega a ver quantidade inválida? |
|---|---|
| `recalcularTotal` | não — o item não existe |
| `criarReservasPedido` | não |
| fallback de saída na entrega (`pedidos-routes.js:1101`) | não — era o ponto do estoque inflado |
| `consumirReservasPedido` | não |
| faturamento / NF-e | não |

O teste `QT13` percorre esse caminho inteiro: cria pedido, tenta o item
inválido (422), confirma, entrega e **verifica que não existe nenhuma
movimentação com quantidade ≤ 0** para aquele pedido.

### 5.1 Variantes equivalentes — auditadas, **não implementadas**

Conforme sua instrução, documento sem expandir escopo:

| Variante | Estado |
|---|---|
| **Quantidade extremamente grande** | `1e308` é finito e positivo: **passa**. Não há teto. O efeito prático é limitado — a confirmação devolve 409 por saldo insuficiente, e o item não reserva. Mas um orçamento com `valorTotal` astronômico é possível. **Não travei**: teto é regra de negócio nova, e não sei qual seria (unidade a granel muda tudo) |
| **Decimal onde a unidade não permite** | `2.5 UN` passa. `produtos.unidade` existe, mas não há cadastro de "aceita fração". Regra nova — fora desta fase |
| **Precisão de ponto flutuante** | `0.1 + 0.2` clássico; `valorTotal` é `qtd * pu` sem arredondamento em `pedido_itens`. Já era assim; não mexi |
| **Subtotal negativo por outro campo** | `valorFrete` fechado na etapa anterior; `precoUnitario` fechado para o vendedor restrito em 10/09; item avulso negativo ainda é possível para **ator irrestrito** (por desenho); desconto e acréscimo não existem como coluna |
| **`quantidade` no PUT via `produtoId: 0`** | testado indiretamente: o PUT valida a quantidade resultante, independente do produto |

Depois desta etapa, **não conheço mais nenhum caminho pelo qual um vendedor
restrito derrube o total de um pedido.**

---

## 6. Parte C — auditoria de `POST /api/pedidos/:id/registrar-pagamento`

**Rota não alterada**, conforme sua instrução. Fica em `pedidos-routes.js:1441`.

```js
const valor = Number(req.body?.valor);
if (!(valor > 0)) return res.status(400).json({ ... });
const novoPago = (ped.valorPago || 0) + valor;      // soma acumulativa
db.prepare('UPDATE pedidos SET valorPago = ? ...').run(novoPago, req.params.id);
atualizarStatusPagamento(db, req.params.id);
```

### As oito perguntas

**1. Quem pode chamar.** Qualquer usuário autenticado cujo perfil alcance o
prefixo `/api/pedidos` — que no `perfis-api-map.js` está associado a **28
páginas**, incluindo `pedidos`. Ou seja: **o vendedor restrito pode chamar**.
Não há `requireRole`, não há checagem de alçada.

Também **não há checagem de dono**: a rota carrega o pedido por `id` sem passar
por `escopoVendedor`. Um vendedor restrito pode registrar pagamento no pedido de
outro. Sendo justo: isso **não é exclusividade dela** — `GET /api/pedidos/:id`
(`:395`) e as demais rotas por `:id` também não aplicam escopo; o recorte por
vendedor está só na listagem (`:337`, `:372`). É dívida do módulo, anterior a
esta fase.

**2. Alguma tela chama?** **Não.** `grep -rn "registrar-pagamento"` no
repositório inteiro retorna só a definição da rota e as menções nestes
relatórios. Nenhum HTML, nenhum JS de `public/`, nenhum script, nenhum outro
módulo.

**3. Integração externa chama?** Tecnicamente **pode**: `X-Api-Key` autentica
contra `/api/` (`auth.js:305-313`), então uma integração com a chave do tenant
alcança a rota. **Não há evidência de que alguma chame** — nenhum dos 9 pedidos
com `valorPago > 0` na base veio dela (todos têm CR por fatura; §7).

**4. Pagamento parcial.** Funciona: soma ao acumulado e
`atualizarStatusPagamento` (`:115`) deriva `pendente`/`parcial`/`pago`
comparando com `valorTotal`. É o único lugar do ERP que produz `parcial` sem CR.

**5. Chamar duas vezes.** **Não é idempotente** — é `valorPago + valor` a cada
chamada. Dois toques = dobro. Não há chave de idempotência, não há vínculo com
um evento de pagamento, e **não há registro em `audit_log`** (a rota não chama
`logAction`). Um pagamento lançado duas vezes não deixa rastro de quem lançou.

**6. Valor negativo.** **Bloqueado**: `if (!(valor > 0))` recusa negativo, zero,
`NaN` e string não numérica. `Infinity` passa nessa guarda (`Infinity > 0`) e
gravaria `valorPago = Infinity` — que o SQLite armazena como `Inf` em REAL.
Caso teórico, sem impacto financeiro (não cria CR nem move caixa), mas é o mesmo
descuido que `erroValorFrete`/`erroQuantidade` corrigiram nos outros campos.

**7. Divergência com contas a receber.** **Sim, nas duas direções:**

- A rota move `pedidos.valorPago` **sem** criar `contas_a_receber`, **sem**
  `contas_receber_pagamentos` e **sem** `movimentacoes_financeiras`. O pedido
  diz "pago" e o financeiro não tem o recebimento. Nenhum relatório financeiro
  enxerga esse dinheiro.
- No sentido inverso: se o pedido tiver **qualquer** CR e ela sofrer baixa,
  estorno, cancelamento ou reabertura, `sincronizarPagamentoPedido` recalcula do
  zero a partir das CRs e **apaga** o valor lançado manualmente.

Hoje isso não produz dano porque nenhum pedido tem as duas coisas — mas é uma
armadilha silenciosa para quem usar a rota depois.

**8. Recomendação.** **Desativar a rota** (responder 410, ou removê-la), e não
convertê-la nem protegê-la:

- Ela não tem consumidor: nenhuma tela, nenhum script, nenhum dado.
- O ERP **já tem** o caminho certo para "recebi dinheiro deste pedido":
  `contas_a_receber` com `pedidoId` + `registrarBaixaCR`, que cria o pagamento,
  lança no caixa, é idempotente, tem estorno e — desde a etapa anterior —
  reflete no pedido automaticamente.
- Convertê-la para criar CR seria escrever um segundo caminho para algo que já
  existe; protegê-la (alçada, idempotência, auditoria, escopo) é trabalho para
  manter um atalho que ninguém usa e que contradiz o financeiro.

Se o Pedidos PDV precisar de "registrar pagamento", o lugar é a CR — que é
também o que sustenta TOTAL / PAGO / RESTA PAGAR.

**Não classifico como vulnerabilidade crítica explorável** (exige credencial
válida do tenant, não move dinheiro, não emite documento, e o efeito é
sobrescrito assim que uma CR real é baixada), por isso **não parei nem alterei**.
A decisão de desativar é sua.

---

## 7. Parte D — dry-run do backfill (somente leitura)

Script novo: **`scripts/auditar-pagamento-pedidos.js`**.

- Abre cada `data/tenants/*/pncp.db` com **`readonly: true`** — a garantia é do
  driver, não da boa intenção do código. Verificado: um `UPDATE` na mesma
  conexão devolve `attempt to write a readonly database`.
- Usa **a mesma expressão** da função corrigida, para não haver duas contas.
- Não imprime cliente, CPF/CNPJ, descrição nem endereço — só `pedidoId`,
  número, valores e status.
- Uso: `node scripts/auditar-pagamento-pedidos.js [tenant] [--json]`.

### Resultado, executado em 2026-09-10

```
1bit:                 4 pedido(s) com CR — nenhuma divergencia
josecarloscostafilho: 4 de 5 pedido(s) com CR divergem
produtosbomgosto:     8 pedido(s) com CR — nenhuma divergencia
raeldouglas:          2 pedido(s) com CR — nenhuma divergencia
crsolucoes:           nao se aplica (schema antigo: no such column: cr.pedidoId)
pccontabilidade:      nao se aplica (schema antigo)
os outros 7:          0 pedido(s) com CR
```

| Tenant | Pedido | Número | Total | Pago atual | Pago esperado | Diferença | Status |
|---|---:|---|---:|---:|---:|---:|---|
| `josecarloscostafilho` | 1 | 000001 | 2.500,00 | 0,00 | 2.500,00 | +2.500,00 | pendente → **pago** |
| `josecarloscostafilho` | 3 | 000003 | 3.036,00 | 0,00 | 3.036,00 | +3.036,00 | pendente → **pago** |
| `josecarloscostafilho` | 4 | 000004 | 1.500,00 | 0,00 | 1.500,00 | +1.500,00 | pendente → **pago** |
| `josecarloscostafilho` | 5 | 000005 | 3.000,00 | 0,00 | 3.000,00 | +3.000,00 | pendente → **pago** |

**Total: 4 pedidos, R$ 10.036,00** que o pedido deixou de registrar como pago.

Todos são do **faturamento de OS** (CRs com `origemTipo` `os_servicos`), todos
já com a conta `paga` no financeiro. Nenhum é da loja virtual — a loja do
`1bit` está ativa mas ainda não teve pedido com cobrança compensada.

Dois tenants (`crsolucoes`, `pccontabilidade`) têm schema antigo, sem
`contas_a_receber.pedidoId`. Sem a coluna, não pode haver CR ligada direto ao
pedido: **não se aplica**, não é erro.

**Nenhum `UPDATE` foi executado.** A correção histórica depende de autorização
sua e será feita em etapa separada.

---

## 8. Testes

### 8.1 Bloco `QT` — novo em `scripts/test-app-backend.js`

**65 testes, 65 OK, 0 falhas** (52 anteriores + 13 de quantidade).

| # | Teste | Resultado |
|---|---|---|
| QT1 | quantidade **inteira** positiva (3 × 100 = 300) | ✅ |
| QT2 | quantidade **decimal** (2,5 × 100 = 250) — comportamento preservado | ✅ |
| QT3 | **string numérica** válida (`"2"`) — comportamento preservado | ✅ |
| QT4 | **zero** → 422, nada gravado | ✅ |
| QT5 | **negativa** → 422, total intacto em 200 *(o bypass)* | ✅ |
| QT6 | **string inválida** (`"abc"`) → 422 | ✅ |
| QT7 | `Infinity`, `-Infinity`, `NaN`, `1e400` → 422 | ✅ |
| QT8 | string numérica negativa (`"-3"`) → 422 | ✅ |
| QT9 | `POST /api/pedidos` com `itens[]`: o inválido não entra e vira **aviso** | ✅ |
| QT10 | **PUT** de item recusa −1, 0 e `"abc"`; item e total preservados | ✅ |
| QT11 | PUT **sem** quantidade preserva a que estava | ✅ |
| QT12 | vale para **ator irrestrito** também | ✅ |
| QT13 | inválida **não chega a estoque**: sem item, sem reserva, **sem movimentação ≤ 0** após a entrega | ✅ |

### 8.2 A correção é real? Antes e depois, no mesmo script

O script que confirmou o bypass ontem foi reexecutado hoje, sem alteração:

```
ANTES:  status do POST com quantidade -1: 200
        itens: [{qtd:2, total:200}, {qtd:-1, total:-100}]
        valorTotal do pedido: 100

DEPOIS: status do POST com quantidade -1: 422
        itens: [{qtd:2, total:200}]
        valorTotal do pedido: 200
```

### 8.3 Uma falha que eu mesmo causei, e como resolvi

`QT13` é o único teste do arquivo que **entrega** um pedido e, portanto, consome
saldo. Isso derrubou o teste `F` (alheio), que afirma `disponivel === 10`.

Não mexi no teste `F`: fiz o `QT13` declarar a própria entrada de estoque de 1
unidade, ficando neutro no saldo. O acoplamento entre testes por estado
compartilhado do banco continua existindo no arquivo — é característica dele, e
mexer nisso seria refatoração fora de escopo.

### 8.4 Regressão

`npm run verify` → **OK: sintaxe válida**.

| Suíte | Resultado |
|---|---|
| `test-app-backend` | **65 OK, 0 falhas** |
| `test-fase0-pagamento-pedido` | 15 OK, 0 falhas |
| `test-reservas-pedido` | 11 OK, 0 falhas |
| `test-venda-perdida-pedido` | 16 OK, 0 falhas |
| `test-metas-bi` | 21 OK, 0 falhas |
| `test-deposito-movimentacao` | 14 OK, 0 falhas |
| `test-devolucao-venda-espelho` | 17 OK, 0 falhas |
| `test-devolucoes-credito-metas-comissao` | 22 OK, 0 falhas |
| `test-devolucoes-custo-saldo-estorno` | 22 OK, 0 falhas |
| `test-cartao-recebiveis` | 12 OK, **1 falha pré-existente** |
| `test-comissoes` | **crash pré-existente** |
| `test-boletos-pagar` | **crash pré-existente** |
| `test-pedido-compra` | **crash pré-existente** |

As quatro falhas são **idênticas às de antes desta tarefa** e não foram
corrigidas: três por `no such table: fornecedores` (tabela unificada em `pessoas`
em 2026-08-20, scripts não acompanharam) e uma por dump ausente em `/tmp`. Todas
quebram no seed, antes de qualquer linha de quantidade.

---

## 9. Outros bypasses e riscos

| Item | Estado |
|---|---|
| Quantidade não positiva | **fechado nesta etapa** |
| `valorFrete` negativo | fechado na etapa anterior |
| `precoUnitario` do vendedor restrito | fechado em 10/09 |
| Item avulso sem produto, preço negativo, **ator irrestrito** | aberto **por desenho** |
| Quantidade sem teto superior | aberto — §5.1, precisa de regra de negócio |
| Decimal em unidade indivisível | aberto — §5.1, precisa de cadastro novo |
| `registrar-pagamento` sem CR, sem idempotência, sem auditoria, sem escopo | **auditado, não alterado** — §6 |
| Rotas por `:id` sem escopo de vendedor | dívida do módulo, anterior a esta fase |
| 4 pedidos com R$ 10.036,00 não refletidos | **medido**, backfill não autorizado — §7 |
| PDV/NFC-e aceita preço e desconto do navegador | intocado por instrução |

---

## 10. Diff isolado desta tarefa

A árvore tem 163 entradas modificadas. O que é **desta tarefa**:

| Arquivo | Diff desta tarefa |
|---|---|
| `pedidos-routes.js` | **+49 −3**, em 5 pontos |
| `scripts/test-app-backend.js` | +134 (bloco `QT`) |
| `scripts/auditar-pagamento-pedidos.js` | arquivo novo |
| `docs/.../07-fase-0-quantidade.md` | arquivo novo |

Os cinco pontos em `pedidos-routes.js`:

| # | Ponto | Linhas |
|---|---|---|
| 1 | `erroQuantidade()` + docstring, antes de `recalcularTotal` | **+30** |
| 2 | `POST /api/pedidos`, item de `itens[]` (`:513-520`) | **+7 −1** |
| 3 | `POST /api/pedidos/:id/itens` (`:895-902`) | **+5 −1** |
| 4 | `PUT /api/pedidos/:id/itens/:itemId` (`:940-946`) | **+6** |
| 5 | `module.exports` | **+1 −1** |

> **Aviso importante para ler `git diff` deste arquivo.** `git diff` compara com
> o HEAD, e `pedidos-routes.js` acumula **várias frentes não commitadas**: o
> hardening de preço e vendedor de 26/08, o de 10/09, o motor de CFOP, o
> depósito, as condições de pagamento e a etapa de frete de hoje. Filtrar os
> hunks por `erroQuantidade` devolve **+152 −29** — e a maior parte disso **não
> é desta tarefa**: vem junto porque está no mesmo bloco contíguo.
>
> O que é meu nesta extensão são exatamente os cinco pontos da tabela acima,
> todos identificáveis por conterem `erroQuantidade` ou o comentário que a
> acompanha. Os hunks completos estão reproduzidos na resposta que acompanha
> este relatório, com essa separação indicada.

---

## 11. O código novo não está em vigor

`pedidos-routes.js` é carregado pelo `server.js`. O processo em memória segue com
a versão anterior — a mudança só passa a valer com
`systemctl restart consulta-licitacoes.service`, que **não** executei.

---

## 12. Confirmação

- **Serviço NÃO reiniciado** — nenhum `systemctl` executado.
- **Banco de produção NÃO alterado** — leitura apenas; o script de auditoria abre
  com `readonly: true` e os bancos de teste ficam em `/tmp`.
- **Nenhum backfill executado** — o dry-run não emite `UPDATE`.
- **Nenhuma migration** — nenhuma coluna, tabela ou índice.
- **Nenhum commit** — e nenhum `reset`, `stash` ou `clean`. Nenhuma alteração
  preexistente da árvore foi descartada.
