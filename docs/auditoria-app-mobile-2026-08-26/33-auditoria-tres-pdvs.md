# 33 — Auditoria dos fluxos de venda: os três PDVs (e os que faltavam)

**Data:** 2026-09-11, 20:20–21:30 BRT
**Natureza:** auditoria somente leitura. **Nada implementado, nada alterado, nada reiniciado.**
**Corrige e amplia:** [32 — consolidação do varejo](32-consolidacao-varejo-pdv-loja.md)

| Unidade | PID | NRestarts | Desde |
|---|---|---|---|
| `consulta-licitacoes.service` | 3777293 | 0 | 2026-09-11 12:14:16 |
| `liciteagora.service` | 3085849 | 0 | 2026-09-11 06:18:49 |

Idênticos antes e depois. Sem restart externo. Apenas `SELECT`/`PRAGMA` em tenants. Nenhuma SEFAZ, TEF, cobrança ou escrita.

---

## 0. A correção, e o que a busca realmente encontrou

Você apontou que o relatório 32 considerou dois PDVs quando existem três. **A correção procede em substância, mas não na forma** — e a diferença importa para a decisão.

Procurei de quatro maneiras independentes:

1. **por conteúdo:** toda tela que menciona "PDV" — só três aparecem, e uma é a de configuração;
2. **pelo histórico do git:** `git log --all --diff-filter=AD` — o git conhece **um único** arquivo de PDV (`public/pdv.html`, movido para `varejo/`);
3. **pelo banco:** `pedidos.tipo='pdv'` existe e tem 76 registros — mas **todos de 2026-09-11**, criados pelas fases desta semana;
4. **por assinatura funcional:** varri as 200+ telas procurando a combinação grade de produtos + carrinho + total + finalizar + busca.

**Não existe uma terceira interface chamada PDV.** O que existe — e você identificou corretamente — é um **terceiro fluxo fiscal de venda**, que emite NF-e modelo 55 série 1 e passa por `pedidos`. Ele simplesmente não se chama PDV: é a tela de Pedido somada ao faturamento.

E a busca encontrou **mais dois** fluxos de venda que não estavam em nenhuma conversa:

| | Fluxo | Interface | Documento |
|---|---|---|---|
| 1 | PDV Varejo | `varejo/pdv.html` | NFC-e 65 |
| 2 | **Pedido → faturamento** | `comercial/pedido.html` | **NF-e 55 série 1** ← o que você descreveu |
| 3 | Pedidos PDV novo | `comercial/pedidos-pdv.html` | nenhum (pedido comercial) |
| 4 | **NF-e avulsa** | `fiscal/nova-nota.html` | **NF-e 55, sem pedido** ← não estava no mapa |
| 5 | **OS → faturamento** | `os/ordem-servico.html` | **NF-e 55, sem pedido** ← não estava no mapa |
| 6 | Loja virtual | `loja/index.html` | nenhum (cria pedido) |
| 7 | Restaurante | `/cardapio/…` | comanda própria — fora do escopo (§11) |

Conforme você pediu: encontrei mais de três, então parei de assumir três e incluí todas no mapa.

---

## 1. Tabela comparativa — os três PDVs

| Interface | Menu atual | Arquivo frontend | Backend principal | Modelo fiscal | Usa `pedidos`? |
|---|---|---|---|---|---|
| **PDV Varejo** | VAREJO → PDV | `public/varejo/pdv.html` (614 l.) | `nfce-routes.js` | **NFC-e 65** | **não** |
| **Pedido + faturamento** | COMERCIAL → Pedidos | `public/comercial/pedido.html` (2.543 l.) | `pedidos-routes.js` → `faturas-routes.js` → `nfe-emit-routes.js` | **NF-e 55, série 1** | **sim — é a origem** |
| **Pedidos PDV novo** | COMERCIAL → Pedidos PDV | `public/comercial/pedidos-pdv.html` (1.051 l.) | `pedidos-routes.js` | **nenhum** | **sim** |
| *NF-e avulsa* | FISCAL → Nova Nota | `public/fiscal/nova-nota.html` (671 l.) | `nf-avulsa-routes.js` | NF-e 55 | **não** (`pedidoId` NULL) |
| *Loja virtual* | VAREJO → Loja virtual | `public/loja/index.html` (493 l.) | `loja-routes.js` | nenhum | **sim** |

---

## 2. PDV de Varejo — NFC-e 65

Reauditado, e o relatório 32 se confirma em tudo. Acrescento o que faltava.

| Item | Achado |
|---|---|
| Rota/tela | `/varejo/pdv.html`, feature `varejo` (planos `avancado` e `enterprise`) |
| Endpoints | `/api/pdv/config`, `/api/pdv/finalizar`, `/api/nfce/produtos/buscar`, `/api/pessoas` |
| Backend | **`nfce-routes.js`** — não existe `pdv-routes.js` |
| Tabelas próprias | `nfce`, `nfce_itens`, `nfce_pagamentos`, `nfce_config` |
| **Modelo 65?** | **sim, exclusivamente.** A resposta carimba `modelo: '65'` |
| **Transmite à SEFAZ?** | **sim, direto e síncrono** — `POST /api/pdv/finalizar` bloqueia até a SEFAZ responder |
| **Cria `pedidos`?** | **não, nunca** |
| Estoque | baixa **só depois de autorizada**, `origem='nfce'`. Não há reserva |
| Financeiro | `contas_a_receber` com `origem='nfce'` e `nfceId`, parcelado pela política de prazo |
| Pagamento | `nfce_pagamentos.tPag` — formas fiscais |
| Cliente | `pessoaDaVenda()` — acha por CPF/CNPJ ou **cria** em `pessoas` |
| **Vendedor** | **não** |
| **Tabela de preço** | **não** — usa `precoVenda` do produto |
| **TEF** | **não** na operação |
| **Venda em espera** | **não** |
| **Caixa (abertura/fechamento)** | **não** |
| **Código de barras** | **não** |

### O ramo NF-e que ele teve, e perdeu

Achado novo, em `nfce-routes.js:208`:

> *"limiteNFCe, pdvModeloPadrao, pdvFormaPagamentoPadrao e pdvExigirClienteCadastrado eram da **decisão automática NFC-e/NFe, que saiu junto com o modelo 55 (2026-08-26)**. Em tenant já provisionado as colunas continuam lá, sem leitor."*

Ou seja: **o PDV de Varejo já emitiu NF-e 55**, escolhendo o modelo pelo valor da venda (`limiteNFCe`). Esse ramo foi removido em 26/08. As quatro colunas órfãs que o relatório 32 classificou como "configuração sem uso" têm esta origem — e isso importa: **já existiu no sistema um PDV único que decidia entre 55 e 65**, exatamente a hipótese da §10.

---

## 3. O fluxo NF-e 55 série 1 — o que você chamou de "PDV antigo de Pedidos"

Esta é a parte que faltou no relatório 32.

### Onde ele está

Não é uma tela de PDV. São **três camadas encadeadas**:

| Camada | Arquivo | Rota |
|---|---|---|
| Interface | `public/comercial/pedido.html` (2.543 linhas — a maior do comercial) | COMERCIAL → Pedidos |
| Faturamento | `faturas-routes.js` | `POST /api/pedidos/:id/faturar` |
| Emissão | `nfe-emit-routes.js` | `POST /api/faturas/:id/emitir-nfe` |

### O fluxo real, provado pelo código

```
cliente (pessoas)
  → pedido            POST /api/pedidos              → pedidos (rascunho)
  → itens             POST /api/pedidos/:id/itens    → pedido_itens
  → confirmação       POST /api/pedidos/:id/confirmar
  → entrega           POST /api/pedidos/:id/entregar → movimentacoes_estoque (origem='pedido')
  → faturamento       POST /api/pedidos/:id/faturar  → faturas (pedidoId) + fatura_itens
  → NF-e              POST /api/faturas/:id/emitir-nfe → SEFAZ → numeroNFe, serieNFe, statusSefaz
```

**O fluxo que você descreveu se confirma** — com uma precisão que muda a leitura: o estoque **não** baixa no faturamento. Baixa em `entregue`, um passo antes. O código é explícito ao recusar:

> *"Só é possível faturar pedidos com status `entregue` (atual: `…`). Marque como entregue para baixar o estoque antes de faturar."*

### Ciclo de status

```
rascunho → confirmado → em_separacao → entregue → faturado
                                    ↘ cancelado
```

### Respondendo às perguntas F e G

**F) O PDV antigo de Pedidos já tem a ponte pedido → faturamento → NF-e 55?**
**Sim, completa e em uso.** Não é uma ponte a construir — é o fluxo fiscal vivo do sistema.

**G) É um PDV separado ou uma interface para faturar pedidos?**
**Nem um nem outro, exatamente.** `pedido.html` é o **editor completo de pedido** do ERP — cliente, itens, preços, descontos com alçada, frete, parcelas, transportadora — e o faturamento é **uma ação dentro dela** (drawer "Ações" → Faturar).

Ela **consegue fazer uma venda completa de balcão**: cadastra cliente, adiciona produtos por busca, aplica desconto, confirma, entrega e fatura. O que ela não tem é **ergonomia de balcão** — é uma tela de formulário denso, com abas, pensada para venda B2B com negociação, não para fila de caixa.

**É por isso que o Pedidos PDV novo foi criado.** Não para substituir um fluxo fiscal, mas para dar interface de balcão ao mesmo fluxo.

---

## 4. Verificação da série 1 — sem aceitar cegamente

Você pediu para não aceitar. Verifiquei nas três fontes.

**No código** (`nfe-emit-routes.js:182`):
```js
db.prepare('INSERT OR IGNORE INTO nfe_config (id, tpAmb, serie, proximoNumero) VALUES (1, 2, 1, 1)').run();
```

**No schema multi-loja** (`estabelecimento_serie`):
```sql
modelo TEXT NOT NULL,          -- '55' NF-e, '65' NFC-e
serie INTEGER NOT NULL DEFAULT 1,
proximoNumero INTEGER NOT NULL DEFAULT 1,
UNIQUE(estabelecimentoId, modelo, serie)
```
> *"A MATRIZ continua no `nfe_config` legado (numeração intacta); FILIAIS usam esta tabela — linha criada sob demanda (serie=1, proximoNumero=1)."*

**Nos dados reais** — todas as 23 NF-e já emitidas:

| Tenant | Série | Autorizadas | Canceladas |
|---|---|---|---|
| `1bit` | **1** | 6 | 5 |
| `produtosbomgosto` | **1** | 13 | 3 |
| `josecarloscostafilho` | **1** | 1 | — |

**Conclusão:** série 1 é **default, não fixa**. A coluna é editável e o modelo suporta várias séries por estabelecimento (`UNIQUE(estabelecimentoId, modelo, serie)`). Na prática, 100% do emitido está em série 1 porque ninguém mudou o default.

Sua informação estava certa quanto ao fato; a nuance é que **não é uma trava** — é o valor inicial.

---

## 5. Pedidos PDV novo

### O que ele já reutiliza

| Recurso | Como |
|---|---|
| `/api/pedidos` | cria e lista pedidos — entidade real |
| `/api/pedidos/:id/itens` | itens, com preço decidido no servidor |
| `/api/pessoas` | cliente — mesmo cadastro do ERP |
| `/api/produtos` | catálogo, com categorias |
| Preço | `precoDeItem` — servidor decide, a tela não manda preço |
| Desconto | alçada e aprovação da Fase 1 |
| Estoque | reserva e baixa herdadas do ciclo de `pedidos` |
| `tipoAtendimento` | No local / Retirada / Entrega |
| Rascunho | é o próprio `pedidos.status='rascunho'` |

**Zero endpoints próprios. Zero tabelas próprias.** Foi a condição da Fase 2.1, e ela se manteve.

### O que falta para unificar os outros dois

| Falta | Para substituir qual | Dificuldade |
|---|---|---|
| Formas de pagamento fiscais (tPag) | PDV Varejo | baixa |
| Impressão de cupom | PDV Varejo | baixa |
| **Ponte pedido → NFC-e 65** | PDV Varejo | **alta — não existe** |
| Vendedor | ambos | baixa (`pedidos.vendedorId` **já existe**) |
| Tabela de preço | Pedido | média (o módulo existe: `comercial/tabelas-preco.html`) |
| Código de barras | ambos | baixa |
| Caixa / fechamento | PDV Varejo | média — **não existe em lugar nenhum** |
| Atalhos de teclado | PDV Varejo | baixa |

> Nota: para o **fluxo NF-e 55**, o Pedidos PDV novo **já não precisa de nada**. Ele cria `pedidos`, e `pedidos` já fatura e emite. O gap é só com a NFC-e.

---

## 6. Loja virtual — e a resposta que você marcou como especialmente importante

O relatório 32 se confirma: ela cria `pedidos` + `pedido_itens`, reserva estoque e emite cobrança.

```
Consumidor → loja_carrinho (por pessoaId)
  → POST /loja/api/pedido
       ├─ INSERT pedidos (tipo='catalogo', modoDocumento='pedido', status='rascunho', origemLoja=1)
       ├─ INSERT pedido_itens + recalcularTotal()
       ├─ criarReservasPedido()
       └─ emitirCobranca() → contas_a_receber (pedidoId) → boletos (PIX/boleto)
```

### O pedido da Loja pode ser faturado em NF-e 55?

**Sim. Sem nenhuma adaptação.**

Verifiquei o filtro de `/api/pedidos/:id/faturar` linha a linha. As condições são **quatro**, e nenhuma olha a origem:

```js
if (!pedido)                      → 404
if (!pedido.clienteId)            → "Pedido sem cliente — impossivel faturar"
if (status === 'faturado')        → "Pedido ja faturado"
if (status === 'cancelado')       → "Pedido cancelado"
if (status !== 'entregue')        → "Só é possível faturar pedidos com status entregue"
```

**Não há `WHERE tipo = …`, nem checagem de `origemLoja`.** O gate é o **status**, não a procedência.

Consequência prática, e é a mais importante desta auditoria: **um pedido da Loja virtual, do Pedidos PDV novo, do Mercado Livre ou digitado à mão são a mesma coisa para o funil fiscal.** Todos chegam a NF-e 55 pelo mesmo caminho, bastando passar por `entregue`.

**A convergência que queremos construir já existe do lado do pedido.** O que não existe é a saída para NFC-e.

---

## 7. Os dois caminhos fiscais — onde divergem

### CAMINHO NF-e 55

```
┌─ pedido.html (manual)      ─┐
├─ pedidos-pdv.html (balcão) ─┤
├─ loja/index.html (online)  ─┼──► pedidos ──► pedido_itens
└─ marketplaces (ML)         ─┘       │
                                      │  confirmar
                                      ▼
                                  entregue ──► movimentacoes_estoque (origem='pedido')
                                      │
                                      │  POST /api/pedidos/:id/faturar
                                      ▼
                                  faturas (pedidoId) + fatura_itens
                                      │
                                      │  POST /api/faturas/:id/emitir-nfe
                                      ▼
                                  SEFAZ ──► numeroNFe, serieNFe=1, statusSefaz
                                      │
                                      └──► contas_a_receber (pedidoId)
```

### CAMINHO NFC-e 65

```
varejo/pdv.html
     │  POST /api/pdv/finalizar
     ▼
emitirNFCe()  ──►  SEFAZ  ◄── síncrono: sem autorização, não há venda
     │
     │ (só depois de autorizada)
     ├──► nfce + nfce_itens + nfce_pagamentos
     ├──► pessoas (cria se não existir)
     ├──► contas_a_receber (origem='nfce', nfceId)
     └──► movimentacoes_estoque (origem='nfce')
```

### Onde divergem — e é mais fundo que "o documento é outro"

| | NF-e 55 | NFC-e 65 |
|---|---|---|
| **Documento de origem** | `pedidos` | **nenhum** — a nota é o documento |
| **Passos** | 5 (rascunho→confirmado→entregue→faturado→emitida) | **1** (finalizar) |
| **Quando o estoque baixa** | em `entregue`, **antes** do fiscal | **depois** da autorização SEFAZ |
| **Se a SEFAZ cair** | a venda existe, emite depois | **não há venda** |
| **Reserva de estoque** | sim | não |
| **Vínculo da CR** | `pedidoId` | `nfceId` |
| **Origem do estoque** | `'pedido'` | `'nfce'` |
| **Fatura** | sim (`faturas`) | não existe |
| **Rascunho** | sim | não |

**O ponto de divergência não é a emissão — é o começo.** Um nasce como documento comercial e ganha um fiscal depois; o outro nasce fiscal. Por isso a ponte não é trivial: exige decidir *em que momento* do ciclo do pedido a NFC-e é emitida, e o que fazer com o estoque, que nos dois modelos baixa em instantes diferentes.

---

## 8. Uso real — a matriz completa

Somente leitura, todos os tenants:

| Tenant | Pedidos | tipo='pdv' | tipo='catalogo' | Faturas | NF-e autorizada | NFC-e | TEF |
|---|---:|---:|---:|---:|---:|---:|---:|
| `1bit` | 29 | 0 | 0 | 13 | **6** | 0 | 0 |
| `produtosbomgosto` | 22 | 1 | 0 | 24 | **13** | 0 | 0 |
| `josecarloscostafilho` | 11 | 0 | 0 | 4 | **1** | 0 | 0 |
| `raeldouglas` | 2 | 0 | 0 | 2 | 0 | 0 | 0 |
| `labfiscal` | 0 | 0 | 0 | 3 | 0 | 0 | 0 |
| `jaagricola` | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| `sandbox` | 131 | 75 | 12 | 16 | 0 | 0 | 0 |
| `sandbox5/6` | 3 | 0 | 0 | 3 | 0 | 0 | 0 |

**Faturas por origem:** 65 no total — **60 a partir de pedido**, 5 sem pedido (2 no `1bit`, 3 no `labfiscal` — avulsa, OS ou devolução).

### Leitura honesta destes números

- **O fluxo NF-e 55 é o único vivo em produção.** 20 NF-e autorizadas em três tenants reais.
- **O PDV de Varejo nunca foi usado.** `nfce = 0` nos 19 tenants — e desta vez verifiquei o que você pediu: não é só a tabela `nfce`. Não há fatura de origem NFC-e, nem CR com `nfceId`, nem movimentação com `origem='nfce'`.
- **TEF zerado** em todos.
- **`tipo='pdv'` (76 registros) é das fases desta semana** — datas todas em 2026-09-11. Não é rastro do PDV antigo.
- **`labfiscal` tem 3 faturas e 0 pedidos** — as únicas faturas puramente avulsas do acervo. É o tenant que usa a Nova Nota.

---

## 9. Classificação — duplicidade real × separação necessária

| Item | Classificação | Justificativa |
|---|---|---|
| `pedido.html` × `pedidos-pdv.html` | **duplicidade de interface** | mesmo fluxo, mesmas tabelas, ergonomias diferentes. Legítimo enquanto uma é B2B densa e a outra é balcão |
| PDV Varejo × Pedidos PDV | **duplicidade de interface** | duas telas de balcão; uma nunca usada |
| `contas_a_receber.pedidoId` × `.nfceId` | **duplicidade de regra** | dois vínculos para a mesma CR; relatório que soma por um não vê o outro |
| `origem='pedido'` × `origem='nfce'` | **duplicidade de regra** | duas origens de baixa. Só `'pedido'` tem dados |
| NF-e 55 × NFC-e 65 | **fluxo fiscal diferente** | **não é duplicidade.** Documentos distintos, obrigações distintas, momentos de estoque distintos |
| `emitirNFCe()` | **código que NÃO pode ser removido** | é o único emissor de cupom fiscal do sistema |
| `emitirNFe()` + `faturas` | **código que NÃO pode ser removido** | é o fluxo vivo, 20 notas autorizadas |
| Natureza de operação + política de prazo (`nfce_config.pdv*`) | **código reutilizável** | regras prontas de financeiro/estoque/parcelamento |
| `tef_transacoes` (modelo) | **código reutilizável** | já aponta para `pedidos` |
| `limiteNFCe`, `pdvModeloPadrao`, `pdvFormaPagamentoPadrao`, `pdvExigirClienteCadastrado` | **legado aposentável** | órfãos da decisão 55/65 removida em 26/08 — **mas ver §10** |
| `varejo/pdv.html` (a tela) | **legado aposentável** | 0 uso; só depois de a NFC-e existir no pedido |
| NF-e avulsa (`nova-nota.html`) | **módulo que deve permanecer separado** | pré-nota sem pedido é caso legítimo (ajuste, brinde, complementar) |
| OS → faturamento | **módulo que deve permanecer separado** | serviço tem ciclo próprio |
| Restaurante | **fora do escopo** (§11) | vertical com feature e plano próprios |

---

## 10. A hipótese de uma interface única — avaliação

Sua hipótese: **uma tela (`Pedidos PDV`) que escolhe a finalidade fiscal** — NF-e 55, NFC-e 65, ou nenhuma emissão.

### É tecnicamente segura? **Sim, com uma condição.**

Três evidências sustentam:

1. **O funil já converge.** `/api/pedidos/:id/faturar` não filtra por tipo — loja, balcão, marketplace e manual já chegam ao mesmo lugar.
2. **O sistema já fez isso antes.** A decisão automática 55/65 existiu no PDV de Varejo até 26/08, escolhendo pelo `limiteNFCe`. Não é terreno novo.
3. **A separação fiscal não está na interface, está na natureza de operação.** `tipos_operacao` já carrega `geraFinanceiro` e `movimentaEstoque`, e tanto a NFC-e quanto a NF-e avulsa já a consultam.

### A condição — e é a parte difícil

**O momento do estoque é diferente nos dois modelos**, e isso não se resolve com um seletor na tela:

| | NF-e 55 | NFC-e 65 |
|---|---|---|
| estoque baixa | em `entregue`, antes do fiscal | após autorização da SEFAZ |
| se a SEFAZ cair | venda existe, emite depois | **não há venda** |

Num balcão, o cliente leva a mercadoria na hora. O modelo da NF-e 55 (`entregue` → `faturado`) até descreve isso bem — mas hoje exige **dois passos manuais** depois de confirmar.

**A recomendação:** manter **um pedido** e **duas saídas fiscais**, com a escolha vindo da **natureza de operação** (que já existe) e não de um botão solto. A tela oferece a operação ("Venda balcão consumidor", "Venda com NF-e"), e a natureza decide documento, estoque e financeiro.

Isso preserva a separação fiscal — que é obrigação legal, não preferência — sem três telas fazendo venda.

---

## 11. Restaurante — fora do escopo, e sem dependência

Conforme pedido. Verifiquei apenas se há dependência direta: `rest_comandas` não referencia `pedidos`, `faturas` nem `nfce`. **Nenhum acoplamento.** Fica para outra conversa.

---

## 12. Riscos

| Risco | Gravidade | Observação |
|---|---|---|
| **Mexer no fluxo NF-e 55** | **alta** | é o único vivo — 20 notas autorizadas em 3 tenants reais. Qualquer mudança aqui atinge faturamento em produção |
| Numeração fiscal | **alta** | `proximoNumero` em `nfe_config` e `estabelecimento_serie`. Número pulado ou repetido é problema com o fisco, não bug de tela |
| Ponte pedido → NFC-e | **alta** | decide *quando* emitir e *quando* baixar estoque. Exige homologação em `tpAmb=2` antes de qualquer coisa |
| Aposentar `varejo/pdv.html` | **baixa** | 0 uso; mas só depois de a NFC-e existir no pedido |
| Remover colunas órfãs | **média** | `limiteNFCe` e `pdvModeloPadrao` são o vestígio da decisão 55/65. **Não remover** — são o desenho que a §10 retoma |
| Menu | baixa, visível | 3 tenants ativos veem VAREJO (`1bit`, `jaagricola`, `labfiscal`) |
| NF-e avulsa | baixa | `labfiscal` usa (3 faturas sem pedido). Não descontinuar |
| Cancelamento de NF-e | — | 8 das 23 notas foram canceladas na SEFAZ — o fluxo de cancelamento está em uso e precisa continuar |

---

## 13. Ordem recomendada das próximas fases

| # | Fase | Por que nesta ordem | Risco |
|---|---|---|---|
| 1 | **Vendedor e tabela de preço no Pedidos PDV** | `pedidos.vendedorId` já existe; o módulo de tabelas de preço já existe. Ganho imediato, risco quase nulo, **não toca em fiscal** | baixo |
| 2 | **Pagamento no Pedidos PDV** (`registrar-pagamento` + formas) | a API já existe; fecha o ciclo de balcão sem emitir nada | baixo |
| 3 | **Natureza de operação escolhida na venda** | é a peça que a §10 identifica como o lugar certo da decisão fiscal. Prepara 4 e 5 sem emitir nada ainda | médio |
| 4 | **Atalho "faturar direto"** no Pedidos PDV (confirmar→entregar→faturar num passo) | usa a ponte 55 que **já existe e está em produção**. Entrega venda de balcão completa com NF-e **sem escrever uma linha de fiscal novo** | médio |
| 5 | **Ponte pedido → NFC-e 65** | só depois de 3 e 4. Fase própria, com homologação `tpAmb=2` | **alto** |
| 6 | Impressão, código de barras, atalhos | acabamento de balcão | baixo |
| 7 | Aposentar `varejo/pdv.html` → consulta de NFC-e | só depois de 5 | baixo |
| 8 | Reorganizar o menu | por último — é o que o cliente vê | baixo |

**A mudança em relação ao relatório 32:** lá eu recomendei começar pela ponte NFC-e. **Estava errado na prioridade.** O passo 4 entrega venda de balcão completa usando o caminho fiscal que já roda em produção — é mais barato, mais seguro, e adia o trabalho fiscal pesado para quando o resto estiver de pé.

---

## 14. Respostas diretas

**A) Onde está cada um?** Tabela da §1. Dois são telas de PDV; o terceiro é `pedido.html` + faturamento, que não se chama PDV.

**B) Finalidade fiscal real?** PDV Varejo = NFC-e 65 consumidor final. Pedido+faturamento = NF-e 55 série 1. Pedidos PDV novo = **nenhuma** — só documento comercial.

**C) Quem emite?** NF-e 55: pedido+faturamento, NF-e avulsa, OS. NFC-e 65: só o PDV de Varejo. Nenhum documento: Pedidos PDV novo e Loja virtual.

**D) Quem cria `pedidos` primeiro?** Pedidos PDV novo, Loja virtual, e a própria `pedido.html`. O PDV de Varejo **nunca**.

**E) Quem toca o quê?** §2, §3 e §5.

**F) A ponte pedido → fatura → NF-e 55 existe?** **Sim, completa e em produção** — 20 notas autorizadas.

**G) É um PDV separado?** Não. É o editor de pedido do ERP com "Faturar" no menu de ações. Faz venda completa, mas sem ergonomia de balcão.

**H) O que reutilizar?** Tudo o que a §13 lista nos passos 1 a 4 — `vendedorId`, tabelas de preço, `registrar-pagamento`, natureza de operação, e sobretudo **a ponte de faturamento inteira**, que não precisa ser reescrita.

**I) Relação entre todos?** `pedidos` é o centro. Pedidos PDV novo, Loja virtual e `pedido.html` escrevem nele; todos podem faturar em NF-e 55 pelo mesmo caminho. O PDV de Varejo é o único fora do centro — ele fala direto com a SEFAZ.

---

## GO / STOP

**STOP.** Auditoria concluída, **nada implementado**. Nenhum arquivo de código alterado, nenhuma tabela tocada, nenhum menu, API ou serviço modificado. PIDs e `NRestarts` idênticos ao pré-check.

**Não executei** a recomendação do relatório 32 de criar a ponte NFC-e e aposentar o PDV antigo — e esta auditoria mostra que **a ordem ali estava errada**: há caminho mais curto e mais seguro (§13, passos 1 a 4) que entrega venda de balcão completa usando o fiscal que já funciona.

Uma ressalva sobre o alcance: auditei lendo código e contando registros. Não executei nenhuma venda, não chamei SEFAZ nem TEF. O que afirmo sobre comportamento vem do código e do esquema; o que afirmo sobre uso vem da contagem nos bancos.
