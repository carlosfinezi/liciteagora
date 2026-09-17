# 25 — Correção: shell do ERP não montava após a mudança de tema

**Data:** 2026-09-11
**Gravidade:** o ERP inteiro abria numa tela vazia — sidebar, logo, menu,
cabeçalho, iframe e conteúdo, nada aparecia.
**Estado:** **corrigido.** Nenhum restart necessário; nenhum dado alterado.

---

## 1. Causa raiz

Uma **crase** dentro de um comentário HTML que vive dentro de uma **template
literal** em `public/js/sidebar.js`.

Ao remover o item "Cor do Sistema" do menu (relatório 24), escrevi o comentário
que explica a remoção. O comentário está dentro da template string que gera o
HTML da sidebar — e usei crases para citar nomes de código:

```js
        <!-- "Cor do Sistema" saiu daqui...
             funções continuam no arquivo — `abrirModalTema()` ainda existe e
             ...usuários têm um tema `custom:` salvo... -->
```

Numa template literal, a crase **fecha a string**. As quatro crases desse
comentário partiram a string ao meio, e o que vinha depois virou código inválido.
O arquivo inteiro deixou de parsear.

**Consequência:** o navegador descarta um `<script>` que não parseia. Como todo o
shell — menu, roteamento por hash, iframe, botão de tema — vive em `sidebar.js`,
nada rodava. O CSS carregava normalmente, e era por isso que restava exatamente o
que se via: **o fundo, e mais nada**.

O erro é meu, e é o tipo de armadilha que só existe em código que gera código:
citar um identificador com crase é natural em comentário de JavaScript, e fatal
dentro de uma template literal.

## 2. A primeira exceção

```
$ node --check public/js/sidebar.js
public/js/sidebar.js:811
             funções continuam no arquivo — `abrirModalTema()` ainda existe e
                                             ^^^^^^^^^^^^^^
SyntaxError: Unexpected identifier 'abrirModalTema'
```

Não é exceção de runtime: é **erro de parsing**, anterior a qualquer execução.
Por isso nenhuma função do shell chegou a ser definida — `initShell`,
`montarMenu`, `gerarMenuHTML`, todas inexistentes. O `initShell()` da linha 32 do
`app.html` teria dado `ReferenceError`, mas àquela altura o problema já estava
feito.

**O tema não era o culpado.** `theme-boot.js` estava correto e funcionava; a
falha foi uma linha de comentário na mesma edição.

## 3. Por que os testes anteriores não pegaram

Duas lacunas somadas, e as duas merecem registro:

**a) `npm run verify` não olha `public/`.**

```json
"verify": "find . scripts -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check"
```

`find . scripts -maxdepth 1` alcança os `.js` da **raiz** e de **`scripts/`**.
`public/js/sidebar.js` nunca foi verificado por ele — nem antes, nem agora. O
verify passou verde com o arquivo quebrado, e passar verde era exatamente o que
me fez seguir em frente.

**b) O teste do tema lia `sidebar.js` como TEXTO.**

`test-tema-global.js` usa regex para extrair `baseDoTema` e conferir o menu.
**Texto quebrado casa com regex do mesmo jeito** — o arquivo não precisa ser
JavaScript válido para um `String.match` funcionar. Os 14 testes passaram sobre
um arquivo que o navegador recusaria.

A lição é a que já estava escrita no CLAUDE.md para o JS inline dos HTML, e que
eu apliquei lá mas não aqui: **verificação de sintaxe precisa ser execução de
parser, não leitura de texto.**

## 4. Arquivo responsável

`public/js/sidebar.js`, linha 811 — editado por mim no relatório 24. Nenhum outro
arquivo estava quebrado: os demais `public/js/*.js` e os 425 blocos inline das
213 telas parseavam normalmente.

## 5. Correção

1. **Crases removidas do comentário**, com um aviso no próprio lugar explicando
   por que não podem voltar:

   ```
   SEM CRASES NESTE COMENTARIO: ele esta dentro de uma template
   literal, e uma crase aqui FECHA a string e quebra o arquivo
   inteiro - foi exatamente o que derrubou o shell (relatorio 25).
   ```

2. **O tema virou não-fatal** (item 7 do pedido). Não foi o que causou esta
   falha, mas a regra é correta e agora está no código:

   - `montarBotaoTema()` inteiro em `try/catch` — se o botão não puder ser
     criado, registra aviso no console e **o shell continua**;
   - `aplicarTema()` em `try/catch` — preferência estranha cai no escuro em vez
     de propagar exceção.

**Nada foi desfeito** (item 9): tema claro, tema escuro, custom legado,
preferência por usuário, anti-flash e botão no topo — todos preservados. O
anti-flash não era o culpado e não precisou ser sacrificado.

## 6. Estados de tema testados

Todos com o shell montando — **12 estados**, cada um um teste:

| Estado | Resultado |
|---|---|
| sem `appTheme` | monta, `data-theme=escuro` |
| `padrao` | monta, escuro |
| `claro` | monta, claro |
| `escuro` | monta, escuro |
| string vazia | monta, escuro |
| valor inválido (`xpto-invalido`) | monta, escuro |
| `custom:#ffffff:#1f6dea` | monta, claro |
| **`custom:#f5f7f9:#021a40`** (1bit/admin, real) | monta, claro |
| **`custom:#030202:#114283`** (produtosbomgosto/admin, real) | monta, escuro |
| `custom:#zzz` (malformado) | monta, escuro |
| `custom:#ffffff` (sem accent) | monta, escuro |
| `custom:::::`(lixo) | monta, escuro |

Em todos, `data-theme` termina como `claro` ou `escuro` — **nunca fica sem**. E
preferência inválida não gera exceção, só cai no padrão.

## 7. Páginas e recursos verificados

Recursos do shell, servidos pelo processo em execução:

| Recurso | HTTP | MIME |
|---|---|---|
| `/app.html` | 200 | `text/html` |
| `/js/theme-boot.js` | 200 | `text/javascript` |
| **`/js/sidebar.js`** | 200 | `text/javascript` — **e o arquivo servido parseia** |
| `/js/menu-config.js` | 200 | `text/javascript` |
| `/js/icons.js` | 200 | `text/javascript` |
| `/css/sidebar.css` | 200 | `text/css` |
| `/css/app-modern.css` | 200 | `text/css` |

Nenhum 404, nenhum MIME errado, nenhum conteúdo inesperado.

As três rotas pedidas respondem **200**:
`/comercial/pedidos-pdv.html` · `/comercial/pedidos.html` · `/catalogo/produtos.html`

## 8. Teste novo contra a regressão

`scripts/test-shell-boot.js` — **24 testes, 24 OK**. Fecha as duas lacunas da §3:

| Bloco | O que faz |
|---|---|
| **A1** | **Todo `.js` de `public/` passa por `new vm.Script`** — parsing de verdade, não regex. É a verificação que faltava. |
| **A2** | Nenhuma crase dentro de comentário HTML em `public/js/` — a armadilha exata, checada por nome. |
| **A3** | O JS inline das 213 telas parseia. |
| **B** | O shell **monta** em DOM simulado: `initShell` e `montarMenu` existem, o HTML sai com `.sidebar-menu`, logo, grupo Conta com Senha/Sair, sem o item "Cor do Sistema" — **e com o modal legado preservado**. |
| **C** | Os 12 estados de tema da §6. |
| **D** | Falha ao criar o botão **não** interrompe o boot; `aplicarTema` não lança com valor absurdo. |
| **E** | `app.html` com iframe e ordem correta de scripts; `theme-boot` não chama nada de `sidebar.js` nem toca em `document.body`. |

O DOM é um objeto próprio, não jsdom — evita dependência nova, e se o código
chamar algo que o objeto não tem, o teste falha, que é o comportamento desejado.

### Prova de que o teste serve

Reintroduzi a crase de propósito e rodei:

```
node --check: FALHOU (correto)
FALHA A1. todo .js de public/ parseia -> Unexpected identifier 'abrirModalTema'
FALHA A2. nenhuma crase dentro de comentario HTML em public/js/
FALHA B1. theme-boot + menu-config + sidebar carregam sem lancar
FALHA C.  o shell monta com tema "sem appTheme"
```

Quatro frentes reprovando a mesma regressão. Arquivo restaurado em seguida:
24/24.

### Recomendação que fica em aberto

O `npm run verify` **continua sem olhar `public/`**. Não alterei o `package.json`
porque isso muda a rotina documentada no `CLAUDE.md`, e a decisão é sua. Duas
saídas:

- estender o verify para `public/js/` (uma linha no script), ou
- rodar `node scripts/test-shell-boot.js` junto do verify.

Enquanto nenhuma das duas for adotada, um erro de sintaxe em `public/js/` volta a
passar verde.

## 9. Regressão

| Suíte | Resultado |
|---|---|
| `npm run verify` | OK |
| **`test-shell-boot`** (novo) | **24 ok, 0 falha** |
| `test-tema-global` | 14 ok, 0 falha |
| `test-pdv-fluxo` | 29 ok, 0 falha |
| `test-pdv-rbac` | 11 ok, 0 falha |
| `test-fase1-funcional` | 57 ok, 0 falha |
| `test-governanca-percentual` | 29 ok, 0 falha |
| `test-app-backend` | 79 ok, 0 falha |
| `test-alcadas` | 41 ok, 0 falha |

## 10. Restart

**Nenhum.** A correção é em `public/js/sidebar.js`, arquivo estático — já está no
ar. Serviços intactos:

| Unidade | PID | Desde |
|---|---|---|
| `consulta-licitacoes.service` | 3777293 | 12:14:16 |
| `liciteagora.service` | 3085849 | 06:18:49 |

**Recarregue com Ctrl+F5** na primeira vez: o navegador guardou em cache a versão
quebrada do `sidebar.js`, e um refresh comum pode servi-la de novo.

## 11. Dados

**Nenhum dado foi alterado por esta correção** — ela mexe em um comentário e
acrescenta dois `try/catch` num arquivo de frontend.

Os 5 temas `custom:` legados seguem intactos em `users.tema`.

### Um pedido que apareceu, e não é meu

A conferência acusou **1 pedido `tipo='pdv'`** em `produtosbomgosto`, onde antes
havia 0. Investiguei antes de concluir:

```
#24  PED-2026-00020  rascunho  R$ 0,00  no_local
criado 2026-09-11 13:40:06 BRT
itens: 0 · reservas: 0 · movimentações: 0 · faturas: 0
```

Foi criado às **13:40 BRT — nove minutos antes** do meu mutirão do tema (13:49) e
por um caminho que eu não executei: **é você usando a tela Pedidos PDV**, que está
no ar desde a ativação da Fase 2.1. É um rascunho vazio, sem itens, que **não
reservou estoque nenhum** — o comportamento correto, e a confirmação prática do
que o relatório 22 §14 previa.

Os totais comerciais do tenant estão intactos: **R$ 46.069,50**, o mesmo valor dos
relatórios 18 e 21. O pedido novo tem valor zero e não os altera.

**Não o apaguei** — é dado seu, num tenant seu, e remover pedido de cliente não é
decisão minha. Se for massa de teste, o caminho é excluí-lo pela tela de Pedidos
(rascunho sem vínculo é excluível).

---

# Adendo — botão de tema sobrepondo o "+ Novo pedido" (Pedidos PDV)

**Data:** 2026-09-11, após a correção do shell. Correção **somente de layout**.

## A causa

Duas, encontradas na auditoria:

**1. O Pedidos PDV não recebia a reserva de espaço.** O ERP reserva o canto
superior direito em `.page-header { padding-right }` (app-modern.css), mas esta
tela **não usa `.page-header`** — tem cabeçalho próprio, `.pdv-topo`, porque
precisa dos modos de atendimento e de altura fixa. A regra global nunca a
alcançou, e o `#btnTema` (`position: fixed; right: 16px`) caía exatamente sobre o
**+ Novo pedido**, que é o último elemento à direita dali.

**2. A reserva global estava 4px curta — em todas as 212 telas.** Defeito meu do
relatório 24: o botão fica a `right: 16px` e tem `34px`, então sua borda esquerda
está a **50px** da margem; a reserva era de **46px**. Visualmente passava
despercebido, mas havia 4px de sobreposição real.

**3. (bônus, no mobile) A gaveta do pedido ficava sob o botão.** `.pdv-pedido`
era `z-index: 61` e o botão é `900` — ao abrir o carrinho no celular, o botão de
tema flutuava por cima dela.

## O ajuste

| Onde | Antes | Depois |
|---|---|---|
| `.pdv-topo` (desktop) | sem reserva | `padding-right: 58px` — 8px de folga |
| `.pdv-topo` (≤639px) | `padding: 10px 14px` | `padding: 10px 50px 10px 14px` |
| `.page-header` (desktop) | `46px` | **`54px`** — elimina os 4px de sobreposição |
| `.page-header` (≤768px) | `40px` | **`46px`** (o botão encolhe para 42px) |
| `.pdv-pedido` / `.gaveta-bg` | `61` / `60` | **`950` / `949`** |

**Nenhum segundo controle de tema foi criado** e o botão global não foi
duplicado — a tela apenas abre espaço para o que já existe.

Ordem de empilhamento final:

```
conteúdo / barra do carrinho   (auto)
#btnTema                        900
.gaveta-bg                      949
.pdv-pedido (gaveta)            950
.modal-bg                     10000
```

## Desktop

```
Pedidos PDV   [No local][Retirada][Entrega]        [Pendentes] [+ Novo pedido]  ☀️
```

Os três controles em linha, espaçamento uniforme (`gap: 12px`), alinhados
verticalmente pelo `align-items: center` do cabeçalho, sem sobreposição. O
**+ Novo pedido** continua `btn-primary`, destacado.

## Mobile e tablet

- a reserva acompanha o botão menor (42px ocupados, 50px reservados);
- as ações ficam mais compactas (`padding: 7px 10px; font-size: 0.82rem`) para
  caberem na primeira linha ao lado do título;
- se ainda não couberem, o `flex-wrap` do cabeçalho **quebra a linha** — nunca
  sobrepõe;
- a gaveta do pedido agora passa **por cima** do botão de tema;
- a barra fixa do carrinho fica no rodapé e o botão no topo: sem disputa.

**O botão não foi escondido em nenhuma largura.**

## Claro e escuro

O botão usa só tokens (`--bg-1`, `--border`, `--text-1`, `--bg-hover`,
`--border-strong`) e acompanha o tema nos dois sentidos — nada de cor fixa. O
cabeçalho do PDV também: `--bg-1` de fundo e `--border` na divisa.

## As outras páginas

**Nenhum dos 212 HTML comuns foi tocado** — verificado: o único `.html` alterado
nesta etapa é `pedidos-pdv.html`.

O que as alcança é uma linha de CSS: a reserva do `.page-header` passou de 46px
para 54px (e de 40 para 46 no mobile). O efeito é afastar os botões de ação 8px
a mais da borda, **corrigindo** a sobreposição de 4px que existia. Não há como
piorar: a reserva só cresceu, e o conteúdo dos cabeçalhos continua o mesmo.

## Testes

`test-tema-global.js` passou de 14 para **17 testes, 17 OK**, com três novos que
impedem a volta do problema:

- **D5** — a reserva do `.page-header` cobre o botão, no desktop e no mobile
  (calcula `right + width` e compara; é o teste que teria pego os 4px);
- **D6** — o PDV tem cabeçalho próprio e reserva o mesmo espaço; avisa se um dia
  ele passar a usar `.page-header`;
- **D7** — a gaveta fica acima do botão e abaixo dos modais.

Regressão: `verify` OK · `test-shell-boot` 24 · `test-pdv-fluxo` 29 ·
`test-pdv-rbac` 11 · `test-fase1-funcional` 57 · `test-app-backend` 79.
**Zero falhas novas.**

**Nada foi reiniciado** (PIDs 3777293 e 3085849) e nenhum dado foi tocado.

> Vale repetir a ressalva do relatório 24: **não vi a tela renderizada**. A
> sobreposição foi corrigida por medida — a conta entre o que o botão ocupa e o
> que o cabeçalho reserva —, e não por inspeção visual.

---

## 12. Próximo passo

1. **Abrir `/app.html#/comercial/pedidos-pdv.html` com Ctrl+F5** e confirmar que
   sidebar, logo, menu, cabeçalho, conteúdo e o botão de tema voltaram.
2. Se voltou, seguir com a **revisão visual dos dois temas**, que era o passo
   pendente do relatório 24 — e onde ainda ninguém olhou a tela renderizada.
3. Decidir sobre a cobertura do `verify` (§8).
