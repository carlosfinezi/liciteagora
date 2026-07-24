# Extensão: sync imediato ao iniciar/recarregar

## Problema
Ao instalar ou recarregar a extensão, leva até 2 minutos para o primeiro sync de disputas. Durante esse tempo, a tela `lances.html` não mostra Melhor/Nosso nos itens.

## Causa
O sync é agendado via `chrome.alarms` com `SYNC_INTERVAL_MIN = 2`. Na primeira execução, o alarm só dispara após 2 minutos. Não há sync imediato ao iniciar.

## Solução proposta
1. Executar `executarSync()` imediatamente ao iniciar o service worker (após verificar que tem bearer)
2. Manter o alarm de 2 min para syncs subsequentes
3. Opcionalmente: ao detectar que `disputasCache` está vazio no servidor, a extensão deve forçar sync imediato

## Arquivos relevantes
- `extensions/token-relay/background.js` — `SYNC_INTERVAL_MIN`, `executarSync()`, inicialização do service worker
- `sniper-lance-routes.js` — `disputasCache`

## Impacto
UX ruim ao recarregar extensão durante uso ativo (ex: antes de licitação). Dados ficam desatualizados por até 2 min.
