// jornal-routes.js
//
// Rotas HTTP do Jornal de Licitações (configuração, histórico, preview,
// execução manual). Extraído de server.js em NFSE-M06 onda 6.6.
//
// O scheduler em si (agendarJornal/pararJornal + envio via Telegram às
// HH:MM configurado) já vive em jornal-scheduler.js desde onda 5A — aqui
// são só as 5 rotas HTTP que o worker expõe para a UI (/public/jornal.html).
// Mesma função agendarJornal é chamada de POST /api/jornal/config para
// reagendar após mudança de horário/ativação; no worker (ROLE=worker) a
// chamada é um no-op idempotente pois o scheduler só arma timers quando
// ROLE=master.

const { agendarJornal, executarJornal, gerarConteudoJornal } = require('./jornal-scheduler');

function registrarRotasJornal(app, db) {
  // Obter configuração do jornal
  app.get('/api/jornal/config', (req, res) => {
    try {
      const config = db.prepare('SELECT * FROM jornal_config WHERE id = 1').get();
      const gruposAtivos = db.prepare(`
        SELECT jg.grupoId, g.nome, g.cor
        FROM jornal_grupos jg
        JOIN grupos_palavras g ON g.id = jg.grupoId
        WHERE jg.ativo = 1
      `).all();

      res.json({
        success: true,
        data: {
          ...config,
          gruposAtivos
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar configuração do jornal
  app.post('/api/jornal/config', (req, res) => {
    try {
      const { ativo, horario, diasAntecedencia, enviarTelegram, gruposIds } = req.body;

      // Atualizar configuração
      db.prepare(`
        UPDATE jornal_config
        SET ativo = ?, horario = ?, diasAntecedencia = ?, enviarTelegram = ?
        WHERE id = 1
      `).run(ativo ? 1 : 0, horario || '08:00', diasAntecedencia || 7, enviarTelegram ? 1 : 0);

      // Atualizar grupos ativos
      db.prepare('DELETE FROM jornal_grupos').run();
      if (gruposIds && gruposIds.length > 0) {
        const insertGrupo = db.prepare('INSERT OR IGNORE INTO jornal_grupos (grupoId, ativo) VALUES (?, 1)');
        gruposIds.forEach(id => insertGrupo.run(id));
      }

      // Reagendar o jornal (rota exposta no worker — jornal-scheduler no-op fora do master)
      agendarJornal(db);

      res.json({ success: true, message: 'Configuração salva!' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Obter histórico de envios
  app.get('/api/jornal/historico', (req, res) => {
    try {
      const historico = db.prepare(`
        SELECT * FROM jornal_historico
        ORDER BY dataEnvio DESC
        LIMIT 30
      `).all();

      res.json({ success: true, data: historico });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Executar jornal manualmente (para teste)
  app.post('/api/jornal/executar', async (req, res) => {
    try {
      const resultado = await executarJornal(db);
      res.json({ success: true, data: resultado });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Preview do jornal (sem enviar)
  app.get('/api/jornal/preview', async (req, res) => {
    try {
      const resultado = await gerarConteudoJornal(db);
      res.json({ success: true, data: resultado });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Jornal] Rotas registradas');
}

module.exports = { registrarRotasJornal };
