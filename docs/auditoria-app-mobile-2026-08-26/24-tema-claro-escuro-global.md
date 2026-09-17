# 24 — Tema claro / escuro global

**Data:** 2026-09-11
**Resultado:** implementado e testado. **Já está no ar** — tudo é frontend
estático. **Nenhum restart é necessário** (§17).

**Não feito, por instrução:** pagamento do PDV · Catálogo Online · commit ·
restart · Asaas · alteração em dado de cliente.

---

## 1. Como funcionava antes

**"Cor do Sistema" nunca foi um seletor de tema claro/escuro.** Era um seletor de
**duas cores livres** — fundo e destaque — em dois `<input type="color">`. O
sistema derivava uma paleta inteira a partir desse par e gravava as 23 variáveis
CSS como estilo inline no `<html>`.

| Peça | Onde |
|---|---|
| Item de menu | `public/js/sidebar.js` — grupo **Conta** |
| Modal | `#modalTema`, no mesmo arquivo |
| Derivação da paleta | `paletaCustom(bg, accent)` + `mixHex()` |
| Aplicação | `aplicarTema(tema)` — `style.setProperty` no `<html>` |
| Formato gravado | string: `'padrao'` ou `'custom:#bg:#accent'` |
| Cache local | `localStorage.appTheme` |
| **Persistência** | **`users.tema`**, via `GET`/`POST /api/user/prefs` (`auth-routes.js:167,176`) |

A preferência **já era por usuário**, no banco do tenant — não por tenant, não em
cookie, não em configuração global. Essa infraestrutura foi **reaproveitada
inteira**: nenhuma rota nova, nenhuma coluna nova.

### O achado que mudou o desenho

Cinco usuários reais têm cor salva — e **quatro escolheram fundo claro**:

| Tenant | Usuário | `users.tema` | Fundo |
|---|---|---|---|
| `josecarloscostafilho` | william | `custom:#ffffff:#1f6dea` | **branco** |
| `josecarloscostafilho` | admin | `custom:#fcfcfc:#1a1acb` | quase branco |
| `josecarloscostafilho` | caio | `custom:#fcfcfd:#0c4bb0` | quase branco |
| `1bit` | admin | `custom:#f5f7f9:#021a40` | cinza claro |
| `produtosbomgosto` | admin | `custom:#030202:#114283` | quase preto |

As pessoas **já estavam tentando fazer tema claro** com o seletor de cores. Isso
confirmou a demanda e impôs a regra: esses dados não podem ser descartados (§14).

## 2. Nova arquitetura

O `:root` continua sendo o **tema escuro**, e o claro sobrescreve **exatamente os
mesmos 23 tokens** sob `[data-theme="claro"]`:

```css
:root                  { --bg-0: #0b1120; … }   /* escuro, o padrão */
[data-theme="claro"]   { --bg-0: #f1f4f8; … }   /* claro */
```

Nenhum token novo, nenhuma regra duplicada por componente, **nenhuma condicional
JavaScript por página**. Quem já escrevia `var(--bg-1)` ganhou o tema claro sem
ser tocado — é isso que faz a mudança valer para o ERP inteiro em vez de tela a
tela.

Quem escreve o atributo: `theme-boot.js` (antes do paint) e `sidebar.js` (na
troca). Só isso.

## 3. Persistência

Inalterada, porque já era adequada:

```
clique → escolherTema(novo)
           ├─ localStorage.appTheme          (cache local, imediato)
           ├─ propaga para os iframes         (app shell)
           └─ POST /api/user/prefs { tema }   → users.tema
```

No carregamento seguinte, `theme-boot.js` lê o `localStorage` (síncrono, antes do
paint) e o `sidebar.js` confirma com o servidor, que é a fonte da verdade. Vale
em qualquer navegador e em qualquer máquina, **por usuário** — nunca virou
configuração de tenant.

## 4. Prevenção do flash

O problema era real: `sidebar.js` carrega **no fim do `<body>`**, depois de todo
o CSS. Como `:root` é escuro, quem usa tema claro via a tela inteira escura e só
então ela clareava.

Não dava para resolver movendo `sidebar.js` para o `<head>` — ele monta o menu e
precisa do DOM.

**Solução:** `public/js/theme-boot.js` — a menor coisa que resolve. Síncrono, sem
dependências, no `<head>` **antes das folhas de estilo**. Ele só escreve um
atributo em `<html>`; quando o CSS chega, `[data-theme="claro"]` já vale e o
primeiro paint sai certo.

Foi inserido em **213 telas** por `scripts/inserir-theme-boot.js`, que é
idempotente, só toca em `.html` que carregam `sidebar.js` e pula (relatando)
qualquer arquivo sem `<link rel="stylesheet">` para ancorar. **Nenhum foi
pulado.** Verificado: as 213 têm a linha, sempre **antes** do CSS, sem duplicatas.

O script também ajusta o `<meta name="theme-color">` — sem isso a barra do
navegador no celular fica escura numa tela clara, e a moldura do sistema desmente
o tema da página.

## 5. Tokens

Os 23 de sempre, agora com valor nos dois temas. Os nomes seguem a arquitetura
existente (`--bg-*`, `--text-*`) em vez dos genéricos sugeridos — renomear
obrigaria a reescrever as 213 telas e os dois CSS por ganho nenhum:

| Conceito pedido | Token do sistema |
|---|---|
| `--bg` | `--bg-0` |
| `--surface` / `--card-bg` | `--bg-1` |
| `--surface-secondary` | `--bg-2`, `--bg-3` |
| `--border` | `--border`, `--border-strong` |
| `--text` / `--text-muted` | `--text-0`…`--text-3` (quatro níveis) |
| `--primary` / `--primary-hover` | `--accent` / `--accent-strong` |
| `--danger` / `--success` / `--warning` | `--danger` / `--success` / `--warn` |
| `--input-bg` | `--bg-input` |
| `--sidebar-bg` | `--bg-1` (a sidebar usa a mesma superfície) |

Um token novo: `--sombra-card`, `none` no escuro e sombra suave no claro (§7).

## 6. Tema escuro

Mantido como era — nenhum usuário perde a aparência a que está acostumado.
Verificado que ele cumpre o que foi pedido: **nada de preto absoluto**
(`--bg-0: #0b1120`, `--bg-1: #0f172a`, `--bg-2: #111827` — grafite azulado, três
superfícies distintas), bordas discretas (`#1e293b`) e azul de ação `#60a5fa`.

## 7. Tema claro

| Token | Valor | Por quê |
|---|---|---|
| `--bg-0` | `#f1f4f8` | **não é branco**: fundo cinza claro, para o card branco existir por si |
| `--bg-1` / `--bg-2` | `#ffffff` | superfícies e modais |
| `--bg-3` | `#e8edf4` | cabeçalho de tabela, chips, áreas de apoio |
| `--border` | `#dbe2ea` | discreta — borda forte demais "gradeia" a tela |
| `--text-0`…`--text-3` | `#0f172a` → `#6b7a8f` | 16,9:1 · 10,4:1 · 6,5:1 · 4,6:1 |
| `--accent` | `#1d4ed8` | o azul da marca, escurecido o bastante para AA (§12) |
| `--sombra-card` | sombra suave | no escuro a elevação vem do contraste; no claro, da sombra |

**Branco puro em tudo foi evitado de propósito**: card branco sobre fundo branco
só se distingue pela borda, e a tela vira uma folha lisa. Aqui o fundo é cinza e
as superfícies são brancas.

## 8. O menu

`Conta → Cor do Sistema` **saiu**. `Alterar Senha` e `Sair` **ficaram** —
verificado por teste (D2).

**O modal e as funções continuam no arquivo**, sem entrada no menu:
`abrirModalTema()`, `salvarTemaCustom()`, `paletaCustom()`,
`restaurarTemaPadrao()`. Não é descuido — é o que garante que os cinco usuários
com tema `custom:` tenham por onde sair dele, e nenhum arquivo foi apagado. Está
marcado como legado no comentário do próprio ponto onde o item existia.

## 9. O botão no topo

`#btnTema`, injetado por `sidebar.js` no canto superior direito, **34 px, só o
ícone** (☀️ no escuro, 🌙 no claro), com `title="Alternar tema"`.

É injetado por JavaScript, e não escrito nas telas, por um motivo prático: são
213 telas e **nenhuma tem cabeçalho global** — cada uma monta o próprio
`.page-header`. Injetar num lugar só faz o controle existir em todas de uma vez.

`position: fixed`, `z-index: 900` — acima do conteúdo, abaixo dos modais (10000).
Como as telas põem os botões de ação exatamente nesse canto, o CSS reserva
`padding-right` no `.page-header`; sem isso o botão os cobriria.

**Não é injetado dentro do iframe do shell**: lá quem manda é a janela de fora,
que já tem o seu. Dois botões seriam dois controles para a mesma coisa.

## 10. Compatibilidade

**Nenhum dado foi descartado nem migrado à força.**

| Valor em `users.tema` | O que acontece |
|---|---|
| `'claro'` / `'escuro'` | o novo caminho: só `data-theme`, paleta do CSS |
| `'padrao'` / vazio | escuro, como sempre foi |
| `'custom:#bg:#accent'` | **o caminho legado, intacto**: a paleta continua sendo derivada e aplicada inline — e `data-theme` é marcado pela **luminância do fundo escolhido**, para as regras que dependem da base acertarem |

Quem está num tema custom vê a mesma coisa de antes. Ao **clicar** no botão, passa
a claro/escuro explícito — migração no momento escolhido pela pessoa, não uma
conversão em massa por trás dela.

RBAC, rotas, tenants e funcionalidades comerciais não foram tocados: a mudança é
CSS, um script de 40 linhas e a injeção de um botão.

## 11. Pedidos PDV

**Já usava os tokens globais** desde que foi escrito — nenhum `background` ou
`color` hardcoded incompatível. Funciona nos dois temas sem alteração de layout.
O refinamento visual fica para a próxima etapa, como combinado.

Duas correções entraram nele:

1. o `<meta name="theme-color">` estava fixo em `#0f1115`; agora o `theme-boot`
   o ajusta ao tema;
2. **5 bytes NUL** — eu havia usado o caractere NUL literal como sentinela de
   "sem categoria" ao escrever a tela. O arquivo era UTF-8 válido e funcionava,
   mas `file` o classificava como `data` e `grep`/`diff` o tratavam como binário.
   Trocado por uma constante nomeada (`SEM_CATEGORIA`), idêntica em runtime. O
   teste D4 agora varre `public/` inteiro e reprova se algum NUL voltar.

## 12. Acessibilidade

Contraste calculado por WCAG e verificado por teste, **nos dois temas**:

| Par | Escuro | Claro | Mínimo |
|---|--:|--:|--:|
| `--text-0` sobre `--bg-0` / `--bg-1` | ✔ | 16,9:1 / 16,9:1 | 4,5 |
| `--text-1` sobre `--bg-1` | ✔ | 10,4:1 | 4,5 |
| `--text-2` sobre `--bg-1` | ✔ | 6,5:1 | 4,5 |
| `--text-3` (placeholder, legenda) | ✔ | 4,6:1 | 3,0 |
| `--accent` sobre fundo | ✔ | 6,7:1 | 3,0 |
| texto de badge sobre o `-soft` | ✔ | 4,8–6,0:1 | 4,5 |

**Um defeito que o teste pegou:** com `--accent: #2563eb`, o texto de badge sobre
`--accent-soft` dava **4,24:1** — abaixo de AA. Escurecido para `#1d4ed8`, que
leva o badge a 5,49:1, o link sobre branco a 6,70:1 e o branco sobre o botão
primário a 6,70:1. As cores de estado do claro também foram escurecidas em
relação ao escuro: `#34d399` sobre branco daria ~1,6:1, ilegível.

## 13. Mobile

O botão fica em `top:10px; right:10px`, 32 px. Não disputa espaço: no mobile a
sidebar vira menu com hambúrguer no canto **esquerdo**, então o direito está
livre. `@media print` o esconde.

## 14. Hardcodes: o que a varredura encontrou

Varri `public/` inteiro atrás de cores fixas que o tema claro tornaria ilegíveis.

**Texto claro sem fundo próprio** (risco de texto invisível): **5 telas**, e o
resultado importa —

- 3 delas (`auth/orcamento`, `comercial/proposta-template`, `auth/admin/index`)
  **não participam do tema**: são públicas, não carregam `sidebar.js` e
  continuam escuras como antes;
- 2 (`crm-oportunidade`, `restaurante/gorjetas`) usam **fundo dinâmico colorido**
  (badge com cor de etapa/status), onde texto branco é o correto.

**Zero texto invisível** nas telas que participam do tema.

**Fundo fixo:** 1 tela com fundo escuro fixo — `cobranca/cobrancas.html`, um
`<pre>` com `background:#1e293b` que ficaria como um bloco escuro dentro do tema
claro. **Corrigido** para `var(--bg-3)` + `var(--text-1)`.

Os `background:#fff` remanescentes (4 telas) foram inspecionados um a um e
**são deliberados**: fundo de thumbnail, logo de produto com transparência,
canvas de assinatura (`cursor:crosshair`) e **QR Code**, que precisa de fundo
branco para ser lido. Mexer neles quebraria a função.

## 15. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/js/theme-boot.js` | **novo** — anti-flash + `theme-color` |
| `public/css/app-modern.css` | bloco `[data-theme="claro"]`, `--sombra-card`, reserva no `.page-header` |
| `public/css/sidebar.css` | estilo do `#btnTema` (+ mobile, + print) |
| `public/js/sidebar.js` | `baseDoTema()`, `aplicarTema()` com `data-theme`, botão, item removido do menu |
| `public/comercial/pedidos-pdv.html` | NUL removido, `theme-color` dinâmico |
| `public/cobranca/cobrancas.html` | `<pre>` com fundo fixo → token |
| **213 telas `.html`** | uma linha: `<script src="/js/theme-boot.js">` no `<head>` |
| `scripts/inserir-theme-boot.js` | **novo** — o mutirão, idempotente |
| `scripts/test-tema-global.js` | **novo** — 14 testes |

**Backup antes do mutirão:** `/home/carlosfinezi/backups/tema-global-20260911-134937`
(tar com as 212 telas + os 3 arquivos de base).

## 16. Testes

`scripts/test-tema-global.js` — **14 testes, 14 OK**:

| Bloco | O que cobre |
|---|---|
| A | o claro define os MESMOS tokens do escuro (se esquecer um, aquele componente fica com a cor errada e ninguém percebe); nenhum token sobrando; os 23 do tema custom existem nos dois |
| B | contraste AA nos dois temas; badges legíveis; claro sem branco puro no fundo; escuro sem preto absoluto |
| C | `theme-boot` resolve cada valor — inclusive **os cinco temas custom reais** — e `sidebar.js` **concorda com ele em todos os casos** (se divergissem, a página nasceria num tema e pularia para o outro) |
| D | as 213 telas com o boot antes do CSS; "Cor do Sistema" fora do menu e Senha/Sair dentro; funções legadas preservadas; **nenhum byte NUL** em `public/` |

**Regressão — zero falhas novas:** `verify` OK · **425 blocos de JS inline nas 213
telas alteradas, 0 com erro** · `test-pdv-fluxo` 29 · `test-pdv-rbac` 11 ·
`test-fase1-funcional` 57 · `test-governanca-percentual` 29 · `test-app-backend`
79 · `test-alcadas` 41.

Servido e conferido pelo processo em execução: `theme-boot.js` (HTTP 200),
`app-modern.css` com 8 ocorrências de `[data-theme="claro"]` e `--bg-0: #f1f4f8`,
e as telas (`pedidos`, `pedidos-pdv`, `alcadas`, `app.html`) trazendo o boot.

### O que NÃO foi testado, e é a limitação principal

**Não consegui ver as telas renderizadas.** Tentei abrir o ERP no Chrome: o
domínio do tenant não resolveu do navegador, e em `localhost` a extensão recusou
a captura (`Permission denied for this action on this domain` — autorização por
site, que é sua). Não insisti.

Portanto: o contraste está calculado, os tokens estão provados e a sintaxe está
verificada, **mas ninguém olhou a tela**. Componentes como tabelas, dropdowns,
badges e modais foram verificados por token, não por aparência. Um espaçamento
ruim, um ícone que some ou uma borda que desaparece no claro só aparecem olhando.

Uma tela `proposta-template.html` acusa erro de sintaxe no JS inline — **é
pré-existente**: o arquivo é de **2026-05-11**, não carrega `sidebar.js` nem
`theme-boot`, e não está no tar do mutirão. Não foi tocado nesta etapa.

## 17. Restart

**Nenhum.** Tudo é frontend estático (`public/`), que fica no ar no instante em
que o arquivo é salvo. Nenhum `.js` da raiz foi alterado; `auth-routes.js`,
que serve `/api/user/prefs`, **não precisou mudar**.

Serviços intactos: `consulta-licitacoes.service` PID 3777293 (12:14:16) e
`liciteagora.service` PID 3085849 (06:18:49).

**Basta recarregar a página** (Ctrl+F5 na primeira vez, para o navegador pegar o
CSS e o `sidebar.js` novos em vez do cache).

## 18. Limitações

1. **Nenhuma verificação visual** (§16) — é o próximo passo, e o mais importante.
2. **A logo não foi verificada nos dois temas.** Não a redesenhei, como pedido,
   mas também não consegui vê-la renderizada. Se for um PNG claro sobre fundo
   escuro, pode perder contraste no tema claro. **Vale olhar primeiro.**
3. **27 telas não participam do tema** — as que não carregam `sidebar.js`: login,
   portal público, orçamento, admin do control-plane. Continuam escuras, como
   sempre foram. Incluí-las exigiria decidir se o tema de um visitante anônimo
   faz sentido, o que é outra conversa.
4. **O tema custom legado não some sozinho.** Os cinco usuários continuam nele
   até clicarem no botão. É deliberado (§10), mas significa que a paleta deles
   não é exatamente a do tema claro novo.
5. **Sem `prefers-color-scheme`.** O tema não segue a preferência do sistema
   operacional no primeiro acesso — todo mundo começa no escuro. Adicionar isso
   mudaria a aparência de quem nunca escolheu, e essa decisão é sua.

## 19. Próximo passo recomendado

1. **Abrir o ERP e olhar** — nos dois temas, em desktop e celular: sidebar,
   cabeçalho, tabelas, cards, formulários, inputs, selects, modais, dropdowns,
   badges, botões, alertas, e as telas de Pedidos, Produtos, Clientes,
   Configurações e Pedidos PDV. É o que este relatório não pôde fazer.
2. **Conferir a logo** nos dois temas (§18.2).
3. **Ajustes que a revisão apontar** — e então o refinamento visual do Pedidos
   PDV, que era o destino original desta sequência.
4. Depois: **Fase 2.2 — pagamento do PDV**.
