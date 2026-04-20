// extensao-chrome-routes.js
//
// Rotas que recebem dados da extensão Chrome (LiciteAgora Token Relay)
// instalada em navegador local do operador humano. A extensão faz
// scraping do Comprasnet e envia mensagens, progresso de captura, logs
// de debug e traces de navegação para o servidor.
//
// Extraído de server.js em NFSE-M06 onda 6.22.
//
// Escopo: 13 rotas em 4 famílias + monitor-status espremido no meio
// (preservado 1:1 do monolito — não é refatoração estrutural).
//
//   GET  /api/chat/status                 ping "online" (sem payload).
//   POST /api/chat/keep-alive             ping para manter sessão viva.
//
//   POST /api/chat/mensagens/extensao     handler PRINCIPAL (~200 linhas).
//                                          Insere mensagens deduplicadas
//                                          em `chat_mensagens` com hash
//                                          md5(cnpjOrgao-ano-seq-remetente
//                                          -texto[0:100]). Filtra mensagens
//                                          curtas, captchas e erros. Marca
//                                          palavras-chave de chat_palavras_chave
//                                          e CNPJ do fornecedor (de
//                                          fornecedor.cnpj, fallback para
//                                          getConfigValue('fornecedor_cnpj')).
//                                          Busca info da licitação em
//                                          `licitacoes` por UASG+ano+seq
//                                          (ou só ano+seq). Dispara
//                                          enviarNotificacaoTelegram
//                                          (async fire-and-forget) e
//                                          marca notificado=1 no sucesso.
//                                          Tenta garantir coluna
//                                          origemCaptura via ALTER TABLE
//                                          idempotente (swallow error se
//                                          já existe).
//
//   GET  /api/chat/progresso/:compraId    lê chat_captura_progresso de 1.
//   POST /api/chat/progresso              upsert em chat_captura_progresso.
//   GET  /api/chat/progresso              lista 100 mais recentes.
//   DEL  /api/chat/progresso/reset-all    TRUNCATE da tabela.
//   DEL  /api/chat/progresso/:compraId    delete de 1.
//
//   GET  /api/chat/monitor-status         lê monitorMensagens via
//                                          getMonitor() closure (a
//                                          variável é let em server.js,
//                                          mutada por /admin/iniciar-
//                                          monitor, /admin/parar-monitor
//                                          e auto-iniciar no boot).
//
//   POST /api/chat/debug-logs             push em extensaoDebugLogs
//                                          (ring buffer 100 itens,
//                                          in-memory).
//   GET  /api/chat/debug-logs             lista extensaoDebugLogs.
//   POST /api/chat/navegacao              push em navegacaoLogs (ring
//                                          buffer 500 itens, in-memory).
//   GET  /api/chat/navegacao              lista navegacaoLogs.
//
// ESTADO INTERNO (reset a cada restart do worker — 1:1 do monolito):
//   - extensaoDebugLogs   array circular de até 100 itens
//   - navegacaoLogs       array circular de até 500 itens
//
// DEPENDÊNCIAS do factory:
//   - db                          better-sqlite3 (chat_mensagens,
//                                  chat_palavras_chave, fornecedor,
//                                  licitacoes, chat_captura_progresso).
//   - opts.getConfigValue(k)      fallback para fornecedor_cnpj quando
//                                  fornecedor.id=1 não existe.
//   - opts.enviarNotificacaoTelegram(payload) -> Promise
//                                  dispara notificação assíncrona.
//   - opts.getMonitor() -> monitor|null
//                                  retorna a instância atual de
//                                  MonitorMensagensComprasnet (lifecycle
//                                  permanece em server.js). USE um getter
//                                  em vez de passar a ref direta porque
//                                  monitorMensagens é reatribuído em
//                                  runtime — capturar por valor no boot
//                                  daria stale reference.

const crypto = require('crypto');

// Estado interno (reset em restart do worker — 1:1 do monolito)
const extensaoDebugLogs = [];
const navegacaoLogs = [];

function registrarRotasExtensaoChrome(app, db, opts) {
  const { getConfigValue, enviarNotificacaoTelegram, getMonitor } = opts || {};
  if (!getConfigValue) {
    throw new Error('extensao-chrome-routes: getConfigValue é obrigatório');
  }
  if (!enviarNotificacaoTelegram) {
    throw new Error('extensao-chrome-routes: enviarNotificacaoTelegram é obrigatório');
  }
  if (!getMonitor) {
    throw new Error('extensao-chrome-routes: getMonitor é obrigatório');
  }

  // Status do servidor (para extensão verificar se está online)
  app.get('/api/chat/status', (req, res) => {
    res.json({
      success: true,
      online: true,
      timestamp: new Date().toISOString()
    });
  });

  // Keep-alive da extensão (mantém sessão ativa)
  app.post('/api/chat/keep-alive', (req, res) => {
    res.json({
      success: true,
      timestamp: new Date().toISOString()
    });
  });

  // Receber mensagens da extensão Chrome
  app.post('/api/chat/mensagens/extensao', (req, res) => {
    try {
      const { licitacao, mensagens, url, timestamp } = req.body;

      // Debug: mostrar estrutura completa do que está chegando
      console.log('[Extensão Debug] ===== DADOS RECEBIDOS =====');
      console.log('[Extensão Debug] Licitação:', JSON.stringify(licitacao));
      console.log('[Extensão Debug] URL:', url);
      console.log('[Extensão Debug] Total mensagens:', mensagens?.length);
      if (mensagens && mensagens.length > 0) {
        console.log('[Extensão Debug] Primeira mensagem (campos):', Object.keys(mensagens[0]));
        console.log('[Extensão Debug] Primeira mensagem (dados):', JSON.stringify(mensagens[0]).substring(0, 200));
      }
      console.log('[Extensão Debug] ===========================');

      if (!licitacao || !mensagens || mensagens.length === 0) {
        return res.status(400).json({ success: false, error: 'Dados inválidos' });
      }

      const { cnpjOrgao, sequencial, ano, compraId } = licitacao;
      console.log(`[Extensão Debug] compraId=${compraId} cnpj=${cnpjOrgao} seq=${sequencial} ano=${ano}`);
      let inseridas = 0;
      let duplicadas = 0;

      // Palavras-chave para alerta (apenas do banco - configuradas pelo usuário)
      let palavrasChave = [];
      try {
        const palavrasDB = db.prepare('SELECT palavra FROM chat_palavras_chave WHERE ativo = 1').all();
        palavrasChave = palavrasDB.map(p => p.palavra.toLowerCase());
      } catch (e) {
        console.log('[Extensão] Erro ao buscar palavras-chave:', e.message);
      }

      // CNPJ do fornecedor configurado (busca na tabela fornecedor)
      let cnpjFornecedor = '';
      try {
        const fornecedorConfig = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
        cnpjFornecedor = fornecedorConfig?.cnpj || '';
      } catch (e) {
        cnpjFornecedor = getConfigValue('fornecedor_cnpj') || '';
      }

      // Buscar informações do órgão e licitação no banco
      let infoLicitacao = null;
      try {
        // Tenta buscar pelo cnpjOrgao (UASG) + ano + sequencial
        infoLicitacao = db.prepare(`
          SELECT razaoSocial, objetoCompra, cnpj
          FROM licitacoes
          WHERE (cnpj LIKE ? OR cnpj LIKE ?)
          AND anoCompra = ?
          AND sequencialCompra = ?
          LIMIT 1
        `).get(`${cnpjOrgao}%`, `%${cnpjOrgao}%`, parseInt(ano), parseInt(sequencial));

        // Se não encontrou, tenta buscar só pelo sequencial e ano
        if (!infoLicitacao) {
          infoLicitacao = db.prepare(`
            SELECT razaoSocial, objetoCompra, cnpj
            FROM licitacoes
            WHERE anoCompra = ? AND sequencialCompra = ?
            LIMIT 1
          `).get(parseInt(ano), parseInt(sequencial));
        }
      } catch (e) {
        console.log('[Extensão] Erro ao buscar info licitação:', e.message);
      }

      // Adicionar coluna origemCaptura se não existir
      try {
        db.exec(`ALTER TABLE chat_mensagens ADD COLUMN origemCaptura TEXT DEFAULT 'servidor'`);
      } catch (e) {
        // Coluna já existe
      }

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO chat_mensagens (
          cnpjOrgao, ano, sequencial, remetente, mensagem, dataHoraMensagem, dataCaptura,
          temCnpjFornecedor, palavrasChaveEncontradas, notificado, origemCaptura, hashMensagem
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'extensao', ?)
      `);

      for (const msg of mensagens) {
        // Aceitar tanto 'texto' quanto 'mensagem' ou 'conteudo' como campo de texto
        const texto = msg.texto || msg.mensagem || msg.conteudo || msg.message || '';
        const textoLower = texto.toLowerCase();

        // Log para debug - ver o que está chegando
        console.log(`[Extensão Debug] Msg recebida: remetente="${msg.remetente}", texto="${texto.substring(0, 50)}...", tamanho=${texto.length}`);

        // Ignorar mensagens de erro do sistema
        if (textoLower.includes('captcha') ||
            textoLower.includes('não há mensagens') ||
            textoLower.includes('tente mais tarde') ||
            texto.length < 10) {
          console.log(`[Extensão Debug] Mensagem FILTRADA: ${texto.length < 10 ? 'muito curta' : 'palavra bloqueada'}`);
          continue;
        }

        // Verificar se menciona o CNPJ do fornecedor
        const temCnpj = cnpjFornecedor && texto.includes(cnpjFornecedor) ? 1 : 0;

        // Verificar palavras-chave
        const palavrasEncontradas = palavrasChave.filter(p => textoLower.includes(p));
        const palavrasStr = palavrasEncontradas.length > 0 ? palavrasEncontradas.join(',') : null;

        try {
          // Gerar hash único para a mensagem (inclui remetente para melhor dedup)
          const hashMensagem = crypto.createHash('md5')
            .update(`${cnpjOrgao}-${ano}-${sequencial}-${(msg.remetente || '')}-${texto.substring(0, 100)}`)
            .digest('hex');

          const result = insertStmt.run(
            cnpjOrgao,
            parseInt(ano) || new Date().getFullYear(),
            parseInt(sequencial) || 0,
            msg.remetente || 'Sistema',
            texto,
            msg.dataHora || new Date().toISOString(),
            new Date().toISOString(),
            temCnpj,
            palavrasStr,
            hashMensagem
          );

          if (result.changes > 0) {
            inseridas++;
            const lastId = result.lastInsertRowid;

            // Enviar notificação Telegram para TODAS as mensagens novas
            // Destaque especial se contém CNPJ do fornecedor ou palavras-chave
            const ehImportante = temCnpj || palavrasEncontradas.length > 0;
            console.log(`[Telegram] Enviando alerta: Lic ${sequencial}/${ano} - Importante:${ehImportante}`);

            enviarNotificacaoTelegram({
              cnpjOrgao: cnpjOrgao,
              nomeOrgao: infoLicitacao?.razaoSocial || null,
              sequencial: sequencial,
              ano: ano,
              objetoLicitacao: infoLicitacao?.objetoCompra || null,
              remetente: msg.remetente || 'Sistema',
              mensagem: texto,
              dataHoraMensagem: msg.dataHora || new Date().toISOString(),
              temCnpjFornecedor: temCnpj === 1,
              palavrasChave: palavrasEncontradas,
              ehImportante: ehImportante
            }).then(() => {
              // Marcar como notificado
              db.prepare('UPDATE chat_mensagens SET notificado = 1 WHERE id = ?').run(lastId);
              console.log(`[Telegram] Alerta enviado e marcado: ID ${lastId}`);
            }).catch(err => {
              console.log('[Telegram] Erro ao enviar notificação:', err.message);
            });
          } else {
            duplicadas++;
          }
        } catch (e) {
          duplicadas++;
        }
      }

      console.log(`[Extensão Chrome] Recebidas ${mensagens.length} mensagens, ${inseridas} novas, ${duplicadas} duplicadas`);

      res.json({
        success: true,
        message: `${inseridas} mensagem(ns) salva(s)`,
        inseridas,
        duplicadas,
        total: mensagens.length
      });
    } catch (error) {
      console.error('[Extensão Chrome] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Consultar progresso de captura de uma licitação
  app.get('/api/chat/progresso/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;

      const progresso = db.prepare(`
        SELECT * FROM chat_captura_progresso WHERE compraId = ?
      `).get(compraId);

      if (progresso) {
        res.json({
          success: true,
          progresso: {
            compraId: progresso.compraId,
            ultimaPagina: progresso.ultimaPaginaCapturada,
            totalPaginas: progresso.totalPaginasEncontradas,
            totalMensagens: progresso.totalMensagensCapturadas,
            capturaCompleta: progresso.capturaCompleta === 1,
            ultimaCaptura: progresso.ultimaCaptura
          }
        });
      } else {
        res.json({
          success: true,
          progresso: null,
          message: 'Nenhuma captura anterior encontrada'
        });
      }
    } catch (error) {
      console.error('[Progresso] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Atualizar progresso de captura de uma licitação
  app.post('/api/chat/progresso', (req, res) => {
    try {
      const {
        compraId,
        cnpjOrgao,
        ano,
        sequencial,
        ultimaPagina,
        totalPaginas,
        totalMensagens,
        capturaCompleta
      } = req.body;

      if (!compraId) {
        return res.status(400).json({ success: false, error: 'compraId é obrigatório' });
      }

      // Upsert - atualiza se existe, insere se não existe
      db.prepare(`
        INSERT INTO chat_captura_progresso (compraId, cnpjOrgao, ano, sequencial, ultimaPaginaCapturada, totalPaginasEncontradas, totalMensagensCapturadas, capturaCompleta, ultimaCaptura, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(compraId) DO UPDATE SET
          ultimaPaginaCapturada = excluded.ultimaPaginaCapturada,
          totalPaginasEncontradas = excluded.totalPaginasEncontradas,
          totalMensagensCapturadas = excluded.totalMensagensCapturadas,
          capturaCompleta = excluded.capturaCompleta,
          ultimaCaptura = CURRENT_TIMESTAMP,
          dataAtualizacao = CURRENT_TIMESTAMP
      `).run(
        compraId,
        cnpjOrgao || null,
        ano || null,
        sequencial || null,
        ultimaPagina || 0,
        totalPaginas || 0,
        totalMensagens || 0,
        capturaCompleta ? 1 : 0
      );

      console.log(`[Progresso] Atualizado: ${compraId} - página ${ultimaPagina}/${totalPaginas}, ${totalMensagens} msgs, completa: ${capturaCompleta}`);

      res.json({
        success: true,
        message: 'Progresso atualizado'
      });
    } catch (error) {
      console.error('[Progresso] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Listar progresso de todas as licitações
  app.get('/api/chat/progresso', (req, res) => {
    try {
      const progressos = db.prepare(`
        SELECT * FROM chat_captura_progresso
        ORDER BY dataAtualizacao DESC
        LIMIT 100
      `).all();

      res.json({
        success: true,
        total: progressos.length,
        progressos: progressos.map(p => ({
          compraId: p.compraId,
          cnpjOrgao: p.cnpjOrgao,
          ano: p.ano,
          sequencial: p.sequencial,
          ultimaPagina: p.ultimaPaginaCapturada,
          totalPaginas: p.totalPaginasEncontradas,
          totalMensagens: p.totalMensagensCapturadas,
          capturaCompleta: p.capturaCompleta === 1,
          ultimaCaptura: p.ultimaCaptura
        }))
      });
    } catch (error) {
      console.error('[Progresso] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Reset de progresso - para recapturar licitações
  app.delete('/api/chat/progresso/reset-all', (req, res) => {
    try {
      const result = db.prepare(`DELETE FROM chat_captura_progresso`).run();
      console.log(`[Progresso] Reset total: ${result.changes} registros removidos`);
      res.json({
        success: true,
        message: `Progresso resetado. ${result.changes} licitações podem ser recapturadas.`
      });
    } catch (error) {
      console.error('[Progresso] Erro ao resetar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Reset de progresso de uma licitação específica
  app.delete('/api/chat/progresso/:compraId', (req, res) => {
    try {
      const { compraId } = req.params;
      const result = db.prepare(`DELETE FROM chat_captura_progresso WHERE compraId = ?`).run(compraId);

      if (result.changes > 0) {
        console.log(`[Progresso] Reset: ${compraId}`);
        res.json({ success: true, message: `Progresso da licitação ${compraId} resetado.` });
      } else {
        res.json({ success: false, message: 'Licitação não encontrada no progresso.' });
      }
    } catch (error) {
      console.error('[Progresso] Erro ao resetar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== ROTAS DO MONITOR DE MENSAGENS ====================

  // Status do monitor de mensagens
  app.get('/api/chat/monitor-status', (req, res) => {
    try {
      const monitor = getMonitor();
      if (monitor) {
        res.json({ success: true, ...monitor.getStatus() });
      } else {
        res.json({ success: true, ativo: false, logs: [], ultimaVerificacao: null, totalMensagensNovas: 0 });
      }
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Receber logs de debug da extensão Chrome
  app.post('/api/chat/debug-logs', (req, res) => {
    try {
      const { logs, url, timestamp } = req.body;

      // Adiciona os logs ao array com timestamp do servidor
      const logEntry = {
        timestamp: new Date().toISOString(),
        url: url,
        logs: logs || []
      };

      extensaoDebugLogs.push(logEntry);

      // Mantém apenas os últimos 100 registros
      while (extensaoDebugLogs.length > 100) {
        extensaoDebugLogs.shift();
      }

      // Mostra no console do servidor
      console.log('\n[Extensão Debug]', timestamp);
      console.log('URL:', url);
      logs.forEach(l => console.log('  ', l));

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Consultar logs de debug da extensão
  app.get('/api/chat/debug-logs', (req, res) => {
    res.json({ success: true, logs: extensaoDebugLogs });
  });

  // Receber dados de navegação da extensão
  app.post('/api/chat/navegacao', (req, res) => {
    try {
      const dados = req.body;
      navegacaoLogs.push(dados);

      // Mantém apenas os últimos 500 registros
      while (navegacaoLogs.length > 500) {
        navegacaoLogs.shift();
      }

      // Mostra no console
      const emoji = dados.tipo === 'navegacao' ? '🌐' : dados.tipo === 'clique' ? '👆' : '📦';
      console.log(`${emoji} [${dados.tipo}] ${dados.url?.substring(0, 60) || ''}`);
      if (dados.texto) console.log(`   Texto: ${dados.texto}`);
      if (dados.href) console.log(`   Href: ${dados.href}`);

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Consultar dados de navegação
  app.get('/api/chat/navegacao', (req, res) => {
    res.json({ success: true, logs: navegacaoLogs });
  });

  console.log('[ExtensaoChrome] Rotas registradas');
}

module.exports = { registrarRotasExtensaoChrome };
