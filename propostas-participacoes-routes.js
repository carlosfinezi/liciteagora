// propostas-participacoes-routes.js
//
// Fluxo de envio de propostas via extensão Chrome: v1 /api/proposta/enviar
// (a partir do fluxo antigo PNCP → interesse) e v2 via participações
// (participacoes_comprasnet → proposta direta).
//
// Extraído de server.js em NFSE-M06 onda 6.2. Mantém propostasPendentes e
// statusEnvioProposta como estado privado do módulo (closure vars do factory),
// substituindo as duas `let` de topo de server.js.
//
// Chamadas de Telegram passam a usar sendTelegram(db, msg) direto do
// módulo telegram-client.js, ao invés do wrapper enviarTelegram(msg) que
// só existe dentro de server.js.

const axios = require('axios');
const { sendTelegram } = require('./telegram-client');

function registrarRotasPropostasParticipacoes(app, db) {
  // Fila de propostas pendentes para a extensão Chrome processar
  let propostasPendentes = [];

  // Status do envio de proposta (para acompanhar execução)
  let statusEnvioProposta = { ativo: false, etapa: '', progresso: 0, mensagens: [] };

  /**
   * Endpoint para enviar proposta via Extensão Chrome
   * A extensão já está logada no Comprasnet e pode executar o envio diretamente
   */
  app.post('/api/proposta/enviar', async (req, res) => {
    try {
      const { cnpj, ano, sequencial, itens } = req.body;

      if (!cnpj || !ano || !sequencial || !itens || !Array.isArray(itens)) {
        return res.status(400).json({ success: false, error: 'Dados incompletos' });
      }

      // Buscar link da licitação
      const licitacao = db.prepare(`
        SELECT linkSistemaOrigem, modalidadeNome, objetoCompra, codigoUnidade, numeroCompra, modalidadeId
        FROM licitacoes
        WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?
      `).get(cnpj, parseInt(ano), parseInt(sequencial));

      if (!licitacao) {
        return res.status(400).json({ success: false, error: 'Licitação não encontrada no banco de dados' });
      }

      // Se não tem link do sistema, tentar construir baseado nos dados
      let linkSistema = licitacao.linkSistemaOrigem;
      if (!linkSistema) {
        // Construir link do Compras.gov.br se tem UASG
        // Formato compraId: UASG (6) + ModalidadeComprasnet (2) + NumeroCompra (5) + Ano (4) = 17 dígitos
        //
        // Mapeamento PNCP modalidadeId → Comprasnet código:
        // PNCP 6 (Pregão - Eletrônico) = Comprasnet 06
        // PNCP 7 (Pregão - Presencial) = Comprasnet 05
        // PNCP 8 (Dispensa) = Comprasnet 08
        // PNCP 9 (Inexigibilidade) = Comprasnet 09
        // PNCP 1 (Leilão) = Comprasnet 01
        // PNCP 2 (Diálogo Competitivo) = Comprasnet 02
        // PNCP 3 (Concurso) = Comprasnet 03
        // PNCP 4 (Concorrência) = Comprasnet 04
        // Mapeamento PNCP modalidadeId -> Comprasnet código
        // Baseado em análise dos linkSistemaOrigem reais
        const mapModalidadeComprasnet = {
          1: '01', // Leilão
          2: '02', // Diálogo Competitivo
          3: '03', // Concurso
          4: '04', // Concorrência
          5: '05', // Pregão Presencial
          6: '05', // Pregão Eletrônico (código 05 no Comprasnet, confirmado pelo linkSistemaOrigem)
          7: '05', // Pregão Presencial
          8: '06', // Dispensa Eletrônica (código 06 no Comprasnet, confirmado pelo usuário)
          9: '09', // Inexigibilidade
        };

        if (licitacao.codigoUnidade) {
          const uasg = String(licitacao.codigoUnidade).padStart(6, '0');
          // Usar o mapeamento ou fallback para '05' (Pregão Eletrônico)
          const modalidadeComprasnet = mapModalidadeComprasnet[licitacao.modalidadeId] || '05';
          const numeroCompra = String(licitacao.numeroCompra || '1').padStart(5, '0');
          const compraIdConstruido = `${uasg}${modalidadeComprasnet}${numeroCompra}${ano}`;
          linkSistema = `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=${compraIdConstruido}`;
          console.log(`[PROPOSTA] Link construído: ${linkSistema} (UASG=${uasg}, ModalidadePNCP=${licitacao.modalidadeId}, ModalidadeComprasnet=${modalidadeComprasnet}, Num=${numeroCompra})`);
        } else {
          return res.status(400).json({
            success: false,
            error: 'Esta licitação não possui link para sistema externo. Acesse diretamente no PNCP para enviar proposta.',
            linkPncp: `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${String(sequencial).padStart(6, '0')}`,
            modalidade: licitacao.modalidadeNome
          });
        }
      }

      // Verificar se é Comprasnet (incluindo cnetmobile.estaleiro.serpro.gov.br)
      if (!linkSistema.includes('compras.gov') &&
          !linkSistema.includes('comprasnet') &&
          !linkSistema.includes('serpro.gov.br')) {
        return res.status(400).json({
          success: false,
          error: 'Envio automático só disponível para licitações do Comprasnet',
          link: linkSistema
        });
      }

      // Extrair compraId do link
      const matchCompra = linkSistema.match(/compra=(\d+)/);
      if (!matchCompra) {
        return res.status(400).json({
          success: false,
          error: 'Não foi possível extrair o ID da compra do link',
          link: linkSistema
        });
      }
      const compraId = matchCompra[1];

      // Extrair UASG e número do compraId
      // Formato: UASG (6 dígitos) + Sequencial (5 dígitos) + Ano (4 dígitos) = 15 dígitos
      const uasg = compraId.substring(0, 6);
      const numeroCompra = compraId.substring(6, 11);

      // Adicionar proposta na fila para a extensão processar
      propostasPendentes.push({
        compraId,
        uasg,
        numeroCompra,
        itens: itens.map(item => ({
          numero: item.numeroItem,
          valor: item.valorUnitario
        })),
        linkSistema,
        cnpj,
        ano,
        sequencial,
        timestamp: new Date().toISOString()
      });

      // Atualiza status
      statusEnvioProposta = {
        ativo: true,
        etapa: 'Aguardando extensão Chrome processar',
        progresso: 10,
        mensagens: [`Proposta adicionada na fila para compra ${compraId}`, 'A extensão Chrome irá processar automaticamente quando você estiver logado no Comprasnet.']
      };

      console.log(`[PROPOSTA] Adicionada na fila: compraId=${compraId}, uasg=${uasg}`);

      res.json({
        success: true,
        message: 'Proposta adicionada na fila. Abra o Comprasnet e a extensão irá processar automaticamente.',
        compraId,
        uasg,
        linkCadastroProposta: `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/cadastro-propostas?compra=${compraId}`,
        instrucoes: [
          '1. Certifique-se de estar logado no Comprasnet',
          '2. A extensão Chrome irá detectar a proposta pendente',
          '3. Acompanhe o status na página da licitação'
        ]
      });

    } catch (error) {
      console.error('Erro ao enviar proposta:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== PROPOSTAS VIA PARTICIPAÇÕES (v2) ====================

  /**
   * Lista participações em andamento disponíveis para envio de proposta
   * Substitui o fluxo antigo: PNCP → interesse → propostas
   * Agora: participacoes_comprasnet (extensão) → proposta direta via API
   */
  app.get('/api/proposta/participacoes', (req, res) => {
    try {
      const { busca, situacao } = req.query;

      let sql = `
        SELECT compraId, cnpj, codigoUnidade, ano, sequencial, tipo, numero, orgao,
               objeto, etapa, situacao, urlCompra, dataSessao, ativo, dataAtualizacao
        FROM participacoes_comprasnet
        WHERE ativo = 1
      `;
      const params = [];

      if (situacao === 'ativas') {
        sql += ` AND (situacao IN ('PD', 'AB', '5') OR etapa LIKE '%andamento%' OR etapa LIKE '%aberta%')`;
      } else if (situacao === 'encerradas') {
        sql += ` AND (situacao IN ('FR', 'EN', '2') OR etapa LIKE '%encerrad%' OR etapa LIKE '%fracass%')`;
      } else if (situacao) {
        sql += ` AND situacao = ?`;
        params.push(situacao);
      }

      if (busca) {
        sql += ` AND (objeto LIKE ? OR orgao LIKE ? OR compraId LIKE ? OR numero LIKE ?)`;
        const termo = `%${busca}%`;
        params.push(termo, termo, termo, termo);
      }

      sql += ` ORDER BY dataSessao DESC, dataAtualizacao DESC`;

      const participacoes = db.prepare(sql).all(...params);

      // Agrupar por situação para o frontend
      const stats = {
        total: participacoes.length,
        emAndamento: participacoes.filter(p => ['PD','AB','5'].includes((p.situacao||'').toUpperCase()) || (p.etapa||'').toLowerCase().includes('andamento')).length,
        encerradas: participacoes.filter(p => ['FR','EN','2'].includes((p.situacao||'').toUpperCase()) || (p.etapa||'').toLowerCase().includes('encerrad')).length
      };

      res.json({ success: true, data: participacoes, stats });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Listar licitações de interesse agrupadas, com itens incluídos.
   * Tenta extrair compraId do linkSistemaOrigem quando disponível.
   */
  app.get('/api/proposta/interesses', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT
          i.id as interesseId,
          i.cnpj, i.ano, i.sequencial, i.numeroItem,
          i.grupoId,
          g.nome as grupoNome,
          l.objetoCompra, l.razaoSocial as nomeOrgao,
          l.codigoUnidade, l.modalidadeId, l.modalidadeNome,
          l.numeroCompra, l.linkSistemaOrigem,
          l.dataEncerramentoProposta, l.valorTotalEstimado,
          it.descricao, it.quantidade, it.unidadeMedida,
          it.valorUnitarioEstimado, it.valorTotal
        FROM interesse i
        LEFT JOIN grupos_palavras g ON g.id = i.grupoId
        LEFT JOIN licitacoes l ON i.cnpj = l.cnpj
          AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra
        LEFT JOIN itens it ON l.id = it.licitacaoId AND i.numeroItem = it.numeroItem
        WHERE l.dataEncerramentoProposta IS NULL
          OR l.dataEncerramentoProposta = ''
          OR l.dataEncerramentoProposta > datetime('now', '-3 hours')
        ORDER BY i.dataCriacao DESC
      `).all();

      // Agrupar por licitação
      const licitacoesMap = new Map();
      rows.forEach(row => {
        const key = `${row.cnpj}-${row.ano}-${row.sequencial}`;
        if (!licitacoesMap.has(key)) {
          // Tentar extrair compraId do linkSistemaOrigem
          let compraId = null;
          if (row.linkSistemaOrigem) {
            const m = row.linkSistemaOrigem.match(/[?&]compra=(\d{14,20})/);
            if (m) compraId = m[1];
          }
          // Verificar se existe compraId salvo manualmente
          if (!compraId) {
            const manual = db.prepare(
              `SELECT compraId FROM interesse_compra_id WHERE cnpj = ? AND ano = ? AND sequencial = ? LIMIT 1`
            ).get(row.cnpj, row.ano, row.sequencial);
            if (manual) compraId = manual.compraId;
          }
          // Verificar se existe participação correspondente
          if (!compraId) {
            const part = db.prepare(
              `SELECT compraId FROM participacoes_comprasnet WHERE cnpj = ? AND ano = ? AND sequencial = ? LIMIT 1`
            ).get(row.cnpj?.substring(0, 8), row.ano, row.sequencial);
            if (part) compraId = part.compraId;
          }
          licitacoesMap.set(key, {
            cnpj: row.cnpj,
            ano: row.ano,
            sequencial: row.sequencial,
            objetoCompra: row.objetoCompra || 'Objeto não disponível',
            nomeOrgao: row.nomeOrgao || '',
            codigoUnidade: row.codigoUnidade || '',
            modalidadeNome: row.modalidadeNome || '',
            numeroCompra: row.numeroCompra || '',
            linkSistemaOrigem: row.linkSistemaOrigem || '',
            dataEncerramentoProposta: row.dataEncerramentoProposta || '',
            valorTotalEstimado: row.valorTotalEstimado || 0,
            compraId,
            grupoNome: row.grupoNome || '',
            itens: []
          });
        }
        if (row.numeroItem) {
          licitacoesMap.get(key).itens.push({
            numero: row.numeroItem,
            descricao: row.descricao || `Item ${row.numeroItem}`,
            quantidade: row.quantidade || 1,
            unidadeMedida: row.unidadeMedida || 'UN',
            valorEstimado: row.valorUnitarioEstimado || null,
            valorTotal: row.valorTotal || null
          });
        }
      });

      const data = Array.from(licitacoesMap.values());
      res.json({ success: true, data, total: data.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Salvar compraId manual para uma licitação de interesse.
   */
  app.post('/api/proposta/interesses/compra-id', (req, res) => {
    try {
      const { cnpj, ano, sequencial, compraId } = req.body;
      if (!cnpj || !ano || !sequencial || !compraId) {
        return res.status(400).json({ success: false, error: 'cnpj, ano, sequencial e compraId são obrigatórios' });
      }
      if (!/^\d{14,20}$/.test(compraId)) {
        return res.status(400).json({ success: false, error: 'compraId deve ter 14-20 dígitos numéricos' });
      }
      db.prepare(`
        INSERT INTO interesse_compra_id (cnpj, ano, sequencial, compraId)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(cnpj, ano, sequencial) DO UPDATE SET compraId = excluded.compraId, verificado = 0
      `).run(cnpj, ano, sequencial, compraId);
      res.json({ success: true, compraId });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Marcar compraId como verificado (após carregar itens com sucesso).
   */
  app.put('/api/proposta/interesses/compra-id/verificar', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.body;
      db.prepare(`UPDATE interesse_compra_id SET verificado = 1 WHERE cnpj = ? AND ano = ? AND sequencial = ?`)
        .run(cnpj, ano, sequencial);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * POST /api/proposta/interesses/auto-compra-id
   * Resolve automaticamente o compraId para interesses que não o têm.
   * Estratégia: construir a chaveCompraPncp esperada e buscar no banco de participações.
   * chaveCompraPncp = {cnpjPncp14}{seqPncp padded 6}{ano4}
   */
  app.post('/api/proposta/interesses/auto-compra-id', async (req, res) => {
    try {
      const iRows = db.prepare(`
        SELECT DISTINCT i.cnpj, i.ano, i.sequencial
        FROM interesse i
        LEFT JOIN interesse_compra_id ic ON i.cnpj = ic.cnpj AND i.ano = ic.ano AND i.sequencial = ic.sequencial
        WHERE ic.compraId IS NULL
      `).all();

      // Também incluir os que têm linkSistemaOrigem com compra=
      const licitacoes = db.prepare(`
        SELECT l.cnpj, l.anoCompra, l.sequencialCompra, l.linkSistemaOrigem
        FROM licitacoes l
        INNER JOIN interesse i ON l.cnpj = i.cnpj AND l.anoCompra = i.ano AND l.sequencialCompra = i.sequencial
        WHERE l.linkSistemaOrigem LIKE '%compra=%'
      `).all();

      const resolvidos = [];

      // Método 1: Extrair compraId do linkSistemaOrigem
      for (const lic of licitacoes) {
        const m = lic.linkSistemaOrigem.match(/[?&]compra=(\d{14,20})/);
        if (m) {
          const compraId = m[1];
          try {
            db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
              .run(lic.cnpj, lic.anoCompra, lic.sequencialCompra, compraId);
            resolvidos.push({ cnpj: lic.cnpj, ano: lic.anoCompra, seq: lic.sequencialCompra, compraId, metodo: 'link' });
          } catch (e) {}
        }
      }

      // Método 2: Construir chaveCompraPncp esperada e buscar nas participações
      // Formato da chave: {cnpjPncp14}{1}{seqPncp padded 6}{ano4} = 25 chars
      for (const row of iRows) {
        const jaResolvido = resolvidos.find(r => r.cnpj === row.cnpj && r.ano === row.ano && r.seq === row.sequencial);
        if (jaResolvido) continue;

        const seqPadded = String(row.sequencial).padStart(6, '0');
        const chaveEsperada = `${row.cnpj}1${seqPadded}${row.ano}`;

        const part = db.prepare(`SELECT compraId FROM participacoes_comprasnet WHERE chaveCompraPncp = ?`).get(chaveEsperada);
        if (part) {
          try {
            db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
              .run(row.cnpj, row.ano, row.sequencial, part.compraId);
            resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId: part.compraId, metodo: 'chave' });
          } catch (e) {}
        }
      }

      // Método 3: Buscar por LIKE no início da chaveCompraPncp (cnpj match)
      for (const row of iRows) {
        const jaResolvido = resolvidos.find(r => r.cnpj === row.cnpj && r.ano === row.ano && r.seq === row.sequencial);
        if (jaResolvido) continue;

        const part = db.prepare(`SELECT compraId, chaveCompraPncp FROM participacoes_comprasnet WHERE chaveCompraPncp LIKE ? AND ano = ?`)
          .get(`${row.cnpj}%`, row.ano);
        if (part) {
          // Extrair sequencial PNCP da chave (pos 15..21 = depois do cnpj14 + "1")
          const seqFromChave = parseInt(part.chaveCompraPncp.substring(15, 21), 10);
          if (seqFromChave === row.sequencial) {
            try {
              db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
                .run(row.cnpj, row.ano, row.sequencial, part.compraId);
              resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId: part.compraId, metodo: 'cnpj-match' });
            } catch (e) {}
          }
        }
      }

      // Método 4: Consultar API PNCP diretamente para pendentes restantes
      const aindaPendentes = iRows.filter(r => !resolvidos.find(x => x.cnpj === r.cnpj && x.ano === r.ano && x.seq === r.sequencial));
      const naoComprasnet = [];
      for (const row of aindaPendentes) {
        try {
          const url = `https://pncp.gov.br/api/consulta/v1/orgaos/${row.cnpj}/compras/${row.ano}/${row.sequencial}`;
          const resp = await axios.get(url, { timeout: 8000, validateStatus: () => true });
          if (resp.status === 200 && resp.data) {
            const link = resp.data.linkSistemaOrigem || '';
            // Extrair compraId do link do Comprasnet
            const m = link.match(/[?&]compra=(\d{14,20})/);
            if (m) {
              const compraId = m[1];
              db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
                .run(row.cnpj, row.ano, row.sequencial, compraId);
              resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId, metodo: 'pncp-api' });
            } else {
              // Link não contém compra= — tentar construir compraId via UASG+modalidade+numero
              const licLocal = db.prepare(
                `SELECT codigoUnidade, modalidadeId, numeroCompra FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?`
              ).get(row.cnpj, row.ano, row.sequencial);

              if (licLocal && licLocal.codigoUnidade && licLocal.numeroCompra) {
                const mapMod = { 1:'01', 2:'02', 3:'03', 4:'04', 5:'05', 6:'05', 7:'05', 8:'06', 9:'09' };
                const uasg = String(licLocal.codigoUnidade).padStart(6, '0');
                const modComprasnet = mapMod[licLocal.modalidadeId] || '05';
                const numCompra = String(licLocal.numeroCompra).padStart(5, '0');
                const compraIdConstruido = `${uasg}${modComprasnet}${numCompra}${row.ano}`;
                db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 0)`)
                  .run(row.cnpj, row.ano, row.sequencial, compraIdConstruido);
                resolvidos.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, compraId: compraIdConstruido, metodo: 'construido-uasg' });
                console.log(`[AUTO-COMPRA-ID] Construído via UASG: ${compraIdConstruido} (UASG=${uasg}, mod=${modComprasnet}, num=${numCompra})`);
              } else {
                // Realmente não é do Comprasnet (sistema estadual/municipal)
                const sistema = link ? new URL(link).hostname : 'desconhecido';
                db.prepare(`INSERT OR IGNORE INTO interesse_compra_id (cnpj, ano, sequencial, compraId, verificado) VALUES (?, ?, ?, ?, 1)`)
                  .run(row.cnpj, row.ano, row.sequencial, `NAO_COMPRASNET:${sistema}`);
                naoComprasnet.push({ cnpj: row.cnpj, ano: row.ano, seq: row.sequencial, sistema });
              }
            }
          }
          // Delay entre chamadas PNCP
          await new Promise(r => setTimeout(r, 500));
        } catch (e) {
          console.log(`[AUTO-COMPRA-ID] Erro PNCP ${row.cnpj}/${row.ano}/${row.sequencial}: ${e.message}`);
        }
      }

      console.log(`[AUTO-COMPRA-ID] ${resolvidos.length} resolvidos, ${naoComprasnet.length} não-Comprasnet, de ${iRows.length} pendentes`);
      res.json({ success: true, resolvidos, naoComprasnet, pendentes: iRows.length - resolvidos.length - naoComprasnet.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  /**
   * Enviar proposta diretamente por compraId (sem passar pelo fluxo PNCP/interesse)
   * Recebe compraId + array de itens [{numero, valor, marca?, modelo?}]
   * Adiciona na fila para a extensão processar via API REST
   */
  app.post('/api/proposta/enviar-direto', (req, res) => {
    try {
      const { compraId, itens, declaracoes } = req.body;

      if (!compraId) {
        return res.status(400).json({ success: false, error: 'compraId obrigatório' });
      }
      if (!itens || !Array.isArray(itens) || itens.length === 0) {
        return res.status(400).json({ success: false, error: 'Array de itens obrigatório' });
      }

      // Validar itens
      for (const item of itens) {
        if (!item.numero || !item.valor || item.valor <= 0) {
          return res.status(400).json({
            success: false,
            error: `Item inválido: numero=${item.numero}, valor=${item.valor}`
          });
        }
      }

      // Verificar se já não está na fila
      if (propostasPendentes.some(p => p.compraId === compraId)) {
        return res.json({ success: true, message: 'Proposta já está na fila', jaExiste: true });
      }

      // Buscar dados da participação para enriquecer
      const participacao = db.prepare('SELECT * FROM participacoes_comprasnet WHERE compraId = ?').get(compraId);

      const uasg = compraId.substring(0, 6);
      const proposta = {
        compraId,
        uasg,
        itens: itens.map(item => ({
          numero: parseInt(item.numero),
          valor: parseFloat(item.valor),
          marcaFabricante: item.marca || item.marcaFabricante || null,
          modeloVersao: item.modelo || item.modeloVersao || null,
          quantidade: item.quantidade || null
        })),
        declaracoes: declaracoes || {},
        orgao: participacao?.orgao || '',
        objeto: participacao?.objeto || '',
        timestamp: new Date().toISOString()
      };

      propostasPendentes.push(proposta);

      console.log(`[PROPOSTA-DIRETO] Adicionada na fila: compraId=${compraId}, ${itens.length} itens`);

      // Atualiza status
      statusEnvioProposta = {
        ativo: true,
        etapa: 'Aguardando extensão processar',
        progresso: 10,
        mensagens: [`Proposta para compra ${compraId} adicionada na fila (${itens.length} itens)`]
      };

      res.json({
        success: true,
        message: `Proposta adicionada: ${itens.length} itens para compra ${compraId}`,
        compraId,
        itensCount: itens.length
      });
    } catch (error) {
      console.error('[PROPOSTA-DIRETO] Erro:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint para a extensão verificar propostas pendentes (ANTES do status)
  app.get('/api/proposta/fila', (req, res) => {
    console.log('[PROPOSTA] GET /api/proposta/fila chamado');
    if (propostasPendentes.length > 0) {
      const proposta = propostasPendentes[0];
      res.json({ success: true, hasPendente: true, data: proposta });
    } else {
      res.json({ success: true, hasPendente: false });
    }
  });

  app.get('/api/proposta/status', (req, res) => {
    res.json({ success: true, data: statusEnvioProposta });
  });

  // Endpoint para a extensão reportar resultado do envio
  app.post('/api/proposta/resultado', async (req, res) => {
    try {
      const { success, compraId, error, uasg, numeroCompra, itens, timestamp, itensSalvos, itensComErro } = req.body;

      console.log(`[PROPOSTA] Resultado recebido: success=${success}, compraId=${compraId}, itensSalvos=${itensSalvos}`);

      // Obtém os dados da proposta antes de remover da fila (para atualizar o kanban)
      const propostaEnviada = propostasPendentes.find(p => p.compraId === compraId);

      // Remove a proposta da fila
      propostasPendentes = propostasPendentes.filter(p => p.compraId !== compraId);

      // Se o envio foi bem-sucedido, atualiza o status no kanban para "proposta_enviada"
      if (success && propostaEnviada && propostaEnviada.cnpj && propostaEnviada.ano && propostaEnviada.sequencial) {
        try {
          db.prepare(`
            UPDATE kanban_status
            SET status = 'enviada',
                observacao = 'Proposta enviada automaticamente',
                dataAtualizacao = CURRENT_TIMESTAMP
            WHERE cnpj = ? AND ano = ? AND sequencial = ?
          `).run(propostaEnviada.cnpj, propostaEnviada.ano, propostaEnviada.sequencial);
          console.log('[PROPOSTA] Status atualizado para enviada');
        } catch (e) {
          console.error('[PROPOSTA] Erro ao atualizar kanban:', e.message);
        }
      }

      // ========== ALERTA TELEGRAM ==========
      try {
        let mensagemTelegram = '';

        if (success) {
          // Sucesso total
          mensagemTelegram = `✅ <b>PROPOSTA ENVIADA COM SUCESSO!</b>\n\n`;
          mensagemTelegram += `📋 <b>Compra:</b> ${numeroCompra || 'N/A'}\n`;
          mensagemTelegram += `🏢 <b>UASG:</b> ${uasg || 'N/A'}\n`;
          mensagemTelegram += `📦 <b>Itens salvos:</b> ${itensSalvos || (itens ? itens.length : 0)}\n`;

          if (propostaEnviada && propostaEnviada.objetoCompra) {
            mensagemTelegram += `\n📝 <b>Objeto:</b> ${propostaEnviada.objetoCompra.substring(0, 100)}${propostaEnviada.objetoCompra.length > 100 ? '...' : ''}`;
          }

          mensagemTelegram += `\n\n⏰ ${new Date().toLocaleString('pt-BR')}`;
        } else if (itensSalvos && itensSalvos > 0) {
          // Sucesso parcial
          mensagemTelegram = `⚠️ <b>PROPOSTA PARCIALMENTE ENVIADA</b>\n\n`;
          mensagemTelegram += `📋 <b>Compra:</b> ${numeroCompra || 'N/A'}\n`;
          mensagemTelegram += `🏢 <b>UASG:</b> ${uasg || 'N/A'}\n`;
          mensagemTelegram += `✅ <b>Itens salvos:</b> ${itensSalvos}\n`;
          mensagemTelegram += `❌ <b>Itens com erro:</b> ${itensComErro ? itensComErro.length : 0}\n`;

          if (itensComErro && itensComErro.length > 0) {
            mensagemTelegram += `\n<b>Erros:</b>\n`;
            itensComErro.slice(0, 3).forEach(item => {
              mensagemTelegram += `• Item ${item.numero}: ${item.erro}\n`;
            });
          }

          mensagemTelegram += `\n⏰ ${new Date().toLocaleString('pt-BR')}`;
        } else {
          // Falha total
          mensagemTelegram = `❌ <b>FALHA AO ENVIAR PROPOSTA</b>\n\n`;
          mensagemTelegram += `📋 <b>Compra:</b> ${numeroCompra || 'N/A'}\n`;
          mensagemTelegram += `🏢 <b>UASG:</b> ${uasg || 'N/A'}\n`;
          mensagemTelegram += `\n<b>Erro:</b> ${error || 'Nenhum item foi salvo'}\n`;
          mensagemTelegram += `\n⏰ ${new Date().toLocaleString('pt-BR')}`;
        }

        await sendTelegram(db, mensagemTelegram);
        console.log('[PROPOSTA] Alerta Telegram enviado');
      } catch (telegramError) {
        console.error('[PROPOSTA] Erro ao enviar alerta Telegram:', telegramError.message);
      }
      // =====================================

      // Atualiza status
      statusEnvioProposta = {
        ativo: false,
        etapa: success ? 'Concluído' : 'Erro',
        progresso: 100,
        mensagens: success
          ? [`Proposta enviada com sucesso para compra ${compraId}`]
          : [`Erro ao enviar proposta: ${error}`],
        resultado: { success, compraId, error, timestamp }
      };

      // Registra no banco de dados (histórico)
      try {
        db.prepare(`
          INSERT INTO proposta_historico (compraId, uasg, numeroCompra, success, error, timestamp)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(compraId, uasg, numeroCompra, success ? 1 : 0, error || null, timestamp || new Date().toISOString());
      } catch (e) {
        // Tabela pode não existir, ignora
        console.log('[PROPOSTA] Tabela de histórico não existe, ignorando...');
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Erro ao processar resultado:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Endpoint para adicionar proposta na fila (para uso via extensão)
  app.post('/api/proposta/adicionar-fila', (req, res) => {
    try {
      const { compraId, uasg, numeroCompra, itens } = req.body;

      if (!compraId || !itens || !Array.isArray(itens)) {
        return res.status(400).json({ success: false, error: 'Dados incompletos' });
      }

      // Verifica se já não está na fila
      if (propostasPendentes.some(p => p.compraId === compraId)) {
        return res.json({ success: true, message: 'Proposta já está na fila' });
      }

      propostasPendentes.push({
        compraId,
        uasg,
        numeroCompra,
        itens,
        timestamp: new Date().toISOString()
      });

      // Atualiza status
      statusEnvioProposta = {
        ativo: true,
        etapa: 'Aguardando extensão processar',
        progresso: 10,
        mensagens: [`Proposta adicionada na fila para compra ${compraId}`]
      };

      console.log(`[PROPOSTA] Adicionada na fila: compraId=${compraId}`);

      res.json({ success: true, message: 'Proposta adicionada na fila. A extensão irá processar.' });
    } catch (error) {
      console.error('Erro ao adicionar proposta na fila:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Propostas] Rotas registradas');
}

module.exports = { registrarRotasPropostasParticipacoes };
