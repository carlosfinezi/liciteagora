# 29 — Fase 3.2.1: acabamento de UX da sidebar e do pedido

**Data:** 2026-09-11, 17:04–17:25 BRT
**Base:** [28 — sidebar e botões](28-fase3.2-sidebar-botoes.md)

**Resultado:** as quatro correções implementadas. **Nenhum restart, nenhuma
alteração de banco.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, 12:14:16, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, 06:18:49, NRestarts 0 | **idêntico** |

Sem restart externo desde o relatório 28. `npm run verify` verde antes e depois.

---

## 1. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/js/sidebar.js` | `title` removido dos itens, seções e ações |
| `public/comercial/pedido.html` | reserva para o botão de tema · `desvincularProduto` · foco após adicionar |
| `scripts/test-fase321-ux.js` | **novo** — 20 testes |
| `scripts/test-sidebar-botoes.js` | duas premissas corrigidas (§7) |

**Zero alteração de banco, de API ou de regra comercial.**

## 2. Parte 1 — tooltip duplicado

### A causa, medida antes de mexer

O HTML gerado tinha **15 `title=` contra 14 `data-tooltip=`**: cada item emitia
os dois. O navegador desenha o tooltip nativo por cima do nosso — os dois textos
que você viu em "Tabelas de Preço".

Fui eu que introduzi, na Fase 3.2, com a justificativa de "fallback nativo".

### Por que o `title` saiu inteiro, e não só foi suprimido

**O fallback não existia de verdade.** Quem desenha os itens da sidebar é o mesmo
`sidebar.js` que desenha o tooltip. Se ele não rodar, não há menu — então não
haveria `title` para socorrer ninguém. Era um fallback para um cenário impossível,
cobrando o preço de um tooltip duplicado em todo item.

Havia um segundo efeito, que o pedido também aponta: com a barra **expandida**, o
`title` mostrava o nome de um item cujo nome já está escrito ao lado. Tooltip
desnecessário, ruído puro.

| Onde | Antes | Depois |
|---|---|---|
| itens do menu | `data-tooltip` + `title` + `aria-label` | `data-tooltip` + `aria-label` |
| cabeçalho de grupo | idem | idem |
| **Alterar Senha / Sair** | idem | idem |

**Acessibilidade preservada:** `aria-label` continua em todos — é ele que
responde ao leitor de tela. `role="button"`, `tabindex` e `aria-expanded` dos
grupos intactos.

**Dois `title` foram mantidos**, e de propósito: o do tile de módulo
(`selecionarModulo`) e o do botão de recolher (`#btnSidebarToggle`). Nenhum dos
dois está nos seletores do tooltip custom, então não há duplicata a resolver — e
tirá-los deixaria esses controles sem dica nenhuma.

**Os nomes continuam vindo do menu.** `data-tooltip` e `aria-label` saem de
`item.texto` / `secao.titulo` do `menu-config`; nada escrito à mão. RBAC
inalterado (§8).

## 3. Parte 2 — botão de tema sobre "Salvar" e "Ações"

### A causa

`pedido.html` **não usa `.page-header`** — tem cabeçalho próprio, `.ped-header`,
e por isso a reserva global do ERP nunca o alcançou. Exatamente o mesmo caso que
o Pedidos PDV teve no relatório 25.

A conta: `.ped-header` tinha `padding-right: 28px`, e o botão ocupa **50px** da
borda (fica a `right: 16px` e tem 34px). **22px de sobreposição** — bem sobre
`Salvar` e `Ações`, que ficam à direita ali.

### A correção

```css
.ped-header { padding: 18px 58px 18px 28px; }        /* 8px de folga */
@media (max-width: 768px) { .ped-header { padding: 14px 50px 14px 16px; } }
```

No mobile o botão encolhe para 32px a `right: 10px` (42px), e 50px dão a mesma
folga. **O botão de tema não foi escondido** em nenhuma largura, e os controles
não foram deslocados além do necessário.

### O dropdown de Ações

É um **drawer**, não dropdown, e já está em `z-index: 2000` — acima do botão de
tema (900). **Nada precisou mudar**; o teste E passou a fixar isso, para ninguém
baixar esse valor sem perceber.

## 4. Parte 3 — foco na busca de produto

### O que foi feito, e o que deliberadamente não foi

**Depois de adicionar um item:** o foco volta para `SKU ou descrição…`, com
`preventScroll`. `addItem()` já limpava os cinco campos; agora limpa também a
legenda de origem do preço e devolve o cursor. Quem lança pedido digita um
produto atrás do outro — sem isso é preciso pegar o mouse a cada item.

**No carregamento da página: não.** O card "Adicionar item" fica abaixo do
cabeçalho e das abas; focá-lo no load rolaria a tela para baixo sozinha,
escondendo o cabeçalho do pedido que a pessoa acabou de abrir. É exatamente a
ressalva que o pedido levanta, e o teste F2 impede que alguém adicione `autofocus`
ou um foco em `DOMContentLoaded` depois.

Nenhum foco é roubado durante a edição: o único ponto que chama `.focus()` é o
sucesso do `addItem`.

## 5. Parte 4 — campos dependentes ao remover o produto

### O defeito, confirmado no código

`acItemProd()` fazia `if (!q) { lista.innerHTML=''; return; }` — limpava só a
lista de sugestões. `itProdId`, `itDesc` e `itPu` continuavam preenchidos com os
dados do produto que não estava mais selecionado, e o item ia adiante como avulso
sem ninguém perceber.

### A regra implementada

Um registro do que a seleção preencheu:

```js
_itemAuto = { busca, desc, pu }
```

E a limpeza só desfaz **o que ainda é dela**:

| Campo | Comportamento |
|---|---|
| `itProdId` | sempre limpo (o vínculo acabou) |
| `itDesc` | limpo **só se** ainda for igual ao auto-preenchido |
| `itPu` | limpo **só se** ainda for igual ao auto-preenchido |
| `itPrecoFonte` | sempre limpo |
| **`itQtd`** | **nunca tocado** — não vem do produto, é do usuário |

Isso atende a sua preferência: limpar o que corresponde ao auto-preenchimento,
preservar o que a pessoa digitou.

**Item avulso é permitido — verificado, não presumido.** `addItem()` envia
`produtoId: val('itProdId') ? Number(...) : null`, e a Fase 1 mantém item sem
produto para quem não é vendedor restrito. Então preservar a descrição editada e
deixar o item virar avulso é um caminho que o backend aceita. Se não aceitasse, a
regra teria de ser outra.

### Quando o vínculo se desfaz

Não só ao apagar o campo: **também ao editá-lo**. O vínculo vale enquanto
`itBusca` mostrar exatamente o que a seleção escreveu (`SKU — descrição`).
Apagar tudo ou mudar uma letra desfaz — nos dois casos o produto deixou de estar
selecionado, e tratar só o "campo vazio" deixaria o caso do meio sem cobertura.

## 6. Comportamento — antes e depois

| Situação | Antes | Depois |
|---|---|---|
| hover na sidebar recolhida | **dois tooltips** (custom + nativo) | só o custom |
| hover na sidebar expandida | tooltip nativo desnecessário | nenhum |
| cabeçalho do pedido | botão de tema **sobre** Salvar/Ações | 8px de folga |
| após adicionar item | cursor em lugar nenhum | volta para a busca |
| apagar o produto do campo | descrição e preço **ficavam** | limpos, se ainda automáticos |
| editar a descrição e apagar o produto | descrição ficava (por acidente) | descrição fica (**por regra**), item vira avulso |
| quantidade digitada | — | nunca apagada |

## 7. Duas premissas de teste que precisaram mudar

`test-sidebar-botoes.js` passou a falhar em dois pontos, e os dois eram do teste,
não do código:

1. **Teste C exigia `title`** — era a premissa da Fase 3.2, e é exatamente o que
   esta fase removeu. Agora exige `aria-label` **e reprova se o `title` voltar`.
2. **Teste E acusou "Tabelas de Preço" escrita à mão** — ela aparece no
   **comentário** que explica por que o `title` saiu. O teste varria o arquivo
   inteiro; passou a remover comentários antes de procurar. Citar um item ao
   documentar um defeito não é duplicar o rótulo.

É a terceira vez que um teste meu casa com o próprio comentário. Vale como
lembrete: verificação de código precisa olhar código.

## 8. RBAC e regras — inalterados

| Verificação | Resultado |
|---|---|
| prefixos no mapa de API | **175** — igual |
| itens no menu | **190** — igual |
| `desenharMenuComAcesso` | intacto |
| `precoDeItem` (servidor decide o preço) | intacto |
| modelo do pedido (`produtoId: null` para avulso) | intacto |
| **banco de dados** | **nada tocado** |

## 9. Temas

Todo o CSS desta fase usa tokens — o teste L varre e reprova cor literal. O
cabeçalho do pedido continua em `var(--border)` / `var(--bg-1)`. O tema `custom:`
legado segue funcionando (`paletaCustom` intacta).

## 10. Testes

`scripts/test-fase321-ux.js` — **20 testes, 20 OK**. A lógica de
`desvincularProduto` é **extraída do HTML e executada** contra campos simulados;
não é regex sobre o fonte — precaução vinda do relatório 24, onde 14 testes
verdes rodaram sobre um arquivo que nem parseava.

Cobertura contra a lista da Parte 5: A ✔ B ✔ C ✔ D ✔ E ✔ F ✔ G ✔ H ✔ I ✔ J ✔
K ✔ L ✔ — mais quatro casos que a lista não pedia mas o comportamento exige:
preço editado à mão preservado, desvincular sem produto não faz nada, vínculo
desfeito também ao editar, e foco **não** roubado no load.

**Regressão — zero falhas novas:**

| Suíte | |
|---|---|
| `npm run verify` | **OK, 1,0 s** |
| `test-fase321-ux` | **20 ok** |
| `test-sidebar-botoes` | 23 ok |
| `test-shell-boot` | 24 ok |
| `test-tema-global` | 21 ok |
| `test-pdv-visual` | 32 ok |
| `test-pdv-fluxo` | 29 ok |
| `test-pdv-rbac` | 11 ok |
| `test-fase1-funcional` | 57 ok |
| `test-governanca-percentual` | 29 ok |
| `test-app-backend` | 79 ok |
| `test-alcadas` | 41 ok |

Conferido no que o servidor entrega: `sidebar.js` (76.175 B) **parseia** e tem
**zero** `title` nos itens; `pedido.html` traz `desvincularProduto` e a reserva
`padding: 18px 58px`.

## 11. Riscos

| Risco | Gravidade | Observação |
|---|---|---|
| **Não vi as telas renderizadas** | — | a extensão do Chrome recusa `localhost`; validação foi estrutural |
| `desvincularProduto` compara strings | baixa | `itPu` compara `'18.90'` com `String(18.90)`. Se o navegador normalizar o valor do `input[type=number]` (ex.: `18.9`), o preço não seria limpo — o pior caso é sobrar um preço, nunca apagar trabalho. Vale conferir na revisão |
| reserva de 58px empurra os botões | baixa | 30px a mais que antes, só nesta tela |
| o `title` sumiu de itens do menu | baixa | `aria-label` cobre leitor de tela; sem JS não há menu |

## 12. O que precisa do seu olho

1. **hover na sidebar recolhida** — confirmar que agora aparece **um** tooltip;
2. **`/comercial/pedido.html?id=…`** — botão de tema não cobrindo Salvar/Ações,
   no claro e no escuro, desktop e celular;
3. **abrir o drawer "Ações"** e ver se o botão de tema fica por baixo;
4. **adicionar um item** e confirmar que o cursor volta à busca sem a tela pular;
5. **selecionar um produto e apagar o campo** — descrição e preço devem sumir;
6. **selecionar, editar a descrição, apagar o campo** — a descrição editada deve
   ficar (o item passa a ser avulso);
7. o caso do preço citado em §11, se você digitar um valor com decimal.

**Paro aqui para a revisão visual.** Não inicio topbar, logo, notificações,
ajuda, Fase 2 do PDV nem Catálogo Online.
