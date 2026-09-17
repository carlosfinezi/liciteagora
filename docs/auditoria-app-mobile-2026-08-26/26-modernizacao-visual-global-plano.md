# 26 — Modernização visual global / Identidade 2.0 — auditoria e plano

**Data:** 2026-09-11, 15:29–15:45 BRT
**Natureza:** **auditoria e plano. Nada foi implementado.**

> Nota de numeração: já existe um `26-fase2.2-refinamento-visual-pdv.md`. Mantive
> o nome pedido; são dois documentos com o mesmo prefixo, de assuntos diferentes.

**Serviços — início e fim, sem alteração:**

| Unidade | Início | Fim |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, 12:14:16, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, 06:18:49, NRestarts 0 | **idêntico** |

Nenhum restart externo. Nada alterado: banco, tenant, API, regra, RBAC, nginx,
Hestia, logo, HTML. O único arquivo criado é
`scripts/diagnostico-visual.js` — **read-only**, só lê `public/` e conta.

---

## 1. Estado atual, em números

| Medida | Valor |
|---|--:|
| Telas `.html` em `public/` | **240** |
| Telas do ERP autenticado (carregam `sidebar.js`) | **213** (89%) |
| Carregam `app-modern.css` | 215 (90%) |
| Carregam `sidebar.css` | 215 (90%) |
| Carregam `theme-boot.js` | 213 (89%) |
| Usam `.page-header` | 213 (89%) |
| **Fora do ERP** (sem sidebar) | **27** |

As 27 de fora são: `landing/` (7), `auth/` (4), `portal/`… — login, landing,
portal do cliente, loja pública, cardápio, monitor Electron. **Não participam do
tema nem da sidebar**, e ficam fora do escopo desta modernização.

### A boa notícia

**89% das telas herdam a mesma camada global.** A modernização não precisa tocar
200 páginas: cinco arquivos alcançam quase tudo.

| Arquivo global | Linhas |
|---|--:|
| `public/css/app-modern.css` | 2.002 |
| `public/js/sidebar.js` | 1.386 |
| `public/css/sidebar.css` | 575 |
| `public/js/menu-config.js` | 547 |
| `public/js/grid.js` | 310 |
| `public/js/icons.js` | 90 |
| `public/js/theme-boot.js` | 77 |
| `public/app.html` | 40 |

## 2. Arquitetura visual atual

```
app.html (shell)          sidebar fixa 250px + <iframe> com a tela
  └ theme-boot.js         escreve data-theme no <html>, antes do CSS
  └ sidebar.css           --sidebar-w, sidebar, modo compacto
  └ app-modern.css        tokens + componentes
  └ sidebar.js            monta o menu, RBAC de exibição, tema, botão
```

**O CSS global já é orientado a componentes** — não é uma folha solta. Tem
seções declaradas para BOTÕES, INPUTS, CARDS E PAINÉIS, TABELAS, BADGES, KPIs,
FILTROS, MODAIS, AUTOCOMPLETE, DROPDOWN, TOASTS, LAYOUT, ABAS e UTILS.

Isso muda a natureza do trabalho: **não é criar um design system, é refinar um
que existe.**

### Tokens

27 declarados, e **71% de todo uso de cor no ERP já passa por eles**
(2.088 `var(--…)` contra 837 cores literais). É uma base sólida — a troca de
identidade pode acontecer majoritariamente pelos tokens.

## 3. Problemas encontrados

### 3.1 Sem escala tipográfica — **28 tamanhos de fonte distintos**

```
0.7em 0.72em 0.75em 0.78em 0.8em 0.82em 0.85em 0.85rem 0.86em 0.88em
0.9em 0.92em 0.92rem 0.95em 1em 1rem 1.15rem 1.2rem 1.3em 1.35rem
1.4em 1.5em 1.8em 11px 12px 13px 14px 18px
```

Três unidades misturadas (`px`, `em`, `rem`) e nenhuma escala. É a causa direta
da sensação de "ERP administrativo": títulos que não têm o mesmo peso entre
telas, rótulos de tamanhos diferentes para a mesma função.

**Não há token de tipografia** — só de cor e raio.

### 3.2 **210 `!important`** em `app-modern.css`

Contra 8 em `sidebar.css`. Sinal de brigas de especificidade acumuladas, e o
maior risco técnico da modernização: mexer numa regra pode não surtir efeito, ou
surtir em lugar inesperado.

O próprio arquivo registra as camadas: seções marcadas **"legacy"** (containers
brancos legacy, modal legacy, botões legacy padronizados) convivendo com
**"ONDA 4"** e **"ONDA 4.2"** de refatorações anteriores.

### 3.3 **39 combinações distintas de classe de botão**

```
522×  btn btn-ghost btn-sm        307×  btn btn-primary
247×  btn btn-primary btn-sm      201×  btn btn-secondary btn-sm
181×  btn btn-ghost               161×  btn btn-secondary
 81×  btn btn-sm (sem variante)    32×  btn btn-danger btn-sm
 25×  btn btn-ghost btn-icon-only  24×  btn (sozinho)
 21×  btn btn-danger               14×  btn btn-success
  6×  btn-link-comprasnet   ← fora do sistema
```

A hierarquia **existe** (primary/secondary/ghost/danger/success/icon-only). O
problema é o uso: 81 botões sem variante nenhuma e 24 só com `.btn` — esses não
comunicam importância. E `btn-ghost btn-sm` sendo a combinação mais usada (522×)
sugere que a ação secundária virou padrão por inércia, não por decisão.

### 3.4 CSS local: 114 telas, 5.051 linhas, 284 KB

Quase metade das telas tem `<style>` próprio. Dez passam de 100 linhas:

| Linhas | Tela |
|--:|---|
| 588 | `licitacoes/consulta.html` |
| 297 | `comercial/pedidos-pdv.html` |
| 288 | `auth/admin/index.html` |
| 242 | `comercial/proposta-template.html` |
| 229 | `operacional/comprasnet-monitor.html` |
| 175 | `operacional/lances.html` |
| 150 | `operacional/propostas-api.html` |
| 146 | `comercial/pessoas.html` |

**São estas que resistem à camada global.** Nem todo CSS local é problema — o do
PDV é layout de tela única, legítimo. O de `consulta.html` (588 linhas) merece
investigação própria.

### 3.5 **5.764 atributos `style=` inline**, em 96% das telas

Média de 24 por tela. É o que mais limita mudança global: estilo inline vence
qualquer folha, inclusive `!important` de arquivo.

| style= | Tela |
|--:|---|
| 172 | `comunicacao/conversas.html` |
| 151 | `os/ordem-servico.html` |
| 144 | `comercial/pessoas.html` |
| 141 | `operacional/inteligencia.html` |
| 131 | `comercial/pedido.html` |

### 3.6 Cor fixa: 837 ocorrências

508 em `<style>` local, 329 inline. Concentradas:

| Cores | Tela |
|--:|---|
| 122 | `operacional/lances.html` |
| 113 | `auth/admin/index.html` (fora do ERP) |
| 46 | `auth/orcamento.html` (fora do ERP) |
| 35 | `operacional/inteligencia.html` |
| 31 | `portal/index.html` (fora do ERP) |

**Boa parte está fora do ERP** — landing, portal e admin não participam do tema.
Dentro do ERP, o foco real é `operacional/lances.html` e
`operacional/inteligencia.html`.

### 3.7 O botão de tema é flutuante, não pertence a lugar nenhum

`position: fixed` no canto, com espaço reservado no `.page-header` por
`padding-right`. Funciona (e foi corrigido duas vezes), mas é sintoma:
**não existe topbar**. Cada tela monta o próprio cabeçalho.

## 4. O que já pode ser reaproveitado

- **os 27 tokens de cor** e o mecanismo de tema — 71% do uso já passa por eles;
- **o `theme-boot.js`** e a prevenção de flash;
- **as seções de componente** do `app-modern.css` — botões, inputs, cards,
  tabelas, badges, KPIs, filtros, modais, dropdown, toasts, abas;
- **`--sidebar-w`** e o modo compacto, feitos na Fase 2.2;
- **o `grid.js`** (70 telas, 29%) — grid configurável com larguras ajustáveis;
- **o `icons.js`** e o padrão Lucide já adotado;
- **`.page-header`** em 213 telas — o gancho pronto para a linguagem de cabeçalho;
- **`__shellPageChanged`** — canal iframe↔shell, que a topbar vai precisar.

As classes mais usadas mostram o vocabulário que já existe e funciona:
`.btn` (1847×), `.form-group` (1567×), `.muted` (1218×), `.empty` (430×),
`.num` (389×), `.badge` (361×), `.kpi` (289×), `.tbl-wrap` (245×),
`.panel` (231×).

## 5. Riscos

| Risco | Gravidade | Mitigação |
|---|---|---|
| **210 `!important`** — mudança sem efeito ou com efeito lateral | **alta** | mexer por token antes de por regra; mudar um componente por vez com teste de contraste |
| **5.764 `style=` inline** vencem qualquer folha | **alta** | não tentar eliminá-los; aceitar que algumas telas ficarão fora do refino até serem tocadas por outro motivo |
| CSS local em 114 telas | média | não tocar em massa; só nas 10 maiores, e uma por vez |
| `verify` não cobre `public/` | **alta** | já mitigado: `test-shell-boot.js` parseia todo `.js` de `public/` — **rodar sempre** |
| Quebrar o shell (já aconteceu) | **alta** | `test-shell-boot.js` monta o shell em DOM simulado nos 12 estados de tema |
| Regressão de contraste | média | `test-tema-global.js` calcula WCAG nos dois temas |
| **`fiscal` (26 telas) e `financeiro` (21)** são as maiores áreas | média | deixar por último; são as de maior custo se quebrarem |
| Módulos verticais (restaurante, ótica, farmácia, posto, locação, produção) | baixa | 43 telas somadas, pouco acessadas — refino por herança, sem visita individual |

**Áreas por volume:** fiscal 26 · financeiro 21 · operacional 19 · comercial 13 ·
estoque 12 · configurações 12 · restaurante 11 · produção 10 · portal 10.

## 6. Proposta de topbar

Hoje não existe. A proposta é uma faixa de ~52px no topo, **no shell**
(`app.html`), acima do iframe — não dentro de cada tela.

```
┌──────────────────────────────────────────────────────────────────┐
│ [≡] Licite Agora          Lab Fiscal        [?] [🔔] [☀️] [👤 ▾] │
├────────────┬─────────────────────────────────────────────────────┤
│  SIDEBAR   │  CONTEÚDO (iframe)                                  │
```

| Item | Existe infraestrutura? | Proposta |
|---|---|---|
| Recolher sidebar `[≡]` | **sim** (Fase 2.2) | move o botão da sidebar para cá |
| Marca | **sim** (`logo-sistema.png`) | substitui a logo do topo da sidebar |
| Nome do tenant | **sim** — o tenant é resolvido por Host | mostrar; é útil para quem opera mais de uma empresa |
| Tema `☀️/🌙` | **sim** | **deixa de ser flutuante** e entra na faixa |
| Usuário/conta `[👤]` | **sim** — `Alterar Senha` e `Sair` já existem no menu Conta | move para cá, que é onde se procura |
| Notificações `[🔔]` | **parcialmente** | há contadores de interesses e aprovações no menu; **não há central de notificações**. Proposta: mostrar só o contador de aprovações, que já existe, ou não mostrar |
| Ajuda `[?]` | **NÃO** | **não incluir** — não há destino real |

**Ganho colateral importante:** com a topbar, o `padding-right: 54px` que hoje
existe em `.page-header` nas 213 telas deixa de ser necessário, e o canto
superior direito volta a ser das telas.

**Risco:** o shell tem iframe posicionado por `top: 0`. A topbar exige recalcular
`top` e `height` do `#conteudo` — mesma natureza da mudança de `--sidebar-w` que
já foi feita com sucesso. Nas 27 telas fora do shell, a topbar não aparece (elas
não têm sidebar tampouco).

## 7. Proposta de sidebar

Direção: **menos caixa, mais continuidade.**

| Hoje | Proposta |
|---|---|
| `border-left: 2px` no item ativo | faixa de acento + fundo suave, sem borda |
| `.sidebar-header` com fundo próprio (`--bg-2`) e borda | some — a marca vai para a topbar |
| Busca de rotina com borda inferior | mantém, com respiro maior |
| Seções em caixa-alta 0.68em | mantém o conceito, com token tipográfico |
| Itens com `padding: 5px 16px 5px 34px` | respiro maior e consistente |
| Ícones de item **ocultos** (`display:none`) | **mostrar sempre** — é o que dá consistência e o que o modo compacto já exige |
| Modo compacto (64px) | mantém, com **tooltip** no hover (hoje é `title` nativo) |
| Mobile: gaveta | mantém — não é a sidebar desktop encolhida |

**RBAC intocado.** O filtro de itens continua em `desenharMenuComAcesso`; nada
da proposta toca em permissão.

## 8. Linguagem visual proposta

### 8.1 Escala tipográfica (o que falta hoje)

Tokens novos, substituindo os 28 tamanhos soltos:

```
--fs-display  1.5rem    título de página
--fs-titulo   1.125rem  título de seção / card
--fs-corpo    0.875rem  texto e tabela  (14px — o atual)
--fs-apoio    0.8125rem legenda, ajuda
--fs-micro    0.6875rem label, badge, caixa-alta
--fs-dado     1.75rem   KPI
```

**A fonte não muda.** Inter já é a escolha certa para ERP denso: números
tabulares, boa legibilidade em 13–14px, altura de x generosa. Trocar por estética
seria risco sem ganho. O que falta é **usar `font-variant-numeric: tabular-nums`
nas tabelas e KPIs** — hoje é pontual, e é o que faz coluna de valor "dançar".

### 8.2 Cabeçalho de página (linguagem, não template)

```
Pedidos                                    [Exportar]  [+ Novo pedido]
Gestão de pedidos de venda e orçamentos
```

Título, descrição opcional, ações à direita com **uma** primária. Já existe
`.page-header` em 213 telas — é refino, não invenção.

### 8.3 Botões

A hierarquia já existe; o trabalho é **reduzir de 39 combinações para 6** e
tornar a primária inequívoca. Os 81 `btn btn-sm` sem variante e os 24 `.btn`
sozinhos precisam de destino definido.

### 8.4 Cards e tabelas

- card: borda discreta, raio consistente, **sem sombra no escuro** (a elevação
  vem do contraste de superfície) e sombra mínima no claro — já implementado com
  `--sombra-card`;
- tabela: **preservar densidade**. A proposta é cabeçalho com peso e fundo
  próprios, linhas com hover discreto, zebra opcional, e números tabulares.
  Nada de transformar tabela em card — 189 telas (79%) têm `<table>`, e é o
  formato certo para trabalho administrativo.

## 9. Temas claro e escuro

**Preservar tudo o que foi feito.** O que a modernização acrescenta:

- refinar `--bg-2` e `--bg-3`, hoje pouco diferenciados no escuro
  (`#111827` e `#1e293b`) — é o que dá a sensação de "várias caixas";
- revisar contraste dos estados sobre superfície elevada;
- manter a verificação WCAG automática que já existe em `test-tema-global.js`;
- **não criar CSS por página** — a regra continua sendo token.

O tema `custom:` legado dos 5 usuários continua funcionando: ele sobrescreve os
mesmos 23 tokens e não conhece os novos de tipografia.

## 10. Inventário da logo

**Nada foi alterado, como instruído.** O que existe hoje:

| Arquivo | Formato | Uso |
|---|---|---|
| `public/img/logo-sistema.png` | **400×100 px**, 45,6 KB | topo da sidebar (`sidebar.js:867`) — **única referência** |
| `public/auth/favicon.svg` | 64×64, 569 B | injetado por `sidebar.js` em toda tela do ERP |
| `public/auth/favicon.ico` | 22,4 KB | pedido automaticamente pelo navegador |
| `public/auth/apple-touch-icon.png` | **180×180 px**, 11 KB | injetado por `sidebar.js` |

Os três ícones são servidos na raiz (`/favicon.svg` → HTTP 200) apesar de
morarem em `public/auth/`.

**A marca atual, no favicon:** monograma **"LA"** em branco, peso 800, sobre
gradiente azul `#3b82f6 → #60a5fa`, em quadrado de raio 12 com fundo `#0b1120`.

### Observações para a identidade 2.0

1. **O PNG é a única forma horizontal, e é raster.** 400×100 em telas 2× fica
   suave demais; e 45,6 KB para uma logo é muito. **Versão vetorial (SVG) é a
   primeira necessidade.**
2. **Não há versão para tema claro.** A logo é a mesma nos dois — precisa ser
   verificada (o relatório 24 já registrou isso como pendência).
3. **O azul do favicon (`#3b82f6`) não é mais o azul do tema claro** (`#1d4ed8`,
   ajustado por contraste na Fase 3 do tema). A identidade precisa definir um
   azul que funcione nos dois.
4. **Não há verde**, embora você o cite como cor secundária. Hoje o `--success`
   (`#34d399` escuro / `#047857` claro) é o único verde, e é semântico, não de
   marca.

### Versões que o sistema vai precisar

| Versão | Tamanho | Onde |
|---|---|---|
| Horizontal SVG | vetorial | topbar, login, landing |
| Horizontal PNG @2x | ~800×200 | fallback, e-mail, PDF |
| Símbolo/monograma SVG | 1:1 | sidebar compacta (64px), favicon |
| Favicon SVG | 64×64 | navegador |
| Favicon ICO | 16/32/48 | navegadores antigos |
| Apple touch icon | 180×180 | iOS, PWA |
| PWA icons | 192, 512 | `manifest.json` (ainda não existe) |
| Monocromática | vetorial | documentos fiscais, impressão |
| Claro / escuro | 2 variantes | topbar nos dois temas |

## 11. Impacto esperado

| Mudança | Arquivos | Telas alcançadas |
|---|--:|--:|
| Escala tipográfica em tokens | 1 (`app-modern.css`) | **213** |
| Refino de superfícies e bordas | 1 | **213** |
| Botões, inputs, cards, tabelas | 1 | **213** |
| Topbar global | 2 (`app.html`, `sidebar.js`) + 1 CSS | **213** |
| Sidebar moderna | 2 (`sidebar.css`, `sidebar.js`) | **213** |
| Cabeçalho de página | 1 (`.page-header`) | **213** |

**Cinco arquivos alcançam 89% do ERP.** É o argumento central deste relatório: a
modernização é viável sem tocar em 200 páginas.

O que **não** será alcançado por herança: as 5.764 declarações inline e as 5.051
linhas de CSS local. Elas não impedem a modernização — apenas ficam desalinhadas
até que cada tela seja tocada por outro motivo. É custo aceitável e previsível.

## 12. Plano de implementação

Ajustei a ordem que você propôs em dois pontos, e explico por quê.

| Fase | O quê | Arquivos | Por quê nesta ordem |
|---|---|---|---|
| **3.1** | **Tokens de tipografia e superfície** + verificação de contraste | `app-modern.css` | é a base de todo o resto, e é reversível: tokens novos sem consumidor não mudam nada |
| **3.2** | **Botões, inputs, badges** | `app-modern.css` | são 1.847 `.btn` e 1.567 `.form-group`; o maior ganho por linha alterada |
| **3.3** | **Cards, painéis, tabelas, estados vazios** | `app-modern.css` | 189 telas têm tabela; aqui mora a sensação de "várias caixas" |
| **3.4** | **Sidebar moderna** | `sidebar.css`, `sidebar.js` | depende dos tokens da 3.1 |
| **3.5** | **Topbar global** | `app.html`, `sidebar.js`, `sidebar.css` | **depois** da sidebar: as duas dividem a marca e o botão de recolher |
| **3.6** | **Cabeçalho de página** (`.page-header`) | `app-modern.css` | depois da topbar, que libera o canto direito |
| **3.7** | **Telas críticas** — as 10 com mais CSS local | 10 HTML | uma por vez, cada uma com sua conferência |
| **3.8** | **Identidade 2.0 / logo** | arquivos de imagem + `sidebar.js` | depois que a base visual estiver estável |
| **3.9** | **Pedidos PDV visual 2.0** | `pedidos-pdv.html` | precisa da base pronta para não ser refeito duas vezes |
| **3.10** | **Responsividade e revisão final** | global | fechamento |

**Duas mudanças em relação à sua proposta:**

1. **Topbar depois da sidebar** (você tinha 3.2 topbar, 3.3 sidebar). As duas
   disputam a marca e o botão de recolher; fazer a sidebar primeiro define onde
   cada coisa mora, e a topbar recebe o que sobrar. Na ordem inversa, a topbar
   seria refeita.
2. **Dashboard não tem fase própria.** Você propôs 3.5 dashboard/painel; ela cai
   dentro da 3.3 (cards e KPIs) — `.kpi` aparece 289 vezes e não é exclusivo do
   dashboard. Uma fase só para ele repetiria trabalho.

Cada fase: **um arquivo global por vez, testável e reversível por `git checkout`
do arquivo** (nenhuma está commitada, então o backup é o tar da Fase 2.2 mais o
diagnóstico deste relatório).

## 13. Estratégia de testes

A suíte existente já cobre o essencial e **deve rodar em toda fase**:

| Teste | O que protege |
|---|---|
| `test-shell-boot` (24) | **o shell monta** — parseia todo `.js` de `public/`, monta o menu em DOM simulado nos 12 estados de tema. É o que teria pego a tela branca |
| `test-tema-global` (17) | tokens pareados nos dois temas, **contraste WCAG**, reserva do botão de tema |
| `test-pdv-visual` (32) | nenhuma cor fixa, nenhum token inexistente, hierarquia de tamanhos |
| `test-pdv-fluxo` (29) · `test-pdv-rbac` (11) | o PDV continua funcionando e o RBAC fechado |
| `npm run verify` | sintaxe da raiz e de `scripts/` — **não cobre `public/`** |

**Acrescentar por fase:**

- **3.1** — todo tamanho de fonte do CSS global vem de token (contagem de
  `font-size` literal deve cair de 28 para ~0);
- **3.2** — as 6 variantes de botão existem e têm contraste AA nos dois temas;
- **3.3** — cabeçalho de tabela legível nos dois temas; card sem sombra no escuro;
- **3.4/3.5** — o shell monta com topbar e sidebar em todas as combinações
  (expandida/compacta × claro/escuro × shell/standalone);
- **3.7** — cada tela tocada: JS inline parseia, sem cor fixa nova.

E o que nenhum teste faz: **olhar**. Cada fase precisa de validação visual sua —
esta auditoria não conseguiu acessar o navegador (a extensão recusa `localhost` e
o domínio do tenant não resolve dela), e isso vale para as fases seguintes até
que o acesso seja liberado.

## 14. Recomendação: **GO**, com uma condição

A modernização é viável e de risco controlado:

- **89% das telas herdam a mesma camada** — cinco arquivos alcançam quase tudo;
- **71% do uso de cor já passa por tokens**;
- **a camada de componentes já existe** — é refino, não criação;
- a suíte de testes já protege o shell, o tema e o contraste.

**A condição:** o `npm run verify` **não cobre `public/`**, e foi exatamente por
isso que uma crase num comentário derrubou o ERP inteiro (relatório 25). Antes da
Fase 3.1, adote uma das duas:

1. estender o `verify` para `public/js/` (uma linha no `package.json`), ou
2. rodar `node scripts/test-shell-boot.js` como parte obrigatória do fechamento.

Sem isso, cada fase da modernização é uma nova chance de repetir a tela branca.

**Começar por 3.1** (tokens de tipografia e superfície): é a base de tudo, não
tem consumidor até ser usada, e por isso é a fase mais reversível de todas.

---

## Resumo em português simples

**O que eu descobri:**

O ERP tem 240 telas, e **213 delas (89%) usam os mesmos arquivos de estilo**. Isso
é a melhor notícia possível: dá para modernizar quase tudo mexendo em **cinco
arquivos**, sem abrir 200 páginas.

O sistema também **já tem** uma base de componentes (botões, cards, tabelas,
modais…) e **71% das cores já passam por tokens** — ou seja, boa parte do
trabalho de anos atrás já está feito.

**Os três problemas de verdade:**

1. **Não existe escala de tamanhos de texto.** São 28 tamanhos diferentes, em
   três unidades misturadas. É isso que faz o sistema parecer "ERP antigo" — cada
   tela tem um título de tamanho diferente.
2. **210 `!important` no CSS.** Herança de anos de correções. Torna mudança
   imprevisível, e é o maior risco técnico.
3. **5.764 estilos escritos direto no HTML.** Esses não obedecem a arquivo
   nenhum. Não dá para eliminá-los agora, e algumas telas vão ficar desalinhadas
   até serem tocadas por outro motivo. É custo previsível, não impedimento.

**Sobre a topbar:** hoje o botão de tema fica flutuando no canto porque **não
existe uma barra no topo**. Proponho criar uma de verdade, com marca, nome da
empresa, usuário e o botão de tema. Ajuda e notificações **ficam de fora** — não
há infraestrutura real para elas, e não vou inventar botão que não leva a lugar
nenhum.

**Sobre a logo:** só existe **um PNG de 400×100** e um favicon com o monograma
"LA". Não há versão vetorial, nem versão para tema claro, e o azul do favicon já
não é o mesmo azul do sistema. Listei as 9 versões que vão ser necessárias.
**Não mexi em nada.**

**Mudei duas coisas na sua ordem:** a topbar vem **depois** da sidebar (as duas
dividem a marca e o botão de recolher — na ordem inversa a topbar seria refeita),
e o dashboard não tem fase própria, porque cai dentro da fase de cards.

**Minha recomendação é GO**, começando pela fase mais segura (tokens). **Com uma
condição:** o `npm run verify` não verifica os arquivos de `public/`, e foi por
isso que o ERP ficou com a tela branca semana passada. Antes de começar, ou
estendemos o verify, ou passamos a rodar o `test-shell-boot` sempre.

**Nada foi alterado nesta etapa** — nem banco, nem código, nem logo, nem
serviços. O único arquivo novo é um script de diagnóstico que só lê e conta.

**Paro aqui para você revisar o plano antes da Fase 3.1.**
