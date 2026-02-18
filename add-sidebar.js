const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

// CSS do sidebar
const sidebarCss = `
        /* Sidebar */
        .app-container {
            display: flex;
            min-height: 100vh;
        }

        .sidebar {
            width: 250px;
            background: #2c3e50;
            padding: 0;
            position: fixed;
            height: 100vh;
            left: 0;
            top: 0;
            overflow-y: auto;
            box-shadow: 2px 0 10px rgba(0,0,0,0.2);
            z-index: 1000;
        }

        .sidebar-header {
            padding: 25px 20px;
            background: #1a252f;
            border-bottom: 1px solid #34495e;
        }

        .sidebar-logo {
            color: white;
            font-size: 20px;
            font-weight: 700;
            text-decoration: none;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .sidebar-logo span {
            font-size: 24px;
        }

        .sidebar-menu {
            padding: 15px 0;
        }

        .menu-section {
            padding: 10px 20px 5px;
            color: #7f8c8d;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .menu-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px 20px;
            color: #bdc3c7;
            text-decoration: none;
            transition: all 0.3s;
            border-left: 3px solid transparent;
        }

        .menu-item:hover {
            background: #34495e;
            color: white;
            border-left-color: #667eea;
        }

        .menu-item.active {
            background: #34495e;
            color: white;
            border-left-color: #667eea;
        }

        .menu-item .icon {
            font-size: 18px;
            width: 24px;
            text-align: center;
        }

        .menu-item .badge {
            margin-left: auto;
            background: #e74c3c;
            color: white;
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
            font-weight: 600;
        }

        .menu-item .badge.green {
            background: #27ae60;
        }

        .main-content {
            flex: 1;
            margin-left: 250px;
            padding: 20px;
        }

        /* Ajustar container */
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        /* Responsive */
        @media (max-width: 768px) {
            .sidebar {
                transform: translateX(-100%);
                transition: transform 0.3s;
            }
            .sidebar.open {
                transform: translateX(0);
            }
            .main-content {
                margin-left: 0;
            }
            .menu-toggle {
                display: block !important;
            }
        }

        .menu-toggle {
            display: none;
            position: fixed;
            top: 10px;
            left: 10px;
            z-index: 1001;
            background: #2c3e50;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 20px;
        }
`;

// Adicionar CSS antes do fechamento de </style>
html = html.replace('</style>', sidebarCss + '\n    </style>');

// Remover estrutura antiga
const oldBody = `<body>
    <div class="container">
        <header>
            <div>
                <h1>Portal de Consulta de Licitações - PNCP</h1>
                <p class="subtitle">Portal Nacional de Contratações Públicas</p>
            </div>
            <a href="/interesse.html" class="btn-interesses">⭐ Meus Interesses</a>
        </header>`;

const newBody = `<body>
    <button class="menu-toggle" onclick="toggleSidebar()">☰</button>

    <div class="app-container">
        <nav class="sidebar" id="sidebar">
            <div class="sidebar-header">
                <a href="/" class="sidebar-logo">
                    <span>📋</span>
                    PNCP
                </a>
            </div>
            <div class="sidebar-menu">
                <div class="menu-section">Principal</div>
                <a href="/" class="menu-item active">
                    <span class="icon">🔍</span>
                    Buscar Licitações
                </a>
                <a href="/interesse.html" class="menu-item">
                    <span class="icon">⭐</span>
                    Meus Interesses
                    <span class="badge green" id="interesseCount">0</span>
                </a>

                <div class="menu-section">Relatórios</div>
                <a href="#" class="menu-item" onclick="alert('Em desenvolvimento')">
                    <span class="icon">📊</span>
                    Dashboard
                </a>
                <a href="#" class="menu-item" onclick="alert('Em desenvolvimento')">
                    <span class="icon">📈</span>
                    Estatísticas
                </a>

                <div class="menu-section">Sistema</div>
                <a href="#" class="menu-item" onclick="sincronizarAgora()">
                    <span class="icon">🔄</span>
                    Sincronizar
                </a>
                <a href="#" class="menu-item" onclick="verStatus()">
                    <span class="icon">ℹ️</span>
                    Status
                </a>
            </div>
        </nav>

        <main class="main-content">
            <div class="container">
                <header>
                    <div>
                        <h1>Portal de Consulta de Licitações - PNCP</h1>
                        <p class="subtitle">Portal Nacional de Contratações Públicas</p>
                    </div>
                </header>`;

html = html.replace(oldBody, newBody);

// Fechar as tags ao final do body
const oldClosing = `    <script src="app.js"></script>
</body>`;

const newClosing = `            </div>
        </main>
    </div>

    <script src="app.js"></script>
    <script>
        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('open');
        }

        async function carregarContadorInteresses() {
            try {
                const response = await fetch('/api/interesse');
                const data = await response.json();
                if (data.success) {
                    document.getElementById('interesseCount').textContent = data.data.length;
                }
            } catch (e) {}
        }

        async function sincronizarAgora() {
            if (!confirm('Iniciar sincronização?')) return;
            try {
                const response = await fetch('/api/sync/start', { method: 'POST' });
                const data = await response.json();
                alert(data.message || 'Sincronização iniciada!');
            } catch (e) {
                alert('Erro ao iniciar sincronização');
            }
        }

        async function verStatus() {
            try {
                const response = await fetch('/api/sync/status');
                const data = await response.json();
                alert('Última sync: ' + (data.ultimaSync || 'Nunca') + '\\nLicitações: ' + (data.totalLicitacoes || 0) + '\\nItens: ' + (data.totalItens || 0));
            } catch (e) {
                alert('Erro ao obter status');
            }
        }

        // Carregar contador ao iniciar
        carregarContadorInteresses();
    </script>
</body>`;

html = html.replace(oldClosing, newClosing);

fs.writeFileSync('public/index.html', html);
console.log('Sidebar adicionado com sucesso!');
