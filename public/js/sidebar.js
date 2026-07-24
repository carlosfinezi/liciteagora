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
};

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
        const itensVisiveis = secao.itens.filter(it => !it.feature || isFeatureEnabled(it.feature));
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
            <span class="sidebar-logo-icon">${renderIcon(config.logo.icone)}</span>
            ${config.logo.texto}
        </a>
    </div>
    <div id="estabSwitcher" style="display:none; padding:10px 14px; border-bottom:1px solid var(--border);"></div>
    <div class="sidebar-menu">
        ${secoesHTML}
        <div class="menu-section menu-section-toggle" data-grupo="grp-conta" onclick="toggleGrupo('grp-conta')"><span class="menu-section-title"><span class="menu-section-icon">${renderIcon('👤')}</span>Conta</span> <span class="menu-chevron">${gruposState['grp-conta'] === true ? '▾' : '▸'}</span></div>
        <div class="menu-group" id="grp-conta" style="${gruposState['grp-conta'] === true ? '' : 'display:none'}">
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
        return;
    }
    const sidebarHTML = gerarMenuHTML(pageName);
    document.body.insertAdjacentHTML('afterbegin', sidebarHTML);
    setActiveMenuItem(pageName);
    carregarContadorInteresses();
    // Renderiza os SVGs do Lucide. Se a lib ainda não carregou, o próprio
    // onload do script (em injectLucide) cuida disso.
    try { if (window.lucide && window.lucide.createIcons) window.lucide.createIcons(); } catch (_) {}
    // Atualiza cache de feature flags em background (recarrega se mudou)
    refreshFeaturesCache();
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
