/**
 * Recorrências: e-mail único, vencimento que não nasce vencido e "Executar
 * todas" em segundo plano com andamento na tela.
 *
 * A emissão roda o código REAL (emitirNfseInterno, executarUmaRecorrencia, o
 * lote, as rotas e a tela). Só as bordas externas são trocadas antes de
 * carregar os módulos: o cliente SEFIN, a assinatura do XML e o envio de
 * e-mail, que aqui só conta quantas mensagens sairiam.
 *
 *   A. vencimentoDaCompetencia
 *   B. e-mail: a recorrência obedece à caixa dela; a emissão avulsa não muda
 *   C. lote: POST imediato, andamento, trava entre execuções, trava vencida
 *   D. tela: andamento "x de N", resultado, erro da última execução na lista
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

// ---------- bordas externas trocadas ANTES de carregar os módulos ----------
const EMAILS = [];
const EMISSOES = [];
let ATRASO_MS = 0;
let nNota = 0;
const trocar = (mod, exp) => {
  const p = require.resolve(path.join(RAIZ, mod));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exp };
};
trocar('nfse-client', { NfseClient: class {
  constructor() {}
  async emitirNfse() {
    EMISSOES.push(Date.now());
    if (ATRASO_MS) await new Promise(r => setTimeout(r, ATRASO_MS));
    nNota += 1;
    return { chaveAcesso: 'CHAVE' + String(nNota).padStart(10, '0'), nNFSe: String(nNota) };
  }
  async downloadDanfse() { return Buffer.from('%PDF-teste'); }
} });
trocar('nfse-xml', { ...require(path.join(RAIZ, 'nfse-xml')),
  extrairChavesCertificado: () => ({ privateKeyPem: 'k', certDerBase64: 'c' }),
  assinarDPS: (xml) => xml });
trocar('email-client', { ...require(path.join(RAIZ, 'email-client')),
  loadSmtpConfig: () => ({ host: 'smtp.teste.invalid', port: 587, user: 'u', pass: 'p', fromEmail: 'a@teste.invalid' }),
  enviarEmailNfse: async (_db, o) => { EMAILS.push(o); return { success: true }; } });

const { emitirNfseInterno, dataBrasilia } = require('../nfse-routes');
const sched = require('../recorrencia-scheduler');
const { registrarRotasRecorrencia } = require('../recorrencia-routes');

// ---------- banco descartável com o schema real ----------
const DB = '/tmp/vp-recorr-lote.db';
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s); } catch {} }
const db = new Database(DB);
db.pragma('journal_mode = WAL');
const schema = require('./schema-de-tenant').lerSchema();
const { prepararAvisos } = require('./aviso-de-teste');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
db.prepare(`INSERT OR REPLACE INTO fornecedor (id, razaoSocial, cnpj, uf, codigoMunicipio)
  VALUES (1, 'PRESTADOR TESTE', '19884430000141', 'PA', '1504208')`).run();
for (const [k, v] of [['ambiente', '2'], ['serie', '1'], ['proximo_numero', '1']]) {
  db.prepare('INSERT OR REPLACE INTO nfse_config (key, value) VALUES (?, ?)').run(k, v);
}
db.prepare(`INSERT OR REPLACE INTO certificado_digital (id, certificadoBase64, senhaCriptografada)
  VALUES (1, 'eA==', ?)`).run(Buffer.from('x').toString('base64'));

let seqDoc = 100;
function recorrencia({ enviarEmail = 1, email = 'cliente@teste.invalid', semCodigo = false, dia = 1 } = {}) {
  seqDoc += 1;
  const pessoaId = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, email, ativo, cobrancaAtiva)
    VALUES (?, 'PJ', ?, ?, 1, 0)`).run('11222333000' + seqDoc, 'Cliente ' + seqDoc, email).lastInsertRowid;
  return db.prepare(`INSERT INTO nfse_recorrencias (pessoaId, ativo, gerarBoleto, enviarEmail, diaVencimentoBoleto,
    codigoTributacaoNacional, descricao, valorServico) VALUES (?, 1, 0, ?, ?, ?, 'Suporte mensal', 250)`)
    .run(pessoaId, enviarEmail, dia, semCodigo ? '' : '010701').lastInsertRowid;
}
const linhaRec = (id) => db.prepare(`SELECT r.*, p.cpfCnpj, p.razaoSocial, p.inscricaoMunicipal, p.email,
  p.emailsAdicionais, p.endereco, p.numero, p.complemento, p.bairro, p.codigoMunicipio, p.uf, p.cep
  FROM nfse_recorrencias r JOIN pessoas p ON p.id = r.pessoaId WHERE r.id = ?`).get(id);
const desativarTodas = () => db.prepare('UPDATE nfse_recorrencias SET ativo = 0').run();
const esperar = (ms) => new Promise(r => setTimeout(r, ms));
async function esperarFimDoLote(limiteMs = 20000) {
  const ate = Date.now() + limiteMs;
  while (Date.now() < ate) {
    if (!sched.loteEmAndamento(sched.lerEstadoLote(db))) return sched.lerEstadoLote(db);
    await esperar(50);
  }
  throw new Error('o lote não terminou');
}

// ---------- rotas chamadas direto, como nas outras suítes ----------
const app = express();
app.use(express.json());
registrarRotasRecorrencia(app, db);
const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
async function chamar(p, m, o = {}) {
  let out = null, st = 200;
  const res = { json: x => { out = x; return res; }, status: c => { st = c; return res; } };
  await achar(p, m)({ params: o.params || {}, query: o.query || {}, body: o.body || {} }, res);
  return { out, st };
}

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

// ============================================================================
// A. vencimento
// ============================================================================
t('A1. dia que já passou vai para o mesmo dia do mês seguinte', () => {
  assert(sched.vencimentoDaCompetencia('2026-09', 5, '2026-09-24') === '2026-10-05', 'set/5');
  assert(sched.vencimentoDaCompetencia('2026-09', 20, '2026-09-24') === '2026-10-20', 'set/20');
});
t('A2. dia que ainda não passou, ou é hoje, fica no mês', () => {
  assert(sched.vencimentoDaCompetencia('2026-09', 24, '2026-09-24') === '2026-09-24', 'hoje');
  assert(sched.vencimentoDaCompetencia('2026-10', 10, '2026-10-01') === '2026-10-10', 'dia 1 do agendador');
});
t('A3. dezembro passa para janeiro do ano seguinte', () => {
  assert(sched.vencimentoDaCompetencia('2026-12', 10, '2026-12-20') === '2027-01-10', 'virada de ano');
});
t('A4. dia maior que o mês cai no último dia, nos dois meses', () => {
  assert(sched.vencimentoDaCompetencia('2026-09', 31, '2026-09-01') === '2026-09-30', 'set/31');
  assert(sched.vencimentoDaCompetencia('2026-01', 31, '2026-02-01') === '2026-02-28', 'jan/31 depois do dia');
});

// ============================================================================
// B. e-mail
// ============================================================================
t('B1. recorrência com a caixa marcada: exatamente um e-mail, com a nota', async () => {
  EMAILS.length = 0;
  const id = recorrencia({ enviarEmail: 1 });
  const r = await sched.executarUmaRecorrencia(db, linhaRec(id), '2026-09');
  assert(r.status === 'sucesso', 'status: ' + JSON.stringify(r));
  assert(EMAILS.length === 1, `saíram ${EMAILS.length} e-mails, esperado 1`);
  assert(EMAILS[0].pdfBuffer && EMAILS[0].nfseNumero, 'o e-mail não levou a nota: ' + JSON.stringify(EMAILS[0]));
});
t('B2. recorrência com a caixa desmarcada: nenhum e-mail', async () => {
  EMAILS.length = 0;
  const id = recorrencia({ enviarEmail: 0 });
  const r = await sched.executarUmaRecorrencia(db, linhaRec(id), '2026-09');
  assert(r.status === 'sucesso', 'status: ' + JSON.stringify(r));
  assert(EMAILS.length === 0, `saíram ${EMAILS.length} e-mails com a caixa desmarcada`);
});
t('B3. emissão avulsa, fora de recorrência, continua mandando o e-mail', async () => {
  EMAILS.length = 0;
  const r = await emitirNfseInterno(db, {
    tomador: { cpfCnpj: '11222333000999', razaoSocial: 'Avulso LTDA', email: 'avulso@teste.invalid' },
    servico: { codigoTributacaoNacional: '010701', descricao: 'Serviço avulso', valorServico: 90 },
  });
  assert(r.success, 'emissão: ' + r.error);
  assert(EMAILS.length === 1, `saíram ${EMAILS.length} e-mails na emissão avulsa, esperado 1`);
});
t('B4. a conta da recorrência nasce com o vencimento da regra, nunca antes de hoje', async () => {
  const id = recorrencia({ dia: 1 });
  const comp = dataBrasilia().slice(0, 7);
  const r = await sched.executarUmaRecorrencia(db, linhaRec(id), comp);
  assert(r.status === 'sucesso', 'status');
  const log = db.prepare('SELECT contaReceberId FROM nfse_recorrencias_log WHERE id = ?').get(r.logId);
  const cr = db.prepare('SELECT dataVencimento FROM contas_a_receber WHERE id = ?').get(log.contaReceberId);
  const hoje = dataBrasilia();
  assert(cr.dataVencimento === sched.vencimentoDaCompetencia(comp, 1, hoje), 'vencimento ' + cr.dataVencimento);
  assert(cr.dataVencimento >= hoje, `conta nasceu vencida: ${cr.dataVencimento} < ${hoje}`);
});

// ============================================================================
// C. lote
// ============================================================================
let IDS_OK = [], IDS_FALHA = [];
t('C1. o POST responde na hora e o lote segue em segundo plano', async () => {
  desativarTodas();
  IDS_OK = Array.from({ length: 10 }, () => recorrencia({ enviarEmail: 0 }));
  IDS_FALHA = [recorrencia({ semCodigo: true }), recorrencia({ semCodigo: true })];
  ATRASO_MS = 60;
  const ini = Date.now();
  const r = await chamar('/api/recorrencias/executar', 'post');
  const ms = Date.now() - ini;
  assert(r.st === 202 && r.out.success, 'resposta: ' + r.st + ' ' + JSON.stringify(r.out));
  assert(ms < 200, `o POST levou ${ms}ms: esperou o lote`);
  assert(r.out.execucao.total === 12, 'total ' + r.out.execucao.total);
});
t('C2. o andamento avança enquanto roda', async () => {
  await esperar(250);
  const a = (await chamar('/api/recorrencias/execucao', 'get')).out;
  assert(a.emAndamento && a.execucao.processadas > 0 && a.execucao.processadas < 12,
    'andamento: ' + JSON.stringify(a));
});
t('C3. um segundo clique durante a execução recebe 409 com o andamento', async () => {
  const r = await chamar('/api/recorrencias/executar', 'post');
  assert(r.st === 409 && r.out.execucao && /andamento/.test(r.out.error), 'resposta: ' + r.st + ' ' + JSON.stringify(r.out));
});
t('C4. o agendador não inicia outra execução por cima do botão', async () => {
  const antes = EMISSOES.length;
  const r = await sched.executarRecorrencias(db);
  assert(r.ocupado === true, 'agendador: ' + JSON.stringify(r));
  await esperar(20);
  assert(EMISSOES.length - antes <= 1, 'o agendador emitiu junto com o botão');
});
t('C5. no fim: 10 emitidas, 2 com falha, e o erro aparece na lista', async () => {
  const e = await esperarFimDoLote();
  assert(e.status === 'concluido' && e.processadas === 12, 'estado: ' + JSON.stringify(e));
  assert(e.sucesso === 10 && e.falha === 2 && e.jaEmitidas === 0, 'contagem: ' + JSON.stringify(e));
  const lista = (await chamar('/api/recorrencias', 'get')).out.recorrencias;
  const falhas = lista.filter(x => IDS_FALHA.includes(x.id));
  assert(falhas.every(x => x.ultimoStatus === 'erro' && /servico/i.test(x.ultimoErro) && x.ultimaCompetencia),
    'erro na lista: ' + JSON.stringify(falhas.map(x => [x.ultimoStatus, x.ultimoErro, x.ultimaCompetencia])));
});
t('C6. executar de novo não reemite: 10 já emitidas, as 2 falham de novo', async () => {
  const antes = EMISSOES.length;
  const r = await chamar('/api/recorrencias/executar', 'post');
  assert(r.st === 202, 'status ' + r.st);
  const e = await esperarFimDoLote();
  assert(e.jaEmitidas === 10 && e.sucesso === 0 && e.falha === 2, 'contagem: ' + JSON.stringify(e));
  assert(EMISSOES.length === antes, `emitiu ${EMISSOES.length - antes} notas de novo`);
});
t('C7. trava de execução que morreu vence e deixa outra começar', async () => {
  desativarTodas();
  const velho = new Date(Date.now() - sched.LOTE_TRAVA_VENCE_MS - 60000).toISOString();
  db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('recorrencias_lote', ?)")
    .run(JSON.stringify({ id: 'morto', status: 'rodando', origem: 'botao', competencia: '2026-09',
      total: 5, processadas: 2, atualizadoEm: velho }));
  const r = await chamar('/api/recorrencias/executar', 'post');
  assert(r.st === 202, 'status ' + r.st + ' ' + JSON.stringify(r.out));
  await esperarFimDoLote();
});
t('C8. dois processos pedindo a trava ao mesmo tempo: só um leva', async () => {
  desativarTodas();
  const outro = new Database(DB);
  const a = sched.iniciarLote(db, 'botao');
  const b = sched.iniciarLote(outro, 'agendador');
  outro.close();
  assert(!a.ocupado && b.ocupado && b.estado.id === a.estado.id, JSON.stringify([a.ocupado, b.ocupado]));
  await sched.processarLote(db, a.estado);
});
t('C9. o lote que perdeu a trava para no meio e não sobrescreve o estado de quem assumiu', async () => {
  desativarTodas();
  Array.from({ length: 6 }, () => recorrencia({ enviarEmail: 0 }));
  ATRASO_MS = 60;
  const { estado } = sched.iniciarLote(db, 'botao');
  const rodando = sched.processarLote(db, estado);
  await esperar(100);
  const novo = { ...estado, id: 'assumiu', processadas: 0, atualizadoEm: new Date().toISOString() };
  db.prepare("UPDATE config SET valor = ? WHERE chave = 'recorrencias_lote'").run(JSON.stringify(novo));
  const fim = await rodando;
  assert(fim.processadas < 6, 'processou tudo mesmo sem a trava: ' + fim.processadas);
  assert(sched.lerEstadoLote(db).id === 'assumiu', 'sobrescreveu o estado de quem assumiu');
  db.prepare("DELETE FROM config WHERE chave = 'recorrencias_lote'").run();
});
t('C10. emissão "processando" recente de outra execução não é refeita; antiga é', async () => {
  desativarTodas();
  const id = recorrencia({ enviarEmail: 0 });
  db.prepare("INSERT INTO nfse_recorrencias_log (recorrenciaId, competencia, status) VALUES (?, '2026-08', 'processando')").run(id);
  const antes = EMISSOES.length;
  let erro = null;
  try { await sched.executarUmaRecorrencia(db, linhaRec(id), '2026-08'); } catch (e) { erro = e.message; }
  assert(/sendo emitida/.test(erro || ''), 'não recusou: ' + erro);
  assert(EMISSOES.length === antes, 'emitiu por cima de outra execução');
  db.prepare("UPDATE nfse_recorrencias_log SET dataCriacao = datetime('now', '-30 minutes') WHERE recorrenciaId = ?").run(id);
  const r = await sched.executarUmaRecorrencia(db, linhaRec(id), '2026-08');
  assert(r.status === 'sucesso', 'a antiga não foi refeita: ' + JSON.stringify(r));
});

// ============================================================================
// D. tela
// ============================================================================
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));
let browser, srv, base;

function subirServidor() {
  const web = express();
  web.use(express.json());
  registrarRotasRecorrencia(web, db);
  web.use('/api', (req, res) => res.json({ success: true, pessoas: [], features: {} }));
  web.get('/__e', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
    <iframe id="tela" src="/financeiro/recorrencias.html"></iframe>`));
  web.use(express.static(PUB));
  return new Promise((r) => { const s = http.createServer(web).listen(0, '127.0.0.1', () => r(s)); });
}
async function abrir() {
  const page = await browser.newPage();
  /* O `confirm()` do navegador era dispensado pelo puppeteer sozinho, e com
     isso a suíte clicava em "excluir" e o fluxo seguia. Desde 01/10/2026 a
     confirmação é a caixa do sistema (`Aviso.confirmar`), que é uma PROMESSA
     esperando alguém clicar: sem isto, o `evaluate` fica pendurado e a suíte
     morre com "Runtime.callFunctionOn timed out". `prepararAvisos` responde
     SIM, que é o que o diálogo nativo fazia, e registra o que foi pedido em
     `window.__confirmacoes`. */
  await prepararAvisos(page);

  const erros = [];
  page.on('pageerror', (e) => erros.push(`${e.name}: ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base + '/__e', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await esperar(1500);
  const frame = await (await page.$('#tela')).contentFrame();
  return { page, frame, erros };
}
const visivel = (frame, sel) => frame.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { h: r.height, w: r.width, texto: el.textContent.trim(), classe: el.className,
    display: getComputedStyle(el).display };
}, sel);

let IDS_TELA_FALHA = [];
t('D1. a lista mostra, visível, o erro da última execução', async () => {
  desativarTodas();
  Array.from({ length: 10 }, () => recorrencia({ enviarEmail: 0 }));
  IDS_TELA_FALHA = [recorrencia({ semCodigo: true }), recorrencia({ semCodigo: true })];
  for (const id of IDS_TELA_FALHA) {
    db.prepare(`INSERT INTO nfse_recorrencias_log (recorrenciaId, competencia, status, erro)
      VALUES (?, '2026-08', 'erro', 'Certificado digital não configurado')`).run(id);
  }
  const { page, frame, erros } = await abrir();
  try {
    const r = await frame.evaluate(() => [...document.querySelectorAll('.erro-rec')].map(e => {
      const b = e.getBoundingClientRect(); return { h: b.height, t: e.textContent };
    }));
    const destas = r.filter(x => /Falhou em 08\/2026: Certificado digital não configurado/.test(x.t));
    assert(destas.length === 2, 'erros destas recorrências na lista: ' + destas.length);
    assert(r.every(x => x.h > 0), 'erro na lista sem altura: ' + JSON.stringify(r));
    assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
  } finally { await page.close(); }
});
t('D2. o clique mostra "x de N", trava o botão, avança e termina com o resultado', async () => {
  ATRASO_MS = 250;
  const { page, frame, erros } = await abrir();
  const semEmissao = () => frame.evaluate(() => [...document.querySelectorAll('#tabelaRecorrencias tr')]
    .filter(tr => /^-/.test(tr.children[5].textContent.trim()) && /Ativo/.test(tr.children[6].textContent)).length);
  try {
    const antes = await semEmissao();
    assert(antes === 12, 'linhas ativas sem emissão antes do clique: ' + antes);
    // Clique pelo DOM: fora do shell a sidebar.js desenha a topbar fixa por cima
    // do cabeçalho da tela, e o clique por coordenada cairia nela. No shell a
    // tela fica abaixo da barra; isso é conferido no sandbox, não aqui.
    await frame.$eval('#btnExecutarTodas', b => b.click());
    await esperar(400);
    const p1 = await visivel(frame, '#progressoLote');
    assert(p1 && p1.h > 0 && p1.display !== 'none', 'andamento invisível: ' + JSON.stringify(p1)
      + ' alerta=' + JSON.stringify(await visivel(frame, '#alertBox')) + ' js=' + erros.join(' | '));
    const m1 = p1.texto.match(/Emitindo as recorrências de \d\d\/\d{4}: (\d+) de (\d+)/);
    assert(m1 && m1[2] === '12', 'texto: ' + p1.texto);
    assert(await frame.$eval('#btnExecutarTodas', b => b.disabled), 'botão livre durante a execução');
    await esperar(1600);
    const m2 = (await visivel(frame, '#progressoLote')).texto.match(/: (\d+) de 12/);
    assert(m2 && Number(m2[1]) > Number(m1[1]), `não avançou: ${m1[1]} -> ${m2 && m2[1]}`);
    await esperarFimDoLote();
    await esperar(1500);
    const fim = await visivel(frame, '#progressoLote');
    assert(/concluída: 10 emitidas e 2 com falha/.test(fim.texto) && /error/.test(fim.classe),
      'resultado: ' + JSON.stringify(fim));
    assert(!(await frame.$eval('#btnExecutarTodas', b => b.disabled)), 'botão continua travado');
    const depois = await semEmissao();
    assert(depois === 2, `a lista não recarregou: ${depois} linhas ativas ainda sem emissão (esperado 2, as que falharam)`);
    assert(!erros.length, 'erros de JS: ' + erros.join(' | '));
  } finally { await page.close(); }
});
t('D3. quem abre a tela durante a execução vê o andamento', async () => {
  desativarTodas();
  Array.from({ length: 8 }, () => recorrencia({ enviarEmail: 0 }));
  ATRASO_MS = 600;
  await chamar('/api/recorrencias/executar', 'post');
  const { page, frame } = await abrir();
  try {
    await esperar(1200);
    const p = await visivel(frame, '#progressoLote');
    assert(p && p.h > 0 && /: \d+ de 8/.test(p.texto), 'não retomou: ' + JSON.stringify(p));
  } finally { await page.close(); await esperarFimDoLote(); }
});

(async () => {
  for (const [nome, fn] of fila) {
    if (nome.startsWith('D1') && !browser) {
      if (!CHROME) { console.log('FALHA Chrome não encontrado'); fail++; break; }
      srv = await subirServidor();
      base = `http://127.0.0.1:${srv.address().port}`;
      browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
        args: ['--no-sandbox', '--disable-gpu'], userDataDir: '/tmp/vp-recorr-lote-chrome' });
    }
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  if (browser) await browser.close();
  if (srv) srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
