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
  let doisNumeros = false;                    // ligada na parte I (vários números)
  let comMidia = false, comHistorico = false;                       // ligada na parte M (mídia nas mensagens)
  let comPausa = false;                       // a IA calada pela pausa de 4 h (parte N)
  let pausaSegundos = 125;                    // quanto falta, para medir o formato do contador
  let RECEBIDAS = { ultimoId: 10, novas: 0 }; // o aviso de mensagem nova (H2b)
  // Mídia (parte M): a 905 não existe mais no WhatsApp.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  app.get('/api/conversas/midia/:id', (rq, rs) => {
    if (rq.params.id === '905') return rs.status(404).json({ success: false, error: 'O WhatsApp não tem mais esta mídia' });
    rs.type('png').send(PNG);
  });
  app.get('/api/conversas', (rq, rs) => {
    pedidos.push(rq.originalUrl);
    const numeros = doisNumeros ? [{ id: 1, nome: 'Comercial', padrao: true }, { id: 2, nome: 'Suporte', padrao: false }] : [];
    const conversas = (filaCheia ? FILA_CHEIA : CONVERSAS)
      .map(c => (doisNumeros ? { ...c, canalId: c.id % 2 ? 1 : 2, canalNome: c.id % 2 ? 'Comercial' : 'Suporte' } : c));
    // Os nichos são os das CAMPANHAS que enviaram (01/10), e não o cadastro de
    // segmentos: aqui, duas, como no 1bit.
    const nichos = [{ id: 4, nome: 'Alimentação' }, { id: 5, nome: 'Beleza' }];
    let lista = conversas;
    const nicho = Number(rq.query.nicho) || null;
    const resposta = String(rq.query.situacao || 'todos');
    if (nicho) {
      // Quem recebeu a campanha deste nicho: duas conversas e, com "todos" ou
      // "não responderam", mais um contato que SÓ recebeu e nunca escreveu.
      lista = conversas.slice(0, 2);
      if (resposta !== 'responderam') {
        lista = lista.concat([{ id: null, semConversa: true, telefone: '5511977770000',
          nome: 'Mercadinho do Zé', pessoaNome: 'Mercadinho do Zé', naoLidas: 0, estado: 'aberta',
          iaAtiva: 1, donoId: null, donoNome: null, canalId: 1,
          ultimaMensagem: 'Oi! Temos novidades para o seu mercado.', ultimaEm: '2026-09-17 09:30' }]);
      }
      if (resposta === 'naoResponderam') lista = lista.filter(c => c.semConversa);
    }
    rs.json({ success: true, conversas: lista, canais: numeros, recebidas: RECEBIDAS, nichos,
      contagem: filaCheia ? { ...CONTAGEM, total: 300 } : CONTAGEM });
  });
  // A página Canal (parte E) lista os números; aqui a empresa tem um só.
  app.get('/api/whatsapp/canais', (_q, rs) => rs.json({ success: true,
    canais: [{ id: 1, nome: 'Principal', instance: 'teste', padrao: true, state: 'close' }] }));
  app.get('/api/conversas/painel/resumo', (_q, rs) =>
    rs.json({ success: true, resumo: { abertas: 4, semResposta: 3, resolvidasHoje: 0, itensBase: 7 } }));
  app.get('/api/conversas/atendentes', (_q, rs) =>
    rs.json({ success: true, atendentes: [{ id: 10, nome: 'Ana' }], eu: 10 }));
  // Uma campanha de cada origem: o filtro de Conversas lista as duas (29/09).
  app.get('/api/conversas/campanhas', (_q, rs) => rs.json({ success: true, campanhas: [
    { origem: 'wa', id: 6, nome: 'leads-pa-pregao', status: 'pausada', canal: 'whatsapp' },
    { origem: 'comm', id: 3, nome: 'exemplo (cópia)', status: 'enviada', canal: 'whatsapp' },
    { origem: 'comm', id: 8, nome: 'boleto por e-mail', status: 'enviada', canal: 'email' },
  ] }));
  // O cadastro de segmentos (28/09): alimenta o filtro de Conversas e o de Listas.
  app.get('/api/comm/segmentos', (_q, rs) => rs.json({ success: true, segmentos: [
    { id: 1, nome: 'Bebidas', chave: 'bebidas' }, { id: 9, nome: 'Genérico', chave: 'generico' }] }));
  app.get('/api/conversas/:id', (rq, rs) => {
    const c = CONVERSAS.find(x => String(x.id) === rq.params.id);
    if (comHistorico) return rs.json({ success: true, conversa: c, ficha: { pedidos: [], titulos: [] }, ...pedaco(null) });
    if (comMidia) {
      return rs.json({ success: true, conversa: c, ficha: { pedidos: [], titulos: [] }, mensagens: [
        { id: 901, from_me: 0, message_type: 'imageMessage', texto: null, timestamp: 1789650000 },
        { id: 902, from_me: 0, message_type: 'templateMessage', texto: 'Ola tudo bem, verificar as condições', timestamp: 1789650010 },
        { id: 903, from_me: 0, message_type: 'audioMessage', texto: null, timestamp: 1789650020 },
        { id: 904, from_me: 0, message_type: 'documentMessage', texto: 'segue o boleto', timestamp: 1789650030 },
        { id: 905, from_me: 0, message_type: 'imageMessage', texto: null, timestamp: 1789650040 },
      ] });
    }
    rs.json({ success: true, conversa: c,
      // A terceira é LONGA de propósito. Com duas mensagens curtas, o balão fica
      // do tamanho do texto e nunca encosta no teto de largura — o teste H5
      // passava com qualquer valor, inclusive com o `72%` que ele deveria
      // reprovar. Sabotar a regra e ver o teste passar foi o que revelou isso.
      // Os `id` não são enfeite: o menu do botão direito (parte N) acha a
      // mensagem por `data-id`, e sem eles o balão nasce sem identidade.
      // A última é HUMANA (sem `from_bot`) e de agora: é ela que prova que
      // "certo/corrigir" ficou só nas da IA, que a hora separa os dias em dois
      // chips de data, e que "Editar" só aparece dentro dos 15 minutos.
      mensagens: [{ id: 11, from_me: 0, texto: 'Bom dia', timestamp: 1789650000 },
                  { id: 12, from_me: 1, from_bot: 1, texto: 'Olá! Como posso ajudar?', timestamp: 1789650060 },
                  { id: 13, from_me: 1, from_bot: 1, timestamp: 1789650120,
                    texto: 'Sobre o prazo de entrega para o Pará: trabalhamos com 12 dias úteis '
                      + 'para a capital e até 18 dias para o interior, contados a partir da '
                      + 'confirmação do pagamento. O frete fica por conta do comprador acima de '
                      + '300 km, e o rastreio é enviado por aqui assim que a transportadora coleta.' },
                  { id: 14, from_me: 1, from_bot: 0, texto: 'Qualquer dúvida, estou por aqui.',
                    timestamp: Math.floor(Date.now() / 1000) - 60, reacoes: '👍' },
                  // Sem texto e sem mídia: até 02/10 isto virava "(sem texto)",
                  // num balão estreito que ficava por cima da hora.
                  { id: 15, from_me: 0, message_type: 'contactMessage', texto: null,
                    timestamp: Math.floor(Date.now() / 1000) - 30 }],
      pausaIA: comPausa ? { pausada: true, ate: Math.floor(Date.now() / 1000) + pausaSegundos } : null,
      ficha: { pedidos: [], titulos: [] } });
  });
  // Histórico longo, como as 15 conversas do 1bit que passavam de 400 mensagens:
  // a rota real corta em 400 e diz `temMais`, e a tela busca o resto por aqui.
  const HISTORICO = Array.from({ length: 900 }, (_, i) => ({
    id: i + 1, from_me: i % 2, texto: 'mensagem ' + (i + 1), timestamp: 1789600000 + i * 60 }));
  const pedaco = (antesDe) => {
    const ate = antesDe ? HISTORICO.findIndex(m => m.id === Number(antesDe)) : HISTORICO.length;
    const ini = Math.max(0, ate - 400);
    return { mensagens: HISTORICO.slice(ini, ate), temMais: ini > 0 };
  };
  app.get('/api/conversas/900/detalhe-longo', (_q, rs) => rs.json(pedaco(null)));
  app.get('/api/conversas/:id/mensagens', (rq, rs) => rs.json({ success: true, ...pedaco(rq.query.antesDe) }));
  app.post('/api/conversas/abrir-destino', (rq, rs) => { pedidos.push('POST ' + rq.originalUrl); rs.json({ success: true, id: 1 }); });
  app.get('/api/conversas/:id/oportunidade', (_q, rs) => rs.json({ success: true, oportunidade: null }));
  // Qualificação pelo roteiro, na ficha da conversa.
  const PERGUNTAS = [
    { chave: 'vende_governo', texto: 'Já vende para órgão público?',
      opcoes: [{ id: 'parou', rotulo: 'Já vendeu e parou' }, { id: 'frequente', rotulo: 'Vende sempre' }] },
    { chave: 'acha_edital', texto: 'Como fica sabendo dos editais?',
      opcoes: [{ id: 'na_mao', rotulo: 'Olha os portais na mão' }, { id: 'sistema', rotulo: 'Tem sistema' }] },
  ];
  let CORRIGIDA = false;
  // O roteiro é o da campanha, em etapas (29/09): antes da correção o lead está
  // na segunda etapa; depois dela, o roteiro fecha como qualificado.
  app.get('/api/conversas/:id/qualificacao', (_q, rs) => rs.json({ success: true,
    roteiro: { id: 2, nome: 'Licitações' }, perguntas: PERGUNTAS,
    ...(CORRIGIDA
      ? { pontos: 4, maximo: 4, qualificado: true, resultado: 'qualificado', etapaAtual: null,
          caminho: ['vende_governo', 'acha_edital'], faltam: [] }
      : { pontos: 2, maximo: 4, qualificado: false, resultado: null, etapaAtual: 'acha_edital',
          caminho: ['vende_governo'], faltam: ['acha_edital'] }),
    visita: { id: 1, respostas: { vende_governo: 'parou' } }, respondidas: [] }));
  app.put('/api/conversas/:id/qualificacao', (_q, rs) => { CORRIGIDA = true;
    rs.json({ success: true, pontos: 4, maximo: 4, qualificado: true, resultado: 'qualificado', faltam: [] }); });
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
  // As páginas que eram guias atrás de um clique e agora abrem direto.
  app.get('/api/comm/templates', (_q, rs) => rs.json({ success: true, templates: [] }));
  app.get('/api/comm/listas', (_q, rs) => rs.json({ success: true, listas: [] }));
  app.get('/api/conversas/painel/relatorio', (_q, rs) => rs.json({ success: true,
    config: { canalLigado: true, iaLigada: true, temChaveIA: true, escopo: 'todos', campanhasAtivas: 0 },
    funil: { escreveram: 0 }, serie: [], erros: [], conversas: {}, tempoResposta: {} }));
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

  await t('A3. conversa no estado COMUM so exibe a marca da IA', async () => {
    // É o ponto do redesenho: antes, estas duas traziam "aberta" e "sem cadastro".
    // A da IA é a exceção, a pedido (02/10): ela aparece em toda conversa, porque
    // é o estado que se procura nesta tela, e cabe numa sigla de duas letras.
    const marcas = await frame.$$eval('.conv', els =>
      els.slice(0, 2).map(e => [...e.querySelectorAll('.marcas .pil')]
        .filter(p => !/\bia-(on|off|pausa)\b/.test(p.className)).length));
    assert(marcas.every(n => n === 0),
      'linha comum ainda exibe marca: ' + JSON.stringify(marcas) + ' — marca em toda linha vira textura');
  });

  await t('A4. o que e EXCEPCIONAL aparece: pendente e dono; a IA e so a cor', async () => {
    const txt = await frame.$$eval('.conv', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    assert(/pendente/.test(txt[2]), 'a conversa pendente não mostra o estado');
    assert(/Ana/.test(txt[4]), 'a conversa assumida não mostra o dono');
    // A sigla é a mesma nos três estados, e quem os separa é a classe de cor.
    // Escrever "IA desligada" ocupava metade da linha da prévia (02/10).
    const ia = await frame.$$eval('.conv', els => els.map(e => {
      const p = e.querySelector('.marcas .pil[class*="ia-"]');
      return p ? { txt: p.textContent.trim(), cls: p.className.replace('pil ', '') } : null;
    }));
    assert(ia.every(x => x && x.txt === 'IA'), 'a marca da IA sumiu ou voltou a escrever o estado: ' + JSON.stringify(ia));
    assert(ia[3].cls === 'ia-off', `a conversa com a IA desligada não ficou cinza: ${ia[3].cls}`);
    assert(ia[0].cls === 'ia-on' && ia[4].cls === 'ia-on', 'a conversa com a IA ligada não ficou verde: ' + JSON.stringify(ia));
  });

  await t('A4c. o contorno das marcas FECHA: nenhuma e cortada pela linha da previa', async () => {
    // A linha da prévia tem altura fixa de 20px com `overflow:hidden` — é o que
    // mantém todo card igual. A pílula media 22px (12px de fonte por 1,5 de
    // entrelinha, mais respiro e borda), e os 2px que sobravam eram a borda de
    // cima e a de baixo: o selo aparecia aberto nas duas pontas.
    const m = await frame.evaluate(() => {
      const linha = document.querySelector('.conv .l2');
      const alturaLinha = linha.getBoundingClientRect().height;
      const pils = [...document.querySelectorAll('.conv .marcas .pil')].map(p => {
        const r = p.getBoundingClientRect(), rl = p.closest('.l2').getBoundingClientRect();
        return { txt: p.textContent.trim(), alto: +r.height.toFixed(1),
          // Sobra para cima e para baixo: negativa quer dizer borda cortada.
          folgaTopo: +(r.top - rl.top).toFixed(1), folgaPe: +(rl.bottom - r.bottom).toFixed(1) };
      });
      return { alturaLinha, pils, corta: getComputedStyle(linha).overflow };
    });
    assert(m.pils.length, 'nenhuma marca na lista para medir');
    const cortadas = m.pils.filter(p => p.alto > m.alturaLinha || p.folgaTopo < 0 || p.folgaPe < 0);
    assert(!cortadas.length,
      `marca cortada pela linha de ${m.alturaLinha}px: ${JSON.stringify(cortadas)}`);
  });

  await t('A4b. as tres cores da marca da IA saem dos tokens de estado', async () => {
    // Verde responde, amarelo em pausa, cinza desligada. Medido no elemento, e
    // não no CSS: é a cor que chega à tela que diz o estado.
    const cores = await frame.evaluate(() => {
      const raiz = getComputedStyle(document.documentElement);
      const pintar = (cls) => {
        const p = document.createElement('span');
        p.className = 'pil ' + cls; document.body.appendChild(p);
        const c = getComputedStyle(p).color; p.remove(); return c;
      };
      const comoRgb = (v) => { const p = document.createElement('span'); p.style.color = v;
        document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; };
      return { on: pintar('ia-on'), pausa: pintar('ia-pausa'), off: pintar('ia-off'),
        success: comoRgb(raiz.getPropertyValue('--success')), warn: comoRgb(raiz.getPropertyValue('--warn')),
        text3: comoRgb(raiz.getPropertyValue('--text-3')) };
    });
    assert(cores.on === cores.success, `a IA ligada não está no verde do tema: ${cores.on}`);
    assert(cores.pausa === cores.warn, `a IA em pausa não está no amarelo do tema: ${cores.pausa}`);
    assert(cores.off === cores.text3, `a IA desligada não está no cinza do tema: ${cores.off}`);
    assert(new Set([cores.on, cores.pausa, cores.off]).size === 3,
      'duas das três cores são iguais, e a cor é a única coisa que diz o estado');
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

  // ==================== B. os filtros (29/09) ====================
  // Até 29/09 "sem nenhuma resposta", "não lidas", "sem dono" e "no total" eram
  // números grandes no alto da tela, e eram os filtros. Saíram a pedido; os
  // filtros vieram para a linha de chips.

  await t('B1. a faixa de numeros saiu, e os filtros dela estao nos chips', async () => {
    const faixa = await frame.$('.numeros');
    assert(!faixa, 'a faixa de números continua na tela');
    const chips = await frame.$$eval('.chips button', els => els.map(e => e.textContent.trim()));
    assert(chips.some(c => c.startsWith('Não lidas')), `falta "Não lidas": ${chips.join(' | ')}`);
    // "Sem resposta" SAIU em 01/10: contava `primeiraRespostaEm IS NULL`, que a
    // campanha e a IA não escrevem — 749 no 1bit onde o fato eram 75, todos já
    // dentro de "Aguardando você". "Campanhas" saiu para o seletor de nicho.
    // Saíram todos estes, cada um por um motivo: "Sem resposta" lia um campo que
    // ninguém escreve, "Campanhas" virou o seletor de nicho, "Aguardando você" é
    // parecido demais com "Não lidas", "Qualificados" foi para o seletor de
    // situação, e "Minhas" só aparece quando você tem alguma.
    for (const rot of ['Sem resposta', 'Campanhas', 'Aguardando', 'Qualificados', 'Minhas']) {
      assert(!chips.some(c => c.startsWith(rot)), `o filtro "${rot}" devia ter saído: ${chips.join(' | ')}`);
    }
  });

  await t('B2. "Nao lidas" filtra de verdade', async () => {
    const antes = pedidos.length;
    await frame.evaluate(() => [...document.querySelectorAll('.chips button')]
      .find(x => /^Não lidas/.test(x.textContent.trim())).click());
    await new Promise(r => setTimeout(r, 600));
    const novos = pedidos.slice(antes);
    assert(novos.some(u => /recorte=naoLidas/.test(u)), 'o chip não pediu o recorte: ' + JSON.stringify(novos));
  });

  await t('B3. o chip clicado fica marcado, e clicar de novo volta a mostrar todas', async () => {
    const sel = await frame.$$eval('.chips button.sel', els => els.map(e => e.textContent.trim()));
    assert(sel.length === 1 && /^Não lidas/.test(sel[0]), 'seleção: ' + JSON.stringify(sel));
    const antes = pedidos.length;
    await frame.evaluate(() => document.querySelector('.chips button.sel').click());
    // Esperar o PEDIDO, e não um tempo fixo: o clique só desmarca depois que a
    // lista volta do servidor, e 600ms é apertado com a máquina carregada.
    await frame.waitForFunction(() => !document.querySelector('.chips button.sel'), { timeout: 8000 })
      .catch(() => {});
    const ultimo = pedidos.slice(antes).pop() || '';
    assert(!/recorte=|nicho=|situacao=|estado=/.test(ultimo), 'não voltou a todas: ' + ultimo);
    const ainda = await frame.$$eval('.chips button.sel', els => els.length);
    assert(ainda === 0, 'o chip continuou marcado');
  });

  await t('B4. nenhum filtro aparece duas vezes', async () => {
    const chips = await frame.$$eval('.chips button', els => els.map(e => e.textContent.trim().replace(/\s*\d+$/, '')));
    assert(new Set(chips).size === chips.length, 'repetido: ' + chips.join(' | '));
  });

  await t('B5. o seletor traz so os nichos das campanhas, e o de resposta so com nicho escolhido', async () => {
    // Até 01/10 este seletor listava os 9 segmentos semeados e filtrava pelo
    // `segmentoId` da FICHA: oferecia ramo onde nunca houve campanha e recortava
    // por um campo que ninguém preenche.
    const ops = await frame.$$eval('#selNicho option', els => els.map(e => e.textContent.trim()));
    assert(ops.join(' | ') === 'Todos os nichos | Alimentação | Beleza', 'nichos: ' + ops.join(' | '));
    // Em "Todos os nichos" o seletor de situação CONTINUA na tela (02/10): antes
    // ele só existia dentro de um nicho e sumia ao voltar para todos.
    const semNicho = await frame.$eval('#selSituacao', e => getComputedStyle(e).display);
    assert(semNicho !== 'none', 'o seletor de situação sumiu em "Todos os nichos"');

    const antes = pedidos.length;
    await frame.evaluate(() => {
      const n = document.getElementById('selNicho'); n.value = '4'; n.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 700));
    assert(/nicho=4/.test(pedidos.slice(antes).pop() || ''), 'não pediu o nicho: ' + pedidos.slice(antes).pop());
    const comNicho = await frame.$eval('#selSituacao', e => [...e.options].map(o => o.value));
    assert(comNicho.includes('responderam') && comNicho.includes('naoResponderam'), JSON.stringify(comNicho));
    // Desliga antes de sair: o nicho recorta a lista, e as partes seguintes
    // medem a fila inteira. O N7b o religa quando precisa dele.
    await frame.evaluate(() => {
      const n = document.getElementById('selNicho'); n.value = ''; n.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 600));
  });

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

  // As quatro guias da tela de IA viraram seis páginas em 28/09: cada uma
  // precisa abrir sozinha, sem erro, e MOSTRAR o próprio conteúdo. Quando elas
  // eram guias, o defeito que escapou foi o painel inicial abrir em branco sem
  // erro nenhum em lugar nenhum — por isso a medida é de altura, não de DOM.
  const PAGINAS_IA = [
    ['ia', 'Base da IA', '#tbBase'],
    ['campanhas', 'Campanhas', '#tbCamp'],
    ['modelos', 'Modelos de mensagem', '#tbModelos'],
    ['listas', 'Listas', '#tbListas'],
    ['canal', 'Canal', '#iaPrompt'],
    ['relatorio', 'Relatório', '#relDiagnostico'],
  ];

  await t('E1. as seis paginas de IA e campanhas montam, cada uma com o seu conteudo', async () => {
    for (const [tela, titulo, alvo] of PAGINAS_IA) {
      const p2 = await browser.newPage();
      const erros = [];
      p2.on('pageerror', e => erros.push(String(e.message)));
      p2.on('response', r => { if (r.status() >= 400) erros.push(`${r.status()} em ${r.url()}`); });
      p2.on('console', m => {
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) erros.push('console: ' + m.text());
      });
      await p2.setViewport({ width: 1440, height: 1000 });
      await p2.goto(`http://127.0.0.1:${PORTA}/__wrapper/${tela}`, { waitUntil: 'networkidle0' });
      const f2 = p2.frames().find(f => f.url().includes(`/comunicacao/${tela}.html`));
      assert(!!f2, `${tela}.html não carregou`);
      await f2.waitForSelector(alvo, { visible: true, timeout: 8000 });
      await f2.waitForFunction(() =>
        !/Carregando…|Verificando…|Apurando…/.test(document.querySelector('.main-content').textContent),
        { timeout: 8000 }).catch(() => {});
      assert(erros.length === 0, `erro de JS em ${tela}.html: ` + erros.slice(0, 2).join(' | '));
      const h1 = await f2.$eval('h1', e => e.textContent.trim());
      assert(h1 === titulo, `${tela}.html abriu com o título "${h1}"`);
      // Nenhuma sobra da tela de guias: se ficou, a separação foi pela metade.
      const sobras = await f2.$$eval('.tabs, .tab-pane, .sub-abas', els => els.length);
      assert(sobras === 0, `${tela}.html ainda tem ${sobras} elemento(s) de guia`);
      const altura = await f2.$eval('.main-content', e => e.getBoundingClientRect().height);
      assert(altura > 150, `${tela}.html tem ${Math.round(altura)}px de conteúdo — está em branco`);
      await p2.close();
    }
  });

  await t('E2. a inbox nao ficou com pedaco da configuracao', async () => {
    const html = fs.readFileSync(path.join(PUB, 'comunicacao/conversas.html'), 'utf8');
    for (const sobra of ['tab-campanhas', 'tab-canal', 'tab-relatorio', 'tab-ia', 'modalCampanha']) {
      assert(!html.includes(sobra), `a inbox ainda carrega "${sobra}", que mudou de tela`);
    }
  });

  await t('E3. o menu alcanca as seis paginas, senao alguma fica inalcancavel', () => {
    // Era um botão na inbox que levava à tela de guias. Com seis páginas, quem
    // garante o caminho é o menu, na seção Comunicação, com a mesma feature da
    // inbox — página fora do menu só se abre sabendo o endereço.
    const menu = require(path.join(PUB, 'js/menu-config.js')).menuConfig;
    const secao = menu.secoes.find(s => s.titulo === 'Comunicação');
    assert(!!secao, 'a seção Comunicação sumiu do menu');
    for (const [tela, titulo] of PAGINAS_IA) {
      const item = secao.itens.find(i => i.link === `/comunicacao/${tela}.html`);
      assert(!!item, `${tela}.html não está no menu`);
      assert(item.texto === titulo, `o item de ${tela}.html se chama "${item.texto}"`);
      assert(item.feature === 'whatsapp', `${tela}.html não segue a feature da inbox`);
    }
    assert(!secao.itens.some(i => /IA e Campanhas/i.test(i.texto)), 'o item antigo continua no menu');
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
    assert(/Na etapa 2 de 2, 2 ponto/.test(txt) && /Licitações/.test(txt), `a situação não apareceu: "${txt.slice(0, 90)}"`);
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
    // A tela grava e depois relê o bloco: são duas idas ao servidor.
    await frame.waitForFunction(() => /Qualificado/.test(document.querySelector('#blocoQualificacao .linha strong')?.textContent || ''),
      { timeout: 4000 }).catch(() => {});
    const nota = await frame.$eval('#blocoQualificacao .linha strong', e => e.textContent);
    assert(/Qualificado, 4 ponto/.test(nota), `a situação ficou em "${nota}"`);
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

  await t('F1. quem pode ver Conversas alcanca as seis paginas de IA e campanhas', () => {
    const { podeVerPath } = require('../perfis-acesso');
    const restrito = { irrestrito: false, perfil: 'atendente', paginas: ['conversas'] };
    assert(podeVerPath(restrito, '/comunicacao/conversas.html'), 'perdeu acesso à própria inbox');
    for (const [tela] of PAGINAS_IA) {
      assert(podeVerPath(restrito, `/comunicacao/${tela}.html`),
        `o perfil que via a tela inteira levaria 403 em ${tela}.html, que foi separada dela`);
    }
  });

  await t('F2. a heranca NAO abre o modulo para quem nunca teve acesso', () => {
    const { podeVerPath } = require('../perfis-acesso');
    const deFora = { irrestrito: false, perfil: 'fiscal', paginas: ['notas-fiscais'] };
    for (const [tela] of PAGINAS_IA) {
      assert(!podeVerPath(deFora, `/comunicacao/${tela}.html`),
        `quem não tem Conversas passou a ver ${tela}.html — a herança virou porta dos fundos`);
    }
  });

  await t('F3. o menu e o servidor concordam sobre a heranca', () => {
    // Se o menu esconder o que o servidor libera, a tela existe e ninguém acha o
    // caminho; se liberar o que o servidor bloqueia, o item leva a um 403.
    const servidor = fs.readFileSync(path.join(RAIZ, 'perfis-acesso.js'), 'utf8');
    const menu = fs.readFileSync(path.join(PUB, 'js/sidebar.js'), 'utf8');
    const itens = require(path.join(PUB, 'js/menu-config.js')).menuConfig.secoes
      .flatMap(s => s.itens).filter(i => PAGINAS_IA.some(([tela]) => i.link === `/comunicacao/${tela}.html`));
    assert(itens.length === PAGINAS_IA.length, `${itens.length} das páginas estão no menu`);
    for (const { page } of itens) {
      assert(new RegExp(`'${page}',\\s*'conversas'`).test(servidor), `o servidor não conhece a herança de ${page}`);
      assert(new RegExp(`'${page}':\\s*'conversas'`).test(menu), `o menu não conhece a herança de ${page}`);
    }
  });

  // ==================== H. densidade e hierarquia ====================
  //
  // O acerto de 18/09. Antes disso, o topo da lista tinha QUATRO linhas de
  // controle antes da primeira conversa, quatro números do mesmo tamanho (dois
  // deles repetindo o mesmo valor) e balões de até 640px em tela larga.

  // Refeito em 29/09: os filtros passaram a quebrar linha, porque rolando
  // para o lado "Campanhas" e "Minhas" ficavam fora da vista. A garantia agora
  // é que nada de controle fica escondido nem espremido.
  const semEscondido = () => frame.evaluate(() => {
    const caixa = document.getElementById('filtros').getBoundingClientRect();
    return [...document.querySelectorAll('#filtros button')].filter(b => {
      const r = b.getBoundingClientRect();
      return r.right > caixa.right + 1 || r.left < caixa.left - 1 || r.bottom > caixa.bottom + 1;
    }).map(b => b.textContent.trim());
  });

  await t('H1. a busca tem a linha inteira, e nenhum filtro fica escondido', async () => {
    const busca = await frame.$eval('#busca', e => e.getBoundingClientRect().width);
    assert(busca >= 250, `a busca tem ${Math.round(busca)}px`);
    const fora = await semEscondido();
    assert(!fora.length, 'fora da vista: ' + fora.join(', '));
  });

  // Restauradas em 29/09: a troca da H1 no acerto de layout apagou, sem querer,
  // a H2, a H2b, a H5 e a H6, que vinham logo depois dela.
  await t('H2. som e notificacao dizem o estado, agora pela cor e pela dica', async () => {
    // Em 29/09 eram dois emojis sem explicação ao lado da busca; viraram botões
    // com texto no cabeçalho da página; e em 02/10 voltaram a ser só o ícone,
    // dentro da caixa (ver N14). O que não pode sumir é QUAL é o estado.
    const m = await frame.evaluate(() => ({
      naLista: !!document.querySelector('.lista .avisos'),
      estados: [...document.querySelectorAll('.avisos button')].map(b => ({
        ligado: b.classList.contains('on'), dica: b.getAttribute('data-dica') || '' })),
    }));
    assert(m.naLista, 'os avisos saíram da coluna da lista: ' + JSON.stringify(m));
    assert(/Som (ligado|desligado)/.test(m.estados[0].dica), 'dica do som: ' + m.estados[0].dica);
    assert(/Notificação (ligada|desligada)/.test(m.estados[1].dica), 'dica da notificação: ' + m.estados[1].dica);
    assert(m.estados[0].ligado === /Som ligado/.test(m.estados[0].dica), 'a cor do som não bate com o estado');
  });

  await t('H2b. mensagem nova toca o bipe e mostra a notificacao, com a quantidade', async () => {
    await frame.evaluate(() => {
      window.__bipes = 0; window.__notif = [];
      window.AudioContext = class { constructor(){ this.state = 'running'; this.currentTime = 0; this.destination = {}; }
        createOscillator(){ return { frequency: {}, connect(){}, start(){ window.__bipes++; }, stop(){} }; }
        createGain(){ return { gain: {}, connect(){} }; } resume(){ return Promise.resolve(); } close(){} };
      window.Notification = function(t){ window.__notif.push(t); };
      window.Notification.permission = 'granted';
      AVISO.som = true; AVISO.popup = true;
    });
    RECEBIDAS = { ultimoId: 10, novas: 0 };
    await frame.evaluate(() => carregar());
    await new Promise(r => setTimeout(r, 400));
    RECEBIDAS = { ultimoId: 12, novas: 2 };
    await frame.evaluate(() => carregar());
    await new Promise(r => setTimeout(r, 600));
    const r = await frame.evaluate(() => ({ bipes: window.__bipes, notif: window.__notif }));
    assert(r.bipes === 1 && r.notif.join() === '2 mensagens novas', JSON.stringify(r));
    RECEBIDAS = { ultimoId: 12, novas: 0 };
    await frame.evaluate(() => carregar());
    await new Promise(r => setTimeout(r, 600));
    const r2 = await frame.evaluate(() => window.__bipes);
    assert(r2 === 1, 'tocou sem mensagem nova');
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

  // Desde 01/10 a hora mora DENTRO do balão, no canto inferior direito, e não
  // numa linha abaixo do texto: era essa linha que dobrava a altura de toda
  // mensagem de uma palavra. Esta checagem substituiu a que media hora e ações
  // na mesma linha, que deixou de existir junto com a linha.
  await t('H6. a hora fica no canto inferior direito, dentro do balao', async () => {
    const m = await frame.evaluate(() => {
      const b = [...document.querySelectorAll('.msg')].find(e => /Bom dia/.test(e.textContent));
      const r = b.getBoundingClientRect();
      const h = b.querySelector('.hora-canto');
      if (!h) return null;
      const rh = h.getBoundingClientRect();
      return { texto: h.textContent.trim(), direita: r.right - rh.right, baixo: r.bottom - rh.bottom,
        dentro: rh.right <= r.right && rh.bottom <= r.bottom + 1, alto: r.height };
    });
    assert(m, 'a mensagem não tem a hora no canto (.hora-canto)');
    assert(/^\d{2}:\d{2}$/.test(m.texto), `a hora saiu como "${m.texto}"`);
    assert(m.dentro && m.direita < 20 && m.baixo < 14,
      `a hora não está no canto: ${Math.round(m.direita)}px da direita e ${Math.round(m.baixo)}px do pé`);
  });

  await t('H7. mensagem curta nao ganha linha vazia no balao', async () => {
    // O pre-wrap estava no balão inteiro e preservava a quebra e o recuo do
    // código em volta do texto: "compra" virava um bloco de 115 px (29/09).
    const m = await frame.evaluate(() => {
      const b = [...document.querySelectorAll('.msg')].find(e => /Bom dia/.test(e.textContent));
      const r = b.getBoundingClientRect();
      // A folga só se mede com o texto no elemento dele; a altura, sempre.
      const t = b.querySelector('.txt');
      return { alto: r.height, folgaTopo: t ? t.getBoundingClientRect().top - r.top : 0 };
    });
    assert(m.alto <= 70 && m.folgaTopo <= 14, `o balão de "Bom dia" tem ${Math.round(m.alto)}px, com ${Math.round(m.folgaTopo)}px antes do texto`);
  });

  // ==================== N. a tela no desenho do WhatsApp (01/10) ====================
  //
  // Quatro pedidos do dono, medidos aqui: card de altura constante, a data do
  // dia num chip, o menu do botão direito com as ações da mensagem, e a barra de
  // escrever com o campo arredondado e o enviar redondo — sem figurinha.

  await t('N1. todo card da lista tem a MESMA altura, inclusive o de IA desligada', async () => {
    const alturas = await frame.$$eval('.conv', els => els.map(e => ({
      alto: Math.round(e.getBoundingClientRect().height),
      quem: (e.querySelector('.nome') || {}).textContent || '',
    })));
    assert(alturas.length >= 5, `cards: ${alturas.length}`);
    const comMarca = await frame.$$eval('.conv', els =>
      els.some(e => e.querySelector('.marcas .pil.ia-off')));
    assert(comMarca, 'nenhum card com a marca da IA desligada — o caso que esticava');
    const unicas = [...new Set(alturas.map(a => a.alto))];
    assert(unicas.length === 1,
      `alturas diferentes na lista: ${JSON.stringify(alturas.map(a => a.quem + '=' + a.alto))}`);
  });

  await t('N2. a data do dia aparece num chip, com a data, e uma vez por dia', async () => {
    await frame.evaluate(() => abrir(1));
    await frame.waitForFunction(() => document.querySelectorAll('.msg').length >= 4, { timeout: 8000 });
    const dias = await frame.$$eval('#msgs .dia', els => els.map(e => e.textContent.trim()));
    // Duas datas: as três primeiras mensagens são de setembro e a última é de
    // hoje. Repetir a data dentro do mesmo dia é o defeito que isto pega.
    assert(dias.length === 2, `chips de data: ${JSON.stringify(dias)}`);
    assert(dias.every(d => /^\d{2}\/\d{2}\/\d{4}$/.test(d)), `formato dos chips: ${JSON.stringify(dias)}`);
    assert(new Set(dias).size === dias.length, `data repetida: ${JSON.stringify(dias)}`);
    const texto = await frame.$eval('#msgs', e => e.textContent);
    assert(!/\bHoje\b|\bOntem\b/.test(texto), 'o chip veio com o dia por escrito, e o pedido é a data');
  });

  await t('N3. avaliar a resposta sai do SELO "IA", e so nas mensagens da IA', async () => {
    // "certo" e "corrigir" eram dois links na linha de cada balão da IA, e
    // saíram de lá (02/10): o selo virou o botão, e as ações abrem no menu.
    const m = await frame.evaluate(() => {
      const balao = (t) => [...document.querySelectorAll('.msg')].find(e => e.textContent.includes(t));
      const daIA = balao('Como posso ajudar'), humana = balao('estou por aqui');
      return {
        iaTem: !!(daIA && daIA.querySelector('.porIA[data-ia]')),
        humanaTem: !!(humana && humana.querySelector('.porIA')),
        deles: !!balao('Bom dia').querySelector('.porIA'),
        // Nenhum link solto na conversa inteira: é o que o pedido tirou.
        links: document.querySelectorAll('#msgs .corrigir, #msgs .aprovar, #msgs .veredito').length,
        textoSolto: /\bcorrigir\b/i.test(document.getElementById('msgs').textContent),
      };
    });
    assert(m.iaTem, 'a mensagem da IA perdeu o selo, que é por onde se avalia a resposta');
    assert(!m.humanaTem, 'a mensagem escrita à mão ganhou o selo da IA');
    assert(!m.deles, 'a mensagem do contato ganhou o selo da IA');
    assert(!m.links && !m.textoSolto, `"certo"/"corrigir" continuam escritos no balão (${m.links} elemento(s))`);
  });

  await t('N3b. o clique no selo abre o menu com as acoes de avaliar', async () => {
    const m = await frame.evaluate(() => {
      const b = document.querySelector('.msg .porIA[data-ia]');
      const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('click', { bubbles: true,
        clientX: Math.round(r.left + 4), clientY: Math.round(r.top + 4) }));
      const menu = document.getElementById('menuMsg');
      return { aberto: menu.classList.contains('abre'),
        itens: [...menu.querySelectorAll('button')].map(x => x.textContent.trim()) };
    });
    assert(m.aberto, 'o clique no selo "IA" não abriu o menu');
    assert(m.itens.includes('Marcar como certa') && m.itens.includes('Corrigir a IA'),
      `o menu do selo não traz as duas ações: ${JSON.stringify(m.itens)}`);
    // E ele FECHA, como o do botão direito: menu preso cobre a conversa.
    await frame.evaluate(() => document.body.click());
    const fechou = await frame.evaluate(() => !document.getElementById('menuMsg').classList.contains('abre'));
    assert(fechou, 'o menu do selo ficou aberto depois do clique fora');
  });

  await t('N4. o botao direito abre o menu, com as acoes que valem para cada lado', async () => {
    const abrirMenu = async (trecho) => {
      await frame.evaluate((t) => {
        const el = [...document.querySelectorAll('.msg')].find(e => e.textContent.includes(t));
        const r = el.getBoundingClientRect();
        el.querySelector('.txt').dispatchEvent(new MouseEvent('contextmenu',
          { bubbles: true, clientX: Math.round(r.left + 10), clientY: Math.round(r.top + 10) }));
      }, trecho);
      return frame.evaluate(() => {
        const m = document.getElementById('menuMsg');
        const r = m.getBoundingClientRect();
        return { aberto: m.classList.contains('abre'), itens: [...m.querySelectorAll('button')].map(b => b.textContent.trim()),
          dentro: r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 };
      });
    };

    const minha = await abrirMenu('estou por aqui');
    assert(minha.aberto && minha.dentro, `menu: ${JSON.stringify(minha)}`);
    for (const item of ['Responder', 'Copiar', 'Editar', 'Apagar para todos']) {
      assert(minha.itens.includes(item), `falta "${item}" na minha mensagem: ${JSON.stringify(minha.itens)}`);
    }

    const deles = await abrirMenu('Bom dia');
    assert(deles.itens.includes('Responder') && deles.itens.includes('Copiar'), JSON.stringify(deles.itens));
    assert(!deles.itens.includes('Apagar para todos') && !deles.itens.includes('Editar'),
      `a mensagem do contato ofereceu ação que o WhatsApp não permite: ${JSON.stringify(deles.itens)}`);

    // Mensagem minha ANTIGA: o WhatsApp não deixa editar depois de 15 minutos
    // nem apagar para todos depois de 60 horas, e oferecer os itens seria
    // prometer o que não se cumpre. Até 02/10 o "Apagar para todos" aparecia em
    // mensagem de qualquer idade, e o clique dava erro cru da Evolution depois
    // de a mensagem já ter sumido da nossa tela.
    const antiga = await abrirMenu('Como posso ajudar');
    assert(!antiga.itens.includes('Editar'), `ofereceu editar numa mensagem de setembro: ${JSON.stringify(antiga.itens)}`);
    assert(!antiga.itens.includes('Apagar para todos'),
      `ofereceu apagar para todos numa mensagem de setembro: ${JSON.stringify(antiga.itens)}`);
    assert(antiga.itens.includes('Responder'), JSON.stringify(antiga.itens));
    await frame.evaluate(() => fecharMenuMsg());
  });

  await t('N5. responder pelo menu monta a citacao acima do campo', async () => {
    await frame.evaluate(() => { citarMensagem(11); });
    const c = await frame.evaluate(() => {
      const el = document.getElementById('citando');
      return { visivel: el.offsetHeight > 0, texto: el.textContent };
    });
    assert(c.visivel && /Bom dia/.test(c.texto), `citação: ${JSON.stringify(c)}`);
    await frame.evaluate(() => cancelarCitacao());
    const depois = await frame.evaluate(() => document.getElementById('citando').offsetHeight);
    assert(depois === 0, 'o X não tirou a citação');
  });

  await t('N6. a barra de escrever e a do WhatsApp: campo arredondado, enviar redondo, e nenhuma figurinha', async () => {
    const b = await frame.evaluate(() => {
      const caixa = document.querySelector('.caixa-escrita');
      const campo = document.getElementById('txtResposta');
      const enviar = document.querySelector('.btn-enviar');
      const r = enviar.getBoundingClientRect();
      const em = (el) => getComputedStyle(el);
      return {
        fundoCaixa: em(caixa).backgroundColor,
        fundoRodape: em(document.querySelector('.responder')).backgroundColor,
        bordaCaixa: parseFloat(em(caixa).borderTopWidth),
        sombraCaixa: em(caixa).boxShadow,
        raioCaixa: parseFloat(em(caixa).borderRadius),
        alturaLinha: Math.round(document.querySelector('.linha-escrita').getBoundingClientRect().height),
        campoSemBorda: em(campo).borderTopWidth === '0px' && em(campo).resize === 'none',
        enviarRedondo: Math.abs(r.width - r.height) <= 1 && parseFloat(em(enviar).borderRadius) >= r.width / 2 - 1,
        enviarAltura: Math.round(r.height),
        temAnexo: !!document.querySelector('.caixa-escrita [data-lucide="paperclip"], .caixa-escrita svg.lucide-paperclip'),
        temEmoji: !!document.getElementById('btnEmoji'),
        temFigurinha: /figurinha|sticker/i.test(document.querySelector('.responder').innerHTML),
        altoCaixa: Math.round(caixa.getBoundingClientRect().height),
      };
    });
    // A pílula FLUTUA (02/10, a pedido): o que a separa da conversa é a
    // superfície mais clara e a sombra, e não um contorno. Com borda e fundo
    // transparente ela era uma caixa desenhada sobre o mesmo fundo.
    assert(b.fundoCaixa !== b.fundoRodape && b.fundoCaixa !== 'rgba(0, 0, 0, 0)',
      `a pílula de escrever não se separa do fundo da conversa: ${b.fundoCaixa} contra ${b.fundoRodape}`);
    assert(b.bordaCaixa === 0, `a pílula voltou a ter contorno (${b.bordaCaixa}px)`);
    assert(b.sombraCaixa !== 'none', 'a pílula perdeu a sombra, que é o que a faz flutuar');
    assert(b.raioCaixa >= 16, `a moldura do campo tem raio ${b.raioCaixa}px — no WhatsApp ela é uma pílula`);
    assert(b.campoSemBorda, 'o campo ainda tem borda própria e alça de redimensionar');
    assert(b.enviarRedondo, 'o botão de enviar não é redondo');
    // Menor que a linha de escrever: com 42px ele era o elemento mais alto do
    // rodapé e puxava o olho para si, à frente do que se está escrevendo.
    // Contra a CAIXA DE ESCREVER, e não contra a linha: a linha é flex e cresce
    // junto com o botão, então a comparação com ela passava com qualquer
    // tamanho — foi o que uma sabotagem de 48px mostrou.
    assert(b.enviarAltura < b.altoCaixa,
      `o enviar tem ${b.enviarAltura}px contra ${b.altoCaixa}px da caixa de escrever`);
    assert(b.temAnexo && b.temEmoji, `faltam os ícones da barra: ${JSON.stringify(b)}`);
    assert(!b.temFigurinha, 'apareceu figurinha, e ela foi tirada a pedido');
    assert(b.altoCaixa <= 48, `a barra de escrever abriu com ${b.altoCaixa}px de altura`);
  });

  await t('N7. a rolagem usa o polegar proprio, e nao a barra do navegador', async () => {
    const r = await frame.evaluate(async () => {
      const caixa = document.getElementById('msgs');
      const nativa = caixa.offsetWidth - caixa.clientWidth;        // 0 = barra escondida
      caixa.scrollTop = 40;
      caixa.dispatchEvent(new Event('scroll'));
      await new Promise((f) => setTimeout(f, 250));
      const p = caixa.querySelector('.polegar-rolagem') || document.querySelector('.polegar-rolagem');
      const largura = p ? parseFloat(getComputedStyle(p).width) : 0;
      return { nativa, temPolegar: !!p, largura,
        visivel: p ? p.getAttribute('data-visivel') === '1' : false,
        flutua: p ? getComputedStyle(p).position === 'absolute' : false };
    });
    assert(r.nativa === 0, `a barra nativa continua ocupando ${r.nativa}px de layout`);
    assert(r.temPolegar, 'o polegar não foi criado (/js/polegar.js não carregou?)');
    assert(r.largura > 0 && r.largura <= 6, `o polegar tem ${r.largura}px — o padrão do biturion é 4px`);
    assert(r.flutua, 'o polegar não flutua: ele voltaria a roubar largura do texto');
  });

  await t('N7b. dentro do nicho aparece quem SO RECEBEU, marcado, e o clique abre o contato', async () => {
    await frame.evaluate(() => {
      const n = document.getElementById('selNicho'); n.value = '4'; n.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 700));
    const linhas = await frame.$$eval('.conv', els => els.map(e => ({
      nome: (e.querySelector('.nome') || {}).textContent || '',
      marcas: (e.querySelector('.marcas') || {}).textContent || '' })));
    const so = linhas.find(l => /Mercadinho/.test(l.nome));
    assert(so, 'quem só recebeu não apareceu: ' + JSON.stringify(linhas.map(l => l.nome)));
    assert(/só recebeu/.test(so.marcas), 'sem a marca "só recebeu": ' + JSON.stringify(so));
    const antes = pedidos.length;
    await frame.evaluate(() => [...document.querySelectorAll('.conv')]
      .find(e => /Mercadinho/.test(e.textContent)).click());
    await new Promise(r => setTimeout(r, 700));
    assert(pedidos.slice(antes).some(u => /POST .*abrir-destino/.test(u)),
      'o clique não abriu o contato: ' + JSON.stringify(pedidos.slice(antes)));
  });

  await t('N7c. "nao responderam" recorta, e voltar a Todos os nichos desliga o filtro', async () => {
    const antes = pedidos.length;
    await frame.evaluate(() => {
      const r = document.getElementById('selSituacao'); r.value = 'naoResponderam'; r.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 700));
    assert(/situacao=naoResponderam/.test(pedidos.slice(antes).pop() || ''), 'pediu: ' + (pedidos.slice(antes).pop() || ''));
    const nomes = await frame.$$eval('.conv .nome', els => els.map(e => e.textContent.trim()));
    assert(nomes.length === 1 && /Mercadinho/.test(nomes[0]), 'lista: ' + JSON.stringify(nomes));
    const antes2 = pedidos.length;
    await frame.evaluate(() => {
      const r = document.getElementById('selSituacao'); r.value = 'todos'; r.dispatchEvent(new Event('change'));
      const n = document.getElementById('selNicho'); n.value = ''; n.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 900));
    const ultimo = pedidos.slice(antes2).pop() || '';
    assert(!/nicho=/.test(ultimo) && !/situacao=/.test(ultimo), 'filtro continuou no pedido: ' + ultimo);
    // Deixa a conversa de teste aberta de novo para as medições seguintes.
    await frame.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 900));
  });

  await t('N8. os chips de data nao se empilham, e todos tem a mesma largura', async () => {
    // O `sticky` dos chips prendia TODOS no mesmo ponto do topo (medido na
    // conversa do Funprev: 24 chips em `top: 158`, um atrás do outro). E a fonte
    // proporcional dava 89px em "11/08/2026" contra 94px em "02/09/2026".
    const m = await frame.evaluate(() => {
      const chips = [...document.querySelectorAll('#msgs .dia')];
      const r = chips.map(e => e.getBoundingClientRect());
      let sobrepostos = 0;
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
        if (r[i].top < r[j].bottom && r[j].top < r[i].bottom) sobrepostos++;
      }
      return { n: chips.length, larguras: [...new Set(r.map(x => Math.round(x.width)))],
        sobrepostos, posicao: chips.length ? getComputedStyle(chips[0]).position : '',
        noGrupo: chips.every(e => e.parentElement && e.parentElement.classList.contains('grupo-dia')) };
    });
    assert(m.n >= 2, `só ${m.n} chip(s) de data`);
    assert(!m.sobrepostos, `${m.sobrepostos} par(es) de chips de data se sobrepondo`);
    assert(m.larguras.length === 1, `larguras diferentes: ${JSON.stringify(m.larguras)}`);
    // O chip GRUDA no topo enquanto o dia dele passa, como no WhatsApp — e o
    // que impede o empilhamento de 01/10 é cada um estar dentro do SEU grupo.
    // Preso ao `.msgs`, todos grudariam no mesmo ponto.
    assert(m.posicao === 'sticky', `o chip de data deixou de grudar no topo (${m.posicao})`);
    assert(m.noGrupo, 'o chip não está dentro do container do próprio dia: assim todos grudam no mesmo ponto');
  });

  await t('N9. a hora fica na MESMA linha do selo "IA", alinhada pela base', async () => {
    // Antes a hora era absoluta no canto e as marcas eram outra linha: ficavam
    // a 5px de altura uma da outra, e era isso o "certo e corrigir desalinhado".
    const m = await frame.evaluate(() => {
      const b = [...document.querySelectorAll('.msg')].find(e => e.querySelector('.porIA'));
      if (!b) return null;
      const R = (el) => { const x = el.getBoundingClientRect(); return { t: x.top, b: x.bottom, l: x.left, r: x.right }; };
      const elHora = b.querySelector('.hora-canto');
      const hora = R(elHora), selo = R(b.querySelector('.porIA'));
      return {
        // O que prova o alinhamento é a hora estar DENTRO da linha de marcas, e
        // não absoluta no canto: medir só a distância em pixels não distingue
        // "na mesma linha" de "perto o bastante".
        naLinha: !!elHora.closest('.meta'),
        posicao: getComputedStyle(elHora).position,
        difTopo: Math.abs(hora.t - selo.t),
        ordem: selo.r <= hora.l + 1,
        dentro: hora.r <= b.getBoundingClientRect().right };
    });
    assert(m, 'nenhuma mensagem da IA na conversa de teste');
    assert(m.naLinha, 'a hora não está na linha do selo — é o desalinhamento de 01/10');
    assert(m.posicao === 'static', `a hora voltou a ser absoluta (${m.posicao}) na mensagem com marcas`);
    assert(m.difTopo <= 6, `hora e selo em alturas diferentes: ${JSON.stringify(m)}`);
    assert(m.ordem, 'a ordem da linha não é selo → hora');
    assert(m.dentro, 'a hora saiu do balão');
  });

  await t('N10. a busca e a do WhatsApp: pilula com lupa, e o X so com texto', async () => {
    const m = await frame.evaluate(() => {
      const caixa = document.querySelector('.busca-wa');
      const em = getComputedStyle(caixa);
      const campo = document.getElementById('busca');
      const antes = getComputedStyle(caixa.querySelector('.limpar')).display;
      campo.value = 'teste'; campo.dispatchEvent(new Event('input'));
      const depois = getComputedStyle(caixa.querySelector('.limpar')).display;
      campo.value = ''; campo.dispatchEvent(new Event('input'));
      return { raio: parseFloat(em.borderRadius), alto: Math.round(caixa.getBoundingClientRect().height),
        lupa: !!caixa.querySelector('svg, i[data-lucide="search"]'),
        campoSemBorda: getComputedStyle(campo).borderTopWidth === '0px',
        placeholder: campo.getAttribute('placeholder'), antes, depois };
    });
    assert(m.raio >= 16, `a busca tem raio ${m.raio}px — no WhatsApp ela é uma pílula`);
    assert(m.lupa, 'a busca está sem a lupa');
    assert(m.campoSemBorda, 'o campo tem moldura própria dentro da pílula');
    assert(m.antes === 'none' && m.depois !== 'none', `o X da busca: ${JSON.stringify(m)}`);
    assert(m.placeholder === 'Pesquisar', `placeholder: ${m.placeholder}`);
  });

  await t('N11. mensagem sem texto diz O QUE e, e nao cobre a hora', async () => {
    const m = await frame.evaluate(() => {
      const b = [...document.querySelectorAll('.msg')].find(e => e.querySelector('.sem-conteudo'));
      if (!b) return null;
      const r = b.getBoundingClientRect(), h = b.querySelector('.hora-canto').getBoundingClientRect();
      const el = b.querySelector('.sem-conteudo');
      // A última LINHA do texto, e não o bloco: o `div` ocupa a largura toda do
      // balão, então comparar o retângulo dele com a hora acusaria sobreposição
      // em qualquer mensagem. Quem diz se o texto esbarra na hora é o Range.
      const faixa = document.createRange();
      faixa.selectNodeContents(el.firstChild);
      const linhas = [...faixa.getClientRects()];
      const ultima = linhas[linhas.length - 1] || el.getBoundingClientRect();
      return { texto: el.textContent.trim(),
        cobreAHora: ultima.right > h.left + 1 && ultima.bottom > h.top + 1,
        largura: Math.round(r.width), fimDoTexto: Math.round(ultima.right), inicioDaHora: Math.round(h.left),
        semTextoGenerico: /\(sem texto\)/.test(b.textContent) };
    });
    assert(m, 'nenhuma mensagem sem texto na conversa de teste');
    assert(m.texto === 'Contato', `o tipo não foi dito: "${m.texto}"`);
    assert(!m.semTextoGenerico, 'ainda aparece "(sem texto)"');
    assert(!m.cobreAHora,
      `o texto termina em ${m.fimDoTexto} e a hora começa em ${m.inicioDaHora} (balão de ${m.largura}px)`);
  });

  await t('N12. a reacao aparece NO balao reagido, e nao como mensagem', async () => {
    const m = await frame.evaluate(() => {
      const b = [...document.querySelectorAll('.msg')].find(e => /estou por aqui/.test(e.textContent));
      const r = b && b.querySelector('.reacoes');
      return { tem: !!r, emoji: r ? r.textContent.trim() : '',
        balaoSoDaReacao: [...document.querySelectorAll('.msg')].some(e => e.textContent.trim() === '👍') };
    });
    assert(m.tem && m.emoji === '👍', `a reação não ficou no balão: ${JSON.stringify(m)}`);
    assert(!m.balaoSoDaReacao, 'a reação virou um balão solto na conversa');
  });

  await t('N13. a IA calada aparece NO botao, em horas e minutos, sem mudar de tamanho', async () => {
    // A faixa "Retomar a IA" saiu (02/10) e o botão que já existia passou a
    // dizer os três estados. O contador é hh:mm porque a pausa é de 4 horas, e
    // a caixa tem largura fixa ENQUANTO ELE CORRE: em fonte proporcional
    // "03h:09" e "03h:10" não medem o mesmo, e ela crescia e encolhia a cada
    // minuto. Fora da pausa não há número, e ela fica do tamanho da sigla.
    const ler = () => frame.evaluate(() => {
      const b = document.getElementById('btnIA');
      return { txt: b.textContent.trim(), largura: Math.round(b.getBoundingClientRect().width),
        pausada: b.classList.contains('pausada'), off: b.classList.contains('off'),
        cor: getComputedStyle(b).color, faixa: !!document.querySelector('.aviso-pausa') };
    });

    comPausa = true; pausaSegundos = 7230;          // 2 h e meio minuto: a folga cobre o
    // segundo que passa entre o stub montar a resposta e a tela desenhar.
    await frame.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 1200));
    const duasHoras = await ler();
    assert(!duasHoras.faixa, 'a faixa "Retomar a IA" continua na tela');
    assert(duasHoras.pausada && !duasHoras.off, 'o botão não ficou no estado de pausa');
    assert(duasHoras.txt === 'IA 02h:00', `com 7.230s devia dizer "IA 02h:00": "${duasHoras.txt}"`);

    pausaSegundos = 155;                            // 2 min e meio, pela mesma folga
    await frame.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 1200));
    const doisMinutos = await ler();
    assert(doisMinutos.txt === 'IA 00h:02', `com 155s devia dizer "IA 00h:02": "${doisMinutos.txt}"`);

    // A largura da pausa é FIXA, e não "a que o texto pedir". Comparar dois
    // contadores não prova isso: eles têm os mesmos caracteres em outra ordem,
    // e com `tabular-nums` medem igual mesmo sem a regra — a sabotagem que
    // tirou a largura passava verde. O que prova é forçar um texto de outro
    // tamanho e a caixa não se mexer.
    pausaSegundos = 11 * 3600 + 11 * 60 + 30;
    await frame.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 1200));
    const onzeHoras = await ler();
    assert(onzeHoras.txt === 'IA 11h:11', `com 11h11 devia dizer "IA 11h:11": "${onzeHoras.txt}"`);
    const forcado = await frame.evaluate(() => {
      const b = document.getElementById('btnIA');
      const antes = Math.round(b.getBoundingClientRect().width);
      b.textContent = 'IA 11h:11 mais texto';
      const depois = Math.round(b.getBoundingClientRect().width);
      return { antes, depois };
    });
    assert(forcado.antes === forcado.depois,
      `a caixa da pausa acompanha o texto (${forcado.antes}px → ${forcado.depois}px) em vez de ter largura fixa`);

    comPausa = false;
    await frame.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 1000));
    const semPausa = await ler();
    assert(semPausa.txt === 'IA' && !semPausa.off && !semPausa.pausada,
      `sem pausa: "${semPausa.txt}", off=${semPausa.off}, pausada=${semPausa.pausada}`);
    // ENQUANTO O CONTADOR CORRE o tamanho não muda, que é o ponto do pedido: é
    // ali que o texto se reescreve a cada minuto.
    assert(duasHoras.largura === doisMinutos.largura,
      `a caixa mudou de tamanho durante a pausa: ${duasHoras.largura} / ${doisMinutos.largura}`);
    // E sem contador ela é MENOR: a largura da pausa deixava metade da caixa
    // vazia nos outros dois estados.
    assert(semPausa.largura < duasHoras.largura - 20,
      `sem contador a caixa continua do tamanho da pausa: ${semPausa.largura} contra ${duasHoras.largura}`);
    // Os três estados têm cores diferentes, que é o que os distingue agora.
    const desligada = await frame.evaluate(() => {
      const b = document.getElementById('btnIA');
      renderBotaoIA(1, 0);
      return { off: b.classList.contains('off'), txt: b.textContent.trim() };
    });
    assert(desligada.off && desligada.txt === 'IA', 'a IA desligada à mão não ficou cinza e sem contador: ' + JSON.stringify(desligada));
    assert(duasHoras.cor !== semPausa.cor, `a pausa tem a mesma cor da IA ligada (${duasHoras.cor})`);
  });

  await t('N13b. o cabecalho da conversa cabe numa linha, e o avatar nao e esmagado', async () => {
    // Com o contador dentro do selo da IA, o `flex-wrap` jogava o selo sozinho
    // para uma segunda fileira. Tirar o wrap resolveu — mas a primeira versão
    // da regra pegou TODOS os filhos e esmagou o avatar de 38px para 8px.
    comPausa = true; pausaSegundos = 7230;
    await frame.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 1200));
    const m = await frame.evaluate(() => {
      const cab = document.querySelector('.cab');
      const vis = [...cab.children].filter(e => e.getBoundingClientRect().width > 0);
      const linhas = new Set(vis.map(e => Math.round(e.getBoundingClientRect().bottom / 10)));
      return { altura: Math.round(cab.getBoundingClientRect().height), linhas: linhas.size,
        avatar: Math.round((cab.querySelector('.ini') || {}).getBoundingClientRect?.().width || 0),
        selo: Math.round(document.getElementById('btnIA').getBoundingClientRect().width),
        wrap: getComputedStyle(cab).flexWrap };
    });
    comPausa = false;
    assert(m.altura <= 80, `o cabeçalho tem ${m.altura}px — o selo da IA quebrou para a linha de baixo`);
    // A altura sozinha não basta: nesta janela o cabeçalho cabe numa linha mesmo
    // com `wrap`, e a sabotagem passava verde. O que garante em QUALQUER largura
    // é não haver quebra.
    assert(m.wrap === 'nowrap', `o cabeçalho voltou a quebrar linha (flex-wrap: ${m.wrap})`);
    assert(m.avatar >= 30, `o avatar foi esmagado para ${m.avatar}px`);
    assert(m.selo >= 80, `o selo da IA encolheu para ${m.selo}px`);
  });

  await t('N14. o titulo e os avisos ficam DENTRO da caixa, acima da busca', async () => {
    const m = await frame.evaluate(() => {
      const h1 = document.querySelector('.topo .titulo-lista h1');
      const busca = document.querySelector('.busca-wa');
      const avisos = [...document.querySelectorAll('.avisos button')];
      if (!h1 || !avisos.length) return null;
      return { titulo: h1.textContent.trim(), acimaDaBusca: h1.getBoundingClientRect().bottom <= busca.getBoundingClientRect().top + 1,
        foraDaCaixa: !!document.querySelector('.page-header'),
        avisos: avisos.map(b => ({ txt: b.textContent.trim(), w: Math.round(b.getBoundingClientRect().width),
          dica: b.getAttribute('data-dica') || '' })) };
    });
    assert(m, 'o título ou os avisos não estão na coluna da lista');
    assert(m.titulo === 'Conversas' && m.acimaDaBusca, JSON.stringify(m));
    assert(!m.foraDaCaixa, 'o cabeçalho de página continua fora da caixa');
    // Só o ícone: o nome ("Som ligado") ocupava três vezes o espaço, e o que
    // cada um faz continua na dica.
    assert(m.avisos.every(a => a.txt.length <= 2 && a.w <= 34), 'os avisos não ficaram só com o ícone: ' + JSON.stringify(m.avisos));
    assert(m.avisos.every(a => /Som|Notificação/.test(a.dica)), 'a dica deixou de dizer o que o botão faz');
  });

  await t('N14b. passar o mouse no icone ABRE o balao com o que ele faz', async () => {
    // O `data-dica` estava nos ícones desde 02/10 e nada o desenhava: só o
    // atributo, sem o balão, o ícone não dizia nada a quem passa o mouse.
    const antes = await frame.evaluate(() => {
      const d = document.getElementById('dica');
      return d ? { existe: true, aberto: d.classList.contains('on') } : { existe: false };
    });
    assert(antes.existe, 'a tela não tem o balão do data-dica');
    assert(!antes.aberto, 'o balão nasce aberto');
    const alvo = await frame.$('.avisos button');
    await alvo.hover();
    await new Promise(r => setTimeout(r, 250));
    const m = await frame.evaluate(() => {
      const d = document.getElementById('dica'), b = document.querySelector('.avisos button');
      const r = d.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return { aberto: d.classList.contains('on'), txt: d.textContent.trim(),
        opaco: getComputedStyle(d).opacity, naTela: r.top >= 0 && r.left >= 0 && r.right <= innerWidth,
        pertoDoAlvo: Math.abs((r.left + r.width / 2) - (rb.left + rb.width / 2)) < r.width };
    });
    assert(m.aberto && Number(m.opaco) > 0.5, `o balão não apareceu no hover: ${JSON.stringify(m)}`);
    assert(/Som/.test(m.txt), `o balão não diz o que o ícone faz: "${m.txt}"`);
    assert(m.naTela && m.pertoDoAlvo, `o balão abriu fora da tela ou longe do ícone: ${JSON.stringify(m)}`);
    // E ele FECHA ao sair: balão que fica preso cobre a lista.
    await frame.hover('.topo h1');
    await new Promise(r => setTimeout(r, 250));
    const fechou = await frame.evaluate(() => !document.getElementById('dica').classList.contains('on'));
    assert(fechou, 'o balão ficou aberto depois de o mouse sair do ícone');
  });

  await t('N14c. os seletores do cabecalho medem o texto ESCOLHIDO, e nao a maior opcao', async () => {
    // O <select> nativo se dimensiona pela opção mais larga: em "aberta" sobrava
    // dentro da caixa o espaço de "resolvida". `field-sizing:content` conserta,
    // e navegador sem a propriedade fica no comportamento antigo.
    await frame.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 800));
    const m = await frame.evaluate(() => {
      const sel = document.querySelector('.cab select');
      const medir = (valor) => { sel.value = valor; sel.dispatchEvent(new Event('input'));
        return sel.getBoundingClientRect().width; };
      const curta = medir('aberta'), longa = medir('resolvida');
      sel.value = 'aberta';
      return { suporte: CSS.supports('field-sizing', 'content'), curta, longa,
        campo: getComputedStyle(sel).fieldSizing };
    });
    if (!m.suporte) return;                      // navegador sem a propriedade: nada a medir
    assert(m.campo === 'content', `o seletor do cabeçalho não pede a medida pelo conteúdo: ${m.campo}`);
    assert(m.longa > m.curta + 5,
      `"aberta" e "resolvida" ocupam o mesmo (${Math.round(m.curta)} e ${Math.round(m.longa)}px): a caixa não acompanha o texto`);
  });

  await t('N15. o rodape FLUTUA sobre a conversa: nao e um bloco atras da pilula', async () => {
    // Enquanto o rodapé era um bloco no fluxo, a faixa da largura inteira da
    // coluna ficava atrás da pílula — era essa a caixa que incomodava, e ter o
    // mesmo fundo das mensagens não a desfazia. Agora ele é `absolute` sobre a
    // conversa, sem fundo, e quem abre o espaço é o padding do `.msgs`.
    const m = await frame.evaluate(() => {
      const r = document.querySelector('.responder'), caixa = document.querySelector('.caixa-escrita');
      const msgs = document.getElementById('msgs');
      const em = (e) => getComputedStyle(e);
      return { posicao: em(r).position, fundoRodape: em(r).backgroundColor,
        bordaRodape: em(r).borderTopWidth, raioPilula: parseFloat(em(caixa).borderRadius),
        fundoPilula: em(caixa).backgroundColor, fundoMsgs: em(msgs).backgroundColor,
        ponteiro: em(r).pointerEvents, ponteiroPilula: em(caixa).pointerEvents,
        vao: parseFloat(em(msgs).paddingBottom), alto: Math.round(r.getBoundingClientRect().height),
        // A conversa vai até embaixo: com o rodapé fora do fluxo, ela não para
        // antes dele.
        msgsAteOFim: Math.abs(msgs.getBoundingClientRect().bottom - r.getBoundingClientRect().bottom) <= 1 };
    });
    assert(m.posicao === 'absolute', `o rodapé voltou a ser um bloco no fluxo (position: ${m.posicao})`);
    assert(m.fundoRodape === 'rgba(0, 0, 0, 0)', `o rodapé pinta uma faixa atrás da pílula (${m.fundoRodape})`);
    assert(parseFloat(m.bordaRodape) === 0, `o rodapé voltou a ter linha no topo (${m.bordaRodape})`);
    assert(m.msgsAteOFim, 'a conversa não vai até o pé da coluna: o rodapé continua ocupando lugar');
    // O vão é MEDIDO: sem ele a última mensagem fica embaixo da barra.
    assert(m.vao >= m.alto, `a conversa reserva ${m.vao}px para um rodapé de ${m.alto}px`);
    // O vão em volta não captura o clique; a pílula, sim.
    assert(m.ponteiro === 'none' && m.ponteiroPilula === 'auto',
      `o vão do rodapé rouba o clique da conversa: ${m.ponteiro} / ${m.ponteiroPilula}`);
    // A pílula é a ÚNICA coisa desenhada ali, e ela flutua pelo fundo próprio.
    // Transparente NÃO conta: "diferente do rodapé" sozinho passava com fundo
    // nenhum, que é justamente o caso em que ela some.
    assert(m.raioPilula >= 16 && m.fundoPilula !== m.fundoMsgs && m.fundoPilula !== 'rgba(0, 0, 0, 0)',
      'a pílula de escrever deixou de se destacar do fundo da conversa: ' + JSON.stringify(m));
  });

  // ==================== I. vários números ====================
  //
  // Desde 28/09 a empresa pode ter vários números; a caixa é uma só, com filtro.
  // Com um número (tudo acima), o seletor não aparece. Com dois, aparece, cada
  // conversa diz por qual número veio, e o topo continua em duas linhas.

  doisNumeros = true;
  await frame.evaluate(() => carregar());
  await new Promise(r => setTimeout(r, 600));

  await t('I1. com dois numeros aparece o seletor, e cada conversa diz o numero', async () => {
    const sel = await frame.$eval('#selNumero', e => ({ vis: e.offsetParent !== null, ops: [...e.options].map(o => o.textContent) }));
    assert(sel.vis && JSON.stringify(sel.ops) === '["Todos os números","Comercial","Suporte"]', JSON.stringify(sel));
    const selos = await frame.$$eval('.conv .pil.numero', els => els.map(e => e.textContent));
    assert(selos.length === CONVERSAS.length && selos.includes('Suporte'), 'selos: ' + selos.join(','));
  });

  await t('I2. escolher o numero pede a lista filtrada, junto do filtro que ja estava', async () => {
    const antes = pedidos.length;
    await frame.evaluate(() => { const s = document.getElementById('selNumero'); s.value = '2'; s.dispatchEvent(new Event('change')); });
    await new Promise(r => setTimeout(r, 500));
    const url = pedidos.slice(antes).find(u => /^\/api\/conversas\?/.test(u)) || '';
    assert(/canal=2/.test(url), 'o filtro não chegou ao servidor: ' + url);
  });

  await t('I3. com numero e nicho, os seletores dividem a linha de baixo e a busca continua inteira', async () => {
    // Em 29/09 os dois seletores na linha da busca deixaram o campo com 26 px.
    // A busca é medida pela PÍLULA (01/10), que é a moldura do campo.
    const m = await frame.evaluate(() => {
      const r = (sel) => { const b = document.querySelector(sel).getBoundingClientRect();
        return { top: b.top, bottom: b.bottom, width: b.width }; };
      return { busca: r('.busca-wa'), num: r('#selNumero'), seg: r('#selNicho') };
    });
    assert(m.busca.width >= 250, `a busca tem ${Math.round(m.busca.width)}px`);
    assert(m.num.width > 0 && m.seg.width > 0 && Math.abs(m.num.top - m.seg.top) < 2 && m.num.top >= m.busca.bottom,
      JSON.stringify({ num: [m.num.top, m.num.width], seg: [m.seg.top, m.seg.width], buscaFim: m.busca.bottom }));
    const fora = await semEscondido();
    assert(!fora.length, 'fora da vista: ' + fora.join(', '));
  });

  await t('I4. a caixa vai ate o pe da pagina', async () => {
    const m = await frame.evaluate(() => ({ fim: document.getElementById('central').getBoundingClientRect().bottom, alto: innerHeight }));
    assert(m.alto - m.fim <= 40, `sobram ${Math.round(m.alto - m.fim)}px embaixo da caixa`);
  });

  // ==================== M. mídia que o contato manda (29/09) ====================
  // Até 29/09 a mensagem com foto, áudio ou documento aparecia como "(sem
  // texto)". Depois do D1 de propósito: a 905 dá 404, e é o caso de mídia que
  // o WhatsApp já não tem.
  comMidia = true;
  await frame.evaluate(() => abrir(1));
  await new Promise(r => setTimeout(r, 1500));

  await t('M1. imagem e imagem de mensagem de empresa aparecem, com o texto embaixo', async () => {
    const imgs = await frame.$$eval('#msgs .msg img', els => els.map(e => ({ src: e.getAttribute('src'), w: e.naturalWidth })));
    const ok1 = imgs.find(i => /\/901$/.test(i.src)), ok2 = imgs.find(i => /\/902$/.test(i.src));
    assert(ok1 && ok1.w > 0 && ok2 && ok2.w > 0, 'imagens: ' + JSON.stringify(imgs));
    const txt = await frame.$eval('#msgs', e => e.textContent);
    assert(/Ola tudo bem, verificar as condições/.test(txt), 'o texto da mensagem de empresa não aparece');
  });

  await t('M2. audio vira player, e documento vira link que abre o arquivo', async () => {
    const audio = await frame.$eval('#msgs audio', e => e.getAttribute('src'));
    assert(/\/api\/conversas\/midia\/903$/.test(audio), 'áudio: ' + audio);
    const doc = await frame.$$eval('#msgs a.midia', els => els.filter(e => /Abrir documento/.test(e.textContent)).map(e => e.getAttribute('href')));
    assert(doc.length === 1 && /\/904$/.test(doc[0]), 'documento: ' + JSON.stringify(doc));
  });

  await t('M3. mensagem so de midia nao diz "(sem texto)", e midia perdida e dita', async () => {
    const txt = await frame.$eval('#msgs', e => e.textContent);
    assert(!/\(sem texto\)/.test(txt), 'apareceu "(sem texto)" em mensagem com mídia');
    assert(/Mídia indisponível/.test(txt), 'a mídia que não existe mais não foi dita');
  });

  // 30/09, medidos na produção: 15 conversas do 1bit passam de 400 mensagens e a
  // tela cortava em silêncio, sem como ver o histórico; e a conversa abria no
  // meio dela, porque a rolagem ia ao fim antes de a mídia carregar e crescer.
  await t('H8. conversa longa: as anteriores sao carregaveis, e a rolagem abre no fim', async () => {
    comMidia = false; comHistorico = true;
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/conversas`, { waitUntil: 'networkidle0' });
    const f8 = page.frames().find(x => x.url().includes('conversas.html'));
    await f8.waitForSelector('.conv', { timeout: 8000 });
    await f8.evaluate(() => abrir(1));
    await new Promise(r => setTimeout(r, 700));
    const antes = await f8.evaluate(() => {
      const m = document.getElementById('msgs');
      return { qtd: m.querySelectorAll('.msg').length, botao: !!document.getElementById('btnMaisAntigas'),
               noFim: m.scrollHeight - m.scrollTop - m.clientHeight < 80,
               primeira: m.querySelector('.msg .txt').textContent };
    });
    assert(antes.qtd === 400, `a tela mostrou ${antes.qtd} mensagens`);
    assert(antes.botao, 'sem o botão de carregar as anteriores');
    assert(antes.noFim, 'a conversa não abriu no fim das mensagens');
    assert(/mensagem 501$/.test(antes.primeira), `a primeira mostrada é "${antes.primeira}"`);

    await f8.evaluate(() => document.getElementById('btnMaisAntigas').click());
    await new Promise(r => setTimeout(r, 700));
    const depois = await f8.evaluate(() => {
      const m = document.getElementById('msgs');
      return { qtd: m.querySelectorAll('.msg').length, botao: !!document.getElementById('btnMaisAntigas'),
               primeira: m.querySelector('.msg .txt').textContent, pos: m.scrollTop };
    });
    assert(depois.qtd === 800, `depois de carregar: ${depois.qtd} mensagens`);
    assert(/mensagem 101$/.test(depois.primeira), `a primeira agora é "${depois.primeira}"`);
    assert(depois.botao, 'ainda faltam 100 e o botão sumiu');
    assert(depois.pos > 0, 'a posição de leitura foi para o topo ao crescer a lista');

    // O chip de data GRUDA no topo enquanto o dia dele passa, como no WhatsApp,
    // e o do dia seguinte empurra o anterior. Isto se mede AQUI, e não na
    // conversa de cinco mensagens: lá tudo cabe na tela, não há rolagem, e o
    // chip parado no alto não distingue "grudado" de "é onde ele nasceu".
    const chips = await f8.evaluate(async () => {
      const m = document.getElementById('msgs');
      const topo = () => m.getBoundingClientRect().top + parseFloat(getComputedStyle(m).paddingTop);
      const ler = () => [...m.querySelectorAll('.dia')]
        .map(e => Math.round(e.getBoundingClientRect().top - topo()));
      m.scrollTop = 0;
      await new Promise(r => requestAnimationFrame(r));
      const noComeco = ler();
      m.scrollTop = Math.round(m.scrollHeight / 2);
      await new Promise(r => requestAnimationFrame(r));
      const noMeio = ler();
      const rs = [...m.querySelectorAll('.dia')].map(e => e.getBoundingClientRect());
      let juntos = 0;
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        if (rs[i].top < rs[j].bottom && rs[j].top < rs[i].bottom) juntos++;
      }
      return { n: rs.length, noComeco, noMeio, juntos,
        grudado: noMeio.some(v => v >= -2 && v <= 2) };
    });
    // Dois dias é o que as 800 mensagens de um minuto cobrem, e bastam: o que
    // se mede é um chip preso no topo e nenhum par empilhado.
    assert(chips.n >= 2, `só ${chips.n} chip(s) de data na conversa longa`);
    // O empilhamento de 01/10: 24 datas no mesmo ponto, uma atrás da outra.
    assert(!chips.juntos, `${chips.juntos} par(es) de chips empilhados: ${JSON.stringify(chips.noMeio)}`);
    assert(chips.grudado, `nenhum chip preso no topo com a conversa rolada: ${JSON.stringify(chips.noMeio)}`);
    assert(JSON.stringify(chips.noComeco) !== JSON.stringify(chips.noMeio),
      'os chips não acompanharam a rolagem: o sticky não está valendo');
    comHistorico = false;
  });

  await t('I5. no celular a lista ocupa a caixa, e a conversa vazia nao aparece', async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/conversas`, { waitUntil: 'networkidle0' });
    const f = page.frames().find(x => x.url().includes('conversas.html'));
    await f.waitForSelector('.conv', { timeout: 8000 });
    const m = await f.evaluate(() => ({
      thread: document.querySelector('.coluna.thread').getBoundingClientRect().height,
      busca: document.querySelector('.busca-wa').getBoundingClientRect().width,
    }));
    assert(m.thread === 0 && m.busca >= 300, JSON.stringify(m));
    // Tocar na conversa a abre na tela toda, sem a ficha, e Voltar traz a lista.
    // Até 29/09 nada abria a conversa no celular: a classe `abriu` não era posta.
    await f.evaluate(() => document.querySelectorAll('.conv')[0].click());
    await f.waitForFunction(() => document.querySelectorAll('.msg').length > 0, { timeout: 8000 });
    const aberta = await f.evaluate(() => ({
      thread: document.querySelector('.coluna.thread').getBoundingClientRect().height,
      lista: document.querySelector('.coluna.lista').getBoundingClientRect().height,
      ficha: document.querySelector('.coluna.ficha').getBoundingClientRect().height,
      voltar: document.querySelector('.cab .voltar').getBoundingClientRect().width,
    }));
    assert(aberta.thread > 400 && aberta.lista === 0 && aberta.ficha === 0 && aberta.voltar > 0, 'aberta: ' + JSON.stringify(aberta));
    await f.evaluate(() => document.querySelector('.cab .voltar').click());
    const volta = await f.evaluate(() => document.querySelector('.coluna.lista').getBoundingClientRect().height);
    assert(volta > 400, 'o Voltar não trouxe a lista: ' + volta);
  });

  await t('I6. no tablet a ficha nao cai embaixo da conversa', async () => {
    await page.setViewport({ width: 1024, height: 768 });
    await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/conversas`, { waitUntil: 'networkidle0' });
    const f = page.frames().find(x => x.url().includes('conversas.html'));
    await f.waitForSelector('.conv', { timeout: 8000 });
    await f.evaluate(() => document.querySelectorAll('.conv')[0].click());
    await f.waitForFunction(() => document.querySelectorAll('.msg').length > 0, { timeout: 8000 });
    const ficha = await f.evaluate(() => document.querySelector('.coluna.ficha').getBoundingClientRect().height);
    assert(ficha === 0, `a ficha aparece com ${Math.round(ficha)}px no tablet`);
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
