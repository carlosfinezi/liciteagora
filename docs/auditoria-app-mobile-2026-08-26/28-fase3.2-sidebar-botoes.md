# 28 — Fase 3.2: sidebar moderna, tooltip, flyout e botões

**Data:** 2026-09-11, 15:51–16:20 BRT
**Base:** [26 — plano](26-modernizacao-visual-global-plano.md) ·
[27 — fundação](27-fase3.1-fundacao-visual.md) ·
[25 — shell branco](25-correcao-shell-branco-tema.md)

**Resultado:** implementado. **Nenhum restart, nenhum HTML alterado.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, 12:14:16, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, 06:18:49, NRestarts 0 | **idêntico** |

Sem restart externo desde o relatório 27. `npm run verify` verde antes e depois.

---

## 1. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/css/sidebar.css` | sidebar moderna, tooltip, flyout, ajuste do compacto |
| `public/js/sidebar.js` | `data-tooltip`/`aria-label` nos itens, tooltip e flyout |
| `public/css/app-modern.css` | bloco de botões + tokens `--btn-*` |
| `scripts/test-sidebar-botoes.js` | **novo** — 23 testes |

**Zero HTML tocado.** Tudo veio da camada global — os 213 telas herdam.

## 2. Sidebar expandida

| Antes | Depois | Por quê |
|---|---|---|
| `border-left: 2px` em **cada** item | fundo suave + faixa fina só no ativo | uma barra por item desenha uma grade vertical, e cada linha vira "botão" |
| ícones dos itens `display: none` | **visíveis** | é o "equilíbrio entre texto e ícone" pedido — e é o **mesmo ícone** que o modo recolhido já usava; nada de novo foi inventado, nada some ao recolher |
| `padding: 5px` | `7px`, com margem lateral e raio | em lista de 190 itens, 2px por linha separam lista de amontoado |
| cabeçalho com fundo `--bg-2` | transparente, só a borda | era mais uma "caixa" |
| seção grudada no grupo anterior | respiro de 14px acima | separa sem precisar de linha divisória |
| logo `max-height: 40px` | **contenção** (`max-height`/`max-width`/`object-fit`) | quando a marca for trocada, o arquivo novo se ajusta sozinho — sem dimensão fixa a corrigir |

**Densidade preservada:** o item continua em uma linha. Com 26 seções e 190
itens, arejar demais dobraria a rolagem.

Preservados: COMERCIAL, CATÁLOGO, ESTOQUE e todos os módulos, submenus, rolagem,
busca de rotina, RBAC.

## 3. Sidebar recolhida

Mantida em 64px, com um ajuste estrutural: o rótulo do item passou a ficar em
`<span class="rotulo">`. Antes, escondê-lo dependia de `font-size: 0` no `<a>`,
que zerava **tudo** que estivesse dentro e obrigava ícone e badge a recuperar
tamanho. Agora basta esconder o span.

## 4. Tooltip

**O problema que ele resolve:** ninguém deve precisar decorar ícone num ERP com
190 itens.

| Requisito | Como foi atendido |
|---|---|
| usa o nome **real** do item | `data-tooltip` vem de `item.texto` / `secao.titulo` do `menu-config` |
| não duplica rótulo | **nenhum nome de menu escrito em `sidebar.js`** — teste E confere |
| aparece rápido | 120 ms — evita piscar ao passar o mouse em diagonal |
| à direita do ícone, com folga | `left = ícone.right + 10px` |
| nunca cobre o ícone | `pointer-events: none` |
| acima do conteúdo | `z-index: 1100` (sidebar é 1000, modais 10000) |
| **não é cortado pelo overflow** | vive no `<body>`, `position: fixed` |
| não sai da viewport | topo limitado a `[8, innerHeight − altura − 8]` |
| claro e escuro | só tokens |
| com a sidebar rolada | `scroll` esconde e recalcula |
| some ao sair | `mouseout`, `focusout`, `scroll`, `resize`, `Escape` |
| não fica preso | os cinco gatilhos acima |

**Por que não `::after`:** `.sidebar-menu` tem `overflow-y: auto` e cortaria o
tooltip exatamente na borda onde ele precisa aparecer.

`title` continua como fallback nativo, mas não é o mecanismo.

## 5. Flyout dos grupos

Com a barra recolhida, clicar no ícone de um grupo abre um painel à direita com
os itens daquele grupo.

**Hover para tooltip, clique para flyout** — a Parte 6 autoriza escolher, e
escolhi clique. Hover exigiria atravessar o vão entre ícone e painel sem que ele
feche, o que se resolve com timers e "pontes" invisíveis e falha no primeiro
movimento rápido de mouse. Clique é estável, funciona em toque e não some
enquanto se lê.

| Requisito | Como |
|---|---|
| itens reais do grupo | **clonados do DOM já renderizado** |
| **respeita RBAC** | ver §8 |
| item atual destacado | `.sb-flyout-item.ativo` |
| clicar navega e fecha | o clone mantém o `href` |
| clique fora fecha | sim |
| `Escape` fecha | sim |
| não sai da viewport | reposiciona para cima quando não cabe |
| sidebar rolada | `scroll` fecha |
| não fica atrás do conteúdo | `z-index: 1100` |
| não cobre o próprio ícone | `left = cabeçalho.right + 8px` |
| **não cria segunda definição de menu** | ver §8 |

Fecha também em `resize` e ao expandir a sidebar.

## 6. Mobile

**Nada mudou no comportamento mobile** — e é decisão, não omissão.

No celular a sidebar já é gaveta de largura cheia (`translateX(-100%)` +
overlay), e `[data-sidebar="compacta"]` é neutralizado abaixo de 768px
(`--sidebar-w: 250px`). Ou seja: **não existe sidebar de ícones no celular**, e
portanto não há o que resolver com tooltip ou flyout ali. Tocar um grupo continua
abrindo o submenu como sempre.

Não transformei a gaveta numa faixa de ícones: seria piorar o que já funciona.

## 7. Acessibilidade

| Item | Antes | Depois |
|---|---|---|
| `aria-label` nos itens | não havia | **todos**, com o nome real |
| grupo operável por teclado | `<div onclick>` | `role="button"`, `tabindex="0"`, `aria-expanded` |
| tooltip no foco | não havia | `focusin` mostra o mesmo que o hover |
| `Escape` | — | fecha flyout e tooltip |
| `:focus-visible` da Fase 3.1 | — | **preservado** (teste C4) |

Dois itens do menu — **"Alterar Senha" e "Sair"** — são ações, não páginas: não
existem no `menu-config` e têm o rótulo escrito no template. Eram os únicos sem
`aria-label`/tooltip, e **o teste C pegou isso**. Corrigidos.

## 8. RBAC — o ponto que mais me preocupou

**O flyout clona os itens já renderizados no DOM**, em vez de ler o
`menuConfig`.

A diferença importa: `gerarMenuHTML` só escreve no DOM os itens que
`desenharMenuComAcesso` liberou para o perfil. Ler o `menuConfig` traria
**todos** os itens, inclusive os que a pessoa não pode ver — e um flyout seria a
porta perfeita para esse vazamento.

O teste G verifica as duas coisas: que o flyout usa `querySelectorAll('.menu-item')`
e que **não menciona `menuConfig`**.

Verificado também que nada de permissão mudou:

- **175 prefixos** no mapa de API — igual (teste N);
- **190 itens** no menu — igual (teste O);
- `desenharMenuComAcesso` intacto.

## 9. Botões

### Tamanho: não mudou

O achado da Fase 3.1 foi respeitado. `.btn` continua em `0.88em` (~12,3px) e
`.btn-sm` em `0.8em`. O teste M **reprova** se alguém mexer no `font-size` neste
bloco.

O que mudou é o que não altera a largura do texto:

| Mudança | Por quê |
|---|---|
| `min-height` 32 / 27 / 38px | a altura dependia do conteúdo; botões vizinhos saíam desiguais na mesma toolbar |
| `hover: transform: none` | `translateY(-1px)` fazia a toolbar inteira tremer ao passar o mouse |
| `active: translateY(1px)` | afunda ao clicar, que é o gesto esperado |
| `disabled: pointer-events: none` | botão desabilitado **ainda aceitava clique** |
| ícone `flex-shrink: 0` + tamanho fixo | ícone esticava em botão estreito |

### Cor: um defeito de contraste encontrado e corrigido

`.btn-danger` e `.btn-success` usavam **cor fixa** (`#b91c1c`, `#059669`) — não
acompanhavam o tema. E, medido o contraste com texto branco:

```
.btn-success  #059669  →  3,77:1     abaixo de AA (4,5)
.btn-primary  #3b82f6  →  3,68:1     no tema escuro, também abaixo
```

Um botão de ação principal com texto ilegível é defeito, não estética.

Botão sólido precisa de **dois** critérios ao mesmo tempo — e é por isso que não
dá para reusar `--danger`/`--success` direto (no escuro são claros demais para
texto branco):

1. texto branco sobre o botão **≥ 4,5:1**;
2. botão contra o fundo da página **≥ 3:1** — nos **dois** temas.

Medi candidatos até achar os que passam em tudo:

| Token | Cor | Texto branco | vs fundo escuro | vs fundo claro |
|---|---|--:|--:|--:|
| `--btn-primary-bg` | `#2563eb` | **5,17** | **3,64** | **4,69** |
| `--btn-danger-bg` | `#dc2626` | **4,83** | **3,90** | **4,38** |
| `--btn-success-bg` | `#047857` | **5,48** | **3,43** | **4,97** |

Ficam em tokens próprios em vez de sobrescrever `--accent` e companhia: aquelas
cores servem a texto e borda, onde o requisito é outro.

O teste M2 recalcula os três critérios a cada execução.

### Hierarquia

A hierarquia já existia; agora está consistente: **primário** (sólido azul),
**secundário** (fundo de apoio com borda), **ghost** (sem fundo), **perigo**
(sólido vermelho), **sucesso** (sólido verde), **só-ícone** (quadrado).

**Não normalizei as telas.** As 39 combinações de classe do ERP continuam como
estão — incluindo os 81 `btn btn-sm` sem variante. Isso é hierarquia de tela, não
de componente, e o pedido manda deixar para depois.

## 10. Temas

Todo o CSS desta fase usa **apenas tokens** — o teste J/K varre o bloco e reprova
qualquer cor literal (exceto `#fff` sobre fundo de acento e `rgba(0,0,0,…)` de
sombra).

**Tema `custom:` legado preservado.** O teste L monta o menu com os dois valores
reais de produção (`custom:#f5f7f9:#021a40` e `custom:#030202:#114283`) e confere
que ele monta e resolve a base corretamente. `paletaCustom` intacta.

## 11. Testes

`scripts/test-sidebar-botoes.js` — **23 testes, 23 OK**. Ele **monta o menu de
verdade** (vm + DOM simulado) e inspeciona o HTML resultante; não é regex sobre o
fonte, precaução tirada direto do relatório 24, onde 14 testes verdes rodaram
sobre um arquivo que nem parseava.

Cobertura contra a lista da Parte 14: A ✔ B ✔ C ✔ D ✔ E ✔ F ✔ G ✔ H ✔ I ✔ J ✔
K ✔ L ✔ M ✔ N ✔ O ✔ P ✔

**Regressão — zero falhas novas:**

| Suíte | |
|---|---|
| `npm run verify` | **OK, 1,2 s** (523 + 23 + 425 + shell + tema) |
| `test-sidebar-botoes` | **23 ok** |
| `test-shell-boot` | 24 ok |
| `test-tema-global` | 21 ok |
| `test-pdv-visual` | 32 ok |
| `test-pdv-fluxo` | 29 ok |
| `test-pdv-rbac` | 11 ok |
| `test-fase1-funcional` | 57 ok |
| `test-governanca-percentual` | 29 ok |
| `test-app-backend` | 79 ok |
| `test-alcadas` | 41 ok |

Servido e conferido pelo processo em execução: `sidebar.js` (75.787 B) **parseia**,
e `data-tooltip`, `abrirFlyout`, `sb-tooltip`, `sb-flyout`, `--btn-primary-bg`
estão no que o servidor entrega.

## 12. Limitações visuais — leia antes de julgar

**Não vi nenhuma tela renderizada.** A extensão do Chrome recusa `localhost` e o
domínio do tenant não resolve dela. Como a Parte 15 pede: **não afirmo que ficou
bom.** Afirmo o que foi medido — tokens, contraste calculado, estrutura do HTML,
ausência de cor fixa, e que nada quebrou.

**O que precisa do seu olho, em ordem de risco:**

1. **os ícones dos itens agora aparecem na barra expandida.** É a mudança mais
   visível desta fase. Com 190 itens, pode ficar ótimo ou poluído — só olhando;
2. **o tooltip**: posição, atraso de 120 ms, se cobre algo;
3. **o flyout**: se abrir por clique é natural, se a posição acerta perto do
   rodapé, se fecha quando se espera;
4. **a densidade da sidebar**: 2px a mais por item × 190 itens muda a rolagem;
5. **os botões** nos dois temas — especialmente `.btn-primary` e `.btn-danger`,
   cujas cores mudaram por contraste;
6. **Pedidos PDV** com a barra recolhida, que é o caso de uso do flyout.

As mudanças são **fáceis de ajustar**: estão concentradas em dois blocos no fim
de `sidebar.css` e um no fim de `app-modern.css`. Nenhuma regra específica de
tela foi criada, justamente para caber ajuste depois dos seus prints.

## 13. Riscos restantes

| Risco | Gravidade | Situação |
|---|---|---|
| ícones visíveis poluírem a barra expandida | média | reversível em 1 regra CSS |
| flyout por clique não ser descoberto pelo usuário | média | o cabeçalho ganha fundo no hover e `aria-expanded`; mas só o uso real dirá |
| densidade maior aumentar a rolagem | baixa | +2px por item |
| **210 `!important`** vencendo as regras novas em telas específicas | média | dívida do relatório 27; nenhuma nova foi adicionada |
| 5.764 estilos inline | média | intocados, mapeados no relatório 26 |
| telas com CSS local (114) podem ignorar os botões novos | baixa | esperado; refino por herança |

## 14. Conclusão: **GO PARA REVISÃO VISUAL**

A Fase 3.2 está completa e testada:

- sidebar modernizada sem perder densidade nem funcionalidade;
- tooltip real, com o nome vindo do menu, fora do overflow, acessível por teclado;
- flyout que **herda o RBAC por construção**;
- botões com estados consistentes, **tamanho preservado** e um defeito de
  contraste corrigido;
- 23 testes novos, zero regressões, nenhum HTML tocado, nenhum restart.

**Paro aqui.** Não inicio a topbar nem a nova logo — como combinado, você olha os
resultados primeiro.

**Para revisar:** recarregue com **Ctrl+F5** (o navegador tem `sidebar.css` e
`sidebar.js` antigos em cache) e teste a barra recolhida em
`/comercial/pedidos-pdv.html`, que é onde ela entra automaticamente.
