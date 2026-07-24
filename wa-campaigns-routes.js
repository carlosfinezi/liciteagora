/**
 * wa-campaigns-routes.js — campanhas de WhatsApp por tenant.
 * Fase 1: config + CSV + dry-run. Fase 2: envio REAL com throttle, limite-por-dia,
 * opt-out, dedup e cancel. Reusa wa-m1-utils (M1+validador) e enviarWhatsApp.
 * Gated pelo flag whatsapp_enabled.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { gerarM1, ensureOptOutTrailer, localDate } = require('./wa-m1-utils');
const { enviarWhatsApp, enviarWhatsAppMidia, loadProviderConfig } = require('./whatsapp-adapter');

// Campanhas em execução neste processo: key `${slug}:${id}` -> { cancelled }
const running = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Imagens da campanha: data/tenants/<slug>/wa-campaign-images/<campId>/
function campImagesDir(slug, id) { return path.join(__dirname, 'data', 'tenants', String(slug), 'wa-campaign-images', String(id)); }
function listCampImages(slug, id) {
  try { return fs.readdirSync(campImagesDir(slug, id)).filter(f => /\.(jpe?g|png|webp)$/i.test(f)); }
  catch (_) { return []; }
}
function logCamp(tdb, campId, msg) {
  try { tdb.prepare("INSERT INTO wa_campanha_log (campanha_id, ts, msg) VALUES (?, ?, ?)").run(campId, new Date().toISOString(), msg); } catch (_) {}
}

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_campanhas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      config TEXT,
      status TEXT DEFAULT 'rascunho',
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wa_campanha_dest (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanha_id INTEGER NOT NULL,
      telefone TEXT,
      nome TEXT,
      extras TEXT,
      status TEXT DEFAULT 'pendente',
      jid TEXT,
      enviado_em TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wacd_camp ON wa_campanha_dest(campanha_id, status);
    CREATE TABLE IF NOT EXISTS wa_optout (telefone TEXT PRIMARY KEY, criado_em TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS wa_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT, telefone TEXT, campanha TEXT,
      enviado_em TEXT, texto_enviado TEXT,
      resposta TEXT, respondido_em TEXT,
      criado_em TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS wa_campanha_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanha_id INTEGER NOT NULL,
      ts TEXT, msg TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_walog_camp ON wa_campanha_log(campanha_id, id);
    CREATE TABLE IF NOT EXISTS wa_agenda (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanha_id INTEGER NOT NULL,
      dias TEXT, hora TEXT, enabled INTEGER DEFAULT 1,
      ultimo_disparo TEXT
    );
  `);
  try { db.exec("ALTER TABLE wa_campanha_dest ADD COLUMN dia TEXT"); } catch (_) { /* já existe */ }
  try { db.exec("ALTER TABLE wa_campanha_dest ADD COLUMN erro TEXT"); } catch (_) { /* já existe */ }
}

function parseCSV(text) {
  const linhas = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (!linhas.length) return [];
  const headers = linhas[0].split(',').map(h => h.trim().toLowerCase());
  return linhas.slice(1).map(l => {
    const cells = l.split(',').map(c => c.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ''; });
    return row;
  });
}
function pickTel(row) { return row.telefone || row.phone || row.fone || row.celular || row.whatsapp || ''; }
function pickNome(row) { return row.nome || row.name || row.cliente || ''; }

// ===== Runner de envio real (roda fora do contexto de request; recebe o db REAL do tenant) =====
async function runCampaign(tdb, slug, id) {
  const key = slug + ':' + id;
  if (running.has(key)) return;
  const ctl = { cancelled: false };
  running.set(key, ctl);
  try {
    const camp = tdb.prepare('SELECT * FROM wa_campanhas WHERE id = ?').get(id);
    if (!camp) return;
    const config = JSON.parse(camp.config || '{}');
    const tz = config.timezone || 'America/Belem';
    const dailyLimit = config.daily_limit ?? 30;
    const minSec = config.throttle_min_sec ?? 45;
    const maxSec = config.throttle_max_sec ?? 120;

    const keys = require('./config-helpers').createConfigHelpers(tdb).getIAKeys();
    const { chamarChatLLM } = require('./chat-ia');
    const callLLM = async (m) => {
      try { const r = await chamarChatLLM(m, keys); return { ok: true, text: r.content }; }
      catch (e) { return { ok: false, err: e.message }; }
    };

    tdb.prepare("UPDATE wa_campanhas SET status = 'enviando' WHERE id = ?").run(id);
    const imgs = listCampImages(slug, id);
    logCamp(tdb, id, `iniciado (${imgs.length} imagem(ns) no pool)`);

    while (!ctl.cancelled) {
      const hoje = localDate(Date.now(), tz);
      // limite POR DIA por número (soma de todas as campanhas do tenant hoje)
      const enviadosHoje = tdb.prepare("SELECT COUNT(*) AS n FROM wa_campanha_dest WHERE status = 'enviado' AND dia = ?").get(hoje).n;
      if (enviadosHoje >= dailyLimit) { logCamp(tdb, id, `limite diário (${dailyLimit}) atingido`); break; }

      const d = tdb.prepare(`
        SELECT * FROM wa_campanha_dest
        WHERE campanha_id = ? AND status = 'pendente'
          AND telefone NOT IN (SELECT telefone FROM wa_optout)
        LIMIT 1
      `).get(id);
      if (!d) break; // acabou

      const row = Object.assign({ nome: d.nome }, JSON.parse(d.extras || '{}'));
      const gen = await gerarM1({ config, row, callLLM });
      if (!gen.ok) {
        const err = 'M1 reprovada: ' + ((gen.erros || []).join('; '));
        tdb.prepare("UPDATE wa_campanha_dest SET status = 'falha', erro = ? WHERE id = ?").run(err, d.id);
        logCamp(tdb, id, `falha ${d.telefone}: ${err}`);
        continue; // pula sem gastar throttle
      }
      const texto = ensureOptOutTrailer(gen.text);
      const img = imgs.length ? path.join(campImagesDir(slug, id), imgs[Math.floor(Math.random() * imgs.length)]) : null;
      const r = img
        ? await enviarWhatsAppMidia(tdb, { telefone: d.telefone, texto, imagePath: img })
        : await enviarWhatsApp(tdb, { telefone: d.telefone, texto });
      if (r && r.queued) { // sem provider conectado — aborta
        tdb.prepare("UPDATE wa_campanha_dest SET status = 'pendente' WHERE id = ?").run(d.id);
        logCamp(tdb, id, 'sem WhatsApp conectado — abortado');
        break;
      }
      if (r && r.success) {
        tdb.prepare("UPDATE wa_campanha_dest SET status = 'enviado', enviado_em = ?, dia = ?, erro = NULL WHERE id = ?")
          .run(new Date().toISOString(), hoje, d.id);
        logCamp(tdb, id, `enviado → ${d.telefone}${img ? ' [img]' : ''}`);
      } else {
        const err = (r && r.error) || 'falha';
        tdb.prepare("UPDATE wa_campanha_dest SET status = 'falha', erro = ? WHERE id = ?").run(err, d.id);
        logCamp(tdb, id, `falha ${d.telefone}: ${err}`);
      }

      if (ctl.cancelled) break;
      const wait = Math.round((minSec + Math.random() * Math.max(0, maxSec - minSec)) * 1000);
      await sleep(wait);
    }

    const restam = tdb.prepare("SELECT COUNT(*) AS n FROM wa_campanha_dest WHERE campanha_id = ? AND status = 'pendente'").get(id).n;
    const fim = ctl.cancelled ? 'cancelada' : (restam > 0 ? 'pausada' : 'concluida');
    tdb.prepare("UPDATE wa_campanhas SET status = ? WHERE id = ?").run(fim, id);
    logCamp(tdb, id, `fim: ${fim} (pendentes: ${restam})`);
  } catch (e) {
    console.error(`[wa-camp ${key}]`, e.message);
    try { tdb.prepare("UPDATE wa_campanhas SET status = 'erro' WHERE id = ?").run(id); } catch (_) {}
  } finally {
    running.delete(key);
  }
}

function registrarRotasWaCampanhas(app, db) {
  const gate = (req, res, next) => {
    try {
      const r = db.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_enabled'").get();
      if (r && String(r.valor) === '1') return next();
    } catch (_) {}
    return res.status(403).json({ success: false, error: 'modulo_whatsapp_desabilitado' });
  };

  app.get('/api/wa-campanhas', gate, (req, res) => {
    try {
      migrar(db);
      const rows = db.prepare(`
        SELECT c.*, (SELECT COUNT(*) FROM wa_campanha_dest d WHERE d.campanha_id = c.id) AS totalDest
        FROM wa_campanhas c ORDER BY c.id DESC
      `).all();
      res.json({ success: true, campanhas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/wa-leads', gate, (req, res) => {
    try {
      migrar(db);
      const leads = db.prepare("SELECT id, jid, telefone, campanha, texto_enviado, resposta, respondido_em FROM wa_leads ORDER BY respondido_em DESC LIMIT 500").all();
      res.json({ success: true, leads });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== Agenda de campanhas (recorrente: dias da semana + hora) =====
  app.get('/api/wa-agenda', gate, (req, res) => {
    try {
      migrar(db);
      const agenda = db.prepare("SELECT a.*, c.nome AS campanhaNome FROM wa_agenda a JOIN wa_campanhas c ON c.id = a.campanha_id ORDER BY a.id").all()
        .map(a => Object.assign({}, a, { dias: JSON.parse(a.dias || '[]'), enabled: !!a.enabled }));
      const campanhas = db.prepare("SELECT id, nome FROM wa_campanhas ORDER BY nome").all();
      res.json({ success: true, agenda, campanhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.post('/api/wa-agenda', gate, (req, res) => {
    try {
      migrar(db);
      const { campanha_id, dias, hora, enabled } = req.body || {};
      if (!campanha_id || !Array.isArray(dias) || !/^\d{2}:\d{2}$/.test(hora || '')) return res.status(400).json({ success: false, error: 'campanha_id, dias[] e hora HH:MM obrigatorios' });
      const r = db.prepare("INSERT INTO wa_agenda (campanha_id, dias, hora, enabled) VALUES (?, ?, ?, ?)").run(campanha_id, JSON.stringify(dias), hora, enabled ? 1 : 0);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
  app.put('/api/wa-agenda/:id', gate, (req, res) => {
    try {
      const { dias, hora, enabled } = req.body || {};
      const a = db.prepare("SELECT id FROM wa_agenda WHERE id = ?").get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'nao encontrada' });
      if (Array.isArray(dias)) db.prepare("UPDATE wa_agenda SET dias = ? WHERE id = ?").run(JSON.stringify(dias), a.id);
      if (/^\d{2}:\d{2}$/.test(hora || '')) db.prepare("UPDATE wa_agenda SET hora = ? WHERE id = ?").run(hora, a.id);
      if (typeof enabled === 'boolean') db.prepare("UPDATE wa_agenda SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, a.id);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
  app.delete('/api/wa-agenda/:id', gate, (req, res) => {
    try { db.prepare("DELETE FROM wa_agenda WHERE id = ?").run(req.params.id); res.json({ success: true }); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/wa-campanhas', gate, (req, res) => {
    try {
      migrar(db);
      const { nome, config } = req.body || {};
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatorio' });
      const cfg = typeof config === 'object' && config ? JSON.stringify(config) : '{}';
      const r = db.prepare('INSERT INTO wa_campanhas (nome, config) VALUES (?, ?)').run(nome, cfg);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.get('/api/wa-campanhas/:id', gate, (req, res) => {
    try {
      migrar(db);
      const c = db.prepare('SELECT * FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      const counts = {};
      for (const r of db.prepare("SELECT status, COUNT(*) AS n FROM wa_campanha_dest WHERE campanha_id = ? GROUP BY status").all(c.id)) counts[r.status] = r.n;
      const totalDest = db.prepare('SELECT COUNT(*) AS n FROM wa_campanha_dest WHERE campanha_id = ?').get(c.id).n;
      const amostra = db.prepare('SELECT telefone, nome FROM wa_campanha_dest WHERE campanha_id = ? LIMIT 5').all(c.id);
      const rodando = running.has((req.tenantCtx && req.tenantCtx.slug) + ':' + c.id);
      res.json({ success: true, campanha: c, config: JSON.parse(c.config || '{}'), totalDest, counts, amostra, rodando });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/wa-campanhas/:id', gate, (req, res) => {
    try {
      const { nome, config } = req.body || {};
      const c = db.prepare('SELECT id FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      if (nome) db.prepare('UPDATE wa_campanhas SET nome = ? WHERE id = ?').run(nome, c.id);
      if (config && typeof config === 'object') db.prepare('UPDATE wa_campanhas SET config = ? WHERE id = ?').run(JSON.stringify(config), c.id);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/wa-campanhas/:id', gate, (req, res) => {
    try {
      db.prepare('DELETE FROM wa_campanha_dest WHERE campanha_id = ?').run(req.params.id);
      db.prepare('DELETE FROM wa_campanhas WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/wa-campanhas/:id/csv', gate, (req, res) => {
    try {
      migrar(db);
      const c = db.prepare('SELECT id FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      const rows = parseCSV(req.body && req.body.csv);
      const trx = db.transaction(() => {
        db.prepare('DELETE FROM wa_campanha_dest WHERE campanha_id = ?').run(c.id);
        const ins = db.prepare('INSERT INTO wa_campanha_dest (campanha_id, telefone, nome, extras) VALUES (?, ?, ?, ?)');
        let n = 0;
        for (const row of rows) {
          const tel = String(pickTel(row)).replace(/\D/g, '');
          if (!tel) continue;
          const extras = {};
          for (const [k, v] of Object.entries(row)) {
            if (!['telefone', 'phone', 'fone', 'celular', 'whatsapp', 'nome', 'name', 'cliente'].includes(k) && v) extras[k] = v;
          }
          ins.run(c.id, tel, pickNome(row), JSON.stringify(extras));
          n++;
        }
        return n;
      });
      res.json({ success: true, total: trx() });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // DRY-RUN: gera a M1 para os primeiros N destinatários. NÃO envia.
  app.post('/api/wa-campanhas/:id/dry-run', gate, async (req, res) => {
    try {
      migrar(db);
      const c = db.prepare('SELECT * FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      const config = JSON.parse(c.config || '{}');
      const limit = Math.min(parseInt(req.body && req.body.limit, 10) || 5, 20);
      const dests = db.prepare('SELECT * FROM wa_campanha_dest WHERE campanha_id = ? LIMIT ?').all(c.id, limit);
      if (!dests.length) return res.json({ success: true, results: [], aviso: 'sem destinatarios (suba um CSV)' });
      const keys = require('./config-helpers').createConfigHelpers(db).getIAKeys();
      if (!keys) return res.json({ success: false, error: 'tenant sem chave de IA configurada' });
      const { chamarChatLLM } = require('./chat-ia');
      const callLLM = async (m) => { try { const r = await chamarChatLLM(m, keys); return { ok: true, text: r.content }; } catch (e) { return { ok: false, err: e.message }; } };
      const results = [];
      for (const d of dests) {
        const row = Object.assign({ nome: d.nome }, JSON.parse(d.extras || '{}'));
        const gen = await gerarM1({ config, row, callLLM });
        results.push({ telefone: d.telefone, nome: d.nome, ok: gen.ok, texto: gen.ok ? ensureOptOutTrailer(gen.text) : null, erros: gen.erros || null, tentativas: gen.tentativas, ramoKey: gen.ramoKey, dor: gen.dor });
      }
      res.json({ success: true, results });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== Imagens da campanha (pool sorteado a cada envio; legenda = M1) =====
  app.get('/api/wa-campanhas/:id/images', gate, (req, res) => {
    try {
      res.json({ success: true, images: listCampImages(req.tenantCtx && req.tenantCtx.slug, req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.post('/api/wa-campanhas/:id/images', gate, (req, res) => {
    try {
      const { filename, base64 } = req.body || {};
      if (!filename || !base64) return res.status(400).json({ success: false, error: 'precisa filename + base64' });
      if (!/^[\w.\- ]+\.(jpe?g|png|webp)$/i.test(filename)) return res.status(400).json({ success: false, error: 'nome de arquivo invalido' });
      const dir = campImagesDir(req.tenantCtx && req.tenantCtx.slug, req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      let b64 = base64; if (b64.startsWith('data:')) b64 = b64.split(',', 2)[1];
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ success: false, error: 'imagem >20MB' });
      fs.writeFileSync(path.join(dir, path.basename(filename)), buf);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
  app.get('/api/wa-campanhas/:id/images/:file', gate, (req, res) => {
    const full = path.join(campImagesDir(req.tenantCtx && req.tenantCtx.slug, req.params.id), path.basename(req.params.file));
    if (!fs.existsSync(full)) return res.status(404).end();
    res.sendFile(full);
  });
  app.delete('/api/wa-campanhas/:id/images/:file', gate, (req, res) => {
    try {
      const full = path.join(campImagesDir(req.tenantCtx && req.tenantCtx.slug, req.params.id), path.basename(req.params.file));
      if (fs.existsSync(full)) fs.unlinkSync(full);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== Destinatários (lista / já enviados) =====
  app.get('/api/wa-campanhas/:id/dest', gate, (req, res) => {
    try {
      migrar(db);
      const status = req.query.status;
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const offset = parseInt(req.query.offset, 10) || 0;
      let sql = "SELECT id, telefone, nome, status, enviado_em, erro FROM wa_campanha_dest WHERE campanha_id = ?";
      const args = [req.params.id];
      if (status) { sql += " AND status = ?"; args.push(status); }
      sql += " ORDER BY (enviado_em IS NULL), enviado_em DESC, id DESC LIMIT ? OFFSET ?";
      args.push(limit, offset);
      res.json({ success: true, dest: db.prepare(sql).all(...args) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== Log do disparo =====
  app.get('/api/wa-campanhas/:id/log', gate, (req, res) => {
    try {
      migrar(db);
      res.json({ success: true, log: db.prepare("SELECT ts, msg FROM wa_campanha_log WHERE campanha_id = ? ORDER BY id DESC LIMIT 300").all(req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // SIMULAR M1: gera a M1 para um contato avulso (sem enviar). Reusa o motor do dry-run.
  app.post('/api/wa-campanhas/:id/sim-m1', gate, async (req, res) => {
    try {
      const c = db.prepare('SELECT config FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      const config = JSON.parse(c.config || '{}');
      const contact = (req.body && req.body.contact) || {};
      const keys = require('./config-helpers').createConfigHelpers(db).getIAKeys();
      if (!keys) return res.json({ success: false, error: 'tenant sem chave de IA configurada' });
      const { chamarChatLLM } = require('./chat-ia');
      const callLLM = async (m) => { try { const r = await chamarChatLLM(m, keys); return { ok: true, text: r.content }; } catch (e) { return { ok: false, err: e.message }; } };
      const gen = await gerarM1({ config, row: contact, callLLM });
      if (!gen.ok) return res.json({ success: false, error: 'M1 reprovada em ' + gen.tentativas + ' tentativa(s): ' + (gen.erros || []).join('; ') });
      res.json({ success: true, reply: ensureOptOutTrailer(gen.text) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // SIMULAR resposta ao lead: aplica o fluxo fixo de lead da campanha (sem enviar).
  app.post('/api/wa-campanhas/:id/sim-lead', gate, (req, res) => {
    try {
      const c = db.prepare('SELECT config FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      const texto = (req.body && req.body.texto) || '';
      if (!texto.trim()) return res.status(400).json({ success: false, error: 'texto obrigatorio' });
      const { buildLeadReply } = require('./whatsapp-webhook');
      res.json({ success: true, reply: buildLeadReply(JSON.parse(c.config || '{}'), texto) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ENVIO REAL: dispara o runner em background (usa o db REAL do tenant, req.tenantDb).
  app.post('/api/wa-campanhas/:id/run', gate, (req, res) => {
    try {
      migrar(db);
      const slug = req.tenantCtx && req.tenantCtx.slug;
      const tdb = req.tenantDb; // db REAL (não o proxy) — sobrevive fora do request
      if (!slug || !tdb) return res.status(400).json({ success: false, error: 'tenant nao resolvido' });
      const c = db.prepare('SELECT id FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      if (running.has(slug + ':' + c.id)) return res.status(409).json({ success: false, error: 'ja esta rodando' });
      const cfg = loadProviderConfig(tdb);
      if (!cfg || cfg.provider !== 'evolution' || !cfg.instance) {
        return res.status(400).json({ success: false, error: 'conecte o WhatsApp deste tenant primeiro' });
      }
      runCampaign(tdb, slug, c.id).catch(e => console.error('[wa-camp run]', e.message));
      res.json({ success: true, started: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/wa-campanhas/:id/cancel', gate, (req, res) => {
    try {
      const slug = req.tenantCtx && req.tenantCtx.slug;
      const ctl = running.get(slug + ':' + req.params.id);
      if (ctl) ctl.cancelled = true;
      res.json({ success: true, cancelado: !!ctl });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Agenda o disparo (o scheduler no worker dispara quando chega a hora).
  app.post('/api/wa-campanhas/:id/agendar', gate, (req, res) => {
    try {
      const quando = req.body && req.body.quando;
      if (!quando || isNaN(Date.parse(quando))) return res.status(400).json({ success: false, error: 'data invalida' });
      const c = db.prepare('SELECT config FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      const cfg = JSON.parse(c.config || '{}');
      cfg.agendadaPara = new Date(quando).toISOString();
      db.prepare("UPDATE wa_campanhas SET config = ?, status = 'agendada' WHERE id = ?").run(JSON.stringify(cfg), req.params.id);
      res.json({ success: true, agendadaPara: cfg.agendadaPara });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
  app.post('/api/wa-campanhas/:id/desagendar', gate, (req, res) => {
    try {
      const c = db.prepare('SELECT config FROM wa_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'nao encontrada' });
      const cfg = JSON.parse(c.config || '{}');
      delete cfg.agendadaPara;
      db.prepare("UPDATE wa_campanhas SET config = ?, status = 'rascunho' WHERE id = ?").run(JSON.stringify(cfg), req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasWaCampanhas, runCampaign };
