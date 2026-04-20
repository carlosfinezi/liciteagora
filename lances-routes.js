// lances-routes.js
//
// Rotas HTTP da API de Lances / Disputa — 10 endpoints consumidos pela
// extensão do Chrome (token-relay) para reportar e coordenar lances
// durante a fase de disputa da licitação. Extraído de server.js em
// NFSE-M06 onda 6.11.
//
// IMPORTANTE: o bloco carrega ESTADO IN-MEMORY — lancesConfig, lancesLog e
// ultimoLance — compartilhado entre todas as 10 rotas. No monolito isso
// vivia como `let` top-level do server.js. Aqui vive no closure da
// factory: mesma semântica (um único snapshot por processo), mas
// encapsulado. Auditoria confirmou zero refs fora do bloco (grep do
// server.js pós-extração).
//
// Não confundir com o SNIPER (lance-engine.js) que é um motor autônomo
// com persistência em SQLite e configuração por licitação. Este módulo
// é a coordenação leve com a extensão: a extensão roda no Chrome do
// usuário, observa o pregão em tempo real, reporta eventos via POST
// /api/lance/evento, e em eventos importantes (lance_enviado, melhor_lance,
// perdemos) o worker dispara alerta no Telegram.
//
// enviarTelegram vem via DI — mesmo padrão da onda 6.10 (centralização
// de helpers fica para onda 7).

function registrarRotasLances(app, db, { enviarTelegram }) {
  // Armazena configurações e estado dos lances em memória
  let lancesConfig = {
    compraId: null,
    uasg: null,
    modo: 'valor',       // 'valor' ou 'percentual'
    cobertura: 0.01,     // valor ou percentual para cobrir
    minimo: null,        // valor mínimo (não cobrir abaixo disso)
    automatico: false,   // modo automático ativado
    itensMonitorados: [] // itens que estamos monitorando
  };

  let lancesLog = [];     // histórico de lances
  let ultimoLance = null; // último lance enviado

  // Obter configuração atual de lances
  app.get('/api/lance/config', (req, res) => {
    res.json({ success: true, data: lancesConfig });
  });

  // Atualizar configuração de lances
  app.post('/api/lance/config', (req, res) => {
    try {
      const { compraId, uasg, modo, cobertura, minimo, automatico, itensMonitorados } = req.body;

      if (compraId !== undefined) lancesConfig.compraId = compraId;
      if (uasg !== undefined) lancesConfig.uasg = uasg;
      if (modo !== undefined) lancesConfig.modo = modo;
      if (cobertura !== undefined) lancesConfig.cobertura = parseFloat(cobertura) || 0.01;
      if (minimo !== undefined) lancesConfig.minimo = minimo ? parseFloat(minimo) : null;
      if (automatico !== undefined) lancesConfig.automatico = automatico;
      if (itensMonitorados !== undefined) lancesConfig.itensMonitorados = itensMonitorados;

      console.log('[LANCE] Configuração atualizada:', lancesConfig);

      res.json({ success: true, data: lancesConfig });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Obter status atual (para polling da extensão)
  app.get('/api/lance/status', (req, res) => {
    res.json({
      success: true,
      data: {
        config: lancesConfig,
        ultimoLance,
        logsRecentes: lancesLog.slice(-10)
      }
    });
  });

  // Registrar evento de lance (extensão reporta)
  app.post('/api/lance/evento', async (req, res) => {
    try {
      const { tipo, item, valorAtual, valorNovo, concorrente, timestamp, sucesso, erro } = req.body;

      const evento = {
        tipo,           // 'lance_detectado', 'lance_enviado', 'lance_erro', 'melhor_lance', 'perdemos'
        item,
        valorAtual,
        valorNovo,
        concorrente,
        timestamp: timestamp || new Date().toISOString(),
        sucesso,
        erro
      };

      lancesLog.push(evento);

      // Mantém apenas os últimos 100 eventos
      if (lancesLog.length > 100) {
        lancesLog = lancesLog.slice(-100);
      }

      // Se foi um lance enviado, atualiza o último lance
      if (tipo === 'lance_enviado' && sucesso) {
        ultimoLance = evento;
      }

      console.log(`[LANCE] Evento: ${tipo} - Item ${item} - Valor: ${valorNovo || valorAtual}`);

      // Envia alerta Telegram para eventos importantes
      if (['lance_enviado', 'melhor_lance', 'perdemos'].includes(tipo)) {
        try {
          let mensagem = '';

          if (tipo === 'lance_enviado' && sucesso) {
            mensagem = `🎯 <b>LANCE ENVIADO!</b>\n\n`;
            mensagem += `📦 <b>Item:</b> ${item}\n`;
            mensagem += `💰 <b>Valor:</b> R$ ${valorNovo?.toFixed(2) || 'N/A'}\n`;
            mensagem += `🏢 <b>UASG:</b> ${lancesConfig.uasg || 'N/A'}\n`;
            mensagem += `\n⏰ ${new Date().toLocaleString('pt-BR')}`;
          } else if (tipo === 'melhor_lance') {
            mensagem = `✅ <b>MELHOR LANCE!</b>\n\n`;
            mensagem += `📦 <b>Item:</b> ${item}\n`;
            mensagem += `💰 <b>Valor:</b> R$ ${valorAtual?.toFixed(2) || 'N/A'}\n`;
            mensagem += `🏢 <b>UASG:</b> ${lancesConfig.uasg || 'N/A'}\n`;
            mensagem += `\n⏰ ${new Date().toLocaleString('pt-BR')}`;
          } else if (tipo === 'perdemos') {
            mensagem = `⚠️ <b>LANCE SUPERADO!</b>\n\n`;
            mensagem += `📦 <b>Item:</b> ${item}\n`;
            mensagem += `💰 <b>Melhor lance:</b> R$ ${valorAtual?.toFixed(2) || 'N/A'}\n`;
            mensagem += `👤 <b>Concorrente:</b> ${concorrente || 'Desconhecido'}\n`;
            mensagem += `🏢 <b>UASG:</b> ${lancesConfig.uasg || 'N/A'}\n`;
            mensagem += `\n⏰ ${new Date().toLocaleString('pt-BR')}`;
          }

          if (mensagem) {
            await enviarTelegram(mensagem);
          }
        } catch (e) {
          console.error('[LANCE] Erro ao enviar Telegram:', e.message);
        }
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Obter histórico de lances
  app.get('/api/lance/log', (req, res) => {
    const { limit } = req.query;
    const qtd = parseInt(limit) || 50;

    res.json({
      success: true,
      data: lancesLog.slice(-qtd)
    });
  });

  // Limpar histórico de lances
  app.delete('/api/lance/log', (req, res) => {
    lancesLog = [];
    ultimoLance = null;
    console.log('[LANCE] Histórico limpo');

    res.json({ success: true });
  });

  // Toggle modo automático
  app.post('/api/lance/automatico', (req, res) => {
    const { ativo } = req.body;

    lancesConfig.automatico = ativo !== undefined ? ativo : !lancesConfig.automatico;

    console.log(`[LANCE] Modo automático: ${lancesConfig.automatico ? 'ATIVADO' : 'DESATIVADO'}`);

    res.json({ success: true, automatico: lancesConfig.automatico });
  });

  // Receber log da extensão (POST)
  app.post('/api/lance/log', (req, res) => {
    const { mensagem, timestamp } = req.body;

    if (mensagem) {
      lancesLog.push({
        tipo: 'log',
        mensagem,
        timestamp: timestamp || new Date().toISOString()
      });

      // Mantém apenas os últimos 100 logs
      if (lancesLog.length > 100) {
        lancesLog = lancesLog.slice(-100);
      }

      console.log(`[LANCE] Log: ${mensagem}`);
    }

    res.json({ success: true });
  });

  // Receber status da extensão (POST)
  app.post('/api/lance/status', (req, res) => {
    const { compraId, itens, ativo, automatico, timestamp } = req.body;

    // Atualiza configuração com dados da extensão
    if (compraId) lancesConfig.compraId = compraId;
    if (ativo !== undefined) lancesConfig.ativo = ativo;
    if (automatico !== undefined) lancesConfig.automatico = automatico;

    // Armazena estado dos itens (opcional)
    if (itens && Array.isArray(itens)) {
      lancesConfig.itensMonitorados = itens;
    }

    console.log(`[LANCE] Status recebido: compraId=${compraId}, itens=${itens?.length || 0}, auto=${automatico}`);

    res.json({ success: true });
  });

  // Buscar limites/preços mínimos das propostas salvas para uma compra
  app.get('/api/lance/limites/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;

      if (!compraId || compraId.length < 10) {
        return res.status(400).json({ success: false, error: 'CompraId inválido' });
      }

      // Decodifica o compraId: CNPJ(14) + SEQUENCIAL(5) + ANO(4)
      // Mas o CNPJ pode ter menos dígitos se for UASG, então vamos tentar diferentes formatos
      let cnpj, sequencial, ano;

      // Formato padrão: últimos 4 dígitos = ano, 5 antes = sequencial, resto = cnpj
      ano = parseInt(compraId.slice(-4));
      sequencial = parseInt(compraId.slice(-9, -4));
      cnpj = compraId.slice(0, -9);

      console.log(`[LANCE] Buscando limites para compraId=${compraId} -> cnpj=${cnpj}, seq=${sequencial}, ano=${ano}`);

      // Primeiro tenta buscar de config_lances (configuração específica de lances)
      let limites = db.prepare(`
        SELECT numeroItem, precoMinimo
        FROM config_lances
        WHERE cnpj = ? AND ano = ? AND sequencial = ? AND precoMinimo IS NOT NULL AND ativo = 1
      `).all(cnpj, ano, sequencial);

      // Se não encontrou em config_lances, busca de valores_proposta
      if (!limites || limites.length === 0) {
        limites = db.prepare(`
          SELECT numeroItem, valorUnitario as precoMinimo
          FROM valores_proposta
          WHERE cnpj = ? AND ano = ? AND sequencial = ? AND valorUnitario IS NOT NULL AND selecionado = 1
        `).all(cnpj, ano, sequencial);
      }

      // Se ainda não encontrou, tenta sem o filtro selecionado
      if (!limites || limites.length === 0) {
        limites = db.prepare(`
          SELECT numeroItem, valorUnitario as precoMinimo
          FROM valores_proposta
          WHERE cnpj = ? AND ano = ? AND sequencial = ? AND valorUnitario IS NOT NULL
        `).all(cnpj, ano, sequencial);
      }

      // Converte para objeto { numeroItem: precoMinimo }
      const limitesObj = {};
      limites.forEach(l => {
        if (l.precoMinimo) {
          limitesObj[l.numeroItem] = l.precoMinimo;
        }
      });

      console.log(`[LANCE] Encontrados ${Object.keys(limitesObj).length} limites para compra ${compraId}`);

      res.json({
        success: true,
        data: {
          compraId,
          cnpj,
          sequencial,
          ano,
          limites: limitesObj
        }
      });
    } catch (error) {
      console.error('[LANCE] Erro ao buscar limites:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar/atualizar limites de lances (da extensão para o servidor)
  app.post('/api/lance/limites/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;
      const { limites } = req.body;

      if (!compraId || !limites) {
        return res.status(400).json({ success: false, error: 'Dados incompletos' });
      }

      // Decodifica compraId
      const ano = parseInt(compraId.slice(-4));
      const sequencial = parseInt(compraId.slice(-9, -4));
      const cnpj = compraId.slice(0, -9);

      console.log(`[LANCE] Salvando limites para compraId=${compraId}`);

      // Atualiza ou insere em config_lances
      const upsert = db.prepare(`
        INSERT INTO config_lances (cnpj, ano, sequencial, numeroItem, precoMinimo, ativo)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(cnpj, ano, sequencial, numeroItem)
        DO UPDATE SET precoMinimo = excluded.precoMinimo, dataAtualizacao = CURRENT_TIMESTAMP
      `);

      let count = 0;
      for (const [numeroItem, precoMinimo] of Object.entries(limites)) {
        if (precoMinimo) {
          upsert.run(cnpj, ano, sequencial, parseInt(numeroItem), parseFloat(precoMinimo));
          count++;
        }
      }

      console.log(`[LANCE] ${count} limites salvos`);

      res.json({ success: true, saved: count });
    } catch (error) {
      console.error('[LANCE] Erro ao salvar limites:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Lances] Rotas registradas');
}

module.exports = { registrarRotasLances };
