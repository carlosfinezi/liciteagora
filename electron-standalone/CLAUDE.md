# ⛔ LEIA ANTES DE MEXER — Electron Standalone (Comprasnet token/hCaptcha)

Este módulo **regride em ciclo**. Toda vez que alguém "conserta o hCaptcha da renovação"
mexendo no retoken, o problema volta. Este arquivo existe para **parar o ciclo**. Leia-o
inteiro antes de tocar em `server-sync.js`, `auto-login.js` ou `portals/comprasnet/`.

## A VERDADE (medida, não teoria)

Telemetria real do 1bit (`electron_eventos`, tenant DB — NÃO journald), 2026-07-02:

| evento | total histórico |
|---|---|
| `retoken-http-ok` (retoken funcionou) | **0** |
| `retoken-http-fail` | **850** |
| `reload-keepalive` (o que REALMENTE renova o Bearer) | **1492** |

- **O retoken NUNCA funcionou. Zero sucessos.** Node = 401 (não manda cookie de sessão);
  webview fetch = status 0 "Failed to fetch" (CORS no PUT cross-origin p/ cnetmobile).
  As duas vias são becos sem saída conhecidos. **Não gaste tempo no retoken.**
- **A renovação do token é 100% via RELOAD do webview.** Isso é por design e funciona.
- **hCaptcha NA RENOVAÇÃO = PERFIL FLAGRADO, não bug de código.** Com o perfil limpo, os
  reloads renovam o Bearer silenciosamente (hCaptcha invisível). O perfil flagra por:
  (a) **builds/updates repetidos** — "8 builds em 1 dia flagraram o perfil e travaram o
  login"; (b) logins falhos acumulados.

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
- `server-sync.js` — keepalive / retoken / reload / ssoMorto.
- `auto-login.js` — fluxo de login gov.br (passos SSO, hCaptcha).
- `portals/comprasnet/integration.js` — `onSSODead` / auto-recuperação de perfil.

Contexto detalhado: memórias `project_electron_reload_keepalive_hcaptcha`,
`project_electron_relogin_cookie_clear`, `project_electron_reload_keepalive_hcaptcha`.
