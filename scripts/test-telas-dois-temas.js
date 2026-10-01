/**
 * test-telas-dois-temas.js — nenhuma tela fica ilegível ao trocar o tema.
 *
 * Em 30/09/2026, 21 telas tinham cor CRAVADA em fundo e texto (a
 * `operacional/lances.html` tinha 106) e por isso não acompanhavam o tema
 * claro: ficavam com pedaços escuros no meio da tela clara. A correção trocou
 * a cor fixa pelas variáveis do tema, e é essa correção que esta suíte guarda.
 *
 * O que ela mede, tela por tela e nos DOIS temas: todo texto visível contra o
 * fundo que de fato está atrás dele, pegando o primeiro ancestral com fundo
 * opaco — medir contra o pai direto daria "transparente" e não diria nada.
 *
 * Roda da raiz do projeto: node scripts/test-telas-dois-temas.js
 *   TELA=operacional/lances.html node scripts/test-telas-dois-temas.js
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39925);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PUBLICO = path.join(RAIZ, 'public');
const MINIMO = 4.5;
/* Texto grande (>= 18.66px negrito ou >= 24px) pede 3:1, e não 4,5:1. */
const MINIMO_GRANDE = 3;

/* As telas que a correção de 30/09 tocou. Tela nova entra aqui por ter cor
   fixa no `<style>` — ver `scripts/diagnostico-visual.js`, que as conta. */
const TELAS = process.env.TELA ? [process.env.TELA] : [
  'operacional/lances.html', 'operacional/inteligencia.html', 'fiscal/nfe-entrada-detalhe.html',
  'portais/bll-salas.html', 'fiscal/diagnostico.html', 'posto/lmc.html',
  'comercial/contrato.html', 'operacional/grupos-palavras.html', 'licitacoes/interesse.html',
  'operacional/blitz.html', 'fiscal/nfse.html', 'posto/recebimento.html',
  'portais/bnc-monitor.html', 'portais/bll-monitor.html', 'comercial/metas.html',
  /* Entraram na segunda rodada, quando a medição no navegador achou texto
     ilegível que o levantamento por cor fixa não pegava: fundo de barra e de
     bloco de aviso com o texto herdando a cor do tema por cima. */
  'configuracoes/status.html', 'producao/config.html', 'comercial/pedidos-pdv.html',
  'licitacoes/interesse.html', 'configuracoes/estabelecimentos.html',
  'configuracoes/usuarios.html', 'operacional/comprasnet-monitor.html',
];

let falhas = 0, total = 0;
const problemas = [];
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) return;
  falhas++;
  problemas.push(`${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

const FEATS = ['produtos', 'varejo', 'fiscal', 'comercial', 'financeiro', 'estoque', 'compras',
  'os', 'catalogo', 'comunicacao', 'licitacoes', 'portais', 'rh', 'contabilidade', 'patrimonio',
  'locacao', 'producao', 'farmacia', 'posto', 'restaurante', 'optica'];

/* Roda DENTRO da página: mede o contraste de cada texto visível. */
const MEDIR_CONTRASTE = () => {
  const lum = (c) => {
    const m = String(c).match(/(\d+(?:\.\d+)?)/g);
    if (!m || m.length < 3) return null;
    const [r, g, b] = m.slice(0, 3).map((x) => Number(x) / 255);
    const f = (x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const opaco = (c) => {
    const m = String(c).match(/rgba?\([^)]*\)/);
    if (!m) return false;
    const partes = m[0].match(/[\d.]+/g) || [];
    return partes.length < 4 || Number(partes[3]) > 0.85;
  };
  /* O fundo que está ATRÁS do elemento: sobe até achar um opaco. */
  const fundoReal = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const bg = getComputedStyle(e).backgroundColor;
      if (opaco(bg) && lum(bg) !== null) return bg;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
  };
  const razao = (a, b) => {
    const la = lum(a), lb = lum(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const fora = [];
  let medidos = 0;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.3) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    // só quem tem texto PRÓPRIO (e não herdado de filhos)
    const proprio = [...el.childNodes]
      .filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    if (proprio.length < 2) continue;
    const cor = cs.color;
    const bg = fundoReal(el);
    const rz = razao(cor, bg);
    if (rz === null) continue;
    medidos++;
    const px = parseFloat(cs.fontSize) || 14;
    const negrito = Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold';
    const grande = px >= 24 || (px >= 18.66 && negrito);
    const minimo = grande ? 3 : 4.5;
    if (rz < minimo) {
      fora.push({
        el: (el.id ? '#' + el.id : el.tagName.toLowerCase()
          + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : '')),
        txt: proprio.slice(0, 32), razao: Math.round(rz * 100) / 100, cor, bg, px: Math.round(px),
      });
    }
  }
  return { medidos, fora: fora.slice(0, 6) };
};

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
    userDataDir: `/tmp/dois-temas-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  try {
    for (const tela of TELAS) {
      if (!fs.existsSync(path.join(PUBLICO, tela))) { checa(`${tela} existe`, false); continue; }
      /* A cor fixa não pode ter voltado ao <style> da tela. */
      const src = fs.readFileSync(path.join(PUBLICO, tela), 'utf8');
      /* As amostras de um seletor de cor ficam de fora: ali o valor É o dado
         que a pessoa escolhe (`<div class="color-option" style="background:#795548"
         data-cor="#795548">` em `operacional/grupos-palavras.html`), e trocá-lo
         por um token mudaria a cor oferecida, não o estilo da tela. Branco e
         preto também: `color:#fff` sobre botão colorido vale nos dois temas. */
      const semAmostras = src.replace(/<div[^>]*class="color-option"[^>]*>/g, '');
      const fixas = (semAmostras.match(/(color|background|background-color|border-color)\s*:\s*#[0-9a-fA-F]{3,6}\b/g) || [])
        .filter((s) => !/#fff{1,4}\b|#ffffff\b|#000\b|#000000\b/i.test(s));
      checa(`${tela}: sem cor fixa de fundo/texto no <style>`, fixas.length === 0,
        `${fixas.length}: ${fixas.slice(0, 3).join(' | ')}`);

      const page = await browser.newPage();
      page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* já foi */ } });
      try {
        await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(`http://127.0.0.1:${PORTA}/${encodeURI(tela)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise((r) => setTimeout(r, 1000));
        /* Transição DESLIGADA antes de medir.
           `.btn` tem `transition: all .15s`, e em headless a aba pode não
           avançar a animação: o `color` fica preso no valor de partida, que é
           o do tema anterior. Isso produziu uma falha fantasma de 2,56:1 num
           botão cuja única regra é `color: var(--text-2)` — a variável já
           valia o do tema novo, e a cor computada, não. Com a transição fora,
           a medição passa a ser do estado final, que é o que a pessoa vê. */
        await page.addStyleTag({
          content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
        });
        for (const tema of ['escuro', 'claro']) {
          await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), tema);
          await new Promise((r) => setTimeout(r, 120));
          const r = await page.evaluate(MEDIR_CONTRASTE);
          const lista = r.fora.map((f) => `${f.el} "${f.txt}" ${f.razao}:1 (${f.px}px)`).join('; ');
          checa(`${tela} / tema ${tema}: todo texto legível (${r.medidos} medidos)`, r.fora.length === 0, lista);
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
  console.log(`${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens (mínimo ${MINIMO}:1, ${MINIMO_GRANDE}:1 para texto grande)`);
  process.exit(falhas ? 1 : 0);
})();
