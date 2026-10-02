# LiciteAgora — instruções para Claude Code

Sistema de gestão de licitações públicas (PNCP/Comprasnet/BLL/BNC) multi-tenant.

## ⚠️ AVISO CRÍTICO: este working tree É a produção

Produção roda diretamente deste diretório — **editar um arquivo aqui é editar
produção**. Não há deploy separado, staging nem build. Para código carregado
pelo Node, a mudança só entra em vigor no restart do processo; para arquivos
em `public/` (estáticos), a mudança fica no ar imediatamente ao salvar.

**O que está no ar se descobre pelo relógio, e não por anotação.** Antes de
dizer se uma mudança está em vigor, compare o `mtime` do arquivo com o
`ExecMainStartTimestamp` da unit que o carrega
(`systemctl show -p ExecMainStartTimestamp <unit>`): arquivo mais novo que o
boot ainda não está no ar. A lista escrita à mão errou esse estado várias vezes.

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
suspendem o tenant sozinhos.

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

### Reiniciar com um demo ACTIVE

Reiniciar o `liciteagora.service` com um demo ACTIVE arma os jobs dele: o
`ligarJobsPorTenant` (`scheduler.js`) percorre os tenants ativos e não
distingue demo. Não suspenda o demo de outra sessão para isso. Antes do
restart, confira que ele não tem robô do PCP ligado, campanha agendada ou em
`enviando`, canal de WhatsApp nem recorrência a vencer; havendo, combine com o
usuário. O `backups/sandbox-video-2026-09-23/reiniciar-com-sandbox-suspenso.sh`
é da gravação de 23/09 e não vale com dois demos: conhece só o `sandbox`,
suspende um tenant que pode ser de outra sessão e o deixa parecendo livre
durante o boot.

### A loja pública e o static do login

A loja como página inicial, o 404 dentro de `/loja/`, o tema e os ícones da
vitrine estão descritos em `docs/loja-vitrine.md`. Leia-o antes de mexer em
`loja-routes.js`, no `base-middleware.js` ou no `auth-pipeline.js`. Duas regras
ficam aqui:

- **o static de `public/auth` é montado DEPOIS do middleware de tenant**
  (`base-middleware.servirTelaDeLogin`, chamado pelo `auth-pipeline`). Por isso
  host desconhecido recebe o 404 do tenant, e o painel admin continua servido
  porque o host `admin` passa pelo middleware de tenant. A configuração da
  vitrine tem cache de 15 s por tenant, e quem grava chama `esquecerVitrine`;
- **domínio próprio não existe**: o `resolveFromHost` só reconhece
  `<slug>.liciteagora.app`.

## Verify

O texto inteiro desta seção, com as medições e o porquê de cada peça, está em
`docs/verify.md`. Leia-o antes de mexer em `scripts/verify.js`,
`banco-de-teste.js` ou `guarda-dados.js`, e antes de escrever suíte nova.

```
systemctl start --no-block liciteagora-verify     # dispara e volta na hora
systemctl is-active liciteagora-verify            # "activating" = ainda rodando
cat /var/lib/liciteagora-verify/ultimo.json       # resultado da última rodada
tail /var/lib/liciteagora-verify/rodando.log      # a rodada em curso
```

**O verify inteiro roda pelo serviço, e quem dispara não espera**: volta depois
e lê o `ultimo.json` (`estado`, `commit`, arquivos sujos, tempo de cada etapa,
falhas com `conhecida: true|false` e `falhasNovas`). O serviço usa 4
trabalhadores (`--paralelo 4`) e leva perto de meia hora: 173 etapas em 1.626 s
na rodada de 02/10/2026. Isso é o normal, não mate o processo. O
`npm run verify` roda em sequência (sem `--paralelo`) e levava de 57 a 67 min já
com 136 etapas. O verify morreu duas vezes junto com a sessão que o rodava, e é
por isso que o serviço existe.

- As etapas 1 a 3 são sintaxe: `vm.Script` em todo .js da raiz, de `scripts/`
  e de `public/`, mais o JavaScript embutido nas telas. O resto são suítes
  funcionais.
- **O banco de teste sai do schema do tenant, extraído na hora** por
  `scripts/schema-de-tenant.js`, em modo somente leitura. Nunca volte a ler
  schema de arquivo local: o verde seria falso.
- Passar no verify não prova que a sua mudança funciona. O teste de runtime do
  caminho tocado continua manual.
- **Falha conhecida é a que está em `FALHAS_CONHECIDAS`, no `verify.js`.** Ela
  reprova igual, mas sai marcada, e o fim da saída separa as conhecidas das
  novas. Hoje é só a `test-catalogo-online-ux`, nas quatro larguras: o menu
  ⚙️ Configurações do Catálogo Online tem 8 opções e a suíte espera 6
  (`test-catalogo-online-ux.js:634`). Quando a suíte for atualizada, tire a
  entrada de lá.
- As falhas da vitrine em obra (`test-catalogo-publico-49`, `fase50` e
  `fase51`) saem como NOVAS de propósito: marcá-las esconderia regressão de
  verdade. Para provar que uma frente não causou uma falha, compare item a item
  com o `ultimo.json` da rodada anterior.
- A unit vive em `scripts/liciteagora-verify.service` e é instalada com
  `install -m 644 scripts/liciteagora-verify.service /etc/systemd/system/ &&
  systemctl daemon-reload`. Mudou a unit, reinstale. **Roda como carlosfinezi,
  e não como root, de propósito**: executa código desta árvore.
- O serviço tem `/tmp` próprio (`PrivateTmp=yes`), e suíte não pode depender de
  arquivo feito à mão em `/tmp`. Insumo real que não sai do banco fica em
  `/var/lib/liciteagora-verify/insumos/`.
- Uma rodada por vez (trava em `/run/lock/liciteagora-verify.lock`, recusa com
  código 3) e o teto de 30 min por suíte já são do `verify.js`. O
  `scripts/verify-servico.sh` roda também à mão
  (`VERIFY_SAIDA=/tmp/x scripts/verify-servico.sh --rapido arquivo.js`).
- `npm run verify:legado` é o `node --check` antigo, em torno de 40 segundos.
  Serve para conferir sintaxe depressa, e não substitui o verify.

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
2. **quando mexer em arquivo compartilhado.** A lista é o `OBRIGA_INTEIRO`, no
   `verify.js`, e com um deles alterado o modo rápido se recusa sozinho e roda
   o inteiro;
3. **antes de afirmar que uma mudança não quebrou outra coisa.** O rápido só
   responde pelas suítes que ele escolheu.

Na árvore de produção, `--rapido` sem arquivos quase sempre vira inteiro,
porque outras frentes deixam `db-schema.js` e companhia sujos. Para o que é
seu, cite os arquivos.

### Nenhuma suíte escreve em `data/`

O `scripts/guarda-dados.js`, que o `verify.js` injeta em cada suíte por
`NODE_OPTIONS`, reprova na hora abrir banco de `data/` sem `readonly` ou gravar
arquivo lá. Suíte que precise de dado real usa `copiaDoTenant(slug)`, do
`scripts/banco-de-teste.js`, que devolve uma cópia temporária. O limite da
guarda é processo que não é node: o binário `sqlite3`, nas suítes, só com
`?mode=ro`.

## Rotinas

Rotinas separadas — não misturar. **Nenhuma delas reinicia serviço** (ver
"Serviços vivos INTOCÁVEIS"): restart é sempre pedido explícito seu, fora de
qualquer rotina.

**"fechamento"** (uma vez, depois de você aprovar o que está no ar):

Aqui não existe deploy — o código aprovado já está em produção desde a edição.
O fechamento não publica nada; ele torna durável e rastreável o que já está
rodando, e declara o que ainda não entrou em vigor.

1. backup: `scripts/backup-tenants.sh`
2. verify inteiro pelo serviço (ver "Verify"), sem falha nova
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

   Use os nomes de unidade exatos: `consulta-licitacoes.service` e
   `liciteagora.service`.

   Na dúvida sobre qual dos dois processos carrega o arquivo, reinicie os dois:
   ambos leem a mesma raiz flat.

   **Exceção dos session-services**: mesmo dentro do fechamento, eles são caso
   à parte. O anti crash-loop do systemd (5 restarts/10min) pode deixá-los
   parados de vez e o relogin queima solve pago de captcha. Se a mudança tocar
   um deles, pare e pergunte — não reinicie por conta do fechamento.

   Com o `settings.local.json` de hoje, o restart deles passa sem prompt (ver
   "Permissões"). A ressalva depende de você lembrar dela.

   Depois de reiniciar, **confirme que o serviço voltou**:
   - `consulta-licitacoes.service`: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health`
     (responde 302 — qualquer 2xx/3xx prova que subiu; timeout ou 000, não)
   - `liciteagora.service`: não tem HTTP — `systemctl is-active` mais as últimas
     linhas de `server.log` sem stack de boot

8. grafo: `~/graphify/liciteagora/atualizar-grafo.sh fechamento --esperar`.
   Ele espera a rodada em curso e refaz uma vez, sobre o disco final. O porquê
   (rodada que chega com o lock tomado é descartada, e o gancho tem debounce de
   30 min) está no cabeçalho do script.
9. `/home/carlosfinezi/apps/biturion/scripts/conferir-claude-md.sh CLAUDE.md 48000`.
   Avisando, tire o que ficou velho antes de fechar.

Antes de commitar, confirme que a working tree é exatamente o que foi testado —
nada pode ter mudado depois do "ficou bom". Ao concluir, informe o resultado do
push (branch, hash, sincronização com origin) e o dos restarts.

**Ao commitar, confira o fecho de `require` do HEAD, e não o da árvore.** Um
arquivo commitado que requer módulo ainda fora do git deixa o HEAD sem bootar.

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

## Permissões (`.claude/settings.json` e `.claude/settings.local.json`)

Os dois arquivos valem para quem abre sessão nesta pasta, root inclusive. O que
o `/root/.claude/settings.json` acrescenta não está conferido aqui: ele não é
legível pelo carlosfinezi.

O `settings.json` traz `defaultMode: acceptEdits`, allow exato para `restart` e
`stop` das duas units comuns (`consulta-licitacoes.service` e
`liciteagora.service`, com e sem `sudo`) e deny para `rm`, `stop` dos
session-services, do `govbr-bearer` e da infraestrutura (`postgresql`, `redis`,
`nginx`, `bind9`/`named`), `disable`/`mask`/`kill` de serviço,
`pkill`/`killall`, `git stash`/`reset --hard`/`clean`/`push --force`,
`npm install`, Edit em `data/` e leitura e escrita de `.env`. Deny vence allow
de qualquer arquivo.

**O `settings.local.json` libera o resto**: `Bash(systemctl:*)`,
`Bash(git add:*)`, `Bash(git commit:*)`, `Bash(git push:*)`, `Bash(sqlite3:*)`,
`Bash(node:*)` e `Bash(curl:*)`, entre outros. Na prática:

- **commit, push e restart passam sem prompt.** O restart de QUALQUER unidade
  passa, inclusive `bll-session`, `bnc-session`, `licitanet-collector` e
  `govbr-bearer`. O `start` também, e o `stop` de unidade fora do deny;
- o `stop` dos session-services só é negado com o sufixo: `systemctl stop
  bll-session.service` é recusado, e `systemctl stop bll-session` passa;
- escrita em banco de `data/` por `sqlite3` ou por `node` passa sem prompt. O
  deny de `data/` cobre só a ferramenta Edit;
- continuam barrados o `rm`, `disable`/`mask`/`kill`, `pkill`/`killall`, o git
  destrutivo, o `npm install` e o `.env`.

Por isso as regras de "Nunca faça sem perguntar" e a exceção dos
session-services valem pela conduta de quem trabalha aqui, e nenhum settings as
garante.

Como `rm` está negado por inteiro, rascunho e arquivo temporário vão para
`/tmp`, não para a árvore. `ExitPlanMode` está fora do allow de propósito: sair
do modo de planejamento é decisão do usuário.

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
- **`enviarAlerta` é tudo ou nada por canal e por tenant**: não há como recusar
  um tipo de aviso só. O `logTag` já chega ao ponto da decisão, e o padrão que
  resolve é o `os_notificacoes_config` de `os-notificacoes.js`. Decisão do
  usuário.
- **A loja usa a cópia própria das máscaras** (`public/loja/catalogo.js`), e não
  a peça `public/js/campo-formato.js`, por decisão do usuário, até ele avisar
  que a frente do Cantinho Verde terminou. Os três passos para reaplicar a
  extração, nenhum opcional, estão em `docs/boots.md` ("Pendente: reaplicar a
  extração da peça de campo na loja").

### O que passa a valer no próximo restart

Esta lista existe porque aqui a edição de um `.js` não entra em vigor sozinha:
o processo vivo segue com a versão que leu no boot. Antes de reiniciar, leia o
que muda. **Mantenha a lista atualizada a cada edição de `.js` da raiz**, e
esvazie a parte do serviço que foi reiniciado.

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

**O diário dos boots** (o que cada restart pôs no ar de 17/09 a 01/10/2026, com
as provas e as sabotagens) está em `docs/boots.md`. Leia-o para saber por que
uma regra existe ou como uma frente foi provada. Para saber o que está no ar,
ele não serve: compare o `mtime` com o `ExecMainStartTimestamp`, como manda o
aviso do topo.

## O que o diário de boots ensinou

Cada item saiu de um defeito real, e o relato está em `docs/boots.md`.

- **Schema vai no `db-schema.js`.** O `migrarDB` chamado pelo registro de rotas
  passa pelo BOOT_STUB do proxy multi-tenant e não alcança tenant nenhum.
- **Upload pelo multer precisa do `reentrarContextoTenant`**, porque em produção
  o `db` é o proxy do contexto do tenant. Suíte que dá à rota o banco cru passa
  sem provar nada; a 147 (`test-upload-comunicacao`) usa o proxy de verdade.
- **Script que lê antes de gravar abre a transação com `.immediate()`.** Com o
  servidor gravando no meio, a transação diferida morre com
  `SQLITE_BUSY_SNAPSHOT`.
- **Suíte mede a regra, e não o dado de produção.** A 142 reprovou sem defeito
  quando o 1bit criou um número novo de WhatsApp.
- **O mesmo extrato por duas portas (OFX e API) lança o dinheiro em dobro.**
  Quem as casa é o `jaVeioPelaOutraPorta`, uma linha existente para cada nova.
- **A mídia do WhatsApp expira no CDN em ~26 dias**, e por isso se guarda no
  recebimento. No `messages.delete` da Evolution, `data.key.id` tem precedência
  sobre `data.id`.
- **O LID do WhatsApp gravado em `wa_optout` não casa com telefone**, e nenhuma
  campanha compara com ele.
- **No roteiro, a resposta pelo número é resolvida pelo Node, e não pela IA**: um
  trecho `"2"` casa com qualquer "2" da conversa. Os gatilhos de desvio exigem o
  verbo junto do objeto, e os desvios vêm depois das guardas do `autoResponder`.
- **Modelo de mensagem sai literal, e exemplo é imitado.** Ao trazer um modelo
  para exemplo, resolva as variáveis antes de gravar. Segmento se define por
  palavra, e não por regex.
- **`pedido.dataFaturamentoPrevista` não é vencimento.** O vencimento sai da
  condição de pagamento gravada no pedido.
- **Nenhuma NFC-e sai enquanto `loja_config.tipoOperacaoNfceId` for NULL**, e o
  checkout público não emite (o K2 de `test-catalogo-fiscal` guarda isso).
- **No lance, o milésimo do disparo é onde o ÚLTIMO lance chega**, e não onde a
  rajada começa. Escada descendente contra robô que cobre na variação mínima não
  vence: arrasta os dois para baixo. No PCP, o relógio do portal só tem
  resolução de segundo e a sessão vale 5 min.
- **O Postgres do catálogo está em `America/Sao_Paulo`, e o SQLite dos tenants
  grava `CURRENT_TIMESTAMP` em UTC**: cruzar os dois exige converter. Comparar
  `recebidoEm` gravado por `toISOString()` com `datetime('now')` casa linha
  demais (`' ' < 'T'`), então o corte sai do JS, em ISO.
- **O catálogo se conta no backend certo**, o Postgres. O cooldown da API do
  PNCP vive em memória e o restart o zera: não reinicie o `liciteagora.service`
  durante um bloqueio. O sintoma do bloqueio é `https://pncp.gov.br/` responder
  302 enquanto `/api/consulta/v1/...` fica pendurado até o timeout.
- **`chat_mensagens.cnpjOrgao` guarda a UASG, e `sequencial` guarda o
  numeroCompra**: o casamento é por UASG + numeroCompra + ano, nunca pela chave
  do PNCP. O RBAC é fail-closed por prefixo de rota. ÓRGÃO (PNCP) e UNIDADE
  (Comprasnet) são nomes diferentes da mesma compra. O sinal de proposta
  enviada é o `kanbanStatus`, e o `lido` está em 0 em todas as mensagens.
- **O static protegido devolve a tela de login com status 200** a quem pede
  `/js/x.js` sem sessão, e um `<script src>` que recebe HTML não avisa nada.
  Peça usada por tela pública entra na liberação do `pre-auth-routes.js`
  (suíte 161).

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
