/**
 * crm-routes.js — CRM funil de vendas + atividades.
 *
 * Modelos:
 *   crm_funis           — funis configuráveis (default: Vendas)
 *   crm_etapas          — etapas dentro de cada funil (com tipo: 'normal'|'ganho'|'perdido')
 *   crm_oportunidades   — leads/negócios com cliente, vendedor, valor, etapa
 *   crm_atividades      — ligação/email/reunião/visita/tarefa/whatsapp por oportunidade
 */

const { logAction } = require('./audit-log');

const TIPOS_ATIV = new Set(['ligacao','email','reuniao','visita','tarefa','whatsapp']);
const FONTES = ['site', 'indicacao', 'redes-sociais', 'whatsapp', 'evento', 'inbound', 'outbound', 'licitacao', 'outros'];
const FUNIL_LICITACOES_NOME = 'Licitações';

// Mapeia status do kanban antigo para a ordem da etapa no funil Licitações.
// Fallback para 'analise' (primeira etapa) se status desconhecido.
const KANBAN_STATUS_TO_ETAPA_ORDEM = {
  analise: 1,
  proposta: 2,
  enviada: 3,
  vencida: 5  // "Encerrada sem ganho" — safe default; user move para "Ganha" se foi vencedor
};

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_funis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      descricao TEXT,
      ordem INTEGER DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS crm_etapas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      funilId INTEGER NOT NULL,
      nome TEXT NOT NULL,
      ordem INTEGER NOT NULL,
      cor TEXT,
      tipo TEXT NOT NULL DEFAULT 'normal',  -- normal | ganho | perdido
      ativo INTEGER DEFAULT 1,
      FOREIGN KEY (funilId) REFERENCES crm_funis(id)
    );
    CREATE INDEX IF NOT EXISTS idx_etapas_funil ON crm_etapas(funilId, ordem);

    CREATE TABLE IF NOT EXISTS crm_oportunidades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      funilId INTEGER NOT NULL,
      etapaId INTEGER NOT NULL,
      clienteId INTEGER,
      vendedorId INTEGER,
      titulo TEXT NOT NULL,
      descricao TEXT,
      valor REAL DEFAULT 0,
      probabilidade INTEGER DEFAULT 50,
      fonte TEXT,
      dataAbertura TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dataPrevisaoFechamento TEXT,
      dataFechamento TEXT,
      motivoPerda TEXT,
      pedidoId INTEGER,
      ativo INTEGER DEFAULT 1,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (funilId) REFERENCES crm_funis(id),
      FOREIGN KEY (etapaId) REFERENCES crm_etapas(id),
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (vendedorId) REFERENCES users(id),
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_op_funil_etapa ON crm_oportunidades(funilId, etapaId, ativo);
    CREATE INDEX IF NOT EXISTS idx_op_cliente ON crm_oportunidades(clienteId);
    CREATE INDEX IF NOT EXISTS idx_op_vendedor ON crm_oportunidades(vendedorId);

    CREATE TABLE IF NOT EXISTS crm_atividades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      oportunidadeId INTEGER,
      clienteId INTEGER,
      tipo TEXT NOT NULL,  -- ligacao|email|reuniao|visita|tarefa|whatsapp
      titulo TEXT NOT NULL,
      descricao TEXT,
      dataHora TEXT NOT NULL,
      concluida INTEGER DEFAULT 0,
      dataConclusao TEXT,
      resultadoNota TEXT,
      usuarioId INTEGER,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (oportunidadeId) REFERENCES crm_oportunidades(id) ON DELETE CASCADE,
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (usuarioId) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_ativ_op ON crm_atividades(oportunidadeId, dataHora);
    CREATE INDEX IF NOT EXISTS idx_ativ_cliente ON crm_atividades(clienteId, dataHora);
    CREATE INDEX IF NOT EXISTS idx_ativ_pendentes ON crm_atividades(usuarioId, concluida, dataHora);

    CREATE TABLE IF NOT EXISTS crm_oportunidade_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      oportunidadeId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      quantidade REAL NOT NULL DEFAULT 1,
      precoUnitario REAL NOT NULL DEFAULT 0,
      desconto REAL NOT NULL DEFAULT 0,
      observacao TEXT,
      ordem INTEGER DEFAULT 0,
      FOREIGN KEY (oportunidadeId) REFERENCES crm_oportunidades(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_op_itens_op ON crm_oportunidade_itens(oportunidadeId);
    CREATE INDEX IF NOT EXISTS idx_op_itens_produto ON crm_oportunidade_itens(produtoId);
  `);

  // Seed funil padrão "Vendas" se não houver nenhum
  const temFunil = db.prepare('SELECT id FROM crm_funis LIMIT 1').get();
  if (!temFunil) {
    const r = db.prepare('INSERT INTO crm_funis (nome, descricao, ordem) VALUES (?, ?, 0)').run('Vendas', 'Funil padrão de vendas');
    const fid = r.lastInsertRowid;
    const stmt = db.prepare('INSERT INTO crm_etapas (funilId, nome, ordem, cor, tipo) VALUES (?, ?, ?, ?, ?)');
    [
      ['Lead',         1, '#9aa', 'normal'],
      ['Qualificado',  2, '#5b9', 'normal'],
      ['Proposta',     3, '#fa3', 'normal'],
      ['Negociação',   4, '#f80', 'normal'],
      ['Ganho',        5, '#3a3', 'ganho'],
      ['Perdido',      6, '#a33', 'perdido']
    ].forEach(([n,o,c,t]) => stmt.run(fid, n, o, c, t));
  }

  // Nome de cliente "avulso": preenchido quando a oportunidade não aponta para
  // uma pessoa cadastrada (clienteId nulo). Fica só no card, não vira cliente.
  alterSafe(db, 'ALTER TABLE crm_oportunidades ADD COLUMN clienteNomeLivre TEXT');

  // Ordem manual dos cards dentro de cada etapa (drag-drop de reordenação).
  // Menor = mais ao topo. Cards nunca reordenados ficam em 0 e caem no
  // desempate por dataAtualizacao (preserva o comportamento antigo).
  alterSafe(db, 'ALTER TABLE crm_oportunidades ADD COLUMN ordemManual INTEGER NOT NULL DEFAULT 0');

  // Etapa configurável: ao mover um card PARA esta etapa, abrir um agendamento
  // (crm_atividade com data/hora) vinculado ao cliente da oportunidade.
  alterSafe(db, 'ALTER TABLE crm_etapas ADD COLUMN geraAgendamento INTEGER NOT NULL DEFAULT 0');

  // Colunas para vincular oportunidade à licitação (unifica kanban → CRM)
  alterSafe(db, 'ALTER TABLE crm_oportunidades ADD COLUMN licitacaoCnpj TEXT');
  alterSafe(db, 'ALTER TABLE crm_oportunidades ADD COLUMN licitacaoAno INTEGER');
  alterSafe(db, 'ALTER TABLE crm_oportunidades ADD COLUMN licitacaoSequencial INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_op_licitacao ON crm_oportunidades(licitacaoCnpj, licitacaoAno, licitacaoSequencial);`);

  // Seed funil "Licitações" (idempotente) — unificação do antigo kanban.html
  let funilLic = db.prepare('SELECT id FROM crm_funis WHERE nome = ?').get(FUNIL_LICITACOES_NOME);
  if (!funilLic) {
    const r = db.prepare('INSERT INTO crm_funis (nome, descricao, ordem) VALUES (?, ?, 1)')
      .run(FUNIL_LICITACOES_NOME, 'Acompanhamento de licitações públicas (substitui o antigo Kanban)');
    const fid = r.lastInsertRowid;
    const stmt = db.prepare('INSERT INTO crm_etapas (funilId, nome, ordem, cor, tipo) VALUES (?, ?, ?, ?, ?)');
    [
      ['Em Análise',             1, '#64748b', 'normal'],
      ['Preparando Proposta',    2, '#f59e0b', 'normal'],
      ['Proposta Enviada',       3, '#3b82f6', 'normal'],
      ['Ganha',                  4, '#10b981', 'ganho'],
      ['Encerrada sem ganho',    5, '#ef4444', 'perdido']
    ].forEach(([n,o,c,t]) => stmt.run(fid, n, o, c, t));
    funilLic = { id: fid };
  }

  // Migração idempotente: kanban_status → crm_oportunidades no funil Licitações
  // Só migra linhas que ainda não têm oportunidade correspondente.
  try {
    const temKanban = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='kanban_status'`).get();
    if (temKanban) {
      const etapas = db.prepare('SELECT id, ordem FROM crm_etapas WHERE funilId = ? ORDER BY ordem').all(funilLic.id);
      const etapaByOrdem = Object.fromEntries(etapas.map(e => [e.ordem, e.id]));
      const kanbanRows = db.prepare(`
        SELECT k.cnpj, k.ano, k.sequencial, k.status, k.observacao,
               l.objetoCompra, l.razaoSocial as nomeOrgao,
               l.dataEncerramentoProposta, l.numeroCompra, l.valorTotalEstimado
        FROM kanban_status k
        LEFT JOIN licitacoes l ON k.cnpj = l.cnpj AND k.ano = l.anoCompra AND k.sequencial = l.sequencialCompra
      `).all();
      const insertOp = db.prepare(`
        INSERT INTO crm_oportunidades
          (funilId, etapaId, titulo, descricao, valor, probabilidade, fonte,
           licitacaoCnpj, licitacaoAno, licitacaoSequencial, dataPrevisaoFechamento)
        VALUES (?, ?, ?, ?, ?, 50, 'licitacao', ?, ?, ?, ?)
      `);
      const existeOp = db.prepare(`
        SELECT id FROM crm_oportunidades
        WHERE licitacaoCnpj = ? AND licitacaoAno = ? AND licitacaoSequencial = ? AND ativo = 1
      `);
      let migrados = 0;
      for (const k of kanbanRows) {
        if (existeOp.get(k.cnpj, k.ano, k.sequencial)) continue;
        const ordem = KANBAN_STATUS_TO_ETAPA_ORDEM[k.status] || 1;
        const etapaId = etapaByOrdem[ordem] || etapas[0]?.id;
        if (!etapaId) continue;
        const titulo = k.numeroCompra
          ? `${k.numeroCompra} — ${(k.nomeOrgao || '').slice(0, 60)}`
          : `Licitação ${k.cnpj}/${k.ano}/${k.sequencial}`;
        const descricao = [k.objetoCompra, k.observacao].filter(Boolean).join('\n\n');
        insertOp.run(
          funilLic.id, etapaId,
          titulo.slice(0, 200),
          descricao || null,
          Number(k.valorTotalEstimado) || 0,
          k.cnpj, Number(k.ano), Number(k.sequencial),
          k.dataEncerramentoProposta || null
        );
        migrados++;
      }
      if (migrados > 0) console.log(`[CRM] Migradas ${migrados} licitações do kanban para o funil Licitações.`);
    }
  } catch (err) {
    console.error('[CRM] Erro na migração kanban→CRM:', err.message);
  }
}

// Fase 3g (2026-05-23): SELECT licitacoes via PG quando flag ativa
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

function registrarRotasCrm(app, db) {
  migrarDB(db);

  // Migração lazy por-tenant: registrarRotasCrm roda em contexto BOOT
  // (proxy é no-op), então tenants provisionados antes do CRM podem
  // não ter as tabelas. Garante criação na 1ª chamada por-tenant.
  const tenantsMigrados = new WeakSet();
  function ensureMigrated() {
    const real = db.__real;
    if (!real || tenantsMigrados.has(real)) return;
    migrarDB(db);
    tenantsMigrados.add(real);
  }

  // Itens de produto vinculados à oportunidade. Subtotal = qtd * precoUnit - desconto.
  // Helper roda dentro de uma transaction externa (não abre uma própria).
  function replaceItensOportunidade(opId, items) {
    db.prepare('DELETE FROM crm_oportunidade_itens WHERE oportunidadeId = ?').run(opId);
    if (!Array.isArray(items) || !items.length) return 0;
    const stmt = db.prepare(`
      INSERT INTO crm_oportunidade_itens
        (oportunidadeId, produtoId, quantidade, precoUnitario, desconto, observacao, ordem)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let total = 0;
    items.forEach((it, idx) => {
      const produtoId = Number(it.produtoId);
      if (!produtoId) return;
      const qtd = Number(it.quantidade) || 0;
      const preco = Number(it.precoUnitario) || 0;
      const desc = Number(it.desconto) || 0;
      stmt.run(opId, produtoId, qtd, preco, desc, it.observacao || null, Number(it.ordem) || idx);
      total += qtd * preco - desc;
    });
    return total;
  }

  function listarItensOportunidade(opId) {
    return db.prepare(`
      SELECT i.*, p.sku, p.descricao AS produtoDescricao, p.unidade
      FROM crm_oportunidade_itens i
      JOIN produtos p ON p.id = i.produtoId
      WHERE i.oportunidadeId = ?
      ORDER BY i.ordem, i.id
    `).all(opId);
  }

  // ==================== FUNIS ====================

  app.get('/api/crm/funis', (req, res) => {
    try {
      ensureMigrated();
      const funis = db.prepare('SELECT * FROM crm_funis WHERE ativo = 1 ORDER BY ordem, nome').all();
      const stmtEtapas = db.prepare('SELECT * FROM crm_etapas WHERE funilId = ? AND ativo = 1 ORDER BY ordem');
      for (const f of funis) f.etapas = stmtEtapas.all(f.id);
      res.json({ success: true, funis, fontes: FONTES, tiposAtividade: [...TIPOS_ATIV] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cria um novo funil já com etapas padrão (senão não dá pra usar).
  app.post('/api/crm/funis', (req, res) => {
    try {
      ensureMigrated();
      const nome = (req.body.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      if (db.prepare('SELECT id FROM crm_funis WHERE nome = ? AND ativo = 1').get(nome)) {
        return res.status(409).json({ success: false, error: 'Já existe um funil com esse nome' });
      }
      const ordem = (db.prepare('SELECT MAX(ordem) m FROM crm_funis').get().m || 0) + 1;
      const funilId = db.transaction(() => {
        const r = db.prepare('INSERT INTO crm_funis (nome, descricao, ordem) VALUES (?, ?, ?)')
          .run(nome, (req.body.descricao || '').trim() || null, ordem);
        const fid = r.lastInsertRowid;
        const stmt = db.prepare('INSERT INTO crm_etapas (funilId, nome, ordem, cor, tipo) VALUES (?, ?, ?, ?, ?)');
        [['Novo', 1, '#64748b', 'normal'], ['Ganho', 2, '#3a3', 'ganho'], ['Perdido', 3, '#a33', 'perdido']]
          .forEach(([n,o,c,t]) => stmt.run(fid, n, o, c, t));
        return fid;
      })();
      logAction(db, req, 'criar', 'crm-funil', funilId, { nome });
      const funil = db.prepare('SELECT * FROM crm_funis WHERE id = ?').get(funilId);
      funil.etapas = db.prepare('SELECT * FROM crm_etapas WHERE funilId = ? AND ativo = 1 ORDER BY ordem').all(funilId);
      res.json({ success: true, funil });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/crm/funis/:id', (req, res) => {
    try {
      const funil = db.prepare('SELECT * FROM crm_funis WHERE id = ?').get(req.params.id);
      if (!funil) return res.status(404).json({ success: false, error: 'Funil não encontrado' });
      const sets = [], vals = [];
      if (req.body.nome !== undefined) {
        const nome = (req.body.nome || '').trim();
        if (!nome) return res.status(400).json({ success: false, error: 'nome não pode ficar vazio' });
        const dup = db.prepare('SELECT id FROM crm_funis WHERE nome = ? AND ativo = 1 AND id <> ?').get(nome, funil.id);
        if (dup) return res.status(409).json({ success: false, error: 'Já existe um funil com esse nome' });
        sets.push('nome = ?'); vals.push(nome);
      }
      if (req.body.descricao !== undefined) { sets.push('descricao = ?'); vals.push((req.body.descricao || '').trim() || null); }
      if (req.body.ordem !== undefined)     { sets.push('ordem = ?');     vals.push(Number(req.body.ordem) || 0); }
      if (!sets.length) return res.json({ success: true, funil });
      vals.push(funil.id);
      db.prepare(`UPDATE crm_funis SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'crm-funil', funil.id, req.body);
      res.json({ success: true, funil: db.prepare('SELECT * FROM crm_funis WHERE id = ?').get(funil.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Soft-delete do funil (com suas etapas). Bloqueia se houver oportunidades ativas
  // ou se for o último funil.
  app.delete('/api/crm/funis/:id', (req, res) => {
    try {
      const funil = db.prepare('SELECT * FROM crm_funis WHERE id = ? AND ativo = 1').get(req.params.id);
      if (!funil) return res.status(404).json({ success: false, error: 'Funil não encontrado' });
      const totalFunis = db.prepare('SELECT COUNT(*) c FROM crm_funis WHERE ativo = 1').get().c;
      if (totalFunis <= 1) return res.status(400).json({ success: false, error: 'Não é possível excluir o único funil existente' });
      const ops = db.prepare('SELECT COUNT(*) c FROM crm_oportunidades WHERE funilId = ? AND ativo = 1').get(funil.id).c;
      if (ops > 0) return res.status(400).json({ success: false, error: `O funil tem ${ops} oportunidade(s) ativa(s). Mova ou exclua antes de remover o funil.` });
      db.transaction(() => {
        db.prepare('UPDATE crm_etapas SET ativo = 0 WHERE funilId = ?').run(funil.id);
        db.prepare('UPDATE crm_funis SET ativo = 0 WHERE id = ?').run(funil.id);
      })();
      logAction(db, req, 'arquivar', 'crm-funil', funil.id, { nome: funil.nome });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ETAPAS ====================

  app.post('/api/crm/etapas', (req, res) => {
    try {
      const { funilId, nome, ordem, cor, tipo, geraAgendamento } = req.body;
      if (!funilId || !nome) return res.status(400).json({ success: false, error: 'funilId e nome obrigatórios' });
      const r = db.prepare('INSERT INTO crm_etapas (funilId, nome, ordem, cor, tipo, geraAgendamento) VALUES (?, ?, ?, ?, ?, ?)')
        .run(funilId, nome, ordem || 99, cor || null, tipo || 'normal', geraAgendamento ? 1 : 0);
      logAction(db, req, 'criar', 'crm-etapa', r.lastInsertRowid, { funilId, nome });
      res.json({ success: true, etapa: db.prepare('SELECT * FROM crm_etapas WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/crm/etapas/:id', (req, res) => {
    try {
      const { nome, ordem, cor, tipo, ativo, geraAgendamento } = req.body;
      const sets = [], vals = [];
      if (nome !== undefined)  { sets.push('nome = ?');  vals.push(nome); }
      if (ordem !== undefined) { sets.push('ordem = ?'); vals.push(ordem); }
      if (cor !== undefined)   { sets.push('cor = ?');   vals.push(cor); }
      if (tipo !== undefined)  { sets.push('tipo = ?');  vals.push(tipo); }
      if (ativo !== undefined) { sets.push('ativo = ?'); vals.push(ativo ? 1 : 0); }
      if (geraAgendamento !== undefined) { sets.push('geraAgendamento = ?'); vals.push(geraAgendamento ? 1 : 0); }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE crm_etapas SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'crm-etapa', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== OPORTUNIDADES ====================

  app.get('/api/crm/oportunidades', (req, res) => {
    try {
      const { funilId, etapaId, clienteId, vendedorId, status, q } = req.query;
      let sql = `SELECT o.*, COALESCE(p.razaoSocial, o.clienteNomeLivre) AS clienteNome, p.telefone AS clienteTelefone, u.username AS vendedorNome,
                        e.nome AS etapaNome, e.cor AS etapaCor, e.tipo AS etapaTipo,
                        (SELECT COUNT(*) FROM crm_oportunidade_itens i WHERE i.oportunidadeId = o.id) AS itensCount
                 FROM crm_oportunidades o
                 LEFT JOIN pessoas p ON p.id = o.clienteId
                 LEFT JOIN users u ON u.id = o.vendedorId
                 JOIN crm_etapas e ON e.id = o.etapaId
                 WHERE o.ativo = 1`;
      const params = [];
      if (funilId)    { sql += ' AND o.funilId = ?';    params.push(Number(funilId)); }
      if (etapaId)    { sql += ' AND o.etapaId = ?';    params.push(Number(etapaId)); }
      if (clienteId)  { sql += ' AND o.clienteId = ?';  params.push(Number(clienteId)); }
      if (vendedorId) { sql += ' AND o.vendedorId = ?'; params.push(Number(vendedorId)); }
      if (status === 'aberta') sql += ` AND e.tipo = 'normal'`;
      if (status === 'ganha')  sql += ` AND e.tipo = 'ganho'`;
      if (status === 'perdida') sql += ` AND e.tipo = 'perdido'`;
      if (q) { sql += ' AND (o.titulo LIKE ? OR p.razaoSocial LIKE ? OR o.clienteNomeLivre LIKE ?)'; const like = `%${q}%`; params.push(like, like, like); }
      sql += ' ORDER BY o.ordemManual ASC, o.dataAtualizacao DESC LIMIT 1000';
      const oportunidades = db.prepare(sql).all(...params);
      res.json({ success: true, oportunidades });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/crm/oportunidades/:id', (req, res) => {
    try {
      const op = db.prepare(`
        SELECT o.*, COALESCE(p.razaoSocial, o.clienteNomeLivre) AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
               p.email AS clienteEmail, p.telefone AS clienteTelefone,
               u.username AS vendedorNome,
               e.nome AS etapaNome, e.cor AS etapaCor, e.tipo AS etapaTipo,
               f.nome AS funilNome
        FROM crm_oportunidades o
        LEFT JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users u ON u.id = o.vendedorId
        JOIN crm_etapas e ON e.id = o.etapaId
        JOIN crm_funis f ON f.id = o.funilId
        WHERE o.id = ?
      `).get(req.params.id);
      if (!op) return res.status(404).json({ success: false, error: 'Oportunidade não encontrada' });
      const atividades = db.prepare(`
        SELECT a.*, u.username AS usuarioNome
        FROM crm_atividades a
        LEFT JOIN users u ON u.id = a.usuarioId
        WHERE a.oportunidadeId = ?
        ORDER BY a.dataHora DESC, a.id DESC
      `).all(op.id);
      const itens = listarItensOportunidade(op.id);
      res.json({ success: true, oportunidade: op, atividades, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/crm/oportunidades', (req, res) => {
    try {
      const { funilId, etapaId, clienteId, vendedorId, titulo, descricao,
              valor, probabilidade, fonte, dataPrevisaoFechamento, itens } = req.body;
      if (!titulo) return res.status(400).json({ success: false, error: 'titulo obrigatório' });
      // Cliente avulso só quando NÃO há cliente cadastrado vinculado.
      const clienteNomeLivre = clienteId ? null : ((req.body.clienteNomeLivre || '').trim() || null);

      // Funil/etapa default
      let fid = funilId;
      let eid = etapaId;
      if (!fid) {
        const f = db.prepare('SELECT id FROM crm_funis WHERE ativo = 1 ORDER BY ordem LIMIT 1').get();
        if (!f) return res.status(400).json({ success: false, error: 'Nenhum funil cadastrado' });
        fid = f.id;
      }
      if (!eid) {
        const e = db.prepare(`SELECT id FROM crm_etapas WHERE funilId = ? AND ativo = 1 AND tipo = 'normal' ORDER BY ordem LIMIT 1`).get(fid);
        if (!e) return res.status(400).json({ success: false, error: 'Funil sem etapas' });
        eid = e.id;
      }

      const temItens = Array.isArray(itens) && itens.some(i => Number(i?.produtoId));
      const opId = db.transaction(() => {
        // Card novo vai para o topo da etapa (ordemManual menor que os atuais).
        const topo = db.prepare('SELECT COALESCE(MIN(ordemManual), 0) - 1 AS o FROM crm_oportunidades WHERE etapaId = ? AND ativo = 1').get(eid).o;
        const r = db.prepare(`
          INSERT INTO crm_oportunidades
            (funilId, etapaId, clienteId, clienteNomeLivre, vendedorId, titulo, descricao, valor, probabilidade, fonte, dataPrevisaoFechamento, ordemManual)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          fid, eid, clienteId || null, clienteNomeLivre, vendedorId || (req.user?.id || null),
          titulo, descricao || null, Number(valor) || 0, Number(probabilidade) || 50,
          fonte || null, dataPrevisaoFechamento || null, topo
        );
        const id = r.lastInsertRowid;
        if (temItens) {
          const total = replaceItensOportunidade(id, itens);
          // Se o body não trouxe valor explícito, usa o somatório dos itens.
          if (valor === undefined || valor === null || valor === '') {
            db.prepare('UPDATE crm_oportunidades SET valor = ? WHERE id = ?').run(total, id);
          }
        }
        return id;
      })();
      logAction(db, req, 'criar', 'crm-oportunidade', opId, { titulo, clienteId, valor, itens: temItens ? itens.length : 0 });
      const op = db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(opId);
      res.json({ success: true, oportunidade: op, itens: listarItensOportunidade(opId) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/crm/oportunidades/:id', (req, res) => {
    try {
      const op = db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(req.params.id);
      if (!op) return res.status(404).json({ success: false, error: 'Não encontrada' });

      const camposEditaveis = ['clienteId','clienteNomeLivre','vendedorId','titulo','descricao','valor','probabilidade','fonte','dataPrevisaoFechamento','pedidoId'];
      const sets = [], vals = [];
      const changed = {};
      for (const c of camposEditaveis) {
        if (req.body[c] !== undefined) {
          sets.push(`${c} = ?`);
          vals.push(req.body[c] === '' ? null : req.body[c]);
          changed[c] = req.body[c];
        }
      }
      const itensRecebidos = req.body.itens !== undefined;
      db.transaction(() => {
        if (sets.length) {
          sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
          vals.push(op.id);
          db.prepare(`UPDATE crm_oportunidades SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        }
        if (itensRecebidos) {
          const total = replaceItensOportunidade(op.id, req.body.itens);
          // Se itens foram editados e o body não mandou valor explícito,
          // recalcula o valor a partir do somatório.
          if (req.body.valor === undefined) {
            db.prepare('UPDATE crm_oportunidades SET valor = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(total, op.id);
          }
          changed.itens = Array.isArray(req.body.itens) ? req.body.itens.length : 0;
        }
        if (sets.length || itensRecebidos) {
          logAction(db, req, 'editar', 'crm-oportunidade', op.id, changed);
        }
      })();
      const atualizada = db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(op.id);
      res.json({ success: true, oportunidade: atualizada, itens: listarItensOportunidade(op.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fase 9.6: gera uma Ordem de Serviço vinculada a partir da oportunidade.
  // Reusa campos do CRM (cliente, valor, título); tipo padrão configurável via body
  // (default: "Instalação"). Preenche `crm_oportunidades.osId` com FK para a nova OS.
  app.post('/api/crm/oportunidades/:id/gerar-os', (req, res) => {
    try {
      const op = db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(req.params.id);
      if (!op) return res.status(404).json({ success: false, error: 'Oportunidade não encontrada' });
      if (!op.clienteId) return res.status(400).json({ success: false, error: 'Oportunidade sem cliente vinculado' });
      if (op.osId) return res.status(400).json({ success: false, error: `Já existe OS #${op.osId} vinculada a esta oportunidade` });

      const { tipoId: tipoIdBody, tecnicoId, prazoSLADias, equipamento, marca, modelo, defeitoRelatado } = req.body || {};
      let tipoId = tipoIdBody ? Number(tipoIdBody) : null;
      if (!tipoId) {
        const padrao = db.prepare(`SELECT id FROM os_tipos WHERE slug = 'instalacao' AND ativo = 1`).get()
                    || db.prepare(`SELECT id FROM os_tipos WHERE ativo = 1 ORDER BY id LIMIT 1`).get();
        tipoId = padrao?.id || null;
      }
      const tipo = tipoId ? db.prepare('SELECT * FROM os_tipos WHERE id = ? AND ativo = 1').get(tipoId) : null;

      // gerarNumero é privado do os-routes — replica a lógica aqui (simples).
      function gerarNumeroOS() {
        const ano = new Date().getFullYear();
        const row = db.prepare(`
          SELECT COUNT(*) AS c FROM os_ordens WHERE strftime('%Y', dataAbertura) = ?
        `).get(String(ano));
        return `OS-${ano}-${String((row?.c || 0) + 1).padStart(5, '0')}`;
      }

      const statusInicial = (tipo && tipo.exigeOrcamentoAprovado) ? 'rascunho' : 'aberta';
      const sla = Number(prazoSLADias) || (tipo ? tipo.slaDiasPadrao : null);
      let promessa = null;
      if (sla) {
        const d = new Date(); d.setDate(d.getDate() + Number(sla));
        promessa = d.toISOString().slice(0, 10);
      }

      const numero = gerarNumeroOS();
      const titulo = op.titulo || `Oportunidade #${op.id}`;
      const osId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO os_ordens (
            numero, clienteId, tecnicoId, status, titulo,
            equipamento, marca, modelo, defeitoRelatado,
            usuarioCriacao, tipoId, oportunidadeId,
            prazoSLADias, dataPromessa, orcamentoStatus,
            ambienteFiscal, valorServicos, valorTotal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          numero, op.clienteId, tecnicoId || op.vendedorId || null, statusInicial, titulo,
          equipamento || null, marca || null, modelo || null, defeitoRelatado || op.descricao || null,
          req.user?.username || null, tipoId, op.id,
          sla || null, promessa, statusInicial === 'rascunho' ? 'rascunho' : null,
          tipo ? tipo.modoFiscal : 'sefaz',
          Number(op.valor) || 0, Number(op.valor) || 0,
        );
        const id = r.lastInsertRowid;

        // Copia checklist padrão do tipo
        if (tipo && tipo.checklistPadrao) {
          try {
            const items = JSON.parse(tipo.checklistPadrao) || [];
            const stmtChk = db.prepare('INSERT INTO os_checklist (osId, ordem, descricao, obrigatorio) VALUES (?, ?, ?, ?)');
            for (const ck of items) stmtChk.run(id, Number(ck.ordem) || 0, ck.descricao, ck.obrigatorio ? 1 : 0);
          } catch (_) { /* */ }
        }

        // Registra evento
        try {
          db.prepare(`
            INSERT INTO os_eventos (osId, tipo, descricao, usuario, payload)
            VALUES (?, 'abertura', ?, ?, ?)
          `).run(id, `OS ${numero} gerada a partir da oportunidade #${op.id}`, req.user?.username || null,
            JSON.stringify({ oportunidadeId: op.id, tipoId }));
        } catch (_) { /* */ }

        // Vincula oportunidade → OS
        db.prepare('UPDATE crm_oportunidades SET osId = ? WHERE id = ?').run(id, op.id);
        return id;
      })();

      logAction(db, req, 'gerar-os', 'crm-oportunidade', op.id, { osId, numero });
      res.json({ success: true, osId, numero });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Mover de etapa (drag-drop kanban)
  app.post('/api/crm/oportunidades/:id/mover', (req, res) => {
    try {
      const op = db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(req.params.id);
      if (!op) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const { etapaId, motivoPerda } = req.body;
      if (!etapaId) return res.status(400).json({ success: false, error: 'etapaId obrigatório' });
      const etapa = db.prepare('SELECT * FROM crm_etapas WHERE id = ?').get(etapaId);
      if (!etapa) return res.status(404).json({ success: false, error: 'Etapa não encontrada' });
      if (etapa.funilId !== op.funilId) {
        return res.status(400).json({ success: false, error: 'Etapa pertence a outro funil' });
      }
      const dataFech = etapa.tipo !== 'normal' ? new Date().toISOString() : null;
      const topo = db.prepare('SELECT COALESCE(MIN(ordemManual), 0) - 1 AS o FROM crm_oportunidades WHERE etapaId = ? AND ativo = 1').get(etapa.id).o;
      db.prepare(`
        UPDATE crm_oportunidades
           SET etapaId = ?, ordemManual = ?, dataFechamento = ?, motivoPerda = ?, dataAtualizacao = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(etapa.id, topo, dataFech, etapa.tipo === 'perdido' ? (motivoPerda || null) : null, op.id);
      logAction(db, req, 'mover', 'crm-oportunidade', op.id, { de: op.etapaId, para: etapa.id, tipo: etapa.tipo });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Reordenação manual (drag-drop no kanban). Recebe a lista completa de ids
  // da etapa de destino, na nova ordem (índice 0 = topo). Se etapaId difere da
  // etapa atual do card, também o move entre etapas (aplicando fechamento em
  // ganho/perdido, como o /mover).
  app.post('/api/crm/oportunidades/:id/reordenar', (req, res) => {
    try {
      const op = db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(req.params.id);
      if (!op) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const { etapaId, orderedIds, motivoPerda } = req.body || {};
      if (!etapaId) return res.status(400).json({ success: false, error: 'etapaId obrigatório' });
      if (!Array.isArray(orderedIds)) return res.status(400).json({ success: false, error: 'orderedIds obrigatório' });
      const etapa = db.prepare('SELECT * FROM crm_etapas WHERE id = ?').get(etapaId);
      if (!etapa) return res.status(404).json({ success: false, error: 'Etapa não encontrada' });
      if (etapa.funilId !== op.funilId) {
        return res.status(400).json({ success: false, error: 'Etapa pertence a outro funil' });
      }
      db.transaction(() => {
        if (etapa.id !== op.etapaId) {
          const dataFech = etapa.tipo !== 'normal' ? new Date().toISOString() : null;
          db.prepare(`
            UPDATE crm_oportunidades
               SET etapaId = ?, dataFechamento = ?, motivoPerda = ?, dataAtualizacao = CURRENT_TIMESTAMP
             WHERE id = ?
          `).run(etapa.id, dataFech, etapa.tipo === 'perdido' ? (motivoPerda || null) : null, op.id);
        }
        // Renumera só os cards que realmente pertencem à etapa de destino
        // (o WHERE etapaId protege contra ids de outra coluna vindos do cliente).
        const upd = db.prepare('UPDATE crm_oportunidades SET ordemManual = ? WHERE id = ? AND etapaId = ? AND ativo = 1');
        orderedIds.forEach((oid, idx) => upd.run(idx, Number(oid), etapa.id));
      })();
      logAction(db, req, 'reordenar', 'crm-oportunidade', op.id, { etapaId: etapa.id, total: orderedIds.length });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Soft-delete
  app.delete('/api/crm/oportunidades/:id', (req, res) => {
    try {
      const r = db.prepare('UPDATE crm_oportunidades SET ativo = 0 WHERE id = ?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrada' });
      logAction(db, req, 'arquivar', 'crm-oportunidade', req.params.id, null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ATIVIDADES ====================

  app.get('/api/crm/atividades', (req, res) => {
    try {
      const { oportunidadeId, clienteId, usuarioId, concluida, de, ate } = req.query;
      let sql = `SELECT a.*, u.username AS usuarioNome,
                        p.razaoSocial AS clienteNome,
                        o.titulo AS oportunidadeTitulo
                 FROM crm_atividades a
                 LEFT JOIN users u ON u.id = a.usuarioId
                 LEFT JOIN pessoas p ON p.id = a.clienteId
                 LEFT JOIN crm_oportunidades o ON o.id = a.oportunidadeId
                 WHERE 1=1`;
      const params = [];
      if (oportunidadeId) { sql += ' AND a.oportunidadeId = ?'; params.push(Number(oportunidadeId)); }
      if (clienteId)      { sql += ' AND a.clienteId = ?';      params.push(Number(clienteId)); }
      if (usuarioId)      { sql += ' AND a.usuarioId = ?';      params.push(Number(usuarioId)); }
      if (concluida !== undefined) { sql += ' AND a.concluida = ?'; params.push(concluida === '1' || concluida === 'true' ? 1 : 0); }
      if (de)             { sql += ' AND a.dataHora >= ?';      params.push(de); }
      if (ate)            { sql += ' AND a.dataHora <= ?';      params.push(ate); }
      sql += ' ORDER BY a.dataHora ASC LIMIT 500';
      const atividades = db.prepare(sql).all(...params);
      res.json({ success: true, atividades });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/crm/atividades', (req, res) => {
    try {
      const { oportunidadeId, clienteId, tipo, titulo, descricao, dataHora } = req.body;
      if (!tipo || !titulo || !dataHora) {
        return res.status(400).json({ success: false, error: 'tipo, titulo e dataHora obrigatórios' });
      }
      if (!TIPOS_ATIV.has(tipo)) {
        return res.status(400).json({ success: false, error: `Tipo inválido. Use: ${[...TIPOS_ATIV].join(', ')}` });
      }
      // Se oportunidadeId informado, herda clienteId
      let cid = clienteId;
      if (oportunidadeId && !cid) {
        const op = db.prepare('SELECT clienteId FROM crm_oportunidades WHERE id = ?').get(oportunidadeId);
        if (op) cid = op.clienteId;
      }
      const r = db.prepare(`
        INSERT INTO crm_atividades (oportunidadeId, clienteId, tipo, titulo, descricao, dataHora, usuarioId)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(oportunidadeId || null, cid || null, tipo, titulo, descricao || null, dataHora, req.user?.id || null);
      logAction(db, req, 'criar', 'crm-atividade', r.lastInsertRowid, { oportunidadeId, tipo, titulo });
      const a = db.prepare('SELECT * FROM crm_atividades WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, atividade: a });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/crm/atividades/:id/concluir', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM crm_atividades WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const { resultadoNota } = req.body;
      db.prepare(`
        UPDATE crm_atividades
           SET concluida = 1, dataConclusao = CURRENT_TIMESTAMP, resultadoNota = ?
         WHERE id = ?
      `).run(resultadoNota || null, a.id);
      logAction(db, req, 'concluir', 'crm-atividade', a.id, null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/crm/atividades/:id', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM crm_atividades WHERE id = ?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrada' });
      logAction(db, req, 'excluir', 'crm-atividade', req.params.id, null);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== IMPORTAR DE INTERESSE (licitações) ====================
  // Lista licitações marcadas como interesse que ainda não viraram oportunidade.
  app.get('/api/crm/importar-interesse/lista', async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (USE_PG) {
        // Cross-DB resolvido em 2 etapas: interesses do tenant (sem oportunidade)
        // + lookup em batch das licitacoes em PG.
        const candidatos = db.prepare(`
          SELECT DISTINCT i.cnpj, i.ano, i.sequencial,
                 (SELECT COUNT(*) FROM interesse i2 WHERE i2.cnpj=i.cnpj AND i2.ano=i.ano AND i2.sequencial=i.sequencial) AS qtdItens,
                 i.dataCriacao
            FROM interesse i
           WHERE NOT EXISTS (
             SELECT 1 FROM crm_oportunidades o
             WHERE o.licitacaoCnpj=i.cnpj AND o.licitacaoAno=i.ano AND o.licitacaoSequencial=i.sequencial AND o.ativo=1
           )
           LIMIT 500
        `).all();
        if (candidatos.length === 0) return res.json({ success: true, licitacoes: [] });
        const values = candidatos.map((_, j) => `($${j*3+1}::text,$${j*3+2}::int,$${j*3+3}::bigint)`).join(',');
        const params = [];
        for (const c of candidatos) params.push(String(c.cnpj), Number(c.ano), Number(c.sequencial));
        let qWhere = '';
        if (q) {
          const idx = params.length + 1;
          qWhere = ` AND (l."objetoCompra" ILIKE $${idx} OR l."razaoSocial" ILIKE $${idx+1} OR l."numeroCompra" ILIKE $${idx+2})`;
          const like = `%${q}%`;
          params.push(like, like, like);
        }
        const licRows = await catalogPg.query(`
          WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
          SELECT k.cnpj, k.ano, k.sequencial,
                 l."numeroCompra" AS "numeroCompra", l."objetoCompra" AS "objetoCompra",
                 l."razaoSocial" AS "nomeOrgao", COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") AS "dataEncerramentoProposta",
                 l."linkSistemaOrigem" AS "linkSistemaOrigem", l."modalidadeNome" AS "modalidadeNome",
                 l."valorTotalEstimado" AS "valorTotalEstimado"
            FROM keys k
       LEFT JOIN licitacoes l ON l."cnpj"=k.cnpj AND l."anoCompra"=k.ano AND l."sequencialCompra"=k.sequencial
           WHERE 1=1 ${qWhere}
        ORDER BY COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") ASC
           LIMIT 200
        `, params);
        const qtdMap = new Map();
        for (const c of candidatos) qtdMap.set(`${c.cnpj}|${c.ano}|${c.sequencial}`, c.qtdItens);
        const rows = licRows.map(r => ({ ...r, qtdItens: qtdMap.get(`${r.cnpj}|${r.ano}|${r.sequencial}`) || 0 }));
        return res.json({ success: true, licitacoes: rows });
      }

      const params = [];
      let where = `WHERE NOT EXISTS (
        SELECT 1 FROM crm_oportunidades o
        WHERE o.licitacaoCnpj = i.cnpj AND o.licitacaoAno = i.ano AND o.licitacaoSequencial = i.sequencial AND o.ativo = 1
      )`;
      if (q) {
        where += ` AND (l.objetoCompra LIKE ? OR l.razaoSocial LIKE ? OR l.numeroCompra LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      const rows = db.prepare(`
        SELECT DISTINCT
          i.cnpj, i.ano, i.sequencial,
          l.numeroCompra, l.objetoCompra,
          l.razaoSocial as nomeOrgao,
          l.dataEncerramentoProposta,
          l.linkSistemaOrigem,
          l.modalidadeNome,
          l.valorTotalEstimado,
          (SELECT COUNT(*) FROM interesse i2 WHERE i2.cnpj = i.cnpj AND i2.ano = i.ano AND i2.sequencial = i.sequencial) as qtdItens
        FROM interesse i
        LEFT JOIN licitacoes l ON i.cnpj = l.cnpj AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra
        ${where}
        ORDER BY l.dataEncerramentoProposta ASC, i.dataCriacao DESC
        LIMIT 200
      `).all(...params);
      res.json({ success: true, licitacoes: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cria uma oportunidade no funil Licitações a partir de uma licitação de interesse.
  app.post('/api/crm/importar-interesse', async (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.body || {};
      if (!cnpj || !ano || !sequencial) {
        return res.status(400).json({ success: false, error: 'cnpj, ano e sequencial são obrigatórios' });
      }
      const funil = db.prepare('SELECT id FROM crm_funis WHERE nome = ? AND ativo = 1').get(FUNIL_LICITACOES_NOME);
      if (!funil) return res.status(500).json({ success: false, error: 'Funil Licitações não encontrado' });
      const etapa = db.prepare('SELECT id FROM crm_etapas WHERE funilId = ? AND ativo = 1 ORDER BY ordem LIMIT 1').get(funil.id);
      if (!etapa) return res.status(500).json({ success: false, error: 'Nenhuma etapa no funil Licitações' });

      const ja = db.prepare(`
        SELECT id FROM crm_oportunidades
        WHERE licitacaoCnpj = ? AND licitacaoAno = ? AND licitacaoSequencial = ? AND ativo = 1
      `).get(cnpj, Number(ano), Number(sequencial));
      if (ja) return res.status(409).json({ success: false, error: 'Licitação já importada', oportunidadeId: ja.id });

      let lic;
      if (USE_PG) {
        lic = await catalogPg.queryOne(
          `SELECT "numeroCompra" AS "numeroCompra", "objetoCompra" AS "objetoCompra",
                  "razaoSocial" AS "nomeOrgao", COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") AS "dataEncerramentoProposta",
                  "valorTotalEstimado" AS "valorTotalEstimado"
             FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3`,
          [cnpj, Number(ano), Number(sequencial)]
        );
      } else {
        lic = db.prepare(`
          SELECT numeroCompra, objetoCompra, razaoSocial as nomeOrgao,
                 dataEncerramentoProposta, valorTotalEstimado
          FROM licitacoes
          WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?
        `).get(cnpj, Number(ano), Number(sequencial));
      }

      const titulo = lic?.numeroCompra
        ? `${lic.numeroCompra} — ${(lic.nomeOrgao || '').slice(0, 60)}`
        : `Licitação ${cnpj}/${ano}/${sequencial}`;

      const r = db.prepare(`
        INSERT INTO crm_oportunidades
          (funilId, etapaId, titulo, descricao, valor, probabilidade, fonte,
           licitacaoCnpj, licitacaoAno, licitacaoSequencial, dataPrevisaoFechamento)
        VALUES (?, ?, ?, ?, ?, 50, 'licitacao', ?, ?, ?, ?)
      `).run(
        funil.id, etapa.id,
        titulo.slice(0, 200),
        lic?.objetoCompra || null,
        Number(lic?.valorTotalEstimado) || 0,
        cnpj, Number(ano), Number(sequencial),
        lic?.dataEncerramentoProposta || null
      );
      logAction(db, req, 'importar-interesse', 'crm-oportunidade', r.lastInsertRowid, { cnpj, ano, sequencial });
      res.json({
        success: true,
        oportunidade: db.prepare('SELECT * FROM crm_oportunidades WHERE id = ?').get(r.lastInsertRowid)
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasCrm };
