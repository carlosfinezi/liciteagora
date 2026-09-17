# Fase 0 (conclusão) — limites de quantidade, unidade de medida e desativação do pagamento manual

Data: 2026-09-10 · Conclusão da Fase 0 do projeto **Catálogo Online + Pedidos PDV**.
Base: [`06`](06-fase-0-frete-pagamento.md) · [`07`](07-fase-0-quantidade.md) §5.1 e §6.

> **Nenhum commit.** Nenhum serviço reiniciado. Nenhuma migration. Nenhum
> backfill. Nenhuma escrita no banco de produção. Nenhum `reset`, `stash` ou
> `clean`.

Três pontos: rota obsoleta desativada, teto de quantidade e regra de decimal por
unidade. Nada de Catálogo Online, Pedidos PDV ou PDV/NFC-e.

---

## 1. Auditoria final de `registrar-pagamento`

Busca em **todo o repositório**, não só em `public/`:

| Onde procurei | Resultado |
|---|---|
| `registrar-pagamento`, `registrarPagamento`, `registrar_pagamento` | 1 definição da rota + menções nos relatórios 06 e 07 |
| `fetch` / `axios` / `form action` com a URL | nada |
| URL montada dinamicamente (`'/api/pedidos/' + id + ...`) | 10 ocorrências em `public/comercial/pedido.html` e `public/estoque/reservas.html`, todas para `parcelas`, `converter-modo`, `pdf`, `PUT` e `reservar` — **nenhuma** para `registrar-pagamento` |
| `.md` (docs, README, guias, CHANGELOG) | só os relatórios 06 e 07 |
| scripts, Electron, integrações | nada |

**Um falso positivo, verificado:** `public/restaurante/caixa.html:308` define uma
função `registrarPagamento()`. É homônima e chama
`/api/restaurante/comandas/…` — o caixa do restaurante, outro módulo, outro
endpoint. **Não é consumidor.**

Somando à auditoria do relatório 07: nenhum dos 9 pedidos com `valorPago > 0` na
base veio dessa rota (todos têm CR por fatura). **Zero consumidores, zero dados.**

### 1.1 Mudança aplicada

`pedidos-routes.js:1576` — a rota passa a responder **410 Gone** e **não grava
nada**:

```json
{
  "success": false,
  "error": "Endpoint descontinuado. Utilize o fluxo financeiro de contas a receber.",
  "alternativa": "Crie a conta a receber com pedidoId e dê baixa por /api/contas-a-receber/:id/baixar"
}
```

**Por que 410 e não 404**: o endereço existiu, e a recusa é deliberada e
permanente. Um cliente esquecido descobre pela resposta, em vez de achar que
digitou errado. **Não redireciona em silêncio** para o fluxo novo — as semânticas
são diferentes (uma soma no pedido × um recebimento no financeiro) e quem chama
precisa decidir.

**Registro da tentativa**: reusei o `logAction` que o módulo já usa em outros
pontos — `action = 'endpoint-descontinuado'`, com o endpoint e o valor enviado
no payload. Nenhuma estrutura nova. Ressalva documentada: `logAction` exige
`req.user` (`audit-log.js:19`), então chamada por `X-Api-Key` não gera linha —
por isso há também um `console.warn`, que cobre o caso sem sessão.

O corpo antigo está preservado no comentário do endpoint, com o motivo da
desativação: o que ele fazia, por que divergia do financeiro e qual é o caminho
correto.

---

## 2. Limite máximo de quantidade

### 2.1 Auditoria antes de escolher o número

**Tipos das colunas** (todas `REAL`, e `NOT NULL` onde importa):

| Tabela | Coluna | Tipo |
|---|---|---|
| `pedido_itens` | `quantidade` | REAL NOT NULL |
| `movimentacoes_estoque` | `quantidade` | REAL NOT NULL |
| `reservas_estoque` | `quantidade` | REAL NOT NULL |
| `fatura_itens`, `nfce_itens`, `os_itens_pecas` | `quantidade` | REAL NOT NULL |

**Maiores quantidades reais em `pedido_itens`**, nos 13 tenants:

| Tenant | Itens | Maior quantidade |
|---|---:|---:|
| `produtosbomgosto` | 505 | 14 |
| `1bit` | 23 | 150 |
| `josecarloscostafilho` | 9 | **240** |
| `raeldouglas` | 4 | 1 |
| `jaagricola` | 1 | 3 |
| outros 8 | 0 | — |

**Fora de `pedido_itens`**, o cenário muda:

- `movimentacoes_estoque` do `produtosbomgosto` tem **10 registros acima de 1
  milhão**, o maior com **9.999.999.998** — todos `origem = 'saldo_inicial'`,
  observação *"Importação inicial do export Bling/Tiny"*. É o "estoque infinito"
  que o Bling usa para produto sob demanda. Não é item de pedido, mas mostra que
  valores enormes circulam legitimamente no ERP.
- **O catálogo de licitações do PNCP** — o domínio central deste sistema — numa
  amostra de 0,5% (109.628 itens): **maior quantidade = 129.157.600** e **151
  itens acima de 1 milhão**. Extrapolando, ~30 mil itens do catálogo passam de
  1 milhão de unidades.

**Preços, para dimensionar o produto `quantidade × precoUnitario`:**

| | |
|---|---:|
| maior `produtos.precoVenda` (13 tenants) | R$ 43.500,00 |
| maior `pedido_itens.valorTotal` | R$ 60.000,00 |
| `Number.MAX_SAFE_INTEGER` | 9.007.199.254.740.991 |
| faixa de **centavos exatos** no double | até ~R$ 90.071.992.547.409 (9,0e13) |

### 2.2 O limite escolhido: `QUANTIDADE_MAXIMA = 1e9`

`pedidos-routes.js:145`, constante nomeada e documentada — não número mágico.

**Justificativa:**

1. **7,7× a maior quantidade observada no domínio** (1,29e8 no catálogo de
   licitações). Um teto de 1e6, que parece generoso à primeira vista,
   **recusaria venda legítima** — é o erro que você pediu para evitar.
2. **Folga numérica confortável**: com o maior preço cadastrado hoje
   (R$ 43.500), `1e9 × 43.500 = 4,35e13` — ainda dentro da faixa de centavos
   exatos do double (9,0e13). Não há perda de precisão em cenário realista.
3. **Barra o absurdo**: `1e308` era finito e positivo, e passava. Agora não.
4. **Não estorva peso, volume ou atacado**: 1e9 kg é um milhão de toneladas;
   1e9 unidades é mais do que qualquer pregão já comprou.

**Limitação assumida e documentada:** num cenário extremo e irreal — quantidade
no teto **e** preço unitário de R$ 1.000.000 — o produto daria 1e15, acima da
faixa de centavos exatos. Continua abaixo de `MAX_SAFE_INTEGER`, então não há
overflow; haveria arredondamento no centavo. Não travei isso: exigiria validar o
par (quantidade × preço), que é regra nova e não foi pedida.

---

## 3. Unidades de medida

### 3.1 Como funciona hoje — auditoria

- **`produtos.unidade` é TEXT livre.** Não há tabela de unidades, não há coluna
  `fracionavel`, `fracionado`, `permiteFracao` ou `casasDecimais` — procurei por
  todas. Confirmado por `PRAGMA table_info(produtos)`.
- Há um catálogo auxiliar em `produto_lookup` com `tipo = 'unidade'`, mas ele é
  **lista de valores para o autocomplete**, sem nenhum atributo além do texto.
- **Nenhuma validação de unidade existe** em compras, vendas, estoque ou fiscal.

**Unidades realmente cadastradas nos 13 tenants:**

| Unidade | Produtos | Classificação |
|---|---:|---|
| `UN` | 220 | não fracionável |
| `MES` | 12 | **ambígua** — pro-rata de meio mês existe |
| `PC` / `pc` | 8 | não fracionável |
| `KG` | 3 | **fracionável** |
| `2`,`3`,`4`,`6`,`7`,`8`,`9` | 13 | **lixo de importação** (coluna trocada) |
| `KIT` | 1 | não fracionável |
| `CX` | 1 | não fracionável |

Ou seja: **de ~258 produtos, só 3 têm unidade fracionável**, e 13 têm lixo no
campo.

### 3.2 A regra implementada — conservadora por decisão

Como não existe estrutura para consultar (e **não criei migration**, conforme
sua instrução), a regra vive em código: `UNIDADES_INTEIRAS`
(`pedidos-routes.js:179`).

**O desenho é deliberadamente assimétrico**: a fração só é recusada quando a
unidade **está na lista** de não fracionáveis. Unidade desconhecida, vazia ou
ambígua **aceita** decimal.

O inverso — exigir que a unidade esteja numa lista de fracionáveis — quebraria
venda legítima por causa do cadastro sujo que acabei de medir: os 12 produtos em
`MES` e os 13 com unidade numérica passariam a recusar qualquer fração.

**Lista adotada** (unidades reais + variantes ortográficas + as universalmente
discretas):

```
UN, UND, UNID, UNIDADE, UNIDADES
PC, PCS, PECA, PECAS
CX, CAIXA, CAIXAS
KIT, KITS
PCT, PACOTE
PAR, PARES
DZ, DUZIA
JG, JOGO
RESMA
```

**Fora da lista de propósito:**

- `MES` — meio mês existe em contrato pro-rata;
- `RL` / `FD` (rolo, fardo) — menos inequívocas; não quis arriscar;
- `KG, G, L, ML, M, M2, M3, TON` — fracionáveis por natureza, e a regra já as
  aceita por não estarem na lista;
- os valores numéricos — lixo, e tratá-los como unidade seria dar significado a
  um erro de importação.

**Normalização**: maiúsculas, sem acento (NFD + remoção de diacríticos) e sem
pontuação. `pç`, `PÇ`, `pc.` e `Pc` caem todas em `PC`. Verificado.

### 3.3 Precisão decimal: 4 casas — reutilizada, não inventada

`QUANTIDADE_CASAS_DECIMAIS = 4` (`pedidos-routes.js:155`).

**Não escolhi o número: o ERP já o pratica.** A emissão fiscal grava `qCom` e
`qTrib` com `toFixed(4)` — o padrão SEFAZ — na NF-e (`nfe-emit-routes.js:623` e
`:628`) e na NFC-e (`nfce-routes.js:428` e `:433`).

Aceitar mais casas no pedido faria a **nota arredondar em silêncio** e divergir
do documento que a originou. Sua sugestão de 3 casas seria mais restritiva do
que a nota fiscal comporta, e criaria uma segunda precisão no mesmo sistema.

A verificação usa comparação com o próprio arredondamento
(`Number(n.toFixed(4)) !== n`) em vez de contar caracteres após o ponto — assim
a notação exponencial também é pega: `1e-7` seria "0 casas" num `split('.')`, e
é corretamente recusado.

**Nada é arredondado**: valor fora da precisão é recusado com 422.

### 3.4 Comportamento final do helper

`erroQuantidade(valor, unidade)` — cinco recusas, da mais grosseira à mais
específica:

| Entrada | Unidade | Resultado |
|---|---|---|
| `1`, `2`, `"2"` | qualquer | aceita |
| `2.0` | `UN` | **aceita** (é inteiro em JS) |
| ausente, `null`, `''` | — | `quantidade obrigatoria` |
| `"abc"`, `NaN`, `Infinity` | — | `quantidade invalida` |
| `0`, `-1`, `"-3"` | — | `quantidade deve ser maior que zero` |
| `1e9` | — | **aceita** (exatamente no teto) |
| `1e9 + 1`, `1e308` | — | `quantidade acima do maximo permitido (1.000.000.000)` |
| `1.2345` | `KG` | aceita |
| `1.23456`, `1e-7` | `KG` | `quantidade com mais de 4 casas decimais` |
| `1.5` | `UN`, `PÇ`, `pc` | `unidade "…" nao aceita quantidade fracionada` |
| `1.5` | `MES`, `6`, vazia, ausente | **aceita** |

---

## 4. Item sem `produtoId` (avulso)

**Decisão: preservar o legado, com as quatro guardas numéricas.**

Item avulso não tem produto e, portanto, não tem unidade a consultar.
`unidadeDoProduto()` devolve `null` e `erroQuantidade` trata `null` como "não
restringe". Concretamente, para o item avulso:

| Regra | Vale? |
|---|---|
| finita, numérica | **sim** |
| maior que zero | **sim** |
| dentro do teto de 1e9 | **sim** |
| até 4 casas decimais | **sim** |
| inteiro conforme unidade | **não** — não há unidade |

Isso é exatamente a sugestão do seu pedido, e é o que preserva o comportamento
legado do ator irrestrito. Lembrando o que já valia desde 10/09: **vendedor
restrito não cria item avulso** (422). Testado em `LM8`.

---

## 5. Todos os caminhos

A validação é central (um helper) e aplicada nos três caminhos que leem do
corpo:

| Caminho | Linha | Unidade consultada | Resposta |
|---|---|---|---|
| `POST /api/pedidos` com `itens[]` | `:615` | `unidadeDoProduto(it.produtoId)` | item não entra, vira `avisos[]` |
| `POST /api/pedidos/:id/itens` | `:997` | `unidadeDoProduto(produtoId)` | **422** |
| `PUT /api/pedidos/:id/itens/:itemId` | `:1041` | `unidadeDoProduto(b.produtoId ?? item.produtoId)` | **422**, sobre a quantidade **resultante** |

`unidadeDoProduto()` (`:347`) é um helper de escopo com `try/catch`: produto
inexistente ou tenant sem a coluna devolve `null` e não restringe.

**Os demais fluxos continuam intactos e seguros** — reconferidos:

| Fluxo | Situação |
|---|---|
| Loja virtual | `POST /loja/api/carrinho` já faz `if (!(qtd > 0))` e descarta (`loja-routes.js:305`). Não passa pelo helper e não precisa |
| Mercado Livre | `Number(oi.quantity) \|\| 0` da API do ML |
| Faturamento de OS | quantidade vem de `os_itens_pecas` / `os_itens_servicos` |
| `importar-participacao` | quantidade vem de `itens` / `sniper_itens` do banco |
| PDV / NFC-e | **não tocado**, por instrução |

Nenhum deles foi alterado.

---

## 6. Arquivos e funções alterados

| Arquivo | O que mudou |
|---|---|
| `pedidos-routes.js` | **`QUANTIDADE_MAXIMA`**, **`QUANTIDADE_CASAS_DECIMAIS`**, **`UNIDADES_INTEIRAS`**, **`unidadeAceitaFracao()`** (novas) · `erroQuantidade()` ganhou teto, precisão e o parâmetro `unidade` · **`unidadeDoProduto()`** (nova, helper de escopo) · as três chamadas passam a unidade · `registrar-pagamento` → **410** |
| `scripts/test-app-backend.js` | blocos `LM` (11 testes) e `RP` (3 testes); seed com produto `KG` e produto de unidade ambígua; `QT2` migrado de unidade |
| **`docs/.../08-…md`** | este relatório |

**Três arquivos.** Nada tocado em `pedido-politicas.js`, `contas-receber-routes.js`,
`reservas-routes.js`, `produtos-routes.js`, `loja-routes.js`, `os-routes.js`,
`auth.js`, `auth-routes.js` ou no fiscal.

---

## 7. Testes

**79 testes, 79 OK, 0 falhas** em `scripts/test-app-backend.js` (65 anteriores +
14 novos). `scripts/test-fase0-pagamento-pedido.js`: 15 OK.

### Bloco `LM` — teto, precisão e unidade

| # | Teste | Resultado |
|---|---|---|
| LM1 | exatamente **no** limite (1e9) → aceita | ✅ |
| LM2 | um acima do limite → 422, nada gravado | ✅ |
| LM3 | **1e308** → 422 *(o caso que passava por ser finito)* | ✅ |
| LM4 | unidade `UN`: `1` aceita, `2.0` aceita, **`1.5` → 422** | ✅ |
| LM5 | unidade `KG`: `0.5` e `1.25` aceitam, total confere | ✅ |
| LM6 | 4 casas aceita, 5 casas → 422 | ✅ |
| LM7 | unidade **ambígua** (`'6'`) não barra fração | ✅ |
| LM8 | item **avulso**: fração aceita; teto e zero recusados | ✅ |
| LM9 | **PUT** respeita teto, precisão e unidade; item preservado | ✅ |
| LM10 | `POST /api/pedidos` com `itens[]`: 2 avisos, 1 item, total certo | ✅ |
| LM11 | recusada **não cria reserva nem movimentação**; confirmar dá "sem itens" | ✅ |

### Bloco `RP` — endpoint descontinuado

| # | Teste | Resultado |
|---|---|---|
| RP1 | responde **410**, `valorPago` e `statusPagamento` intactos | ✅ |
| RP2 | **não cria CR** e **não lança movimentação financeira** | ✅ |
| RP3 | a tentativa entra no `audit_log` com o usuário real | ✅ |

### Uma falha que eu mesmo causei

`QT2`, escrito na etapa anterior, usava 2,5 no produto de unidade `UN` — e a
regra nova passou a recusar, **com razão**. Migrei o teste para o produto `KG`:
o que ele prova ("decimal continua funcionando") vale igual, na unidade em que
decimal faz sentido. Não afrouxei a regra para deixar o teste verde.

### Regressão

`npm run verify` → **OK: sintaxe válida**.

| Suíte | Resultado |
|---|---|
| `test-app-backend` | **79 OK, 0 falhas** |
| `test-fase0-pagamento-pedido` | 15 OK, 0 falhas |
| `test-reservas-pedido` | 11 OK, 0 falhas |
| `test-venda-perdida-pedido` | 16 OK, 0 falhas |
| `test-metas-bi` | 21 OK, 0 falhas |
| `test-deposito-movimentacao` | 14 OK, 0 falhas |
| `test-devolucao-venda-espelho` | 17 OK, 0 falhas |
| `test-devolucoes-credito-metas-comissao` | 22 OK, 0 falhas |
| `test-devolucoes-custo-saldo-estorno` | 22 OK, 0 falhas |
| `test-cartao-recebiveis` | 12 OK, **1 falha pré-existente** |
| `test-comissoes` / `test-boletos-pagar` | **crash pré-existente** (`no such table: fornecedores`) |
| `test-pedido-compra` | **crash pré-existente** (dump ausente em `/tmp`) |

As quatro pré-existentes seguem **idênticas** e não foram corrigidas.

---

## 8. Compatibilidade

| Fluxo | Efeito |
|---|---|
| Tela `/comercial/pedido.html` | quantidade positiva inteira continua passando. **Mudança visível**: quem digitar `1,5` num produto `UN` passa a receber 422 com a mensagem explicando. Era venda que não deveria existir |
| Produtos `KG` (3 no cadastro) | ganham fração até 4 casas, que a tela já permitia digitar |
| Produtos com unidade suja (`MES`, `'6'`) | **inalterados** — a regra não os restringe |
| Loja, ML, OS, importação | **inalterados**, nenhum passa pelo helper |
| Emissão fiscal | **inalterada**, e agora protegida: a quantidade do pedido nunca excede o que `qCom` comporta |
| Reserva e estoque | inalterados; item inválido não chega até eles |
| `registrar-pagamento` | **410**. Sem consumidor, ninguém quebra |
| Hardening de 26/08 e de 10/09 | **intacto** — 79 testes verdes, incluindo os 45 originais |

---

## 9. Riscos que ainda restam

| Risco | Estado |
|---|---|
| `quantidade × preço` em cenário extremo (1e9 × R$ 1M) sai da faixa de centavos exatos | aberto; exigiria validar o par, regra nova |
| Unidade é texto livre, sem cadastro | **estrutural** — a regra por código é paliativo honesto. Resolver de verdade pede coluna `fracionavel` em `produtos` ou tabela de unidades: **é migration, e parei antes** (§11) |
| 13 produtos com unidade numérica (lixo de importação) | dado sujo, não corrigido — seria escrita em produção |
| `MES` tratado como fracionável | decisão consciente; se a proprietária disser que mês é indivisível, é uma linha na lista |
| Item avulso com preço negativo por ator irrestrito | aberto **por desenho** |
| 4 pedidos com R$ 10.036,00 não refletidos | medido no relatório 07; **backfill não autorizado** |
| PDV/NFC-e aceita preço e desconto do navegador | intocado por instrução |
| Rotas por `:id` sem escopo de vendedor | dívida do módulo |

---

## 10. Diff isolado desta etapa

| Arquivo | Diff desta etapa |
|---|---|
| `pedidos-routes.js` | **+152 −17**, em 7 pontos |
| `scripts/test-app-backend.js` | +139 (blocos `LM` e `RP`, seed, `QT2`) |
| `docs/.../08-…md` | arquivo novo |

Os sete pontos em `pedidos-routes.js`:

| # | Ponto | Linha |
|---|---|---|
| 1 | `QUANTIDADE_MAXIMA` + docstring | `:145` |
| 2 | `QUANTIDADE_CASAS_DECIMAIS` + docstring | `:155` |
| 3 | `UNIDADES_INTEIRAS` + `unidadeAceitaFracao()` | `:179`, `:191` |
| 4 | `erroQuantidade()` — teto, precisão, unidade | `:239` |
| 5 | `unidadeDoProduto()` (helper de escopo) | `:347` |
| 6 | as três chamadas passam a unidade | `:615`, `:997`, `:1041` |
| 7 | `registrar-pagamento` → 410 + auditoria | `:1576` |

Contagem, medida bloco a bloco no arquivo: constantes e docstrings 58 linhas
(16 + 8 + 34), `unidadeAceitaFracao` 8, `unidadeDoProduto` 10, rota 410 41,
mais o que `erroQuantidade` ganhou (docstring estendida e as três recusas novas)
e as três chamadas que passaram a receber a unidade.

> **Aviso para ler `git diff`:** `pedidos-routes.js` acumula várias frentes não
> commitadas (hardening de 26/08 e 10/09, CFOP, depósito, condições de
> pagamento) e as duas etapas anteriores de hoje. Filtrar os hunks pelos
> marcadores desta etapa devolve **+317 −37** — e a maior parte disso **não é
> desta etapa**: vem junto porque cai no mesmo bloco contíguo. Os números da
> tabela acima são a contagem real, medida bloco a bloco.

---

## 11. Onde parei, e por quê

Você pediu para não fazer migration se a regra de unidade exigisse mudança de
schema. **Exige, e parei antes.**

O que fica garantido com a estrutura atual: a lista `UNIDADES_INTEIRAS` no
código, com fallback permissivo para unidade desconhecida. Funciona, é
conservadora e não quebra ninguém.

O que **não** fica garantido, e precisa de decisão sua numa etapa futura:

1. **Uma unidade nova cadastrada por um tenant não é classificada.** Se alguém
   cadastrar `FRASCO`, ela aceita fração por omissão.
2. **A classificação é global**, igual para os 13 tenants. Um tenant que venda
   `CX` fracionada (meia caixa) não tem como dizer isso.
3. **O cadastro sujo continua sujo** — 13 produtos com unidade numérica.

A solução estrutural seria uma coluna `fracionavel` em `produtos` (ou uma tabela
`unidades` por tenant, alimentada pelo `produto_lookup` que já existe). **Não
criei nem uma nem outra.**

---

## 12. Confirmação

- **Serviço NÃO reiniciado** — nenhum `systemctl` executado.
- **Código novo NÃO carregado em produção** — `pedidos-routes.js` é lido pelo
  `server.js`, e o processo em memória segue com a versão anterior. Só passa a
  valer no restart, que é pedido seu.
- **Banco de produção NÃO alterado** — só `SELECT` e `PRAGMA` nos tenants, e
  uma consulta de leitura com `TABLESAMPLE` no catálogo Postgres. Bancos de
  teste em `/tmp`.
- **Nenhum backfill executado.**
- **Nenhuma migration** — nenhuma coluna, tabela ou índice.
- **Nenhum commit** — e nenhum `reset`, `stash` ou `clean`. Nenhuma alteração
  preexistente da árvore foi descartada.
