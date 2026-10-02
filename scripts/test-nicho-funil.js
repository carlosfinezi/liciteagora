/**
 * O NICHO do contato, que é o funil do CRM dele (`nicho-funil.js`).
 *
 * ── O que esta suíte guarda ───────────────────────────────────────────────
 *
 * Desde 02/10/2026 cada contato tem DOIS vocabulários, em campos separados: o
 * segmento legado da campanha de WhatsApp, marcado com "(L)", e o nicho do
 * funil, que veio da planilha de propensão de 24/09. Os dois convivem, e o
 * defeito que isto previne é um apagar o outro — gravar o nicho não pode zerar
 * o segmento, e a troca de nome dos nove não pode fazer a coluna Segmento das
 * planilhas deixar de achá-los.
 *
 * O mapa de ramo para nicho não está escrito em lugar nenhum: o agrupamento dos
 * 39 setores da planilha em 10 funis foi feito à mão, e o que restou dele são as
 * descrições dos cards. Por isso o mapa é LIDO dos cards, e as etapas N3 e N5
 * sabotam exatamente isso: apagado o card, o contato cai no nicho padrão.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

require.cache[require.resolve('../audit-log')] = { exports: { logAction: () => {} } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nicho-funil-'));
const db = new Database(path.join(dir, 'pncp.db'));
db.exec(require('./schema-de-tenant').lerSchema());
db.pragma('foreign_keys = OFF');
try { db.exec('DROP TABLE IF EXISTS segmentos'); } catch (_) {}
const seg = require('../segmentos');
const nf = require('../nicho-funil');
seg.migrarSegmentos(db);
nf.migrarNicho(db);
for (const t of ['pessoas', 'comm_lista_membros', 'comm_listas', 'comm_campanhas', 'comm_envios',
  'crm_oportunidades', 'crm_funis', 'crm_etapas']) {
  try { db.exec(`DELETE FROM ${t}`); } catch (_) {}
}

// Os funis, como no 1bit: o inativo é o "Ligação Licitações", que recebeu a
// importação e foi fechado depois — ele não é nicho de ninguém.
const FUNIS = [
  [4, 'Comércio', 1, 1], [6, 'Alimentação', 2, 1], [8, 'Transporte e logística', 3, 1],
  [13, 'Outros e fora do perfil', 4, 1], [3, 'Ligação Licitações', 5, 0],
];
const insFunil = db.prepare('INSERT INTO crm_funis (id, nome, ordem, ativo) VALUES (?, ?, ?, ?)');
for (const f of FUNIS) insFunil.run(...f);
db.prepare("INSERT INTO crm_etapas (id, funilId, nome, ordem, tipo) VALUES (1, 4, 'Leads', 1, 'normal')").run();

const RAMO_BEBIDA = 'Comércio varejista de bebidas';
const RAMO_LANCHE = 'Lanchonetes, casas de chá, de sucos e similares';
const RAMO_CARGA = 'Transporte rodoviário de carga, exceto produtos perigosos e mudanças, municipal';
const RAMO_ALUGUEL_MAQ = 'Aluguel de máquinas e equipamentos para construção sem operador';
const RAMO_ALUGUEL_PALCO = 'Aluguel de palcos, coberturas e outras estruturas de uso temporário';

let proxCard = 100;
const card = ({ funilId, setor, ramo, clienteId = null, telefone = null }) => {
  const id = proxCard++;
  db.prepare(`INSERT INTO crm_oportunidades (id, funilId, etapaId, clienteId, clienteTelefoneLivre, titulo, descricao, ativo)
    VALUES (?, ?, 1, ?, ?, ?, ?, 1)`)
    .run(id, funilId, clienteId, telefone, 'CARD ' + id,
      `CNPJ: 00000000000${id}\nSetor: ${setor}\nRamo: ${ramo}\nPropensão: Quente (88)`);
  return id;
};

const pessoa = (o) => Number(db.prepare(`INSERT INTO pessoas (cpfCnpj, razaoSocial, telefone, categorias,
    segmentoId, nichoFunilId, cnaeDescricao, aceitaWhatsappMarketing, ativo)
  VALUES (@cpfCnpj, @razaoSocial, @telefone, @categorias, @segmentoId, @nichoFunilId, @cnae, 1, 1)`)
  .run({ cpfCnpj: 'X' + Math.random(), telefone: null, categorias: null, segmentoId: null,
    nichoFunilId: null, cnae: null, ...o }).lastInsertRowid);

const express = require(path.join(__dirname, '..', 'node_modules', 'express'));
const app = express();
app.use(express.json());
app.use((req, _r, n) => { req.user = { id: 1, username: 't' }; req.tenantDb = db; req.tenantCtx = { slug: 'teste-nicho' }; n(); });
require('../financeiro-routes').registrarRotasFinanceiro(app, db);
require('../comm-routes').registrarRotasComm(app, db);
require('../conversas-routes').registrarRotasConversas(app, db);

let ok = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const segId = (nome) => seg.segmentoPorNome(db, nome);
const nichoDaPessoa = (id) => db.prepare('SELECT nichoFunilId FROM pessoas WHERE id = ?').get(id).nichoFunilId;
const segDaPessoa = (id) => db.prepare('SELECT segmentoId FROM pessoas WHERE id = ?').get(id).segmentoId;

const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const j = async (u, o = {}) => (await fetch(base + u, { ...o,
    headers: o.body instanceof FormData ? {} : { 'Content-Type': 'application/json' } })).json();

  await t('N1 a coluna nasce, roda duas vezes sem erro, e o segmento legado fica com "(L)"', () => {
    nf.migrarNicho(db);
    const cols = db.prepare('PRAGMA table_info(pessoas)').all().map(c => c.name);
    assert(cols.includes('nichoFunilId'), 'sem pessoas.nichoFunilId');
    assert(cols.filter(c => c === 'nichoFunilId').length === 1, 'coluna duplicada');
    const legados = seg.listarSegmentos(db).map(s => s.nome);
    assert(legados.length === 9 && legados.every(n => n.endsWith(' (L)')), legados.join(','));
    // A marca é no nome, e o id não muda: é isso que faz quem já aponta para
    // eles (ficha, campanha, nicho de Conversas) continuar apontando.
    assert(seg.segmentoGenerico(db).nome === 'Genérico (L)', 'o Genérico se perdeu');
    assert(segId('Mercado') === segId('Mercado (L)'), 'a busca sem a marca deixou de achar');
  });

  await t('N2 nicho é funil ATIVO; o padrão é "Outros e fora do perfil"; funil fechado é recusado', () => {
    const nomes = nf.listarNichos(db).map(f => f.nome);
    assert(nomes.join(' | ') === 'Comércio | Alimentação | Transporte e logística | Outros e fora do perfil',
      nomes.join(' | '));
    assert(nf.nichoPadrao(db).id === 13, 'padrão: ' + JSON.stringify(nf.nichoPadrao(db)));
    assert(nf.nichoValido(db, 4) && !nf.nichoValido(db, 3) && !nf.nichoValido(db, 99), 'validação frouxa');
  });

  // O mapa sai dos cards. Dois do mesmo ramo em Comércio e um em Outros: o mais
  // frequente vence, que é a cauda de 1 card contra centenas da planilha real.
  const clienteComCard = pessoa({ razaoSocial: 'LOJA COM CARD' });
  card({ funilId: 4, setor: 'Comércio varejista', ramo: RAMO_BEBIDA, clienteId: clienteComCard });
  card({ funilId: 4, setor: 'Comércio varejista', ramo: RAMO_BEBIDA, telefone: '5594991110001' });
  card({ funilId: 13, setor: 'Outros', ramo: RAMO_BEBIDA, telefone: '5594991110002' });
  card({ funilId: 6, setor: 'Alimentação', ramo: RAMO_LANCHE, telefone: '5594991110003' });
  const cardCarga = card({ funilId: 8, setor: 'Transporte terrestre', ramo: RAMO_CARGA, telefone: '5594991110004' });
  card({ funilId: 13, setor: 'Fora do perfil', ramo: RAMO_ALUGUEL_PALCO, telefone: '5594991110005' });
  card({ funilId: 4, setor: 'Comércio atacadista', ramo: RAMO_ALUGUEL_MAQ, telefone: '5594991110006' });
  // O card de um funil FECHADO não deve classificar ninguém.
  card({ funilId: 3, setor: 'Outros', ramo: 'Atividade de telemarketing', telefone: '5594991110007' });

  await t('N3 o nicho sai do card, do telefone e do ramo, e o ramo truncado casa por começo', () => {
    const mapa = nf.mapaDeNicho(db);
    assert(mapa.nichoDe({ pessoaId: clienteComCard }).nichoId === 4, 'card da própria pessoa');
    // Card sem ficha de pessoa (a importação grava nome e telefone soltos): o
    // casamento é pelo número, e a origem diz por onde veio.
    assert(mapa.nichoDe({ telefone: '5594991110003' }).origem === 'telefone', 'origem pelo telefone');
    assert(mapa.nichoDe({ telefone: '5594991110003' }).nichoId === 6, 'card do telefone');
    assert(mapa.nichoDe({ pessoaId: clienteComCard }).origem === 'card', 'origem pela ficha');
    assert(mapa.nichoDe({ ramo: RAMO_BEBIDA }).nichoId === 4, 'ramo igual, pelo mais frequente');
    assert(mapa.nichoDe({ ramo: 'comercio VAREJISTA de bebidas' }).nichoId === 4, 'ramo ignorando acento e caixa');
    // O CSV da importação truncou o ramo na vírgula: '"Lanchonetes' é o começo
    // de 'Lanchonetes, casas de chá…'.
    assert(mapa.nichoDe({ ramo: '"Lanchonetes' }).nichoId === 6, 'ramo truncado por começo');
    assert(mapa.nichoDe({ ramo: 'Aluguel de ' }).nichoId === 13, 'começo ambíguo devia cair no padrão');
    assert(mapa.nichoDe({ ramo: 'Oficina de foguetes' }).nichoId === 13, 'ramo desconhecido devia cair no padrão');
    assert(mapa.nichoDe({ ramo: 'Atividade de telemarketing' }).nichoId === 13, 'card de funil fechado classificou');
    assert(mapa.nichoDe({}).origem === 'padrao', 'sem sinal nenhum devia ser o padrão');
  });

  await t('N3b apagado o card, o contato daquele ramo cai no nicho padrão', () => {
    const antes = nf.mapaDeNicho(db).nichoDe({ ramo: RAMO_CARGA });
    assert(antes.nichoId === 8, 'antes: ' + JSON.stringify(antes));
    db.prepare('UPDATE crm_oportunidades SET ativo = 0 WHERE id = ?').run(cardCarga);
    const depois = nf.mapaDeNicho(db).nichoDe({ ramo: RAMO_CARGA });
    assert(depois.nichoId === 13 && depois.origem === 'padrao', 'depois: ' + JSON.stringify(depois));
    db.prepare('UPDATE crm_oportunidades SET ativo = 1 WHERE id = ?').run(cardCarga);
  });

  await t('N4 a rota de comunicação devolve os dois grupos, e os legados com a marca', async () => {
    const r = await j('/api/comm/segmentos');
    assert(r.success && r.segmentos.length === 9 && r.nichos.length === 4, JSON.stringify(r).slice(0, 200));
    assert(r.segmentos.every(s => s.nome.endsWith(' (L)')), 'segmento sem a marca');
    assert(r.nichos.map(n => n.nome).includes('Outros e fora do perfil'), 'sem o nicho padrão');
    assert(!r.nichos.some(n => n.nome === 'Ligação Licitações'), 'ofereceu funil fechado');
  });

  let listaId, membroDoLead, leadId;
  await t('N5 a lista filtra e conta pelos dois, e a contagem segue o que se troca à mão', async () => {
    listaId = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('nicho')").run().lastInsertRowid);
    leadId = pessoa({ razaoSocial: 'ADEGA DO LEAD', telefone: '5594991110001',
      segmentoId: segId('Bebidas'), nichoFunilId: 4, categorias: '["lead"]' });
    const outro = pessoa({ razaoSocial: 'LANCHE DO LEAD', telefone: '5594991110003',
      segmentoId: segId('Alimentação'), nichoFunilId: 6, categorias: '["lead"]' });
    membroDoLead = Number(db.prepare(`INSERT INTO comm_lista_membros (listaId, pessoaId, destinoManual, nomeManual, ramo)
      VALUES (?, ?, '5594991110001', 'ADEGA DO LEAD', ?)`).run(listaId, leadId, RAMO_BEBIDA).lastInsertRowid);
    db.prepare(`INSERT INTO comm_lista_membros (listaId, pessoaId, destinoManual, nomeManual, ramo)
      VALUES (?, ?, '5594991110003', 'LANCHE DO LEAD', ?)`).run(listaId, outro, RAMO_LANCHE);

    const tudo = await j(`/api/comm/listas/${listaId}`);
    const qtdNicho = Object.fromEntries((tudo.porNicho || []).map(x => [x.nichoFunilId, x.n]));
    const qtdSeg = Object.fromEntries((tudo.porSegmento || []).map(x => [x.segmentoId, x.n]));
    assert(tudo.total === 2 && qtdNicho[4] === 1 && qtdNicho[6] === 1, JSON.stringify(tudo.porNicho));
    assert(qtdSeg[segId('Bebidas')] === 1, JSON.stringify(tudo.porSegmento));
    assert(tudo.membros[0].nichoFunilId && tudo.membros[0].segmentoId, 'o membro veio sem um dos dois');

    const soNicho = await j(`/api/comm/listas/${listaId}?nicho=4`);
    assert(soNicho.total === 1 && soNicho.membros[0].nome === 'ADEGA DO LEAD', JSON.stringify(soNicho.membros));
    const soSeg = await j(`/api/comm/listas/${listaId}?segmento=${segId('Alimentação')}`);
    assert(soSeg.total === 1 && soSeg.membros[0].nome === 'LANCHE DO LEAD', JSON.stringify(soSeg.membros));
    // Os dois juntos recortam o cruzamento, e aqui ele é vazio.
    const cruz = await j(`/api/comm/listas/${listaId}?nicho=4&segmento=${segId('Alimentação')}`);
    assert(cruz.total === 0, 'cruzamento: ' + JSON.stringify(cruz.membros));

    // A sabotagem: trocado o nicho da ficha por fora, a contagem tem de seguir.
    db.prepare('UPDATE pessoas SET nichoFunilId = 13 WHERE id = ?').run(leadId);
    const depois = await j(`/api/comm/listas/${listaId}`);
    const q2 = Object.fromEntries((depois.porNicho || []).map(x => [x.nichoFunilId, x.n]));
    assert(q2[13] === 1 && q2[4] === undefined, 'a contagem não seguiu: ' + JSON.stringify(depois.porNicho));
    db.prepare('UPDATE pessoas SET nichoFunilId = 4 WHERE id = ?').run(leadId);
  });

  await t('N6 o PUT do membro grava um sem apagar o outro, e recusa nicho que não vale', async () => {
    const r = await j('/api/comm/listas/membros/' + membroDoLead,
      { method: 'PUT', body: JSON.stringify({ nichoFunilId: 6 }) });
    assert(r.success && nichoDaPessoa(leadId) === 6, 'não gravou o nicho');
    assert(segDaPessoa(leadId) === segId('Bebidas'), 'gravar o nicho apagou o segmento');
    const r2 = await j('/api/comm/listas/membros/' + membroDoLead,
      { method: 'PUT', body: JSON.stringify({ segmentoId: segId('Mercado') }) });
    assert(r2.success && segDaPessoa(leadId) === segId('Mercado'), 'não gravou o segmento');
    assert(nichoDaPessoa(leadId) === 6, 'gravar o segmento apagou o nicho');
    const fechado = await j('/api/comm/listas/membros/' + membroDoLead,
      { method: 'PUT', body: JSON.stringify({ nichoFunilId: 3 }) });
    assert(!fechado.success, 'aceitou funil fechado');
    const vazio = await j('/api/comm/listas/membros/' + membroDoLead, { method: 'PUT', body: JSON.stringify({}) });
    assert(!vazio.success, 'aceitou PUT sem campo nenhum');
  });

  await t('N6b o contato avulso ganha ficha com o nicho que se escolheu', async () => {
    const av = Number(db.prepare(`INSERT INTO comm_lista_membros (listaId, destinoManual, nomeManual)
      VALUES (?, '5594991110020', 'AVULSO DO NICHO')`).run(listaId).lastInsertRowid);
    const r = await j('/api/comm/listas/membros/' + av, { method: 'PUT', body: JSON.stringify({ nichoFunilId: 8 }) });
    assert(r.success && r.pessoaId, JSON.stringify(r));
    assert(nichoDaPessoa(r.pessoaId) === 8, 'a ficha nova nasceu sem o nicho');
  });

  await t('N7 a ficha da pessoa grava o nicho e recusa funil fechado ou inexistente', async () => {
    const p = pessoa({ razaoSocial: 'CLIENTE DA FICHA', categorias: '["cliente"]' });
    const atual = await j('/api/pessoas/' + p);
    const corpo = { ...atual.pessoa, nichoFunilId: 6, segmentoId: segId('Atacado') };
    const r = await j('/api/pessoas/' + p, { method: 'PUT', body: JSON.stringify(corpo) });
    assert(r.success, 'não salvou: ' + r.error);
    assert(nichoDaPessoa(p) === 6 && segDaPessoa(p) === segId('Atacado'), 'não gravou os dois');
    const fechado = await j('/api/pessoas/' + p, { method: 'PUT', body: JSON.stringify({ ...corpo, nichoFunilId: 3 }) });
    assert(!fechado.success && /[Nn]icho/.test(fechado.error || ''), 'aceitou funil fechado: ' + JSON.stringify(fechado));
    const inexistente = await j('/api/pessoas/' + p, { method: 'PUT', body: JSON.stringify({ ...corpo, nichoFunilId: 999 }) });
    assert(!inexistente.success, 'aceitou nicho inexistente');
    const lista = await j('/api/pessoas/nichos');
    assert(lista.success && lista.nichos.length === 4, 'a rota do cadastro: ' + JSON.stringify(lista).slice(0, 120));
  });

  await t('N8 a planilha dá ao lead novo o segmento pelas palavras e o nicho pelo mapa', async () => {
    const l2 = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('planilha nicho')").run().lastInsertRowid);
    const XLSX = require(path.join(__dirname, '..', 'node_modules', 'xlsx'));
    const ws = XLSX.utils.aoa_to_sheet([
      ['Telefone', 'Nome', 'Segmento', 'Ramo'],
      ['94991110030', 'ADEGA NOVA', '', RAMO_BEBIDA],
      ['94991110031', 'LANCHE NOVO', '', '"Lanchonetes'],
      ['94991110032', 'FOGUETES', '', 'Oficina de foguetes'],
    ]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'a');
    const fd = new FormData();
    fd.append('arquivo', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'c.xlsx');
    const r = await j(`/api/comm/listas/${l2}/importar`, { method: 'POST', body: fd });
    assert(r.success && r.adicionados === 3, JSON.stringify(r));
    const fichas = Object.fromEntries(db.prepare(`SELECT p.razaoSocial n, p.segmentoId s, p.nichoFunilId f
      FROM comm_lista_membros m JOIN pessoas p ON p.id = m.pessoaId WHERE m.listaId = ?`).all(l2)
      .map(x => [x.n, x]));
    assert(fichas['ADEGA NOVA'].s === segId('Bebidas'), 'segmento pelas palavras do ramo');
    assert(fichas['ADEGA NOVA'].f === 4, 'nicho pelo ramo: ' + JSON.stringify(fichas['ADEGA NOVA']));
    assert(fichas['LANCHE NOVO'].f === 6, 'nicho pelo ramo truncado: ' + JSON.stringify(fichas['LANCHE NOVO']));
    assert(fichas['FOGUETES'].f === 13, 'ramo desconhecido devia ir ao padrão: ' + JSON.stringify(fichas['FOGUETES']));
    assert(fichas['FOGUETES'].s === segId('Genérico'), 'segmento sem casar devia ir ao Genérico (L)');
  });

  await t('N9 o cadastro que a tela oferece para adicionar recorta por nicho', async () => {
    const todos = await j('/api/conversas/publico');
    const soNicho = await j('/api/conversas/publico?nicho=6');
    assert(todos.total > soNicho.total, `todos ${todos.total}, nicho ${soNicho.total}`);
    assert(soNicho.pessoas.every(p => p.nichoFunilId === 6), 'veio quem não é do nicho');
    assert(soNicho.pessoas.length > 0, 'o recorte por nicho veio vazio');
  });

  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
});
