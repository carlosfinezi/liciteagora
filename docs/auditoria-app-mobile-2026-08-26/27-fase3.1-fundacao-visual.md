# 27 — Fase 3.1: verify reforçado e fundação visual

**Data:** 2026-09-11, 15:36–16:00 BRT
**Referência:** [26 — plano de modernização](26-modernizacao-visual-global-plano.md)
**Resultado:** ambas as partes concluídas. **Nenhum restart.** Nenhum pixel
alterado na aparência atual — e isso é o ponto central da Parte B (§4).

**Serviços — início e fim, idênticos:**

| Unidade | PID | Start | NRestarts |
|---|---|---|--:|
| `consulta-licitacoes.service` | 3777293 | 12:14:16 | 0 |
| `liciteagora.service` | 3085849 | 06:18:49 | 0 |

---

# PARTE A — verify reforçado

## 1. O problema, medido

O verify antigo:

```
find . scripts -maxdepth 1 -name '*.js' -print0 | xargs -0 -n1 node --check
```

Dois defeitos, e o segundo já custou uma tela branca:

1. **Lento: 38,8 segundos.** `xargs -n1 node` inicia **um processo Node por
   arquivo** — 521 processos, quase todo o tempo gasto subindo e derrubando o
   runtime. Verificação lenta é verificação que se deixa de rodar.
2. **Cego para `public/`.** `-maxdepth 1` alcança a raiz e `scripts/`. Em
   2026-09-11 uma crase num comentário quebrou `public/js/sidebar.js`, o verify
   passou **verde**, e o ERP subiu com a tela em branco (relatório 25).

## 2. O que foi feito

`scripts/verify.js` — tudo em **um processo**, com `vm.Script` (o mesmo parser do
Node, sem o custo de iniciá-lo 521 vezes).

| Passo | Cobre | Antes |
|---|--:|---|
| 1. `.js` da raiz e de `scripts/` | **522** | 521, em 38,8 s |
| 2. `.js` de `public/` | **23** | **nenhum** |
| 3. `<script>` inline das telas do ERP | **425 blocos** | **nenhum** |
| 4. `test-shell-boot` | o shell **monta** | não rodava |
| 5. `test-tema-global` | tokens e contraste WCAG | não rodava |

```
OK: sintaxe válida — raiz, scripts/, public/, telas e shell (1.2s)
```

**De 38,8 s para 1,2 s**, cobrindo 970 unidades em vez de 522.

`package.json`: `verify` aponta para o script novo; o antigo ficou como
`verify:legado`, para comparação, sem custo.

### Duas correções que o próprio verify exigiu

Ao rodar pela primeira vez, ele reprovou **97 arquivos que são válidos**. Os dois
falsos positivos ensinaram como cada arquivo deve ser parseado:

1. **`Illegal return statement`** em `scripts/rollout-fase1-tenants.js`. O Node
   envolve todo módulo CommonJS numa função antes de compilar — é por isso que
   `if (require.main !== module) return;` funciona lá. Parseado como script
   solto, vira erro. **Correção:** módulos da raiz e de `scripts/` são parseados
   com o wrapper; `public/js/*` e o inline, como script puro — que é como o
   navegador os carrega. Um `return` no topo de um script de navegador *é* erro,
   e envolvê-lo esconderia o defeito.
2. **`Invalid or unexpected token`** em 96 scripts que começam com
   `#!/usr/bin/env node`. O Node remove o shebang antes de compilar.
   **Correção:** removê-lo também.

## 3. Prova de que reprova

Feita em **cópias** em `/tmp`, nunca nos arquivos reais:

| Erro artificial | Resultado |
|---|---|
| crase dentro de comentário em `sidebar.js` (a regressão real) | **REPROVOU** — 7 falhas |
| parêntese sobrando em `theme-boot.js` | **REPROVOU** — 7 falhas |
| `<script>` quebrado numa tela | **REPROVOU** — 2 falhas |
| cópias restauradas | volta a passar |

`public/js/sidebar.js` real conferido intacto ao final.

---

# PARTE B — fundação visual

## 4. A decisão que define esta fase

**A fundação foi criada. Os componentes ainda NÃO a consomem — e isso é
deliberado.**

Eu havia ligado `.btn`, `.btn-sm`, `.badge`, `.label`, `input`, `h1` e `.kpi` à
escala nova. Antes de dar por feito, medi o delta de cada um:

| Componente | Antes | Token | Delta |
|---|---|---|--:|
| `.btn` | `0.88em` → 12,3px | `--text-base` 14px | **+13,6%** |
| `.btn-sm` | `0.8em` → 11,2px | `--text-sm` 13px | **+16,1%** |
| `.badge` | `0.72em` → 10,1px | `--text-xs` 11px | **+9,1%** |
| `.muted`, `.label`, `input`, `h1`, `.kpi` | *sem `font-size`* | — | **ganhariam um** |

São **1.847 botões e 361 badges em 213 telas**. Aumentar 14% pode estourar
toolbar apertada — e **eu não tenho como ver se estoura**: o ambiente não abre o
ERP renderizado (§17).

Então **revertі o consumo**. Sobrou o que não altera pixel nenhum:

```css
body { font-size: var(--text-base); line-height: var(--lh-base); }
```

`body` era `font-size: 14px; line-height: 1.5` — e `--text-base` é `0.875rem`,
exatamente 14px. Verificado, não presumido.

**Fundação que muda a aparência sem verificação deixa de ser fundação e vira
reforma às cegas.** O consumo entra nas fases 3.2 e 3.3, uma família por vez, com
validação visual sua entre elas.

## 5. Escala tipográfica

Sete degraus, todos em `rem` — que respeita o zoom de texto do navegador, coisa
que `px` ignora e que é acessibilidade real para quem passa o dia no ERP.

| Token | rem | px | Uso |
|---|--:|--:|---|
| `--text-xs` | 0.6875 | 11 | label em caixa-alta, badge, legenda |
| `--text-sm` | 0.8125 | 13 | apoio, ajuda, metadado |
| **`--text-base`** | **0.875** | **14** | **corpo: texto, tabela, input, botão** |
| `--text-md` | 1 | 16 | texto enfatizado, título de card |
| `--text-lg` | 1.125 | 18 | título de seção |
| `--text-xl` | 1.375 | 22 | título de página |
| `--text-2xl` | 1.75 | 28 | KPI, número grande |

Mais `--lh-densa` (1.3), `--lh-base` (1.5), `--lh-solta` (1.65) e os pesos
`--peso-normal/medio/forte/dado` (400/500/600/700).

**A fonte não muda.** Inter continua — números tabulares, boa legibilidade em
13–14px, altura de x generosa. É a escolha certa para ERP denso; trocá-la por
estética seria risco sem ganho.

## 6. Espaçamento

Escala de 4px, `--space-1` a `--space-7` (4, 8, 12, 16, 24, 32, 48). Todo valor
múltiplo de 4 faz espaçamentos diferentes encaixarem em vez de brigarem por 1–2px.

Nomes numéricos de propósito: `--space-3` não promete uso específico;
`--space-card` prometeria, e a primeira exceção quebraria o nome.

## 7. Raios

`--raio-sm/md/lg` apelidam os `--r-sm/md/lg` existentes (6/8/12px), que seguem
como fonte da verdade. `--raio-pill: 999px` é o que faltava.

## 8. Bordas e sombras

**Bordas** — uma espessura só: `--borda`, `--borda-forte`, `--borda-acento`.
Borda de 2px vira "caixa", e o ERP já tem caixas demais.

**Sombras** — deliberadamente discretas:

| Token | Escuro | Claro |
|---|---|---|
| `--sombra-sm` | `none` | `0 1px 2px rgba(15,23,42,.06)` |
| `--sombra-md` | `none` | `0 2px 6px + 0 1px 2px` |
| `--sombra-modal` | `0 16px 48px rgba(0,0,0,.55)` | `0 16px 40px rgba(15,23,42,.18)` |

No escuro a elevação vem do **contraste entre superfícies**, não de sombra:
sombra preta sobre fundo escuro não aparece, só suja.

## 9. Superfícies

Nomes por **papel**, não por número — apontando para os tokens existentes, sem
mudar cor nenhuma:

```
--superficie-app       fundo geral        → --bg-0
--superficie           card, painel       → --bg-1
--superficie-alta      modal, dropdown    → --bg-2
--superficie-apoio     cabeçalho, chip    → --bg-3
--superficie-hover / --superficie-campo / --superficie-selecao
```

`--bg-2` não diz onde usar; `--superficie-alta` diz.

## 10. Cores semânticas

Apelidos do que já existe: `--primary`, `--primary-forte`, `--primary-suave`,
`--info`, `--info-suave`, `--muted`, `--muted-fraco`.

`--primary` e `--info` faltavam **como nome**, embora a cor exista — o azul
acumula os dois papéis, e nomeá-los deixa explícito que é decisão, não descuido.
**Azul principal e verde secundário seguem intocados**, como pedido.

## 11. Foco e acessibilidade — o ganho real desta fase

**Achado:** o CSS global tinha `input:focus { outline: none }` e **zero
`:focus-visible`**. `.btn` não tinha estado de foco nenhum. Quem navega por
teclado só via a borda do input mudar de cor, e nada em botões, links, abas,
selects e itens de menu.

Agora há anel de foco em todos eles:

```css
a, button, .btn, input, select, textarea, [tabindex], .tab, .menu-item {
  :focus-visible → outline: var(--foco); outline-offset: var(--foco-offset);
}
```

`:focus-visible` (e não `:focus`) faz o anel aparecer para **teclado** e não para
clique de mouse — atende a razão pela qual o `outline: none` foi escrito, sem
tirar a acessibilidade de ninguém.

Também entrou `font-variant-numeric: tabular-nums` em tabelas e KPIs: o que faz
coluna de valor "dançar" é o dígito 1 ser mais estreito que o 8. **Não muda
tamanho — só alinha as casas.**

## 12. `!important` — mapeado, nenhum removido

Mapa dos 210 (em 113 regras):

| Onde | Quantos |
|---|--:|
| `--- Filtro bar (inputs date/select) ---` | **69** |
| `--- Botões legacy padronizados ---` | 31 |
| `Ícones SVG premium` | 26 |
| `--- Página Interesses ---` | 13 |
| `--- Filtros tipo "pills" ---` / `--- Filtros internos ---` | 12 + 12 |
| demais blocos *legacy* | 47 |

Por propriedade: **80 `color`, 52 `background`, 26 `border`** — **158 de 210
(75%) são cor**.

**Removi zero, e a razão é mensurável.** Procurei candidatos comprovadamente
seguros:

| Critério | Encontrados |
|---|--:|
| seletor com `#id` (especificidade alta, dispensa `!important`) | **0** |
| propriedade duplicada no mesmo bloco (redundância pura) | **0** |
| dentro de `@media print` (não compete com inline) | **0** |

Todos existem para **vencer o estilo inline e o CSS local das telas**. Provar que
um deles é dispensável exigiria renderizar cada tela afetada — que é exatamente o
que não consigo fazer. Remover às cegas trocaria dívida documentada por defeito
silencioso.

**Dívida registrada:** 210 `!important`, concentrados em blocos *legacy*, cuja
remoção depende de reduzir o estilo inline (fase futura).

**A Fase 3.1 não acrescentou nenhum.** O bloco novo fica no **fim do arquivo** e
vence por ordem de cascata. (O `grep` acusa 211 porque a palavra aparece num
comentário meu explicando justamente isso.)

## 13. Estilo inline — medido, não tocado

5.764 declarações. Os padrões mais repetidos nas telas do ERP:

| Vezes | Padrão | Já existe utilitário? |
|--:|---|---|
| **731** | `text-align:right` | **sim — `.text-right`** |
| 236 | `display:none` | **sim — `.hidden`** |
| 168 | `margin:0` | não |
| 97 | `color:var(--danger)` | **sim — `.text-danger`** |
| 90 | `display:block` | não |
| 86 | `color:var(--text-3)` | **sim — `.muted`** |
| 70 / 60 | `flex:2` / `flex:1` | parcial — `.spacer` |

**Descoberta útil: os utilitários já existem.** `.text-right`, `.hidden`,
`.text-danger`, `.muted` e `.spacer` estão na seção UTILS há tempos — **o
problema é adoção, não falta**. Por isso **não criei utilitário novo**: seria
somar código a um problema que já tem solução escrita.

A migração dos 731 `text-align:right` para `.text-right` é mecânica e segura,
mas toca centenas de HTMLs — fora do escopo desta fase por instrução explícita.

## 14. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `scripts/verify.js` | **novo** — o verify |
| `package.json` | `verify` → script novo; antigo vira `verify:legado` |
| `public/css/app-modern.css` | fundação no `:root`, sombras no tema claro, bloco de foco no fim |
| `scripts/test-tema-global.js` | premissa de token corrigida + 4 testes novos |

**Nenhum HTML alterado.** (O `find` acusa 2 por mtime, ambos da Fase 2.2,
concluída minutos antes — nenhum foi tocado aqui.) O limite de 10 do escopo não
chegou a ser exercido.

## 15. Testes

`test-tema-global` foi de 18 para **21**, com quatro verificações novas:

- **A1b** — os apelidos da fundação apontam para tokens **que existem**
  (`var(--nao-existe)` renderiza transparente e passaria despercebido);
- **A4** — a escala tipográfica está em `rem`, é **crescente**, e `--text-base`
  é 0.875rem;
- **A5** — espaçamento, raio, borda, foco, superfícies e semânticas declarados; e
  todo `--space-*` é **múltiplo de 4px**;
- **A6** — **a fundação não mudou o tamanho de `.btn`, `.badge`, `.label` nem
  `.kpi`**. Se alguém aplicar sem medir o delta, este teste avisa.

Também corrigi a **premissa** do teste A1. Ela era "todo token declarado no
escuro tem par no claro", e valia enquanto todo token era cor. Agora há tokens
que não são (espaçamento, tipografia) e **apelidos** cujo valor é
`var(--outro)` — esses resolvem sozinhos e redefini-los duplicaria a informação
que os apelidos vieram evitar. A regra passou a olhar o **valor**: token de cor é
o que tem `#hex`/`rgb()`.

**Regressão — zero falhas novas:**

| Suíte | Resultado |
|---|---|
| `npm run verify` (novo) | **OK, 1,2 s** |
| `test-tema-global` | **21 ok** |
| `test-shell-boot` | 24 ok |
| `test-pdv-visual` | 32 ok |
| `test-pdv-fluxo` | 29 ok |
| `test-pdv-rbac` | 11 ok |
| `test-fase1-funcional` | 57 ok |
| `test-governanca-percentual` | 29 ok |
| `test-app-backend` | 79 ok |
| `test-alcadas` | 41 ok |

Servido e conferido pelo processo em execução: `--space-4`, `--text-base`,
`--raio-pill`, `--foco`, `--superficie-alta`, 13 `focus-visible` e 3
`tabular-nums` presentes no CSS que o ERP entrega.

## 16. Compatibilidade

Preservados e verificados por teste: tema claro, tema escuro, **tema `custom:`
legado** (sobrescreve os 23 tokens de cor e não conhece os novos — segue
funcionando sem adaptação), `theme-boot`, botão de tema, sidebar, menu, RBAC,
Pedidos PDV, e todas as telas comerciais, de estoque, financeiro e licitações.

## 17. Limitações

1. **Não vi nenhuma tela renderizada.** O ambiente não abre o ERP — a extensão do
   Chrome recusa `localhost` e o domínio do tenant não resolve. Como instruído:
   **não afirmo que ficou bonito nem aprovado.** O que afirmo é o que foi medido.
2. **A fundação ainda não é visível.** Criar tokens sem consumo não muda
   aparência — por decisão (§4). O único efeito visível desta fase é o **anel de
   foco ao navegar por teclado**, que vale a pena testar com Tab.
3. **Os 210 `!important` continuam lá**, e nenhum candidato seguro foi
   encontrado. Dívida documentada.
4. **Os 5.764 estilos inline continuam**, mapeados mas não tocados.
5. **87 declarações de `font-size` literais** seguem no CSS global (contra 9 com
   token). A migração é das fases 3.2/3.3, com medição de delta caso a caso.

## 18. Recomendação: **GO para a Fase 3.2**

A fundação está posta, provada por teste e **sem custo visual** — se a 3.2 não
agradar, basta não consumir os tokens; nada precisa ser desfeito.

E a condição que o relatório 26 colocou como bloqueio **foi resolvida**: o verify
agora cobre `public/`, o inline das telas e o boot do shell, em 1,2 s. A porta
por onde a tela branca passou está fechada.

**A Fase 3.2 (botões, inputs, badges) começa com uma tarefa herdada desta:** os
deltas medidos em §4. `.btn` +13,6%, `.btn-sm` +16,1%, `.badge` +9,1%. Cada um
precisa da sua validação visual antes de entrar — e é por isso que a 3.2 deve ser
a primeira fase com **você olhando a tela** entre o antes e o depois.

**Sugestão concreta para a 3.2:** aplicar em **um componente só** (`.btn`),
publicar, você olhar, e só então seguir para inputs e badges. Três idas e voltas
curtas custam menos que uma reforma que precise ser desfeita.
