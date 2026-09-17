# 20 — Governança percentual: revisão da interface antes de ativar a Fase 1

**Data:** 2026-09-11
**Referência:** [19 — Fase 1 funcional](19-fase1-funcional-desconto-atendimento.md)

**Resultado:** a interface **não estava correta** — e o problema era maior do que
formatação. Corrigido e testado. Nenhum serviço reiniciado, nenhuma faixa criada
em tenant de cliente.

**Não feito, por instrução:** restart · faixas reais · commit · frontend do PDV ·
backfill · Asaas · alteração de dado comercial de cliente.

---

## 1. Tela encontrada

| Peça | Arquivo |
|---|---|
| Tela de cadastro/listagem/edição | `public/configuracoes/alcadas.html` (304 linhas) |
| JS | inline, no próprio HTML (não há `.js` separado) |
| API — listar | `GET /api/alcadas/regras` |
| API — criar | `POST /api/alcadas/regras` |
| API — editar / ativar / desativar | `PUT /api/alcadas/regras/:id` |
| API — simulador | `GET /api/alcadas/simular` |
| API — diagnóstico | `GET /api/alcadas/diagnostico` |
| Validação de servidor | `governanca-alcadas.validarRegra` |
| Fila de decisão (outra tela) | `public/aprovacoes/aprovacoes.html` |
| Mensagens de aviso | `governanca-avisos.js` (**inerte** desde 2026-08-21) |

**Não existe exclusão de regra** — só desativar/reativar, por desenho: as
aprovações já emitidas guardam `regraId`/`papelExigido`, e apagar a regra
romperia o histórico.

## 2. Comportamento anterior

A tela era **monetária por construção**, com "R$" escrito à mão em sete pontos:

| Ponto | Conteúdo |
|---|---|
| `<select id="simTipo">` | dois `<option>` fixos, **sem `desconto_venda`** |
| `<select id="rTipo">` | dois `<option>` fixos, **sem `desconto_venda`** |
| `<select id="rPapel">` e `#ePapel` | cinco papéis fixos, **sem `gerente-comercial`** |
| input de limite | `placeholder="Limite (R$)"` |
| cabeçalho da tabela | `<th>Acima de (R$)</th>` |
| modal de edição | `<label>Acima de (R$)</label>` |
| listagem | `R$ ${fmt(x.limiteValor)}` — moeda fixa |
| campo ao editar | `Number(x.limiteValor).toFixed(2)` → `5` virava `5.00` |
| simulador e painel de faixas | `fmtG()` — `style:'currency', currency:'BRL'` |
| `EVENTO_TXT` | mapa fixo com dois eventos |

## 3. Problemas encontrados

Não era só rotulagem. Em ordem de gravidade:

### 3.1 A faixa de desconto não podia ser cadastrada por ninguém

`desconto_venda` entrou no backend em 2026-09-11, mas os dois `<select>` da tela
têm a lista de eventos **escrita à mão**. A tela não o oferecia, e não havia
caminho pela interface para criar a faixa que a Fase 1 inteira depende.

### 3.2 Nenhum perfil customizado podia ser aprovador — nem pela API

Mais grave, porque não se resolvia mexendo só no HTML.
`governanca-routes` chamava `validarRegra(..., { roles: ROLES })`, e
`ROLES = ['admin','financeiro','comercial','operacional','licitacoes']` são só os
**nativos**. Perfis cadastrados em `perfis_acesso` — os customizados — eram
recusados com *"Papel ... não existe"*.

`gerente-comercial` é exatamente um perfil customizado. **É por isso que as faixas
do sandbox tiveram de ser inseridas direto no banco no relatório 14**: a API as
recusava. O item 7 do pedido ("Acima de 5%: gerente comercial") era impossível
pela tela.

Não é limitação nova nem exclusiva do desconto — atingia `pagamento_cp` e
`pedido_compra` do mesmo jeito. Era uma **segunda noção de "papel que existe"**,
mais pobre que a do cadastro de usuários, que já usa `perfisDisponiveis(db)`.

### 3.3 `limiteValor` ausente virava faixa de 0

`Number(null)` é `0`, e `0 >= 0` passava na validação. Um campo vazio criava a
faixa **"acima de 0"** — que exige aprovação para **tudo**, inclusive para o que
ninguém quis restringir.

**Isso não é hipótese: aconteceu.** No tenant `1bit` existe a regra

```
id=2  pagamento_cp  limiteValor=0.0  admin  ativo=0  criada em 2026-08-21
```

uma faixa de zero criada e depois desativada. Enquanto esteve ativa, todo
pagamento do tenant exigia aprovação e ninguém saberia por quê — é o sintoma
clássico que o próprio `diagnostico` foi escrito para caçar.

### 3.4 Formatação (o problema originalmente relatado)

Limite percentual exibido e reeditado como dinheiro: `5` → `"R$ 5,00"` na
listagem e `"5.00"` no campo de edição.

## 4. Alterações realizadas

**A causa raiz era a duplicação**: a tela mantinha cópias próprias da lista de
eventos, dos rótulos e dos papéis. Qualquer coisa nova no backend nascia invisível
para ela. A correção foi **eliminar as cópias**, não acrescentar mais uma.

| Arquivo | Mudança |
|---|---|
| `governanca-alcadas.js` | `EVENTOS` (rótulo + unidade por evento), `unidadeDoEvento()`, `catalogoEventos()`, `LIMITE_PERCENTUAL_MAXIMO = 100`; validação de teto percentual; `null`/`''`/`undefined` deixam de virar 0 |
| `governanca-routes.js` | `GET /api/alcadas/regras` passa a devolver `eventos` e `papeis`; `papeisAprovadores(db)` = nativos **+** perfis do tenant, nas duas chamadas de `validarRegra` |
| `public/configuracoes/alcadas.html` | selects montados pela API; `fmtLimite()` por unidade; rótulos e `max` contextuais; edição sem `toFixed(2)` em percentual; simulador e painel de faixas na unidade certa; `fmtG()` removida |
| `governanca-avisos.js` | `rotuloEvento()` e `valorDoEvento()` a partir da mesma fonte |

### Por que `governanca-avisos.js` entrou, sendo código inerte

Ele não é chamado em produção desde 2026-08-21, mas o comentário no
`scheduler.js` diz *"Para religar: restaurar este ciclo"*. Com `moeda()` fixo, um
desconto de 6% sairia como **"R$ 6,00"** na mensagem ao aprovador. Corrigir agora
custa quatro linhas; corrigir depois de alguém religar custa uma mensagem errada
enviada a um cliente.

### O fallback da tela — e por que ele não é zelo excessivo

`public/` **fica no ar no instante em que o arquivo é salvo**, mas o processo em
memória só muda no restart. Entre uma coisa e outra, a tela nova conversaria com a
API antiga, que não devolve `eventos` nem `papeis` — e os selects ficariam vazios.
**Eu quebraria a tela de alçadas agora, sem reiniciar nada.**

Por isso a tela nasce com uma lista embutida contendo **apenas os dois eventos
monetários e os cinco papéis nativos**: o comportamento anterior, exatamente.
`desconto_venda` fica **fora** do fallback de propósito — oferecê-lo antes de o
backend o reconhecer produziria erro de validação ao salvar.

**Verificado agora, com o serviço em execução:**

```
GET /api/alcadas/regras (labfiscal)   HTTP 200
  campos devolvidos: success, regras        ← sem catálogo: processo é o ANTIGO
GET /configuracoes/alcadas.html        HTTP 200
  ocorrências de fmtLimite: 9               ← página nova JÁ está no ar
```

Exatamente o intervalo que o fallback cobre.

## 5. Comportamento de `desconto_venda`

| Aspecto | Como ficou |
|---|---|
| Rótulo do evento | "Desconto em venda" |
| Campo | `Limite (%)`, `min=0`, `max=100`, `step=0.01` |
| Máscara monetária | **nenhuma** — `type=number`, sem prefixo, sem centavos |
| Listagem | `5` → **"5%"**; `7.5` → **"7,5%"** |
| Edição | volta ao campo como `5`, **nunca** `5.00` |
| Modal | "Acima de (%)" |
| Resumo na edição | *"Acima de 5% exige aprovação de **gerente-comercial**. Até 5%, segue sem aprovação."* |
| Simulador | mostra `6%` e explica a faixa em percentual |
| Painel de faixas | `acima de 5% → gerente-comercial (7d)` |

**Precisão:** 2 casas decimais. Não é escolha de tela — é o que o backend
pratica: `pedido-desconto.r2()` arredonda o percentual em duas casas antes de
comparar com a faixa. Aceitar mais casas na tela criaria uma faixa que o motor
nunca leria por inteiro.

## 6. Comportamento dos eventos monetários

**Inalterado, e isso foi testado explicitamente:**

- `pagamento_cp` e `pedido_compra` continuam com unidade `moeda`;
- `50000` continua exibido como **"R$ 50.000,00"** (C2);
- o campo continua `Limite (R$)` com `toFixed(2)` na edição (D2);
- **não ganharam teto**: `150` em `pagamento_cp` continua válido (E3). O teto de
  100 vale só para evento percentual;
- a semântica de faixa não mudou: `1000` não cai na faixa de `50000`, `60000` cai
  (F2).

A única mudança que os alcança é a §3.3 (campo vazio deixou de virar faixa de
zero) — e ela **corrige** um defeito deles, não altera o que já funcionava.

## 7. Criação, edição e listagem

Ciclo completo exercitado no **sandbox**, pela API real:

```
criar 7,5% -> gerente-comercial            OK  gravado=7.5
editar para 12,25% e reler                 OK  gravado=12.25
editar só o papel (limite intacto?)        OK  limite=12.25
evento MONETARIO 25000 continua normal     OK  gravado=25000
```

E como a tela exibe as faixas que já existiam lá:

```
#11  desconto_venda  bruto=5   tela="5%"   -> gerente-comercial
#12  desconto_venda  bruto=15  tela="15%"  -> admin
```

O catálogo devolvido pela API ao sandbox:

```
pagamento_cp    moeda       teto=—     "Pagamento de conta a pagar"
pedido_compra   moeda       teto=—     "Envio de pedido de compra"
desconto_venda  percentual  teto=100   "Desconto em venda"
papeis: admin, financeiro, comercial, operacional, licitacoes, gerente-comercial
```

`gerente-comercial` aparece — era o que faltava.

**As duas faixas de teste criadas foram removidas**; o sandbox voltou a ter
exatamente as duas originais.

## 8. Validações

O frontend ajuda; **o backend decide**. Todas verificadas no sandbox:

| Entrada | Frontend | Backend |
|---|---|---|
| percentual negativo | bloqueia | **400** |
| percentual > 100 | bloqueia (`max`) | **400** — "o desconto máximo é 100%" |
| string inválida | `type=number` → NaN | **400** |
| `NaN` | — | **400** |
| `null` / `''` / ausente | bloqueia | **400** (era aceito como 0) |
| `"R$ 5,00"` mascarado | não produz | **400** |
| `tipoEvento` inválido | não ofertado | **400** |
| papel inexistente | não ofertado | **400** — "não existe" |
| faixa duplicada no mesmo ponto | — | **400** |

## 9. Testes no sandbox

Escrita **só** no sandbox. `scripts/test-governanca-percentual.js` (novo, banco
descartável) — **29 testes, 29 OK**, cobrindo catálogo, unidade, teto, papéis
customizados, criação, decimal, listagem, formatação, editar→reler, segurança e
preservação da semântica.

Dois deles merecem nota por terem **falhado primeiro e revelado defeitos reais**:

- **E5** (`null` recusado) — expôs a §3.3;
- **F1** (a faixa de 5% vale para 6%, não para 5%) — falhava *por consequência*
  de E5: a faixa de zero criada pelo `null` capturava qualquer valor. Corrigida a
  causa, os dois passaram.

## 10. Regressão

| Suíte | Resultado |
|---|---|
| `npm run verify` | **OK** |
| JS inline do HTML (fora do verify) | **2 blocos, sintaxe OK** |
| `test-governanca-percentual` (nova) | **29 ok, 0 falha** |
| `test-alcadas` | **41 ok, 0 falha** |
| `test-fase1-funcional` | 57 ok, 0 falha |
| `test-fase1-rollout-parcial` | 10 ok, 0 falha |
| `test-app-backend` | 79 ok, 0 falha |
| `test-fase1-desconto-origem` | 57 ok, 0 falha |
| `test-fase0-pagamento-pedido` | 15 ok, 0 falha |
| `test-rollout-fase1` | 17 ok, 0 falha |
| `test-documento-fiscal` | 16 ok, 0 falha |
| `test-reservas-pedido` | 11 ok, 0 falha |
| `test-metas-bi` | 21 ok, 0 falha |
| `test-devolucoes-custo-saldo-estorno` | 22 ok, 0 falha |
| `test-aprovacoes-fluxo` | 15 passaram, **4 falharam — pré-existentes** |

As 4 falhas de `test-aprovacoes-fluxo` são **as mesmas quatro** do relatório 19
§16, com textos idênticos (montagem de mensagem com fornecedor e contador de
menu). Confirmei depois de mexer em `governanca-avisos.js`, que é justamente o
módulo que esse teste exercita: nenhum nome, nenhum texto e nenhum total mudou.

**Zero regressões novas.**

> `verify` roda `node --check` só em `.js` de raiz e `scripts/` — **não cobre JS
> inline de HTML**, e toda a tela de alçadas é inline. Por isso o bloco foi
> extraído e validado à parte. Sem esse passo, um erro de sintaxe ali passaria
> verde e derrubaria a tela.

## 11. Arquivos que precisam entrar em vigor

| Arquivo | Estado |
|---|---|
| `pedidos-routes.js` | M |
| `pedido-desconto.js` | novo |
| `pedido-atendimento.js` | novo |
| `pedido-politicas.js` | novo (não commitado) |
| `faturas-routes.js` | M |
| `db-schema.js` | M |
| `governanca-alcadas.js` | M |
| `governanca-routes.js` | M |
| `governanca-avisos.js` | M (inerte) |
| `public/configuracoes/alcadas.html` | M — **já em vigor** (estático) |

## 12. Processo responsável por cada arquivo

Traçado pelo **fecho de `require` dos entrypoints reais**, não por suposição.
Units instaladas, conferidas com `systemctl show`:

```
consulta-licitacoes.service → /usr/bin/node --max-old-space-size=4096 server.js
                              ROLE=worker  MULTI_TENANT=true  PORT=3000
liciteagora.service        → /usr/bin/node scheduler.js   ROLE=master
```

`server.js` carrega **317** módulos; `scheduler.js`, **125**.

| Arquivo | worker (`server.js`) | master (`scheduler.js`) |
|---|---|---|
| `pedidos-routes.js` | **SIM** | não |
| `pedido-desconto.js` | **SIM** | não |
| `pedido-atendimento.js` | **SIM** | não |
| `pedido-politicas.js` | **SIM** | não |
| `faturas-routes.js` | **SIM** | não |
| `governanca-alcadas.js` | **SIM** | **SIM** |
| `governanca-routes.js` | **SIM** | **SIM** |
| `governanca-avisos.js` | **SIM** | **SIM** |
| `db-schema.js` | **SIM** | **SIM** |
| `alcadas.html` | estático — já no ar | — |

Por onde o master os alcança:

- `db-schema.js` ← `scheduler.js` direto (`initSchema` → `createTenantManager`);
- `governanca-routes.js` ← `contas-pagar-routes.js` e `tesouraria-routes.js`;
- `governanca-alcadas.js` ← `governanca-routes.js`.

**O master apenas os carrega.** `scheduler.js` não cria pedido, não aplica
desconto e não chama `verificarAlcada` — verificado por busca direta.

## 13. Efeito de reiniciar apenas `consulta-licitacoes.service`

**É suficiente para ativar a Fase 1 inteira.** Todo caminho que exercita as
regras novas é HTTP, e todo HTTP é do worker:

| Capacidade | Ativa? | Por quê |
|---|---|---|
| desconto no pedido | **sim** | `pedidos-routes` + `pedido-desconto`, só no worker |
| alçada de desconto | **sim** | `governanca-alcadas` recarregado no worker |
| aprovação / bloqueio da confirmação | **sim** | `pedidos-routes`, só no worker |
| `tipoAtendimento` e validações | **sim** | `pedidos-routes` + `pedido-atendimento` |
| herança do desconto na fatura | **sim** | `faturas-routes`, só no worker |
| APIs de governança (`/api/alcadas/*`) | **sim** | `governanca-routes`, registrado pelo worker |
| tela de alçadas com `%` | **sim** | estático + catálogo da API do worker |
| schema de tenant novo | **sim** | provisionamento é do worker (control-plane) |

## 14. Efeito de NÃO reiniciar `liciteagora.service`

O master continua com a versão anterior de três módulos. Consequência real, item
a item:

| Módulo | O que o master faz com ele | Impacto de ficar velho |
|---|---|---|
| `db-schema.js` | `initSchema` ao abrir banco de tenant | **Nenhum.** Os 19 tenants já têm as 6 colunas (relatório 18) e `initSchema` é aditivo — a versão velha não remove nada, apenas não acrescenta. Tenant novo é provisionado pelo worker. |
| `governanca-alcadas.js` | só carregado, via `contas-pagar-routes` | **Nenhum.** Nenhum job chama `verificarAlcada` nem `validarRegra`; regras só se cadastram pela API do worker. |
| `governanca-routes.js` | idem | **Nenhum.** Registra rotas HTTP, e o master não serve HTTP. |
| `governanca-avisos.js` | inerte desde 2026-08-21 | **Nenhum.** Nada o chama. |

**Nada fica desatualizado de forma observável.** Não há bloqueador técnico para
manter o master como está.

### Correção de uma pendência desatualizada do CLAUDE.md

O `CLAUDE.md` ainda registra que *"`cicloAvisoAlcadas` passa a mandar mensagem no
próximo restart do `liciteagora.service`"*, com risco de e-mail para
`werick@reimac.com.br`. **Isso não vale mais.** O `scheduler.js` da árvore traz,
nas linhas 462-473, o bloco "ALÇADAS: AVISOS REMOVIDOS": o ciclo e o
`avisarCriacao` foram retirados em **2026-08-21**. Reiniciar o master hoje **não**
dispararia aviso de alçada nenhum.

O que **continua** valendo dessa pendência é o `ligarWatchdogCatalogo()`
(`scheduler.js:1182`), que passa a rodar no próximo restart do master. Segue
sendo motivo para não reiniciá-lo de carona nesta janela.

> Nota lateral: o `sandbox` tem 12 aprovações pendentes com `expiraEm` — massa da
> matriz do relatório 19. Inofensivo: o tenant está `SUSPENDED`, e `listActive()`
> só enxerga `ACTIVE`/`TRIAL`, então nenhum job o alcança.

## 15. Recomendação: **GO**

Ativar reiniciando **somente `consulta-licitacoes.service`**.

O que sustenta:

1. o worker é suficiente — verificado pelo fecho de `require` dos entrypoints
   reais, não presumido (§12, §13);
2. não reiniciar o master não deixa nada desatualizado de forma observável (§14);
3. a migration está nos 19 tenants e é aditiva; o schema base passou a criar as
   colunas para tenants novos;
4. **nenhum tenant de cliente tem faixa de desconto** — conferido: as únicas duas
   regras em cliente são `pagamento_cp` do `1bit`, de agosto. Sem faixa, o
   desconto permitido é 0% e o ERP vende como hoje;
5. regressão limpa, com as 4 falhas pré-existentes identificadas e provadas como
   tais.

**Condições que acompanham o GO:**

- reiniciar **só o worker**; o master fica como está (§14);
- depois do restart, conferir que `GET /api/alcadas/regras` passou a devolver
  `eventos` e `papeis` — é o sinal de que o fallback da tela saiu de cena;
- abrir a tela de alçadas e confirmar que `desconto_venda` aparece no select e
  que as faixas do sandbox leem "5%" e "15%";
- **só então** cadastrar faixas reais, tenant a tenant, com os percentuais que
  cada proprietária definir.

**Riscos que permanecem abertos:**

- **fail-open de perfil sem cadastro** (relatório 19 §4): `role` sem registro em
  `perfis_acesso` passa como privilegiado. Não endurecido por decisão; fixado
  pelo teste E5 daquela suíte;
- **`loja-routes.js` não aplica desconto** — o catálogo grava pedido por INSERT
  próprio; quando o Catálogo Online for feito, a alçada precisa entrar ali, e não
  num segundo caminho;
- **faixa de zero em `pagamento_cp` no `1bit`** (id=2, inativa): resíduo do
  defeito §3.3. Está desativada e **não foi tocada** — mexer em dado de cliente
  está fora desta janela. Vale apagá-la um dia, com autorização;
- NFC-e/NFS-e lendo documento do corpo (relatório 15); webhook Asaas do
  `josecarloscostafilho` (11); 4 pedidos de R$ 10.036,00 aguardando decisão (07);
  `[DIGEST] no such table: licitacoes` (18 §16).

## Serviços — estado no fim desta etapa

| Unidade | Estado |
|---|---|
| `consulta-licitacoes.service` | active, PID **3310892**, desde 08:21:57 — **inalterado** |
| `liciteagora.service` | active, PID **3085849**, desde 06:18:49 — **inalterado** |

Nada foi reiniciado.
