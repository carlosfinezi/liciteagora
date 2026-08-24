/**
 * Imagens de produto por URL de origem: validação da URL (o servidor vai
 * buscá-la), do conteúdo baixado, e o vínculo com a capa do produto.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const I = require('../produto-imagens');

const DB = '/tmp/vp-prodimg.db';
const RAIZ = '/tmp/vp-prodimg-public';
try { fs.unlinkSync(DB); } catch {}
try { fs.rmSync(RAIZ, { recursive: true, force: true }); } catch {}
const db = new Database(DB);
const schema = fs.readFileSync('/tmp/vp-prodimg-schema.sql', 'utf8');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
}
I.migrarImagensDB(db);

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- bytes de imagem de verdade ----------
const JPEG = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(4000, 7)]);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(4000, 3)]);
const HTML = Buffer.from('<!doctype html><html>' + 'x'.repeat(4000) + '</html>');

function resposta(buf, { ct = 'image/jpeg', status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (h) => (h.toLowerCase() === 'content-type' ? ct : null) },
    arrayBuffer: async () => buf,
  };
}
const buscarQue = (fn) => async (url, opts) => fn(url, opts);

const P = db.prepare("INSERT INTO produtos (sku, descricao, unidade, ativo) VALUES ('P1','Produto','UN',1)")
  .run().lastInsertRowid;

(async () => {

// ---------- a URL vai ser buscada PELO SERVIDOR ----------
await t('endereço interno é recusado', async () => {
  for (const u of ['http://localhost/x.jpg', 'http://127.0.0.1/x.jpg', 'http://10.0.0.5/x.jpg',
                   'http://192.168.1.10/x.jpg', 'http://172.16.3.4/x.jpg']) {
    const r = I.urlSegura(u);
    assert(!r.ok, 'passou: ' + u);
  }
});

await t('metadados da nuvem são recusados', async () => {
  // 169.254.169.254 devolve credencial de instância em várias nuvens.
  assert(!I.urlSegura('http://169.254.169.254/latest/meta-data/').ok, 'link-local passou');
});

await t('esquema fora de http/https é recusado', async () => {
  assert(!I.urlSegura('file:///etc/passwd').ok, 'file: passou');
  assert(!I.urlSegura('ftp://x/y.jpg').ok, 'ftp: passou');
  assert(!I.urlSegura('nao-e-url').ok, 'lixo passou');
});

await t('URL pública comum é aceita', async () => {
  const r = I.urlSegura('https://cdn.fabricante.com.br/fotos/produto.jpg');
  assert(r.ok, 'motivo: ' + r.motivo);
});

// ---------- o que foi baixado é imagem mesmo? ----------
await t('página HTML servida como imagem é recusada', async () => {
  let erro = null;
  try {
    await I.baixarImagem('https://x.com/a.jpg', { raizPublica: RAIZ,
      buscar: buscarQue(async () => resposta(HTML, { ct: 'image/jpeg' })) });
  } catch (e) { erro = e.message; }
  // O content-type dizia imagem; quem desmente é a assinatura do arquivo.
  assert(/não é uma imagem/.test(erro || ''), 'erro: ' + erro);
});

await t('content-type não-imagem é recusado antes de baixar tudo', async () => {
  let erro = null;
  try {
    await I.baixarImagem('https://x.com/a', { raizPublica: RAIZ,
      buscar: buscarQue(async () => resposta(JPEG, { ct: 'text/html' })) });
  } catch (e) { erro = e.message; }
  assert(/não devolveu imagem/.test(erro || ''), 'erro: ' + erro);
});

await t('arquivo minúsculo é recusado', async () => {
  let erro = null;
  try {
    await I.baixarImagem('https://x.com/a.jpg', { raizPublica: RAIZ,
      buscar: buscarQue(async () => resposta(Buffer.from([0xFF, 0xD8, 0xFF]), { ct: 'image/jpeg' })) });
  } catch (e) { erro = e.message; }
  assert(/pequeno demais/.test(erro || ''), 'erro: ' + erro);
});

await t('origem fora do ar dá erro com o status', async () => {
  let erro = null;
  try {
    await I.baixarImagem('https://x.com/a.jpg', { raizPublica: RAIZ,
      buscar: buscarQue(async () => resposta(JPEG, { status: 404 })) });
  } catch (e) { erro = e.message; }
  assert(/HTTP 404/.test(erro || ''), 'erro: ' + erro);
});

await t('assinatura decide a extensão, não a URL', async () => {
  const r = await I.baixarImagem('https://x.com/foto.jpg', { raizPublica: RAIZ,
    buscar: buscarQue(async () => resposta(PNG, { ct: 'image/png' })) });
  assert(r.caminho.endsWith('.png'), 'extensão: ' + r.caminho);
  assert(fs.existsSync(path.join(RAIZ, r.caminho.replace(/^\//, ''))), 'arquivo não foi gravado');
});

// ---------- vínculo com o produto ----------
await t('primeira imagem vira a capa do produto', async () => {
  const r = await I.adicionarImagem(db, P, { url: 'https://cdn.fab.com/1.jpg', origem: 'fabricante',
    usuario: 'ana', raizPublica: RAIZ, buscar: buscarQue(async () => resposta(JPEG)) });
  const p = db.prepare('SELECT imagemPath FROM produtos WHERE id=?').get(P);
  assert(p.imagemPath === r.caminho, 'capa: ' + p.imagemPath);
  assert(r.ordem === 0, 'ordem: ' + r.ordem);
});

await t('a origem e quem autorizou ficam registradas', async () => {
  const img = db.prepare('SELECT * FROM produto_imagens WHERE produtoId=? ORDER BY ordem').get(P);
  assert(img.origem === 'fabricante', 'origem: ' + img.origem);
  assert(img.urlOrigem === 'https://cdn.fab.com/1.jpg', 'urlOrigem: ' + img.urlOrigem);
  assert(img.autorizadoPor === 'ana' && img.autorizadoEm, 'sem registro de autorização');
});

await t('segunda imagem entra na galeria sem trocar a capa', async () => {
  const capaAntes = db.prepare('SELECT imagemPath FROM produtos WHERE id=?').get(P).imagemPath;
  const r = await I.adicionarImagem(db, P, { url: 'https://cdn.fab.com/2.jpg', origem: 'fabricante',
    raizPublica: RAIZ, buscar: buscarQue(async () => resposta(JPEG)) });
  assert(r.ordem === 1, 'ordem: ' + r.ordem);
  assert(db.prepare('SELECT imagemPath FROM produtos WHERE id=?').get(P).imagemPath === capaAntes, 'a capa mudou');
  assert(I.listarImagens(db, P).length === 2, 'galeria: ' + I.listarImagens(db, P).length);
});

await t('origem inválida é recusada', async () => {
  let erro = null;
  try {
    await I.adicionarImagem(db, P, { url: 'https://x.com/a.jpg', origem: 'roubada',
      raizPublica: RAIZ, buscar: buscarQue(async () => resposta(JPEG)) });
  } catch (e) { erro = e.message; }
  assert(/Origem inválida/.test(erro || ''), 'erro: ' + erro);
});

await t('remover a capa promove a próxima e apaga o arquivo', async () => {
  const capa = db.prepare('SELECT * FROM produto_imagens WHERE produtoId=? ORDER BY ordem').get(P);
  const arquivo = path.join(RAIZ, capa.caminho.replace(/^\//, ''));
  assert(fs.existsSync(arquivo), 'arquivo deveria existir antes');
  const r = I.removerImagem(db, P, capa.id, { raizPublica: RAIZ });
  assert(r.novaCapa && r.novaCapa !== capa.caminho, 'não promoveu a próxima: ' + JSON.stringify(r));
  assert(db.prepare('SELECT imagemPath FROM produtos WHERE id=?').get(P).imagemPath === r.novaCapa, 'capa desatualizada');
  // Arquivo órfão em diretório público é lixo que fica para sempre.
  assert(!fs.existsSync(arquivo), 'arquivo continuou no disco');
});

await t('remover a última zera a capa do produto', async () => {
  for (const img of I.listarImagens(db, P)) I.removerImagem(db, P, img.id, { raizPublica: RAIZ });
  assert(db.prepare('SELECT imagemPath FROM produtos WHERE id=?').get(P).imagemPath === null, 'capa não foi limpa');
});

await t('imagem de produto inexistente é recusada', async () => {
  let erro = null;
  try {
    await I.adicionarImagem(db, 99999, { url: 'https://x.com/a.jpg', raizPublica: RAIZ,
      buscar: buscarQue(async () => resposta(JPEG)) });
  } catch (e) { erro = e.message; }
  assert(/Produto não encontrado/.test(erro || ''), 'erro: ' + erro);
});

console.log(`\n${ok} OK, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
})();
