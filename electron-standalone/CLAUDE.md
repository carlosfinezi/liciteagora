# ⛔ LEIA ANTES DE MEXER — Electron Standalone (Comprasnet token/hCaptcha)

Este módulo **regride em ciclo**: toda vez que alguém "conserta o hCaptcha" mexendo na
renovação ou no perfil, o problema volta. Leia este arquivo antes de tocar em
`electron-browser.js`, `server-sync.js` ou `portals/comprasnet/`.

## 🛡️ O guard é o ponto de entrada

`verify-comprasnet-invariants.js` lista as proibições, cada uma com o porquê, e **trava o
build** se alguma for violada. Ele cobre: as flags anti-hCaptcha, stealth JS, wipe de perfil
(`rmSync` em Partitions, `wipeAndRelaunch`, `profile-recovery`, `clearStorageData` com
cookies), retoken, `webviewNoLogin`, o fluxo do `reauth.js`, o gravador de rede fora do
Comprasnet e a URL `www`. Antes de mexer, leia o guard; o que ele reprova não se repete aqui.

- Rode `npm run verify:comprasnet` antes e depois de mexer, e builde por
  **`npm run build:win:nsis`**, cujo `prebuild` roda o guard. O `build:linux` e o
  electron-builder chamado direto **não** passam por ele.
- O guard reprova por **nome** (regex sobre o código sem comentários). A mesma coisa
  reintroduzida com outro nome passa calada, e é por isso que as regras abaixo continuam escritas.
- `portals/bnc/` e `portals/bll/` podem mudar à vontade: o guard só protege o núcleo Comprasnet.
- Referência do padrão correto: a build ESTÁVEL v1.0.0 do cliente em
  `private/electron-standalone-REFERENCE-v1.0.0-comprasnet-stable.zip` (`resources/app.asar`; gitignored).

## ⚠️ Regra de ouro: o device-trust do `acesso.gov.br` é sagrado

As flags do Chromium (`AutomationControlled` + `ignore-gpu-blocklist`, no topo de
`electron-browser.js`) fazem o hCaptcha passar invisível, mesmo em perfil recém-limpo. O que o
traz de volta é destruir o cookie de device-trust do `acesso.gov.br`. Stealth JS por cima das
flags piora, porque cria fingerprint inconsistente. A história completa (5.2.18 errada, 5.2.19 e
5.2.20) está nas mensagens dos commits `847acd5`, `9413d88` e `5148a8c`.

Captura 100% autônoma: **nada manual, nunca**.

Duas regras que o guard **não** cobre e que valem igual:

1. **O re-login não apaga cookie do `acesso.gov.br`.** Ele usa só `limparSessaoComprasnet`
   (`portals/comprasnet/auto-login.js`), que remove cookie a cookie apenas os do
   `comprasnet.gov.br`. O guard não reprova um `cookies.remove` do `acesso.gov.br` escrito à mão.
2. **Não apagar o perfil por caminho nenhum.** Nem `.electron-profile`, nem `%APPDATA%`, nem
   "limpar ao trocar de versão", nem por um nome de função que o guard não conhece.

## Renovação do Bearer

É re-auth SSO pelo `portals/comprasnet/reauth.js` (authorize → `dispensa_eletronica.asp` →
cnetmobile), disparado pelo keepalive do `server-sync.js` quando o token passa de 4 min. Ficar
parado no `loginPortal.asp` é o repouso normal entre re-auths, e não sessão morta. Sem Bearer
novo em 90 s, cai em ssoMorto e no re-login cirúrgico.

## ✅ Se o hCaptcha voltar, é regressão de código

1. Rode `npm run verify:comprasnet`.
2. Compare com a build de referência.
3. **Não** "resolva" apagando perfil nem acrescentando retoken ou stealth. Isso É o ciclo.

## Validar um deploy pela telemetria

Em `data/tenants/1bit/pncp.db`, e não no journald. Saudável é: `electron_heartbeat.versao`
novo, `ssoMorto=0`, `tokenAgeSec` oscilando baixo, `bearer_history` com `expEm` diferente a
cada ~6 min (limiar de 4 min, conferido pelo keepalive de 2 em 2 min), evento `reauth-sso`
recorrente e nenhum `sso-morto-login-page`.

## Arquivos-mina

- `electron-browser.js`: as flags do topo.
- `portals/comprasnet/auto-login.js`: `limparSessaoComprasnet`.
- `portals/comprasnet/reauth.js` e `server-sync.js`: keepalive, renovação e ssoMorto.
- `portals/comprasnet/integration.js`: `onSSODead`, que só faz `reviverSSO` + `attemptAutoRelogin`.

O `auto-login.js` da raiz desta pasta não é carregado por nada nem entra no pacote
(`build.files` do `package.json`). Quem conta é o de `portals/comprasnet/`.

Contexto detalhado: memória `project_electron_hcaptcha_captura_definitivo` (definitiva) +
`project_electron_relogin_cookie_clear`.
