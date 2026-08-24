/**
 * Parâmetros de emissão como seção do cadastro da empresa + NFC-e na lista
 * unificada.
 *
 * As telas /fiscal/nfe-config e /fiscal/nfce-config foram aposentadas. O
 * armazenamento NÃO mudou de tabela de propósito: `proximoNumero` é um contador
 * que a emissão incrementa em transação. O que mudou é onde se edita — e
 * aposentar a tela de NFC-e tirava o único lugar onde cupom aparecia, então
 * NFC-e entrou na lista unificada junto.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasNfeEntrada } = require('../nfe-entrada-routes');

const DB = '/tmp/vp-nfcfg.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-nfcfg-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- fixture ----------
db.prepare("INSERT INTO pessoas (razaoSocial, cpfCnpj) VALUES ('Cliente SA', '11111111000191')").run();
db.prepare("INSERT INTO fornecedores (razaoSocial, cpfCnpj) VALUES ('Fornecedor SA', '22222222000192')").run();
db.prepare(`INSERT INTO nfe_entrada (numero, serie, chaveAcesso, dataEmissao, valorTotal, situacao,
  naturezaOperacao, emitenteRazaoSocial, emitenteCnpj, fornecedorId)
  VALUES ('500','1','CH-ENT-1','2026-07-10T10:00:00-03:00',250.0,'processada','Compra','Fornecedor SA','22222222000192',1)`).run();
db.prepare(`INSERT INTO faturas (numero, clienteId, dataEmissao, dataVencimento, valorBruto, valorTotal, status, statusSefaz, chaveAcesso, xmlAssinado)
  VALUES ('900',1,'2026-07-12','2026-08-12',1000.0,1000.0,'emitida','autorizada','CH-SAI-1','<xml/>')`).run();
db.prepare(`INSERT INTO nfse (idDps, serie, nDPS, chaveAcesso, nNFSe, tomadorRazaoSocial, tomadorCpfCnpj,
  descricaoServico, valorServico, dataCompetencia, status, dataCriacao)
  VALUES ('DPS-1','1',1,'CH-NFSE-1','900001','Cliente SA','11111111000191','Consultoria',1500.0,'2026-07-15','autorizada','2026-07-15 09:30:00')`).run();

const CUPONS = [
  // numero, serie, chave, tpAmb, dataEmissao, valorTotal, cpf, nome, xml, statusSefaz
  [1, 1, 'CH-NFCE-1', 1, '2026-07-20 08:00:00', 49.90, '33333333333', 'Maria Souza', '<xml/>', 'autorizada'],
  [2, 1, 'CH-NFCE-2', 1, '2026-07-20 09:00:00', 12.50, null, null, '<xml/>', 'autorizada'],
  [3, 1, 'CH-NFCE-3', 1, '2026-07-21 10:00:00', 80.00, null, null, '<xml/>', 'cancelada'],
  [4, 1, null, 1, '2026-07-22 11:00:00', 15.00, null, null, null, 'pendente'],
  [5, 1, null, 1, '2026-07-23 12:00:00', 20.00, null, null, null, 'rejeitada'],
];
const insN = db.prepare(`INSERT INTO nfce (numero, serie, chaveAcesso, tpAmb, dataEmissao, valorTotal,
  consumidorCpfCnpj, consumidorNome, xmlAssinado, statusSefaz) VALUES (?,?,?,?,?,?,?,?,?,?)`);
for (const c of CUPONS) insN.run(...c);

// ---------- app ----------
const app = express();
app.use(express.json());
registrarRotasNfeEntrada(app, db);

function handler(appx, caminho) {
  for (const c of appx.router.stack) {
    if (c.route && c.route.path === caminho && c.route.methods.get) {
      return c.route.stack[c.route.stack.length - 1].handle;
    }
  }
  throw new Error('rota não encontrada: ' + caminho);
}
function listar(query = {}, appx = app) {
  const h = handler(appx, '/api/notas-fiscais');
  let out = null;
  h({ query, params: {}, body: {} },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { out = j; } },
    () => {});
  if (!out) throw new Error('handler não respondeu');
  if (!out.success) throw new Error('erro: ' + out.error);
  return out.notas;
}
const so = (n, tipo) => n.filter(x => x.tipo === tipo);
const porNum = (n, num) => n.find(x => String(x.numero) === String(num));

console.log('\n--- NFC-e entra na lista unificada ---');

t('sem filtro, os quatro tipos convivem', () => {
  const n = listar();
  assert(so(n, 'entrada').length === 1, 'entrada: ' + so(n, 'entrada').length);
  assert(so(n, 'saida').length === 1, 'saida: ' + so(n, 'saida').length);
  assert(so(n, 'nfse').length === 1, 'nfse: ' + so(n, 'nfse').length);
  assert(so(n, 'nfce').length === 5, 'nfce: ' + so(n, 'nfce').length);
});

t('filtro tipo=nfce traz só cupom', () => {
  const n = listar({ tipo: 'nfce' });
  assert(n.length === 5 && n.every(x => x.tipo === 'nfce'), JSON.stringify(n.map(x => x.tipo)));
});

t('cupom não vaza para o filtro de saída', () => {
  assert(so(listar({ tipo: 'saida' }), 'nfce').length === 0, 'cupom apareceu como NF-e de saída');
});

t('ordenação continua correta com quatro origens', () => {
  const datas = listar().map(x => x.dataEmissao);
  assert(JSON.stringify(datas) === JSON.stringify([...datas].sort().reverse()), datas.join(' | '));
});

console.log('\n--- o cupom diz a verdade sobre si ---');

t('consumidor identificado aparece; anônimo fica nulo em vez de inventado', () => {
  const n = listar({ tipo: 'nfce' });
  assert(porNum(n, 1).pessoa.nome === 'Maria Souza', JSON.stringify(porNum(n, 1).pessoa));
  assert(porNum(n, 2).pessoa.nome === null, JSON.stringify(porNum(n, 2).pessoa));
  assert(porNum(n, 2).pessoa.cpfCnpj === null, JSON.stringify(porNum(n, 2).pessoa));
});

t('status da SEFAZ é traduzido para o vocabulário da tela', () => {
  const n = listar({ tipo: 'nfce' });
  assert(porNum(n, 1).statusSefaz === 'autorizada', porNum(n, 1).statusSefaz);
  assert(porNum(n, 3).statusSefaz === 'cancelada_sefaz', porNum(n, 3).statusSefaz);
  assert(porNum(n, 4).statusSefaz === 'aguardando', porNum(n, 4).statusSefaz);
  assert(porNum(n, 5).statusSefaz === 'rejeitada', porNum(n, 5).statusSefaz);
});

t('cupom não inventa CFOP nem tipo de operação de mercadoria', () => {
  const n = porNum(listar({ tipo: 'nfce' }), 1);
  assert(n.cfop === null, 'cfop: ' + n.cfop);
  assert(n.tipoOperacaoCodigo === null, 'tipoOp: ' + n.tipoOperacaoCodigo);
  assert(n.tipoOperacaoDescricao === 'Venda ao consumidor', n.tipoOperacaoDescricao);
});

t('data normalizada como as demais', () => {
  const n = porNum(listar({ tipo: 'nfce' }), 1);
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(n.dataEmissao), 'data: ' + n.dataEmissao);
});

console.log('\n--- links do cupom ---');

t('XML sai só de cupom autorizado com XML guardado', () => {
  const n = listar({ tipo: 'nfce' });
  assert(porNum(n, 1).links.xml === `/api/nfce/${porNum(n, 1).id}/xml`, JSON.stringify(porNum(n, 1).links));
  assert(porNum(n, 4).links.xml === null, 'cupom pendente ofereceu XML');
  assert(porNum(n, 5).links.xml === null, 'cupom rejeitado ofereceu XML');
});

t('cupom cancelado não oferece XML (o evento de cancelamento é outro documento)', () => {
  assert(porNum(listar({ tipo: 'nfce' }), 3).links.xml === null, 'ofereceu XML de cupom cancelado');
});

t('cupom não promete DANFE em PDF, que o sistema não gera', () => {
  assert(listar({ tipo: 'nfce' }).every(x => x.links.danfe === null), 'prometeu DANFE de NFC-e');
});

t('cupom não aponta para tela de detalhe de NF-e', () => {
  assert(listar({ tipo: 'nfce' }).every(x => x.links.detalhe === null), 'link de detalhe errado');
});

t('os outros tipos não ganharam link de XML por engano', () => {
  const n = listar();
  assert(n.filter(x => x.tipo !== 'nfce').every(x => x.links.xml === null), 'xml vazou para outro tipo');
});

t('NFS-e continua com DANFSE depois da entrada do cupom', () => {
  const n = so(listar(), 'nfse')[0];
  assert(n.links.danfe === `/api/nfse/${n.id}/danfse`, JSON.stringify(n.links));
});

t('NF-e de saída autorizada continua com DANFE', () => {
  const n = so(listar(), 'saida')[0];
  assert(n.links.danfe === `/api/faturas/${n.id}/danfe`, JSON.stringify(n.links));
});

console.log('\n--- filtros ---');

t('busca por consumidor encontra o cupom', () => {
  const n = listar({ busca: 'Maria' });
  assert(n.length === 1 && n[0].tipo === 'nfce', JSON.stringify(n.map(x => x.tipo)));
});

t('filtro por CFOP não traz cupom', () => {
  assert(so(listar({ cfop: '5102' }), 'nfce').length === 0, 'cupom apareceu num filtro de CFOP');
});

t('filtro por período funciona com a data normalizada', () => {
  const n = listar({ tipo: 'nfce', dataInicio: '2026-07-20', dataFim: '2026-07-20' });
  assert(n.length === 2, JSON.stringify(n.map(x => x.dataEmissao)));
});

t('cupom conta como ativo e nunca como excluído', () => {
  assert(so(listar({ status: 'ativa' }), 'nfce').length === 5, 'sumiu do filtro padrão');
  assert(so(listar({ status: 'excluida' }), 'nfce').length === 0, 'apareceu como excluído');
});

console.log('\n--- tenant sem o módulo de varejo ---');

t('banco sem tabela nfce não derruba a lista', () => {
  try { fs.unlinkSync('/tmp/vp-nfcfg-sem-nfce.db'); } catch {}
  const db2 = new Database('/tmp/vp-nfcfg-sem-nfce.db');
  db2.exec(schema);
  for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
    db2.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  }
  db2.exec('DROP TABLE nfce');
  const app2 = express();
  app2.use(express.json());
  registrarRotasNfeEntrada(app2, db2);
  for (const q of [{}, { tipo: 'nfce' }, { tipo: 'nfse' }]) {
    const r = listar(q, app2);
    assert(Array.isArray(r), 'query ' + JSON.stringify(q));
  }
  db2.close();
  try { fs.unlinkSync('/tmp/vp-nfcfg-sem-nfce.db'); } catch {}
});

// ================= CONFIG DE NFC-e =================
console.log('\n--- CSC: o que a tela mostra bate com o que está gravado ---');

const { registrarRotasNFCe } = require('../nfce-routes');
const appC = express();
appC.use(express.json());
registrarRotasNFCe(appC, db);

function chamarCfg(metodo, caminho, body = {}) {
  let h = null;
  for (const c of appC.router.stack) {
    if (c.route && c.route.path === caminho && c.route.methods[metodo]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota não encontrada: ' + metodo + ' ' + caminho);
  let out = null;
  h({ body, params: {}, query: {}, session: { username: 'tester' } },
    { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { out = { status: this.statusCode, body: j }; } },
    () => {});
  return out;
}
const cscGravado = () => db.prepare('SELECT csc FROM nfce_config WHERE id = 1').get().csc;

t('sem CSC gravado, GET e PUT concordam que não há CSC', () => {
  db.prepare("UPDATE nfce_config SET csc = '' WHERE id = 1").run();
  const g = chamarCfg('get', '/api/nfce/config').body.config;
  const p = chamarCfg('put', '/api/nfce/config', { serie: 1 }).body.config;
  assert(g.cscCadastrado === false, 'GET: ' + g.cscCadastrado);
  // Era aqui que a tela mentia: string vazia passava por "IS NOT NULL".
  assert(p.cscCadastrado === false, 'PUT dizia cadastrado com CSC vazio: ' + p.cscCadastrado);
});

t('gravar CSC passa a ser reportado como cadastrado', () => {
  const p = chamarCfg('put', '/api/nfce/config', { csc: 'TOKEN-SECRETO' }).body.config;
  assert(p.cscCadastrado === true, JSON.stringify(p));
  assert(cscGravado() === 'TOKEN-SECRETO', 'gravou: ' + cscGravado());
});

t('salvar com o campo em branco preserva o token (não é apagar)', () => {
  chamarCfg('put', '/api/nfce/config', { csc: '', serie: 2 });
  assert(cscGravado() === 'TOKEN-SECRETO', 'apagou o CSC ao salvar outro campo: ' + cscGravado());
  assert(db.prepare('SELECT serie FROM nfce_config WHERE id = 1').get().serie === 2, 'não salvou a série');
});

t('o CSC nunca é devolvido pela API, só o fato de existir', () => {
  const g = chamarCfg('get', '/api/nfce/config').body;
  const p = chamarCfg('put', '/api/nfce/config', { serie: 2 }).body;
  assert(!JSON.stringify(g).includes('TOKEN-SECRETO'), 'GET vazou o CSC');
  assert(!JSON.stringify(p).includes('TOKEN-SECRETO'), 'PUT vazou o CSC');
});

t('dá para apagar o CSC de propósito', () => {
  const p = chamarCfg('put', '/api/nfce/config', { cscLimpar: true }).body.config;
  assert(cscGravado() === null, 'não apagou: ' + JSON.stringify(cscGravado()));
  assert(p.cscCadastrado === false, JSON.stringify(p));
});

t('trocar de ambiente reinicia o contador (produção e homologação são séries distintas)', () => {
  db.prepare('UPDATE nfce_config SET tpAmb = 2, proximoNumero = 57 WHERE id = 1').run();
  const p = chamarCfg('put', '/api/nfce/config', { tpAmb: 1 }).body;
  assert(p.trocouAmbiente === true, JSON.stringify(p));
  assert(p.config.proximoNumero === 1, 'contador: ' + p.config.proximoNumero);
});

t('informar o próximo número junto com a troca respeita o que foi digitado', () => {
  db.prepare('UPDATE nfce_config SET tpAmb = 2, proximoNumero = 57 WHERE id = 1').run();
  const p = chamarCfg('put', '/api/nfce/config', { tpAmb: 1, proximoNumero: 411 }).body;
  assert(p.config.proximoNumero === 411, 'contador: ' + p.config.proximoNumero);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
