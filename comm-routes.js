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
 * Elegibilidade e opt-out ficam em comm-destinos.js: destino é normalizado,
 * validado, deduplicado e checado contra o descadastro ANTES de virar envio.
 *
 * E-mail sai de verdade quando há SMTP configurado. Sem SMTP a campanha fica em
 * 'simulada' e NÃO se declara enviada — antes ela marcava 'enviada' com N
 * 'enviados' para mensagens que nunca saíram do servidor.
 */

const { logAction } = require('./audit-log');
const { enviarWhatsApp, loadProviderConfig, enviarWhatsAppMidia } = require('./whatsapp-adapter');
const { localDate } = require('./wa-m1-utils');
const dest = require('./comm-destinos');
const multer = require('multer');
const uploadImagem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const { loadSmtpConfig, enviarEmailSimples } = require('./email-client');

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
    let imagemDoTemplate = null;
    try {
      const t = tdb.prepare(`SELECT t.imagemPath FROM comm_campanhas c
        JOIN comm_templates t ON t.id = c.templateId WHERE c.id = ?`).get(campId);
      if (t?.imagemPath) {
        const p = require('path'), fs = require('fs');
        const rel = String(t.imagemPath).replace(/^\//, '');
        // Caminho novo (data/tenants/<slug>/comm-imagens) e o antigo em public/,
        // para não quebrar modelo salvo antes desta mudança.
        for (const c of [p.join(__dirname, 'data', 'tenants', slug, rel), p.join(__dirname, 'public', rel)]) {
          if (fs.existsSync(c)) { imagemDoTemplate = c; break; }
        }
      }
    } catch (_) { /* instalação sem a coluna */ }

    while (!ctl.cancelled) {
      const hoje = localDate(Date.now(), 'America/Belem');
      const enviadosHoje = tdb.prepare("SELECT COUNT(*) AS n FROM comm_envios WHERE status = 'enviado' AND dia = ?").get(hoje).n;
      if (enviadosHoje >= dailyLimit) break;
      const e = tdb.prepare(`
        SELECT * FROM comm_envios
        WHERE campanhaId = ? AND status = 'pendente' AND destino IS NOT NULL
          AND destino NOT IN (SELECT destino FROM comm_optout WHERE canal = 'whatsapp')
        LIMIT 1
      `).get(campId);
      if (!e) break;
      // Template com imagem manda a mensagem como legenda dela — mesmo
      // comportamento das campanhas legado, que já faziam isso.
      const r = imagemDoTemplate
        ? await enviarWhatsAppMidia(tdb, { telefone: e.destino, texto: e.mensagemRenderizada, imagePath: imagemDoTemplate })
        : await enviarWhatsApp(tdb, { telefone: e.destino, texto: e.mensagemRenderizada });
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
    // Opt-out, destino inválido e repetido saem ANTES de virar envio: gravá-los
    // como 'pendente' e filtrar depois inflava o total de destinatários e fazia
    // a campanha prometer um alcance que não existia.
    const prep = dest.prepararDestinatarios(tdb, { listaId: camp.listaId, canal: 'whatsapp', tipo: camp.tipo });
    const trxWa = tdb.transaction(() => {
      const stmt = tdb.prepare(`INSERT INTO comm_envios
        (campanhaId, pessoaId, canal, destino, mensagemRenderizada, assuntoRenderizado, status, motivoDescartado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of prep.enviar) {
        stmt.run(campId, d.pessoa.id, 'whatsapp', d.destino, renderizar(camp.corpo, d.pessoa), null, 'pendente', null);
      }
      for (const d of prep.descartados) {
        stmt.run(campId, d.pessoaId, 'whatsapp', d.destino || null, null, null, 'descartado', d.motivo);
      }
      tdb.prepare('UPDATE comm_campanhas SET totalDestinatarios = ?, totalDescartados = ? WHERE id = ?')
        .run(prep.enviar.length, prep.descartados.length, campId);
    });
    trxWa();
  }
  tdb.prepare("UPDATE comm_campanhas SET status = 'enviando', dataEnvio = CURRENT_TIMESTAMP WHERE id = ?").run(campId);
  runCommWhatsApp(tdb, slug, campId).catch(e => console.error('[comm-wa]', e.message));
  return true;
}

const CANAIS = ['email', 'whatsapp'];
const STATUS_CAMP = ['rascunho', 'agendada', 'enviando', 'enviada', 'cancelada', 'pausada'];

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
  const alterSafe = (sql) => {
    try { db.exec(sql); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  };
  // Imagem do modelo: a mensagem vira legenda dela no WhatsApp.
  alterSafe('ALTER TABLE comm_templates ADD COLUMN imagemPath TEXT');
  // Contato avulso na lista: telefone digitado à mão, sem cadastro. Exige
  // pessoaId nulo, e a tabela nasceu com NOT NULL — daí a recriação, feita uma
  // única vez e preservando o que houver.
  alterSafe('ALTER TABLE comm_lista_membros ADD COLUMN destinoManual TEXT');
  alterSafe('ALTER TABLE comm_lista_membros ADD COLUMN nomeManual TEXT');
  try {
    const col = db.prepare('PRAGMA table_info(comm_lista_membros)').all().find(c => c.name === 'pessoaId');
    if (col && col.notnull) {
      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        db.exec(`
          CREATE TABLE comm_lista_membros_novo (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listaId INTEGER NOT NULL,
            pessoaId INTEGER,
            destinoManual TEXT,
            nomeManual TEXT,
            dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (listaId) REFERENCES comm_listas(id) ON DELETE CASCADE,
            FOREIGN KEY (pessoaId) REFERENCES pessoas(id),
            UNIQUE(listaId, pessoaId),
            UNIQUE(listaId, destinoManual)
          );
          INSERT INTO comm_lista_membros_novo (id, listaId, pessoaId, destinoManual, nomeManual, dataCriacao)
            SELECT id, listaId, pessoaId, destinoManual, nomeManual, dataCriacao FROM comm_lista_membros;
          DROP TABLE comm_lista_membros;
          ALTER TABLE comm_lista_membros_novo RENAME TO comm_lista_membros;
          CREATE INDEX IF NOT EXISTS idx_membros_lista ON comm_lista_membros(listaId);
        `);
      })();
      db.exec('PRAGMA foreign_keys = ON');
    }
  } catch (e) { console.error('[comm] migração de membros avulsos:', e.message); }
}

// Renderização e resolução de destino moram em comm-destinos.js, junto da
// validação — separar levava a validar num lugar e enviar de outro.
const renderizar = dest.renderizar;
const destinoPara = (canal, pessoa) => dest.normalizarDestino(canal, dest.destinoBruto(canal, pessoa));

// Erro bloqueia; aviso vai junto na resposta. Assunto vazio não impede o
// envio, mas quem grava precisa saber que vai cair em spam.
function separar(problemas) {
  return {
    erros: problemas.filter((p) => p.nivel === 'erro'),
    avisos: problemas.filter((p) => p.nivel === 'aviso'),
  };
}

function registrarRotasComm(app, db) {
  migrarDB(db);
  dest.migrarDB(db);

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
      const { erros, avisos } = separar(dest.validarTemplate(req.body));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const r = db.prepare('INSERT INTO comm_templates (nome, canal, assunto, corpo) VALUES (?, ?, ?, ?)').run(nome, canal, assunto || null, corpo);
      logAction(db, req, 'criar', 'comm-template', r.lastInsertRowid, { nome, canal });
      res.json({ success: true, avisos, template: db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/comm/templates/:id', (req, res) => {
    try {
      const camposValidos = ['nome','canal','assunto','corpo','ativo'];

      const atual = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Template não encontrado' });

      // Valida o estado final: corrigir só o corpo ainda precisa resultar num
      // template que não mande "{{fone}}" literal para o cliente.
      const final = { ...atual, ...req.body };
      const { erros, avisos } = separar(dest.validarTemplate(final));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

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
      res.json({ success: true, avisos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Imagem do modelo. Mesma validação da foto de produto — assinatura do
   * arquivo, não a extensão — e mesma pasta pública, que o WhatsApp precisa
   * conseguir ler no envio.
   */
  app.post('/api/comm/templates/:id/imagem', uploadImagem.single('imagem'), (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Modelo não encontrado' });
      if (!req.file?.buffer) return res.status(400).json({ success: false, error: 'Envie o arquivo da imagem' });
      const imgs = require('./produto-imagens');
      const ext = imgs.tipoReal(req.file.buffer);
      if (!ext) return res.status(400).json({ success: false, error: 'O arquivo não é uma imagem JPEG, PNG, WEBP ou GIF' });
      // Fora de public/: o WhatsApp recebe a imagem em base64 lida do disco,
      // então ela não precisa — nem deve — ficar exposta na web.
      const fs = require('fs'), path = require('path');
      const slug = (req.tenantCtx && req.tenantCtx.slug) || 'default';
      const dir = path.join(__dirname, 'data', 'tenants', slug, 'comm-imagens');
      fs.mkdirSync(dir, { recursive: true });
      const nome = 'tpl-' + t.id + '-' + Date.now() + ext;
      fs.writeFileSync(path.join(dir, nome), req.file.buffer);
      const caminho = 'comm-imagens/' + nome;
      db.prepare('UPDATE comm_templates SET imagemPath = ? WHERE id = ?').run(caminho, t.id);
      res.json({ success: true, imagemPath: caminho });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comm/templates/:id/imagem', (req, res) => {
    try {
      db.prepare('UPDATE comm_templates SET imagemPath = NULL WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
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
      // Contatos digitados à mão: uma linha por telefone, com nome opcional.
      // "5594991234567" ou "5594991234567, Zé da Loja" ou "Zé da Loja; 94 99123-4567"
      const manuais = String(req.body?.manuais || '').split('\n')
        .map(l => l.trim()).filter(Boolean)
        .map(l => {
          const partes = l.split(/[;,]/).map(x => x.trim()).filter(Boolean);
          const comNumero = partes.find(x => (x.replace(/\D/g, '').length >= 10));
          const destino = dest.normalizarDestino('whatsapp', comNumero || l);
          const nome = partes.find(x => x !== comNumero) || null;
          return { linha: l, destino, nome };
        });
      const invalidos = manuais.filter(m => !m.destino).map(m => m.linha);
      const validos = manuais.filter(m => m.destino);

      if ((!Array.isArray(pessoaIds) || !pessoaIds.length) && !validos.length) {
        return res.status(400).json({ success: false,
          error: invalidos.length ? `Nenhum telefone válido. Recusados: ${invalidos.slice(0,3).join(', ')}`
                                  : 'Selecione clientes ou informe telefones' });
      }
      const stmt = db.prepare('INSERT OR IGNORE INTO comm_lista_membros (listaId, pessoaId) VALUES (?, ?)');
      const stmtManual = db.prepare('INSERT OR IGNORE INTO comm_lista_membros (listaId, destinoManual, nomeManual) VALUES (?, ?, ?)');
      let adic = 0, adicManual = 0;
      const trx = db.transaction(() => {
        for (const pid of (pessoaIds || [])) { const r = stmt.run(req.params.id, pid); if (r.changes) adic++; }
        for (const m of validos) { const r = stmtManual.run(req.params.id, m.destino, m.nome); if (r.changes) adicManual++; }
      });
      trx();
      logAction(db, req, 'add-membros', 'comm-lista', req.params.id, { quantidade: adic + adicManual });
      res.json({ success: true, adicionados: adic + adicManual, doCadastro: adic, manuais: adicManual,
                 recusados: invalidos });
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
      const tipo = req.body.tipo || 'marketing';
      if (!dest.TIPOS_CAMPANHA.includes(tipo)) {
        return res.status(400).json({ success: false,
          error: `tipo deve ser ${dest.TIPOS_CAMPANHA.join(' ou ')} — 'marketing' respeita o consentimento do cadastro` });
      }
      const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(templateId);
      if (!t) return res.status(404).json({ success: false, error: 'Template não encontrado' });
      const l = db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(listaId);
      if (!l) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
      const totalDest = db.prepare('SELECT COUNT(*) AS n FROM comm_lista_membros WHERE listaId = ?').get(listaId).n;
      const r = db.prepare(`
        INSERT INTO comm_campanhas (nome, templateId, listaId, canal, status, agendadaPara, totalDestinatarios, observacoes, tipo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nome, templateId, listaId, t.canal, agendadaPara ? 'agendada' : 'rascunho', agendadaPara || null, totalDest, observacoes || null, tipo);
      logAction(db, req, 'criar', 'comm-campanha', r.lastInsertRowid, { nome, totalDest });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Executar agora (modo simulado: marca cada envio como 'simulado').
  // Provider real pode ser plugado depois — basta processar envios 'pendente'.
  app.post('/api/comm/campanhas/:id/executar', async (req, res) => {
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

      // Janela de envio vale para todos os canais: mensagem às 3h da manhã
      // rende denúncia, não venda.
      const janela = dest.janelaPermitida(db);
      if (!janela.permitido && !req.body?.ignorarJanela) {
        return res.status(400).json({ success: false,
          error: `Envio ${janela.motivo}. Reenvie dentro da janela ou mande ignorarJanela para forçar.`,
          janela });
      }

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

      // Reexecutar não pode reenviar para quem já recebeu. Antes, uma campanha
      // 'pausada' executada de novo inseria a lista inteira outra vez — cada
      // pessoa recebendo em duplicado.
      const jaPreparada = db.prepare('SELECT COUNT(*) n FROM comm_envios WHERE campanhaId = ?').get(camp.id).n;
      if (!jaPreparada) {
        const prep = dest.prepararDestinatarios(db, { listaId: camp.listaId, canal: camp.canal, tipo: camp.tipo });
        const trxPrep = db.transaction(() => {
          const stmt = db.prepare(`INSERT INTO comm_envios
            (campanhaId, pessoaId, canal, destino, mensagemRenderizada, assuntoRenderizado, status, motivoDescartado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
          for (const d of prep.enviar) {
            stmt.run(camp.id, d.pessoa.id, camp.canal, d.destino,
              renderizar(camp.corpo, d.pessoa), renderizar(camp.assunto, d.pessoa), 'pendente', null);
          }
          for (const d of prep.descartados) {
            stmt.run(camp.id, d.pessoaId, camp.canal, d.destino || null, null, null, 'descartado', d.motivo);
          }
          db.prepare('UPDATE comm_campanhas SET totalDestinatarios = ?, totalDescartados = ? WHERE id = ?')
            .run(prep.enviar.length, prep.descartados.length, camp.id);
        });
        trxPrep();
      }

      db.prepare("UPDATE comm_campanhas SET status = 'enviando', dataEnvio = CURRENT_TIMESTAMP WHERE id = ?").run(camp.id);

      const pendentes = db.prepare(
        "SELECT * FROM comm_envios WHERE campanhaId = ? AND status = 'pendente' ORDER BY id").all(camp.id);
      const temSmtp = !!loadSmtpConfig(db);

      if (!temSmtp) {
        // Sem SMTP a mensagem não sai. Marcar 'enviada' com N enviados era a
        // tela afirmando um envio que nunca aconteceu.
        const trxSim = db.transaction(() => {
          const upd = db.prepare("UPDATE comm_envios SET status = 'simulado', dataEnvio = ? WHERE id = ?");
          for (const e of pendentes) upd.run(new Date().toISOString(), e.id);
          db.prepare("UPDATE comm_campanhas SET status = 'simulada', totalEnviados = 0 WHERE id = ?").run(camp.id);
        });
        trxSim();
        logAction(db, req, 'executar-simulado', 'comm-campanha', camp.id, { simulados: pendentes.length });
        return res.json({ success: true, simulacao: true, simulados: pendentes.length, enviados: 0,
          aviso: 'SMTP não configurado — nada foi enviado de verdade. '
               + 'Configure o e-mail em Configurações para disparar a campanha.' });
      }

      // Fora da transação: envio é I/O, e prender o banco por minutos travaria
      // o tenant inteiro.
      let env = 0;
      const erros = [];
      const marcarOk = db.prepare("UPDATE comm_envios SET status = 'enviado', dataEnvio = ?, dia = ? WHERE id = ?");
      const marcarFalha = db.prepare("UPDATE comm_envios SET status = 'falha', erro = ? WHERE id = ?");
      const hoje = new Date().toISOString().slice(0, 10);

      for (const e of pendentes) {
        let r;
        try {
          r = await enviarEmailSimples(db, {
            to: e.destino, assunto: e.assuntoRenderizado, texto: e.mensagemRenderizada,
            // Cabeçalho padrão que clientes de e-mail usam para o botão de
            // descadastro. Sem ele a denúncia de spam substitui o opt-out.
            headers: { 'List-Unsubscribe': `<mailto:${(loadSmtpConfig(db) || {}).user || ''}?subject=DESCADASTRAR>` },
          });
        } catch (err) { r = { success: false, error: err.message }; }

        if (r && r.success) { marcarOk.run(new Date().toISOString(), hoje, e.id); env++; }
        else { marcarFalha.run((r && r.error) || 'falha no envio', e.id); erros.push({ destino: e.destino, erro: r && r.error }); }
      }

      const tot = db.prepare(`SELECT
          SUM(CASE WHEN status='enviado' THEN 1 ELSE 0 END) AS env,
          SUM(CASE WHEN status='falha' THEN 1 ELSE 0 END) AS fal,
          SUM(CASE WHEN status='descartado' THEN 1 ELSE 0 END) AS desc,
          SUM(CASE WHEN status='pendente' THEN 1 ELSE 0 END) AS pend
        FROM comm_envios WHERE campanhaId = ?`).get(camp.id);
      db.prepare(`UPDATE comm_campanhas SET status = ?, totalEnviados = ?, totalFalhas = ?, totalDescartados = ?
        WHERE id = ?`).run(tot.pend > 0 ? 'pausada' : 'enviada', tot.env || 0, tot.fal || 0, tot.desc || 0, camp.id);

      logAction(db, req, 'executar', 'comm-campanha', camp.id, { enviados: env, falhas: erros.length });
      res.json({ success: true, enviados: env, falhas: erros.length,
        descartados: tot.desc || 0, erros: erros.slice(0, 20) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Edita a campanha enquanto ela ainda não saiu.
   *
   * Depois de enviada não se edita: o texto e o público daquele envio são o
   * registro do que o destinatário recebeu, e reescrevê-los apagaria a prova.
   * Trocar template ou lista recalcula o total de destinatários.
   */
  app.put('/api/comm/campanhas/:id', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      if (!['rascunho', 'agendada'].includes(camp.status)) {
        return res.status(400).json({ success: false,
          error: `Campanha ${camp.status} não pode ser editada — duplique para criar outra` });
      }
      const b = req.body || {};

      let templateId = camp.templateId, canal = camp.canal;
      if (b.templateId != null && Number(b.templateId) !== camp.templateId) {
        const t = db.prepare('SELECT * FROM comm_templates WHERE id = ?').get(Number(b.templateId));
        if (!t) return res.status(404).json({ success: false, error: 'Template não encontrado' });
        templateId = t.id; canal = t.canal;
      }
      let listaId = camp.listaId;
      if (b.listaId != null && Number(b.listaId) !== camp.listaId) {
        const l = db.prepare('SELECT * FROM comm_listas WHERE id = ?').get(Number(b.listaId));
        if (!l) return res.status(404).json({ success: false, error: 'Lista não encontrada' });
        listaId = l.id;
      }
      let tipo = camp.tipo;
      if (b.tipo != null && b.tipo !== camp.tipo) {
        if (!dest.TIPOS_CAMPANHA.includes(b.tipo)) {
          return res.status(400).json({ success: false, error: `tipo deve ser ${dest.TIPOS_CAMPANHA.join(' ou ')}` });
        }
        tipo = b.tipo;
      }
      const nome = b.nome != null ? String(b.nome).trim() : camp.nome;
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });

      const agendadaPara = b.agendadaPara !== undefined ? (b.agendadaPara || null) : camp.agendadaPara;
      const total = db.prepare('SELECT COUNT(*) AS n FROM comm_lista_membros WHERE listaId = ?').get(listaId).n;

      db.prepare(`UPDATE comm_campanhas SET nome = ?, templateId = ?, listaId = ?, canal = ?, tipo = ?,
          agendadaPara = ?, status = ?, totalDestinatarios = ?, observacoes = ? WHERE id = ?`)
        .run(nome, templateId, listaId, canal, tipo, agendadaPara,
             agendadaPara ? 'agendada' : 'rascunho', total,
             b.observacoes !== undefined ? (b.observacoes || null) : camp.observacoes, camp.id);
      logAction(db, req, 'editar', 'comm-campanha', camp.id, { nome, totalDest: total });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(camp.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /** Duplica uma campanha (inclusive enviada) para reaproveitar texto e público. */
  app.post('/api/comm/campanhas/:id/duplicar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });
      const total = db.prepare('SELECT COUNT(*) AS n FROM comm_lista_membros WHERE listaId = ?').get(c.listaId).n;
      const nome = String(req.body?.nome || `${c.nome} (cópia)`).trim().slice(0, 120);
      const r = db.prepare(`INSERT INTO comm_campanhas
          (nome, templateId, listaId, canal, status, totalDestinatarios, observacoes, tipo)
        VALUES (?, ?, ?, ?, 'rascunho', ?, ?, ?)`)
        .run(nome, c.templateId, c.listaId, c.canal, total, c.observacoes || null, c.tipo);
      logAction(db, req, 'duplicar', 'comm-campanha', r.lastInsertRowid, { de: c.id });
      res.json({ success: true, campanha: db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  /**
   * Pausa a campanha em curso. Diferente de cancelar: os envios seguem
   * 'pendente' e um /executar depois continua de onde parou.
   */
  app.post('/api/comm/campanhas/:id/pausar', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['enviada', 'cancelada'].includes(camp.status)) {
        return res.status(400).json({ success: false, error: `Campanha ${camp.status} não está em execução` });
      }
      const ctl = running.get('comm:' + (req.tenantCtx && req.tenantCtx.slug) + ':' + camp.id);
      if (ctl) ctl.cancelled = true;   // encerra o laço; o status vira 'pausada' porque restam pendentes
      // Agendada que é pausada perde o agendamento: sem isso o scheduler a
      // dispararia de novo em no máximo 2 minutos.
      db.prepare("UPDATE comm_campanhas SET status = 'pausada', agendadaPara = NULL WHERE id = ?").run(camp.id);
      logAction(db, req, 'pausar', 'comm-campanha', camp.id, null);
      res.json({ success: true, emExecucao: !!ctl });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /** Agenda (ou desagenda, com quando=null) o início do disparo. */
  app.post('/api/comm/campanhas/:id/agendar', (req, res) => {
    try {
      const camp = db.prepare('SELECT * FROM comm_campanhas WHERE id = ?').get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['enviada', 'cancelada'].includes(camp.status)) {
        return res.status(400).json({ success: false, error: `Campanha ${camp.status} não pode ser agendada` });
      }
      const quando = req.body?.quando;
      if (!quando) {
        db.prepare("UPDATE comm_campanhas SET agendadaPara = NULL, status = 'rascunho' WHERE id = ?").run(camp.id);
        return res.json({ success: true, agendadaPara: null });
      }
      const d = new Date(quando);
      if (isNaN(d.getTime())) return res.status(400).json({ success: false, error: 'Data inválida' });
      db.prepare("UPDATE comm_campanhas SET agendadaPara = ?, status = 'agendada' WHERE id = ?")
        .run(d.toISOString(), camp.id);
      logAction(db, req, 'agendar', 'comm-campanha', camp.id, { quando: d.toISOString() });
      res.json({ success: true, agendadaPara: d.toISOString() });
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

  // ==================== OPT-OUT ====================

  app.get('/api/comm/optout', (req, res) => {
    try {
      const { canal, q } = req.query;
      let sql = `SELECT o.*, p.razaoSocial FROM comm_optout o
                 LEFT JOIN pessoas p ON p.id = o.pessoaId WHERE 1=1`;
      const params = [];
      if (canal) { sql += ' AND o.canal = ?'; params.push(canal); }
      if (q) { sql += ' AND (o.destino LIKE ? OR p.razaoSocial LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
      sql += ' ORDER BY o.dataCriacao DESC LIMIT 1000';
      const registros = db.prepare(sql).all(...params);
      const porCanal = db.prepare('SELECT canal, COUNT(*) n FROM comm_optout GROUP BY canal').all();
      res.json({ success: true, registros, porCanal });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comm/optout', (req, res) => {
    try {
      const r = dest.registrarOptOut(db, { ...req.body, origem: req.body?.origem || 'manual' });
      logAction(db, req, 'registrar-optout', 'comm', null, r);
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Reinclusão exige confirmação: desfazer um "não me mande mais" é decisão de
  // risco, não correção de digitação.
  app.delete('/api/comm/optout', (req, res) => {
    try {
      const { canal, destino, confirmar } = req.body || {};
      if (confirmar !== true) {
        return res.status(400).json({ success: false,
          error: 'Reinclusão exige confirmar: true — a pessoa pediu para não receber' });
      }
      const r = dest.removerOptOut(db, canal, destino);
      if (!r.removidos) return res.status(404).json({ success: false, error: 'Destino não estava em opt-out' });
      logAction(db, req, 'remover-optout', 'comm', null, { canal, destino });
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== PRÉVIA DA CAMPANHA ====================

  // Quem realmente vai receber, antes de disparar. Uma campanha que diz
  // "500 enviados" sem dizer que 120 estavam em opt-out dá uma taxa de sucesso
  // que não existe.
  app.get('/api/comm/campanhas/:id/previa', (req, res) => {
    try {
      const camp = db.prepare(`SELECT c.*, t.canal, t.assunto, t.corpo
        FROM comm_campanhas c JOIN comm_templates t ON t.id = c.templateId WHERE c.id = ?`).get(req.params.id);
      if (!camp) return res.status(404).json({ success: false, error: 'Campanha não encontrada' });

      const prep = dest.prepararDestinatarios(db, { listaId: camp.listaId, canal: camp.canal, tipo: camp.tipo });
      const problemas = dest.validarTemplate({ nome: 'x', canal: camp.canal, assunto: camp.assunto, corpo: camp.corpo });
      const janela = dest.janelaPermitida(db);
      const temSmtp = camp.canal === 'email' ? !!loadSmtpConfig(db) : null;

      res.json({
        success: true,
        canal: camp.canal,
        tipo: camp.tipo || 'marketing',
        resumo: prep.resumo,
        descartados: prep.descartados.slice(0, 200),
        exemplos: prep.enviar.slice(0, 3).map((d) => ({
          destino: d.destino, nome: d.pessoa.razaoSocial,
          assunto: renderizar(camp.assunto, d.pessoa),
          corpo: renderizar(camp.corpo, d.pessoa),
        })),
        problemasTemplate: problemas,
        // "0 elegíveis" sem explicação faz o usuário achar que o sistema
        // quebrou, quando o que falta é o aceite ter sido coletado.
        consentimento: (camp.tipo || 'marketing') === 'marketing'
          ? dest.diagnosticoConsentimento(db, camp.canal) : null,
        janela,
        envioReal: camp.canal === 'email'
          ? (temSmtp || false)
          : !!(loadProviderConfig(db) || {}).instance,
      });
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
