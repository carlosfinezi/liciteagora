# Changelog

Um bloco por "fechamento" (ver CLAUDE.md). Mais recente no topo, data
AAAA-MM-DD. Registra o que mudou em produção — que aqui é esta própria
working tree.

## 2026-08-14 (3)

- **Conhecimento da IA unificado num lugar só.** Havia dois: o campo antigo
  `config.whatsapp_ai_kb` (um bloco de texto, editado pela tela de WhatsApp que
  saiu do ar na unificação) e os itens de `ia_base`. Os dois eram concatenados
  no prompt, e o antigo continuava valendo sem que ninguém pudesse vê-lo nem
  corrigi-lo pela tela
- `scripts/migrar-kb-legado.js` levou o conteúdo para itens: no `1bit`, 16.265
  caracteres viraram **7 itens**, divididos pelas quatro URLs que o texto já
  marcava com `#` e fatiados no teto de 4.000 caracteres, com a URL gravada em
  `origem`. Nenhum outro tenant tinha conteúdo. Prompt conferido depois da
  migração: mesmo conhecimento, agora com título e origem visíveis
- `buildSystemAtendimento` **parou de ler** o campo antigo, e a rota
  `/api/whatsapp/ai-config` passou a **recusar** gravação nele — gravar num
  campo que ninguém lê é pior que recusar, porque quem envia acha que a IA
  aprendeu. O valor segue no `config` só para conferência (`kbLegado`), e
  desfazer é copiar de volta

## 2026-08-14 (2)

- **Funil duplicado corrigido**: a central de Conversas nasceu com funil
  próprio (`conv_funil_etapas` + `etapaId`/`valor` na conversa) sem que eu
  tivesse checado o CRM — que já existe em Comercial → CRM · Funil, está em uso
  real (350 oportunidades, 2 funis, 19 etapas) e é bem mais completo:
  probabilidade, motivo de perda, geração de OS, atividades e itens. Dois
  quadros seriam duas verdades sobre a mesma venda
- A conversa agora **aponta para uma oportunidade do CRM** (`oportunidadeId`).
  Na ficha lateral dá para criar o card (funil e etapa default do próprio CRM,
  `fonte='whatsapp'`, cliente já vinculado) ou amarrar a um card existente; o
  quadro continua sendo o do CRM. A aba Funil saiu da central
- Ficaram órfãs nos 11 tenants a tabela `conv_funil_etapas` e as colunas
  `etapaId`/`valor`/`etapaEm` de `conv_conversas`. **Removidas em seguida**, a
  pedido, por `scripts/limpar-funil-orfao.js`: o script simula por padrão, só
  age com `--aplicar` e pula o tenant que tiver qualquer dado nessas colunas —
  dado órfão ainda é dado. Backup em `backups/db/2026-08-14-1048/` antes do
  DDL; `integrity_check` ok depois, e tenant novo já nasce sem elas

## 2026-08-14

**Loja virtual (módulo Varejo)** — catálogo público por tenant, do mesmo
catálogo que abastece o Mercado Livre:

- `loja-routes.js` novo. Vitrine pública em `/loja/` (sem login) e painel do
  lojista em Varejo → Loja virtual. Publicar produto é opt-in por produto
  (`produtos.publicadoNaLoja`): catálogo inteiro no ar por engano é vazar preço
  e linha de produto. A loja nasce desligada em todos os tenants
- Disponibilidade nunca sai como número: a vitrine mostra *disponível*,
  *últimas unidades* ou *sob consulta*, calculado como saldo **menos reservas
  ativas** — a mesma conta do resto do ERP. Quantidade exata é inteligência de
  negócio, e o concorrente também abre a vitrine
- Personalização por tokens CSS (cor, fundo, tipografia, cantos, logo) com
  prévia ao vivo e três presets — sem campo de CSS livre, que é o pedido mais
  comum e o que gera mais suporte. A cor do texto sobre o botão é calculada por
  contraste, então cor clara não vira botão ilegível
- Fase 2: login do comprador reusando o portal do cliente (mesma
  `cliente_logins`, mesma sessão), preço por tabela via `resolverPreco` do
  próprio ERP (tabela do cliente → gerais por prioridade → cadastro, com faixa
  de quantidade), carrinho no servidor e checkout criando **pedido em rascunho
  com reserva de estoque** — mesma tabela, mesma numeração, mesmo fluxo de
  conferência. Estoque é conferido no fechamento, não na exibição
- Fase 4: cobrança opcional no checkout (Pix ou boleto) pela régua do
  financeiro — conta a receber ligada ao pedido, emissão pelo provedor já
  configurado e baixa pelo webhook que já existe. Desligada por padrão
- `gerarNumero`/`recalcularTotal` passaram a ser exportados de
  `pedidos-routes.js`: duplicar a numeração noutro módulo produziria número
  repetido assim que dois pedidos nascessem juntos

**Central de conversas (módulo Comunicação)** — cinco telas com três APIs
rivais viraram uma:

- `conversas-routes.js` novo. A unidade deixou de ser "mensagem enfileirada
  para envio" e passou a ser a **conversa**: estado (aberta/pendente/resolvida),
  dono, etiquetas, não lidas e o contato do ERP do outro lado, casado pelos 8
  últimos dígitos do telefone. Tela em três colunas com a ficha do cliente
  (últimos pedidos e títulos em aberto) ao lado da conversa
- **Funil** no mesmo lugar: etapa e valor moram na própria conversa — é a mesma
  conversa vista por outro ângulo, não uma oportunidade paralela para manter em
  sincronia. Arrastar entre etapas, total por coluna, e "gerar pedido" pelo
  mesmo caminho da loja virtual
- **Base da IA em pedaços** (`ia_base`), com origem e data, entrando no prompt
  do atendimento. Toda resposta da IA ganhou um "corrigir": o atendente escreve
  o que ela deveria ter dito e aquilo vira item da base, valendo na próxima
  conversa. É o que "treinar o robô" significa num atendente de IA — o caso que
  ele errou, não prompt novo
- Desligar a IA numa conversa passou a ser definitivo até religarem (a regra
  antiga voltava sozinha em 4h), e responder pelo inbox desliga a IA: se o
  humano assumiu, o robô sai de cena
- Menu: `comunicacao`, `whatsapp`, `wa-campanhas`, `wa-simular` e `wa-agenda`
  saíram; as três primeiras redirecionam para a central via `PAGINAS_MOVIDAS`.
  `wa-campanhas` e `wa-agenda` seguem acessíveis por URL porque a central lista
  e cancela campanha, mas ainda não cria nem agenda disparo

**Dois consertos que valem por si:**

- **Inbox nunca recebeu mensagem**: o webhook só aceitava instância com prefixo
  `le_`, e a instância real do 1bit se chama `status1bit` — todo evento era
  descartado em silêncio. Agora, quando o prefixo não bate, resolve o tenant
  procurando quem declarou aquela instância em `whatsapp_config`
- **Nenhuma trava de ritmo no envio**: 25/hora, 45s entre mensagens e teto
  diário que sobe com a idade do número (40 → 90 → 180 → 300). Resposta a quem
  escreveu, resposta do atendente e confirmação de descadastro passam por fora
  da trava — segurar atendimento para "proteger o número" é o inverso do que
  protege. Mensagem segurada fica na fila com o motivo, e `/api/whatsapp/ritmo`
  mostra o quadro. A contagem diária usa dia de Brasília: com `date('now')`
  puro o contador zerava às 21h local e o teto deixava de valer no fim do
  expediente

**Fotos de produto que o Mercado Livre não conseguia baixar** (anúncio nascia
pausado em `picture_download_pending`): `public/uploads/produtos` era root-owned
e o serviço roda como carlosfinezi — nenhuma foto era gravada; e a pasta ficava
atrás do login, então o ML recebia HTML em vez de JPEG. Agora só essa pasta é
servida antes da barreira (documento em `habilitacao`, `pessoas`, `os`, `cp` e
`cr` continua exigindo login) e as imagens **sobem por upload** para o ML em vez
de passar URL. O corpo do item também se adapta à categoria (título livre ou
família), manda o GTIN do cadastro e valida no `/items/validate` antes de criar.

Commit PARCIAL em `route-registry.js`: a versão da árvore registra quatro
módulos ainda untracked (`chat-monitor-routes`, `comprasnet-mensagem-routes`,
`notificacoes-routes`, `resultado-item-routes`), e commitá-la inteira deixaria o
HEAD sem bootar. Entrou a versão do HEAD mais as duas linhas que registram
`loja-routes` e `conversas-routes`. `produto-imagens.js` foi junto por ser
exigido por `loja-routes.js` e `marketplaces-ml.js`.

## 2026-08-12 (2)

- **Marcação de falhas da análise IA** (`analise_ia_falha` + backoff no
  `analise-ia-scheduler`). A fila do scan só excluía o que estava em
  `licitacao_analise`, e essa tabela só recebe linha em caso de SUCESSO: uma
  licitação que falhava voltava à fila nas duas janelas de todo dia até
  encerrar. Medido em 2026-08-12: 285 das 432 falhas do dia (66%) eram
  reincidentes de dias anteriores, cada retentativa reenviando até 40k
  caracteres a um provider pago. Agora a falha é registrada com backoff de
  1 → 3 → 7 → 30 dias, e o portão foi posto nos dois caminhos da fila (JS no
  Postgres, `NOT EXISTS` no SQLite). Sucesso posterior limpa a marca
- **Falha sistêmica não gera backoff**: as falhas são acumuladas e só
  persistidas se o scan analisou algo (`analisadas > 0`), provando que os
  providers estavam de pé. Sem essa regra os 9 dias de DeepSeek com HTTP 402
  teriam marcado ~500 licitações, escondendo-as por dias justamente quando o
  saldo voltasse. Efeito colateral bem-vindo: o motivo da falha passa a ficar
  gravado em `analise_ia_falha.ultimoErro` — antes o ramo `else { erros++ }`
  não logava nada
- Commit PARCIAL nos dois arquivos: `db-schema.js` e `analise-ia-scheduler.js`
  já estavam modificados na árvore antes desta mudança e o `db-schema.js` da
  árvore tem `require('./chat-monitor-config')`, que segue untracked — commitar
  inteiro deixaria o HEAD sem bootar. Ficou de fora, seguindo na árvore: no
  schema, `serieDps` do fornecedor, as migrações das colunas `ufs`/`municipios`
  de `grupos_palavras` e o `require` do chat-monitor-config; no scheduler, a
  herança de UFs do grupo e o filtro por município

### Diagnóstico que motivou a mudança (nada além do acima foi alterado)

- **DeepSeek sem saldo desde 2026-08-03** (`HTTP 402: Insufficient Balance`),
  700–1050 chamadas rejeitadas por dia, 9 dias sem ninguém notar. Ele era 81%
  de toda a análise do sistema (7.406 de 9.024 desde 19/06); desde então só o
  Gemini responde, no teto do free tier — exatamente 22–26 análises/dia
- O 402 não gera cooldown nem desativa o provider (`chamarDeepSeek` só trata
  429), a lista de grupos exibe status `erro` como "ativa", e
  `ultimo_scan_mensagem` fica NULL quando as falhas são por licitação. Nada
  disso foi corrigido — só a marcação de falhas
- Consumo concentrado no tenant `reimac`: 94% das análises, com cinco grupos de
  termos genéricos. 49% dos vereditos são "incompatível". A palavra `pá` do
  grupo Jardinagem gera 1.223 candidatas (casa "Pá coletora lixo", e por
  substring no `objetoCompra` casa Maca**pá**, "**pá**ginas" de outsourcing de
  impressão, "**pá**tio")
- Simulei alternativas antes de propor: remover `pá` corta 60% do volume mas
  perde 31% das licitações compatíveis — descartado. As duas que valem mexem no
  mecanismo, não na configuração: casar palavra em vez de substring no
  `objetoCompra` (−10% de volume, −3% de oportunidade) e aplicar a exclusão nos
  itens como o BI já faz (−36% / −11%). Nenhuma das duas foi implementada

## 2026-08-12

- `public/operacional/comprasnet-monitor.html`: o botão de silenciar pregão
  volta a ser reconhecível. Ele nunca deixou de funcionar — o clique disparava
  o POST normalmente — mas no estado *não silenciado* renderizava só um ícone
  de megafone de 16px em `--text-3` sobre `--bg-2`, com `border:none`, o que no
  tema claro virou um enfeite indistinguível dos badges de contagem ao lado.
  Agora tem rótulo ("Silenciar"), borda e `--text-2`; o estado silenciado ganhou
  borda em `--danger` para manter a simetria. Corrigido nos dois pontos: o
  render do grupo e o `toggleSilenciar` que reescreve o botão
- Grupos de palavras do tenant `1bit` (dado, não código — fica registrado aqui
  porque muda o que a pesquisa enxerga): cruzamento do portfólio do
  shop.certum.eu com o catálogo apontou 78 itens vendáveis fora dos filtros.
  `CERTIFICADO SSL` (id 2) foi de 13 para 33 palavras e de 2.753 para 3.080
  itens; `ALM — Application Lifecycle` (id 11) acolheu code signing, de 8 para
  12 palavras e de 3 para 15 itens. Do +327 do grupo 2, só 71 vêm das palavras
  novas — os outros 256 já casavam as palavras antigas e não apareciam porque a
  membership materializada estava congelada desde 2026-06-08. O rebuild só
  dispara quando alguém abre a página em modo-grupo, então um grupo pouco
  visitado serve dado velho por tempo indeterminado, mesmo com o TTL de 6h
- `wildcard` sozinho respondia por 27 dos itens perdidos: o match é
  `websearch_to_tsquery('simple', …)`, sem stemming e com frase exigindo
  adjacência, então `certificado wildcard` não pega "PremiumSSL Wildcard" nem
  "CERTIFICADO DIGITAL DO TIPO WILDCARD". Mesmo efeito no plural
  (`certificados ssl` ≠ `certificado ssl`)

## 2026-08-11

- Rotinas nomeadas no CLAUDE.md: "fechamento" (com restart condicional e
  healthcheck), "fechamento 0" (sem restart, com relatório de pendência),
  "backup" e "estado"
- `.claude/settings.json` do projeto: `defaultMode: acceptEdits`, restart no
  allow por nome de unidade (`consulta-licitacoes`, `liciteagora`) e deny do que
  é destrutivo aqui (stop/disable/mask/kill, `rm`, git destrutivo, npm install,
  `data/`, `.env`). Os session-services ficam fora das duas listas, para cair
  em prompt
- `scripts/backup-tenants.sh`: backup online dos SQLite dos tenants + dump
  seletivo do catálogo Postgres
- Correção no CLAUDE.md: caminho real dos bancos de tenant e registro de que o
  catálogo vivo migrou para PostgreSQL (`data/catalog.db` é legado congelado)
- As quatro engines de backfill do catálogo passam a reagendar o próprio timer
  em `finally`. O `resultados-backfill` tinha morrido calado em 2026-08-07: uma
  rejeição escapou do ciclo, o timer nunca foi rearmado e o processo seguiu de
  pé por 4 dias
- `catalog-watchdog.js`: alerta quando uma engine para de dar sinal (heartbeat
  em `catalog_sync_state`, check de hora em hora, log sempre + Telegram do
  primeiro tenant com o canal ligado)
- `stop` deixa de ser deny blanket e passa a nominal: liberado por nome só para
  `consulta-licitacoes` e `liciteagora` (serviço em laço de reinício), negado
  por nome para os session-services e para `postgresql`, `redis`, `nginx` e
  `bind9`/`named`. O blanket `stop:*` precisou sair porque deny vence allow e
  anulava a liberação nominal
- Nova seção "Pendências conhecidas" no CLAUDE.md, começando pelos 31.737
  erros de `participacoes_comprasnet` acumulados no `server.log`

### Faxina do repositório e separação do que estava pendente

- `.gitignore`: `*.bak-*`, `*.bak2*`, `backups-public/` e `public/uploads/`
  (`*.bak` já estava). Saem do índice 46 arquivos `.bak` rastreados, mais os 5
  de `public/uploads/` (PDFs de habilitação e imagem de produto — dado de
  runtime de tenant) e `propostas-api.js.bak2-123913`. Nada foi apagado do
  disco: só `git rm --cached`
- Jornal de Licitações removido. Saem `jornal-routes.js`,
  `jornal-scheduler.js` e a tela; entra `scripts/migrate-desligar-jornal.js`,
  que desliga o envio em todos os tenants (`listAll`, para que tenant suspenso
  que volte não ressuscite o envio) antes de a tela sair do ar. As tabelas
  `jornal_*` e o histórico ficam: são registro de mensagem já enviada a
  clientes. A descoberta por IA varre os mesmos grupos, pelos mesmos canais,
  com qualificação por score — manter os dois mandava duas mensagens sobre a
  mesma licitação
- Correção das referências órfãs que a remoção do jornal deixou no HEAD
  (`route-registry.js`, `role-dispatch.js`, `scheduler.js`). Os dois últimos
  commits são **parciais de propósito**: entraram só as linhas do jornal, para
  não arrastar seis frentes ainda não commitadas. Detalhe no corpo de cada
  commit e em "Frentes pendentes de commit" no CLAUDE.md
- Nova seção "Frentes pendentes de commit" no CLAUDE.md: mapa das 14 frentes
  que seguem na árvore (271 entradas), ordem recomendada de commit, os 7
  módulos untracked que o core/infra arrasta, e três pendências — a fiação do
  watchdog do catálogo fora do git, o `enviarAlerta` sem granularidade por
  tipo de aviso, e o `participacoes_comprasnet`
- Registrado em "Pendências conhecidas" que o `cicloAvisoAlcadas` passa a
  mandar mensagem no próximo restart do `liciteagora.service`, com o
  levantamento de quem receberia (Telegram do `1bit`, email do `reimac`)
