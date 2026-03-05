/* Sidebar Unificado - Licite Agora */
/* Menu é gerado dinamicamente a partir de menu-config.js */

// Gera o HTML do menu a partir da configuração
function gerarMenuHTML() {
    const config = typeof menuConfig !== 'undefined' ? menuConfig : null;

    if (!config) {
        console.error('menu-config.js não foi carregado!');
        return '';
    }

    let secoesHTML = '';
    config.secoes.forEach(secao => {
        secoesHTML += `<div class="menu-section">${secao.titulo}</div>\n`;
        secao.itens.forEach(item => {
            const badgeHTML = item.badge ? `<span class="badge" id="${item.badge}"></span>` : '';
            secoesHTML += `
        <a href="${item.link}" class="menu-item" data-page="${item.page}">
            <span class="icon">${item.icone}</span>
            ${item.texto}
            ${badgeHTML}
        </a>`;
        });
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
    </div>
</nav>
`;
}

// Inicializa o sidebar
function initSidebar(pageName) {
    // Gera e insere o HTML do sidebar
    const sidebarHTML = gerarMenuHTML();
    document.body.insertAdjacentHTML('afterbegin', sidebarHTML);

    // Marca o item ativo
    setActiveMenuItem(pageName);

    // Carrega contador de interesses
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
    }
});
