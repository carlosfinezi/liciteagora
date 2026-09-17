# Fase 1 — fundação comercial para Pedidos PDV + Catálogo Online

Data: 2026-09-10 · Auditoria + implementação parcial + migration **proposta**.
Base: [`03`](03-arquitetura-mvp-e-roadmap.md) · [`04`](04-backend-preparado-para-app.md) ·
[`05`](05-catalogo-pdv-encaixe-erp.md) · [`06`](06-fase-0-frete-pagamento.md) ·
[`07`](07-fase-0-quantidade.md) · [`08`](08-fase-0-limites-quantidade-pagamento.md) ·
[`10`](10-restart-controlado-fase0.md).

> **Migration NÃO aplicada em produção.** Nenhum serviço reiniciado, nenhum
> commit, nenhum backfill, nada no Asaas. O `liciteagora.service` não foi tocado.

---

## 1. Arquitetura encontrada

O que a auditoria mudou em relação ao plano do relatório 05 — e mudou para
melhor, porque **três das cinco partes não precisam de coluna nova**:

| Parte | Descoberta | Precisa de migration? |
|---|---|---|
| **A. Origem** | `pedidos.tipo` **não é lido por nenhum filtro, relatório, BI, meta, comissão, faturamento ou integração** | **NÃO** |
| **B. Desconto** | não existe em `pedidos`/`pedido_itens`; mas a **fatura já tem** `valorDesconto` e já calcula `bruto + frete − desconto` | **SIM** |
| **C. Alçada** | o motor existente serve inteiro, sem alteração — muda só a unidade do limite | **NÃO** (só cadastro de faixas) |
| **D. Cliente** | `pessoas` exige apenas `cpfCnpj` + `razaoSocial`; faltava busca por telefone | **NÃO** |
| **E. Atendimento** | `pedidos` já tem endereço de entrega completo, `tipoFrete`, `valorFrete`, `dataEntregaPrevista`; falta só o modo | **SIM** (1 coluna) |

---

## 2. Decisões de reaproveitamento

| Em vez de criar | Reusei | Por quê |
|---|---|---|
| coluna `origem` | **`pedidos.tipo`** | já é semanticamente origem, e ninguém a consome como filtro. Duas colunas seriam dois lugares para divergir |
| motor de aprovação novo | **`governanca-alcadas.js`** | maduro, com faixas, valor travado, expiração, reenvio e diagnóstico — tudo já corrigido em 2026-08 |
| tabela de clientes do PDV | **`pessoas`** | `cpfCnpj` é UNIQUE e o `POST` já é idempotente (atualiza em vez de duplicar, reativa inativo) |
| campos de entrega novos | **`enderecoEntrega`… `telefoneEntrega`** (10 colunas) | já existem e já são usados pela NF-e |
| campo de data de retirada | **`dataEntregaPrevista`** | "quando o cliente recebe" cobre retirada e entrega |
| desconto por item | — | **não implementei**: os exemplos são de cabeçalho, e `fatura_itens.valorDesconto` já não é preenchido hoje. Rateio não é desta fase |

---

## 3. Schema atual relevante

```
pedidos (43 colunas)
  numero, tipo, modoDocumento, clienteId, status, statusPagamento,
  valorTotal, valorPago, valorFrete, tipoFrete, transportadoraId,
  dataPedido, dataEntregaPrevista, dataEntregaReal, dataValidade,
  enderecoEntrega, numeroEntrega, complementoEntrega, bairroEntrega,
  cidadeEntrega, ufEntrega, cepEntrega, codigoMunicipioEntrega,
  contatoEntrega, telefoneEntrega,
  vendedorId, tabelaPrecoId, depositoId, tipoOperacaoId, politicaPrazoId,
  origemLoja, faturaId, observacao, observacoesInterna
pedido_itens  pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal, cfop
pessoas       cpfCnpj UNIQUE, tipo, razaoSocial (NOT NULL); telefone, celular, …
regras_alcada tipoEvento, limiteValor REAL, papelAprovador, validadeDias, ativo
aprovacoes    tipoEvento, referenciaId, valorReferencia, status, valorAprovado, expiraEm, consumida
```

---

## 4. Schema mínimo proposto

**5 colunas, todas em `pedidos`. Nenhuma em `pedido_itens`. Nenhuma tabela nova.**

| Coluna | Tipo | Para quê |
|---|---|---|
| `descontoTipo` | TEXT | `'valor'` ou `'percentual'` — o que o operador escolheu |
| `descontoValor` | REAL DEFAULT 0 | o número informado (50 ou 10) |
| `descontoAplicado` | REAL DEFAULT 0 | **sempre em R$**, calculado pelo servidor. É esta que entra no total |
| `descontoMotivo` | TEXT | por que foi dado — é o que o aprovador lê |
| `tipoAtendimento` | TEXT | `'local'` / `'retirada'` / `'entrega'`; NULL = pedido anterior à fase |

Por que guardar **tipo + valor + aplicado** em vez de só o valor em reais: sem
`descontoTipo`/`descontoValor`, a tela não consegue mostrar "10%" de volta — só
"R$ 50,00" —, e a auditoria perde o que o operador realmente digitou.

---

## 5. Migration proposta

`scripts/migrate-fase1-pedido.js` — **criada, executada apenas em banco
descartável.**

- **Dry-run por padrão.** Só escreve com `--aplicar`.
- **Recusa aplicar sem tenant nomeado**: não existe modo "todos".
  `--aplicar` sem slug sai com código 2 e a mensagem *"aplicar nos 13 de uma vez
  não é operação de script"*.
- Só `ALTER TABLE ADD COLUMN`. **Nenhuma coluna removida, nenhum dado
  reescrito.** As colunas nascem NULL/0, então **todo pedido já gravado
  continua com o mesmo total**.
- Idempotente: confere `PRAGMA table_info` antes e depois; se o ALTER não
  persistir, lança.
- Transação por tenant.
- **Não semeia faixas de alçada.** Os percentuais são decisão da proprietária, e
  um seed com número inventado viraria regra de verdade.

Dry-run de hoje, nos 13 tenants:

```
1bit                  5 coluna(s) a criar: descontoTipo, descontoValor, descontoAplicado, descontoMotivo, tipoAtendimento
… (idem nos 13)
Nada foi escrito.
```

### Reversão

`DROP COLUMN` **não** está no script, de propósito: o SQLite só o suporta desde
a 3.35 e, num banco com índices e views, é mais arriscado do que conviver com
uma coluna ignorada. A reversão prática é parar de escrever nelas — o
`recalcularTotal` volta a somar itens + frete e nada mais muda.

---

## 6. Origem do pedido — **implementado, sem migration**

### Valores em produção antes de qualquer mudança (13 tenants)

| Valor | Pedidos |
|---|---:|
| `manual` | 48 |
| `os` | 10 |
| `marketplace` | 4 |
| `licitacao` | 2 |
| **total** | **64** |

Nenhum outro valor existe. `origemLoja=1`: **zero** pedidos (a loja do `1bit`
está ativa mas ainda não teve pedido).

### Auditoria de consumo — por que é seguro acrescentar valor

| Consumidor | Resultado |
|---|---|
| SQL filtrando `pedidos.tipo` | **nenhum** no repositório |
| relatórios, BI, metas, comissões | **nenhum** agrupa ou filtra por `tipo` |
| faturamento, fiscal, devoluções | usam `tipoOperacaoId`, não `tipo` |
| frontend | **um** uso: `public/comercial/pedido.html:1154`, `<span class="badge ${p.tipo}">${p.tipo}</span>` — imprime o valor cru e **não tem CSS por valor**. Valor novo aparece como texto sem estilo |

### O que ficou valendo

`pedido-politicas.js`:

```js
const ORIGENS_CLIENTE = ['manual', 'app', 'pdv'];     // o que o corpo pode declarar
const ORIGENS_PEDIDO = { manual:'ERP', pdv:'Pedidos PDV', catalogo:'Catálogo Online',
                         app:'App de vendas', marketplace:'Marketplace',
                         os:'Ordem de Serviço', licitacao:'Licitação' };
```

`'pdv'` entra no que o cliente pode declarar porque o Pedidos PDV é área interna
autenticada — quem a alcança já podia criar pedido manual, e declarar a origem
não amplia poder. `'catalogo'`, `'os'`, `'licitacao'` e `'marketplace'`
continuam **fora**: são gravadas pelos caminhos internos que as produzem.

`loja-routes.js`: o pedido da loja passa a nascer **`tipo='catalogo'`** em vez de
`'manual'`. `origemLoja` **não foi tocado** — é o que as consultas da própria
loja usam (`:384`, `:395`, `:454`), e mexer nele quebraria as telas dela.

---

## 7. Modelo de desconto — **código preparado, não ligado**

`pedido-desconto.js` (**arquivo novo, nenhuma rota faz `require` dele**).

```
calcularDesconto({ subtotal, tipo, valor }) → { ok, aplicado, percentual, erro }
totalDoPedido({ subtotalItens, desconto, frete })
verificarAlcadaDesconto(db, { pedidoId, percentual, usuario })
descontoDoPedido(db, pedidoId)      // 0 quando a coluna não existe
temColunaDesconto(db)
```

Comportamento:

| Entrada | Resultado |
|---|---|
| `percentual: 10` sobre 500 | aplica **R$ 50** |
| `valor: 30` sobre 500 | aplica **R$ 30**, percentual derivado **6%** |
| ausente ou `0` | **0**, sem erro |
| negativo (valor ou percentual) | **recusa** |
| percentual > 100 | **recusa** (100 exato vale) |
| valor > subtotal | **recusa**, com os dois números na mensagem |
| tipo inválido, `NaN`, `Infinity` | **recusa** |
| desconto em reais com subtotal 0 | **recusa** — produziria total negativo no primeiro item |

**Recusa, não corrige** — a mesma escolha de `erroValorFrete` e `erroQuantidade`.

**Por que não está ligado:** ele lê `pedidos.descontoAplicado`, que ainda não
existe. Ligar antes da migration derrubaria o pedido a cada item adicionado — e
o working tree **é** produção. Ainda assim o módulo é tolerante: sem a coluna,
`descontoDoPedido` devolve 0 e `totalDoPedido` soma itens + frete. É isso que
permitirá conectar sem um instante de inconsistência.

---

## 8. Integração com alçadas — o motor serve inteiro

Auditoria de `governanca-alcadas.js`:

| Peça | Como funciona | Serve? |
|---|---|---|
| `regraAplicavel` | a regra de **maior limite que o valor ultrapassa** | ✅ |
| `verificarAlcada` | libera, ou cria/reaproveita aprovação pendente | ✅ |
| valor travado | aprovação de 15 não libera 40 depois (`valor_excedido`) | ✅ |
| expiração | `validadeDias` por faixa, padrão 7 | ✅ |
| reprovação | mesmo valor continua barrado; valor diferente abre novo pedido | ✅ |
| `podeDecidir` | admin **ou** o papel exato gravado na aprovação | ✅ |
| multi-tenant | tudo pelo `db` do tenant | ✅ |
| `validarRegra` | recusa papel inexistente, faixa duplicada e papel **sem nenhum usuário ativo** | ✅ |

**Nada precisou mudar no motor.** O que muda é a **unidade** de `limiteValor`
para o evento `desconto_venda`: **percentual**, não reais.

Por quê: a alçada comercial se enuncia em percentual, e um limite em reais muda
de significado conforme o tamanho do pedido — R$ 50 é 50% de um pedido de R$ 100
e 0,5% de um de R$ 10.000. `limiteValor` é REAL e `regraAplicavel` só compara
números, então a leitura percentual encaixa sem tocar em código.

**"Vendedor até 10%, gerente até 25%" se cadastra assim:**

| Faixa (`limiteValor`) | `papelAprovador` | Efeito |
|---|---|---|
| — | — | até 10% passa direto (nenhuma faixa ultrapassada) |
| **10** | `gerente-comercial` | acima de 10% exige gerente |
| **25** | `admin` | acima de 25% exige admin |

O "vendedor até 10%" é implícito e é assim que o motor foi desenhado.

> ⚠️ **Consequência que precisa da sua decisão** — ver §18, item 2: um **gerente**
> que dá 20% cai na faixa de 10%, cujo aprovador é `gerente-comercial`. Ele é
> solicitante e aprovador ao mesmo tempo, e `podeAutoAprovar` só libera
> auto-aprovação para **admin** com a chave `alcada_admin_autoaprova` ligada.
> Resultado: o desconto do gerente fica pendente até **outro** gerente ou um
> admin decidir.

---

## 9. Cálculo do total

Fórmula única, em `pedido-desconto.totalDoPedido`:

```
subtotal dos itens  −  desconto  +  frete
```

- **frete com piso zero** — invariável da Fase 0, preservada;
- **desconto limitado ao subtotal** — se um item for removido depois do desconto
  ter sido dado, o abatimento encolhe junto em vez de virar crédito;
- **o servidor recalcula sempre**; o frontend nunca é autoridade;
- **o desconto não toca `pedido_itens`** — o preço do item continua sendo o
  oficial resolvido pelo servidor (teste `D4`).

---

## 10. Cliente e cadastro rápido — **implementado, sem migration**

### O que o backend realmente exige

`pessoas` tem **3 colunas NOT NULL**: `cpfCnpj`, `tipo`, `razaoSocial`. O
`POST /api/pessoas` exige `cpfCnpj` + `razaoSocial`; `tipo` é **detectado** do
documento (PF/PJ). `erroDominioPessoa` só valida campos opcionais (tipo de
frete, homologação, avaliação, prazo) — **nenhum obstáculo ao cadastro rápido**.

E ele já é idempotente: CPF/CNPJ existente **atualiza** em vez de duplicar, e
reativa quem estava inativo. Nenhuma obrigação fiscal foi afrouxada.

### O que faltava, e foi feito

`GET /api/pessoas` buscava por `cpfCnpj`, `razaoSocial` e `nomeFantasia`.
**Não buscava por telefone** — e no balcão o cliente é achado pelo telefone
antes do nome.

Agora busca também por `telefone` e `celular`, **com e sem máscara**: quem digita
`11988887777` encontra o cadastro gravado como `(11) 98888-7777`, porque a
consulta compara também os dígitos puros. O mesmo vale para CPF/CNPJ com pontos.
A busca por nome e documento **continua idêntica** (teste `F1`).

O cliente criado é um cliente normal do ERP e aparece em
**Comercial → Clientes & Fornecedores** para ser completado depois.

---

## 11. Identificação no catálogo público — **estratégia, não implementada**

Hoje o checkout da loja exige `requirePortalAuth` → `cliente_logins`, e essa
credencial **só é criada pelo administrador** (`portal-routes.js:333`). Não há
auto-cadastro. Para o consumidor da Art's Presentes, isso é impeditivo.

**Estratégia recomendada, para sua aprovação (§18, item 6):**

1. **Nome + telefone obrigatórios** no checkout público.
2. **CPF/CNPJ opcional por padrão, obrigatório por configuração** — o lojista
   liga quando precisa de NF. Quando presente, a deduplicação é perfeita: o
   `UNIQUE(cpfCnpj)` resolve.
3. **Sem documento, NÃO fazer merge automático por telefone.** Telefone é
   reaproveitado, compartilhado em família e digitado errado. Mesclar duas
   pessoas é irreversível na prática — histórico, crédito e comissão vão junto.
   A saída segura: **telefone igual sugere**, não funde. O pedido nasce ligado a
   uma pessoa nova, e a tela do lojista mostra "existe outro cadastro com este
   telefone" para ele decidir.
4. **Problema técnico a resolver antes:** `pessoas.cpfCnpj` é **NOT NULL** e
   **UNIQUE**. Cliente sem documento precisa de um valor — e no SQLite vários
   NULL não colidem, mas a coluna não aceita NULL. O padrão que o próprio ERP já
   usa: placeholder (`resolverClienteDeParticipacao` grava `UASG-<código>`
   quando não há CNPJ). O equivalente aqui seria `SEMDOC-<telefone>` ou similar
   — **é decisão sua**, porque cria uma classe de cadastro sem documento.

**Não implementei autenticação pública nova**, conforme sua instrução.

---

## 12. Tipos de atendimento

| Modo | Cliente | Endereço | Frete | Campos usados |
|---|---|---|---|---|
| **local** | obrigatório | não | normalmente 0 | `tipoAtendimento` |
| **retirada** | obrigatório | não | 0 | + `dataEntregaPrevista` como data/hora de retirada |
| **entrega** | obrigatório | **obrigatório** | ≥ 0 | + os 10 campos `…Entrega` + `valorFrete` + `transportadoraId` |

**Uma coluna nova só** (`tipoAtendimento`). Todo o resto já existe e já é usado
pela NF-e. Os testes `G2`/`G3` confirmam que entrega e retirada funcionam com os
campos atuais.

O endereço pode vir do cadastro principal, de `pessoas_enderecos_adicionais` (que
já guarda N endereços com `padrao` e `apelido`) ou ser digitado no fluxo — os
campos do pedido são override, por desenho.

**Cliente obrigatório já é regra do backend**: `confirmarPedidoInterno` recusa
com *"Informe o cliente antes de confirmar"* (`pedidos-routes.js:948`, teste
`F3`). O PDV não precisa reinventar — precisa respeitar.

---

## 13. Estoque — regra preservada, nada alterado

| Momento | Efeito |
|---|---|
| rascunho/pendente | **não** reserva |
| `confirmar` | **reserva** (`criarReservasPedido`) |
| `entregar` | converte em saída real |

Confirmado no teste `H1`, incluindo a ausência de movimentação com quantidade
não positiva. **Nenhuma linha foi alterada** em `reservas-routes.js`.

Exceção que continua existindo e não é desta fase: a loja virtual reserva já no
rascunho (`loja-routes.js:355`).

---

## 14. Matriz de compatibilidade

| Fluxo | Origem (`tipo`) | Desconto (5 colunas) | Busca de pessoas | Veredito |
|---|---|---|---|---|
| **Pedido manual (ERP)** | nasce `manual`, como sempre | colunas nascem 0 → total idêntico | busca ampliada, nunca reduzida | ✅ |
| **Licitação** | `importar-participacao` grava `'licitacao'`, intocado | idem | — | ✅ |
| **OS** | `os-routes` grava `'os'`, intocado | idem | — | ✅ |
| **Marketplace / ML** | grava `'marketplace'`, intocado | idem | — | ✅ |
| **Loja virtual** | passa a gravar `'catalogo'`; `origemLoja` intocado e é o que as consultas dela usam | idem | — | ✅ |
| **Estoque / reservas** | não lê `tipo` | não lê desconto | — | ✅ |
| **Faturamento** | usa `tipoOperacaoId` | **⚠️ ver abaixo** | — | ⚠️ |
| **Financeiro / CR** | não lê `tipo` | lê `pedidos.valorTotal`, que continua correto | — | ✅ |
| **Devoluções** | não lê `tipo` | idem | — | ✅ |
| **Metas / comissões** | agrupam por `vendedorId` e data | calculam sobre `valorTotal` — que passa a já vir com desconto, que é o certo | — | ✅ |
| **Relatórios / BI** | nenhum agrupa por `tipo` | — | — | ✅ |
| **Fiscal (NF-e/NFC-e)** | não lê `tipo` | **⚠️ ver abaixo** | — | ⚠️ |

### ⚠️ O ponto que exige sua decisão antes de conectar o desconto

`POST /api/faturas` **já aceita `valorDesconto` no corpo** e calcula
`valorBruto + valorFrete − valorDesconto` (`faturas-routes.js:176-179`). Hoje
esse número é **digitado na hora de faturar** e não tem relação com o pedido.

Com desconto no pedido, surgem duas possibilidades:

- **herdar**: se o corpo não informar `valorDesconto`, a fatura usa o do pedido.
  É uma linha, mantém compatibilidade (quem informa continua mandando) e evita
  que o desconto suma no faturamento;
- **não herdar**: o desconto do pedido é comercial e o da fatura é fiscal, e
  cada um se digita onde é.

**Não implementei nenhuma das duas** — é decisão sua (§18, item 5).

E um limite que **já existe hoje, e não foi criado por esta fase**:
`fatura_itens.valorDesconto` existe no schema mas **nunca é preenchido** —
nenhum rateio por item acontece, nem para o desconto digitado ao faturar. Para
NF-e com `vDesc` por item, isso precisará ser resolvido algum dia. Não é desta
fase e não foi agravado por ela.

---

## 15. Código preparado

| Arquivo | Estado | Ligado? |
|---|---|---|
| `pedido-politicas.js` | `ORIGENS_CLIENTE` + `'pdv'`; `ORIGENS_PEDIDO` novo | **sim, em vigor no disco** |
| `loja-routes.js` | pedido da loja nasce `tipo='catalogo'` | **sim** |
| `financeiro-routes.js` | `GET /api/pessoas` busca por telefone/celular, com e sem máscara | **sim** |
| **`pedido-desconto.js`** | **novo** — desconto, alçada e total | **NÃO** — nenhuma rota o importa |
| **`scripts/migrate-fase1-pedido.js`** | **novo** — migration | **NÃO executada em produção** |
| **`scripts/test-fase1-desconto-origem.js`** | **novo** — 39 testes | — |

**As três mudanças em vigor não dependem de coluna nenhuma** e foram escolhidas
justamente por isso. Nenhuma delas está carregada no processo: o
`consulta-licitacoes.service` roda desde 18:21 e os três arquivos foram alterados
depois — **só valem no próximo restart**, que não foi feito.

---

## 16. Testes

`scripts/test-fase1-desconto-origem.js` — **39 testes, 39 OK, 0 falhas.**

A migration é aplicada **no banco descartável pelo próprio script que um dia
rodará em produção** — o que se testa é a migration de verdade, não uma cópia.

| Bloco | Cobertura |
|---|---|
| **A. Migration** (3) | cria as 5 colunas sem remover nenhuma; idempotente; **pedido antigo mantém o total de antes** |
| **B. Origem** (6) | ERP→`manual`; PDV→`pdv`; `app` preservado; **origem interna forjada é recusada** (`licitacao`, `os`, `marketplace`, `catalogo`); valor desconhecido cai em `manual`; vocabulário cobre tudo |
| **C. Desconto** (8) | percentual; valor; zero/ausente; **maior que o subtotal**; **negativo**; **>100%**; tipo inválido/`NaN`/`Infinity`; subtotal zero |
| **D. Total** (4) | `itens − desconto + frete`; **frete negativo não reduz**; **total nunca negativo**; **desconto não altera o preço dos itens** |
| **E. Alçada** (8) | faixas cadastráveis; dentro da alçada passa **sem criar aprovação**; acima abre pendente com o papel certo; **faixa de maior limite**; aprovada libera e é consumida; **valor travado** (`valor_excedido`); zero não aciona; **sem faixas, nada é barrado** |
| **F. Cliente** (3) | busca por telefone com/sem máscara **sem quebrar nome e documento**; cadastro rápido com CPF+nome; **cliente obrigatório para confirmar** |
| **G. Atendimento** (3) | três modos + NULL; entrega com endereço e frete; retirada sem endereço |
| **H. Regressão** (4) | estoque reserva/baixa; **frete e quantidade negativos ainda 422**; **preço do restrito ainda resolvido pelo servidor**; `registrar-pagamento` ainda 410 |

### Regressão das suítes existentes

`npm run verify` → **OK**.

| Suíte | Resultado |
|---|---|
| `test-app-backend` | **79 OK, 0 falhas** |
| `test-fase0-pagamento-pedido` | 15 OK, 0 falhas |
| `test-reservas-pedido` · `test-venda-perdida-pedido` · `test-metas-bi` | 11 · 16 · 21, 0 falhas |
| `test-deposito-movimentacao` · `test-devolucao-venda-espelho` | 14 · 17, 0 falhas |
| `test-devolucoes-credito-metas-comissao` · `test-devolucoes-custo-saldo-estorno` | 22 · 22, 0 falhas |
| `test-os-equipamento` | 5 OK, **14 falhas pré-existentes** |
| `test-os-notificacoes` | 7 OK, **6 falhas pré-existentes** |
| `test-ml-anuncios` | 29 OK, **1 falha pré-existente** |
| `test-comissoes` · `test-boletos-pagar` · `test-cartao-recebiveis` · `test-pedido-compra` | falhas pré-existentes já documentadas |

**As falhas de OS e ML não são minhas, e há prova objetiva**: as suítes não
criam OS com `tipoOsId`, que passou a ser obrigatório em `os-routes.js:1713`
(frente do commit `332da50`, *"tipo de OS vira motor de comportamento"*). E
nenhuma das três toca origem, desconto, `/api/pessoas`, loja ou pedidos —
verificado por grep. A do ML é um mock HTTP 400.

Elas só apareceram agora porque **nunca tinham rodado**: faltavam os dumps
`/tmp/vp-equip-schema.sql` e `/tmp/vp-mlanuncio-schema.sql`, que gerei (leitura
do banco) para poder executá-las. **Não corrigi nenhuma** — está fora do escopo.

---

## 17. Riscos

| Risco | Gravidade | Situação |
|---|---|---|
| Desconto some ao faturar, se não for herdado | **média** | §14 — decisão pendente |
| `fatura_itens.valorDesconto` sem rateio | média | **já existe hoje**, não agravado |
| Gerente não aprova o próprio desconto | média | §8 — decisão pendente |
| Alçada em percentual num campo chamado `limiteValor` | baixa–média | a tela de governança pode mostrar "R$"; precisa de rótulo por evento |
| `cpfCnpj` NOT NULL bloqueia cliente sem documento | **média** | §11 — decisão pendente antes do catálogo público |
| Merge de pessoas por telefone | **alta se feito errado** | por isso a recomendação é **sugerir, não fundir** |
| Badge do frontend sem CSS para `pdv`/`catalogo` | baixa | aparece como texto sem estilo |
| As 3 mudanças em vigor no disco não estão no processo | informativo | só valem no próximo restart |
| Suítes de OS desatualizadas | baixa | pré-existente, documentado |

---

## 18. Decisões que precisam da sua aprovação

**1. Aplicar a migration?** 5 colunas em `pedidos`, 13 tenants. Aditiva, sem
reescrever dado, sem mudar total de pedido existente. Recomendo aplicar
**primeiro em um tenant** (`1bit` ou um suspenso, como `levezi`), conferir, e só
então nos demais.

**2. Alçada: o gerente precisa de outro aprovador para o próprio desconto?**
Com o motor atual, sim — cai na faixa que ele mesmo aprova, e auto-aprovação só
existe para admin com chave ligada. Opções: (a) aceitar (outro gerente ou admin
aprova); (b) ligar `alcada_admin_autoaprova` e concentrar aprovação no admin;
(c) estender o motor para considerar o papel do **solicitante** — mudança maior,
que eu não faria sem necessidade.

**3. Unidade da alçada: percentual, como implementei?** A alternativa é valor em
reais. Recomendo percentual — foi como você enunciou e não depende do tamanho do
pedido.

**4. Conectar `pedido-desconto.js` às rotas?** Depende da migration (1). Envolve
`recalcularTotal`, `PUT /api/pedidos/:id` e uma rota nova
`POST /api/pedidos/:id/desconto`.

**5. A fatura herda o desconto do pedido?** Recomendo **sim**, só quando o corpo
não informar `valorDesconto` — preserva quem já manda e evita o desconto sumir.

**6. Catálogo público: CPF/CNPJ obrigatório no checkout?** E, se opcional, qual
placeholder para `cpfCnpj` NOT NULL? Sem essa definição o checkout sem login não
sai do papel.

**7. `tipoAtendimento` obrigatório para pedido novo?** Recomendo: obrigatório no
PDV e no catálogo, opcional no ERP (compatível com os 64 pedidos existentes, que
ficam NULL).

**8. Os percentuais das faixas.** Você disse para não fixar 5%/15% — então não
semeei nenhuma faixa. Sem faixas cadastradas, **nenhum desconto é barrado**
(teste `E8`). Precisa dos números para a alçada existir de fato.

---

## 19. Confirmação

- **Migration NÃO aplicada em produção** — só dry-run (13 tenants) e execução em
  `/tmp`.
- **Nenhum serviço reiniciado**; `liciteagora.service` e o scheduler intocados.
- **Banco de produção não alterado** — só `SELECT`/`PRAGMA`. Os dois dumps que
  gerei em `/tmp` são leitura de schema.
- **Nenhum commit**, nenhum `reset`/`stash`/`clean`, nenhum backfill, nada no
  Asaas.
- **Nenhum frontend criado**, nenhum React Native, PDV/NFC-e fiscal intocado.
- Arquivos de aplicação alterados: **3** (`pedido-politicas.js`,
  `loja-routes.js`, `financeiro-routes.js`) — todos sem dependência de coluna
  nova. Criados: `pedido-desconto.js` (inerte), a migration e a suíte.
