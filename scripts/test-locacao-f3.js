#!/usr/bin/env node
/**
 * test-locacao-f3.js — Fase 3: o documento de locação.
 *
 * Cobre a máquina de estados (o que pode e o que não pode em cada status), a
 * numeração sequencial, a precificação do item pelo tarifário, a separação
 * locação/serviço exigida pela SV 31 e — o mais importante — o acoplamento
 * entre confirmar e a agenda: confirmar grava reserva, cancelar libera,
 * reabrir devolve o saldo.
 *
 * Uso: node scripts/test-locacao-f3.js
 */
const BASE = require('path').join(__dirname, '..');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig } = require('./locacao-teste-util');
const { registrarRotasLocacao } = require(BASE + '/locacao/locacao-routes');
const D = require(BASE + '/locacao/disponibilidade');
const C = require(BASE + '/locacao/contrato');

const db = new Database(copiaDoTenant('labfiscal'));

// Devolve toda chave `locacao_*` ao estado original na saída do processo —
// inclusive se este teste estourar no meio. Ver locacao-teste-util.js.
protegerConfig(db);
initLocacaoSchema(db);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function eq(a, b, msg) { assert(a === b, msg, `esperado ${b}, veio ${a}`); }
function secao(t) { console.log(`\n── ${t}`); }

// ─── Cenário ──────────────────────────────────────────────────────────────────
const SKU = 'TESTE-LOC-F3';
const PREFIXO_NUM = 'TSTF3';

function limpar() {
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(SKU + '%').map(r => r.id);
  const contratos = db.prepare('SELECT id FROM locacao_contratos WHERE numero LIKE ?').all(PREFIXO_NUM + '%').map(r => r.id);
  for (const cid of contratos) {
    db.prepare("DELETE FROM locacao_reservas WHERE documentoTipo='locacao' AND documentoId = ?").run(cid);
    db.prepare('DELETE FROM locacao_itens WHERE contratoId = ?').run(cid);
    db.prepare('DELETE FROM locacao_eventos WHERE contratoId = ?').run(cid);
    db.prepare('DELETE FROM locacao_contratos WHERE id = ?').run(cid);
  }
  for (const id of ids) {
    db.prepare('DELETE FROM locacao_reservas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_item_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_tarifas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
}
limpar();

const prod = db.prepare(`
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaSerial)
  VALUES (?, 'Gerador 15kVA (teste F3)', 'UN', 0, 1, 0)
`).run(SKU).lastInsertRowid;

const colsMov = db.prepare('PRAGMA table_info(movimentacoes_estoque)').all().map(c => c.name);
const campos = ['produtoId', 'tipo', 'quantidade'].concat(colsMov.includes('data') ? ['data'] : []);
const vals = [prod, 'entrada', 2].concat(colsMov.includes('data') ? ['2026-01-01 00:00:00'] : []);
db.prepare(`INSERT INTO movimentacoes_estoque (${campos.join(',')})
            VALUES (${campos.map(() => '?').join(',')})`).run(...vals);

db.prepare('INSERT INTO locacao_item_specs (produtoId, alugavel, exigeSerie, horasPreparo) VALUES (?, 1, 0, 0)').run(prod);
db.prepare("INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel) VALUES (?, 'dia', 200, 1)").run(prod);
db.prepare("INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel) VALUES (?, 'semana', 1000, 1)").run(prod);

const cliente = db.prepare('SELECT id FROM pessoas LIMIT 1').get();
assert(!!cliente, 'tenant tem ao menos uma pessoa para ser cliente');

// ─── Rotas ────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
registrarRotasLocacao(app, db);

function chamar(p, m, o = {}) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c => { st = c; return res; } };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, headers: {}, user: o.user };
  let i = 0;
  const next = () => { const h = l.route.stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_enabled'").get();
const prefixoOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_prefixo_numero'").get();
db.prepare(`INSERT INTO config (chave, valor) VALUES ('locacao_enabled','1')
            ON CONFLICT(chave) DO UPDATE SET valor='1'`).run();
db.prepare(`INSERT INTO config (chave, valor) VALUES ('locacao_prefixo_numero', ?)
            ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(PREFIXO_NUM);

// ─── Criação ──────────────────────────────────────────────────────────────────
secao('Criação do documento');

let r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-09-10 08:00', dataRetornoPrevisto: '2026-09-16 08:00' },
});
assert(r.st === 200 && r.out.contrato.id, 'POST cria a locação', JSON.stringify(r.out));
const loc1 = r.out.contrato.id;
eq(r.out.contrato.numero, `${PREFIXO_NUM}-2026-0001`, 'numeração começa em 0001');
eq(r.out.contrato.status, 'orcamento', 'nasce como orçamento');

r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-09-20 08:00', dataRetornoPrevisto: '2026-09-25 08:00' },
});
eq(r.out.contrato.numero, `${PREFIXO_NUM}-2026-0002`, 'numeração é sequencial');
const loc2 = r.out.contrato.id;

r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: 99999999, dataSaidaPrevista: '2026-09-10', dataRetornoPrevisto: '2026-09-11' },
});
assert(r.st === 400, 'cliente inexistente é recusado');

r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-09-10' },
});
assert(r.st === 400 && /avulsa exige/.test(r.out.error || ''),
  'avulsa sem retorno previsto é recusada', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, tipo: 'aberta', dataSaidaPrevista: '2026-09-10' },
});
assert(r.st === 200, 'aberta SEM retorno previsto é aceita (não tem fim por definição)');
const locAberta = r.out.contrato.id;

r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-09-16', dataRetornoPrevisto: '2026-09-10' },
});
assert(r.st === 400, 'retorno antes da saída é recusado');

r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, tipo: 'emprestimo', dataSaidaPrevista: '2026-09-10', dataRetornoPrevisto: '2026-09-11' },
});
assert(r.st === 400, 'tipo inválido é recusado');

// ─── Itens ────────────────────────────────────────────────────────────────────
secao('Itens: precificação pelo tarifário e separação SV 31');

r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc1 }, body: { produtoId: prod, quantidade: 1 },
});
assert(r.st === 200, 'item de locação é aceito', JSON.stringify(r.out.error));
const itemLoc = r.out.itens[0];
eq(itemLoc.valorTotal, 1000, '6 dias caem na semana (1000), não em 6 diárias (1200)');
eq(itemLoc.tarifaFaixa, 'semana', 'faixa principal registrada é semana');
eq(r.out.totais.valorLocacao, 1000, 'total de locação = 1000');
eq(r.out.totais.valorServicos, 0, 'total de serviço = 0');

r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc1 },
  body: { natureza: 'servico', descricao: 'Frete de entrega', quantidade: 1, valorUnitario: 250 },
});
assert(r.st === 200, 'item de serviço é aceito');
eq(r.out.totais.valorServicos, 250, 'serviço soma em coluna própria (SV 31)');
eq(r.out.totais.valorLocacao, 1000, 'locação não foi contaminada pelo serviço');
eq(r.out.totais.valorTotal, 1250, 'total é a soma das duas naturezas');

r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc1 }, body: { natureza: 'servico', quantidade: 1, valorUnitario: 100 },
});
assert(r.st === 400, 'serviço sem descrição é recusado');

r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc1 }, body: { natureza: 'locacao', quantidade: 1 },
});
assert(r.st === 400 && /exige produtoId/.test(r.out.error || ''), 'locação sem produto é recusada');

r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc1 }, body: { natureza: 'comodato', produtoId: prod },
});
assert(r.st === 400, 'natureza inválida é recusada');

// Produto não alugável
const prodNaoAlugavel = db.prepare(`
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo) VALUES (?, 'Parafuso', 'UN', 1, 1)
`).run(SKU + '-NA').lastInsertRowid;
r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc1 }, body: { produtoId: prodNaoAlugavel, quantidade: 1 },
});
assert(r.st === 400 && /alugável/.test(r.out.error || ''), 'produto sem spec de locação é recusado');

// Alterar quantidade reprecifica
r = chamar('/api/locacao/locacoes/:id/itens/:itemId', 'put', {
  params: { id: loc1, itemId: itemLoc.id }, body: { quantidade: 2 },
});
eq(r.out.totais.valorLocacao, 2000, 'dobrar a quantidade dobra o valor de locação');

// Alterar período reprecifica
r = chamar('/api/locacao/locacoes/:id/itens/:itemId', 'put', {
  params: { id: loc1, itemId: itemLoc.id }, body: { quantidade: 1, dataFim: '2026-09-11 08:00' },
});
eq(r.out.totais.valorLocacao, 200, '1 dia volta a custar 1 diária');

// Repõe 6 dias
chamar('/api/locacao/locacoes/:id/itens/:itemId', 'put', {
  params: { id: loc1, itemId: itemLoc.id }, body: { dataFim: '2026-09-16 08:00' },
});

// ─── Confirmação: o acoplamento com a agenda ──────────────────────────────────
secao('Confirmar grava reserva; cancelar e reabrir liberam');

let d = D.disponibilidade(db, prod, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 2, 'antes de confirmar, nada está reservado');

r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc1 } });
assert(r.st === 200 && r.out.contrato.status === 'reservado', 'confirmar move para reservado', JSON.stringify(r.out.error));
eq(r.out.reservas.filter(x => x.status === 'ativa').length, 1, 'uma reserva ativa foi gravada');

d = D.disponibilidade(db, prod, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 1, 'depois de confirmar, 1 das 2 unidades está ocupada');

// O serviço não vira reserva — não é bem que sai do estoque.
eq(r.out.reservas.length, 1, 'item de serviço não gera reserva');

r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc1 } });
assert(r.st === 409, 'confirmar duas vezes é 409', `st=${r.st}`);

r = chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: loc1 }, body: { produtoId: prod, quantidade: 1 },
});
assert(r.st === 409 && /orçamento/.test(r.out.error || ''),
  'não dá para acrescentar item depois de confirmado', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes/:id', 'put', {
  params: { id: loc1 }, body: { dataRetornoPrevisto: '2026-09-30 08:00' },
});
assert(r.st === 409 && /reabra/.test(r.out.error || ''),
  'mudar o período de um documento reservado é recusado com instrução', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes/:id', 'put', {
  params: { id: loc1 }, body: { observacoes: 'entregar no portão 3' },
});
assert(r.st === 200, 'campos que não afetam a agenda continuam editáveis');

r = chamar('/api/locacao/locacoes/:id', 'delete', { params: { id: loc1 } });
assert(r.st === 409 && /cancelar/.test(r.out.error || ''),
  'excluir documento reservado é recusado — manda cancelar', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes/:id/reabrir', 'post', { params: { id: loc1 } });
assert(r.st === 200 && r.out.contrato.status === 'orcamento', 'reabrir volta para orçamento');
d = D.disponibilidade(db, prod, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 2, 'reabrir liberou a reserva');

chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc1 } });

r = chamar('/api/locacao/locacoes/:id/cancelar', 'post', { params: { id: loc1 }, body: { motivo: 'cliente desistiu' } });
assert(r.st === 200 && r.out.contrato.status === 'cancelado', 'cancelar move para cancelado');
d = D.disponibilidade(db, prod, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 2, 'cancelar devolveu o saldo');

r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc1 } });
assert(r.st === 409, 'locação cancelada não volta a ser confirmada');

// ─── Confirmação sem item ─────────────────────────────────────────────────────
secao('Recusas de confirmação');

r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc2 } });
assert(r.st === 400 && /sem nenhum item/.test(r.out.error || ''),
  'confirmar sem item é recusado', JSON.stringify(r.out));

// Caução exigida
db.prepare(`INSERT INTO config (chave, valor) VALUES ('locacao_exigir_caucao','1')
            ON CONFLICT(chave) DO UPDATE SET valor='1'`).run();
chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id: loc2 }, body: { produtoId: prod, quantidade: 1 } });
r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc2 } });
assert(r.st === 400 && /caução/.test(r.out.error || ''),
  'com a trava ligada, confirmar sem caução é recusado', JSON.stringify(r.out));

chamar('/api/locacao/locacoes/:id', 'put', { params: { id: loc2 }, body: { caucaoValor: 1500 } });
r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc2 } });
assert(r.st === 200, 'com caução definida, confirma');
db.prepare("UPDATE config SET valor='0' WHERE chave='locacao_exigir_caucao'").run();

// ─── Conflito de agenda na confirmação ────────────────────────────────────────
secao('Confirmar recusa quando a agenda não comporta');

// loc2 ocupa 1 unidade de 20 a 25/09. Cria outra locação no mesmo período
// pedindo 2 unidades (só há 2 no total, 1 já ocupada).
r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-09-21 08:00', dataRetornoPrevisto: '2026-09-24 08:00' },
});
const loc3 = r.out.contrato.id;
chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id: loc3 }, body: { produtoId: prod, quantidade: 2 } });
r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc3 } });
assert(r.st === 400 || r.st === 500, 'confirmar com agenda cheia falha', `st=${r.st}`);
assert(/indispon/.test((r.out && r.out.error) || ''), 'a falha diz que está indisponível', JSON.stringify(r.out));
eq(db.prepare('SELECT status FROM locacao_contratos WHERE id = ?').get(loc3).status, 'orcamento',
  'documento continua orçamento depois da falha (transação desfez tudo)');
eq(db.prepare("SELECT COUNT(*) n FROM locacao_reservas WHERE documentoId = ? AND status='ativa'").get(loc3).n, 0,
  'nenhuma reserva parcial ficou gravada');

// Com 1 unidade cabe.
chamar('/api/locacao/locacoes/:id/itens/:itemId', 'put', {
  params: { id: loc3, itemId: db.prepare('SELECT id FROM locacao_itens WHERE contratoId = ?').get(loc3).id },
  body: { quantidade: 1 },
});
r = chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc3 } });
assert(r.st === 200, 'com 1 unidade a confirmação passa', JSON.stringify(r.out.error));

// ─── Listagem, leitura e eventos ──────────────────────────────────────────────
secao('Listagem, leitura e trilha de eventos');

r = chamar('/api/locacao/locacoes', 'get', { query: { status: 'reservado' } });
assert(r.st === 200 && r.out.locacoes.length >= 2, 'GET lista por status');

// O filtro por tipo separa período fechado de mensal-até-devolver — são
// operações diferentes no balcão e a lista precisa dar para olhar uma de cada vez.
r = chamar('/api/locacao/locacoes', 'get', { query: { tipo: 'aberta' } });
assert(r.st === 200 && r.out.locacoes.every(l => l.tipo === 'aberta'),
  'filtro tipo=aberta traz só as mensais', JSON.stringify(r.out.locacoes.map(l => l.tipo)));

r = chamar('/api/locacao/locacoes', 'get', { query: { tipo: 'avulsa' } });
assert(r.out.locacoes.every(l => l.tipo === 'avulsa'),
  'filtro tipo=avulsa traz só as de período fechado');

const semFiltro = chamar('/api/locacao/locacoes', 'get', { query: {} }).out.locacoes.length;
const soAbertas = chamar('/api/locacao/locacoes', 'get', { query: { tipo: 'aberta' } }).out.locacoes.length;
assert(semFiltro >= soAbertas, 'sem filtro traz pelo menos tanto quanto filtrado');

r = chamar('/api/locacao/locacoes', 'get', { query: { busca: PREFIXO_NUM } });
assert(r.out.locacoes.length >= 3, 'busca por número encontra');

r = chamar('/api/locacao/locacoes/:id', 'get', { params: { id: loc1 } });
assert(r.st === 200 && r.out.eventos.length >= 3,
  'documento carrega a trilha de eventos (criar, confirmar, reabrir, cancelar)',
  JSON.stringify(r.out.eventos.map(e => e.tipo)));
const tipos = r.out.eventos.map(e => e.tipo);
assert(tipos.includes('criar') && tipos.includes('confirmar') && tipos.includes('cancelar'),
  'eventos registram cada transição', tipos.join(','));

r = chamar('/api/locacao/locacoes/:id', 'get', { params: { id: 99999999 } });
assert(r.st === 404, 'documento inexistente devolve 404');

// Exclusão de orçamento puro
r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-10-01', dataRetornoPrevisto: '2026-10-02' },
});
const locTmp = r.out.contrato.id;
r = chamar('/api/locacao/locacoes/:id', 'delete', { params: { id: locTmp } });
assert(r.st === 200, 'orçamento puro pode ser excluído');
assert(!db.prepare('SELECT id FROM locacao_contratos WHERE id = ?').get(locTmp), 'linha sumiu do banco');

// ─── Transições diretas na lib ────────────────────────────────────────────────
secao('Máquina de estados (tabela de transições)');
assert(C.podeTransicionar('orcamento', 'reservado'), 'orcamento → reservado');
assert(C.podeTransicionar('reservado', 'emAndamento'), 'reservado → emAndamento');
assert(C.podeTransicionar('emAndamento', 'devolvido'), 'emAndamento → devolvido');
assert(!C.podeTransicionar('emAndamento', 'cancelado'), 'emAndamento ✗ cancelado (o bem já saiu)');
assert(!C.podeTransicionar('orcamento', 'emAndamento'), 'orcamento ✗ emAndamento (pula a reserva)');
assert(!C.podeTransicionar('encerrado', 'orcamento'), 'encerrado é terminal');
assert(!C.podeTransicionar('cancelado', 'reservado'), 'cancelado é terminal');

// ─── Limpeza ──────────────────────────────────────────────────────────────────
db.prepare('DELETE FROM produtos WHERE id = ?').run(prodNaoAlugavel);
limpar();
if (flagOriginal) db.prepare("UPDATE config SET valor = ? WHERE chave = 'locacao_enabled'").run(flagOriginal.valor);
else db.prepare("DELETE FROM config WHERE chave = 'locacao_enabled'").run();
if (prefixoOriginal) db.prepare("UPDATE config SET valor = ? WHERE chave = 'locacao_prefixo_numero'").run(prefixoOriginal.valor);
else db.prepare("DELETE FROM config WHERE chave = 'locacao_prefixo_numero'").run();

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
