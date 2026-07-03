# ⛔ LEIA ANTES DE MEXER — Electron Standalone (Comprasnet token/hCaptcha)

Este módulo **regride em ciclo**. Toda vez que alguém "conserta o hCaptcha da renovação"
mexendo no retoken, o problema volta. Este arquivo existe para **parar o ciclo**. Leia-o
inteiro antes de tocar em `server-sync.js`, `auto-login.js` ou `portals/comprasnet/`.

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

## A VERDADE sobre o retoken (medida, não teoria)

Telemetria real do 1bit (`electron_eventos`, tenant DB — NÃO journald), 2026-07-02:

| evento | total histórico |
|---|---|
| `retoken-http-ok` (retoken funcionou) | **0** |
| `retoken-http-fail` | **850** |
| `reload-keepalive` (o que REALMENTE renova o Bearer) | **1492** |

- **O retoken NUNCA funcionou. Zero sucessos.** Node = 401 (não manda cookie de sessão);
  webview fetch = status 0 "Failed to fetch" (CORS no PUT cross-origin p/ cnetmobile).
  As duas vias são becos sem saída conhecidos. **Não gaste tempo no retoken.**
- **A renovação do token é 100% via RELOAD do webview.** Isso é por design e funciona —
  **desde que o stealth esteja ativo** (senão o reload cai no hCaptcha visível).

## BASELINE ESTÁVEL

`server-sync-v4.0.3.js` (neste diretório) = versão consolidada. **Zero retoken**, renovação
só por reload (keepalive 60s + main.asp + reload). Era estável. Quando em dúvida, o alvo é
voltar a esse modelo simples, NÃO adicionar mais retoken.

## ❌ O QUE NÃO FAZER (causa a regressão)

1. **NÃO mexa no retoken** (`retokenHTTP` / `retokenWebview` / `getCookieHeaderCnetmobile`).
   Nunca funcionou (0/850). É a armadilha nº 1. Se for simplificar, **remova** o retoken e
   use reload-only (estilo v4.0.3) — menos código, menos regressão.
2. **NÃO rebuilde/redeploye por impulso.** Cada build+update pode flagrar o perfil → hCaptcha.
   Junte TODAS as mudanças em **um único build testado**. Nunca faça N builds no mesmo dia.
3. **NÃO recarregue páginas do Comprasnet** fora do keepalive (aciona hCaptcha).
4. **NÃO limpe o cookie do `acesso.gov.br`** no re-login (mata o SSO — [[project_electron_relogin_cookie_clear]]).
5. **NÃO troque de versão sem apagar `.electron-profile`** (perfil velho c/ falhas flagra hCaptcha).

## ✅ QUANDO O hCAPTCHA APARECER (recuperação, NÃO "conserto de código")

1. Login manual na janela do Electron (resolver hCaptcha + senha).
2. Se persistir: fechar o Electron, **apagar `%APPDATA%\LiciteAgora Browser`** (perfil limpo
   → hCaptcha invisível), reabrir e logar.
3. **NÃO** responda a um hCaptcha adicionando/alterando código de retoken. Isso é o ciclo.

## PROCESSO OBRIGATÓRIO antes de qualquer mudança aqui

1. **Ler este arquivo.**
2. **O código do Electron NÃO está no git** (`server-sync.js` = uncommitted; `auto-login.js`
   = untracked). Sem baseline não há como saber o que regrediu. **Commitar + taggovernar a
   versão boa ANTES de mudar.**
3. Mudança em **1 build testado**, nunca por impulso (ver regra 2 acima).
4. **Validar por telemetria pós-deploy** (`electron_eventos` no tenant DB): o esperado é
   `retoken-http-ok` subir de 0, `reload-keepalive`/hCaptcha caírem. `bearer_history` mostra
   captura a cada ~8 min quando saudável. `electron_heartbeat.ssoMorto`=1 = travado.

## Arquivos-mina (mexer = risco alto de regressão)
- `electron-browser.js` (flags no topo: `AutomationControlled` + `ignore-gpu-blocklist`) —
  é isto que evita o hCaptcha. NÃO remover. NÃO adicionar injeção de stealth JS por cima.
- `portals/comprasnet/auto-login.js` (`limparSessaoComprasnet` cirúrgico) — re-login NÃO
  pode apagar o cookie do acesso.gov.br (device-trust).
- `server-sync.js` — keepalive / retoken / reload / ssoMorto.
- `auto-login.js` — fluxo de login gov.br (passos SSO, hCaptcha).
- `portals/comprasnet/integration.js` — `onSSODead` / auto-recuperação de perfil.

Contexto detalhado: memórias `project_electron_reload_keepalive_hcaptcha`,
`project_electron_relogin_cookie_clear`, `project_electron_reload_keepalive_hcaptcha`.
