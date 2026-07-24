/**
 * participacao-monitoramento-routes.js
 * ------------------------------------------------------------------
 * Extraído do server.js (NFSE-M06 onda 6.25).
 *
 * Agrupa duas seções contíguas do monolito:
 *   1. MONITORAMENTO DE CHAT
 *      - POST   /api/chat/monitorar
 *      - POST   /api/chat/monitoramento/registrar
 *      - POST   /api/chat/monitoramento/desativar/:compraId
 *      - DELETE /api/chat/monitorar/:cnpj/:ano/:sequencial
 *   2. SINCRONIZAÇÃO DE PARTICIPAÇÕES
 *      - POST   /api/chat/participacoes/sincronizar
 *      - GET    /api/chat/monitoramentos
 *      - POST   /api/chat/mensagem
 *
 * Assinatura: registrarRotasParticipacaoMonitoramento(app, db, { enviarTelegram })
 *
 * Observação: /api/chat/mensagem usa o esquema legado de chat_mensagens
 * (colunas cnpj/ano/sequencial/mensagemId/remetente/conteudo/dataHora).
 * Preservado 1:1 conforme monolito — possível código legado pré-migração
 * das rotas /api/chat/mensagens/* (que usam cnpjOrgao/ano/sequencial etc).
 */

// Fase 3g (2026-05-23): SELECT licitacoes vai pra PG quando flag ativa
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

function registrarRotasParticipacaoMonitoramento(app, db, opts = {}) {
  const { enviarTelegram } = opts;

  // ==================== MONITORAMENTO DE CHAT ====================

  // Iniciar monitoramento de chat de uma licitação
  app.post('/api/chat/monitorar', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.body;

      if (!cnpj || !ano || !sequencial) {
        return res.status(400).json({ success: false, error: 'Dados incompletos' });
      }

      db.prepare(`
        INSERT OR REPLACE INTO chat_monitoramento (cnpj, ano, sequencial, ativo, dataCriacao)
        VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).run(cnpj, ano, sequencial);

      res.json({ success: true, message: 'Monitoramento ativado' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Registro automático de licitação acessada (chamado pela extensão)
  app.post('/api/chat/monitoramento/registrar', (req, res) => {
    try {
      const { cnpj, ano, sequencial, compraId, url } = req.body;

      if (!compraId && (!cnpj || !ano || !sequencial)) {
        return res.status(400).json({ success: false, error: 'Precisa de compraId ou cnpj/ano/sequencial' });
      }

      // Registro por compraId → direto em participacoes_comprasnet (tabela do polling)
      if (compraId) {
        const existente = db.prepare('SELECT id, cnpj, urlCompra FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);
        if (existente) {
          // Atualiza campos que estavam vazios + marca ativo
          db.prepare(`UPDATE participacoes_comprasnet SET
            cnpj = CASE WHEN cnpj IS NULL OR cnpj = '' THEN ? ELSE cnpj END,
            ano = CASE WHEN ano IS NULL OR ano = 0 THEN ? ELSE ano END,
            sequencial = CASE WHEN sequencial IS NULL OR sequencial = 0 THEN ? ELSE sequencial END,
            urlCompra = CASE WHEN urlCompra IS NULL OR urlCompra = '' OR urlCompra NOT LIKE '%acompanhamento-compra%' THEN ? ELSE urlCompra END,
            dataAtualizacao = CURRENT_TIMESTAMP, ativo = 1
            WHERE compraId = ?`).run(cnpj || '', ano || 0, sequencial || 0, url || '', compraId);
          return res.json({ success: true, novo: false, message: 'Já monitorado' });
        }

        db.prepare(`
          INSERT INTO participacoes_comprasnet
            (compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao, objeto, etapa, situacao, urlCompra, dataSessao, ativo, dataAtualizacao)
          VALUES (?, ?, '', ?, ?, '', '', '', '', '', '', ?, '', 1, CURRENT_TIMESTAMP)
        `).run(compraId, cnpj || '', ano || 0, sequencial || 0, url || '');

        console.log(`[Auto-Monitor] Registrado: compraId=${compraId}`);
        return res.json({ success: true, novo: true, message: 'Registrado para monitoramento' });
      }

      // Fallback: registro por cnpj/ano/sequencial
      const existente = db.prepare('SELECT id FROM chat_monitoramento WHERE cnpj = ? AND ano = ? AND sequencial = ?')
        .get(cnpj, ano, sequencial);

      if (existente) {
        return res.json({ success: true, novo: false, message: 'Já monitorado' });
      }

      db.prepare(`
        INSERT INTO chat_monitoramento (cnpj, ano, sequencial, ativo, dataCriacao)
        VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
      `).run(cnpj, ano, sequencial);

      console.log(`[Auto-Monitor] Registrado: ${cnpj}/${ano}/${sequencial}`);
      res.json({ success: true, novo: true, message: 'Registrado para monitoramento' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Desativar monitoramento por compraId
  app.post('/api/chat/monitoramento/desativar/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;
      db.prepare('UPDATE participacoes_comprasnet SET ativo = 0 WHERE compraId = ?').run(compraId);
      res.json({ success: true, message: 'Monitoramento desativado' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Parar monitoramento
  app.delete('/api/chat/monitorar/:cnpj/:ano/:sequencial', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;

      db.prepare('UPDATE chat_monitoramento SET ativo = 0 WHERE cnpj = ? AND ano = ? AND sequencial = ?')
        .run(cnpj, ano, sequencial);

      res.json({ success: true, message: 'Monitoramento desativado' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== SINCRONIZAÇÃO DE PARTICIPAÇÕES ====================

  // Receber participações do Comprasnet (chamado pela extensão)
  app.post('/api/chat/participacoes/sincronizar', (req, res) => {
    try {
      const { participacoes } = req.body;

      if (!participacoes || !Array.isArray(participacoes)) {
        return res.status(400).json({ success: false, error: 'Participações inválidas' });
      }

      console.log(`[Participações] Recebendo ${participacoes.length} participações para sincronizar`);

      let inseridas = 0;
      let atualizadas = 0;

      const insertStmt = db.prepare(`
        INSERT INTO participacoes_comprasnet
          (compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao, objeto, etapa, situacao, urlCompra, dataSessao, ativo, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(compraId) DO UPDATE SET
          etapa = excluded.etapa,
          situacao = excluded.situacao,
          objeto = COALESCE(excluded.objeto, objeto),
          dataAtualizacao = CURRENT_TIMESTAMP,
          ativo = 1
      `);

      for (const p of participacoes) {
        try {
          // Monta o compraId se não vier
          const compraId = p.compraId || `${p.codigoUnidade || p.cnpj}${String(p.sequencial || p.numero).padStart(5, '0')}${p.ano}`;

          const result = insertStmt.run(
            compraId,
            p.cnpj || p.cnpjOrgao || '',
            p.codigoUnidade || p.uasg || '',
            p.ano || 0,
            p.sequencial || p.numero || 0,
            p.tipo || '',
            p.numero || p.sequencial || '',
            p.orgao || p.nomeOrgao || '',
            p.objeto || p.objetoCompra || '',
            p.etapa || '',
            p.situacao || p.status || '',
            p.urlCompra || p.url || '',
            p.dataSessao || ''
          );

          if (result.changes > 0) {
            if (result.lastInsertRowid) {
              inseridas++;
            } else {
              atualizadas++;
            }
          }
        } catch (e) {
          console.log(`[Participações] Erro ao inserir: ${e.message}`);
        }
      }

      console.log(`[Participações] Sincronização concluída: ${inseridas} novas, ${atualizadas} atualizadas`);
      res.json({
        success: true,
        inseridas,
        atualizadas,
        total: participacoes.length
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar monitoramentos ativos (participações do Comprasnet)
  app.get('/api/chat/monitoramentos', (req, res) => {
    try {
      // Busca licitações para polling da tabela participacoes_comprasnet
      const monitoramentos = db.prepare(`
        SELECT compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero,
               orgao as nomeOrgao, objeto as objetoCompra, etapa, situacao, urlCompra, dataSessao
        FROM participacoes_comprasnet
        WHERE ativo = 1 AND compraId IS NOT NULL AND compraId != ''
        ORDER BY dataAtualizacao DESC
      `).all();

      res.json({ success: true, data: monitoramentos });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Registrar nova mensagem do chat (será chamado pelo robô)
  app.post('/api/chat/mensagem', async (req, res) => {
    try {
      const { cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora } = req.body;

      // Verificar se mensagem já existe
      const existe = db.prepare('SELECT id FROM chat_mensagens WHERE cnpj = ? AND ano = ? AND sequencial = ? AND mensagemId = ?')
        .get(cnpj, ano, sequencial, mensagemId);

      if (existe) {
        return res.json({ success: true, message: 'Mensagem já registrada' });
      }

      // Salvar mensagem
      db.prepare(`
        INSERT INTO chat_mensagens (cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(cnpj, ano, sequencial, mensagemId, remetente, conteudo, dataHora);

      // Buscar informações da licitação
      let licitacao;
      if (USE_PG) {
        licitacao = await catalogPg.queryOne(
          `SELECT "objetoCompra","razaoSocial" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3`,
          [cnpj, ano, sequencial]
        );
      } else {
        licitacao = db.prepare('SELECT objetoCompra, razaoSocial FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?')
          .get(cnpj, ano, sequencial);
      }

      // Enviar alerta no Telegram
      const mensagemTelegram = `🔔 <b>NOVA MENSAGEM NO CHAT</b>\n\n` +
        `<b>Licitação:</b> ${licitacao?.objetoCompra?.substring(0, 100) || 'N/A'}...\n` +
        `<b>Órgão:</b> ${licitacao?.razaoSocial || 'N/A'}\n\n` +
        `<b>De:</b> ${remetente}\n` +
        `<b>Mensagem:</b>\n${conteudo}\n\n` +
        `<i>${dataHora}</i>`;

      const enviado = await enviarTelegram(mensagemTelegram);

      // Marcar como notificado
      if (enviado) {
        db.prepare('UPDATE chat_mensagens SET notificado = 1 WHERE cnpj = ? AND ano = ? AND sequencial = ? AND mensagemId = ?')
          .run(cnpj, ano, sequencial, mensagemId);
      }

      res.json({ success: true, notificado: enviado });
    } catch (error) {
      console.error('Erro ao registrar mensagem:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[ParticipacaoMonitoramento] Rotas registradas');
}

module.exports = { registrarRotasParticipacaoMonitoramento };
