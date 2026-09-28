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
27/09/2026.

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

Para isso, **o static de `public/auth` deixou de ser montado antes do
middleware de tenant**. Agora é `base-middleware.servirTelaDeLogin`, chamado
pelo `auth-pipeline` depois da sessão e do `vitrineAntesDoLogin`. Duas
consequências: host desconhecido recebe o 404 do tenant em vez da tela de
login, e o painel admin continua servido porque o host `admin` passa pelo
middleware de tenant. O `vitrineNaBarreira` fica logo antes do
`requireAuth`. A configuração é lida com cache de 15 s por tenant, e quem grava
chama `esquecerVitrine`.

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

Linha de base **2026-09-25: uma falha conhecida, a etapa 21**
(`test-catalogo-online-ux`). Em 21/09 o menu ⚙️ Configurações do Catálogo
Online ganhou a sétima opção, "Regras fiscais", e a suíte continua esperando 6
(`test-catalogo-online-ux.js:634`). O menu está certo e a suíte é que ficou
para trás. Ela está em `FALHAS_CONHECIDAS`, no `verify.js`: reprova igual, mas
sai marcada como conhecida, e o fim da saída separa as conhecidas das novas.
Qualquer outra falha é regressão nova. Quando a suíte for atualizada, tire a
entrada de lá.

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

**`consulta-licitacoes.service`** (o `server.js`) — boot atual: **2026-09-17
10:16**, reiniciado no passo 7 do fechamento.

**Pendente: o faturamento do contrato por nota avulsa** (17/09, tarde).
Quatro arquivos da raiz mudaram e nenhum está em vigor: `db-schema.js`
(coluna `nfse.contratoId` mais o índice — a migration roda no boot, e até lá
nenhum tenant tem a coluna), `contratos-routes.js` (`notasAvulsas` no detalhe
e as rotas `nfse-disponiveis` / `vincular-nfse`), `nfse-routes.js`
(`emitirNfseInterno` carimba o contrato de origem) e `perfis-api-map.js`
(perfil `nfse` ganhou acesso a `/api/contratos`).

As telas, por serem estáticas, **já estão no ar** e convivem com o servidor
antigo sem quebrar: o bloco "Notas avulsas deste contrato" fica escondido
enquanto o detalhe não devolver `notasAvulsas`. O que não funciona até o
restart é emitir pela tela do contrato com o vínculo: o `POST /api/nfse/emitir`
em memória ignora o `contratoId` e a nota sairia solta.

O que entrou em vigor nesse restart, e que vale saber porque muda
comportamento: **a NFC-e da comanda do restaurante passou a funcionar.** Antes
dele, `POST /api/restaurante/comandas/:id/emitir-nfce` respondia 400 com
"emitirNFCe is not a function" em toda chamada. Agora a nota **sai de verdade
na SEFAZ**, então o primeiro teste vale ser feito em homologação e não numa
comanda real.

Como decidir o que está pendente, da próxima vez: `stat -c '%y' <arquivo>`
contra o `ActiveEnterTimestamp` da unit. Arquivo mais antigo que o boot já está
carregado, e commitá-lo não muda nada em produção. Foi assim que se descobriu
que quase toda a leva de 16/09 já estava no ar e só o `nfce-routes.js` faltava.

**`liciteagora.service`** (o `scheduler.js`) — **nada pendente**, e o medo
antigo não se aplica mais.

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
