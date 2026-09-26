/**
 * Governança: evento percentual (`desconto_venda`) × eventos monetários.
 *
 * Exercita as ROTAS REAIS de `governanca-routes.js` sobre banco descartável, e
 * a formatação da TELA sobre a mesma fonte de verdade que ela usa — o catálogo
 * devolvido pela API.
 *
 * O que se quer provar, em uma frase: o limite de `desconto_venda` nunca é
 * apresentado nem salvo como dinheiro, e os dois eventos monetários continuam
 * exatamente como estavam.
 *
 * Schema: sqlite3 data/tenants/1bit/pncp.db .schema > /tmp/app-backend-schema.sql
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');

// O texto do schema, tirado do tenant na hora (ver schema-de-tenant.js). Até
// 25/09 vinha de um /tmp/app-backend-schema.sql gerado à mão, que some no reboot.
const SCHEMA = require('./schema-de-tenant').lerSchema('/tmp/app-backend-schema.sql');
const DB = `/tmp/gov-percentual-${process.pid}.db`;
try { fs.unlinkSync(DB); } catch {}
const criar = new Database(DB);
criar.exec(SCHEMA
  .split(/;\s*\n/).filter((s) => !/sqlite_sequence/i.test(s)).join(';\n'));
criar.close();

const dbt = new Database(DB);
const { registrarRotasGovernanca } = require('../governanca-routes');
const alc = require('../governanca-alcadas');

const app = express();
registrarRotasGovernanca(app, dbt);

const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find((x) => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: o.session || {}, user: o.user || { id: 1, username: 'admin', role: 'admin' },
                ip: '127.0.0.1', headers: {} },
    { json: (x) => { out = x; return { json: (y) => { out = y; } }; },
      status: (c) => { st = c; return { json: (x) => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed: usuários para os papéis existirem ----------
dbt.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (1,'admin','x','Admin','admin',1)").run();
dbt.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (2,'fin','x','Fin','financeiro',1)").run();
dbt.prepare("INSERT INTO users (id, username, passwordHash, nome, role, ativo) VALUES (3,'ger','x','Gerente','gerente-comercial',1)").run();
dbt.prepare("INSERT INTO perfis_acesso (slug, nome, paginas, ativo) VALUES ('gerente-comercial','Gerente Comercial',?,1)")
  .run(JSON.stringify(['pedidos']));

const listar = () => chamar('/api/alcadas/regras', 'get');
const criarRegra = (body) => chamar('/api/alcadas/regras', 'post', { body });
const editar = (id, body) => chamar('/api/alcadas/regras/:id', 'put', { params: { id }, body });
const regraDe = (id) => dbt.prepare('SELECT * FROM regras_alcada WHERE id = ?').get(id);

/**
 * A MESMA formatação da tela (`fmtLimite` em alcadas.html), reproduzida aqui
 * sobre o catálogo da API. Se a tela e este teste divergirem, é porque alguém
 * mudou um dos dois — e é isso que se quer detectar.
 */
function fmtLimite(v, tipo, eventos) {
  const e = eventos.find((x) => x.valor === tipo) || {};
  const n = Number(v);
  if (e.unidade === 'percentual') {
    return (Number.isInteger(n) ? String(n)
      : n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })) + '%';
  }
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ==================== A. CATÁLOGO ====================
t('A1. a listagem devolve o catalogo de eventos (a tela nao duplica lista)', () => {
  const d = listar().out;
  assert(d.success && Array.isArray(d.eventos), 'sem catalogo: ' + JSON.stringify(Object.keys(d)));
  assert(d.eventos.length === alc.TIPOS_EVENTO.length, 'catalogo incompleto: ' + d.eventos.length);
  for (const tipo of alc.TIPOS_EVENTO) {
    assert(d.eventos.some((e) => e.valor === tipo), 'faltou ' + tipo);
  }
});

t('A2. desconto_venda e declarado PERCENTUAL; os outros dois, moeda', () => {
  const ev = listar().out.eventos;
  const u = (v) => (ev.find((e) => e.valor === v) || {}).unidade;
  assert(u('desconto_venda') === 'percentual', 'desconto_venda=' + u('desconto_venda'));
  assert(u('pagamento_cp') === 'moeda', 'pagamento_cp=' + u('pagamento_cp'));
  assert(u('pedido_compra') === 'moeda', 'pedido_compra=' + u('pedido_compra'));
});

t('A3. so o evento percentual declara teto (100)', () => {
  const ev = listar().out.eventos;
  assert((ev.find((e) => e.valor === 'desconto_venda') || {}).maximo === 100, 'sem teto');
  assert((ev.find((e) => e.valor === 'pagamento_cp') || {}).maximo === null, 'monetario ganhou teto');
});

t('A4. os papeis incluem os perfis CUSTOMIZADOS do tenant', () => {
  const p = listar().out.papeis;
  assert(Array.isArray(p), 'sem papeis');
  assert(p.includes('gerente-comercial'), 'perfil customizado ausente: ' + JSON.stringify(p));
  for (const nativo of ['admin', 'financeiro', 'comercial']) {
    assert(p.includes(nativo), 'nativo sumiu: ' + nativo);
  }
});

// ==================== B. CRIAR ====================
let ID_PCT5, ID_PCT15, ID_MOEDA;

t('B1. criar desconto_venda 5% com aprovador CUSTOMIZADO', () => {
  const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: 5, papelAprovador: 'gerente-comercial', validadeDias: 7 });
  assert(r.st === 200 && r.out.success, 'status=' + r.st + ' ' + JSON.stringify(r.out.error));
  ID_PCT5 = r.out.id;
  const g = regraDe(ID_PCT5);
  assert(Number(g.limiteValor) === 5, 'gravou ' + g.limiteValor + ' (nao pode virar centavos nem 5.00 de moeda)');
  assert(g.papelAprovador === 'gerente-comercial', 'papel=' + g.papelAprovador);
});

t('B2. criar desconto_venda 15% -> admin', () => {
  const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: 15, papelAprovador: 'admin', validadeDias: 7 });
  assert(r.st === 200, JSON.stringify(r.out));
  ID_PCT15 = r.out.id;
  assert(Number(regraDe(ID_PCT15).limiteValor) === 15, 'gravou ' + regraDe(ID_PCT15).limiteValor);
});

t('B3. decimal e suportado (2 casas, a precisao do backend)', () => {
  const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: 7.5, papelAprovador: 'admin' });
  assert(r.st === 200, JSON.stringify(r.out));
  assert(Number(regraDe(r.out.id).limiteValor) === 7.5, 'gravou ' + regraDe(r.out.id).limiteValor);
  editar(r.out.id, { ativo: 0 });
});

t('B4. evento MONETARIO continua aceitando valor grande, sem teto', () => {
  const r = criarRegra({ tipoEvento: 'pagamento_cp', limiteValor: 50000, papelAprovador: 'financeiro' });
  assert(r.st === 200, JSON.stringify(r.out));
  ID_MOEDA = r.out.id;
  assert(Number(regraDe(ID_MOEDA).limiteValor) === 50000, 'gravou ' + regraDe(ID_MOEDA).limiteValor);
});

// ==================== C. LISTAGEM / FORMATAÇÃO ====================
t('C1. 5 de desconto_venda se le "5%", nunca "R$ 5,00"', () => {
  const d = listar().out;
  const txt = fmtLimite(5, 'desconto_venda', d.eventos);
  assert(txt === '5%', 'formatou "' + txt + '"');
  assert(!/R\$/.test(txt), 'apareceu R$ num percentual');
});

t('C2. 50000 de pagamento_cp continua "R$ 50.000,00"', () => {
  const d = listar().out;
  const txt = fmtLimite(50000, 'pagamento_cp', d.eventos);
  assert(txt === 'R$ 50.000,00', 'formatou "' + txt + '"');
});

t('C3. percentual decimal mostra a casa; inteiro nao inventa ",00"', () => {
  const ev = listar().out.eventos;
  assert(fmtLimite(7.5, 'desconto_venda', ev) === '7,5%', fmtLimite(7.5, 'desconto_venda', ev));
  assert(fmtLimite(15, 'desconto_venda', ev) === '15%', fmtLimite(15, 'desconto_venda', ev));
});

t('C4. nenhuma faixa percentual e exibida com simbolo de moeda', () => {
  const d = listar().out;
  for (const r of d.regras) {
    const txt = fmtLimite(r.limiteValor, r.tipoEvento, d.eventos);
    const pct = (d.eventos.find((e) => e.valor === r.tipoEvento) || {}).unidade === 'percentual';
    assert(pct ? /%$/.test(txt) && !/R\$/.test(txt) : /^R\$/.test(txt),
      `${r.tipoEvento} formatado como "${txt}"`);
  }
});

// ==================== D. EDITAR → RELER ====================
t('D1. criar -> editar -> salvar -> reler preserva o percentual', () => {
  const antes = Number(regraDe(ID_PCT5).limiteValor);
  assert(antes === 5, 'antes=' + antes);
  const r = editar(ID_PCT5, { limiteValor: 8, papelAprovador: 'gerente-comercial', validadeDias: 7 });
  assert(r.st === 200, JSON.stringify(r.out));
  assert(Number(regraDe(ID_PCT5).limiteValor) === 8, 'depois=' + regraDe(ID_PCT5).limiteValor);
  // volta ao valor original para os testes seguintes
  editar(ID_PCT5, { limiteValor: 5 });
  assert(Number(regraDe(ID_PCT5).limiteValor) === 5, 'nao voltou');
});

t('D2. o valor que volta ao campo de edicao nao ganha ",00" de moeda', () => {
  // Reproduz a linha da tela: percentual usa String(Number(v)), moeda usa toFixed(2).
  const ev = listar().out.eventos;
  const paraCampo = (v, tipo) => (ev.find((e) => e.valor === tipo) || {}).unidade === 'percentual'
    ? String(Number(v)) : Number(v).toFixed(2);
  assert(paraCampo(5, 'desconto_venda') === '5', 'percentual virou ' + paraCampo(5, 'desconto_venda'));
  assert(paraCampo(7.5, 'desconto_venda') === '7.5', paraCampo(7.5, 'desconto_venda'));
  assert(paraCampo(50000, 'pagamento_cp') === '50000.00', paraCampo(50000, 'pagamento_cp'));
});

t('D3. editar so o papel nao mexe no limite', () => {
  editar(ID_PCT15, { papelAprovador: 'admin' });
  assert(Number(regraDe(ID_PCT15).limiteValor) === 15, 'limite mudou: ' + regraDe(ID_PCT15).limiteValor);
});

t('D4. desativar e reativar preserva o limite percentual', () => {
  editar(ID_PCT5, { ativo: 0 });
  assert(regraDe(ID_PCT5).ativo === 0, 'nao desativou');
  editar(ID_PCT5, { ativo: 1 });
  assert(regraDe(ID_PCT5).ativo === 1 && Number(regraDe(ID_PCT5).limiteValor) === 5, 'perdeu o limite');
});

// ==================== E. SEGURANÇA ====================
t('E1. percentual NEGATIVO e recusado', () => {
  const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: -5, papelAprovador: 'admin' });
  assert(r.st === 400, 'status=' + r.st);
});

t('E2. percentual ACIMA de 100 e recusado', () => {
  const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: 150, papelAprovador: 'admin' });
  assert(r.st === 400, 'status=' + r.st);
  assert(/máximo é 100%|100%/.test(r.out.error), 'msg=' + r.out.error);
});

t('E3. mas 150 em evento MONETARIO continua valido (nao contaminou)', () => {
  const r = criarRegra({ tipoEvento: 'pagamento_cp', limiteValor: 150, papelAprovador: 'financeiro' });
  assert(r.st === 200, 'monetario passou a ter teto: ' + JSON.stringify(r.out));
  editar(r.out.id, { ativo: 0 });
});

t('E4. string invalida e recusada', () => {
  assert(criarRegra({ tipoEvento: 'desconto_venda', limiteValor: 'abc', papelAprovador: 'admin' }).st === 400, 'aceitou string');
});

t('E5. NaN e recusado', () => {
  assert(criarRegra({ tipoEvento: 'desconto_venda', limiteValor: NaN, papelAprovador: 'admin' }).st === 400, 'aceitou NaN');
  assert(criarRegra({ tipoEvento: 'desconto_venda', limiteValor: null, papelAprovador: 'admin' }).st === 400, 'aceitou null');
});

t('E6. valor MASCARADO como moeda ("R$ 5,00") e recusado', () => {
  for (const v of ['R$ 5,00', '5,00', 'R$5']) {
    const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: v, papelAprovador: 'admin' });
    assert(r.st === 400, `aceitou "${v}": status=${r.st}`);
  }
});

t('E7. tipoEvento invalido e recusado', () => {
  const r = criarRegra({ tipoEvento: 'desconto_inventado', limiteValor: 5, papelAprovador: 'admin' });
  assert(r.st === 400 && /tipoEvento/i.test(r.out.error), 'msg=' + r.out.error);
});

t('E8. papel inexistente continua recusado (nao afrouxou)', () => {
  const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: 5, papelAprovador: 'diretor-supremo' });
  assert(r.st === 400 && /não existe/i.test(r.out.error), 'msg=' + r.out.error);
});

t('E9. faixa duplicada no mesmo ponto continua recusada', () => {
  const r = criarRegra({ tipoEvento: 'desconto_venda', limiteValor: 5, papelAprovador: 'admin' });
  assert(r.st === 400 && /Já existe uma faixa/i.test(r.out.error), 'msg=' + r.out.error);
});

// ==================== F. SEMÂNTICA PRESERVADA ====================
t('F1. a faixa de 5% vale para 6%, nao para 5% (acima de)', () => {
  assert(alc.regraAplicavel(dbt, 'desconto_venda', 5) === null, '5 caiu numa faixa');
  const r6 = alc.regraAplicavel(dbt, 'desconto_venda', 6);
  assert(r6 && Number(r6.limiteValor) === 5, '6% caiu em ' + (r6 && r6.limiteValor));
  const r16 = alc.regraAplicavel(dbt, 'desconto_venda', 16);
  assert(r16 && Number(r16.limiteValor) === 15, '16% caiu em ' + (r16 && r16.limiteValor));
});

t('F2. os eventos monetarios mantem a semantica anterior', () => {
  assert(alc.regraAplicavel(dbt, 'pagamento_cp', 1000) === null, '1000 caiu na faixa de 50000');
  const r = alc.regraAplicavel(dbt, 'pagamento_cp', 60000);
  assert(r && Number(r.limiteValor) === 50000, '60000 caiu em ' + (r && r.limiteValor));
});

t('F3. o simulador responde para desconto_venda', () => {
  const s = alc.simular(dbt, 'desconto_venda', 6);
  assert(s.exigeAprovacao === true, 'nao exigiu');
  assert(Number(s.acimaDe) === 5, 'acimaDe=' + s.acimaDe);
  assert(s.papel === 'gerente-comercial', 'papel=' + s.papel);
});

t('F4. o diagnostico inclui desconto_venda entre os eventos', () => {
  const g = alc.diagnostico(dbt);
  assert(g.faixasPorEvento.some((x) => x.tipoEvento === 'desconto_venda'), 'evento ausente no diagnostico');
});

dbt.close();
try { fs.unlinkSync(DB); } catch {}
console.log(`\n${ok} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
