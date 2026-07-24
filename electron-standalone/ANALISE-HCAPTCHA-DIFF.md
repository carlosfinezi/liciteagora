# Análise: perda de device-trust / hCaptcha — Estável v1.0.0 vs Multi-portal 5.2.x

Data: 2026-07-07. Objetivo: documentar por que o Comprasnet do **multi-portal** perde o
device-trust do `acesso.gov.br` a cada reinício (pede hCaptcha "toda santa vez"), enquanto o
**estável v1.0.0** (`LiciteAgora-Browser-versao-estavel-login-automatico.zip`) loga sozinho e
o trust persiste.

## Sintoma exato
- **Multi-portal:** pede hCaptcha. Após resolver manualmente + logar (bearer capturado com
  sucesso), ao **fechar e reabrir** (sem update) o trust **não fica salvo** → pede de novo.
- **Estável v1.0.0:** loga sozinho, trust persiste entre reinícios, nunca pede hCaptcha.

## Confirmado IGUAL nos dois (descartado como causa)
- **Chromium:** idêntico — `Chrome/146.0.7680.80` (via strings do exe estável e do electron 41.0.3).
- **Flags anti-hCaptcha:** idênticas (`disable-blink-features=AutomationControlled`,
  `ignore-gpu-blocklist`, `disable-features=IsolateOrigins,site-per-process`,
  `ignore-certificate-errors`, `lang=pt-BR`, `disable-infobars`, `no-sandbox`). Na 5.2.26 foram
  movidas pro topo (antes de `requestSingleInstanceLock`) — **não resolveu**, então a ordem não era a causa.
- **Limpeza de UA** (remove `Electron/<ver>`): idêntica.
- **Popup handler** (`setWindowOpenHandler` + `did-create-window` ocultos): idêntico. O popup
  herda a sessão do webview pai; o login SSO acontece no **webview principal**, não em popup.
- **`limparSessaoComprasnet`** (`portals/comprasnet/auto-login.js:55`): filtra correto — só
  remove cookies de `comprasnet.gov.br` (`dom.endsWith('comprasnet.gov.br')`), **preserva
  `acesso.gov.br`**; e só roda quando `opts.clearSession` é passado. **NÃO apaga o trust.**
- **Nenhum `flushStore`** em nenhum dos dois.
- **Nenhum wipe de perfil / `clearStorageData(cookies)`** (removido na 5.2.19; guard
  `verify-comprasnet-invariants.js` confirma que não voltou).

## Diferenças CONFIRMADAS entre estável e multi-portal
1. **Sessão do webview Comprasnet** (principal suspeita):
   - Estável: `<webview>` **sem `partition`** → usa a **`session.defaultSession`** (persistente).
   - Multi-portal: `<webview partition="persist:comprasnet">` → sessão persistente **nomeada**.
   - Pela doc do Electron ambas são persistentes, mas é a única diferença estrutural na área
     exata do bug (onde o cookie de trust é gravado/lido).
2. **`warmupProfile`** (só no multi-portal, `portals/comprasnet/utils.js:107`): num perfil novo,
   navega Google/gov.br/comprasnet pra "aquecer". Decide "perfil novo" checando
   `path.join(userDataDir, 'Default')` — mas a partição `persist:comprasnet` grava em
   `<userData>/Partitions/comprasnet/`, **NÃO em `Default/`**. Heurística olha o diretório errado.
3. **userData:** estável = ao lado do exe (ZIP, nunca apagado). Multi-portal ≤5.2.25 = ao lado do
   exe (apagado pelo electron-updater a CADA update → causou o "toda vez que atualiza"). 5.2.26 =
   `%APPDATA%\LiciteAgora Browser` (sobrevive a updates). **A 5.2.26 corrigiu o wipe-por-update,
   mas o trust AINDA some no fechar/reabrir → há uma segunda causa além do local do perfil.**
4. **Arquitetura:** 1 webview (estável) vs 3 webviews com partições (multi-portal).

## Hipótese principal (a validar FORA da produção)
A causa remanescente mais provável é a **partição nomeada `persist:comprasnet`**: o cookie de
device-trust do `acesso.gov.br`, gravado no webview principal, não sobrevive ao restart nessa
partição — enquanto sobrevive na `session.defaultSession` do estável.

**Correção a testar:** fazer o webview do Comprasnet usar a **sessão default (sem `partition`)**,
exatamente como o estável, mantendo BNC/BLL nas partições `persist:bnc` / `persist:bll`.
Isso mexe na área "sagrada" (interceptor de Bearer, cookie-sync e auto-login estão amarrados à
sessão do Comprasnet), então precisa ser reproduzido e validado num ambiente de teste — NUNCA
publicar direto na produção do cliente.

## Em aberto (só dá pra fechar rodando o Electron com display)
- Confirmar empiricamente ONDE em disco o cookie `acesso.gov.br` é gravado após um login no
  multi-portal (`.../Default/Cookies` vs `.../Partitions/comprasnet/Cookies`) e se ele some no
  restart. Isso decide entre a hipótese da partição e alguma outra (ex.: cookie sendo escrito
  numa sessão diferente da lida).

## Recomendação imediata (versão funcional AGORA)
Rodar o **estável v1.0.0** (é portable — extrair o zip e abrir o exe) para ter Comprasnet
funcional imediatamente. Manter o feed do multi-portal parado (está em 5.2.20, sem publicar
nada novo) até a hipótese acima ser validada em teste.
