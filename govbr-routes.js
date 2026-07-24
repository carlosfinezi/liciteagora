/**
 * govbr-routes.js
 * ------------------------------------------------------------------
 * CRUD puro da config gov.br (CPF/senha). Isolamento multi-tenant
 * vem do middleware (tenant-middleware.js): getConfigValue /
 * setConfigValue lêem e gravam no banco do tenant da request.
 *
 * Refatorado em 2026-04-22: removido acoplamento com puppeteer
 * (MonitorMensagensComprasnet). Captura de mensagens Comprasnet
 * agora é 100% Electron standalone.
 *
 * Rotas:
 *   - GET    /api/govbr/status    (CPF mascarado)
 *   - POST   /api/govbr/config    (salva cpf + senha em config)
 *   - DELETE /api/govbr/config    (apaga ambos do config)
 *
 * Assinatura:
 *   registrarRotasGovBr(app, { getConfigValue, setConfigValue })
 */

function registrarRotasGovBr(app, opts = {}) {
  const { getConfigValue, setConfigValue } = opts;

  app.get('/api/govbr/status', (req, res) => {
    try {
      const cpf = getConfigValue('govbr_cpf');
      if (cpf) {
        const cpfMascarado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.***.***-$4');
        res.json({ success: true, configurado: true, cpf: cpfMascarado });
      } else {
        res.json({ success: true, configurado: false });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/govbr/config', (req, res) => {
    try {
      const { cpf, senha } = req.body;
      if (!cpf || !senha) {
        return res.status(400).json({ success: false, error: 'CPF e senha são obrigatórios' });
      }
      const cpfLimpo = String(cpf).replace(/\D/g, '');
      if (cpfLimpo.length !== 11) {
        return res.status(400).json({ success: false, error: 'CPF inválido' });
      }
      setConfigValue('govbr_cpf', cpfLimpo);
      setConfigValue('govbr_senha', senha);
      console.log('[Gov.br] Credenciais salvas (tenant-scoped)');
      res.json({ success: true, message: 'Credenciais salvas com sucesso' });
    } catch (error) {
      console.error('[Gov.br] Erro ao salvar credenciais:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.delete('/api/govbr/config', (req, res) => {
    try {
      setConfigValue('govbr_cpf', '');
      setConfigValue('govbr_senha', '');
      res.json({ success: true, message: 'Credenciais removidas' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[GovBr] Rotas registradas');
}

module.exports = { registrarRotasGovBr };
