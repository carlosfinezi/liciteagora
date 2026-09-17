# 32 — Consolidação do módulo Varejo: PDV, Loja e Catálogo

**Data:** 2026-09-11, 20:30–21:40 BRT
**Natureza:** auditoria. **Nada foi implementado, alterado ou reiniciado.**

| Unidade | PID | NRestarts | Desde |
|---|---|---|---|
| `consulta-licitacoes.service` | 3777293 | 0 | 2026-09-11 12:14:16 |
| `liciteagora.service` | 3085849 | 0 | 2026-09-11 06:18:49 |

Sem restart externo. Acesso a tenants **somente leitura** (`SELECT`/`PRAGMA`). Nenhuma escrita, nenhum fluxo executado.

---

## 1. Visão geral

A pergunta era se há duplicidade entre o PDV antigo, o Pedidos PDV novo e o Catálogo Online planejado. A resposta curta: **sim, mas menos do que parece — e há uma duplicidade a mais do que você listou.**

Três achados mudam o enquadramento:

1. **O PDV antigo nunca foi usado.** `nfce = 0` nos **19 tenants**. Nenhuma venda, nenhum cupom emitido. O mesmo vale para TEF (`tef_transacoes = 0`) e para o carrinho da loja (`loja_carrinho = 0`).
2. **A Loja virtual já é o Catálogo Online.** Ela já cria `pedidos` + `pedido_itens`, reserva estoque e emite cobrança PIX/boleto. Não é um modelo paralelo — é a mesma tabela, mesma numeração.
3. **Existe um terceiro fluxo de venda que não estava na sua lista:** o módulo **Restaurante**, com 14 arquivos de backend, cardápio público próprio e comandas (`rest_comandas`). Ele **não** usa `pedidos`.

Então o mapa real não é "2 PDVs". É:

| Fluxo | Documento que gera | Vivo? |
|---|---|---|
| PDV antigo (`/varejo/pdv.html`) | `nfce` | **não** — 0 registros |
| Pedidos PDV novo (`/comercial/pedidos-pdv.html`) | `pedidos` | sim |
| Loja virtual (`/loja/index.html`) | `pedidos` | 1 loja ativa, 0 pedidos |
| Restaurante (cardápio + comandas) | `rest_comandas` | residual (1 e 3 registros) |

---

## 2. PDV antigo

### Localização

| Camada | Onde |
|---|---|
| Tela | `public/varejo/pdv.html` (614 linhas) |
| Menu | VAREJO → PDV, `page: 'pdv'`, feature `varejo` |
| Backend | **`nfce-routes.js`** — não existe `pdv-routes.js` |
| Rotas | `GET/POST /api/pdv/config`, `POST /api/pdv/finalizar` |
| Gate | `module-gate.js` → módulo `varejo`; `perfis-api-map` → páginas `pdv`, `pdv-config` |

A tela chama só quatro endpoints: `/api/nfce/produtos/buscar`, `/api/pdv/config`, `/api/pdv/finalizar` e `/api/pessoas`.

### O fluxo ponta a ponta — a resposta à sua pergunta central

**O PDV antigo NÃO cria registro em `pedidos`.** Nem hoje, nem nunca. Ele é **NFC-e-first**: a nota fiscal é o documento de venda.

`POST /api/pdv/finalizar` faz uma coisa só:

```js
const r = await emitirNFCe(db, payload);
res.json({ success: true, modelo: '65', ...r });
```

E `emitirNFCe` executa, nesta ordem:

1. monta e assina o XML, transmite à SEFAZ;
2. **só depois de autorizada**, grava `nfce`, `nfce_itens`, `nfce_pagamentos`;
3. `pessoaDaVenda()` — acha a pessoa pelo CPF/CNPJ ou **cria** em `pessoas`;
4. `aplicarEfeitosDaNatureza()`, que decide o resto pela natureza de operação configurada:
   - `natureza.geraFinanceiro` → insere em `contas_a_receber` com **`origem='nfce'`** e **`nfceId`**, parcelado conforme a política de prazo;
   - `natureza.movimentaEstoque` → insere em `movimentacoes_estoque` com **`origem='nfce'`**, uma linha por lote quando o módulo Farmácia está ligado (FEFO/SNGPC).

Tudo dentro de uma transação, depois da autorização.

### O que a tela tem — e o que ela não tem

| Recurso | Estado |
|---|---|
| busca de produto | sim (`/api/nfce/produtos/buscar`) |
| cliente | sim, por CPF/CNPJ (`/api/pessoas`) |
| carrinho | sim, em memória |
| desconto | sim (8 ocorrências) |
| pagamento | sim, formas fiscais (tPag) |
| NFC-e | sim — é o propósito |
| impressão | sim (DANFE/cupom) |
| estoque | sim, via natureza |
| **código de barras** | **não** |
| **atalhos de teclado** | **não** |
| **TEF na operação** | **não** |
| **vendedor** | **não** |
| **fechamento de caixa** | **não** |
| **rascunho / venda pendente** | **não** |

> É importante ser exato: **isto não é um PDV de balcão completo.** É uma tela de emissão de NFC-e com carrinho. Falta o que caracteriza um PDV de varejo — leitor de código de barras, atalhos, sangria/suprimento, fechamento de caixa, venda em espera.

### Uso real

**Zero.** `SELECT COUNT(*) FROM nfce` retorna **0 em todos os 19 tenants**. Não há uma única venda, nem em sandbox.

---

## 3. Pedidos PDV novo

| Camada | Onde |
|---|---|
| Tela | `public/comercial/pedidos-pdv.html` (1.051 linhas) |
| Menu | COMERCIAL → Pedidos PDV |
| Backend | **nenhum próprio** |

### O que ele reutiliza

Usa exclusivamente endpoints que já existiam: **`/api/pedidos`**, `/api/pedidos/:id/itens`, `/api/produtos`, `/api/pessoas`. Nenhuma rota nova, nenhuma tabela nova — foi a condição da Fase 2.1.

O ciclo de vida de `pedidos` que ele herda já é rico:

```
/api/pedidos/:id/confirmar · /cancelar · /reabrir · /entregar
/api/pedidos/:id/registrar-pagamento · /parcelas · /pdf · /historico
/api/pedidos/:id/converter-modo · /status
```

### O que tem

| Recurso | Estado |
|---|---|
| cria `pedidos` | sim — rascunho, com itens |
| grade de produtos por categoria | sim |
| cliente | sim |
| desconto com alçada | sim (Fase 1 funcional) |
| `tipoAtendimento` | sim |
| rascunho | sim |
| reserva de estoque | sim (herdada de `pedidos`) |
| confirmação | sim |
| touch/mobile | sim (Fase 2.2) |

### O que falta

| Recurso | Estado |
|---|---|
| pagamento na tela | parcial — `registrar-pagamento` existe na API, a tela não o usa no fluxo de balcão |
| NFC-e | **não** — e a ponte não existe (§4) |
| TEF | **não** |
| impressão de cupom | **não** |
| código de barras | **não** |
| fechamento de caixa | **não** |
| vendedor | **não** |

---

## 4. Comparação PDV antigo × Pedidos PDV novo

| Funcionalidade | Antigo | Novo | Classificação |
|---|---|---|---|
| cliente | sim (CPF/CNPJ) | sim (`/api/pessoas`) | **nos dois** — novo é mais completo |
| produto | busca própria NFC-e | `/api/produtos` | **nos dois** — reaproveitar o do novo |
| categoria | não | sim | **só no novo** |
| estoque | via natureza, na emissão | reserva + baixa na confirmação | **nos dois**, modelos diferentes |
| preço | `precoVenda` | `precoDeItem` (servidor decide) | **só no novo** tem regra |
| desconto | livre | **com alçada e aprovação** | **só no novo** — não reaproveitar o antigo |
| carrinho | memória, some ao sair | `pedidos` em rascunho | **só no novo** persiste |
| pagamento | tPag fiscal | `registrar-pagamento` | **nos dois**, modelos diferentes |
| dinheiro / PIX / cartão | sim (como tPag) | via parcelas/CR | **nos dois** |
| TEF | **não** (só cadastro) | não | **falta nos dois** |
| venda a prazo | sim (política de prazo → CR) | sim (parcelas) | **nos dois** |
| **NFC-e** | **sim** | **não** | **só no antigo** — é o que ele tem de único |
| NF-e (55) | não | sim (pedido → fatura → NF-e) | **só no novo** |
| reserva de estoque | não | sim | **só no novo** |
| baixa de estoque | sim (`origem='nfce'`) | sim (`origem='pedido'`) | **nos dois**, origens distintas |
| pedido pendente | não | sim (rascunho) | **só no novo** |
| histórico | via lista de NFC-e | `/api/pedidos/:id/historico` | **só no novo** |
| vendedor | não | não | **falta nos dois** |
| impressão | sim (cupom) | não | **só no antigo** — reaproveitável |
| código de barras | não | não | **falta nos dois** |
| touch/mobile | não | sim | **só no novo** |
| fiscal | NFC-e completo | nenhum | **só no antigo** |

### O gap arquitetural que decide tudo

**`nfce-routes.js` tem ZERO referência a `pedidoId`.** Verificado por busca direta: a NFC-e não sabe o que é um pedido.

E o caminho fiscal que **existe** para pedidos é outro:

```
pedido → fatura (faturas.pedidoId) → NF-e modelo 55
```

Confirmado em dados reais: 13 faturas no `1bit`, 24 no `produtosbomgosto`, 16 no `sandbox`.

Ou seja: **o pedido tem caminho para NF-e (55), mas não para NFC-e (65).** Essa ponte é o único trabalho estrutural que a consolidação exige.

---

## 5. PDV · Config

Tela: `public/varejo/pdv-config.html` (197 linhas). Grava em `nfce_config`, registro único (`id = 1`).

### Separação — e é mais limpa do que parecia

| Campo | Natureza | Serve ao Pedidos PDV? |
|---|---|---|
| `pdvTipoOperacaoId` | **operacional** — natureza da operação; decide `geraFinanceiro` e `movimentaEstoque` | **sim, diretamente** |
| `pdvPoliticaPrazoId` | **operacional** — meios de pagamento e vencimento das parcelas | **sim, diretamente** |
| `pdvModoImpressao` | **operacional** | sim |
| `pdvExigirCpfSempre` | misto — exigência fiscal com efeito operacional | sim |
| `tpAmb` (1=prod, 2=homolog) | **exclusivamente fiscal** | não |
| `serie`, `proximoNumero` | **exclusivamente fiscal** | não |
| `csc`, `cscId` | **exclusivamente fiscal** (credencial SEFAZ) | não |
| `limiteNFCe` | **exclusivamente fiscal** | não |

**Só 4 dos 16 campos são editáveis pela tela.** Três existem no schema e não aparecem em lugar nenhum — `pdvModeloPadrao`, `pdvFormaPagamentoPadrao`, `pdvExigirClienteCadastrado`: configuração órfã.

**A parte reaproveitável é justamente a mais valiosa:** natureza de operação e política de prazo são exatamente o que o Pedidos PDV precisaria para decidir financeiro, estoque e parcelamento sem reinventar regra.

---

## 6. TEF

Tela `public/varejo/tef.html`, backend `tef-routes.js` (7,5 KB).

### A descoberta boa

**O TEF já aponta para `pedidos`, não para NFC-e.**

```sql
tef_transacoes: id, terminalId, pedidoId, faturaId, tipo, bandeira,
                parcelas, valor, autorizacao, nsu, status, ...
FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
CREATE INDEX idx_tef_pedido ON tef_transacoes(pedidoId);
```

`nfce` **não aparece uma vez sequer** em `tef-routes.js`.

**Respondendo diretamente: o Pedidos PDV pode reutilizar o TEF sem nenhum desacoplamento.** Ele já foi modelado para o pedido — está acoplado ao fluxo *de pedido*, não ao fiscal.

### A ressalva honesta

O próprio arquivo declara:

> "Esta versão NÃO se conecta a hardware (pinpad físico) nem a SDKs nativos como SiTef ou GerTef. Permite registro manual da transação."

Zero chamadas HTTP a provedor. **É um registro manual de transação**, não uma integração. E `tef_transacoes = 0` em todos os tenants.

Então o que existe é o **modelo de dados** — que é bom e reaproveitável — e não a integração.

---

## 7. Loja virtual

| Camada | Onde |
|---|---|
| Admin | `public/varejo/loja.html` (483 linhas) — VAREJO → Loja virtual |
| Público | `public/loja/index.html` (493 linhas) |
| Backend | `loja-routes.js` |
| Tabelas | `loja_config` (1 registro), `loja_carrinho`, `produtos.publicadoNaLoja` |

### Rotas

```
Admin:    /api/loja/config · /api/loja/logo · /api/loja/produtos · /api/loja/produtos/publicar
Público:  /loja/api/config · /loja/api/produtos · /loja/api/produtos/:id
          /loja/api/eu · /loja/api/carrinho
          /loja/api/pedido · /loja/api/pedido/:id/cobranca · /loja/api/meus-pedidos
```

### **Sim — ela já cria pedido comercial normal**

Esta era a sua pergunta central sobre a loja, e a resposta é inequívoca. O próprio código diz:

> *"Fecha o carrinho como pedido do ERP. Nasce em rascunho, com reserva de estoque — o lojista confirma na tela de pedidos que já usa. Não é um registro paralelo: mesma tabela, mesma numeração, mesmo fluxo."*

```sql
INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status,
                     dataPedido, observacao, depositoId, origemLoja)
VALUES (?, 'catalogo', 'pedido', ?, 'rascunho', ..., 1)
```

E na sequência: `pedido_itens`, `recalcularTotal()`, `criarReservasPedido()`, limpeza do carrinho, e `emitirCobranca()` quando configurado — que gera `contas_a_receber.pedidoId` e o boleto/PIX.

### O que ela tem

| Recurso | Estado |
|---|---|
| vitrine por `publicadoNaLoja` | sim |
| categorias | sim |
| **cria `pedidos`** | **sim**, `tipo='catalogo'`, rascunho |
| reserva de estoque | sim |
| cobrança PIX / boleto | sim (`pagamentoModo`) |
| "meus pedidos" do comprador | sim |
| reabrir QR do PIX | sim |
| login do comprador | sim (mesmo cliente do portal) |
| aparência (logo, tema, contatos) | sim, básico |

### O que falta

Medido por busca no backend — **zero ocorrências** de: `busca`, `cupom`, `endereco`, `entrega`, `retirada`, `frete`, `destaque`, `personaliza`.

| Recurso | Estado |
|---|---|
| busca de produto | **falta** |
| destaques / boas-vindas | **falta** |
| endereço de entrega | **falta** |
| entrega × retirada | **falta** |
| frete | **falta** |
| cupom de desconto | **falta** |
| personalizações de item | **falta** |
| cartão no checkout | **falta** (só PIX/boleto) |

### Uso real

| | |
|---|---|
| lojas ativas | **1** — `1bit`, modo `pix-ou-boleto` |
| produtos publicados | **2** (todos no `1bit`) |
| carrinhos | **0** em todos os tenants |
| pedidos com `origemLoja=1` | **0** |

O `loja_config` existe em 18 tenants, mas com `ativa=0` e sem nome: é registro default criado por migração, não uso.

---

## 8. Loja virtual × Catálogo Online planejado

| Funcionalidade planejada | Situação real |
|---|---|
| **Admin** | |
| Página de produtos | **já existe** (`/api/loja/produtos/publicar`) |
| Página de boas-vindas | **falta** |
| Aparência | **parcialmente existe** — logo, tema, contatos; sem banner/destaque |
| Entrega e retirada | **falta** |
| Pagamentos | **parcialmente existe** — `pagamentoModo` PIX/boleto; sem cartão |
| Cupons | **falta** |
| Configurações | **já existe** |
| **Público** | |
| loja / vitrine | **já existe** |
| categorias | **já existe** |
| destaques | **falta** |
| busca | **falta** |
| página de produto | **já existe** (`/loja/api/produtos/:id`) |
| personalizações | **falta** |
| carrinho | **já existe** (`loja_carrinho`) |
| cliente | **já existe** — mesmo cadastro do portal |
| endereço | **falta** |
| retirada / entrega | **falta** |
| pagamento | **parcialmente existe** — PIX/boleto |
| **pedido indo para o fluxo de pedidos** | **JÁ EXISTE** |

**Conclusão desta seção: o Catálogo Online planejado é ~60% a Loja virtual que já está no ar.** O item mais caro da lista — criar pedido de verdade, com reserva e cobrança — está pronto e funcionando. O que falta é o que se acrescenta por cima: busca, endereço, entrega, cupom, destaques.

**Ela deve ser evoluída, não substituída.**

---

## 9. Fluxo de dados — os reais, medidos no código

### A) PDV antigo

```
Operador → /varejo/pdv.html
  → POST /api/pdv/finalizar
  → emitirNFCe()
      → XML assinado → SEFAZ  ◄── ponto de falha externo
      → (autorizada) grava nfce + nfce_itens + nfce_pagamentos
      → pessoaDaVenda()          → pessoas (cria se não existir)
      → aplicarEfeitosDaNatureza()
           ├─ geraFinanceiro    → contas_a_receber (origem='nfce', nfceId)
           └─ movimentaEstoque  → movimentacoes_estoque (origem='nfce')
```

**`pedidos` não aparece em ponto nenhum.** O estoque só baixa depois de a SEFAZ autorizar — se a SEFAZ estiver fora, não há venda.

### B) Pedidos PDV novo

```
Operador → /comercial/pedidos-pdv.html
  → POST /api/pedidos                    → pedidos (rascunho)
  → POST /api/pedidos/:id/itens          → pedido_itens (preço decidido no servidor)
  → [desconto acima da alçada → aprovacoes]
  → POST /api/pedidos/:id/confirmar      → reserva/baixa de estoque
                                            movimentacoes_estoque (origem='pedido')
  → (depois, fora do PDV)
      /api/pedidos/:id/registrar-pagamento → contas_a_receber (pedidoId)
      fatura (faturas.pedidoId)            → NF-e modelo 55
```

**Não há saída para NFC-e.**

### C) Loja virtual

```
Consumidor → /loja/index.html (login de comprador)
  → POST /loja/api/carrinho     → loja_carrinho (por pessoaId)
  → POST /loja/api/pedido
       ├─ confere estoque no fechamento (409 se faltou)
       ├─ INSERT pedidos (tipo='catalogo', rascunho, origemLoja=1)
       ├─ INSERT pedido_itens + recalcularTotal()
       ├─ criarReservasPedido()
       ├─ DELETE loja_carrinho
       └─ emitirCobranca() → contas_a_receber (pedidoId) → boletos (PIX/boleto)
  → lojista confirma na tela de Pedidos que já usa
```

**Este fluxo já está certo.** É exatamente o desenho que o Catálogo Online pretendia.

### D) Restaurante — o fluxo que não estava na lista

```
Cliente → /cardapio/... → POST /cardapio/api/pedido
  → rest_comandas + rest_comanda_itens + rest_comanda_item_opcoes + rest_entregas
```

**Não toca em `pedidos`.** É um quarto modelo de venda.

---

## 10. Tabelas por área

| Área | Tabelas |
|---|---|
| **PDV antigo** | `nfce`, `nfce_itens`, `nfce_pagamentos`, `nfce_config` · escreve em `pessoas`, `contas_a_receber`, `movimentacoes_estoque` |
| **Pedidos PDV novo** | `pedidos`, `pedido_itens`, `pedido_parcelas`, `pedido_historico`, `aprovacoes` · `movimentacoes_estoque`, `contas_a_receber` |
| **Loja virtual** | `loja_config`, `loja_carrinho`, `produtos.publicadoNaLoja` · **`pedidos`**, `pedido_itens`, `contas_a_receber`, `boletos` |
| **TEF** | `tef_terminais`, `tef_transacoes` (→ `pedidos`, `faturas`) |
| **Fiscal do pedido** | `faturas` (→ `pedidos`), NF-e 55 |
| **Restaurante** | `rest_comandas`, `rest_comanda_itens`, `rest_comanda_item_opcoes`, `rest_comanda_pagamentos`, `rest_comanda_eventos`, `rest_entregas` |
| **Romaneios** | `romaneios`, `romaneio_paradas`, `prod_romaneios`, `prod_romaneio_itens` |

### Duplicidades de modelo — as reais

| # | Duplicidade | Gravidade | Observação |
|---|---|---|---|
| 1 | **`contas_a_receber` com `pedidoId` E `nfceId`** | **alta** | dois caminhos para a mesma CR; relatórios que somem por um não veem o outro |
| 2 | **`movimentacoes_estoque` com `origem='pedido'` e `origem='nfce'`** | **alta** | duas origens para a mesma baixa. Nos dados reais só `'pedido'` aparece — `'nfce'` nunca foi usado |
| 3 | **`rest_comandas` × `pedidos`** | média | dois modelos de venda; **tem justificativa de negócio** (comanda de mesa, KDS, garçom) |
| 4 | **`loja_carrinho` × carrinho do PDV novo** | baixa | um persiste em tabela, o outro é o próprio rascunho de `pedidos`. Convergem no mesmo destino |
| 5 | **`nfce_config.pdv*` × configuração de pedido** | baixa | 4 campos operacionais presos numa tabela fiscal |

**Não há duplicidade de `pedidos`.** Loja virtual e Pedidos PDV escrevem na mesma tabela, com a mesma numeração. Isso já está certo.

---

## 11. Menu e UX

### Hoje

```
COMERCIAL → Pedidos
COMERCIAL → Pedidos PDV
VAREJO    → PDV · PDV·Config · TEF · Marketplaces · Loja virtual · Romaneios
```

O problema não é só "dois PDVs no menu". É que **VAREJO mistura três coisas de naturezas diferentes**: operação de venda (PDV), configuração fiscal (PDV·Config, TEF) e canais de venda (Marketplaces, Loja virtual). E Romaneios é logística, não varejo.

### Proposta futura (não aplicada)

```
COMERCIAL
  ├── Pedidos              (lista e edição — como hoje)
  └── Pedidos PDV          (balcão — a tela de operação)

CATÁLOGO
  ├── Produtos             (como hoje)
  ├── Catálogo Online      ← a Loja virtual, renomeada e evoluída
  └── Marketplaces         (canal de venda, junto do catálogo que o abastece)

FISCAL
  ├── Configuração fiscal  ← tpAmb, série, CSC, limite (de nfce_config)
  ├── NFC-e                ← lista/consulta/cancelamento de cupons
  └── TEF                  (terminais e transações)

LOGÍSTICA
  └── Romaneios            (sai do Varejo — é entrega, não venda)
```

**A seção VAREJO desaparece**, e cada peça vai para onde ela pertence pela função. Configuração operacional (natureza de operação, política de prazo) migra para a configuração de Pedidos, onde o Pedidos PDV a alcança.

---

## 12. Riscos de migração

Esta é a parte em que a auditoria mudou a conversa — **o risco é muito menor do que o esperado**, porque quase nada está em uso.

| Item | Situação real | Risco |
|---|---|---|
| clientes usando PDV antigo | **nenhum** — `nfce = 0` em 19/19 tenants | **nulo** |
| cupons fiscais históricos | **nenhum** | **nulo** |
| TEF | `tef_transacoes = 0` | **nulo** |
| carrinhos abertos na loja | `loja_carrinho = 0` | **nulo** |
| pedidos vindos da loja | **0** com `origemLoja=1` | **nulo** |
| URL pública da loja | 1 loja ativa (`1bit`), 2 produtos | **baixo** — um tenant, e é o seu |
| `loja_config` | 18 registros default (`ativa=0`, sem nome) | **nulo** |
| comandas de restaurante | 1 (`1bit`) + 3 (`labfiscal`) | **baixo** — residual/teste |
| pedidos históricos | 29 (`1bit`), 22 (`produtosbomgosto`), 11 (`josecarloscostafilho`), 131 (`sandbox`) | **alto se tocado** — é o fluxo vivo |
| configurações de PDV | `nfce_config` existe, 4 campos preenchíveis | **baixo** |

### Quem veria a mudança

Feature `varejo` vem do plano (`plan_modules`): só `avancado` e `enterprise`.

**Tenants ativos com VAREJO visível: três** — `1bit`, `jaagricola`, `labfiscal`. Todos enterprise. `hseletricista` tem `avancado` mas está SUSPENDED.

Os outros ativos (`produtosbomgosto`, `reimac`, `josecarloscostafilho`) são `basic` e **nunca viram o menu VAREJO**.

> **Nada deve ser apagado.** O que a auditoria mostra é que a interface pode ser aposentada sem perda de dados — porque não há dados. O backend de NFC-e, esse, precisa continuar: é ele que emite cupom fiscal, e é a única coisa que só o PDV antigo sabe fazer.

---

## 13. Proposta de arquitetura final

O princípio: **um pedido, um estoque, um financeiro, um catálogo. O fiscal é um serviço, não um fluxo paralelo.**

```
                       ┌──────────────────────────┐
   balcão ─────────────►                          │
   (Pedidos PDV)       │                          │
                       │      pedidos +           │
   catálogo online ────►      pedido_itens        ├──► movimentacoes_estoque
   (ex-Loja virtual)   │   (rascunho → confirmado)│    (origem='pedido')
                       │                          │
   marketplaces ───────►                          ├──► contas_a_receber
                       └────────────┬─────────────┘    (pedidoId)
                                    │
                       ┌────────────▼─────────────┐
                       │   camada fiscal (serviço) │
                       │   NFC-e (65) · NF-e (55)  │
                       └───────────────────────────┘
```

O que isso exige, concretamente: **uma ponte `pedido → NFC-e`**, hoje inexistente (`nfce-routes.js` não conhece `pedidoId`). É o único trabalho estrutural.

**Restaurante fica separado, e por razão legítima:** comanda de mesa, KDS, garçom e iFood são outro modelo de operação, com feature própria e plano próprio. Forçar `rest_comandas` dentro de `pedidos` seria unificação pela unificação — exatamente o que você pediu para não fazer.

---

## 14. Recomendação por área

### PDV antigo
**Descontinuar a interface, preservar e reaproveitar o backend.**

A tela não tem código de barras, atalhos nem fechamento de caixa — não é um PDV de balcão, e nunca foi usada. Mas `emitirNFCe()` e `aplicarEfeitosDaNatureza()` são código bom e testado, e são a **única** forma de emitir cupom fiscal no sistema.

Caminho: transformar `nfce-routes.js` em **serviço fiscal**, chamado a partir do pedido. A tela vira uma consulta de NFC-e emitidas (em FISCAL).

### Pedidos PDV novo
**Continuar. É a base certa.**

Já escreve na entidade real, já tem alçada de desconto, preço decidido no servidor, reserva de estoque e rascunho — tudo o que o antigo não tem. O que falta incorporar do antigo: **impressão de cupom**, **formas de pagamento fiscais (tPag)** e a ponte para NFC-e.

### Loja virtual
**Evoluir para Catálogo Online. Não substituir.**

Ela já faz o mais difícil: cria `pedidos` de verdade, reserva estoque e cobra. Trocar isso por uma implementação nova seria refazer o que funciona. O trabalho é aditivo — busca, endereço, entrega/retirada, cupom, destaques — mais o renome e a mudança de seção no menu.

### PDV · Config
**Dividir em dois.**

- **Operacional** (`pdvTipoOperacaoId`, `pdvPoliticaPrazoId`, `pdvModoImpressao`) → migra para a configuração de Pedidos, onde o Pedidos PDV a alcança. São exatamente as regras de financeiro, estoque e parcelamento que ele precisaria reinventar.
- **Fiscal** (`tpAmb`, `serie`, `proximoNumero`, `csc`, `cscId`, `limiteNFCe`) → fica, em FISCAL → Configuração fiscal.
- Os três campos órfãos (`pdvModeloPadrao`, `pdvFormaPagamentoPadrao`, `pdvExigirClienteCadastrado`) precisam de decisão: usar ou remover.

### TEF
**Integrar ao novo PDV — já está pronto para isso.**

`tef_transacoes.pedidoId` com FK para `pedidos` e zero menção a `nfce`. Não há acoplamento fiscal a desfazer. A ressalva é outra: **não existe integração real com pinpad**, só registro manual. O modelo serve; a integração é trabalho novo, e independente desta consolidação.

---

## 15. Roadmap de consolidação (proposta, não executada)

| # | Etapa | Depende de | Risco |
|---|---|---|---|
| 1 | Ponte `pedido → NFC-e`: `emitirNFCe` aceitar `pedidoId`, gravar `nfce.pedidoId` | — | médio (fiscal) |
| 2 | Formas de pagamento fiscais (tPag) e impressão de cupom no Pedidos PDV | 1 | baixo |
| 3 | Migrar config operacional de `nfce_config` para configuração de Pedidos | — | baixo |
| 4 | Loja virtual → Catálogo Online: busca, destaques, boas-vindas | — | baixo |
| 5 | Endereço, entrega × retirada, frete | 4 | médio (modelo novo) |
| 6 | Cupons | 4 | baixo |
| 7 | TEF no fluxo de pagamento do Pedidos PDV | 2 | baixo |
| 8 | Reorganizar o menu (VAREJO → COMERCIAL/CATÁLOGO/FISCAL/LOGÍSTICA) | 1–7 | baixo, mas **visível ao cliente** |
| 9 | Aposentar a tela `/varejo/pdv.html`, virando consulta de NFC-e | 1, 2 | baixo (0 uso) |

**A ordem importa:** o passo 1 é o que destrava tudo. Sem a ponte `pedido → NFC-e`, aposentar o PDV antigo tiraria do sistema a capacidade de emitir cupom fiscal.

---

## 16. Em português simples

**O que já existe:**
Um fluxo de pedido maduro (`pedidos` + itens + parcelas + histórico + reserva de estoque + alçada de desconto + NF-e via fatura). Uma loja virtual que **já cria pedido de verdade**, reserva estoque e cobra por PIX ou boleto. Um emissor de NFC-e completo e funcionando. Um modelo de TEF já ligado ao pedido.

**O que vale reaproveitar:**
Quase tudo. O `emitirNFCe` (é o único emissor de cupom que existe). A natureza de operação e a política de prazo do PDV·Config — são regras prontas de financeiro e estoque. O modelo do TEF. E a loja virtual inteira, que é ~60% do Catálogo Online planejado.

**O que estamos duplicando:**
Três coisas de verdade. **Dois caminhos de conta a receber** (`pedidoId` e `nfceId`) e **duas origens de baixa de estoque** (`'pedido'` e `'nfce'`) — o que significa que um relatório que soma por um não enxerga o outro. E **duas telas de venda de balcão**, sendo que uma nunca foi usada. Achei ainda um quarto fluxo que não estava na conversa: o cardápio do Restaurante, que cria `rest_comandas` em vez de `pedidos` — mas esse tem motivo de negócio para ficar separado.

**O que eu recomendo:**
Não construir um segundo de nada. O caminho mais curto e mais seguro é: **fazer o pedido virar cupom fiscal**. Hoje o pedido chega até a NF-e, mas não até a NFC-e — e é só isso que falta para o Pedidos PDV substituir o PDV antigo por completo. Feito isso, a tela velha pode ser aposentada sem perder nada, porque não há nada a perder: zero vendas em 19 tenants.

Em paralelo, e sem depender disso, a Loja virtual deve ser **renomeada e evoluída** para Catálogo Online — não reescrita. Ela já acerta a parte difícil.

E o menu deve deixar de ter uma seção "Varejo" que mistura operação, fiscal e canal de venda. Mas isso é o último passo, não o primeiro: é o que o cliente vê.

---

## GO / STOP

**STOP**, como pedido. Auditoria concluída, **nada foi implementado**.

Nenhum arquivo de código foi alterado. Nenhuma tabela tocada. Nenhum menu, API ou serviço modificado. Os dois serviços seguem com os PIDs e `NRestarts` do pré-check.

**GO condicional** para o roadmap, se você aprovar — começando pelo passo 1 (ponte `pedido → NFC-e`), que é o que destrava a consolidação inteira e tem o maior conteúdo fiscal. Recomendo que esse passo seja uma fase própria, com homologação SEFAZ em `tpAmb=2` antes de qualquer coisa em produção.

Uma ressalva sobre o alcance desta auditoria: ela foi feita lendo código e **contando registros nos bancos**. Não executei nenhum fluxo de venda, então o que afirmo sobre comportamento vem do código e do esquema, não de observação em execução. Onde o código declara uma coisa e os dados mostram outra — como o TEF que se diz MVP e tem zero transações — relatei os dois.
