const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

// 1. Add CSS
const cssToAdd = `
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
`;

html = html.replace('</style>\n</head>', cssToAdd + '    </style>\n</head>');
console.log('CSS adicionado!');

// 2. Update results info with filter
html = html.replace(
    /<div id="resultsInfo" style="display: none;" class="results-info">\s*<div class="results-count">\s*<span id="resultsCount">0<\/span> licitações encontradas\s*<\/div>\s*<div>Página <span id="currentPage">1<\/span><\/div>\s*<\/div>/,
    `<div id="resultsInfo" style="display: none;" class="results-info">
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
        </div>`
);
console.log('Filtro de lidas adicionado!');

fs.writeFileSync('public/index.html', html);
console.log('HTML atualizado!');
