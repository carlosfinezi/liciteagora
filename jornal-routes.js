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
// Fase 3g (2026-05-23): catalog probe via PG
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

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

      // [DEBUG] dump do body recebido pra investigar por que jornal_grupos fica vazio
      console.log(`[JORNAL][POST config] body recebido:`,
        JSON.stringify({ ativo, horario, diasAntecedencia, enviarTelegram,
          gruposIds, gruposIdsLen: Array.isArray(gruposIds) ? gruposIds.length : null }));

      // Atualizar configuração
      db.prepare(`
        UPDATE jornal_config
        SET ativo = ?, horario = ?, diasAntecedencia = ?, enviarTelegram = ?
        WHERE id = 1
      `).run(ativo ? 1 : 0, horario || '08:00', diasAntecedencia || 7, enviarTelegram ? 1 : 0);

      // Atualizar grupos ativos
      const delResult = db.prepare('DELETE FROM jornal_grupos').run();
      let insOk = 0, insFail = 0;
      if (gruposIds && gruposIds.length > 0) {
        const insertGrupo = db.prepare('INSERT OR IGNORE INTO jornal_grupos (grupoId, ativo) VALUES (?, 1)');
        gruposIds.forEach(id => {
          try {
            const r = insertGrupo.run(id);
            if (r.changes > 0) insOk++; else insFail++;
          } catch (e) {
            insFail++;
            console.error(`[JORNAL][POST config] INSERT grupoId=${id} falhou: ${e.message}`);
          }
        });
      }
      const total = db.prepare('SELECT COUNT(*) c FROM jornal_grupos').get().c;
      console.log(`[JORNAL][POST config] deleted=${delResult.changes} inserted_ok=${insOk} inserted_fail=${insFail} total_atual=${total}`);

      // Reagendar o jornal (rota exposta no worker — jornal-scheduler no-op fora do master)
      agendarJornal(db);

      res.json({ success: true, message: 'Configuração salva!', debug: { deleted: delResult.changes, insertedOk: insOk, insertedFail: insFail, total } });
    } catch (error) {
      console.error(`[JORNAL][POST config] ERRO:`, error.message);
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
      console.log(`[JORNAL][GET preview] chamado`);
      const gruposCount = db.prepare('SELECT COUNT(*) c FROM jornal_grupos').get().c;
      let catalogStatus = 'ok';
      try {
        if (USE_PG) await catalogPg.queryOne('SELECT 1 FROM licitacoes LIMIT 1');
        else db.prepare('SELECT COUNT(*) FROM licitacoes LIMIT 1').get();
      } catch (e) { catalogStatus = `VIEW_FAIL: ${e.message}`; }
      console.log(`[JORNAL][GET preview] jornal_grupos.count=${gruposCount} catalog=${catalogStatus}`);

      const resultado = await gerarConteudoJornal(db);
      console.log(`[JORNAL][GET preview] resultado: grupos=${resultado.grupos?.length||0} total=${resultado.totalLicitacoes||0} periodo=${resultado.periodo?.dataInicial}→${resultado.periodo?.dataFinal}`);
      res.json({ success: true, data: resultado });
    } catch (error) {
      console.error(`[JORNAL][GET preview] ERRO:`, error.message, error.stack);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Jornal] Rotas registradas');
}

module.exports = { registrarRotasJornal };
