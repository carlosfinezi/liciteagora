/**
 * contas-receber-routes.js — Módulo completo de Contas a Receber (v2)
 *
 * Registra rotas em server.js:
 *   const { registrarRotasContasReceber, registrarBaixaCR } = require('./contas-receber-routes');
 *   registrarRotasContasReceber(app, db);
 *
 * Espelha contas-pagar-routes.js para CR:
 *   - categorias_cr + contas_receber_pagamentos + contas_receber_anexos
 *   - Pagamento com juros/multa/desconto/parcial, estorno, baixa em lote
 *   - Parcelamento, duplicar
 *   - Preserva fluxo MercadoPago (boletos permanecem em financeiro-routes.js)
 *
 * Recorrências de CR não existem aqui — geração recorrente passa pelo módulo de NFSe
 * (nfse_recorrencias) que já cria CR + boleto + NFSe de forma atômica.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { lancarMovimentacao } = require('./contas-financeiras-routes');

function dataBrasilia() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function alterSafe(db, sql) {
  try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

// ==================== MIGRAÇÕES ====================

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categorias_cr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      icone TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contas_receber_pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaReceberId INTEGER NOT NULL,
      dataPagamento TEXT NOT NULL,
      valorPago REAL NOT NULL,
      valorBase REAL NOT NULL,
      juros REAL DEFAULT 0,
      multa REAL DEFAULT 0,
      desconto REAL DEFAULT 0,
      formaPagamento TEXT,
      contaFinanceiraId INTEGER NOT NULL,
      movimentacaoFinanceiraId INTEGER,
      observacoes TEXT,
      estornado INTEGER DEFAULT 0,
      estornadoEm TEXT,
      origem TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id),
      FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id)
    );
    CREATE INDEX IF NOT EXISTS idx_crp_conta ON contas_receber_pagamentos(contaReceberId);

    CREATE TABLE IF NOT EXISTS contas_receber_anexos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaReceberId INTEGER NOT NULL,
      nomeOriginal TEXT NOT NULL,
      caminho TEXT NOT NULL,
      mimeType TEXT,
      tamanho INTEGER,
      tipo TEXT,
      dataUpload TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cra_conta ON contas_receber_anexos(contaReceberId);
  `);

  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN categoriaId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN parcelaNumero INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN totalParcelas INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN grupoParcelaId TEXT');

  const seed = [
    { nome: 'Vendas', icone: '🛒' },
    { nome: 'Serviços', icone: '🔧' },
    { nome: 'Licitações', icone: '📋' },
    { nome: 'Assinaturas', icone: '🔁' },
    { nome: 'Aluguel recebido', icone: '🏠' },
    { nome: 'Juros/Rendimentos', icone: '📈' },
    { nome: 'Outros', icone: '📌' }
  ];
  const stmt = db.prepare('INSERT OR IGNORE INTO categorias_cr (nome, icone) VALUES (?, ?)');
  for (const c of seed) stmt.run(c.nome, c.icone);

  // Backfill — contas pagas v1 sem histórico
  // Só fazemos backfill para contas que tinham contaFinanceiraId registrado (NOT NULL),
  // para preservar a FK. As demais permanecem sem histórico detalhado.
  const pagasSemHistorico = db.prepare(`
    SELECT c.* FROM contas_a_receber c
    WHERE c.status = 'paga' AND c.dataPagamento IS NOT NULL
      AND c.contaFinanceiraId IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM contas_receber_pagamentos p WHERE p.contaReceberId = c.id)
  `).all();
  let puladas = 0;
  for (const c of pagasSemHistorico) {
    const contaFin = db.prepare('SELECT id FROM contas_financeiras WHERE id = ?').get(c.contaFinanceiraId);
    if (!contaFin) { puladas++; continue; }
    db.prepare(`INSERT INTO contas_receber_pagamentos
      (contaReceberId, dataPagamento, valorPago, valorBase, formaPagamento,
       contaFinanceiraId, origem, observacoes)
      VALUES (?, ?, ?, ?, ?, ?, 'backfill_v1', 'backfill v1')`).run(
      c.id, c.dataPagamento, c.valorPago || c.valor, c.valorPago || c.valor,
      c.formaPagamento, c.contaFinanceiraId
    );
  }
  if (puladas) console.log(`[CR backfill] ${puladas} conta(s) paga(s) sem contaFinanceiraId válida — pulado`);
}

// ==================== HELPER EXPORTADO ====================

/**
 * Registra baixa em uma CR — usado pelo webhook MP, polling e endpoints internos.
 * Cria registro em contas_receber_pagamentos, lança movimentacao_financeira (tipo=entrada)
 * e atualiza status da CR.
 */
function registrarBaixaCR(db, opts) {
  const {
    contaReceberId, valorBase, dataPagamento, contaFinanceiraId,
    formaPagamento, origem, juros = 0, multa = 0, desconto = 0,
    observacoes = null, usuario = null, parcial = false
  } = opts;

  if (!contaReceberId || !contaFinanceiraId) {
    throw new Error('contaReceberId e contaFinanceiraId obrigatórios');
  }
  const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(contaReceberId);
  if (!conta) throw new Error('Conta a receber não encontrada');

  const jaPago = Number(db.prepare(`SELECT COALESCE(SUM(valorBase), 0) AS t
    FROM contas_receber_pagamentos WHERE contaReceberId = ? AND estornado = 0`).get(contaReceberId).t) || 0;
  const saldoAberto = Number((conta.valor - jaPago).toFixed(2));
  // CR-01 (2026-04-18): rejeita valorBase acima do saldo aberto em vez de truncar silenciosamente.
  const vBaseSolicitado = (valorBase !== undefined && valorBase !== null && valorBase !== '') ? Number(valorBase) : saldoAberto;
  if (!Number.isFinite(vBaseSolicitado) || vBaseSolicitado <= 0) {
    throw new Error('valorBase deve ser positivo');
  }
  if (vBaseSolicitado > saldoAberto + 0.01) {
    throw new Error(`valorBase (${vBaseSolicitado.toFixed(2)}) maior que saldo aberto (${saldoAberto.toFixed(2)})`);
  }
  const vBase = Math.min(vBaseSolicitado, saldoAberto);
  const vPago = Number((vBase + Number(juros) + Number(multa) - Number(desconto)).toFixed(2));
  const dp = dataPagamento || dataBrasilia();
  const novoJaPago = Number((jaPago + vBase).toFixed(2));
  const novoStatus = (parcial || novoJaPago < conta.valor - 0.01) ? 'parcial' : 'paga';

  let pagamentoId, movId;
  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO contas_receber_pagamentos
      (contaReceberId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
       formaPagamento, contaFinanceiraId, origem, observacoes, usuario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      contaReceberId, dp, vPago, vBase, juros, multa, desconto,
      formaPagamento || null, contaFinanceiraId, origem || 'manual',
      observacoes, usuario
    );
    pagamentoId = r.lastInsertRowid;

    movId = lancarMovimentacao(db, {
      contaId: contaFinanceiraId,
      tipo: 'entrada', valor: vPago, data: dp,
      descricao: `Baixa CR: ${conta.descricao}`,
      origem: 'baixa_cr', origemId: conta.id,
      categoria: 'vendas', usuario
    });
    db.prepare('UPDATE contas_receber_pagamentos SET movimentacaoFinanceiraId = ? WHERE id = ?').run(movId, pagamentoId);

    db.prepare(`UPDATE contas_a_receber SET status = ?,
      valorPago = ?, dataPagamento = CASE WHEN ? = 'paga' THEN ? ELSE dataPagamento END,
      formaPagamento = COALESCE(?, formaPagamento),
      contaFinanceiraId = ?, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
      novoStatus, novoJaPago, novoStatus, dp, formaPagamento || null, contaFinanceiraId, contaReceberId
    );
  });
  tx();

  return { pagamentoId, movimentacaoFinanceiraId: movId, novoStatus, saldoRestante: Number((conta.valor - novoJaPago).toFixed(2)) };
}

// ==================== MULTER (anexos) ====================

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'cr');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploadAnexo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
      cb(null, `${Date.now()}-${safe}${ext.startsWith('.') ? '' : '.'}${ext}`.replace(/\.+/g,'.'));
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|image|octet-stream/i.test(file.mimetype) ||
      /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Apenas PDF ou imagens'), ok);
  }
});

// ==================== ROTAS ====================

function registrarRotas(app, db) {
  migrar(db);

  // ========== CATEGORIAS ==========
  app.get('/api/cr-categorias', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM categorias_cr WHERE ativo = 1 ORDER BY nome ASC').all();
      res.json({ success: true, categorias: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.post('/api/cr-categorias', (req, res) => {
    try {
      const { nome, icone } = req.body || {};
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare('INSERT INTO categorias_cr (nome, icone) VALUES (?, ?)').run(nome.trim(), icone || null);
      res.json({ success: true, categoria: db.prepare('SELECT * FROM categorias_cr WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.put('/api/cr-categorias/:id', (req, res) => {
    try {
      const { nome, icone } = req.body || {};
      db.prepare('UPDATE categorias_cr SET nome = COALESCE(?, nome), icone = COALESCE(?, icone) WHERE id = ?')
        .run(nome || null, icone || null, req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.delete('/api/cr-categorias/:id', (req, res) => {
    try {
      db.prepare('UPDATE categorias_cr SET ativo = 0 WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== LISTAGEM / DETALHE ==========
  app.get('/api/contas-a-receber', (req, res) => {
    try {
      const { status, pessoaId, categoriaId, origem,
              dataVencIni, dataVencFim, dataPagIni, dataPagFim,
              formaPagamento, busca, nota, nDPS } = req.query;
      let sql = `SELECT c.*,
        CASE WHEN c.status IN ('aberta','parcial') AND c.dataVencimento < DATE('now','-3 hours') THEN 'vencida' ELSE c.status END AS statusReal,
        p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaCpfCnpj,
        cat.nome AS categoriaNome, cat.icone AS categoriaIcone,
        b.id AS boletoId, b.status AS boletoStatus, b.externalUrl AS boletoUrl,
        COALESCE((SELECT SUM(valorPago) FROM contas_receber_pagamentos
                  WHERE contaReceberId = c.id AND estornado = 0), 0) AS totalPago,
        (SELECT COUNT(*) FROM contas_receber_anexos WHERE contaReceberId = c.id) AS totalAnexos,
        n.nDPS AS nfseNumero
      FROM contas_a_receber c
      JOIN pessoas p ON p.id = c.pessoaId
      LEFT JOIN categorias_cr cat ON cat.id = c.categoriaId
      LEFT JOIN boletos b ON b.id = (SELECT MAX(b2.id) FROM boletos b2 WHERE b2.contaReceberId = c.id)
      LEFT JOIN nfse n ON n.id = c.nfseId
      WHERE 1=1`;
      const p = [];
      if (status) {
        if (status === 'vencida') {
          sql += ` AND c.status IN ('aberta','parcial') AND c.dataVencimento < DATE('now','-3 hours')`;
        } else { sql += ' AND c.status = ?'; p.push(status); }
      }
      if (pessoaId)    { sql += ' AND c.pessoaId = ?'; p.push(Number(pessoaId)); }
      if (categoriaId) { sql += ' AND c.categoriaId = ?'; p.push(Number(categoriaId)); }
      if (origem)      { sql += ' AND c.origem = ?'; p.push(origem); }
      if (formaPagamento) { sql += ' AND c.formaPagamento = ?'; p.push(formaPagamento); }
      if (dataVencIni) { sql += ' AND c.dataVencimento >= ?'; p.push(dataVencIni); }
      if (dataVencFim) { sql += ' AND c.dataVencimento <= ?'; p.push(dataVencFim); }
      if (dataPagIni)  { sql += ' AND c.dataPagamento >= ?'; p.push(dataPagIni); }
      if (dataPagFim)  { sql += ' AND c.dataPagamento <= ?'; p.push(dataPagFim); }
      if (busca) {
        sql += ' AND (p.razaoSocial LIKE ? OR p.cpfCnpj LIKE ? OR c.descricao LIKE ?)';
        const t = '%' + busca + '%'; p.push(t, t, t);
      }
      if (nota === 'com') sql += ' AND c.nfseId IS NOT NULL';
      else if (nota === 'sem') sql += ' AND c.nfseId IS NULL';
      if (nDPS) { sql += ' AND c.nfseId IN (SELECT id FROM nfse WHERE nDPS = ?)'; p.push(Number(nDPS)); }
      sql += ' ORDER BY c.dataVencimento ASC, c.id DESC LIMIT 500';
      const contas = db.prepare(sql).all(...p).map(c => ({
        ...c,
        saldoRestante: Number((c.valor - c.totalPago).toFixed(2))
      }));
      res.json({ success: true, contas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-receber/resumo', (req, res) => {
    try {
      const hoje = dataBrasilia();
      const d7 = new Date(hoje + 'T12:00:00'); d7.setDate(d7.getDate() + 7);
      const d30 = new Date(hoje + 'T12:00:00'); d30.setDate(d30.getDate() + 30);
      const mesIni = hoje.slice(0,7) + '-01';

      const saldoSQL = "c.valor - COALESCE((SELECT SUM(valorPago) FROM contas_receber_pagamentos WHERE contaReceberId=c.id AND estornado=0),0)";
      const sums = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN c.dataVencimento < ? THEN ${saldoSQL} ELSE 0 END), 0) AS vencido,
        COALESCE(SUM(CASE WHEN c.dataVencimento = ? THEN ${saldoSQL} ELSE 0 END), 0) AS venceHoje,
        COALESCE(SUM(CASE WHEN c.dataVencimento > ? AND c.dataVencimento <= ? THEN ${saldoSQL} ELSE 0 END), 0) AS prox7,
        COALESCE(SUM(CASE WHEN c.dataVencimento > ? AND c.dataVencimento <= ? THEN ${saldoSQL} ELSE 0 END), 0) AS prox30,
        COALESCE(SUM(${saldoSQL}), 0) AS aberto
        FROM contas_a_receber c WHERE c.status IN ('aberta','parcial')`).get(
        hoje, hoje, hoje, d7.toISOString().slice(0,10), hoje, d30.toISOString().slice(0,10)
      );
      const recebidoMes = db.prepare(`SELECT COALESCE(SUM(valorPago), 0) AS total
        FROM contas_receber_pagamentos WHERE estornado = 0 AND dataPagamento >= ?`).get(mesIni);

      const porCategoria = db.prepare(`SELECT
        COALESCE(cat.nome, 'Sem categoria') AS nome, cat.icone,
        COUNT(*) AS qtd,
        SUM(${saldoSQL}) AS total
        FROM contas_a_receber c
        LEFT JOIN categorias_cr cat ON cat.id = c.categoriaId
        WHERE c.status IN ('aberta','parcial')
        GROUP BY cat.id, cat.nome, cat.icone ORDER BY total DESC`).all();

      const topClientes = db.prepare(`SELECT
        p.razaoSocial AS nome, COUNT(*) AS qtd, SUM(${saldoSQL}) AS total
        FROM contas_a_receber c
        LEFT JOIN pessoas p ON p.id = c.pessoaId
        WHERE c.status IN ('aberta','parcial')
        GROUP BY p.id ORDER BY total DESC LIMIT 5`).all();

      res.json({ success: true, resumo: {
        aberto: sums.aberto, vencido: sums.vencido,
        venceHoje: sums.venceHoje, prox7: sums.prox7, prox30: sums.prox30,
        recebidoMes: recebidoMes.total, porCategoria, topClientes
      }});
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-receber/csv', (req, res) => {
    try {
      const rows = db.prepare(`SELECT c.*, p.razaoSocial AS cliente, p.cpfCnpj,
          cat.nome AS categoria,
          COALESCE((SELECT SUM(valorPago) FROM contas_receber_pagamentos WHERE contaReceberId=c.id AND estornado=0), 0) AS totalPago
        FROM contas_a_receber c
        LEFT JOIN pessoas p ON p.id = c.pessoaId
        LEFT JOIN categorias_cr cat ON cat.id = c.categoriaId
        ORDER BY c.dataVencimento ASC`).all();
      const cols = ['id','cliente','cpfCnpj','descricao','categoria','valor','totalPago','dataEmissao','dataVencimento','dataPagamento','status','formaPagamento','origem','parcelaNumero','totalParcelas'];
      const header = cols.join(';');
      const body = rows.map(r => cols.map(c => {
        const v = r[c]; if (v == null) return '';
        return String(v).replace(/[;\n\r]/g, ' ');
      }).join(';')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contas-a-receber-${dataBrasilia()}.csv"`);
      res.send('\ufeff' + header + '\n' + body);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-receber/:id', (req, res) => {
    try {
      const conta = db.prepare(`SELECT c.*,
        CASE WHEN c.status IN ('aberta','parcial') AND c.dataVencimento < DATE('now','-3 hours') THEN 'vencida' ELSE c.status END AS statusReal,
        p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaCpfCnpj, p.email AS pessoaEmail,
        cat.nome AS categoriaNome, cat.icone AS categoriaIcone,
        n.nDPS AS nfseNumero, n.status AS nfseStatus
      FROM contas_a_receber c
      JOIN pessoas p ON p.id = c.pessoaId
      LEFT JOIN categorias_cr cat ON cat.id = c.categoriaId
      LEFT JOIN nfse n ON n.id = c.nfseId
      WHERE c.id = ?`).get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Não encontrada' });

      const pagamentos = db.prepare(`SELECT p.*, cf.nome AS contaFinanceiraNome
        FROM contas_receber_pagamentos p
        LEFT JOIN contas_financeiras cf ON cf.id = p.contaFinanceiraId
        WHERE p.contaReceberId = ? ORDER BY p.dataPagamento DESC, p.id DESC`).all(req.params.id);
      const anexos = db.prepare('SELECT * FROM contas_receber_anexos WHERE contaReceberId = ? ORDER BY dataUpload DESC').all(req.params.id);
      const boletos = db.prepare('SELECT * FROM boletos WHERE contaReceberId = ? ORDER BY id DESC').all(req.params.id);
      const parcelas = conta.grupoParcelaId
        ? db.prepare('SELECT id, descricao, parcelaNumero, valor, dataVencimento, status FROM contas_a_receber WHERE grupoParcelaId = ? ORDER BY parcelaNumero').all(conta.grupoParcelaId)
        : [];

      const totalPago = pagamentos.filter(p => !p.estornado).reduce((s,p) => s + Number(p.valorPago), 0);
      conta.totalPago = Number(totalPago.toFixed(2));
      conta.saldoRestante = Number((conta.valor - totalPago).toFixed(2));

      res.json({ success: true, conta, pagamentos, anexos, boletos, parcelas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== CRIAR / EDITAR / DUPLICAR / CANCELAR / REABRIR ==========
  app.post('/api/contas-a-receber', (req, res) => {
    try {
      const { pessoaId, categoriaId, descricao, valor, dataVencimento, dataEmissao,
              formaPagamento, observacoes, parcelas, intervaloMeses } = req.body || {};
      if (!pessoaId || !descricao || valor == null || !dataVencimento) {
        return res.status(400).json({ success: false, error: 'pessoaId, descricao, valor e dataVencimento obrigatórios' });
      }
      const pessoa = db.prepare('SELECT id FROM pessoas WHERE id = ? AND ativo = 1').get(Number(pessoaId));
      if (!pessoa) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

      const parcelasN = Math.max(1, Number(parcelas) || 1);
      const intervalo = Math.max(1, Number(intervaloMeses) || 1);
      const valorParcela = Number((Number(valor) / parcelasN).toFixed(2));
      const sobra = Number((Number(valor) - valorParcela * parcelasN).toFixed(2));
      const dataEmi = dataEmissao || dataBrasilia();
      const grupo = parcelasN > 1 ? (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) : null;

      const inseridas = [];
      const tx = db.transaction(() => {
        for (let i = 0; i < parcelasN; i++) {
          const d = new Date(dataVencimento + 'T12:00:00');
          d.setMonth(d.getMonth() + i * intervalo);
          const venc = d.toISOString().slice(0, 10);
          const vlr = (i === parcelasN - 1) ? (valorParcela + sobra) : valorParcela;
          const desc = parcelasN > 1 ? `${descricao} (${i+1}/${parcelasN})` : descricao;
          const r = db.prepare(`INSERT INTO contas_a_receber
            (pessoaId, categoriaId, descricao, valor, dataEmissao, dataVencimento,
             formaPagamento, observacoes, origem, status, parcelaNumero, totalParcelas, grupoParcelaId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'aberta', ?, ?, ?)`).run(
            Number(pessoaId), categoriaId ? Number(categoriaId) : null,
            desc, vlr, dataEmi, venc, formaPagamento || null, observacoes || null,
            parcelasN > 1 ? (i+1) : null, parcelasN > 1 ? parcelasN : null, grupo
          );
          inseridas.push(r.lastInsertRowid);
        }
      });
      tx();
      res.json({ success: true, ids: inseridas, parcelas: parcelasN });
    } catch (err) {
      console.error('[criar CR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/contas-a-receber/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (!['aberta','parcial'].includes(existing.status)) {
        return res.status(400).json({ success: false, error: 'Só contas abertas ou parciais podem ser editadas' });
      }
      const { descricao, valor, dataVencimento, formaPagamento, observacoes, pessoaId, categoriaId } = req.body || {};
      db.prepare(`UPDATE contas_a_receber SET
          descricao = ?, valor = ?, dataVencimento = ?,
          formaPagamento = ?, observacoes = ?,
          pessoaId = ?, categoriaId = ?,
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        descricao || existing.descricao,
        valor != null ? Number(valor) : existing.valor,
        dataVencimento || existing.dataVencimento,
        formaPagamento ?? existing.formaPagamento,
        observacoes ?? existing.observacoes,
        pessoaId ? Number(pessoaId) : existing.pessoaId,
        categoriaId != null ? Number(categoriaId) : existing.categoriaId,
        req.params.id
      );
      res.json({ success: true, conta: db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contas-a-receber/:id/duplicar', (req, res) => {
    try {
      const src = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!src) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      const d = new Date(dataBrasilia() + 'T12:00:00'); d.setDate(d.getDate() + 30);
      const r = db.prepare(`INSERT INTO contas_a_receber
        (pessoaId, categoriaId, descricao, valor, dataEmissao, dataVencimento,
         formaPagamento, observacoes, origem, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'aberta')`).run(
        src.pessoaId, src.categoriaId, src.descricao + ' (cópia)', src.valor,
        dataBrasilia(), d.toISOString().slice(0,10), src.formaPagamento, src.observacoes
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contas-a-receber/:id/cancelar', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (!['aberta','parcial'].includes(conta.status)) return res.status(400).json({ success: false, error: 'Só contas abertas/parciais podem ser canceladas' });
      const tx = db.transaction(() => {
        db.prepare(`UPDATE contas_a_receber SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
        db.prepare(`UPDATE boletos SET status = 'cancelado', dataAtualizacao = CURRENT_TIMESTAMP
          WHERE contaReceberId = ? AND status IN ('pendente','registrado')`).run(req.params.id);
      });
      tx();
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contas-a-receber/:id/reabrir', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (conta.status !== 'cancelada') return res.status(400).json({ success: false, error: 'Só canceladas podem ser reabertas' });
      db.prepare(`UPDATE contas_a_receber SET status = 'aberta', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== PAGAMENTO ==========
  app.post('/api/contas-a-receber/:id/baixar', (req, res) => {
    try {
      const { contaFinanceiraId, dataPagamento, valorBase, juros, multa, desconto,
              formaPagamento, parcial, observacoes } = req.body || {};
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (!['aberta','parcial'].includes(conta.status)) return res.status(400).json({ success: false, error: `Conta com status ${conta.status} não pode receber baixa` });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });

      const result = registrarBaixaCR(db, {
        contaReceberId: Number(req.params.id),
        valorBase, dataPagamento, contaFinanceiraId, formaPagamento,
        juros: Number(juros) || 0, multa: Number(multa) || 0, desconto: Number(desconto) || 0,
        observacoes, parcial, origem: 'manual',
        usuario: req.session?.username || null
      });

      // Se quitou totalmente, marca boletos pendentes como pagos (lógica preservada do v1)
      if (result.novoStatus === 'paga') {
        db.prepare(`UPDATE boletos SET status = 'pago', dataAtualizacao = CURRENT_TIMESTAMP
          WHERE contaReceberId = ? AND status IN ('pendente','registrado')`).run(req.params.id);
      }
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[baixar CR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-a-receber/:id/estornar-baixa', (req, res) => {
    try {
      const { pagamentoId } = req.body || {};
      if (!pagamentoId) return res.status(400).json({ success: false, error: 'pagamentoId obrigatório' });
      const pag = db.prepare('SELECT * FROM contas_receber_pagamentos WHERE id = ? AND contaReceberId = ?').get(pagamentoId, req.params.id);
      if (!pag) return res.status(404).json({ success: false, error: 'Pagamento não encontrado' });
      if (pag.estornado) return res.status(400).json({ success: false, error: 'Pagamento já estornado' });
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);

      const tx = db.transaction(() => {
        db.prepare(`UPDATE contas_receber_pagamentos SET estornado = 1, estornadoEm = CURRENT_TIMESTAMP WHERE id = ?`).run(pagamentoId);
        // CR-01 (2026-04-18): estorno como movimentação reversa, não DELETE.
        if (pag.movimentacaoFinanceiraId) {
          const mov = db.prepare('SELECT * FROM movimentacoes_financeiras WHERE id = ?').get(pag.movimentacaoFinanceiraId);
          if (mov) {
            lancarMovimentacao(db, {
              contaId: mov.contaId,
              tipo: mov.tipo === 'entrada' ? 'saida' : 'entrada',
              valor: mov.valor,
              data: dataBrasilia(),
              descricao: `Estorno baixa CR #${req.params.id} (mov original #${mov.id})`,
              origem: 'estorno_cr',
              origemId: pagamentoId,
              categoria: mov.categoria,
              usuario: req.session?.username || null
            });
          }
        }
        const restante = Number(db.prepare(`SELECT COALESCE(SUM(valorBase), 0) AS t
          FROM contas_receber_pagamentos WHERE contaReceberId = ? AND estornado = 0`).get(req.params.id).t);
        const novoStatus = restante <= 0 ? 'aberta' : (restante < conta.valor - 0.01 ? 'parcial' : 'paga');
        db.prepare(`UPDATE contas_a_receber SET status = ?, valorPago = ?,
          dataPagamento = CASE WHEN ? = 'paga' THEN dataPagamento ELSE NULL END,
          dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(novoStatus, restante, novoStatus, req.params.id);
      });
      tx();
      res.json({ success: true });
    } catch (err) {
      console.error('[estornar CR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-a-receber/baixar-lote', (req, res) => {
    try {
      const { ids, contaFinanceiraId, dataPagamento, formaPagamento } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids obrigatórios' });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });

      const dp = dataPagamento || dataBrasilia();
      const sucessos = [], falhas = [];
      const tx = db.transaction(() => {
        for (const id of ids) {
          try {
            const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(id);
            if (!conta || !['aberta','parcial'].includes(conta.status)) { falhas.push({ id, erro: 'status inválido' }); continue; }
            registrarBaixaCR(db, {
              contaReceberId: id, dataPagamento: dp, contaFinanceiraId,
              formaPagamento: formaPagamento || null, origem: 'lote',
              usuario: req.session?.username || null
            });
            db.prepare(`UPDATE boletos SET status = 'pago', dataAtualizacao = CURRENT_TIMESTAMP
              WHERE contaReceberId = ? AND status IN ('pendente','registrado')`).run(id);
            sucessos.push(id);
          } catch (e) { falhas.push({ id, erro: e.message }); }
        }
      });
      tx();
      res.json({ success: true, sucessos, falhas });
    } catch (err) {
      console.error('[baixar-lote CR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ========== ANEXOS ==========
  app.post('/api/contas-a-receber/:id/anexos', uploadAnexo.single('arquivo'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'arquivo obrigatório' });
      const tipo = req.body.tipo || 'outro';
      const rel = path.relative(path.join(__dirname, 'public'), req.file.path).replace(/\\/g,'/');
      const r = db.prepare(`INSERT INTO contas_receber_anexos
        (contaReceberId, nomeOriginal, caminho, mimeType, tamanho, tipo)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        req.params.id, req.file.originalname, rel, req.file.mimetype, req.file.size, tipo
      );
      res.json({ success: true, anexo: db.prepare('SELECT * FROM contas_receber_anexos WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-receber/:id/anexos', (req, res) => {
    try {
      const anexos = db.prepare('SELECT * FROM contas_receber_anexos WHERE contaReceberId = ? ORDER BY dataUpload DESC').all(req.params.id);
      res.json({ success: true, anexos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-receber/anexos/:anexoId/download', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM contas_receber_anexos WHERE id = ?').get(req.params.anexoId);
      if (!a) return res.status(404).json({ success: false, error: 'Anexo não encontrado' });
      res.download(path.join(__dirname, 'public', a.caminho), a.nomeOriginal);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/contas-a-receber/anexos/:anexoId', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM contas_receber_anexos WHERE id = ?').get(req.params.anexoId);
      if (!a) return res.status(404).json({ success: false, error: 'Anexo não encontrado' });
      const abs = path.join(__dirname, 'public', a.caminho);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      db.prepare('DELETE FROM contas_receber_anexos WHERE id = ?').run(req.params.anexoId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasContasReceber: registrarRotas, registrarBaixaCR };
