/**
 * A dor por segmento, e o modelo da campanha, à vista na tela.
 *
 * ── O que estava escondido ────────────────────────────────────────────────
 *
 * A primeira mensagem da campanha legado não usa {{variavel}}: o Node escolhe
 * o segmento pelo ramo do contato, sorteia uma dor e a entrega pronta ao
 * modelo, que só redige as ligações. Isso vive em `config.dores_por_ramo`, e
 * até aqui só existia dentro do JSON avançado. A campanha `leads-pa-erp-m1` do
 * `1bit` está com nove segmentos e 35 frases, e nenhuma delas aparecia na tela.
 *
 * Dois modos de falha que ninguém via, e que esta suíte guarda:
 *
 * 1. Segmento com contato e sem frase não dá erro nenhum. Essa gente recebe a
 *    frase genérica, e a campanha `leads-pa-pregao` tem 15.885 contatos nessa
 *    situação.
 * 2. Frase gravada numa chave que `chaveDoRamo` não devolve nunca é sorteada.
 *    O texto fica no config parecendo configuração viva.
 *
 * A terceira parte cobre o modelo de mensagem: a campanha mostrava o nome dela
 * sem dizer qual texto vai sair, e a lista de modelos não dizia quais estavam
 * em uso.
 *
 * Desde 2026-09-28 a primeira mensagem da campanha legado sai do MODELO, e
 * nunca da IA. As seções da página que configuravam a IA saíram, e a parte C
 * passou a guardar a escolha do modelo. A parte A continua medindo o
 * classificador de segmento, que a lista de contatos ainda usa. O envio em si,
 * sem IA, é provado em `test-campanha-modelo.js`.
 */
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PORTA = 34177;

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

const { chaveDoRamo, RAMOS } = require('../wa-m1-utils');
const { esperarFrame } = require('./frame-de-teste');

(async () => {
  // ==================== A. o classificador de segmento ====================

  await t('A1. o ramo do cadastro cai no segmento certo', () => {
    const cheias = Object.fromEntries([...RAMOS, 'generico'].map(k => [k, ['.']]));
    assert(chaveDoRamo('Comércio varejista de bebidas', cheias) === 'bebidas', 'bebidas');
    assert(chaveDoRamo('MERCADINHO SAO JOSE', cheias) === 'mercado', 'mercadinho');
    assert(chaveDoRamo('Salão de beleza', cheias) === 'beleza', 'salão');
    assert(chaveDoRamo('Serralheria industrial', cheias) === 'generico',
      'ramo que não casa com regra nenhuma precisa cair no genérico');
  });

  await t('A2. segmento SEM frase manda o contato para o generico', () => {
    // O modo de falha silencioso: nenhum erro, e a pessoa recebe a frase de
    // outro segmento. É o que a contagem da tela passa a mostrar.
    const dores = { generico: ['dor generica'] };       // bebidas sem frase
    assert(chaveDoRamo('Distribuidora de bebidas', dores) === 'generico',
      'um segmento vazio não deveria ser escolhido');
  });

  // ==================== B. a tela ====================

  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));
  const app = express();
  app.use(express.json());
  // As imagens do modelo 1: duas, servidas como PNG de 1x1, e a remoção anotada.
  const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  let imagemRemovida = null;
  app.get('/api/comm/templates/:id/imagens', (_q, rs) => rs.json({ success: true, imagens: ['img-1-1.png', 'img-2-2.png'], max: 20 }));
  app.get('/api/comm/templates/:id/imagens/:arquivo', (_q, rs) => rs.type('png').send(PNG1));
  app.delete('/api/comm/templates/:id/imagens/:arquivo', (rq, rs) => {
    imagemRemovida = rq.params.arquivo; rs.json({ success: true, imagens: ['img-2-2.png'] });
  });

  // A campanha 6 está num servidor que já envia pelo modelo; a 8 simula o
  // servidor antigo, que ainda não manda o sinal `mensagemPorModelo`.
  let salvo = null, pedidoPrevia = null;
  app.get('/api/conversas/campanhas/wa/:id', (rq, rs) => rs.json({ success: true,
    campanha: { id: Number(rq.params.id), nome: 'leads-pa-pregao', status: 'pausada',
      config: { templateId: rq.params.id === '8' ? undefined : 1, dores_por_ramo: { farmacia: ['a', 'b', 'c'] }, canais: [2],
                horario_permitido: { inicio: '09:00', fim: '18:00', dias: ['seg', 'ter', 'qua', 'qui', 'sex'] } } },
    destinatarios: { pendente: 15885 },
    ...(rq.params.id === '8' ? {} : { mensagemPorModelo: true }) }));
  app.put('/api/conversas/campanhas/wa/:id', (rq, rs) => { salvo = rq.body; rs.json({ success: true }); });
  // Os números da empresa (desde 28/09): dois, para a campanha escolher.
  app.get('/api/whatsapp/canais', (_q, rs) => rs.json({ success: true, canais: [
    { id: 1, nome: 'Comercial', padrao: true, state: 'open' }, { id: 2, nome: 'Suporte', padrao: false, state: 'open' } ] }));
  app.get('/api/roteiros', (_q, rs) => rs.json({ success: true, roteiros: [], funis: [] }));
  app.get('/api/wa-campanhas/:id/images', (_q, rs) => rs.json({ success: true, images: [] }));
  app.post('/api/wa-campanhas/:id/sim-m1', (rq, rs) => { pedidoPrevia = rq.body; rs.json({ success: true,
    reply: 'Olá ADABOX tudo bem?\n\nResponda PARAR para nao receber mais.',
    contato: { nome: 'ADABOX', telefone: '5594991032093', exemplo: false }, comImagem: false,
    modelo: { id: 1, nome: 'Aviso de boleto' } }); });
  app.get('/api/comm/templates', (_q, rs) => rs.json({ success: true, templates: [
    { id: 1, nome: 'Aviso de boleto', canal: 'whatsapp', corpo: 'Olá {{primeiroNome}}', emUso: 2, imagens: 2 },
    { id: 2, nome: 'Modelo parado', canal: 'email', assunto: 'x', corpo: 'texto', emUso: 0 },
  ] }));
  // O cadastro de segmentos e a contagem por segmento da lista (28/09): a
  // campanha nova escolhe para quais segmentos da lista ela sai.
  app.get('/api/comm/segmentos', (_q, rs) => rs.json({ success: true, segmentos: [
    { id: 1, nome: 'Bebidas', chave: 'bebidas' }, { id: 9, nome: 'Genérico', chave: 'generico' }] }));
  app.get('/api/comm/listas/:id', (rq, rs) => rs.json({ success: true, lista: { id: Number(rq.params.id) },
    membros: [], total: 3, pagina: 1, porPagina: 1, porSegmento: [{ segmentoId: 1, n: 2 }, { segmentoId: 9, n: 1 }] }));
  app.get('/api/comm/listas', (_q, rs) => rs.json({ success: true,
    listas: [{ id: 3, nome: 'clientes ativos', qtdMembros: 40 }] }));
  let criado = null;
  app.post('/api/comm/campanhas', (rq, rs) => { criado = rq.body;
    rs.json({ success: true, campanha: { id: 9, totalDestinatarios: 12 } }); });
  app.post('/api/comm/templates', (rq, rs) => rs.json({ success: true, template: { id: 5 } }));
  let listaCriada = false;
  app.post('/api/comm/listas', (_q, rs) => { listaCriada = true; rs.json({ success: true, lista: { id: 8 } }); });
  app.post('/api/comm/listas/:id/membros', (_q, rs) => rs.json({ success: true, adicionados: 2 }));
  app.get('/api/comm/campanhas/:id', (_q, rs) => rs.json({ success: true,
    campanha: { id: 7, nome: 'Cobrança de agosto', tipo: 'operacional', templateId: 1,
                listaId: 3, status: 'rascunho', totalDestinatarios: 30 } }));
  app.get('/api/conversas/campanhas', (_q, rs) => rs.json({ success: true, campanhas: [
    { origem: 'comm', id: 7, nome: 'Cobrança de agosto', status: 'rascunho', criadoEm: '2026-09-01',
      destinatarios: null, totalDestinatarios: 30, templateId: 1, templateNome: 'Aviso de boleto' },
    { origem: 'wa', id: 6, nome: 'leads-pa-pregao', status: 'pausada', criadoEm: '2026-08-14',
      destinatarios: { pendente: 15468 } },
    // Enviada: é a que ficava sem "Editar" (as "(cópia)" do 1bit, 30/09).
    { origem: 'comm', id: 8, nome: 'Alimentação.. (cópia)', status: 'enviada', criadoEm: '2026-09-29',
      destinatarios: { enviado: 12 }, totalDestinatarios: 12, rodada: 2, templateId: 1 },
  ] }));
  app.get('/api/conversas/publico', (_q, rs) => rs.json({ success: true, ufs: ['PA'], total: 2, pessoas: [
    { id: 1, razaoSocial: 'Mercado Sao Jose', telefone: '5594999990001', cidade: 'Maraba', uf: 'PA',
      aceitaMarketing: true, optOut: false },
    { id: 2, razaoSocial: 'Quem pediu para sair', telefone: '5594999990002', cidade: 'Maraba', uf: 'PA',
      aceitaMarketing: false, optOut: true },
  ] }));
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  app.get('/api/ia/base', (_q, rs) => rs.json({ success: true, itens: [], correcoes: [] }));
  app.get('/api/whatsapp/status', (_q, rs) => rs.json({ success: true, connected: false, instance: 't' }));
  app.get('/api/whatsapp/ritmo', (_q, rs) => rs.json({ success: true, hora: 0, dia: 0, limiteHora: 25,
    podeEnviarAgora: true, motivo: null }));
  app.get('/api/whatsapp/ai-config', (_q, rs) => rs.json({ success: true, enabled: false, prompt: '',
    escopo: 'todos', horario: null, popupAtivo: false }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  app.get('/__wrapper/:tela', (rq, rs) => rs.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
    + `ipt></head><body style="margin:0"><iframe src="/comunicacao/${rq.params.tela}.html`
    // A query inteira vai para o iframe: a página usa `id`, `comm` e `nova`
    // para decidir o modo, e repassar só um deles deixava o teste medindo o
    // modo errado.
    + (Object.keys(rq.query).length ? '?' + new URLSearchParams(rq.query).toString() : '')
    + '" style="width:100vw;height:100vh;border:0;display:block"></iframe></body></html>'));
  app.use(express.static(PUB));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-campanha-segmentos', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const erros = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  page.on('pageerror', e => erros.push(String(e.message)));
  page.on('response', r => { if (r.status() >= 400) erros.push(`${r.status()} em ${r.url()}`); });
  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanhas`, { waitUntil: 'networkidle0' });
  let frame = await esperarFrame(page, f => f.url().includes('/comunicacao/campanhas.html'));
  if (!frame) { console.log('FALHA a tela não carregou'); process.exit(1); }
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));

  await frame.waitForFunction(() =>
    !/Carregando/.test(document.getElementById('tbCamp').textContent), { timeout: 8000 });

  await t('B1. a campanha diz qual modelo ela manda', async () => {
    const txt = await frame.$$eval('#tbCamp tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const linha = txt.find(x => /Cobrança de agosto/.test(x));
    assert(/modelo: Aviso de boleto/.test(linha), `a linha diz "${linha}"`);
  });

  await t('B1b. a campanha enviada tem Editar, junto de Enviar de novo', async () => {
    const linha = await frame.evaluate(() => {
      const tr = [...document.querySelectorAll('#tbCamp tr')].find(e => /\(cópia\)/.test(e.textContent));
      if (!tr) return null;
      return { principal: tr.querySelector('.acoes .btn')?.textContent.trim(),
               menu: [...tr.querySelectorAll('.acoes .itens button')].map(b => b.textContent.trim()) };
    });
    assert(linha, 'a campanha enviada não apareceu na listagem');
    assert(linha.principal === 'Enviar de novo', `o botão principal é "${linha.principal}"`);
    assert(linha.menu.includes('Editar'), 'o menu da enviada não tem Editar: ' + linha.menu.join(', '));
  });

  await t('B3. editar a campanha leva para a PAGINA, e nao abre modal', async () => {
    // Ela cresceu além do que cabe num modal, e era isso que fazia ninguém
    // mexer nas configurações.
    const temModal = await frame.$$eval('#modalWa', els => els.length);
    assert(temModal === 0, 'o modal de edição continua na listagem');
    const destino = await frame.evaluate(() => abrirCampanha.toString());
    assert(/\/comunicacao\/campanha\.html/.test(destino), `a edição iria para: ${destino}`);
  });

  await t('B2. a lista de modelos diz quais estao em uso', async () => {
    // Modelos era subguia de Campanhas até 28/09; agora é página própria.
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/modelos`, { waitUntil: 'networkidle0' });
    frame = await esperarFrame(page, f => f.url().includes('/comunicacao/modelos.html'));
    assert(!!frame, 'modelos.html não carregou');
    await frame.waitForFunction(() =>
      !/Carregando/.test(document.getElementById('tbModelos').textContent), { timeout: 8000 });
    const txt = await frame.$$eval('#tbModelos tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    assert(/2 campanha\(s\)/.test(txt.find(x => /Aviso de boleto/.test(x))), 'o modelo em uso não diz quantas');
    assert(/nenhuma/.test(txt.find(x => /Modelo parado/.test(x))), 'o modelo sem uso não diz que está parado');
    // "arquivo(s)", e não "imagem(ns)": o conjunto do modelo aceita vídeo MP4
    // desde 30/09, e a contagem é dos dois.
    assert(/2 arquivo\(s\)/.test(txt.find(x => /Aviso de boleto/.test(x))), 'a tabela não diz quantos arquivos o modelo tem');
  });

  await t('B2b. o modelo mostra as imagens dele, e o x remove a certa', async () => {
    // O modelo tem um conjunto de imagens desde 28/09; cada envio sorteia uma.
    await frame.evaluate(() => abrirModelo(1));
    await frame.waitForFunction(() => document.querySelectorAll('#mdImagens img').length === 2, { timeout: 8000 });
    await frame.waitForFunction(() => [...document.querySelectorAll('#mdImagens img')].every(i => i.complete && i.naturalWidth > 0),
      { timeout: 8000 });
    const tam = await frame.$$eval('#mdImagens img', els => els.map(e => Math.round(e.getBoundingClientRect().width)));
    assert(tam.every(w => w > 40), 'as miniaturas não aparecem: ' + tam.join(','));
    await frame.evaluate(() => document.querySelector('#mdImagens button[data-arquivo="img-1-1.png"]').click());
    await esperar(500);
    assert(imagemRemovida === 'img-1-1.png', 'removeu: ' + imagemRemovida);
    // Modelo de e-mail não manda imagem: a grade some.
    await frame.evaluate(() => { document.getElementById('mdCanal').value = 'email'; mudouCanalModelo(); });
    const vis = await frame.$eval('#mdLinhaImagem', e => e.style.display);
    assert(vis === 'none', 'a grade de imagens aparece num modelo de e-mail');
    await frame.evaluate(() => fechar('modalModelo'));
  });

  // ==================== C. a página da campanha legado ====================
  //
  // Desde 28/09 a primeira mensagem sai do modelo, e nunca da IA. As seções que
  // configuravam a IA (abordagem, exemplos, segmentos) saíram da página; o que
  // elas gravaram continua no config.

  const abrirLegado = async (id) => {
    salvo = null; pedidoPrevia = null;
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanha?id=${id}`, { waitUntil: 'networkidle0' });
    frame = await esperarFrame(page, f => f.url().includes('campanha.html'));
    if (!frame) { console.log('FALHA a página da campanha não carregou'); process.exit(1); }
    await frame.waitForFunction(() => document.querySelectorAll('#cModelo option').length > 1, { timeout: 8000 });
  };
  await abrirLegado(6);

  await t('C1. a campanha legado nao tem mais as secoes que configuravam a IA', async () => {
    const sobras = await frame.$$eval('#s-abordagem, #s-exemplos, #s-segmentos, #cRamos, #cExemplos, #s-avancado, #cJson',
      els => els.length);
    assert(sobras === 0, `${sobras} elemento(s) das seções da IA continuam na página`);
  });

  await t('C1b. sem indice lateral, e o limite por dia fica em Ritmo e horario', async () => {
    // O índice repetia os títulos de cinco seções curtas e saiu em 28/09.
    const indice = await frame.$$eval('.indice, #indice', els => els.length);
    assert(indice === 0, 'o índice lateral continua na página');
    const secao = await frame.$eval('#cDiario', e => e.closest('section').id);
    assert(secao === 's-ritmo', `o limite por dia está em #${secao}`);
  });

  await t('C2. o seletor traz so os modelos de WhatsApp, com o da campanha marcado', async () => {
    const opcoes = await frame.$$eval('#cModelo option', els => els.map(e => e.value));
    assert(JSON.stringify(opcoes) === JSON.stringify(['', '1']), 'opções: ' + JSON.stringify(opcoes));
    const v = await frame.$eval('#cModelo', e => e.value);
    assert(v === '1', `o modelo da campanha veio "${v}"`);
  });

  await t('C3. a previa mostra o texto exato, e para quem', async () => {
    await frame.waitForSelector('#cPrevia .fala', { visible: true, timeout: 8000 });
    const txt = await frame.$eval('#cPrevia .fala', e => e.textContent);
    assert(txt === 'Olá ADABOX tudo bem?\n\nResponda PARAR para nao receber mais.', `a prévia mostra "${txt}"`);
    assert(pedidoPrevia && pedidoPrevia.templateId === 1, 'a prévia não pediu o modelo escolhido: ' + JSON.stringify(pedidoPrevia));
    const quem = await frame.$eval('#cPrevia small', e => e.textContent);
    assert(/ADABOX, o próximo da fila/.test(quem), `a legenda diz "${quem}"`);
  });

  await t('C4. sem modelo escolhido, a pagina diz que a campanha nao envia', async () => {
    await frame.evaluate(() => { document.getElementById('cModelo').value = ''; previaModelo(); });
    const txt = await frame.$eval('#cPrevia', e => e.textContent);
    assert(/Sem modelo, a campanha não envia/.test(txt), `a página diz "${txt}"`);
  });

  await t('C4g. a pagina tem UMA barra de rolagem, e nao duas', async () => {
    // Campo com teto de altura vira barra dentro da barra da página, e quem
    // edita perde o lugar onde estava. O JSON avançado é a exceção: ele fica
    // dentro de um `details` fechado, e ali a barra própria é o certo.
    const rolando = await frame.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (!/auto|scroll/.test(getComputedStyle(el).overflowY)) continue;
        if (el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0) {
          out.push(el.id || el.tagName.toLowerCase());
        }
      }
      return out;
    });
    assert(rolando.length === 0, 'rolam por conta própria: ' + rolando.join(', '));
  });

  await t('C5. salvar leva o modelo escolhido, e null quando ele e tirado', async () => {
    await frame.evaluate(() => { document.getElementById('cModelo').value = '1'; salvar(); });
    await esperar(600);
    assert(salvo && salvo.config.templateId === 1, 'o modelo não viajou: ' + JSON.stringify(salvo && salvo.config));
    await frame.evaluate(() => { document.getElementById('cModelo').value = ''; salvar(); });
    await esperar(600);
    // null, e não a chave ausente: o servidor mescla o config, e ausente
    // manteria o modelo anterior.
    assert(salvo.config.templateId === null, 'tirar o modelo foi como ' + JSON.stringify(salvo.config.templateId));
  });

  await t('C6. salvar manda so os campos da tela, e o servidor mescla o resto', async () => {
    // Sem o JSON avançado, a tela não conhece o resto do config e não pode
    // reescrevê-lo. A mescla do servidor é provada em test-campanha-modelo (D5).
    const chaves = Object.keys(salvo.config).sort();
    const permitidas = ['canais', 'daily_limit', 'descricao', 'horario_permitido', 'roteiro_id', 'templateId', 'throttle_max_sec', 'throttle_min_sec'];
    assert(chaves.every(k => permitidas.includes(k)), 'mandou chave que a tela não mostra: ' + chaves.join(', '));
    assert(!('dores_por_ramo' in salvo.config), 'reenviou o config inteiro');
  });

  await t('C9. a campanha escolhe por quais numeros sai, e a escolha vai no salvar', async () => {
    await abrirLegado(6);
    await frame.waitForFunction(() => document.getElementById('cLinhaNumeros').style.display !== 'none', { timeout: 8000 });
    const caixas = await frame.$$eval('#cNumeros input', els => els.map(e => [e.value, e.checked]));
    assert(JSON.stringify(caixas) === '[["1",false],["2",true]]', 'caixas: ' + JSON.stringify(caixas));
    await frame.evaluate(() => { document.querySelector('#cNumeros input[value="1"]').checked = true; salvar(); });
    await esperar(600);
    assert(JSON.stringify(salvo.config.canais) === '[1,2]', 'salvou ' + JSON.stringify(salvo.config.canais));
    await frame.evaluate(() => { document.querySelectorAll('#cNumeros input').forEach(i => { i.checked = false; }); salvar(); });
    await esperar(600);
    // Nenhum marcado = lista vazia, que o servidor lê como "pelo padrão".
    assert(JSON.stringify(salvo.config.canais) === '[]', 'desmarcar tudo salvou ' + JSON.stringify(salvo.config.canais));
  });

  await t('C8. o horario carrega com os dias, e salva inicio, fim e dias juntos', async () => {
    await abrirLegado(6);
    const ini = await frame.$eval('#cIni', e => e.type + ' ' + e.value);
    assert(ini === 'time 09:00', `o início veio "${ini}"`);
    const marcados = await frame.$$eval('#cDias input:checked', els => els.map(e => e.value));
    assert(JSON.stringify(marcados) === '["seg","ter","qua","qui","sex"]', 'dias marcados: ' + marcados.join(','));
    await frame.evaluate(() => { document.querySelector('#cDias input[value="sab"]').checked = true; salvar(); });
    await esperar(600);
    assert(JSON.stringify(salvo.config.horario_permitido)
      === '{"inicio":"09:00","fim":"18:00","dias":["seg","ter","qua","qui","sex","sab"]}',
      'salvou ' + JSON.stringify(salvo.config.horario_permitido));
  });

  await t('C8b. meia janela e recusada na tela, e os dois em branco tiram o horario', async () => {
    salvo = null;
    await frame.evaluate(() => { document.getElementById('cFim').value = ''; salvar(); });
    await esperar(400);
    const aviso = await frame.$eval('#avisoTopo', e => e.textContent);
    assert(salvo === null && /início e o fim/.test(aviso), `salvou meia janela, ou o aviso diz "${aviso}"`);
    await frame.evaluate(() => { document.getElementById('cIni').value = ''; salvar(); });
    await esperar(600);
    assert(salvo && salvo.config.horario_permitido === null, 'em branco foi como ' + JSON.stringify(salvo && salvo.config.horario_permitido));
  });

  await t('C7. com o servidor antigo, a escolha fica travada e o salvar nao toca no modelo', async () => {
    // Antes do restart o motor ainda manda o texto da IA. Deixar escolher o
    // modelo ali faria a pessoa achar que o modelo seria enviado.
    await abrirLegado(8);
    const travado = await frame.$eval('#cModelo', e => e.disabled);
    assert(travado, 'o seletor ficou livre com o servidor antigo');
    const aviso = await frame.$eval('#cPrevia', e => e.textContent);
    assert(/próximo restart/.test(aviso), `o aviso diz "${aviso}"`);
    assert(pedidoPrevia === null, 'pediu prévia a um servidor que não sabe fazê-la');
    await frame.evaluate(() => salvar());
    await esperar(600);
    assert(salvo && !('templateId' in salvo.config), 'o salvar mexeu no modelo: ' + JSON.stringify(salvo && salvo.config));
  });

  // ==================== E. criar campanha, na mesma página ====================

  await t('E1. criar campanha abre a PAGINA, com as secoes dela', async () => {
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanha?nova=1`, { waitUntil: 'networkidle0' });
    frame = await esperarFrame(page, f => f.url().includes('campanha.html'));
    await frame.waitForFunction(() => document.querySelectorAll('#cLista option').length > 1, { timeout: 8000 });
    const titulo = await frame.$eval('#tituloCamp', e => e.textContent);
    assert(/Nova campanha/.test(titulo), `o título diz "${titulo}"`);
    // As seções do legado não fazem sentido aqui, e o contrário também não.
    const visiveis = await frame.$$eval('[data-modo]', els =>
      els.filter(e => e.style.display !== 'none').map(e => e.id).filter(Boolean));
    assert(visiveis.includes('s-mensagem') && visiveis.includes('s-publico'), visiveis.join(', '));
    assert(!visiveis.includes('s-segmentos') && !visiveis.includes('s-exemplos'),
      'seções da campanha legado apareceram na campanha nova: ' + visiveis.join(', '));
  });

  await t('E1b. a campanha nova tem ritmo e horario, com o padrao dito nos campos', async () => {
    // Desde 29/09. Antes, o limite era fixo no banco e o horário só valia no
    // clique em "Enviar"; a seção era só da legado.
    const m = await frame.evaluate(() => ({
      visivel: document.getElementById('s-ritmo').style.display !== 'none',
      ph: ['cDiario', 'cMin', 'cMax'].map(id => document.getElementById(id).placeholder),
      sub: document.getElementById('ritmoSub').textContent,
    }));
    assert(m.visivel, 'a seção de ritmo não aparece na campanha nova');
    assert(m.ph.join() === '30,45,120', 'placeholders: ' + m.ph.join());
    assert(/8h às 20h/.test(m.sub) && /mais restritivo/.test(m.sub), 'o texto não diz o padrão: ' + m.sub);
  });

  await t('E2. a campanha nova mostra as secoes dela, com o ritmo', async () => {
    const secoes = await frame.$$eval('section.secao', els =>
      els.filter(e => e.style.display !== 'none').map(e => e.id));
    assert(JSON.stringify(secoes) === JSON.stringify(['s-identificacao', 's-mensagem', 's-publico', 's-roteiro', 's-ritmo']),
      'seções visíveis: ' + secoes.join(', '));
  });

  await t('E3. a campanha nova so escolhe uma lista que existe, sem montar outra ali', async () => {
    // Até 28/09 dava para marcar clientes e digitar números na própria
    // campanha. Gente nova entra agora pela página Listas.
    const sobras = await frame.$$eval('#cNovaLista, #tbPublico, #cManuais, #cBuscaPessoa', els => els.length);
    assert(sobras === 0, `${sobras} elemento(s) da montagem de lista continuam na página`);
    const opcoes = await frame.$$eval('#cLista option', els => els.map(e => e.textContent.trim()));
    assert(!opcoes.some(o => /montar/i.test(o)), 'a opção de montar lista continua: ' + opcoes.join(' | '));
  });

  await t('E4. criar sem mensagem e sem publico e RECUSADO', async () => {
    await frame.evaluate(() => { document.getElementById('cNome').value = 'Teste'; salvar(); });
    await esperar(400);
    const av = await frame.$eval('#avisoTopo', e => e.textContent);
    assert(/Escreva a mensagem/.test(av), `o aviso diz "${av}"`);
  });

  await t('E4b. criar sem lista e RECUSADO, e nenhuma lista nasce no servidor', async () => {
    criado = null; listaCriada = false;
    await frame.evaluate(() => { document.getElementById('cCorpo').value = 'Olá {{primeiroNome}}'; salvar(); });
    await esperar(600);
    const av = await frame.$eval('#avisoTopo', e => e.textContent);
    assert(/Escolha a lista/.test(av), `o aviso diz "${av}"`);
    assert(!listaCriada && !criado, 'criou lista ou campanha sem lista escolhida');
  });

  await t('E5. criar monta o modelo e a campanha com a lista escolhida, em rascunho', async () => {
    await frame.evaluate(() => { document.getElementById('cLista').value = '3'; salvar(); });
    await esperar(700);
    assert(criado, 'a campanha não chegou ao servidor');
    assert(criado.templateId === 5 && criado.listaId === 3, JSON.stringify(criado));
    assert(Array.isArray(criado.canais), 'a campanha nova não levou a escolha dos números: ' + JSON.stringify(criado.canais));
    assert(!listaCriada, 'a campanha criou uma lista por conta própria');
    assert(criado.tipo === 'operacional', `o tipo foi ${criado.tipo}`);
  });

  await t('E6. editar campanha nova carrega o que ela ja tem', async () => {
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanha?comm=7`, { waitUntil: 'networkidle0' });
    frame = await esperarFrame(page, f => f.url().includes('campanha.html'));
    await frame.waitForFunction(() => document.getElementById('cNome').value !== '', { timeout: 8000 });
    const nome = await frame.$eval('#cNome', e => e.value);
    const lista = await frame.$eval('#cLista', e => e.value);
    assert(nome === 'Cobrança de agosto', `veio "${nome}"`);
    assert(lista === '3', `a lista veio "${lista}"`);
  });

  await t('D1. nenhum erro de JavaScript nem 404 na tela', () => {
    assert(erros.length === 0, erros.slice(0, 4).join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
