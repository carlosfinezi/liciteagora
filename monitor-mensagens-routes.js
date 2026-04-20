/**
 * monitor-mensagens-routes.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.27).
 *
 * Agrupa as 4 rotas do bloco "ROBÔ DE MONITORAMENTO DE MENSAGENS
 * DO COMPRASNET" que operam a Map de monitores por licitação
 * (`monitoramentosAtivos`) via MonitorChat (legado):
 *   - POST /api/chat/iniciar-monitoramento
 *   - POST /api/chat/parar-monitoramento
 *   - GET  /api/chat/status-monitoramento/:cnpj/:ano/:sequencial
 *   - GET  /api/chat/monitoramentos-ativos
 *
 * Assinatura: registrarRotasMonitorMensagens(app, db, { MonitorChat })
 *
 * A classe MonitorChat vem da factory createMonitorMensagens
 * (ver monitor-mensagens-core.js). `monitoramentosAtivos` passa a ser
 * módulo-privado aqui — não era compartilhada com nenhum outro bloco
 * do server.js.
 *
 * Onda 6.27 também removeu `autoIniciarMonitoramentoMensagens` do
 * monolito: a função estava definida mas sem nenhum chamador no
 * projeto inteiro (dead code desde as ondas anteriores).
 */

function registrarRotasMonitorMensagens(app, db, opts = {}) {
  const { MonitorChat } = opts;

  // Map de monitores ativos por key "cnpj-ano-sequencial"
  const monitoramentosAtivos = new Map();

  // Iniciar monitoramento de uma licitação
  app.post('/api/chat/iniciar-monitoramento', async (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.body;

      if (!cnpj || !ano || !sequencial) {
        return res.status(400).json({ success: false, error: 'Dados incompletos' });
      }

      const key = `${cnpj}-${ano}-${sequencial}`;

      // Verificar se já está monitorando
      if (monitoramentosAtivos.has(key)) {
        return res.status(400).json({ success: false, error: 'Já está sendo monitorado' });
      }

      // Buscar link do sistema
      const licitacao = db.prepare(`
        SELECT linkSistemaOrigem, objetoCompra
        FROM licitacoes
        WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?
      `).get(cnpj, parseInt(ano), parseInt(sequencial));

      if (!licitacao) {
        return res.status(404).json({ success: false, error: 'Licitação não encontrada' });
      }

      // Criar monitor
      const monitor = new MonitorChat(cnpj, ano, sequencial, licitacao.linkSistemaOrigem);
      monitoramentosAtivos.set(key, monitor);

      // Iniciar em background
      monitor.iniciar().catch(error => {
        console.error('Erro no monitoramento:', error);
        monitoramentosAtivos.delete(key);
      });

      res.json({ success: true, message: 'Monitoramento iniciado' });

    } catch (error) {
      console.error('Erro ao iniciar monitoramento:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Parar monitoramento
  app.post('/api/chat/parar-monitoramento', async (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.body;
      const key = `${cnpj}-${ano}-${sequencial}`;

      const monitor = monitoramentosAtivos.get(key);
      if (monitor) {
        await monitor.parar();
        monitoramentosAtivos.delete(key);
      }

      res.json({ success: true, message: 'Monitoramento parado' });

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Status do monitoramento
  app.get('/api/chat/status-monitoramento/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;
      const key = `${cnpj}-${ano}-${sequencial}`;

      const monitor = monitoramentosAtivos.get(key);
      if (monitor) {
        res.json({ success: true, ...monitor.getStatus() });
      } else {
        res.json({ success: true, ativo: false, logs: [] });
      }

    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar todos os monitoramentos ativos
  app.get('/api/chat/monitoramentos-ativos', (req, res) => {
    try {
      const ativos = [];
      for (const [key, monitor] of monitoramentosAtivos) {
        ativos.push({
          key,
          cnpj: monitor.cnpj,
          ano: monitor.ano,
          sequencial: monitor.sequencial,
          ativo: monitor.ativo
        });
      }
      res.json({ success: true, data: ativos });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('Rotas de monitoramento de mensagens registradas!');
}

module.exports = { registrarRotasMonitorMensagens };
