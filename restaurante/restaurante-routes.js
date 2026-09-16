/**
 * restaurante-routes.js — Módulo Restaurante, fase 0: fundação.
 *
 * Cadastros de base do salão (áreas, mesas, setores de produção) e a
 * configuração do módulo. As fases seguintes penduram cardápio, comanda,
 * KDS, fechamento e delivery em cima disto.
 *
 * Feature flag por-tenant em config('restaurante_enabled'). Quando off,
 * /api/restaurante/* devolve 403 com error:'restaurante_disabled' — mesmo
 * contrato do módulo Ótica. O module-gate do plano é uma segunda camada,
 * anterior a esta (plano não contratado nem chega aqui).
 *
 * Config do módulo mora na tabela `config` com prefixo `restaurante_`:
 *   restaurante_taxa_servico_pct    percentual sugerido (default 10)
 *   restaurante_taxa_servico_prod   produtoId da taxa de serviço na NFC-e
 *   restaurante_couvert_prod        produtoId do couvert artístico
 *   restaurante_modo                alacarte | quilo | fastfood | bar | delivery
 *   restaurante_pesavel_layout      valor | peso (layout da etiqueta da balanca)
 */

const { logAction } = require('../audit-log');
const { initRestauranteSchema } = require('./restaurante-schema');
const { registrarRotasCardapio, cardapioVigente } = require('./restaurante-cardapio');
const { registrarRotasComanda } = require('./restaurante-comanda');
const { registrarRotasKds } = require('./restaurante-kds');
const { registrarRotasFechamento } = require('./restaurante-fechamento');
const { registrarRotasBalanca } = require('./restaurante-balanca');
const { registrarRotasDelivery } = require('./restaurante-delivery');
const { registrarRotasAceite } = require('./cardapio-publico-routes');
const { registrarRotasIfood } = require('./ifood-routes');
const { registrarRotasFicha } = require('./restaurante-ficha');
const { registrarRotasIndicadores } = require('./restaurante-indicadores');
const { registrarRotasGorjeta } = require('./restaurante-gorjeta');

const CONFIG_DEFAULTS = {
  restaurante_taxa_servico_pct: '10',
  restaurante_taxa_servico_prod: '',
  restaurante_couvert_prod: '',
  restaurante_modo: 'alacarte',
  // Layout do EAN-13 da balanca etiquetadora: 'valor' (5 digitos = centavos)
  // ou 'peso' (5 digitos = gramas). Nao da para inferir do codigo — ver
  // restaurante-balanca.js.
  restaurante_pesavel_layout: 'valor',
  // Canal publico (QR Code). Desligado por padrao: publicar o cardapio na
  // internet e decisao do lojista, nao efeito colateral de ativar o modulo.
  restaurante_cardapio_publico: '0',
  restaurante_aceita_pedido_online: '0',
  restaurante_nome_publico: '',
  // Gorjeta (Lei 13.419/2017). O teto de retencao para encargos depende do
  // regime: 20% no Simples, 33% nos demais — ver restaurante-gorjeta.js.
  restaurante_regime_tributario: 'simples',
  restaurante_gorjeta_retencao_pct: '0',
  restaurante_gorjeta_criterio: 'igual',
};

const MODOS_VALIDOS = ['alacarte', 'quilo', 'fastfood', 'bar', 'delivery'];

function getFlag(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'restaurante_enabled'").get();
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

function registrarRotasRestaurante(app, db) {
  initRestauranteSchema(db);

  // Em multi-tenant o db acima é o BOOT_STUB e a migração foi no-op. O schema
  // real de cada tenant vem do db-schema.js; este hook cobre o tenant que
  // ainda não passou por um boot completo (mesmo padrão do módulo Ótica).
  const tenantsMigrados = new WeakSet();
  app.use('/api/restaurante', (req, res, next) => {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        initRestauranteSchema(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Read-only e SEM gate: a sidebar precisa saber se mostra o módulo.
  app.get('/api/restaurante/status', (req, res) => {
    res.json({ success: true, enabled: getFlag(db) });
  });

  function gateFlag(req, res, next) {
    if (!getFlag(db)) {
      return res.status(403).json({ success: false, error: 'restaurante_disabled' });
    }
    next();
  }

  // ==================== CONFIG ====================

  app.get('/api/restaurante/config', gateFlag, (req, res) => {
    try {
      res.json({ success: true, config: lerConfig(db), modos: MODOS_VALIDOS });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/restaurante/config', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      if (b.restaurante_modo && !MODOS_VALIDOS.includes(b.restaurante_modo)) {
        return res.status(400).json({ success: false, error: 'modo inválido' });
      }
      if (b.restaurante_pesavel_layout && !['valor', 'peso'].includes(b.restaurante_pesavel_layout)) {
        return res.status(400).json({ success: false, error: 'layout da balança deve ser "valor" ou "peso"' });
      }
      if (b.restaurante_regime_tributario
          && !['simples', 'normal'].includes(b.restaurante_regime_tributario)) {
        return res.status(400).json({ success: false, error: 'regime deve ser "simples" ou "normal"' });
      }
      if (b.restaurante_gorjeta_retencao_pct != null) {
        // O teto legal é validado no rateio (é lá que o regime vale); aqui só
        // barramos valor absurdo.
        const rp = Number(b.restaurante_gorjeta_retencao_pct);
        if (!Number.isFinite(rp) || rp < 0 || rp > 33) {
          return res.status(400).json({ success: false, error: 'retenção deve ficar entre 0% e 33%' });
        }
      }
      if (b.restaurante_taxa_servico_pct != null) {
        const pct = Number(b.restaurante_taxa_servico_pct);
        // Acima de 10% a gorjeta perde a exclusão da base do ICMS; não é
        // proibido cobrar, mas o tratamento fiscal deixa de ser o do item
        // isento — por isso o teto aqui.
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ success: false, error: 'percentual inválido' });
        }
      }
      const tx = db.transaction(() => {
        for (const chave of Object.keys(CONFIG_DEFAULTS)) {
          if (b[chave] !== undefined) gravarConfig(db, chave, b[chave]);
        }
      });
      tx();
      try { logAction(db, req, 'update', 'restaurante_config', null, b); } catch (_) { /* */ }
      res.json({ success: true, config: lerConfig(db) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ÁREAS ====================

  app.get('/api/restaurante/areas', gateFlag, (req, res) => {
    try {
      const items = db.prepare(
        'SELECT * FROM rest_areas ORDER BY ordem ASC, nome ASC'
      ).all();
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/restaurante/areas', gateFlag, (req, res) => {
    try {
      const nome = String(req.body?.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome é obrigatório' });
      const r = db.prepare('INSERT INTO rest_areas (nome, ordem, ativo) VALUES (?, ?, ?)')
        .run(nome, Number(req.body?.ordem) || 0, req.body?.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/restaurante/areas/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_areas WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'área não encontrada' });
      const b = req.body || {};
      db.prepare('UPDATE rest_areas SET nome = ?, ordem = ?, ativo = ? WHERE id = ?').run(
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.ordem !== undefined ? Number(b.ordem) : atual.ordem,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/restaurante/areas/:id', gateFlag, (req, res) => {
    try {
      const emUso = db.prepare('SELECT COUNT(*) AS n FROM rest_mesas WHERE areaId = ?').get(req.params.id);
      if (emUso && emUso.n > 0) {
        return res.status(400).json({ success: false, error: `área tem ${emUso.n} mesa(s) — mova ou remova antes` });
      }
      db.prepare('DELETE FROM rest_areas WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== MESAS ====================

  app.get('/api/restaurante/mesas', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT m.*, a.nome AS areaNome
          FROM rest_mesas m
          LEFT JOIN rest_areas a ON a.id = m.areaId
         ORDER BY CAST(m.numero AS INTEGER) ASC, m.numero ASC
      `).all();
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/restaurante/mesas', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const numero = String(b.numero || '').trim();
      if (!numero) return res.status(400).json({ success: false, error: 'número é obrigatório' });
      const dup = db.prepare('SELECT id FROM rest_mesas WHERE numero = ?').get(numero);
      if (dup) return res.status(400).json({ success: false, error: `mesa ${numero} já existe` });
      const r = db.prepare(`
        INSERT INTO rest_mesas (areaId, numero, capacidade, posX, posY, ativo)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        b.areaId || null, numero,
        Number(b.capacidade) || 4,
        Number(b.posX) || 0, Number(b.posY) || 0,
        b.ativo === 0 ? 0 : 1,
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Criação em lote: ninguém cadastra 30 mesas uma a uma.
  app.post('/api/restaurante/mesas/lote', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const de = Number(b.de), ate = Number(b.ate);
      if (!Number.isInteger(de) || !Number.isInteger(ate) || de < 1 || ate < de) {
        return res.status(400).json({ success: false, error: 'faixa inválida' });
      }
      if (ate - de > 500) return res.status(400).json({ success: false, error: 'faixa máxima de 500 mesas' });
      const capacidade = Number(b.capacidade) || 4;
      const areaId = b.areaId || null;
      const existentes = new Set(
        db.prepare('SELECT numero FROM rest_mesas').all().map(m => m.numero)
      );
      const ins = db.prepare(
        'INSERT INTO rest_mesas (areaId, numero, capacidade, ativo) VALUES (?, ?, ?, 1)'
      );
      let criadas = 0, puladas = 0;
      const tx = db.transaction(() => {
        for (let n = de; n <= ate; n++) {
          if (existentes.has(String(n))) { puladas++; continue; }
          ins.run(areaId, String(n), capacidade);
          criadas++;
        }
      });
      tx();
      res.json({ success: true, criadas, puladas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/restaurante/mesas/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_mesas WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'mesa não encontrada' });
      const b = req.body || {};
      if (b.numero !== undefined) {
        const novo = String(b.numero).trim();
        const dup = db.prepare('SELECT id FROM rest_mesas WHERE numero = ? AND id <> ?').get(novo, req.params.id);
        if (dup) return res.status(400).json({ success: false, error: `mesa ${novo} já existe` });
      }
      db.prepare(`
        UPDATE rest_mesas SET areaId = ?, numero = ?, capacidade = ?, posX = ?, posY = ?, ativo = ?
         WHERE id = ?
      `).run(
        b.areaId !== undefined ? (b.areaId || null) : atual.areaId,
        b.numero !== undefined ? String(b.numero).trim() : atual.numero,
        b.capacidade !== undefined ? Number(b.capacidade) : atual.capacidade,
        b.posX !== undefined ? Number(b.posX) : atual.posX,
        b.posY !== undefined ? Number(b.posY) : atual.posY,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Mesa que já atendeu NÃO se exclui: a comanda é histórico fiscal e gerencial,
  // e apagar a mesa levaria o vínculo junto. Nesse caso a saída é desativar
  // (some do salão, o histórico fica). Sem esta checagem o usuário receberia
  // "FOREIGN KEY constraint failed", que não explica nada.
  app.delete('/api/restaurante/mesas/:id', gateFlag, (req, res) => {
    try {
      const aberta = db.prepare(
        "SELECT COUNT(*) AS n FROM rest_comandas WHERE mesaId = ? AND status = 'aberta'"
      ).get(req.params.id);
      if (aberta && aberta.n > 0) {
        return res.status(400).json({ success: false, error: 'mesa tem comanda aberta' });
      }
      const historico = db.prepare('SELECT COUNT(*) AS n FROM rest_comandas WHERE mesaId = ?').get(req.params.id);
      if (historico && historico.n > 0) {
        return res.status(400).json({
          success: false,
          error: `mesa tem ${historico.n} comanda(s) no histórico — desative em vez de excluir`,
          sugestao: 'desativar',
        });
      }
      db.prepare('DELETE FROM rest_mesas WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== SETORES DE PRODUÇÃO ====================

  app.get('/api/restaurante/setores', gateFlag, (req, res) => {
    try {
      const items = db.prepare('SELECT * FROM rest_setores ORDER BY ordem ASC, nome ASC').all();
      res.json({ success: true, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/restaurante/setores', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const nome = String(b.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome é obrigatório' });
      const codigo = String(b.codigo || nome).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const dup = db.prepare('SELECT id FROM rest_setores WHERE codigo = ?').get(codigo);
      if (dup) return res.status(400).json({ success: false, error: `setor "${codigo}" já existe` });
      const r = db.prepare('INSERT INTO rest_setores (codigo, nome, ordem, ativo) VALUES (?, ?, ?, ?)')
        .run(codigo, nome, Number(b.ordem) || 0, b.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid, codigo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/restaurante/setores/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_setores WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'setor não encontrado' });
      const b = req.body || {};
      db.prepare('UPDATE rest_setores SET nome = ?, ordem = ?, ativo = ? WHERE id = ?').run(
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.ordem !== undefined ? Number(b.ordem) : atual.ordem,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/restaurante/setores/:id', gateFlag, (req, res) => {
    try {
      const emUso = db.prepare('SELECT COUNT(*) AS n FROM rest_produto_config WHERE setorId = ?').get(req.params.id);
      if (emUso && emUso.n > 0) {
        return res.status(400).json({ success: false, error: `setor usado por ${emUso.n} produto(s)` });
      }
      db.prepare('DELETE FROM rest_setores WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fases seguintes penduram aqui, reaproveitando o mesmo gateFlag.
  registrarRotasCardapio(app, db, gateFlag);
  registrarRotasComanda(app, db, gateFlag, { cardapioVigente, lerConfig });
  registrarRotasKds(app, db, gateFlag);
  registrarRotasFechamento(app, db, gateFlag, { lerConfig });
  registrarRotasBalanca(app, db, gateFlag, { lerConfig });
  registrarRotasDelivery(app, db, gateFlag);
  registrarRotasAceite(app, db, gateFlag);
  registrarRotasIfood(app, db, gateFlag);
  registrarRotasFicha(app, db, gateFlag);
  registrarRotasIndicadores(app, db, gateFlag);
  registrarRotasGorjeta(app, db, gateFlag, { lerConfig });

  console.log('[restaurante] Rotas registradas');
}

module.exports = { registrarRotasRestaurante, getFlag, lerConfig, MODOS_VALIDOS };
