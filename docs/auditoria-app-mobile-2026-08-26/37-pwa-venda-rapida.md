# 37 — PWA instalável: Licite Agora no celular

**Data:** 2026-09-12, 13:10–14:20 BRT
**Escopo:** manifest, service worker e registro. **Nenhum backend, banco, rota, perfil ou regra.**

| Unidade | Antes | Depois |
|---|---|---|
| `consulta-licitacoes.service` | PID 3777293, NRestarts 0 | **idêntico** |
| `liciteagora.service` | PID 3085849, NRestarts 0 | **idêntico** |

Sem restart — nenhum `.js` de servidor foi tocado. `git status`: 368 → 374 (6 arquivos novos).

---

## 1. O que já existia

A auditoria achou **metade da infraestrutura pronta**, e ela foi reaproveitada inteira.

| Item | Situação | O que foi feito |
|---|---|---|
| `manifest.json` / `.webmanifest` | **não existia** | criado |
| service worker | **não existia** | criado |
| registro de SW | **não existia** | criado |
| `theme-color` | **existia, e dinâmico** — `theme-boot.js` ajusta por tema (`#f1f4f8` claro / `#0b1120` escuro) | **preservado** (§4) |
| `apple-touch-icon` | **existia** — injetado por `injectFavicons` em todas as telas | reaproveitado |
| favicons (SVG + ICO) | **existiam** — refeitos na Fase 3.4 | reaproveitados |
| meta viewport | **existia** nas 220 telas | + `viewport-fit=cover` no shell |
| `display: standalone` | não existia | no manifest |
| mecanismo de instalação | não existia | nenhum custom — o navegador já oferece (§9) |
| cache/offline | **não existia** | allowlist mínima (§5) |

O único "manifest" que aparecia na busca era `public/fiscal/manifestador.html` — manifestação de NF-e, outra coisa.

---

## 2. Arquivos criados e alterados

**Criados** (6):

| Arquivo | O quê |
|---|---|
| `public/auth/manifest.webmanifest` | o manifest |
| `public/auth/sw.js` | service worker |
| `public/auth/pwa.js` | registro |
| `public/auth/icone-maskable.svg` | variante do símbolo para recorte do Android |
| `public/auth/icone-{192,512}.png` | ícones `purpose: any` |
| `public/auth/icone-maskable-{192,512}.png` | ícones `purpose: maskable` |
| `scripts/test-pwa.js` | 24 testes |

**Alterados** (4):

| Arquivo | O quê |
|---|---|
| `public/auth/login.html` | `<link rel="manifest">` + `<script src="/pwa.js">` |
| `public/app.html` | idem + `viewport-fit=cover` + `100dvh` (§8) |
| `scripts/verify.js` | passo 10 |

**Por que tudo em `public/auth/`:** é o único diretório servido na **raiz da URL e antes da barreira de autenticação** (`base-middleware.js:41`). Manifest e service worker em `public/js/` receberiam **302 para o login** e a instalação nunca seria oferecida. O teste F2 trava isso.

---

## 3. Manifest final

```json
{
  "id": "/",
  "name": "Licite Agora ERP",
  "short_name": "Licite Agora",
  "description": "Licitações, compras e gestão em um só lugar.",
  "lang": "pt-BR",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "theme_color": "#2563EB",
  "background_color": "#0b1120",
  "icons": [ 192 any · 512 any · 192 maskable · 512 maskable · favicon.svg ],
  "shortcuts": [ { "name": "Venda rápida", "url": "/comercial/pedidos-pdv.html" } ]
}
```

Servido como `application/manifest+json`, confirmado por HTTP.

### As decisões

**`start_url: "/"`** — e não uma tela interna. `/` responde **302 para `/login.html`** sem sessão, verificado. O app instalado sempre entra pela porta autenticada.

**`theme_color: #2563EB`** — o azul da marca, como você pediu. Vale saber o que ele faz: pinta a **splash** e a barra de status **antes de o JS rodar**. Assim que a página carrega, o `theme-boot.js` sobrescreve com a cor do tema do usuário. As duas coisas convivem de propósito: a splash tem a cor da marca, o app tem a cor do tema.

**`background_color: #0b1120`** — o `--bg-0` do app, **não** o azul. Se fosse o mesmo `#2563EB`, o ícone azul sumiria no fundo azul da splash. O teste A5 reprova se alguém igualar os dois.

**Sem `orientation`** — o balcão usa retrato e paisagem. O teste A6 reprova se travarem.

---

## 4. Ícones

Reutilizam o símbolo da Fase 3.4. **A marca não foi redesenhada.**

Precisou de uma variante: o Android **recorta o ícone na forma do lançador** (círculo, squircle, losango) e só garante um círculo central de 80%. Renderizar o favicon direto deixava duas coisas erradas — os cantos arredondados do SVG viravam "orelhas" brancas, e as pontas do "L" e do "A" eram cortadas.

`icone-maskable.svg` corrige as duas: fundo quadrado cheio (o sistema arredonda) e símbolo a ~59% do lado. Verificado por simulação do recorte circular: o desenho sobrevive inteiro.

Os quatro PNGs foram renderizados no Chrome, e o teste A4 confere que o tamanho do arquivo bate com o declarado no manifest.

---

## 5. Service worker e política de cache

### A política, em uma frase

**Allowlist fechada de 7 arquivos estáticos públicos. Todo o resto passa como se o service worker não existisse.**

```js
if (!ESTATICOS.includes(url.pathname)) return;   // nem chama respondWith
```

Os 7: `favicon.svg`, `apple-touch-icon.png`, os quatro `icone-*.png` e o próprio `manifest.webmanifest`. Todos públicos, todos iguais para qualquer usuário de qualquer tenant.

### Por que allowlist e não exclusão

Uma lista de exclusão — *"não cacheie `/api/`"* — é o desenho errado, e o motivo é o futuro: no dia em que alguém criar `/relatorios/`, `/export/` ou `/download/`, o SW passaria a cachear **sem ninguém decidir**. A allowlist erra para o lado seguro: o que não foi escrito não é tocado.

O teste **C4** existe só para isso: pede ao SW quatro caminhos que não existem hoje (`/relatorios/export.csv`, `/download/cliente-123.pdf`…) e reprova se ele assumir algum.

### O que fica de fora, por consequência direta

- **`/api/*`** — nenhuma rota, nenhum método (C1 testa 14 rotas × GET e POST);
- **telas e assets autenticados** — `/app.html`, `/comercial/*`, `/js/*`, `/css/*` (C2);
- **`/`** — responde 302 ou 200 conforme a sessão; congelar isso seria servir a tela errada;
- **outra origem** — Google Fonts, CDN (C5).

E na gravação: só `status === 200`, `type === 'basic'`, sem `Set-Cookie`. Requisição que não é GET nem chega lá.

### Sem offline de dados

Não há fila, banco local nem pedido criado sem rede. Sem conexão o app abre e as telas falham como falhariam no navegador — **o comportamento honesto** enquanto não houver sincronização pensada. O teste C7 reprova `indexedDB`, `BackgroundSync`, `postMessage` e `push`.

### Multi-tenant

O cache do navegador já é separado por origem, e cada tenant é um subdomínio. Dois tenants nunca compartilham. Ainda assim, a lista só tem arquivo idêntico para todos.

---

## 6. Login e sessão

**Nada mudou.** Não há autenticação diferente para o PWA — mesma sessão, mesmo cookie, mesmo `requireAuth`.

| Situação | Comportamento |
|---|---|
| app aberto com sessão válida | `/` → shell normalmente |
| sessão expirada | `/` → **302 `/login.html`** (verificado por HTTP) |
| após login | `window.location.href = '/'` → shell. **Sem loop**: o SW não intercepta `/` nem `/login.html`, então nenhuma resposta de redirecionamento fica congelada |
| dentro do iframe | `login.html` já tem `if (window.top !== window.self) window.top.location = ...` — sai do frame e loga a aba inteira |

O risco clássico de PWA — *service worker servindo uma resposta de login antiga e criando loop* — **não existe aqui**, porque nenhum dos dois caminhos está na allowlist.

---

## 7. RBAC

**Intacto.** O PWA não toca em `perfis-acesso.js`.

O ponto que exigiu cuidado foi o **shortcut**. Ele aponta para `/comercial/pedidos-pdv.html`, e é só um link — quem protege continua sendo o servidor:

| Quem clica no shortcut | O que acontece |
|---|---|
| sem sessão | `requireAuth` → `/login.html` |
| com sessão, **sem** `pedidos-pdv` | `podeVerPath` **bloqueia** — a página é registrada no menu (checagem nominal, Fase 3.6) |
| com sessão **e** a permissão | abre normalmente |

O teste **B2** verifica as duas condições que sustentam isso: `pedidos-pdv` continua no `menu-config` (senão cairia no fallback por diretório) e `/comercial/` **não** está em `DIRS_ABERTOS`.

---

## 8. Um problema mobile encontrado e corrigido

Você pediu para verificar `100vh` vs `100dvh`. Havia um caso real, e ele **não era onde parecia**.

Na Venda rápida, `.pdv-main { height: 100vh }` é inofensivo: a tela roda **dentro do iframe** do shell (`shellRedirect`), e ali `100vh` é a altura do iframe — não existe barra de endereço dentro de um frame.

O problema estava no **shell**, que é o documento de fora: `html, body { height: 100% }`. No navegador do celular a barra de endereço aparece e some ao rolar, a altura do viewport muda, e o rodapé do conteúdo cai para fora da tela.

```css
html, body { height: 100%; }      /* fallback */
html, body { height: 100dvh; }    /* acompanha a barra de endereço */
```

No app **instalado** não há barra de endereço e as duas dão no mesmo — a correção é para quem usa pelo navegador, que é como todo mundo começa.

### Medições nas larguras pedidas

| Largura | Cabeçalho | Corpo | Rolagem horizontal |
|---|---|---|---|
| 360px | 145px | ok | **nenhuma** (`scrollW = 360`) |
| 390px | 145px | ok | **nenhuma** |
| 430px | 105px | ok | **nenhuma** |
| 820px (tablet) | 62px | ok | **nenhuma** |

Os 12 elementos que aparecem "fora da tela" em todas as larguras são a **gaveta do pedido** (`.pdv-pedido` com `translateX(100%)`) e seus filhos — deslocados de propósito desde a Fase 2.2, não é defeito.

Safe area e toque já estavam resolvidos: a Venda rápida tem `viewport-fit=cover`, `env(safe-area-inset-bottom)` na barra do carrinho e `@media (pointer: coarse)`. O shell ganhou o `viewport-fit=cover` que faltava.

---

## 9. Instalação

### Android / Chrome

O navegador oferece sozinho — manifest válido + service worker no escopo + HTTPS. Aparece como "Instalar aplicativo" no menu, ou como banner.

Instalado: ícone maskable recortado na forma do lançador, splash com fundo `#0b1120` e barra `#2563EB`, abre em `standalone` (sem barra de endereço). **Segurar o ícone mostra o atalho "Venda rápida".**

### iOS / iPadOS / Safari

O iOS **não oferece instalação automática** — é preciso *Compartilhar → Adicionar à Tela de Início*. Não é limitação nossa; a Apple não implementa `beforeinstallprompt`.

O que funciona: o `apple-touch-icon` já existia e é usado como ícone; `display: standalone` é respeitado; a marca aparece.

O que **não** funciona no iOS, e é bom saber: `shortcuts` do manifest são ignorados (não há atalho de "Venda rápida" ao segurar o ícone), e o Safari limpa o cache do service worker após ~7 dias sem uso — irrelevante aqui, já que só guardamos ícones.

### Nenhum botão de instalação custom

O navegador já oferece, e um convite próprio feito antes de saber se faz falta é interface a mais para manter. O teste D3 reprova se aparecer `beforeinstallprompt`.

---

## 10. Testes

`scripts/test-pwa.js` — **24 testes, 24 OK**, ligados ao `verify` como passo 10.

| Bloco | Cobre |
|---|---|
| A (6) | manifest instalável · `start_url` passa pelo login · ícones nos dois propósitos · **arquivo bate com o declarado** · cores · orientação livre |
| B (2) | shortcut aponta para a tela real · **não contorna login nem RBAC** |
| C (7) | **`/api/` nunca interceptado** · telas autenticadas fora · allowlist exata · **allowlist ≠ exclusão** · outra origem · só 200/basic/sem-cookie · sem offline |
| D (3) | as duas portas registram · falha não derruba a página · sem banner custom |
| E (3) | `viewport-fit` no shell · safe-area e toque na Venda rápida · theme-color dinâmico preservado |
| F (3) | nada paralelo criado · arquivos públicos · escopo na raiz |

### O bloco C executa o service worker

Não lê o arquivo procurando a palavra "api": carrega o `sw.js` num escopo simulado, dispara o handler de `fetch` com URLs reais e verifica se ele chamou `respondWith` — o único momento em que o SW assume a resposta.

### Provado no Chrome real

Registrei o service worker num Chrome headless e li o cache de verdade:

```
registros: 1 · escopo: "/" · estado: "activated"
caches: ["licite-v1"]
cacheado: /apple-touch-icon.png /favicon.svg /icone-192.png /icone-512.png
          /icone-maskable-192.png /icone-maskable-512.png /manifest.webmanifest
```

Depois disparei requisições a `/api/usuarios/me`, `/api/pedidos`, `/api/pessoas`, `/app.html`, `/comercial/pedidos-pdv.html`, `/js/sidebar.js`, `/css/app-modern.css` e `/`, com `credentials: 'include'`:

> **cache antes: 7 itens · cache depois: 7 itens · nada sensível.**

### Provado por sabotagem

| Sabotagem | Reprovou em |
|---|---|
| trocar allowlist por exclusão (`if (pathname.startsWith('/api/')) return`) | **C2** (*"o SW assumiu /"*), **C4** |
| `start_url` apontando para tela interna | **A2** |

### Regressão — zero falhas

`npm run verify` (3,0s) e 16 suítes: `test-pwa` 24 · `test-venda-rapida-nav` 15 · `test-menu-oculto-rbac` 15 · `test-pdv-rbac` 11 · `test-pdv-fluxo` 29 · `test-pdv-visual` 32 · `test-sidebar-botoes` 23 · `test-fase321-ux` 20 · `test-shell-boot` 24 · `test-tema-global` 21 · `test-fase33-topbar` 40 · `test-fase34-identidade` 26 · `test-fase1-funcional` 57 · `test-app-backend` 79 · `test-alcadas` 41 · `test-governanca-percentual` 29.

---

## 11. Limitações atuais

| Limitação | Detalhe |
|---|---|
| **Sem offline** | sem rede, o app abre e as telas falham. Foi decisão desta fase |
| **Exige HTTPS** | o SW não registra em HTTP. Produção é HTTPS; em desenvolvimento local, só via `localhost` |
| **iOS não oferece instalar** | é manual (Compartilhar → Adicionar à Tela de Início) — limitação da Apple |
| **iOS ignora `shortcuts`** | o atalho "Venda rápida" só existe no Android |
| **Cabeçalho de 145px em 360px** | a Venda rápida quebra em três linhas nos aparelhos mais estreitos. Funciona, mas come altura |
| **Não testei em aparelho real** | ver a ressalva abaixo |
| **Sem Lighthouse** | não está instalado e `npm install` é negado nesta árvore. Os critérios de instalabilidade foram verificados um a um (manifest válido e servido com o MIME certo, ícones 192/512, `display`, `start_url` no escopo, SW ativo no escopo `/`) |

---

## 12. Próximos passos possíveis

| # | Passo | Quando faria sentido |
|---|---|---|
| 1 | Compactar o cabeçalho da Venda rápida abaixo de 400px | se o uso em celular estreito incomodar |
| 2 | Página de "sem conexão" | hoje o erro é o do navegador |
| 3 | Botão de instalação próprio (`beforeinstallprompt`) | se os vendedores não acharem o convite do navegador |
| 4 | Instruções de instalação no iOS, dentro do app | o iOS não convida sozinho |
| 5 | Cache de shell para abrir mais rápido | exige decidir invalidação; hoje o ganho seria pequeno |
| 6 | Fila offline de pedidos | **fase própria** — mexe em conflito, numeração e estoque |

Nada disso foi feito, e nada de React Native, Capacitor, push, biometria, código de barras nativo ou impressão Bluetooth — conforme a instrução.

---

## GO / STOP

**GO** para o que está no ar: tudo estático, já servido e confirmado por HTTP. Nenhum restart necessário — nenhum `.js` de servidor foi tocado.

**STOP** aqui, como pedido.

**Não foi feito:** migration, alteração de tenant, faturamento, emissão fiscal, SEFAZ, cobrança, alteração de perfis, restart, commit, reset/stash/clean.

### A ressalva honesta

Validei em **Chrome headless**: o service worker registrou de verdade, o cache foi lido de verdade, e as larguras foram medidas de verdade. Mas **não instalei o app num celular Android nem num iPhone**. O que afirmo sobre o comportamento instalado — splash, recorte do ícone, atalho ao segurar — vem da especificação e do que o manifest declara, não de observação em aparelho.

É o que falta para esta fase fechar: instalar em um Android e em um iPhone e confirmar ícone, splash, entrada pelo login e a Venda rápida em uso.
