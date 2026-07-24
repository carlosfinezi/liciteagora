/**
 * tesouraria-routes.js — Item 2.4:
 *  - Lotes de pagamento de CP (manual ou PIX via Asaas transfers);
 *  - Regras de conciliação OFX (ignorar/categorizar por padrão de texto);
 *  - Agenda de recebíveis de cartão (previsto × extrato).
 *
 * Alçada: consultada no PROCESSAR (momento em que o dinheiro sai) — uma
 * aprovação por CP, consumida no uso (mesma semântica da baixa manual).
 * Asaas: transferência criada no processar; a BAIXA do CP acontece no
 * /confirmar (manual v1 — automação por webhook fica para refinamento).
 */

const { logAction } = require('./audit-log');
const { lancarMovimentacao } = require('./contas-financeiras-routes');
const { verificarAlcada } = require('./governanca-routes');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function migrarTesourariaDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lotes_pagamento (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      contaFinanceiraId INTEGER NOT NULL,
      provedor TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'rascunho',
      dataAgendada TEXT,
      valorTotal REAL DEFAULT 0,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lote_pagamento_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loteId INTEGER NOT NULL,
      contaPagarId INTEGER NOT NULL,
      formaPagamento TEXT NOT NULL DEFAULT 'pix',
      chavePix TEXT,
      valor REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      provedorRef TEXT,
      erroMensagem TEXT,
      pagamentoId INTEGER,
      FOREIGN KEY (loteId) REFERENCES lotes_pagamento(id),
      FOREIGN KEY (contaPagarId) REFERENCES contas_a_pagar(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lotepag_lote ON lote_pagamento_itens(loteId);

    CREATE TABLE IF NOT EXISTS conciliacao_regras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaFinanceiraId INTEGER,
      padraoTexto TEXT NOT NULL,
      tipoLancamento TEXT NOT NULL DEFAULT 'ambos',
      acao TEXT NOT NULL DEFAULT 'categorizar',
      categoria TEXT,
      prioridade INTEGER DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agenda_recebiveis_cartao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parcelaId INTEGER UNIQUE,
      pedidoId INTEGER,
      adquirenteId INTEGER,
      valorBruto REAL NOT NULL,
      taxa REAL DEFAULT 0,
      valorLiquido REAL NOT NULL,
      dataVenda TEXT,
      dataPrevistaLiquidacao TEXT,
      status TEXT NOT NULL DEFAULT 'previsto',
      transacaoBancariaId INTEGER,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agcartao_status ON agenda_recebiveis_cartao(status);
  `);
  alterSafe(db, 'ALTER TABLE fornecedores ADD COLUMN chavePix TEXT');
  alterSafe(db, 'ALTER TABLE transacoes_bancarias ADD COLUMN categoriaSugerida TEXT');
  alterSafe(db, 'ALTER TABLE transacoes_bancarias ADD COLUMN regraAplicadaId INTEGER');
}

function proximoNumeroLote(db) {
  const ano = new Date().getFullYear();
  const prefixo = `LP-${ano}-`;
  const ult = db.prepare('SELECT numero FROM lotes_pagamento WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefixo + '%');
  const seq = ult ? parseInt(ult.numero.slice(prefixo.length), 10) + 1 : 1;
  return prefixo + String(seq).padStart(4, '0');
}

function saldoAbertoCP(db, contaPagarId) {
  const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(contaPagarId);
  if (!conta) return { conta: null };
  const pago = Number(db.prepare(`SELECT COALESCE(SUM(valorBase),0) t FROM contas_pagar_pagamentos
    WHERE contaPagarId = ? AND estornado = 0`).get(contaPagarId).t) || 0;
  return { conta, pago, saldo: Number((conta.valor - pago).toFixed(2)) };
}

// Baixa efetiva de um item do lote: pagamento + movimentação + status do CP.
function baixarItemLote(db, lote, item, usuario) {
  const { conta, pago, saldo } = saldoAbertoCP(db, item.contaPagarId);
  if (!conta || !['aberta', 'parcial'].includes(conta.status)) {
    throw new Error(`CP #${item.contaPagarId} não está aberta (${conta?.status})`);
  }
  const v = Math.min(item.valor, saldo);
  const dp = dataBrasilia();
  const movId = lancarMovimentacao(db, {
    contaId: lote.contaFinanceiraId, tipo: 'saida', valor: v, data: dp,
    descricao: `Lote ${lote.numero}: ${conta.descricao}`,
    origem: 'lote_pagamento', origemId: lote.id, usuario
  });
  // contas_pagar_pagamentos não tem coluna origem (diferente da de CR) —
  // a origem fica registrada em observacoes.
  const rp = db.prepare(`INSERT INTO contas_pagar_pagamentos
    (contaPagarId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
     formaPagamento, contaFinanceiraId, movimentacaoFinanceiraId, observacoes, usuario)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`).run(
    conta.id, dp, v, v, item.formaPagamento, lote.contaFinanceiraId, movId,
    `Lote ${lote.numero}`, usuario);
  const novoPago = Number((pago + v).toFixed(2));
  const novoStatus = novoPago < conta.valor - 0.01 ? 'parcial' : 'paga';
  db.prepare(`UPDATE contas_a_pagar SET status = ?, valorPago = ?,
    dataPagamento = CASE WHEN ? = 'paga' THEN ? ELSE dataPagamento END,
    dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(novoStatus, novoPago, novoStatus, dp, conta.id);
  db.prepare(`UPDATE lote_pagamento_itens SET status = 'pago', pagamentoId = ? WHERE id = ?`).run(rp.lastInsertRowid, item.id);
  return v;
}

// ===== Asaas transfers (PIX) — usa a config de boleto da conta financeira =====
function asaasCfg(db, contaFinanceiraId) {
  const row = db.prepare(`SELECT * FROM contas_financeiras_boleto
    WHERE contaFinanceiraId = ? AND provedor = 'asaas' AND ativo = 1`).get(contaFinanceiraId);
  if (!row) return null;
  let cfg = {};
  try { cfg = JSON.parse(row.configJson || '{}'); } catch {}
  if (!cfg.apiKey) return null;
  const base = row.ambiente === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
  return { apiKey: cfg.apiKey, base };
}

function tipoChavePix(chave) {
  const c = String(chave || '').trim();
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(c)) return 'EMAIL';
  if (/^\+?55?\d{10,11}$/.test(c.replace(/\D/g, '')) && /[()\s\-+]/.test(c)) return 'PHONE';
  const dig = c.replace(/\D/g, '');
  if (dig.length === 11 && dig === c) return 'CPF';
  if (dig.length === 14 && dig === c) return 'CNPJ';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c)) return 'EVP';
  if (dig.length === 11) return 'CPF';
  if (dig.length === 14) return 'CNPJ';
  return 'EVP';
}

async function asaasTransfer(cfg, { valor, chavePix, descricao }) {
  const resp = await fetch(cfg.base + '/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': cfg.apiKey },
    body: JSON.stringify({
      value: Number(valor),
      pixAddressKey: chavePix,
      pixAddressKeyType: tipoChavePix(chavePix),
      description: (descricao || '').slice(0, 100)
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.description || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data; // { id, status, ... }
}

// ===== Regras OFX =====
function aplicarRegrasConciliacao(db, contaFinanceiraId) {
  const regras = db.prepare(`SELECT * FROM conciliacao_regras
    WHERE ativo = 1 AND (contaFinanceiraId IS NULL OR contaFinanceiraId = ?)
    ORDER BY prioridade DESC, id`).all(contaFinanceiraId);
  if (!regras.length) return 0;
  const pendentes = db.prepare(`SELECT * FROM transacoes_bancarias
    WHERE contaFinanceiraId = ? AND conciliadaCom IS NULL AND regraAplicadaId IS NULL`).all(contaFinanceiraId);
  let aplicadas = 0;
  for (const t of pendentes) {
    const texto = `${t.descricao || ''} ${t.memo || ''}`.toLowerCase();
    const ehEntrada = Number(t.valor) > 0;
    for (const r of regras) {
      if (r.tipoLancamento === 'entrada' && !ehEntrada) continue;
      if (r.tipoLancamento === 'saida' && ehEntrada) continue;
      if (!texto.includes(r.padraoTexto.toLowerCase())) continue;
      if (r.acao === 'ignorar') {
        db.prepare(`UPDATE transacoes_bancarias SET conciliadaCom = 'ignorada',
          conciliadaEm = CURRENT_TIMESTAMP, conciliadaPor = 'regra#' || ?, regraAplicadaId = ? WHERE id = ?`)
          .run(r.id, r.id, t.id);
      } else {
        db.prepare(`UPDATE transacoes_bancarias SET categoriaSugerida = ?, regraAplicadaId = ? WHERE id = ?`)
          .run(r.categoria || r.padraoTexto, r.id, t.id);
      }
      aplicadas++;
      break;
    }
  }
  return aplicadas;
}

function registrarRotasTesouraria(app, db) {
  migrarTesourariaDB(db);

  // ==================== LOTES DE PAGAMENTO ====================

  app.get('/api/lotes-pagamento', (req, res) => {
    try {
      const lotes = db.prepare(`SELECT l.*, cf.nome AS contaNome,
          (SELECT COUNT(*) FROM lote_pagamento_itens WHERE loteId = l.id) AS qtdItens,
          (SELECT COUNT(*) FROM lote_pagamento_itens WHERE loteId = l.id AND status = 'pago') AS qtdPagos
        FROM lotes_pagamento l JOIN contas_financeiras cf ON cf.id = l.contaFinanceiraId
        ORDER BY l.id DESC LIMIT 100`).all();
      res.json({ success: true, lotes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/lotes-pagamento/:id', (req, res) => {
    try {
      const lote = db.prepare(`SELECT l.*, cf.nome AS contaNome FROM lotes_pagamento l
        JOIN contas_financeiras cf ON cf.id = l.contaFinanceiraId WHERE l.id = ?`).get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      const itens = db.prepare(`SELECT i.*, cp.descricao, cp.dataVencimento, f.razaoSocial AS fornecedorNome
        FROM lote_pagamento_itens i
        JOIN contas_a_pagar cp ON cp.id = i.contaPagarId
        LEFT JOIN fornecedores f ON f.id = cp.fornecedorId
        WHERE i.loteId = ?`).all(lote.id);
      res.json({ success: true, lote, itens });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Cria lote com CPs abertas. itens: [{contaPagarId, formaPagamento?, chavePix?}]
  app.post('/api/lotes-pagamento', (req, res) => {
    try {
      const { contaFinanceiraId, provedor, dataAgendada, itens } = req.body || {};
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const cf = db.prepare('SELECT id FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!cf) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });
      if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ success: false, error: 'Informe ao menos 1 CP' });
      const prov = provedor === 'asaas' ? 'asaas' : 'manual';
      if (prov === 'asaas' && !asaasCfg(db, contaFinanceiraId)) {
        return res.status(400).json({ success: false, error: 'Conta sem integração Asaas ativa (configure em Cobranças)' });
      }

      const resolvidos = [];
      for (const it of itens) {
        const { conta, saldo } = saldoAbertoCP(db, Number(it.contaPagarId));
        if (!conta) return res.status(404).json({ success: false, error: `CP ${it.contaPagarId} não encontrada` });
        if (!['aberta', 'parcial'].includes(conta.status)) {
          return res.status(400).json({ success: false, error: `CP #${conta.id} com status ${conta.status}` });
        }
        const jaEmLote = db.prepare(`SELECT l.numero FROM lote_pagamento_itens i
          JOIN lotes_pagamento l ON l.id = i.loteId
          WHERE i.contaPagarId = ? AND i.status IN ('pendente','aguardando','enviado')`).get(conta.id);
        if (jaEmLote) return res.status(400).json({ success: false, error: `CP #${conta.id} já está no lote ${jaEmLote.numero}` });
        let chave = (it.chavePix || '').trim() || null;
        if (!chave && conta.fornecedorId) {
          chave = db.prepare('SELECT chavePix FROM fornecedores WHERE id = ?').get(conta.fornecedorId)?.chavePix || null;
        }
        if (prov === 'asaas' && !chave) {
          return res.status(400).json({ success: false, error: `CP #${conta.id}: fornecedor sem chave PIX (informe no item ou no cadastro)` });
        }
        resolvidos.push({ contaPagarId: conta.id, fornecedorId: conta.fornecedorId, valor: saldo, chavePix: chave, formaPagamento: it.formaPagamento || 'pix' });
      }

      const usuario = req.session?.username || null;
      let loteId;
      const tx = db.transaction(() => {
        const total = resolvidos.reduce((s, x) => s + x.valor, 0);
        const r = db.prepare(`INSERT INTO lotes_pagamento (numero, contaFinanceiraId, provedor, dataAgendada, valorTotal, usuario)
          VALUES (?, ?, ?, ?, ?, ?)`).run(proximoNumeroLote(db), Number(contaFinanceiraId), prov,
          dataAgendada || null, Number(total.toFixed(2)), usuario);
        loteId = r.lastInsertRowid;
        const ins = db.prepare(`INSERT INTO lote_pagamento_itens (loteId, contaPagarId, formaPagamento, chavePix, valor)
          VALUES (?, ?, ?, ?, ?)`);
        for (const x of resolvidos) {
          ins.run(loteId, x.contaPagarId, x.formaPagamento, x.chavePix, x.valor);
          if (x.chavePix && x.fornecedorId) {
            db.prepare('UPDATE fornecedores SET chavePix = COALESCE(chavePix, ?) WHERE id = ?').run(x.chavePix, x.fornecedorId);
          }
        }
      });
      tx();
      logAction(db, req, 'criar', 'lote-pagamento', loteId, { itens: resolvidos.length, provedor: prov });
      res.json({ success: true, id: loteId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Processa: consulta alçada por CP (consome aprovações) e dispara PIX (asaas)
  // ou marca aguardando confirmação (manual).
  app.post('/api/lotes-pagamento/:id/processar', async (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes_pagamento WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      if (lote.status !== 'rascunho') return res.status(400).json({ success: false, error: `Status atual: ${lote.status}` });
      const itens = db.prepare(`SELECT * FROM lote_pagamento_itens WHERE loteId = ? AND status = 'pendente'`).all(lote.id);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Lote sem itens pendentes' });
      const usuario = req.session?.username || null;

      // Alçada primeiro — se algum item bloquear, nada é disparado
      const bloqueados = [];
      for (const it of itens) {
        const alcada = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: it.contaPagarId, valor: it.valor, usuario });
        if (!alcada.liberado) bloqueados.push({ contaPagarId: it.contaPagarId, aprovacaoId: alcada.aprovacaoId, status: alcada.status });
      }
      if (bloqueados.length) {
        return res.status(403).json({ success: false, error: `${bloqueados.length} item(ns) acima da alçada — aprovações pendentes`, bloqueados });
      }

      const erros = [];
      if (lote.provedor === 'asaas') {
        const cfg = asaasCfg(db, lote.contaFinanceiraId);
        if (!cfg) return res.status(400).json({ success: false, error: 'Integração Asaas indisponível' });
        for (const it of itens) {
          try {
            const cp = db.prepare('SELECT descricao FROM contas_a_pagar WHERE id = ?').get(it.contaPagarId);
            const tr = await asaasTransfer(cfg, { valor: it.valor, chavePix: it.chavePix, descricao: `Lote ${lote.numero}: ${cp?.descricao || ''}` });
            db.prepare(`UPDATE lote_pagamento_itens SET status = 'enviado', provedorRef = ? WHERE id = ?`).run(tr.id || null, it.id);
          } catch (e) {
            erros.push({ contaPagarId: it.contaPagarId, erro: e.message });
            db.prepare(`UPDATE lote_pagamento_itens SET status = 'erro', erroMensagem = ? WHERE id = ?`).run(String(e.message).slice(0, 300), it.id);
          }
        }
      } else {
        db.prepare(`UPDATE lote_pagamento_itens SET status = 'aguardando' WHERE loteId = ? AND status = 'pendente'`).run(lote.id);
      }
      db.prepare(`UPDATE lotes_pagamento SET status = 'processando', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(lote.id);
      logAction(db, req, 'processar', 'lote-pagamento', lote.id, { provedor: lote.provedor, erros: erros.length });
      res.json({ success: true, erros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Confirma pagamentos efetivados: baixa os CPs e lança as saídas no caixa.
  app.post('/api/lotes-pagamento/:id/confirmar', (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes_pagamento WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      // 'erro' é retentável: itens com falha na baixa voltam a ser processados
      // (itens 'erro' nunca tiveram transferência disparada — sem risco de duplo PIX)
      if (!['processando', 'erro'].includes(lote.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${lote.status}` });
      }
      const usuario = req.session?.username || null;
      const itens = db.prepare(`SELECT * FROM lote_pagamento_itens WHERE loteId = ? AND status IN ('aguardando','enviado','erro')`).all(lote.id);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Nada a confirmar' });

      let totalPago = 0;
      const erros = [];
      // Transação POR ITEM: se a baixa de um item falha, TUDO daquele item
      // (movimentação + pagamento + status) reverte junto — um catch dentro
      // de transação única deixava movimentação órfã do item que falhou.
      const itemTx = db.transaction((it) => baixarItemLote(db, lote, it, usuario));
      for (const it of itens) {
        try { totalPago += itemTx(it); }
        catch (e) {
          erros.push({ contaPagarId: it.contaPagarId, erro: e.message });
          db.prepare(`UPDATE lote_pagamento_itens SET status = 'erro', erroMensagem = ? WHERE id = ?`).run(String(e.message).slice(0, 300), it.id);
        }
      }
      const restam = db.prepare(`SELECT COUNT(*) n FROM lote_pagamento_itens
        WHERE loteId = ? AND status IN ('pendente','aguardando','enviado')`).get(lote.id).n;
      db.prepare(`UPDATE lotes_pagamento SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(restam === 0 ? (erros.length ? 'erro' : 'concluido') : 'processando', lote.id);
      logAction(db, req, 'confirmar', 'lote-pagamento', lote.id, { totalPago, erros: erros.length });
      res.json({ success: true, totalPago: Number(totalPago.toFixed(2)), erros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/lotes-pagamento/:id/cancelar', (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes_pagamento WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      if (!['rascunho', 'processando'].includes(lote.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${lote.status}` });
      }
      const pagos = db.prepare(`SELECT COUNT(*) n FROM lote_pagamento_itens WHERE loteId = ? AND status = 'pago'`).get(lote.id).n;
      db.prepare(`UPDATE lote_pagamento_itens SET status = 'cancelado'
        WHERE loteId = ? AND status IN ('pendente','aguardando','erro')`).run(lote.id);
      db.prepare(`UPDATE lotes_pagamento SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(pagos > 0 ? 'concluido' : 'cancelado', lote.id);
      logAction(db, req, 'cancelar', 'lote-pagamento', lote.id, { itensJaPagos: pagos });
      res.json({ success: true, aviso: pagos > 0 ? `${pagos} item(ns) já pagos permanecem baixados` : undefined });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== REGRAS DE CONCILIAÇÃO ====================

  app.get('/api/conciliacao/regras', (req, res) => {
    try {
      res.json({ success: true, regras: db.prepare(`SELECT r.*, cf.nome AS contaNome FROM conciliacao_regras r
        LEFT JOIN contas_financeiras cf ON cf.id = r.contaFinanceiraId
        ORDER BY r.prioridade DESC, r.id`).all() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/conciliacao/regras', (req, res) => {
    try {
      const { contaFinanceiraId, padraoTexto, tipoLancamento, acao, categoria, prioridade } = req.body || {};
      const padrao = (padraoTexto || '').trim();
      if (padrao.length < 3) return res.status(400).json({ success: false, error: 'padraoTexto (mín. 3 caracteres) obrigatório' });
      if (acao && !['categorizar', 'ignorar'].includes(acao)) {
        return res.status(400).json({ success: false, error: "acao: 'categorizar'|'ignorar'" });
      }
      const r = db.prepare(`INSERT INTO conciliacao_regras (contaFinanceiraId, padraoTexto, tipoLancamento, acao, categoria, prioridade)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        contaFinanceiraId || null, padrao,
        ['entrada', 'saida'].includes(tipoLancamento) ? tipoLancamento : 'ambos',
        acao || 'categorizar', (categoria || '').trim() || null, Number(prioridade) || 0);
      logAction(db, req, 'criar', 'regra-conciliacao', r.lastInsertRowid, { padrao });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/conciliacao/regras/:id', (req, res) => {
    try {
      const { ativo, prioridade, categoria } = req.body || {};
      const r = db.prepare(`UPDATE conciliacao_regras SET ativo = COALESCE(?, ativo),
        prioridade = COALESCE(?, prioridade), categoria = COALESCE(?, categoria) WHERE id = ?`).run(
        ativo != null ? (ativo ? 1 : 0) : null,
        prioridade != null ? Number(prioridade) : null,
        categoria !== undefined ? categoria : null, req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Regra não encontrada' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Reaplica regras às transações pendentes de uma conta
  app.post('/api/conciliacao/regras/aplicar', (req, res) => {
    try {
      const contaFinanceiraId = Number(req.body?.contaFinanceiraId);
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const aplicadas = aplicarRegrasConciliacao(db, contaFinanceiraId);
      res.json({ success: true, aplicadas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== AGENDA DE CARTÕES ====================

  // Gera previsões a partir das parcelas de pedido com bandeira (adquirente)
  app.post('/api/cartoes/agenda/gerar', (req, res) => {
    try {
      const parcelas = db.prepare(`
        SELECT pp.*, p.dataPedido, a.taxaPercentual, a.prazoLiquidacaoDias, a.id AS adquirenteId
        FROM pedido_parcelas pp
        JOIN pedidos p ON p.id = pp.pedidoId
        JOIN adquirentes_cartao a ON a.id = pp.bandeiraId
        WHERE pp.bandeiraId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agenda_recebiveis_cartao ag WHERE ag.parcelaId = pp.id)
          AND p.status NOT IN ('rascunho','cancelado')`).all();
      let geradas = 0;
      const tx = db.transaction(() => {
        const ins = db.prepare(`INSERT INTO agenda_recebiveis_cartao
          (parcelaId, pedidoId, adquirenteId, valorBruto, taxa, valorLiquido, dataVenda, dataPrevistaLiquidacao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const pp of parcelas) {
          const taxa = Number((pp.valor * (pp.taxaPercentual || 0) / 100).toFixed(2));
          const liquido = Number((pp.valor - taxa).toFixed(2));
          const base = pp.dataPedido || dataBrasilia();
          const prev = new Date(base + 'T12:00:00');
          prev.setDate(prev.getDate() + (pp.prazoLiquidacaoDias || 0));
          ins.run(pp.id, pp.pedidoId, pp.adquirenteId, pp.valor, taxa, liquido, base, prev.toISOString().slice(0, 10));
          geradas++;
        }
      });
      tx();
      logAction(db, req, 'gerar', 'agenda-cartao', null, { geradas });
      res.json({ success: true, geradas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/cartoes/agenda', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT ag.*, a.nome AS adquirenteNome, p.numero AS pedidoNumero
        FROM agenda_recebiveis_cartao ag
        LEFT JOIN adquirentes_cartao a ON a.id = ag.adquirenteId
        LEFT JOIN pedidos p ON p.id = ag.pedidoId WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND ag.status = ?'; params.push(status); }
      sql += ' ORDER BY ag.dataPrevistaLiquidacao, ag.id LIMIT 300';
      res.json({ success: true, agenda: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Sugestões de match no extrato: entrada com valor ≈ líquido e data ±3 dias
  app.get('/api/cartoes/agenda/:id/sugestoes', (req, res) => {
    try {
      const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE id = ?').get(req.params.id);
      if (!ag) return res.status(404).json({ success: false, error: 'Previsão não encontrada' });
      const sugestoes = db.prepare(`SELECT * FROM transacoes_bancarias
        WHERE conciliadaCom IS NULL AND valor > 0
          AND ABS(valor - ?) <= 0.05
          AND date(data) BETWEEN date(?, '-3 days') AND date(?, '+3 days')
        ORDER BY ABS(julianday(data) - julianday(?)) LIMIT 10`)
        .all(ag.valorLiquido, ag.dataPrevistaLiquidacao, ag.dataPrevistaLiquidacao, ag.dataPrevistaLiquidacao);
      res.json({ success: true, sugestoes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cartoes/agenda/:id/conciliar', (req, res) => {
    try {
      const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE id = ?').get(req.params.id);
      if (!ag) return res.status(404).json({ success: false, error: 'Previsão não encontrada' });
      if (ag.status !== 'previsto') return res.status(400).json({ success: false, error: `Status atual: ${ag.status}` });
      const trxId = Number(req.body?.transacaoBancariaId);
      if (!trxId) return res.status(400).json({ success: false, error: 'transacaoBancariaId obrigatório' });
      const t = db.prepare('SELECT * FROM transacoes_bancarias WHERE id = ?').get(trxId);
      if (!t) return res.status(404).json({ success: false, error: 'Transação não encontrada' });
      if (t.conciliadaCom) return res.status(400).json({ success: false, error: 'Transação já conciliada' });

      const divergente = Math.abs(Number(t.valor) - ag.valorLiquido) > 0.05;
      const tx = db.transaction(() => {
        db.prepare(`UPDATE agenda_recebiveis_cartao SET status = ?, transacaoBancariaId = ?,
          observacao = CASE WHEN ? THEN 'Divergência: extrato R$ ' || ? || ' × previsto R$ ' || ? ELSE observacao END
          WHERE id = ?`).run(divergente ? 'divergente' : 'conciliado', t.id, divergente ? 1 : 0, t.valor, ag.valorLiquido, ag.id);
        db.prepare(`UPDATE transacoes_bancarias SET conciliadaCom = 'cartao', conciliadaId = ?,
          conciliadaEm = CURRENT_TIMESTAMP, conciliadaPor = ? WHERE id = ?`)
          .run(ag.id, req.session?.username || 'cartoes', t.id);
      });
      tx();
      logAction(db, req, 'conciliar', 'agenda-cartao', ag.id, { trxId, divergente });
      res.json({ success: true, divergente });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasTesouraria, migrarTesourariaDB, aplicarRegrasConciliacao, tipoChavePix };
