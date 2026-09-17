/**
 * Faturamento do contrato por nota avulsa — o que a pessoa vê e toca.
 *
 * As rotas estão presas em `test-contrato-nfse-avulsa.js`. Aqui é a tela:
 * interações REAIS no Chrome, porque existir no DOM não prova que aparece —
 * um bloco pode nascer com altura zero e o teste de DOM passa igual.
 *
 * Duas telas entram: a do contrato (bloco das notas, modal de vínculo) e a de
 * NFSe chamada com ?contratoId=N (pré-preenchimento e carimbo do vínculo).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const NOTAS = [
  { id: 11, nNFSe: '221', nDPS: 221, serie: '1', tomadorRazaoSocial: 'TRE-MG',
    descricaoServico: 'Certificados 2027', valorServico: 1600, dataCompetencia: '2027-01-15',
    status: 'autorizada', dataCriacao: '2027-01-15' },
  { id: 10, nNFSe: '210', nDPS: 210, serie: '1', tomadorRazaoSocial: 'TRE-MG',
    descricaoServico: 'Certificados 2026', valorServico: 1600, dataCompetencia: '2026-01-15',
    status: 'cancelada', dataCriacao: '2026-01-15' },
];
const CONTRATO = { id: 3, numero: 'CT-2026-0003', clienteId: 1, clienteNome: 'TRIBUNAL REGIONAL ELEITORAL DE MINAS GERAIS',
  clienteCpfCnpj: '05940740000121', descricao: 'CERTIFICADOS', valorMensal: 1600,
  periodicidade: 'anual', status: 'ativo', dataInicio: '2026-01-01', dataFim: '2029-01-01' };

// Cada caso escolhe o que o backend devolve antes de abrir a tela.
const ESTADO = { notasAvulsas: NOTAS, vinculou: null };

function subirServidor() {
  const srv = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    const ler = (cb) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => cb(b)); };

    if (url === '/api/contratos/3') {
      return json({ success: true, contrato: CONTRATO, eventos: [], recorrencia: null, itens: [],
                    notasAvulsas: ESTADO.notasAvulsas, osAutomatica: null, mesesVigencia: 36 });
    }
    if (url === '/api/contratos/3/nfse-disponiveis') {
      return json({ success: true,
        contrato: { id: 3, numero: 'CT-2026-0003', clienteNome: CONTRATO.clienteNome },
        notas: [{ id: 12, nNFSe: '230', nDPS: 230, tomadorRazaoSocial: 'TRE-MG',
                  descricaoServico: 'Certificados 2028', valorServico: 1600,
                  dataCompetencia: '2028-01-10', status: 'autorizada' }] });
    }
    if (url === '/api/contratos/3/vincular-nfse' && req.method === 'POST') {
      return ler((b) => { try { ESTADO.vinculou = JSON.parse(b); } catch (_) {} json({ success: true }); });
    }
    if (url === '/api/pessoas/1') {
      return json({ success: true, pessoa: { id: 1, cpfCnpj: '05940740000121',
        razaoSocial: CONTRATO.clienteNome, email: 'nf@tre-mg.jus.br', endereco: 'Av. Prudente de Morais',
        numero: '100', bairro: 'Cidade Jardim', codigoMunicipio: '3106200', uf: 'MG', cep: '30380000' } });
    }
    if (url === '/api/nfse/config') {
      return json({ success: true, config: { ambiente: '2', serie: '1', proximo_numero: '1',
        cod_municipio: '3106200' }, prestador: { razaoSocial: 'EMPRESA TESTE' } });
    }
    if (url.startsWith('/api/')) return json({ success: true, anexos: [], itens: [], eventos: [], notas: [], pessoas: [] });

    if (url === '/__e') {
      const alvo = new URLSearchParams(req.url.split('?')[1] || '').get('tela') || '/comercial/contrato.html?id=3';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(`<!doctype html><meta charset="utf-8">
        <style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style>
        <iframe id="tela" src="${alvo}"></iframe>`);
    }

    const arq = path.join(PUB, url.replace(/^\//, ''));
    if (!arq.startsWith(PUB) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) {
      res.statusCode = 404; return res.end('x');
    }
    res.setHeader('Content-Type', TIPOS[path.extname(arq)] || 'application/octet-stream');
    res.end(fs.readFileSync(arq));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let browser, srv, base;

async function abrir(tela) {
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push(`${e.name}: ${e.message}`));
  await page.setViewport({ width: 1280, height: 900 });
  const q = tela ? '?tela=' + encodeURIComponent(tela) : '';
  await page.goto(base + '/__e' + q, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 2300));
  const frame = await (await page.$('#tela')).contentFrame();
  if (!frame) throw new Error('a tela não carregou');
  return { page, frame, erros };
}

// ============================================================================
// A. Bloco das notas na tela do contrato
// ============================================================================

t('A1. o bloco aparece com as notas, o total e as duas ações', async () => {
  ESTADO.notasAvulsas = NOTAS;
  const { page, frame, erros } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const sec = document.getElementById('secNotas');
      const el = document.getElementById('notasAvulsas');
      const link = el.querySelector('a[href*="nfse.html"]');
      const botoes = [...el.querySelectorAll('button')].map(b => b.textContent.trim());
      return {
        alturaSec: Math.round(sec.getBoundingClientRect().height),
        visivel: sec.offsetParent !== null,
        texto: el.textContent.replace(/\s+/g, ' ').trim(),
        linhas: el.querySelectorAll('tr').length,
        href: link ? link.getAttribute('href') : null,
        alturaLink: link ? Math.round(link.getBoundingClientRect().height) : 0,
        botoes,
      };
    });
    assert(r.visivel && r.alturaSec > 40, `bloco com ${r.alturaSec}px — não está na tela`);
    assert(/221/.test(r.texto) && /210/.test(r.texto), 'as duas notas deveriam aparecer: ' + r.texto);
    // Cabeçalho + 2 notas + total.
    assert(r.linhas === 4, 'linhas na tabela: ' + r.linhas);
    assert(/3\.200,00/.test(r.texto), 'total vinculado errado ou ausente: ' + r.texto);
    assert(r.href === '/fiscal/nfse.html?contratoId=3', 'link de emissão: ' + r.href);
    assert(r.alturaLink > 10, `o botão de emitir está achatado (${r.alturaLink}px)`);
    assert(r.botoes.some(b => /Vincular nota/i.test(b)), 'faltou o botão de vincular: ' + r.botoes.join(' | '));
    assert(!erros.length, 'erro na página: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('A2. status da nota aparece com a cor certa (cancelada não passa por autorizada)', async () => {
  ESTADO.notasAvulsas = NOTAS;
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const badges = [...document.querySelectorAll('#notasAvulsas .badge')];
      return badges.map(b => ({ txt: b.textContent.trim(), cls: b.className }));
    });
    const aut = r.find(b => b.txt === 'autorizada');
    const can = r.find(b => b.txt === 'cancelada');
    assert(aut && /entrada/.test(aut.cls), 'autorizada deveria usar a badge de ok: ' + JSON.stringify(aut));
    assert(can && /inativo/.test(can.cls), 'cancelada deveria usar a badge apagada: ' + JSON.stringify(can));
  } finally { await page.close(); }
});

t('A3. sem nota vinculada, o convite traz as mesmas duas ações', async () => {
  ESTADO.notasAvulsas = [];
  const { page, frame, erros } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const el = document.getElementById('notasAvulsas');
      return {
        visivel: document.getElementById('secNotas').offsetParent !== null,
        texto: el.textContent.replace(/\s+/g, ' ').trim(),
        temLink: !!el.querySelector('a[href="/fiscal/nfse.html?contratoId=3"]'),
        temBotao: [...el.querySelectorAll('button')].some(b => /Vincular nota/i.test(b.textContent)),
      };
    });
    assert(r.visivel, 'o bloco sumiu no estado vazio');
    assert(/Nenhuma nota vinculada/i.test(r.texto), 'texto do estado vazio: ' + r.texto);
    assert(r.temLink && r.temBotao, 'estado vazio precisa das duas portas');
    assert(!erros.length, 'erro na página: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('A4. tenant sem o módulo de NFSe não vê o bloco', async () => {
  ESTADO.notasAvulsas = null;
  const { page, frame } = await abrir();
  try {
    const r = await frame.evaluate(() => {
      const sec = document.getElementById('secNotas');
      return { visivel: sec.offsetParent !== null, altura: Math.round(sec.getBoundingClientRect().height) };
    });
    assert(!r.visivel && r.altura === 0, `bloco visível sem o módulo (${r.altura}px)`);
  } finally { await page.close(); }
});

t('A5. o modal abre, lista a nota livre e manda o id no vínculo', async () => {
  ESTADO.notasAvulsas = NOTAS;
  ESTADO.vinculou = null;
  const { page, frame, erros } = await abrir();
  try {
    await frame.evaluate(() => {
      [...document.querySelectorAll('#notasAvulsas button')]
        .find(b => /Vincular nota/i.test(b.textContent)).click();
    });
    await new Promise((r) => setTimeout(r, 700));
    const aberto = await frame.evaluate(() => {
      const m = document.getElementById('modalVincularNfse');
      return {
        aberto: m.classList.contains('open'),
        altura: Math.round(m.getBoundingClientRect().height),
        texto: m.textContent.replace(/\s+/g, ' ').trim(),
        radios: m.querySelectorAll('input[name="vincNfse"]').length,
      };
    });
    assert(aberto.aberto && aberto.altura > 50, `modal não apareceu (${aberto.altura}px)`);
    assert(aberto.radios === 1, 'notas oferecidas: ' + aberto.radios);
    assert(/230/.test(aberto.texto), 'a nota livre deveria aparecer: ' + aberto.texto);

    await frame.evaluate(() => {
      document.querySelector('input[name="vincNfse"]').checked = true;
      [...document.querySelectorAll('#modalVincularNfse button')]
        .find(b => b.textContent.trim() === 'Vincular').click();
    });
    await new Promise((r) => setTimeout(r, 900));
    assert(ESTADO.vinculou && ESTADO.vinculou.nfseId === 12,
      'payload enviado: ' + JSON.stringify(ESTADO.vinculou));
    assert(!erros.length, 'erro na página: ' + erros.join(' | '));
  } finally { await page.close(); }
});

// ============================================================================
// B. A tela de NFSe chamada pelo contrato
// ============================================================================

t('B1. ?contratoId preenche tomador, valor e descrição, e avisa do vínculo', async () => {
  const { page, frame, erros } = await abrir('/fiscal/nfse.html?contratoId=3');
  try {
    const r = await frame.evaluate(() => {
      const v = (id) => document.getElementById(id).value;
      const aviso = document.getElementById('avisoContrato');
      return {
        cpfCnpj: v('tomaCpfCnpj'), razao: v('tomaRazaoSocial'), email: v('tomaEmail'),
        logradouro: v('tomaLogradouro'), municipio: v('tomaCodMunicipio'),
        descricao: v('servDescricao'), valor: v('servValor'),
        avisoVisivel: aviso.offsetParent !== null,
        avisoAltura: Math.round(aviso.getBoundingClientRect().height),
        avisoTexto: aviso.textContent.replace(/\s+/g, ' ').trim(),
        voltar: aviso.querySelector('a') ? aviso.querySelector('a').getAttribute('href') : null,
      };
    });
    assert(r.cpfCnpj === '05940740000121', 'CNPJ do tomador: ' + r.cpfCnpj);
    assert(/TRIBUNAL/.test(r.razao), 'razão social: ' + r.razao);
    // O endereço vem do cadastro da pessoa, não do contrato.
    assert(r.logradouro === 'Av. Prudente de Morais' && r.municipio === '3106200',
      'endereço não veio do cadastro: ' + r.logradouro + ' / ' + r.municipio);
    assert(r.email === 'nf@tre-mg.jus.br', 'e-mail: ' + r.email);
    assert(r.descricao === 'CERTIFICADOS', 'descrição: ' + r.descricao);
    // Contrato anual: o valor do período é o do ano, não um doze avos.
    assert(Number(r.valor) === 1600, 'valor: ' + r.valor);
    assert(r.avisoVisivel && r.avisoAltura > 10, `aviso do contrato invisível (${r.avisoAltura}px)`);
    assert(/CT-2026-0003/.test(r.avisoTexto), 'aviso sem o número do contrato: ' + r.avisoTexto);
    assert(r.voltar === '/comercial/contrato.html?id=3', 'link de volta: ' + r.voltar);
    assert(!erros.length, 'erro na página: ' + erros.join(' | '));
  } finally { await page.close(); }
});

t('B2. sem ?contratoId a tela segue avulsa, sem aviso e sem campo preenchido', async () => {
  const { page, frame, erros } = await abrir('/fiscal/nfse.html');
  try {
    const r = await frame.evaluate(() => ({
      cpfCnpj: document.getElementById('tomaCpfCnpj').value,
      descricao: document.getElementById('servDescricao').value,
      avisoVisivel: document.getElementById('avisoContrato').offsetParent !== null,
      contratoOrigem: window.contratoOrigem === undefined ? 'indefinido' : window.contratoOrigem,
    }));
    assert(!r.cpfCnpj && !r.descricao, 'a tela avulsa não pode nascer preenchida');
    assert(!r.avisoVisivel, 'o aviso de contrato apareceu numa emissão avulsa');
    assert(r.contratoOrigem === null || r.contratoOrigem === 'indefinido',
      'contratoOrigem deveria seguir vazio: ' + JSON.stringify(r.contratoOrigem));
    assert(!erros.length, 'erro na página: ' + erros.join(' | '));
  } finally { await page.close(); }
});

// ============================================================================
(async () => {
  if (!CHROME) { console.log('FALHA Chrome nao encontrado'); process.exit(1); }
  srv = await subirServidor();
  base = 'http://127.0.0.1:' + srv.address().port;
  browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  await browser.close();
  srv.close();
  console.log(`\n${ok} OK, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
