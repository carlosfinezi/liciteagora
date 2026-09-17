#!/usr/bin/env node
/**
 * test-interesse-relatorio.js — prova o relatório da tela de Interesses
 * (CSV, PDF e impressão) em Chrome headless, contra massa de valor conhecido.
 *
 * POR QUE EXISTE: `npm run verify` roda `node --check` só nos .js da raiz e de
 * scripts/ — nada de `public/` entra, e um arquivo estático já está no ar no
 * instante em que é salvo. Além disso, um relatório que some errado passa em
 * qualquer checagem de sintaxe: aqui os totais são conferidos contra números
 * calculados à mão.
 *
 * A massa é servida por um Express de mentira nesta mesma execução — nenhum
 * banco é aberto, nenhum tenant é tocado.
 *
 *   Licitação A (prazo hoje+10): item 1 = 2 × 100,00 = 200,00
 *                                item 2 = 3 ×  50,00 = 150,00   → 350,00
 *   Licitação B (prazo hoje-5):  item 1 = 1 × 1000,00           → 1.000,00
 *   Licitação C (sem prazo):     item 5 = 10 ×   7,50           →    75,00
 *
 *   filtro "Em aberto" (padrão) → A e C  = 2 licitações, 3 itens,   R$ 425,00
 *   filtro "Todos os prazos"    → A, B, C = 3 licitações, 4 itens, R$ 1.425,00
 *
 * Uso: node scripts/test-interesse-relatorio.js
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

// Cada linha aqui é o que `/api/interesse` devolve: item já achatado com os
// dados da licitação. Os textos carregam de propósito ponto-e-vírgula, VÍRGULA,
// aspas e sinal de menor — os venenos do CSV e do HTML. A vírgula e o
// ponto-e-vírgula estão em campos diferentes de propósito: cada um quebra a
// coluna em UM dos dois idiomas (pt separa por ';', en por ',').
function colunasCsv(linha, sep) {
  const out = [];
  let atual = '';
  let dentroDeAspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (linha[i + 1] === '"') { atual += '"'; i++; } else { dentroDeAspas = false; }
      } else atual += c;
    } else if (c === '"') dentroDeAspas = true;
    else if (c === sep) { out.push(atual); atual = ''; }
    else atual += c;
  }
  out.push(atual);
  return out;
}

const MASSA = [
  {
    id: 101, cnpj: '11111111000111', ano: 2026, sequencial: 1, numeroCompra: '90001',
    objetoCompra: 'Aquisicao de notebooks; monitores e perifericos',
    nomeOrgao: 'Prefeitura Alfa', codigoUnidadeCompradora: '111111',
    linkSistemaOrigem: '', dataAberturaProposta: emDias(-2), dataEncerramentoProposta: emDias(10),
    grupoNome: 'Informatica', kanbanStatus: null, kanbanDataAtualizacao: null,
    numeroItem: 1, descricao: 'Notebook 16GB', valorUnitarioEstimado: 100, quantidade: 2
  },
  {
    id: 102, cnpj: '11111111000111', ano: 2026, sequencial: 1, numeroCompra: '90001',
    objetoCompra: 'Aquisicao de notebooks; monitores e perifericos',
    nomeOrgao: 'Prefeitura Alfa', codigoUnidadeCompradora: '111111',
    linkSistemaOrigem: '', dataAberturaProposta: emDias(-2), dataEncerramentoProposta: emDias(10),
    grupoNome: 'Informatica', kanbanStatus: null, kanbanDataAtualizacao: null,
    numeroItem: 2, descricao: 'Cabo HDMI <2m> "reforcado"', valorUnitarioEstimado: 50, quantidade: 3
  },
  {
    id: 201, cnpj: '22222222000122', ano: 2026, sequencial: 2, numeroCompra: '90002',
    objetoCompra: 'Servico de limpeza',
    nomeOrgao: 'Prefeitura Beta', codigoUnidadeCompradora: '222222',
    linkSistemaOrigem: '', dataAberturaProposta: emDias(-20), dataEncerramentoProposta: emDias(-5),
    grupoNome: '', kanbanStatus: null, kanbanDataAtualizacao: null,
    numeroItem: 1, descricao: 'Posto de limpeza 44h', valorUnitarioEstimado: 1000, quantidade: 1
  },
  {
    id: 301, cnpj: '33333333000133', ano: 2026, sequencial: 3, numeroCompra: '90003',
    objetoCompra: 'Material de expediente, limpeza e copa',
    nomeOrgao: 'Prefeitura Gama', codigoUnidadeCompradora: '333333',
    linkSistemaOrigem: '', dataAberturaProposta: null, dataEncerramentoProposta: null,
    grupoNome: 'Informatica', kanbanStatus: null, kanbanDataAtualizacao: null,
    numeroItem: 5, descricao: 'Resma A4', valorUnitarioEstimado: 7.5, quantidade: 10
  }
];

(async () => {
  const app = express();
  app.use(express.json());

  app.get('/api/interesse', (_req, res) => res.json({ success: true, data: MASSA }));
  app.get('/api/tenant-atual', (_req, res) =>
    res.json({ success: true, tenant: { nome: 'Empresa de Teste LTDA', slug: 'teste' } }));
  app.get('/api/features/status', (_req, res) =>
    res.json({ success: true, features: { licitacoes: true } }));
  app.get('/api/perfis/meu-acesso', (_req, res) => res.json({ success: true, irrestrito: true }));
  app.get('/api/usuarios/me', (_req, res) =>
    res.json({ success: true, usuario: { nome: 'Fulano', username: 'fulano' } }));

  app.use(express.static(path.join(BASE, 'public')));

  // sidebar.js manda qualquer carga top-level para /app.html#... — a tela só
  // roda de verdade dentro do iframe do shell.
  app.get('/wrap', (req, res) => {
    const p = String(req.query.p || '');
    res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8">
      <script>window.__liciteShell = true;</script></head>
      <body style="margin:0"><iframe id="f" src="${p}" style="width:100vw;height:100vh;border:0"></iframe></body></html>`);
  });

  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const porta = servidor.address().port;

  const navegador = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    // Perfil próprio em /tmp: NUNCA os perfis dos session-services do BLL/BNC.
    userDataDir: `/tmp/interesse-rel-chrome-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await navegador.newPage();
  const errosJs = [];
  page.on('pageerror', e => errosJs.push(String(e.message)));
  page.on('dialog', d => d.dismiss().catch(() => {}));

  await page.goto(`http://127.0.0.1:${porta}/wrap?p=/licitacoes/interesse.html`,
    { waitUntil: 'networkidle2', timeout: 25000 });

  const frame = page.frames().find(f => f !== page.mainFrame() && f.url().includes('interesse.html'));
  if (!frame) {
    console.error('✗ o iframe da tela não carregou — nada mais pode ser conferido');
    await navegador.close(); servidor.close(); process.exit(1);
  }

  await frame.waitForSelector('#interessesContainer .card', { timeout: 10000 });

  // Os stubs de captura: nada de download real nem de janela de impressão.
  await frame.evaluate(() => {
    window.__alertas = [];
    window.alert = (m) => window.__alertas.push(String(m));

    window.__blobs = [];
    const origCreate = URL.createObjectURL;
    URL.createObjectURL = (b) => { window.__blobs.push(b); return origCreate.call(URL, b); };

    window.__clicouDownload = 0;
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__clicouDownload++; return; }   // não baixa de verdade
      return origClick.call(this);
    };

    window.__htmlImpresso = '';
    window.open = () => ({
      document: {
        write: (h) => { window.__htmlImpresso += h; },
        close: () => {}
      },
      focus: () => {},
      print: () => {}
    });
  });

  // Devolve o texto E os três primeiros bytes: `Blob.text()` decodifica em
  // UTF-8 e COME o BOM, então o texto sozinho não prova que ele foi escrito.
  const capturarCSV = (nivel, idioma = 'pt') => frame.evaluate(async ([nv, lg]) => {
    document.querySelector(`input[name="relNivel"][value="${nv}"]`).checked = true;
    document.querySelector(`input[name="relIdioma"][value="${lg}"]`).checked = true;
    window.__blobs.length = 0;
    relBaixarCSV();
    const b = window.__blobs[window.__blobs.length - 1];
    if (!b) return null;
    const bytes = Array.from(new Uint8Array(await b.arrayBuffer()).slice(0, 3));
    return { texto: await b.text(), bytes };
  }, [nivel, idioma]);

  // ── 1. a tela em si, antes do relatório ────────────────────────────────────
  console.log('\n── tela carregada (filtro padrão "Em aberto")');
  {
    const kpi = await frame.evaluate(() => ({
      lic: document.getElementById('totalLicitacoes').textContent,
      itens: document.getElementById('totalItens').textContent,
      valor: document.getElementById('valorTotal').textContent,
    }));
    assert(kpi.lic === '2', 'KPI mostra 2 licitações (a vencida ficou de fora)', kpi);
    assert(kpi.itens === '3', 'KPI mostra 3 itens', kpi);
    assert(/425,00/.test(kpi.valor), 'KPI mostra R$ 425,00', kpi);

    const filtradas = await frame.evaluate(() => licitacoesFiltradas.length);
    assert(filtradas === 2, 'licitacoesFiltradas acompanha o que está na tela', filtradas);
  }

  // ── 2. o modal declara o escopo antes de gerar ─────────────────────────────
  console.log('\n── modal');
  {
    const info = await frame.evaluate(() => {
      relAbrirModal();
      return {
        aberto: document.getElementById('modalRelatorio').classList.contains('open'),
        texto: document.getElementById('relEscopoInfo').textContent,
      };
    });
    assert(info.aberto, 'o modal abre');
    assert(/2 licitações/.test(info.texto) && /3 itens/.test(info.texto) && /425,00/.test(info.texto),
      'o modal anuncia o escopo real antes de gerar', info.texto);
    assert(/2 linhas/.test(info.texto), 'resumo anuncia 2 linhas (uma por licitação)', info.texto);

    const det = await frame.evaluate(() => {
      document.querySelector('input[name="relNivel"][value="detalhado"]').checked = true;
      relAtualizarEscopo();
      return document.getElementById('relEscopoInfo').textContent;
    });
    assert(/3 linhas/.test(det), 'detalhado anuncia 3 linhas (uma por item)', det);
  }

  // ── 3. CSV resumo ──────────────────────────────────────────────────────────
  console.log('\n── CSV resumo por licitação');
  {
    const out = await capturarCSV('resumo');
    assert(!!out, 'o CSV foi gerado');
    const csv = out.texto;
    const linhas = csv.trim().split('\r\n');
    assert(String(out.bytes) === '239,187,191',
      'os três primeiros bytes são o BOM EF BB BF (senão o Excel come os acentos)', out.bytes);
    assert(linhas.length === 3, 'cabeçalho + 2 licitações', linhas.length);
    assert(linhas[0].split(';').length === 10, 'cabeçalho com as 10 colunas do resumo', linhas[0]);

    const soma = linhas.slice(1)
      .map(l => l.split(';').pop())
      .reduce((s, v) => s + parseFloat(String(v).replace(',', '.')), 0);
    assert(Math.abs(soma - 425) < 0.001, 'a coluna Valor total soma 425,00', soma);

    assert(/Prefeitura Alfa/.test(csv) && /Prefeitura Gama/.test(csv),
      'traz as duas licitações em aberto');
    assert(!/Prefeitura Beta/.test(csv),
      'NÃO traz a licitação vencida — o relatório obedece o filtro da tela');

    // O objeto da licitação A tem ';' no meio: sem aspas, ele viraria coluna nova.
    assert(/"Aquisicao de notebooks; monitores e perifericos"/.test(csv),
      'campo com ponto-e-vírgula sai entre aspas');
    const colunasPorLinha = linhas.map(l => (l.match(/(^|;)(?=(?:[^"]|"[^"]*")*$)/g) || []).length);
    assert(colunasPorLinha.every(n => n === colunasPorLinha[0]),
      'todas as linhas têm o mesmo número de colunas', colunasPorLinha);
  }

  // ── 4. CSV detalhado ───────────────────────────────────────────────────────
  console.log('\n── CSV detalhado por item');
  {
    const csv = (await capturarCSV('detalhado')).texto;
    const linhas = csv.trim().split('\r\n');
    assert(linhas.length === 4, 'cabeçalho + 3 itens', linhas.length);

    const soma = linhas.slice(1)
      .map(l => l.split(';').pop())
      .reduce((s, v) => s + parseFloat(String(v).replace(',', '.')), 0);
    assert(Math.abs(soma - 425) < 0.001,
      'a soma por item bate com a soma por licitação (425,00)', soma);

    assert(/;200,00$/m.test(csv) && /;150,00$/m.test(csv) && /;75,00$/m.test(csv),
      'os três totais de item saem certos: 200,00 / 150,00 / 75,00');
    assert(/;7,50;/.test(csv), 'valor unitário com decimal em vírgula (7,50)');
    assert(!/R\$/.test(csv), 'CSV sai sem "R$" — o Excel precisa do número, não do rótulo');
    assert(/"Cabo HDMI <2m> ""reforcado"""/.test(csv), 'aspas internas são duplicadas');
  }

  // ── 5. impressão ───────────────────────────────────────────────────────────
  console.log('\n── impressão');
  {
    const html = await frame.evaluate(async () => {
      document.querySelector('input[name="relNivel"][value="detalhado"]').checked = true;
      window.__htmlImpresso = '';
      await relImprimir();
      return window.__htmlImpresso;
    });
    assert(/<table/.test(html), 'gerou a folha com tabela');
    const linhasCorpo = (html.split('<tbody>')[1] || '').split('<tr>').length - 1;
    assert(linhasCorpo === 3, 'a folha tem 3 linhas de item', linhasCorpo);
    assert(/Empresa de Teste LTDA/.test(html), 'o cabeçalho identifica a empresa');
    assert(/Prazo: Em aberto/.test(html), 'o cabeçalho diz qual filtro estava valendo');
    assert(/R\$&nbsp;425,00|R\$ 425,00/.test(html.replace(/\u00a0/g, ' ')),
      'o cabeçalho traz o total de R$ 425,00');
    assert(/Cabo HDMI &lt;2m&gt;/.test(html),
      'o "<" da descrição foi escapado (senão vira tag e some da folha)');
    assert(/onload="window\.print\(\)"/.test(html), 'a folha chama a impressão sozinha');
  }

  // ── 6. PDF ─────────────────────────────────────────────────────────────────
  console.log('\n── PDF');
  {
    const r = await frame.evaluate(async () => {
      document.querySelector('input[name="relNivel"][value="resumo"]').checked = true;
      window.__alertas.length = 0;
      window.__blobs.length = 0;
      const temLib = !!(window.jspdf && window.jspdf.jsPDF);
      await relGerarPDF();
      const blob = window.__blobs[window.__blobs.length - 1];
      let cabecalho = '';
      if (blob) cabecalho = (await blob.text()).slice(0, 5);
      return { temLib, alertas: window.__alertas.slice(), tamanho: blob ? blob.size : 0, cabecalho };
    });

    // A fonte padrão do jsPDF é WinAnsi: a seta da ordenação saía como "!'" no
    // papel — lixo silencioso, que ninguém lê como erro de código.
    const saneado = await frame.evaluate(() => ({
      seta: relPdfTexto('Ordem: Encerramento ↑'),
      fora: relPdfTexto('Objeto ✅ com emoji'),
      acento: relPdfTexto('Licitação nº 1 — órgão “aspas” ½'),
      titulo: relPdfTexto(relMontar('detalhado').titulo),
    }));
    assert(saneado.seta === 'Ordem: Encerramento (cresc.)', 'a seta da ordenação vira texto', saneado.seta);
    assert(!/[^ -ÿ]/.test(saneado.fora), 'caractere fora do WinAnsi não chega ao PDF', saneado.fora);
    assert(saneado.acento === 'Licitação nº 1 — órgão “aspas” ½',
      'acento, º, travessão e aspas curvas passam intactos (estão no WinAnsi)', saneado.acento);
    assert(saneado.titulo === 'Interesses — detalhado por item',
      'o próprio título do relatório chega inteiro ao PDF', saneado.titulo);

    if (r.temLib) {
      assert(r.alertas.length === 0, 'gerou sem reclamar', r.alertas);
      assert(r.tamanho > 1000, 'o arquivo tem conteúdo de verdade', r.tamanho);
      assert(r.cabecalho === '%PDF-', 'é um PDF de fato', r.cabecalho);
    } else {
      // Sem internet o jsPDF não chega — e aí o que se prova é a guarda.
      assert(r.alertas.length === 1 && /CSV|Imprimir/.test(r.alertas[0]),
        'sem a lib de CDN, avisa e aponta a saída alternativa (não falha calado)', r.alertas);
      console.log('  ⚠ jsPDF não carregou (CDN fora do ar ou sem internet): o PDF em si não foi provado');
    }
  }

  // ── 7. mudar o filtro muda o relatório ─────────────────────────────────────
  console.log('\n── o relatório segue a tela');
  {
    await frame.evaluate(() => {
      document.getElementById('filtroPeriodo').value = 'todas';
      aplicarFiltro();
    });
    const csv = (await capturarCSV('resumo')).texto;
    const linhas = csv.trim().split('\r\n');
    assert(linhas.length === 4, 'com "Todos os prazos" saem as 3 licitações', linhas.length);
    assert(/Prefeitura Beta/.test(csv), 'a vencida agora entra');

    const soma = linhas.slice(1)
      .map(l => l.split(';').pop())
      .reduce((s, v) => s + parseFloat(String(v).replace(',', '.')), 0);
    assert(Math.abs(soma - 1425) < 0.001, 'o total passa a 1.425,00', soma);

    // Filtro por órgão, que é o outro eixo da tela.
    const csvBeta = await frame.evaluate(async () => {
      const sel = document.getElementById('filtroOrgao');
      sel.value = 'Prefeitura Beta';
      aplicarFiltro();
      document.querySelector('input[name="relNivel"][value="resumo"]').checked = true;
      window.__blobs.length = 0;
      relBaixarCSV();
      const b = window.__blobs[window.__blobs.length - 1];
      return b ? await b.text() : null;
    });
    const lb = String(csvBeta).replace(/^\ufeff/, '').trim().split('\r\n');
    assert(lb.length === 2 && /Prefeitura Beta/.test(csvBeta) && !/Prefeitura Alfa/.test(csvBeta),
      'filtrando por órgão, o relatório sai só daquele órgão', lb.length);
    assert(/Órgão: Prefeitura Beta/.test(await frame.evaluate(() => relDescricaoFiltro('pt'))),
      'o cabeçalho registra o filtro de órgão');
  }

  // ── 7b. o mesmo relatório em inglês ────────────────────────────────────────
  // Os números têm de ser OS MESMOS; o que muda é rótulo, formato e separador.
  console.log('\n── versão em inglês');
  {
    await frame.evaluate(() => {
      document.getElementById('filtroOrgao').value = '';
      document.getElementById('filtroPeriodo').value = 'ativas';
      aplicarFiltro();
    });

    const out = await capturarCSV('resumo', 'en');
    const csv = out.texto;
    const linhas = csv.trim().split('\r\n');
    const cab = colunasCsv(linhas[0], ',');

    assert(String(out.bytes) === '239,187,191', 'o CSV em inglês também leva BOM', out.bytes);
    assert(cab.length === 10, 'cabeçalho em inglês com 10 colunas separadas por vírgula', cab);
    assert(cab[0] === 'Agency' && cab[2] === 'Tender no.' && cab[9] === 'Total value',
      'os rótulos estão em inglês', cab);
    assert(linhas.length === 3, 'mesmo recorte da tela: 2 licitações', linhas.length);

    const corpo = linhas.slice(1).map(l => colunasCsv(l, ','));
    const soma = corpo.reduce((s, c) => s + parseFloat(c[9]), 0);
    assert(Math.abs(soma - 425) < 0.001,
      'o total em inglês é o MESMO número do relatório em português (425)', soma);
    assert(corpo.some(c => c[9] === '350.00') && corpo.some(c => c[9] === '75.00'),
      'decimal com ponto, sem separador de milhar, para o Excel en-US ler como número',
      corpo.map(c => c[9]));
    assert(!/R\$|BRL/.test(csv), 'o CSV segue sem rótulo de moeda nos dois idiomas');

    // O campo com vírgula só quebra coluna aqui — em pt ele passa sem aspas.
    assert(/"Material de expediente, limpeza e copa"/.test(csv),
      'campo com vírgula sai entre aspas no CSV em inglês');
    const csvPt = (await capturarCSV('resumo', 'pt')).texto;
    assert(/;Material de expediente, limpeza e copa;/.test(csvPt),
      'e o MESMO campo não é aspeado em português, onde a vírgula não separa nada');

    // Datas: ISO nos dois campos de data.
    const alfa = corpo.find(c => c[0] === 'Prefeitura Alfa');
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(alfa[6]),
      'encerramento em formato ISO (aaaa-mm-dd hh:mm)', alfa[6]);
    assert(alfa[7] === 'Closes in 10 days', 'a situação do prazo vem em inglês', alfa[7]);
    const gama = corpo.find(c => c[0] === 'Prefeitura Gama');
    assert(gama[6] === 'Not informed' && gama[7] === 'No deadline',
      'ausência de prazo também em inglês', [gama[6], gama[7]]);

    // pt e en descrevem o MESMO instante — trocar o idioma não pode deslocar a hora.
    const cruzado = await frame.evaluate(() => {
      const ptLinha = relMontar('resumo', 'pt').linhas.find(l => l[0] === 'Prefeitura Alfa');
      const enLinha = relMontar('resumo', 'en').linhas.find(l => l[0] === 'Prefeitura Alfa');
      return { pt: ptLinha[6], en: enLinha[6], ptValor: ptLinha[9], enValor: enLinha[9] };
    });
    const mPt = cruzado.pt.match(/(\d{2})\/(\d{2})\/(\d{4}),? (\d{2}):(\d{2})/);
    const isoDoPt = mPt && `${mPt[3]}-${mPt[2]}-${mPt[1]} ${mPt[4]}:${mPt[5]}`;
    assert(isoDoPt === cruzado.en,
      'a data em pt e em en é o mesmo instante, só reordenado', cruzado);
    assert(cruzado.ptValor === cruzado.enValor,
      'o valor cru é literalmente o mesmo número nos dois idiomas (a formatação é que muda)',
      cruzado);

    const filtro = await frame.evaluate(() => relDescricaoFiltro('en'));
    assert(/Deadline: Open/.test(filtro) && /Sort: Deadline, earliest first/.test(filtro),
      'o cabeçalho descreve o filtro em inglês', filtro);

    // Impressão e PDF em inglês.
    const html = await frame.evaluate(async () => {
      document.querySelector('input[name="relIdioma"][value="en"]').checked = true;
      document.querySelector('input[name="relNivel"][value="detalhado"]').checked = true;
      window.__htmlImpresso = '';
      await relImprimir();
      return window.__htmlImpresso;
    });
    assert(/<html lang="en"/.test(html), 'a folha impressa se declara em inglês');
    assert(/Tender interests — detailed by item/.test(html), 'título em inglês na folha');
    assert(/Generated on/.test(html) && /Estimated total BRL/.test(html),
      'cabeçalho e totais em inglês', (html.match(/Estimated total[^<]*/) || [])[0]);
    assert(/<th>Unit price<\/th>/.test(html), 'colunas em inglês na folha');
    assert(/Prefeitura Alfa/.test(html) && /Notebook 16GB/.test(html),
      'os DADOS do PNCP seguem em português, como combinado');

    const pdfEn = await frame.evaluate(async () => {
      document.querySelector('input[name="relNivel"][value="resumo"]').checked = true;
      window.__alertas.length = 0;
      window.__blobs.length = 0;
      if (!(window.jspdf && window.jspdf.jsPDF)) return { pulado: true };
      await relGerarPDF();
      const b = window.__blobs[window.__blobs.length - 1];
      return { pulado: false, tamanho: b ? b.size : 0, alertas: window.__alertas.slice() };
    });
    if (pdfEn.pulado) console.log('  ⚠ jsPDF fora do ar: PDF em inglês não provado');
    else assert(pdfEn.tamanho > 1000 && pdfEn.alertas.length === 0,
      'o PDF em inglês também é gerado', pdfEn);

    // Volta ao português para não contaminar o que vem depois.
    await frame.evaluate(() => {
      document.querySelector('input[name="relIdioma"][value="pt"]').checked = true;
    });
  }

  // ── 8. lista vazia não gera arquivo vazio ──────────────────────────────────
  console.log('\n── guarda de lista vazia');
  {
    const r = await frame.evaluate(async () => {
      document.getElementById('filtroOrgao').value = '';
      document.getElementById('filtroPeriodo').value = 'hoje';   // nenhuma licitação encerra hoje
      aplicarFiltro();
      window.__alertas.length = 0;
      window.__blobs.length = 0;
      window.__clicouDownload = 0;
      relBaixarCSV();
      return { alertas: window.__alertas.slice(), blobs: window.__blobs.length, baixou: window.__clicouDownload };
    });
    assert(r.alertas.length === 1 && /Nada para gerar/.test(r.alertas[0]),
      'avisa que não há nada no filtro', r.alertas);
    assert(r.blobs === 0 && r.baixou === 0, 'e não baixa arquivo nenhum', r);
  }

  assert(errosJs.length === 0, 'nenhum erro de JavaScript na página inteira', errosJs);

  await navegador.close();
  servidor.close();

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${ok} ok, ${fail} falha(s)`);
  if (fail) { falhas.forEach(f => console.error('   - ' + f)); process.exit(1); }
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
