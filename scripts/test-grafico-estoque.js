/**
 * test-grafico-estoque.js — os dois gráficos de `estoque/analises.html` com o
 * texto legível, inclusive a 360px.
 *
 * O defeito que ela guarda: os `<svg>` tinham `viewBox="0 0 800 240"` com
 * `preserveAspectRatio="none"`. A altura não escalava (240 de 240) mas a
 * largura sim, e com isso o GLIFO era esticado num eixo só — 1,36 de largura no
 * computador e **0,37 a 360px**. O rótulo "jan/26" media 50px de largura no
 * computador e 14px no celular, com 14,6px de altura: letras de ~2,3px de
 * largura, achatadas e ilegíveis.
 *
 * Nenhuma medição de `font-size` acusa isso, e é por isso que esta suíte
 * precisa exister à parte: o `font-size` dali é 12px e sempre foi legítimo. O
 * que se mede aqui é a MATRIZ do elemento (`getScreenCTM`), que é onde a
 * distorção aparece.
 *
 * Roda da raiz do projeto: node scripts/test-grafico-estoque.js
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39923);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PUBLICO = path.join(RAIZ, 'public');

let falhas = 0, total = 0;
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) { console.log(`  ok   ${rotulo}`); return; }
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

/* 12 meses, que é o caso apertado: a 360px dá ~20px por barra. */
const MESES = ['out/25', 'nov/25', 'dez/25', 'jan/26', 'fev/26', 'mar/26',
  'abr/26', 'mai/26', 'jun/26', 'jul/26', 'ago/26', 'set/26'];
const PONTOS = MESES.map((mes, i) => ({ mes, valor: 90000 + i * 12345.67, variacao: i % 3 === 0 ? 4321.5 : -876.25 }));

(async () => {
  const app = express();
  app.get('/api/features/status', (_q, s) => s.json({ features: { estoque: true, produtos: true } }));
  app.get('/api/perfis/meu-acesso', (_q, s) => s.json({ irrestrito: true, acessos: {} }));
  app.get('/api/estoque/valorizacao', (_q, s) => s.json({
    success: true, valorTotal: 1234567.89, totalItens: 420,
    top10: [{ sku: 'A1', descricao: 'Produto de teste', saldo: 10, custoMedio: 5, valor: 50 }],
    resumo: {}, kpis: {},
  }));
  app.get('/api/estoque/valorizacao/evolucao', (_q, s) => s.json({ success: true, pontos: PONTOS }));
  app.get('/api/estoque/cmv', (_q, s) => s.json({
    success: true, porMes: PONTOS.map((p) => ({ mes: p.mes, cmv: p.valor })),
    total: 0, resumo: {}, itens: [],
  }));
  app.all('/api/*splat', (_q, s) => s.json({ success: true, dados: [], itens: [], pontos: PONTOS, porMes: [] }));
  app.use(express.static(path.join(PUBLICO, 'auth')));
  app.use(express.static(PUBLICO));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/grafico-estoque-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  /** Mede um dos dois gráficos na largura pedida. */
  async function medir(page, svgId, largura) {
    await page.setViewport({ width: largura, height: 900 });
    // O resize redesenha por ResizeObserver; dar o quadro para ele acontecer.
    await new Promise((r) => setTimeout(r, 450));
    return page.evaluate((id) => {
      const svg = document.getElementById(id);
      const caixa = svg.getBoundingClientRect();
      const rotulos = [...svg.querySelectorAll('text.label, text.delta-pos, text.delta-neg')].map((t) => {
        const m = t.getScreenCTM();
        const r = t.getBoundingClientRect();
        return {
          texto: t.textContent, escalaX: m ? m.a : 0, escalaY: m ? m.d : 0,
          esq: r.left, dir: r.right, topo: r.top, base: r.bottom, alt: r.height,
          ancora: t.getAttribute('text-anchor'),
        };
      });
      const barras = [...svg.querySelectorAll('rect.bar')].map((b) => {
        const r = b.getBoundingClientRect();
        return { esq: r.left, dir: r.right, larg: r.width };
      });
      return { svg: { esq: caixa.left, dir: caixa.right, larg: caixa.width, alt: caixa.height }, rotulos, barras };
    }, svgId);
  }

  try {
    const page = await browser.newPage();
    page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* já foi */ } });
    await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${PORTA}/estoque/analises.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('#svgEvol text.label').length > 0, { timeout: 15000 });
    // O gráfico de CMV vive na aba CMV, que começa fechada: é o caso que prova
    // o ResizeObserver, porque o primeiro desenho dele é com largura ZERO.
    await page.evaluate(() => switchTab('cmv'));
    await new Promise((r) => setTimeout(r, 900));
    await page.evaluate(() => switchTab('valorizacao'));
    await new Promise((r) => setTimeout(r, 400));

    for (const svgId of ['svgEvol', 'svgCmv']) {
      if (svgId === 'svgCmv') { await page.evaluate(() => switchTab('cmv')); await new Promise((r) => setTimeout(r, 500)); }
      for (const largura of [1440, 360]) {
        const m = await medir(page, svgId, largura);
        const alvo = `${svgId} a ${largura}px`;

        checa(`${alvo}: desenhou rótulo`, m.rotulos.length > 0, `${m.rotulos.length} rótulos`);
        if (!m.rotulos.length) continue;

        /* O que o viewBox esticado quebrava: escala diferente nos dois eixos. */
        const pior = m.rotulos.reduce((a, r) =>
          Math.abs(r.escalaX - r.escalaY) > Math.abs(a.escalaX - a.escalaY) ? r : a, m.rotulos[0]);
        checa(`${alvo}: o glifo não é distorcido (escalaX == escalaY)`,
          Math.abs(pior.escalaX - pior.escalaY) < 0.02,
          `"${pior.texto}" escalaX=${pior.escalaX.toFixed(2)} escalaY=${pior.escalaY.toFixed(2)}`);

        /* Um "jan/26" de 14px de largura e 14,6 de altura era o sintoma: a
           largura por caractere é o que denuncia a compressão. */
        const mes = m.rotulos.filter((r) => /\w{3}\/\d\d/.test(r.texto));
        if (mes.length) {
          const estreito = mes.reduce((a, r) =>
            (r.dir - r.esq) / r.texto.length < (a.dir - a.esq) / a.texto.length ? r : a, mes[0]);
          const porChar = (estreito.dir - estreito.esq) / estreito.texto.length;
          checa(`${alvo}: o mês tem largura de letra legível`, porChar >= 4.5,
            `"${estreito.texto}" ${porChar.toFixed(1)}px por caractere`);
        }

        /* Nada cortado pela borda do gráfico, nos dois lados. */
        const fora = m.rotulos.filter((r) => r.esq < m.svg.esq - 1 || r.dir > m.svg.dir + 1);
        checa(`${alvo}: nenhum rótulo sai do gráfico`, fora.length === 0,
          fora.slice(0, 3).map((r) => `"${r.texto}"`).join(' '));

        /* E nada sobreposto: pular rótulo de mês é justamente o que evita isso. */
        const linhaDeBaixo = mes.slice().sort((a, b) => a.esq - b.esq);
        let colide = null;
        for (let i = 1; i < linhaDeBaixo.length; i++) {
          if (linhaDeBaixo[i].esq < linhaDeBaixo[i - 1].dir - 0.5) {
            colide = `"${linhaDeBaixo[i - 1].texto}" e "${linhaDeBaixo[i].texto}"`;
            break;
          }
        }
        checa(`${alvo}: os meses não se sobrepõem`, !colide, colide || '');

        /* A barra tem corpo: a folga fixa de 12px zerava a barra de 20px. */
        if (m.barras.length) {
          const fina = Math.min(...m.barras.map((b) => b.larg));
          checa(`${alvo}: a barra mais fina ainda se vê`, fina >= 3, `${fina.toFixed(1)}px`);
        }
      }
    }
    await page.close();
  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
