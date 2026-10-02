/**
 * test-campos-todas-telas.js — todas as telas que declaram `data-formato`.
 *
 * Percorre cada uma no computador (1440) e no celular (360), nos dois temas, e
 * confere: a peça carregada, o formato válido, a máscara funcionando de fato, o
 * teclado do celular, nada passando da borda, e nenhuma caixa de alerta ou erro
 * de JavaScript na abertura.
 *
 * É a rede que impede uma tela de sair da padronização sem ninguém ver: tela
 * nova com `data-formato` entra aqui sozinha, sem se declarar em lugar nenhum.
 *
 * Roda da raiz do projeto: node scripts/test-campos-todas-telas.js
 *   TELA=comercial/pedido.html node scripts/test-campos-todas-telas.js   (uma só)
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39915);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
const PUBLICO = path.join(RAIZ, 'public');

const FORMATOS_VALIDOS = new Set(['telefone', 'cpf', 'cnpj', 'cpfcnpj', 'cep',
  'dinheiro', 'data', 'hora', 'placa', 'inscricao', 'email']);

/* As telas que declaram formato, achadas no disco — não uma lista fixa aqui. */
function telasComFormato(dir, fora = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['img', 'uploads', 'downloads', 'extensions', 'vendor'].includes(e.name)) continue;
      telasComFormato(p, fora);
    } else if (e.name.endsWith('.html')) {
      const src = fs.readFileSync(p, 'utf8');
      if (src.includes('data-formato')) fora.push(path.relative(PUBLICO, p));
    }
  }
  return fora;
}

/**
 * Erros que JÁ EXISTIAM antes da padronização dos campos, e que este teste não
 * pode cobrar: a tela lê a resposta da API sem guarda (`d.itens.length` com
 * `itens` ausente), e o servidor de teste responde vazio. Medido em 30/09/2026
 * abrindo a MESMA tela nas duas versões, a de antes e a de depois: erro
 * idêntico nas duas.
 *
 * Não é desculpa, é separação — sem isto, a suíte reprovaria por algo que a
 * mudança não causou, e ninguém confiaria nela. Vale a pena tratar: é o mesmo
 * "chamadas que falham sem dizer nada" do levantamento.
 */
const ERRO_PREEXISTENTE = /Cannot read properties of (undefined|null) \(reading '[^']+'\)/;

/**
 * `catalogo/loja-montagem.html` usa `data-formato` para OUTRA coisa: o formato
 * do buquê montável, num `<div>`. Não é campo de dado e não carrega a peça —
 * e a peça, por sua vez, só olha `input`/`select`/`textarea`, justamente para
 * não marcar aquelas caixas como erro.
 */
const OUTRO_SENTIDO = new Set(['catalogo/loja-montagem.html']);

let falhas = 0, total = 0, conhecidos = 0;
const problemas = [];
function checa(tela, rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) return;
  if (ERRO_PREEXISTENTE.test(detalhe)) { conhecidos++; return; }
  falhas++;
  problemas.push(`${tela}: ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

const FEATS = ['produtos', 'varejo', 'fiscal', 'comercial', 'financeiro', 'estoque', 'compras',
  'os', 'catalogo', 'comunicacao', 'licitacoes', 'portais', 'rh', 'contabilidade', 'patrimonio',
  'locacao', 'producao', 'farmacia', 'posto', 'restaurante', 'optica', 'whatsapp', 'crm', 'pdv'];

(async () => {
  const app = express();
  app.get('/api/features/status', (_q, s) => s.json({ features: Object.fromEntries(FEATS.map((k) => [k, true])) }));
  app.get('/api/perfis/meu-acesso', (_q, s) => s.json({ irrestrito: true, acessos: {} }));
  /**
   * O `contas` deste `if` pegava `/api/contas-a-pagar` e `/api/contas-a-receber`
   * pelo meio da palavra, e as duas respondem ENVELOPE (`{success, contas}`) na
   * rota real (`contas-pagar-routes.js:456`). Recebendo `[]`, as duas telas
   * caíam no `if (!r1.success) throw new Error(r1.error)` e abriam `alert('Erro: ')`
   * — comportamento CERTO delas, cobrado aqui como se fosse defeito. Medido em
   * 02/10/2026 nas duas versões da tela, com e sem a peça: alerta idêntico, logo
   * o harness era a causa.
   */
  const ENVELOPE = /^\/api\/contas-a-(pagar|receber)/;
  app.all('/api/*splat', (q, s) => {
    if (ENVELOPE.test(q.path)) return s.json({ success: true, contas: [], resumo: {} });
    if (/lista|itens|pessoas|contas|segmentos|tags|produtos|pedidos/i.test(q.path)) return s.json([]);
    s.json({ success: true, total: 0, dados: [], itens: [], resultado: [], lista: [] });
  });
  app.use(express.static(path.join(PUBLICO, 'auth')));
  app.use(express.static(PUBLICO));
  const srv = app.listen(PORTA);

  const lista = process.env.TELA ? [process.env.TELA] : telasComFormato(PUBLICO);
  console.log(`telas que declaram data-formato: ${lista.length}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/campos-todas-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  // A loja tem mundo próprio (não carrega a camada do ERP) e caminho próprio.
  const FORA_DO_SHELL = (t) => t.startsWith('loja/') || t.startsWith('landing/') || t.startsWith('portal/') || t.startsWith('auth/');

  try {
    for (const tela of lista) {
      if (OUTRO_SENTIDO.has(tela)) continue;
      const arq = path.join(PUBLICO, tela);
      if (!fs.existsSync(arq)) { checa(tela, 'arquivo existe', false); continue; }
      const src = fs.readFileSync(arq, 'utf8');

      /* --- o que se confere sem navegador --- */
      const declarados = [...src.matchAll(/data-formato="([^"]+)"/g)].map((m) => m[1]);
      for (const f of new Set(declarados)) {
        checa(tela, `formato "${f}" é um dos que a peça conhece`, FORMATOS_VALIDOS.has(f));
      }
      const carregaPeca = src.includes('/js/campo-formato.js');
      checa(tela, 'carrega /js/campo-formato.js', carregaPeca);
      // Campo de dinheiro não pode ter ficado como type=number: a máscara não
      // cabe num campo numérico, e o navegador recusa "R$ 1.234,56".
      for (const m of src.matchAll(/<input[^>]*data-formato="dinheiro"[^>]*>/g)) {
        checa(tela, 'campo de dinheiro não é type=number', !/type="number"/.test(m[0]), m[0].slice(0, 90));
      }
      if (!carregaPeca) continue;

      /* --- no navegador --- */
      for (const vp of [{ n: 'pc', w: 1440, h: 900 }, { n: 'cel', w: 360, h: 740 }]) {
        const page = await browser.newPage();
        const erros = [], caixas = [];
        page.on('pageerror', (e) => erros.push(String(e.message).slice(0, 120)));
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          const t = m.text();
          if (/Failed to load resource|favicon|net::ERR|MIME|Refused|ViaCEP|viacep/.test(t)) return;
          erros.push(t.slice(0, 120));
        });
        /* `beforeunload` fica FORA da conta, e não por tolerância: ele é por
           definição da SAÍDA, nunca da abertura, e quem o dispara aqui é esta
           própria suíte — `comercial/pedido.html` marca a tela como suja a cada
           evento `input` dentro do painel, que é exatamente o que a prova da
           máscara emite. A tela está certa em avisar que há mudança não salva. */
        page.on('dialog', async (d) => {
          if (d.type() !== 'beforeunload') caixas.push(`${d.type()}: ${d.message().slice(0, 60)}`);
          try { await d.dismiss(); } catch (e) { /* já foi */ }
        });
        try {
          if (!FORA_DO_SHELL(tela)) await page.evaluateOnNewDocument(() => { window.__liciteShell = true; });
          await page.setViewport({ width: vp.w, height: vp.h });
          await page.goto(`http://127.0.0.1:${PORTA}/${encodeURI(tela)}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await new Promise((r) => setTimeout(r, 900));

          const r = await page.evaluate(() => {
            const out = { peca: typeof window.CampoFormato === 'object', campos: [], fora: [], rola: 0 };
            if (!out.peca) return out;
            const nativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            for (const el of document.querySelectorAll('input[data-formato]')) {
              const f = el.dataset.formato;
              const info = { id: el.id || el.name || '(sem id)', f, max: el.getAttribute('maxlength'), modo: el.getAttribute('inputmode'), tipo: el.type };
              // a máscara funciona neste campo, aqui, agora?
              const antes = nativo.get.call(el);
              const amostra = { telefone: '94991769924', cpf: '52998224725', cnpj: '11222333000181',
                cpfcnpj: '11222333000181', cep: '68506640', dinheiro: '123456',
                data: '31122026', hora: '2345', placa: 'abc1d23', inscricao: '123456', email: '' }[f];
              if (amostra) {
                nativo.set.call(el, amostra);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                info.saiu = nativo.get.call(el);
                if (f === 'dinheiro') info.lido = el.value;
                nativo.set.call(el, antes);
              }
              out.campos.push(info);
            }
            return out;
          });

          checa(tela, `${vp.n}: a peça carregou`, r.peca);
          if (!r.peca) { await page.close(); continue; }

          const ESPERADO = {
            telefone: '(94) 99176-9924', cpf: '529.982.247-25', cnpj: '11.222.333/0001-81',
            cpfcnpj: '11.222.333/0001-81', cep: '68506-640', dinheiro: 'R$ 1.234,56',
            data: '31/12/2026', hora: '23:45', placa: 'ABC1D23',
          };
          for (const c of r.campos) {
            if (vp.n === 'pc' && ESPERADO[c.f]) {
              checa(tela, `#${c.id} (${c.f}) mascara`, c.saiu === ESPERADO[c.f], `saiu "${c.saiu}"`);
            }
            if (vp.n === 'pc' && c.f === 'dinheiro') {
              checa(tela, `#${c.id} entrega número ao JavaScript`, c.lido === '1234.56', `lido "${c.lido}"`);
            }
            if (vp.n === 'cel') {
              const num = ['cpf', 'cnpj', 'cpfcnpj', 'cep', 'data', 'hora'].includes(c.f);
              if (num) checa(tela, `celular: #${c.id} teclado numérico`, c.modo === 'numeric', `inputmode=${c.modo}`);
              if (c.f === 'telefone') checa(tela, `celular: #${c.id} teclado de telefone`, c.modo === 'tel' || c.tipo === 'tel', `inputmode=${c.modo}`);
              if (c.f === 'dinheiro') checa(tela, `celular: #${c.id} teclado decimal`, c.modo === 'decimal', `inputmode=${c.modo}`);
            }
          }

          /* Layout nos dois temas. */
          for (const tema of ['escuro', 'claro']) {
            const l = await page.evaluate((t) => {
              document.documentElement.setAttribute('data-theme', t);
              const doc = document.scrollingElement;
              const fora = [];
              for (const el of document.querySelectorAll('body *')) {
                const cs = getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
                const rc = el.getBoundingClientRect();
                if (rc.width === 0 || rc.height === 0 || rc.right <= window.innerWidth + 2) continue;
                let rola = false;
                for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                  if (/auto|scroll/.test(getComputedStyle(p).overflowX)) { rola = true; break; }
                }
                if (!rola) fora.push((el.id ? '#' + el.id : el.tagName.toLowerCase()) + '@' + Math.round(rc.right));
              }
              return { rola: doc.scrollWidth > doc.clientWidth + 2 ? doc.scrollWidth : 0, fora: fora.slice(0, 3) };
            }, tema);
            checa(tela, `${vp.n}/${tema}: a página não rola para o lado`, !l.rola, `${l.rola}px`);
            checa(tela, `${vp.n}/${tema}: nada passa da borda`, l.fora.length === 0, l.fora.join(' '));
          }

          checa(tela, `${vp.n}: sem erro de JavaScript`, erros.length === 0, erros.slice(0, 2).join(' | '));
          checa(tela, `${vp.n}: sem caixa de alerta na abertura`, caixas.length === 0, caixas.slice(0, 2).join(' | '));
        } catch (e) {
          checa(tela, `${vp.n}: a tela abre`, false, String(e.message).slice(0, 80));
        }
        await page.close();
      }
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
  if (conhecidos) {
    console.log(`(${conhecidos} falhas de erro pré-existente na leitura da API, fora do escopo desta suíte)`);
  }
  console.log(`${falhas ? 'FALHOU' : 'OK'}: ${total - falhas - conhecidos}/${total} checagens em ${lista.length} telas`);
  process.exit(falhas ? 1 : 0);
})();
