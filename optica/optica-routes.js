/**
 * optica-routes.js — Módulo Ótica (fase 1: schema + cadastros)
 *
 * Modelo: NÃO altera tabelas core (produtos, pedidos, pedido_itens).
 * Cria tabelas optica_* que referenciam produtos por FK 1:1.
 *
 *   produtos (core)
 *     ├── optica_armacao_specs (1:1 via produtoId UNIQUE)
 *     └── optica_lente_specs   (1:1 via produtoId UNIQUE)
 *
 * Feature flag por-tenant em config('optica_enabled'). Quando off, todas
 * as rotas /api/optica/* devolvem 403 com error:'optica_disabled'.
 * Front decide se mostra o módulo a partir de GET /api/optica/status.
 */

const { logAction } = require('../audit-log');

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS optica_armacao_specs (
      produtoId INTEGER PRIMARY KEY,
      marca TEXT,
      modelo TEXT,
      cor TEXT,
      material TEXT,
      aroMm INTEGER,
      ponteMm INTEGER,
      hasteMm INTEGER,
      generoAlvo TEXT,
      observacoes TEXT,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS optica_lente_specs (
      produtoId INTEGER PRIMARY KEY,
      tipo TEXT,
      material TEXT,
      indiceRefracao TEXT,
      tratamentos TEXT,
      observacoes TEXT,
      FOREIGN KEY (produtoId) REFERENCES produtos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS optica_lente_tipos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS optica_lente_materiais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS optica_lente_indices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS optica_lente_tratamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );

    -- Lookups de armação (mesmo padrão dos de lente: codigo/label/ordem/ativo)
    CREATE TABLE IF NOT EXISTS optica_armacao_materiais (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS optica_armacao_generos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS optica_armacao_cores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    -- Marca e modelo: relação 1:N (modelo pertence à marca)
    CREATE TABLE IF NOT EXISTS optica_marcas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
      ativo INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS optica_modelos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marcaId INTEGER NOT NULL,
      nome TEXT NOT NULL COLLATE NOCASE,
      ativo INTEGER NOT NULL DEFAULT 1,
      UNIQUE(marcaId, nome),
      FOREIGN KEY (marcaId) REFERENCES optica_marcas(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_optica_modelos_marca ON optica_modelos(marcaId, ativo);

    CREATE TABLE IF NOT EXISTS optica_receitas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pessoaId INTEGER NOT NULL,
      dataReceita TEXT NOT NULL,
      dataValidade TEXT,
      medico TEXT,
      crm TEXT,
      od_esferico REAL,
      od_cilindrico REAL,
      od_eixo INTEGER,
      od_adicao REAL,
      oe_esferico REAL,
      oe_cilindrico REAL,
      oe_eixo INTEGER,
      oe_adicao REAL,
      dnp_od REAL,
      dnp_oe REAL,
      alturaOptica REAL,
      observacoes TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      dataCriacao TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_optica_receitas_pessoa ON optica_receitas(pessoaId, dataReceita DESC);

    CREATE TABLE IF NOT EXISTS optica_pedido_item_receita (
      pedidoItemId INTEGER PRIMARY KEY,
      receitaId INTEGER NOT NULL,
      olho TEXT,
      observacoes TEXT,
      FOREIGN KEY (pedidoItemId) REFERENCES pedido_itens(id) ON DELETE CASCADE,
      FOREIGN KEY (receitaId) REFERENCES optica_receitas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_optica_item_receita_recip ON optica_pedido_item_receita(receitaId);

    CREATE TABLE IF NOT EXISTS optica_ordens_montagem (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      pedidoId INTEGER,
      status TEXT NOT NULL DEFAULT 'aguardando',
      laboratorio TEXT,
      dataAbertura TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dataEnvioLab TEXT,
      dataPrevisaoEntrega TEXT,
      dataEntrega TEXT,
      observacoes TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_optica_om_pedido ON optica_ordens_montagem(pedidoId);
    CREATE INDEX IF NOT EXISTS idx_optica_om_status ON optica_ordens_montagem(status, dataAbertura);

    -- Forensics: rastreia toda mudança em config(optica_enabled) com histórico
    -- (config.dataAtualizacao só guarda o último estado).
    CREATE TABLE IF NOT EXISTS optica_flag_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      evento TEXT NOT NULL,
      valor_antes TEXT,
      valor_depois TEXT
    );
    CREATE TRIGGER IF NOT EXISTS trg_optica_flag_insert
      AFTER INSERT ON config WHEN NEW.chave = 'optica_enabled'
    BEGIN
      INSERT INTO optica_flag_audit (evento, valor_antes, valor_depois)
      VALUES ('INSERT', NULL, NEW.valor);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_optica_flag_update
      AFTER UPDATE ON config WHEN NEW.chave = 'optica_enabled'
    BEGIN
      INSERT INTO optica_flag_audit (evento, valor_antes, valor_depois)
      VALUES ('UPDATE', OLD.valor, NEW.valor);
    END;
    CREATE TRIGGER IF NOT EXISTS trg_optica_flag_delete
      AFTER DELETE ON config WHEN OLD.chave = 'optica_enabled'
    BEGIN
      INSERT INTO optica_flag_audit (evento, valor_antes, valor_depois)
      VALUES ('DELETE', OLD.valor, NULL);
    END;
  `);

  seedLookupsLentes(db);
  seedLookupsArmacoes(db);
}

const SEED_TIPOS = [
  ['monofocal', 'Monofocal (visão única)'],
  ['bifocal', 'Bifocal'],
  ['multifocal', 'Multifocal / Progressiva'],
  ['ocupacional', 'Ocupacional'],
  ['incolor', 'Lente solar incolor'],
  ['solar', 'Lente solar com grau'],
];
const SEED_MATERIAIS = [
  ['cr39', 'Resina (CR-39)'],
  ['policarbonato', 'Policarbonato'],
  ['trivex', 'Trivex'],
  ['cristal', 'Cristal/mineral'],
  ['alto_indice', 'Alto índice'],
];
const SEED_INDICES = [
  ['1.50', '1.50'],
  ['1.56', '1.56'],
  ['1.59', '1.59'],
  ['1.61', '1.61'],
  ['1.67', '1.67'],
  ['1.74', '1.74'],
];
const SEED_TRATAMENTOS = [
  ['antirreflexo', 'Antirreflexo (AR)'],
  ['antirrisco', 'Antirrisco'],
  ['hidrofobico', 'Hidrofóbico'],
  ['oleofobico', 'Oleofóbico'],
  ['bluecut', 'Filtro luz azul (Blue Cut)'],
  ['fotossensivel', 'Fotossensível (Transitions)'],
  ['polarizada', 'Polarizada'],
  ['uv400', 'Proteção UV 400'],
];

function seedLookupsLentes(db) {
  const seed = (tabela, dados) => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${tabela} (codigo, label, ordem) VALUES (?, ?, ?)`);
    dados.forEach((d, i) => stmt.run(d[0], d[1], i));
  };
  seed('optica_lente_tipos', SEED_TIPOS);
  seed('optica_lente_materiais', SEED_MATERIAIS);
  seed('optica_lente_indices', SEED_INDICES);
  seed('optica_lente_tratamentos', SEED_TRATAMENTOS);
}

const SEED_ARMACAO_MATERIAIS = [
  ['acetato', 'Acetato'], ['metal', 'Metal'], ['titanio', 'Titânio'],
  ['tr90', 'TR-90'], ['aluminio', 'Alumínio'], ['madeira', 'Madeira'],
  ['outro', 'Outro'],
];
const SEED_ARMACAO_GENEROS = [
  ['unissex', 'Unissex'], ['masculino', 'Masculino'],
  ['feminino', 'Feminino'], ['infantil', 'Infantil'],
];

function seedLookupsArmacoes(db) {
  const seed = (tabela, dados) => {
    const stmt = db.prepare(`INSERT OR IGNORE INTO ${tabela} (codigo, label, ordem) VALUES (?, ?, ?)`);
    dados.forEach((d, i) => stmt.run(d[0], d[1], i));
  };
  seed('optica_armacao_materiais', SEED_ARMACAO_MATERIAIS);
  seed('optica_armacao_generos', SEED_ARMACAO_GENEROS);
  // cor não tem seed — usuário cadastra conforme uso.
}

const LOOKUP_TABELAS = {
  tipos: 'optica_lente_tipos',
  materiais: 'optica_lente_materiais',
  indices: 'optica_lente_indices',
  tratamentos: 'optica_lente_tratamentos',
};

const LOOKUP_TABELAS_ARMACAO = {
  materiais: 'optica_armacao_materiais',
  generos: 'optica_armacao_generos',
  cores: 'optica_armacao_cores',
};

function getFlag(db) {
  const r = db.prepare("SELECT valor FROM config WHERE chave = 'optica_enabled'").get();
  return r && r.valor === '1';
}

// Diagnóstico (forensics 2026-04-28): patch global em Database.prototype.prepare
// para capturar QUALQUER write em config(optica_enabled), independente de qual
// código chame (stmt-cache, setConfigValue, prepare direto, etc.). Roda 1x.
let _opticaFlagPatchAplicado = false;
function aplicarPatchOpticaFlag() {
  if (_opticaFlagPatchAplicado) return;
  _opticaFlagPatchAplicado = true;
  try {
    const Database = require('better-sqlite3');
    const origPrepare = Database.prototype.prepare;
    Database.prototype.prepare = function (sql) {
      const stmt = origPrepare.call(this, sql);
      if (typeof sql === 'string' && /optica_enabled/i.test(sql)) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = function (...args) {
          console.error('[optica-flag-write] SQL_LITERAL', { sql, args, ts: new Date().toISOString() });
          console.trace('[optica-flag-write] stack');
          return origRun(...args);
        };
      } else if (typeof sql === 'string' && /INSERT.*INTO\s+config|UPDATE\s+config|REPLACE\s+INTO\s+config/i.test(sql)) {
        const origRun = stmt.run.bind(stmt);
        stmt.run = function (...args) {
          if (args.some(a => String(a) === 'optica_enabled')) {
            console.error('[optica-flag-write] SQL_PARAM', { sql, args, ts: new Date().toISOString() });
            console.trace('[optica-flag-write] stack');
          }
          return origRun(...args);
        };
      }
      return stmt;
    };
    console.log('[Ótica] Patch diagnóstico Database.prepare aplicado');
  } catch (e) {
    console.error('[Ótica] Falha ao aplicar patch diagnóstico:', e.message);
  }
}

function registrarRotasOptica(app, db) {
  aplicarPatchOpticaFlag();
  migrarDB(db);

  const tenantsMigrados = new WeakSet();
  function ensureMigrated(req, res, next) {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        migrarDB(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
  app.use('/api/optica', ensureMigrated);

  // Read-only: tenant pergunta se o módulo está ativo (controlado pelo
  // super-admin via PATCH /api/admin/tenants/:slug/features). O tenant
  // não pode alternar a flag sozinho.
  app.get('/api/optica/status', (req, res) => {
    res.json({ success: true, enabled: getFlag(db) });
  });

  // Daqui pra frente, exige flag
  function gateFlag(req, res, next) {
    if (!getFlag(db)) return res.status(403).json({ success: false, error: 'optica_disabled' });
    next();
  }

  // ==================== ARMAÇÕES ====================

  app.get('/api/optica/armacoes', gateFlag, (req, res) => {
    try {
      const incluirInativas = req.query.todos === '1';
      const where = incluirInativas ? '' : ' WHERE p.ativo = 1';
      const rows = db.prepare(`
        SELECT p.id AS produtoId, p.sku, p.descricao, p.precoCusto, p.precoVenda,
               p.estoqueMinimo, p.ativo, p.imagemPath,
               s.marca, s.modelo, s.cor, s.material, s.aroMm, s.ponteMm, s.hasteMm,
               s.generoAlvo, s.observacoes
        FROM optica_armacao_specs s
        JOIN produtos p ON p.id = s.produtoId
        ${where}
        ORDER BY p.descricao
      `).all();
      res.json({ success: true, armacoes: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/optica/armacoes/:produtoId', gateFlag, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT p.id AS produtoId, p.sku, p.descricao, p.precoCusto, p.precoVenda,
               p.estoqueMinimo, p.ativo, p.imagemPath,
               s.marca, s.modelo, s.cor, s.material, s.aroMm, s.ponteMm, s.hasteMm,
               s.generoAlvo, s.observacoes
        FROM optica_armacao_specs s
        JOIN produtos p ON p.id = s.produtoId
        WHERE s.produtoId = ?
      `).get(req.params.produtoId);
      if (!row) return res.status(404).json({ success: false, error: 'Armação não encontrada' });
      res.json({ success: true, armacao: row });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/armacoes', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      if (!b.sku || !b.descricao) return res.status(400).json({ success: false, error: 'sku e descricao obrigatórios' });
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO produtos
          (sku, descricao, unidade, precoCusto, precoVenda, estoqueMinimo, categoria, marca)
          VALUES (?, ?, 'UN', ?, ?, ?, 'armacao', ?)`).run(
          b.sku.trim(), b.descricao.trim(),
          Number(b.precoCusto) || 0, Number(b.precoVenda) || 0,
          Number(b.estoqueMinimo) || 0, b.marca || null
        );
        const pid = r.lastInsertRowid;
        db.prepare(`INSERT INTO optica_armacao_specs
          (produtoId, marca, modelo, cor, material, aroMm, ponteMm, hasteMm, generoAlvo, observacoes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          pid, b.marca || null, b.modelo || null, b.cor || null, b.material || null,
          b.aroMm != null && b.aroMm !== '' ? Number(b.aroMm) : null,
          b.ponteMm != null && b.ponteMm !== '' ? Number(b.ponteMm) : null,
          b.hasteMm != null && b.hasteMm !== '' ? Number(b.hasteMm) : null,
          b.generoAlvo || null, b.observacoes || null
        );
        return pid;
      });
      const pid = tx();
      logAction(db, req, 'criar', 'optica-armacao', pid, { sku: b.sku });
      res.json({ success: true, produtoId: pid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/armacoes/:produtoId', gateFlag, (req, res) => {
    try {
      const pid = Number(req.params.produtoId);
      const atual = db.prepare('SELECT * FROM optica_armacao_specs WHERE produtoId = ?').get(pid);
      if (!atual) return res.status(404).json({ success: false, error: 'Armação não encontrada' });
      const b = req.body || {};
      const tx = db.transaction(() => {
        if (b.sku !== undefined || b.descricao !== undefined || b.precoCusto !== undefined ||
            b.precoVenda !== undefined || b.estoqueMinimo !== undefined || b.ativo !== undefined ||
            b.marca !== undefined) {
          const prod = db.prepare('SELECT * FROM produtos WHERE id = ?').get(pid);
          db.prepare(`UPDATE produtos SET
              sku = ?, descricao = ?, precoCusto = ?, precoVenda = ?,
              estoqueMinimo = ?, ativo = ?, marca = ?, dataAtualizacao = CURRENT_TIMESTAMP
              WHERE id = ?`).run(
            b.sku !== undefined ? String(b.sku).trim() : prod.sku,
            b.descricao !== undefined ? String(b.descricao).trim() : prod.descricao,
            b.precoCusto !== undefined ? Number(b.precoCusto) : prod.precoCusto,
            b.precoVenda !== undefined ? Number(b.precoVenda) : prod.precoVenda,
            b.estoqueMinimo !== undefined ? Number(b.estoqueMinimo) : prod.estoqueMinimo,
            b.ativo !== undefined ? (b.ativo ? 1 : 0) : prod.ativo,
            b.marca !== undefined ? b.marca : prod.marca,
            pid
          );
        }
        db.prepare(`UPDATE optica_armacao_specs SET
            marca = ?, modelo = ?, cor = ?, material = ?,
            aroMm = ?, ponteMm = ?, hasteMm = ?,
            generoAlvo = ?, observacoes = ?
            WHERE produtoId = ?`).run(
          b.marca !== undefined ? b.marca : atual.marca,
          b.modelo !== undefined ? b.modelo : atual.modelo,
          b.cor !== undefined ? b.cor : atual.cor,
          b.material !== undefined ? b.material : atual.material,
          b.aroMm !== undefined && b.aroMm !== '' ? Number(b.aroMm) : (b.aroMm === '' ? null : atual.aroMm),
          b.ponteMm !== undefined && b.ponteMm !== '' ? Number(b.ponteMm) : (b.ponteMm === '' ? null : atual.ponteMm),
          b.hasteMm !== undefined && b.hasteMm !== '' ? Number(b.hasteMm) : (b.hasteMm === '' ? null : atual.hasteMm),
          b.generoAlvo !== undefined ? b.generoAlvo : atual.generoAlvo,
          b.observacoes !== undefined ? b.observacoes : atual.observacoes,
          pid
        );
      });
      tx();
      logAction(db, req, 'editar', 'optica-armacao', pid, {});
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/armacoes/:produtoId', gateFlag, (req, res) => {
    try {
      const pid = Number(req.params.produtoId);
      const r = db.prepare('UPDATE produtos SET ativo = 0 WHERE id = ? AND ativo = 1').run(pid);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrada ou já inativa' });
      logAction(db, req, 'inativar', 'optica-armacao', pid, {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== LENTES ====================

  app.get('/api/optica/lentes', gateFlag, (req, res) => {
    try {
      const incluirInativas = req.query.todos === '1';
      const where = incluirInativas ? '' : ' WHERE p.ativo = 1';
      const rows = db.prepare(`
        SELECT p.id AS produtoId, p.sku, p.descricao, p.precoCusto, p.precoVenda,
               p.estoqueMinimo, p.ativo,
               s.tipo, s.material, s.indiceRefracao, s.tratamentos, s.observacoes
        FROM optica_lente_specs s
        JOIN produtos p ON p.id = s.produtoId
        ${where}
        ORDER BY p.descricao
      `).all();
      res.json({ success: true, lentes: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/optica/lentes/:produtoId', gateFlag, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT p.id AS produtoId, p.sku, p.descricao, p.precoCusto, p.precoVenda,
               p.estoqueMinimo, p.ativo,
               s.tipo, s.material, s.indiceRefracao, s.tratamentos, s.observacoes
        FROM optica_lente_specs s
        JOIN produtos p ON p.id = s.produtoId
        WHERE s.produtoId = ?
      `).get(req.params.produtoId);
      if (!row) return res.status(404).json({ success: false, error: 'Lente não encontrada' });
      res.json({ success: true, lente: row });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/lentes', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      if (!b.sku || !b.descricao) return res.status(400).json({ success: false, error: 'sku e descricao obrigatórios' });
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO produtos
          (sku, descricao, unidade, precoCusto, precoVenda, estoqueMinimo, categoria)
          VALUES (?, ?, 'UN', ?, ?, ?, 'lente')`).run(
          b.sku.trim(), b.descricao.trim(),
          Number(b.precoCusto) || 0, Number(b.precoVenda) || 0,
          Number(b.estoqueMinimo) || 0
        );
        const pid = r.lastInsertRowid;
        db.prepare(`INSERT INTO optica_lente_specs
          (produtoId, tipo, material, indiceRefracao, tratamentos, observacoes)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          pid, b.tipo || null, b.material || null, b.indiceRefracao || null,
          b.tratamentos || null, b.observacoes || null
        );
        return pid;
      });
      const pid = tx();
      logAction(db, req, 'criar', 'optica-lente', pid, { sku: b.sku });
      res.json({ success: true, produtoId: pid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/lentes/:produtoId', gateFlag, (req, res) => {
    try {
      const pid = Number(req.params.produtoId);
      const atual = db.prepare('SELECT * FROM optica_lente_specs WHERE produtoId = ?').get(pid);
      if (!atual) return res.status(404).json({ success: false, error: 'Lente não encontrada' });
      const b = req.body || {};
      const tx = db.transaction(() => {
        if (b.sku !== undefined || b.descricao !== undefined || b.precoCusto !== undefined ||
            b.precoVenda !== undefined || b.estoqueMinimo !== undefined || b.ativo !== undefined) {
          const prod = db.prepare('SELECT * FROM produtos WHERE id = ?').get(pid);
          db.prepare(`UPDATE produtos SET
              sku = ?, descricao = ?, precoCusto = ?, precoVenda = ?,
              estoqueMinimo = ?, ativo = ?, dataAtualizacao = CURRENT_TIMESTAMP
              WHERE id = ?`).run(
            b.sku !== undefined ? String(b.sku).trim() : prod.sku,
            b.descricao !== undefined ? String(b.descricao).trim() : prod.descricao,
            b.precoCusto !== undefined ? Number(b.precoCusto) : prod.precoCusto,
            b.precoVenda !== undefined ? Number(b.precoVenda) : prod.precoVenda,
            b.estoqueMinimo !== undefined ? Number(b.estoqueMinimo) : prod.estoqueMinimo,
            b.ativo !== undefined ? (b.ativo ? 1 : 0) : prod.ativo,
            pid
          );
        }
        db.prepare(`UPDATE optica_lente_specs SET
            tipo = ?, material = ?, indiceRefracao = ?, tratamentos = ?, observacoes = ?
            WHERE produtoId = ?`).run(
          b.tipo !== undefined ? b.tipo : atual.tipo,
          b.material !== undefined ? b.material : atual.material,
          b.indiceRefracao !== undefined ? b.indiceRefracao : atual.indiceRefracao,
          b.tratamentos !== undefined ? b.tratamentos : atual.tratamentos,
          b.observacoes !== undefined ? b.observacoes : atual.observacoes,
          pid
        );
      });
      tx();
      logAction(db, req, 'editar', 'optica-lente', pid, {});
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/lentes/:produtoId', gateFlag, (req, res) => {
    try {
      const pid = Number(req.params.produtoId);
      const r = db.prepare('UPDATE produtos SET ativo = 0 WHERE id = ? AND ativo = 1').run(pid);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrada ou já inativa' });
      logAction(db, req, 'inativar', 'optica-lente', pid, {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== LOOKUPS DE LENTES (tipos/materiais/indices/tratamentos) ====================

  function resolverTabelaLookup(req, res) {
    const t = LOOKUP_TABELAS[req.params.tipo];
    if (!t) { res.status(404).json({ success: false, error: 'lookup desconhecido' }); return null; }
    return t;
  }

  app.get('/api/optica/lentes-lookup/:tipo', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookup(req, res);
      if (!tabela) return;
      const incluirInativos = req.query.todos === '1';
      const where = incluirInativos ? '' : ' WHERE ativo = 1';
      const rows = db.prepare(`SELECT id, codigo, label, ordem, ativo FROM ${tabela}${where} ORDER BY ordem, label`).all();
      res.json({ success: true, itens: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/lentes-lookup/:tipo', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookup(req, res);
      if (!tabela) return;
      const b = req.body || {};
      const codigo = (b.codigo || '').toString().trim();
      const label = (b.label || '').toString().trim();
      if (!codigo || !label) return res.status(400).json({ success: false, error: 'codigo e label obrigatórios' });
      const ordem = Number.isFinite(Number(b.ordem)) ? Number(b.ordem) : 999;
      const r = db.prepare(`INSERT INTO ${tabela} (codigo, label, ordem) VALUES (?, ?, ?)`).run(codigo, label, ordem);
      logAction(db, req, 'criar', 'optica-lente-lookup', r.lastInsertRowid, { tipo: req.params.tipo, codigo });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/lentes-lookup/:tipo/:id', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookup(req, res);
      if (!tabela) return;
      const id = Number(req.params.id);
      const atual = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'item não encontrado' });
      const b = req.body || {};
      const codigo = b.codigo !== undefined ? String(b.codigo).trim() : atual.codigo;
      const label = b.label !== undefined ? String(b.label).trim() : atual.label;
      const ordem = b.ordem !== undefined && b.ordem !== '' ? Number(b.ordem) : atual.ordem;
      const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo;
      db.prepare(`UPDATE ${tabela} SET codigo = ?, label = ?, ordem = ?, ativo = ? WHERE id = ?`)
        .run(codigo, label, ordem, ativo, id);
      logAction(db, req, 'editar', 'optica-lente-lookup', id, { tipo: req.params.tipo });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/lentes-lookup/:tipo/:id', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookup(req, res);
      if (!tabela) return;
      const id = Number(req.params.id);
      const hard = req.query.hard === '1';
      if (hard) {
        const r = db.prepare(`DELETE FROM ${tabela} WHERE id = ?`).run(id);
        if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrado' });
        logAction(db, req, 'excluir', 'optica-lente-lookup', id, { tipo: req.params.tipo });
        return res.json({ success: true, hard: true });
      }
      const r = db.prepare(`UPDATE ${tabela} SET ativo = 0 WHERE id = ? AND ativo = 1`).run(id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrado ou já inativo' });
      logAction(db, req, 'inativar', 'optica-lente-lookup', id, { tipo: req.params.tipo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== LOOKUPS DE ARMAÇÃO (materiais/generos/cores) ====================

  function resolverTabelaLookupArmacao(req, res) {
    const t = LOOKUP_TABELAS_ARMACAO[req.params.tipo];
    if (!t) { res.status(404).json({ success: false, error: 'lookup desconhecido' }); return null; }
    return t;
  }

  app.get('/api/optica/armacoes-lookup/:tipo', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookupArmacao(req, res);
      if (!tabela) return;
      const incluirInativos = req.query.todos === '1';
      const where = incluirInativos ? '' : ' WHERE ativo = 1';
      const rows = db.prepare(`SELECT id, codigo, label, ordem, ativo FROM ${tabela}${where} ORDER BY ordem, label`).all();
      res.json({ success: true, itens: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/armacoes-lookup/:tipo', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookupArmacao(req, res);
      if (!tabela) return;
      const b = req.body || {};
      const codigo = (b.codigo || '').toString().trim();
      const label = (b.label || '').toString().trim();
      if (!codigo || !label) return res.status(400).json({ success: false, error: 'codigo e label obrigatórios' });
      const ordem = Number.isFinite(Number(b.ordem)) ? Number(b.ordem) : 999;
      const r = db.prepare(`INSERT INTO ${tabela} (codigo, label, ordem) VALUES (?, ?, ?)`).run(codigo, label, ordem);
      logAction(db, req, 'criar', 'optica-armacao-lookup', r.lastInsertRowid, { tipo: req.params.tipo, codigo });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/armacoes-lookup/:tipo/:id', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookupArmacao(req, res);
      if (!tabela) return;
      const id = Number(req.params.id);
      const atual = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'item não encontrado' });
      const b = req.body || {};
      const codigo = b.codigo !== undefined ? String(b.codigo).trim() : atual.codigo;
      const label = b.label !== undefined ? String(b.label).trim() : atual.label;
      const ordem = b.ordem !== undefined && b.ordem !== '' ? Number(b.ordem) : atual.ordem;
      const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo;
      db.prepare(`UPDATE ${tabela} SET codigo = ?, label = ?, ordem = ?, ativo = ? WHERE id = ?`)
        .run(codigo, label, ordem, ativo, id);
      logAction(db, req, 'editar', 'optica-armacao-lookup', id, { tipo: req.params.tipo });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/armacoes-lookup/:tipo/:id', gateFlag, (req, res) => {
    try {
      const tabela = resolverTabelaLookupArmacao(req, res);
      if (!tabela) return;
      const id = Number(req.params.id);
      const r = db.prepare(`UPDATE ${tabela} SET ativo = 0 WHERE id = ? AND ativo = 1`).run(id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrado ou já inativo' });
      logAction(db, req, 'inativar', 'optica-armacao-lookup', id, { tipo: req.params.tipo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== MARCAS E MODELOS ====================

  app.get('/api/optica/marcas', gateFlag, (req, res) => {
    try {
      const incluirInativos = req.query.todos === '1';
      const sql = incluirInativos
        ? 'SELECT id, nome, ativo FROM optica_marcas ORDER BY ativo DESC, nome'
        : 'SELECT id, nome, ativo FROM optica_marcas WHERE ativo = 1 ORDER BY nome';
      res.json({ success: true, marcas: db.prepare(sql).all() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/marcas', gateFlag, (req, res) => {
    try {
      const nome = ((req.body || {}).nome || '').toString().trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const ja = db.prepare('SELECT id FROM optica_marcas WHERE nome = ?').get(nome);
      if (ja) return res.json({ success: true, id: ja.id, reused: true });
      const r = db.prepare('INSERT INTO optica_marcas (nome) VALUES (?)').run(nome);
      logAction(db, req, 'criar', 'optica-marca', r.lastInsertRowid, { nome });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/marcas/:id', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT * FROM optica_marcas WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'marca não encontrada' });
      const b = req.body || {};
      const nome = b.nome !== undefined ? String(b.nome).trim() : atual.nome;
      const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo;
      db.prepare('UPDATE optica_marcas SET nome = ?, ativo = ? WHERE id = ?').run(nome, ativo, id);
      logAction(db, req, 'editar', 'optica-marca', id, { nome });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/marcas/:id', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const r = db.prepare('UPDATE optica_marcas SET ativo = 0 WHERE id = ? AND ativo = 1').run(id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'não encontrada ou já inativa' });
      logAction(db, req, 'inativar', 'optica-marca', id, {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/optica/marcas/:id/modelos', gateFlag, (req, res) => {
    try {
      const incluirInativos = req.query.todos === '1';
      const sql = incluirInativos
        ? 'SELECT id, marcaId, nome, ativo FROM optica_modelos WHERE marcaId = ? ORDER BY ativo DESC, nome'
        : 'SELECT id, marcaId, nome, ativo FROM optica_modelos WHERE marcaId = ? AND ativo = 1 ORDER BY nome';
      res.json({ success: true, modelos: db.prepare(sql).all(Number(req.params.id)) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/marcas/:id/modelos', gateFlag, (req, res) => {
    try {
      const marcaId = Number(req.params.id);
      const marca = db.prepare('SELECT id FROM optica_marcas WHERE id = ?').get(marcaId);
      if (!marca) return res.status(404).json({ success: false, error: 'marca não encontrada' });
      const nome = ((req.body || {}).nome || '').toString().trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const ja = db.prepare('SELECT id FROM optica_modelos WHERE marcaId = ? AND nome = ?').get(marcaId, nome);
      if (ja) return res.json({ success: true, id: ja.id, reused: true });
      const r = db.prepare('INSERT INTO optica_modelos (marcaId, nome) VALUES (?, ?)').run(marcaId, nome);
      logAction(db, req, 'criar', 'optica-modelo', r.lastInsertRowid, { marcaId, nome });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/modelos/:id', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT * FROM optica_modelos WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'modelo não encontrado' });
      const b = req.body || {};
      const nome = b.nome !== undefined ? String(b.nome).trim() : atual.nome;
      const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo;
      db.prepare('UPDATE optica_modelos SET nome = ?, ativo = ? WHERE id = ?').run(nome, ativo, id);
      logAction(db, req, 'editar', 'optica-modelo', id, { nome });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/modelos/:id', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const r = db.prepare('UPDATE optica_modelos SET ativo = 0 WHERE id = ? AND ativo = 1').run(id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'não encontrado ou já inativo' });
      logAction(db, req, 'inativar', 'optica-modelo', id, {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== RECEITAS ====================

  function normReceitaBody(b) {
    const num = (v) => v === '' || v == null ? null : Number(v);
    const intv = (v) => v === '' || v == null ? null : Math.round(Number(v));
    return {
      pessoaId: b.pessoaId != null ? Number(b.pessoaId) : null,
      dataReceita: b.dataReceita || null,
      dataValidade: b.dataValidade || null,
      medico: b.medico || null,
      crm: b.crm || null,
      od_esferico: num(b.od_esferico),
      od_cilindrico: num(b.od_cilindrico),
      od_eixo: intv(b.od_eixo),
      od_adicao: num(b.od_adicao),
      oe_esferico: num(b.oe_esferico),
      oe_cilindrico: num(b.oe_cilindrico),
      oe_eixo: intv(b.oe_eixo),
      oe_adicao: num(b.oe_adicao),
      dnp_od: num(b.dnp_od),
      dnp_oe: num(b.dnp_oe),
      alturaOptica: num(b.alturaOptica),
      observacoes: b.observacoes || null,
    };
  }

  app.get('/api/optica/receitas', gateFlag, (req, res) => {
    try {
      const pessoaId = req.query.pessoaId ? Number(req.query.pessoaId) : null;
      const incluirInativas = req.query.todos === '1';
      const where = [];
      const params = [];
      if (pessoaId) { where.push('r.pessoaId = ?'); params.push(pessoaId); }
      if (!incluirInativas) where.push('r.ativo = 1');
      const sql = `
        SELECT r.*, p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaCpfCnpj
        FROM optica_receitas r
        JOIN pessoas p ON p.id = r.pessoaId
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY r.dataReceita DESC, r.id DESC
        LIMIT 500
      `;
      const rows = db.prepare(sql).all(...params);
      res.json({ success: true, receitas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/optica/receitas/:id', gateFlag, (req, res) => {
    try {
      const r = db.prepare(`SELECT r.*, p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaCpfCnpj
        FROM optica_receitas r JOIN pessoas p ON p.id = r.pessoaId WHERE r.id = ?`).get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'Receita não encontrada' });
      res.json({ success: true, receita: r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/receitas', gateFlag, (req, res) => {
    try {
      const n = normReceitaBody(req.body || {});
      if (!n.pessoaId) return res.status(400).json({ success: false, error: 'pessoaId obrigatório' });
      if (!n.dataReceita) return res.status(400).json({ success: false, error: 'dataReceita obrigatória' });
      const r = db.prepare(`INSERT INTO optica_receitas
        (pessoaId, dataReceita, dataValidade, medico, crm,
         od_esferico, od_cilindrico, od_eixo, od_adicao,
         oe_esferico, oe_cilindrico, oe_eixo, oe_adicao,
         dnp_od, dnp_oe, alturaOptica, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        n.pessoaId, n.dataReceita, n.dataValidade, n.medico, n.crm,
        n.od_esferico, n.od_cilindrico, n.od_eixo, n.od_adicao,
        n.oe_esferico, n.oe_cilindrico, n.oe_eixo, n.oe_adicao,
        n.dnp_od, n.dnp_oe, n.alturaOptica, n.observacoes
      );
      logAction(db, req, 'criar', 'optica-receita', r.lastInsertRowid, { pessoaId: n.pessoaId });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/receitas/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM optica_receitas WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Receita não encontrada' });
      const b = req.body || {};
      const n = normReceitaBody({ ...atual, ...b });
      db.prepare(`UPDATE optica_receitas SET
        pessoaId = ?, dataReceita = ?, dataValidade = ?, medico = ?, crm = ?,
        od_esferico = ?, od_cilindrico = ?, od_eixo = ?, od_adicao = ?,
        oe_esferico = ?, oe_cilindrico = ?, oe_eixo = ?, oe_adicao = ?,
        dnp_od = ?, dnp_oe = ?, alturaOptica = ?, observacoes = ?,
        ativo = ?
        WHERE id = ?`).run(
        n.pessoaId, n.dataReceita, n.dataValidade, n.medico, n.crm,
        n.od_esferico, n.od_cilindrico, n.od_eixo, n.od_adicao,
        n.oe_esferico, n.oe_cilindrico, n.oe_eixo, n.oe_adicao,
        n.dnp_od, n.dnp_oe, n.alturaOptica, n.observacoes,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id
      );
      logAction(db, req, 'editar', 'optica-receita', Number(req.params.id), {});
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/receitas/:id', gateFlag, (req, res) => {
    try {
      const r = db.prepare('UPDATE optica_receitas SET ativo = 0 WHERE id = ? AND ativo = 1').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrada ou já inativa' });
      logAction(db, req, 'inativar', 'optica-receita', Number(req.params.id), {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============ CONTEXTO PEDIDO + ANEXAR RECEITA AO ITEM ============

  // Devolve, em uma chamada, tudo que a aba "Receita Óptica" do pedido precisa:
  // - clienteId do pedido
  // - itens do pedido que são lente (com receita anexada, se houver)
  // - receitas do cliente (pra reuso)
  app.get('/api/optica/pedido/:pedidoId/contexto', gateFlag, (req, res) => {
    try {
      const ped = db.prepare('SELECT id, clienteId FROM pedidos WHERE id = ?').get(req.params.pedidoId);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido não encontrado' });

      const itens = db.prepare(`
        SELECT pi.id AS pedidoItemId, pi.produtoId, pi.descricao, pi.quantidade, pi.precoUnitario,
               p.categoria, ls.tipo AS lenteTipo, ls.material AS lenteMaterial,
               ls.indiceRefracao, ls.tratamentos,
               pir.receitaId, pir.olho, pir.observacoes AS itemObservacoes
        FROM pedido_itens pi
        JOIN produtos p ON p.id = pi.produtoId
        LEFT JOIN optica_lente_specs ls ON ls.produtoId = pi.produtoId
        LEFT JOIN optica_pedido_item_receita pir ON pir.pedidoItemId = pi.id
        WHERE pi.pedidoId = ? AND p.categoria = 'lente'
        ORDER BY pi.id
      `).all(req.params.pedidoId);

      const receitas = ped.clienteId ? db.prepare(`
        SELECT * FROM optica_receitas
        WHERE pessoaId = ? AND ativo = 1
        ORDER BY dataReceita DESC, id DESC
        LIMIT 50
      `).all(ped.clienteId) : [];

      const omAtual = db.prepare(`SELECT id, numero, status FROM optica_ordens_montagem
                                   WHERE pedidoId = ? AND ativo = 1
                                   ORDER BY id DESC LIMIT 1`).get(req.params.pedidoId) || null;

      res.json({ success: true, clienteId: ped.clienteId, itens, receitas, omAtual });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/pedido-item/:pedidoItemId/receita', gateFlag, (req, res) => {
    try {
      const itemId = Number(req.params.pedidoItemId);
      const item = db.prepare('SELECT id FROM pedido_itens WHERE id = ?').get(itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Item de pedido não encontrado' });
      const b = req.body || {};
      if (!b.receitaId) return res.status(400).json({ success: false, error: 'receitaId obrigatório' });
      const receita = db.prepare('SELECT id FROM optica_receitas WHERE id = ?').get(Number(b.receitaId));
      if (!receita) return res.status(404).json({ success: false, error: 'Receita não encontrada' });
      db.prepare(`INSERT INTO optica_pedido_item_receita (pedidoItemId, receitaId, olho, observacoes)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(pedidoItemId) DO UPDATE SET
                    receitaId = excluded.receitaId,
                    olho = excluded.olho,
                    observacoes = excluded.observacoes`).run(
        itemId, Number(b.receitaId), b.olho || null, b.observacoes || null
      );
      logAction(db, req, 'anexar-receita', 'optica-pedido-item', itemId, { receitaId: b.receitaId });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/pedido-item/:pedidoItemId/receita', gateFlag, (req, res) => {
    try {
      const r = db.prepare('DELETE FROM optica_pedido_item_receita WHERE pedidoItemId = ?').run(Number(req.params.pedidoItemId));
      if (!r.changes) return res.status(404).json({ success: false, error: 'Nenhuma receita anexada a este item' });
      logAction(db, req, 'desvincular-receita', 'optica-pedido-item', Number(req.params.pedidoItemId), {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ORDENS DE MONTAGEM ====================

  const STATUS_OM = ['aguardando', 'laboratorio', 'pronto', 'entregue', 'cancelada'];

  function gerarNumeroOM() {
    const ano = new Date().getFullYear();
    const prefix = `OM-${ano}-`;
    const u = db.prepare(`SELECT numero FROM optica_ordens_montagem WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix + '%');
    let n = 1;
    if (u) { const m = u.numero.match(/-(\d+)$/); if (m) n = parseInt(m[1], 10) + 1; }
    return prefix + String(n).padStart(5, '0');
  }

  function carregarOMCompleta(omId) {
    const om = db.prepare(`
      SELECT om.*, ped.numero AS pedidoNumero, ped.clienteId,
             p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
             p.telefone AS clienteTelefone, p.email AS clienteEmail
      FROM optica_ordens_montagem om
      LEFT JOIN pedidos ped ON ped.id = om.pedidoId
      LEFT JOIN pessoas p ON p.id = ped.clienteId
      WHERE om.id = ?
    `).get(omId);
    if (!om) return null;

    om.itens = om.pedidoId ? db.prepare(`
      SELECT pi.id AS pedidoItemId, pi.descricao, pi.quantidade,
             prod.categoria, prod.sku,
             ls.tipo AS lenteTipo, ls.material AS lenteMaterial,
             ls.indiceRefracao, ls.tratamentos,
             ar.marca AS armacaoMarca, ar.modelo AS armacaoModelo, ar.cor AS armacaoCor,
             ar.material AS armacaoMaterial, ar.aroMm, ar.ponteMm, ar.hasteMm,
             pir.receitaId, pir.olho, pir.observacoes AS itemObservacoes,
             r.dataReceita, r.medico, r.crm,
             r.od_esferico, r.od_cilindrico, r.od_eixo, r.od_adicao,
             r.oe_esferico, r.oe_cilindrico, r.oe_eixo, r.oe_adicao,
             r.dnp_od, r.dnp_oe, r.alturaOptica, r.observacoes AS receitaObservacoes
      FROM pedido_itens pi
      JOIN produtos prod ON prod.id = pi.produtoId
      LEFT JOIN optica_lente_specs ls ON ls.produtoId = prod.id
      LEFT JOIN optica_armacao_specs ar ON ar.produtoId = prod.id
      LEFT JOIN optica_pedido_item_receita pir ON pir.pedidoItemId = pi.id
      LEFT JOIN optica_receitas r ON r.id = pir.receitaId
      WHERE pi.pedidoId = ? AND prod.categoria IN ('lente','armacao')
      ORDER BY prod.categoria DESC, pi.id
    `).all(om.pedidoId) : [];
    return om;
  }

  app.get('/api/optica/ordens-montagem', gateFlag, (req, res) => {
    try {
      const { status, q, dataIni, dataFim, todas } = req.query;
      const where = [];
      const params = [];
      if (todas !== '1') where.push('om.ativo = 1');
      if (status && STATUS_OM.includes(status)) { where.push('om.status = ?'); params.push(status); }
      if (dataIni) { where.push('om.dataAbertura >= ?'); params.push(dataIni); }
      if (dataFim) { where.push('om.dataAbertura <= ?'); params.push(dataFim + ' 23:59:59'); }
      if (q) {
        where.push('(om.numero LIKE ? OR ped.numero LIKE ? OR p.razaoSocial LIKE ? OR p.cpfCnpj LIKE ? OR om.laboratorio LIKE ?)');
        const term = `%${q}%`;
        params.push(term, term, term, term, term);
      }
      const sql = `
        SELECT om.id, om.numero, om.pedidoId, om.status, om.laboratorio,
               om.dataAbertura, om.dataEnvioLab, om.dataPrevisaoEntrega, om.dataEntrega,
               om.observacoes, om.ativo,
               ped.numero AS pedidoNumero,
               p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
               (SELECT COUNT(*) FROM pedido_itens pi
                JOIN produtos prod ON prod.id = pi.produtoId
                WHERE pi.pedidoId = om.pedidoId AND prod.categoria = 'lente') AS lentesItens,
               (SELECT COUNT(DISTINCT pir.pedidoItemId) FROM pedido_itens pi
                JOIN produtos prod ON prod.id = pi.produtoId
                JOIN optica_pedido_item_receita pir ON pir.pedidoItemId = pi.id
                WHERE pi.pedidoId = om.pedidoId AND prod.categoria = 'lente') AS lentesComReceita,
               (SELECT MAX(r.dataReceita) FROM pedido_itens pi
                JOIN optica_pedido_item_receita pir ON pir.pedidoItemId = pi.id
                JOIN optica_receitas r ON r.id = pir.receitaId
                WHERE pi.pedidoId = om.pedidoId) AS receitaUltimaData
        FROM optica_ordens_montagem om
        LEFT JOIN pedidos ped ON ped.id = om.pedidoId
        LEFT JOIN pessoas p ON p.id = ped.clienteId
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY om.dataAbertura DESC, om.id DESC
        LIMIT 500
      `;
      const rows = db.prepare(sql).all(...params);
      res.json({ success: true, ordens: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/optica/ordens-montagem/:id', gateFlag, (req, res) => {
    try {
      const om = carregarOMCompleta(Number(req.params.id));
      if (!om) return res.status(404).json({ success: false, error: 'OM não encontrada' });
      res.json({ success: true, om });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/optica/ordens-montagem', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const pedidoId = b.pedidoId ? Number(b.pedidoId) : null;
      if (pedidoId) {
        const ped = db.prepare('SELECT id FROM pedidos WHERE id = ?').get(pedidoId);
        if (!ped) return res.status(400).json({ success: false, error: 'Pedido não encontrado' });
        const ja = db.prepare('SELECT id FROM optica_ordens_montagem WHERE pedidoId = ? AND ativo = 1').get(pedidoId);
        if (ja && b.permitirDuplicada !== true) {
          return res.status(409).json({ success: false, error: 'Já existe OM ativa para este pedido', omId: ja.id });
        }
      }
      const numero = gerarNumeroOM();
      const r = db.prepare(`INSERT INTO optica_ordens_montagem
        (numero, pedidoId, status, laboratorio, dataEnvioLab, dataPrevisaoEntrega, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        numero, pedidoId, b.status && STATUS_OM.includes(b.status) ? b.status : 'aguardando',
        b.laboratorio || null, b.dataEnvioLab || null, b.dataPrevisaoEntrega || null,
        b.observacoes || null
      );
      logAction(db, req, 'criar', 'optica-om', r.lastInsertRowid, { numero, pedidoId });
      res.json({ success: true, id: r.lastInsertRowid, numero });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/optica/ordens-montagem/:id', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT * FROM optica_ordens_montagem WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'OM não encontrada' });
      const b = req.body || {};
      const status = (b.status && STATUS_OM.includes(b.status)) ? b.status : atual.status;
      // Transições automáticas de data baseadas em mudança de status
      let dataEnvioLab = b.dataEnvioLab !== undefined ? b.dataEnvioLab : atual.dataEnvioLab;
      let dataEntrega = b.dataEntrega !== undefined ? b.dataEntrega : atual.dataEntrega;
      const hojeISO = new Date().toISOString().slice(0,10);
      if (status === 'laboratorio' && atual.status !== 'laboratorio' && !dataEnvioLab) dataEnvioLab = hojeISO;
      if (status === 'entregue' && atual.status !== 'entregue' && !dataEntrega) dataEntrega = hojeISO;

      db.prepare(`UPDATE optica_ordens_montagem SET
        status = ?, laboratorio = ?,
        dataEnvioLab = ?, dataPrevisaoEntrega = ?, dataEntrega = ?,
        observacoes = ?, ativo = ?
        WHERE id = ?`).run(
        status,
        b.laboratorio !== undefined ? b.laboratorio : atual.laboratorio,
        dataEnvioLab,
        b.dataPrevisaoEntrega !== undefined ? b.dataPrevisaoEntrega : atual.dataPrevisaoEntrega,
        dataEntrega,
        b.observacoes !== undefined ? b.observacoes : atual.observacoes,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        id
      );
      logAction(db, req, 'editar', 'optica-om', id, { status });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/optica/ordens-montagem/:id', gateFlag, (req, res) => {
    try {
      const r = db.prepare('UPDATE optica_ordens_montagem SET ativo = 0 WHERE id = ? AND ativo = 1').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrada ou já inativa' });
      logAction(db, req, 'inativar', 'optica-om', Number(req.params.id), {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/optica/ordens-montagem/:id/pdf', gateFlag, async (req, res) => {
    try {
      const om = carregarOMCompleta(Number(req.params.id));
      if (!om) return res.status(404).json({ success: false, error: 'OM não encontrada' });
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get() || {};
      const { gerarOrdemMontagemPdf } = require('./optica-pdf');
      const buf = await gerarOrdemMontagemPdf({ om, fornecedor });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="OM-${om.numero}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[Ótica] Erro PDF OM:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[Ótica] Rotas registradas');
}

module.exports = { registrarRotasOptica };
