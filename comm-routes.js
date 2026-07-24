/**
 * comm-routes.js — Comunicação em massa (templates, listas, campanhas).
 *
 * Modelo:
 *   comm_templates    — template de mensagem (canal email|whatsapp, com placeholders)
 *   comm_listas       — listas de destinatários
 *   comm_lista_membros — pessoas em cada lista
 *   comm_campanhas    — uma execução de template em uma lista
 *   comm_envios       — uma linha por destinatário (status individual)
 *
 * Placeholders suportados: {{razaoSocial}} {{primeiroNome}} {{cpfCnpj}} {{email}} {{telefone}}
 *
 * Execução: o endpoint /executar renderiza a mensagem por destinatário e marca como
 * 'simulado' (status='enviado-simulado'). Provider real pode ser plugado num worker
 * que processa registros 'pendente' depois.
 */

const { logAction } = require('./audit-log');
const { enviarWhatsApp, loadProviderConfig } = require('./whatsapp-adapter');
const { localDate } = require('./wa-m1-utils');

// Campanhas WhatsApp do comm em execução neste processo: key `comm:${slug}:${id}`.
const running = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Runner de envio REAL do canal WhatsApp (roda fora do request; db REAL do tenant).
async function runCommWhatsApp(tdb, slug, campId) {
  const key = 'comm:' + slug + ':' + campId;
  if (running.has(key)) return;
  const ctl = { cancelled: false };
  running.set(key, ctl);
  try {
    try { tdb.exec("ALTER TABLE comm_envios ADD COLUMN dia TEXT"); } catch (_) {}
    tdb.exec("CREATE TABLE IF NOT EXISTS wa_optout (telefone TEXT PRIMARY KEY, criado_em TEXT DEFAULT CURRENT_TIMESTAMP)");
    const gv = (c) => { try { const r = tdb.prepare("SELECT valor FROM config WHERE chave = ?").get(c); return r ? r.valor : null; } catch (_) { return null; } };
    const dailyLimit = parseInt(gv('whatsapp_daily_limit'), 10) || 30;
    const minSec = parseInt(gv('whatsapp_throttle_min'), 10) || 45;
    const maxSec = parseInt(gv('whatsapp_throttle_max'), 10) || 120;

    while (!ctl.cancelled) {
      const hoje = localDate(Date.now(), 'America/Belem');
      const enviadosHoje = tdb.prepare("SELECT COUNT(*) AS n FROM comm_envios WHERE status = 'enviado' AND dia = ?").get(hoje).n;
      if (enviadosHoje >= dailyLimit) break;
      const e = tdb.prepare(`
        SELECT * FROM comm_envios
        WHERE campanhaId = ? AND status = 'pendente' AND destino IS NOT NULL
          AND destino NOT IN (SELECT telefone FROM wa_optout)
        LIMIT 1
      `).get(campId);
      if (!e) break;
      const r = await enviarWhatsApp(tdb, { telefone: e.destino, texto: e.mensagemRenderizada });
      if (r && r.queued) break; // sem provider conectado
      if (r && r.success) tdb.prepare("UPDATE comm_envios SET status = 'enviado', dataEnvio = ?, dia = ? WHERE id = ?").run(new Date().toISOString(), hoje, e.id);
      else tdb.prepare("UPDATE comm_envios SET status = 'falha', erro = ? WHERE id = ?").run((r && r.error) || 'falha', e.id);
      const tot = tdb.prepare("SELECT SUM(CASE WHEN status='enviado' THEN 1 ELSE 0 END) AS env, SUM(CASE WHEN status='falha' THEN 1 ELSE 0 END) AS fal FROM comm_envios WHERE campanhaId = ?").get(campId);
      tdb.prepare("UPDATE comm_campanhas SET totalEnviados = ?, totalFalhas = ? WHERE id = ?").run(tot.env || 0, tot.fal || 0, campId);
      if (ctl.cancelled) break;
      await sleep(Math.round((minSec + Math.random() * Math.max(0, maxSec - minSec)) * 1000));
    }
    const restam = tdb.prepare("SELECT COUNT(*) AS n FROM comm_envios WHERE campanhaId = ? AND status = 'pendente'").get(campId).n;
    tdb.prepare("UPDATE comm_campanhas SET status = ? WHERE id = ?").run(ctl.cancelled ? 'cancelada' : (restam > 0 ? 'pausada' : 'enviada'), campId);
  } catch (e) {
    console.error('[comm-wa ' + key + ']', e.message);
  } finally {
    running.delete(key);
  }
}

// Prepara envios (se ainda não existem) e dispara o runner WhatsApp. Usado pelo
// /executar (HTTP) e pelo scheduler. Recebe o db REAL do tenant (tdb).
function dispararCommWhatsApp(tdb, slug, campId) {
  const camp = tdb.prepare("SELECT c.*, t.canal, t.corpo FROM comm_campanhas c JOIN comm_templates t ON t.id = c.templateId WHERE c.id = ?").get(campId);
  if (!camp || camp.canal !== 'whatsapp') return false;
  if (running.has('comm:' + slug + ':' + campId)) return false;
  const jaTem = tdb.prepare("SELECT COUNT(*) AS n FROM comm_envios WHERE campanhaId = ?").get(campId).n;
  if (!jaTem) {
    const membros = tdb.prepare("SELECT p.* FROM comm_lista_membros m JOIN pessoas p ON p.id = m.pessoaId WHERE m.listaId = ?").all(camp.listaId);
    const trxWa = tdb.transaction(() => {
      const stmt = tdb.prepare("INSERT INTO comm_envios (campanhaId, pessoaId, canal, destino, mensagemRenderizada, assuntoRenderizado, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const p of membros) {
        const dest = destinoPara('whatsapp', p);
        stmt.run(campId, p.id, 'whatsapp', dest ? String(dest).replace(/\D/g, '') : null, renderizar(camp.corpo, p), null, dest ? 'pendente' : 'falha');
      }
      tdb.prepare("UPDATE comm_campanhas SET totalDestinatarios = ? WHERE id = ?").run(membros.length, campId);
    });
    trxWa();
  }
  tdb.prepare("UPDATE comm_campanhas SET status = 'enviando', dataEnvio = CURRENT_TIMESTAMP WHERE id = ?").run(campId);
  runCommWhatsApp(tdb, slug, campId).catch(e => console.error('[comm-wa]', e.message));
  return true;
}

const CANAIS = ['email', 'whatsapp'];
const STATUS_CAMP = ['rascunho', 'agendada', 'enviando', 'enviada', 'cancelada'];

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comm_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      canal TEXT NOT NULL,
      assunto TEXT,
      corpo TEXT NOT NULL,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_tpl_canal ON comm_templates(canal, ativo);

    CREATE TABLE IF NOT EXISTS comm_listas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      descricao TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comm_lista_membros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listaId INTEGER NOT NULL,
      pessoaId INTEGER NOT NULL,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (listaId) REFERENCES comm_listas(id) ON DELETE CASCADE,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id),
      UNIQUE(listaId, pessoaId)
    );
    CREATE INDEX IF NOT EXISTS idx_membros_lista ON comm_lista_membros(listaId);

    CREATE TABLE IF NOT EXISTS comm_campanhas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      templateId INTEGER NOT NULL,
      listaId INTEGER NOT NULL,
      canal TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'rascunho',
      agendadaPara TEXT,
      dataEnvio TEXT,
      totalDestinatarios INTEGER DEFAULT 0,
      totalEnviados INTEGER DEFAULT 0,
      totalFalhas INTEGER DEFAULT 0,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (templateId) REFERENCES comm_templates(id),
      FOREIGN KEY (listaId) REFERENCES comm_listas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_camp_status ON comm_campanhas(status, agendadaPara);

    CREATE TABLE IF NOT EXISTS comm_envios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campanhaId INTEGER NOT NULL,
      pessoaId INTEGER NOT NULL,
      canal TEXT NOT NULL,
      destino TEXT,
      mensagemRenderizada TEXT,
      assuntoRenderizado TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      dataEnvio TEXT,
      erro TEXT,
      FOREIGN KEY (campanhaId) REFERENCES comm_campanhas(id) ON DELETE CASCADE,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_env_campanha ON comm_envios(campanhaId, status);
  `);
}

function renderizar(texto, pessoa) {
  if (!texto) return '';
  const primeiroNome = (pessoa.razaoSocial || '').trim().split(/\s+/)[0] || '';
  const vars = {
    razaoSocial: pessoa.razaoSocial || '',
    nomeFantasia: pessoa.nomeFantasia || pessoa.razaoSocial || '',
    primeiroNome,
    cpfCnpj: pessoa.cpfCnpj || '',
    email: pessoa.email || '',
    telefone: pessoa.telefone || ''
  };
  return texto.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] != null ? vars[k] : `{{${k}}}`);
}

function destinoPara(canal, pessoa) {
  if (canal === 'email')    return pessoa.email || null;
  if (canal === 'whatsapp') return pessoa.telefone || null;
  return null;
}

function registrarRotasComm(app, db) {
  migrarDB(db);

  // ==================== TEMPLATES ====================

  app.get('/api/comm/templates', (req, res) => {
    try {
      const lista = db.prepare('SELECT * FROM comm_templates WHERE ativo = 1 ORDER BY canal, nome').all();
      res.json({ success: true, templates: lista, canais: CANAIS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/templates', (req, res) => {
    try {
      const { nome, canal, assunto, corpo } = req.body;
      if (!nome || !canal || !corpo) return res.status(400).json({ success: false, error: 'nome, canal e corpo obrigatórios' });
      if (!CANAIS.includes(canal)) return res.status(400).json({ success: false, error: 'canal inválido' });
      const r = db.prepare('INSERT INTO comm_templates (nome, canal, assunto, corpo) VALUES (?, ?, ?, ?)').run(nome, canal, assunto || null, corpo);
      logAction(db, req, 'criar', 'comm-template', r.lastInsertRowid, { nome, canal });
      res.json({ success: true, template: db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/comm/templates/:id', (req, res) => {
    try {
      const camposValidos = ['nome','canal','assunto','corpo','ativo'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) {
          if (c === 'canal' && !CANAIS.includes(req.body[c])) return res.status(400).json({ success: false, error: 'canal inválido' });
          sets.push(`${c} = ?`);
          vals.push(c === 'ativo' ? (req.body[c] ? 1 : 0) : req.body[c]);
        }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE comm_templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'comm-template', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/templates/:id', (req, res) => {
    try {
      db.prepare('UPDATE comm_templates SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'comm-template', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== LISTAS ====================

  app.get('/api/comm/listas', (req, res) => {
    try {
      const listas = db.prepare(`
        SELECT l.*,
          (SELECT COUNT(*) FROM comm_lista_membros m WHERE m.listaId = l.id) AS qtdMembros
        FROM comm_listas l
        WHERE l.ativo = 1
        ORDER BY l.nome
      `).all();
      res.json({ success: true, listas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/comm/listas/:id', (req, res) => {
    try {
      const lista = db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(req.params.id);
      if (!lista) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
      const membros = db.prepare(`
        SELECT m.id, m.pessoaId, p.razaoSocial, p.cpfCnpj, p.email, p.telefone
        FROM comm_lista_membros m
        JOIN pessoas p ON p.id = m.pessoaId
        WHERE m.listaId = ?
        ORDER BY p.razaoSocial
      `).all(lista.id);
      res.json({ success: true, lista, membros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/listas', (req, res) => {
    try {
      const { nome, descricao } = req.body;
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare('INSERT INTO comm_listas (nome, descricao) VALUES (?, ?)').run(nome, descricao || null);
      logAction(db, req, 'criar', 'comm-lista', r.lastInsertRowid, { nome });
      res.json({ success: true, lista: db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/comm/listas/:id', (req, res) => {
    try {
      const { nome, descricao, ativo } = req.body;
      const sets = [], vals = [];
      if (nome !== undefined)      { sets.push('nome = ?');      vals.push(nome); }
      if (descricao !== undefined) { sets.push('descricao = ?'); vals.push(descricao); }
      if (ativo !== undefined)     { sets.push('ativo = ?');     vals.push(ativo ? 1 : 0); }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE comm_listas SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'comm-lista', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/listas/:id', (req, res) => {
    try {
      db.prepare('UPDATE comm_listas SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'comm-lista', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Adicionar membros (lote)
  app.post('/api/comm/listas/:id/membros', (req, res) => {
    try {
      const { pessoaIds } = req.body;
      if (!Array.isArray(pessoaIds) || !pessoaIds.length) return res.status(400).json({ success: false, error: 'pessoaIds obrigatórios' });
      const stmt = db.prepare('INSERT OR IGNORE INTO comm_lista_membros (listaId, pessoaId) VALUES (?, ?)');
      let adic = 0;
      const trx = db.transaction(() => {
        for (const pid of pessoaIds) { const r = stmt.run(req.params.id, pid); if (r.changes) adic++; }
      });
      trx();
      logAction(db, req, 'add-membros', 'comm-lista', req.params.id, { quantidade: adic });
      res.json({ success: true, adicionados: adic });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/listas/membros/:id', (req, res) => {
    try {
      db.prepare('DELETE FROM comm_lista_membros WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CAMPANHAS ====================

  app.get('/api/comm/campanhas', (req, res) => {
    try {
      const lista = db.prepare(`
        SELECT c.*, t.nome AS templateNome, t.canal AS templateCanal, l.nome AS listaNome
        FROM comm_campanhas c
        JOIN comm_templates t ON t.id = c.templateId
        JOIN comm_listas l ON l.id = c.listaId
        ORDER BY c.id DESC LIMIT 200
      `).all();
      res.json({ success: true, campanhas: lista, status: STATUS_CAMP });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/comm/campanhas/:id', (req, res) => {
    try {
      const camp = db.prepare(`
        SELECT c.*, t.nome AS templateNome, t.canal AS templateCanal, t.assunto, t.corpo,
               l.nome AS listaNome
        FROM comm_campanhas c
        JOIN comm_templates t ON t.id = c.templateId
        JOIN comm_listas l ON l.id = c.listaId
        WHERE c.id = ?
      `).get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      const envios = db.prepare(`
        SELECT e.*, p.razaoSocial
        FROM comm_envios e JOIN pessoas p ON p.id = e.pessoaId
        WHERE e.campanhaId = ? ORDER BY e.id DESC LIMIT 1000
      `).all(camp.id);
      const rodando = running.has('comm:' + (req.tenantCtx && req.tenantCtx.slug) + ':' + camp.id);
      res.json({ success: true, campanha: camp, envios, rodando });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/campanhas', (req, res) => {
    try {
      const { nome, templateId, listaId, agendadaPara, observacoes } = req.body;
      if (!nome || !templateId || !listaId) return res.status(400).json({ success: false, error: 'nome, templateId e listaId obrigatórios' });
      const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(templateId);
      if (!t) return res.status(404).json({ success: false, error: 'Template não encontrado' });
      const l = db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(listaId);
      if (!l) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
      const totalDest = db.prepare('SELECT COUNT(*) AS n FROM comm_lista_membros WHERE listaId = ?').get(listaId).n;
      const r = db.prepare(`
        INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status, agendadaPara, totalDestinatarios, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nome, templateId, listaId, t.canal, agendadaPara ? 'agendada' : 'rascunho', agendadaPara || null, totalDest, observacoes || null);
      logAction(db, req, 'criar', 'comm-campanha', r.lastInsertRowid, { nome, totalDest });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Executar agora (modo simulado: marca cada envio como 'simulado').
  // Provider real pode ser plugado depois — basta processar envios 'pendente'.
  app.post('/api/comm/campanhas/:id/executar', (req, res) => {
    try {
      const camp = db.prepare(`
        SELECT c.*, t.canal, t.assunto, t.corpo
        FROM comm_campanhas c JOIN comm_templates t ON t.id = c.templateId
        WHERE c.id = ?
      `).get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['rascunho','agendada','pausada'].includes(camp.status)) {
        return res.status(400).json({ success: false, error: `Campanha em status '${camp.status}' não pode ser executada` });
      }

      const membros = db.prepare(`
        SELECT p.* FROM comm_lista_membros m
        JOIN pessoas p ON p.id = m.pessoaId
        WHERE m.listaId = ?
      `).all(camp.listaId);

      // Canal WhatsApp: envio REAL em background (throttle/limite-dia/opt-out).
      // Email segue o caminho simulado abaixo (inalterado).
      if (camp.canal === 'whatsapp') {
        const cfg = loadProviderConfig(db);
        if (!cfg || cfg.provider !== 'evolution' || !cfg.instance) {
          return res.status(400).json({ success: false, error: 'Conecte o WhatsApp deste tenant antes de enviar' });
        }
        const slug = req.tenantCtx && req.tenantCtx.slug;
        const tdb = req.tenantDb;
        if (!slug || !tdb) return res.status(400).json({ success: false, error: 'tenant não resolvido' });
        if (running.has('comm:' + slug + ':' + camp.id)) return res.status(409).json({ success: false, error: 'já está enviando' });
        dispararCommWhatsApp(tdb, slug, camp.id);
        logAction(db, req, 'executar', 'comm-campanha', camp.id, { canal: 'whatsapp' });
        return res.json({ success: true, started: true, canal: 'whatsapp' });
      }

      const trx = db.transaction(() => {
        db.prepare(`UPDATE comm_campanhas SET status = 'enviando', dataEnvio = CURRENT_TIMESTAMP WHERE id = ?`).run(camp.id);
        const stmt = db.prepare(`
          INSERT INTO comm_envios (campanhaId, pessoaId, canal, destino, mensagemRenderizada, assuntoRenderizado, status, dataEnvio, erro)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        let env = 0, fal = 0;
        for (const p of membros) {
          const dest = destinoPara(camp.canal, p);
          const mensagem = renderizar(camp.corpo, p);
          const assunto  = renderizar(camp.assunto, p);
          if (!dest) {
            stmt.run(camp.id, p.id, camp.canal, null, mensagem, assunto, 'falha', null, `Sem ${camp.canal === 'email' ? 'e-mail' : 'telefone'} cadastrado`);
            fal++;
          } else {
            // SIMULADO — provider real plugaria aqui (envio, captura erro, atualiza status)
            stmt.run(camp.id, p.id, camp.canal, dest, mensagem, assunto, 'enviado-simulado', new Date().toISOString(), null);
            env++;
          }
        }
        db.prepare(`
          UPDATE comm_campanhas
             SET status = 'enviada', totalEnviados = ?, totalFalhas = ?, totalDestinatarios = ?
           WHERE id = ?
        `).run(env, fal, membros.length, camp.id);
        return { env, fal };
      });
      const result = trx();
      logAction(db, req, 'executar', 'comm-campanha', camp.id, { enviados: result.env, falhas: result.fal });
      res.json({ success: true, enviados: result.env, falhas: result.fal });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/campanhas/:id/cancelar', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['enviada','cancelada'].includes(camp.status)) return res.status(400).json({ success: false, error: 'Estado não permite cancelar' });
      const ctl = running.get('comm:' + (req.tenantCtx && req.tenantCtx.slug) + ':' + camp.id);
      if (ctl) ctl.cancelled = true; // sinaliza o runner (whatsapp)
      db.prepare(`UPDATE comm_campanhas SET status = 'cancelada' WHERE id = ?`).run(camp.id);
      logAction(db, req, 'cancelar', 'comm-campanha', camp.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Pré-visualização (renderiza para um destinatário)
  app.post('/api/comm/preview', (req, res) => {
    try {
      const { templateId, pessoaId } = req.body;
      const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(templateId);
      if (!t) return res.status(404).json({ success: false, error: 'Template não encontrado' });
      const p = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(pessoaId);
      if (!p) return res.status(404).json({ success: false, error: 'Pessoa não encontrada' });
      res.json({
        success: true,
        canal: t.canal,
        assunto: renderizar(t.assunto, p),
        corpo: renderizar(t.corpo, p),
        destino: destinoPara(t.canal, p)
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasComm, runCommWhatsApp, dispararCommWhatsApp };
