const db = require('better-sqlite3')('./pncp.db');

const msgs = db.prepare(`
  SELECT id, cnpjOrgao, ano, sequencial, remetente, mensagem, origemCaptura, dataCaptura
  FROM chat_mensagens
  ORDER BY id DESC
`).all();

console.log('='.repeat(80));
console.log('MENSAGENS NO BANCO DE DADOS');
console.log('='.repeat(80));
console.log('Total de mensagens:', msgs.length);
console.log('');

msgs.forEach(m => {
  console.log('-'.repeat(80));
  console.log('ID:', m.id);
  console.log('Licitação:', m.sequencial + '/' + m.ano + ' (Órgão: ' + m.cnpjOrgao + ')');
  console.log('Remetente:', m.remetente);
  console.log('Mensagem:', m.mensagem);
  console.log('Origem:', m.origemCaptura);
  console.log('Capturada em:', m.dataCaptura);
});

console.log('='.repeat(80));
db.close();
