# Auditoria — Pedido comercial ponta a ponta (para o app móvel de vendas)

Data: 2026-08-26 · Escopo: "Novo pedido" → gravado no banco → estoque → faturamento.
Objetivo: definir o que uma API de entrada precisa enviar para que o pedido nasça
como pedido comercial normal, apareça em COMERCIAL → Pedidos e siga o fluxo já
existente até a nota.

## 0. Procedência do que está escrito aqui

**`docs/auditoria-integracao-2026-08-17/` NÃO existe.** O diretório `docs/` inteiro
não existe nesta árvore (`ls -d docs` → *No such file or directory*). Portanto **nada
neste relatório vem de auditoria anterior** — tudo foi lido agora, em 2026-08-26, no
código da árvore de trabalho (que é a produção) e nos bancos dos tenants.

Fontes usadas:

- Código: arquivos `.js` da raiz e telas em `public/comercial/`, na versão da árvore
  (não a do HEAD do git — a árvore tem 271 entradas pendentes de commit).
- Banco: os **11 `data/tenants/*/pncp.db`** para contagem e valores em uso (57 pedidos
  no total); o schema detalhado foi lido do `1bit` (o de maior volume: 27 pedidos) via
  `PRAGMA table_info` / `PRAGMA foreign_key_list` / `SELECT`. **Leitura pura — nenhuma
  escrita, DDL ou DELETE.**

Onde não foi possível confirmar, está escrito **"não confirmado"**.

---

## 1. FLUXO PONTA A PONTA

### 1.1 As telas

| Papel | Arquivo |
|---|---|
| Listagem + botão "+ Novo pedido" | `public/comercial/pedidos.html` |
| Edição do pedido (cabeçalho, itens, parcelas, ações, fatura) | `public/comercial/pedido.html` (2471 linhas, JS inline) |

Não há build nem framework: o JS é inline no HTML e chama `fetch()` direto.

### 1.2 Sequência real, na ordem em que acontece

**Passo 1 — nasce vazio.**
`public/comercial/pedidos.html:32` (botão) → `criarPedidoVazio()` em
`public/comercial/pedidos.html:428` → `criarVazio()` em
`public/comercial/pedidos.html:431-441`, que faz:

```js
fetch('/api/pedidos', { method:'POST', body: JSON.stringify({ modoDocumento }) })
```

**O corpo enviado pela tela tem UM campo: `modoDocumento`.** Nada mais. Em seguida
a tela redireciona para `/comercial/pedido.html?id=<novo id>&aba=cliente`.

Backend: `pedidos-routes.js:336-371`, handler `app.post('/api/pedidos')`.
O que ele faz, em ordem:

1. Lê do corpo apenas `clienteId, dataEntregaPrevista, observacao, itens, modoDocumento, vendedorId, depositoId` (`pedidos-routes.js:338`). **Todo o resto do corpo é ignorado** — `tipoOperacaoId`, `meioPagamento`, `politicaPrazoId`, `tabelaPrecoId`, frete, endereço de entrega etc. não entram por aqui.
2. `modo = MODOS_DOCUMENTO.includes(modoDocumento) ? modoDocumento : 'pedido'` (`:339`; `MODOS_DOCUMENTO = ['pedido','orcamento']` em `:80`).
3. Se `clienteId` veio, valida `SELECT * FROM pessoas WHERE id = ? AND ativo = 1`; se não achar, 404 (`:341-344`). **Se não veio, segue em frente** — cliente é opcional no rascunho.
4. Vendedor: `vendedorId` do corpo, senão `req.session?.userId` (`:348`).
5. `numero = gerarNumero(db, modo)` (`:350`) — ver seção 4.
6. `INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, dataEntregaPrevista, observacao, vendedorId, depositoId)` com `tipo='manual'`, `status='rascunho'`, `dataPedido = dataBrasilia()` (`:351-355`). `depositoId` = o informado, senão `resolverDeposito(db, {})` → depósito padrão.
7. Se veio `itens[]`, para cada um: **pula silenciosamente** se faltar `descricao`, `quantidade` ou se `precoUnitario == null` (`:359` — `continue`, sem erro); senão `INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)` com `valorTotal = qtd * pu` (`:361-363`).
8. `recalcularTotal(db, pedidoId)` (`:366` → `:103-110`): `valorTotal = SUM(pedido_itens.valorTotal) + pedidos.valorFrete`.
9. Responde `carregarPedidoCompleto()` (`:121-145`).

**Não há transação** neste handler. O INSERT do pedido, os INSERTs de itens e o
UPDATE do total são três operações soltas. (Compare com `loja-routes.js:338-350`,
que faz o mesmo dentro de `db.transaction(...)`.)

**Atenção — CFOP:** o POST de criação **não calcula CFOP** dos itens. Quem calcula é
o `POST /api/pedidos/:id/itens` (`pedidos-routes.js:708-717`, via `sugerirCFOP`).
Itens criados junto do pedido nascem com `cfop = NULL`.

**Passo 2 — preenche o cabeçalho.**
`public/comercial/pedido.html:1507` (`coletarBody()`) monta o corpo e
`salvarHeader()` / `salvarHeaderSilencioso()` (`:1548` / `:1536`) fazem
`PUT /api/pedidos/:id`.

Campos que a tela envia (`pedido.html:1507-1534`): `clienteId, transportadoraId,
tipoFrete, valorFrete, dataEntregaPrevista, dataValidade, dataFaturamentoPrevista,
codigoPedidoCliente, vendedorId, depositoId, politicaPrazoId, meioPagamento,
observacao, observacoesInterna, tipoOperacaoId, enderecoEntrega, numeroEntrega,
complementoEntrega, bairroEntrega, cidadeEntrega, ufEntrega, cepEntrega,
contatoEntrega, telefoneEntrega`.

Backend: `pedidos-routes.js:530-579`. Ordem:

1. 404 se não existe; 400 se `status` é `cancelado` ou `faturado` (`:534-536`).
2. **Única validação real do módulo** (`:542-559`): se veio `meioPagamento`, `clienteId` ou `politicaPrazoId`, resolve a condição de pagamento via `resolverPoliticaPedido()` (`:37-50`) e o meio via `erroMeioPermitido()` (`meios-pagamento.js`). Regras:
   - política vinculada ao cliente (`pessoas.politicaPrazoId`) é **obrigatória** quando existe e vale para vendas — mandar outra dá 400 (`:46-48`);
   - política escolhida tem de existir, estar `ativo=1` e ter `aplicaVendas=1` (`:43-45`);
   - `meioPagamento` tem de estar na whitelist `politicas_prazo.meiosPermitidos` (`:551-555`) e na do cliente (`:557-558`).
3. Aplica os campos presentes em `CAMPOS_PEDIDO` (`:62-78`) — `''` vira `NULL` (`:566`).
4. Se `valorFrete` mudou, `recalcularTotal` (`:574`).

`CAMPOS_PEDIDO` é a lista fechada do que o PUT aceita: `clienteId,
dataEntregaPrevista, dataValidade, dataFaturamentoPrevista, codigoPedidoCliente,
transportadoraId, tipoFrete, valorFrete, meioPagamento, observacao,
observacoesInterna, vendedorId, depositoId, tipoOperacaoId, naoEmitirNFe,
tabelaPrecoId, politicaPrazoId, enderecoEntrega, numeroEntrega, complementoEntrega,
bairroEntrega, cidadeEntrega, ufEntrega, cepEntrega, codigoMunicipioEntrega,
contatoEntrega, telefoneEntrega`.

**Passo 3 — itens.**
`addItem()` (`pedido.html:1704-1722`) → `POST /api/pedidos/:id/itens`
(`pedidos-routes.js:693-729`). Valida status (`entregue/faturado/cancelado` → 400,
`:697-699`) e exige `descricao`, `quantidade`, `precoUnitario != null` (`:701-703`).
Calcula CFOP com `sugerirCFOP()` (`:709-717`), insere, `recalcularTotal` +
`atualizarStatusPagamento`.
Edição de item: `PUT /api/pedidos/:id/itens/:itemId` (`:731-753`).
Remoção: `DELETE` (`:780-794`).

**Passo 4 — parcelas (opcional).**
`PUT /api/pedidos/:id/parcelas` (`pedidos-routes.js:1145-1216`) substitui a lista
inteira. Valida por parcela: `valor > 0`, `dataVencimento`, `meioPagamento`,
bandeira obrigatória para cartão (`'03'`/`'04'`), meio permitido para o cliente,
valor mínimo da política, e **soma das parcelas = `pedidos.valorTotal`** com
tolerância de R$ 0,01 (`:1190-1197`). Roda em transação (`:1200-1210`).

**Passo 5 — confirmar.**
`acao('confirmar')` (`pedido.html:2026`) → `POST /api/pedidos/:id/confirmar`
(`pedidos-routes.js:833-843`) → `confirmarPedidoInterno()` (`:804-831`):
orçamento não pode (`:807`), só `rascunho` (`:808`), **exige `clienteId`** (`:809`)
e **pelo menos 1 item** (`:810-811`). Dentro de transação (`:815-820`): cria as
reservas de estoque e muda `status='confirmado'`. Se houver insuficiência e o corpo
não trouxer `{forcar:true}`, devolve **409** com a lista (`:824-827`).

**Passo 6 — entregar.**
`POST /api/pedidos/:id/entregar` (`pedidos-routes.js:845-908`): exige status
`confirmado` ou `em_separacao`. Em transação: consome reservas → movimentações de
saída; itens sem reserva ganham saída de fallback; `status='entregue'` e
`dataEntregaReal`.

**Passo 7 — faturar.**
`executarFaturar()` (`pedido.html:2300`) → `POST /api/pedidos/:id/faturar`
(`faturas-routes.js:149-385`) e, se o tipo de operação emite NF-e, a própria tela
encadeia `POST /api/faturas/:id/emitir-nfe` (`pedido.html:2319`).

### 1.3 O que é gravado, em que tabela, na ordem

| # | Momento | Tabela | Operação |
|---|---|---|---|
| 1 | POST /api/pedidos | `pedidos` | INSERT (`numero, tipo='manual', modoDocumento, clienteId, status='rascunho', dataPedido, dataEntregaPrevista, observacao, vendedorId, depositoId`) |
| 2 | idem | `pedido_itens` | INSERT por item (sem `cfop`) |
| 3 | idem | `pedidos` | UPDATE `valorTotal`, `dataAtualizacao` |
| 4 | PUT /api/pedidos/:id | `pedidos` | UPDATE dos campos de `CAMPOS_PEDIDO` |
| 5 | POST /itens | `pedido_itens` + `pedidos` | INSERT (com `cfop`) + UPDATE total/statusPagamento |
| 6 | PUT /parcelas | `pedido_parcelas` | DELETE + INSERT (tx) |
| 7 | confirmar | `reservas_estoque` | INSERT `status='ativa'` (tx) |
| 8 | confirmar | `pedidos` | UPDATE `status='confirmado'` (mesma tx) |
| 9 | entregar | `movimentacoes_estoque` | INSERT `tipo='saida'`, `origem='pedido'`, `origemId=pedidoId` (tx) |
| 10 | entregar | `reservas_estoque` | UPDATE `status='consumida'`, `movimentacaoConsumoId` |
| 11 | entregar | `lotes` | UPDATE `saldoAtual` (só produto com `rastreiaLote`) |
| 12 | entregar | `pedidos` | UPDATE `status='entregue'`, `dataEntregaReal` |
| 13 | faturar | `faturas` | INSERT (tx) |
| 14 | faturar | `fatura_itens` | INSERT por item |
| 15 | faturar | `contas_a_receber` | INSERT 1 por parcela |
| 16 | faturar | `movimentacoes_financeiras` (via `lancarMovimentacao`) | só se meio à vista em dinheiro |
| 17 | faturar | `faturas` / `pedidos` | UPDATE `contaReceberId` / `status='faturado'`, `faturaId` |
| 18 | cancelar/reabrir | `pedido_historico` | INSERT |

`pedido_historico` **só** é escrito em `cancelar` (`pedidos-routes.js:1005`) e
`reabrir` (`:1086`). Criação, edição e confirmação não deixam rastro nessa tabela.

### 1.4 Autenticação (o app precisa disto)

`requireAuth` em `auth.js:255-331`, instalado em `auth-bootstrap.js:76`.
Dois caminhos:

- **Sessão** (`req.session.userId`) — o que a tela usa;
- **Header `X-Api-Key`** (`auth.js:298-306`), validado contra `config.api_key` do
  tenant. **Passa direto, sem `req.user`.**

Consequências para o app, todas confirmadas no código:

1. Com `X-Api-Key`, o gate de perfil (`perfis-acesso.js:185`,
   `if (!req.user) return next(); // X-Api-Key: atua como sistema`) **não filtra
   nada** — a chave é acesso total ao tenant.
2. Com `X-Api-Key`, `req.session?.userId` é `undefined`, então o default de
   vendedor em `pedidos-routes.js:348` resolve para **`null`**. **O app tem de
   enviar `vendedorId` explicitamente**, ou metas e comissões voltam a ficar sem
   dono.
3. `/api/pedidos` **não está** no `feature-gate.js` — está listado em `GATES_FORA`
   (`feature-gate.js:174`) como consumido por tela sem feature. Ou seja, não há
   gate de módulo pago barrando a criação de pedido. (`module-gate.js` está
   **desativado** desde 2026-05-21 — `server.js:60`, linha comentada.)

---

## 2. TABELAS E RELACIONAMENTOS

Schema conferido em `data/tenants/1bit/pncp.db` (`PRAGMA table_info`) e cruzado com
`db-schema.js`.

### 2.1 `pedidos`

Criada em `db-schema.js:1177-1199`; colunas novas por `ALTER` em `db-schema.js:986-1011`
(+ `vendedorId`, `tipoOperacaoId`, `depositoId` por outros módulos, e `origemLoja`
por `loja-routes.js:99`).

| Coluna | Tipo | NOT NULL | Default |
|---|---|---|---|
| `id` | INTEGER | — | PK AUTOINCREMENT |
| `numero` | TEXT | **sim** | — (UNIQUE) |
| `tipo` | TEXT | **sim** | `'manual'` |
| `clienteId` | INTEGER | não | — |
| `participacaoId` | INTEGER | não | — |
| `compraId` | TEXT | não | — |
| `status` | TEXT | **sim** | `'rascunho'` |
| `dataPedido` | TEXT | **sim** | — |
| `dataEntregaPrevista` | TEXT | não | — |
| `dataEntregaReal` | TEXT | não | — |
| `valorTotal` | REAL | não | `0` |
| `valorPago` | REAL | não | `0` |
| `statusPagamento` | TEXT | não | `'pendente'` |
| `observacao` | TEXT | não | — |
| `dataCriacao` | TEXT | não | `CURRENT_TIMESTAMP` |
| `dataAtualizacao` | TEXT | não | `CURRENT_TIMESTAMP` |
| `transportadoraId` | INTEGER | não | — |
| `tipoFrete` | TEXT | não | — |
| `valorFrete` | REAL | não | — |
| `dataValidade` | TEXT | não | — |
| `dataFaturamentoPrevista` | TEXT | não | — |
| `codigoPedidoCliente` | TEXT | não | — |
| `meioPagamento` | TEXT | não | — |
| `observacoesInterna` | TEXT | não | — |
| `faturaId` | INTEGER | não | — |
| `enderecoEntrega`, `numeroEntrega`, `complementoEntrega`, `bairroEntrega`, `cidadeEntrega`, `ufEntrega`, `cepEntrega`, `codigoMunicipioEntrega`, `contatoEntrega`, `telefoneEntrega` | TEXT | não | — |
| `modoDocumento` | TEXT | **sim** | `'pedido'` |
| `naoEmitirNFe` | INTEGER | **sim** | `0` |
| `vendedorId` | INTEGER | não | — |
| `tipoOperacaoId` | INTEGER | não | — |
| `tabelaPrecoId` | INTEGER | não | — |
| `depositoId` | INTEGER | não | — |
| `origemLoja` | INTEGER | não | `0` |
| `politicaPrazoId` | INTEGER | não | — |

FKs declaradas (`PRAGMA foreign_key_list(pedidos)`): `clienteId → pessoas(id)` e
`participacaoId → participacoes_comprasnet(id)`. Ambas `NO ACTION`.
**`vendedorId`, `tipoOperacaoId`, `depositoId`, `tabelaPrecoId`, `politicaPrazoId`,
`transportadoraId`, `faturaId` NÃO têm FK declarada** — vieram por `ALTER TABLE`.
O tenant roda com `foreign_keys = ON` (`tenant-manager.js`), então as duas FKs
declaradas são realmente aplicadas.

Índices: `idx_pedidos_status`, `idx_pedidos_cliente`, `idx_pedidos_participacao`.

**Não existe coluna de desconto de cabeçalho.** `os-routes.js:2265-2268` contorna
isso lançando um item de valor negativo. Também não existe `estabelecimentoId` em
`pedidos` (existe em `faturas`).

### 2.2 `pedido_itens`

`db-schema.js:1201-1212`.

| Coluna | Tipo | NOT NULL |
|---|---|---|
| `id` | INTEGER | PK |
| `pedidoId` | INTEGER | **sim** |
| `produtoId` | INTEGER | não |
| `descricao` | TEXT | **sim** |
| `quantidade` | REAL | **sim** |
| `precoUnitario` | REAL | **sim** |
| `valorTotal` | REAL | **sim** |
| `cfop` | TEXT | não |

FKs: `pedidoId → pedidos(id)`, `produtoId → produtos(id)`.
**Item sem produto é válido** (`produtoId` nulo) — é como serviço e desconto entram.
Não há coluna de desconto, unidade nem NCM no item: unidade e NCM vêm do produto na
hora de faturar (`faturas-routes.js:167`).

### 2.3 `pedido_parcelas` — `db-schema.js:937-949`

`id`, `pedidoId` (NN), `numeroParcela` (NN), `valor` (NN), `dataVencimento` (NN),
`meioPagamento` (NN), `bandeiraId` (FK `adquirentes_cartao`), `observacao`.

### 2.4 `pedido_historico` — `db-schema.js:923-935`

`id`, `pedidoId` (NN), `statusAnterior`, `statusNovo`, `acao` (NN), `motivo`,
`usuario`, `dadosExtras` (JSON TEXT), `dataCriacao`.

### 2.5 `pessoas` (cliente) — cadastro unificado

`db-schema.js` (ALTERs em `:2020-2063`). Obrigatórias no banco: `cpfCnpj` (NN),
`tipo` (NN, default `'PJ'`), `razaoSocial` (NN). Relevantes ao pedido:
`ativo` (default 1), `tabelaPrecoId`, `politicaPrazoId`, `meiosPagamentoPermitidos`
(JSON array de tPag), `condicaoPagamentoPadrao`, `limiteCredito`, `vendedorId`,
`uf`, `cidade`, `codigoMunicipio`, `inscricaoEstadual`.

**`limiteCredito` não é validado em lugar nenhum do fluxo de pedido.** Busca em
todo o repo: só aparece em `db-schema.js:2047` (declaração) e
`financeiro-routes.js:481` (lista de campos do cadastro). Não bloqueia nada.

### 2.6 `produtos`

`sku` (NN), `descricao` (NN), `unidade` (default `'UN'`), `precoVenda` (default 0),
`precoCusto`, `precoMinimoVenda`, `ncm`, `cfopPadrao`, `origem`, `tipoProduto`
(`'kit'` explode em componentes), `rastreiaLote`, `rastreiaSerial`,
`publicadoNaLoja`, `ativo`.

### 2.7 `tabelas_preco` / `tabela_preco_itens` — `precos-routes.js:47-66`

`tabelas_preco`: `nome` (NN, UNIQUE), `prioridade` (default 0), `vigenciaInicio`,
`vigenciaFim`, `ativo`.
`tabela_preco_itens`: `tabelaId` (NN), `produtoId` (NN), `preco` (NN),
`qtdMinima` (default 0), UNIQUE `(tabelaId, produtoId, qtdMinima)`.
Vínculo com cliente: `pessoas.tabelaPrecoId` (`precos-routes.js:84`).

### 2.8 `politicas_prazo` (condição de pagamento)

`nome` (NN, UNIQUE), `tipo` (NN, default `'prazo'`), `prazoDias` (TEXT, ex.
`'30/60/90'`), `meiosPermitidos` (JSON array), `valorMinimoParcela`, `coeficiente`,
`ignoraLimiteCredito`, `aplicaVendas` (default 1), `aplicaCompras`, `aplicaPdv`,
`ativo`.
Dados reais no tenant `1bit`: 9 políticas — `15 dias · 4 meios`, `À vista`,
`PIX à vista`, `Cartão de crédito`, `Boleto 30 dias`, `Boleto 30/60/90`,
`Faturamento 30 dias`, `Órgão público 30 dias`, `Fornecedor 28 dias`
(esta com `aplicaVendas=0`).

### 2.9 `tipos_operacao` — `tipos-operacao-routes.js`

`codigo` (NN), `descricao` (NN), `categoriaOperacao`, `finalidadeNFe`,
`geraFinanceiro`, `movimentaEstoque`, `gerencial`, `emiteNFe`, `cfopInterno`,
`cfopInterestadual`, `cfopExterior`, `usarEmPedido`, `usarEmOS`, `usarEmDevolucao`,
`usarEmNFAvulsa`, `ativo`.

Dados reais no `1bit` (`usarEmPedido=1`): `VDA-NORMAL` (id 1), `VDA-BONIF` (2),
`VDA-NAOFISCAL` (3), `REM-SIMPLES` (4), `TRANSF` (8), `VENDA SEM MOVIMENTO` (20),
`VDA-ORDEM` (109). É este cadastro que decide se a operação emite NF-e, gera
financeiro e movimenta estoque.

### 2.10 Frete

Não há tabela de frete: são três colunas em `pedidos` — `transportadoraId`
(→ `transportadoras`), `tipoFrete` (TEXT livre; **valores aceitos não validados no
backend** — o PUT grava o que vier), `valorFrete` (REAL, entra no `valorTotal` em
`pedidos-routes.js:107`).
Valores de `tipoFrete` em uso no `1bit` (27 pedidos): `'0'` (2), `'1'` (2), `'9'` (1),
`NULL` (22) — são os códigos `modFrete` da SEFAZ (0 = por conta do emitente/CIF,
1 = por conta do destinatário/FOB, 9 = sem frete), mas **nada no backend impõe esse
domínio**.
`transportadoras`: `cpfCnpj` (NN, UNIQUE), `razaoSocial` (NN), + endereço/contato
(`db-schema.js:969-983`).

### 2.11 Vendedor

`users.ehVendedor` (INTEGER, default 0), `users.comissaoPercentual`,
`users.metaMensal`, `users.vendedorTipo`. `pedidos.vendedorId` aponta para
`users.id` **sem FK declarada**. A tela busca a lista em `/api/usuarios?vendedor=1`
(`pedido.html:1365`).

### 2.12 Estoque

`movimentacoes_estoque`: `produtoId` (NN), `tipo` (NN — `entrada`/`saida`/ajuste),
`quantidade` (NN), `data` (NN), `custoUnitario`, `origem`, `origemId`, `loteId`,
`serialId`, `custoMedioAnterior`, `custoMedioPosterior`, `saldoPosterior`,
`estornada`, `movEstornoId`, `movOriginalId`, `depositoId`.
`reservas_estoque` (`reservas-routes.js:23-40` + ALTERs): `produtoId` (NN),
`loteId`, `quantidade` (NN), `pedidoId` (NN), `pedidoItemId`, `status` (NN, default
`'ativa'`), `dataConsumo`, `movimentacaoConsumoId`, `osId`, `osItemPecaId`,
`depositoId`.
`depositos`: `nome` (NN), `tipo` (NN, default `'interno'`), `padrao`, `ativo`,
`estabelecimentoId`. No `1bit`: id 1 `Principal` (padrão), id 2 `DEPÓSITO TESTE`.

### 2.13 Faturamento

`faturas` (`faturas-routes.js:51-81`): `numero` (NN, UNIQUE), `pedidoId` (NN),
`clienteId` (NN), `dataEmissao` (NN), `dataVencimento` (NN), `valorBruto` (NN),
`valorFrete`, `valorDesconto`, `valorTotal` (NN), `meioPagamento`, `observacao`,
`contaReceberId`, `status` (default `'emitida'`), `chaveAcesso`,
`protocoloAutorizacao`, `numeroNFe`, `serieNFe`, `xmlAssinado`, `statusSefaz`,
`dataAutorizacaoSefaz`, + `excluida`/`dataExclusao`/`motivoExclusao`/
`observacaoInterna` (`:103-106`) + `tipoOperacaoId`/`estabelecimentoId` (usados no
INSERT em `:214`).
FKs: `pedidoId → pedidos`, `clienteId → pessoas`, `contaReceberId → contas_a_receber`.
`fatura_itens` (`:83-98`): `faturaId` (NN), `produtoId`, `sku`, `descricao` (NN),
`unidade`, `quantidade` (NN), `precoUnitario` (NN), `valorTotal` (NN), `ncm`,
`cfop`, `origem`.
`contas_a_receber`: uma linha por parcela (`faturas-routes.js:307-321`), com
`pessoaId`, `faturaId`, `descricao`, `valor`, `dataEmissao`, `dataVencimento`,
`formaPagamento`, `origem`, `parcelaNumero`, `totalParcelas`, `grupoParcelaId`,
`adquirenteCartaoId`.

### 2.14 Diagrama de ligações (só o que importa aqui)

```
pessoas ──1:N── pedidos ──1:N── pedido_itens ──N:1── produtos
   │              │  │                                   │
   │              │  └──1:N── pedido_parcelas ──N:1── adquirentes_cartao
   │              │  └──1:N── pedido_historico
   │              │  └──1:N── reservas_estoque ──1:1── movimentacoes_estoque (consumo)
   │              └──1:1── faturas ──1:N── fatura_itens
   │                          └──1:N── contas_a_receber
   ├── tabelaPrecoId ──> tabelas_preco ──1:N── tabela_preco_itens
   └── politicaPrazoId ──> politicas_prazo
pedidos.vendedorId ──> users (sem FK)
pedidos.tipoOperacaoId ──> tipos_operacao (sem FK)
pedidos.depositoId ──> depositos (sem FK)
pedidos.transportadoraId ──> transportadoras (sem FK)
```

---

## 3. CAMPOS OBRIGATÓRIOS — os três níveis

### 3.1 Obrigatório no BANCO (`NOT NULL` sem default utilizável)

| Tabela | Coluna | Quem preenche hoje |
|---|---|---|
| `pedidos` | `numero` | backend, `gerarNumero()` |
| `pedidos` | `dataPedido` | backend, `dataBrasilia()` |
| `pedidos` | `tipo` | default `'manual'` |
| `pedidos` | `status` | default `'rascunho'` |
| `pedidos` | `modoDocumento` | default `'pedido'` |
| `pedidos` | `naoEmitirNFe` | default `0` |
| `pedido_itens` | `pedidoId`, `descricao`, `quantidade`, `precoUnitario`, `valorTotal` | backend |

**Nenhum campo enviado pelo cliente HTTP é NOT NULL no banco.** `clienteId` é
nullable; `vendedorId` é nullable; `valorTotal` tem default 0.

### 3.2 Obrigatório na VALIDAÇÃO DO BACKEND

**Para `POST /api/pedidos` (criar): NADA.** Um `POST` com corpo `{}` cria um
rascunho válido. Único caso de erro: `clienteId` apontando para pessoa inexistente
ou inativa → 404 (`pedidos-routes.js:341-343`).

Para os passos seguintes:

| Operação | Exige | Onde |
|---|---|---|
| `POST /:id/itens` | `descricao`, `quantidade`, `precoUnitario != null` | `pedidos-routes.js:701-703` |
| `PUT /:id` com meio/política | política do cliente respeitada; meio na whitelist | `:542-559` |
| `PUT /:id/parcelas` | por parcela: `valor > 0`, `dataVencimento`, `meioPagamento`, bandeira se cartão; soma = `valorTotal` | `:1156-1197` |
| `POST /:id/confirmar` | `modoDocumento != 'orcamento'`, `status='rascunho'`, **`clienteId`**, **≥1 item** | `:807-811` |
| `POST /:id/entregar` | `status ∈ {confirmado, em_separacao}` | `:849-851` |
| `POST /:id/faturar` | **`clienteId`**, **`status='entregue'`**, **≥1 item**, **`valorTotal > 0`** | `faturas-routes.js:156-180` |
| `POST /:id/cancelar` e `/reabrir` | `motivo` não vazio | `:964`, `:1054` |

### 3.3 Obrigatório SÓ NA TELA (o backend aceitaria vazio)

| Campo | Regra da tela | Backend |
|---|---|---|
| `meioPagamento` | `salvarHeader()` bloqueia salvar pedido (não orçamento) sem meio e sem parcelas — `pedido.html:1550-1555` | aceita `NULL` sem reclamar |
| `descricao` do item | `addItem()` exige (`pedido.html:1708`) | também exige — coincide |
| `quantidade > 0` | `pedido.html:1709` | backend só testa `!quantidade` (0 e negativo caem, mas `-5` passa em `POST /itens`) |
| `precoUnitario >= 0` | `pedido.html:1710` | backend só testa `!= null` — **aceita negativo** |
| `vendedorId` | select preenchido com o usuário logado | default `req.session.userId`; **`null` via `X-Api-Key`** |
| `depositoId` | select carregado de `/api/depositos` | default `resolverDeposito(db,{})` = depósito padrão |
| `tipoOperacaoId` | select `/api/tipos-operacao?usoPedido=1` (`pedido.html:1096`) | **`NULL` é aceito** e trata como `VDA-NORMAL` implícito (movimenta estoque, gera financeiro, emite NF-e) |
| `tabelaPrecoId` | select opcional | `NULL` = resolução automática |
| endereço de entrega | opcional (override do cadastro) | `NULL` = usa o do cliente |

### 3.4 Recorte prático: o MÍNIMO que o app precisa enviar

Para um pedido que percorre o fluxo inteiro até a NF-e, sem tratamento especial:

**Cabeçalho** (`POST /api/pedidos` + `PUT /api/pedidos/:id`):
- `clienteId` — obrigatório a partir do `confirmar`;
- `vendedorId` — obrigatório **na prática** se o app autenticar por `X-Api-Key`;
- `tipoOperacaoId` — recomendado (ex.: `VDA-NORMAL`); sem ele o CFOP cai no padrão e a fatura não sabe se gera financeiro/estoque por regra explícita;
- `meioPagamento` (tPag SEFAZ: `'15'` boleto, `'17'` PIX, `'01'` dinheiro, `'03'`/`'04'` cartão) — exigido de fato na emissão da NF-e;
- `politicaPrazoId` — obrigatório **se** o cliente tiver política vinculada (o PUT recusa outra);
- `depositoId` — opcional (cai no padrão);
- opcionais: `dataEntregaPrevista`, `codigoPedidoCliente`, `observacao`, frete (`transportadoraId`, `tipoFrete`, `valorFrete`), endereço de entrega.

**Itens** (por item): `descricao`, `quantidade`, `precoUnitario`, e `produtoId`
sempre que for produto de catálogo — **sem `produtoId` não há reserva, não há baixa
de estoque, e a fatura sai sem SKU/NCM/unidade** (`faturas-routes.js:233-236`).

**Cliente**: tem de existir em `pessoas` com `ativo = 1`. Para NF-e, precisa de
`cpfCnpj` válido e endereço (`nfe-emit-routes.js:520-521`).

**Condição de pagamento**: `politicaPrazoId` + `meioPagamento` compatível, ou lista
em `pedido_parcelas`.

**Frete**: nada é obrigatório.

**Vendedor**: `vendedorId` (`users.id`, idealmente com `ehVendedor=1`).

**Outros**: `modoDocumento='pedido'` (default). Não enviar `numero`, `status`,
`valorTotal` — são do backend.

---

## 4. NUMERAÇÃO

**Arquivo e função:** `pedidos-routes.js:91-101`, `gerarNumero(db, modo = 'pedido')`.
Exportada em `pedidos-routes.js:1471` justamente para outra porta de entrada
reusá-la (comentário em `:1468-1470`).

```js
function gerarNumero(db, modo = 'pedido') {
  const ano = new Date().getFullYear();
  const prefixo = `${modo === 'orcamento' ? 'ORC' : 'PED'}-${ano}-`;
  const row = db.prepare(`SELECT numero FROM pedidos WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefixo + '%');
  let seq = 1;
  if (row) { const n = parseInt(row.numero.slice(prefixo.length), 10); if (!isNaN(n)) seq = n + 1; }
  return `${prefixo}${String(seq).padStart(5, '0')}`;
}
```

- **Formato:** `PED-2026-00015` / `ORC-2026-00015`. Sequência de 5 dígitos, reinicia por ano (o prefixo contém o ano).
- **É por tenant?** Sim, por consequência da arquitetura: cada tenant tem seu `pncp.db` e o `SELECT` roda no `db` do tenant. Não há sequência global.
- **Contador/sequência/max+1?** Nenhum contador dedicado. É **"último inserido + 1"** — e note que é `ORDER BY id DESC`, **não** `MAX(numero)`. Se um número maior existir num `id` menor (possível via `converter-modo`, `pedidos-routes.js:673`, que regera o número de um pedido antigo), a sequência pode repetir um número já usado → `UNIQUE constraint failed: pedidos.numero`. Cenário não reproduzido nesta auditoria: **não confirmado** na prática.
- **Backend ou tela?** **100% backend.** A tela nunca envia `numero`; `POST /api/pedidos` não lê `numero` do corpo (`pedidos-routes.js:338`), e o campo não está em `CAMPOS_PEDIDO` (`:62-78`), então o `PUT` também não permite alterá-lo. **Confirmado: o backend continua dono da numeração — o app não precisa (nem consegue) gerar número.**
- **Risco de corrida:** o par SELECT+INSERT **não está em transação** no `POST /api/pedidos` (`:350-355`). Dentro de um mesmo processo Node isso não corre risco: `better-sqlite3` é síncrono e não há `await` entre gerar e inserir. O risco real é **entre processos** que escrevam no mesmo `pncp.db`. Hoje só o `consulta-licitacoes.service` (`server.js`) cria pedidos por HTTP; `scheduler.js` não insere em `pedidos`. Se o app móvel for atendido pelo mesmo processo, o risco continua nulo; **se algum dia houver um segundo worker, dois pedidos simultâneos podem colidir em `numero` (UNIQUE) e um deles morre com HTTP 500.** Vale notar que `loja-routes.js:338-350` já faz a coisa certa: gera e insere dentro de `db.transaction()`.

### Outras numerações no mesmo `pedidos` (para não confundir)

- `marketplaces-ml.js:298-302`: `'ML-' + n(6)`, com `n` derivado de `SELECT numero FROM pedidos ORDER BY id DESC LIMIT 1` + regex — **não usa `gerarNumero`**.
- `marketplaces-routes.js:149-153`: número puramente numérico de 6 dígitos — idem.
- `os-routes.js:2194`: `String(numPed).padStart(6,'0')` para o pedido gerado pela OS — idem.
Essas três não colidem com `PED-…` porque o `LIKE 'PED-2026-%'` de `gerarNumero` as ignora.

---

## 5. PREÇO

### 5.1 Como o preço é definido

Função central: `resolverPreco(db, produtoId, { pessoaId, quantidade, tabelaId })`
em `precos-routes.js:127-165`. Cadeia, em ordem de precedência:

| # | Fonte | Condição | `fonte` retornada |
|---|---|---|---|
| 0 | `pedidos.tabelaPrecoId` (tabela forçada no pedido) | tabela existe e está vigente e tem o produto | `tabela_forcada` |
| 1 | `pessoas.tabelaPrecoId` (tabela do cliente) | idem | `tabela_cliente` |
| 2 | Tabelas gerais ativas, por `prioridade DESC, id` | primeira que tiver o produto e estiver vigente | `tabela` |
| 3 | `produtos.precoVenda` | sempre | `produto` |

Vigência: `tabelaVigente()` (`precos-routes.js:116-121`) — `ativo=1` e data de hoje
(Brasília) dentro de `vigenciaInicio`/`vigenciaFim`.
Quantidade: dentro de cada tabela, escolhe a linha de **maior `qtdMinima <= quantidade`**
(`precos-routes.js:131-134`) — faixas de preço por volume.

Endpoint exposto: `GET /api/precos/resolver?produtoId=&pessoaId=&quantidade=&tabelaId=`
(`precos-routes.js:398-411`).

### 5.2 Onde a tela usa

`resolverPrecoItem()` em `pedido.html:1666-1687`: ao escolher o produto, a tela
chama `/api/precos/resolver` com `produtoId`, `quantidade`, `pessoaId` (= cliente do
pedido) e `tabelaId` (= `pedidos.tabelaPrecoId`), e **preenche o campo de preço**,
mostrando a origem (`fonteLabel()`, `:1688-1693`). O vendedor pode digitar por cima.

### 5.3 O ponto central — o backend recalcula ou aceita?

**O backend ACEITA o valor que o frontend mandou. Não recalcula, não valida, não
compara com nada.**

Provas:

- `POST /api/pedidos` (`pedidos-routes.js:357-364`): `const qtd = Number(it.quantidade), pu = Number(it.precoUnitario);` e insere `pu` direto. **`resolverPreco` não é chamado**; `precos-routes` só é requerido em `pedidos-routes.js:21` para vendas perdidas.
- `POST /api/pedidos/:id/itens` (`:704, :719-721`): mesma coisa — `pu = Number(precoUnitario)` vai direto para o INSERT.
- `PUT /api/pedidos/:id/itens/:itemId` (`:742-746`): idem.
- Não há checagem contra `produtos.precoMinimoVenda`, `precoCusto`, `markupMinimo` ou desconto máximo em nenhum desses caminhos (grep por `precoMinimoVenda` não retorna ocorrência em `pedidos-routes.js`).
- `precoUnitario` negativo **é aceito** (a única barreira, `pu < 0`, está na tela — `pedido.html:1710`). É assim que a OS lança desconto (`os-routes.js:2268`).

**Desconto:** não existe campo de desconto em `pedidos` nem em `pedido_itens`.
Desconto no pedido só existe como preço unitário menor, ou como item negativo.
Existe `faturas.valorDesconto`, aplicado **no faturamento**, vindo do corpo do
`POST /:id/faturar` (`faturas-routes.js:176`).

**Permissões de preço:** não há RBAC de preço. O gate de perfil
(`perfis-acesso.js:150-161`) é por **prefixo de API** (`/api/pedidos`), não por campo
— quem pode criar pedido pode pôr qualquer preço. Com `X-Api-Key` nem o gate de
prefixo se aplica.

**Consequência para o app:** o app é responsável pelo preço que enviar. Se quiser o
mesmo comportamento da tela, deve chamar `GET /api/precos/resolver` antes de montar
o item — o backend não fará isso por ele. Se a intenção for impedir o vendedor de
digitar preço à mão, essa regra **não existe hoje** e teria de ser criada.

---

## 6. ESTOQUE

Resposta curta: **criar pedido NÃO mexe em estoque. Confirmar RESERVA. Entregar
BAIXA. Faturar não mexe.**

### 6.1 Criar — nenhum efeito

`POST /api/pedidos` (`pedidos-routes.js:336-371`) não toca `movimentacoes_estoque`
nem `reservas_estoque`. (A loja virtual é diferente: `loja-routes.js:355` chama
`criarReservasPedido` logo após criar o rascunho — decisão própria dela.)

### 6.2 Confirmar — reserva virtual

`confirmarPedidoInterno` (`pedidos-routes.js:804-831`) → `criarReservasPedido(db, pedidoId)`
em **`reservas-routes.js:133-202`**. Dentro da transação de `pedidos-routes.js:815-820`.

- Gate: se `tipos_operacao.movimentaEstoque = 0` do pedido, retorna vazio e não reserva nada (`reservas-routes.js:137-139`, via `pedidoMovimentaEstoque()` em `:95-100`). Pedido **sem** `tipoOperacaoId` movimenta (comportamento legado, `:97`).
- Kits são explodidos em componentes (`explodirItensPedido`, `:111-127`).
- Item **sem `produtoId` é ignorado** (`:150`).
- Produto com `rastreiaLote`: aloca lotes FIFO por validade (`alocarLotesFIFO`, `:63-88`).
- Produto sem lote: calcula `saldoFisico = SUM(entradas - saidas)` sobre `movimentacoes_estoque` **global, sem recorte de depósito** (`:172-177`), subtrai reservas ativas (`saldoReservado`, `:50-57`), e **cria a reserva mesmo se faltar saldo**, apenas registrando a insuficiência (`:180-198` — comentário explícito em `:192`).
- `INSERT INTO reservas_estoque (produtoId, loteId, quantidade, pedidoId, pedidoItemId, status='ativa', depositoId)` — `reservas-routes.js:164-167` e `:193-196`.
- Se houve insuficiência e o chamador não mandou `{forcar:true}`, a transação é revertida e o endpoint devolve **409** (`pedidos-routes.js:818, 824-827`).

**Reserva não altera saldo físico** — é linha em `reservas_estoque`, descontada do
"disponível" nas consultas.

### 6.3 Entregar — baixa real

`POST /api/pedidos/:id/entregar` (`pedidos-routes.js:845-908`), tudo em transação
(`:854-901`):

1. `consumirReservasPedido(db, pedidoId, dataEntrega)` — **`reservas-routes.js:370-415`**. Para cada reserva ativa: `INSERT INTO movimentacoes_estoque (produtoId, tipo='saida', quantidade, origem='pedido', origemId=pedidoId, observacao, data, loteId, custoMedioAnterior, custoMedioPosterior, saldoPosterior, depositoId)` (`reservas-routes.js:387-399`); `UPDATE lotes SET saldoAtual = saldoAtual - ?` se houver lote (`:405`); `UPDATE reservas_estoque SET status='consumida', movimentacaoConsumoId=?` (`:408-412`).
2. Fallback para itens sem reserva (pedidos antigos): `INSERT INTO movimentacoes_estoque ... 'saida' ... 'Saída pelo pedido X (sem reserva)'` — **`pedidos-routes.js:873-885`**. Só roda se `tipos_operacao.movimentaEstoque` for verdadeiro (`:868-871`) e só para itens com `produtoId` (`:876`).
3. `UPDATE pedidos SET status='entregue', dataEntregaReal=?` (`:887-888`).

### 6.4 Faturar — nada

`POST /api/pedidos/:id/faturar` (`faturas-routes.js:149-385`) **não emite nenhuma
movimentação de estoque**. Ele exige que o pedido já esteja `entregue` justamente
porque a baixa acontece antes (mensagem literal em `faturas-routes.js:162`).

### 6.5 Cancelar / reabrir — estorno

- `cancelarPedidoInterno` (`pedidos-routes.js:952-1013`): se `entregue`, `estornarEstoque()` (`:158-178`) cria movimentações de **entrada** compensatórias com `origem='estorno_pedido'`; se `confirmado`/`em_separacao`, `cancelarReservasPedido()` (`reservas-routes.js:356-363`).
- `reabrir` (`:1042-1098`): estorna saídas se vinha de `entregue` (`:1063`) e recria reservas quando o destino é `confirmado`/`em_separacao` (`:1074-1085`).

### 6.6 Depósito

`resolverDeposito()` em **`estoque-routes.js:234-258`**: usa o `depositoId`
informado; senão o da movimentação original; senão o da saída/reserva anterior do
mesmo pedido+produto; senão `getDepositoPadraoId(db)`.

---

## 7. FATURAMENTO — o encadeamento depois do pedido salvo

### 7.1 Status

`STATUS_VALIDOS = ['rascunho','confirmado','em_separacao','entregue','faturado','cancelado']`
(`pedidos-routes.js:29`).
`STATUS_PAGAMENTO = ['pendente','parcial','pago']` (`:30`).

Transições, e por qual endpoint:

```
rascunho ──POST /confirmar──> confirmado ──POST /status {em_separacao}──> em_separacao
                                   │                                            │
                                   └──────────POST /entregar────────────────────┘
                                                     ↓
                                                 entregue ──POST /faturar──> faturado
qualquer (≠faturado c/ fatura emitida) ──POST /cancelar {motivo}──> cancelado
qualquer ──POST /reabrir {motivo}──> status anterior (TRANSICAO_REABRIR, :1034-1040)
```

`POST /api/pedidos/:id/status` (`:910-944`) muda status genericamente, mas
**recusa `entregue`** (`:919-921`: "Use POST /entregar para baixar estoque").

### 7.2 Aprovação / alçada

**Não existe.** Grep por `alcada` e `aprovacao` em `pedidos-routes.js` e
`faturas-routes.js` não retorna nada. O pedido vai de rascunho a faturado sem
passar por aprovação. (Há um módulo de alçadas no sistema — `/api/alcadas`,
`governanca-avisos.js` — mas ele **não** está fiado no fluxo de pedido.)

### 7.3 O que `POST /api/pedidos/:id/faturar` exige

`faturas-routes.js:149-385`. Barreiras, em ordem:

| Checagem | Linha |
|---|---|
| pedido existe | `:155` |
| `pedido.clienteId` não nulo | `:156` |
| `status != 'faturado'` | `:157` |
| `status != 'cancelado'` | `:158` |
| **`status === 'entregue'`** | `:159-164` |
| ≥ 1 item em `pedido_itens` | `:173` |
| `valorTotal = valorBruto + valorFrete - valorDesconto > 0` | `:180` |
| se meio é cartão (`03`/`04`): `bandeiraId` no corpo + adquirente ativo | `:295-301` |
| se há `pedido_parcelas`: soma = `valorTotal` (±0,01) | `:255-258` |
| se meio à vista em dinheiro: conta financeira padrão configurada | `:327-328` |

O que ele **lê do pedido**: `clienteId`, `status`, `valorFrete`, `tipoOperacaoId`,
`meioPagamento`, `dataFaturamentoPrevista`, `naoEmitirNFe`, `numero`, itens (+ dados
do produto: `sku`, `unidade`, `ncm`, `cfopPadrao`, `origem`), `pedido_parcelas`.

O que ele **decide a partir do `tipoOperacaoId`** (`:184-200`):
- `geraFinanceiro = 0` → **não cria `contas_a_receber`**, só marca o pedido faturado (`:241-245`);
- `emiteNFe = 0` → fatura nasce com `statusSefaz = 'nao_fiscal'` (`:200, :219`);
- sem `tipoOperacaoId` → assume `geraFinanceiro=1`, `emiteNFe=1` (comportamento legado).

Vencimento e parcelamento (`:189-284`): `b.dataVencimento` → `pedido.dataFaturamentoPrevista`
→ prazo do cadastro do cliente (`prazoDaPessoa`) → `dataEmissao + 30`. Se o pedido
tem `pedido_parcelas`, elas mandam; senão, se o cliente tem prazo múltiplo
(`'30/60/90'`), a fatura sai parcelada; senão, 1 CR.

Auto-baixa: só `'01'` (dinheiro) hoje — `MEIOS_AVISTA_CAIXA` (`:19`);
`MEIOS_AVISTA_BANCO` está **vazio** (`:20`), PIX passou a gerar cobrança.
Auto-cobrança fire-and-forget para boleto (`'15'`) e PIX (`'17'`) em `:357-379`.

### 7.4 NF-e

`POST /api/faturas/:id/emitir-nfe` (`nfe-emit-routes.js:1031-1039`). Exigências que
dependem do pedido/cliente:
- emitente com CNPJ, UF e IE (`:226-229`) e certificado (`:257`) — cadastro da empresa, não do pedido;
- fatura com `status='emitida'`, `statusSefaz != 'nao_fiscal'` e não já autorizada (`:332-334`);
- ≥1 item (`:346`);
- destinatário: `cpfCnpj` do cliente (`:521`) e endereço;
- **meio de pagamento em todas as parcelas** — `throw` explícito em `:822-823`: *"defina o meio (tPag) no pedido antes de emitir"*;
- fatura que gera financeiro sem parcelas e sem meio → `throw` (`:880`).

### 7.5 Um pedido criado por API percorre isso sem tratamento especial?

**Sim** — e isso já está provado em produção por três integrações que criam pedido
sem passar pela tela:

| Porta | Arquivo/linha | Como nasce |
|---|---|---|
| Loja virtual | `loja-routes.js:340-343` | `tipo='manual'`, `status='rascunho'`, `origemLoja=1`, usa `gerarNumero` importado de `pedidos-routes` |
| Mercado Livre | `marketplaces-ml.js:300-302` | `tipo='marketplace'`, `status='confirmado'`, numeração própria `ML-000001` |
| Marketplaces genérico | `marketplaces-routes.js:152-156` | `tipo='marketplace'`, `status='confirmado'` |
| Ordem de serviço | `os-routes.js:2246-2250` | `tipo='os'`, `status='confirmado'` |

Ressalvas concretas para o app (todas evitáveis se ele enviar os campos certos):

1. Com `X-Api-Key`, `vendedorId` fica **NULL** por default (`pedidos-routes.js:348`) → o pedido some das metas e comissões. **Enviar sempre.**
2. Itens enviados no `POST /api/pedidos` nascem **sem CFOP** (`:361-363`). A fatura cai em `it.cfop || it.prodCfop` (`faturas-routes.js:228`): se o produto não tiver `cfopPadrao`, o item vai à SEFAZ sem CFOP. **Preferir criar o pedido vazio e adicionar itens por `POST /:id/itens`** (que roda `sugerirCFOP`), ou preencher `produtos.cfopPadrao`.
3. `tipoOperacaoId` não é definido pelo `POST` de criação — só pelo `PUT`. Sem ele, tudo se comporta como venda normal por omissão.
4. `meioPagamento` também só entra pelo `PUT`. Sem ele, a NF-e trava no grupo `<pag>`.
5. O `POST` de criação **não roda em transação**: um erro no meio dos itens deixa o pedido gravado com itens parciais e total desatualizado.

Ou seja: **o app não precisa de endpoint novo para funcionar** — a sequência
`POST /api/pedidos` → `PUT /api/pedidos/:id` → `POST /api/pedidos/:id/itens` (×N)
→ `POST /api/pedidos/:id/confirmar` já produz um pedido comercial idêntico ao da
tela. Um endpoint "criar pedido completo em uma chamada" seria conveniência (menos
round-trips no celular, atomicidade), não necessidade.

---

## 8. ORIGEM / CANAL / FONTE — o que já existe

**Sim, existem duas colunas**, e nenhuma delas foi criada para isso de forma geral:

### 8.1 `pedidos.tipo` — TEXT NOT NULL DEFAULT `'manual'`

É a coluna que hoje funciona como "canal". Valores **em uso real** no tenant `1bit`
(`SELECT tipo, modoDocumento, COUNT(*) FROM pedidos GROUP BY 1,2`):

| `tipo` | `modoDocumento` | Qtd | Quem grava |
|---|---|---:|---|
| `manual` | `pedido` | 19 | `pedidos-routes.js:353` (tela) e `loja-routes.js:342` (loja virtual) |
| `marketplace` | `pedido` | 4 | `marketplaces-ml.js:301`, `marketplaces-routes.js:154` |
| `licitacao` | `pedido` | 2 | `pedidos-routes.js:505` (importar participação) |
| `os` | `pedido` | 2 | `os-routes.js:2248` |

Varredura dos **11 tenants** com `pncp.db` (`SELECT COUNT(*)` + `group_concat(DISTINCT tipo)`),
feita em 2026-08-26 — **57 pedidos no total, e nenhum valor de `tipo` fora dos quatro acima**:

| Tenant | Pedidos | Valores de `tipo` |
|---|---:|---|
| `1bit` | 27 | manual, licitacao, os, marketplace |
| `produtosbomgosto` | 17 | manual |
| `josecarloscostafilho` | 10 | os, manual |
| `raeldouglas` | 2 | os |
| `jaagricola` | 1 | manual |
| `hseletricista`, `labfiscal`, `levezi`, `lojasemijoias`, `opendesk`, `pccontabilidade`, `reimac` | 0 | — |

**Não há CHECK constraint nem lista de valores válidos no código** — `tipo` é
gravado por literal em cada INSERT. A API `GET /api/pedidos?tipo=` filtra por ele
(`pedidos-routes.js:217`).

**`POST /api/pedidos` grava `tipo='manual'` fixo** (`:353`) — não lê `tipo` do corpo.
Um pedido vindo do app cairia como `manual`, indistinguível do digitado na tela,
a menos que se passe a aceitar o campo.

### 8.2 `pedidos.origemLoja` — INTEGER DEFAULT 0

Flag booleana **específica da loja virtual**, criada em `loja-routes.js:99`
(`ALTER TABLE pedidos ADD COLUMN origemLoja INTEGER DEFAULT 0`).
Gravada como `1` só em `loja-routes.js:342`; lida em `loja-routes.js:384, 395, 454`
para o comprador ver "meus pedidos". No `1bit` **todas as 27 linhas têm
`origemLoja = 0`** — a loja ainda não gerou pedido nesse tenant.

Não é um campo de canal genérico: é um booleano de um módulo.

### 8.3 `pedidos.modoDocumento` — não é origem

TEXT NOT NULL DEFAULT `'pedido'`, valores `'pedido'` | `'orcamento'`
(`pedidos-routes.js:80`). Distingue documento, não canal.

### 8.4 Conclusão do item 8

- **Coluna de canal existente e em uso: `pedidos.tipo`**, com os quatro valores
  acima. É o lugar natural para um `'app'` / `'mobile'`, mas hoje o
  `POST /api/pedidos` **não aceita** esse campo — teria de passar a aceitar.
- `origemLoja` existe mas é dedicada à loja; replicar o padrão (uma coluna booleana
  por canal) não escala.
- Não há coluna `origem`, `canal` ou `fonte` em `pedidos`. (Existe
  `pessoas.origem` — origem do *cliente*, `db-schema.js:2045` — e
  `vendas_perdidas.origem` e `contas_a_receber.origem`; nenhuma delas se aplica ao
  pedido.)

---

## 9. Resumo dos achados que mudam a decisão do projeto

1. **A porta já existe e já foi usada quatro vezes.** Loja virtual, Mercado Livre, marketplaces e OS criam pedido comercial normal por código, na mesma tabela, com a mesma numeração. O app é o quinto caso, não um caso novo.
2. **O backend não valida preço.** Aceita o que vier, inclusive negativo. Se o app permitir preço à mão sem regra, não há rede de proteção no servidor.
3. **A numeração é do backend e só dele.** Nem o `POST` nem o `PUT` deixam o cliente informar `numero`.
4. **`vendedorId` vira NULL com `X-Api-Key`.** É o erro mais provável de um app que autentique por chave — e ele é silencioso: o pedido nasce certo e some das comissões.
5. **Itens criados junto do pedido não ganham CFOP.** Usar `POST /:id/itens` ou aceitar o `cfopPadrao` do produto.
6. **Estoque só se move em `confirmar` (reserva) e `entregar` (baixa).** Criar pedido nunca mexe.
7. **Não há aprovação/alçada e não há limite de crédito no caminho do pedido.** Se o app precisar disso, é regra nova, não existente.
8. **`POST /api/pedidos` não é transacional** — diferente do que a loja virtual faz. Um endpoint dedicado ao app resolveria isso de graça.
9. **`pedidos.tipo` é o lugar do canal**, mas o `POST` atual força `'manual'`.

## 10. O que ficou "não confirmado"

- Se a colisão de `numero` por `converter-modo` (regeração de número em pedido antigo) chega a acontecer na prática — o caminho existe no código, não foi reproduzido.
- Comportamento sob concorrência real entre dois processos escrevendo no mesmo `pncp.db` — nenhum teste foi executado (esta etapa é só auditoria).
- A **lista de domínio** de `pedidos.tipoFrete`: não há validação nem constante no código. Os valores em uso (`0`, `1`, `9`) coincidem com o `modFrete` da SEFAZ, mas essa correspondência é inferência a partir dos dados, não algo declarado no repositório.
