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
const PDFDocument = require('pdfkit');
const { lancarMovimentacao } = require('./contas-financeiras-routes');

function dataBrasilia() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

// ==================== MIGRAÇÕES ====================
//
// Multi-tenant (2026-04-22): schemas e seed de categorias_cr /
// contas_receber_pagamentos / contas_receber_anexos + ALTER em
// contas_a_receber migraram para db-schema.js. O backfill de contas
// pagas v1 sem histórico também roda de lá — idempotente (NOT EXISTS).

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

  if (!contaReceberId) {
    throw new Error('contaReceberId obrigatório');
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
  // Bonificação: vPago=0 (desconto cobre o total) é permitido e NÃO exige conta
  // financeira nem gera movimentação no caixa. Conta só é obrigatória quando
  // entra dinheiro de fato.
  if (vPago > 0 && !contaFinanceiraId) {
    throw new Error('contaFinanceiraId obrigatório quando o valor recebido é maior que zero');
  }
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
      formaPagamento || null, contaFinanceiraId || null, origem || 'manual',
      observacoes, usuario
    );
    pagamentoId = r.lastInsertRowid;

    // Só lança movimentação no caixa quando há valor de fato (vPago>0).
    // Bonificação (vPago=0) não toca o caixa — fica só o registro do desconto.
    if (vPago > 0) {
      movId = lancarMovimentacao(db, {
        contaId: contaFinanceiraId,
        tipo: 'entrada', valor: vPago, data: dp,
        descricao: `Baixa CR: ${conta.descricao}`,
        origem: 'baixa_cr', origemId: conta.id,
        categoria: 'vendas', usuario
      });
      db.prepare('UPDATE contas_receber_pagamentos SET movimentacaoFinanceiraId = ? WHERE id = ?').run(movId, pagamentoId);
    }

    db.prepare(`UPDATE contas_a_receber SET status = ?,
      valorPago = ?, dataPagamento = CASE WHEN ? = 'paga' THEN ? ELSE dataPagamento END,
      formaPagamento = COALESCE(?, formaPagamento),
      contaFinanceiraId = COALESCE(?, contaFinanceiraId), dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
      novoStatus, novoJaPago, novoStatus, dp, formaPagamento || null, contaFinanceiraId || null, contaReceberId
    );

    // Cria CRs sintéticas de Juros/Multa pra refletir no DRE com plano contábil
    // correto (Receitas Financeiras). Não geram movimentação financeira nova
    // — o caixa já recebeu o total via lancarMovimentacao acima. São apenas
    // registros contábeis pra agrupar corretamente na consulta de DRE.
    const jurosV = Number(juros) || 0;
    const multaV = Number(multa) || 0;
    if (jurosV > 0 || multaV > 0) {
      const cats = _garantirCategoriasJurosMulta(db);
      if (cats) {
        const insSint = db.prepare(`
          INSERT INTO contas_a_receber
            (pessoaId, categoriaId, planoContaId, descricao, valor, valorPago,
             dataEmissao, dataVencimento, dataPagamento, status, formaPagamento,
             contaFinanceiraId, origem, dataAtualizacao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paga', ?, ?, ?, CURRENT_TIMESTAMP)
        `);
        if (jurosV > 0) {
          insSint.run(
            conta.pessoaId, cats.jurosCategId, cats.planoFinReceitaId,
            `Juros sobre conta #${conta.id} — ${conta.descricao}`,
            jurosV, jurosV, dp, dp, dp, formaPagamento || null,
            contaFinanceiraId, 'juros-baixa'
          );
        }
        if (multaV > 0) {
          insSint.run(
            conta.pessoaId, cats.multaCategId, cats.planoFinReceitaId,
            `Multa sobre conta #${conta.id} — ${conta.descricao}`,
            multaV, multaV, dp, dp, dp, formaPagamento || null,
            contaFinanceiraId, 'multa-baixa'
          );
        }
      }
    }
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

// Garante categorias "Juros recebidos" e "Multa recebida" ligadas ao plano de
// contas "Receitas Financeiras" (tipo financeiro_receita). Usado pela baixa
// de CR pra criar CRs sintéticas que aparecem corretamente no DRE.
//
// Retorna { jurosCategId, multaCategId, planoFinReceitaId } — null se faltar
// plano contábil de receita financeira (sistema sem seed ainda).
function _garantirCategoriasJurosMulta(db) {
  const planoFin = db.prepare(
    `SELECT id FROM plano_contas WHERE tipo = 'financeiro_receita' AND ativo = 1 ORDER BY codigo LIMIT 1`
  ).get();
  if (!planoFin) return null;

  const garantirCateg = (nome, icone) => {
    const existente = db.prepare(`SELECT id FROM categorias_cr WHERE nome = ? AND ativo = 1`).get(nome);
    if (existente) {
      // Atualiza planoContaId se estiver vazio
      db.prepare(`UPDATE categorias_cr SET planoContaId = COALESCE(planoContaId, ?) WHERE id = ?`)
        .run(planoFin.id, existente.id);
      return existente.id;
    }
    const r = db.prepare(`INSERT INTO categorias_cr (nome, icone, planoContaId) VALUES (?, ?, ?)`)
      .run(nome, icone, planoFin.id);
    return r.lastInsertRowid;
  };

  return {
    jurosCategId: garantirCateg('Juros recebidos', '💰'),
    multaCategId: garantirCateg('Multa recebida', '⚠️'),
    planoFinReceitaId: planoFin.id,
  };
}

function registrarRotas(app, db) {
  // Seed idempotente das categorias contábeis pra juros/multa
  try { _garantirCategoriasJurosMulta(db); } catch (e) { console.error('[CR] seed juros/multa:', e.message); }

  // ========== CATEGORIAS ==========
  app.get('/api/cr-categorias', (req, res) => {
    try {
      const rows = db.prepare(`SELECT c.*, pc.codigo AS planoContaCodigo, pc.nome AS planoContaNome
        FROM categorias_cr c LEFT JOIN plano_contas pc ON pc.id = c.planoContaId
        WHERE c.ativo = 1 ORDER BY c.nome ASC`).all();
      res.json({ success: true, categorias: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.post('/api/cr-categorias', (req, res) => {
    try {
      const { nome, icone, planoContaId } = req.body || {};
      if (!nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare('INSERT INTO categorias_cr (nome, icone, planoContaId) VALUES (?, ?, ?)')
        .run(nome.trim(), icone || null, planoContaId ? Number(planoContaId) : null);
      res.json({ success: true, categoria: db.prepare('SELECT * FROM categorias_cr WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  app.put('/api/cr-categorias/:id', (req, res) => {
    try {
      const { nome, icone, planoContaId } = req.body || {};
      db.prepare(`UPDATE categorias_cr SET
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

  /**
   * GET /api/contas-a-receber/pdf
   * Gera PDF da listagem com os mesmos filtros do GET /api/contas-a-receber.
   * Inclui coluna "Com atraso" = saldo + juros + multa (usa config de juros do tenant).
   */
  app.get('/api/contas-a-receber/pdf', (req, res) => {
    try {
      const { status, pessoaId, categoriaId, origem,
              dataVencIni, dataVencFim, formaPagamento, busca, nota, nDPS } = req.query;

      // Reusa a query do GET principal (só sem ORDER+LIMIT diferentes).
      let sql = `SELECT c.id, c.descricao, c.valor, c.dataVencimento, c.status, c.formaPagamento,
          p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaCpfCnpj,
          cat.nome AS categoriaNome, cat.icone AS categoriaIcone,
          COALESCE((SELECT SUM(valorPago) FROM contas_receber_pagamentos
                    WHERE contaReceberId = c.id AND estornado = 0), 0) AS totalPago
        FROM contas_a_receber c
        JOIN pessoas p ON p.id = c.pessoaId
        LEFT JOIN categorias_cr cat ON cat.id = c.categoriaId
        WHERE 1=1`;
      const p = [];
      if (status) {
        if (status === 'vencida') sql += ` AND c.status IN ('aberta','parcial') AND c.dataVencimento < DATE('now','-3 hours')`;
        else { sql += ' AND c.status = ?'; p.push(status); }
      }
      if (pessoaId)       { sql += ' AND c.pessoaId = ?'; p.push(Number(pessoaId)); }
      if (categoriaId)    { sql += ' AND c.categoriaId = ?'; p.push(Number(categoriaId)); }
      if (origem)         { sql += ' AND c.origem = ?'; p.push(origem); }
      if (formaPagamento) { sql += ' AND c.formaPagamento = ?'; p.push(formaPagamento); }
      if (dataVencIni)    { sql += ' AND c.dataVencimento >= ?'; p.push(dataVencIni); }
      if (dataVencFim)    { sql += ' AND c.dataVencimento <= ?'; p.push(dataVencFim); }
      if (busca) {
        sql += ' AND (p.razaoSocial LIKE ? OR p.cpfCnpj LIKE ? OR c.descricao LIKE ?)';
        const t = '%' + busca + '%'; p.push(t, t, t);
      }
      if (nota === 'com') sql += ' AND c.nfseId IS NOT NULL';
      else if (nota === 'sem') sql += ' AND c.nfseId IS NULL';
      if (nDPS) { sql += ' AND c.nfseId IN (SELECT id FROM nfse WHERE nDPS = ?)'; p.push(Number(nDPS)); }
      sql += ' ORDER BY c.dataVencimento ASC, c.id DESC LIMIT 1000';
      const rawContas = db.prepare(sql).all(...p);

      // Config de juros
      const cfgRows = db.prepare(`SELECT chave, valor FROM config WHERE chave IN (
        'juros_mes_pct','multa_atraso_pct','carencia_dias','juros_modo')`).all();
      const cfgMap = Object.fromEntries(cfgRows.map(r => [r.chave, r.valor]));
      const CFG = {
        jurosMesPct:    Number(cfgMap.juros_mes_pct)    || 0,
        multaAtrasoPct: Number(cfgMap.multa_atraso_pct) || 0,
        carenciaDias:   Number(cfgMap.carencia_dias)    || 0,
        jurosModo:      cfgMap.juros_modo || 'simples',
      };
      const hojeStr = dataBrasilia();

      const contas = rawContas.map(c => {
        const saldo = Number((c.valor - c.totalPago).toFixed(2));
        const vencida = ['aberta','parcial'].includes(c.status) && c.dataVencimento && c.dataVencimento < hojeStr;
        let juros = 0, multa = 0, diasAtraso = 0;
        if (vencida && saldo > 0) {
          const v = new Date(c.dataVencimento.slice(0,10) + 'T12:00:00Z');
          const h = new Date(hojeStr + 'T12:00:00Z');
          diasAtraso = Math.max(0, Math.floor((h - v) / 86400000));
          const efetivos = Math.max(0, diasAtraso - CFG.carenciaDias);
          if (efetivos > 0) {
            if (CFG.jurosModo === 'composto') {
              juros = saldo * (Math.pow(1 + CFG.jurosMesPct/100, efetivos/30) - 1);
            } else {
              juros = saldo * (CFG.jurosMesPct/100) * (efetivos/30);
            }
            multa = saldo * (CFG.multaAtrasoPct/100);
          }
        }
        return {
          ...c,
          saldoRestante: saldo,
          vencida,
          diasAtraso,
          juros:      Math.round(juros * 100) / 100,
          multa:      Math.round(multa * 100) / 100,
          comAtraso:  Math.round((saldo + juros + multa) * 100) / 100,
          statusDisplay: vencida ? 'vencida' : c.status,
        };
      });

      // Totalizadores
      const totValor     = contas.reduce((s, c) => s + Number(c.valor || 0), 0);
      const totSaldo     = contas.reduce((s, c) => s + c.saldoRestante, 0);
      const totJuros     = contas.reduce((s, c) => s + c.juros, 0);
      const totMulta     = contas.reduce((s, c) => s + c.multa, 0);
      const totComAtraso = contas.reduce((s, c) => s + c.comAtraso, 0);

      // Dados do emitente
      const emp = db.prepare('SELECT razaoSocial, cnpj FROM fornecedor LIMIT 1').get() || {};

      // PDF
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="contas-a-receber-${hojeStr}.pdf"`);

      const doc = new PDFDocument({ size: 'A4', margin: 30, layout: 'landscape' });
      doc.pipe(res);

      const fmt = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const fmtDt = s => s ? String(s).slice(0,10).split('-').reverse().join('/') : '—';

      // Header
      doc.fontSize(14).font('Helvetica-Bold').text(emp.razaoSocial || 'Contas a Receber', 30, 30);
      if (emp.cnpj) doc.fontSize(9).font('Helvetica').text(`CNPJ: ${emp.cnpj}`, 30, doc.y);
      doc.fontSize(12).font('Helvetica-Bold').text('Relatório — Contas a Receber', 30, doc.y + 4);
      doc.fontSize(8).font('Helvetica').fillColor('#666').text(`Emitido em ${fmtDt(hojeStr)} · ${contas.length} lançamento(s)`, 30, doc.y);

      // Filtros aplicados
      const filtrosDesc = [];
      if (status)          filtrosDesc.push(`status=${status}`);
      if (categoriaId)     filtrosDesc.push(`categoria=${categoriaId}`);
      if (dataVencIni)     filtrosDesc.push(`venc≥${fmtDt(dataVencIni)}`);
      if (dataVencFim)     filtrosDesc.push(`venc≤${fmtDt(dataVencFim)}`);
      if (formaPagamento)  filtrosDesc.push(`forma=${formaPagamento}`);
      if (busca)           filtrosDesc.push(`busca="${busca}"`);
      if (nota)            filtrosDesc.push(`nota=${nota}`);
      if (filtrosDesc.length) {
        doc.fillColor('#000').fontSize(8).font('Helvetica-Oblique').text(`Filtros: ${filtrosDesc.join(' · ')}`, 30, doc.y + 2);
      }

      // Tabela
      const colX = { venc: 30, cliente: 95, descricao: 230, categoria: 400, valor: 490, saldo: 560, comAtraso: 635, status: 720 };
      const colW = { venc: 60, cliente: 130, descricao: 165, categoria: 85, valor: 65, saldo: 70, comAtraso: 80, status: 85 };
      let y = Math.max(doc.y + 8, 90);

      const desenharHeader = (yHead) => {
        doc.fillColor('#000').rect(28, yHead, 794, 14).fillAndStroke('#eee', '#ccc');
        doc.fillColor('#000').fontSize(8).font('Helvetica-Bold');
        doc.text('Vencimento', colX.venc, yHead + 3, { width: colW.venc });
        doc.text('Cliente',    colX.cliente, yHead + 3, { width: colW.cliente });
        doc.text('Descrição',  colX.descricao, yHead + 3, { width: colW.descricao });
        doc.text('Categoria',  colX.categoria, yHead + 3, { width: colW.categoria });
        doc.text('Valor',      colX.valor, yHead + 3, { width: colW.valor, align: 'right' });
        doc.text('Saldo',      colX.saldo, yHead + 3, { width: colW.saldo, align: 'right' });
        doc.text('Com atraso', colX.comAtraso, yHead + 3, { width: colW.comAtraso, align: 'right' });
        doc.text('Status',     colX.status, yHead + 3, { width: colW.status });
        return yHead + 16;
      };
      y = desenharHeader(y);

      doc.font('Helvetica').fontSize(8).fillColor('#000');
      for (const c of contas) {
        if (y > 560) { doc.addPage(); y = 50; y = desenharHeader(y); doc.font('Helvetica').fontSize(8); }
        if (c.vencida) doc.fillColor('#b91c1c'); else doc.fillColor('#000');
        doc.text(fmtDt(c.dataVencimento), colX.venc, y, { width: colW.venc });
        doc.text((c.pessoaNome || '—').slice(0, 40), colX.cliente, y, { width: colW.cliente });
        doc.text((c.descricao || '').slice(0, 60), colX.descricao, y, { width: colW.descricao, height: 10, ellipsis: true });
        doc.text((c.categoriaNome || '—').slice(0, 25), colX.categoria, y, { width: colW.categoria });
        doc.text(fmt(c.valor),         colX.valor, y, { width: colW.valor, align: 'right' });
        doc.text(fmt(c.saldoRestante), colX.saldo, y, { width: colW.saldo, align: 'right' });
        doc.text(c.comAtraso > c.saldoRestante ? fmt(c.comAtraso) : '—', colX.comAtraso, y, { width: colW.comAtraso, align: 'right' });
        doc.text(c.statusDisplay, colX.status, y, { width: colW.status });
        y += 13;
      }

      // Totais
      if (y > 540) { doc.addPage(); y = 60; }
      y += 8;
      doc.fillColor('#000').rect(28, y, 794, 14).fillAndStroke('#eef', '#99c');
      doc.fillColor('#000').font('Helvetica-Bold').fontSize(8);
      doc.text('TOTAIS',                 colX.descricao, y + 3, { width: colW.descricao });
      doc.text(fmt(totValor),            colX.valor,     y + 3, { width: colW.valor, align: 'right' });
      doc.text(fmt(totSaldo),            colX.saldo,     y + 3, { width: colW.saldo, align: 'right' });
      doc.text(fmt(totComAtraso),        colX.comAtraso, y + 3, { width: colW.comAtraso, align: 'right' });
      y += 18;
      if (totJuros + totMulta > 0) {
        doc.fillColor('#555').font('Helvetica').fontSize(7);
        doc.text(`Juros projetados: R$ ${fmt(totJuros)} · Multa projetada: R$ ${fmt(totMulta)}`, 30, y);
        doc.text(`Config: juros ${CFG.jurosMesPct}% ao mês (${CFG.jurosModo}) · multa ${CFG.multaAtrasoPct}% · carência ${CFG.carenciaDias} dia(s)`, 30, y + 9);
      }

      doc.end();
    } catch (err) {
      console.error('[CR-PDF]', err);
      if (!res.headersSent) res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-a-receber/:id', (req, res) => {
    try {
      const conta = db.prepare(`SELECT c.*,
        CASE WHEN c.status IN ('aberta','parcial') AND c.dataVencimento < DATE('now','-3 hours') THEN 'vencida' ELSE c.status END AS statusReal,
        p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaCpfCnpj, p.email AS pessoaEmail,
        cat.nome AS categoriaNome, cat.icone AS categoriaIcone,
        pc.codigo AS planoContaCodigo, pc.nome AS planoContaNome,
        cc.codigo AS centroCustoCodigo, cc.nome AS centroCustoNome,
        n.nDPS AS nfseNumero, n.status AS nfseStatus
      FROM contas_a_receber c
      JOIN pessoas p ON p.id = c.pessoaId
      LEFT JOIN categorias_cr cat ON cat.id = c.categoriaId
      LEFT JOIN plano_contas pc ON pc.id = c.planoContaId
      LEFT JOIN centros_custo cc ON cc.id = c.centroCustoId
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
              formaPagamento, observacoes, parcelas, intervaloMeses,
              planoContaId, centroCustoId } = req.body || {};
      if (!pessoaId || !descricao || valor == null || !dataVencimento) {
        return res.status(400).json({ success: false, error: 'pessoaId, descricao, valor e dataVencimento obrigatórios' });
      }
      const pessoa = db.prepare('SELECT id FROM pessoas WHERE id = ? AND ativo = 1').get(Number(pessoaId));
      if (!pessoa) return res.status(404).json({ success: false, error: 'Cliente não encontrado' });

      // Plano 12: se planoContaId não veio mas a categoria tem mapeamento, usa
      // como fallback (mantém compatibilidade com dados antigos que só têm
      // categoria sem plano de contas explícito).
      let planoId = planoContaId ? Number(planoContaId) : null;
      if (!planoId && categoriaId) {
        const cat = db.prepare('SELECT planoContaId FROM categorias_cr WHERE id = ?').get(Number(categoriaId));
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
          const r = db.prepare(`INSERT INTO contas_a_receber
            (pessoaId, categoriaId, planoContaId, centroCustoId, descricao, valor, dataEmissao, dataVencimento,
             formaPagamento, observacoes, origem, status, parcelaNumero, totalParcelas, grupoParcelaId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'aberta', ?, ?, ?)`).run(
            Number(pessoaId), categoriaId ? Number(categoriaId) : null,
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
      const { descricao, valor, dataVencimento, formaPagamento, observacoes, pessoaId,
              categoriaId, planoContaId, centroCustoId } = req.body || {};
      db.prepare(`UPDATE contas_a_receber SET
          descricao = ?, valor = ?, dataVencimento = ?,
          formaPagamento = ?, observacoes = ?,
          pessoaId = ?, categoriaId = ?, planoContaId = ?, centroCustoId = ?,
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        descricao || existing.descricao,
        valor != null ? Number(valor) : existing.valor,
        dataVencimento || existing.dataVencimento,
        formaPagamento ?? existing.formaPagamento,
        observacoes ?? existing.observacoes,
        pessoaId ? Number(pessoaId) : existing.pessoaId,
        categoriaId != null ? Number(categoriaId) : existing.categoriaId,
        planoContaId !== undefined ? (planoContaId ? Number(planoContaId) : null) : existing.planoContaId,
        centroCustoId !== undefined ? (centroCustoId ? Number(centroCustoId) : null) : existing.centroCustoId,
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
      // Conta financeira é opcional: bonificação (desconto total → vPago=0) não
      // exige conta. Se informada, valida que existe e está ativa.
      if (contaFinanceiraId) {
        const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
        if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });
      }

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
      const { ids, contaFinanceiraId, dataPagamento, formaPagamento, valorTotal, imputacao } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids obrigatórios' });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });

      const dp = dataPagamento || dataBrasilia();

      // Carrega contas válidas com saldo; só modo valorTotal pede ordem FIFO por vencimento.
      const selConta = db.prepare(`SELECT c.*,
        COALESCE((SELECT SUM(valorBase) FROM contas_receber_pagamentos
                  WHERE contaReceberId = c.id AND estornado = 0), 0) AS jaPago
        FROM contas_a_receber c WHERE c.id = ?`);
      const elegiveis = [];
      for (const id of ids) {
        const c = selConta.get(id);
        if (!c || !['aberta','parcial'].includes(c.status)) continue;
        const saldo = Number((c.valor - c.jaPago).toFixed(2));
        if (saldo > 0) elegiveis.push({ ...c, saldo });
      }

      // Lê config de juros pra projetar juros+multa por conta (mesma fórmula do detalhe + relatório).
      const cfgRows = db.prepare(`SELECT chave, valor FROM config WHERE chave IN (
        'juros_mes_pct','multa_atraso_pct','carencia_dias','juros_modo')`).all();
      const cfgMap = Object.fromEntries(cfgRows.map(r => [r.chave, r.valor]));
      const CFG = {
        jurosMesPct:    Number(cfgMap.juros_mes_pct)    || 0,
        multaAtrasoPct: Number(cfgMap.multa_atraso_pct) || 0,
        carenciaDias:   Number(cfgMap.carencia_dias)    || 0,
        jurosModo:      cfgMap.juros_modo || 'simples',
      };
      const hojeStr = dataBrasilia();
      function jurosMultaProjetado(c) {
        if (!c.dataVencimento || c.dataVencimento >= hojeStr) return { juros: 0, multa: 0 };
        const v = new Date(c.dataVencimento.slice(0,10) + 'T12:00:00Z');
        const h = new Date(hojeStr + 'T12:00:00Z');
        const atraso = Math.max(0, Math.floor((h - v) / 86400000));
        const efet = Math.max(0, atraso - CFG.carenciaDias);
        if (efet <= 0) return { juros: 0, multa: 0 };
        const j = CFG.jurosModo === 'composto'
          ? c.saldo * (Math.pow(1 + CFG.jurosMesPct/100, efet/30) - 1)
          : c.saldo * (CFG.jurosMesPct/100) * (efet/30);
        const m = c.saldo * (CFG.multaAtrasoPct/100);
        return { juros: Math.round(j*100)/100, multa: Math.round(m*100)/100 };
      }

      // Distribuição FIFO quando valorTotal informado: paga contas em ordem de
      // vencimento. Dentro de cada conta, imputa primeiro juros, depois multa,
      // depois principal (Art. 354 CC). Última conta atingida pode ficar parcial.
      let distribuicao = null; // Map<id, { valorBase, juros, multa }>
      if (valorTotal !== undefined && valorTotal !== null && valorTotal !== '') {
        const vt = Number(valorTotal);
        if (!Number.isFinite(vt) || vt <= 0) {
          return res.status(400).json({ success: false, error: 'valorTotal inválido' });
        }

        // Ordena FIFO + id desempate
        elegiveis.sort((a, b) => {
          const cmp = String(a.dataVencimento || '').localeCompare(String(b.dataVencimento || ''));
          return cmp !== 0 ? cmp : (a.id - b.id);
        });

        // Projeta juros+multa por conta + total devido (principal + acessórios)
        for (const c of elegiveis) {
          const jm = jurosMultaProjetado(c);
          c.jurosProj = jm.juros;
          c.multaProj = jm.multa;
          c.totalDevido = Math.round((c.saldo + jm.juros + jm.multa) * 100) / 100;
        }
        const somaTotal = elegiveis.reduce((s, c) => s + c.totalDevido, 0);
        if (vt > somaTotal + 0.01) {
          return res.status(400).json({
            success: false,
            error: `valorTotal (R$ ${vt.toFixed(2)}) maior que total devido com juros (R$ ${somaTotal.toFixed(2)})`,
          });
        }

        distribuicao = new Map();
        // Modos de imputação:
        //   'cc354' (default): juros → multa → principal — quando paga menos que total,
        //     conta fica parcial. Segue Art. 354 do Código Civil.
        //   'quitar-arredondando-juros': principal → multa → juros — quita o título primeiro,
        //     desconta do juros. Útil quando cliente paga valor "redondo" e cobre o principal.
        const modo = imputacao === 'quitar-arredondando-juros' ? 'principal-primeiro' : 'cc354';

        let restante = vt;
        for (const c of elegiveis) {
          if (restante <= 0.005) break;
          let allocBase = 0, allocJuros = 0, allocMulta = 0;
          if (modo === 'principal-primeiro') {
            // Cobre principal antes; sobra vai pra multa, depois juros.
            allocBase  = Math.min(c.saldo, Math.round(restante * 100) / 100);
            restante = Math.round((restante - allocBase) * 100) / 100;
            allocMulta = Math.min(c.multaProj, Math.round(restante * 100) / 100);
            restante = Math.round((restante - allocMulta) * 100) / 100;
            allocJuros = Math.min(c.jurosProj, Math.round(restante * 100) / 100);
            restante = Math.round((restante - allocJuros) * 100) / 100;
          } else {
            // CC 354: juros → multa → principal
            allocJuros = Math.min(c.jurosProj, Math.round(restante * 100) / 100);
            restante = Math.round((restante - allocJuros) * 100) / 100;
            allocMulta = Math.min(c.multaProj, Math.round(restante * 100) / 100);
            restante = Math.round((restante - allocMulta) * 100) / 100;
            allocBase  = Math.min(c.saldo, Math.round(restante * 100) / 100);
            restante = Math.round((restante - allocBase) * 100) / 100;
          }
          if (allocJuros + allocMulta + allocBase > 0) {
            distribuicao.set(c.id, { valorBase: allocBase, juros: allocJuros, multa: allocMulta });
          }
        }
      }

      const sucessos = [], falhas = [];
      const tx = db.transaction(() => {
        // Se distribuicao existe, só baixa os que receberam alocação.
        // Sem valorTotal: baixa todos os IDs elegíveis pelo saldo cheio (comportamento anterior).
        const iterar = distribuicao ? [...distribuicao.keys()] : elegiveis.map(c => c.id);
        const naoElegiveis = ids.filter(id => !elegiveis.some(c => c.id === id));
        for (const id of naoElegiveis) falhas.push({ id, erro: 'status inválido ou saldo zero' });

        for (const id of iterar) {
          try {
            const opts = {
              contaReceberId: id, dataPagamento: dp, contaFinanceiraId,
              formaPagamento: formaPagamento || null, origem: 'lote',
              usuario: req.session?.username || null,
            };
            if (distribuicao) {
              const a = distribuicao.get(id);
              opts.valorBase = a.valorBase;
              opts.juros = a.juros;
              opts.multa = a.multa;
              const conta = elegiveis.find(c => c.id === id);
              if (conta && a.valorBase < conta.saldo - 0.01) opts.parcial = true;
            }
            registrarBaixaCR(db, opts);
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

  // ==================== CONFIGURAÇÃO DE JUROS & MULTA ====================
  //
  // Armazenada em `config` (key-value). Chaves:
  //   juros_mes_pct        — taxa mensal de juros (%), default 1
  //   multa_atraso_pct     — multa fixa sobre valor em atraso (%), default 2
  //   carencia_dias        — dias de carência antes de cobrar juros, default 0
  //   juros_modo           — 'simples' (padrão) | 'composto' (raramente usado)
  //
  // Aplicação: aoAbrir modal de baixa, front calcula juros/multa sugeridos
  // com base em dias de atraso vs vencimento. Usuário pode editar livremente.

  app.get('/api/financeiro/config-juros', (req, res) => {
    try {
      const rows = db.prepare(`SELECT chave, valor FROM config WHERE chave IN (
        'juros_mes_pct','multa_atraso_pct','carencia_dias','juros_modo')`).all();
      const map = Object.fromEntries(rows.map(r => [r.chave, r.valor]));
      res.json({
        success: true,
        jurosMesPct:    Number(map.juros_mes_pct)    || 0,
        multaAtrasoPct: Number(map.multa_atraso_pct) || 0,
        carenciaDias:   Number(map.carencia_dias)    || 0,
        jurosModo:      map.juros_modo || 'simples',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/financeiro/config-juros', (req, res) => {
    try {
      const { jurosMesPct, multaAtrasoPct, carenciaDias, jurosModo } = req.body || {};
      const upsert = db.prepare(`INSERT INTO config (chave, valor) VALUES (?, ?)
        ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`);
      const setIfPresent = (k, v) => { if (v !== undefined && v !== null && v !== '') upsert.run(k, String(v)); };
      setIfPresent('juros_mes_pct',    Number(jurosMesPct));
      setIfPresent('multa_atraso_pct', Number(multaAtrasoPct));
      setIfPresent('carencia_dias',    Math.max(0, parseInt(carenciaDias) || 0));
      if (jurosModo && ['simples','composto'].includes(jurosModo)) upsert.run('juros_modo', jurosModo);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasContasReceber: registrarRotas, registrarBaixaCR };
