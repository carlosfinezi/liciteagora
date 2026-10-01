# LiciteAgora — instruções para Claude Code

Sistema de gestão de licitações públicas (PNCP/Comprasnet/BLL/BNC) multi-tenant.

## ⚠️ AVISO CRÍTICO: este working tree É a produção

Produção roda diretamente deste diretório — **editar um arquivo aqui é editar
produção**. Não há deploy separado, staging nem build. Para código carregado
pelo Node, a mudança só entra em vigor no restart do processo; para arquivos
em `public/` (estáticos), a mudança fica no ar imediatamente ao salvar.

## Serviços vivos INTOCÁVEIS (nunca reiniciar sem perguntar)

| Serviço | O que mantém |
|---|---|
| `bll-session-service.js` | Chrome logado no BLL Compras + relay de token de lance |
| `bnc-session-service.js` | Chrome logado no BNC Compras + relay de token de lance |
| `licitanet-collector-server.js` | Coletor de marcas Licitanet (Chrome via túnel da loja) |
| `server.js` | Servidor web de produção (user carlosfinezi, porta de produção) |
| `scheduler.js` | Jobs master (sync PNCP, cobrança, boletos) — roda como root |
| `govbr-bearer.service` | (definido, atualmente parado — mesmo perfil de risco) |

Os session-services mantêm sessões de Chrome **logadas nos portais**: derrubar
é caro — o relogin queima solves pagos de captcha (NopeCHA) e o anti crash-loop
do systemd (5 restarts/10min) pode deixar o serviço **parado** de vez.
Os logs deles são escritos na raiz (`bll-session.log`, `bnc-session.log`, ...).

## Stack

- JavaScript puro, **CommonJS** (`"type": "commonjs"`) — sem TypeScript, sem ESM
- Node v20 (`/usr/bin/node`), Express 5, better-sqlite3 (+ pg pontual)
- Puppeteer (`puppeteer-core` + stealth) para os portais; Electron para o
  cliente desktop Comprasnet
- Layout flat: ~280 arquivos .js na raiz (rotas, engines, schedulers)

## Multi-tenant

Um banco SQLite por empresa em `data/tenants/<tenant>/pncp.db` (1bit, reimac,
levezi, ...), mais `data/control.db`. O `pncp.db` da raiz é legado, parado
desde 2026-05.

O catálogo compartilhado **não é mais SQLite**: roda em PostgreSQL
`liciteagora_catalog` (~54 GB), ligado por `CATALOG_BACKEND_PG=1` nas duas
units instaladas. O `data/catalog.db` (36 GB) é o backend antigo, **congelado
desde 2026-08-02 14:20 BRT** — nenhuma escrita desde então. Ao consultar estado
do catálogo (ex.: `catalog_sync_state`), vá no Postgres: o SQLite devolve
valores parados de agosto, inclusive um `syncRetroativo.status = rodando` que é
falso — no Postgres esse mesmo sync consta `concluido` desde 2026-05-29.

### Provisionamento de vhost: mudar o script exige REINSTALAR

A criação de tenant chama, via `sudo -n`, a **cópia de posse do root** em
`/usr/local/sbin/liciteagora-provision-vhost`, e não o
`scripts/provision-tenant-vhost.sh` do projeto. A regra do sudo
(`/etc/sudoers.d/liciteagora-provision`) só libera a cópia.

**Editar o script do projeto não muda nada em produção** até alguém rodar,
como root:

```
sudo bash /home/carlosfinezi/web/liciteagora.com.br/private/scripts/instalar-provision-vhost.sh
```

O instalador mostra o diff contra a cópia em uso, copia, passa a regra pelo
`visudo` antes de gravar e recusa terminar se sobrar regra apontando para o
arquivo do projeto. Leia o diff antes de confiar: é conteúdo que vai rodar
como root.

Até 2026-09-24 a regra apontava para o arquivo do projeto, que é do
carlosfinezi. Qualquer processo desse usuário podia reescrevê-lo e rodar o
que quisesse como root, sem senha. **Nunca volte a apontar sudo para arquivo
desta árvore.** Mesmo desenho do `trajeta-publicar`.

### Criar tenant fora do painel: `scripts/criar-tenant.js`

O painel admin exige sessão de super-admin. O script segue o MESMO caminho da
rota (`criarTenant` e `ligarFeature`, exportados do `control-plane-routes.js`)
e depois roda a cópia root do provisionamento de vhost:

```
sudo -u carlosfinezi DISABLE_SCHEDULERS=1 node scripts/criar-tenant.js \
  --slug X --nome "Nome" --plano-id 4 --features produtos,varejo,fiscal
```

Roda como carlosfinezi (dono de `data/` e o único que o sudo libera) e é todo
síncrono de propósito: as migrações registram as rotas de todos os módulos, e
alguns armam temporizadores. Sem devolver o controle ao event loop até o
`process.exit`, nenhum dispara, e o script não vira uma segunda produção.
`--plano-id 4` é o Vitalício/Interno: os planos Trial e Mensal vencem e
suspendem o tenant sozinhos. Foi assim que nasceu o `floricultura`, em
27/09/2026, que desde 29/09 é o `cantinhoverde` (ver abaixo).

### Trocar o slug de um tenant: não há rota, e a ordem importa

Feito uma vez, em 29/09/2026 (`floricultura` → `cantinhoverde`, depois de
apagar um `cantinhoverde` de teste). O slug é o endereço, o nome da pasta
em `data/tenants/` e a chave do pool de conexões dos dois processos:

1. backup;
2. no `control.db`, `UPDATE tenants SET slug, db_path` e uma linha em
   `tenant_audit` (`RENAME_SLUG`). Apagar tenant é `DELETE FROM tenants` com
   `PRAGMA foreign_keys=ON`, que leva módulos e cobrança pelo `CASCADE`;
3. `mv` da pasta em `data/tenants/`;
4. **restart dos dois serviços na hora.** O pool guarda a conexão pelo slug:
   sem o restart, o slug reaproveitado continuaria servindo o banco antigo;
5. `v-delete-web-domain carlosfinezi <antigo>.liciteagora.app yes` e
   `/usr/local/sbin/liciteagora-provision-vhost <novo>`;
6. resselar o FIM com os arquivos de `/etc/nginx/conf.d/domains/` que mudaram.

As imagens da loja guardam o slug antigo no nome do arquivo
(`logo-floricultura-…`). Isso é só nome, e continua servindo.

### Tenants de demonstração: um por sessão, e a posse se anuncia

São **dois**, iguais no cuidado e trocáveis entre si:

| slug | endereço | encerramento |
|---|---|---|
| `sandbox` | `sandbox.liciteagora.app` | `sudo bash scripts/encerrar-demo.sh sandbox --sim` |
| `demo2` | `demo2.liciteagora.app` | `sudo bash scripts/encerrar-demo.sh demo2 --sim` |

Os dois estão no plano **Vitalício/Interno** (`plano_id = 4`), e isso não é
detalhe: o `sandbox` estava no Mensal, que vencia em **11/10/2026** e o
suspenderia sozinho — no meio de uma gravação, sem aviso. Tenant de
demonstração não vence (trocado em 01/10/2026 pelo `setPlanoTenant`).

Os dois nascem vazios, sem certificado, sem SMTP, sem WhatsApp, sem provedor
de boleto e sem integração nenhuma, e **é assim que ficam**: quem monta um
retrato semeia o banco direto, nunca por rota de emissão. O banco de
referência e o nome original de cada um vivem em `backups/<slug>/`.

**Pegue um que esteja SUSPENDED, e só esse.** Isto não é etiqueta: em
01/10/2026 duas sessões montaram retrato no `sandbox` com quatro horas de
diferença, e a segunda só soube da primeira porque o tenant apareceu ACTIVE
com nome de outro ramo. A primeira coisa de qualquer trabalho de retrato é:

```
sqlite3 -readonly data/control.db \
  "SELECT slug, status, name FROM tenants WHERE slug IN ('sandbox','demo2')"
```

**ACTIVE quer dizer OCUPADO.** Não ative o que já está ativo, não encerre o
que você não ativou, e não conte com o nome: ele é do retrato de quem pegou.

**A anotação é dupla, e as duas pontas importam.** No sistema, a posse já se
anuncia sozinha — ao ativar, você grava `status = ACTIVE`, o nome do seu
retrato e uma linha em `tenant_audit` com o seu `actor`. Essa é a marca que a
próxima sessão lê, e é a que vale. Para o usuário, **diga na primeira resposta
qual você pegou**, em uma linha ("estou usando o `demo2`"), porque ele
acompanha mais de uma conversa ao mesmo tempo e não vai consultar o banco para
descobrir onde cada uma está mexendo.

**Encerre o que você abriu, antes de acabar a sessão.** O
`scripts/encerrar-demo.sh` restaura o banco, devolve o nome e põe em
SUSPENDED. Sem `--sim` ele não escreve nada: lista o que o banco vivo tem e
para, para você conferir que o retrato ali dentro é o seu. Por padrão ele
restaura o tenant vazio; se a sua sessão tirou um backup ao começar — e
deveria —, passe-o em `--pncp`, porque ele tem as migrações que rodaram desde
então. Banco antigo demais deixa o servidor vivo batendo em "no such table".

Precisando de um terceiro, há `sandbox2` a `sandbox6` no `control.db`, todos
limpos e suspensos, mas **sem vhost**: sem endereço eles não abrem no
navegador e não servem para print. O `sandbox5` ainda é o alvo padrão do
`scripts/test-provisionamento-tenant-novo.js` — esse não se usa.

### Chave do certificado A1: `/etc/liciteagora/chave-certificado.env`

Desde 27/09/2026 a senha do certificado digital fica cifrada no banco
(`cert-senha.js`, AES-256-GCM). Até então era só base64, e o `pncp.db`
sozinho entregava o pfx e a senha que o abre.

- **A chave NÃO mora no banco nem na árvore.** Fica em
  `/etc/liciteagora/chave-certificado.env` (root, 600), como
  `LICITEAGORA_CHAVE_CERT` (64 hexadecimais). O systemd a entrega às duas
  units por um drop-in: `/etc/systemd/system/<unit>.service.d/chave-certificado.conf`,
  com `EnvironmentFile=-...`. O carlosfinezi não consegue ler o arquivo, e o
  processo recebe só a variável.
- **O backup dos bancos não leva a chave**, e é isso que faz o banco sozinho
  não revelar a senha. Guarde uma cópia da chave FORA desta máquina: sem ela,
  o backup restaura o pfx e perde a senha.
- **A migração roda no boot de cada tenant** (`db-schema.js` →
  `migrarSenhas`). Sem a chave no processo ela não migra e avisa no log
  quantas senhas ficaram em base64. A leitura aceita os dois formatos, então
  nada para enquanto isso.
- **Gravar senha sem a chave é recusado**: o upload do certificado responde
  erro em vez de guardar em base64.
- Script ou suíte rodado à mão como carlosfinezi **não tem a chave** e não
  decifra as senhas migradas. Para provar a emissão num tenant real:
  `( set -a; . /etc/liciteagora/chave-certificado.env; set +a; node scripts/provar-cert-senha.js 1bit )`,
  como root, somente leitura (faz uma consulta de status à SEFAZ e um
  controle com senha errada, que tem de falhar).

**O pfx é aberto em memória, sem arquivo** (`cert-memoria.js`, desde
28/09/2026). A node-sped-nfe abre o certificado com o `pem.readPkcs12`, e o
pacote `pem` rodava o `openssl` gravando o pfx, a senha e a chave privada
aberta em `/tmp`, com permissão 644, apagando só no callback. Em 27/09 sobraram
quatro desses arquivos, de um processo que saiu antes do callback. O
`cert-memoria.instalar()`, chamado ao carregar o `nfe-emit-routes.js` e o
`nfce-routes.js`, troca esse `readPkcs12` por uma leitura com o node-forge. Não
abre processo nem toca em disco. Código novo que crie `Tools` da biblioteca
fora desses dois módulos precisa chamar `instalar()` antes. O `/proc` está com
`hidepid=invisible`: outro usuário não enxerga o processo do servidor.

**Se a chave se perder:** toda senha já migrada fica ilegível. A NF-e, a
NFC-e, a NFS-e, o PDF assinado e o certificado entregue ao Electron passam a
falhar com "LICITEAGORA_CHAVE_CERT ausente" ou erro de decifra, em todos os
tenants com certificado. O pfx continua no banco; o que some é a senha. O
conserto é gerar uma chave nova (`openssl rand -hex 32` no mesmo arquivo),
reiniciar as duas units e pedir a cada tenant que reenvie o certificado com a
senha em Configurações › Minha empresa. Não há como recuperar as senhas
antigas, e é justamente essa a garantia.

**Se o arquivo sumir mas a chave existir em outro lugar:** recoloque o arquivo
com o mesmo valor e reinicie as units. O hífen do `EnvironmentFile=-` faz o
serviço subir mesmo sem o arquivo, e aí só a emissão fiscal falha, com erro no
log, em vez de o ERP inteiro cair no boot.

### A loja como página inicial, e a nova posição do static do login

Desde 27/09/2026, com `loja_config.paginaInicial = 1` e a loja publicada
(Catálogo Online › Informações da empresa › "Abrir o catálogo em…"), quem abre
o endereço do tenant sem sessão cai na loja: `/` vai para `/loja/`, caminho
desconhecido recebe `public/loja/404.html` com status 404, e favicon, ícones e
manifest do ERP não são servidos (sai o ícone da loja, ou 404). O dono entra
por `/login`; com sessão, tudo volta a ser o ERP. Tenant suspenso mostra a loja
fechada (`responderLojaFechada`), sem slug nem cobrança.

**Dentro de `/loja/` isso vale com a opção desligada também** (desde
29/09/2026): basta a loja publicada para um caminho inexistente em `/loja/…`
receber o 404 da loja, e não o login, e para o tenant suspenso mostrar a loja
fechada ali. É o caso do `cantinhoverde`, que divulga o `/loja/` e tem a raiz
no login, como os outros tenants. Mudou também o `1bit` e o
`produtosbomgosto`, as outras lojas publicadas: antes, lá, `/loja/inexistente`
levava ao login.

Para isso, **o static de `public/auth` deixou de ser montado antes do
middleware de tenant**. Agora é `base-middleware.servirTelaDeLogin`, chamado
pelo `auth-pipeline` depois da sessão e do `vitrineAntesDoLogin`. Duas
consequências: host desconhecido recebe o 404 do tenant em vez da tela de
login, e o painel admin continua servido porque o host `admin` passa pelo
middleware de tenant. O `vitrineNaBarreira` fica logo antes do
`requireAuth`. A configuração é lida com cache de 15 s por tenant, e quem grava
chama `esquecerVitrine`.

O tema da vitrine tem acabamento desde 28/09/2026 (fundo aquarela, sombras,
topo translúcido, sigla, slogan e o destaque do topo), e o `tema.js` grava as
escolhas como `data-fundo-efeito`, `data-sombra` e `data-topo` no `<html>`:
é neles que a folha do `public/loja/index.html` se apoia. Desde 29/09 o topo
tem a opção `degrade`, que é a regra `.topbar` do protótipo do Cantinho Verde
(degradê 96/78/0% na cor de fundo da loja e `blur(12px)`, sem máscara). A loja
do tenant `cantinhoverde` (até 29/09, `floricultura`) usa tudo isso, e seus
produtos de exemplo têm SKU `EXEMPLO-`.

**Ícones da loja** (29/09/2026): a vitrine com ícone enviado (`faviconPath`)
declara aba em 16 e 32 px, atalho do celular (180) e manifest próprio, pelas
rotas públicas `/loja/icones/<tamanho>.png` e `/loja/manifest.webmanifest`.
As versões por tamanho são arquivos ao lado do ícone, com sufixo (`…-16.png`,
`-32`, `-180`, `-192`), e faltando uma vai o ícone enviado. Quem troca o ícone
pela tela perde as versões: elas eram do arquivo antigo. Ícone pequeno de
desenho detalhado precisa ser redesenhado a 16 px, como o do Cantinho Verde.

O domínio próprio (`floriculturadoamigo.com.br`) **ainda não existe**: o
`resolveFromHost` só reconhece `<slug>.liciteagora.app`.

## Verify

```
npm run verify
```

**Leva cerca de 35 minutos, e isso é o normal.** Medido em 2.070s no
fechamento de 2026-09-16. O número está escrito aqui porque quem espera
segundos conclui que travou e mata o processo, e aí o passo deixa de ser
rodado. Rode após qualquer edição de .js, e conte com o tempo.

Ele deixou de ser o `node --check` em massa que esta seção descrevia até
2026-09-16. Em 17/09 passou de 30 para **106 etapas**: entraram 71 suítes que
já existiam, passavam e não rodavam em lugar nenhum, mais 6 recuperadas do
dump em `/tmp` (ver `docs/suites-fora-do-verify-2026-09-17.md`). Módulos
inteiros — farmácia, locação, produção, apuração fiscal, devolução — não
tinham uma única etapa até então.

As 71 somam 325s medidos, cerca de 23% a mais. O tempo total da rodada de 106
etapas **não foi medido**: a tentativa esbarrou em outra sessão usando a
máquina, com load average em 7 e Chrome headless disputado. A estimativa é
~32 min, e o primeiro que rodar com a máquina livre deve anotar o número real
aqui.

A estrutura segue a mesma: as três primeiras etapas são sintaxe, o resto são
suítes funcionais.

- **1 a 3, sintaxe**: `vm.Script` em todo .js da raiz, de `scripts/` e de
  `public/`, mais o JavaScript embutido nas telas. Levam segundos. Essa
  cobertura de `public/` é resposta a 2026-09-11, quando uma crase dentro de um
  comentário quebrou o `public/js/sidebar.js`, o verify antigo passou verde e o
  ERP inteiro subiu com a tela em branco.
- **4 a 106, suítes funcionais**: shell, tema e contraste, PWA, RBAC,
  isolamento multi-tenant, catálogo, pedidos, faturamento, SSL, farmácia,
  locação, produção, PDV, apuração fiscal e devolução. São elas que consomem o
  tempo, porque montam bancos descartáveis e sobem Chrome headless.

  **O banco de teste sai do schema do tenant, extraído na hora** por
  `scripts/schema-de-tenant.js`, em modo somente leitura. Antes, 27 suítes liam
  um dump gerado à mão em `/tmp`, que sumia no reboot. Pior: aquele dump era de
  antes de 2026-08-20 e não tinha a remoção da tabela `fornecedores`, então 12
  suítes passavam contra um schema congelado havia um mês. Nunca volte a ler
  schema de arquivo local — o verde seria falso.

Passar no verify hoje diz bem mais que "o código parseia". Ainda assim não é
prova de que a sua mudança funciona: nenhuma das 29 etapas conhece o que você
acabou de editar, e o teste de runtime do caminho tocado continua manual.

A saída termina em `FALHOU: N problema(s) em Ns`, com cada falha nomeada.

Linha de base **2026-10-01, 168 etapas em 1.911s (31,8 min) com 4
trabalhadores: 11 falhas, 4 conhecidas e 7 da frente da loja.**

As **4 conhecidas** são a etapa 21 (`test-catalogo-online-ux`), nas quatro
larguras que ela mede. O menu ⚙️ Configurações do Catálogo Online ganhou a
sétima opção em 21/09 ("Regras fiscais") e a oitava depois dela, e a suíte
continua esperando 6 (`test-catalogo-online-ux.js:634`). O menu está certo e a
suíte é que ficou para trás. Ela está em `FALHAS_CONHECIDAS`, no `verify.js`:
reprova igual, mas sai marcada como conhecida, e o fim da saída separa as
conhecidas das novas. Quando a suíte for atualizada, tire a entrada de lá.

As **7 da frente da loja** saem como NOVAS e não estão em `FALHAS_CONHECIDAS`,
de propósito: elas são da vitrine em obra, e marcá-las esconderia regressão de
verdade. São a sacola sem caminho para o checkout e a recusa sem motivo
(`test-catalogo-publico-49` e `test-catalogo-fase50`) e os ícones do cabeçalho
que não aparecem em 768 px (`test-catalogo-fase51`, nas três combinações de
rede social). **São idênticas, item por item, às da rodada de 30/09 às 17:36** —
é assim que se prova que uma frente nova não as causou. Quem fechar a vitrine
acerta as três e esta linha cai.

Fora dessas 11, qualquer falha é regressão nova.

`npm run verify:legado` continua existindo e é o `node --check` antigo, em
torno de 40 segundos. Serve para conferir sintaxe depressa, e não substitui o
verify.

### Rodar fora da sessão: o `liciteagora-verify.service`

O verify morreu duas vezes junto com a sessão que o rodava (24 e 25/09), e
quem espera 35 minutos por um aviso perde o resultado quando a conversa acaba.
Por isso o jeito de rodar o verify inteiro é pelo serviço:

```
systemctl start --no-block liciteagora-verify     # dispara e volta na hora
systemctl is-active liciteagora-verify            # "activating" = ainda rodando
cat /var/lib/liciteagora-verify/ultimo.json       # resultado da última rodada
tail /var/lib/liciteagora-verify/rodando.log      # a rodada em curso
```

**Quem dispara não espera: volta depois e lê o `ultimo.json`.** Ele traz o
`estado` (`concluido` ou `morreu`), o `commit`, quantos arquivos sujos a árvore
tinha, o tempo de cada etapa, as falhas com `conhecida: true|false` e o
`falhasNovas`. Enquanto a rodada acontece, o mesmo conteúdo está no
`rodando.json`, com `estado: rodando`.

- A unit vive em `scripts/liciteagora-verify.service` e é instalada com
  `install -m 644 scripts/liciteagora-verify.service /etc/systemd/system/ &&
  systemctl daemon-reload`. Mudou a unit, reinstale.
- **Roda como carlosfinezi, e não como root, de propósito**: executa código
  desta árvore, e um serviço root faria o mesmo que o sudo do provisionamento
  fazia até 24/09.
- O `scripts/verify-servico.sh` é quem ela chama, e roda também à mão
  (`VERIFY_SAIDA=/tmp/x scripts/verify-servico.sh --rapido arquivo.js`).
- **Uma rodada por vez**: o `verify.js` segura a trava
  `/run/lock/liciteagora-verify.lock` e recusa com código 3 se outra estiver
  viva, venha ela do serviço, do `npm run verify` ou da mão. Trava de processo
  morto é assumida sozinha.
- **O serviço tem `/tmp` próprio (`PrivateTmp=yes`).** Muitas suítes usam nome
  fixo em `/tmp`, de banco ou de perfil do Chrome, e o que uma rodada como root
  deixa lá o carlosfinezi não consegue apagar. Na estreia, em 25/09, isso
  reprovou 53 suítes com `SQLITE_ERROR` e "browser is already running". Pelo
  mesmo motivo, suíte não pode depender de arquivo feito à mão em `/tmp`: as
  seis que liam o `/tmp/app-backend-schema.sql` passaram a usar o
  `lerSchema()` do `schema-de-tenant.js`, como as outras 24. Insumo real que
  não sai do banco (hoje, só a planilha da CMED da `test-farmacia-f1`) fica em
  `/var/lib/liciteagora-verify/insumos/`, fora da árvore e do `/tmp`.
- Uma suíte que passa de 30 min é derrubada e vira falha com nome, em vez de
  uma rodada que nunca termina.

### Modo rápido, e quando o inteiro continua obrigatório

```
node scripts/verify.js --rapido                   # os arquivos alterados em relação ao HEAD
node scripts/verify.js --rapido loja-routes.js    # só os arquivos citados
```

Roda a sintaxe inteira (segundos) e só as suítes cujo fonte cita o arquivo
alterado: um `require`, o caminho da tela ou um `readFileSync`. Um script de
shell, um documento ou uma planilha ficam só com a sintaxe. Arquivo que
nenhuma suíte cita sai listado como "sem suíte nenhuma", e isso é informação:
nada no verify testa aquele arquivo.

**O verify inteiro continua obrigatório:**

1. **no fechamento, sempre**, pelo serviço;
2. **quando mexer em arquivo compartilhado.** Nesses casos o modo rápido se
   recusa sozinho e roda o inteiro: `db-schema.js`, `route-registry.js`,
   `perfis-acesso.js`, `perfis-api-map.js`, `role-dispatch.js`, `server.js`,
   `auth*.js`, `tenant-*.js`, `base-middleware.js`, `pre-auth-routes.js`,
   `plan-modules.js`, `module-gate.js`, `public/js/menu-config.js`,
   `public/js/sidebar.js`, `public/app.html`, `public/app.js`,
   `public/css/app-modern.css`, `public/auth/sw.js`, `package.json` e os
   próprios `verify.js`, `banco-de-teste.js`, `guarda-dados.js` e
   `schema-de-tenant.js`. A lista está em `OBRIGA_INTEIRO`, no `verify.js`;
3. **antes de afirmar que uma mudança não quebrou outra coisa.** O rápido só
   responde pelas suítes que ele escolheu.

Na árvore de produção, `--rapido` sem arquivos quase sempre vira inteiro,
porque outras frentes deixam `db-schema.js` e companhia sujos. Para o que é
seu, cite os arquivos.

### Paralelo

`--paralelo N` roda N suítes ao mesmo tempo. O serviço usa 4.

**Medido em 26/09, com a carga da máquina em torno de 10: 136 etapas em
1.316s (21,9 min) pelo serviço com 4 trabalhadores**, contra 3.452 a 4.042s
(57 a 67 min) das rodadas sequenciais de 25/09. O teto é a `fase51`, que
sozinha leva 13 a 14 min.

- **Grupos por conflito.** Suítes que citam o mesmo arquivo fixo de `/tmp` ou
  a mesma porta fixa caem no mesmo grupo e rodam em sequência. Em 25/09 eram
  quatro grupos por `/tmp`, o maior com seis suítes em
  `/tmp/app-backend-schema.sql`, e nenhuma porta repetida. O `verify.js` lê
  isso do fonte a cada rodada, e suíte nova não precisa se declarar.
- **A mais longa primeiro.** A ordem sai do `ultimo.json` anterior, ou da
  semente em `/var/lib/liciteagora-verify/tempos-semente.json`, tirada da
  rodada sequencial de 25/09 (3.452s, carga entre 7 e 9). Nela, quatro suítes
  do catálogo somavam 56% do tempo: `fase51` com 811s, `fase50` com 583s,
  `publico-49` com 285s e `catalogo-48` com 260s. É a mais longa que decide a
  duração total com 4 trabalhadores.
- **Suíte sensível a carga.** A `test-scan-horario` reprovou uma vez sem
  mensagem enquanto outra bateria de Chrome rodava junto, e passou nas três
  vezes seguintes. Falha de Chrome sem linha de FALHA agora sai com o fim do
  stderr.

### Nenhuma suíte escreve em `data/`

Até 25/09, 36 suítes do verify abriam para escrita o banco de produção de um
tenant interno: 28 no `labfiscal`, 7 no `jaagricola`, uma no `sandbox` e a
etapa 93 no `sandbox5`. A 36ª, a `test-multideposito-lab`, escapou do
levantamento feito por busca no código, porque guardava o caminho numa
variável. Quem a achou foi a guarda, na primeira rodada. A etapa 93 deixou 17 pedidos, 9 clientes e 9 faturas
no `sandbox5`, e acabou reprovando porque os CNPJs de teste se esgotaram. A
`test-nfe-tributacao-integracao` fazia `DELETE FROM fiscal_regras_trib` no
`labfiscal` a cada rodada.

Agora são duas peças:

- **`scripts/banco-de-teste.js`**: `copiaDoTenant(slug)` devolve um
  `pncp.db` temporário, tirado por `VACUUM INTO` a partir de uma conexão
  somente leitura, que some no fim do processo. Suíte nova que precise de dado
  real usa isso.
- **`scripts/guarda-dados.js`**: o `verify.js` o injeta em cada suíte por
  `NODE_OPTIONS`, que passa também aos processos filhos. Abrir banco de
  `data/` sem `readonly`, ou gravar arquivo lá, reprova na hora e nomeia a
  suíte. Ler continua livre.

**Por que a guarda não compara os bancos antes e depois da rodada:** a
produção está viva. O `-wal` do `1bit` muda a cada minuto por uso e pelos
schedulers, e a comparação reprovaria toda rodada sem apontar quem escreveu.
O limite é o que ela não vê: escrita de processo que não é node, como o
binário `sqlite3`. As suítes usam o `sqlite3` só com `?mode=ro`.

As 28 suítes que fixavam
`BASE = '/home/carlosfinezi/web/liciteagora.com.br/private'` passaram a usar
`path.join(__dirname, '..')`. Antes, rodando numa cópia (um `git worktree`,
por exemplo), elas testavam o código da produção, e não o da cópia.

## Rotinas

Rotinas separadas — não misturar. **Nenhuma delas reinicia serviço** (ver
"Serviços vivos INTOCÁVEIS"): restart é sempre pedido explícito seu, fora de
qualquer rotina.

**"fechamento"** (uma vez, depois de você aprovar o que está no ar):

Aqui não existe deploy — o código aprovado já está em produção desde a edição.
O fechamento não publica nada; ele torna durável e rastreável o que já está
rodando, e declara o que ainda não entrou em vigor.

1. backup: `scripts/backup-tenants.sh`
2. `npm run verify` — verde obrigatório
3. atualizar `CHANGELOG.md`
4. commit (código + changelog)
5. `git push`
6. `chown -R carlosfinezi:carlosfinezi .git` — a sessão roda como root e o repo
   é do carlosfinezi; sem isso o próximo commit dele falha em objetos/refs
   root-owned
7. **restart condicional** do que precisa recarregar o código novo. Não exige
   pergunta — é parte da rotina:

   | Mudou | Ação |
   |---|---|
   | Só `public/` (estáticos), doc ou config | **nada** — já está no ar |
   | `.js` da raiz carregado pelo `server.js` (rotas, libs) | `systemctl restart consulta-licitacoes.service` |
   | `.js` de job/engine/scheduler carregado pelo `scheduler.js` | `systemctl restart liciteagora.service` |
   | `bll-session-service.js`, `bnc-session-service.js`, `licitanet-collector-server.js` | **pergunte** — nunca automático |

   Use os nomes de unidade exatos — só estes dois estão no allow do
   `.claude/settings.json`, e qualquer variação cai em prompt:
   `consulta-licitacoes.service` e `liciteagora.service`.

   Na dúvida sobre qual dos dois processos carrega o arquivo, reinicie os dois:
   ambos leem a mesma raiz flat.

   **Exceção dos session-services**: mesmo dentro do fechamento, eles são caso
   à parte. O anti crash-loop do systemd (5 restarts/10min) pode deixá-los
   parados de vez e o relogin queima solve pago de captcha. Se a mudança tocar
   um deles, pare e pergunte — não reinicie por conta do fechamento.

   A ressalva não depende de ninguém lembrar dela: `bll-session.service`,
   `bnc-session.service`, `licitanet-collector.service` e `govbr-bearer.service`
   estão de fora do allow **e** de fora do deny, então o restart deles cai em
   prompt e a decisão é sua na hora.

   Depois de reiniciar, **confirme que o serviço voltou**:
   - `consulta-licitacoes.service`: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health`
     (responde 302 — qualquer 2xx/3xx prova que subiu; timeout ou 000, não)
   - `liciteagora.service`: não tem HTTP — `systemctl is-active` mais as últimas
     linhas de `server.log` sem stack de boot

8. grafo: `~/graphify/liciteagora/atualizar-grafo.sh fechamento --esperar`

   **Por que ele ESPERA, em vez de disparar e sair.** Um fechamento são vários
   commits em sequência, e cada um já dispara o gancho `post-commit`. Essas
   rodadas se atropelam: o graphify toma um flock por repositório e, na
   reconstrução COMPLETA — que é a nossa —, **quem chega com o lock tomado é
   DESCARTADO, não enfileirado**. Das N rodadas de uma leva sobrevive a
   primeira, que retrata o disco do COMEÇO do fechamento. Disparar mais uma
   aqui cairia na mesma armadilha. Com `--esperar`, o passo aguarda a rodada
   em curso terminar e então refaz uma vez, sobre o disco final.

   É também o passo que fecha a conta do **debounce**: o gancho de commit
   passa por uma janela de 30 min, justamente para que uma rajada de commits
   não marrete uma rodada inteira a cada um. O pedido de cada commit fica
   registrado, e é aqui que ele é cobrado.

Antes de commitar, confirme que a working tree é exatamente o que foi testado —
nada pode ter mudado depois do "ficou bom". Ao concluir, informe o resultado do
push (branch, hash, sincronização com origin) e o dos restarts.

**"fechamento 0"** (mesmo fluxo, a ÚNICA diferença é o restart): igual ao
"fechamento" — incluindo o push automático e o passo 8 do grafo — mas SEM o
passo 7. Não reinicia
nada, nem os serviços comuns. No lugar do restart, entrega o **relatório de
pendência**: quais `.js` alterados são carregados por processo vivo e, portanto,
qual serviço só passa a rodar o código novo quando você reiniciar. Ao final,
avise que o restart ficou pendente para quando for pedido.

**"backup"**: `scripts/backup-tenants.sh`. É o passo 1 do fechamento e também
roda sozinho, antes de mexer em schema.

Cobre os `data/tenants/*/pncp.db`, o `data/control.db` e um dump seletivo do
catálogo Postgres. Backup de SQLite é sempre `sqlite3 .backup` — `cp`/`rsync`
de banco vivo corrompe, porque o `-wal` fica para trás.

Fica de fora **por escolha, não por esquecimento**:

- `licitacoes`, `itens` e `resultados_bi` do catálogo (~50 dos 54 GB): é dado
  público do PNCP e volta por refetch. Não é grátis — custa semanas de crawl e
  a cota da API — mas volta sem perda definitiva.
- `data/catalog.db`: backend SQLite legado, congelado desde 2026-08-02. Copiar
  36 GB de arquivo morto não protege nada.

O dump seletivo leva justamente o que **não** volta: `catalog_sync_state` (os
cursores — perder essas ~24 linhas reinicia todos os backfills do zero), os
derivados de IA (`bi_item_classificacao_ia` e afins, que custam chamada paga),
as marcas do coletor Licitanet e a coluna `marcaExtraida` dos itens (573.866
linhas, sobre ~23M itens já processados).

`scripts/backup-tenants.sh --catalogo-full` faz o `pg_dump` inteiro dos 54 GB:
chamada manual, sob demanda, **nunca** dentro do fechamento.

**Cada rodada apaga o conjunto mais antigo além dos 10 mais recentes** em
`backups/db/` (retenção desde o 9294db8, de 17/09/2026: sem ela a pasta ia a
24 GB em 15 dias e derrubava o backup do Hestia). Ou seja, rodar o backup à
toa custa um ponto de restauração antigo. Ao final ele relata o espaço
ocupado e o disco livre.

Argumento desconhecido é recusado com erro antes de qualquer backup, e
`--help` só mostra a ajuda. Até 24/09/2026 o script ignorava argumento
estranho: um `--help` virou backup completo e empurrou para fora o conjunto
de 16/09.

Restaurar backup nunca é rotina: só a pedido explícito.

**"estado"** (leitura pura, não escreve nada):

1. `systemctl is-active` dos serviços da tabela de intocáveis
2. `git status` resumido
3. `npm run verify`

## O grafo do graphify: ele mora FORA do repositório

Existe um grafo de conhecimento deste repositório desde 16/09/2026, e ele
**não fica na árvore**: mora em `~/graphify/liciteagora/`, junto do
coalescedor que o reconstrói. Nada de `graphify-out/` aqui dentro, nada de
`.graphifyignore`, nada de `.gitattributes` — este working tree é a produção
e já carrega 420 arquivos sujos; não é lugar para artefato de ferramenta.

- **O gancho** é o `.git/hooks/post-commit`, escrito à mão e **não** pelo
  `graphify hook install`. O instalador escreveria na árvore, reinstalaria o
  corpo incremental (que perde as arestas de saída dos arquivos tocados) e
  dependeria de marcadores que este grafo não tem. Reinstalar com ele desfaz
  tudo isso. Para pular uma vez: `GRAFO_PULAR=1 git commit …`.
- **O coalescedor** é `~/graphify/liciteagora/atualizar-grafo.sh`, com três
  modos: `commit` (o gancho), `fechamento --esperar` (o passo 8) e `manual`.
  Ele tem trava, debounce e arquivo de `estado`, e **nunca reprova quem
  chamou** — falha vira `ESTADO=PARADO`, não erro no commit.
- **O corte do corpus** está em `graphify-out/.graphify_build.json`, também
  fora da árvore: ficam de fora `.specify/`, `.claude/`, `electron-standalone/`,
  `nopecha-ext/` e os dois `cndfed-perfil*`. Sem ele a varredura cospe 59
  avisos de permissão e o grafo passa a se descrever a si mesmo.
- **O custo**, medido em 16/09/2026: **1min10 e ~0,72 GB de pico**, em toda
  rodada. Não existe rodada barata — o cache AST do graphify ignora `.js` por
  construção, então 717 arquivos são re-extraídos mesmo com o disco intocado.
- **O que ele NÃO faz**: ignora DOCUMENTO por construção. `CLAUDE.md` e
  `CHANGELOG.md` ficam de fora, e é neles que moram os nós de conceito. Esse
  lado envelhece calado; o momento de rodá-lo é no fechamento, com
  `/graphify .` à mão.

### O primeiro grafo retrata um estado que ninguém aprovou

Isto vale até o próximo commit, e quem ler o grafo antes dele precisa saber:
**o repositório está há 19 dias sem commit** — o último é de 28/08/2026 —,
com **259 arquivos modificados** (+15.154 / −2.529 linhas) e **134 nunca
rastreados**. O grafo foi construído sobre esse disco.

Ou seja, ele retrata a produção como ela está rodando, e não um estado
revisado: código a meio caminho, módulos inteiros que nunca entraram no
histórico (`farmacia/`, `locacao/`, `posto/`, `restaurante/`), e a
reorganização de páginas que está montada no índice sem ter sido commitada.
Nada disso passou por revisão de ninguém.

Isso não é defeito do grafo — aqui a árvore É a produção, e retratá-la é
justamente o que ele deve fazer. Mas é diferente de um grafo construído sobre
histórico revisado, e a diferença muda o quanto se pode confiar nele para
responder "como este sistema está organizado". Ver "Frentes pendentes de
commit", cujo mapa é de 2026-08-11 e já conta 271 entradas contra as 420 de
hoje.

## Convenções

Commits em português, Conventional Commits: `feat|fix|chore|refactor(escopo):
descrição`, títulos sem acento.

## Se travar

Se o mesmo erro persistir após 3 tentativas de correção, pare e explique o que
tentou e qual o obstáculo. Não invente workaround.

## Permissões (`.claude/settings.json`)

`defaultMode: acceptEdits`. O deny cobre o que é destrutivo **aqui**:
`disable` / `mask` / `kill` de serviço, `rm`, git destrutivo (`stash`,
`reset --hard`, `clean`, `push --force`), `npm install`, escrita em `data/` e
leitura/escrita de `.env`. **Deny vence allow de qualquer arquivo**, inclusive
do `settings.local.json` — e vence também um allow mais específico, o que
determina o desenho abaixo.

`restart` e `stop` usam as três faixas de propósito:

- **allow, por nome de unidade e match exato** — `consulta-licitacoes.service`
  e `liciteagora.service`, nos dois verbos. São os que voltam de graça, e é
  isso que faz o passo 7 do fechamento ser automático de fato: o que não está
  no allow cai em prompt. O `stop` está lá para um caso só — serviço em laço
  de reinício, onde esperar o usuário colar comando custa caro.
- **deny, por nome de unidade** — `stop` de `bll-session`, `bnc-session`,
  `licitanet-collector` e `govbr-bearer`, mais a infraestrutura que nada aqui
  tem motivo para derrubar: `postgresql` (é o catálogo), `redis`, `nginx`,
  `bind9`/`named`. Não pode ser blanket (`stop:*`) porque isso mataria o allow
  exato das duas de cima. Cada nome aparece nas duas grafias — `postgresql` e
  `postgresql:*` — porque `systemctl stop postgresql` sem `.service` funciona
  e escaparia de um match exato.
- **nem allow nem deny** — `restart` dos session-services, e qualquer verbo em
  unidade não citada. Cai o prompt e a decisão é do usuário na hora. A
  ressalva não depende de ninguém lembrar da regra.

Consequência assumida: `stop` de unidade fora de todas essas listas passou de
bloqueado a prompt.

## Frentes pendentes de commit

Levantado em 2026-08-11. **271 entradas** na árvore, agrupadas em 14 frentes.
Produção já roda tudo isso — o que falta é histórico, não deploy. Este mapa
existe para que quem retomar não tenha de redescobri-lo.

| Frente | Arq | M / novo / del | churn |
|---|---:|---|---:|
| Estoque/compras/cotações/pedidos | 48 | 28 / 20 / 0 | +7687 −619 |
| Boletos/cobrança/tesouraria | 34 | 19 / 15 / 0 | +4676 −182 |
| Portais BLL/BNC + chat/monitoramento | 33 | 20 / 13 / 0 | +4029 −1493 |
| Reorg de módulos/menu | 28 | 4 / 13 / 11 | +3722 −3095 |
| Fiscal (NF-e/NFS-e/NFC-e/DRE) | 20 | 10 / 6 / 4 | +2468 −1229 |
| Licitações/PNCP/IA | 20 | 16 / 4 / 0 | +2797 −132 |
| Governança/alçadas/aprovações | 18 | 10 / 8 / 0 | +2928 −137 |
| Notificações/comunicação | 14 | 6 / 8 / 0 | +2128 −117 |
| Comissões/RH/usuários | 13 | 5 / 8 / 0 | +3952 −149 |
| Core/infra | 13 | 13 / 0 / 0 | +322 −136 |
| OS/equipamentos | 12 | 6 / 6 / 0 | +2186 −364 |
| Patrimônio/contábil | 10 | 1 / 9 / 0 | +2203 −3 |
| Varejo/PDV/marketplaces | 7 | 4 / 3 / 0 | +1809 −11 |
| Contratos/recorrência | 2 | 1 / 1 / 0 | +378 −4 |

### Ordem recomendada

1. **Reorg de módulos/menu primeiro e junta, com `git add -A` na frente
   inteira de uma vez.** São ~11 pares deletado→novo (`public/financeiro/` →
   `public/contabilidade/`, `public/cobranca/`, `public/fiscal/`;
   `public/configuracoes/` → `public/operacional/`, `public/fiscal/`;
   `public/rh/patrimonio.html` → `public/patrimonio/bens.html`;
   `public/fiscal/nfe-inbox.html` → `manifestador.html`). O `mover_modulos.py`
   na raiz é o script que fez isso e vai junto. Só com as duas pontas no mesmo
   commit o git detecta rename; espalhada, cada metade vira "apagado + novo" e
   o histórico perde o rastro.
2. As frentes de negócio, cada uma inteira, em qualquer ordem.
3. **Core/infra por último, ou fatiado junto de cada frente.** São 13
   arquivos modificados e só +322 linhas — os pontos de registro
   (`route-registry.js`, `role-dispatch.js`, `db-schema.js`, `plan-modules.js`,
   `features-routes.js`, `scheduler.js`, `tenant-middleware.js`). Quase toda
   frente pendura uma linha aqui, então esse grupo não commita sozinho de
   forma limpa.

### Os 7 módulos untracked que o core/infra arrasta

Commitar core/infra sozinho **deixa o HEAD sem bootar**: o `route-registry.js`
e o `db-schema.js`/`scheduler.js` da árvore já registram módulos que ainda não
estão no git. Fecho transitivo (fecha em 7, não explode):

```
chat-monitor-config.js          <- db-schema.js, chat-monitor-routes.js
chat-monitor-routes.js          <- route-registry.js
comprasnet-mensagem-routes.js   <- route-registry.js
notificacoes-routes.js          <- route-registry.js
resultado-item-routes.js        <- route-registry.js
governanca-avisos.js            <- scheduler.js
os-notificacoes.js              <- scheduler.js
```

Eles vêm de 6 frentes diferentes. Levá-los junto do core/infra faz o HEAD
bootar, mas descola cada um da sua frente (`governanca-avisos.js` sem o
`governanca-routes.js` que o chama, `os-notificacoes.js` sem o `os-routes.js`)
— troca uma inconsistência gritante por seis silenciosas. Preferir commitar as
frentes antes.

**Ao commitar qualquer frente, verifique o fecho de requires do HEAD, não o da
árvore.** Foi exatamente esse erro que deixou o HEAD quebrado entre b2bacdb e
e094c43: o levantamento leu a versão da árvore do `scheduler.js`, que já não
tinha o jornal, e não viu o `require('./jornal-scheduler')` que seguia vivo no
HEAD.

### Commits parciais em aberto

`route-registry.js` (aecb543) e `scheduler.js` (e094c43) estão no HEAD em
versão **parcial**: entraram só as linhas que removem o jornal, montadas
direto no índice via `git hash-object` + `git update-index`, sem tocar a
árvore. Ambos seguem modificados e devem ir inteiros junto do core/infra. O
que ficou de fora está listado no corpo de cada commit.

### Três pendências que saem daqui

1. **A fiação do watchdog do catálogo está viva em produção mas fora do git.**
   O `scheduler.js` da árvore ganhou `ligarWatchdogCatalogo()` e
   `_dbParaAlertaMaster()` — a vigilância das engines do catálogo criada em
   6c485a7 depois de o `resultados-backfill` ter morrido calado por 4 dias. O
   `catalog-watchdog.js` está commitado; **quem o liga, não**. O commit
   parcial e094c43 deixou isso de fora de propósito. Enquanto não for
   commitado, o histórico não explica por que o watchdog existe nem quem o
   inicia, e um `git checkout` do HEAD produz um sistema com o watchdog morto.
2. **`enviarAlerta` não tem granularidade por tipo de aviso — é tudo ou nada
   por canal, por tenant.** O `notificacoes-dispatcher.lerCanais` lê três
   chaves globais (`alerta_canal_telegram`, `alerta_canal_email`,
   `alerta_email_destinatarios`) e despacha para todo canal ligado, sem olhar
   o conteúdo. O `logTag` (ex.: `'Alcada'`) chega até o ponto da decisão e só
   é usado em `console.error` — o dado para filtrar já viaja até lá, falta a
   decisão. Consequência concreta: o tenant `reimac` desligou o Telegram e
   ligou o email; passa a receber por email o aviso de alçada que nunca pediu,
   sem poder recusar só esse. **O padrão que resolve já existe neste repo**:
   `os-notificacoes.js` usa `os_notificacoes_config(evento, canal, template,
   ativo)`, uma linha por par evento×canal, e o `dispatchNotificacoes`
   consulta as regras ativas do evento antes de enviar. Falta generalizar
   para fora de OS. Não mexido — decisão do usuário.
3. **`participacoes_comprasnet`: 31.737 ocorrências** de `[Alerta] Erro ao
   verificar disputas: no such table` — ver o primeiro item de "Pendências
   conhecidas" abaixo. Continua não investigado.

## Pendências conhecidas

- **Restaurante: não há histórico de turnos fechados** (anotado 2026-09-25, a
  pedido, para construir depois). A diferença do caixa fica gravada em
  `rest_turnos.diferenca`, mas as rotas são só `/turnos/atual` e
  `/turnos/:id`, e a tela do Caixa mostra só o turno aberto. A diferença
  aparece uma vez, na mensagem logo após fechar, e some.
- **Mesmo defeito de fuso, fora do que foi corrigido em 25/09:** o scheduler
  compara `os_ordens.dataPromessa` (data local) com `date('now')` em UTC, e a
  OS vira "atrasada" às 21h; `movimentacoes_estoque.data` mistura data local
  com data e hora UTC da baixa do restaurante; o evento SNGPC da farmácia grava
  a emissão da NFC-e e merece conferência própria.
- **`[Alerta] Erro ao verificar disputas: no such table:
  participacoes_comprasnet`** — 31.737 ocorrências no `server.log` até
  2026-08-11, a primeira lá pela linha 520.699. Alguma verificação de disputa
  falha calada há muito tempo: o alerta é engolido e o erro só aparece no log.
  Não investigado — trabalho para outro dia.
- `[Polling Boletos] Erro boleto #32 e #51: MercadoPago 404` — 16.410
  ocorrências no mesmo período. Mesma situação: antigo, recorrente, não
  investigado.
- **`cicloAvisoAlcadas` passa a mandar mensagem no próximo restart do
  `liciteagora.service` — ninguém foi avisado disso** (anotado 2026-08-11).
  O `scheduler.js` da árvore de trabalho ganhou um ciclo de 6 em 6 horas
  (`ALCADA_AVISO_INTERVAL_MS`) que varre todos os tenants via
  `governanca-avisos.avisarExpirando` e dispara aviso de aprovação prestes a
  vencer. Hoje não roda: o `scheduler.js` em memória é o antigo. **O primeiro
  restart liga o envio**, e o mesmo vale para o watchdog do catálogo
  (`_dbParaAlertaMaster` → primeiro tenant com Telegram ativo).

  Quem receberia, levantado nos bancos em 2026-08-11:

  | Tenant | Canal | Destino |
  |---|---|---|
  | `1bit` | Telegram ativo, token ok | chat **1594299485** (id positivo = conversa privada, não grupo) |
  | `reimac` | Telegram **desligado** (`alerta_canal_telegram=0`), email ligado | **werick@reimac.com.br** — cliente externo |
  | outros 9 | sem `telegram_config`, email off | ninguém (`sendTelegram` devolve false) |

  O `1bit` não tem a chave `alerta_canal_telegram` gravada e o default do
  `notificacoes-dispatcher.lerCanais` é **ON** — canal ligado por omissão, não
  por escolha. O único destino externo é o email do `reimac`.

  Amortecedor: `aprovacoes` com `status='pendente' AND consumida=0 AND
  expiraEm IS NOT NULL` = **0 em todos os 11 tenants** nessa data. Com a fila
  vazia o primeiro ciclo não manda nada — mas isso é estado de dado, não
  garantia: basta uma aprovação nascer para o envio começar. Cada aprovação
  avisa uma vez só (`avisoExpiracaoEm`).

### O que passa a valer no próximo restart

Esta lista existe porque aqui a edição de um `.js` não entra em vigor sozinha:
o processo vivo segue com a versão que leu no boot. Antes de reiniciar, leia o
que muda. **Mantenha a lista atualizada a cada edição de `.js` da raiz**, e
esvazie a parte do serviço que foi reiniciado.

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

**Enquanto o sandbox estiver ACTIVE**, reinicie pelo
`backups/sandbox-video-2026-09-23/reiniciar-com-sandbox-suspenso.sh`, que
reinicia os dois serviços com o sandbox suspenso durante o boot.

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
**01/10 08:00** e deixaria "Falhou em 10/2026" nas 250 linhas. Para desarmar,
reinicie pelo `reiniciar-com-sandbox-suspenso.sh` antes disso.

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

Como `rm` está negado por inteiro, rascunho e arquivo temporário vão para
`/tmp`, não para a árvore.

`ExitPlanMode` está fora do allow de propósito: sair do modo de planejamento é
decisão sua.

## Notas / divergências conhecidas

As units systemd versionadas no repo divergem das instaladas em
`/etc/systemd/system/` (confirmado em 2026-07-28):

- O `liciteagora.service` **do repo** diz `ExecStart=node server.js` — está
  desatualizado. O **instalado** roda `node scheduler.js` como root
  (ROLE=master, sem HTTP) e escreve log em `server.log` (nome enganoso).
- O `server.js` roda por outra unit, **`consulta-licitacoes.service`** (não
  versionada no repo): user carlosfinezi, `--max-old-space-size=4096`,
  PORT=3000, ROLE=worker, MULTI_TENANT=true. Essa unit instalada contém
  segredos (chaves de API) — não copiá-la para o repo.

Ao raciocinar sobre restart/systemctl, use as units **instaladas** como fonte
da verdade, não as cópias do repo.

### O ambiente do root é cópia do do carlosfinezi

As sessões daqui rodam como root, e o root só carrega o que está em
`/root/.claude`. Em 29/09/2026 ele recebeu o mesmo conjunto do carlosfinezi,
tudo de posse do root e sem nada executando arquivo da home dele. Nada disso
se atualiza sozinho. Atualizou lá, o root refaz aqui:

- **Skills** `impeccable`, `motion-design` e `graphify` em
  `/root/.claude/skills/`: recopiar com `cp -r`, `chown -R root:root` e
  `chmod 755` no `impeccable/scripts/impeccable`, que vem sem o bit. Duas
  diferenças a recolocar depois da cópia: o `craft-floor.md` do Impeccable
  leva cinco regras que só a variante do Codex (`~/.agents`) tinha, e o
  `SKILL.md` do graphify leva no topo a seção "LiciteAgora: consultar, nunca
  construir".
- **Binário do Impeccable**: o launcher baixa sozinho para
  `/root/.impeccable/bin/<versão>` a versão do `scripts/VERSION`.
- **Ponytail 4.9.0**, com os ganchos: marketplace de diretório em
  `/root/.claude/plugin-sources/ponytail`, um clone do
  `DietrichGebert/ponytail` parado no `356918e`, o mesmo commit do
  carlosfinezi. O marketplace do GitHub não fixa commit, e o `main` já está na
  4.10.0. Para atualizar: `git -C` no clone com `fetch` e `checkout` da nova
  referência, depois `claude plugin marketplace update ponytail` e
  `claude plugin update ponytail@ponytail`.
- **Graphify**: o programa fica na venv `/root/.local/share/graphifyy`
  (`graphifyy[sql]==0.9.56`) e se atualiza com
  `python3 -m pip --python /root/.local/share/graphifyy/bin/python install "graphifyy[sql]==<versão>"`.
  A consulta é pelo `graphify-liciteagora` (`/root/.local/bin`), que só lê o
  grafo do carlosfinezi. O grafo continua sendo reconstruído por ele, pelo
  `su - carlosfinezi`.
- **CLAUDE.md global**: `/root/.claude/CLAUDE.md` é cópia do
  `/home/carlosfinezi/.claude/CLAUDE.md`, a recopiar quando aquele mudar. O
  anterior, o Karpathy Guidelines, está em
  `/root/.claude/CLAUDE.md.karpathy-antes-2026-09-29`.
- **Gancho do Impeccable: LIGADO**, na chave `hooks` do
  `/root/.claude/settings.json` (cópia do bloco em
  `/root/.claude/impeccable-hook.json`). Ele roda depois de cada Edit ou Write
  e no fim do turno, só sobre arquivo dentro da pasta da sessão, e avisa no
  contexto o que achou, sem bloquear. O cache vai para fora do projeto
  (`IMPECCABLE_CACHE_ROOT=/root/.impeccable/hook-cache`). O que ele grava no
  repositório é um bloco `# impeccable-hook-ignore-start`, uma vez só, no
  `.git/info/exclude`. Esse arquivo não é versionado e não aparece no
  `git status`, e o bloco foi aceito em 29/09.

Nesta árvore, não rode sem perguntar `impeccable hooks ignore-*`, `init`,
`document` nem o modo `live`: eles gravam `.impeccable/`, `PRODUCT.md` ou
`DESIGN.md` aqui dentro.

## Nunca faça sem perguntar

- Reiniciar serviço **fora de um fechamento** — aí o restart é sempre pedido
  seu. Como passo 7 do "fechamento" não exige pergunta; no "fechamento 0" não
  há restart. Os session-services (`bll-session`, `bnc-session`,
  `licitanet-collector`) e o `govbr-bearer` exigem pergunta sempre, inclusive
  dentro do fechamento
- `stop`, `disable`, `mask` ou `kill` de serviço: não são rotina nenhuma
- Tocar nos DBs de `data/` (schema, escrita direta, apagar)
- `sqlite3` / `psql` além de leitura: SELECT e PRAGMA seguem livres; qualquer
  escrita, DDL ou DELETE vira pergunta. Nenhum padrão de permissão distingue um
  SELECT de um DROP na mesma linha de comando — essa regra vive aqui, o
  settings não a garante
- `cp` / `rsync` sobre arquivo `.db` (corrompe banco em WAL — use `.backup`)
- Subir o server na porta de produção (para testes, use porta alternativa + DB descartável — e só com aprovação)
- `git commit` / `git push` (exceto os passos 4 e 5 do "fechamento")
- `git stash`, `git reset --hard`, `git clean`: nesta árvore isso não é
  limpeza, é apagar produção não commitada
- Instalar dependência (npm install)
