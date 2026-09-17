# Catálogo Online + Pedidos PDV — auditoria técnica de encaixe no ERP

Data: 2026-09-10 · Caixa 5 — **auditoria, nenhuma implementação**.
Base: [`01`](01-pedido-ponta-a-ponta.md) · [`02`](02-acesso-dados-e-apis.md) ·
[`03`](03-arquitetura-mvp-e-roadmap.md) · [`04`](04-backend-preparado-para-app.md).

> **Nada foi alterado.** Nenhum arquivo de código, nenhuma tabela, nenhuma
> migration, nenhum serviço reiniciado, nenhum commit. Este documento é o único
> arquivo criado.

**Sobre o caminho do arquivo:** você pediu `docs/auditoria-app-mobile-2026-08-26/`
e mantive exatamente esse caminho. Registro a observação sem mudar nada: a pasta
tem nome de data e de *app móvel*, e este relatório não é sobre o app — é sobre
catálogo e PDV. Se em algum momento virar uma linha de trabalho própria, o lugar
natural seria `docs/catalogo-pdv/`. Fica como sugestão, não como mudança.

---

## Como ler as afirmações deste relatório

Toda afirmação de "já existe" abaixo vem com arquivo e linha, tabela ou rota.
Onde não consegui confirmar, está escrito **NÃO CONFIRMADO** — e é literal: quer
dizer que não achei, não que não exista.

Os números de linha são da **árvore de trabalho de hoje** (2026-09-10), que é a
produção. A árvore tem 271 entradas pendentes de commit (ver `CLAUDE.md`), então
`git show` do HEAD pode divergir.

---

## A. Resumo executivo

**O encaixe é bom, e é melhor do que parece — mas por um motivo que muda o
plano: quase tudo o que você descreveu já existe no repositório, em três lugares
diferentes, e nenhum deles é o pedido comercial.**

Os três lugares:

| Peça pronta | Onde | O que resolve do seu pedido |
|---|---|---|
| **Loja virtual** (`loja-routes.js`, 552 linhas) | vitrine pública + carrinho + checkout + cobrança Pix/boleto, já **ativa em produção no tenant `1bit`** | §5, §8, §10, §13 parcialmente |
| **Cardápio público do restaurante** (`restaurante/cardapio-publico-routes.js`, 360 linhas) | catálogo por QR, **grupos de opção com mín/máx e preço adicional**, taxa de entrega por bairro, pedido online com aceite | §9 quase inteiro, §12 |
| **PDV de varejo** (`public/varejo/pdv.html` + `nfce-routes.js`) | balcão com leitor de código de barras, múltiplos meios de pagamento, NFC-e | §14, §17 parcialmente |

O problema é que **os três desembocam em modelos diferentes**: a loja virtual
cria `pedidos` (é o único que acerta o seu §1); o cardápio cria `rest_comandas`;
o PDV cria `nfce` e **não cria pedido nenhum**. A sua exigência central — "o
pedido continua sendo o pedido comercial normal do ERP" — hoje só é satisfeita
por um dos três.

Cinco conclusões que mudam o desenho:

1. **A loja virtual é a base do Catálogo Online, não um concorrente dele.** Ela
   já faz vitrine, carrinho no servidor, pedido no ERP, reserva de estoque e
   cobrança Pix/boleto pelo financeiro existente. O que falta é o que você pediu
   e ela não tem: categorias com ordenação, destaques, página de boas-vindas,
   personalizações, cupons, entrega/retirada e **checkout sem login**.
2. **O modelo de personalização que você descreveu (balão: nome, cor, recadinho
   +R$ 5) está pronto e validado no servidor** — em `rest_grupos_opcao`,
   `rest_opcoes`, `rest_produto_grupos` e `rest_comanda_item_opcoes`. Só que
   pendurado na comanda, não no `pedido_itens`. Essa é a decisão de arquitetura
   mais cara deste projeto (ver §P e §X-1).
3. **O checkout sem login é o maior buraco do seu §2A.** Hoje a loja exige
   `cliente_logins`, e essa credencial **só é criada pelo administrador**
   (`POST /api/portal/credencial`). Não existe auto-cadastro de comprador. Sem
   isso, o consumidor da Art's Presentes não compra.
4. **O PDV atual não serve de base para "Pedidos PDV".** Ele é fiscal-first:
   emite NFC-e e deriva financeiro e estoque da natureza de operação
   (`nfce-routes.js:95`). Não cria pedido, não passa por `precoDeItem` e aceita
   `precoUnitario` e `valorDesconto` crus do navegador. É outro produto — e
   convive, não substitui.
5. **A política de preço que acabamos de endurecer tem duas portas abertas
   fora dela**, e as duas afetam diretamente este projeto: `pedidos.valorFrete`
   aceita valor negativo e entra no total (`pedidos-routes.js:110`), e o PDV/NFC-e
   não valida preço nenhum. Detalhes em §T.

**Não recomendo criar um segundo modelo de pedido.** Recomendo estender
`pedido_itens` com duas tabelas satélite e uma coluna de desconto, generalizar os
grupos de opção para fora do restaurante, e transformar a loja virtual no
Catálogo Online. Fases em §V.

---

## B. O que já existe e pode ser reutilizado

### B.1 Loja virtual pública — a base do Catálogo Online

`loja-routes.js`, registrada em dois lugares por decisão de segurança
(`loja-routes.js:14-17`):

| Rota | Onde | O que faz |
|---|---|---|
| `GET /loja/api/config` | `loja-routes.js:209` | identidade da loja (nome, logo, WhatsApp, tema); **404 se `loja_config.ativa = 0`** |
| `GET /loja/api/produtos` | `loja-routes.js:223` | vitrine com busca, filtro por categoria, fotos, preço e rótulo de estoque |
| `GET /loja/api/produtos/:id` | `loja-routes.js:416` | detalhe do produto |
| `GET/POST /loja/api/carrinho` | `loja-routes.js:292`, `:299` | **carrinho no servidor** (`loja_carrinho`), não no navegador |
| `POST /loja/api/pedido` | `loja-routes.js:322` | fecha o carrinho **como pedido do ERP** |
| `GET /loja/api/meus-pedidos` | `loja-routes.js:378` | histórico do comprador |
| `GET /loja/api/pedido/:id/cobranca` | `loja-routes.js:391` | reabre o Pix/boleto |
| `GET/PUT /api/loja/config` | `loja-routes.js:442`, `:462` | administração (atrás do login) |
| `POST /api/loja/logo` | `loja-routes.js:490` | upload de logo com validação por assinatura de arquivo |
| `GET /api/loja/produtos` | `loja-routes.js:517` | lista para o lojista escolher o que publicar |
| `POST /api/loja/produtos/publicar` | `loja-routes.js:536` | publica/despublica em lote |

Cinco decisões dela que valem herdar inteiras:

- **Preço nunca vem do navegador.** O carrinho guarda só `produtoId` e
  `quantidade`; o preço é resolvido item a item por `resolverPreco` no momento de
  ler o carrinho (`loja-routes.js:268-287`) e de novo no fechamento.
- **Coluna explícita no SELECT público** (`loja-routes.js:232-233`): `SELECT *`
  ali publicaria `precoCusto` e `markupVenda` para a internet.
- **Estoque vira rótulo, não número** (`rotuloEstoque`, `loja-routes.js:128`):
  `sob-consulta` / `ultimas` / `disponivel`. Já é a resposta ao seu §19.
- **Disponível = saldo − reservado** (`disponivelDe`, `loja-routes.js:115`), a
  mesma conta do resto do ERP.
- **A cobrança reusa o financeiro inteiro** (`emitirCobranca`,
  `loja-routes.js:152`): cria `contas_a_receber` amarrada ao `pedidoId` e emite
  pela régua de provedores existente. Não há caminho de pagamento paralelo.

**Estado em produção, lido agora nos bancos:**

| Tenant | `loja_config.ativa` | Produtos publicados | Modo de pagamento |
|---|---|---|---|
| `1bit` | **1 (no ar)** | 2 | `pix-ou-boleto` |
| `produtosbomgosto` | 0 | 0 | `nenhum` |
| `reimac` | 0 | 0 | `nenhum` |

Frontend: `public/loja/index.html`, 493 linhas, um arquivo só, com
`<meta name="viewport">` e 1 media query.

### B.2 Personalizações — prontas, no módulo errado

`restaurante/restaurante-schema.js`:

| Tabela | Linha | Colunas que interessam |
|---|---|---|
| `rest_grupos_opcao` | `:126` | `nome`, **`minEscolhas`**, **`maxEscolhas`**, `ordem`, `ativo` |
| `rest_opcoes` | `:136` | `grupoId`, `nome`, **`precoAdicional`**, `insumoProdutoId`, `quantidadeInsumo` |
| `rest_produto_grupos` | `:150` | liga produto ↔ grupo, com `ordem` |
| `rest_comanda_item_opcoes` | `:292` | **snapshot** de `nome` e `precoAdicional` no item |

Isso é exatamente o seu §9: "escolha um nome para o balão" é um grupo 1..1,
"escolha a cor" é outro grupo 1..1, "deseja recadinho? +R$ 5,00" é um grupo 0..1
com `precoAdicional = 5`. O `insumoProdutoId` até resolve o adicional que consome
estoque próprio.

E a validação no canal público **já é server-side e já está certa**
(`restaurante/cardapio-publico-routes.js:170-201`): o preço do item vem de
`rest_cardapio_itens`, as opções são conferidas contra os grupos daquele produto,
`minEscolhas`/`maxEscolhas` são exigidos, e o adicional é somado no servidor. O
comentário na linha `:173` é literal: *"Preço vem SEMPRE do servidor. O que o
cliente mandar é ignorado."*

O snapshot de nome e preço em `rest_comanda_item_opcoes` responde ao seu "essas
escolhas precisam ficar vinculadas ao item do pedido para que o funcionário veja
exatamente o que foi solicitado".

### B.3 Produtos, atributos e imagens

- **`produtos`** (76 colunas): `sku` UNIQUE, `descricao`, `unidade`, `precoVenda`,
  `precoMinimoVenda`, `categoria` (TEXT livre), `marca`, `modelo`, `cor`,
  `material`, `genero`, `imagemPath`, `codigoBarras`, `ativo`,
  **`publicadoNaLoja`** (criada pela loja, `loja-routes.js:81`).
- **`produto_lookup (tipo, valor, ativo)`** — **já é a tabela de "Atributos" que
  você quer**. `produto-lookup-routes.js:13` define
  `LOOKUP_TIPOS = ['categoria','marca','modelo','cor','material','genero','unidade']`
  e um CRUD único serve os sete: `GET/POST /api/produto-lookup/:tipo`,
  `DELETE /api/produto-lookup/:tipo/:valor`.
- **As cinco telas do menu Catálogo são a MESMA tela cinco vezes.**
  `public/catalogo/marcas.html`, `modelos.html`, `cores.html`, `materiais.html`
  e `generos.html` chamam `/api/produto-lookup/<tipo>` e nada mais. Conferido um
  a um.
- **`produto_imagens`** (`produto-imagens.js:29`): N fotos por produto, com
  `ordem`, `origem`, `urlOrigem`, `autorizadoPor` — a galeria do catálogo já
  existe. `tipoReal(buf)` (`:81`) valida **assinatura do arquivo**, não o
  `content-type` declarado.
- Upload: `POST /api/produtos/:id/imagem` (`produtos-routes.js:603`), multer com
  limite de 5 MB.

### B.4 Pedido comercial

- **`pedidos`** (43 colunas) já tem tudo o que catálogo e PDV precisam no
  cabeçalho: `clienteId`, `status`, `vendedorId`, `tabelaPrecoId`, `depositoId`,
  `meioPagamento`, `politicaPrazoId`, `tipoFrete`, `valorFrete`, `tipoOperacaoId`,
  **endereço de entrega completo** (`enderecoEntrega`, `numeroEntrega`,
  `complementoEntrega`, `bairroEntrega`, `cidadeEntrega`, `ufEntrega`,
  `cepEntrega`, `codigoMunicipioEntrega`, `contatoEntrega`, `telefoneEntrega`),
  `modoDocumento` (pedido/orçamento) e **`origemLoja`**.
- **`pedido_itens`**: `pedidoId`, `produtoId`, `descricao`, `quantidade`,
  `precoUnitario`, `valorTotal`, `cfop`. **Só isso** — ver §C.1.
- **`pedido_parcelas`**: `numeroParcela`, `valor`, `dataVencimento`,
  `meioPagamento`, `bandeiraId`. Já é o esqueleto do pagamento misto.
- **`pedido_historico`**: `statusAnterior`, `statusNovo`, `acao`, `motivo`,
  `usuario`, `dadosExtras`.
- Status: `STATUS_VALIDOS = ['rascunho','confirmado','em_separacao','entregue','faturado','cancelado']`
  (`pedidos-routes.js:32`) e `STATUS_PAGAMENTO = ['pendente','parcial','pago']` (`:33`).
- APIs: listagem com escopo por vendedor e paginação, `POST /api/pedidos`,
  `POST/PUT/DELETE` de itens, `confirmar`, `entregar`, `cancelar`, `acao-massa`,
  `converter-modo`. Tudo auditado em `04`.

### B.5 Preço

- `resolverPreco(db, produtoId, { pessoaId, quantidade, tabelaId })`
  (`precos-routes.js:127`), com quatro fontes em cascata: tabela forçada no
  pedido → tabela do cliente → tabelas gerais por prioridade → `produtos.precoVenda`.
- `tabelas_preco` + `tabela_preco_itens` com `qtdMinima` (faixa por quantidade) e
  vigência.
- `pedido-politicas.js` — a fonte única endurecida em 26/08 e 10/09:
  `precoDeItem()`, `politicaPreco()`, `vendedorRestrito()`, `podeFurarPiso()`,
  `resolverVendedor()`, `escopoVendedor()`.
- `GET /api/precos/resolver` (`precos-routes.js:398`) — a tela já consulta o
  preço oficial antes de gravar.

### B.6 Estoque e reserva

Confirmado no código, e é exatamente o que você supôs no §19:

| Momento | Função | Efeito |
|---|---|---|
| carrinho | — | **nada** (só `loja_carrinho`) |
| `POST /api/pedidos/:id/confirmar` | `criarReservasPedido` (`reservas-routes.js:133`), chamada em `pedidos-routes.js:955` | cria `reservas_estoque` com `status='ativa'`; **409 com `insuficiencias` se faltar saldo**, salvo `{forcar:true}` |
| `POST /api/pedidos/:id/entregar` | `consumirReservasPedido` | converte reserva em saída real em `movimentacoes_estoque` |
| cancelar | `cancelarReservasPedido` | libera |

**Uma exceção que você precisa saber:** a loja virtual **reserva já no
rascunho** (`loja-routes.js:355`), fora do fluxo padrão. Foi decisão dela —
"a reserva é o que impede vender a mesma peça duas vezes" (`:353`).

`POST /api/produtos/disponibilidade` (`produtos-routes.js`, criada na caixa 4)
devolve disponibilidade sem vazar custo.

### B.7 Financeiro e pagamento

- `contas_a_receber` já tem **`pedidoId`**, `nfceId`, `osId`, `origem`,
  `origemTipo`, parcelamento (`parcelaNumero`, `totalParcelas`, `grupoParcelaId`)
  e `adquirenteCartaoId`.
- `boleto-orchestrator.js`: `emitirBoletoParaCR` e **`emitirCobrancaPixParaCR`**
  (`:318`), com quatro provedores em `boleto-provedores/`: `asaas.js`,
  `mercadopago.js`, `sicredi.js`, `manual.js`.
- Webhook único e genérico: `POST /webhook/boleto/:provedor`
  (`pre-auth-routes.js:106`), pré-auth, tenant resolvido pelo subdomínio.
  `processarWebhook` (`boleto-orchestrator.js:480`) é **idempotente por estado da
  CR** (`:496`: só baixa CR que não esteja `paga` nem `cancelada`).
- `POST /api/webhooks/mercadopago` (`financeiro-routes.js:1468`).
- `meios-pagamento.js`: dicionário SEFAZ (`01` dinheiro … `17` PIX) e whitelist
  por cliente em `pessoas.meiosPagamentoPermitidos`.
- `politicas_prazo`: `prazoDias`, `meiosPermitidos`, `valorMinimoParcela`,
  `coeficiente`, `ignoraLimiteCredito`, `aplicaVendas`, `aplicaCompras` e
  **`aplicaPdv`** — a coluna do PDV já está lá.
- `adquirentes_cartao` + `agenda_recebiveis_cartao`: taxa e prazo de recebível.
- TEF: `tef-routes.js` (156 linhas), `tef_terminais`, `tef_transacoes`,
  `TIPOS = ['credito','debito','voucher','pix','outros']`.

### B.8 Alçadas — o motor do seu §16 já existe

`governanca-alcadas.js` + `regras_alcada` + `aprovacoes`. É um motor maduro, com
quatro defeitos já corrigidos e documentados no cabeçalho do arquivo (faixas,
travamento do valor aprovado, reenvio após reprovação, expiração).

- `regras_alcada (tipoEvento, limiteValor, papelAprovador, validadeDias, descricao, ativo)`
- `aprovacoes (tipoEvento, referenciaId, valorReferencia, solicitante, status, aprovador, regraId, papelExigido, valorAprovado, expiraEm, consumida, autoAprovada)`
- `TIPOS_EVENTO = ['pagamento_cp', 'pedido_compra']` (`governanca-alcadas.js:26`)
  — **lista fechada, e é aí que 'desconto_venda' entraria.**

### B.9 RBAC

`perfis-acesso.js` + `perfis_acesso` + `perfis-api-map.js`:

- Catálogo de páginas sai de `public/js/menu-config.js` — **não há lista
  paralela**, item novo no menu aparece sozinho na tela de perfis
  (`perfis-acesso.js:33`).
- Gate de página: fail-closed dentro dos diretórios de módulo.
- Gate de API: fail-closed contra `perfis-api-map.js` — prefixo sem entrada é
  negado e logado (`[RBAC] prefixo sem mapa:`).
- `perfis-api-map.js` é **arquivo gerado** por `scripts/gerar-mapa-api.js`.
- `atorIrrestrito`/`vendedorRestrito`/`podeDelegarVendedor` em
  `pedido-politicas.js` — a classificação de ator já usada pelo pedido.
- Camada de plano: `plan-modules.js` (módulos por tier) + `module-gate.js`
  (prefixo de API → módulo). `varejo` cobre `/api/nfce/`, `/api/pdv/`,
  `/api/tef/`, `/api/marketplaces/`.

### B.10 Multi-tenant

- `tenant-middleware.js`: `AsyncLocalStorage` + Proxy sobre better-sqlite3.
- `tenant-manager.js:217` `resolveFromHost(host)`: **só subdomínio de
  `liciteagora.app`**. `www`/apex → landing; `admin` → control plane;
  `RESERVED_SLUGS = ['www','admin','api','static','cdn']`; qualquer outro
  subdomínio → tenant.
- `data/control.db` → tabela `tenants`: 13 tenants hoje, 6 `ACTIVE`, 1 `TRIAL`,
  6 `SUSPENDED`. **Não existe coluna de domínio próprio** — conferido em
  `PRAGMA table_info(tenants)`.
- Tenant suspenso recebe página de pagamento pendente (`tenant-middleware.js:165`).

### B.11 Frontend

- ~30 diretórios em `public/`, um HTML autocontido por tela, sem build.
- `public/css/app-modern.css` + `sidebar.css`; menu montado por
  `public/js/menu-config.js` + `public/js/sidebar.js`.
- Ícones: Lucide (mapa em `sidebar.js`).
- Padrão de página pública já estabelecido três vezes: `/portal`, `/loja`,
  `/cardapio` — estático servido em `pre-auth-routes.js:42,63,72` mais rotas
  `/<nome>/api/*` **fora do prefixo `/api/`**, que é a área protegida.

---

## C. O que precisa ser adaptado

### C.1 `pedido_itens` é pequeno demais para o que você quer

Ele tem 8 colunas. Não tem **desconto**, não tem **observação do cliente**, não
tem vínculo com personalização, não tem ordem.

E o levantamento no schema inteiro do tenant mostra que **`pedidos` e
`pedido_itens` são os únicos documentos de venda sem desconto**:

| Tem coluna de desconto | Não tem |
|---|---|
| `os_ordens.valorDesconto`, `os_itens_pecas.desconto`, `os_itens_servicos.desconto`, `crm_oportunidade_itens.desconto`, `faturas.valorDesconto`, `fatura_itens.valorDesconto`, `nfce.valorDesconto`, `rest_comandas.totalDesconto` | **`pedidos`**, **`pedido_itens`** |

Consequência direta e atual: **desconto no pedido só existe embutido no
`precoUnitario`** — que é justamente o que a regra de 10/09 acabou de proibir ao
vendedor restrito. Hoje, na prática, **o vendedor restrito não consegue dar
desconto nenhum**. O caminho que você quer no §16 ("preço oficial → desconto
explícito → total") não é uma melhoria estética: é o que devolve a capacidade
que a trava tirou.

### C.2 Checkout sem login (§2A) — hoje é impossível

`POST /loja/api/pedido` exige `compradorAuth = requirePortalAuth(db)`
(`loja-routes.js:322` e `:266`), que exige `req.session.clienteLoginId` e um
registro ativo em `cliente_logins`. E `cliente_logins` **só é criado pelo
administrador** via `POST /api/portal/credencial` (`portal-routes.js:24`).

Não há auto-cadastro em lugar nenhum. **NÃO CONFIRMADO** que exista qualquer
fluxo de "criar conta" no portal — procurei e não achei.

Para o consumidor da Art's Presentes, isso precisa mudar de forma. Três caminhos
possíveis, em §X-2.

### C.3 Categorias de produto

`produtos.categoria` é **TEXT livre**, alimentado por `produto_lookup` com
`tipo='categoria'`. Não há id, não há ordem, não há hierarquia, não há
visibilidade, não há contagem. O agrupamento na vitrine hoje é feito por
`[...new Set(...)]` sobre o texto (`loja-routes.js:256`).

Para o seu §5 (categoria expansível, com ordenação, visibilidade, duplicar,
copiar link, reorganizar) o texto livre não sustenta. Mas **também não precisa
virar FK em `produtos`**: dá para ter categorias do *catálogo* sem tocar na
categoria fiscal/interna do produto — ver §F.

### C.4 Atributos (§3) — o backend já é um só, o menu é que não

Agrupar Marcas / Modelos / Cores / Materiais / Gêneros em **um item "Atributos"**
é viável e barato, e não perde funcionalidade: as cinco telas já falam com o
mesmo CRUD.

O que precisa mudar para atributo virar configurável por segmento (moda,
autopeças, presentes):

1. `LOOKUP_TIPOS` é um `Set` fixo no código (`produto-lookup-routes.js:13`) —
   precisaria virar cadastro por tenant.
2. As colunas em `produtos` são fixas: `marca`, `modelo`, `cor`, `material`,
   `genero`. Um atributo novo ("Tamanho", "Ano", "Aplicação", "Ocasião") não tem
   onde ser gravado sem `ALTER TABLE`. Precisa de tabela de valor por produto.
3. **RBAC**: cada uma das cinco páginas é uma entrada em `menu-config.js`
   (`cadastro-marcas`, `cadastro-modelos`, `cadastro-cores`, `cadastro-materiais`,
   `cadastro-generos`) e essas chaves aparecem em `perfis-api-map.js`. Fundir em
   uma página muda o catálogo de perfis — perfil restrito que hoje tem
   `cadastro-marcas` precisa ser remapeado, e `perfis-api-map.js` regenerado por
   `scripts/gerar-mapa-api.js`.

### C.5 Loja virtual → Catálogo Online

O que ela tem hoje e precisa evoluir:

| Hoje | Precisa |
|---|---|
| `loja_config` com 13 colunas (nome, descrição, logo, WhatsApp, tema, pagamento) | + capa/banner, endereço, horários, status aberto/fechado, redes sociais, blocos da página de boas-vindas |
| tema com 4 valores (`corPrimaria`, `fundo`, `fonte`, `raio`) e 3 presets | + cor de destaque, estilo de botão (o §7 cabe quase inteiro no que já existe) |
| publicação em lote por checkbox (`/api/loja/produtos/publicar`) | + categoria do catálogo, ordem, destaque, preço promocional, visibilidade por produto |
| sem entrega/retirada | tipo de atendimento, endereço, taxa |
| sem cupom | cupom validado no servidor |
| carrinho exige login | sessão anônima |

### C.6 Frete negativo (§12) — confirmado, e é mais amplo do que parece

`recalcularTotal` (`pedidos-routes.js:106-113`) soma `valorFrete` **com sinal**:

```js
const total = row.total + (Number(ped && ped.valorFrete) || 0);
```

E `valorFrete` está em `CAMPOS_PEDIDO` (`pedidos-routes.js:67`), gravado pelo
`PUT /api/pedidos/:id` sem validação de sinal. Qualquer usuário que alcance o
pedido — inclusive o vendedor restrito — pode mandar `valorFrete: -500` e
derrubar o total. **É o desconto que sobrou** depois da trava de 10/09.

A proteção correta, sem quebrar fluxo administrativo legítimo: piso em zero na
gravação (frete negativo não existe em lugar nenhum do mundo real), e desconto
como campo próprio, sujeito à alçada. Não vi nenhum fluxo do ERP que dependa de
frete negativo — mas **NÃO CONFIRMADO** que não exista dado histórico negativo
em produção; isso precisa de um `SELECT` antes de ligar a trava.

### C.7 PDV atual

Não é para adaptar — é para conviver. Mas duas coisas dele precisam de decisão:

- `POST /api/pdv/finalizar` (`nfce-routes.js:778`) manda o payload inteiro para
  `emitirNFCe`, que usa `it.precoUnitario` do corpo (`:295`, `:429`, `:547`) e
  `payload.valorDesconto` (`:296`) **sem consultar `resolverPreco`**. Não há
  chamada a `resolverPreco` em `nfce-routes.js` — conferido por grep.
- A única validação de valor é `|vPag − vNF| ≤ 0,02` (`:305`), ou seja: os
  pagamentos têm de bater com o total que **o próprio navegador calculou**.

---

## D. O que precisa ser criado

Em ordem de dependência, não de importância:

1. **Desconto explícito no pedido** — item e cabeçalho, com motivo e autor.
2. **Personalizações genéricas de produto** — os grupos de opção do restaurante
   promovidos a cidadão do catálogo, ligados a `pedido_itens`.
3. **Categorias de catálogo** — com ordem, visibilidade e destaque, sem mexer em
   `produtos.categoria`.
4. **Publicação por produto no catálogo** — visível, destaque, ordem, preço
   promocional, categoria.
5. **Sessão de comprador anônimo** — carrinho sem login, com identificação só no
   checkout.
6. **Tipo de atendimento e entrega** — retirada / entrega / no local, taxa por
   região.
7. **Cupons** — nada existe hoje. `grep -i cupom` só encontra "NF/cupom" em
   `os-routes.js:898` e o `voucher` do TEF.
8. **Página de boas-vindas e aparência estendida** — em `loja_config`.
9. **Pedidos PDV** — tela nova sobre a API de pedidos existente.
10. **Alçada de desconto** — `tipoEvento = 'desconto_venda'` no motor existente.
11. **Origem do pedido de primeira classe** — hoje é `tipo` + flag `origemLoja`.
12. **Testes** — não existe nenhum teste de loja nem de cardápio público
    (`ls scripts/ | grep -i loja` → só `migrate-loja.js`).

---

## E. Tabelas e colunas atuais relevantes

| Tabela | Onde é criada | Papel neste projeto |
|---|---|---|
| `produtos` | `db-schema.js` | mestre; `publicadoNaLoja`, `precoVenda`, `precoMinimoVenda`, `categoria`, `imagemPath`, `codigoBarras` |
| `produto_imagens` | `produto-imagens.js:29` | galeria, com `ordem` |
| `produto_lookup` | `db-schema.js` | atributos (`tipo`,`valor`,`ativo`) |
| `produto_kit_itens` | `db-schema.js` | kit/composição — **NÃO CONFIRMADO** se serve de base para "complete seu pedido" |
| `pessoas` | `db-schema.js` | cliente; `cpfCnpj` **UNIQUE** (`idx_pessoas_cpfcnpj`), `telefone`, `celular`, `tabelaPrecoId`, `politicaPrazoId`, `meiosPagamentoPermitidos`, `limiteCredito` |
| `pessoas_enderecos_adicionais` | `db-schema.js` | N endereços por pessoa, com `padrao` e `apelido` |
| `cliente_logins` | `db-schema.js` | login do portal/loja (`pessoaId`,`email`,`passwordHash`) |
| `pedidos` | `db-schema.js` | cabeçalho; endereço de entrega completo, `origemLoja`, `politicaPrazoId` |
| `pedido_itens` | `db-schema.js` | 8 colunas — o gargalo |
| `pedido_parcelas` | `db-schema.js` | base do pagamento misto |
| `pedido_historico` | `db-schema.js` | trilha de status |
| `tabelas_preco`, `tabela_preco_itens` | `precos-routes.js` | preço por cliente/faixa/vigência |
| `reservas_estoque`, `movimentacoes_estoque` | `reservas-routes.js`, `estoque-routes.js` | reserva e baixa |
| `contas_a_receber` | `financeiro-routes.js` | já tem `pedidoId` |
| `boletos`, `contas_financeiras_boleto` | `boleto-orchestrator.js` | Pix/boleto + webhook |
| `politicas_prazo` | `politicas-prazo-routes.js` | condição de pagamento, com `aplicaPdv` |
| `adquirentes_cartao`, `agenda_recebiveis_cartao` | `financeiro-avancado-routes.js` | taxa e prazo de cartão |
| `regras_alcada`, `aprovacoes` | `governanca-routes.js:38` | motor de alçada |
| `perfis_acesso` | `db-schema.js` | RBAC por página |
| `loja_config`, `loja_carrinho` | `loja-routes.js:58`, `:89` | catálogo online atual |
| `rest_grupos_opcao`, `rest_opcoes`, `rest_produto_grupos`, `rest_comanda_item_opcoes` | `restaurante/restaurante-schema.js` | modelo de personalização pronto |
| `rest_bairros_taxa` | `restaurante-schema.js:373` | taxa de entrega por bairro |
| `nfce`, `nfce_itens`, `nfce_pagamentos` | `nfce-routes.js` | PDV fiscal atual |
| `tef_terminais`, `tef_transacoes` | `tef-routes.js` | TEF |
| `estabelecimentos` | `db-schema.js` | multi-loja dentro do tenant |
| `config` | `db-schema.js` | chave/valor por tenant (`preco_politica`, `restaurante_enabled`, …) |

---

## F. Novas tabelas e colunas — proposta, nada criado

> Nenhuma destas existe. Nenhuma foi criada. São proposta para sua aprovação.

### F.1 Catálogo online

```
catalogo_categorias
  id, nome, slug, ordem, visivel, descricao, imagemPath, dataCriacao

catalogo_produtos            -- publicação, não duplicação do produto
  produtoId (PK, FK produtos), categoriaId, ordem, visivel, destaque,
  precoPromocional, descricaoVitrine, dataAtualizacao
```

Por que uma tabela de publicação em vez de colunas em `produtos`: "retirar do
catálogo" (seu §5) passa a ser deletar uma linha de `catalogo_produtos`, sem
tocar no produto mestre. E um produto pode estar em categoria normal **e** em
destaque com uma coluna booleana, sem duplicar registro.

`publicadoNaLoja` continua valendo como está — a existência da linha em
`catalogo_produtos` seria a fonte nova, com migração a decidir (§X-4).

### F.2 Personalizações — a decisão está em §X-1

```
opcao_grupos                 -- promoção de rest_grupos_opcao
  id, nome, minEscolhas, maxEscolhas, ordem, ativo, tipoEntrada

opcao_itens                  -- promoção de rest_opcoes
  id, grupoId, nome, precoAdicional, insumoProdutoId, quantidadeInsumo, ordem, ativo

produto_opcao_grupos
  produtoId, grupoId, ordem

pedido_item_opcoes           -- espelho de rest_comanda_item_opcoes
  id, pedidoItemId, opcaoId, nome, precoAdicional     -- nome/preço em snapshot
```

`tipoEntrada` cobriria o "Outro" com texto livre do seu exemplo do balão.

### F.3 Desconto e observação

```
ALTER TABLE pedido_itens ADD COLUMN descontoValor REAL DEFAULT 0
ALTER TABLE pedido_itens ADD COLUMN observacao TEXT
ALTER TABLE pedidos      ADD COLUMN descontoValor REAL DEFAULT 0
ALTER TABLE pedidos      ADD COLUMN descontoMotivo TEXT
ALTER TABLE pedidos      ADD COLUMN descontoAutorId INTEGER
```

Com `recalcularTotal` passando a ser
`Σ(itens) − Σ(desconto item) − desconto do pedido + max(0, frete)`.

### F.4 Atendimento, entrega e cupom

```
ALTER TABLE pedidos ADD COLUMN tipoAtendimento TEXT   -- 'local'|'retirada'|'entrega'
ALTER TABLE pedidos ADD COLUMN dataHoraRetirada TEXT
ALTER TABLE pedidos ADD COLUMN cupomId INTEGER

catalogo_taxas_entrega
  id, tipo ('bairro'|'cep'|'raio'|'fixa'), chave, taxa, prazoMin, ativo

cupons
  id, codigo (UNIQUE), tipo ('percentual'|'valor'|'frete'), valor,
  validoDe, validoAte, usoMaximo, usoAtual, valorMinimoPedido, ativo

cupom_usos
  id, cupomId, pedidoId, pessoaId, valorAplicado, dataUso
```

### F.5 Origem do pedido

```
ALTER TABLE pedidos ADD COLUMN origem TEXT   -- 'erp'|'pdv'|'catalogo'|'app'|'marketplace'
```

Coluna nova em vez de reaproveitar `tipo`, porque `tipo` já carrega
`manual|licitacao|os|marketplace|app` e tem consumidores esperando esses valores
(`pedidos-routes.js:427`). `origemLoja` viraria derivado.

### F.6 Sessão de comprador anônimo

```
loja_sessoes
  id, token (UNIQUE), pessoaId, dadosContato TEXT, criadoEm, expiraEm
ALTER TABLE loja_carrinho ADD COLUMN sessaoId INTEGER
```

Hoje `loja_carrinho` é `UNIQUE(pessoaId, produtoId)` e `pessoaId` é NOT NULL
(`loja-routes.js:89-97`) — sem `sessaoId` não há carrinho anônimo.

### F.7 Atributos configuráveis

```
atributo_tipos
  id, slug, nome, ordem, ativo, aplicaSegmento

produto_atributo_valores
  produtoId, tipoId, valor
```

As cinco colunas atuais de `produtos` (`marca`,`modelo`,`cor`,`material`,`genero`)
ficam onde estão — remover é ALTER destrutivo e há consumidores (loja,
marketplaces, óptica).

---

## G. APIs existentes reutilizáveis

| API | Arquivo | Serve a |
|---|---|---|
| `GET /api/produtos`, `GET /api/produtos/:id` | `produtos-routes.js` | catálogo administrativo, PDV |
| `POST /api/produtos/:id/imagem` | `produtos-routes.js:603` | foto do catálogo |
| `POST /api/produtos/disponibilidade` | `produtos-routes.js` (caixa 4) | PDV e vitrine |
| `GET/POST/DELETE /api/produto-lookup/:tipo` | `produto-lookup-routes.js` | atributos |
| `GET /api/pessoas`, `/api/pessoas/autocomplete`, `POST /api/pessoas` | `financeiro-routes.js:374`, `:401`, `:639` | cliente no PDV |
| `POST /api/pedidos` + itens + `confirmar`/`entregar`/`cancelar` | `pedidos-routes.js` | **o pedido, para os três canais** |
| `GET /api/precos/resolver` | `precos-routes.js:398` | preço na tela |
| `GET/PUT /api/loja/config`, `/api/loja/produtos`, `/api/loja/produtos/publicar` | `loja-routes.js` | administração do catálogo |
| `/loja/api/*` (config, produtos, carrinho, pedido, meus-pedidos, cobranca) | `loja-routes.js` | loja pública |
| `POST /webhook/boleto/:provedor` | `pre-auth-routes.js:106` | confirmação de pagamento |
| `emitirCobrancaPixParaCR` / `emitirBoletoParaCR` | `boleto-orchestrator.js:318` | Pix e boleto do checkout |
| `/api/politicas-prazo` | `politicas-prazo-routes.js` | condição de pagamento (tem `aplicaPdv`) |
| `/api/governanca/*` | `governanca-routes.js` | alçadas |
| `/api/perfis` | `perfis-acesso.js` | RBAC |

---

## H. APIs novas e adaptações prováveis

### H.1 Catálogo administrativo (dentro do ERP, atrás do login)

```
GET    /api/catalogo/categorias                  lista com contagem de produtos
POST   /api/catalogo/categorias
PUT    /api/catalogo/categorias/:id              nome, visível, ordem
POST   /api/catalogo/categorias/:id/duplicar
DELETE /api/catalogo/categorias/:id              recusa se tiver produto, ou realoca
POST   /api/catalogo/categorias/ordenar          [{id, ordem}]
POST   /api/catalogo/categorias/:id/produtos     adiciona produto existente
PUT    /api/catalogo/produtos/:produtoId         visível, destaque, ordem, promocional
DELETE /api/catalogo/produtos/:produtoId         retira do catálogo, NÃO apaga o produto
POST   /api/catalogo/produtos/:produtoId/mover   troca de categoria
GET    /api/catalogo/vitrine-preview             o que o consumidor veria
GET    /api/catalogo/qrcode                      QR do link público
GET/PUT /api/catalogo/aparencia                  logo, capa, cores, botões
GET/PUT /api/catalogo/boas-vindas                blocos, horários, endereço, redes
GET/PUT /api/catalogo/entrega                    retirada/entrega, taxas
GET/PUT /api/catalogo/pagamentos                 online/na entrega, provedores
CRUD    /api/catalogo/cupons
```

### H.2 Loja pública (pré-auth, fora do `/api/`)

```
GET  /loja/api/home                    página de boas-vindas
GET  /loja/api/categorias
GET  /loja/api/produtos                (existe; ganha categoria, destaque, promocional)
GET  /loja/api/produtos/:id            (existe; ganha grupos de opção)
POST /loja/api/sessao                  cria sessão anônima → token em cookie
POST /loja/api/carrinho                (existe; passa a aceitar sessão anônima + opções)
POST /loja/api/cupom                   valida no SERVIDOR, devolve desconto calculado
POST /loja/api/checkout                identifica/cria pessoa, cria pedido, cobra
GET  /loja/api/pedido/:id/status       acompanhamento por token, sem login
```

### H.3 Pedidos PDV (dentro do ERP)

Quase nada de API nova — é interface sobre o que existe:

```
GET  /api/pedidos?painel=pdv&status=...        adaptação da listagem atual
POST /api/pedidos/:id/desconto                 desconto com alçada
POST /api/pedidos/:id/pagamentos               pagamento misto (usa pedido_parcelas)
GET  /api/pdv/catalogo-visual                  produtos com foto para o balcão
POST /api/pessoas/rapido                       cadastro mínimo (ver §O)
```

### H.4 Adaptações em rotas existentes

| Rota | Adaptação |
|---|---|
| `PUT /api/pedidos/:id` | piso em zero no `valorFrete`; `descontoValor` sujeito à alçada |
| `POST /api/pedidos/:id/itens` e `PUT .../:itemId` | aceitar `opcoes[]` e `observacao`; validar grupos no servidor; `descontoValor` |
| `recalcularTotal` (`pedidos-routes.js:106`) | somar adicionais e subtrair descontos |
| `GET /api/pessoas` | buscar também por `telefone`/`celular` (hoje não busca) |
| `POST /api/pdv/finalizar` | resolver preço no servidor, como o pedido faz |
| `perfis-api-map.js` | regenerar para os prefixos novos (senão perfil restrito toma 403) |

---

## I. Encaixe no frontend e no menu

### I.1 Onde as coisas estão hoje (não onde você imaginou)

Conferido em `public/js/menu-config.js`:

| Seção | Linha | Itens |
|---|---|---|
| **Comercial** (`feature: 'comercial'`) | `:88` | Clientes & Fornecedores · CRM · Funil · **Pedidos** · Tabelas de Preço · Vendas Perdidas · Metas · Contratos · Devoluções |
| **Catálogo** (`feature: 'produtos'`) | `:153` | Produtos · Etiquetas · **Marcas · Modelos · Cores · Materiais · Gêneros** |
| **Varejo** (`feature: 'varejo'`) | `:226` | **PDV** · PDV · Config · TEF · Marketplaces · **Loja virtual** · Romaneios |

**A Loja virtual e o PDV moram em VAREJO, não em Comercial nem em Catálogo.**
Isso importa por dois motivos que não são de organização:

1. `feature: 'varejo'` é gate de **plano** (`plan-modules.js:20`): o módulo
   `varejo` só entra nos tiers superiores. Dos 13 tenants, o `1bit` (enterprise)
   tem; o `produtosbomgosto` (basic) **não**. Mover "Catálogo Online" para a
   seção Catálogo (`feature: 'produtos'`, presente em todos os tiers) **entrega o
   catálogo online a tenants que hoje não pagam por varejo**. É decisão
   comercial, não técnica — §X-6.
2. Em `perfis-acesso.js`, **o primeiro segmento do path libera as páginas de
   detalhe**. Mover um HTML de pasta muda permissão. Já houve precedente
   documentado: o `ssl` saiu de `/comercial/` para `/ssl/` exatamente por isso
   (comentário em `menu-config.js:108-118`).

### I.2 Proposta de menu

**Comercial** — acrescentar um item, sem mexer nos outros:

```
Clientes & Fornecedores · CRM · Funil · Pedidos · [NOVO] Pedidos PDV ·
Tabelas de Preço · Vendas Perdidas · Metas · Contratos · Devoluções
```

`Pedidos` continua sendo a gestão completa; `Pedidos PDV` é a interface rápida.
Ambos sobre `/api/pedidos`.

**Catálogo** — de 7 itens para 4, como você propôs:

```
Produtos · [NOVO] Catálogo Online · Etiquetas · [FUNDIDO] Atributos
```

Sobre Etiquetas: **recomendo manter**. `etiquetas-routes.js` é módulo próprio,
com página própria, e é impressão de etiqueta de gôndola/código de barras — não
tem relação com catálogo online. Tirar não simplifica nada e quebra quem usa.

**Varejo** — sem mudança. A "Loja virtual" atual vira o Catálogo Online; se ela
sair de Varejo, o item precisa ser redirecionado (há precedente: `PAGINAS_MOVIDAS`
em `auth-bootstrap.js`).

### I.3 Custo escondido de qualquer mudança de menu

Três arquivos andam juntos e **não podem divergir**:

1. `public/js/menu-config.js` — a fonte.
2. `perfis-acesso.js` — lê o menu, monta o catálogo de páginas. Automático.
3. `perfis-api-map.js` — **arquivo gerado**; precisa de
   `node scripts/gerar-mapa-api.js` depois de qualquer rota nova. Prefixo fora
   do mapa é **negado** para perfil restrito.

E um alerta específico: `verify` (`npm run verify`) roda `node --check` só nos
`.js` da raiz e de `scripts/`. **Não cobre o JS inline dos HTML** — erro de
sintaxe numa tela nova passa verde e derruba a página em produção no instante em
que o arquivo é salvo, porque `public/` é estático.

---

## J. Arquitetura do Catálogo Online administrativo

A divisão que você propôs (Produtos · Boas-vindas · Aparência · Entrega e
retirada · Pagamentos · Cupons · Configurações) **faz sentido na arquitetura
atual**, com uma ressalva: são sete telas de configuração para um objeto que
hoje é uma linha só (`loja_config`, `id = 1`).

O caminho de menor atrito, dado o padrão do repositório (um HTML autocontido por
tela, sem build):

- **Uma página** `public/catalogo/online.html` com abas — não sete arquivos.
  Precedente no próprio repo: `public/varejo/pdv-config.html` e
  `public/restaurante/config.html` já fazem isso.
- **Uma tabela de config estendida** (`loja_config`) + as tabelas novas de
  categoria/publicação/cupom/taxa. Cada aba fala com o seu endpoint.
- **A aba "Produtos" é a mais pesada** e a que justifica trabalho de verdade:
  árvore de categorias expansível, arrastar para ordenar, publicar/ocultar,
  destaque, preço promocional, contagem por categoria. Hoje o equivalente é uma
  lista plana com checkbox (`/api/loja/produtos` → `loja-routes.js:517`).

Sobre o "+ Produto dentro de uma categoria" (seu §5): as duas opções que você
descreveu são as certas, e a segunda **precisa** passar por
`POST /api/produtos` — o cadastro mestre. Um cadastro paralelo de "produto do
catálogo" seria exatamente o sistema paralelo que o seu §1 proíbe. O `sku` é
`UNIQUE` em `produtos`, então o cadastro rápido precisa gerar SKU ou exigir um.

Sobre pré-visualização responsiva (§6): viável sem framework — um `<iframe>` com
largura fixa de 390 px apontando para `/loja/?preview=1`. O que **não** existe
hoje é um modo de preview que mostre a loja **despublicada**: `GET /loja/api/config`
devolve 404 quando `ativa = 0` (`loja-routes.js:212`). Precisaria de um token de
preview.

---

## K. Arquitetura da loja pública

Herda o padrão já usado três vezes (`/portal`, `/loja`, `/cardapio`):

```
public/loja/index.html                    estático, servido em pre-auth-routes.js:63
/loja/api/*                               rotas pré-auth, FORA do prefixo /api/
```

Por que fora de `/api/`: é a área protegida por `requireAuth`. Essa separação é
de segurança, e está dita no cabeçalho de `loja-routes.js:14-17` e de
`cardapio-publico-routes.js:3-6`.

O que a loja pública precisa ganhar:

| Item do seu §8/§9/§10 | Estado |
|---|---|
| identidade, logo, tema | **existe** (`/loja/api/config`) |
| categorias | existe como texto derivado; precisa da tabela |
| destaques, busca, fotos, preço | busca e fotos **existem**; destaque não |
| preço anterior/promocional | não existe |
| status aberto/fechado, endereço, redes | não existe (só `ativa` 0/1 e WhatsApp) |
| carrinho, quantidade, excluir item, subtotal | **existe**, no servidor |
| grupos de personalização | existe **no cardápio**, não na loja |
| cupom, entrega/retirada, taxa | não existe |
| checkout sem login | **não existe** — o bloqueio de §C.2 |

Responsividade: `public/loja/index.html` já nasce com `viewport` e uma media
query. É um arquivo de 493 linhas — reescrevê-lo mobile-first é trabalho de
tela, não de arquitetura.

---

## L. Arquitetura do Pedidos PDV

**Não precisa de modelo novo.** O mapeamento para o que existe é direto:

| Seu conceito | `pedidos` hoje |
|---|---|
| pedidos em andamento | `status IN ('rascunho','confirmado','em_separacao')` |
| pendentes | `statusPagamento IN ('pendente','parcial')` |
| concluídos | `status IN ('entregue','faturado')` |
| + Novo pedido | `POST /api/pedidos` |
| No local / Retirada / Entrega | **coluna nova** `tipoAtendimento` (§F.4) |
| Mesas (futuro) | `rest_mesas` já existe, no módulo restaurante |

O fluxo do seu §15 usa APIs que já existem, na ordem: `POST /api/pedidos` →
`GET /api/pessoas/autocomplete` (ou `POST /api/pessoas`) →
`GET /api/produtos` → `POST /api/pedidos/:id/itens` →
`POST /api/pedidos/:id/confirmar`.

Três pontos de atenção:

1. **Cliente obrigatório antes de concluir já é regra do backend**:
   `confirmarPedidoInterno` recusa com *"Informe o cliente antes de confirmar"*
   (`pedidos-routes.js:948`). O PDV não precisa reinventar — precisa respeitar.
2. **Pedido nasce em `rascunho`** e é isso que permite "salvar como pendente".
3. **Responsividade/PWA**: não existe `manifest.json` nem service worker em
   `public/` — conferido. Uma interface responsiva bem-feita atende
   computador/tablet/celular sem PWA; PWA (instalável, offline) é trabalho
   adicional e **não** é pré-requisito. Recomendo responsivo primeiro.

---

## M. Integração de pagamentos e financeiro

### M.1 O que já funciona ponta a ponta

O caminho `gateway → webhook → CR → financeiro` **existe e está em uso**:

```
POST /loja/api/pedido            (loja-routes.js:322)
  → cria pedido + itens + reserva
  → emitirCobranca (loja-routes.js:152)
      → INSERT contas_a_receber (pedidoId, origem='loja', origemTipo='pedido')
      → emitirCobrancaPixParaCR | emitirBoletoParaCR   (boleto-orchestrator.js)
          → provedor: asaas | mercadopago | sicredi | manual

POST /webhook/boleto/:provedor   (pre-auth-routes.js:106, pré-auth, por subdomínio)
  → processarWebhook (boleto-orchestrator.js:480)
      → registrarBaixaCR → contas_receber_pagamentos + movimentacoes_financeiras
```

Idempotência do webhook: `boleto-orchestrator.js:496` só baixa CR que não esteja
`paga` nem `cancelada`. É simples e funciona para reentrega.

### M.2 O defeito que o seu §13 vai encontrar

**Pagar o Pix da loja virtual NÃO marca o pedido como pago.**

`sincronizarPagamentoPedido` (`contas-receber-routes.js:52`) é o único caminho que
escreve `pedidos.valorPago` / `pedidos.statusPagamento`, e ele exige que a CR
tenha **`faturaId`**:

```js
const cr = db.prepare('SELECT faturaId FROM contas_a_receber WHERE id = ?').get(contaReceberId);
if (!cr || !cr.faturaId) return;          // ← a CR da loja para aqui
```

A CR criada pela loja tem `pedidoId`, **não** `faturaId` (`loja-routes.js:155-160`).
Resultado: a baixa acontece corretamente no financeiro, mas o pedido continua
`statusPagamento = 'pendente'` para sempre. A loja disfarça isso lendo a CR
direto na tela dela (`loja-routes.js:383`), o que só funciona ali.

**Consequência para este projeto:** na tela Pedidos e no Pedidos PDV, um pedido
pago pelo Catálogo Online apareceria como não pago. Precisa de correção — a
menor é fazer `sincronizarPagamentoPedido` cair também no vínculo direto
`contas_a_receber.pedidoId` quando não houver fatura.

Isto é **achado desta auditoria, não implementado**.

### M.3 "Pagar na entrega/retirada"

Não precisa de nada novo no financeiro: é `pedidos.meioPagamento` +
`politicaPrazoId`, e a CR nasce na entrega/faturamento pelo caminho normal. O que
não pode acontecer é a tela fingir pagamento — o seu §17 já diz isso, e o
backend concorda: `statusPagamento` deriva de `valorPago`, que deriva de baixa
real (`pedidos-routes.js:115`).

### M.4 Pagamento misto no PDV (§17)

As peças existem, sem estar ligadas:

- `pedido_parcelas (numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId)`
- `nfce_pagamentos (nfceId, tPag, valor)` — o PDV atual **já faz misto**, no
  modelo fiscal
- `contas_receber_pagamentos` — N pagamentos por CR, com estorno e retificação
- `rest_comanda_pagamentos` — N pagamentos por comanda, com divisão de conta

Ou seja: **três modelos de pagamento misto já existem no repositório**, nenhum
sobre `pedidos`. TOTAL / PAGO / RESTA PAGAR sai de `valorTotal` − Σ pagamentos.

### M.5 Dois avisos de campo

- **Webhook Asaas rejeitando eventos**: há registro de que o webhook do Asaas
  rejeita todo evento de pagamento por token inválido, e a baixa depende só do
  polling. Não revalidei nesta auditoria — **NÃO CONFIRMADO hoje**, mas precisa
  ser checado antes de prometer "pago na hora" ao consumidor.
- **Split de plataforma** existe (`boleto-orchestrator.js:32-127`,
  `tenants.split_asaas_modo`). Cobrança do catálogo passa por ele. Vale conferir
  se o split deve incidir sobre venda de varejo.

---

## N. Integração de estoque

O que você supôs está certo, e está confirmado no código:

| Momento | Reserva? | Onde |
|---|---|---|
| carrinho público | **não** | `loja_carrinho` não toca estoque |
| pedido rascunho (ERP/PDV) | não | — |
| **pedido da loja virtual** | **SIM, já no rascunho** | `loja-routes.js:355` |
| confirmado/aceito | sim | `pedidos-routes.js:955` → `criarReservasPedido` |
| entregue | vira saída real | `consumirReservasPedido` |

A exceção da loja é deliberada e, para catálogo online, provavelmente **certa**:
sem ela, dois consumidores fecham a mesma última peça. Mas ela cria o outro
problema — pedido abandonado segura estoque, e **reserva não expira** (dívida já
registrada em `04` §18).

### N.1 Disponibilidade no catálogo público

Já resolvido, e bem: `rotuloEstoque` (`loja-routes.js:128`) devolve
`sob-consulta` / `ultimas` / `disponivel` em vez do número. O motivo está no
comentário: *"Quantidade exata é inteligência de negócio: o concorrente também
abre a vitrine."* Recomendo manter — e `loja_config.mostrarEstoque` já permite
desligar por tenant.

### N.2 Produto sem estoque

Hoje aparece como `sob-consulta` e **pode ser comprado**: a conferência de saldo
só acontece no fechamento (`loja-routes.js:330-336`, devolve **409** com a lista
de itens faltantes). Decisão sua se produto zerado some da vitrine, aparece
esgotado ou aceita encomenda — §X-8.

### N.3 Concorrência entre dois consumidores

Baixo risco hoje, por um motivo de infraestrutura: `better-sqlite3` é **síncrono**
e o `server.js` roda em **processo único** — as requisições serializam, e
`criarReservasPedido` roda dentro de `db.transaction` (`pedidos-routes.js:954`).
Dois consumidores não conseguem reservar a mesma unidade simultaneamente.

O que **não** está protegido é a janela entre exibir e fechar: o consumidor vê
"disponível", monta o carrinho e fecha 10 minutos depois. Aí o 409 do checkout é
a única defesa — e é a defesa certa, contanto que a tela trate o erro com
clareza.

---

## O. Clientes e endereço

### O.1 Como `pessoas` funciona hoje

- **`cpfCnpj` é UNIQUE** (`idx_pessoas_cpfcnpj`) — é a chave de deduplicação.
- `POST /api/pessoas` (`financeiro-routes.js:639`) **exige `cpfCnpj` e
  `razaoSocial`**, e já é idempotente: se o CPF/CNPJ existe, atualiza em vez de
  duplicar; se existia inativo, reativa (`:653-664`).
- Busca (`GET /api/pessoas`, `:374`) filtra por `cpfCnpj`, `razaoSocial`,
  `nomeFantasia`. **Não busca por telefone nem celular** — e o seu §11 pede isso
  explicitamente. `pessoas.telefone` e `pessoas.celular` existem; falta o `OR` e
  um índice.
- Endereços: `pessoas` tem um endereço próprio **e**
  `pessoas_enderecos_adicionais` guarda N, com `tipo`, `apelido` e `padrao`.
  Cobre o seu §12 sem tabela nova.
- `pessoas` já traz `tabelaPrecoId`, `politicaPrazoId`, `limiteCredito`,
  `meiosPagamentoPermitidos`, `vendedorId` — o cliente já carrega a política
  comercial dele.

### O.2 O conflito do catálogo público

Seu §11 diz duas coisas que hoje se chocam:

- *"Todo pedido deve possuir cliente cadastrado"* — o backend concorda e **exige**
  (`pedidos-routes.js:948`).
- *"O consumidor não deve precisar preencher o cadastro completo do ERP"* — mas
  `POST /api/pessoas` exige CPF/CNPJ, e o pedido exige cliente.

Três saídas possíveis, e é decisão sua (§X-2):

1. **Pedir CPF no checkout.** Mais simples, dedup perfeita pelo UNIQUE existente,
   e é o que o varejo brasileiro já faz ("CPF na nota?"). Atrito baixo.
2. **Aceitar pessoa sem CPF**, deduplicando por telefone. Exige afrouxar a regra
   de `POST /api/pessoas` e criar chave alternativa — o UNIQUE de `cpfCnpj`
   **não aceita múltiplos NULL do jeito que se espera**: no SQLite, NULL não
   colide com NULL, então N clientes sem CPF convivem, e a dedup teria de ser
   por telefone normalizado, sem garantia do banco.
3. **Cliente genérico "Consumidor final"** para o catálogo, com os dados reais
   no pedido. Rejeito: mata metas, comissão, histórico e crédito — vira o sistema
   paralelo que o seu §1 proíbe.

Recomendo a **1**, com a **2** como degradação opcional.

### O.3 Cadastro rápido no PDV

`POST /api/pessoas` já aceita payload mínimo (`cpfCnpj` + `razaoSocial`); o resto
das 76 colunas é opcional. Um `POST /api/pessoas/rapido` não é estritamente
necessário — o que falta mesmo é a **busca por telefone**.

---

## P. Personalizações e adicionais

O modelo está pronto e validado no servidor (§B.2). A decisão é onde ele vive:

| Opção | Custo | Risco |
|---|---|---|
| **A. Promover para o catálogo** (`opcao_grupos`, `opcao_itens`, `produto_opcao_grupos`, `pedido_item_opcoes`) e fazer o restaurante passar a usar as tabelas novas | alto: mexe em módulo em produção com 5.470 linhas | alto — o restaurante está vivo |
| **B. Criar as tabelas novas para o catálogo/pedido e deixar o restaurante como está** | médio | baixo; custo é ter dois cadastros de "grupo de opção" no mesmo tenant se ele usar os dois módulos |
| **C. Reusar `rest_*` direto no pedido** | baixo | alto: amarra o Catálogo Online à flag `restaurante_enabled` e ao vocabulário de comanda |

**Recomendo B**, com o código copiado da validação do cardápio público
(`cardapio-publico-routes.js:170-201`), que já está certa. A migração A pode ser
feita depois, quando não houver pressa.

Regra inegociável, e o cardápio já a cumpre: **o preço do adicional vem do
servidor**. O cliente manda `opcaoIds`; o servidor busca `precoAdicional`,
confere que a opção pertence a um grupo daquele produto e valida
`minEscolhas`/`maxEscolhas`. Ver §T-11 e §T-12.

Sobre **"Complete seu pedido"** (produtos recomendados): não existe estrutura.
`produto_kit_itens` existe, mas é composição de kit — **NÃO CONFIRMADO** que
sirva; pelo nome e uso aparente, não serve. Precisa de tabela própria
(`catalogo_relacionados`) ou de uma regra simples "outros da mesma categoria",
que não custa tabela nenhuma.

---

## Q. Cupons e promoções

**Nada existe.** `grep -rni "cupom\|voucher"` retorna só:

- `os-routes.js:898` — texto `NF/cupom:` em observação;
- `tef-routes.js:16` — `voucher` como tipo de cartão (vale-refeição).

Precisa ser criado do zero (§F.4). Duas regras que precisam nascer com ele:

1. **O cupom é validado e aplicado no servidor.** O navegador manda o código; o
   servidor devolve o desconto calculado. Nunca o contrário.
2. **Uso é contabilizado na criação do pedido, com trava de concorrência.**
   `usoMaximo` sem controle de uso vira cupom infinito.

"Preço promocional" (§5) é diferente de cupom e mais simples:
`catalogo_produtos.precoPromocional`, exibido riscado contra o preço resolvido.
Atenção: promocional é **preço**, então cai sob a política de preço — e o
vendedor restrito não pode defini-lo (regra de 10/09).

---

## R. Permissões e RBAC

Nenhum perfil novo, como você pediu. O encaixe usa o que existe:

| Seu perfil | Encaixe |
|---|---|
| **VENDEDOR** | perfil restrito atual: `users.ehVendedor = 1` + perfil sem `comercial-metas`/`comissoes`. Já é `vendedorRestrito()` (`pedido-politicas.js:90`). Ganharia a página `pedidos-pdv` e `produtos`; **desconto dentro da alçada** |
| **GERENTE** | a "faixa do meio" já descrita em `04` §4.1: perfil com `comercial-metas`/`comissoes`. Já delega vendedor e já informa preço |
| **ADMINISTRADOR** | `role = 'admin'` — irrestrito, configura catálogo, pagamentos, aparência, alçadas |

Páginas novas a cadastrar em `menu-config.js` (e a refletir em
`perfis-api-map.js` via `scripts/gerar-mapa-api.js`):

```
pedidos-pdv        → /comercial/pedidos-pdv.html      → /api/pedidos, /api/produtos, /api/pessoas
catalogo-online    → /catalogo/online.html            → /api/catalogo/*, /api/loja/*
catalogo-atributos → /catalogo/atributos.html         → /api/produto-lookup/*
```

Dois cuidados concretos:

- **Prefixo novo sem entrada no mapa = 403 para todo perfil restrito.** O
  servidor loga `[RBAC] prefixo sem mapa: /api/catalogo` — é esse log que avisa.
- **As rotas públicas (`/loja/api/*`) não passam pelo RBAC**, por serem pré-auth.
  A defesa delas é outra: `loja_config.ativa`, `publicadoNaLoja` e lista
  explícita de colunas. Ou seja, **cada rota pública nova precisa repetir esse
  cuidado à mão** — não há gate que o faça por ela.

Sobre alçada de desconto: `TIPOS_EVENTO` em `governanca-alcadas.js:26` é uma
lista fechada de dois itens. Acrescentar `'desconto_venda'` liga o desconto ao
motor inteiro — faixas por valor, papel aprovador, valor travado na aprovação e
expiração — sem inventar nada. O que precisa decidir é se a alçada é por
**valor** de desconto ou por **percentual** (`regras_alcada.limiteValor` é REAL,
absoluto) — §X-5.

---

## S. Multi-tenant e URL pública

### S.1 Como é hoje

`resolveFromHost` (`tenant-manager.js:217`) **só resolve subdomínio de
`liciteagora.app`**:

```
1bit.liciteagora.app          → tenant '1bit'
liciteagora.app / www.…       → apex (landing) — SEM banco
admin.liciteagora.app         → control plane
qualquer outra coisa          → unknown
```

`RESERVED_SLUGS = ['www','admin','api','static','cdn']`. Não existe coluna de
domínio próprio em `tenants` — conferido.

### S.2 O que isso significa para a URL da loja

**`liciteagora.app/loja/minha-empresa` (o formato do seu §21) não funciona sem
mudança estrutural.** O apex resolve para `kind: 'apex'` e roda com
`db: null` (`tenant-middleware.js:179-181`) — não há banco de tenant nenhum
naquele contexto. Fazer o apex servir loja exigiria resolver tenant **pelo path**,
o que é um segundo mecanismo de resolução convivendo com o de Host. É
precisamente o tipo de coisa que quebra silenciosamente.

**A URL que já funciona hoje, sem nenhuma mudança:**

```
https://1bit.liciteagora.app/loja/
```

Recomendo essa como a URL pública oficial, com duas melhorias baratas:

1. **Slug amigável no lugar do slug técnico**, se quiser: hoje o subdomínio é o
   slug do tenant. Mudar exige vhost novo no nginx — e há um alerta registrado
   de que o Hestia se auto-atualiza (~04:41 diário) e **regera os vhosts**,
   já tendo derrubado tudo uma vez com laço de proxy. Qualquer vhost manual
   precisa sobreviver a isso.
2. **Domínio próprio do lojista** (`loja.artspresentes.com.br`) — seria a
   experiência ideal para o §7 ("não parecer uma página administrativa do Licite
   Agora"), e exige: coluna de domínio em `tenants`, `resolveFromHost` olhando
   essa coluna, vhost e certificado. O ERP **já emite certificados** via NicSRS
   (`nicsrs-client.js`, `ssl_certificados`), então a peça mais cara já existe.

### S.3 Enumeração de lojas

Você levantou o risco, e ele é real mas **já está mitigado por acidente**: como a
loja vive no subdomínio do tenant e `GET /loja/api/config` devolve **404 quando
`ativa = 0`**, não há índice de lojas nem rota que liste tenants. Confirmei que
não existe endpoint público de listagem.

O que **cria** o risco é justamente a URL por path do seu §21: `/loja/<slug>`
convida a varrer slugs. Mais um motivo para ficar no subdomínio.

Dois pontos que continuam abertos:

- **Tenant suspenso**: `tenant-middleware.js:189` intercepta antes de qualquer
  rota e devolve a página de pagamento pendente — inclusive para o consumidor
  final da loja. Hoje 6 dos 13 tenants estão `SUSPENDED`. O consumidor da loja
  veria um aviso de cobrança do Licite Agora. Precisa de decisão (§X-7).
- **Uploads não são segregados por tenant** — ver §T-9.

---

## T. Segurança e riscos

Cada risco que você listou, com o estado real:

| # | Risco | Estado |
|---|---|---|
| 1 | **Preço enviado pelo frontend** | **Resolvido no pedido** (`pedido-politicas.js`, 26/08 + 10/09) e no cardápio (`cardapio-publico-routes.js:173`). **ABERTO no PDV/NFC-e**: `nfce-routes.js` usa `it.precoUnitario` e `payload.valorDesconto` do corpo, sem `resolverPreco` |
| 2 | **Vendedor falsificando `vendedorId`** | **Resolvido** — `resolverVendedor()`, testes B/B2/B3 |
| 3 | **Frete negativo** | **ABERTO e confirmado** — `pedidos-routes.js:110` soma com sinal; `valorFrete` em `CAMPOS_PEDIDO` |
| 4 | **Descontos/acréscimos alterando o total** | Hoje não existe campo de desconto no pedido (§C.1). Ao criar, nasce sujeito à alçada — senão troca-se um furo por outro |
| 5 | **Estoque concorrente** | Baixo (processo único, better-sqlite3 síncrono, reserva em transação). Janela vitrine→checkout coberta pelo 409 |
| 6 | **Idempotência** | **ABERTO** para criação de pedido: `POST /api/pedidos` não tem chave de idempotência. Duplo toque no celular = dois pedidos. Já registrado em `04` §15 |
| 7 | **Duplicação de cliente** | Protegido por `cpfCnpj` UNIQUE — **enquanto houver CPF**. Sem CPF, sem proteção (§O.2) |
| 8 | **Pagamento duplicado via webhook** | Mitigado por estado (`boleto-orchestrator.js:496`). Não há tabela de eventos processados — reentrega com CR já paga é ignorada, o que basta |
| 9 | **Exposição entre tenants** | **ACHADO NOVO: uploads não são segregados.** `public/uploads/produtos` e `public/uploads/loja` são diretórios **únicos**, compartilhados por todos os tenants, servidos **sem autenticação** (`pre-auth-routes.js:53,60`). O nome do arquivo é `<produtoId>-<timestamp>.ext` (`produtos-routes.js:36`). Foto de produto é pública por natureza, mas o namespace é global e a URL de um tenant é servida por qualquer host |
| 10 | **Enumeração de lojas** | Mitigado hoje pelo subdomínio + 404 de loja inativa (§S.3) |
| 11 | **Upload inseguro** | Parcialmente resolvido: `tipoReal()` (`produto-imagens.js:81`) valida **assinatura** do arquivo no logo da loja. Mas `POST /api/produtos/:id/imagem` (`produtos-routes.js:41`) filtra por **`file.mimetype`**, que é declarado pelo cliente. Grava direto em `public/`, servido estático |
| 12 | **Manipulação de personalizações** | O padrão certo existe e está aplicado no cardápio (`cardapio-publico-routes.js:178-201`): opção conferida contra o produto, `min`/`max` validados |
| 13 | **Preço de adicional vindo do frontend** | Idem — o cardápio já ignora e usa `rest_opcoes.precoAdicional` |
| 14 | **Cupom manipulado** | Não existe cupom ainda; nasce com a regra ou não nasce |
| 15 | **Total calculado no navegador** | **ABERTO no PDV**: a única checagem de `POST /api/pdv/finalizar` é `|Σ pagamentos − total| ≤ 0,02` (`nfce-routes.js:309`), e o total é o do navegador |

Dois riscos que **eu acrescento**, encontrados nesta auditoria:

| # | Risco | Onde |
|---|---|---|
| 16 | **Pedido pago pelo catálogo aparece como não pago** | `sincronizarPagamentoPedido` exige `faturaId` (§M.2) |
| 17 | **Loja e cardápio público não têm nenhum teste automatizado** | `scripts/` só tem `migrate-loja.js`. Todo o hardening de pedido tem `test-app-backend.js`; a loja, que já está no ar e cria pedido, não tem nada |

---

## U. Compatibilidade com fluxos atuais

O que **não pode** ser quebrado, e por quê:

| Fluxo | Por que é frágil |
|---|---|
| **Loja virtual do `1bit`** | está **no ar agora**, com 2 produtos publicados e cobrança `pix-ou-boleto` ligada. Qualquer mudança em `loja-routes.js` é mudança em produção viva |
| **Tela `/comercial/pedido.html`** | manda `precoUnitario` em todo POST e PUT de item; qualquer regra nova precisa **ignorar**, não recusar (foi a decisão de 10/09) |
| **PDV/NFC-e** | emite documento fiscal; mexer em preço ali muda o valor da nota |
| **Restaurante** | 5.470 linhas, com comanda, KDS, delivery e iFood. Promover `rest_*` para o core mexe em tudo isso (§P) |
| **Marketplaces (ML)** | tem INSERT próprio em `pedido_itens`; regra nova em `precoDeItem` **não** o alcança, e é bom que seja assim (preço vem do ML) |
| **`perfis-api-map.js`** | arquivo gerado; rota nova sem regeneração = 403 para perfil restrito |
| **`public/` é estático** | arquivo salvo **entra no ar na hora**, sem restart e sem verify. Erro de sintaxe em JS inline derruba a tela |
| **Hardening da caixa 4 e de 10/09** | `pedido-politicas.js`, `pedidos-routes.js`, `produtos-routes.js`, `reservas-routes.js`, `auth.js`, `auth-routes.js`, `scripts/test-app-backend.js`. **Nada aqui propõe desfazê-los** — as propostas de desconto e frete os complementam, e a suíte de 45 testes tem de continuar verde |

---

## V. Plano de implementação em fases pequenas

Cada fase é entregável sozinha, com prova de que funciona. Nenhuma depende de
decisão que não esteja em §X.

**Fase 0 — travar os furos que já existem** *(não depende de catálogo nenhum)*
- piso zero em `valorFrete`; `SELECT` antes, para saber se há histórico negativo
- `sincronizarPagamentoPedido` passa a cair no `pedidos.pedidoId` sem fatura
- teste: pedido com frete negativo recusado; Pix da loja marca pedido como pago

**Fase 1 — desconto explícito no pedido**
- `descontoValor` em `pedido_itens` e `pedidos`, `descontoMotivo`, `descontoAutorId`
- `recalcularTotal` passa a subtrair desconto
- ainda **sem alçada**: só admin e faixa do meio descontam; vendedor restrito, não
- teste: desconto entra no total; vendedor restrito recusado

**Fase 2 — alçada de desconto**
- `'desconto_venda'` em `TIPOS_EVENTO`; cadastro de faixas por tenant
- teste: vendedor dentro da alçada passa; acima gera aprovação pendente

**Fase 3 — Atributos**
- fundir as 5 páginas em `/catalogo/atributos.html`, mesmo backend
- `menu-config.js` + regenerar `perfis-api-map.js` + `PAGINAS_MOVIDAS`
- teste: perfil restrito que tinha `cadastro-marcas` continua entrando

**Fase 4 — categorias e publicação do catálogo**
- `catalogo_categorias` + `catalogo_produtos`
- aba Produtos do Catálogo Online (ordenar, ocultar, destacar, promocional)
- vitrine passa a ler categoria da tabela
- teste: retirar do catálogo não apaga o produto

**Fase 5 — Pedidos PDV** *(não depende de catálogo público)*
- `tipoAtendimento` e `origem` em `pedidos`
- `/comercial/pedidos-pdv.html`: painéis, novo pedido, catálogo visual, carrinho
- pagamento misto sobre `pedido_parcelas`
- teste: pedido do PDV aparece na tela Pedidos, reserva estoque, gera CR

**Fase 6 — checkout sem login**
- `loja_sessoes` + `sessaoId` em `loja_carrinho`
- identificação no checkout, com a regra de §X-2
- teste: consumidor anônimo compra; dois pedidos do mesmo CPF não duplicam pessoa

**Fase 7 — entrega e retirada**
- `catalogo_taxas_entrega`; endereço no checkout gravando nos campos que o pedido
  já tem; retirada sem endereço
- teste: taxa calculada no servidor entra no total

**Fase 8 — personalizações**
- `opcao_grupos`, `opcao_itens`, `produto_opcao_grupos`, `pedido_item_opcoes`
- validação copiada de `cardapio-publico-routes.js:170-201`
- teste: opção de outro produto recusada; `min`/`max` respeitados; preço do
  adicional ignorado quando vier do cliente

**Fase 9 — página de boas-vindas e aparência**
- `loja_config` estendida; preview responsivo com token
- teste: loja despublicada abre no preview e continua 404 no público

**Fase 10 — cupons**
- `cupons` + `cupom_usos`, validação no servidor, uso contabilizado na criação
- teste: cupom expirado, acima do uso máximo e abaixo do mínimo — todos recusados

**Fase 11 — pagamento online no checkout público**
- reusa `emitirCobrancaPixParaCR`; webhook já existe
- teste: webhook reentregue não paga duas vezes

**Fase 12 — testes de regressão do canal público**
- `scripts/test-catalogo-publico.js`, no molde do `test-app-backend.js`

---

## W. Ordem recomendada de execução

**0 → 1 → 2 → 5 → 3 → 4 → 6 → 7 → 8 → 9 → 10 → 11 → 12**

O raciocínio:

- **Fase 0 primeiro, sempre.** São furos abertos hoje, em produção, e não
  dependem de nenhuma decisão sua.
- **1 e 2 antes de qualquer tela**, porque o vendedor restrito hoje **não
  consegue dar desconto nenhum** — a trava de 10/09 fechou o único caminho que
  havia. Enquanto isso não for resolvido, o PDV nasce capenga.
- **5 (PDV) antes do catálogo público**, por três motivos: é interno (erro não
  aparece para o consumidor da Art's Presentes), não depende de checkout anônimo
  nem de personalizações, e valida a operação de venda rápida antes de você
  expor a marca do lojista.
- **3 antes de 4** porque mexer no menu e no RBAC é barato e arriscado; melhor
  fazer isolado do que junto de uma tela grande.
- **6 antes de 7 e 8** porque sem checkout anônimo o catálogo público não vende
  para ninguém, e entrega e personalização só importam depois disso.
- **12 no fim, mas não opcional.** Hoje o canal público não tem teste nenhum e
  já cria pedido em produção.

---

## X. Pontos que precisam da sua decisão

**1. Personalizações: promover `rest_*` ou criar tabelas paralelas?**
Recomendo criar paralelas (§P, opção B) e deixar o restaurante como está. Custo:
um tenant que use restaurante **e** catálogo cadastra "grupo de opção" em dois
lugares. Benefício: o Catálogo Online não fica preso à flag `restaurante_enabled`
nem ao vocabulário de comanda, e um módulo em produção com 5.470 linhas não é
tocado.

**2. Como o consumidor se identifica no checkout público?**
(a) CPF obrigatório — dedup perfeita, atrito baixo, é o que o varejo brasileiro
já faz; (b) só nome + telefone, dedup por telefone sem garantia do banco;
(c) cliente genérico "Consumidor final" — **não recomendo**, mata metas,
comissão e histórico. Recomendo (a).

**3. Desconto é por valor ou por percentual?**
`regras_alcada.limiteValor` é REAL absoluto. Alçada por percentual ("vendedor
até 10%") exige coluna nova ou convenção. Sua definição de alçadas ainda não
existe (você disse que os percentuais não estão definidos) — mas a **forma**
precisa ser decidida antes da Fase 2.

**4. `publicadoNaLoja` vira o quê?**
Hoje é a flag de publicação. Com `catalogo_produtos`, ela pode (a) continuar como
está e a tabela ser complementar; (b) virar derivada; (c) ser aposentada. Há 2
produtos publicados no `1bit` — migração pequena, mas precisa ser decidida.

**5. Catálogo Online fica em qual seção do menu — e sob qual feature?**
Em `Catálogo` (`feature: 'produtos'`) ele fica disponível **a todos os tiers**,
inclusive `basic`. Em `Varejo` (`feature: 'varejo'`), só nos tiers superiores.
É decisão comercial: hoje a Loja virtual é item de Varejo.

**6. Pedidos PDV entra no Comercial mesmo?**
Você propôs Comercial, e faz sentido (trabalha sobre os mesmos pedidos). Mas o
PDV atual está em Varejo, e ter "PDV" em Varejo e "Pedidos PDV" em Comercial vai
confundir. Alternativas: nome diferente ("Balcão", "Venda rápida"), ou os dois
na mesma seção.

**7. Loja de tenant suspenso: o que o consumidor final vê?**
Hoje vê a página de pagamento pendente do Licite Agora
(`tenant-middleware.js:189`) — 6 dos 13 tenants estão nesse estado. Opções:
manter, mostrar "loja temporariamente indisponível" sem marca do Licite Agora, ou
manter a loja no ar durante a suspensão.

**8. Produto sem estoque no catálogo público: some, aparece esgotado, ou aceita
encomenda?** Hoje aparece como `sob-consulta` e **pode ser comprado**, com o 409
só no fechamento.

**9. URL pública: fica no subdomínio?**
Recomendo `https://<slug>.liciteagora.app/loja/`, que **já funciona hoje**. O
formato `liciteagora.app/loja/<slug>` do seu §21 exige um segundo mecanismo de
resolução de tenant e convida à enumeração. Domínio próprio do lojista é
possível (o ERP já emite certificados via NicSRS) mas é projeto à parte.

**10. Etiquetas sai do menu Catálogo?**
Recomendo **manter**: é módulo próprio (`etiquetas-routes.js`), sem relação com
catálogo online.

**11. O PDV/NFC-e atual entra no escopo do hardening de preço?**
Ele aceita preço e desconto do navegador (§T-1, §T-15). Corrigir é certo, mas
mexe em emissão fiscal em produção — **não** está em nenhuma fase acima
justamente por isso. Precisa ser decisão explícita sua.

---

## Confirmação final

Esta auditoria **não alterou nada**: nenhum arquivo de código, nenhuma tabela,
nenhuma migration, nenhum serviço reiniciado, nenhum commit. As consultas ao
banco foram todas `SELECT` e `PRAGMA` (leitura). O único arquivo criado é este.

