# 30 — Fase 3.3: topbar global e preparação da identidade

**Data:** 2026-09-11, 17:40–18:35 BRT
**Base:** [29 — acabamento de UX](29-fase3.2.1-ajustes-ux.md) · [28 — sidebar e botões](28-fase3.2-sidebar-botoes.md)

**Resultado:** topbar implementada no shell, botão de tema migrado, dívida do
botão flutuante liquidada. **Nenhum restart, nenhuma alteração de banco, nenhum
commit.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, 12:14:16, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, 06:18:49, NRestarts 0 | **idêntico** |

---

## 1. Onde a topbar vive — e por que só num lugar

**No shell (`public/app.html`), montada uma vez.** Nenhuma das 213 telas foi
tocada para recebê-la, e nenhuma tela futura precisará ser.

O que garante isso é o `shellRedirect()`, no topo de `sidebar.js`:

```js
(function shellRedirect() {
    if (window.__liciteShell) return;           // o próprio shell
    if (window.self !== window.top) return;     // já está dentro de um frame
    location.replace('/app.html#' + location.pathname + location.search + location.hash);
})();
```

Toda página top-level do ERP é levada para dentro de `/app.html`. Logo, o que
existe no shell existe em todas elas. **Auditado, não presumido:** das 213 telas
que carregam `sidebar.js`, 100% passam por aqui.

## 2. A decisão de arquitetura: a marca fica na sidebar

Havia duas formas. Escolhi a segunda, e o motivo não é estético:

| | topbar de largura total | **sidebar de altura total** |
|---|---|---|
| marca | repetida, ou canto esquerdo vazio | **uma só, onde já estava** |
| o que muda | `top` da sidebar + `top` do iframe + cálculo de altura | **só o `top` do iframe** |
| sidebar recolhida (64px) | monograma "pula" de lugar | continua alinhado à esquerda da barra |

```css
.topbar { position: fixed; top: 0; left: var(--sidebar-w); right: 0;
          height: var(--topbar-h); transition: left .18s ease; }
```

O `left: var(--sidebar-w)` é a mesma variável que a sidebar e o iframe já usavam
desde a Fase 2.1 — recolher a barra move a topbar junto, sem nova fiação.

## 3. A dívida que isto liquida

Esta é a parte que importa mais do que a barra em si.

O botão de tema era `position: fixed` sobre o conteúdo. Como não empurrava nada,
**cada cabeçalho precisava reservar espaço por conta própria** — e quem não
reservasse era coberto:

| Quando | Onde | Sintoma |
|---|---|---|
| relatório 25 | `.pdv-topo` | botão sobre "+ Novo pedido" |
| relatório 29 | `.ped-header` | botão sobre "Salvar" e "Ações" |
| relatório 20 | `.page-header` | reserva global nasceu **4px curta** |

Três descobertas, todas por sobreposição visível, todas depois do fato. A
próxima tela com cabeçalho próprio teria o mesmo defeito, e ninguém saberia.

**A topbar ocupa espaço em vez de flutuar:**

```css
#conteudo { top: var(--topbar-h); height: calc(100% - var(--topbar-h)); }
```

As três reservas foram removidas. Medido depois: **zero** telas com reserva de
canto remanescente, **zero** elementos `fixed` no topo direito em qualquer das
213 telas. E o levantamento final mostra que só **duas** telas têm cabeçalho
próprio — `pedido.html` e `pedidos-pdv.html`, exatamente as duas que já haviam
dado o defeito. A dívida está inteira, não parcialmente, paga.

## 4. Arquivos alterados

| Arquivo | O quê |
|---|---|
| `public/js/sidebar.js` | `montarTopbar`, `montarMenuConta`, `carregarIdentidade`, `publicarEmpresaNaTopbar`, `alternarMenuConta`/`fecharMenuConta`, `ligarFechamentoDoMenuConta` · `montarBotaoTema` removida · grupo Conta fora do menu |
| `public/css/sidebar.css` | bloco da topbar (`--topbar-h`, `.tb-*`) no lugar do `#btnTema` flutuante · slot do monograma documentado |
| `public/app.html` | iframe começa abaixo da topbar |
| `public/css/app-modern.css` | reserva do `.page-header` removida |
| `public/comercial/pedido.html` | reserva do `.ped-header` removida |
| `public/comercial/pedidos-pdv.html` | reserva do `.pdv-topo` removida |
| `scripts/test-fase33-topbar.js` | **novo** — 40 testes |
| `scripts/verify.js` | passo 6 chama a suíte nova |
| `scripts/test-{shell-boot,tema-global,sidebar-botoes,fase321-ux,pdv-visual}.js` | 8 premissas atualizadas (§13) |

**Zero alteração de banco, de API, de rota ou de regra comercial.**

## 5. O defeito que o teste pegou — e que teria ido para produção

O mais importante desta fase.

`montarTopbar` roda no IIFE `initTema`, **no meio** de `sidebar.js`.
`montarMenuConta` chama `renderIcon`, que lê `EMOJI_TO_LUCIDE` — um `const`
declarado **mais abaixo** no mesmo arquivo. Zona morta temporal:

```
[topbar] não pôde ser montada: Cannot access 'EMOJI_TO_LUCIDE' before initialization
```

O `try/catch` fez o que foi desenhado para fazer — segurou o shell de pé. E foi
exatamente isso que tornou o defeito perigoso: **a barra aparecia, o menu de
conta nascia vazio, e o único sinal era uma linha no console**. Como o grupo
Conta acabara de sair da sidebar, o usuário ficaria **sem nenhum caminho para
sair do sistema**.

Nada na tela denunciaria. `npm run verify` estava verde — o arquivo parseia, o
shell monta. Quem pegou foi o teste A5, que executa a montagem de verdade e
reprova se ela cair no `catch`.

**Correção:** o conteúdo do menu passa a ser montado na primeira abertura, não
no boot. Nesse momento o arquivo terminou de carregar e toda declaração existe.
Resolve pela raiz, e ainda economiza trabalho no boot.

## 6. Botão de tema — mudou de casa, não de função

Mesmo ícone, mesma `alternarTema`, mesma persistência em `users.tema` pelo
`/api/user/prefs`. Continua redondo e só com o ícone.

O que saiu: `position: fixed`, `top`, `right`, `z-index: 900` e o `box-shadow`
de elemento flutuante. Dois testes (B2 aqui, D5 no tema global) reprovam se
qualquer um deles voltar.

## 7. Área da conta — um "Sair", não dois

O pedido era explícito sobre não duplicar. O grupo "Conta" **saiu do menu
lateral**; Senha e Sair vivem no dropdown da topbar, que é onde se procura por
eles.

As ações são as **mesmas funções** — `abrirModalSenha` e `fazerLogout`, ambas
intactas no arquivo. Não houve reimplementação: mudou o lugar de onde são
chamadas. O teste C1 executa os dois handlers e confere que cada um chama a
função original exatamente uma vez.

O grupo Conta já vinha esvaziando: "Cor do Sistema" saiu no relatório 24. Com
Senha e Sair fora, ele deixou de ter conteúdo e foi removido inteiro.

## 8. Identidade — só o que existe de verdade

### Usuário

`/api/usuarios/me`, rota que **já existia** e está em `LIBERADOS` no
`perfis-api-map` (passa para qualquer perfil — verificado no teste E2).

É a **única requisição nova** da fase. Nenhuma das que o shell já fazia
(`/api/user/prefs`, `/api/features/status`, `/api/perfis/meu-acesso`) devolve o
nome da pessoa — conferido antes de acrescentar a chamada.

Medido nos bancos em 2026-09-11: **32 dos 33 usuários ativos** têm `nome`
preenchido. O único que não tem cai para `username`, que nunca falta por ser a
chave de login. Cobertura efetiva: 100%.

### Empresa — **e a ressalva que o pedido pedia**

**Zero requisições.** O nome é publicado por `carregarEstabSwitcher`, que já
consulta `/api/estabelecimentos` em todo carregamento do menu.

⚠️ **O dado é esparso no acervo real.** Medido no mesmo dia, nos 13 tenants de
cliente:

| Tenant | `nomeFantasia` / `razaoSocial` |
|---|---|
| `1bit` | 1 BIT GESTÃO E CONSULTORIA LT |
| `josecarloscostafilho` | MC Consultoria |
| `produtosbomgosto` | VALDIRENE DOS SANTOS LIMA DA S |
| `reimac` | REIMAV |
| **outros 9** | **vazio** |

**Nos 9 sem dado, o campo não aparece.** Nada de "Empresa", nada do slug do
tenant, nada do `tenants.name` do `control.db` — este último até tem nomes
melhores ("Produtos Bom Gosto", "1bit Tecnologia"), mas é plano de controle e
não está exposto ao frontend do tenant. Escrever qualquer um dos três seria
inventar identidade que ninguém cadastrou.

O teste D4 passa `null`, `undefined`, `''` e `'   '` e reprova se sair qualquer
coisa na tela.

**Multi-loja:** quando há mais de um estabelecimento, o seletor da sidebar já
diz qual está ativo, então a topbar mostra a **matriz** — a empresa, que é o que
não muda ao trocar de loja.

## 9. O que deliberadamente NÃO entrou

| Ideia comum de topbar | Por que fora |
|---|---|
| sino de notificações | **não existe central de notificações** neste ERP |
| ícone de ajuda / suporte | **não existe destino real** de suporte |
| busca global | já existe, e é na sidebar (`.menu-busca`) — duplicar daria dois campos |
| atalhos rápidos | sem função definida |
| breadcrumb | o shell não tem hierarquia de navegação para descrever |
| logo na topbar | duplicaria a marca da sidebar (§2) |

Um sino que não toca e um "?" que não leva a lugar nenhum são piores que a
ausência deles.

## 10. Mobile

A sidebar vira gaveta e sai do fluxo; a topbar toma a largura inteira.

O canto esquerdo continua sendo do botão hambúrguer (`.menu-toggle`, `fixed` e
`z-index: 1001` — **por cima** da barra, que é 1000). O `padding-left: 64px`
abre o espaço dele, e o teste F6 **calcula** a ocupação real do hambúrguer a
partir do CSS e reprova se o padding ficar curto. É a mesma classe de conta que
nasceu 4px errada no relatório 20 — desta vez medida por máquina.

Nome da empresa e nome do usuário cedem o lugar; ficam o tema, o chevron e o
avatar, que já identifica quem está logado.

Uma armadilha encontrada e resolvida: com `.tb-esq` escondida sobra um filho só,
e o `justify-content: space-between` jogaria a área da conta para a **esquerda**,
em cima do hambúrguer. `margin-left: auto` na `.tb-dir` segura (teste F7).

## 11. Temas

Todo o CSS da topbar usa tokens — o teste G1 varre o bloco e reprova cor
literal.

**Um defeito de contraste encontrado e corrigido.** O avatar nasceu com
`background: var(--accent)` e texto branco. No tema escuro `--accent` é
`#60a5fa`:

| Fundo | Branco sobre ele |
|---|---|
| `--accent` escuro `#60a5fa` | **2,54:1** — reprova |
| `--btn-primary-bg` `#2563eb` | **5,17:1** — passa |

Passou a usar `--btn-primary-bg`, o par já verificado na Fase 3.2, que vale nos
dois temas. O teste G2 **lê do CSS qual token o avatar realmente usa**, em vez
de presumir — se alguém trocar de novo, a verificação acompanha.

O tema `custom:` legado segue funcionando (`paletaCustom` e `abrirModalTema`
intactas — teste C3).

## 12. Acessibilidade

| Item | Estado |
|---|---|
| landmark | `<header role="banner">` |
| botão de tema | `aria-label` + `title` |
| botão de conta | `aria-haspopup="menu"`, `aria-expanded` alternando, `aria-label` que **nasce genérico** e vira "Conta de \<nome\>" quando a API responde |
| menu | `role="menu"`, itens `role="menuitem"`, `aria-labelledby` |
| avatar | `aria-hidden="true"` — a inicial é decorativa e seria lida duas vezes |
| **Escape** | fecha o menu **e devolve o foco** ao botão (teste C5) |
| foco | `:focus-visible` em `.tb-btn` e `.tb-menu-item`; primeiro item recebe foco ao abrir |
| contraste | AA verificado por cálculo (§11) |
| impressão | `@media print { .topbar { display: none } }` |

## 13. Custo: uma requisição, nenhum laço

O pedido proibia polling e listeners novos. Medido, não afirmado:

- **E1** conta as requisições do boot num `fetch` instrumentado: exatamente uma
  além das pré-existentes, e é `/api/usuarios/me`;
- **E3** extrai o corpo das 7 funções novas e reprova `setInterval`,
  `MutationObserver` ou `requestAnimationFrame`;
- **E4** conta os listeners antes e depois de remontar, e reprova se acumularem.

Dois listeners de documento ao todo (clique fora, Escape), registrados uma vez.

## 14. Preparação da identidade — inventário, sem criar nada

**Nenhuma logo foi criada, trocada ou substituída.** O favicon não foi tocado.

O acervo real, levantado:

| Asset | Tamanho | Onde |
|---|---|---|
| `public/img/logo-sistema.png` | 400×100, 46 KB | sidebar, referenciado **num único lugar** (`sidebar.js`) |
| `public/auth/favicon.svg` | 569 B | injetado por `injectFavicons` |
| `public/auth/favicon.ico`, `apple-touch-icon.png` | — | idem |

**A lacuna concreta é o monograma.** A logo é 4:1, horizontal. Com a sidebar
recolhida (`max-width: 46px`), ela desenha com ~11px de altura: legível no
expandido, um borrão no compacto. **Não existe símbolo quadrado**, e esta fase
não criou um.

O que foi preparado é o **ponto de troca**, marcado onde ele vai entrar:

```css
/* ⚠️ SLOT DE IDENTIDADE — … Quando existir, o slot é este: troque o `src`
   deste <img> pelo monograma dentro de [data-sidebar="compacta"] … */
[data-sidebar="compacta"] .sidebar-logo-img { max-height: 26px; max-width: 46px; }
```

Dois testes protegem a preparação: **H1** reprova se a logo passar a ser
referenciada em mais de um arquivo (trocar a identidade deixaria de ser uma
linha); **H4** reprova se algum asset de marca novo aparecer em `public/img`.

## 15. Premissas de teste que precisaram mudar

Oito asserções de fases anteriores passaram a falhar, e **todas porque esta fase
removeu a causa que elas vigiavam** — não porque algo quebrou:

| Suíte | Asserção | Agora prova |
|---|---|---|
| `test-shell-boot` | B2 exigia o grupo Conta | que ele **não voltou** ao menu lateral |
| | D1, D3 citavam `montarBotaoTema` | o mesmo, sobre `montarTopbar` |
| `test-tema-global` | D2 exigia Senha/Sair no menu | que estão no menu de conta, e só lá |
| | D5, D6 mediam reservas | que o botão **não é mais `fixed`** e as reservas sumiram |
| | D7 comparava com o botão | ordem interna da gaveta (contextos de empilhamento diferentes) |
| `test-sidebar-botoes` | A exigia `grp-conta` | que ele saiu |
| `test-fase321-ux` | A2, D, E, E2 | idem |
| `test-pdv-visual` | F1, F2 | idem |

Nenhuma foi apenas afrouxada: cada uma passou a vigiar a **causa**, não o
sintoma. Duas ganharam correção de regex de quebra: o seletor `.menu-toggle`
casava antes com `body.embedded .menu-toggle`, e `#btnTema {[\s\S]*?z-index}`
escorregava para a regra seguinte — esta última estava medindo outra coisa e
passando por acaso.

**É a quarta vez** que um teste meu casa com o próprio comentário que explica a
mudança: o H1 acusou a logo "referenciada em dois lugares" porque a nota do slot
cita o nome do arquivo. Todos os testes deste arquivo removem comentários antes
de procurar.

## 16. Testes

`scripts/test-fase33-topbar.js` — **40 testes, 40 OK**. A topbar é **construída
de verdade** num DOM simulado (com parser de HTML, `classList`, `closest` que
sobe pelos pais) e depois inspecionada. Não é regex sobre o fonte — precaução do
relatório 24, onde 14 testes verdes rodaram sobre um arquivo que nem parseava.

Uma correção na própria harness: o `t()` era síncrono e imprimia OK **antes** de
a promessa dos testes `async` rejeitar. D1 dava verde e derrubava o processo no
fim. Teste que anuncia o resultado antes de tê-lo não é teste — agora a fila é
percorrida com `await`.

| Bloco | Cobre |
|---|---|
| A (5) | monta, landmark, não no iframe, idempotência, **não cai no catch** |
| B (2) | tema dentro da barra, ainda alterna, não é mais `fixed` |
| C (6) | Senha/Sair, um lugar só, funções reais, `aria-expanded`, Escape, clique fora |
| D (5) | nome, fallback para `username`, API caindo, empresa vazia, sem chamada nova |
| E (4) | uma requisição, RBAC, sem polling, listeners não acumulam |
| F (7) | reserva no shell, tokens, acompanha a sidebar, z-index, reservas removidas, mobile |
| G (4) | tokens, contraste AA, nome acessível, impressão |
| H (4) | asset único, sem logo na topbar, slot marcado, **nada criado** |
| I (3) | menu monta, RBAC intacto, `shellRedirect` intacto |

**Regressão — zero falhas:**

| Suíte | |
|---|---|
| `npm run verify` (agora com o passo 6) | **OK, 1,5 s** |
| `test-fase33-topbar` | **40 ok** |
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

## 17. RBAC e regras — inalterados

| Verificação | Resultado |
|---|---|
| prefixos no mapa de API | **175** — igual |
| itens no menu | **190** — igual |
| `desenharMenuComAcesso` | intacto |
| `shellRedirect` | intacto |
| rota nova criada | **nenhuma** |
| **banco de dados** | **nada tocado** |

## 18. Validação de telas (Parte 15)

Estrutural, em 10 telas representativas: todas carregam `sidebar.js`; 8 usam
`.page-header` (que perdeu só o `padding-right` — nunca teve outro padding
próprio); as 2 de altura fixa usam `100vh`, que **dentro do iframe já é a altura
do iframe**, portanto já descontada da topbar.

Varredura nas 213: **0** reservas de canto remanescentes, **0** elementos
`fixed` no topo direito.

## 19. Riscos

| Risco | Gravidade | Observação |
|---|---|---|
| **Não vi as telas renderizadas** | — | a extensão do Chrome recusa `localhost`, e o host real (`<slug>.liciteagora.app`) exige DNS e sessão. A validação foi **estrutural e por execução**, não visual. **Não afirmo que ficou bonito** — isso é o que preciso do seu olho |
| o nome da empresa some em 9 tenants | baixa | é a decisão consciente do §8; se preferir o `tenants.name` do control plane, é backend e ficou de fora |
| 52px a menos de altura útil | baixa | o iframe encolheu; nas telas de altura fixa (PDV, pedido) isso significa 52px a menos de lista visível |
| menu de conta montado tardiamente | baixa | um clique a mais de trabalho na primeira abertura; foi a correção do §5 e o teste C1 cobre |
| `--sombra-md` é `none` no escuro | baixa | o dropdown usa `--sombra-modal` + `border-strong` para ter aresta própria; mesmo peso do `.modulo-pop` |

## 20. O que precisa do seu olho

1. **a topbar em si** — altura, alinhamento com a sidebar, no claro e no escuro;
2. **recolher a sidebar** (botão «) e ver se a topbar acompanha sem pular;
3. **o menu de conta** — abrir, ver Senha e Sair, fechar com Escape e clicando fora;
4. **confirmar que o "Sair" funciona** — é o ponto do §5, e o mais importante da lista;
5. **o nome da empresa**: no `1bit` deve aparecer; num tenant sem cadastro, nada;
6. **`/comercial/pedido.html?id=…`** — "Salvar" e "Ações" agora encostam mais à
   direita (a reserva de 58px saiu); confirmar que não ficou apertado;
7. **o Pedidos PDV** — mesma conferência no "+ Novo pedido";
8. **no celular** — hambúrguer e área da conta não podem se tocar.

---

## Decisão

**GO** para o que está no ar: nada precisa de restart (só `public/`, já
servido), a regressão está limpa e o defeito sério da fase foi encontrado e
corrigido **antes** de chegar em você.

**STOP** para o passo seguinte. Não inicio logo definitiva, favicon, redesign do
PDV, notificações, ajuda, nem qualquer mexida em backend. O monograma está
mapeado e com o slot marcado — **criar o asset é decisão sua**, não minha.

E a ressalva honesta: a validação foi por execução e por medida, não por olho.
A confirmação visual dos 8 pontos acima é o que falta para esta fase fechar.
