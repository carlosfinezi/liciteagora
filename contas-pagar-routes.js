/**
 * contas-pagar-routes.js — Módulo completo de Contas a Pagar
 *
 * Registra rotas em server.js:
 *   const { registrarRotasContasPagar } = require('./contas-pagar-routes');
 *   registrarRotasContasPagar(app, db);
 *
 * Dependências: contas-financeiras-routes.js (lancarMovimentacao),
 * tabela fornecedores, contas_financeiras, movimentacoes_financeiras.
 *
 * Geração de recorrências: o módulo inicia um setInterval no boot que roda
 * gerarContasRecorrentes(db) 1x ao carregar + a cada 6h.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { lancarMovimentacao } = require('./contas-financeiras-routes');

// ==================== HELPERS ====================

function dataBrasilia() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function alterSafe(db, sql) {
  try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

// Avança uma data YYYY-MM-DD pela frequência escolhida, respeitando o dia
// do mês ou valor informado. Retorna nova string YYYY-MM-DD.
// CP-02 (2026-04-18): throw para frequência desconhecida em vez de retornar
// a data original (causava loop infinito de recorrência mensal no scheduler).
function proximaOcorrencia(base, frequencia, diaMes) {
  const d = new Date(base + 'T12:00:00');
  if (frequencia === 'mensal') {
    d.setMonth(d.getMonth() + 1);
    if (diaMes) d.setDate(Math.min(diaMes, 28));
  } else if (frequencia === 'quinzenal') {
    d.setDate(d.getDate() + 14);
  } else if (frequencia === 'semanal') {
    d.setDate(d.getDate() + 7);
  } else if (frequencia === 'anual') {
    d.setFullYear(d.getFullYear() + 1);
  } else if (frequencia === 'bimestral') {
    d.setMonth(d.getMonth() + 2);
  } else if (frequencia === 'trimestral') {
    d.setMonth(d.getMonth() + 3);
  } else if (frequencia === 'semestral') {
    d.setMonth(d.getMonth() + 6);
  } else {
    throw new Error(`Frequência de recorrência desconhecida: ${frequencia}`);
  }
  return d.toISOString().slice(0, 10);
}

// ==================== MIGRAÇÕES ====================

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categorias_cp (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      icone TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contas_pagar_pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaPagarId INTEGER NOT NULL,
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
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaPagarId) REFERENCES contas_a_pagar(id),
      FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cpp_conta ON contas_pagar_pagamentos(contaPagarId);

    CREATE TABLE IF NOT EXISTS contas_pagar_anexos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaPagarId INTEGER NOT NULL,
      nomeOriginal TEXT NOT NULL,
      caminho TEXT NOT NULL,
      mimeType TEXT,
      tamanho INTEGER,
      tipo TEXT,
      dataUpload TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaPagarId) REFERENCES contas_a_pagar(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cpa_conta ON contas_pagar_anexos(contaPagarId);

    CREATE TABLE IF NOT EXISTS contas_pagar_recorrencias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fornecedorId INTEGER NOT NULL,
      categoriaId INTEGER,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL,
      frequencia TEXT NOT NULL,
      diaVencimento INTEGER,
      proximaGeracao TEXT,
      ultimaGeracao TEXT,
      ativo INTEGER DEFAULT 1,
      formaPagamentoPadrao TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fornecedorId) REFERENCES fornecedores(id),
      FOREIGN KEY (categoriaId) REFERENCES categorias_cp(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cpr_ativo ON contas_pagar_recorrencias(ativo);
  `);

  // Colunas novas em contas_a_pagar
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN categoriaId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN parcelaNumero INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN totalParcelas INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN grupoParcelaId TEXT');
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN recorrenciaId INTEGER');

  // Seed de categorias padrão
  const categoriasPadrao = [
    { nome: 'Energia', icone: '💡' },
    { nome: 'Água', icone: '💧' },
    { nome: 'Telefone/Internet', icone: '📞' },
    { nome: 'Aluguel', icone: '🏠' },
    { nome: 'Salário/Pró-labore', icone: '👥' },
    { nome: 'Impostos', icone: '📋' },
    { nome: 'Fornecedores', icone: '📦' },
    { nome: 'Serviços', icone: '🔧' },
    { nome: 'Outros', icone: '📌' }
  ];
  const stmt = db.prepare('INSERT OR IGNORE INTO categorias_cp (nome, icone) VALUES (?, ?)');
  for (const c of categoriasPadrao) stmt.run(c.nome, c.icone);

  // Backfill: para contas pagas v1 sem histórico em contas_pagar_pagamentos
  const pagasSemHistorico = db.prepare(`
    SELECT c.* FROM contas_a_pagar c
    WHERE c.status = 'paga' AND c.dataPagamento IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM contas_pagar_pagamentos p WHERE p.contaPagarId = c.id)
  `).all();
  for (const c of pagasSemHistorico) {
    db.prepare(`INSERT INTO contas_pagar_pagamentos
      (contaPagarId, dataPagamento, valorPago, valorBase, formaPagamento,
       contaFinanceiraId, observacoes)
      VALUES (?, ?, ?, ?, ?, ?, 'backfill v1')`).run(
      c.id, c.dataPagamento, c.valorPago || c.valor, c.valorPago || c.valor,
      c.formaPagamento, c.contaFinanceiraId || 0
    );
  }
}

// ==================== JOB RECORRÊNCIAS ====================

function gerarContasRecorrentes(db) {
  const hoje = dataBrasilia();
  const pendentes = db.prepare(`
    SELECT * FROM contas_pagar_recorrencias
    WHERE ativo = 1 AND proximaGeracao IS NOT NULL AND proximaGeracao <= ?
  `).all(hoje);

  let geradas = 0;
  for (const rec of pendentes) {
    try {
      // Gera para cada ocorrência vencida (ex: se ficou sem rodar 2 meses, gera 2)
      let prox = rec.proximaGeracao;
      while (prox <= hoje) {
        const desc = `${rec.descricao} (${prox.slice(0,7)})`;
        db.prepare(`INSERT INTO contas_a_pagar
          (fornecedorId, categoriaId, descricao, valor, dataEmissao, dataVencimento,
           formaPagamento, observacoes, status, origem, recorrenciaId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberta', 'recorrente', ?)`).run(
          rec.fornecedorId, rec.categoriaId || null, desc, rec.valor,
          hoje, prox, rec.formaPagamentoPadrao || null, rec.observacoes || null, rec.id
        );
        geradas++;
        prox = proximaOcorrencia(prox, rec.frequencia, rec.diaVencimento);
      }
      db.prepare(`UPDATE contas_pagar_recorrencias
        SET ultimaGeracao = ?, proximaGeracao = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(hoje, prox, rec.id);
    } catch (e) {
      console.error('[cp-recorrencias] erro recorrencia', rec.id, e.message);
    }
  }
  if (geradas) console.log(`[cp-recorrencias] ${geradas} conta(s) gerada(s) de ${pendentes.length} template(s)`);
  return geradas;
}

// ==================== MULTER (anexos) ====================

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'cp');
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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const ok = /pdf|image|octet-stream/i.test(file.mimetype) ||
      /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Apenas PDF ou imagens'), ok);
  }
});

// ==================== ROTAS ====================

function registrarRotas(app, db) {
  migrar(db);

  // Job recorrências: roda no boot e a cada 6h
  setTimeout(() => gerarContasRecorrentes(db), 5000);
  setInterval(() => gerarContasRecorrentes(db), 6 * 60 * 60 * 1000);

  // ========== CATEGORIAS ==========

  app.get('/api/cp-categorias', (req, res) => {
    try {
      const rows = db.prepare(`SELECT c.*, pc.codigo AS planoContaCodigo, pc.nome AS planoContaNome
        FROM categorias_cp c LEFT JOIN plano_contas pc ON pc.id = c.planoContaId
        WHERE c.ativo = 1 ORDER BY c.nome ASC`).all();
      res.json({ success: true, categorias: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cp-categorias', (req, res) => {
    try {
      const { nome, icone, planoContaId } = req.body || {};
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare('INSERT INTO categorias_cp (nome, icone, planoContaId) VALUES (?, ?, ?)')
        .run(nome.trim(), icone || null, planoContaId ? Number(planoContaId) : null);
      res.json({ success: true, categoria: db.prepare('SELECT * FROM categorias_cp WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/cp-categorias/:id', (req, res) => {
    try {
      const { nome, icone, planoContaId } = req.body || {};
      db.prepare(`UPDATE categorias_cp SET
          nome = COALESCE(?, nome),
          icone = COALESCE(?, icone),
          planoContaId = ?
        WHERE id = ?`)
        .run(nome || null, icone || null,
             planoContaId !== undefined ? (planoContaId ? Number(planoContaId) : null) : null,
             req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/cp-categorias/:id', (req, res) => {
    try {
      db.prepare('UPDATE categorias_cp SET ativo = 0 WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== CONTAS A PAGAR — LISTAGEM / DETALHE ==========

  app.get('/api/contas-a-pagar', (req, res) => {
    try {
      const { status, fornecedorId, categoriaId, vencAte,
              dataVencIni, dataVencFim, dataPagIni, dataPagFim,
              origem, formaPagamento, busca } = req.query;
      let sql = `SELECT cp.*,
                   f.razaoSocial AS fornecedorNome, f.cpfCnpj AS fornecedorCnpj,
                   n.numero AS nfeNumero, n.serie AS nfeSerie,
                   cat.nome AS categoriaNome, cat.icone AS categoriaIcone,
                   COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos
                             WHERE contaPagarId = cp.id AND estornado = 0), 0) AS totalPago,
                   (SELECT COUNT(*) FROM contas_pagar_anexos WHERE contaPagarId = cp.id) AS totalAnexos
                 FROM contas_a_pagar cp
                 LEFT JOIN fornecedores f ON f.id = cp.fornecedorId
                 LEFT JOIN nfe_entrada n ON n.id = cp.nfeEntradaId
                 LEFT JOIN categorias_cp cat ON cat.id = cp.categoriaId
                 WHERE 1=1`;
      const p = [];
      if (status) {
        if (status === 'vencida') {
          sql += ` AND cp.status IN ('aberta','parcial') AND cp.dataVencimento < DATE('now','-3 hours')`;
        } else {
          sql += ' AND cp.status = ?'; p.push(status);
        }
      }
      if (fornecedorId) { sql += ' AND cp.fornecedorId = ?'; p.push(Number(fornecedorId)); }
      if (categoriaId)  { sql += ' AND cp.categoriaId = ?'; p.push(Number(categoriaId)); }
      if (origem)       { sql += ' AND cp.origem = ?'; p.push(origem); }
      if (formaPagamento){ sql += ' AND cp.formaPagamento = ?'; p.push(formaPagamento); }
      if (dataVencIni)  { sql += ' AND cp.dataVencimento >= ?'; p.push(dataVencIni); }
      if (dataVencFim)  { sql += ' AND cp.dataVencimento <= ?'; p.push(dataVencFim); }
      if (vencAte)      { sql += ' AND cp.dataVencimento <= ?'; p.push(vencAte); }
      if (dataPagIni)   { sql += ' AND cp.dataPagamento >= ?'; p.push(dataPagIni); }
      if (dataPagFim)   { sql += ' AND cp.dataPagamento <= ?'; p.push(dataPagFim); }
      if (busca) {
        sql += ' AND (f.razaoSocial LIKE ? OR cp.descricao LIKE ?)';
        const t = '%' + busca + '%'; p.push(t, t);
      }
      sql += ' ORDER BY cp.dataVencimento ASC, cp.id DESC LIMIT 500';
      const contas = db.prepare(sql).all(...p).map(c => ({ ...c, saldoRestante: Number((c.valor - c.totalPago).toFixed(2)) }));
      res.json({ success: true, contas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-pagar/resumo', (req, res) => {
    try {
      const hoje = dataBrasilia();
      const d7 = new Date(hoje + 'T12:00:00'); d7.setDate(d7.getDate() + 7);
      const d30 = new Date(hoje + 'T12:00:00'); d30.setDate(d30.getDate() + 30);
      const mesIni = hoje.slice(0,7) + '-01';

      const sumAbertas = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN cp.dataVencimento < ? THEN cp.valor - COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0),0) ELSE 0 END), 0) AS vencido,
        COALESCE(SUM(CASE WHEN cp.dataVencimento = ? THEN cp.valor - COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0),0) ELSE 0 END), 0) AS venceHoje,
        COALESCE(SUM(CASE WHEN cp.dataVencimento > ? AND cp.dataVencimento <= ? THEN cp.valor - COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0),0) ELSE 0 END), 0) AS prox7,
        COALESCE(SUM(CASE WHEN cp.dataVencimento > ? AND cp.dataVencimento <= ? THEN cp.valor - COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0),0) ELSE 0 END), 0) AS prox30,
        COALESCE(SUM(cp.valor - COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0),0)), 0) AS aberto
        FROM contas_a_pagar cp
        WHERE cp.status IN ('aberta','parcial')`).get(
        hoje, hoje, hoje, d7.toISOString().slice(0,10),
        hoje, d30.toISOString().slice(0,10)
      );

      const pagoMes = db.prepare(`SELECT COALESCE(SUM(valorPago), 0) AS total
        FROM contas_pagar_pagamentos WHERE estornado = 0 AND dataPagamento >= ?`).get(mesIni);

      const porCategoria = db.prepare(`SELECT
        COALESCE(cat.nome, 'Sem categoria') AS nome,
        cat.icone,
        COUNT(*) AS qtd,
        SUM(cp.valor - COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0),0)) AS total
        FROM contas_a_pagar cp
        LEFT JOIN categorias_cp cat ON cat.id = cp.categoriaId
        WHERE cp.status IN ('aberta','parcial')
        GROUP BY cat.id, cat.nome, cat.icone ORDER BY total DESC`).all();

      const topFornecedores = db.prepare(`SELECT
        f.razaoSocial AS nome, COUNT(*) AS qtd,
        SUM(cp.valor - COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0),0)) AS total
        FROM contas_a_pagar cp
        LEFT JOIN fornecedores f ON f.id = cp.fornecedorId
        WHERE cp.status IN ('aberta','parcial')
        GROUP BY f.id ORDER BY total DESC LIMIT 5`).all();

      res.json({ success: true, resumo: {
        aberto: sumAbertas.aberto, vencido: sumAbertas.vencido,
        venceHoje: sumAbertas.venceHoje, prox7: sumAbertas.prox7, prox30: sumAbertas.prox30,
        pagoMes: pagoMes.total, porCategoria, topFornecedores
      }});
    } catch (err) {
      console.error('[cp-resumo]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-a-pagar/csv', (req, res) => {
    try {
      const rows = db.prepare(`SELECT cp.*, f.razaoSocial AS fornecedor, f.cpfCnpj,
          cat.nome AS categoria,
          COALESCE((SELECT SUM(valorPago) FROM contas_pagar_pagamentos WHERE contaPagarId=cp.id AND estornado=0), 0) AS totalPago
        FROM contas_a_pagar cp
        LEFT JOIN fornecedores f ON f.id = cp.fornecedorId
        LEFT JOIN categorias_cp cat ON cat.id = cp.categoriaId
        ORDER BY cp.dataVencimento ASC`).all();
      const cols = ['id','fornecedor','cpfCnpj','descricao','categoria','valor','totalPago','dataEmissao','dataVencimento','dataPagamento','status','formaPagamento','origem','parcelaNumero','totalParcelas'];
      const header = cols.join(';');
      const body = rows.map(r => cols.map(c => {
        const v = r[c];
        if (v == null) return '';
        return String(v).replace(/[;\n\r]/g, ' ');
      }).join(';')).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="contas-a-pagar-${dataBrasilia()}.csv"`);
      res.send('\ufeff' + header + '\n' + body);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-pagar/:id', (req, res) => {
    try {
      const conta = db.prepare(`SELECT cp.*,
          f.razaoSocial AS fornecedorNome, f.cpfCnpj AS fornecedorCnpj,
          n.numero AS nfeNumero, n.serie AS nfeSerie, n.chaveAcesso AS nfeChave,
          cat.nome AS categoriaNome, cat.icone AS categoriaIcone,
          pc.codigo AS planoContaCodigo, pc.nome AS planoContaNome,
          cc.codigo AS centroCustoCodigo, cc.nome AS centroCustoNome
        FROM contas_a_pagar cp
        LEFT JOIN fornecedores f ON f.id = cp.fornecedorId
        LEFT JOIN nfe_entrada n ON n.id = cp.nfeEntradaId
        LEFT JOIN categorias_cp cat ON cat.id = cp.categoriaId
        LEFT JOIN plano_contas pc ON pc.id = cp.planoContaId
        LEFT JOIN centros_custo cc ON cc.id = cp.centroCustoId
        WHERE cp.id = ?`).get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Não encontrada' });

      const pagamentos = db.prepare(`SELECT p.*, cf.nome AS contaFinanceiraNome
        FROM contas_pagar_pagamentos p
        LEFT JOIN contas_financeiras cf ON cf.id = p.contaFinanceiraId
        WHERE p.contaPagarId = ? ORDER BY p.dataPagamento DESC, p.id DESC`).all(req.params.id);
      const anexos = db.prepare('SELECT * FROM contas_pagar_anexos WHERE contaPagarId = ? ORDER BY dataUpload DESC').all(req.params.id);
      const parcelas = conta.grupoParcelaId
        ? db.prepare('SELECT id, descricao, parcelaNumero, valor, dataVencimento, status FROM contas_a_pagar WHERE grupoParcelaId = ? ORDER BY parcelaNumero').all(conta.grupoParcelaId)
        : [];

      const totalPago = pagamentos.filter(p => !p.estornado).reduce((s,p) => s + Number(p.valorPago), 0);
      conta.totalPago = Number(totalPago.toFixed(2));
      conta.saldoRestante = Number((conta.valor - totalPago).toFixed(2));

      res.json({ success: true, conta, pagamentos, anexos, parcelas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== CRIAR / EDITAR / DUPLICAR / CANCELAR ==========

  app.post('/api/contas-a-pagar', (req, res) => {
    try {
      const { fornecedorId, categoriaId, descricao, valor, dataVencimento, dataEmissao,
              formaPagamento, observacoes, parcelas, intervaloMeses,
              planoContaId, centroCustoId } = req.body || {};
      if (!fornecedorId || !descricao || valor == null || !dataVencimento) {
        return res.status(400).json({ success: false, error: 'fornecedorId, descricao, valor e dataVencimento obrigatórios' });
      }
      const fornec = db.prepare('SELECT id FROM fornecedores WHERE id = ? AND ativo = 1').get(Number(fornecedorId));
      if (!fornec) return res.status(404).json({ success: false, error: 'Fornecedor não encontrado' });

      // Plano 12: fallback — se planoContaId não veio mas categoria tem mapeamento, usa
      let planoId = planoContaId ? Number(planoContaId) : null;
      if (!planoId && categoriaId) {
        const cat = db.prepare('SELECT planoContaId FROM categorias_cp WHERE id = ?').get(Number(categoriaId));
        if (cat?.planoContaId) planoId = cat.planoContaId;
      }

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
          const r = db.prepare(`INSERT INTO contas_a_pagar
            (fornecedorId, categoriaId, planoContaId, centroCustoId, descricao, valor, dataEmissao, dataVencimento,
             formaPagamento, observacoes, origem, status, parcelaNumero, totalParcelas, grupoParcelaId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'aberta', ?, ?, ?)`).run(
            Number(fornecedorId), categoriaId ? Number(categoriaId) : null,
            planoId, centroCustoId ? Number(centroCustoId) : null,
            desc, vlr, dataEmi, venc, formaPagamento || null, observacoes || null,
            parcelasN > 1 ? (i+1) : null, parcelasN > 1 ? parcelasN : null, grupo
          );
          inseridas.push(r.lastInsertRowid);
        }
      });
      tx();
      res.json({ success: true, ids: inseridas, parcelas: parcelasN });
    } catch (err) {
      console.error('[criar CP]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/contas-a-pagar/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (!['aberta','parcial'].includes(existing.status)) {
        return res.status(400).json({ success: false, error: 'Só contas abertas ou parciais podem ser editadas' });
      }
      const { descricao, valor, dataVencimento, formaPagamento, observacoes, fornecedorId,
              categoriaId, planoContaId, centroCustoId } = req.body || {};
      db.prepare(`UPDATE contas_a_pagar SET
          descricao = ?, valor = ?, dataVencimento = ?,
          formaPagamento = ?, observacoes = ?,
          fornecedorId = ?, categoriaId = ?, planoContaId = ?, centroCustoId = ?,
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        descricao || existing.descricao,
        valor != null ? Number(valor) : existing.valor,
        dataVencimento || existing.dataVencimento,
        formaPagamento ?? existing.formaPagamento,
        observacoes ?? existing.observacoes,
        fornecedorId ? Number(fornecedorId) : existing.fornecedorId,
        categoriaId != null ? Number(categoriaId) : existing.categoriaId,
        planoContaId !== undefined ? (planoContaId ? Number(planoContaId) : null) : existing.planoContaId,
        centroCustoId !== undefined ? (centroCustoId ? Number(centroCustoId) : null) : existing.centroCustoId,
        req.params.id
      );
      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      res.json({ success: true, conta });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contas-a-pagar/:id/duplicar', (req, res) => {
    try {
      const src = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!src) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      const d = new Date(dataBrasilia() + 'T12:00:00'); d.setDate(d.getDate() + 30);
      const venc = d.toISOString().slice(0, 10);
      const r = db.prepare(`INSERT INTO contas_a_pagar
        (fornecedorId, categoriaId, descricao, valor, dataEmissao, dataVencimento,
         formaPagamento, observacoes, origem, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'aberta')`).run(
        src.fornecedorId, src.categoriaId, src.descricao + ' (cópia)', src.valor,
        dataBrasilia(), venc, src.formaPagamento, src.observacoes
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contas-a-pagar/:id/cancelar', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (!['aberta','parcial'].includes(conta.status)) return res.status(400).json({ success: false, error: 'Só contas abertas/parciais podem ser canceladas' });
      db.prepare(`UPDATE contas_a_pagar SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== PAGAMENTO ==========

  app.post('/api/contas-a-pagar/:id/baixar', (req, res) => {
    try {
      const { contaFinanceiraId, dataPagamento, valorBase, juros, multa, desconto,
              formaPagamento, parcial, observacoes } = req.body || {};
      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (!['aberta','parcial'].includes(conta.status)) return res.status(400).json({ success: false, error: `Conta com status ${conta.status} não pode receber baixa` });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });

      // Alçada (governança): pagamento acima do limite exige aprovação prévia
      const { verificarAlcada } = require('./governanca-routes');
      const valorAlcada = (valorBase !== undefined && valorBase !== null && valorBase !== '') ? Number(valorBase) : Number(conta.valor - (conta.valorPago || 0));
      const alcada = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: conta.id, valor: valorAlcada, usuario: req.session?.username });
      if (!alcada.liberado) {
        return res.status(403).json({ success: false,
          error: alcada.status === 'reprovada'
            ? 'Pagamento reprovado pela alçada'
            : `Pagamento acima da alçada (R$ ${alcada.regra.limiteValor.toFixed(2)}) — aprovação #${alcada.aprovacaoId} pendente`,
          aprovacaoId: alcada.aprovacaoId, statusAprovacao: alcada.status });
      }

      const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });

      const jaPago = Number(db.prepare(`SELECT COALESCE(SUM(valorBase), 0) AS t
        FROM contas_pagar_pagamentos WHERE contaPagarId = ? AND estornado = 0`).get(req.params.id).t) || 0;
      const saldoAberto = Number((conta.valor - jaPago).toFixed(2));

      // CP-06 (2026-04-18): em vez de silenciosamente truncar valorBase ao saldo
      // aberto, rejeita com 400 quando o cliente envia valor acima. Isso evita
      // perda de registro (exemplo: cliente queria pagar 300 numa conta de 100
      // e o sistema aceitava 100 sem aviso, sem criar outra conta para 200).
      const vBaseSolicitado = (valorBase !== undefined && valorBase !== null && valorBase !== '') ? Number(valorBase) : saldoAberto;
      if (!Number.isFinite(vBaseSolicitado) || vBaseSolicitado <= 0) {
        return res.status(400).json({ success: false, error: 'valorBase deve ser positivo' });
      }
      if (vBaseSolicitado > saldoAberto + 0.01) {
        return res.status(400).json({ success: false, error: `valorBase (${vBaseSolicitado.toFixed(2)}) maior que saldo aberto (${saldoAberto.toFixed(2)})` });
      }
      const vBase = Math.min(vBaseSolicitado, saldoAberto);
      const vJuros = Number(juros) || 0;
      const vMulta = Number(multa) || 0;
      const vDesc = Number(desconto) || 0;
      const vPago = Number((vBase + vJuros + vMulta - vDesc).toFixed(2));
      if (vPago <= 0) return res.status(400).json({ success: false, error: 'Valor a pagar deve ser positivo' });

      const dp = dataPagamento || dataBrasilia();
      const novoJaPago = Number((jaPago + vBase).toFixed(2));
      const novoStatus = (parcial || novoJaPago < conta.valor - 0.01) ? 'parcial' : 'paga';

      let pagamentoId, movId;
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO contas_pagar_pagamentos
          (contaPagarId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
           formaPagamento, contaFinanceiraId, observacoes, usuario)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          req.params.id, dp, vPago, vBase, vJuros, vMulta, vDesc,
          formaPagamento || null, contaFinanceiraId, observacoes || null,
          req.session?.username || null
        );
        pagamentoId = r.lastInsertRowid;

        movId = lancarMovimentacao(db, {
          contaId: contaFinanceiraId,
          tipo: 'saida', valor: vPago, data: dp,
          descricao: `Pagto CP: ${conta.descricao}`,
          origem: 'baixa_cp', origemId: conta.id,
          categoria: 'fornecedores',
          usuario: req.session?.username || null
        });

        db.prepare('UPDATE contas_pagar_pagamentos SET movimentacaoFinanceiraId = ? WHERE id = ?').run(movId, pagamentoId);

        db.prepare(`UPDATE contas_a_pagar SET status = ?,
          valorPago = ?, dataPagamento = CASE WHEN ? = 'paga' THEN ? ELSE dataPagamento END,
          formaPagamento = COALESCE(?, formaPagamento),
          contaFinanceiraId = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?`).run(
          novoStatus, novoJaPago, novoStatus, dp, formaPagamento || null, contaFinanceiraId, req.params.id
        );
      });
      tx();

      res.json({ success: true, pagamentoId, movimentacaoFinanceiraId: movId, novoStatus, saldoRestante: Number((conta.valor - novoJaPago).toFixed(2)) });
    } catch (err) {
      console.error('[baixar CP]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-a-pagar/:id/estornar-baixa', (req, res) => {
    try {
      const { pagamentoId } = req.body || {};
      if (!pagamentoId) return res.status(400).json({ success: false, error: 'pagamentoId obrigatório' });

      const pag = db.prepare('SELECT * FROM contas_pagar_pagamentos WHERE id = ? AND contaPagarId = ?').get(pagamentoId, req.params.id);
      if (!pag) return res.status(404).json({ success: false, error: 'Pagamento não encontrado' });
      if (pag.estornado) return res.status(400).json({ success: false, error: 'Pagamento já estornado' });

      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);

      const tx = db.transaction(() => {
        db.prepare(`UPDATE contas_pagar_pagamentos SET estornado = 1, estornadoEm = CURRENT_TIMESTAMP WHERE id = ?`).run(pagamentoId);
        // CP-03 (2026-04-18): estorno lança MOVIMENTAÇÃO REVERSA em vez de DELETE.
        // DELETE destruía o histórico de auditoria bancária. Agora a movimentação
        // original permanece e uma nova entrada (oposto da saída) a anula.
        if (pag.movimentacaoFinanceiraId) {
          const mov = db.prepare('SELECT * FROM movimentacoes_financeiras WHERE id = ?').get(pag.movimentacaoFinanceiraId);
          if (mov) {
            lancarMovimentacao(db, {
              contaId: mov.contaId,
              tipo: mov.tipo === 'saida' ? 'entrada' : 'saida',
              valor: mov.valor,
              data: dataBrasilia(),
              descricao: `Estorno pagto CP #${req.params.id} (mov original #${mov.id})`,
              origem: 'estorno_cp',
              origemId: pagamentoId,
              categoria: mov.categoria,
              usuario: req.session?.username || null
            });
          }
        }
        // Recalcula status
        const restante = Number(db.prepare(`SELECT COALESCE(SUM(valorBase), 0) AS t
          FROM contas_pagar_pagamentos WHERE contaPagarId = ? AND estornado = 0`).get(req.params.id).t);
        const novoStatus = restante <= 0 ? 'aberta' : (restante < conta.valor - 0.01 ? 'parcial' : 'paga');
        db.prepare(`UPDATE contas_a_pagar SET status = ?, valorPago = ?,
          dataPagamento = CASE WHEN ? = 'paga' THEN dataPagamento ELSE NULL END,
          dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(novoStatus, restante, novoStatus, req.params.id);
      });
      tx();
      res.json({ success: true });
    } catch (err) {
      console.error('[estornar CP]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-a-pagar/baixar-lote', (req, res) => {
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
            const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(id);
            if (!conta || !['aberta','parcial'].includes(conta.status)) { falhas.push({ id, erro: 'status inválido' }); continue; }
            const jaPago = Number(db.prepare(`SELECT COALESCE(SUM(valorBase), 0) AS t
              FROM contas_pagar_pagamentos WHERE contaPagarId = ? AND estornado = 0`).get(id).t) || 0;
            const saldo = Number((conta.valor - jaPago).toFixed(2));
            if (saldo <= 0) { falhas.push({ id, erro: 'sem saldo' }); continue; }

            const r = db.prepare(`INSERT INTO contas_pagar_pagamentos
              (contaPagarId, dataPagamento, valorPago, valorBase, formaPagamento, contaFinanceiraId, usuario)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, dp, saldo, saldo, formaPagamento || null, contaFinanceiraId, req.session?.username || null);
            const movId = lancarMovimentacao(db, {
              contaId: contaFinanceiraId, tipo: 'saida', valor: saldo, data: dp,
              descricao: `Pagto CP (lote): ${conta.descricao}`,
              origem: 'baixa_cp', origemId: conta.id, categoria: 'fornecedores',
              usuario: req.session?.username || null
            });
            db.prepare('UPDATE contas_pagar_pagamentos SET movimentacaoFinanceiraId = ? WHERE id = ?').run(movId, r.lastInsertRowid);
            db.prepare(`UPDATE contas_a_pagar SET status = 'paga', valorPago = ?, dataPagamento = ?,
              formaPagamento = COALESCE(?, formaPagamento), contaFinanceiraId = ?,
              dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(conta.valor, dp, formaPagamento || null, contaFinanceiraId, id);
            sucessos.push(id);
          } catch (e) { falhas.push({ id, erro: e.message }); }
        }
      });
      tx();
      res.json({ success: true, sucessos, falhas });
    } catch (err) {
      console.error('[baixar-lote]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ========== ANEXOS ==========

  app.post('/api/contas-a-pagar/:id/anexos', uploadAnexo.single('arquivo'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'arquivo obrigatório' });
      const tipo = req.body.tipo || 'outro';
      const rel = path.relative(path.join(__dirname, 'public'), req.file.path).replace(/\\/g,'/');
      const r = db.prepare(`INSERT INTO contas_pagar_anexos
        (contaPagarId, nomeOriginal, caminho, mimeType, tamanho, tipo)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        req.params.id, req.file.originalname, rel, req.file.mimetype, req.file.size, tipo
      );
      res.json({ success: true, anexo: db.prepare('SELECT * FROM contas_pagar_anexos WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) {
      console.error('[upload anexo]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-a-pagar/:id/anexos', (req, res) => {
    try {
      const anexos = db.prepare('SELECT * FROM contas_pagar_anexos WHERE contaPagarId = ? ORDER BY dataUpload DESC').all(req.params.id);
      res.json({ success: true, anexos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-pagar/anexos/:anexoId/download', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM contas_pagar_anexos WHERE id = ?').get(req.params.anexoId);
      if (!a) return res.status(404).json({ success: false, error: 'Anexo não encontrado' });
      const abs = path.join(__dirname, 'public', a.caminho);
      res.download(abs, a.nomeOriginal);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/contas-a-pagar/anexos/:anexoId', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM contas_pagar_anexos WHERE id = ?').get(req.params.anexoId);
      if (!a) return res.status(404).json({ success: false, error: 'Anexo não encontrado' });
      const abs = path.join(__dirname, 'public', a.caminho);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      db.prepare('DELETE FROM contas_pagar_anexos WHERE id = ?').run(req.params.anexoId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== RECORRÊNCIAS ==========

  app.get('/api/cp-recorrencias', (req, res) => {
    try {
      const rows = db.prepare(`SELECT r.*, f.razaoSocial AS fornecedorNome, c.nome AS categoriaNome
        FROM contas_pagar_recorrencias r
        LEFT JOIN fornecedores f ON f.id = r.fornecedorId
        LEFT JOIN categorias_cp c ON c.id = r.categoriaId
        ORDER BY r.ativo DESC, r.descricao ASC`).all();
      res.json({ success: true, recorrencias: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cp-recorrencias', (req, res) => {
    try {
      const { fornecedorId, categoriaId, descricao, valor, frequencia, diaVencimento,
              proximaGeracao, formaPagamentoPadrao, observacoes } = req.body || {};
      if (!fornecedorId || !descricao || !valor || !frequencia || !proximaGeracao) {
        return res.status(400).json({ success: false, error: 'fornecedorId, descricao, valor, frequencia, proximaGeracao obrigatórios' });
      }
      const r = db.prepare(`INSERT INTO contas_pagar_recorrencias
        (fornecedorId, categoriaId, descricao, valor, frequencia, diaVencimento,
         proximaGeracao, formaPagamentoPadrao, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        Number(fornecedorId), categoriaId || null, descricao, Number(valor),
        frequencia, diaVencimento || null, proximaGeracao,
        formaPagamentoPadrao || null, observacoes || null
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/cp-recorrencias/:id', (req, res) => {
    try {
      const e = db.prepare('SELECT * FROM contas_pagar_recorrencias WHERE id = ?').get(req.params.id);
      if (!e) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const b = req.body || {};
      db.prepare(`UPDATE contas_pagar_recorrencias SET
        fornecedorId = ?, categoriaId = ?, descricao = ?, valor = ?,
        frequencia = ?, diaVencimento = ?, proximaGeracao = ?,
        formaPagamentoPadrao = ?, observacoes = ?, ativo = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(
        b.fornecedorId != null ? Number(b.fornecedorId) : e.fornecedorId,
        b.categoriaId != null ? Number(b.categoriaId) : e.categoriaId,
        b.descricao || e.descricao,
        b.valor != null ? Number(b.valor) : e.valor,
        b.frequencia || e.frequencia,
        b.diaVencimento != null ? Number(b.diaVencimento) : e.diaVencimento,
        b.proximaGeracao || e.proximaGeracao,
        b.formaPagamentoPadrao ?? e.formaPagamentoPadrao,
        b.observacoes ?? e.observacoes,
        b.ativo != null ? (b.ativo ? 1 : 0) : e.ativo,
        req.params.id
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/cp-recorrencias/:id', (req, res) => {
    try {
      db.prepare('UPDATE contas_pagar_recorrencias SET ativo = 0 WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cp-recorrencias/:id/gerar-agora', (req, res) => {
    try {
      const rec = db.prepare('SELECT * FROM contas_pagar_recorrencias WHERE id = ?').get(req.params.id);
      if (!rec) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const hoje = dataBrasilia();
      const desc = `${rec.descricao} (${(rec.proximaGeracao||hoje).slice(0,7)})`;
      const r = db.prepare(`INSERT INTO contas_a_pagar
        (fornecedorId, categoriaId, descricao, valor, dataEmissao, dataVencimento,
         formaPagamento, observacoes, status, origem, recorrenciaId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberta', 'recorrente', ?)`).run(
        rec.fornecedorId, rec.categoriaId, desc, rec.valor, hoje, rec.proximaGeracao || hoje,
        rec.formaPagamentoPadrao || null, rec.observacoes || null, rec.id
      );
      const prox = proximaOcorrencia(rec.proximaGeracao || hoje, rec.frequencia, rec.diaVencimento);
      db.prepare(`UPDATE contas_pagar_recorrencias SET ultimaGeracao = ?, proximaGeracao = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(hoje, prox, rec.id);
      res.json({ success: true, contaPagarId: r.lastInsertRowid, proximaGeracao: prox });
    } catch (err) {
      console.error('[gerar-agora rec]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

// ==================== HELPERS REUTILIZÁVEIS ====================
// Usados pelo os-routes para sincronizar AP de itens "comprados de terceiro".
// Mantém a lógica de parcelamento/categoria fora — aqui é AP simples (1 parcela).

function categoriaFornecedoresId(db) {
  const r = db.prepare(`SELECT id FROM categorias_cp WHERE nome = 'Fornecedores'`).get();
  return r?.id || null;
}

// Cria um AP simples (1 parcela) e retorna o id. Não valida fornecedor —
// chamador é responsável.
function criarContaAPagar(db, payload) {
  const cat = payload.categoriaId || categoriaFornecedoresId(db);
  const dataEmi = payload.dataEmissao || dataBrasilia();
  const r = db.prepare(`INSERT INTO contas_a_pagar
    (fornecedorId, categoriaId, descricao, valor, dataEmissao, dataVencimento,
     formaPagamento, observacoes, origem, status, osId, osItemId, osItemTipo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?, ?, ?)`).run(
    Number(payload.fornecedorId), cat,
    payload.descricao, Number(payload.valor),
    dataEmi, payload.dataVencimento,
    payload.formaPagamento || null, payload.observacoes || null,
    payload.origem || 'os_item_terceiro',
    payload.osId || null, payload.osItemId || null, payload.osItemTipo || null,
  );
  return r.lastInsertRowid;
}

// Atualiza um AP só se ainda estiver aberto (sem pagamentos). Retorna true
// se atualizou, false se já tem pagamento — chamador decide o que fazer.
function atualizarContaAPagarSeAberta(db, contaId, payload) {
  const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(contaId);
  if (!conta) return false;
  if (!['aberta'].includes(conta.status)) return false;
  const pagamentos = db.prepare(`SELECT COUNT(*) c FROM contas_pagar_pagamentos
    WHERE contaPagarId = ? AND estornado = 0`).get(contaId).c;
  if (pagamentos > 0) return false;
  db.prepare(`UPDATE contas_a_pagar SET
      fornecedorId = ?, descricao = ?, valor = ?, dataVencimento = ?,
      formaPagamento = ?, observacoes = ?, dataAtualizacao = CURRENT_TIMESTAMP
    WHERE id = ?`).run(
    payload.fornecedorId != null ? Number(payload.fornecedorId) : conta.fornecedorId,
    payload.descricao || conta.descricao,
    payload.valor != null ? Number(payload.valor) : conta.valor,
    payload.dataVencimento || conta.dataVencimento,
    payload.formaPagamento ?? conta.formaPagamento,
    payload.observacoes ?? conta.observacoes,
    contaId,
  );
  return true;
}

// Tenta deletar AP. Se já tem pagamento (não estornado), só cancela em vez
// de deletar — preserva histórico financeiro.
// Retorna 'deleted' | 'cancelled' | 'nothing'.
function removerContaAPagarSeAberta(db, contaId) {
  const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(contaId);
  if (!conta) return 'nothing';
  const pagamentos = db.prepare(`SELECT COUNT(*) c FROM contas_pagar_pagamentos
    WHERE contaPagarId = ? AND estornado = 0`).get(contaId).c;
  if (pagamentos > 0) {
    if (['aberta','parcial'].includes(conta.status)) {
      db.prepare(`UPDATE contas_a_pagar SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(contaId);
      return 'cancelled';
    }
    return 'nothing';
  }
  db.prepare('DELETE FROM contas_a_pagar WHERE id = ?').run(contaId);
  return 'deleted';
}

// Indica se o AP já recebeu pagamento — usado por os-routes para bloquear
// edição de custo/fornecedor após baixa.
function contaAPagarTemPagamento(db, contaId) {
  if (!contaId) return false;
  const r = db.prepare(`SELECT COUNT(*) c FROM contas_pagar_pagamentos
    WHERE contaPagarId = ? AND estornado = 0`).get(contaId);
  return (r?.c || 0) > 0;
}

module.exports = {
  registrarRotasContasPagar: registrarRotas,
  gerarContasRecorrentes,
  criarContaAPagar,
  atualizarContaAPagarSeAberta,
  removerContaAPagarSeAberta,
  contaAPagarTemPagamento,
};
