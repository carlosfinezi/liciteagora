#!/usr/bin/env node
/**
 * test-farmacia-f5.js — Fase 5: SNGPC (escrituração e transmissão).
 *
 * O QUE ESTE TESTE COBRE
 *   - a fila de eventos: quem é escriturável, um evento por lote, e o que
 *     acontece quando a ANVISA rejeita (os eventos voltam para a fila);
 *   - o XML conforme o "Guia de Geração do XML – SNGPC Versão 2" da ANVISA:
 *     nomes de elemento, domínios enumerados e agrupamento por receita/nota;
 *   - o envelope de transmissão do "Manual do Desenvolvedor 2.0.1":
 *     XML → zip → base64 → MD5 do base64, e o envelope SOAP.
 *
 * O QUE ESTE TESTE **NÃO** COBRE — E NÃO TEM COMO COBRIR AQUI
 *   1. Validação contra os XSDs oficiais. Eles ficam em
 *      http://sngpc.anvisa.gov.br/schema/ e o host recusa download
 *      automatizado (Cloudflare). O XML segue o guia oficial, mas não passou
 *      pelo schema.
 *   2. A chamada de rede à ANVISA. Depende do e-mail e senha do RT
 *      Transmissor credenciado, que não existe para o tenant de laboratório.
 *
 * Roda contra `labfiscal`, cria a própria massa e limpa no fim.
 * Uso: node scripts/test-farmacia-f5.js
 */
const BASE = require('path').join(__dirname, '..');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');
const AdmZip = require(BASE + '/node_modules/adm-zip');
const crypto = require('crypto');
const { XMLParser, XMLValidator } = require(BASE + '/node_modules/fast-xml-parser');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { hojeBrasilia, resolverLotesDaVenda } = require(BASE + '/farmacia/fefo');
const eventos = require(BASE + '/farmacia/sngpc-eventos');
const { montarInventario, montarMovimentacao, unidadeMedida, TIPO_RECEITUARIO } = require(BASE + '/farmacia/sngpc-xml');
const api = require(BASE + '/farmacia/sngpc-api');

const db = new Database(copiaDoTenant('labfiscal'));

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

initFarmaciaSchema(db);

const hoje = hojeBrasilia();
const dia = (n) => new Date(Date.parse(hoje + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

const PREFIXO = 'TESTE-FARM-F5-';
const NFCE_ID = 777555;
function limpar() {
  const ids = db.prepare('SELECT id FROM produtos WHERE sku LIKE ?').all(PREFIXO + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM farmacia_sngpc_eventos WHERE produtoId = ?').run(id);
    // A partir da fase 5 este teste chama a rota real de movimentação de
    // estoque, que grava em movimentacoes_estoque — sem apagar aqui, a FK
    // impede remover o produto e a próxima execução estoura.
    db.prepare('DELETE FROM movimentacoes_estoque WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM farmacia_venda_receita WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM farmacia_receita_itens WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM lotes WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM farmacia_medicamento_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
  db.prepare("DELETE FROM farmacia_receitas WHERE criadoPor = 'teste-f5'").run();
  db.prepare("DELETE FROM farmacia_sngpc_transmissoes WHERE periodoInicio LIKE '9%' OR tipo LIKE 'teste%'").run();
}
limpar();

// ─── Massa ───────────────────────────────────────────────────────────────────
function criarMed(sufixo, descricao, spec, unidade = 'UN') {
  const id = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo, rastreiaLote)
    VALUES (?, ?, ?, 20, '30049099', 1, 1)`).run(PREFIXO + sufixo, descricao, unidade).lastInsertRowid;
  db.prepare(`INSERT INTO farmacia_medicamento_specs
    (produtoId, registroAnvisa, pmc, tarja, listaPortaria344, antimicrobiano)
    VALUES (?, ?, 25, ?, ?, ?)`).run(id, spec.registro || '1234567890123',
    spec.tarja || 'livre', spec.lista344 || null, spec.antimicrobiano ? 1 : 0);
  return id;
}
function criarLote(produtoId, numero, saldo) {
  return db.prepare(`INSERT INTO lotes (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(produtoId, numero, dia(-60), dia(300), saldo, saldo).lastInsertRowid;
}

const idB1 = criarMed('B1', 'CLONAZEPAM 2MG', { tarja: 'preta', lista344: 'B1', registro: '1111111111111' });
const idAnti = criarMed('ANTI', 'AMOXICILINA 500MG', { tarja: 'vermelha', antimicrobiano: 1, registro: '2222222222222' });
const idLivre = criarMed('LIVRE', 'DIPIRONA 500MG', { tarja: 'livre', registro: '3333333333333' });
const idFrasco = criarMed('FR', 'XAROPE CONTROLADO', { tarja: 'preta', lista344: 'C1', registro: '4444444444444' }, 'FR');

criarLote(idB1, 'LB1-A', 3);
criarLote(idB1, 'LB1-B', 10);
criarLote(idAnti, 'LANTI', 20);
criarLote(idLivre, 'LLIVRE', 50);
criarLote(idFrasco, 'LFR', 8);

// ─── Fila de eventos ─────────────────────────────────────────────────────────
secao('Fila de eventos escrituráveis');

assert(eventos.ehEscriturável(db, idB1) === true, 'controlado da lista B1 é escriturável');
assert(eventos.ehEscriturável(db, idAnti) === true, 'antimicrobiano é escriturável');
assert(eventos.ehEscriturável(db, idLivre) === false, 'medicamento de venda livre NÃO é escriturável');
assert(eventos.ehEscriturável(db, null) === false, 'item sem produto não é escriturável');

const receitaId = db.prepare(`INSERT INTO farmacia_receitas
  (tipo, numero, dataEmissao, uf, prescritorNome, prescritorConselho, prescritorConselhoUf,
   prescritorNumero, pacienteNome, compradorNome, compradorDocumento, criadoPor)
  VALUES ('notificacao_b', 'NR-4477', ?, 'PA', 'DRA FULANA DE TAL', 'CRM', 'PA', '54321',
          'PACIENTE TESTE', 'COMPRADOR TESTE', '12345678900', 'teste-f5')`).run(dia(-3)).lastInsertRowid;

// Venda que atravessa dois lotes + um item não escriturável junto.
const itensVenda = [
  { produtoId: idB1, quantidade: 5, descricao: 'CLONAZEPAM 2MG' },
  { produtoId: idLivre, quantidade: 2, descricao: 'DIPIRONA 500MG' },
];
const lotesDaVenda = resolverLotesDaVenda(db, itensVenda);
const n = eventos.registrarVenda(db, {
  nfceId: NFCE_ID, numero: 4321, dataEmissao: dia(-1), itens: itensVenda, lotesDaVenda, receitaId,
});
assert(n === 2, 'venda de 5 unidades em 2 lotes gera 2 eventos (um por lote)', `n=${n}`);

const fila = eventos.pendentes(db, { dataInicio: dia(-30), dataFim: hoje })
  .filter(e => e.origemId === NFCE_ID);
assert(fila.length === 2, 'a fila devolve os 2 eventos');
assert(fila.every(e => e.produtoId === idB1), 'o item de venda livre não entrou na fila');
assert(fila.every(e => e.receitaId === receitaId), 'os eventos carregam a receita');
assert(fila.every(e => e.loteNumero), 'os eventos trazem o número do lote (join com lotes)');
assert(fila.reduce((s, e) => s + e.quantidade, 0) === 5, 'a soma dos eventos bate com a quantidade vendida');
assert(fila.every(e => e.registroAnvisa === '1111111111111'), 'os eventos trazem o registro ANVISA');

// Entrada e perda
eventos.registrarEntrada(db, {
  data: dia(-2), produtoId: idB1, loteId: db.prepare('SELECT id FROM lotes WHERE numero = ?').get('LB1-B').id,
  quantidade: 10, notaNumero: '9001', cnpjOrigem: '11222333000181', origem: 'teste',
});
const entradaLivre = eventos.registrarEntrada(db, {
  data: dia(-2), produtoId: idLivre, loteId: null, quantidade: 5, notaNumero: '9002', origem: 'teste',
});
assert(entradaLivre === 0, 'entrada de medicamento não controlado não é escriturada');

eventos.registrarPerda(db, {
  data: dia(-1), produtoId: idFrasco, loteId: db.prepare('SELECT id FROM lotes WHERE numero = ?').get('LFR').id,
  quantidade: 2, motivo: 3, origem: 'teste',
});

const filaToda = eventos.pendentes(db, { dataInicio: dia(-30), dataFim: hoje })
  .filter(e => String(e.origem) === 'teste' || e.origemId === NFCE_ID);
assert(filaToda.filter(e => e.tipoMovimento === 'entrada').length === 1, 'entrada de controlado entrou na fila');
assert(filaToda.filter(e => e.tipoMovimento === 'perda').length === 1, 'perda entrou na fila');

// ─── Entrada e perda vêm do SISTEMA, não só de chamada direta ────────────────
// Um agente validador achou que registrarEntrada/registrarPerda existiam mas
// nenhum caminho de código as chamava: a movimentação mensal sairia só com
// vendas, sem entradas nem baixas, e o saldo declarado nunca fecharia.
// Este bloco exercita a ROTA de movimentação de estoque, que é por onde a
// farmácia dá entrada em compra e baixa lote vencido.
secao('Entrada e perda entram na fila pela rota de estoque');

const express5 = require(BASE + '/node_modules/express');
const { registrarRotasEstoque } = require(BASE + '/estoque-routes');
const appEst = express5();
appEst.use(express5.json());
registrarRotasEstoque(appEst, db);

const flagOrig5 = db.prepare("SELECT valor FROM config WHERE chave = 'farmacia_enabled'").get();
function setFlag5(v) {
  db.prepare(`INSERT INTO config (chave, valor) VALUES ('farmacia_enabled', ?)
              ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`).run(String(v));
}
setFlag5(1);

function chamarEst(p, m, o = {}) {
  const l = ((appEst.router || appEst._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c => { st = c; return res; } };
  const req = { params: o.params || {}, query: o.query || {}, body: o.body || {},
                user: o.user || { id: 1, username: 'teste-f5' }, headers: {}, ip: '127.0.0.1' };
  let i = 0; const stack = l.route.stack;
  const next = () => { const h = stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

const loteEntradaId = db.prepare('SELECT id FROM lotes WHERE numero = ?').get('LB1-A').id;
const antesEntrada = eventos.pendentes(db).filter(e => e.tipoMovimento === 'entrada').length;
let re = chamarEst('/api/estoque/movimentacoes', 'post', {
  body: { produtoId: idB1, tipo: 'entrada', quantidade: 7, loteId: loteEntradaId,
          origem: 'compra', observacao: 'teste f5 entrada', data: dia(-2) },
});
assert(re.st === 200, 'a rota de movimentação aceitou a entrada', JSON.stringify(re.out));
const depoisEntrada = eventos.pendentes(db).filter(e => e.tipoMovimento === 'entrada');
assert(depoisEntrada.length === antesEntrada + 1,
  'ENTRADA de controlado pela rota de estoque entra na fila do SNGPC (era a lacuna apontada)',
  `${antesEntrada} → ${depoisEntrada.length}`);

// A baixa sai do MESMO lote que acabou de entrar: a rota confere saldo por
// depósito, e lote inserido direto no banco não tem movimentação de entrada.
const antesPerda = eventos.pendentes(db).filter(e => e.tipoMovimento === 'perda').length;
re = chamarEst('/api/estoque/movimentacoes', 'post', {
  body: { produtoId: idB1, tipo: 'saida', quantidade: 1, loteId: loteEntradaId,
          origem: 'baixa_vencimento', observacao: 'teste f5 perda', data: dia(-1),
          motivoPerdaSngpc: 3 },
});
assert(re.st === 200, 'a rota de movimentação aceitou a baixa', JSON.stringify(re.out));
const depoisPerda = eventos.pendentes(db).filter(e => e.tipoMovimento === 'perda');
assert(depoisPerda.length === antesPerda + 1,
  'BAIXA de controlado pela rota de estoque entra na fila como perda',
  `${antesPerda} → ${depoisPerda.length}`);
assert(depoisPerda.at(-1).documentoTipo === '3', 'a perda carrega o motivo do domínio da ANVISA');

// Produto não escriturável não polui a fila.
const antesLivre = eventos.pendentes(db).length;
chamarEst('/api/estoque/movimentacoes', 'post', {
  body: { produtoId: idLivre, tipo: 'entrada', quantidade: 5,
          loteId: db.prepare('SELECT id FROM lotes WHERE numero = ?').get('LLIVRE').id,
          origem: 'compra', data: dia(-2) },
});
assert(eventos.pendentes(db).length === antesLivre,
  'movimentação de medicamento NÃO controlado não entra na fila do SNGPC');

// Com o módulo desligado, a rota de estoque não escritura nada.
setFlag5(0);
const antesOff = eventos.pendentes(db).length;
chamarEst('/api/estoque/movimentacoes', 'post', {
  body: { produtoId: idB1, tipo: 'entrada', quantidade: 1, loteId: loteEntradaId,
          origem: 'compra', data: dia(-2) },
});
assert(eventos.pendentes(db).length === antesOff,
  'com o módulo desligado a rota de estoque se comporta como antes (nada de SNGPC)');
setFlag5(1);

if (flagOrig5) setFlag5(flagOrig5.valor);

// ─── XML de movimentação ─────────────────────────────────────────────────────
secao('XML de movimentação (Guia SNGPC v2)');

const receitasPorId = new Map([[receitaId, db.prepare('SELECT * FROM farmacia_receitas WHERE id = ?').get(receitaId)]]);
const xmlMov = montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153',
  dataInicio: dia(-30), dataFim: hoje, eventos: filaToda, receitasPorId,
});

assert(XMLValidator.validate(xmlMov) === true, 'XML de movimentação é XML válido',
  JSON.stringify(XMLValidator.validate(xmlMov)));
assert(/<mensagemSNGPC xmlns="urn:sngpc-schema">/.test(xmlMov), 'raiz e namespace conforme o guia');
assert(/encoding="iso-8859-1"/.test(xmlMov), 'encoding iso-8859-1, como no exemplo oficial');

const p = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
const doc = p.parse(xmlMov);
const raiz = doc.mensagemSNGPC;
assert(raiz.cabecalho.cnpjEmissor === '05059874000138', 'cabeçalho traz o CNPJ do emissor');
assert(raiz.cabecalho.cpfTransmissor === '72586648153', 'cabeçalho traz o CPF do RT transmissor');
assert(raiz.cabecalho.dataInicio === dia(-30) && raiz.cabecalho.dataFim === hoje, 'cabeçalho traz o período');

const med = raiz.corpo.medicamentos;
assert(!!med.entradaMedicamentos, 'bloco de entrada presente');
assert(med.entradaMedicamentos.notaFiscalEntradaMedicamento.numeroNotaFiscal === '9001',
  'entrada referencia a nota fiscal');
assert(med.entradaMedicamentos.notaFiscalEntradaMedicamento.tipoOperacaoNotaFiscal === '1',
  'tipoOperacaoNotaFiscal = 1 (compra), domínio st_TipoOperacaoNotaFiscal');

const venda = med.saidaMedicamentoVendaAoConsumidor;
assert(!!venda, 'bloco de venda ao consumidor presente');
assert(venda.tipoReceituarioMedicamento === String(TIPO_RECEITUARIO.notificacao_b),
  'Notificação B vira tipoReceituario 2 (domínio st_TipoReceituario)', venda.tipoReceituarioMedicamento);
assert(venda.numeroNotificacaoMedicamento === 'NR-4477', 'número da notificação vem da receita');
assert(venda.dataPrescricaoMedicamento === dia(-3), 'data da prescrição vem da receita');
assert(venda.prescritorMedicamento.conselhoProfissional === 'CRM'
  && venda.prescritorMedicamento.UFConselho === 'PA'
  && venda.prescritorMedicamento.numeroRegistroProfissional === '54321',
  'prescritor completo (conselho, UF e número)');
assert(venda.compradorMedicamento.nomeComprador === 'COMPRADOR TESTE'
  && venda.compradorMedicamento.numeroDocumento === '12345678900', 'comprador completo');
assert(venda.pacienteMedicamento.nome === 'PACIENTE TESTE', 'paciente informado');
assert(Array.isArray(venda.medicamentoVenda) && venda.medicamentoVenda.length === 2,
  'os 2 lotes viram 2 <medicamentoVenda> na mesma dispensação');
assert(venda.medicamentoVenda.every(m => m.registroMSMedicamento === '1111111111111'),
  'cada medicamentoVenda traz o registro MS');
assert(venda.medicamentoVenda.map(m => Number(m.quantidadeMedicamento)).reduce((a, b) => a + b, 0) === 5,
  'quantidade total dispensada bate');
assert(venda.usoMedicamento === '1', 'usoMedicamento = 1 (humano)');

const perda = med.saidaMedicamentoPerda;
assert(!!perda && perda.motivoPerdaMedicamento === '3', 'perda com motivo 3 (vencimento)');
assert(perda.medicamentoPerda.unidadeMedidaMedicamento === '2',
  'produto em frasco vira unidadeMedida 2 (domínio só tem caixas e frascos)',
  perda.medicamentoPerda.unidadeMedidaMedicamento);

// classeTerapeutica: 1 antimicrobiano, 2 controle especial.
const itensAnti = [{ produtoId: idAnti, quantidade: 1, descricao: 'AMOXICILINA' }];
eventos.registrarVenda(db, {
  nfceId: NFCE_ID + 1, numero: 4322, dataEmissao: dia(-1),
  itens: itensAnti, lotesDaVenda: resolverLotesDaVenda(db, itensAnti), receitaId,
});
const filaAnti = eventos.pendentes(db).filter(e => e.origemId === NFCE_ID + 1);
const xmlAnti = montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153',
  dataInicio: dia(-30), dataFim: hoje,
  eventos: [...filaAnti, ...filaToda.filter(e => e.tipoMovimento === 'entrada')],
  receitasPorId,
});
const docAnti = p.parse(xmlAnti);
assert(docAnti.mensagemSNGPC.corpo.medicamentos.entradaMedicamentos.medicamentoEntrada.classeTerapeutica === '2',
  'controlado da 344 tem classeTerapeutica 2 (sujeito a controle especial)');

// ─── Faltas que precisam falhar alto ─────────────────────────────────────────
secao('O que não pode passar batido');

function esperarErro(fn, regex, msg) {
  let e = null;
  try { fn(); } catch (err) { e = err.message; }
  assert(e && regex.test(e), msg, String(e));
}

esperarErro(() => montarMovimentacao({
  cnpjEmissor: '123', cpfTransmissor: '72586648153', dataInicio: dia(-1), dataFim: hoje,
  eventos: filaToda, receitasPorId,
}), /CNPJ do emissor/, 'CNPJ do emissor inválido é recusado');

esperarErro(() => montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '123', dataInicio: dia(-1), dataFim: hoje,
  eventos: filaToda, receitasPorId,
}), /CPF do transmissor/, 'CPF do RT transmissor inválido é recusado');

esperarErro(() => montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', dataInicio: hoje, dataFim: dia(-5),
  eventos: filaToda, receitasPorId,
}), /período invertido/, 'período invertido é recusado');

esperarErro(() => montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', dataInicio: dia(-1), dataFim: hoje,
  eventos: [], receitasPorId,
}), /sem movimentação/, 'período sem movimentação é recusado');

// Venda de controlado sem receita vinculada não pode virar XML silencioso.
esperarErro(() => montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', dataInicio: dia(-30), dataFim: hoje,
  eventos: fila.map(e => ({ ...e, receitaId: null })), receitasPorId: new Map(),
}), /sem receita vinculada/, 'venda de controlado sem receita falha alto');

// Registro ANVISA ausente.
esperarErro(() => montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', dataInicio: dia(-30), dataFim: hoje,
  eventos: fila.map(e => ({ ...e, registroAnvisa: null })), receitasPorId,
}), /sem registro ANVISA/, 'evento sem registro ANVISA falha alto');

// Lote ausente.
esperarErro(() => montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', dataInicio: dia(-30), dataFim: hoje,
  eventos: fila.map(e => ({ ...e, loteNumero: null })), receitasPorId,
}), /sem lote/, 'evento sem lote falha alto');

// Conselho fora do domínio da ANVISA.
esperarErro(() => montarMovimentacao({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', dataInicio: dia(-30), dataFim: hoje,
  eventos: fila,
  receitasPorId: new Map([[receitaId, { ...receitasPorId.get(receitaId), prescritorConselho: 'XYZ' }]]),
}), /conselho do prescritor/, 'conselho fora do domínio st_ConselhoProfissional falha alto');

// ─── Inventário ──────────────────────────────────────────────────────────────
secao('XML de inventário');

const itensInv = db.prepare(`
  SELECT l.numero AS loteNumero, l.saldoAtual AS quantidade, p.descricao, p.unidade,
         s.registroAnvisa, s.antimicrobiano
  FROM lotes l JOIN produtos p ON p.id = l.produtoId
  JOIN farmacia_medicamento_specs s ON s.produtoId = l.produtoId
  WHERE l.ativo = 1 AND l.saldoAtual > 0 AND p.sku LIKE ?
    AND (s.listaPortaria344 IS NOT NULL OR s.antimicrobiano = 1)`).all(PREFIXO + '%');

const xmlInv = montarInventario({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', data: hoje, itens: itensInv,
});
assert(XMLValidator.validate(xmlInv) === true, 'XML de inventário é XML válido');
const docInv = p.parse(xmlInv);
assert(!!docInv.mensagemSNGPCInventario, 'raiz mensagemSNGPCInventario');
assert(docInv.mensagemSNGPCInventario.cabecalho.data === hoje, 'inventário tem data única (não período)');
const entradas = docInv.mensagemSNGPCInventario.corpo.medicamentos.entradaMedicamentos;
assert(Array.isArray(entradas) && entradas.length === itensInv.length,
  'um <entradaMedicamentos> por lote com saldo', `${entradas.length} vs ${itensInv.length}`);
assert(entradas.every(e => e.medicamentoEntrada.registroMSMedicamento && e.medicamentoEntrada.numeroLoteMedicamento),
  'todo item do inventário tem registro e lote');
assert(!itensInv.some(i => i.descricao === 'DIPIRONA 500MG'),
  'medicamento de venda livre fica fora do inventário do SNGPC');

esperarErro(() => montarInventario({
  cnpjEmissor: '05059874000138', cpfTransmissor: '72586648153', data: hoje, itens: [],
}), /sem itens/, 'inventário vazio é recusado');

assert(unidadeMedida('FR') === 2 && unidadeMedida('UN') === 1 && unidadeMedida('CX') === 1,
  'mapeamento de unidade: frasco → 2, resto → 1');

// ─── Envelope de transmissão ─────────────────────────────────────────────────
secao('Envelope de transmissão (Manual do Desenvolvedor 2.0.1)');

const b64 = api.compactarEBase64(xmlMov, 'sngpc.xml');
assert(typeof b64 === 'string' && /^[A-Za-z0-9+/=]+$/.test(b64), 'saída é base64 puro');

// O zip precisa realmente conter o XML de volta.
const zip = new AdmZip(Buffer.from(b64, 'base64'));
const entradasZip = zip.getEntries();
assert(entradasZip.length === 1 && entradasZip[0].entryName === 'sngpc.xml',
  'o zip contém um arquivo, com o nome informado', JSON.stringify(entradasZip.map(e => e.entryName)));
const xmlVolta = zip.readFile('sngpc.xml').toString('latin1');
assert(xmlVolta === xmlMov, 'o XML volta idêntico do zip (round-trip em iso-8859-1)');

const md5 = api.hashIdentificacao(b64);
assert(/^[0-9a-f]{32}$/.test(md5), 'MD5 tem os 32 caracteres que o manual exige', md5);
assert(md5 === crypto.createHash('md5').update(b64, 'utf8').digest('hex'),
  'MD5 é calculado sobre o base64, não sobre o XML — é o que o manual manda');

const env = api.envelopeSoap('EnviaArquivoSNGPC', {
  Email: 'rt@farmacia.com.br', Senha: 's&nha<1>', Arq: b64, Hashindenficacacao: md5,
});
assert(XMLValidator.validate(env) === true, 'envelope SOAP é XML válido');
assert(/<EnviaArquivoSNGPC xmlns="http:\/\/tempuri.org\/">/.test(env), 'método e namespace do manual');
assert(/<Hashindenficacacao>/.test(env),
  'o parâmetro mantém a grafia do manual da ANVISA (com o erro de digitação dele)');
assert(/s&amp;nha&lt;1&gt;/.test(env), 'senha com caracteres especiais é escapada');

assert(api.ENDPOINTS.homologacao === 'http://homologacao.anvisa.gov.br/sngpc/webservice/sngpc.asmx',
  'endpoint de homologação conforme o manual');
assert(api.ENDPOINTS.producao === 'http://sngpc.anvisa.gov.br/webservice/sngpc.asmx',
  'endpoint de produção conforme o manual');

const respostaOk = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
  + '<soap:Body><EnviaArquivoSNGPCResponse xmlns="http://tempuri.org/">'
  + '<EnviaArquivoSNGPCResult>Arquivo recebido com sucesso, em 26/08/2026, ás 10:00:00. '
  + `O Hash calculado foi '${md5}'</EnviaArquivoSNGPCResult>`
  + '</EnviaArquivoSNGPCResponse></soap:Body></soap:Envelope>';
assert(/recebido com sucesso/.test(api.extrairResultado(respostaOk, 'EnviaArquivoSNGPC')),
  'a resposta de sucesso da ANVISA é extraída do envelope');
assert(api.extrairResultado('<html>erro</html>', 'EnviaArquivoSNGPC') === null,
  'resposta fora do formato devolve null em vez de fingir sucesso');

// ─── Rejeição devolve os eventos à fila ──────────────────────────────────────
secao('Rejeição da ANVISA devolve os eventos à fila');

const tId = db.prepare(`INSERT INTO farmacia_sngpc_transmissoes
  (tipo, periodoInicio, periodoFim, ambiente, xml, md5, status)
  VALUES ('movimentacao', ?, ?, 'homologacao', ?, ?, 'gerado')`)
  .run(dia(-30), hoje, xmlMov, md5).lastInsertRowid;

const idsFila = filaToda.map(e => e.id);
eventos.marcarTransmitidos(db, idsFila, tId);
let aindaPendentes = eventos.pendentes(db).filter(e => idsFila.includes(e.id));
assert(aindaPendentes.length === 0, 'eventos transmitidos saem da fila');

eventos.devolverAFila(db, tId);
aindaPendentes = eventos.pendentes(db).filter(e => idsFila.includes(e.id));
assert(aindaPendentes.length === idsFila.length,
  'rejeição devolve TODOS os eventos à fila (senão o estoque declarado deixa de fechar)',
  `${aindaPendentes.length} de ${idsFila.length}`);

// ─── Limpeza ─────────────────────────────────────────────────────────────────
db.prepare('DELETE FROM farmacia_sngpc_transmissoes WHERE id = ?').run(tId);
db.prepare('DELETE FROM farmacia_sngpc_eventos WHERE origemId IN (?, ?) OR origem = ?')
  .run(NFCE_ID, NFCE_ID + 1, 'teste');
limpar();
const sobrou = db.prepare('SELECT COUNT(*) n FROM produtos WHERE sku LIKE ?').get(PREFIXO + '%').n;
assert(sobrou === 0, 'massa de teste removida do tenant');

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
console.log('\n⚠ Não coberto aqui (e não encoberto): validação contra os XSDs oficiais');
console.log('  (host da ANVISA recusa download automatizado) e a chamada real ao');
console.log('  webservice (exige credencial do RT Transmissor credenciado).');
process.exit(fail === 0 ? 0 : 1);
