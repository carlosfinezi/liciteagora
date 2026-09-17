# 40 — DANFE legível e lista de separação

**Data:** 2026-09-12, 20:10–22:05 BRT
**Escopo:** tabela de produtos do DANFE + documento novo de conferência.

| Unidade | Estado |
|---|---|
| `consulta-licitacoes.service` | PID **2153439** — reiniciado por você desde o relatório 39; as correções anteriores estão no ar |
| `liciteagora.service` | PID 3085849, NRestarts 0 |

> ⚠️ **Ação sua pendente: reiniciar `consulta-licitacoes.service` de novo.** Quatro `.js` da raiz mudaram; até o restart, o DANFE sai no formato antigo e a lista de separação responde 404 (§7).

---

## 1. O achado que mudou a abordagem do item 1

**O DANFE não é gerado por código nosso.** Vem da biblioteca `node-sped-pdf@1.0.66`, chamada em três pontos de `nfe-emit-routes.js`:

```js
const { DANFe } = await import('node-sped-pdf');
const danfePdf = await DANFe({ xml: f.xmlAssinado, logo });
```

E ela aceita **apenas** `{ xml, consulta, logo }` — nenhuma opção de layout, espaçamento ou fonte.

Restavam três caminhos, e nenhum é indolor:

| Caminho | Problema |
|---|---|
| editar `node_modules` | some no próximo `npm install`, e não vai para o git |
| escrever um DANFE do zero | o layout é normatizado; refazer é semanas e risco fiscal |
| **vendorizar** | congela a lib — se ela for atualizada por mudança da SEFAZ, perdemos |

**Escolhi vendorizar**, com a mitigação possível: `vendor/node-sped-pdf/` guarda a cópia, o `VERSAO.txt` registra origem, versão e licença (MIT), e o teste **A4 compara a versão do vendor com a do `node_modules`** — se a lib for atualizada, o teste avisa que o patch precisa ser reaplicado.

**É o trade-off desta entrega, e é seu para revisar.** O patch são ~30 linhas dentro de 1.606; tudo o mais é a lib original.

---

## 2. O que mudou no DANFE

Só o laço de produtos. **Nenhuma coluna, valor ou campo fiscal foi tocado** — as mesmas 14 colunas, na mesma ordem (teste A3 confere uma a uma).

| # | Mudança | Por quê |
|---|---|---|
| 1 | **Linha horizontal** fechando cada produto (0,4pt, preta) | é a resposta para "onde termina este item?". Preta, não cinza: a impressora do balcão é monocromática |
| 2 | **Respiro de 4,2pt** por produto | as descrições de duas linhas encostavam na seguinte |
| 3 | **Quantidade em negrito** | é o número conferido contra a mercadoria, e se perdia no meio de 14 colunas de valores |
| 4 | **Paginação por pontos**, não por "linhas de texto" | o cálculo antigo (`lIndex` contra `blockH / 7.1`) não sabia do respiro; com ele, os últimos produtos passariam do rodapé |

O item 4 é o que garante duas coisas que você pediu: **segunda página em vez de comprimir**, e **produto nunca partido entre páginas** — se não cabe inteiro, vai todo para a próxima.

### O cabeçalho já repetia

Verifiquei antes de mexer: a lib **já redesenha** "DADOS DOS PRODUTOS / SERVIÇOS" e as 14 colunas em cada página, com "Folha 2/2". Não precisou de alteração.

### Resultado, com a nota real de 36 itens

| | Antes | Depois |
|---|---|---|
| Páginas | 1 | **2** |
| Separação entre produtos | nenhuma | **régua horizontal** |
| Descrição de 2 linhas | encostava na seguinte | espaço próprio |
| Quantidade | igual às demais colunas | **negrito** |
| Bytes | 45.684 | 59.567 |

### Sobre a zebra

Você permitiu "se o formato atual deixar". **Não usei no DANFE**, e é decisão consciente: as réguas pretas já resolvem a separação, e um fundo em 36 linhas gasta toner numa folha que é impressa em toda venda. **Usei na lista de separação**, onde o documento é interno e a leitura é em pé.

---

## 3. A lista de separação

Arquivo novo: `separacao-pdf.js`. Não é o DANFE com colunas escondidas — é um documento com outro propósito.

```
LISTA DE SEPARAÇÃO                      VALDIRENE DOS SANTOS LIMA DA SILVA LTDA
─────────────────────────────────────────────────────────────────────────────
Pedido                Nota fiscal           Data
PED-2026-00177        177                   12/09/2026
Cliente
Supermecado Guerra Laranjeiras

 #   CÓDIGO   DESCRIÇÃO DO PRODUTO                    UN    QTD    OK
 1   3000     BICARBONATO DE SÓDIO - FD 20 UN 40G     UN    [1]    ☐
 8   3007     TEMPERO COMPLETO COM AÇAFRÃO - FD 24    UN    [1]    ☐
              UN 400G
```

| Decisão | Motivo |
|---|---|
| Fonte **10** (DANFE usa 8) | a folha é lida em pé, com a mercadoria na mão |
| Linha de **22pt** mínimo | espaço para a descrição respirar |
| **Quantidade** em 13pt, negrito, fundo cinza | é o número que decide se a separação está certa |
| **Caixa de marcação** de 13pt | para riscar com caneta |
| Zebra + régua preta | zebra ajuda; a régua é o que sobrevive em monocromático |
| Altura **medida** (`heightOfString`) | mesma lição do relatório 39 — contar caracteres erra |

### O que fica de fora, e por quê

**Sem NCM, CFOP, CST, ICMS, IPI, PIS, COFINS, preço unitário, total ou qualquer valor em dinheiro.** Duas razões: não ajudam a conferir uma caixa, e **esta folha circula pelo estoque e pelo balcão** — preço de custo e margem não deveriam passear por lá.

O teste **B3** reprova se qualquer um dos 13 termos aparecer no PDF gerado.

### As três ações

| Ação | Comportamento |
|---|---|
| **Visualizar** | abre no visualizador |
| **Baixar** | download por Blob, nome `SEPARACAO-PED-2026-00177.pdf` |
| **Imprimir** | `iframe` oculto + `print()`, com fallback para aba nova |

> O `iframe` em vez de `window.open` + `print()`: no celular a aba nova perde o foco antes de o PDF carregar e o diálogo nunca aparece. Com o `onload` do iframe, o documento está pronto quando a impressão é chamada. Se o navegador bloquear (acontece no iOS), cai para o comportamento antigo.

### A partir da nota fiscal

`GET /api/faturas/:id/separacao` **redireciona** para a rota do pedido, em vez de ter um gerador próprio — senão seriam duas listas que um dia divergiriam. Nota sem pedido (avulsa, devolução, OS) responde **400 com o motivo**, não uma folha vazia.

---

## 4. Testes

`scripts/test-separacao-danfe.js` — **17 testes, 17 OK**, ligado ao verify como passo 12. Os PDFs são **gerados de verdade** e o texto extraído do resultado: um PDF pode sair sem erro e ainda assim ter linhas sobrepostas.

| Bloco | Cobre |
|---|---|
| A (4) | o código usa o vendor · o patch está lá · **nenhuma coluna fiscal removida** · versão registrada |
| B (10) | A4 · 2 páginas com 36 itens · todos os campos · **nada fiscal vaza** · totais · assinaturas em todas · aviso não cortado · descrição íntegra · cabeçalho repetido · lista pequena numa página · nota não emitida |
| C (3) | rotas no pedido e na nota · três ações na tela · download por Blob |

### Cenário de 36 produtos — o do relato

| Verificação | Resultado |
|---|---|
| Tamanho | 595,28 × 841,89 pts = **A4** |
| Páginas | 2 |
| Linhas sobrepostas | **nenhuma** (conferido na imagem) |
| Descrição de 82 caracteres | íntegra, em 2 linhas |
| Totais | **36 produtos diferentes · 141 unidades** |
| Assinaturas | nas 2 páginas |
| Cabeçalho | nas 2 páginas |

### Um defeito encontrado e corrigido no meio

A primeira versão do rodapé colocava o aviso 12pt acima da linha de "Emitido em" — e ele **caía sobre o rótulo "Conferido por"**. Corrigido dividindo o rodapé em três colunas. Na sequência, o texto ficou **truncado** ("...SEM VALOR") porque a coluna do meio tem 1/3 da largura; encurtei para "USO INTERNO — SEM VALOR FISCAL". O teste B6 trava os dois.

### Um teste meu que reprovou um PDF correto

O B7 verificava a descrição longa juntando o texto extraído. Mas `pdftotext -layout` **preserva a posição das colunas**, então uma descrição de duas linhas sai intercalada com as células vizinhas — juntar espaços não reconstrói a frase. O PDF estava certo; o teste é que media errado. Passou a conferir os pedaços, incluindo o **fim** da descrição, que é o que provaria truncamento.

### Regressão — zero falhas

`npm run verify` (3,5s, 12 passos) e **18 suítes, 490 asserções**: `test-separacao-danfe` 17 · `test-correcoes-mobile` 26 · `test-app-backend` 79 · `test-fase1-funcional` 57 · `test-alcadas` 41 · `test-pdv-fluxo` 29 · `test-pdv-rbac` 11 · `test-pdv-visual` 32 · `test-shell-boot` 24 · `test-tema-global` 21 · `test-fase33-topbar` 40 · `test-fase34-identidade` 26 · `test-venda-rapida-nav` 15 · `test-menu-oculto-rbac` 15 · `test-pwa` 24 · `test-fase321-ux` 20 · `test-sidebar-botoes` 23 · `test-governanca-percentual` 29.

---

## 5. Arquivos

**Criados** (4):

| Arquivo | O quê |
|---|---|
| `separacao-pdf.js` | gerador da lista (240 linhas) |
| `vendor/node-sped-pdf/index.js` | cópia da lib, com o patch de legibilidade |
| `vendor/node-sped-pdf/VERSAO.txt` + `package.json` | origem, versão, licença |
| `scripts/test-separacao-danfe.js` | 17 testes |

**Alterados** (5):

| Arquivo | O quê |
|---|---|
| **`nfe-emit-routes.js`** | 3 chamadas apontam para o vendor |
| **`pedidos-routes.js`** | rota `/api/pedidos/:id/separacao` |
| **`faturas-routes.js`** | rota `/api/faturas/:id/separacao` (delega) |
| `public/comercial/pedido.html` | 3 ações + `verSeparacao`/`baixarSeparacao`/`imprimirSeparacao`/`baixarArquivo` |
| `scripts/verify.js` | passo 12 |

**Em negrito: exigem restart.**

---

## 6. Migrações e variáveis

**Nenhuma.** Não houve mudança de schema, nem coluna nova, nem variável de ambiente. A lista de separação lê os mesmos dados que o PDF do pedido já lia.

---

## 7. O que executar no servidor

```
systemctl restart consulta-licitacoes.service
```

Depois: `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/health` → 302.

**Até o restart:** o DANFE sai no formato antigo (o `import` do vendor não está carregado) e `/api/pedidos/:id/separacao` responde 404. A tela já mostra os três botões — são `public/`, servidos na hora —, e eles falharão com "documento não foi encontrado" até o processo recarregar.

`liciteagora.service` **não precisa** — nenhum arquivo de job foi tocado.

---

## 8. Ressalvas

**O vendor congela a lib.** Se `node-sped-pdf` publicar uma versão nova — inclusive por mudança de layout exigida pela SEFAZ —, continuaremos na 1.0.66 até alguém reaplicar o patch. O teste A4 avisa quando as versões divergirem, mas **avisar não é aplicar**. Vale colocar isso na lista de coisas a revisar quando houver mudança fiscal.

**Não imprimi em papel.** Validei por renderização a 100 dpi e extração de texto. Contraste de uma régua de 0,4pt e legibilidade da fonte 10 em impressora térmica ou jato de tinta cansado só se confirmam imprimindo. Se a régua sair fraca no seu equipamento, é um número a subir — está em `vendor/node-sped-pdf/index.js`, na linha do `thickness`.

**O DANFE agora usa 2 páginas onde usava 1.** É o efeito direto de não comprimir, e foi o que você pediu. Mas dobra o papel de toda venda com muitos itens — se o custo incomodar, o `PADDING_PROD` (4,2pt) é o parâmetro que regula o meio-termo.

**Não mexi no DANFE da NFC-e.** A lib tem um segundo bloco, para o modelo 65, com a mesma estrutura. O relato era sobre a NF-e, e o PDV de NFC-e não tem uso registrado (relatório 33). Se a conferência de cupom também incomodar, o mesmo patch se aplica lá.
