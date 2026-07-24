// comprasnet-anexos-routes.js
//
// Anexos de participação no Comprasnet (fase-externa), por item de uma compra.
// Enviar/listar/excluir arquivos anexados à participação do fornecedor num item.
//
// Descoberta que viabiliza o server-side: axios + Bearer válido passa direto do IP
// do datacenter — o bot-manager só afeta o LOGIN gov.br (resolvido pelo
// govbr-bearer.service, que entrega o Bearer fresco em config.bearer_token). Os anexos
// NÃO exigem captcha nem cookie de sessão; só o Bearer.
//
// Endpoints reais do Comprasnet (confirmados empiricamente):
//   GET    .../v1/compras/{compraId}/itens/{item}/participacao/{cnpj}/anexos
//   POST   (mesmo path) multipart/form-data campo "file"
//   DELETE .../anexos/{encodeURIComponent(nome)}

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const API_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'x-device-platform': 'web',
  'x-version-number': '6.2.1',
};
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });

// Bearer + CNPJ do tenant, a partir de config.bearer_token (entregue pelo serviço de login).
function getBearerContext(db) {
  const row = db.prepare("SELECT valor FROM config WHERE chave = 'bearer_token'").get();
  if (!row || !row.valor) return { erro: 'Sem Bearer do Comprasnet. Verifique o serviço de login (govbr-bearer).' };
  const token = row.valor.startsWith('Bearer') ? row.valor : 'Bearer ' + row.valor;
  let claims;
  try { claims = JSON.parse(Buffer.from(token.replace(/^Bearer\s+/i, '').split('.')[1], 'base64url').toString()); }
  catch (e) { return { erro: 'Bearer inválido (JWT não parseável).' }; }
  const ttl = Math.round(claims.exp - Date.now() / 1000);
  if (ttl <= 5) return { erro: `Bearer expirado (${-ttl}s atrás). Aguarde a renovação automática.` };
  return { token, cnpj: claims.identificacao_fornecedor, ttl };
}

const anexosPath = (compra, item, cnpj) =>
  `/comprasnet-fase-externa/v1/compras/${compra}/itens/${item}/participacao/${cnpj}/anexos`;

function registrarRotasComprasnetAnexos(app, db) {
  const PUBLIC_DIR = path.join(__dirname, 'public');

  // ── INFO da compra (cabeçalho + chave PNCP p/ o front listar itens) ──
  app.get('/api/comprasnet/anexos/compra', async (req, res) => {
    const { compra } = req.query;
    if (!compra) return res.status(400).json({ success: false, error: 'compra é obrigatório' });
    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });
    try {
      const r = await axios.get(`${BASE_URL}/comprasnet-fase-externa/v1/compras/${compra}`, {
        headers: { ...API_HEADERS, Authorization: ctx.token }, httpsAgent: keepAliveAgent,
        validateStatus: () => true, timeout: 15000,
      });
      if (r.status !== 200 || typeof r.data !== 'object') {
        return res.status(502).json({ success: false, status: r.status, error: 'Compra não encontrada no Comprasnet' });
      }
      const c = r.data;
      // linkPncp: .../editais/{cnpj}/{ano}/{sequencial} → chave p/ itens do catálogo local
      let pncp = null;
      const m = String(c.linkPncp || '').match(/editais\/(\d{14})\/(\d{4})\/(\d+)/);
      if (m) pncp = { cnpj: m[1], ano: m[2], sequencial: m[3] };
      return res.json({
        success: true,
        compra: {
          compraId: compra, uasg: c.numeroUasg, numero: c.numero, ano: c.ano,
          orgao: c.nomeUasg, uf: c.ufUasg, objeto: c.objeto,
          situacao: c.situacaoCompraFaseExterna, linkPncp: c.linkPncp,
        },
        pncp,
      });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });

  // ── descrição de um item (captcha-free) p/ rotular no front ──
  app.get('/api/comprasnet/anexos/item', async (req, res) => {
    const { compra, item } = req.query;
    if (!compra || !item) return res.status(400).json({ success: false, error: 'compra e item são obrigatórios' });
    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });
    try {
      const r = await axios.get(`${BASE_URL}/comprasnet-fase-externa/v1/compras/${compra}/itens/${item}/detalhamento`, {
        headers: { ...API_HEADERS, Authorization: ctx.token }, httpsAgent: keepAliveAgent,
        validateStatus: () => true, timeout: 15000,
      });
      if (r.status !== 200 || typeof r.data !== 'object') return res.status(404).json({ success: false, status: r.status, error: 'Item não encontrado' });
      return res.json({ success: true, numero: r.data.numero, descricao: r.data.descricao });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });

  // ── LISTAR anexos de um item ──
  app.get('/api/comprasnet/anexos', async (req, res) => {
    const { compra, item } = req.query;
    if (!compra || !item) return res.status(400).json({ success: false, error: 'compra e item são obrigatórios' });
    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });
    try {
      const r = await axios.get(`${BASE_URL}${anexosPath(compra, item, ctx.cnpj)}`, {
        headers: { ...API_HEADERS, Authorization: ctx.token }, httpsAgent: keepAliveAgent,
        validateStatus: () => true, timeout: 15000,
      });
      const anexos = Array.isArray(r.data) ? r.data : [];
      return res.json({ success: r.status === 200, status: r.status, anexos, cnpj: ctx.cnpj });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });

  // ── ENVIAR um documento de habilitação como anexo ──
  app.post('/api/comprasnet/anexos', async (req, res) => {
    const { compra, item, documentoId } = req.body || {};
    if (!compra || !item || !documentoId) return res.status(400).json({ success: false, error: 'compra, item e documentoId são obrigatórios' });
    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });

    const doc = db.prepare('SELECT id, tipo, arquivo, arquivoNome, arquivoMime FROM habilitacao_documentos WHERE id = ?').get(documentoId);
    if (!doc) return res.status(404).json({ success: false, error: 'Documento de habilitação não encontrado' });
    if (!doc.arquivo) return res.status(422).json({ success: false, error: `"${doc.tipo}" não tem arquivo anexado no liciteagora` });
    const abs = path.join(PUBLIC_DIR, doc.arquivo);
    if (!fs.existsSync(abs)) return res.status(422).json({ success: false, error: 'Arquivo ausente no disco' });

    try {
      const fd = new FormData();
      fd.append('file', fs.createReadStream(abs), { filename: doc.arquivoNome, contentType: doc.arquivoMime });
      const r = await axios.post(`${BASE_URL}${anexosPath(compra, item, ctx.cnpj)}`, fd, {
        headers: { ...API_HEADERS, Authorization: ctx.token, ...fd.getHeaders() },
        httpsAgent: keepAliveAgent, validateStatus: () => true, timeout: 120000,
        maxContentLength: Infinity, maxBodyLength: Infinity,
      });
      const ok = r.status >= 200 && r.status < 300;
      return res.status(ok ? 200 : 502).json({
        success: ok, status: r.status,
        message: r.headers['message-summary'] || (ok ? 'Anexado' : 'Falha ao anexar'),
        data: r.data,
      });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });

  // ── EXCLUIR um anexo (pelo nome retornado na listagem) ──
  app.delete('/api/comprasnet/anexos', async (req, res) => {
    const { compra, item, nome } = req.body || {};
    if (!compra || !item || !nome) return res.status(400).json({ success: false, error: 'compra, item e nome são obrigatórios' });
    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });
    try {
      const url = `${BASE_URL}${anexosPath(compra, item, ctx.cnpj)}/${encodeURIComponent(nome)}`;
      const r = await axios.delete(url, {
        headers: { ...API_HEADERS, Authorization: ctx.token }, httpsAgent: keepAliveAgent,
        validateStatus: () => true, timeout: 20000,
      });
      const ok = r.status >= 200 && r.status < 300;
      return res.status(ok ? 200 : 502).json({
        success: ok, status: r.status,
        message: r.headers['message-summary'] || (ok ? 'Anexo excluído' : 'Falha ao excluir'),
      });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });
}

module.exports = { registrarRotasComprasnetAnexos };
