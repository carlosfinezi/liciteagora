# Restart controlado da Fase 0 — backup, execução e validação

Data: 2026-09-10, 18:13 → 18:25 BRT.
Base: [`09`](09-pre-restart-fase0.md) (auditoria pré-restart).
Autorização: restart de **`consulta-licitacoes.service`, e somente dele**.

> **Resultado: sucesso.** Serviço no ar, PID novo, zero erros, rollback não foi
> necessário. Nenhum outro serviço tocado. Nenhum commit, nenhuma migration,
> nenhum backfill.

---

## 1. Verificação prévia (18:12)

| Item | Valor | Situação |
|---|---|---|
| Serviço alvo | `consulta-licitacoes.service` | confirmado |
| PID anterior | **263220** | — |
| ActiveState / SubState | `active` / `running` | saudável |
| Início anterior | **2026-09-09 15:43:57 -03** | `NRestarts=0` |
| HEAD | **5ec3474** | inalterado |
| Working tree | 163 entradas | inalterado |

**Nenhum dos 5 arquivos críticos mudou depois da auditoria 09** — os mtimes são
exatamente os registrados lá:

```
2026-09-09 16:06:05  pcp-proposta.js
2026-09-09 16:06:12  pcp-routes.js
2026-09-10 14:16:56  pedido-politicas.js
2026-09-10 16:20:03  contas-receber-routes.js
2026-09-10 17:10:48  pedidos-routes.js
```

E varri **os 320 arquivos do fecho de `require` do `server.js`**: nenhum foi
modificado após as 17:52 (horário da auditoria 09). No working tree inteiro, só
mudaram o relatório 09 e os logs que os serviços vivos escrevem
(`server.log`, `bll-session.log`, `licitanet-collector.log`).

**Verificação limpa → autorizado a prosseguir.**

---

## 2. Backup

**Diretório:** `/home/carlosfinezi/backups/pre-restart-fase0-20260910-181331/`
(472 KB — só os 5 arquivos, sem bancos, sem uploads, sem dado de cliente).

### 2.1 O problema que o backup precisava resolver

Copiar o working tree **não** representa a versão em execução: os 5 arquivos já
estavam alterados em disco. Para haver rollback real era preciso a versão que o
processo **leu no boot**, e ela não estava em lugar óbvio.

**Achado que resolveu o caso:** existe um backup do Hestia,
`/backup/carlosfinezi.2026-09-09_22-18-41.tar`, gerado em **09/09 22:18** — ou
seja, **depois** do start do processo (15:43) e **antes** de todas as edições da
Fase 0 (10/09 14:16, 16:20 e 17:10). Dentro dele, `web/liciteagora.com.br/
domain_data.tar.zst` (5,4 GB) contém a árvore do projeto.

### 2.2 O que foi possível reconstruir — e o que não foi

| Arquivo | Versão em memória | Evidência |
|---|---|---|
| `pedido-politicas.js` | ✅ **recuperada** | mtime preservado no tar: **26/08 16:58**, anterior ao start. Hash **difere** do disco atual |
| `contas-receber-routes.js` | ✅ **recuperada** | mtime **21/08 17:51**. Hash difere do disco |
| `pedidos-routes.js` | ✅ **recuperada** | mtime **26/08 17:00**. Hash difere do disco |
| `pcp-routes.js` | ❌ **NÃO reconstruível** | mtime no tar: **09/09 16:06** — o backup pegou a versão **nova**. Hash **idêntico** ao disco atual |
| `pcp-proposta.js` | ❌ **NÃO reconstruível** | idem |

A prova dos dois lados é objetiva e foi feita por hash: os três da Fase 0
**diferem** do disco (logo são a versão anterior); os dois do PCP são
**idênticos** ao disco (logo o backup não tem a versão de memória).

**Por que os do PCP não são reconstruíveis:** foram modificados em 09/09 16:06,
uma janela que fica **depois** do start (15:43) e **antes** do backup (22:18).
Não existe backup do `carlosfinezi` nessa janela — o anterior a 09/09 não existe
na retenção. E o mtime só guarda a **última** modificação: não há como provar
que entre o commit do HEAD e as 16:06 não houve outra edição. **Não inventei uma
reconstrução.**

Como paliativo documentado, salvei `git show HEAD:pcp-*.js` em
`head-5ec3474-aproximacao-pcp/`, com um LEIA-ME que diz o que ele é: **rollback
funcional, não fiel** — restaurar o HEAD desfaria a frente PCP inteira, inclusive
o que já rodava antes do restart. A distância medida entre HEAD e a versão em
memória é de 81 linhas (`pcp-routes.js`) e 35 (`pcp-proposta.js`).

**Avaliação de impacto, feita antes de prosseguir:** isso **não** compromete a
capacidade de recuperar o serviço — havia caminho de rollback para os dois
(HEAD), e o risco de precisar dele era baixo (boot já validado). Compromete a
*fidelidade* do rollback do PCP, que é um módulo de portal e não toca pedidos nem
financeiro. Por isso segui.

### 2.3 Estrutura e hashes

```
pre-restart-fase0-20260910-181331/
├── MANIFESTO.md
├── current-disk-version/            ← o que o restart carregou
│   ├── contas-receber-routes.js   7e270fab489e…
│   ├── pcp-proposta.js            80b41060f0eb…
│   ├── pcp-routes.js              581f5b30253c…
│   ├── pedido-politicas.js        b9287e9d9144…
│   └── pedidos-routes.js          f11066ca7b2f…
├── before-restart-running-version/  ← o que estava em memória (PID 263220)
│   ├── LEIA-ME.txt
│   ├── contas-receber-routes.js   07d4d388d3ea…
│   ├── pedido-politicas.js        4c0365067a65…
│   └── pedidos-routes.js          de2d2bf6792b…
└── head-5ec3474-aproximacao-pcp/    ← aproximação, NÃO a versão em memória
    ├── LEIA-ME.txt
    ├── pcp-proposta.js
    └── pcp-routes.js
```

O `MANIFESTO.md` traz timestamp, HEAD, PID anterior, início anterior, hashes
completos, origem de cada cópia e a separação por frente (Fase 0 × PCP).

---

## 3. Teste de boot antes do restart

| Verificação | Resultado |
|---|---|
| `node --check` nos 5 arquivos | **OK** nos 5 |
| `pcp-edital-download.js` existe | **sim** — 7.265 bytes, 09/09 10:02 |
| Requires relativos quebrados no fecho (319 arquivos) | **nenhum** |
| Carga dos 5 módulos em processo isolado | **OK** nos 5 |
| `npm run verify` | **OK: sintaxe válida** |

Nenhuma falha → restart autorizado.

---

## 4. Restart

```
systemctl restart consulta-licitacoes.service
```

**Somente este serviço.** Nenhum outro comando `systemctl` de escrita foi
executado.

| | Antes | Depois |
|---|---|---|
| **PID** | 263220 | **2052694** |
| **Início** | 2026-09-09 15:43:57 | **2026-09-10 18:21:19** |
| ActiveState / SubState | active / running | **active / running** |
| NRestarts | 0 | **0** |
| `/health` | 302 | **302** (8 ms) |

Uptime anterior encerrado limpo: *"Deactivated successfully. Consumed 2h 19min
50.704s CPU time"* — sem sinal, sem timeout.

### 4.1 Journal do boot

- **Erros (`-p err`) desde o restart: 0**
- Ocorrências de `unhandled` / `Cannot find module` / `SyntaxError` / `TypeError`
  / `FATAL` / `EADDRINUSE`: **0**

Sequência de boot íntegra:

```
[catalog-pg] pool inicializado (max=10)
[servicos] Tabelas fiscais carregadas: 917 NBS, 335 cTribNac
[Auth] Rotas públicas registradas (/api/login, /api/logout)
[restaurante] Cardápio público registrado (pré-auth)
[FeatureGate] 75 prefixos protegidos por flag de tenant
[Integrações] Rotas registradas (portais: bnc, bll, pcp)
[PCP] Rotas registradas (/api/pcp/seus-pregoes, …, /api/pcp/proposta/*, /api/pcp/lances/*)
[worker] Servidor rodando em http://localhost:3000
[worker] ROLE=worker — HTTP-only (nenhum scheduler rodando aqui)
[Sniper] Instância criada para tenant "crsolucoes"   (tenants abrindo normalmente)
```

Os únicos avisos são `[AutoLance] Cache vazio: …` e `[BLL-Engine] motor em
repouso` — **os mesmos que já apareciam antes do restart**, sem relação com esta
frente.

---

## 5. Smoke tests

### 5.1 Contra o processo vivo (somente leitura)

Via `X-Api-Key` do tenant `1bit`, com `Host: 1bit.liciteagora.app`:

| # | Teste | HTTP | Observação |
|---|---|---|---|
| A | `GET /health` | **302** | sem auth, como sempre |
| A | `GET /api/usuarios/me` com chave inválida | **401** | autenticação rejeitando corretamente |
| B | `GET /api/pedidos?limit=2&page=1` | **200** | devolveu pedidos reais, paginado |
| B | `GET /api/pedidos/resumo` | **200** | `total: 29`, por status |
| C | `GET /api/produtos?limit=2` | **200** | catálogo respondendo |
| D | `POST /api/produtos/disponibilidade` | **200** | leitura pura, não grava |
| E | `GET /api/contas-a-receber?limit=2` | **200** | financeiro respondendo |
| — | **`GET /api/pcp/pregoes`** | **200** | ver 5.2 |

Nota: `/health` devolve 404 quando se força `Host` de tenant; no acesso normal
(sem esse header) responde 302, igual a antes. Não é regressão — é o roteamento
por host. `GET /api/financeiro/contas-financeiras` deu 404 porque esse caminho
não existe; a rota certa (`/api/contas-a-receber`) respondeu 200.

### 5.2 A prova de que o processo carregou o código novo

`GET /api/pcp/pregoes` respondeu **200 com dados reais**. Essa rota **foi criada
em 09/09 16:06** e **não existia** na versão que estava em memória — se o
processo ainda tivesse o código antigo, teria devolvido 404.

É evidência empírica direta, e não apenas o argumento por mtime.

### 5.3 Comportamento da Fase 0 (banco descartável)

Os itens F a J foram validados pelas suítes, em `/tmp`, **sem tocar em tenant de
cliente** — conforme sua instrução. As suítes exercitam exatamente os arquivos
que agora estão em memória:

| # | Item | Teste | Resultado |
|---|---|---|---|
| F | `registrar-pagamento` → **410**, sem alterar dados | `RP1`, `RP2`, `RP3` | ✅ 410; não altera `valorPago`; não cria CR nem movimentação; audita a tentativa |
| G | quantidade negativa → **422** | `QT5` | ✅ total intacto em 200 |
| H | frete negativo → **422** | `FR3` | ✅ nada gravado |
| I | decimal em produto fracionável aceito | `QT2`, `LM5` | ✅ `2.5 KG`, `0.5`, `1.25` |
| J | decimal em unidade inteira → **422** | `LM4` | ✅ `1.5 UN` recusado |

Suítes completas, executadas **após** o restart:
`test-app-backend.js` **79 ok, 0 falhas** · `test-fase0-pagamento-pedido.js`
**15 ok, 0 falhas**.

**Por que não testei o 410 contra a produção:** aquele endpoint grava uma linha
em `audit_log` do tenant. Seria escrita no banco de produção, e a instrução era
não alterar o banco. E não existe teste discriminante seguro para frete e
quantidade contra produção: se o código fosse o antigo, a chamada **gravaria** o
valor inválido num pedido real. A prova ficou em `/api/pcp/pregoes` (§5.2) mais
as suítes.

---

## 6. Estabilidade e demais serviços

Às 18:24, ~3 minutos depois do restart:

| | |
|---|---|
| ActiveState / SubState | `active` / `running` |
| PID | 2052694 (o mesmo — não houve respawn) |
| NRestarts | **0** — sem crash loop |
| `/health` | **302** |
| Erros no journal | **0** |

**Nenhum outro serviço foi reiniciado** — os horários de início provam:

| Serviço | Início | Situação |
|---|---|---|
| `liciteagora.service` (scheduler) | **2026-09-02 09:40:24** | **intacto** |
| `bll-session.service` | 2026-09-03 06:53:11 | intacto |
| `licitanet-collector.service` | 2026-09-10 16:29:23 | intacto (anterior a este trabalho) |
| `nginx` | 2026-09-04 06:38:05 | intacto |

---

## 7. Rollback

**Não foi necessário.** Nenhum arquivo foi restaurado. O backup permanece
disponível em `/home/carlosfinezi/backups/pre-restart-fase0-20260910-181331/`.

Se vier a ser preciso, a ordem é a do relatório 09: identificar o arquivo pelo
erro, restaurar **só ele** de `before-restart-running-version/` (Fase 0) ou de
`head-5ec3474-aproximacao-pcp/` (PCP, com a ressalva do §2.2), e reiniciar
**somente** `consulta-licitacoes.service`. Nada de `git reset`.

---

## 8. Banco de dados

- **Nenhuma migration, nenhum `UPDATE`, nenhum backfill executado por mim.**
- O `data/tenants/1bit/pncp.db` tem mtime **18:09**, anterior ao restart.
- O `audit_log` do `1bit` tem como registro mais recente uma ação de **09/09
  14:18** — nenhuma linha originada desta operação.
- O journal do boot não relata nenhuma DDL (`ALTER TABLE` / `CREATE TABLE` /
  migração): **0 ocorrências**.
- Os `-wal` são escritos pela operação normal da aplicação (sniper, scan de
  alertas, cache) — isso é a aplicação viva funcionando, não alteração minha.

---

## 9. O que ficou em vigor

**Fase 0:**

- vendedor restrito **não define preço** — corpo ignorado, item avulso 422,
  resolver indisponível 422, auditoria `preco-manual-ignorado`;
- `valorFrete` negativo → **422**, mais a guarda no `recalcularTotal`;
- quantidade: `> 0`, finita, **≤ 1e9**, até **4 casas**, inteira em unidade não
  fracionável;
- `sincronizarPagamentoPedido` enxerga a CR ligada por `pedidoId` — loja virtual
  **e faturamento de OS**;
- `POST /api/pedidos/:id/registrar-pagamento` → **410 Gone**.

**Frente PCP (não é nossa, subiu junto):**

- download registrado do edital antes da proposta, com erro explicativo;
- itens de edital por lote; rotas `/api/pcp/pregoes` e silenciar pregão —
  **confirmada funcionando** com dados reais.

---

## 10. Riscos ainda pendentes

| Risco | Estado |
|---|---|
| **Correção de pagamento não vale no polling do Asaas** | o polling roda no `scheduler.js` (`liciteagora.service`, no ar desde 02/09), que **não** foi reiniciado. O webhook do Asaas está sendo rejeitado por token inválido, então é o polling que baixa de fato. Decisão separada |
| Token do webhook Asaas inválido | bug próprio, anterior a esta frente. Não corrigido |
| 4 pedidos, R$ 10.036,00, com `valorPago = 0` | backfill **não autorizado**, não executado |
| Mudanças do PCP sem teste automatizado | subiram e respondem; validação real depende de uso no portal |
| Versão em memória do PCP não reconstruível | ver §2.2 — rollback do PCP seria funcional, não fiel |
| Unidade de medida é texto livre | resolver de verdade pede migration; documentado no relatório 08 |
| PDV/NFC-e aceita preço e desconto do navegador | intocado |

---

## 11. Confirmação

- **Restart executado:** apenas `consulta-licitacoes.service`, uma única vez.
- **Não reiniciados:** `liciteagora.service`/scheduler, `bll-session`,
  `licitanet-collector`, `nginx` — horários de início comprovam.
- **Banco de produção:** não alterado por mim; sem migration, sem backfill.
- **Git:** nenhum commit; nenhum `reset`, `stash` ou `clean`; as 163 entradas do
  working tree seguem intactas.
- **Arquivos de aplicação:** nenhum alterado nesta operação. O backup foi
  gravado fora da árvore, em `/home/carlosfinezi/backups/`.
