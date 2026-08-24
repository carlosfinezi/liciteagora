/**
 * Teste isolado do vínculo venda perdida × pedido de venda.
 * Roda contra um SQLite temporário com o schema real do tenant.
 */
const fs = require('fs');
const Database = require('better-sqlite3');
const {
  migrarPrecosDB, registrarPerdasDePedido, estornarPerdasDePedido, itensElegiveisPerda,
} = require('../precos-routes');

const DB = '/tmp/vp-teste.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync('/tmp/vp-schema.sql', 'utf8'));
// pedidos.participacaoId aponta pra cá; com foreign_keys=ON a tabela
// precisa existir mesmo sem uso no teste.
db.exec('CREATE TABLE IF NOT EXISTS participacoes_comprasnet (id INTEGER PRIMARY KEY AUTOINCREMENT)');

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

// ---------- 1. migração ----------
t('migração cria colunas de vínculo', () => {
  migrarPrecosDB(db);
  const cols = db.prepare('PRAGMA table_info(vendas_perdidas)').all().map(c => c.name);
  for (const c of ['pedidoId', 'pedidoItemId', 'pedidoNumero', 'concorrente']) {
    assert(cols.includes(c), 'faltou coluna ' + c);
  }
});

t('migração é idempotente (roda 2x sem erro)', () => {
  migrarPrecosDB(db);
  migrarPrecosDB(db);
});

// ---------- seed ----------
db.prepare("INSERT INTO pessoas (id, cpfCnpj, razaoSocial, tipo) VALUES (1,'00000000000191','Cliente Teste','cliente')").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, precoVenda, ativo) VALUES (1,'SKU-1','Produto Um',10,1)").run();
db.prepare("INSERT INTO produtos (id, sku, descricao, precoVenda, ativo) VALUES (2,'SKU-2','Produto Dois',25,1)").run();

function novoPedido(numero, status, modo = 'pedido') {
  const r = db.prepare(`INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido)
    VALUES (?, 'manual', ?, 1, ?, '2026-07-01')`).run(numero, modo, status);
  const pid = r.lastInsertRowid;
  db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?, 1, 'Produto Um', 10, 10, 100)`).run(pid);
  db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?, NULL, 'Item avulso', 4, 25, 100)`).run(pid);
  return pid;
}

// ---------- 2. geração ----------
let p1;
t('registra perda de todos os itens', () => {
  p1 = novoPedido('PED-2026-0001', 'cancelado');
  const out = registrarPerdasDePedido(db, p1, { motivo: 'concorrente', concorrente: 'Fulano SA', origem: 'pedido_cancelado' });
  assert(out.geradas === 2, 'esperava 2 perdas, veio ' + out.geradas);
  const rows = db.prepare('SELECT * FROM vendas_perdidas WHERE pedidoId = ? ORDER BY id').all(p1);
  assert(rows[0].produtoId === 1, 'produtoId nao herdado');
  assert(rows[0].quantidade === 10, 'qtd nao herdada');
  assert(rows[0].precoAlvo === 10, 'preco nao herdado');
  assert(rows[0].clienteId === 1, 'cliente nao herdado');
  assert(rows[0].pedidoNumero === 'PED-2026-0001', 'snapshot do numero faltou');
  assert(rows[0].concorrente === 'Fulano SA', 'concorrente nao gravado');
  assert(rows[1].produtoId === null && rows[1].descricaoLivre === 'Item avulso', 'item avulso nao virou descricaoLivre');
});

t('não duplica ao rodar de novo (cancelar->reabrir->cancelar)', () => {
  const out = registrarPerdasDePedido(db, p1, { motivo: 'preco', origem: 'pedido_cancelado' });
  assert(out.geradas === 0, 'gerou duplicata: ' + out.geradas);
  assert(out.ignorados.length === 2, 'esperava 2 ignorados');
  const n = db.prepare('SELECT COUNT(*) n FROM vendas_perdidas WHERE pedidoId = ?').get(p1).n;
  assert(n === 2, 'total mudou: ' + n);
});

t('índice único barra INSERT direto duplicado', () => {
  const item = db.prepare('SELECT id FROM pedido_itens WHERE pedidoId = ? LIMIT 1').get(p1);
  let barrou = false;
  try {
    db.prepare(`INSERT INTO vendas_perdidas (data, produtoId, quantidade, motivo, pedidoItemId)
      VALUES ('2026-07-31', 1, 1, 'outro', ?)`).run(item.id);
  } catch (e) { barrou = /UNIQUE/.test(e.message); }
  assert(barrou, 'índice único não barrou');
});

// ---------- 3. proteções ----------
t('recusa pedido entregue', () => {
  const p = novoPedido('PED-2026-0002', 'entregue');
  let erro = null;
  try { registrarPerdasDePedido(db, p, { motivo: 'preco' }); } catch (e) { erro = e.message; }
  assert(erro && /concretizada/.test(erro), 'não recusou entregue: ' + erro);
});

t('recusa pedido faturado', () => {
  const p = novoPedido('PED-2026-0003', 'faturado');
  let erro = null;
  try { registrarPerdasDePedido(db, p, { motivo: 'preco' }); } catch (e) { erro = e.message; }
  assert(erro && /concretizada/.test(erro), 'não recusou faturado');
});

t('motivo inválido cai para "outro"', () => {
  const p = novoPedido('PED-2026-0004', 'cancelado');
  registrarPerdasDePedido(db, p, { motivo: 'inventado' });
  const r = db.prepare('SELECT motivo FROM vendas_perdidas WHERE pedidoId = ? LIMIT 1').get(p);
  assert(r.motivo === 'outro', 'motivo virou ' + r.motivo);
});

// ---------- 4. parcial ----------
t('perda parcial respeita a qtd informada e o teto do item', () => {
  const p = novoPedido('PED-2026-0005', 'cancelado');
  const itens = db.prepare('SELECT id, quantidade FROM pedido_itens WHERE pedidoId = ? ORDER BY id').all(p);
  const out = registrarPerdasDePedido(db, p, {
    motivo: 'preco',
    itens: [{ pedidoItemId: itens[0].id, quantidade: 3 }, { pedidoItemId: itens[1].id, quantidade: 999 }],
  });
  assert(out.geradas === 2, 'esperava 2, veio ' + out.geradas);
  const rows = db.prepare('SELECT quantidade FROM vendas_perdidas WHERE pedidoId = ? ORDER BY id').all(p);
  assert(rows[0].quantidade === 3, 'parcial ignorada: ' + rows[0].quantidade);
  assert(rows[1].quantidade === 4, 'teto do item não aplicado: ' + rows[1].quantidade);
});

t('seleção parcial de itens grava só os escolhidos', () => {
  const p = novoPedido('PED-2026-0006', 'cancelado');
  const itens = db.prepare('SELECT id FROM pedido_itens WHERE pedidoId = ? ORDER BY id').all(p);
  const out = registrarPerdasDePedido(db, p, { motivo: 'prazo', itens: [{ pedidoItemId: itens[1].id }] });
  assert(out.geradas === 1, 'esperava 1, veio ' + out.geradas);
});

// ---------- 5. estorno ----------
t('estorno remove automáticas e preserva as manuais', () => {
  const p = novoPedido('PED-2026-0007', 'cancelado');
  const itens = db.prepare('SELECT id FROM pedido_itens WHERE pedidoId = ? ORDER BY id').all(p);
  registrarPerdasDePedido(db, p, { motivo: 'preco', origem: 'pedido_cancelado', itens: [{ pedidoItemId: itens[0].id }] });
  registrarPerdasDePedido(db, p, { motivo: 'preco', origem: 'pedido_item', itens: [{ pedidoItemId: itens[1].id }] });
  const removidas = estornarPerdasDePedido(db, p);
  assert(removidas === 1, 'removeu ' + removidas + ', esperava 1');
  const resto = db.prepare('SELECT origem FROM vendas_perdidas WHERE pedidoId = ?').all(p);
  assert(resto.length === 1 && resto[0].origem === 'pedido_item', 'manual não sobreviveu');
});

t('orçamento perdido também é estornado', () => {
  const p = novoPedido('ORC-2026-0001', 'cancelado', 'orcamento');
  registrarPerdasDePedido(db, p, { motivo: 'concorrente', origem: 'orcamento_perdido' });
  assert(estornarPerdasDePedido(db, p) === 2, 'orcamento_perdido não estornado');
});

// ---------- 6. integridade referencial ----------
t('excluir pedido zera FK mas mantém o rastro (pedidoNumero)', () => {
  const p = novoPedido('PED-2026-0008', 'cancelado');
  registrarPerdasDePedido(db, p, { motivo: 'preco', origem: 'pedido_cancelado' });
  db.prepare('DELETE FROM pedido_itens WHERE pedidoId = ?').run(p);
  db.prepare('DELETE FROM pedidos WHERE id = ?').run(p);
  const rows = db.prepare("SELECT * FROM vendas_perdidas WHERE pedidoNumero = 'PED-2026-0008'").all();
  assert(rows.length === 2, 'perdas sumiram: ' + rows.length);
  assert(rows[0].pedidoId === null && rows[0].pedidoItemId === null, 'FK não virou NULL');
  assert(rows[0].quantidade === 10 && rows[0].precoAlvo === 10, 'snapshot de valor perdido');
});

t('índice único não impede vários registros com pedidoItemId NULL', () => {
  const st = db.prepare(`INSERT INTO vendas_perdidas (data, descricaoLivre, quantidade, motivo, origem)
    VALUES ('2026-07-31', ?, 1, 'outro', 'manual')`);
  st.run('avulsa A'); st.run('avulsa B'); st.run('avulsa C');
  const n = db.prepare("SELECT COUNT(*) n FROM vendas_perdidas WHERE origem='manual'").get().n;
  assert(n === 3, 'esperava 3 avulsas, veio ' + n);
});

// ---------- 7. leitura ----------
t('itensElegiveisPerda marca o que já foi registrado', () => {
  const p = novoPedido('PED-2026-0009', 'cancelado');
  const itens = db.prepare('SELECT id FROM pedido_itens WHERE pedidoId = ? ORDER BY id').all(p);
  registrarPerdasDePedido(db, p, { motivo: 'preco', itens: [{ pedidoItemId: itens[0].id }] });
  const ctx = itensElegiveisPerda(db, p);
  assert(ctx.pedido.numero === 'PED-2026-0009', 'pedido errado');
  assert(ctx.itens.length === 2, 'esperava 2 itens');
  assert(ctx.itens[0].vendaPerdidaId != null, 'item 1 deveria estar marcado');
  assert(ctx.itens[1].vendaPerdidaId == null, 'item 2 não deveria estar marcado');
  assert(ctx.itens[0].sku === 'SKU-1', 'sku não veio no join');
});

t('itensElegiveisPerda devolve null para pedido inexistente', () => {
  assert(itensElegiveisPerda(db, 999999) === null, 'deveria ser null');
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
