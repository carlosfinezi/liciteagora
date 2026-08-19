/* Sidebar Unificado - Licite Agora */
/* Menu é gerado dinamicamente a partir de menu-config.js */

// ===== Shell SPA (app.html) =====
// O menu vive UMA vez no shell (app.html) e as páginas carregam num <iframe>.
// - Página dentro do shell: não renderiza sidebar; só reporta ao pai (IN_SHELL).
// - Página aberta top-level (bookmark/URL antiga): redireciona pra dentro do shell.
// - Página framed por um pai que NÃO é o shell (ex.: proposta-template no editor):
//   comportamento antigo, intacto.
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
function aplicarTema(tema) {
    const st = document.documentElement.style;
    CUSTOM_VARS.forEach((v) => st.removeProperty(v));
    const m = CUSTOM_TEMA_RE.exec(tema || '');
    if (!m) return; // 'padrao' (ou tema antigo/desconhecido) = paleta do CSS
    const pal = paletaCustom(m[1], m[2]);
    Object.keys(pal).forEach((k) => st.setProperty(k, pal[k]));
}
function cacheTema(tema) {
    try { localStorage.setItem('appTheme', tema || 'padrao'); } catch (_) {}
}
(function initTema() {
    if (typeof document === 'undefined') return;
    try { aplicarTema(localStorage.getItem('appTheme')); } catch (_) {}
    window.addEventListener('storage', (e) => {
        if (e.key === 'appTheme') aplicarTema(e.newValue);
    });
    // Fonte da verdade: preferência do usuário logado no servidor.
    fetch('/api/user/prefs').then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d || !d.success) return;
        const tema = d.tema || 'padrao';
        cacheTema(tema);
        aplicarTema(tema);
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

// Feature flags: cache lido sincronamente do localStorage (atualizado em
// background a cada init). Seções/itens com `feature: 'X'` em menu-config
// são ocultadas se features[X] !== true.
function getFeaturesCache() {
    try { return JSON.parse(localStorage.getItem('featuresCache') || '{}'); }
    catch { return {}; }
}
function refreshFeaturesCache() {
    fetch('/api/features/status').then(r => r.ok ? r.json() : null).then(d => {
        if (!d || !d.features) return;
        const cur = getFeaturesCache();
        const next = { ...cur, ...d.features };
        const changed = JSON.stringify(cur) !== JSON.stringify(next);
        localStorage.setItem('featuresCache', JSON.stringify(next));
        // Se a flag virou em segundo plano, recarrega a página uma vez pra
        // a sidebar pegar o estado novo. Evita loop com sessionStorage.
        if (changed && !sessionStorage.getItem('featuresCacheReloaded')) {
            sessionStorage.setItem('featuresCacheReloaded', '1');
            location.reload();
        }
    }).catch(() => {});
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
function refreshAcessoCache() {
    fetch('/api/perfis/meu-acesso').then(r => r.ok ? r.json() : null).then(d => {
        if (!d || !d.success) return;
        const next = { irrestrito: !!d.irrestrito, paginas: d.paginas || [] };
        const changed = JSON.stringify(getAcessoCache()) !== JSON.stringify(next);
        localStorage.setItem('acessoCache', JSON.stringify(next));
        if (changed && !sessionStorage.getItem('acessoCacheReloaded')) {
            sessionStorage.setItem('acessoCacheReloaded', '1');
            location.reload();
        }
    }).catch(() => {});
}
function isPaginaPermitida(page) {
    const c = getAcessoCache();
    // Sem cache ainda (primeiro acesso do browser) não esconde nada: o gate do
    // servidor é quem decide de fato, aqui é só para não oferecer porta fechada.
    if (!c || c.irrestrito) return true;
    return (c.paginas || []).includes(page);
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
function observarIconesDinamicos() {
    if (window.__lctIconObserver) return;
    let pendente = false;
    const obs = new MutationObserver((muts) => {
        const temBotao = muts.some((mut) => {
            if (mut.target && mut.target.closest && mut.target.closest('button, .btn, h1, h2, h3, h4')) return true;
            return [...mut.addedNodes].some((n) => n.nodeType === Node.ELEMENT_NODE
                && (n.matches?.('button, .btn, h1, h2, h3, h4') || n.querySelector?.('button, .btn, h1, h2, h3, h4')));
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

// Gera o HTML do menu a partir da configuração
function gerarMenuHTML(pageName) {
    const config = typeof menuConfig !== 'undefined' ? menuConfig : null;

    if (!config) {
        console.error('menu-config.js não foi carregado!');
        return '';
    }

    const gruposState = getGruposState();

    let secoesHTML = '';
    config.secoes.forEach((secao, idx) => {
        if (secao.feature && !isFeatureEnabled(secao.feature)) return;
        const slug = 'grp-' + idx;
        const itensVisiveis = secao.itens.filter(it =>
            (!it.feature || isFeatureEnabled(it.feature)) && isPaginaPermitida(it.page));
        if (!itensVisiveis.length) return;
        const temPaginaAtiva = itensVisiveis.some(i => i.page === pageName);
        // Grupo colapsável: aberto só se contém página ativa ou se usuário expandiu explicitamente
        const aberto = temPaginaAtiva || gruposState[slug] === true;

        const secIcone = secao.icone ? `<span class="menu-section-icon">${renderIcon(secao.icone)}</span>` : '';
        const tituloHTML = `<span class="menu-section-title">${secIcone}${secao.titulo}</span>`;
        if (secao.colapsavel) {
            const chevron = aberto ? '▾' : '▸';
            secoesHTML += `<div class="menu-section menu-section-toggle" data-grupo="${slug}" onclick="toggleGrupo('${slug}')">${tituloHTML} <span class="menu-chevron">${chevron}</span></div>\n`;
            secoesHTML += `<div class="menu-group" id="${slug}" style="${aberto ? '' : 'display:none'}">`;
        } else {
            secoesHTML += `<div class="menu-section">${tituloHTML}</div>\n`;
            secoesHTML += `<div class="menu-group">`;
        }

        itensVisiveis.forEach(item => {
            const badgeHTML = item.badge ? `<span class="badge" id="${item.badge}"></span>` : '';
            secoesHTML += `
        <a href="${item.link}" class="menu-item" data-page="${item.page}">
            <span class="icon">${renderIcon(item.icone)}</span>
            ${item.texto}
            ${badgeHTML}
        </a>`;
        });

        secoesHTML += '</div>';
    });

    return `
<button class="menu-toggle" onclick="toggleSidebar()">☰</button>
<div class="sidebar-overlay" onclick="toggleSidebar()"></div>
<nav class="sidebar" id="sidebar">
    <div class="sidebar-header">
        <a href="${config.logo.link}" class="sidebar-logo">
            <img class="sidebar-logo-img" src="/img/logo-sistema.png" alt="${config.logo.texto}">
        </a>
    </div>
    <div id="estabSwitcher" style="display:none; padding:10px 14px; border-bottom:1px solid var(--border);"></div>
    <div class="sidebar-menu">
        ${secoesHTML}
        <div class="menu-section menu-section-toggle" data-grupo="grp-conta" onclick="toggleGrupo('grp-conta')"><span class="menu-section-title"><span class="menu-section-icon">${renderIcon('👤')}</span>Conta</span> <span class="menu-chevron">${gruposState['grp-conta'] === true ? '▾' : '▸'}</span></div>
        <div class="menu-group" id="grp-conta" style="${gruposState['grp-conta'] === true ? '' : 'display:none'}">
        <a href="#" class="menu-item" onclick="abrirModalTema(); return false;">
            <span class="icon">${renderIcon('🎨')}</span>
            Cor do Sistema
        </a>
        <a href="#" class="menu-item" onclick="abrirModalSenha(); return false;">
            <span class="icon">${renderIcon('🔑')}</span>
            Alterar Senha
        </a>
        <a href="#" class="menu-item" onclick="fazerLogout(); return false;">
            <span class="icon">${renderIcon('🚪')}</span>
            Sair
        </a>
        </div>
    </div>
</nav>

<!-- Modal Alterar Senha -->
<div id="modalSenha" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.65); z-index:10000; align-items:center; justify-content:center;">
  <div style="background:var(--bg-2); border:1px solid var(--border); border-radius:var(--r-lg); padding:28px; width:100%; max-width:380px; box-shadow:0 12px 40px rgba(0,0,0,0.5);">
    <h3 style="color:var(--text-0); margin-bottom:18px;">Alterar Senha</h3>
    <div id="senhaErro" style="display:none; background:var(--danger-soft); color:var(--danger); padding:8px 12px; border-radius:var(--r-sm); font-size:13px; margin-bottom:12px;"></div>
    <div id="senhaSucesso" style="display:none; background:var(--success-soft); color:var(--success); padding:8px 12px; border-radius:var(--r-sm); font-size:13px; margin-bottom:12px;"></div>
    <div style="margin-bottom:14px;">
      <label style="display:block; font-size:0.82em; color:var(--text-2); text-transform:uppercase; letter-spacing:0.02em; margin-bottom:5px;">Senha atual</label>
      <input type="password" id="senhaAtual">
    </div>
    <div style="margin-bottom:18px;">
      <label style="display:block; font-size:0.82em; color:var(--text-2); text-transform:uppercase; letter-spacing:0.02em; margin-bottom:5px;">Nova senha</label>
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
        observarIconesDinamicos();
        // Se a lib ainda não carregou, o onload de injectLucide desenha depois.
        try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
        return;
    }
    const sidebarHTML = gerarMenuHTML(pageName);
    document.body.insertAdjacentHTML('afterbegin', sidebarHTML);
    setActiveMenuItem(pageName);
    padronizarIconesDaPagina();
    observarIconesDinamicos();
    carregarContadorInteresses();
    carregarContadorAprovacoes();
    // Renderiza os SVGs do Lucide. Se a lib ainda não carregou, o próprio
    // onload do script (em injectLucide) cuida disso.
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
    // Atualiza cache de feature flags em background (recarrega se mudou)
    refreshFeaturesCache();
    // Idem para o acesso do perfil do usuário.
    refreshAcessoCache();
    // Seletor de estabelecimento (multi-loja): só aparece quando há +de 1 ativo.
    carregarEstabSwitcher();
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

    document.body.insertAdjacentHTML('afterbegin', gerarMenuHTML(null));
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
    refreshFeaturesCache();
    carregarEstabSwitcher();
    carregarContadorInteresses();
    carregarContadorAprovacoes();

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
            setActiveMenuItem(pageName);
            // Deep link: se o item ativo está num grupo recolhido, abre o grupo
            const ativo = document.querySelector('.menu-item.active');
            const grupo = ativo && ativo.closest('.menu-group');
            if (grupo && grupo.style.display === 'none') toggleGrupo(grupo.id);
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
        if (ativos.length <= 1) return; // só matriz → não exibe

        let ativoId = (ativos.find(e => e.matriz) || ativos[0]).id;
        try {
            const a = await fetch('/api/estabelecimento-ativo').then(r => r.json());
            if (a && a.success && a.data) ativoId = a.data.id;
        } catch (_) {}

        const opts = ativos.map(e => {
            const nome = e.nomeFantasia || e.razaoSocial || 'Estabelecimento';
            const tag = e.matriz ? ' (Matriz)' : '';
            const sel = e.id === ativoId ? ' selected' : '';
            return `<option value="${e.id}"${sel}>${nome}${tag}</option>`;
        }).join('');

        cont.innerHTML =
            `<div style="font-size:0.7em; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-3); margin-bottom:5px;">Estabelecimento</div>
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
