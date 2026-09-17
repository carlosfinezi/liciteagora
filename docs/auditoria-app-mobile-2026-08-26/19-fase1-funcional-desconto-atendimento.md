# 19 — Fase 1 funcional: desconto com alçada, aprovação e tipo de atendimento

**Data:** 2026-09-11
**Referências:** [13 — decisões](13-fase-1-decisoes-modelo-comercial.md) ·
[14 — sandbox](14-sandbox-validacao-fase1.md) · [18 — rollout](18-rollout-fase1-demais-tenants.md)

**Estado:** código pronto e testado, **não em vigor** — os processos em memória
ainda rodam o código anterior. Nenhum serviço foi reiniciado.

**Não feito, por instrução:** frontend · backfill · faixas para clientes ·
restart · commit · Asaas · correção do `[DIGEST]` · alteração de dado comercial
de cliente.

---

## 1. Rotas auditadas

Todos os caminhos que criam, alteram ou precificam pedido:

| Rota | Papel | Recebe desconto? | Recebe `tipoAtendimento`? |
|---|---|---|---|
| `POST /api/pedidos` | cria | **sim** (após os itens) | **sim** |
| `PUT /api/pedidos/:id` | atualiza | **sim** (porta principal) | **sim** |
| `POST /api/pedidos/:id/itens` | inclui item | não — recalcula | não |
| `PUT /api/pedidos/:id/itens/:itemId` | altera item | não — recalcula | não |
| `DELETE /api/pedidos/:id/itens/:itemId` | remove item | não — recalcula | não |
| `POST /api/pedidos/:id/confirmar` | vira venda | **valida** | **valida** |
| `POST /api/pedidos/acao-massa` | confirma em lote | **valida** | **valida** |
| `PUT /api/pedidos/:id` (`valorFrete`) | frete | recalcula | — |
| `POST /api/faturas` | fatura | **herda do pedido** | — |
| `POST /api/pedidos/importar-participacao/:id` | licitação | não | não |
| `loja-routes.js` (INSERT próprio) | catálogo | não (ainda) | grava direto |
| `os-routes.js`, `marketplaces-*.js` | INSERT próprio | não | não |

**Centralização.** O desconto tem **um único ponto de escrita** —
`pedido-desconto.aplicarDescontoNoPedido`. POST e PUT chamam a mesma função; não
há uma regra na criação e outra na edição. As colunas de desconto **não estão em
`CAMPOS_PEDIDO`** (a whitelist do PUT) de propósito: um segundo caminho de
gravação seria, por definição, um desconto sem alçada. Isso é testado (H8).

A fórmula do total também ficou num lugar só: `recalcularTotal` passou a delegar
a `pedido-desconto.totalDoPedido`.

## 2. Conexão de `pedido-desconto.js`

O módulo existia desde 2026-09-10 e não era requerido por nenhuma rota de pedido.
Agora é requerido por `pedidos-routes.js` (POST, PUT, confirmação) — e já era por
`faturas-routes.js`.

**Preço e desconto continuam separados**, que é a razão de o módulo existir: a
política de 2026-09-10 fechou o `precoUnitario` para o vendedor restrito e o
deixou sem como conceder abatimento nenhum. O preço segue vindo do servidor
(`precoDeItem`), e o desconto aparece à parte, auditável e sujeito a alçada.
Provado em H2: vendedor restrito mandando `precoUnitario: 1` num produto de
R$ 100 grava R$ 100.

## 3. Semântica das alçadas

Uma faixa `(limiteValor = 5, papelAprovador = 'gerente-comercial')` lê-se:
**acima de 5% exige a autoridade do papel `gerente-comercial`**.

Três respostas, nesta ordem:

1. **abaixo da menor faixa** → aplica direto (`alcada_base`);
2. **acima de uma faixa cuja autoridade o solicitante JÁ TEM** → aplica direto
   (`propria`). Um gerente que dá 15% cai na faixa de 5%, cuja autoridade é a
   dele — **não faz sentido pedir que outro gerente aprove o que ele mesmo
   aprovaria**. É o caso D2, e era exatamente o pedido do usuário;
3. **acima de uma faixa cuja autoridade ele não tem** → solicitação de aprovação.

`admin` satisfaz qualquer papel, como `podeDecidir` já fazia do outro lado do
balcão.

**Bloqueador removido:** `governanca-alcadas.TIPOS_EVENTO` continha apenas
`['pagamento_cp', 'pedido_compra']`, e `validarRegra` recusa qualquer tipo fora
da lista com `tipo_invalido`. **Era impossível cadastrar uma faixa de
`desconto_venda` pela tela de governança.** `desconto_venda` foi acrescentado à
lista — e com ele o evento passa a aparecer também no diagnóstico e no simulador,
que iteram a mesma constante.

**A unidade é percentual, e isso agora está declarado** em
`EVENTOS_PERCENTUAIS`. O motor não precisou mudar (`regraAplicavel` só compara
números), mas quem exibe uma faixa de `desconto_venda` precisa escrever "%" e não
"R$". Sem essa declaração, a tela de governança mostraria "acima de R$ 5,00".

## 4. Fail-closed

Sem nenhuma faixa cadastrada, o desconto permitido é **0%** para quem não é ator
privilegiado. Ausência de configuração **não** é ausência de limite.

| Caso | Resultado | Teste |
|---|---|---|
| vendedor, 0%, sem faixas | **OK** — e o pedido confirma | E1 |
| vendedor, 0,01%, sem faixas | **422** — "o limite é 0%" | E2 |
| gerente com perfil cadastrado, 5%, sem faixas | **422** | E3 |
| admin, 20%, sem faixas | OK (`privilegiado`) | E4 |

E1 merece destaque: o que se bloqueia é o **desconto**, não a venda. O pedido
continua saindo pelo preço oficial. Um tenant que ainda não configurou governança
vende normalmente — só não dá desconto.

**Risco registrado, não corrigido (por decisão do usuário):** um usuário cujo
`role` **não tem perfil cadastrado** no tenant passa como privilegiado e fura o
fail-closed. Não é regra comercial válida — é o fail-open de
`perfis-acesso.js:99-107`, reproduzido em `atorIrrestrito` para não divergir dele.
O teste **E5 fixa esse comportamento por escrito**: se ele mudar, o teste quebra e
a mudança será consciente em vez de surpresa. `atorIrrestrito` **não** foi
endurecido globalmente nesta fase, como combinado.

## 5. Cálculo do desconto

Fórmula única, em `pedido-desconto.totalDoPedido`:

```
subtotal dos itens − desconto + frete = total
```

| Invariável | Como é garantida |
|---|---|
| frete ≥ 0 | recusa na entrada (`erroValorFrete`) + piso zero na fórmula |
| desconto ≥ 0 | recusa (`calcularDesconto`) |
| desconto ≤ subtotal | recusa em reais; limitado na fórmula |
| total nunca negativo | `Math.min(desconto, subtotal)` |
| backend é a autoridade | `valorTotal` do corpo é ignorado (H7) |

**Reprecificação do percentual.** Um desconto percentual acompanha o subtotal
quando itens entram ou saem. Sem isso, "10% de R$ 1.000 = R$ 100" continuaria
valendo R$ 100 depois de o pedido encolher para R$ 200 — **metade do pedido, sem
passar por alçada nenhuma**. O percentual é o que foi autorizado; é ele que se
preserva (B5). Desconto em reais não é reprecificado: ali o combinado era o número.

## 6. Percentual × valor

**A fonte canônica é o percentual.** Quem informa percentual não precisa saber o
subtotal, e a alçada — que é percentual — fica sem conversão no meio.

| Corpo | Resultado |
|---|---|
| `descontoPercentual: 10` | `tipo='percentual'`, `valor=10`, `aplicado = 10% do subtotal` |
| `descontoValor: 50` | `tipo='valor'`, `aplicado=50`, percentual derivado para a alçada |
| `descontoTipo:'percentual'` + `descontoValor: 10` | aceito — é o formato que o schema grava |
| `descontoPercentual: 10` + `descontoValor: 70` sobre R$ 500 | **422 — inconsistente** |
| `descontoPercentual: 10` + `descontoValor: 50` sobre R$ 500 | aceito (consistentes) |

**A decisão de RECUSAR a contradição, e não conciliá-la**, é o ponto desta seção.
Qualquer regra de desempate ("o percentual vence") gravaria um número que ninguém
pediu, e o operador só descobriria na fatura. Recusar devolve a decisão a quem
sabe qual dos dois era o combinado. A tolerância de um centavo evita brigar com
arredondamento de tela (B3, B4).

## 7. Motivo

| Situação | `descontoMotivo` |
|---|---|
| desconto 0% | irrelevante |
| dentro da própria autoridade | **opcional** (F1) |
| acima da autoridade (vai para aprovação) | **obrigatório**, mínimo 3 caracteres (F2, F3) |

Confirmado antes de implementar, como pedido: **o motor de governança não tinha
regra equivalente.** `aprovacoes.motivo` existe, mas é preenchido por quem
DECIDE — a justificativa da reprovação. Nenhum caminho exigia justificativa para
abrir a solicitação. Logo, é regra nova, e vive em `pedido-desconto.js` e não no
motor: impô-la a `pagamento_cp` mudaria um fluxo que ninguém pediu para mudar.

**Um defeito que o teste encontrou e que vale registrar.** Na primeira versão, a
solicitação de aprovação nascia *antes* da checagem de motivo: uma tentativa sem
justificativa era recusada, mas **já tinha aberto a solicitação** — e o aprovador
receberia exatamente o pedido sem motivo que a regra queria impedir. A correção
foi uma pré-verificação em **modo simulação** (`simular: true`), que responde
"precisaria de aprovação" sem gravar nada; a solicitação só nasce depois de o
motivo passar. F2 verifica que nenhuma linha sobra em `aprovacoes`.

## 8. Aprovação

**O motor existente foi reutilizado.** Não há segundo sistema de aprovações:
`alcadas.verificarAlcada` é quem cria, valida teto, valida expiração e consome.

O que fica registrado, tudo em `aprovacoes`:

| Dado | Coluna |
|---|---|
| solicitante | `solicitante` |
| aprovador | `aprovador` |
| percentual | `valorReferencia` (e `valorAprovado` como teto) |
| motivo | `pedidos.descontoMotivo` (+ `aprovacoes.motivo` na decisão) |
| data/hora | `dataCriacao`, `dataDecisao`, `expiraEm` |
| papel exigido | `papelExigido`, gravado na própria linha |

**Estado do pedido: rascunho, com a confirmação bloqueada (409).** Nenhum status
novo foi criado. Inventar `aguardando_aprovacao` em `STATUS_VALIDOS` obrigaria a
revisar toda tela, filtro, relatório e transição que hoje lê os seis status — um
custo alto para expressar o que "rascunho + motivo do bloqueio" já expressa: o
pedido ainda não é venda. O desconto **é gravado** mesmo pendente, para o
aprovador ter o que olhar; o que ele não faz é virar venda (C5).

**O fluxo NÃO retoma sozinho.** Depois de aprovado, alguém precisa confirmar o
pedido de novo — e é essa segunda confirmação que consome a aprovação. É o mesmo
comportamento que o motor já tinha em `pagamento_cp`, mantido por coerência.

**Um segundo defeito que o desenho tinha e foi corrigido:** a confirmação
bloqueava mas não **consumia** a aprovação — ela ficaria aberta, reutilizável em
quantas confirmações quisessem. Agora `bloqueioDeConfirmacao` passa pelo mesmo
`verificarAlcadaDesconto`, que consome. C6 verifica `consumida = 1`; C8 verifica
que uma aprovação de 8% **não** cobre 20% quando o desconto sobe depois.

## 9. `tipoAtendimento`

Vocabulário: `no_local`, `retirada`, `entrega`. Módulo próprio,
`pedido-atendimento.js`.

| Origem (`pedidos.tipo`) | `tipoAtendimento` |
|---|---|
| `pdv` | **obrigatório** |
| `catalogo` | **obrigatório** |
| `manual`, `os`, `licitacao`, `marketplace`, `app` | **pode continuar NULL** |

**NULL significa alguma coisa** — "pedido anterior a esta fase, que não declarava
atendimento" — e é o estado dos 67 pedidos históricos. Não é lacuna a preencher;
por isso a obrigatoriedade nunca retroage (G9).

**Onde cada regra é cobrada:** o vocabulário, em toda escrita (valor inválido →
422 no POST e no PUT, G10); a obrigatoriedade, **na confirmação**. Rascunho é
rascunho: o PDV monta o pedido item a item e só no fim escolhe o atendimento.
Exigir na criação impediria o rascunho de existir.

## 10. Validações por atendimento

| Atendimento | Cliente | Endereço | Frete |
|---|---|---|---|
| `no_local` | obrigatório (já era) | não exigido | livre |
| `retirada` | obrigatório (já era) | não exigido | livre |
| `entrega` | obrigatório (já era) | **obrigatório** | ≥ 0 (Fase 0) |

**Os campos de endereço já existiam e foram reutilizados** — nenhum criado:
`enderecoEntrega`, `numeroEntrega`, `complementoEntrega`, `bairroEntrega`,
`cidadeEntrega`, `ufEntrega`, `cepEntrega`, `codigoMunicipioEntrega`,
`contatoEntrega`, `telefoneEntrega`, já em `CAMPOS_PEDIDO` como "override do
cadastro do cliente".

**O cadastro do cliente conta como endereço válido.** Exigir o override no pedido
recusaria o caso mais comum e legítimo do ERP — cliente com endereço cadastrado,
entrega no endereço dele. O que se exige é que exista endereço, não que tenha
sido redigitado (G3, G6).

**O frete NÃO foi amarrado ao atendimento.** A tentação era impor frete zero em
`no_local`; isso inventaria uma regra que ninguém pediu e quebraria casos
legítimos (taxa de serviço lançada como frete). O frete já tem a sua invariável,
que é não ser negativo (G11).

**Retirada com data/hora** não foi implementada — só o campo `dataEntregaPrevista`
existente já serve, e criar coluna para um frontend que não existe seria
especulação.

## 11. Origem do pedido

`pedidos.tipo` continua sendo a origem operacional. **Nenhuma coluna `origem`
redundante foi criada.**

`ORIGENS_CLIENTE = ['manual', 'app', 'pdv']` é o que um cliente HTTP pode
declarar. `catalogo`, `os`, `licitacao` e `marketplace` são gravadas pelos
caminhos internos que as produzem — aceitá-las do corpo deixaria forjar
procedência. Tentativa de forjar cai em `manual`, sem erro (H9).

## 12. Faturamento

A regra de 2026-09-10 foi **preservada, não reescrita**:

- `valorDesconto` **omitido** → herda o desconto do pedido;
- `valorDesconto` **presente** (inclusive `0`) → substitui;
- **nunca soma** — a distinção é por presença do campo, não por valor.

Somar seria o pior dos mundos: quem digita o mesmo desconto de novo (o hábito de
hoje) veria o abatimento dobrar em silêncio. Agora que o desconto do pedido
existe de verdade, `descontoDoPedido` passa a devolver número diferente de zero, e
é isso que I1 verifica (R$ 50 de um pedido de R$ 500 com 10%).

## 13. Testes no sandbox

Faixas do sandbox (já cadastradas no relatório 14, **não recriadas**):
`5% → gerente-comercial` · `15% → admin`.

Executado com `scripts/sandbox-fase1-matriz.js` sobre o **banco real do
sandbox**, com os perfis e o cadastro que estão lá. Pedido de 5 × R$ 100 =
subtotal R$ 500, frete R$ 20.

| Ator | % | Subtotal | Desconto | Frete | Total | Alçada | Aprovação? | Status |
|---|--:|--:|--:|--:|--:|---|---|---|
| VENDEDOR | 0% | 500,00 | 0,00 | 20,00 | **520,00** | alcada_base | não | confirmado |
| VENDEDOR | 3% | 500,00 | 15,00 | 20,00 | **505,00** | alcada_base | não | confirmado |
| VENDEDOR | 5% | 500,00 | 25,00 | 20,00 | **495,00** | alcada_base | não | confirmado |
| VENDEDOR | 6% | 500,00 | 30,00 | 20,00 | 490,00 | sem autoridade | **SIM (gerente-comercial)** | **409 — rascunho** |
| GERENTE | 5% | 500,00 | 25,00 | 20,00 | **495,00** | alcada_base | não | confirmado |
| GERENTE | 15% | 500,00 | 75,00 | 20,00 | **445,00** | **propria** | não | confirmado |
| GERENTE | 16% | 500,00 | 80,00 | 20,00 | 440,00 | sem autoridade | **SIM (admin)** | **409 — rascunho** |
| ADMIN | 30% | 500,00 | 150,00 | 20,00 | **370,00** | propria | não | confirmado |

A linha do GERENTE a 15% é a que prova o item 3 do pedido: autoridade `propria`,
sem aprovação de outro gerente.

## 14. Testes de atendimento

Mesma execução, no sandbox:

| Origem | Atendimento | Endereço | Resultado |
|---|---|---|---|
| pdv | no_local | — | **OK — confirmado** |
| pdv | retirada | — | **OK — confirmado** |
| pdv | entrega | no pedido | **OK — confirmado** |
| pdv | *(nulo)* | — | **422** — "origem pdv exige tipoAtendimento" |
| pdv | entrega | nenhum | **422** — "entrega exige endereço" |
| catalogo | retirada | — | **OK — confirmado** |
| catalogo | entrega | no pedido | **OK — confirmado** |
| catalogo | *(nulo)* | — | **422** |
| catalogo | entrega | nenhum | **422** |
| manual | *(nulo)* | — | **OK — confirmado** |

> Nota de honestidade: nenhum cliente do sandbox tem endereço cadastrado. A
> primeira execução rotulou o endereço como "do cliente" e a confirmação foi
> recusada — a recusa estava certa, o rótulo é que mentia. Os casos "com
> endereço" passaram a usar o override `enderecoEntrega` do pedido, que é o outro
> caminho aceito e o que se queria exercitar de qualquer modo.

**A massa ficou no sandbox**, 18 pedidos marcados `FASE1-MATRIZ` em
`observacoesInterna`. Para remover:
`node scripts/sandbox-fase1-matriz.js --limpar`.

## 15. Testes de segurança

`scripts/test-fase1-funcional.js`, bloco H — **todos passam**:

| Tentativa | Resultado |
|---|---|
| vendedor envia `vendedorId` de outro | ignorado, fica com o próprio |
| vendedor restrito envia `precoUnitario: 1` (produto R$ 100) | preço oficial R$ 100 gravado |
| desconto acima da autoridade | solicitação de aprovação, venda bloqueada |
| desconto negativo | **422** |
| desconto acima de 100% | **422** |
| desconto em reais > subtotal | **422** |
| frete negativo | **422** |
| `valorTotal` manipulado no corpo | **ignorado** — recalculado |
| `descontoAplicado` direto no corpo | **ignorado** — não está em `CAMPOS_PEDIDO` |
| `tipoAtendimento` inválido | **422** no POST e no PUT |
| origem `catalogo`/`licitacao`/`os`/`marketplace` forjada | vira `manual` |
| quantidade negativa | **recusada** (Fase 0 intacta) |

## 16. Regressão

| Suíte | Resultado |
|---|---|
| `npm run verify` | **OK** |
| **`test-fase1-funcional`** (nova) | **57 ok, 0 falha** |
| `test-app-backend` | **79 ok, 0 falha** |
| `test-alcadas` | **41 ok, 0 falha** |
| `test-fase1-desconto-origem` | 57 ok, 0 falha |
| `test-fase1-rollout-parcial` | **10 ok, 0 falha** |
| `test-fase0-pagamento-pedido` | 15 ok, 0 falha |
| `test-rollout-fase1` | 17 ok, 0 falha |
| `test-documento-fiscal` | 16 ok, 0 falha |
| `test-reservas-pedido` | 11 ok, 0 falha |
| `test-venda-perdida-pedido` | 16 ok, 0 falha |
| `test-metas-bi` | 21 ok, 0 falha |
| `test-deposito-movimentacao` | 14 ok, 0 falha |
| `test-devolucoes-credito-metas-comissao` | 22 ok, 0 falha |
| `test-devolucoes-custo-saldo-estorno` | 22 ok, 0 falha |
| `test-devolucao-venda-espelho` | 17 ok, 0 falha |
| `test-analises-estoque` | 17 ok, 0 falha |

**Zero falhas novas.** Três suítes estão quebradas **de antes** desta etapa:

- `test-comissoes` e `test-pedido-compra` — `no such table: fornecedores`. A
  tabela foi extinta em 2026-08-20 (fornecedor virou `pessoas` com categoria);
  os testes não acompanharam. Nada nesta fase toca fornecedor.
- `test-aprovacoes-fluxo` — 15 passaram, 4 falharam, sobre montagem de mensagem
  de notificação. **Provado não ser regressão minha**: removi
  `desconto_venda` de `TIPOS_EVENTO`, rodei, restaurei e rodei de novo —
  **15/4 nos dois casos**. O arquivo foi conferido byte a byte após restaurar.

### Um teste que estava passando por acidente

`test-fase1-rollout-parcial` monta um "tenant sem a migration" a partir do schema
de referência — e passava porque o schema de referência ainda não tinha as
colunas. Depois do rollout do relatório 18, **os 19 tenants as têm**, e o teste
passou a montar um banco já migrado: media o oposto do que dizia medir.

Agora ele **constrói** o schema antigo, removendo as 6 colunas do texto do
`CREATE TABLE`. E aí encontrou um defeito real: meu `INSERT INTO pedidos (...
tipoAtendimento)` estourava **500 — "no such column"** num banco sem a coluna,
derrubando a criação de qualquer pedido por causa de um campo opcional. Corrigido:
o campo saiu do INSERT e é gravado à parte, só quando a coluna existe
(`atendimento.temColuna`). O PUT ignora o campo pelo mesmo motivo.

## 17. Compatibilidade com os tenants

Conferido tenant a tenant depois de tudo:

| Tenant | Pedidos | Com desconto/atendimento | Aprovações | Faixas |
|---|--:|--:|--:|--:|
| `1bit` | 29 | **0** | 0 | **0** |
| `produtosbomgosto` | 21 | **0** | 0 | **0** |
| `josecarloscostafilho` | 11 | **0** | 0 | **0** |
| `raeldouglas` | 2 | **0** | 0 | **0** |
| `jaagricola` | 1 | **0** | 0 | **0** |
| demais 7 clientes | 0 | 0 | 0 | **0** |
| `sandbox` (interno) | — | massa de teste | massa de teste | 2 |

- pedidos antigos continuam normais — nenhum foi recalculado;
- pedido manual sem desconto continua normal;
- **nenhum tenant de cliente ganhou faixa** — só o sandbox tem, e de antes;
- nenhuma venda histórica recalculada, nenhuma aprovação retroativa.

**Por que um tenant sem faixa não fica travado:** sem faixas, o desconto
permitido é 0%, e um pedido sem desconto não passa por alçada nenhuma. O ERP
segue vendendo como hoje. Quem quiser desconto cadastra as faixas na tela de
governança — que só agora aceita o evento (§3).

## 18. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `pedido-desconto.js` | **ligado**; ganhou `aplicarDescontoNoPedido` (ponto único de escrita), `reprecificarDesconto`, `bloqueioDeConfirmacao`, `lerDescontoDoCorpo`, `erroMotivo`, modo `simular` |
| `pedido-atendimento.js` | **novo** — vocabulário, obrigatoriedade por origem, endereço, `temColuna` |
| `pedidos-routes.js` | `recalcularTotal` com desconto; desconto no POST e no PUT; `tipoAtendimento` em `CAMPOS_PEDIDO`; validações na confirmação e na ação em massa |
| `governanca-alcadas.js` | `desconto_venda` em `TIPOS_EVENTO`; `EVENTOS_PERCENTUAIS` |
| `db-schema.js` | as 6 colunas da Fase 1 no schema base — **tenant novo nasce com elas** |
| `scripts/test-fase1-funcional.js` | **novo** — 57 testes |
| `scripts/sandbox-fase1-matriz.js` | **novo** — matriz no sandbox, com `--limpar` |
| `scripts/test-fase1-rollout-parcial.js` | passou a construir o schema antigo |

`db-schema.js` merece nota: a migration da Fase 1 é script avulso e **não alcança
tenant novo**. Sem essa entrada, o primeiro pedido de um tenant recém-provisionado
estouraria com "no such column". É exatamente a história do `depositoId`, que já
tinha passado por isso (relatório 15).

## 19. Restart

**É necessário, e não foi feito.** `pedidos-routes.js`, `pedido-desconto.js`,
`pedido-atendimento.js`, `governanca-alcadas.js` e `db-schema.js` são carregados
pelo `server.js`; o processo em memória roda o código anterior. **Nada nesta etapa
está em vigor.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | active, PID **3310892**, desde 08:21:57 | **idêntico** |
| `liciteagora.service` | active, PID **3085849**, desde 06:18:49 | **idêntico** |

Quando for reiniciar: **só o worker** (`consulta-licitacoes.service`). Reiniciar
`liciteagora.service` liga o `cicloAvisoAlcadas` e o watchdog do catálogo, que
estão pendentes desde 2026-08-11 (CLAUDE.md, "Pendências conhecidas") — é assunto
separado e não deve pegar carona nesta janela.

## 20. Próximo passo recomendado

1. **Restart de `consulta-licitacoes.service`**, e só dele. Depois, o smoke test
   de leitura do relatório 17 §13 mais um pedido de ponta a ponta num tenant
   interno.
2. **Cadastrar as faixas por tenant**, na tela de governança, com os percentuais
   que cada proprietária definir. Nenhum número foi semeado, de propósito: um
   percentual inventado por script vira regra de verdade. **Verificar antes se a
   tela de governança escreve "%" e não "R$" para `desconto_venda`** — o backend
   já declara a unidade em `EVENTOS_PERCENTUAIS`, mas o frontend não foi tocado
   nesta etapa e provavelmente ainda mostra o rótulo monetário.
3. **Fila de aprovação de desconto na tela** — hoje a solicitação nasce e fica
   visível só para quem consultar `aprovacoes`. O vendedor recebe 409 com o
   motivo, mas o aprovador não é avisado. O padrão de notificação por evento já
   existe em `os-notificacoes.js` e é o caminho a generalizar.
4. **Só então o frontend** — Pedidos PDV e Catálogo Online.

**Riscos que ficam abertos:**

- **fail-open de perfil sem cadastro** (§4, teste E5) — não endurecido por
  decisão; o risco é um `role` novo sem perfil virar privilegiado silencioso;
- **loja-routes ainda não aplica desconto** — o catálogo grava pedido por INSERT
  próprio e não passa pela porta única. Quando o Catálogo Online for implementado,
  é ali que a alçada precisa entrar, e não num segundo caminho de desconto;
- **NFC-e e NFS-e ainda leem documento do corpo** (relatório 15);
- **webhook Asaas de `josecarloscostafilho`** (relatório 11);
- **4 pedidos de R$ 10.036,00** aguardando decisão de backfill (relatório 07);
- **`[DIGEST] no such table: licitacoes`** (relatório 18 §16), não corrigido.
