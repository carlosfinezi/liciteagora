/**
 * test-campos-cadastros.js — os três cadastros centrais com os campos formatados.
 *
 * `comercial/pessoas.html`, `configuracoes/minha-empresa.html` e
 * `configuracoes/estabelecimentos.html` são por onde todo o resto do sistema lê
 * cliente, fornecedor e empresa. Até 30/09/2026 o `#cpfCnpj` de `pessoas` — a
 * chave única do cadastro — não tinha máscara, limite nem conferência de
 * dígito, e o `#celular` estava ao lado de um `#telefone` que já formatava.
 *
 * A tela roda dentro do shell, então o teste injeta `__liciteShell` antes do
 * script (senão o `sidebar.js` redireciona a carga top-level).
 *
 * Roda da raiz do projeto: node scripts/test-campos-cadastros.js
 */
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39913);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';

let falhas = 0, total = 0;
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) { console.log(`  ok   ${rotulo}`); return; }
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

/* Cada tela, com os campos que ela precisa ter formatados. */
const TELAS = [
  {
    arq: 'comercial/pessoas.html',
    campos: {
      cpfCnpj: 'cpfcnpj', cep: 'cep', telefone: 'telefone', celular: 'telefone',
      email: 'email', emailFinanceiro: 'email',
      inscricaoEstadual: 'inscricao', inscricaoMunicipal: 'inscricao',
    },
  },
  {
    arq: 'configuracoes/minha-empresa.html',
    campos: { cnpj: 'cnpj', cep: 'cep', telefone: 'telefone', celular: 'telefone', email: 'email' },
  },
  {
    arq: 'configuracoes/estabelecimentos.html',
    campos: { cnpj: 'cnpj', cep: 'cep', telefone: 'telefone', celular: 'telefone', email: 'email' },
  },
];

const FEATS = ['produtos', 'varejo', 'fiscal', 'comercial', 'financeiro', 'estoque', 'compras',
  'os', 'catalogo', 'comunicacao', 'licitacoes', 'portais', 'rh', 'contabilidade', 'patrimonio'];

(async () => {
  const app = express();
  app.get('/api/features/status', (_q, s) => s.json({ features: Object.fromEntries(FEATS.map((k) => [k, true])) }));
  app.get('/api/perfis/meu-acesso', (_q, s) => s.json({ irrestrito: true, acessos: {} }));
  app.all('/api/*splat', (q, s) => {
    if (/lista|itens|pessoas|contas|segmentos|tags/i.test(q.path)) return s.json([]);
    s.json({ success: true, total: 0, dados: [], itens: [] });
  });
  app.use(express.static(path.join(RAIZ, 'public', 'auth')));
  app.use(express.static(path.join(RAIZ, 'public')));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/campos-cadastros-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  try {
    for (const tela of TELAS) {
      console.log(`\n=== ${tela.arq}`);
      for (const vp of [{ n: 'computador', w: 1440, h: 900 }, { n: 'celular', w: 360, h: 740 }]) {
        const page = await browser.newPage();
        const errosJs = [];
        page.on('pageerror', (e) => errosJs.push(String(e.message).slice(0, 140)));
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const t = m.text();
          if (/Failed to load resource|favicon|net::ERR|MIME|Refused/.test(t)) return;
          errosJs.push(t.slice(0, 140));
        });
        // A caixa de alerta trava a medição inteira; dispensar e registrar.
        const caixas = [];
        page.on('dialog', async (d) => { caixas.push(d.message()); try { await d.dismiss(); } catch (e) { /* já foi */ } });
        await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
        await page.setViewport({ width: vp.w, height: vp.h });
        await page.goto(`http://127.0.0.1:${PORTA}/${tela.arq}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await new Promise((r) => setTimeout(r, 1200));

        /* A peça está carregada? */
        if (vp.n === 'computador') {
          const temPeca = await page.evaluate(() => typeof window.CampoFormato === 'object');
          checa(`${vp.n}: a peça campo-formato.js está carregada`, temPeca);
        }

        /* Cada campo declara o formato, tem limite e teclado. */
        const estado = await page.evaluate((campos) => {
          const out = {};
          for (const id of Object.keys(campos)) {
            const el = document.getElementById(id);
            if (!el) { out[id] = null; continue; }
            out[id] = {
              formato: el.dataset.formato || null,
              max: el.getAttribute('maxlength'),
              modo: el.getAttribute('inputmode'),
              tipo: el.type,
            };
          }
          return out;
        }, tela.campos);

        for (const [id, esperado] of Object.entries(tela.campos)) {
          const e = estado[id];
          if (!e) { checa(`${vp.n}: #${id} existe na tela`, false, 'campo não encontrado'); continue; }
          if (vp.n === 'computador') {
            checa(`#${id} declara data-formato="${esperado}"`, e.formato === esperado, `declarou ${e.formato}`);
            const precisaLimite = ['cpfcnpj', 'cnpj', 'cpf', 'cep', 'telefone', 'inscricao'].includes(esperado);
            if (precisaLimite) checa(`#${id} tem limite de tamanho`, !!e.max, 'sem maxlength');
          } else {
            // No celular o que importa é o teclado que abre.
            const numerico = ['cpfcnpj', 'cnpj', 'cpf', 'cep'].includes(esperado);
            if (numerico) checa(`celular: #${id} abre teclado numérico`, e.modo === 'numeric', `inputmode=${e.modo}`);
            if (esperado === 'telefone') checa(`celular: #${id} abre teclado de telefone`, e.modo === 'tel' || e.tipo === 'tel', `inputmode=${e.modo} type=${e.tipo}`);
            if (esperado === 'email') checa(`celular: #${id} abre teclado de e-mail`, e.modo === 'email' || e.tipo === 'email', `inputmode=${e.modo} type=${e.tipo}`);
          }
        }

        /* A máscara funciona de verdade, e o documento errado é recusado. */
        if (vp.n === 'computador') {
          const ids = Object.entries(tela.campos);
          const idDoc = (ids.find(([, f]) => f === 'cpfcnpj' || f === 'cnpj') || [])[0];
          const idTel = (ids.find(([, f]) => f === 'telefone') || [])[0];
          if (idDoc) {
            const r = await page.evaluate((id) => {
              const el = document.getElementById(id);
              const nativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
              el.value = '';
              nativo.set.call(el, '11222333000181');
              el.dispatchEvent(new Event('input', { bubbles: true }));
              const mascarado = nativo.get.call(el);
              el.value = '11222333000182';                 // dígito errado
              const erro = CampoFormato.erroDoCampo(el);
              return { mascarado, erro };
            }, idDoc);
            checa(`#${idDoc} mascara o CNPJ`, r.mascarado === '11.222.333/0001-81', r.mascarado);
            checa(`#${idDoc} recusa dígito errado`, /inválido/i.test(String(r.erro)), String(r.erro));
          }
          if (idTel) {
            const r = await page.evaluate((id) => {
              const el = document.getElementById(id);
              el.value = '';
              el.value = '5594991769924';                   // com o 55 do país
              el.dispatchEvent(new Event('input', { bubbles: true }));
              return el.value;
            }, idTel);
            checa(`#${idTel} mascara e descarta o 55 do país`, r === '(94) 99176-9924', r);
          }
        }

        /* Layout: nada pode passar da borda, nos dois temas. */
        for (const tema of ['escuro', 'claro']) {
          const layout = await page.evaluate((t) => {
            document.documentElement.setAttribute('data-theme', t);
            const doc = document.scrollingElement;
            const fora = [];
            for (const el of document.querySelectorAll('body *')) {
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.right <= window.innerWidth + 2) continue;
              let rola = false;
              for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                if (/auto|scroll/.test(getComputedStyle(p).overflowX)) { rola = true; break; }
              }
              if (!rola) fora.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + ' até ' + Math.round(r.right) + 'px');
            }
            return { rolaPagina: doc.scrollWidth > doc.clientWidth + 2 ? doc.scrollWidth : 0, fora: fora.slice(0, 3) };
          }, tema);
          checa(`${vp.n}, tema ${tema}: a página não rola para o lado`, !layout.rolaPagina, `${layout.rolaPagina}px`);
          checa(`${vp.n}, tema ${tema}: nada passa da borda`, layout.fora.length === 0, layout.fora.join('; '));
        }

        checa(`${vp.n}: nenhum erro de JavaScript`, errosJs.length === 0, errosJs.slice(0, 2).join(' | '));
        checa(`${vp.n}: nenhuma caixa de alerta na abertura`, caixas.length === 0, caixas.join(' | '));
        await page.close();
      }
    }
  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
