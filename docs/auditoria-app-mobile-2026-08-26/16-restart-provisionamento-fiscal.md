# Ativação das correções de provisionamento e documento fiscal

Data: 2026-09-11, 08:19 → 08:23 BRT · Ativação de [`15`](15-provisionamento-e-documento-fiscal.md).

> **Resultado: sucesso.** Serviço no ar com PID novo, zero erros, rollback não
> foi necessário. Migration da Fase 1 **não** aplicada nos clientes. Nenhum
> outro serviço reiniciado. Nenhum commit, backfill ou alteração no Asaas.

---

## 1. Pré-check (08:19)

| Serviço | PID | Start | NRestarts | Estado |
|---|---|---|---|---|
| `consulta-licitacoes.service` | **3085545** | 2026-09-11 06:18:47 | 0 | active/running |
| `liciteagora.service` | **3085849** | 2026-09-11 06:18:49 | 0 | active/running |

**Idênticos aos registrados no relatório 15** — nenhum restart externo desde
então. `/health` respondia 302; zero erros no journal dos dois desde 06:18.

---

## 2. Testes antes do restart

### 2.1 Sintaxe e carga dos 8 arquivos modificados

| Verificação | Resultado |
|---|---|
| `node --check` nos 8 | **OK** nos 8 |
| `require` real em processo isolado | **OK** nos 8 — `tenant-provision`, `route-registry`, `db-schema`, `faturas-routes`, `comissoes-routes`, `pessoa-sem-documento`, `nfe-emit-routes`, `boleto-orchestrator` |
| Requires relativos quebrados no fecho (**321** arquivos) | **nenhum** |
| `npm run verify` | **OK: sintaxe válida** |

A carga do `route-registry.js` era a mais sensível — 124 chamadas foram
reescritas para o wrapper `R(...)`. Carregou limpo.

### 2.2 Suítes

| Suíte | Resultado |
|---|---|
| `test-provisionamento-tenant-novo` | **15 OK, 0 falhas** |
| `test-documento-fiscal` | **16 OK, 0 falhas** |
| `test-app-backend` | 79 OK, 0 falhas |
| `test-fase1-desconto-origem` | 57 OK, 0 falhas |
| `test-fase1-rollout-parcial` | 10 OK, 0 falhas |
| `test-fase0-pagamento-pedido` | 15 OK, 0 falhas |

Nenhuma falha nova → autorizado a prosseguir.

---

## 3. Backup

**`/home/carlosfinezi/backups/pre-restart-provisionamento-20260911-082133/`**
(352 KB, 19 arquivos, sem nenhum banco).

| Pasta | O que é |
|---|---|
| `em-disco/` | os 8 arquivos + 3 scripts, no estado que o restart carregou |
| `head-5ec3474/` | os 7 rastreados, na versão do commit HEAD |
| `ROLLBACK.md` | procedimento e as ressalvas |

**Honestidade sobre o rollback**, registrada no `ROLLBACK.md`: `head-5ec3474/`
é **aproximação, não a versão em memória** — restaurar de lá desfaz também
alterações preexistentes da árvore que já rodavam. A fonte **fiel** é o backup
do Hestia `/backup/carlosfinezi.2026-09-10_22-20-41.tar` (ontem 22:20, anterior
a todas as correções de hoje), com duas ressalvas medidas: ele tem
`faturas-routes.js` **antes** da herança de desconto (editada ontem 23:22) e
**não tem** `pessoa-sem-documento.js` (criado ontem 23:21).

Não extraí o tar preventivamente — os 8 módulos carregaram sem erro e o fecho
de 321 arquivos não tem require quebrado, então a chance de precisar era baixa;
a extração leva ~5 min e pode ser feita na hora.

---

## 4. Restart

```
systemctl restart consulta-licitacoes.service
```

**Somente este serviço.**

| | Antes | Depois |
|---|---|---|
| **PID** | 3085545 | **3310892** |
| **Start** | 2026-09-11 06:18:47 | **2026-09-11 08:21:57** |
| ActiveState / SubState | active / running | **active / running** |
| NRestarts | 0 | **0** |
| `/health` | 302 | **302** (13 ms) |

### Journal do boot

- **Erros (`-p err`): 0**
- `unhandled` / `Cannot find module` / `SyntaxError` / `TypeError` / `FATAL` /
  `EADDRINUSE`: **0**

```
[worker] Servidor rodando em http://localhost:3000
[worker] ROLE=worker — HTTP-only (nenhum scheduler rodando aqui)
```

**Todos os 8 arquivos têm mtime anterior a 08:21:57 — estão em vigor.**

---

## 5. Smoke test (somente leitura em tenant real)

| Rota | HTTP |
|---|---|
| `GET /health` (sem auth) | **302** |
| `GET /api/usuarios/me` com chave inválida | **401** |
| `GET /api/pedidos?limit=2` | **200** |
| `GET /api/produtos?limit=2` | **200** |
| `POST /api/produtos/disponibilidade` | **200** (leitura pura) |
| `GET /api/contas-a-receber?limit=2` | **200** |
| `GET /api/pessoas?q=teste` | **200** |
| `GET /api/faturas?limit=2` | **200** |

Nenhuma escrita em tenant real. O 404 do `/health` com `Host` de tenant forçado
é o comportamento já documentado do roteamento por host; sem esse header, 302.

---

## 6. Provisionamento limpo pós-restart — `sandbox6`

Criado pelo mecanismo oficial já corrigido, **sem nenhum script de completar
schema**, e com o mesmo desenho de segurança: **SUSPENDED** (fora de
`listActive()` ⇒ invisível a todos os jobs), **sem vhost, sem SSL, sem DNS, sem
e-mail, sem cobrança, sem webhook**.

> Nota de método: o `sandbox6` foi criado pelo **script**, não pela rota
> `POST /api/admin/tenants` do control plane. A diferença entre os dois é
> **apenas** o `spawnProvisionVhost` — que mexe em nginx e Let's Encrypt e está
> fora do permitido. O `applyRouteMigrations` executado é exatamente o mesmo.

### Schema

| | |
|---|---:|
| Tabelas | **364** (antes das correções: 277) |
| `pedidos` | **43 colunas** (antes: 20) |
| Divergência vs `1bit` | **1 tabela** — `fatura_itens` sem `vBCIcms`/`vBCST`, colunas órfãs que **não existem em nenhum `.js`** do repositório |

| Verificação | Resultado |
|---|---|
| `pedidos.vendedorId` | ✅ |
| `pedidos.depositoId` | ✅ |
| Endereço de entrega | **10/10 campos** |
| Frete (`tipoFrete`, `valorFrete`, `transportadoraId`) | ✅ |
| Financeiro (4 tabelas) | ✅ |
| Estoque (4 tabelas) | ✅ |
| CRM (4 tabelas) | ✅ |
| Comissões (2) · Metas (2) · Faturas (2) | ✅ |
| Usuários/perfis (4 tabelas) | ✅ — 3 usuários, 2 perfis |
| **`falhasDeMigracao`** | **zero** |

As 16 tabelas ausentes são de subsistemas que dependem de uso (WhatsApp,
sniper, Comprasnet, `email_log`, `stone_config`) — nenhuma do núcleo comercial.

### Teste funcional — 15/15

Cliente · produto · **pedido** · item · confirmar · **reserva** ·
disponibilidade · entrega · **faturar** · financeiro · escopo de vendedor ·
permissões · SELECT nas 15 tabelas centrais.

**Nenhum 500.** O caso 5 é justamente o que falhava antes
(`table pedidos has no column named vendedorId`).

---

## 7. Teste fiscal

`test-documento-fiscal.js` — **16 OK, 0 falhas**, sem disparar nenhuma
integração externa.

| Verificação | Resultado |
|---|---|
| CPF válido continua aceito | ✅ |
| CNPJ válido continua aceito | ✅ |
| `SD-*` nunca vira documento | ✅ |
| `UASG-*` nunca vira CPF/CNPJ | ✅ |
| `EX-*` / `TARIFA-*` nunca viram documento | ✅ |
| **String alfanumérica que daria 11/14 dígitos após limpeza** | ✅ recusada — `UASG-12345678901`, `EX-12345678000199`, `TARIFA-11144477735` |
| NF-e não monta tag fiscal falsa | ✅ a tag simplesmente não é emitida |
| Identificador nunca sobra com 11/14 dígitos (20.000 gerações) | ✅ |

### Boleto/Pix — a guarda em ação

Reproduzindo a guarda inserida em `boleto-orchestrator.js`, **sem rede**:

```
SD-44f7337…          BARRADO: Este cliente (Diego) foi cadastrado sem CPF/CNPJ…
UASG-12345678901     BARRADO: Este cliente (Prefeitura) foi cadastrado sem CPF/CNPJ…
EX-NICSRS            BARRADO: Este cliente (Fornecedor) foi cadastrado sem CPF/CNPJ…
TARIFA-asaas         BARRADO: Este cliente (Tarifa) foi cadastrado sem CPF/CNPJ…
11144477735          ENVIA documento 11144477735
```

### ⚠️ Mudança de comportamento para cadastros legados — verificada

A guarda passa a **barrar** emissão de boleto/Pix para `UASG-*`, `EX-*` e
`TARIFA-*`. Antes, esses valores iam ao provedor e voltavam como rejeição de API.

**Verifiquei se algum deles emite boleto hoje: nenhum.** Consultei os 6 tenants
com movimento, cruzando `pessoas` de documento não convencional com
`contas_a_receber` e `boletos` — **zero ocorrências**. A mudança não quebra
nenhum fluxo em uso; troca uma rejeição obscura do provedor por uma mensagem
que diz o que fazer.

---

## 8. Impacto nos tenants existentes

| Verificação | Resultado |
|---|---|
| Colunas da Fase 1 nos 13 clientes | **0** — nenhuma apareceu |
| `pedidos` nos clientes | **43 colunas**, como antes |
| Schema alterado pelo boot | **não** — `raeldouglas` mantém mtime de 01/09 |
| Comunicação externa disparada no boot | **0** |
| Webhooks | não alterados |
| Backfill | **nenhum** |

Por que o boot não altera schema de cliente: as correções mudam a **ordem** das
migrations e a 2ª passada do `db-schema` roda **só no provisionamento**, não no
boot. Os mtimes de 06:18 nos bancos são do restart anterior (o do Hestia) e da
operação normal da aplicação.

---

## 9. Serviços não reiniciados

| Serviço | Start | Situação |
|---|---|---|
| `liciteagora.service` (scheduler) | 2026-09-11 06:18:49 | **intacto** |
| `bll-session.service` | 2026-09-11 06:18:49 | intacto |
| `licitanet-collector.service` | 2026-09-11 07:29:38 | intacto |
| `nginx` | 2026-09-11 06:18:52 | intacto |
| `postgresql` | 2026-05-23 12:37:03 | intacto |

Apenas `consulta-licitacoes.service` foi reiniciado, uma única vez.

---

## 10. Estabilidade e regressão pós-restart

Às 08:23, ~1 min após o restart: `active`, PID 3310892 (sem respawn),
`NRestarts=0`, `/health` 302, **0 erros**.

`npm run verify` OK · `test-app-backend` **79 OK** ·
`test-fase1-desconto-origem` **57 OK** · `sandbox-seed-e-testes` **26 OK** ·
`test-fase1-rollout-parcial` **10 OK** — todas 0 falhas.

---

## 11. Riscos restantes

| Risco | Gravidade | Situação |
|---|---|---|
| **Scheduler ainda com o código antigo** | média | `liciteagora.service` segue de 06:18. Ele não provisiona tenant, mas carrega `db-schema`, `faturas-routes` e `boleto-orchestrator` — a guarda de documento no boleto **não vale no polling** até ele reiniciar |
| Duplicação boot loop × provisionamento | média | a lista dos 4 módulos existe em dois lugares; comentada no código |
| 212 ALTERs ainda no lugar errado no `db-schema` | média | a 2ª passada os resolve; a causa estrutural permanece |
| `vBCIcms`/`vBCST` órfãs no `1bit` | baixa | não vêm de código |
| NFC-e e NFS-e leem documento do corpo | média | não alcançadas por `pessoas`; precisarão de `documentoFiscalDe` quando o catálogo público gerar NFC-e |
| 5 sandboxes (`sandbox2`…`sandbox6`) | baixa | SUSPENDED, sem vhost; ocupam disco e podem ser removidos |
| Fase 1 não está nos clientes | por decisão | §12 |

---

## 12. Recomendação sobre liberar a migration da Fase 1

**Recomendo liberar — com rollout em duas etapas.**

O que sustenta a recomendação:

1. **A migration é aditiva e já foi exercitada de verdade.** 6 colunas, só
   `ALTER TABLE ADD COLUMN`, nenhuma tabela recriada, nenhum dado reescrito.
   Aplicada no `sandbox` com `integrity_check` ok antes e depois, e **nenhum
   pedido existente mudou de total**.
2. **O rollout parcial está provado.** `test-fase1-rollout-parcial` (10 OK)
   exercita um banco no schema **antigo** ponta a ponta — inclusive faturar, que
   é onde `descontoDoPedido` é chamado. Nenhum 500.
3. **O código que consome as colunas continua desligado.** Só
   `descontoDoPedido` está em uso, e é tolerante. Aplicar a migration não muda
   comportamento nenhum — só prepara o terreno.
4. **O bloqueador que existia foi removido hoje**: o provisionamento corrigido
   está em vigor, então um tenant novo nasce completo.

Etapas sugeridas:

- **Etapa 1** — aplicar em **um** tenant de baixo movimento (`crsolucoes`, TRIAL
  e vazio, ou `labfiscal`, seu e quase vazio). Conferir `integrity_check` e
  rodar um pedido de ponta a ponta.
- **Etapa 2** — se limpo, aplicar nos demais, um a um, com backup
  (`sqlite3 .backup`) antes de cada.

**Duas coisas devem vir antes de o desconto ser efetivamente usado**, e nenhuma
é da migration: definir **os percentuais das faixas de alçada** (sem eles o
fail-closed deixa o limite em 0%) e conectar `pedido-desconto.js` às rotas.

**Uma ressalva sobre o scheduler:** enquanto o `liciteagora.service` não
reiniciar, a guarda de documento no boleto não vale no polling. Como nenhum
cadastro legado emite boleto hoje (§7), isso não é urgente — mas é decisão sua,
e carrega o efeito conhecido de ligar o `cicloAvisoAlcadas`.

---

## 13. Confirmação

- **Migration da Fase 1 NÃO aplicada nos clientes** — 0 colunas, verificado um
  a um depois do restart.
- **Nenhum tenant de cliente alterado**; nenhum schema mudou pelo boot.
- **Somente `consulta-licitacoes.service` reiniciado.** `liciteagora.service`,
  scheduler, nginx e postgresql intactos.
- **Nenhum commit**, nenhum `reset`/`stash`/`clean`, **nenhum backfill**, nada
  no Asaas.
- Nenhuma comunicação externa disparada; o `sandbox6` nasceu SUSPENDED e sem
  vhost.
