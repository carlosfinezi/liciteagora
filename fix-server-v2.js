const fs = require('fs');
let server = fs.readFileSync('server.js', 'utf8');

// Use regex to find and fix the problematic section
const regex = /(\s*CREATE INDEX IF NOT EXISTS idx_interesse_licitacao ON interesse\(cnpj, ano, sequencial\);)\s*\/\/ Tabela para marcar licitações lidas\s*db\.exec\(`\s*(CREATE TABLE IF NOT EXISTS licitacao_lida[\s\S]*?)\s*`\);\s*db\.exec\('(CREATE INDEX IF NOT EXISTS idx_lida_licitacao[\s\S]*?)'\);\s*`\)/;

const match = server.match(regex);
if (match) {
    console.log('Encontrado! Corrigindo...');
    server = server.replace(regex, `$1

  $2;

  $3;
\`)`);
    fs.writeFileSync('server.js', server);
    console.log('Corrigido!');
} else {
    console.log('Regex não encontrou. Mostrando o trecho problemático:');
    const idx = server.indexOf('idx_interesse_licitacao');
    if (idx > -1) {
        console.log(server.substring(idx - 10, idx + 400));
    }
}
