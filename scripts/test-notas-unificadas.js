/**
 * Lista unificada de notas fiscais com NFS-e dentro.
 *
 * A tela se chamava "gestão unificada" e mostrava só NF-e (entrada + saída).
 * No 1bit isso escondia 91 de 106 documentos: a NFS-e, que era a maioria,
 * só existia numa tela separada. Estes testes travam a inclusão dela e as
 * bordas que aparecem quando um terceiro tipo entra num código escrito para
 * dois (filtros de CFOP, exclusão lógica, links de detalhe e DANFE).
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasNfeEntrada } = require('../nfe-entrada-routes');

const DB = '/tmp/vp-notas.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-notas-schema.sql', 'utf8');
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
const cliente = db.prepare("INSERT INTO pessoas (razaoSocial, cpfCnpj) VALUES ('Cliente SA', '11111111000191')").run().lastInsertRowid;
db.prepare("INSERT INTO fornecedores (razaoSocial, cpfCnpj) VALUES ('Fornecedor SA', '22222222000192')").run();

db.prepare(`INSERT INTO nfe_entrada (numero, serie, chaveAcesso, dataEmissao, valorTotal, situacao,
  naturezaOperacao, emitenteRazaoSocial, emitenteCnpj, fornecedorId)
  VALUES ('500', '1', 'CH-ENTRADA-0001', '2026-07-10T10:00:00-03:00', 250.00, 'processada',
  'Compra', 'Fornecedor SA', '22222222000192', 1)`).run();

db.prepare(`INSERT INTO faturas (numero, clienteId, dataEmissao, dataVencimento, valorBruto, valorTotal, status, statusSefaz, chaveAcesso)
  VALUES ('900', ?, '2026-07-12', '2026-08-12', 1000.00, 1000.00, 'emitida', 'autorizada', 'CH-SAIDA-0001')`).run(cliente);

const NOTAS = [
  ['DPS-1', '1', 1, 'CH-NFSE-0001', '900001', 'Cliente SA', '11111111000191', 'Consultoria', 1500.00, '2026-07-15', 'autorizada', '2026-07-15 09:30:00'],
  ['DPS-2', '1', 2, 'CH-NFSE-0002', '900002', 'Cliente SA', '11111111000191', 'Suporte', 300.00, '2026-07-16', 'cancelada', '2026-07-16 11:00:00'],
  ['DPS-3', '1', 3, null, null, 'Cliente SA', '11111111000191', 'Treinamento', 800.00, '2026-07-17', 'erro', '2026-07-17 14:00:00'],
  ['DPS-4', '1', 4, null, null, 'Cliente SA', '11111111000191', 'Manutenção', 120.00, '2026-07-18', 'processando', '2026-07-18 08:00:00'],
];
const insNfse = db.prepare(`INSERT INTO nfse (idDps, serie, nDPS, chaveAcesso, nNFSe, tomadorRazaoSocial,
  tomadorCpfCnpj, descricaoServico, valorServico, dataCompetencia, status, dataCriacao)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const n of NOTAS) insNfse.run(...n);

// ---------- app ----------
const app = express();
app.use(express.json());
registrarRotasNfeEntrada(app, db);

function achar(metodo, caminho) {
  for (const c of app.router.stack) {
    if (c.route && c.route.path === caminho && c.route.methods[metodo]) {
      return c.route.stack[c.route.stack.length - 1].handle;
    }
  }
  throw new Error('rota não encontrada: ' + caminho);
}
function listar(query = {}) {
  const h = achar('get', '/api/notas-fiscais');
  let out = null;
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(j) { out = { status: this.statusCode, body: j }; return this; },
  };
  h({ query, params: {}, body: {}, session: { username: 'tester' } }, res, () => {});
  if (!out) throw new Error('handler não respondeu');
  if (!out.body.success) throw new Error('erro: ' + out.body.error);
  return out.body.notas;
}
const so = (notas, tipo) => notas.filter(n => n.tipo === tipo);
const porNumero = (notas, num) => notas.find(n => String(n.numero) === String(num));

console.log('\n--- a NFS-e entra na lista ---');

t('sem filtro, os três tipos aparecem juntos', () => {
  const n = listar();
  assert(so(n, 'entrada').length === 1, 'entrada: ' + so(n, 'entrada').length);
  assert(so(n, 'saida').length === 1, 'saida: ' + so(n, 'saida').length);
  assert(so(n, 'nfse').length === 4, 'nfse: ' + so(n, 'nfse').length);
});

t('a lista sai ordenada por emissão, misturando os tipos', () => {
  const datas = listar().map(x => x.dataEmissao);
  const ordenado = [...datas].sort().reverse();
  assert(JSON.stringify(datas) === JSON.stringify(ordenado), datas.join(' | '));
});

t('filtro tipo=nfse traz só NFS-e', () => {
  const n = listar({ tipo: 'nfse' });
  assert(n.length === 4 && n.every(x => x.tipo === 'nfse'), JSON.stringify(n.map(x => x.tipo)));
});

t('filtro tipo=saida não vaza NFS-e (as duas são emissão, mas não são a mesma coisa)', () => {
  const n = listar({ tipo: 'saida' });
  assert(n.length === 1 && n[0].tipo === 'saida', JSON.stringify(n.map(x => x.tipo)));
});

t('filtro tipo=entrada continua intocado', () => {
  const n = listar({ tipo: 'entrada' });
  assert(n.length === 1 && n[0].tipo === 'entrada', JSON.stringify(n.map(x => x.tipo)));
});

console.log('\n--- as colunas dizem a verdade ---');

t('número usa o nNFSe quando existe e cai no nDPS quando ainda não veio', () => {
  const n = listar({ tipo: 'nfse' });
  assert(porNumero(n, '900001'), 'nota autorizada sem nNFSe');
  const semNumero = n.find(x => x.chaveAcesso === null);
  assert(semNumero && String(semNumero.numero) === '3' || String(semNumero.numero) === '4',
    'nota sem chave deveria mostrar o nDPS: ' + JSON.stringify(semNumero && semNumero.numero));
});

t('tomador vira a coluna Pessoa', () => {
  const n = porNumero(listar({ tipo: 'nfse' }), '900001');
  assert(n.pessoa.nome === 'Cliente SA', JSON.stringify(n.pessoa));
  assert(n.pessoa.cpfCnpj === '11111111000191', JSON.stringify(n.pessoa));
});

t('status da prefeitura é traduzido para o vocabulário da tela', () => {
  const n = listar({ tipo: 'nfse' });
  const mapa = Object.fromEntries(n.map(x => [x.status, x.statusSefaz]));
  assert(mapa.autorizada === 'autorizada', JSON.stringify(mapa));
  assert(mapa.cancelada === 'cancelada_sefaz', JSON.stringify(mapa));
  assert(mapa.erro === 'rejeitada', JSON.stringify(mapa));
  assert(mapa.processando === 'aguardando', JSON.stringify(mapa));
});

t('NFS-e não inventa CFOP nem tipo de operação', () => {
  const n = porNumero(listar({ tipo: 'nfse' }), '900001');
  assert(n.cfop === null, 'cfop: ' + n.cfop);
  assert(n.tipoOperacaoCodigo === null, 'tipoOp: ' + n.tipoOperacaoCodigo);
  assert(n.tipoOperacaoDescricao === 'Consultoria', 'descricao: ' + n.tipoOperacaoDescricao);
});

t('a data fica no mesmo formato das outras, senão o ordenar mente', () => {
  const n = porNumero(listar({ tipo: 'nfse' }), '900001');
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(n.dataEmissao), 'data: ' + n.dataEmissao);
});

console.log('\n--- links ---');

t('DANFSE sai quando há chave de acesso', () => {
  const n = porNumero(listar({ tipo: 'nfse' }), '900001');
  assert(n.links.danfe === `/api/nfse/${n.id}/danfse`, JSON.stringify(n.links));
});

t('nota cancelada continua com DANFSE — é documento, não sumiu', () => {
  const n = porNumero(listar({ tipo: 'nfse' }), '900002');
  assert(n.statusSefaz === 'cancelada_sefaz', n.statusSefaz);
  assert(n.links.danfe, 'perdeu o PDF da nota cancelada');
});

t('nota sem chave não oferece PDF que não existe', () => {
  const n = listar({ tipo: 'nfse' }).filter(x => !x.chaveAcesso);
  assert(n.length === 2, 'esperava 2 sem chave: ' + n.length);
  assert(n.every(x => x.links.danfe === null), JSON.stringify(n.map(x => x.links.danfe)));
});

t('NFS-e não aponta para tela de detalhe de NF-e', () => {
  const n = listar({ tipo: 'nfse' });
  assert(n.every(x => x.links.detalhe === null), JSON.stringify(n.map(x => x.links.detalhe)));
});

t('os links de NF-e não mudaram', () => {
  const e = listar({ tipo: 'entrada' })[0];
  const s = listar({ tipo: 'saida' })[0];
  assert(/nfe-entrada-detalhe/.test(e.links.detalhe), e.links.detalhe);
  assert(/nfe-detalhe/.test(s.links.detalhe), s.links.detalhe);
});

console.log('\n--- filtros existentes não quebram com o terceiro tipo ---');

t('busca por tomador encontra NFS-e', () => {
  const n = listar({ busca: 'Cliente' });
  assert(so(n, 'nfse').length === 4, 'nfse encontradas: ' + so(n, 'nfse').length);
});

t('busca por chave encontra a NFS-e certa', () => {
  const n = listar({ busca: 'CH-NFSE-0001' });
  assert(n.length === 1 && n[0].tipo === 'nfse', JSON.stringify(n.map(x => [x.tipo, x.numero])));
});

t('filtro por CFOP exclui NFS-e sozinho (serviço não tem CFOP)', () => {
  const n = listar({ cfop: '5102' });
  assert(so(n, 'nfse').length === 0, 'NFS-e apareceu num filtro de CFOP');
});

t('filtro por período pega NFS-e apesar do formato de data diferente', () => {
  const n = listar({ tipo: 'nfse', dataInicio: '2026-07-16', dataFim: '2026-07-17' });
  assert(n.length === 2, 'no período: ' + JSON.stringify(n.map(x => x.dataEmissao)));
});

t('o último dia do período inclui a nota emitida naquele dia', () => {
  const n = listar({ tipo: 'nfse', dataInicio: '2026-07-18', dataFim: '2026-07-18' });
  assert(n.length === 1, 'esperava a nota do dia 18: ' + JSON.stringify(n.map(x => x.dataEmissao)));
});

t('filtro por status SEFAZ funciona para NFS-e', () => {
  const n = listar({ statusSefaz: 'rejeitada' });
  assert(n.length === 1 && n[0].tipo === 'nfse' && n[0].status === 'erro', JSON.stringify(n));
});

t('NFS-e conta como ativa (não tem exclusão lógica)', () => {
  assert(so(listar({ status: 'ativa' }), 'nfse').length === 4, 'sumiu do filtro padrão');
});

t('o filtro de excluídas não traz NFS-e', () => {
  assert(so(listar({ status: 'excluida' }), 'nfse').length === 0, 'NFS-e apareceu como excluída');
});

t('filtro por tipo de operação continua só para saída', () => {
  const n = listar({ tipoOperacao: 'XYZ' });
  assert(n.length === 0, JSON.stringify(n.map(x => x.tipo)));
});

console.log('\n--- tenant sem o módulo ---');

t('banco sem tabela nfse não derruba a lista', () => {
  try { fs.unlinkSync('/tmp/vp-notas-sem-nfse.db'); } catch {}
  const db2 = new Database('/tmp/vp-notas-sem-nfse.db');
  db2.exec(schema);
  for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
    db2.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  }
  // Tenant que nunca emitiu NFS-e: db-schema so cria a tabela quando o modulo
  // e provisionado, entao ela pode simplesmente nao existir.
  db2.exec('DROP TABLE nfse');
  const app2 = express();
  app2.use(express.json());
  registrarRotasNfeEntrada(app2, db2);
  let h = null;
  for (const c of app2.router.stack) {
    if (c.route && c.route.path === '/api/notas-fiscais' && c.route.methods.get) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  for (const q of [{}, { tipo: 'nfse' }]) {
    let out = null;
    h({ query: q, params: {}, body: {} }, { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { out = j; } }, () => {});
    assert(out && out.success, 'query ' + JSON.stringify(q) + ' -> ' + JSON.stringify(out));
  }
  db2.close();
  try { fs.unlinkSync('/tmp/vp-notas-sem-nfse.db'); } catch {}
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
