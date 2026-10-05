#!/usr/bin/env node
/**
 * test-locacao-f4.js — Fase 4: saída, retorno e avaria via OS.
 *
 * O que precisa ficar provado aqui:
 *  1. a vistoria usa a OS de verdade — tipo semeado, checklist copiado na
 *     criação, e o obrigatório TRAVANDO a entrega;
 *  2. a devolução apura sozinha atraso, excedente de medidor e item não
 *     devolvido, e a reapuração não empilha multa;
 *  3. o que voltou libera a agenda; o que ficou com o cliente, não.
 *
 * Uso: node scripts/test-locacao-f4.js
 */
const BASE = require('path').join(__dirname, '..');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig } = require('./locacao-teste-util');
const { registrarRotasLocacao } = require(BASE + '/locacao/locacao-routes');
const D = require(BASE + '/locacao/disponibilidade');
const V = require(BASE + '/locacao/vistoria');

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
const SKU = 'TESTE-LOC-F4';
const PREFIXO_NUM = 'TSTF4';

function limpar() {
  const contratos = db.prepare('SELECT id, osEntregaId, osDevolucaoId FROM locacao_contratos WHERE numero LIKE ?')
    .all(PREFIXO_NUM + '%');
  for (const c of contratos) {
    for (const osId of [c.osEntregaId, c.osDevolucaoId]) {
      if (osId) {
        db.prepare('DELETE FROM os_checklist WHERE osId = ?').run(osId);
        try { db.prepare('DELETE FROM os_eventos WHERE osId = ?').run(osId); } catch (_) {}
        db.prepare('DELETE FROM os_ordens WHERE id = ?').run(osId);
      }
    }
    db.prepare("DELETE FROM locacao_reservas WHERE documentoTipo='locacao' AND documentoId = ?").run(c.id);
    db.prepare('DELETE FROM locacao_acertos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_avarias WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_medidor_leituras WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_itens WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_eventos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_contratos WHERE id = ?').run(c.id);
  }
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(SKU + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM locacao_reservas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_medidor_leituras WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_item_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_tarifas WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM locacao_tarifa_extras WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
}
limpar();

function criarProduto(sku, descricao, qtd, spec, tarifas) {
  const id = db.prepare(`
    INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo, rastreiaSerial)
    VALUES (?, ?, 'UN', 0, 1, 0)
  `).run(sku, descricao).lastInsertRowid;
  const cols = db.prepare('PRAGMA table_info(movimentacoes_estoque)').all().map(c => c.name);
  const campos = ['produtoId', 'tipo', 'quantidade'].concat(cols.includes('data') ? ['data'] : []);
  const vals = [id, 'entrada', qtd].concat(cols.includes('data') ? ['2026-01-01 00:00:00'] : []);
  db.prepare(`INSERT INTO movimentacoes_estoque (${campos.join(',')})
              VALUES (${campos.map(() => '?').join(',')})`).run(...vals);
  db.prepare(`INSERT INTO locacao_item_specs
                (produtoId, alugavel, exigeSerie, horasPreparo, medidorTipo, franquiaPorDia, valorReposicao)
              VALUES (?, 1, 0, ?, ?, ?, ?)`)
    .run(id, spec.horasPreparo || 0, spec.medidorTipo || 'nenhum',
         spec.franquiaPorDia || null, spec.valorReposicao || null);
  for (const t of tarifas) {
    db.prepare('INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel) VALUES (?, ?, ?, 1)')
      .run(id, t.faixa, t.valor);
  }
  return id;
}

const prodMaquina = criarProduto(SKU + '-M', 'Escavadeira (teste F4)', 2,
  { medidorTipo: 'horimetro', franquiaPorDia: 8, valorReposicao: 90000 },
  [{ faixa: 'dia', valor: 500 }, { faixa: 'semana', valor: 2500 }]);

const prodSimples = criarProduto(SKU + '-S', 'Compressor (teste F4)', 2,
  { valorReposicao: 3000 }, [{ faixa: 'dia', valor: 100 }]);

db.prepare(`INSERT INTO locacao_tarifa_extras (produtoId, tipo, valor, ativo)
            VALUES (?, 'hora_extra', 60, 1)`).run(prodMaquina);

const cliente = db.prepare('SELECT id FROM pessoas LIMIT 1').get();

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

const cfgOriginal = {};
for (const k of ['locacao_enabled', 'locacao_prefixo_numero', 'locacao_exigir_vistoria',
                 'locacao_carencia_atraso_horas', 'locacao_multa_atraso_percentual']) {
  cfgOriginal[k] = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k);
}
function setCfg(k, v) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(k, String(v));
}
setCfg('locacao_enabled', '1');
setCfg('locacao_prefixo_numero', PREFIXO_NUM);
setCfg('locacao_exigir_vistoria', '1');
setCfg('locacao_carencia_atraso_horas', '3');
setCfg('locacao_multa_atraso_percentual', '100');

function novaLocacao(saida, retorno, itens) {
  const r = chamar('/api/locacao/locacoes', 'post', {
    body: { clienteId: cliente.id, dataSaidaPrevista: saida, dataRetornoPrevisto: retorno },
  });
  const id = r.out.contrato.id;
  for (const it of itens) {
    chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id }, body: it });
  }
  chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id } });
  return id;
}

// ─── Tipos de OS semeados ─────────────────────────────────────────────────────
secao('Tipos de OS de vistoria');
const tipos = V.garantirTiposOS(db);
assert(!!tipos.entregaId && !!tipos.devolucaoId, 'os dois tipos são criados');
const tipos2 = V.garantirTiposOS(db);
eq(tipos2.entregaId, tipos.entregaId, 'garantirTiposOS é idempotente (não duplica)');

const tipoEntrega = db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(tipos.entregaId);
eq(tipoEntrega.slug, 'locacao-entrega', 'slug do tipo de entrega');
eq(tipoEntrega.exigeAssinaturaCliente, 1, 'tipo exige assinatura do cliente');
const chkPadrao = JSON.parse(tipoEntrega.checklistPadrao);
assert(chkPadrao.length >= 5, 'checklist padrão tem itens', String(chkPadrao.length));
assert(chkPadrao.some(i => i.obrigatorio), 'há item obrigatório no checklist padrão');

// ─── Entrega com vistoria travando ────────────────────────────────────────────
secao('Entrega: o checklist obrigatório trava a saída');

const loc1 = novaLocacao('2026-09-10 08:00', '2026-09-16 08:00',
  [{ produtoId: prodMaquina, quantidade: 1 }]);

let r = chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: loc1 } });
assert(r.st === 400 && /exige vistoria/.test(r.out.error || ''),
  'com vistoria exigida e sem OS, entregar é recusado', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes/:id/entregar', 'post', {
  params: { id: loc1 }, body: { abrirVistoria: true },
});
assert(r.st === 409 && !!r.out.os, 'abrirVistoria abre a OS e pede para concluir o checklist', JSON.stringify(r.out.error));
const osEntregaId = r.out.os.id;

const checklist = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem').all(osEntregaId);
assert(checklist.length === chkPadrao.length, 'checklist foi copiado para a OS', String(checklist.length));
const obrigatorios = checklist.filter(i => i.obrigatorio);
assert(obrigatorios.length >= 3, 'a OS tem itens obrigatórios');

r = chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: loc1 } });
assert(r.st === 409 && Array.isArray(r.out.checklist) && r.out.checklist.length > 0,
  'entregar com checklist pendente é recusado e lista as pendências',
  JSON.stringify(r.out.error));

// Conclui só metade dos obrigatórios — ainda deve travar.
db.prepare('UPDATE os_checklist SET concluido = 1 WHERE id = ?').run(obrigatorios[0].id);
r = chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: loc1 } });
assert(r.st === 409, 'checklist parcialmente concluído ainda trava');

db.prepare('UPDATE os_checklist SET concluido = 1 WHERE osId = ? AND obrigatorio = 1').run(osEntregaId);
r = chamar('/api/locacao/locacoes/:id/entregar', 'post', {
  params: { id: loc1 },
  body: { dataSaidaReal: '2026-09-10 09:15', medidores: [
    { itemId: db.prepare('SELECT id FROM locacao_itens WHERE contratoId = ?').get(loc1).id,
      valor: 1200, tipo: 'horimetro' },
  ] },
});
assert(r.st === 200 && r.out.contrato.status === 'emAndamento',
  'com o checklist concluído, a entrega passa', JSON.stringify(r.out.error));
eq(r.out.contrato.dataSaidaReal, '2026-09-10 09:15:00', 'data real de saída gravada');
eq(r.out.itens[0].medidorSaida, 1200, 'leitura de saída gravada no item');

const leituraSaida = db.prepare("SELECT * FROM locacao_medidor_leituras WHERE contratoId = ? AND origem='saida'").get(loc1);
assert(!!leituraSaida, 'leitura de saída também vai para o histórico do medidor');

const reservaDepois = db.prepare("SELECT status FROM locacao_reservas WHERE documentoId = ?").get(loc1);
eq(reservaDepois.status, 'consumida', "reserva vira 'consumida' quando o bem sai");
let d = D.disponibilidade(db, prodMaquina, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 1, 'item na rua continua ocupando a agenda');

r = chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: loc1 } });
assert(r.st === 409, 'entregar duas vezes é recusado');

r = chamar('/api/locacao/locacoes/:id/cancelar', 'post', { params: { id: loc1 } });
assert(r.st === 409 && /já saiu/.test(r.out.error || ''),
  'cancelar depois da saída é recusado com a explicação certa', JSON.stringify(r.out));

// ─── Devolução no prazo, sem excedente ────────────────────────────────────────
secao('Devolução no prazo');

db.prepare('UPDATE locacao_contratos SET osDevolucaoId = NULL WHERE id = ?').run(loc1);

// Resumo das vistorias na capa do contrato. Este é o ponto exato em que o bem
// saiu conferido e ainda não voltou: a capa tem de dizer as duas coisas, e era
// o que faltava — o rastro da vistoria vivia só no Histórico colapsado.
r = chamar('/api/locacao/locacoes/:id', 'get', { params: { id: loc1 } });
eq((r.out.vistorias || []).length, 2, 'a capa traz os dois momentos de vistoria');
const vSaida = r.out.vistorias.find(v => v.momento === 'entrega');
const vRetorno = r.out.vistorias.find(v => v.momento === 'devolucao');
eq(vSaida.os && vSaida.os.id, osEntregaId, 'a vistoria de saída aponta para a OS de entrega');
eq(vSaida.pendencias, 0, 'saída sem item obrigatório em aberto');
eq(vRetorno.os, null, 'o retorno ainda não vistoriado aparece como não realizado');

// E a tela tem de desenhar isso no corpo do contrato: o dado existir na rota
// sem sair do "Histórico" colapsado era exatamente o defeito.
const telaLocacoes = require('fs').readFileSync(BASE + '/public/locacao/locacoes.html', 'utf8');
assert(/d\.vistorias/.test(telaLocacoes), 'a tela do contrato não lê as vistorias');
assert(telaLocacoes.indexOf('blocoVistorias}') < telaLocacoes.indexOf('<summary class="muted">Histórico'),
  'o resumo das vistorias precisa vir ANTES do Histórico colapsado, no corpo do contrato');

r = chamar('/api/locacao/locacoes/:id/devolver', 'post', {
  params: { id: loc1 }, body: { abrirVistoria: true },
});
assert(r.st === 409 && !!r.out.os, 'devolver abre a OS de devolução');
const osDevId = r.out.os.id;
db.prepare('UPDATE os_checklist SET concluido = 1 WHERE osId = ? AND obrigatorio = 1').run(osDevId);

const itemLoc1 = db.prepare('SELECT id FROM locacao_itens WHERE contratoId = ?').get(loc1);
r = chamar('/api/locacao/locacoes/:id/devolver', 'post', {
  params: { id: loc1 },
  body: {
    dataRetornoReal: '2026-09-16 07:30',
    medidores: [{ itemId: itemLoc1.id, valor: 1240, tipo: 'horimetro' }],
  },
});
assert(r.st === 200 && r.out.contrato.status === 'devolvido', 'devolução no prazo é aceita', JSON.stringify(r.out.error));
assert(r.out.resumo.atraso && r.out.resumo.atraso.aplicavel === false, 'sem atraso, sem multa');
// 6 dias × franquia 8 = 48h; usou 40h → sem excedente
eq(r.out.resumo.medidores.length, 0, '40h em 6 dias (franquia 48) não gera excedente');
eq(r.out.acertos.length, 0, 'nenhum acerto foi criado');
eq(r.out.contrato.valorTotal, 2500, 'total continua o da locação (semana)');

d = D.disponibilidade(db, prodMaquina, '2026-09-12 08:00', '2026-09-13 08:00');
eq(d.disponivel, 2, 'devolver libera a agenda do período');

r = chamar('/api/locacao/locacoes/:id', 'get', { params: { id: loc1 } });
eq(r.out.vistorias.find(v => v.momento === 'devolucao').os.id, osDevId,
  'depois da devolução, a capa aponta para a OS de retorno');

r = chamar('/api/locacao/locacoes/:id/devolver', 'post', { params: { id: loc1 } });
assert(r.st === 409, 'devolver duas vezes é recusado');

// ─── Devolução com atraso + excedente + avaria ────────────────────────────────
secao('Devolução com atraso, excedente de medidor e avaria');

const loc2 = novaLocacao('2026-10-01 08:00', '2026-10-06 08:00',
  [{ produtoId: prodMaquina, quantidade: 1 }]);
const item2 = db.prepare('SELECT id FROM locacao_itens WHERE contratoId = ?').get(loc2);

// Entrega direta (sem exigir vistoria, para o teste focar na apuração)
setCfg('locacao_exigir_vistoria', '0');
chamar('/api/locacao/locacoes/:id/entregar', 'post', {
  params: { id: loc2 },
  body: { dataSaidaReal: '2026-10-01 08:00', medidores: [{ itemId: item2.id, valor: 2000 }] },
});

// Avaria registrada antes da devolução
r = chamar('/api/locacao/locacoes/:id/avarias', 'post', {
  params: { id: loc2 },
  body: { itemId: item2.id, descricao: 'Vidro da cabine trincado', gravidade: 'media', valorCobrado: 850 },
});
assert(r.st === 200, 'avaria registrada', JSON.stringify(r.out.error));

r = chamar('/api/locacao/locacoes/:id/avarias', 'post', {
  params: { id: loc2 }, body: { descricao: 'x', gravidade: 'catastrofica', valorCobrado: 10 },
});
assert(r.st === 400, 'gravidade inválida é recusada');

r = chamar('/api/locacao/locacoes/:id/avarias', 'post', { params: { id: loc2 }, body: { valorCobrado: 10 } });
assert(r.st === 400, 'avaria sem descrição é recusada');

// Devolve 2 dias e meio atrasado, com 60h de uso (franquia 5×8 = 40 → 20h extras a 60)
r = chamar('/api/locacao/locacoes/:id/devolver', 'post', {
  params: { id: loc2 },
  body: {
    dataRetornoReal: '2026-10-08 20:00',
    medidores: [{ itemId: item2.id, valor: 2060 }],
  },
});
assert(r.st === 200, 'devolução com pendências é aceita', JSON.stringify(r.out.error));

const acertos = r.out.acertos;
const porTipo = t => acertos.filter(a => a.tipo === t);

assert(porTipo('atraso').length === 1, 'um acerto de atraso', JSON.stringify(acertos.map(a => a.tipo)));
eq(porTipo('atraso')[0].quantidade, 3, '2 dias e 12h de atraso cobram 3 dias');
eq(porTipo('atraso')[0].valorTotal, 1500, '3 dias × diária 500 × 100%');

assert(porTipo('medidor').length === 1, 'um acerto de medidor');
eq(porTipo('medidor')[0].quantidade, 20, '60h usadas − 40h de franquia = 20h');
eq(porTipo('medidor')[0].valorTotal, 1200, '20h × 60 = 1200');

assert(porTipo('avaria').length === 1, 'a avaria virou acerto');
eq(porTipo('avaria')[0].valorTotal, 850, 'valor da avaria cobrado');

// locação (semana 2500) + acertos (1500 + 1200 + 850 = 3550)
eq(r.out.contrato.valorLocacao, 2500, 'valor de locação intacto');
eq(r.out.contrato.valorExtras, 3550, 'acertos somam em valorExtras');
eq(r.out.contrato.valorTotal, 6050, 'total = locação + extras');

const avariaCobrada = db.prepare('SELECT cobrada FROM locacao_avarias WHERE contratoId = ?').get(loc2);
eq(avariaCobrada.cobrada, 1, 'avaria fica marcada como cobrada');

// ─── Avaria registrada depois da devolução ────────────────────────────────────
secao('Avaria descoberta depois da devolução');
r = chamar('/api/locacao/locacoes/:id/avarias', 'post', {
  params: { id: loc2 },
  body: { descricao: 'Mangueira hidráulica rompida (vista na oficina)', gravidade: 'grave', valorCobrado: 400 },
});
assert(r.st === 200, 'avaria pós-devolução é aceita');
eq(r.out.contrato.valorExtras, 3950, 'avaria pós-devolução entra no acerto na hora');
eq(r.out.acertos.filter(a => a.tipo === 'avaria').length, 2, 'duas avarias cobradas');

// Remover a avaria remove a cobrança
const avarias = db.prepare('SELECT * FROM locacao_avarias WHERE contratoId = ? ORDER BY id').all(loc2);
r = chamar('/api/locacao/locacoes/:id/avarias/:avariaId', 'delete', {
  params: { id: loc2, avariaId: avarias[1].id },
});
assert(r.st === 200, 'avaria removida');
const totaisDepois = db.prepare('SELECT valorExtras FROM locacao_contratos WHERE id = ?').get(loc2);
eq(totaisDepois.valorExtras, 3550, 'remover a avaria remove também o acerto');

// ─── Item não devolvido ───────────────────────────────────────────────────────
secao('Item que não voltou: reposição e agenda ainda ocupada');

const loc3 = novaLocacao('2026-11-01 08:00', '2026-11-05 08:00', [
  { produtoId: prodSimples, quantidade: 1 },
  { produtoId: prodMaquina, quantidade: 1 },
]);
const itens3 = db.prepare('SELECT * FROM locacao_itens WHERE contratoId = ? ORDER BY id').all(loc3);
chamar('/api/locacao/locacoes/:id/entregar', 'post', {
  params: { id: loc3 }, body: { dataSaidaReal: '2026-11-01 08:00' },
});

r = chamar('/api/locacao/locacoes/:id/devolver', 'post', {
  params: { id: loc3 },
  body: { dataRetornoReal: '2026-11-05 08:00', itensDevolvidos: [itens3[1].id] }, // só a máquina voltou
});
assert(r.st === 200, 'devolução parcial é aceita', JSON.stringify(r.out.error));
eq(r.out.resumo.naoDevolvidos.length, 1, 'um item não voltou');

const reposicao = r.out.acertos.filter(a => a.tipo === 'reposicao');
eq(reposicao.length, 1, 'acerto de reposição criado');
eq(reposicao[0].valorTotal, 3000, 'valor de reposição do compressor');

const itensDepois = db.prepare('SELECT * FROM locacao_itens WHERE contratoId = ? ORDER BY id').all(loc3);
eq(itensDepois[0].devolvido, 0, 'item não devolvido fica marcado');
eq(itensDepois[1].devolvido, 1, 'item devolvido fica marcado');

// A agenda do que não voltou continua ocupada.
d = D.disponibilidade(db, prodSimples, '2026-11-02 08:00', '2026-11-03 08:00');
eq(d.ocupadoLocacao, 1, 'item não devolvido continua ocupando a agenda');
d = D.disponibilidade(db, prodMaquina, '2026-11-02 08:00', '2026-11-03 08:00');
eq(d.ocupadoLocacao, 0, 'item devolvido liberou a agenda');

// REGRESSÃO (bug encontrado na validação): a asserção acima consultava uma
// data DENTRO da janela contratada, onde a reserva ocuparia de qualquer jeito.
// O `dataFim` da reserva continuava sendo o fim CONTRATADO, então bastava a
// data prevista passar para a máquina que está na rua — e já foi cobrada como
// reposição — reaparecer livre no calendário. Agora o fim é empurrado para um
// horizonte aberto.
d = D.disponibilidade(db, prodSimples, '2026-11-20 08:00', '2026-11-21 08:00');
eq(d.ocupadoLocacao, 1, 'item não devolvido AINDA ocupa muito depois do fim contratado');
d = D.disponibilidade(db, prodSimples, '2027-06-01 08:00', '2027-06-02 08:00');
eq(d.ocupadoLocacao, 1, 'e continua ocupando no ano seguinte — até que volte');

const reservaNaoDevolvida = db.prepare(`
  SELECT dataFim, status, observacoes FROM locacao_reservas
  WHERE documentoId = ? AND locacaoItemId = ?
`).get(loc3, itens3[0].id);
assert(reservaNaoDevolvida.dataFim > '2090-01-01',
  'a reserva do item não devolvido tem fim em horizonte aberto', reservaNaoDevolvida.dataFim);
assert(/não devolvido/.test(reservaNaoDevolvida.observacoes || ''),
  'e a observação registra o porquê', reservaNaoDevolvida.observacoes);

// O que voltou não foi afetado: continua liberado depois do fim.
d = D.disponibilidade(db, prodMaquina, '2026-11-20 08:00', '2026-11-21 08:00');
eq(d.ocupadoLocacao, 0, 'o item devolvido segue livre');

// ─── Acertos manuais ──────────────────────────────────────────────────────────
secao('Reposição por PERCENTUAL no fluxo real');
// O item não devolvido pode ser cobrado por percentual do valor do bem, e não
// só pelo valor fixo. O produto de teste tem preço de venda, então a base
// existe.
// Produto PRÓPRIO desta seção: o `prodSimples` ficou permanentemente ocupado
// pelo item não devolvido do bloco anterior — que é justamente o
// comportamento correto (a reserva vai até o horizonte aberto). Reaproveitá-lo
// aqui daria um falso negativo.
const prodPct = criarProduto(SKU + '-P', 'Gerador portátil (teste F4 pct)', 2,
  { valorReposicao: 3000 }, [{ faixa: 'dia', valor: 100 }]);
db.prepare('UPDATE produtos SET precoVenda = 4000 WHERE id = ?').run(prodPct);
db.prepare('UPDATE locacao_item_specs SET reposicaoPercentual = 120 WHERE produtoId = ?').run(prodPct);

const locPct = novaLocacao('2027-02-01 08:00', '2027-02-03 08:00',
  [{ produtoId: prodPct, quantidade: 2 }]);
chamar('/api/locacao/locacoes/:id/entregar', 'post', {
  params: { id: locPct }, body: { dataSaidaReal: '2027-02-01 08:00' } });
r = chamar('/api/locacao/locacoes/:id/devolver', 'post', {
  params: { id: locPct }, body: { dataRetornoReal: '2027-02-03 08:00', itensDevolvidos: [] },
});
assert(r.st === 200, 'devolução com item não devolvido é aceita', JSON.stringify(r.out.error));
const repPct = r.out.acertos.filter(a => a.tipo === 'reposicao');
eq(repPct.length, 1, 'um acerto de reposição');
eq(repPct[0].valorUnitario, 4800, '120% de 4000 = 4800 por unidade');
eq(repPct[0].valorTotal, 9600, 'e 2 unidades = 9600 (o fixo de 3000 foi ignorado)');
assert(/120% de 4000/.test(repPct[0].descricao),
  'a descrição do acerto mostra a conta', repPct[0].descricao);

// Produto sem preço nenhum: cai no valor fixo, sem inventar zero.
const prodSemBase = criarProduto(SKU + '-N', 'Item sem preço (teste F4)', 2,
  { valorReposicao: 3000 }, [{ faixa: 'dia', valor: 100 }]);
db.prepare('UPDATE produtos SET precoVenda = 0, precoCusto = 0 WHERE id = ?').run(prodSemBase);
db.prepare('UPDATE locacao_item_specs SET reposicaoPercentual = 120 WHERE produtoId = ?').run(prodSemBase);
const locSemBase = novaLocacao('2027-03-01 08:00', '2027-03-03 08:00',
  [{ produtoId: prodSemBase, quantidade: 1 }]);
chamar('/api/locacao/locacoes/:id/entregar', 'post', {
  params: { id: locSemBase }, body: { dataSaidaReal: '2027-03-01 08:00' } });
r = chamar('/api/locacao/locacoes/:id/devolver', 'post', {
  params: { id: locSemBase }, body: { dataRetornoReal: '2027-03-03 08:00', itensDevolvidos: [] },
});
const repFix = r.out.acertos.filter(a => a.tipo === 'reposicao');
eq(repFix[0].valorTotal, 3000, 'sem base para o percentual, cobra o valor fixo de 3000');
assert(!!r.out.resumo.naoDevolvidos[0].aviso, 'e o resumo carrega o aviso do porquê');


secao('Acertos manuais (desconto entra negativo)');

const extrasAntes = db.prepare('SELECT valorExtras FROM locacao_contratos WHERE id = ?').get(loc3).valorExtras;
r = chamar('/api/locacao/locacoes/:id/acertos', 'post', {
  params: { id: loc3 }, body: { tipo: 'desconto', descricao: 'Cortesia comercial', valorUnitario: 500 },
});
assert(r.st === 200, 'acerto de desconto é aceito');
eq(r.out.totais.valorExtras, extrasAntes - 500, 'desconto SUBTRAI do total');

r = chamar('/api/locacao/locacoes/:id/acertos', 'post', {
  params: { id: loc3 }, body: { tipo: 'limpeza', descricao: 'Lavagem', valorUnitario: 120 },
});
eq(r.out.totais.valorExtras, extrasAntes - 500 + 120, 'limpeza soma');

r = chamar('/api/locacao/locacoes/:id/acertos', 'post', {
  params: { id: loc3 }, body: { tipo: 'gorjeta', descricao: 'x', valorUnitario: 10 },
});
assert(r.st === 400, 'tipo de acerto inválido é recusado');

const acertoLimpeza = db.prepare("SELECT id FROM locacao_acertos WHERE contratoId = ? AND tipo='limpeza'").get(loc3);
r = chamar('/api/locacao/locacoes/:id/acertos/:acertoId', 'delete', {
  params: { id: loc3, acertoId: acertoLimpeza.id },
});
assert(r.st === 200 && r.out.totais.valorExtras === extrasAntes - 500, 'remover acerto recalcula o total');

// ─── Reapuração não empilha ───────────────────────────────────────────────────
secao('Reapuração não empilha multa');
// Força voltar para emAndamento e devolve de novo, mais atrasado ainda.
db.prepare("UPDATE locacao_contratos SET status='emAndamento' WHERE id = ?").run(loc2);
r = chamar('/api/locacao/locacoes/:id/devolver', 'post', {
  params: { id: loc2 }, body: { dataRetornoReal: '2026-10-10 20:00' },
});
assert(r.st === 200, 'reapuração roda');
eq(r.out.acertos.filter(a => a.tipo === 'atraso').length, 1,
  'continua havendo UMA linha de atraso (substituída, não somada)');
eq(r.out.acertos.filter(a => a.tipo === 'atraso')[0].quantidade, 5,
  'a multa foi recalculada para os 5 dias de atraso');

// ─── Entrega sem confirmar ────────────────────────────────────────────────────
secao('Recusas de fluxo');
r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, dataSaidaPrevista: '2026-12-01', dataRetornoPrevisto: '2026-12-02' },
});
const locOrc = r.out.contrato.id;
r = chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: locOrc } });
assert(r.st === 409 && /confirme/.test(r.out.error || ''),
  'entregar orçamento não confirmado é recusado com instrução', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes/:id/devolver', 'post', { params: { id: locOrc } });
assert(r.st === 409, 'devolver o que não saiu é recusado');

r = chamar('/api/locacao/locacoes/:id/vistoria', 'post', { params: { id: locOrc }, body: { momento: 'almoco' } });
assert(r.st === 400, 'momento de vistoria inválido é recusado');

r = chamar('/api/locacao/locacoes/:id/vistoria', 'post', { params: { id: locOrc }, body: { momento: 'entrega' } });
assert(r.st === 200 && r.out.os.id, 'vistoria avulsa abre OS');
r = chamar('/api/locacao/locacoes/:id/vistoria', 'post', { params: { id: locOrc }, body: { momento: 'entrega' } });
assert(r.st === 409, 'abrir duas OS de entrega é recusado');

// ─── Limpeza ──────────────────────────────────────────────────────────────────
limpar();
db.prepare("DELETE FROM os_tipos WHERE slug IN ('locacao-entrega','locacao-devolucao')").run();
for (const [k, v] of Object.entries(cfgOriginal)) {
  if (v) db.prepare('UPDATE config SET valor = ? WHERE chave = ?').run(v.valor, k);
  else db.prepare('DELETE FROM config WHERE chave = ?').run(k);
}

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
