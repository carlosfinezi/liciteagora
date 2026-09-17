# 42 — Skeleton infinito na Venda rápida

**Data:** 2026-09-13
**Tela:** `/comercial/pedidos-pdv.html` · **Tenant do relato:** `produtosbomgosto`

---

## 1. A causa — e uma ressalva que vem primeiro

**Não consegui reproduzir o skeleton com o código e os dados de hoje.** Preciso
dizer isso antes de qualquer outra coisa, porque muda como ler o resto.

Rodei a tela contra a **produção real**, no tenant `produtosbomgosto`, com uma
sessão válida, pelo caminho que você usa (shell → menu):

```
200 /api/produtos  produtos=76   (31 ms)
skeletons: 0    cards: 76    cats: 4  →  Todos 76 · Outros 1 · PRODUTOS BOM GOSTO 59 · Sem categoria 16
console: limpo
```

As contagens batem exatamente com as que você viu. A tela, hoje, funciona.

O que fiz então foi outra coisa: **procurar toda condição capaz de produzir
aquele sintoma** e fechar cada uma. Achei três, e duas delas eu reproduzi.

### A condição principal: a requisição que nunca responde

`carregarProdutos()` fazia `await api('/api/produtos')` **sem prazo nenhum**. O
`fetch` não tem timeout próprio: se a resposta nunca chega, a promessa nunca
assenta, o código depois do `await` nunca roda, e o esqueleto fica na tela
**para sempre** — sem erro, sem console, sem botão.

Reproduzi ligando o servidor de teste para aceitar a conexão e nunca responder.
Resultado antes da correção: *"a grade ficou com 6 esqueleto(s) — loading
infinito"*. É o seu sintoma, palavra por palavra.

Isso acontece no mundo real quando o servidor é **reiniciado com uma requisição
em voo**, quando o celular troca de wi-fi para dados, ou quando um proxy segura
a conexão aberta. **E acontece igual no computador e no celular** — que é
exatamente o que você observou, e a razão de você estar certo ao dizer que não é
iOS, Safari, PWA nem service worker.

Confirmei que não é o service worker, aliás: ele tem uma allowlist de sete
arquivos (ícones e manifest) e **não cacheia tela nenhuma**.

### A segunda condição: um produto derruba o catálogo inteiro

```js
const c = (p.categoria || '').trim() || SEM_CATEGORIA;
```

Parece seguro e não é. A coluna é TEXT, mas **o SQLite guarda o que lhe derem**:
um produto importado com categoria numérica faz `.trim` deixar de existir →
`TypeError: (p.categoria || "").trim is not a function`.

Como isso estava dentro de um `.map()` único, a exceção abortava a expressão
inteira, `innerHTML` nunca era atribuído, e **76 produtos sumiam por causa de
um**. Reproduzi: com 5 produtos hostis misturados, a tela foi de 76 cards para
**zero cards e zero categorias**.

Hoje os dados estão sãos — conferi `typeof()` em `produtosbomgosto`, `1bit` e
`reimac`: `categoria` é sempre `text` ou `null`. É um defeito latente, não o que
te atingiu. Mas é latente por acaso, não por desenho.

### A terceira: o `catch` era o último recurso, e podia falhar

Se `pintarProdutos()` lançasse, o `catch` pintava o erro. Se o próprio `catch`
falhasse, o esqueleto sobrevivia. Era o único caminho compatível com a sua
descrição — **categorias preenchidas e grade em esqueleto** — porque
`pintarCategorias()` roda antes e já teria pintado `#cats`.

---

## 2. Onde exatamente quebrava

A cadeia, mapeada:

```
abrir a tela
  └─ carregarProdutos()                     ← única função de carga
       ├─ pintarSkeleton()                  ← pinta os 6 esqueletos em #grade
       ├─ await api('/api/produtos')        ← ❶ SEM PRAZO: pendura aqui para sempre
       ├─ PRODUTOS = d.produtos.filter(ativo)
       ├─ se vazio → estado "Nenhum produto cadastrado"
       ├─ pintarCategorias()                ← ❷ .trim() em não-string derruba tudo
       └─ pintarProdutos()                  ← ❷ .map() único: um item ruim = grade vazia
     catch → estado de erro                 ← ❸ se ele falhar, o esqueleto fica
```

Não há segunda requisição. **Categorias e produtos vêm do mesmo `GET
/api/produtos`** — as categorias são derivadas de `produtos.categoria` no
próprio navegador, e as contagens saem de um `Map` local. É por isso que
"categorias carregam mas produtos não" é um estado tão informativo: significa
que a resposta chegou inteira e a quebra foi **depois**, entre uma função e a
seguinte.

---

## 3. Endpoints

| Endpoint | Status | Tempo | Conteúdo |
|---|---|---|---|
| `GET /api/produtos` | 200 | 31 ms | `success: true`, **76 produtos**, com `saldo` |
| `GET /api/perfis/meu-acesso` | 200 | — | ok |
| `GET /api/features/status` | 200 | — | ok |
| `GET /api/estabelecimentos` | 200 | — | ok |
| `GET /api/tenant-atual` | **404** | — | ver nota |

Não me contentei com o 200: validei o corpo. Os 76 produtos vêm com `id`, `sku`,
`descricao`, `precoVenda` e `saldo` (calculado por `SUM` das movimentações no
próprio SQL). Nenhum campo nulo onde não devia.

**A nota do 404:** `/api/tenant-atual` responde 404 porque meu teste usa
`Host: produtosbomgosto.liciteagora.app:3000` — com a porta, o `Host` deixa de
casar com o slug. É artefato do meu ambiente de teste, não um defeito: em
produção, pela porta 443, o Host chega limpo. E essa rota **não participa** da
carga de produtos.

**Não há dependência de preço, estoque, tabela de preço, vendedor, depósito ou
configuração fiscal** no carregamento inicial. O `saldo` vem no mesmo SELECT.
Não existe chamada secundária que possa ficar pendente — o que torna a ausência
de timeout na chamada principal ainda mais determinante.

---

## 4. Frontend, backend ou dados?

**Frontend.** O backend responde certo e rápido, e os dados estão sãos.
Nenhuma linha de backend foi alterada nesta rodada.

---

## 5. Algum produto específico?

**Não, nos dados atuais.** Verifiquei os tipos coluna a coluna em três tenants e
não há nenhum valor capaz de disparar o `TypeError` hoje. O defeito do `.trim()`
é real e demonstrável, mas está dormindo.

---

## 6. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/comercial/pedidos-pdv.html` | timeout com `AbortController`; `finally` como trava final; `catDe()`; render item a item; `pintarErroProdutos()`; `api()` preserva `AbortError` |
| `scripts/test-venda-rapida-carga.js` | **novo** — 18 asserções no Chrome |
| `scripts/verify.js` | passo 16 |
| `scripts/test-pdv-visual.js` | 2 ajustes, explicados em §12 |

**Nenhuma mudança de backend, schema, migration ou variável de ambiente.**

---

## 7. A correção

**Prazo para a resposta.** `AbortController` com 12 s — folgado para uma consulta
que leva 31 ms; o limite existe para o caso patológico, não para o lento. O
`api()` foi ajustado para **preservar o `AbortError`**, que antes se perdia na
tradução de mensagem de rede; sem isso não daria para distinguir "não respondeu"
de "sem internet".

**Categoria sempre como texto.** `catDe(p)` faz `String(p.categoria).trim()`.
Custa nada e tira a lista da mão do dado.

**Um produto ruim fica sozinho.** O `.map()` virou laço com `try/catch` por
item: o defeituoso é o único que falta, os outros aparecem, e o id vai para o
console — que é o que permite corrigir o cadastro na origem. A tela ainda avisa
*"N produto(s) não puderam ser exibidos"* com os códigos, em vez de simplesmente
escondê-los.

---

## 8. O loading sempre termina

Quatro desfechos, e nenhum é esqueleto:

| Situação | O que aparece |
|---|---|
| Produtos | os cards |
| Catálogo vazio | "Nenhum produto cadastrado" + onde cadastrar |
| Erro / resposta inválida | "Não foi possível carregar os produtos" + **Tentar novamente** |
| Sem resposta em 12 s | "O servidor demorou para responder…" + **Tentar novamente** |

E uma trava final, no `finally`:

```js
if (!terminou || $('grade').querySelector('.skel')) { … pintarErroProdutos(…) }
```

Se nenhum caminho assumiu a grade — inclusive por uma falha **dentro do
`catch`**, que era o único jeito de o esqueleto sobreviver — ela pinta o erro
assim mesmo. **Não é timeout escondendo causa**: a causa foi corrigida acima; a
trava é a garantia de que um caminho que eu não previ não volte a deixar cinza
para sempre.

O teste A3 verifica que nada de `Load failed`, `Failed to fetch`, `TypeError`,
`undefined`, `null` ou `HTTP 500` chega à tela. O rastro completo vai para o
console.

---

## 9. Testes

`scripts/test-venda-rapida-carga.js` — **18 asserções**, rodando a tela real no
Chrome com o catálogo real do `produtosbomgosto` (lido em somente-leitura) e
respondendo `/api/produtos` de seis formas: normal, vazio, erro 500, HTML em vez
de JSON, sem o campo `produtos`, e **nunca respondendo**.

A regra é uma só, aplicada a todos: *a grade não pode terminar com um `.skel`*.

Cobre também: um produto derrubar os outros, categoria numérica, produto sem
imagem, nome vazio, preço inválido, aspas e tags na descrição, troca de
categoria, busca sem resultado, o card levar ao `addItem`, as seis larguras, e
que a tela não carrega slug/tenant/organização fixos.

---

## 10. Sabotagens

| Sabotagem | Reprovou |
|---|---|
| tirar o `AbortController` | `A4` — *"a grade ficou com 6 esqueleto(s) — loading infinito"* |
| voltar `(p.categoria \|\| '').trim()` | `B1`, `B2`, `B3` — *"0 cards para 76 produtos sãos"* |
| voltar o `.map()` único | `B1` — *"os produtos válidos sumiram"* |
| remover a trava do `finally` | `A3` e `A5` — esqueleto no erro 500 e na resposta inválida |

A primeira reproduz **literalmente** o seu sintoma. Código restaurado após cada
uma.

---

## 11. Resultados

```
npm run verify — 16 passos, 142,3 s, todos verdes

  16. carga da venda rapida (test-venda-rapida-carga)   18 ok, 0 falha(s)
```

Suítes relacionadas:

| Suíte | Resultado |
|---|---|
| `test-pdv-fluxo` | 29 ok, 0 falha |
| `test-pdv-rbac` | 11 ok, 0 falha |
| `test-pdv-visual` | 32 ok, 0 falha |
| `test-pdv-natureza` | 20 asserts, 0 falha |
| `test-venda-rapida-nav` | 15 ok, 0 falha |
| `test-app-backend` | 79 ok, 0 falha |
| `test-fase0-pagamento-pedido` | 15 ok, 0 falha |
| `test-fase1-funcional` | 57 ok, 0 falha |
| `test-fase1-desconto-origem` | 57 ok, 0 falha |
| `test-isolamento-tenant` | 20 ok, 0 falha |
| `test-menu-oculto-rbac` | 15 ok, 0 falha |
| `test-orcamento-pwa` | 43 ok, 0 falha |

---

## 12. Os dois testes que ajustei, e por quê

Ambos falharam por **casar a forma, não o comportamento** — e ambos por causa da
própria correção:

- **`B3`** exigia o texto literal `"Tentar de novo"`. Troquei o rótulo para
  **"Tentar novamente"**, que é o texto do seu item 10. A garantia — existir
  caminho de volta — continua verificada; o regex agora aceita as duas redações.
- **`C1`** casava `$('grade').innerHTML = lista.map(…)`. Esse `.map()` único *é*
  o bug: substituí-lo pelo laço isolado por item foi a correção. A garantia — o
  placeholder ser monograma e não 📦 — continua verificada, agora na função
  `card()`.

Não mexi em mais nenhum teste para ficar verde.

---

## 13. Desktop e mobile

Medido no Chrome, com a tela dentro do iframe do shell:

| Largura | Cards | Esqueleto | Estouro horizontal |
|---|---|---|---|
| 320 / 360 / 375 / 390 / 430 px | 76 | 0 | 0 px |
| 1280 px | 76 | 0 | 0 px |

Busca, troca de categoria e o painel do pedido continuam acessíveis em todas.

**Não testei em aparelho físico** — não tenho iPhone nem Android aqui.

---

## 14. Backend, restart e dados

**Nenhuma mudança de backend.** **Nenhum restart necessário** — só
`public/comercial/pedidos-pdv.html` mudou, e estático já está no ar ao salvar.

**Nenhum pedido foi criado no tenant de produção.** Confirmei depois dos testes:
`produtosbomgosto` tem **um** pedido tipo `pdv`, o `PED-2026-00021`, cancelado,
de 11/09 — anterior a tudo isto. Todo teste que grava roda em banco descartável;
o que tocou produção foi só leitura.

Recarregue a página com **Ctrl+Shift+R** (computador) ou feche e reabra o PWA
(celular) para o navegador soltar a versão anterior da tela.

---

## 15. O que testar

**No computador (2 min):**

1. Ctrl+Shift+R em COMERCIAL → Pedidos → Venda rápida. Os produtos devem
   aparecer no lugar do esqueleto.
2. Clique numa categoria e depois em "Todos".
3. Busque algo que não existe → deve dizer "Nenhum produto encontrado", **sem
   esqueleto**.
4. Com F12 aberto, na aba Rede, marque **Offline** e clique em "Tentar
   novamente" → em até 12 s deve aparecer a mensagem com o botão. *Este é o
   passo que exercita a correção principal.*

**No iPhone (1 min):** feche o PWA no alternador, reabra, entre na Venda rápida
e confirme que os cards aparecem — no wi-fi e nos dados móveis.

**Se o esqueleto voltar**, agora ele vira mensagem em até 12 s. Me diga qual das
duas apareceu ("demorou para responder" ou "não foi possível carregar") — elas
apontam para causas diferentes e isso encurta o próximo diagnóstico.

---

## 16. O que não foi tocado

`pedido.html`, PDF de orçamento, WhatsApp, link público, card mobile dos itens,
CFOP, paginação do PDF e ações do orçamento — nada. Nenhuma regra de preço,
estoque, RBAC ou tenant. A tela continua sem slug, `organizationId` ou tenant
fixo (teste `E1`), e o isolamento multi-tenant segue verde.

---
---

# Teste real do usuário após a primeira correção

**Data:** 2026-09-13 · **Evidência:** teste no computador, com imagem da tela.

O usuário reportou que, depois da Fase 42, a tela **continuava igual**:
categorias com as contagens certas (76 / 1 / 59 / 16) e a grade central "somente
com os skeletons cinza". Isso contradizia o meu resultado — `skeletons: 0,
cards: 76`.

**Ele estava certo, e eu estava errado. As duas medições eram verdadeiras ao
mesmo tempo.**

## 1. Por que continuava com "skeleton"

Não era skeleton. **Eram os 76 cards, achatados a 15 pixels de altura.**

A `.foto` do card usa `aspect-ratio: 1/1` e não tem altura própria. Ao calcular
a altura INTRÍNSECA da linha do grid, o navegador ainda não conhece a largura
final da coluna `1fr` e resolve a proporção contra zero. As linhas nasciam com
**13,5px**; o `overflow: hidden` do card cortava o resto.

Medido, com a tela real no Chrome:

| | antes | depois |
|---|---:|---:|
| altura do card | **15 px** | 286 px |
| altura da foto | **0 px** | 189 px |
| `.info` dentro do card | 95 px (cortado) | 95 px |
| altura do esqueleto | 243 px | 243 px |
| `scrollHeight` da grade | 761 px (não rolava) | 7803 px |

O resultado na tela eram 76 tiras cinza empilhadas. E o cinza é o mesmo:
`.skel .bloco` usa `--bg-3`; `.card-prod .foto.sem-img` usa um gradiente de
`--bg-3`. Some-se que **os 76 produtos deste tenant não têm foto** (`imagemPath`
vazio em todos) e que `.card-prod[disabled]` aplica `opacity: .72` enquanto não
há pedido aberto. Descrever aquilo como "skeletons cinza" foi exato.

No celular era pior: medido em 320–430px, o card ficava com **2 a 4 pixels**.

## 2. Por que o meu teste mostrava 76 cards

**Porque ele contava elementos no DOM.** `document.querySelectorAll('.card-prod').length`
devolvia 76 — e devolvia mesmo com cada card medindo 15px. Os cards existiam;
ninguém conseguia vê-los.

Foi um teste que mediu ao lado do que importava. A pergunta certa nunca foi
"quantos cards existem", e sim **"o usuário vê os produtos"** — que se responde
com geometria, não com contagem.

Aconteceu porque construí o teste a partir do relato "skeleton infinito" e fui
verificar `.skel`; ao não encontrar nenhum, dei o caso por resolvido sem olhar o
que havia ficado no lugar. Só encontrei a causa depois de **renderizar a grade
em imagem e olhar**.

## 3. O que descartei antes de chegar aqui

Cada um por medição, não por suposição:

- **Arquivo antigo sendo servido** — busquei a tela pelo caminho real (nginx,
  443, com sessão) e comparei com o Node e com o disco: **MD5 idêntico nos
  três**, e as assinaturas da Fase 42 (`TIMEOUT_PRODUTOS`, `AbortController`,
  `catDe`, `pintarErroProdutos`) presentes nas três cópias.
- **nginx / proxy / cache** — o vhost `produtosbomgosto.liciteagora.app.ssl.conf`
  é proxy limpo para `127.0.0.1:3000`, sem cache. Headers: `Cache-Control:
  public, max-age=0` + ETag, que obriga revalidação.
- **Cache do navegador** — reproduzi o ciclo completo num Chrome com perfil
  persistente: versão com defeito → troca no servidor → reabrir pelo menu, com
  o iframe navegado por JavaScript. O navegador pegou a versão nova
  imediatamente, sem hard reload.
- **Service worker** — allowlist de sete arquivos (ícones e manifest), com
  `skipWaiting` e `clients.claim`. Nunca cacheou HTML.
- **`<button>` vs `<div>`** — troquei o card por div: colapsava igual. Não era o
  elemento.

## 4. A causa definitiva

Ausência de `grid-auto-rows` na `.grade`, com filhos cuja altura depende de
`aspect-ratio`. As três correções que testei devolveram o card a 286px;
escolhi a que diz exatamente o que se quer.

## 5. A correção

Uma linha em `public/comercial/pedidos-pdv.html`:

```css
.grade { …; grid-auto-rows: max-content; … }
```

Cada linha do grid passa a valer o seu conteúdo, em vez de uma altura calculada
antes de a foto existir.

**Nada mais mudou.** As correções da Fase 42 (timeout, `catDe`, render item a
item, trava do `finally`) continuam — são robustez legítima e cobrem falhas
reais, mas **nenhuma delas era a causa do que você viu**. Registro isso porque a
Fase 42 foi apresentada como solução e não era.

## 6. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/comercial/pedidos-pdv.html` | `grid-auto-rows: max-content` na `.grade` |
| `scripts/test-venda-rapida-carga.js` | `A1b`, `A1c` novos; o bloco `D` passa a medir geometria |

## 7. Testes

O teste agora mede **altura do card, altura da foto, área do preço e
`scrollHeight` da grade**, em todas as larguras — não só a contagem. E compara o
card carregado com o esqueleto: se o card ficar menor que ele, reprova, porque
na tela isso é indistinguível de "ainda carregando".

**Sabotagem** — removi o `grid-auto-rows` e o teste reprovou em 8 asserções:

```
A1b -> card com 13px de altura — achatado, o usuário vê uma tira cinza
A1c -> card (13px) muito menor que o esqueleto (243px):
       na tela a grade carregada parece continuar carregando
D    -> em 320px o card ficou com 2px — achatado   (e 360/375/390/430/1280)
```

## 8. Resultados

```
npm run verify — 16 passos, 156,5 s, todos verdes
  16. carga da venda rapida   20 ok, 0 falha(s)
```

Relacionadas, todas verdes: `test-pdv-fluxo` 29, `test-pdv-rbac` 11,
`test-pdv-visual` 32, `test-pdv-natureza` 20, `test-venda-rapida-nav` 15,
`test-app-backend` 79, `test-isolamento-tenant` 20, `test-menu-oculto-rbac` 15,
`test-orcamento-pwa` 43.

**Contra a produção real** (`produtosbomgosto`, sessão válida, pelo shell):

```
cards: 76   altura do card: 284px   altura da foto: 189px   rolagem: 7734px
```

## 9. Restart

**Não precisa.** Só um arquivo de `public/` mudou — estático já está no ar.

Recarregue com **Ctrl+Shift+R**. Se ainda vier achatado, é cache do navegador; o
teste do ciclo persistente mostrou que ele pega a versão nova sozinho.

## 10. O que testar

Abra COMERCIAL → Pedidos → Venda rápida. Os produtos devem aparecer como
**cards altos**, cada um com um quadrado com duas letras (o monograma, porque
esses produtos não têm foto), o **preço em destaque**, o nome e o saldo. A grade
deve **rolar** — 76 produtos não cabem numa tela.

Se ainda parecer cinza, o que me diz mais é: **aparece "R$" legível em cada
bloco?** Se sim, são cards; se não, ainda é o colapso.

---
---

# Continuação: as categorias não filtravam

**Data:** 2026-09-13 · Relatado logo após a correção dos cards.

Com os produtos aparecendo, apareceu o próximo: a busca filtrava, mas clicar em
"Outros", "PRODUTOS BOM GOSTO" ou "Sem categoria" não fazia nada. Só "Todos"
respondia.

## 1. Causa exata

O botão era montado assim:

```js
onclick="filtrarCat(${JSON.stringify(c)})"
```

`JSON.stringify` de uma string devolve **aspas duplas** — e o atributo `onclick`
também é delimitado por aspas duplas. O HTML saía partido no meio:

```html
<button class="cat-item" onclick="filtrarCat(" produtos="" bom="" gosto")"="" title="PRODUTOS BOM GOSTO">
```

O valor do atributo terminava em `filtrarCat(`. Clicar lançava, medido no
navegador:

```
SyntaxError: Failed to execute 'click' on 'HTMLElement': Unexpected end of input
```

**"Todos" funcionava porque é `filtrarCat(null)`** — sem aspas, o único que não
quebrava o atributo. Isso explica exatamente o que você viu: um item da lista
respondendo e os outros três não.

Não era o filtro: a busca já provava que a grade filtra. Era o clique nunca
chegar a `filtrarCat`.

## 2. Por que os testes não pegaram

Os testes de PDV verificavam que **existe** `onclick` no HTML — e existia. Um
atributo truncado continua sendo um atributo. Só clicar de verdade revelaria.

## 3. Correção

`public/comercial/pedidos-pdv.html`, três peças:

**O botão guarda o índice, não o nome.** `data-idx="${i}"` é um número: não tem
aspas, acento, espaço nem o sentinela de "sem categoria". Nenhum nome de
categoria — venha do cadastro, de importação ou de onde for — pode voltar a
quebrar o HTML.

**Um ouvinte no contêiner, não em cada botão.** `pintarCategorias` reescreve o
`innerHTML` a cada troca, destruindo os botões; preso a `#cats`, que nunca é
substituído, o ouvinte sobrevive a todos os redesenhos.

**`filtrarCat(undefined)` cai em "Todos"**, em vez de virar um filtro que não
casa com nada e deixar a grade vazia sem explicação.

A busca não foi tocada: `filtrarCat` chama `pintarProdutos`, que lê o campo de
busca — a interseção sai de graça, e "Todos" remove só a categoria.

## 4. Clique real, no navegador

```
"Outros"             -> 1 card    ativo: Outros
"PRODUTOS BOM GOSTO" -> 59 cards  ativo: PRODUTOS BOM GOSTO
"Sem categoria"      -> 16 cards  ativo: Sem categoria
voltar em "Todos"    -> 76 cards
erros JS: (nenhum)
```

**Contra a produção real** (`produtosbomgosto`, sessão válida, pelo shell) — e o
catálogo já mudou desde ontem, o que torna a prova mais forte:

```
total: 74
  "CHÁS"               -> esperado 2,  obtido 2,  card 267px
  "Outros"             -> esperado 1,  obtido 1,  card 267px
  "OUTROS"             -> esperado 4,  obtido 4,  card 284px
  "PRODUTOS BOM GOSTO" -> esperado 49, obtido 49, card 284px
  "TEMPEROS"           -> esperado 5,  obtido 5,  card 267px
  "Sem categoria"      -> esperado 13, obtido 13, card 284px
erros JS: (nenhum)
```

O número da barra e o número de cards batem em todas. O destaque acompanha.

> Nota, sem ação: `Outros` e `OUTROS` são duas categorias distintas. O campo é
> texto livre e a distinção por maiúsculas é o comportamento atual — não mexi
> nisso nesta rodada.

## 5. Categoria + busca

```
categoria (a maior)          -> 49
categoria + termo            -> interseção, <= categoria e <= busca isolada
limpar a busca               -> volta aos 49 da categoria
clicar "Todos" com busca     -> mantém o texto digitado, remove só a categoria
```

## 6. "Sem categoria"

Testado com produtos hostis misturados: `null`, string vazia e só espaços caem
todos ali, pela mesma `catDe()` que a barra usa para contar — contagem e grade
não podem divergir porque saem da mesma função.

## 7. Mobile

Em **320, 360, 375, 390 e 430px**, para cada largura: o botão tem área, não está
`disabled`, não está com `pointer-events: none`, e `elementFromPoint` no centro
dele devolve o próprio botão — **nada sobreposto interceptando o toque**. O
clique filtra e o destaque muda.

## 8. Regressão dos cards

Todo clique de categoria verifica também que os cards continuam com altura
normal e que nenhum esqueleto volta. Medido: 267–284px após cada troca.

## 9. Sabotagens

| Sabotagem | Reprovou |
|---|---|
| voltar o `onclick` com `JSON.stringify` (defeito exato) | `C0`: *"'Outros': a barra diz 1 produto(s) e a grade mostrou 76"*, `C0c`, `C0d` |
| remover o ouvinte delegado | `C0`, `C0c`, `C0d` |

## 10. Um defeito meu que o verify pegou

Ao escrever o comentário da correção, coloquei o caractere NUL **literal** no
arquivo. O passo 5 do verify (`test-tema-global`, D4) reprovou na hora:
*"nenhum arquivo de tela ficou com byte NUL (quebra grep/diff)"*. Trocado pela
menção em texto. Fica o registro de que a verificação existente funcionou.

## 11. Resultados

```
npm run verify — 16 passos, 186,1 s, todos verdes
  16. carga da venda rapida   29 ok, 0 falha(s)
```

Relacionadas, todas verdes: `test-pdv-fluxo` 29, `test-pdv-rbac` 11,
`test-pdv-visual` 32, `test-pdv-natureza` 20, `test-venda-rapida-nav` 15,
`test-app-backend` 79, `test-isolamento-tenant` 20, `test-menu-oculto-rbac` 15.

## 12. Restart

**Não precisa.** Só `public/comercial/pedidos-pdv.html` mudou — estático já está
no ar. Nenhuma linha de backend, schema ou configuração.

Recarregue com **Ctrl+Shift+R**.

## 13. O que testar

Clique em cada categoria da coluna esquerda e confira que o número de cards bate
com o número ao lado do nome, e que o item clicado fica destacado. Depois:
escolha uma categoria, digite algo na busca, e confirme que o resultado é a
interseção; limpe a busca e a categoria deve continuar valendo.
