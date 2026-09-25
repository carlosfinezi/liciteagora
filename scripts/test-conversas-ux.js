/**
 * A inbox redesenhada — o que a tela mostra, medido em Chrome.
 *
 * ── O que motivou o redesenho ──────────────────────────────────────────────
 *
 * Com 953 conversas abertas, TODA linha da lista trazia "aberta" e "sem
 * cadastro". Marca que aparece em quase todas as linhas não informa nada: vira
 * textura, e o olho aprende a pular a faixa inteira — inclusive quando ali
 * havia algo diferente. O topo tinha quatro caixas de mesmo peso, uma delas com
 * borda vermelha em "753 sem nenhuma resposta", um número que gritava e não
 * levava a lugar nenhum.
 *
 * ── Por que Chrome, e com a API stubada ───────────────────────────────────
 *
 * O que está sob teste é o que a pessoa VÊ. Contar `innerHTML` provaria que a
 * string existe, não que ela aparece — e a lista roda dentro de um iframe, com
 * a cascata do shell por cima. As respostas de API são fixas aqui de propósito:
 * medir contra o banco vivo faz a suíte reprovar no primeiro uso legítimo do
 * sistema (uma conversa nova muda a contagem).
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PORTA = 34157;

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

/**
 * A fila de teste, montada para cobrir o comum e o excepcional:
 * duas conversas no estado de todo dia (aberta, IA ligada, sem dono) e três com
 * algo fora do comum. Só as três podem exibir marca.
 */
const CONVERSAS = [
  { id: 1, nome: 'Rodolfo Neves', telefone: '5511900000001', estado: 'aberta', iaAtiva: 1,
    naoLidas: 0, pessoaId: null, donoId: null, donoNome: null, ultimaMensagem: 'Bom dia', ultimaEm: '2026-09-17 11:00' },
  { id: 2, nome: 'Paloma Gabriela', telefone: '5511900000002', estado: 'aberta', iaAtiva: 1,
    naoLidas: 3, pessoaId: null, donoId: null, donoNome: null, ultimaMensagem: 'Tem em estoque?', ultimaEm: '2026-09-17 11:10' },
  { id: 3, nome: 'Karolina Klopotek', telefone: '5511900000003', estado: 'pendente', iaAtiva: 1,
    naoLidas: 0, pessoaId: 9, donoId: null, donoNome: null, ultimaMensagem: 'Aguardo retorno', ultimaEm: '2026-09-17 10:00' },
  { id: 4, nome: 'Allan Cravo', telefone: '5511900000004', estado: 'aberta', iaAtiva: 0,
    naoLidas: 0, pessoaId: 9, donoId: null, donoNome: null, ultimaMensagem: 'Falar com humano', ultimaEm: '2026-09-17 09:00' },
  { id: 5, nome: 'Maria Souza', telefone: '5511900000005', estado: 'aberta', iaAtiva: 1,
    naoLidas: 0, pessoaId: 9, donoId: 10, donoNome: 'Ana', ultimaMensagem: 'Obrigada', ultimaEm: '2026-09-17 08:00' },
];
const CONTAGEM = { total: 5, naoLidas: 1, aguardando: 2, respondeuCampanha: 0,
  aberta: 4, pendente: 1, resolvida: 0, minhas: 0, semDono: 4, semResposta: 3 };

/**
 * A mesma fila, mas com 300 linhas — o tamanho real do tenant.
 *
 * Existe porque cinco conversas não reproduzem o defeito que importa: sem
 * `min-height:0` na coluna do grid, a lista cresce em vez de rolar e estica a
 * página inteira para 20.595px, arrastando a conversa e a ficha junto. Com
 * cinco linhas, nada disso aparece — e foi assim que o defeito passou pela
 * primeira versão desta suíte e só foi visto em produção.
 */
const FILA_CHEIA = Array.from({ length: 300 }, (_, i) => ({
  id: 100 + i, nome: `Cliente ${i}`, telefone: '55119' + String(i).padStart(8, '0'),
  estado: 'aberta', iaAtiva: 1, naoLidas: 0, pessoaId: null, donoId: null, donoNome: null,
  ultimaMensagem: 'mensagem de teste', ultimaEm: '2026-09-17 08:00',
}));

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));

  const app = express();
  const pedidos = [];                         // toda chamada à API, para conferir os filtros
  let filaCheia = false;                      // ligada no teste de rolagem
  app.get('/api/conversas', (rq, rs) => {
    pedidos.push(rq.originalUrl);
    rs.json({ success: true, conversas: filaCheia ? FILA_CHEIA : CONVERSAS,
      contagem: filaCheia ? { ...CONTAGEM, total: 300 } : CONTAGEM });
  });
  app.get('/api/conversas/painel/resumo', (_q, rs) =>
    rs.json({ success: true, resumo: { abertas: 4, semResposta: 3, resolvidasHoje: 0, itensBase: 7 } }));
  app.get('/api/conversas/atendentes', (_q, rs) =>
    rs.json({ success: true, atendentes: [{ id: 10, nome: 'Ana' }], eu: 10 }));
  app.get('/api/conversas/campanhas', (_q, rs) => rs.json({ success: true, campanhas: [] }));
  app.get('/api/conversas/:id', (rq, rs) => {
    const c = CONVERSAS.find(x => String(x.id) === rq.params.id);
    rs.json({ success: true, conversa: c,
      // A terceira é LONGA de propósito. Com duas mensagens curtas, o balão fica
      // do tamanho do texto e nunca encosta no teto de largura — o teste H5
      // passava com qualquer valor, inclusive com o `72%` que ele deveria
      // reprovar. Sabotar a regra e ver o teste passar foi o que revelou isso.
      mensagens: [{ from_me: 0, texto: 'Bom dia', timestamp: 1789650000 },
                  { from_me: 1, from_bot: 1, texto: 'Olá! Como posso ajudar?', timestamp: 1789650060 },
                  { from_me: 1, from_bot: 1, timestamp: 1789650120,
                    texto: 'Sobre o prazo de entrega para o Pará: trabalhamos com 12 dias úteis '
                      + 'para a capital e até 18 dias para o interior, contados a partir da '
                      + 'confirmação do pagamento. O frete fica por conta do comprador acima de '
                      + '300 km, e o rastreio é enviado por aqui assim que a transportadora coleta.' }],
      ficha: { pedidos: [], titulos: [] } });
  });
  app.get('/api/conversas/:id/oportunidade', (_q, rs) => rs.json({ success: true, oportunidade: null }));
  // Qualificação pelo roteiro, na ficha da conversa.
  const PERGUNTAS = [
    { chave: 'vende_governo', texto: 'Já vende para órgão público?',
      opcoes: [{ id: 'parou', rotulo: 'Já vendeu e parou' }, { id: 'frequente', rotulo: 'Vende sempre' }] },
    { chave: 'acha_edital', texto: 'Como fica sabendo dos editais?',
      opcoes: [{ id: 'na_mao', rotulo: 'Olha os portais na mão' }, { id: 'sistema', rotulo: 'Tem sistema' }] },
  ];
  let QUALIF_SALVO = null;
  app.get('/api/conversas/:id/qualificacao', (_q, rs) => rs.json({ success: true,
    perguntas: PERGUNTAS, pontos: 2, maximo: 4, qualificado: true,
    visita: { id: 1, respostas: { vende_governo: 'parou' } }, respondidas: [], faltam: ['acha_edital'] }));
  app.put('/api/conversas/:id/qualificacao', (rq, rs) => { QUALIF_SALVO = rq.body;
    rs.json({ success: true, pontos: 4, maximo: 4, qualificado: true, faltam: [] }); });
  app.post('/api/conversas/:id/qualificar', (_q, rs) => rs.json({ success: true,
    aceitas: { acha_edital: { resposta: 'na_mao', rotulo: 'Olha os portais na mão',
                              trecho: 'olhava os portais na mao' } },
    recusadas: [{ chave: 'habilitacao', motivo: 'trecho não está na conversa' }],
    pontos: 4, maximo: 4, qualificado: true, faltam: [] }));
  // O que o shell e a tela irmã pedem sozinhos. Sem estes, o 404 apareceria como
  // erro da tela — e erro de ambiente que se disfarça de defeito é o que faz
  // uma suíte deixar de ser levada a sério.
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  // O agendamento de reunião: a tela pergunta se está ligado para decidir se
  // mostra o botão. Desligado aqui, como nasce em qualquer tenant.
  app.get('/api/agenda/config', (_q, rs) => rs.json({ success: true,
    config: { ativo: false, faixas: null, duracaoMin: 30, antecedenciaMin: 120, janelaDias: 7, maxSlots: 8 } }));
  app.get('/api/ia/base', (_q, rs) => rs.json({ success: true, itens: [], correcoes: [] }));
  app.get('/api/whatsapp/status', (_q, rs) => rs.json({ success: true, connected: false, instance: 'teste' }));
  app.get('/api/whatsapp/ritmo', (_q, rs) => rs.json({ success: true, hora: 0, hoje: 0, limiteHora: 25 }));
  app.get('/api/whatsapp/ai-config', (_q, rs) => rs.json({ success: true, enabled: false, prompt: '',
    escopo: 'todos', horario: { ativo: false, faixas: null, mensagem: '' } }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  // Wrapper: a tela do ERP só monta dentro do shell (o sidebar.js redireciona fora dele).
  app.get('/__wrapper/:tela', (rq, rs) => rs.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
    + `ipt></head><body style="margin:0"><iframe src="/comunicacao/${rq.params.tela}.html"`
    + ' style="width:100vw;height:100vh;border:0"></iframe></body></html>'));
  app.use(express.static(PUB));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-conversas-ux',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const erros = [];
  const page = await browser.newPage();
  // Sem isto, a suíte mede a tela ANTIGA. O `userDataDir` é fixo e sobrevive
  // entre execuções, então o Chrome serve o HTML e o CSS do cache: sabotar a
  // largura do balão e ver o teste passar verde foi o que revelou o problema.
  await page.setCacheEnabled(false);
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', e => erros.push(String(e.message)));
  // O 404 entra pela URL, e não pelo texto do console: "Failed to load resource"
  // sem dizer QUAL recurso não ajuda ninguém a consertar.
  page.on('response', r => { if (r.status() >= 400) erros.push(`${r.status()} em ${r.url()}`); });
  page.on('console', m => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push('console: ' + m.text());
  });

  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/conversas`, { waitUntil: 'networkidle0' });
  const frame = page.frames().find(f => f.url().includes('conversas.html'));
  if (!frame) { console.log('FALHA a tela não carregou no iframe'); process.exit(1); }
  await frame.waitForSelector('.conv', { timeout: 8000 });

  // ==================== A. a lista ====================

  await t('A1. a lista mostra as conversas, com avatar em cada uma', async () => {
    const n = await frame.$$eval('.conv', els => els.length);
    const avatares = await frame.$$eval('.conv .ini', els => els.filter(e => e.textContent.trim()).length);
    assert(n === 5, `apareceram ${n} de 5 conversas`);
    assert(avatares === 5, `${avatares} de 5 linhas têm iniciais — sem avatar a coluna vira texto corrido`);
  });

  await t('A2. as iniciais saem do nome, nao do telefone', async () => {
    const primeira = await frame.$eval('.conv .ini', e => e.textContent.trim().slice(0, 2));
    assert(primeira === 'RN', `veio "${primeira}" para "Rodolfo Neves"`);
  });

  await t('A3. conversa no estado COMUM nao exibe marca nenhuma', async () => {
    // É o ponto do redesenho: antes, estas duas traziam "aberta" e "sem cadastro".
    const marcas = await frame.$$eval('.conv', els =>
      els.slice(0, 2).map(e => e.querySelectorAll('.marcas .pil').length));
    assert(marcas.every(n => n === 0),
      'linha comum ainda exibe marca: ' + JSON.stringify(marcas) + ' — marca em toda linha vira textura');
  });

  await t('A4. o que e EXCEPCIONAL aparece: pendente, IA desligada e dono', async () => {
    const txt = await frame.$$eval('.conv', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    assert(/pendente/.test(txt[2]), 'a conversa pendente não mostra o estado');
    assert(/IA desligada/.test(txt[3]), 'a conversa com IA desligada não avisa');
    assert(/Ana/.test(txt[4]), 'a conversa assumida não mostra o dono');
  });

  await t('A5. nao lidas aparece no avatar, e so em quem tem', async () => {
    const comBadge = await frame.$$eval('.conv .ini .n', els => els.map(e => e.textContent.trim()));
    assert(comBadge.length === 1 && comBadge[0] === '3',
      'o contador de não lidas veio: ' + JSON.stringify(comBadge));
  });

  await t('A6. a linha e clicavel de verdade e tem altura util', async () => {
    const h = await frame.$eval('.conv', e => e.getBoundingClientRect().height);
    assert(h >= 44, `a linha tem ${h}px — abaixo de 44 o alvo de toque fica pequeno demais`);
  });

  // ==================== B. os números do topo ====================

  await t('B1. os numeros do topo sao botoes, nao placas', async () => {
    const n = await frame.$$eval('.numeros button', els => els.length);
    assert(n >= 3, `só ${n} número(s) clicável(is) no topo`);
  });

  await t('B2. "sem nenhuma resposta" filtra de verdade', async () => {
    const antes = pedidos.length;
    await frame.evaluate(() => {
      const b = [...document.querySelectorAll('.numeros button')]
        .find(x => /sem nenhuma resposta/.test(x.textContent));
      b.click();
    });
    await new Promise(r => setTimeout(r, 600));
    const novos = pedidos.slice(antes);
    assert(novos.some(u => /recorte=semResposta/.test(u)),
      'clicar no número não pediu o recorte ao servidor: ' + JSON.stringify(novos));
  });

  await t('B3. o numero clicado fica marcado como selecionado', async () => {
    const sel = await frame.$$eval('.numeros button.sel', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
    assert(sel.length === 1 && /sem nenhuma resposta/.test(sel[0]),
      'seleção do filtro veio: ' + JSON.stringify(sel));
  });

  await t('B4. o mesmo filtro nao aparece duas vezes na tela', async () => {
    // "não lidas" e "sem dono" viraram números do topo; repeti-los nos chips
    // divide a atenção e faz a pessoa procurar qual dos dois vale.
    const numeros = await frame.$$eval('.numeros button', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const chips = await frame.$$eval('.chips button', els => els.map(e => e.textContent.trim()));
    for (const rot of ['não lidas', 'sem dono']) {
      assert(numeros.some(n => n.includes(rot)), `"${rot}" sumiu do topo`);
      assert(!chips.some(ch => ch.toLowerCase().includes(rot)),
        `"${rot}" aparece no topo E nos chips`);
    }
  });

  // ==================== C. os vazios ====================

  await t('C1. a tela tem UM estado vazio, e ele nao narra o que esta na tela', async () => {
    const vazios = await frame.$$eval('.vazio-centro', els =>
      els.filter(e => e.offsetParent !== null).map(e => e.textContent.trim()));
    assert(vazios.length === 1, 'estados vazios visíveis: ' + JSON.stringify(vazios));
    assert(!/aparece aqui|toque na|clique na/i.test(vazios[0]),
      `o texto narra a tela: "${vazios[0]}"`);
  });

  await t('C2. a ficha vazia fica em branco, sem legenda de si mesma', async () => {
    const ficha = await frame.$eval('#fichaCorpo', e => e.textContent.trim());
    assert(ficha === '', `a ficha vazia diz: "${ficha}"`);
  });

  await t('C3. abrir uma conversa revela cabecalho, mensagens e ficha', async () => {
    await frame.evaluate(() => document.querySelectorAll('.conv')[0].click());
    await frame.waitForFunction(() => document.querySelectorAll('.msg').length > 0, { timeout: 8000 });
    const cab = await frame.$eval('#threadCab', e => e.textContent.replace(/\s+/g, ' ').trim());
    assert(/Rodolfo Neves/.test(cab), `o cabeçalho não identifica quem é: "${cab}"`);
    const ficha = await frame.$eval('#fichaCorpo', e => e.textContent.trim());
    assert(/Contato/.test(ficha), 'a ficha do cliente não apareceu ao abrir a conversa');
  });

  await t('C4. o mesmo texto de vazio nao e dito duas vezes', async () => {
    const vazios = await frame.$$eval('.vazio-centro', els =>
      els.filter(e => e.offsetParent !== null).map(e => e.textContent.trim()));
    assert(new Set(vazios).size === vazios.length, 'texto de vazio repetido: ' + JSON.stringify(vazios));
  });

  // ==================== D. a tela inteira ====================

  await t('D1. nenhum erro de JavaScript na tela', async () => {
    assert(erros.length === 0, erros.slice(0, 3).join(' | '));
  });

  await t('D4. com a fila cheia, a lista ROLA em vez de esticar a pagina', async () => {
    // O defeito real: sem `min-height:0` na coluna do grid, 300 conversas fazem a
    // página ter 20.595px de altura, e a conversa e a ficha esticam junto porque
    // as colunas do grid compartilham a altura. A rolagem some, e a tela vira
    // uma lista infinita com dois retângulos brancos ao lado.
    filaCheia = true;
    await frame.evaluate(() => carregar());
    await frame.waitForFunction(() => document.querySelectorAll('.conv').length > 200, { timeout: 8000 });

    const m = await frame.evaluate(() => ({
      central: document.getElementById('central').getBoundingClientRect().height,
      msgs: document.getElementById('msgs').getBoundingClientRect().height,
      lista: document.querySelector('.lista .rolagem').getBoundingClientRect().height,
      conteudo: document.querySelector('.lista .rolagem').scrollHeight,
      janela: window.innerHeight,
    }));
    assert(m.central <= m.janela + 1,
      `a caixa tem ${Math.round(m.central)}px numa janela de ${m.janela}px`);
    assert(m.msgs <= m.janela + 1,
      `a coluna da conversa esticou para ${Math.round(m.msgs)}px junto com a lista`);
    assert(m.conteudo > m.lista,
      'a lista não tem conteúdo além do visível — o teste não está reproduzindo a fila cheia');
    filaCheia = false;
    await frame.evaluate(() => carregar());
    await frame.waitForFunction(() => document.querySelectorAll('.conv').length === 5, { timeout: 8000 });
  });

  await t('D2. o estilo inline ficou abaixo de 30 atributos', async () => {
    // Era 172 — a maior concentração do ERP. Estilo inline não herda tema nem
    // escala e é o que fez a Fase 3.5 não alcançar esta tela.
    const html = fs.readFileSync(path.join(PUB, 'comunicacao/conversas.html'), 'utf8');
    const n = (html.match(/style="/g) || []).length;
    assert(n < 30, `${n} atributos style= na tela`);
  });

  await t('D3. o subtitulo com emenda saiu do cabecalho', async () => {
    const html = fs.readFileSync(path.join(PUB, 'comunicacao/conversas.html'), 'utf8');
    assert(!/a base que a IA usa — num lugar só/.test(html),
      'o subtítulo antigo continua: ele emendava três informações numa frase que já tinha terminado');
  });

  // ==================== E. a tela irmã ====================

  await t('E1. a tela de IA e campanhas monta, com as quatro abas', async () => {
    const p2 = await browser.newPage();
    const errosIa = [];
    p2.on('pageerror', e => errosIa.push(String(e.message)));
    p2.on('response', r => { if (r.status() >= 400) errosIa.push(`${r.status()} em ${r.url()}`); });
    p2.on('console', m => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errosIa.push('console: ' + m.text());
    });
    await p2.setViewport({ width: 1440, height: 1000 });
    await p2.goto(`http://127.0.0.1:${PORTA}/__wrapper/ia`, { waitUntil: 'networkidle0' });
    const f2 = p2.frames().find(f => f.url().includes('ia.html'));
    assert(!!f2, 'a tela de IA não carregou');
    await f2.waitForSelector('.tabs .tab', { timeout: 8000 });
    const abas = await f2.$$eval('.tabs .tab', els => els.map(e => e.textContent.trim()));
    assert(JSON.stringify(abas) === JSON.stringify(['Base da IA', 'Campanhas', 'Canal', 'Relatório']),
      'as abas vieram: ' + JSON.stringify(abas));
    assert(errosIa.length === 0, 'erro de JS na tela de IA: ' + errosIa.slice(0, 2).join(' | '));

    // A aba que abre precisa MOSTRAR alguma coisa. No corte das telas, o painel
    // da Base da IA veio sem a classe `active`: as quatro abas apareciam e a
    // primeira abria em branco, sem erro nenhum em lugar nenhum.
    const visivel = await f2.$$eval('.tab-pane', els =>
      els.filter(e => e.offsetParent !== null).map(e => e.id));
    assert(visivel.length === 1, 'painéis visíveis ao abrir: ' + JSON.stringify(visivel));
    const conteudo = await f2.$eval('#tab-ia', e => e.getBoundingClientRect().height);
    assert(conteudo > 100, `a aba que abre tem ${Math.round(conteudo)}px de altura — está em branco`);

    // E cada aba precisa continuar trocando depois do corte.
    for (const [i, nome] of [[1, 'tab-campanhas'], [2, 'tab-canal'], [3, 'tab-relatorio']]) {
      await f2.evaluate((idx) => document.querySelectorAll('.tabs .tab')[idx].click(), i);
      await new Promise(r => setTimeout(r, 400));
      const agora = await f2.$$eval('.tab-pane', els =>
        els.filter(e => e.offsetParent !== null).map(e => e.id));
      assert(agora.length === 1 && agora[0] === nome,
        `clicar na aba ${i} mostrou ${JSON.stringify(agora)} em vez de ${nome}`);
    }
    await p2.close();
  });

  await t('E2. a inbox nao ficou com pedaco da configuracao', async () => {
    const html = fs.readFileSync(path.join(PUB, 'comunicacao/conversas.html'), 'utf8');
    for (const sobra of ['tab-campanhas', 'tab-canal', 'tab-relatorio', 'tab-ia', 'modalCampanha']) {
      assert(!html.includes(sobra), `a inbox ainda carrega "${sobra}", que mudou de tela`);
    }
  });

  await t('E3. a inbox aponta para a tela irma, senao ela fica inalcancavel', async () => {
    const href = await frame.$$eval('a', els => els.map(e => e.getAttribute('href')));
    assert(href.some(h => /comunicacao\/ia\.html/.test(h || '')),
      'não há caminho da inbox para IA e campanhas: ' + JSON.stringify(href));
  });

  // ==================== F. o acesso à tela nova ====================
  //
  // Partir uma tela em duas cria uma armadilha de permissão: a metade nova entra
  // no menu com `page` própria, e toda permissão JÁ GRAVADA em banco passa a não
  // alcançá-la. O perfil que via a tela inteira ontem levaria 403 hoje, sem
  // ninguém ter tirado acesso de ninguém — e o pior é que isso não aparece para
  // quem é admin, que é justamente quem testa.

  await t('G1. a ficha mostra a qualificacao, com a nota', async () => {
    await frame.evaluate(() => document.querySelectorAll('.conv')[0].click());
    await frame.waitForSelector('#blocoQualificacao select', { timeout: 8000 });
    const txt = await frame.$eval('#blocoQualificacao', e => e.textContent.replace(/\s+/g, ' '));
    assert(/2 de 4/.test(txt), `a nota não apareceu: "${txt.slice(0, 90)}"`);
    const selects = await frame.$$eval('#blocoQualificacao select', els => els.length);
    assert(selects === 2, `${selects} perguntas na ficha`);
  });

  await t('G2. o que ja foi apurado volta selecionado', async () => {
    const v = await frame.$eval('#blocoQualificacao select', e => e.value);
    assert(v === 'parou', `a resposta apurada veio como "${v}"`);
  });

  await t('G3. corrigir a resposta grava e atualiza a nota', async () => {
    await frame.evaluate(() => {
      const s = document.querySelector('#blocoQualificacao select');
      s.value = 'frequente'; s.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 400));
    const nota = await frame.$eval('#blocoQualificacao .linha strong', e => e.textContent);
    assert(/4 de 4/.test(nota), `a nota ficou em "${nota}"`);
  });

  await t('G4. a leitura pela IA mostra o TRECHO que sustenta a resposta', async () => {
    // Sem a citação, a nota seria um número sem origem, e ninguém decide venda
    // com base num número desses.
    await frame.evaluate(() => document.querySelector('#blocoQualificacao button').click());
    await frame.waitForFunction(() =>
      /portais/.test(document.getElementById('qualifAviso').textContent), { timeout: 8000 });
    const txt = await frame.$eval('#qualifAviso', e => e.textContent);
    assert(/olhava os portais na mao/.test(txt), `o trecho não apareceu: "${txt}"`);
    assert(/1 resposta\(s\) recusada\(s\)/.test(txt), 'a recusa não foi mostrada: ' + txt);
  });

  await t('F1. quem pode ver Conversas alcanca a tela de IA e campanhas', () => {
    const { podeVerPath } = require('../perfis-acesso');
    const restrito = { irrestrito: false, perfil: 'atendente', paginas: ['conversas'] };
    assert(podeVerPath(restrito, '/comunicacao/conversas.html'), 'perdeu acesso à própria inbox');
    assert(podeVerPath(restrito, '/comunicacao/ia.html'),
      'o perfil que via a tela inteira levaria 403 na metade que foi separada dela');
  });

  await t('F2. a heranca NAO abre o modulo para quem nunca teve acesso', () => {
    const { podeVerPath } = require('../perfis-acesso');
    const deFora = { irrestrito: false, perfil: 'fiscal', paginas: ['notas-fiscais'] };
    assert(!podeVerPath(deFora, '/comunicacao/ia.html'),
      'quem não tem Conversas passou a ver a configuração da IA — a herança virou porta dos fundos');
  });

  await t('F3. o menu e o servidor concordam sobre a heranca', () => {
    // Se o menu esconder o que o servidor libera, a tela existe e ninguém acha o
    // caminho; se liberar o que o servidor bloqueia, o item leva a um 403.
    const servidor = fs.readFileSync(path.join(RAIZ, 'perfis-acesso.js'), 'utf8');
    const menu = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');
    const par = /'comunicacao-ia',\s*'conversas'/;
    assert(par.test(servidor), 'o servidor não conhece a herança');
    assert(/'comunicacao-ia':\s*'conversas'/.test(menu), 'o menu não conhece a herança');
  });

  // ==================== H. densidade e hierarquia ====================
  //
  // O acerto de 18/09. Antes disso, o topo da lista tinha QUATRO linhas de
  // controle antes da primeira conversa, quatro números do mesmo tamanho (dois
  // deles repetindo o mesmo valor) e balões de até 640px em tela larga.

  await t('H1. o topo da lista ocupa no maximo duas linhas de controle', async () => {
    // A medida é a altura, e não a contagem de elementos: o que rouba espaço da
    // lista é altura em pixels, e é isso que a pessoa sente ao rolar.
    const alturas = await frame.evaluate(() => ({
      topo: document.querySelector('.lista .topo').getBoundingClientRect().height,
      linha: document.querySelector('.conv').getBoundingClientRect().height,
    }));
    assert(alturas.topo <= 110,
      `o topo da lista tem ${Math.round(alturas.topo)}px — cada linha de botão a mais é uma conversa a menos na tela`);
  });

  await t('H2. som e pop-up nao tem o peso de um filtro', async () => {
    // São preferência que se ajusta uma vez. Em barra da largura inteira, eles
    // competiam todos os dias com os filtros que se usa o tempo todo.
    const m = await frame.evaluate(() => {
      const a = document.querySelector('.avisos button').getBoundingClientRect();
      const c = document.querySelector('.chips button').getBoundingClientRect();
      return { aviso: a.width, chip: c.width };
    });
    assert(m.aviso < m.chip,
      `o botão de aviso tem ${Math.round(m.aviso)}px e o chip de filtro ${Math.round(m.chip)}px`);
  });

  await t('H3. um numero e o principal, e os outros sao menores', async () => {
    const tam = await frame.$$eval('.numeros button .v', els =>
      els.map(e => parseFloat(getComputedStyle(e).fontSize)));
    assert(tam.length >= 2, 'há menos de dois números no topo');
    assert(tam[0] > tam[1],
      `todos os números têm o mesmo corpo (${tam.join(', ')}px) — sem hierarquia, não se sabe por onde começar`);
  });

  await t('H4. numero que repete outro nao aparece', async () => {
    // "sem dono 954" ao lado de "no total 954" faz duvidar dos dois. Aqui a
    // contagem tem semDono=4 e total=5, então ele DEVE aparecer; o caso inverso
    // é o de produção, onde ninguém assumiu nada ainda.
    const rotulos = await frame.$$eval('.numeros button', els => els.map(e => e.textContent));
    assert(rotulos.some(r => /sem dono/.test(r)), 'sem dono sumiu mesmo sendo diferente do total');

    const iguais = await frame.evaluate(() => {
      renderNumeros({ total: 954, naoLidas: 158, semDono: 954, semResposta: 754 }, null);
      return [...document.querySelectorAll('.numeros button')].map(e => e.textContent);
    });
    assert(!iguais.some(r => /sem dono/.test(r)),
      'com semDono igual ao total, o número repetido continuou na tela');
    await frame.evaluate(() => carregar());
    await frame.waitForFunction(() => document.querySelectorAll('.conv').length === 5, { timeout: 8000 });
  });

  await t('H5. o balao nao estica em tela larga', async () => {
    await frame.evaluate(() => document.querySelectorAll('.conv')[0].click());
    await frame.waitForFunction(() => document.querySelectorAll('.msg').length > 0, { timeout: 8000 });
    const larguras = await frame.$$eval('.msg', els => els.map(e => e.getBoundingClientRect().width));
    const maior = Math.max(...larguras);
    // O teto é 500px, e o número não é arbitrário: nesta janela de 1440px a
    // coluna da conversa tem 757px, então a regra certa (`min(72%, 34em)`) dá
    // 476px e a antiga (`72%` sozinho) daria 545px. Com o limite em 560 que esta
    // linha tinha antes, as DUAS passavam — o teste não distinguia o defeito da
    // correção, e só a sabotagem mostrou isso.
    assert(maior <= 500,
      `o balão chegou a ${Math.round(maior)}px numa janela de 1440px — linha longa demais faz o olho voltar ao começo`);
  });

  await t('H6. a hora fica de um lado e as acoes do outro', async () => {
    const m = await frame.evaluate(() => {
      const meta = [...document.querySelectorAll('.msg .meta')].find(e => e.querySelector('.corrigir'));
      if (!meta) return null;
      const quando = meta.querySelector('.quando').getBoundingClientRect();
      const acao = meta.querySelector('.corrigir').getBoundingClientRect();
      return { quando: quando.left, acao: acao.left, caixa: meta.getBoundingClientRect() };
    });
    assert(m, 'não achei a linha de metadados com ação');
    assert(m.acao - m.quando > 60,
      'hora e ações estão coladas — eram quatro informações no mesmo tom e tamanho');
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
