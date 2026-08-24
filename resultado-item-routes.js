// resultado-item-routes.js
//
// Desfecho da disputa POR ITEM (o que resultado_comprasnet, que é 1 linha por
// compra, não guarda): o valor que efetivamente arrematamos.
//
// Fonte medida (03/08/2026, compra 15306506002472026 item 1):
//   GET /comprasnet-disputa/v1/compras/{compraId}/itens/{numeroItem}
//     → melhorValorFornecedor.valorInformado  = nosso melhor valor  (1068.81)
//     → melhorValorGeral.valorInformado       = melhor valor geral
//     → situacaoParticipanteDisputa: "G" = ganhador
//     → desclassificado: false | fase: "E" (encerrada)
//
// O sniper já lê esses campos em memória durante a disputa (sniper-lance-routes
// ~linhas 852/889/957/978/1038) mas NUNCA persiste — quando a sessão encerra o
// número se perde, e por isso valor_ganho fica 0 em participações. Aqui a gente
// grava, para a proposta ajustada sair com o valor certo em vez do pré-disputa.
//
// Só GET no portal; captcha-free, basta o Bearer (mesma descoberta que viabilizou
// comprasnet-anexos-routes.js). O endpoint tem rate-limit: 429 sem intervalo entre
// chamadas, por isso o sync em lote espaça as requisições.

const axios = require('axios');
const https = require('https');

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const API_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'x-device-platform': 'web',
  'x-version-number': '6.2.1',
};
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });

// Intervalo entre chamadas no sync em lote. Medido: sem espaçamento o portal
// devolve 429 já na segunda requisição.
const INTERVALO_LOTE_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bearer + CNPJ do tenant (mesmo contrato de comprasnet-anexos-routes.js).
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

// DDL lazy: no registro o `db` é proxy no-op (multi-tenant); a tabela só pode
// nascer dentro do request, quando o proxy já resolveu pro tenant.
// Ver memória [liciteagora-servico-web-e-migracoes].
function ensureResultadoItemTable(_db) {
  _db.prepare(`CREATE TABLE IF NOT EXISTS resultado_item_comprasnet (
    compraId TEXT NOT NULL,
    numeroItem INTEGER NOT NULL,
    valorArrematado REAL,
    valorMelhorGeral REAL,
    valorEstimado REAL,
    situacaoParticipante TEXT,
    ganhamos INTEGER,
    desclassificado INTEGER,
    fase TEXT,
    dataHoraFimContagem TEXT,
    atualizadoEm TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (compraId, numeroItem)
  )`).run();
}

// `valorCalculado` vem escalar quando a quantidade é 1 e objeto
// {valorUnitario, valorTotal} quando é maior (visto em propostas-iniciais).
// `valorInformado` é sempre escalar — é o que usamos.
function extrairValor(bloco) {
  if (!bloco || typeof bloco !== 'object') return null;
  const v = bloco.valorInformado;
  if (typeof v === 'number') return v;
  const c = bloco.valorCalculado;
  if (typeof c === 'number') return c;
  if (c && typeof c === 'object' && typeof c.valorUnitario === 'number') return c.valorUnitario;
  return null;
}

function normalizar(compraId, numeroItem, apiItem) {
  const situacao = apiItem.situacaoParticipanteDisputa || null;
  return {
    compraId: String(compraId),
    numeroItem: Number(numeroItem),
    valorArrematado: extrairValor(apiItem.melhorValorFornecedor),
    valorMelhorGeral: extrairValor(apiItem.melhorValorGeral),
    valorEstimado: typeof apiItem.valorEstimado === 'number' ? apiItem.valorEstimado : null,
    situacaoParticipante: situacao,
    // "G" = ganhador. Só afirmamos vitória com o código explícito; qualquer
    // outra coisa vira 0, e ausência de situação vira null (não sabemos).
    ganhamos: situacao == null ? null : (situacao === 'G' ? 1 : 0),
    desclassificado: apiItem.desclassificado == null ? null : (apiItem.desclassificado ? 1 : 0),
    fase: apiItem.fase || null,
    dataHoraFimContagem: apiItem.dataHoraFimContagem || null,
  };
}

function upsert(_db, r) {
  _db.prepare(`INSERT INTO resultado_item_comprasnet
    (compraId, numeroItem, valorArrematado, valorMelhorGeral, valorEstimado,
     situacaoParticipante, ganhamos, desclassificado, fase, dataHoraFimContagem, atualizadoEm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(compraId, numeroItem) DO UPDATE SET
      valorArrematado      = COALESCE(excluded.valorArrematado, valorArrematado),
      valorMelhorGeral     = COALESCE(excluded.valorMelhorGeral, valorMelhorGeral),
      valorEstimado        = COALESCE(excluded.valorEstimado, valorEstimado),
      situacaoParticipante = COALESCE(excluded.situacaoParticipante, situacaoParticipante),
      ganhamos             = COALESCE(excluded.ganhamos, ganhamos),
      desclassificado      = COALESCE(excluded.desclassificado, desclassificado),
      fase                 = COALESCE(excluded.fase, fase),
      dataHoraFimContagem  = COALESCE(excluded.dataHoraFimContagem, dataHoraFimContagem),
      atualizadoEm         = CURRENT_TIMESTAMP`).run(
    r.compraId, r.numeroItem, r.valorArrematado, r.valorMelhorGeral, r.valorEstimado,
    r.situacaoParticipante, r.ganhamos, r.desclassificado, r.fase, r.dataHoraFimContagem,
  );
}

// Busca no portal o estado do item. Devolve {ok, item} ou {ok:false, status}.
async function buscarItemNoPortal(token, compraId, numeroItem) {
  const url = `${BASE_URL}/comprasnet-disputa/v1/compras/${compraId}/itens/${numeroItem}`;
  const r = await axios.get(url, {
    headers: { ...API_HEADERS, Authorization: token },
    httpsAgent: keepAliveAgent, validateStatus: () => true, timeout: 20000,
  });
  if (r.status !== 200 || typeof r.data !== 'object' || r.data === null) {
    return { ok: false, status: r.status };
  }
  return { ok: true, item: r.data };
}

function registrarRotasResultadoItem(app, db) {
  // ── Lê do portal e persiste (1 item) ──
  app.get('/api/comprasnet/resultado-item', async (req, res) => {
    const { compra, item } = req.query;
    if (!compra || !item) return res.status(400).json({ success: false, error: 'compra e item são obrigatórios' });
    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });
    try {
      ensureResultadoItemTable(db);
      const r = await buscarItemNoPortal(ctx.token, compra, item);
      if (!r.ok) {
        return res.status(r.status === 429 ? 429 : 502).json({
          success: false, status: r.status,
          error: r.status === 429 ? 'Portal recusou por excesso de chamadas (429). Tente em alguns segundos.'
                                  : 'Item não encontrado na disputa',
        });
      }
      const dados = normalizar(compra, item, r.item);
      upsert(db, dados);
      return res.json({ success: true, resultado: dados });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });

  // ── Lê o que já está persistido (sem tocar no portal) ──
  app.get('/api/comprasnet/resultado-item/compra/:compraId', (req, res) => {
    try {
      ensureResultadoItemTable(db);
      const rows = db.prepare(
        'SELECT * FROM resultado_item_comprasnet WHERE compraId = ? ORDER BY numeroItem'
      ).all(String(req.params.compraId));
      const porItem = {};
      for (const r of rows) porItem[r.numeroItem] = r;
      return res.json({ success: true, itens: rows, porItem });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });

  // ── Sync em lote de uma compra (espaça as chamadas por causa do 429) ──
  app.post('/api/comprasnet/resultado-item/sincronizar', async (req, res) => {
    const b = req.body || {};
    const compra = b.compra;
    const itens = Array.isArray(b.itens) ? b.itens : [];
    if (!compra || !itens.length) return res.status(400).json({ success: false, error: 'compra e itens[] são obrigatórios' });
    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });
    try {
      ensureResultadoItemTable(db);
      const oks = []; const falhas = [];
      for (let i = 0; i < itens.length; i++) {
        if (i > 0) await sleep(INTERVALO_LOTE_MS);
        try {
          const r = await buscarItemNoPortal(ctx.token, compra, itens[i]);
          if (!r.ok) { falhas.push({ item: itens[i], status: r.status }); continue; }
          const dados = normalizar(compra, itens[i], r.item);
          upsert(db, dados);
          oks.push(dados);
        } catch (e) { falhas.push({ item: itens[i], erro: e.message }); }
      }
      return res.json({ success: true, gravados: oks.length, falhas, itens: oks });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });
}

module.exports = { registrarRotasResultadoItem, ensureResultadoItemTable };
