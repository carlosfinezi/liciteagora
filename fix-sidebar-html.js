const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

const oldBody = `<body>
    <div class="container">
        <header>
            <h1>Portal de Consulta de Licitações - PNCP</h1>
            <p class="subtitle">Portal Nacional de Contratações Públicas</p>
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
                    <h1>Portal de Consulta de Licitações - PNCP</h1>
                    <p class="subtitle">Portal Nacional de Contratações Públicas</p>
                </header>`;

if (html.includes(oldBody)) {
    html = html.replace(oldBody, newBody);
    console.log('Body inicio substituido!');
} else {
    console.log('AVISO: Padrao do body nao encontrado!');
}

// Fechar as tags no final
const oldEnding = `    <script src="app.js"></script>
</body>`;

const newEnding = `            </div>
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

        carregarContadorInteresses();
    </script>
</body>`;

if (html.includes(oldEnding)) {
    html = html.replace(oldEnding, newEnding);
    console.log('Fechamento substituido!');
} else {
    console.log('AVISO: Padrao de fechamento nao encontrado!');
}

// Também fechar o primeiro container div antes do modal
const oldContainerEnd = `    </div>


    <!-- Modal de Itens -->`;

const newContainerEnd = `            </div>

    <!-- Modal de Itens -->`;

if (html.includes(oldContainerEnd)) {
    html = html.replace(oldContainerEnd, newContainerEnd);
    console.log('Container fechado!');
}

fs.writeFileSync('public/index.html', html);
console.log('Arquivo salvo!');
