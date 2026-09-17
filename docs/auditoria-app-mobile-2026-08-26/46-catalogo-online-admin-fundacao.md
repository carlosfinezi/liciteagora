# 46 — Catálogo Online administrativo: a fundação

**Data:** 2026-09-13 · Implementa o escopo do §29 da Fase 46.

> **Sobre a referência:** os screenshots do OlaClick **não chegaram** nesta
> conversa — nenhuma imagem foi anexada. Construí a partir da sua descrição
> escrita (itens 3–18), que é detalhada. Onde a descrição não alcança o
> detalhe visual, segui o padrão do Licite Agora. Se enviar as imagens, ajusto
> o acabamento no próximo bloco.

---

## 1. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/catalogo/catalogo-online.html` | **novo** — a central |
| `loja-routes.js` | `destaqueNaLoja` (migration aditiva), `POST /api/loja/produtos/destacar`, `GET /api/loja/catalogo` |
| `public/js/menu-config.js` | item movido de Varejo para Catálogo; tela antiga registrada como oculta |
| `perfis-api-map.js` | `loja` e `loja-config` nos prefixos que consomem |
| `scripts/test-catalogo-online.js` | **novo** — 18 asserções |
| `scripts/verify.js` | passo 19 |

Nada de checkout, `requirePortalAuth`, cliente público, entrega, pagamento,
webhook, `rest_comandas`, Venda rápida, orçamento, PDF, WhatsApp, fiscal ou
Ótica.

---

## 2–4. Navegação, rota e RBAC

```
CATÁLOGO
  Produtos
  Categorias
  Catálogo Online     ← veio de VAREJO → "Loja virtual"
  Etiquetas · Marcas · Modelos · Cores · Materiais · Gêneros
```

**A chave de RBAC continua `loja`.** Ela pode estar gravada em
`perfis_acesso.paginas` nos tenants; renomeá-la tiraria o acesso de quem já o
tem. Mudou o lugar e o rótulo, não a identidade. (Conferi: hoje nenhum perfil a
tem gravada, mas a regra vale mesmo assim.)

**A tela antiga (`/varejo/loja.html`) continua viva**, com upload de logo,
publicação em massa e o tema completo — a central linka para ela. Registrei-a
como `loja-config` com `oculto: true`: sem item no menu, o RBAC cairia na
herança do diretório `/varejo/` e quem tem PDV passaria a abrir a configuração
da loja. É o mesmo padrão do `pedidos-pdv`.

**O mapa de API foi editado à mão**, não regerado — o gerador está interditado
desde a Fase 44, quando desfez ajustes manuais e ampliou acessos. Conferido
após a edição: **176 prefixos** (inalterado), `pedidos-pdv` em **3**,
`/api/orcamento-publico` presente.

---

## 5–9. A central

Uma requisição (`GET /api/loja/catalogo`) traz identidade, contadores,
destaques e produtos **já agrupados por categoria**. Agrupar no servidor é o que
faz a tela abrir organizada — e é a mesma consulta que alimenta os contadores,
então eles não podem divergir.

**Cabeçalho:** faixa com a cor do tema, logo (ou monograma), nome público,
apresentação, etiqueta publicado/não publicado, link com **Abrir** e **Copiar**.
Sem banner ainda — não há campo em `loja_config` (§13).

**Contadores:** Publicados · Ocultos · Destaques · Categorias · Sem foto, todos
dos produtos reais.

**Categorias** vêm do `produto_lookup` (a gestão da Fase 44) **unidas** às que
estão em uso nos produtos. As duas, porque nenhuma sozinha basta: o lookup tem
categorias ainda sem produto (que precisam aparecer vazias para receber o
primeiro), e um produto pode ter categoria fora do lookup — e sumir da tela por
isso seria um produto invisível para quem administra. "Sem categoria" é um grupo
com `categoria: null`, **nunca uma categoria de texto**, e vem por último.

Cada grupo abre e recolhe, com **Abrir todas** / **Fechar todas**. Cada linha
mostra foto, nome, SKU, unidade, preço, estrela de destaque e o interruptor de
visibilidade.

**Ordenação manual não foi implementada** — não há campo `ordem` em `produtos`,
e inventar um às pressas era o que você pediu para não fazer. Alfabética por
enquanto (§20).

**"+ Produto"** dentro da categoria: nesta fundação a central leva para o
cadastro real (`/catalogo/produtos.html`), em vez de criar um segundo caminho de
criação. É o item que eu revisitaria com você — a alternativa é um seletor de
produto existente, e a escolha depende de como você usa no dia a dia.

---

## 7. Destaques

**Uma coluna, `produtos.destaqueNaLoja`, não uma categoria.** Destaque é
ortogonal à categoria: o produto continua em "Cestas de café da manhã" **e**
aparece em Destaques. Se fosse categoria, ou ele saía da dele, ou teria de
existir duas vezes — nenhuma das duas serve.

Migration aditiva, `INTEGER DEFAULT 0`, pelo mesmo `alterSafe` que a loja já
usa. Nenhuma linha é reescrita e todo produto nasce fora dos destaques.

Os testes `E1`/`E2` provam que o produto destacado aparece nos **dois** lugares
e que nenhuma categoria "Destaques" é criada no lookup.

---

## 8. Visibilidade

Reutiliza `produtos.publicadoNaLoja` — nenhum campo equivalente foi criado, e o
teste `H` reprova se aparecer (`visivelNaLoja`, `ativoNaLoja`, …). Um toque no
interruptor da linha publica ou oculta, pelo endpoint que já existia.

---

## 10–11. Painel lateral

Desktop: painel de 440px à direita, com a central visível atrás. Celular: tela
cheia, com rodapé fixo de Cancelar/Salvar. Medido nas duas larguras.

**Campos editáveis — todos já existentes em `produtos`:**

| Campo | Coluna |
|---|---|
| Nome | `descricao` |
| Observações | `observacoes` |
| Preço de venda | `precoVenda` |
| Unidade | `unidade` |
| SKU · Código de barras | `sku`, `codigoBarras` |
| Categoria | `categoria` (com datalist das existentes) |
| Publicado · Destaque | `publicadoNaLoja`, `destaqueNaLoja` |
| Estoque mínimo · Custo | `estoqueMinimo`, `precoCusto` |

**Salva pelo `PUT /api/produtos/:id`** — o mesmo endpoint da tela de Produtos,
com a mesma whitelist de campos e a mesma validação de preço mínimo no
servidor. Não criei endpoint de escrita de produto dentro da loja; o teste `D3`
reprova se aparecer, porque ele duplicaria a validação.

O saldo em estoque **não** é editável ali (vem das movimentações) — dito na
própria tela, com link para Estoque.

---

## 12. Imagens

O painel mostra a foto e leva para o gerenciador existente
(`/catalogo/produto.html#imagens`). Não criei arquitetura nova de imagem, o que
mantém o caminho livre para o recorte:

`produto_imagens` já guarda `largura`, `altura`, `bytes`, `ordem` e a
procedência. Um recorte futuro grava **um novo arquivo** e uma nova linha, sem
alterar o original — nada do que foi feito aqui atrapalha isso.

**Pendência que a Fase 45 já apontou:** não há compressão nem thumbnail. Fotos
de até 12 MB indo inteiras para o celular é o maior risco de desempenho da
vitrine pública.

---

## 13. Aparência

Modal "Aparência", gravando em `loja_config` pelo `PUT /api/loja/config`:
publicado (sim/não), nome público, apresentação, WhatsApp, cor principal,
mostrar preço, mostrar disponibilidade.

**Sem campo em `loja_config`, e por isso ausentes:** banner, Instagram,
Facebook, endereço público, cor secundária. A própria tela diz isso, em vez de
mostrar um campo que não salva.

---

## 14. Link público

`https://<tenant>.liciteagora.app/loja/`, montado do Host — **sem slug novo**,
compatível com a rota existente. Abrir usa a janela de **topo** (a tela roda no
iframe do shell; navegar ali trocaria só o conteúdo interno). Copiar tem
fallback para `execCommand` onde a área de transferência não existe.

`empresa.liciteagora.app/catalogo` continua sendo o destino conceitual — nada
aqui atrapalha, é trocar o caminho e redirecionar `/loja`.

---

## 15. Preço promocional — a análise

**O motor já existe, e não é um campo.** `tabelas_preco` tem
`vigenciaInicio`, `vigenciaFim` e `prioridade`; `tabela_preco_itens` tem preço
por produto e por faixa de quantidade. Uma tabela "Promoção de setembro" com
vigência e prioridade alta **é** preço promocional, e `resolverPreco()` já a
aplica — inclusive na vitrine pública.

O que falta é UX: os prints mostram "Preço" e "Preço com desconto" no próprio
produto, e mapear isso para tabela de preço é indireto.

**Duas saídas, e eu recomendo a segunda:**

1. `produtos.precoPromocional` + vigência — simples de exibir, mas **cria um
   segundo sistema de preços** e abre a pergunta de quem vence quando os dois
   existem. Foi o que você pediu para evitar.
2. **Atalho na UI sobre o motor existente:** o painel oferece "preço
   promocional" e por trás grava numa tabela de preço marcada como promocional,
   com vigência. Um sistema só, e a regra de precedência continua sendo a que
   já está em produção.

Não implementei nenhuma das duas — é decisão sua.

---

## 16. Variantes — a análise

**Não existe estrutura.** Procurei grade, variação, atributo com SKU próprio:
só há `produto_kit_itens`, que é **composição** (kit = vários produtos juntos),
o oposto de variação.

Hoje cada variação é um produto próprio, com SKU e estoque próprios — o que
funciona para o ERP e é ruim para a vitrine (P, M e G aparecem como três cards).

Variante de verdade precisa de: produto-pai, filhos com SKU e estoque
próprios, e eixos de variação. É a maior das peças em aberto, e mexe em estoque
e pedido. **Não é para improvisar** — merece uma fase própria.

---

## 17–19. Modificadores — a análise, e a proposta

### O que existe

```sql
rest_grupos_opcao   (id, nome, minEscolhas, maxEscolhas, ordem, ativo)
rest_opcoes         (id, grupoId, nome, precoAdicional, insumoProdutoId,
                     quantidadeInsumo, ordem, ativo)
rest_produto_grupos (produtoId, grupoId, ordem)   -- PK composta
```

**Cobre tudo o que você descreveu nos itens 17 e 18:** obrigatório (`min ≥ 1`),
opcional (`min = 0`), escolha única (`max = 1`), múltipla (`max > 1`), preço
adicional, ordem, ativo. E a validação já roda no servidor
(`cardapio-publico-routes.js:180-196`), rejeitando opção fora do grupo e grupo
obrigatório não atendido.

### Três descobertas que mudam a recomendação

1. **`rest_produto_grupos` referencia `produtos`** — a tabela geral do ERP, não
   um item de cardápio. A estrutura **já é genérica**; só o nome é de
   restaurante.
2. **Grupos reutilizáveis já são o desenho:** a PK composta `(produtoId,
   grupoId)` é exatamente o "um grupo, vários produtos" do seu item 19.
3. **Zero uso em todos os 19 tenants.** Contei: nenhum grupo cadastrado em
   lugar nenhum. O recurso existe e nunca foi usado.

### A recomendação: **opção B — extrair para camada comum**

Das quatro que você listou:

| | |
|---|---|
| A) generalizar no lugar | mantém o prefixo `rest_` em tabela usada pelo B2B — confunde para sempre |
| **B) extrair para camada comum** | **recomendada** |
| C) tabelas genéricas novas, em paralelo | duas implementações da mesma coisa |
| D) manter isolada, só como referência | joga fora uma implementação pronta e correta |

Concretamente: criar `produto_grupos_opcao`, `produto_opcoes`,
`produto_grupo_vinculos` — mesmas colunas, sem `insumoProdutoId`/
`quantidadeInsumo` (que são de ficha técnica de cozinha) — e migrar as
`rest_*` para elas, deixando o Restaurante consumir a camada comum.

**O que torna isso seguro, e é a razão de eu recomendar B e não C:** as tabelas
`rest_*` estão **vazias em toda a base**. A migração move zero linhas. Se
houvesse dados, eu recomendaria C.

**O que ainda assim exige cuidado:** o Restaurante está em produção e lê essas
tabelas em cinco lugares. A troca precisa ser um commit só, com o teste do
cardápio verde antes e depois. E **nada de `rest_comandas`** — as opções
escolhidas continuam gravando em `rest_comanda_item_opcoes` no fluxo de
restaurante; o Catálogo Online gravará nas suas próprias, em `pedido_itens`.

Vocabulário: **modificadores, opções, complementos** — nunca mesa, garçom,
cozinha, KDS ou comanda (teste `L` reprova).

---

## 20. Migrations

**Nesta fase, uma só, aditiva:**

```sql
ALTER TABLE produtos ADD COLUMN destaqueNaLoja INTEGER DEFAULT 0;
```

Roda por `migrarLojaDB`, com `alterSafe` (idempotente). O teste `M` verifica que
todo `ALTER` do arquivo é `ADD COLUMN` e que não há `DROP`/`RENAME`.

**Necessárias depois, quando você decidir:**

| Recurso | Migration |
|---|---|
| Ordem manual | `produtos.ordemVitrine INTEGER DEFAULT 0` (+ `produto_lookup.ordem`) |
| Banner e redes | `loja_config`: `bannerPath`, `instagram`, `facebook`, `enderecoPublico`, `corSecundaria` |
| Horários / aberto-fechado | `loja_config.horarios` (JSON) ou tabela de faixas |
| Modificadores | as três tabelas da camada comum (§19) |
| Preço promocional | nenhuma, se for a saída 2 do §15 |
| Variantes | fase própria |

---

## 21. Responsividade

Medida no Chrome, com a central real, o painel aberto e todas as categorias
expandidas:

| Largura | Estouro | Campos < 16px | Painel cabe |
|---|---|---|---|
| 320 / 360 / 375 / 390 / 430 | **0 px** | **0** | sim |
| 768 / 1280 | **0 px** | (desktop) | sim |

Elevei os alvos de toque **desta** tela: cabeçalho de categoria 48px, botões da
barra e do link 44px. Não mexi no `btn-sm` global — elevá-lo mudaria o padrão de
140 telas por causa de uma.

---

## 22. Segurança

| | |
|---|---|
| Tenant | `db` escopado pelo Host; teste `N` prova com dois bancos que publicar/destacar em um não alcança o outro |
| RBAC | fail-closed preservado; total de prefixos inalterado (176) |
| Feature-gate | `produtos` (seção Catálogo) e `/api/loja` seguem como estavam |
| Preço | não é confiado do frontend: salva pelo `PUT /api/produtos/:id`, com a validação de preço mínimo do servidor |
| Produto de outro tenant | impossível — o `db` é o do tenant |
| Upload | não foi tocado; continua isolado por tenant no diretório existente |
| Escrita em `rest_comandas` | nenhuma (teste `L`) |
| Checkout público | intocado (teste `J`) |

---

## 23–24. Testes e sabotagens

**18 asserções** em `scripts/test-catalogo-online.js`, com banco descartável do
schema real. Cobrem os itens A–T que você listou.

| Sabotagem | Reprovou |
|---|---|
| destaque gravado como categoria "Destaques" | `E1`, `E2` |
| tabela espelho `catalogo_produtos` | `D1` |
| item duplicado no menu (Varejo + Catálogo) | `A` |
| tirar a página do mapa de RBAC (fail-open) | `C` |

---

## 25. Verify

```
npm run verify — 19 passos, 246,1 s, todos verdes
  19. catalogo online (test-catalogo-online)   18 ok, 0 falha(s)
```

Relacionadas verdes: `test-app-backend` 79, `test-pdv-rbac` 11,
`test-fase321-ux` 20, `test-menu-oculto-rbac` 15, `test-isolamento-tenant` 20,
`test-categorias-produtos` 27, `test-venda-rapida-nav` 15,
`test-sidebar-botoes` 23.

---

## 26. Restart

```
systemctl restart consulta-licitacoes.service
```

**Necessário:** `loja-routes.js` e `perfis-api-map.js` são carregados pelo
`server.js`. Sem o restart, a central abre (é estática) mas `/api/loja/catalogo`
responde 404 e a coluna `destaqueNaLoja` não é criada.

A migration roda sozinha no boot, por `migrarLojaDB` — nenhum comando de banco
para você executar.

---

## ADERÊNCIA À REFERÊNCIA OLACLICK

| Recurso | Situação |
|---|---|
| Identidade da loja visível ao administrar | **IMPLEMENTADO NESTA FASE** |
| Link público com Abrir / Copiar | **IMPLEMENTADO NESTA FASE** |
| Contadores (publicados / ocultos / destaques) | **IMPLEMENTADO NESTA FASE** |
| Produtos agrupados por categoria | **IMPLEMENTADO NESTA FASE** |
| Abrir / fechar todas as categorias | **IMPLEMENTADO NESTA FASE** |
| Contagem por categoria | **IMPLEMENTADO NESTA FASE** |
| Seção Destaques | **IMPLEMENTADO NESTA FASE** |
| Mostrar / ocultar produto num toque | **IMPLEMENTADO NESTA FASE** |
| Editar produto em painel lateral | **IMPLEMENTADO NESTA FASE** |
| Aparência (nome, logo, cor, WhatsApp) | **IMPLEMENTADO NESTA FASE** (logo pela tela de configurações) |
| Publicar / despublicar em massa | **JÁ EXISTIA** (tela de configurações) |
| Upload de logo | **JÁ EXISTIA** |
| Tema com presets | **JÁ EXISTIA** |
| Busca no catálogo | **JÁ EXISTIA** (vitrine) + agora na central |
| Banner / capa | **EXIGE ADAPTAÇÃO** — falta campo em `loja_config` |
| Instagram, Facebook, endereço | **EXIGE ADAPTAÇÃO** — idem |
| Ordenar produtos e categorias | **PREPARADO PARA PRÓXIMO BLOCO** — falta `ordem` |
| Preço com desconto | **PREPARADO PARA PRÓXIMO BLOCO** — motor existe (§15) |
| Ajustar foto (recorte, zoom) | **PREPARADO PARA PRÓXIMO BLOCO** — nada bloqueia |
| Modificadores e grupos reutilizáveis | **PREPARADO PARA PRÓXIMO BLOCO** — estrutura mapeada, proposta no §19 |
| Variantes | **FASE POSTERIOR** — não há estrutura |
| Horários, aberto/fechado | **FASE POSTERIOR** |
| QR Code | **FASE POSTERIOR** |
| Boas-vindas | **FASE POSTERIOR** |
| Checkout, entrega, pagamento público | **FASE POSTERIOR** (Fase 4) |

---

## Um incidente que preciso reportar

No meio das sabotagens rodei `git checkout loja-routes.js` para desfazer uma —
e isso **reverteu o arquivo para o HEAD**, apagando minhas mudanças da fase
**e** um comentário de 4 linhas que era trabalho anterior não commitado (a
explicação do `tipo='catalogo'` no INSERT do pedido).

Conferi item a item o que o HEAD tinha: todo o resto do trabalho anterior
(pagamento, cobrança, `origemLoja`, `escolherForma`) já estava commitado.
Restaurei o comentário do meu contexto — eu o havia lido inteiro na Fase 45 — e
refiz as mudanças da fase. O arquivo voltou a 556 linhas + as minhas, com
`node --check` limpo e os 18 testes verdes.

Passei a usar cópias em `/tmp` para sabotagem. **Neste repositório `git
checkout` de arquivo é destrutivo**, porque a árvore tem 271 entradas não
commitadas — está no CLAUDE.md e eu deveria ter lembrado antes.

---
---

# Correção: a central não carregava em produção

**Data:** 2026-09-13, após o teste real. **Duas causas, não uma.**

## A) Causa raiz

### Causa 1 — o processo nunca carregou o código novo

```
serviço ativo desde:      Sat 2026-09-12 13:32:43 -03
loja-routes.js alterado:  2026-09-13 19:16:55
```

O `consulta-licitacoes.service` estava rodando desde **ontem**. As rotas da
Fase 46 nunca entraram em memória.

### Causa 2 — a coluna `destaqueNaLoja` não existia em NENHUM tenant

Esta é a que **persistiria mesmo após o restart**, e é o erro de fundo.

Coloquei a coluna em `migrarLojaDB()`. Essa função **não roda para tenant que já
existe**: no registro das rotas o `db` ainda é o proxy sem contexto de tenant, e
criar coluna ali é no-op silencioso. O próprio `loja-routes.js:193` documenta
isso — eu li o comentário na Fase 45 e ainda assim errei.

Auditoria dos 19 tenants, antes de qualquer alteração:

```
destaqueNaLoja:   0 de 19 tenants
publicadoNaLoja: 18 de 19  (faltava em crsolucoes)
```

A coluna irmã chegou por `scripts/migrate-loja.js`, script manual de agosto —
e o `crsolucoes` ficou de fora.

## B) O request que falhava

```
GET /api/loja/catalogo
Host: produtosbomgosto.liciteagora.app
→ 404  "Cannot GET /api/loja/catalogo"   (HTML, não JSON)
```

O `api()` da tela tenta ler JSON, não consegue, e cai na mensagem genérica
"Não foi possível concluir a operação" — que foi o que você viu.

Os demais requests da página estavam **todos 200**: `/api/tenant-atual`,
`/api/usuarios/me`, `/api/perfis/meu-acesso`, `/api/features/status`,
`/api/estabelecimentos`. O RBAC estava correto; o tenant também.

## C) O erro real do servidor

Depois do restart, com a rota registrada e a coluna ainda faltando, seria:

```
SqliteError: no such column: p.destaqueNaLoja
```

Não cheguei a vê-lo em log porque corrigi a coluna antes de reiniciar — mas é o
que a auditoria dos 19 tenants garante que aconteceria.

## D) Arquivos alterados

| Arquivo | O quê |
|---|---|
| `db-schema.js` | `publicadoNaLoja` e `destaqueNaLoja` na lista de ALTERs idempotentes de `produtos` |
| `loja-routes.js` | identidade com recuo para a empresa (`nomeProprio`, `logoProprio`) |
| `public/catalogo/catalogo-online.html` | avisa quando o nome vem da empresa; `title` no status |
| `scripts/test-catalogo-online.js` | `M0` e `M0b` |

## E) Como foi corrigido

**A coluna foi para onde alcança tenant existente.** `initSchema` (db-schema.js)
roda por tenant no boot (`tenant-bootstrap.js`), e é o único caminho que
atinge banco já criado — está inclusive registrado na memória do projeto.
`publicadoNaLoja` entrou junto, o que de quebra conserta o `crsolucoes`.

Aditivo e idempotente (`alterSafe`), com `DEFAULT 0`. Nenhuma linha reescrita,
nenhum dado tocado. Conferido depois: **19 de 19 tenants com as duas colunas**.

**E o cabeçalho.** `loja_config` do `produtosbomgosto` está vazia — o tenant
nunca configurou a loja. O nome "Catálogo" e o traço no logo eram o **dado
real**, não defeito. Mas era o que fazia a tela parecer quebrada, e o §4 do seu
pedido já previa recuo para a empresa: agora usa razão social e logo do
emitente, dizendo na tela que é recuo ("Usando o nome da empresa — defina um
nome público em Aparência").

**Nada foi mascarado:** sem array vazio artificial, sem fallback que simule
carregamento, sem hardcode de tenant, sem afrouxar RBAC.

## F) Evidência no tenant produtosbomgosto

```
GET /api/loja/catalogo → 200 em 0,13 s, 13.654 bytes

resumo:     total 66 · publicados 0 · ocultos 66 · destaques 0 · categorias 7 · sem foto 24
loja:       VALDIRENE DOS SANTOS LIMA DA SILVA LTDA (nomeProprio: false)
            logo: sim (do emitente) · url: .../loja/ · ativa: false
categorias: CHÁS 10 · CONDIMENTOS 16 · CONFEITOS 2 · Outros 0 · OUTROS 5
            PRODUTOS BOM GOSTO 19 · TEMPEROS 9 · (sem categoria) 5
1º produto: 3003 ALECRIM — R$ 23,00 · foto sim · disponível 19.839 · oculto
```

Na tela, medido no navegador contra produção: **8 grupos, 66 linhas, 42 com
foto**, preços, o logo real da empresa, e **zero erro de JavaScript**.

### Interações (item 8)

| | |
|---|---|
| Abrir todas / Fechar todas | 8 → 0 grupos abertos |
| Abrir uma categoria | 1 aberta |
| Busca "ALECRIM" | 1 linha, a certa |
| Limpar busca | volta a 66 |
| Painel lateral | abre com nome e preço corretos |
| Salvar | "Produto atualizado", painel fecha |
| Publicar / destacar | `publicado=1`, `destaque=1` no banco |

### Nada foi alterado em produção

Salvei o produto **sem mudar valor** e publiquei/destaquei **revertendo em
seguida**:

```
antes:  id 2 | 3003 | ALECRIM - FD 20 UN 0,8G | 23.0 | pub 0 | dest 0
depois: id 2 | 3003 | ALECRIM - FD 20 UN 0,8G | 23.0 | pub 0 | dest 0
        66 produtos ativos · 1 registro com sku 3003
```

E ao destacar, a categoria continuou `CHÁS` — destaque não engole a categoria.

## G) Testes e regressões

**O teste novo que teria pego isto.** A lacuna era minha: o harness chamava
`migrarLojaDB()` explicitamente, então a coluna existia no teste e não em
produção. Dois testes fecham isso:

- `M0` — as colunas de vitrine têm de estar na lista do **db-schema**, não só
  em `migrarLojaDB`;
- `M0b` — generaliza: toda coluna de `produtos` que a central consulta precisa
  ser garantida pelo db-schema.

**Sabotagem:** removi as colunas do db-schema → `M0` reprova com *"destaqueNaLoja
não está na lista do db-schema — não chegaria a tenant que já existe"*.

> Nota: a primeira versão do `M0` **não** pegava a sabotagem — o regex casava
> com o meu próprio comentário explicativo dentro do array. Corrigido removendo
> comentários antes de buscar, que é o padrão desta base. Vale o registro: um
> teste que não reprova o defeito não é teste.

```
npm run verify — 19 passos, 233,8 s, todos verdes
  19. catalogo online   20 ok, 0 falha(s)
```

**Regressões, contra produção:**

| | |
|---|---|
| Painel antigo (`/api/loja/produtos`) | 200 · 66 produtos |
| Venda rápida (`/api/produtos`) | 200 · 66 produtos |
| Loja pública (`/loja/api/config`) | **404 — correto**: `ativa = 0`, a loja nunca foi publicada |

## H) Restart

**Já foi feito** — duas vezes, e era necessário para provar. Serviço `active`,
health **302**, migration aplicada nos 19 tenants no boot.

Não é preciso reiniciar de novo por causa desta correção.

Um aviso que apareceu, alheio a esta fase: *"The unit file … changed on disk.
Run 'systemctl daemon-reload'"*. A unit instalada foi editada em algum momento
sem reload. Não mexi nisso — é decisão sua.
