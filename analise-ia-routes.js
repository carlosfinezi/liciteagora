// analise-ia-routes.js
//
// Rotas HTTP de Análise IA (viabilidade de licitação via Gemini/Claude).
// Extraído de server.js em NFSE-M06 onda 6.5.
//
// Contexto histórico: há DOIS blocos de rotas no server.js original —
//   Bloco A (// ==================== ANÁLISE IA (rotas) ==================== )
//   Bloco B (// ─── ROTAS DE ANÁLISE IA ─────────────────────────────────── )
// com formas quase-duplicadas, ordem de parâmetros diferente na URL
// (:cnpj/:ano/:sequencial em A vs :cnpj/:sequencial/:ano em B) e UMA
// colisão crua: `GET /api/analise/stats` aparece nos dois. Em Express, quando
// dois handlers batem no mesmo método+path, o PRIMEIRO registrado envia a
// resposta e mata a cadeia — ou seja, o do Bloco A (`{success, stats:{total,
// pendentes, porSegmento, porComplexidade}}`) é o que responde em prod. O do
// Bloco B (`{total, analisadas, pendentes, alta, chaveConfigurada}`) está
// efetivamente morto mas permanece aqui registrado para preservar 1:1 a
// ordem/superfície do monolito — qualquer deduplicação é onda de limpeza
// separada, fora do escopo desta extração.
//
// Helpers do server.js passados via options para não duplicar get/set
// config (getConfigValue/setConfigValue têm ~37 call-sites no monolito e
// lêem/escrevem a tabela `config` usando prepared statements cacheados lá).
// analisarLicitacao/processarFilaAnalise vêm de ./analise-ia e são
// require()d aqui diretamente — mesma fonte usada por server.js e
// pncp-sync-scheduler.js.

const { analisarLicitacao, processarFilaAnalise } = require('./analise-ia');

function registrarRotasAnaliseIa(app, db, { getConfigValue, setConfigValue, getIAKeys }) {
  // ==================== BLOCO A ====================

  // Retorna a análise IA de uma licitação específica
  app.get('/api/licitacoes/:cnpj/:ano/:sequencial/analise', (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;
      const analise = db.prepare(`
        SELECT * FROM licitacao_analise
        WHERE cnpj = ? AND ano = ? AND sequencial = ? AND resumo != 'ignorada'
      `).get(cnpj, parseInt(ano), parseInt(sequencial));

      if (!analise) {
        return res.json({ success: true, analise: null });
      }

      // Parse JSON fields
      analise.itens_destaque = JSON.parse(analise.itens_destaque || '[]');
      analise.requisitos = JSON.parse(analise.requisitos || '[]');
      analise.atencao = JSON.parse(analise.atencao || '[]');
      analise.arquivos_info = JSON.parse(analise.arquivos_info || '[]');

      res.json({ success: true, analise });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Força (re)análise de uma licitação específica
  app.post('/api/licitacoes/:cnpj/:ano/:sequencial/analisar', async (req, res) => {
    try {
      const { cnpj, ano, sequencial } = req.params;
      const keys = getIAKeys();
      if (!keys) {
        return res.status(400).json({ success: false, error: 'Nenhuma chave de IA configurada. Vá em Fornecedor > Análise IA.' });
      }

      const resultado = await analisarLicitacao(db, cnpj, parseInt(ano), parseInt(sequencial), keys);
      if (!resultado) {
        // Verificar se a licitação existe no banco
        const existe = db.prepare('SELECT id FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?')
          .get(cnpj, parseInt(ano), parseInt(sequencial));
        if (!existe) {
          return res.status(404).json({ success: false, error: 'Licitação não encontrada no banco de dados' });
        }
        return res.status(502).json({ success: false, error: 'Falha nos providers de IA. Verifique as chaves em Fornecedor > Análise IA (Gemini: cota esgotada? Claude: sem créditos?)' });
      }

      res.json({ success: true, analise: resultado });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Processa fila de análises pendentes
  app.post('/api/analise/processar', async (req, res) => {
    try {
      const keys = getIAKeys();
      if (!keys) {
        return res.status(400).json({ success: false, error: 'Nenhuma chave de IA configurada' });
      }
      const limite = parseInt(req.body.limite) || 20;
      const processadas = await processarFilaAnalise(db, keys, limite);
      res.json({ success: true, processadas });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Estatísticas de análise (Bloco A) — colide com handler do Bloco B
  // registrado depois; como este é registrado PRIMEIRO, é este que responde.
  app.get('/api/analise/stats', (req, res) => {
    try {
      const total = db.prepare('SELECT COUNT(*) as count FROM licitacao_analise').get().count;
      const pendentes = db.prepare(`
        SELECT COUNT(*) as count FROM licitacoes l
        LEFT JOIN licitacao_analise a ON l.cnpj = a.cnpj AND l.anoCompra = a.ano AND l.sequencialCompra = a.sequencial
        WHERE a.id IS NULL AND l.dataEncerramentoProposta >= date('now')
      `).get().count;
      const porSegmento = db.prepare(`
        SELECT segmento, COUNT(*) as count, AVG(viabilidade_score) as avgScore
        FROM licitacao_analise GROUP BY segmento ORDER BY count DESC LIMIT 10
      `).all();
      const porComplexidade = db.prepare(`
        SELECT complexidade, COUNT(*) as count FROM licitacao_analise GROUP BY complexidade
      `).all();

      res.json({
        success: true,
        stats: { total, pendentes, porSegmento, porComplexidade }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Verificar chaves de IA configuradas
  app.get('/api/config/ia-keys', (req, res) => {
    try {
      const gemini = getConfigValue('gemini_api_key');
      const anthropic = getConfigValue('anthropic_api_key');
      res.json({
        success: true,
        gemini: { configurada: !!gemini, preview: gemini ? gemini.substring(0, 10) + '...' : null },
        anthropic: { configurada: !!anthropic, preview: anthropic ? anthropic.substring(0, 10) + '...' : null },
        alguma_configurada: !!(gemini || anthropic)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar chave de IA (provider: gemini ou anthropic)
  app.post('/api/config/ia-keys', (req, res) => {
    try {
      const { provider, key } = req.body;
      if (provider === 'gemini') {
        if (!key || typeof key !== 'string' || !key.startsWith('AIza')) {
          return res.status(400).json({ success: false, error: 'Chave Gemini inválida. Deve começar com AIza...' });
        }
        setConfigValue('gemini_api_key', key);
      } else if (provider === 'anthropic') {
        if (!key || typeof key !== 'string' || !key.startsWith('sk-')) {
          return res.status(400).json({ success: false, error: 'Chave Anthropic inválida. Deve começar com sk-...' });
        }
        setConfigValue('anthropic_api_key', key);
      } else {
        return res.status(400).json({ success: false, error: 'Provider inválido. Use "gemini" ou "anthropic".' });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Remover chave de IA
  app.post('/api/config/ia-key-remove', (req, res) => {
    try {
      const { provider } = req.body;
      if (provider === 'gemini') {
        setConfigValue('gemini_api_key', '');
      } else if (provider === 'anthropic') {
        setConfigValue('anthropic_api_key', '');
      } else {
        return res.status(400).json({ success: false, error: 'Provider inválido' });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== BLOCO B ====================

  // GET análise de uma licitação específica (param order :cnpj/:sequencial/:ano)
  app.get('/api/licitacoes/:cnpj/:sequencial/:ano/analise', (req, res) => {
    try {
      const { cnpj, sequencial, ano } = req.params;
      const analise = db.prepare(`
        SELECT * FROM licitacao_analise
        WHERE cnpj = ? AND ano = ? AND sequencial = ? AND resumo != 'ignorada'
      `).get(cnpj, parseInt(ano), parseInt(sequencial));

      if (!analise) return res.json({ analise: null, pendente: true });

      res.json({
        analise: {
          ...analise,
          itens_destaque: JSON.parse(analise.itens_destaque || '[]'),
          requisitos: JSON.parse(analise.requisitos || '[]'),
          atencao: JSON.parse(analise.atencao || '[]'),
          arquivos_info: JSON.parse(analise.arquivos_info || '[]'),
        }
      });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST forçar análise de uma licitação (param order :cnpj/:sequencial/:ano)
  app.post('/api/licitacoes/:cnpj/:sequencial/:ano/analisar', async (req, res) => {
    try {
      const { cnpj, sequencial, ano } = req.params;
      const anthropicKey = getConfigValue('anthropic_api_key');
      const geminiKey = getConfigValue('gemini_api_key');
      if (!anthropicKey && !geminiKey) return res.status(400).json({ error: 'Nenhuma chave de IA configurada. Acesse Configurações > IA.' });
      const keys = { anthropic: anthropicKey, gemini: geminiKey };

      const lic = db.prepare('SELECT * FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?')
        .get(cnpj, parseInt(ano), parseInt(sequencial));
      if (!lic) return res.status(404).json({ error: 'Licitação não encontrada no banco' });

      // Força re-análise removendo anterior
      db.prepare('DELETE FROM licitacao_analise WHERE cnpj = ? AND ano = ? AND sequencial = ?')
        .run(cnpj, parseInt(ano), parseInt(sequencial));

      const resultado = await analisarLicitacao(db, cnpj, parseInt(ano), parseInt(sequencial), keys);

      if (!resultado) return res.status(500).json({ error: 'Falha na análise. Verifique o log do servidor.' });

      const analise = db.prepare('SELECT * FROM licitacao_analise WHERE cnpj = ? AND ano = ? AND sequencial = ?')
        .get(cnpj, parseInt(ano), parseInt(sequencial));

      res.json({
        sucesso: true,
        analise: {
          ...analise,
          itens_destaque: JSON.parse(analise.itens_destaque || '[]'),
          requisitos: JSON.parse(analise.requisitos || '[]'),
          atencao: JSON.parse(analise.atencao || '[]'),
          arquivos_info: JSON.parse(analise.arquivos_info || '[]'),
        }
      });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET/POST chave Anthropic
  app.get('/api/config/anthropic-key', (req, res) => {
    const key = getConfigValue('anthropic_api_key');
    res.json({ configurada: !!key, prefixo: key ? key.substring(0, 10) + '...' : null });
  });

  app.post('/api/config/anthropic-key', (req, res) => {
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return res.status(400).json({ error: 'Chave inválida. Deve começar com sk-ant-' });
    }
    setConfigValue('anthropic_api_key', apiKey);
    res.json({ sucesso: true });
  });

  // GET estatísticas de análise (Bloco B) — DEAD CODE: Bloco A já respondeu,
  // mantido só para preservar paridade 1:1 com o monolito original.
  app.get('/api/analise/stats', (req, res) => {
    const total = db.prepare('SELECT COUNT(*) as c FROM licitacoes WHERE dataEncerramentoProposta >= date("now")').get().c;
    const analisadas = db.prepare('SELECT COUNT(*) as c FROM licitacao_analise la JOIN licitacoes l ON l.numeroControlePNCP = la.numeroControlePNCP WHERE l.dataEncerramentoProposta >= date("now")').get().c;
    const alta = db.prepare('SELECT COUNT(*) as c FROM licitacao_analise la JOIN licitacoes l ON l.numeroControlePNCP = la.numeroControlePNCP WHERE l.dataEncerramentoProposta >= date("now") AND la.viabilidade_score >= 70').get().c;
    const chaveConfigurada = !!getConfigValue('anthropic_api_key');
    res.json({ total, analisadas, pendentes: total - analisadas, alta, chaveConfigurada });
  });


  // Lista todas as análises IA com dados da licitação
  app.get('/api/analise/lista', (req, res) => {
    try {
      const { segmento, complexidade, scoreMin, scoreMax, busca, ordem, pagina = 1, limite = 50 } = req.query;
      const params = [];
      const where = ["a.resumo != 'ignorada'"];

      if (segmento) { where.push('a.segmento = ?'); params.push(segmento); }
      if (complexidade) { where.push('a.complexidade = ?'); params.push(complexidade); }
      if (scoreMin) { where.push('a.viabilidade_score >= ?'); params.push(Number(scoreMin)); }
      if (scoreMax) { where.push('a.viabilidade_score <= ?'); params.push(Number(scoreMax)); }
      if (busca) { where.push('(a.resumo LIKE ? OR l.objetoCompra LIKE ? OR l.nomeUnidade LIKE ?)'); params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); }

      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

      let orderBy = 'a.dataAnalise DESC';
      if (ordem === 'score_desc') orderBy = 'a.viabilidade_score DESC';
      if (ordem === 'score_asc') orderBy = 'a.viabilidade_score ASC';
      if (ordem === 'data_asc') orderBy = 'a.dataAnalise ASC';
      if (ordem === 'encerramento') orderBy = 'l.dataEncerramentoProposta ASC';
      if (ordem === 'valor_desc') orderBy = 'l.valorTotalEstimado DESC';

      const offset = (Number(pagina) - 1) * Number(limite);

      const totalRow = db.prepare(`
        SELECT COUNT(*) as total FROM licitacao_analise a
        LEFT JOIN licitacoes l ON a.cnpj = l.cnpj AND a.ano = l.anoCompra AND a.sequencial = l.sequencialCompra
        ${whereClause}
      `).get(...params);

      const rows = db.prepare(`
        SELECT
          a.*,
          l.objetoCompra, l.nomeUnidade, l.ufSigla, l.municipioNome,
          l.valorTotalEstimado, l.dataEncerramentoProposta, l.dataPublicacaoPncp,
          l.modalidadeNome, l.situacaoCompraNome, l.linkSistemaOrigem,
          l.numeroControlePNCP
        FROM licitacao_analise a
        LEFT JOIN licitacoes l ON a.cnpj = l.cnpj AND a.ano = l.anoCompra AND a.sequencial = l.sequencialCompra
        ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?
      `).all(...params, Number(limite), offset);

      // Parse JSON fields
      for (const r of rows) {
        try { r.itens_destaque = JSON.parse(r.itens_destaque || '[]'); } catch { r.itens_destaque = []; }
        try { r.requisitos = JSON.parse(r.requisitos || '[]'); } catch { r.requisitos = []; }
        try { r.atencao = JSON.parse(r.atencao || '[]'); } catch { r.atencao = []; }
        try { r.arquivos_info = JSON.parse(r.arquivos_info || '[]'); } catch { r.arquivos_info = []; }
      }

      // Segmentos distintos para filtro
      const segmentos = db.prepare('SELECT DISTINCT segmento FROM licitacao_analise WHERE segmento IS NOT NULL ORDER BY segmento').all().map(r => r.segmento);

      res.json({
        success: true,
        total: totalRow.total,
        pagina: Number(pagina),
        limite: Number(limite),
        segmentos,
        analises: rows
      });
    } catch (error) {
      console.error('[API] Erro ao listar análises:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[AnaliseIA] Rotas registradas');
}

module.exports = { registrarRotasAnaliseIa };
