# Módulo Produção — plano de implementação

Data: 2026-08-28. Molde: a vertical **locação** (`locacao/`), que por sua vez
seguiu ótica/restaurante/farmácia/posto.

Prefixo de tabela: `prod_`. Prefixo de config: `producao_`. Flag:
`producao_enabled`, nasce **desligada em todos os tenants**.

> **Histórico que explica o desenho.** O módulo nasceu em 27/08/2026 como
> vertical de pré-moldados de concreto, a pedido de um prospect. Em 28/08 foi
> generalizado para servir qualquer manufatura discreta, e o que era específico
> de concreto virou um PERFIL DE INDÚSTRIA. As decisões abaixo continuam
> descritas pelo caso que as originou — é o caso concreto que explica por que
> cada trava existe —, mas nenhuma delas é específica de concreto no código.

---

## O negócio, em uma frase

Manufatura discreta por ordem, onde **o recurso que satura não é a máquina, é o
que fica preso durante o processo** (forma, molde, forno, linha), o produto
acabado custa caro parado, e há processo em que a unidade só pode sair do
recurso quando uma medição prova que ela aguenta.

No perfil de pré-moldados isso se lê: a forma prende, a peça pesa no pátio, e a
cordoalha só é cortada quando o corpo de prova atinge o fck de transferência.

---

## O núcleo é genérico; o segmento é um perfil

O código não sabe o que é concreto. Sabe **ficha, ordem, recurso, etapa,
ensaio, apontamento, unidade, projeto**. O que muda de fábrica para fábrica:

| | De onde vem |
|---|---|
| Etapas de produção | cadastro `prod_etapas`, semeado pelo perfil |
| Tipos de ensaio | cadastro `prod_ensaio_tipos`, semeado pelo perfil |
| Unidade do indicador | `prod_fichas.unidadeBase` — m³, kg, m², milheiro |
| Vocabulário das telas | `producao/perfis.js`, servido em `/api/producao/vocabulario` |

Dois perfis hoje: `generico` (preparação → processo → acabamento → inspeção →
expedição) e `premoldados` (armação → forma → concretagem → desforma →
acabamento → carga, com os três ensaios de fck).

**Trocar de perfil não apaga nada.** Acrescenta o que falta e desativa as
etapas do perfil anterior que ninguém usou. Etapa com apontamento gravado fica
— só perde o `contaProducao`, porque duas etapas contando produção fariam a
mesma unidade ser contada duas vezes. Isso não é hipótese: aconteceu na
primeira troca de perfil testada.

**A tela é uma só.** O vocabulário é `data-vocab` no HTML, trocado em tempo de
carga (`public/js/producao-vocab.js`). Duplicar as telas por segmento faria
duas telas iguais divergirem na terceira correção.

---

## Decisões do prospect que originaram o módulo (27/08/2026)

| # | Pergunta | Resposta | Consequência no desenho |
|---|---|---|---|
| 1 | Catálogo ou sob projeto? | **Os dois** | `pmo_pecas.modo` = `catalogo` \| `obra`. Mesma OP, origem diferente |
| 2 | Forma fixa ou pista de protensão? | **Os dois** | Controle tecnológico sobe da F2 para a **F1** — ver "A protensão puxa o ensaio para a F1" |
| 3 | Monta no cliente? | **Não sabe — deixar opcional** | `pmo_obras.comMontagem`, default 0. Liga a OS e a NFS-e; desligado, nada aparece |
| 4 | Granularidade do apontamento | **"Ele define a quantidade"** | Apontamento por quantidade no catálogo; **identificação individual imposta** em peça de obra ou protendida — ver "O que não é configurável" |
| 5 | Pátio | **Próprio** | Endereçamento fica como texto livre (`posicaoPatio`) até ele confirmar se há ruas/quadras |
| 6 | Porte | **20+ funcionários** | Enterprise (usuários ilimitados). Apontamento por equipe é obrigatório, não opcional |
| 7 | Dor declarada | **"Quanto o funcionário produz"** | Painel de produtividade entra na F1, não na F2 |

---

## Descobertas que moldaram o plano

### 1. `produto_kit_itens` é um BOM, mas não serve como ficha técnica

`db-schema.js:1161` já tem estrutura de composição: `produtoPaiId`,
`produtoFilhoId`, `quantidade`, com `UNIQUE(pai, filho)`.

Três coisas impedem o reuso:

- **não tem perda.** Em pré-moldado a perda de concreto (sobra de betonada,
  limpeza de forma) e de aço (pontas de corte) é de 3 a 8%, e é ela que separa
  custo teórico de custo real;
- **o UNIQUE proíbe o mesmo insumo duas vezes.** Uma peça leva CA-50 de duas
  bitolas — que no cadastro são dois produtos, sim, mas também leva o mesmo
  aditivo em dois momentos do traço;
- **kit é consumido pela venda.** `produto_kit_itens` é lido na saída do
  pedido. Pendurar produção nele faria a venda de uma peça explodir os insumos
  no faturamento, baixando duas vezes.

**Decisão:** `pmo_ficha_itens` própria, com `perdaPercentual`. Mesma decisão
que a locação tomou com `reservas_estoque` (`locacao-schema.js:26`) e pelo
mesmo motivo: a estrutura existente responde outra pergunta.

### 2. A ficha técnica do restaurante é o molde certo, com um ajuste

`rest_ficha_itens` (`restaurante-schema.js:195`) já resolveu o problema difícil:
`quantidadeBruta` é o que baixa do estoque, `fatorCorrecao` é a perda, e
`restaurante-ficha.js` explode sub-receitas com guarda de profundidade e
detecção de ciclo (`PROFUNDIDADE_MAX = 5`).

Pré-moldado tem a mesma estrutura em dois níveis: peça → armação → aço. A
explosão recursiva serve inteira.

O ajuste é de vocabulário e de base: no restaurante a perda é um **divisor**
(`bruto ÷ líquido`, alface 1,4); em pré-moldado o consumo é declarado como
volume de projeto **mais** um percentual de perda. `pmo_ficha_itens` usa
`perdaPercentual` e o consumo é `quantidade × (1 + perda/100)`.

### 3. `funcionarios_ponto` fecha a conta da produtividade

`rh-routes.js:64` já registra o ponto. É isso que transforma o indicador de
estimado em real: o apontamento diz que a equipe concretou 12 m³ na pista 2;
o ponto diz quantas pessoas-hora estavam presentes naquele turno. O
**homem-hora do denominador não é digitado por ninguém** — sai do ponto.

Sem essa ligação, o número vira o que o encarregado quiser que ele seja.

### 4. A OS já resolve a montagem no cliente

Mesma descoberta que a locação fez: `os_tipos.checklistPadrao` copiado na
criação (`os-routes.js:1524`), `os_checklist` com `obrigatorio` travando a
conclusão (`os-routes.js:1684`), `os_anexos` para foto e
`exigeAssinaturaCliente`. Um tipo de OS semeado (`premoldado-montagem`) entrega
a montagem com checklist e assinatura sem código novo.

Por isso a decisão 3 custa quase nada: é uma flag e um seed.

### 5. `movimentacoes_estoque` aceita a baixa de produção sem alteração

`db-schema.js:1124` tem `origem` + `origemId` livres, com índice
(`idx_movimentacoes_origem`). A baixa de insumo entra como
`origem='pmo_op'`, `origemId=<opId>`, e a entrada da peça acabada como
`origem='pmo_op_producao'`. Nenhuma coluna nova no core.

---

## A protensão puxa o ensaio para a F1

Esta é a consequência mais cara da decisão 2, e não é negociável.

Em **forma fixa** o ciclo é: concretar → esperar → desmoldar. O ensaio de
corpo de prova é controle de qualidade: importante, mas posterior.

Em **pista de protensão** o ensaio é **operacional e bloqueante**. A
transferência da protensão só pode ocorrer quando o concreto atinge o fck de
transferência (tipicamente 21 a 24 MPa, contra 35 de projeto). Cortar a
cordoalha antes disso arranca a peça.

Um módulo que deixasse essa liberação fora do sistema entregaria à fábrica um
formulário para preencher depois — e o encarregado, com razão, ignoraria.

**Decisão:** `pmo_lotes_concreto` + `pmo_corpos_prova` entram na F1, e a
transição `concretada → liberada_desforma` da OP é **travada** quando
`pmo_pecas.cura = 'pista_protensao'` e não há corpo de prova de transferência
com `resistenciaMpa >= fckTransferencia` **da peça daquela OP**.

A comparação é feita na hora da liberação, contra o fck da peça — não se
confia no `aprovado` gravado na ruptura. O motivo: um lote serve várias OPs, e
a associação OP↔lote acontece na concretagem, que pode ser posterior ao ensaio.
Um CP rompido a 26 MPa é aprovado para a peça que exige 24 e **reprovado** para
a que exige 30, e as duas podem dividir o mesmo lote.

Três travas de apoio, que as auditorias de 27/08 mostraram serem necessárias.
Todas nasceram do mesmo padrão: **editar o cadastro da peça no meio de uma OP
mudava a régua depois do jogo começar.**

- **`modo` e `cura` não podem mudar com OP em andamento** (qualquer status não
  terminal, inclusive `planejada`). Sem isso, trocar a cura para `forma_fixa`
  no meio de uma OP concretada liberava a desforma sem ensaio — e o evento
  gravado ainda diria "cura em forma fixa, sem trava de ensaio".
- **O fck de transferência é CONGELADO na concretagem**
  (`pmo_ops.fckTransferenciaExigidoMpa`). A guarda acima não bastava: `cura`
  continuava `pista_protensao` e só o número baixava, de 30 para 21, fazendo um
  ensaio de 22 MPa "aprovar". Congelado, o cadastro só alcança as próximas OPs
  — mesma lógica da ficha congelada na liberação.
- **A liberação forçada é o único caminho de exceção.** Exige as três coisas
  juntas: `pmo_permitir_liberacao_sem_ensaio = 1`, `forcar` no pedido e uma
  justificativa escrita. Grava evento `liberacao_forcada` com usuário, e o
  painel de aderência conta essas liberações separadamente.

---

## O que não é configurável, e por quê

O prospect disse que a quantidade de peças "pode ser ele quem define". Isso
vale para **granularidade de apontamento**, e só até onde a rastreabilidade
permite:

| Situação | Apontamento | Configurável? |
|---|---|---|
| `modo='catalogo'` e `cura='forma_fixa'` | por quantidade ("saíram 40 blocos") | sim |
| `modo='obra'` | peça a peça, identificada | **não** |
| `cura='pista_protensao'` | peça a peça, identificada | **não** |

O motivo é que a identificação individual é o que amarra peça ↔ lote de
concreto ↔ corpo de prova. Sem ela, o ensaio não prova nada sobre a peça que
foi para a obra, e a NBR 9062 fica sem lastro.

Se isso fosse uma opção de tela, alguém a desligaria numa semana apertada — e
o dado sumiria justamente onde é exigido. `pmo_pecas.exigeIdentificacao` é
**derivado**, gravado pelo backend a cada save do tipo de peça, e a API
recusa sobrescrevê-lo para baixo.

---

## Fases

### F1 — produção (fecha o modo catálogo e a dor declarada)

1. **Tipo de peça** (`pmo_pecas`, 1:1 com `produtos`): modo, cura, volume de
   concreto, peso, dimensões, fck de projeto e de transferência, tempo de cura.
2. **Ficha técnica** (`pmo_ficha_itens` + `premoldados/ficha.js`): insumos com
   perda, explosão recursiva, custo teórico da peça, avisos de insumo sem custo.
3. **Formas e pistas** (`pmo_formas`): o recurso que satura, com capacidade.
4. **Ordem de produção** (`pmo_ops` + `pmo_op_insumos`): origem estoque ou
   obra, ciclo `planejada → liberada → concretada → curando → liberada →
   concluida`, baixa de insumo no apontamento de concretagem, entrada da peça
   acabada na conclusão.
5. **Apontamento** (`pmo_apontamentos`, `pmo_equipes`, `pmo_equipe_membros`):
   por equipe, com etapa (armação, forma, concretagem, desforma, acabamento),
   quantidade produzida e **refugo com motivo**.
6. **Controle tecnológico** (`pmo_lotes_concreto`, `pmo_corpos_prova`): lote
   de betonada, corpo de prova, ruptura, liberação de protensão.
7. **Peça identificada** (`pmo_pecas_produzidas`): quando exigida pela regra
   acima.
8. **Custo por OP**: insumo real + hora apontada, contra o teórico da ficha.
9. **Painel de produtividade** (`premoldados/produtividade.js`): m³ por
   homem-hora, peças por ciclo de forma, refugo por equipe, aderência ao ciclo.

### F2 — obra (fecha o modo sob projeto)

10. **Obra** (`pmo_obras`, `pmo_obra_itens`): agregador de pedido, peças,
    entregas e custo. `comMontagem` opcional.
11. **Pátio**: posição da peça, idade, peças paradas por obra.
12. **Romaneio** (`pmo_romaneios`, `pmo_romaneio_itens`): carga com peso,
    comprimento e **sequência de descarga** — a peça que monta primeiro sobe
    por último.
13. **Medição** (`pmo_medicoes`): faturamento parcial por competência, NF-e do
    fornecimento e NFS-e da montagem quando `comMontagem=1`.

---

## Pontos de registro no core

| Arquivo | O que entra |
|---|---|
| `db-schema.js` | `require('./premoldados/pmo-schema').initPremoldadosSchema(db)` |
| `route-registry.js` | `registrarRotasPremoldados(app, db)` |
| `plan-modules.js` | slug `premoldados` no `MODULE_SLUGS` e no tier `enterprise` |
| `module-gate.js` | `{ prefix: '/api/premoldados/', module: 'premoldados' }` + legado |
| `features-routes.js` | `premoldados` em `FEATURE_KEYS` |
| `public/js/menu-config.js` | grupo com `feature: 'premoldados'` |
| `perfis-api-map.js` | `/api/premoldados` → páginas do módulo |

Todos são arquivos de **core/infra**: só entram em vigor no restart do
`consulta-licitacoes.service`. Até lá o módulo existe em disco e não é
alcançável — que é o comportamento desejado durante o desenvolvimento.

---

## Testes

Todos contra **banco descartável em `/tmp`** — não contra `labfiscal`. O
harness de farmácia/locação usa o tenant real e já petrificou resíduo em
produção uma vez (`scripts/locacao-teste-util.js:9`); aqui isso não é
necessário, porque o módulo não depende de massa histórica.

| Script | Cobre | Asserções |
|---|---|---:|
| `scripts/test-producao-f0.js` | a FIAÇÃO nos 8 pontos de registro do core | 58 |
| `scripts/test-producao-f1.js` | perfil, ficha, recurso, ordem, apontamento, ensaio, produtividade + regressões | 172 |
| `scripts/test-producao-f2.js` | projeto, estoque de acabados, romaneio, medição + regressões | 103 |
| `scripts/test-producao-telas.js` | as 10 telas em Chrome headless | 63 |
| `scripts/test-producao-sem-rh.js` | o módulo em tenant sem `funcionarios`/`funcionarios_ponto` | 17 |

**O F0 existe por um erro concreto.** Em 27/08 as 344 asserções estavam verdes
e o módulo não aparecia no painel do super-admin: `control-plane-routes.js` tem
um catálogo PRÓPRIO de features (`FEATURES`) que nenhum outro ponto consulta, e
ele havia ficado de fora. Testar comportamento não prova fiação.

**`npm run verify` NÃO cobre este módulo.** Ele roda `node --check` só nos
`.js` da raiz e de `scripts/` — subdiretório não entra, e isso vale também para
`locacao/`, `farmacia/`, `posto/` e `restaurante/`. Uma crase dentro de um
template SQL quebrou o `prod-schema.js` inteiro e o verify passou verde. Rode
`for f in producao/*.js; do node --check "$f"; done` depois de mexer aqui.

O boot compartilhado está em `scripts/producao-teste-util.js`. A ordem
importa e não é óbvia: `contas-financeiras-routes` → `initSchema` →
`estoque-routes` → `rh-routes` → `premoldados-routes`.

**Por que existe um teste de tela:** `npm run verify` roda `node --check` só
nos `.js` da raiz e de `scripts/` — o JavaScript inline dos HTML de `public/`
fica de fora, e arquivo estático entra em produção ao salvar. O teste carrega
cada tela dentro do shell (iframe + stubs de `/api/features/status` e
`/api/perfis/meu-acesso`) e falha em erro de JS, `undefined` visível e
`[object Object]` na página.

**Por que existe um teste sem RH:** `funcionarios` e `funcionarios_ponto` vêm
do `rh-routes`, cujo `migrarDB` é no-op em multi-tenant. Levantado em
2026-08-27: `crsolucoes` e `pccontabilidade` não têm nenhuma das duas. O painel
de produtividade lê as duas — sem guarda, devolvia 500 e derrubava justamente a
F1.9. O contrato testado é: degrada com aviso, nunca 500.

---

## Onde o módulo toca o estoque core

Três origens em `movimentacoes_estoque`, todas com `origem`/`origemId` livres
(nenhuma coluna nova no core):

| Momento | tipo | origem | origemId |
|---|---|---|---|
| Concretagem baixa os insumos | `saida` | `pmo_op` | id da OP |
| Conclusão dá entrada da peça | `entrada` | `pmo_op_producao` | id da OP |
| Cancelamento estorna a baixa | `entrada` | `pmo_op_estorno` | id da OP |
| Entrega do romaneio baixa a peça | `saida` | `pmo_romaneio` | id do romaneio |

**A baixa da peça acabada é na ENTREGA, não na expedição** — peça em trânsito
ainda é da fábrica. Quando a emissão de NF-e da medição existir (gap 4 abaixo),
a baixa migra para lá; hoje é aqui ou em lugar nenhum, e sem ela o saldo do
produto acabado só cresceria.

**`data` é sempre data pura (`YYYY-MM-DD`), como o resto do core.**
`estoque-routes.calcularCustoMedio` elege o custo médio vigente com
`ORDER BY data DESC, id DESC` entre as linhas com `custoMedioPosterior`. Uma
linha com hora é lexicograficamente maior que qualquer data-só do mesmo dia:
ela sequestraria a consulta, devolveria um custo médio antigo, e a movimentação
seguinte materializaria o erro para o produto no tenant inteiro — CMV, margem
de pedido e valorização de inventário. Foi o pior achado da auditoria de 27/08.

## A entrega tem dois donos, e eles têm de concordar

A quantidade entregue de um item de obra aparece em dois lugares, e a segunda
auditoria mostrou que eles divergiam:

- **quem credita** (`expedicao.creditarEntrega`) — atualiza
  `pmo_obra_itens.quantidadeEntregue`;
- **quem fatura** (`obra.previaMedicao`) — decide o preço de cada peça.

Os dois usam a MESMA regra, e é isto que os mantém coerentes:

1. se a peça veio de uma OP amarrada a um item (`pmo_ops.obraItemId`), é nesse
   item que ela cai — vínculo explícito, não heurística;
2. sem vínculo (peça de catálogo, que não passa por item de obra), FIFO por
   ordem de cadastro, respeitando o saldo de cada linha;
3. o que exceder o contratado é creditado na última linha e aparece em
   `naoContratados` na medição — nunca é descartado nem ganha preço inventado.

O passo 1 não é detalhe: uma obra tem duas linhas do mesmo produto quando há
aditivo com preço diferente do lote original. Sem o vínculo, a peça produzida
para o aditivo de R$ 1.500 era creditada e faturada a R$ 1.000, e o painel
dizia que ela ainda faltava entregar — para sempre.

Pelo mesmo motivo, o carimbo de "já medido" é **por quantidade**, não por
romaneio: numa medição parcial, marcar o romaneio inteiro como medido deixava
a sobra sem faturamento possível, nem depois de um aditivo elevar o contrato.

## Gaps declarados (o que este plano NÃO entrega)

1. **Endereçamento de pátio** é texto livre. Vira tabela quando ele confirmar
   se o pátio tem ruas/quadras.
2. **Projeto estrutural / desenho da peça** não entra: o módulo referencia o
   projeto por código e anexo, não o gera nem o interpreta.
3. **Traço por betonada com balança** — a dosagem real vem digitada, não da
   automação da central. Integração com central dosadora fica fora.
4. **CNO/INSS da obra** não é tratado: matrícula e retenção previdenciária de
   construção civil são um módulo fiscal próprio.
5. **Prêmio de produção** só calcula o indicador; a regra de pagamento fica em
   `comissoes-calculo.js`, que já existe e não é tocado aqui.
