/**
 * Responsividade do fluxo de orçamento — medida no Chrome, não estimada.
 *
 * ── Por que não basta ler o CSS ─────────────────────────────────────────────
 *
 * Um `@media (max-width: 640px)` no arquivo não prova que a tela cabe: basta um
 * seletor com especificidade menor, um `min-width` esquecido numa tabela, ou um
 * elemento posicionado fora do fluxo para o conteúdo estourar mesmo com a regra
 * escrita. Este teste abre a página de verdade, nas larguras dos aparelhos, e
 * mede `scrollWidth` contra `clientWidth`.
 *
 * ── O que ele NÃO é ─────────────────────────────────────────────────────────
 *
 * Chromium num servidor não é um iPhone. Ele não reproduz a barra do Safari, o
 * teclado do iOS, o `100vh` que muda ao rolar, nem o comportamento da folha de
 * compartilhamento. O que este teste garante é geometria: o que couber aqui não
 * vai estourar lá por culpa de largura. O resto continua precisando do aparelho.
 *
 * As telas são carregadas com as APIs interceptadas — nenhuma chamada sai da
 * máquina e nenhum banco é tocado.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));

const LARGURAS = [320, 360, 375, 390, 430];

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

/** Um orçamento plausível, com a descrição longa que motivou a correção. */
const ORCAMENTO = {
  success: true,
  pedido: {
    id: 1, numero: 'ORC-2026-00003', modoDocumento: 'orcamento', tipo: 'venda',
    status: 'rascunho', statusPagamento: 'aberta',
    clienteId: 1, clienteNome: 'PARAISO COMERCIO DE ALIMENTOS LTDA',
    clienteTelefone: '44999990000', dataPedido: '2026-09-12',
    valorTotal: 42.5, valorPago: 0, desconto: 0, frete: 0,
    itens: [{
      id: 1, produtoId: 1, sku: '3066',
      descricao: 'MEIO TEMPERO COMPLETO COM AÇAFRÃO - FARDO COM 24 UNIDADES DE 400G CADA',
      unidade: 'UN', quantidade: 1, precoUnitario: 42.5, valorTotal: 42.5,
    }],
  },
};

/**
 * Servidor local só com os estáticos; qualquer /api/ responde um JSON inócuo.
 *
 * Porta efêmera (`listen(0)`) de propósito: subir na porta de produção para
 * testar é justamente o que o CLAUDE.md deste projeto proíbe.
 */
function subirServidor() {
  const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/')) {
      res.setHeader('Content-Type', 'application/json');
      if (/^\/api\/pedidos\/\d+$/.test(url)) return res.end(JSON.stringify(ORCAMENTO));
      // Resposta genérica: as telas leem listas por nomes diferentes, e um
      // array vazio em cada uma evita que a montagem pare por `undefined`.
      return res.end(JSON.stringify({
        success: true, itens: [], produtos: [], pedidos: [], clientes: [], parcelas: [],
        cfops: [], tiposOperacao: [], tabelas: [], historico: [], motivos: [], perfis: [],
        paginas: [], meios: [], politicas: [], total: 0, resumo: {},
      }));
    }
    // As telas do ERP se recusam a rodar soltas: o `shellRedirect()` do
    // sidebar.js manda toda página top-level para `/app.html`. Medir a página
    // "carregada" direto mediria o SHELL, não a tela — os primeiros resultados
    // deste teste passaram assim, verdes e sem valor. O envelope reproduz o
    // iframe do shell, que é como a tela existe de verdade.
    if (url === '/__envelope') {
      const alvo = (req.url.split('?tela=')[1] || '');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html,body{margin:0;padding:0;height:100%;overflow:hidden}
               iframe{border:0;width:100%;height:100%;display:block}</style></head>
        <body><iframe id="tela" src="${decodeURIComponent(alvo)}"></iframe></body></html>`);
    }

    const arq = path.join(PUB, url === '/' ? 'index.html' : url.replace(/^\//, ''));
    if (!arq.startsWith(PUB) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
      res.statusCode = 404; return res.end('nao encontrado');
    }
    res.setHeader('Content-Type', TIPOS[path.extname(arq)] || 'application/octet-stream');
    res.end(fs.readFileSync(arq));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

/**
 * Abre uma tela do ERP dentro do envelope e devolve o frame dela.
 *
 * Devolver o FRAME, e não a página, é o ponto: toda medição precisa acontecer
 * no documento da tela. Medir na página de fora daria sempre "cabe".
 */
async function abrirTela(page, url, largura) {
  await page.setViewport({ width: largura, height: 780, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const u = new URL(url);
  await page.goto(`${u.origin}/__envelope?tela=${encodeURIComponent(u.pathname + u.search)}`,
                  { waitUntil: 'networkidle0', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 500));   // deixa a montagem terminar
  const el = await page.$('#tela');
  const frame = await el.contentFrame();
  if (!frame) throw new Error('a tela não carregou dentro do envelope');
  return frame;
}

/** Mede o que estoura a largura da janela. */
async function medir(page, url, largura) {
  const frame = await abrirTela(page, url, largura);
  return frame.evaluate(() => {
    const doc = document.documentElement;
    const culpados = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const est = getComputedStyle(el);
      if (est.position === 'fixed' || est.display === 'none' || est.visibility === 'hidden') continue;
      if (r.right > doc.clientWidth + 1) {
        culpados.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`
          + `${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}`
          + ` (até ${Math.round(r.right)}px)`);
      }
      if (culpados.length > 6) break;
    }
    // Campos abaixo de 16px fazem o Safari do iOS dar zoom ao focar.
    const pequenos = [...document.querySelectorAll('input, select, textarea')]
      .filter((el) => el.offsetParent && parseFloat(getComputedStyle(el).fontSize) < 15.9)
      .map((el) => el.id || el.name || el.tagName.toLowerCase());
    // Alvos de toque pequenos demais entre os botões visíveis.
    const miudos = [...document.querySelectorAll('button')]
      .filter((el) => el.offsetParent && el.getBoundingClientRect().height > 0
                   && el.getBoundingClientRect().height < 30)
      .map((el) => (el.textContent || '').trim().slice(0, 18)).filter(Boolean);
    return {
      estouro: doc.scrollWidth - doc.clientWidth,
      largura: doc.clientWidth, culpados, pequenos: [...new Set(pequenos)], miudos: [...new Set(miudos)],
    };
  });
}

(async () => {
  if (!CHROME) {
    console.log('  Chrome ausente — teste de responsividade real não pode rodar');
    console.log('\n0 ok, 0 falha(s) (pulado)');
    process.exit(0);
  }
  const srv = await subirServidor();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  const TELAS = [
    ['tela do orçamento', '/comercial/pedido.html?id=1'],
    ['listagem de pedidos', '/comercial/pedidos.html'],
    ['página pública do cliente', '/orcamento-comercial.html?token=' + 'a'.repeat(64)],
  ];

  for (const [nome, caminho] of TELAS) {
    for (const w of LARGURAS) {
      t(`${nome} cabe em ${w}px`, async () => {
        const page = await browser.newPage();
        try {
          const m = await medir(page, base + caminho, w);
          assert(m.estouro <= 1,
            `estoura ${m.estouro}px além dos ${m.largura} disponíveis — ` +
            (m.culpados.length ? m.culpados.join(', ') : 'sem culpado identificado'));
          assert(m.pequenos.length === 0,
            'campo abaixo de 16px (o iOS daria zoom ao focar): ' + m.pequenos.join(', '));
        } finally { await page.close(); }
      });
    }
  }

  t('a faixa de abas rola e a aba ativa fica visivel em 320px', async () => {
    const page = await browser.newPage();
    try {
      const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', 320);
      const r = await frame.evaluate(async () => {
        const f = document.getElementById('pedTabs');
        if (!f || !f.children.length) return { erro: 'a faixa de abas não montou' };
        const rolavel = f.scrollWidth > f.clientWidth + 1;
        const cssVar = (n) => getComputedStyle(f).getPropertyValue(n).trim();
        // No começo há conteúdo à DIREITA: é ali que o desvanecido precisa
        // aparecer. Lê-lo depois de rolar até o fim daria 0px — corretamente,
        // porque ali não sobra nada — e reprovaria um indicador que funciona.
        const fadeInicial = cssVar('--tabs-fade-dir');

        // Ativa a última aba e confere que ela entrou na área visível.
        const ultima = f.children[f.children.length - 1];
        ultima.click();
        await new Promise((s) => setTimeout(s, 700));
        const cf = f.getBoundingClientRect(), cu = ultima.getBoundingClientRect();
        return {
          rolavel, fadeInicial,
          // No fim da faixa o desvanecido troca de lado: some à direita, nasce
          // à esquerda. É o que diz "dá para voltar".
          fadeFinalEsq: cssVar('--tabs-fade-esq'),
          fadeFinalDir: cssVar('--tabs-fade-dir'),
          visivel: cu.left >= cf.left - 2 && cu.right <= cf.right + 2,
          nAbas: f.children.length,
        };
      });
      assert(!r.erro, r.erro);
      assert(r.nAbas >= 7, `só ${r.nAbas} abas montaram — o cenário não exercita a rolagem`);
      assert(r.rolavel, 'as abas foram espremidas na largura em vez de rolar');
      assert(r.fadeInicial && r.fadeInicial !== '0px',
        'sem indicação de continuidade à direita: nada diz que há mais abas');
      assert(r.fadeFinalEsq && r.fadeFinalEsq !== '0px',
        'no fim da faixa nada indica que dá para voltar');
      assert(r.fadeFinalDir === '0px',
        'o desvanecido continua à direita mesmo sem conteúdo — indica continuidade que não existe');
      assert(r.visivel, 'a aba ativa ficou fora da área visível depois do clique');
    } finally { await page.close(); }
  });

  t('o painel de acoes cabe na tela e mostra os rotulos de ORCAMENTO', async () => {
    const page = await browser.newPage();
    try {
      const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', 390);
      const r = await frame.evaluate(async () => {
        abrirDrawer();
        await new Promise((s) => setTimeout(s, 300));
        const d = document.querySelector('.drawer-right');
        const cr = d.getBoundingClientRect();
        const rotulos = [...document.querySelectorAll('#drawerBody .btn')].map((b) => b.textContent.trim());
        const baixos = rotulos.filter((_, i) =>
          document.querySelectorAll('#drawerBody .btn')[i].getBoundingClientRect().height < 36);
        return {
          titulo: document.getElementById('drawerTitulo').textContent,
          largura: cr.width, dentro: cr.right <= window.innerWidth + 1 && cr.left >= -1,
          rotulos, baixos,
        };
      });
      assert(r.titulo === 'Ações do orçamento', `o título diz "${r.titulo}"`);
      assert(r.dentro, `o painel sai da tela (largura ${Math.round(r.largura)}px em 390px)`);
      assert(r.largura >= 280, `o painel ficou estreito demais: ${Math.round(r.largura)}px`);
      assert(r.baixos.length === 0, 'botão do painel abaixo de 36px: ' + r.baixos.join(', '));
      // A separação não pode estar aqui: o documento é um orçamento.
      const sep = r.rotulos.filter((x) => /separação/i.test(x));
      assert(sep.length === 0, 'o orçamento oferece lista de separação: ' + sep.join(', '));
      for (const esperado of ['Baixar PDF do orçamento', 'Enviar orçamento via WhatsApp']) {
        assert(r.rotulos.some((x) => x === esperado), `falta a ação "${esperado}"`);
      }
    } finally { await page.close(); }
  });

  for (const w of [320, 390]) {
    t(`a descricao do item ja adicionado aparece inteira em ${w}px`, async () => {
      const page = await browser.newPage();
      try {
        const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', w);
        const r = await frame.evaluate(async () => {
          // Painel oculto mede zero: sem ativar a aba, tudo daria 0px e o teste
          // passaria por não estar olhando nada.
          await ativarAba('itens');
          await new Promise((s) => setTimeout(s, 250));
          const td = document.querySelector('#tbItens td.col-descricao');
          if (!td) return { erro: 'a tabela de itens não montou' };
          const campo = td.querySelector('textarea') || td;
          const est = getComputedStyle(campo);
          const rc = campo.getBoundingClientRect();
          return {
            tag: campo.tagName.toLowerCase(),
            texto: (campo.value || campo.textContent || '').trim(),
            // Conteúdo mais alto que a caixa = parte do texto está escondida.
            cortado: campo.scrollHeight > campo.clientHeight + 2,
            ellipsis: est.textOverflow === 'ellipsis',
            nowrap: est.whiteSpace === 'nowrap',
            fonte: parseFloat(est.fontSize),
            largura: Math.round(rc.width),
            dentro: rc.right <= document.documentElement.clientWidth + 1,
            // Os dados operacionais continuam à mão no card.
            rotulos: [...document.querySelectorAll('#tbItens td[data-rot]')]
              .map((c) => c.getAttribute('data-rot')),
          };
        });
        assert(!r.erro, r.erro);
        assert(r.texto.includes('MEIO TEMPERO COMPLETO COM AÇAFRÃO'),
          `a descrição chegou truncada ao campo: "${r.texto}"`);
        assert(!r.cortado, 'a descrição não cabe no campo: parte do texto continua escondida');
        assert(!r.ellipsis, 'a descrição usa reticências — foi isso que cortou o nome');
        assert(!r.nowrap, 'a descrição está em nowrap: não quebra em duas linhas');
        assert(r.fonte >= 16, `fonte de ${r.fonte}px — o Safari daria zoom ao focar`);
        assert(r.dentro, 'o campo passa da largura da tela');
        assert(r.largura >= 200, `campo de ${r.largura}px — estreito demais para reconhecer o produto`);
        for (const esperado of ['Qtd', 'V.Unit', 'Total', 'Produto']) {
          assert(r.rotulos.includes(esperado), `o card perdeu "${esperado}"`);
        }
      } finally { await page.close(); }
    });
  }

  t('o CFOP sai do card mobile, mas continua no documento e no desktop', async () => {
    const page = await browser.newPage();
    try {
      // ── Celular: fora da vista ──────────────────────────────────────────
      const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', 390);
      const mob = await frame.evaluate(async () => {
        await ativarAba('itens');
        await new Promise((s) => setTimeout(s, 250));
        const td = document.querySelector('#tbItens td.col-cfop');
        if (!td) return { erro: 'a célula de CFOP sumiu do HTML — era para sumir só da vista' };
        // O CFOP é um <input list="cfops-datalist">, não um <select>.
        const sel = td.querySelector('input, select');
        return {
          visivel: getComputedStyle(td).display !== 'none',
          altura: td.getBoundingClientRect().height,
          // O dado tem de continuar aqui: escondido não é o mesmo que removido.
          temCampo: !!sel,
          valor: sel ? sel.value : null,
          salva: !!(sel && /salvarItemCampo\(\d+,'cfop'/.test(sel.getAttribute('onchange') || '')),
          rotulos: [...document.querySelectorAll('#tbItens td[data-rot]')]
            .filter((c) => getComputedStyle(c).display !== 'none')
            .map((c) => c.getAttribute('data-rot')),
        };
      });
      assert(!mob.erro, mob.erro);
      assert(!mob.visivel, 'o CFOP continua aparecendo no card do celular');
      assert(mob.altura === 0, `a célula escondida ainda ocupa ${mob.altura}px no card`);
      assert(mob.temCampo, 'o campo de CFOP saiu do DOM — isso mudaria o que é salvo');
      assert(mob.salva, 'o campo perdeu a gravação do CFOP (salvarItemCampo)');
      // O que o card precisa mostrar continua lá.
      for (const esperado of ['Produto', 'Descrição', 'Qtd', 'V.Unit', 'Total']) {
        assert(mob.rotulos.includes(esperado), `o card perdeu "${esperado}"`);
      }
      assert(!mob.rotulos.includes('CFOP'), 'o CFOP ainda consta entre os campos visíveis');

      // ── Computador: intocado ────────────────────────────────────────────
      const desk = await abrirTela(page, base + '/comercial/pedido.html?id=1', 1280);
      const d = await desk.evaluate(async () => {
        await ativarAba('itens');
        await new Promise((s) => setTimeout(s, 250));
        const td = document.querySelector('#tbItens td.col-cfop');
        return { visivel: td && getComputedStyle(td).display !== 'none',
                 temCampo: !!(td && td.querySelector('input, select')) };
      });
      assert(d.visivel, 'o CFOP também sumiu no computador — ali ele é que é ajustado');
      assert(d.temCampo, 'o campo de CFOP do desktop sumiu');
    } finally { await page.close(); }
  });

  t('editar quantidade e valor continua funcionando no card', async () => {
    const page = await browser.newPage();
    try {
      const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', 360);
      const r = await frame.evaluate(async () => {
        await ativarAba('itens');
        await new Promise((s) => setTimeout(s, 250));
        const qtd = document.querySelector('#tbItens input[data-campo="qtd"]');
        const pu  = document.querySelector('#tbItens input[data-campo="pu"]');
        if (!qtd || !pu) return { erro: 'os campos de quantidade/valor sumiram do card' };
        qtd.value = '3'; qtd.dispatchEvent(new Event('input', { bubbles: true }));
        pu.value = '10'; pu.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((s) => setTimeout(s, 150));
        const total = document.querySelector('#tbItens [data-campo="total"]');
        return {
          total: total ? total.textContent.trim() : null,
          alcancaveis: [qtd, pu].every((el) => {
            const c = el.getBoundingClientRect();
            return c.width > 0 && c.height >= 30 && c.right <= document.documentElement.clientWidth + 1;
          }),
        };
      });
      assert(!r.erro, r.erro);
      // 3 × R$ 10,00 — o recálculo da linha continua ligado aos campos do card.
      assert(/30[.,]00/.test(r.total || ''), `o total não recalculou: "${r.total}"`);
      assert(r.alcancaveis, 'os campos de quantidade/valor saem da tela ou ficam pequenos demais');
    } finally { await page.close(); }
  });

  t('o cabecalho tem so Salvar e Acoes, e ambos cabem em 320px', async () => {
    const page = await browser.newPage();
    try {
      const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', 320);
      const r = await frame.evaluate(() => {
        const btns = [...document.querySelectorAll('#hActions .btn')];
        return {
          rotulos: btns.map((b) => b.textContent.trim()),
          estouram: btns.filter((b) => b.getBoundingClientRect().right
                                      > document.documentElement.clientWidth + 1).length,
          baixos: btns.filter((b) => b.getBoundingClientRect().height < 40).length,
        };
      });
      assert(r.rotulos.length === 2, 'o cabeçalho tem ' + r.rotulos.length
        + ' botões: ' + r.rotulos.join(', '));
      assert(r.rotulos.join(',') === 'Salvar,Ações', 'os botões são: ' + r.rotulos.join(', '));
      assert(r.estouram === 0, 'botão do cabeçalho sai da tela em 320px');
      assert(r.baixos === 0, 'botão do cabeçalho abaixo de 40px de altura');
    } finally { await page.close(); }
  });

  t('o titulo dos itens diz ORCAMENTO quando o documento e orcamento', async () => {
    const page = await browser.newPage();
    try {
      const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', 390);
      const orc = await frame.evaluate(() => ({
        itens: document.getElementById('tituloItens').textContent,
        voltar: document.getElementById('lnkVoltar').textContent,
        validade: document.getElementById('lblValidade').textContent,
      }));
      assert(/Itens do orçamento/i.test(orc.itens), `título diz "${orc.itens}"`);
      assert(/orçamento/i.test(orc.validade), `validade diz "${orc.validade}"`);
      assert(/orçamento/i.test(orc.voltar), `voltar diz "${orc.voltar}"`);

      // O mesmo documento, agora como PEDIDO, tem de dizer "pedido".
      const ped = await frame.evaluate(() => {
        pedidoAtual.modoDocumento = 'pedido';
        renderHeader();
        return {
          itens: document.getElementById('tituloItens').textContent,
          validade: document.getElementById('lblValidade').textContent,
          drawer: (abrirDrawer(), document.getElementById('drawerTitulo').textContent),
        };
      });
      assert(/Itens do pedido/i.test(ped.itens), `como pedido, o título diz "${ped.itens}"`);
      assert(/Validade do pedido/i.test(ped.validade), `como pedido, a validade diz "${ped.validade}"`);
      assert(ped.drawer === 'Ações do pedido', `o painel diz "${ped.drawer}"`);
    } finally { await page.close(); }
  });

  t('a descricao longa aparece inteira no formulario de item', async () => {
    const page = await browser.newPage();
    try {
      const frame = await abrirTela(page, base + '/comercial/pedido.html?id=1', 390);
      const r = await frame.evaluate(() => {
        const el = document.getElementById('itDesc');
        if (!el) return { erro: 'o campo de descrição não existe' };
        el.value = 'MEIO TEMPERO COMPLETO COM AÇAFRÃO - FARDO COM 24 UNIDADES DE 400G CADA';
        ajustarAltura(el);
        return {
          tag: el.tagName.toLowerCase(),
          // Se o conteúdo é mais alto que a caixa, parte do texto está oculta.
          cortado: el.scrollHeight > el.clientHeight + 2,
          fonte: parseFloat(getComputedStyle(el).fontSize),
          largura: el.getBoundingClientRect().right <= window.innerWidth + 1,
        };
      });
      assert(!r.erro, r.erro);
      assert(r.tag === 'textarea', `o campo ainda é <${r.tag}> — nome longo continuaria cortado`);
      assert(!r.cortado, 'a descrição longa não cabe: parte do texto continua escondida');
      assert(r.fonte >= 16, `fonte de ${r.fonte}px — o Safari daria zoom ao focar`);
      assert(r.largura, 'o campo passa da largura da tela');
    } finally { await page.close(); }
  });

  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  await browser.close();
  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
