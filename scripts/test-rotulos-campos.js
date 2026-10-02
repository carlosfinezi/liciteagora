/**
 * test-rotulos-campos.js — o rótulo está LIGADO ao campo dele.
 *
 * Medido em 01/10/2026: **1.711 `<label>` sem `for=`, em 163 telas** (158 já
 * tinham; rótulo que abraça o campo não precisa). Sem a ligação, clicar no
 * rótulo não foca o campo — e, o que pesa mais, o leitor de tela anuncia o
 * campo sem dizer o que ele é: "edição, em branco", e a pessoa adivinha.
 *
 * ── O que esta suíte mede, e por que no navegador ───────────────────────────
 *
 * `for=` escrito no HTML não prova nada: ele pode apontar um id que não existe,
 * ou apontar o campo errado. O que importa é o efeito, e ele se mede no DOM:
 *
 *  1. todo `for=` aponta um elemento que EXISTE na tela;
 *  2. o alvo é um controle de formulário (não um `<div>`);
 *  3. a ligação funciona nos dois sentidos — `label.control` é o campo, e
 *     `campo.labels` contém o rótulo. É esse par que o leitor de tela usa;
 *  4. nenhum id está repetido entre os alvos VISÍVEIS ao mesmo tempo: dois
 *     campos com o mesmo id fariam o rótulo apontar sempre o primeiro.
 *
 * ── O que fica de fora, e não é esquecimento ────────────────────────────────
 *
 * Esta suíte não cobra `for` de TODO rótulo, porque há três casos em que ele
 * está errado por natureza, e eles estão medidos em
 * `docs/rotulos-sem-for-2026-10-02.md`:
 *
 *  - o rótulo que ENVOLVE o campo (229 casos): a ligação já existe pela
 *    aninhagem, e o `for` seria redundante;
 *  - o rótulo de um GRUPO de controles (91): "Cor" acima de cinco quadrados
 *    clicáveis, "Segmentos" acima de uma lista de caixas. Um `for` apontaria
 *    um dos controles e mentiria sobre os outros; o certo é `fieldset`/`legend`
 *    ou `role="group"`, que é outra frente;
 *  - um rótulo para DOIS campos (8): "Valor estimado (R$)" sobre mín e máx.
 *
 * Roda da raiz do projeto: node scripts/test-rotulos-campos.js
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39927);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PUBLICO = path.join(RAIZ, 'public');

const FEATS = ['produtos', 'varejo', 'fiscal', 'comercial', 'financeiro', 'estoque', 'compras',
  'os', 'catalogo', 'comunicacao', 'licitacoes', 'portais', 'rh', 'contabilidade', 'patrimonio',
  'locacao', 'producao', 'farmacia', 'posto', 'restaurante', 'optica', 'whatsapp', 'crm', 'pdv'];

let falhas = 0, total = 0;
const problemas = [];
function checa(onde, rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) return;
  falhas++;
  problemas.push(`${onde}: ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

/** As telas que escrevem `for=` em algum rótulo — achadas no disco. */
function telasComFor(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['img', 'uploads', 'downloads', 'extensions', 'vendor', 'icons'].includes(e.name)) continue;
      telasComFor(p, acc);
    } else if (e.name.endsWith('.html')) {
      if (/<label\b[^>]*\bfor=/.test(fs.readFileSync(p, 'utf8'))) acc.push(path.relative(PUBLICO, p));
    }
  }
  return acc;
}

(async () => {
  const app = express();
  app.get('/api/features/status', (_q, s) => s.json({ features: Object.fromEntries(FEATS.map((k) => [k, true])) }));
  app.get('/api/perfis/meu-acesso', (_q, s) => s.json({ irrestrito: true, acessos: {} }));
  const ENVELOPE = /^\/api\/contas-a-(pagar|receber)/;
  app.all('/api/*splat', (q, s) => {
    if (ENVELOPE.test(q.path)) return s.json({ success: true, contas: [], resumo: {} });
    if (/lista|itens|pessoas|contas|segmentos|tags|produtos|pedidos/i.test(q.path)) return s.json([]);
    s.json({ success: true, total: 0, dados: [], itens: [], resultado: [], lista: [] });
  });
  /**
   * A alavanca da prova por sabotagem: `SABOTA=<modo>` entrega a tela com o
   * defeito dentro, sem escrever nada na árvore — que aqui É a produção. Se a
   * suíte não reprovar com isto ligado, ela não está medindo nada.
   */
  const SABOTA = {
    'for-quebrado': (s) => s.replace(/(<label\b[^>]*) for="[^"]*"/, '$1 for="__naoExisteNaTela"'),
    'for-em-div': (s) => s.replace(/(<label\b[^>]*) for="[^"]*"/, '$1 for="conteudo"'),
    /* A cópia entra LOGO DEPOIS do campo original, e não no fim do `<body>`:
       assim ela herda a visibilidade dele. Um clone no fim do body ficaria
       visível enquanto o original dorme num modal fechado, e aí não haveria
       dois visíveis ao mesmo tempo — que é justamente o que esta checagem
       cobra, porque id repetido em modais mutuamente exclusivos é legítimo
       (`restaurante/caixa.html` tem três `#mtValor` assim). */
    'id-duplicado': (s) => {
      /* Duplica TODOS os alvos, e não o primeiro: o primeiro pode ser um campo
         que a tela esconde (o seletor de estabelecimento de
         `financeiro/extrato-conta.html` só aparece com mais de um), e aí o
         clone seria o único visível — nenhuma dupla para a checagem achar. */
      const ids = [...new Set([...s.matchAll(/<label\b[^>]* for="([^"]+)"/g)].map((m) => m[1]))];
      for (const id of ids) {
        const re = new RegExp(`(<(?:input|select|textarea)\\b[^>]*\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>)`);
        s = s.replace(re, `$1<input id="${id}">`);
      }
      return s;
    },
  }[process.env.SABOTA];
  if (SABOTA) {
    console.log(`(sabotagem "${process.env.SABOTA}" ligada)\n`);
    app.use((q, s, prox) => {
      if (!q.path.endsWith('.html')) return prox();
      const arq = path.join(PUBLICO, decodeURI(q.path).replace(/^\//, ''));
      if (!fs.existsSync(arq)) return prox();
      s.type('html').send(SABOTA(fs.readFileSync(arq, 'utf8')));
    });
  }
  app.use(express.static(path.join(PUBLICO, 'landing')));
  app.use(express.static(path.join(PUBLICO, 'auth')));
  app.use(express.static(PUBLICO));
  const srv = app.listen(PORTA);

  const lista = process.env.TELA ? [process.env.TELA] : telasComFor(PUBLICO);
  console.log(`telas com rótulo ligado: ${lista.length}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/rotulos-campos-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  const DENTRO_DO_SHELL = (t) => !/^(landing|portal|auth|loja)\//.test(t);
  let pares = 0, naoMedidas = [];

  try {
    for (const tela of lista) {
      const page = await browser.newPage();
      page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* já foi */ } });
      const pedida = `http://127.0.0.1:${PORTA}/${encodeURI(tela)}`;
      try {
        if (DENTRO_DO_SHELL(tela)) await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
        await page.setViewport({ width: 1440, height: 900 });
        await page.goto(pedida, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise((r) => setTimeout(r, 700));
        if (!page.url().startsWith(pedida)) { naoMedidas.push(tela); await page.close(); continue; }

        const r = await page.evaluate(() => {
          const out = { quebrados: [], naoControle: [], semMao: [], semVolta: [], dupVisivel: [], n: 0 };
          const visivel = (el) => (typeof el.checkVisibility === 'function'
            ? el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: false })
            : true);
          for (const lab of document.querySelectorAll('label[for]')) {
            out.n++;
            const id = lab.getAttribute('for');
            const alvo = document.getElementById(id);
            const diz = (lab.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '(sem texto)';
            if (!alvo) { out.quebrados.push(`"${diz}" → #${id}`); continue; }
            if (!/^(INPUT|SELECT|TEXTAREA|BUTTON|OUTPUT|METER|PROGRESS)$/.test(alvo.tagName)) {
              out.naoControle.push(`"${diz}" → #${id} é <${alvo.tagName.toLowerCase()}>`); continue;
            }
            /* `label.control` e `campo.labels` são o que o navegador (e o
               leitor de tela) de fato usam. O `for` pode estar escrito e a
               ligação não valer — um `<label>` dentro de outro, por exemplo. */
            if (lab.control !== alvo) out.semMao.push(`"${diz}" → #${id} (label.control=${lab.control ? lab.control.id || lab.control.tagName : 'null'})`);
            else if (!alvo.labels || ![...alvo.labels].includes(lab)) out.semVolta.push(`"${diz}" → #${id}`);
            /* Dois campos com o mesmo id ao mesmo tempo na tela: o rótulo
               aponta sempre o primeiro, e mente sobre o segundo. */
            const iguais = [...document.querySelectorAll(`[id="${CSS.escape ? id.replace(/"/g, '\\"') : id}"]`)].filter(visivel);
            if (iguais.length > 1) out.dupVisivel.push(`#${id} (${iguais.length} visíveis)`);
          }
          return out;
        });

        pares += r.n;
        checa(tela, 'todo for= aponta um elemento que existe', r.quebrados.length === 0, r.quebrados.slice(0, 4).join('; '));
        checa(tela, 'todo alvo é um controle de formulário', r.naoControle.length === 0, r.naoControle.slice(0, 4).join('; '));
        checa(tela, 'a ligação vale de ida (label.control)', r.semMao.length === 0, r.semMao.slice(0, 4).join('; '));
        checa(tela, 'e de volta (campo.labels)', r.semVolta.length === 0, r.semVolta.slice(0, 4).join('; '));
        checa(tela, 'nenhum id de alvo repetido entre os visíveis', r.dupVisivel.length === 0, [...new Set(r.dupVisivel)].slice(0, 4).join('; '));
      } catch (e) {
        if (!page.url().startsWith(pedida)) naoMedidas.push(tela);
        else checa(tela, 'a tela abre', false, String(e.message).slice(0, 90));
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
    for (const p of problemas.slice(0, 50)) console.log('  ' + p);
    if (problemas.length > 50) console.log(`  ... e ${problemas.length - 50} outros`);
    console.log('');
  }
  console.log(`pares rótulo→campo medidos: ${pares}, em ${lista.length - naoMedidas.length} de ${lista.length} telas`);
  if (naoMedidas.length) console.log(`não medidas (saem de cena sem sessão ou sem id): ${naoMedidas.join(', ')}`);
  console.log(`${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
