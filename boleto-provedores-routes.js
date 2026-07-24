/**
 * boleto-provedores-routes.js — CRUD de configuração de provedor por conta financeira.
 *
 * Endpoints:
 *   GET  /api/boleto-provedores                               — lista provedores disponíveis + schema de campos
 *   GET  /api/contas-financeiras/:id/boleto-config            — config atual da conta (ou null)
 *   POST /api/contas-financeiras/:id/boleto-config            — salva/atualiza
 *   DELETE /api/contas-financeiras/:id/boleto-config          — desativa
 *   POST /api/contas-financeiras/:id/boleto-config/testar     — testa autenticação
 */

const provedores = require('./boleto-provedores');
const orchestrator = require('./boleto-orchestrator');

function registrarRotasBoletoProvedores(app, db) {
  orchestrator.migrarSchema(db);

  app.get('/api/boleto-provedores', (req, res) => {
    try {
      res.json({ success: true, provedores: provedores.listar() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-financeiras/:id/boleto-config', (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM contas_financeiras_boleto WHERE contaFinanceiraId = ?')
        .get(req.params.id);
      if (!row) return res.json({ success: true, config: null });
      let configJson = {};
      try { configJson = JSON.parse(row.configJson || '{}'); } catch {}
      // Mascarar campos sensíveis (password) antes de devolver
      const modulo = provedores.get(row.provedor);
      const masked = { ...configJson };
      if (modulo?.camposConfig) {
        for (const c of modulo.camposConfig) {
          if (c.type === 'password' && masked[c.name]) masked[c.name] = '***';
        }
      }
      res.json({
        success: true,
        config: {
          contaFinanceiraId: row.contaFinanceiraId,
          provedor: row.provedor,
          ambiente: row.ambiente,
          ativo: !!row.ativo,
          ehPadrao: !!row.ehPadrao,
          proximoNossoNumero: row.proximoNossoNumero,
          temCertificado: !!row.certificadoBase64,
          campos: masked,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras/:id/boleto-config', (req, res) => {
    try {
      const contaFinanceiraId = Number(req.params.id);
      const b = req.body || {};
      const nomeProvedor = String(b.provedor || '').trim();
      const modulo = provedores.get(nomeProvedor);
      if (!modulo) return res.status(400).json({ success: false, error: `Provedor inválido: ${nomeProvedor}` });

      // Merge com config anterior pra não sobrescrever campos password não-enviados
      const existente = db.prepare('SELECT configJson, certificadoBase64, certificadoSenhaCripto FROM contas_financeiras_boleto WHERE contaFinanceiraId = ?').get(contaFinanceiraId);
      let configAnterior = {};
      try { configAnterior = existente ? JSON.parse(existente.configJson || '{}') : {}; } catch {}
      const campos = { ...configAnterior, ...(b.campos || {}) };
      // Se veio "***" no password, significa "não mexer"
      if (modulo.camposConfig) {
        for (const c of modulo.camposConfig) {
          if (c.type === 'password' && campos[c.name] === '***') {
            campos[c.name] = configAnterior[c.name];
          }
        }
      }

      const validacao = modulo.validarConfig(campos);
      if (!validacao.ok) return res.status(400).json({ success: false, error: validacao.erro || 'Config inválida' });

      const certificadoBase64 = b.certificadoBase64 || existente?.certificadoBase64 || null;
      const certificadoSenhaCripto = b.certificadoSenha
        ? Buffer.from(String(b.certificadoSenha), 'utf-8').toString('base64')
        : (existente?.certificadoSenhaCripto || null);

      db.prepare(`
        INSERT INTO contas_financeiras_boleto
          (contaFinanceiraId, provedor, ambiente, ativo, configJson, certificadoBase64, certificadoSenhaCripto, proximoNossoNumero)
        VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT proximoNossoNumero FROM contas_financeiras_boleto WHERE contaFinanceiraId = ?), 1))
        ON CONFLICT(contaFinanceiraId) DO UPDATE SET
          provedor = excluded.provedor,
          ambiente = excluded.ambiente,
          ativo = excluded.ativo,
          configJson = excluded.configJson,
          certificadoBase64 = excluded.certificadoBase64,
          certificadoSenhaCripto = excluded.certificadoSenhaCripto,
          dataAtualizacao = CURRENT_TIMESTAMP
      `).run(
        contaFinanceiraId,
        nomeProvedor,
        b.ambiente || 'homologacao',
        b.ativo ? 1 : 0,
        JSON.stringify(campos),
        certificadoBase64,
        certificadoSenhaCripto,
        contaFinanceiraId
      );

      // Permite editar proximoNossoNumero manualmente (migração de banco antigo)
      if (b.proximoNossoNumero != null) {
        db.prepare('UPDATE contas_financeiras_boleto SET proximoNossoNumero = ? WHERE contaFinanceiraId = ?')
          .run(Math.max(1, Number(b.proximoNossoNumero) || 1), contaFinanceiraId);
      }

      // Flag "conta padrão para boletos" — exclusiva: só uma conta pode ser padrão
      if (b.ehPadrao) {
        db.prepare('UPDATE contas_financeiras_boleto SET ehPadrao = 0 WHERE contaFinanceiraId != ?').run(contaFinanceiraId);
        db.prepare('UPDATE contas_financeiras_boleto SET ehPadrao = 1 WHERE contaFinanceiraId = ?').run(contaFinanceiraId);
      } else if (b.ehPadrao === false || b.ehPadrao === 0) {
        db.prepare('UPDATE contas_financeiras_boleto SET ehPadrao = 0 WHERE contaFinanceiraId = ?').run(contaFinanceiraId);
      }

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/contas-financeiras/:id/boleto-config', (req, res) => {
    try {
      db.prepare('UPDATE contas_financeiras_boleto SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE contaFinanceiraId = ?')
        .run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras/:id/boleto-config/testar', async (req, res) => {
    try {
      const row = db.prepare('SELECT * FROM contas_financeiras_boleto WHERE contaFinanceiraId = ?').get(req.params.id);
      if (!row) return res.status(404).json({ success: false, error: 'Configuração não encontrada' });
      const modulo = provedores.get(row.provedor);
      if (!modulo) return res.status(400).json({ success: false, error: 'Provedor inválido' });
      const cfg = orchestrator._internal.parseConfigJson(row);
      await modulo.autenticar(cfg);
      res.json({ success: true, mensagem: `${modulo.label} autenticou com sucesso` });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  console.log('[BoletoProvedores] Rotas registradas');
}

module.exports = { registrarRotasBoletoProvedores };
