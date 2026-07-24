/**
 * Backfill saldoPosterior / custoMedioAnterior / custoMedioPosterior
 * em movimentacoes_estoque para os registros existentes.
 *
 * Ordena por produto + data + id e recalcula progressivamente.
 *
 * Uso: node scripts/backfill-estoque-custos.js
 */

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'pncp.db');
const db = new Database(dbPath);

console.log('Conectado em', dbPath);

// Pega produtos que têm movimentações
const produtos = db.prepare(`
  SELECT DISTINCT produtoId FROM movimentacoes_estoque ORDER BY produtoId
`).all();

console.log(`Produtos com movimentação: ${produtos.length}`);

let totalMovs = 0;
let totalProdutos = 0;

const update = db.prepare(`
  UPDATE movimentacoes_estoque
  SET saldoPosterior = ?, custoMedioAnterior = ?, custoMedioPosterior = ?
  WHERE id = ?
`);

const trx = db.transaction(() => {
  for (const { produtoId } of produtos) {
    const movs = db.prepare(`
      SELECT id, tipo, quantidade, custoUnitario
      FROM movimentacoes_estoque
      WHERE produtoId = ?
      ORDER BY data ASC, id ASC
    `).all(produtoId);

    let saldo = 0;
    let custoMedio = 0;

    for (const m of movs) {
      const qtd = Number(m.quantidade);
      const custoAntes = custoMedio;
      const saldoAntes = saldo;

      if (m.tipo === 'entrada') {
        saldo += qtd;
        if (m.custoUnitario != null && saldo > 0) {
          if (saldoAntes <= 0 || custoAntes <= 0) {
            custoMedio = Number(m.custoUnitario);
          } else {
            custoMedio = (saldoAntes * custoAntes + qtd * Number(m.custoUnitario)) / saldo;
          }
        }
      } else if (m.tipo === 'saida') {
        saldo -= qtd;
        // custoMedio não muda em saída
      } else if (m.tipo === 'ajuste') {
        saldo += qtd;
        // custoMedio não muda em ajuste
      }

      update.run(
        saldo,
        custoAntes || null,
        custoMedio || null,
        m.id
      );
      totalMovs++;
    }
    totalProdutos++;
  }
});

console.log('Iniciando transação...');
const t0 = Date.now();
trx();
const dt = Date.now() - t0;

console.log(`Backfill concluído em ${dt}ms`);
console.log(`${totalMovs} movimentações atualizadas em ${totalProdutos} produtos`);

db.close();
