const fs = require('fs');
let server = fs.readFileSync('server.js', 'utf8');

const oldCode = `  CREATE INDEX IF NOT EXISTS idx_interesse_licitacao ON interesse(cnpj, ano, sequencial);

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
  db.exec('CREATE INDEX IF NOT EXISTS idx_lida_licitacao ON licitacao_lida(cnpj, ano, sequencial)');
\`);`;

const newCode = `  CREATE INDEX IF NOT EXISTS idx_interesse_licitacao ON interesse(cnpj, ano, sequencial);

  CREATE TABLE IF NOT EXISTS licitacao_lida (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cnpj TEXT NOT NULL,
    ano INTEGER NOT NULL,
    sequencial INTEGER NOT NULL,
    dataLeitura TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(cnpj, ano, sequencial)
  );

  CREATE INDEX IF NOT EXISTS idx_lida_licitacao ON licitacao_lida(cnpj, ano, sequencial);
\`);`;

if (server.includes(oldCode)) {
    server = server.replace(oldCode, newCode);
    fs.writeFileSync('server.js', server);
    console.log('Server.js corrigido!');
} else {
    console.log('Padrão não encontrado. Verificando...');
    // Check if already fixed
    if (server.includes('CREATE TABLE IF NOT EXISTS licitacao_lida') &&
        !server.includes('// Tabela para marcar licitações lidas\n  db.exec')) {
        console.log('Já está corrigido!');
    } else {
        console.log('Precisa corrigir manualmente');
    }
}
