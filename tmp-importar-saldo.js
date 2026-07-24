const fs = require('fs');
const Database = require('better-sqlite3');
const { calcularContextoMovimento } = require('./estoque-routes');

// Re-parse CSV (já foi limpo e importado o produtos; aqui só precisamos do sku + estoque)
const CSV_PATH = '/tmp/leao-prod-csv/listagem.csv';
const DB_PATH = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants/leao-acessorios/pncp.db';
const EXEC = process.argv.includes('--exec');

let raw = fs.readFileSync(CSV_PATH, 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

function parseCsv(txt, sep = ';') {
  const rows = [];
  let row = [], cur = '', inQ = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i], n = txt[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === sep) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') {
        if (cur !== '' || row.length) { row.push(cur); rows.push(row); row = []; cur = ''; }
        if (c === '\r' && n === '\n') i++;
      } else cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const rows = parseCsv(raw);
const EXPECTED_COLS = 24;
const fixed = [];
for (const r of rows) {
  if (r.length === EXPECTED_COLS) fixed.push(r);
  else if (r.length > EXPECTED_COLS) {
    const excesso = r.length - EXPECTED_COLS;
    fixed.push([r.slice(0, excesso + 1).join(';'), ...r.slice(excesso + 1)]);
  }
}
const data = fixed.slice(1);

const db = new Database(DB_PATH);

// Mapeia sku → produtoId
const produtosPorSku = new Map();
db.prepare('SELECT id, sku, precoCusto FROM produtos').all().forEach(p => {
  produtosPorSku.set(p.sku, { id: p.id, precoCusto: p.precoCusto || 0 });
});
console.log('Produtos no banco:', produtosPorSku.size);

const HOJE = new Date().toISOString().slice(0, 10);

// Classifica
let comPositivo = 0, zerados = 0, comNegativo = 0, semProduto = 0;
const lotes = [];
for (const r of data) {
  const sku = (r[4] || '').trim();
  const prod = produtosPorSku.get(sku);
  if (!prod) { semProduto++; continue; }
  const est = parseFloat(String(r[2] || '0').replace(',', '.')) || 0;
  if (est > 0) comPositivo++;
  else if (est < 0) comNegativo++;
  else { zerados++; continue; }
  lotes.push({ produtoId: prod.id, sku, estoque: est, custo: prod.precoCusto });
}

console.log('Com estoque > 0:', comPositivo);
console.log('Com estoque < 0:', comNegativo);
console.log('Zerados (pulados):', zerados);
console.log('SKU na planilha mas não no banco:', semProduto);
console.log('Total de movimentos a lançar:', lotes.length);

if (!EXEC) {
  console.log('\n(DRY RUN — adicione --exec)');
  process.exit(0);
}

const stmtEntrada = db.prepare(`INSERT INTO movimentacoes_estoque
  (produtoId, tipo, quantidade, custoUnitario, origem, observacao, data,
   custoMedioAnterior, custoMedioPosterior, saldoPosterior)
  VALUES (?, 'entrada', ?, ?, 'importacao-saldo-inicial', ?, ?, ?, ?, ?)`);

const stmtAjuste = db.prepare(`INSERT INTO movimentacoes_estoque
  (produtoId, tipo, quantidade, custoUnitario, origem, observacao, data,
   custoMedioAnterior, custoMedioPosterior, saldoPosterior)
  VALUES (?, 'ajuste', ?, ?, 'importacao-saldo-inicial', ?, ?, ?, ?, ?)`);

const tx = db.transaction(() => {
  let okPos = 0, okNeg = 0, erros = [];
  for (const l of lotes) {
    try {
      if (l.estoque > 0) {
        const ctx = calcularContextoMovimento(db, l.produtoId, 'entrada', l.estoque, l.custo || null);
        stmtEntrada.run(
          l.produtoId, l.estoque, l.custo || null,
          'Saldo inicial importado do sistema antigo', HOJE,
          ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
        );
        okPos++;
      } else {
        // estoque negativo — lança ajuste com delta negativo para chegar no valor
        const ctx = calcularContextoMovimento(db, l.produtoId, 'ajuste', l.estoque, null);
        stmtAjuste.run(
          l.produtoId, l.estoque, null,
          'Saldo inicial importado (negativo herdado do sistema antigo)', HOJE,
          ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior
        );
        okNeg++;
      }
    } catch (e) {
      erros.push({ sku: l.sku, est: l.estoque, erro: e.message });
    }
  }
  return { okPos, okNeg, erros };
});

const r = tx();
console.log('\n=== RESULTADO ===');
console.log('Entradas (positivos) inseridas:', r.okPos);
console.log('Ajustes (negativos) inseridos :', r.okNeg);
console.log('Erros                         :', r.erros.length);
r.erros.slice(0, 10).forEach(e => console.log(' ', e.sku, '→', e.est, ':', e.erro));

// Sanity check
const totMov = db.prepare('SELECT COUNT(*) c FROM movimentacoes_estoque').get().c;
const saldoNeg = db.prepare(`
  SELECT COUNT(DISTINCT produtoId) c FROM movimentacoes_estoque
   WHERE saldoPosterior < 0
`).get().c;
const saldoTotal = db.prepare(`
  SELECT SUM(qtd) total FROM (
    SELECT produtoId, SUM(CASE tipo WHEN 'entrada' THEN quantidade
                                    WHEN 'saida' THEN -quantidade
                                    WHEN 'ajuste' THEN quantidade
                                    ELSE 0 END) qtd
    FROM movimentacoes_estoque GROUP BY produtoId
  )
`).get().total;
console.log('\nTotal movimentacoes_estoque no banco:', totMov);
console.log('Produtos com saldo negativo             :', saldoNeg);
console.log('Soma total de unidades em estoque       :', saldoTotal);
db.close();
