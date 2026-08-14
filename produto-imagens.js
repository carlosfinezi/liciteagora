/**
 * produto-imagens.js — imagens de produto a partir de uma URL de origem
 * (fabricante, distribuidor, catálogo do ML ou foto própria hospedada).
 *
 * Por que baixar em vez de apontar direto para a URL do fabricante:
 *   1. O Mercado Livre baixa a imagem no momento da publicação. Link que
 *      muda ou cai deixa o anúncio sem foto depois de publicado.
 *   2. Hotlink no servidor do fabricante costuma ser bloqueado por referer.
 *   3. Guardando a origem, dá para provar de onde veio cada imagem.
 *
 * A origem e a autorização ficam gravadas em cada imagem. Quem sabe se tem
 * direito de uso é quem tem o contrato de revenda — o sistema registra a
 * declaração, não a presume.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 12 * 1024 * 1024;      // ML recorta acima disso de qualquer forma
const MIN_BYTES = 1024;                   // menos que isso não é foto de produto
const TIPOS = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif',
};
const ORIGENS = ['fabricante', 'distribuidor', 'catalogo-ml', 'propria', 'outra'];

function migrarImagensDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS produto_imagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      caminho TEXT NOT NULL,
      urlOrigem TEXT,
      origem TEXT NOT NULL DEFAULT 'outra',
      autorizadoPor TEXT,
      autorizadoEm TEXT,
      largura INTEGER, altura INTEGER, bytes INTEGER,
      ordem INTEGER DEFAULT 0,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_prodimg_prod ON produto_imagens(produtoId, ordem);
  `);
}

/**
 * O servidor vai buscar uma URL que o usuário digitou — então ela não pode
 * apontar para dentro da própria infraestrutura. Sem esta checagem, um campo
 * de "URL da foto" vira uma forma de fazer o servidor ler a rede interna
 * (metadados da nuvem, painel em localhost, banco em rede privada).
 */
function urlSegura(entrada) {
  let u;
  try { u = new URL(String(entrada)); } catch { return { ok: false, motivo: 'URL inválida' }; }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return { ok: false, motivo: 'Só http e https são aceitos' };
  }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return { ok: false, motivo: 'Endereço local não é uma origem válida de imagem' };
  }
  // Faixas privadas e link-local, incluindo o 169.254.169.254 dos metadados.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const privado = a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || a >= 224;
    if (privado) return { ok: false, motivo: 'Endereço de rede interna não é uma origem válida' };
  }
  if (/^\[?([0-9a-f]*:){2,}/i.test(host) && /^(\[?::1|\[?f[cd])/i.test(host)) {
    return { ok: false, motivo: 'Endereço IPv6 interno não é uma origem válida' };
  }
  return { ok: true, url: u.toString() };
}

/** Assinatura do arquivo, porque content-type mente. */
function tipoReal(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8) return '.jpg';
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return '.png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
  return null;
}

/**
 * Baixa a imagem e grava em public/uploads/produtos.
 * @returns {{caminho, bytes, ext}} caminho já no formato servido pela web.
 */
async function baixarImagem(url, { raizPublica, subdir = 'uploads/produtos', buscar = fetch } = {}) {
  const seguro = urlSegura(url);
  if (!seguro.ok) throw new Error(seguro.motivo);

  const r = await buscar(seguro.url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`Origem respondeu HTTP ${r.status}`);

  const ct = String(r.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  if (ct && !TIPOS[ct]) throw new Error(`A URL não devolveu imagem (veio ${ct || 'sem tipo'})`);

  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`Imagem com ${(buf.length / 1048576).toFixed(1)} MB — o limite é 12 MB`);
  if (buf.length < MIN_BYTES) throw new Error('Arquivo pequeno demais para ser foto de produto');

  // Content-type pode vir errado ou ausente; a assinatura do arquivo decide.
  const ext = tipoReal(buf);
  if (!ext) throw new Error('O conteúdo baixado não é uma imagem JPEG, PNG, WEBP ou GIF');

  const destinoDir = path.join(raizPublica, subdir);
  fs.mkdirSync(destinoDir, { recursive: true });
  const nome = crypto.randomBytes(12).toString('hex') + ext;
  fs.writeFileSync(path.join(destinoDir, nome), buf);
  return { caminho: '/' + subdir.replace(/^\/+/, '') + '/' + nome, bytes: buf.length, ext };
}

/** Registra uma imagem para o produto. A primeira vira a capa. */
async function adicionarImagem(db, produtoId, { url, origem = 'outra', usuario = null,
                                               raizPublica, buscar = fetch } = {}) {
  const produto = db.prepare('SELECT id FROM produtos WHERE id = ?').get(produtoId);
  if (!produto) throw new Error('Produto não encontrado');
  if (!ORIGENS.includes(origem)) throw new Error(`Origem inválida: ${origem}`);

  const baixada = await baixarImagem(url, { raizPublica, buscar });
  const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 AS n FROM produto_imagens WHERE produtoId = ?')
    .get(produtoId).n;

  const id = db.prepare(`INSERT INTO produto_imagens
      (produtoId, caminho, urlOrigem, origem, autorizadoPor, autorizadoEm, bytes, ordem)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)`)
    .run(produtoId, baixada.caminho, String(url).slice(0, 500), origem, usuario, baixada.bytes, ordem)
    .lastInsertRowid;

  // imagemPath é o campo que o resto do sistema já lê; a capa vai para lá.
  if (ordem === 0) {
    db.prepare('UPDATE produtos SET imagemPath = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
      .run(baixada.caminho, produtoId);
  }
  return { id, ...baixada, ordem, origem };
}

function listarImagens(db, produtoId) {
  try { return db.prepare('SELECT * FROM produto_imagens WHERE produtoId = ? ORDER BY ordem').all(produtoId); }
  catch { return []; }
}

function removerImagem(db, produtoId, imagemId, { raizPublica } = {}) {
  const img = db.prepare('SELECT * FROM produto_imagens WHERE id = ? AND produtoId = ?').get(imagemId, produtoId);
  if (!img) throw new Error('Imagem não encontrada');
  db.prepare('DELETE FROM produto_imagens WHERE id = ?').run(img.id);
  // Some do disco também: arquivo órfão em diretório público é lixo que fica.
  try { if (raizPublica) fs.unlinkSync(path.join(raizPublica, img.caminho.replace(/^\//, ''))); } catch { }

  const proxima = db.prepare('SELECT caminho FROM produto_imagens WHERE produtoId = ? ORDER BY ordem LIMIT 1').get(produtoId);
  db.prepare('UPDATE produtos SET imagemPath = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
    .run(proxima ? proxima.caminho : null, produtoId);
  return { removida: img.id, novaCapa: proxima ? proxima.caminho : null };
}

module.exports = {
  migrarImagensDB, urlSegura, tipoReal, baixarImagem,
  adicionarImagem, listarImagens, removerImagem, ORIGENS,
};
