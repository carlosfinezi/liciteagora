/**
 * marketplaces-routes.js — Integrações com marketplaces (estrutura MVP).
 *
 * Modelo:
 *   marketplaces_integracoes — credenciais e configuração por canal (ML, Shopee, Magalu, WooCommerce, Shopify)
 *   marketplaces_pedidos     — pedidos importados (com vínculo opcional ao pedido local)
 *   marketplaces_logs        — log de operações de sync
 *
 * Esta versão MVP NÃO conecta às APIs reais. Permite:
 *   - cadastrar credenciais por canal (cifradas em base64 — substituir por crypto real)
 *   - registrar pedidos importados manualmente (ou via webhook futuro)
 *   - vincular pedido marketplace a pedido local (cria pedidos local com origem='marketplace')
 *   - log de tentativas/erros para evolução com APIs reais
 */

const { logAction } = require('./audit-log');

const CANAIS = ['mercado-livre', 'shopee', 'magalu', 'woocommerce', 'shopify', 'amazon', 'outros'];
const STATUS_PEDIDO = ['novo','pago','aprovado','enviado','entregue','cancelado','devolvido','vinculado'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketplaces_integracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal TEXT NOT NULL UNIQUE,
      apelido TEXT,
      credenciais TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      ultimaSync TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS marketplaces_pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal TEXT NOT NULL,
      idExterno TEXT NOT NULL,
      numeroExterno TEXT,
      compradorNome TEXT,
      compradorCpfCnpj TEXT,
      compradorEmail TEXT,
      dataPedido TEXT,
      valorTotal REAL DEFAULT 0,
      valorFrete REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'novo',
      formaPagamento TEXT,
      dadosBrutos TEXT,
      pedidoIdLocal INTEGER,
      observacoes TEXT,
      dataImport TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pedidoIdLocal) REFERENCES pedidos(id),
      UNIQUE(canal, idExterno)
    );
    CREATE INDEX IF NOT EXISTS idx_mp_canal_status ON marketplaces_pedidos(canal, status);
    CREATE INDEX IF NOT EXISTS idx_mp_data ON marketplaces_pedidos(dataPedido);

    CREATE TABLE IF NOT EXISTS marketplaces_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canal TEXT NOT NULL,
      tipo TEXT NOT NULL,
      mensagem TEXT,
      detalhes TEXT,
      sucesso INTEGER NOT NULL DEFAULT 1,
      data TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_mp_log ON marketplaces_logs(canal, data);
  `);
}

function registrarRotasMarketplaces(app, db) {
  migrarDB(db);

  // ---- INTEGRAÇÕES ----

  app.get('/api/marketplaces/integracoes', (req, res) => {
    try {
      const lista = db.prepare('SELECT id, canal, apelido, ativo, ultimaSync, observacoes, dataCriacao FROM marketplaces_integracoes ORDER BY canal').all();
      res.json({ success: true, integracoes: lista, canais: CANAIS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/marketplaces/integracoes', (req, res) => {
    try {
      const { canal, apelido, credenciais, observacoes } = req.body;
      if (!canal || !CANAIS.includes(canal)) return res.status(400).json({ success: false, error: 'canal inválido' });
      const credEnc = credenciais ? Buffer.from(JSON.stringify(credenciais)).toString('base64') : null;
      const existente = db.prepare('SELECT id FROM marketplaces_integracoes WHERE canal = ?').get(canal);
      if (existente) {
        db.prepare('UPDATE marketplaces_integracoes SET apelido = ?, credenciais = ?, observacoes = ? WHERE id = ?').run(apelido || null, credEnc, observacoes || null, existente.id);
        logAction(db, req, 'editar', 'marketplace-integracao', existente.id, { canal });
      } else {
        const r = db.prepare('INSERT INTO marketplaces_integracoes (canal, apelido, credenciais, observacoes) VALUES (?, ?, ?, ?)').run(canal, apelido || null, credEnc, observacoes || null);
        logAction(db, req, 'criar', 'marketplace-integracao', r.lastInsertRowid, { canal });
      }
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/marketplaces/integracoes/:id', (req, res) => {
    try {
      db.prepare('UPDATE marketplaces_integracoes SET ativo = 0 WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---- PEDIDOS ----

  app.get('/api/marketplaces/pedidos', (req, res) => {
    try {
      const { canal, status, q } = req.query;
      let sql = 'SELECT * FROM marketplaces_pedidos WHERE 1=1';
      const params = [];
      if (canal) { sql += ' AND canal = ?'; params.push(canal); }
      if (status) { sql += ' AND status = ?'; params.push(status); }
      if (q) { sql += ' AND (idExterno LIKE ? OR numeroExterno LIKE ? OR compradorNome LIKE ?)'; const like=`%${q}%`; params.push(like,like,like); }
      sql += ' ORDER BY dataPedido DESC LIMIT 500';
      const pedidos = db.prepare(sql).all(...params);
      res.json({ success: true, pedidos, canais: CANAIS, statusList: STATUS_PEDIDO });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Registro manual de pedido marketplace (provisório até integrar API real)
  app.post('/api/marketplaces/pedidos', (req, res) => {
    try {
      const b = req.body;
      if (!b.canal || !b.idExterno) return res.status(400).json({ success: false, error: 'canal e idExterno obrigatórios' });
      const r = db.prepare(`
        INSERT INTO marketplaces_pedidos (canal, idExterno, numeroExterno, compradorNome, compradorCpfCnpj, compradorEmail,
                                          dataPedido, valorTotal, valorFrete, status, formaPagamento, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(b.canal, b.idExterno, b.numeroExterno || null, b.compradorNome || null, b.compradorCpfCnpj || null, b.compradorEmail || null,
              b.dataPedido || new Date().toISOString().slice(0,10),
              Number(b.valorTotal)||0, Number(b.valorFrete)||0,
              b.status || 'novo', b.formaPagamento || null, b.observacoes || null);
      logAction(db, req, 'importar', 'marketplace-pedido', r.lastInsertRowid, { canal: b.canal, idExterno: b.idExterno });
      res.json({ success: true, pedido: db.prepare('SELECT * FROM marketplaces_pedidos WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Vincula um pedido marketplace a um pedido local (cria pedido novo se necessário)
  app.post('/api/marketplaces/pedidos/:id/vincular', (req, res) => {
    try {
      const mp = db.prepare('SELECT * FROM marketplaces_pedidos WHERE id = ?').get(req.params.id);
      if (!mp) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const { pedidoLocalId, criarPedido } = req.body;
      let finalPedidoId = pedidoLocalId;
      if (!finalPedidoId && criarPedido) {
        // próximo número
        const ultimo = db.prepare('SELECT numero FROM pedidos ORDER BY id DESC LIMIT 1').get();
        let n = 1; if (ultimo) { const m = String(ultimo.numero).match(/(\d+)/); if (m) n = parseInt(m[1],10) + 1; }
        const numero = String(n).padStart(6, '0');
        const r = db.prepare(`
          INSERT INTO pedidos (numero, tipo, status, dataPedido, valorTotal, observacao)
          VALUES (?, 'marketplace', 'confirmado', ?, ?, ?)
        `).run(numero, mp.dataPedido || new Date().toISOString().slice(0,10), mp.valorTotal,
                `Origem: ${mp.canal} #${mp.idExterno} (${mp.compradorNome||'sem nome'})`);
        finalPedidoId = r.lastInsertRowid;
      }
      if (!finalPedidoId) return res.status(400).json({ success: false, error: 'pedidoLocalId ou criarPedido=true obrigatório' });
      db.prepare('UPDATE marketplaces_pedidos SET pedidoIdLocal = ?, status = ? WHERE id = ?').run(finalPedidoId, 'vinculado', mp.id);
      logAction(db, req, 'vincular', 'marketplace-pedido', mp.id, { pedidoLocalId: finalPedidoId });
      res.json({ success: true, pedidoLocalId: finalPedidoId });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Sync (placeholder — registra apenas no log para futuras integrações reais)
  app.post('/api/marketplaces/integracoes/:id/sync', (req, res) => {
    try {
      const integ = db.prepare('SELECT * FROM marketplaces_integracoes WHERE id = ?').get(req.params.id);
      if (!integ) return res.status(404).json({ success: false, error: 'Integração não encontrada' });
      db.prepare('INSERT INTO marketplaces_logs (canal, tipo, mensagem, sucesso) VALUES (?, ?, ?, ?)')
        .run(integ.canal, 'sync', 'Sync solicitada — implementação real pendente', 0);
      db.prepare('UPDATE marketplaces_integracoes SET ultimaSync = CURRENT_TIMESTAMP WHERE id = ?').run(integ.id);
      res.json({ success: true, importados: 0, mensagem: 'Stub: integração com API real do canal pendente' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/marketplaces/logs', (req, res) => {
    try {
      const { canal } = req.query;
      let sql = 'SELECT * FROM marketplaces_logs WHERE 1=1';
      const params = [];
      if (canal) { sql += ' AND canal = ?'; params.push(canal); }
      sql += ' ORDER BY id DESC LIMIT 200';
      const logs = db.prepare(sql).all(...params);
      res.json({ success: true, logs });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasMarketplaces };
