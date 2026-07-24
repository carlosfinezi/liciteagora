# Plano de construção — Coletor de Marca do Licitanet

> Especificação para o desenvolvedor. **Não altera o que já está pronto no servidor** —
> descreve só a peça que falta (lado cliente) e como ativar/validar.
> Documento gerado 2026-07-07.

## Status

- ✅ Servidor: parser + gravação (`licitanet-marca.js`) — FEITO e testado
- ✅ Servidor: endpoints (`electron-routes.js`) — FEITO e **vivos** (401 sem key)
- ✅ Cliente: Abordagem A implementada (5.2.28) — `electron-standalone/portals/licitanet/`
  (`index.js` = job de janela oculta + 2 chamadas in-page; `server-bridge.js` = fila/ata).
  Wired em `electron-browser.js` (require + `licitanetCollector.start` após loadFile). ⏳ falta
  VALIDAR end-to-end na máquina do cliente (a chamada in-page é engenharia reversa).
- ⛔ `licitanet.com.br` bloqueia o IP do servidor (403) — por isso roda no Electron do cliente

---

## 1. Contexto e problema

O BI mostra a **marca do vencedor** por item, lida de `resultados_bi.marcaFabricante`
(Postgres, catálogo `liciteagora_catalog`). O PNCP **não** fornece marca. Para os portais
**BLL/BNC** já existe coletor rodando. Para o **Licitanet**, a marca está no relatório
**"Extrato de Ata"** — mas há um bloqueio de acesso.

**Comprovado — é bloqueio de IP:** `licitanet.com.br` devolve **HTTP 403** para o IP do
servidor. Testado com `curl`, `Node` e **Google Chrome headless real** — todos 403. Não é
fingerprint TLS (senão o Chrome real passaria); é reputação de IP de datacenter no WAF AWS.
Já o **CloudFront do Licitanet** (`*.cloudfront.net/reports/…`) **não** bloqueia: o servidor
baixa normal (200).

**Consequência:** as 2 chamadas de API que geram/descobrem a URL do relatório precisam
sair de um **IP diferente** (residencial). O download + parse + gravação roda no servidor.

---

## 2. O que JÁ está pronto no servidor (não mexer, só usar)

### `private/licitanet-marca.js` — núcleo testado
- `processarAtaUrl({cnpj, ano, sequencial, ataUrl})` — baixa a URL do CloudFront, parseia o
  HTML, mapeia cada item ao `numeroItem` canônico (via descrição) e grava a marca **só onde
  está vazio** (nunca sobrescreve). Filtra lixo ("cf edital", "Serviço").
- `getProcessId(cnpj, ano, sequencial)` — deriva o `processId` do Licitanet do nome do edital
  no PNCP (`{processId}_editais_*.zip`).
- CLI de teste: `--ata` e `--processid` (ver seção 5).

### `private/electron-routes.js` — 2 endpoints (self-auth via `X-Api-Key`, pré-auth)
- `GET /api/electron/licitanet/pendentes?limit=N` → `{ pendentes: [{cnpj, ano, sequencial, processId, objeto}] }`.
  Lista licitações Licitanet homologadas, com marca faltando, que aparecem em grupos de
  palavras; já deriva o `processId`.
- `POST /api/electron/licitanet/ata` body `{cnpj, ano, sequencial, ataUrl}` → chama
  `processarAtaUrl`; retorna `{ok, status, itensAta, mapeados, gravados}`.

**Chave de join (importante):** o `id` do item na API do Licitanet **é igual ao `numeroItem`
do PNCP** (ex.: HD 10TB = item id `7181638`). O parser usa a **descrição** (idêntica à do
edital) como chave — não precisa de CNPJ. O número "Item" que aparece no relatório é só de
exibição (1..69) — **não** usar como numeroItem.

---

## 3. O que FALTA construir (a peça do desenvolvedor)

O **lado cliente**, que roda num **IP residencial** e faz as 2 chamadas ao `licitanet.com.br`.
Escolher **uma** das duas abordagens.

### Abordagem A — dentro do Electron do cliente (recomendada; grátis; cobre 1bit hoje)

O app `private/electron-standalone/` já roda no Chromium do cliente (IP residencial) e já
acessa portais. Adicionar um job:

1. `GET {SERVER}/api/electron/licitanet/pendentes?limit=10` (header `X-Api-Key`) → recebe a
   fila com `processId`.
2. Para cada pendente, carregar `https://licitanet.com.br/sessao/{processId}` num webview e
   executar as 2 chamadas **no contexto da página** via `webContents.executeJavaScript(...)`.
3. `POST {SERVER}/api/electron/licitanet/ata` (header `X-Api-Key`) body
   `{cnpj, ano, sequencial, ataUrl}` → servidor baixa, parseia e grava.

**Por que executar no contexto da página:** o SPA do Licitanet (Laravel/Inertia) injeta
sozinho os headers `x-xsrf-token` (do cookie), `x-csrf-token` e `x-browser-fingerprint` em
toda requisição same-origin. Rodando o `fetch` de dentro da página, **não é preciso
reconstruir token nenhum** — cookies e headers vão automáticos.

As 2 chamadas (executar in-page, nesta ordem):

```js
// (1) gera o relatório "Extrato de Ata"
const g = await fetch(`/report/${processId}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  body: JSON.stringify({ relatorio: 'RELATORIO_EXTRATO_ATA', dados: '' })
}).then(r => r.json());        // → { identifier: "<reportId>" }

// (2) resolve a URL do CloudFront
const d = await fetch(`/report/${g.identifier}/download/2`, {
  headers: { 'X-Requested-With': 'XMLHttpRequest' }
}).then(r => r.json());        // → { url: "https://…cloudfront.net/reports/pregao/…html" }

return d.url;
```

- Rate-limit do `/report`: **60/min**. Ir devagar (≈1 req/s).
- O `reportId` é **estável** por (processo, tipo) — pode cachear.
- Tipo `RELATORIO_EXTRATO_ATA` é o que tem Marca/Modelo (há outros: `RELATORIO_LOTES_ADJUDICADOS`,
  `RELATORIO_RESULTADO_PARCIAL`).
- `apiKey` e URL do servidor: reaproveitar o que o Electron já usa em `/api/electron/credentials`.

### Abordagem B — proxy residencial, tudo no servidor (cobre todos os tenants; custo de proxy)

Com um proxy residencial (ex.: Bright Data/Smartproxy, cobrança por GB), o servidor faz tudo:

- Roteia só as requisições ao `licitanet.com.br` pelo proxy (o resto — CloudFront/PNCP/Postgres — direto).
- `GET /sessao/{processId}` pelo proxy para estabelecer sessão (cookie `XSRF-TOKEN`) e ler o
  CSRF; depois `POST /report` + `GET /download` com `x-xsrf-token` (= valor URL-decoded do
  cookie) + `x-requested-with`.
- Chamar `processarAtaUrl` local. Vira um backfill contínuo no scheduler, análogo ao
  `marca-portal-backfill.js` do BLL/BNC (mesma disciplina de rate-limit e tabela de controle).

| Abordagem | De onde saem as 2 chamadas | Custo | Cobertura |
|---|---|---|---|
| **A — Electron** | IP residencial do cliente | grátis (já existe) | tenants com Electron (hoje 1bit) |
| **B — Proxy** | proxy pago, chamado pelo servidor | ~US$/GB | todos os tenants |

**Recomendação:** começar por **A** (grátis, cobre o 1bit, que é quem usa NAS). Migrar/ampliar
para **B** se quiser cobrir todos sem depender do Electron. Parser e gravação já servem os dois.

---

## 4. Ativação (ops)

- Os endpoints `/api/electron/licitanet/*` são servidos pelo **worker** `consulta-licitacoes.service`
  (= `server.js`), **não** pelo scheduler. Precisam de **restart desse serviço** para entrar no
  ar. Boot ≈60–90s. **Confirmar antes** (pode haver tenant em uso).
- (Opcional, robustez) criar tabela de controle
  `marca_licitanet_backfill (cnpj, ano, sequencial, status, itens_gravados, tentativas, data_cache)`
  para não reprocessar e permitir retry — mesmo padrão do `marca_portal_backfill`.

---

## 5. Como validar

Servidor (já dá pra testar hoje, sem o Electron):

```bash
# deriva o processId do PNCP
sudo -u carlosfinezi node licitanet-marca.js --processid 18449132000160 2026 21
# esperado → processId Licitanet: 176262

# baixa a ata do CloudFront, mapeia e mostra o plano (sem gravar)
sudo -u carlosfinezi node licitanet-marca.js --ata 18449132000160 2026 21 \
  'https://dv7rs78smtpx8.cloudfront.net/reports/pregao/176262/completo_relatorio_extrato_ata_15251272241.html' --dry
# esperado → 59 itens; item 38 → numeroItem 7181638 → WD / SATA RED NAS
```

Cliente (após implementar): pegar 1 pendente de `/pendentes`, rodar as 2 chamadas in-page,
`POST` em `/ata`, e conferir no BI que a coluna Marca preencheu para aquele processo.

---

## 6. Gotchas

- **Não reconstruir tokens manualmente** na Abordagem A — rodar o `fetch` no contexto da
  página do Licitanet resolve cookies/CSRF/XSRF/fingerprint sozinho.
- O "Item" do relatório de ata é o número de **exibição** (1..69), não o `numeroItem`. O
  mapeamento correto é por **descrição** (já implementado).
- **Nunca sobrescrever** marca existente — o servidor já garante via
  `WHERE marcaFabricante IS NULL OR = ''`.
- Filtrar marca-lixo ("cf edital", "Serviço", "conforme edital") — já implementado.
- Rate-limit `/report` = 60/min; ir devagar para não tomar 429/ban.
- O `linkSistemaOrigem` que o PNCP guarda para Licitanet
  (`portal.licitanet.com.br/acesso-visitante/<token>`) **expira (404)** — não usar. Usar
  `sessao/{processId}` com o `processId` de `getProcessId`.
- Licitanet **não** tem `usuarioNome` fixo (o publicador varia: Fiorilli, IMAP…). O
  identificador do portal é só o `linkSistemaOrigem`.

---

**Fluxo completo quando o cliente estiver pronto:** Electron pega a fila em `/pendentes` →
chama `/report/{processId}` + `/report/{id}/download/2` no IP residencial → devolve a `ataUrl`
em `/ata` → servidor baixa do CloudFront, parseia e grava. Núcleo validado no processo real
176262 (item 38 = WD).
