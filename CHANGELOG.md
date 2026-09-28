# Changelog

Um bloco por "fechamento" (ver CLAUDE.md). Mais recente no topo, data
AAAA-MM-DD. Registra o que mudou em produção — que aqui é esta própria
working tree.

## 2026-09-27, senha do certificado cifrada, tenant floricultura e a loja sem a marca do ERP

### A senha do certificado A1 deixou de ficar em base64

`cert-senha.js` cifra a senha com AES-256-GCM, amarrada ao próprio pfx: a
senha de uma linha copiada para outra não decifra. A chave fica em
`/etc/liciteagora/chave-certificado.env` (root, 600), entregue às duas units
por um drop-in `EnvironmentFile=-`, e não vai no backup dos bancos. As senhas
existentes migram no boot de cada tenant (`db-schema.js`); os sete pontos que
liam a senha (NF-e, NFC-e, NFS-e, PDF assinado, Electron e os dois scripts de
mTLS) passaram a decifrar. Gravar senha sem a chave é recusado. O que fazer se
a chave se perder está no CLAUDE.md. Suíte: etapa 136 (`test-cert-senha.js`).

A prova nos tenants que emitem de verdade é `scripts/provar-cert-senha.js`,
somente leitura: consulta de status à SEFAZ com a senha decifrada e um
controle com senha errada, que precisa falhar. De passagem, o
`/api/nfe/status` de produção quebra para o PA: o `getTools` roteia como
"SVRS", que a biblioteca não converte em cUF. Não mexido.

### Tenant floricultura

Criado por `scripts/criar-tenant.js`, que segue o caminho da rota do painel
(`criarTenant` e `ligarFeature` saíram da rota para funções exportadas, sem
mudar o que a rota faz) e roda a cópia root do provisionamento. Plano
Vitalício/Interno, com produtos, varejo, fiscal, comercial, financeiro e
comunicação. `https://floricultura.liciteagora.app/`, vhost e Let's Encrypt
prontos.

O painel e a tela de Status passaram a respeitar os módulos: sem licitações,
some tudo que é Comprasnet, PNCP e agenda, e a tela nem chama essas APIs. O
painel ganhou atalhos de PDV, Produtos e Catálogo Online, cada um com o seu
módulo.

### A loja como página inicial, sem nada do ERP para o cliente

Com "Abrir o catálogo no endereço" ligado (Informações da empresa), o
visitante que abre o endereço vai para a loja; caminho desconhecido recebe um
404 com a cara da loja; favicon, ícones e manifest do ERP não são servidos. O
dono entra por `/login`, e logado o `/` volta a ser o painel. Tenant suspenso
mostra a loja fechada, com o nome e as cores dela, sem slug nem cobrança.

Para isso o static de `public/auth` (login, ícones, service worker) passou a
ser montado depois da sessão, e não antes do middleware de tenant
(`base-middleware.servirTelaDeLogin`, chamado pelo `auth-pipeline`). Host
desconhecido, que recebia a tela de login, recebe o 404 do tenant.

Tema da vitrine: cor secundária, cor da barra do navegador, fundo suave,
fonte amigável, fonte dos títulos (elegante, clássica, manuscrita, moderna),
faixa de aviso no topo, texto do rodapé e ícone da aba.

### Buquê pronto, opções que baixam estoque, custo e lucro

- Kit na loja rende o mínimo entre os componentes; antes aparecia "sob
  consulta". No balcão, a NFC-e do kit baixa cada componente. A tela do kit
  mostra o custo somado e a margem.
- A opção com insumo baixa o insumo, na loja e na comanda. As escolhas ficam
  em `pedido_item_opcoes` (tabela nova), com o insumo copiado no momento da
  compra. O cadastro de grupos e opções saiu do restaurante e está na tela do
  produto, com o grupo de texto livre (mensagem do cartão).
- Toda saída grava o custo em `custoMedioAnterior`: NFC-e, NF avulsa e pedido
  sem reserva não gravavam nenhum. Sem média, vale o custo da última entrada
  ou o do cadastro (`estoque-routes.contextoDeSaida`).
- Relatório "Lucro por produto" em Estoque › Análises: vendido, custo e lucro
  por produto e período, juntando pedido, loja e balcão, com o custo que cada
  venda tirou do estoque. Venda sem saída sai estimada e marcada.

### Clientes e promoções

- Checkout da loja e PDV pedem e-mail (opcional) e o aceite de promoções, que
  vai para os campos de LGPD com data e origem. Não marcar não descadastra.
- Promoção é a tabela de preço geral, vigente e com vigência definida
  (`precos-routes.precoPromocional`). Vale para o visitante da loja e no PDV;
  tabela sem vigência continua sendo só do cliente vinculado. A vitrine ganhou
  a seção e o selo de Ofertas.

Suíte: etapa 137 (`test-floricultura.js`), 28 casos. Cada bloco foi sabotado
numa cópia do código em `/tmp` e reprovou.

## 2026-09-26, frentes paradas no git, verify em banco descartável e fora da sessão

### Doze frentes que estavam só em produção entraram no histórico

Um commit por frente, cada um dizendo desde quando aquele estado roda em
produção, sem mudança de conteúdo: SSL e NicSRS (400cea5, com o
`test-ssl-reissue-dcv.js` que o verify já listava e faltava no git), sync do
catálogo PNCP (6935f04), CRM (6f7984e), faturas e Asaas (7a68934), loja e
catálogo online (04a1e41), modelo de IA por tenant (840e170), pop-up de
mensagem (94e1fe8), comunicação (5ff051a), agenda e roteiros com o
`route-registry.js` (186cdda), sniper (b8572d5), hora do scan (03c0bbd) e a
suíte do PDV (8979b12).

Arquivos compartilhados entraram por trecho, montados no índice sobre o HEAD:
`db-schema.js`, `menu-config.js`, `route-registry.js`, `perfis-api-map.js`,
`analise-ia.js` e `CHANGELOG.md`. Antes de cada commit, uma checagem sobre o
índice conferiu que todo `require` e todo `<script src>` local aponta para
arquivo que está no git; ao fim, os módulos centrais carregaram num worktree
limpo do HEAD.

Ficaram fora, por terem sido mexidas hoje por outras sessões: portais BLL e
BNC, licitações e interesse, shell e tema, comprasnet, electron, a numeração
dos itens no prompt da IA e os trechos de hoje do `db-schema.js` e do
`perfis-api-map.js`.

Os dois arquivos abandonados da Fase 3.5 (`public/comunicacao/conversas-nova.html`
e `public/css/app-modern-v2.css`) saíram da árvore; o documento da auditoria
já dizia que podiam ser apagados.

### Nenhuma suíte do verify escreve mais em banco de produção

36 suítes abriam para escrita o banco de um tenant interno (28 no labfiscal,
7 no jaagricola, uma no sandbox e a etapa 93 no sandbox5). A 36ª, a
`test-multideposito-lab`, guardava o caminho numa variável e escapou da busca
no código; a guarda a pegou na primeira rodada. A
`test-nfe-tributacao-integracao` apagava as regras tributárias do labfiscal a
cada rodada, e a etapa 93 esgotou os próprios CNPJs e passou a reprovar.

- `scripts/banco-de-teste.js`: `copiaDoTenant(slug)`, cópia por `VACUUM INTO`
  a partir de conexão somente leitura, apagada no fim do processo.
- `scripts/guarda-dados.js`, injetado pelo `verify.js` em cada suíte: abrir
  banco de `data/` para escrita, ou gravar arquivo lá, reprova na hora e
  nomeia a suíte. A comparação dos bancos antes e depois foi descartada
  porque a produção está viva e reprovaria toda rodada.
- A etapa 93 gera CNPJ com dígito verificador válido (1.000 de 1.000 aceitos
  pelo `cnpjValido` do sistema).
- 28 suítes deixaram de fixar o caminho da produção em `BASE`.

As 36 passaram com a guarda ligada, e os quatro bancos de origem ficaram
intocados. Seis suítes que liam um `/tmp/app-backend-schema.sql` feito à mão
passaram a usar o `lerSchema()`, como as outras 24, e a `test-farmacia-f1`
procura a planilha real da CMED em `/var/lib/liciteagora-verify/insumos/`.

### O verify roda fora da sessão, rápido ou em paralelo

- `liciteagora-verify.service`, como carlosfinezi e não como root, com
  `rodando.*` e `ultimo.log`/`ultimo.json` em `/var/lib/liciteagora-verify`.
- Trava contra duas rodadas, com código 3. Na estreia ela recusou o serviço
  porque outra sessão rodava o `npm run verify`, que é o comportamento pedido.
- `--rapido`: só as suítes ligadas aos arquivos alterados, com a lista dos
  compartilhados que obrigam o verify inteiro.
- `--paralelo N`: grupos por arquivo fixo de `/tmp` e por porta, na ordem da
  mais longa primeiro.
- `FALHAS_CONHECIDAS`: a etapa 21 reprova marcada como conhecida (o menu do
  catálogo tem 7 opções desde 21/09, e a suíte espera 6).
- Suíte parada há 30 min vira falha com nome. Falha sem linha de FALHA sai
  com o fim do stderr.
- `/tmp` próprio no serviço (`PrivateTmp`), com a trava em `/run/lock`. Sem
  isso, na estreia, 53 suítes reprovaram porque não conseguiam apagar bancos
  e perfis do Chrome de nome fixo deixados em `/tmp` por rodadas como root.

A rodada final pelo serviço, em 26/09: 136 etapas em 1.316s (21,9 min) com
4 em paralelo, contra 57 a 67 min no sequencial. Só a etapa 21 reprovou,
marcada como conhecida.

### Duas correções que a rodada exigiu

- Os três retratos do mapa de RBAC (`test-catalogo-online`, `test-fase321-ux`
  e `test-sidebar-botoes`) passam de 176 para 178 prefixos, aceitando
  `/api/roteiros` e `/api/visitas` para `visita` e `crm-funil`, decisão do
  usuário.
- `public/comunicacao/campanha.html` ganhou o `theme-boot` antes do CSS, pelo
  `scripts/inserir-theme-boot.js`. Era a única das 222 telas sem ele, e o tema
  piscava ao abrir.

### Resíduo apagado

Com backup (`backups/db/2026-09-25-1645`) e transação com contagem esperada:

- **labfiscal, 134 linhas**: 91 de auditoria das suítes de farmácia, 3 notas
  avulsas de teste de hoje com 3 itens e 2 contas a receber, e 35
  movimentações do `LAB-FERT-01` ("saldo inicial do teste" e as saídas das
  notas).
- **sandbox5, 131 linhas**: tudo o que a etapa 93 criou desde 11/09.

Ficaram, por origem desconhecida: os 6 produtos `REST-*` do labfiscal, com
comanda e ficha técnica ligadas, que nenhuma suíte cria. Ficou também uma
rodada da etapa 93 no sandbox6, que não estava no pedido.

## 2026-09-25, nomes dos quadrantes da engenharia de cardápio

A tela de Indicadores do restaurante deixou de usar o jargão da matriz de
engenharia de cardápio. Os quatro quadros e a coluna Classe da Curva ABC
passam a dizer "Vendem bem e dão lucro", "Vendem bem, mas dão pouco lucro",
"Dão lucro, mas vendem pouco" e "Vendem pouco e dão pouco lucro", no lugar de
estrela, cavalo, enigma e peso morto. Os ícones (estrela, cavalo,
interrogação, caveira) deram lugar a uma marca redonda na cor do quadro, que
também aparece na coluna Classe.

- Os identificadores da API (`estrela`, `cavalo`, `enigma`, `peso-morto`) não
  mudaram. A tradução para o nome visível mora só na tela
  (`NOMES_QUADRANTE`).
- As frases de orientação de cada quadro ficaram como estavam, porque nenhuma
  citava os nomes antigos.
- A coluna Classe e a Receita da Curva ABC não quebram linha. Com os nomes
  longos, o valor em reais partia em "R$" numa linha e o número na outra.
- `test-restaurante-engenharia.js` (C1) confere os quatro títulos, a ausência
  dos nomes e emojis antigos na tela e a cor de cada marca.

Só `public/`: está no ar desde a edição, sem restart.


## 2026-09-25, engenharia de cardápio por categoria

A matriz de engenharia de cardápio (estrela, cavalo, enigma, peso morto)
comparava cada item com a média do cardápio inteiro. A bebida vende em
unidades muitas vezes maiores que o prato e puxava a popularidade média para
cima: no retrato de alimentação, 13 dos 30 itens caíam em "enigma" e os dois
executivos em "peso morto". Agora a classificação é feita dentro de cada
categoria do cardápio: a popularidade é a participação do item na quantidade
da própria categoria, e as duas médias (popularidade e margem) também são da
categoria. A regra de classificação não mudou, e a dos 70% não foi aplicada.

- A categoria vem de `rest_cardapio_itens.categoria`. Produto em mais de um
  cardápio fica com a do primeiro pela ordem; item vendido fora de cardápio
  cai em "Sem categoria".
- A tela mostra, em cada quadrante, a participação do item na categoria
  ("54,5% de Pratos") em vez da participação nas vendas totais.
- A curva ABC continua sobre o cardápio inteiro.
- A API troca `medias` por `mediasPorCategoria`. Nenhuma outra tela lia o
  campo.
- No retrato de alimentação, a distribuição passou de 2 estrelas, 5 cavalos,
  13 enigmas e 10 pesos mortos para 6, 6, 9 e 9.

Limite conhecido: um item sozinho na categoria é sempre "estrela", porque ele
é a própria média.

A suíte é a etapa 135 do verify (`test-restaurante-engenharia.js`, 8 casos),
montada para as duas regras discordarem: com a média do cardápio inteiro,
4 casos reprovam.

O verify fechou com 15 problemas em 3.749 s, todos de outras frentes e fora
deste commit: os 14 da rodada anterior e a etapa 127
(`test-interesse-historico-tela`), cuja tela foi alterada por outra sessão às
12:43, durante a rodada.

## 2026-09-25, restaurante no horário de Marabá e CMV% colorido

Achados ao tirar os prints do anúncio de restaurante no tenant `sandbox`.

### O CMV% da lista nunca teve cor

A Ficha Técnica pintava o CMV% (até 35% verde, até 45% amarelo, acima
vermelho) no próprio `<td>`, e o `td { color: var(--text-1) !important }` do
`app-modern.css` apagava a cor em toda tabela do sistema. Nenhum tenant viu
o semáforo na lista, só no detalhe do prato, onde a cor está num `<strong>`.
Agora o valor vai num `<span>` colorido dentro da célula, na lista da Ficha e
na coluna CMV% da aba CMV dos Indicadores, que não tinha cor nenhuma. A regra
do `app-modern.css` não mudou.

### O restaurante lia hora UTC como se fosse de Marabá

O módulo grava tudo em UTC (`agora()` e `CURRENT_TIMESTAMP`), e cortava dia e
hora direto sobre esse texto. O horário de pico saía três horas adiantado
(almoço às 13h aparecia como 16h), a conta fechada depois das 21h caía no dia
seguinte e o sábado à noite contava como domingo. Nos prints, o turno aberto
às 10:30 aparecia como 13:30.

- `FUSO_LOCAL_SQL = '-3 hours'` em `restaurante-comanda.js` (America/Belem,
  UTC−3 o ano todo) entra em todo corte de dia e hora: indicadores (período,
  dia da semana, hora, cardápio, garçons, cancelamentos), gorjetas, acerto do
  entregador e CMV teórico e real.
- As telas mostram a hora em Marabá: abertura do turno no Caixa, abertura da
  comanda no Salão, entrega no Delivery e cancelamento nos Indicadores.

O mesmo defeito, fora do restaurante:

- **Monitor de chat** (`chat-mensagens-routes.js`): os filtros "hoje", 7 e 30
  dias e o contador de hoje comparavam `dataCaptura` (UTC) com o dia UTC.
- **WhatsApp** (`whatsapp-adapter.js`): o contador de envios do dia fazia o
  mesmo. O contador da linha 405, no mesmo arquivo, já convertia.
- **OS** (`os-routes.js`): o período dos relatórios filtrava `dataAbertura`
  (UTC) contra a data local da tela, e a contagem de falhas de notificação dos
  últimos 7 dias usava o dia UTC.

A suíte é a etapa 134 do verify (`test-restaurante-fuso.js`, 13 casos). As
comandas têm valores distintos para a soma denunciar o dia errado; cortando
em UTC, 8 casos reprovam.

O verify fechou com 14 problemas em 3.980 s, todos de outras frentes e em
arquivos fora deste commit: `campanha.html` sem `theme-boot`, o mapa de RBAC
com 178 prefixos (3 falhas), o menu Configurações com 7 opções (4) e a suíte de
provisionamento, que grava no `sandbox5` real e colide no CPF (6).

### Pendências declaradas

- **Histórico de turnos fechados com diferença.** A diferença do caixa do
  restaurante é gravada em `rest_turnos.diferenca`, mas nenhuma tela lista os
  turnos fechados: ela só aparece na mensagem logo após o fechamento. Não
  construído, a pedido.
- **Engenharia de cardápio mistura bebida com prato.** A popularidade média é
  calculada sobre o cardápio inteiro, e as bebidas, que vendem em unidades
  muitas vezes maiores, puxam a média e jogam quase todo prato para "Enigma".
  A regra não foi mudada; as opções estão no relato de 25/09.
- **Do mesmo padrão, e não mexido:** o scheduler compara `dataPromessa` das OS
  (data local) com `date('now')` em UTC, então a OS vira "atrasada" três horas
  antes, às 21h; `movimentacoes_estoque.data` mistura data local (quase tudo)
  com data e hora UTC (a baixa do restaurante), e a correção depende de
  escolher um formato único; o evento da farmácia (SNGPC) grava a emissão da
  NFC-e e merece conferência própria por ser regulatório.
- `test-os-equipamento.js` e `test-os-notificacoes.js` falham igual com e sem
  esta mudança (14 e 6 falhas) e não estão no verify.

## 2026-09-24, sudo do provisionamento de vhost e backup que recusa argumento estranho

### O sudo sem senha dava root a quem editasse o script do projeto

`/etc/sudoers.d/liciteagora-provision` liberava ao carlosfinezi, sem senha, o
`scripts/provision-tenant-vhost.sh` desta árvore, e o arquivo é do próprio
carlosfinezi. Qualquer processo desse usuário podia reescrevê-lo e rodar o que
quisesse como root. Antes de mexer, o script foi conferido: igual ao HEAD byte
a byte, sem mudança de conteúdo desde o 862a791 (27/08). O sudo registra uma
única execução dele, em 27/08, para o `crsolucoes`.

O conserto segue o desenho do trajeta. O sudo passa a liberar só a cópia de
posse do root em `/usr/local/sbin/liciteagora-provision-vhost`, e o
`control-plane-routes.js` chama a cópia. O `scripts/instalar-provision-vhost.sh`
instala a cópia, mostra o diff contra a que está em uso, passa a regra pelo
`visudo` antes de gravar e recusa terminar se sobrar regra apontando para a
árvore. **Mudou o script do projeto, é preciso reinstalar**, senão produção
segue com a versão antiga.

O script ganhou a guarda do slug, com a mesma regra do `isValidSlug`, porque
roda como root e a regra do sudo aceita qualquer argumento. Slug fora da regra
sai com o código 2 antes de qualquer comando do Hestia. Os 27 casos do teste
(caminho, `$(id)`, quebra de linha, reservados, limites de tamanho) batem com o
`isValidSlug`, e a mesma bateria reprova 21 deles na versão sem guarda.

Provado depois da instalação e do restart do `consulta-licitacoes.service`,
como carlosfinezi: a cópia com `crsolucoes` sai com 20 (ALREADY_OK), o caminho
antigo é recusado pelo sudo e `../x`, `a;id`, `admin` e `Ab` saem com 2. **O
caminho HTTP não foi exercitado.** O `reprovision` exige sessão de super-admin
e ficou de fora por decisão do usuário: a primeira criação de tenant real é a
prova do caminho inteiro, e deve terminar READY com `PROVISION_VHOST_OK` no
`tenant_audit`.

### O backup ignorava argumento desconhecido e apagou o conjunto de 16/09

`scripts/backup-tenants.sh --help` não mostrava ajuda: fazia um backup
completo, e a retenção de 10 conjuntos apagou o `backups/db/2026-09-16-1213`
para caber o que ninguém tinha pedido. Aconteceu neste fechamento, e o ponto
de restauração de 16/09 não tem volta. Agora `--help` e `-h` só mostram a
ajuda, e argumento desconhecido é recusado com erro antes de qualquer backup.
O CLAUDE.md, que dizia que o script não apaga backup antigo, passa a descrever
a retenção.

### O verify rodou numa cópia limpa, e ficou vermelho por duas causas alheias

A árvore tem ~120 arquivos sujos de outras frentes, e na primeira tentativa
duas etapas reprovaram por causa deles (a 19 conta os prefixos do mapa de
RBAC, a 21 as opções de um menu, e os dois mudaram de propósito). Para medir
só este trabalho, o verify rodou num `git worktree` do fa0b754 com apenas
estas mudanças por cima, bancos restaurados do backup de 24/09 17:37 e o
`BASE` fixo de 28 suítes apontado para a cópia. Resultado: 7 problemas em
3.452s, nas 132 etapas, por duas causas que não tocam nenhum arquivo daqui:

- a etapa 30 lista `test-ssl-reissue-dcv.js`, que existe na árvore mas nunca
  foi commitado;
- a etapa 93 (`test-provisionamento-tenant-novo`, que testa pedidos e faturas
  no `sandbox5`, e não o vhost) sorteia o CNPJ só pelo último dígito, e 9 dos
  10 já estão gravados no `sandbox5` por rodadas de 11/09 a 23/09.

As etapas 19 e 21 passaram na cópia, com 22 e 23 ok.

## 2026-09-24, CRM: leads por nicho e kanban por coluna

### A lista de propensão inteira entrou no CRM, um funil por nicho

A planilha `LEADS_PARA_PROPENSAO_LICITEAGORA` substituiu a
`LEADS_PARA_TELEFONES_VALIDADOS`. Os 1.000 cards desta, sem nenhuma atividade,
foram apagados, e entraram as 63.274 empresas com telefone utilizável das
72.606 da planilha. Ficaram fora 555 sem telefone e 8.777 que repetiam um
número já incluído. Os 39 setores da planilha foram agrupados em 10 nichos, e
cada nicho virou um funil com as colunas Leads, Caixa postal, Já tem ERP, Não
existe e Não disponível: Comércio (19.794), Veículos, máquinas e equipamentos
(7.434), Alimentação (5.579), Construção e engenharia (5.472), Transporte e
logística (3.842), Saúde e educação (3.500), Serviços gerais (3.305),
Comunicação e tecnologia (3.244), Indústria (1.881) e Outros e fora do perfil
(9.223). Os leads estão na coluna Leads, na ordem da propensão, e o setor
original segue na descrição do card. O funil "Ligação Licitações" foi excluído
(soft, como a tela faz).

No caminho, uma distribuição intermediária por setor desfez a classificação de
4 cards que o usuário `jonata` já tinha arrastado para as colunas de resultado.
Eles foram devolvidos às mesmas colunas, lidas do `audit_log`, dentro do funil
do nicho de cada um.

O `scripts/importar-leads-crm.js`, que entra no git agora, fez a importação e
guarda quem já entrou num controle fora do repositório.

### O kanban mostrava no máximo 1.000 cards somando todas as colunas

`GET /api/crm/oportunidades` tinha um `LIMIT 1000` para o funil inteiro, e a
tela escrevia no topo da coluna quantos cards tinha recebido. Com menos de
1.000 cards os dois números coincidiam. Com 63 mil, "Comércio varejista"
mostrava 27 de 17.364. A rota aceita agora `porEtapa=N`: traz os N primeiros
de cada etapa e os `totais` reais (quantidade e soma), e com `etapaId` e
`offset` pagina uma coluna. A tela pede 50 por coluna e carrega mais ao rolar
até o fim. Sem `porEtapa` a resposta é a antiga.

A reordenação do arrastar só renumera os cards que estão na tela. Ela continua
certa porque o carregado é sempre o começo da coluna, e para isso a ordem
ganhou `o.id` como desempate. A suíte de banco descartável e Chrome headless
confere que a coluna inteira, percorrida página a página depois de um arrastar,
não repete nem perde card.

### Telefone no card sem cliente cadastrado

Entra junto, porque a rota acima já depende dela, a coluna
`crm_oportunidades.clienteTelefoneLivre`, criada no `db-schema.js`. O card sem
cliente guarda o próprio telefone, e a tela deixou de recusar o número quando
não há cliente escolhido. É nela que a importação de leads grava.

## 2026-09-24

Três defeitos das recorrências de NFS-e, achados ao preparar a gravação do
vídeo de faturamento recorrente no tenant `sandbox`.

### O cliente recebia o e-mail da nota em dobro

`emitirNfseInterno` manda o DANFSE ao tomador sempre que a nota é autorizada,
e a recorrência mandava o dela em seguida. Com "Enviar por e-mail" marcado
saíam dois e-mails; desmarcado, saía um mesmo assim. A emissão ganhou a opção
`enviarEmailTomador`, ligada por padrão, e a recorrência a desliga: quem decide
é a caixa dela, e o e-mail é um só, com a nota e o boleto. A emissão avulsa e a
da OS não mudam.

### A conta nascia vencida quando executada depois do dia

O vencimento era sempre o dia escolhido dentro do mês da competência.
Executada no dia 24, uma recorrência com vencimento dia 10 gerava conta e
boleto vencidos no próprio dia. Agora, se o dia já passou na data da execução,
o vencimento vai para o mesmo dia do mês seguinte (`vencimentoDaCompetencia`).
Vale para o botão, para o ▶ de cada linha e para o agendamento do dia 1. De
passagem: dia 31 num mês de 30 gerava uma data inexistente; agora cai no último
dia do mês.

### "Executar todas" roda em segundo plano, com andamento na tela

Era um POST só, que esperava todas terminarem. Com centenas de recorrências
estouraria o timeout do proxy, e a tela não dizia nada enquanto isso. Agora o
POST responde na hora e a tela mostra "x de N" consultando
`GET /api/recorrencias/execucao`. No fim diz quantas foram emitidas, quantas
falharam e quantas já estavam emitidas, e recarrega a lista. Quem abre a tela
com uma execução em andamento vê o andamento dela.

- **Uma execução por tenant.** O botão roda no `server.js` e o agendamento no
  `scheduler.js`, que são processos diferentes. Por isso a trava fica no banco
  do tenant (`config.recorrencias_lote`), e não em memória. Segundo clique
  recebe 409 com o andamento da que está rodando; o agendamento não inicia
  outra por cima.
- **A trava vence em 15 minutos sem avanço**, para um restart no meio não
  travar o tenant. Quem perde a trava por vencimento para, e grava o andamento
  só se a trava ainda for sua. Sem essa conferência, a execução antiga
  sobrescrevia o estado da nova, e a nova se achava a perdedora e parava.
- **Emissão em andamento não é refeita.** Um log "processando" de menos de 15
  minutos é de outra execução viva; antes, o ▶ da linha durante o lote apagava
  esse log e emitia a mesma nota de novo.
- **O erro da última execução aparece na lista.** Era gravado e não aparecia.

A suíte é a etapa 131 do verify (`test-recorrencia-lote.js`). Ela roda a
emissão real com SEFIN, assinatura e e-mail trocados, e conta os e-mails que
sairiam. Reintroduzido cada defeito, ela reprova.

A suíte nova passa com 21 casos, e as suítes de recorrência e contrato que já
existiam (etapas 28, 102, 104, 107 e 108) continuam verdes.

### Pendências declaradas no fechamento

**O restart não foi feito, e este código ainda não roda.** A tela
(`public/`) já está no ar; o backend entra no restart dos dois serviços. Até
lá, "Executar todas" emite normalmente pelo servidor antigo, mas a tela nova
mostra "Sem resposta do servidor" no lugar do resultado. O restart ficou
parado porque outra sessão está editando, sem commit, o sync do PNCP
(`pncp-sync-scheduler.js` e `verificacao-lacunas.js`, +535 −131 linhas,
alterados às 09:45 de hoje), e os dois serviços carregam esses arquivos:
reiniciar poria no ar o trabalho dela pela metade.

O verify não fechou verde: **16 problemas em 3.690 s**, com a máquina em load
average entre 7 e 11. A etapa desta mudança passou (21 ok). Nenhuma das 16
falhas é daqui, e todas estão em arquivos que não entram neste commit:

- etapa 5 (`test-tema-global`): `public/comunicacao/campanha.html` sem o
  `theme-boot` antes do CSS. Arquivo fora do Git, da frente de campanhas (18/09).
- etapa 19 (`test-catalogo-online`): o mapa de RBAC tem 178 prefixos e a suíte
  espera 176. `perfis-api-map.js` ganhou `/api/roteiros` e `/api/visitas` em
  18/09, sem commit.
- etapa 21 (`test-catalogo-online-ux`): o menu Configurações tem 7 opções e a
  suíte espera 6. `menu-config.js` e `sidebar.js` estão alterados por outras
  frentes.
- etapas 14 e 15 (orçamento responsivo): passaram na primeira rodada do dia e
  falharam na segunda, sem arquivo delas alterado. Medição de layout sob carga,
  com outras sessões usando Chrome na máquina.
- etapa do RBAC inalterado (2 falhas): o mesmo mapa com 178 prefixos.
- etapa 93 (`test-provisionamento-tenant-novo`, 6 falhas em cascata): a suíte
  grava no banco real do `sandbox5` e gera o CPF do cliente variando um único
  dígito; rodadas anteriores já ocuparam o número, a criação dá 409 e
  confirmação, reserva, entrega e faturamento caem atrás dela.

## 2026-09-17 (noite)

O ponto de partida foi uma comparação: o painel de bot do Loctos, de um lado, e
a nossa tela de Conversas, do outro. Onze diferenças foram anotadas; o que segue
é o que saiu delas, mais a fase visual que estava parada desde 11/09.

### A escala tipográfica passa a valer para o ERP inteiro

A Fase 3.1 declarou 53 tokens de tipografia, espaçamento e superfície em 11/09 e
**não os aplicou** — de propósito, porque não havia como ver o resultado em 213
telas. O teste `A6` guardava essa decisão.

O que destravou foi medir em Chrome de verdade. E a medição mostrou o que ler o
CSS não mostra, porque `em` multiplica em cascata:

| Componente | Antes | Depois |
|---|---|---|
| botão pequeno | **9,86px** | 13px |
| marcador de estado | **8,87px** | 11px |
| cabeçalho de tabela | 10,08px | 11px |
| célula, botão, campo, aba | 12,3 a 12,6px | 14px |

O 9,86px não existe em lugar nenhum do código: nasce de `.btn` em `0.88em`
multiplicado por `.btn-sm` em `0.8em` dentro dele. A Fase 3.1 estimou 11,2px
para esse caso, no papel, e errou — estimativa não enxerga cascata. O corpo do
sistema estava declarado em 14px e quase nada usava 14px.

O `A6` foi trocado na mesma mudança: em vez de **proibir** aplicar a escala, ele
passou a **exigir** que a medição exista e esteja no verify.

### Conversas: quatro funcionalidades que o painel comparado tinha e nós não

- **Dono da conversa.** A coluna `donoId` existia desde sempre e nenhuma tela
  usava. Agora há filtros "Minhas" e "Sem dono", seletor e botão "assumir".
  Dono organiza fila e **não** vira permissão: todos continuam vendo tudo. Sem
  usuário identificado, "Minhas" devolve vazio — nunca a fila inteira.
- **Aviso de mensagem nova** na inbox, pegando carona no polling que já existia.
  Som nasce ligado, pop-up nasce desligado, e a primeira carga nunca avisa.
- **Horário de atendimento.** Fora da faixa, a IA não responde e manda uma vez a
  cada 8 horas a mensagem configurada. O fuso é `America/Sao_Paulo` escrito, não
  o do processo: o banco grava em UTC e a unit pode mudar. Na dúvida, atende —
  configuração ausente ou ilegível não cala o atendimento.
- **Base da IA por PDF.** O texto é fatiado em vários itens porque a coluna
  guarda 4.000 caracteres; acima de 20 trechos, a resposta **diz** quantos
  ficaram de fora. PDF digitalizado é recusado com o motivo.

### A tela de Conversas virou duas, e a inbox foi redesenhada

`conversas.html` saiu de 2.272 linhas para 664 e ficou só com o atendimento;
Base da IA, Campanhas, Canal e Relatório foram para `comunicacao/ia.html`. O
estilo inline da inbox caiu de **172 atributos para 14**.

Na inbox: marca só no excepcional (as pílulas "aberta" e "sem cadastro"
apareciam em toda linha e viraram textura), avatar de iniciais com o contador de
não lidas dentro dele, números do topo que filtram ao clique — inclusive o "sem
nenhuma resposta", que antes gritava em vermelho sem levar a lugar nenhum —, um
estado vazio por região e a ficha vazia em branco.

**Partir uma tela em duas tem uma armadilha de permissão**: a metade nova entra
no menu com `page` própria e toda permissão já gravada em banco deixa de
alcançá-la. Em vez de uma migration nos perfis de cada tenant, a herança está
declarada no código (`HERDA_DE`), no servidor e no menu: quem pode ver Conversas
alcança a configuração dela, e quem nunca teve continua bloqueado.

### Pop-up de mensagem nova, inclusive com o ERP fechado

Web Push escrito à mão — `web-push` não está instalado e `npm install` é vedado
aqui. O VAPID é um JWT ES256 que o `crypto` do Node assina.

**O push vai vazio.** Ele carrega um sinal; o service worker acorda e busca nome
e trecho com a sessão da própria pessoa. O motivo não é técnico: o push passa
pelo servidor da Google ou da Mozilla, e o conteúdo é a conversa de um cliente
com a empresa.

São dois interruptores com papéis diferentes: a **chave da empresa** decide se o
sistema avisa alguém, e a **inscrição do aparelho** decide quem recebe onde.
Nasce desligado.

A primeira versão guardava a chave em `data/vapid.json` e **durou uma tarde**: o
arquivo nasceu `root:root`, o servidor roda como `carlosfinezi` e não conseguia
ler a própria chave — sem erro em log nenhum. A causa não era a permissão, era o
lugar. A chave passou para o `config` de cada tenant.

### Sete suítes novas no verify (109 a 115)

`fase35-escala` (Chrome, 8), `conversas-dono` (14), `conversas-aviso` (13),
`atendimento-horario` (25), `ia-base-pdf` (7, com PDF e `pdftotext` de verdade),
`conversas-ux` (Chrome, 24) e `push-mensagem` (22).

Quatro foram **sabotadas de propósito** para confirmar que reprovam: sem a
guarda do "minhas", sem a validação de atendente inativo, sem a guarda da
primeira carga do aviso, e com a assinatura do JWT em DER. Todas acusaram.

O `C7` do `test-pwa` também foi trocado: proibia `push` dizendo "ficou para
outra fase", e virou dois testes mais específicos — o service worker não pode
ler o payload, e a busca do conteúdo vai com sessão, sem cache.

### Também entrou, de outras frentes da mesma árvore

- **ID de modelo de IA por tenant** (`ia-modelos.js`): os cinco IDs estavam
  cravados no código e o hardcode quebrou quatro vezes em quatro meses. Agora
  mora em `config`, com o padrão no código para quem nunca abriu a tela.
- **Aviso antes da reemissão de SSL com DCV por e-mail**: esse caminho depende
  de um clique do aprovador do domínio, que é do cliente. Sem aviso, o
  certificado expira e o primeiro a saber é quem abre o site.

## 2026-09-17 (tarde)

**O contrato passa a faturar por nota avulsa.** Até aqui o bloco "Faturamento"
da tela do contrato só sabia vincular recorrência NFSe, e a recorrência é
mensal por construção: o `recorrencia-scheduler` roda dia 1 e a competência é
`YYYY-MM`. Contrato anual não cabe nela, e são **5 dos 6 contratos do 1bit**.
Na prática aquele bloco era uma porta fechada para quase todos.

Agora o contrato tem, abaixo da recorrência, a lista das notas avulsas ligadas
a ele, com duas portas: emitir uma nota nova a partir do contrato, e vincular
uma nota que já foi emitida.

- **Emitir** abre a tela de sempre, `/fiscal/nfse.html?contratoId=N`, já
  preenchida: tomador do cadastro da pessoa (com endereço e e-mail), descrição
  e valor do contrato. Código de tributação e competência continuam sendo
  conferidos por quem emite, e o número do contrato aparece na confirmação. A
  nota nasce carimbada com `nfse.contratoId`, espelhando o `nfse.osId` que a OS
  já usava. **Não existe botão que emita direto na SEFAZ** a partir do
  contrato: emissão não volta atrás, o cancelamento tem prazo e motivo, e o
  contrato não guarda código de tributação nem município de prestação.
- **Vincular** lista as notas do mesmo CNPJ ainda sem contrato. Nota de outro
  tomador é recusada, e nota que já pertence a outro contrato é recusada
  citando o número dele.

O vínculo é **1:N**, ao contrário do 1:1 da recorrência: contrato trienal com
faturamento anual rende três notas ao longo da vigência. Recorrência e notas
avulsas **convivem** no mesmo contrato, sem bloqueio — um contrato mensal pode
ter uma nota extra pontual.

Desvincular só solta a ligação. A nota segue emitida e a conta a receber dela
segue de pé.

### Duas suítes novas, e por que a de tela existe

`test-contrato-nfse-avulsa.js` (16 casos) prende as rotas: o 1:N, as duas
recusas, o CNPJ com máscara que precisa casar mesmo assim, e que desvincular
não toca na nota. `test-contrato-nfse-ui.js` (7 casos) sobe Chrome headless e
mede altura e visibilidade — existir no DOM não prova que aparece. A segunda
foi sabotada de propósito, em memória, para confirmar que reprova quando o
bloco quebra. Entram como etapas 107 e 108.

O `perfis-api-map.js` ganhou o perfil `nfse` em `/api/contratos`: o mapa é
fail-closed, e sem essa linha quem tem perfil restrito à emissão tomaria 403 ao
abrir a tela com `?contratoId=`.

### Verify

**109 etapas, zero falhas, 2.210,5s** (36min50) — é o primeiro número real da
rodada de 106 etapas, que estava só estimado em ~32 min. A rodada anterior
morreu na etapa 27 junto com a sessão que a disparou, sem falha nenhuma até
ali; esta foi relançada desacoplada, com `setsid`.

### O que ficou de fora deste commit

A árvore tinha, ao mesmo tempo, trabalho de outra sessão em voo (conversas,
WhatsApp, horário de atendimento, tema) e a frente de SSL ainda pendente. Nada
disso entrou aqui — este commit é só o faturamento do contrato por nota avulsa.
O `CLAUDE.md` também ficou de fora pelo mesmo motivo: a versão em disco mistura
a nota desta frente com a da outra.

## 2026-09-17

O fechamento por frentes aberto em 16/09 chegou ao fim. São **31 commits** que
levaram ao histórico **564 arquivos** e +107.372 / −3.700 linhas, tudo o que
rodava em produção sem estar no git desde 28/08. A árvore ficou limpa pela
primeira vez desde então.

A ordem foi a do bloco de 16/09, e a primeira frente pagou pelas outras: o
theme-boot era uma linha repetida em 147 telas, 57% dos arquivos modificados.
Depois dele, cada frente ficou legível. As estimativas caíram junto — a frente
fiscal, prevista em 36 entradas, teve 10; a financeira, prevista em 38, teve 12.

### Quatro defeitos que apareceram por causa do fechamento

Nenhum deles foi procurado. Todos apareceram ao verificar uma frente antes de
commitá-la, e é a razão de o trabalho ter valido mais que o histórico.

- **`emitirNFCe` nunca foi exportado.** A rota
  `POST /api/restaurante/comandas/:id/emitir-nfce` respondia 400 em TODA
  chamada. Ao corrigir, apareceu o segundo defeito atrás dele: o consumidor
  lia `r.nfceId` e o retorno traz `r.id`, então a nota sairia na SEFAZ e a
  comanda ficaria sem vínculo nenhum, em silêncio e com `success: true`.
- **Cancelar certificado SSL não pedia confirmação.** A função disparava o POST
  direto, com motivo fixo, para uma ação irreversível que não devolve o valor
  pago — e o botão tinha acabado de deixar de ser invisível. A suíte que prova
  isso existia desde 31/08, estava correta, e ninguém a executava porque ela
  não estava no verify. Hoje é a etapa 30.
- **`title=` no arrastar do catálogo**, resíduo de uma migração que não removeu
  o atributo antigo. Corrigido em 17/09.

### O que o fechamento corrigiu no próprio CLAUDE.md

Três descrições estavam obsoletas e a última era perigosa:

- O verify não era mais `node --check`: são 30 etapas e ~30 minutos. Quem
  esperasse segundos concluiria que travou.
- O mapa de "frentes pendentes" era de 11/08 e já fora consumido pelo commit
  181c65f, de 24/08.
- **O `cicloAvisoAlcadas` não existe desde 21/08**, quando foi removido a
  pedido por mandar mensagem a cada solicitação de alçada. Ele era a única
  razão documentada para temer o restart do `liciteagora.service`, e a página
  dizia o contrário havia quase um mês.

### Verify

Trinta etapas, **zero falhas, 1.528s**. A etapa 30 é nova. Das 130 suítes em
`scripts/`, 104 seguem fora: parte delas depende de artefatos em `/tmp` que
somem no reboot e entraria já quebrada.

## 2026-09-16

Fechamento **por frentes** das 422 entradas acumuladas desde 28/08. São 19 dias
de trabalho que já roda em produção sem estar no histórico, e levar tudo num
commit só produziria um diff que ninguém revisa. Cada frente abaixo vira um
commit próprio, nesta ordem:

1. **theme-boot**, a inserção de uma linha em 147 telas. Vai primeiro porque
   sozinha responde por 57% dos arquivos modificados. Tirá-la do caminho é o
   que torna as outras frentes legíveis.
2. **Verticais novos** (`farmacia/`, `locacao/`, `posto/`, `restaurante/`),
   cada um inteiro com o seu `public/`. O `route-registry.js` e o `db-schema.js`
   da árvore já os registram, então eles precisam entrar antes do core.
3. **Frentes de negócio**, uma a uma: fiscal, financeiro, pedidos, portais,
   loja, OS, SSL, habilitação, governança, identidade visual.
4. **Reorg de páginas**, com o `auth-bootstrap.js` no mesmo commit. As 26
   deleções já estão no índice; sem a tabela `PAGINAS_MOVIDAS` junto, o HEAD
   fica com as páginas apagadas e sem o 301 que as substitui.
5. **Core/infra** por último, conferido contra o fecho de requires do HEAD e
   não o da árvore.

O mapa de frentes do CLAUDE.md não serve de guia para esta leva. Ele é de
11/08 e foi consumido pelo commit 181c65f, de 24/08, que fechou aquelas 14
frentes. O que está na árvore hoje é trabalho posterior.

O que vem descrito abaixo é o trabalho desta sessão, e entra na frente de SSL.

### Compra de certificado SSL na NicSRS: destravada

A compra de OV/EV estava recusada havia dois dias, com mensagens que apontavam
para o lado errado. Eram **duas causas**, a segunda escondida atrás da primeira.

- **Contato do certificado SUBSTITUÍA o do tenant**, em vez de completá-lo. O
  contato gravado tem a pessoa (nome, e-mail, cargo); o do tenant é o único com
  organização e endereço. Em DV nunca apareceu — DV não valida organização — e
  todo OV anterior tinha o campo de contato vazio. O primeiro certificado a
  preenchê-lo foi o primeiro a falhar. Agora `mesclarContato` combina os dois,
  campo a campo, e campo em branco não sobrescreve.
- **`organizationInfo` é obrigatório em OV/EV e usa nomes PRÓPRIOS**:
  `organizationName`, `organizationAddress`, `organizationCity`,
  `organizationCountry`, `organizationPostCode`, `organizationMobile`. Nenhum
  coincide com os dos contatos (`organation`, `city`, `state`), e a
  documentação não os lista. **Como a lista foi obtida**: mandando um objeto
  qualquer não-vazio (`{x:1}`), a API troca o "organizationInfo is required"
  genérico por uma recusa que NOMEIA cada campo que falta; com `{}` ela trata
  como ausente e não diz nada. O bloco agora é montado do cadastro do cliente.
- Saiu junto o `Object.assign(params, org)`, que espalhava a organização na
  RAIZ do payload: entrou em 181c65f (24/08) e **nunca funcionou**, porque de
  lá até aqui nenhum certificado com cliente vinculado foi comprado.
- **Guarda `erroDadosOv`**, nos TRÊS caminhos que chegam ao `/ssl/place`: num
  OV/EV com contato ou organização incompletos, recusa antes de gastar a
  chamada, dizendo o papel e o campo em português. DV passa livre — barrá-lo
  bloquearia compra que a NicSRS aceita.

Comprovado de ponta a ponta: o `place` devolveu `code: 1` e emitiu. Duas
hipóteses foram testadas contra a API e **refutadas** — mandar
`organizationInfo: {}` (bloco vazio é bloco ausente para ela) e preencher o
telefone do cliente. Ficam registradas no cabeçalho de
`scripts/test-ssl-contato-ov.js` para não serem tentadas de novo.

**O `-2` do `/ssl/place` é saldo insuficiente.** Mesmo payload, mesmo refId:
com saldo zero devolve `-2` sem detalhe; com US$ 1,86 devolve `code: 1`. A
compra pela API depende de saldo pré-pago — pagar por PayPal/cartão sem saldo
existe no console, não neste canal.

### Modo de compra: três viraram um

O seletor entre `api`, `console` e `painel` saiu da tela de Integração. Só a
API de revenda funciona nesta conta: o `console` dependia de um refresh_token
que expira em ~13 h e cuja renovação exige login humano com captcha (o guardado
estava morto havia 15 dias), e o `painel` não comprava nada. `modoCompra()`
passou a devolver `'api'` fixo; a chave `nicsrs_modo_compra` deixou de ser lida
e continua inofensiva no banco. `comprarPeloConsole` e
`registrarComprasNoPainel` seguem no módulo, hoje sem chamador.

### Tela de certificados

- **`editar()` trocava o produto do certificado, em silêncio.** O select ficava
  no primeiro item do catálogo, então salvar qualquer edição gravava outro
  produto — o #61 (`certum-ov-wildcard-ssl`, US$ 61,60) abria como
  `certum-dv-multidomain-ssl`. Só apareceria na recusa da CA ou na fatura. O
  custo gravado também é restaurado, porque a troca de produto repõe o preço de
  tabela e numa edição vale o que foi pago.
- **O botão Cancelar existia e era invisível**: a coluna de ações tinha 134px
  para 170px de conteúdo e cortava tudo além do primeiro botão. Agora a célula
  quebra em linhas.
- **Filtros no catálogo** (marca, validação, tipo de domínio) — são 69 produtos
  de 5 CAs numa lista só, e dois vizinhos da mesma marca podem ser um DV de
  US$ 5 e um OV de US$ 25. Domínio curinga liga o filtro de curinga sozinho.
- **O modal deixou de pedir o que a compra não usa**: `CSR *` virou opcional
  explícito (sem ele a NicSRS gera o par — comprovado), e contatos/organização
  ficam recolhidos, abrindo sozinhos em OV/EV.
- **Relatório em .xlsx e .pdf** com os filtros da tela. Data vai como DATA no
  Excel, não como o texto que a tela mostra: entregar um `Date` à lib `xlsx`
  produzia serial fracionário (ela compensa fuso contra 30/12/1899, quando
  America/Sao_Paulo ainda está em LMT) e o Excel truncava — toda data aparecia
  um dia antes.

### Contrato → pedido de compra

O botão gerava um pedido a cada clique, sem olhar o que já existia; no tenant
1bit um item chegou a ter três pedidos, dois cancelados à mão. Agora o servidor
responde 409 com a lista do que já existe e a tela pergunta. **Não bloqueia**:
item anual em contrato de vários anos precisa de uma compra por ciclo. Pedido
`recebido` também dispara o aviso — a duplicata real nasceu um dia depois de o
anterior já constar recebido.

### Verify

Três suítes novas: **20** (relatório SSL), **28** (pedido duplicado) e **29**
(contato OV/EV). As massas são sintéticas, com datas relativas a hoje — teste
que mede produção reprova no primeiro uso legítimo do sistema.

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
