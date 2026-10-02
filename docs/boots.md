# Diário de boots do LiciteAgora (17/09 a 01/10/2026)

Saiu do CLAUDE.md em 02/10/2026, com o texto preservado. É o registro do que
cada restart pôs no ar, com as provas, e NÃO serve para saber o que está em
vigor hoje: ele errou esse estado mais de uma vez. Para isso, compare o `mtime`
do arquivo com o `ExecMainStartTimestamp` da unit. As lições que valem como
regra ficaram no CLAUDE.md, em "O que o diário de boots ensinou".

Correções feitas na mudança:

- os dois trechos que mandavam reiniciar pelo `reiniciar-com-sandbox-suspenso.sh`
  saíram, marcados no lugar. Com dois demos o script não vale; ver o CLAUDE.md,
  "Reiniciar com um demo ACTIVE";
- onde o texto diz que o boot atual do `liciteagora.service` é de 29/09 às
  09:51:49, o certo é 30/09 às 15:01:09, registrado no bloco logo depois. A
  "Pendente (28/09, c323e54)" se resolveu nesse boot;
- o comentário da remoção do `cicloAvisoAlcadas` está hoje em
  `scheduler.js:500`, e não na linha 462 citada.

### Em vigor desde o boot de 2026-10-01 12:15:33: opção numerada e os dois desvios do roteiro

A pedido, sem backup (nenhuma mudança de schema). Boot limpo, `NRestarts=0`,
HTTP 302, journal sem erro de carregamento. **O boot levou só estes três
arquivos**: nenhuma outra frente tinha `.js` da raiz alterado depois do boot
anterior (10:59:26), conferido por `find -newermt`. Nenhuma campanha em
`enviando` em tenant algum.

**O `sandbox` estava ACTIVE** (outra sessão o ativou) e o
`reiniciar-com-sandbox-suspenso.sh` **não** foi usado, pelo mesmo motivo do boot
das 10:59: ele existe para o SCHEDULER não armar jobs do sandbox, e mexe no
status de um tenant que não é meu. Só o servidor web reiniciou. Conferido antes:
o sandbox não tem robô do PCP ligado, campanha agendada, canal de WhatsApp,
roteiro ativo nem chave de IA, então o boot não armou nada para ele.

**Nada pendente deste serviço por esta frente.**

| Arquivo | O que o boot pôs em vigor |
|---|---|
| `roteiros.js` | `respostaNumerica`, `opcoesNumeradas`, `desvioPedido`; `validar` recusa desvio que não é texto; `conferirExtracao` recusa trecho que é só número |
| `roteiro-conversa.js` | resolve o número ANTES da IA (`resolverNumero`); opções numeradas no prompt; `desvioDaMensagem` |
| `whatsapp-webhook.js` | o `autoResponder` consulta o desvio e desliga a IA quando pedem uma pessoa |

- **A resposta pelo NÚMERO é resolvida pelo Node, sem IA.** O prompt oferece as
  opções como "1) …", e a fala que é só um número grava a opção daquela posição.
  Isso não podia ficar com o modelo: o `conferirExtracao` prova a resposta
  exigindo que o trecho esteja no que o contato escreveu, e um trecho `"2"` casa
  com qualquer "2" da conversa, inclusive o de um telefone. A guarda é a mensagem
  anterior conter o rótulo daquela opção; sem ela, um "2" solto gravaria resposta.
  Resposta escrita com as palavras do lead continua indo para a IA, como antes.
- **Pedir uma pessoa desliga a IA da conversa** (`iaAtiva = 0`), soma uma não
  lida e grava evento em `conv_eventos`. Só mandar "aguarde" e continuar
  perguntando faria a promessa virar mentira na mensagem seguinte.
- **Os gatilhos exigem o verbo junto do objeto**, e isso não é zelo: "Alguém
  anota em caderno ou planilha" e "o gerente, de uma em uma semana" são respostas
  legítimas do roteiro de alimentação. Com "alguém" ou "gerente" soltos, responder
  a etapa do estoque desligaria o atendimento automático. Qualquer negação na
  frase ("não quero falar com atendente") derruba o desvio inteiro; o custo é o
  falso negativo, que é o erro mais barato dos dois.
- **Os dois desvios vêm DEPOIS das guardas do `autoResponder`.** Antes delas,
  responderiam com a IA desligada à mão, fora do expediente, fora do escopo de
  campanha e durante a pausa por atendimento humano, justamente onde o sistema
  hoje cala.
- **A mensagem do material usa `{{linkMaterial}}`**, que precisa existir em
  Variáveis do roteiro, senão o salvar recusa com "Variável sem valor" (é a regra
  antiga, e é ela que impede o link vazio chegar ao cliente). Escrever o endereço
  direto na mensagem também vale. **Nenhum roteiro do 1bit tem os desvios
  configurados ainda**: até alguém preencher em Comunicação › Roteiros, a IA
  responde esses pedidos como antes. A NUMERAÇÃO não depende de configuração
  nenhuma e já vale em toda campanha com roteiro.
- **Os desvios são do ROTEIRO, então não existem fora dele.** Conversa sem
  campanha com roteiro nunca desvia, nem para pedido de atendente: quem decide
  ali é o escopo do atendente (com `campanha`, a IA não responde a quem chegou por
  fora, e é o caso do 1bit). Se algum dia o pedido de uma pessoa precisar desligar
  a IA em QUALQUER conversa, o lugar não é este: seria uma regra do canal, ao lado
  do opt-out, e não do roteiro.
- Provas: bloco N e D da etapa 150 (`test-roteiros-campanha`, 30 checagens) e a
  etapa 166 nova (`test-roteiro-desvio-webhook`, 4), que prova o FIO entre o
  webhook e as regras — sem ela, esquecer a chamada no `autoResponder` passaria
  verde, porque as regras continuariam certas.

  Sabotagens que reprovaram: guarda do rótulo na mensagem anterior (N1b),
  negação do desvio (D1b), gatilho largo com "gerente" e "alguém" soltos (D1b),
  material sem a pergunta da etapa (D2), validação de tipo (D4) e a chamada do
  desvio removida do `autoResponder` (W1 e W2, 3 de 4).

  **Uma sabotagem passou verde, e o motivo é informação:** derrubar a conferência
  por TIPO em `desvioPedido` não reprova nada, porque `desvioDaMensagem` recusa
  mensagem vazia e segura o caso. São duas guardas para a mesma coisa. Reprova
  derrubando as duas juntas (D3). Quem mexer ali não pode concluir que a primeira
  é supérflua pelo verde de uma sabotagem só.

### Pendente: reaplicar a extração da peça de campo na loja

**A loja usa HOJE a cópia própria das máscaras, e isso está certo por ora.** A
peça `public/js/campo-formato.js` nasceu dentro do `public/loja/catalogo.js` e
saiu dele em 30/09/2026 para servir também ao ERP; o `catalogo.js` passou a
consumi-la por uma ponte no topo (`const { ... } = window.CampoFormato`).

Em **01/10 às 09:52 a extração foi desfeita** pela sessão que trabalha na loja
do Cantinho Verde: o `catalogo.js` voltou às 2.724 linhas com as funções
próprias (`digitosDe`, `formatarTelefone`, `cpfValido`…) e o `index.html` perdeu
a tag do script. **Decisão do usuário: fica assim até ele avisar** que aquela
frente terminou, e então a extração se reaplica.

O que isso NÃO é: defeito. As três lojas publicadas (`1bit`,
`produtosbomgosto`, `josecarloscostafilho`) montam até o checkout, mascaram
telefone e documento e recusam dígito verificador errado — conferido no domínio
real em 01/10 às 10:50, sem finalizar pedido. A do `cantinhoverde` está com
`loja_config.ativa = 0` e responde "Loja não publicada": é a frente em
andamento, e não falha.

**O que a convivência das duas versões quebrou, e já está consertado:** as duas
leituras do troco (`catalogo.js`, `corpo.trocoPara` e a validação) tinham sido
ajustadas para o campo que entrega NÚMERO, que é o comportamento da peça. Com a
máscara própria de volta, elas passaram a ler `"R$ 50,00"`, e `Number` disso é
`NaN` — o pedido em dinheiro acusava "Para quanto precisa de troco?" com o campo
preenchido. Voltaram para `Number(digitosDe(v(...)))/100` em 01/10 às 10:39.

**Ao reaplicar**, três coisas e nenhuma é opcional:

1. a ponte no topo do `catalogo.js`, em lugar das definições próprias. Ela é
   mecânica: a peça commitada exporta os mesmos nomes que o `catalogo.js` define
   hoje, então a ponte é um `const { … } = window.CampoFormato` com a lista
   deles. A versão já escrita está em `/tmp/rev/catalogo-depois.js`, enquanto o
   `/tmp` durar;
2. `<script src="/js/campo-formato.js">` ANTES do `catalogo.js` no
   `index.html` — sem isso a ponte lê `undefined` e a vitrine não monta;
3. as duas leituras do troco voltam para `Number(v('chkTrocoPara') || 0)`,
   porque com a peça o campo entrega o número. Deixá-las como estão hoje
   dividiria o valor por 100 duas vezes.

Prova de ponta a ponta: `node scripts/test-pecas-pre-auth.js` e a conferência
das lojas no domínio real, abrindo o checkout por `pintarCheckout()` e sem
submeter nada.

**Em vigor desde o boot de 2026-09-30 17:55:38, feito por outra sessão: a
padronização dos campos de dado.** Nada pendente deste serviço por esta frente.
Os quatro arquivos são anteriores a esse boot (o mais recente, o
`pre-auth-routes.js`, é das 17:42:48):

| Arquivo | O que o boot pôs em vigor |
|---|---|
| `pre-auth-routes.js` | `/js/campo-formato.js` e `/js/aviso-sistema.js` liberados ANTES do login |
| `pessoa-sem-documento.js` | `cpfValido`, `cnpjValido` e `erroDeDocumento` |
| `financeiro-routes.js` | `POST /api/pessoas` recusa documento com dígito errado; `cep` entra só com dígitos |
| `loja-routes.js` | `documentoValido` usa a conferência do `pessoa-sem-documento` |

**O boot seguinte, de 2026-10-01 às 12:15:33, também foi de outra sessão**, e
nada desta frente dependia dele. Quem for conferir o que está no ar: compare o
`mtime` do arquivo com o `ExecMainStartTimestamp` da unit, e não com o que
estiver escrito aqui.

**Pendente depois desse boot, e NÃO é desta frente:** às 12:31:48 a frente de OS
acrescentou `os-rotulos.js` à liberação do `pre-auth-routes.js` (o portal do
cliente mostra "Aguardando peça" em vez de `aguardando-peca`, e é tela pública).
A estrutura da liberação é a mesma, e o que esta frente pôs lá continua no ar; o
que espera restart é o terceiro arquivo.

**O `loja-routes.js` ficou de fora do commit 9afb2bb**, pelo fecho de requires
do HEAD: a árvore já tinha nele `require('./loja-metodos-pagamento')`, da frente
das formas de pagamento da loja, cujo módulo não está no git. Commitá-lo
deixaria o HEAD sem bootar. A mudança desta obra ali são duas linhas, estão em
produção e vão junto daquela frente.

**Por que a liberação em `pre-auth-routes.js` existe, para quem for mexer nela:**
o static de `public/` vive atrás do `requireAuth`
(`auth-bootstrap.installProtectedStatic`), então quem pede `/js/x.js` sem sessão
recebe o HTML da tela de login **com status 200** — e um `<script src>` que
recebe HTML não avisa nada. A loja pública, o cardápio do QR Code, o portal do
cliente e as telas de orçamento usam as duas peças, e sem a liberação elas
ficariam sem nenhuma. Conferido em 01/10 às 10:45 contra a produção:
`GET /js/campo-formato.js` sem cookie devolve 22.414 bytes de
`application/javascript` nos hosts de `cantinhoverde`, `1bit` e
`produtosbomgosto`. A suíte 161 (`test-pecas-pre-auth`) guarda isso, e
`menu-config.js` e `sidebar.js` seguem atrás do login de propósito.

Nenhuma migração de banco. A validação do documento vale só para cadastro novo,
e as 8 fichas com dígito errado que já estão gravadas não travam — elas estão
listadas por `node scripts/listar-documentos-invalidos.js`, que é leitura pura.

**Em vigor desde o boot de 2026-10-01 10:59:26, a pedido (limpo,
`NRestarts=0`, HTTP 302, depois do backup `backups/db/2026-10-01-1058`): a
mídia do WhatsApp guardada no recebimento, e a mensagem apagada marcada.**
Conferido depois do boot: a coluna `apagadaEm` nos 20 tenants, nenhum sem a
tabela. Antes do boot: `sandbox` ACTIVE mas sem robô do PCP ligado, nenhuma
campanha em `enviando` em tenant nenhum. **Só o servidor web** — o scheduler
não carrega o webhook nem a mídia, e reiniciá-lo levaria junto a pendência de
28/09 do estoque mais o que outras sessões deixaram hoje. O
`reiniciar-com-sandbox-suspenso.sh` não foi usado de propósito: ele existe para
o SCHEDULER não armar os jobs do sandbox, e mexe no status de um tenant que
outra sessão ativou.

A mídia do WhatsApp tem prazo, e ninguém sabia: até hoje ela só era buscada
quando alguém ABRIA a conversa (`wa-midia.obter`), e o link expira sozinho.
Medido no 1bit em 01/10, imagem por imagem: **05/09 ainda baixa, 04/09 e os 14
dias testados antes dele, não.** São ~26 dias. Não é a Evolution que apaga — as
4.519 mensagens de mídia estavam todas no banco dela. Era o CDN do WhatsApp.
**2.434 das 4.519 já estavam perdidas** quando isso foi descoberto.

| Arquivo | O que o boot pôs no ar |
|---|---|
| `whatsapp-webhook.js` | guarda a mídia no RECEBIMENTO; trata `messages.delete` marcando a mensagem |
| `wa-midia.js` | `TIPOS_GUARDAR` (figurinha fora) e `guardarAgora`, que não lança |
| `whatsapp-adapter.js` | ALTER de `whatsapp_messages.apagadaEm` no `migrarQueue` |
| `db-schema.js` | o mesmo ALTER no boot, que é o que alcança os 20 tenants |
| `conversas-routes.js` | a listagem da conversa devolve `apagadaEm` |

**A Evolution assina `MESSAGES_DELETE`** nas três instâncias (`status1bit`,
`le_1bit_2`, `le_josecarloscostafilho`), feito às 10:41 de 01/10 por
`POST /webhook/set/<instância>`, preservando url, `base64` e `byEvents`. Entre
10:41 e o boot das 10:59 o servidor vivo descartava esse evento, então
**exclusão nessa janela de 18 min passou sem marca** — o evento não se repete e
não há como recuperá-la.

O boot não levou nada de outras frentes: o `.js` da raiz mais recente depois do
meu era de 30/09, já em vigor desde os boots daquele dia.

**Provado em produção com mídia real**, e não só em suíte: a primeira imagem a
chegar depois do boot (id 52542, do contato, 11:10:03) foi guardada sozinha em
`data/tenants/1bit/wa-midia/52542.bin`, 30.435 bytes, JPEG íntegro — sem
ninguém abrir a conversa, que era exatamente o que faltava.

**Figurinha fica de fora do que se guarda sozinho**, a pedido: 159 em 26 dias no
1bit, quase todas repetidas. Abrir a conversa ainda a busca sob demanda, se o
WhatsApp a tiver. O que a lista decide é o gasto automático de disco.

**O resgate rodou em 01/10**, a pedido, por
`node scripts/resgatar-wa-midia.js 1bit --aplicar`: 2.321 mídias dentro de 30
dias sem arquivo em disco, do MAIS ANTIGO para o mais novo, porque é o da borda
da janela que morre primeiro. Sem `--aplicar` o script só conta. As ~394 de
mais de 26 dias são quase todas recusa esperada, e cada recusa custa ~7 s de
espera da Evolution. O `josecarloscostafilho` tem outras 261, não resgatadas.

Peso medido por amostra real, para dimensionar o disco: áudio 137 KB, imagem
59 KB, documento 426 KB, **vídeo 5,0 MB**. No ritmo do 1bit dá cerca de 22 MB
por dia e 7,8 GB por ano, e o vídeo é 3% dos arquivos com mais da metade do
peso.

**Dois formatos de id no mesmo evento, e trocá-los marca a mensagem errada.** A
Evolution emite `messages.delete` de dois lugares (conferido em
`/opt/evolution-api`, `whatsapp.baileys.service.ts`): do `messages.update` com
a mensagem nula, que é quem apaga para todos no celular, o id vem no TOPO
(`data.id`); do `deleteMessage` da API dela, `data.id` é o uuid INTERNO e o do
WhatsApp está em `data.key.id`. O `idApagado` dá precedência ao `data.key.id`.

Prova: etapa 165 (`test-wa-midia-apagada`), 22 checagens, com o `fetch`
injetado e nenhuma chamada à Evolution. Sabotadas as três garantias (figurinha
de volta, `data.key.id` ignorado, webhook sem guardar), reprovou em 6.

**Em vigor desde o boot de 2026-09-30 15:00:41, feito por outra sessão (anexo
da máquina em Meus anexos).** O arquivo é de 30/09 às 12:40, e aquele boot, mais
os de 17:12, 17:29, 17:30 e 17:55, são todos posteriores: **a nota que dizia
"pendente até o restart" estava errada, e o ZIP já funcionava desde ontem à
tarde.**
`comprasnet-anexos-routes.js` deixou de exigir PDF no envio de arquivo local. A
validação passou a ser por extensão, contra o mapa `TIPOS_ANEXO` (pdf, zip,
rar, png, jpg, jpeg, doc, docx, xls, xlsx, txt), e o `Content-Type` do
multipart sai dele. Vale para as duas rotas que chamam `enviarAnexoCompra`: a
`/api/interesse/anexos` da tela de Interesses e a `/api/comprasnet/anexos` do
Electron.

O teto é de 7 MB por arquivo, conferido no navegador, porque o body do Express
para em 10 MB e o base64 infla 33%.

Prova: bloco novo na etapa 127b (`test-interesse-anexos-api`), que grava um
bearer com validade e substitui o `axios.post` para ver o multipart. Com a
validação antiga de volta, reprova em 4 das 23. Verify rápido de 12:52: 7
suítes, 89,6 s, zero falhas.

**Em vigor desde o boot de 2026-10-01 12:38:04** (limpo, `NRestarts=0`, HTTP
302): **as correções do módulo de OS**. Duas valem para todo tenant e eram
defeito silencioso:

- o relatório **SLA — cumprimento de prazos** passou a calcular o status pelo
  `calcSlaStatus`, o mesmo da lista. Lendo a coluna `slaStatus`, ele mostrava 0
  cumpridos e 0 estourados em QUALQUER tenant, para sempre: nada no sistema
  grava esses dois valores ali;
- `os_itens_pecas` ganhou `custoUnitario`, `desconto` e `situacao` pelo
  `db-schema.js`, na recriação e por ALTER idempotente. **Conferido nos 22
  tenants depois do boot: 20 com as três colunas**; `crsolucoes` e
  `pccontabilidade` não têm a tabela e por isso ficam de fora. Sem elas, abrir
  uma OS e o relatório de margem respondiam erro de SQL.

Mais: os KPIs "Faturadas sem nota" e "Rejeitadas SEFAZ" passaram a olhar as
notas (a NFS-e conta, e o de rejeitadas só aparece para quem emitiu), os
relatórios mostram o nome do técnico e não o login, a régua de cobrança ganhou
nome por etapa (`nomeDaEtapa`, exportada do `cobrancas-routes.js`) e o
`pre-auth-routes.js` passou a liberar `/js/os-rotulos.js`, que o portal do
cliente precisa por ser tela pública. **Nada pendente deste serviço.**

O boot levou junto, com a sintaxe conferida antes, o `ssl-certificados-routes.js`
de outra frente (salvo às 12:31, posterior ao boot das 12:15 daquela sessão).

**`consulta-licitacoes.service`** (o `server.js`) — boot atual: **2026-09-30
11:29:24**, a pedido, depois do backup `backups/db/2026-09-30-1057`: **o motor
da campanha nova não segura mais o disparo seguinte**, e a campanha enviada
volta a ser editável. Boot limpo, `NRestarts=0`, HTTP 302; nenhum sandbox ACTIVE
e nenhuma campanha em `enviando` em tenant nenhum no instante do restart (com
uma em envio, o restart a deixaria presa nesse estado até o tique do
`wa-scheduler`). **Nada pendente deste serviço.**

**Em vigor desde o boot de 2026-09-30 15:00:41, a pedido (limpo, `NRestarts=0`,
HTTP 302, sandboxes SUSPENDED e nenhuma campanha em `enviando` conferidos
antes; backup `backups/db/2026-09-30-1457`): conciliação bancária pelo extrato
da API, sem OFX.** O provedor de boleto da conta ganhou um método opcional `listarExtrato`,
e quem o tem passa a alimentar a mesma `transacoes_bancarias` do OFX. Hoje só o
Asaas (`GET /v3/financialTransactions`, conferido contra a API de produção do
1bit em 30/09: 148 lançamentos, `startDate`/`finishDate` e paginação por
`hasMore`). Arquivos do servidor web: `conciliacao-routes.js`
(`importarExtratoProvedor`, `POST /api/conciliacao/importar` e
`GET /api/conciliacao/extrato-contas`), `boleto-provedores/asaas.js`,
`boleto-provedores/index.js`, `boleto-provedores-routes.js` e
`boleto-orchestrator.js`.

- **Schema no boot, conferido nos 20 tenants**: `contas_financeiras_boleto.extratoAuto`
  (default 0), pelo `migrarSchema` do orquestrador, mais
  `transacoes_bancarias.origemImportacao` ('ofx' ou 'api'; NULL vale 'ofx',
  porque todo o histórico é de arquivo). O `extratoAuto` nasce desligado em
  todos: ligar sozinho gastaria chamada da API de quem nunca pediu.
- **O `migrarDB` da conciliação nunca alcançou tenant nenhum, e isso já estava
  quebrado antes desta frente.** Ele roda pelo `registrarRotasConciliacao`, que
  passa pelo BOOT_STUB do proxy multi-tenant: o **primeiro** restart de 30/09
  (14:59:08) criou o `extratoAuto` nos 20 e **nenhuma** coluna de
  `transacoes_bancarias`. Ou seja, `pagamentoId` — que o CONC-02 desta mesma
  data grava ao conciliar com CR/CP — não existia em tenant algum desde o boot
  das 11:29. O conserto é uma linha no `db-schema.js`, logo abaixo da do
  `boleto-orchestrator`, e foi o que motivou o segundo restart, às 15:00:41.
  Ensaio antes, sobre cópias: as 3 colunas criadas em 1bit, produtosbomgosto e
  reimac, sem perder linha, no máximo 715 ms.
- **O mesmo extrato por duas portas duplicaria tudo, e isso não é hipótese.**
  O `1bit` já sobe o OFX do Asaas: as 57 linhas de setembro que a API devolveu
  são as mesmas 57 que o arquivo tinha trazido, com identificador diferente dos
  dois lados. Sem guarda, a conta ficaria com 114 linhas e conciliar as duas
  metades como avulsas lançaria o dinheiro em dobro. `jaVeioPelaOutraPorta`
  casa por conta, data e valor, **uma linha existente para cada nova** (dois
  recebimentos iguais no mesmo dia continuam sendo dois), e vale nos dois
  sentidos: o upload de OFX também pula o que já veio da API.
- **Quem já usa OFX ganha na transição.** Quando a linha da API é uma que o
  arquivo já trouxe, ela não entra, mas o vínculo com a cobrança — que só a API
  tem — é aplicado à linha antiga, se ela ainda estiver pendente. No ensaio
  sobre a cópia do `1bit`, 5 linhas de setembro (R$ 6.722,89) deixaram de ser
  pendentes e passaram a apontar as baixas que o polling já tinha feito.
- **O `paymentId` é o que o OFX não tem.** A linha que veio de uma cobrança já
  baixada pelo webhook ou pelo polling nasce **conciliada**, apontando aquele
  pagamento, e a importação não lança nada. Sem isso ela nasceria pendente, e um
  clique em "avulsa" dobraria o saldo e o DRE.
- **Só a carteira Asaas.** Banco da Amazônia, CAIXA, Cora e Mercado Pago seguem
  no OFX, e a transferência Asaas → banco aparece nos dois extratos.
- A tarifa de mensageria e as transferências ficam **pendentes**, porque
  ninguém as lançou. Casam por regra da tesouraria ou à mão.
- Telas: `conciliacao-bancaria.html` ganhou o bloco "Importar do banco" e
  `contas-financeiras.html` o "Buscar o extrato automaticamente". As duas só
  aparecem para conta cujo provedor tenha `listarExtrato`, hoje as três do
  Asaas (1bit conta 5, produtosbomgosto conta 2, josecarloscostafilho conta 2).
- Prova: etapa 153 (`test-conciliacao-extrato`, 19 checagens), mais um ensaio
  contra a API de produção sobre uma cópia do `1bit`. **Oito sabotagens
  reprovaram**: a guarda do pagamento já reivindicado, a conferência de valor
  da tarifa, a conciliação automática, a paginação, o descarte de linha
  ilegível, a guarda das duas portas, o casamento um-para-um e o aproveitamento
  do vínculo na linha antiga. A conferência de valor da tarifa só passou a ser
  provada de verdade no X6b — no X6 quem segurava era a outra guarda, e a
  sabotagem passava verde até o caso ser isolado.
- **O boot levou junto o que a árvore tinha de outras frentes**, com a sintaxe
  conferida antes: `perfis-api-map.js` (09:46), `comm-imagens.js` (10:27),
  `comm-routes.js` (11:29), `whatsapp-adapter.js` (12:05), `whatsapp-webhook.js`
  (12:24), `roteiro-conversa.js` (12:29), `conversas-routes.js` (12:32) e
  `comprasnet-anexos-routes.js` (12:40). Os quatro do WhatsApp e das campanhas
  são posteriores ao boot das 11:29:24 e passaram a valer agora.

- **"Já está enviando" ao reenviar uma campanha que já tinha terminado.** A
  espera do intervalo era um `sleep` de 45 a 120 s que ignorava a pausa, e o laço
  a pagava mesmo com a fila vazia; enquanto ele não saía, a chave em memória
  recusava o `executar`. Medido na campanha 5 do 1bit: `pausar` às 11:20:48 e 409
  em todo `executar` de 11:20:50 em diante. Agora a espera é interrompível, a
  consulta de quem falta vem antes de qualquer espera, e a fila vazia encerra o
  laço no último envio. Provas: R20 e R21 da `test-campanha-rodadas`.
- **Campanha `enviada` ou `cancelada` é editável**, a pedido. O status é
  preservado (regravar `rascunho` trocaria "Enviar de novo", que abre a rodada
  seguinte, por "Enviar", que repetiria a atual), o que já saiu não muda, e
  `enviando` continua recusada. Provas: R19 e B1b da `test-campanha-segmentos`.
- A campanha 5 do 1bit ficou `pausada` com zero pendentes na rodada 7, resíduo do
  defeito. Um clique em "Retomar" a encerra como `enviada`, porque o motor novo
  vê a fila vazia e sai. Não mexi no banco para consertar o status.

O boot anterior foi o de **2026-09-30
10:17:53**, a pedido: **vídeo MP4 no conjunto do modelo de mensagem.** Boot
limpo, `NRestarts=0`, HTTP 302, os 20 tenants sem sandbox ACTIVE (conferido
antes). Nenhuma migração: o `db-schema.js` é de 29/09 e já estava no boot
anterior. **Nada pendente deste serviço.** O que era meu:

- `comm-imagens.js` aceita `.mp4` no conjunto do modelo, ao lado das imagens, e
  o sorteio de cada envio é entre todos. Vídeo que não é MP4 é recusado pedindo
  conversão (o `.mov` do iPhone tem a mesma caixa `ftyp` e chegaria quebrado ao
  cliente), e o teto é `MAX_VIDEO_BYTES`, **64 MB**.
- **O teto não é o do WhatsApp.** 16 MB é o limite da API oficial, que não é o
  caminho daqui: o envio passa pela Evolution 2.3.7 (protocolo do WhatsApp Web),
  que aceita corpo de 136 MB. Como o arquivo viaja em base64 (+33%), o teto
  técnico fica perto de 100 MB de arquivo; 64 MB é a folga escolhida para não
  pôr 130 MB de string na memória do servidor web a cada envio.
- `whatsapp-adapter.js`: `midiaDoCaminho` decide `mediatype`/`mimetype` pelo
  arquivo, e `.mp4` sai como `video`. Sem isso o vídeo sairia declarado como
  imagem. O `scheduler.js` também carrega o adapter, e lá a mudança fica ociosa:
  cobrança e OS não mandam vídeo.
- `comm-routes.js`: o teto do multer saiu de 8 MB para o do vídeo mais 4, e
  arquivo acima disso responde com o tamanho em vez de um 500 sem motivo.
- Telas (estáticas, já estavam no ar antes do boot): `modelos.html` aceita
  vídeo, mostra-o na grade e conta "arquivo(s)" no lugar de "imagem(ns)"; a
  prévia da campanha diz "com o arquivo do modelo".
- Provas: `test-comunicacao` (MP4 entra, sorteio misturado, `.mov` recusado,
  teto lido do módulo), `test-whatsapp-canais` A3b (mediatype `video`, sabotada
  e reprovada) e `test-campanha-segmentos` B2, que media a frase antiga da
  tabela de modelos. Verify rápido de 09:39: 14 etapas, 88,5 s, zero falhas
  novas.

Levou também, de outras frentes, o que a árvore tinha nesse instante, com a
sintaxe conferida antes: `perfis-api-map.js` (09:46), `roteiro-conversa.js`
(09:47) e `conciliacao-routes.js` (09:58).

O boot anterior foi o de **2026-09-30 08:23:10** (roteiro de qualificação por
campanha). O de **2026-09-29
13:16:26**, no fechamento da loja do Cantinho Verde (barra do topo por
medida, sacola no fluxo e montável sempre no montador), depois do backup
`backups/db/2026-09-29-1315`. Boot limpo, `NRestarts=0`, HTTP 302. **Nada
pendente.** Só o `loja-routes.js` era meu; o boot levou junto o
`faturas-routes.js` de outra frente, salvo às 13:08 e com sintaxe conferida
antes do restart. O restart foi feito ANTES do commit, e não depois, porque
as rotas novas (`montavel` e `precoInicial` em `/loja/api/sugestoes` e
`/loja/api/produtos/:id`) precisavam estar no ar para as provas de tela
valerem sobre o que seria commitado.

**Um boot às 12:58:53 aconteceu por outra sessão e não estava registrado
aqui** (esta nota dizia 11:05:29). Quem for conferir o que está em vigor:
compare o `mtime` do arquivo com o `ExecMainStartTimestamp` da unit, e não
com o que estiver escrito aqui.

O anterior registrado foi o de **11:05:29**, para as rotas `/loja/icones/` e `/loja/manifest.webmanifest`
do 68a0b5e (`loja-routes.js`), que o `tema.js` já no ar pedia. Boot limpo,
`NRestarts=0`, HTTP 302. **Nada pendente.** O anterior foi o de
**10:50:25**, no fechamento do 8e24d07: o 404 da loja dentro de `/loja/` sem
exigir a loja como página inicial (`loja-routes.js`). Só o servidor web: o
scheduler carrega o arquivo pelo `db-schema.js`, mas não serve HTTP. Boot
limpo, `NRestarts=0`, HTTP 302. Levou também o que a árvore tinha de outras
frentes nesse instante. **Nada pendente.** O anterior foi o de **10:19:22**,
no fechamento do ac722e1 (monte seu buquê e Pix da loja), depois do
backup `backups/db/2026-09-29-0929`. Só o servidor web: o `scheduler.js` não
carrega o checkout nem o webhook. O boot criou `loja_montaveis` e companhia,
`loja_pagamentos` e a `pedidos.valorRecebidoDinheiro` de outra frente,
conferidas nos 20 tenants. Boot limpo, `NRestarts=0`, HTTP 302. **Nada
pendente.** O Pix no site só liga quando o `cantinhoverde` tiver conta Asaas
ativa em Financeiro › Contas financeiras; até lá o checkout aceita as
intenções de sempre. O `public/loja/catalogo.js`, o `public/loja/index.html` e
o `public/comercial/pedido.html` estão no ar e fora do commit, porque dependem
de trabalho de outras frentes que não está no HEAD.

O boot anterior foi o de **09:51:47**, junto do scheduler (09:51:49), a pedido, depois do backup
`backups/db/2026-09-29-0947`: a troca do slug `floricultura` → `cantinhoverde`
exigia os dois processos largarem as conexões antigas, e o boot pôs no ar o
`topo: degrade` do `loja-routes.js`. Levou também o que a árvore tinha de
outras frentes nesse instante. Boot limpo nos dois, `NRestarts=0`, HTTP 302.
**Nada pendente.** O anterior foi o de 07:00:14 (ver o bloco logo abaixo do
de 23:03). O de **2026-09-28 23:03:44**, a pedido, depois do backup `backups/db/2026-09-28-2302`:
**segmento na ficha da pessoa.** Boot limpo, `NRestarts=0`, HTTP 302. O
`db-schema.js` chama `segmentos.migrarSegmentos`: tabela `segmentos` (9
sementes, com o Genérico), `pessoas.segmentoId` e `comm_campanhas.segmentos`,
conferidos nos 20 tenants (ensaio em cópia antes: até 411 ms cada). Arquivos:
`segmentos.js` e `lead-ficha.js` (novos), `financeiro-routes.js` (lead puro
fora da listagem, `?leads=1`, `?segmento`), `comm-routes.js` (planilha cria ou
reaproveita a ficha; membro edita o segmento da ficha; campanha por segmento;
`/api/comm/segmentos`), `comm-destinos.js`, `conversas-routes.js` (público
filtrado no SQL antes do limite; `?segmento` em Conversas). **A migração dos
27.777 avulsos do 1bit NÃO rodou**: `scripts/migrar-leads-listas.js` espera a
decisão sobre casar com ficha antiga (as 44 são quase todas contabilidade) e
sobre os 1.056 cards do CRM com nome diferente. As duas foram decididas em
29/09 e entraram no boot seguinte.

**Boot seguinte, 2026-09-29 07:00:14**, a pedido, depois do backup
`backups/db/2026-09-29-0659`. Boot limpo, `NRestarts=0`, HTTP 302. **Nada
pendente.** Levou:

- **O lead com ficha própria, juntado por telefone E nome** (`lead-ficha.js`),
  a pedido. Só ficha de lead casa, e nunca cliente, fornecedor ou contador. Dois
  contatos são a mesma ficha só quando o telefone e o nome coincidem, com o nome
  comparado sem acento, pontuação, espaço ou caixa. O mesmo telefone com nomes
  diferentes são empresas diferentes do mesmo contador: no 1bit, 278 telefones
  aparecem assim. O card do CRM liga só com telefone e nome iguais. A conversa
  liga só quando um único lead tem o telefone, porque ela não tem nome para
  desempatar.
- **A campanha em rodadas** (`comm-routes.js`, `comm-destinos.js`,
  `conversas-routes.js`, `db-schema.js`), a pedido. "Enviar de novo", numa
  campanha enviada ou cancelada, abre a rodada seguinte
  (`POST /api/comm/campanhas/:id/nova-rodada`), e a lista inteira recebe outra
  vez. O boot criou `comm_campanhas.rodada` e `comm_envios.rodada` (default 1),
  conferidas nas 18 empresas com campanhas; no 1bit, os 2 envios existentes são
  da rodada 1. Os totais da campanha são os da rodada atual, e "Ver envios"
  escolhe a rodada. O `wa-scheduler.js`, que dispara as campanhas agendadas,
  roda dentro do `server.js`, e por isso o scheduler não precisou reiniciar.

Suítes: 144 (`test-campanha-rodadas`) e 145 (`test-segmentos`).

**A migração dos avulsos do 1bit foi APLICADA em 29/09 às 07:10**, a pedido,
depois do backup `backups/db/2026-09-29-0710`. Os números bateram com os do
ensaio, e foram conferidos no banco depois: 27.771 fichas com `["lead"]`, todas
com aceite de WhatsApp; as 181 fichas antigas intocadas; 2 membros sem ficha
(telefone inválido); 25.997 cards do CRM com cliente lead; 357 conversas com
ficha (31 antes + 326). Para voltar atrás, só restaurando aquele backup.
Outros tenants não têm avulsos em lista. Ensaio de 29/09, sobre uma cópia: 27.777
avulsos, 27.771 fichas novas de lead, nenhuma casando com ficha antiga, nenhum
nome mudando nas listas nem no CRM, 25.997 cards do CRM ligados (961 ficam
sem ligar, por nome diferente), 326 conversas ligadas e 2 contatos com telefone
inválido, que ficam sem ficha. Rodar de novo não faz nada: não sobra avulso
para migrar.

**Em vigor desde o boot de 2026-09-29 10:19:22, feito por outra sessão: a
ficha de lead completada e as variáveis novas.** Os seis arquivos são das
09:49 e 09:50, anteriores a esse boot. O "[CRM] Erro na migração kanban→CRM:
no such table: licitacoes" do log é antigo (aparece em todo boot desde 28/09
08:53) e não vem desta frente. Decidido em 29/09:

- `{{primeiroNome}}` sai do NOME FANTASIA, e da razão social só sem fantasia
  (`comm-destinos.renderizar`). Vale para toda ficha.
- Variáveis novas `{{cidade}}`, `{{ramo}}` e `{{porte}}`, nos dois motores
  (na legado, do `extras` do lead). `{{cpfCnpj}}` sai vazio para o
  identificador interno (`SD-…`), que antes chegava ao cliente, e na legado só
  sai quando é número.
- As telas mostram o NOME DO LEAD, e não a razão social:
  `lead-ficha.nomeExibido`, usado em Listas, "Ver envios", Conversas e CRM.
  Ficha que não é lead continua mostrando a razão social.
- O lead casa pelo fantasia também (`lead-ficha.indiceDeTelefones`), e a ficha
  nova nasce com o nome nos dois campos. Sem isso, uma planilha nova duplicaria
  o lead completado.
- Arquivos: `comm-destinos.js`, `wa-campaigns-routes.js`, `lead-ficha.js`,
  `comm-routes.js`, `conversas-routes.js` e `crm-routes.js`. As telas
  `modelos.html` e `campanha.html` já listam as variáveis novas, e o servidor
  vivo as recusa até o restart.

**`scripts/completar-leads.js` foi APLICADO no 1bit em 29/09 às 12:33**, a
pedido, depois do backup `backups/db/2026-09-29-1232`, com os números do
ensaio: 27.769 fichas completadas, 17.991 com CNPJ, 2 sem dados do lead. A
primeira tentativa morreu com `SQLITE_BUSY_SNAPSHOT` e não gravou nada: a
transação abria como leitura e não virava escrita, porque o servidor gravou no
meio. Os três scripts desta frente (`completar-leads`, `migrar-leads-listas` e
`acertar-optout`) passaram a abrir com `.immediate()`.

Junto, e a pedido, a campanha 3 do 1bit voltou de cancelada para pausada,
com os 19 pendentes da rodada 1. O modelo 1 ainda não tinha imagem nesse
momento.

**Em vigor desde o boot de 2026-09-29 11:15:42, a pedido (boot limpo,
`NRestarts=0`, HTTP 302): a pausa da campanha nova.** A campanha 3 do 1bit
continua gravada como cancelada: voltá-la para pausada é escrita no banco, e
espera pedido.
A rota `pausar` gravava "pausada", mas o motor, ao sair do laço, gravava
"cancelada" por cima, porque não distinguia pausa de cancelamento. A campanha
pausada perdia o "Retomar". Foi o que houve com a campanha 3 do 1bit
("exemplo (cópia)"): pausada às 11:01, ficou cancelada com 19 pendentes. Agora
é o mesmo `ctl.pausado` da campanha legado (`comm-routes.js`). Prova: R11 da
`test-campanha-rodadas`, que reprovou com o motor antigo.

**Em vigor desde o boot de 2026-09-29 12:21:36, a pedido (limpo,
`NRestarts=0`, HTTP 302): "Aceita campanha por WhatsApp" como o controle de
marketing.** Decidido em 29/09: desmarcar o campo
na ficha tira o lead de toda campanha de marketing, nova ou legado. A
operacional (boleto, entrega) continua ignorando o campo, mas não a lista de
bloqueio.

- A campanha legado passa a respeitar o campo da ficha do LEAD, achada pelo
  telefone e pelo nome (`lead-ficha.leadRecusaMarketing`). A ficha do contador,
  que divide o telefone, não fala pelo lead. Ela também passa a olhar a lista
  da campanha nova (`comm_optout`) com o número normalizado. Quem cai numa
  dessas regras sai da fila como `optout`, com o motivo (`wa-campaigns-routes.js`).
- Responder SAIR (ou PARAR, STOP…) a uma campanha, nova ou legado, passa por
  `comm-destinos.descadastrarWhatsApp`: as duas listas de bloqueio, com o
  número normalizado e como veio, a ficha desmarcada e os pendentes da legado
  fora da fila (`whatsapp-webhook.js`). Até 29/09 só a legado contava, e o pedido
  ia só para a lista dela. Quem nunca recebeu campanha segue o fluxo normal:
  "cancelar" sobre um pedido não descadastra ninguém.
- Prova: O1 a O3 da `test-campanha-modelo`, que reprovaram O1 e O2 com o
  código antigo.

**`scripts/acertar-optout.js` foi APLICADO no 1bit em 29/09 às 12:22**, depois
do backup `backups/db/2026-09-29-1222`, com os mesmos números do ensaio.
Conferido depois: 36 números na lista da campanha nova, o 5594992069221 entre
eles, e nenhuma ficha com número bloqueado ainda aceitando campanha. Ensaio,
sobre uma cópia, com `--numero 559481151183 --numero 559491186675`: 9 números
novos na lista da campanha nova (o 559492069221 de 17/08 entre eles, bloqueado
até então só na legado), 7 fichas desmarcadas e 1 pendente da legado fora da
fila.

**19 pedidos de saída de antes de 17/08 estão sem telefone.** O bot antigo
gravou o identificador interno do WhatsApp (LID, como "117145820221516") em
`wa_optout`, e nenhuma campanha compara com ele. O telefone de 2 está nas
mensagens da Evolution (`Message.key->>'remoteJidAlt'`, no `evolution_db`) e
entra pelo `--numero`. Dos outros 17 não há mensagem nenhuma, e o número se
perdeu. O webhook de hoje já troca o LID pelo telefone
(`whatsapp-webhook.js:28`).

**Em vigor desde o boot de 2026-09-30 09:50:58, a pedido (limpo, `NRestarts=0`,
HTTP 302; conferido numa cópia do 1bit que o qualificado recebe o link já
trocado): as variáveis do roteiro no prompt da IA.** O `roteiro-conversa.blocoParaIA` mandava à IA o texto do
roteiro sem trocar as variáveis, e ela leria `{{linkTrial}}` cru. Agora troca
pelo `roteiros.render`, com os valores do roteiro e o cadastro da empresa, na
etapa, nas regras e no próximo passo. Prova: Q5 da `test-roteiros-campanha`,
que reprovou com a versão anterior. Junto, a pedido, o roteiro 2 do 1bit
("WhatsApp — licitações") ganhou o próximo passo do qualificado: o link
`{{linkTrial}}` (https://liciteagora.app/trial.html, que cria o tenant de
teste de 14 dias) e o aviso de que um consultor vai chamar. O config anterior
está em `/tmp/roteiro2-1bit-antes-proximo-passo.json`.

**Em vigor desde o boot de 2026-09-30 08:23:10, a pedido (limpo,
`NRestarts=0`, HTTP 302; sandboxes conferidos SUSPENDED antes): roteiro de
qualificação por campanha.** Conferido depois do boot nos 20 tenants: as três
colunas de `roteiro_visitas` em todos, `comm_campanhas.roteiroId` em todos os
que têm a tabela (o crsolucoes e o pccontabilidade não têm), e nenhum roteiro
presencial ativo. O boot anterior era de 29/09 às 16:54:55, feito por outra
sessão, e não o das 16:38:36 anotado abaixo. Decidido pelo usuário: cada campanha, nova ou legado, escolhe
um roteiro; o roteiro são etapas em ordem (`roteiros.estado`), e uma resposta
pode encerrar (desqualificado) ou pular para uma etapa MAIS ADIANTE (para trás
é recusado pelo `validar`). A cada mensagem do lead, o webhook chama
`roteiro-conversa.qualificarPelaIA` antes do `autoResponder`: a IA marca as
respostas com o trecho, que precisa existir na conversa. O qualificado vira
oportunidade no funil do roteiro (`config.funilId`, uma vez só) e filtro em
Conversas; o desqualificado vira filtro, e o prompt da IA passa a mandar
encerrar com cordialidade. O prompt leva só a etapa atual
(`blocoParaIA`). Qual roteiro vale: o que a conversa já começou, senão o da
campanha mais recente que o contato recebeu; **fora de campanha, nenhum** (o
roteiro "padrão da casa" acabou).

- Arquivos: `roteiros.js`, `roteiro-conversa.js` (novo), `roteiros-routes.js`
  (editor: GET/POST/DELETE `/api/roteiros`, com os funis na listagem),
  `whatsapp-adapter.js`, `whatsapp-webhook.js`, `conversas-routes.js`,
  `comm-routes.js`, `db-schema.js`, `perfis-acesso.js`, `perfis-api-map.js`.
  Telas (já no ar, estáticas): `public/comunicacao/roteiros.html` (nova),
  `campanha.html` (seção "Roteiro de qualificação"), `conversas.html` (ficha e
  filtros), `menu-config.js` e `sidebar.js`.
- **Schema no boot** (`roteiro-conversa.migrar`, chamado no fim do
  `db-schema.js`): `roteiro_visitas` ganha `resultado`, `finalizadoEm` e
  `trechos`; `comm_campanhas` ganha `roteiroId`; e **o roteiro presencial
  (`canal = 'visita'`) é desativado**, a pedido. Nada é apagado.
- A Visita saiu do menu do Comercial. O `public/comercial/visita.html` e as
  rotas `/api/visitas` continuam (o `rm` é negado aqui), sem link.
- **As campanhas 5 e 6 do 1bit não têm `roteiro_id`.** Depois do restart a IA
  deixa de fazer perguntas de roteiro a quem veio delas até alguém escolher um
  roteiro na página da campanha. Antes, todas usavam o roteiro de WhatsApp
  padrão.
- Prova: etapa 150 (`test-roteiros-campanha`, 14 checagens, nove sabotagens
  reprovadas). O bloco G da `test-visita-campo` saiu para ela. A6 a A8 da
  `test-ia-estilo` (etapa 117) passaram à regra nova, e o A6b novo reprova com
  o roteiro padrão de volta.
- Verify inteiro de 29/09 às 17:51 (1.320 s): as 4 conhecidas da etapa 21, as
  2 da 117 (já corrigidas, era a suíte antiga), e 7 nas etapas 25, 26 e 27, da
  loja. Essas 7 não são desta frente: a 26 reprova igual com o `db-schema.js`
  sem a linha do roteiro, e vêm do `loja-routes.js`, `public/loja/catalogo.js`
  e `index.html` editados às 17:17–17:19 por outra sessão.

**Em vigor desde o boot de 2026-09-29 16:38:36, a pedido (limpo, `NRestarts=0`,
HTTP 302; coluna `ritmo` conferida no 1bit e no reimac): ritmo e horário da
campanha nova.** Ela não tinha tela para isso: 30 envios por dia por número e 45 a 120 s,
fixos no banco, e a janela de 8h às 20h conferida só no clique em "Enviar" (uma
campanha começada às 19h55 seguia mandando de madrugada). Agora a coluna
`comm_campanhas.ritmo` (JSON; criada pelo `migrarRodadas`, que o boot já chama)
guarda limite por dia DA CAMPANHA, intervalo mínimo e máximo, e horário
(início, fim e dias). Em branco vale o padrão de antes (`whatsapp_daily_limit`,
`whatsapp_throttle_*`, `comm_janela_*`). O motor (`comm-routes.ritmoDaCampanha`)
confere horário e limite a cada envio e ESPERA, continuando sozinho quando o
horário abre ou o dia vira; antes, bater o teto terminava a campanha em
'pausada'. O teto de 30 por NÚMERO saiu do motor: o teto do número é o da tela
Canal (`checarRitmo`), que vale por cima, e o mais restritivo ganha. O "Enviar"
de WhatsApp não recusa mais fora do horário: começa e avisa quando o envio
começa (`aguarda`). O e-mail continua recusando. A página da campanha usa a
mesma seção "Ritmo e horário" da legado (`data-modo="wa comm"`), com o padrão
nos campos vazios, e a pausada muda o ritmo. As suítes que esperam o motor
desligam a janela (`comm_janela_ativa = 0`), senão travariam à noite. Prova:
R16 a R18 da `test-campanha-rodadas`, que reprovaram com o código anterior, e
E1b/E2 da `test-campanha-segmentos`.

**Em vigor desde o boot de 16:38:36: o número novo herda a configuração do
padrão**, a pedido: instruções e estilo da IA, horário e ritmo.
A IA nasce desligada, e o teto do dia não vem, porque o número novo precisa do
aquecimento (40, 90, 180, 300). Prova: D3 da `test-whatsapp-canais`.

**Em vigor desde o boot de 16:38:36: o aviso de mensagem nova em Conversas.** Comparava o número de conversas não lidas e perdia a mensagem nova
em conversa já não lida. `GET /api/conversas` devolve `recebidas: { ultimoId,
novas }` (com `?desde=`), e a tela avisa por isso. O som libera o áudio
(`resume`) e toca ao ser ligado. Os dois controles saíram da linha de busca para
o cabeçalho, com texto ("Som ligado", "Notificação desligada"). Prova: H2, H2b e
S19, e a etapa 111 (`test-conversas-aviso`), reescrita para a regra nova: contra
a tela anterior reprova 7 de 14. Até o restart, a tela (no ar) não recebe
`recebidas` e não avisa.

**Já no ar (estático), 29/09, fim da tarde: balão e celular de Conversas.**
Três defeitos, dois deles anteriores a este dia:

- **O balão gigante.** `.msg` tinha `white-space: pre-wrap`, que preservava
  também a quebra e o recuo do código em volta do texto: cada mensagem curta
  ("compra", "Bom dia") virava um bloco de 115 a 144 px. O `pre-wrap` foi para o
  texto (`.msg .txt`).
- **No celular não se abria conversa.** Nada punha a classe `abriu` na caixa;
  a conversa só aparecia porque a regra que devia escondê-la perdia para
  `.coluna`. O acerto de layout do mesmo dia fez a regra valer, e a conversa
  sumiu de vez. Agora o `abrir` põe `abriu`, e um "Voltar" (só no celular)
  volta à lista.
- **A ficha nunca sumia** no tablet e no celular, pelo mesmo motivo: caía
  embaixo da conversa. As regras de tamanho de tela usam `.central .x`.

Prova: H7, I5 e I6 da `test-conversas-ux`, que reprovaram com a tela anterior
(o balão de "Bom dia" tinha 144 px). **No acerto de layout a mesma suíte perdeu
sem querer a H2, a H2b, a H5 e a H6**, apagadas junto com a H1 antiga; a
contagem caiu de 40 para 38 e ninguém conferiu. Foram restauradas, e a suíte tem
44 etapas.

**Já no ar (estático), 29/09: o layout de Conversas.** Com dois números, os
seletores de número e segmento na linha da busca deixaram o campo com 26 px;
os filtros rolavam para o lado e escondiam "Campanhas" e "Minhas"; a caixa
descontava a faixa de números que saiu e sobravam 96 px embaixo; e no celular a
conversa vazia dividia a altura com a lista (a regra `.coluna` vencia a do
celular). Agora a busca tem linha própria, os seletores dividem a de baixo, os
filtros quebram linha, a coluna tem 340 px e a caixa vai ao pé da página. Prova:
H1, I3, I4 e I5 da `test-conversas-ux`, que reprovaram com a tela anterior.

**Em vigor desde o boot de 16:38:36: os tetos na tela Canal.** A tela
deixava Por hora, Intervalo e Por dia vazios, com o padrão só como texto
apagado dentro do campo (e nenhum no Por dia). `GET /api/whatsapp/ritmo`
passa a devolver os tetos que valem (`limiteHora`, `intervaloMinS`,
`limiteDia`) e o `padrao` de cada um, com o do dia calculado pela idade do
número (`whatsapp-adapter.tetoDoDia`, a mesma regra do envio, agora numa
função só). A tela (já no ar) mostra o teto do dia no quadro e escreve o
padrão embaixo dos campos. O scheduler também carrega o adapter, mas o envio
não mudou de comportamento. Prova: D2b da `test-whatsapp-canais`.

**A etapa 142 (`test-whatsapp-canais-migracao`) media a produção.** Esperava
"um canal só" e a configuração do canal igual à da empresa, sobre a cópia do
banco vivo. O 1bit criou o número "Suporte" em 29/09 às 15:54, e ela reprovou
sem defeito. Agora mede a regra: o número que existia é um canal só e o
padrão, e num banco já migrado a migração não muda nenhum canal.

**Em vigor desde o boot de 2026-09-29 16:06:04, a pedido: o filtro de
campanha de Conversas.** Ele só listava as campanhas legado, e só quem respondeu. Agora
(`conversas-routes.sqlDaCampanha`) lista as novas também (`comm:<id>`, e
`wa:<id>` para a legado) e escolhe entre "responderam" e "receberam", por
subconsulta dos últimos 8 dígitos: o telefone da conversa vem do jid, às vezes
sem o nono dígito, e "receberam" nas legado do 1bit são 27 mil telefones.
"Receberam" só mostra quem tem conversa; quem recebeu e nunca escreveu fica
em Campanhas › Ver envios. Medido no 1bit: todas responderam 63, todas
receberam 307, campanha 3 5 e 5. Até o restart, a tela (já no ar) manda
`comm:3` a um servidor que não o entende e cai em "todas as legado".

**Já no ar (estático), 29/09, a pedido: a faixa de números do topo de
Conversas saiu** ("sem nenhuma resposta", "não lidas", "no total"). Como
eram também os filtros, eles viraram chips ("Não lidas", "Sem resposta",
"Sem dono", este só quando difere do total), e clicar de novo no chip marcado
volta a mostrar todas, que era o papel do "no total". Prova: B1 a B5 da
`test-conversas-ux` e S18 da `test-segmentos`, que reprovou com a rota antiga.

**Em vigor desde o boot de 2026-09-29 15:42:41, a pedido (limpo,
`NRestarts=0`, HTTP 302; `wa_numeros` e `wa_verificacoes` criadas no boot,
conferidas no 1bit, reimac e crsolucoes): números sem WhatsApp.** O
`whatsapp-adapter.js` também é carregado pelo scheduler, e lá a única mudança
(a resposta no erro do envio com foto) espera o próximo restart dele.
Na campanha 3 do 1bit, 10 de 22 envios falharam porque o número não tem
WhatsApp (conferido na Evolution), e nada guardava isso. Decidido em 29/09
(opção 2):

- a marca é do NÚMERO normalizado, na tabela `wa_numeros` (o boot a cria pelo
  `db-schema.js`), e não da ficha;
- a falha de envio em que a Evolution responde `"exists": false` marca o
  número. O erro do envio com foto passou a trazer a resposta
  (`whatsapp-adapter.js`), senão não dava para saber;
- as campanhas, nova e legado, pulam o número marcado com o motivo "número sem
  WhatsApp", sem gastar intervalo do ritmo;
- em Listas, "Verificar WhatsApp" consulta a lista na Evolution
  (`/chat/whatsappNumbers`) em segundo plano, 25 números por lote com 3 s de
  pausa, para não chamar a atenção do WhatsApp para o número da empresa.
  Número verificado nos últimos 30 dias não é consultado de novo, então um
  restart no meio só obriga a clicar de novo. Uma lista de 15 mil são 600
  lotes, perto de 40 minutos. O andamento fica em `wa_verificacoes`;
- a ficha mostra a marca do telefone e a desfaz
  (`DELETE /api/pessoas/:id/sem-whatsapp`).

Arquivos: `wa-numeros.js` (novo), `comm-destinos.js`, `comm-routes.js`,
`wa-campaigns-routes.js`, `whatsapp-adapter.js`, `financeiro-routes.js` e
`db-schema.js`; telas `listas.html` e `pessoas.html`, já no ar, que só mostram
algo depois do restart. Prova: suíte 149 (`test-numeros-whatsapp`), O4 da
`test-campanha-modelo` e B3f e B3g da `test-listas-membros`; as três
sabotagens reprovaram.

**Em vigor desde o boot de 2026-09-29 14:39:57, a pedido (limpo,
`NRestarts=0`, HTTP 302): a campanha nova volta sozinha depois de um
restart.** Conferido: a campanha 3 do 1bit voltou a enviar às 14:42:02, no
primeiro tique. O laço de envio mora em memória, e o restart no
meio deixava a campanha em 'enviando' sem nada saindo, para sempre: a campanha
3 do 1bit parou às 12:47 com 7 pendentes. O `wa-scheduler.js` já retomava a
campanha legado nesse estado; agora faz o mesmo com a nova, pelo
`dispararCommWhatsApp`, que não prepara a lista de novo. **Efeito do próximo
boot:** no primeiro tique (até 2 min), a campanha 3 do 1bit volta a enviar
para os 7 pendentes; era a única em 'enviando' em todas as empresas às 13:10.
As 5 falhas com foto dela eram números sem WhatsApp (conferido na Evolution),
e não defeito da foto. Prova: R15 da `test-campanha-rodadas`, que reprovou com
o scheduler antigo.

**Em vigor desde o boot de 2026-09-29 12:58:53, a pedido (limpo,
`NRestarts=0`, HTTP 302): o texto da campanha nova sai do modelo na hora de
cada envio, e a pausada se edita.** Até então o texto
era montado ao preparar a lista e ficava congelado: o modelo do 1bit foi
editado com a campanha 3 pausada, e os 19 pendentes continuavam com "Olá!
Tudo bem?". Agora `comm-routes.textoDoEnvio` monta o texto do modelo atual
em cada envio (WhatsApp e e-mail) e grava no envio o que saiu. A campanha
pausada edita nome, modelo e números; lista, segmentos e tipo ficam para a
próxima rodada, e a tela os desabilita. A foto sempre foi sorteada na hora do
envio, e a do modelo 1 já existe. Prova: R12 a R14 da `test-campanha-rodadas`,
que reprovaram com o código anterior.

**Em vigor desde o boot de 2026-09-29 12:49:43, a pedido (limpo,
`NRestarts=0`, HTTP 302): a mídia nas conversas.**
A Conversas não mostrava foto, áudio nem documento, e o texto da mensagem de
empresa do WhatsApp Business se perdia (o 556236020555 manda
`templateMessage`, com a imagem e a legenda em `hydratedTemplate`).

- O webhook lê o texto dos formatos que se perdiam: mensagem de empresa,
  legenda de documento, mensagem temporária ou de visualização única, e
  resposta de botão ou lista (`whatsapp-webhook.extractText`). A prévia da lista
  mostra o tipo ("Imagem", "Áudio"…) quando não há texto; o texto gravado segue
  vazio, e a IA não responde a mídia sem texto.
- A mídia é buscada na Evolution quando a conversa abre
  (`POST /chat/getBase64FromMediaMessage/<instância>`, conferido em 29/09 com a
  imagem de dentro da `templateMessage`) e guardada em
  `data/tenants/<slug>/wa-midia/<id>.bin` (`wa-midia.js`, rota
  `GET /api/conversas/midia/:id`). Vale também para a mídia já recebida,
  enquanto a Evolution a tiver.
- A tela (`conversas.html`, estática, já no ar) mostra imagem, áudio, vídeo e
  documento. Até o restart a rota não existe, e a mídia aparece como
  "Mídia indisponível".
- As mensagens antigas de empresa continuam com o texto vazio no banco: o
  webhook novo só lê as que chegarem.
- Prova: suíte 148 (`test-conversas-midia`) e a parte M da
  `test-conversas-ux`. As duas reprovaram contra o webhook e a tela antigos.

**Em vigor desde o boot de 2026-09-29 12:31:02, a pedido (limpo,
`NRestarts=0`, HTTP 302): uploads da comunicação.**
A imagem do modelo, a planilha da lista e o PDF da Base da IA passavam pelo
multer direto para o handler, sem o `reentrarContextoTenant`. Em produção o
`db` é o proxy do contexto do tenant, e o upload voltava 400 com "currentDb()
chamado fora de contexto de tenant". Foi o que a imagem do modelo do 1bit
recebeu às 12:26. As suítes anteriores davam às rotas o banco cru e passavam.
Arquivos: `comm-routes.js` e `conversas-routes.js`. Suíte 147
(`test-upload-comunicacao`), com o proxy de verdade: contra as rotas antigas,
reprovou nas três com a mesma mensagem.

**Já no ar (estático), 29/09: a imagem do modelo sobe de verdade.** Em
`modelos.html`, a foto só subia por um botão à parte, e quem escolhia a foto e
clicava em "Salvar modelo" a perdia sem aviso. Nenhuma imagem de modelo do 1bit
chegou ao servidor: o log só tem GET em `/imagens`. Agora ela sobe ao ser
escolhida, ou junto do salvar no modelo novo, e a recusa deixa o modal aberto
dizendo qual arquivo foi. Suíte 146 (`test-modelos-imagens`), no Chrome:
contra a tela antiga, reprovou em 4 de 5. Ensaio no 1bit, sobre uma
cópia: 27.769 fichas completadas com cidade, porte e ramo; 17.991 com CNPJ;
9.777 sem CNPJ, porque as colunas deslizaram na planilha original; 1 CNPJ de
outra ficha; a razão social muda em 10.225 fichas (por exemplo "BUXIM XEI" →
"G DOS S FREITAS MARQUES…"). Prova: S14 a S17 da `test-segmentos`.

O de **22:07**, a pedido, para pôr em vigor a **Etapa 6 da Fase 2B**: o cancelamento
de pedido passou a ser recusado quando existe NFC-e `autorizada` ou
`pendente` vinculada (`pedidos-routes.js`, dentro de `cancelarPedidoInterno`,
antes de qualquer efeito). Boot limpo, PID 144481 → 183825, `NRestarts=0`,
HTTP 302 no `/health` em 6 ms. **Nada pendente.**

Esse boot fechou a **Fase 2A + 2B** inteira, que já estava parcialmente no ar:

- **Fase 2A** (motor NFC-e): frete, `indPres`, grupo `<entrega>` injetado antes
  da assinatura e **reconciliação por chave** quando o envio estoura — a
  consulta pergunta à SEFAZ o que ela fez com o lote, em vez de tratar timeout
  como "não aconteceu nada".
- **Etapas 1-3**: trava simétrica NF-e 55 × NFC-e 65 (só `autorizada` bloqueia;
  cancelada e rejeitada liberam), `documentoFiscalDe` no motor NFC-e, e as
  rotas de consulta por chave e DANFCe.
- **Etapa 5**: `POST /api/pedidos/:id/emitir-nfce` — emissão MANUAL, do
  lojista, só para pedido de catálogo em `entregue` ou `faturado`, com
  `efeitosJaAplicados = true`. Mais `GET /api/pedidos/:id/nfce` e o painel
  "Documento fiscal" em `public/comercial/pedido.html`.

**Nenhuma NFC-e pode ser emitida hoje**, e isso é configuração, não código:
`loja_config.tipoOperacaoNfceId` está NULL nos 20 tenants, e a rota recusa com
409 mandando configurar em Catálogo Online › Regras fiscais. Conferido depois
do boot: 0 NFC-e em todos os tenants e 0 pedidos de catálogo em estado
emitível. O **checkout público continua sem emitir** — `loja-routes.js` não
tem uma única menção ao emissor, e é isso que o K2 de `test-catalogo-fiscal`
guarda.

Nenhuma migration foi necessária: o índice `idx_nfce_pedido_autorizada`, que
é a rede de baixo contra nota em dobro, já existia nos 20 tenants desde a
Fase 1.

**Um boot às 21:31 aconteceu por outra sessão e não estava registrado aqui.**
Foi ele que pôs no ar a Fase 2A e as Etapas 1, 2, 3 e 5 — quatro minutos antes
de a Etapa 6 ser salva, e por isso só ela ficou pendente. Quem for conferir o
que está em vigor: compare o `mtime` do arquivo com o
`ExecMainStartTimestamp` da unit, e não com o que estiver escrito aqui.

O de **2026-09-28 11:57**, com o 16fa6e1: acabamento do tema da vitrine (loja
do Cantinho Verde). Levou também o que a árvore tinha de outras frentes nesse
instante. Boot limpo, `NRestarts=0`.

O de **2026-09-28 10:29**, a pedido, para o **robô de lances do PCP** (sem commit ainda):
`pcp-auto-lance.js` (novo, sobe por tenant no boot do `server.js`), as rotas
`/api/pcp/robo/*` no `pcp-routes.js`, o `lerDadosPregao` no `pcp-lances.js` e
as tabelas `pcp_auto_lance` e `pcp_auto_lance_historico`, criadas pelo
`db-schema.js` no boot de cada tenant. Todo item nasce desligado e em
simulação. Boot limpo, `NRestarts=0`.

**Boot seguinte, 2026-09-28 11:03**, a pedido: a tela de IA e campanhas virou
seis páginas em `/comunicacao/` (`ia`, `campanhas`, `modelos`, `listas`,
`canal`, `relatorio`), e o boot levou o `perfis-acesso.js` (as cinco chaves
novas herdam de `conversas`) e o `perfis-api-map.js` (`/api/agenda` também
para `comunicacao-canal`). Levou também o que a árvore tinha de outras frentes
nesse instante. Boot limpo, `NRestarts=0`.

**Boot seguinte, 2026-09-28 11:44**, a pedido: o **horário marcado do sniper
do PCP** (`pcp-auto-lance.js`, `pcp-routes.js` e a coluna `horario_alvo`, que o
`pcp-schema.js` acrescenta por ALTER no boot, conferida no 1bit, reimac e
floricultura). O horário é onde o ÚLTIMO lance deve chegar, como no Comprasnet;
em branco, o robô calcula pelo encerramento. Levou também o que a árvore tinha
de outras frentes nesse instante. Boot limpo, `NRestarts=0`. **Nada pendente.**

Entre o que esse boot levou de outra frente está **a campanha legado mandando
o MODELO, e nunca a IA** (`wa-campaigns-routes.js` e `conversas-routes.js`,
editados às 11:42, antes do boot). A primeira mensagem sai do
`comm_templates` escolhido em `config.templateId`, pelo mesmo `renderizar` das
campanhas novas; campanha sem modelo não envia e fica pausada, com o motivo no
log. As duas do `1bit` (5 e 6) estavam sem modelo nesse boot: nenhuma envia até
alguém escolher um e mandar enviar. O atendente de IA, que responde a quem
escreve de volta, não mudou. Provado pela etapa 140 do verify
(`test-campanha-modelo`).

**Boot de 2026-09-28 13:20:13**, a pedido, para a campanha legado. Levou:

- o `{{primeiroNome}}` saindo do NOME do lead, como está gravado, e não da
  razão social (`comm-destinos.renderizar` aceita `pessoa.primeiroNome`; o
  cadastro de pessoas não tem esse campo e segue igual). Da razão social ele
  saía errado em 5.859 dos 27.361 pendentes do 1bit ("RETRO 230" virava
  "Olá A.");
- o **horário de envio valendo**: `horario_permitido` (início, fim e dias)
  era gravado pela tela e lido por ninguém. Fora dele o laço espera e confere
  de minuto em minuto; horário ilegível pausa a campanha com o motivo no log.
  A campanha 5 do 1bit tem 09:00–18:00, segunda a sexta;
- o atendente de IA deixando de ler a `persona` e o `briefing` da campanha:
  a persona é a de Canal › Instruções da empresa, e o contexto de campanha
  leva só o nome dela;
- a remoção do motor da IA do `wa-m1-utils.js` (`gerarM1`, `buildM1Messages`,
  `validarM1`) e das rotas `/ramos`, `/segmentos/previa`, `/exemplos` e
  `/exemplos/previa` do `conversas-routes.js`, que perderam a tela.

Levou também o que a árvore tinha de outras frentes nesse instante. Boot
limpo, `NRestarts=0`.

**Boot de 2026-09-28 21:31:41**, a pedido, depois do backup `backups/db/2026-09-28-2130`: **campanha nova para contato avulso.** Boot limpo, `NRestarts=0`; conferido `comm_envios.pessoaId` opcional no 1bit, josecarloscostafilho e reimac. **Nada pendente.**
`comm_envios.pessoaId` era `NOT NULL`, e o disparo falhava com "NOT NULL
constraint failed: comm_envios.pessoaId" em qualquer lista com contato sem
ficha de cliente (planilha, digitado, legado): foi o caso da campanha
"exemplo" do 1bit. O boot chama `comm-destinos.permitirEnvioAvulso`, que
reconstrói a tabela com `pessoaId` opcional (ensaiado nas 20 empresas: 18
reconstruídas, 2 sem a tabela; nenhuma tinha envio gravado). Arquivos:
`comm-destinos.js`, `comm-routes.js` (os dois inserts chamam a função antes;
"Ver envios" passou a `LEFT JOIN`, com o nome do avulso vindo da lista) e
`db-schema.js`. Só o servidor web carrega esse caminho.

**Boot de 2026-09-28 18:37:43** (servidor web) e **18:38:09** (scheduler), a
pedido, depois do backup `backups/db/2026-09-28-1836`: **vários números de
WhatsApp.** Boot limpo nos dois, `NRestarts=0`. Conferido em produção: no 1bit o
canal 1 é o `status1bit`, padrão, com a IA ligada, escopo `campanha` e as
instruções de 2.583 caracteres; as 980 conversas estão no canal 1, com
`UNIQUE(canal, jid, canalId)`; a fila e as mensagens não têm linha sem número.
No josecarloscostafilho, 42 conversas no canal 1. **Nada pendente.** O que
mudou, como estava descrito antes do boot:

Mudou SCHEMA no boot: o `db-schema.js` chama `whatsapp-canais.migrarCanais`, que
cria `whatsapp_canais`, põe `canalId` em `whatsapp_queue`, `wa_campanha_dest`
e `comm_envios`, `canais` em `comm_campanhas`, e **reconstrói
`conv_conversas`** com `canalId` na chave única (uma conversa por contato E
número, mesmos ids). O número de cada empresa vira o canal 1, padrão, com as
chaves `whatsapp_ai_*`, `whatsapp_horario_*` e `limite_*` copiadas; as da
`config` ficam sem leitura. Ensaiado em cópia das 20 empresas: nenhum erro,
conversas iguais antes e depois (1bit 980, josecarloscostafilho 42), menos de
300 ms cada. Arquivos: `whatsapp-canais.js` (novo), `whatsapp-adapter.js`,
`whatsapp-webhook.js`, `conversas-routes.js`, `roteiros-routes.js`,
`wa-campaigns-routes.js`, `comm-routes.js`, `db-schema.js`. O `scheduler.js`
também carrega o adapter (cobrança, OS), e por isso foi reiniciado junto: as
mensagens do sistema saem pelo número padrão e contam no ritmo dele.

**Boot de 2026-09-28 17:20:58**, a pedido, com o `comm-routes.js` e o `comm-imagens.js` abaixo. Boot limpo, `NRestarts=0`; conferido no 1bit que as rotas novas respondem.

O que ele levou: **`comm-routes.js`.** A lista de contatos
ganhou importação de planilha (`POST /api/comm/listas/:id/importar`, colunas
Telefone, Nome e Ramo) no lugar do campo de números à mão, e o ramo de cada
contato ficou editável (`PUT /api/comm/listas/membros/:id`); sem ramo próprio,
vale o `cnaeDescricao` da ficha do cliente. O `POST .../membros` deixou de
aceitar `manuais`. A tela `listas.html` estava no ar antes do boot.

**E as imagens do modelo** (`comm-imagens.js`, novo;
`comm-routes.js` e `wa-campaigns-routes.js`). O modelo passou a ter um conjunto
de imagens em `data/tenants/<slug>/comm-imagens/modelo-<id>/`, e os dois
motores sorteiam uma a cada envio; na campanha legado, as do modelo valem
quando existem, e senão as da campanha. As rotas são
`/api/comm/templates/:id/imagens[/:arquivo]`; as da imagem única
(`/imagem`) saíram, e a coluna `imagemPath` ficou no banco sem leitura
(nenhum modelo de nenhum tenant tinha imagem). 

**Boot seguinte, 2026-09-28 12:05:34**, a pedido: **a escada do robô do PCP**,
no `pcp-auto-lance.js` e no `lerRanking` do `pcp-lances.js`. Boot limpo,
`NRestarts=0`. **Nada pendente.** Esse boot pegou o `sandbox` ACTIVE (ativado por
outra sessão às 11:52 para prints e suspenso às 12:05:53): só o servidor web
reiniciou, e o sandbox não tinha robô ligado nem agendamento de IA, então o que
o boot armou para ele fica ocioso até o próximo restart. O scheduler, que arma
recorrência e régua, não foi reiniciado.

**Boot seguinte, 2026-09-28 12:59:06**, a pedido: **a largada do sniper do PCP**, no
`pcp-auto-lance.js`. O primeiro lance real (12:17, Serra) chegou ~1,9 s depois
do horário marcado: a janela de armamento de 1,5 s era menor que um ciclo
(tick de 1 s mais leituras de ~670 ms), e com isso o disparo saía tarde. Perto
do fim, a trava de "chega antes do fim" fazia o robô DESISTIR do lance (etapa
F12 da `test-pcp-auto-lance`, com o armamento antigo: nenhum envio em 3 de 3).
Agora arma 20 s antes, prepara as leituras antes da hora e espera o
milissegundo da largada para enviar; a trava de fim considera a margem do
relógio.

Junto, no `pcp-client.js`: a sessão do PCP vale 5 min fixos e o login leva
~6 s. Se ela vencesse entre o armamento e a largada, a leitura da preparação
pagaria o login e o lance se perderia (etapa F13: nenhum envio sem a
renovação). O `renovarSeVencerEm` renova no armamento, e logins simultâneos
passam a compartilhar um só. O monitor, a proposta e a tela de salas do PCP
usam o mesmo `pcp-client`. Boot limpo, `NRestarts=0`. **Nada pendente.** Quando o líder está
abaixo do piso, o robô lê a "Colocação dos Participantes" e cobre o concorrente
de menor valor à nossa frente que o piso ainda alcança. Empatado conta como à
frente, porque a ordem dos empatados nessa tabela troca de uma leitura para
outra.

O `enviarLance` do PCP nunca tinha sido usado em produção até esse boot: o
primeiro lance real do robô é também o primeiro do sistema no PCP. O relógio
do portal só existe com resolução de segundo, tanto na `horaAtual` da aba
quanto no `apipcp.../hora` que a tela deles usa. Não há fonte com
milissegundos, e o robô estima o desvio cruzando as leituras (±0,7 s medido em
28/09).

O de 09:42, com o 8b68689, levou o certificado aberto em memória (sem
temporários do `pem` em /tmp) e o `/api/nfe/status` respondendo para o PA.

O de 2026-09-27 21:53, no fechamento da floricultura, foi para a correção do
manifest da loja (5231601). O das 21:06 do mesmo dia, junto do scheduler, levou o b6bb88d:
senha do certificado cifrada (as quatro senhas existentes migraram no boot:
1bit, produtosbomgosto, reimac e josecarloscostafilho), a loja como página
inicial, kit, opções, custo, lucro, contato e promoção. Levou também o que
outras frentes deixaram na árvore sem commit: `analise-ia*.js`, `bll-*.js`,
`bnc-*.js`, `comprasnet-anexos-routes.js`, `comprasnet-mensagem-routes.js`,
`licitacoes-routes.js`, `proposta-routes.js`, `perfis-api-map.js`, os trechos
delas no `db-schema.js`, `electron-routes.js` e `loja-routes.js`, e os
untracked `coleta-comprasnet-fila.js` e `comprasnet-participacao.js`. Boot
limpo, `NRestarts=0`. **Nada pendente.**

O boot anterior, pelo journal, foi de **2026-09-26 16:54**, de outra sessão, e
não estava registrado aqui (esta nota dizia 25/09 10:59). Levou o horário de Marabá do restaurante, do monitor
de chat, do WhatsApp e dos relatórios de OS (9f15a5c). O das 09:35, a pedido,
para o card de Interesses: levou só o `proposta-routes.js`
(sem commit), com os campos do grid de detalhes e as mensagens do Comprasnet
por licitação. O anterior, de 24/09 17:37, levou o `control-plane-routes.js`
logo depois da instalação da cópia do provisionamento de vhost; o das 11:25, o
kanban do CRM por etapa (`crm-routes.js`); o das 10:58, as recorrências do
fa0b754, o sync do PNCP e o `ssl-certificados-routes.js`. **Nada pendente.**

**O card de Interesses virou o mesmo da busca** (25/09/2026): faixa
Detalhes / Arquivos / Quadro de avisos, com o CSS movido da `consulta.html`
para o `app-modern.css` — as duas telas leem a mesma definição agora. O grid
passou de 6 para 13 campos; Esfera e Modo de disputa ficam de fora porque o
catálogo não tem essas colunas.

Dois ajustes a pedido, no mesmo dia: o **"Ver no PNCP ↗" saiu da faixa de
seções** e foi para o alto do card, junto do "Site de origem" — os dois
destinos externos no mesmo lugar. E o **badge "✓ Proposta enviada" sob o
título saiu**: dizia o mesmo que o botão ao lado de Análise IA, que ainda por
cima é acionável. A data que só o badge trazia virou o `title` do botão
("Proposta enviada em 25/05/2026, 18:58 — clique para ver os envios").

O botão de proposta é **um só**, e troca de papel: sem proposta leva ao
portal, com proposta lista o histórico. O sinal é `kanbanStatus`, e NÃO o
histórico de envios — este só enxerga quem gravou a chave PNCP, e os envios
de BLL e BNC anteriores a 21/09/2026 ficaram sem ela (medido no 1bit: 37
licitações com kanban `enviada` contra 3 rastreáveis, e as 3 estão dentro das
37). Quem já enviou reenvia pelo modal, que ganhou um "Enviar nova proposta".

**A aba Mensagens casa por UASG + numeroCompra + ano, nunca pela chave do
PNCP.** `chat_mensagens` engana pelos nomes: `cnpjOrgao` guarda a UASG (8
dígitos) e `sequencial` guarda o numeroCompra. Um JOIN por cnpj/ano/sequencial
devolve ZERO — medido sobre 4.391 mensagens. Pelo casamento certo são 722
mensagens em 39 das 172 licitações de interesse. A rota é
`/api/interesse/mensagens`, e não `/api/chat/...`, porque o RBAC é fail-closed
por prefixo e `/api/chat` pertence à página do monitor.

Duas ressalvas do mesmo trabalho: a aba só aparece quando há mensagem (seria
aba morta em 133 das 172), e o contador é o TOTAL, não "não lidas" — `lido`
está em 0 nas 4.391 mensagens, então um contador de não lidas mostraria o
total para sempre. Se for para usar leitura, apure antes por que ela nunca
pegou.

**As mensagens só aparecem com o filtro em "Todos os prazos".** As 39
licitações que têm mensagem estão TODAS com o prazo de propostas encerrado, e
a tela abre em "Em aberto" — não é defeito, é a natureza do dado: a sessão de
disputa, onde o agente de contratação fala, acontece depois do encerramento
das propostas. Quem abrir a tela no padrão não vê aba nenhuma.

**O filtro de órgão é busca, não lista** (25/09/2026). Era um `<select>` com
uma opção por órgão, ordenado por quantidade: 149 órgãos para 172 licitações,
140 deles com uma só — ou seja, 140 opções "(1)" em ordem arbitrária, com o
nome cortado em 40 caracteres (o maior tem 86). Agora é o `.autocomplete-*` do
`app-modern.css`, o mesmo componente de `fiscal/nfse.html`, com filtro local
(os órgãos já estão em memória, não há chamada nova).

O `<select>` virou `<input type="hidden" id="filtroOrgao">` mais um campo de
busca ao lado. **O id e o `.value` foram preservados de propósito**: são o
contrato de `aplicarFiltro` e de `interesse-relatorio.js:234`, que imprime o
órgão no cabeçalho do relatório. A busca casa todos os termos em qualquer
ordem e ignora acento nos dois lados — o PNCP grava "SAO PAULO" sem acento e
quem digita escreve "são".

**ÓRGÃO e UNIDADE são nomes diferentes da mesma compra, e quem procura usa o
errado.** O Comprasnet mostra a UNIDADE compradora; a tela de Interesses
agrupa pela `razaoSocial` do PNCP, que é o ÓRGÃO. Medido em 25/09/2026 nas 81
licitações de interesse com participação no portal: **80 têm nomes diferentes
nos dois lados** (só 1 coincide), e em 71 delas o nome do Comprasnet é
exatamente o `nomeUnidade`. A diferença pode ser total —
`COMISSÃO REGIONAL DE OBRAS DA 8º REG MILITAR` no portal é
`COMANDO DO EXERCITO` no PNCP; `ESP-DIRETORIA TEC. INFORMACAO E COMUNICACAO` é
`SAO PAULO SECRETARIA DA SEGURANCA PUBLICA`.

Por isso a busca olha os DOIS nomes, e o item da lista mostra a unidade
embaixo **só quando foi ela que casou** — buscar "obras" e receber "COMANDO DO
EXERCITO" sem explicação pareceria defeito. O agrupamento continua por órgão,
então `COMANDO DA MARINHA (12)` segue trazendo as 12 unidades de uma vez.

O que isto NÃO resolve: colar o nome inteiro do Comprasnet quando a grafia
diverge. A `56319882000107-2026-27` é `CONSELHO REGIONAL DE FONOAUDIOLOGIA 2A
- SP` no portal e `... 2 - SP` na unidade do PNCP — o "A" a mais derruba o
casamento por substring. Digitar um trecho resolve; casar grafia divergente
exigiria comparação aproximada, que traz falso positivo.

**O kanban do CRM carrega por coluna.** `GET /api/crm/oportunidades` aceita
`porEtapa=N` (1 a 500): traz os N primeiros de cada etapa mais `totais`
(`{etapaId: {n, soma}}`), e com `etapaId` + `offset` pagina uma coluna. Sem
`porEtapa` a resposta é a antiga, com LIMIT 1000 no funil inteiro, e era esse
teto que cortava as colunas e fazia o contador da tela contar só o carregado.
A tela pede 50 por coluna e carrega mais ao rolar até o fim. **A reordenação do
arrastar só renumera os cards presentes na tela**, e continua coerente porque o
carregado é sempre o começo da coluna; por isso a ordem tem `o.id` como
desempate.

[Tirado em 02/10/2026: aqui o texto mandava reiniciar pelo `reiniciar-com-sandbox-suspenso.sh` enquanto o sandbox estivesse ACTIVE. Com dois demos isso não vale; ver o CLAUDE.md, "Reiniciar com um demo ACTIVE".]

### O incidente da rajada de 22/09 e as quatro correções que saíram dele

Numa dispensa (item 1 da `92661806000202026`, fim às 14:00:00) a rajada desceu
de R$ 57,68 a **R$ 17,55** em quatro lances, quando o primeiro — R$ 42,37 — já
tinha nos deixado em primeiro. Quatro defeitos somados, todos em
`sniper-lance-routes.js`, todos corrigidos neste boot:

1. **`cancelar-blitz` não desarmava o `setTimeout`.** A blitz é registrada com
   `_mkBlitzKey` (`compra-item-alvoMs`), mas o timer era gravado com a chave
   curta `compra-item`, que nunca existe. O campo `timer` ficava `null`, o
   `clearTimeout` não rodava, e o disparo acontecia mesmo com o registro
   apagado da memória, do banco e marcado "cancelada" no histórico. Naquele dia
   isso pôs **três rajadas no ar ao mesmo tempo** (duas supostamente
   canceladas), que pisaram umas nas outras: uma delas mandou R$ 32,12 quando
   outra já nos tinha levado a R$ 17,55, e o portal recusou com "o lance deve
   ser melhor que seu último lance". **Vale só para a rajada global** — a rota
   de blitz individual grava o timer certo e ainda tem o `blitzGruposPorAlvo`.
2. **A rajada não relia o estado entre um degrau e outro.** Agora o laço de
   rodadas lê `melhorValorGeral`/`melhorValorFornecedor` da resposta do próprio
   POST de lance (sem chamada extra) e descarta o resto do lote assim que os
   dois coincidem. Rodando contra as respostas reais daquele dia, a rajada para
   em R$ 42,37. A mesma guarda cobre o recálculo pós-422, que senão reabriria a
   escada.
3. **A config era uma foto do agendamento.** Piso, agressividade e variação
   vinham da consulta de itens elegíveis feita ao agendar; ajuste posterior na
   tela era ignorado sem aviso. Naquele dia a agressividade passou de 5% para
   2% oitenta segundos após o agendamento e o disparo usou os 5%. Agora são
   relidos no disparo. **`maxLances` continua sendo o do agendamento de
   propósito**: o milésimo é dimensionado para N lances, e mudar N no disparo
   estouraria a janela do auto-cálculo.
4. **Os degraus ignoravam a agressividade.** Eram interpolação linear de `topo`
   até o piso — `(topo - piso) / N` —, então quem mandava no tamanho do passo
   era o PISO. Com piso de R$ 1,00 e topo de R$ 42,37 deu degraus de R$ 8,27 e
   o último lance cravado no piso. Agora cada degrau usa a mesma regra do
   primeiro (o maior entre o degrau mínimo legal e a agressividade sobre a
   folga restante), e o piso voltou a ser só o limite inferior.

**O milésimo do disparo é onde o ÚLTIMO lance deve CHEGAR, não onde a rajada
começa.** A rajada daquele dia fora agendada para `13:59:59.970` com 5 lances,
deixando 30 ms para algo que leva ~718 ms. Deixar o milésimo em branco faz o
auto-cálculo (`sniper-lance-routes.js:3545`) reservar a janela pelo número de
lances: 76 ms de ida, mais (N−1) × 153 ms, mais 30 ms de folga.

**Sobre o adversário:** os lances dele saíram em 44,5499, 33,759 e 17,3745 —
exatamente 1% abaixo de cada lance nosso, sem arredondar para centavos, e a
resposta ao nosso R$ 17,55 veio em menos de 131 ms (nosso RTT medido foi
162 ms). É robô que cobre no talo da variação mínima e segue quem descer.
**Escada descendente contra robô assim não vence: ela arrasta os dois para
baixo, e quem tem o piso mais fundo termina pior.**

Esse boot pôs em vigor também **as duas guardas do alerta de SSO morto** e,
junto (desde o boot das 11:08),
**o campo que alimenta o filtro por fase** (`situacaoCompraNome` em
`/api/interesse`, nas duas variantes, PG e SQLite), que esperava restart desde
o dia 21.

**O alerta de SSO morto passou a considerar todas as instâncias do tenant.**
`sniper-lance-routes.js` cala o aviso enquanto qualquer Electron estiver
capturando bearer, e guarda 30 min de cooldown entre mensagens. O defeito:
duas instâncias do `1bit` reportavam ao mesmo tempo — a 5.9.1 capturando
(`ssoMorto=0`) e a 7.4.0 presa no gov.br desde as 09:48 (`ssoMorto=1`) —,
alternando heartbeat a cada 15s. A flag `_ssoMortoAlertado` é uma só por
tenant: a saudável zerava, a presa rearmava, e saiu **um alerta a cada 30
segundos**, 193 no total. Pior que o volume: o aviso era falso, porque a
captura nunca parou (`Validação token: HTTP 200 → VÁLIDO` de minuto em
minuto) e não havia login manual a fazer.

O corte da janela sai do JS, em ISO-8601, e não de `datetime('now')`: o
`recebidoEm` é gravado com `toISOString()` (T e Z), o SQLite formata com
espaço no lugar do T, e `' ' < 'T'` faria a comparação lexicográfica casar
linha demais. O `DELETE` de purga do mesmo endpoint tem esse problema e
segura heartbeat velho além das 24h que promete — não mexido.

Sobre o boot das 21:29 do dia 21: ele foi disparado para renovar as conexões do pool
depois da troca de fuso do PostgreSQL, e **não era necessário** —
`pg_reload_conf()` aplica `timezone` também às sessões já abertas. O serviço
voltou limpo (HTTP 302 no `/health`, `NRestarts=0`).

**O PostgreSQL do catálogo saiu de `Europe/Berlin` para `America/Sao_Paulo`**
em 21/09/2026, por `ALTER SYSTEM SET timezone` + `pg_reload_conf()`. Estava no
fuso do pacote desde sempre, e o desvio mudava o dia de 2.154 das 105.071
licitações de 60 dias nos casts `::date`. O SQLite dos tenants continua
gravando `CURRENT_TIMESTAMP` em UTC — as duas fontes divergem entre si, e
cruzá-las exige converter uma das duas.

**Os dois roteiros do `1bit` já estão semeados**: #1 visita e #2 WhatsApp,
conferidos no banco em 18/09 às 16:47. O aviso anterior, de que o semeador ainda
não tinha rodado, estava desatualizado — ele rodou às 12:39, logo após o boot que
criou as tabelas.

Esse restart pôs em vigor **os segmentos editáveis e o ramo nas listas**, e o
backfill já rodou: **os 27.775 membros de lista do `1bit` têm ramo**, trazido de
`wa_campanha_dest` pelos últimos oito dígitos do telefone. Nenhum ficou de fora.
A distribuição é 10.528 em genérico, 4.312 vestuário, 2.854 beleza, 2.770
alimentação, 2.552 material de construção, 2.064 mercado, 1.241 bebidas, 878
cosméticos e 576 atacado.

`scripts/backfill-ramo-listas.js <tenant>` só conta; só grava com `--aplicar`, e
só preenche quem está sem ramo. Serve para os outros tenants quando precisarem.

**Segmento agora é dado da campanha, não código.** `config.segmentos` é uma
lista de `{ chave, palavras }`, e `chaveDoRamo` recebe os segmentos por
parâmetro. Campanha sem `segmentos` usa os embutidos, então nada mudou para
quem já existia. A tela deixa renomear, criar e remover, e **renomear leva as
frases de dor junto** — sem isso o segmento novo nasceria sem dor e o antigo
viraria órfão no config (etapa C6c de `test-campanha-segmentos.js`).

**Palavra, e não regex.** As regras antigas eram alternativas de substring, sem
âncora nem quantificador, então "contém" faz o mesmo casamento. Deixar o usuário
escrever regex traria erro de sintaxe e expressão cara rodando sobre 15 mil
contatos. E a tela tem o botão **"Ver quem cai onde"**, que conta a distribuição
antes de salvar: acrescentar uma palavra move gente na frente de milhares de
contatos, e sem a prévia isso se faz às cegas.

**Campo com teto de altura vira barra dentro da barra da página.** Os textareas
de frases e palavras tinham `max-height`, e o auto-ajuste parava ali: o campo
ganhava rolagem própria e a tela ficava com duas barras, o que faz quem edita
perder o lugar onde estava. Agora eles crescem com o conteúdo e a página é a
única que rola. A exceção é o JSON avançado, que fica dentro de um `details`
fechado — ali a barra própria é o certo, senão um config de 2.000px empurraria a
página inteira. A etapa C4g de `test-campanha-segmentos.js` guarda isso: nenhum
elemento visível pode rolar por conta própria.

Uma armadilha de diagnóstico que apareceu no caminho: o wrapper das suítes
declarava o iframe sem `display:block`, e os 4px de descida de linha do inline
faziam o shell de teste "rolar". No shell real o `#conteudo` é `position:fixed`
e não rola nunca. O wrapper foi corrigido para não induzir ao erro de novo.

**Campanha virou PÁGINA, uma só para as duas origens**, em
`public/comunicacao/campanha.html`. Os dois modais saíram do `ia.html`, que
encolheu de 115 para 84 ids e de 61 para 44 funções. A origem decide as seções:

| endereço | o que abre |
|---|---|
| `?id=5` | campanha legado: abordagem, exemplos, segmentos, imagens, ritmo, JSON |
| `?comm=7` | campanha nova: mensagem e público |
| `?nova=1` | criação de campanha nova |

Para quem usa, "campanha" é uma coisa só — o módulo é que foi construído duas
vezes. As seções são mutuamente exclusivas por `data-modo`, e o índice da
esquerda se monta com as do modo. **Campo que não vale no modo fica escondido**:
o limite diário só existe na legado, porque na nova o teto é do tenant. Ela é estática e não depende de restart; o RBAC não precisou de
entrada nova, porque página de detalhe em `/comunicacao/` herda o acesso do
módulo (conferido: quem tem `conversas` abre, quem não tem é barrado).

**O campo "Exemplo de mensagem pronta" nunca fez nada.** `template_referencia`
aparecia em dois lugares no sistema inteiro — a tela lia e a tela gravava — e
NENHUMA linha do gerador o consumia. Quem molda a primeira mensagem são
`exemplos_bons` e `exemplos_ruins`, que só existiam no JSON avançado (3 e 6 na
campanha `leads-pa-erp-m1`). A tela passou a editar esses dois, e o valor antigo
aparece como aviso, com um botão para aproveitá-lo, em vez de sumir calado.

**Modelo de mensagem e exemplo são opostos, e misturá-los quebra o envio.** O
modelo sai LITERAL, com `{{primeiroNome}}` trocado no disparo; o exemplo é
IMITADO, e o gerador não substitui nada nele. Por isso "trazer de um modelo"
RESOLVE as variáveis no servidor (pela mesma `comm-destinos.renderizar` dos
disparos, mais os marcadores de chave simples do gerador) antes de gravar.
Copiar a chave crua ensinaria a IA a escrevê-la, e ela sairia assim para o
cliente.

Esse boot pôs em vigor **o vencimento da fatura pela condição de pagamento**.
`faturas-routes.js` lê a condição gravada no PEDIDO (`pedidos.politicaPrazoId`)
antes de cair na do cadastro do cliente, como `os-routes.js:2431` já fazia, e
`pedido.dataFaturamentoPrevista` **não vale mais como data de vencimento**. Ela
responde quando a nota seria emitida, e não quando o cliente paga; enquanto
entrava na conta, todo pedido com ela preenchida nascia vencendo nela, por cima
da condição.

O estrago que motivou a correção, no `produtosbomgosto` em 18/09: quatro faturas
com "Boleto 30 dias" venceram na emissão, e as NF-e 176, 178, 179 e 181 foram
autorizadas com `indPag=0` e sem `<dup>`, porque `nfe-emit-routes.js:845` deriva
isso do vencimento das parcelas. As contas a receber 24, 26 e 27 foram
recalculadas à mão para 03/10 e 12/10; **as notas não têm conserto por aqui**.
Nenhum outro tenant foi atingido.

**Um efeito colateral que é correto e muda comportamento:** `prazoCliente` também
comanda o parcelamento, então um pedido com condição "30/60/90" passa a nascer
com três contas a receber em vez de uma. Antes isso nunca acontecia quando havia
data prevista preenchida, porque a data bloqueava o caminho.

Esse boot pôs em vigor também **a guarda de ambiente do Asaas**.
`boleto-provedores-routes.js` entrega o `ambiente` ao `validarConfig` do
provedor, que antes o recebia sempre `undefined` — a regra de coerência existia
em `boleto-provedores/asaas.js` e nunca executava. Agora Produção exige chave
`$aact_prod_`, e chave `$aact_prod_` com ambiente Homologação é recusada. A
recusa inversa é assimétrica de propósito: chave de sandbox sem marcador de
ambiente (formato antigo do Asaas) continua aceita. O `ambiente` segue fora do
`configJson`, porque a coluna `ambiente` já o guarda.

**`liciteagora.service`** (o `scheduler.js`) — boot atual: **2026-09-29
09:51:49**, junto do servidor web, pela troca de slug (ver acima). Com ele,
a pendência de 28/09 logo abaixo deixou de existir. O anterior foi o de
**2026-09-28 09:42**, com o 8b68689, junto do servidor web: o `nfe-emit-routes.js` que as
recorrências usam passou a abrir o certificado em memória.

**Em vigor desde o boot de 2026-09-30 15:01:09, a pedido (limpo, `NRestarts=0`):
a importação automática do extrato.** O `scheduler.js` chama
`agendarImportacaoExtrato(db)` por tenant, ao lado do polling de boletos: de 6
em 6 horas, as contas com `extratoAuto = 1` têm os últimos 7 dias importados
sozinhas. Conferido no boot: 7 linhas de `[Extrato] Agendado`, o mesmo número
do `[Polling Asaas] Agendado`, que são os tenants ativos que o master percorre.

**Nenhum tenant tem a opção ligada**, então hoje o ciclo acorda e não faz nada.
Quem ligar passa a receber o extrato sozinho; reimportar o mesmo período não
duplica, porque a chave é o identificador da transação no provedor. O
`agendarImportacaoExtrato` chama o `migrarDB` da conciliação no agendamento,
porque o scheduler não registra rotas e passou a escrever em
`transacoes_bancarias`: sem isso a primeira importação dependeria de o servidor
web ter bootado antes.

**Pendente (28/09, c323e54):** seis arquivos do estoque que o scheduler
carrega (`estoque-routes.js`, `ordem-pt.js`, `precos-routes.js`,
`farmacia/farmacia-routes.js`, `reservas-routes.js`, `nfe-entrada-routes.js`):
saldo arredondado em 3 casas e ordem alfabética em português, nada que o
scheduler mostre em tela. Não foi reiniciado porque o boot levaria junto
trabalho de outras frentes sem commit, alterado depois das 09:42: o
`whatsapp-adapter.js` das campanhas, o `db-schema.js`, o robô do PCP
(`pcp-schema.js`, `pcp-client.js`), `perfis-acesso.js`, `perfis-api-map.js`
e `loja-routes.js`. O servidor web já roda as correções desde o boot das
13:20, feito por outra sessão.

O de **2026-09-27 21:06**, no fechamento da floricultura (b6bb88d), junto do servidor web. Tem a
chave do certificado no ambiente (drop-in `chave-certificado.conf`) e levou a
árvore inteira, inclusive o `scheduler.js` de outras frentes. Os seis
sandboxes estavam SUSPENDED nesse boot, então **os jobs do sandbox descritos
abaixo ficaram desarmados**, e a recorrência de 01/10 não roda nele.
**Nada pendente.**

O boot anterior, pelo journal, foi de **2026-09-26 01:50**, de outra sessão, e
não estava registrado aqui (esta nota dizia 24/09 09:47, o que carregou as
recorrências do fa0b754 e o sync do PNCP das 09:45).

**Aquele boot armou os jobs do sandbox**, que estava ACTIVE para a gravação: 7
tenants em vez de 6. A régua não tem o que cobrar nele (clientes com
`cobrancaAtiva=0`, sem SMTP nem WhatsApp). A recorrência do dia 1 rodaria em
**01/10 08:00** e deixaria "Falhou em 10/2026" nas 250 linhas. [Tirado em
02/10/2026: a instrução de desarmar pelo `reiniciar-com-sandbox-suspenso.sh`,
que não vale com dois demos.]

**A recomposição do catálogo depende da varredura de 45 dias, e ela perdia um
dia inteiro por uma recusa isolada.** O incremental olha 2 dias e a verificação
rápida 3; só `verificacaoCompletaDiaria` enxerga o histórico. Medido em 23/09
pela hora de ingestão: o pico das 3-4h concentra 8.408 licitações contra
algumas centenas nas outras horas, e esse pico é ela rodando. Três correções
neste boot:

- ao ser recusada pela API, ela reagendava para as 3h do DIA SEGUINTE. Agora se
  declara `incompleta` e repete em 25 min.
- só rodava às 3h, então uma parada que começasse às 4h ficava 23 horas sem
  ninguém corrigindo. Agora há uma passada 4 min após o boot.
- ela não respeitava o cooldown de 20 min: gastava uma chamada durante o
  silêncio, tomava 429 e **rearmava o próprio silêncio** a cada repetição, o
  que calaria a verificação rápida indefinidamente.

Os 25 min da repetição são maiores que os 20 do cooldown de propósito. Menor
que isso, a repetição cai no próprio silêncio e se gasta à toa.

**Estado do catálogo em 23/09 às 10:30**, para quem retomar: 21/09 com 323
(uma segunda normal tem ~5.500), 22/09 com 3.603 (~5.400), 23/09 com 390 — a
ingestão tem atraso natural de ~2 dias, então o dia corrente baixo é esperado.
Ontem às 18h esses números eram 201, 116 e zero, ou seja, a recomposição
começou. **A API do PNCP ainda recusa de forma intermitente** desde o
estrangulamento de 22/09; cada repetição que cai no silêncio não gasta chamada,
então não realimenta o bloqueio. Evite reiniciar este serviço enquanto isso
durar: o cooldown vive em memória e o restart o zera.

Esse boot pôs em vigor **a correção do sync do catálogo PNCP**, que estava
parado sem acusar erro: o catálogo caiu de ~5.400 publicações por dia útil
(14 a 18/09) para 104, 201 e 116 em 20, 21 e 22/09.

A raiz era `verificacao-lacunas.js` **contando no banco errado**. As escritas
vão para o Postgres desde `CATALOG_BACKEND_PG=1`, mas o
`SELECT COUNT(*) FROM licitacoes` continuava no SQLite, cuja última licitação é
de 23/05/2026. A verificação concluía que faltavam todas as licitações de todos
os dias e refazia o download completo a cada rodada — 69 rodadas em 22/09. O
PNCP respondeu com 429 e depois parou de responder: os timeouts saltaram de 223
para 2.380 entre 19-20/09 e 21-22/09. O sintoma que identifica esse estado é
específico: `https://pncp.gov.br/` responde 302 em 0,36s, com TCP e TLS
perfeitos, enquanto `/api/consulta/v1/...` fica pendurado até o timeout.

Junto vieram três guardas, e o contador honesto é a mais importante delas:
`corrigirLacuna` chamava `salvarLicitacao` **sem await** (a função é async em
modo Postgres) e incrementava na linha seguinte. Em 19/09 ele reportou
**110.219 corrigidas** enquanto o catálogo ganhava zero licitações daquele dia.
As outras duas são o teto de 800 gravações por rodada e a parada imediata no
429, em vez de pular a página e continuar batendo.

**O cursor `lastSyncDate` também apontava para o futuro** (`2026-09-29` em
22/09). O sync gravava `hoje + 7` como cursor e a rodada seguinte partia dele,
então a janela vivia dois dias à frente do calendário contra um endpoint que
busca por data de PUBLICAÇÃO: `0 licitações` a cada 5 minutos. A janela agora
termina hoje, e `calcularJanelaIncremental` recua o cursor adiantado — sem essa
guarda, corrigir só a gravação não bastaria, porque o valor contaminado já
estava no banco.

Achado menor do mesmo trabalho: os nomes das modalidades 6 e 8 estavam trocados
em `verificacao-lacunas.js`, então o log acusava "Dispensa" onde era pregão.

A suíte é a etapa 130 do verify (`test-lacunas-catalogo.js`).

O boot de 17/09 às 17:50 levou o **modelo de IA escolhido por tenant** (ver o bloco do
`consulta-licitacoes.service` acima): o scheduler carrega o `analise-ia.js`
para a análise agendada, então ele precisa do mesmo código.

O restart anterior, das 16:49, não foi rotineiro, e vale saber o tamanho dele: o boot anterior
era de **11/09**, com 42 `.js` da raiz alterados no intervalo. Ou seja, uma
semana de edições entrou em vigor de uma vez — faturamento, fiscal,
governança, conversas e as migrations do `db-schema.js`, que rodam no boot de
cada tenant. O boot saiu limpo: nenhuma linha de erro no `server.log`,
`NRestarts=0` e o master subiu em `ROLE=master`. O que motivou o restart foi a
troca do modelo do Gemini em `analise-ia.js`, que o scheduler carrega para a
análise agendada.

O medo antigo do restart deste serviço não se aplica mais.

O item do `cicloAvisoAlcadas` mais acima nesta seção **está obsoleto**: esse
ciclo foi REMOVIDO em 2026-08-21, a pedido, junto do aviso de criação, porque
mandava mensagem no Telegram e no e-mail do tenant a cada solicitação de
alçada. Há um comentário no `scheduler.js:462` registrando a remoção e como
religar. Verificado em 17/09: o símbolo não existe nem na árvore nem no HEAD.
Ou seja, reiniciar este serviço **não dispara mensagem nenhuma para destino
externo** — era essa a única razão documentada para temer o restart.

O watchdog do catálogo já está no HEAD e o `scheduler.js` da árvore é de 26/08,
anterior ao boot de 11/09, então o processo vivo já roda esta versão.
