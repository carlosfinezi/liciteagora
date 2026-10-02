# Verify: a seção inteira, com as medições

Era a seção "Verify" do CLAUDE.md até 02/10/2026, e saiu de lá com o texto
preservado. O resumo que vale está no CLAUDE.md. Os números abaixo são das
datas citadas e envelheceram: a última rodada está em
`/var/lib/liciteagora-verify/ultimo.json` (173 etapas em 1.626 s com 4
trabalhadores, em 02/10/2026). Onde o texto diz "nenhuma das 29 etapas", o
número já estava errado; a frase vale para todas. A lista de arquivos que
obrigam o verify inteiro é a do `OBRIGA_INTEIRO`, no `verify.js`, e manda sobre
a cópia daqui.

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
