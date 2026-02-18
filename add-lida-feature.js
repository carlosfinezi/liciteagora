const fs = require('fs');

// ========================================
// 1. UPDATE SERVER.JS - Add table and endpoints
// ========================================
let server = fs.readFileSync('server.js', 'utf8');

// Add table creation after interesse table
const afterInteresse = `CREATE INDEX IF NOT EXISTS idx_interesse_licitacao ON interesse(cnpj, ano, sequencial);`;

const newTable = `CREATE INDEX IF NOT EXISTS idx_interesse_licitacao ON interesse(cnpj, ano, sequencial);

  // Tabela para marcar licitações lidas
  db.exec(\`
    CREATE TABLE IF NOT EXISTS licitacao_lida (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cnpj TEXT NOT NULL,
      ano INTEGER NOT NULL,
      sequencial INTEGER NOT NULL,
      dataLeitura TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(cnpj, ano, sequencial)
    )
  \`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_lida_licitacao ON licitacao_lida(cnpj, ano, sequencial)');`;

server = server.replace(afterInteresse, newTable);
console.log('1. Tabela licitacao_lida adicionada!');

// Add endpoints before the last app.listen
const beforeListen = `app.listen(PORT, () => {`;

const newEndpoints = `/**
 * Endpoint para marcar licitação como lida
 */
app.post('/api/lida', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.body;

    if (!cnpj || !ano || !sequencial) {
      return res.status(400).json({
        success: false,
        error: 'cnpj, ano e sequencial são obrigatórios'
      });
    }

    const stmt = db.prepare(\`
      INSERT OR REPLACE INTO licitacao_lida (cnpj, ano, sequencial, dataLeitura)
      VALUES (?, ?, ?, datetime('now'))
    \`);

    stmt.run(cnpj, parseInt(ano), parseInt(sequencial));

    res.json({
      success: true,
      message: 'Licitação marcada como lida'
    });

  } catch (error) {
    console.error('Erro ao marcar como lida:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao marcar como lida',
      details: error.message
    });
  }
});

/**
 * Endpoint para desmarcar licitação como lida
 */
app.delete('/api/lida/:cnpj/:ano/:sequencial', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.params;

    const result = db.prepare(
      'DELETE FROM licitacao_lida WHERE cnpj = ? AND ano = ? AND sequencial = ?'
    ).run(cnpj, parseInt(ano), parseInt(sequencial));

    res.json({
      success: true,
      message: result.changes > 0 ? 'Desmarcada' : 'Não encontrada'
    });

  } catch (error) {
    console.error('Erro ao desmarcar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Endpoint para listar licitações lidas
 */
app.get('/api/lidas', (req, res) => {
  try {
    const lidas = db.prepare('SELECT cnpj, ano, sequencial FROM licitacao_lida').all();

    // Retorna um Set-like object para fácil verificação
    const lidasMap = {};
    lidas.forEach(l => {
      lidasMap[l.cnpj + '-' + l.ano + '-' + l.sequencial] = true;
    });

    res.json({
      success: true,
      data: lidasMap,
      total: lidas.length
    });

  } catch (error) {
    console.error('Erro ao listar lidas:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {`;

server = server.replace(beforeListen, newEndpoints);
console.log('2. Endpoints de lidas adicionados!');

fs.writeFileSync('server.js', server);

// ========================================
// 2. UPDATE HTML - Add filter checkbox and styles
// ========================================
let html = fs.readFileSync('public/index.html', 'utf8');

// Add CSS for read items
const beforeStyle = `</style>
</head>`;

const newCss = `
        /* Estilo para licitações lidas */
        .licitacao-card.lida {
            opacity: 0.6;
            background: #f5f5f5;
            border-left: 4px solid #9e9e9e;
        }
        .licitacao-card.lida .licitacao-titulo {
            color: #888;
        }
        .licitacao-card.lida::before {
            content: '✓ Lida';
            position: absolute;
            top: 10px;
            right: 10px;
            background: #9e9e9e;
            color: white;
            padding: 3px 8px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 600;
        }
        .licitacao-card {
            position: relative;
        }
        .btn-marcar-lida {
            padding: 6px 12px;
            background: #607d8b;
            color: white;
            border: none;
            border-radius: 4px;
            font-size: 12px;
            cursor: pointer;
            margin-right: 8px;
        }
        .btn-marcar-lida:hover {
            background: #455a64;
        }
        .btn-marcar-lida.lida {
            background: #4caf50;
        }
        .filtro-lidas {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 10px 15px;
            background: #e3f2fd;
            border-radius: 5px;
            margin-left: auto;
        }
        .filtro-lidas label {
            font-size: 13px;
            color: #1976d2;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            margin: 0;
        }
        .filtro-lidas input[type="checkbox"] {
            width: 16px;
            height: 16px;
            cursor: pointer;
        }
    </style>
</head>`;

html = html.replace(beforeStyle, newCss);
console.log('3. CSS de lidas adicionado!');

// Add filter checkbox in results-info
const oldResultsInfo = `<div id="resultsInfo" style="display: none;" class="results-info">
            <div class="results-count">
                <span id="resultsCount">0</span> licitações encontradas
            </div>
            <div>Página <span id="currentPage">1</span></div>
        </div>`;

const newResultsInfo = `<div id="resultsInfo" style="display: none;" class="results-info">
            <div class="results-count">
                <span id="resultsCount">0</span> licitações encontradas
                <span id="lidasCount" style="margin-left: 10px; color: #888; font-size: 13px;"></span>
            </div>
            <div class="filtro-lidas">
                <label>
                    <input type="checkbox" id="filtroNaoLidas" onchange="aplicarFiltroLidas()">
                    Mostrar apenas não lidas
                </label>
            </div>
            <div>Página <span id="currentPage">1</span></div>
        </div>`;

html = html.replace(oldResultsInfo, newResultsInfo);
console.log('4. Filtro de lidas adicionado!');

fs.writeFileSync('public/index.html', html);

// ========================================
// 3. UPDATE APP.JS - Add read functionality
// ========================================
let appJs = fs.readFileSync('public/app.js', 'utf8');

// Add lidas map and functions at the beginning
const oldStart = `// Variáveis globais`;
const newStart = `// Variáveis globais
let licitacoesLidas = {};
let todasLicitacoesAtuais = [];`;

if (appJs.includes(oldStart)) {
    appJs = appJs.replace(oldStart, newStart);
} else {
    // Add at beginning if not found
    appJs = `// Mapa de licitações lidas
let licitacoesLidas = {};
let todasLicitacoesAtuais = [];

` + appJs;
}

// Add functions at the end (before the last closing)
const lidasFunctions = `

// ========================================
// Funções para licitações lidas
// ========================================

async function carregarLidas() {
    try {
        const response = await fetch('/api/lidas');
        const data = await response.json();
        if (data.success) {
            licitacoesLidas = data.data;
            atualizarContadorLidas();
        }
    } catch (error) {
        console.error('Erro ao carregar lidas:', error);
    }
}

function isLida(cnpj, ano, sequencial) {
    return licitacoesLidas[cnpj + '-' + ano + '-' + sequencial] === true;
}

async function toggleLida(cnpj, ano, sequencial, btn) {
    const key = cnpj + '-' + ano + '-' + sequencial;
    const jaLida = licitacoesLidas[key];

    try {
        if (jaLida) {
            // Desmarcar
            await fetch('/api/lida/' + cnpj + '/' + ano + '/' + sequencial, { method: 'DELETE' });
            delete licitacoesLidas[key];
            btn.textContent = '👁 Marcar lida';
            btn.classList.remove('lida');
            btn.closest('.licitacao-card').classList.remove('lida');
        } else {
            // Marcar como lida
            await fetch('/api/lida', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cnpj, ano, sequencial })
            });
            licitacoesLidas[key] = true;
            btn.textContent = '✓ Lida';
            btn.classList.add('lida');
            btn.closest('.licitacao-card').classList.add('lida');
        }
        atualizarContadorLidas();
        aplicarFiltroLidas();
    } catch (error) {
        console.error('Erro ao alternar lida:', error);
    }
}

function atualizarContadorLidas() {
    const total = todasLicitacoesAtuais.length;
    const lidas = todasLicitacoesAtuais.filter(l =>
        isLida(l.cnpj, l.anoCompra, l.sequencialCompra)
    ).length;

    const el = document.getElementById('lidasCount');
    if (el && total > 0) {
        el.textContent = '(' + lidas + ' lidas, ' + (total - lidas) + ' não lidas)';
    }
}

function aplicarFiltroLidas() {
    const filtroAtivo = document.getElementById('filtroNaoLidas')?.checked;
    const cards = document.querySelectorAll('.licitacao-card');

    cards.forEach(card => {
        if (filtroAtivo && card.classList.contains('lida')) {
            card.style.display = 'none';
        } else {
            card.style.display = '';
        }
    });
}

// Carregar lidas ao iniciar
document.addEventListener('DOMContentLoaded', carregarLidas);
`;

appJs += lidasFunctions;
console.log('5. Funções de lidas adicionadas ao app.js!');

// Modify renderizarLicitacoes to include read status
// Find the card creation in renderizar and add lida class and button
appJs = appJs.replace(
    /card\.className = 'licitacao-card';/g,
    `const lidaClass = isLida(licitacao.cnpj, licitacao.anoCompra, licitacao.sequencialCompra) ? ' lida' : '';
            card.className = 'licitacao-card' + lidaClass;`
);

// Add button in footer - find btn-ver-itens and add before it
appJs = appJs.replace(
    /<button class="btn-ver-itens"/g,
    `<button class="btn-marcar-lida\${isLida(licitacao.cnpj, licitacao.anoCompra, licitacao.sequencialCompra) ? ' lida' : ''}"
                        onclick="toggleLida('\${licitacao.cnpj}', \${licitacao.anoCompra}, \${licitacao.sequencialCompra}, this)">
                        \${isLida(licitacao.cnpj, licitacao.anoCompra, licitacao.sequencialCompra) ? '✓ Lida' : '👁 Marcar lida'}
                    </button>
                    <button class="btn-ver-itens"`
);

// Store results for counter
appJs = appJs.replace(
    /function renderizarLicitacoes\(licitacoes\) \{/,
    `function renderizarLicitacoes(licitacoes) {
    todasLicitacoesAtuais = licitacoes;`
);

// Call counter update after rendering
appJs = appJs.replace(
    /resultsContainer\.appendChild\(card\);\s*\}/,
    `resultsContainer.appendChild(card);
    }
    atualizarContadorLidas();`
);

fs.writeFileSync('public/app.js', appJs);
console.log('6. Renderização com lidas atualizada!');

console.log('\n✅ Feature de licitações lidas implementada!');
