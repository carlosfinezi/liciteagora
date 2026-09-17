/**
 * Upload de logo e banner do Catálogo Online, dentro do contexto de tenant.
 *
 * O bug reproduzido em produção (tenant `produtosbomgosto`, 14/09):
 *
 *     POST /api/loja/logo -> 400
 *     {"success":false,"error":"tenant-middleware: currentDb() chamado fora de
 *      contexto de tenant"}
 *
 * O multer lê o corpo com busboy, e callback de stream NÃO carrega o
 * AsyncLocalStorage: os callbacks rodam no contexto de quando o socket nasceu,
 * antes do `tenantStorage.run()`. Quando o handler executa, o store sumiu e o
 * proxy do db estoura na primeira query.
 *
 * Estes testes sobem a cadeia HTTP INTEIRA — servidor, multer, proxy de db — que
 * é o único jeito de pegar isso. Chamar o handler direto não passa pelo multer e
 * o defeito desaparece. Mesmo padrão de `scripts/test-upload-ofx.js`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');
const { tenantStorage, createDbProxy, currentDb } = require('../tenant-middleware');

const RAIZ = path.join(__dirname, '..');
const DIR_LOJA = path.join(RAIZ, 'public/uploads/loja');

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cat48up-'));
const criados = [];          // arquivos que este teste gravou em public/uploads/loja

/* PNG 8x8 montado no código: não depende de arquivo do repositório e passa pela
   validação por ASSINATURA (`imgs.tipoReal`), que é o que a rota exige. */
function png(r, g, b) {
  const zlib = require('zlib');
  const chunk = (tipo, dados) => {
    const corpo = Buffer.concat([Buffer.from(tipo), dados]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(require('zlib').crc32
      ? require('zlib').crc32(corpo) >>> 0 : crc32(corpo), 0);
    const tam = Buffer.alloc(4); tam.writeUInt32BE(dados.length, 0);
    return Buffer.concat([tam, corpo, crc]);
  };
  // crc32 próprio: o do zlib só existe no Node 20.12+, e não dá para depender disso.
  function crc32(buf) {
    let c, tabela = crc32.t;
    if (!tabela) {
      tabela = crc32.t = [];
      for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        tabela[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (const byte of buf) crc = (tabela[(crc ^ byte) & 0xFF] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  const w = 8, h = 8;
  const linhas = [];
  for (let y = 0; y < h; y++) {
    linhas.push(Buffer.from([0]));
    for (let x = 0; x < w; x++) linhas.push(Buffer.from([r, g, b]));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(linhas))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function bancoDe(nome) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
  require('../loja-routes').migrarLojaDB(db);
  /* `produto_imagens` não nasce no db-schema (veio por script em 2026-08) mas
     existe em todos os tenants, e o GET do catálogo a consulta. Sem ela aqui, o
     teste reprovaria por falta do harness, não por defeito do código. */
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL,
    caminho TEXT NOT NULL,
    urlOrigem TEXT, origem TEXT NOT NULL DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT,
    largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0,
    dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE);`);
  return db;
}

/* Sobe o servidor com a MESMA cadeia do `server.js`: middleware que abre o
   contexto do tenant, e as rotas registradas sobre o PROXY de db — nunca sobre
   o banco direto. É o proxy que chama `currentDb()`, então testar com o banco
   direto esconderia exatamente o defeito que se quer pegar. */
function subir(tenants) {
  const app = express();
  let atual = null;
  app.use((req, res, next) => {
    // O slug chega por header só para o teste escolher o tenant da requisição.
    const slug = req.headers['x-tenant-teste'] || tenants[0].slug;
    atual = tenants.find((t2) => t2.slug === slug);
    req.tenant = { slug: atual.slug, name: atual.slug };
    req.tenantDb = atual.db;
    req.tenantCtx = { kind: 'tenant', slug: atual.slug };
    req.session = { username: 'tester' };
    tenantStorage.run({ kind: 'tenant', tenant: req.tenant, db: atual.db }, next);
  });

  const proxy = createDbProxy();
  tenantStorage.run({ kind: 'tenant', tenant: { slug: tenants[0].slug }, db: tenants[0].db }, () => {
    require('../loja-routes').registrarRotasLojaAdmin(app, proxy);
  });

  return new Promise((r) => {
    const srv = http.createServer(app);
    srv.listen(0, '127.0.0.1', () => r(srv));
  });
}

/* Requisição multipart montada à mão. `form-data` não é dependência deste
   projeto, e o que importa aqui é que o corpo chegue pelo busboy de verdade. */
function enviarArquivo(porta, rota, campo, buf, slug, nomeArq = 'x.png') {
  const lim = '----cat48' + Date.now();
  const corpo = Buffer.concat([
    Buffer.from(`--${lim}\r\nContent-Disposition: form-data; name="${campo}"; filename="${nomeArq}"\r\n`
      + 'Content-Type: image/png\r\n\r\n'),
    buf,
    Buffer.from(`\r\n--${lim}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + lim,
                 'Content-Length': corpo.length, 'x-tenant-teste': slug } },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
          resolve({ status: res.statusCode, body: j, cru: b }); });
      });
    req.on('error', reject);
    req.end(corpo);
  });
}

function pedir(porta, rota, slug, metodo = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: porta, path: rota, method: metodo,
      headers: { 'x-tenant-teste': slug } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (_) {}
        resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============================================================================

t('E7. upload de LOGO funciona dentro do contexto de tenant', async () => {
  const A = { slug: 'tenantA', db: bancoDe('A') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const r = await enviarArquivo(porta, '/api/loja/logo', 'logo', png(200, 30, 60), 'tenantA');
    // A mensagem exata do defeito reproduzido em produção.
    assert(!(r.body && /fora de contexto de tenant/.test(r.body.error || '')),
      'o contexto do tenant se perdeu no multer: ' + JSON.stringify(r.body));
    assert(r.status === 200 && r.body && r.body.success,
      `upload de logo respondeu ${r.status}: ` + JSON.stringify(r.body));

    // Persistiu no banco DO TENANT, e o arquivo existe em disco.
    const cfg = A.db.prepare('SELECT logoPath FROM loja_config WHERE id = 1').get();
    assert(cfg.logoPath === r.body.logo, `banco diz ${cfg.logoPath}, resposta diz ${r.body.logo}`);
    const abs = path.join(RAIZ, 'public', r.body.logo.replace(/^\//, ''));
    criados.push(abs);
    assert(fs.existsSync(abs), 'o arquivo não foi gravado: ' + abs);
  } finally { srv.close(); }
});

t('E8. upload de BANNER funciona dentro do contexto de tenant', async () => {
  const A = { slug: 'tenantA', db: bancoDe('A8') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const r = await enviarArquivo(porta, '/api/loja/banner', 'banner', png(10, 90, 200), 'tenantA');
    assert(!(r.body && /fora de contexto de tenant/.test(r.body.error || '')),
      'o contexto do tenant se perdeu no multer: ' + JSON.stringify(r.body));
    assert(r.status === 200 && r.body && r.body.success,
      `upload de banner respondeu ${r.status}: ` + JSON.stringify(r.body));

    const cfg = A.db.prepare('SELECT bannerPath FROM loja_config WHERE id = 1').get();
    assert(cfg.bannerPath === r.body.banner, `banco diz ${cfg.bannerPath}, resposta diz ${r.body.banner}`);
    const abs = path.join(RAIZ, 'public', r.body.banner.replace(/^\//, ''));
    criados.push(abs);
    assert(fs.existsSync(abs), 'o arquivo não foi gravado: ' + abs);

    // O catálogo passa a devolver o banner, e o GET roda no mesmo contexto.
    const cat = await pedir(porta, '/api/loja/catalogo', 'tenantA');
    assert(cat.body.loja.banner === r.body.banner,
      'o catálogo não reflete o banner recém-enviado: ' + JSON.stringify(cat.body.loja.banner));
  } finally { srv.close(); }
});

t('E9. o upload do tenant A não aparece no tenant B', async () => {
  const A = { slug: 'tenantA', db: bancoDe('A9') };
  const B = { slug: 'tenantB', db: bancoDe('B9') };
  const srv = await subir([A, B]);
  const porta = srv.address().port;
  try {
    const rA = await enviarArquivo(porta, '/api/loja/logo', 'logo', png(255, 0, 0), 'tenantA');
    const rB = await enviarArquivo(porta, '/api/loja/logo', 'logo', png(0, 255, 0), 'tenantB');
    assert(rA.status === 200 && rB.status === 200, 'um dos uploads falhou');
    criados.push(path.join(RAIZ, 'public', rA.body.logo.replace(/^\//, '')));
    criados.push(path.join(RAIZ, 'public', rB.body.logo.replace(/^\//, '')));

    // Nomes distintos: um tenant não pode sobrescrever o arquivo do outro.
    assert(rA.body.logo !== rB.body.logo, 'os dois tenants gravaram no MESMO arquivo: ' + rA.body.logo);

    // Cada banco guarda só o seu.
    const a = A.db.prepare('SELECT logoPath FROM loja_config WHERE id=1').get().logoPath;
    const b = B.db.prepare('SELECT logoPath FROM loja_config WHERE id=1').get().logoPath;
    assert(a === rA.body.logo && b === rB.body.logo, `vazou entre tenants: A=${a} B=${b}`);

    // E o catálogo de B nunca devolve o caminho de A.
    const catB = await pedir(porta, '/api/loja/catalogo', 'tenantB');
    assert(catB.body.loja.logo !== rA.body.logo,
      'o catálogo do tenant B devolveu a imagem do tenant A');

    // O nome carimba o tenant — é o que permite auditar a pasta compartilhada.
    assert(rA.body.logo.includes('tenantA') && rB.body.logo.includes('tenantB'),
      'o nome do arquivo não identifica o tenant: ' + rA.body.logo + ' / ' + rB.body.logo);
  } finally { srv.close(); }
});

t('E10. currentDb() responde dentro do handler de upload (o defeito real)', async () => {
  const A = { slug: 'tenantA', db: bancoDe('A10') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    /* Prova direta: uma rota registrada DEPOIS do multer, que só chama
       currentDb(). Se o contexto se perder, ela estoura — que é exatamente o
       que acontecia com logo e banner antes do `reentrarContextoTenant`. */
    const r = await enviarArquivo(porta, '/api/loja/logo', 'logo', png(1, 2, 3), 'tenantA');
    criados.push(path.join(RAIZ, 'public', (r.body.logo || '/x').replace(/^\//, '')));
    assert(r.status === 200, 'o upload falhou: ' + JSON.stringify(r.body));
    // Fora de qualquer requisição, currentDb() DEVE falhar — é a guarda funcionando.
    let estourou = false;
    try { currentDb(); } catch (e) { estourou = /fora de contexto de tenant/.test(e.message); }
    assert(estourou, 'currentDb() respondeu fora de requisição — a guarda de tenant sumiu');
  } finally { srv.close(); }
});

t('E-extra. arquivo que não é imagem é recusado, e nada é gravado', async () => {
  const A = { slug: 'tenantA', db: bancoDe('Ax') };
  const srv = await subir([A]);
  const porta = srv.address().port;
  try {
    const antes = A.db.prepare('SELECT logoPath FROM loja_config WHERE id=1').get().logoPath;
    const r = await enviarArquivo(porta, '/api/loja/logo', 'logo',
      Buffer.from('<?php echo 1; ?>'), 'tenantA', 'malicioso.png');
    assert(r.status === 400, `aceitou um não-imagem com status ${r.status}`);
    assert(/não é uma imagem/i.test((r.body && r.body.error) || ''),
      'recusou pela razão errada: ' + JSON.stringify(r.body));
    const depois = A.db.prepare('SELECT logoPath FROM loja_config WHERE id=1').get().logoPath;
    assert(antes === depois, 'gravou caminho no banco mesmo recusando o arquivo');
  } finally { srv.close(); }
});

t('E-extra2. nenhuma rota PÚBLICA da loja aceita upload', async () => {
  const rotas = [];
  const coletor = { use() {},
    get: (u) => rotas.push('GET ' + u), post: (u, ...f) => rotas.push('POST ' + u + ' |' + f.length),
    put: (u) => rotas.push('PUT ' + u), delete: (u) => rotas.push('DELETE ' + u) };
  const db = bancoDe('pub');
  tenantStorage.run({ kind: 'tenant', tenant: { slug: 'p' }, db }, () => {
    require('../loja-routes').registrarRotasLojaPublica(coletor, db);
  });
  const upload = rotas.filter((r) => /logo|banner|upload|imagem/i.test(r));
  assert(upload.length === 0, 'rota pública aceita upload: ' + upload.join(', '));
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  /* Faxina por PADRÃO DE NOME, não pela lista de `criados`.
   *
   * A lista só é preenchida quando o caso chega ao fim: um `assert` que falha
   * antes do `push` deixa o arquivo para trás, e foi o que sujou
   * `public/uploads/loja` com sete resíduos durante as sabotagens. O nome
   * carimba o slug do tenant, e os slugs daqui (`tenantA`/`tenantB`) não
   * existem em produção — então o padrão pega tudo o que este teste criou, e
   * nada além disso. */
  const RESIDUO = /-tenant[AB]-\d+-[0-9a-f]{12}\.(png|jpg|jpeg|webp|gif)$/i;
  try {
    for (const n of fs.readdirSync(DIR_LOJA)) {
      if (RESIDUO.test(n)) { try { fs.unlinkSync(path.join(DIR_LOJA, n)); } catch (_) {} }
    }
  } catch (_) { /* pasta pode nem existir numa instalação limpa */ }
  for (const f of criados) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
