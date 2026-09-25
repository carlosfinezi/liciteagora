/**
 * O agendamento de ponta a ponta: rotas, corrida pelo mesmo horário e a tela
 * que o contato abre.
 *
 * ── O que está guardado ────────────────────────────────────────────────────
 *
 * 1. A CORRIDA. Dois contatos clicam nas 10h ao mesmo tempo. Sem o índice único
 *    parcial `idx_agenda_slot`, os dois saem da tela convencidos de que têm o
 *    horário, e a duplicidade só aparece na hora da reunião. Aqui o segundo tem
 *    de levar recusa explícita, com a lista já refeita.
 * 2. O horário é RECONFERIDO no servidor. Aceitar o que a tela mandou deixaria
 *    marcar fora do expediente com uma requisição montada à mão.
 * 3. Conversa sem dono é recusada na geração do convite. Todas as 956 conversas
 *    do `1bit` estão sem dono, então este é o caminho comum, e não a exceção.
 * 4. O token é a única chave: formato errado, inexistente e expirado não
 *    entram, e nenhum deles vaza nada.
 */
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PORTA = 34185;

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

const FAIXAS = { seg: ['09:00', '18:00'], ter: ['09:00', '18:00'], qua: ['09:00', '18:00'],
                 qui: ['09:00', '18:00'], sex: ['09:00', '18:00'], sab: null, dom: null };

/** Banco descartável com o schema que o agendamento toca. */
function bancoDeTeste() {
  const Database = require(path.join(RAIZ, 'node_modules/better-sqlite3'));
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (chave TEXT PRIMARY KEY, valor TEXT, dataAtualizacao TEXT);
    CREATE TABLE fornecedor (id INTEGER PRIMARY KEY, razaoSocial TEXT, nomeFantasia TEXT);
    CREATE TABLE conv_conversas (id INTEGER PRIMARY KEY, nome TEXT, telefone TEXT,
      pessoaId INTEGER, donoId INTEGER, estado TEXT);
    CREATE TABLE crm_atividades (id INTEGER PRIMARY KEY AUTOINCREMENT, oportunidadeId INTEGER,
      clienteId INTEGER, tipo TEXT NOT NULL, titulo TEXT NOT NULL, descricao TEXT,
      dataHora TEXT NOT NULL, concluida INTEGER DEFAULT 0, dataConclusao TEXT,
      resultadoNota TEXT, usuarioId INTEGER, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE whatsapp_config (id INTEGER PRIMARY KEY, provider TEXT, instance TEXT);
    CREATE TABLE agenda_reunioes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE,
      conversaId INTEGER, pessoaId INTEGER, responsavelId INTEGER NOT NULL,
      nomeContato TEXT, telefone TEXT, email TEXT,
      estado TEXT NOT NULL DEFAULT 'convidado', dataHora TEXT, atividadeId INTEGER,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP, expiraEm TEXT, marcadoEm TEXT, canceladoEm TEXT);
    CREATE UNIQUE INDEX idx_agenda_slot ON agenda_reunioes(responsavelId, dataHora) WHERE estado = 'marcada';
    INSERT INTO fornecedor (id, razaoSocial, nomeFantasia) VALUES (1, 'Empresa Teste Ltda', 'Empresa Teste');
    INSERT INTO conv_conversas (id, nome, telefone, donoId, estado) VALUES
      (1, 'Ana Souza', '5594999990001', 7, 'aberta'),
      (2, 'Sem Dono', '5594999990002', NULL, 'aberta'),
      (3, 'Bruno Lima', '5594999990003', 7, 'aberta');
  `);
  const up = db.prepare('INSERT INTO config (chave, valor) VALUES (?,?)');
  up.run('agenda_ativo', '1');
  up.run('agenda_faixas', JSON.stringify(FAIXAS));
  return db;
}

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));
  const { registrarRotasAgenda } = require('../agenda-routes');

  const db = bancoDeTeste();
  const app = express();
  app.use(express.json());
  registrarRotasAgenda(app, db);
  // O Chrome pede sozinho, e o 404 dele apareceria como defeito da tela.
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
    // `public/auth/` é servido na RAIZ da URL — é assim que o orçamento público
  // chega ao cliente sem passar pela barreira de login.
  app.use(express.static(path.join(PUB, 'auth')));
  app.use(express.static(PUB));
  const srv = app.listen(PORTA);
  const url = (p) => `http://127.0.0.1:${PORTA}${p}`;
  const pegar = (p, opts) => fetch(url(p), opts).then(async r => ({ status: r.status, corpo: await r.json() }));
  const post = (p, body) => pegar(p, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                       body: JSON.stringify(body || {}) });

  let token = null, token3 = null;

  // ==================== A. o convite ====================

  await t('A1. conversa SEM dono e recusada, com o motivo dito', async () => {
    const r = await post('/api/conversas/2/convite-agenda');
    assert(r.status === 400, `respondeu ${r.status}`);
    assert(r.corpo.semDono === true, 'a tela não tem como saber que o problema é o dono');
    assert(/Assuma a conversa/.test(r.corpo.error), r.corpo.error);
  });

  await t('A2. conversa com dono gera o link', async () => {
    const r = await post('/api/conversas/1/convite-agenda');
    assert(r.corpo.success, r.corpo.error);
    assert(/^[a-f0-9]{64}$/.test(r.corpo.token), `token fora do formato: ${r.corpo.token}`);
    assert(r.corpo.url.includes('/agendar.html?token='), r.corpo.url);
    token = r.corpo.token;
  });

  await t('A3. pedir de novo devolve o MESMO link, e nao um segundo', async () => {
    // Dois links vivos para o mesmo contato o fariam marcar duas reuniões.
    const r = await post('/api/conversas/1/convite-agenda');
    assert(r.corpo.token === token, 'gerou um segundo convite para a mesma conversa');
  });

  await t('A4. agendamento desligado recusa, em vez de gerar link morto', async () => {
    db.prepare("UPDATE config SET valor = '0' WHERE chave = 'agenda_ativo'").run();
    const r = await post('/api/conversas/3/convite-agenda');
    assert(r.status === 400 && /desligado/i.test(r.corpo.error), JSON.stringify(r.corpo));
    db.prepare("UPDATE config SET valor = '1' WHERE chave = 'agenda_ativo'").run();
  });

  // ==================== B. o que o token abre ====================

  await t('B1. token fora do formato nao chega ao banco', async () => {
    const r = await pegar('/api/agendar/nao-e-token');
    assert(r.status === 404, `respondeu ${r.status}`);
  });

  await t('B2. token inexistente responde igual a token invalido', async () => {
    const r = await pegar('/api/agendar/' + 'a'.repeat(64));
    assert(r.status === 404, `respondeu ${r.status}`);
  });

  await t('B3. o convite mostra empresa e horarios, e nada mais', async () => {
    const r = await pegar('/api/agendar/' + token);
    assert(r.corpo.success && r.corpo.empresa === 'Empresa Teste', JSON.stringify(r.corpo));
    assert(Array.isArray(r.corpo.horarios) && r.corpo.horarios.length, 'veio sem horários');
    const vazado = JSON.stringify(r.corpo);
    assert(!/responsavelId|donoId|telefone/.test(vazado), 'vazou dado interno: ' + vazado);
  });

  await t('B4. convite expirado responde 410, e nao um formulario morto', async () => {
    const r2 = await post('/api/conversas/3/convite-agenda');
    token3 = r2.corpo.token;
    db.prepare("UPDATE agenda_reunioes SET expiraEm = datetime('now','-1 day') WHERE token = ?").run(token3);
    const r = await pegar('/api/agendar/' + token3);
    assert(r.status === 410 && /expirou/.test(r.corpo.error), JSON.stringify(r.corpo));
    db.prepare("UPDATE agenda_reunioes SET expiraEm = datetime('now','+10 days') WHERE token = ?").run(token3);
  });

  // ==================== C. a corrida ====================

  await t('C1. horario fora da lista do servidor e RECUSADO', async () => {
    // Madrugada de domingo: nenhuma tela ofereceria, mas um POST à mão sim.
    const r = await post('/api/agendar/' + token, { dataHora: '2027-01-03T03:00' });
    assert(r.status === 409, `respondeu ${r.status}`);
    assert(/não está mais livre/.test(r.corpo.error), r.corpo.error);
    assert(Array.isArray(r.corpo.horarios), 'não devolveu a lista refeita');
  });

  await t('C2. dois contatos no MESMO horario: um marca, o outro leva recusa', async () => {
    const livre = (await pegar('/api/agendar/' + token)).corpo.horarios[0];
    const [a, b] = await Promise.all([
      post('/api/agendar/' + token, { dataHora: livre, nome: 'Ana' }),
      post('/api/agendar/' + token3, { dataHora: livre, nome: 'Bruno' }),
    ]);
    const vencedores = [a, b].filter(x => x.corpo.success);
    const perdedores = [a, b].filter(x => !x.corpo.success);
    assert(vencedores.length === 1, `${vencedores.length} confirmações para o mesmo horário`);
    assert(perdedores.length === 1 && perdedores[0].status === 409,
      `o perdedor respondeu ${perdedores[0]?.status}`);
    assert(/outra pessoa|não está mais livre/.test(perdedores[0].corpo.error), perdedores[0].corpo.error);
    assert(Array.isArray(perdedores[0].corpo.horarios), 'o perdedor ficou sem lista para tentar de novo');

    const marcadas = db.prepare(
      "SELECT COUNT(*) n FROM agenda_reunioes WHERE estado='marcada' AND dataHora = ?").get(livre).n;
    assert(marcadas === 1, `${marcadas} reuniões gravadas no mesmo horário`);
  });

  await t('C3. a reuniao virou atividade do CRM, na agenda de quem atende', async () => {
    const a = db.prepare("SELECT * FROM crm_atividades WHERE tipo='reuniao'").get();
    assert(a, 'nada foi criado no CRM');
    assert(a.usuarioId === 7, `a atividade ficou com o usuário ${a.usuarioId}`);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(a.dataHora), `dataHora fora do formato: ${a.dataHora}`);
  });

  await t('C4. o horario marcado sai da lista dos proximos', async () => {
    const marcada = db.prepare("SELECT dataHora FROM agenda_reunioes WHERE estado='marcada'").get().dataHora;
    const r = await pegar('/api/agendar/' + token3);
    assert(!r.corpo.horarios.includes(marcada), 'o horário já tomado continua sendo oferecido');
  });

  await t('C5. convite ja usado nao marca de novo', async () => {
    const usado = db.prepare("SELECT token FROM agenda_reunioes WHERE estado='marcada'").get().token;
    const livre = (await pegar('/api/agendar/' + token3)).corpo.horarios[0];
    const r = await post('/api/agendar/' + usado, { dataHora: livre });
    assert(r.status === 409 && r.corpo.jaMarcada, JSON.stringify(r.corpo));
  });

  // ==================== D. o .ics e o cancelamento ====================

  await t('D1. o .ics sai com o tipo certo e a hora em UTC', async () => {
    const usado = db.prepare("SELECT token, dataHora FROM agenda_reunioes WHERE estado='marcada'").get();
    const r = await fetch(url('/api/agendar/' + usado.token + '/ics'));
    assert(r.headers.get('content-type').startsWith('text/calendar'), r.headers.get('content-type'));
    const txt = await r.text();
    const hora = Number(usado.dataHora.slice(11, 13)) + 3;   // -03 → UTC
    assert(txt.includes(`DTSTART:${usado.dataHora.slice(0,10).replace(/-/g,'')}T${String(hora).padStart(2,'0')}`),
      txt.split('\r\n').find(l => l.startsWith('DTSTART')));
  });

  await t('D2. cancelar libera o horario e marca a atividade', async () => {
    const usado = db.prepare("SELECT token, dataHora FROM agenda_reunioes WHERE estado='marcada'").get();
    const r = await post('/api/agendar/' + usado.token + '/cancelar');
    assert(r.corpo.success, JSON.stringify(r.corpo));
    const depois = await pegar('/api/agendar/' + token3);
    assert(depois.corpo.horarios.includes(usado.dataHora), 'o horário cancelado não voltou para a lista');
    const a = db.prepare("SELECT * FROM crm_atividades WHERE tipo='reuniao'").get();
    assert(/^CANCELADA:/.test(a.titulo), `a atividade ficou como "${a.titulo}"`);
  });

  await t('D3. remarcar o MESMO horario depois do cancelamento e permitido', async () => {
    // O índice é parcial justamente para isto: um UNIQUE cru proibiria.
    const liberado = db.prepare("SELECT dataHora FROM agenda_reunioes WHERE estado='cancelada'").get().dataHora;
    const r = await post('/api/agendar/' + token3, { dataHora: liberado, nome: 'Bruno' });
    assert(r.corpo.success, JSON.stringify(r.corpo));
  });

  // ==================== E. a tela do contato ====================

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-agenda', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const erros = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 900 });    // celular: é onde o link é aberto
  page.on('pageerror', e => erros.push(String(e.message)));
  page.on('response', r => { if (r.status() >= 400 && !r.url().includes('/api/agendar/naoexiste')) erros.push(`${r.status()} em ${r.url()}`); });

  const novo = await post('/api/conversas/1/convite-agenda');
  db.prepare("UPDATE agenda_reunioes SET estado='cancelada' WHERE token = ?").run(token);
  const r4 = await post('/api/conversas/1/convite-agenda');
  const tokenTela = r4.corpo.token;

  await page.goto(url('/agendar.html?token=' + tokenTela), { waitUntil: 'networkidle0' });

  await t('E1. a sugestao aparece grande, com o botao de confirmar', async () => {
    await page.waitForSelector('.sugestao .quando', { timeout: 8000 });
    const m = await page.$eval('.sugestao .quando', e => ({
      txt: e.textContent.trim(), h: Math.round(e.getBoundingClientRect().height),
      fonte: parseFloat(getComputedStyle(e).fontSize) }));
    assert(m.h > 0 && m.fonte >= 18, `a sugestão tem ${m.fonte}px e altura ${m.h}`);
    assert(/\d{2}\/\d{2} às \d{2}:\d{2}/.test(m.txt), `a sugestão diz "${m.txt}"`);
  });

  await t('E2. os outros horarios ficam disponiveis, sem calendario', async () => {
    const n = await page.$$eval('.outros button', els => els.length);
    assert(n > 0, 'a pessoa só pode aceitar a sugestão');
    assert(n <= 7, `${n} botões — a lista deveria ser curta`);
  });

  await t('E3. confirmar mostra o que foi marcado e o link do calendario', async () => {
    await page.click('.sugestao .principal');
    await page.waitForSelector('.feito .quando', { timeout: 8000 });
    const txt = await page.$eval('.feito', e => e.textContent);
    assert(/às \d{2}:\d{2}/.test(txt), `a confirmação diz "${txt}"`);
    const href = await page.$eval('.calendario', e => e.getAttribute('href'));
    assert(href === `/api/agendar/${tokenTela}/ics`, href);
  });

  await t('E4. reabrir o link mostra a reuniao, e nao um formulario em branco', async () => {
    await page.goto(url('/agendar.html?token=' + tokenTela), { waitUntil: 'networkidle0' });
    await page.waitForSelector('.feito .quando', { timeout: 8000 });
    const titulo = await page.$eval('#titulo', e => e.textContent);
    assert(/confirmada/i.test(titulo), `o título diz "${titulo}"`);
  });

  await t('E5. link invalido explica, em vez de ficar carregando', async () => {
    await page.goto(url('/agendar.html?token=quebrado'), { waitUntil: 'networkidle0' });
    await page.waitForSelector('.aviso.erro', { timeout: 8000 });
    const txt = await page.$eval('.aviso.erro', e => e.textContent);
    assert(/inválido/i.test(txt), txt);
  });

  await t('F1. nenhum erro de JavaScript na tela publica', () => {
    assert(erros.length === 0, erros.slice(0, 4).join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
