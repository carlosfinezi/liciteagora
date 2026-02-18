const fs = require('fs');

// 1. Remove checkbox from HTML
let html = fs.readFileSync('public/index.html', 'utf8');

// Find and remove the busca detalhada div
const checkboxRegex = /<div style="margin-top: 20px; padding: 15px; background: #fff3cd;[\s\S]*?Busca Detalhada nos Itens\/Lotes[\s\S]*?<\/div>\s*<\/div>\s*<\/label>\s*<\/div>/;

if (checkboxRegex.test(html)) {
    html = html.replace(checkboxRegex, '');
    console.log('1. Checkbox removido do HTML!');
} else {
    console.log('1. Checkbox não encontrado no HTML');
}

fs.writeFileSync('public/index.html', html);

// 2. Update server.js to always use detailed search
let server = fs.readFileSync('server.js', 'utf8');

// Change the condition to always use detailed search when there's a keyword
const oldCondition = `if (usarBuscaDetalhada && palavraChave) {`;
const newCondition = `if (palavraChave) {
      // Sempre usa busca detalhada (inclui itens)`;

if (server.includes(oldCondition)) {
    server = server.replace(oldCondition, newCondition);
    console.log('2. Server atualizado para sempre usar busca detalhada!');
} else {
    console.log('2. Condição não encontrada no server');
}

// Remove the else if for simple search (it's now dead code)
const oldElseIf = `    } else if (palavraChave) {
      const palavraParam = \`%\${palavraChave.toLowerCase()}%\`;
      sql = \`
        SELECT * FROM licitacoes
        \${whereClause}
        \${conditions.length > 0 ? 'AND' : 'WHERE'} (
          LOWER(objetoCompra) LIKE ?
          OR LOWER(informacaoComplementar) LIKE ?
          OR LOWER(razaoSocial) LIKE ?
          OR LOWER(nomeUnidade) LIKE ?
        )
        ORDER BY dataEncerramentoProposta ASC
      \`;
      params.push(palavraParam, palavraParam, palavraParam, palavraParam);
    } else {`;

const newElse = `    } else {`;

if (server.includes(oldElseIf)) {
    server = server.replace(oldElseIf, newElse);
    console.log('3. Código de busca simples removido!');
} else {
    console.log('3. Código de busca simples não encontrado');
}

fs.writeFileSync('server.js', server);

console.log('\nCheckbox de busca detalhada removido!');
console.log('Agora todas as buscas incluem os itens automaticamente.');
