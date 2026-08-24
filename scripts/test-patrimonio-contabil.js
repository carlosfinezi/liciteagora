/**
 * Patrimônio contabilizado e integrado à NF-e de entrada.
 *
 * O módulo calculava depreciação só para mostrar na tela — o próprio cabeçalho
 * dizia "não emite contabilização". O balanço não sabia que existia imobilizado
 * e a despesa de depreciação, que é dedutível, nunca chegava ao resultado.
 *
 * As duas invariantes que estes testes protegem:
 *   1. rodar o fechamento do mês duas vezes não dobra a despesa;
 *   2. o acumulado usado na baixa vem do razão, não da fórmula — estornar um
 *      mês tem que mudar a baixa.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const ctb = require('../patrimonio-contabil');

const DB = '/tmp/vp-patctb.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-patctb-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const perto = (a, b, tol = 0.01) => Math.abs(Number(a) - Number(b)) < tol;

// ---------- app ----------
const app = express();
app.use(express.json());
require('../contabilidade-routes').registrarRotasContabilidade(app, db);
require('../patrimonio-routes').registrarRotasPatrimonio(app, db);

function call(m, p, body = {}, params = {}, query = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === p && c.route.methods[m]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota não encontrada: ' + m + ' ' + p);
  let o = null;
  h({ body, params, query, user: { username: 't' }, session: { username: 't' } },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { o = { status: this.statusCode, body: j }; } },
    () => {});
  if (!o) throw new Error('handler não respondeu');
  return o;
}

// A FK de nfe_entrada aponta para fornecedores, que o stub cria vazia.
db.prepare(`INSERT INTO fornecedores (id, cpfCnpj, tipo, razaoSocial)
  VALUES (1, '22222222000192', 'PJ', 'Fornecedor SA')`).run();

// ---------- plano contábil ----------
const conta = (codigo, nome, natureza, tipo = 'analitica') =>
  db.prepare(`INSERT INTO contas_contabeis (codigo, nome, tipoConta, natureza, nivel, ativo)
    VALUES (?, ?, ?, ?, 3, 1)`).run(codigo, nome, tipo, natureza).lastInsertRowid;

const IMOB = conta('1.2.3.01', 'Máquinas e Equipamentos', 'D');
const IMOB_VEIC = conta('1.2.3.02', 'Veículos', 'D');
const ACUM = conta('1.2.3.91', '(-) Depreciação Acumulada', 'C');
const DESP = conta('4.1.5.01', 'Despesa de Depreciação', 'D');
const RESULT = conta('4.1.9.01', 'Perdas na Baixa de Imobilizado', 'D');
const FORNEC = conta('2.1.1.01', 'Fornecedores', 'C');
const SINTETICA = conta('1.2.3', 'IMOBILIZADO', 'D', 'sintetica');

// ---------- fixture ----------
let seqBem = 0;
const novoBem = (o = {}) => db.prepare(`INSERT INTO patrimonio_bens
  (codigo, descricao, categoria, valorAquisicao, valorResidual, vidaUtilMeses, dataAquisicao, status, dataBaixa, motivoBaixa, centroCustoId)
  VALUES (@codigo, @descricao, @categoria, @valorAquisicao, @valorResidual, @vidaUtilMeses, @dataAquisicao, @status, @dataBaixa, @motivoBaixa, @centroCustoId)`)
  .run({ codigo: 'BEM-T-' + (++seqBem), descricao: 'Torno CNC', categoria: null,
         valorAquisicao: 60000, valorResidual: 0, vidaUtilMeses: 60, dataAquisicao: '2026-01-15',
         status: 'ativo', dataBaixa: null, motivoBaixa: null, centroCustoId: null, ...o }).lastInsertRowid;

function limpar() {
  db.exec(`DELETE FROM patrimonio_depreciacoes; DELETE FROM patrimonio_movimentos;
           DELETE FROM patrimonio_bens; DELETE FROM lancamento_partidas;
           DELETE FROM lancamentos_contabeis; DELETE FROM patrimonio_contas_padrao;
           DELETE FROM nfe_entrada_itens; DELETE FROM nfe_entrada; DELETE FROM periodos_contabeis;`);
}
const mapearPadrao = (o = {}) => db.prepare(`INSERT INTO patrimonio_contas_padrao
  (categoria, contaImobilizadoId, contaDepreciacaoAcumuladaId, contaDespesaDepreciacaoId, contaResultadoBaixaId)
  VALUES (@categoria, @imob, @acum, @desp, @result)`)
  .run({ categoria: null, imob: IMOB, acum: ACUM, desp: DESP, result: RESULT, ...o });

const saldo = (contaId) => db.prepare(`
  SELECT COALESCE(SUM(CASE WHEN dc='D' THEN valor ELSE -valor END), 0) AS s
  FROM lancamento_partidas WHERE contaContabilId = ?`).get(contaId).s;

// ==================== MAPEAMENTO DE CONTAS ====================
console.log('\n--- mapeamento de contas ---');

t('sem mapeamento nada é contabilizado, e o motivo é dito', () => {
  limpar();
  const r = ctb.contasDoBem(db, { categoria: 'TI' });
  assert(r.contas === null, 'devolveu contas sem mapeamento');
  assert(/Nenhum mapeamento/i.test(r.problemas[0].mensagem), r.problemas[0].mensagem);
});

t('mapeamento da categoria vence o padrão', () => {
  limpar(); mapearPadrao();
  mapearPadrao({ categoria: 'Veículos', imob: IMOB_VEIC });
  const r = ctb.contasDoBem(db, { categoria: 'Veículos' });
  assert(r.contas.imobilizado.id === IMOB_VEIC, 'usou o padrão em vez da categoria');
  assert(r.contas.origem === 'categoria Veículos', r.contas.origem);
});

t('categoria sem mapeamento próprio cai no padrão', () => {
  const r = ctb.contasDoBem(db, { categoria: 'Móveis' });
  assert(r.contas.imobilizado.id === IMOB, 'não caiu no padrão');
  assert(r.contas.origem === 'padrão', r.contas.origem);
});

t('conta sintética é recusada com o papel dela na mensagem', () => {
  limpar(); mapearPadrao({ imob: SINTETICA });
  const r = ctb.contasDoBem(db, {});
  assert(r.contas.imobilizado === null, 'aceitou sintética');
  assert(/sintética/i.test(r.problemas[0].mensagem) && /imobilizado/i.test(r.problemas[0].mensagem),
    r.problemas[0].mensagem);
});

t('regravar o mapeamento atualiza em vez de duplicar', () => {
  limpar();
  const r1 = call('post', '/api/patrimonio/contas',
    { contaImobilizadoId: IMOB, contaDepreciacaoAcumuladaId: ACUM, contaDespesaDepreciacaoId: DESP });
  assert(r1.body.success, JSON.stringify(r1.body));
  const r2 = call('post', '/api/patrimonio/contas',
    { contaImobilizadoId: IMOB_VEIC, contaDepreciacaoAcumuladaId: ACUM, contaDespesaDepreciacaoId: DESP });
  assert(r2.body.success, JSON.stringify(r2.body));
  const n = db.prepare('SELECT COUNT(*) n FROM patrimonio_contas_padrao').get().n;
  assert(n === 1, 'duplicou o padrão: ' + n);
  assert(ctb.contasDoBem(db, {}).contas.imobilizado.id === IMOB_VEIC, 'não atualizou');
});

t('mapeamento sem as três contas obrigatórias é recusado', () => {
  const r = call('post', '/api/patrimonio/contas', { contaImobilizadoId: IMOB });
  assert(r.status === 400, 'status: ' + r.status);
});

// ==================== QUOTA ====================
console.log('\n--- quota de depreciação ---');

const bemBase = { valorAquisicao: 60000, valorResidual: 0, vidaUtilMeses: 60,
                  dataAquisicao: '2026-01-15', status: 'ativo' };

t('quota linear simples', () => {
  assert(perto(ctb.quotaDoMes(bemBase, '2026-03', 2000).valor, 1000), 'quota errada');
});

t('deprecia já no mês da aquisição', () => {
  assert(perto(ctb.quotaDoMes(bemBase, '2026-01', 0).valor, 1000), 'não depreciou no mês da compra');
});

t('competência anterior à aquisição não deprecia', () => {
  const q = ctb.quotaDoMes(bemBase, '2025-12', 0);
  assert(q.valor === 0 && /anterior/i.test(q.motivo), JSON.stringify(q));
});

t('valor residual reduz a base depreciável', () => {
  const q = ctb.quotaDoMes({ ...bemBase, valorResidual: 6000 }, '2026-03', 0);
  assert(perto(q.valor, 900), 'quota: ' + q.valor);
});

t('a última parcela fecha exatamente, sem deixar centavos', () => {
  // 1000 / 3 meses = 333,33 -> a terceira precisa ser 333,34.
  const bem = { valorAquisicao: 1000, valorResidual: 0, vidaUtilMeses: 3, dataAquisicao: '2026-01-10', status: 'ativo' };
  const q1 = ctb.quotaDoMes(bem, '2026-01', 0);
  const q2 = ctb.quotaDoMes(bem, '2026-02', q1.valor);
  const q3 = ctb.quotaDoMes(bem, '2026-03', q1.valor + q2.valor);
  const soma = q1.valor + q2.valor + q3.valor;
  assert(perto(soma, 1000), 'soma das quotas: ' + soma);
  assert(q3.ajusteFinal === true, 'não marcou ajuste final');
});

t('mês faltante não vira parcela gorda escondida no último mês', () => {
  // 3 meses de 1000; o segundo foi estornado e não reapurado. O último mês
  // cobra a quota normal, não 2000 de uma vez.
  const bem = { valorAquisicao: 3000, valorResidual: 0, vidaUtilMeses: 3, dataAquisicao: '2026-01-10', status: 'ativo' };
  const q3 = ctb.quotaDoMes(bem, '2026-03', 1000);
  assert(perto(q3.valor, 1000), 'quota do último mês: ' + q3.valor);
});

t('bem totalmente depreciado para de depreciar', () => {
  const q = ctb.quotaDoMes(bemBase, '2032-01', 60000);
  assert(q.valor === 0 && /totalmente/i.test(q.motivo), JSON.stringify(q));
});

t('passada a vida útil com saldo residual, fecha o que falta', () => {
  // Simula um mês estornado: faltam 1000 e já passou dos 60 meses.
  const q = ctb.quotaDoMes(bemBase, '2032-01', 59000);
  assert(perto(q.valor, 1000) && q.ajusteFinal, JSON.stringify(q));
});

t('residual cobrindo o valor de aquisição não deprecia nada', () => {
  const q = ctb.quotaDoMes({ ...bemBase, valorResidual: 60000 }, '2026-03', 0);
  assert(q.valor === 0 && /residual/i.test(q.motivo), JSON.stringify(q));
});

t('bem baixado deprecia até o mês da baixa e para', () => {
  const bem = { ...bemBase, status: 'baixado', dataBaixa: '2026-04-20' };
  assert(ctb.quotaDoMes(bem, '2026-04', 3000).valor > 0, 'não depreciou no mês da baixa');
  assert(ctb.quotaDoMes(bem, '2026-05', 4000).valor === 0, 'depreciou depois da baixa');
});

t('vida útil zerada não deprecia (evita divisão por zero silenciosa)', () => {
  const q = ctb.quotaDoMes({ ...bemBase, vidaUtilMeses: 0 }, '2026-03', 0);
  assert(q.valor === 0 && /vida útil/i.test(q.motivo), JSON.stringify(q));
});

// ==================== APURAÇÃO ====================
console.log('\n--- fechamento mensal ---');

function cenarioSimples() {
  limpar(); mapearPadrao();
  return novoBem();
}

t('apuração lança D despesa / C depreciação acumulada', () => {
  cenarioSimples();
  const r = ctb.apurarDepreciacao(db, '2026-03');
  assert(r.bens === 1 && perto(r.total, 1000), JSON.stringify(r));
  assert(perto(saldo(DESP), 1000), 'despesa: ' + saldo(DESP));
  assert(perto(saldo(ACUM), -1000), 'acumulada: ' + saldo(ACUM));
});

t('apurar a mesma competência de novo NÃO dobra a despesa', () => {
  const r2 = ctb.apurarDepreciacao(db, '2026-03');
  // Sem a trava de idempotência, fechar o mês duas vezes duplicaria a
  // despesa dedutível — e ninguém repara olhando a tela.
  assert(r2.bens === 0, 'gerou de novo: ' + r2.bens);
  assert(r2.pulados.length === 1 && /já apurada/i.test(r2.pulados[0].motivo), JSON.stringify(r2.pulados));
  assert(perto(saldo(DESP), 1000), 'despesa dobrou: ' + saldo(DESP));
});

t('simulação calcula e não grava nada', () => {
  cenarioSimples();
  const r = ctb.apurarDepreciacao(db, '2026-03', { simular: true });
  assert(r.simulacao && r.bens === 1 && perto(r.total, 1000), JSON.stringify(r));
  assert(r.lancamentoId === null, 'gerou lançamento simulando');
  assert(db.prepare('SELECT COUNT(*) n FROM patrimonio_depreciacoes').get().n === 0, 'gravou simulando');
  assert(saldo(DESP) === 0, 'lançou simulando');
});

t('bem sem mapeamento de contas é bloqueado e nomeado', () => {
  limpar();
  const id = novoBem();
  const r = ctb.apurarDepreciacao(db, '2026-03');
  assert(r.bens === 0 && r.bloqueios.length === 1, JSON.stringify(r));
  assert(r.bloqueios[0].bemId === id, JSON.stringify(r.bloqueios));
});

t('meses distintos acumulam', () => {
  cenarioSimples();
  ctb.apurarDepreciacao(db, '2026-01');
  ctb.apurarDepreciacao(db, '2026-02');
  ctb.apurarDepreciacao(db, '2026-03');
  assert(perto(saldo(DESP), 3000), 'despesa: ' + saldo(DESP));
});

t('um lançamento por competência, com as partidas agrupadas', () => {
  limpar(); mapearPadrao();
  novoBem(); novoBem(); novoBem();
  const r = ctb.apurarDepreciacao(db, '2026-03');
  assert(r.bens === 3, 'bens: ' + r.bens);
  const partidas = db.prepare('SELECT * FROM lancamento_partidas WHERE lancamentoId = ?').all(r.lancamentoId);
  // Três bens no mesmo par de contas viram duas partidas, não seis.
  assert(partidas.length === 2, 'partidas: ' + partidas.length);
  assert(perto(partidas.find((p) => p.dc === 'D').valor, 3000), JSON.stringify(partidas));
  assert(db.prepare('SELECT COUNT(*) n FROM patrimonio_depreciacoes WHERE competencia = ?').get('2026-03').n === 3,
    'detalhe por bem não foi gravado');
});

t('categorias diferentes geram pares de partidas diferentes', () => {
  limpar(); mapearPadrao();
  mapearPadrao({ categoria: 'Veículos', imob: IMOB_VEIC, acum: ACUM, desp: RESULT });
  novoBem();
  novoBem({ categoria: 'Veículos' });
  const r = ctb.apurarDepreciacao(db, '2026-03');
  const partidas = db.prepare('SELECT * FROM lancamento_partidas WHERE lancamentoId = ?').all(r.lancamentoId);
  assert(partidas.length === 4, 'partidas: ' + partidas.length);
});

t('competência fechada bloqueia o lançamento', () => {
  cenarioSimples();
  db.prepare("INSERT INTO periodos_contabeis (competencia, status) VALUES ('2026-03', 'fechado')").run();
  let erro = null;
  try { ctb.apurarDepreciacao(db, '2026-03'); } catch (e) { erro = e.message; }
  assert(/fechada/i.test(erro || ''), 'erro: ' + erro);
  assert(db.prepare('SELECT COUNT(*) n FROM patrimonio_depreciacoes').get().n === 0, 'gravou em período fechado');
});

t('competência mal formada é recusada', () => {
  let erro = null;
  try { ctb.apurarDepreciacao(db, '2026'); } catch (e) { erro = e.message; }
  assert(/YYYY-MM/.test(erro || ''), 'erro: ' + erro);
});

// ==================== ESTORNO ====================
console.log('\n--- estorno da depreciação ---');

t('estorno gera contra-lançamento e zera o saldo', () => {
  cenarioSimples();
  ctb.apurarDepreciacao(db, '2026-03');
  const r = ctb.estornarDepreciacao(db, '2026-03');
  assert(r.estornadas === 1 && r.lancamentoEstornoId, JSON.stringify(r));
  assert(perto(saldo(DESP), 0), 'despesa: ' + saldo(DESP));
  assert(perto(saldo(ACUM), 0), 'acumulada: ' + saldo(ACUM));
});

t('o lançamento original fica marcado como estornado, não some', () => {
  const orig = db.prepare("SELECT * FROM lancamentos_contabeis WHERE origem = 'patrimonio_depreciacao'").get();
  assert(orig && orig.estornado === 1 && orig.lancamentoEstornoId, JSON.stringify(orig));
});

t('depois do estorno a competência pode ser reapurada', () => {
  const r = ctb.apurarDepreciacao(db, '2026-03');
  assert(r.bens === 1, 'não reapurou: ' + JSON.stringify(r));
});

t('estornar competência sem apuração não faz nada', () => {
  const r = ctb.estornarDepreciacao(db, '2020-01');
  assert(r.estornadas === 0, JSON.stringify(r));
});

// ==================== AQUISIÇÃO ====================
console.log('\n--- aquisição ---');

t('aquisição debita imobilizado e credita a contrapartida', () => {
  limpar(); mapearPadrao();
  const id = novoBem();
  const r = ctb.contabilizarAquisicao(db, id, { contaContrapartidaId: FORNEC });
  assert(r.lancamentoId, JSON.stringify(r));
  assert(perto(saldo(IMOB), 60000), 'imobilizado: ' + saldo(IMOB));
  assert(perto(saldo(FORNEC), -60000), 'fornecedores: ' + saldo(FORNEC));
});

t('contabilizar duas vezes não duplica', () => {
  const id = db.prepare('SELECT id FROM patrimonio_bens LIMIT 1').get().id;
  const r = ctb.contabilizarAquisicao(db, id, { contaContrapartidaId: FORNEC });
  assert(r.jaContabilizado, JSON.stringify(r));
  assert(perto(saldo(IMOB), 60000), 'dobrou: ' + saldo(IMOB));
});

t('aquisição sem contrapartida é recusada, sem palpite', () => {
  limpar(); mapearPadrao();
  const id = novoBem();
  let erro = null;
  try { ctb.contabilizarAquisicao(db, id, {}); } catch (e) { erro = e.message; }
  assert(/contrapartida/i.test(erro || ''), 'erro: ' + erro);
  assert(saldo(IMOB) === 0, 'lançou mesmo assim');
});

// ==================== BAIXA ====================
console.log('\n--- baixa ---');

function cenarioBaixa() {
  limpar(); mapearPadrao();
  const id = novoBem();
  ctb.contabilizarAquisicao(db, id, { contaContrapartidaId: FORNEC });
  ctb.apurarDepreciacao(db, '2026-01');
  ctb.apurarDepreciacao(db, '2026-02');
  db.prepare("UPDATE patrimonio_bens SET status='baixado', dataBaixa='2026-02-28', motivoBaixa='Venda' WHERE id = ?").run(id);
  return id;
}

t('baixa tira o custo do ativo, tira a acumulada e joga o resto no resultado', () => {
  const id = cenarioBaixa();
  const r = ctb.contabilizarBaixa(db, id);
  assert(perto(r.aquisicao, 60000) && perto(r.acumulada, 2000) && perto(r.residual, 58000), JSON.stringify(r));
  assert(perto(saldo(IMOB), 0), 'imobilizado não zerou: ' + saldo(IMOB));
  assert(perto(saldo(ACUM), 0), 'acumulada não zerou: ' + saldo(ACUM));
  assert(perto(saldo(RESULT), 58000), 'resultado: ' + saldo(RESULT));
});

t('a baixa usa o acumulado do RAZÃO, não o da fórmula', () => {
  const id = cenarioBaixa();
  // Estornar fevereiro tem que mudar a baixa: se a baixa recalculasse pela
  // fórmula, ignoraria o estorno e o balanço não fecharia.
  ctb.estornarDepreciacao(db, '2026-02');
  const r = ctb.contabilizarBaixa(db, id);
  assert(perto(r.acumulada, 1000), 'acumulada: ' + r.acumulada);
  assert(perto(r.residual, 59000), 'residual: ' + r.residual);
});

t('bem ainda ativo não pode ser baixado contabilmente', () => {
  limpar(); mapearPadrao();
  const id = novoBem();
  let erro = null;
  try { ctb.contabilizarBaixa(db, id); } catch (e) { erro = e.message; }
  assert(/ainda está ativo/i.test(erro || ''), 'erro: ' + erro);
});

t('bem sem depreciação nenhuma baixa tudo como resultado', () => {
  limpar(); mapearPadrao();
  const id = novoBem();
  db.prepare("UPDATE patrimonio_bens SET status='baixado', dataBaixa='2026-03-10' WHERE id = ?").run(id);
  const r = ctb.contabilizarBaixa(db, id);
  assert(perto(r.acumulada, 0) && perto(r.residual, 60000), JSON.stringify(r));
  assert(perto(saldo(RESULT), 60000), 'resultado: ' + saldo(RESULT));
});

t('bem totalmente depreciado baixa sem resultado', () => {
  limpar(); mapearPadrao();
  const id = novoBem({ valorAquisicao: 3000, vidaUtilMeses: 3, dataAquisicao: '2026-01-05' });
  ctb.apurarDepreciacao(db, '2026-01');
  ctb.apurarDepreciacao(db, '2026-02');
  ctb.apurarDepreciacao(db, '2026-03');
  db.prepare("UPDATE patrimonio_bens SET status='baixado', dataBaixa='2026-04-01' WHERE id = ?").run(id);
  const r = ctb.contabilizarBaixa(db, id);
  assert(perto(r.residual, 0), 'residual: ' + r.residual);
  assert(perto(saldo(RESULT), 0), 'gerou perda de bem já depreciado: ' + saldo(RESULT));
});

t('sem conta de resultado configurada, a baixa com resíduo é recusada', () => {
  limpar(); mapearPadrao({ result: null });
  const id = novoBem();
  db.prepare("UPDATE patrimonio_bens SET status='baixado', dataBaixa='2026-03-10' WHERE id = ?").run(id);
  let erro = null;
  try { ctb.contabilizarBaixa(db, id); } catch (e) { erro = e.message; }
  assert(/conta de\s+resultado/i.test(erro || ''), 'erro: ' + erro);
  assert(saldo(IMOB) === 0, 'lançou parcialmente');
});

// ==================== NF-e DE ENTRADA ====================
console.log('\n--- integração com NF-e de entrada ---');

let seqNfe = 0;
function novaNfe(o = {}) {
  return db.prepare(`INSERT INTO nfe_entrada
    (numero, serie, chaveAcesso, dataEmissao, valorTotal, situacao, emitenteRazaoSocial, emitenteCnpj, fornecedorId)
    VALUES (@numero, '1', @chave, @dataEmissao, @valorTotal, 'processada', 'Fornecedor SA', '22222222000192', 1)`)
    .run({ numero: 'NF' + (++seqNfe), chave: 'CH' + seqNfe, dataEmissao: '2026-05-10T10:00:00-03:00',
           valorTotal: 12000, ...o }).lastInsertRowid;
}
const novoItemNfe = (nfeId, o = {}) => db.prepare(`INSERT INTO nfe_entrada_itens
  (nfeId, numero, descricao, cfop, ncm, quantidade, unidade, valorUnitario, valorTotal, valorIpi, valorFrete, valorDesconto, ignorado)
  VALUES (?, @numero, @descricao, @cfop, '84589', @quantidade, 'UN', @valorUnitario, @valorTotal, @valorIpi, @valorFrete, @valorDesconto, @ignorado)`)
  .run(nfeId, { numero: 1, descricao: 'Notebook Dell i7', cfop: '1551', quantidade: 1,
                valorUnitario: 6000, valorTotal: 6000, valorIpi: 0, valorFrete: 0, valorDesconto: 0,
                ignorado: 0, ...o }).lastInsertRowid;

t('item com CFOP 1551 aparece como candidato a virar bem', () => {
  limpar();
  const nfe = novaNfe();
  novoItemNfe(nfe);
  const c = ctb.candidatosDaNfe(db);
  assert(c.length === 1 && c[0].cfop === '1551', JSON.stringify(c.map((x) => x.cfop)));
});

t('CFOP de uso e consumo NÃO é imobilizado', () => {
  limpar();
  const nfe = novaNfe();
  novoItemNfe(nfe, { cfop: '1556', descricao: 'Material de escritório' });
  // 1556 é despesa, não bem: incluí-lo criaria patrimônio de caneta.
  assert(ctb.candidatosDaNfe(db).length === 0, 'trouxe uso e consumo');
});

t('CFOP de revenda também fica de fora', () => {
  limpar();
  const nfe = novaNfe();
  novoItemNfe(nfe, { cfop: '1102' });
  assert(ctb.candidatosDaNfe(db).length === 0, 'trouxe mercadoria de revenda');
});

t('item marcado como ignorado na nota não vira bem', () => {
  limpar();
  const nfe = novaNfe();
  novoItemNfe(nfe, { ignorado: 1 });
  assert(ctb.candidatosDaNfe(db).length === 0, 'trouxe item ignorado');
});

t('nota excluída não gera candidato', () => {
  limpar();
  const nfe = novaNfe();
  novoItemNfe(nfe);
  db.prepare('UPDATE nfe_entrada SET excluida = 1 WHERE id = ?').run(nfe);
  assert(ctb.candidatosDaNfe(db).length === 0, 'trouxe nota excluída');
});

t('IPI e frete entram no custo; desconto sai', () => {
  const c = ctb.custoDoItem({ valorTotal: 6000, valorIpi: 300, valorFrete: 200, valorDesconto: 100 });
  assert(perto(c, 6400), 'custo: ' + c);
});

t('gerar bem traz fornecedor, data da nota e custo com impostos', () => {
  limpar();
  const nfe = novaNfe();
  const item = novoItemNfe(nfe, { valorIpi: 300, valorFrete: 200 });
  const r = ctb.criarBensDaNfe(db, item, { categoria: 'TI', vidaUtilMeses: 60 });
  assert(r.criados.length === 1, JSON.stringify(r));
  const bem = db.prepare('SELECT * FROM patrimonio_bens WHERE id = ?').get(r.criados[0].id);
  assert(perto(bem.valorAquisicao, 6500), 'valor: ' + bem.valorAquisicao);
  assert(bem.dataAquisicao === '2026-05-10', 'data: ' + bem.dataAquisicao);
  assert(bem.fornecedorId === 1, 'fornecedor: ' + bem.fornecedorId);
  assert(bem.nfeEntradaItemId === item, 'não guardou a origem');
  assert(bem.categoria === 'TI' && bem.vidaUtilMeses === 60, JSON.stringify(bem));
});

t('quantidade 5 vira 5 bens, cada um com seu código', () => {
  limpar();
  const nfe = novaNfe();
  const item = novoItemNfe(nfe, { quantidade: 5, valorUnitario: 1000, valorTotal: 5000 });
  const r = ctb.criarBensDaNfe(db, item);
  // Patrimônio se controla por unidade: é o bem que é transferido e baixado.
  assert(r.criados.length === 5, 'criados: ' + r.criados.length);
  const codigos = new Set(r.criados.map((b) => b.codigo));
  assert(codigos.size === 5, 'códigos repetidos: ' + JSON.stringify(r.criados.map((b) => b.codigo)));
});

t('a soma dos bens bate com o valor da nota, mesmo com centavos', () => {
  limpar();
  const nfe = novaNfe();
  // 1000 / 3 = 333,333... A sobra tem que ir para algum bem.
  const item = novoItemNfe(nfe, { quantidade: 3, valorTotal: 1000 });
  const r = ctb.criarBensDaNfe(db, item);
  const soma = r.criados.reduce((s, b) => s + b.valorAquisicao, 0);
  assert(perto(soma, 1000), 'soma: ' + soma + ' vs nota 1000');
});

t('gerar de novo o mesmo item não duplica os bens', () => {
  limpar();
  const nfe = novaNfe();
  const item = novoItemNfe(nfe, { quantidade: 2, valorTotal: 2000 });
  ctb.criarBensDaNfe(db, item);
  const r2 = ctb.criarBensDaNfe(db, item);
  assert(r2.criados.length === 0 && r2.jaExistiam === 2, JSON.stringify(r2));
  assert(db.prepare('SELECT COUNT(*) n FROM patrimonio_bens').get().n === 2, 'duplicou');
});

t('item já convertido sai da lista de candidatos', () => {
  const c = ctb.candidatosDaNfe(db);
  assert(c.length === 0, 'continuou como pendente: ' + JSON.stringify(c));
});

t('conversão parcial mantém o item pendente pelo que falta', () => {
  limpar();
  const nfe = novaNfe();
  const item = novoItemNfe(nfe, { quantidade: 3, valorTotal: 3000 });
  db.prepare(`INSERT INTO patrimonio_bens (codigo, descricao, valorAquisicao, vidaUtilMeses, dataAquisicao, nfeEntradaItemId)
    VALUES ('BEM-P-1', 'parcial', 1000, 60, '2026-05-10', ?)`).run(item);
  const c = ctb.candidatosDaNfe(db);
  assert(c.length === 1, 'sumiu da lista tendo 2 a criar');
  const r = ctb.criarBensDaNfe(db, item);
  assert(r.criados.length === 2, 'criados: ' + r.criados.length);
});

t('a rota devolve os CFOPs que considerou', () => {
  const r = call('get', '/api/patrimonio/nfe-entrada/candidatos');
  assert(r.body.success && r.body.cfopsConsiderados.includes('1551'), JSON.stringify(r.body.cfopsConsiderados));
});

// ==================== CICLO COMPLETO ====================
console.log('\n--- da nota ao balanço ---');

t('nota → bem → aquisição → depreciação → baixa fecha em zero', () => {
  limpar(); mapearPadrao();
  const nfe = novaNfe({ dataEmissao: '2026-01-10T10:00:00-03:00' });
  const item = novoItemNfe(nfe, { quantidade: 1, valorTotal: 3000, valorUnitario: 3000 });
  const { criados } = ctb.criarBensDaNfe(db, item, { vidaUtilMeses: 3 });
  const id = criados[0].id;

  ctb.contabilizarAquisicao(db, id, { contaContrapartidaId: FORNEC });
  ctb.apurarDepreciacao(db, '2026-01');
  ctb.apurarDepreciacao(db, '2026-02');
  ctb.apurarDepreciacao(db, '2026-03');
  db.prepare("UPDATE patrimonio_bens SET status='baixado', dataBaixa='2026-04-05' WHERE id = ?").run(id);
  ctb.contabilizarBaixa(db, id);

  assert(perto(saldo(IMOB), 0), 'imobilizado: ' + saldo(IMOB));
  assert(perto(saldo(ACUM), 0), 'acumulada: ' + saldo(ACUM));
  assert(perto(saldo(DESP), 3000), 'despesa acumulada: ' + saldo(DESP));
  assert(perto(saldo(FORNEC), -3000), 'fornecedores: ' + saldo(FORNEC));
  assert(perto(saldo(RESULT), 0), 'sobrou perda num bem totalmente depreciado: ' + saldo(RESULT));
});

t('todo lançamento gerado fecha débito com crédito', () => {
  const desbalanceados = db.prepare(`
    SELECT l.id, l.historico,
           SUM(CASE WHEN p.dc='D' THEN p.valor ELSE -p.valor END) AS dif
    FROM lancamentos_contabeis l JOIN lancamento_partidas p ON p.lancamentoId = l.id
    GROUP BY l.id HAVING ABS(dif) > 0.005`).all();
  assert(desbalanceados.length === 0, JSON.stringify(desbalanceados));
});

t('conferência mostra o imobilizado por conta', () => {
  limpar(); mapearPadrao();
  novoBem({ valorAquisicao: 10000 });
  novoBem({ valorAquisicao: 5000 });
  ctb.apurarDepreciacao(db, '2026-03');
  const c = ctb.conferencia(db, '2026-03');
  const linha = c.porConta.find((x) => x.conta === '1.2.3.01');
  assert(linha && linha.bens === 2 && perto(linha.aquisicao, 15000), JSON.stringify(c.porConta));
  assert(perto(linha.contabil, 15000 - linha.depreciado), JSON.stringify(linha));
});

t('conferência aponta bem ativo sem aquisição contabilizada', () => {
  const c = ctb.conferencia(db, '2026-03');
  assert(c.bensAtivosSemAquisicaoContabilizada === 2, 'contou: ' + c.bensAtivosSemAquisicaoContabilizada);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
