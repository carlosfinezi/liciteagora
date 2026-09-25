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

const { chaveDoRamo, RAMOS, buildM1Messages } = require('../wa-m1-utils');

(async () => {
  // ==================== A. o gerador ====================

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

  await t('A3. a frase escolhida chega FIXA ao modelo, nao como sugestao', () => {
    const cfg = { dores_por_ramo: { mercado: ['faltar na prateleira o que mais sai'] },
                  variantes_pergunta_final: ['Isso pega ai tambem?'] };
    const m = buildM1Messages(cfg, { nome: 'Ana Souza', ramo: 'mercadinho', cidade: 'Marabá' });
    const user = m.messages.find(x => x.role === 'user').content;
    assert(/nao substitua, nao invente outra/.test(user), 'a dor foi entregue como sugestão');
    assert(user.includes('faltar na prateleira o que mais sai'), 'a frase do segmento não entrou');
    assert(m.contact.ramoKey === 'mercado', `o segmento resolvido foi ${m.contact.ramoKey}`);
  });

  // ==================== B. a tela ====================

  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));
  const app = express();
  app.use(express.json());

  const RAMOS_RESP = {
    success: true, total: 15885, semRamo: 0, semDor: 10617,
    perguntas: ['Isso ainda acontece ai?', 'Ja resolveu isso?'],
    orfaos: [{ chave: 'farmacia', dores: 3 }],
    proprios: false,
    ramos: [
      { chave: 'bebidas', palavras: ['bebida'], dores: ['venceu na prateleira'], contatos: 1212 },
      { chave: 'mercado', palavras: ['mercad', 'mercearia'], dores: [], contatos: 2110 },
      { chave: 'generico', palavras: [], dores: [], contatos: 10617 },
    ],
  };
  let salvo = null;
  app.get('/api/conversas/campanhas/wa/:id/ramos', (_q, rs) => rs.json(RAMOS_RESP));
  app.get('/api/conversas/campanhas/wa/:id', (_q, rs) => rs.json({ success: true,
    campanha: { id: 6, nome: 'leads-pa-pregao', status: 'pausada',
      config: { briefing: 'b', dores_por_ramo: { farmacia: ['a', 'b', 'c'] } } },
    destinatarios: { pendente: 15885 } }));
  app.put('/api/conversas/campanhas/wa/:id', (rq, rs) => { salvo = rq.body; rs.json({ success: true }); });
  app.get('/api/wa-campanhas/:id/images', (_q, rs) => rs.json({ success: true, images: [] }));
  // Os exemplos que a IA imita, e o modelo de onde trazê-los.
  app.get('/api/conversas/campanhas/wa/:id/exemplos', (_q, rs) => rs.json({ success: true,
    bons: ['Boa tarde, Rosete. Aqui e o Carlos, da 1bit.'], ruins: ['Oi! Tudo bem?? Promocao!!!'],
    legado: '{saudacao}, {primeiro_nome}. Aqui e o Carlos.',
    modelos: [{ id: 1, nome: 'liciteagora', canal: 'whatsapp', corpo: 'Olá {{primeiroNome}} tudo bem?' }] }));
  app.post('/api/conversas/campanhas/wa/:id/segmentos/previa', (rq, rs) => {
    const segs = rq.body.segmentos || [];
    rs.json({ success: true, contagem: [...segs.map(x => ({ chave: x.chave, contatos: 100 })),
                                        { chave: 'generico', contatos: 7 }] });
  });
  app.post('/api/conversas/campanhas/wa/:id/exemplos/previa', (rq, rs) => {
    const texto = rq.body.templateId ? 'Olá Rosete tudo bem?' : 'Boa tarde, Rosete. Aqui e o Carlos.';
    rs.json({ success: true, texto, sobrando: [] });
  });
  app.get('/api/comm/templates', (_q, rs) => rs.json({ success: true, templates: [
    { id: 1, nome: 'Aviso de boleto', canal: 'whatsapp', corpo: 'Olá {{primeiroNome}}', emUso: 2 },
    { id: 2, nome: 'Modelo parado', canal: 'email', assunto: 'x', corpo: 'texto', emUso: 0 },
  ] }));
  app.get('/api/comm/listas', (_q, rs) => rs.json({ success: true,
    listas: [{ id: 3, nome: 'clientes ativos', qtdMembros: 40 }] }));
  let criado = null;
  app.post('/api/comm/campanhas', (rq, rs) => { criado = rq.body;
    rs.json({ success: true, campanha: { id: 9, totalDestinatarios: 12 } }); });
  app.post('/api/comm/templates', (rq, rs) => rs.json({ success: true, template: { id: 5 } }));
  app.post('/api/comm/listas', (_q, rs) => rs.json({ success: true, lista: { id: 8 } }));
  app.post('/api/comm/listas/:id/membros', (_q, rs) => rs.json({ success: true, adicionados: 2 }));
  app.get('/api/comm/campanhas/:id', (_q, rs) => rs.json({ success: true,
    campanha: { id: 7, nome: 'Cobrança de agosto', tipo: 'operacional', templateId: 1,
                listaId: 3, status: 'rascunho', totalDestinatarios: 30 } }));
  app.get('/api/conversas/campanhas', (_q, rs) => rs.json({ success: true, campanhas: [
    { origem: 'comm', id: 7, nome: 'Cobrança de agosto', status: 'rascunho', criadoEm: '2026-09-01',
      destinatarios: null, totalDestinatarios: 30, templateId: 1, templateNome: 'Aviso de boleto' },
    { origem: 'wa', id: 6, nome: 'leads-pa-pregao', status: 'pausada', criadoEm: '2026-08-14',
      destinatarios: { pendente: 15468 } },
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
  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/ia`, { waitUntil: 'networkidle0' });
  let frame = page.frames().find(f => f.url().includes('ia.html'));
  if (!frame) { console.log('FALHA a tela não carregou'); process.exit(1); }
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));

  await frame.evaluate(() => {
    [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === 'Campanhas').click();
  });
  await frame.waitForFunction(() =>
    !/Carregando/.test(document.getElementById('tbCamp').textContent), { timeout: 8000 });

  await t('B1. a campanha diz qual modelo ela manda', async () => {
    const txt = await frame.$$eval('#tbCamp tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const linha = txt.find(x => /Cobrança de agosto/.test(x));
    assert(/modelo: Aviso de boleto/.test(linha), `a linha diz "${linha}"`);
  });

  await t('B2. a lista de modelos diz quais estao em uso', async () => {
    await frame.evaluate(() => {
      [...document.querySelectorAll('.sub-abas .sub')].find(b => b.textContent.trim() === 'Modelos de mensagem').click();
    });
    await frame.waitForFunction(() =>
      !/Carregando/.test(document.getElementById('tbModelos').textContent), { timeout: 8000 });
    const txt = await frame.$$eval('#tbModelos tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    assert(/2 campanha\(s\)/.test(txt.find(x => /Aviso de boleto/.test(x))), 'o modelo em uso não diz quantas');
    assert(/nenhuma/.test(txt.find(x => /Modelo parado/.test(x))), 'o modelo sem uso não diz que está parado');
  });

  await t('B3. editar a campanha leva para a PAGINA, e nao abre modal', async () => {
    // Ela cresceu além do que cabe num modal, e era isso que fazia ninguém
    // mexer nas configurações.
    const temModal = await frame.$$eval('#modalWa', els => els.length);
    assert(temModal === 0, 'o modal de edição continua na listagem');
    const destino = await frame.evaluate(() => abrirCampanha.toString());
    assert(/\/comunicacao\/campanha\.html/.test(destino), `a edição iria para: ${destino}`);
  });

  // ==================== C. a página da campanha ====================

  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanha?id=6`, { waitUntil: 'networkidle0' });
  frame = page.frames().find(f => f.url().includes('campanha.html'));
  if (!frame) { console.log('FALHA a página da campanha não carregou'); process.exit(1); }
  await frame.waitForFunction(() =>
    !/carregando/i.test(document.getElementById('cRamos').textContent), { timeout: 8000 });

  await t('C1. cada segmento aparece com as frases dele', async () => {
    const linhas = await frame.$$eval('#cRamos tbody tr', els => els.length);
    assert(linhas === 3, `${linhas} segmento(s) na tabela`);
    const v = await frame.$eval('#cRamos tr[data-seg="bebidas"] textarea[data-campo="dores"]', e => e.value);
    assert(v === 'venceu na prateleira', `o textarea de bebidas tem "${v}"`);
  });

  await t('C2. a contagem de contatos por segmento esta VISIVEL', async () => {
    const cel = await frame.$$eval('#cRamos tbody tr', els => els.map(e => ({
      txt: e.textContent.replace(/\s+/g, ' '), h: Math.round(e.getBoundingClientRect().height) })));
    assert(cel.every(c => c.h > 0), 'as linhas têm altura zero');
    assert(/10\.617/.test(cel.find(c => /generico/.test(c.txt)).txt),
      'a contagem do genérico não apareceu formatada');
  });

  await t('C3. segmento com gente e sem frase e DENUNCIADO', async () => {
    const aviso = await frame.$eval('#cRamos .alert', e => e.textContent.replace(/\s+/g, ' '));
    assert(/10\.617 contato\(s\) estão em segmento sem frase própria/.test(aviso),
      `o aviso diz "${aviso}"`);
  });

  await t('C4. frase em chave que o gerador ignora e denunciada', async () => {
    const aviso = await frame.$eval('#cRamos .alert', e => e.textContent.replace(/\s+/g, ' '));
    assert(/farmacia \(3 frase\(s\)\)/.test(aviso), `o aviso não citou a chave órfã: "${aviso}"`);
  });

  await t('C4b. os exemplos que a IA imita aparecem, bons e ruins', async () => {
    await frame.waitForSelector('#cBons textarea', { timeout: 8000 });
    const bons = await frame.$eval('#cBons textarea', e => e.value);
    const ruins = await frame.$eval('#cRuins textarea', e => e.value);
    assert(/Boa tarde, Rosete/.test(bons), `o exemplo bom veio "${bons}"`);
    assert(/Promocao/.test(ruins), `o exemplo ruim veio "${ruins}"`);
  });

  await t('C4c. o campo antigo e DENUNCIADO, e nao descartado calado', async () => {
    // Ele era lido e gravado pela tela, e consumido por ninguém.
    const aviso = await frame.$eval('#cExemplos .alert', e => e.textContent.replace(/\s+/g, ' '));
    assert(/o gerador nunca leu/.test(aviso), `o aviso diz "${aviso.slice(0, 80)}"`);
    assert(/\{saudacao\}/.test(aviso), 'o texto antigo não foi mostrado');
  });

  await t('C4d. trazer de um modelo resolve a variavel, e nao copia a chave', async () => {
    // Copiar "Olá {{primeiroNome}}" ensinaria a IA a escrever a chave, e ela
    // sairia crua para o cliente: aqui ninguém substitui nada.
    await frame.evaluate(() => {
      document.getElementById('cDeModelo').value = '1';
      trazerDeModelo();
    });
    await esperar(500);
    const textos = await frame.$$eval('#cBons textarea', els => els.map(e => e.value));
    assert(textos.some(t => /Olá Rosete tudo bem/.test(t)), 'o texto resolvido não entrou: ' + textos.join(' | '));
    assert(!textos.some(t => /\{\{/.test(t)), 'a chave crua foi copiada para o exemplo');
  });

  await t('C4e. as palavras de cada segmento sao editaveis', async () => {
    const palavras = await frame.$eval('#cRamos tr[data-seg="bebidas"] [data-campo="palavras"]', e => e.value);
    assert(palavras === 'bebida', `as palavras vieram "${palavras}"`);
    // O genérico é o destino de quem não casa com nada: dar-lhe palavra confunde.
    const generico = await frame.$$eval('#cRamos tr[data-seg="generico"] [data-campo="palavras"]', els => els.length);
    assert(generico === 0, 'o genérico apareceu com campo de palavras');
  });

  await t('C4f. a previa conta quem cai onde ANTES de salvar', async () => {
    // Acrescentar uma palavra move gente na frente de 15 mil contatos, e sem a
    // prévia isso se faz às cegas.
    await frame.evaluate(() => previaSegmentos());
    await esperar(500);
    const txt = await frame.$eval('#cPreviaSeg', e => e.textContent);
    assert(/bebidas/.test(txt) && /generico/.test(txt), `a prévia diz "${txt}"`);
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

  await t('C5. as perguntas finais aparecem, uma por linha', async () => {
    const v = await frame.$eval('#cPerguntas', e => e.value);
    assert(v === 'Isso ainda acontece ai?\nJa resolveu isso?', `veio "${v}"`);
  });

  await t('C6. salvar leva as frases editadas, e preserva a chave orfa', async () => {
    await frame.evaluate(() => {
      document.querySelector('#cRamos tr[data-seg="mercado"] textarea[data-campo="dores"]').value =
        'faltar na prateleira\ndiferenca no caixa';
      salvar();
    });
    await esperar(600);
    assert(salvo, 'nada chegou ao servidor');
    const d = salvo.config.dores_por_ramo;
    assert(JSON.stringify(d.mercado) === '["faltar na prateleira","diferenca no caixa"]',
      `mercado foi como ${JSON.stringify(d.mercado)}`);
    assert(d.bebidas.length === 1, 'a frase que não foi tocada se perdeu');
    assert(!('generico' in d), 'segmento esvaziado continuou gravado');
    // A chave que a tela não mostra não pode ser apagada por quem só editou
    // outra coisa.
    assert(d.farmacia && d.farmacia.length === 3, 'a chave órfã foi descartada no salvar');
    assert(salvo.config.variantes_pergunta_final.length === 2, 'as perguntas não viajaram');
  });

  await t('C6c. renomear o segmento leva as frases junto', async () => {
    // Sem isso, "beleza" virando "salao" deixaria as frases órfãs na chave
    // antiga e o segmento novo nasceria sem dor nenhuma.
    await frame.evaluate(() => {
      const tr = document.querySelector('#cRamos tr[data-seg="bebidas"]');
      tr.querySelector('[data-campo="chave"]').value = 'bebidas-frias';
      salvar();
    });
    await esperar(600);
    const d = salvo.config.dores_por_ramo;
    assert(d['bebidas-frias']?.length === 1, `as frases não seguiram: ${JSON.stringify(d)}`);
    assert(!('bebidas' in d), 'a chave antiga ficou órfã no config');
    assert(salvo.config.segmentos.some(x => x.chave === 'bebidas-frias'),
      'o segmento renomeado não foi gravado');
  });

  await t('C6b. salvar leva os exemplos, e aposenta o campo que nao fazia nada', async () => {
    assert(salvo.config.exemplos_bons?.length >= 1, 'os exemplos bons não viajaram');
    assert(salvo.config.exemplos_ruins?.length >= 1, 'os exemplos ruins não viajaram');
    assert(salvo.config.exemplos_bons.some(t => /Olá Rosete/.test(t)),
      'o exemplo trazido do modelo não foi salvo');
  });

  await t('C7. sem carregar os segmentos, salvar NAO mexe nas frases', async () => {
    // O caso de quem abre a campanha só para trocar o nome, com a rota de
    // segmentos fora do ar. Apagar 35 frases aí seria o pior desfecho.
    // Recarrega para partir do config original: as checagens anteriores
    // salvaram, e a página passa a refletir o que foi salvo — depender desse
    // acúmulo faria o teste medir a ordem em que ele roda.
    salvo = null;
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanha?id=6`, { waitUntil: 'networkidle0' });
    frame = page.frames().find(f => f.url().includes('campanha.html'));
    await frame.waitForFunction(() =>
      !/carregando/i.test(document.getElementById('cRamos').textContent), { timeout: 8000 });
    await frame.evaluate(() => { RAMOS_OK = false; salvar(); });
    await esperar(600);
    assert(salvo, 'nada chegou ao servidor');
    assert(JSON.stringify(salvo.config.dores_por_ramo) === JSON.stringify({ farmacia: ['a', 'b', 'c'] }),
      `o config foi com ${JSON.stringify(salvo.config.dores_por_ramo)}`);
  });

  // ==================== E. criar campanha, na mesma página ====================

  await t('E1. criar campanha abre a PAGINA, com as secoes dela', async () => {
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanha?nova=1`, { waitUntil: 'networkidle0' });
    frame = page.frames().find(f => f.url().includes('campanha.html'));
    await frame.waitForSelector('#tbPublico tr', { timeout: 8000 });
    const titulo = await frame.$eval('#tituloCamp', e => e.textContent);
    assert(/Nova campanha/.test(titulo), `o título diz "${titulo}"`);
    // As seções do legado não fazem sentido aqui, e o contrário também não.
    const visiveis = await frame.$$eval('[data-modo]', els =>
      els.filter(e => e.style.display !== 'none').map(e => e.id).filter(Boolean));
    assert(visiveis.includes('s-mensagem') && visiveis.includes('s-publico'), visiveis.join(', '));
    assert(!visiveis.includes('s-segmentos') && !visiveis.includes('s-exemplos'),
      'seções da campanha legado apareceram na campanha nova: ' + visiveis.join(', '));
  });

  await t('E1b. campo que nao faz nada na campanha nova fica ESCONDIDO', async () => {
    // O limite diário é do tenant aqui, não da campanha. Mostrar o campo seria
    // repetir o defeito do "Exemplo de mensagem pronta", que ninguém lia.
    const visivel = await frame.$eval('#cDiario', e => e.closest('[data-modo]').style.display !== 'none');
    assert(!visivel, 'o limite por dia aparece numa campanha que não o usa');
  });

  await t('E2. o indice acompanha o modo', async () => {
    const itens = await frame.$$eval('.indice a', els => els.map(e => e.textContent));
    assert(itens.length === 3, `o índice tem ${itens.length} itens: ${itens.join(', ')}`);
    assert(itens.includes('Quem recebe'), itens.join(', '));
  });

  await t('E3. quem pediu para sair nao pode ser marcado', async () => {
    const caixas = await frame.$$eval('#tbPublico input[type=checkbox]', els =>
      els.map(e => e.disabled));
    assert(caixas.length === 2 && caixas[1] === true, JSON.stringify(caixas));
  });

  await t('E4. criar sem mensagem e sem publico e RECUSADO', async () => {
    await frame.evaluate(() => { document.getElementById('cNome').value = 'Teste'; salvar(); });
    await esperar(400);
    const av = await frame.$eval('#avisoTopo', e => e.textContent);
    assert(/Escreva a mensagem/.test(av), `o aviso diz "${av}"`);
  });

  await t('E5. criar monta modelo, lista e campanha, em rascunho', async () => {
    await frame.evaluate(() => {
      document.getElementById('cCorpo').value = 'Olá {{primeiroNome}}';
      document.querySelector('#tbPublico input[type=checkbox]').click();
      salvar();
    });
    await esperar(700);
    assert(criado, 'a campanha não chegou ao servidor');
    assert(criado.templateId === 5 && criado.listaId === 8, JSON.stringify(criado));
    assert(criado.tipo === 'operacional', `o tipo foi ${criado.tipo}`);
  });

  await t('E6. editar campanha nova carrega o que ela ja tem', async () => {
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/campanha?comm=7`, { waitUntil: 'networkidle0' });
    frame = page.frames().find(f => f.url().includes('campanha.html'));
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
