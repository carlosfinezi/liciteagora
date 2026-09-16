# Módulo Locação — plano de implementação

Data: 2026-08-27. Molde: a vertical **ótica** (`optica/`), o mesmo precedente
que farmácia, posto e restaurante seguiram.

---

## Suposições declaradas (as 4 decisões ainda em aberto)

Foram perguntadas e não respondidas. O plano abaixo assume o default de cada
uma; onde a resposta muda o desenho, está anotado no ponto exato.

| # | Decisão | Assumido aqui | Se for diferente |
|---|---|---|---|
| 1 | Segmento | **Equipamentos/máquinas + artigos de festa** — o núcleo comum "bem móvel que sai e volta" | **Veículos** acrescenta condutor/CNH/multa/sinistro (F7 nova). **Imóveis** é outro módulo: repasse ao proprietário, IPTU/condomínio, IGPM — nada da F2 e F4 aqui serve |
| 2 | Onde vive a unidade alugável | **`produtos` + `serial_numbers`** | **`patrimonio_bens`**: ganha depreciação de graça, mas F2 perde o saldo de estoque e a NF-e de remessa precisa de caminho próprio. **`equipamentos`**: hoje modela equipamento *do cliente*, precisaria de coluna de posse |
| 3 | Faturamento | **Os dois**, em ordem: avulsa (F3) primeiro, contrato aberto (F5) depois | Só avulsa: F5 encolhe pela metade (sai a ponte com `contratos`/`nfse_recorrencias`) |
| 4 | Tenant piloto | **a definir** — flag nasce desligada em todos | — |

---

## Descobertas que moldaram o plano

### 1. A reserva de estoque não tem tempo — e não dá para dar tempo a ela

`reservas_estoque` (`reservas-routes.js:23`) reserva **quantidade por pedido**,
sem intervalo. `saldoReservado()` soma reservas ativas de um produto; quem
pergunta "quanto sobra" recebe um número, não uma agenda.

Locação é o contrário: a mesma máquina está livre em setembro e ocupada em
outubro. A pergunta não é *quanto*, é *quando*.

Não dá para acrescentar `dataInicio/dataFim` em `reservas_estoque`: essa função
é consumida por pedidos (`pedidos-routes.js:999`), OS e produtos, e todos
esperam a semântica de soma. Uma reserva com data faria o pedido de venda ver
como indisponível um item que só sai em novembro.

**Decisão:** tabela própria `locacao_reservas`, com disponibilidade calculada
por **sobreposição de intervalos**, não por soma. O cálculo do módulo consulta
as duas fontes: saldo físico − reservado de venda (`saldoReservado`) − ocupado
por locação no período − em manutenção.

### 2. A OS já é o motor de vistoria que eu ia construir

Não é só "tem OS". A Fase 9.1 (`db-schema.js:1610`) deixou pronto exatamente o
que uma saída e um retorno de locação precisam:

- `os_tipos.checklistPadrao` copiado **na criação** da OS (`os-routes.js:1524-1530`)
  — a OS fica imune a mudança posterior no tipo;
- `os_checklist` com `obrigatorio`, e a conclusão **travada** enquanto houver
  item pendente (`os-routes.js:1684-1692`);
- `os_anexos` por categoria — as fotos da vistoria;
- `exigeAssinaturaCliente` no tipo;
- `os_eventos` para a linha do tempo.

Dois tipos de OS semeados (`locacao-entrega`, `locacao-devolucao`) entregam
vistoria com foto, checklist que trava e assinatura **sem uma linha nova de
código de vistoria**. É o maior reaproveitamento disponível no repo.

### 3. `contratos` serve, mas seus itens são informativos por decisão de projeto

`contratos-routes.js:81-83` é explícito: os itens **não** recalculam
`valorMensal`, porque existe desconto de pacote que a soma não expressa.

Na locação o item *é* o valor — tirar uma máquina muda a fatura do mês.

**Decisão:** não mexer nessa regra (ela protege um caso real). O contrato de
locação calcula seu valor a partir de `locacao_itens` próprios e **escreve o
resultado** em `contratos.valorMensal`. O `contratos` core continua sendo a
fonte de renovação automática, `indiceReajuste`/`dataProximoReajuste` e do
vínculo com `nfse_recorrencias` — tudo isso vem de graça.

### 4. O fiscal precisa estar no schema desde o primeiro dia, não depois

Locação pura de bem móvel **não gera ISS** (Súmula Vinculante 31 do STF). Mas o
próprio STF afasta a súmula quando, num contrato complexo, a locação **não está
claramente segmentada da prestação de serviço** — nem no objeto nem no valor da
contrapartida. Operador, montagem, frete e limpeza são serviço; a diária da
máquina não é.

Isso não é ajuste posterior: se as duas coisas entrarem como "item" genérico,
separá-las depois exige reprocessar documento emitido.

**Decisão:** `locacao_itens.natureza IN ('locacao','servico')` desde a F3, com
`tipoOperacaoId` distinto em cada uma. A linha de serviço vai para NFS-e; a de
locação vai para fatura + NF-e de remessa/retorno.

> **Conferir com o contador antes da F5:** os CFOPs de remessa e retorno
> (5908/6908 na saída; 1909/2909 no retorno do bem que remetemos) e o
> tratamento IBS/CBS, já que a locação de bem móvel entra na base da reforma
> pelo cronograma 2026-2033. O repo tem cadastro de CFOP e `tipos_operacao`
> com `movimentaEstoque`/`emiteNFe`/`geraFinanceiro` — a fiação existe, a
> escolha dos códigos é do contador.

### Bônus: nenhum ícone novo

Diferente da farmácia (que precisou de `'💊': 'pill'`), `🔑`, `🚚`, `📅` e `⏱️`
**já estão** no mapa de `public/js/sidebar.js`. Sugestão: `🔑` (`key-round`)
para a seção.

---

## Forma do módulo

| Peça | Ótica (referência) | Locação |
|---|---|---|
| Pasta | `optica/optica-routes.js` | `locacao/locacao-routes.js` + `locacao-schema.js` |
| Tabelas | `optica_*`, 1:1 com `produtos` via FK | `locacao_*`, mesma regra |
| Registro de rotas | `route-registry.js:117` e `:280` | mesmas duas linhas |
| Migração real | `db-schema.js` (como restaurante `:2325`, farmácia `:2333`, posto `:2340`) | `require('./locacao/locacao-schema').initLocacaoSchema(db)` |
| Flag do tenant | `config('optica_enabled')` | `config('locacao_enabled')` |
| Slug de plano | `otica` (`plan-modules.js:34`) | `locacao`, junto dos verticais |
| Chave legada | `optica` (`features-routes.js:18`) | `locacao` + `LEGACY_FEATURE_TO_MODULES` (`module-gate.js:22`) |
| Telas | `public/optica/` | `public/locacao/` |
| Menu | `menu-config.js:363` (`feature: 'optica'`) | idem, `feature: 'locacao'` |

**Regra herdada e mantida: não alterar tabela core.** `produtos`, `pedidos`,
`reservas_estoque`, `contratos` e `os_ordens` não ganham coluna de locação. As
ligações são por FK a partir das tabelas `locacao_*`.

**Gate de plano:** `locacao` depende de `produtos_estoque_completo` (série) e
`contratos_os` (as OS de entrega/devolução). Recomendação: entrar como **add-on
por override**, no modelo do `ssl_nicsrs` — fora de todo tier, concedido caso a
caso — e decidir a matriz quando houver cliente real.

---

## Fases

Ordem por dependência de dado. F1 e F2 são o núcleo insubstituível: sem
tarifário e sem disponibilidade por período não existe locação, e tudo depois
delas é reaproveitamento do que o repo já tem.

### Fase 0 — fundação

Esqueleto, sem regra de negócio.

- `locacao/locacao-schema.js` com `initLocacaoSchema(db)`; `locacao/locacao-routes.js`
  com `registrarRotasLocacao(app, db)`, `getFlag()` e `gateFlag` devolvendo 403
  `locacao_disabled`.
- `GET /api/locacao/status` sem gate (o front pergunta se o módulo existe).
- Os oito pontos de fiação da tabela acima.
- Seção no `menu-config.js` com `feature: 'locacao'`, ícone `🔑`.

**Verificação:** `npm run verify` verde; `status` devolve `enabled:false` em
tenant qualquer e `true` no piloto depois da flag; nenhuma rota
`/api/locacao/*` responde sem flag; menu só aparece no piloto.

### Fase 1 — catálogo alugável e tarifário

**Schema** (1:1 com `produtos`, espelhando `optica_armacao_specs`):

- `locacao_item_specs` — `produtoId` PK/FK, `alugavel`, `exigeSerie`,
  `cauçaoPadrao`, `categoria`, `horasPreparo` (turnaround entre duas
  locações), `franquiaDiaria` (horas ou km), `medidorTipo` (`nenhum`/`horimetro`/`km`).
- `locacao_tarifas` — `produtoId`, `faixa` (`hora`|`dia`|`semana`|`quinzena`|`mes`),
  `valor`, `minimoFaturavel`, `ordem`. Progressividade: 7 diárias devem virar
  1 semana, não 7 × diária.
- `locacao_tarifa_extras` — hora/km excedente, taxa de entrega, taxa de
  limpeza, taxa de atraso.

**Código:** `locacao/tarifa.js` com `calcularTarifa(produtoId, inicio, fim, opts)`
— função pura, sem `db` escondido, testável isolada.

**Telas:** `public/locacao/itens.html`, `public/locacao/tarifas.html`.

**Verificação:** `scripts/test-locacao-f1.js` (padrão dos `test-farmacia-fN.js`),
com os casos de borda que definem o negócio: exatamente 7 dias, 6 dias e meio,
devolução no mesmo dia, período que cruza a virada do mês, mínimo faturável.

### Fase 2 — disponibilidade por período

O coração do módulo.

- `locacao_reservas` — `produtoId`, `serialNumberId` (nulo quando genérico),
  `quantidade`, `dataInicio`, `dataFim`, `status`, `documentoTipo`,
  `documentoId`. Índice em `(produtoId, status, dataInicio, dataFim)`.
- `disponibilidade(produtoId, inicio, fim)`: saldo físico
  − `saldoReservado()` (venda) − sobreposições em `locacao_reservas`
  − unidades em manutenção. O `horasPreparo` da F1 entra como folga no fim de
  cada reserva.
- `GET /api/locacao/disponibilidade?produtoId&inicio&fim`
- `GET /api/locacao/calendario?de&ate` para a grade visual.

**Verificação:** teste com sobreposição parcial nas duas pontas, encaixe exato
(uma volta 10h, outra sai 10h — deve falhar se `horasPreparo > 0`), item com
série vs genérico, e reserva cancelada não bloqueando.

### Fase 3 — o documento de locação (avulsa)

- `locacao_contratos` — `numero`, `clienteId`, `tipo` (`avulsa`|`aberta`),
  `dataSaidaPrevista`, `dataRetornoPrevisto`, `dataRetornoReal`, `status`
  (`orcamento`→`reservado`→`emAndamento`→`devolvido`→`encerrado`),
  `cauçaoValor`, `cauçaoStatus`, endereço de entrega, `contratoCoreId` (FK
  opcional para `contratos`, usada só no tipo `aberta` na F5).
- `locacao_itens` — `contratoId`, `produtoId`, `serialNumberId`, `quantidade`,
  **`natureza`** (`locacao`|`servico`), `tipoOperacaoId`, `tarifaFaixa`,
  `valorUnitario`, `valorTotal`, `medidorSaida`, `medidorRetorno`.
- `locacao_eventos` — espelho de `contratos_eventos`.
- Máquina de estados; a confirmação do orçamento é o que grava em
  `locacao_reservas`.

**Telas:** `public/locacao/locacoes.html` (grid + calendário da F2),
`public/locacao/locacao.html` (o documento).

**Verificação:** confirmar orçamento cria reserva; cancelar libera; conflito de
período recusa com mensagem que diz **qual** locação ocupa.

### Fase 4 — saída, retorno e avaria via OS

Sem código novo de vistoria — só configuração e ligação.

- Seed de dois `os_tipos`: `locacao-entrega` e `locacao-devolucao`, com
  `checklistPadrao` de vistoria e `exigeAssinaturaCliente = 1`.
- `locacao_contratos.osEntregaId` / `osDevolucaoId`.
- No retorno, a apuração que gera as linhas de acerto:
  **atraso** (multa da F1, com carência configurável), **avaria**, **medição**
  (horímetro/km fora da franquia).
- `locacao_avarias` — `contratoId`, `itemId`, `descricao`, `valorCobrado`,
  `osAnexoId` (a foto já está na OS).

**Verificação:** fluxo completo no harness de teste isolado (banco descartável
+ Chrome headless), incluindo devolução com 2 dias de atraso e uma avaria.

### Fase 5 — financeiro e fiscal

- CR com `origemTipo = 'locacao'` (a coluna já existe — `os-routes.js:392`).
- **Caução** como título de natureza própria: retido → devolvido | abatido.
  É a única peça financeira sem precedente no repo.
- Linha `servico` → NFS-e; linha `locacao` → fatura + NF-e de remessa/retorno,
  com `tipos_operacao` dedicados (CFOPs a confirmar com o contador).
- Tipo `aberta`: cria e liga um `contratos` core, que passa a cuidar de
  renovação, reajuste por índice e recorrência — e a recorrência de NFS-e cobre
  **só a parte de serviço**.
- `locacao_notificacoes_config(evento, canal, template, ativo)` — cópia
  deliberada do padrão de `os_notificacoes_config`, que é o único do repo com
  granularidade por evento×canal. Eventos: retorno amanhã, retorno atrasado,
  contrato a vencer, caução a devolver.

### Fase 6 — manutenção e BI

- Medidor acumulado por série; ao cruzar o intervalo, abre OS preventiva e o
  ativo **sai da disponibilidade** da F2 enquanto estiver em manutenção.
- Indicadores: taxa de ocupação por ativo, receita por ativo, custo de
  manutenção, ROI contra o valor de aquisição — com ponte para
  `patrimonio_bens` quando a unidade também for bem do imobilizado.

---

## Fora do escopo desta v1

- Veículos: CNH, condutor, multa, seguro, sinistro.
- Imóveis: repasse ao proprietário, IPTU/condomínio, reajuste IGPM.
- Telemetria automática (o medidor é digitado; a integração vem depois).
- Assinatura com validade ICP-Brasil — a da OS é registro, não certificação.
- Portal do cliente para autoatendimento de reserva.
- IBS/CBS: acompanhar, não implementar antes de o contador definir.

---

## Riscos e pendências

1. **Contrato misto e a SV 31.** Mitigado no schema (F3), mas a separação
   precisa aparecer também no **documento impresso** e no valor — senão o
   município autua. Revisar o PDF na F5.
2. **CFOPs de remessa/retorno não conferidos.** Bloqueia a F5, não as anteriores.
3. **Caução não tem precedente financeiro no repo.** É dinheiro que entra e não
   é receita; se entrar como CR comum, contamina o DRE.
4. **`reservas_estoque` fica com duas verdades.** Um produto poderá estar
   reservado para venda e ocupado por locação em tabelas diferentes. Quem
   consulta disponibilidade **precisa** passar pela função da F2 — documentar
   isso no topo do `locacao-schema.js`.
5. **Tabelas nascendo em todos os tenants.** Padrão já assumido pelo
   restaurante (`db-schema.js:2325`): tabela vazia não custa e evita
   divergência.

---

## Ordem de execução

`F0 → F1 → F2 → F3 → F4 → F5 → F6`

F1 e F2 são as únicas sem atalho. A partir da F3 o trabalho é majoritariamente
ligar peças existentes — OS, contratos, CR, NF-e, notificações — o que coloca o
custo real do módulo bem abaixo do que o tamanho da lista sugere.

---

## Situação em 2026-08-27 (implementado)

As 7 fases estão no ar no tenant `labfiscal`, com **504 asserções** em
`scripts/test-locacao-f0.js` .. `f6.js`.

Um agente validador independente auditou a entrega e encontrou 11 defeitos —
6 graves, todos confirmados por probe próprio antes de corrigir. **Os
corrigidos estão cobertos por teste de regressão**, cada um marcado no arquivo
com o comentário `REGRESSÃO (bug encontrado na validação)`:

| Bug | Onde | Efeito |
|---|---|---|
| DP com passo diário quebrava faixas menores | `tarifa.js` | 61 dias custavam R$ 915 contra R$ 3.000 dos 60 — alugar mais tempo saía mais barato |
| Limite fixo em 1 para item com série | `disponibilidade.js` | a mesma máquina alugada duas vezes nos mesmos dias |
| `excetoContratoId` no cálculo de reserva | `disponibilidade.js` | dois itens do mesmo produto no mesmo contrato furavam o saldo |
| `dataFim` não estendido | `apuracao.js` | o bem que não voltou reaparecia livre ao passar a data prevista |
| Trava de duplicidade só com competência | `faturamento.js` | dois cliques em "Faturar" geravam dois títulos cheios |
| Status `'pendente'` no CR | `faturamento.js` | título não podia ser baixado, sumia do aging, do DRE e da cobrança |
| `CREATE INDEX` fora do tolerante | `locacao-schema.js` | schema antigo derrubava o **boot do tenant** |
| JOIN multiplicava a receita | `manutencao.js` | "receita por ativo" e ROI inutilizáveis com mais de um item |

### Pendências assumidas (não implementadas)

1. **Nada envia as notificações.** `apurarNotificacoes` calcula os 4 eventos e
   `locacao_notificacoes_config` guarda a preferência por evento×canal, mas não
   há gancho no `scheduler.js` nem dispatcher. O tenant pode ligar um aviso e
   não receber nada.
2. **ROI contra `patrimonio_bens` não existe.** O painel entrega ocupação,
   receita rateada, custo de manutenção e resultado. A ponte com o imobilizado
   depende de decidir como casar `produtos` ↔ `patrimonio_bens` (hoje não há
   FK), e isso não foi resolvido.
3. **Caução e DRE.** A garantia só fica fora do resultado se o tenant apontar
   uma conta patrimonial em `locacao_caucao_plano_conta_id`. Sem isso a API
   **avisa** no retorno de `caucao/receber`, mas o valor entra no DRE. Antes
   ficava de fora por acidente (status inválido), o que era pior.
4. **Testes rodam contra o banco real do `labfiscal`**, não contra banco
   descartável como a F4 prometia. Eles se limpam (`locacao-teste-util.js`
   restaura a config até em caso de exceção), mas o harness isolado com Chrome
   headless não foi feito.
5. **Gate de plano**: entrou no tier `enterprise`, e não como add-on por
   override — divergindo da recomendação da seção "Forma do módulo".
6. **CFOPs de remessa/retorno seguem não conferidos** com o contador, e nenhum
   documento fiscal é emitido pelo módulo. O faturamento separa os valores por
   natureza e deixa `nfseId`/`nfeId` prontos para quem for emitir.
