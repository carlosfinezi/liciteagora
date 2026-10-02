# Os rótulos que NÃO foram ligados ao campo, e por quê

Levantado e decidido em 02/10/2026, par por par. Quem for mexer nisto: a
ligação já feita é guardada pela suíte `scripts/test-rotulos-campos.js`; o que
está aqui é o que ficou de fora **de propósito**, e cada grupo pede um conserto
diferente de `for=`.

## O número de partida

**1.982 `<label>` sem `for=`**, em 206 telas (fora de `public/loja/`). Deles:

| n | o que é | o que foi feito |
|--:|---|---|
| **1.649** | par único e claro: um rótulo, um campo com id, no mesmo bloco | **ligado** |
| 229 | o rótulo ENVOLVE o campo | nada a fazer |
| 46 | rótulo de LEITURA, sobre um valor exibido | ver abaixo |
| 30 | rótulo de um GRUPO de controles | ver abaixo |
| 14 | `&nbsp;` usado como espaçador de layout | ver abaixo |
| 8 | um rótulo para DOIS campos | ver abaixo |
| 6 | campo sem `id` e sem `name`, dentro de template de JavaScript | ver abaixo |

Dos 1.649 ligados, 1.622 são par direto, 13 têm o id montado por JavaScript (o
`for` leva a mesma expressão) e 14 ganharam um `id` porque só tinham `name`.

Dois dos 1.622 saíram de uma **segunda passada**, com janela maior: o varredor
parava no fecha do bloco do rótulo, e em `comercial/crm-oportunidade.html:226`
("Descrição" → `#descInline`) e `fiscal/nfe-detalhe.html:110` ("Texto da
correção" → `#cceTexto`) o campo está no bloco irmão, logo abaixo. São pares
legítimos, e passaram a ser ligados à mão.

## O rótulo que ENVOLVE o campo (229): nada a fazer

`<label>Ativo <input type="checkbox"></label>`. A ligação existe pela
aninhagem, e o navegador a enxerga (`label.control` devolve o campo). Um `for`
aqui seria repetição.

## Rótulo de LEITURA (46): o alvo não é um campo

```html
<div><label class="muted">Status SEFAZ</label><div>Autorizada</div></div>
```

São 46 casos, em quatro telas: `fiscal/fatura-detalhe.html` (18),
`fiscal/regras-tributarias.html` (12, no simulador), `licitacoes/agenda.html`
(12) e `locacao/painel.html` (4). O `<label>` está sobre um valor que ninguém
edita — não há campo a apontar, e o `for` não tem onde cair.

**O conserto certo é outro, e não é `for`:** `<label>` é o elemento do
formulário, e usá-lo como legenda de um dado de leitura engana o leitor de
tela, que anuncia "rótulo" e não acha controle. O par certo é
`<dt>`/`<dd>`, ou um `<span class="rotulo">`. É mudança de marcação em quatro
telas, com CSS a reavaliar (`label` tem estilo próprio no
`app-modern.css`), e por isso ficou fora desta rodada.

## Rótulo de GRUPO de controles (30): o `for` mentiria

```html
<div class="form-group">
  <label>Cor</label>
  <div class="color-picker">
    <div class="color-option" data-cor="#2196F3"></div>
    ... (mais quatro)
  </div>
</div>
```

O rótulo nomeia um CONJUNTO: cinco quadrados clicáveis (`operacional/grupos-palavras.html:110`),
uma lista de caixas de seleção (`comercial/pessoas.html:572` "Categorias",
`comunicacao/campanha.html:114` "Segmentos"), uma paleta
(`catalogo/catalogo-online.html:1543`), uma tabela de atributos
(`varejo/marketplaces.html:711`). Apontar um `for` escolheria UM dos controles
e mentiria sobre os outros.

**O conserto certo:** `<fieldset>` com `<legend>`, ou
`role="group" aria-labelledby`. Em vários casos os controles não são nativos
(são `<div>` com `data-cor`), e aí falta também `role`/`tabindex` para o
teclado alcançá-los — é uma frente de acessibilidade por si, não a deste dia.

Lista completa, por tela e linha:

- `catalogo/catalogo-online.html`: L1543, L1639
- `catalogo/produto.html`: L444
- `catalogo/produtos.html`: L138
- `comercial/contrato.html`: L146
- `comercial/crm-funil.html`: L269
- `comercial/crm-oportunidade.html`: L133
- `comercial/pedidos-pdv.html`: L430
- `comercial/pessoas.html`: L572
- `comercial/visita.html`: L278
- `comunicacao/campanha.html`: L73, L114, L185
- `comunicacao/canal.html`: L324
- `financeiro/contas-a-receber-detalhe.html`: L179
- `financeiro/fluxo-caixa.html`: L78
- `financeiro/politicas-prazo.html`: L98, L111
- `fiscal/apuracao-sn.html`: L98
- `fiscal/configuracao.html`: L135, L142
- `locacao/locacoes.html`: L398
- `operacional/grupos-palavras.html`: L110, L142
- `producao/apontamento.html`: L38
- `restaurante/cardapio.html`: L135
- `ssl/integracao.html`: L81
- `varejo/loja.html`: L118
- `varejo/marketplaces.html`: L711, **L718** (este com o id montado por
  JavaScript: "Atributos obrigatórios" nomeia uma TABELA com um `<select>` por
  linha, e o `for="${o.id}"` apontaria o de uma linha só)

## `<label>&nbsp;</label>` como espaçador (14): não é rótulo

Serve para alinhar um botão com a linha dos campos ao lado. Não nomeia nada, e
hoje o leitor de tela anuncia um rótulo vazio.

- `catalogo/etiquetas.html`: L83
- `configuracoes/importacao.html`: L64, L80
- `financeiro/contas-a-pagar-detalhe.html`: L83, L115
- `financeiro/contas-a-receber-detalhe.html`: L90, L122
- `fiscal/apuracao-sn.html`: L94
- `fiscal/cadastro-cfops.html`: L84
- `fiscal/defis.html`: L77
- `fiscal/fiscal-arquivamento.html`: L48, L52, L56, L60

**O conserto certo:** trocar por `<div aria-hidden="true">` ou resolver o
alinhamento no CSS. É mexer em layout de 8 telas, e por isso não entrou aqui.

## Um rótulo para DOIS campos (8): o `for` cobriria metade

| tela | rótulo | os dois campos |
|---|---|---|
| `licitacoes/consulta.html`:730 | Valor estimado (R$) | mínimo e máximo |
| `operacional/analises-ia.html`:148 | Score | mínimo e máximo |
| `comercial/vendas-perdidas.html`:63 | Vincular a pedido / orçamento | busca e seleção |
| `estoque/movimentacao-nova.html`:71 | Números de série (um por linha) | modo e lista |
| `habilitacao/certidoes.html`:104 | Tipo de documento * | seletor e texto livre |
| `locacao/itens.html`:51 | Produto | o escolhido e a busca |
| `locacao/locacoes.html`:407 | Avalistas | nome, documento e telefone |
| `varejo/loja.html`:125 | Cor principal | seletor de cor e o hexa |

**O conserto certo** é o mesmo do grupo: `fieldset`/`legend` no par, com um
`aria-label` em cada campo dizendo qual é a ponta ("mínimo", "máximo").

## Campo sem `id` e sem `name`, em template de JavaScript (6)

- `catalogo/loja-montagem.html`: L107, L108, L136, L137
- `comercial/tabelas-preco.html`: L245
- `varejo/marketplaces.html`: L689

O campo é lido por posição (`querySelectorAll` na linha da tabela), e o
template se repete N vezes. Um `id` fixo colidiria a partir da segunda linha, e
dar um id único exige o índice da iteração chegar até ali — que é mudança no
JavaScript daquelas telas, não marcação.

## Os 14 ids que foram CRIADOS, e o prefixo

| tela | campos | prefixo |
|---|---|---|
| `landing/contato.html` | nome, telefone, email, empresa, cnpj, mensagem | `ct-` |
| `landing/trial.html` | nome, telefone, email, empresa, cnpj | `tr-` |
| `auth/admin/index.html` | slug, name, ownerEmail | `nt-` |

Esses campos tinham `name` e nenhum `id`. Conferido antes: nenhum dos ids novos
colide com id existente na tela. **O prefixo não é enfeite:** um `id="name"`
num `<input>` entra no acesso nomeado do navegador e convive mal com o
`window.name` nativo. O `name` não foi tocado, porque é dele que o `FormData`
desses três formulários depende.

---

## Anexo: os diálogos fora da convenção `.modal`

Levantado no mesmo dia, pela peça `public/js/dialogo.js`. Todas as classes de
diálogo do sistema, contadas: `.modal` (197), `.modal-bg` (187),
`.modal-content` (12), `.modal-overlay` (4), `.modal-card` (2), `.modal-box`
(1). Três estão fora disso:

| onde | classe | o que foi feito |
|---|---|---|
| `operacional/lances.html` | `.help-modal-card` | ganhou `data-dialogo`, o gancho da peça |
| `comercial/pedido.html` | `.drawer-right` (com `.drawer-overlay`) | **não tratado** |
| `comercial/pedidos-pdv.html` | `.gaveta-bg` | **não tratado** |

**Por que as duas gavetas ficam de fora:** elas são painel LATERAL, que entra
deslizando e ocupa a altura toda. Tratá-las como diálogo modal (prender o foco,
anunciar `role="dialog"`) é decisão de desenho — numa gaveta de ações pode ser
certo, numa gaveta de carrinho que fica aberta junto do conteúdo é errado. O
caminho, quando alguém decidir, é o mesmo `data-dialogo`: uma palavra por
gaveta, sem tocar a peça.
