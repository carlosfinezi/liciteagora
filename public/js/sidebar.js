/* Sidebar Unificado - Licite Agora */
/* Menu é gerado dinamicamente a partir de menu-config.js */

// ===== Shell SPA (app.html) =====
// O menu vive UMA vez no shell (app.html) e as páginas carregam num <iframe>.
// - Página dentro do shell: não renderiza sidebar; só reporta ao pai (IN_SHELL).
// - Página aberta top-level (bookmark/URL antiga): redireciona pra dentro do shell.
// - Página framed por um pai que NÃO é o shell: comportamento antigo, intacto.
//   (O exemplo daqui era o proposta-template.html, apagado em 30/09/2026: o
//   `</script>` num comentário dele fechava o bloco e a tela não desenhava
//   nada desde maio, e nenhum editor a abria.)
const IN_SHELL = (() => {
    try { return window.self !== window.top && window.parent.__liciteShell === true; }
    catch { return false; } // pai cross-origin
})();

(function shellRedirect() {
    if (typeof window === 'undefined') return;
    if (window.__liciteShell) return;           // o próprio shell carrega este arquivo
    if (window.self !== window.top) return;     // framed (shell ou não): nunca redireciona
    // Top-level fora do shell → entra no shell preservando path, query e hash interno
    location.replace('/app.html#' + location.pathname + location.search + location.hash);
})();

// Injeta favicons da marca (SVG + apple-touch) em qualquer página que carregue o sidebar.
// O /favicon.ico é auto-requisitado pelo browser e não precisa de tag.
(function injectFavicons() {
    if (typeof document === 'undefined') return;
    const head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;
    if (!head.querySelector('link[rel="icon"][type="image/svg+xml"]')) {
        const svg = document.createElement('link');
        svg.rel = 'icon';
        svg.type = 'image/svg+xml';
        svg.href = '/favicon.svg';
        head.appendChild(svg);
    }
    if (!head.querySelector('link[rel="apple-touch-icon"]')) {
        const apple = document.createElement('link');
        apple.rel = 'apple-touch-icon';
        apple.href = '/apple-touch-icon.png';
        head.appendChild(apple);
    }
})();

// ===== Tema do sistema (fundo/paleta) =====
// Preferência salva POR USUÁRIO no servidor (users.tema, /api/user/prefs).
// localStorage ('appTheme') é só cache pra aplicar sem flash antes do fetch.
// Roda em toda página E no shell; troca propaga aos outros frames/abas pelo
// evento 'storage'. Valores: 'padrao' (escuro slate/navy do CSS) ou
// 'custom:#fundo:#destaque' (paleta derivada das duas cores do usuário).
const TEMA_FUNDO_PADRAO = '#0f172a';
const TEMA_DESTAQUE_PADRAO = '#3b82f6';
// Tema personalizado: 'custom:#<fundo>:#<destaque>' — a paleta inteira é
// derivada das duas cores e aplicada como CSS vars inline no <html>.
const CUSTOM_TEMA_RE = /^custom:(#[0-9a-fA-F]{6}):(#[0-9a-fA-F]{6})$/;
const CUSTOM_VARS = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-hover', '--bg-input',
    '--border', '--border-strong', '--text-0', '--text-1', '--text-2', '--text-3',
    '--accent', '--accent-strong', '--accent-soft', '--success', '--success-soft',
    '--warn', '--warn-soft', '--danger', '--danger-soft', '--purple', '--purple-soft'];
function mixHex(hex, alvo, p) {
    const h = (s, i) => parseInt(s.slice(i, i + 2), 16);
    return '#' + [1, 3, 5].map((i) =>
        Math.round(h(hex, i) + (h(alvo, i) - h(hex, i)) * p).toString(16).padStart(2, '0')).join('');
}
function lumHex(hex) {
    const h = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return 0.2126 * h(1) + 0.7152 * h(3) + 0.0722 * h(5);
}
function paletaCustom(bg, accent) {
    const P = {};
    if (lumHex(bg) >= 0.5) { // fundo claro → textos escuros, tons puxados pro branco
        P['--bg-0'] = bg;
        P['--bg-1'] = P['--bg-2'] = mixHex(bg, '#ffffff', 0.7);
        P['--bg-3'] = P['--bg-hover'] = mixHex(bg, '#000000', 0.06);
        P['--bg-input'] = mixHex(bg, '#ffffff', 0.8);
        P['--border'] = mixHex(bg, '#000000', 0.18);
        P['--border-strong'] = mixHex(bg, '#000000', 0.34);
        P['--text-0'] = '#0f172a'; P['--text-1'] = '#1e293b'; P['--text-2'] = '#475569'; P['--text-3'] = '#64748b';
        P['--accent'] = accent; P['--accent-strong'] = mixHex(accent, '#000000', 0.12); P['--accent-soft'] = accent + '26';
        P['--success'] = '#059669'; P['--success-soft'] = '#d1fae5';
        P['--warn'] = '#b45309'; P['--warn-soft'] = '#fef3c7';
        P['--danger'] = '#dc2626'; P['--danger-soft'] = '#fee2e2';
        P['--purple'] = '#7c3aed'; P['--purple-soft'] = '#ede9fe';
    } else { // fundo escuro → textos padrão claros, tons derivados do fundo
        P['--bg-0'] = mixHex(bg, '#000000', 0.25);
        P['--bg-1'] = bg;
        P['--bg-2'] = mixHex(bg, '#ffffff', 0.03);
        P['--bg-3'] = mixHex(bg, '#ffffff', 0.10);
        P['--bg-hover'] = mixHex(bg, '#ffffff', 0.14);
        P['--bg-input'] = mixHex(bg, '#000000', 0.15);
        P['--border'] = mixHex(bg, '#ffffff', 0.10);
        P['--border-strong'] = mixHex(bg, '#ffffff', 0.22);
        P['--accent'] = mixHex(accent, '#ffffff', 0.18);
        P['--accent-strong'] = accent;
        P['--accent-soft'] = accent + '40';
    }
    return P;
}
/**
 * Claro ou escuro, a partir de qualquer valor gravado em `users.tema`.
 *
 * A mesma decisão vive em `theme-boot.js` — lá em versão mínima, porque aquele
 * arquivo roda antes do primeiro paint e não pode crescer. Os dois precisam
 * concordar, senão a página nasce num tema e troca para o outro logo depois.
 */
function baseDoTema(tema) {
    const v = String(tema || '').trim();
    if (v === 'claro') return 'claro';
    if (v === 'escuro' || v === 'padrao' || v === '') return 'escuro';
    const m = CUSTOM_TEMA_RE.exec(v);
    if (m) return lumHex(m[1]) >= 0.5 ? 'claro' : 'escuro';
    return 'escuro';
}

/**
 * Aplica o tema no documento.
 *
 * Dois caminhos, e os dois continuam valendo:
 *   - 'claro' / 'escuro'  → só o atributo `data-theme`; a paleta inteira vem do
 *     CSS. Nenhuma variável inline, nada calculado em JavaScript.
 *   - 'custom:#bg:#accent' → o caminho LEGADO, preservado. Cinco usuários reais
 *     têm um salvo (relatório 24); apagá-lo mudaria a cara do sistema deles sem
 *     aviso. Continua derivando a paleta e gravando as vars inline — e ainda
 *     assim marca `data-theme`, para as regras que dependem da base acertarem.
 */
function aplicarTema(tema) {
    // Mesma regra do botão: preferência estranha vira tema padrão, nunca um
    // erro que interrompe o resto do arquivo (relatório 25).
    try {
        const st = document.documentElement.style;
        CUSTOM_VARS.forEach((v) => st.removeProperty(v));
        document.documentElement.setAttribute('data-theme', baseDoTema(tema));
        const m = CUSTOM_TEMA_RE.exec(tema || '');
        if (!m) return;                   // claro/escuro: a paleta é do CSS
        const pal = paletaCustom(m[1], m[2]);
        Object.keys(pal).forEach((k) => st.setProperty(k, pal[k]));
    } catch (e) {
        console.warn('[tema] preferência não aplicada, seguindo no padrão:', e && e.message);
        try { document.documentElement.setAttribute('data-theme', 'escuro'); } catch (_) {}
    }
}
function cacheTema(tema) {
    try { localStorage.setItem('appTheme', tema || 'padrao'); } catch (_) {}
}

/* ==========================================================================
   TOPBAR GLOBAL — Fase 3.3
   ==========================================================================

   Uma barra, montada UMA vez, no shell. Não foi escrita nas 213 telas, e não
   precisa ser: `shellRedirect()` (no topo deste arquivo) manda toda página
   top-level do ERP para dentro de `/app.html`, então o que existe no shell
   existe em todas elas. Quem edita uma tela nova não precisa lembrar da topbar.

   ── O que ela substitui ─────────────────────────────────────────────────────

   O botão de tema, que desde a Fase 2.3 flutuava (`position: fixed`) sobre o
   conteúdo. Flutuar cobre coisa: cobriu o cabeçalho do Pedidos PDV (relatório
   25) e depois os botões Salvar/Ações do Pedido (relatório 29), cada caso
   pedindo uma reserva de `padding-right` própria na tela afetada. A topbar
   ocupa espaço — o iframe começa abaixo dela — e as três reservas saíram.

   ── O que NÃO entra ─────────────────────────────────────────────────────────

   Nada de sino de notificações, "?" de ajuda ou atalhos: este ERP não tem
   central de notificações nem destino de suporte. Um controle que não leva a
   lugar nenhum é pior que a sua ausência.

   ── Onde ela NÃO aparece ────────────────────────────────────────────────────

   Dentro do iframe. Lá quem manda é a janela de fora, que já tem a sua — duas
   barras seriam dois controles para a mesma coisa. É a mesma guarda `IN_SHELL`
   que o botão de tema já usava.
*/
function iconeTema(base) { return base === 'claro' ? '🌙' : '☀️'; }

/**
 * ⚠️ NADA AQUI PODE DERRUBAR O SHELL.
 *
 * Em 2026-09-11 o ERP inteiro ficou numa tela vazia porque `sidebar.js` deixou
 * de parsear (relatório 25). A causa foi outra — uma crase dentro de um
 * comentário, que fecha a template literal —, mas a lição vale para este
 * caminho: o tema é acessório e o menu é essencial. Se o botão não puder ser
 * criado, o shell continua; o pior que acontece é a pessoa ficar sem o atalho.
 */
function montarTopbar() {
    try {
        if (typeof document === 'undefined' || IN_SHELL) return;
        if (!document.body || document.getElementById('topbar')) return;

        const base = document.documentElement.getAttribute('data-theme') || 'escuro';
        const bar = document.createElement('header');
        bar.id = 'topbar';
        bar.className = 'topbar';
        bar.setAttribute('role', 'banner');
        bar.innerHTML =
            '<div class="tb-esq" id="tbEmpresa"></div>' +
            '<div class="tb-dir">' +
              '<button type="button" id="btnTema" class="tb-btn" title="Alternar tema" aria-label="Alternar tema"></button>' +
              '<div class="tb-conta">' +
                // O aria-label nasce genérico e vira "Conta de <nome>" quando
                // `carregarIdentidade` responde: se a API demorar ou falhar, o
                // botão ainda tem nome para o leitor de tela.
                '<button type="button" id="btnConta" class="tb-btn tb-conta-btn" ' +
                        'aria-haspopup="menu" aria-expanded="false" aria-label="Conta do usuário">' +
                  '<span class="tb-avatar" id="tbAvatar" aria-hidden="true"></span>' +
                  '<span class="tb-usuario" id="tbUsuario"></span>' +
                  '<span class="tb-chevron" aria-hidden="true">&#9662;</span>' +
                '</button>' +
                '<div class="tb-menu" id="tbMenu" role="menu" aria-labelledby="btnConta"></div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(bar);

        // textContent, e não no innerHTML acima: o ícone é um emoji e não tem
        // por que passar pelo parser de HTML.
        document.getElementById('btnTema').textContent = iconeTema(base);
        document.getElementById('btnTema').onclick = alternarTema;
        document.getElementById('btnConta').onclick = alternarMenuConta;
        ligarFechamentoDoMenuConta();
        carregarIdentidade();
        // O conteúdo do menu de conta é montado na PRIMEIRA abertura, não aqui
        // — ver `montarMenuConta`.
    } catch (e) {
        // A topbar é acessória; o menu é essencial. Se ela não puder ser
        // montada, o ERP continua — o pior que acontece é a pessoa ficar sem
        // o atalho de tema e de conta.
        console.warn('[topbar] não pôde ser montada (o ERP segue normal):', e && e.message);
    }
}

/**
 * Ações da conta.
 *
 * São as MESMAS duas do antigo grupo "Conta" da sidebar, chamando as mesmas
 * funções (`abrirModalSenha`, `fazerLogout`) — o grupo saiu do menu lateral
 * para não existirem dois "Sair" na tela. Não há ação nova aqui: só mudou o
 * lugar onde se procura por elas.
 *
 * ⚠️ CHAMADA NA PRIMEIRA ABERTURA DO MENU, NUNCA NA MONTAGEM DA TOPBAR.
 *
 * A topbar nasce no IIFE `initTema`, que roda no meio deste arquivo — e
 * `renderIcon` lê `EMOJI_TO_LUCIDE`, um `const` declarado mais ABAIXO. Chamar
 * daqui de cima cai na zona morta temporal: `ReferenceError`, engolido pelo
 * `try` de `montarTopbar`, e o menu ficaria VAZIO em produção. Com o grupo
 * Conta já fora da sidebar, isso deixaria a pessoa sem como sair do sistema —
 * um aviso no console e nada mais.
 *
 * Adiar até a abertura resolve pela raiz: nesse momento o arquivo terminou de
 * carregar e toda declaração existe. Ainda economiza trabalho no boot.
 */
function montarMenuConta() {
    const m = document.getElementById('tbMenu');
    if (!m) return;
    m.innerHTML =
        '<button type="button" class="tb-menu-item" role="menuitem" data-acao="senha">' +
          '<span class="ic">' + renderIcon('🔑') + '</span>Alterar Senha</button>' +
        '<button type="button" class="tb-menu-item" role="menuitem" data-acao="sair">' +
          '<span class="ic">' + renderIcon('🚪') + '</span>Sair</button>';
    m.querySelector('[data-acao="senha"]').onclick = () => { fecharMenuConta(); abrirModalSenha(); };
    m.querySelector('[data-acao="sair"]').onclick  = () => { fecharMenuConta(); fazerLogout(); };
}

function alternarMenuConta(e) {
    if (e) e.stopPropagation();   // senão o handler de documento fecha no mesmo clique
    const m = document.getElementById('tbMenu');
    const b = document.getElementById('btnConta');
    if (!m || !b) return;
    const abrir = !m.classList.contains('aberto');
    if (abrir && !m.querySelector('.tb-menu-item')) montarMenuConta();   // ver a nota lá
    m.classList.toggle('aberto', abrir);
    b.setAttribute('aria-expanded', String(abrir));
    if (abrir) {
        const primeiro = m.querySelector('.tb-menu-item');
        if (primeiro) primeiro.focus({ preventScroll: true });
    }
}

function fecharMenuConta(devolverFoco) {
    const m = document.getElementById('tbMenu');
    const b = document.getElementById('btnConta');
    if (!m || !m.classList.contains('aberto')) return;
    m.classList.remove('aberto');
    if (b) {
        b.setAttribute('aria-expanded', 'false');
        if (devolverFoco) b.focus({ preventScroll: true });
    }
}

// Dois listeners de documento, registrados UMA vez com a topbar. Não há
// polling, timer nem observer: o menu só reage a clique e a tecla.
function ligarFechamentoDoMenuConta() {
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.tb-conta')) fecharMenuConta();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') fecharMenuConta(true);
    });
}

/**
 * Nome do usuário e da empresa — só o que EXISTE de verdade.
 *
 * ── Usuário ─────────────────────────────────────────────────────────────────
 *
 * `/api/usuarios/me`, rota que já existe e está em LIBERADOS no
 * `perfis-api-map` (passa para qualquer perfil). É a ÚNICA requisição nova
 * desta fase, feita uma vez na montagem: nenhuma das que o shell já faz
 * (`/api/user/prefs`, `/api/features/status`, `/api/perfis/meu-acesso`) devolve
 * o nome da pessoa.
 *
 * Cai para `username` quando `nome` está vazio. Medido em 2026-09-11: 32 dos 33
 * usuários ativos têm `nome`; o restante é coberto pelo `username`, que nunca
 * falta por ser a chave de login.
 *
 * ── Empresa ─────────────────────────────────────────────────────────────────
 *
 * Nenhuma requisição: o nome é publicado por `carregarEstabSwitcher`, que já
 * consulta `/api/estabelecimentos` em todo carregamento do menu.
 *
 * ⚠️ E ele é ESPARSO no acervo real — medido no mesmo dia, só 4 dos 13 tenants
 * de cliente têm `nomeFantasia` ou `razaoSocial` preenchidos. Nos outros 9 o
 * campo fica VAZIO, de propósito: escrever "Empresa" ou o slug do tenant seria
 * inventar identidade que ninguém cadastrou.
 */
function carregarIdentidade() {
    /* Empresa na topbar — duas fontes, nesta ordem:
     *
     *   1. `carregarEstabSwitcher` publica o nome do estabelecimento, quando
     *      cadastrado (medido em 2026-09-11: 4 dos 13 tenants têm);
     *   2. se não houver, `/api/tenant-atual` dá o nome do TENANT.
     *
     * A segunda fonte entrou na auditoria de isolamento (relatório 41): em 9
     * dos 13 tenants a topbar ficava sem identificação nenhuma, e não havia
     * como o usuário saber de qual empresa era a sessão aberta. O nome do
     * tenant vem do `control.db`, resolvido pelo Host no servidor — nunca de
     * parâmetro do navegador.
     *
     * A ordem importa: quem cadastrou a empresa vê a razão social dela, que é
     * mais precisa que o slug da assinatura.
     */
    fetch('/api/tenant-atual').then((r) => (r.ok ? r.json() : null)).then((d) => {
        const t = d && d.success && d.tenant;
        if (!t) return;
        const el = document.getElementById('tbEmpresa');
        // Só preenche se o estabelecimento ainda não tiver respondido.
        if (el && !el.textContent.trim()) {
            el.textContent = t.nome;
            el.title = t.nome + '  ·  ' + t.slug;
        }
    }).catch(() => {});

    fetch('/api/usuarios/me').then((r) => (r.ok ? r.json() : null)).then((d) => {
        const u = d && d.success && d.usuario;
        if (!u) return;
        const nome = String(u.nome || u.username || '').trim();
        if (!nome) return;
        const el = document.getElementById('tbUsuario');
        const av = document.getElementById('tbAvatar');
        if (el) el.textContent = nome;
        if (av) av.textContent = nome.charAt(0).toUpperCase();
        const b = document.getElementById('btnConta');
        if (b) b.setAttribute('aria-label', 'Conta de ' + nome);
    }).catch(() => { /* silencioso: a barra funciona sem o nome */ });
}

// Chamada por `carregarEstabSwitcher`, que já tem o dado em mãos.
function publicarEmpresaNaTopbar(nome) {
    const el = document.getElementById('tbEmpresa');
    if (!el) return;                             // fora do shell não há topbar
    const limpo = String(nome || '').trim();
    if (!limpo) return;                          // sem dado real: fica vazio
    el.textContent = limpo;
    el.title = limpo;                            // razão social longa é truncada no CSS
}

/**
 * Alterna e persiste. Reaproveita `escolherTema`, que já grava no localStorage,
 * propaga para os iframes e salva em `users.tema` pelo `/api/user/prefs` — a
 * mesma infraestrutura do seletor de cores antigo, sem rota nova.
 *
 * Quem estiver num tema `custom:` LEGADO passa a claro/escuro explícito ao
 * clicar: é o momento natural de migrar, escolhido pela pessoa, e não uma
 * conversão em massa por trás dela.
 */
function alternarTema() {
    const atual = document.documentElement.getAttribute('data-theme') || 'escuro';
    const novo = atual === 'claro' ? 'escuro' : 'claro';
    escolherTema(novo);
    const b = document.getElementById('btnTema');
    if (b) b.textContent = iconeTema(novo);
}

/* ==========================================================================
   Sidebar compacta.
   ==========================================================================
   Só a LARGURA muda: os mesmos itens, o mesmo RBAC, a mesma navegação. Não há
   segunda sidebar nem menu alternativo.

   Quem liga: o Pedidos PDV, ao entrar (`PAGINAS_COMPACTAS`). Naquela tela a
   largura é área de venda — o menu textual custa 186px que ninguém lê enquanto
   atende no balcão. Ao sair para outra tela, volta ao que a pessoa tinha antes.

   A escolha manual (o botão no topo da barra) vence a automática e fica gravada
   em `localStorage.sidebarCompacta` — quem prefere compacto em tudo, ou prefere
   o menu inteiro mesmo no PDV, manda no próprio ERP.
*/
const LS_COMPACTA = 'sidebarCompacta';
const PAGINAS_COMPACTAS = ['pedidos-pdv'];

function sidebarCompactaPreferida() {
    try { return localStorage.getItem(LS_COMPACTA); } catch (_) { return null; }
}

/** Aplica o estado. `persistir=false` é o modo automático do PDV, que não grava. */
function aplicarSidebarCompacta(compacta, persistir) {
    try {
        const el = document.documentElement;
        if (compacta) el.setAttribute('data-sidebar', 'compacta');
        else el.removeAttribute('data-sidebar');
        if (persistir) { try { localStorage.setItem(LS_COMPACTA, compacta ? '1' : '0'); } catch (_) {} }
        const b = document.getElementById('btnSidebarToggle');
        if (b) {
            b.textContent = compacta ? '»' : '«';
            b.title = compacta ? 'Expandir menu' : 'Recolher menu';
            b.setAttribute('aria-label', b.title);
        }
    } catch (e) {
        console.warn('[sidebar] modo compacto não aplicado:', e && e.message);
    }
}

function alternarSidebarCompacta() {
    const agora = document.documentElement.getAttribute('data-sidebar') === 'compacta';
    aplicarSidebarCompacta(!agora, true);   // escolha manual: fica gravada
    if (agora) fecharFlyout();              // ao expandir, o flyout perde sentido
}

/* ==========================================================================
   Tooltip e flyout da sidebar recolhida.
   ==========================================================================
   Com 64px de largura sobra só o ícone, e ninguém deve precisar decorar ícone
   para usar um ERP com 190 itens.

   ── Por que em elemento único no <body>, e não em ::after ───────────────────

   `.sidebar-menu` tem `overflow-y: auto`. Um tooltip desenhado como pseudo-
   elemento do item seria CORTADO na borda da barra — que é justamente onde ele
   precisa aparecer. Um elemento solto no <body>, posicionado com `fixed`, não
   tem esse problema, não depende do z-index da sidebar e nunca sai da viewport.

   ── Hover para tooltip, CLIQUE para flyout ──────────────────────────────────

   O flyout abre por clique/foco, não por hover. Hover exigiria atravessar o
   vão entre o ícone e o painel sem que ele feche — o que se resolve com timers
   e "pontes" invisíveis, e falha no primeiro movimento rápido de mouse. Clique é
   estável, funciona em telas de toque e não some sozinho enquanto se lê. É a
   escolha que a Parte 6 do pedido autoriza explicitamente.

   ── Os nomes vêm do menu, nunca daqui ───────────────────────────────────────

   Tooltip e flyout leem `data-tooltip` / `data-grupo-nome`, preenchidos por
   `gerarMenuHTML` a partir de `item.texto` e `secao.titulo` do `menu-config.js`.
   Nenhum rótulo é escrito neste arquivo: um segundo lugar com os nomes do menu
   divergiria do primeiro no dia em que alguém renomeasse um item.
*/

let _tipEl = null, _flyEl = null, _tipTimer = null;

function elTooltip() {
    if (_tipEl && document.body.contains(_tipEl)) return _tipEl;
    _tipEl = document.createElement('div');
    _tipEl.className = 'sb-tooltip';
    _tipEl.setAttribute('role', 'tooltip');
    _tipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(_tipEl);
    return _tipEl;
}

const sidebarCompacta = () => document.documentElement.getAttribute('data-sidebar') === 'compacta';

function mostrarTooltip(alvo) {
    // Só na recolhida: com a barra aberta o nome já está escrito ao lado.
    if (!sidebarCompacta()) return;
    const texto = alvo.getAttribute('data-tooltip') || (alvo.textContent || '').trim();
    if (!texto) return;
    const t = elTooltip();
    t.textContent = texto;
    t.classList.add('visivel');
    t.setAttribute('aria-hidden', 'false');

    const r = alvo.getBoundingClientRect();
    t.style.left = (r.right + 10) + 'px';                  // à direita, com folga
    // Não sair da viewport pelo rodapé nem pelo topo.
    const alt = t.offsetHeight || 28;
    let topo = r.top + r.height / 2 - alt / 2;
    topo = Math.max(8, Math.min(topo, window.innerHeight - alt - 8));
    t.style.top = topo + 'px';
}

function esconderTooltip() {
    clearTimeout(_tipTimer);
    if (!_tipEl) return;
    _tipEl.classList.remove('visivel');
    _tipEl.setAttribute('aria-hidden', 'true');
}

/* ---- flyout dos grupos ---- */

function elFlyout() {
    if (_flyEl && document.body.contains(_flyEl)) return _flyEl;
    _flyEl = document.createElement('div');
    _flyEl.className = 'sb-flyout';
    _flyEl.setAttribute('role', 'menu');
    document.body.appendChild(_flyEl);
    return _flyEl;
}

function fecharFlyout() {
    if (!_flyEl) return;
    _flyEl.classList.remove('visivel');
    _flyEl.innerHTML = '';
    const antes = document.querySelector('.menu-section-toggle[aria-expanded="true"]');
    if (antes) antes.setAttribute('aria-expanded', 'false');
}

/**
 * Abre o painel do grupo ao lado do ícone.
 *
 * Os itens são CLONADOS do próprio grupo já renderizado na sidebar — e é isso
 * que faz o RBAC valer de graça: `gerarMenuHTML` só escreve no DOM os itens que
 * `desenharMenuComAcesso` liberou. Buscar os itens em `menuConfig` traria também
 * os que a pessoa não pode ver.
 */
function abrirFlyout(cabecalho) {
    const slug = cabecalho.getAttribute('data-grupo');
    const grupo = slug && document.getElementById(slug);
    if (!grupo) return;

    const itens = [...grupo.querySelectorAll('.menu-item')];
    if (!itens.length) return;

    const f = elFlyout();
    const titulo = cabecalho.getAttribute('data-grupo-nome')
        || (cabecalho.querySelector('.menu-section-title') || {}).textContent || '';
    f.innerHTML = `<div class="sb-flyout-tit">${escaparHtml(titulo.trim())}</div>`;
    for (const it of itens) {
        const a = it.cloneNode(true);
        a.classList.remove('menu-item');
        a.className = 'sb-flyout-item' + (it.classList.contains('active') ? ' ativo' : '');
        a.setAttribute('role', 'menuitem');
        f.appendChild(a);
    }
    f.classList.add('visivel');
    cabecalho.setAttribute('aria-expanded', 'true');

    const r = cabecalho.getBoundingClientRect();
    f.style.left = (r.right + 8) + 'px';
    // Reposiciona verticalmente quando não cabe até o rodapé.
    const alt = f.offsetHeight;
    let topo = r.top;
    if (topo + alt > window.innerHeight - 8) topo = Math.max(8, window.innerHeight - alt - 8);
    f.style.top = topo + 'px';
    const primeiro = f.querySelector('.sb-flyout-item');
    if (primeiro) primeiro.focus({ preventScroll: true });
}

function escaparHtml(t) {
    const d = document.createElement('div');
    d.textContent = String(t == null ? '' : t);
    return d.innerHTML;
}

/**
 * Liga os eventos uma única vez, no documento.
 *
 * Delegação em vez de listener por item: o menu é redesenhado quando o módulo
 * muda ou o acesso é revalidado, e listeners presos aos itens antigos vazariam a
 * cada redesenho.
 */
function ligarTooltipEFlyout() {
    if (typeof document === 'undefined' || ligarTooltipEFlyout._feito) return;
    ligarTooltipEFlyout._feito = true;

    const alvoDe = (e) => e.target && e.target.closest
        ? e.target.closest('.sidebar .menu-item, .sidebar .menu-section-toggle, .sidebar .menu-section')
        : null;

    document.addEventListener('mouseover', (e) => {
        const a = alvoDe(e);
        if (!a) return;
        clearTimeout(_tipTimer);
        _tipTimer = setTimeout(() => mostrarTooltip(a), 120);   // rápido, sem piscar ao passar direto
    });
    document.addEventListener('mouseout', (e) => { if (alvoDe(e)) esconderTooltip(); });

    // Teclado: o tooltip também aparece no foco — quem navega por Tab precisa da
    // mesma informação que o mouse recebe.
    document.addEventListener('focusin', (e) => {
        const a = alvoDe(e);
        if (a) mostrarTooltip(a); else esconderTooltip();
    });
    document.addEventListener('focusout', esconderTooltip);

    // Clique no cabeçalho de grupo, com a barra recolhida, abre o flyout em vez
    // de expandir/recolher o grupo (que não teria efeito visível em 64px).
    document.addEventListener('click', (e) => {
        const cab = e.target.closest && e.target.closest('.sidebar .menu-section-toggle');
        if (cab && sidebarCompacta()) {
            e.preventDefault();
            e.stopPropagation();
            const jaAberto = cab.getAttribute('aria-expanded') === 'true';
            esconderTooltip();
            fecharFlyout();
            if (!jaAberto) abrirFlyout(cab);
            return;
        }
        // Clique fora fecha; clique num item do flyout navega e fecha.
        if (_flyEl && _flyEl.classList.contains('visivel')) {
            if (e.target.closest('.sb-flyout-item')) { setTimeout(fecharFlyout, 0); return; }
            if (!e.target.closest('.sb-flyout')) fecharFlyout();
        }
    }, true);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { fecharFlyout(); esconderTooltip(); }
    });

    // Rolar a sidebar ou a janela invalida a posição calculada.
    window.addEventListener('scroll', () => { esconderTooltip(); fecharFlyout(); }, true);
    window.addEventListener('resize', () => { esconderTooltip(); fecharFlyout(); });
}

/**
 * Decide a largura ao abrir uma página.
 *
 * Ordem: escolha manual gravada > automática da página > padrão expandido.
 * Só a manual persiste; a automática do PDV é um estado da visita, para que sair
 * do PDV devolva o menu inteiro sem a pessoa precisar reabri-lo.
 */
function ajustarSidebarPara(pageName) {
    const manual = sidebarCompactaPreferida();
    if (manual === '1') return aplicarSidebarCompacta(true, false);
    if (manual === '0') return aplicarSidebarCompacta(false, false);
    aplicarSidebarCompacta(PAGINAS_COMPACTAS.includes(pageName), false);
}

/** Mantém o ícone certo quando o tema muda em outra aba ou pelo servidor. */
function sincronizarBotaoTema() {
    const b = document.getElementById('btnTema');
    if (b) b.textContent = iconeTema(document.documentElement.getAttribute('data-theme') || 'escuro');
}
(function initTema() {
    if (typeof document === 'undefined') return;
    try { aplicarTema(localStorage.getItem('appTheme')); } catch (_) {}
    window.addEventListener('storage', (e) => {
        if (e.key === 'appTheme') { aplicarTema(e.newValue); sincronizarBotaoTema(); }
    });
    // A topbar só pode ser criada depois de existir <body>. `sidebar.js` já é
    // carregado no fim do body nas 213 telas, mas o shell o carrega antes de
    // `initShell()` — a checagem cobre os dois casos sem depender da ordem.
    if (document.body) { montarTopbar(); ligarTooltipEFlyout(); }
    else document.addEventListener('DOMContentLoaded', () => { montarTopbar(); ligarTooltipEFlyout(); });
    // Fonte da verdade: preferência do usuário logado no servidor.
    fetch('/api/user/prefs').then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d || !d.success) return;
        const tema = d.tema || 'padrao';
        cacheTema(tema);
        aplicarTema(tema);
        sincronizarBotaoTema();
        // menuModo do usuário vem na mesma resposta; se mudou, o menu já
        // desenhado está no modo errado e precisa ser refeito.
        // Só quem é dono do menu redesenha: este IIFE roda em TODO documento,
        // e dentro do shell isso montaria uma segunda sidebar no iframe.
        const modoMudou = cacheMenuModoUsuario(d.menuModo || '');
        if (modoMudou && !IN_SHELL) aplicarTrocaDeModo();
    }).catch(() => {});
})();

// Carrega estado dos grupos do localStorage
function getGruposState() {
    try {
        return JSON.parse(localStorage.getItem('sidebarGrupos') || '{}');
    } catch { return {}; }
}
function saveGruposState(state) {
    localStorage.setItem('sidebarGrupos', JSON.stringify(state));
}

// ===== Modo do menu ('unico' | 'modulos') =====
// Duas camadas: padrão do tenant (config.menu_modo, vem em /api/features/status)
// e override do usuário (users.menuModo, vem em /api/user/prefs). Vazio no
// usuário = herda o tenant. Ambos cacheados no localStorage pelo mesmo motivo
// das features: o menu é desenhado antes de qualquer fetch responder.
const MENU_MODOS_VALIDOS = ['unico', 'modulos'];
function cacheMenuModoTenant(modo) {
    const v = MENU_MODOS_VALIDOS.includes(modo) ? modo : 'unico';
    const mudou = localStorage.getItem('menuModoTenant') !== v;
    localStorage.setItem('menuModoTenant', v);
    return mudou;
}
// '' (vazio) é valor legítimo aqui: significa "herda do tenant".
function cacheMenuModoUsuario(modo) {
    const v = MENU_MODOS_VALIDOS.includes(modo) ? modo : '';
    const mudou = (localStorage.getItem('menuModoUsuario') || '') !== v;
    localStorage.setItem('menuModoUsuario', v);
    return mudou;
}
function getMenuModo() {
    try {
        const doUsuario = localStorage.getItem('menuModoUsuario') || '';
        if (MENU_MODOS_VALIDOS.includes(doUsuario)) return doUsuario;
        const doTenant = localStorage.getItem('menuModoTenant') || '';
        return MENU_MODOS_VALIDOS.includes(doTenant) ? doTenant : 'unico';
    } catch { return 'unico'; }
}

// Feature flags: cache lido sincronamente do localStorage (atualizado em
// background a cada init). Seções/itens com `feature: 'X'` em menu-config
// são ocultadas se features[X] !== true.
function getFeaturesCache() {
    try { return JSON.parse(localStorage.getItem('featuresCache') || '{}'); }
    catch { return {}; }
}
// Busca as flags e grava no cache; resolve com `true` se mudou algo.
function buscarFeatures() {
    return fetch('/api/features/status').then(r => r.ok ? r.json() : null).then(d => {
        if (!d || !d.features) return false;
        const cur = getFeaturesCache();
        const next = { ...cur, ...d.features };
        const mudou = JSON.stringify(cur) !== JSON.stringify(next);
        localStorage.setItem('featuresCache', JSON.stringify(next));
        // O modo do tenant vem na mesma resposta; trocá-lo também obriga a
        // redesenhar o menu, então entra no mesmo "mudou".
        return cacheMenuModoTenant(d.menuModo) || mudou;
    }).catch(() => false);
}
// Antes isto dava location.reload() quando a flag virava. Agora o menu é
// redesenhado — no shell, recarregar custa a página aberta no iframe.
function refreshFeaturesCache() {
    buscarFeatures().then(mudou => { if (mudou) montarMenu(paginaAtualMenu); });
}
function isFeatureEnabled(name) {
    if (!name) return true;
    return getFeaturesCache()[name] === true;
}

// Acesso por perfil (RBAC — ver perfis-acesso.js). Mesmo esquema de cache das
// features: sem isto o menu ofereceria itens que respondem 403 ao serem
// clicados. A feature flag é do tenant; isto aqui é do usuário.
function getAcessoCache() {
    try { return JSON.parse(localStorage.getItem('acessoCache') || 'null'); }
    catch { return null; }
}
// Busca o acesso e grava no cache. Resolve com `true` quando o que veio é
// diferente do que estava — aí o menu desenhado está errado e precisa ser refeito.
function buscarAcesso() {
    return fetch('/api/perfis/meu-acesso').then(r => r.ok ? r.json() : null).then(d => {
        if (!d || !d.success) return false;
        const next = { irrestrito: !!d.irrestrito, paginas: d.paginas || [] };
        const mudou = JSON.stringify(getAcessoCache()) !== JSON.stringify(next);
        localStorage.setItem('acessoCache', JSON.stringify(next));
        return mudou;
    }).catch(() => false);
}

// Revalida em segundo plano. Antes isto dava location.reload(); no shell (app.html)
// recarregar significa perder a página aberta dentro do iframe, então o menu é
// redesenhado no lugar.
function refreshAcessoCache() {
    buscarAcesso().then(mudou => { if (mudou) montarMenu(paginaAtualMenu); });
}
/**
 * Páginas que nasceram do desmembramento de outra e herdam a permissão dela.
 * Precisa ser a MESMA relação de `perfis-acesso.js` (HERDA_DE): se o menu
 * esconder o que o servidor libera, a tela existe e ninguém acha o caminho.
 */
const HERDA_DE_MENU = {
    'comunicacao-ia': 'conversas',
    'comunicacao-campanhas': 'conversas',
    'comunicacao-modelos': 'conversas',
    'comunicacao-listas': 'conversas',
    'comunicacao-canal': 'conversas',
    'comunicacao-relatorio': 'conversas',
    'comunicacao-roteiros': 'conversas',
};

function isPaginaPermitida(page) {
    const c = getAcessoCache();
    // Sem cache ainda (primeiro acesso do browser) não esconde nada: o gate do
    // servidor é quem decide de fato, aqui é só para não oferecer porta fechada.
    if (!c || c.irrestrito) return true;
    const p = c.paginas || [];
    return p.includes(page) || p.includes(HERDA_DE_MENU[page]);
}

// Carrega a biblioteca Lucide Icons (SVG premium) do CDN. Se falhar,
// o sidebar cai graciosamente para os emojis originais.
(function injectLucide() {
    if (typeof document === 'undefined') return;
    if (document.querySelector('script[data-lucide-lib]')) return;
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/lucide@0.475.0/dist/umd/lucide.min.js';
    s.async = true;
    s.setAttribute('data-lucide-lib', '1');
    s.onload = () => { try { window.lucide && window.lucide.createIcons(); } catch (_) {} };
    document.head.appendChild(s);
})();

// Mapa emoji → nome do ícone Lucide. Mantido aqui (em vez de em
// menu-config.js) para que a fonte-da-verdade dos ícones continue
// sendo os emojis nas páginas — se o Lucide falhar, o emoji aparece
// como fallback automaticamente.
const EMOJI_TO_LUCIDE = {
    '↩️': 'undo-2',       '⚙️': 'settings',    '✂️': 'scissors',
    '⬆️': 'upload',       '⭐': 'star',         '🎯': 'target',
    '🏛️': 'landmark',    '🏢': 'building-2',   '🏦': 'building',
    '🏪': 'store',        '🏭': 'factory',      '🏷️': 'tag',
    '👤': 'user',         '👥': 'users',        '👷': 'hard-hat',
    '💧': 'droplet',      '💬': 'message-square','💰': 'banknote',
    '💳': 'credit-card',  '💵': 'wallet',       '💼': 'briefcase',
    '💾': 'save',         '📃': 'file-text',    '📄': 'file',
    '📅': 'calendar',     '📈': 'trending-up',  '📊': 'bar-chart-3',
    '📋': 'clipboard-list','📑': 'files',       '📒': 'book-open',
    '📝': 'pen-tool',     '📣': 'megaphone',    '📤': 'inbox',
    '📥': 'archive-restore','📦': 'package',    '📧': 'mail',
    '📨': 'send',         '📬': 'inbox',        '📰': 'newspaper',
    '🔁': 'repeat',       '🔄': 'refresh-cw',   '🔍': 'search',
    '🔎': 'search',       '🔐': 'lock-keyhole', '🔑': 'key-round',
    '🔒': 'lock',         '🔗': 'link',         '🔢': 'hash',
    '🔧': 'wrench',       '🗂️': 'folder-kanban','🗄️': 'archive',
    '🚚': 'truck',        '🚛': 'truck',        '🚫': 'ban',
    '🛍️': 'shopping-bag','🛒': 'shopping-cart','🛠️': 'wrench',
    '🤖': 'bot',          '🧮': 'calculator',   '🧾': 'receipt',
    '📌': 'pin',          '🚪': 'log-out',      '📋': 'clipboard-list',
    '🎨': 'palette',      '🌐': 'globe',        '🛡️': 'shield',
    '📚': 'library',      '🥽': 'glasses',      '📡': 'radio-tower',
    '🏬': 'warehouse',    '🚀': 'rocket',       '⏱️': 'timer',
    '🩺': 'stethoscope',  '🔌': 'plug',         '🏆': 'trophy',
    '💊': 'pill',         '⛽': 'fuel',
    '🧩': 'puzzle',       '💲': 'badge-dollar-sign', '📉': 'trending-down',
    '🏁': 'flag',         '🖥️': 'monitor',      '🔖': 'bookmark',
    '🧱': 'brick-wall',   '⚥': 'users-round',   '🔀': 'arrow-left-right',
    '💠': 'circle-dollar-sign', '🤝': 'handshake', '🎛️': 'sliders-horizontal',
    '✍️': 'pen-line',     '⚖️': 'scale',        '🧪': 'flask-conical',
    '✨': 'sparkles',     '✉️': 'mail',         '🔔': 'bell',
    // usados em títulos de página (não aparecem no menu)
    '📍': 'map-pin',      '📞': 'phone',        '🖼️': 'image',
    '✓': 'check',         '⚡': 'zap',          '⏳': 'hourglass',
    '📁': 'folder',       '🔥': 'flame',        '🧠': 'brain',
    '✕': 'x',             '⚠️': 'alert-triangle', '⟳': 'refresh-cw',
    '⇄': 'arrow-left-right', '↩': 'undo-2',
    // usados como ícone de botão
    '←': 'arrow-left',    '→': 'arrow-right',   '◀': 'chevron-left',
    '↗': 'arrow-up-right','↳': 'corner-down-right', '↶': 'undo-2',
    '↺': 'rotate-ccw',    '↻': 'refresh-cw',    '↧': 'arrow-down-to-line',
    '↕': 'arrow-up-down', '⬆': 'upload',        '⬇': 'download',
    '⬇️': 'download',     '▶': 'play',          '⏸': 'pause',
    '⏸️': 'pause',        '➕': 'plus',          '✅': 'circle-check',
    '✔': 'check',         '✖': 'x',             '✗': 'x',
    '☰': 'menu',          '⚙': 'settings',      '♻️': 'recycle',
    '✏️': 'pencil',       '🗑': 'trash-2',       '🗑️': 'trash-2',
    '🖨️': 'printer',      '📱': 'smartphone',   '📎': 'paperclip',
    '👁': 'eye',          '👁️': 'eye',          '👓': 'glasses',
};

// Os títulos das páginas trazem o ícone como emoji no HTML, enquanto o menu
// renderiza Lucide. Converter aqui deixa a tela inteira na mesma linguagem
// visual sem precisar reescrever o emoji em cada uma das ~280 páginas.
function padronizarIconesDaPagina() {
    // Forma 1: <h3><span>🏢</span> Título</h3>
    document.querySelectorAll('h1 > span, h2 > span, h3 > span, h4 > span').forEach((el) => {
        if (el.children.length) return;              // já é ícone ou tem markup próprio
        const nome = EMOJI_TO_LUCIDE[el.textContent.trim()];
        if (!nome) return;                           // emoji não mapeado: fica como está
        el.classList.add('titulo-icone');
        el.innerHTML = `<i data-lucide="${nome}"></i>`;
    });
    // Forma 2: <h3>🏢 Título</h3> — o emoji é o começo do próprio texto
    document.querySelectorAll('h1, h2, h3, h4').forEach((h) => trocarEmojiInicial(h, 'titulo-icone'));
    // Botões e links-botão: mesmo padrão de ícone-antes-do-rótulo.
    document.querySelectorAll('button, .btn').forEach((b) => trocarEmojiInicial(b, 'btn-icone'));
}

// Troca o emoji que abre o elemento por um ícone Lucide. Só mexe quando o
// primeiro nó é texto começando com um emoji conhecido; qualquer outro caso
// (ícone já convertido, markup próprio, emoji não mapeado) fica intacto.
function trocarEmojiInicial(el, classe) {
    const no = el.firstChild;
    if (!no || no.nodeType !== Node.TEXT_NODE) return;
    const m = no.nodeValue.match(/^\s*(\S+)(\s+|$)/);
    if (!m) return;
    const nome = EMOJI_TO_LUCIDE[m[1]];
    if (!nome) return;
    no.nodeValue = no.nodeValue.slice(m[0].length);
    const span = document.createElement('span');
    // Botão só de ícone (lixeira, lápis) não deve carregar a margem do rótulo.
    span.className = classe + (el.textContent.trim() ? '' : ' so-icone');
    span.innerHTML = `<i data-lucide="${nome}"></i>`;
    el.insertBefore(span, el.firstChild);
}

// Muito botão tem o rótulo reescrito em tempo de execução ('⏳ Salvando...',
// e depois '💾 Salvar'), e a tela é montada por innerHTML em quase toda
// listagem. Sem observar, o ícone só valeria até a primeira interação.
/**
 * Envolve cada `<table>` num container com rolagem própria.
 *
 * ── Por que em JavaScript, e não em CSS ─────────────────────────────────────
 *
 * 175 telas do ERP têm `<table>` e NENHUMA envolvia a tabela num container. Uma
 * tabela de 8 colunas força uns 900px: era a maior causa de a PÁGINA inteira
 * ficar mais larga que o celular e precisar ser arrastada de lado.
 *
 * CSS não cria elemento, e um wrapper é o que falta. As alternativas eram
 * piores: `display: block` na tabela quebra o alinhamento das colunas, e editar
 * 175 arquivos seria muito mais arriscado do que uma função aqui — que vale
 * inclusive para as tabelas montadas depois, por JavaScript.
 *
 * A rolagem fica DENTRO do quadro (`overscroll-behavior-x: contain`), então
 * arrastar a tabela não arrasta a página. Nenhuma coluna é escondida.
 *
 * Idempotente: tabela já envolvida é pulada, e tabela dentro de outra tabela
 * também — o wrapper de fora já resolve.
 */
/**
 * Traduz falha de REDE para uma frase que a pessoa entenda.
 *
 * `Load failed` é a mensagem literal do Safari/WebKit quando um `fetch` não
 * completa; no Chrome é `Failed to fetch`. Nenhuma das duas diz nada a quem
 * está tentando salvar um orçamento — e era exatamente o que aparecia na tela
 * do celular, porque as telas mostram `e.message` cru.
 *
 * O detalhe técnico não se perde: vai para o console, onde serve a quem
 * investiga. O usuário recebe o que dá para agir.
 *
 * Global de propósito: o mesmo texto tem de aparecer em qualquer tela, e as
 * ~220 do ERP já carregam este arquivo.
 */
/**
 * @param {*} e        o erro capturado
 * @param {string} [oque]  o que falhou, para a frase ficar específica:
 *                         `'baixar o PDF'` → "Não foi possível baixar o PDF."
 */
function mensagemDeRede(e, oque) {
    const m = String((e && e.message) || e || '');
    const alvo = oque ? ('Não foi possível ' + oque + '.') : 'Não foi possível concluir esta ação.';
    if (/load failed|failed to fetch|networkerror|network request failed|the internet connection appears to be offline/i.test(m)) {
        console.warn('[rede] falha técnica:', m, e);
        return alvo + ' Verifique sua conexão e tente novamente.';
    }
    if (/abort/i.test(m)) return 'A operação demorou demais e foi cancelada. Tente de novo.';
    // ReferenceError/TypeError não é falha de rede: é BUG. Mandar a pessoa
    // "verificar a conexão" a faria procurar defeito no wi-fi por um erro que
    // está no código. O rastro inteiro vai para o console.
    if (e instanceof ReferenceError || e instanceof TypeError) {
        console.error('[bug] falha inesperada:', e);
        return alvo + ' Ocorreu um erro interno — avise o suporte se continuar.';
    }
    return m || alvo;
}

function envolverTabelas(raiz) {
    try {
        const alvo = raiz || document;
        if (!alvo || !alvo.querySelectorAll) return;
        for (const tab of alvo.querySelectorAll('table')) {
            if (!tab.parentElement) continue;
            if (tab.closest('.tabela-rolagem')) continue;      // já envolvida
            if (tab.parentElement.closest('table')) continue;  // aninhada
            const box = document.createElement('div');
            box.className = 'tabela-rolagem';
            tab.parentElement.insertBefore(box, tab);
            box.appendChild(tab);
        }
    } catch (e) {
        // Uma tabela sem rolagem é um incômodo; a tela não abrir é um defeito.
        console.warn('[tabelas] não pôde envolver (a tela segue normal):', e && e.message);
    }
}

function observarIconesDinamicos() {
    if (window.__lctIconObserver) return;
    let pendente = false;
    const obs = new MutationObserver((muts) => {
        // `table` entrou na lista junto com os botões: quase toda listagem do
        // ERP monta a tabela por `innerHTML` depois do fetch, então envolvê-la
        // só no carregamento pegaria a tela vazia. Ver `envolverTabelas`.
        const temBotao = muts.some((mut) => {
            if (mut.target && mut.target.closest && mut.target.closest('button, .btn, h1, h2, h3, h4, table')) return true;
            return [...mut.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE
                && (n.matches?.('button, .btn, h1, h2, h3, h4, table') || n.querySelector?.('button, .btn, h1, h2, h3, h4, table')));
        });
        if (!temBotao || pendente) return;
        // Agrupa numa única passada por frame: listagens grandes disparam
        // centenas de mutações seguidas.
        pendente = true;
        requestAnimationFrame(() => {
            pendente = false;
            obs.disconnect();
            try {
                padronizarIconesDaPagina();
                envolverTabelas();
                if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
            } finally {
                obs.observe(document.body, { childList: true, subtree: true, characterData: true });
            }
        });
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.__lctIconObserver = obs;
}

function renderIcon(emoji) {
    const name = EMOJI_TO_LUCIDE[emoji];
    if (!name) return emoji; // fallback: mostra o próprio emoji
    // O fallback fica como `data-lucide-fallback` — se o CSS do Lucide
    // não carregar (offline), o emoji aparece pelo texto interno.
    return `<i data-lucide="${name}" data-lucide-fallback="${emoji}"></i>`;
}

// Última página marcada como ativa — o menu é redesenhado quando o acesso do
// perfil chega, e precisa reacender o item certo.
let paginaAtualMenu = null;

// Desenha (ou redesenha) o menu no documento atual. Serve tanto para a página
// solta quanto para o shell: os dois montam o mesmo bloco no topo do body.
function montarMenu(pageName) {
    paginaAtualMenu = pageName ?? paginaAtualMenu;
    // Quem está digitando na busca não pode perder o foco porque um refresh de
    // features/acesso resolveu redesenhar o menu por baixo.
    const buscaTinhaFoco = !!(document.activeElement && document.activeElement.id === 'menuBusca');
    for (const sel of ['.menu-toggle', '.sidebar-overlay', '#sidebar']) {
        const el = document.querySelector(sel);
        if (el) el.remove();
    }
    document.body.insertAdjacentHTML('afterbegin', gerarMenuHTML(paginaAtualMenu));
    if (paginaAtualMenu) setActiveMenuItem(paginaAtualMenu);
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
    // Busca em curso sobrevive ao redesenho: um refresh de features/acesso no
    // meio da digitação apagaria o que a pessoa escreveu.
    if (termoBuscaMenu || buscaTinhaFoco) {
        const inp = document.getElementById('menuBusca');
        if (inp) {
            inp.value = termoBuscaMenu;
            if (buscaTinhaFoco) {
                inp.removeAttribute('readonly');   // o onfocus não roda em foco programático
                inp.focus();
                const fim = inp.value.length;
                try { inp.setSelectionRange(fim, fim); } catch (_) {} // type=search recusa em alguns browsers
            }
        }
        renderResultadosBusca();
    }
    carregarEstabSwitcher();
    carregarContadorInteresses();
    carregarContadorAprovacoes();
}

// ===== Módulos (modo 'modulos') =====
// O módulo de uma seção É a feature dela — a mesma chave que o admin liga por
// tenant. Seção sem feature (Configurações) cai no balde 'sistema'.
function moduloDaSecao(secao) { return secao.feature || 'sistema'; }

/**
 * Seções que sobrevivem a feature flag + RBAC. A lista é a mesma nos dois
 * modos; 'modulos' apenas mostra um subconjunto dela por vez.
 *
 * ── `paraDesenho` e os itens `oculto` ───────────────────────────────────────
 *
 * Um item com `oculto: true` está REGISTRADO no menu — e é isso que mantém a
 * permissão dele sendo exigida pelo nome. `perfis-acesso.js` indexa
 * `menuConfig.secoes[].itens[]` sem olhar esta propriedade: a página segue em
 * `POR_LINK`, e `podeVerPath` continua fazendo checagem NOMINAL. Tirar o item
 * do arquivo é que faria a página cair no fallback por diretório.
 *
 * O que `oculto` muda é só o DESENHO da barra. Por isso o padrão desta função
 * é INCLUIR — quem esquecer o parâmetro mantém o comportamento de sempre — e
 * apenas `montarMenu` pede a lista filtrada.
 *
 * Os outros dois chamadores precisam enxergar o item oculto, e por motivos
 * diferentes:
 *
 *   - `buscarRotinas`: a busca existe justamente para alcançar o que não está
 *     à vista. Quem TEM a permissão deve achar a rotina digitando o nome dela;
 *     escondê-la ali tiraria um caminho legítimo, sem ganho nenhum.
 *   - `sincronizarModuloComPagina`: abrir a página por link direto no modo
 *     'modulos' precisa saber a que módulo ela pertence. Sem isso o menu ficaria
 *     no módulo errado ao entrar por bookmark.
 */
function secoesVisiveisDoMenu({ paraDesenho = false } = {}) {
    const config = typeof menuConfig !== 'undefined' ? menuConfig : null;
    if (!config) return [];
    const out = [];
    config.secoes.forEach((secao, idx) => {
        if (secao.feature && !isFeatureEnabled(secao.feature)) return;
        const itens = secao.itens.filter(it =>
            (!it.feature || isFeatureEnabled(it.feature))
            && isPaginaPermitida(it.page)
            && !(paraDesenho && it.oculto));
        if (!itens.length) return;
        out.push({ secao, itens, slug: 'grp-' + idx });
    });
    return out;
}

// ===== Busca de rotina =====
// Varre TODOS os módulos, não só o que está aberto: no modo 'modulos' é ela
// que evita que o resto do sistema fique escondido atrás do seletor.
const MENU_BUSCA_MAX = 12;
let termoBuscaMenu = '';
let buscaIndiceAtivo = -1;

// Sem acento e em minúsculas dos dois lados: "comissoes" tem de achar "Comissões".
function normalizarBusca(s) {
    return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Casa no texto do item e também no título da seção — assim "fiscal" traz o
// módulo inteiro, e não só os itens com "fiscal" no próprio nome.
function buscarRotinas(termo) {
    const alvo = normalizarBusca(termo).trim();
    if (alvo.length < 2) return [];
    const termos = alvo.split(/\s+/);
    const achados = [];
    secoesVisiveisDoMenu().forEach(({ secao, itens }) => {
        itens.forEach(item => {
            const heno = normalizarBusca(item.texto);
            const hsec = normalizarBusca(secao.titulo);
            // Todo termo tem de aparecer em algum dos dois campos.
            if (!termos.every(t => heno.includes(t) || hsec.includes(t))) return;
            achados.push({
                texto: item.texto, link: item.link, icone: item.icone,
                caminho: secao.titulo,
                // Casar no próprio nome do item vale mais que casar só na seção.
                peso: (heno.startsWith(termos[0]) ? 0 : (heno.includes(termos[0]) ? 1 : 2)),
            });
        });
    });
    achados.sort((a, b) => a.peso - b.peso || a.texto.localeCompare(b.texto));
    return achados.slice(0, MENU_BUSCA_MAX);
}

function renderResultadosBusca() {
    const cx = document.getElementById('menuBuscaLista');
    if (!cx) return;
    const achados = buscarRotinas(termoBuscaMenu);
    if (!termoBuscaMenu.trim()) { cx.innerHTML = ''; cx.classList.remove('open'); return; }
    cx.classList.add('open');
    if (!achados.length) {
        cx.innerHTML = '<div class="menu-busca-vazio">Nenhuma rotina encontrada</div>';
        return;
    }
    // Classe menu-item de propósito: o shell já intercepta clique em
    // a.menu-item[href] e navega sem recarregar. Sem data-page para não
    // disputar o destaque de "página ativa" com o item real do menu.
    cx.innerHTML = achados.map((r, i) => `
        <a href="${r.link}" class="menu-item menu-busca-item ${i === buscaIndiceAtivo ? 'sel' : ''}" data-idx="${i}">
            <span class="icon">${renderIcon(r.icone)}</span>
            <span class="menu-busca-txt">
                <span class="menu-busca-nome">${r.texto}</span>
                <span class="menu-busca-caminho">${r.caminho}</span>
            </span>
        </a>`).join('');
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
}

function onBuscaMenuInput(valor) {
    termoBuscaMenu = valor;
    buscaIndiceAtivo = -1;
    renderResultadosBusca();
}

// Setas percorrem, Enter abre, Esc limpa. Sem isto a busca obriga a tirar a
// mão do teclado para clicar no resultado.
function onBuscaMenuTecla(ev) {
    const itens = document.querySelectorAll('.menu-busca-item');
    if (ev.key === 'Escape') { limparBuscaMenu(); return; }
    if (!itens.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const passo = ev.key === 'ArrowDown' ? 1 : -1;
        buscaIndiceAtivo = (buscaIndiceAtivo + passo + itens.length) % itens.length;
        renderResultadosBusca();
    } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const alvo = itens[buscaIndiceAtivo >= 0 ? buscaIndiceAtivo : 0];
        if (alvo) alvo.click();
        limparBuscaMenu();
    }
}

function limparBuscaMenu() {
    termoBuscaMenu = '';
    buscaIndiceAtivo = -1;
    const inp = document.getElementById('menuBusca');
    if (inp) inp.value = '';
    renderResultadosBusca();
}

// Abrir uma página de outro módulo (deep link, bookmark, ou link vindo de outra
// tela) tem de trazer o menu junto — senão o item ativo nem existe no DOM.
// Devolve true quando trocou o módulo e o menu precisa ser redesenhado.
function sincronizarModuloComPagina(pageName) {
    if (!pageName || getMenuModo() !== 'modulos') return false;
    const modulos = agruparEmModulos(secoesVisiveisDoMenu());
    const daPagina = modulos.find(m => m.secoes.some(s => s.itens.some(i => i.page === pageName)));
    if (!daPagina || daPagina.chave === getModuloAtivo()) return false;
    try { localStorage.setItem('menuModuloAtivo', daPagina.chave); } catch (_) {}
    return true;
}

// Título/ícone do módulo: o mapa `menuModulos` só nomeia quem agrupa mais de
// uma seção; nos demais o módulo é a própria seção e herda o rótulo dela.
function rotuloModulo(chave, secoes) {
    const meta = (typeof menuModulos !== 'undefined' && menuModulos[chave]) || null;
    if (meta) return meta;
    const primeira = secoes[0] || {};
    return { titulo: primeira.titulo || chave, icone: primeira.icone || '📁' };
}

// Agrupa as seções JÁ filtradas por feature/acesso, preservando a ordem do
// menu-config. Consequência útil: módulo que o tenant não contratou, ou que o
// perfil não alcança, simplesmente não existe no seletor.
function agruparEmModulos(secoesVisiveis) {
    const ordem = [];
    const mapa = new Map();
    secoesVisiveis.forEach(sv => {
        const chave = moduloDaSecao(sv.secao);
        if (!mapa.has(chave)) { mapa.set(chave, []); ordem.push(chave); }
        mapa.get(chave).push(sv);
    });
    return ordem.map(chave => {
        const secoes = mapa.get(chave);
        const meta = rotuloModulo(chave, secoes.map(s => s.secao));
        return { chave, titulo: meta.titulo, icone: meta.icone, secoes };
    });
}

function getModuloAtivo() {
    try { return localStorage.getItem('menuModuloAtivo') || ''; } catch { return ''; }
}

// Trocar de modo com uma página já aberta: o módulo salvo pode ser de outra
// área, e o menu abriria sem o item da tela que está no ar. Sincronizar aqui é
// seguro — ao contrário de fazê-lo em todo montarMenu(), que desfaria a
// escolha de módulo do usuário no primeiro refresh de features.
function aplicarTrocaDeModo() {
    sincronizarModuloComPagina(paginaAtualMenu);
    montarMenu(paginaAtualMenu);
}

// Troca de módulo sem recarregar: no shell, reload custaria a página aberta
// dentro do iframe.
function selecionarModulo(chave) {
    try { localStorage.setItem('menuModuloAtivo', chave); } catch (_) {}
    montarMenu(paginaAtualMenu);
}

function toggleSeletorModulos() {
    const el = document.getElementById('modulosPop');
    if (el) el.classList.toggle('open');
}

// Clique fora fecha o seletor. Registrado uma vez no documento: montarMenu()
// destrói e recria a sidebar, então listener preso ao elemento se perderia.
if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
        const dentroBusca = e.target.closest && e.target.closest('.menu-busca');
        // Escolher um resultado fecha a busca; o shell cuida da navegação.
        if (e.target.closest && e.target.closest('.menu-busca-item')) limparBuscaMenu();
        else if (!dentroBusca && termoBuscaMenu) limparBuscaMenu();

        const pop = document.getElementById('modulosPop');
        if (!pop || !pop.classList.contains('open')) return;
        if (e.target.closest && e.target.closest('.modulo-switcher')) return;
        pop.classList.remove('open');
    });
}

/* ==========================================================================
   MARCA — SVG embutido
   ==========================================================================
   Os mesmos desenhos de `public/img/marca-horizontal.svg` e
   `marca-monograma.svg`, colados aqui. A duplicação é deliberada, e o custo
   dela é conhecido: mudou um, muda o outro. O que se ganha:

   - **Os dois temas com um desenho só.** "Licite" e "ERP" são
     `fill="currentColor"` e herdam a cor do texto da sidebar. Dentro de um
     `<img src=…>` não existe cor herdada, e seriam precisos dois arquivos por
     variante — quatro ao todo, para dessincronizar depois.
   - **A fonte certa.** `Inter` é carregada pela PÁGINA (app-modern.css). Um
     `<img>` renderiza o SVG isolado, sem acesso a ela, e o texto cairia numa
     fonte qualquer do sistema.
   - **Zero requisições.** Antes era uma (o PNG); com dois arquivos seriam
     duas, e a troca ao recolher a barra piscaria na primeira vez.

   Os arquivos em `public/img/` continuam sendo a fonte da verdade e existem
   para uso fora daqui (documento, apresentação, e-mail).

   ⚠️ IDs de `mask`, `clipPath` e `linearGradient` são GLOBAIS no documento,
   não escopados ao SVG. Por isso os prefixos `lah*` (horizontal) e `lam*`
   (monograma) são diferentes: os dois convivem na mesma página, e IDs iguais
   fariam um usar a máscara do outro.
*/
const MARCA_HORIZONTAL = `
<svg class="marca marca-horizontal" viewBox="0 0 320 70" role="img" aria-label="Licite Agora ERP" focusable="false">
  <defs>
    <linearGradient id="lahAz" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="#3B82F6"/><stop offset="50%" stop-color="#2563EB"/><stop offset="100%" stop-color="#1D4ED8"/>
    </linearGradient>
    <clipPath id="lahCorte"><rect x="0" y="7" width="84" height="42.5"/></clipPath>
    <mask id="lahVao"><rect width="84" height="54" fill="#fff"/>
      <path d="M43 46 L55.5 31.5" stroke="#000" stroke-width="9" stroke-linecap="round" fill="none"/>
      <path d="M64 20.5 L48.5 27 L60.5 38.5 Z" fill="#000" stroke="#000" stroke-width="5.5" stroke-linejoin="round"/>
    </mask>
  </defs>
  <g transform="translate(0 6) scale(0.815)">
    <g clip-path="url(#lahCorte)"><path d="M23 0 L10.5 36 Q9.5 43 17 43 L29 43 L53 7 L76 54"
       fill="none" stroke="url(#lahAz)" stroke-width="13" stroke-linecap="butt" stroke-linejoin="round" mask="url(#lahVao)"/></g>
    <path d="M43 46 L55.5 31.5" stroke="#22C55E" stroke-width="5" stroke-linecap="round" fill="none"/>
    <path d="M64 20.5 L48.5 27 L60.5 38.5 Z" fill="#22C55E" stroke="#22C55E" stroke-width="2" stroke-linejoin="round"/>
  </g>
  <text x="84" y="40" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="34" font-weight="800" letter-spacing="-1.2">
    <tspan fill="currentColor">Licite</tspan><tspan fill="#2563EB"> Agora</tspan>
  </text>
  <line x1="84" y1="55" x2="146" y2="55" stroke="#22C55E" stroke-width="2.2" stroke-linecap="round"/>
  <text x="196.5" y="60" text-anchor="middle" fill="currentColor" opacity="0.85" font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="15" font-weight="600" letter-spacing="7">ERP</text>
  <line x1="240" y1="55" x2="302" y2="55" stroke="#22C55E" stroke-width="2.2" stroke-linecap="round"/>
</svg>`;

const MARCA_MONOGRAMA = `
<svg class="marca marca-monograma" viewBox="0 0 84 54" role="img" aria-label="Licite Agora" focusable="false">
  <defs>
    <linearGradient id="lamAz" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="#3B82F6"/><stop offset="50%" stop-color="#2563EB"/><stop offset="100%" stop-color="#1D4ED8"/>
    </linearGradient>
    <clipPath id="lamCorte"><rect x="0" y="7" width="84" height="42.5"/></clipPath>
    <mask id="lamVao"><rect width="84" height="54" fill="#fff"/>
      <path d="M43 46 L55.5 31.5" stroke="#000" stroke-width="9" stroke-linecap="round" fill="none"/>
      <path d="M64 20.5 L48.5 27 L60.5 38.5 Z" fill="#000" stroke="#000" stroke-width="5.5" stroke-linejoin="round"/>
    </mask>
  </defs>
  <g clip-path="url(#lamCorte)"><path d="M23 0 L10.5 36 Q9.5 43 17 43 L29 43 L53 7 L76 54"
     fill="none" stroke="url(#lamAz)" stroke-width="13" stroke-linecap="butt" stroke-linejoin="round" mask="url(#lamVao)"/></g>
  <path d="M43 46 L55.5 31.5" stroke="#22C55E" stroke-width="5" stroke-linecap="round" fill="none"/>
  <path d="M64 20.5 L48.5 27 L60.5 38.5 Z" fill="#22C55E" stroke="#22C55E" stroke-width="2" stroke-linejoin="round"/>
</svg>`;

// Gera o HTML do menu a partir da configuração
function gerarMenuHTML(pageName) {
    const config = typeof menuConfig !== 'undefined' ? menuConfig : null;

    if (!config) {
        console.error('menu-config.js não foi carregado!');
        return '';
    }

    const gruposState = getGruposState();
    const modo = getMenuModo();
    // O ÚNICO lugar que filtra os itens `oculto` — é o desenho da barra. Ver a
    // nota em `secoesVisiveisDoMenu`.
    const secoesVisiveis = secoesVisiveisDoMenu({ paraDesenho: true });

    // Módulo escolhido vence o da página aberta: no modo 'modulos' trocar de
    // módulo é um ato deliberado, e a página continua no lugar (como no ERP que
    // serviu de referência). Quem cuida do caso "abri uma página de outro
    // módulo" é sincronizarModuloComPagina, no momento da navegação.
    let modulos = [];
    let moduloAtivo = null;
    let secoesDoMenu = secoesVisiveis;
    if (modo === 'modulos') {
        modulos = agruparEmModulos(secoesVisiveis);
        const salvo = modulos.find(m => m.chave === getModuloAtivo());
        const daPagina = modulos.find(m => m.secoes.some(s => s.itens.some(i => i.page === pageName)));
        moduloAtivo = salvo || daPagina || modulos[0] || null;
        secoesDoMenu = moduloAtivo ? moduloAtivo.secoes : [];
    }

    let secoesHTML = '';
    secoesDoMenu.forEach(({ secao, itens: itensVisiveis, slug }) => {
        const temPaginaAtiva = itensVisiveis.some(i => i.page === pageName);
        // Grupo colapsável: aberto só se contém página ativa ou se usuário expandiu explicitamente
        const aberto = temPaginaAtiva || gruposState[slug] === true;
        // Módulo de uma seção só: o nome do módulo já está no cabeçalho logo
        // acima, então repetir o título como grupo fechável só daria ao usuário
        // um jeito de esconder o menu inteiro do módulo.
        const semCabecalho = modo === 'modulos' && secoesDoMenu.length === 1;

        const secIcone = secao.icone ? `<span class="menu-section-icon">${renderIcon(secao.icone)}</span>` : '';
        const tituloHTML = `<span class="menu-section-title">${secIcone}${secao.titulo}</span>`;
        if (semCabecalho) {
            secoesHTML += `<div class="menu-group">`;
        } else if (secao.colapsavel) {
            const chevron = aberto ? '▾' : '▸';
            // `data-grupo-nome` e `data-tooltip` = `secao.titulo`, a mesma fonte
            // do rótulo visível. É o que o flyout usa como cabeçalho e o tooltip
            // como texto quando a barra está recolhida.
            const nomeSecao = String(secao.titulo || '').trim().replace(/"/g, '&quot;');
            secoesHTML += `<div class="menu-section menu-section-toggle" data-grupo="${slug}"`
                + ` data-grupo-nome="${nomeSecao}" data-tooltip="${nomeSecao}"`
                + ` role="button" tabindex="0" aria-expanded="${aberto ? 'true' : 'false'}"`
                + ` onclick="toggleGrupo('${slug}')">${tituloHTML} <span class="menu-chevron">${chevron}</span></div>\n`;
            secoesHTML += `<div class="menu-group" id="${slug}" style="${aberto ? '' : 'display:none'}">`;
        } else {
            secoesHTML += `<div class="menu-section">${tituloHTML}</div>\n`;
            secoesHTML += `<div class="menu-group">`;
        }

        itensVisiveis.forEach(item => {
            const badgeHTML = item.badge ? `<span class="badge" id="${item.badge}"></span>` : '';
            // `data-tooltip` e `aria-label` saem de `item.texto`, o nome real do
            // menu-config. Nenhum rótulo é escrito à mão.
            //
            // SEM `title`: ele desenharia o tooltip NATIVO do navegador por cima
            // do nosso (visto em "Tabelas de Preço" na revisão de 2026-09-11 —
            // dois textos ao mesmo tempo, um escuro e um branco). Ter os dois
            // também poluía a barra EXPANDIDA, onde o nome já está escrito ao
            // lado e nenhum tooltip é necessário.
            //
            // Não há perda de fallback: quem desenha estes itens é o mesmo
            // `sidebar.js` que desenha o tooltip. Se ele não rodar, não há menu —
            // então não haveria `title` para socorrer ninguém. Para leitor de
            // tela, quem responde é o `aria-label`.
            const nome = String(item.texto || '').trim();
            secoesHTML += `
        <a href="${item.link}" class="menu-item" data-page="${item.page}"
           data-tooltip="${nome.replace(/"/g, '&quot;')}"
           aria-label="${nome.replace(/"/g, '&quot;')}">
            <span class="icon">${renderIcon(item.icone)}</span>
            <span class="rotulo">${item.texto}</span>
            ${badgeHTML}
        </a>`;
        });

        secoesHTML += '</div>';
    });

    // Cabeçalho do módulo ativo + seletor. Só existe no modo 'modulos'.
    let moduloHTML = '';
    if (modo === 'modulos' && moduloAtivo) {
        const tiles = modulos.map(m => `
            <button type="button" class="modulo-tile ${m.chave === moduloAtivo.chave ? 'ativo' : ''}"
                    onclick="selecionarModulo('${m.chave}')" title="${m.titulo}">
                <span class="modulo-tile-icon">${renderIcon(m.icone)}</span>
                <span class="modulo-tile-nome">${m.titulo}</span>
            </button>`).join('');
        moduloHTML = `
    <div class="modulo-switcher">
        <button type="button" class="modulo-atual" onclick="toggleSeletorModulos()">
            <span class="menu-section-icon">${renderIcon(moduloAtivo.icone)}</span>
            <span class="modulo-atual-nome">${moduloAtivo.titulo}</span>
            <span class="menu-chevron">▾</span>
        </button>
        <div class="modulo-pop" id="modulosPop">${tiles}</div>
    </div>`;
    }

    return `
<button class="menu-toggle" onclick="toggleSidebar()">☰</button>
<div class="sidebar-overlay" onclick="toggleSidebar()"></div>
<nav class="sidebar" id="sidebar">
    <div class="sidebar-header">
        <a href="${config.logo.link}" class="sidebar-logo" aria-label="${config.logo.texto}">
            ${MARCA_HORIZONTAL}${MARCA_MONOGRAMA}
        </a>
        <button type="button" class="sidebar-toggle" id="btnSidebarToggle"
                onclick="alternarSidebarCompacta(); return false;"
                title="Recolher menu" aria-label="Recolher menu">&laquo;</button>
    </div>
    <div id="estabSwitcher" style="display:none; padding:10px 14px; border-bottom:1px solid var(--border);"></div>
    ${moduloHTML}
    <div class="menu-busca">
        <!-- readonly liberado no foco: o Chrome ignora autocomplete="off" e
             trata um input de texto solto no topo da página como campo de
             login, pintando o usuário salvo por cima da busca. Campo readonly
             ele não autopreenche, e o atributo sai no primeiro clique. -->
        <input type="search" id="menuBusca" name="busca-rotina" placeholder="Buscar rotina…"
               readonly onfocus="this.removeAttribute('readonly')"
               autocomplete="off" data-1p-ignore data-lpignore="true" spellcheck="false"
               oninput="onBuscaMenuInput(this.value)" onkeydown="onBuscaMenuTecla(event)">
        <div class="menu-busca-lista" id="menuBuscaLista"></div>
    </div>
    <div class="sidebar-menu">
        ${secoesHTML}
        <!-- O grupo "Conta" saiu daqui em 2026-09-11 (Fase 3.3). Alterar Senha e
             Sair passaram para o menu de conta da TOPBAR, no canto superior
             direito, que e onde se procura por elas. Mante-los aqui tambem daria
             dois "Sair" na mesma tela - dois caminhos para a mesma acao, e um
             deles escondido dentro de um grupo recolhivel.
             As funcoes nao mudaram: abrirModalSenha() e fazerLogout() continuam
             neste arquivo, agora chamadas por montarMenuConta().
             Antes disso, "Cor do Sistema" ja havia saido do mesmo grupo
             (relatorio 24): o tema virou botao. abrirModalTema() segue existindo
             para os cinco usuarios com tema custom salvo.
             SEM CRASES NESTE COMENTARIO: ele esta dentro de uma template
             literal, e uma crase aqui FECHA a string e quebra o arquivo
             inteiro - foi exatamente o que derrubou o shell (relatorio 25). -->
    </div>
</nav>

<!-- Modal Alterar Senha -->
<div id="modalSenha" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.65); z-index:10000; align-items:center; justify-content:center;">
  <div style="background:var(--bg-2); border:1px solid var(--border); border-radius:var(--r-lg); padding:28px; width:100%; max-width:380px; box-shadow:0 12px 40px rgba(0,0,0,0.5);">
    <h3 style="color:var(--text-0); margin-bottom:18px;">Alterar Senha</h3>
    <div id="senhaErro" style="display:none; background:var(--danger-soft); color:var(--danger); padding:8px 12px; border-radius:var(--r-sm); font-size:13px; margin-bottom:12px;"></div>
    <div id="senhaSucesso" style="display:none; background:var(--success-soft); color:var(--success); padding:8px 12px; border-radius:var(--r-sm); font-size:13px; margin-bottom:12px;"></div>
    <div style="margin-bottom:14px;">
      <label style="display:block; font-size:var(--text-xs); color:var(--text-2); text-transform:uppercase; letter-spacing:0.02em; margin-bottom:5px;">Senha atual</label>
      <input type="password" id="senhaAtual">
    </div>
    <div style="margin-bottom:18px;">
      <label style="display:block; font-size:var(--text-xs); color:var(--text-2); text-transform:uppercase; letter-spacing:0.02em; margin-bottom:5px;">Nova senha</label>
      <input type="password" id="senhaNova">
    </div>
    <div style="display:flex; gap:10px; justify-content:flex-end;">
      <button class="btn btn-ghost" onclick="fecharModalSenha()">Cancelar</button>
      <button class="btn btn-primary" onclick="salvarSenha()">Salvar</button>
    </div>
  </div>
</div>

<!-- Modal Cor do Sistema -->
<div id="modalTema" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.65); z-index:10000; align-items:center; justify-content:center;" onclick="if(event.target===this)fecharModalTema()">
  <div style="background:var(--bg-2); border:1px solid var(--border); border-radius:var(--r-lg); padding:28px; width:100%; max-width:380px; box-shadow:0 12px 40px rgba(0,0,0,0.5);">
    <h3 style="color:var(--text-0); margin-bottom:6px;">Cor do Sistema</h3>
    <p style="color:var(--text-2); font-size:13px; margin-bottom:18px;">Escolha o fundo e a cor de destaque. Mexer nas cores mostra uma prévia na hora; "Salvar cores" grava no seu usuário.</p>
    <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin-bottom:14px;">
      <label style="display:flex; align-items:center; gap:8px; color:var(--text-1); font-size:13px;">Fundo <input type="color" id="corFundo" value="#0f172a" oninput="previewTemaCustom()" style="width:44px; height:32px; border:1px solid var(--border-strong); border-radius:var(--r-sm); background:none; cursor:pointer;"></label>
      <label style="display:flex; align-items:center; gap:8px; color:var(--text-1); font-size:13px;">Destaque <input type="color" id="corDestaque" value="#3b82f6" oninput="previewTemaCustom()" style="width:44px; height:32px; border:1px solid var(--border-strong); border-radius:var(--r-sm); background:none; cursor:pointer;"></label>
    </div>
    <div id="temaStatus" style="color:var(--text-2); font-size:12px; min-height:16px; margin-bottom:12px;"></div>
    <div style="display:flex; gap:10px; justify-content:space-between;">
      <button class="btn btn-ghost" onclick="restaurarTemaPadrao()">Restaurar padrão</button>
      <div style="display:flex; gap:10px;">
        <button class="btn btn-ghost" onclick="fecharModalTema()">Cancelar</button>
        <button class="btn btn-primary" onclick="salvarTemaCustom()">Salvar cores</button>
      </div>
    </div>
  </div>
</div>
`;
}

// Toggle grupo colapsável
function toggleGrupo(slug) {
    const el = document.getElementById(slug);
    if (!el) return;
    const state = getGruposState();
    const aberto = el.style.display !== 'none';
    el.style.display = aberto ? 'none' : '';
    state[slug] = !aberto;
    saveGruposState(state);
    // Atualizar chevron
    const header = document.querySelector(`[data-grupo="${slug}"] .menu-chevron`);
    if (header) header.textContent = aberto ? '▸' : '▾';
}

// Inicializa o sidebar
function initSidebar(pageName) {
    // Dentro do shell: a sidebar é do pai. A página só se identifica e ajusta o layout.
    if (IN_SHELL) {
        document.body.classList.add('embedded');
        try {
            window.parent.__shellPageChanged(
                pageName,
                location.pathname + location.search + location.hash,
                document.title
            );
        } catch (_) {}
        interceptarLinksExternos();
        padronizarIconesDaPagina();
        envolverTabelas();
        observarIconesDinamicos();
        // Se a lib ainda não carregou, o onload de injectLucide desenha depois.
        try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
        return;
    }
    // desenharMenuComAcesso já revalida acesso e features em segundo plano.
    desenharMenuComAcesso(pageName);
    // Largura da barra conforme a página (o PDV pede compacta). Depois do menu
    // existir: é ele que tem o botão cujo rótulo precisa ser acertado.
    ajustarSidebarPara(pageName);
    padronizarIconesDaPagina();
    envolverTabelas();
    observarIconesDinamicos();
}

// Desenha o menu já sabendo o que o perfil alcança.
//
// No primeiro carregamento deste browser não há cache: desenhar direto mostraria
// o menu inteiro por um instante e encolheria depois — para um perfil restrito,
// isso é exibir a lista das telas que ele não pode abrir. Então espera a
// resposta, com teto de 1,5s para que uma API lenta não segure a tela; se o teto
// estourar, o menu sai pelo cache (ou completo) e é corrigido quando a resposta
// chegar.
async function desenharMenuComAcesso(pageName) {
    const faltando = [];
    if (!getAcessoCache()) faltando.push(buscarAcesso());
    // Mesma história do outro lado: sem featuresCache, o menu nasce com as
    // seções do tenant escondidas (só "Configurações" sobra) — era o que o
    // location.reload() consertava depois.
    if (!Object.keys(getFeaturesCache()).length) faltando.push(buscarFeatures());
    if (faltando.length) {
        await Promise.race([Promise.all(faltando), new Promise(r => setTimeout(r, 1500))]);
    }
    // Antes do primeiro desenho: no boot é a página que manda, senão um módulo
    // salvo de outra sessão abriria o menu longe da tela que está no ar.
    sincronizarModuloComPagina(pageName);
    montarMenu(pageName);
    refreshAcessoCache();
    refreshFeaturesCache();
}

// Página embutida no shell: links pra outra origem (ex.: portais externos) devem
// navegar a aba inteira, não o iframe — sites externos costumam bloquear frames.
function interceptarLinksExternos() {
    document.addEventListener('click', function (e) {
        const a = e.target.closest('a[href]');
        if (!a || a.target) return; // _blank/_top já fazem a coisa certa
        const href = a.href; // absoluto, resolvido pelo browser
        if (!/^https?:/i.test(href)) return;
        try {
            if (new URL(href).origin === location.origin) return;
        } catch (_) { return; }
        e.preventDefault();
        try { window.top.location = href; } catch (_) { location.href = href; }
    });
}

// ===== Shell (app.html) =====
// Renderiza o menu UMA vez e navega as páginas dentro do <iframe id="conteudo">.
// URL do shell: /app.html#/caminho/pagina.html?query#hashInterno
function initShell() {
    window.__liciteShell = true;

    // O menu do shell é o menu de verdade: toda página redireciona para cá. Sem
    // passar pelo acesso do perfil aqui, o filtro do menu não valia na prática.
    desenharMenuComAcesso(null);

    const iframe = document.getElementById('conteudo');

    function destinoAtual() {
        try {
            const loc = iframe.contentWindow.location;
            if (loc.origin === location.origin) return loc.pathname + loc.search + loc.hash;
        } catch (_) {}
        return null;
    }

    function navegar(path) {
        const url = new URL(path, location.origin).href; // base explícita: iframe começa em about:blank
        // replace: o histórico é controlado pelo shell (pushState), não pelo iframe
        try { iframe.contentWindow.location.replace(url); }
        catch (_) { iframe.src = url; }
    }

    function sincronizarHash(path) {
        if (!path) return;
        if (location.hash.slice(1) !== path) history.pushState(null, '', '#' + path);
    }

    // Cliques no menu (e no logo) trocam só o conteúdo do iframe
    document.addEventListener('click', function (e) {
        const a = e.target.closest('a.menu-item[href], a.sidebar-logo[href]');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href || href === '#') return; // itens com onclick próprio (senha/sair)
        e.preventDefault();
        navegar(href === '/' ? '/index.html' : href);
    });

    // Chamada pela página filha (initSidebar embutido) quando termina de carregar
    window.__shellPageChanged = function (pageName, path, title) {
        if (pageName) {
            paginaAtualMenu = pageName;   // o menu pode ser redesenhado depois
            // No modo 'modulos', página de outro módulo troca o menu inteiro.
            if (sincronizarModuloComPagina(pageName)) montarMenu(pageName);
            setActiveMenuItem(pageName);
            // Deep link: se o item ativo está num grupo recolhido, abre o grupo
            const ativo = document.querySelector('.menu-item.active');
            const grupo = ativo && ativo.closest('.menu-group');
            if (grupo && grupo.style.display === 'none') toggleGrupo(grupo.id);
            // Largura da barra conforme a página aberta no iframe. É aqui, e não
            // dentro do PDV, porque no shell a sidebar é deste documento — a
            // página filha não alcança a barra do pai.
            ajustarSidebarPara(pageName);
        }
        if (title) document.title = title;
        sincronizarHash(path);
        carregarContadorInteresses();
        carregarContadorAprovacoes();
    };

    // Fallback pra páginas que não chamam initSidebar: sincroniza pelo load do iframe
    iframe.addEventListener('load', function () {
        sincronizarHash(destinoAtual());
    });

    function aplicarHash() {
        const alvo = location.hash.slice(1) || '/index.html';
        if (destinoAtual() === alvo) return;
        navegar(alvo);
    }
    window.addEventListener('popstate', aplicarHash);
    window.addEventListener('hashchange', aplicarHash);

    aplicarHash(); // carga inicial (deep link ou home)
}

// Popula o seletor de estabelecimento no topo do sidebar. Fica OCULTO quando o
// tenant só tem a matriz (ou uma única loja contratada) — nada muda para quem
// não usa multi-loja. Trocar recarrega a página para o novo contexto valer.
async function carregarEstabSwitcher() {
    const cont = document.getElementById('estabSwitcher');
    if (!cont) return;
    try {
        const j = await fetch('/api/estabelecimentos').then(r => r.json());
        if (!j || !j.success) return;
        const ativos = (j.data || []).filter(e => e.ativo && !e.bloqueado);

        // Com uma loja só, o nome dela é o nome da empresa — e é o que a topbar
        // mostra. Publicar aqui, e não com uma requisição própria, é o que
        // mantém a topbar em UMA chamada nova ao todo (a do usuário).
        if (ativos.length <= 1) {
            if (ativos.length === 1) publicarEmpresaNaTopbar(ativos[0].nomeFantasia || ativos[0].razaoSocial);
            return; // só matriz → não exibe o seletor
        }

        let ativoId = (ativos.find(e => e.matriz) || ativos[0]).id;
        try {
            const a = await fetch('/api/estabelecimento-ativo').then(r => r.json());
            if (a && a.success && a.data) ativoId = a.data.id;
        } catch (_) {}
        // Multi-loja: o seletor ao lado já diz QUAL loja está ativa, então a
        // topbar mostra a matriz — a empresa, que é o que não muda ao trocar.
        const matriz = ativos.find(e => e.matriz) || ativos[0];
        publicarEmpresaNaTopbar(matriz.nomeFantasia || matriz.razaoSocial);

        const opts = ativos.map(e => {
            const nome = e.nomeFantasia || e.razaoSocial || 'Estabelecimento';
            const tag = e.matriz ? ' (Matriz)' : '';
            const sel = e.id === ativoId ? ' selected' : '';
            return `<option value="${e.id}"${sel}>${nome}${tag}</option>`;
        }).join('');

        cont.innerHTML =
            `<div style="font-size:var(--text-xs); text-transform:uppercase; letter-spacing:0.04em; color:var(--text-3); margin-bottom:5px;">Estabelecimento</div>
             <select id="estabSwitcherSelect" onchange="trocarEstabelecimento(this.value)"
                     style="width:100%; padding:7px 9px; border-radius:var(--r-sm); background:var(--bg-1); color:var(--text-0); border:1px solid var(--border); font-size:0.88em;">
               ${opts}
             </select>`;
        cont.style.display = 'block';
    } catch (_) { /* silencioso: seletor é opcional */ }
}

async function trocarEstabelecimento(id) {
    try {
        const r = await fetch('/api/estabelecimento-ativo', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: Number(id) })
        });
        const j = await r.json();
        if (!j.success) { alert(j.error || 'Não foi possível trocar de estabelecimento.'); return; }
        location.reload();
    } catch (_) {
        alert('Falha ao trocar de estabelecimento.');
    }
}

// Marca o item de menu ativo baseado no nome da página
function setActiveMenuItem(pageName) {
    const menuItems = document.querySelectorAll('.menu-item');
    menuItems.forEach(item => {
        item.classList.remove('active');
        if (item.dataset.page === pageName) {
            item.classList.add('active');
        }
    });
}

// Toggle do sidebar para mobile
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.querySelector('.sidebar-overlay');

    if (sidebar) {
        sidebar.classList.toggle('open');
    }
    if (overlay) {
        overlay.classList.toggle('active');
    }
}

// Carrega o contador de interesses
async function carregarContadorInteresses() {
    try {
        const response = await fetch('/api/interesse');
        if (response.ok) {
            const data = await response.json();
            const countElement = document.getElementById('interesseCount');
            const count = data.success ? data.data.length : (Array.isArray(data) ? data.length : 0);
            if (countElement && count > 0) {
                countElement.textContent = count;
            }
        }
    } catch (error) {
        console.log('Erro ao carregar contador de interesses:', error);
    }
}

// Contador de aprovações pendentes.
//
// Mostra o que ESTE usuário pode decidir, não o total: um badge com um número
// que não é problema de quem está vendo treina a ignorar o badge. Se não há
// nada para ele mas há pendências de outro papel, mostra o total esmaecido —
// some do radar seria pior.
async function carregarContadorAprovacoes() {
    try {
        const response = await fetch('/api/alcadas/aprovacoes/pendentes');
        if (!response.ok) return;
        const data = await response.json();
        const el = document.getElementById('aprovacoesCount');
        if (!el || !data.success) return;
        if (data.minhas > 0) {
            el.textContent = data.minhas;
            el.style.opacity = '';
            el.title = `${data.minhas} esperando a sua decisão`;
        } else if (data.total > 0) {
            el.textContent = data.total;
            el.style.opacity = '0.5';
            el.title = `${data.total} pendente(s), aguardando outro papel`;
        } else {
            el.textContent = '';
        }
    } catch (error) {
        console.log('Erro ao carregar contador de aprovações:', error);
    }
}

// Fecha sidebar ao clicar em um link (mobile)
document.addEventListener('click', function(e) {
    if (e.target.closest('.menu-item') && window.innerWidth <= 768) {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
    }
});

// Fecha sidebar com tecla Escape
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
        fecharModalSenha();
    }
});

// Logout
async function fazerLogout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
    } catch (e) {}
    // O acesso é do usuário, não do browser: sem limpar, o próximo a entrar
    // nesta máquina veria o menu do anterior até a primeira resposta da API.
    try { localStorage.removeItem('acessoCache'); } catch (_) {}
    window.location.href = '/login.html';
}

// Modal cor do sistema
// Preenche os pickers com o tema salvo (custom) ou com as cores do padrão.
function seedTemaInputs() {
    const m = CUSTOM_TEMA_RE.exec(localStorage.getItem('appTheme') || '');
    const cf = document.getElementById('corFundo');
    const cd = document.getElementById('corDestaque');
    if (cf) cf.value = m ? m[1] : TEMA_FUNDO_PADRAO;
    if (cd) cd.value = m ? m[2] : TEMA_DESTAQUE_PADRAO;
}
function temaCustomAtual() {
    return 'custom:' + document.getElementById('corFundo').value + ':' + document.getElementById('corDestaque').value;
}
function previewTemaCustom() {
    aplicarTema(temaCustomAtual());
    const st = document.getElementById('temaStatus');
    if (st) st.textContent = 'Prévia — clique em "Salvar cores" pra manter.';
}
function salvarTemaCustom() {
    escolherTema(temaCustomAtual());
}
function restaurarTemaPadrao() {
    escolherTema('padrao');
    seedTemaInputs();
}
function escolherTema(tema) {
    cacheTema(tema);
    aplicarTema(tema);
    // storage event não dispara na janela que gravou → aplica no(s) iframe(s) daqui
    document.querySelectorAll('iframe').forEach((f) => {
        try { f.contentDocument && f.contentWindow.aplicarTema && f.contentWindow.aplicarTema(tema); } catch (_) {}
    });
    // Persiste no usuário logado (vale em qualquer navegador/máquina).
    fetch('/api/user/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tema }),
    }).then((r) => (r.ok ? r.json() : null)).then((d) => {
        const st = document.getElementById('temaStatus');
        if (st) st.textContent = d && d.success ? 'Salvo no seu usuário ✓' : '⚠ não foi possível salvar no servidor (aplicado só neste navegador)';
    }).catch(() => {
        const st = document.getElementById('temaStatus');
        if (st) st.textContent = '⚠ não foi possível salvar no servidor (aplicado só neste navegador)';
    });
}
function abrirModalTema() {
    const modal = document.getElementById('modalTema');
    if (modal) {
        seedTemaInputs();
        const st = document.getElementById('temaStatus');
        if (st) st.textContent = '';
        modal.style.display = 'flex';
    }
}
function fecharModalTema() {
    const modal = document.getElementById('modalTema');
    if (modal) modal.style.display = 'none';
    // Descarta prévia não salva: reaplica o tema que está persistido.
    try { aplicarTema(localStorage.getItem('appTheme')); } catch (_) {}
}

// Modal alterar senha
function abrirModalSenha() {
    const modal = document.getElementById('modalSenha');
    if (modal) {
        modal.style.display = 'flex';
        document.getElementById('senhaAtual').value = '';
        document.getElementById('senhaNova').value = '';
        document.getElementById('senhaErro').style.display = 'none';
        document.getElementById('senhaSucesso').style.display = 'none';
        document.getElementById('senhaAtual').focus();
    }
}

function fecharModalSenha() {
    const modal = document.getElementById('modalSenha');
    if (modal) modal.style.display = 'none';
}

async function salvarSenha() {
    const erroEl = document.getElementById('senhaErro');
    const sucessoEl = document.getElementById('senhaSucesso');
    erroEl.style.display = 'none';
    sucessoEl.style.display = 'none';

    const currentPassword = document.getElementById('senhaAtual').value;
    const newPassword = document.getElementById('senhaNova').value;

    if (!currentPassword || !newPassword) {
        erroEl.textContent = 'Preencha todos os campos';
        erroEl.style.display = 'block';
        return;
    }

    try {
        const res = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            sucessoEl.textContent = 'Senha alterada com sucesso!';
            sucessoEl.style.display = 'block';
            setTimeout(fecharModalSenha, 1500);
        } else {
            erroEl.textContent = data.error || 'Erro ao alterar senha';
            erroEl.style.display = 'block';
        }
    } catch (e) {
        erroEl.textContent = 'Erro de conexão';
        erroEl.style.display = 'block';
    }
}

// ===== Chat IA Widget desativado (2026-06-22) =====
// Botão flutuante "Copiloto IA" removido a pedido (estava atrapalhando).
// Widget preservado em /js/chat-ia-widget.js caso seja reativado no futuro.
