/**
 * whatsapp-adapter.js — Camada plugável para envio de WhatsApp
 *
 * Comportamento atual: enfileira a mensagem no banco (tabela whatsapp_queue).
 * Quando um provider for escolhido (Evolution, Z-API, Meta Cloud API),
 * implementar o dispatch real em dispatchViaProvider(db, item).
 *
 * O frontend pode consumir /api/whatsapp/queue para enviar manualmente
 * (abrir wa.me em massa) enquanto não houver provider configurado.
 */

// Credenciais globais do Evolution (systemd Environment). A config do tenant só
// guarda provider + instance; base/apikey vêm daqui (não replica segredo por-tenant).
const EVOLUTION_URL = process.env.EVOLUTION_URL || '';
const EVOLUTION_APIKEY = process.env.EVOLUTION_APIKEY || '';

const WEBHOOK_URL = process.env.EVOLUTION_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/webhook';

const DEFAULT_ATEND = 'Você é o atendente virtual desta empresa no WhatsApp. Responda em português, de forma breve e cordial.';
const KB_SEP = '\n\n=== BASE DE CONHECIMENTO ===\n\n';

// Garantia 1 (nunca silêncio): quando a IA roda mas o LLM vem vazio/falha, devolve isto
// em vez de nada. Usado pelo atendimento real (autoResponder) e pelo simulador.
const FALLBACK_SEM_RESPOSTA = 'Recebi sua mensagem! Já te retorno por aqui.';

// Garantia 2 (interina, anti-alucinação): guard-rail mínimo pra IA não inventar fato quando
// a base é seca. A trava completa + escalonamento pro humano é a Parte 2 (ver TODO abaixo).
const GUARDRAIL_INTERINO = 'Responda apenas com o que estiver nesta base. Se não tiver a informação (preço, produto, arquivo, prazo ou qualquer dado específico), NÃO invente: diga de forma breve que vai confirmar e retornar. Prefira ser vago a criar um fato.';

// Do briefing da campanha (material de abordagem do M1), remove as frases sobre a PRÓPRIA M1
// — elas orientam a ESCRITA da abordagem, não são fato de atendimento.
function briefingLimpo(briefing) {
  return String(briefing || '')
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim() && !/\bM1\b/i.test(s))
    .join(' ')
    .trim();
}

// >>> PONTO DE INJEÇÃO DA BASE DE ATENDIMENTO DA CAMPANHA <<<
// Precedência:
//   1. Base de atendimento DEDICADA (atendimento_prompt/_kb) — SLOT DA PARTE 2 (factual).
//   2. Fiação Parte 1: material de abordagem do M1 (persona = tom, briefing limpo = contexto).
// TODO Parte 2: sem base dedicada → ESCALAR PARA HUMANO, em vez de derivar do M1. O fallback
//   silencioso pro KB genérico do tenant (removido daqui) foi o que gerou a "planilha".
function buildAtendimentoBaseCampanha(campCfg) {
  const temDedicada = campCfg.atendimento_prompt || campCfg.atendimento_kb;
  const prompt = temDedicada ? (campCfg.atendimento_prompt || DEFAULT_ATEND) : (campCfg.persona || DEFAULT_ATEND);
  const kb     = temDedicada ? (campCfg.atendimento_kb || '') : briefingLimpo(campCfg.briefing);
  const corpo  = kb ? prompt + KB_SEP + kb : prompt;
  return corpo + '\n\n' + GUARDRAIL_INTERINO;
}

// FONTE ÚNICA do system prompt do atendimento IA — atendimento REAL (autoResponder) E
// simulador, pra nunca divergirem. Lead de campanha => SEMPRE base da campanha (nunca o
// KB do tenant). Sem campanha (atendimento geral) => KB do tenant, como hoje.
function buildSystemAtendimento(db, campanhaId) {
  if (campanhaId) {
    try {
      const c = db.prepare("SELECT config FROM wa_campanhas WHERE id = ?").get(campanhaId);
      if (c) return buildAtendimentoBaseCampanha(JSON.parse(c.config || '{}'));
    } catch (_) {}
  }
  const { getConfigValue } = require('./config-helpers').createConfigHelpers(db);
  const base = getConfigValue('whatsapp_ai_prompt') || DEFAULT_ATEND;
  const kb = getConfigValue('whatsapp_ai_kb');
  return kb ? base + KB_SEP + kb : base;
}

function evoCreds(cfg) {
  const base = String((cfg && cfg.baseUrl) || EVOLUTION_URL || '').replace(/\/$/, '');
  const apikey = (cfg && cfg.apikey) || EVOLUTION_APIKEY || '';
  return { base, apikey };
}

// Aponta o webhook da instância pro liciteagora (recebimento). Só para instâncias
// 'le_*' — nunca mexe em status1bit (webhook dele vai pro status-bot).
async function setWebhook(base, apikey, instance) {
  if (!instance || !instance.startsWith('le_')) return;
  try {
    await fetch(`${base}/webhook/set/${instance}`, {
      method: 'POST', headers: { apikey, 'content-type': 'application/json' },
      body: JSON.stringify({ webhook: { enabled: true, url: WEBHOOK_URL, webhookByEvents: false, webhookBase64: false, events: ['MESSAGES_UPSERT'] } }),
    });
  } catch (_) { /* best-effort */ }
}

function migrarQueue(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefone TEXT NOT NULL,
      texto TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      erro TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataEnvio TEXT,
      provider TEXT,
      providerMessageId TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wa_queue_status ON whatsapp_queue(status);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wa_message_id TEXT,
      instance TEXT,
      remote_jid TEXT NOT NULL,
      from_me INTEGER DEFAULT 0,
      from_bot INTEGER DEFAULT 0,
      push_name TEXT,
      texto TEXT,
      message_type TEXT,
      timestamp INTEGER,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wa_msg_jid ON whatsapp_messages(remote_jid, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_waid ON whatsapp_messages(wa_message_id) WHERE wa_message_id IS NOT NULL;
  `);
  // tabelas criadas antes da coluna from_bot (migração idempotente)
  try { db.exec('ALTER TABLE whatsapp_messages ADD COLUMN from_bot INTEGER DEFAULT 0'); } catch (_) { /* já existe */ }
}

function loadProviderConfig(db) {
  migrarQueue(db);
  const rows = db.prepare('SELECT key, value FROM whatsapp_config').all();
  if (!rows.length) return null;
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  if (!cfg.provider) return null;
  return cfg;
}

/**
 * Envia uma mensagem via provider configurado.
 * Hoje retorna { queued: true } porque nenhum provider está implementado.
 *
 * Interface esperada de retorno:
 *   { success: true, providerMessageId }
 *   { success: false, error }
 *   { queued: true }
 */
async function enviarWhatsApp(db, { telefone, texto }) {
  migrarQueue(db);

  const cfg = loadProviderConfig(db);
  let telefoneNorm = String(telefone || '').replace(/\D/g, '');
  if (telefoneNorm && !telefoneNorm.startsWith('55')) telefoneNorm = '55' + telefoneNorm;

  if (!telefoneNorm) {
    return { success: false, error: 'Telefone invalido' };
  }

  if (!cfg) {
    // Enfileira para envio manual/posterior
    const id = db.prepare(
      'INSERT INTO whatsapp_queue (telefone, texto, status) VALUES (?, ?, ?)'
    ).run(telefoneNorm, texto, 'pendente').lastInsertRowid;
    return { queued: true, queueId: id };
  }

  try {
    const result = await dispatchViaProvider(db, cfg, { telefone: telefoneNorm, texto });
    const id = db.prepare(
      'INSERT INTO whatsapp_queue (telefone, texto, status, provider, providerMessageId, dataEnvio) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)'
    ).run(telefoneNorm, texto, 'enviado', cfg.provider, result.providerMessageId || null).lastInsertRowid;
    return { success: true, queueId: id, providerMessageId: result.providerMessageId };
  } catch (err) {
    db.prepare(
      'INSERT INTO whatsapp_queue (telefone, texto, status, erro, provider) VALUES (?, ?, ?, ?, ?)'
    ).run(telefoneNorm, texto, 'erro', err.message, cfg.provider);
    return { success: false, error: err.message };
  }
}

async function dispatchViaProvider(db, cfg, { telefone, texto }) {
  if (cfg.provider === 'evolution') {
    const { base, apikey } = evoCreds(cfg);
    if (!base || !cfg.instance || !apikey) {
      throw new Error('Config evolution incompleta (baseUrl/instance/apikey)');
    }
    const r = await fetch(`${base}/message/sendText/${cfg.instance}`, {
      method: 'POST',
      headers: { apikey, 'content-type': 'application/json' },
      body: JSON.stringify({ number: telefone, text: texto }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status !== 200 && r.status !== 201) {
      throw new Error(`evolution http ${r.status}: ${JSON.stringify(data).slice(0, 200)}`);
    }
    return { providerMessageId: data?.key?.id || null };
  }
  if (cfg.provider === 'zapi') {
    // TODO: implementar Z-API
    throw new Error('Provider zapi ainda nao implementado');
  }
  if (cfg.provider === 'meta') {
    // TODO: implementar Meta Cloud API
    throw new Error('Provider meta ainda nao implementado');
  }
  throw new Error('Provider desconhecido: ' + cfg.provider);
}

// Envia imagem (mídia) com legenda via Evolution. Fallback pra texto se não houver provider/imagem.
async function enviarWhatsAppMidia(db, { telefone, texto, imagePath }) {
  const cfg = loadProviderConfig(db);
  let tel = String(telefone || '').replace(/\D/g, '');
  if (tel && !tel.startsWith('55')) tel = '55' + tel;
  if (!tel) return { success: false, error: 'Telefone invalido' };
  if (!cfg || cfg.provider !== 'evolution' || !imagePath) return enviarWhatsApp(db, { telefone, texto });
  try {
    const fs = require('fs'), path = require('path');
    const { base, apikey } = evoCreds(cfg);
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const media = fs.readFileSync(imagePath).toString('base64');
    const r = await fetch(`${base}/message/sendMedia/${cfg.instance}`, {
      method: 'POST', headers: { apikey, 'content-type': 'application/json' },
      body: JSON.stringify({ number: tel, mediatype: 'image', mimetype: mime, media, fileName: path.basename(imagePath), caption: texto }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status !== 200 && r.status !== 201) return { success: false, error: `evolution media http ${r.status}` };
    return { success: true, providerMessageId: (data && data.key && data.key.id) || null };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Guard: só tenants com o módulo WhatsApp habilitado acessam /api/whatsapp/*.
// Flag dedicado por-tenant (config.whatsapp_enabled === '1'), independente da seção
// "comunicacao" (que está ligada em quase todos). Mesma fonte de verdade do menu. Fail-closed.
function exigirWhatsApp(db) {
  return (req, res, next) => {
    try {
      const row = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_enabled'").get();
      if (row && String(row.valor) === '1') return next();
    } catch (_) { /* fail-closed abaixo */ }
    return res.status(403).json({ success: false, error: 'modulo_whatsapp_desabilitado' });
  };
}

function registrarRotasWhatsApp(app, db) {
  migrarQueue(db);
  const gate = exigirWhatsApp(db);

  app.get('/api/whatsapp/queue', gate, (req, res) => {
    try {
      const status = req.query.status || 'pendente';
      const rows = db.prepare(
        'SELECT id, telefone, texto, status, erro, dataCriacao, dataEnvio FROM whatsapp_queue WHERE status = ? ORDER BY id DESC LIMIT 200'
      ).all(status);
      res.json({ success: true, items: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/whatsapp/queue/:id/marcar-enviado', gate, (req, res) => {
    try {
      db.prepare('UPDATE whatsapp_queue SET status = ?, dataEnvio = CURRENT_TIMESTAMP WHERE id = ?')
        .run('enviado', req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/whatsapp/config', gate, (req, res) => {
    try {
      const cfg = loadProviderConfig(db);
      // não expõe a apikey pro frontend
      const safe = cfg ? { ...cfg, apikey: cfg.apikey ? '***' : undefined } : { provider: null };
      res.json({ success: true, config: safe });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Estado da conexão no provider (PoC Evolution) — por-tenant via db proxy.
  app.get('/api/whatsapp/status', gate, async (req, res) => {
    try {
      const cfg = loadProviderConfig(db);
      if (!cfg || cfg.provider !== 'evolution' || !cfg.instance) {
        return res.json({ success: true, provider: cfg?.provider || null, instance: cfg?.instance || null, state: 'sem-config' });
      }
      const { base, apikey } = evoCreds(cfg);
      const r = await fetch(`${base}/instance/connectionState/${cfg.instance}`, { headers: { apikey } });
      const data = await r.json().catch(() => ({}));
      const state = data?.instance?.state || data?.state || (r.status === 404 ? 'inexistente' : null);
      res.json({ success: true, provider: 'evolution', instance: cfg.instance, state });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Envio de mensagem de teste (PoC) — usa o mesmo enviarWhatsApp gravando na whatsapp_queue.
  app.post('/api/whatsapp/test', gate, async (req, res) => {
    try {
      const { telefone, texto } = req.body || {};
      if (!telefone || !texto) return res.status(400).json({ success: false, error: 'telefone e texto obrigatorios' });
      const result = await enviarWhatsApp(db, { telefone, texto });
      res.json({ success: !result.error, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Pareamento por tenant: cria/garante a instância Evolution do tenant e devolve o QR.
  app.post('/api/whatsapp/connect', gate, async (req, res) => {
    try {
      const slug = req.tenantCtx?.slug;
      if (!slug) return res.status(400).json({ success: false, error: 'tenant nao resolvido' });
      const cfg = loadProviderConfig(db);
      const instance = (cfg && cfg.instance) || ('le_' + String(slug).replace(/[^a-z0-9-]/gi, '').toLowerCase());
      const { base, apikey } = evoCreds(cfg);
      if (!base || !apikey) return res.status(500).json({ success: false, error: 'EVOLUTION_URL/APIKEY nao configurados' });

      // já existe? qual estado?
      let state = null, exists = false;
      const st = await fetch(`${base}/instance/connectionState/${instance}`, { headers: { apikey } });
      if (st.status === 200) { exists = true; const d = await st.json().catch(() => ({})); state = d?.instance?.state || d?.state || null; }

      // persiste config do tenant (creds ficam no env global, não por-tenant)
      const up = db.prepare('INSERT INTO whatsapp_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      up.run('provider', 'evolution');
      up.run('instance', instance);
      await setWebhook(base, apikey, instance); // recebimento -> liciteagora (só le_*)

      if (state === 'open') return res.json({ success: true, connected: true, instance });

      let qr = null;
      if (exists) {
        const c = await fetch(`${base}/instance/connect/${instance}`, { headers: { apikey } });
        qr = (await c.json().catch(() => ({})))?.base64 || null;
      } else {
        const c = await fetch(`${base}/instance/create`, {
          method: 'POST', headers: { apikey, 'content-type': 'application/json' },
          body: JSON.stringify({ instanceName: instance, integration: 'WHATSAPP-BAILEYS', qrcode: true }),
        });
        const d = await c.json().catch(() => ({}));
        if (c.status !== 200 && c.status !== 201) throw new Error(`create http ${c.status}: ${JSON.stringify(d).slice(0, 160)}`);
        qr = d?.qrcode?.base64 || null;
      }
      res.json({ success: true, connected: false, instance, qr });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Desconecta (logout) a instância do tenant; mantém o nome pra reconectar depois.
  app.post('/api/whatsapp/disconnect', gate, async (req, res) => {
    try {
      const cfg = loadProviderConfig(db);
      if (!cfg || !cfg.instance) return res.json({ success: true });
      const { base, apikey } = evoCreds(cfg);
      await fetch(`${base}/instance/logout/${cfg.instance}`, { method: 'DELETE', headers: { apikey } }).catch(() => {});
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Inbox: conversas (agrupadas por remote_jid).
  app.get('/api/whatsapp/conversations', gate, (req, res) => {
    try {
      migrarQueue(db);
      const rows = db.prepare(`
        SELECT remote_jid AS jid,
               COUNT(*) AS total,
               MAX(id) AS lastId,
               (SELECT texto FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid ORDER BY id DESC LIMIT 1) AS ultimo,
               (SELECT push_name FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid AND push_name IS NOT NULL ORDER BY id DESC LIMIT 1) AS nome,
               (SELECT timestamp FROM whatsapp_messages x WHERE x.remote_jid = m.remote_jid ORDER BY id DESC LIMIT 1) AS ts
        FROM whatsapp_messages m
        GROUP BY remote_jid
        ORDER BY lastId DESC
        LIMIT 100
      `).all();
      res.json({ success: true, conversas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Inbox: mensagens de uma conversa.
  app.get('/api/whatsapp/messages', gate, (req, res) => {
    try {
      migrarQueue(db);
      const jid = String(req.query.jid || '');
      if (!jid) return res.status(400).json({ success: false, error: 'jid obrigatorio' });
      const rows = db.prepare(
        'SELECT id, from_me, push_name, texto, message_type, timestamp FROM whatsapp_messages WHERE remote_jid = ? ORDER BY id ASC LIMIT 500'
      ).all(jid);
      res.json({ success: true, mensagens: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Inbox: responder numa conversa (envia + grava o outgoing; echo do webhook deduplica).
  app.post('/api/whatsapp/send', gate, async (req, res) => {
    try {
      const { jid, texto } = req.body || {};
      if (!jid || !texto) return res.status(400).json({ success: false, error: 'jid e texto obrigatorios' });
      const telefone = String(jid).split('@')[0];
      const result = await enviarWhatsApp(db, { telefone, texto });
      if (result.error) return res.json({ success: false, error: result.error });
      try {
        migrarQueue(db);
        db.prepare('INSERT OR IGNORE INTO whatsapp_messages (wa_message_id, remote_jid, from_me, texto, timestamp) VALUES (?,?,?,?,?)')
          .run(result.providerMessageId || null, jid, 1, texto, Math.floor(Date.now() / 1000));
      } catch (_) {}
      res.json({ success: true, providerMessageId: result.providerMessageId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Config da auto-resposta IA (por tenant).
  app.get('/api/whatsapp/ai-config', gate, (req, res) => {
    try {
      const enabled = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_ai_enabled'").get();
      const prompt = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_ai_prompt'").get();
      const kb = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_ai_kb'").get();
      res.json({ success: true, enabled: enabled?.valor === '1', prompt: prompt?.valor || '', kb: kb?.valor || '' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.post('/api/whatsapp/ai-config', gate, (req, res) => {
    try {
      const { enabled, prompt, kb } = req.body || {};
      const up = db.prepare("INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)");
      up.run('whatsapp_ai_enabled', enabled ? '1' : '0');
      if (typeof prompt === 'string') up.run('whatsapp_ai_prompt', prompt.slice(0, 8000));
      if (typeof kb === 'string') up.run('whatsapp_ai_kb', kb.slice(0, 100000));
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Simular atendimento IA — mesmo pipeline do autoResponder (prompt + KB + histórico
  // + chamarChatLLM), sem enviar nem gravar.
  app.post('/api/whatsapp/sim-atendimento', gate, async (req, res) => {
    try {
      const raw = Array.isArray(req.body && req.body.history) ? req.body.history : [];
      const history = raw
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (!history.length) return res.status(400).json({ success: false, error: 'history vazio' });
      const { createConfigHelpers } = require('./config-helpers');
      const { chamarChatLLM } = require('./chat-ia');
      const keys = createConfigHelpers(db).getIAKeys();
      if (!keys) return res.json({ success: false, error: 'tenant sem chave de IA configurada' });
      // MESMA função do atendimento real (buildSystemAtendimento) → simulação idêntica.
      const campId = req.body && req.body.campanha_id;
      const prompt = buildSystemAtendimento(db, campId);
      let reply = '', provider;
      try {
        const out = await chamarChatLLM([{ role: 'system', content: prompt }, ...history], keys);
        reply = ((out && out.content) || '').trim(); provider = out && out.provider;
      } catch (_) { /* garantia 1: nunca silêncio → cai no fallback abaixo */ }
      if (!reply) reply = FALLBACK_SEM_RESPOSTA;
      res.json({ success: true, reply, provider, contexto: campId ? 'campanha' : 'tenant' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[WhatsApp] Rotas registradas (modo: ' + (loadProviderConfig(db)?.provider || 'fila') + ')');
}

module.exports = { enviarWhatsApp, enviarWhatsAppMidia, migrarQueue, loadProviderConfig, registrarRotasWhatsApp, buildSystemAtendimento, FALLBACK_SEM_RESPOSTA };
