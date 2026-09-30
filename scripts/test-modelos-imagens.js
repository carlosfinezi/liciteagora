/**
 * As imagens do modelo de mensagem, medidas em Chrome (29/09/2026).
 *
 * O defeito: a imagem só subia por um botão "Adicionar imagem" ao lado do
 * campo de arquivo. Quem escolhia a foto e clicava em "Salvar modelo" salvava
 * só o texto, e a foto se perdia sem aviso. Nenhuma imagem de modelo chegou ao
 * servidor do 1bit, e a campanha saiu sem foto. A suíte de comunicação só
 * procurava a rota no fonte da tela, e por isso passava.
 *
 *  M1  no modelo que já existe, a foto sobe assim que é escolhida
 *  M2  no modelo novo, a foto espera o salvar e sobe para o id que ele criou
 *  M3  foto recusada deixa o modal aberto e diz qual foi
 *  M4  o botão separado saiu
 *
 * A API é simulada: o que está sob teste é a tela. As rotas de verdade têm a
 * prova delas na test-comunicacao.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Um PNG de 1x1 de verdade, para o navegador tratar como imagem.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelos-imagens-'));
const FOTO = path.join(dir, 'foto.png');
const RUIM = path.join(dir, 'recusada.png');
fs.writeFileSync(FOTO, PNG);
fs.writeFileSync(RUIM, PNG);

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));
  const multer = require(path.join(RAIZ, 'node_modules/multer'));
  const upload = multer({ storage: multer.memoryStorage() });

  let DEMORAR = false;           // o M6 segura a resposta do envio, como faz um vídeo grande
  const MODELOS = [{ id: 1, nome: 'liciteagora', canal: 'whatsapp', assunto: null, corpo: 'Olá {{primeiroNome}}', imagens: 0 }];
  const imagens = {};            // id do modelo → [arquivos]
  const pedidos = [];            // cada escrita, na ordem em que chegou
  const app = express();
  app.use(express.json());
  app.get('/api/comm/templates', (_q, rs) => rs.json({ success: true,
    templates: MODELOS.map(m => ({ ...m, imagens: (imagens[m.id] || []).length })) }));
  app.post('/api/comm/templates', (rq, rs) => {
    const m = { id: 9, ...rq.body };
    MODELOS.push(m);
    pedidos.push('criou modelo 9');
    rs.json({ success: true, avisos: [], template: m });
  });
  app.put('/api/comm/templates/:id', (rq, rs) => { pedidos.push('salvou modelo ' + rq.params.id); rs.json({ success: true, avisos: [] }); });
  app.get('/api/comm/templates/:id/imagens', (rq, rs) => rs.json({ success: true, imagens: imagens[rq.params.id] || [], max: 20 }));
  app.get('/api/comm/templates/:id/imagens/:arquivo', (_q, rs) => rs.type('png').send(PNG));
  app.post('/api/comm/templates/:id/imagens', upload.single('imagem'), async (rq, rs) => {
    const nome = rq.file && rq.file.originalname;
    pedidos.push(`imagem ${nome} no modelo ${rq.params.id}`);
    // Vídeo grande responde devagar, e é durante essa espera que o M6 clica em
    // Salvar. Sem segurar a resposta não há "envio em curso" para medir.
    if (DEMORAR) await esperar(1000);
    // Recusa com 200 e success:false, como a rota faz com arquivo que não é
    // imagem: o D1 mede só o que não era esperado.
    if (nome === 'recusada.png') return rs.json({ success: false, error: 'não é uma imagem' });
    (imagens[rq.params.id] = imagens[rq.params.id] || []).push('img-' + Date.now() + '.png');
    rs.json({ success: true });
  });
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  app.get('/__wrapper/:tela', (rq, rs) => rs.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
    + `ipt></head><body style="margin:0"><iframe src="/comunicacao/${rq.params.tela}.html"`
    + ' style="display:block;width:100vw;height:100vh;border:0"></iframe></body></html>'));
  app.use(express.static(PUB));
  const srv = app.listen(0);
  const porta = srv.address().port;

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new', userDataDir: path.join(dir, 'chrome'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const erros = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', e => erros.push(String(e.message)));
  page.on('response', r => { if (r.status() >= 400) erros.push(`${r.status()} em ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${porta}/__wrapper/modelos`, { waitUntil: 'networkidle0' });
  const frame = page.frames().find(f => f.url().includes('/comunicacao/modelos.html'));
  if (!frame) { console.log('FALHA modelos.html não carregou no iframe'); process.exit(1); }

  const escolher = async (arquivo) => {
    const campo = await frame.$('#mdArquivo');
    await campo.uploadFile(arquivo);
    await esperar(700);
  };

  await t('M4 o botão separado de adicionar imagem saiu', async () => {
    const txt = await frame.$eval('#modalModelo', e => e.textContent);
    assert(!/Adicionar imagem/.test(txt), 'o botão "Adicionar imagem" continua no modal');
  });

  await t('M1 no modelo existente, a foto sobe assim que é escolhida', async () => {
    await frame.evaluate(() => abrirModelo(1));
    await esperar(300);
    const visivel = await frame.$eval('#mdLinhaImagem', e => e.offsetHeight > 0);
    assert(visivel, 'a linha de imagens não aparece no modelo de WhatsApp');
    pedidos.length = 0;
    await escolher(FOTO);
    assert(pedidos.join(',') === 'imagem foto.png no modelo 1', 'chegou: ' + (pedidos.join(', ') || 'nada'));
    const mostradas = await frame.$$eval('#mdImagens img', els => els.length);
    assert(mostradas === 1, `a grade mostra ${mostradas} imagem(ns)`);
    await frame.evaluate(() => fechar('modalModelo'));
  });

  await t('M2 no modelo novo, a foto sobe ao salvar, para o id que o salvar criou', async () => {
    await frame.evaluate(() => abrirModelo());
    await esperar(300);
    const visivel = await frame.$eval('#mdLinhaImagem', e => e.offsetHeight > 0);
    assert(visivel, 'a linha de imagens não aparece no modelo novo');
    pedidos.length = 0;
    await escolher(FOTO);
    assert(!pedidos.length, 'subiu antes de existir o modelo: ' + pedidos.join(', '));
    const aviso = await frame.$eval('#mdPendentes', e => e.textContent);
    assert(/ao salvar/.test(aviso), `o campo diz "${aviso}"`);
    await frame.evaluate(() => {
      document.getElementById('mdNome').value = 'novo';
      document.getElementById('mdCorpo').value = 'Olá {{primeiroNome}}';
      salvarModelo();
    });
    await esperar(1000);
    assert(pedidos.join(',') === 'criou modelo 9,imagem foto.png no modelo 9', 'ordem: ' + pedidos.join(', '));
    const aberto = await frame.$eval('#modalModelo', e => e.classList.contains('open'));
    assert(!aberto, 'o modal ficou aberto depois de salvar');
  });

  await t('M3 foto recusada deixa o modal aberto e diz qual foi', async () => {
    await frame.evaluate(() => abrirModelo(1));
    await esperar(300);
    const campo = await frame.$('#mdArquivo');
    // Escolhida sem disparar o envio imediato: é o caminho do salvar que se mede.
    await frame.evaluate(() => { EDIT_MODELO = null; });
    await campo.uploadFile(RUIM);
    await esperar(300);
    await frame.evaluate(() => {
      document.getElementById('mdNome').value = 'outro';
      document.getElementById('mdCorpo').value = 'Oi';
      salvarModelo();
    });
    await esperar(1000);
    const aberto = await frame.$eval('#modalModelo', e => e.classList.contains('open'));
    const aviso = await frame.$eval('#mdAviso', e => e.textContent);
    assert(aberto && /recusada\.png/.test(aviso), `aberto: ${aberto}, aviso: "${aviso}"`);
  });

  // 30/09: o vídeo do modelo "Alimentação" não entrava, e o "Salvar modelo"
  // parecia não fazer nada. A recusa do primeiro envio limpava o campo, então o
  // arquivo desaparecia da tela: o clique seguinte em Salvar não tinha mais o
  // que enviar e salvava só o texto, calado. Foram 8 PUTs do modelo sem um único
  // POST de arquivo no log do nginx.
  await t('M5 arquivo recusado continua escolhido, e o envio seguinte o manda', async () => {
    await frame.evaluate(() => abrirModelo(1));
    await esperar(300);
    await escolher(RUIM);
    let n = await frame.$eval('#mdArquivo', e => e.files.length);
    assert(n === 1, `a recusa esvaziou o campo: ${n} arquivo(s) escolhido(s)`);
    const aviso = await frame.$eval('#mdPendentes', e => e.textContent);
    assert(/ainda escolhido/.test(aviso), `o campo não diz que o arquivo ficou: "${aviso}"`);
    // É isso que estava impossível: tentar de novo sem reabrir o seletor.
    pedidos.length = 0;
    await frame.evaluate(() => enviarImagensModelo());
    await esperar(700);
    assert(/recusada\.png no modelo 1/.test(pedidos.join(',')), 'o reenvio não mandou: ' + (pedidos.join(', ') || 'nada'));
    // O arquivo aceito, por outro lado, limpa o campo (M1 mede o envio; aqui, a limpeza).
    await escolher(FOTO);
    n = await frame.$eval('#mdArquivo', e => e.files.length);
    assert(n === 0, 'o campo não foi limpo depois do envio aceito');
    await frame.evaluate(() => fechar('modalModelo'));
  });

  await t('M6 envio em curso nao vira dois envios do mesmo arquivo', async () => {
    await frame.evaluate(() => abrirModelo(1));
    await esperar(300);
    DEMORAR = true;                       // o servidor simulado segura a resposta
    pedidos.length = 0;
    await frame.evaluate(() => { document.getElementById('mdArquivo').dispatchEvent(new Event('change')); });
    const campo = await frame.$('#mdArquivo');
    await campo.uploadFile(FOTO);
    await esperar(200);
    // Durante o envio, dois cliques em Salvar: nenhum deles começa outro envio.
    await frame.evaluate(() => { salvarModelo(); salvarModelo(); });
    await esperar(400);
    const emCurso = pedidos.filter(p => /foto\.png/.test(p)).length;
    assert(emCurso === 1, `${emCurso} envios do mesmo arquivo ao mesmo tempo`);
    const aviso = await frame.$eval('#mdAviso', e => e.textContent);
    assert(/ainda está subindo/.test(aviso), `o Salvar não avisou do envio em curso: "${aviso}"`);
    DEMORAR = false;
    await esperar(1200);
    await frame.evaluate(() => fechar('modalModelo'));
  });

  await t('D1 nenhum erro de JavaScript nem 404 na tela', () => {
    assert(erros.length === 0, erros.slice(0, 4).join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
