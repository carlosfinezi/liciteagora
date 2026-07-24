# electron-bnc/ — DEPRECATED (2026-05-15)

Este diretório foi **descontinuado** na refatoração multi-portal de
maio/2026. Toda a funcionalidade do app `LiciteAgora BNC` foi portada
para o binário unificado `electron-standalone/`, ativável via flag
`--portal=bnc`.

## Onde foi parar cada arquivo

| Antes (electron-bnc/) | Agora (electron-standalone/) |
|---|---|
| `electron-bnc.js` (main) | dispatch dentro de `electron-browser.js` (fork por `--portal`) |
| `bnc-login.js` (snippet) | `portals/bnc/auto-login.js` |
| `bnc-cookie-sync.js` | `portals/bnc/cookie-sync.js` |
| `server-bridge.js` | `portals/bnc/server-bridge.js` |
| `nav.html` | `electron-nav-bnc.html` (cópia do nav.html principal + `partition="persist:bnc"`) |
| `store.js` | `electron-standalone/store.js` (compartilhado) |
| `assets/` | `electron-standalone/assets/` |

## Por que NÃO foi deletado

1. Fonte de comparação caso o portal BNC quebre depois do refactor —
   `git diff` entre os dois pode mostrar regressões sutis.
2. Builds antigos (`LiciteAgora-BNC-Setup.exe`) ainda referenciam estes
   arquivos no instalador. Se algum cliente ainda tem o app separado
   instalado, precisa de migração explícita antes de remover.
3. Profile separado em `%APPDATA%\LiciteAgora BNC` (do app antigo) NÃO
   é compatível com o novo `.electron-profile-bnc` do unificado —
   cookies precisam ser regerados via novo login.

## Como rodar BNC no binário unificado

```bash
# Em desenvolvimento
cd electron-standalone
electron --no-sandbox electron-browser.js --portal=bnc

# Build Windows (mesmo .exe, atalho com flag)
LiciteAgora-Browser.exe --portal=bnc
# OU (NSIS): cria atalho separado "LiciteAgora BNC" com argumento --portal=bnc
```

## Quando deletar este diretório de vez

- Quando todos os clientes que usavam o app BNC separado tiverem migrado
  pro binário unificado E o portal BNC do unificado estiver estável em
  produção por pelo menos 1 mês sem rollback.
- Atualizar `electron-standalone/INSTRUCOES.txt` reforçando o fluxo novo.
- Remover entradas em qualquer configuração de installer/Task Scheduler
  que aponte pra `LiciteAgora-BNC-Setup.exe`.

Histórico no git: `git log --all --follow -- electron-bnc/` antes de remover.
