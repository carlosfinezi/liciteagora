const Database = require('better-sqlite3');
const db = new Database('pncp.db');

// Verificar licitações sem itens
console.log('=== LICITAÇÕES SEM ITENS ===\n');

const semItens = db.prepare(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN date(dataPublicacaoPncp) >= '2026-01-06' THEN 1 ELSE 0 END) as recentes
  FROM licitacoes l
  WHERE NOT EXISTS (SELECT 1 FROM itens i WHERE i.licitacaoId = l.id)
`).get();

console.log(`Total de licitações sem itens: ${semItens.total}`);
console.log(`Publicadas desde 06/01/2026: ${semItens.recentes}`);

// Licitações recentes sem itens por modalidade
console.log('\n=== LICITAÇÕES RECENTES SEM ITENS (desde 06/01) ===\n');

const recentesSemItens = db.prepare(`
  SELECT modalidadeNome, COUNT(*) as qtd
  FROM licitacoes l
  WHERE NOT EXISTS (SELECT 1 FROM itens i WHERE i.licitacaoId = l.id)
    AND date(dataPublicacaoPncp) >= '2026-01-06'
  GROUP BY modalidadeNome
  ORDER BY qtd DESC
`).all();

recentesSemItens.forEach(m => {
  console.log(`  ${m.modalidadeNome}: ${m.qtd}`);
});

// Exemplo de licitações recentes sem itens
console.log('\n=== EXEMPLOS DE LICITAÇÕES RECENTES SEM ITENS ===\n');

const exemplos = db.prepare(`
  SELECT l.id, l.cnpj, l.anoCompra, l.sequencialCompra, l.nomeUnidade, l.objetoCompra,
         l.dataPublicacaoPncp, l.modalidadeNome
  FROM licitacoes l
  WHERE NOT EXISTS (SELECT 1 FROM itens i WHERE i.licitacaoId = l.id)
    AND date(dataPublicacaoPncp) >= '2026-01-06'
    AND l.modalidadeId = 6
  ORDER BY l.dataPublicacaoPncp DESC
  LIMIT 10
`).all();

exemplos.forEach((l, i) => {
  console.log(`${i+1}. ${l.nomeUnidade}`);
  console.log(`   ID: ${l.id} | CNPJ: ${l.cnpj} | Ano: ${l.anoCompra} | Seq: ${l.sequencialCompra}`);
  console.log(`   Publicação: ${l.dataPublicacaoPncp}`);
  console.log(`   Objeto: ${l.objetoCompra?.substring(0, 80)}...`);
  console.log('');
});

db.close();
