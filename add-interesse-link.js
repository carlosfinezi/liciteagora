const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

// Adicionar CSS para header flexbox
const headerCss = `
        header {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            margin-bottom: 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .btn-interesses {
            padding: 12px 25px;
            background: #4caf50;
            color: white;
            border: none;
            border-radius: 5px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }

        .btn-interesses:hover {
            background: #43a047;
        }`;

const oldHeaderCss = `        header {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
            margin-bottom: 20px;
        }`;

html = html.replace(oldHeaderCss, headerCss);

// Atualizar estrutura do header HTML
const oldHeader = `        <header>
            <h1>Portal de Consulta de Licitações - PNCP</h1>
            <p class="subtitle">Portal Nacional de Contratações Públicas</p>
        </header>`;

const newHeader = `        <header>
            <div>
                <h1>Portal de Consulta de Licitações - PNCP</h1>
                <p class="subtitle">Portal Nacional de Contratações Públicas</p>
            </div>
            <a href="/interesse.html" class="btn-interesses">⭐ Meus Interesses</a>
        </header>`;

html = html.replace(oldHeader, newHeader);

fs.writeFileSync('public/index.html', html);
console.log('Link para interesses adicionado no header!');
