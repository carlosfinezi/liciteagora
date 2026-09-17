# 21 — Ativação da Fase 1 funcional em produção

**Data:** 2026-09-11, 11:15–11:30 BRT
**Referências:** [19 — Fase 1 funcional](19-fase1-funcional-desconto-atendimento.md) ·
[20 — governança percentual](20-governanca-percentual-pre-ativacao.md)

**Resultado:** **ATIVADO.** `consulta-licitacoes.service` reiniciado, subiu limpo,
Fase 1 em vigor. `liciteagora.service` intocado. Nenhum dado de cliente alterado.

**Não feito, por instrução:** faixas em cliente · restart do master · commit ·
frontend do PDV · backfill · Asaas.

---

## 1. Pré-check

| Unidade | Status | PID | NRestarts | Start |
|---|---|---|--:|---|
| `consulta-licitacoes.service` | active/running | 3310892 | **0** | 2026-09-11 08:21:57 |
| `liciteagora.service` | active/running | 3085849 | **0** | 2026-09-11 06:18:49 |

Idênticos aos registrados no relatório 20, com `NRestarts = 0` em ambos:
**nenhum restart externo ocorreu** entre os dois relatórios (o Hestia não tocou
em nada).

## 2. Testes antes do restart

| Suíte | Resultado |
|---|---|
| `npm run verify` | **OK** |
| `test-fase1-funcional` | 57 ok, 0 falha |
| `test-governanca-percentual` | 29 ok, 0 falha |
| `test-alcadas` | 41 ok, 0 falha |
| `test-fase1-rollout-parcial` | 10 ok, 0 falha |
| `test-app-backend` | 79 ok, 0 falha |
| `test-aprovacoes-fluxo` | 15 passaram, **4 falharam — pré-existentes** |

> O pedido citava `test-governanca-alcadas`; não existe suíte com esse nome — a
> do motor é `test-alcadas`, usada acima.

As 4 falhas de `test-aprovacoes-fluxo` foram conferidas linha a linha e são
**exatamente as mesmas** dos relatórios 19 §16 e 20 §10, com textos idênticos
(montagem de mensagem com fornecedor e contador de menu). **Nenhuma falha nova** —
o restart foi autorizado a prosseguir.

## 3. Backup

```
/home/carlosfinezi/backups/fase1-ativacao-20260911-111732/
```

20 arquivos · 604 KB · **0 arquivos `.db`** — nenhum banco de cliente copiado.

Além dos dez pedidos, levei `loja-routes.js`, `contas-receber-routes.js`,
`perfis-acesso.js` (tocados nas fases anteriores e lidos por este código) e os
scripts de teste/migração da Fase 1.

Todos conferidos **byte a byte** contra a árvore depois de copiados.

## 4. Restart controlado

```
systemctl restart consulta-licitacoes.service     11:17:35
```

Só essa unidade. `liciteagora.service`, nginx, postgres e os session-services não
foram tocados.

O boot registrou as rotas dos módulos, abriu os bancos e anunciou
`[worker] Servidor rodando em http://localhost:3000` às **11:17:41** — seis
segundos. As primeiras tentativas de `curl` deram `000` porque foram disparadas
durante esses seis segundos, não por falha.

**Nenhum stack trace, nenhum `Cannot find module`, nenhum crash-loop.**

## 5. PID antes/depois

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID **3310892**, 08:21:57, NRestarts 0 | PID **3637675**, **11:17:35**, NRestarts 0, active/running |
| `liciteagora.service` | PID **3085849**, 06:18:49, NRestarts 0 | PID **3085849**, 06:18:49, NRestarts 0 — **inalterado** |

`/health` → **HTTP 302** (o esperado; qualquer 2xx/3xx prova que subiu).

## 6. Journal

Desde o novo start (11:17:35):

| Padrão | Ocorrências |
|---|--:|
| `no such column` | **0** |
| `SQLITE_ERROR` | **0** |
| `TypeError` | **0** |
| `ReferenceError` | **0** |
| `Cannot find module` | **0** |
| `desconto_venda` | **0** |
| `tipoAtendimento` | **0** |
| `governanca` | **0** |

Ruído pré-existente, separado: `AutoLance` 44, `BNC-Chat` 3 (sessão BNC expirada),
`[DIGEST]` 0 nesta janela (roda às 08:00). Todos documentados nos relatórios 18 e
19, sem relação com esta ativação.

**Uma anomalia encontrada — e ela não é desta ativação.** Ver §17.

## 7. Smoke test

Tenant `labfiscal` (interno, do próprio dono do sistema), **somente leitura**:

| Rota | HTTP |
|---|---|
| `/health` (sem Host de tenant) | **302** |
| chave de API inválida | **401** |
| `GET /api/pedidos` | 200 |
| `GET /api/pedidos/resumo` | 200 |
| `GET /api/produtos?limit=3` | 200 |
| `POST /api/produtos/disponibilidade` | 200 |
| `GET /api/pessoas` | 200 |
| `GET /api/faturas` | 200 |
| `GET /api/contas-a-receber` | 200 |
| `GET /api/alcadas/regras` | 200 |
| `GET /api/alcadas/diagnostico` | 200 |
| `GET /configuracoes/alcadas.html` | 200 |

`/health` com o Host do tenant devolve 404 — é roteamento por subdomínio, não
falha: sem o Host ele responde 302, como a documentação prevê.

### A prova de que o código novo está em vigor

Feita sem escrever nada, aproveitando que a validação de atendimento acontece
**antes** do INSERT:

```
POST /api/pedidos {"origem":"pdv","tipoAtendimento":"teleporte"}
→ 422 {"error":"tipoAtendimento deve ser no_local, retirada, entrega"}

pedidos em labfiscal antes: 0    depois: 0    (nada criado)
```

Essa mensagem só existe em `pedido-atendimento.js`, arquivo que **não existia**
no processo anterior. O 422 vindo dela é a prova direta de que o worker está
rodando a Fase 1.

## 8. API de governança

`GET /api/alcadas/regras` no processo ativo devolve agora
`success, regras, eventos, papeis`:

| Evento | Unidade | Teto | Rótulo |
|---|---|--:|---|
| `pagamento_cp` | moeda | — | Pagamento de conta a pagar |
| `pedido_compra` | moeda | — | Envio de pedido de compra |
| **`desconto_venda`** | **percentual** | **100** | Desconto em venda |

Papéis ofertados em `labfiscal`: `admin, financeiro, comercial, operacional,
licitacoes` — os cinco nativos, porque esse tenant não tem perfil customizado
cadastrado. Onde existe perfil customizado, ele aparece: no `sandbox` a mesma
rota lista também `gerente-comercial` (§10).

**Regras em `labfiscal`: 0 — e assim permanece.** Nenhuma faixa foi criada em
tenant real.

## 9. Tela de alçadas

Servida pelo processo novo, 19.385 bytes:

| Verificação | Resultado |
|---|---|
| usa `fmtLimite` (formata por unidade) | **SIM** |
| selects montados pela API (`montarSelects`) | **SIM** |
| `fmtG` (moeda fixa) removida | **SIM** |
| cabeçalho sem `Acima de (R$)` fixo | **SIM** |
| rótulo do modal dinâmico (`eLimiteLabel`) | **SIM** |
| `desconto_venda` no catálogo recebido | **SIM**, `percentual`, teto 100 |
| eventos monetários preservados | **SIM** — `5000` → `"R$ 5.000,00"` |

O fallback embutido (relatório 20 §4) saiu de cena: a API agora entrega o
catálogo, que é a fonte real.

**Nenhuma faixa foi salva em cliente.**

## 10. Matriz de desconto no sandbox

Pedido de 5 × R$ 100 = subtotal R$ 500, frete R$ 20. Faixas do sandbox:
`5% → gerente-comercial`, `15% → admin`.

| Ator | % | Subtotal | Desconto | Frete | Total | Alçada | Aprovação? | Status |
|---|--:|--:|--:|--:|--:|---|---|---|
| VENDEDOR | 0% | 500,00 | 0,00 | 20,00 | **520,00** | alcada_base | não | confirmado |
| VENDEDOR | 3% | 500,00 | 15,00 | 20,00 | **505,00** | alcada_base | não | confirmado |
| VENDEDOR | 5% | 500,00 | 25,00 | 20,00 | **495,00** | alcada_base | não | confirmado |
| VENDEDOR | 6% | 500,00 | 30,00 | 20,00 | 490,00 | sem autoridade | **SIM (gerente-comercial)** | **409 — rascunho** |
| GERENTE | 5% | 500,00 | 25,00 | 20,00 | **495,00** | alcada_base | não | confirmado |
| GERENTE | 15% | 500,00 | 75,00 | 20,00 | **445,00** | **propria** | **não** | confirmado |
| GERENTE | 16% | 500,00 | 80,00 | 20,00 | 440,00 | sem autoridade | **SIM (admin)** | **409 — rascunho** |
| ADMIN | 30% | 500,00 | 150,00 | 20,00 | **370,00** | propria | não | confirmado |

Os quatro comportamentos pedidos, confirmados: dentro da própria alçada aplica;
acima exige aprovação; **gerente a 15% não pede a outro gerente**; vendedor a 6%
aguarda gerente; gerente a 16% aguarda admin; admin a 30% aplica.

### Limitação declarada: por que estes testes não foram por HTTP

O `sandbox` está `SUSPENDED`, e o gate de plano devolve **402 (Pagamento
pendente)** a qualquer requisição HTTP dele. Para testar por HTTP seria preciso
mudar seu status para `ACTIVE` — o que o tornaria visível a `listActive()` e,
portanto, aos **jobs do master**, que roda código anterior e não foi reiniciado.
Não vale o risco por um detalhe de transporte.

Os testes rodaram **in-process, contra o banco real do sandbox, carregando os
mesmos arquivos do disco que o worker carregou às 11:17:41**. O que muda é o
processo, não o código — e a §7 já prova, por HTTP, que o worker está com a
Fase 1 ativa.

## 11. Aprovação

Ciclo completo no sandbox — `scripts/sandbox-fase1-aprovacao.js`, **21 testes,
21 OK**:

| Verificação | Resultado |
|---|---|
| solicitação criada com solicitante, percentual, papel, data e validade | **OK** |
| motivo obrigatório acima da alçada — e **sem ele nada é aberto** | **OK** |
| pedido **não confirma** antes da aprovação (409, segue rascunho) | **OK** |
| aprovação pode ser decidida (aprovador e `dataDecisao` gravados) | **OK** |
| depois de aprovada, o pedido confirma | **OK** |
| aprovação é **consumida** (`consumida = 1`) | **OK** |
| **não pode ser reutilizada** por outro pedido | **OK** |
| aprovação de 8% **não cobre** 20% lançado depois | **OK** |
| reprovação barra e **diz o motivo** | **OK** |

## 12. `tipoAtendimento`

| Origem | Atendimento | Endereço | Resultado |
|---|---|---|---|
| pdv | no_local | — | **OK — confirmado** |
| pdv | retirada | — | **OK — confirmado** |
| pdv | entrega | no pedido | **OK — confirmado** |
| pdv | *(nulo)* | — | **422** — "origem pdv exige tipoAtendimento" |
| pdv | entrega | nenhum | **422** — "entrega exige endereço" |
| catalogo | retirada | — | **OK — confirmado** |
| catalogo | entrega | no pedido | **OK — confirmado** |
| catalogo | *(nulo)* | — | **422** |
| catalogo | entrega | nenhum | **422** |
| manual | *(nulo)* | — | **OK — confirmado** |

Confirmado também por HTTP, em `labfiscal`: `tipoAtendimento` inválido → **422**,
sem criar pedido (§7).

## 13. Segurança

No código ativo:

| Tentativa | Resultado |
|---|---|
| vendedor restrito manda `precoUnitario: 1` (produto R$ 100) | preço **oficial** gravado |
| `vendedorId` de outro usuário | **ignorado**, fica com o próprio |
| desconto negativo | **422**, total intacto |
| desconto > 100% | **422** |
| frete negativo | **422** |
| `valorTotal` manipulado no corpo | **ignorado** e recalculado |
| `descontoAplicado` direto no corpo | **ignorado** — não está em `CAMPOS_PEDIDO` |
| `tipoAtendimento` inválido | **422** |
| origem `catalogo`/`licitacao`/`os`/`marketplace` forjada | vira `manual` |

## 14. Faturamento

| Caso | Esperado | Resultado |
|---|---|---|
| pedido com 10% (R$ 50), faturar **sem** `valorDesconto` | herda 50 | **`valorDesconto = 50`** |
| pedido com 10% (R$ 50), faturar **com** `valorDesconto: 30` | substitui | **`valorDesconto = 30`** — não 80 |
| pedido com 10%, faturar com `valorDesconto: 0` | sem desconto | **`valorDesconto = 0`** |

O total da fatura fecha em `valorBruto + valorFrete − valorDesconto` nos três
casos. **Nunca somou.**

## 15. Impacto nos tenants de clientes

Leitura pura, depois da ativação:

| Tenant | Faixas `desconto_venda` | Pedidos | Com desconto/atendimento | `semDocumento=1` | Aprovações `desconto_venda` |
|---|--:|--:|--:|--:|--:|
| `1bit` | **0** | 29 | **0** | 0 | **0** |
| `produtosbomgosto` | **0** | 21 | **0** | 0 | **0** |
| `josecarloscostafilho` | **0** | 11 | **0** | 0 | **0** |
| `raeldouglas` | **0** | 2 | **0** | 0 | **0** |
| `jaagricola` | **0** | 1 | **0** | 0 | **0** |
| `labfiscal` e demais 7 | **0** | 0 | 0 | 0 | **0** |

Totais comerciais conferidos contra o relatório 18:

```
produtosbomgosto   21 pedidos · 505 itens · R$ 46.069,50   ← idêntico ao relatório 18
1bit               29 pedidos ·  23 itens · R$ 110.397,93
```

As únicas 2 aprovações existentes em tenant de cliente são `pagamento_cp` do
`1bit`, de **21/08/2026** — anteriores a tudo isto.

- nenhum tenant recebeu faixa automaticamente;
- nenhum pedido histórico mudou;
- nenhum `tipoAtendimento` preenchido automaticamente;
- nenhum desconto histórico apareceu;
- nenhuma aprovação retroativa.

**Massa de teste:** os 20 pedidos de `sandbox-fase1-aprovacao.js` foram removidos
(incluindo faturas, contas a receber e movimentações que geraram). Ficaram no
sandbox os 18 da matriz, marcados `FASE1-MATRIZ` —
`node scripts/sandbox-fase1-matriz.js --limpar` os remove.

## 16. Serviços

| Unidade | Estado final |
|---|---|
| `consulta-licitacoes.service` | active/running, PID **3637675**, 11:17:35, NRestarts 0 |
| `liciteagora.service` | active/running, PID **3085849**, 06:18:49, NRestarts 0 — **inalterado** |

**`cicloAvisoAlcadas` não existe mais no `scheduler.js` atual** — `grep` devolve
**0 ocorrências**, e as linhas 462-473 trazem o bloco "ALÇADAS: AVISOS
REMOVIDOS", que documenta a retirada em 2026-08-21 do ciclo e do `avisarCriacao`.
A pendência do `CLAUDE.md` que previa envio de aviso no próximo restart do master
**não vale mais**; o que resta dela é o `ligarWatchdogCatalogo()`
(`scheduler.js:1182`).

Não havia bloqueador técnico exigindo reiniciar o master (relatório 20 §14), e
ele não foi reiniciado.

## 17. Falhas e anomalias

**Nenhuma falha.** Uma anomalia, e ela **não foi causada por esta ativação**:

```
[tenant-manager] initSchema falhou em "sandbox".."sandbox6":
    attempt to write a readonly database
```

**Causa:** os bancos dos 6 tenants `sandbox*` pertencem a `root:root`, porque
foram criados pelos scripts que rodei nesta sessão (a sessão é root; o worker
roda como `carlosfinezi`).

**Não é regressão do restart:** o boot anterior, das 08:21:57, já registrava o
mesmo erro para os 5 sandboxes que existiam então. Agora são 6 porque o
`sandbox6` nasceu depois.

**Não afeta cliente nenhum** — verificado arquivo por arquivo:

| Grupo | Dono do `pncp.db` e do `-wal` | Worker escreve? |
|---|---|---|
| **13 tenants de clientes** | `carlosfinezi:carlosfinezi` 644 | **SIM** — conferido abrindo os bancos em modo escrita (`query_only=0`) |
| 6 sandboxes internos | `root:root` 644 | não |

Os sandboxes já estavam inacessíveis por HTTP de qualquer forma (402, tenant
`SUSPENDED`), então o efeito prático é apenas ruído no journal a cada boot.

**Não corrigi**, e o motivo é explícito: a correção é um `chown` dentro de
`data/`, que está no *deny* de permissões deste projeto, e a decisão é sua. Se
quiser limpar, é

```
chown -R carlosfinezi:carlosfinezi data/tenants/sandbox*
```

— mesmo padrão do `chown` do `.git` que o `CLAUDE.md` já prevê pelo mesmo motivo
(sessão root, arquivos do `carlosfinezi`).

## 18. Conclusão: **GO PARA PEDIDOS PDV**

A Fase 1 funcional está **em vigor em produção**:

- worker reiniciado às 11:17:35, subiu limpo, `/health` 302, sem stack trace;
- desconto, alçada, aprovação, `tipoAtendimento`, validação de entrega, origem
  PDV/Catálogo e governança de `desconto_venda` — todos ativos e verificados;
- tela de alçadas servindo `%` para desconto e `R$` para os eventos monetários;
- journal limpo nos oito padrões críticos;
- **nenhum dado de cliente alterado**, nenhuma faixa criada, nenhuma aprovação
  retroativa;
- master intocado.

O que o backend oferece hoje é tudo de que o PDV precisa: criar pedido com origem
`pdv`, declarar atendimento, aplicar desconto sujeito a alçada, exigir aprovação
quando passa do limite e faturar herdando o desconto.

## 19. Próximo passo recomendado

1. **Cadastrar as faixas de desconto, tenant a tenant**, pela tela de Governança,
   com os percentuais que cada proprietária definir. Enquanto não houver faixa, o
   desconto permitido é 0% e o ERP vende exatamente como antes — nada trava.
2. **Fila de aprovação visível ao aprovador.** Hoje a solicitação nasce e só
   aparece a quem for olhar. O vendedor recebe 409 com o motivo; o aprovador não é
   avisado. O padrão a generalizar já existe em `os-notificacoes.js`
   (`evento × canal`), e é o que evita repetir o problema de granularidade
   descrito no `CLAUDE.md`.
3. **Frontend do Pedidos PDV** — a tela de venda de balcão, consumindo o que
   acabou de entrar em vigor.
4. **Catálogo Online** depois, lembrando que `loja-routes.js` grava pedido por
   INSERT próprio e **ainda não passa pela porta única do desconto**: a alçada
   precisa entrar ali, não num segundo caminho.

**Riscos que permanecem abertos:** fail-open de perfil sem cadastro (19 §4);
`loja-routes` fora da porta de desconto; faixa de zero inativa em `pagamento_cp`
no `1bit` (20 §3.3); NFC-e/NFS-e lendo documento do corpo (15); webhook Asaas de
`josecarloscostafilho` (11); 4 pedidos de R$ 10.036,00 aguardando decisão de
backfill (07); `[DIGEST] no such table: licitacoes` (18 §16); e a propriedade
`root:root` dos sandboxes (§17).
