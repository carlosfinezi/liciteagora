# O que saiu do CLAUDE.md por estar velho

Texto preservado como estava no CLAUDE.md até 02/10/2026. NÃO descreve o estado
atual. Conferido em 02/10/2026:

- os 7 módulos "untracked" e as pastas `farmacia/`, `locacao/`, `posto/` e
  `restaurante/` estão rastreados (`git ls-files`); a reorganização e o registro
  dos módulos entraram em `e582d8f` e `e9920e3` (17/09/2026);
- o `ligarWatchdogCatalogo` está no HEAD (`scheduler.js:172` e `:1182`);
- o `cicloAvisoAlcadas` foi removido em 21/08/2026, e o símbolo não existe em
  nenhum .js do HEAD. O comentário da remoção está em `scheduler.js:500`.

A lição do fecho de `require` do HEAD e a pendência do `enviarAlerta` sem
granularidade continuam no CLAUDE.md.

## Frentes pendentes de commit

Levantado em 2026-08-11. **271 entradas** na árvore, agrupadas em 14 frentes.
Produção já roda tudo isso — o que falta é histórico, não deploy. Este mapa
existe para que quem retomar não tenha de redescobri-lo.

| Frente | Arq | M / novo / del | churn |
|---|---:|---|---:|
| Estoque/compras/cotações/pedidos | 48 | 28 / 20 / 0 | +7687 −619 |
| Boletos/cobrança/tesouraria | 34 | 19 / 15 / 0 | +4676 −182 |
| Portais BLL/BNC + chat/monitoramento | 33 | 20 / 13 / 0 | +4029 −1493 |
| Reorg de módulos/menu | 28 | 4 / 13 / 11 | +3722 −3095 |
| Fiscal (NF-e/NFS-e/NFC-e/DRE) | 20 | 10 / 6 / 4 | +2468 −1229 |
| Licitações/PNCP/IA | 20 | 16 / 4 / 0 | +2797 −132 |
| Governança/alçadas/aprovações | 18 | 10 / 8 / 0 | +2928 −137 |
| Notificações/comunicação | 14 | 6 / 8 / 0 | +2128 −117 |
| Comissões/RH/usuários | 13 | 5 / 8 / 0 | +3952 −149 |
| Core/infra | 13 | 13 / 0 / 0 | +322 −136 |
| OS/equipamentos | 12 | 6 / 6 / 0 | +2186 −364 |
| Patrimônio/contábil | 10 | 1 / 9 / 0 | +2203 −3 |
| Varejo/PDV/marketplaces | 7 | 4 / 3 / 0 | +1809 −11 |
| Contratos/recorrência | 2 | 1 / 1 / 0 | +378 −4 |

### Ordem recomendada

1. **Reorg de módulos/menu primeiro e junta, com `git add -A` na frente
   inteira de uma vez.** São ~11 pares deletado→novo (`public/financeiro/` →
   `public/contabilidade/`, `public/cobranca/`, `public/fiscal/`;
   `public/configuracoes/` → `public/operacional/`, `public/fiscal/`;
   `public/rh/patrimonio.html` → `public/patrimonio/bens.html`;
   `public/fiscal/nfe-inbox.html` → `manifestador.html`). O `mover_modulos.py`
   na raiz é o script que fez isso e vai junto. Só com as duas pontas no mesmo
   commit o git detecta rename; espalhada, cada metade vira "apagado + novo" e
   o histórico perde o rastro.
2. As frentes de negócio, cada uma inteira, em qualquer ordem.
3. **Core/infra por último, ou fatiado junto de cada frente.** São 13
   arquivos modificados e só +322 linhas — os pontos de registro
   (`route-registry.js`, `role-dispatch.js`, `db-schema.js`, `plan-modules.js`,
   `features-routes.js`, `scheduler.js`, `tenant-middleware.js`). Quase toda
   frente pendura uma linha aqui, então esse grupo não commita sozinho de
   forma limpa.

### Os 7 módulos untracked que o core/infra arrasta

Commitar core/infra sozinho **deixa o HEAD sem bootar**: o `route-registry.js`
e o `db-schema.js`/`scheduler.js` da árvore já registram módulos que ainda não
estão no git. Fecho transitivo (fecha em 7, não explode):

```
chat-monitor-config.js          <- db-schema.js, chat-monitor-routes.js
chat-monitor-routes.js          <- route-registry.js
comprasnet-mensagem-routes.js   <- route-registry.js
notificacoes-routes.js          <- route-registry.js
resultado-item-routes.js        <- route-registry.js
governanca-avisos.js            <- scheduler.js
os-notificacoes.js              <- scheduler.js
```

Eles vêm de 6 frentes diferentes. Levá-los junto do core/infra faz o HEAD
bootar, mas descola cada um da sua frente (`governanca-avisos.js` sem o
`governanca-routes.js` que o chama, `os-notificacoes.js` sem o `os-routes.js`)
— troca uma inconsistência gritante por seis silenciosas. Preferir commitar as
frentes antes.

**Ao commitar qualquer frente, verifique o fecho de requires do HEAD, não o da
árvore.** Foi exatamente esse erro que deixou o HEAD quebrado entre b2bacdb e
e094c43: o levantamento leu a versão da árvore do `scheduler.js`, que já não
tinha o jornal, e não viu o `require('./jornal-scheduler')` que seguia vivo no
HEAD.

### Commits parciais em aberto

`route-registry.js` (aecb543) e `scheduler.js` (e094c43) estão no HEAD em
versão **parcial**: entraram só as linhas que removem o jornal, montadas
direto no índice via `git hash-object` + `git update-index`, sem tocar a
árvore. Ambos seguem modificados e devem ir inteiros junto do core/infra. O
que ficou de fora está listado no corpo de cada commit.

### Três pendências que saem daqui

1. **A fiação do watchdog do catálogo está viva em produção mas fora do git.**
   O `scheduler.js` da árvore ganhou `ligarWatchdogCatalogo()` e
   `_dbParaAlertaMaster()` — a vigilância das engines do catálogo criada em
   6c485a7 depois de o `resultados-backfill` ter morrido calado por 4 dias. O
   `catalog-watchdog.js` está commitado; **quem o liga, não**. O commit
   parcial e094c43 deixou isso de fora de propósito. Enquanto não for
   commitado, o histórico não explica por que o watchdog existe nem quem o
   inicia, e um `git checkout` do HEAD produz um sistema com o watchdog morto.
2. **`enviarAlerta` não tem granularidade por tipo de aviso — é tudo ou nada
   por canal, por tenant.** O `notificacoes-dispatcher.lerCanais` lê três
   chaves globais (`alerta_canal_telegram`, `alerta_canal_email`,
   `alerta_email_destinatarios`) e despacha para todo canal ligado, sem olhar
   o conteúdo. O `logTag` (ex.: `'Alcada'`) chega até o ponto da decisão e só
   é usado em `console.error` — o dado para filtrar já viaja até lá, falta a
   decisão. Consequência concreta: o tenant `reimac` desligou o Telegram e
   ligou o email; passa a receber por email o aviso de alçada que nunca pediu,
   sem poder recusar só esse. **O padrão que resolve já existe neste repo**:
   `os-notificacoes.js` usa `os_notificacoes_config(evento, canal, template,
   ativo)`, uma linha por par evento×canal, e o `dispatchNotificacoes`
   consulta as regras ativas do evento antes de enviar. Falta generalizar
   para fora de OS. Não mexido — decisão do usuário.
3. **`participacoes_comprasnet`: 31.737 ocorrências** de `[Alerta] Erro ao
   verificar disputas: no such table` — ver o primeiro item de "Pendências
   conhecidas" abaixo. Continua não investigado.

## Pendência que estava em "Pendências conhecidas"

- **`cicloAvisoAlcadas` passa a mandar mensagem no próximo restart do
  `liciteagora.service` — ninguém foi avisado disso** (anotado 2026-08-11).
  O `scheduler.js` da árvore de trabalho ganhou um ciclo de 6 em 6 horas
  (`ALCADA_AVISO_INTERVAL_MS`) que varre todos os tenants via
  `governanca-avisos.avisarExpirando` e dispara aviso de aprovação prestes a
  vencer. Hoje não roda: o `scheduler.js` em memória é o antigo. **O primeiro
  restart liga o envio**, e o mesmo vale para o watchdog do catálogo
  (`_dbParaAlertaMaster` → primeiro tenant com Telegram ativo).

  Quem receberia, levantado nos bancos em 2026-08-11:

  | Tenant | Canal | Destino |
  |---|---|---|
  | `1bit` | Telegram ativo, token ok | chat **1594299485** (id positivo = conversa privada, não grupo) |
  | `reimac` | Telegram **desligado** (`alerta_canal_telegram=0`), email ligado | **werick@reimac.com.br** — cliente externo |
  | outros 9 | sem `telegram_config`, email off | ninguém (`sendTelegram` devolve false) |

  O `1bit` não tem a chave `alerta_canal_telegram` gravada e o default do
  `notificacoes-dispatcher.lerCanais` é **ON** — canal ligado por omissão, não
  por escolha. O único destino externo é o email do `reimac`.

  Amortecedor: `aprovacoes` com `status='pendente' AND consumida=0 AND
  expiraEm IS NOT NULL` = **0 em todos os 11 tenants** nessa data. Com a fila
  vazia o primeiro ciclo não manda nada — mas isso é estado de dado, não
  garantia: basta uma aprovação nascer para o envio começar. Cada aprovação
  avisa uma vez só (`avisoExpiracaoEm`).
