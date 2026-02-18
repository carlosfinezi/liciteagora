const path = require('path');
const dbPath = path.join(__dirname, 'erp.db');
console.log('Usando banco:', dbPath);
const db = require('better-sqlite3')(dbPath);

// Verificar estrutura atual
const info = db.pragma('table_info(grupos_palavras)');
console.log('Estrutura atual da tabela:');
info.forEach(col => console.log(`  - ${col.name} (${col.type})`));

// Verificar se coluna tipo existe
const temTipo = info.some(col => col.name === 'tipo');

if (!temTipo) {
  console.log('\nAdicionando coluna tipo...');
  db.exec("ALTER TABLE grupos_palavras ADD COLUMN tipo TEXT DEFAULT 'pesquisa'");
  console.log('Coluna tipo adicionada com sucesso!');

  // Atualizar registros existentes
  db.exec("UPDATE grupos_palavras SET tipo = 'pesquisa' WHERE tipo IS NULL");
  console.log('Registros existentes atualizados para tipo=pesquisa');
} else {
  console.log('\nColuna tipo já existe');
}

// Mostrar estrutura final
const infoFinal = db.pragma('table_info(grupos_palavras)');
console.log('\nEstrutura final:');
infoFinal.forEach(col => console.log(`  - ${col.name} (${col.type})`));

// Mostrar dados
const grupos = db.prepare('SELECT id, nome, tipo FROM grupos_palavras').all();
console.log('\nGrupos existentes:');
grupos.forEach(g => console.log(`  - ${g.id}: ${g.nome} (tipo: ${g.tipo})`));

db.close();
