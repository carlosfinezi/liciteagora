const Database = require('better-sqlite3');
const db = new Database('./pncp.db');

// Buscar licitações a monitorar
const rows = db.prepare('SELECT id, cnpjOrgao, sequencial, ano, urlCompra FROM licitacoes_monitorar WHERE ativo = 1').all();
console.log('Licitações monitoradas:');
console.log(JSON.stringify(rows, null, 2));

// Para cada licitação, corrigir a URL
for (const row of rows) {
  const cnpj = (row.cnpjOrgao || '').replace(/[^\d]/g, '').padStart(10, '0').slice(-10);
  const sequencial = String(row.sequencial).padStart(5, '0');
  const ano = String(row.ano);
  const compra = cnpj + sequencial + ano;
  const urlCorreta = `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/acompanhamento-compra?compra=${compra}`;

  console.log(`\nID ${row.id}:`);
  console.log(`  CNPJ: ${cnpj}`);
  console.log(`  Sequencial: ${sequencial}`);
  console.log(`  Ano: ${ano}`);
  console.log(`  Compra: ${compra} (${compra.length} dígitos)`);
  console.log(`  URL antiga: ${row.urlCompra}`);
  console.log(`  URL correta: ${urlCorreta}`);

  // Atualizar no banco
  db.prepare('UPDATE licitacoes_monitorar SET urlCompra = ? WHERE id = ?').run(urlCorreta, row.id);
  console.log(`  ✅ URL atualizada!`);
}

// Verificar após atualização
const rowsAtualizados = db.prepare('SELECT id, urlCompra FROM licitacoes_monitorar').all();
console.log('\n\nURLs atualizadas:');
console.log(JSON.stringify(rowsAtualizados, null, 2));

db.close();
