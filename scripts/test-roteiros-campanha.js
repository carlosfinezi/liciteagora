/**
 * Roteiro de qualificação por campanha (29/09/2026).
 *
 * Cada campanha, nova ou legado, escolhe o roteiro que a IA segue com quem
 * responder. O roteiro são etapas em ordem; uma resposta pode encerrar
 * (desqualificado) ou pular para uma etapa mais adiante. A IA marca as
 * respostas sozinha, com o trecho da conversa que as sustenta; no fim, o
 * qualificado vira oportunidade no CRM, e os dois resultados viram filtro em
 * Conversas.
 *
 *  Q1   estado: caminho, encerra, pula, corte; validar recusa pulo para trás
 *  Q2   qual roteiro vale: o da campanha mais recente recebida, nova ou legado;
 *       sem roteiro na campanha, nenhum (não há mais padrão da casa)
 *  Q3   a IA marca o que o lead disse; o inventado é recusado; não repergunta;
 *       sem fala do lead, não chama a IA
 *  Q4   resposta que encerra: desqualificado, e a IA recebe a ordem de encerrar
 *  Q5   fim com pontos: qualificado, oportunidade no funil escolhido, uma vez só
 *  Q6   o prompt do atendimento leva só a etapa atual
 *  Q7   editor: lista com campanhas e funis, cria, recusa pulo para trás,
 *       recusa remover roteiro em uso
 *  Q8   campanha legado e nova recusam roteiro que não existe, e gravam o que existe
 *  Q9   Conversas filtra e conta qualificados e desqualificados
 *  Q10  a migração desativa o roteiro presencial e é idempotente
 *  Q11  a tela: cria roteiro com duas etapas e a resposta que encerra; a
 *       campanha mostra e grava o roteiro escolhido (Chrome)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

require.cache[require.resolve('../audit-log')] = { exports: { logAction: () => {} } };

const RAIZ = path.join(__dirname, '..');
const R = require('../roteiros');
const RC = require('../roteiro-conversa');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roteiros-campanha-'));
const db = new Database(path.join(dir, 'pncp.db'));
db.exec(require('./schema-de-tenant').lerSchema());
db.pragma('foreign_keys = OFF');
require('../whatsapp-canais').migrarCanais(db);
for (const t of ['roteiros', 'roteiro_visitas', 'conv_conversas', 'conv_eventos', 'whatsapp_messages', 'wa_campanhas',
  'wa_campanha_dest', 'comm_campanhas', 'comm_envios', 'crm_oportunidades', 'crm_etapas', 'crm_funis', 'whatsapp_canais']) {
  try { db.exec(`DELETE FROM ${t}`); } catch (_) {}
}
db.prepare("INSERT INTO whatsapp_canais (id, nome, instance, padrao, config) VALUES (1, 'Principal', 'inst1', 1, '{}')").run();
db.exec("DELETE FROM config WHERE chave = 'gemini_api_key'");

// O roteiro presencial, como está nos tenants antes do boot.
db.prepare("INSERT INTO roteiros (id, nome, canal, corte, padrao, ativo, config) VALUES (50, 'Visita', 'visita', 2, 1, 1, ?)")
  .run(JSON.stringify({ corte: 2, perguntas: [] }));
RC.migrar(db);

// Dois funis: o roteiro escolhe o segundo, e a oportunidade tem de nascer nele.
db.exec(`INSERT INTO crm_funis (id, nome, ordem, ativo) VALUES (1, 'Vendas', 0, 1), (2, 'Leads WhatsApp', 1, 1);
  INSERT INTO crm_etapas (id, funilId, nome, ordem, tipo, ativo) VALUES
    (10, 1, 'Novo', 1, 'normal', 1), (20, 2, 'Ganho', 0, 'ganho', 1), (21, 2, 'Qualificado', 1, 'normal', 1);`);

// Três etapas. "nao" encerra; "grande" pula a etapa do porte; corte 3.
const CFG = {
  corte: 3, funilId: 2, valores: { trial: '14 dias', linkTrial: 'https://exemplo.test/trial.html' },
  proximoPasso: 'Mande {{linkTrial}} para o teste de {{trial}}.',
  conducao: ['Uma pergunta por mensagem.'],
  perguntas: [
    { chave: 'vende', texto: 'Sua empresa vende para órgão público?', opcoes: [
      { id: 'sim', rotulo: 'Vende', peso: 1 },
      { id: 'grande', rotulo: 'Vende muito', peso: 2, vaiPara: 'dor' },
      { id: 'nao', rotulo: 'Não tem interesse', peso: 0, encerra: true }] },
    { chave: 'porte', texto: 'Quantas pessoas trabalham com licitação?', opcoes: [
      { id: 'uma', rotulo: 'Uma', peso: 0 }, { id: 'varias', rotulo: 'Várias', peso: 1 }] },
    { chave: 'dor', texto: 'Como você acha os editais?', opcoes: [
      { id: 'mao', rotulo: 'Na mão', peso: 2, dor: 'garimpa os portais à mão' },
      { id: 'sistema', rotulo: 'Sistema', peso: 0 }] },
  ],
};
const insRoteiro = db.prepare("INSERT INTO roteiros (nome, canal, corte, padrao, ativo, config) VALUES (?, 'whatsapp', ?, 0, 1, ?)");
const rotA = Number(insRoteiro.run('Licitações', CFG.corte, JSON.stringify(CFG)).lastInsertRowid);
const rotB = Number(insRoteiro.run('Outro', 1, JSON.stringify({ ...CFG, perguntas: [CFG.perguntas[2]], corte: 1 })).lastInsertRowid);

const conversa = (id, tel, nome) => {
  db.prepare("INSERT INTO conv_conversas (id, canal, jid, telefone, nome, canalId) VALUES (?, 'whatsapp', ?, ?, ?, 1)")
    .run(id, tel + '@s.whatsapp.net', tel, nome);
  return db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(id);
};
const fala = (tel, deMim, texto, ts) => db.prepare(`INSERT INTO whatsapp_messages (instance, remote_jid, from_me, texto, timestamp)
  VALUES ('inst1', ?, ?, ?, ?)`).run(tel + '@s.whatsapp.net', deMim ? 1 : 0, texto, ts);

let ok = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};

const express = require('express');
const app = express();
app.use(express.json());
app.use((req, _r, n) => { req.user = { id: 1, username: 't' }; req.tenantDb = db; req.tenantCtx = { slug: 'teste-rot' }; n(); });
require('../financeiro-routes').registrarRotasFinanceiro(app, db);
require('../comm-routes').registrarRotasComm(app, db);
require('../conversas-routes').registrarRotasConversas(app, db);
require('../roteiros-routes').registrarRotasRoteiros(app, db);
app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
app.get('/api/whatsapp/canais', (_q, rs) => rs.json({ success: true, canais: [] }));
app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
app.get('/__wrapper/:pasta/:tela', (rq, rs) => rs.type('html').send(
  `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
  + `ipt></head><body style="margin:0"><iframe src="/${rq.params.pasta}/${rq.params.tela}.html${rq.url.includes('?') ? rq.url.slice(rq.url.indexOf('?')) : ''}"`
  + ' style="width:100vw;height:100vh;border:0;display:block"></iframe></body></html>'));
app.use(express.static(path.join(RAIZ, 'public')));

const srv = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + srv.address().port;
  const pedir = async (u, metodo = 'GET', corpo) => {
    const r = await fetch(base + u, { method: metodo, headers: { 'Content-Type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    return { status: r.status, corpo: await r.json().catch(() => ({})) };
  };

  await t('Q1 estado: caminho, encerra, pula e corte; validar recusa pulo para tras', () => {
    let e = R.estado(CFG, {});
    assert(!e.fim && e.etapa.chave === 'vende', 'começa pela primeira etapa');
    e = R.estado(CFG, { vende: 'sim' });
    assert(e.etapa.chave === 'porte', 'depois de "sim" vem a segunda');
    e = R.estado(CFG, { vende: 'grande' });
    assert(e.etapa.chave === 'dor' && e.caminho.join() === 'vende', '"grande" pula o porte: ' + JSON.stringify(e));
    e = R.estado(CFG, { vende: 'nao' });
    assert(e.fim && e.resultado === 'desqualificado', 'a resposta que encerra desqualifica');
    e = R.estado(CFG, { vende: 'grande', dor: 'mao' });
    assert(e.fim && e.resultado === 'qualificado' && e.pontos === 4, JSON.stringify(e));
    e = R.estado(CFG, { vende: 'sim', porte: 'uma', dor: 'sistema' });
    assert(e.fim && e.resultado === 'desqualificado' && e.pontos === 1, 'abaixo do corte: ' + JSON.stringify(e));
    const volta = JSON.parse(JSON.stringify(CFG));
    volta.perguntas[2].opcoes[0].vaiPara = 'vende';
    assert(R.validar(volta).some(p => /mais adiante/.test(p)), 'aceitou pulo para trás');
    volta.perguntas[2].opcoes[0].vaiPara = 'naoexiste';
    assert(R.validar(volta).some(p => /não existe/.test(p)), 'aceitou pulo para etapa inexistente');
  });

  const c1 = conversa(1, '5594991110001', 'Loja Um');
  db.prepare("INSERT INTO wa_campanhas (id, nome, config, status) VALUES (5, 'Legado', ?, 'concluida')").run(JSON.stringify({ roteiro_id: rotA }));
  db.prepare("INSERT INTO wa_campanha_dest (campanha_id, telefone, status, enviado_em) VALUES (5, '5594991110001', 'enviado', '2023-11-13T00:00:00.000Z')").run();

  await t('Q2 vale o roteiro da campanha mais recente recebida; sem roteiro, nenhum', () => {
    assert(RC.roteiroDaConversa(db, c1)?.id === rotA, 'não pegou o roteiro da campanha legado');
    // Depois o contato recebeu uma campanha nova, com outro roteiro.
    db.prepare("INSERT INTO comm_campanhas (id, nome, canal, templateId, listaId, status, roteiroId) VALUES (7, 'Nova', 'whatsapp', 0, 0, 'concluida', ?)").run(rotB);
    db.prepare("INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio) VALUES (7, 'whatsapp', '5594991110001', 'enviado', '2023-11-13T01:00:00.000Z')").run();
    assert(RC.roteiroDaConversa(db, c1)?.id === rotB, 'a campanha mais recente não venceu');
    // A mais recente sem roteiro: a conversa fica sem, e não herda nada.
    db.prepare('UPDATE comm_campanhas SET roteiroId = NULL WHERE id = 7').run();
    assert(RC.roteiroDaConversa(db, c1) === null, 'caiu num roteiro sem a campanha ter escolhido');
    const avulsa = conversa(9, '5594990009999', 'Fora de campanha');
    assert(RC.roteiroDaConversa(db, avulsa) === null, 'conversa fora de campanha ganhou roteiro');
    db.prepare('DELETE FROM comm_envios').run();
    assert(RC.roteiroDaConversa(db, c1)?.id === rotA, 'voltou ao legado');
  });

  await t('Q3 a IA marca o que o lead disse, recusa o inventado, nao repergunta, e sem fala do lead nao chama', async () => {
    let chamadas = 0, pedido = '';
    const semFala = await RC.qualificarPelaIA(db, c1, { chamar: async () => { chamadas++; return {}; } });
    assert(semFala === null && chamadas === 0, 'chamou a IA sem nenhuma fala do lead');
    fala('5594991110001', 1, 'Oi! Sua empresa vende para órgão público?', 1700000000);
    fala('5594991110001', 0, 'vendo sim, umas vezes por ano', 1700000001);
    const r = await RC.qualificarPelaIA(db, c1, { chamar: async (p) => { chamadas++; pedido = p; return {
      vende: { resposta: 'sim', trecho: 'vendo sim, umas vezes' },
      dor: { resposta: 'mao', trecho: 'procuro tudo na mão' } }; } });
    assert(chamadas === 1 && r.mudou, JSON.stringify(r));
    assert(r.aceitas.vende && !r.aceitas.dor, 'aceitou resposta sem trecho na conversa');
    assert(r.recusadas.some(x => x.chave === 'dor' || /dor/.test(JSON.stringify(x))), 'a recusa não aparece');
    assert(!r.fim && r.etapa.chave === 'porte', 'a etapa não andou: ' + JSON.stringify(r.etapa));
    const reg = RC.registroDa(db, 1);
    assert(JSON.parse(reg.trechos).vende === 'vendo sim, umas vezes', 'o trecho não ficou gravado');
    await RC.qualificarPelaIA(db, c1, { chamar: async (p) => { pedido = p; return {}; } });
    assert(!/vende:/.test(pedido) && /porte:/.test(pedido), 'repetiu a pergunta respondida ou não pediu a que falta');
  });

  await t('Q4 a resposta que encerra desqualifica, e a IA recebe a ordem de encerrar', async () => {
    const c2 = conversa(2, '5594991110002', 'Loja Dois');
    db.prepare("INSERT INTO wa_campanha_dest (campanha_id, telefone, status, enviado_em) VALUES (5, '5594991110002', 'enviado', '2023-11-13T00:00:00.000Z')").run();
    fala('5594991110002', 0, 'não tenho interesse nisso não', 1700000100);
    const r = await RC.qualificarPelaIA(db, c2, { chamar: async () => ({ vende: { resposta: 'nao', trecho: 'não tenho interesse' } }) });
    assert(r.fim && r.resultado === 'desqualificado', JSON.stringify(r));
    assert(RC.registroDa(db, 2).resultado === 'desqualificado' && RC.registroDa(db, 2).finalizadoEm, 'resultado não gravado');
    assert(!db.prepare('SELECT oportunidadeId FROM conv_conversas WHERE id = 2').get().oportunidadeId, 'desqualificado virou oportunidade');
    const bloco = RC.blocoParaIA(db, 2);
    assert(/ROTEIRO ENCERRADO/.test(bloco) && !/Quantas pessoas/.test(bloco), bloco);
    // 30/09: a IA escreveu "como o contato está qualificado" PARA o cliente.
    assert(/NUNCA escreva "qualificado"/.test(bloco), 'o desfecho não proíbe o jargão interno');
    let chamou = false;
    await RC.qualificarPelaIA(db, c2, { chamar: async () => { chamou = true; return {}; } });
    assert(!chamou, 'continuou chamando a IA num roteiro encerrado');
  });

  // 30/09: a qualificação chamava `analise-ia.chamarGemini` direto, então bastava
  // o Gemini estar em 429 ou 503 para o roteiro parar de marcar resposta, calado.
  // Foi o que aconteceu no 1bit, e `roteiro_visitas` ficou sem uma linha.
  await t('Q3b sem `chamar`, a qualificacao usa a CADEIA de IA, e nao so o Gemini', async () => {
    const c4 = conversa(4, '5594991110004', 'Loja Quatro');
    // A conversa precisa de campanha com roteiro, senão a qualificação nem
    // chega na IA (é a regra do Q2).
    db.prepare("INSERT INTO wa_campanha_dest (campanha_id, telefone, status, enviado_em) VALUES (5, '5594991110004', 'enviado', '2023-11-13T00:00:00.000Z')").run();
    fala('5594991110004', 0, 'somos pequenos, duas pessoas', Math.floor(Date.now() / 1000));
    // Só a chave da groq: com o Gemini de fora, o caminho antigo devolvia null
    // sem chamar ninguém.
    db.prepare("DELETE FROM config WHERE chave IN ('gemini_api_key','groq_api_key')").run();
    db.prepare("INSERT INTO config (chave, valor) VALUES ('groq_api_key','chave-falsa')").run();
    let usouCadeia = false;
    require.cache[require.resolve('../chat-ia')] = { exports: {
      chamarChatLLM: async () => { usouCadeia = true; return { content: '{}', provider: 'groq' }; },
    } };
    await RC.qualificarPelaIA(db, c4);
    assert(usouCadeia, 'a qualificação não passou pela cadeia de IA');
    delete require.cache[require.resolve('../chat-ia')];
  });

  // 30/09, e é a raiz do roteiro parado: a cadeia devolve TEXTO, e o valor ia
  // direto para `conferirExtracao`, que indexa por nome de chave. Numa string
  // isso é `undefined` em toda chave, então nada era aceito E nada recusado —
  // zero linha em `roteiro_visitas` e zero linha no log. As checagens acima
  // passavam porque todas injetam um objeto pronto.
  await t('Q3c a resposta da IA chega como TEXTO, e ainda assim e gravada', async () => {
    const c5 = conversa(5, '5594991110005', 'Loja Cinco');
    db.prepare("INSERT INTO wa_campanha_dest (campanha_id, telefone, status, enviado_em) VALUES (5, '5594991110005', 'enviado', '2023-11-13T00:00:00.000Z')").run();
    fala('5594991110005', 0, 'vendo sim, umas vezes por ano', Math.floor(Date.now() / 1000));
    // Com a cerca ```json e uma linha de conversa antes, como a groq devolve.
    const texto = 'Claro, segue a análise:\n```json\n{ "vende": { "resposta": "sim",'
      + ' "trecho": "vendo sim, umas vezes por ano" } }\n```';
    const r = await RC.qualificarPelaIA(db, c5, { chamar: async () => texto });
    assert(r && r.mudou, 'a resposta em texto não virou resposta marcada: ' + JSON.stringify(r));
    assert(r.aceitas.vende && r.etapa.chave !== 'vende', 'a etapa não andou: ' + JSON.stringify(r.etapa));
    assert(JSON.parse(RC.registroDa(db, 5).respostas).vende === 'sim', 'não gravou em roteiro_visitas');
    // Texto sem JSON nenhum não pode virar exceção nem gravar nada.
    const nada = await RC.qualificarPelaIA(db, c5, { chamar: async () => 'não consegui responder' });
    assert(nada === null, 'texto sem JSON produziu alguma coisa: ' + JSON.stringify(nada));
  });

  // 30/09: o reenvio da campanha 5 (rodada 18, 17:33) retomou o roteiro na etapa
  // 3, porque duas respostas estavam gravadas da rodada 17. Quem recebe a
  // mensagem outra vez responde de novo, do começo.
  await t('Q3d rodada NOVA da campanha recomeca o roteiro, sem apagar o registro antigo', async () => {
    const c6 = conversa(6, '5594991110006', 'Loja Seis');
    db.prepare(`INSERT INTO comm_campanhas (id, nome, canal, templateId, listaId, status, roteiroId)
      VALUES (60, 'Rodadas', 'whatsapp', 0, 0, 'enviada', ?)`).run(rotA);
    const envio = (quando) => db.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio)
      VALUES (60, 'whatsapp', '5594991110006', 'enviado', ?)`).run(quando);
    envio('2023-11-13T00:00:00.000Z');
    fala('5594991110006', 0, 'vendo sim, umas vezes por ano', 1700000500);
    const r1 = await RC.qualificarPelaIA(db, c6, { chamar: async () => ({ vende: { resposta: 'sim', trecho: 'vendo sim, umas vezes' } }) });
    assert(r1.mudou && r1.etapa.chave === 'porte', 'a primeira rodada não andou: ' + JSON.stringify(r1));
    const idAntigo = RC.registroDa(db, 6).id;

    // A rodada seguinte: envio POSTERIOR ao registro (o `criadoEm` dele tem
    // resolução de segundo, daí a folga), e o contato responde depois do envio.
    const rodada2 = new Date(Date.now() + 5000).toISOString();
    envio(rodada2);
    assert(RC.registroDa(db, 6, { desde: rodada2 }) === null, 'o registro da rodada passada continuou valendo');
    const bloco = RC.blocoParaIA(db, 6);
    assert(/Sua empresa vende para órgão público/.test(bloco), 'não voltou à etapa 1: ' + bloco);

    // A fala ANTIGA não pode alimentar a rodada nova: sem o corte do histórico, o
    // extrator reconstruiria as respostas da rodada passada na primeira mensagem.
    const so = await RC.qualificarPelaIA(db, c6, { chamar: async (p) => {
      assert(!/vendo sim, umas vezes por ano/.test(p), 'a fala da rodada passada entrou no pedido à IA');
      return {};
    } });
    assert(so === null, 'chamou a IA sem fala nenhuma nesta rodada: ' + JSON.stringify(so));

    fala('5594991110006', 0, 'vendo muito, toda semana', Math.floor(Date.now() / 1000) + 10);
    const r2 = await RC.qualificarPelaIA(db, c6, { chamar: async () => ({ vende: { resposta: 'grande', trecho: 'vendo muito, toda semana' } }) });
    assert(r2.mudou, 'a rodada nova não gravou nada');
    assert(RC.registroDa(db, 6).id !== idAntigo, 'gravou por cima do registro da rodada passada');
    assert(db.prepare('SELECT COUNT(*) n FROM roteiro_visitas WHERE conversaId = 6').get().n === 2,
      'o registro antigo foi apagado, em vez de virar histórico');
  });

  // 30/09, 17:33 e 17:34: a IA mandou o link do trial no meio do roteiro, duas
  // vezes, porque as instruções do canal mandam oferecê-lo SEMPRE que houver
  // interesse. Pedido no prompt não venceu; a guarda de código vence.
  await t('Q6d o link NAO sai enquanto o roteiro corre, e a pergunta fica', () => {
    const resp = 'Claro! Você pode testar em https://liciteagora.app/trial.html — é rápido.'
      + '\n\nQuantas pessoas trabalham com licitação?';
    const saiu = RC.semLinkNoRoteiro(db, 1, resp);
    assert(!/https?:\/\//.test(saiu), 'o link passou: ' + saiu);
    assert(/Quantas pessoas trabalham com licitação/.test(saiu), 'a pergunta da etapa se perdeu: ' + saiu);

    // Sem a pergunta na resposta, a guarda a recoloca.
    const soLink = RC.semLinkNoRoteiro(db, 1, 'Segue o link: https://liciteagora.app/trial.html');
    assert(!/https?:\/\//.test(soLink) && /Quantas pessoas trabalham/.test(soLink), soLink);

    // Texto sem link não é tocado, e conversa sem roteiro também não.
    const limpo = 'Entendi. Quantas pessoas trabalham com licitação?';
    assert(RC.semLinkNoRoteiro(db, 1, limpo) === limpo, 'mexeu em texto sem link');
    // Com a pergunta presente, sai IDÊNTICO, inclusive a linha em branco entre
    // parágrafos: a reconstrução junta tudo com um \n só, e no WhatsApp isso vira
    // um bloco corrido.
    const doisParagrafos = 'Entendi, obrigado.\n\nQuantas pessoas trabalham com licitação?';
    assert(RC.semLinkNoRoteiro(db, 1, doisParagrafos) === doisParagrafos, 'achatou os parágrafos: '
      + JSON.stringify(RC.semLinkNoRoteiro(db, 1, doisParagrafos)));

    // 01/10, 15:20: SEM link e SEM a pergunta, a resposta passava inteira e a
    // conversa ficava sem saída — a IA perguntou "tem interesse em conhecer o
    // LiciteAgora?", que não está em roteiro nenhum, e a etapa seguia pendente.
    const inventada = 'Obrigado pela confirmação! 😊\n\nPosso saber se você tem interesse em conhecer o LiciteAgora?';
    const comPergunta = RC.semLinkNoRoteiro(db, 1, inventada);
    assert(/Quantas pessoas trabalham com licitação/.test(comPergunta),
           'a pergunta da etapa não entrou numa resposta sem link: ' + comPergunta);

    // 01/10, 15:21: tirada a linha do endereço, sobrou "você pode testar pelo link
    // abaixo:" sem link nenhum embaixo. Promete e não entrega, que é pior que calar.
    const orfa = 'Você pode testar 14 dias grátis agora pelo link abaixo:\nhttps://liciteagora.app/trial.html\nÉ só preencher o formulário rápido.';
    const semOrfa = RC.semLinkNoRoteiro(db, 1, orfa);
    assert(!/https?:\/\//.test(semOrfa), 'o link passou: ' + semOrfa);
    assert(!/link/i.test(semOrfa), 'sobrou a frase que anuncia o link: ' + semOrfa);
    assert(/Quantas pessoas trabalham com licitação/.test(semOrfa), 'a pergunta não ficou: ' + semOrfa);
    const comLink = 'Segue: https://exemplo.test/x';
    assert(RC.semLinkNoRoteiro(db, 9, comLink) === comLink, 'cortou o link de conversa sem roteiro');

    // Roteiro CONCLUÍDO: aí o link é o próximo passo e tem de sair.
    assert(RC.semLinkNoRoteiro(db, 3, comLink) === comLink, 'cortou o link depois de o roteiro terminar');
  });

  await t('Q5 no fim com pontos: qualificado, oportunidade no funil escolhido, uma vez so', () => {
    const c3 = conversa(3, '5594991110003', 'Loja Três');
    const r = RC.gravar(db, c3, db.prepare('SELECT * FROM roteiros WHERE id = ?').get(rotA), { vende: 'grande', dor: 'mao' }, { usuario: 'teste' });
    assert(r.resultado === 'qualificado' && r.oportunidadeId, JSON.stringify(r));
    const op = db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(r.oportunidadeId);
    assert(op.funilId === 2 && op.etapaId === 21, `nasceu no funil ${op.funilId}, etapa ${op.etapaId}`);
    assert(db.prepare('SELECT oportunidadeId FROM conv_conversas WHERE id = 3').get().oportunidadeId === r.oportunidadeId, 'a conversa não ficou ligada');
    const de_novo = RC.gravar(db, c3, db.prepare('SELECT * FROM roteiros WHERE id = ?').get(rotA), { vende: 'grande', dor: 'mao' }, {});
    assert(!de_novo.oportunidadeId && db.prepare('SELECT COUNT(*) n FROM crm_oportunidades').get().n === 1, 'criou oportunidade em dobro');
    const bloco = RC.blocoParaIA(db, 3);
    assert(/ROTEIRO CONCLUÍDO/.test(bloco) && /Mande https:\/\/exemplo\.test\/trial\.html para o teste de 14 dias/.test(bloco), bloco);
    assert(!/\{\{/.test(bloco), 'a variável chegou crua à IA: ' + bloco);
    assert(/NUNCA escreva "qualificado"/.test(bloco), 'o desfecho qualificado não proíbe o jargão interno');
  });

  await t('Q6 o prompt do atendimento leva so a etapa atual', () => {
    const bloco = RC.blocoParaIA(db, 1);
    assert(/Quantas pessoas trabalham/.test(bloco), 'não levou a etapa atual');
    assert(!/Como você acha os editais/.test(bloco) && !/vende para órgão/.test(bloco), 'levou etapa que não é a atual');
    assert(/Uma pergunta por mensagem/.test(bloco), 'não levou a condução');
    assert(RC.blocoParaIA(db, 9) === '', 'conversa sem roteiro ganhou bloco');
  });

  // 30/09: a IA respondeu "Sim" de um lead de restaurante pedindo nome da
  // empresa e quantos usuários usariam o sistema, duas vezes, porque as
  // instruções da empresa mandam coletar isso e vinham MUITO antes do roteiro no
  // prompt (16% contra 91%). Nem o pedido de precedência escrito no roteiro
  // bastou: ordem específica que aparece antes vence pedido genérico depois.
  await t('Q6b o roteiro vem NA FRENTE das instrucoes, e proibe a coleta pelo nome', () => {
    const bloco = RC.blocoParaIA(db, 1);
    assert(/NÃO peça nome da empresa/.test(bloco), 'a proibição não nomeia o que não fazer');
    assert(/número de usuários/.test(bloco), 'a proibição não cobre o número de usuários');
    assert(/NÃO prometa que alguém vai retornar com proposta/.test(bloco), 'não proíbe prometer a proposta');
    // 30/09, 16:27: as instruções do canal mandam oferecer o teste grátis SEMPRE
    // que houver interesse, e o "Sim" da campanha é interesse. A IA mandou o
    // trial no lugar da etapa 1.
    assert(/NÃO ofereça link de teste grátis, trial, demonstração/.test(bloco), 'não proíbe oferecer o trial');
    assert(/manda oferecer SEMPRE/.test(bloco), 'não nomeia a instrução conflitante do canal');
    // 30/09, 17:15: o lead respondeu "o gerente, de uma em uma semana", que não
    // cabe em opção nenhuma, e a IA inventou uma pergunta sobre ficha técnica.
    // Desde 01/10 as opções saem NUMERADAS, e é por esse número que a resposta é
    // reconhecida sem passar pela IA (ver o bloco N).
    assert(/OFEREÇA ESTAS RESPOSTAS, UMA POR LINHA, COM O NÚMERO NA FRENTE/.test(bloco), 'o bloco não leva as opções da etapa');
    assert(/NÃO invente outra pergunta/.test(bloco), 'não proíbe inventar pergunta fora do roteiro');
    assert(/Repita a pergunta com a mesma lista/.test(bloco), 'não manda oferecer as opções de novo');

    // Instruções da empresa com a linha conflitante, como as do 1bit.
    // As instruções são do CANAL (configDoAtendimento lê o canal padrão), e não
    // da config global: gravadas no lugar errado, não entrariam no prompt.
    require('../whatsapp-canais').salvarConfigCanal(db, 1, { whatsapp_ai_prompt:
      'Você é o assistente. Se o cliente pedir orçamento, colete: nome da empresa, CNPJ, quantos usuários.' });
    const p = require('../whatsapp-adapter').buildSystemAtendimento(db, null, { conversaId: 1, canalId: null });
    const posRoteiro = p.indexOf('FAÇA ESTA PERGUNTA AO CONTATO');
    const posColeta = p.indexOf('colete: nome da empresa');
    assert(posRoteiro === 0, `o roteiro não abre o prompt (está em ${posRoteiro})`);
    assert(posColeta > posRoteiro, 'a instrução de coletar dados vem antes do roteiro');
  });

  // 30/09, 15:57: a IA EXPLICOU como se calcula o preço de um prato pela ficha
  // técnica e só então devolveu a pergunta do roteiro reescrita. Solta no topo
  // do prompt, uma frase interrogativa é lida como pergunta dirigida ao modelo.
  await t('Q6c o bloco manda FAZER a pergunta, com as palavras do roteiro, e nao responde-la', () => {
    const bloco = RC.blocoParaIA(db, 1);
    assert(/FAÇA ESTA PERGUNTA AO CONTATO/.test(bloco), 'o bloco não diz a quem a pergunta se dirige');
    assert(/"Quantas pessoas trabalham[^"]*"/.test(bloco), 'a pergunta não vem delimitada: ' + bloco);
    assert(/ESTAS PALAVRAS/.test(bloco), 'não manda copiar o texto do roteiro');
    assert(/NÃO para você responder/.test(bloco), 'não proíbe a IA de responder a própria pergunta');
    assert(/Nunca dê a resposta dela no lugar dele/.test(bloco), 'não proíbe responder no lugar do contato');
  });

  await t('Q7 editor: lista com campanhas e funis, cria, recusa pulo para tras e remover em uso', async () => {
    const l = await pedir('/api/roteiros');
    const a = l.corpo.roteiros.find(r => r.id === rotA);
    assert(a && a.etapas === 3 && a.campanhas.some(c => /Legado/.test(c)), JSON.stringify(l.corpo.roteiros));
    assert(!l.corpo.roteiros.some(r => r.id === 50), 'listou o roteiro presencial');
    assert(l.corpo.funis.map(f => f.nome).join() === 'Vendas,Leads WhatsApp', JSON.stringify(l.corpo.funis));
    const volta = JSON.parse(JSON.stringify(CFG));
    volta.perguntas[1].opcoes[0].vaiPara = 'vende';
    const ruim = await pedir('/api/roteiros', 'POST', { nome: 'Ruim', config: volta });
    assert(ruim.status === 400 && /mais adiante/.test(ruim.corpo.error), JSON.stringify(ruim.corpo));
    const novo = await pedir('/api/roteiros', 'POST', { nome: 'Novo', config: { ...CFG, corte: 0 } });
    assert(novo.corpo.success && novo.corpo.id, JSON.stringify(novo.corpo));
    const emUso = await pedir('/api/roteiros/' + rotA, 'DELETE');
    assert(emUso.status >= 400 && /Legado/.test(emUso.corpo.error), JSON.stringify(emUso.corpo));
    assert(db.prepare('SELECT ativo FROM roteiros WHERE id = ?').get(rotA).ativo === 1, 'desativou roteiro em uso');
    const livre = await pedir('/api/roteiros/' + novo.corpo.id, 'DELETE');
    assert(livre.corpo.success && db.prepare('SELECT ativo FROM roteiros WHERE id = ?').get(novo.corpo.id).ativo === 0, 'não removeu');
    const corte0 = await pedir('/api/roteiros/' + rotB, 'PUT', { config: { ...JSON.parse(db.prepare('SELECT config FROM roteiros WHERE id = ?').get(rotB).config), corte: 0 } });
    assert(corte0.corpo.success && db.prepare('SELECT corte FROM roteiros WHERE id = ?').get(rotB).corte === 0, 'corte zero não foi gravado');
  });

  await t('Q8 as duas campanhas recusam roteiro inexistente e gravam o que existe', async () => {
    const ruimWa = await pedir('/api/conversas/campanhas/wa/5', 'PUT', { config: { roteiro_id: 999 } });
    assert(ruimWa.status === 400 && /Roteiro/.test(ruimWa.corpo.error), JSON.stringify(ruimWa.corpo));
    const bomWa = await pedir('/api/conversas/campanhas/wa/5', 'PUT', { config: { roteiro_id: rotB } });
    assert(bomWa.corpo.success && JSON.parse(db.prepare('SELECT config FROM wa_campanhas WHERE id = 5').get().config).roteiro_id === rotB, JSON.stringify(bomWa.corpo));
    const tira = await pedir('/api/conversas/campanhas/wa/5', 'PUT', { config: { roteiro_id: null } });
    assert(tira.corpo.success && !('roteiro_id' in JSON.parse(db.prepare('SELECT config FROM wa_campanhas WHERE id = 5').get().config)), 'não tirou o roteiro');
    await pedir('/api/conversas/campanhas/wa/5', 'PUT', { config: { roteiro_id: rotA } });
    const visita = await pedir('/api/conversas/campanhas/wa/5', 'PUT', { config: { roteiro_id: 50 } });
    assert(visita.status === 400, 'aceitou o roteiro presencial desativado');
    const tpl = Number(db.prepare("INSERT INTO comm_templates (nome, canal, corpo) VALUES ('t', 'whatsapp', 'Oi')").run().lastInsertRowid);
    const lista = Number(db.prepare("INSERT INTO comm_listas (nome) VALUES ('l')").run().lastInsertRowid);
    const ruimComm = await pedir('/api/comm/campanhas', 'POST', { nome: 'c', templateId: tpl, listaId: lista, tipo: 'marketing', roteiroId: 999 });
    assert(ruimComm.status === 400 && /Roteiro/.test(ruimComm.corpo.error), JSON.stringify(ruimComm.corpo));
    const bomComm = await pedir('/api/comm/campanhas', 'POST', { nome: 'c', templateId: tpl, listaId: lista, tipo: 'marketing', roteiroId: rotA });
    assert(bomComm.corpo.success && db.prepare('SELECT roteiroId FROM comm_campanhas WHERE id = ?').get(bomComm.corpo.campanha.id).roteiroId === rotA, JSON.stringify(bomComm.corpo));
  });

  await t('Q9 Conversas filtra e conta qualificados e desqualificados', async () => {
    // O recorte virou SITUAÇÃO em 02/10: qualificado e desqualificado saíram dos
    // chips e entraram no mesmo seletor de "responderam/não responderam".
    const q = await pedir('/api/conversas?situacao=qualificados');
    assert(q.corpo.conversas.map(c => c.id).join() === '3', 'qualificados: ' + q.corpo.conversas.map(c => c.id));
    const d = await pedir('/api/conversas?situacao=desqualificados');
    assert(d.corpo.conversas.map(c => c.id).join() === '2', 'desqualificados: ' + d.corpo.conversas.map(c => c.id));
    assert(q.corpo.contagem.qualificados === 1 && q.corpo.contagem.desqualificados === 1, JSON.stringify(q.corpo.contagem));
  });

  await t('Q10 a migracao desativa o roteiro presencial e e idempotente', () => {
    assert(db.prepare('SELECT ativo FROM roteiros WHERE id = 50').get().ativo === 0, 'o presencial continua ativo');
    RC.migrar(db);
    const cols = db.prepare('PRAGMA table_info(roteiro_visitas)').all().map(c => c.name);
    assert(['resultado', 'finalizadoEm', 'trechos'].every(c => cols.includes(c)), cols.join());
  });

  // Campanha recebida conta pelo NÚMERO por onde ela saiu (05/10/2026). No
  // 1bit a campanha saiu pelo Principal, o contato mandou "oi" para o número
  // pessoal do atendente e a IA respondeu lá com a primeira etapa do roteiro,
  // porque o casamento era só pelo telefone. Eram 4 conversas assim.
  await t('Q12 campanha de OUTRO numero nao vale: nem roteiro, nem escopo da IA', async () => {
    db.prepare("INSERT INTO whatsapp_canais (id, nome, instance, padrao, config) VALUES (2, 'Pessoal', 'inst2', 0, '{}')").run();
    const tel = '5594991110081';
    db.prepare("INSERT INTO conv_conversas (id, canal, jid, telefone, nome, canalId) VALUES (81, 'whatsapp', ?, ?, 'Pelo Principal', 1)")
      .run(tel + '@s.whatsapp.net', tel);
    db.prepare("INSERT INTO conv_conversas (id, canal, jid, telefone, nome, canalId) VALUES (82, 'whatsapp', ?, ?, 'Pelo Pessoal', 2)")
      .run(tel + '@s.whatsapp.net', tel);
    const noCanal1 = db.prepare('SELECT * FROM conv_conversas WHERE id = 81').get();
    const noCanal2 = db.prepare('SELECT * FROM conv_conversas WHERE id = 82').get();
    db.prepare("INSERT INTO comm_campanhas (id, nome, canal, templateId, listaId, status, roteiroId) VALUES (81, 'Do Principal', 'whatsapp', 0, 0, 'concluida', ?)").run(rotA);
    db.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio, canalId)
      VALUES (81, 'whatsapp', ?, 'enviado', '2023-11-14T00:00:00.000Z', 1)`).run(tel);

    assert(RC.campanhaDaConversa(db, noCanal1), 'a campanha do próprio número não casou');
    assert(!RC.campanhaDaConversa(db, noCanal2), 'a campanha de outro número casou, e o escopo da IA vaza');
    assert(RC.roteiroDaConversa(db, noCanal1)?.id === rotA, 'o roteiro não veio no número que abordou');
    assert(!RC.roteiroDaConversa(db, noCanal2), 'o roteiro vazou para o número que não abordou');

    // Envio de banco anterior aos canais (coluna nula) é do número PADRÃO:
    // exigir igualdade crua descartaria toda campanha antiga de uma vez.
    db.prepare('UPDATE comm_envios SET canalId = NULL WHERE campanhaId = 81').run();
    assert(RC.campanhaDaConversa(db, noCanal1), 'envio sem canal deixou de contar no número padrão');
    assert(!RC.campanhaDaConversa(db, noCanal2), 'envio sem canal contou num número que não é o padrão');
    db.prepare('UPDATE comm_envios SET canalId = 1 WHERE campanhaId = 81').run();

    // E a marca da IA na lista diz a mesma coisa: com o escopo em 'campanha',
    // a conversa que nenhuma campanha deste número abordou aparece desligada.
    db.prepare("INSERT INTO config (chave, valor) VALUES ('whatsapp_ai_escopo', 'campanha')").run();
    const r = await pedir('/api/conversas');
    const por = (id) => r.corpo.conversas.find(c => c.id === id);
    assert(por(81) && por(81).iaForaDoEscopo === 0, 'quem veio da campanha deste número saiu fora do escopo');
    assert(por(82) && por(82).iaForaDoEscopo === 1, 'quem nenhuma campanha deste número abordou saiu como atendido pela IA');
    // Sem o escopo restrito, a marca volta a valer para todas.
    db.prepare("UPDATE config SET valor = 'todos' WHERE chave = 'whatsapp_ai_escopo'").run();
    const t2 = await pedir('/api/conversas');
    assert(t2.corpo.conversas.every(c => c.iaForaDoEscopo === 0), 'com o escopo em "todos" alguma conversa saiu fora dele');
    db.prepare("DELETE FROM config WHERE chave = 'whatsapp_ai_escopo'").run();
    db.prepare('DELETE FROM conv_conversas WHERE id IN (81, 82)').run();
    db.prepare('DELETE FROM comm_envios WHERE campanhaId = 81').run();
    db.prepare('DELETE FROM comm_campanhas WHERE id = 81').run();
    db.prepare('DELETE FROM whatsapp_canais WHERE id = 2').run();
  });

  // ==================== N. a resposta pelo número da opção (01/10) ==========
  //
  // As opções são oferecidas numeradas, e "2" é resolvido pelo Node, sem IA. A
  // guarda é a mensagem anterior: ela precisa ter oferecido aquele rótulo. Sem
  // isso, o "2" de um telefone ou de "2 caixas" viraria resposta do roteiro, e o
  // `conferirExtracao` não seguraria — um trecho "2" casa com qualquer "2".
  const comRoteiro = (id, tel, nome, roteiroId) => {
    const c = conversa(id, tel, nome);
    const camp = Number(db.prepare(`INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status, roteiroId, canais)
      VALUES (?, 1, 1, 'whatsapp', 'enviada', ?, '[1]')`).run('Camp ' + nome, roteiroId).lastInsertRowid);
    db.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio, canalId, rodada)
      VALUES (?, 'whatsapp', ?, 'enviado', '2023-11-13T00:00:00.000Z', 1, 1)`).run(camp, tel);
    return c;
  };
  const semIA = async (c) => {
    let chamou = false;
    const r = await RC.qualificarPelaIA(db, c, { chamar: async () => { chamou = true; return {}; } });
    return { r, chamou };
  };

  await t('N1 "2" depois da pergunta oferecida grava a segunda opcao, sem chamar a IA', async () => {
    const c = comRoteiro(30, '5594991110030', 'Numero Um', rotA);
    fala('5594991110030', 1, 'Sua empresa vende para órgão público?\n1) Vende\n2) Vende muito\n3) Não tem interesse', 1700001000);
    fala('5594991110030', 0, '2', 1700001001);
    const { r, chamou } = await semIA(c);
    assert(!chamou, 'chamou a IA para resolver um número de opção');
    assert(r && r.mudou && r.porNumero && r.porNumero.resposta === 'grande', JSON.stringify(r));
    const reg = RC.registroDa(db, 30);
    assert(JSON.parse(reg.respostas).vende === 'grande', 'não gravou a opção 2: ' + reg.respostas);
    assert(JSON.parse(reg.trechos).vende === '2', 'o trecho não é a fala do contato: ' + reg.trechos);
    // "grande" pula o porte, então a etapa seguinte é a dor. A numeração resolvida
    // tem de deixar o estado igual ao que a IA deixaria.
    assert(r.etapa && r.etapa.chave === 'dor', 'o estado não avançou pelo desvio da opção: ' + JSON.stringify(r.etapa));
  });

  await t('N1b sem a pergunta oferecida antes, o "2" solto nao grava nada', async () => {
    const c = comRoteiro(31, '5594991110031', 'Numero Dois', rotA);
    // A mensagem anterior é nossa, mas não ofereceu a lista: é o caso do contato
    // mandando "2" por outro motivo (quantidade, continuação de outro assunto).
    fala('5594991110031', 1, 'Perfeito, obrigado pelo retorno!', 1700001010);
    fala('5594991110031', 0, '2', 1700001011);
    const { chamou } = await semIA(c);
    assert(chamou, 'não caiu na IA: o número foi aceito sem a lista ter sido oferecida');
    assert(!RC.registroDa(db, 31), 'gravou resposta a partir de um "2" solto');
  });

  await t('N2 numero fora da faixa e numero no meio da frase nao sao escolha', async () => {
    const etapa = CFG.perguntas[0];
    assert(R.respostaNumerica(etapa, '2') === 'grande', 'o número da posição não resolveu');
    assert(R.respostaNumerica(etapa, 'opção 3') === 'nao', 'não aceitou "opção 3"');
    assert(R.respostaNumerica(etapa, '3.') === 'nao', 'a pontuação derrubou a escolha');
    assert(R.respostaNumerica(etapa, '7') === null, '7 não existe e foi aceito');
    assert(R.respostaNumerica(etapa, '20') === null, '20 virou escolha de opção');
    assert(R.respostaNumerica(etapa, 'uns 2 por mês') === null, 'número no meio da frase virou escolha');
    assert(R.respostaNumerica(etapa, '94991817186') === null, 'um telefone virou escolha');
    assert(R.respostaNumerica(etapa, '') === null && R.respostaNumerica(null, '2') === null, 'vazio não é escolha');
  });

  await t('N2b trecho que e so numero nao sustenta resposta, venha de onde vier', () => {
    // A escolha legítima pelo número é resolvida antes, sem IA. Um trecho "2" que
    // chega pelo extrator é invenção: "2" está em qualquer conversa que tenha um
    // telefone ou um valor, e o `alvo.includes` passaria sempre.
    const historico = [{ deMim: true, texto: 'Sua empresa vende para órgão público?' },
                       { deMim: false, texto: 'meu telefone é 94991817186, falamos 2 vezes' }];
    const r = R.conferirExtracao(CFG, { vende: { resposta: 'grande', trecho: '2' } }, historico);
    assert(!r.aceitas.vende, 'um trecho "2" sustentou resposta');
    assert(r.recusadas.some(x => x.motivo === 'trecho é só um número'), JSON.stringify(r.recusadas));
    // E o trecho de verdade continua passando.
    const ok2 = R.conferirExtracao(CFG, { vende: { resposta: 'grande', trecho: 'falamos 2 vezes' } }, historico);
    assert(ok2.aceitas.vende, 'o trecho com palavras foi recusado: ' + JSON.stringify(ok2.recusadas));
  });

  // 01/10, 15:20, a conversa real do 1bit: o lead escreveu "eu sou o dono" na
  // última etapa e a groq respondeu `resposta: "1"`, o número da opção, porque a
  // conversa toda está cheia das listas numeradas que nós oferecemos. O id "1" não
  // existe, a etapa travou, a IA repetiu a pergunta, inventou outra fora do
  // roteiro ("tem interesse em conhecer o LiciteAgora?") e o link nunca saiu.
  await t('N2c a IA devolvendo o NUMERO da opcao no lugar do id ainda casa', () => {
    const historico = [{ deMim: true, texto: 'Sua empresa vende para órgão público?\n1) Vende\n2) Vende muito\n3) Não tem interesse' },
                       { deMim: false, texto: 'eu vendo muito, direto' }];
    const r = R.conferirExtracao(CFG, { vende: { resposta: '2', trecho: 'eu vendo muito, direto' } }, historico);
    assert(r.aceitas.vende && r.aceitas.vende.resposta === 'grande',
           'a posição 2 não casou com a segunda opção: ' + JSON.stringify(r));
    // Número fora da faixa continua recusado, e o trecho continua sendo a prova.
    const fora = R.conferirExtracao(CFG, { vende: { resposta: '9', trecho: 'eu vendo muito, direto' } }, historico);
    assert(!fora.aceitas.vende && fora.recusadas[0].motivo === 'opção inexistente', JSON.stringify(fora.recusadas));
    const semProva = R.conferirExtracao(CFG, { vende: { resposta: '2', trecho: 'nunca disse isso' } }, historico);
    assert(!semProva.aceitas.vende, 'a posição foi aceita com trecho que o contato não escreveu');
    // E o prompt pede o id, para o modelo não cair nisso de novo.
    assert(/NÃO é o número da opção/.test(R.promptExtracao(CFG, historico, {}).prompt), 'o prompt não avisa sobre o número');
  });

  await t('N3 o prompt oferece as respostas numeradas, na ordem do roteiro', () => {
    const c = conversa(32, '5594991110032', 'Numero Tres');
    db.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio, canalId, rodada)
      VALUES ((SELECT id FROM comm_campanhas WHERE roteiroId = ? ORDER BY id LIMIT 1), 'whatsapp', ?, 'enviado',
              '2023-11-13T00:00:00.000Z', 1, 1)`).run(rotA, '5594991110032');
    const bloco = RC.blocoParaIA(db, c.id);
    assert(/1\) Vende\n2\) Vende muito\n3\) Não tem interesse/.test(bloco), 'as opções não saíram numeradas: ' + bloco);
    assert(/Não reordene, não renumere/.test(bloco), 'nada impede o modelo de reordenar a lista');
    assert(/responder o número ou escrever/.test(bloco), 'não diz que a resposta livre vale também');
  });

  // ============ D. os desvios do atendimento e o fim do roteiro ============
  //
  // Desde 02/10 as duas respostas prontas são do NÚMERO, e não do roteiro: quem
  // vê um anúncio e pergunta o link nunca passou por campanha. O roteiro ficou
  // com o FIM, que é mensagem literal por desfecho.
  const RESP_PESSOA = 'Obrigado pela paciência! Alguém da equipe já está vindo falar com você.';
  const canais = require('../whatsapp-canais');
  canais.salvarConfigCanal(db, 1, {
    whatsapp_ai_resp_pessoa: RESP_PESSOA,
    whatsapp_ai_resp_material: 'Segue o link do site: liciteagora.app',
  });
  const CFG_D = { ...CFG, fim: { qualificado: 'Perfeito! Alguém da equipe já vem falar com você.',
                                 desqualificado: 'Entendi, obrigado pelo seu tempo.' } };
  const rotD = Number(insRoteiro.run('Com fim', CFG_D.corte, JSON.stringify(CFG_D)).lastInsertRowid);

  await t('D1 pedido de atendente: mensagem do CANAL, e pede pausa da IA', () => {
    const c = comRoteiro(33, '5594991110033', 'Desvio Um', rotD);
    const d = RC.desvioDaMensagem(db, c, 'quero falar com uma pessoa, por favor');
    assert(d && d.tipo === 'atendente' && d.pausarIA === true, JSON.stringify(d));
    assert(d.texto === RESP_PESSOA, 'não saiu a mensagem do canal: ' + d.texto);
    assert(!/vende para órgão/i.test(d.texto), 'quem pediu uma pessoa recebeu a pergunta do roteiro junto');
    for (const frase of ['pode me ligar?', 'tem um atendente aí', 'me liga', 'quero conversar com alguém',
                         'queria falar com um vendedor']) {
      assert(RC.desvioDaMensagem(db, c, frase)?.tipo === 'atendente', 'não reconheceu: ' + frase);
    }
  });

  await t('D1b negacao e resposta legitima do roteiro NAO desviam', () => {
    const c = db.prepare('SELECT * FROM conv_conversas WHERE id = 33').get();
    assert(!RC.desvioDaMensagem(db, c, 'não quero falar com atendente'), 'a negação desviou');
    // Os rótulos do roteiro de alimentação do 1bit, que custaram esta guarda:
    // com "alguém" ou "gerente" soltos como gatilho, responder a etapa do estoque
    // pararia o atendimento automático da conversa.
    assert(!RC.desvioDaMensagem(db, c, 'Alguém anota em caderno ou planilha'), 'um rótulo do roteiro desviou');
    assert(!RC.desvioDaMensagem(db, c, 'o gerente, de uma em uma semana'), '"gerente" desviou');
    assert(!RC.desvioDaMensagem(db, c, 'Vende muito'), 'uma resposta normal desviou');
  });

  await t('D2 pedido de material: o link do canal mais a pergunta da etapa', () => {
    const c = comRoteiro(34, '5594991110034', 'Desvio Dois', rotD);
    for (const frase of ['me manda o link', 'tem o site de vocês?', 'qual o aplicativo', 'manda o pdf',
                         'queria ver o catálogo', 'link']) {
      assert(RC.desvioDaMensagem(db, c, frase)?.tipo === 'material', 'não reconheceu: ' + frase);
    }
    const d = RC.desvioDaMensagem(db, c, 'me manda o link do site');
    assert(d.pausarIA === false, 'o pedido de material pediu pausa');
    assert(d.texto.startsWith('Segue o link do site: liciteagora.app'), 'não saiu o material do canal: ' + d.texto);
    assert(/Sua empresa vende para órgão público\?/.test(d.texto), 'não repetiu a pergunta da etapa: ' + d.texto);
    assert(/1\) Vende\n2\) Vende muito/.test(d.texto), 'a pergunta foi sem as opções numeradas: ' + d.texto);
  });

  await t('D3 sem a mensagem no canal nao desvia, e o roteiro terminado manda so o material', async () => {
    const c = comRoteiro(35, '5594991110035', 'Desvio Tres', rotD);
    // UM dos dois configurado não liga o outro.
    canais.salvarConfigCanal(db, 1, { whatsapp_ai_resp_material: '' });
    assert(!RC.desvioDaMensagem(db, c, 'me manda o link'), 'desviou sem a mensagem de material no canal');
    assert(RC.desvioDaMensagem(db, c, 'me liga')?.tipo === 'atendente', 'o desvio de pessoa parou de funcionar');
    canais.salvarConfigCanal(db, 1, { whatsapp_ai_resp_pessoa: '' });
    assert(!RC.desvioDaMensagem(db, c, 'me liga'), 'desviou sem a mensagem de pessoa no canal');
    canais.salvarConfigCanal(db, 1, { whatsapp_ai_resp_pessoa: RESP_PESSOA,
      whatsapp_ai_resp_material: 'Segue o link do site: liciteagora.app' });
    // Roteiro já fechado: vai só o material, sem pergunta nenhuma atrás.
    const c2 = comRoteiro(36, '5594991110036', 'Desvio Quatro', rotD);
    RC.gravar(db, c2, db.prepare('SELECT * FROM roteiros WHERE id = ?').get(rotD),
              { vende: 'grande', dor: 'mao' }, { usuario: 'teste' });
    assert(R.estado(CFG_D, { vende: 'grande', dor: 'mao' }).fim, 'o fixture não fecha o roteiro');
    const d = RC.desvioDaMensagem(db, c2, 'me manda o link');
    assert(d && d.texto === 'Segue o link do site: liciteagora.app', 'com o roteiro fechado, veio pergunta junto: ' + d.texto);
  });

  await t('D5 a mensagem de fim sai por desfecho, literal, e tira o proximoPasso do prompt', () => {
    const c = comRoteiro(39, '5594991110039', 'Fim Um', rotD);
    assert(RC.mensagemDeTermino(db, c, 'qualificado') === CFG_D.fim.qualificado, 'fim do qualificado errado');
    assert(RC.mensagemDeTermino(db, c, 'desqualificado') === CFG_D.fim.desqualificado, 'fim do desqualificado errado');
    assert(RC.mensagemDeTermino(db, c, null) === '', 'devolveu mensagem sem desfecho');
    // Com a mensagem escrita, o `proximoPasso` NÃO vai ao prompt: ela já foi
    // enviada, e repetir a ordem faria a IA oferecer o link outra vez.
    RC.gravar(db, c, db.prepare('SELECT * FROM roteiros WHERE id = ?').get(rotD),
              { vende: 'grande', dor: 'mao' }, { usuario: 'teste' });
    const bloco = RC.blocoParaIA(db, 39);
    assert(/ROTEIRO CONCLUÍDO/.test(bloco), bloco);
    assert(!/Próximo passo/.test(bloco), 'o proximoPasso foi ao prompt mesmo com a mensagem de fim: ' + bloco);
    // E o roteiro SEM mensagem de fim continua levando o proximoPasso, como antes.
    const c5 = comRoteiro(40, '5594991110040', 'Fim Dois', rotA);
    RC.gravar(db, c5, db.prepare('SELECT * FROM roteiros WHERE id = ?').get(rotA),
              { vende: 'grande', dor: 'mao' }, { usuario: 'teste' });
    assert(/Próximo passo/.test(RC.blocoParaIA(db, 40)), 'o roteiro sem mensagem de fim perdeu o proximoPasso');
  });

  await t('D4 o editor grava e devolve o fim, e recusa mensagem que nao e texto', async () => {
    const cfg = JSON.parse(JSON.stringify(CFG_D));
    const criado = await pedir('/api/roteiros', 'POST', { nome: 'Fim pela rota', canal: 'whatsapp', config: cfg });
    assert(criado.corpo.success, JSON.stringify(criado.corpo));
    const lido = await pedir('/api/roteiros/' + criado.corpo.id + '?cru=1');
    assert(lido.corpo.roteiro.config.fim.desqualificado === cfg.fim.desqualificado, JSON.stringify(lido.corpo.roteiro.config.fim));
    // Objeto no lugar do texto sairia "[object Object]" no WhatsApp do cliente.
    const ruim = await pedir('/api/roteiros', 'POST',
      { nome: 'Fim torto', canal: 'whatsapp', config: { ...cfg, fim: { qualificado: { msg: 'oi' } } } });
    assert(ruim.status === 400 && /precisa ser texto/.test(JSON.stringify(ruim.corpo)), JSON.stringify(ruim.corpo));
    // Variável sem valor continua recusada, e é o que impede o buraco na frase.
    const semValor = await pedir('/api/roteiros', 'POST',
      { nome: 'Sem valor', canal: 'whatsapp', config: { ...cfg, fim: { qualificado: 'Acesse {{linkMaterial}}' } } });
    assert(semValor.status === 400 && /linkMaterial/.test(JSON.stringify(semValor.corpo)), JSON.stringify(semValor.corpo));
  });

  // ==================== Q11. a tela ====================
  const puppeteer = require('puppeteer-core');
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-roteiros-'));
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: perfil, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));
  const abrir = async (tela, largura = 1280) => {
    const page = await browser.newPage();
    await page.setViewport({ width: largura, height: 900 });
    const erros = [];
    page.on('pageerror', e => erros.push(String(e.message)));
    page.on('dialog', d => d.accept());
    await page.goto(base + '/__wrapper/comunicacao/' + tela, { waitUntil: 'networkidle0' });
    const frame = page.frames().find(f => f.url().includes('/comunicacao/' + tela.split('?')[0] + '.html'));
    return { page, frame, erros };
  };

  await t('Q11a a tela cria um roteiro com duas etapas e a resposta que encerra', async () => {
    const { page, frame, erros } = await abrir('roteiros');
    await frame.waitForSelector('#tbRoteiros [data-editar]', { timeout: 8000 });
    await frame.click('#btnNovo');
    await frame.type('#rNome', 'Pela tela');
    await frame.click('#btnEtapa');
    await frame.click('#btnEtapa');
    const preencher = async (sel, v) => { await frame.$eval(sel, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, v); };
    await preencher('textarea[data-e="0"][data-campo="texto"]', 'Vende para governo?');
    await preencher('input[data-e="0"][data-r="0"][data-campo="rotulo"]', 'Sim, já vende');
    await preencher('input[data-e="0"][data-r="0"][data-campo="peso"]', '2');
    await preencher('input[data-e="0"][data-r="1"][data-campo="rotulo"]', 'Não');
    await preencher('select[data-e="0"][data-r="1"][data-campo="depois"]', 'encerra');
    await preencher('textarea[data-e="1"][data-campo="texto"]', 'Como acha os editais?');
    await preencher('input[data-e="1"][data-r="0"][data-campo="rotulo"]', 'Na mão');
    await preencher('input[data-e="1"][data-r="1"][data-campo="rotulo"]', 'Sistema');
    await frame.$eval('#rCorte', e => { e.value = '2'; });
    await frame.select('#rFunil', '2');
    await frame.click('#btnSalvar');
    await esperar(800);
    const linha = db.prepare("SELECT * FROM roteiros WHERE nome = 'Pela tela' AND ativo = 1").get();
    assert(linha, 'não gravou: ' + await frame.$eval('#alertGlobal', e => e.textContent));
    const c = JSON.parse(linha.config);
    assert(c.perguntas.length === 2 && c.perguntas[0].opcoes[1].encerra === true && c.perguntas[0].opcoes[0].peso === 2, linha.config);
    assert(c.perguntas[0].opcoes[0].id === 'sim_ja_vende' && c.funilId === 2 && c.corte === 2, linha.config);
    assert(await frame.$eval('#lista', e => getComputedStyle(e).display !== 'none'), 'não voltou para a lista');
    assert(!erros.length, erros.join(' | '));
    await page.close();
  });

  await t('Q11b editar preserva o que a tela nao mostra e o id das respostas', async () => {
    const extra = { ...CFG, objecoes: [{ chave: 'preco', rotulo: 'Preço', resposta: 'R$ 297' }] };
    db.prepare('UPDATE roteiros SET config = ? WHERE id = ?').run(JSON.stringify(extra), rotA);
    const { page, frame, erros } = await abrir('roteiros');
    await frame.waitForSelector(`#tbRoteiros [data-editar]`, { timeout: 8000 });
    const idx = await frame.$$eval('#tbRoteiros tr', (trs) => trs.findIndex(tr => tr.textContent.includes('Licitações')));
    await frame.click(`#tbRoteiros [data-editar="${idx}"]`);
    await frame.waitForSelector('textarea[data-e="0"]', { timeout: 5000 });
    await frame.$eval('input[data-e="0"][data-r="0"][data-campo="rotulo"]', e => { e.value = 'Vende sim'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await frame.click('#btnSalvar');
    await esperar(800);
    const c = JSON.parse(db.prepare('SELECT config FROM roteiros WHERE id = ?').get(rotA).config);
    assert(c.objecoes && c.objecoes[0].resposta === 'R$ 297', 'perdeu as objeções');
    assert(c.perguntas[0].opcoes[0].id === 'sim' && c.perguntas[0].opcoes[0].rotulo === 'Vende sim', 'trocou o id da resposta: ' + JSON.stringify(c.perguntas[0].opcoes[0]));
    assert(c.perguntas[0].opcoes[1].vaiPara === 'dor', 'perdeu o pulo');
    assert(!erros.length, erros.join(' | '));
    await page.close();
  });

  await t('Q11c a campanha legado mostra e grava o roteiro escolhido', async () => {
    const { page, frame, erros } = await abrir('campanha?id=5');
    await frame.waitForFunction(() => document.querySelectorAll('#cRoteiro option').length > 1, { timeout: 8000 });
    assert(await frame.$eval('#cRoteiro', e => e.value) === String(rotA), 'não mostrou o roteiro da campanha');
    assert(await frame.$eval('#s-roteiro', e => e.offsetHeight > 0), 'a seção não aparece na legado');
    await frame.select('#cRoteiro', String(rotB));
    await frame.evaluate(() => salvar());
    await esperar(800);
    assert(JSON.parse(db.prepare('SELECT config FROM wa_campanhas WHERE id = 5').get().config).roteiro_id === rotB, 'não gravou');
    assert(!erros.length, erros.join(' | '));
    await page.close();
  });

  await t('Q11d a campanha nova mostra e grava o roteiro escolhido', async () => {
    const id = db.prepare('SELECT id FROM comm_campanhas WHERE roteiroId = ? ORDER BY id DESC').get(rotA).id;
    const { page, frame, erros } = await abrir('campanha?comm=' + id);
    await frame.waitForFunction(() => document.querySelectorAll('#cRoteiro option').length > 1 && document.getElementById('cRoteiro').value, { timeout: 8000 });
    assert(await frame.$eval('#cRoteiro', e => e.value) === String(rotA), 'não mostrou o roteiro da campanha');
    await frame.select('#cRoteiro', '');
    await frame.evaluate(() => salvar());
    await esperar(800);
    assert(db.prepare('SELECT roteiroId FROM comm_campanhas WHERE id = ?').get(id).roteiroId === null, 'não tirou o roteiro');
    assert(!erros.length, erros.join(' | '));
    await page.close();
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
});
