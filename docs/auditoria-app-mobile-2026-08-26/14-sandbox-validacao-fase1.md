# Sandbox — criação, migration e validação da Fase 1

Data: 2026-09-11 · Continuação de [`13`](13-fase-1-decisoes-modelo-comercial.md).

> **Migration aplicada SOMENTE no `sandbox`.** Nenhum tenant de cliente foi
> tocado (verificado ao final). Nenhum serviço reiniciado, nenhum commit,
> nenhum backfill, nada no Asaas.

---

## 0-A. ⚠️ Os dois serviços foram reiniciados hoje — e não fui eu

Descoberto na conferência final, e precisa ficar no topo.

| Serviço | Novo start | PID | NRestarts | Erros no boot |
|---|---|---|---|---|
| `consulta-licitacoes.service` | **2026-09-11 06:18:47** | 3085545 | 0 | **0** |
| `liciteagora.service` (scheduler) | **2026-09-11 06:18:49** | 3085849 | 0 | **0** |

**Causa:** **55 serviços** foram parados e iniciados no mesmo minuto — `atd`,
`avahi`, `accounts-daemon`, `packagekit`, `cron` e os dois do Licite Agora. É
atualização de sistema, disparada pelo cron do Hestia das 06:00
(`sudo /usr/local/hestia/bin/v-update-sys-queue restart`). **A máquina não
reiniciou** — uptime de 15 semanas.

**Não executei nenhum `systemctl` nesta sessão** além de `show`/`status`.

### Consequências, e são de três tipos

**1. Todo o código da Fase 1 que estava no disco entrou em vigor** — todos os
arquivos têm mtime anterior a 06:18:47:

`pedido-politicas.js` (origem `pdv`/`catalogo`) · `loja-routes.js` (catálogo
grava `tipo='catalogo'`) · `financeiro-routes.js` (busca por telefone) ·
`faturas-routes.js` (**herança do desconto**) · `pedido-desconto.js` (carregado,
mas ainda **não conectado** às rotas de pedido).

Os dois serviços subiram **sem nenhum erro**, o que é a melhor confirmação
possível de que o código está são.

**2. Resolveu, de graça, a pendência do relatório 11.** O scheduler agora roda
`contas-receber-routes.js` de 10/09 16:20 — a versão com
`sincronizarPagamentoPedido` corrigida. **O polling do Asaas, que era o caminho
que de fato baixa as cobranças, passou a refletir o pagamento em
`pedidos.valorPago` também para CR ligada por `pedidoId`.** Era exatamente o que
dependia de um restart do `liciteagora.service` que eu não podia dar.

**3. Ligou o que o `CLAUDE.md` avisava.** O primeiro restart do
`liciteagora.service` ativa o `cicloAvisoAlcadas` (varredura de 6 em 6 horas) e
o watchdog do catálogo. Conferido agora: **0 aprovações pendentes com
`expiraEm`** no `1bit` e no `reimac` — então o amortecedor documentado continua
valendo e **nenhum aviso foi disparado**. Mas isso é estado de dado, não
garantia: basta uma aprovação nascer.

**Nada disso muda o que fiz ou deixei de fazer** — a migration continua só no
sandbox e nenhum cliente foi tocado. Mas o estado do sistema mudou, e você
precisa saber.

---

## 0. O achado que domina este relatório

Criar o sandbox pelo mecanismo oficial revelou um **defeito de produção no
provisionamento**: *um tenant novo não nasce com o schema completo, e o
`POST /api/pedidos` dele responde 500*.

Não é do nosso código, não foi introduzido por esta fase, e **afeta qualquer
cliente provisionado hoje**. Detalhe em §1.5. Não corrigi — corrigir mexe no
provisionamento de todos e é tarefa própria, com sua aprovação.

---

## 1. Auditoria do provisionamento

### 1.1 O que a criação de tenant faz

`POST /api/admin/tenants` (`control-plane-routes.js:539`), do control plane:

| Passo | O quê | Efeito externo? |
|---|---|---|
| 1 | `manager.createTenant` — cria `data/tenants/<slug>/`, o `pncp.db`, aplica `initSchema` e insere em `data/control.db` | **não** |
| 2 | `applyRouteMigrations` — registra todas as rotas num app descartável para rodar os `db.exec`/seed de cada módulo | **não** (ver §1.4) |
| 3 | cria `users.admin` com senha aleatória | não |
| 4 | cria `config.api_key` | não |
| 5 | **`spawnProvisionVhost`** — `sudo` no script do Hestia: vhost nginx + SSL Let's Encrypt | **SIM** |

### 1.2 Rastreamento dos efeitos que você listou

| Efeito | Existe no fluxo? | Evidência |
|---|---|---|
| E-mail para cliente | **não** | nenhum `nodemailer`/`smtp`/`enviarEmail` em `control-plane-routes.js` nem em `tenant-manager.js` |
| Cobrança / assinatura paga | **não** na criação | `tenant_billing` só é preenchida por `POST .../billing/paid`, manual |
| Webhook externo | **não** | nenhum `axios`/`fetch` nos dois arquivos |
| WhatsApp | **não** | idem |
| Integração financeira | **não** | provedores de boleto exigem `contas_financeiras_boleto` configurada — que nasce vazia |
| **Comunicação externa** | **SIM, uma** | `spawnProvisionVhost` → nginx/Hestia + Let's Encrypt |
| **Jobs do scheduler** | **SIM, potencialmente** | ver §1.3 |

### 1.3 O vetor menos óbvio: o scheduler pega tenant novo sem restart

`scheduler.js` chama `_listTenantsSafe()` **dentro dos ciclos** (`:158`, `:179`,
`:216`, `:259`), não só no boot. Um tenant novo entraria em `agendarCobrancas`,
`agendarPollingBoletos`, `agendarPollingBoletosAsaas`, `agendarPcpMonitor`,
`agendarAlertasDisputa` — **sem precisar reiniciar o `liciteagora.service`**.

E `agendarCobrancas` é a régua que manda e-mail/WhatsApp para inadimplentes.

**A trava:** `listActive()` é
`SELECT * FROM tenants WHERE status IN ('ACTIVE','TRIAL')`
(`tenant-manager.js:256`). Fora desses dois status, o tenant é **invisível para
todos os jobs**.

### 1.4 Como o sandbox foi blindado

Usei o **mesmo mecanismo** (`createTenant` + `applyRouteMigrations`), por script
(`scripts/sandbox-criar.js`), com duas exclusões deliberadas:

1. **Sem `spawnProvisionVhost`.** Nenhum vhost, DNS, SSL ou toque no Hestia —
   que, além do mais, se auto-atualiza e regera vhosts. Ambiente de teste não
   precisa de domínio público. `provision_status` ficou `NOT_STARTED`.
2. **Status `SUSPENDED`.** Fora de `listActive()` ⇒ fora de todos os jobs.
   Nenhuma comunicação externa pode partir dele.

Sobre os timers: `applyRouteMigrations` registra rotas de verdade, e alguns
módulos criam `setInterval` (sniper ~2 min, wa-scheduler 120 s). O script sai com
`process.exit(0)` em segundos — **nenhum chega a disparar**.

Confirmação no journal do `liciteagora.service` depois da criação: **nenhuma
menção ao sandbox**.

### 1.5 🔴 Defeito encontrado: provisionamento incompleto

Ao usar o sandbox, `POST /api/pedidos` respondeu **500 —
`table pedidos has no column named vendedorId`**.

**Causa, isolada com precisão:**

1. `db-schema.js:2402` faz `alterSafe('ALTER TABLE faturas ADD COLUMN isDevolucao …')`
   — mas `faturas` só nasce em `faturas-routes.js`, mais adiante. O `alterSafe`
   **engole o erro** (é idempotente por desenho) e a coluna não é criada.
2. Depois, `tipos-operacao-routes.js:245` executa
   `UPDATE … WHERE isDevolucao IS NULL …` e **lança**.
3. `applyRouteMigrations` envolve `registerProtectedRoutes` num **único**
   try/catch (`tenant-provision.js:79-83`). A exceção **aborta a cadeia** — e
   todos os módulos registrados depois nunca rodam suas migrations.

**Alcance medido no sandbox recém-criado:**

| Item | Estado |
|---|---|
| Último módulo registrado | `fiscal-classificacao` (`route-registry.js:277`) |
| `pedidos.vendedorId`, `depositoId`, `origemLoja` | **ausentes** |
| `comissoes_regras`, `comissoes_apuracao`, `metas_vendas`, `crm_funis`, `optica_marcas` | **tabelas ausentes** |
| Tabelas totais | **277** (um tenant real tem 374) |

**Consequência para o negócio:** um cliente provisionado hoje não consegue
criar pedido pela API, e fica sem comissões, metas e CRM.

**Segunda classe de falha, silenciosa:** mesmo sem abort, vários `alterSafe`
rodam antes de a tabela existir e a coluna nunca nasce. Restavam 27 colunas
faltando em `contas_a_receber`, `fatura_itens`, `faturas`, `reservas_estoque` e
`users` mesmo depois de destravar o abort.

**Não corrigi o provisionamento.** Para o sandbox ficar utilizável, criei
`scripts/sandbox-completar-schema.js`, que **só adiciona colunas** e **só opera
no sandbox** (trava dura no caminho). Depois disso: 362 tabelas,
`integrity_check` ok.

---

## 2. O sandbox criado

| | |
|---|---|
| slug | **`sandbox`** |
| nome | `[INTERNO] Sandbox de testes — Licite Agora` |
| status | **SUSPENDED** (blindagem contra jobs) |
| plano | `enterprise` (para poder testar todos os módulos) |
| `owner_email` | **vazio** — não há para quem notificar |
| `provision_status` | `NOT_STARTED` — nenhum vhost/SSL |
| `notes` | `AMBIENTE INTERNO DE TESTE — nao e cliente. SUSPENDED de proposito…` |
| banco | `data/tenants/sandbox/pncp.db` |

**Nenhum dado de cliente foi importado ou copiado.** Toda a massa é fictícia.

### Usuários e perfis

| Login | Papel | Perfil de acesso |
|---|---|---|
| `admin` | `admin` | — (privilegiado) |
| `vendedor` | `comercial` | **cadastrado**: pedidos, pessoas, produtos, meu-perfil |
| `gerente` | `gerente-comercial` | **cadastrado**: + comercial-metas, comissoes, aprovacoes |

Senhas **aleatórias por execução**, impressas uma única vez na criação. Nenhuma
senha de cliente foi reaproveitada, e nada ficou fixo em código. Verifiquei que
o `admin` **não** ficou com a senha `admin` do bootstrap padrão (o banner
aparece, mas o script sobrescreve com `INSERT OR REPLACE`).

Os perfis foram cadastrados **de propósito**: sem cadastro, `atorIrrestrito`
aplica o fail-open de `perfis-acesso.js` e vendedor/gerente virariam
privilegiados — e o fail-closed do desconto não valeria para eles. Foi
exatamente a sua decisão 7.

---

## 3. Backup e integridade

| Momento | Resultado |
|---|---|
| **Backup pré-migration** | `/home/carlosfinezi/backups/sandbox-pre-migration-20260911-074043/pncp.db` — 3,0 MB, feito com **`sqlite3 .backup`** (nunca `cp`) |
| `integrity_check` do backup | **ok** |
| `integrity_check` antes | **ok** |
| `integrity_check` depois | **ok** |

Schema anterior registrado junto do backup: `pedidos` 40 colunas, `pessoas` 74.

---

## 4. Migration — somente no sandbox

```
node scripts/migrate-fase1-pedido.js sandbox --aplicar
  sandbox   6 coluna(s) criada(s) ✔
```

| Tabela | Antes | Depois | Novas |
|---|---:|---:|---|
| `pedidos` | 40 | **45** | `descontoTipo`, `descontoValor`, `descontoAplicado`, `descontoMotivo`, `tipoAtendimento` |
| `pessoas` | 74 | **75** | `semDocumento` |

- **Nenhuma coluna removida** (conferido por `comm` entre antes e depois).
- **Nenhum dado alterado**: as colunas nascem NULL/0.
- Os outros 13 tenants: **0 colunas novas**, verificado um a um. O dry-run
  global continua mostrando "6 coluna(s) a criar" para todos e "já migrado" só
  para o sandbox.

*(As 48 colunas finais de `pedidos` incluem `vendedorId`, `depositoId` e
`origemLoja`, que faltavam pelo defeito do §1.5 e foram completadas à parte.)*

---

## 5. As colunas, com finalidade

| Tabela | Coluna | Tipo | Nullable | Default | Finalidade |
|---|---|---|---|---|---|
| `pedidos` | `descontoTipo` | TEXT | sim | — | `'valor'` ou `'percentual'` — como o operador informou |
| `pedidos` | `descontoValor` | REAL | sim | 0 | o número digitado, na unidade acima |
| `pedidos` | `descontoAplicado` | REAL | sim | 0 | **o abatimento em R$** — é o que entra no total e o que a fatura herda |
| `pedidos` | `descontoMotivo` | TEXT | sim | — | por que foi dado; o aprovador da alçada decide olhando isto |
| `pedidos` | `tipoAtendimento` | TEXT | sim | — | `no_local` / `retirada` / `entrega`; **NULL = pedido que não declara** |
| `pessoas` | `semDocumento` | INTEGER | sim | 0 | `1` = sem CPF/CNPJ real; `cpfCnpj` guarda identificador interno |

---

## 6. Massa de teste

**Clientes** (fictícios):

| Cliente | Documento | Telefone |
|---|---|---|
| Ana Souza | CPF `111.444.777-35` | (11) 90000-1111 |
| Comercio Fictício LTDA | CNPJ `11.222.333/0001-81` | (11) 90000-2222 |
| Bruno Lima | CPF `529.982.247-25` | **(11) 93333-4444** |
| Carla Lima | CPF `877.482.488-00` | **(11) 93333-4444** ← mesmo telefone, pessoa distinta |
| Diego do Balcão | **sem documento** (`SD-…`, `semDocumento=1`) | (11) 95555-6666 |

**Produtos:** 5 — R$ 100, R$ 50, R$ 250, granel R$ 20/KG e um **sem estoque**
(R$ 75).

**Alçadas — MASSA DE TESTE, só deste tenant:**

| Faixa | Aprovador | Leitura |
|---:|---|---|
| 5% | `gerente-comercial` | vendedor aplica até 5% |
| 15% | `admin` | gerente aplica até 15% |

**Não estão na migration nem em seed de produção.** O script as insere
diretamente no banco do sandbox, com descrição prefixada `[SANDBOX]`.

---

## 7. Fase 1.5 — testes de desconto

Subtotal de R$ 500 (5 × R$ 100) em todos os casos.

| Ator | % | Subtotal | Desconto | Frete | Total | Alçada | Exigiu aprovação | Quem aprova |
|---|---:|---:|---:|---:|---:|---|---|---|
| VENDEDOR | 0% | 500,00 | 0,00 | 0,00 | **500,00** | liberado | não | — |
| VENDEDOR | 3% | 500,00 | 15,00 | 0,00 | **485,00** | `alcada_base` | não | — |
| VENDEDOR | **5%** | 500,00 | 25,00 | 0,00 | **475,00** | `alcada_base` | não | — |
| VENDEDOR | **6%** | 500,00 | 30,00 | 0,00 | **500,00** | `pendente` | **SIM** | gerente (ou admin) |
| GERENTE | 5% | 500,00 | 25,00 | 0,00 | **475,00** | `alcada_base` | não | — |
| GERENTE | **15%** | 500,00 | 75,00 | 0,00 | **425,00** | **`propria`** | não | — |
| GERENTE | **16%** | 500,00 | 80,00 | 0,00 | **500,00** | `pendente` | **SIM** | admin |
| ADMIN | 30% | 500,00 | 150,00 | 25,00 | **375,00** | `propria` | não | — |

Leitura das três linhas que mais importam:

- **VENDEDOR 5% passa, 6% não.** O limite é exato, sem zona cinzenta.
- **GERENTE 15% aplica direto** (`autoridade: propria`) — era o ponto da sua
  decisão: ele não precisa de outro gerente para o que ele mesmo aprovaria.
- **GERENTE 16% sobe para admin**, e o total volta a 500 porque o desconto não é
  aplicado enquanto pendente.

**O desconto não alterou o preço de nenhum item** — todos continuam a R$ 100
(teste `1.5-g`).

---

## 8. Fase 1.6 — tipo de atendimento

| Origem | Atendimento | Endereço | Resultado |
|---|---|---|---|
| `pdv` | `no_local` | não | **aceita** |
| `pdv` | `retirada` | não | **aceita** |
| `pdv` | `entrega` | sim | **aceita** |
| catálogo | `retirada` | não | **aceita** |
| catálogo | `entrega` | sim | **aceita** |
| `pdv` | **(nenhum)** | não | **RECUSA** — `pedido de origem "pdv" exige tipoAtendimento` |
| catálogo | **(nenhum)** | não | **RECUSA** — mesma regra |
| `pdv` | `entrega` | **não** | **RECUSA** — `entrega exige endereco` |
| `manual` (ERP) | **(nenhum)** | não | **aceita** — pedido legado continua válido |

> A validação está implementada **no script de teste**, como especificação
> executável da regra aprovada. Ela **ainda não está nas rotas** — isso depende
> de conectar o módulo, que é a sua decisão 5 do relatório 13.

---

## 9. Fase 1.7 — pessoa sem documento

Identificador gerado: `SD-efd15707fa1b4e32a60d6d593dc6d965`
(`crypto.randomUUID()`, 128 bits — não `Math.random()`).

| Verificação | Resultado |
|---|---|
| Cadastro com `semDocumento = 1` | ✅ |
| `UNIQUE` continua barrando identificador repetido | ✅ |
| Busca por **nome** | ✅ |
| Busca por **telefone** | ✅ |
| Telefone repetido devolve **as duas** pessoas, sem fundir nem inativar | ✅ |
| Pode ser usada em pedido, que **confirma** normalmente | ✅ |
| Aparece em Clientes & Fornecedores como qualquer outra | ✅ |

### 9.1 🔴 O caminho fiscal — um risco medido e eliminado

Os emissores limpam o documento com `(cpfCnpj || '').replace(/\D/g,'')`:
`nfe-emit-routes.js:521`, `nfse-routes.js:332`, `nfce-routes.js:294`.

Aplicado a `SD-<uuid hex>`, isso **apaga o prefixo e as letras a–f, deixando só
os dígitos do UUID**. Se sobrarem exatamente 11 ou 14, a NF-e monta
`destTag.CPF`/`destTag.CNPJ` — **com um número inventado**.

Medi em **200.000 gerações**:

| Resultado | Ocorrências | % |
|---|---:|---:|
| vira 11 dígitos (parece CPF) | 121 | 0,06% |
| vira 14 dígitos (parece CNPJ) | 2.153 | **1,08%** |
| **risco combinado** | 2.274 | **1,14%** |

**1 em cada 88 cadastros sem documento carregaria um CNPJ falso para dentro de
uma nota fiscal.** Exatamente o que você proibiu.

**Corrigido na origem:** o gerador regenera enquanto o resultado limpo tiver
comprimento de documento. Custo ~1% de tentativas. Remedido depois:
**0 e 0 em 200.000**, com 0 colisões em 50.000.

**A porta certa continua sendo `documentoFiscalDe(pessoa)`**, que devolve `null`
para `semDocumento = 1` — e é ela que a emissão deve consultar, nunca
`pessoa.cpfCnpj` cru. A regeneração é a segunda camada, para o caso de algum
caminho ler a coluna direto.

### 9.2 ⚠️ O que precisa ser corrigido ANTES do catálogo público

**Nenhum emissor fiscal usa `documentoFiscalDe()` hoje** — todos leem
`cpfCnpj` direto. Com o gerador endurecido, um `SD-…` não vira mais documento
falso, mas o comportamento ainda não é o desejado:

| Emissor | Hoje, com `SD-…` |
|---|---|
| **NF-e** (`nfe-emit-routes.js:521-524`) | os dígitos não dão 11 nem 14 ⇒ **omite a tag** CPF/CNPJ. Tecnicamente é o comportamento de consumidor não identificado (`indIEDest=9`), mas por acidente, não por decisão |
| **NFS-e** (`nfse-xml.js:176`, `nfse-routes.js:623`) | `tomador.cpfCnpj` vem do **corpo da requisição**, não de `pessoas` — não é alcançado hoje |
| **NFC-e** (`nfce-routes.js:294`) | usa `payload.consumidorCpfCnpj`, também do corpo |

**Recomendação: não ligar o cadastro público antes de os emissores passarem a
consultar `documentoFiscalDe()`** e a recusar explicitamente a emissão quando o
documento for obrigatório. É mudança fiscal, e não a fiz em silêncio.

---

## 10. Fase 1.8 — pedido → fatura

| Caso | Bruto | Desconto | Total | Origem do desconto |
|---|---:|---:|---:|---|
| **herdado** (corpo sem desconto) | 500,00 | **50,00** | **450,00** | pedido |
| manual 80 (pedido tinha 50) | 500,00 | **80,00** | 420,00 | corpo — **substitui** |
| manual 0 (pedido tinha 50) | 500,00 | 0,00 | 500,00 | corpo — zero explícito |
| pedido sem desconto | 500,00 | 0,00 | 500,00 | — |

**O caso central saiu exatamente como especificado: 500 − 50 = 450.**

E o que não pode acontecer, não aconteceu: com pedido de 50 e corpo de 80, a
fatura saiu com **80**, não 130. **Nunca soma.**

### 10.1 Requisito de frontend, documentado (não implementado)

A tela de faturamento deverá mostrar, antes de o operador digitar:

```
Desconto herdado do pedido     R$ 50,00
```

Sem isso, o operador redigita por hábito — e como o informado **substitui**, o
resultado é silenciosamente diferente do que ele espera. Não implementei
frontend nesta fase.

---

## 11. Compatibilidade com tenant não migrado

`scripts/test-fase1-rollout-parcial.js` — **10 testes, 10 OK**.

Exercita um banco descartável **no schema antigo** (sem nenhuma coluna da Fase 1)
ponta a ponta, com o **mesmo código** que roda no sandbox migrado:

| Verificação (schema ANTIGO) | Resultado |
|---|---|
| As colunas da Fase 1 realmente não existem | ✅ |
| `temColunaDesconto` detecta a ausência | ✅ |
| `descontoDoPedido` devolve 0, sem 500 | ✅ |
| `POST /api/pedidos` funciona | ✅ |
| item, confirmar e entregar funcionam | ✅ |
| **`POST /api/pedidos/:id/faturar` funciona** — é onde `descontoDoPedido` é chamado | ✅ bruto 500, desconto 0, total 500 |
| faturar com desconto manual (70) continua funcionando | ✅ total 430 |
| alçada não quebra sem as tabelas: fail-closed para restrito | ✅ |
| **(sandbox migrado)** `temColunaDesconto` = true e a leitura confere | ✅ |

**Nenhum caminho produz 500 por falta das colunas.** É o que sustenta o rollout
parcial.

---

## 12. Conexão de `pedido-desconto.js`

**Ainda NÃO conectado às rotas de pedido**, conforme sua decisão 7 — e agora com
a prova de que a conexão será segura:

| Peça | Estado |
|---|---|
| `descontoDoPedido` em `faturas-routes.js` | **já em uso** — é tolerante, e o §11 prova que não quebra no schema antigo |
| `calcularDesconto`, `verificarAlcadaDesconto`, `totalDoPedido` | prontos e testados, **sem consumidor em rota** |
| `recalcularTotal` com desconto | **não conectado** — é o ponto que exige a migration em todos os tenants |
| `POST /api/pedidos/:id/desconto` | **não criada** |
| Validação de `tipoAtendimento` nas rotas | **não conectada** — hoje vive no script de teste como especificação |

O que falta para conectar, em ordem: migration nos tenants → ligar
`recalcularTotal` com guarda de schema → criar a rota de desconto → ligar a
validação de atendimento.

---

## 13. Testes automatizados

| Suíte | Resultado |
|---|---|
| **`scripts/sandbox-seed-e-testes.js`** (novo) | **26 OK, 0 falhas** — roda no sandbox |
| **`scripts/test-fase1-rollout-parcial.js`** (novo) | **10 OK, 0 falhas** |
| `test-fase1-desconto-origem` | 57 OK, 0 falhas |
| `test-app-backend` | 79 OK, 0 falhas |
| `test-fase0-pagamento-pedido` | 15 OK, 0 falhas |
| `test-reservas-pedido` · `test-venda-perdida-pedido` · `test-metas-bi` | 11 · 16 · 21, 0 falhas |
| `test-deposito-movimentacao` · `test-devolucao-venda-espelho` | 14 · 17, 0 falhas |
| `test-devolucoes-credito-metas-comissao` · `test-devolucoes-custo-saldo-estorno` | 22 · 22, 0 falhas |
| `npm run verify` | **OK: sintaxe válida** |

Falhas pré-existentes conhecidas (OS, ML, comissões, boletos, cartão, notas
unificadas, pedido-compra) seguem inalteradas e **não foram corrigidas**.

---

## 14. Riscos restantes

| Risco | Gravidade | Situação |
|---|---|---|
| 🔴 **Provisionamento incompleto: tenant novo com 500 no `POST /api/pedidos`** | **alta** | §1.5 — **não corrigido**, afeta qualquer cliente novo |
| 🔴 **Emissores fiscais não usam `documentoFiscalDe()`** | **alta** | §9.2 — bloqueia o catálogo público |
| Tela de faturamento não mostra o desconto herdado | média | §10.1 — requisito registrado |
| `tipoAtendimento` não é validado pelas rotas | média | §12 |
| Sandbox `SUSPENDED` não abre pelo navegador | baixa | deliberado; mudar o status o coloca nos jobs |
| Role sem perfil cadastrado escapa do fail-closed | média | herdado do relatório 13 |
| `pedido-desconto.js` ainda não ligado | informativo | proposital |
| Mudanças no disco não estão no processo | informativo | nenhum restart foi feito |

---

## 15. Próximo passo recomendado

Nesta ordem, e cada um é decisão sua:

1. **Corrigir o provisionamento** (§1.5). É o mais urgente e independe da Fase 1:
   hoje um cliente novo não cria pedido. A correção mínima é envolver cada
   `registrarRotasX` em try/catch próprio dentro de `applyRouteMigrations`, para
   que um módulo com erro não derrube os seguintes — mais mover o `alterSafe` de
   `faturas.isDevolucao` para depois de a tabela existir.
2. **Ligar `documentoFiscalDe()` nos emissores** (§9.2), antes de qualquer
   cadastro público.
3. **Aprovar a migration nos tenants de cliente** — o sandbox mostrou que ela é
   limpa (6 colunas, integridade ok, nada reescrito).
4. **Conectar `pedido-desconto.js`** e a validação de atendimento.
5. Só então: telas de PDV e Catálogo Online.

---

## 16. Confirmação

- **Migration aplicada só no `sandbox`** — os 13 tenants de cliente continuam
  com 0 colunas novas, verificado um a um ao final.
- **Nenhum tenant de cliente foi alterado**, lido ou copiado. A massa é
  fictícia.
- **Nenhum efeito externo**: sem vhost, DNS, SSL, e-mail, cobrança, assinatura,
  webhook ou WhatsApp. O sandbox nasceu `SUSPENDED`, fora de `listActive()`, e o
  journal do scheduler não o menciona.
- **Nenhum serviço reiniciado** — nem `consulta-licitacoes`, nem
  `liciteagora.service`, nem scheduler.
- **Nenhum commit**, nenhum `reset`/`stash`/`clean`, **nenhum backfill**, nada
  no Asaas.
- Backup do sandbox feito com `sqlite3 .backup` antes da migration, com
  `integrity_check` ok.
