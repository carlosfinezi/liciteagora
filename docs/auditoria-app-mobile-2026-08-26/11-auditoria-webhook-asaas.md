# Auditoria — webhook do Asaas rejeitando por token inválido

Data: 2026-09-10, 18:30 → 18:55 BRT · Auditoria **somente leitura**.
Base: [`09`](09-pre-restart-fase0.md) §8.2 · [`10`](10-restart-controlado-fase0.md) §10.

> **Nada foi alterado.** Nenhum código, nenhuma configuração, nenhum banco,
> nenhum serviço reiniciado, nenhum commit. O único arquivo criado é este.

---

## 0. Resposta curta

**É CORREÇÃO SIMPLES DE CONFIGURAÇÃO, num tenant só — e não exige restart de
nada.**

O `webhookToken` cadastrado no ERP para o tenant **`josecarloscostafilho`** tem
**31 caracteres**; o que o Asaas envia para ele tem **49**. São valores
diferentes, e nem o tamanho bate. O do tenant `1bit` está correto — os webhooks
dele passam normalmente.

O dinheiro não está se perdendo: o polling cobre a baixa, com atraso de até 30
minutos. Mas há uma consequência que interessa diretamente à Fase 0 — §6.

---

## 1. A rota e o fluxo

| Item | Onde |
|---|---|
| **Rota** | `POST /webhook/boleto/:provedor` — `pre-auth-routes.js:106` |
| Registro | **pré-auth**, antes de `app.use(requireAuth)` — não exige login, por natureza |
| Processo que atende | `consulta-licitacoes.service` (ROLE=worker) |
| Orquestrador | `processarWebhook()` — `boleto-orchestrator.js:480` |
| Handler do provedor | `processarWebhook()` — `boleto-provedores/asaas.js:261` |
| Middleware envolvido | `tenantMiddleware` (resolve o tenant pelo Host) + `express.json` |

**Token recebido** — lido do **header** `asaas-access-token`
(`boleto-provedores/asaas.js:270-271`):

```js
const sent = (req.get && req.get('asaas-access-token'))
  || (req.headers && req.headers['asaas-access-token']);
```

Não há leitura de query string, body ou qualquer outra origem.

**Token esperado** — vem do **banco do tenant**, não de ENV nem de arquivo:

```
contas_financeiras_boleto  (provedor='asaas', ativo=1)
  └── coluna configJson (TEXT com JSON)
        └── chave "webhookToken"
```

Lido por `parseConfigJson()` (`boleto-orchestrator.js:196`), que faz spread do
`configJson` sobre a linha. A tela que grava esse valor é a de provedores de
boleto (`boleto-provedores-routes.js`), campo *"Token do Webhook (opcional)"*
(`boleto-provedores/asaas.js:110`).

---

## 2. Recebido × esperado

Sem expor segredo — só tamanho, prefixo/sufixo mascarados e formato.

### 2.1 O que o log mostra (20 ocorrências idênticas)

```
[Asaas webhook] token inválido — ignorando
  | recebido: 49 chars, whs…mGs
  | esperado: 31 chars, whs…N9m
  | headers candidatos: asaas-access-token
```

### 2.2 O que está cadastrado no ERP

| Tenant | `webhookToken` | `accessToken` (API) |
|---|---|---|
| `1bit` | **49 chars**, `whs…bAY` | 166 chars, formato `$aact…` |
| `josecarloscostafilho` | **31 chars**, `whs…N9m` | 166 chars, formato `$aact…` |

### 2.3 O cruzamento

- **`esperado: 31 chars, whs…N9m`** bate **exatamente** — tamanho, prefixo e
  sufixo — com o `webhookToken` do **`josecarloscostafilho`**. É esse tenant que
  está rejeitando.
- **`recebido: 49 chars, whs…mGs`** **não corresponde a nenhum dos dois**
  cadastrados. O do `1bit` também tem 49 chars, mas termina em `bAY`, não `mGs`.

### 2.4 Causas descartadas, uma a uma

| Hipótese | Veredito |
|---|---|
| **Header incorreto** | ❌ descartado — `headers candidatos: asaas-access-token`, o header chega com o nome certo |
| **Prefixo `Bearer`** | ❌ descartado — o valor cadastrado não começa com `bearer` (verificado) e o recebido tem prefixo `whs`, o mesmo padrão |
| **Espaço / quebra de linha** | ❌ descartado — o valor no banco não tem espaço nas bordas (verificado); e a diferença é de 18 caracteres, não de 1 ou 2 |
| **Variável errada / ENV** | ❌ descartado — o token vem do banco do tenant, não de ENV |
| **Token de OUTRO tenant sendo comparado** | ❌ descartado — o esperado é o do próprio tenant que recebeu; e o recebido também não é o do `1bit` |
| **Configuração duplicada** | ❌ descartado — há **uma** linha `asaas` ativa por tenant |
| **Mudança de padrão do Asaas** | ⚠️ **provável coadjuvante** — os dois tokens começam com `whs`, mas o novo padrão parece ser de 49 chars (o `1bit`, configurado depois, tem 49) |
| **Token antigo no ERP / regenerado no painel** | ✅ **CAUSA MAIS PROVÁVEL** — o painel do Asaas do `josecarloscostafilho` tem um token de 49 chars e o ERP guarda um de 31 |

**Não é possível afirmar com 100% de certeza** de que lado a divergência nasceu
(se o token foi regenerado no painel ou se foi cadastrado errado no ERP desde o
início) sem abrir o painel do Asaas daquele tenant — o que está fora do alcance
desta auditoria. O que é certo: **os dois lados divergem, e é no
`josecarloscostafilho`.**

---

## 3. Tenant e escopo

- **O endpoint é único e global** (`/webhook/boleto/:provedor`), mas **o
  processamento é por tenant**.
- **Resolução do tenant: pelo Host**, via `tenantMiddleware` →
  `tenant-manager.resolveFromHost()` — subdomínio `<slug>.liciteagora.app`.
  O Asaas de cada empresa aponta para o subdomínio dela.
- **Cada empresa tem sua própria conta Asaas**: os `accessToken` dos dois
  tenants são distintos (sufixos diferentes), ambos no formato `$aact…`.
- **Risco de comparar o token de um tenant com o de outro: não existe.** A
  config é lida do `db` já resolvido pelo Host
  (`boleto-orchestrator.js:485`), dentro do `AsyncLocalStorage` do tenant. O
  cruzamento confirmou: o esperado era o do próprio tenant.

**Tenant afetado: `josecarloscostafilho`, e só ele.** Confirmado pelos
pagamentos: `pay_nnd4xf8s0tidy08g`, rejeitado hoje às 17:33, corresponde ao
`boletos#7` desse tenant. Os pagamentos do `1bit` (`pay_rysezzcim0ccozh6`,
`pay_gc40aoqjxi34dkww`) **não** geram rejeição.

Dos 13 tenants, **apenas 2 têm Asaas configurado e ativo**.

---

## 4. Frequência

Journal do `consulta-licitacoes.service`, desde 2026-08-20:

| Métrica | Quantidade |
|---|---|
| Eventos `[Asaas webhook]` no total | **139** |
| Com `payment` (só esses checam token) | **47** |
| Sem `payment` (transferências, etc. — saem antes do check) | 69 |
| **Rejeitados por token** | **23** |

- **Primeira rejeição: 2026-08-20 16:14.** Coincide com a data em que o log de
  diagnóstico foi acrescentado (o comentário no código diz *"TEMP diagnóstico
  (2026-08-20)"*), então o problema pode ser anterior — simplesmente não havia
  registro antes.
- **Última rejeição: 2026-09-10 17:33** (hoje).
- **20 das 23** têm assinatura **idêntica**: `recebido: 49 chars, whs…mGs |
  esperado: 31 chars, whs…N9m`. As 3 restantes são de 20/08, antes de o log
  passar a imprimir os detalhes.
- **Há webhook funcionando**: os eventos com `payment` do `1bit` não produzem
  rejeição — hoje mesmo, às 17:42 e 18:43, dois `PAYMENT_CONFIRMED`/
  `PAYMENT_RECEIVED` passaram limpos.

Ritmo aproximado: ~23 rejeições em 21 dias, ~1/dia.

---

## 5. Polling — a rede de segurança

| Item | Valor |
|---|---|
| Onde roda | **`scheduler.js:196`** → `agendarPollingBoletosAsaas(db)` — processo `liciteagora.service` (ROLE=master), **não** o worker |
| Periodicidade | **30 min** para tudo (`INTERVALO_BOLETO`); **2 min** só para PIX recente (`INTERVALO_PIX`); 1ª passada 90 s após o boot |
| Como funciona | **consulta ativa à API do Asaas**, não depende de webhook |
| Função que baixa | `registrarBaixaCR()` (`boleto-orchestrator.js:592`), com `origem: 'polling_asaas'` |

**A baixa financeira está funcionando apesar do webhook rejeitado.** Prova
direta: a CR do pagamento rejeitado hoje às 17:33 está `paga`, com o registro:

```
contas_receber_pagamentos: id=19, contaReceberId=29,
origem = 'polling_asaas', valorPago = 600.00, dataCriacao 2026-09-10 13:42:11
```

Ou seja: o webhook é ignorado, o polling pega minutos depois.

### 5.1 O polling do scheduler antigo executa a nova sincronização? **NÃO.**

Confirmado, e a cadeia é esta:

- `scheduler.js:26` faz `require('./financeiro-routes')` **no topo**;
- `financeiro-routes.js:11` faz `require('./contas-receber-routes')` **no topo**;
- logo, `contas-receber-routes.js` foi carregado **no boot do scheduler, em
  2026-09-02 09:40** — e a versão em disco naquele momento era a de **21/08**.

O `liciteagora.service` **não foi reiniciado** (segue de 02/09). Portanto o
polling chama a versão **antiga** de `sincronizarPagamentoPedido`, que só
enxerga `faturaId` e abandona a CR ligada por `pedidoId`.

**Consequência prática:** enquanto a baixa vier pelo polling, um pedido da loja
virtual ou do faturamento de OS **continua com `valorPago = 0`**, mesmo depois
do restart de hoje. O passivo medido segue igual: **4 pedidos, R$ 10.036,00**,
todos no `josecarloscostafilho`.

*(A baixa de hoje, CR 29, não agravou o passivo: aquela CR não tem `pedidoId`
nem `faturaId` — é cobrança avulsa.)*

---

## 6. Efeito da correção — o ponto mais importante desta auditoria

**Corrigir o token do webhook resolve, de quebra, o problema do scheduler
desatualizado.** O raciocínio:

- o **webhook** entra pelo `consulta-licitacoes.service`, que **foi reiniciado
  hoje às 18:21** e já tem a `sincronizarPagamentoPedido` nova;
- o **polling** roda no `liciteagora.service`, que tem a versão antiga.

Com o webhook voltando a funcionar, a baixa passa a acontecer no processo **que
já está correto** — e a sincronização nova passa a valer **sem reiniciar o
scheduler**. O polling continua como rede de segurança.

### Necessidade de restart, por solução

| Solução | Restart necessário |
|---|---|
| **Acertar o `webhookToken` no ERP** (tela de provedores de boleto) | **A) NENHUMA reinicialização.** A config é lida do banco **a cada webhook** (`boleto-orchestrator.js:485`), não é cacheada em memória |
| **Acertar o token no painel do Asaas** para o valor que o ERP espera | **A) nenhuma** — muda só o lado de lá |
| Fazer a sincronização nova valer **também no polling** | **C) restart de `liciteagora.service`** — com a ressalva conhecida (liga `cicloAvisoAlcadas` e o watchdog, com destino externo) |
| Mudança no código do handler | **B) restart de `consulta-licitacoes.service`** — mas **não é necessária** (§8) |

**Nenhuma solução exige D (os dois).**

---

## 7. Segurança — riscos observados, nenhum corrigido

| # | Risco | Gravidade | Situação |
|---|---|---|---|
| 1 | **Validação desligada quando não há token** | **média** | `if (cfg.webhookToken)` (`asaas.js:269`): se a chave estiver vazia ou ausente, **nada é validado** e qualquer POST anônimo com um `payment.id` conhecido é aceito. Hoje **os 2 tenants têm token preenchido**, então não está exposto — mas é fail-open por desenho |
| 2 | **Comparação não é timing-safe** | baixa | `sent !== cfg.webhookToken` — comparação de string comum. Teoricamente permite ataque de tempo; na prática, sobre HTTP e com token de 31–49 chars, é pouco explorável. O correto seria `crypto.timingSafeEqual` |
| 3 | **Sem event ID / sem tabela de eventos processados** | baixa | a idempotência é **por estado**: `boleto-orchestrator.js:496` só baixa CR que não esteja `paga` nem `cancelada`. Funciona para reentrega, mas não distingue "mesmo evento" de "evento novo com mesmo efeito" |
| 4 | **Baixa dupla por chamada autenticada** | baixa | protegida pelo mesmo mecanismo do item 3. O comentário do polling registra que leitura de status e baixa são síncronas, sem `await` no meio |
| 5 | **Resposta sempre 200, mesmo em erro** | baixa | `pre-auth-routes.js:113` — deliberado, para evitar retry agressivo. Efeito colateral: quem chama não distingue sucesso de recusa (o que, para um atacante, é bom) |
| 6 | **Log expõe parte do token esperado** | **média** | o diagnóstico imprime tamanho + 3 primeiros e 3 últimos caracteres do segredo no journal do servidor. O próprio código diz **"TEMP … REMOVER depois do diagnóstico"** (`asaas.js:275-278`). Já cumpriu a função: foi ele que permitiu este diagnóstico |
| 7 | Rejeição não gera alerta | baixa | a rejeição só vira `console.warn`. Ninguém é avisado — o problema durou 21 dias sem ninguém notar, e só apareceu porque fomos ler o journal |

**Nenhum hardening foi aplicado**, conforme sua instrução.

---

## 8. Recomendação

# ✅ CORREÇÃO SIMPLES DE CONFIGURAÇÃO

**Não é preciso mudar código.** O handler está correto: lê o header certo,
compara com a config certa do tenant certo, e recusa quando divergem — que é o
comportamento desejado.

### Onde está a divergência

Tenant **`josecarloscostafilho`** → tela de **provedores de boleto** → provedor
**Asaas** → campo **"Token do Webhook"**.

- valor no ERP: **31 caracteres**, começa com `whs`, termina em `N9m`;
- valor que o Asaas envia: **49 caracteres**, começa com `whs`, termina em `mGs`.

### Correção mínima

Abrir o painel do Asaas **daquele tenant**, em *Integrações → Webhooks*, e
comparar o token de acesso configurado lá com o do ERP. Então **alinhar os
dois**, no lado que estiver desatualizado — o mais provável é copiar o token de
49 caracteres do painel para o campo do ERP.

O tenant `1bit` **não deve ser tocado**: o webhook dele funciona.

### Depois da correção, verificar

Sem reiniciar nada, acompanhar no journal o próximo `PAYMENT_RECEIVED` daquele
tenant: ele deve aparecer **sem** a linha `token inválido — ignorando` na
sequência. A partir daí, a baixa passa pelo worker (que já tem o código novo) e
`pedidos.valorPago` passa a refletir também as CRs ligadas por `pedidoId`.

### Duas coisas que ficam pendentes, e não são desta correção

1. **O log TEMP de diagnóstico** (`asaas.js:275-289`) deve ser removido depois —
   ele expõe parte do segredo no journal. Já cumpriu a função.
2. **O passivo histórico** de 4 pedidos / R$ 10.036,00 continua: corrigir o
   webhook resolve o fluxo dali para a frente, não o retroativo. O backfill
   segue não autorizado.

---

## 9. Confirmação

- **Nenhum serviço reiniciado** — só `systemctl show`/`status` e `journalctl`,
  todos leitura. `consulta-licitacoes.service` segue no PID 2052694 (start
  18:21:19) e `liciteagora.service` no de 02/09.
- **Nenhuma configuração alterada** — o `configJson` do Asaas foi apenas **lido**
  e mascarado.
- **Nenhum código de aplicação alterado.**
- **Banco não alterado** — somente `SELECT` e `PRAGMA`.
- **Nenhuma migration, nenhum backfill.**
- **Nenhum commit**; nenhum `reset`, `stash` ou `clean`.
- O único arquivo criado é este relatório.
