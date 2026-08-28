# Changelog

Um bloco por "fechamento" (ver CLAUDE.md). Mais recente no topo, data
AAAA-MM-DD. Registra o que mudou em produção — que aqui é esta própria
working tree.

## 2026-08-28

Nasceu um módulo de **Produção** (ordem de produção para manufatura discreta) e,
no mesmo dia, foi generalizado: começou como vertical de pré-moldados de
concreto para um prospect e terminou como núcleo neutro de segmento, com o
concreto virando um perfil de indústria.

**O núcleo não sabe o que é concreto.** Sabe ficha técnica com perda e
sub-ficha (BOM multinível), ordem de produção com ficha congelada na liberação,
agenda do recurso que satura, apontamento por equipe, ensaio que trava a saída
do recurso, unidade identificada, estoque de acabados, romaneio e medição de
projeto. O que muda entre fábricas vem de cadastro: as etapas (`prod_etapas`),
os tipos de ensaio (`prod_ensaio_tipos`), a unidade do indicador
(`prod_fichas.unidadeBase`) e o vocabulário das telas (`producao/perfis.js`,
servido em `/api/producao/vocabulario` e aplicado por `data-vocab`). Dois
perfis: `generico` e `premoldados`. Nenhuma tela é duplicada por segmento.

- **A trava que dá identidade ao módulo**: quando a ficha exige liberação por
  ensaio, a unidade só sai do recurso depois que uma medição atinge o limite —
  no concreto é o fck de transferência antes de cortar a cordoalha; numa
  fábrica de tintas seria a viscosidade. O limite é **congelado na ordem**
  quando o processo inicia, porque editar o cadastro depois rebaixaria a
  exigência de uma unidade que já está no recurso. O bypass exige config +
  `forcar` + justificativa, grava evento nominal e é contado no painel.
- **`prod_fichas.exigeIdentificacao` é derivado, não configurável**: vale 1 em
  modo `projeto` ou com liberação por ensaio. É o elo unidade ↔ lote ↔ ensaio;
  como opção de tela, alguém a desligaria na primeira semana apertada. `modo` e
  liberação por ensaio também não mudam com ordem em andamento.
- **O indicador de produtividade divide pelo PONTO, não pelo apontamento**: se
  a equipe esteve 8h presente e apontou 5h, as 3h de espera são custo e entram
  no denominador. Sem RH instalado (dois tenants não têm as tabelas), cai no
  apontamento e **avisa** em vez de devolver 500. O refugo vem na mesma linha:
  produzir muito e quebrar não é produtividade.
- **A baixa de estoque grava `data` como data pura**, igual ao resto do core.
  `estoque-routes.calcularCustoMedio` elege o custo vigente com
  `ORDER BY data DESC`; uma linha com hora venceria a mais recente e o erro
  seria materializado na movimentação seguinte, contaminando CMV e margem de
  qualquer produto do tenant.

Registro nos oito pontos do core (`db-schema`, `route-registry`, `plan-modules`,
`module-gate`, `features-routes`, `perfis-api-map`, `menu-config` e o catálogo
`FEATURES` do `control-plane-routes`). Flag `producao_enabled` nasce desligada
em todos os 13 tenants; o schema e o seed do perfil genérico rodam no boot.

**413 asserções** em cinco suítes contra banco descartável em `/tmp`
(`scripts/test-producao-f0` a `f2`, `-telas`, `-sem-rh`). Duas rodadas de
auditoria por agente encontraram 29 problemas, todos corrigidos com regressão —
entre eles três críticos: reclassificar a ficha contornava a trava do ensaio, a
trava confiava num flag persistido em vez de comparar ao vivo, e a baixa de
estoque envenenava o custo médio.

- **Duas descobertas que valem para o repo inteiro**: `npm run verify` roda
  `node --check` só na raiz e em `scripts/` — **subdiretório não entra**, o que
  também deixa `locacao/`, `farmacia/`, `posto/` e `restaurante/` sem cobertura
  de sintaxe; e testar comportamento não prova fiação (as 344 asserções verdes
  do dia anterior conviviam com o módulo ausente do painel do super-admin,
  porque o `control-plane-routes.js` tem um catálogo próprio de features).
- As 19 tabelas `pmo_*` da versão anterior do módulo foram removidas dos 13
  tenants após conferência de que estavam vazias (0 linhas no total).

**Este commit leva só os arquivos NOVOS do módulo.** O registro nos oito pontos
do core (`db-schema.js`, `route-registry.js`, `plan-modules.js`,
`module-gate.js`, `features-routes.js`, `perfis-api-map.js`, `menu-config.js`,
`control-plane-routes.js`) segue **pendente**, junto da frente core/infra: os
dois primeiros já requerem, na árvore, os módulos `farmacia/`, `locacao/`,
`posto/` e `restaurante/`, que continuam fora do git. Commitá-los agora
deixaria o HEAD sem bootar — o mesmo erro que quebrou o histórico entre b2bacdb
e e094c43. Produção não é afetada: ela roda desta árvore, onde o registro está
aplicado e o serviço já foi reiniciado.

## 2026-08-27

Duas correções sem relação entre si: os botões de ação do card de licitação, que
estavam ilegíveis, e o provisionamento de tenant, que subia o vhost em laço de
proxy.

**As cores dos botões vinham de um tema que não existe mais.** Na consulta de
licitações, "Não tenho interesse" era rosa claro sobre rosa claro, "Ver Itens"
amarelo sobre amarelo e "Análise IA" quase preto sobre azul-marinho. A causa não
estava na tela: o bloco "Botões legacy padronizados" do `app-modern.css` fixava
`#fca5a5`, `#fbbf24`, `#0b1120` com `!important` — valores escolhidos para a
paleta escura do `:root`. Só que o tema real é **injetado inline no `<html>`**
pelo white-label do tenant e é claro, então cada uma dessas cores caiu sobre um
fundo da mesma família. Nenhum `!important` na página venceria isso; a correção
foi trocar valor fixo por token (`--danger-soft` + `--danger`, `--warn-soft` +
`--warn`, `--accent-strong` + branco, `--success-soft` + `--success`), que é o
par que o resto do arquivo já usa nos badges. Alcança também `.btn-remover` e
`.btn-excluir-todos`, que dividiam a mesma declaração e estavam igualmente
ilegíveis em outras telas.

- **Os cinco botões tinham cinco geometrias**: padding 6×12, 8×14, 8×15 e 8×20,
  raio 4, 5 e 6px, fonte 12 e 13px, e `margin-right` avulso no lugar de um
  contêiner. Agora herdam uma base única em `consulta.html` e a barra é um
  `.card-acoes` flex com `gap` e `flex-wrap`
- **`min-height: 34px`** porque só alguns recebem ícone Lucide, e o svg deixava
  esses 2px mais altos que os demais
- Conferido no ar, no tenant `1bit`: os cinco medem 34px e o mesmo `top`

**Tenant novo subia com o nginx em laço de proxy.** O `crsolucoes` foi criado e
respondia **400 "Request Header Or Cookie Too Large"** — sem cookie nenhum na
requisição. Desde que o upgrade 1.10.2 do Hestia ligou `PROXY_SYSTEM='nginx'`
(15/08, o mesmo que derrubou 27 domínios), todo domínio novo nasce com proxy
template `default`, que faz `proxy_pass https://<ip>:443`: o vhost devolve a
requisição ao próprio nginx, o `X-Forwarded-For` cresce a cada volta e o buffer
estoura. Reproduzido ao vivo num vhost descartável — logo após
`v-add-web-domain`, `PROXY: default` e `proxy_pass http://217.216.85.37:80`.

- **O `provision-tenant-vhost.sh` trocava só o template web.** O
  `v-change-web-domain-tpl` conserta o `nginx.conf` (HTTP), mas o
  `nginx.ssl.conf` é gerado pelo template de **proxy** — e com `SSL_FORCE` ligado
  é ele que atende tudo. Daí o tenant ter SSL válido e mesmo assim só devolver
  400. Passo 4b novo: remove o proxy herdado e **rebuilda** (o delete sozinho
  apaga o vhost, como já constava do incidente de agosto)
- **O script gravava `READY` no control.db com o vhost quebrado.** Passo 8 novo
  verifica se o `nginx.ssl.conf` encaminha para `127.0.0.1:3000` e sai `FAILED`
  em vez de declarar sucesso
- **A idempotência escondia o estrago**: o early-exit olhava só o SSL, então
  reprovisionar um tenant nesse estado não consertava nada. Agora exige também
  proxy vazio
- `crsolucoes` no ar (302 → `/login.html`), com `nginx.conf` e `nginx.ssl.conf`
  idênticos aos de um tenant saudável. Varridos os 18 vhosts `*.liciteagora.app`:
  nenhum outro em laço

## 2026-08-26

Devolução de venda como espelho da nota de origem, e a listagem de notas fiscais
no padrão de grid das demais telas. A referência da devolução foi o wizard
`lifdoctofiscaldevolucaowizard` do Solution ERP da Raízes Agrícola (9 etapas),
lido para entender o modelo — sem reproduzir o wizard inteiro.

**O espelho passou a valer nos dois sentidos.** A devolução de compra já era
espelho de verdade: lê o XML da entrada, reproduz item a item o que o fornecedor
destacou, controla saldo e emite com `finNFe=4` + `refNFe`. A de venda emitia
nota, mas **recalculava** o imposto pelo pipeline normal, partia do RMA/pedido em
vez da nota, exigia pedido de origem e não tratava frete nem desconto. O motor
comum saiu para `espelho-fiscal.js` (parse dos `<det>`, rateio proporcional,
condicionais de ICMS/ST e IPI, grupo IBS/CBS quando existe), parametrizado pela
chave do item de origem e pelo CSOSN; `devolucao-compra.js` passou a consumi-lo e
`devolucao-venda.js` nasceu em cima dele.

- **`GET /api/faturas/:id/devolucao/preview`** e **`POST /api/faturas/:id/devolucao`**:
  seleção item a item, saldo por linha da nota, avisos (CFOP fora do mapa, cliente
  contribuinte, item sem produto) e emissão como nota de **entrada** (tpNF=0,
  finNFe=4, refNFe da venda)
- **O CFOP de devolução não precisou de tabela nova**: `cfops.cfopContrapartida`
  já declarava 1202→5102, 2202→6102, 1411→5403 — consultar pelo lado da
  contrapartida devolve o CFOP de entrada, e o prefixo 1/2 vem junto porque o
  CFOP de saída já distingue interno de interestadual
- **O espelho gera o RMA, não um caminho paralelo.** `criarDevolucao` e
  `efetivarDevolucao` viraram funções exportadas de `devolucoes-routes.js` (os
  handlers HTTP são cascas finas sobre elas) e o módulo novo as chama: estoque
  com o custo da saída original, crédito em CR negativo e estorno de comissão
  continuam saindo de um lugar só. Com `faturaOrigemId`/`faturaItemOrigemId`, o
  saldo enxerga RMA manual e devolução espelho na mesma conta — devolver a mesma
  peça duas vezes é recusado, venha de onde vier
- **`vDesc` era zerado nos totais do espelho de compra** — entrada com desconto
  gerava devolução valendo mais do que o fornecedor cobrou. Agora o desconto é
  sempre espelhado (proporcional) e o frete virou opção, padrão não devolver.
  O `<prod>` do emissor ganhou `vDesc` por item, que a SEFAZ valida contra o total
- **IBS/CBS na devolução**: espelha o grupo quando a nota de origem tem; quando é
  pré-reforma e `nfe_config.ibsCbsAtivo` está ligado, sai com o cClassTrib de
  devolução (`nfe_config.cClassTribDevolucao`, padrão 410031). **O 410031 veio do
  aviso na tela do Solution, não de uma NT conferida — confirmar com o contador.**
  Limitação herdada da compra: o espelho só monta o grupo ICMS do Simples (CSOSN);
  emitente em regime normal é recusado com mensagem, em vez de gerar nota errada

Duas portas de entrada, uma implementação: botão "↩ Devolução do cliente" na tela
da NF-e de saída e "↩ Devolver uma nota fiscal" na tela de Devoluções, que busca a
nota e cai no mesmo modal via `?devolucao=1`.

**Notas Fiscais: grid no padrão de `comercial/pessoas.html`.** Colunas declaradas
em JS com seletor de colunas persistido, cabeçalho que ordena, larguras
arrastáveis pelo `/js/grid.js` e contador de registros. A coluna "Ações ▾" saiu —
cada linha tem só o lápis, que abre o detalhe, e as ações foram para onde o
documento mora: DANFE, observação interna e excluir/restaurar lançamento na tela
da NF-e de entrada; observação interna e restaurar na de saída; DANFSE, edição,
reemissão e cancelamento no modal da NFS-e. A NFC-e não tinha detalhe nenhum e
ganhou um modal (dados, itens, pagamento) com baixar XML e cancelar.

Testes: `scripts/test-espelho-fiscal.js` (15) trava o motor — parse, rateio,
condicionais e as opções de frete/desconto; `scripts/test-devolucao-venda-espelho.js`
(17) roda o fluxo inteiro em banco descartável com a emissão stubada, incluindo a
trava contra dupla devolução.

Fica pendente: `data/tenants/labfiscal/pncp.db` é `root:root` e o serviço web roda
como `carlosfinezi` — o boot registra `attempt to write a readonly database` e
esse tenant não recebeu as colunas novas (nem as da devolução de compra, pelo
mesmo motivo).

## 2026-08-25

Emissão manual de NF-e e o módulo fiscal fora do Simples Nacional. A referência
foi o Solution ERP da JA Agrícola (pré-nota, rotina 1017 de Tributações ICMS,
simulador 2850), lido tela a tela para entender o modelo antes de desenhar o
nosso.

**O motor de tributação por regime.** Até aqui o `emitirNFe` montava imposto
assumindo Simples: CSOSN do cadastro do produto e PIS/COFINS zerados — correto
para Simples, e é por isso que a ausência de configuração nunca doeu nos três
tenants que emitem. Não atendia Lucro Real/Presumido, que precisa de CST de dois
dígitos, base, alíquota e redução. `fiscal-tributacao.js` resolve a tributação
por contexto a partir de `fiscal_regras_trib` (operação × CFOP × NCM por prefixo
× produto × UF × âmbito × perfil do destinatário × regime), com override manual
por item e memória de cálculo persistida — o equivalente da aba Auditoria do
Solution. O caso-verdade usado em todos os testes é a pré-nota 197 deles: CST 20,
alíquota 12, redução 78,95 sobre R$ 1,00, que dá base 0,21 e ICMS **0,03** — o
mesmo centavo.

- **`CRT` era fixo em `'1'`** — toda nota declarava Simples Nacional, de qualquer
  tenant. Agora vem de `fornecedor.regimeTributario`, a mesma fonte que a entrada
  de NF-e e a NFS-e já liam. Sem regime gravado devolve 1, então quem já emitia
  emite igual: os 323 itens reais das faturas autorizadas dos tenants do Simples
  foram medidos e **nenhum muda de caminho**
- **Dois bugs encontrados pela validação XSD.** O `pRedBC` vem antes do `vBC` no
  `ICMS20` e a lib serializa na ordem das chaves; e `tagProdIPI` do node-sped-nfe
  faz `obj[key] == 0 ? "0.00"` em todas as chaves — como `'00' == 0` é `true` em
  JS, o CST 00 de IPI virava `0.00` e a SEFAZ rejeita. Contornado em
  `corrigirCstIpiZero`, no mesmo ponto onde o `<cobr>` já é injetado

**NF-e manual com rascunho** (`nf-avulsa-routes.js`, `nova-nota.html`). O
documento é uma `faturas` com `pedidoId` NULL e `origemDocumento='avulsa'` —
mesmo padrão da devolução de compra, que já emitia sem pedido. Rascunho editável
(`status='rascunho'`), prévia de impostos antes de transmitir, e os efeitos que o
Tipo de Operação pedir: contas a receber quando `geraFinanceiro=1`, baixa de
estoque quando `movimentaEstoque=1`. A flag `usarEmNFAvulsa` de `tipos_operacao`,
provisionada em 21/08 e sem consumidor desde então, finalmente tem uso.

- **`faturas.pedidoId` era NOT NULL em 10 dos 11 tenants.** O rebuild existia em
  `devolucao-compra.js`, mas chamado *dentro da rota* de devolução de compra — só
  migrava quem usasse a função. Passou para o schema, via `fiscal-trib-schema.js`
- **Não existe emissão retroativa** e o código não sabia disso: a regra era
  resolvida por `fatura.dataEmissao` enquanto o XML levava `dhEmi` = agora. Nas
  notas históricas as datas sempre coincidiram, mas o rascunho cria a divergência.
  A emissão resolve por hoje, e o rascunho passa a ser carimbado com a data real
  ao ser emitido

**Matriz de regras cadastrável** (`fiscal-regras-routes.js`,
`regras-tributarias.html`). CRUD com validações que recusam regra que só falharia
na emissão (regime normal sem CST, MVA sem alíquota de ST, CST e CSOSN juntos), e
um **simulador** que responde qual regra vence, *por que* vence — o ranking de
candidatas com a especificidade de cada uma — e que imposto sai. Regra já usada
em nota emitida é desativada, nunca apagada: a memória de cálculo aponta para
ela.

**Camada 3 — refinos na emissão.** Vigência nas regras (serve para agendar a
virada de alíquota e aposentar regra sozinha, não para emitir retroativo);
`cBenef`, que fica no grupo `<prod>` e não dentro do ICMS; **CEST**, que existia
em `produtos.cest` e nunca ia para o XML; e **DIFAL** completo (`ICMSUFDest`, FCP
do destino, partilha de 100% ao destino). A tabela `fiscal_aliquotas_uf` nasce
com as 27 UFs **vazias de propósito**: alíquota interna errada produz imposto
errado numa nota autorizada, então sem o valor cadastrado o DIFAL não é calculado
e a emissão diz qual estado falta.

**Camada 1 — os livros de apuração.** Três livros com a mesma mecânica de
competência, ajustes, fechamento e transporte de saldo, mas com a regra de
crédito de cada imposto:

- **ICMS** (`fiscal-apuracao-icms.js`) — o crédito vem do CFOP, não do valor
  destacado: uso e consumo e mercadoria com ST vêm com ICMS na nota e não
  creditam. ST e DIFAL ficam fora da conta principal (guia própria)
- **PIS/COFINS** (`fiscal-apuracao-piscofins.js`) — dois regimes que produzem
  contas incompatíveis. No cumulativo **não há crédito nenhum**; a mesma massa de
  documentos dá PIS a recolher de 1.250 no não-cumulativo e 1.650 no cumulativo.
  `cfops.geraCreditoPisCofins` nasce copiada da flag do ICMS como ponto de
  partida, e o diagnóstico cobra a revisão enquanto ninguém mexer nela
- **IPI** (`fiscal-apuracao-ipi.js`) — só indústria apura, e **compra para
  revenda não credita**: só insumo de industrialização. `geraCreditoIpi` tem seed
  próprio e explícito, porque copiar a do ICMS marcaria revenda como creditável

Os três exigem que a competência anterior esteja fechada para transportar saldo,
recusam ajuste em competência fechada, e acusam quando um documento do período
muda depois do fechamento.

**Diagnóstico fiscal por tenant** (`fiscal-diagnostico-routes.js`,
`diagnostico.html`). Seis blocos — identidade fiscal, produtos, CFOP/operações,
matriz, documentos e apuração — com severidade, contagem, exemplos nominais e
link para a tela que resolve. O que ele cobra **depende do regime**: para Simples
a matriz não é exigida. O achado mais útil não é "cadastre regras", é listar as
combinações concretas de produto × UF de destino que ficariam sem resposta.

Estado levantado nos 12 tenants: **8 estão sem regime tributário informado** e
por isso emitem declarando CRT 1 — certo por acaso para quem é do Simples. Nenhum
produto de nenhum tenant tem CST de PIS/COFINS preenchido, o que nunca doeu
porque no Simples esse campo sai zerado de qualquer forma.

**Testes.** 11 suítes, 446 asserts, rodadas em ordem direta e inversa (a inversa
é o que prova que nenhuma suíte depende da massa deixada por outra — pegou
interferência duas vezes). Cobrem regressão contra os 323 itens reais de
produção, validação XSD com `xmllint`, e as telas em Chrome headless, que é o
buraco que o `npm run verify` não alcança. Tenant `labfiscal` criado como
laboratório (`scripts/create-tenant-labfiscal.js`).

**Levado junto por fecho de requires:** `feature-gate.js` (untracked, de outra
frente) — o `route-registry.js` desta frente registra `registrarFeatureGates` e
sem o módulo o HEAD não bootaria. `perfis-api-map.js` é gerado por
`scripts/gerar-mapa-api.js` e vai inteiro; `public/js/menu-config.js` carrega
itens de outras frentes além dos seis fiscais adicionados aqui.

## 2026-08-25

Comparação da nossa tela de Tipos de OS com o cadastro equivalente do Solution
ERP (Oficina › Tipo de Ordem de Serviço, 83 campos em 4 abas contra os nossos
11). O tipo lá é o motor de comportamento da OS inteira; aqui era taxonomia com
três checkboxes. Quatro frentes saíram daí, todas com default que preserva o
comportamento anterior.

- **`checklistPadrao` era um campo morto — bug, não feature.** A coluna existia
  em `os_tipos`, o seed populava os 4 tipos padrão e quatro pontos do código a
  **liam** (`os-routes`, `crm-routes`, `scheduler`, `nova-os.html`), mas o
  INSERT e o UPDATE de `/api/os-tipos` não a listavam. Todo tipo criado pela tela
  nascia com checklist vazio para sempre, e não havia como editar o dos
  seedados. Gravação corrigida (normaliza: trima, descarta item sem descrição,
  renumera `ordem`, recusa JSON malformado) e editor de itens no formulário
- **O tipo passou a ditar comportamento da OS.** `natureza` (9 valores — as duas
  de garantia abrem a OS com `emGarantia=1`), `localPrestacao` (`externo` exige
  endereço, como `exigeEnderecoExec`), `bloqueiaFaturamento` (tipo que não
  fatura: consumo interno, retrabalho) e `obrigarDataPrevista` (recusa OS sem
  data de promessa, própria ou derivada do SLA)
- **Deslocamento virou dinheiro.** `kmPercorrido` e `valorDeslocamento` existiam
  em `os_ordens` desde sempre, mas eram digitados à mão e **não entravam em
  total nenhum** — a própria tela mandava "lance-o como um serviço na aba
  Serviços". Agora o tipo define a regra (`manual` / `nao-cobrar` / `por-km` /
  `valor-fixo`) e o sistema mantém a linha em `os_itens_servicos` com
  `origem='deslocamento'`: entra no total, na NFS-e e na conta a receber pelo
  mesmo caminho de qualquer serviço. Recalculada a cada salvamento do km, some
  quando o km zera, e **garantia nunca cobra deslocamento** qualquer que seja a
  regra. A linha é protegida de edição/remoção manual — voltaria no próximo
  recálculo. `origem` é NULL nas linhas lançadas à mão, que seguem intocadas
- **Regras de encerramento (Encerramento da OS, do Solution).** Cinco
  pendências, cada uma com os níveis que fazem sentido para ela: peça e serviço
  orçados aceitam `permitido` / `venda-perdida` / `bloqueado`; item de terceiro
  sem custo, km não informado (só quando o tipo cobra por km) e apontamento em
  aberto aceitam `permitido` / `bloqueado`. `venda-perdida` grava em
  `vendas_perdidas` com `motivo='desistencia'` e `origem='os_item'`, entrando no
  relatório e na sugestão de compras. As cinco categorias são levantadas antes
  de agir: um 400 lista tudo que falta de uma vez. Bloqueio vence perda — numa
  conclusão recusada nada é gravado
- **Cálculo do serviço pelo tipo.** `livre` (precedência histórica),
  `preco-fixo` (catálogo), `horas-x-valor` e `tempo-padrao` — este último trouxe
  `servicos.tempoPadraoHoras`. Nos modos calculados, horas e valor hora usados
  ficam gravados na linha, senão ninguém saberia de onde o preço saiu.
  `permiteAlterarCalculoServico=0` **recusa** um valor digitado, em vez de
  ignorá-lo em silêncio
- **Faturar contra quem não é o cliente** (garantia de fábrica, sinistro de
  seguradora). O Solution guarda a conta de faturamento no próprio tipo; aqui
  não serviria, porque cada sinistro tem sua seguradora. Dividido: o tipo diz a
  categoria (`faturarPara`: cliente / fabrica / seguradora / outro) e a OS diz
  quem é (`os_ordens.pagadorId`). O pagador passa a valer em cinco lugares —
  `pedidos.clienteId`, `contas_a_receber.pessoaId`, `faturas.clienteId`, tomador
  da NFS-e — mais política de prazo e meios aceitos. **Sem pagador informado a
  OS não fatura**: emitir contra o cliente seria cobrar de quem não deve. O
  `clienteId` da OS não muda, e o histórico do equipamento fica intacto
- **Fora de propósito, do bloco Faturamento do Solution:** "impedir faturamento
  parcial" (o nosso já é tudo-ou-nada), "geração de provisão" (não temos
  provisão contábil) e o tipo de garantia A/C/D/H/I/J/S/Z (taxonomia da
  CNH/CASE). Também ficaram fora as "Configurações de Uso" (8 selects sobre
  misturar tipos entre capa e item) e segregação contábil / centro de custo —
  complexidade de concessionária multi-filial
- **Tipos de OS e Tipos de Operação saíram do modal para o padrão do
  `pessoas.html`**: abas Lista / Cadastro na própria página, header de
  formulário com Status e ações à direita, e sub-abas agrupando os campos (em
  Tipos de OS: Geral · Precificação · Faturamento · Exigências · Encerramento ·
  Checklist, o agrupamento do Solution). Validação que falha salta para a
  sub-aba do problema — senão o alerta apontaria campo fora de vista
- Na conversão de Tipos de Operação caíram dois defeitos: tipo desativado sumia
  da tela sem forma de reativá-lo (o GET sem query devolve só ativos — agora há
  filtro Ativos/Inativos/Todos), e a lista montava `onclick='editar(<json>)'`
  com o objeto inteiro no atributo, que uma aspa na descrição quebrava
- Migrações espelhadas em `db-schema.js` e no `migrarDB` do `os-routes.js`, pelo
  mesmo motivo da nota de 24/08: só o `db-schema` alcança tenant existente, e o
  `migrarDB` cobre o tenant que ainda não tem as tabelas de OS
- Validado por 313 testes em 7 suítes (banco descartável em `/tmp`, porta alta,
  e Chrome headless com perfil próprio para as telas). A ferramenta não vai para
  o repo, mas a receita está descrita no fim deste bloco

Nota para quem for testar de novo: `initSchema` **não é auto-suficiente em banco
vazio** — pressupõe tabelas que nascem no registro de outros módulos
(`contas_financeiras`, `reservas_estoque` antes dela ganhar `osId`). E página em
`public/` só roda dentro de iframe: o `sidebar.js` redireciona carga top-level
para `/app.html#…`.

## 2026-08-24

- **Cadastro de filial ganhou a busca de CNPJ que só existia em Minha Empresa.**
  Em Estabelecimentos › Nova filial o CNPJ era digitado e todo o resto ia à mão.
  Agora tem o botão 🔎 Buscar (mesma BrasilAPI + `publica.cnpj.ws` para a IE),
  máscara e auto-busca ao sair do campo. O CNPJ passou para a posição da Razão
  Social, que é preenchida por ele. Registro já gravado não é sobrescrito pela
  auto-busca: ao abrir uma filial existente o CNPJ entra como "já buscado"
- **Logradouro pelo CEP quando a Receita não informa** (Estabelecimentos e Minha
  Empresa). MEI e empresário individual costumam vir sem logradouro, número,
  telefone e e-mail — o caso real foi `63.523.205/0001-71`, que devolve só
  bairro/município/UF/CEP. O CEP recupera a rua; número e complemento seguem
  manuais. Só preenche campo vazio
- **Aviso do que ficou em branco**, em vez do silêncio: uma linha sob o CNPJ
  lista o que nenhuma base pública trouxe. Roda depois da consulta de IE, para
  não acusar campo que a segunda API acabou de preencher
- **Tipo de Operação agora declara em que módulo pode ser escolhido.** O select
  do pedido listava os três `OS-*` (Ordem de Serviço), que não têm CFOP: quem
  escolhesse um e aceitasse o "re-sugerir CFOP" deixava os itens sem CFOP e
  quebrava a NF-e depois. Quatro flags novas em `tipos_operacao` —
  `usarEmPedido`, `usarEmOS`, `usarEmDevolucao`, `usarEmNFAvulsa` — editáveis no
  cadastro (bloco "Disponível em", e as letras `P O D A` na listagem).
  `GET /api/tipos-operacao` aceita `?usoPedido=1` e afins; `?categoria=` segue
  valendo. Pedido, Devoluções e Tipos de OS passaram a filtrar pela flag. No
  pedido: de 13 opções para 7
- O valor inicial da flag sai da categoria e **só preenche NULL** — o que o
  usuário desmarcar no cadastro sobrevive aos boots seguintes. A migração está
  espelhada em `db-schema.js` porque o `migrar()` dos módulos de rota é no-op em
  multi-tenant (roda contra o BOOT_STUB; só vale no provision). Sem o espelho,
  nenhum tenant existente ganhava as colunas
- **Ordens de Serviço: KPIs compactos e seleção de colunas.** Eram 9 KPIs no
  tamanho global ocupando duas faixas e empurrando a tabela para fora da
  primeira dobra, mais 12 colunas que exigiam rolagem horizontal. Os KPIs viram
  uma faixa compacta (CSS page-local, o `.kpi` global não foi tocado) e a tabela
  ganhou o botão **Colunas** com preferência em `localStorage['os_colunas']`.
  Padrão: 7 visíveis (Equipamento, Prazo e Aberta ficam opcionais). Removida a
  coluna vazia do fim, que ocupava largura sem mostrar nada e disputava chave
  com a do lápis no `grid.js`
- **O botão "Colunas" de Pedidos nunca funcionou:** o `onclick` chamava
  `toggleColunasMenu`, que não existe em `pedidos.html` (só `salvarColunas`
  estava lá). Clicar dava `ReferenceError`. Com as duas funções que faltavam, as
  15 colunas já declaradas ficam acessíveis — entre elas `Operação`,
  `Entrega prev.`, `Fat. previsto`, `Cód. cliente`, `Pago`, `Fatura` e
  `Meio pgto`, todas `default:false` e portanto nunca vistas por ninguém
- **PDF de Contas a Receber escrevia uma linha por cima da outra.** O texto da
  célula quebrava em várias linhas e o avanço vertical era fixo (`y += 13`).
  `Cliente` recebia até 40 caracteres numa coluna de 130pt com fonte 8 (precisa
  de ~176pt): medido em 40 contas reais, **17 transbordavam**. `height+ellipsis`
  em toda célula de texto, `lineBreak:false` nas numéricas. Os cortes de página
  também estouravam a margem inferior (linha em `y=560` terminava em 573, limite
  565) — agora 545 para as linhas e 500 para o bloco de totais
- **Contas a Pagar ganhou PDF** (`GET /api/contas-a-pagar/pdf`), espelho do de
  receber, registrado antes de `/:id` para o Express não casar `:id = 'pdf'`.
  Sem coluna "Com atraso" de propósito: ela usa a config de juros do tenant, que
  é o que a empresa **cobra** dos clientes — projetar isso sobre o que ela deve
  inventaria encargo que quem arbitra é o credor
- **O CSV de Contas a Pagar ignorava os filtros da tela.** O front mandava
  status, categoria, origem, período e busca na query string e a rota nunca lia
  `req.query` — exportava sempre tudo. Passa a aplicar o mesmo recorte do GET
  principal e do PDF

## 2026-08-20

- **O split do Asaas saiu do env e virou configuração no painel admin.** A taxa
  da plataforma era três variáveis na unit systemd (`ASAAS_PLATFORM_WALLET_ID`,
  `ASAAS_PLATFORM_FEE_PERCENT`, `ASAAS_PLATFORM_TENANT_SLUG`), só ajustáveis por
  quem edita `/etc/systemd/system` e reinicia. Agora vivem no `control.db` e têm
  tela: **admin.liciteagora.app › Split Asaas** (ativo, wallet, percentual) e uma
  coluna **Split** por tenant na aba Tenants, com Padrão / Isento / percentual
  próprio. O env segue como fallback de cada campo enquanto a chave não for
  gravada — nada muda até alguém salvar
- Rotas: `GET/PUT /api/admin/split-asaas` e `PATCH /api/admin/tenants/:slug/split`,
  ambas auditadas (`SET_SPLIT_ASAAS`, `SET_SPLIT_TENANT`)
- Schema do `control.db`: `tenants.split_asaas_modo` e `.split_asaas_percentual`,
  mais a tabela `config` promovida ao `CONTROL_SCHEMA` (só o `auth.js` a criava).
  Migração idempotente grava `isento` no slug que o env isentava, para o painel
  não mostrar como "padrão" um tenant que o env isenta
- **Teto de R$ 2,00 de split por boleto.** A tarifa do Asaas por boleto emitido
  já é alta e o split crescia junto com o valor do título; acima do teto ele
  deixa de ser percentual e vira `fixedValue`. Com 0,5%, morde a partir de
  R$ 400,00. Vale só para boleto — o PIX não tem essa tarifa e segue percentual
  puro. Configurável em **Teto por boleto (R$)**, R$ 2,00 por padrão
- **Baixa de PIX caiu de 30 min para 2 min.** O polling do Asaas era um ciclo
  único de 30 min; para PIX, que o pagador vê sair na hora, isso passa por
  sistema quebrado. Agora são dois: um de 2 min só para PIX das últimas 48h e o
  de 30 min que continua varrendo **tudo** — a sobreposição é de propósito, sem
  ela um PIX pago depois de 48h ficaria sem varredura nenhuma
- O polling gravava `formaPagamento: 'boleto'` fixo: **toda cobrança PIX baixada
  por ele entrava na conciliação como boleto**. Passa a usar o `tipoCobranca`
- **Diagnóstico TEMPORÁRIO no webhook do Asaas** (`boleto-provedores/asaas.js`):
  100% dos eventos com `payment` vêm sendo recusados por token inválido, então a
  baixa da CR depende só do polling — medido hoje, 15min46s entre o pagamento e
  a baixa. O log mostra token recebido/esperado mascarados e os headers
  candidatos, para separar "header ausente" de "tokens divergentes".
  **Remover depois de identificar a causa**
- Painel admin: os campos do formulário fora de modal saíam com o widget nativo
  branco sobre o tema escuro (a regra de `input`/`select` é escopada em
  `.modal-body`); a coluna Split usava um `<select>` nativo que empurrou a tabela
  para além da janela. Formulário ganhou `.panel`, a coluna virou badge com o
  percentual efetivo abrindo modal, e o `main` subiu de 1200 para 1440px — a
  tabela de tenants já estourava os 1200 antes desta coluna

## 2026-08-19

- **Configurações que não eram da empresa saíram de Minha Empresa.** A tela
  acumulava 12 painéis, dois deles alheios ao cadastro do emitente: as chaves de
  IA (credencial de serviço externo, irmã de "E-mail (SMTP)") e a configuração de
  emissão fiscal. Viraram **Configurações › IA · Chaves** (`configuracoes/ia.html`)
  e **Fiscal › Configuração de Emissão** (`fiscal/configuracao.html`)
- A tela fiscal traz **matriz e filiais no mesmo lugar**, que era a divisão real:
  a matriz configurava série/numeração em Minha Empresa e a filial, em
  Estabelecimentos — e a numeração da filial (`estabelecimento_serie`) **não tinha
  interface nenhuma**: a emissão criava a linha com 1/1 e ninguém conseguia
  corrigir uma migração de sistema ou uma nota inutilizada
- Rotas novas: `GET/PUT /api/estabelecimentos/:id/emissao` (série e numeração dos
  modelos 55/65/NFSE e CSC da filial; respeita o escopo de loja do usuário, recusa
  a matriz, e o GET não cria linha) e `PUT /api/nfse/serie-dps` — a série do DPS
  continua em `fornecedor.serieDps` porque é do emitente, mas `POST /api/fornecedor`
  reescreve o cadastro inteiro e a tela de emissão precisa mexer só na série
- `scripts/test-emissao-estabelecimento.js` (14 casos) cobre defaults, CSC que
  nunca sai no GET, branco preserva / `cscLimpar` apaga, matriz recusada, série
  inválida, RBAC de loja e o `serie-dps` sem derrubar razão social e CNPJ
- **Ícones: o sistema falava duas línguas.** O menu lateral traduz emoji para
  Lucide via `EMOJI_TO_LUCIDE`; o que faltava no mapa caía no fallback e aparecia
  como emoji colorido — era o caso de 4 seções (**Portais**, **Contabilidade**,
  Aprovações, Ótica) e 32 itens. O mapa foi completado (139 entradas, cada nome
  validado contra o Lucide 0.475.0 que o sistema carrega: `venus-mars`, que eu ia
  usar em Gêneros, não existe nessa versão e teria virado ícone vazio)
- Os títulos e botões das páginas seguiam com emoji cru. Em vez de reescrever ~280
  arquivos, `sidebar.padronizarIconesDaPagina()` converte em tempo de execução, e
  um `MutationObserver` (uma passada por frame) reconverte o que o JS reescreve —
  sem isso o ícone de um botão duraria até o primeiro clique. 500 botões inseridos
  de uma vez custam ~120ms. Os emojis continuam no HTML: reverter é apagar a chamada
- **Bug encontrado por causa disso**: `bll-proposta.html` e `bnc-proposta.html`
  travavam o reenvio comparando `btn.textContent !== '✅ Enviada'`. Com o ✅ virando
  SVG o texto passaria a ser só "Enviada", a comparação daria sempre verdadeiro e o
  botão seria **reabilitado depois de uma proposta já enviada ao portal**. A trava
  passou a ser `btn.dataset.enviada`
- `.card-info` está definida **duas vezes** em `app-modern.css` — fundo escuro na
  linha 239, e linha de metadados do kanban (`display:flex`) na 850, que vence.
  A página de IA usava a classe contando com a primeira e virou uma linha flex com
  os campos desalinhados. As telas novas não usam mais `.card-info`; o CSS global
  ficou como está porque 20+ páginas dependem da versão kanban
- `.alert:empty` não ocupa mais espaço: o container de mensagens nascia com borda
  e padding, desenhando uma faixa vazia no topo de Minha Empresa e do Log de E-mails
- Minha Empresa foi reorganizada em 4 abas (Cadastro · Representante e Banco ·
  Credenciais · Propostas), com contador de pendência na aba Credenciais — conteúdo
  escondido atrás de aba esconde também o "certificado não configurado"

- **Perfil de acesso virou cadastro.** Até aqui `users.role` tinha cinco valores
  fixos e quase ninguém olhava para eles: fora de `requireRole(['admin'])`, todo
  usuário autenticado enxergava o menu inteiro — o que filtrava a tela era a
  feature flag do tenant, igual para todos os usuários dele. Agora um perfil é
  uma linha em `perfis_acesso` com a lista de páginas que abre, e a tela
  **Configurações › Perfis de Acesso** marca essas páginas por seção do menu
- O catálogo de páginas é lido de `public/js/menu-config.js`, o mesmo arquivo que
  desenha o menu (ganhou um `module.exports` no fim). Página nova no menu aparece
  na tela de perfis sem lista paralela para manter
- **Duas portas, não uma.** `perfis-acesso.js` instala um middleware antes do
  static e do route-registry: nega o `.html` fora do perfil e também o
  `/api/<prefixo>` que a tela negada usaria. Sem a segunda porta, esconder a tela
  seria decoração — bastava saber o endereço do endpoint
- `perfis-api-map.js` (150 prefixos) diz de qual página cada prefixo depende.
  **Fail-closed**: prefixo sem entrada é negado e logado como
  `[RBAC] prefixo sem mapa: /api/xxx`. O arquivo é gerado por
  `scripts/gerar-mapa-api.js`, que varre o consumo real de cada tela e dos `.js`
  que ela inclui; tela de detalhe herda de quem a linka, não do módulo inteiro —
  herdar do módulo inflava o mapa a ponto de `/api/sniper` (só a
  `electron-monitor.html` chama) ficar ao alcance de quem tinha "Meu Perfil"
- **Fail-open no perfil, de propósito**: só é barrado quem tem perfil cadastrado
  e ativo com aquele slug. Era o que permitia subir isto sem trancar quem já
  existia. `admin` nunca é barrado e o cadastro recusa esse slug — um perfil
  chamado `admin` daria a impressão de limitar o administrador sem limitar nada
- Fechada de passagem uma porta dos fundos que já existia: `/backups/*.html` e
  `/produtos/*.html` (telas legadas da reorganização de módulos, fora do menu)
  abriam para qualquer um. Agora só quem tem acesso ao módulo — ou o admin
- **Migração**: `william` e `caio` (tenant `josecarloscostafilho`, os únicos
  usuários ativos que não eram `admin` em nenhum tenant) foram para `admin`, a
  pedido. Ganharam com isso as funções administrativas que o
  `requireRole(['admin'])` lhes negava. Depois disso, nenhum usuário ativo em
  nenhum tenant depende do fail-open
- Testado no tenant `1bit` com o perfil `faturamento` (8 páginas) e o usuário
  `teste.rbac`: 148 páginas, 162 prefixos de API e as 25 chamadas das telas do
  próprio perfil — nenhuma divergência. Com `role=admin`, tudo livre nas duas
  portas

## 2026-08-14 (4)

- **Bug: aba Campanhas abria com "Conversa não encontrada"**. `/api/conversas/:id`
  estava registrada antes de `/api/conversas/campanhas`, então o Express casava
  `campanhas` como se fosse um id de conversa. As rotas de caminho literal
  (`campanhas`, `publico`, `oportunidades/livres`, `painel/resumo`) passaram para
  antes da paramétrica, com aviso no código para não regredir
- **Faltava criar campanha.** A tela antiga fazia isso e foi redirecionada sem
  que a função fosse replicada — erro meu na unificação. A aba ganhou o
  assistente: mensagem (modelo existente ou texto novo, com as variáveis do
  cadastro), público (lista existente ou montada na hora a partir dos clientes
  com telefone) e a campanha em si. Usa as APIs `/api/comm/*` que já existiam,
  sem criar um terceiro módulo de campanha
- A escolha do público mostra **quem pediu para sair** (desmarcável, vindo de
  `comm_optout`) e **quem aceita marketing** — antes isso só aparecia na hora do
  envio, quando a lista já estava montada. Campanha nasce em rascunho; executar
  é ação separada, e o envio sai no ritmo do canal

## 2026-08-14 (3)

- **Conhecimento da IA unificado num lugar só.** Havia dois: o campo antigo
  `config.whatsapp_ai_kb` (um bloco de texto, editado pela tela de WhatsApp que
  saiu do ar na unificação) e os itens de `ia_base`. Os dois eram concatenados
  no prompt, e o antigo continuava valendo sem que ninguém pudesse vê-lo nem
  corrigi-lo pela tela
- `scripts/migrar-kb-legado.js` levou o conteúdo para itens: no `1bit`, 16.265
  caracteres viraram **7 itens**, divididos pelas quatro URLs que o texto já
  marcava com `#` e fatiados no teto de 4.000 caracteres, com a URL gravada em
  `origem`. Nenhum outro tenant tinha conteúdo. Prompt conferido depois da
  migração: mesmo conhecimento, agora com título e origem visíveis
- `buildSystemAtendimento` **parou de ler** o campo antigo, e a rota
  `/api/whatsapp/ai-config` passou a **recusar** gravação nele — gravar num
  campo que ninguém lê é pior que recusar, porque quem envia acha que a IA
  aprendeu. O valor segue no `config` só para conferência (`kbLegado`), e
  desfazer é copiar de volta

## 2026-08-14 (2)

- **Funil duplicado corrigido**: a central de Conversas nasceu com funil
  próprio (`conv_funil_etapas` + `etapaId`/`valor` na conversa) sem que eu
  tivesse checado o CRM — que já existe em Comercial → CRM · Funil, está em uso
  real (350 oportunidades, 2 funis, 19 etapas) e é bem mais completo:
  probabilidade, motivo de perda, geração de OS, atividades e itens. Dois
  quadros seriam duas verdades sobre a mesma venda
- A conversa agora **aponta para uma oportunidade do CRM** (`oportunidadeId`).
  Na ficha lateral dá para criar o card (funil e etapa default do próprio CRM,
  `fonte='whatsapp'`, cliente já vinculado) ou amarrar a um card existente; o
  quadro continua sendo o do CRM. A aba Funil saiu da central
- Ficaram órfãs nos 11 tenants a tabela `conv_funil_etapas` e as colunas
  `etapaId`/`valor`/`etapaEm` de `conv_conversas`. **Removidas em seguida**, a
  pedido, por `scripts/limpar-funil-orfao.js`: o script simula por padrão, só
  age com `--aplicar` e pula o tenant que tiver qualquer dado nessas colunas —
  dado órfão ainda é dado. Backup em `backups/db/2026-08-14-1048/` antes do
  DDL; `integrity_check` ok depois, e tenant novo já nasce sem elas

## 2026-08-14

**Loja virtual (módulo Varejo)** — catálogo público por tenant, do mesmo
catálogo que abastece o Mercado Livre:

- `loja-routes.js` novo. Vitrine pública em `/loja/` (sem login) e painel do
  lojista em Varejo → Loja virtual. Publicar produto é opt-in por produto
  (`produtos.publicadoNaLoja`): catálogo inteiro no ar por engano é vazar preço
  e linha de produto. A loja nasce desligada em todos os tenants
- Disponibilidade nunca sai como número: a vitrine mostra *disponível*,
  *últimas unidades* ou *sob consulta*, calculado como saldo **menos reservas
  ativas** — a mesma conta do resto do ERP. Quantidade exata é inteligência de
  negócio, e o concorrente também abre a vitrine
- Personalização por tokens CSS (cor, fundo, tipografia, cantos, logo) com
  prévia ao vivo e três presets — sem campo de CSS livre, que é o pedido mais
  comum e o que gera mais suporte. A cor do texto sobre o botão é calculada por
  contraste, então cor clara não vira botão ilegível
- Fase 2: login do comprador reusando o portal do cliente (mesma
  `cliente_logins`, mesma sessão), preço por tabela via `resolverPreco` do
  próprio ERP (tabela do cliente → gerais por prioridade → cadastro, com faixa
  de quantidade), carrinho no servidor e checkout criando **pedido em rascunho
  com reserva de estoque** — mesma tabela, mesma numeração, mesmo fluxo de
  conferência. Estoque é conferido no fechamento, não na exibição
- Fase 4: cobrança opcional no checkout (Pix ou boleto) pela régua do
  financeiro — conta a receber ligada ao pedido, emissão pelo provedor já
  configurado e baixa pelo webhook que já existe. Desligada por padrão
- `gerarNumero`/`recalcularTotal` passaram a ser exportados de
  `pedidos-routes.js`: duplicar a numeração noutro módulo produziria número
  repetido assim que dois pedidos nascessem juntos

**Central de conversas (módulo Comunicação)** — cinco telas com três APIs
rivais viraram uma:

- `conversas-routes.js` novo. A unidade deixou de ser "mensagem enfileirada
  para envio" e passou a ser a **conversa**: estado (aberta/pendente/resolvida),
  dono, etiquetas, não lidas e o contato do ERP do outro lado, casado pelos 8
  últimos dígitos do telefone. Tela em três colunas com a ficha do cliente
  (últimos pedidos e títulos em aberto) ao lado da conversa
- **Funil** no mesmo lugar: etapa e valor moram na própria conversa — é a mesma
  conversa vista por outro ângulo, não uma oportunidade paralela para manter em
  sincronia. Arrastar entre etapas, total por coluna, e "gerar pedido" pelo
  mesmo caminho da loja virtual
- **Base da IA em pedaços** (`ia_base`), com origem e data, entrando no prompt
  do atendimento. Toda resposta da IA ganhou um "corrigir": o atendente escreve
  o que ela deveria ter dito e aquilo vira item da base, valendo na próxima
  conversa. É o que "treinar o robô" significa num atendente de IA — o caso que
  ele errou, não prompt novo
- Desligar a IA numa conversa passou a ser definitivo até religarem (a regra
  antiga voltava sozinha em 4h), e responder pelo inbox desliga a IA: se o
  humano assumiu, o robô sai de cena
- Menu: `comunicacao`, `whatsapp`, `wa-campanhas`, `wa-simular` e `wa-agenda`
  saíram; as três primeiras redirecionam para a central via `PAGINAS_MOVIDAS`.
  `wa-campanhas` e `wa-agenda` seguem acessíveis por URL porque a central lista
  e cancela campanha, mas ainda não cria nem agenda disparo

**Dois consertos que valem por si:**

- **Inbox nunca recebeu mensagem**: o webhook só aceitava instância com prefixo
  `le_`, e a instância real do 1bit se chama `status1bit` — todo evento era
  descartado em silêncio. Agora, quando o prefixo não bate, resolve o tenant
  procurando quem declarou aquela instância em `whatsapp_config`
- **Nenhuma trava de ritmo no envio**: 25/hora, 45s entre mensagens e teto
  diário que sobe com a idade do número (40 → 90 → 180 → 300). Resposta a quem
  escreveu, resposta do atendente e confirmação de descadastro passam por fora
  da trava — segurar atendimento para "proteger o número" é o inverso do que
  protege. Mensagem segurada fica na fila com o motivo, e `/api/whatsapp/ritmo`
  mostra o quadro. A contagem diária usa dia de Brasília: com `date('now')`
  puro o contador zerava às 21h local e o teto deixava de valer no fim do
  expediente

**Fotos de produto que o Mercado Livre não conseguia baixar** (anúncio nascia
pausado em `picture_download_pending`): `public/uploads/produtos` era root-owned
e o serviço roda como carlosfinezi — nenhuma foto era gravada; e a pasta ficava
atrás do login, então o ML recebia HTML em vez de JPEG. Agora só essa pasta é
servida antes da barreira (documento em `habilitacao`, `pessoas`, `os`, `cp` e
`cr` continua exigindo login) e as imagens **sobem por upload** para o ML em vez
de passar URL. O corpo do item também se adapta à categoria (título livre ou
família), manda o GTIN do cadastro e valida no `/items/validate` antes de criar.

Commit PARCIAL em `route-registry.js`: a versão da árvore registra quatro
módulos ainda untracked (`chat-monitor-routes`, `comprasnet-mensagem-routes`,
`notificacoes-routes`, `resultado-item-routes`), e commitá-la inteira deixaria o
HEAD sem bootar. Entrou a versão do HEAD mais as duas linhas que registram
`loja-routes` e `conversas-routes`. `produto-imagens.js` foi junto por ser
exigido por `loja-routes.js` e `marketplaces-ml.js`.

## 2026-08-12 (2)

- **Marcação de falhas da análise IA** (`analise_ia_falha` + backoff no
  `analise-ia-scheduler`). A fila do scan só excluía o que estava em
  `licitacao_analise`, e essa tabela só recebe linha em caso de SUCESSO: uma
  licitação que falhava voltava à fila nas duas janelas de todo dia até
  encerrar. Medido em 2026-08-12: 285 das 432 falhas do dia (66%) eram
  reincidentes de dias anteriores, cada retentativa reenviando até 40k
  caracteres a um provider pago. Agora a falha é registrada com backoff de
  1 → 3 → 7 → 30 dias, e o portão foi posto nos dois caminhos da fila (JS no
  Postgres, `NOT EXISTS` no SQLite). Sucesso posterior limpa a marca
- **Falha sistêmica não gera backoff**: as falhas são acumuladas e só
  persistidas se o scan analisou algo (`analisadas > 0`), provando que os
  providers estavam de pé. Sem essa regra os 9 dias de DeepSeek com HTTP 402
  teriam marcado ~500 licitações, escondendo-as por dias justamente quando o
  saldo voltasse. Efeito colateral bem-vindo: o motivo da falha passa a ficar
  gravado em `analise_ia_falha.ultimoErro` — antes o ramo `else { erros++ }`
  não logava nada
- Commit PARCIAL nos dois arquivos: `db-schema.js` e `analise-ia-scheduler.js`
  já estavam modificados na árvore antes desta mudança e o `db-schema.js` da
  árvore tem `require('./chat-monitor-config')`, que segue untracked — commitar
  inteiro deixaria o HEAD sem bootar. Ficou de fora, seguindo na árvore: no
  schema, `serieDps` do fornecedor, as migrações das colunas `ufs`/`municipios`
  de `grupos_palavras` e o `require` do chat-monitor-config; no scheduler, a
  herança de UFs do grupo e o filtro por município

### Diagnóstico que motivou a mudança (nada além do acima foi alterado)

- **DeepSeek sem saldo desde 2026-08-03** (`HTTP 402: Insufficient Balance`),
  700–1050 chamadas rejeitadas por dia, 9 dias sem ninguém notar. Ele era 81%
  de toda a análise do sistema (7.406 de 9.024 desde 19/06); desde então só o
  Gemini responde, no teto do free tier — exatamente 22–26 análises/dia
- O 402 não gera cooldown nem desativa o provider (`chamarDeepSeek` só trata
  429), a lista de grupos exibe status `erro` como "ativa", e
  `ultimo_scan_mensagem` fica NULL quando as falhas são por licitação. Nada
  disso foi corrigido — só a marcação de falhas
- Consumo concentrado no tenant `reimac`: 94% das análises, com cinco grupos de
  termos genéricos. 49% dos vereditos são "incompatível". A palavra `pá` do
  grupo Jardinagem gera 1.223 candidatas (casa "Pá coletora lixo", e por
  substring no `objetoCompra` casa Maca**pá**, "**pá**ginas" de outsourcing de
  impressão, "**pá**tio")
- Simulei alternativas antes de propor: remover `pá` corta 60% do volume mas
  perde 31% das licitações compatíveis — descartado. As duas que valem mexem no
  mecanismo, não na configuração: casar palavra em vez de substring no
  `objetoCompra` (−10% de volume, −3% de oportunidade) e aplicar a exclusão nos
  itens como o BI já faz (−36% / −11%). Nenhuma das duas foi implementada

## 2026-08-12

- `public/operacional/comprasnet-monitor.html`: o botão de silenciar pregão
  volta a ser reconhecível. Ele nunca deixou de funcionar — o clique disparava
  o POST normalmente — mas no estado *não silenciado* renderizava só um ícone
  de megafone de 16px em `--text-3` sobre `--bg-2`, com `border:none`, o que no
  tema claro virou um enfeite indistinguível dos badges de contagem ao lado.
  Agora tem rótulo ("Silenciar"), borda e `--text-2`; o estado silenciado ganhou
  borda em `--danger` para manter a simetria. Corrigido nos dois pontos: o
  render do grupo e o `toggleSilenciar` que reescreve o botão
- Grupos de palavras do tenant `1bit` (dado, não código — fica registrado aqui
  porque muda o que a pesquisa enxerga): cruzamento do portfólio do
  shop.certum.eu com o catálogo apontou 78 itens vendáveis fora dos filtros.
  `CERTIFICADO SSL` (id 2) foi de 13 para 33 palavras e de 2.753 para 3.080
  itens; `ALM — Application Lifecycle` (id 11) acolheu code signing, de 8 para
  12 palavras e de 3 para 15 itens. Do +327 do grupo 2, só 71 vêm das palavras
  novas — os outros 256 já casavam as palavras antigas e não apareciam porque a
  membership materializada estava congelada desde 2026-06-08. O rebuild só
  dispara quando alguém abre a página em modo-grupo, então um grupo pouco
  visitado serve dado velho por tempo indeterminado, mesmo com o TTL de 6h
- `wildcard` sozinho respondia por 27 dos itens perdidos: o match é
  `websearch_to_tsquery('simple', …)`, sem stemming e com frase exigindo
  adjacência, então `certificado wildcard` não pega "PremiumSSL Wildcard" nem
  "CERTIFICADO DIGITAL DO TIPO WILDCARD". Mesmo efeito no plural
  (`certificados ssl` ≠ `certificado ssl`)

## 2026-08-11

- Rotinas nomeadas no CLAUDE.md: "fechamento" (com restart condicional e
  healthcheck), "fechamento 0" (sem restart, com relatório de pendência),
  "backup" e "estado"
- `.claude/settings.json` do projeto: `defaultMode: acceptEdits`, restart no
  allow por nome de unidade (`consulta-licitacoes`, `liciteagora`) e deny do que
  é destrutivo aqui (stop/disable/mask/kill, `rm`, git destrutivo, npm install,
  `data/`, `.env`). Os session-services ficam fora das duas listas, para cair
  em prompt
- `scripts/backup-tenants.sh`: backup online dos SQLite dos tenants + dump
  seletivo do catálogo Postgres
- Correção no CLAUDE.md: caminho real dos bancos de tenant e registro de que o
  catálogo vivo migrou para PostgreSQL (`data/catalog.db` é legado congelado)
- As quatro engines de backfill do catálogo passam a reagendar o próprio timer
  em `finally`. O `resultados-backfill` tinha morrido calado em 2026-08-07: uma
  rejeição escapou do ciclo, o timer nunca foi rearmado e o processo seguiu de
  pé por 4 dias
- `catalog-watchdog.js`: alerta quando uma engine para de dar sinal (heartbeat
  em `catalog_sync_state`, check de hora em hora, log sempre + Telegram do
  primeiro tenant com o canal ligado)
- `stop` deixa de ser deny blanket e passa a nominal: liberado por nome só para
  `consulta-licitacoes` e `liciteagora` (serviço em laço de reinício), negado
  por nome para os session-services e para `postgresql`, `redis`, `nginx` e
  `bind9`/`named`. O blanket `stop:*` precisou sair porque deny vence allow e
  anulava a liberação nominal
- Nova seção "Pendências conhecidas" no CLAUDE.md, começando pelos 31.737
  erros de `participacoes_comprasnet` acumulados no `server.log`

### Faxina do repositório e separação do que estava pendente

- `.gitignore`: `*.bak-*`, `*.bak2*`, `backups-public/` e `public/uploads/`
  (`*.bak` já estava). Saem do índice 46 arquivos `.bak` rastreados, mais os 5
  de `public/uploads/` (PDFs de habilitação e imagem de produto — dado de
  runtime de tenant) e `propostas-api.js.bak2-123913`. Nada foi apagado do
  disco: só `git rm --cached`
- Jornal de Licitações removido. Saem `jornal-routes.js`,
  `jornal-scheduler.js` e a tela; entra `scripts/migrate-desligar-jornal.js`,
  que desliga o envio em todos os tenants (`listAll`, para que tenant suspenso
  que volte não ressuscite o envio) antes de a tela sair do ar. As tabelas
  `jornal_*` e o histórico ficam: são registro de mensagem já enviada a
  clientes. A descoberta por IA varre os mesmos grupos, pelos mesmos canais,
  com qualificação por score — manter os dois mandava duas mensagens sobre a
  mesma licitação
- Correção das referências órfãs que a remoção do jornal deixou no HEAD
  (`route-registry.js`, `role-dispatch.js`, `scheduler.js`). Os dois últimos
  commits são **parciais de propósito**: entraram só as linhas do jornal, para
  não arrastar seis frentes ainda não commitadas. Detalhe no corpo de cada
  commit e em "Frentes pendentes de commit" no CLAUDE.md
- Nova seção "Frentes pendentes de commit" no CLAUDE.md: mapa das 14 frentes
  que seguem na árvore (271 entradas), ordem recomendada de commit, os 7
  módulos untracked que o core/infra arrasta, e três pendências — a fiação do
  watchdog do catálogo fora do git, o `enviarAlerta` sem granularidade por
  tipo de aviso, e o `participacoes_comprasnet`
- Registrado em "Pendências conhecidas" que o `cicloAvisoAlcadas` passa a
  mandar mensagem no próximo restart do `liciteagora.service`, com o
  levantamento de quem receberia (Telegram do `1bit`, email do `reimac`)
