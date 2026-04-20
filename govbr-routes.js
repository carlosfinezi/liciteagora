/**
 * govbr-routes.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.28).
 *
 * 3 rotas de credenciais gov.br:
 *   - GET    /api/govbr/status         (somente CPF mascarado)
 *   - POST   /api/govbr/config         (salva CPF/senha + inicia monitor)
 *   - DELETE /api/govbr/config         (remove credenciais + para monitor)
 *
 * Encapsula o singleton `monitorMensagens` (instância corrente de
 * MonitorMensagensComprasnet) que era `let monitorMensagens = null;` no
 * topo do server.js. As 3 rotas mutavam esse binding; a rota
 * POST /api/extensao/* (em extensao-chrome-routes.js) lia via closure
 * `getMonitor: () => monitorMensagens`. Agora o estado vive aqui e o
 * factory expõe `getMonitor` para quem precisar.
 *
 * Assinatura:
 *   registrarRotasGovBr(app, db, { getConfigValue, setConfigValue, MonitorMensagensComprasnet })
 *     → { getMonitor: () => monitorMensagens }
 *
 * A classe MonitorMensagensComprasnet vem da factory createMonitorMensagens
 * (monitor-mensagens-core.js) e é injetada aqui.
 */

function registrarRotasGovBr(app, db, opts = {}) {
  const { getConfigValue, setConfigValue, MonitorMensagensComprasnet } = opts;

  // Singleton do monitor global de mensagens do Comprasnet.
  // Era `let monitorMensagens = null;` no topo do server.js pré-6.28.
  let monitorMensagens = null;

  // Verificar status das credenciais gov.br
  app.get('/api/govbr/status', (req, res) => {
    try {
      const cpf = getConfigValue('govbr_cpf');

      if (cpf) {
        // Mascarar o CPF para exibição
        const cpfMascarado = cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.***.***-$4');
        res.json({
          success: true,
          configurado: true,
          cpf: cpfMascarado
        });
      } else {
        res.json({
          success: true,
          configurado: false
        });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar credenciais gov.br
  app.post('/api/govbr/config', async (req, res) => {
    try {
      const { cpf, senha } = req.body;

      if (!cpf || !senha) {
        return res.status(400).json({ success: false, error: 'CPF e senha são obrigatórios' });
      }

      // Limpar CPF (remover pontos e traços)
      const cpfLimpo = cpf.replace(/\D/g, '');

      if (cpfLimpo.length !== 11) {
        return res.status(400).json({ success: false, error: 'CPF inválido' });
      }

      // Salvar no banco
      setConfigValue('govbr_cpf', cpfLimpo);
      setConfigValue('govbr_senha', senha);

      console.log('[Gov.br] Credenciais salvas');

      // Tentar iniciar o monitor de mensagens
      if (!monitorMensagens || !monitorMensagens.ativo) {
        console.log('[Gov.br] Iniciando monitor de mensagens...');
        monitorMensagens = new MonitorMensagensComprasnet();
        monitorMensagens.iniciar().catch(error => {
          console.error('[Monitor Mensagens] Erro ao iniciar:', error.message);
        });
      }

      res.json({
        success: true,
        message: 'Credenciais salvas com sucesso'
      });

    } catch (error) {
      console.error('Erro ao salvar credenciais gov.br:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover credenciais gov.br
  app.delete('/api/govbr/config', async (req, res) => {
    try {
      // Parar o monitor se estiver ativo
      if (monitorMensagens && monitorMensagens.ativo) {
        await monitorMensagens.parar();
        monitorMensagens = null;
      }

      // Remover credenciais
      db.prepare("DELETE FROM config WHERE chave = 'govbr_cpf'").run();
      db.prepare("DELETE FROM config WHERE chave = 'govbr_senha'").run();

      res.json({ success: true, message: 'Credenciais removidas' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[GovBr] Rotas registradas');

  return {
    getMonitor: () => monitorMensagens,
  };
}

module.exports = { registrarRotasGovBr };
