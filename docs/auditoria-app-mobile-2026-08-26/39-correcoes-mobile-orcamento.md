# 39 — Correções: responsividade, login, descrição, PDF e link público

**Data:** 2026-09-12, 16:30–19:10 BRT
**Escopo:** 7 problemas relatados. **Implementados, não só analisados.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, NRestarts 0 | **idêntico** |

**Backup antes do schema:** `backups/db/2026-09-12-1254/`.

> ⚠️ **Há uma ação sua pendente: reiniciar `consulta-licitacoes.service`.** Cinco
> `.js` da raiz mudaram, e o processo vivo ainda roda o código anterior. Os itens
> 4, 5, 6 e 7 **só passam a funcionar depois do restart** (§9).

---

## 1. Causa encontrada, item por item

### Item 1 — Responsividade

**Causa: o sistema não tinha responsividade global.** Medido: das 213 telas do ERP, **apenas 20 tinham `@media` própria**, e o `app-modern.css` — carregado por todas — tinha **um único breakpoint** (`.form-grid-2`).

A maior fonte de estouro eram as **tabelas**: 175 telas têm `<table>`, e nenhuma envolvia a tabela num container. Uma tabela de 8 colunas força ~900px e arrastava a **página inteira**.

**Correção:** um bloco responsivo no CSS global (900 / 640 / 380px) e um wrapper de rolagem injetado por JavaScript. A correção é em 2 arquivos, não em 193.

> Não usei `overflow-x: hidden` no `body`. Isso esconde o estouro e corta conteúdo sem avisar — a instrução era explícita quanto a não resolver escondendo.

### Item 2 — Login no Android

**Causa:** campos com `font-size: 15px` — **abaixo do limiar de 16px**, que é o que faz o iOS dar zoom sozinho ao focar. Rótulos em 14px, e `min-height: 100vh`, que ignora o encolhimento do viewport quando o teclado virtual sobe.

### Item 3 — Descrição cortada

**Causa: não é o banco, nem a API.** Verifiquei nos dados reais:

```
item#589 | desc='TEMPERO COMPLETO COM COLORAU - FD 24 UN 500G' | len=44
item#593 | desc='TEMPERO PEGA MARIDO - FD 20 UND 25G'          | len=35
```

**A descrição completa está gravada.** O HTML também sai inteiro (`<td>${it.descricao}</td>`). O corte era **visual**: sem responsividade, a coluna era espremida pela tabela larga, e o `<input>` de edição tinha `width:100%` dentro de uma célula sem largura mínima.

### Item 4 — Download do PDF

**Causa:** a rota respondia `Content-Disposition: inline` (abre, não baixa) e a tela usava `window.open`, que no iPhone cai no bloqueador de pop-up com frequência — e, quando abre, o visualizador não oferece salvar de forma clara. Sem indicador de carregamento e sem tratamento de erro.

### Item 5 — WhatsApp levando ao login

**Causa, no código:**

```js
`PDF do ${rotulo}: ${location.origin}/api/pedidos/${p.id}/pdf`
```

Rota **autenticada**. O cliente, que não tem conta, caía no login. Exatamente o relato.

### Item 6 — "Load failed"

**Causa:** `Load failed` é a mensagem literal do **Safari/WebKit** quando um `fetch` não completa (o Chrome diz `Failed to fetch`). As telas mostram `e.message` cru, então o usuário lia o texto do motor do navegador.

### Item 7 — Quebra de página do PDF

**Causa: a altura da linha era estimada, não medida.**

```js
const linhas = Math.max(1, Math.ceil((it.descricao || '').length / 50));
const rowH = Math.max(14, linhas * 10);
```

Um chute de 50 caracteres por linha. Mas quem quebra a linha é o PDFKit, **por largura em pontos**. Quando o texto real precisava de mais linhas que o chute previa, transbordava a altura reservada e escrevia **por cima da linha seguinte** — ou da primeira linha da página seguinte, que é o item 30 do relato.

Segundo defeito: `addPage()` **não redesenhava o cabeçalho** da tabela.

---

## 2. Arquivos alterados

| Arquivo | Item | O quê |
|---|---|---|
| `public/css/app-modern.css` | 1, 3 | +149 linhas: breakpoints 900/640/380, `.tabela-rolagem`, `col-descricao` |
| `public/js/sidebar.js` | 1, 6 | `envolverTabelas()`, `mensagemDeRede()`, observer cobre `table` |
| `public/auth/login.html` | 2 | 16px, `100dvh`, alturas de toque, 2 breakpoints, `viewport-fit` |
| `public/comercial/pedido.html` | 3, 4, 5, 6 | `col-descricao`, `baixarPdf()`, `obterLinkPublico()`, `gerenciarLinkPublico()`, WhatsApp com link público |
| `public/comercial/pedidos-pdv.html` | 6 | `api()` trata rede e sessão expirada |
| **`pedido-pdf.js`** | 7 | `heightOfString`, `desenharCabecalho()`, `bufferPages`, rodapé em todas as páginas |
| **`pedidos-routes.js`** | 4, 5 | `?download=1`, 4 rotas de link público, `carregarPedidoCompleto` por token |
| **`auth.js`** | 5 | bypass de `/api/orcamento-publico/` |
| **`db-schema.js`** | 5 | `tokenPublico`, `tokenPublicoEm`, índice único |
| **`perfis-api-map.js`** | 5 | `/api/orcamento-publico` em LIBERADOS |
| `public/auth/orcamento-comercial.html` | 5 | **novo** — página pública |
| `scripts/test-correcoes-mobile.js` | todos | **novo** — 26 testes |
| `scripts/verify.js` | — | passo 11 |
| 3 suítes existentes | — | premissas atualizadas (§8) |

**Em negrito: os 5 que exigem restart.**

---

## 3. Item 1 — responsividade

```css
@media (max-width: 900px)  /* padding, page-header empilha, form-row 1 coluna */
@media (max-width: 640px)  /* 16px nos campos, toque 40px, modal full, kpi 2 col */
@media (max-width: 380px)  /* kpi 1 coluna, títulos menores */
```

E as tabelas, que eram o problema central:

```js
function envolverTabelas(raiz) { /* <table> ganha .tabela-rolagem em volta */ }
```

Roda nos dois caminhos de `initSidebar` **e** no observer de mutação — porque quase toda listagem monta a tabela por `innerHTML` depois do fetch. Idempotente: pula tabela já envolvida e tabela aninhada.

**Medido no Chrome**, com a estrutura real de uma listagem (page-header + toolbar + tabela de 8 colunas):

| Largura | `scrollWidth` | Estouro | Tabela envolvida | Fonte | Botão |
|---|---|---|---|---|---|
| 320px | 320 ✓ | 0 | ✓ | 16px | 40px |
| 360px | 360 ✓ | 0 | ✓ | 16px | 40px |
| 375px | 375 ✓ | 0 | ✓ | 16px | 40px |
| 390px | 390 ✓ | 0 | ✓ | 16px | 40px |
| 430px | 430 ✓ | 0 | ✓ | 16px | 40px |

**Zero rolagem horizontal** em todas. Nenhuma coluna foi escondida.

---

## 4. Itens 2 e 3

**Login**, medido nas cinco larguras: `scrollWidth` igual ao viewport em todas, fonte **16px**, input **48px**, botão **50px**, e a marca reduz de 265→215px abaixo de 360px.

**Descrição**: no celular a coluna quebra em várias linhas (`white-space: normal`, `min-width: 170px`), em vez de ser espremida. Medido: a descrição de 44 caracteres ocupa 2 linhas e **aparece inteira**. SKU, quantidade, unidade e valores continuam legíveis, com `nowrap` nas colunas numéricas.

**Nenhum dado precisou ser corrigido no banco** — a descrição completa sempre esteve lá.

---

## 5. Item 7 — PDF

```js
const alturaDesc = doc.heightOfString(String(it.descricao || ''), {
  width: colDesc.w - 6, align: colDesc.align,
});
const rowH = Math.max(14, Math.ceil(alturaDesc) + 6);
```

Agora a altura vem do **próprio PDFKit**, com a mesma fonte, o mesmo tamanho e a mesma largura de coluna do desenho. Mais: `height: rowH - 4, ellipsis: true` em cada célula, para tornar o transbordo impossível mesmo que a medição erre.

**Testado com 42 itens e descrições de até 82 caracteres:**

| | Antes | Depois |
|---|---|---|
| Cabeçalho da tabela | 1ª página só | **nas 2 páginas** |
| Rodapé "SEM VALOR FISCAL" | última página só | **nas 2 páginas** |
| Numeração | não tinha | "Página 1 de 2" |
| Sobreposição | item 30 sobre a página 2 | **nenhuma** |

Conferido também na imagem renderizada da página 2: cabeçalho completo, item 24 em diante, descrições longas quebrando **dentro** da célula.

---

## 6. Item 5 — link público

O desenho **copia um padrão que já roda em produção**: o módulo de OS tem `/api/orcamento/:token` público desde antes. Não inventei mecanismo novo.

```
POST   /api/pedidos/:id/link-publico     gera (protegida, idempotente)
DELETE /api/pedidos/:id/link-publico     revoga (protegida)
GET    /api/orcamento-publico/:token     lê    (PÚBLICA)
GET    /api/orcamento-publico/:token/pdf PDF   (PÚBLICA)
```

O link é `/orcamento-comercial.html?token=<64 hex>`, servido de `public/auth/` — o mesmo diretório público de onde sai o login.

### As decisões de segurança

| | |
|---|---|
| **Token** | `crypto.randomBytes(32)` = 64 hex. **Não é o id** — sequencial seria trivial de adivinhar |
| **Formato conferido antes do banco** | regex `^[a-f0-9]{64}$`; qualquer outra coisa é 404 sem consultar nada |
| **Recorte explícito** | lista campo a campo. Sem `...pedido`, sem `SELECT *` |
| **O que NÃO vai** | custo, margem, vendedor, depósito, status interno, histórico, CPF/CNPJ do cliente |
| **Revogável** | `DELETE` escreve NULL; o link antigo responde 404 na hora |
| **Cancelado** | responde 410, com mensagem própria |
| **Painel intacto** | `/api/pedidos/*` continua exigindo sessão. O bypass é só do prefixo novo |

### Provado ponta a ponta

Servidor real numa porta alternativa, banco descartável (cópia `.backup` do `sandbox2`, suspenso):

```
gerar link          → 200, token de 64 chars
2ª chamada          → mesmo token ✓ (não invalida o que já foi enviado)
ler SEM sessão      → 200, "TEMPERO COMPLETO COM AÇAFRÃO - FD 24 UN 500G"
campos devolvidos   → numero,data,validade,cliente,itens,desconto,frete,valorTotal,observacao
vazou dado interno  → não ✓
token "abc"         → 404
64 hex aleatório    → 404
PDF                 → 200, attachment; filename="ORC-2026-00003.pdf"
revogar → reabrir   → 404 ✓
```

A mensagem do WhatsApp passou a levar número, empresa, valor total e o **link público**.

---

## 7. Item 6 — "Load failed"

Helper global em `sidebar.js`, alcançando as ~220 telas:

```js
function mensagemDeRede(e) {
  if (/load failed|failed to fetch|networkerror|.../i.test(m)) {
    console.warn('[rede] falha técnica:', m, e);   // detalhe fica no console
    return 'Não foi possível falar com o servidor. Verifique sua conexão e tente de novo.';
  }
  ...
}
```

E o `api()` da Venda rápida passou a distinguir três casos: falha de rede, **sessão expirada** (401/403 → *"Entre novamente para continuar"*) e erro de negócio.

> Sobre "identificar qual requisição está falhando": `Load failed` é falha de **transporte** — o navegador não registra qual. O `console.warn` agora carrega o objeto de erro inteiro, que é o que dá para capturar. Se o erro voltar a aparecer, o console do aparelho mostra a URL.

---

## 8. Testes

### Suíte nova

`scripts/test-correcoes-mobile.js` — **26 testes, 26 OK**, ligada ao verify como passo 11.

| Bloco | Cobre |
|---|---|
| A (6) | breakpoints · 16px · **não escondeu conteúdo** · rolagem própria · idempotência · descrição quebra |
| B (3) | login 16px/48px · `100dvh` (teclado) · breakpoints |
| C (5) | altura **medida** · cabeçalho repetido · texto preso na célula · rodapé em todas · download real |
| D (2) | tradução do erro · `api()` trata rede e sessão |
| E (7) | token aleatório · **painel não abriu** · **recorte sem dado interno** · revogável · WhatsApp · página pública · responsiva |
| F (3) | schema · migration aplicada nos 19 · **nenhum token criado sozinho** |

### Provado por sabotagem

| Sabotagem | Reprovou |
|---|---|
| liberar `/api/pedidos/` sem auth | **E2** — *"PERIGO: /api/pedidos/ foi liberado sem autenticação"* |
| vazar `margem` no recorte público | **E3** — *"o recorte público expõe margem"* |
| trocar allowlist por exclusão (PWA) | C2, C4 |

### Regressão — zero falhas

`npm run verify` (2,0s, 11 passos) e **17 suítes, 473 asserções**: `test-correcoes-mobile` 26 · `test-app-backend` 79 · `test-fase1-funcional` 57 · `test-alcadas` 41 · `test-governanca-percentual` 29 · `test-pdv-fluxo` 29 · `test-pdv-rbac` 11 · `test-pdv-visual` 32 · `test-shell-boot` 24 · `test-tema-global` 21 · `test-fase33-topbar` 40 · `test-fase34-identidade` 26 · `test-venda-rapida-nav` 15 · `test-menu-oculto-rbac` 15 · `test-pwa` 24 · `test-fase321-ux` 20 · `test-sidebar-botoes` 23.

### Três premissas atualizadas, e por quê

| Teste | Era | Virou |
|---|---|---|
| `test-tema-global` A6 | "nenhum `font-size` em `.btn`" | idem, **ignorando `@media`** — o tamanho protegido é o do desktop; num breakpoint de celular, aumentar o alvo de toque é o objetivo |
| `test-sidebar-botoes` M | idem | idem |
| `test-sidebar-botoes` N / `test-fase321-ux` C | "175 prefixos de API" | **176** — `/api/orcamento-publico` é a única rota pública nova |

### Lint, tipos e build

**Não existem neste projeto**, e isso é da natureza dele, não uma omissão minha:

| | Situação |
|---|---|
| ESLint | não instalado, sem `.eslintrc` — e `npm install` é negado nesta árvore |
| TypeScript | não há `tsconfig.json`; o projeto é **CommonJS puro**, sem tipos |
| `npm test` | `echo "Error: no test specified" && exit 1` — placeholder |
| `npm run build` | `pkg` para gerar **um .exe do cliente Windows**. Não é build do servidor, que roda direto do fonte — **não roda-lo é o correto** |

O que substitui os três: **`npm run verify`**, que parseia com o motor do Node os 529 `.js` da raiz e de `scripts/`, os 25 de `public/`, os 425 blocos `<script>` inline das telas, e roda 11 suítes.

---

## 9. O que você precisa fazer no servidor

### 1. Reiniciar o worker — **obrigatório**

```
systemctl restart consulta-licitacoes.service
```

Cinco `.js` da raiz mudaram (`pedidos-routes.js`, `auth.js`, `db-schema.js`, `perfis-api-map.js`, `pedido-pdf.js`) e o processo vivo ainda roda o código anterior.

**Até o restart:** os itens 1, 2 e 3 já funcionam (são `public/`, servidos na hora). **Os itens 4, 5, 6 e 7 não** — o botão de link público responderá 404, e o PDF sairá com a paginação antiga.

Depois, confirme: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health` → 302.

**`liciteagora.service` não precisa** — nenhum arquivo de job foi tocado.

### 2. Migração — **já aplicada**

`tokenPublico` e `tokenPublicoEm` criadas nos **19 tenants**, mais o índice único. Backup em `backups/db/2026-09-12-1254/`. `db-schema.js` também foi atualizado, para tenant novo já nascer com elas.

**Nada a rodar.**

### 3. Variáveis de ambiente

**Nenhuma.** O link público usa `location.origin`; não há chave nem configuração nova.

### 4. Commit

Não foi feito, conforme a rotina do projeto.

---

## 10. O que não fiz, e por quê

| Item | Situação |
|---|---|
| **Linhas viram cards em TODAS as telas** | Fiz na página pública do orçamento, onde controlo o HTML. Nas 175 telas do ERP, cada `<td>` precisaria de um `data-label` com o nome da coluna — não dá para inferir com segurança, e errar o rótulo é pior que rolar a tabela. A rolagem própria resolve o estouro **sem esconder nada**; transformar em cards fica para um segundo passo, tela a tela |
| **Botão "Baixar PDF" na listagem** | Fiz na tela do pedido/orçamento e na página pública. Na listagem (`pedidos.html`) não — ali cada linha precisaria do próprio botão, e a tela já tem ação em massa; queria sua opinião sobre onde ele cabe antes de poluir a grade |
| **Testar em aparelho real** | Ver a ressalva |

---

## Ressalvas honestas

**O que validei de verdade:** renderização no Chrome headless nas cinco larguras (320/360/375/390/430), PDF gerado com 42 itens e inspecionado como imagem, e o link público exercido ponta a ponta contra um servidor real com banco descartável.

**O que não validei:** não abri em um Android nem em um iPhone físicos. As medidas de `scrollWidth`, fonte e alvo de toque são do motor do Chrome — que é o do Android, mas não é o WebKit do iPhone. O comportamento do teclado virtual, em particular, só se confirma no aparelho.

**Um ponto que merece seu olho:** a instrução pedia "transformar as linhas em cards no celular". Entreguei rolagem horizontal **dentro** do quadro, não cards, nas telas do ERP — pelo motivo da §10. Se a rolagem lateral dentro da tabela não for boa o suficiente na prática, o caminho é fazer card nas telas mais usadas, uma a uma, com os rótulos escritos à mão.
