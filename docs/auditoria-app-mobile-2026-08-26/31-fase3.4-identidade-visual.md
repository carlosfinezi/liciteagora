# 31 — Fase 3.4: nova identidade visual

**Data:** 2026-09-11, 18:20–19:35 BRT
**Base:** [30 — topbar global](30-fase3.3-topbar-identidade.md) (auditoria da marca) · prancha enviada em `/root/logo-licite-agora-nova.png`

**Resultado:** identidade recriada em SVG, aplicada na sidebar, no login e nos
favicons. **Nenhum restart** (tudo estático), nenhuma alteração de banco,
backend, RBAC, rota ou regra comercial.

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, 12:14:16, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, 06:18:49, NRestarts 0 | **idêntico** |

Sem restart externo durante a fase. `npm run verify` verde antes e depois.

---

## 1. Backup, antes de qualquer coisa

`docs/auditoria-app-mobile-2026-08-26/backup-marca-2026-09-11/`

| Arquivo | sha256 (12 primeiros) |
|---|---|
| `logo-sistema.png` | `1c60bb6fa2cf` |
| `favicon.svg` | `2fc76a8c7233` |
| `favicon.ico` | `f841c7ec21ca` |
| `apple-touch-icon.png` | `7f9a08101ed4` |
| `login.html` | `568e4ef56b37` |
| `prancha-identidade-nova.png` | `3f48f8aa2d3e` |

A prancha foi junto: ela é a referência do desenho, e sem ela o SVG vira um
arquivo sem procedência.

## 2. O ponto de partida — a prancha não era um asset

Recapitulando o que a auditoria mediu, porque é o que justifica tudo abaixo: o
arquivo enviado é uma **prancha de manual de marca**, 1536×1024, com ~15
variantes em cards. Três defeitos impediam o recorte:

1. **Fundo opaco** — os cards têm fundo pintado. Remover por cor deixava um
   **halo claro** contornando o símbolo, visível sobre fundo escuro.
2. **Raster com serrilhado e ruído**, visível na ampliação 4×.
3. **Paleta escrita ≠ paleta pintada**: o swatch dizia `#2563EB`, o pixel era
   `#0068F5`.

Sem vetorizador no servidor (`potrace`, `autotrace`, `inkscape` ausentes) e com
`npm install` negado, o caminho aprovado foi **redesenhar à mão em SVG**.

## 3. Como o desenho foi extraído

Não a olho. O símbolo foi reduzido a uma grade de 68×44 e cada célula
classificada por cor, produzindo um mapa que revelou a geometria:

```
 0 ...........AAAAAAAAAAAA...............AAAAAAAAAAAAAA...............
12 .......AAAAAAAAAAAA............AAAAAAAAAAAAA..AAAAAAAAAAAA.........
23 ...AAAAAAAAAAAAA.........AAAAAAAAAAAAA....VVVVVVVVVVV..AAAAAAA.....
30 .AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.......VVVVVVVVVVVV..AAAAAAAAAAA..
```

O que o mapa mostrou, e que não se vê olhando:

- a silhueta é **um traço só em ziguezague** (`\_/\`): desce, base, sobe ao
  ápice do A, desce — o "LA" ligado;
- as pontas são **cortadas na horizontal**, não arredondadas nem perpendiculares
  ao traço;
- a proporção real é **1,557** (204×131), não quadrada;
- a seta sobe a ~45° e **atravessa** a perna direita do A, com um vão fino.

Foram **quatro iterações** (v1→v4), cada uma renderizada e comparada com o
original lado a lado. A v1 errou a proporção e a espessura da seta; a v2 usou
`linecap="round"` e arredondou pontas que no original são retas; a v3 acertou a
estrutura mas cortou as pontas perpendicularmente; a v4 resolveu com `clipPath`.

## 4. Validação: Chrome de verdade, não ImageMagick

O renderizador interno do ImageMagick **descartou `mask` e `linearGradient`** —
mostrou o desenho sem o traço azul, só a seta. Um SVG validado por ele estaria
validado contra nada.

A validação passou a ser por **Chrome headless** (via o `puppeteer-core` que o
projeto já tem), que é o mesmo motor do navegador do usuário. Todas as imagens
de conferência desta fase saíram de lá.

## 5. As três decisões técnicas do desenho

| Escolha | Por quê |
|---|---|
| **`stroke` grosso, não contorno preenchido** | `stroke-linejoin="round"` dá os cantos arredondados do conceito sem recalcular curvas à mão se a espessura mudar |
| **`clipPath` para as pontas** | `linecap="butt"` sozinho corta perpendicular ao traço — num traço inclinado, fica torto. O retângulo de clip dá o corte reto de verdade |
| **`mask` para o vão da seta** | Pintar o vão com a cor do fundo funcionaria em **um** tema. A máscara recorta: o vão fica transparente e mostra o que estiver atrás, em qualquer fundo |

## 6. Um arquivo por versão, não dois por tema

A prancha previa versões separadas para tema claro e escuro. **Não foram
feitas.** "Licite" e "ERP" usam `fill="currentColor"` e herdam a cor do texto:
escuro no tema claro, claro no escuro. Quatro arquivos viraram dois, e não há
como um divergir do outro.

"Agora" e o verde são **fixos**: são cor de marca, não seguem a preferência do
usuário. O teste D3 reprova se virarem token de tema.

## 7. Cores

| Papel | Valor | Origem |
|---|---|---|
| Azul principal | `#2563EB` | sua decisão — **e já é o `--btn-primary-bg`** do design system (Fase 3.2) |
| Gradiente | `#3B82F6` → `#2563EB` → `#1D4ED8` | o principal no meio |
| Verde | `#22C55E` | escrito na prancha; o pintado era `#1EBF60`, diferença imperceptível |
| Verde do favicon | `#4ADE80` | mais claro: o `#22C55E` escurece contra o azul em 16px |

`--success` **não** foi usado: ele vale `#34d399` no escuro e `#047857` no
claro. Marca que muda de cor com o tema deixa de ser marca.

## 8. Sidebar — a dívida da Fase 3.3 está paga

O slot de identidade marcado no relatório 30 foi preenchido.

**Antes:** um `<img>` de 400×100 (4:1) servindo aos dois estados. Na barra
recolhida, espremido em 46px de largura, desenhava com **~11px de altura**.

**Agora:** dois SVG embutidos, alternados por CSS puro:

```css
.marca-monograma  { display: none; }
[data-sidebar="compacta"] .marca-horizontal { display: none; }
[data-sidebar="compacta"] .marca-monograma  { display: block; }
```

Medido no Chrome, com a barra recolhida: monograma **38×24px**, proporção 1,58
contra 1,556 do viewBox — **sem distorção**. Distorcer é impossível por
construção, não por ajuste: nenhuma regra fixa largura e altura ao mesmo tempo
(`height: auto`), e o teste C2 reprova se alguém fizer isso.

### Por que embutido e não `<img src=…>`

Três motivos, e os dois primeiros são impeditivos:

1. **`currentColor` não existe dentro de um `<img>`** — seriam precisos dois
   arquivos por variante, quatro ao todo, para dessincronizar depois;
2. **a fonte Inter é carregada pela página**, não pelo SVG. Num `<img>` o
   arquivo renderiza isolado e o texto cairia na fonte do sistema;
3. **zero requisições** — era uma (o PNG), com dois arquivos seriam duas, e a
   troca ao recolher piscaria na primeira vez.

Os arquivos em `public/img/` continuam sendo a fonte da verdade, para uso fora
do ERP. O teste H1 compara o traço principal nos quatro lugares e reprova se um
divergir.

## 9. Login

| | Antes | Depois |
|---|---|---|
| Marca | `<h1>Licite Agora</h1>` em texto | marca completa em SVG |
| Cores | 7 valores hardcoded (`#1a1a2e`, `#4dabf7`, `#888`…) | 14 tokens do design system |
| Fonte | pilha do sistema | Inter, a do manual |
| Favicon | nenhum declarado | SVG + apple-touch-icon |
| Foco | só `border-color` | `:focus-visible` com contorno |

**Os tokens são espelhados, não importados** — e isso foi verificado, não
suposto: `/css/app-modern.css` responde **302** para quem não tem sessão, e o
login roda antes da barreira de auth. A duplicação é o preço de a tela vir
antes do login; o teste G2 confronta os 10 valores com o original e reprova se
divergirem.

O tema fica **fixo escuro**: quem escolhe o tema é o usuário logado
(`users.tema`), e ali ainda não há usuário.

Nenhuma funcionalidade mudou — o `<script>` do formulário está intacto, e o
teste G4 confere seis pontos dele.

## 10. Favicons — e uma correção de rota

**`public/auth/` é servido na RAIZ da URL** (`base-middleware.js:41`), antes do
auth. Eu havia criado `public/favicon.svg`, que **nunca seria entregue**: o de
`auth/` vence. Corrigido — os três estão em `public/auth/`, e o teste A3 reprova
se aparecer um `public/favicon.svg` órfão.

Confirmado por HTTP, não por `ls`:

```
/favicon.svg           200  2284B  image/svg+xml
/favicon.ico           200 15086B  image/vnd.microsoft.icon
/apple-touch-icon.png  200  5264B  image/png
```

### O favicon é um desenho diferente, de propósito

Testado renderizando a 16px no Chrome, comparando duas variantes:

| Variante | 16px |
|---|---|
| navy com símbolo azul | borrão escuro, contraste insuficiente |
| **azul sólido com símbolo branco** | **o LA lê; a seta permanece** |

Daí: fundo `#2563EB` chapado (gradiente não é percebido em 16px e só suja o
antialiasing), traço e vão mais grossos, verde mais claro.

O ICO tem **três resoluções reais** — 16, 32 e 48 — e o teste F2 lê o cabeçalho
binário para confirmar. O app icon é 180×180 e **opaco**: o iOS ignora
transparência e preencheria o vazio com preto (teste F3 lê o byte do tipo de
cor no PNG).

## 11. O que este conjunto de testes vigia

Marca não avisa quando quebra. Os modos de falha aqui não aparecem numa tela
qualquer, e o mais provável deles é invisível no código:

**Colisão de IDs.** `mask`, `clipPath` e `linearGradient` resolvem por id no
**documento inteiro**, não dentro do `<svg>`. Dois SVG embutidos com
`id="az"` na mesma página fazem o segundo usar o gradiente do primeiro — e,
pior, a **máscara** do primeiro: o desenho sai recortado no lugar errado, sem
nenhum erro no console.

Por isso os prefixos são distintos por contexto: `lah*` (horizontal), `lam*`
(monograma), `lol*` (login), `fav*` (favicon). Os testes B1–B3 varrem os três
contextos e reprovam qualquer repetição.

`scripts/test-fase34-identidade.js` — **25 testes, 25 OK**:

| Bloco | Cobre |
|---|---|
| A (3) | os seis assets existem · PNG antigo intacto · favicons no lugar **servido** |
| B (3) | colisão de ids entre sidebar, login e dentro de cada arquivo |
| C (3) | recolhida usa o monograma · nada com largura+altura fixas · proporção ~1,56 |
| D (4) | `currentColor` nos três lugares · vão por máscara · cores fixas e aprovadas · azul = design system |
| E (3) | a seta existe em **todas** as versões · tem área, não é fio · o LA continua ligado |
| F (3) | favicon quadrado e sem gradiente · ICO com 3 resoluções · app icon 180×180 opaco |
| G (4) | marca no lugar do `<h1>` · tokens batem com o original · favicon declarado · nada de funcionalidade perdida |
| H (2) | embutido não divergiu do arquivo · não virou `<img>` |

## 12. Regressão — zero falhas

| Suíte | |
|---|---|
| `npm run verify` (agora com o passo 7) | **OK, 1,4 s** |
| `test-fase34-identidade` | **25 ok** |
| `test-fase33-topbar` | 40 ok |
| `test-shell-boot` | 24 ok |
| `test-tema-global` | 21 ok |
| `test-sidebar-botoes` | 23 ok |
| `test-fase321-ux` | 20 ok |
| `test-pdv-visual` | 32 ok |
| `test-pdv-fluxo` | 29 ok |
| `test-pdv-rbac` | 11 ok |
| `test-fase1-funcional` | 57 ok |
| `test-governanca-percentual` | 29 ok |
| `test-app-backend` | 79 ok |
| `test-alcadas` | 41 ok |

Quatro asserções da Fase 3.3 foram atualizadas (bloco H de `test-fase33-topbar`).
Elas vigiavam um estado **deliberadamente provisório** — "um asset só, slot
apenas marcado, nenhuma logo criada" — que esta fase encerrou por decisão sua.
Passaram a vigiar a fronteira que continua valendo: a topbar segue sem marca, e
a sidebar segue sendo dona dela.

## 13. Arquivos

**Criados** (4):
```
public/img/marca-horizontal.svg       1,9 KB
public/img/marca-monograma.svg        2,5 KB
public/img/marca-monocromatica.svg    1,9 KB
scripts/test-fase34-identidade.js     25 testes
```

**Substituídos** (4, com backup em §1):
```
public/auth/favicon.svg           569 B  →  2.284 B
public/auth/favicon.ico        22.382 B  → 15.086 B  (16/32/48)
public/auth/apple-touch-icon.png 11.273 B →  5.264 B  (180×180)
public/auth/login.html          4.890 B  →  ~11 KB
```

**Alterados** (4):

| Arquivo | O quê |
|---|---|
| `public/js/sidebar.js` | `<img>` único → `MARCA_HORIZONTAL` + `MARCA_MONOGRAMA` embutidos |
| `public/css/sidebar.css` | bloco `.marca-*` com a alternância; slot de identidade marcado como preenchido |
| `scripts/verify.js` | passo 7 chama a suíte da identidade |
| `scripts/test-fase33-topbar.js` | bloco H atualizado (§12) |

**Preservado:** `public/img/logo-sistema.png`, intacto (46.707 B, verificado por
tamanho no teste A2). Não é mais referenciado por nenhuma tela — fica como
fallback, conforme pedido.

## 14. O que NÃO foi tocado

| | |
|---|---|
| PDFs (7 geradores) | usam `logoBase64` do **emitente** — a logo do cliente |
| Landing (7 telas) | marca em texto + ícone próprio, fora do escopo |
| Loja / portal | logo da loja do cliente |
| E-mails | não têm imagem de marca |
| Banco, backend, RBAC, rotas, regras | **nada** |

## 15. Riscos

| Risco | Gravidade | Observação |
|---|---|---|
| **É uma interpretação, não uma cópia** | — | o SVG foi desenhado à mão a partir da prancha. É fiel ao conceito e foi comparado lado a lado quatro vezes, mas não é idêntico pixel a pixel. Era a condição que você aprovou |
| Inter vem do Google Fonts no login | baixa | se o Google estiver fora, a marca desenha com a fonte de fallback; o login funciona igual |
| Desenho duplicado (arquivo + embutido) | baixa | mudou um, muda o outro. O teste H1 reprova a divergência do traço principal |
| Tokens do login espelhados | baixa | mudou o tema no ERP, mude no login. O teste G2 confronta os 10 valores |
| Favicon em cache | baixa | navegadores seguram favicon com força; pode ser preciso Ctrl+F5 ou uma aba anônima para ver o novo |

## 16. O que precisa do seu olho

1. **Sidebar expandida**, claro e escuro — a marca completa e o "ERP" entre os filetes;
2. **recolher a barra** (botão «) e confirmar o **monograma nítido**, sem espremer;
3. **o login** — marca, cores, e **entrar de verdade** para confirmar que o formulário está intacto;
4. **o favicon na aba** (Ctrl+F5, ou aba anônima — favicon fica em cache);
5. **adicionar à tela de início** no celular, para ver o app icon;
6. a transição ao recolher/expandir: não deve piscar nem pular.

---

## Decisão

**GO** para o que está no ar: tudo é estático e já está sendo servido —
confirmado por HTTP, não por listagem de diretório. Nenhum restart foi feito nem
é necessário. Os serviços estão com os mesmos PIDs e `NRestarts=0`.

**STOP** aqui, como pedido. Não avanço para outra fase.

A ressalva honesta: a conferência foi por renderização no Chrome e por medida —
proporção, contraste, legibilidade em 16px, ausência de colisão de id. **Não
afirmo que a marca ficou bonita**; isso é julgamento seu, e é o que falta para
esta fase fechar.

---

# Complemento — ajuste final de escala

**Data:** 2026-09-11, 19:50–20:15 BRT
**Escopo:** só escala e espaçamento. Nenhum SVG, cor, seta, favicon ou monograma foi tocado.

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, NRestarts 0 | **idêntico** |

## C1. As dimensões, antes e depois

**Sidebar expandida** — `public/css/sidebar.css`

| | Antes | Depois | |
|---|---|---|---|
| `.marca-horizontal` `max-width` | **176px** | **190px** | **+7,95%** |
| altura resultante (do viewBox) | 38,5px | 41,6px | proporção intacta |
| `.sidebar .sidebar-header` padding | `14px 14px 12px` | `14px 8px 12px 14px` | só o direito |
| `.sidebar-header` gap | `10px` | `6px` | |
| **faixa útil do cabeçalho** | **184px** | **194px** | |
| folga entre marca e botão | 8px | 4px | |
| largura da sidebar | 250px | **250px** | **inalterada** |

**Sidebar recolhida** — `.marca-monograma`: **38px, inalterado**. Medido depois: 38 × 24,4px, razão 1,556 — a mesma do viewBox (84/54).

**Login** — `public/auth/login.html`

| | Antes | Depois | |
|---|---|---|---|
| `.login-marca` `max-width` | **232px** | **265px** | **+14,2%** |
| altura resultante | 50,8px | 58px | proporção intacta |
| `margin-bottom` da marca | 10px | 14px | |
| `.login-header` `margin-bottom` | 32px | 34px | |
| card | 400px (320 úteis) | **inalterado** | sobram 55px |

## C2. Por que 190px, e não "176 + 10%"

A largura não foi escolhida por gosto — foi calculada, e o número pedido **não cabia**.

Medida no Chrome, a faixa útil do cabeçalho era **184px**: 250 da barra, menos 28 de padding, 28 do botão de recolher e 10 de gap. Com a marca em 176, sobravam 8px. Os 10% pedidos dariam **193,6px** — 9,6px além do disponível, com a marca por cima do botão.

Como a barra não podia ficar mais larga, o espaço veio de dentro. E a escolha de **onde** tirar não é indiferente:

- o **`padding-left`** de 14px é a **grade da barra** — medido, a marca começa em x=14 e o campo de busca também. Mexer nele desalinharia a marca de tudo o que vem abaixo. **Não foi tocado.**
- o **`padding-right`** não alinha com nada: à direita do cabeçalho só existe o botão de recolher, e ele não tem par nas linhas de baixo (a busca vai até 236, os itens até 230). **14 → 8px.**
- o **gap** entre marca e botão: **10 → 6px.**

Faixa útil passou a 194px, e a marca ocupa 190 com 4px de folga. **+7,95%**, dentro da faixa de 8–10% pedida, escolhido por caber e não por arredondar.

No login o limite não era o espaço — o card tem 320px úteis e sobram 55px mesmo depois do aumento. Ali o que decidiu foi a presença na tela de entrada: **+14,2%**, perto do teto dos 15%.

**Nenhum `transform: scale()`**, conforme pedido: só `max-width`. A altura continua vindo do `viewBox`, então a proporção é preservada por construção — medida depois, 4,571 no login contra 320/70 = 4,571 do viewBox.

## C3. Um defeito antigo que a mudança revelou

O monograma da barra recolhida estava **2,5px à direita do centro**.

A causa não era o ajuste: a regra `[data-sidebar="compacta"] .sidebar-header { padding: 10px 6px }` (Fase 3.2) **empatava em especificidade** com `.sidebar .sidebar-header` — ambas valem (0,2,0) — e perdia por vir antes no arquivo. Ou seja, **nunca valeu**: a barra recolhida usava o padding da expandida.

Passava despercebido porque `14/14` é simétrico e o monograma ficava quase centrado. Com o `padding-right` em 8px o desencontro apareceu.

Corrigido com um seletor de (0,3,0), que devolve ao compacto o padding que a Fase 3.2 já pretendia dar:

```css
[data-sidebar="compacta"] .sidebar .sidebar-header { padding: 10px 6px; }
```

Monograma agora em x=12,5 — centro exato da barra de 64px. **Conserto de passagem, no mesmo arquivo e na mesma regra que o ajuste tocou.**

## C4. A conta virou teste

`test-fase34-identidade.js` ganhou o **C4**, que refaz a conta a partir do CSS:

```
faixa útil = --sidebar-w − padding lateral − botão de recolher − gap
```

e reprova se a marca não couber, ou se sobrar folga demais. Vale também para a recolhida, incluindo a simetria do padding que o C3 corrigiu.

Esta classe de erro já escapou **três vezes** nesta série — a reserva do botão de tema nasceu 4px curta (relatório 20) e duas telas ficaram sem reserva nenhuma (25 e 29). Todas descobertas por sobreposição visível, depois do fato.

**Provado por sabotagem:** com a marca em 210px, o teste reprova com `a marca (210px) não cabe na faixa útil (194px)`. Restaurado em seguida.

## C5. Validação

Renderizado no Chrome, nos quatro estados:

| | claro | escuro |
|---|---|---|
| expandida | marca 190px, folga do botão | idem |
| recolhida | monograma 38px, centrado | idem |

Login conferido com o formulário funcionando (`loginForm`, `btnLogin` e a marca presentes; fonte Inter ativa; fundo `rgb(11,17,32)` = `--bg-0`). Card com 425px de altura, formulário inteiro visível.

| Suíte | |
|---|---|
| `npm run verify` | **OK, 1,3 s** |
| `test-fase34-identidade` | **26 ok** (era 25; +C4) |
| as outras 12 suítes | **0 falhas** |

## C6. Arquivos

| Arquivo | O quê |
|---|---|
| `public/css/sidebar.css` | `max-width` da marca · padding-right e gap do cabeçalho · correção de especificidade do compacto |
| `public/auth/login.html` | `max-width` e margens da marca |
| `scripts/test-fase34-identidade.js` | teste C4 |

Sem restart, sem banco, sem commit, sem mudança funcional.

## C7. O que precisa do seu olho

1. sidebar expandida nos dois temas — a marca não pode encostar no botão «;
2. **recolher a barra** e confirmar que o monograma está centrado (era o desvio do C3);
3. o login — presença da marca e respiro até "Acesse o sistema";
4. entrar de verdade, para confirmar que o formulário segue intacto.

**Parado aqui.** Não avanço para outra fase.
