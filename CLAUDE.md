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

## Verify

```
npm run verify
```

`node --check` em massa nos .js da raiz e de `scripts/` — valida sintaxe sem
executar nada. Linha de base 2026-07-28: 100% OK; qualquer FAIL é regressão
nova. Rode após qualquer edição de .js.

`node --check` valida só sintaxe, não comportamento — passar no verify
significa que o código parseia, não que funciona. Teste de runtime continua
sendo manual.

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

Antes de commitar, confirme que a working tree é exatamente o que foi testado —
nada pode ter mudado depois do "ficou bom". Ao concluir, informe o resultado do
push (branch, hash, sincronização com origin) e o dos restarts.

**"fechamento 0"** (mesmo fluxo, a ÚNICA diferença é o restart): igual ao
"fechamento" — incluindo o push automático — mas SEM o passo 7. Não reinicia
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
chamada manual, sob demanda, **nunca** dentro do fechamento. O script não apaga
backup antigo — só relata o espaço ocupado e o disco livre.

Restaurar backup nunca é rotina: só a pedido explícito.

**"estado"** (leitura pura, não escreve nada):

1. `systemctl is-active` dos serviços da tabela de intocáveis
2. `git status` resumido
3. `npm run verify`

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
