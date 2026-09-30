/**
 * A mesma campanha enviada mais de uma vez: rodadas (decisão de 28/09/2026).
 *
 * Até então uma campanha enviada só podia ser duplicada. O "Enviar de novo"
 * abre a rodada seguinte na MESMA campanha: a lista inteira recebe outra vez,
 * inclusive quem já recebeu, e as rodadas anteriores ficam nos envios.
 *
 * O que esta suíte prova, e por que cada prova reprovaria sem o código:
 *
 *  R1-R2  a rodada 2 reenvia para todos pelo WhatsApp. Sem o filtro por
 *         rodada no preparo, o disparo veria os envios da rodada 1, não
 *         prepararia nada e terminaria sem mandar mensagem.
 *  R3     a rodada 1 continua intacta e os totais da campanha são os da 2.
 *  R4     pausar e retomar a rodada 2 não prepara a lista de novo.
 *  R5     "Ver envios" mostra uma rodada por vez e o resumo de todas.
 *  R6     rodada nova só abre em campanha que terminou.
 *  R7     o e-mail segue a mesma regra.
 *  R8     envio gravado antes da coluna existir é da rodada 1.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// O que sai do servidor fica anotado aqui, e nada sai de verdade.
const saidas = [];
require.cache[require.resolve('../whatsapp-adapter')] = { exports: {
  enviarWhatsApp: async (_db, o) => { saidas.push({ canal: 'whatsapp', para: o.telefone, texto: o.texto }); return { success: true }; },
  enviarWhatsAppMidia: async () => ({ success: false, error: 'sem mídia no teste' }),
  loadProviderConfig: () => ({ provider: 'evolution', instance: 'teste' }),
  checarRitmo: () => ({ ok: true }),
} };
require.cache[require.resolve('../email-client')] = { exports: {
  loadSmtpConfig: () => ({ user: 'teste@exemplo.com.br' }),
  enviarEmailSimples: async (_db, o) => { saidas.push({ canal: 'email', para: o.to, texto: o.texto }); return { success: true }; },
} };
require.cache[require.resolve('../audit-log')] = { exports: { logAction: () => {} } };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rodadas-'));
const db = new Database(path.join(dir, 'pncp.db'));
const schema = require('./schema-de-tenant').lerSchema();
db.exec(schema);
db.pragma('foreign_keys = OFF');

// R8: um envio gravado antes de a coluna existir. Em tenant ainda sem a
// migração, o schema não tem `rodada`; no que já tem, vale o default.
db.exec("INSERT INTO comm_templates (id, nome, canal, corpo) VALUES (900, 'antigo', 'email', 'x')");
db.exec("INSERT INTO comm_listas (id, nome) VALUES (900, 'antiga')");
db.exec("INSERT INTO comm_campanhas (id, nome, templateId, listaId, canal, status) VALUES (900, 'antiga', 900, 900, 'email', 'enviada')");
db.exec("INSERT INTO comm_envios (campanhaId, canal, destino, status) VALUES (900, 'email', 'a@exemplo.com.br', 'enviado')");

const express = require('express');
const app = express();
app.use(express.json());
const comm = require('../comm-routes');
comm.registrarRotasComm(app, db);
require('../whatsapp-canais').migrarCanais(db);

let ok = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};

function call(m, p, body = {}, params = {}, query = {}) {
  let h = null;
  for (const c of app.router.stack) {
    if (c.route && c.route.path === p && c.route.methods[m]) h = c.route.stack[c.route.stack.length - 1].handle;
  }
  if (!h) throw new Error('rota não encontrada: ' + m + ' ' + p);
  return new Promise((resolve) => {
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; },
      json(j) { resolve({ status: this.statusCode, body: j }); return this; } };
    Promise.resolve(h({ body, params, query, user: { username: 't' }, session: { username: 't' },
      tenantCtx: { slug: 'teste-rodadas' }, tenantDb: db }, res, () => {})).catch((e) => resolve({ status: 500, body: { error: e.message } }));
  });
}

// ---------- fixture ----------
db.exec("DELETE FROM whatsapp_canais");
db.exec(`INSERT INTO whatsapp_canais (id, nome, instance, padrao, ativo, config)
  VALUES (1, 'principal', 'le_teste_1', 1, 1, '{}')`);
// A janela de 8h às 20h vale a cada envio desde 29/09: desligada aqui, senão
// a suíte, rodada à noite no verify, ficaria esperando o horário abrir.
db.exec("DELETE FROM config WHERE chave IN ('whatsapp_throttle_min','whatsapp_throttle_max','whatsapp_daily_limit','comm_janela_ativa')");
db.exec(`INSERT INTO config (chave, valor) VALUES ('whatsapp_throttle_min','1'), ('whatsapp_throttle_max','1'),
  ('whatsapp_daily_limit','100'), ('comm_janela_ativa','0')`);
const pessoa = (nome, tel, email) => Number(db.prepare(`INSERT INTO pessoas
  (cpfCnpj, razaoSocial, telefone, email, aceitaWhatsappMarketing, aceitaEmailMarketing)
  VALUES (?, ?, ?, ?, 1, 1)`).run('SD-' + nome, nome, tel, email).lastInsertRowid);
const ana = pessoa('ANA', '94991110001', 'ana@exemplo.com.br');
const bia = pessoa('BIA', '94991110002', 'bia@exemplo.com.br');
const lista = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('rodadas')").run().lastInsertRowid);
for (const p of [ana, bia]) db.prepare('INSERT INTO comm_lista_membros (listaId, pessoaId) VALUES (?, ?)').run(lista, p);
const tplWa = Number(db.prepare("INSERT INTO comm_templates (nome, canal, corpo) VALUES ('wa', 'whatsapp', 'Oi {{primeiroNome}}')").run().lastInsertRowid);
const tplEm = Number(db.prepare("INSERT INTO comm_templates (nome, canal, assunto, corpo) VALUES ('em', 'email', 'Oi', 'Olá {{razaoSocial}}')").run().lastInsertRowid);

const esperar = async (id) => {
  for (let i = 0; i < 60; i++) {
    const s = db.prepare('SELECT status FROM comm_campanhas WHERE id = ?').get(id).status;
    if (s !== 'enviando') return s;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('a campanha não terminou em 15 s');
};
const envios = (id, rodada) => db.prepare(`SELECT status, COUNT(*) n FROM comm_envios
  WHERE campanhaId = ? AND rodada = ? GROUP BY status`).all(id, rodada).reduce((o, r) => (o[r.status] = r.n, o), {});

(async () => {
  let camp;

  await t('R1 a rodada 1 manda para os dois da lista pelo WhatsApp', async () => {
    const c = await call('post', '/api/comm/campanhas', { nome: 'mensal', templateId: tplWa, listaId: lista, tipo: 'marketing' });
    assert(c.body.success, c.body.error);
    camp = c.body.campanha.id;
    const r = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id: camp });
    assert(r.body.success, r.body.error);
    assert(await esperar(camp) === 'enviada', 'status ' + db.prepare('SELECT status FROM comm_campanhas WHERE id=?').get(camp).status);
    assert(saidas.filter(s => s.canal === 'whatsapp').length === 2, 'saídas: ' + JSON.stringify(saidas));
    assert(envios(camp, 1).enviado === 2, JSON.stringify(envios(camp, 1)));
  });

  await t('R6 campanha enviada não dispara de novo sem abrir a rodada', async () => {
    const r = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id: camp });
    assert(!r.body.success, 'executou campanha enviada');
  });

  await t('R2 a rodada 2 manda de novo para os dois, inclusive quem já recebeu', async () => {
    const n = await call('post', '/api/comm/campanhas/:id/nova-rodada', {}, { id: camp });
    assert(n.body.success, n.body.error);
    assert(n.body.campanha.rodada === 2 && n.body.campanha.status === 'rascunho', JSON.stringify(n.body.campanha));
    assert(n.body.campanha.totalEnviados === 0 && n.body.campanha.totalDestinatarios === 2, 'totais: ' + JSON.stringify(n.body.campanha));
    saidas.length = 0;
    const r = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id: camp });
    assert(r.body.success, r.body.error);
    assert(await esperar(camp) === 'enviada', 'não terminou enviada');
    const para = saidas.map(s => s.para).sort().join(',');
    assert(para === '5594991110001,5594991110002', 'saíram: ' + para);
  });

  await t('R3 a rodada 1 fica como estava, e os totais da campanha são os da 2', () => {
    assert(envios(camp, 1).enviado === 2 && envios(camp, 2).enviado === 2, JSON.stringify([envios(camp, 1), envios(camp, 2)]));
    const c = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(camp);
    assert(c.totalEnviados === 2 && c.rodada === 2, JSON.stringify(c));
  });

  await t('R4 pausar e retomar a rodada não prepara a lista de novo', async () => {
    const n = await call('post', '/api/comm/campanhas/:id/nova-rodada', {}, { id: camp });
    assert(n.body.success, n.body.error);
    db.prepare("UPDATE comm_campanhas SET status = 'pausada' WHERE id = ?").run(camp);
    // Uma rodada preparada pela metade: uma linha pendente e nenhuma outra.
    db.prepare(`INSERT INTO comm_envios (campanhaId, pessoaId, canal, destino, mensagemRenderizada, status, rodada)
      VALUES (?, ?, 'whatsapp', '5594991110001', 'Oi ANA', 'pendente', 3)`).run(camp, ana);
    saidas.length = 0;
    const r = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id: camp });
    assert(r.body.success, r.body.error);
    await esperar(camp);
    assert(saidas.length === 1, 'saíram ' + saidas.length + ', a lista foi preparada de novo');
    assert(db.prepare('SELECT COUNT(*) n FROM comm_envios WHERE campanhaId = ? AND rodada = 3').get(camp).n === 1, 'rodada 3 ganhou linhas');
  });

  await t('R5 Ver envios mostra uma rodada por vez e o resumo de todas', async () => {
    const atual = await call('get', '/api/comm/campanhas/:id', {}, { id: camp }, {});
    assert(atual.body.success, atual.body.error);
    assert(atual.body.rodada === 3 && atual.body.envios.length === 1, 'atual: ' + atual.body.rodada + '/' + atual.body.envios.length);
    assert(atual.body.rodadas.map(r => r.rodada).join(',') === '1,2,3', JSON.stringify(atual.body.rodadas));
    const um = await call('get', '/api/comm/campanhas/:id', {}, { id: camp }, { rodada: '1' });
    assert(um.body.envios.length === 2 && um.body.envios.every(e => e.rodada === 1), 'rodada 1: ' + um.body.envios.length);
  });

  await t('R6 rodada nova é recusada em rascunho', async () => {
    const c = await call('post', '/api/comm/campanhas', { nome: 'nova', templateId: tplWa, listaId: lista });
    const n = await call('post', '/api/comm/campanhas/:id/nova-rodada', {}, { id: c.body.campanha.id });
    assert(!n.body.success && n.status === 400, 'abriu rodada em rascunho');
  });

  await t('R7 o e-mail também reenvia na rodada 2', async () => {
    const c = await call('post', '/api/comm/campanhas', { nome: 'email', templateId: tplEm, listaId: lista, tipo: 'marketing' });
    const id = c.body.campanha.id;
    saidas.length = 0;
    const r1 = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id });
    assert(r1.body.success && r1.body.enviados === 2, JSON.stringify(r1.body));
    await call('post', '/api/comm/campanhas/:id/nova-rodada', {}, { id });
    const r2 = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id });
    assert(r2.body.success && r2.body.enviados === 2, 'rodada 2: ' + JSON.stringify(r2.body));
    assert(saidas.length === 4, 'saídas ' + saidas.length);
  });

  await t('R8 envio anterior à coluna é da rodada 1, e a migração roda duas vezes', () => {
    require('../comm-destinos').migrarRodadas(db);
    const r = db.prepare('SELECT rodada FROM comm_envios WHERE campanhaId = 900').get();
    assert(r && r.rodada === 1, JSON.stringify(r));
    assert(db.prepare('SELECT rodada FROM comm_campanhas WHERE id = 900').get().rodada === 1, 'campanha antiga');
  });

  await t('R9 a cópia de uma campanha nasce na rodada 1', async () => {
    const d = await call('post', '/api/comm/campanhas/:id/duplicar', {}, { id: camp });
    assert(d.body.success && d.body.campanha.rodada === 1, JSON.stringify(d.body.campanha));
  });

  await t('R11 pausar durante o envio termina pausada, e cancelar termina cancelada', async () => {
    // Três contatos e 1 s entre envios: dá tempo de pausar com o motor rodando.
    const extra = [pessoa('CAIO', '94991110003', 'caio@exemplo.com.br'), pessoa('DUDA', '94991110004', 'duda@exemplo.com.br')];
    const l2 = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('pausa')").run().lastInsertRowid);
    for (const p of [ana, bia, ...extra]) db.prepare('INSERT INTO comm_lista_membros (listaId, pessoaId) VALUES (?, ?)').run(l2, p);
    for (const [acao, esperado] of [['pausar', 'pausada'], ['cancelar', 'cancelada']]) {
      const c = await call('post', '/api/comm/campanhas', { nome: acao, templateId: tplWa, listaId: l2, tipo: 'marketing' });
      const id = c.body.campanha.id;
      await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id });
      await new Promise(r => setTimeout(r, 300));
      const r = await call('post', `/api/comm/campanhas/:id/${acao}`, {}, { id });
      assert(r.body.success, acao + ': ' + JSON.stringify(r.body));
      // A rota grava o status na hora; o motor só sai do laço depois do
      // intervalo em curso (1 s aqui) e grava o dele por cima. É esse o que vale.
      await new Promise(r => setTimeout(r, 2500));
      const fim = db.prepare('SELECT status FROM comm_campanhas WHERE id = ?').get(id).status;
      assert(fim === esperado, `${acao} terminou ${fim}`);
    }
  });

  await t('R12 o modelo editado com a campanha pausada vale para quem ainda nao recebeu', async () => {
    const tpl = Number(db.prepare("INSERT INTO comm_templates (nome, canal, corpo) VALUES ('r12', 'whatsapp', 'Texto antigo')").run().lastInsertRowid);
    const c = await call('post', '/api/comm/campanhas', { nome: 'r12', templateId: tpl, listaId: lista, tipo: 'marketing' });
    const id = c.body.campanha.id;
    // Preparada e pausada antes de enviar: é o estado da campanha 3 do 1bit.
    db.prepare(`INSERT INTO comm_envios (campanhaId, pessoaId, canal, destino, mensagemRenderizada, status, rodada)
      VALUES (?, ?, 'whatsapp', '5594991110001', 'Texto antigo', 'pendente', 1)`).run(id, ana);
    db.prepare("UPDATE comm_campanhas SET status = 'pausada' WHERE id = ?").run(id);
    db.prepare("UPDATE comm_templates SET corpo = 'Olá {{primeiroNome}}, texto novo' WHERE id = ?").run(tpl);
    saidas.length = 0;
    await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id });
    await esperar(id);
    assert(saidas.length === 1 && saidas[0].texto === 'Olá ANA, texto novo', 'saiu: ' + JSON.stringify(saidas));
    const gravado = db.prepare('SELECT mensagemRenderizada m FROM comm_envios WHERE campanhaId = ?').get(id).m;
    assert(gravado === 'Olá ANA, texto novo', 'o envio guardou: ' + gravado);
  });

  await t('R13 a campanha pausada edita nome, modelo e numeros, e nao a lista, o tipo e o segmento', async () => {
    const tpl2 = Number(db.prepare("INSERT INTO comm_templates (nome, canal, corpo) VALUES ('r13', 'whatsapp', 'Outro')").run().lastInsertRowid);
    const c = await call('post', '/api/comm/campanhas', { nome: 'r13', templateId: tplWa, listaId: lista, tipo: 'marketing' });
    const id = c.body.campanha.id;
    db.prepare("UPDATE comm_campanhas SET status = 'pausada', totalDestinatarios = 7 WHERE id = ?").run(id);
    const ok = await call('put', '/api/comm/campanhas/:id', { nome: 'r13 novo nome', templateId: tpl2, listaId: lista, tipo: 'marketing' }, { id });
    assert(ok.body.success, ok.body.error);
    const depois = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(id);
    assert(depois.status === 'pausada' && depois.nome === 'r13 novo nome' && depois.templateId === tpl2 && depois.totalDestinatarios === 7,
      JSON.stringify({ s: depois.status, n: depois.nome, t: depois.templateId, tot: depois.totalDestinatarios }));
    const outraLista = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('r13 outra')").run().lastInsertRowid);
    for (const [corpo, nome] of [[{ listaId: outraLista }, 'lista'], [{ tipo: 'operacional' }, 'tipo'], [{ segmentos: [1] }, 'segmento'],
                                 [{ templateId: tplEm }, 'modelo de e-mail']]) {
      const r = await call('put', '/api/comm/campanhas/:id', corpo, { id });
      assert(!r.body.success && r.status === 400, nome + ' mudou com a campanha pausada');
    }
  });

  await t('R14 o e-mail tambem sai com o modelo como ele esta na hora', async () => {
    const tpl = Number(db.prepare("INSERT INTO comm_templates (nome, canal, assunto, corpo) VALUES ('r14', 'email', 'Assunto velho', 'Corpo velho')").run().lastInsertRowid);
    const c = await call('post', '/api/comm/campanhas', { nome: 'r14', templateId: tpl, listaId: lista, tipo: 'marketing' });
    const id = c.body.campanha.id;
    db.prepare(`INSERT INTO comm_envios (campanhaId, pessoaId, canal, destino, mensagemRenderizada, assuntoRenderizado, status, rodada)
      VALUES (?, ?, 'email', 'ana@exemplo.com.br', 'Corpo velho', 'Assunto velho', 'pendente', 1)`).run(id, ana);
    db.prepare("UPDATE comm_campanhas SET status = 'pausada' WHERE id = ?").run(id);
    db.prepare("UPDATE comm_templates SET corpo = 'Olá {{razaoSocial}}, corpo novo' WHERE id = ?").run(tpl);
    saidas.length = 0;
    const r = await call('post', '/api/comm/campanhas/:id/executar', { ignorarJanela: true }, { id });
    assert(r.body.success && saidas.length === 1 && saidas[0].texto === 'Olá ANA, corpo novo', JSON.stringify({ r: r.body, saidas }));
  });

  await t('R15 campanha que ficou enviando depois de um restart volta no proximo tique', async () => {
    const c = await call('post', '/api/comm/campanhas', { nome: 'r15', templateId: tplWa, listaId: lista, tipo: 'marketing' });
    const id = c.body.campanha.id;
    // O estado que o restart deixa: 'enviando', com pendente preparado e
    // nenhum laço vivo neste processo.
    db.prepare(`INSERT INTO comm_envios (campanhaId, pessoaId, canal, destino, mensagemRenderizada, status, rodada)
      VALUES (?, ?, 'whatsapp', '5594991110002', 'x', 'pendente', 1)`).run(id, bia);
    db.prepare("UPDATE comm_campanhas SET status = 'enviando' WHERE id = ?").run(id);
    db.prepare("DELETE FROM config WHERE chave = 'whatsapp_enabled'").run();
    db.prepare("INSERT INTO config (chave, valor) VALUES ('whatsapp_enabled', '1')").run();
    saidas.length = 0;
    require('../wa-scheduler').tick({ listAll: () => [{ slug: 'teste-rodadas' }], getDb: () => db });
    const fim = await esperar(id);
    assert(fim === 'enviada' && saidas.length === 1 && saidas[0].para === '5594991110002', `${fim} ${JSON.stringify(saidas)}`);
    const n = db.prepare('SELECT COUNT(*) n FROM comm_envios WHERE campanhaId = ?').get(id).n;
    assert(n === 1, `a lista foi preparada de novo: ${n} envios`);
  });

  // ---------- ritmo e horário da campanha nova (29/09) ----------
  const { momento } = require('../atendimento-horario');
  const OUTRO_DIA = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].find(d => d !== momento().dia);
  const listaDe = (nome, pessoas) => {
    const l = Number(db.prepare('INSERT INTO comm_listas (nome) VALUES (?)').run(nome).lastInsertRowid);
    for (const p of pessoas) db.prepare('INSERT INTO comm_lista_membros (listaId, pessoaId) VALUES (?, ?)').run(l, p);
    return l;
  };
  const esperarMotor = () => new Promise(r => setTimeout(r, 2500));

  await t('R16 o ritmo e gravado, o invalido e recusado, e a pausada muda o ritmo', async () => {
    const ok = await call('post', '/api/comm/campanhas', { nome: 'r16', templateId: tplWa, listaId: lista, tipo: 'marketing',
      ritmo: { limiteDia: '50', intervaloMin: '60', intervaloMax: '90', horario: { inicio: '09:00', fim: '18:00', dias: ['seg', 'ter'] } } });
    assert(ok.body.success, ok.body.error);
    const r = JSON.parse(ok.body.campanha.ritmo);
    assert(r.limiteDia === 50 && r.intervaloMin === 60 && r.horario.inicio === '09:00' && r.horario.dias.join() === 'seg,ter', ok.body.campanha.ritmo);
    for (const [ritmo, nome] of [[{ limiteDia: 0 }, 'limite 0'], [{ horario: { inicio: '09:00', fim: '09:00' } }, 'início igual ao fim'],
                                 [{ intervaloMin: 'x' }, 'intervalo não numérico']]) {
      const ruim = await call('post', '/api/comm/campanhas', { nome: 'r16 ruim', templateId: tplWa, listaId: lista, ritmo });
      assert(!ruim.body.success, nome + ' foi aceito');
    }
    db.prepare("UPDATE comm_campanhas SET status = 'pausada' WHERE id = ?").run(ok.body.campanha.id);
    const put = await call('put', '/api/comm/campanhas/:id', { ritmo: { limiteDia: 5 } }, { id: ok.body.campanha.id });
    assert(put.body.success && JSON.parse(put.body.campanha.ritmo).limiteDia === 5 && put.body.campanha.status === 'pausada', JSON.stringify(put.body));
  });

  await t('R17 fora do horario da campanha o motor espera sem enviar, e diz quando comeca', async () => {
    const l = listaDe('r17', [ana]);
    const c = await call('post', '/api/comm/campanhas', { nome: 'r17', templateId: tplWa, listaId: l, tipo: 'marketing',
      ritmo: { horario: { inicio: '00:00', fim: '23:59', dias: [OUTRO_DIA] } } });
    const id = c.body.campanha.id;
    saidas.length = 0;
    const r = await call('post', '/api/comm/campanhas/:id/executar', {}, { id });
    assert(r.body.success && /fora do horário/.test(r.body.aguarda || ''), JSON.stringify(r.body));
    await esperarMotor();
    const st = db.prepare('SELECT status FROM comm_campanhas WHERE id = ?').get(id).status;
    assert(saidas.length === 0 && st === 'enviando', `saíram ${saidas.length}, status ${st}`);
    await call('post', '/api/comm/campanhas/:id/pausar', {}, { id });   // desliga o motor
  });

  await t('R18 com o limite do dia da campanha cumprido, o motor espera', async () => {
    const l = listaDe('r18', [ana, bia]);
    const c = await call('post', '/api/comm/campanhas', { nome: 'r18', templateId: tplWa, listaId: l, tipo: 'marketing',
      ritmo: { limiteDia: 1 } });
    const id = c.body.campanha.id;
    saidas.length = 0;
    await call('post', '/api/comm/campanhas/:id/executar', {}, { id });
    await esperarMotor();
    const st = db.prepare('SELECT status FROM comm_campanhas WHERE id = ?').get(id).status;
    assert(saidas.length === 1 && st === 'enviando', `saíram ${saidas.length}, status ${st}`);
    await call('post', '/api/comm/campanhas/:id/pausar', {}, { id });
  });

  // 30/09: "já está enviando" ao reenviar uma campanha que já tinha terminado.
  // O laço dormia o intervalo do ritmo (45 a 120 s) num sono que ignorava a
  // pausa, e pagava esse sono mesmo com a fila vazia. Enquanto ele não saía, a
  // chave em memória segurava o disparo seguinte (campanha 5 do 1bit).
  await t('R20 com a fila vazia o motor encerra na hora, sem pagar o intervalo', async () => {
    const l = listaDe('r20', [ana]);
    const c = await call('post', '/api/comm/campanhas', { nome: 'r20', templateId: tplWa, listaId: l, tipo: 'marketing',
      ritmo: { intervaloMin: 90, intervaloMax: 90 } });   // intervalo longo de propósito
    const id = c.body.campanha.id;
    saidas.length = 0;
    await call('post', '/api/comm/campanhas/:id/executar', {}, { id });
    await esperarMotor();                                  // 2,5 s: bem menos que os 90
    const st = db.prepare('SELECT status FROM comm_campanhas WHERE id = ?').get(id).status;
    assert(saidas.length === 1 && st === 'enviada', `saíram ${saidas.length}, status ${st}`);
    // E o disparo seguinte não é recusado: a campanha já largou a memória.
    const r = await call('post', '/api/comm/campanhas/:id/nova-rodada', {}, { id });
    assert(r.body.success, 'nova rodada recusada: ' + JSON.stringify(r.body));
    const ex = await call('post', '/api/comm/campanhas/:id/executar', {}, { id });
    assert(ex.status !== 409, 'o reenvio foi recusado com "já está enviando": ' + JSON.stringify(ex.body));
    await call('post', '/api/comm/campanhas/:id/pausar', {}, { id });
  });

  await t('R21 a pausa interrompe a espera do intervalo em poucos segundos', async () => {
    const l = listaDe('r21', [ana, bia]);
    const c = await call('post', '/api/comm/campanhas', { nome: 'r21', templateId: tplWa, listaId: l, tipo: 'marketing',
      ritmo: { intervaloMin: 90, intervaloMax: 90 } });
    const id = c.body.campanha.id;
    saidas.length = 0;
    await call('post', '/api/comm/campanhas/:id/executar', {}, { id });
    await new Promise(r => setTimeout(r, 1200));           // o 1º saiu; o laço está na espera
    assert(saidas.length === 1, `saíram ${saidas.length} antes da pausa`);
    await call('post', '/api/comm/campanhas/:id/pausar', {}, { id });
    await new Promise(r => setTimeout(r, 2500));           // o sono antigo era de 90 s
    const st = db.prepare('SELECT status FROM comm_campanhas WHERE id = ?').get(id).status;
    assert(st === 'pausada', `o laço não largou a campanha: status ${st}`);
    const ex = await call('post', '/api/comm/campanhas/:id/executar', {}, { id });
    assert(ex.status !== 409, 'retomar ainda é recusado: ' + JSON.stringify(ex.body));
    await call('post', '/api/comm/campanhas/:id/pausar', {}, { id });
  });

  // 30/09, a pedido: a campanha que já saiu volta a ser editável. As "(cópia)"
  // do 1bit ficavam em 'enviada' e a rota recusava a edição, então mudar uma
  // palavra obrigava a duplicar a campanha outra vez.
  await t('R19 a campanha enviada e editada por inteiro, sem perder o status nem o que foi enviado', async () => {
    const c = await call('post', '/api/comm/campanhas', { nome: 'r19', templateId: tplWa, listaId: lista, tipo: 'marketing' });
    const id = c.body.campanha.id;
    db.prepare(`INSERT INTO comm_envios (campanhaId, pessoaId, canal, destino, mensagemRenderizada, status, rodada)
      VALUES (?, ?, 'whatsapp', '5594999990019', 'texto que saiu', 'enviado', 1)`).run(id, ana);
    db.prepare("UPDATE comm_campanhas SET status = 'enviada', rodada = 1 WHERE id = ?").run(id);

    const tpl2 = Number(db.prepare("INSERT INTO comm_templates (nome, canal, corpo) VALUES ('r19b', 'whatsapp', 'Novo')").run().lastInsertRowid);
    const outraLista = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('r19 outra')").run().lastInsertRowid);
    const r = await call('put', '/api/comm/campanhas/:id',
      { nome: 'r19 editada', templateId: tpl2, listaId: outraLista, tipo: 'operacional' }, { id });
    assert(r.body.success, 'a enviada não pôde ser editada: ' + r.body.error);

    const d = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(id);
    assert(d.status === 'enviada', `o status virou "${d.status}" — a tela trocaria "Enviar de novo" por "Enviar"`);
    assert(d.nome === 'r19 editada' && d.templateId === tpl2 && d.listaId === outraLista && d.tipo === 'operacional',
      JSON.stringify({ n: d.nome, t: d.templateId, l: d.listaId, tp: d.tipo }));
    // O que já saiu fica como saiu: é o histórico da rodada 1.
    const env = db.prepare('SELECT mensagemRenderizada, status FROM comm_envios WHERE campanhaId = ? AND rodada = 1').get(id);
    assert(env.mensagemRenderizada === 'texto que saiu' && env.status === 'enviado', JSON.stringify(env));

    // Cancelada também, e pelo mesmo motivo.
    db.prepare("UPDATE comm_campanhas SET status = 'cancelada' WHERE id = ?").run(id);
    const rc = await call('put', '/api/comm/campanhas/:id', { nome: 'r19 cancelada' }, { id });
    assert(rc.body.success && db.prepare('SELECT status FROM comm_campanhas WHERE id = ?').get(id).status === 'cancelada',
      JSON.stringify(rc.body));

    // Enviando continua recusada: o motor está lendo essas linhas agora.
    db.prepare("UPDATE comm_campanhas SET status = 'enviando' WHERE id = ?").run(id);
    const re = await call('put', '/api/comm/campanhas/:id', { nome: 'r19 no meio' }, { id });
    assert(!re.body.success && re.status === 400 && /[Pp]ause antes/.test(re.body.error || ''), JSON.stringify(re));
  });

  await t('R10 a página de campanhas não abre pop-up do navegador', () => {
    // Removidos a pedido em 29/09: o modal de envio já pergunta "agora ou
    // agendado", e cancelar fica atrás do menu ⋯.
    const tela = fs.readFileSync(path.join(__dirname, '..', 'public/comunicacao/campanhas.html'), 'utf8');
    const achados = tela.match(/(?<![\w.])(confirm|alert|prompt)\(/g) || [];
    assert(!achados.length, 'pop-up na página: ' + achados.join(', '));
  });

  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
