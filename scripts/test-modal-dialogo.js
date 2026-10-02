/**
 * test-modal-dialogo.js — todo modal do sistema se anuncia como diálogo.
 *
 * A medição de 01/10/2026: **100 telas com `.modal-header`, UMA com
 * `role="dialog"`**. Para leitor de tela o resto era `div`: não avisava que
 * abriu, não dizia o título, não prendia o foco, e o Tab seguia navegando pelo
 * formulário de trás, que está debaixo do véu e não se vê.
 *
 * O conserto é a peça `public/js/dialogo.js`, carregada pelo `sidebar.js` (e
 * por uma tag em `auth/admin/index.html`, a única das 100 que não o carrega).
 * Esta suíte abre cada tela, ABRE cada modal pelos cinco jeitos que o sistema
 * usa, e mede o que a pessoa de teclado sente:
 *
 *  1. a caixa é `role="dialog"` com `aria-modal="true"`;
 *  2. ela DIZ o próprio nome (`aria-labelledby` apontando um título com texto);
 *  3. o foco está dentro dela;
 *  4. o Tab não sai (cicla do último para o primeiro, e do primeiro para o
 *     último com Shift);
 *  5. tem saída pelo teclado — WCAG 2.1.2: prender o foco numa caixa sem
 *     controle focável seria armadilha, e a peça então NÃO prende;
 *  6. fechando, o foco volta para quem o tinha.
 *
 * Roda da raiz do projeto: node scripts/test-modal-dialogo.js
 *   TELA=comercial/pedido.html node scripts/test-modal-dialogo.js    (uma só)
 *   LIMITE=10 node scripts/test-modal-dialogo.js                     (as 10 primeiras)
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39925);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PUBLICO = path.join(RAIZ, 'public');

const FEATS = ['produtos', 'varejo', 'fiscal', 'comercial', 'financeiro', 'estoque', 'compras',
  'os', 'catalogo', 'comunicacao', 'licitacoes', 'portais', 'rh', 'contabilidade', 'patrimonio',
  'locacao', 'producao', 'farmacia', 'posto', 'restaurante', 'optica', 'whatsapp', 'crm', 'pdv'];

/* As classes que SÃO a caixa, e o seletor que a peça usa. Os dois andam juntos:
   mexer num sem o outro deixa a suíte medindo telas que a peça não trata, ou o
   contrário. `[data-dialogo]` é a porta para quem está fora da convenção — a
   ajuda de `operacional/lances.html` é um `.help-modal-card`, e levantada a
   conta inteira do sistema ela era o único caso. */
const CLASSES_DE_CAIXA = new Set(['modal', 'modal-card', 'modal-box', 'modal-content']);
const CAIXA_SELETOR = '.modal, .modal-card, .modal-box, .modal-content, [data-dialogo]';

let falhas = 0, total = 0;
const problemas = [];
function checa(onde, rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) return;
  falhas++;
  problemas.push(`${onde}: ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

/**
 * As telas que têm alguma CAIXA de modal, e não só as que têm `.modal-header`.
 *
 * O levantamento de 01/10 contou pelo `.modal-header` e achou 100 telas. Medido
 * em 02/10, há **124 com caixa de modal**: as outras 24 não têm o cabeçalho
 * (`financeiro/contas-a-pagar`, `farmacia/receitas`, `operacional/lances`,
 * `varejo/loja`…) e ficavam fora da conta — a peça as trata e ninguém media.
 * Caixa sem título é tratada igual, e a suíte CONTA quantas ficaram sem nome em
 * vez de reprová-las: o nome é o que a tela tem para dar.
 */
function telasComModal(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['img', 'uploads', 'downloads', 'extensions', 'vendor', 'icons', 'loja'].includes(e.name)) continue;
      telasComModal(p, acc);
    } else if (e.name.endsWith('.html')) {
      const s = fs.readFileSync(p, 'utf8');
      /* A classe TODA, e não um pedaço dela: o hífen é limite de palavra em
         regex, e um `\bmodal\b` casava com `modal-actions` (uma barra de
         botões) e com `help-modal` (um véu) — duas telas entravam na lista sem
         ter caixa nenhuma. */
      const temCaixa = [...s.matchAll(/class="([^"]*)"/g)].some((m) =>
        m[1].split(/\s+/).some((c) => CLASSES_DE_CAIXA.has(c)))
        || /\bdata-dialogo\b/.test(s);
      if (temCaixa) acc.push(path.relative(PUBLICO, p));
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
  /* A alavanca da prova por sabotagem: `PECA=/tmp/x.js` serve esse arquivo em
     lugar de `public/js/dialogo.js`, e assim a peça pode ser quebrada de
     propósito sem escrever nada na árvore — que aqui É a produção. */
  if (process.env.PECA) {
    const peca = fs.readFileSync(process.env.PECA, 'utf8');
    app.get('/js/dialogo.js', (_q, s) => s.type('application/javascript').send(peca));
    console.log(`(peça trocada por ${process.env.PECA} — rodada de sabotagem)\n`);
  }
  app.use(express.static(path.join(PUBLICO, 'landing')));
  app.use(express.static(path.join(PUBLICO, 'auth')));
  app.use(express.static(PUBLICO));
  const srv = app.listen(PORTA);

  let lista = process.env.TELA ? [process.env.TELA] : telasComModal(PUBLICO);
  if (process.env.LIMITE) lista = lista.slice(0, Number(process.env.LIMITE));
  console.log(`telas com modal: ${lista.length}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/modal-dialogo-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  const DENTRO_DO_SHELL = (t) => !/^(landing|portal|auth)\//.test(t);
  let modaisMedidos = 0, telasSemModalAbrivel = 0;
  const naoMedidas = [];
  const semNome = [];

  try {
    for (const tela of lista) {
      const page = await browser.newPage();
      page.on('dialog', async (d) => { try { await d.dismiss(); } catch (e) { /* já foi */ } });
      try {
        if (DENTRO_DO_SHELL(tela)) await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
        await page.setViewport({ width: 1440, height: 900 });
        const pedida = `http://127.0.0.1:${PORTA}/${encodeURI(tela)}`;
        await page.goto(pedida, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // A peça entra por um <script> que o sidebar.js injeta: esperar por ela.
        await page.waitForFunction(() => typeof window.Dialogo === 'object', { timeout: 10000 })
          .catch(() => {});
        /* Algumas telas saem de cena sozinhas: o painel de super-admin vai para
           a própria tela de login sem sessão, e `crm-oportunidade.html` volta ao
           funil sem `?id=`. Ali não há modal para medir, e a checagem só é feita
           na tela que ficou. A conferência da URL vem DEPOIS da espera, porque
           o redirecionamento acontece no primeiro fetch, não no load. */
        if (!page.url().startsWith(pedida)) {
          console.log(`\n  (${tela}: foi para ${page.url().replace(`http://127.0.0.1:${PORTA}`, '')} — sai de cena sem sessão ou sem id, não medida)`);
          naoMedidas.push(tela);
          await page.close();
          continue;
        }
        const temPeca = await page.evaluate(() => typeof window.Dialogo === 'object');
        checa(tela, 'a peça dialogo.js está carregada', temPeca);
        if (!temPeca) { await page.close(); continue; }

        /* Quantas caixas a tela tem, e por qual véu cada uma abre. */
        const caixas = await page.evaluate((CAIXA) => {
          return [...document.querySelectorAll(CAIXA)]
            .filter((el) => !(el.parentElement && el.parentElement.closest(CAIXA)))
            .map((el, i) => {
              el.dataset.provaIdx = String(i);
              const veu = el.closest('.modal-bg, .modal-overlay') || el.parentElement;
              if (veu) veu.dataset.provaVeu = String(i);
              return {
                i,
                temHeader: !!el.querySelector('.modal-header'),
                temTitulo: !!el.querySelector('.modal-title, h1, h2, h3, h4'),
                veu: veu ? veu.className : null,
              };
            });
        }, CAIXA_SELETOR);

        for (const c of caixas) {
          const onde = `${tela} [caixa ${c.i}]`;

          /* Abre pelos cinco jeitos que o sistema usa, até um pegar. É o que
             torna esta suíte independente de COMO a tela abre o modal. */
          const abriu = await page.evaluate((i) => {
            const caixa = document.querySelector(`[data-prova-idx="${i}"]`);
            const veu = document.querySelector(`[data-prova-veu="${i}"]`);
            // Quem tinha o foco antes: é a ele que a peça deve devolver.
            const marca = document.createElement('button');
            marca.id = '__prova_foco_antes';
            marca.textContent = 'antes';
            document.body.appendChild(marca);
            marca.focus();
            for (const alvo of [veu, caixa]) {
              if (!alvo) continue;
              for (const passo of [
                () => alvo.classList.add('open'),
                () => alvo.classList.add('active'),
                () => { alvo.style.display = 'flex'; },
                () => { alvo.style.visibility = 'visible'; alvo.style.opacity = '1'; },
                () => alvo.removeAttribute('hidden'),
              ]) {
                passo();
                if (typeof caixa.checkVisibility === 'function'
                    ? caixa.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                    : caixa.getBoundingClientRect().width > 0) return true;
              }
            }
            return false;
          }, c.i);
          if (!abriu) continue;

          /* Espera a CONDIÇÃO, e não um tempo: a peça trabalha num
             `requestAnimationFrame`, e com a máquina carregada (medido com load
             19) um `setTimeout` de 120ms chega antes dele — a medição saía com
             a caixa ainda não tratada, e a suíte reprovava sem defeito. */
          await page.waitForFunction(
            (i) => window.Dialogo.noAr() === document.querySelector(`[data-prova-idx="${i}"]`),
            { timeout: 5000 }, c.i,
          ).catch(() => {});

          const m = await page.evaluate((i) => {
            const caixa = document.querySelector(`[data-prova-idx="${i}"]`);
            const rotuloId = caixa.getAttribute('aria-labelledby');
            const rot = rotuloId ? document.getElementById(rotuloId) : null;
            return {
              role: caixa.getAttribute('role'),
              ariaModal: caixa.getAttribute('aria-modal'),
              rotulo: caixa.getAttribute('aria-label') || (rot ? rot.textContent.trim() : null),
              /* Quando o título está vazio no HTML (a tela o preenche ao abrir,
                 e várias fazem), o que se pode exigir é que o `aria-labelledby`
                 aponte um TÍTULO que existe — o texto chega em produção. */
              aponta: !!rot,
              apontaTitulo: !!rot && /^H[1-6]$/.test(rot.tagName) || (rot && rot.className.includes('modal-title')),
              focoDentro: caixa.contains(document.activeElement),
              focaveis: window.Dialogo.focaveis(caixa).length,
              noAr: window.Dialogo.noAr() === caixa,
            };
          }, c.i);

          modaisMedidos++;
          checa(onde, 'é role="dialog"', m.role === 'dialog', `role=${m.role}`);
          checa(onde, 'é aria-modal="true"', m.ariaModal === 'true', `aria-modal=${m.ariaModal}`);
          if (c.temTitulo) {
            checa(onde, 'diz o próprio nome', !!(m.rotulo && m.rotulo.length > 1) || (m.aponta && m.apontaTitulo),
              `rótulo=${JSON.stringify(m.rotulo)} aponta=${m.aponta}`);
          } else {
            /* Sem título nenhum na caixa não há nome a dar, e inventar um aqui
               seria pior que a ausência. Fica CONTADO, para quem for desenhar
               essas 24 telas saber quantas são. */
            semNome.push(onde);
          }
          checa(onde, 'a peça reconheceu a caixa como a do ar', m.noAr);

          if (m.focaveis === 0) {
            /* Sem controle focável a peça foca a CAIXA (para o leitor de tela
               ler o diálogo) e não prende o Tab: prender aqui seria a armadilha
               de teclado do 2.1.2, porque não haveria como sair. O que se mede
               é isso — o Tab passa. */
            const passa = await page.evaluate((i) => {
              const caixa = document.querySelector(`[data-prova-idx="${i}"]`);
              caixa.focus();
              const e = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
              document.activeElement.dispatchEvent(e);
              return !e.defaultPrevented;
            }, c.i);
            checa(onde, 'caixa sem controle focável não prende o Tab', passa);
          } else {
            checa(onde, 'o foco entrou na caixa', m.focoDentro);
          }

          if (m.focaveis > 0) {

          /* O Tab não sai: do último volta ao primeiro, e Shift+Tab do primeiro
             vai ao último. É isso que impede o Tab de passear pelo formulário
             de trás, que está debaixo do véu. */
          const tab = await page.evaluate(async (i) => {
            const caixa = document.querySelector(`[data-prova-idx="${i}"]`);
            const lista = window.Dialogo.focaveis(caixa);
            const ultimo = lista[lista.length - 1];
            const primeiro = lista[0];
            const enviar = (shift) => {
              const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
              document.activeElement.dispatchEvent(e);
              return e.defaultPrevented;
            };
            ultimo.focus();
            const barrouFim = enviar(false);
            const depoisDoFim = document.activeElement === primeiro;
            primeiro.focus();
            const barrouInicio = enviar(true);
            const depoisDoInicio = document.activeElement === ultimo;
            return { barrouFim, depoisDoFim, barrouInicio, depoisDoInicio, n: lista.length };
          }, c.i);

          checa(onde, 'Tab no último volta ao primeiro', tab.barrouFim && tab.depoisDoFim,
            `barrou=${tab.barrouFim} voltou=${tab.depoisDoFim} focáveis=${tab.n}`);
          checa(onde, 'Shift+Tab no primeiro vai ao último', tab.barrouInicio && tab.depoisDoInicio,
            `barrou=${tab.barrouInicio} foi=${tab.depoisDoInicio}`);
          }

          /* Fechando, o foco volta para quem o tinha. ESTE bloco roda sempre,
             inclusive para a caixa sem focável: deixar uma caixa aberta faria
             a peça tratá-la como a do ar e reprovaria a caixa SEGUINTE da mesma
             tela — foi o que aconteceu em `comercial/pedidos.html`. */
          const volta = await page.evaluate(async (i) => {
            const caixa = document.querySelector(`[data-prova-idx="${i}"]`);
            const veu = document.querySelector(`[data-prova-veu="${i}"]`);
            for (const alvo of [veu, caixa]) {
              if (!alvo) continue;
              alvo.classList.remove('open', 'active');
              alvo.style.display = 'none';
            }
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            return {
              voltou: document.activeElement && document.activeElement.id === '__prova_foco_antes',
              ariaModal: caixa.getAttribute('aria-modal'),
              onde: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
            };
          }, c.i);
          if (m.focaveis > 0) {
            checa(onde, 'fechando, o foco volta de onde veio', volta.voltou, `foco em ${volta.onde}`);
          }
          checa(onde, 'fechando, deixa de ser aria-modal', !volta.ariaModal, `aria-modal=${volta.ariaModal}`);

          // Limpa a marca para a caixa seguinte da mesma tela.
          await page.evaluate(() => {
            const m = document.getElementById('__prova_foco_antes');
            if (m) m.remove();
          });
        }
        if (!caixas.length) telasSemModalAbrivel++;

        /* A caixa do `Aviso.confirmar` NÃO é desta peça, e isto não é detalhe:
           o `js/aviso-sistema.js` monta `div.modal-bg.open` com `role="dialog"`
           e `aria-modal` NO VÉU, mais um `div.modal` dentro, e tem armadilha de
           Tab própria. Sem a guarda, a peça marcaria a caixa de dentro também
           (diálogo dentro de diálogo para o leitor de tela) e as duas
           armadilhas disputariam a mesma tecla. */
        const temAviso = await page.evaluate(() => typeof window.Aviso === 'object' && !!window.Aviso.confirmar);
        if (temAviso) {
          /* Nenhuma caixa da tela pode estar aberta aqui: uma que sobrasse
             traria o `aria-modal` dela para a conta e esta prova acusaria duas
             marcas sem haver conflito nenhum. */
          await page.evaluate(() => {
            for (const v of document.querySelectorAll('.modal-bg, .modal-overlay')) {
              v.classList.remove('open', 'active');
              v.style.display = 'none';
            }
          });
          await page.waitForFunction(() => window.Dialogo.noAr() === null, { timeout: 5000 }).catch(() => {});
          const a = await page.evaluate(async () => {
            window.Aviso.confirmar('Prova da guarda: esta caixa é do Aviso.');
            await new Promise((r) => setTimeout(r, 250));
            const marcados = [...document.querySelectorAll('[aria-modal="true"]')];
            const veu = document.querySelector('.modal-bg.open[role="dialog"]');
            const dentro = veu ? veu.querySelector('.modal') : null;
            return {
              quantos: marcados.length,
              oVeu: !!veu && marcados.includes(veu),
              aDeDentro: !!dentro && dentro.getAttribute('aria-modal') === 'true',
              peçaReivindicou: !!dentro && window.Dialogo.noAr() === dentro,
            };
          });
          checa(tela, 'a caixa do Aviso tem UM só aria-modal', a.quantos === 1, `${a.quantos} marcados`);
          checa(tela, 'e é o véu do Aviso, não a caixa de dentro', a.oVeu && !a.aDeDentro,
            `véu=${a.oVeu} dentro=${a.aDeDentro}`);
          checa(tela, 'a peça não reivindica a caixa do Aviso', !a.peçaReivindicou);
        }
      } catch (e) {
        /* `comercial/pedido.html` é a tela de DETALHE e, sem `?id=`, volta à
           listagem por conta própria — às vezes no meio da medição, e aí o
           contexto do `evaluate` morre. Conferir a URL separa isso de um
           defeito: se a tela saiu de cena, não havia o que medir. */
        const saiuDeCena = !page.url().startsWith(`http://127.0.0.1:${PORTA}/${encodeURI(tela)}`);
        if (saiuDeCena) {
          console.log(`\n  (${tela}: saiu para ${page.url().replace(`http://127.0.0.1:${PORTA}`, '')} durante a medição — não medida)`);
          naoMedidas.push(tela);
        } else {
          checa(tela, 'a tela abre', false, String(e.message).slice(0, 90));
        }
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
    for (const p of problemas.slice(0, 60)) console.log('  ' + p);
    if (problemas.length > 60) console.log(`  ... e ${problemas.length - 60} outros`);
    console.log('');
  }
  console.log(`modais medidos: ${modaisMedidos}, em ${lista.length - naoMedidas.length} de ${lista.length} telas`);
  if (semNome.length) {
    console.log(`caixas sem título para dar nome ao diálogo: ${semNome.length}`);
    console.log('  ' + semNome.slice(0, 12).join(', ') + (semNome.length > 12 ? ', …' : ''));
  }
  if (naoMedidas.length) console.log(`não medidas (exigem sessão): ${naoMedidas.join(', ')}`);
  console.log(`${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
