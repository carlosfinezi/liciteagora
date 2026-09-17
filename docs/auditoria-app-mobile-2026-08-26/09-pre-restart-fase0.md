# Auditoria pré-restart — o que entra em vigor se reiniciarmos agora

Data: 2026-09-10, 17:52 BRT · Auditoria **somente leitura**, antes de qualquer restart.
Base: [`06`](06-fase-0-frete-pagamento.md) · [`07`](07-fase-0-quantidade.md) · [`08`](08-fase-0-limites-quantidade-pagamento.md).

> **Nada foi alterado.** Nenhum código, nenhum banco, nenhum serviço, nenhum
> commit, nenhum `reset`/`stash`/`clean`. O único arquivo criado é este.

---

## 0. A conclusão, antes dos detalhes

A premissa de que "um restart carregaria as ~160 alterações do working tree"
**está errada, e isso é uma boa notícia.**

O processo web em produção subiu em **2026-09-09 15:43:57** — ontem. Tudo que foi
modificado **antes** disso já está rodando há mais de um dia. Cruzando os mtimes
com o horário do start, **apenas 5 arquivos `.js` entram em vigor no restart**:

| Arquivo | Modificado | Frente |
|---|---|---|
| `pcp-proposta.js` | 09/09 16:06 | **outra frente** — download de edital do PCP |
| `pcp-routes.js` | 09/09 16:06 | **outra frente** — idem + pregões silenciados |
| `pedido-politicas.js` | 10/09 14:16 | nossa — vendedor restrito não define preço |
| `contas-receber-routes.js` | 10/09 16:20 | nossa — sincronização de pagamento |
| `pedidos-routes.js` | 10/09 17:10 | nossa — frete, quantidade, 410 |

Os outros 43 arquivos de backend modificados **já estão em produção** desde
ontem, com **zero erros no journal** em mais de 26 horas. O restart não os ativa
— eles já estão ativos.

**Recomendação: GO**, com uma ressalva importante sobre o segundo serviço (§8).

---

## 1. Estado do serviço

### 1.1 `consulta-licitacoes.service` — o servidor web

| | |
|---|---|
| Estado | **active (running)**, há 1 dia e 2 h |
| **Último start** | **2026-09-09 15:43:57 -03** |
| `NRestarts` | **0** — não houve crash-loop nem restart desde então |
| MainPID | 263220 |
| Comando | `/usr/bin/node --max-old-space-size=4096 server.js` |
| WorkingDirectory | `/home/carlosfinezi/web/liciteagora.com.br/private` |
| User | `carlosfinezi` |
| Ambiente | `NODE_ENV=production`, `PORT=3000`, **`ROLE=worker`**, `MULTI_TENANT=true`, `CATALOG_BACKEND_PG=1` |
| Process manager | **nenhum** — systemd direto, sem PM2, sem nodemon, sem `--watch` |
| `/health` agora | **302** (o esperado) |
| Erros (`journalctl -p err`) desde o start | **0** |

**Não há hot-reload**: `node server.js` puro. Isso é o que torna a inferência por
mtime confiável — cada arquivo foi lido uma vez, no `require` do boot, e não é
relido depois.

### 1.2 Os outros serviços (nenhum será tocado)

| Serviço | Estado | Desde |
|---|---|---|
| `liciteagora.service` (scheduler, ROLE=master, root) | active | **2026-09-02 09:40** |
| `bll-session.service` | active | 2026-09-03 06:53 |
| `licitanet-collector.service` | active | **2026-09-10 16:29** (reiniciado hoje) |
| `bnc-session.service` | inactive | 2026-07-29 |
| `govbr-bearer.service` | inactive | 2026-07-23 |

---

## 2. HEAD e resumo do working tree

**HEAD: `5ec3474`** — *feat(producao): modulo de ordem de producao generico com
perfis de industria*.

**163 entradas** em `git status --porcelain`, classificadas:

| # | Grupo | Entradas | Entra em vigor no restart do web? |
|---|---|---:|---|
| 1 | **backend carregado pelo `server.js`** | **48** | só **5** (os demais já estão em vigor) |
| 2 | frontend `public/` | 69 | **não** — estático, já está no ar desde que foi salvo |
| 3 | `scripts/` e testes | 30 | não — não são carregados pelo servidor |
| 4 | documentação | 4 | não |
| 6 | `.js` fora do fecho do `server.js` | 6 | não pelo web (ver §4.2) |
| 7 | diretórios untracked de módulo | 6 | já carregados (nada dentro deles mudou após o start) |

O fecho de `require` do `server.js` tem **320 arquivos**; o do `scheduler.js`,
**129**.

---

## 3. Arquivos críticos, um a um

Legenda de risco: **baixo** = já em produção há dias, ou coberto por teste;
**médio** = entra agora, com teste; **alto** = entra agora, sem cobertura.

| Arquivo | Alterado | Diff | O que é da nossa frente | O que é de outra frente | Entra no restart? | Risco |
|---|---|---|---|---|---|---|
| `server.js` | **não** | — | — | — | — | — |
| `pedidos-routes.js` | sim | +215 −33 acumulado | Fase 0 inteira: `erroValorFrete`, `erroQuantidade`, `UNIDADES_INTEIRAS`, `unidadeDoProduto`, 410 do `registrar-pagamento`, guarda no `recalcularTotal` | hardening de 26/08 (preço/vendedor/CFOP/depósito), condições de pagamento, motor de tipo de operação | **SIM** (17:10) | **médio** |
| `pedido-politicas.js` | sim (untracked) | arquivo novo de 26/08 | regra de 10/09: vendedor restrito não define preço, item avulso 422, resolver indisponível 422 | o corpo de 26/08 já estava em produção | **SIM** (14:16) | **médio** |
| `contas-receber-routes.js` | sim | +40 −10 na função | `sincronizarPagamentoPedido` pelos dois vínculos | resto do arquivo é anterior e **já está em produção** | **SIM** (16:20) | **baixo** |
| `produtos-routes.js` | sim | — | `POST /api/produtos/disponibilidade` (26/08) | outras | **não** — mtime anterior ao start | **baixo** (já em vigor) |
| `reservas-routes.js` | sim | — | `disponibilidadeDeItens` exportada (26/08) | outras | **não** | **baixo** (já em vigor) |
| `auth.js` | sim | — | `ehVendedor` no `req.user` (26/08) | outras | **não** | **baixo** (já em vigor) |
| `auth-routes.js` | sim | — | `_loginClientIp` por `req.ip` (26/08) | `menuModo` e outras | **não** | **baixo** (já em vigor) |
| **`pcp-proposta.js`** | sim | **+35** | **nada** | download registrado do edital antes da proposta; `registrarDownloadEdital`; erro `PCP_EDITAL_NAO_BAIXADO` | **SIM** (09/09 16:06) | **médio** |
| **`pcp-routes.js`** | sim | **+81 −3** | **nada** | itens de edital por lote (`itensDaPaginaApi`); rotas novas `/api/pcp/pregoes` e silenciar Telegram | **SIM** (09/09 16:06) | **médio** |

### 3.1 Dependências novas — o teste que mais importava

`pcp-proposta.js` passou a fazer `require('./pcp-edital-download')` **no topo**.
Um require de arquivo inexistente derruba o boot inteiro, então varri **todo o
fecho de 319 arquivos** procurando require relativo sem alvo em disco:

```
arquivos no fecho: 319
NENHUM require relativo quebrado.
```

`pcp-edital-download.js` existe (7.265 bytes, 09/09 10:02 — anterior ao start).

E carreguei os cinco módulos que entram, em processo isolado, sem executar o app:

```
OK   ./pcp-routes        OK   ./pedidos-routes
OK   ./pcp-proposta      OK   ./pedido-politicas
OK   ./pcp-edital-download   OK   ./contas-receber-routes
```

Nenhum efeito colateral no topo desses módulos além de `require` e constantes —
conferido linha a linha.

---

## 4. As demais alterações do working tree

### 4.1 Backend já em vigor (43 arquivos) — **o restart não muda nada neles**

`analise-ia-routes.js`, `analise-ia.js`, `auth-bootstrap.js`, `auth-routes.js`,
`auth.js`, `boleto-orchestrator.js`, `boleto-provedores-routes.js`,
`compras-routes.js`, `contabilidade-routes.js`, `contratos-routes.js`,
`control-plane-routes.js`, `db-schema.js`, `electron-routes.js`,
`estoque-routes.js`, `features-routes.js`, `fornecedor-integracoes.js`,
`grupos-palavras-routes.js`, `habilitacao-provedores/cndfed.js`,
`habilitacao-routes.js`, `module-gate.js`, `nfce-routes.js`,
`nfe-entrada-routes.js`, `nfse-routes.js`, `nfse-xml.js`, `nicsrs-client.js`,
`os-routes.js`, `pcp-client.js`, `pcp-monitor.js`, `pcp-schema.js`,
`perfis-api-map.js`, `plan-modules.js`, `politicas-prazo-routes.js`,
`pre-auth-routes.js`, `produtos-routes.js`, `reservas-routes.js`,
`route-registry.js`, `ssl-certificados-routes.js`, `tesouraria-routes.js`, mais
os untracked `certidao-ponte.js`, `licitanet-estado.js`,
`marca-comprasnet-ponte.js`, `nicsrs-console-client.js`, `pcp-edital-download.js`.

**Todos com mtime anterior a 09/09 15:43:57.** Estão rodando há mais de 26 horas,
com zero erros no journal. Este é o argumento central a favor do GO: o restart
não é um salto para o desconhecido — é recarregar o que já roda, mais 5 arquivos.

### 4.2 `.js` fora do fecho do `server.js` (6)

`cndfed-emitir.js`, `habilitacao-renovar.js`, `mrb-emitir.js`,
`ssl-certificados-scheduler.js`, `scheduler.js` — pertencem ao **scheduler**
(`liciteagora.service`), não ao web. `licitanet-collector-server.js` tem serviço
próprio, **já reiniciado hoje às 16:29** (portanto já com a versão nova).

### 4.3 `public/` (69 entradas)

Estático servido por `express.static`. **Já está no ar desde que cada arquivo foi
salvo** — o restart não muda nada aqui. Inclui `public/portais/pcp-proposta.html`
(09/09 16:05), a tela que acompanha a mudança do PCP: hoje a tela nova conversa
com o backend antigo.

### 4.4 Diretórios untracked de módulo (6)

`restaurante/`, `farmacia/`, `locacao/`, `posto/`, `cndfed-perfil/`,
`cndfed-perfil-socks/`. O `git status` lista o diretório, não os arquivos.
Verifiquei com `find`: **nenhum `.js` dentro deles foi modificado após o start** —
todos já estão carregados.

---

## 5. Memória × disco

Classificação, com a evidência de cada uma:

| Classificação | Arquivos | Evidência |
|---|---|---|
| **Certamente NÃO carregado** | `pedidos-routes.js`, `contas-receber-routes.js`, `pedido-politicas.js`, `pcp-routes.js`, `pcp-proposta.js` | mtime **posterior** ao `ActiveEnterTimestamp`; `NRestarts=0`; sem hot-reload |
| **Certamente já carregado** | os outros 43 backends do grupo 1, e os módulos em subdiretório | mtime **anterior** ao start; `require` no fecho do boot; `NRestarts=0` |
| **Não se aplica** | `public/` (69) | estático, relido a cada requisição |
| **Certamente já carregado, em OUTRO processo** | `scheduler.js` e os 4 do §4.2 | `liciteagora.service` no ar desde 02/09; para eles a fronteira é **02/09 09:40**, não 09/09 |
| Indeterminado | — | nenhum caso ficou indeterminado |

**Por que a inferência é segura**: Node lê cada módulo uma vez, no `require`, e
guarda no cache do processo. Não há `nodemon`, `--watch` nem `chokidar`
(conferido em `package.json` e na linha de comando do PID 263220). O serviço não
reiniciou (`NRestarts=0`) desde 09/09 15:43:57. Logo, arquivo com mtime posterior
não pode ter sido lido.

**Uma ressalva honesta sobre `require` lazy**: `pedidos-routes.js`,
`contas-receber-routes.js`, `produtos-routes.js` e `reservas-routes.js` contêm
`require` dentro de funções. Isso **não** muda a conclusão — o cache do Node é
por caminho resolvido, e todos esses módulos já foram carregados no boot, então
um `require` em runtime devolve a cópia antiga em memória, não relê o disco.

### 5.1 Fronteira diferente para o scheduler

Estes já estão desatualizados **também no scheduler**, cuja fronteira é 02/09 09:40:

```
02/09 10:18  mrb-emitir.js          09/08 22:23  electron-routes.js
02/09 10:36  db-schema.js           09/09 10:02  pcp-edital-download.js
02/09 10:36  habilitacao-renovar.js 09/09 10:03  pcp-client.js
02/09 10:37  habilitacao-routes.js  09/09 16:06  pcp-proposta.js / pcp-routes.js
03/09 15:08  cndfed-emitir.js       10/09 14:16  pedido-politicas.js
03/09 17:31  certidao-ponte.js      10/09 16:20  contas-receber-routes.js
08/09 20:17  grupos-palavras-routes.js  10/09 17:10  pedidos-routes.js
08/09 22:06  marca-comprasnet-ponte.js
08/09 22:19  licitanet-estado.js
```

**Isso não é problema do restart do web** — mas é o assunto do §8.2.

---

## 6. Testes da versão em disco

Cronologia, que dispensa repetir a bateria inteira:

| Arquivo | Última modificação |
|---|---|
| `pedidos-routes.js` | 10/09 **17:10** |
| `scripts/test-app-backend.js` | 10/09 17:13 |
| `contas-receber-routes.js` | 10/09 16:20 |
| `pedido-politicas.js` | 10/09 14:16 |

Nenhum arquivo de aplicação foi tocado depois das 17:10. Ainda assim, reexecutei
agora (17:52) — é barato e somente leitura:

| Verificação | Resultado |
|---|---|
| `npm run verify` | **OK: sintaxe válida** |
| `scripts/test-app-backend.js` | **79 ok, 0 falhas** |
| `scripts/test-fase0-pagamento-pedido.js` | **15 ok, 0 falhas** |

As regressões de pedido/reserva/estoque/devolução foram executadas na etapa
anterior, depois da última alteração dos arquivos envolvidos, e nada mudou desde
então: `test-reservas-pedido` 11, `test-venda-perdida-pedido` 16,
`test-metas-bi` 21, `test-deposito-movimentacao` 14,
`test-devolucao-venda-espelho` 17, `test-devolucoes-credito-metas-comissao` 22,
`test-devolucoes-custo-saldo-estorno` 22 — todas 0 falhas.

**Falhas pré-existentes, não corrigidas** (quebram no seed, sem relação):
`test-comissoes`, `test-boletos-pagar`, `test-cartao-recebiveis` (1 de 13) por
`no such table: fornecedores`; `test-pedido-compra` por dump ausente em `/tmp`.

**O que os testes NÃO cobrem, e é honesto dizer**: as mudanças do PCP
(`pcp-proposta.js`, `pcp-routes.js`) **não têm teste automatizado**. Elas
dependem do portal externo — só se validam em uso real.

---

## 7. Plano de rollback — proposta, nada executado

**`git reset`/`checkout` está fora de questão**: as 163 entradas incluem
produção não commitada de 14 frentes. Descartar seria perder trabalho.

O rollback correto é por **cópia de arquivo**, e ele é pequeno: só 5 arquivos
mudam de versão.

### 7.1 Antes do restart — snapshot mínimo (recomendado)

Copiar para fora da árvore os 5 arquivos que entram em vigor, mais os críticos
da Fase 0, num diretório carimbado com a data. **~200 KB.**

```
/home/carlosfinezi/backups/pre-restart-2026-09-10/
  pedidos-routes.js  contas-receber-routes.js  pedido-politicas.js
  pcp-routes.js      pcp-proposta.js           pcp-edital-download.js
```

Não usar `rm`: copiar preserva o original. Como o rollback é "voltar o arquivo",
o snapshot **do estado atual** é o que permite refazer o caminho de volta caso
alguém edite algo depois.

### 7.2 Snapshot amplo (opcional, mais conservador)

Todo o código, sem `node_modules`, `data/`, `public/uploads` e `.git`:
**~7,6 MB** (6,4 MB de `.js` na raiz + 1,2 MB dos módulos em subdiretório).
Disco livre: **106 GB**. Custo desprezível, cobertura total.

### 7.3 Se o restart der problema

Diagnóstico primeiro, na ordem:

1. `systemctl status consulta-licitacoes.service` — subiu?
2. `journalctl -u consulta-licitacoes.service -n 80 --no-pager` — stack de boot?
3. `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health` — **302
   é sucesso**; `000`/timeout, não.

Se não subir, o erro de boot aponta o arquivo. Duas saídas:

- **Cirúrgica** (preferida): restaurar do snapshot **só o arquivo culpado** e
  reiniciar. Se for `pcp-proposta.js` ou `pcp-routes.js` — que não são da nossa
  frente e não têm teste —, voltar os dois desfaz a frente do PCP sem tocar na
  Fase 0.
- **Ampla**: restaurar os 5 do snapshot e reiniciar. Volta ao comportamento
  exato de agora.

Em qualquer caso, **o banco não precisa de rollback**: nada desta fase escreve
schema ou dado. E `NRestarts=0` mostra que o serviço não está em laço de
reinício — se cair, cai limpo.

### 7.4 O que não serve de rollback

- **`git stash`/`reset`/`clean`** — descartaria as 14 frentes não commitadas.
- **Matar o PID 263220 e "voltar o processo anterior"** — não existe processo
  anterior a recuperar; o systemd sobe um novo do disco. O estado antigo só
  sobrevive no snapshot de arquivos.

---

## 8. Decisão

# ✅ GO PARA RESTART — do `consulta-licitacoes.service`

### 8.1 Por quê

1. **O restart é muito menor do que parecia.** Dos 48 backends modificados, 43
   já estão em produção há 26 horas com **zero erros**. Só 5 arquivos trocam de
   versão.
2. **Boot verificado**: nenhum require quebrado nos 319 arquivos do fecho, e os
   5 módulos carregam limpo em processo isolado. `npm run verify` verde.
3. **A Fase 0 está coberta**: 79 + 15 testes, 0 falhas, executados sobre
   exatamente os arquivos em disco.
4. **Nada de banco**: nenhuma migration, nenhuma coluna, nenhum dado.
5. **Rollback barato e conhecido**: 5 arquivos, ~200 KB de snapshot.
6. **`NRestarts=0`** — o serviço não está instável.

### O que entra em vigor

**Da nossa frente:**

- vendedor restrito **não define preço** (corpo ignorado, item avulso 422,
  resolver indisponível 422) — e a auditoria `preco-manual-ignorado`;
- `valorFrete` negativo → **422**, e guarda no `recalcularTotal`;
- quantidade: `> 0`, finita, **≤ 1e9**, até **4 casas**, inteira em unidade não
  fracionável → 422 (ou aviso, na criação com `itens[]`);
- `sincronizarPagamentoPedido` passa a enxergar a CR ligada por `pedidoId` —
  loja virtual **e faturamento de OS**;
- `POST /api/pedidos/:id/registrar-pagamento` → **410 Gone**.

**De outra frente (não é nossa, e vai junto):**

- PCP: download registrado do edital antes da proposta, com erro explicativo
  (`PCP_EDITAL_NAO_BAIXADO`) no lugar de "declarações não liberaram os itens";
- PCP: itens de edital **por lote**; rotas novas `/api/pcp/pregoes` e silenciar
  pregão no Telegram.

### Riscos residuais

| Risco | Gravidade | Observação |
|---|---|---|
| **PCP sem teste automatizado** | **médio** | é a única mudança que entra sem cobertura; depende do portal externo. A tela (`public/portais/pcp-proposta.html`) já está no ar desde 09/09 esperando esse backend |
| Vendedor restrito perde o item avulso na tela | baixo | decisão sua, de 10/09; a tela mostra a mensagem |
| `1,5` em produto `UN` passa a dar 422 | baixo | era venda que não deveria existir |
| Rotas novas do PCP sem entrada em `perfis-api-map.js` | baixo–médio | prefixo `/api/pcp` **já existe** no mapa; as rotas novas são sub-caminhos dele |
| Primeiro `/health` pode demorar alguns segundos | baixo | boot abre 13 bancos SQLite |

### 8.2 ⚠️ Ressalva importante: um restart só do web **não** completa a Fase 0

`contas-receber-routes.js` é carregado **também pelo `scheduler.js`**
(`liciteagora.service`, no ar desde 02/09). E a divisão é esta:

- o **webhook** HTTP de boleto/Pix entra pelo **worker** (o serviço web);
- o **polling** de boletos — inclusive o do Asaas — roda no **master**
  (`scheduler.js:195-196`), que é o `liciteagora.service`.

Isso importa porque **o webhook do Asaas está sendo rejeitado**. No journal de
hoje, às 17:33:

```
[Asaas webhook] token inválido — ignorando | recebido: 49 chars, whs…mGs
                                           | esperado: 31 chars, whs…N9m
```

Ou seja: para as cobranças Asaas, **quem baixa de fato é o polling do
scheduler**. Reiniciando só o web, a correção de `sincronizarPagamentoPedido`
vale para baixa manual, estorno, cancelamento e webhooks que passam — mas **não**
para o caminho que hoje efetivamente baixa as cobranças Asaas.

**Não recomendo reiniciar o `liciteagora.service` junto, sem decisão sua.** O
`CLAUDE.md` avisa que o primeiro restart dele liga o `cicloAvisoAlcadas` (varre
todos os tenants de 6 em 6 horas e dispara aviso de aprovação a vencer) e o
watchdog do catálogo — com um destino **externo**: o e-mail do cliente do tenant
`reimac`. O amortecedor medido em 11/08 era fila de aprovações vazia, mas isso é
estado de dado, não garantia.

**Sugestão**: reiniciar **agora só o web** e tratar o scheduler como decisão
separada, junto da correção do token do webhook Asaas — que é um bug próprio,
anterior a esta frente.

### 8.3 Depois do restart, conferir

```
systemctl status consulta-licitacoes.service          # active (running)
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health   # 302
journalctl -u consulta-licitacoes.service -n 60 --no-pager            # sem stack de boot
```

E um teste funcional de leitura, sem criar nada: abrir um pedido existente na
tela e conferir que carrega.

---

## 9. Confirmação

- **Serviço NÃO reiniciado** — nenhum `systemctl restart/stop/start` executado.
  As únicas chamadas a `systemctl` foram `status` e `show`, ambas leitura.
- **Banco NÃO alterado** — nenhuma consulta a `data/` nesta auditoria além de
  leitura; nenhum `UPDATE`, nenhuma migration.
- **Nenhum commit** — HEAD segue em `5ec3474`.
- **Nenhum `reset`, `stash` ou `clean`** — nada descartado.
- **Nenhum arquivo de aplicação alterado** — os scripts auxiliares desta
  auditoria foram criados em `/tmp` (`fecho-requires.js`,
  `requires-quebrados.js`, `fecho-sched.js`), fora da árvore. O único arquivo
  novo no repositório é **este relatório**.
