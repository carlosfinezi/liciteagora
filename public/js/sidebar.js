/* Sidebar Unificado - Licite Agora */
/* Menu é gerado dinamicamente a partir de menu-config.js */

// Carrega estado dos grupos do localStorage
function getGruposState() {
    try {
        return JSON.parse(localStorage.getItem('sidebarGrupos') || '{}');
    } catch { return {}; }
}
function saveGruposState(state) {
    localStorage.setItem('sidebarGrupos', JSON.stringify(state));
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
        const slug = 'grp-' + idx;
        const temPaginaAtiva = secao.itens.some(i => i.page === pageName);
        // Grupo colapsável: aberto se contém página ativa, ou conforme estado salvo (padrão: aberto)
        const aberto = temPaginaAtiva || gruposState[slug] !== false;

        if (secao.colapsavel) {
            const chevron = aberto ? '▾' : '▸';
            secoesHTML += `<div class="menu-section menu-section-toggle" data-grupo="${slug}" onclick="toggleGrupo('${slug}')">${secao.titulo} <span class="menu-chevron">${chevron}</span></div>\n`;
            secoesHTML += `<div class="menu-group" id="${slug}" style="${aberto ? '' : 'display:none'}">`;
        } else {
            secoesHTML += `<div class="menu-section">${secao.titulo}</div>\n`;
            secoesHTML += `<div class="menu-group">`;
        }

        secao.itens.forEach(item => {
            const badgeHTML = item.badge ? `<span class="badge" id="${item.badge}"></span>` : '';
            secoesHTML += `
        <a href="${item.link}" class="menu-item" data-page="${item.page}">
            <span class="icon">${item.icone}</span>
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
            <span>${config.logo.icone}</span>
            ${config.logo.texto}
        </a>
    </div>
    <div class="sidebar-menu">
        ${secoesHTML}
        <div class="menu-section menu-section-toggle" data-grupo="grp-conta" onclick="toggleGrupo('grp-conta')">Conta <span class="menu-chevron">▾</span></div>
        <div class="menu-group" id="grp-conta">
        <a href="#" class="menu-item" onclick="abrirModalSenha(); return false;">
            <span class="icon">🔑</span>
            Alterar Senha
        </a>
        <a href="#" class="menu-item" onclick="fazerLogout(); return false;">
            <span class="icon">🚪</span>
            Sair
        </a>
        </div>
    </div>
</nav>

<!-- Modal Alterar Senha -->
<div id="modalSenha" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:10000; align-items:center; justify-content:center;">
  <div style="background:#16213e; border-radius:12px; padding:32px; width:100%; max-width:380px; box-shadow:0 8px 32px rgba(0,0,0,0.3);">
    <h3 style="color:#4dabf7; margin-bottom:20px;">Alterar Senha</h3>
    <div id="senhaErro" style="display:none; background:rgba(255,70,70,0.15); color:#ff6b6b; padding:8px 12px; border-radius:6px; font-size:13px; margin-bottom:12px;"></div>
    <div id="senhaSucesso" style="display:none; background:rgba(70,255,70,0.15); color:#69db7c; padding:8px 12px; border-radius:6px; font-size:13px; margin-bottom:12px;"></div>
    <div style="margin-bottom:14px;">
      <label style="display:block; font-size:13px; color:#aaa; margin-bottom:4px;">Senha atual</label>
      <input type="password" id="senhaAtual" style="width:100%; padding:10px; border:1px solid #2a3a5c; border-radius:6px; background:#0f1a30; color:#e0e0e0; font-size:14px;">
    </div>
    <div style="margin-bottom:14px;">
      <label style="display:block; font-size:13px; color:#aaa; margin-bottom:4px;">Nova senha</label>
      <input type="password" id="senhaNova" style="width:100%; padding:10px; border:1px solid #2a3a5c; border-radius:6px; background:#0f1a30; color:#e0e0e0; font-size:14px;">
    </div>
    <div style="display:flex; gap:10px; justify-content:flex-end;">
      <button onclick="fecharModalSenha()" style="padding:8px 16px; border:1px solid #2a3a5c; border-radius:6px; background:transparent; color:#aaa; cursor:pointer;">Cancelar</button>
      <button onclick="salvarSenha()" style="padding:8px 16px; border:none; border-radius:6px; background:#4dabf7; color:#fff; cursor:pointer; font-weight:600;">Salvar</button>
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
    const sidebarHTML = gerarMenuHTML(pageName);
    document.body.insertAdjacentHTML('afterbegin', sidebarHTML);
    setActiveMenuItem(pageName);
    carregarContadorInteresses();
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
