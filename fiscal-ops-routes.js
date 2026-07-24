/**
 * fiscal-ops-routes.js — Operações fiscais complementares (item 2.5):
 *  - Histórico de eventos NF-e (CC-e/cancelamento persistidos p/ arquivamento);
 *  - Inutilização de numeração (tools.sefazInutiliza, cStat 102);
 *  - GNRE/DIFAL: cálculo assistido + registro da guia + conta a pagar.
 *
 * A CC-e em si já existe em nfe-emit-routes (/api/faturas/:id/cce) — aqui
 * ficam o registro persistente (chamado de lá) e as operações novas.
 */

const { logAction } = require('./audit-log');

function tag(xml, nome) {
  const m = String(xml || '').match(new RegExp(`<${nome}[^>]*>([\\s\\S]*?)</${nome}>`));
  return m ? m[1] : null;
}

function migrarFiscalOpsDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfe_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faturaId INTEGER,
      chaveAcesso TEXT NOT NULL,
      tpEvento TEXT NOT NULL,
      nSeqEvento INTEGER DEFAULT 1,
      texto TEXT,
      cStat TEXT,
      xMotivo TEXT,
      protocolo TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nfeev_chave ON nfe_eventos(chaveAcesso);

    CREATE TABLE IF NOT EXISTS nfe_inutilizacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serie INTEGER NOT NULL,
      numeroInicial INTEGER NOT NULL,
      numeroFinal INTEGER NOT NULL,
      ano INTEGER NOT NULL,
      justificativa TEXT NOT NULL,
      cStat TEXT,
      xMotivo TEXT,
      protocolo TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS gnre_guias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faturaId INTEGER,
      uf TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'difal',
      baseCalculo REAL NOT NULL,
      aliquotaInterna REAL NOT NULL,
      aliquotaInterestadual REAL NOT NULL,
      percentualFcp REAL DEFAULT 0,
      valorDifal REAL NOT NULL,
      valorFcp REAL DEFAULT 0,
      valorTotal REAL NOT NULL,
      dataVencimento TEXT,
      status TEXT NOT NULL DEFAULT 'pendente',
      contaPagarId INTEGER,
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_gnre_status ON gnre_guias(status);
  `);
}

// Chamado pelos endpoints de CC-e/cancelamento em nfe-emit-routes
function registrarEventoNfe(db, { faturaId, chaveAcesso, tpEvento, nSeqEvento, texto, cStat, xMotivo, protocolo, usuario }) {
  try {
    db.prepare(`INSERT INTO nfe_eventos
      (faturaId, chaveAcesso, tpEvento, nSeqEvento, texto, cStat, xMotivo, protocolo, usuario)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      faturaId || null, chaveAcesso, tpEvento, nSeqEvento || 1,
      texto || null, cStat || null, xMotivo || null, protocolo || null, usuario || null);
  } catch (e) {
    console.warn('[nfe_eventos] registro falhou:', e.message);
  }
}

function registrarRotasFiscalOps(app, db) {
  migrarFiscalOpsDB(db);

  app.get('/api/nfe/eventos', (req, res) => {
    try {
      const { chaveAcesso, faturaId } = req.query;
      let sql = 'SELECT * FROM nfe_eventos WHERE 1=1';
      const params = [];
      if (chaveAcesso) { sql += ' AND chaveAcesso = ?'; params.push(chaveAcesso); }
      if (faturaId)    { sql += ' AND faturaId = ?'; params.push(Number(faturaId)); }
      sql += ' ORDER BY id DESC LIMIT 200';
      res.json({ success: true, eventos: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ===== inutilização =====
  app.get('/api/nfe/inutilizacoes', (req, res) => {
    try {
      res.json({ success: true, inutilizacoes: db.prepare('SELECT * FROM nfe_inutilizacoes ORDER BY id DESC LIMIT 100').all() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfe/inutilizar', async (req, res) => {
    try {
      const { serie, numeroInicial, numeroFinal, justificativa, ano } = req.body || {};
      const nIni = Number(numeroInicial), nFin = Number(numeroFinal), nSerie = Number(serie);
      const xJust = (justificativa || '').trim();
      if (!(nSerie >= 0) || !(nIni > 0) || !(nFin >= nIni)) {
        return res.status(400).json({ success: false, error: 'serie, numeroInicial e numeroFinal (>= inicial) obrigatórios' });
      }
      if (xJust.length < 15) return res.status(400).json({ success: false, error: 'Justificativa deve ter pelo menos 15 caracteres' });
      // não inutilizar número já autorizado
      const emitida = db.prepare(`SELECT numero FROM faturas
        WHERE serieNFe = ? AND numeroNFe BETWEEN ? AND ? AND statusSefaz = 'autorizada' LIMIT 1`).get(String(nSerie), nIni, nFin);
      if (emitida) return res.status(400).json({ success: false, error: `Faixa contém NF-e autorizada (${emitida.numero})` });

      const { getTools } = require('./nfe-emit-routes');
      const tools = await getTools(db);
      const resp = await tools.sefazInutiliza({ nSerie, nIni, nFin, xJust, ano: ano || undefined });
      const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
      const cStat = tag(str, 'cStat');
      const xMotivo = tag(str, 'xMotivo');
      const nProt = tag(str, 'nProt');
      const usuario = req.session?.username || null;

      db.prepare(`INSERT INTO nfe_inutilizacoes
        (serie, numeroInicial, numeroFinal, ano, justificativa, cStat, xMotivo, protocolo, usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        nSerie, nIni, nFin, Number(ano) || new Date().getFullYear(), xJust, cStat, xMotivo, nProt, usuario);

      logAction(db, req, 'inutilizar', 'nfe-numeracao', null, { serie: nSerie, nIni, nFin, cStat });
      if (cStat === '102') {
        res.json({ success: true, cStat, xMotivo, protocolo: nProt });
      } else {
        res.status(400).json({ success: false, cStat, xMotivo, raw: str.slice(0, 1500) });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  // ===== GNRE / DIFAL =====
  app.get('/api/gnre', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT g.*, f.numero AS faturaNumero, f.chaveAcesso
        FROM gnre_guias g LEFT JOIN faturas f ON f.id = g.faturaId WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND g.status = ?'; params.push(status); }
      sql += ' ORDER BY g.id DESC LIMIT 200';
      res.json({ success: true, guias: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Cálculo assistido: DIFAL = base × (aliqInterna − aliqInterestadual); FCP = base × %FCP.
  // Opcionalmente gera a conta a pagar da guia (fornecedor "SEFAZ <UF>" auto-criado).
  app.post('/api/gnre', (req, res) => {
    try {
      const { faturaId, uf, tipo, baseCalculo, aliquotaInterna, aliquotaInterestadual,
              percentualFcp, dataVencimento, observacao, gerarContaPagar } = req.body || {};
      const base = Number(baseCalculo), ali = Number(aliquotaInterna), alie = Number(aliquotaInterestadual);
      const fcpPct = Number(percentualFcp) || 0;
      if (!uf || !/^[A-Z]{2}$/.test(String(uf).toUpperCase())) {
        return res.status(400).json({ success: false, error: 'uf (2 letras) obrigatória' });
      }
      if (!(base > 0) || !(ali > 0) || !(alie >= 0) || ali <= alie) {
        return res.status(400).json({ success: false, error: 'baseCalculo > 0 e aliquotaInterna > aliquotaInterestadual obrigatórios' });
      }
      const valorDifal = Number((base * (ali - alie) / 100).toFixed(2));
      const valorFcp = Number((base * fcpPct / 100).toFixed(2));
      const valorTotal = Number((valorDifal + valorFcp).toFixed(2));
      const usuario = req.session?.username || null;

      let contaPagarId = null;
      const tx = db.transaction(() => {
        if (gerarContaPagar) {
          const nomeForn = `SEFAZ ${String(uf).toUpperCase()}`;
          let forn = db.prepare('SELECT id FROM fornecedores WHERE razaoSocial = ?').get(nomeForn);
          if (!forn) {
            const rf = db.prepare(`INSERT INTO fornecedores (razaoSocial, cpfCnpj, tipo) VALUES (?, ?, 'PJ')`)
              .run(nomeForn, '00000000000000');
            forn = { id: rf.lastInsertRowid };
          }
          const { criarContaAPagar } = require('./contas-pagar-routes');
          contaPagarId = criarContaAPagar(db, {
            fornecedorId: forn.id,
            descricao: `GNRE ${String(uf).toUpperCase()} — DIFAL${fcpPct ? '+FCP' : ''}${faturaId ? ' NF ' + faturaId : ''}`,
            valor: valorTotal,
            dataVencimento: dataVencimento || new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10),
            origem: 'gnre'
          });
        }
        const r = db.prepare(`INSERT INTO gnre_guias
          (faturaId, uf, tipo, baseCalculo, aliquotaInterna, aliquotaInterestadual, percentualFcp,
           valorDifal, valorFcp, valorTotal, dataVencimento, contaPagarId, observacao, usuario)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          faturaId || null, String(uf).toUpperCase(), tipo === 'st' ? 'st' : 'difal',
          base, ali, alie, fcpPct, valorDifal, valorFcp, valorTotal,
          dataVencimento || null, contaPagarId, observacao || null, usuario);
        return r.lastInsertRowid;
      });
      const id = tx();
      logAction(db, req, 'criar', 'gnre', id, { uf, valorTotal, contaPagarId });
      res.json({ success: true, id, valorDifal, valorFcp, valorTotal, contaPagarId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/gnre/:id/baixar', (req, res) => {
    try {
      const g = db.prepare('SELECT * FROM gnre_guias WHERE id = ?').get(req.params.id);
      if (!g) return res.status(404).json({ success: false, error: 'Guia não encontrada' });
      if (g.status !== 'pendente') return res.status(400).json({ success: false, error: `Status atual: ${g.status}` });
      db.prepare("UPDATE gnre_guias SET status = 'paga' WHERE id = ?").run(g.id);
      logAction(db, req, 'baixar', 'gnre', g.id, {});
      res.json({ success: true, aviso: g.contaPagarId ? `Baixe também a conta a pagar #${g.contaPagarId} pelo financeiro` : undefined });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/gnre/:id/cancelar', (req, res) => {
    try {
      const g = db.prepare('SELECT * FROM gnre_guias WHERE id = ?').get(req.params.id);
      if (!g) return res.status(404).json({ success: false, error: 'Guia não encontrada' });
      if (g.status !== 'pendente') return res.status(400).json({ success: false, error: `Status atual: ${g.status}` });
      db.prepare("UPDATE gnre_guias SET status = 'cancelada' WHERE id = ?").run(g.id);
      logAction(db, req, 'cancelar', 'gnre', g.id, {});
      res.json({ success: true, aviso: g.contaPagarId ? `Cancele também a conta a pagar #${g.contaPagarId}` : undefined });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasFiscalOps, migrarFiscalOpsDB, registrarEventoNfe };
