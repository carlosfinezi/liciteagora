/**
 * As listas de campanha — quem está dentro, medido em Chrome.
 *
 * ── O defeito que motivou a suíte ─────────────────────────────────────────
 *
 * As três listas do tenant 1bit somam 27.775 contatos e a tela mostrava as
 * três vazias. Duas causas somadas: a rota `GET /api/comm/listas/:id` fazia
 * `JOIN pessoas ON p.id = m.pessoaId`, um JOIN interno que descarta todo
 * membro importado do legado (esses têm `destinoManual` e nenhum `pessoaId`),
 * e a coluna "Pessoas" lia `totalMembros`, campo que a rota nunca mandou —
 * ela manda `qtdMembros`. O resultado era lista de 15.595 contatos exibindo um
 * traço na contagem e "Nenhum cliente com telefone" ao abrir.
 *
 * ── Por que Chrome, e com a API stubada ───────────────────────────────────
 *
 * O que está sob teste é o que a pessoa VÊ. Contar `innerHTML` provaria que a
 * string existe, não que ela aparece. As respostas de API são fixas aqui de
 * propósito: medir contra o banco vivo faz a suíte reprovar no primeiro uso
 * legítimo do sistema, quando alguém tirar um contato da lista.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PORTA = 34162;

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
 * O tamanho é o do tenant real. Com dez membros a paginação não apareceria, e
 * era justamente ela que faltava: a rota antiga mandava a lista inteira.
 */
const TOTAL_LISTA_1 = 15595;
const membrosDe = (pagina, porPagina) => Array.from({ length: porPagina }, (_, i) => {
  const n = (pagina - 1) * porPagina + i;
  // Os dois primeiros com ramo, o resto sem: é a mistura real depois do
  // backfill, e a tela precisa dizer os dois casos.
  return { id: 1000 + n, pessoaId: null, nome: `CONTATO LEGADO ${n}`,
           telefone: '55949' + String(n).padStart(7, '0'), vinculo: 'manual',
           ramo: n < 2 ? 'Comércio varejista de bebidas' : null,
           segmento: n < 2 ? 'bebidas' : null };
});

const LISTAS = [
  { id: 1, nome: 'leads-pa-pregao (legado)', descricao: 'Importada da campanha legado #6', qtdMembros: TOTAL_LISTA_1 },
  { id: 2, nome: 'lista vazia', descricao: null, qtdMembros: 0 },
];

const CAMPANHAS = [
  { origem: 'comm', id: 7, nome: 'Aviso de boleto', status: 'rascunho', canal: 'whatsapp',
    criadoEm: '2026-09-17', destinatarios: null, totalDestinatarios: 12,
    listaId: 1, listaNome: 'leads-pa-pregao (legado)' },
  { origem: 'wa', id: 6, nome: 'leads-pa-pregao', status: 'pausada', canal: 'whatsapp',
    criadoEm: '2026-08-14', destinatarios: { pendente: 15468, enviado: 314 } },
];

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));

  const app = express();
  const pedidos = [];                          // toda chamada de membros, para conferir busca e página
  app.get('/api/comm/listas', (_q, rs) => rs.json({ success: true, listas: LISTAS }));
  app.get('/api/comm/listas/:id', (rq, rs) => {
    pedidos.push(rq.originalUrl);
    const lista = LISTAS.find(l => String(l.id) === rq.params.id);
    const q = String(rq.query.q || '');
    const pagina = Number(rq.query.pagina) || 1;
    const porPagina = 100;
    // Busca devolve um resultado só; sem busca, a página cheia.
    if (q) {
      return rs.json({ success: true, lista, pagina: 1, porPagina,
        total: 1, membros: [{ id: 99, pessoaId: null, nome: 'ACHADO PELA BUSCA',
                              telefone: '5594999999999', vinculo: 'manual' }] });
    }
    const total = lista.qtdMembros;
    rs.json({ success: true, lista, pagina, porPagina, total, comRamo: total ? 2 : 0,
      membros: total ? membrosDe(pagina, Math.min(porPagina, total)) : [] });
  });
  app.get('/api/comm/templates', (_q, rs) => rs.json({ success: true, templates: [] }));
  app.get('/api/conversas/campanhas', (_q, rs) => rs.json({ success: true, campanhas: CAMPANHAS }));
  app.get('/api/conversas/publico', (_q, rs) => rs.json({ success: true, ufs: [], total: 0, pessoas: [] }));
  // O que o shell e a tela pedem sozinhos. Sem estes, o 404 apareceria como
  // defeito da tela.
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  app.get('/api/ia/base', (_q, rs) => rs.json({ success: true, itens: [], correcoes: [] }));
  app.get('/api/whatsapp/status', (_q, rs) => rs.json({ success: true, connected: false, instance: 'teste' }));
  app.get('/api/whatsapp/ritmo', (_q, rs) => rs.json({ success: true, hora: 0, hoje: 0, limiteHora: 25 }));
  app.get('/api/whatsapp/ai-config', (_q, rs) => rs.json({ success: true, enabled: false, prompt: '',
    escopo: 'todos', horario: { ativo: false, faixas: null, mensagem: '' } }));
  app.get('/api/conversas/relatorio', (_q, rs) => rs.json({ success: true, serie: [], erros: [],
    funil: {}, conversas: {}, tempoResposta: {} }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  app.get('/__wrapper/:tela', (rq, rs) => rs.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
    + `ipt></head><body style="margin:0"><iframe src="/comunicacao/${rq.params.tela}.html"`
    + ' style="width:100vw;height:100vh;border:0"></iframe></body></html>'));
  app.use(express.static(PUB));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-listas-membros',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const erros = [];
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.on('pageerror', e => erros.push(String(e.message)));
  page.on('response', r => { if (r.status() >= 400) erros.push(`${r.status()} em ${r.url()}`); });

  await page.goto(`http://127.0.0.1:${PORTA}/__wrapper/ia`, { waitUntil: 'networkidle0' });
  const frame = page.frames().find(f => f.url().includes('ia.html'));
  if (!frame) { console.log('FALHA a tela não carregou no iframe'); process.exit(1); }

  const abrirAba = async (rotulo) => {
    await frame.evaluate((r) => {
      [...document.querySelectorAll('.tab')].find(t => t.textContent.trim() === r).click();
    }, rotulo);
  };
  const clicarSub = async (rotulo) => {
    await frame.evaluate((r) => {
      [...document.querySelectorAll('.sub-abas .sub')].find(b => b.textContent.trim() === r).click();
    }, rotulo);
  };
  const esperar = (ms) => new Promise(r => setTimeout(r, ms));
  /**
   * Espera a tabela sair de "Carregando…". Em timeout, diz o que estava na
   * tela e o que o navegador reclamou: "Waiting failed: 8000ms" sozinho não
   * distingue API muda de erro de JavaScript.
   */
  const esperarTabela = async (id) => {
    try {
      await frame.waitForFunction((x) =>
        !/Carregando/.test(document.getElementById(x).textContent), { timeout: 8000 }, id);
    } catch (e) {
      const txt = await frame.$eval('#' + id, el => el.textContent.replace(/\s+/g, ' ').slice(0, 120));
      throw new Error(`#${id} ficou em "${txt}" — erros: ${erros.slice(0, 3).join(' | ') || 'nenhum'}`);
    }
  };

  // ==================== A. a tabela de listas ====================

  await abrirAba('Campanhas');
  await clicarSub('Listas');
  await esperarTabela('tbListas');

  await t('A1. a contagem de contatos aparece, e nao um traco', async () => {
    const celula = await frame.$eval('#tbListas tr td:nth-child(3)', e => e.textContent.trim());
    assert(celula !== '—' && celula !== '', 'a coluna de contatos veio vazia');
    assert(/15[.,]?595/.test(celula), `veio "${celula}" para uma lista de ${TOTAL_LISTA_1}`);
  });

  await t('A2. a lista diz de qual campanha foi importada', async () => {
    const txt = await frame.$eval('#tbListas tr', e => e.textContent);
    assert(/campanha legado #6/.test(txt), 'a origem da lista não aparece na tabela');
  });

  // ==================== B. o modal, com contato avulso ====================

  await frame.evaluate(() => abrirLista(1));
  await esperarTabela('tbMembros');

  await t('B1. os contatos avulsos aparecem — era o defeito', async () => {
    const linhas = await frame.$$eval('#tbMembros tr', els => els.length);
    assert(linhas === 100, `${linhas} linha(s) de membro; a rota antiga trazia zero`);
  });

  await t('B2. nome e telefone estao VISIVEIS, nao so no DOM', async () => {
    const medida = await frame.$eval('#tbMembros tr td', e => {
      const r = e.getBoundingClientRect();
      return { w: r.width, h: r.height, txt: e.textContent.trim() };
    });
    assert(medida.w > 0 && medida.h > 0, `a célula tem área ${medida.w}x${medida.h}`);
    assert(/CONTATO LEGADO/.test(medida.txt), `a primeira célula diz "${medida.txt}"`);
  });

  await t('B3. o contato sem cadastro e marcado como avulso', async () => {
    const txt = await frame.$eval('#tbMembros tr', e => e.textContent);
    assert(/avulso/.test(txt), 'o vínculo do contato não aparece na linha');
  });

  await t('B3b. o segmento do contato aparece, e quem nao tem ramo e dito', async () => {
    // Sem ramo não há segmento, e a dor por segmento não alcança essa gente.
    const linhas = await frame.$$eval('#tbMembros tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    assert(/bebidas/.test(linhas[0]), `a primeira linha diz "${linhas[0]}"`);
    assert(/sem ramo/.test(linhas[2]), `a terceira linha diz "${linhas[2]}"`);
  });

  await t('B3c. o cabecalho diz quantos tem ramo', async () => {
    const txt = await frame.$eval('#ltTotal', e => e.textContent);
    assert(/com ramo/.test(txt), `o cabeçalho diz "${txt}"`);
  });

  await t('B4. o total da lista aparece no cabecalho do bloco', async () => {
    const txt = await frame.$eval('#ltTotal', e => e.textContent);
    assert(/15[.,]?595/.test(txt), `o total veio como "${txt}"`);
  });

  await t('B5. a paginacao aparece e a pagina 2 pede a pagina 2 ao servidor', async () => {
    const antes = pedidos.length;
    const temBotao = await frame.$eval('#ltPaginacao', e => /Próxima/.test(e.textContent));
    assert(temBotao, 'sem paginação, 15.595 contatos viriam de uma vez');
    await frame.evaluate(() => irPaginaMembros(2));
    await frame.waitForFunction((n) => true, {}, antes);
    await esperar(400);
    assert(pedidos.some(u => /pagina=2/.test(u)), 'a página 2 não chegou ao servidor: ' + pedidos.join(' | '));
  });

  await t('B6. a busca vai ao servidor, e nao filtra so o que ja veio', async () => {
    await frame.evaluate(() => {
      document.getElementById('ltBuscaMembro').value = 'ACHADO';
      buscarMembros();
    });
    await esperar(600);
    assert(pedidos.some(u => /q=ACHADO/.test(u)), 'a busca não chegou ao servidor');
    const txt = await frame.$eval('#tbMembros', e => e.textContent);
    assert(/ACHADO PELA BUSCA/.test(txt), 'o resultado da busca não apareceu');
  });

  await t('B7. lista vazia diz que esta vazia, sem parecer erro', async () => {
    await frame.evaluate(() => abrirLista(2));
    await esperarTabela('tbMembros');
    const txt = await frame.$eval('#tbMembros', e => e.textContent.trim());
    assert(/Lista vazia/.test(txt), `a lista vazia mostra "${txt}"`);
  });

  await t('B8. lista nova abre no bloco de adicionar, sem tabela de membros', async () => {
    await frame.evaluate(() => abrirLista());
    await esperar(300);
    const vis = await frame.$eval('#ltBlocoMembros', e => e.style.display);
    const aberto = await frame.$eval('#ltBlocoAdicionar', e => e.open);
    assert(vis === 'none', 'lista nova mostra a tabela de quem está dentro, que por definição é vazia');
    assert(aberto, 'lista nova abre fechada — quem cria precisa escolher gente já');
  });

  // ==================== C. a lista vinculada à campanha ====================

  await frame.evaluate(() => fechar('modalLista'));
  await clicarSub('Campanhas');
  await esperarTabela('tbCamp');

  await t('C1. a campanha nova mostra o nome da lista vinculada', async () => {
    const txt = await frame.$$eval('#tbCamp tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const linha = txt.find(x => /Aviso de boleto/.test(x));
    assert(/lista: leads-pa-pregao \(legado\)/.test(linha), `a linha diz "${linha}"`);
  });

  await t('C2. clicar na lista da campanha abre a lista certa', async () => {
    await frame.evaluate(() => {
      [...document.querySelectorAll('#tbCamp a')].find(a => /leads-pa-pregao/.test(a.textContent)).click();
    });
    await esperarTabela('tbMembros');
    const aberto = await frame.$eval('#modalLista', e => e.classList.contains('open'));
    const nome = await frame.$eval('#ltNome', e => e.value);
    assert(aberto, 'o modal da lista não abriu pela campanha');
    assert(nome === 'leads-pa-pregao (legado)', `abriu a lista "${nome}"`);
  });

  await t('C3. a campanha legado nao inventa lista nenhuma', async () => {
    // Ela guarda os próprios destinatários e nunca tem lista. Dizer isso em
    // toda linha só somaria textura à coluna Origem, que já a marca como
    // legado — a mesma lição da suíte de inbox.
    await frame.evaluate(() => fechar('modalLista'));
    const txt = await frame.$$eval('#tbCamp tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const linha = txt.find(x => /leads-pa-pregao\b/.test(x) && /legado/.test(x) && !/Aviso/.test(x));
    assert(!/lista:/.test(linha), `a linha da campanha legado fala de lista: "${linha}"`);
  });

  await t('C4. numero e data saem formatados em pt-BR', async () => {
    const txt = await frame.$$eval('#tbCamp tr', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
    const linha = txt.find(x => /leads-pa-pregao\b/.test(x) && !/Aviso/.test(x));
    assert(/15\.468/.test(linha), `o milhar saiu sem ponto: "${linha}"`);
    assert(/14\/08\/2026/.test(linha), `a data saiu fora do formato brasileiro: "${linha}"`);
  });

  await t('D1. nenhum erro de JavaScript nem 404 na tela', () => {
    assert(erros.length === 0, erros.slice(0, 4).join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
