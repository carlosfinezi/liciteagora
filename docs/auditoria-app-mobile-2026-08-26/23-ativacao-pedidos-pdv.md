# 23 — Ativação da Fase 2.1: Pedidos PDV

**Data:** 2026-09-11, 12:11–12:20 BRT
**Referência:** [22 — interface Pedidos PDV](22-fase2-pedidos-pdv-interface.md)

**Resultado:** **ATIVADO.** Worker reiniciado, mapa de permissões novo em vigor,
RBAC fail-closed comprovado para perfil restrito. Master intocado, nenhum tenant
de cliente alterado.

**Não feito, por instrução:** pagamento · Catálogo Online · commit · restart do
master · Asaas · alteração em tenant de cliente.

---

## 1. Pré-check

| Unidade | Status | PID | NRestarts | Start |
|---|---|---|--:|---|
| `consulta-licitacoes.service` | active/running | 3637675 | **0** | 2026-09-11 11:17:35 |
| `liciteagora.service` | active/running | 3085849 | **0** | 2026-09-11 06:18:49 |

Idênticos ao registrado no relatório 22, com `NRestarts = 0`: **nenhum restart
externo** entre os dois relatórios.

## 2. Arquivos

| Arquivo | Tamanho | Gravado |
|---|--:|---|
| `public/comercial/pedidos-pdv.html` | 38.972 B | 12:03:24 |
| `public/js/menu-config.js` | 36.232 B | 12:02:16 |
| `perfis-api-map.js` | 27.780 B | 12:03:29 |

### O mapa contém exatamente o necessário

Comparação automática entre o que a tela **chama** e o que o mapa **libera**:

```
usados na tela : /api/pedidos, /api/pessoas, /api/produtos
liberados      : /api/pedidos, /api/pessoas, /api/produtos
liberado A MAIS (permissão indevida) : NENHUM
usado SEM liberação (quebraria)      : NENHUM
```

Correspondência exata. O total de prefixos do mapa continua **175** — nenhuma API
foi aberta de carona para outras páginas.

## 3. Testes antes do restart

| Suíte | Resultado |
|---|---|
| `npm run verify` | **OK** |
| `test-pdv-fluxo` | 29 ok, 0 falha |
| `test-fase1-funcional` | 57 ok, 0 falha |
| `test-alcadas` | 41 ok, 0 falha |
| `test-governanca-percentual` | 29 ok, 0 falha |
| `test-app-backend` | 79 ok, 0 falha |
| `test-aprovacoes-fluxo` | 15 passaram, **4 falharam — pré-existentes** |

> O pedido citava `test-governanca-alcadas`; não existe suíte com esse nome — a
> do motor de alçadas é `test-alcadas`, usada acima.

As 4 falhas são as mesmas dos relatórios 19, 20 e 21 (montagem de mensagem com
fornecedor e contador de menu). **Nenhuma falha nova** — restart autorizado.

## 4. Backup

```
/home/carlosfinezi/backups/fase2.1-ativacao-20260911-121413/
```

4 arquivos · 144 KB · **0 bancos**. Conferidos byte a byte após a cópia:
`pedidos-pdv.html`, `menu-config.js`, `perfis-api-map.js` e `test-pdv-fluxo.js`
— os únicos realmente alterados na Fase 2.1.

## 5. Restart

```
systemctl restart consulta-licitacoes.service     12:14:16
```

Só essa unidade. `liciteagora.service`, nginx, postgres e os session-services não
foram tocados.

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID **3637675**, 11:17:35 | PID **3777293**, **12:14:16**, NRestarts 0, active/running |
| `liciteagora.service` | PID **3085849**, 06:18:49 | PID **3085849**, 06:18:49 — **inalterado** |

`[worker] Servidor rodando em http://localhost:3000` às **12:14:21** — cinco
segundos. `/health` → **HTTP 302**. **Nenhum stack trace, nenhum crash.**

> As primeiras dez tentativas de `curl` devolveram `000` porque o laço rodou em
> fração de segundo, dentro da janela de boot. Não foi falha do serviço — a
> chamada seguinte, com `--retry`, respondeu em 8 ms.

### O processo carregou o mapa novo

```
perfis-api-map.js gravado em : 12:03:29
worker iniciado em           : 12:14:16
→ o arquivo é ANTERIOR ao boot; o require do disco carregou esta versão
```

Node lê o `require` do disco a cada processo — não há cache entre execuções.
Arquivo mais antigo que o boot significa, deterministicamente, que é esta versão
que está em memória.

## 6. Smoke test

Tenant `labfiscal`, somente leitura:

| Rota | HTTP |
|---|---|
| `/health` (sem Host de tenant) | **302** |
| `/comercial/pedidos-pdv.html` | **200** |
| `GET /api/produtos` | 200 |
| `GET /api/pessoas` | 200 |
| `GET /api/pedidos` | 200 |
| `POST /api/produtos/disponibilidade` | 200 |
| `GET /api/pedidos?status=rascunho&tipo=pdv` | 200 |

`/health` com o Host do tenant devolve 404 — roteamento por subdomínio, já
documentado no relatório 21 §7, não falha.

**Zero avisos `[RBAC] prefixo sem mapa` desde o boot.**

## 7. RBAC — o ponto principal

`scripts/test-pdv-rbac.js` (novo) — **11 testes, 11 OK** — no sandbox, com as
funções reais de `perfis-acesso.js` e o `perfis-api-map.js` do disco. Os perfis
de teste foram criados e **removidos ao final**.

### A) Perfil COM acesso a `pedidos-pdv`

| Verificação | Resultado |
|---|---|
| a página abre | **OK** |
| as 3 APIs da tela respondem | **OK** |
| caminhos aninhados (`/api/pedidos/12/itens/3`, `/api/produtos/disponibilidade`) | **OK** |

O teste confirma antes que o perfil **não é irrestrito** — senão não provaria nada.

### B) Perfil SEM acesso

| Verificação | Resultado |
|---|---|
| a página é **bloqueada** | **OK** |
| o bloqueio é da página, não do diretório | **OK** |
| **perfil com OUTRA página de `/comercial/` também é barrado** | **OK** |

O terceiro é o que mais importava. `podeVerPath` tem um fallback por diretório:
quem tem qualquer página de `/comercial/` passaria a ver caminhos daquele
diretório. Isso **não** acontece aqui porque `pedidos-pdv` está registrada no
`menu-config` e cai na checagem **nominal**, antes do fallback. Um perfil com
`/comercial/pedidos.html` **não** entra em `/comercial/pedidos-pdv.html`.

### C) Não amplia permissão

| Verificação | Resultado |
|---|---|
| ter **só** `pedidos-pdv` libera as 3 APIs da tela | **OK** |
| e **nenhuma** das 12 APIs sensíveis testadas | **OK** |
| não abre outras páginas (contas a pagar, alçadas, nota fiscal, pedidos) | **OK** |
| prefixo desconhecido continua **negado** | **OK** |
| admin segue irrestrito | **OK** |

APIs verificadas como bloqueadas: `contas-a-pagar`, `tesouraria`, `alcadas`,
`usuarios-admin`, `nfe`, `faturas`, `contas-a-receber`, `compras`, `estoque`,
`comissoes`, `contratos`, `devolucoes`.

**O fail-closed está intacto.** Os avisos `[RBAC] prefixo sem mapa` que aparecem
no teste são a própria negação funcionando — prefixo fora do mapa é recusado, e o
log diz qual foi.

## 8. Fluxo no sandbox

| Passo | Resultado |
|---|---|
| 1. novo pedido PDV | PED-2026-00124, `tipo=pdv` |
| 2. cliente escolhido | Ana Souza (CPF) |
| 3. tipo de atendimento | `no_local` |
| 4. produto adicionado | total R$ 100,00 |
| 5. quantidade 1 → 4 | total R$ 400,00 |
| 6. desconto 4% (dentro da alçada) | desconto R$ 16,00 · total **R$ 384,00** · aprovação: **não** |
| 7. deixado pendente | status `rascunho`, aparece na lista de pendentes |
| 8. **estoque** | **0 reservas, 0 movimentações** |
| 9. limpeza | pedido removido do sandbox |

### Limitação declarada

O `sandbox` está `SUSPENDED` e o gate de plano devolve **402** a qualquer
requisição HTTP dele. Ativá-lo o tornaria visível a `listActive()` e aos jobs do
master — que roda código anterior e não foi reiniciado. Não vale o risco por um
detalhe de transporte.

Os testes rodaram **in-process, contra o banco real do sandbox, carregando os
mesmos arquivos do disco que o worker carregou às 12:14:21**. O que muda é o
processo, não o código — e o §6 já prova por HTTP que a tela e as APIs respondem
no worker.

## 9. Estoque

**Pedido pendente não reserva estoque — verificado, não presumido.** Após o
fluxo completo (4 unidades, desconto aplicado, pedido deixado em aberto):

```
reservas_estoque    = 0
movimentacoes_estoque (origem='pedido') = 0
```

É o comportamento correto: `criarReservasPedido` só é chamado na confirmação. O
lifecycle **não foi alterado**.

## 10. Verificação visual

Marcadores conferidos na página **servida pelo processo ativo** (38.767 bytes) —
nenhum redesenho foi feito nesta etapa:

| Desktop | | Mobile | |
|---|---|---|---|
| coluna de categorias | **SIM** | categorias horizontais (≤1099px) | **SIM** |
| grade de produtos | **SIM** | barra fixa do carrinho | **SIM** |
| painel do pedido atual | **SIM** | pedido em gaveta | **SIM** |
| cliente | **SIM** | grade adapta em <640px | **SIM** |
| subtotal · desconto · frete · TOTAL | **SIM** | safe-area (notch) | **SIM** |

Mais: três modos de atendimento, botão **+ Novo pedido** e **Pendentes**, todos
presentes.

## 11. Tenants de clientes

Somente leitura, depois da ativação:

| Tenant | Pedidos PDV | Perfis | Faixas desconto | Pedidos (total) |
|---|--:|--:|--:|--:|
| `1bit` | **0** | 0 | 0 | 29 |
| `produtosbomgosto` | **0** | 0 | 0 | 21 |
| `josecarloscostafilho` | **0** | 1 | 0 | 11 |
| `raeldouglas` | **0** | 0 | 0 | 2 |
| `jaagricola` | **0** | 0 | 0 | 1 |
| demais 8 | **0** | 0 | 0 | 0 |

- nenhum pedido `tipo='pdv'` em cliente algum;
- nenhum perfil criado ou alterado (o perfil único do `josecarloscostafilho` é
  pré-existente, já registrado no relatório 20);
- nenhuma regra de desconto criada;
- contagens de pedidos idênticas às dos relatórios 21 e 22.

## 12. Serviços e journal

| Unidade | Estado final |
|---|---|
| `consulta-licitacoes.service` | active/running, PID **3777293**, 12:14:16, NRestarts 0 |
| `liciteagora.service` | active/running, PID **3085849**, 06:18:49 — **inalterado** |

Journal desde o boot: `no such column` 0 · `SQLITE_ERROR` 0 · `TypeError` 0 ·
`ReferenceError` 0 · `Cannot find module` 0 · `prefixo sem mapa` 0.

Ruído pré-existente: `AutoLance` 44, `BNC-Chat` 3 — ambos documentados e sem
relação com esta ativação.

### Uma anomalia que deixou de existir

O `initSchema falhou … readonly database` dos 6 sandboxes, registrado no
relatório 21 §17, **não ocorre mais**: são agora `carlosfinezi:carlosfinezi`. A
última ocorrência no journal foi às **11:17:45**, no boot anterior. O `chown`
sugerido naquele relatório foi executado e resolveu — os bancos de cliente já
estavam corretos e seguem intactos.

## 13. Conclusão: **GO PARA REVISÃO VISUAL**

A Fase 2.1 está ativa:

- worker reiniciado às 12:14:16, subiu limpo, sem stack trace;
- mapa de permissões novo comprovadamente em memória;
- **RBAC fail-closed provado nos três cenários**: quem tem entra, quem não tem é
  barrado (inclusive tendo outra página do mesmo diretório), e ter a página não
  concede nenhuma API a mais;
- fluxo de balcão completo funcionando, com desconto sujeito a alçada;
- **estoque não é reservado por pedido pendente**;
- tela servida com todos os elementos de desktop e mobile;
- nenhum tenant de cliente tocado; master intocado.

O que falta para o PDV ser usável em produção não é técnico nesta camada — é
**olhar a tela**. Nenhum teste de API pega espaçamento, contraste, tamanho de
card ou o comportamento real do toque.

## 14. Próximo passo recomendado

1. **Revisão visual com dados reais.** Abrir `/comercial/pedidos-pdv.html` num
   tenant com produtos e **fotos** cadastradas, em desktop e celular. Vale
   lembrar: o acervo real tem pouquíssimas imagens (2 de 109 no `1bit`, 0 em
   `produtosbomgosto`), então o card cai no ícone `📦` — para avaliar a
   experiência visual de verdade, subir algumas fotos em Produtos antes.
2. **Ajustes visuais** que a revisão apontar — é a etapa natural depois de um GO
   funcional.
3. **Fase 2.2 — pagamento:** dinheiro, PIX, cartão, misto e a prazo, terminando
   na confirmação do pedido (que é quando a reserva de estoque acontece). É
   também onde a **fila de aprovação de desconto** precisa ficar visível ao
   aprovador: hoje a solicitação nasce e só aparece a quem for consultar
   `aprovacoes`.
4. **Depois:** `manifest.json` + service worker (PWA instalável) e o **Catálogo
   Online**, que é outra audiência e onde `pessoa-sem-documento.js` entra.

**Riscos que permanecem abertos:** categorias são texto livre (22 §10);
`loja-routes.js` grava pedido por INSERT próprio e ainda não passa pela porta
única do desconto; fail-open de perfil sem cadastro (19 §4); faixa de zero inativa
em `pagamento_cp` no `1bit` (20 §3.3); NFC-e/NFS-e lendo documento do corpo (15);
webhook Asaas de `josecarloscostafilho` (11); 4 pedidos de R$ 10.036,00 aguardando
decisão de backfill (07); `[DIGEST] no such table: licitacoes` (18 §16).
