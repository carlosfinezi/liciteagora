#!/usr/bin/env node
/**
 * test-farmacia-f1.js — Fase 1: cadastro farmacêutico + importador CMED.
 *
 * O importador é testado contra uma planilha montada a partir do ARQUIVO REAL
 * da CMED (mesmo cabeçalho, mesmas linhas, mesmo preâmbulo), não contra massa
 * inventada: o valor do teste está em provar que o parser aguenta o formato de
 * verdade — preâmbulo variável, preço em vírgula decimal e a armadilha das
 * colunas "PMC 19 %  ALC" ao lado das normais.
 *
 * Pré-requisito: baixar a lista uma vez —
 *   curl -sL -o /tmp/cmed-pmc.xlsx "https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos/arquivos/xls_conformidade_site_20260811_192510234.xlsx/@@download/file"
 *
 * Roda contra `labfiscal`, cria a própria massa e limpa no fim.
 * Uso: node scripts/test-farmacia-f1.js
 */
const fs = require('fs');
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');
const XLSX = require(BASE + '/node_modules/xlsx');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { registrarRotasFarmacia } = require(BASE + '/farmacia/farmacia-routes');
const {
  importarCmed, lerPlanilhaCmed, detectarCabecalho, mapearColunas,
  parseNumeroBr, normalizarTarja, normalizarLista, normalizarRegime, ehAntimicrobiano,
  tarjaMaisRestritiva, normalizarTexto,
} = require(BASE + '/farmacia/cmed-import');

const ARQUIVO_REAL = '/tmp/cmed-pmc.xlsx';
const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

initFarmaciaSchema(db);

// ─── Normalizadores (domínios REAIS conferidos na lista de 11/08/2026) ────────
secao('Normalização');
assert(parseNumeroBr('50,90') === 50.9, 'preço brasileiro "50,90" vira 50.9');
assert(parseNumeroBr('1.234,56') === 1234.56, 'milhar com ponto: "1.234,56" vira 1234.56');
assert(parseNumeroBr('') === null, 'preço vazio vira null (medicamento sem PMC naquela alíquota)');
assert(normalizarTarja('Tarja Vermelha') === 'vermelha', 'Tarja Vermelha');
assert(normalizarTarja('Tarja Vermelha sob restrição') === 'vermelha_retencao', 'Tarja Vermelha sob restrição → retenção');
assert(normalizarTarja('Tarja Preta') === 'preta', 'Tarja Preta');
// "- (*)" é "sem informação", NÃO "venda livre". Tratar como livre deixaria
// controlado passar sem receita — 58 linhas da lista de 11/08/2026 são de
// substâncias que a própria CMED marca como Tarja Preta em outras linhas.
assert(normalizarTarja('- (*) ') === null, '"- (*)" vira null (não informada), não "livre"');
assert(normalizarTarja('') === null, 'tarja vazia vira null');
assert(normalizarTarja('Tarja Sem Tarja') === 'livre', '"Tarja Sem Tarja" → livre (aí a CMED afirmou)');
assert(tarjaMaisRestritiva('livre', 'preta') === 'preta', 'na dúvida vale a tarja mais restritiva');
assert(tarjaMaisRestritiva('vermelha', 'vermelha_retencao') === 'vermelha_retencao', 'retenção é mais restritiva que vermelha');
assert(tarjaMaisRestritiva(null, 'vermelha') === 'vermelha', 'null não vence tarja conhecida');
assert(tarjaMaisRestritiva(null, null) === null, 'duas desconhecidas seguem desconhecidas');
assert(normalizarLista('Negativa') === 'negativa' && normalizarLista('Positiva') === 'positiva'
  && normalizarLista('Neutra') === 'neutra', 'listas de crédito tributário');
assert(normalizarRegime('Regulado') === 'regulado' && normalizarRegime('Liberado') === 'liberado', 'regime de preço');
assert(ehAntimicrobiano('AMOXICILINA;CLAVULANATO DE POTASSIO') === 1, 'amoxicilina marcada como antimicrobiano');
assert(ehAntimicrobiano('DIPIRONA SODICA') === 0, 'dipirona não é antimicrobiano');

if (!fs.existsSync(ARQUIVO_REAL)) {
  console.error(`\nArquivo real ausente: ${ARQUIVO_REAL}`);
  console.error('Baixe a lista da CMED antes de rodar (comando no cabeçalho deste arquivo).');
  process.exit(2);
}

// ─── Planilha de teste montada a partir do arquivo real ──────────────────────
secao('Leitura do formato real da CMED');

const wbReal = XLSX.readFile(ARQUIVO_REAL);
const rowsReal = XLSX.utils.sheet_to_json(wbReal.Sheets[wbReal.SheetNames[0]],
  { header: 1, blankrows: false, defval: '' });
const iHeaderReal = detectarCabecalho(rowsReal);
assert(iHeaderReal > 0, `cabeçalho detectado no arquivo real (linha ${iHeaderReal}), apesar do preâmbulo`);

const H = rowsReal[iHeaderReal];
// A armadilha: existe "PMC 19 %" e "PMC 19 %  ALC". Pegar a errada baixa o teto.
const cols = mapearColunas(H, '19');
const iPmcNormal = H.findIndex(c => String(c).trim() === 'PMC 19 %');
const iPmcAlc = H.findIndex(c => String(c).trim() === 'PMC 19 %  ALC');
assert(iPmcAlc > 0, 'o arquivo real de fato tem a coluna "PMC 19 %  ALC" ao lado');
assert(cols.pmc === iPmcNormal && cols.pmc !== iPmcAlc,
  'mapeamento pega a coluna PMC 19% normal, não a variante ALC', `pmc=${cols.pmc} normal=${iPmcNormal} alc=${iPmcAlc}`);

// Coluna de PMC inexistente tem de falhar com mensagem clara, não em silêncio.
let erroColuna = null;
try { mapearColunas(H, '13'); } catch (e) { erroColuna = e.message; }
assert(erroColuna && /PMC 13 %/.test(erroColuna),
  'coluna de PMC inexistente falha citando a coluna procurada', String(erroColuna));

// Monta um arquivo pequeno com o preâmbulo + cabeçalho + linhas reais escolhidas.
const linhasReais = rowsReal.slice(iHeaderReal + 1).filter(r => String(r[cols.substancia]).trim());
const amostra = [
  linhasReais.find(r => String(r[cols.produto]).trim() === 'BAYCUTEN N'),
  linhasReais.find(r => normalizarTarja(r[cols.tarja]) === 'preta' && parseNumeroBr(r[cols.pmc]) != null),
  linhasReais.find(r => ehAntimicrobiano(r[cols.substancia]) && parseNumeroBr(r[cols.pmc]) != null),
  linhasReais.find(r => parseNumeroBr(r[cols.pmc]) == null),
].filter(Boolean);
assert(amostra.length === 4, 'amostra real cobre livre, tarja preta, antimicrobiano e sem-PMC');

const aoa = [
  ...rowsReal.slice(0, iHeaderReal + 1), // preâmbulo + cabeçalho, como no original
  ...amostra,
];
const ARQUIVO_TESTE = '/tmp/cmed-teste-f1.xlsx';
const wbT = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbT, XLSX.utils.aoa_to_sheet(aoa), 'Planilha1');
XLSX.writeFile(wbT, ARQUIVO_TESTE);

const lido = lerPlanilhaCmed(ARQUIVO_TESTE, { colunaPmc: '19' });
assert(lido.linhas.length === amostra.length,
  `lê as ${amostra.length} linhas de dado e ignora o preâmbulo`, `leu ${lido.linhas.length}`);
const bay = lido.linhas.find(l => l.produto === 'BAYCUTEN N');
assert(bay && bay.pmc === 50.9 && bay.pf === 37.94,
  'BAYCUTEN N: PF 37,94 e PMC 19% 50,90 conforme a lista publicada', JSON.stringify(bay && { pf: bay.pf, pmc: bay.pmc }));
assert(bay && bay.listaCmed === 'negativa' && bay.regimePreco === 'regulado',
  'BAYCUTEN N: lista negativa e regime regulado, conforme a lista publicada');
// A CMED traz "- (*)" na tarja deste produto. Como esta planilha de teste tem
// só 4 linhas, não há outra linha da mesma substância de onde herdar — então
// fica desconhecida, e NÃO "livre". Numa importação da lista inteira a
// inferência costuma resolver (3.807 das 4.692 linhas sem tarja).
assert(bay && bay.tarja === null && bay.tarjaOrigem === 'desconhecida',
  'BAYCUTEN N: a CMED não informa a tarja, e o importador não inventa "livre"',
  JSON.stringify({ tarja: bay && bay.tarja, origem: bay && bay.tarjaOrigem }));
assert(bay && bay.registroAnvisa === '1705600230032', 'registro ANVISA preservado sem máscara');

// ─── Massa: produtos que casam por cada um dos dois caminhos de EAN ──────────
secao('Importação para o tenant');

const PREFIXO = 'TESTE-FARM-F1-';
function limpar() {
  const ids = db.prepare(`SELECT id FROM produtos WHERE sku LIKE ?`).all(PREFIXO + '%').map(r => r.id);
  for (const id of ids) {
    db.prepare('DELETE FROM farmacia_medicamento_specs WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produto_codigos WHERE produtoId = ?').run(id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(id);
  }
  const v = db.prepare("SELECT id FROM farmacia_cmed_versoes WHERE competencia = '9999-01'").get();
  if (v) {
    db.prepare('DELETE FROM farmacia_cmed_naocasados WHERE cmedVersaoId = ?').run(v.id);
    db.prepare('DELETE FROM farmacia_cmed_versoes WHERE id = ?').run(v.id);
  }
}
limpar();

const eanBay = bay.eans[0];
const linhaAnti = lido.linhas.find(l => l.antimicrobiano);
const eanAnti = linhaAnti.eans[0];

// (a) casa por produtos.codigoBarras
const idA = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, codigoBarras, ativo)
  VALUES (?, 'BAYCUTEN N CREME 40G', 'UN', 60, '30049099', ?, 1)`).run(PREFIXO + 'A', eanBay).lastInsertRowid;
// (b) casa por produto_codigos tipo 'ean'
const idB = db.prepare(`INSERT INTO produtos (sku, descricao, unidade, precoVenda, ncm, ativo)
  VALUES (?, 'ANTIMICROBIANO TESTE', 'UN', 40, '30042099', 1)`).run(PREFIXO + 'B').lastInsertRowid;
db.prepare(`INSERT INTO produto_codigos (produtoId, codigo, tipo, principal, ativo)
  VALUES (?, ?, 'ean', 1, 1)`).run(idB, eanAnti);

const r1 = importarCmed(db, ARQUIVO_TESTE, { colunaPmc: '19', uf: 'PA', competencia: '9999-01', usuario: 'teste' });
assert(r1.lidas === amostra.length, `importou lendo ${amostra.length} linhas`, JSON.stringify(r1));
assert(r1.casadas === 2, 'casou exatamente os 2 produtos plantados', JSON.stringify(r1));
assert(r1.naoCasadas === amostra.length - 2, 'as demais foram para a fila de não-casados', JSON.stringify(r1));

const specA = db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(idA);
assert(specA && specA.pmc === 50.9, 'spec do produto A recebeu o PMC 19% do arquivo real', JSON.stringify(specA && specA.pmc));
assert(specA.registroAnvisa === '1705600230032', 'spec do produto A recebeu o registro ANVISA');
assert(specA.listaCmed === 'negativa', 'spec do produto A recebeu a lista de crédito tributário');
assert(specA.ean === eanBay, 'spec guarda o EAN que efetivamente casou');

const specB = db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(idB);
assert(!!specB, 'produto casado por produto_codigos tipo ean também recebeu spec');
assert(specB.antimicrobiano === 1, 'antimicrobiano marcado pela substância');

const naoCasados = db.prepare(`SELECT * FROM farmacia_cmed_naocasados
  WHERE cmedVersaoId = ?`).all(r1.versaoId);
assert(naoCasados.length === amostra.length - 2, 'fila de não-casados tem as linhas sem produto');
assert(naoCasados.every(n => n.produto && n.motivo), 'não-casado guarda produto e motivo para conferência');

const produtosCriados = db.prepare('SELECT COUNT(*) n FROM produtos WHERE sku LIKE ?').get(PREFIXO + '%').n;
assert(produtosCriados === 2, 'importador NÃO cria produto a partir da CMED (EAN da origem é sujo)');

// ─── Reimportação: idempotência e preservação da curadoria ───────────────────
secao('Reimportação da mesma competência');

// Curadoria local: a CMED não publica lista da 344; o farmacêutico preenche.
db.prepare(`UPDATE farmacia_medicamento_specs
            SET listaPortaria344 = 'C1', antimicrobiano = 1 WHERE produtoId = ?`).run(idA);

const r2 = importarCmed(db, ARQUIVO_TESTE, { colunaPmc: '19', uf: 'PA', competencia: '9999-01', usuario: 'teste' });
assert(r2.versaoId === r1.versaoId, 'reimportar a mesma competência reaproveita a versão (não duplica)');
const naoCasados2 = db.prepare('SELECT COUNT(*) n FROM farmacia_cmed_naocasados WHERE cmedVersaoId = ?').get(r1.versaoId).n;
assert(naoCasados2 === amostra.length - 2, 'fila de não-casados não duplicou na reimportação', `n=${naoCasados2}`);

const specAdepois = db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(idA);
assert(specAdepois.listaPortaria344 === 'C1',
  'reimportação PRESERVA a lista da Portaria 344 preenchida à mão');
assert(specAdepois.antimicrobiano === 1,
  'reimportação PRESERVA o flag de antimicrobiano curado à mão');
assert(specAdepois.pmc === 50.9, 'reimportação atualiza o preço normalmente');

// ─── Tarja não informada: o buraco que quase passou ──────────────────────────
secao('Tarja "- (*)" e inferência por substância');

// Duas linhas REAIS do arquivo, mesma substância: uma sem tarja informada e
// outra com Tarja Preta. É o caso do clonazepam na lista de 11/08/2026.
const linhasSubst = new Map();
for (const r of linhasReais) {
  const s = normalizarTexto(r[cols.substancia]);
  if (!s) continue;
  if (!linhasSubst.has(s)) linhasSubst.set(s, []);
  linhasSubst.get(s).push(r);
}
let parSemInfo = null;
for (const [, rs] of linhasSubst) {
  const semInfo = rs.find(r => String(r[cols.tarja]).trim().startsWith('-'));
  const preta = rs.find(r => /PRETA/i.test(String(r[cols.tarja])));
  if (semInfo && preta) { parSemInfo = { semInfo, preta }; break; }
}
assert(!!parSemInfo,
  'o arquivo real de fato tem substância com uma linha "- (*)" e outra "Tarja Preta"');

const ARQ_TARJA = '/tmp/cmed-teste-f1-tarja.xlsx';
const wbTarja = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbTarja,
  XLSX.utils.aoa_to_sheet([...rowsReal.slice(0, iHeaderReal + 1), parSemInfo.preta, parSemInfo.semInfo]),
  'Planilha1');
XLSX.writeFile(wbTarja, ARQ_TARJA);

const lidoTarja = lerPlanilhaCmed(ARQ_TARJA, { colunaPmc: '19' });
const linhaPreta = lidoTarja.linhas[0];
const linhaSemInfo = lidoTarja.linhas[1];
assert(linhaPreta.tarja === 'preta' && linhaPreta.tarjaOrigem === 'cmed',
  'linha com tarja informada fica como veio, marcada como origem cmed');
assert(linhaSemInfo.tarja === 'preta',
  'linha "- (*)" HERDA a tarja preta da mesma substância — senão um controlado entraria como venda livre',
  JSON.stringify({ tarja: linhaSemInfo.tarja, origem: linhaSemInfo.tarjaOrigem }));
assert(linhaSemInfo.tarjaOrigem === 'inferida',
  'a herança fica marcada como inferida, para o farmacêutico saber que foi deduzida');

// Substância sem nenhuma linha informativa continua desconhecida — não é
// aceitável inventar "livre" para ela.
const ARQ_SO_SEMINFO = '/tmp/cmed-teste-f1-seminfo.xlsx';
const wbSo = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbSo,
  XLSX.utils.aoa_to_sheet([...rowsReal.slice(0, iHeaderReal + 1), parSemInfo.semInfo]), 'Planilha1');
XLSX.writeFile(wbSo, ARQ_SO_SEMINFO);
const lidoSo = lerPlanilhaCmed(ARQ_SO_SEMINFO, { colunaPmc: '19' });
assert(lidoSo.linhas[0].tarja === null && lidoSo.linhas[0].tarjaOrigem === 'desconhecida',
  'sem nenhuma linha informativa, a tarja fica desconhecida (não vira "livre")',
  JSON.stringify(lidoSo.linhas[0].tarjaOrigem));

// Curadoria manual resiste à reimportação.
db.prepare("UPDATE farmacia_medicamento_specs SET tarja = 'preta', tarjaOrigem = 'manual' WHERE produtoId = ?").run(idA);
importarCmed(db, ARQUIVO_TESTE, { colunaPmc: '19', uf: 'PA', competencia: '9999-01', usuario: 'teste' });
const specTarja = db.prepare('SELECT tarja, tarjaOrigem FROM farmacia_medicamento_specs WHERE produtoId = ?').get(idA);
assert(specTarja.tarja === 'preta' && specTarja.tarjaOrigem === 'manual',
  'tarja corrigida à mão NÃO é sobrescrita pela reimportação da CMED',
  JSON.stringify(specTarja));

try { fs.unlinkSync(ARQ_TARJA); fs.unlinkSync(ARQ_SO_SEMINFO); } catch (_) { /* */ }

const versao = db.prepare('SELECT * FROM farmacia_cmed_versoes WHERE id = ?').get(r1.versaoId);
assert(versao.colunaPmc === '19' && versao.ufReferencia === 'PA',
  'versão registra de que coluna/UF vieram os preços');
assert(versao.linhasCasadas === 2, 'versão registra o placar da importação');

// ─── Rotas ───────────────────────────────────────────────────────────────────
secao('Rotas do cadastro farmacêutico');

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
  let i = 0;
  const stack = l.route.stack;
  const next = () => { const h = stack[i++]; if (h) h.handle(req, res, next); };
  next();
  return { out, st };
}

let r = chamar('/api/farmacia/medicamentos', 'get', { query: { q: 'clotrimazol' } });
assert(r.st === 200 && r.out.items.some(i => i.produtoId === idA),
  'busca por princípio ativo (substância) encontra o medicamento', JSON.stringify(r.out.items?.length));

r = chamar('/api/farmacia/medicamentos', 'get', { query: { q: eanBay } });
assert(r.out.items.some(i => i.produtoId === idA), 'busca por EAN encontra o medicamento');

r = chamar('/api/farmacia/medicamentos/:produtoId', 'get', { params: { produtoId: idA } });
assert(r.st === 200 && r.out.item.produtoId === idA, 'detalhe do medicamento responde');

r = chamar('/api/farmacia/medicamentos/:produtoId', 'put', { params: { produtoId: idA }, body: { tarja: 'roxa' } });
assert(r.st === 400, 'tarja fora do vocabulário é recusada', `st=${r.st}`);

r = chamar('/api/farmacia/medicamentos/:produtoId', 'put', { params: { produtoId: idA }, body: { listaPortaria344: 'Z9' } });
assert(r.st === 400, 'lista da Portaria 344 inválida é recusada', `st=${r.st}`);

r = chamar('/api/farmacia/medicamentos/:produtoId', 'put', {
  params: { produtoId: idA }, body: { isentoRegistro: 1, motivoIsencao: '' },
});
assert(r.st === 400, 'isenção de registro sem motivo é recusada (evita a rejeição 840 da SEFAZ)', `st=${r.st}`);

r = chamar('/api/farmacia/medicamentos/:produtoId', 'put', {
  params: { produtoId: idA }, body: { isentoRegistro: 1, motivoIsencao: 'DECISAO 123/2026' },
});
assert(r.st === 200 && r.out.item.isentoRegistro === 1 && r.out.item.motivoIsencao === 'DECISAO 123/2026',
  'isenção com motivo é aceita');

r = chamar('/api/farmacia/medicamentos/:produtoId', 'put', { params: { produtoId: 999999 }, body: { tarja: 'livre' } });
assert(r.st === 404, 'produto inexistente devolve 404');

r = chamar('/api/farmacia/cmed/versoes', 'get');
assert(r.st === 200 && r.out.items.some(v => v.competencia === '9999-01'), 'lista de versões da CMED responde');

r = chamar('/api/farmacia/cmed/naocasados', 'get', { query: { versaoId: r1.versaoId } });
assert(r.st === 200 && r.out.items.length === amostra.length - 2, 'fila de não-casados responde por versão');

r = chamar('/api/farmacia/medicamentos', 'get', { query: { controlados: '1' } });
assert(r.out.items.every(i => i.listaPortaria344 || i.antimicrobiano),
  'filtro de controlados só devolve controlado/antimicrobiano');

// ─── Limpeza ─────────────────────────────────────────────────────────────────
limpar();
try { fs.unlinkSync(ARQUIVO_TESTE); } catch (_) { /* */ }
if (flagOriginal) {
  db.prepare("UPDATE config SET valor = ? WHERE chave = 'farmacia_enabled'").run(flagOriginal.valor);
} else {
  db.prepare("DELETE FROM config WHERE chave = 'farmacia_enabled'").run();
}
const sobrou = db.prepare('SELECT COUNT(*) n FROM produtos WHERE sku LIKE ?').get(PREFIXO + '%').n;
assert(sobrou === 0, 'massa de teste removida do tenant');

console.log(`\n${fail === 0 ? 'OK' : 'FALHOU'} — ${ok} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
