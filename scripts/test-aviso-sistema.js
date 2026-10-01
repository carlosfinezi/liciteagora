/**
 * test-aviso-sistema.js — o aviso e a confirmação do sistema.
 *
 * Prova o que a peça `public/js/aviso-sistema.js` promete, e sobretudo o que
 * ela existe para consertar: nenhuma frase de erro pode sair vazia. Em
 * 30/09/2026, seis telas mostravam uma caixa dizendo "Erro: " (nada depois dos
 * dois pontos) ou "undefined", porque a exceção não tinha `message`.
 *
 * Roda da raiz do projeto: node scripts/test-aviso-sistema.js
 */
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39917);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';

let falhas = 0, total = 0;
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) { console.log(`  ok   ${rotulo}`); return; }
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/app-modern.css"></head>
<body><div id="toasts"></div><button id="algo">algo</button>
<script src="/js/aviso-sistema.js"></script></body></html>`;

(async () => {
  const app = express();
  app.get('/teste', (_q, s) => s.type('html').send(PAGINA));
  app.use(express.static(path.join(RAIZ, 'public')));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/aviso-sistema-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  try {
    const page = await browser.newPage();
    const errosJs = [];
    page.on('pageerror', (e) => errosJs.push(String(e.message)));
    /* Se a peça abrisse uma caixa do NAVEGADOR, ela cairia aqui — e é
       exatamente o que ela existe para não fazer. */
    const caixasDoNavegador = [];
    page.on('dialog', async (d) => { caixasDoNavegador.push(d.message()); await d.dismiss(); });
    await page.setViewport({ width: 1280, height: 860 });
    await page.goto(`http://127.0.0.1:${PORTA}/teste`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 300));

    console.log('\nA. nenhuma frase de erro sai vazia (o defeito que motivou a peça)');
    const frases = await page.evaluate(() => ({
      exceçãoSemMessage: Aviso.mensagemDeErro(new Error('')),
      undefinedCru: Aviso.mensagemDeErro(undefined),
      nulo: Aviso.mensagemDeErro(null),
      textoUndefined: Aviso.mensagemDeErro('undefined'),
      respostaSemError: Aviso.mensagemDeErro({ success: false }),
      respostaComErrorVazio: Aviso.mensagemDeErro({ error: '' }),
      soEspaço: Aviso.mensagemDeErro('   '),
      redeCaiu: Aviso.mensagemDeErro(new Error('Failed to fetch')),
      comFrase: Aviso.mensagemDeErro({ error: 'CPF inválido' }),
      excecaoComFrase: Aviso.mensagemDeErro(new Error('Conta já baixada')),
    }));
    const util = (s) => typeof s === 'string' && s.trim().length > 15 && !/undefined|^Erro: *$/.test(s);
    for (const [caso, frase] of Object.entries(frases)) {
      if (caso === 'comFrase') {
        checa('frase do servidor é preservada', frase === 'CPF inválido', frase);
      } else if (caso === 'excecaoComFrase') {
        checa('frase da exceção é preservada', frase === 'Conta já baixada', frase);
      } else if (caso === 'redeCaiu') {
        checa('rede caída ganha frase própria', /conex|internet/i.test(frase), frase);
      } else {
        checa(`${caso}: vira frase útil`, util(frase), JSON.stringify(frase));
      }
    }

    console.log('\nB. o aviso aparece na tela, e não numa caixa do navegador');
    const toast = await page.evaluate(() => {
      Aviso.erro('Não foi possível salvar o pedido');
      const el = document.querySelector('#toasts .toast');
      const r = el ? el.getBoundingClientRect() : null;
      return {
        existe: !!el,
        classe: el ? el.className : '',
        papel: el ? el.getAttribute('role') : '',
        texto: el ? el.textContent : '',
        visivel: !!(r && r.width > 60 && r.height > 20),
        dentroDaTela: !!(r && r.right <= window.innerWidth + 1 && r.left >= -1),
      };
    });
    checa('o aviso entra no #toasts', toast.existe);
    checa('erro usa a classe .error da folha comum', /error/.test(toast.classe), toast.classe);
    checa('erro é anunciado como alert para leitor de tela', toast.papel === 'alert', toast.papel);
    checa('o aviso ocupa espaço de verdade', toast.visivel, JSON.stringify(toast));
    checa('o aviso não passa da borda', toast.dentroDaTela);
    checa('nenhuma caixa do navegador foi aberta', caixasDoNavegador.length === 0, caixasDoNavegador.join('|'));

    const vazio = await page.evaluate(() => {
      const antes = document.querySelectorAll('#toasts .toast').length;
      Aviso.ok('');
      Aviso.ok('   ');
      return document.querySelectorAll('#toasts .toast').length - antes;
    });
    checa('aviso vazio não aparece', vazio === 0, `apareceram ${vazio}`);

    console.log('\nC. a confirmação é a caixa do sistema, e devolve a resposta');
    const sim = await page.evaluate(async () => {
      const p = Aviso.confirmar({ texto: 'Excluir o pedido 123?', botao: 'Excluir', perigo: true });
      await new Promise((r) => setTimeout(r, 80));
      const caixa = document.querySelector('.modal-bg.open .modal');
      const btns = [...document.querySelectorAll('.modal-bg.open .modal-actions button')];
      const estado = {
        abriu: !!caixa,
        temAriaModal: document.querySelector('.modal-bg.open').getAttribute('aria-modal') === 'true',
        rotulos: btns.map((b) => b.textContent),
        classeDoOk: btns[1] ? btns[1].className : '',
        focoNoCancelar: document.activeElement === btns[0],
        texto: caixa ? caixa.textContent : '',
      };
      btns[1].click();
      estado.resposta = await p;
      estado.fechou = !document.querySelector('.modal-bg.open');
      return estado;
    });
    checa('a caixa abre com .modal-bg/.modal da folha comum', sim.abriu);
    checa('a caixa se declara modal para leitor de tela', sim.temAriaModal);
    checa('os botões usam os rótulos pedidos', sim.rotulos.join('/') === 'Cancelar/Excluir', sim.rotulos.join('/'));
    checa('ação destrutiva usa o botão de perigo', /btn-danger/.test(sim.classeDoOk), sim.classeDoOk);
    checa('o foco começa no Cancelar, não no que apaga', sim.focoNoCancelar);
    checa('confirmar devolve true', sim.resposta === true);
    checa('a caixa fecha depois de responder', sim.fechou);

    const nao = await page.evaluate(async () => {
      const p = Aviso.confirmar('Cancelar a nota?');
      await new Promise((r) => setTimeout(r, 60));
      document.querySelectorAll('.modal-bg.open .modal-actions button')[0].click();
      return p;
    });
    checa('cancelar devolve false', nao === false);

    const esc = await page.evaluate(async () => {
      const p = Aviso.confirmar('Apagar?');
      await new Promise((r) => setTimeout(r, 60));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return p;
    });
    checa('Escape devolve false (nunca true)', esc === false);

    const fora = await page.evaluate(async () => {
      const p = Aviso.confirmar('Apagar?');
      await new Promise((r) => setTimeout(r, 60));
      document.querySelector('.modal-bg.open').click();
      return p;
    });
    checa('clique fora devolve false', fora === false);

    const duas = await page.evaluate(async () => {
      const a = Aviso.confirmar('primeira');
      await new Promise((r) => setTimeout(r, 60));
      const b = await Aviso.confirmar('segunda');   // não deve abrir
      const quantas = document.querySelectorAll('.modal-bg.open').length;
      document.querySelectorAll('.modal-bg.open .modal-actions button')[0].click();
      await a;
      return { segunda: b, quantas };
    });
    checa('duas caixas ao mesmo tempo não se empilham', duas.quantas === 1, `abriram ${duas.quantas}`);
    checa('a segunda devolve false em vez de ficar sem resposta', duas.segunda === false);

    console.log('\nD. a ponte para as seis funções toast() caseiras');
    const ponte = await page.evaluate(() => {
      const r = {};
      r.temToast = typeof window.toast === 'function';
      toast('salvo', 'sucesso');
      r.sucesso = document.querySelector('#toasts .toast:last-child').className;
      toast('deu erro', 'erro');
      r.erro = document.querySelector('#toasts .toast:last-child').className;
      toast('em ingles', 'success');
      r.success = document.querySelector('#toasts .toast:last-child').className;
      return r;
    });
    checa('window.toast existe', ponte.temToast);
    checa('"sucesso" vira .success', /success/.test(ponte.sucesso), ponte.sucesso);
    checa('"erro" vira .error', /error/.test(ponte.erro), ponte.erro);
    checa('"success" (inglês) também vira .success', /success/.test(ponte.success), ponte.success);

    console.log('\nE. no celular (360px) e nos dois temas');
    for (const tema of ['escuro', 'claro']) {
      await page.setViewport({ width: 360, height: 740 });
      const cel = await page.evaluate(async (t) => {
        document.documentElement.setAttribute('data-theme', t);
        document.getElementById('toasts').innerHTML = '';
        Aviso.erro('Não foi possível salvar: a conta já foi baixada em 12/10/2026');
        const el = document.querySelector('#toasts .toast');
        const r = el.getBoundingClientRect();
        const p = Aviso.confirmar({ texto: 'Excluir o pedido 123, com 4 itens?', botao: 'Excluir', perigo: true });
        await new Promise((x) => setTimeout(x, 120));
        const caixa = document.querySelector('.modal-bg.open .modal');
        const rc = caixa.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const doc = document.scrollingElement;
        document.querySelectorAll('.modal-bg.open .modal-actions button')[0].click();
        await p;
        return {
          avisoDentro: r.right <= window.innerWidth + 1 && r.left >= -1,
          avisoLargura: Math.round(r.width),
          caixaDentro: rc.right <= window.innerWidth + 1 && rc.left >= -1,
          caixaLargura: Math.round(rc.width),
          corDoTexto: cs.color,
          fundo: cs.backgroundColor,
          rolaPagina: doc.scrollWidth > doc.clientWidth + 2 ? doc.scrollWidth : 0,
        };
      }, tema);
      checa(`celular/${tema}: o aviso cabe na tela`, cel.avisoDentro, `largura ${cel.avisoLargura}px`);
      checa(`celular/${tema}: a caixa de confirmar cabe na tela`, cel.caixaDentro, `largura ${cel.caixaLargura}px`);
      checa(`celular/${tema}: a página não rola para o lado`, !cel.rolaPagina, `${cel.rolaPagina}px`);
      checa(`celular/${tema}: o aviso tem cor de texto e fundo próprios`,
        cel.corDoTexto !== cel.fundo && /rgb/.test(cel.corDoTexto), `${cel.corDoTexto} sobre ${cel.fundo}`);
    }

    console.log('\nF. nenhum erro de JavaScript');
    checa('nenhum pageerror', errosJs.length === 0, errosJs.join(' | '));
  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
