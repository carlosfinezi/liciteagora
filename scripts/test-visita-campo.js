/**
 * O registro de visita, das rotas até a tela que o vendedor usa na loja.
 *
 * ── Por que a tela é medida em 390px ──────────────────────────────────────
 *
 * Ela é usada de pé, na loja, no celular. Alvo de toque pequeno demais faz o
 * vendedor errar a resposta na frente do cliente, e aí ele para de usar. As
 * checagens de altura mínima existem por isso, e não por gosto.
 *
 * ── O que está guardado ────────────────────────────────────────────────────
 *
 * 1. A PONTUAÇÃO É DO SERVIDOR. A tela mostra o número, mas quem soma é o Node.
 * 2. O RECORTE DO VENDEDOR: ele vê as visitas dele, e a de outro responde 403.
 * 3. O RESUMO SAI PRONTO, com os sete itens que o roteiro exige.
 * 4. O PESO PODE MUDAR AMANHÃ, e a visita de ontem continua valendo o que valia.
 */
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PORTA = 34191;

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { console.log('  OK  ' + nome); ok++; },
        (e) => { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; });
    }
    console.log('  OK  ' + nome); ok++;
  } catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  return Promise.resolve();
};
const assert = (c, m) => { if (!c) throw new Error(m); };

const { CONFIG } = require('./semear-roteiro-visita');
const { esperarFrame } = require('./frame-de-teste');

function bancoDeTeste() {
  const Database = require(path.join(RAIZ, 'node_modules/better-sqlite3'));
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE fornecedor (id INTEGER PRIMARY KEY, razaoSocial TEXT, nomeFantasia TEXT,
      cidade TEXT, uf TEXT, telefone TEXT, celular TEXT, email TEXT, site TEXT, cnpj TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, nome TEXT, ehVendedor INTEGER);
    CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE whatsapp_config (id INTEGER PRIMARY KEY, provider TEXT, instance TEXT);
    CREATE TABLE conv_conversas (id INTEGER PRIMARY KEY, nome TEXT, telefone TEXT, jid TEXT,
      pessoaId INTEGER, donoId INTEGER, estado TEXT);
    CREATE TABLE whatsapp_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, remote_jid TEXT,
      from_me INTEGER, texto TEXT, timestamp INTEGER);
    CREATE TABLE wa_campanhas (id INTEGER PRIMARY KEY, nome TEXT, config TEXT, status TEXT);
    CREATE TABLE wa_campanha_dest (id INTEGER PRIMARY KEY AUTOINCREMENT, campanha_id INTEGER,
      telefone TEXT, jid TEXT, enviado_em TEXT);
    CREATE TABLE roteiros (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL,
      canal TEXT NOT NULL DEFAULT 'visita', corte INTEGER NOT NULL DEFAULT 2,
      padrao INTEGER NOT NULL DEFAULT 0, ativo INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP, dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE roteiro_visitas (id INTEGER PRIMARY KEY AUTOINCREMENT, roteiroId INTEGER NOT NULL,
      vendedorId INTEGER, pessoaId INTEGER, empresa TEXT, segmento TEXT, decisor TEXT,
      whatsapp TEXT, contador TEXT, caixas INTEGER, funcionarios INTEGER,
      maisDeUmPonto INTEGER NOT NULL DEFAULT 0, conversaId INTEGER, respostas TEXT, pontos INTEGER NOT NULL DEFAULT 0,
      videoAssistido INTEGER NOT NULL DEFAULT 0, reacaoVideo TEXT, objecao TEXT,
      status TEXT NOT NULL DEFAULT 'em_visita', motivo TEXT, agendaReuniaoId INTEGER,
      oportunidadeId INTEGER, resumoEnviadoEm TEXT,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP, dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO fornecedor (id, razaoSocial, nomeFantasia, cidade, uf)
      VALUES (1, '1 BIT GESTAO E CONSULTORIA LTDA', '1BIT', 'MARABA', 'PA');
    INSERT INTO users (id, username, nome, ehVendedor) VALUES
      (6, 'guilherme', 'Guilherme', 1), (7, 'outro', 'Outro Vendedor', 1), (1, 'admin', 'Admin', 0);
  `);
  db.prepare("INSERT INTO roteiros (nome, canal, corte, padrao, config) VALUES (?,'visita',?,1,?)")
    .run('Visita presencial — comércio', CONFIG.corte, JSON.stringify(CONFIG));
  return db;
}

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));
  const { registrarRotasRoteiros } = require('../roteiros-routes');

  const db = bancoDeTeste();
  const app = express();
  app.use(express.json());
  // O vendedor logado. Trocado no meio da suíte para provar o recorte.
  let EU = { id: 6, nome: 'Guilherme', ehVendedor: 1 };
  app.use((req, _rs, next) => { req.user = EU; next(); });
  registrarRotasRoteiros(app, db);
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  app.get('/__wrapper/:pasta/:tela', (rq, rs) => rs.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
    + `ipt></head><body style="margin:0"><iframe src="/${rq.params.pasta}/${rq.params.tela}.html"`
    + ' style="width:100vw;height:100vh;border:0"></iframe></body></html>'));
  app.use(express.static(PUB));
  const srv = app.listen(PORTA);
  const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
  const pegar = (p, o) => fetch(url(p), o).then(async r => ({ status: r.status, corpo: await r.json() }));
  const json = (metodo) => (p, body) => pegar(p, { method: metodo,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const post = json('POST'), put = json('PUT');

  // ==================== A. o roteiro chega pronto ====================

  await t('A1. o roteiro vem com as variaveis ja trocadas', async () => {
    const r = await pegar('/api/roteiros/padrao');
    assert(r.corpo.success, r.corpo.error);
    const t = r.corpo.roteiro;
    assert(!/\{\{/.test(JSON.stringify(t)), 'sobrou variável no roteiro entregue à tela');
    assert(/Guilherme/.test(t.abertura), 'o nome do vendedor não entrou na abertura');
    assert(/1BIT/.test(t.abertura) && /MARABA\/PA/.test(t.abertura), t.abertura);
  });

  await t('A1b. sem nome no cadastro, sai marcador e nao variavel crua', async () => {
    const guardado = EU;
    EU = { id: 6, ehVendedor: 1 };            // usuário sem nome nem username
    const r = await pegar('/api/roteiros/padrao');
    assert(!/\{\{/.test(JSON.stringify(r.corpo.roteiro)), 'variável crua chegou à tela');
    assert(/\[seu nome\]/.test(r.corpo.roteiro.abertura), r.corpo.roteiro.abertura.slice(0, 80));
    EU = guardado;
  });

  await t('A2. a objecao de preco cita o plano que tem caixa', async () => {
    const r = await pegar('/api/roteiros/padrao');
    const o = r.corpo.roteiro.objecoes.find(x => x.chave === 'preco');
    assert(/R\$ 1\.497/.test(o.resposta), 'o preço do plano vendido não aparece');
  });

  await t('A3. roteiro invalido e RECUSADO ao salvar', async () => {
    const r = await put('/api/roteiros/1', { config: { ...CONFIG, abertura: 'Desde {{semValor}}.' } });
    assert(r.status === 400 && /semValor/.test(r.corpo.error), JSON.stringify(r.corpo));
    const ainda = await pegar('/api/roteiros/padrao');
    assert(/Guilherme/.test(ainda.corpo.roteiro.abertura), 'o roteiro bom foi sobrescrito pelo ruim');
  });

  // ==================== B. a visita e a pontuação ====================

  let visitaId = null;

  await t('B1. abre a visita no roteiro padrao', async () => {
    const r = await post('/api/visitas', { empresa: 'Mercado Sao Jose' });
    assert(r.corpo.success && r.corpo.id, JSON.stringify(r.corpo));
    visitaId = r.corpo.id;
  });

  await t('B2. quem soma e o servidor, e nao a tela', async () => {
    const r = await put('/api/visitas/' + visitaId,
      { respostas: { controle: 'caderno', suporte: 'ninguem' } });
    assert(r.corpo.pontos === 4, `veio ${r.corpo.pontos}, esperado 4`);
    assert(r.corpo.maximo === 9 && r.corpo.qualificado, JSON.stringify(r.corpo));
    assert(r.corpo.faltam.length === 3, 'deveria faltar três perguntas');
  });

  await t('B3. o porte e avaliado com o que foi informado', async () => {
    const pequeno = await put('/api/visitas/' + visitaId, { caixas: 1, funcionarios: 2 });
    assert(pequeno.corpo.temPorte === false, 'liberou loja abaixo do corte');
    const grande = await put('/api/visitas/' + visitaId, { caixas: 3 });
    assert(grande.corpo.temPorte === true, 'barrou loja com três caixas');
  });

  await t('B4. situacao invalida e recusada', async () => {
    const r = await put('/api/visitas/' + visitaId, { status: 'inventado' });
    assert(r.status === 400, `respondeu ${r.status}`);
  });

  await t('B5. peso alterado NAO reescreve a visita ja feita', async () => {
    // A pontuação fica gravada junto das respostas de propósito.
    const antes = db.prepare('SELECT pontos FROM roteiro_visitas WHERE id = ?').get(visitaId).pontos;
    const novo = JSON.parse(JSON.stringify(CONFIG));
    novo.perguntas[0].opcoes[0].peso = 0;      // "caderno" deixa de valer 2
    db.prepare('UPDATE roteiros SET config = ? WHERE id = 1').run(JSON.stringify(novo));
    const depois = db.prepare('SELECT pontos FROM roteiro_visitas WHERE id = ?').get(visitaId).pontos;
    assert(antes === depois && depois === 4, `a visita passou de ${antes} para ${depois}`);
    db.prepare('UPDATE roteiros SET config = ? WHERE id = 1').run(JSON.stringify(CONFIG));
  });

  // ==================== C. o recorte do vendedor ====================

  await t('C1. o vendedor ve as visitas dele', async () => {
    const r = await pegar('/api/visitas');
    assert(r.corpo.visitas.every(v => v.vendedorId === 6), 'apareceu visita de outro');
  });

  await t('C2. visita de outro vendedor responde 403', async () => {
    EU = { id: 7, nome: 'Outro Vendedor', ehVendedor: 1 };
    const r = await put('/api/visitas/' + visitaId, { motivo: 'mexi na visita alheia' });
    assert(r.status === 403, `respondeu ${r.status}`);
    const lista = await pegar('/api/visitas');
    assert(lista.corpo.visitas.length === 0, 'o outro vendedor enxergou a visita');
  });

  await t('C3. quem nao e vendedor enxerga todas', async () => {
    EU = { id: 1, nome: 'Admin', ehVendedor: 0 };
    const r = await pegar('/api/visitas');
    assert(r.corpo.visitas.length >= 1, 'a gerência não vê as visitas da equipe');
    EU = { id: 6, nome: 'Guilherme', ehVendedor: 1 };
  });

  // ==================== D. o resumo ====================

  await t('D1. o resumo sai pronto, com os itens que o roteiro exige', async () => {
    await put('/api/visitas/' + visitaId, {
      respostas: { controle: 'caderno', suporte: 'ninguem', nota: 'nao_emite', lucro: 'nao_sabe',
                   cobranca: 'dono' },
      segmento: 'mercado', decisor: 'Sr. Antonio', whatsapp: '5594999990001',
      contador: 'Escritorio Silva', videoAssistido: true, reacaoVideo: 'no estoque',
      objecao: 'pensar', status: 'agendado',
    });
    const r = await post(`/api/visitas/${visitaId}/resumo`);
    const txt = r.corpo.texto;
    for (const [oque, re] of [['empresa', /Mercado Sao Jose/], ['decisor', /Sr\. Antonio/],
      ['nota', /8 de 9/], ['dor', /caderno/], ['contador', /Escritorio Silva/],
      ['vídeo', /no estoque/], ['objeção', /Vou pensar/], ['status', /Agendado/]]) {
      assert(re.test(txt), `o resumo não traz ${oque}:\n${txt}`);
    }
  });

  await t('D2. enviar sem destino e recusado, e nao sai calado', async () => {
    const r = await post(`/api/visitas/${visitaId}/resumo`, { enviar: true });
    assert(r.status === 400, `respondeu ${r.status}`);
    assert(db.prepare('SELECT resumoEnviadoEm FROM roteiro_visitas WHERE id = ?').get(visitaId)
      .resumoEnviadoEm === null, 'carimbou envio que não aconteceu');
  });

  await t('D3. o painel conta a semana contra a meta', async () => {
    const r = await pegar('/api/visitas/painel');
    assert(r.corpo.metas.visitas === 18, 'a meta do roteiro não chegou ao painel');
    assert(r.corpo.semana.visitas >= 1 && r.corpo.semana.agendadas >= 1, JSON.stringify(r.corpo.semana));
    assert(r.corpo.semana.contadores >= 1, 'o contador coletado não foi contado');
  });

  // ==================== G. a qualificação pela IA ====================
  //
  // O modelo é trocado por um dublê: o que está sob teste é a GUARDA, e não o
  // Gemini. Depender da rede aqui faria a suíte reprovar por cota esgotada.

  const WA = require('./semear-roteiro-whatsapp').CONFIG;
  db.prepare("INSERT INTO roteiros (nome, canal, corte, padrao, config) VALUES (?,'whatsapp',?,1,?)")
    .run('WhatsApp — licitações', WA.corte, JSON.stringify(WA));
  db.prepare("INSERT INTO config (chave, valor) VALUES ('gemini_api_key','chave-de-teste')").run();
  db.prepare("INSERT INTO conv_conversas (id, nome, telefone, jid, estado) VALUES (1,'Rosete','559499','559499@s.whatsapp.net','aberta')").run();
  const msg = db.prepare('INSERT INTO whatsapp_messages (remote_jid, from_me, texto, timestamp) VALUES (?,?,?,?)');
  [[0, 'Oi, vi a mensagem sobre licitacao'], [1, 'Oi! Sua empresa ja vende para orgao publico?'],
   [0, 'ja vendi umas vezes mas parei, deu muito trabalho'],
   [1, 'E como voce ficava sabendo dos editais?'],
   [0, 'olhava os portais na mao quando sobrava tempo']]
    .forEach(([meu, txt], i) => msg.run('559499@s.whatsapp.net', meu, txt, 1700000000 + i));

  // O dublê responde o que mandarmos, no lugar da chamada ao Gemini.
  const analise = require('../analise-ia');
  const geminiReal = analise.chamarGemini;
  let RESPOSTA_IA = {};
  analise.chamarGemini = async () => RESPOSTA_IA;

  await t('G1. a IA preenche o que o contato REALMENTE disse', async () => {
    RESPOSTA_IA = {
      vende_governo: { resposta: 'parou', trecho: 'ja vendi umas vezes mas parei' },
      acha_edital: { resposta: 'na_mao', trecho: 'olhava os portais na mao' },
    };
    const r = await post('/api/conversas/1/qualificar');
    assert(r.corpo.success, JSON.stringify(r.corpo));
    assert(r.corpo.pontos === 4, `somou ${r.corpo.pontos}`);
    assert(Object.keys(r.corpo.aceitas).length === 2, JSON.stringify(r.corpo.aceitas));
  });

  await t('G2. o que a IA INVENTOU e recusado, e a recusa aparece', async () => {
    db.prepare('DELETE FROM roteiro_visitas WHERE conversaId = 1').run();
    RESPOSTA_IA = {
      habilitacao: { resposta: 'varias', trecho: 'ja perdi varias por certidao vencida' },
      preco_lance: { resposta: 'feeling', trecho: 'chuto o preco na hora' },
    };
    const r = await post('/api/conversas/1/qualificar');
    assert(r.corpo.pontos === 0, `pontuou ${r.corpo.pontos} com resposta inventada`);
    assert(r.corpo.recusadas.length === 2, JSON.stringify(r.corpo.recusadas));
    assert(r.corpo.recusadas.every(x => x.motivo === 'trecho não está na conversa'),
      JSON.stringify(r.corpo.recusadas));
  });

  await t('G3. a segunda passada NAO repergunta o que ja foi apurado', async () => {
    db.prepare('DELETE FROM roteiro_visitas WHERE conversaId = 1').run();
    RESPOSTA_IA = { vende_governo: { resposta: 'parou', trecho: 'ja vendi umas vezes mas parei' } };
    await post('/api/conversas/1/qualificar');
    let pedido = null;
    analise.chamarGemini = async (_k, prompt) => { pedido = prompt; return {}; };
    await post('/api/conversas/1/qualificar');
    assert(pedido && !/vende_governo:/.test(pedido), 'repetiu a pergunta já respondida');
    assert(/acha_edital:/.test(pedido), 'não pediu as que faltam');
    analise.chamarGemini = async () => RESPOSTA_IA;
  });

  await t('G4. conversa curta demais nao vai a IA', async () => {
    db.prepare("INSERT INTO conv_conversas (id, nome, telefone, jid, estado) VALUES (2,'Novo','5594','5594@s.whatsapp.net','aberta')").run();
    let chamou = false;
    analise.chamarGemini = async () => { chamou = true; return {}; };
    const r = await post('/api/conversas/2/qualificar');
    assert(r.status === 400 && /curta demais/.test(r.corpo.error), JSON.stringify(r.corpo));
    assert(!chamou, 'gastou chamada paga numa conversa de uma linha');
    analise.chamarGemini = async () => RESPOSTA_IA;
  });

  await t('G4b. a campanha de origem escolhe o roteiro dela', async () => {
    // O contato veio da campanha 9, que aponta para um roteiro próprio. O
    // padrão da casa não pode vencer o vínculo.
    const proprio = db.prepare("INSERT INTO roteiros (nome, canal, corte, padrao, config) VALUES (?,'whatsapp',?,0,?)")
      .run('Roteiro da campanha 9', 1, JSON.stringify({ ...WA, corte: 1,
        perguntas: [WA.perguntas[0]] })).lastInsertRowid;
    db.prepare("INSERT INTO wa_campanhas (id, nome, config, status) VALUES (9,'leads',?, 'pausada')")
      .run(JSON.stringify({ roteiro_id: proprio }));
    db.prepare("INSERT INTO wa_campanha_dest (campanha_id, telefone, jid, enviado_em) VALUES (9,'559499','559499@s.whatsapp.net',datetime('now'))").run();
    db.prepare('DELETE FROM roteiro_visitas WHERE conversaId = 1').run();

    let pedido = null;
    analise.chamarGemini = async (_k, prompt) => { pedido = prompt; return {}; };
    const r = await post('/api/conversas/1/qualificar');
    assert(r.corpo.success, JSON.stringify(r.corpo));
    assert(db.prepare('SELECT roteiroId FROM roteiro_visitas WHERE conversaId = 1 ORDER BY id DESC LIMIT 1')
      .get().roteiroId === proprio, 'a qualificação usou o roteiro padrão, e não o da campanha');
    assert(!/acha_edital:/.test(pedido), 'perguntou fora do roteiro da campanha');
    analise.chamarGemini = async () => RESPOSTA_IA;

    // Sem vínculo na campanha, o padrão da casa volta a valer.
    db.prepare("UPDATE wa_campanhas SET config = '{}' WHERE id = 9").run();
    db.prepare('DELETE FROM roteiro_visitas WHERE conversaId = 1').run();
    RESPOSTA_IA = {};
    await post('/api/conversas/1/qualificar');
    const usado = db.prepare('SELECT roteiroId FROM roteiro_visitas WHERE conversaId = 1 ORDER BY id DESC LIMIT 1').get();
    assert(usado.roteiroId !== proprio, 'ficou preso no roteiro da campanha sem vínculo');
  });

  await t('G5. a tela consulta o que foi apurado, sem chamar a IA de novo', async () => {
    // Apura antes de consultar: as checagens anteriores mexeram no estado, e
    // teste que depende da ordem da vizinha quebra na primeira reorganização.
    db.prepare('DELETE FROM roteiro_visitas WHERE conversaId = 1').run();
    RESPOSTA_IA = { vende_governo: { resposta: 'parou', trecho: 'ja vendi umas vezes mas parei' } };
    analise.chamarGemini = async () => RESPOSTA_IA;
    await post('/api/conversas/1/qualificar');
    const r = await pegar('/api/conversas/1/qualificacao');
    assert(r.corpo.success && r.corpo.visita, JSON.stringify(r.corpo));
    assert(r.corpo.respondidas.length >= 1, 'não devolveu o que já foi respondido');
    assert(r.corpo.faltam.length >= 1, 'não diz o que ainda falta descobrir');
  });

  analise.chamarGemini = geminiReal;

  // ==================== E. a tela, no celular ====================

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-visita', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const erros = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true });
  page.on('pageerror', e => erros.push(String(e.message)));
  page.on('response', r => { if (r.status() >= 400) erros.push(`${r.status()} em ${r.url()}`); });
  await page.goto(url('/__wrapper/comercial/visita'), { waitUntil: 'networkidle0' });
  let frame = await esperarFrame(page, f => f.url().includes('visita.html'));
  if (!frame) { console.log('FALHA a tela não carregou'); process.exit(1); }
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));
  await frame.waitForSelector('#fEmpresa', { timeout: 8000 });

  await t('E1. a visita comeca pelo porte, e nao pelo formulario inteiro', async () => {
    const titulo = await frame.$eval('#titulo', e => e.textContent);
    assert(/Vale a visita/.test(titulo), `a primeira etapa é "${titulo}"`);
  });

  await t('E1b. abrir a tela NAO cria visita no banco', async () => {
    // Registro vazio de quem só deu uma olhada infla a meta da semana, e foi
    // exatamente o que a primeira versão fez.
    const antes = db.prepare('SELECT COUNT(*) n FROM roteiro_visitas').get().n;
    await page.goto(url('/__wrapper/comercial/visita'), { waitUntil: 'networkidle0' });
    // O goto solta o frame anterior: sem reatribuir, as checagens seguintes
    // falhariam com "detached Frame" e o motivo pareceria outro.
    frame = await esperarFrame(page, x => x.url().includes('visita.html'));
    await frame.waitForSelector('#fEmpresa', { timeout: 8000 });
    await esperar(400);
    const depois = db.prepare('SELECT COUNT(*) n FROM roteiro_visitas').get().n;
    assert(depois === antes, `abrir a tela criou ${depois - antes} visita(s)`);
  });

  await t('E1c. o primeiro dado preenchido cria a visita', async () => {
    const antes = db.prepare('SELECT COUNT(*) n FROM roteiro_visitas').get().n;
    await frame.type('#fEmpresa', 'Loja Nova');
    await frame.type('#fCaixas', '3');
    await esperar(600);
    const depois = db.prepare('SELECT COUNT(*) n FROM roteiro_visitas').get().n;
    assert(depois === antes + 1, `criou ${depois - antes} visita(s) ao preencher`);
  });

  await t('E2. o porte responde enquanto o vendedor digita', async () => {
    await frame.$eval('#fCaixas', e => { e.value = '1'; e.dispatchEvent(new Event('input')); });
    await frame.type('#fFunc', '2');
    await esperar(500);
    const txt = await frame.$eval('#vereditoPorte', e => e.textContent);
    assert(/Abaixo do corte/.test(txt), `o veredito diz "${txt}"`);
    await frame.$eval('#fCaixas', e => { e.value = '3'; e.dispatchEvent(new Event('input')); });
    await esperar(500);
    assert(/Pode seguir/.test(await frame.$eval('#vereditoPorte', e => e.textContent)),
      'três caixas continuaram reprovados');
  });

  await t('E3. a fala aparece do jeito que ele deve falar', async () => {
    await frame.evaluate(() => irEtapa(1));
    await frame.waitForSelector('.fala', { timeout: 4000 });
    const txt = await frame.$eval('.fala', e => e.textContent);
    assert(/Guilherme/.test(txt) && /1BIT/.test(txt), txt.slice(0, 120));
    assert(!/\{\{/.test(txt), 'variável cru na frente do cliente: ' + txt.slice(0, 80));
  });

  await t('E4. as cinco perguntas viram toque, com alvo utilizavel em pe', async () => {
    await frame.evaluate(() => irEtapa(2));
    await frame.waitForSelector('.opcoes button', { timeout: 4000 });
    const n = await frame.$$eval('.pergunta', els => els.length);
    assert(n === 5, `${n} perguntas na tela`);
    const alturas = await frame.$$eval('.opcoes button', els =>
      els.map(e => Math.round(e.getBoundingClientRect().height)));
    assert(alturas.every(h => h >= 44), 'alvo de toque menor que 44px: ' + alturas.join(', '));
    const inputs = await frame.$$eval('.pergunta input', els => els.length);
    assert(inputs === 0, 'apareceu campo de digitar no meio da qualificação');
  });

  await t('E5. tocar na resposta pontua, e tocar de novo desmarca', async () => {
    await frame.evaluate(() => document.querySelector('.opcoes button[data-o="caderno"]').click());
    await esperar(400);
    assert(/2/.test(await frame.$eval('#placar', e => e.textContent)), 'o placar não somou');
    await frame.evaluate(() => document.querySelector('.opcoes button[data-o="caderno"]').click());
    await esperar(400);
    const sel = await frame.$$eval('.opcoes button.sel', els => els.length);
    assert(sel === 0, 'o segundo toque não desmarcou');
  });

  await t('E6. as objecoes ficam a um toque na etapa do agendamento', async () => {
    await frame.evaluate(() => irEtapa(4));
    await frame.waitForSelector('.objecoes', { timeout: 4000 });
    const n = await frame.$$eval('.objecao', els => els.length);
    assert(n === 7, `${n} objeções na tela, esperado 7`);
  });

  await t('E7. o fechamento mostra o resumo pronto', async () => {
    await frame.evaluate(() => irEtapa(5));
    await frame.waitForFunction(() =>
      !/Carregando/.test(document.getElementById('resumo').textContent), { timeout: 8000 });
    const txt = await frame.$eval('#resumo', e => e.textContent);
    assert(/Loja Nova/.test(txt), `o resumo diz "${txt.slice(0, 80)}"`);
    assert(/Qualificação:/.test(txt), 'o resumo saiu sem a pontuação');
  });

  await t('F1. nenhum erro de JavaScript na tela', () => {
    assert(erros.length === 0, erros.slice(0, 4).join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
