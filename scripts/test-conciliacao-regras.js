/**
 * Regras de conciliação bancária: casamento do padrão, vínculo com o plano de
 * contas, correção de regra errada e visibilidade de regra morta/sombreada.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const T = require('../tesouraria-routes');

const DB = '/tmp/vp-concil.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-concil-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario TEXT, acao TEXT, entidade TEXT, entidadeId INTEGER, detalhes TEXT, ip TEXT,
  dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);

const app = express();
T.registrarRotasTesouraria(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: { username: 'tester' }, user: { username: 'tester' } },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed ----------
const CONTA = db.prepare("INSERT INTO contas_financeiras (nome, tipo, ativo) VALUES ('Banco','corrente',1)").run().lastInsertRowid;
const pcIns = db.prepare("INSERT INTO plano_contas (codigo, nome, tipo, nivel) VALUES (?,?,?,2)");
const PC_TARIFA = pcIns.run('5.2', 'Despesas Financeiras', 'financeiro_despesa').lastInsertRowid;
const PC_VENDAS = pcIns.run('1.1', 'Receita de Vendas', 'receita').lastInsertRowid;

let seqFit = 0;
const trx = (descricao, valor, memo = '') => db.prepare(`INSERT INTO transacoes_bancarias
  (contaFinanceiraId, fitid, data, valor, descricao, memo) VALUES (?,?,?,?,?,?)`)
  .run(CONTA, 'FIT' + (++seqFit), '2026-08-01', valor, descricao, memo).lastInsertRowid;

// ---------- casamento ----------
t('padrão curto no modo "contém" casa dentro de outra palavra', () => {
  const pixel = { descricao: 'COMPRA PIXEL DESIGN', memo: '', valor: -50 };
  assert(T.regraCasa({ padraoTexto: 'PIX', tipoLancamento: 'ambos', modo: 'contem' }, pixel),
    'era para casar no modo contém — é justamente o problema');
  assert(!T.regraCasa({ padraoTexto: 'PIX', tipoLancamento: 'ambos', modo: 'palavra' }, pixel),
    'modo palavra não pode casar PIXEL com PIX');
});

t('modo palavra ainda casa a palavra de verdade', () => {
  const pix = { descricao: 'PIX RECEBIDO JOAO', memo: '', valor: 100 };
  assert(T.regraCasa({ padraoTexto: 'PIX', tipoLancamento: 'ambos', modo: 'palavra' }, pix), 'deveria casar');
});

t('acento e caixa não atrapalham', () => {
  const tarifa = { descricao: 'TARIFA MANUTENÇÃO', memo: '', valor: -12 };
  assert(T.regraCasa({ padraoTexto: 'manutencao', tipoLancamento: 'ambos', modo: 'contem' }, tarifa),
    'sem acento deveria casar com acentuado');
});

t('faixa de valor separa a tarifa do TED de mesmo texto', () => {
  const regra = { padraoTexto: 'TED', tipoLancamento: 'saida', modo: 'palavra', valorMax: 100 };
  assert(T.regraCasa(regra, { descricao: 'TED TARIFA', memo: '', valor: -12 }), 'tarifa deveria casar');
  assert(!T.regraCasa(regra, { descricao: 'TED PARA FORNECEDOR', memo: '', valor: -12000 }),
    'TED grande não pode cair na regra da tarifa');
});

t('tipo de lançamento é respeitado', () => {
  const r = { padraoTexto: 'PIX', tipoLancamento: 'entrada', modo: 'contem' };
  assert(T.regraCasa(r, { descricao: 'PIX', memo: '', valor: 100 }), 'entrada deveria casar');
  assert(!T.regraCasa(r, { descricao: 'PIX', memo: '', valor: -100 }), 'saída não podia casar');
});

// ---------- vínculo com o plano de contas ----------
t('categorizar sem conta do plano é recusado', () => {
  const r = chamar('/api/conciliacao/regras', 'post', { body: {
    padraoTexto: 'TARIFA', acao: 'categorizar', categoria: 'Tarifas' } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/plano de contas/.test(r.out.error), 'erro: ' + r.out.error);
});

let REGRA_TARIFA;
t('regra com conta do plano é aceita e leva a classificação para a transação', () => {
  const r = chamar('/api/conciliacao/regras', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'TARIFA', tipoLancamento: 'saida',
    acao: 'categorizar', categoria: 'Tarifas bancárias', planoContaId: PC_TARIFA, modo: 'palavra' } });
  assert(r.out.success, 'erro: ' + r.out.error);
  REGRA_TARIFA = r.out.id;

  trx('TARIFA MENSALIDADE', -35);
  const ap = chamar('/api/conciliacao/regras/aplicar', 'post', { body: { contaFinanceiraId: CONTA } });
  assert(ap.out.aplicadas === 1, 'aplicadas: ' + ap.out.aplicadas);
  const tr = db.prepare('SELECT categoriaSugerida, planoContaIdSugerido FROM transacoes_bancarias WHERE fitid=?').get('FIT1');
  // Sem planoContaIdSugerido a categorização não entra no orçamento.
  assert(tr.planoContaIdSugerido === PC_TARIFA, 'não levou a conta do plano: ' + tr.planoContaIdSugerido);
  assert(tr.categoriaSugerida === 'Tarifas bancárias', 'categoria: ' + tr.categoriaSugerida);
});

t('ignorar dispensa conta do plano', () => {
  const r = chamar('/api/conciliacao/regras', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'SALDO ANTERIOR', acao: 'ignorar' } });
  assert(r.out.success, 'erro: ' + r.out.error);
});

// ---------- simulação ----------
t('testar mostra o que a regra pegaria antes de salvar', () => {
  trx('PIX RECEBIDO CLIENTE A', 500);
  trx('PIX RECEBIDO CLIENTE B', 800);
  const r = chamar('/api/conciliacao/regras/testar', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'PIX RECEBIDO', tipoLancamento: 'entrada', planoContaId: PC_VENDAS } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.casam === 2, 'casam: ' + r.out.casam);
  assert(r.out.amostra.length === 2, 'amostra: ' + r.out.amostra.length);
});

t('testar avisa quando o padrão pega quase tudo', () => {
  const r = chamar('/api/conciliacao/regras/testar', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'E', padraoTexto: 'RECEBIDO' } });
  // 2 de 3 transações = 66%
  assert(r.out.avisos.some(a => /curto demais/.test(a)), 'avisos: ' + JSON.stringify(r.out.avisos));
});

t('testar avisa sobre padrão curto no modo contém', () => {
  const r = chamar('/api/conciliacao/regras/testar', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'PIX', modo: 'contem' } });
  assert(r.out.avisos.some(a => /PIXEL/.test(a)), 'avisos: ' + JSON.stringify(r.out.avisos));
});

t('testar avisa que ignorar concilia sozinho', () => {
  const r = chamar('/api/conciliacao/regras/testar', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'ESTORNO', acao: 'ignorar' } });
  assert(r.out.avisos.some(a => /sem ninguém conferir/.test(a)), 'avisos: ' + JSON.stringify(r.out.avisos));
});

t('testar recusa padrão curto demais', () => {
  const r = chamar('/api/conciliacao/regras/testar', 'post', { body: { padraoTexto: 'ab' } });
  assert(r.st === 400, 'status: ' + r.st);
});

// ---------- corrigir regra errada ----------
t('editar o padrão da regra passou a ser possível', () => {
  const r = chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(REGRA_TARIFA) },
    body: { padraoTexto: 'TARIFA MENSAL', planoContaId: PC_TARIFA } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const g = db.prepare('SELECT padraoTexto FROM conciliacao_regras WHERE id=?').get(REGRA_TARIFA);
  assert(g.padraoTexto === 'TARIFA MENSAL', 'padrão: ' + g.padraoTexto);
});

t('editar avisa que o passado não muda sozinho', () => {
  const r = chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(REGRA_TARIFA) },
    body: { prioridade: 5 } });
  assert(/Reaplicar/.test(r.out.avisoReprocessar || ''), 'sem aviso: ' + JSON.stringify(r.out));
});

t('reprocessar reavalia o que a regra já tinha tocado', () => {
  const antes = db.prepare('SELECT planoContaIdSugerido FROM transacoes_bancarias WHERE fitid=?').get('FIT1');
  assert(antes.planoContaIdSugerido === PC_TARIFA, 'estado inicial errado');
  // Volta o padrao a casar (o teste anterior o deixou como 'TARIFA MENSAL',
  // que no modo palavra nao casa 'TARIFA MENSALIDADE') e troca a conta.
  chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(REGRA_TARIFA) },
    body: { padraoTexto: 'TARIFA', planoContaId: PC_VENDAS } });
  const semRepro = chamar('/api/conciliacao/regras/aplicar', 'post', { body: { contaFinanceiraId: CONTA } });
  const meio = db.prepare('SELECT planoContaIdSugerido FROM transacoes_bancarias WHERE fitid=?').get('FIT1');
  assert(meio.planoContaIdSugerido === PC_TARIFA, 'sem reprocessar não devia mudar');

  const comRepro = chamar('/api/conciliacao/regras/aplicar', 'post',
    { body: { contaFinanceiraId: CONTA, reprocessar: true } });
  assert(comRepro.out.revertidas > 0, 'revertidas: ' + comRepro.out.revertidas);
  const depois = db.prepare('SELECT planoContaIdSugerido FROM transacoes_bancarias WHERE fitid=?').get('FIT1');
  assert(depois.planoContaIdSugerido === PC_VENDAS, 'reprocessar não corrigiu: ' + depois.planoContaIdSugerido);
});

t('padrão que deixou de casar desclassifica no reprocessamento', () => {
  // Regra apertada demais tem de soltar a transação, não deixá-la marcada
  // com uma classificação que a regra atual não sustenta mais.
  chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(REGRA_TARIFA) },
    body: { padraoTexto: 'TARIFA MENSAL' } });
  chamar('/api/conciliacao/regras/aplicar', 'post', { body: { contaFinanceiraId: CONTA, reprocessar: true } });
  const tr = db.prepare('SELECT planoContaIdSugerido, regraAplicadaId FROM transacoes_bancarias WHERE fitid=?').get('FIT1');
  assert(tr.planoContaIdSugerido === null && tr.regraAplicadaId === null,
    'continuou classificada por regra que nao casa mais: ' + JSON.stringify(tr));
  chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(REGRA_TARIFA) },
    body: { padraoTexto: 'TARIFA' } });
});

t('reprocessar não desfaz conciliação feita por pessoa', () => {
  const id = trx('DEPOSITO MANUAL', 900);
  db.prepare(`UPDATE transacoes_bancarias SET conciliadaCom='cr', conciliadaId=1,
    conciliadaPor='ana', regraAplicadaId=? WHERE id=?`).run(REGRA_TARIFA, id);
  chamar('/api/conciliacao/regras/aplicar', 'post', { body: { contaFinanceiraId: CONTA, reprocessar: true } });
  const tr = db.prepare('SELECT conciliadaCom, conciliadaPor FROM transacoes_bancarias WHERE id=?').get(id);
  assert(tr.conciliadaCom === 'cr' && tr.conciliadaPor === 'ana', 'apagou trabalho manual: ' + JSON.stringify(tr));
});

t('reprocessar devolve à fila o que a regra tinha ignorado', () => {
  const id = trx('SALDO ANTERIOR DO MES', -1);
  chamar('/api/conciliacao/regras/aplicar', 'post', { body: { contaFinanceiraId: CONTA } });
  const ignorada = db.prepare('SELECT conciliadaCom FROM transacoes_bancarias WHERE id=?').get(id);
  assert(ignorada.conciliadaCom === 'ignorada', 'não ignorou: ' + ignorada.conciliadaCom);

  // Desativa a regra e reprocessa: a transação tem de voltar a aparecer.
  db.prepare("UPDATE conciliacao_regras SET ativo=0 WHERE padraoTexto='SALDO ANTERIOR'").run();
  chamar('/api/conciliacao/regras/aplicar', 'post', { body: { contaFinanceiraId: CONTA, reprocessar: true } });
  const volta = db.prepare('SELECT conciliadaCom FROM transacoes_bancarias WHERE id=?').get(id);
  assert(volta.conciliadaCom === null, 'ficou escondida para sempre: ' + volta.conciliadaCom);
});

// ---------- excluir ----------
t('excluir a regra limpa a marca nas transações pendentes', () => {
  const r = chamar('/api/conciliacao/regras/:id', 'delete', { params: { id: String(REGRA_TARIFA) } });
  assert(r.out.success, 'erro: ' + r.out.error);
  const orfas = db.prepare('SELECT COUNT(*) n FROM transacoes_bancarias WHERE regraAplicadaId = ?').get(REGRA_TARIFA).n;
  assert(orfas === 0, 'sobraram transações apontando para regra inexistente: ' + orfas);
});

t('excluir regra inexistente devolve 404', () => {
  const r = chamar('/api/conciliacao/regras/:id', 'delete', { params: { id: '99999' } });
  assert(r.st === 404, 'status: ' + r.st);
});

// ---------- diagnóstico ----------
t('regra que nunca pegou nada é apontada', () => {
  chamar('/api/conciliacao/regras', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'XPTO INEXISTENTE', planoContaId: PC_VENDAS } });
  const d = chamar('/api/conciliacao/regras', 'get', {}).out.diagnostico;
  assert(d.mortas.some(m => m.padraoTexto === 'XPTO INEXISTENTE'), 'mortas: ' + JSON.stringify(d.mortas));
});

t('regra engolida por outra de prioridade maior é apontada', () => {
  chamar('/api/conciliacao/regras', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'PIX', prioridade: 10, planoContaId: PC_VENDAS } });
  chamar('/api/conciliacao/regras', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'PIX RECEBIDO CLIENTE', prioridade: 1, planoContaId: PC_VENDAS } });
  const d = chamar('/api/conciliacao/regras', 'get', {}).out.diagnostico;
  const s = d.sombreadas.find(x => x.padraoTexto === 'PIX RECEBIDO CLIENTE');
  assert(s, 'sombreadas: ' + JSON.stringify(d.sombreadas));
  assert(s.engolidaPor.padraoTexto === 'PIX', 'engolida por: ' + JSON.stringify(s.engolidaPor));
});


// ==================== TRAVA: CATEGORIZAR EXIGE CONTA ====================

t('o banco recusa regra ativa que categoriza sem conta', () => {
  // Não é só validação de rota: o CHECK impede por qualquer caminho, inclusive
  // SQL direto, seed e importação.
  let erro = null;
  try {
    db.prepare(`INSERT INTO conciliacao_regras (padraoTexto, acao, ativo, planoContaId)
      VALUES ('BURLA', 'categorizar', 1, NULL)`).run();
  } catch (e) { erro = e.message; }
  assert(erro && /categorizar_exige_conta|CHECK/i.test(erro), 'passou pelo banco: ' + erro);
});

t('regra inválida pode existir inativa, para não apagar configuração', () => {
  const id = db.prepare(`INSERT INTO conciliacao_regras (padraoTexto, acao, ativo, planoContaId)
    VALUES ('LEGADA', 'categorizar', 0, NULL)`).run().lastInsertRowid;
  const g = db.prepare('SELECT ativo, planoContaId FROM conciliacao_regras WHERE id=?').get(id);
  assert(g.ativo === 0 && g.planoContaId === null, 'inativa inválida deveria ser permitida');
  return id;
});

t('reativar por SQL uma regra inválida também é barrado', () => {
  const r = db.prepare("SELECT id FROM conciliacao_regras WHERE padraoTexto='LEGADA'").get();
  let erro = null;
  try { db.prepare('UPDATE conciliacao_regras SET ativo = 1 WHERE id = ?').run(r.id); }
  catch (e) { erro = e.message; }
  assert(erro && /categorizar_exige_conta|CHECK/i.test(erro), 'reativou sem conta: ' + erro);
});

t('a rota de edição recusa reativar sem conta, com o motivo', () => {
  const r = db.prepare("SELECT id FROM conciliacao_regras WHERE padraoTexto='LEGADA'").get();
  const res = chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(r.id) }, body: { ativo: 1 } });
  assert(res.st === 400, 'status: ' + res.st);
  assert(/conta do plano/.test(res.out.error), 'erro: ' + res.out.error);
});

t('a rota de edição recusa limpar a conta de uma regra ativa', () => {
  const nova = chamar('/api/conciliacao/regras', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'ALUGUEL SALA', planoContaId: PC_TARIFA } });
  assert(nova.out.success, 'seed: ' + nova.out.error);
  const res = chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(nova.out.id) },
    body: { planoContaId: null } });
  assert(res.st === 400, 'status: ' + res.st);
  assert(/conta do plano/.test(res.out.error), 'erro: ' + res.out.error);
});

t('trocar a ação para categorizar sem conta é recusado', () => {
  const ign = chamar('/api/conciliacao/regras', 'post', { body: {
    contaFinanceiraId: CONTA, padraoTexto: 'ESTORNO TARIFA', acao: 'ignorar' } });
  const res = chamar('/api/conciliacao/regras/:id', 'put', { params: { id: String(ign.out.id) },
    body: { acao: 'categorizar' } });
  assert(res.st === 400, 'status: ' + res.st);
});

t('regra inválida que sobrou não é executada pelo motor', () => {
  // Cenário do legado: existe, está lá, mas não pode classificar nada.
  const antes = db.prepare("SELECT COUNT(*) n FROM transacoes_bancarias WHERE categoriaSugerida = 'LEGADA'").get().n;
  chamar('/api/conciliacao/regras/aplicar', 'post', { body: { contaFinanceiraId: CONTA, reprocessar: true } });
  const depois = db.prepare("SELECT COUNT(*) n FROM transacoes_bancarias WHERE categoriaSugerida = 'LEGADA'").get().n;
  assert(antes === depois, 'regra sem conta classificou alguma coisa');
});

t('migração desativa a regra ativa inválida e informa qual foi', () => {
  // Base sem a trava, com uma regra legada ativa e sem conta.
  const P2 = '/tmp/vp-concil-legado.db';
  try { fs.unlinkSync(P2); } catch {}
  const db2 = new Database(P2);
  db2.exec(schema);
  db2.exec(`CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT)`);
  db2.prepare(`INSERT INTO conciliacao_regras (padraoTexto, acao, ativo) VALUES ('ANTIGA', 'categorizar', 1)`).run();
  db2.prepare(`INSERT INTO conciliacao_regras (padraoTexto, acao, ativo) VALUES ('SO IGNORA', 'ignorar', 1)`).run();

  T.migrarRegrasConciliacao(db2);
  const antiga = db2.prepare("SELECT ativo FROM conciliacao_regras WHERE padraoTexto='ANTIGA'").get();
  assert(antiga.ativo === 0, 'regra inválida continuou ativa');
  const ignora = db2.prepare("SELECT ativo FROM conciliacao_regras WHERE padraoTexto='SO IGNORA'").get();
  assert(ignora.ativo === 1, 'desativou uma regra que era válida');
  db2.close();
});

t('a migração preserva os dados das regras existentes', () => {
  const P2 = '/tmp/vp-concil-legado.db';
  const db2 = new Database(P2);
  const n = db2.prepare('SELECT COUNT(*) n FROM conciliacao_regras').get().n;
  assert(n === 2, 'perdeu regra na reconstrução da tabela: ' + n);
  const cols = db2.prepare('PRAGMA table_info(conciliacao_regras)').all().map(c => c.name);
  for (const c of ['planoContaId', 'modo', 'valorMin', 'valorMax', 'vezesAplicada']) {
    assert(cols.includes(c), 'perdeu a coluna ' + c);
  }
  db2.close();
});

t('aplicar a trava duas vezes não quebra', () => {
  const P2 = '/tmp/vp-concil-legado.db';
  const db2 = new Database(P2);
  T.migrarRegrasConciliacao(db2);
  T.migrarRegrasConciliacao(db2);
  assert(db2.prepare('SELECT COUNT(*) n FROM conciliacao_regras').get().n === 2, 'duplicou ou perdeu');
  db2.close();
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
