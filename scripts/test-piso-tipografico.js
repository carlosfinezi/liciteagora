/**
 * O piso tipográfico: nenhum texto que a pessoa precise ler fica abaixo de 12px.
 *
 * ── Por que esta suíte existe ─────────────────────────────────────────────────
 *
 * A etapa 109 (`test-fase35-escala.js`) mede a escala em UMA amostra sintética,
 * com a marcação dos componentes do design system. Ela prova que o componente
 * está certo, e não que a TELA está: a cascata de `em` dentro do `<style>` de
 * cada tela produz tamanhos que não aparecem em lugar nenhum do CSS global.
 *
 * O levantamento de 2026-10-01 mediu as 252 telas em Chrome: **226 delas** tinham
 * texto abaixo de 12px. Os três focos, e o alcance de cada um:
 *
 *     span.menu-section-title (sidebar)     9,24px   em 223 telas
 *     span.menu-section-icon  (sidebar)    10,63px   em 223 telas
 *     thead th                              11,00px   em 118 telas
 *
 * Os dois primeiros saíam de `.menu-section { font-size: 0.66em }` sobre uma base
 * que já era reduzida — o 9,24px não está escrito em lugar nenhum. O terceiro
 * saía de `--text-xs: 0.6875rem`, que era o piso declarado da escala e passou a
 * 12px.
 *
 * ── O que ela mede ───────────────────────────────────────────────────────────
 *
 * Todo texto PRÓPRIO de elemento visível (não herdado de filhos), nas telas da
 * lista abaixo, em 1440px e em 360px, nos DOIS temas. Mede o `font-size`
 * computado, que é o único número que corresponde ao que a pessoa vê.
 *
 * As telas não são todas as 252 de propósito: medir as 252 leva ~35 min, acima do
 * teto de 30 min por suíte do verify. São as que concentravam o problema no
 * levantamento, mais a sidebar — que, por estar em toda tela, é medida de graça
 * em todas elas.
 *
 * Roda da raiz do projeto: node scripts/test-piso-tipografico.js
 *   TELA=fiscal/nova-nota.html node scripts/test-piso-tipografico.js
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39961);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PUBLICO = path.join(RAIZ, 'public');

/** O piso. Vive aqui e em `test-fase35-escala.js` (que o afirma sobre a escala). */
const PISO = 12;

/* As telas que concentravam texto miúdo no levantamento de 2026-10-01, uma por
   foco. Tela nova entra aqui quando o levantamento do navegador a apontar. */
const TELAS = process.env.TELA ? [process.env.TELA] : [
  'operacional/integracao-comprasnet.html', 'portais/bll-monitor.html',
  'portais/bnc-monitor.html', 'operacional/lances.html', 'operacional/conexoes.html',
  'catalogo/loja-regras-fiscais.html', 'fiscal/nova-nota.html', 'comercial/contratos.html',
  'configuracoes/ia.html', 'portais/bll-proposta.html', 'varejo/pdv.html',
  'estoque/estoque.html', 'fiscal/defis.html', 'aprovacoes/aprovacoes.html',
  'catalogo/catalogo-online.html', 'financeiro/extrato-conta.html',
  'fiscal/notas-fiscais.html', 'licitacoes/interesse.html',
  'operacional/comprasnet-monitor.html', 'comercial/pedidos.html',
];

/* O que NÃO é texto para ler, e por isso fica de fora da medição:
   - o rótulo dentro de SVG de gráfico, que é legenda de eixo e cresce com o
     gráfico, não com o corpo do texto;
   - texto de um caractere, que é ícone ou seta de acordeão. */
const FORA = ['svg', 'text', 'tspan'];

const MEDIR = (piso, fora) => {
  const achados = [];
  let medidos = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (fora.includes(el.tagName.toLowerCase())) continue;
    if (el.closest('svg')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const proprio = [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim()).join(' ').trim();
    if (proprio.replace(/\s+/g, '').length < 2) continue;
    const px = parseFloat(cs.fontSize);
    if (!px) continue;
    medidos++;
    if (px >= piso - 0.01) continue;
    achados.push({
      sel: (el.id ? '#' + el.id : el.tagName.toLowerCase()
        + (typeof el.className === 'string' && el.className
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')),
      txt: proprio.slice(0, 26), px: Math.round(px * 100) / 100,
    });
  }
  return { medidos, achados };
};

const FEATS = ['produtos', 'varejo', 'fiscal', 'comercial', 'financeiro', 'estoque', 'compras',
  'os', 'catalogo', 'comunicacao', 'licitacoes', 'portais', 'rh', 'contabilidade', 'patrimonio',
  'locacao', 'producao', 'farmacia', 'posto', 'restaurante', 'optica'];

let falhas = 0, total = 0;
const problemas = [];
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) return;
  falhas++;
  problemas.push(`${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

(async () => {
  const app = express();
  app.get('/api/features/status', (_q, s) => s.json({ features: Object.fromEntries(FEATS.map((k) => [k, true])) }));
  app.get('/api/perfis/meu-acesso', (_q, s) => s.json({ irrestrito: true, acessos: {} }));
  app.all('/api/*splat', (q, s) => {
    if (/lista|itens|pessoas|contas|produtos|pedidos/i.test(q.path)) return s.json([]);
    s.json({ success: true, total: 0, dados: [], itens: [] });
  });
  app.use(express.static(path.join(PUBLICO, 'auth')));
  app.use(express.static(PUBLICO));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/piso-tipografico-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  try {
    for (const tela of TELAS) {
      if (!fs.existsSync(path.join(PUBLICO, tela))) { checa(`${tela} existe`, false); continue; }
      const page = await browser.newPage();
      page.on('dialog', (d) => d.dismiss().catch(() => {}));
      try {
        await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
        await page.goto(`http://127.0.0.1:${PORTA}/${encodeURI(tela)}`,
          { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise((r) => setTimeout(r, 700));
        /* Transição fora antes de medir: em headless a aba pode não avançar a
           animação, e o `font-size` fica preso no valor de partida. */
        await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
        for (const [larg, alt] of [[1440, 900], [360, 740]]) {
          await page.setViewport({ width: larg, height: alt });
          for (const tema of ['escuro', 'claro']) {
            await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), tema);
            await new Promise((r) => setTimeout(r, 90));
            const r = await page.evaluate(MEDIR, PISO, FORA);
            const lista = r.achados.slice(0, 5)
              .map((a) => `${a.sel} "${a.txt}" ${a.px}px`).join('; ');
            checa(`${tela} @${larg}px/${tema}: nada abaixo de ${PISO}px (${r.medidos} medidos)`,
              r.achados.length === 0,
              `${r.achados.length} achado(s): ${lista}`);
          }
        }
      } catch (e) {
        checa(`${tela}: a tela abre`, false, String(e.message).slice(0, 70));
      }
      await page.close();
      process.stdout.write('.');
    }
  } finally {
    await browser.close();
    srv.close();
  }

  console.log('\n');
  if (problemas.length) {
    console.log('PROBLEMAS:');
    for (const p of problemas) console.log('  ' + p);
    console.log('');
  }
  console.log(`${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens (piso de ${PISO}px)`);
  process.exit(falhas ? 1 : 0);
})();
