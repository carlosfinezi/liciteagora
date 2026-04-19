/**
 * conciliacao-routes.js — Importa extratos OFX e concilia com CR/CP.
 *
 * Tabela: transacoes_bancarias
 *   Cada linha = uma transação do extrato (idempotente via UNIQUE(contaFinanceiraId, fitid)).
 *   conciliadaCom: 'cr' | 'cp' | 'avulsa' | null
 *   conciliadaId: id do CR/CP vinculado
 *
 * Parser OFX: tolerante a SGML 1.x (tags sem fechamento) e XML 2.x.
 * Bancos brasileiros majoritariamente usam SGML.
 */

const multer = require('multer');
const { logAction } = require('./audit-log');
const { lancarMovimentacao } = require('./contas-financeiras-routes');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transacoes_bancarias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaFinanceiraId INTEGER NOT NULL,
      fitid TEXT NOT NULL,
      data TEXT NOT NULL,
      valor REAL NOT NULL,
      tipo TEXT,
      descricao TEXT,
      memo TEXT,
      checkNum TEXT,
      conciliadaCom TEXT,
      conciliadaId INTEGER,
      conciliadaEm TEXT,
      conciliadaPor TEXT,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_trx_unica ON transacoes_bancarias(contaFinanceiraId, fitid);
    CREATE INDEX IF NOT EXISTS idx_trx_pendentes ON transacoes_bancarias(contaFinanceiraId, conciliadaCom, data);
    CREATE INDEX IF NOT EXISTS idx_trx_data ON transacoes_bancarias(data);
  `);
}

// ==================== PARSER OFX ====================

function parseOfx(text) {
  // Remove cabeçalho OFXHEADER (até linha em branco) — só presente em SGML
  const inicioOfx = text.indexOf('<OFX>');
  if (inicioOfx < 0) throw new Error('Arquivo não parece ser OFX (tag <OFX> não encontrada)');
  const corpo = text.slice(inicioOfx);

  // Captura blocos STMTTRN. Tolerante a tags abertas (SGML) ou fechadas (XML).
  // Cada match retorna o conteúdo entre <STMTTRN> e </STMTTRN> ou até o próximo <STMTTRN>/</BANKTRANLIST>.
  const transacoes = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<STMTTRN>|<\/STMTTRN>|<\/BANKTRANLIST>|<\/CCSTMTTRNRS>)/g;
  let m;
  while ((m = re.exec(corpo)) !== null) {
    const bloco = m[1];
    const t = {
      tipo:     extrai(bloco, 'TRNTYPE'),
      data:     formatarData(extrai(bloco, 'DTPOSTED')),
      valor:    Number(String(extrai(bloco, 'TRNAMT') || '0').replace(',', '.')),
      fitid:    extrai(bloco, 'FITID'),
      checkNum: extrai(bloco, 'CHECKNUM'),
      memo:     extrai(bloco, 'MEMO'),
      descricao: extrai(bloco, 'NAME') || extrai(bloco, 'MEMO')
    };
    if (t.fitid) transacoes.push(t);
  }
  if (!transacoes.length) throw new Error('Nenhuma transação encontrada no OFX');

  const acctid = extrai(corpo, 'ACCTID');
  const bankid = extrai(corpo, 'BANKID');
  return { acctid, bankid, transacoes };
}

function extrai(texto, tag) {
  // Tenta XML primeiro (com fechamento), depois SGML (sem fechamento — vai até próxima tag ou fim de linha)
  const reXml = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  let m = reXml.exec(texto);
  if (m) return m[1].trim();
  const reSgml = new RegExp(`<${tag}>([^\\r\\n<]*)`);
  m = reSgml.exec(texto);
  return m ? m[1].trim() : null;
}

function formatarData(dt) {
  if (!dt) return null;
  // OFX datas: YYYYMMDD ou YYYYMMDDHHMMSS[.fff][TZ]
  const s = String(dt).replace(/[^0-9]/g, '');
  if (s.length < 8) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

// ==================== ROUTES ====================

function registrarRotasConciliacao(app, db) {
  migrarDB(db);

  // Upload OFX (multipart/form-data: file=<.ofx>, contaFinanceiraId)
  app.post('/api/conciliacao/upload', upload.single('arquivo'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo OFX obrigatório (campo "arquivo")' });
      const contaFinanceiraId = Number(req.body.contaFinanceiraId);
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(contaFinanceiraId);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });

      const text = req.file.buffer.toString('latin1'); // OFX BR comum em iso-8859-1; latin1 cobre ASCII e estendidos
      const parsed = parseOfx(text);

      const stmt = db.prepare(`
        INSERT INTO transacoes_bancarias (contaFinanceiraId, fitid, data, valor, tipo, descricao, memo, checkNum)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(contaFinanceiraId, fitid) DO NOTHING
      `);
      let novas = 0, dup = 0;
      const trx = db.transaction(() => {
        for (const t of parsed.transacoes) {
          const r = stmt.run(contaFinanceiraId, t.fitid, t.data, t.valor, t.tipo, t.descricao, t.memo, t.checkNum);
          if (r.changes) novas++; else dup++;
        }
      });
      trx();
      logAction(db, req, 'upload-ofx', 'conciliacao', null, {
        conta: conta.nome, total: parsed.transacoes.length, novas, duplicadas: dup
      });
      res.json({ success: true, total: parsed.transacoes.length, novas, duplicadas: dup, conta: conta.nome });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Listar transações (filtro por status, conta, período)
  app.get('/api/conciliacao/transacoes', (req, res) => {
    try {
      const { contaFinanceiraId, status, dataIni, dataFim, q, limit } = req.query;
      let sql = `SELECT t.*, cf.nome AS contaNome
                 FROM transacoes_bancarias t
                 JOIN contas_financeiras cf ON cf.id = t.contaFinanceiraId
                 WHERE 1=1`;
      const params = [];
      if (contaFinanceiraId) { sql += ' AND t.contaFinanceiraId = ?'; params.push(Number(contaFinanceiraId)); }
      if (status === 'pendente')  sql += ' AND t.conciliadaCom IS NULL';
      if (status === 'conciliada') sql += ' AND t.conciliadaCom IS NOT NULL';
      if (dataIni) { sql += ' AND t.data >= ?'; params.push(dataIni); }
      if (dataFim) { sql += ' AND t.data <= ?'; params.push(dataFim); }
      if (q)       { sql += ' AND (t.descricao LIKE ? OR t.memo LIKE ?)'; const like = `%${q}%`; params.push(like, like); }
      sql += ' ORDER BY t.data DESC, t.id DESC LIMIT ?';
      params.push(Number(limit) || 500);
      const transacoes = db.prepare(sql).all(...params);
      res.json({ success: true, transacoes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Sugestões de casamento: CR/CP em aberto com mesmo valor (e proximidade de data)
  app.get('/api/conciliacao/sugestoes/:trxId', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM transacoes_bancarias WHERE id = ?').get(req.params.trxId);
      if (!t) return res.status(404).json({ success: false, error: 'Transação não encontrada' });
      const valorAbs = Math.abs(t.valor);
      const sugestoes = [];
      // Crédito (entrada) → bate com CR
      if (t.valor > 0) {
        const crs = db.prepare(`
          SELECT 'cr' AS tipo, cr.id, cr.descricao, cr.valor, cr.dataVencimento, cr.dataEmissao,
                 p.razaoSocial AS pessoa
          FROM contas_a_receber cr
          JOIN pessoas p ON p.id = cr.pessoaId
          WHERE cr.status IN ('aberta','parcial')
            AND ABS(cr.valor - ?) < 0.005
          ORDER BY ABS(julianday(cr.dataVencimento) - julianday(?)) LIMIT 10
        `).all(valorAbs, t.data);
        sugestoes.push(...crs);
      }
      // Débito (saída) → bate com CP
      if (t.valor < 0) {
        const cps = db.prepare(`
          SELECT 'cp' AS tipo, cp.id, cp.descricao, cp.valor, cp.dataVencimento, cp.dataEmissao,
                 f.razaoSocial AS pessoa
          FROM contas_a_pagar cp
          JOIN fornecedores f ON f.id = cp.fornecedorId
          WHERE cp.status IN ('aberta','parcial')
            AND ABS(cp.valor - ?) < 0.005
          ORDER BY ABS(julianday(cp.dataVencimento) - julianday(?)) LIMIT 10
        `).all(valorAbs, t.data);
        sugestoes.push(...cps);
      }
      res.json({ success: true, sugestoes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Conciliar com CR/CP existente: marca CR/CP como pago e a transação como conciliada
  app.post('/api/conciliacao/transacoes/:id/conciliar', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM transacoes_bancarias WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Transação não encontrada' });
      if (t.conciliadaCom) return res.status(400).json({ success: false, error: 'Transação já conciliada' });
      const { tipo, contaId } = req.body; // tipo: 'cr'|'cp'|'avulsa'; contaId: id do CR/CP
      if (!['cr','cp','avulsa'].includes(tipo)) return res.status(400).json({ success: false, error: 'tipo inválido (cr|cp|avulsa)' });

      // CONC-01 (2026-04-18): antes, conciliar marcava CR/CP como paga mas NÃO
      // lançava movimentação na conta financeira — saldo bancário ficava defasado.
      let movimentacaoId = null;
      const trx = db.transaction(() => {
        if (tipo === 'cr' || tipo === 'cp') {
          if (!contaId) throw new Error('contaId obrigatório para conciliação com CR/CP');
          const tabela = tipo === 'cr' ? 'contas_a_receber' : 'contas_a_pagar';
          const conta = db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(contaId);
          if (!conta) throw new Error(`${tipo.toUpperCase()} não encontrado`);
          if (conta.status === 'paga') throw new Error(`${tipo.toUpperCase()} já está paga — desconcilie antes`);
          db.prepare(`UPDATE ${tabela} SET status='paga', dataPagamento=?, valorPago=?, contaFinanceiraId=? WHERE id = ?`)
            .run(t.data, Math.abs(t.valor), t.contaFinanceiraId, contaId);
          // Lança movimentação: CR → entrada, CP → saída
          movimentacaoId = lancarMovimentacao(db, {
            contaId: t.contaFinanceiraId,
            tipo: tipo === 'cr' ? 'entrada' : 'saida',
            valor: Math.abs(t.valor),
            data: t.data,
            descricao: `Conciliação ${tipo.toUpperCase()} #${contaId} — ${t.descricao || t.memo || ''}`.trim(),
            origem: tipo === 'cr' ? 'contas_a_receber' : 'contas_a_pagar',
            origemId: contaId,
            usuario: req.user?.username || 'conciliacao'
          });
        } else if (tipo === 'avulsa') {
          // Avulsa: transação não casada com CR/CP — lança como entrada/saída avulsa
          movimentacaoId = lancarMovimentacao(db, {
            contaId: t.contaFinanceiraId,
            tipo: t.valor >= 0 ? 'entrada' : 'saida',
            valor: Math.abs(t.valor),
            data: t.data,
            descricao: `Avulsa: ${t.descricao || t.memo || 'movimentação bancária'}`,
            origem: 'transacao_bancaria',
            origemId: t.id,
            usuario: req.user?.username || 'conciliacao'
          });
        }
        db.prepare(`
          UPDATE transacoes_bancarias
             SET conciliadaCom = ?, conciliadaId = ?, conciliadaEm = CURRENT_TIMESTAMP, conciliadaPor = ?
           WHERE id = ?
        `).run(tipo, contaId || null, req.user?.username || null, t.id);
      });
      trx();
      logAction(db, req, 'conciliar', 'transacao-bancaria', t.id, { tipo, contaId, valor: t.valor, movimentacaoId });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Reverter conciliação
  app.post('/api/conciliacao/transacoes/:id/desconciliar', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM transacoes_bancarias WHERE id = ?').get(req.params.id);
      if (!t || !t.conciliadaCom) return res.status(404).json({ success: false, error: 'Não conciliada' });
      const trx = db.transaction(() => {
        // CONC-01 (2026-04-18): lança movimentação REVERSA em vez de DELETE para
        // preservar trilha de auditoria. Dupla entrada: original fica, estorno anula.
        const origem = t.conciliadaCom === 'cr' ? 'contas_a_receber'
                    : t.conciliadaCom === 'cp' ? 'contas_a_pagar'
                    : 'transacao_bancaria';
        const origemId = t.conciliadaCom === 'avulsa' ? t.id : t.conciliadaId;
        const tipoReverso = (() => {
          if (t.conciliadaCom === 'cr') return 'saida'; // cancela a entrada original
          if (t.conciliadaCom === 'cp') return 'entrada'; // cancela a saída original
          return t.valor >= 0 ? 'saida' : 'entrada';
        })();
        lancarMovimentacao(db, {
          contaId: t.contaFinanceiraId,
          tipo: tipoReverso,
          valor: Math.abs(t.valor),
          data: new Date().toISOString().slice(0, 10),
          descricao: `Estorno desconciliação — trx ${t.id}`,
          origem,
          origemId,
          usuario: req.user?.username || 'conciliacao'
        });
        if (t.conciliadaCom === 'cr' && t.conciliadaId) {
          db.prepare(`UPDATE contas_a_receber SET status='aberta', dataPagamento=NULL, valorPago=NULL WHERE id = ?`).run(t.conciliadaId);
        } else if (t.conciliadaCom === 'cp' && t.conciliadaId) {
          db.prepare(`UPDATE contas_a_pagar SET status='aberta', dataPagamento=NULL, valorPago=NULL WHERE id = ?`).run(t.conciliadaId);
        }
        db.prepare('UPDATE transacoes_bancarias SET conciliadaCom = NULL, conciliadaId = NULL, conciliadaEm = NULL, conciliadaPor = NULL WHERE id = ?')
          .run(t.id);
      });
      trx();
      logAction(db, req, 'desconciliar', 'transacao-bancaria', t.id, null);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasConciliacao };
