/**
 * portal-routes.js — Portal externo do cliente (autoatendimento).
 *
 * Auth separado: tabela `cliente_logins` vinculada a pessoaId.
 * Sessão usa req.session.clienteId (não confundir com req.session.userId que é staff).
 *
 * Rotas DEVEM ser registradas ANTES do app.use(requireAuth) em server.js
 * (o requireAuth padrão também faz bypass de '/portal/*' como segurança extra).
 *
 * Endpoints públicos:
 *   POST /portal/api/login   { email, senha }
 *   POST /portal/api/logout
 *
 * Endpoints autenticados (requirePortalAuth):
 *   GET  /portal/api/me
 *   PUT  /portal/api/me/senha       { senhaAtual, senhaNova }
 *   GET  /portal/api/pedidos
 *   GET  /portal/api/cobrancas
 *   GET  /portal/api/nfses
 *   GET  /portal/api/contratos
 *   GET  /portal/api/dashboard      (KPIs)
 *
 * Endpoints admin (cria/reseta credencial — vão pelo /api/ normal):
 *   POST /api/portal/credencial     { pessoaId, email, senha }
 *   DELETE /api/portal/credencial/:pessoaId   (revoga acesso)
 *   GET  /api/portal/credenciais    (lista todas)
 */

const bcrypt = require('bcryptjs');
const { logAction } = require('./audit-log');
const { requireRole } = require('./auth');
const { createStmtCache } = require('./stmt-cache');

// Schema de cliente_logins foi movido para db-schema.js (2026-04-22)
// em consequência da migração multi-tenant — agora é criado no
// initSchema() por-tenant, não em runtime no boot do worker.

function requirePortalAuth(db) {
  const stmt = createStmtCache();
  const SQL = 'SELECT cl.id, cl.pessoaId, cl.email, cl.ativo, p.razaoSocial, p.cpfCnpj FROM cliente_logins cl JOIN pessoas p ON p.id = cl.pessoaId WHERE cl.id = ?';
  return (req, res, next) => {
    if (!req.session || !req.session.clienteLoginId) {
      return res.status(401).json({ success: false, error: 'Não autenticado' });
    }
    const c = stmt(db, SQL).get(req.session.clienteLoginId);
    if (!c || !c.ativo) {
      req.session.destroy?.(() => {});
      return res.status(401).json({ success: false, error: 'Sessão inválida' });
    }
    req.cliente = c;
    next();
  };
}

// Rotas /portal/* (públicas + autenticadas por sessão de cliente).
// Devem ser registradas ANTES do app.use(requireAuth) em server.js.
function registrarRotasPortal(app, db) {
  const portalAuth = requirePortalAuth(db);

  // ==================== PORTAL PÚBLICO ====================

  app.post('/portal/api/login', (req, res) => {
    try {
      const { email, senha } = req.body || {};
      if (!email || !senha) return res.status(400).json({ success: false, error: 'Informe e-mail e senha' });
      const cl = db.prepare(`
        SELECT cl.*, p.razaoSocial FROM cliente_logins cl
        JOIN pessoas p ON p.id = cl.pessoaId
        WHERE cl.email = ?
      `).get(email);
      if (!cl || !bcrypt.compareSync(senha, cl.passwordHash)) {
        return res.status(401).json({ success: false, error: 'E-mail ou senha incorretos' });
      }
      if (!cl.ativo) return res.status(401).json({ success: false, error: 'Acesso revogado' });
      db.prepare('UPDATE cliente_logins SET ultimoLogin = CURRENT_TIMESTAMP WHERE id = ?').run(cl.id);
      req.session.clienteLoginId = cl.id;
      req.session.clientePessoaId = cl.pessoaId;
      res.json({ success: true, razaoSocial: cl.razaoSocial });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/portal/api/logout', (req, res) => {
    if (req.session) req.session.destroy(() => {
      res.clearCookie('liciteagora.sid');
      res.json({ success: true });
    });
    else res.json({ success: true });
  });

  // ==================== PORTAL AUTENTICADO ====================

  app.get('/portal/api/me', portalAuth, (req, res) => {
    res.json({ success: true, cliente: req.cliente });
  });

  app.put('/portal/api/me/senha', portalAuth, (req, res) => {
    try {
      const { senhaAtual, senhaNova } = req.body || {};
      if (!senhaAtual || !senhaNova) return res.status(400).json({ success: false, error: 'Informe senhas' });
      if (senhaNova.length < 6) return res.status(400).json({ success: false, error: 'Nova senha mín. 6 caracteres' });
      const u = db.prepare('SELECT passwordHash FROM cliente_logins WHERE id = ?').get(req.cliente.id);
      if (!bcrypt.compareSync(senhaAtual, u.passwordHash)) {
        return res.status(400).json({ success: false, error: 'Senha atual incorreta' });
      }
      db.prepare('UPDATE cliente_logins SET passwordHash = ? WHERE id = ?').run(bcrypt.hashSync(senhaNova, 10), req.cliente.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/pedidos', portalAuth, (req, res) => {
    try {
      const pedidos = db.prepare(`
        SELECT id, numero, status, statusPagamento, dataPedido, dataEntregaPrevista, dataEntregaReal, valorTotal, valorPago
        FROM pedidos WHERE clienteId = ?
        ORDER BY dataPedido DESC LIMIT 200
      `).all(req.cliente.pessoaId);
      res.json({ success: true, pedidos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/pedidos/:id', portalAuth, (req, res) => {
    try {
      const p = db.prepare('SELECT * FROM pedidos WHERE id = ? AND clienteId = ?').get(req.params.id, req.cliente.pessoaId);
      if (!p) return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
      const itens = db.prepare(`
        SELECT pi.*, pr.sku FROM pedido_itens pi
        LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.pedidoId = ? ORDER BY pi.id
      `).all(p.id);
      res.json({ success: true, pedido: p, itens });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== OS (Fase 9.5) ====================
  //
  // Cliente logado no portal vê suas OS e pode:
  //   - Listar (com filtros de status e SLA)
  //   - Ver detalhe (+ checklist, anexos, timeline)
  //   - Baixar PDF
  //   - Assinar recebimento/aceite via canvas

  app.get('/portal/api/os', portalAuth, (req, res) => {
    try {
      const ordens = db.prepare(`
        SELECT o.id, o.numero, o.titulo, o.status, o.orcamentoStatus, o.orcamentoToken,
               o.equipamento, o.marca, o.modelo, o.dataAbertura, o.dataConclusao,
               o.dataPromessa, o.slaStatus, o.valorTotal, o.garantiaDias,
               t.nome AS tipoNome
        FROM os_ordens o
        LEFT JOIN os_tipos t ON t.id = o.tipoId
        WHERE o.clienteId = ?
        ORDER BY o.dataAbertura DESC LIMIT 200
      `).all(req.cliente.pessoaId);
      res.json({ success: true, ordens });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/os/:id', portalAuth, (req, res) => {
    try {
      const os = db.prepare(`
        SELECT o.*, t.nome AS tipoNome, u.nome AS tecnicoNomeExibicao, u.username AS tecnicoNome
        FROM os_ordens o
        LEFT JOIN os_tipos t ON t.id = o.tipoId
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE o.id = ? AND o.clienteId = ?
      `).get(req.params.id, req.cliente.pessoaId);
      if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });

      const pecas = db.prepare(`
        SELECT pi.descricao, pi.quantidade, pi.valorUnitario, pi.valorTotal, pr.sku
        FROM os_itens_pecas pi LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ?
      `).all(os.id);
      const servicos = db.prepare(
        'SELECT descricao, horas, valorHora, valorTotal FROM os_itens_servicos WHERE osId = ?'
      ).all(os.id);
      const checklist = db.prepare('SELECT id, ordem, descricao, concluido, obrigatorio FROM os_checklist WHERE osId = ? ORDER BY ordem').all(os.id);
      const anexos = db.prepare(`
        SELECT id, categoria, mimeType, nomeOriginal, caminho, dataUpload
        FROM os_anexos WHERE osId = ?
        ORDER BY dataUpload DESC
      `).all(os.id);

      // Só eventos "públicos" — cliente não precisa ver audit interno
      const eventos = db.prepare(`
        SELECT tipo, descricao, data FROM os_eventos
        WHERE osId = ? AND tipo IN ('abertura','enviado','aprovado','rejeitado','inicio','conclusao','faturamento','assinatura')
        ORDER BY data DESC LIMIT 50
      `).all(os.id);

      res.json({ success: true, os, pecas, servicos, checklist, anexos, eventos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/os/:id/pdf', portalAuth, (req, res) => {
    try {
      const ok = db.prepare('SELECT id FROM os_ordens WHERE id = ? AND clienteId = ?').get(req.params.id, req.cliente.pessoaId);
      if (!ok) return res.status(404).json({ success: false, error: 'OS não encontrada' });
      const osPdf = require('./os-pdf');
      const os = db.prepare(`
        SELECT o.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
               p.telefone AS clienteTelefone, u.nome AS tecnicoNomeExibicao,
               u.username AS tecnicoNome
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE o.id = ?
      `).get(req.params.id);
      const pecas = db.prepare(`
        SELECT pi.*, pr.sku FROM os_itens_pecas pi
        LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ? ORDER BY pi.id
      `).all(os.id);
      const servicos = db.prepare('SELECT * FROM os_itens_servicos WHERE osId = ? ORDER BY id').all(os.id);
      const checklist = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem').all(os.id);
      const emitente = db.prepare('SELECT razaoSocial, cnpj, telefone, email FROM fornecedor WHERE id = 1').get() || {};
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="OS-${os.numero}.pdf"`);
      osPdf.gerar(res, os, emitente, pecas, servicos, checklist);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/portal/api/os/:id/assinar', portalAuth, (req, res) => {
    try {
      const os = db.prepare('SELECT id FROM os_ordens WHERE id = ? AND clienteId = ?').get(req.params.id, req.cliente.pessoaId);
      if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });
      const { dataUrl } = req.body || {};
      if (!dataUrl || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
        return res.status(400).json({ success: false, error: 'dataUrl inválido' });
      }
      db.prepare(`UPDATE os_ordens
        SET assinaturaClienteDataUrl = ?, assinaturaClienteData = CURRENT_TIMESTAMP
        WHERE id = ?`).run(dataUrl, os.id);
      try {
        db.prepare(`INSERT INTO os_eventos (osId, tipo, descricao, usuario, payload)
          VALUES (?, 'assinatura', 'Assinatura do cliente (portal)', ?, ?)`)
          .run(os.id, `portal:${req.cliente.email}`, JSON.stringify({ via: 'portal', clienteLoginId: req.cliente.id }));
      } catch (_) {}
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/cobrancas', portalAuth, (req, res) => {
    try {
      const cobs = db.prepare(`
        SELECT cr.id, cr.descricao, cr.valor, cr.dataEmissao, cr.dataVencimento, cr.dataPagamento,
               cr.valorPago, cr.status, cr.formaPagamento, cr.nfseId
        FROM contas_a_receber cr
        WHERE cr.pessoaId = ?
        ORDER BY cr.dataVencimento DESC LIMIT 500
      `).all(req.cliente.pessoaId);
      res.json({ success: true, cobrancas: cobs });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/nfses', portalAuth, (req, res) => {
    try {
      // Match por CNPJ tomador (NFSe nacional). NF-e ficaria similar mas campo diferente.
      const nfses = db.prepare(`
        SELECT id, nNFSe, nDPS, chaveAcesso, descricaoServico, valorServico, dataCompetencia, status, dataCriacao
        FROM nfse
        WHERE tomadorCpfCnpj = ? AND status NOT IN ('cancelada','erro')
        ORDER BY dataCriacao DESC LIMIT 200
      `).all(req.cliente.cpfCnpj);
      res.json({ success: true, nfses });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/contratos', portalAuth, (req, res) => {
    try {
      const cts = db.prepare(`
        SELECT id, numero, descricao, valorMensal, diaVencimento, dataInicio, dataFim, status
        FROM contratos WHERE clienteId = ?
        ORDER BY dataInicio DESC
      `).all(req.cliente.pessoaId);
      res.json({ success: true, contratos: cts });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/portal/api/dashboard', portalAuth, (req, res) => {
    try {
      const pedidos = db.prepare(`
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN status NOT IN ('cancelado','rascunho') THEN 1 ELSE 0 END) AS ativos,
               SUM(CASE WHEN statusPagamento = 'pago' THEN valorTotal ELSE 0 END) AS valorPago
        FROM pedidos WHERE clienteId = ?
      `).get(req.cliente.pessoaId);
      const cobs = db.prepare(`
        SELECT
          SUM(CASE WHEN status = 'aberta' AND date(dataVencimento) >= date('now') THEN valor ELSE 0 END) AS aReceber,
          SUM(CASE WHEN status = 'aberta' AND date(dataVencimento) < date('now')  THEN valor ELSE 0 END) AS vencidas,
          SUM(CASE WHEN status = 'paga' AND strftime('%Y-%m', dataPagamento) = strftime('%Y-%m', 'now') THEN valor ELSE 0 END) AS pagasNoMes
        FROM contas_a_receber WHERE pessoaId = ?
      `).get(req.cliente.pessoaId);
      res.json({ success: true, pedidos, cobrancas: cobs });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

// Rotas /api/portal/* — administração de credenciais (admin only).
// Devem ser registradas DEPOIS do app.use(requireAuth) em server.js.
function registrarRotasPortalAdmin(app, db) {
  app.get('/api/portal/credenciais', requireRole(['admin']), (req, res) => {
    try {
      const lista = db.prepare(`
        SELECT cl.id, cl.pessoaId, cl.email, cl.ativo, cl.ultimoLogin, cl.dataCriacao,
               p.razaoSocial, p.cpfCnpj
        FROM cliente_logins cl
        JOIN pessoas p ON p.id = cl.pessoaId
        ORDER BY cl.ativo DESC, p.razaoSocial
      `).all();
      res.json({ success: true, credenciais: lista });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/portal/credencial', requireRole(['admin']), (req, res) => {
    try {
      const { pessoaId, email, senha } = req.body;
      if (!pessoaId || !email || !senha) return res.status(400).json({ success: false, error: 'pessoaId, email e senha obrigatórios' });
      if (senha.length < 6) return res.status(400).json({ success: false, error: 'Senha deve ter ao menos 6 caracteres' });
      const pessoa = db.prepare('SELECT id, razaoSocial FROM pessoas WHERE id = ?').get(pessoaId);
      if (!pessoa) return res.status(404).json({ success: false, error: 'Pessoa não encontrada' });
      const conflito = db.prepare('SELECT id, pessoaId FROM cliente_logins WHERE email = ?').get(email);
      if (conflito && conflito.pessoaId !== Number(pessoaId)) {
        return res.status(409).json({ success: false, error: 'E-mail já em uso por outro cliente' });
      }
      const hash = bcrypt.hashSync(senha, 10);
      const existente = db.prepare('SELECT id FROM cliente_logins WHERE pessoaId = ?').get(pessoaId);
      if (existente) {
        db.prepare('UPDATE cliente_logins SET email = ?, passwordHash = ?, ativo = 1 WHERE id = ?').run(email, hash, existente.id);
        logAction(db, req, 'redefinir-senha', 'cliente-login', existente.id, { pessoaId, email });
      } else {
        const r = db.prepare('INSERT INTO cliente_logins (pessoaId, email, passwordHash) VALUES (?, ?, ?)').run(pessoaId, email, hash);
        logAction(db, req, 'criar', 'cliente-login', r.lastInsertRowid, { pessoaId, email });
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/portal/credencial/:pessoaId', requireRole(['admin']), (req, res) => {
    try {
      const r = db.prepare('UPDATE cliente_logins SET ativo = 0 WHERE pessoaId = ?').run(req.params.pessoaId);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Credencial não encontrada' });
      logAction(db, req, 'revogar', 'cliente-login', req.params.pessoaId, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

// requirePortalAuth é reusado pela loja virtual: o comprador da vitrine é o
// mesmo cliente do portal, com a mesma sessão e o mesmo login.
module.exports = { registrarRotasPortal, registrarRotasPortalAdmin, requirePortalAuth };
