/**
 * Tom e limites como escolha, e não como texto solto no campo de instruções.
 *
 * ── O que estava errado ───────────────────────────────────────────────────
 *
 * O campo "Instruções (tom e limites)" era um textarea só, e no `1bit` ele
 * juntava identidade do assistente, descrição do produto, regras de conversa e
 * contatos em 2.995 caracteres. Quem abria não tinha como saber o que já tinha
 * sido dito, nem escrever "seja conciso" sem repetir o que já estava lá.
 *
 * ── O que esta suíte guarda ───────────────────────────────────────────────
 *
 * A parte A prova o prompt: a frase que chega ao modelo é a do catálogo, só a
 * das escolhas marcadas, e tenant sem escolha nenhuma recebe exatamente o
 * prompt de antes — essa última é a que impede a mudança de vazar para os
 * outros dez tenants. A parte B prova a tela em Chrome: o botão marcado volta
 * marcado, e é ele que viaja no salvar.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PORTA = 34168;

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

const { ESTILO, lerEstilo, frasesDeEstilo, buildSystemAtendimento } = require('../whatsapp-adapter');

/** Banco descartável com o mínimo que o prompt consulta. */
function bancoDeTeste(valores) {
  const Database = require(path.join(RAIZ, 'node_modules/better-sqlite3'));
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT, dataAtualizacao TEXT);
           CREATE TABLE ia_base (id INTEGER PRIMARY KEY, titulo TEXT, conteudo TEXT, ativo INTEGER DEFAULT 1);`);
  const up = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?)');
  for (const [k, v] of Object.entries(valores)) up.run(k, v);
  db.prepare('INSERT INTO ia_base (titulo, conteudo, ativo) VALUES (?,?,1)')
    .run('Horário', 'A loja abre das 8h às 18h.');
  return db;
}

(async () => {
  // ==================== A. o prompt ====================

  await t('A1. a frase que vai ao modelo e a do catalogo, nao a do banco', () => {
    const frases = frasesDeEstilo({ tom: 'formal', tamanho: null, emoji: null, limites: [] });
    const esperada = ESTILO.tom.opcoes.find(o => o.id === 'formal').frase;
    assert(frases === esperada, `veio "${frases}"`);
  });

  await t('A2. so o que esta marcado vira frase', () => {
    const frases = frasesDeEstilo({ tom: 'proximo', tamanho: 'curta', emoji: null,
                                    limites: ['dado_sensivel'] });
    assert(/profissional e próximo/.test(frases), 'o tom marcado não apareceu');
    assert(/um a três parágrafos/.test(frases), 'o tamanho marcado não apareceu');
    assert(!/emoji/i.test(frases), 'entrou frase de emoji sem ninguém escolher: ' + frases);
    assert(!/desconto/.test(frases), 'entrou limite que não foi marcado: ' + frases);
  });

  await t('A3. escolha que nao existe no catalogo e descartada na leitura', () => {
    const e = lerEstilo((c) => ({ whatsapp_ai_tom: 'sarcastico',
      whatsapp_ai_limites: '["dado_sensivel","virar_pizza"]' }[c] || ''));
    assert(e.tom === null, `o tom inventado passou: ${e.tom}`);
    assert(JSON.stringify(e.limites) === '["dado_sensivel"]',
      `os limites vieram ${JSON.stringify(e.limites)}`);
  });

  await t('A4. o prompt real ganha o bloco COMO RESPONDER', () => {
    const db = bancoDeTeste({ whatsapp_ai_prompt: 'Você atende a Loja X.',
      whatsapp_ai_tom: 'direto', whatsapp_ai_emoji: 'nenhum' });
    const p = buildSystemAtendimento(db, null);
    assert(/COMO RESPONDER/.test(p), 'o bloco não entrou');
    assert(/direto ao ponto/i.test(p), 'a frase do tom não entrou');
    assert(/Não use emoji/.test(p), 'a frase de emoji não entrou');
    // A ordem importa: como falar antes do que se pode dizer.
    assert(p.indexOf('COMO RESPONDER') < p.indexOf('BASE DE CONHECIMENTO'),
      'o estilo caiu depois do conhecimento');
  });

  await t('A5. tenant SEM escolha recebe o prompt de antes, sem uma letra a mais', () => {
    // A garantia que impede esta mudança de vazar para os outros dez tenants.
    const db = bancoDeTeste({ whatsapp_ai_prompt: 'Você atende a Loja X.' });
    const p = buildSystemAtendimento(db, null);
    assert(!/COMO RESPONDER/.test(p), 'entrou bloco de estilo em quem não escolheu nada');
    assert(p.startsWith('Você atende a Loja X.'), 'o começo do prompt mudou');
  });

  // ==================== A6. o roteiro dentro do prompt ====================

  const { blocoRoteiro } = require('../whatsapp-adapter');
  const WA = require('./semear-roteiro-whatsapp').CONFIG;

  /** Banco com roteiro de WhatsApp e uma conversa. */
  function bancoComRoteiro(respostas) {
    const db = bancoDeTeste({ whatsapp_ai_prompt: 'Você atende a Loja X.' });
    db.exec(`CREATE TABLE roteiros (id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, canal TEXT,
               corte INTEGER, padrao INTEGER, ativo INTEGER DEFAULT 1, config TEXT);
             CREATE TABLE roteiro_visitas (id INTEGER PRIMARY KEY AUTOINCREMENT, roteiroId INTEGER,
               conversaId INTEGER, respostas TEXT, pontos INTEGER);`);
    db.prepare("INSERT INTO roteiros (nome, canal, corte, padrao, ativo, config) VALUES (?,'whatsapp',?,1,1,?)")
      .run('WhatsApp', WA.corte, JSON.stringify(WA));
    if (respostas) {
      db.prepare('INSERT INTO roteiro_visitas (roteiroId, conversaId, respostas, pontos) VALUES (1,1,?,0)')
        .run(JSON.stringify(respostas));
    }
    return db;
  }

  await t('A6. o prompt passa a dizer o que a IA precisa DESCOBRIR', () => {
    const db = bancoComRoteiro(null);
    const p = buildSystemAtendimento(db, null, { conversaId: 1 });
    assert(/O QUE VOCÊ AINDA PRECISA DESCOBRIR/.test(p), 'o roteiro não entrou no prompt');
    assert(/já vende para órgão público/i.test(p), 'a primeira pergunta não apareceu');
    assert(/COMO PERGUNTAR/.test(p), 'as regras de condução não entraram');
    assert(/Responda primeiro o que a pessoa perguntou/.test(p),
      'a precedência não foi declarada — sem ela o atendimento vira interrogatório');
  });

  await t('A7. pergunta ja respondida SAI da lista', () => {
    const db = bancoComRoteiro({ vende_governo: 'parou' });
    const p = buildSystemAtendimento(db, null, { conversaId: 1 });
    assert(!/já vende para órgão público/i.test(p), 'repetiu a pergunta que o contato já respondeu');
    assert(/como você fica sabendo dos editais/i.test(p), 'sumiu com as perguntas que faltam');
  });

  await t('A8. roteiro inteiro respondido nao deixa bloco nenhum', () => {
    const db = bancoComRoteiro({ vende_governo: 'parou', acha_edital: 'na_mao', le_edital: 'desiste',
                                 habilitacao: 'uma', preco_lance: 'feeling' });
    const p = buildSystemAtendimento(db, null, { conversaId: 1 });
    assert(!/PRECISA DESCOBRIR/.test(p), 'manteve o bloco sem nada para perguntar');
  });

  await t('A9. SEM conversa identificada, o prompt fica como era', () => {
    // A garantia que impede a mudança de vazar: simulador, campanha e qualquer
    // chamada antiga continuam com o prompt de antes.
    const db = bancoComRoteiro(null);
    const p = buildSystemAtendimento(db, null);
    assert(!/PRECISA DESCOBRIR/.test(p), 'entrou roteiro sem conversa identificada');
  });

  await t('A10. tenant SEM roteiro nao ganha bloco nenhum', () => {
    const db = bancoDeTeste({ whatsapp_ai_prompt: 'Você atende a Loja X.' });
    const p = buildSystemAtendimento(db, null, { conversaId: 1 });
    assert(!/PRECISA DESCOBRIR/.test(p), 'inventou roteiro em tenant que não tem nenhum');
    assert(blocoRoteiro(db, 1) === '', 'o bloco deveria ser vazio');
  });

  // ==================== B. a tela ====================

  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));
  const app = express();
  app.use(express.json());
  let salvo = null, salvoAgenda = null;
  const ESCOLHAS = { tom: 'proximo', tamanho: 'curta', emoji: 'ate1',
                     limites: ['dado_sensivel', 'outro_idioma'] };
  app.get('/api/whatsapp/ai-config', (_q, rs) => rs.json({ success: true, enabled: true,
    prompt: 'Você atende a Loja X.', escopo: 'todos', horario: { ativo: false, faixas: null, mensagem: '' },
    popupAtivo: false, estilo: { catalogo: ESTILO, escolhas: ESCOLHAS } }));
  app.post('/api/whatsapp/ai-config', (rq, rs) => { salvo = rq.body; rs.json({ success: true }); });
  // O agendamento de reunião: a tela pergunta se está ligado para decidir se
  // mostra o botão. Desligado aqui, como nasce em qualquer tenant.
  app.get('/api/agenda/config', (_q, rs) => rs.json({ success: true,
    config: { ativo: false, faixas: null, duracaoMin: 30, antecedenciaMin: 120, janelaDias: 7, maxSlots: 8 } }));
  app.post('/api/agenda/config', (rq, rs) => { salvoAgenda = rq.body; rs.json({ success: true,
    config: { ativo: false, faixas: null, duracaoMin: 30, antecedenciaMin: 120, janelaDias: 7, maxSlots: 8 } }); });
  app.get('/api/ia/base', (_q, rs) => rs.json({ success: true, itens: [], correcoes: [] }));
  app.get('/api/comm/listas', (_q, rs) => rs.json({ success: true, listas: [] }));
  app.get('/api/comm/templates', (_q, rs) => rs.json({ success: true, templates: [] }));
  app.get('/api/conversas/campanhas', (_q, rs) => rs.json({ success: true, campanhas: [] }));
  app.get('/api/conversas/publico', (_q, rs) => rs.json({ success: true, ufs: [], total: 0, pessoas: [] }));
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  app.get('/api/whatsapp/status', (_q, rs) => rs.json({ success: true, connected: true, instance: 'teste' }));
  app.get('/api/whatsapp/ritmo', (_q, rs) => rs.json({ success: true, hora: 0, dia: 0, limiteHora: 25,
    podeEnviarAgora: true, motivo: null }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  app.get('/__wrapper/:tela', (rq, rs) => rs.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
    + `ipt></head><body style="margin:0"><iframe src="/comunicacao/${rq.params.tela}.html"`
    + ' style="width:100vw;height:100vh;border:0"></iframe></body></html>'));
  app.use(express.static(PUB));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-ia-estilo', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const erros = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('pageerror', e => erros.push(String(e.message)));
  page.on('response', r => { if (r.status() >= 400) erros.push(`${r.status()} em ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/ia`, { waitUntil: 'networkidle0' });
  const frame = page.frames().find(f => f.url().includes('ia.html'));
  if (!frame) { console.log('FALHA a tela não carregou'); process.exit(1); }
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));

  await frame.evaluate(() => {
    [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'Canal').click();
  });
  await frame.waitForSelector('#iaEstilo .opt', { timeout: 8000 });

  await t('B1. os grupos do catalogo viram botoes na tela', async () => {
    const grupos = await frame.$$eval('.estilo-grupo label', els => els.map(e => e.textContent.trim()));
    assert(grupos.length === Object.keys(ESTILO).length,
      `${grupos.length} grupo(s) para ${Object.keys(ESTILO).length} do catálogo`);
    assert(grupos.includes('O que ela nunca faz'), 'faltou o grupo de limites: ' + grupos.join(', '));
  });

  await t('B2. o que esta gravado volta MARCADO, e o resto nao', async () => {
    const marcados = await frame.$$eval('#iaEstilo .opt.sel', els => els.map(e => e.dataset.id));
    const esperado = ['proximo', 'curta', 'ate1', 'dado_sensivel', 'outro_idioma'].sort();
    assert(JSON.stringify(marcados.sort()) === JSON.stringify(esperado),
      `marcados: ${marcados.join(', ')}`);
  });

  await t('B3. o botao marcado mostra a frase que a IA recebe', async () => {
    const txt = await frame.$eval('#frase-tom', e => e.textContent);
    assert(/profissional e próximo/.test(txt), `a frase do tom veio como "${txt}"`);
    // É a prova de que o botão não é enfeite: sem isso ninguém sabe o efeito.
    const medida = await frame.$eval('#frase-tom', e => e.getBoundingClientRect().height);
    assert(medida > 0, 'a frase existe no DOM mas tem altura zero');
  });

  await t('B4. clicar troca a escolha unica em vez de somar', async () => {
    await frame.evaluate(() => {
      document.querySelector('#iaEstilo .opt[data-id="formal"]').click();
    });
    const marcadosTom = await frame.$$eval('.estilo-grupo:first-child .opt.sel', els => els.map(e => e.dataset.id));
    assert(marcadosTom.length === 1 && marcadosTom[0] === 'formal',
      `o grupo de tom ficou com ${marcadosTom.join(', ')}`);
  });

  await t('B5. limite e escolha multipla, e desmarca no segundo clique', async () => {
    await frame.evaluate(() => {
      document.querySelector('#iaEstilo .opt[data-id="prometer"]').click();
      document.querySelector('#iaEstilo .opt[data-id="outro_idioma"]').click();
    });
    const sel = await frame.evaluate(() => ESTILO_SEL.limites.slice().sort());
    assert(JSON.stringify(sel) === JSON.stringify(['dado_sensivel', 'prometer']),
      `os limites ficaram ${JSON.stringify(sel)}`);
  });

  await t('B6. o salvar leva as escolhas, e nao so o texto', async () => {
    await frame.evaluate(() => salvarIA());
    await esperar(500);
    assert(salvo, 'nada chegou ao servidor');
    assert(salvo.estilo, 'o corpo foi sem as escolhas: ' + JSON.stringify(salvo).slice(0, 120));
    assert(salvo.estilo.tom === 'formal', `o tom gravado seria ${salvo.estilo.tom}`);
    assert(salvo.estilo.limites.includes('prometer'), 'o limite novo não viajou');
    assert(typeof salvo.prompt === 'string', 'o texto livre deixou de ser enviado');
  });

  await t('B6b. o salvar da aba grava tambem o agendamento de reuniao', async () => {
    // As duas configurações saem do mesmo botão. Se uma falhasse calada, a
    // pessoa sairia da tela achando que gravou as duas.
    assert(salvoAgenda, 'o agendamento não foi salvo junto');
    assert(salvoAgenda.faixas && typeof salvoAgenda.faixas === 'object', 'as faixas não viajaram');
  });

  await t('B7. servidor sem catalogo nao desenha botao nenhum', async () => {
    // Enquanto o serviço não reinicia, a rota antiga responde sem `estilo`.
    // Um bloco de botões que o salvar ignorasse seria pior que nenhum.
    const vazio = await frame.evaluate(() => {
      renderEstilo(undefined);
      return document.getElementById('iaEstilo').innerHTML;
    });
    assert(vazio === '', 'a tela desenhou botões sem catálogo do servidor');
  });

  await t('C1. nenhum erro de JavaScript nem 404 na tela', () => {
    assert(erros.length === 0, erros.slice(0, 4).join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
