# 26 — Fase 2.2: refinamento visual do Pedidos PDV

**Data:** 2026-09-11, 15:18–15:30 BRT
**Resultado:** implementado. **Já está no ar** — tudo é frontend estático.
**Nenhum restart** foi feito nem é necessário.

**Não tocado, por instrução:** Catálogo Online · pagamento · Asaas · fiscal ·
estoque/lifecycle · reserva · tabela `pedidos` · schema · migrations · preços ·
alçadas · cadastro de produtos · pedidos tradicionais · master.

---

## 1. Serviços — antes e depois

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | active, PID **3777293**, 12:14:16, NRestarts 0 | **idêntico** |
| `liciteagora.service` | active, PID **3085849**, 06:18:49, NRestarts 0 | **idêntico** |

Nenhum restart externo entre o relatório 25 e esta fase, e **nenhum feito aqui**.

## 2. Auditoria inicial

| O que | O que encontrei |
|---|---|
| Sidebar | `250px` **escrito à mão em três lugares** que precisam concordar: `.sidebar`, `.main-content{margin-left}` e o `#conteudo{left/width}` do shell. Não existia modo compacto — só o `toggleSidebar()` de gaveta do mobile. |
| Shell × iframe | No `app.html` a sidebar é do **documento pai**; o PDV roda no iframe e não a alcança. Existe canal: `window.parent.__shellPageChanged(pageName, …)`. |
| Ícones do menu | `.menu-item .icon { display: none }` — os ícones existem no HTML mas ficam ocultos; quem identifica é o texto. |
| Botão "Continuar" | **Só exibia um aviso.** O pedido já persiste a cada ação (7 chamadas gravam no servidor). |
| "Skeleton" | Não havia skeleton: era um `<div class="vazio">Carregando produtos…</div>` esticado na grade inteira. |
| Placeholder | Emoji `📦`, repetido em todo card sem foto. |
| Categorias | Lista de botões sem destaque forte do selecionado. |

## 3. Decisões de UX

### 3.1 Sidebar compacta (não uma segunda sidebar)

`250px` virou **`--sidebar-w`**, uma variável consumida pelos três lugares.
`data-sidebar="compacta"` no `<html>` a leva a **64px**, mostrando só os ícones.

**Só a largura muda.** Os mesmos itens, a mesma navegação, o mesmo RBAC — não há
menu alternativo nem segunda barra. O teste G6 verifica que a função do modo
compacto não toca em `acessoDoUsuario`, `paginas`, `perfil` nem `innerHTML`.

Precedência, e ela importa: **escolha manual > automática da página > expandido**.
O PDV *pede* o modo compacto ao entrar, mas quem clicar no botão manda — a
escolha fica em `localStorage.sidebarCompacta` e vence a automática em qualquer
tela. Só a manual persiste; a do PDV é estado da visita, para que sair da tela
devolva o menu inteiro sem ninguém precisar reabri-lo.

Dois detalhes que só apareceram lendo o CSS existente:

- **os ícones dos itens estão ocultos por padrão.** Sem revelá-los no compacto,
  o menu viraria uma coluna de faixas clicáveis sem rótulo nenhum;
- **a logo é uma imagem.** Escondê-la deixaria o topo vazio, então ela continua
  visível, reduzida e centralizada.

No **mobile o compacto não se aplica**: lá a sidebar já é gaveta, e 64px de
gaveta não serviriam para nada.

### 3.2 "Continuar" → "Salvar pedido"

Auditei antes de renomear, como pedido. O botão **não envia nada**: cada item,
quantidade, desconto, frete e atendimento já vão ao servidor no instante em que
acontecem. O que ele faz é confirmar o estado.

**O comportamento não mudou** — só o rótulo e a mensagem, que agora dizem o que
de fato aconteceu: *"Pedido PED-… salvo — 3 itens, R$ 314,00. Está em Pendentes;
o pagamento entra na próxima etapa."*

"Ir para pagamento" foi descartado de propósito: prometer uma etapa que não
existe é pior do que um botão honesto.

### 3.3 Cards de produto

Hierarquia deliberada — **imagem > preço > nome > saldo**. Quem vende de balcão
reconhece pela foto e confere o preço; o nome confirma, o saldo é apoio.

O **emoji `📦` saiu**. Repetido em dezenas de cards ele virava o elemento mais
chamativo da tela e passava impressão de catálogo quebrado. No lugar, um
**monograma** — as duas primeiras letras do produto sobre um fundo neutro em
gradiente, que se lê como "sem foto" e não como erro. Imagem quebrada também cai
no monograma, em vez do ícone de imagem partida do navegador.

Produto **sem estoque** ganhou estado próprio: etiqueta "Sem estoque" sobre a
imagem e saldo em `--danger`. **A regra não mudou** — ele continua clicável e
vendável, porque o ERP permite venda a descoberto e barrar aqui inventaria uma
regra que o backend não tem.

### 3.4 Estados da área central

| Situação | Antes | Agora |
|---|---|---|
| Carregando | texto esticado na grade | **6 esqueletos** no formato do card real |
| Catálogo vazio | "Nenhum produto encontrado" | "Nenhum produto cadastrado" + onde cadastrar |
| Busca sem resultado | mesma frase genérica | diz **o termo buscado**, se havia filtro de categoria, e oferece "Ver todos" |
| Erro de rede | frase solta | mensagem + **"Tentar de novo"** |

Seis esqueletos, não uma parede: o suficiente para dizer "carregando" sem encher
a tela de linhas cinzas — que era a queixa. A animação respeita
`prefers-reduced-motion`.

### 3.5 Painel do pedido

**Vazio:** deixou de ser uma frase e virou convite — ícone, título, explicação e
o botão **+ Novo pedido** ali mesmo.

**Com pedido:** cliente, número e atendimento no topo; itens com quantidade,
preço unitário e total; e o **TOTAL em 1,5rem**, o maior número da tela (o teste
D2 exige que seja ao menos 40% maior que o total de item).

A ação de desconto continua ligada ao backend: a tela envia o percentual e
**exibe o que o servidor respondeu**. O teste D5 verifica que não há faixa nem
limite codificado no JavaScript.

### 3.6 Pendentes

A linha passou a mostrar **cliente em destaque**, e como apoio: número,
atendimento, **data/hora** e valor. O filtro continua sendo do servidor
(`status=rascunho&tipo=pdv`), o que também garante o isolamento por tenant.

A hora é convertida de UTC para Brasília (o banco grava UTC — CLAUDE.md) e
mostra só o horário quando é de hoje: num balcão, "14:32" é mais útil que a data
de hoje repetida em toda linha.

## 4. Desktop, tablet e celular

| Faixa | Comportamento |
|---|---|
| **≥1100px** | três colunas (`208px \| 1fr \| 372px`), sidebar compacta automática |
| **640–1099px** | categorias em faixa horizontal rolável; pedido vira **gaveta** |
| **<640px** | grade de cards menor; modos de atendimento em largura total; ações compactas |

No celular e no tablet, a **barra fixa do carrinho** no rodapé
(`3 itens · R$ 314,00 · Ver pedido`) respeita `env(safe-area-inset-bottom)`, e a
**gaveta fica acima do botão de tema** (`z-index` 950 contra 900) — corrigido no
relatório 25 e agora coberto por teste.

O cabeçalho reserva 58px (desktop) / 50px (mobile) para o botão global de tema,
conferido por cálculo contra a posição e a largura reais dele.

## 5. Tema claro e escuro

A tela **não tem nenhuma cor fixa** fora de dois casos justificados: branco sobre
fundo de acento (o contraste é garantido pelo token do fundo) e `rgba(0,0,0,…)`
em sombra/overlay. Tudo o mais é token do sistema — o teste A1 varre o CSS da
tela e reprova qualquer cor literal nova.

O teste A2 confere que **todo token usado existe** em `app-modern.css` ou
`sidebar.css`: um `var(--nao-existe)` renderiza transparente e passaria
despercebido.

O tema `custom:` legado continua intacto — nada aqui mexe em `aplicarTema` nem
nas 23 variáveis que ele sobrescreve.

## 6. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/css/sidebar.css` | `--sidebar-w`, modo compacto, botão de alternar |
| `public/js/sidebar.js` | `aplicarSidebarCompacta`, `alternarSidebarCompacta`, `ajustarSidebarPara`, botão no header, ligação em `initSidebar` e `__shellPageChanged` |
| `public/app.html` | `#conteudo` posicionado por `var(--sidebar-w)` |
| `public/comercial/pedidos-pdv.html` | cards, categorias, estados, painel, pendentes, `salvarPedido`, `dataHora` |
| `public/css/app-modern.css` | (do relatório 25) reserva do `.page-header` |
| `scripts/test-pdv-visual.js` | **novo** — 32 testes |

**Nenhuma API criada, nenhum arquivo de backend tocado.**

## 7. Testes

`scripts/test-pdv-visual.js` — **32 testes, 32 OK**:

| Bloco | Cobre |
|---|---|
| **A** | tema: nenhuma cor fixa; nenhum token inexistente; theme-boot presente |
| **B** | skeleton contido e com `prefers-reduced-motion`; três estados vazios distintos; o vazio oferece saída |
| **C** | placeholder não é o emoji; imagem quebrada cai no monograma; **preço maior que o nome**; sem estoque com estado próprio; **preço vem da API e a tela não envia preço** |
| **D** | painel vazio com CTA; **TOTAL é o maior número**; botões de quantidade ≥36px no toque; rótulo do botão principal não promete pagamento; **alçada continua no servidor** |
| **E** | pendentes com os 5 campos; filtro no servidor; `dataHora` convertendo UTC→BRT |
| **F** | reserva do botão de tema por cálculo; gaveta acima dele; três larguras; safe-area |
| **G** | `--sidebar-w` sem 250px hardcoded; ícones revelados no compacto; logo visível; botão de alternar; manual vence automático; compacto desligado no mobile; **não mexe em RBAC** |
| **H** | JS inline parseia; todo handler tem função |

**Regressão — zero falhas novas:** `verify` OK · `test-shell-boot` 24 ·
`test-tema-global` 17 · `test-pdv-fluxo` 29 · `test-pdv-rbac` 11 ·
`test-fase1-funcional` 57 · `test-governanca-percentual` 29 · `test-app-backend`
79 · `test-alcadas` 41.

Dois testes falharam primeiro e foram úteis: o do rótulo do botão (que casava com
o meu próprio comentário explicando por que "Ir para pagamento" foi descartado) e
o do modo compacto, que revelou que os ícones do menu estão ocultos por padrão.

## 8. Tenants

**Nenhum tenant de cliente foi alterado.** Esta fase não escreve em banco nenhum
— é CSS, HTML e JavaScript.

Conferido depois: `produtosbomgosto` segue com **R$ 46.069,50**, o mesmo dos
relatórios 18, 21 e 25. O único pedido `tipo='pdv'` em cliente continua sendo o
seu, de 13:40 (relatório 25 §11) — nenhum novo apareceu.

O sandbox não precisou ser usado: não houve mudança funcional a exercitar além
do que `test-pdv-fluxo` já cobre em banco descartável.

## 9. Restart

**Nenhum, e nenhum é necessário.** Todos os arquivos são de `public/`, servidos
estaticamente — já estão no ar. Verificado pelo processo em execução:

```
/comercial/pedidos-pdv.html   HTTP 200   50.221 B   (sem-img, pintarSkeleton,
                                                     salvarPedido, ped-vazio,
                                                     pend-item, tag-esgotado)
/css/sidebar.css              HTTP 200   16.176 B   (21 regras do compacto)
/js/sidebar.js                HTTP 200   65.814 B
/app.html                     HTTP 200    1.336 B
```

**Recarregue com Ctrl+F5** na primeira vez — o navegador tem em cache o CSS e o
`sidebar.js` antigos.

## 10. Limitações — leia antes de considerar pronto

**Não vi nenhuma tela renderizada.** Tentei o Chrome duas vezes; a extensão
recusa `localhost` (*"Can't interact with browser-internal or unparseable URLs"*
e, antes, *"Permission denied for this action on this domain"*) e o domínio do
tenant não resolve do navegador. A autorização por site é sua.

Portanto, e sendo explícito como o item 13 pede: **não afirmo que ficou bonito,
nem que está aprovado.** O que posso afirmar é o que foi medido — que a tela usa
só tokens do sistema, que a hierarquia de tamanhos está na ordem pretendida, que
os estados existem e que nada se sobrepõe por cálculo. Equilíbrio, respiro,
densidade e legibilidade real só se julgam olhando.

**Precisa da sua validação manual:**

1. desktop claro e escuro · mobile claro e escuro;
2. pedido vazio e pedido com produtos;
3. modal **Novo pedido** e lista de **Pendentes**;
4. a **sidebar compacta**: se 64px bastam para os ícones e se o botão de alternar
   está onde a mão procura;
5. o **monograma** dos produtos sem foto — é onde mais posso ter errado o tom,
   porque o acervo real quase não tem imagens (2 de 109 no `1bit`, 0 em
   `produtosbomgosto`). Vale subir algumas fotos antes de julgar.

**Outras limitações conhecidas:**

- **categorias continuam sendo `TEXT` livre** (relatório 22 §10) — sem
  hierarquia, ordem própria ou normalização. Não criei tabela, como instruído;
- **sem PWA instalável** — falta `manifest.json` e service worker;
- **sem leitor de código de barras por hardware** — a busca encontra pelo código
  digitado, mas não há captura de scanner;
- **o pedido não é confirmado pela tela** — segue em rascunho, sem reservar
  estoque; confirmação e reserva vêm com o pagamento.

## 11. Nada que exigisse backend foi feito por conta própria

Duas coisas que a melhoria visual tocaria e **ficaram de fora**, como instruído:

1. **Ordenar ou agrupar categorias** exigiria modelagem (tabela, ordem, ícone) —
   é decisão de outra fase;
2. **Imagem em tamanho maior/galeria** exigiria variantes de imagem no servidor;
   hoje há um caminho só (`imagemPath`).

## 12. Próximo passo

1. **Validar visualmente** os oito cenários da §10.
2. Ajustes que a revisão apontar.
3. **Fase 2.3 — pagamento do PDV**: dinheiro, PIX, cartão, misto e a prazo,
   terminando na confirmação do pedido (que é quando a reserva de estoque
   acontece). É também onde a fila de aprovação de desconto precisa ficar
   visível ao aprovador.
