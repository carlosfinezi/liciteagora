#!/usr/bin/env node
/**
 * test-interesse-analise.js — prova o disparo manual da análise IA na tela de
 * Interesses, em Chrome headless, contra um servidor de mentira.
 *
 * POR QUE ESTE TESTE EXISTE, e por que ele não chama IA de verdade: cada
 * análise real baixa o edital no PNCP e consome uma chamada PAGA do provider.
 * Um teste que fizesse isso seria caro a cada execução — e caro é como teste
 * deixa de ser rodado. Aqui o endpoint é falso; o que se prova é o
 * comportamento da TELA: quem ela chama, em que ordem, quantas vezes, o que faz
 * com erro, e se o botão aparece para quem não tem permissão.
 *
 * O ponto mais importante é a ORDEM: o `analise-ia.js` documenta que o WAF do
 * PNCP trava downloads simultâneos do mesmo IP. Se o lote paralelizasse, o
 * defeito apareceria lá dentro, longe daqui. Por isso o servidor registra
 * início e fim de cada chamada e o teste reprova qualquer sobreposição.
 *
 * Uso: node scripts/test-interesse-analise.js
 */

const path = require('path');

const BASE = path.resolve(__dirname, '..');
const express = require(BASE + '/node_modules/express');
const puppeteer = require(BASE + '/node_modules/puppeteer-core');

const CHROME = '/usr/bin/google-chrome';

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 700) : ''}`);
  }
}

function emDias(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T14:30:00`;
}

function item(seq, id, numeroItem, extra = {}) {
  return {
    id, cnpj: `${seq}${seq}${seq}${seq}${seq}${seq}${seq}${seq}00011${seq}`,
    ano: 2026, sequencial: seq, numeroCompra: `9000${seq}`,
    objetoCompra: `Objeto da licitacao ${seq}`,
    nomeOrgao: `Prefeitura ${seq}`, codigoUnidadeCompradora: `${seq}${seq}${seq}${seq}${seq}${seq}`,
    linkSistemaOrigem: '', dataAberturaProposta: emDias(-2),
    dataEncerramentoProposta: emDias(10), grupoNome: '',
    kanbanStatus: null, kanbanDataAtualizacao: null,
    numeroItem, descricao: `Item ${numeroItem} da ${seq}`,
    valorUnitarioEstimado: 100, quantidade: 1,
    temAnalise: 0,            // o que o servidor manda; sobrescrito por `extra`
    ...extra
  };
}

// 4 licitações em aberto + 1 vencida (que o filtro padrão esconde e o lote,
// portanto, não pode tocar).
const MASSA = [
  item(1, 101, 1), item(1, 102, 2),
  item(2, 201, 1),
  item(3, 301, 1),
  item(4, 401, 1),
  item(9, 901, 1, { dataEncerramentoProposta: emDias(-5) }),
];

// Estado do servidor falso, manipulado ao longo do teste.
const estado = {
  massa: null,                  // preenchido com MASSA no boot
  acesso: { success: true, irrestrito: true, paginas: [] },
  jaAnalisadas: new Set(),      // sequenciais que respondem "já tem análise"
  respostaAnalisar: 'ok',       // 'ok' | 'erro502' | 'lento'
  chamadas: [],                 // { seq, inicio, fim }
  gets: [],                     // sequenciais consultados por GET /analise
};

(async () => {
  estado.massa = MASSA;
  const app = express();
  app.use(express.json());

  app.get('/api/interesse', (_q, r) => r.json({ success: true, data: estado.massa }));
  app.get('/api/perfis/meu-acesso', (_q, r) => r.json(estado.acesso));
  app.get('/api/features/status', (_q, r) => r.json({ success: true, features: { licitacoes: true } }));
  app.get('/api/tenant-atual', (_q, r) => r.json({ success: true, tenant: { nome: 'Teste' } }));
  app.get('/api/usuarios/me', (_q, r) => r.json({ success: true, usuario: { nome: 'Fulano' } }));

  app.get('/api/licitacoes/:cnpj/:ano/:seq/analise', (req, res) => {
    const seq = Number(req.params.seq);
    estado.gets.push(seq);
    res.json({
      success: true,
      analise: estado.jaAnalisadas.has(seq) ? { id: seq, resumo: 'análise anterior' } : null
    });
  });

  app.post('/api/licitacoes/:cnpj/:ano/:seq/analisar', async (req, res) => {
    const seq = Number(req.params.seq);
    const registro = { seq, inicio: Date.now(), fim: 0 };
    estado.chamadas.push(registro);
    // Demora de verdade: sem ela, chamadas paralelas terminariam tão rápido que
    // a sobreposição não apareceria na medição.
    const espera = estado.respostaAnalisar === 'lento' ? 5000 : 120;
    await new Promise(r => setTimeout(r, espera));
    registro.fim = Date.now();
    if (estado.respostaAnalisar === 'erro502') {
      return res.status(502).json({ success: false, error: 'Falha nos providers de IA. Verifique as chaves.' });
    }
    res.json({ success: true, analise: { id: seq, resumo: 'nova análise' } });
  });

  app.use(express.static(path.join(BASE, 'public')));
  app.get('/wrap', (req, res) => res.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell=true;</script></head>
     <body style="margin:0"><iframe src="${String(req.query.p || '')}" style="width:100vw;height:100vh;border:0"></iframe></body></html>`));

  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const porta = servidor.address().port;
  const URL_TELA = `http://127.0.0.1:${porta}/wrap?p=/licitacoes/interesse.html`;

  const navegador = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/interesse-ia-chrome-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const errosJs = [];
  const page = await navegador.newPage();
  page.on('pageerror', e => errosJs.push(String(e.message)));
  page.on('dialog', d => d.accept().catch(() => {}));   // o lote confirma antes de rodar

  const abrirTela = async () => {
    await page.goto(URL_TELA, { waitUntil: 'networkidle2', timeout: 25000 });
    const f = page.frames().find(x => x !== page.mainFrame() && x.url().includes('interesse.html'));
    await f.waitForSelector('#interessesContainer .card', { timeout: 10000 });
    return f;
  };

  // ── 1. permissão: o botão não existe para quem tomaria 403 ─────────────────
  console.log('\n── permissão (RBAC fail-closed em /api/licitacoes)');
  {
    estado.acesso = { success: true, irrestrito: false, paginas: ['interesse'] };
    const f = await abrirTela();
    const r = await f.evaluate(() => ({
      card: document.querySelectorAll('.btn-ia').length,
      links: document.querySelectorAll('.btn-ia-link').length,
      lote: getComputedStyle(document.getElementById('btnAnalisarLote')).display,
      pode: iaPodeAnalisar,
    }));
    assert(r.pode === false, 'perfil com acesso só a "interesse" NÃO pode analisar', r);
    assert(r.card === 0, 'nenhum botão de DISPARAR análise nos cards', r);
    assert(r.links === 4, 'mas o link para VER a análise continua nos 4 cards', r);
    assert(r.lote === 'none', 'o botão de lote fica escondido', r);

    // A tela em si continua inteira — esconder o botão não pode quebrar o resto.
    const cards = await f.evaluate(() => document.querySelectorAll('#interessesContainer .card').length);
    assert(cards === 4, 'a lista continua renderizando as 4 licitações em aberto', cards);
  }

  {
    estado.acesso = { success: true, irrestrito: false, paginas: ['interesse', 'consulta'] };
    const f = await abrirTela();
    const r = await f.evaluate(() => ({ pode: iaPodeAnalisar, card: document.querySelectorAll('.btn-ia').length }));
    assert(r.pode === true && r.card === 4,
      'quem tem a página "consulta" (que libera o prefixo) vê os botões', r);
  }

  // ── 1b. UM botão só, com três estados ──────────────────────────────────────
  // O pedido que originou este bloco: a tela mostrava "Analisar IA" e
  // "Análise IA" lado a lado, e cabia ao usuário saber qual valia.
  console.log('\n── botão unificado');
  {
    estado.acesso = { success: true, irrestrito: true, paginas: [] };
    estado.massa = [
      item(11, 1101, 1, { temAnalise: 0 }),          // nunca analisada
      item(12, 1201, 1, { temAnalise: 1 }),          // já tem análise
      item(13, 1301, 1, { temAnalise: undefined }),  // servidor ainda sem o campo
    ];
    const f = await abrirTela();

    const r = await f.evaluate(() => {
      const por = (seq) => {
        const el = document.querySelector(`.btn-ia[data-lic-key$="-2026-${seq}"], .btn-ia-link[data-lic-key$="-2026-${seq}"]`);
        return el ? { tag: el.tagName, classe: el.className, texto: el.innerText.trim(), href: el.getAttribute('href') } : null;
      };
      return {
        semAnalise: por(11), comAnalise: por(12), desconhecido: por(13),
        totalPorCard: Array.from(document.querySelectorAll('#interessesContainer .card'))
          .map(c => c.querySelectorAll('.btn-ia, .btn-ia-link').length),
      };
    });

    assert(r.totalPorCard.every(n => n === 1),
      'cada card tem UM controle de análise, nunca dois', r.totalPorCard);

    assert(r.semAnalise.tag === 'BUTTON' && /Analisar IA/.test(r.semAnalise.texto),
      'sem análise: o botão roda a análise', r.semAnalise);

    assert(r.comAnalise.tag === 'A' && /Análise IA/.test(r.comAnalise.texto) &&
           /analises-ia\.html\?pncp=/.test(r.comAnalise.href),
      'com análise: vira link para o resultado', r.comAnalise);

    // A janela entre salvar o front e reiniciar o servidor: sem o campo, não se
    // sabe se há análise — e gastar chamada paga no escuro seria pior.
    assert(r.desconhecido.tag === 'A',
      'campo ausente (servidor não reiniciado): cai no link, não no gasto', r.desconhecido);
  }

  // ── 1c. analisada na hora, o botão vira link ───────────────────────────────
  console.log('\n── depois de analisar, o botão troca de papel');
  {
    estado.chamadas = [];
    const f = await abrirTela();
    const r = await f.evaluate(async () => {
      const btn = document.querySelector('.btn-ia[data-lic-key$="-2026-11"]');
      await analisarIa(btn.dataset.licKey, btn);
      const agora = document.querySelector('.btn-ia[data-lic-key$="-2026-11"], .btn-ia-link[data-lic-key$="-2026-11"]');
      return {
        tag: agora.tagName, texto: agora.innerText.trim(), href: agora.getAttribute('href'),
        quantos: document.querySelectorAll('.btn-ia[data-lic-key$="-2026-11"], .btn-ia-link[data-lic-key$="-2026-11"]').length,
        estadoNaMemoria: todasLicitacoes.find(l => l.sequencial === 11).temAnalise,
      };
    });
    assert(r.tag === 'A' && /Análise IA/.test(r.texto),
      'o botão de analisar vira o link de ver, sem recarregar a tela', r);
    assert(r.quantos === 1, 'e continua sendo UM controle só', r);
    assert(r.estadoNaMemoria === 1,
      'a licitação em memória passa a constar como analisada', r.estadoNaMemoria);

    estado.massa = MASSA;   // devolve a massa padrão para os blocos seguintes
  }

  // ── 2. uma licitação ───────────────────────────────────────────────────────
  console.log('\n── análise de uma licitação');
  {
    estado.acesso = { success: true, irrestrito: true, paginas: [] };
    estado.chamadas = [];
    const f = await abrirTela();

    const r = await f.evaluate(async () => {
      const btn = document.querySelector('.btn-ia[data-lic-key$="-2026-2"]');
      const promessa = analisarIa(btn.dataset.licKey, btn);
      // Estado intermediário: o clique precisa dizer que algo está acontecendo.
      const durante = { texto: btn.innerHTML, desabilitado: btn.disabled };
      await promessa;
      const noCard = document.querySelector('.btn-ia[data-lic-key$="-2026-2"], .btn-ia-link[data-lic-key$="-2026-2"]');
      return {
        durante,
        depoisTag: noCard ? noCard.tagName : null,
        depoisTexto: noCard ? noCard.innerText.trim() : null,
        faixa: document.getElementById('iaFaixa') ? document.getElementById('iaFaixa').innerText : null,
      };
    });

    assert(/Analisando/.test(r.durante.texto) && r.durante.desabilitado === true,
      'durante a chamada o botão avisa e trava (não dá para clicar duas vezes)', r.durante);
    assert(estado.chamadas.length === 1 && estado.chamadas[0].seq === 2,
      'chamou a análise UMA vez, da licitação certa', estado.chamadas.map(c => c.seq));
    assert(r.depoisTag === 'A' && /Análise IA/.test(r.depoisTexto),
      'ao terminar, o controle do card passa a ser o link para o resultado', r);
    assert(/concluída/i.test(r.faixa) && /Análise IA/.test(r.faixa),
      'a faixa avisa e aponta o caminho do resultado (o link que já existia)', r.faixa);
  }

  // ── 3. erro do provider ────────────────────────────────────────────────────
  console.log('\n── erro do provider');
  {
    estado.respostaAnalisar = 'erro502';
    estado.chamadas = [];
    const f = await abrirTela();
    const r = await f.evaluate(async () => {
      const btn = document.querySelector('.btn-ia[data-lic-key$="-2026-3"]');
      const antes = btn.innerHTML;   // o botão sobrevive ao erro, e é isso que se checa
      await analisarIa(btn.dataset.licKey, btn);
      return {
        antes, depois: btn.innerHTML, habilitado: !btn.disabled,
        faixa: document.getElementById('iaFaixa').innerText,
      };
    });
    assert(/Falha nos providers de IA/.test(r.faixa),
      'a mensagem REAL do servidor chega ao usuário, não um "erro" genérico', r.faixa);
    assert(r.depois === r.antes && r.habilitado,
      'o botão volta ao normal para poder tentar de novo', r);
    estado.respostaAnalisar = 'ok';
  }

  // ── 4. prazo: a espera não pode ser eterna ─────────────────────────────────
  console.log('\n── prazo máximo');
  {
    estado.respostaAnalisar = 'lento';   // servidor leva 5s
    const f = await abrirTela();
    const r = await f.evaluate(async () => {
      IA_TIMEOUT_MS = 300;               // encurta só para provar a guarda
      const btn = document.querySelector('.btn-ia[data-lic-key$="-2026-4"]');
      const t0 = Date.now();
      await analisarIa(btn.dataset.licKey, btn);
      return {
        ms: Date.now() - t0,
        habilitado: !btn.disabled,
        faixa: document.getElementById('iaFaixa').innerText,
      };
    });
    assert(r.ms < 3000, 'desiste no prazo em vez de esperar o servidor lento', r.ms);
    assert(/tempo esgotado/.test(r.faixa), 'e diz que foi tempo esgotado', r.faixa);
    assert(r.habilitado, 'o botão volta a funcionar depois do prazo estourado');
    estado.respostaAnalisar = 'ok';
  }

  // ── 5. lote ────────────────────────────────────────────────────────────────
  console.log('\n── lote');
  {
    estado.chamadas = [];
    estado.gets = [];
    estado.jaAnalisadas = new Set([2]);   // a licitação 2 já tem análise
    const f = await abrirTela();

    const faixa = await f.evaluate(async () => {
      await analisarIaLote();
      return document.getElementById('iaFaixa').innerText;
    });

    const seqs = estado.chamadas.map(c => c.seq);
    assert(seqs.length === 3, 'analisou 3 das 4 (a que já tinha análise foi pulada)', seqs);
    assert(!seqs.includes(2), 'a licitação com análise anterior NÃO foi reanalisada', seqs);
    assert(!seqs.includes(9), 'a vencida, fora do filtro da tela, não entrou no lote', seqs);
    assert(estado.gets.includes(2), 'o lote consultou antes de gastar chamada', estado.gets);

    // Sequencial de verdade: nenhuma chamada começa antes de a anterior acabar.
    //
    // A checagem de `fim > 0` vem PRIMEIRO e não é formalidade: sem ela, um lote
    // que dispara tudo sem esperar passaria — as chamadas ainda estariam em voo,
    // com `fim` zerado, e comparar contra 0 nunca acusa sobreposição. Medido:
    // com o lote paralelizado de propósito, era exatamente assim que este bloco
    // passava verde.
    const emVoo = estado.chamadas.filter(c => c.fim === 0);
    assert(emVoo.length === 0,
      'o lote só se dá por encerrado depois que TODAS as chamadas voltaram',
      emVoo.map(c => c.seq));

    const ordenadas = [...estado.chamadas].filter(c => c.fim > 0).sort((a, b) => a.inicio - b.inicio);
    const sobrepostas = ordenadas.filter((c, i) => i > 0 && c.inicio < ordenadas[i - 1].fim);
    assert(ordenadas.length === estado.chamadas.length && sobrepostas.length === 0,
      'as chamadas não se sobrepõem — o WAF do PNCP trava download simultâneo',
      ordenadas.map(c => ({ seq: c.seq, dur: c.fim - c.inicio })));

    const resumo = faixa.replace(/\s+/g, ' ').trim();
    assert(/^3 analisada\(s\) · 1 já tinha\(m\) análise · 0 com erro/.test(resumo),
      'o resumo final dá os três números exatos: 3 analisadas, 1 pulada, 0 erros', resumo);
  }

  // ── 6. lote respeita a seleção ─────────────────────────────────────────────
  console.log('\n── lote com seleção');
  {
    estado.chamadas = [];
    estado.jaAnalisadas = new Set();
    const f = await abrirTela();
    const resumoSel = await f.evaluate(async () => {
      // Marca só os itens da licitação 3.
      const lic = todasLicitacoes.find(l => l.sequencial === 3);
      lic.itens.forEach(i => selectedIds.add(i.id));
      updateSelectionUI();
      await analisarIaLote();
      return document.getElementById('iaFaixa').innerText.replace(/\s+/g, ' ').trim();
    });
    assert(estado.chamadas.length === 1 && estado.chamadas[0].seq === 3,
      'com itens marcados, o lote analisa só a licitação marcada',
      estado.chamadas.map(c => c.seq));
    assert(/^1 analisada\(s\) · 0 já tinha\(m\) análise · 0 com erro/.test(resumoSel),
      'e o resumo confirma exatamente 1 analisada, 0 puladas, 0 erros', resumoSel);
  }

  // ── 7. parar no meio ───────────────────────────────────────────────────────
  console.log('\n── interromper');
  {
    estado.chamadas = [];
    estado.jaAnalisadas = new Set();
    estado.respostaAnalisar = 'lento';   // 5s por chamada, dá tempo de parar
    const f = await abrirTela();
    const r = await f.evaluate(async () => {
      IA_TIMEOUT_MS = 240000;
      const promessa = analisarIaLote();
      await new Promise(r => setTimeout(r, 600));    // deixa a primeira começar
      const temBotaoParar = /Parar/.test(document.getElementById('iaFaixa').innerHTML);
      iaPararLote();
      await promessa;
      return { temBotaoParar, faixa: document.getElementById('iaFaixa').innerText, rodando: iaLoteRodando };
    });
    assert(r.temBotaoParar, 'enquanto roda, a faixa oferece o botão Parar');
    assert(estado.chamadas.length === 1,
      'parar interrompe: só a que já estava em voo foi chamada', estado.chamadas.map(c => c.seq));
    assert(/interrompido/.test(r.faixa), 'o resumo final diz que foi interrompido', r.faixa);
    assert(r.rodando === false, 'e o estado de "rodando" é liberado');
    estado.respostaAnalisar = 'ok';
  }

  assert(errosJs.length === 0, 'nenhum erro de JavaScript na página inteira', errosJs);

  await navegador.close();
  servidor.close();

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${ok} ok, ${fail} falha(s)`);
  if (fail) { falhas.forEach(f => console.error('   - ' + f)); process.exit(1); }
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
