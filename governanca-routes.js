/**
 * governanca-routes.js — Alçadas e aprovações (item 2.6).
 *
 * regras_alcada: acima de limiteValor, o evento exige aprovação de um papel.
 * verificarAlcada() é o hook usado pelos fluxos (baixa de CP, envio de pedido
 * de compra): se houver faixa aplicável, cria/consulta a aprovação e bloqueia
 * até um aprovador decidir. Aprovação 'aprovada' libera UMA execução.
 *
 * A decisão de qual faixa vale, o travamento do valor aprovado, a expiração e
 * o reenvio depois de reprovar estão em governanca-alcadas.js.
 *
 * Módulo de gate: 'governanca' (Enterprise).
 */

const { logAction } = require('./audit-log');
const { ROLES, requireRole } = require('./auth');
const alc = require('./governanca-alcadas');
const avisos = require('./governanca-avisos');

const TIPOS_EVENTO = new Set(alc.TIPOS_EVENTO);

// Erro bloqueia; aviso vai junto na resposta.
function separar(problemas) {
  return {
    erros: problemas.filter((p) => p.nivel === 'erro'),
    avisos: problemas.filter((p) => p.nivel === 'aviso'),
  };
}

function migrarGovernancaDB(db) {
  criarTabelas(db);
  alc.migrarDB(db);
  avisos.migrarAvisosDB(db);
}

function criarTabelas(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS regras_alcada (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipoEvento TEXT NOT NULL,
      limiteValor REAL NOT NULL,
      papelAprovador TEXT NOT NULL DEFAULT 'admin',
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS aprovacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipoEvento TEXT NOT NULL,
      referenciaId INTEGER NOT NULL,
      valorReferencia REAL,
      solicitante TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      aprovador TEXT,
      motivo TEXT,
      dataDecisao TEXT,
      consumida INTEGER DEFAULT 0,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_aprov_ref ON aprovacoes(tipoEvento, referenciaId, status);
  `);
}

// Fluxos que chamam este hook: baixa de CP individual, baixa de CP em LOTE,
// lote de pagamento da tesouraria, PIX automático e envio de pedido de compra.
//
// A baixa em lote de contas a pagar entrou nesta lista em 2026-08-02 — antes
// disso ela era a única que NÃO verificava, e o comentário aqui já dava a
// lista como completa. Com seleção múltipla na tela, era um caminho aberto
// para pagar acima do limite sem aprovação nenhuma.
//
// Ficam de fora, de propósito: o backfill de migração (reconstrói histórico de
// contas já pagas) e a taxa de adquirente de cartão (débito automático gerado
// pelo sistema na conciliação, sem decisão humana para submeter a alguém).
const verificarAlcada = (db, args) => {
  // Aviso de criação REMOVIDO em 2026-08-21, a pedido: a solicitação nascia e
  // disparava mensagem no Telegram/e-mail do tenant. Quem decide vê a fila em
  // Financeiro > Fila de Aprovações, que tem contador no menu. O módulo
  // governanca-avisos continua no repo (migração das colunas e os testes),
  // mas nada mais chama avisarCriacao — o de vencimento saiu do scheduler.
  return alc.verificarAlcada(db, args);
};

function registrarRotasGovernanca(app, db) {
  migrarGovernancaDB(db);

  // ===== regras =====
  app.get('/api/alcadas/regras', (req, res) => {
    try {
      res.json({ success: true, regras: db.prepare('SELECT * FROM regras_alcada ORDER BY tipoEvento, limiteValor').all() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/alcadas/regras', (req, res) => {
    try {
      const { tipoEvento, limiteValor, papelAprovador, validadeDias, descricao } = req.body || {};
      const { erros, avisos } = separar(alc.validarRegra(db, req.body, { roles: ROLES }));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const r = db.prepare(`INSERT INTO regras_alcada
        (tipoEvento, limiteValor, papelAprovador, validadeDias, descricao)
        VALUES (?, ?, ?, ?, ?)`).run(
        tipoEvento, Number(limiteValor), papelAprovador || 'admin',
        validadeDias != null && validadeDias !== '' ? Number(validadeDias) : alc.VALIDADE_PADRAO_DIAS,
        (descricao || '').trim() || null);
      logAction(db, req, 'criar', 'regra-alcada', r.lastInsertRowid, req.body);
      res.json({ success: true, id: r.lastInsertRowid, avisos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/alcadas/regras/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT * FROM regras_alcada WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'Regra não encontrada' });

      const { limiteValor, papelAprovador, ativo, validadeDias, descricao } = req.body || {};
      // Valida o estado final: mudar só o papel ainda tem que resultar numa
      // faixa que alguém consiga aprovar.
      const final = { ...atual, ...req.body };
      const { erros, avisos } = separar(alc.validarRegra(db, final, { roles: ROLES, id }));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      // descricao usa CASE, não COALESCE: com COALESCE, mandar '' virava NULL
      // e o COALESCE devolvia a descrição antiga — não havia como APAGAR uma
      // descrição pela tela. O flag separa "não mandou o campo" de "mandou vazio".
      db.prepare(`UPDATE regras_alcada SET
        limiteValor = COALESCE(?, limiteValor), papelAprovador = COALESCE(?, papelAprovador),
        ativo = COALESCE(?, ativo), validadeDias = COALESCE(?, validadeDias),
        descricao = CASE WHEN ? = 1 THEN ? ELSE descricao END WHERE id = ?`).run(
        limiteValor != null && limiteValor !== '' ? Number(limiteValor) : null,
        papelAprovador || null,
        ativo != null ? (ativo ? 1 : 0) : null,
        validadeDias != null && validadeDias !== '' ? Number(validadeDias) : null,
        descricao !== undefined ? 1 : 0,
        descricao !== undefined ? ((descricao || '').trim() || null) : null,
        id);
      logAction(db, req, 'editar', 'regra-alcada', id, req.body);
      res.json({ success: true, avisos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== configuração da governança =====
  // Uma chave só: admin pode aprovar a própria solicitação. Fica em config do
  // tenant (não em regras_alcada) porque vale para todas as faixas e eventos.
  app.get('/api/alcadas/config', (req, res) => {
    try {
      res.json({ success: true, adminAutoAprova: alc.autoAprovaAdminLigada(db) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/alcadas/config', requireRole(['admin']), (req, res) => {
    try {
      const ligado = !!(req.body || {}).adminAutoAprova;
      db.prepare(`INSERT INTO config (chave, valor, dataAtualizacao) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, dataAtualizacao = CURRENT_TIMESTAMP`)
        .run(alc.CHAVE_AUTO_APROVA, ligado ? '1' : '0');
      logAction(db, req, 'editar', 'config-alcada', alc.CHAVE_AUTO_APROVA, { adminAutoAprova: ligado });
      res.json({ success: true, adminAutoAprova: ligado });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== fila de aprovações =====
  app.get('/api/alcadas/aprovacoes', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT a.*,
          CASE a.tipoEvento
            WHEN 'pagamento_cp' THEN (SELECT descricao FROM contas_a_pagar WHERE id = a.referenciaId)
            WHEN 'pedido_compra' THEN (SELECT numero FROM pedidos_compra WHERE id = a.referenciaId)
          END AS referenciaDescricao
        FROM aprovacoes a WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND a.status = ?'; params.push(status); }
      sql += ' ORDER BY a.id DESC LIMIT 200';
      res.json({ success: true, aprovacoes: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Contador do menu. Devolve o total e quantas ESTE usuário pode decidir —
  // um número grande que não é problema dele treina a ignorar o badge.
  app.get('/api/alcadas/aprovacoes/pendentes', (req, res) => {
    try {
      const eu = db.prepare('SELECT username, role FROM users WHERE id = ?').get(req.session?.userId || -1);
      const pendentes = db.prepare(
        "SELECT * FROM aprovacoes WHERE status = 'pendente' AND consumida = 0").all();
      const minhas = eu ? pendentes.filter((a) => {
        // Solicitante não aprova o próprio pedido — salvo admin com a
        // auto-aprovação ligada, aí a decisão é de fato dele.
        if (eu.username === a.solicitante && !alc.podeAutoAprovar(db, a, eu)) return false;
        return alc.podeDecidir(db, a, eu).pode;
      }).length : 0;
      res.json({ success: true, total: pendentes.length, minhas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  const decidir = (novoStatus) => (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM aprovacoes WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Aprovação não encontrada' });
      if (a.status !== 'pendente') return res.status(400).json({ success: false, error: `Status atual: ${a.status}` });

      const eu = db.prepare('SELECT username, role FROM users WHERE id = ?').get(req.session?.userId || -1);
      // O papel exigido vem da própria aprovação — buscar "uma regra do tipo"
      // podia trazer o papel de outra faixa, e aí quem não devia aprovava.
      const permissao = alc.podeDecidir(db, a, eu);
      if (!permissao.pode) return res.status(403).json({ success: false, error: permissao.motivo });
      const papel = permissao.papel;
      if (eu.username === a.solicitante && novoStatus === 'aprovada' && !alc.podeAutoAprovar(db, a, eu)) {
        return res.status(403).json({ success: false,
          error: 'Solicitante não pode aprovar a própria solicitação. '
            + 'Um admin pode liberar isso em Financeiro > Regras de Alçada.' });
      }
      const motivo = (req.body?.motivo || '').trim() || null;
      if (novoStatus === 'reprovada' && !motivo) {
        return res.status(400).json({ success: false, error: 'Motivo obrigatório para reprovar' });
      }
      const auto = eu.username === a.solicitante && novoStatus === 'aprovada';
      db.prepare(`UPDATE aprovacoes SET status = ?, aprovador = ?, motivo = ?, autoAprovada = ?,
        dataDecisao = DATETIME('now','-3 hours') WHERE id = ?`)
        .run(novoStatus, eu.username, motivo, auto ? 1 : 0, a.id);
      logAction(db, req, novoStatus === 'aprovada' ? 'aprovar' : 'reprovar', 'aprovacao', a.id,
        { tipoEvento: a.tipoEvento, referenciaId: a.referenciaId, valor: a.valorReferencia, autoAprovada: auto });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  };
  app.post('/api/alcadas/aprovacoes/:id/aprovar', decidir('aprovada'));
  app.post('/api/alcadas/aprovacoes/:id/reprovar', decidir('reprovada'));

  // ===== inteligência =====

  // Alçada mal configurada não dá erro: ela para o pagamento e ninguém sabe
  // por quê. Aqui aparecem faixa sem aprovador, aprovação parada há dias,
  // aprovação vencida e reprovação que ficou travando o documento.
  app.get('/api/alcadas/diagnostico', (req, res) => {
    try {
      res.json({ success: true, diagnostico: alc.diagnostico(db, {
        diasParado: Number(req.query.diasParado) || 3,
      }) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // "Um pagamento de R$ X passaria, e quem aprovaria?" — a tela mostrava
  // limites soltos e o erro de configuração só aparecia na hora de pagar.
  app.get('/api/alcadas/simular', (req, res) => {
    try {
      const { tipoEvento, valor } = req.query;
      if (!TIPOS_EVENTO.has(tipoEvento)) {
        return res.status(400).json({ success: false, error: `tipoEvento: ${[...TIPOS_EVENTO].join('|')}` });
      }
      res.json({ success: true, simulacao: alc.simular(db, tipoEvento, Number(valor) || 0) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasGovernanca, migrarGovernancaDB, verificarAlcada };
