# 47 — UX da central do Catálogo Online

**Data:** 2026-09-14 · Fase de UX sobre a fundação da 46.
**Predominantemente frontend:** uma única alteração de backend, mínima e aditiva (§ Preço/estoque).

> **Referência:** os screenshots do OlaClick continuam **não tendo chegado** — segui
> a sua descrição escrita (itens 3–18 da Fase 46 e 3–17 desta). Onde ela não
> alcança o detalhe visual, usei o padrão do Licite Agora.

---

## Antes e depois

| | Antes (46) | Depois (47) |
|---|---|---|
| Topo | faixa de 88px, logo 68px | **capa de 132px**, logo 80px com sombra |
| Números | **5 cards grandes** (dashboard) | **uma linha**: "64 produto(s) · 6 categoria(s) · 0 publicado(s)" |
| Navegação | só busca | **barra horizontal de categorias**, com rolagem e desvanecido |
| Categorias | acesso só pela tela de Categorias | **painel lateral** com adicionar, abrir/fechar todas, totais |
| Visibilidade | pílula "Oculto" | **ícone de olho** com estado, dica e `aria-pressed` |
| Destaque | estrela | estrela com `aria-label` e dica |
| Painel | formulário corrido | **5 blocos**: Preço · Estoque · Identificação · Vitrine · Personalizações |
| Foto no painel | 84px | **116px**, quadrada |
| Descrição | textarea 70px | 62px mínimo, redimensionável, com placeholder |
| Estoque | ausente | **bloco próprio**, com o saldo e a marca de importação |
| Topo | "Aparência \| Produtos" | só **Aparência** (§18) |

---

## Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/catalogo/catalogo-online.html` | reescrita da UX |
| `loja-routes.js` | **uma linha**: destaques passam a trazer `sku`/`unidade` (ver abaixo) |
| `scripts/test-catalogo-online-ux.js` | **novo** — 23 asserções no Chrome |
| `scripts/test-catalogo-online.js` | `I1b` (recuo da empresa) e `I1c` (campos do destaque) |
| `scripts/verify.js` | passo 21 |

### A alteração de backend, e por que foi necessária

O teste `E` reprovou com *"SKU ausente na linha: sem SKU"* — na faixa de
**Destaques**. A linha é a mesma das categorias, mas o endpoint da Fase 46
mandava só `id, descricao, preco, foto, publicado`. Era inconsistência da minha
própria API.

Acrescentei `sku`, `unidade`, `nFotos`, `destaque` e `disponivel` ao objeto de
destaques. **Aditivo** — nenhum consumidor perde nada — e agora travado pelo
teste `I1c`, que compara campo a campo com a linha da categoria.

---

## Decisões visuais

**Os cinco cards saíram.** Viraram uma linha discreta acima da barra de
categorias. O foco é categoria e produto, como você pediu — o teste `A` reprova
se qualquer card de dashboard voltar à área principal.

**Barra de categorias** com pílulas roláveis: `☰ Categorias` · `★ Destaques` ·
as categorias reais. Desvanecido à direita quando há mais — a barra de rolagem
do iOS só aparece durante o gesto, e sem o indicador ninguém descobre que
continua. Clicar abre, foca e rola a seção; a pílula ativa fica destacada.

**Painel de categorias** (esquerda): `+ Adicionar categoria` (leva à tela da
Fase 44), Abrir/Fechar todas, o total `X categoria(s) · Y produto(s)`, Destaques
e a lista com contagem. Clicar fecha o painel e leva à seção.

**Linha do produto:** `[foto] Nome / SKU · unidade … Preço ★ 👁`. O teste `E`
reprova se aparecer CFOP, NCM, custo, ICMS ou CEST — isso é de
CATÁLOGO → Produtos.

**Visibilidade:** ícone de olho (`👁` publicado / `🚫` oculto), verde quando
publicado, com `aria-pressed`, `aria-label` e dica no desktop. Continua sobre
`produtos.publicadoNaLoja` — nenhum campo novo.

**Destaques** é a primeira seção e **não é categoria de texto**: o teste `D`
verifica que a chave do bloco é `destaques` e nunca `c:Destaques`.

---

## Painel de produto

Foto 116px à esquerda, nome e descrição à direita, e cinco blocos na ordem da
referência. O teste `F` verifica a ordem exata.

| Bloco | Conteúdo |
|---|---|
| **Preço** | preço de venda + nota de que a promoção por vigência já existe em Tabelas de preço |
| **Estoque** | saldo, marca de importação quando for o caso, estoque mínimo |
| **Identificação** | SKU, unidade, código de barras, categoria (com datalist) |
| **Vitrine** | publicado, destaque |
| **Personalizações** | `em preparação` — o lugar reservado, sem fingir que funciona |

**O preço de custo saiu do painel.** Ele é informação de gestão, não de montagem
de vitrine — e o teste `F2` reprova se a central voltar a enviá-lo.

Salvar continua pelo `PUT /api/produtos/:id`, com a mesma whitelist e a mesma
validação de preço do servidor. O teste `F2` também verifica que a central
**não** manda saldo, estoque nem quantidade.

---

## Estoque: a auditoria que você pediu (§15)

**Não é sentinela.** Investiguei antes de esconder qualquer coisa:

```sql
-- produtos: NÃO existe coluna `controlaEstoque`
-- a movimentação por trás do saldo de 9.999.999.969:
ENTRADA  9.999.999.974  "Importação inicial do export Bling/Tiny"  2026-05-15
```

São **8 produtos** do `produtosbomgosto`, todos da mesma importação, e
**nenhum ponto do código trata esse valor como especial**. É dado real digitado,
não sentinela do sistema.

Por isso **não substituí por "Estoque não controlado"** — seria mascarar dado
real, e você pediu para confirmar a regra antes. O que fiz:

- a **linha** do produto não mostra número de estoque (ela é para montar
  vitrine);
- o **painel** mostra o saldo formatado, com a etiqueta **"valor de importação"**
  e a explicação de onde veio, com link para Estoque.

O teste `F3` reprova as duas formas de errar: esconder o número **ou** deixar de
sinalizá-lo. A sabotagem que troca por "Estoque não controlado" é pega.

> Se você confirmar que esses 8 registros representam "estoque ilimitado" e
> quiser um campo próprio para isso, é uma migration aditiva e uma fase curta.
> Não improvisei.

---

## Preço e variantes

**Nada de `precoPromocional`.** O motor já existe: `tabelas_preco` com
`vigenciaInicio`, `vigenciaFim` e `prioridade`, aplicado por `resolverPreco()`.
O bloco Preço está preparado e traz a nota; a interface vem na fase que você
decidir.

**Variantes:** o alternador `[ Simples | Variantes ]` entra no topo do bloco
Preço. Nada foi criado — não há estrutura (só `produto_kit_itens`, que é
composição). Continua sendo fase própria.

---

## Modificadores

Só o **lugar reservado**, com a etiqueta `em preparação` e uma frase dizendo o
que virá. Sem botão que finja funcionar, como você pediu. A proposta de
arquitetura (opção B — extrair `rest_grupos_opcao` para camada comum) está no
relatório 46 §17–19 e continua válida.

---

## §18 — o botão "Produtos"

**Saiu do topo.** A própria central administra os produtos do catálogo, e o
botão levava ao cadastro técnico. O caminho continua existindo: `+ Produto`
dentro de cada categoria leva a `/catalogo/produto.html`, e a rota não foi
removida. O teste `G2` trava as duas pontas — fora do topo, presente na tela.

---

## Mobile e desktop

Medido no Chrome, com o painel aberto e todas as categorias expandidas:

| | 320 · 360 · 375 · 390 · 430 | 768 · 1280 · 1440 |
|---|---|---|
| Estouro horizontal | **0 px** | **0 px** |
| Campos < 16px | **0** | (desktop) |
| Ícones < 40px | **0** | **0** |
| Painel cabe na tela | sim | sim (470px, catálogo visível atrás) |
| Rodapé Salvar acessível | sim | sim |

No celular a linha quebra em duas (foto+texto em cima, preço e controles
embaixo) e os painéis ocupam a tela toda.

---

## Acessibilidade

`aria-label` e `aria-pressed` na estrela e no olho, `aria-expanded` no cabeçalho
da categoria, `role="dialog"` e `aria-label` nos painéis, `role="tooltip"` na
dica.

**Nada de `title=`** — proibido nesta base desde a Fase 3.2.1, porque o balão
nativo aparece por cima do nosso. Tooltip próprio (`.dica`), posicionado no
hover, `pointer-events: none`, que some ao rolar. O teste `G` reprova qualquer
`title=` na tela.

---

## Testes

**23 asserções** em `scripts/test-catalogo-online-ux.js`, com interações reais:
clicar na barra, abrir o painel, abrir/fechar todas, clicar estrela e olho,
abrir o painel de produto, salvar, buscar. Cobre os itens A–Z que você listou.

As garantias de arquitetura da Fase 46 continuam em `test-catalogo-online.js`,
que ganhou dois testes: `I1b` (recuo para a empresa) e `I1c` (campos do
destaque) — **22 asserções**.

### Sabotagens

| Sabotagem | Reprovou |
|---|---|
| voltar os cards de dashboard | `A` — *"sobraram 2 cards de dashboard"* |
| esconder o saldo de importação | `F3` — *"o saldo real sumiu da tela"* |
| voltar a usar `title=` | `G` |
| Destaques virando categoria de texto | `D` e `C2` |
| destaque sem `sku` | `I1c` |
| perder o recuo da empresa | `I1b` |

> Duas sabotagens **não** foram pegas na primeira tentativa: o recuo da empresa
> não tinha teste nenhum, e o harness não criava a tabela `fornecedor`.
> Ambas corrigidas — é o tipo de buraco que só aparece tentando quebrar.

---

## Verify e regressões

```
npm run verify — 21 passos, 330,4 s, todos verdes
  19. catalogo online              22 ok
  21. UX do catalogo online        23 ok
```

> O passo 20 (`test-ssl-relatorio`) apareceu no verify entre a Fase 46 e esta —
> não é meu. Meu teste entrou como 21.

**Em produção** (`produtosbomgosto`, sessão real):

```
/api/produtos        200 · 64 produtos     (Venda rápida)
/api/loja/produtos   200 · 64 produtos     (painel antigo)
/api/loja/catalogo   200 · 64 produtos     (central)
tenant: 64 ativos · 0 publicados · 0 destaques   ← inalterado
```

Na tela: capa com logo real, 6 categorias na barra, **64 linhas, 64 com foto,
zero estouro, zero erro de JavaScript**.

Suítes: `test-catalogo-online` 22, `test-catalogo-online-ux` 23,
`test-venda-rapida-carga` 29, `test-app-backend` 79, `test-pdv-rbac` 11,
`test-isolamento-tenant` 20 — todas verdes.

---

## Restart

**Já foi feito** — `loja-routes.js` mudou (a linha dos destaques) e era preciso
para provar em produção. Serviço `active`, health **302**.

Se você repuxar o código, é `systemctl restart consulta-licitacoes.service`.

Um aviso alheio à fase, que persiste: *"The unit file … changed on disk. Run
'systemctl daemon-reload'"*. A unit instalada foi editada sem reload em algum
momento. Não toquei — é decisão sua.

---

## ADERÊNCIA À REFERÊNCIA OLACLICK

| # | Recurso | Situação |
|---|---|---|
| 1 | Identidade / banner | **PARCIAL** — capa, logo, nome, status e link prontos; falta o campo de imagem de banner em `loja_config` |
| 2 | Navegação de categorias | **IMPLEMENTADO** — barra horizontal rolável + painel lateral |
| 3 | Destaques | **IMPLEMENTADO** — primeira seção, coluna própria, estrela na linha |
| 4 | Categoria expansível | **IMPLEMENTADO** — abrir/recolher, contagem, `+ Produto` |
| 5 | Produto compacto | **IMPLEMENTADO** — foto, nome, SKU, preço, estrela, olho |
| 6 | Foto | **PARCIAL** — preview quadrado maior e fallback; recorte/zoom é fase posterior |
| 7 | Preço | **PARCIAL** — bloco próprio com o preço real; promocional preparado, motor existente |
| 8 | Visibilidade | **IMPLEMENTADO** — olho com estado, dica e acessibilidade |
| 9 | Edição lateral | **IMPLEMENTADO** — painel 470px no desktop, tela cheia no celular |
| 10 | Organização do painel | **IMPLEMENTADO** — 5 blocos na ordem da referência |
| 11 | Variantes | **PRÓXIMA FASE** — sem estrutura; lugar definido no bloco Preço |
| 12 | Modificadores | **PRÓXIMA FASE** — lugar reservado, marcado "em preparação" |

**Ainda de fora, por não haver campo:** banner, Instagram, Facebook, endereço
público, cor secundária, horários, aberto/fechado, QR Code. Todos precisam de
migration aditiva em `loja_config` — listados no relatório 46 §20.
