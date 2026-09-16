/**
 * posto-routes.js — Módulo Posto de Combustível, fase 1: cadastros e config.
 *
 * Feature flag por-tenant em config('posto_enabled'). Quando off,
 * /api/posto/* devolve 403 com error:'posto_disabled' — mesmo contrato dos
 * módulos Ótica e Restaurante. O module-gate do plano é a camada anterior.
 *
 * Config do módulo mora na tabela `config` com prefixo `posto_`:
 *   posto_tolerancia_perda_pct   limite de perda/sobra diária (default 0.6,
 *                                Resolução ANP 884/2022 — configurável porque
 *                                alguns postos trabalham com meta interna menor)
 *   posto_afericao_padrao_ml     volume do aferidor (default 20000)
 *   posto_afericao_tol_mais_ml   tolerância superior (default 100)
 *   posto_afericao_tol_menos_ml  tolerância inferior (default 60)
 *
 * As fases seguintes (fiscal, hardware, frotas) penduram em cima destes
 * cadastros — o bico já carrega nBico/nBomba/nTanque que a NFC-e vai pedir.
 */

const { logAction } = require('../audit-log');
const { initPostoSchema } = require('./posto-schema');
const { registrarRotasPostoMovimento, normalizarDataHora, normalizarData } = require('./posto-movimento');
const { registrarRotasPostoLmc } = require('./posto-lmc');

const CONFIG_DEFAULTS = {
  posto_tolerancia_perda_pct: '0.6',
  posto_afericao_padrao_ml: '20000',
  posto_afericao_tol_mais_ml: '100',
  posto_afericao_tol_menos_ml: '60',
};

function getFlag(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'posto_enabled'").get();
    return !!(r && r.valor === '1');
  } catch (_) {
    return false;
  }
}

function lerConfig(db) {
  const out = { ...CONFIG_DEFAULTS };
  try {
    const chaves = Object.keys(CONFIG_DEFAULTS);
    const rows = db.prepare(
      `SELECT chave, valor FROM config WHERE chave IN (${chaves.map(() => '?').join(',')})`
    ).all(...chaves);
    for (const r of rows) out[r.chave] = r.valor;
  } catch (_) { /* config ausente — devolve defaults */ }
  return out;
}

function gravarConfig(db, chave, valor) {
  db.prepare(`
    INSERT INTO config (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `).run(chave, String(valor));
}

function registrarRotasPosto(app, db) {
  initPostoSchema(db);

  // Em multi-tenant o db acima é o BOOT_STUB e a migração foi no-op. O schema
  // real de cada tenant vem do db-schema.js; este hook cobre o tenant que ainda
  // não passou por um boot completo (mesmo padrão de Ótica e Restaurante).
  const tenantsMigrados = new WeakSet();
  app.use('/api/posto', (req, res, next) => {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        initPostoSchema(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Read-only e sem o gate do feature flag. Note que o gate de PLANO
  // (module-gate) casa o prefixo /api/posto/ e pega esta rota também: o tenant
  // sem o módulo contratado recebe 403 aqui, não `enabled:false`. É o mesmo
  // comportamento de Ótica, Restaurante e Farmácia.
  app.get('/api/posto/status', (req, res) => {
    res.json({ success: true, enabled: getFlag(db) });
  });

  function gateFlag(req, res, next) {
    if (!getFlag(db)) {
      return res.status(403).json({ success: false, error: 'posto_disabled' });
    }
    next();
  }

  // ==================== CONFIG ====================

  app.get('/api/posto/config', gateFlag, (req, res) => {
    try {
      res.json({ success: true, config: lerConfig(db) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/posto/config', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      if (b.posto_tolerancia_perda_pct != null) {
        const pct = Number(b.posto_tolerancia_perda_pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ success: false, error: 'tolerância inválida' });
        }
      }
      const tx = db.transaction(() => {
        for (const chave of Object.keys(CONFIG_DEFAULTS)) {
          if (b[chave] !== undefined) gravarConfig(db, chave, b[chave]);
        }
      });
      tx();
      try { logAction(db, req, 'update', 'posto_config', null, b); } catch (_) { /* */ }
      res.json({ success: true, config: lerConfig(db) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== COMBUSTÍVEIS ====================

  app.get('/api/posto/combustiveis', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM posto_tanques t WHERE t.combustivelId = c.id) AS tanques
          FROM posto_combustiveis c
         ORDER BY c.ativo DESC, c.nome ASC
      `).all();
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/combustiveis', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const codigo = String(b.codigo || '').trim().toUpperCase();
      const nome = String(b.nome || '').trim();
      if (!codigo || !nome) {
        return res.status(400).json({ success: false, error: 'código e nome são obrigatórios' });
      }
      const dup = db.prepare('SELECT id FROM posto_combustiveis WHERE codigo = ?').get(codigo);
      if (dup) return res.status(400).json({ success: false, error: `código "${codigo}" já existe` });
      const r = db.prepare(`
        INSERT INTO posto_combustiveis (codigo, nome, cProdANP, descANP, unidade, produtoId, precoLitro, ativo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        codigo, nome,
        b.cProdANP ? String(b.cProdANP).trim() : null,
        b.descANP ? String(b.descANP).trim() : null,
        b.unidade === 'KG' ? 'KG' : 'L',
        b.produtoId || null,
        Number(b.precoLitro) || 0,
        b.ativo === 0 ? 0 : 1,
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/posto/combustiveis/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM posto_combustiveis WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'combustível não encontrado' });
      const b = req.body || {};
      db.prepare(`
        UPDATE posto_combustiveis
           SET nome = ?, cProdANP = ?, descANP = ?, unidade = ?, produtoId = ?, ativo = ?
         WHERE id = ?
      `).run(
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.cProdANP !== undefined ? (b.cProdANP || null) : atual.cProdANP,
        b.descANP !== undefined ? (b.descANP || null) : atual.descANP,
        b.unidade !== undefined ? (b.unidade === 'KG' ? 'KG' : 'L') : atual.unidade,
        b.produtoId !== undefined ? (b.produtoId || null) : atual.produtoId,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Preço é rota à parte porque toda troca vira histórico: o fechamento do
  // turno precisa saber qual preço valia na hora do abastecimento.
  app.post('/api/posto/combustiveis/:id/preco', gateFlag, (req, res) => {
    try {
      const comb = db.prepare('SELECT * FROM posto_combustiveis WHERE id = ?').get(req.params.id);
      if (!comb) return res.status(404).json({ success: false, error: 'combustível não encontrado' });
      const preco = Number(req.body?.precoLitro);
      if (!Number.isFinite(preco) || preco <= 0) {
        return res.status(400).json({ success: false, error: 'preço inválido' });
      }
      const dhVig = normalizarDataHora(req.body?.vigenciaInicio);
      if (!dhVig.ok) return res.status(400).json({ success: false, error: dhVig.erro });
      const vigencia = dhVig.valor;
      const tx = db.transaction(() => {
        db.prepare(`
          INSERT INTO posto_precos (combustivelId, precoLitro, vigenciaInicio, usuario)
          VALUES (?, ?, ?, ?)
        `).run(comb.id, preco, vigencia, req.user?.nome || req.user?.username || null);
        db.prepare('UPDATE posto_combustiveis SET precoLitro = ? WHERE id = ?').run(preco, comb.id);
      });
      tx();
      try { logAction(db, req, 'update', 'posto_preco', comb.id, { de: comb.precoLitro, para: preco }); } catch (_) { /* */ }
      res.json({ success: true, precoLitro: preco });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/posto/combustiveis/:id/precos', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT * FROM posto_precos WHERE combustivelId = ?
         ORDER BY vigenciaInicio DESC LIMIT 100
      `).all(req.params.id);
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== TANQUES ====================

  app.get('/api/posto/tanques', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT t.*, c.nome AS combustivelNome, c.codigo AS combustivelCodigo, c.unidade,
               (SELECT m.litrosFisico FROM posto_medicoes m
                 WHERE m.tanqueId = t.id ORDER BY m.dataHora DESC LIMIT 1) AS ultimaMedicaoL,
               (SELECT m.dataHora FROM posto_medicoes m
                 WHERE m.tanqueId = t.id ORDER BY m.dataHora DESC LIMIT 1) AS ultimaMedicaoEm
          FROM posto_tanques t
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         ORDER BY t.codigo ASC
      `).all();
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/tanques', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const codigo = String(b.codigo || '').trim().toUpperCase();
      if (!codigo) return res.status(400).json({ success: false, error: 'código é obrigatório' });
      if (!b.combustivelId) return res.status(400).json({ success: false, error: 'combustível é obrigatório' });
      const cap = Number(b.capacidadeLitros);
      if (!Number.isFinite(cap) || cap <= 0) {
        return res.status(400).json({ success: false, error: 'capacidade inválida' });
      }
      const dup = db.prepare('SELECT id FROM posto_tanques WHERE codigo = ?').get(codigo);
      if (dup) return res.status(400).json({ success: false, error: `tanque "${codigo}" já existe` });
      const comb = db.prepare('SELECT id FROM posto_combustiveis WHERE id = ?').get(b.combustivelId);
      if (!comb) return res.status(400).json({ success: false, error: 'combustível inexistente' });
      const r = db.prepare(`
        INSERT INTO posto_tanques (codigo, combustivelId, capacidadeLitros, estoqueMinimoLitros, ativo, observacao)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        codigo, b.combustivelId, cap,
        Number(b.estoqueMinimoLitros) || 0,
        b.ativo === 0 ? 0 : 1,
        b.observacao ? String(b.observacao).trim() : null,
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/posto/tanques/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM posto_tanques WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'tanque não encontrado' });
      const b = req.body || {};
      // Trocar o combustível de um tanque com movimento reescreveria a história
      // do LMC (o dia passado passaria a ser de outro produto). Se precisar
      // mesmo, o caminho é desativar e criar outro.
      if (b.combustivelId !== undefined && Number(b.combustivelId) !== atual.combustivelId) {
        const mov = db.prepare(`
          SELECT (SELECT COUNT(*) FROM posto_descargas WHERE tanqueId = ?) +
                 (SELECT COUNT(*) FROM posto_medicoes WHERE tanqueId = ?) AS n
        `).get(req.params.id, req.params.id);
        if (mov && mov.n > 0) {
          return res.status(400).json({
            success: false,
            error: `tanque tem ${mov.n} movimento(s) — não é possível trocar o combustível`,
            sugestao: 'desativar',
          });
        }
      }
      db.prepare(`
        UPDATE posto_tanques
           SET codigo = ?, combustivelId = ?, capacidadeLitros = ?, estoqueMinimoLitros = ?, ativo = ?, observacao = ?
         WHERE id = ?
      `).run(
        b.codigo !== undefined ? String(b.codigo).trim().toUpperCase() : atual.codigo,
        b.combustivelId !== undefined ? b.combustivelId : atual.combustivelId,
        b.capacidadeLitros !== undefined ? Number(b.capacidadeLitros) : atual.capacidadeLitros,
        b.estoqueMinimoLitros !== undefined ? Number(b.estoqueMinimoLitros) : atual.estoqueMinimoLitros,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        b.observacao !== undefined ? (b.observacao || null) : atual.observacao,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/posto/tanques/:id', gateFlag, (req, res) => {
    try {
      const bicos = db.prepare('SELECT COUNT(*) AS n FROM posto_bicos WHERE tanqueId = ?').get(req.params.id);
      if (bicos && bicos.n > 0) {
        return res.status(400).json({ success: false, error: `tanque alimenta ${bicos.n} bico(s)` });
      }
      const mov = db.prepare(`
        SELECT (SELECT COUNT(*) FROM posto_descargas WHERE tanqueId = ?) +
               (SELECT COUNT(*) FROM posto_medicoes WHERE tanqueId = ?) AS n
      `).get(req.params.id, req.params.id);
      if (mov && mov.n > 0) {
        return res.status(400).json({
          success: false,
          error: `tanque tem ${mov.n} movimento(s) no histórico — desative em vez de excluir`,
          sugestao: 'desativar',
        });
      }
      db.prepare('DELETE FROM posto_tanques WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== BOMBAS ====================

  app.get('/api/posto/bombas', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT b.*,
               (SELECT COUNT(*) FROM posto_bicos bi WHERE bi.bombaId = b.id) AS bicos,
               (SELECT l.numero FROM posto_lacres l
                 WHERE l.bombaId = b.id AND l.dataRemocao IS NULL
                 ORDER BY l.dataAplicacao DESC LIMIT 1) AS lacreVigente
          FROM posto_bombas b
         ORDER BY b.codigo ASC
      `).all();
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/bombas', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const codigo = String(b.codigo || '').trim().toUpperCase();
      if (!codigo) return res.status(400).json({ success: false, error: 'código é obrigatório' });
      const dup = db.prepare('SELECT id FROM posto_bombas WHERE codigo = ?').get(codigo);
      if (dup) return res.status(400).json({ success: false, error: `bomba "${codigo}" já existe` });
      const r = db.prepare(`
        INSERT INTO posto_bombas (codigo, fabricante, modelo, numeroSerie, ativo)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        codigo,
        b.fabricante ? String(b.fabricante).trim() : null,
        b.modelo ? String(b.modelo).trim() : null,
        b.numeroSerie ? String(b.numeroSerie).trim() : null,
        b.ativo === 0 ? 0 : 1,
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/posto/bombas/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM posto_bombas WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'bomba não encontrada' });
      const b = req.body || {};
      db.prepare(`
        UPDATE posto_bombas SET codigo = ?, fabricante = ?, modelo = ?, numeroSerie = ?, ativo = ?
         WHERE id = ?
      `).run(
        b.codigo !== undefined ? String(b.codigo).trim().toUpperCase() : atual.codigo,
        b.fabricante !== undefined ? (b.fabricante || null) : atual.fabricante,
        b.modelo !== undefined ? (b.modelo || null) : atual.modelo,
        b.numeroSerie !== undefined ? (b.numeroSerie || null) : atual.numeroSerie,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/posto/bombas/:id', gateFlag, (req, res) => {
    try {
      const bicos = db.prepare('SELECT COUNT(*) AS n FROM posto_bicos WHERE bombaId = ?').get(req.params.id);
      if (bicos && bicos.n > 0) {
        return res.status(400).json({ success: false, error: `bomba tem ${bicos.n} bico(s) — remova antes` });
      }
      db.prepare('DELETE FROM posto_bombas WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== LACRES ====================

  app.get('/api/posto/bombas/:id/lacres', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT * FROM posto_lacres WHERE bombaId = ?
         ORDER BY dataAplicacao DESC, id DESC
      `).all(req.params.id);
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/bombas/:id/lacres', gateFlag, (req, res) => {
    try {
      const bomba = db.prepare('SELECT id FROM posto_bombas WHERE id = ?').get(req.params.id);
      if (!bomba) return res.status(404).json({ success: false, error: 'bomba não encontrada' });
      const numero = String(req.body?.numero || '').trim();
      if (!numero) return res.status(400).json({ success: false, error: 'número do lacre é obrigatório' });
      // O lacre alimenta o registro 1360 do SPED: data inventada aqui só
      // aparece como problema na escrituração, meses depois.
      const dtAp = normalizarData(req.body?.dataAplicacao);
      if (!dtAp.ok) return res.status(400).json({ success: false, error: dtAp.erro });
      const r = db.prepare(`
        INSERT INTO posto_lacres (bombaId, numero, dataAplicacao) VALUES (?, ?, ?)
      `).run(req.params.id, numero, dtAp.valor || hojeISO());
      try { logAction(db, req, 'create', 'posto_lacre', r.lastInsertRowid, { bombaId: req.params.id, numero }); } catch (_) { /* */ }
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Romper lacre não apaga a linha: fecha com data e motivo. É exatamente o
  // histórico que o fisco pede (registro 1360 do SPED) e o que explica uma
  // intervenção técnica na bomba.
  app.put('/api/posto/lacres/:id/remover', gateFlag, (req, res) => {
    try {
      const lacre = db.prepare('SELECT * FROM posto_lacres WHERE id = ?').get(req.params.id);
      if (!lacre) return res.status(404).json({ success: false, error: 'lacre não encontrado' });
      if (lacre.dataRemocao) return res.status(400).json({ success: false, error: 'lacre já removido' });
      const dtRem = normalizarData(req.body?.dataRemocao);
      if (!dtRem.ok) return res.status(400).json({ success: false, error: dtRem.erro });
      db.prepare('UPDATE posto_lacres SET dataRemocao = ?, motivoRemocao = ? WHERE id = ?').run(
        dtRem.valor || hojeISO(),
        req.body?.motivoRemocao ? String(req.body.motivoRemocao).trim() : null,
        req.params.id,
      );
      try { logAction(db, req, 'update', 'posto_lacre', req.params.id, { removido: true }); } catch (_) { /* */ }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== BICOS ====================

  app.get('/api/posto/bicos', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT bi.*, b.codigo AS bombaCodigo, t.codigo AS tanqueCodigo,
               c.id AS combustivelId, c.nome AS combustivelNome, c.precoLitro
          FROM posto_bicos bi
          JOIN posto_bombas b ON b.id = bi.bombaId
          JOIN posto_tanques t ON t.id = bi.tanqueId
          JOIN posto_combustiveis c ON c.id = t.combustivelId
         ORDER BY b.codigo ASC, bi.numero ASC
      `).all();
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/bicos', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const numero = String(b.numero || '').trim();
      if (!numero) return res.status(400).json({ success: false, error: 'número é obrigatório' });
      if (!b.bombaId || !b.tanqueId) {
        return res.status(400).json({ success: false, error: 'bomba e tanque são obrigatórios' });
      }
      const dup = db.prepare('SELECT id FROM posto_bicos WHERE numero = ?').get(numero);
      if (dup) return res.status(400).json({ success: false, error: `bico "${numero}" já existe` });
      if (!db.prepare('SELECT id FROM posto_bombas WHERE id = ?').get(b.bombaId)) {
        return res.status(400).json({ success: false, error: 'bomba inexistente' });
      }
      if (!db.prepare('SELECT id FROM posto_tanques WHERE id = ?').get(b.tanqueId)) {
        return res.status(400).json({ success: false, error: 'tanque inexistente' });
      }
      const enc = Number(b.encerranteAtual) || 0;
      if (enc < 0) return res.status(400).json({ success: false, error: 'encerrante não pode ser negativo' });
      const r = db.prepare(`
        INSERT INTO posto_bicos (numero, bombaId, tanqueId, encerranteAtual, ativo)
        VALUES (?, ?, ?, ?, ?)
      `).run(numero, b.bombaId, b.tanqueId, enc, b.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/posto/bicos/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM posto_bicos WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'bico não encontrado' });
      const b = req.body || {};
      // encerranteAtual NÃO entra aqui de propósito: quem o move é o movimento
      // (abastecimento/aferição). Corrigir leitura errada tem rota própria, que
      // registra o ajuste — senão o LMC perde a explicação da diferença.
      if (b.tanqueId !== undefined && Number(b.tanqueId) !== atual.tanqueId) {
        const abast = db.prepare('SELECT COUNT(*) AS n FROM posto_abastecimentos WHERE bicoId = ?').get(req.params.id);
        if (abast && abast.n > 0) {
          return res.status(400).json({
            success: false,
            error: `bico tem ${abast.n} abastecimento(s) — trocar o tanque falsearia o LMC dos dias anteriores`,
          });
        }
      }
      db.prepare(`
        UPDATE posto_bicos SET numero = ?, bombaId = ?, tanqueId = ?, ativo = ? WHERE id = ?
      `).run(
        b.numero !== undefined ? String(b.numero).trim() : atual.numero,
        b.bombaId !== undefined ? b.bombaId : atual.bombaId,
        b.tanqueId !== undefined ? b.tanqueId : atual.tanqueId,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Ajuste manual do encerrante — leitura digitada errada, troca de cabeçote.
  // Existe separado do PUT porque é evento, não edição de cadastro: fica no
  // audit_log e o motivo é obrigatório.
  app.post('/api/posto/bicos/:id/ajustar-encerrante', gateFlag, (req, res) => {
    try {
      const bico = db.prepare('SELECT * FROM posto_bicos WHERE id = ?').get(req.params.id);
      if (!bico) return res.status(404).json({ success: false, error: 'bico não encontrado' });
      const novo = Number(req.body?.encerrante);
      const motivo = String(req.body?.motivo || '').trim();
      if (!Number.isFinite(novo) || novo < 0) {
        return res.status(400).json({ success: false, error: 'encerrante inválido' });
      }
      if (!motivo) return res.status(400).json({ success: false, error: 'motivo é obrigatório' });
      db.prepare('UPDATE posto_bicos SET encerranteAtual = ? WHERE id = ?').run(novo, req.params.id);
      try {
        logAction(db, req, 'update', 'posto_bico_encerrante', req.params.id,
          { de: bico.encerranteAtual, para: novo, motivo });
      } catch (_) { /* */ }
      res.json({ success: true, de: bico.encerranteAtual, para: novo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/posto/bicos/:id', gateFlag, (req, res) => {
    try {
      const abast = db.prepare('SELECT COUNT(*) AS n FROM posto_abastecimentos WHERE bicoId = ?').get(req.params.id);
      if (abast && abast.n > 0) {
        return res.status(400).json({
          success: false,
          error: `bico tem ${abast.n} abastecimento(s) no histórico — desative em vez de excluir`,
          sugestao: 'desativar',
        });
      }
      db.prepare('DELETE FROM posto_bicos WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fases seguintes do módulo, reaproveitando o mesmo gateFlag.
  registrarRotasPostoMovimento(app, db, gateFlag);
  registrarRotasPostoLmc(app, db, gateFlag);

  console.log('[posto] Rotas registradas');
}

// Datas em horário de Brasília: o LMC é um livro DIÁRIO e o dia tem de ser o do
// posto, não o UTC do servidor — senão todo movimento depois das 21h cai no dia
// seguinte no livro.
function hojeISO() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function agoraISO() {
  return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

module.exports = { registrarRotasPosto, getFlag, lerConfig, hojeISO, agoraISO };
