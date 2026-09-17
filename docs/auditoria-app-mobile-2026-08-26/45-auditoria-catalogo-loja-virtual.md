# 45 — Auditoria conjunta: CATÁLOGO + VAREJO → Loja virtual

**Data:** 2026-09-13 · **Somente leitura.** Nada foi alterado.

> **O achado que muda o desenho da Fase 3/4:** não existem dois módulos a
> consolidar. Existem **três** — Catálogo, Loja virtual e o **Cardápio público
> do módulo Restaurante**, que ninguém citou e que já implementa quase tudo o
> que se quer do OlaClick: pedido sem login com nome+telefone+endereço,
> grupos de opções com mínimo/máximo e preço adicional, taxa por bairro,
> horário de funcionamento e aceite do balcão. Só que sobre `rest_comandas`,
> não sobre `pedidos`. Ver §3 e §22.

---

## 1. Mapa do módulo CATÁLOGO

Menu `Suprimentos → Catálogo`, 8 itens:

| Tela | Arquivo | Página RBAC | API |
|---|---|---|---|
| Produtos | `public/catalogo/produtos.html` | `produtos` | `/api/produtos` |
| Produto (detalhe) | `public/catalogo/produto.html` | — (detalhe) | `/api/produtos/:id` |
| **Categorias** | `public/catalogo/categorias.html` | `cadastro-categorias` | `/api/produto-lookup` |
| Etiquetas | `public/catalogo/etiquetas.html` | `catalogo-etiquetas` | `/api/etiquetas` |
| Marcas | `public/catalogo/marcas.html` | `cadastro-marcas` | `/api/produto-lookup` |
| Modelos | `public/catalogo/modelos.html` | `cadastro-modelos` | idem |
| Cores | `public/catalogo/cores.html` | `cadastro-cores` | idem |
| Materiais | `public/catalogo/materiais.html` | `cadastro-materiais` | idem |
| Gêneros | `public/catalogo/generos.html` | `cadastro-generos` | idem |

**Backend:** `produtos-routes.js`, `produto-lookup-routes.js`,
`produto-imagens.js`, `produtos-import.js`, `etiquetas-routes.js`.

**Tabelas:** `produtos` (61 colunas), `produto_lookup` (7 tipos de atributo),
`produto_imagens`, `produto_codigos` (códigos de barras alternativos).

**Feature-gate:** `produtos` → "Catálogo, Estoque & Compras"
(`feature-gate.js:132`).

**Achados de itens antigos/sem uso:**

- `public/catalogo/marcas-modelos.html` — **deletado** (tela 3-em-1 aposentada);
  os stubs em `/produtos/*` ainda redirecionam (`auth-bootstrap.js:131-138`).
- `produto_lookup` aceita 7 tipos, mas em `produtosbomgosto` só 3 têm dados
  (`categoria` 7, `marca` 1, `unidade` 1). Cores/materiais/gêneros vêm do
  vertical Ótica e estão vazios nos demais.
- `produtos` tem colunas de verticais que a maioria dos tenants não usa
  (`codigoFCI`, `escalaRelevante`, `codigoCatmat/Catser/PDM`, `cstIBS/CBS`).

---

## 2. Mapa da LOJA VIRTUAL

| Peça | Caminho |
|---|---|
| Painel do lojista | `public/varejo/loja.html` (483 linhas), menu `VAREJO → Loja virtual`, página `loja` |
| Página pública | `public/loja/index.html` (493 linhas) |
| Backend | `loja-routes.js` (556 linhas) |
| Registro público | `pre-auth-routes.js:63-64` — estático `/loja` + rotas `/loja/api/*` |
| Registro admin | `route-registry.js:354` |
| Uploads | `public/uploads/loja` (logo), servido em `pre-auth-routes.js:60` |

**Tabelas próprias:** `loja_config` (1 linha, `CHECK id = 1`), `loja_carrinho`.
**Colunas acrescentadas:** `produtos.publicadoNaLoja`, `pedidos.origemLoja`.

### Rotas públicas (sem login)

```
GET  /loja/api/config          nome, descrição, logo, whatsapp, tema, pagamento
GET  /loja/api/produtos        vitrine + lista de categorias derivada
GET  /loja/api/produtos/:id    detalhe
```

### Rotas do comprador (exigem login do portal)

```
GET  /loja/api/eu · /carrinho · /meus-pedidos · /pedido/:id/cobranca
POST /loja/api/carrinho · /pedido
```

### Rotas do lojista

```
GET/PUT /api/loja/config · POST/DELETE /api/loja/logo
GET     /api/loja/produtos        · POST /api/loja/produtos/publicar
```

---

## 3. Onde os módulos se cruzam — e o terceiro que apareceu

### Loja virtual × Catálogo: **compartilhado, não duplicado**

| Dado | Situação |
|---|---|
| Produto | **compartilhado** — lê `produtos` direto, sem cópia |
| Preço | **compartilhado** — `resolverPreco()`, o mesmo motor do ERP |
| Estoque | **compartilhado** — movimentações menos reservas |
| Imagens | **compartilhado** — `produto_imagens`, com `imagemPath` de reserva |
| Categoria | **compartilhado**, mas **derivada dos produtos**, não do lookup |
| Cliente | **compartilhado** — `pessoas` + `cliente_logins` do portal |
| Pedido | **compartilhado** — `pedidos` + `pedido_itens` |
| Visibilidade | **exclusivo da loja** — `produtos.publicadoNaLoja` |
| Carrinho | **exclusivo da loja** — `loja_carrinho` |

**Nada é duplicado.** A loja é uma vitrine sobre o catálogo, e o pedido nasce no
fluxo normal do ERP. É a melhor notícia desta auditoria: a base do §19 já está
respeitada.

### O terceiro módulo: Cardápio público (Restaurante)

`restaurante/cardapio-publico-routes.js`, registrado em
`pre-auth-routes.js:72-76`, com tela em `public/cardapio/index.html`. O próprio
arquivo diz "espelha o desenho da loja virtual".

**Ele resolve o que a Loja virtual não resolve:**

| | Loja virtual | Cardápio |
|---|---|---|
| Comprar sem login | ❌ exige `requirePortalAuth` | ✅ nome + telefone + endereço |
| Personalizações | ❌ | ✅ `rest_grupos_opcao` com min/max e `precoAdicional` |
| Entrega / taxa | ❌ | ✅ `rest_bairros_taxa` (taxa e tempo por bairro) |
| Entregador / rota | ❌ | ✅ `rest_entregadores`, `rest_entregas` |
| Horário de funcionamento | ❌ | ✅ `cardapioVigente()` por faixa |
| Aceitar/recusar pedido | ❌ (nasce rascunho) | ✅ `/pedidos-online/:id/aceitar` |
| **Onde grava** | ✅ `pedidos` | ❌ `rest_comandas` (paralelo) |

**E é exatamente aí que está a tensão a resolver:** a Loja virtual grava no
lugar certo mas não tem as funcionalidades; o Cardápio tem as funcionalidades
mas grava em estrutura paralela.

---

## 4. Fluxo público atual

```
visitante → /loja/  (GET /loja/api/config → 404 se `ativa = 0`)
          → GET /loja/api/produtos   (ativo=1 AND publicadoNaLoja=1)
          → modal do produto (fotos, marca, modelo, unidade)
          ┌── sem login: vê preço só se `mostrarPreco = 1`. FIM DA LINHA.
          └── com login do portal:
               POST /loja/api/carrinho   (server-side, tabela `loja_carrinho`)
               POST /loja/api/pedido
```

**O bloqueio é o login.** Não há caminho para o visitante comprar.

---

## 5. Fluxo de pedido — `pedidos`, sem paralelo

`POST /loja/api/pedido`, tudo em uma transação:

```sql
INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status,
                     dataPedido, observacao, depositoId, origemLoja)
VALUES (?, 'catalogo', 'pedido', ?, 'rascunho', date('now','-3 hours'), ?, ?, 1)
INSERT INTO pedido_itens (...)
recalcularTotal(); DELETE FROM loja_carrinho
```

| | |
|---|---|
| Numeração | `gerarNumero(db, 'pedido')` — a mesma do ERP |
| Status | `rascunho` — o lojista confirma na tela que já usa |
| Origem | `tipo='catalogo'` **e** `origemLoja=1` |
| Estoque | `criarReservasPedido()` **depois** da transação; falha não invalida o pedido |
| Financeiro | `emitirCobranca()` opcional (Pix/boleto), por `loja_config.pagamentoModo` |
| Observação | prefixada com `[Loja virtual]`, truncada em 500 |

**Validações:** carrinho vazio → 400; conferência de estoque no fechamento →
409 com a lista do que faltou.

---

## 6. Produtos — o que serve ao Catálogo Online

| Campo | Situação |
|---|---|
| `ativo` | **JÁ EXISTE** |
| `precoVenda` + tabelas de preço | **JÁ EXISTE** (`resolverPreco`) |
| Estoque | **JÁ EXISTE** (disponível = saldo − reservas) |
| `categoria` | **JÁ EXISTE** (texto + `produto_lookup`) |
| Imagem | **JÁ EXISTE** (`produto_imagens`, múltiplas, com ordem) |
| `descricao` | **JÁ EXISTE** |
| `unidade` | **JÁ EXISTE** |
| `marca` / `modelo` | **JÁ EXISTE** |
| SKU / `codigoBarras` | **JÁ EXISTE** (+ `produto_codigos`) |
| **Visibilidade pública** | **JÁ EXISTE** — `publicadoNaLoja` |
| Disponibilidade | **PARCIAL** — calculada; não há "esgotado" manual, como o `rest_cardapio_itens.disponivel` do cardápio |
| **Destaque** | **NÃO EXISTE** |
| **Ordem na vitrine** | **NÃO EXISTE** (ordem alfabética fixa) |
| **Descrição curta / de vitrine** | **NÃO EXISTE** (usa a fiscal, que é longa) |
| Atributos livres | **PARCIAL** — os 7 lookups são de *classificação*, não opções de compra |

---

## 7. Categorias

**A Loja virtual deriva as categorias dos produtos**, igual à Venda rápida —
não usa o `produto_lookup`:

```js
const categorias = [...new Set(linhas.map(p => (p.categoria || '').trim()).filter(Boolean))]
  .sort((a, b) => a.localeCompare(b, 'pt-BR'));
```

O filtro é `AND categoria = ?` — **texto exato**, então `Outros` e `OUTROS`
seriam duas entradas na vitrine pública.

| | |
|---|---|
| Fonte | produtos publicados |
| Ordem | alfabética, sem ordenação própria |
| Categoria oculta/pública | **não existe** — a inativação do lookup não alcança a vitrine, porque ela não lê o lookup |

Consequência a registrar: inativar uma categoria na tela da Fase 44 **não a tira
da vitrine** enquanto houver produto publicado usando-a. É coerente (a vitrine
mostra o que existe), mas não é o que "inativar" sugere.

A Fase 44 não foi alterada.

---

## 8. Imagens

```sql
produto_imagens (id, produtoId, caminho, urlOrigem, origem, autorizadoPor,
                 autorizadoEm, largura, altura, bytes, ordem, dataCriacao)
```

| | |
|---|---|
| Onde salva | `public/uploads/produtos`; logo da loja em `public/uploads/loja` |
| Servido | `pre-auth-routes.js:53` e `:60` — **públicos, antes do auth** |
| Limite | 12 MB (`MAX_BYTES`) |
| Tipo real | verificado por assinatura de bytes (`tipoReal`), não pela extensão |
| Dimensões | **gravadas** (`largura`, `altura`, `bytes`) |
| Múltiplas fotos | **sim**, com `ordem` |
| Procedência | `origem`, `urlOrigem`, `autorizadoPor` — rastreio de direito de uso |
| **Compressão / thumbnail** | **NÃO EXISTE** — a foto original vai inteira para o navegador |
| Fallback | "sem foto" na vitrine; monograma na Venda rápida |

**Para o catálogo público isso importa:** 12 MB por foto num celular 4G, sem
thumbnail, é o maior risco de desempenho da vitrine. E não há recorte quadrado —
os cards hoje usam `object-fit: contain`, o que deixa a moldura alta quando a
foto é retrato (visível no teste do §17).

---

## 9. Clientes

**Hoje a Loja virtual não cria cliente.** Ela exige que o cliente **já exista**
em `pessoas` e tenha login em `cliente_logins` (o mesmo do portal).

| Regra desejada | Estado atual |
|---|---|
| nome + telefone obrigatórios | ❌ na loja (exige login). ✅ **no cardápio**: nome ≥ 2, telefone ≥ 10 dígitos, endereço |
| CPF/CNPJ opcional | ✅ `pessoas.cpfCnpj` aceita nulo |
| CPF/CNPJ = correspondência forte | **PARCIAL** — existe `garantirPessoa` por `cpfCnpj` em `pedidos-routes.js:820` |
| telefone = sugestão, nunca merge | **NÃO EXISTE** — não há busca por telefone com confirmação |
| sem documento falso | ✅ nada gera documento |

O cardápio guarda nome/telefone/endereço na comanda, **sem criar pessoa** — o
oposto do que se quer no futuro.

---

## 10. Entrega / retirada

| | Pedido (ERP) | Loja virtual | Cardápio |
|---|---|---|---|
| Endereço de entrega | ✅ `enderecoEntrega`, `numero`, `bairro`, `cidade`, `uf`, `cep` | ❌ não coleta | ✅ `rest_entregas` |
| Retirada / no local | ✅ `modoEntrega` (`no_local`/`retirada`/`entrega`, usado no PDV) | ❌ | ✅ `tipo` da comanda |
| Taxa / frete | ✅ `pedidos.valorFrete` | ❌ | ✅ por bairro |
| Observação | ✅ | ✅ (prefixada) | ✅ |
| Previsão / horário | **PARCIAL** — `dataEntregaPrevista` no pedido | ❌ | ✅ tempo por bairro |
| Pedido mínimo | ❌ | ❌ | ❌ |
| Área / região | ❌ | ❌ | ✅ `rest_bairros_taxa` |

**O pedido do ERP já tem os campos de entrega** — a Loja virtual simplesmente
não os preenche.

---

## 11. Pagamentos

| | |
|---|---|
| Pix | ✅ `loja_config.pagamentoModo` = `pix` |
| Boleto | ✅ idem |
| Pix **ou** boleto | ✅ o comprador escolhe |
| Nenhum (B2B) | ✅ padrão — cobrança pela régua do financeiro |
| Integração financeira | ✅ `emitirCobranca()` → `contas_a_receber` |
| Reabrir cobrança | ✅ `/loja/api/pedido/:id/cobranca` |
| Vencimento | ✅ `pagamentoVencimentoDias` (3) |
| Cartão / gateway online | ❌ |
| Dinheiro / pagar na entrega | ❌ |
| Webhook | ⚠️ existe para Asaas, mas **rejeita todo evento** (token inválido) — pendência antiga, a baixa depende do polling |

---

## 12. Personalizações e atributos

**JÁ EXISTE, completo — mas só no Restaurante:**

```
rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ativo)
rest_opcoes       (grupoId, nome, precoAdicional, ativo)
rest_produto_grupos (produtoId, grupoId)
rest_comanda_item_opcoes (comandaItemId, opcaoId, nome, precoAdicional)
```

Cobre **opção única** (`min=max=1`), **múltipla escolha** (`max>1`),
**obrigatória** (`min≥1`), **adicional com preço** e a validação no servidor.

| Necessidade | Reutilizável? |
|---|---|
| cor, tamanho, sabor | ✅ como grupo de opções |
| adicional / complemento | ✅ com `precoAdicional` |
| opção única / múltipla | ✅ `min`/`max` |
| observação livre | ✅ `pedido_itens` e comanda têm observação |
| mensagem/frase personalizada | **PARCIAL** — caberia na observação; sem campo próprio |

**Não existe** equivalente fora do Restaurante. `produto_lookup` **não serve**:
é classificação (marca, cor do produto), não opção de compra com preço.

Kits/grades/variações: não encontrei estrutura de variação (produto-pai com
SKUs filhos). Cada variação é um produto próprio.

---

## 13. Configurações da loja

Tudo em `loja_config` (uma linha por tenant):

| Campo | Onde | Existe |
|---|---|---|
| nome | `loja_config.nome` | ✅ |
| descrição | `descricao` | ✅ |
| logo | `logoPath` → `/uploads/loja` | ✅ |
| WhatsApp | `whatsapp` | ✅ |
| e-mail / telefone | `email`, `telefone` | ✅ |
| cor principal | `tema.corPrimaria` (JSON) | ✅ |
| tema claro/escuro, fonte, raio | `tema` | ✅ |
| presets prontos | `neutro`, `industrial`, `vivo` | ✅ |
| mostrar preço / estoque | `mostrarPreco`, `mostrarEstoque` | ✅ |
| pagamento | `pagamentoModo`, `pagamentoVencimentoDias` | ✅ |
| ativa (publicada) | `ativa` | ✅ |
| **banner** | — | ❌ |
| **Instagram / Facebook** | — | ❌ |
| **endereço / cidade** | — | ❌ |
| **horário, aberto/fechado** | — | ❌ (o cardápio tem, por faixa) |
| **cor secundária** | — | ❌ |
| **slug/link** | — | ❌ (a URL é o subdomínio) |
| **entrega / retirada / pedido mínimo / taxa** | — | ❌ |

---

## 14. Página pública — o que já tem

Medida no navegador (screenshot em 390px):

| Elemento | Situação |
|---|---|
| Cabeçalho com nome e descrição | ✅ |
| Logo | ✅ (quando configurado) |
| Botão WhatsApp | ✅ |
| Busca | ✅ (nome, marca, modelo, SKU) |
| Categorias | ✅ — `<select>` |
| Cards com foto, marca, nome, disponibilidade, preço | ✅ |
| Modal do produto com galeria e miniaturas | ✅ |
| Carrinho | ⚠️ existe o botão, mas exige login |
| Rodapé | ✅ |
| Tema aplicado por variável CSS | ✅ |
| Banner | ❌ |
| Destaques | ❌ |
| Aberto/fechado | ❌ |
| Checkout público | ❌ |
| Entrega/retirada, endereço, pagamento | ❌ |
| Redes sociais | ❌ |

**A base visual está mais pronta do que eu esperava.** O que falta é o funil de
compra, não a vitrine.

---

## 15. Tenant e URL

**Resolvido pelo Host, antes de tudo.** `app.use(ctx.middleware)` roda em
`server.js:54`, antes do `pre-auth-routes`. As rotas públicas recebem o `db` já
escopado no tenant — o mesmo Proxy que lança fora de contexto.

**Não há slug, id nem query string** identificando empresa em nenhuma rota
pública. `loja-routes.js:462` monta o link como:

```
https://<slug>.liciteagora.app/loja/
```

**URL futura coerente:** manter o subdomínio e trocar só o caminho —
`empresa.liciteagora.app/catalogo`. Preserva o isolamento (que é o subdomínio),
não exige nada de novo, e `/loja` pode redirecionar para não quebrar links já
enviados.

---

## 16. Segurança

| Item | Estado |
|---|---|
| Isolamento por tenant | ✅ Host → `db` escopado; nenhuma consulta cross-tenant |
| **Preço revalidado no servidor** | ✅ **sim** — `resolverPreco()` item a item no carrinho e no pedido; o que o cliente manda é ignorado. No cardápio, idem, explícito no código |
| Produto de outro tenant | ✅ impossível — o `db` é o do tenant |
| Produto não publicado | ✅ `AND publicadoNaLoja = 1` no carrinho e no pedido |
| IDOR em pedidos | ✅ `WHERE clienteId = ? AND origemLoja = 1` |
| Vazamento de custo/margem | ✅ lista de colunas explícita, comentada: "SELECT * aqui publicaria precoCusto" |
| Quantidade de estoque exata | ✅ escondida — vira rótulo (`disponivel`/`ultimas`/`sob-consulta`) |
| Quantidade absurda | ⚠️ **a loja não limita** `quantidade` (o cardápio limita: 50 itens, 99 por item) |
| Frete | n/a — a loja não tem frete |
| Desconto | ✅ o comprador não informa desconto |
| Loja desativada | ✅ 404 em config e produtos |
| Cardápio | ✅ duplo gate: `restaurante_enabled` **e** `restaurante_cardapio_publico`, ambos default desligado |

**Uma lacuna concreta:** `POST /loja/api/carrinho` aceita qualquer
`quantidade > 0`. Não é vazamento (o estoque barra no fechamento), mas permite
inflar o carrinho. O cardápio já tem o limite; a loja não.

---

## 17. Responsividade da página pública

Medido no Chrome, com a vitrine real e 12 produtos:

| Largura | Estouro horizontal | Campos < 16px | Botões < 40px |
|---|---|---|---|
| 320 / 360 / 375 / 390 / 430 / 768 / 1280 | **0 px em todas** | 2 | 2 |

**Zero overflow em todas as larguras** — a base responsiva está boa.

Dois pontos a corrigir quando chegar a hora:

- **busca e select com fonte < 16px** → o Safari do iOS dá zoom ao focar;
- **dois botões abaixo de 40px** de altura.

E um de layout: com `object-fit: contain` e foto ausente, o card fica muito
alto — em 390px cabe **um card por tela**. Um recorte quadrado resolveria (é a
ferramenta de enquadramento que já está no seu radar).

---

## 18–21. Fases 3 e 4 do checklist

### FASE 3 — Catálogo Online administrativo

**Já existe:**

- painel do lojista (`/varejo/loja.html`) com publicar/despublicar em massa;
- `publicadoNaLoja` por produto, com filtro publicados/fora;
- identidade: nome, descrição, logo, WhatsApp, tema com 3 presets;
- mostrar/ocultar preço e estoque;
- modo de pagamento e vencimento;
- indicador de produto sem foto (`temFoto`) e disponibilidade;
- gestão de categorias (Fase 44) e dos 6 lookups.

**Falta:**

- **destaques** (campo e seleção);
- **ordem** dos produtos e das categorias na vitrine;
- **banner** e cor secundária;
- **horários** e chave aberto/fechado;
- **entrega/retirada**: taxa, área, pedido mínimo, previsão;
- **link/QR Code** para divulgação;
- descrição curta de vitrine;
- marcar "esgotado" à mão.

### FASE 4 — Catálogo público

**Já existe:** cabeçalho, logo, busca, categorias, cards, modal com galeria,
tema, rodapé, carrinho no servidor, pedido em `pedidos`, Pix/boleto,
"meus pedidos", responsividade sem overflow.

**Falta:**

- **comprar sem login** — o bloqueio central;
- banner, destaques, aberto/fechado;
- personalizações no fluxo da loja;
- entrega/retirada com endereço e taxa;
- checkout com cliente, endereço e pagamento;
- tela de confirmação;
- redes sociais.

---

## 22. O que reaproveitar, o que refatorar, e os riscos

### Reaproveitar (praticamente tudo)

`produtos`, `produto_imagens`, `produto_lookup`, `resolverPreco`, estoque com
reservas, `pedidos`/`pedido_itens`, `gerarNumero`, `criarReservasPedido`,
`emitirCobranca`, `pessoas`, `loja_config`, o tema por variável CSS, e a
resolução de tenant por Host.

Do Restaurante, como **modelo** (não como cópia): grupos de opções, taxa por
bairro, horário, aceite do balcão.

### Refatorar

1. **Categorias da vitrine deveriam ler o `produto_lookup`**, não derivar dos
   produtos — é o que faria "inativar" e a ordem futura valerem no público.
2. **Duas implementações públicas quase iguais** (`/loja` e `/cardapio`), com
   config, tema e vitrine próprias. Consolidar depois, com cuidado: o
   Restaurante está em produção.
3. **Thumbnails.** Sem isso, a vitrine pública em 4G serve fotos de até 12 MB.
4. **Limite de quantidade** no carrinho da loja.

### Riscos

| Risco | Gravidade |
|---|---|
| **Migrar o cardápio de `rest_comandas` para `pedidos`** — comanda tem mesa, garçom, KDS, gorjeta, fechamento; não é o mesmo objeto | **alta** — eu não recomendaria nesta rodada |
| Comprar sem login criando pessoa a cada pedido → duplicidade de cadastro | **alta** — precisa da regra de correspondência do §9 antes |
| Publicar produto por engano expõe preço e linha de produto | média — hoje protegido por opt-in duplo (`ativa` + `publicadoNaLoja`) |
| Categoria `Outros`/`OUTROS` aparecer duplicada na vitrine pública | média |
| Foto sem compressão em 4G | média |
| Tocar no Restaurante e quebrar operação de salão | **alta** — módulo vivo |

---

## 23. Proposta de execução (não implementada)

A ordem que eu recomendaria, cada etapa entregando algo utilizável:

**3.1 — Vitrine administrável.** Destaque, ordem e descrição curta em
`produtos`; banner, cor secundária, redes sociais, endereço e horário em
`loja_config`. Tudo aditivo, sem tocar no público. *Baixo risco.*

**3.2 — Entrega e retirada.** Configuração no painel (modos aceitos, taxa
fixa ou por região, pedido mínimo, previsão), gravando em `loja_config`. Os
campos do **pedido já existem** — é preencher o que a loja hoje deixa vazio.
*Baixo risco.*

**3.3 — Link e QR Code.** Uma tela; nenhuma mudança de dados.

**4.1 — Comprar sem login.** *A etapa que destrava tudo, e a mais delicada.*
Checkout com nome + telefone + endereço, e a regra de correspondência do §9:
CPF/CNPJ casa forte; telefone **sugere** e pede confirmação; nunca merge
silencioso. Reaproveitar `garantirPessoa`. **Fazer com o teste de duplicidade
antes do código.**

**4.2 — Vitrine completa.** Banner, destaques, aberto/fechado, cards quadrados
(depende do recorte de imagem), thumbnails.

**4.3 — Personalizações fora do Restaurante.** Só depois de 4.1 provar-se.
Generalizar `rest_grupos_opcao` para produto comum — ou aceitar que
personalização é do vertical de alimentação e não levá-la ao B2B.

**Deixaria para o fim, ou para nunca:** unificar `rest_comandas` com `pedidos`.
O ganho é de elegância; o risco é a operação de salão de quem já usa.

---

## 24. O que não foi tocado

Nada. Sem alteração de código, schema, dado ou configuração. Consultas a banco
todas em `mode=ro`; a página pública foi exercitada contra um servidor local com
APIs simuladas, em porta efêmera. Botões da tela Categorias, Venda rápida,
tooltip, orçamento, PDF, WhatsApp, NF-e, NFC-e, CFOP, comissões e Ótica
intocados.
