// comprasnet-mensagem-routes.js
//
// ENVIO de mensagem no chat da compra (a contrapartida da leitura que o
// chat-mensagens-ingest.js já fazia). Fecha a lacuna que o roadmap chama de
// "Negociação pós-lance — só detecta".
//
// Endpoint descoberto em 03/08/2026 lendo o bundle do fornecedor na SPA do
// cnetmobile e confirmado por negociação de método, sem escrever nada:
//   GET     .../v1/sistema/compras/{compra}/mensagens → 405 "Method 'GET' is not supported"
//   OPTIONS .../v1/sistema/compras/{compra}/mensagens → Allow: POST,OPTIONS
//
// O corpo é o DTO que a SPA monta em `enviarMensagem(compraId, …, vinculadaADiligencia=false)`:
//   { texto, identificadorItem, identificadorDestinatario, identificadorRemetente, vinculadaADiligencia }
// São os mesmos cinco campos que a nossa tabela de mensagens já guarda na leitura
// — mesmo contrato, direção invertida.
//
// Como anexos: captcha-free, só Bearer.

const axios = require('axios');
const https = require('https');

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const API_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'x-device-platform': 'web',
  'x-version-number': '6.2.1',
};
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 10, timeout: 60000 });

// Limite nosso, não do portal — o tamanho aceito lá não foi medido. Serve para
// não mandar um texto absurdo por engano; se o portal recusar por tamanho, o
// erro dele volta íntegro para a tela.
const MAX_TEXTO = 2000;

const mensagensPath = (compra) => `/comprasnet-fase-externa/v1/sistema/compras/${compra}/mensagens`;

// DDL lazy: no registro o `db` é proxy no-op (multi-tenant); a tabela só nasce no
// request. Ver memória [liciteagora-servico-web-e-migracoes].
//
// Por que guardar: o ingest lê /comprasnet-mensagem/v1/mensagens, que é a caixa do
// que CHEGA para nós. O que sai não volta por lá — medido em 03/08/2026, todos os
// endpoints de leitura de chat da compra devolveram 204 vazio. Sem este registro,
// a mensagem enviada some da tela.
function ensureTabelaEnviadas(_db) {
  _db.prepare(`CREATE TABLE IF NOT EXISTS mensagens_enviadas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    compraId TEXT NOT NULL,
    identificadorItem TEXT,
    identificadorDestinatario TEXT,
    texto TEXT NOT NULL,
    vinculadaADiligencia INTEGER DEFAULT 0,
    statusPortal INTEGER,
    dataHoraEnvio TEXT DEFAULT CURRENT_TIMESTAMP
  )`).run();
  _db.prepare('CREATE INDEX IF NOT EXISTS idx_msg_env_compra ON mensagens_enviadas(compraId)').run();
}

// Mesmo contrato de comprasnet-anexos-routes.js.
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

function registrarRotasComprasnetMensagem(app, db) {
  // ── ENVIAR mensagem no chat de uma compra ──
  // Publica no chat do pregão. Irreversível: não há rota de exclusão de mensagem
  // no portal, ao contrário dos anexos.
  app.post('/api/comprasnet/mensagens', async (req, res) => {
    const b = req.body || {};
    const compra = b.compra;
    const texto = typeof b.texto === 'string' ? b.texto.trim() : '';

    if (!compra) return res.status(400).json({ success: false, error: 'compra é obrigatório' });
    if (!texto) return res.status(400).json({ success: false, error: 'texto da mensagem é obrigatório' });
    if (texto.length > MAX_TEXTO) {
      return res.status(400).json({ success: false, error: `Texto muito longo (${texto.length} caracteres; limite ${MAX_TEXTO}).` });
    }

    const ctx = getBearerContext(db);
    if (ctx.erro) return res.status(409).json({ success: false, error: ctx.erro });

    // item/destinatário nulos = mensagem da compra inteira, para todos.
    const payload = {
      texto,
      identificadorItem: b.item != null && String(b.item).trim() !== '' ? String(b.item).trim() : null,
      identificadorDestinatario: b.destinatario ? String(b.destinatario).trim() : null,
      identificadorRemetente: ctx.cnpj,
      vinculadaADiligencia: !!b.vinculadaADiligencia,
    };

    try {
      const r = await axios.post(`${BASE_URL}${mensagensPath(compra)}`, payload, {
        headers: { ...API_HEADERS, Authorization: ctx.token, 'Content-Type': 'application/json' },
        httpsAgent: keepAliveAgent, validateStatus: () => true, timeout: 30000,
      });
      const ok = r.status >= 200 && r.status < 300;

      // Só registra o que o portal aceitou — a tabela é o nosso comprovante,
      // não pode virar depósito de tentativa falha.
      if (ok) {
        try {
          ensureTabelaEnviadas(db);
          db.prepare(`INSERT INTO mensagens_enviadas
            (compraId, identificadorItem, identificadorDestinatario, texto, vinculadaADiligencia, statusPortal)
            VALUES (?, ?, ?, ?, ?, ?)`).run(
            String(compra), payload.identificadorItem, payload.identificadorDestinatario,
            payload.texto, payload.vinculadaADiligencia ? 1 : 0, r.status,
          );
        } catch (e) {
          // Falhar o registro local não invalida um envio que o portal já aceitou.
          console.error('[comprasnet-mensagem] envio ok mas falhou ao registrar:', e.message);
        }
      }

      return res.status(ok ? 200 : 502).json({
        success: ok,
        status: r.status,
        message: r.headers['message-summary'] || (ok ? 'Mensagem enviada' : 'Falha ao enviar'),
        // Em erro o portal devolve {title, detail}; repassa para a tela mostrar o motivo real.
        error: ok ? undefined : ((r.data && (r.data.detail || r.data.title)) || `HTTP ${r.status}`),
        data: r.data,
        enviado: payload,
      });
    } catch (e) { return res.status(502).json({ success: false, error: e.message }); }
  });

  // ── LISTAR o que já enviamos ──
  // Sem `compra` devolve tudo, que é como o Monitor de Chat consome (ele mescla
  // com a caixa de entrada antes de agrupar por licitação).
  app.get('/api/comprasnet/mensagens/enviadas', (req, res) => {
    try {
      ensureTabelaEnviadas(db);
      const { compra } = req.query;
      const rows = compra
        ? db.prepare('SELECT * FROM mensagens_enviadas WHERE compraId = ? ORDER BY dataHoraEnvio DESC').all(String(compra))
        : db.prepare('SELECT * FROM mensagens_enviadas ORDER BY dataHoraEnvio DESC LIMIT 2000').all();
      return res.json({ success: true, total: rows.length, data: rows });
    } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
  });
}

module.exports = { registrarRotasComprasnetMensagem };
