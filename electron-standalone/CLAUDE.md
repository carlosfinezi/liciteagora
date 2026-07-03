# ⛔ LEIA ANTES DE MEXER — Electron Standalone (Comprasnet token/hCaptcha)

Este módulo **regride em ciclo**. Toda vez que alguém "conserta o hCaptcha da renovação"
mexendo no retoken, o problema volta. Este arquivo existe para **parar o ciclo**. Leia-o
inteiro antes de tocar em `server-sync.js`, `auto-login.js` ou `portals/comprasnet/`.

## 🛡️ GUARD AUTOMÁTICO (rode/builde por aqui)

`verify-comprasnet-invariants.js` codifica as regras abaixo e **trava o build** se violadas.
- Buildar SEMPRE via **`npm run build:win:nsis`** (o `prebuild` roda o guard). Não chame o
  electron-builder direto sem rodar `npm run verify:comprasnet` antes.
- **BNC/BLL/outros portais podem mudar à vontade** — o guard só protege o núcleo Comprasnet
  (`electron-browser.js` flags, `server-sync.js` renovação, `portals/comprasnet/*`). Mudanças
  em `portals/bnc/` ou `portals/bll/` não disparam o guard.
- Padrão de referência: build ESTÁVEL v1.0.0 do cliente em
  `private/electron-standalone-REFERENCE-v1.0.0-comprasnet-stable.zip` (`resources/app.asar`; gitignored).

## 🔴 A CAUSA-RAIZ REAL (2026-07-03, confirmada com a build ESTÁVEL v1.0.0)

O cliente enviou a build estável funcional (`LiciteAgora-Browser-versao-estavel-login-automatico.zip`,
`resources/app.asar`). Comparação direta com o código atual revelou a verdade:

- **A build estável evita o hCaptcha SÓ com flags do Chromium** — nada de JS:
  `disable-blink-features=AutomationControlled` (remove navigator.webdriver no MOTOR) +
  `ignore-gpu-blocklist` (WebGL) + UA limpo + `www.comprasnet.gov.br`. **Não existe
  `stealth-preload.js` na estável.** Essas flags **já estão idênticas no código atual**.
- Logo, o hCaptcha **NÃO** é fingerprint faltando. O que faz o hCaptcha voltar é
  **destruir o device-trust do `acesso.gov.br`** (cookie que faz o hCaptcha passar
  invisível). E o que destruía o trust em loop era o **wipe automático de perfil** que o
  refactor 5.x adicionou (wipe na troca de versão + escalonamento `wipeAndRelaunch` +
  `clearStorageData(cookies)` no SSO morto). 124 `profile-clear-giveup` numa noite.

**Tentativa ERRADA (5.2.18, revertida):** restaurei o `stealth-preload.js` achando que era
a regressão. Injetar JS redefinindo `navigator.webdriver` POR CIMA da flag do motor cria
inconsistência detectável → transformou o hCaptcha visível-resolvível num invisível-travado.

**Fix correto (5.2.19):**
1. **Removido** todo o stealth-preload/injeção (volta ao flags-only da estável).
2. **Removido** o wipe automático de perfil (startup version-wipe, `profile-recovery.js`
   inteiro, `resetProfileComprasnet`, `clearStorageData(cookies)` do SSO morto). Nunca mais
   apagar o cookie do `acesso.gov.br`.
3. `www.comprasnet.gov.br` (igual à estável).

⚠️ **Regra de ouro:** o device-trust é sagrado. NUNCA fazer wipe total de perfil nem
`clearStorageData` com `cookies`. Re-login usa só `limparSessaoComprasnet` (cirúrgico, apaga
apenas cookies do comprasnet.gov.br, preserva acesso.gov.br). Se o hCaptcha aparecer mesmo
assim → **UM login manual** re-semeia o trust; depois os reloads renovam invisível.
NÃO reintroduzir stealth JS: as flags do Chromium já bastam.

## CAPTURA CONTÍNUA = re-auth SSO (não retoken) — v5.2.20

A renovação do Bearer é **100% via re-auth SSO** (`portals/comprasnet/reauth.js`), o mesmo
fluxo de 3 passos da build estável ("como o Lancer faz"):
1. `loadURL` em `sso.acesso.gov.br/authorize` (SSO vivo → redireciona sem hCaptcha),
2. `dispensa_eletronica.asp` → extrai `compras-id` → navega ao **cnetmobile**,
3. a request ao cnetmobile carrega o Bearer NOVO → o **interceptor captura** (bearer-interceptor.js
   chama `resetAguardando`). Volta ao loginPortal (repouso).

`executarKeepalive` (server-sync.js) dispara isso quando o token passa de `RETOKEN_THRESHOLD_MS`
(4 min; TTL 9 min). Telemetria: evento `reauth-sso` a cada ciclo; `bearer_history` novo a cada ~4min.

- **O `retoken` (endpoint /sessao/fornecedor/retoken) foi REMOVIDO (5.2.20). NUNCA funcionou
  (0/850):** Node = 401 (não manda cookie de sessão); webview-fetch = "Failed to fetch" (CORS
  cross-origin). Não reintroduza.
- **NÃO** tratar "webview parado no loginPortal.asp" como sessão morta (`webviewNoLogin→ssoMorto`,
  removido): ficar no loginPortal é o REPOUSO NORMAL entre re-auths. Aquilo inundava
  `sso-morto-login-page` e matava sessão saudável (bug que travou a captura contínua no 5.2.19).
- Se o re-auth não trouxer Bearer novo em 90s (`AGUARDANDO_TIMEOUT_MS`) → ssoMorto → re-login
  cirúrgico (preserva trust). Sem wipe, sem passo manual.

## ❌ O QUE NÃO FAZER (é o que causa a regressão — o guard trava tudo isto)

1. **NÃO reintroduzir retoken** (`retokenHTTP`/`retokenWebview`). Removido no 5.2.20. Nunca
   funcionou (0/850). Renovação é via re-auth SSO (`reauth.js`), ponto.
2. **NÃO fazer wipe de perfil** — nem `rmSync(Partitions)`, nem `clearStorageData` com
   `cookies`, nem `wipeAndRelaunch`, nem "apagar `.electron-profile`/`%APPDATA%` ao trocar de
   versão". Apagar o perfil **destrói o device-trust do `acesso.gov.br`** → é o que CAUSA o
   hCaptcha. (Era a antiga "recuperação" que rodava em loop — 124 giveups numa noite.)
3. **NÃO reintroduzir stealth JS** (`stealth-preload`). As flags do Chromium já bastam;
   stealth por cima cria fingerprint inconsistente (regressão 5.2.18).
4. **NÃO tratar "webview no loginPortal" como sessão morta** (`webviewNoLogin→ssoMorto`). É o
   repouso normal entre re-auths.
5. **NÃO limpar o cookie do `acesso.gov.br`** no re-login. Re-login usa só
   `limparSessaoComprasnet` (cirúrgico — [[project_electron_relogin_cookie_clear]]).

## ✅ SE O hCAPTCHA VOLTAR (é regressão de código, não "recuperação")

Com as flags + trust preservado, o hCaptcha passa **invisível sozinho** (provado 2026-07-03:
login OK sem prompt mesmo em perfil recém-limpo). Se ele voltar a aparecer:
1. Rode `npm run verify:comprasnet` — provavelmente alguma invariante foi violada.
2. Diff contra a build de referência (`private/electron-standalone-REFERENCE-v1.0.0-comprasnet-stable.zip`).
3. **NÃO** "resolva" apagando perfil nem adicionando retoken/stealth. Isso É o ciclo.
   Nada manual — o objetivo do software é captura 100% autônoma.

## PROCESSO OBRIGATÓRIO antes de qualquer mudança aqui

1. **Ler este arquivo.** O núcleo Comprasnet está no git (commits `fix(electron)` até 5.2.20).
2. **Rodar `npm run verify:comprasnet`** antes e depois; buildar via `npm run build:win:nsis`
   (dispara o guard). Um build testado, sem impulso.
3. **Validar por telemetria pós-deploy** (`data/tenants/1bit/pncp.db`, NÃO journald): saudável =
   `electron_heartbeat.versao` novo, `ssoMorto=0`, `tokenAgeSec` oscila baixo (reseta),
   `bearer_history` com `expEm` diferente a cada ~6min, evento `reauth-sso` recorrente,
   `sso-morto-login-page` ausente.

## Arquivos-mina (mexer = risco alto de regressão)
- `electron-browser.js` (flags no topo: `AutomationControlled` + `ignore-gpu-blocklist`) —
  é isto que evita o hCaptcha. NÃO remover. NÃO adicionar injeção de stealth JS por cima.
- `portals/comprasnet/auto-login.js` (`limparSessaoComprasnet` cirúrgico) — re-login NÃO
  pode apagar o cookie do acesso.gov.br (device-trust).
- `server-sync.js` — keepalive / retoken / reload / ssoMorto.
- `auto-login.js` — fluxo de login gov.br (passos SSO, hCaptcha).
- `portals/comprasnet/integration.js` — `onSSODead` / auto-recuperação de perfil.

Contexto detalhado: memória `project_electron_hcaptcha_captura_definitivo` (definitiva) +
`project_electron_relogin_cookie_clear`.
