/**
 * Cadastro completo de fornecedor: campos fiscais/comerciais/bancários,
 * múltiplos contatos, certidões com validade e histórico de compras.
 */
const fs = require('fs');
const express = require('express');
const Database = require('better-sqlite3');
const { registrarRotasFornecedores, migrarFornecedoresDB,
        situacaoDocumentos, historicoCompras, valorCampo } = require('../fornecedores-routes');

const DB = '/tmp/vp-forn.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-forn-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}

const app = express();
registrarRotasFornecedores(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {},
                session: { username: 'tester' }, user: { username: 'tester' } },
    { json: x => { out = x; return { json: y => { out = y; } }; },
      status: c => { st = c; return { json: x => { out = x; } }; } });
  return { out, st };
}

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const dia = n => new Date(Date.now() + n * 86400000 - 3 * 3600000).toISOString().slice(0, 10);

// ---------- migração ----------
t('migração cria colunas novas e as tabelas filhas', () => {
  const cols = db.prepare('PRAGMA table_info(fornecedores)').all().map(c => c.name);
  for (const c of ['regimeTributario','porte','condicaoPagamento','prazoEntregaDias',
                   'banco','chavePix','statusHomologacao','avaliacao','categorias','emailFinanceiro']) {
    assert(cols.includes(c), 'faltou a coluna ' + c);
  }
  const tabs = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fornecedor_%'").all().map(x=>x.name);
  assert(tabs.includes('fornecedor_contatos') && tabs.includes('fornecedor_documentos'), 'tabelas: ' + tabs.join(','));
});

t('migrar duas vezes não quebra', () => {
  migrarFornecedoresDB(db);
  migrarFornecedoresDB(db);
});

// ---------- cadastro ----------
let F;
t('cadastro grava os campos completos, inclusive chavePix', () => {
  const r = chamar('/api/fornecedores', 'post', { body: {
    cpfCnpj: '11.222.333/0001-81', razaoSocial: 'Fornecedor Completo LTDA',
    nomeFantasia: 'Completo', regimeTributario: 'simples', porte: 'EPP',
    contribuinteIcms: 1, cnae: '4751-2/01', condicaoPagamento: '30/60',
    prazoEntregaDias: 15, pedidoMinimo: 500, tipoFrete: 'CIF',
    banco: '341', agencia: '1234', conta: '56789-0', tipoConta: 'corrente',
    chavePix: 'financeiro@completo.com.br', emailFinanceiro: 'nf@completo.com.br',
    categorias: 'informática, papelaria', cidade: 'Vitória', uf: 'es',
  } });
  assert(r.out.success, 'erro: ' + r.out.error);
  F = r.out.fornecedor;
  // chavePix existia na tabela mas estava fora de CAMPOS_FORN: nunca gravava.
  assert(F.chavePix === 'financeiro@completo.com.br', 'chavePix: ' + F.chavePix);
  assert(F.porte === 'EPP' && F.regimeTributario === 'simples', 'fiscal não gravou');
  assert(F.prazoEntregaDias === 15 && F.pedidoMinimo === 500, 'comercial não gravou');
  assert(F.cpfCnpj === '11222333000181', 'cpfCnpj não normalizou: ' + F.cpfCnpj);
});

t('número em branco vira null, não string vazia', () => {
  assert(valorCampo('prazoEntregaDias', '') === null, 'vazio deveria virar null');
  assert(valorCampo('prazoEntregaDias', '7') === 7, 'texto deveria virar número');
  assert(valorCampo('pedidoMinimo', 'abc') === null, 'lixo deveria virar null');
  const r = chamar('/api/fornecedores', 'post', { body: {
    cpfCnpj: '22333444000155', razaoSocial: 'Sem Números', prazoEntregaDias: '', pedidoMinimo: '' } });
  assert(r.out.fornecedor.prazoEntregaDias === null, 'gravou: ' + r.out.fornecedor.prazoEntregaDias);
});

t('valor fora do domínio é recusado com o nome do campo', () => {
  const r = chamar('/api/fornecedores', 'post', { body: {
    cpfCnpj: '33444555000166', razaoSocial: 'X', regimeTributario: 'inventado' } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/Regime tributário/.test(r.out.error), 'erro: ' + r.out.error);
});

t('avaliação fora de 1..5 é recusada', () => {
  const r = chamar('/api/fornecedores/:id', 'put', { params: { id: String(F.id) }, body: { avaliacao: 9 } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/1 e 5/.test(r.out.error), 'erro: ' + r.out.error);
});

t('homologar carimba a data sozinho', () => {
  const r = chamar('/api/fornecedores/:id', 'put', { params: { id: String(F.id) },
    body: { statusHomologacao: 'homologado' } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.fornecedor.dataHomologacao === hoje, 'data: ' + r.out.fornecedor.dataHomologacao);
});

t('opções do domínio vêm do backend', () => {
  const r = chamar('/api/fornecedores/opcoes', 'get', {});
  assert(r.out.regimes.includes('simples'), 'regimes');
  assert(r.out.portes.includes('EPP'), 'portes');
  assert(r.out.tiposDocumento.some(x => x.codigo === 'cnd_federal'), 'tipos de documento');
});

// ---------- contatos ----------
t('fornecedor aceita vários contatos', () => {
  for (const c of [
    { nome: 'Ana Compras', setor: 'Comercial', email: 'ana@x.com', principal: true },
    { nome: 'Beto Financeiro', setor: 'Financeiro', email: 'beto@x.com' },
  ]) {
    const r = chamar('/api/fornecedores/:id/contatos', 'post', { params: { id: String(F.id) }, body: c });
    assert(r.out.success, 'erro: ' + r.out.error);
  }
  const d = chamar('/api/fornecedores/:id', 'get', { params: { id: String(F.id) } }).out;
  assert(d.contatos.length === 2, 'contatos: ' + d.contatos.length);
});

t('só existe um contato principal', () => {
  chamar('/api/fornecedores/:id/contatos', 'post', { params: { id: String(F.id) },
    body: { nome: 'Carla Diretoria', principal: true } });
  const n = db.prepare('SELECT COUNT(*) n FROM fornecedor_contatos WHERE fornecedorId=? AND principal=1').get(F.id).n;
  assert(n === 1, 'principais: ' + n);
});

t('contato sem nome é recusado', () => {
  const r = chamar('/api/fornecedores/:id/contatos', 'post', { params: { id: String(F.id) }, body: {} });
  assert(r.st === 400, 'status: ' + r.st);
});

t('contato é removido', () => {
  const c = db.prepare('SELECT id FROM fornecedor_contatos WHERE fornecedorId=? AND principal=0 LIMIT 1').get(F.id);
  const r = chamar('/api/fornecedores/:id/contatos/:contatoId', 'delete',
    { params: { id: String(F.id), contatoId: String(c.id) } });
  assert(r.out.success, 'erro: ' + r.out.error);
});

t('contato de outro fornecedor não é removido por engano', () => {
  const outro = chamar('/api/fornecedores', 'post', { body: { cpfCnpj: '44555666000177', razaoSocial: 'Outro' } }).out.fornecedor;
  const c = db.prepare('SELECT id FROM fornecedor_contatos WHERE fornecedorId=? LIMIT 1').get(F.id);
  const r = chamar('/api/fornecedores/:id/contatos/:contatoId', 'delete',
    { params: { id: String(outro.id), contatoId: String(c.id) } });
  assert(r.st === 404, 'status: ' + r.st);
});

// ---------- certidões ----------
t('certidão vencida e a vencer são classificadas', () => {
  const add = (tipo, validade) => chamar('/api/fornecedores/:id/documentos', 'post',
    { params: { id: String(F.id) }, body: { tipo, dataValidade: validade } });
  assert(add('cnd_federal', dia(-10)).out.success, 'vencida');
  assert(add('fgts', dia(10)).out.success, 'a vencer');
  assert(add('trabalhista', dia(200)).out.success, 'válida');
  assert(add('alvara', null).out.success, 'sem validade');

  const s = situacaoDocumentos(db, F.id, 30);
  assert(s.total === 4, 'total: ' + s.total);
  assert(s.vencidos.length === 1 && s.vencidos[0].tipo === 'cnd_federal', 'vencidos: ' + JSON.stringify(s.vencidos.map(x=>x.tipo)));
  assert(s.aVencer.length === 1 && s.aVencer[0].tipo === 'fgts', 'aVencer: ' + JSON.stringify(s.aVencer.map(x=>x.tipo)));
  assert(s.semValidade === 1, 'semValidade: ' + s.semValidade);
});

t('tipo de documento inválido é recusado', () => {
  const r = chamar('/api/fornecedores/:id/documentos', 'post',
    { params: { id: String(F.id) }, body: { tipo: 'inventado' } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/tipo inválido/.test(r.out.error), 'erro: ' + r.out.error);
});

t('validade anterior à emissão é recusada', () => {
  const r = chamar('/api/fornecedores/:id/documentos', 'post', { params: { id: String(F.id) },
    body: { tipo: 'fgts', dataEmissao: '2026-05-10', dataValidade: '2026-04-01' } });
  assert(r.st === 400, 'status: ' + r.st);
  assert(/anterior/.test(r.out.error), 'erro: ' + r.out.error);
});

t('a listagem mostra quem está com certidão vencida', () => {
  const r = chamar('/api/fornecedores', 'get', {});
  const f = r.out.fornecedores.find(x => x.id === F.id);
  assert(f.docsVencidos === 1, 'docsVencidos: ' + f.docsVencidos);
  assert(f.docsAVencer === 1, 'docsAVencer: ' + f.docsAVencer);
  assert(r.out.resumo.comDocVencido === 1, 'resumo: ' + JSON.stringify(r.out.resumo));
});

t('filtro de pendência isola quem tem certidão vencida', () => {
  const r = chamar('/api/fornecedores', 'get', { query: { pendencia: '1' } });
  assert(r.out.fornecedores.length === 1 && r.out.fornecedores[0].id === F.id, 'filtro falhou');
});

t('painel de vencimentos lista com o nome do fornecedor', () => {
  const r = chamar('/api/fornecedores-documentos/vencimentos', 'get', { query: { dias: '30' } });
  assert(r.out.success, 'erro: ' + r.out.error);
  assert(r.out.vencidos === 1 && r.out.aVencer === 1, JSON.stringify({ v: r.out.vencidos, a: r.out.aVencer }));
  assert(r.out.documentos[0].fornecedor === 'Fornecedor Completo LTDA', 'sem o nome do fornecedor');
});

// ---------- busca ----------
t('busca também acha por cidade e por categoria', () => {
  assert(chamar('/api/fornecedores', 'get', { query: { q: 'Vitória' } }).out.fornecedores.length === 1, 'por cidade');
  assert(chamar('/api/fornecedores', 'get', { query: { q: 'papelaria' } }).out.fornecedores.length === 1, 'por categoria');
  assert(chamar('/api/fornecedores', 'get', { query: { q: 'nada-disso' } }).out.fornecedores.length === 0, 'busca vazia');
});

t('filtro por homologação e por UF', () => {
  assert(chamar('/api/fornecedores', 'get', { query: { statusHomologacao: 'homologado' } }).out.fornecedores.length === 1, 'homologado');
  assert(chamar('/api/fornecedores', 'get', { query: { uf: 'es' } }).out.fornecedores.length === 1, 'uf minúscula deveria casar');
});

// ---------- histórico ----------
t('histórico soma compras e mede pontualidade', () => {
  const ins = db.prepare(`INSERT INTO pedidos_compra
    (numero, fornecedorId, status, valorTotal, dataPrevistaEntrega, dataRecebimento)
    VALUES (?, ?, ?, ?, ?, ?)`);
  ins.run('PC-1', F.id, 'recebido', 1000, '2026-06-10', '2026-06-08'); // no prazo
  ins.run('PC-2', F.id, 'recebido', 3000, '2026-06-20', '2026-06-25'); // 5 dias de atraso
  ins.run('PC-3', F.id, 'cancelado', 9999, null, null);                // não conta

  const h = historicoCompras(db, F.id);
  assert(h.pedidos === 2, 'pedidos: ' + h.pedidos);
  assert(h.valorTotal === 4000, 'total: ' + h.valorTotal);
  assert(h.ticketMedio === 2000, 'ticket: ' + h.ticketMedio);
  assert(h.recebidos === 2 && h.entregasNoPrazo === 1, JSON.stringify(h));
  assert(h.atrasoMedioDias === 5, 'atraso médio: ' + h.atrasoMedioDias);
});

t('detalhe entrega cadastro, contatos, certidões e histórico juntos', () => {
  const d = chamar('/api/fornecedores/:id', 'get', { params: { id: String(F.id) } }).out;
  assert(d.fornecedor && d.contatos && d.documentos && d.situacaoDocumentos && d.historico, 'faltou bloco');
  assert(d.historico.pedidos === 2, 'histórico no detalhe');
});

t('fornecedor sem compra nenhuma não quebra o histórico', () => {
  const novo = chamar('/api/fornecedores', 'post', { body: { cpfCnpj: '55666777000188', razaoSocial: 'Novato' } }).out.fornecedor;
  const h = historicoCompras(db, novo.id);
  assert(h.pedidos === 0 && h.valorTotal === 0, JSON.stringify(h));
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
