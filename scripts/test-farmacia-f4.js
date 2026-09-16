#!/usr/bin/env node
/**
 * test-farmacia-f4.js — Fase 4: receita, Portaria 344/98 e RDC 20/2011.
 *
 * O que precisa ser verdade no balcão:
 *   - controlado e antimicrobiano não saem sem receita registrada;
 *   - tarja vermelha simples NÃO é bloqueada (a norma pede apresentação, não
 *     retenção — bloquear seria mais rígido que a lei);
 *   - a validade é a do tipo da receita (30 dias para 344, 10 para antimicrobiano);
 *   - receita não é passe livre: vale pela quantidade prescrita, descontando o
 *     que já saiu;
 *   - os campos capturados são os que o SNGPC vai cobrar na fase 5.
 *
 * Roda contra `labfiscal`, cria a própria massa e limpa no fim.
 * Uso: node scripts/test-farmacia-f4.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { registrarRotasFarmacia } = require(BASE + '/farmacia/farmacia-routes');
const { hojeBrasilia, resolverLotesDaVenda } = require(BASE + '/farmacia/fefo');
const {
  TIPOS_RECEITA, tiposAceitosPara, ehValida, camposObrigatorios,
  saldoDaReceita, validarDispensacao, registrarConsumo,
} = require(BASE + '/farmacia/receita');

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

initFarmaciaSchema(db);

const hoje = hojeBrasilia();
const dia = (n) => new Date(Date.parse(hoje + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const PREFIXO = 'TESTE-FARM-F4-';
function limpar() {
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(PREFIXO + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM farmacia_venda_receita WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM farmacia_receita_itens WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM lotes WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM farmacia_medicamento_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
  db.prepare("DELETE FROM farmacia_receitas WHERE criadoPor = 'teste-f4'").run();
}
limpar();

// ─── Massa: um de cada categoria ─────────────────────────────────────────────
function criarMed(sufixo, descricao, spec) {
  const id = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
    VALUES (?, ?, 'UN', 20, '30049099', 1, 1)`).run(PREFIXO + sufixo, descricao).lastInsertRowid;
  db.prepare(`INSERT INTO farmacia_medicamento_specs
    (produtoId, registroAnvisa, pmc, tarja, listaPortaria344, antimicrobiano, substancia)
    VALUES (?, '1234567890123', 25, ?, ?, ?, ?)`).run(
    id, spec.tarja || 'livre', spec.lista344 || null, spec.antimicrobiano ? 1 : 0, spec.substancia || null);
  db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
    VALUES (?, ?, ?, ?, 100, 100, 1)`).run(id, 'L-' + sufixo, dia(-30), dia(300));
  return id;
}

const idB1 = criarMed('B1', 'CLONAZEPAM 2MG', { tarja: 'preta', lista344: 'B1' });
const idA1 = criarMed('A1', 'MORFINA 10MG', { tarja: 'preta', lista344: 'A1' });
const idC1 = criarMed('C1', 'FLUOXETINA 20MG', { tarja: 'vermelha_retencao', lista344: 'C1' });
const idAnti = criarMed('ANTI', 'AMOXICILINA 500MG', { tarja: 'vermelha', antimicrobiano: 1, substancia: 'AMOXICILINA' });
const idVerm = criarMed('VERM', 'LOSARTANA 50MG', { tarja: 'vermelha' });
const idLivre = criarMed('LIVRE', 'DIPIRONA 500MG', { tarja: 'livre' });

// ─── Quem exige receita ──────────────────────────────────────────────────────
secao('Quem exige receita registrada');
const spec = (id) => db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(id);

assert(tiposAceitosPara(spec(idA1))[0] === 'notificacao_a', 'lista A1 exige Notificação de Receita A');
assert(tiposAceitosPara(spec(idB1))[0] === 'notificacao_b', 'lista B1 exige Notificação de Receita B');
assert(tiposAceitosPara(spec(idC1))[0] === 'controle_especial', 'lista C1 exige Receituário de Controle Especial');
assert(tiposAceitosPara(spec(idAnti)).includes('antimicrobiano'), 'antimicrobiano exige receita própria');
assert(tiposAceitosPara(spec(idAnti)).includes('controle_especial'),
  'antimicrobiano também aceita controle especial (é o mesmo papel de 2 vias)');
assert(tiposAceitosPara(spec(idVerm)) === null,
  'tarja vermelha simples NÃO exige receita registrada (a norma pede apresentação, não retenção)');
assert(tiposAceitosPara(spec(idLivre)) === null, 'venda livre não exige receita');
assert(tiposAceitosPara(null) === null, 'produto sem cadastro farmacêutico não exige receita');

// Tarja preta sem lista preenchida ainda exige: a lista é curadoria e pode faltar.
db.prepare("UPDATE farmacia_medicamento_specs SET listaPortaria344 = NULL WHERE produtoId = ?").run(idA1);
assert(tiposAceitosPara(spec(idA1)) !== null,
  'tarja preta sem lista da 344 preenchida continua exigindo receita');
db.prepare("UPDATE farmacia_medicamento_specs SET listaPortaria344 = 'A1' WHERE produtoId = ?").run(idA1);

// ─── Validade por tipo ───────────────────────────────────────────────────────
secao('Validade da receita por tipo');

const base = {
  prescritorNome: 'DRA FULANA', prescritorConselho: 'CRM', prescritorConselhoUf: 'PA',
  prescritorNumero: '12345', pacienteNome: 'PACIENTE TESTE',
  compradorNome: 'COMPRADOR TESTE', compradorDocumento: '00000000000',
};

assert(ehValida({ ...base, tipo: 'controle_especial', dataEmissao: dia(-10) }) === null,
  'controle especial com 10 dias está válida (limite 30)');
assert(/venceu/.test(String(ehValida({ ...base, tipo: 'controle_especial', dataEmissao: dia(-31) }))),
  'controle especial com 31 dias está vencida');
assert(ehValida({ ...base, tipo: 'antimicrobiano', dataEmissao: dia(-9) }) === null,
  'antimicrobiano com 9 dias está válida (limite 10)');
assert(/venceu/.test(String(ehValida({ ...base, tipo: 'antimicrobiano', dataEmissao: dia(-11) }))),
  'antimicrobiano com 11 dias está vencida — validade é mais curta que a da 344');
assert(/futuro/.test(String(ehValida({ ...base, tipo: 'notificacao_a', dataEmissao: dia(1) }))),
  'receita com data futura é recusada');
assert(ehValida({ ...base, tipo: 'comum', dataEmissao: dia(-500) }) === null,
  'receita comum não tem prazo de validade neste controle');

// ─── Campos obrigatórios ─────────────────────────────────────────────────────
secao('Campos que o SNGPC vai cobrar');
assert(camposObrigatorios({ ...base, tipo: 'notificacao_b' }).length === 0, 'receita completa passa');
assert(camposObrigatorios({ ...base, tipo: 'comum' }).length === 0, 'receita comum não exige retenção');
assert(camposObrigatorios({ ...base, tipo: 'notificacao_b', prescritorConselho: 'XYZ' })
  .some(f => /conselho/.test(f)), 'conselho fora de CRM/CRO/CRMV/COREN é recusado');
assert(camposObrigatorios({ ...base, tipo: 'antimicrobiano', prescritorConselho: 'COREN' }).length === 0,
  'COREN é aceito como prescritor (a ANVISA passou a aceitar enfermeiro em antimicrobiano)');
assert(camposObrigatorios({ ...base, tipo: 'notificacao_b', compradorDocumento: '' })
  .some(f => /documento do comprador/.test(f)), 'documento do comprador é obrigatório');
assert(camposObrigatorios({ ...base, tipo: 'notificacao_b', prescritorConselhoUf: 'Pará' })
  .some(f => /UF/.test(f)), 'UF do conselho fora do formato de 2 letras é recusada');

// ─── Dispensação ─────────────────────────────────────────────────────────────
secao('Validação da dispensação');

function criarReceita(campos, itens) {
  const id = db.prepare(`INSERT INTO farmacia_receitas
    (tipo, numero, dataEmissao, uf, prescritorNome, prescritorConselho, prescritorConselhoUf,
     prescritorNumero, pacienteNome, pacienteDocumento, compradorNome, compradorDocumento, criadoPor)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'teste-f4')`).run(
    campos.tipo, campos.numero || 'R1', campos.dataEmissao, campos.uf || 'PA',
    campos.prescritorNome || base.prescritorNome, campos.prescritorConselho || 'CRM',
    campos.prescritorConselhoUf || 'PA', campos.prescritorNumero || '12345',
    campos.pacienteNome || base.pacienteNome, '11122233344',
    campos.compradorNome || base.compradorNome, campos.compradorDocumento || '00000000000'
  ).lastInsertRowid;
  for (const i of itens) {
    db.prepare('INSERT INTO farmacia_receita_itens (receitaId, produtoId, quantidade) VALUES (?,?,?)')
      .run(id, i.produtoId, i.quantidade);
  }
  return id;
}

// Sem receita: controlado barra, livre passa.
let r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 1 }], null);
assert(r.erros.length === 1 && /exige/.test(r.erros[0]),
  'controlado sem receita é bloqueado', JSON.stringify(r.erros));
assert(r.exigidos.length === 1 && r.exigidos[0].produtoId === idB1, 'a validação diz qual item exigiu');

r = validarDispensacao(db, [{ produtoId: idLivre, quantidade: 3 }, { produtoId: idVerm, quantidade: 1 }], null);
assert(r.erros.length === 0, 'venda livre + tarja vermelha simples passa sem receita', JSON.stringify(r.erros));

// Receita certa libera.
const recB = criarReceita({ tipo: 'notificacao_b', dataEmissao: dia(-5) }, [{ produtoId: idB1, quantidade: 2 }]);
r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 2 }], recB);
assert(r.erros.length === 0, 'receita do tipo certo, válida e completa libera a venda', JSON.stringify(r.erros));

// Tipo errado barra.
const recC = criarReceita({ tipo: 'controle_especial', dataEmissao: dia(-5) }, [{ produtoId: idB1, quantidade: 2 }]);
r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 1 }], recC);
assert(r.erros.some(e => /exige/.test(e)), 'receita de tipo errado é recusada', JSON.stringify(r.erros));

// Vencida barra.
const recVencida = criarReceita({ tipo: 'notificacao_b', dataEmissao: dia(-40) }, [{ produtoId: idB1, quantidade: 2 }]);
r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 1 }], recVencida);
assert(r.erros.some(e => /venceu/.test(e)), 'receita vencida é recusada', JSON.stringify(r.erros));

// Item que não está na receita barra.
r = validarDispensacao(db, [{ produtoId: idC1, quantidade: 1 }], recC);
assert(r.erros.some(e => /não consta/.test(e)), 'item fora da receita é recusado', JSON.stringify(r.erros));

// Quantidade acima da prescrita barra.
r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 5 }], recB);
assert(r.erros.some(e => /permite mais/.test(e)),
  'quantidade acima da prescrita é recusada', JSON.stringify(r.erros));

// Receita inexistente.
r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 1 }], 999999);
assert(r.erros.some(e => /não encontrada/.test(e)), 'receita inexistente é recusada');

// Notificação B fora da UF de emissão.
const recUf = criarReceita({ tipo: 'notificacao_b', dataEmissao: dia(-2), uf: 'SP', prescritorConselhoUf: 'PA' },
  [{ produtoId: idB1, quantidade: 1 }]);
r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 1 }], recUf);
assert(r.erros.some(e => /UF de emissão/.test(e)),
  'Notificação B só vale na UF de emissão', JSON.stringify(r.erros));

// Antimicrobiano aceita os dois tipos de papel.
const recAnti = criarReceita({ tipo: 'antimicrobiano', dataEmissao: dia(-3) }, [{ produtoId: idAnti, quantidade: 1 }]);
r = validarDispensacao(db, [{ produtoId: idAnti, quantidade: 1 }], recAnti);
assert(r.erros.length === 0, 'antimicrobiano com receita própria passa', JSON.stringify(r.erros));

const recAntiCE = criarReceita({ tipo: 'controle_especial', dataEmissao: dia(-3) }, [{ produtoId: idAnti, quantidade: 1 }]);
r = validarDispensacao(db, [{ produtoId: idAnti, quantidade: 1 }], recAntiCE);
assert(r.erros.length === 0, 'antimicrobiano com receituário de controle especial também passa');

// ─── Saldo: receita não é passe livre ────────────────────────────────────────
secao('Saldo da receita');

let s = saldoDaReceita(db, recB, idB1);
assert(s.prescrito === 2 && s.usado === 0 && s.saldo === 2, 'saldo inicial é o prescrito');

const itensVenda = [{ produtoId: idB1, quantidade: 1, descricao: 'CLONAZEPAM 2MG' }];
registrarConsumo(db, {
  receitaId: recB, nfceId: 888111, itens: itensVenda,
  lotesDaVenda: resolverLotesDaVenda(db, itensVenda),
});

s = saldoDaReceita(db, recB, idB1);
assert(s.usado === 1 && s.saldo === 1, 'consumo baixa o saldo da receita', JSON.stringify(s));

r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 2 }], recB);
assert(r.erros.some(e => /permite mais 1/.test(e)),
  'segunda dispensação além do saldo é recusada com o número exato', JSON.stringify(r.erros));

r = validarDispensacao(db, [{ produtoId: idB1, quantidade: 1 }], recB);
assert(r.erros.length === 0, 'o que ainda cabe no saldo continua liberado');

const consumo = db.prepare('SELECT * FROM farmacia_venda_receita WHERE receitaId = ?').all(recB);
assert(consumo.length === 1 && consumo[0].loteId, 'o consumo registra o lote dispensado (dado do SNGPC)');
assert(consumo[0].nfceId === 888111, 'o consumo aponta para a nota');

// Produto que não exige receita não consome saldo.
const itensLivre = [{ produtoId: idLivre, quantidade: 1, descricao: 'DIPIRONA' }];
registrarConsumo(db, {
  receitaId: recB, nfceId: 888112, itens: itensLivre,
  lotesDaVenda: resolverLotesDaVenda(db, itensLivre),
});
assert(db.prepare('SELECT COUNT(*) n FROM farmacia_venda_receita WHERE receitaId = ?').get(recB).n === 1,
  'item que não exige receita não gera consumo');

// ─── Reserva: a corrida que existia entre conferir e gravar ──────────────────
secao('Reserva de saldo (corrida da dispensação)');

const { reservarDispensacao, confirmarDispensacao, liberarDispensacao } = require(BASE + '/farmacia/receita');

const recCorrida = criarReceita({ tipo: 'notificacao_b', dataEmissao: dia(-2) },
  [{ produtoId: idB1, quantidade: 10 }]);
const itensCorrida = [{ produtoId: idB1, quantidade: 10, descricao: 'CLONAZEPAM 2MG' }];

// Primeira venda reserva os 10.
const reserva1 = reservarDispensacao(db, {
  receitaId: recCorrida, itens: itensCorrida, lotesDaVenda: resolverLotesDaVenda(db, itensCorrida),
});
assert(reserva1.length > 0, 'a reserva grava linhas de consumo com status reservado');
assert(db.prepare("SELECT COUNT(*) n FROM farmacia_venda_receita WHERE receitaId = ? AND status = 'reservado'")
  .get(recCorrida).n === reserva1.length, 'as linhas nascem como reservado');

// Segunda venda simultânea: ANTES da correção, isto passava — a conferência
// acontecia antes de dois await de rede e a gravação só depois deles.
let erroCorrida = null;
try {
  reservarDispensacao(db, {
    receitaId: recCorrida, itens: itensCorrida, lotesDaVenda: resolverLotesDaVenda(db, itensCorrida),
  });
} catch (e) { erroCorrida = e.message; }
assert(erroCorrida && /permite mais 0/.test(erroCorrida),
  'segunda dispensação simultânea da MESMA receita é barrada pela reserva', String(erroCorrida));

const s2 = saldoDaReceita(db, recCorrida, idB1);
assert(s2.saldo === 0 && s2.usado === 10,
  'reserva conta como usado — é isso que impede a corrida', JSON.stringify(s2));

// Nota rejeitada ou erro de rede: o saldo tem de voltar.
liberarDispensacao(db, reserva1);
const s3 = saldoDaReceita(db, recCorrida, idB1);
assert(s3.saldo === 10 && s3.usado === 0,
  'liberar a reserva devolve o saldo inteiro (nota rejeitada não gasta receita)', JSON.stringify(s3));
assert(db.prepare('SELECT COUNT(*) n FROM farmacia_venda_receita WHERE receitaId = ?').get(recCorrida).n === 0,
  'a liberação apaga as linhas reservadas');

// Nota autorizada: reserva vira consumo com o número da nota.
const reserva2 = reservarDispensacao(db, {
  receitaId: recCorrida, itens: [{ produtoId: idB1, quantidade: 4 }],
  lotesDaVenda: resolverLotesDaVenda(db, [{ produtoId: idB1, quantidade: 4 }]),
});
confirmarDispensacao(db, reserva2, 888999);
const linhas = db.prepare('SELECT * FROM farmacia_venda_receita WHERE receitaId = ?').all(recCorrida);
assert(linhas.length > 0 && linhas.every(l => l.status === 'confirmado' && l.nfceId === 888999),
  'confirmar marca as linhas e amarra à nota', JSON.stringify(linhas.map(l => ({ s: l.status, n: l.nfceId }))));
assert(saldoDaReceita(db, recCorrida, idB1).saldo === 6, 'saldo reflete o consumo confirmado');

// Liberar não pode desfazer o que já foi confirmado.
liberarDispensacao(db, reserva2);
assert(db.prepare('SELECT COUNT(*) n FROM farmacia_venda_receita WHERE receitaId = ?').get(recCorrida).n === linhas.length,
  'liberar NÃO apaga consumo já confirmado — só reserva em aberto');

// Reserva também barra o que já era barrado antes (validação continua valendo).
let erroReserva = null;
try {
  reservarDispensacao(db, { receitaId: null, itens: [{ produtoId: idB1, quantidade: 1 }], lotesDaVenda: [] });
} catch (e) { erroReserva = e.message; }
assert(erroReserva && /exige/.test(erroReserva), 'reserva sem receita para controlado é barrada');

db.prepare('DELETE FROM farmacia_venda_receita WHERE receitaId = ?').run(recCorrida);

// ─── Rotas ───────────────────────────────────────────────────────────────────
secao('Rotas de receita');

const app = express();
app.use(express.json());
registrarRotasFarmacia(app, db);
const flagOriginal = db.prepare("SELECT valor FROM config WHERE chave = 'farmacia_enabled'").get();
db.prepare(`INSERT INTO config (chave, valor) VALUES ('farmacia_enabled','1')
            ON CONFLICT(chave) DO UPDATE SET valor='1'`).run();

function chamar(p, m, o = {}) {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c => { st = c; return res; } };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {}, user: o.user, headers: {} };
  let i = 0; const stack = l.route.stack;
  const next = () => { const h = stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

let x = chamar('/api/farmacia/receitas', 'post', { body: { tipo: 'inexistente', dataEmissao: dia(0) } });
assert(x.st === 400, 'tipo de receita inválido é recusado pela rota');

x = chamar('/api/farmacia/receitas', 'post', { body: { ...base, tipo: 'notificacao_b', dataEmissao: '26/08/2026' } });
assert(x.st === 400, 'data fora de AAAA-MM-DD é recusada');

x = chamar('/api/farmacia/receitas', 'post', {
  body: { ...base, tipo: 'notificacao_b', dataEmissao: dia(-1), prescritorNumero: '' },
});
assert(x.st === 400 && /número do conselho/.test(x.out.error), 'campo obrigatório faltando é recusado com o nome do campo');

x = chamar('/api/farmacia/receitas', 'post', { body: { ...base, tipo: 'notificacao_b', dataEmissao: dia(-40) } });
assert(x.st === 400 && /venceu/.test(x.out.error), 'a rota recusa cadastrar receita já vencida');

x = chamar('/api/farmacia/receitas', 'post', {
  body: {
    ...base, tipo: 'controle_especial', dataEmissao: dia(-2), numero: 'RX-9',
    itens: [{ produtoId: idC1, quantidade: 3, posologia: '1x ao dia' }],
  },
  user: { id: 1, username: 'teste-f4' },
});
assert(x.st === 200 && x.out.id, 'receita válida é criada');
const novaId = x.out.id;

x = chamar('/api/farmacia/receitas/:id', 'get', { params: { id: novaId } });
assert(x.st === 200 && x.out.itens.length === 1 && x.out.itens[0].saldo === 3,
  'detalhe traz os itens com saldo calculado', JSON.stringify(x.out.itens));

x = chamar('/api/farmacia/receitas/:id', 'get', { params: { id: 999999 } });
assert(x.st === 404, 'receita inexistente devolve 404');

x = chamar('/api/farmacia/receitas', 'get', { query: { tipo: 'controle_especial' } });
assert(x.st === 200 && x.out.items.some(i => i.id === novaId), 'listagem filtra por tipo');

x = chamar('/api/farmacia/dispensacao/validar', 'post', {
  body: { itens: [{ produtoId: idC1, quantidade: 1 }], receitaId: novaId },
});
assert(x.st === 200 && x.out.liberado === true, 'simulação de dispensação libera quando está tudo certo');

x = chamar('/api/farmacia/dispensacao/validar', 'post', {
  body: { itens: [{ produtoId: idC1, quantidade: 1 }], receitaId: null },
});
assert(x.out.liberado === false && x.out.exigidos.length === 1,
  'simulação sem receita diz que não libera e qual item exigiu');

// ─── Limpeza ─────────────────────────────────────────────────────────────────
db.prepare('DELETE FROM farmacia_venda_receita WHERE nfceId IN (888111, 888112)').run();
limpar();
if (flagOriginal) db.prepare("UPDATE config SET valor = ? WHERE chave = 'farmacia_enabled'").run(flagOriginal.valor);
else db.prepare("DELETE FROM config WHERE chave = 'farmacia_enabled'").run();

const sobrou = db.prepare('SELECT COUNT(*) n FROM produtos WHERE sku LIKE ?').get(PREFIXO + '%').n;
assert(sobrou === 0, 'massa de teste removida do tenant');

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
