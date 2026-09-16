#!/usr/bin/env node
/**
 * test-locacao-f5.js — Fase 5: financeiro e fiscal.
 *
 * Três coisas precisam ficar provadas:
 *  1. locação e serviço chegam SEPARADOS ao faturamento (SV 31) — se um dia
 *     alguém somar as duas colunas, este teste quebra;
 *  2. a caução tem título próprio, `origemTipo='locacao_caucao'`, e não entra
 *     na receita;
 *  3. a competência não é faturada duas vezes.
 *
 * Uso: node scripts/test-locacao-f5.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

const { initLocacaoSchema } = require(BASE + '/locacao/locacao-schema');
const { protegerConfig } = require('./locacao-teste-util');
const { registrarRotasLocacao } = require(BASE + '/locacao/locacao-routes');
const F = require(BASE + '/locacao/faturamento');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

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
const SKU = 'TESTE-LOC-F5';
const PREFIXO_NUM = 'TSTF5';

function limpar() {
  const contratos = db.prepare('SELECT id, numero FROM locacao_contratos WHERE numero LIKE ?')
    .all(PREFIXO_NUM + '%');
  for (const c of contratos) {
    // Dois padrões: o título de faturamento cita o número em `observacoes`; o
    // de caução, só na `descricao` (as observações dele são o aviso fixo de
    // "não é receita"). Limpar só por observacoes deixava a caução órfã.
    db.prepare('DELETE FROM contas_a_receber WHERE observacoes LIKE ? OR descricao LIKE ?')
      .run(`%${c.numero}%`, `%${c.numero}%`);
    db.prepare('DELETE FROM contratos WHERE numero = ?').run(`LOC-${c.numero}`);
    db.prepare("DELETE FROM locacao_reservas WHERE documentoTipo='locacao' AND documentoId = ?").run(c.id);
    db.prepare('DELETE FROM locacao_faturamentos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_acertos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_avarias WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_itens WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_eventos WHERE contratoId = ?').run(c.id);
    db.prepare('DELETE FROM locacao_contratos WHERE id = ?').run(c.id);
  }
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(SKU + '%').map(r => r.id);
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
  INSERT INTO produtos (sku, descricao, unidade, precoVenda, ativo) VALUES (?, 'Betoneira (teste F5)', 'UN', 0, 1)
`).run(SKU).lastInsertRowid;
const colsMov = db.prepare('PRAGMA table_info(movimentacoes_estoque)').all().map(c => c.name);
const campos = ['produtoId', 'tipo', 'quantidade'].concat(colsMov.includes('data') ? ['data'] : []);
const vals = [prod, 'entrada', 5].concat(colsMov.includes('data') ? ['2026-01-01 00:00:00'] : []);
db.prepare(`INSERT INTO movimentacoes_estoque (${campos.join(',')})
            VALUES (${campos.map(() => '?').join(',')})`).run(...vals);
db.prepare('INSERT INTO locacao_item_specs (produtoId, alugavel, exigeSerie) VALUES (?, 1, 0)').run(prod);
db.prepare("INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel) VALUES (?, 'dia', 100, 1)").run(prod);
db.prepare("INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel) VALUES (?, 'mes', 2000, 1)").run(prod);

const cliente = db.prepare('SELECT id FROM pessoas LIMIT 1').get();

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
for (const k of ['locacao_enabled', 'locacao_prefixo_numero', 'locacao_exigir_vistoria']) {
  cfgOriginal[k] = db.prepare('SELECT valor FROM config WHERE chave = ?').get(k);
}
const { setCfg } = require('./locacao-teste-util');
setCfg(db, 'locacao_enabled', '1');
setCfg(db, 'locacao_prefixo_numero', PREFIXO_NUM);
setCfg(db, 'locacao_exigir_vistoria', '0');

function novaLocacao(saida, retorno, itens, extra = {}) {
  const r = chamar('/api/locacao/locacoes', 'post', {
    body: { clienteId: cliente.id, dataSaidaPrevista: saida, dataRetornoPrevisto: retorno, ...extra },
  });
  const id = r.out.contrato.id;
  for (const it of itens) chamar('/api/locacao/locacoes/:id/itens', 'post', { params: { id }, body: it });
  return id;
}

// ─── Vencimento ───────────────────────────────────────────────────────────────
secao('Cálculo de vencimento');
eq(F.calcularVencimento('2026-09-05', 10), '2026-09-10', 'dia 10 ainda no mês corrente');
eq(F.calcularVencimento('2026-09-20', 10), '2026-10-10', 'dia 10 já passou → mês seguinte');
eq(F.calcularVencimento('2026-09-10', 10), '2026-09-10', 'no próprio dia, vence hoje');
eq(F.calcularVencimento('2026-12-20', 10), '2027-01-10', 'vira o ano corretamente');
eq(F.calcularVencimento('2026-09-05', 99), '2026-09-05', 'dia inválido cai na data base');

// ─── Faturamento: separação SV 31 ─────────────────────────────────────────────
secao('Faturamento separa locação de serviço (SV 31)');

const loc1 = novaLocacao('2026-09-01 08:00', '2026-09-06 08:00', [
  { produtoId: prod, quantidade: 2 },
  { natureza: 'servico', descricao: 'Frete de entrega e retirada', quantidade: 1, valorUnitario: 300 },
]);

let r = chamar('/api/locacao/locacoes/:id/faturar', 'post', { params: { id: loc1 } });
assert(r.st === 409 && /depois da devolução/.test(r.out.error || ''),
  'avulsa não faturada antes de devolver', JSON.stringify(r.out));

chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc1 } });
chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: loc1 }, body: { dataSaidaReal: '2026-09-01 08:00' } });
chamar('/api/locacao/locacoes/:id/devolver', 'post', { params: { id: loc1 }, body: { dataRetornoReal: '2026-09-06 08:00' } });

r = chamar('/api/locacao/locacoes/:id/faturar', 'post', { params: { id: loc1 } });
assert(r.st === 200, 'faturar depois da devolução funciona', JSON.stringify(r.out.error));
const fat = r.out.faturamento;
eq(fat.valorLocacao, 1000, 'locação: 5 diárias × 2 unidades = 1000');
eq(fat.valorServicos, 300, 'serviço: 300, em coluna própria');
eq(fat.valorTotal, 1300, 'total 1300');
assert(/SV 31/.test(fat.destinoFiscal.locacao || ''), 'destino fiscal da locação cita a SV 31', JSON.stringify(fat.destinoFiscal));
assert(/NFS-e/.test(fat.destinoFiscal.servico || ''), 'destino fiscal do serviço é NFS-e');

const cr = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(fat.contaReceberId);
assert(!!cr, 'título a receber criado');
eq(cr.valor, 1300, 'CR com o valor total');
eq(cr.origemTipo, 'locacao', "CR marcado com origemTipo='locacao'");
eq(cr.status, 'aberta', "CR nasce 'aberta' — vocabulário real de contas_a_receber; 'pendente' impedia a baixa");
assert(/locação 1000/.test(cr.descricao) && /serviços 300/.test(cr.descricao),
  'a descrição do título mostra a separação dos dois valores', cr.descricao);

// A separação também fica gravada no registro de faturamento.
const fatRow = db.prepare('SELECT * FROM locacao_faturamentos WHERE id = ?').get(fat.faturamentoId);
eq(fatRow.valorLocacao, 1000, 'faturamento guarda o valor de locação');
eq(fatRow.valorServicos, 300, 'faturamento guarda o valor de serviço');

// ─── Encerramento ─────────────────────────────────────────────────────────────
secao('Encerramento');
r = chamar('/api/locacao/locacoes/:id/encerrar', 'post', { params: { id: loc1 } });
assert(r.st === 200 && r.out.contrato.status === 'encerrado', 'encerra depois de faturado');

// REGRESSÃO (bug encontrado na validação): faturar de novo SEM competência
// duplicava o título. A trava de duplicidade vivia dentro de `if (competencia)`,
// então a locação avulsa não tinha trava nenhuma — e a tela mantinha o botão
// "Faturar" visível, o que fazia de dois cliques dois títulos de valor cheio.
const crAntes = db.prepare("SELECT COUNT(*) n FROM contas_a_receber WHERE origem='locacao'").get().n;
r = chamar('/api/locacao/locacoes/:id/faturar', 'post', { params: { id: loc1 } });
assert(r.st === 409 && /já foi faturada/.test(r.out.error || ''),
  'faturar duas vezes SEM competência é recusado', JSON.stringify(r.out));
eq(db.prepare("SELECT COUNT(*) n FROM contas_a_receber WHERE origem='locacao'").get().n, crAntes,
  'e nenhum título novo foi criado');

r = chamar('/api/locacao/locacoes/:id/faturar', 'post', {
  params: { id: loc1 }, body: { permitirRefaturar: true },
});
assert(r.st === 200, 'refaturar continua possível, mas só com permitirRefaturar explícito');
db.prepare('DELETE FROM locacao_faturamentos WHERE contratoId = ? AND id > ?').run(loc1, fat.faturamentoId);
db.prepare("DELETE FROM contas_a_receber WHERE origem='locacao' AND id NOT IN (SELECT contaReceberId FROM locacao_faturamentos WHERE contaReceberId IS NOT NULL)").run();

// Encerrar sem faturar
const loc2 = novaLocacao('2026-09-10 08:00', '2026-09-12 08:00', [{ produtoId: prod, quantidade: 1 }]);
chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc2 } });
chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: loc2 }, body: { dataSaidaReal: '2026-09-10 08:00' } });
r = chamar('/api/locacao/locacoes/:id/encerrar', 'post', { params: { id: loc2 } });
assert(r.st === 409 && /devolvida/.test(r.out.error || ''), 'não encerra o que não voltou', JSON.stringify(r.out));

chamar('/api/locacao/locacoes/:id/devolver', 'post', { params: { id: loc2 }, body: { dataRetornoReal: '2026-09-12 08:00' } });
r = chamar('/api/locacao/locacoes/:id/encerrar', 'post', { params: { id: loc2 } });
assert(r.st === 409 && /fature/.test(r.out.error || ''), 'não encerra sem faturar', JSON.stringify(r.out));
r = chamar('/api/locacao/locacoes/:id/encerrar', 'post', { params: { id: loc2 }, body: { semFaturar: true } });
assert(r.st === 200, 'semFaturar:true encerra explicitamente');

// ─── Caução ───────────────────────────────────────────────────────────────────
secao('Caução: garantia, não receita');

const loc3 = novaLocacao('2026-10-01 08:00', '2026-10-06 08:00',
  [{ produtoId: prod, quantidade: 1 }], { caucaoValor: 800 });

r = chamar('/api/locacao/locacoes/:id/caucao/destinar', 'post', {
  params: { id: loc3 }, body: { destino: 'devolvido' },
});
assert(r.st === 409 && /não está retida/.test(r.out.error || ''),
  'destinar caução não recebida é recusado', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes/:id/caucao/receber', 'post', { params: { id: loc3 } });
assert(r.st === 200, 'caução recebida', JSON.stringify(r.out.error));
eq(r.out.contrato.caucaoStatus, 'retido', 'status vira retido');

const crCaucao = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(r.out.caucao.contaReceberId);
eq(crCaucao.origemTipo, 'locacao_caucao', "caução tem origemTipo PRÓPRIO ('locacao_caucao')");
assert(crCaucao.origemTipo !== 'locacao', 'caução NÃO se confunde com o título de receita');
// Não basta o origemTipo diferir: o DRE (gerencial-routes.js:308) soma todo
// CR com status aberta/paga/parcial agrupando por plano de contas. Sem plano
// próprio a garantia entra no resultado — e antes isso só não acontecia por
// acidente, porque o status era inválido. A exclusão agora é decisão do
// tenant, e a API AVISA quando ela não foi tomada.
assert(typeof r.out.caucao.aviso === 'string' && /plano de contas/.test(r.out.caucao.aviso),
  'sem plano de contas configurado, a API avisa que a caução cairá no DRE',
  JSON.stringify(r.out.caucao));
eq(crCaucao.planoContaId, null, 'e o título fica sem plano (nada é inventado)');

setCfg(db, 'locacao_caucao_plano_conta_id', '4242');
const locCaucao2 = novaLocacao('2026-11-20 08:00', '2026-11-22 08:00',
  [{ produtoId: prod, quantidade: 1 }], { caucaoValor: 300 });
const rc2 = chamar('/api/locacao/locacoes/:id/caucao/receber', 'post', { params: { id: locCaucao2 } });
eq(rc2.out.caucao.planoContaId, 4242, 'com a config preenchida, a caução vai para a conta patrimonial');
assert(!rc2.out.caucao.aviso, 'e o aviso some');
eq(db.prepare('SELECT planoContaId FROM contas_a_receber WHERE id = ?').get(rc2.out.caucao.contaReceberId).planoContaId,
  4242, 'o título gravado carrega o plano de contas');
db.prepare('DELETE FROM config WHERE chave = ?').run('locacao_caucao_plano_conta_id');
assert(/NÃO é receita/.test(crCaucao.observacoes || ''), 'o título diz que não é receita', crCaucao.observacoes);
eq(crCaucao.valor, 800, 'valor da caução');

r = chamar('/api/locacao/locacoes/:id/caucao/receber', 'post', { params: { id: loc3 } });
assert(r.st === 409, 'receber caução duas vezes é recusado');

// Encerrar com caução pendente é barrado
chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: loc3 } });
chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: loc3 }, body: { dataSaidaReal: '2026-10-01 08:00' } });
chamar('/api/locacao/locacoes/:id/devolver', 'post', { params: { id: loc3 }, body: { dataRetornoReal: '2026-10-06 08:00' } });
chamar('/api/locacao/locacoes/:id/faturar', 'post', { params: { id: loc3 } });

r = chamar('/api/locacao/locacoes/:id/encerrar', 'post', { params: { id: loc3 } });
assert(r.st === 409 && /caução/.test(r.out.error || ''),
  'encerrar com caução retida é barrado', JSON.stringify(r.out));

// Abater a caução gera acerto negativo
const extrasAntes = db.prepare('SELECT valorExtras, valorTotal FROM locacao_contratos WHERE id = ?').get(loc3);
r = chamar('/api/locacao/locacoes/:id/caucao/destinar', 'post', {
  params: { id: loc3 }, body: { destino: 'abatido', valor: 300 },
});
assert(r.st === 200 && r.out.contrato.caucaoStatus === 'abatido', 'caução abatida');
eq(r.out.contrato.valorExtras, extrasAntes.valorExtras - 300, 'abatimento entra como acerto NEGATIVO');

r = chamar('/api/locacao/locacoes/:id/encerrar', 'post', { params: { id: loc3 } });
assert(r.st === 200, 'com a caução destinada, encerra');

// Devolver a caução (outro contrato)
const loc4 = novaLocacao('2026-11-01 08:00', '2026-11-03 08:00',
  [{ produtoId: prod, quantidade: 1 }], { caucaoValor: 500 });
chamar('/api/locacao/locacoes/:id/caucao/receber', 'post', { params: { id: loc4 } });
r = chamar('/api/locacao/locacoes/:id/caucao/destinar', 'post', {
  params: { id: loc4 }, body: { destino: 'devolvido' },
});
assert(r.st === 200 && r.out.contrato.caucaoStatus === 'devolvido', 'caução devolvida');
const acertosLoc4 = db.prepare('SELECT * FROM locacao_acertos WHERE contratoId = ?').all(loc4);
eq(acertosLoc4.length, 0, 'devolver caução NÃO cria acerto (não mexe no valor da locação)');

r = chamar('/api/locacao/locacoes/:id/caucao/destinar', 'post', {
  params: { id: loc4 }, body: { destino: 'sumiu' },
});
assert(r.st === 400, 'destino inválido é recusado');

// Sem caução definida
const loc5 = novaLocacao('2026-11-10 08:00', '2026-11-11 08:00', [{ produtoId: prod, quantidade: 1 }]);
r = chamar('/api/locacao/locacoes/:id/caucao/receber', 'post', { params: { id: loc5 } });
assert(r.st === 400 && /não tem caução/.test(r.out.error || ''), 'receber caução inexistente é recusado');

// ─── Contrato aberto e competência ────────────────────────────────────────────
secao('Contrato aberto: competência e ponte com contratos core');

r = chamar('/api/locacao/locacoes', 'post', {
  body: { clienteId: cliente.id, tipo: 'aberta', dataSaidaPrevista: '2026-09-01 08:00', diaVencimento: 10 },
});
const locAberta = r.out.contrato.id;
chamar('/api/locacao/locacoes/:id/itens', 'post', {
  params: { id: locAberta },
  body: { produtoId: prod, quantidade: 1, dataInicio: '2026-09-01 08:00', dataFim: '2026-10-01 08:00' },
});

r = chamar('/api/locacao/locacoes/:id/faturar', 'post', {
  params: { id: locAberta }, body: { competencia: '2026-09' },
});
assert(r.st === 409 && /a partir da entrega/.test(r.out.error || ''),
  'aberta não fatura antes da entrega', JSON.stringify(r.out));

chamar('/api/locacao/locacoes/:id/confirmar', 'post', { params: { id: locAberta } });
chamar('/api/locacao/locacoes/:id/entregar', 'post', { params: { id: locAberta }, body: { dataSaidaReal: '2026-09-01 08:00' } });

r = chamar('/api/locacao/locacoes/:id/faturar', 'post', {
  params: { id: locAberta }, body: { competencia: '2026-09' },
});
assert(r.st === 200, 'aberta fatura a competência de setembro', JSON.stringify(r.out.error));
eq(r.out.faturamento.valorLocacao, 2000, '30 dias caem na tarifa de mês (2000)');

r = chamar('/api/locacao/locacoes/:id/faturar', 'post', {
  params: { id: locAberta }, body: { competencia: '2026-09' },
});
assert(r.st === 409 && /já foi faturada/.test(r.out.error || ''),
  'a MESMA competência não é faturada duas vezes', JSON.stringify(r.out));

r = chamar('/api/locacao/locacoes/:id/faturar', 'post', {
  params: { id: locAberta }, body: { competencia: '2026-10' },
});
assert(r.st === 200, 'a competência seguinte fatura normalmente');

r = chamar('/api/locacao/locacoes/:id/faturar', 'post', {
  params: { id: locAberta }, body: { competencia: 'setembro' },
});
assert(r.st === 400, 'competência fora do formato YYYY-MM é recusada');

// Ponte com contratos core
r = chamar('/api/locacao/locacoes/:id/contrato-core', 'post', {
  params: { id: locAberta }, body: { indiceReajuste: 'IGPM' },
});
assert(r.st === 200 && r.out.contratoCore.id, 'contrato core criado', JSON.stringify(r.out.error));
eq(r.out.contratoCore.valorMensal, 2000, 'valorMensal do core vem do cálculo da locação');
eq(r.out.contratoCore.indiceReajuste, 'IGPM', 'índice de reajuste gravado');
eq(r.out.contratoCore.renovacaoAutomatica, 1, 'renovação automática ligada por padrão');
eq(r.out.contrato.contratoCoreId, r.out.contratoCore.id, 'locação aponta para o contrato core');

const antes = r.out.contratoCore.id;
r = chamar('/api/locacao/locacoes/:id/contrato-core', 'post', { params: { id: locAberta } });
eq(r.out.contratoCore.id, antes, 'chamar de novo devolve o mesmo contrato (idempotente)');

r = chamar('/api/locacao/locacoes/:id/contrato-core', 'post', { params: { id: loc4 } });
assert(r.st === 400 && /aberta/.test(r.out.error || ''), 'avulsa não gera contrato de recorrência');

// ─── Notificações ─────────────────────────────────────────────────────────────
secao('Notificações por evento×canal');

r = chamar('/api/locacao/notificacoes/config', 'get');
assert(r.st === 200 && r.out.config.length >= 12,
  'config semeada com 4 eventos × 3 canais', String(r.out.config.length));
assert(r.out.config.every(c => c.ativo === 0),
  'tudo nasce DESLIGADO (o tenant escolhe o que quer receber)');

const nAntes = r.out.config.length;
chamar('/api/locacao/notificacoes/config', 'get');
r = chamar('/api/locacao/notificacoes/config', 'get');
eq(r.out.config.length, nAntes, 'semear duas vezes não duplica');

r = chamar('/api/locacao/notificacoes/config', 'put', {
  body: { evento: 'retorno_atrasado', canal: 'email', ativo: 1, template: 'A locação {numero} atrasou.' },
});
assert(r.st === 200, 'liga um evento×canal específico');
const cfgLinha = db.prepare("SELECT * FROM locacao_notificacoes_config WHERE evento='retorno_atrasado' AND canal='email'").get();
eq(cfgLinha.ativo, 1, 'a linha ficou ativa');
const outraLinha = db.prepare("SELECT * FROM locacao_notificacoes_config WHERE evento='retorno_atrasado' AND canal='telegram'").get();
eq(outraLinha.ativo, 0, 'ligar o email NÃO liga o telegram (granularidade por canal)');

r = chamar('/api/locacao/notificacoes/config', 'put', { body: { evento: 'aniversario', canal: 'email' } });
assert(r.st === 400, 'evento inválido é recusado');
r = chamar('/api/locacao/notificacoes/config', 'put', { body: { evento: 'retorno_atrasado', canal: 'pombo' } });
assert(r.st === 400, 'canal inválido é recusado');

// Apuração
r = chamar('/api/locacao/notificacoes/pendentes', 'get', { query: { hoje: '2026-09-15' } });
assert(r.st === 200, 'apuração responde');
assert(Array.isArray(r.out.retorno_atrasado), 'traz a lista de atrasados');
// locAberta está emAndamento desde 01/09 sem retorno previsto → não conta como atraso
assert(!r.out.retorno_atrasado.some(x => x.id === locAberta),
  'locação aberta sem retorno previsto não entra como atrasada');

r = chamar('/api/locacao/notificacoes/pendentes', 'get', { query: { hoje: '2026-10-07' } });
assert(Array.isArray(r.out.caucao_a_devolver), 'traz a lista de caução a devolver');

// ─── Limpeza ──────────────────────────────────────────────────────────────────
db.prepare("DELETE FROM locacao_notificacoes_config WHERE evento IN ('retorno_amanha','retorno_atrasado','contrato_vencendo','caucao_a_devolver')").run();
limpar();
for (const [k, v] of Object.entries(cfgOriginal)) {
  if (v) db.prepare('UPDATE config SET valor = ? WHERE chave = ?').run(v.valor, k);
  else db.prepare('DELETE FROM config WHERE chave = ?').run(k);
}

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
