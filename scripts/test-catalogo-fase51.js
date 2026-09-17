/**
 * Fase 51 — acabamento visual e Informações da empresa do Catálogo Online.
 *
 * Duas famílias de garantia:
 *
 *   SEGURANÇA do dado público. Rede social vira `href` numa página aberta à
 *   internet, então `javascript:` e domínio disfarçado morrem na entrada E na
 *   saída. Endereço só vai ao ar com opt-in explícito. Nada disso pode vazar
 *   entre tenants.
 *
 *   APRESENTAÇÃO. O "Voltar" saiu do cabeçalho, as redes viraram ícone sem
 *   texto, o rodapé não desenha bloco vazio, e o status Aberto/Fechado é
 *   informativo — não bloqueia carrinho nem pedido.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome']
  .find((p) => fs.existsSync(p));

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const FILTRO = process.argv[2] || null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f51-'));
const abertos = [];
fs.mkdirSync(path.join(tmp, 'uploads', 'loja'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'uploads', 'loja', 'logo.png'), Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));

const loja = require('../loja-routes');

// Segunda-feira, 10:00 — a referência de "agora" dos testes de horário.
const SEG_10H = { diaSemana: 1, hhmm: '10:00' };
const COMERCIAL = { 1: [['08:00', '18:00']], 2: [['08:00', '18:00']], 3: [['08:00', '18:00']],
                    4: [['08:00', '18:00']], 5: [['08:00', '18:00']], 6: [['08:00', '12:00']] };

const padrao = (cfg, chave, valor) => (chave in cfg ? cfg[chave] : valor);

function montar(nome, cfg = {}) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
  loja.migrarLojaDB(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT NOT NULL, urlOrigem TEXT, origem TEXT DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT, largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  abertos.push(db);

  db.prepare(`UPDATE loja_config SET ativa=1, nome=?, descricao=?, logoPath=?, whatsapp=?,
      email=?, instagram=?, facebook=?, endereco=?, mostrarEndereco=?, horarios=?,
      mostrarPreco=1, mostrarEstoque=1 WHERE id=1`)
    /* `padrao` olha a CHAVE, não o valor: `{ nome: null }` quer dizer "sem nome
       público", e um `??` transformaria isso no default, apagando justamente o
       caso de fallback que se quer testar. */
    .run(padrao(cfg, 'nome', 'LOJA TESTE'), padrao(cfg, 'descricao', 'Sabor em cada detalhe'),
         padrao(cfg, 'logo', '/uploads/loja/logo.png'), padrao(cfg, 'whatsapp', '44999990000'),
         padrao(cfg, 'email', 'oi@loja.com'), padrao(cfg, 'instagram', null),
         padrao(cfg, 'facebook', null), padrao(cfg, 'endereco', null),
         cfg.mostrarEndereco ? 1 : 0,
         cfg.horarios === undefined || cfg.horarios === null ? null : JSON.stringify(cfg.horarios));

  // Cadastro da empresa: a fonte de FALLBACK.
  try {
    db.prepare(`INSERT INTO fornecedor (razaoSocial, nomeFantasia, telefone, endereco, numero,
      bairro, cidade, uf) VALUES (?,?,?,?,?,?,?,?)`)
      .run(padrao(cfg, 'empRazao', 'EMPRESA TESTE LTDA'), padrao(cfg, 'empFantasia', ''),
           padrao(cfg, 'empTelefone', '4433221100'), 'RUA DA EMPRESA', '10', 'CENTRO', 'MARINGA', 'PR');
  } catch (_) { /* schema sem fornecedor */ }

  db.prepare(`INSERT INTO produtos (sku, descricao, categoria, unidade, precoVenda, precoCusto,
    ativo, publicadoNaLoja) VALUES ('P1','PRODUTO TESTE','GERAL','UN',10,3,1,1)`).run();
  return db;
}

function subir(tenants) {
  const app = express();
  app.use(express.json());
  let atual = tenants[0];
  app.use((req, res, next) => {
    const slug = req.headers['x-tenant-teste'];
    if (slug) atual = tenants.find((x) => x.slug === slug) || atual;
    next();
  });
  const proxy = new Proxy({}, { get: (_, prop) => {
    const alvo = atual.db; const v = alvo[prop];
    return typeof v === 'function' ? v.bind(alvo) : v;
  } });
  loja.registrarRotasLojaPublica(app, proxy);
  loja.registrarRotasLojaAdmin(app, proxy);
  app.use('/loja', express.static(path.join(PUB, 'loja')));
  app.use('/uploads', express.static(path.join(tmp, 'uploads')));
  return new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
}

function pedir(porta, rota, { metodo = 'GET', corpo = null, slug = null } = {}) {
  return new Promise((resolve, reject) => {
    const dados = corpo ? Buffer.from(JSON.stringify(corpo)) : null;
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo,
      headers: Object.assign({}, dados ? { 'Content-Type': 'application/json',
        'Content-Length': dados.length } : {}, slug ? { 'x-tenant-teste': slug } : {}) }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, body: j, cru: b }); });
    });
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

// ============================================================================
// A. Redes sociais — o dado que vira href numa página pública
// ============================================================================

t('A1. javascript:, data: e HTML são rejeitados no identificador social', () => {
  const venenos = ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)',
                   'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox',
                   '<img src=x onerror=alert(1)>', '"><script>alert(1)</script>',
                   'loja"onmouseover="alert(1)'];
  for (const v of venenos) {
    assert(loja.usuarioRede(v, 'instagram.com') === null, `aceitou: ${v}`);
    assert(loja.usuarioRede(v, 'facebook.com') === null, `aceitou no facebook: ${v}`);
  }
});

t('A2. domínio disfarçado é rejeitado; usuário legítimo passa', () => {
  for (const mau of ['instagram.com.evil.io/loja', 'evil.com/loja', 'loja.com.br']) {
    assert(loja.usuarioRede(mau, 'instagram.com') === null, `aceitou domínio: ${mau}`);
  }
  for (const [bom, esperado] of [['@lojinha', 'lojinha'], ['lojinha', 'lojinha'],
    ['https://instagram.com/lojinha/', 'lojinha'], ['loja.bom.gosto', 'loja.bom.gosto'],
    ['produtos_bom_gosto', 'produtos_bom_gosto']]) {
    assert(loja.usuarioRede(bom, 'instagram.com') === esperado,
      `${bom} virou ${loja.usuarioRede(bom, 'instagram.com')}, esperava ${esperado}`);
  }
});

t('A3. WhatsApp é normalizado no backend', () => {
  assert(loja.whatsappNormalizado('(94) 99162-5366') === '5594991625366', 'não normalizou com máscara');
  assert(loja.whatsappNormalizado('5594991625366') === '5594991625366', 'duplicou o DDI');
  assert(loja.whatsappNormalizado('123') === null, 'aceitou número curto demais');
  assert(loja.whatsappNormalizado('') === null, 'aceitou vazio');
  assert(loja.whatsappNormalizado(null) === null, 'aceitou nulo');
});

t('A4. o PUT recusa rede inválida com o motivo, sem gravar', async () => {
  const A = { slug: 'a', db: montar('a4') };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/api/loja/informacoes', { metodo: 'PUT',
      corpo: { nome: 'X', instagram: 'javascript:alert(1)' } });
    assert(r.status === 422, `aceitou javascript: no PUT (status ${r.status})`);
    assert(/usuário/i.test(r.body.error), 'não explicou o problema: ' + r.body.error);
    const gravado = A.db.prepare('SELECT instagram FROM loja_config WHERE id=1').get().instagram;
    assert(!gravado, 'gravou o valor recusado: ' + gravado);
  } finally { srv.close(); }
});

t('A5. rede NÃO configurada não aparece no payload público', async () => {
  const A = { slug: 'a', db: montar('a5', { instagram: null, facebook: null }) };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(r.body.loja.instagram === null, 'instagram apareceu sem estar configurado');
    assert(r.body.loja.facebook === null, 'facebook apareceu sem estar configurado');
    assert(r.body.loja.whatsapp, 'o whatsapp configurado sumiu');
  } finally { srv.close(); }
});

// ============================================================================
// B. Endereço, fallback e isolamento
// ============================================================================

t('B1. endereço fica OCULTO enquanto a opção estiver desligada', async () => {
  const A = { slug: 'a', db: montar('b1', { endereco: 'RUA SECRETA, 42', mostrarEndereco: false }) };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(r.body.loja.endereco === null, 'endereço vazou com a opção desligada');
    assert(!/RUA SECRETA/.test(r.cru), 'o endereço apareceu em algum lugar do payload');
  } finally { srv.close(); }
});

t('B2. endereço aparece quando a opção é ligada', async () => {
  const A = { slug: 'a', db: montar('b2', { endereco: 'RUA ABERTA, 10', mostrarEndereco: true }) };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(r.body.loja.endereco === 'RUA ABERTA, 10', 'endereço não apareceu: ' + r.body.loja.endereco);
  } finally { srv.close(); }
});

t('B3. sem endereço próprio, usa o do cadastro da empresa (só se autorizado)', async () => {
  const A = { slug: 'a', db: montar('b3', { endereco: null, mostrarEndereco: true }) };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(/RUA DA EMPRESA/.test(r.body.loja.endereco || ''),
      'não caiu no endereço do cadastro: ' + r.body.loja.endereco);
    assert(/MARINGA\/PR/.test(r.body.loja.endereco), 'a cidade/UF não entrou: ' + r.body.loja.endereco);
  } finally { srv.close(); }
});

t('B4. nome público vence o da empresa; vazio cai no fallback', async () => {
  const comNome = { slug: 'a', db: montar('b4a', { nome: 'FEIRA DA ESQUINA' }) };
  let srv = await subir([comNome]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(r.body.loja.nome === 'FEIRA DA ESQUINA', 'o nome público não venceu: ' + r.body.loja.nome);
  } finally { srv.close(); }

  const semNome = { slug: 'a', db: montar('b4b', { nome: null, empFantasia: 'BOM GOSTO' }) };
  srv = await subir([semNome]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/config');
    assert(r.body.loja.nome === 'BOM GOSTO', 'não caiu no nome da empresa: ' + r.body.loja.nome);
  } finally { srv.close(); }
});

t('B5. tenant A não recebe rede, endereço nem horário do tenant B', async () => {
  const A = { slug: 'a', db: montar('b5a', { nome: 'LOJA A', instagram: 'perfil_do_a',
    endereco: 'ENDERECO DO A', mostrarEndereco: true, horarios: COMERCIAL }) };
  const B = { slug: 'b', db: montar('b5b', { nome: 'LOJA B', instagram: 'perfil_do_b',
    facebook: 'face_do_b', endereco: 'ENDERECO DO B', mostrarEndereco: true,
    horarios: { 0: [['09:00', '11:00']] } }) };
  const srv = await subir([A, B]);
  const porta = srv.address().port;
  try {
    const ra = await pedir(porta, '/loja/api/config', { slug: 'a' });
    const rb = await pedir(porta, '/loja/api/config', { slug: 'b' });
    assert(ra.body.loja.instagram === 'perfil_do_a', 'instagram do A errado');
    assert(!/perfil_do_b|face_do_b/.test(ra.cru), 'rede do B vazou para o A');
    assert(!/ENDERECO DO B/.test(ra.cru), 'endereço do B vazou para o A');
    assert(!/ENDERECO DO A/.test(rb.cru), 'endereço do A vazou para o B');
    // Horários são diferentes: o do B tem só domingo.
    assert(Object.keys(ra.body.loja.horarios).length === 6, 'horário do A veio errado');
    assert(Object.keys(rb.body.loja.horarios).join() === '0', 'horário do B veio do A');
  } finally { srv.close(); }
});

t('B6. o payload público continua sem custo e sem dado interno', async () => {
  const A = { slug: 'a', db: montar('b6', { instagram: 'loja' }) };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    for (const rota of ['/loja/api/config', '/loja/api/produtos']) {
      const r = await pedir(porta, rota);
      for (const proibido of ['precoCusto', 'markup', 'cnpj', 'inscricao', 'razaoSocial',
                              'api_key', 'apiKey', 'banco', 'agencia']) {
        assert(!new RegExp(proibido, 'i').test(r.cru), `${rota} expõe "${proibido}"`);
      }
    }
  } finally { srv.close(); }
});

// ============================================================================
// C. Horários e status
// ============================================================================

t('C1. dentro do expediente -> Aberto, com a hora de fechar', () => {
  const s = loja.statusAtendimento(COMERCIAL, SEG_10H);
  assert(s.aberto === true, 'devia estar aberto: ' + JSON.stringify(s));
  assert(s.rotulo === 'Aberto · fecha às 18:00', 'rótulo errado: ' + s.rotulo);
});

t('C2. antes de abrir -> Fechado, abre hoje', () => {
  const s = loja.statusAtendimento(COMERCIAL, { diaSemana: 1, hhmm: '06:30' });
  assert(s.aberto === false, 'devia estar fechado');
  assert(/abre hoje às 08:00/.test(s.rotulo), 'rótulo errado: ' + s.rotulo);
});

t('C3. depois de fechar -> Fechado, abre amanhã', () => {
  const s = loja.statusAtendimento(COMERCIAL, { diaSemana: 1, hhmm: '19:00' });
  assert(/abre amanhã às 08:00/.test(s.rotulo), 'rótulo errado: ' + s.rotulo);
});

t('C4. dia FECHADO pula para o próximo dia com expediente', () => {
  // Domingo não está em COMERCIAL: o próximo é segunda.
  const s = loja.statusAtendimento(COMERCIAL, { diaSemana: 0, hhmm: '10:00' });
  assert(s.aberto === false, 'domingo devia estar fechado');
  assert(/abre amanhã às 08:00/.test(s.rotulo), 'rótulo errado: ' + s.rotulo);

  // Sábado 13:00 (fechou ao meio-dia) -> segunda, que é "depois de amanhã".
  const sab = loja.statusAtendimento(COMERCIAL, { diaSemana: 6, hhmm: '13:00' });
  assert(/abre segunda às 08:00/.test(sab.rotulo), 'do sábado não achou a segunda: ' + sab.rotulo);
});

t('C5. dois períodos no mesmo dia são respeitados', () => {
  const h = { 1: [['08:00', '12:00'], ['14:00', '18:00']] };
  assert(loja.statusAtendimento(h, { diaSemana: 1, hhmm: '10:00' }).aberto, 'manhã devia abrir');
  const almoco = loja.statusAtendimento(h, { diaSemana: 1, hhmm: '13:00' });
  assert(!almoco.aberto && /abre hoje às 14:00/.test(almoco.rotulo),
    'o intervalo do almoço não foi entendido: ' + almoco.rotulo);
  assert(loja.statusAtendimento(h, { diaSemana: 1, hhmm: '15:00' }).aberto, 'tarde devia abrir');
});

t('C6. sem horário configurado, NÃO afirma nada', () => {
  assert(loja.statusAtendimento(null) === null, 'inventou status sem horário');
  assert(loja.statusAtendimento('{}') === null, 'inventou status com objeto vazio');
  assert(loja.statusAtendimento('lixo{{') === null, 'quebrou com JSON inválido');
});

t('C7. faixa malformada é descartada, não corrigida', () => {
  const h = loja.lerHorarios(JSON.stringify({
    1: [['08:00', '18:00'], ['25:00', '30:00'], ['18:0', '19:00'], ['18:00', '08:00'], ['x']],
    9: [['08:00', '09:00']],
  }));
  assert(h[1].length === 1, 'faixas inválidas entraram: ' + JSON.stringify(h[1]));
  assert(!h[9], 'dia fora de 0-6 entrou');
});

t('C8. o status NÃO bloqueia carrinho (é informativo nesta fase)', async () => {
  // Domingo, loja fechada — e ainda assim o carrinho calcula.
  const A = { slug: 'a', db: montar('c8', { horarios: { 1: [['08:00', '09:00']] } }) };
  const srv = await subir([A]);
  try {
    const r = await pedir(srv.address().port, '/loja/api/carrinho/calcular', { metodo: 'POST',
      corpo: { itens: [{ produtoId: 1, quantidade: 2 }] } });
    assert(r.status === 200 && r.body.total === 20,
      'o horário bloqueou o carrinho: ' + JSON.stringify(r.body));
  } finally { srv.close(); }
});

// ============================================================================
// D. Navegador
// ============================================================================

async function comNavegador(tenants, largura, fn) {
  const srv = await subir(tenants);
  const porta = srv.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: largura, height: 900, isMobile: largura < 700, hasTouch: largura < 700 });
  const erros = [];
  page.on('pageerror', (e) => erros.push(e.name + ': ' + e.message));
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await page.goto(`http://127.0.0.1:${porta}/loja/`, { waitUntil: 'networkidle2', timeout: 30000 });
    await espera(1600);
    return await fn(page, { erros, espera, porta });
  } finally { await browser.close(); srv.close(); }
}

t('D1. o "Voltar" sumiu do cabeçalho, e a marca leva ao início', async () => {
  const A = { slug: 'a', db: montar('d1', { instagram: 'loja' }) };
  await comNavegador([A], 1280, async (page, ctx) => {
    const r = await page.evaluate(async () => {
      const antes = { voltar: !!document.getElementById('btVoltar'),
                      texto: document.querySelector('header').innerText };
      location.hash = '#/p/1';
      await new Promise((x) => setTimeout(x, 900));
      const naPagina = { voltar: !!document.getElementById('btVoltar'),
                         texto: document.querySelector('header').innerText,
                         marca: !!document.querySelector('.marca-loja[href="#/"]') };
      document.querySelector('.marca-loja').click();
      await new Promise((x) => setTimeout(x, 700));
      return { antes, naPagina, hashFinal: location.hash };
    });
    assert(!r.antes.voltar && !/Voltar/i.test(r.antes.texto), 'o "Voltar" continua na home');
    assert(!r.naPagina.voltar && !/Voltar/i.test(r.naPagina.texto),
      'o "Voltar" reaparece na página de produto: ' + r.naPagina.texto);
    assert(r.naPagina.marca, 'a marca não é link para o início');
    assert(r.hashFinal === '#/', 'clicar na marca não voltou ao início: ' + r.hashFinal);
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('D2. redes viram ÍCONES, sem texto, e só as configuradas', async () => {
  const A = { slug: 'a', db: montar('d2', { instagram: 'perfil', facebook: null }) };
  await comNavegador([A], 1280, async (page) => {
    const r = await page.evaluate(() => {
      const links = [...document.querySelectorAll('#redes .rede')];
      return {
        titulos: links.map((a) => a.getAttribute('title')),
        hrefs: links.map((a) => a.getAttribute('href')),
        alvos: links.map((a) => a.getAttribute('target')),
        rel: links.map((a) => a.getAttribute('rel')),
        svgs: document.querySelectorAll('#redes .rede svg').length,
        texto: document.getElementById('redes').innerText.trim(),
        tamanhos: links.map((a) => { const b = a.getBoundingClientRect();
          return { w: Math.round(b.width), h: Math.round(b.height) }; }),
      };
    });
    assert(r.titulos.join(',') === 'WhatsApp,Instagram',
      'redes erradas (facebook não estava configurado): ' + r.titulos.join(','));
    assert(r.svgs === 2, 'os ícones não são SVG: ' + r.svgs);
    assert(r.texto === '', 'sobrou texto ao lado do ícone: ' + JSON.stringify(r.texto));
    assert(r.hrefs[1] === 'https://instagram.com/perfil', 'href do instagram: ' + r.hrefs[1]);
    assert(r.alvos.every((a) => a === '_blank'), 'não abre em nova aba: ' + r.alvos);
    assert(r.rel.every((x) => /noopener/.test(x || '')), 'falta rel=noopener: ' + r.rel);
    assert(r.tamanhos.every((s) => s.w >= 44 && s.h >= 44),
      'alvo de toque pequeno: ' + JSON.stringify(r.tamanhos));
  });
});

t('D3. tipografia moderna, sem serifa', async () => {
  const A = { slug: 'a', db: montar('d3') };
  // O preset "editorial" era Georgia serif — a aparência antiga relatada.
  A.db.prepare(`UPDATE loja_config SET tema = ? WHERE id=1`)
    .run(JSON.stringify({ preset: 'neutro', corPrimaria: '#0E6B63', fundo: 'claro',
                          fonte: 'editorial', raio: 12 }));
  await comNavegador([A], 1280, async (page) => {
    const f = await page.evaluate(() => ({
      body: getComputedStyle(document.body).fontFamily,
      nome: getComputedStyle(document.getElementById('nomeLoja')).fontFamily,
    }));
    assert(/Inter/i.test(f.body), 'o corpo não usa Inter: ' + f.body);
    // `sans-serif` contém "serif": a checagem precisa da borda que exclui o
    // "sans-", senão reprova exatamente a fonte correta.
    assert(!/Georgia|Times New Roman|Iowan|(^|[^-])\bserif\b/i.test(f.body),
      'sobrou serifa antiga: ' + f.body);
    assert(/Inter/i.test(f.nome), 'o nome da loja não usa Inter: ' + f.nome);
  });
});

t('D4. rodapé estruturado, sem bloco vazio', async () => {
  const completo = { slug: 'a', db: montar('d4a', { instagram: 'loja', facebook: 'loja',
    endereco: 'RUA X, 1', mostrarEndereco: true }) };
  await comNavegador([completo], 1280, async (page) => {
    const r = await page.evaluate(() => ({
      nome: document.getElementById('rodNome').textContent,
      desc: document.getElementById('rodDesc').textContent,
      contato: [...document.querySelectorAll('#rodContato li')].map((l) => l.innerText),
      redes: document.querySelectorAll('#rodRedes .rede').length,
      copy: document.getElementById('rodCopy').textContent,
      corLink: getComputedStyle(document.querySelector('#rodContato a')).color,
    }));
    assert(r.nome === 'LOJA TESTE', 'nome do rodapé: ' + r.nome);
    assert(r.contato.some((c) => /WhatsApp/.test(c)), 'faltou WhatsApp no rodapé');
    assert(r.contato.some((c) => /RUA X, 1/.test(c)), 'faltou o endereço autorizado');
    assert(r.redes === 3, 'redes no rodapé: ' + r.redes);
    assert(/© 20\d\d LOJA TESTE/.test(r.copy), 'linha de copyright: ' + r.copy);
  });

  // Loja sem nada opcional: os blocos somem em vez de aparecerem vazios.
  const pelado = { slug: 'a', db: montar('d4b', { descricao: null, email: null,
    whatsapp: null, instagram: null, facebook: null, endereco: null, empTelefone: null }) };
  await comNavegador([pelado], 1280, async (page) => {
    const r = await page.evaluate(() => ({
      redesCol: document.getElementById('rodRedesCol').hidden,
      contatoCol: document.getElementById('rodContatoCol').hidden,
      descOculta: document.getElementById('rodDesc').hidden,
      vazios: [...document.querySelectorAll('#rodContato li')].filter((l) => !l.innerText.trim()).length,
    }));
    assert(r.redesCol, 'a coluna de redes apareceu sem rede configurada');
    assert(r.contatoCol, 'a coluna de contato apareceu sem contato');
    assert(r.descOculta, 'a descrição vazia ocupou espaço');
    assert(r.vazios === 0, 'há item de contato vazio no rodapé');
  });
});

t('D5. status Aberto/Fechado aparece; sem horário, não aparece', async () => {
  const comHorario = { slug: 'a', db: montar('d5a', { horarios: COMERCIAL }) };
  await comNavegador([comHorario], 1280, async (page) => {
    const r = await page.evaluate(() => {
      const s = document.getElementById('statusAtend');
      return { visivel: !s.hidden, texto: s.textContent, classe: s.className };
    });
    assert(r.visivel, 'o status não apareceu com horário configurado');
    assert(/Aberto|Fechado/.test(r.texto), 'texto do status: ' + r.texto);
  });

  const semHorario = { slug: 'a', db: montar('d5b', { horarios: undefined }) };
  await comNavegador([semHorario], 1280, async (page) => {
    assert(await page.evaluate(() => document.getElementById('statusAtend').hidden),
      'inventou status sem horário configurado');
  });
});

t('D6. XSS em nome, descrição e endereço não executa', async () => {
  const A = { slug: 'a', db: montar('d6', {
    nome: '<img src=x onerror="window.__xss=1">LOJA',
    descricao: '<script>window.__xss2=1</script>desc',
    endereco: '<svg onload="window.__xss3=1">rua', mostrarEndereco: true }) };
  await comNavegador([A], 1280, async (page, ctx) => {
    const r = await page.evaluate(() => ({
      xss: !!window.__xss || !!window.__xss2 || !!window.__xss3,
      imgInjetada: !!document.querySelector('#nomeLoja img, #rodNome img'),
      nomeTexto: document.getElementById('nomeLoja').textContent,
      rodEnd: document.getElementById('rodContato').innerHTML,
    }));
    assert(!r.xss, 'o script injetado EXECUTOU');
    assert(!r.imgInjetada, 'a tag injetada virou elemento');
    assert(/LOJA/.test(r.nomeTexto), 'o nome não foi exibido como texto: ' + r.nomeTexto);
    assert(!/<svg/i.test(r.rodEnd), 'o svg do endereço virou marcação: ' + r.rodEnd);
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

/* D7 — o cabeçalho em telas estreitas.
 *
 * A exigência original continua de pé, e ficou MAIS forte: marca e ícones são
 * importantes, então nenhum dos dois pode sumir, encolher abaixo do alvo de
 * toque ou vazar da tela. O que mudou é como o cabeçalho cumpre isso: em vez
 * de espremer tudo numa linha até o nome virar "PRO…", ele quebra em duas —
 * marca em cima, redes e ⓘ embaixo.
 *
 * Por isso "nome legível" deixou de ser medido em pixels. Largura não prova
 * leitura: 72px de largura passavam no critério antigo e mostravam "PRO…" na
 * tela (medido em produção, 390px, 16/09). O que se mede agora é quantos
 * CARACTERES ficam visíveis.
 *
 * Os quatro cenários de rede existem porque o aperto depende deles: com só o
 * WhatsApp sobra espaço, com os três mais o ⓘ são 176px que a marca não tem.
 */
const REDES_CENARIOS = [
  /* `empTelefone` também vai a null: o WhatsApp público cai no telefone do
     cadastro da empresa quando a loja não tem o seu (`c.whatsapp || emp.telefone`),
     e sem zerar as duas fontes este cenário não seria "sem rede" nenhuma. */
  ['sem rede', { whatsapp: null, instagram: null, facebook: null, empTelefone: null }],
  ['só zap', { instagram: null, facebook: null }],
  ['zap+insta', { instagram: 'loja', facebook: null }],
  ['as três', { instagram: 'loja', facebook: 'loja' }],
];

for (const largura of [320, 375, 390, 430, 768]) {
  for (const [rotulo, redes] of REDES_CENARIOS) {
    t(`D7-${largura} (${rotulo}). cabeçalho legível e sem overflow`, async () => {
      /* Com HORÁRIO configurado de propósito: é o status no cabeçalho que
         disputa espaço com marca e ícones. */
      const A = { slug: 'a', db: montar(`d7${largura}${rotulo.replace(/\W/g, '')}`,
        { nome: 'NOME BEM LONGO DE UMA LOJA QUE NAO CABE', endereco: 'RUA X, 1',
          mostrarEndereco: true, horarios: COMERCIAL, ...redes }) };
      await comNavegador([A], largura, async (page, ctx) => {
        const r = await page.evaluate((qtdEsperada) => {
          const dentro = (s) => { const e = document.querySelector(s); if (!e) return null;
            const b = e.getBoundingClientRect();
            return { ok: b.left >= -1 && b.right <= window.innerWidth + 1,
                     w: Math.round(b.width), h: Math.round(b.height),
                     x: Math.round(b.left), y: Math.round(b.top) }; };

          /* Quantos caracteres do nome o visitante realmente lê: corta o texto
             até ele caber na caixa e conta. É isto que separa "PRODUTOS BOM
             GOSTO" de "PRO…" — a largura do elemento é a mesma nos dois. */
          const el = document.getElementById('nomeLoja');
          const texto = el.textContent;
          /* Cabe nos DOIS eixos. Medir só a altura deixa passar o corte de uma
             linha com `white-space: nowrap`, onde o excesso vaza na horizontal
             e `scrollHeight` nunca cresce — a sabotagem de 16/09 atravessou
             este caso exatamente por aí. */
          const cabe = () => el.scrollHeight <= el.clientHeight + 1
                          && el.scrollWidth <= el.clientWidth + 1;
          let visiveis = texto.length;
          if (!cabe()) {
            let lo = 0, hi = texto.length;
            while (lo < hi) {
              const m = Math.ceil((lo + hi) / 2);
              el.textContent = texto.slice(0, m);
              if (cabe()) lo = m; else hi = m - 1;
            }
            el.textContent = texto;
            visiveis = lo;
          }

          const marca = document.querySelector('.marca-loja').getBoundingClientRect();
          const acoes = document.querySelector('.acoes-topo').getBoundingClientRect();
          const icones = [...document.querySelectorAll('#redes .rede')];
          const menorAlvo = [...icones, document.getElementById('btInfo')]
            .reduce((m, e) => { const b = e.getBoundingClientRect();
              const v = Math.min(b.width, b.height); return m === null || v < m ? v : m; }, null);

          return {
            redes: dentro('#redes'), marca: dentro('.marca-loja'),
            acoes: dentro('.acoes-topo'), logo: dentro('header.topo img.logo'),
            rodape: dentro('.rodape-grade'),
            qtdIcones: icones.length, qtdEsperada,
            infoVisivel: !!document.getElementById('btInfo').offsetParent,
            menorAlvo: menorAlvo === null ? null : Math.round(menorAlvo),
            nome: texto, visiveis,
            // Marca e ações não podem ocupar o mesmo espaço da tela.
            sobrepoe: marca.right > acoes.left + 1 && marca.left < acoes.right - 1
                   && marca.bottom > acoes.top + 1 && marca.top < acoes.bottom - 1,
            rolaH: document.documentElement.scrollWidth > window.innerWidth + 1,
          };
        }, redes.whatsapp === null ? 0 : 1 + (redes.instagram ? 1 : 0) + (redes.facebook ? 1 : 0));

        assert(r.qtdIcones === r.qtdEsperada,
          `${r.qtdIcones} ícones de rede, esperados ${r.qtdEsperada} — nenhuma rede configurada pode ser escondida`);
        if (r.qtdIcones) {
          assert(r.redes.ok, 'a barra de redes vaza da tela');
          assert(r.menorAlvo >= 44, `alvo de toque de ${r.menorAlvo}px — abaixo dos 44px`);
        }
        assert(r.infoVisivel, 'o botão Informações sumiu do cabeçalho');
        assert(r.marca.ok, 'a marca vaza da tela');
        assert(r.acoes.ok, 'o grupo de ações vaza da tela');
        assert(r.logo.w >= 24, `o logo colapsou para ${r.logo.w}px`);
        /* 24 caracteres, ou o nome inteiro se for menor. Era exatamente aqui
           que "PRO…" (3 caracteres) passava batido medindo só largura. */
        assert(r.visiveis >= Math.min(r.nome.length, 24),
          `nome ilegível: ${r.visiveis} de ${r.nome.length} caracteres — "${r.nome.slice(0, r.visiveis)}…"`);
        assert(!r.sobrepoe, 'a marca e os ícones se sobrepõem');
        assert(r.rodape.ok, 'o rodapé vaza da tela');
        assert(!r.rolaH, 'a página rola na horizontal');
        assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
      });
    });
  }
}

t('D8. o catálogo continua funcionando: produtos, busca e carrinho', async () => {
  const A = { slug: 'a', db: montar('d8', { horarios: COMERCIAL }) };
  await comNavegador([A], 1280, async (page, ctx) => {
    const r = await page.evaluate(async () => {
      const cards = document.querySelectorAll('.card').length;
      await adicionar({ produtoId: 1, quantidade: 1, opcoes: [], textos: {}, comentario: null });
      await new Promise((x) => setTimeout(x, 500));
      return { cards, barra: !document.getElementById('barra').hidden,
               total: document.getElementById('barraTotal').textContent };
    });
    assert(r.cards === 1, 'o produto sumiu da vitrine: ' + r.cards);
    assert(r.barra && /10,00/.test(r.total), 'o carrinho parou de funcionar: ' + r.total);
    assert(ctx.erros.length === 0, 'erro de página: ' + ctx.erros.join(' | '));
  });
});

t('D9. a tela administrativa carrega e tem os campos esperados', async () => {
  const A = { slug: 'a', db: montar('d9') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'] });
  try {
    const html = fs.readFileSync(path.join(PUB, 'catalogo/loja-informacoes.html'), 'utf8');
    for (const id of ['nome', 'descricao', 'email', 'whatsapp', 'telefone', 'instagram',
                      'facebook', 'endereco', 'mostrarEndereco', 'dias', 'previa']) {
      assert(html.includes(`id="${id}"`), `falta o campo "${id}" na tela administrativa`);
    }
    // Campos de 16px: abaixo disso o iOS dá zoom ao focar.
    assert(/font-size:\s*16px/.test(html), 'os campos não têm 16px (zoom do iOS)');
    assert(/min-height:\s*44px/.test(html), 'controles sem 44px de alvo de toque');
    // E o GET que a tela consome responde.
    const r = await pedir(porta, '/api/loja/informacoes');
    assert(r.status === 200 && r.body.informacoes, 'o GET da tela falhou: ' + r.status);
    assert(r.body.empresa, 'o GET não devolve os dados de fallback da empresa');
  } finally { await browser.close(); srv.close(); }
});

t('D10. salvar pela API persiste e o público reflete', async () => {
  const A = { slug: 'a', db: montar('d10', { instagram: null, horarios: undefined }) };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const r = await pedir(porta, '/api/loja/informacoes', { metodo: 'PUT', corpo: {
      nome: 'FEIRA NOVA', descricao: 'Tudo fresquinho', whatsapp: '(44) 99999-0000',
      instagram: '@feiranova', facebook: 'https://facebook.com/feiranova',
      endereco: 'AV CENTRAL, 900', mostrarEndereco: true,
      horarios: { 1: [['08:00', '18:00']] } } });
    assert(r.status === 200, 'o PUT falhou: ' + JSON.stringify(r.body));

    const pub = await pedir(porta, '/loja/api/config');
    const l = pub.body.loja;
    assert(l.nome === 'FEIRA NOVA', 'nome não persistiu: ' + l.nome);
    assert(l.instagram === 'feiranova', 'instagram não normalizou: ' + l.instagram);
    assert(l.facebook === 'feiranova', 'facebook (URL completa) não normalizou: ' + l.facebook);
    assert(l.whatsapp === '5544999990000', 'whatsapp não normalizou: ' + l.whatsapp);
    assert(l.endereco === 'AV CENTRAL, 900', 'endereço não persistiu: ' + l.endereco);
    assert(l.atendimento && /Aberto|Fechado/.test(l.atendimento.rotulo), 'status não veio');
  } finally { srv.close(); }
});

(async () => {
  if (!CHROME) console.log('  Chrome ausente — bloco D sera pulado');
  for (const [nome, fn] of fila.filter(([n]) => !FILTRO || n.startsWith(FILTRO))) {
    if (!CHROME && /^D/.test(nome)) { console.log('PULA  ' + nome); continue; }
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  for (const db of abertos) { try { db.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
