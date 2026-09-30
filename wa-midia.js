/**
 * wa-midia.js — a mídia que o contato manda no WhatsApp, para a tela de Conversas.
 *
 * Até 29/09 o webhook gravava só o tipo da mensagem ("imageMessage") e nunca o
 * arquivo, e a conversa mostrava "(sem texto)" no lugar da foto, do áudio ou do
 * documento. O arquivo continua na Evolution, que o entrega por
 * `POST /chat/getBase64FromMediaMessage/<instância>` com o id da mensagem,
 * inclusive a imagem de dentro da mensagem de empresa (templateMessage).
 *
 * A busca é na hora de abrir a conversa, e a cópia fica em
 * data/tenants/<slug>/wa-midia/<id>.bin (mais o .json com o tipo e o nome):
 * mídia que ninguém abre não ocupa disco, e a que se abre não é buscada de
 * novo. Mensagem que a Evolution já não tem volta como erro dito.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TIPOS_MIDIA = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
  'documentWithCaptionMessage', 'stickerMessage', 'ptvMessage', 'templateMessage']);
const MAX_BYTES = 32 * 1024 * 1024;

const modulo = {
  raiz: path.join(__dirname, 'data', 'tenants'),
};

const pasta = (slug) => path.join(modulo.raiz, String(slug || 'default').replace(/[^a-z0-9-]/gi, ''), 'wa-midia');

function credenciais(db, instance) {
  let c = null;
  try { c = db.prepare('SELECT baseUrl, apikey FROM whatsapp_canais WHERE instance = ?').get(instance); } catch (_) { /* sem a tabela */ }
  const base = String((c && c.baseUrl) || process.env.EVOLUTION_URL || '').replace(/\/$/, '');
  const apikey = (c && c.apikey) || process.env.EVOLUTION_APIKEY || '';
  return { base, apikey };
}

/**
 * A mídia da mensagem `id` de whatsapp_messages: { arquivo, mimetype, fileName }.
 * Lança Error com mensagem legível quando não há mídia ou a Evolution não a tem.
 */
async function obter(db, slug, id, { buscar = fetch } = {}) {
  const m = db.prepare('SELECT id, wa_message_id, instance, message_type FROM whatsapp_messages WHERE id = ?').get(Number(id));
  if (!m) throw Object.assign(new Error('Mensagem não encontrada'), { status: 404 });
  if (!TIPOS_MIDIA.has(m.message_type)) throw Object.assign(new Error('A mensagem não tem mídia'), { status: 404 });
  const dir = pasta(slug);
  const bin = path.join(dir, `${m.id}.bin`), meta = path.join(dir, `${m.id}.json`);
  if (fs.existsSync(bin) && fs.existsSync(meta)) return { arquivo: bin, ...JSON.parse(fs.readFileSync(meta, 'utf8')) };

  const { base, apikey } = credenciais(db, m.instance);
  if (!base || !m.wa_message_id || !m.instance) throw Object.assign(new Error('Sem como buscar a mídia no WhatsApp'), { status: 502 });
  const r = await buscar(`${base}/chat/getBase64FromMediaMessage/${encodeURIComponent(m.instance)}`, {
    method: 'POST', headers: { apikey, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { key: { id: m.wa_message_id } }, convertToMp4: false }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.base64) {
    throw Object.assign(new Error('O WhatsApp não tem mais esta mídia'), { status: 404 });
  }
  const buf = Buffer.from(j.base64, 'base64');
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('Mídia grande demais para a tela'), { status: 413 });
  const info = { mimetype: String(j.mimetype || 'application/octet-stream').split(';')[0], fileName: j.fileName || null };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(bin, buf);
  fs.writeFileSync(meta, JSON.stringify(info));
  return { arquivo: bin, ...info };
}

module.exports = modulo;
Object.assign(modulo, { TIPOS_MIDIA, obter, pasta });
