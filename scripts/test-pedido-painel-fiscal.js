/**
 * O painel "Documento fiscal" do pedido, renderizado de verdade e OLHADO.
 *
 * `montarPainelFiscal` e `blocoAcoesFiscais` são funções puras: recebem a
 * resposta de `/api/pedidos/:id/nfce` e devolvem HTML. Esta suíte extrai as
 * duas do `public/comercial/pedido.html`, executa-as com cada estado fiscal
 * possível e confere o que sai — inclusive medindo no Chrome, com o CSS real,
 * se o que deveria aparecer aparece mesmo.
 *
 * Contar o que está no DOM não prova que se vê: um botão com `display:none`
 * herdado, ou um alerta de 0px de altura, passa em `innerHTML.includes()` e
 * não existe para o lojista. Por isso os estados críticos vão ao navegador e
 * saem em PNG, em /tmp, para serem olhados.
 *
 * Roda da raiz do projeto:  node scripts/test-pedido-painel-fiscal.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');
const TELA = path.join(RAIZ, 'public/comercial/pedido.html');
const CSS = path.join(RAIZ, 'public/css/app-modern.css');
const SAIDA = fs.mkdtempSync(path.join(os.tmpdir(), 'painel-fiscal-'));

let falhas = 0;
let total = 0;
function ok(nome, condicao, detalhe) {
  total++;
  if (condicao) console.log(`  ok   ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
}

// ── extrai as funções puras da tela ─────────────────────────────────────────
// Sem copiá-las: o que é medido é o código que está no ar. Uma cópia local
// passaria a valer por si e envelheceria no primeiro ajuste da tela.
const html = fs.readFileSync(TELA, 'utf8');
const blocos = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const fonte = blocos.join('\n');

/* Recorte CONTÍGUO, entre dois marcadores que existem no arquivo: do
   `escHtml` até a primeira função que fala com a rede. Recortar função por
   função por heurística de chave-na-coluna-zero quebra na primeira arrow
   multilinha — quebrou aqui, e é por isso que o corte é este. */
/* O recorte vai do `escHtml` (que as duas funções usam) até a primeira que
   fala com a rede, e por isso inclui também a `travaFiscalDoCancelamento`,
   da Etapa 6 — ela foi posta depois do `escHtml` justamente para caber aqui
   e para não depender da TDZ de um `const` declarado mais abaixo. */
const INI = 'const escHtml =';
const FIM = 'async function emitirNFCeDoPedido(';
const a = fonte.indexOf(INI);
const b = fonte.indexOf(FIM);
if (a < 0 || b < 0 || b < a) {
  console.log(`FALHA: não achei o trecho do painel na tela (${a}, ${b})`);
  process.exit(1);
}
const trecho = fonte.slice(a, b);

/* `carregarFiscal` entra junto no recorte e usa `document` e `fetch`. Declarar
   não executa, mas o contexto precisa dos nomes para o parse não reclamar em
   uso futuro — e os stubs deixam explícito que nada de rede roda aqui. */
const contexto = {
  console,
  document: { getElementById: () => null },
  fetch: () => { throw new Error('esta suíte não faz rede'); },
  PEDIDO_ID: 1,
};
vm.createContext(contexto);
vm.runInContext(trecho, contexto);
const montar = contexto.montarPainelFiscal;

ok('A1 as funções de render foram extraídas da tela em uso', typeof montar === 'function');

// ── os estados, como o servidor os entrega ──────────────────────────────────
const base = { pedido: { id: 1, numero: 'CAT-1', tipo: 'catalogo', status: 'entregue' },
               nfce: null, nfe55: null, naturezaOk: true, naturezaDescricao: 'Venda catálogo',
               podeEmitir: true, precisaConsultar: false };
const nota = (st, extra) => Object.assign({
  id: 7, numero: 1234, serie: 1, chaveAcesso: '1'.repeat(44),
  protocoloAutorizacao: '915260000123456', dataEmissao: '2026-09-28',
  valorTotal: 60, statusSefaz: st, rejeicaoMotivo: null, motivoCancelamento: null,
  dataCancelamento: null, qrCodeUrl: null,
}, extra || {});

const ESTADOS = {
  'nao-emitida': Object.assign({}, base),
  'sem-natureza': Object.assign({}, base, { naturezaOk: false, podeEmitir: false,
    naturezaDescricao: null }),
  'estado-cedo': Object.assign({}, base, { podeEmitir: false,
    pedido: { id: 1, numero: 'CAT-1', tipo: 'catalogo', status: 'confirmado' } }),
  autorizada: Object.assign({}, base, { podeEmitir: false, nfce: nota('autorizada') }),
  rejeitada: Object.assign({}, base, { podeEmitir: true,
    nfce: nota('rejeitada', { rejeicaoMotivo: 'cStat=539 · Duplicidade de NF-e com diferenca na chave de acesso',
                              protocoloAutorizacao: null }) }),
  cancelada: Object.assign({}, base, { podeEmitir: true,
    nfce: nota('cancelada', { motivoCancelamento: 'Cliente desistiu da compra na entrega (protocolo 915260000777666)',
                              dataCancelamento: '2026-09-28 15:40' }) }),
  pendente: Object.assign({}, base, { podeEmitir: false, precisaConsultar: true,
    nfce: nota('pendente', { protocoloAutorizacao: null }) }),
  'com-nfe55': Object.assign({}, base, { podeEmitir: false,
    nfe55: { id: 3, numero: 'F-1', numeroNFe: 555, chaveAcesso: '5'.repeat(44) } }),
};

const saidas = {};
for (const [nome, d] of Object.entries(ESTADOS)) saidas[nome] = montar(d);

// ── B. o que cada estado tem de dizer ───────────────────────────────────────
const tem = (nome, t) => saidas[nome].includes(t);

ok('B1 não emitida: oferece Emitir NFC-e', tem('nao-emitida', 'Emitir NFC-e'));
ok('B2 não emitida: diz que não há nota', /Nenhuma NFC-e emitida/.test(saidas['nao-emitida']));

ok('B3 sem natureza: NÃO oferece emitir', !tem('sem-natureza', 'Emitir NFC-e'));
ok('B4 sem natureza: manda configurar, e diz onde',
  /Regras fiscais/.test(saidas['sem-natureza']) && /Catálogo Online/.test(saidas['sem-natureza']));

ok('B5 estado cedo demais: NÃO oferece emitir', !tem('estado-cedo', 'Emitir NFC-e'));
ok('B6 estado cedo demais: explica qual estado falta',
  /entregue ou faturado/.test(saidas['estado-cedo']));

ok('B7 autorizada: mostra número e série', /1234 \/ 1/.test(saidas.autorizada));
ok('B8 autorizada: mostra a chave inteira', tem('autorizada', '1'.repeat(44)));
ok('B9 autorizada: oferece DANFCe, XML, Consultar e Cancelar',
  ['DANFCe', '/xml', 'Consultar situação', 'Cancelar NFC-e'].every((x) => tem('autorizada', x)));
ok('B10 autorizada: NÃO oferece emitir de novo', !tem('autorizada', 'Emitir NFC-e'));

/* O motivo INTEIRO, e não uma mensagem genérica: é ele que diz o que
   corrigir. Esconder isso deixa o lojista sem o dado que resolve. */
ok('B11 rejeitada: mostra o motivo da SEFAZ por extenso',
  tem('rejeitada', 'Duplicidade de NF-e com diferenca na chave de acesso')
  && tem('rejeitada', '539'));
ok('B12 rejeitada: permite nova tentativa', tem('rejeitada', 'Emitir NFC-e'));
ok('B13 rejeitada: NÃO oferece DANFCe (não há cupom de nota rejeitada)',
  !tem('rejeitada', 'DANFCe'));

ok('B14 cancelada: diz que foi cancelada e mantém o motivo',
  /cancelada/i.test(saidas.cancelada) && tem('cancelada', 'Cliente desistiu'));
ok('B15 cancelada: mantém o histórico da nota (número e chave)',
  /1234 \/ 1/.test(saidas.cancelada) && tem('cancelada', '1'.repeat(44)));
ok('B16 cancelada: permite nova emissão', tem('cancelada', 'Emitir NFC-e'));

ok('B17 pendente: NÃO oferece emitir', !tem('pendente', 'Emitir NFC-e'));
ok('B18 pendente: oferece Consultar situação', tem('pendente', 'Consultar situação'));
ok('B19 pendente: explica o risco de emitir por cima',
  /dois documentos para a mesma venda/.test(saidas.pendente));

ok('B20 com NF-e 55: NÃO oferece emitir NFC-e', !tem('com-nfe55', 'Emitir NFC-e'));
ok('B21 com NF-e 55: explica e manda para a aba certa',
  /NF-e modelo 55/.test(saidas['com-nfe55']) && /aba Fatura/.test(saidas['com-nfe55']));
ok('B22 com NF-e 55: não oferece ação fiscal nenhuma de NFC-e',
  !tem('com-nfe55', 'DANFCe') && !tem('com-nfe55', 'Cancelar NFC-e'));

// ── B2. a trava do botão "Cancelar pedido" (Etapa 6) ────────────────────────
// A tela não pode convidar o lojista a cancelar um pedido que o servidor vai
// recusar. A régua é a MESMA das duas pontas: autorizada e pendente barram,
// rejeitada e cancelada não.
{
  const trava = contexto.travaFiscalDoCancelamento;
  ok('B23 a função de trava foi extraída da tela', typeof trava === 'function');

  /* `estadoFiscal` é declarado com `let`, e um `let` de script vive no escopo
     lexical — NÃO vira propriedade do objeto global do contexto. Atribuir
     `contexto.estadoFiscal` não o alcança (a função continuava lendo null, e
     três asserts reprovaram por isso). A atribuição precisa ser executada
     DENTRO do contexto, onde a binding existe. */
  const comEstado = (d) => {
    contexto.__e = d;
    vm.runInContext('estadoFiscal = __e;', contexto);
    return trava();
  };

  ok('B24 sem estado fiscal: não trava (pedido que não é do catálogo)',
    comEstado(null) === null);
  ok('B25 sem nota: não trava', comEstado(ESTADOS['nao-emitida']) === null);

  const tAut = comEstado(ESTADOS.autorizada);
  ok('B26 NFC-e autorizada: trava e explica', typeof tAut === 'string'
    && /Cancele primeiro a NFC-e/.test(tAut), String(tAut));
  ok('B27 e diz qual nota e onde resolver',
    /nº 1234/.test(tAut) && /Documento fiscal/.test(tAut), tAut);

  const tPend = comEstado(ESTADOS.pendente);
  ok('B28 NFC-e pendente: trava também', typeof tPend === 'string'
    && /Consulte a situação/.test(tPend), String(tPend));

  ok('B29 NFC-e rejeitada: NÃO trava', comEstado(ESTADOS.rejeitada) === null);
  ok('B30 NFC-e cancelada: NÃO trava', comEstado(ESTADOS.cancelada) === null);

  /* A régua da tela e a do servidor têm de ser a mesma lista. Divergir faria
     a tela esconder o botão onde o servidor deixaria passar, ou o contrário
     — que é o caso ruim. Lido do fonte dos dois lados. */
  const srvSrc = fs.readFileSync(path.join(RAIZ, 'pedidos-routes.js'), 'utf8');
  ok('B31 o servidor barra exatamente autorizada e pendente',
    srvSrc.includes("statusSefaz IN ('autorizada', 'pendente')"),
    'a lista do servidor mudou — a da tela precisa acompanhar');

  comEstado(null);
}

// ── C. o texto da SEFAZ não pode virar HTML ─────────────────────────────────
{
  const veneno = Object.assign({}, base, { podeEmitir: false,
    nfce: nota('rejeitada', { rejeicaoMotivo: '<img src=x onerror=alert(1)> & "aspas"' }) });
  const saida = montar(veneno);
  ok('C1 motivo com HTML é escapado, não injetado',
    !saida.includes('<img src=x') && saida.includes('&lt;img'), saida.slice(0, 200));
  ok('C2 o & também é escapado', saida.includes('&amp;'));
}

// ── D. medido no navegador, com o CSS real ──────────────────────────────────
// Um botão que existe no HTML mas não aparece na tela é o mesmo que não
// existir. Aqui os estados críticos são renderizados e MEDIDOS.
(async () => {
  let puppeteer;
  try { puppeteer = require('puppeteer-extra'); }
  catch (_) { try { puppeteer = require('puppeteer-core'); } catch (_2) { puppeteer = null; } }
  if (!puppeteer) {
    console.log('  (Chrome indisponível — os asserts de visibilidade foram pulados)');
    return fim();
  }

  const css = fs.readFileSync(CSS, 'utf8');
  const pagina = (corpo) => `<!doctype html><meta charset="utf-8"><style>${css}</style>
    <body class="theme-light" style="padding:24px;background:var(--bg,#fff)">
      <div class="ped-painel active"><h3>Documento fiscal</h3>${corpo}</div>
    </body>`;

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: '/usr/bin/google-chrome-stable',
      headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (e) {
    console.log('  (não subiu o Chrome: ' + e.message + ' — visibilidade pulada)');
    return fim();
  }

  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 700 });

  for (const nome of ['nao-emitida', 'autorizada', 'rejeitada', 'pendente', 'com-nfe55']) {
    await page.setContent(pagina(saidas[nome]), { waitUntil: 'domcontentloaded' });
    const medida = await page.evaluate(() => {
      const visivel = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
          && Number(s.opacity) > 0.05;
      };
      const alvos = [...document.querySelectorAll('button, a.btn, .alert')];
      /* Link com `.btn` herda o sublinhado e o botão sai riscado. Só se vê
         olhando a captura — foi assim que apareceu, em 28/09 —, e uma vez
         visto vira número: nenhum botão pode ter decoração de texto. */
      const riscados = [...document.querySelectorAll('a.btn')]
        .filter((el) => !/^none\b/.test(getComputedStyle(el).textDecorationLine))
        .map((el) => el.textContent.trim());
      return {
        totais: alvos.length,
        visiveis: alvos.filter(visivel).length,
        riscados,
        textos: alvos.filter(visivel).map((e) => e.textContent.trim().slice(0, 40)),
        alturaConteudo: document.querySelector('.ped-painel').getBoundingClientRect().height,
      };
    });
    const png = path.join(SAIDA, `${nome}.png`);
    await page.screenshot({ path: png, fullPage: true });

    ok(`D.${nome} tudo que foi montado está VISÍVEL (${medida.visiveis}/${medida.totais})`,
      medida.totais > 0 && medida.visiveis === medida.totais,
      `invisíveis: ${medida.totais - medida.visiveis}`);
    ok(`D.${nome} o painel tem altura real`, medida.alturaConteudo > 40,
      `${medida.alturaConteudo}px`);
    ok(`D.${nome} nenhum botão-link sai sublinhado`, medida.riscados.length === 0,
      `riscados: ${medida.riscados.join(', ')}`);
    console.log(`       ${png}  ·  ${medida.textos.join(' | ')}`);
  }

  await browser.close();
  fim();
})().catch((e) => { console.error('FALHOU:', e.stack || e.message); process.exit(1); });

function fim() {
  console.log(`\nPNGs em ${SAIDA}`);
  console.log(`${total - falhas}/${total} asserts passaram`);
  if (falhas) { console.log(`FALHA: ${falhas} problema(s)`); process.exit(1); }
  console.log('TODOS OS ASSERTS PASSARAM');
}
