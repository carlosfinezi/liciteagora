/**
 * Prova que o verificador do rollout REPROVA quando deve.
 *
 * Um detector que nunca reprovou não prova nada: no relatório 17 §5, um script
 * de hash com SQL inválido devolveu string vazia para todas as tabelas — ou
 * seja, "tudo igual" — e passou por prova até alguém olhar o número. Estes
 * testes existem para que o "hashes iguais" do rollout signifique alguma coisa.
 *
 * Roda inteiro em /tmp, sobre bancos criados aqui. Não toca tenant nenhum.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const r = require(path.join(__dirname, 'rollout-fase1-tenants'));

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, msg) => { if (!c) throw new Error(msg); };

const arquivo = `/tmp/test-rollout-${process.pid}.db`;
const db = new Database(arquivo);
db.exec(`
  CREATE TABLE pedidos (id INTEGER PRIMARY KEY, numero TEXT, status TEXT,
    vendedorId INTEGER, tipo TEXT, valorTotal REAL, valorPago REAL, valorFrete REAL);
  CREATE TABLE pedido_itens (id INTEGER PRIMARY KEY, pedidoId INTEGER, quantidade REAL, valorTotal REAL);
  CREATE TABLE pessoas (id INTEGER PRIMARY KEY, cpfCnpj TEXT, razaoSocial TEXT);
  INSERT INTO pedidos VALUES (1,'P-1','entregue',7,'manual',100.5,100.5,0),
                             (2,'P-2','rascunho',8,'catalogo',250.0,0,15.0);
  INSERT INTO pedido_itens VALUES (1,1,3,100.5),(2,2,2,250.0);
  INSERT INTO pessoas VALUES (1,'11144477735','Ana'),(2,'SD-abc','Diego');
`);

const colsPedidos = db.prepare('PRAGMA table_info(pedidos)').all().map((c) => c.name);

// ---------- 1. O HASH É SENSÍVEL AO DADO ----------
t('1-a hash idêntico quando nada muda', () => {
  const a = r.hashTabela(db, 'pedidos', colsPedidos);
  const b = r.hashTabela(db, 'pedidos', colsPedidos);
  assert(a && a.length === 32, 'hash vazio ou curto: ' + JSON.stringify(a));
  assert(a === b, 'hash instável entre duas leituras');
});
t('1-b hash MUDA ao alterar um centavo', () => {
  const antes = r.hashTabela(db, 'pedidos', colsPedidos);
  db.exec('UPDATE pedidos SET valorTotal = 100.51 WHERE id = 1');
  const depois = r.hashTabela(db, 'pedidos', colsPedidos);
  assert(antes !== depois, 'um centavo passou despercebido');
  db.exec('UPDATE pedidos SET valorTotal = 100.5 WHERE id = 1');
  assert(r.hashTabela(db, 'pedidos', colsPedidos) === antes, 'não voltou ao original');
});
t('1-c hash MUDA ao trocar status, vendedorId ou tipo', () => {
  for (const sql of ['UPDATE pedidos SET status=\'cancelado\' WHERE id=1',
    'UPDATE pedidos SET vendedorId=99 WHERE id=1', 'UPDATE pedidos SET tipo=\'pdv\' WHERE id=1']) {
    const antes = r.hashTabela(db, 'pedidos', colsPedidos);
    db.exec(sql);
    assert(r.hashTabela(db, 'pedidos', colsPedidos) !== antes, 'não detectou: ' + sql);
    db.exec('UPDATE pedidos SET status=\'entregue\', vendedorId=7, tipo=\'manual\' WHERE id=1');
  }
});
t('1-d NULL e string vazia não colidem', () => {
  db.exec("UPDATE pedidos SET numero = NULL WHERE id = 1");
  const comNull = r.hashTabela(db, 'pedidos', colsPedidos);
  db.exec("UPDATE pedidos SET numero = '' WHERE id = 1");
  assert(r.hashTabela(db, 'pedidos', colsPedidos) !== comNull, 'NULL colidiu com string vazia');
  db.exec("UPDATE pedidos SET numero = 'P-1' WHERE id = 1");
});
t('1-e hash MUDA ao apagar uma linha', () => {
  const antes = r.hashTabela(db, 'pedido_itens', ['id', 'pedidoId', 'quantidade', 'valorTotal']);
  db.exec('DELETE FROM pedido_itens WHERE id = 2');
  assert(r.hashTabela(db, 'pedido_itens', ['id', 'pedidoId', 'quantidade', 'valorTotal']) !== antes, 'DELETE passou');
  db.exec('INSERT INTO pedido_itens VALUES (2,2,2,250.0)');
});

// ---------- 2. A COMPARAÇÃO REPROVA ----------
t('2-a retratos idênticos não acusam divergência', () => {
  const a = r.retrato(db);
  const b = r.retrato(db, a.colunas);
  assert(r.compararRetratos(a, b).length === 0, 'acusou diferença onde não há');
});
t('2-b count diferente é acusado', () => {
  const a = r.retrato(db);
  db.exec("INSERT INTO pessoas VALUES (3,'99999999999','Novo')");
  const div = r.compararRetratos(a, r.retrato(db, a.colunas));
  assert(div.some((d) => d.startsWith('counts.pessoas')), 'não acusou count: ' + JSON.stringify(div));
  db.exec('DELETE FROM pessoas WHERE id = 3');
});
t('2-c soma monetária diferente é acusada', () => {
  const a = r.retrato(db);
  db.exec('UPDATE pedidos SET valorPago = 999 WHERE id = 2');
  const div = r.compararRetratos(a, r.retrato(db, a.colunas));
  assert(div.some((d) => d.includes('somas.pedidos.valorPago')), 'não acusou soma: ' + JSON.stringify(div));
  db.exec('UPDATE pedidos SET valorPago = 0 WHERE id = 2');
});
t('2-d alteração que NÃO mexe na soma ainda assim é acusada pelo hash', () => {
  // Troca de valor entre dois pedidos: a soma total não muda, o conteúdo sim.
  const a = r.retrato(db);
  db.exec('UPDATE pedidos SET valorTotal = 250.0 WHERE id = 1; UPDATE pedidos SET valorTotal = 100.5 WHERE id = 2');
  const div = r.compararRetratos(a, r.retrato(db, a.colunas));
  assert(div.some((d) => d.startsWith('hashes.pedidos')), 'a troca cruzada escapou: ' + JSON.stringify(div));
  assert(!div.some((d) => d.includes('somas.pedidos.valorTotal')), 'a soma deveria estar igual');
  db.exec('UPDATE pedidos SET valorTotal = 100.5 WHERE id = 1; UPDATE pedidos SET valorTotal = 250.0 WHERE id = 2');
});
t('2-e o hash do DEPOIS usa as colunas de ANTES, e não SELECT *', () => {
  const a = r.retrato(db);
  db.exec('ALTER TABLE pedidos ADD COLUMN colunaNova TEXT DEFAULT NULL');
  const div = r.compararRetratos(a, r.retrato(db, a.colunas));
  assert(div.length === 0, 'a coluna nova sozinha fez a comparação reprovar: ' + JSON.stringify(div));
});

// ---------- 3. PREENCHIMENTO AUTOMÁTICO ----------
t('3-a banco migrado e limpo passa', () => {
  db.exec(`ALTER TABLE pedidos ADD COLUMN descontoTipo TEXT;
           ALTER TABLE pedidos ADD COLUMN descontoValor REAL DEFAULT 0;
           ALTER TABLE pedidos ADD COLUMN descontoAplicado REAL DEFAULT 0;
           ALTER TABLE pedidos ADD COLUMN descontoMotivo TEXT;
           ALTER TABLE pedidos ADD COLUMN tipoAtendimento TEXT;
           ALTER TABLE pessoas ADD COLUMN semDocumento INTEGER DEFAULT 0;`);
  assert(r.conferirColunasNovasVazias(db).length === 0, JSON.stringify(r.conferirColunasNovasVazias(db)));
});
t('3-b desconto preenchido é acusado', () => {
  db.exec('UPDATE pedidos SET descontoAplicado = 10 WHERE id = 1');
  assert(r.conferirColunasNovasVazias(db).some((p) => p.includes('descontoAplicado')), 'desconto passou');
  db.exec('UPDATE pedidos SET descontoAplicado = 0 WHERE id = 1');
});
t('3-c tipoAtendimento preenchido é acusado', () => {
  db.exec("UPDATE pedidos SET tipoAtendimento = 'retirada' WHERE id = 1");
  assert(r.conferirColunasNovasVazias(db).some((p) => p.includes('tipoAtendimento')), 'tipoAtendimento passou');
  db.exec('UPDATE pedidos SET tipoAtendimento = NULL WHERE id = 1');
});
t('3-d semDocumento marcado é acusado (backfill indevido)', () => {
  db.exec('UPDATE pessoas SET semDocumento = 1 WHERE id = 2');
  assert(r.conferirColunasNovasVazias(db).some((p) => p.includes('semDocumento=1')), 'backfill passou');
  db.exec('UPDATE pessoas SET semDocumento = 0 WHERE id = 2');
});
t('3-e semDocumento NULL é acusado (default não aplicou)', () => {
  db.exec('UPDATE pessoas SET semDocumento = NULL WHERE id = 1');
  assert(r.conferirColunasNovasVazias(db).some((p) => p.includes('NULL')), 'NULL passou');
  db.exec('UPDATE pessoas SET semDocumento = 0 WHERE id = 1');
});

// ---------- 4. A LISTA DE COLUNAS ----------
t('4-a são exatamente 6 colunas, nos nomes aprovados', () => {
  const todas = Object.values(r.ESPERADAS).flat();
  assert(todas.length === 6, 'esperava 6, tem ' + todas.length);
  assert(r.ESPERADAS.pessoas.join() === 'semDocumento', 'pessoas mudou');
  assert(r.ESPERADAS.pedidos.join() === 'descontoTipo,descontoValor,descontoAplicado,descontoMotivo,tipoAtendimento',
    'pedidos mudou: ' + r.ESPERADAS.pedidos.join());
});
t('4-b a ordem tem 17 tenants, sem repetição e sem os já migrados', () => {
  assert(r.ORDEM.length === 17, 'esperava 17, tem ' + r.ORDEM.length);
  assert(new Set(r.ORDEM).size === 17, 'há tenant repetido na ordem');
  assert(!r.ORDEM.includes('labfiscal') && !r.ORDEM.includes('sandbox'), 'já migrado está na lista');
});

db.close();
fs.unlinkSync(arquivo);
console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
