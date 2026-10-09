/**
 * O FIO entre o webhook, os desvios do atendimento e o fim do roteiro.
 *
 * As regras puras vivem na suíte 150 (`roteiros.js`, `roteiro-conversa.js`).
 * Esta prova o que o SISTEMA faz com elas: que o `autoResponder` as consulta
 * antes de chamar a IA, que a mensagem sai pelo mesmo caminho da resposta do
 * modelo, e que o efeito no banco acontece. Sem ela, esquecer a chamada no
 * webhook passaria verde — as regras continuariam certas e nenhuma etapa
 * reclamaria.
 *
 * O `conversas-routes` entra de VERDADE, e não como dublê: a pausa é o efeito
 * que se quer provar, e um stub de `pausarIA` provaria apenas que a chamada
 * existe.
 *
 *  W1  pedido de uma pessoa: mensagem do CANAL, pausa com contador, não lida,
 *      evento, e o LLM não é chamado
 *  W2  pedido do link: material do canal mais a pergunta da etapa
 *  W2b fora de campanha (sem roteiro) o material TAMBÉM sai — era o buraco que
 *      motivou tirar as mensagens do roteiro
 *  W3  mensagem comum segue para a IA, como antes
 *  W4  as guardas do atendimento vêm ANTES do desvio: com a IA desligada à mão,
 *      o desvio não responde
 *  W5  roteiro fechado QUALIFICADO: mensagem literal do roteiro e pausa
 *  W6  roteiro fechado DESQUALIFICADO: mensagem literal e NENHUMA pausa
 *  W7  a promessa da IA na resposta pausa e chama gente
 *  W8  o elo: `qualificarPeloRoteiro` diz o desfecho na passagem que fecha, e
 *      silencia nas seguintes
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');

// ── os dublês, instalados ANTES de carregar o webhook ──────────────────────
//
// O `enviarWhatsApp` é desestruturado no topo do `whatsapp-webhook.js`, então a
// substituição precisa estar no cache antes do require dele. Nada aqui fala com
// a Evolution nem com provedor de IA.
const enviadas = [];
let chamadasLLM = 0;
let CONFIG_CANAL = {};
require.cache[require.resolve('../whatsapp-adapter')] = { exports: {
  migrarQueue: () => {},
  enviarWhatsApp: async (_db, { texto }) => { enviadas.push(texto); return { providerMessageId: 'm' + enviadas.length }; },
  configDoAtendimento: () => (chave) => (CONFIG_CANAL[chave] || ''),
  buildSystemAtendimento: () => 'prompt do atendimento',
  FALLBACK_SEM_RESPOSTA: 'Vou encaminhar para um atendente.',
} };
require.cache[require.resolve('../atendimento-horario')] = { exports: { foraDoExpediente: () => null } };
let respostaDaIA = 'resposta da IA';
require.cache[require.resolve('../chat-ia')] = { exports: {
  chamarChatLLM: async () => { chamadasLLM++; return { content: respostaDaIA, provider: 'groq' }; },
} };
require.cache[require.resolve('../ia-modelos')] = { exports: { resolverModelos: () => ({}) } };
require.cache[require.resolve('../audit-log')] = { exports: { logAction: () => {} } };
// O aviso da pausa não sai daqui: o que se prova é a pausa, e o despachante
// falaria com Telegram e SMTP de verdade.
const avisos = [];
require.cache[require.resolve('../notificacoes-dispatcher')] = { exports: {
  lerCanais: () => ({ telegram: false, email: false, destinatarios: [] }),
  enviarAlerta: async (_db, a) => { avisos.push(a); },
} };

const RC = require('../roteiro-conversa');
const CR = require('../conversas-routes');
const { autoResponder, prometeuAtendimentoHumano, qualificarPeloRoteiro, handleIncoming } = require('../whatsapp-webhook');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desvio-webhook-'));
const db = new Database(path.join(dir, 'pncp.db'));
db.exec(require('./schema-de-tenant').lerSchema());
db.pragma('foreign_keys = OFF');
require('../whatsapp-canais').migrarCanais(db);
for (const t of ['roteiros', 'roteiro_visitas', 'conv_conversas', 'conv_eventos', 'whatsapp_messages',
  'comm_campanhas', 'comm_envios', 'whatsapp_canais', 'crm_funis', 'crm_etapas']) {
  try { db.exec(`DELETE FROM ${t}`); } catch (_) {}
}
db.prepare("INSERT INTO whatsapp_canais (id, nome, instance, padrao, config) VALUES (1, 'Principal', 'inst1', 1, '{}')").run();
db.prepare("INSERT INTO config (chave, valor) VALUES ('groq_api_key', 'chave-falsa')").run();
RC.migrar(db);

const RESP_PESSOA = 'Obrigado pela paciência! Alguém da equipe já está vindo para falar com você.';
const RESP_MATERIAL = 'Segue o link do site: liciteagora.app';
const FIM_QUALIFICADO = 'Perfeito, obrigado! Alguém da equipe já está vindo para falar com você.';
const FIM_DESQUALIFICADO = 'Entendi, obrigado pelo seu tempo. Qualquer coisa, estou por aqui.';
const PADRAO_CANAL = {
  whatsapp_ai_enabled: '1', whatsapp_ai_escopo: 'todos',
  whatsapp_ai_resp_pessoa: RESP_PESSOA, whatsapp_ai_resp_material: RESP_MATERIAL,
};

const CFG = {
  corte: 1, fim: { qualificado: FIM_QUALIFICADO, desqualificado: FIM_DESQUALIFICADO },
  perguntas: [{ chave: 'vende', texto: 'Sua empresa vende para órgão público?', opcoes: [
    { id: 'sim', rotulo: 'Vende', peso: 1 }, { id: 'nao', rotulo: 'Não vende', peso: 0 }] }],
};
const rot = Number(db.prepare("INSERT INTO roteiros (nome, canal, corte, padrao, ativo, config) VALUES ('Com fim', 'whatsapp', 1, 0, 1, ?)")
  .run(JSON.stringify(CFG)).lastInsertRowid);

const CANAL = { id: 1, instance: 'inst1' };
const conversa = (id, tel, comRoteiro) => {
  const jid = tel + '@s.whatsapp.net';
  db.prepare("INSERT INTO conv_conversas (id, canal, jid, telefone, nome, canalId) VALUES (?, 'whatsapp', ?, ?, 'Teste', 1)")
    .run(id, jid, tel);
  if (comRoteiro) {
    const camp = Number(db.prepare(`INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status, roteiroId, canais)
      VALUES ('Camp', 1, 1, 'whatsapp', 'enviada', ?, '[1]')`).run(rot).lastInsertRowid);
    db.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio, canalId, rodada)
      VALUES (?, 'whatsapp', ?, 'enviado', '2023-11-13T00:00:00.000Z', 1, 1)`).run(camp, tel);
  }
  return { id, jid, tel };
};

const receber = async (c, texto, opts = {}) => {
  db.prepare("INSERT INTO whatsapp_messages (instance, remote_jid, from_me, texto, timestamp) VALUES ('inst1', ?, 0, ?, ?)")
    .run(c.jid, texto, Math.floor(Date.now() / 1000));
  enviadas.length = 0; chamadasLLM = 0; avisos.length = 0;
  await autoResponder(db, CANAL, 'inst1', c.jid, texto, opts);
};
// As guardas da W10 em diante moram no `handleIncoming`, e não no
// `autoResponder`: é ele que o webhook chama, e é onde a mensagem automática do
// contato e a fala repetida precisam morrer antes de gastar etapa do roteiro.
// `from_bot` acompanha `from_me`, como na campanha e na resposta da IA: nossa
// mensagem gravada sem a marca é "um humano respondeu à mão", e isso PAUSA a IA
// por 4 h — o fixture calaria o atendimento e a etapa mediria outra coisa.
const gravarMsg = (c, texto, { deMim = false, atrasoS = 0 } = {}) =>
  db.prepare('INSERT INTO whatsapp_messages (instance, remote_jid, from_me, from_bot, texto, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run('inst1', c.jid, deMim ? 1 : 0, deMim ? 1 : 0, texto, Math.floor(Date.now() / 1000) + atrasoS);
const porWebhook = async (c, texto) => {
  gravarMsg(c, texto);
  await handleIncoming(db, CANAL, 'inst1', c.jid, texto);
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const ficha = (id) => db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(id);
const pausada = (c) => CR.pausaDaIA(db, { jid: c.jid, canalId: 1, conversaId: c.id }).pausada;
const eventos = (id) => db.prepare("SELECT detalhe FROM conv_eventos WHERE conversaId = ? AND tipo = 'ia' ORDER BY id DESC").all(id).map(r => r.detalhe);

let ok = 0, fail = 0;
const assert = (c, m) => { if (!c) throw new Error(m); };
const t = async (nome, fn) => {
  CONFIG_CANAL = { ...PADRAO_CANAL };
  respostaDaIA = 'resposta da IA';
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};

(async () => {
  await t('W1 pedido de uma pessoa: mensagem do CANAL, pausa com contador e aviso', async () => {
    const c = conversa(7, '5594991112222', true);
    await receber(c, 'queria falar com uma pessoa');
    assert(chamadasLLM === 0, 'o LLM foi chamado num desvio que não depende dele');
    assert(enviadas.length === 1 && enviadas[0] === RESP_PESSOA, 'saiu outro texto: ' + enviadas[0]);
    assert(pausada(c), 'a IA não foi pausada depois de o contato pedir uma pessoa');
    assert(ficha(7).iaAtiva === 1, 'DESLIGOU a IA; o desenho é pausar, que tem contador e volta sozinha');
    assert(ficha(7).naoLidas === 1, 'a conversa não subiu para as não lidas: ' + ficha(7).naoLidas);
    assert(eventos(7).some(d => /pausada: o contato pediu/.test(d)), 'sem evento no histórico: ' + eventos(7));
    assert(avisos.length === 1 && /assumir uma conversa/.test(avisos[0].subject), 'ninguém foi avisado: ' + JSON.stringify(avisos));
    const m = db.prepare('SELECT from_me, from_bot FROM whatsapp_messages WHERE remote_jid = ? ORDER BY id DESC LIMIT 1').get(c.jid);
    assert(m.from_me === 1 && m.from_bot === 1, 'a mensagem do desvio não ficou marcada como nossa');
  });

  await t('W4 com a IA desligada a mao, o desvio NAO responde', async () => {
    const c = { id: 7, jid: '5594991112222@s.whatsapp.net' };
    db.prepare('UPDATE conv_conversas SET iaAtiva = 0 WHERE id = 7').run();
    await receber(c, 'me manda o link');
    assert(enviadas.length === 0, 'respondeu numa conversa com a IA desligada: ' + enviadas[0]);
    db.prepare('UPDATE conv_conversas SET iaAtiva = 1, naoLidas = 0 WHERE id = 7').run();
    db.prepare("INSERT INTO conv_eventos (conversaId, tipo, detalhe, usuario) VALUES (7, 'ia', 'retomada', 't')").run();
  });

  await t('W2 pedido do link: material do canal mais a pergunta da etapa', async () => {
    const c = conversa(8, '5594991113333', true);
    await receber(c, 'tem o site de vocês?');
    assert(chamadasLLM === 0, 'o LLM foi chamado para entregar o material');
    assert(enviadas.length === 1, 'enviou ' + enviadas.length + ' mensagem(ns)');
    assert(enviadas[0].startsWith(RESP_MATERIAL), 'não saiu o material do canal: ' + enviadas[0]);
    assert(/Sua empresa vende para órgão público\?/.test(enviadas[0]), 'não repetiu a pergunta: ' + enviadas[0]);
    assert(/1\) Vende\n2\) Não vende/.test(enviadas[0]), 'a pergunta saiu sem as opções numeradas: ' + enviadas[0]);
    assert(!pausada(c), 'entregar o link pausou a IA');
  });

  // O buraco que motivou tirar as mensagens do roteiro: quem vê um anúncio e
  // pergunta o link nunca passou por campanha.
  await t('W2b fora de campanha, sem roteiro no tenant, o material sai SOZINHO', async () => {
    const c = conversa(10, '5594991114444', false);
    // Desde 05/10/2026 "fora de campanha" não quer mais dizer "sem roteiro":
    // quem nunca recebeu campanha cai no roteiro padrão do tenant, que é o que
    // dá roteiro ao Messenger, ao Instagram e ao Click-to-WhatsApp. Para medir
    // o material SOZINHO, que é o que esta etapa guarda, o tenant tem de estar
    // sem roteiro ativo nenhum.
    db.prepare('UPDATE roteiros SET ativo = 0').run();
    try {
      assert(!RC.roteiroDaConversa(db, ficha(10)), 'o fixture tem roteiro e não devia');
      await receber(c, 'manda o link do site');
      assert(chamadasLLM === 0, 'chamou o LLM fora de campanha');
      assert(enviadas.length === 1 && enviadas[0] === RESP_MATERIAL, 'não saiu só o material: ' + enviadas[0]);
    } finally {
      // Restaura mesmo se a asserção falhar: sem isto, toda etapa daqui para
      // baixo mediria um tenant sem roteiro e falharia em cascata, escondendo
      // qual foi o defeito de verdade.
      db.prepare('UPDATE roteiros SET ativo = 1 WHERE id = ?').run(rot);
    }
  });

  await t('W2c fora de campanha COM roteiro no tenant, o roteiro entra', async () => {
    const c = conversa(20, '5594991114445', false);
    assert(RC.roteiroDaConversa(db, ficha(20))?.id === rot,
      'quem nunca recebeu campanha devia cair no roteiro padrao do tenant');
    await receber(c, 'manda o link do site');
    assert(enviadas.length === 1, 'nao respondeu: ' + JSON.stringify(enviadas));
    assert(enviadas[0].startsWith(RESP_MATERIAL), 'nao saiu o material do canal: ' + enviadas[0]);
    assert(/Sua empresa vende para órgão público\?/.test(enviadas[0]),
      'o roteiro entrou mas a pergunta da etapa nao saiu: ' + enviadas[0]);
  });

  await t('W3 mensagem comum segue para a IA, como antes', async () => {
    const c = conversa(11, '5594991115555', true);
    respostaDaIA = 'O sistema monitora o Comprasnet e o PNCP.';
    await receber(c, 'bom dia, tudo bem?');
    assert(chamadasLLM === 1, 'a IA não foi chamada numa mensagem comum');
    assert(enviadas.length === 1 && enviadas[0].startsWith(respostaDaIA),
      'o desvio engoliu a mensagem: ' + enviadas[0]);
    assert(!pausada(c), 'uma resposta comum pausou a IA');
  });

  await t('W5 roteiro fechado QUALIFICADO: mensagem literal do roteiro e pausa', async () => {
    const c = conversa(12, '5594991116666', true);
    await receber(c, 'vendo sim', { fechouAgora: 'qualificado' });
    assert(chamadasLLM === 0, 'chamou o LLM no fim do roteiro, em vez de usar a mensagem escrita');
    assert(enviadas.length === 1 && enviadas[0] === FIM_QUALIFICADO, 'não saiu a mensagem de término: ' + enviadas[0]);
    assert(pausada(c), 'o roteiro terminou prometendo gente e não pausou a IA');
    assert(avisos.length === 1, 'ninguém foi avisado do fim do roteiro');
  });

  await t('W6 roteiro fechado DESQUALIFICADO: mensagem literal e NENHUMA pausa', async () => {
    const c = conversa(13, '5594991117777', true);
    await receber(c, 'não vendo', { fechouAgora: 'desqualificado' });
    assert(enviadas.length === 1 && enviadas[0] === FIM_DESQUALIFICADO, 'não saiu a despedida: ' + enviadas[0]);
    assert(!pausada(c), 'pausou a IA para quem foi descartado: não há ninguém para chamar');
    assert(avisos.length === 0, 'avisou a equipe sobre um descarte');
  });

  await t('W5b sem mensagem de fim configurada, o fim cai na IA como antes', async () => {
    const semFim = Number(db.prepare("INSERT INTO roteiros (nome, canal, corte, padrao, ativo, config) VALUES ('Sem fim', 'whatsapp', 1, 0, 1, ?)")
      .run(JSON.stringify({ corte: 1, perguntas: CFG.perguntas, proximoPasso: 'Mande o link do teste.' })).lastInsertRowid);
    const c = conversa(14, '5594991118888', false);
    const camp = Number(db.prepare(`INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status, roteiroId, canais)
      VALUES ('C2', 1, 1, 'whatsapp', 'enviada', ?, '[1]')`).run(semFim).lastInsertRowid);
    db.prepare(`INSERT INTO comm_envios (campanhaId, canal, destino, status, dataEnvio, canalId, rodada)
      VALUES (?, 'whatsapp', ?, 'enviado', '2023-11-13T00:00:00.000Z', 1, 1)`).run(camp, c.tel);
    respostaDaIA = 'Tudo certo por aqui.';
    await receber(c, 'vendo sim', { fechouAgora: 'qualificado' });
    assert(chamadasLLM === 1, 'não caiu na IA com o roteiro sem mensagem de fim');
    assert(enviadas[0].startsWith(respostaDaIA), 'saiu outra coisa: ' + enviadas[0]);
  });

  await t('W7 a promessa da IA na resposta pausa e chama gente', async () => {
    const c = conversa(15, '5594991119999', true);
    respostaDaIA = 'Não tenho esse dado aqui. Vou pedir ao Carlos para responder pessoalmente.';
    await receber(c, 'qual o prazo do contrato de 5 anos?');
    assert(chamadasLLM === 1, 'não passou pela IA');
    assert(enviadas[0].startsWith(respostaDaIA), 'a resposta da IA não saiu: ' + enviadas[0]);
    assert(pausada(c), 'a IA prometeu gente e não pausou');
    assert(eventos(15).some(d => /a IA disse que alguém/.test(d)), 'sem evento: ' + eventos(15));
    assert(avisos.length === 1, 'ninguém foi avisado da promessa');
    assert(prometeuAtendimentoHumano(respostaDaIA), 'a detecção não reconhece a própria frase');
  });

  // O buraco que faltava: trocar a condição do envio por "o roteiro ESTÁ
  // fechado" faria a mensagem de término sair a cada mensagem do contato, e
  // nenhuma checagem reprovaria — a W8 mede o elo, não o envio.
  await t('W9 roteiro JA fechado: mensagem comum nao repete o termino', async () => {
    const c = conversa(17, '5594991110002', true);
    RC.gravar(db, ficha(17), db.prepare('SELECT * FROM roteiros WHERE id = ?').get(rot),
              { vende: 'sim' }, { usuario: 'teste' });
    const reg = RC.registroDa(db, 17);
    assert(reg && reg.resultado === 'qualificado', 'o fixture não fechou o roteiro: ' + JSON.stringify(reg));
    respostaDaIA = 'Claro, pode perguntar.';
    await receber(c, 'uma dúvida: vocês atendem em Marabá?');
    assert(enviadas.length === 1, 'enviou ' + enviadas.length + ' mensagem(ns)');
    assert(enviadas[0] !== FIM_QUALIFICADO, 'repetiu a mensagem de término numa mensagem comum');
    assert(chamadasLLM === 1, 'não passou pela IA com o roteiro já fechado');
  });

  await t('W8 o elo: qualificarPeloRoteiro diz o desfecho SO na passagem que fecha', async () => {
    const c = conversa(16, '5594991110001', true);
    db.prepare("INSERT INTO whatsapp_messages (instance, remote_jid, from_me, texto, timestamp) VALUES ('inst1', ?, 1, ?, ?)")
      .run(c.jid, 'Sua empresa vende para órgão público?\n1) Vende\n2) Não vende', Math.floor(Date.now() / 1000) - 10);
    db.prepare("INSERT INTO whatsapp_messages (instance, remote_jid, from_me, texto, timestamp) VALUES ('inst1', ?, 0, '1', ?)")
      .run(c.jid, Math.floor(Date.now() / 1000));
    const primeira = await qualificarPeloRoteiro(db, CANAL, c.jid);
    assert(primeira === 'qualificado', 'a passagem que fecha não disse o desfecho: ' + primeira);
    const segunda = await qualificarPeloRoteiro(db, CANAL, c.jid);
    assert(segunda === null, 'disse de novo na passagem seguinte, e a mensagem de término sairia duas vezes: ' + segunda);
  });

  await t('W10 saudacao automatica do contato: nada sai, e a etapa NAO e gasta', async () => {
    const c = conversa(21, '5594991110003', true);
    enviadas.length = 0;
    await porWebhook(c, '‎Dr. Cell agradece seu contato. Como podemos ajudar?');
    assert(enviadas.length === 0, 'respondeu ao atendimento automatico do contato: ' + enviadas[0]);
    assert(!RC.registroDa(db, 21), 'o roteiro gastou etapa falando com uma maquina');
    // E a etapa continua esperando: quando o contato escreve, ela sai.
    respostaDaIA = 'Claro! Sua empresa vende para órgão público?';
    await porWebhook(c, 'oi, vi a mensagem de vocês, me conta mais');
    assert(enviadas.length === 1 && enviadas[0].startsWith(respostaDaIA),
      'calou tambem para o contato de verdade: ' + JSON.stringify(enviadas));
  });

  await t('W11 a frase de bot sozinha nao basta: fora da janela, responde', async () => {
    const c = conversa(22, '5594991110004', true);
    const FRASE = 'Agradecemos o contato. Um representante falará com você em breve.';
    gravarMsg(c, 'Olá! Todo dia prefeituras abrem licitações…', { deMim: true, atrasoS: -600 });
    enviadas.length = 0;
    await porWebhook(c, FRASE);
    assert(enviadas.length === 1, 'calou por causa da frase, com a nossa mensagem de 10 minutos atras: '
      + JSON.stringify(enviadas));
    // A mesma frase logo depois de falarmos é a autoresposta, e aí cala.
    const d = conversa(23, '5594991110005', true);
    gravarMsg(d, 'Olá! Todo dia prefeituras abrem licitações…', { deMim: true });
    enviadas.length = 0;
    await porWebhook(d, FRASE);
    assert(enviadas.length === 0, 'respondeu a autoresposta que chegou na hora: ' + enviadas[0]);
  });

  await t('W12 duas mensagens seguidas recebem UMA resposta', async () => {
    const c = conversa(24, '5594991110006', true);
    respostaDaIA = 'Sua empresa vende para órgão público?';
    enviadas.length = 0; chamadasLLM = 0;
    // Como no webhook: duas passagens concorrentes, sem await entre elas.
    const primeira = porWebhook(c, 'Claro');
    await dormir(300);
    const segunda = porWebhook(c, 'Boa noite');
    await Promise.all([primeira, segunda]);
    assert(enviadas.length === 1, 'enviou ' + enviadas.length + ' resposta(s) para duas mensagens seguidas: '
      + JSON.stringify(enviadas));
    assert(enviadas[0].startsWith(respostaDaIA), 'saiu outra coisa no lugar da resposta: ' + enviadas[0]);
    // Quem respondeu foi a ÚLTIMA passagem, e ela leu as duas falas: o extrator
    // do roteiro só rodou uma vez, e não duas (uma chamada de LLM por passagem).
    assert(chamadasLLM <= 2, 'as duas passagens chamaram o LLM: ' + chamadasLLM);
  });

  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
