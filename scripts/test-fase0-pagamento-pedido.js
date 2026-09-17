/**
 * Fase 0 — sincronização do pagamento da CR com o pedido.
 *
 * Cobre a correção de `sincronizarPagamentoPedido` (contas-receber-routes.js):
 * até 2026-09-10 ela abandonava na primeira linha toda CR sem `faturaId`, e é
 * assim que a loja virtual e o faturamento de OS ligam a cobrança ao pedido.
 * Resultado medido em produção: CR paga, pedido em `valorPago = 0`.
 *
 * Testa a função diretamente, com o estado de CR que `registrarBaixaCR` produz
 * (`valorPago` e `status` na conta). O que está sob teste é a agregação e a
 * idempotência, não a mecânica de baixa — essa tem cobertura própria.
 *
 * Schema: gere antes o dump de um tenant real —
 *   sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/app-backend-schema.sql
 */
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = '/tmp/app-backend-schema.sql';
if (!fs.existsSync(SCHEMA)) {
  console.error(`schema ausente: ${SCHEMA}\n  sqlite3 data/tenants/1bit/pncp.db .schema > ${SCHEMA}`);
  process.exit(2);
}
const DB = '/tmp/fase0-pagamento.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(fs.readFileSync(SCHEMA, 'utf8')
  .split(/;\s*\n/)
  .filter((s) => !/sqlite_sequence/i.test(s))
  .join(';\n'));

const { sincronizarPagamentoPedido } = require('../contas-receber-routes');

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

db.prepare("INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, ativo) VALUES (1,'00000000000191','PJ','Cliente Teste',1)").run();

let seqPedido = 0;
const novoPedido = (valorTotal, status = 'confirmado') => {
  seqPedido += 1;
  return db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, valorTotal)
    VALUES (?, 'manual', 'pedido', 1, ?, date('now'), ?)`)
    .run(`PED-2026-${String(seqPedido).padStart(5, '0')}`, status, valorTotal).lastInsertRowid;
};
const novaFatura = (pedidoId, valor) => db.prepare(
  `INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento, valorBruto, valorTotal, status)
   VALUES (?, ?, 1, date('now'), date('now'), ?, ?, 'aberta')`)
  .run(`FAT-${pedidoId}`, pedidoId, valor, valor).lastInsertRowid;

/** Cria a CR como o ERP cria: `pedidoId` direto (loja/OS) ou via `faturaId`. */
const novaCR = ({ pedidoId = null, faturaId = null, valor, valorPago = 0, status = 'aberta', origem = 'loja' }) =>
  db.prepare(`INSERT INTO contas_a_receber
    (pessoaId, descricao, valor, valorPago, dataEmissao, dataVencimento, status, origem, origemTipo, pedidoId, faturaId)
    VALUES (1, ?, ?, ?, date('now'), date('now'), ?, ?, 'pedido', ?, ?)`)
    .run(`CR de teste`, valor, valorPago, status, origem, pedidoId, faturaId).lastInsertRowid;

/** Estado do pedido depois da sincronização. */
const estado = (pedidoId) => db.prepare('SELECT valorPago, statusPagamento FROM pedidos WHERE id = ?').get(pedidoId);

// Simula o que registrarBaixaCR grava na conta ao dar baixa.
const baixar = (crId, valorPago) => {
  const cr = db.prepare('SELECT valor FROM contas_a_receber WHERE id = ?').get(crId);
  const status = valorPago >= cr.valor - 0.01 ? 'paga' : (valorPago > 0 ? 'parcial' : 'aberta');
  db.prepare('UPDATE contas_a_receber SET valorPago = ?, status = ? WHERE id = ?').run(valorPago, status, crId);
};

// ---------- A. vínculo direto por pedidoId (loja virtual e OS) ----------
t('A1. CR direta por pedidoId, ainda nao paga: pedido segue pendente e zerado', () => {
  const p = novoPedido(300);
  const cr = novaCR({ pedidoId: p, valor: 300 });
  sincronizarPagamentoPedido(db, cr);
  const e = estado(p);
  assert(e.valorPago === 0, 'valorPago=' + e.valorPago);
  assert(e.statusPagamento === 'pendente', 'status=' + e.statusPagamento);
});

t('A2. pagamento PARCIAL da CR direta reflete no pedido', () => {
  const p = novoPedido(300);
  const cr = novaCR({ pedidoId: p, valor: 300 });
  baixar(cr, 100);
  sincronizarPagamentoPedido(db, cr);
  const e = estado(p);
  assert(e.valorPago === 100, 'valorPago=' + e.valorPago);
  assert(e.statusPagamento === 'parcial', 'status=' + e.statusPagamento);
});

t('A3. pagamento TOTAL da CR direta marca o pedido como pago', () => {
  const p = novoPedido(300);
  const cr = novaCR({ pedidoId: p, valor: 300 });
  baixar(cr, 300);
  sincronizarPagamentoPedido(db, cr);
  const e = estado(p);
  assert(e.valorPago === 300, 'valorPago=' + e.valorPago);
  assert(e.statusPagamento === 'pago', 'status=' + e.statusPagamento);
  // É este o caso que estava quebrado: era exatamente aqui que o pedido da loja
  // virtual continuava 'pendente' depois do Pix compensado.
});

// ---------- B. várias CRs para o mesmo pedido ----------
t('B1. duas CRs diretas somam — nao vale a ultima processada', () => {
  const p = novoPedido(500);
  const cr1 = novaCR({ pedidoId: p, valor: 200 });
  const cr2 = novaCR({ pedidoId: p, valor: 300 });
  baixar(cr1, 200);
  sincronizarPagamentoPedido(db, cr1);
  assert(estado(p).valorPago === 200, 'apos a 1a: ' + estado(p).valorPago);
  baixar(cr2, 300);
  sincronizarPagamentoPedido(db, cr2);
  const e = estado(p);
  assert(e.valorPago === 500, 'valorPago=' + e.valorPago + ' (esperado 500, a soma das duas)');
  assert(e.statusPagamento === 'pago', 'status=' + e.statusPagamento);
});

t('B2. CR direta + CR pela fatura no MESMO pedido somam sem duplicar', () => {
  // O caso real do tenant raeldouglas, pedido 3: pecas pela fatura, servicos
  // direto. Uma das CRs tem os DOIS vinculos, e nao pode contar duas vezes.
  const p = novoPedido(280);
  const f = novaFatura(p, 280);
  const crFat = novaCR({ pedidoId: p, faturaId: f, valor: 120, origem: 'os_pecas' });
  const crDir = novaCR({ pedidoId: p, valor: 160, origem: 'os_servicos' });
  baixar(crFat, 120);
  baixar(crDir, 160);
  sincronizarPagamentoPedido(db, crDir);
  const e = estado(p);
  assert(e.valorPago === 280, 'valorPago=' + e.valorPago + ' (120 + 160, sem duplicar a que tem os dois vinculos)');
  assert(e.statusPagamento === 'pago', 'status=' + e.statusPagamento);
});

t('B3. CR cancelada nao entra na soma', () => {
  const p = novoPedido(500);
  const cr1 = novaCR({ pedidoId: p, valor: 200 });
  const cr2 = novaCR({ pedidoId: p, valor: 300 });
  baixar(cr1, 200);
  baixar(cr2, 300);
  db.prepare("UPDATE contas_a_receber SET status = 'cancelada' WHERE id = ?").run(cr2);
  sincronizarPagamentoPedido(db, cr1);
  const e = estado(p);
  assert(e.valorPago === 200, 'valorPago=' + e.valorPago);
  assert(e.statusPagamento === 'parcial', 'status=' + e.statusPagamento);
});

// ---------- C. idempotência ----------
t('C1. reprocessar a MESMA baixa nao soma duas vezes', () => {
  const p = novoPedido(300);
  const cr = novaCR({ pedidoId: p, valor: 300 });
  baixar(cr, 300);
  for (let i = 0; i < 5; i++) sincronizarPagamentoPedido(db, cr);
  assert(estado(p).valorPago === 300, 'valorPago=' + estado(p).valorPago + ' apos 5 sincronizacoes');
});

// ---------- D. estorno e cancelamento ----------
t('D1. estorno da baixa devolve o pedido a pendente', () => {
  const p = novoPedido(300);
  const cr = novaCR({ pedidoId: p, valor: 300 });
  baixar(cr, 300);
  sincronizarPagamentoPedido(db, cr);
  assert(estado(p).statusPagamento === 'pago', 'nao chegou a pago');
  // estornarBaixaCR devolve a conta para 'aberta' com valorPago = 0 e chama a
  // sincronizacao; aqui reproduzimos esse estado final.
  baixar(cr, 0);
  sincronizarPagamentoPedido(db, cr);
  const e = estado(p);
  assert(e.valorPago === 0, 'valorPago=' + e.valorPago);
  assert(e.statusPagamento === 'pendente', 'status=' + e.statusPagamento);
});

t('D2. estorno parcial deixa o pedido em parcial', () => {
  const p = novoPedido(300);
  const cr1 = novaCR({ pedidoId: p, valor: 150 });
  const cr2 = novaCR({ pedidoId: p, valor: 150 });
  baixar(cr1, 150);
  baixar(cr2, 150);
  sincronizarPagamentoPedido(db, cr1);
  assert(estado(p).statusPagamento === 'pago', 'nao chegou a pago');
  baixar(cr2, 0);
  sincronizarPagamentoPedido(db, cr2);
  const e = estado(p);
  assert(e.valorPago === 150, 'valorPago=' + e.valorPago);
  assert(e.statusPagamento === 'parcial', 'status=' + e.statusPagamento);
});

// ---------- E. compatibilidade: o caminho antigo (fatura) segue igual ----------
t('E1. CR pela FATURA continua refletindo no pedido (comportamento legado)', () => {
  const p = novoPedido(1000);
  const f = novaFatura(p, 1000);
  const cr = novaCR({ pedidoId: null, faturaId: f, valor: 1000, origem: 'fatura' });
  baixar(cr, 1000);
  sincronizarPagamentoPedido(db, cr);
  const e = estado(p);
  assert(e.valorPago === 1000, 'valorPago=' + e.valorPago);
  assert(e.statusPagamento === 'pago', 'status=' + e.statusPagamento);
});

t('E2. parcelas da MESMA fatura somam (comportamento legado preservado)', () => {
  const p = novoPedido(900);
  const f = novaFatura(p, 900);
  const c1 = novaCR({ faturaId: f, valor: 300, origem: 'fatura' });
  const c2 = novaCR({ faturaId: f, valor: 300, origem: 'fatura' });
  const c3 = novaCR({ faturaId: f, valor: 300, origem: 'fatura' });
  baixar(c1, 300); baixar(c2, 300);
  sincronizarPagamentoPedido(db, c2);
  assert(estado(p).valorPago === 600, 'parcial=' + estado(p).valorPago);
  assert(estado(p).statusPagamento === 'parcial', 'status=' + estado(p).statusPagamento);
  baixar(c3, 300);
  sincronizarPagamentoPedido(db, c3);
  assert(estado(p).valorPago === 900, 'total=' + estado(p).valorPago);
  assert(estado(p).statusPagamento === 'pago', 'status=' + estado(p).statusPagamento);
});

// ---------- F. o que NÃO pode ser tocado ----------
t('F1. CR sem pedido e sem fatura nao altera pedido nenhum', () => {
  const p = novoPedido(300);
  db.prepare('UPDATE pedidos SET valorPago = 77, statusPagamento = ? WHERE id = ?').run('parcial', p);
  const cr = novaCR({ valor: 500, origem: 'avulsa' });
  baixar(cr, 500);
  sincronizarPagamentoPedido(db, cr);
  const e = estado(p);
  assert(e.valorPago === 77, 'mexeu em pedido alheio: ' + e.valorPago);
  assert(e.statusPagamento === 'parcial', 'status=' + e.statusPagamento);
});

t('F2. pedido CANCELADO nao e alterado pela baixa', () => {
  const p = novoPedido(300, 'cancelado');
  const cr = novaCR({ pedidoId: p, valor: 300 });
  baixar(cr, 300);
  sincronizarPagamentoPedido(db, cr);
  const e = estado(p);
  assert((e.valorPago || 0) === 0, 'valorPago=' + e.valorPago);
});

t('F3. CR inexistente nao quebra e nao escreve', () => {
  const antes = db.prepare('SELECT COUNT(*) n FROM pedidos WHERE COALESCE(valorPago,0) > 0').get().n;
  sincronizarPagamentoPedido(db, 999999);
  const depois = db.prepare('SELECT COUNT(*) n FROM pedidos WHERE COALESCE(valorPago,0) > 0').get().n;
  assert(antes === depois, 'alterou pedido a partir de CR inexistente');
});

t('F4. pedido de OUTRA CR nao e afetado pela soma', () => {
  const pA = novoPedido(100);
  const pB = novoPedido(100);
  const crA = novaCR({ pedidoId: pA, valor: 100 });
  const crB = novaCR({ pedidoId: pB, valor: 100 });
  baixar(crA, 100);
  sincronizarPagamentoPedido(db, crA);
  assert(estado(pA).valorPago === 100, 'A=' + estado(pA).valorPago);
  assert((estado(pB).valorPago || 0) === 0, 'B vazou: ' + estado(pB).valorPago);
  baixar(crB, 100);
  sincronizarPagamentoPedido(db, crB);
  assert(estado(pA).valorPago === 100, 'A mudou: ' + estado(pA).valorPago);
  assert(estado(pB).valorPago === 100, 'B=' + estado(pB).valorPago);
});

console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
