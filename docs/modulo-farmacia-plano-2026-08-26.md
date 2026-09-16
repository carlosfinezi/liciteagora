# Módulo Farmácia — plano de implementação

Data: 2026-08-26. Escopo fechado em `modulo-farmacia-levantamento-2026-08-26.md`:
**drogaria apenas**, UF **PA**, tenant piloto **`labfiscal`**, **sem Farmácia
Popular** e **sem PBM** na v1, cadastro alimentado pela **lista CMED da ANVISA**.

Este plano cobre a v1 = Tier 0 do levantamento mais o mínimo de balcão.

---

## Descobertas que moldaram o plano

Três coisas encontradas no código mudam decisões de projeto. Vale registrar antes
das fases, porque cada uma corta ou abre caminho.

### 1. A lib de NF-e não emite os grupos de medicamento

`node-sped-nfe` **declara** `tagRastro` e `tagMed`, mas as duas implementações
são literalmente `throw "não implementado!"`:

```
node_modules/node-sped-nfe/dist/utils/make.js:197-205
```

Não dá para usar a lib, e as saídas óbvias estão fechadas: `npm install` está
negado nas permissões, e patch em `node_modules/` se perde no próximo install.

**Decisão:** injetar `<rastro>` e `<med>` no XML **entre `NFe.xml()` e a
assinatura**. O ponto exato já existe e é limpo:

```js
// nfce-routes.js:415-416
const xmlRaw = NFe.xml();
const xmlAssinado = await tools.xmlSign(xmlRaw);
```

Injetar entre essas duas linhas é seguro por construção — a assinatura é
calculada depois, sobre o XML já completo. `fast-xml-parser` já é usado no
projeto (`nfe-emit-routes.js:40`), então a manipulação é por árvore, não por
regex em string: a ordem dos filhos de `<prod>` é rígida no schema
(`rastro` vem antes de `med`) e um splice de texto erraria isso cedo ou tarde.

### 2. A fundação de lote já existe, e é melhor do que o levantamento supôs

Não é só a tabela `lotes`. Já existem:

- `produtos.rastreiaLote` (`estoque-routes.js:25`) — e a validação que **recusa
  movimento sem `loteId`** quando o produto rastreia (`estoque-routes.js:877`);
- `movimentacoes_estoque.loteId` (`estoque-routes.js:37`), com FK para `lotes`;
- `atualizarSaldoLote()` (`estoque-routes.js:384`).

Falta só a **seleção FEFO** e o caminho da venda passar `loteId` — hoje a baixa
da NFC-e (`nfce-routes.js:112-115`) insere movimentação sem lote nenhum.

### 3. O SNGPC tem API oficial, não só upload manual

A ANVISA mantém área de desenvolvedores com **Manual do Desenvolvedor 2.0**,
**XSDs** (tipos simples, complexos, mensagens, operações e retorno), guia de
credenciamento, ambiente de **homologação** e uma **API REST com Swagger**. O
webservice legado segue ativo mas **está marcado para desativação** — nasce
direto na API. Formato de envio: XML → zip → base64, com MD5 calculado sobre o
base64.

Isso promove o SNGPC de "gerar arquivo para o RT subir à mão" para integração de
verdade já na v1.

### Bônus: `xlsx` já está instalado

`xlsx` está nas dependências do `package.json`. O importador da CMED lê o XLS
publicado pela ANVISA direto, sem depender de `npm install` (negado) nem de
conversão manual para CSV.

---

## Forma do módulo

Segue o molde da vertical ótica, que é o único precedente de vertical no repo:

| Peça | Ótica (referência) | Farmácia |
|---|---|---|
| Pasta | `optica/optica-routes.js` | `farmacia/farmacia-routes.js` |
| Tabelas | `optica_*`, 1:1 com `produtos` via FK | `farmacia_*`, mesma regra |
| Registro | `route-registry.js:117` e `:277` | mesmas duas linhas |
| Flag do tenant | `config('optica_enabled')` | `config('farmacia_enabled')` |
| Slug de plano | `otica` em `plan-modules.js:29` | `farmacia` |
| Chave legada | `optica` em `features-routes.js:18` | `farmacia` |
| Telas | `public/optica/` | `public/farmacia/` |
| Menu | `menu-config.js:322` (`feature: 'optica'`) | idem, `feature: 'farmacia'` |

**Regra herdada e mantida: não alterar tabela core.** `produtos`, `nfce`,
`movimentacoes_estoque` não ganham coluna nova de farmácia — os dados
farmacêuticos vivem em `farmacia_*` referenciando `produtos.id`. A única exceção
justificada aparece na Fase 2 e está argumentada lá.

**Migração:** o `migrarDB()` de um `*-routes.js` é no-op em multi-tenant. O
schema entra por `db-schema.js`, no padrão já usado por contratos
(`db-schema.js:2293`): `require('./farmacia/farmacia-routes').migrarDB(db)`.

**Gate de plano:** `farmacia` depende de `varejo`, `fiscal_nfe_completo` e
`produtos_estoque_completo` — sem PDV, sem NFC-e e sem lote não existe farmácia.
Recomendação: entrar como **add-on por override**, no modelo do `ssl_nicsrs`
(fora de todo tier, concedido caso a caso), e decidir a matriz de planos quando
houver cliente real. Ligar só no `labfiscal` enquanto for desenvolvimento.

---

## Fases

Ordem escolhida por dependência de dado, não por tamanho. O grupo `rastro` do
XML exige `nLote/qLote/dFab/dVal` **do lote que saiu na venda** — então o lote na
venda (F2) precisa vir antes do fiscal (F3), embora o fiscal seja o bloqueio
legal mais visível.

### Fase 0 — fundação

Esqueleto do módulo, sem nenhuma regra de negócio.

- `farmacia/farmacia-routes.js` com `migrarDB(db)`, `registrarRotasFarmacia(app, db)`,
  `getFlag()` e `gateFlag` devolvendo 403 `farmacia_disabled`.
- `GET /api/farmacia/status` (read-only, sem gate — o front pergunta se o módulo
  existe).
- Registro em `route-registry.js`; chamada do `migrarDB` em `db-schema.js`.
- Slug `farmacia` em `plan-modules.js`; chave `farmacia` em
  `features-routes.js:18` e no `LEGACY_FEATURE_TO_MODULES` do `module-gate.js`.
- Seção no `menu-config.js` com `feature: 'farmacia'`.
- **Ícone:** o menu usa emoji no config e Lucide na renderização, via mapa em
  `public/js/sidebar.js:258-300`. `💊` **não está no mapa** — adicionar
  `'💊': 'pill'` (e `'🧾'`/`'🧪'` já existem, se servirem para submenus).

**Verificação:** `npm run verify` verde; `GET /api/farmacia/status` devolve
`enabled:false` num tenant qualquer e `true` no `labfiscal` depois da flag;
menu aparece só no `labfiscal`; nenhuma rota `/api/farmacia/*` responde sem flag.

---

### Fase 1 — cadastro farmacêutico + importador CMED

**Schema** (`farmacia_medicamento_specs`, 1:1 com `produtos` via `produtoId`
PRIMARY KEY, espelhando `optica_armacao_specs`):

`registroAnvisa`, `ean`, `substancia`, `classeTerapeutica`, `laboratorio`,
`cnpjLaboratorio`, `apresentacao`, `tarja`, `listaCmed` (positiva/negativa/
neutra), `regimePreco` (regulado/liberado), `pf`, `pmc`, `restricaoHospitalar`,
`listaPortaria344`, `cmedVersaoId`, `isentoRegistro`, `motivoIsencao`.

Mais `farmacia_cmed_versoes` (competência da lista, data de importação, linhas
lidas, linhas casadas) — para saber de que lista veio cada preço e conseguir
reimportar sem adivinhação.

**Importador** (`farmacia/cmed-import.js`):

- lê o XLS da CMED com `xlsx`;
- **coluna de PMC: a de 19%** (alíquota interna do PA) — parametrizada por
  config, não fixa no código, porque é o primeiro item que muda se aparecer
  cliente de outro estado;
- casa produto por **EAN** contra `produto_codigos`; sem match, registra na fila
  de não-casados em vez de criar produto às cegas;
- **tolera EAN sujo** — é defeito conhecido da origem, não do arquivo baixado;
- roda por CLI (`scripts/importar-cmed.js`) e por rota admin com upload.

**Verificação:** importar a lista do mês no `labfiscal`; conferir contagem de
casados/não-casados; um medicamento conhecido tem registro ANVISA, PMC 19% e
lista CMED corretos conferidos contra a planilha.

---

### Fase 2 — lote obrigatório e FEFO na venda

- `farmacia/fefo.js` — `selecionarLotesFEFO(db, produtoId, quantidade, depositoId)`
  devolve `[{loteId, quantidade}]` ordenado por `dataValidade`, **pulando
  vencidos** e respeitando `saldoAtual`. Retorna erro claro quando o saldo com
  validade boa não cobre a quantidade.
- Bloqueio de venda de vencido na baixa, em `estoque-routes.js`, junto da guarda
  de `rastreiaLote` que já existe (`:877`) — é o mesmo ponto de decisão.
- PDV: ao adicionar item de produto que rastreia lote, resolve o FEFO, **mostra
  qual lote saiu** e permite trocar manualmente (devolução, recall, lote
  reservado).
- `emitirNFCe` passa a receber `loteId` por item e a gravá-lo na movimentação
  (`nfce-routes.js:112-115` — a coluna já existe, hoje vai NULL).

**Exceção à regra de não tocar core:** `nfce_itens` ganha `loteId`. A alternativa
seria uma tabela de ligação `farmacia_nfce_item_lote`, mas o item de nota fiscal
com lote é dado fiscal do documento, não extensão de vertical — e o `rastro` do
XML precisa reconstruir isso na consulta e no cancelamento. Uma coluna
nullable, ignorada por quem não é farmácia.

**Verificação:** produto com dois lotes de validades diferentes → sai o mais
velho; lote vencido não é oferecido nem aceito se forçado; `saldoAtual` dos
lotes bate com o vendido; `movimentacoes_estoque.loteId` preenchido.

---

### Fase 3 — `med` e `rastro` na NFC-e/NF-e

- `farmacia/nfe-med-rastro.js` — `injetarMedRastro(xml, itens, db)`:
  - dispara por item quando o NCM começa em **3001–3006**;
  - `<med>`: `cProdANVISA` = registro da spec, ou `ISENTO` — e aí
    `xMotivoIsencao` é obrigatório; `vPMC` = PMC da spec;
  - `<rastro>`: `nLote`, `qLote`, `dFab`, `dVal` do lote resolvido na F2;
  - insere na posição correta dentro de `<prod>` (rastro antes de med), via
    `fast-xml-parser`.
- Chamada entre `NFe.xml()` e `tools.xmlSign()` na NFC-e (`nfce-routes.js:415`)
  e no ponto equivalente da NF-e — o mesmo helper serve aos dois, porque a regra
  é do produto, não do modelo do documento.
- Guarda de emissão: medicamento sem registro/PMC ou sem lote **falha antes de
  ir à SEFAZ**, com mensagem dizendo o que falta. Rejeição 840 vinda de volta é
  diagnóstico caro; o mesmo erro pego localmente é uma linha.

**Verificação:** emitir NFC-e em **`tpAmb=2` (homologação)** no `labfiscal` com um
medicamento com lote → autorizada, sem rejeição 840; o XML gravado contém `med`
e `rastro` com os valores certos; a assinatura valida (prova de que a injeção
antes do `xmlSign` não quebrou nada); um item não-medicamento na mesma nota sai
sem os grupos.

---

### Fase 4 — receita e Portaria 344 no balcão

- `farmacia_receitas`: tipo (notificação A / notificação B / receituário de
  controle especial / antimicrobiano / comum), número, data de emissão, UF,
  prescritor (nome, conselho, UF, número — incluindo **COREN**, que a ANVISA
  passou a aceitar para antimicrobiano), paciente e comprador (nome, documento,
  endereço).
- `farmacia_receita_itens` e o vínculo venda↔receita.
- Validação no PDV: produto com tarja/lista da 344 ou antimicrobiano **exige
  receita**; valida a receita dentro da validade do tipo; confere quantidade
  máxima.

**Verificação:** venda de controlado sem receita é recusada com mensagem
específica (não um 500); com receita completa passa e grava prescritor,
paciente, comprador e itens; a validade vencida é recusada.

---

### Fase 5 — SNGPC

- `farmacia/sngpc-xml.js` — monta o XML conforme o Manual do Desenvolvedor 2.0,
  **validado contra os XSDs da ANVISA** baixados para `farmacia/xsd/`.
- Cobre: inventário inicial (pré-requisito da primeira transmissão), entradas
  (a partir da NF-e de entrada, que já existe), saídas (vendas da F4), perdas e
  transferências.
- `farmacia/sngpc-api.js` — transmissão: zip → base64 → MD5 → API REST da
  ANVISA; **homologação primeiro**; fila com reenvio e registro de protocolo e
  de crítica devolvida.
- Nasce na API nova, não no webservice legado, que está marcado para desativação.

**Verificação:** homologação da ANVISA aceita o inventário inicial e um lote de
movimentação do `labfiscal`; XML valida contra o XSD **antes** de sair;
divergência entre estoque declarado e movimentado aparece em relatório próprio,
não numa notificação da vigilância.

---

### Fase 6 — balcão de farmácia

- Busca por **princípio ativo** e EAN em `/api/nfce/produtos/buscar` (o PDV já
  consome esse endpoint — `public/varejo/pdv.html:191`).
- Sugestão de **genérico e similar**: mesma substância e apresentação, ordenado
  por preço, mostrado na hora de adicionar o item.
- **Trava de PMC**: preço acima do PMC da spec é bloqueado quando
  `regimePreco = regulado`.
- Tela de vencimentos, reaproveitando `/api/lotes/vencendo` (`lotes-routes.js`).

**Verificação:** buscar "dipirona" traz as marcas; trocar por genérico mantém o
carrinho consistente; preço acima do PMC é recusado; a tela de vencimento lista
o que o FEFO vai empurrar primeiro.

---

## Fora do escopo desta v1

Registrado para não voltar como surpresa: Farmácia Popular, PBM, manipulação
(RDC 67/2007), delivery/e-commerce sob RDC 44/2009, serviços farmacêuticos,
curva ABC e ruptura. Serialização/SNCM **não entra nunca** — foi revogada pela
RDC 886/2024.

---

## Riscos e pendências

1. **SEFAZ-PA (bloqueia o fechamento da F1 e da F3).** Alíquota efetiva de
   medicamento no Pará — a geral é 19%, mas medicamento costuma ter tratamento
   próprio —, MVAs do Convênio 76/94 no RICMS-PA e eventual redução de base.
   Define qual coluna de PMC vale e como o `fiscal-tributacao.js` fecha o
   ICMS-ST. É pergunta para o contador.
2. **Regime tributário do CNPJ piloto** (Simples ou normal): muda CST/CSOSN e o
   tratamento do PIS/COFINS monofásico derivado da lista CMED.
3. **Credenciamento do RT no SNGPC** (bloqueia a F5): o acesso é exclusivo e
   intransferível do farmacêutico responsável. Sem RT credenciado não há nem
   homologação.
4. **`labfiscal` não é farmácia de verdade.** Serve para tudo até a F5; a
   transmissão real ao SNGPC exige um CNPJ de farmácia com licença sanitária.
5. **A árvore é produção.** Teste de NFC-e só em `tpAmb=2`, nunca na porta de
   produção. Todo `.js` da raiz e de `farmacia/` só entra em vigor no restart do
   `consulta-licitacoes.service`; o que está em `public/` vai ao ar ao salvar —
   por isso as telas novas nascem atrás da flag `farmacia_enabled`, desligada em
   todo tenant que não seja o `labfiscal`.

---

## Execução — o que foi construído e o que a validação encontrou

Implementado em 2026-08-26, no tenant `labfiscal`. 362 asserts em
`scripts/test-farmacia-f0.js` … `f6.js`, todos verdes.

### Defeitos encontrados por teste e corrigidos

**1. A coluna TARJA da CMED não é confiável — e tratá-la como confiável
liberava controlado sem receita.** Na lista de 11/08/2026, 4.692 das 26.001
linhas trazem `"- (*)"`, que significa "sem informação", não "venda livre". O
importador mapeava isso para `livre`. Das 4.692, **58 são de substâncias que a
própria CMED marca como Tarja Preta em outras linhas** — entrariam no sistema
como venda livre e escapariam da exigência de receita. Corrigido: `"- (*)"`
vira `null`, e o importador infere a tarja pela substância, sempre a mais
restritiva observada (recupera 3.807 das 4.692; 885 ficam para curadoria). A
coluna `tarjaOrigem` (`cmed` / `inferida` / `manual` / `desconhecida`) diz de
onde veio cada tarja, e curadoria manual resiste à reimportação.

**2. Corrida entre conferir a receita e gravar o consumo.** A conferência
acontecia antes de dois `await` de rede (assinar o XML, enviar à SEFAZ) e a
gravação só depois deles. Duas vendas simultâneas da mesma receita passavam as
duas — dispensação de controlado acima do prescrito. Corrigido com reserva
atômica: `reservarDispensacao()` confere e reserva dentro de um
`db.transaction()` síncrono, antes dos awaits; a nota autorizada confirma, a
rejeitada ou o erro de rede liberam. Achado pelo agente validador.

**3. A trava de PMC olhava só o preço unitário.** A emissão monta o `vProd` do
XML a partir de `valorTotal` quando ele vem preenchido, sem exigir coerência
com quantidade × unitário. Item com unitário dentro do teto e total inflado
passava — o teto virava decoração. Corrigido: a conferência usa o preço
efetivo (`valorTotal / quantidade`). Achado pelo agente validador.

**4. `registrarEntrada` e `registrarPerda` existiam mas ninguém as chamava.**
Só a venda alimentava a fila do SNGPC. A movimentação mensal sairia
estruturalmente incompleta — entrava estoque sem nunca aparecer entrada, e
nenhuma baixa por vencimento era escriturada. Corrigido: ligadas à rota de
movimentação de estoque (`POST /api/estoque/movimentacoes`), que é onde a
farmácia dá entrada em compra e baixa lote vencido — e é o ponto que já tem o
lote em mãos, sem o qual a ANVISA não aceita a movimentação. Achado pelo agente
validador.

### O que NÃO está pronto (declarado, não escondido)

1. **XML do SNGPC não foi validado contra os XSDs oficiais.** Eles ficam em
   `http://sngpc.anvisa.gov.br/schema/` e o host recusa download automatizado
   (Cloudflare). O XML segue o "Guia de Geração do XML – SNGPC Versão 2" da
   ANVISA — nomes de elemento, domínios enumerados e agrupamento saíram de lá —
   mas "conforme o guia" não é "aprovado pelo schema".
2. **A transmissão real ao SNGPC nunca rodou.** Exige e-mail e senha do RT
   Transmissor credenciado. O que está testado é o envelope: zip → base64 →
   MD5 do base64 → envelope SOAP, conforme o Manual do Desenvolvedor 2.0.1.
3. **A NF-e de entrada não captura lote, e por isso não alimenta o SNGPC.**
   `nfe-entrada-routes.js:1148` grava a movimentação sem `loteId`. Para a
   farmácia, o recebimento de controlado precisa entrar pela tela de
   movimentação de estoque, informando o lote. Fazer a NF-e de entrada capturar
   lote é trabalho próprio (schema + tela) e não foi feito.
4. **A lista de antimicrobianos é parcial.** São 42 substâncias das mais
   dispensadas, não o Anexo I completo da RDC 20/2011 — a CMED não publica essa
   informação. O flag é editável no cadastro, e o Anexo I precisa ser carregado
   inteiro antes de o SNGPC ir a produção.
5. **A enumeração `tipoDocumento` do comprador não estava no guia v2** (é tipo
   antigo, num anexo que o guia só referencia). O default adotado é 1.
6. **Nada disso está em vigor.** Os `.js` da raiz e de `farmacia/` só passam a
   valer no restart do `consulta-licitacoes.service`.

## Ordem de execução

```
F0 fundação  →  F1 cadastro/CMED  →  F2 lote+FEFO  →  F3 med+rastro
                                                        ↓
                             F6 balcão  ←  F5 SNGPC  ←  F4 receita/344
```

F1 e F2 são independentes entre si e podem andar em paralelo. F3 precisa das
duas. F4 é pré-requisito de dado da F5 (a saída escriturada é a venda com
receita). F6 depende só da F1 e pode ser antecipada se a demanda for demonstrar
o produto antes de estar fiscalmente completo.
