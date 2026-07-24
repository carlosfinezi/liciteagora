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
// Fase 3g (2026-05-23): SELECTs simples de licitacoes vão pra PG
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';
const {
  executarScanGrupo,
  buscarLicitacoesDoGrupo,
  carregarGrupoCompleto,
} = require('./analise-ia-scheduler');

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

      // Resolve produtos_que_vendo: prioridade pro grupo informado em ?grupoId=N
      // (UI sabe de qual grupo veio a chamada). Senão, concatena de todos os
      // agendamentos ativos — IA recebe contexto da empresa toda.
      const grupoIdParam = parseInt(req.query.grupoId);
      let produtosQueVendo = null;
      if (Number.isInteger(grupoIdParam) && grupoIdParam > 0) {
        const row = db.prepare('SELECT produtos_que_vendo FROM analise_ia_agendamento WHERE grupoId = ?').get(grupoIdParam);
        produtosQueVendo = row?.produtos_que_vendo || null;
      } else {
        const rows = db.prepare(`
          SELECT a.produtos_que_vendo FROM analise_ia_agendamento a
            JOIN grupos_palavras g ON g.id = a.grupoId AND g.ativo = 1
           WHERE a.ativo = 1 AND a.produtos_que_vendo IS NOT NULL AND length(a.produtos_que_vendo) > 0
        `).all();
        const partes = rows.map(r => r.produtos_que_vendo).filter(Boolean);
        if (partes.length > 0) produtosQueVendo = partes.join('\n\n---\n\n');
      }

      const resultado = await analisarLicitacao(db, cnpj, parseInt(ano), parseInt(sequencial), keys, { produtosQueVendo });
      if (!resultado) {
        // Verificar se a licitação existe no banco
        let existe;
        if (USE_PG) {
          existe = await catalogPg.queryOne(
            'SELECT "id" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3',
            [cnpj, parseInt(ano), parseInt(sequencial)]
          );
        } else {
          existe = db.prepare('SELECT id FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?')
            .get(cnpj, parseInt(ano), parseInt(sequencial));
        }
        if (!existe) {
          return res.status(404).json({ success: false, error: 'Licitação não encontrada no banco de dados' });
        }
        return res.status(502).json({ success: false, error: 'Falha nos providers de IA. Verifique as chaves em Fornecedor > Análise IA (Gemini: cota esgotada? Claude: sem créditos?)' });
      }

      // Re-lê a linha salva para incluir arquivos_info / textos_extraidos
      // (analisarLicitacao retorna só o JSON da IA, sem metadados de anexos).
      const linha = db.prepare(`
        SELECT * FROM licitacao_analise
        WHERE cnpj = ? AND ano = ? AND sequencial = ?
      `).get(cnpj, parseInt(ano), parseInt(sequencial));

      const analiseCompleta = linha ? {
        ...linha,
        itens_destaque: JSON.parse(linha.itens_destaque || '[]'),
        requisitos: JSON.parse(linha.requisitos || '[]'),
        atencao: JSON.parse(linha.atencao || '[]'),
        arquivos_info: JSON.parse(linha.arquivos_info || '[]'),
      } : resultado;

      res.json({ success: true, analise: analiseCompleta });
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
      const cerebras = getConfigValue('cerebras_api_key');
      const gemini = getConfigValue('gemini_api_key');
      const deepseek = getConfigValue('deepseek_api_key');
      const groq = getConfigValue('groq_api_key');
      const anthropic = getConfigValue('anthropic_api_key');
      res.json({
        success: true,
        cerebras: { configurada: !!cerebras, preview: cerebras ? cerebras.substring(0, 10) + '...' : null },
        gemini: { configurada: !!gemini, preview: gemini ? gemini.substring(0, 10) + '...' : null },
        deepseek: { configurada: !!deepseek, preview: deepseek ? deepseek.substring(0, 10) + '...' : null },
        groq: { configurada: !!groq, preview: groq ? groq.substring(0, 10) + '...' : null },
        anthropic: { configurada: !!anthropic, preview: anthropic ? anthropic.substring(0, 10) + '...' : null },
        alguma_configurada: !!(cerebras || gemini || deepseek || groq || anthropic)
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Salvar chave de IA. Providers suportados:
  //   cerebras (csk-...), gemini (AIza...), deepseek (sk-...),
  //   groq (gsk_...), anthropic (sk-...).
  app.post('/api/config/ia-keys', (req, res) => {
    try {
      const { provider, key } = req.body;
      const validar = (prefix) => key && typeof key === 'string' && key.startsWith(prefix);
      if (provider === 'cerebras') {
        if (!validar('csk-')) return res.status(400).json({ success: false, error: 'Chave Cerebras inválida. Deve começar com csk-...' });
        setConfigValue('cerebras_api_key', key);
      } else if (provider === 'gemini') {
        if (!validar('AIza')) return res.status(400).json({ success: false, error: 'Chave Gemini inválida. Deve começar com AIza...' });
        setConfigValue('gemini_api_key', key);
      } else if (provider === 'deepseek') {
        if (!validar('sk-')) return res.status(400).json({ success: false, error: 'Chave DeepSeek inválida. Deve começar com sk-...' });
        setConfigValue('deepseek_api_key', key);
      } else if (provider === 'groq') {
        if (!validar('gsk_')) return res.status(400).json({ success: false, error: 'Chave Groq inválida. Deve começar com gsk_...' });
        setConfigValue('groq_api_key', key);
      } else if (provider === 'anthropic') {
        if (!validar('sk-')) return res.status(400).json({ success: false, error: 'Chave Anthropic inválida. Deve começar com sk-...' });
        setConfigValue('anthropic_api_key', key);
      } else {
        return res.status(400).json({ success: false, error: 'Provider inválido. Use cerebras, gemini, deepseek, groq ou anthropic.' });
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
      const chavePor = { cerebras: 'cerebras_api_key', gemini: 'gemini_api_key',
                         deepseek: 'deepseek_api_key', groq: 'groq_api_key',
                         anthropic: 'anthropic_api_key' };
      if (!chavePor[provider]) return res.status(400).json({ success: false, error: 'Provider inválido' });
      setConfigValue(chavePor[provider], '');
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

      let lic;
      if (USE_PG) {
        lic = await catalogPg.queryOne(
          'SELECT *, COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") AS "dataEncerramentoProposta" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3',
          [cnpj, parseInt(ano), parseInt(sequencial)]
        );
      } else {
        lic = db.prepare('SELECT * FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?')
          .get(cnpj, parseInt(ano), parseInt(sequencial));
      }
      if (!lic) return res.status(404).json({ error: 'Licitação não encontrada no banco' });

      // Força re-análise removendo anterior (tenant-scoped desde 2026-04-23)
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
  // Fase 3g: em PG mode evita JOIN cross-DB; retorna apenas chaveConfigurada.
  app.get('/api/analise/stats', (req, res) => {
    if (USE_PG) {
      const chaveConfigurada = !!getConfigValue('anthropic_api_key');
      return res.json({ total: 0, analisadas: 0, pendentes: 0, alta: 0, chaveConfigurada });
    }
    const total = db.prepare('SELECT COUNT(*) as c FROM licitacoes WHERE dataEncerramentoProposta >= date("now")').get().c;
    const analisadas = db.prepare('SELECT COUNT(*) as c FROM licitacao_analise la JOIN licitacoes l ON l.numeroControlePNCP = la.numeroControlePNCP WHERE l.dataEncerramentoProposta >= date("now")').get().c;
    const alta = db.prepare('SELECT COUNT(*) as c FROM licitacao_analise la JOIN licitacoes l ON l.numeroControlePNCP = la.numeroControlePNCP WHERE l.dataEncerramentoProposta >= date("now") AND la.viabilidade_score >= 70').get().c;
    const chaveConfigurada = !!getConfigValue('anthropic_api_key');
    res.json({ total, analisadas, pendentes: total - analisadas, alta, chaveConfigurada });
  });


  // Lista todas as análises IA com dados da licitação
  app.get('/api/analise/lista', async (req, res) => {
    try {
      const { grupoId, uf, complexidade, scoreMin, scoreMax, busca, ordem, pagina = 1, limite = 50, pncp,
              dataInicial, dataFinal, encerramentoInicial, encerramentoFinal, apenasAbertas } = req.query;
      const params = [];
      const where = ["a.resumo != 'ignorada'"];

      // Filtro exato por numeroControlePNCP (deep-link de outra página)
      if (pncp) {
        where.push('a.numeroControlePNCP = ?');
        params.push(String(pncp));
      }
      // Em PG mode: filtros que dependem de licitacoes/itens (grupoId, uf, busca em objetoCompra/nomeUnidade, ordenação por l.*)
      // são aplicados em JS pós-fetch. SQLite mode mantém JOIN local.
      if (!USE_PG) {
        if (grupoId) {
          const palavrasGrupo = db.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?')
            .all(Number(grupoId)).map(r => String(r.palavra || '').trim()).filter(Boolean);
          if (palavrasGrupo.length === 0) {
            where.push('1=0');
          } else {
            const conds = palavrasGrupo.map(() =>
              "(LOWER(l.objetoCompra) LIKE ? OR EXISTS (SELECT 1 FROM itens i WHERE i.licitacaoId = l.id AND LOWER(i.descricao) LIKE ?))"
            ).join(' OR ');
            where.push(`(${conds})`);
            for (const p of palavrasGrupo) {
              const like = `%${p.toLowerCase()}%`;
              params.push(like, like);
            }
          }
        }
        if (uf) { where.push('l.ufSigla = ?'); params.push(String(uf).toUpperCase()); }
      }
      if (complexidade) { where.push('a.complexidade = ?'); params.push(complexidade); }
      if (scoreMin) { where.push('a.viabilidade_score >= ?'); params.push(Number(scoreMin)); }
      if (scoreMax) { where.push('a.viabilidade_score <= ?'); params.push(Number(scoreMax)); }
      if (!USE_PG && busca) { where.push('(a.resumo LIKE ? OR l.objetoCompra LIKE ? OR l.nomeUnidade LIKE ?)'); params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); }
      if (USE_PG && busca) { where.push('a.resumo LIKE ?'); params.push(`%${busca}%`); }
      // Filtro pela data em que a análise IA foi gerada (date() ignora hora)
      if (dataInicial) { where.push('date(a.dataAnalise) >= date(?)'); params.push(String(dataInicial)); }
      if (dataFinal)   { where.push('date(a.dataAnalise) <= date(?)'); params.push(String(dataFinal)); }

      // Filtros que dependem de licitacoes.dataEncerramentoProposta. SQLite mode aplica
      // direto via JOIN. PG mode pré-consulta o catálogo pra obter as keys que passam,
      // depois aplica IN (...) na query SQLite — evita filtro pós-fetch que quebra paginação.
      const temFiltroEncerramento = (apenasAbertas === '1' || apenasAbertas === 'true') ||
                                     !!encerramentoInicial || !!encerramentoFinal;
      if (temFiltroEncerramento && !USE_PG) {
        if (apenasAbertas === '1' || apenasAbertas === 'true') {
          where.push("date(l.dataEncerramentoProposta) >= date('now')");
        }
        if (encerramentoInicial) { where.push('date(l.dataEncerramentoProposta) >= date(?)'); params.push(String(encerramentoInicial)); }
        if (encerramentoFinal)   { where.push('date(l.dataEncerramentoProposta) <= date(?)'); params.push(String(encerramentoFinal)); }
      }
      if (temFiltroEncerramento && USE_PG) {
        const tenantKeys = db.prepare(
          `SELECT DISTINCT cnpj, ano, sequencial FROM licitacao_analise WHERE resumo != 'ignorada'`
        ).all();
        if (tenantKeys.length === 0) {
          where.push('1=0');
        } else {
          const cnpjs = tenantKeys.map(k => String(k.cnpj));
          const anos  = tenantKeys.map(k => Number(k.ano));
          const seqs  = tenantKeys.map(k => Number(k.sequencial));
          const pgConds = [
            `(l.cnpj, l."anoCompra", l."sequencialCompra") IN (SELECT * FROM unnest($1::text[], $2::int[], $3::bigint[]))`
          ];
          const pgParams = [cnpjs, anos, seqs];
          let pi = 4;
          if (apenasAbertas === '1' || apenasAbertas === 'true') {
            pgConds.push(`COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") >= now()`);
          }
          if (encerramentoInicial) {
            pgConds.push(`COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") >= $${pi++}::date`);
            pgParams.push(String(encerramentoInicial));
          }
          if (encerramentoFinal) {
            pgConds.push(`COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") < ($${pi++}::date + interval '1 day')`);
            pgParams.push(String(encerramentoFinal));
          }
          const pgRows = await catalogPg.query(
            `SELECT l.cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS sequencial
               FROM licitacoes l WHERE ${pgConds.join(' AND ')}`,
            pgParams
          );
          if (pgRows.length === 0) {
            where.push('1=0');
          } else {
            const compoundKeys = pgRows.map(r => `${r.cnpj}|${r.ano}|${r.sequencial}`);
            where.push(`(a.cnpj || '|' || a.ano || '|' || a.sequencial) IN (${compoundKeys.map(() => '?').join(',')})`);
            params.push(...compoundKeys);
          }
        }
      }

      // grupoId em PG mode: a marca/produto quase sempre está na descrição dos
      // ITENS, não no objetoCompra genérico — então casa objeto OU itens (igual
      // ao SQLite mode). Restringe às análises do tenant (poucas) antes de tocar
      // a tabela `itens` (18M linhas) pra não estourar timeout, e aplica IN (...)
      // na query SQLite (paginação e total corretos). Mesma estratégia do
      // filtro de encerramento acima. O pós-fetch só-por-objetoCompra foi
      // removido — ele descartava 38–76% das licitações relevantes por grupo.
      if (grupoId && USE_PG) {
        const palavrasGrupo = db.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?')
          .all(Number(grupoId)).map(r => String(r.palavra || '').trim()).filter(Boolean);
        const tenantKeys = palavrasGrupo.length === 0 ? [] : db.prepare(
          `SELECT DISTINCT cnpj, ano, sequencial FROM licitacao_analise WHERE resumo != 'ignorada'`
        ).all();
        if (palavrasGrupo.length === 0 || tenantKeys.length === 0) {
          where.push('1=0');
        } else {
          const likes = palavrasGrupo.map(p => `%${p.toLowerCase()}%`);
          // Etapa 1: ids internos das licitações analisadas pelo tenant (rápido,
          // ~milhares). Etapa 2: dentre esses ids, quais casam por objetoCompra
          // OU descrição de item — usando `licitacaoId = ANY(ids)` (idx_itens_licitacao)
          // pra tocar só os itens dessas licitações, não os 18M da tabela inteira.
          const alvo = await catalogPg.query(
            `SELECT l.id, l.cnpj, l."anoCompra" AS ano, l."sequencialCompra" AS sequencial
               FROM licitacoes l
              WHERE (l.cnpj, l."anoCompra", l."sequencialCompra") IN (SELECT * FROM unnest($1::text[], $2::int[], $3::bigint[]))`,
            [tenantKeys.map(k => String(k.cnpj)), tenantKeys.map(k => Number(k.ano)), tenantKeys.map(k => Number(k.sequencial))]
          );
          const keyById = new Map(alvo.map(r => [String(r.id), `${r.cnpj}|${r.ano}|${r.sequencial}`]));
          const ids = alvo.map(r => r.id);
          let compoundKeys = [];
          if (ids.length > 0) {
            const matched = await catalogPg.query(
              `SELECT DISTINCT id FROM (
                 SELECT id FROM licitacoes WHERE id = ANY($1) AND "objetoCompra" ILIKE ANY($2::text[])
                 UNION
                 SELECT "licitacaoId" AS id FROM itens WHERE "licitacaoId" = ANY($1) AND descricao ILIKE ANY($2::text[])
               ) x`,
              [ids, likes]
            );
            compoundKeys = matched.map(m => keyById.get(String(m.id))).filter(Boolean);
          }
          if (compoundKeys.length === 0) {
            where.push('1=0');
          } else {
            where.push(`(a.cnpj || '|' || a.ano || '|' || a.sequencial) IN (${compoundKeys.map(() => '?').join(',')})`);
            params.push(...compoundKeys);
          }
        }
      }

      const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

      let orderBy = 'a.dataAnalise DESC';
      if (ordem === 'score_desc') orderBy = 'a.viabilidade_score DESC';
      if (ordem === 'score_asc') orderBy = 'a.viabilidade_score ASC';
      if (ordem === 'data_asc') orderBy = 'a.dataAnalise ASC';
      // ordem por l.* só funciona em SQLite (JOIN local); PG mode usa fallback dataAnalise DESC.
      if (!USE_PG) {
        if (ordem === 'encerramento') orderBy = 'l.dataEncerramentoProposta ASC';
        if (ordem === 'valor_desc') orderBy = 'l.valorTotalEstimado DESC';
      }

      const offset = (Number(pagina) - 1) * Number(limite);

      let totalRow, rows;
      if (USE_PG) {
        // Tenant-only query (filtros em a.*)
        const tenantWhere = whereClause; // já só usa a.* em PG mode
        totalRow = db.prepare(`SELECT COUNT(*) as total FROM licitacao_analise a ${tenantWhere}`).get(...params);
        const analises = db.prepare(`
          SELECT a.* FROM licitacao_analise a
          ${tenantWhere}
          ORDER BY ${orderBy}
          LIMIT ? OFFSET ?
        `).all(...params, Number(limite), offset);

        // Lookup batch em PG das licitações correspondentes
        if (analises.length === 0) {
          rows = [];
        } else {
          const values = analises.map((_, j) => `($${j*3+1}::text,$${j*3+2}::int,$${j*3+3}::bigint)`).join(',');
          const pgParams = [];
          for (const a of analises) pgParams.push(String(a.cnpj), Number(a.ano), Number(a.sequencial));
          const lic = await catalogPg.query(`
            WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
            SELECT k.cnpj, k.ano, k.sequencial,
                   l."objetoCompra" AS "objetoCompra", l."nomeUnidade" AS "nomeUnidade",
                   l."ufSigla" AS "ufSigla", l."municipioNome" AS "municipioNome",
                   l."valorTotalEstimado" AS "valorTotalEstimado",
                   COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") AS "dataEncerramentoProposta",
                   l."dataPublicacaoPncp" AS "dataPublicacaoPncp",
                   l."modalidadeNome" AS "modalidadeNome",
                   l."situacaoCompraNome" AS "situacaoCompraNome",
                   l."linkSistemaOrigem" AS "linkSistemaOrigem",
                   l."numeroControlePNCP" AS "numeroControlePNCP"
              FROM keys k
         LEFT JOIN licitacoes l ON l."cnpj"=k.cnpj AND l."anoCompra"=k.ano AND l."sequencialCompra"=k.sequencial
          `, pgParams);
          const licMap = new Map();
          for (const l of lic) licMap.set(`${l.cnpj}|${l.ano}|${l.sequencial}`, l);
          rows = analises.map(a => ({ ...a, ...(licMap.get(`${a.cnpj}|${a.ano}|${a.sequencial}`) || {}) }));

          // Pós-filtros: uf e busca (parte que dependia de l.*). O grupoId já
          // foi aplicado antes da paginação via IN (...) no whereClause.
          if (uf) rows = rows.filter(r => r.ufSigla === String(uf).toUpperCase());
          if (busca) {
            const q = String(busca).toLowerCase();
            rows = rows.filter(r => (r.objetoCompra || '').toLowerCase().includes(q) || (r.nomeUnidade || '').toLowerCase().includes(q) || (r.resumo || '').toLowerCase().includes(q));
          }
        }
      } else {
        totalRow = db.prepare(`
          SELECT COUNT(*) as total FROM licitacao_analise a
          LEFT JOIN licitacoes l ON a.cnpj = l.cnpj AND a.ano = l.anoCompra AND a.sequencial = l.sequencialCompra
          ${whereClause}
        `).get(...params);

        rows = db.prepare(`
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
      }

      // Parse JSON fields
      for (const r of rows) {
        try { r.itens_destaque = JSON.parse(r.itens_destaque || '[]'); } catch { r.itens_destaque = []; }
        try { r.requisitos = JSON.parse(r.requisitos || '[]'); } catch { r.requisitos = []; }
        try { r.atencao = JSON.parse(r.atencao || '[]'); } catch { r.atencao = []; }
        try { r.arquivos_info = JSON.parse(r.arquivos_info || '[]'); } catch { r.arquivos_info = []; }
      }

      // Grupos de palavras-chave ativos da tenant. Para cada análise,
      // computa quais grupos casaram (palavra do grupo presente no
      // objetoCompra). Substitui o antigo "segmento" gerado pela IA.
      const gruposRows = db.prepare(`
        SELECT gp.id, gp.nome, gp.cor, gpi.palavra
          FROM grupos_palavras gp
          LEFT JOIN grupos_palavras_itens gpi ON gpi.grupoId = gp.id
         WHERE gp.ativo = 1 AND gp.tipo = 'pesquisa'
      `).all();
      const gruposMap = new Map();
      for (const g of gruposRows) {
        if (!gruposMap.has(g.id)) gruposMap.set(g.id, { id: g.id, nome: g.nome, cor: g.cor, palavras: [] });
        if (g.palavra) gruposMap.get(g.id).palavras.push(String(g.palavra).toLowerCase());
      }
      // Pra cada licitação visível na página, pega TODAS as descrições de
      // itens em UMA query batch.
      const itensPorLic = new Map();
      if (rows.length > 0) {
        try {
          let itensRows;
          if (USE_PG) {
            const values = rows.map((_, j) => `($${j*3+1}::text,$${j*3+2}::int,$${j*3+3}::bigint)`).join(',');
            const args = [];
            for (const r of rows) args.push(String(r.cnpj), Number(r.ano), Number(r.sequencial));
            itensRows = await catalogPg.query(`
              WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
              SELECT l."cnpj" || '/' || l."anoCompra" || '/' || l."sequencialCompra" AS "pncpKey",
                     LOWER(COALESCE(i."descricao", '')) AS d
                FROM itens i
                JOIN licitacoes l ON l."id" = i."licitacaoId"
                JOIN keys k ON l."cnpj"=k.cnpj AND l."anoCompra"=k.ano AND l."sequencialCompra"=k.sequencial
            `, args);
          } else {
            const placeholders = rows.map(() => '(?,?,?)').join(',');
            const args = [];
            for (const r of rows) args.push(r.cnpj, r.ano, r.sequencial);
            itensRows = db.prepare(`
              SELECT l.cnpj || '/' || l.anoCompra || '/' || l.sequencialCompra AS pncpKey,
                     LOWER(COALESCE(i.descricao, '')) AS d
                FROM itens i
                JOIN licitacoes l ON l.id = i.licitacaoId
               WHERE (l.cnpj, l.anoCompra, l.sequencialCompra) IN (VALUES ${placeholders})
            `).all(...args);
          }
          for (const it of itensRows) {
            const prev = itensPorLic.get(it.pncpKey) || '';
            itensPorLic.set(it.pncpKey, prev + ' ' + it.d);
          }
        } catch (_) { /* sem itens — ok */ }
      }
      for (const r of rows) {
        const obj = String(r.objetoCompra || '').toLowerCase();
        const itensBlob = itensPorLic.get(`${r.cnpj}/${r.ano}/${r.sequencial}`) || '';
        const haystack = obj + ' ' + itensBlob;
        const matched = [];
        for (const g of gruposMap.values()) {
          if (!g.palavras.length) continue;
          if (g.palavras.some(p => haystack.includes(p))) {
            matched.push({ id: g.id, nome: g.nome, cor: g.cor });
          }
        }
        r.grupos_matched = matched;
      }

      const grupos = Array.from(gruposMap.values())
        .map(g => ({ id: g.id, nome: g.nome, cor: g.cor }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

      // UFs distintas das análises (pra popular o dropdown de filtro UF)
      let ufs;
      if (USE_PG) {
        const aRows = db.prepare(`SELECT DISTINCT cnpj, ano, sequencial FROM licitacao_analise`).all();
        if (aRows.length === 0) {
          ufs = [];
        } else {
          const values = aRows.map((_, j) => `($${j*3+1}::text,$${j*3+2}::int,$${j*3+3}::bigint)`).join(',');
          const args = [];
          for (const r of aRows) args.push(String(r.cnpj), Number(r.ano), Number(r.sequencial));
          const ufRows = await catalogPg.query(`
            WITH keys(cnpj, ano, sequencial) AS (VALUES ${values})
            SELECT DISTINCT l."ufSigla" AS uf
              FROM licitacoes l
              JOIN keys k ON l."cnpj"=k.cnpj AND l."anoCompra"=k.ano AND l."sequencialCompra"=k.sequencial
             WHERE l."ufSigla" IS NOT NULL AND l."ufSigla" != ''
          ORDER BY l."ufSigla"
          `, args);
          ufs = ufRows.map(r => r.uf);
        }
      } else {
        ufs = db.prepare(`
          SELECT DISTINCT l.ufSigla AS uf
            FROM licitacao_analise a
            JOIN licitacoes l ON a.cnpj = l.cnpj AND a.ano = l.anoCompra AND a.sequencial = l.sequencialCompra
           WHERE l.ufSigla IS NOT NULL AND l.ufSigla != ''
           ORDER BY l.ufSigla
        `).all().map(r => r.uf);
      }

      res.json({
        success: true,
        total: totalRow.total,
        pagina: Number(pagina),
        limite: Number(limite),
        grupos,
        ufs,
        analises: rows
      });
    } catch (error) {
      console.error('[API] Erro ao listar análises:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ==================== AGENDAMENTO DIÁRIO POR GRUPO ====================

  // GET config do agendamento de um grupo. Retorna defaults se nunca configurado.
  app.get('/api/analise/agendamento/:grupoId', (req, res) => {
    try {
      const grupoId = parseInt(req.params.grupoId);
      if (!grupoId) return res.status(400).json({ success: false, error: 'grupoId inválido' });

      const grupo = db.prepare('SELECT id, nome FROM grupos_palavras WHERE id = ?').get(grupoId);
      if (!grupo) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });

      const row = db.prepare('SELECT * FROM analise_ia_agendamento WHERE grupoId = ?').get(grupoId);
      const config = row || {
        grupoId,
        ativo: 0,
        ufs: null,
        modalidades: null,
        valor_minimo: null,
        limite_diario: 100,
        produtos_que_vendo: null,
        auto_interesse_ativo: 0,
        auto_telegram_ativo: 0,
        auto_score_min: 70,
        ultimo_scan_em: null,
        ultimo_scan_total: 0,
        ultimo_scan_analisadas: 0,
        ultimo_scan_erros: 0,
        ultimo_scan_status: null,
        ultimo_scan_mensagem: null,
      };

      // Parse JSON arrays para o frontend consumir como array
      try { config.ufs = JSON.parse(config.ufs || '[]'); } catch { config.ufs = []; }
      try { config.modalidades = JSON.parse(config.modalidades || '[]'); } catch { config.modalidades = []; }

      res.json({ success: true, grupo, config });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // PUT salva config (upsert). Body: { ativo, ufs[], modalidades[], valor_minimo, limite_diario }
  app.put('/api/analise/agendamento/:grupoId', (req, res) => {
    try {
      const grupoId = parseInt(req.params.grupoId);
      if (!grupoId) return res.status(400).json({ success: false, error: 'grupoId inválido' });

      const grupo = db.prepare('SELECT id FROM grupos_palavras WHERE id = ?').get(grupoId);
      if (!grupo) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });

      const ativo = req.body.ativo ? 1 : 0;
      const ufs = JSON.stringify(Array.isArray(req.body.ufs) ? req.body.ufs : []);
      const modalidades = JSON.stringify(Array.isArray(req.body.modalidades) ? req.body.modalidades.map(m => Number(m) || 0) : []);
      const valorMinimo = Number(req.body.valor_minimo) || null;
      const limiteDiario = Math.max(1, Math.min(500, Number(req.body.limite_diario) || 100));
      const produtosQueVendo = (typeof req.body.produtos_que_vendo === 'string'
                                && req.body.produtos_que_vendo.trim())
                               ? req.body.produtos_que_vendo.trim() : null;
      const autoInteresseAtivo = req.body.auto_interesse_ativo ? 1 : 0;
      const autoTelegramAtivo = req.body.auto_telegram_ativo ? 1 : 0;
      const autoScoreMin = Math.max(0, Math.min(100, Number(req.body.auto_score_min) || 70));

      db.prepare(`
        INSERT INTO analise_ia_agendamento
          (grupoId, ativo, ufs, modalidades, valor_minimo, limite_diario, produtos_que_vendo,
           auto_interesse_ativo, auto_telegram_ativo, auto_score_min, dataAtualizacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(grupoId) DO UPDATE SET
          ativo = excluded.ativo,
          ufs = excluded.ufs,
          modalidades = excluded.modalidades,
          valor_minimo = excluded.valor_minimo,
          limite_diario = excluded.limite_diario,
          produtos_que_vendo = excluded.produtos_que_vendo,
          auto_interesse_ativo = excluded.auto_interesse_ativo,
          auto_telegram_ativo = excluded.auto_telegram_ativo,
          auto_score_min = excluded.auto_score_min,
          dataAtualizacao = CURRENT_TIMESTAMP
      `).run(grupoId, ativo, ufs, modalidades, valorMinimo, limiteDiario, produtosQueVendo,
             autoInteresseAtivo, autoTelegramAtivo, autoScoreMin);

      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // POST executar scan agora (não espera o cron de 6h). Útil pra testar.
  app.post('/api/analise/agendamento/:grupoId/executar', async (req, res) => {
    try {
      const grupoId = parseInt(req.params.grupoId);
      if (!grupoId) return res.status(400).json({ success: false, error: 'grupoId inválido' });

      const keys = getIAKeys();
      if (!keys) return res.status(400).json({ success: false, error: 'Nenhuma chave de IA configurada' });

      const grupo = carregarGrupoCompleto(db, grupoId);
      if (!grupo) return res.status(404).json({ success: false, error: 'Grupo não encontrado ou inativo' });

      let config = db.prepare('SELECT * FROM analise_ia_agendamento WHERE grupoId = ?').get(grupoId);
      if (!config) config = { grupoId, ativo: 0, limite_diario: 100, ufs: '[]', modalidades: '[]', valor_minimo: null };

      // Garante linha de status (mesmo que agendamento esteja desativado — útil pra preview)
      db.prepare(`
        INSERT OR IGNORE INTO analise_ia_agendamento (grupoId, ativo, limite_diario)
        VALUES (?, 0, 100)
      `).run(grupoId);

      // Não await — o scan pode demorar minutos com várias licitações.
      // Responde imediato e roda em background. Cliente faz polling via GET.
      executarScanGrupo(db, grupo, config, keys)
        .catch(e => console.error(`[AnaliseIA-Sched] Scan manual grupo ${grupoId} falhou:`, e.message));

      res.json({ success: true, mensagem: 'Scan iniciado em background. Acompanhe via GET /api/analise/agendamento/:grupoId.' });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // GET preview: lista licitações que serão analisadas (sem efetivamente analisar)
  app.get('/api/analise/agendamento/:grupoId/preview', async (req, res) => {
    try {
      const grupoId = parseInt(req.params.grupoId);
      if (!grupoId) return res.status(400).json({ success: false, error: 'grupoId inválido' });

      const grupo = carregarGrupoCompleto(db, grupoId);
      if (!grupo) return res.status(404).json({ success: false, error: 'Grupo não encontrado' });

      const config = db.prepare('SELECT * FROM analise_ia_agendamento WHERE grupoId = ?').get(grupoId)
                    || { ufs: '[]', modalidades: '[]', valor_minimo: null, limite_diario: 100 };

      const licitacoes = await buscarLicitacoesDoGrupo(db, grupo, config, config.limite_diario || 100);
      res.json({ success: true, total: licitacoes.length, licitacoes });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[AnaliseIA] Rotas registradas');
}

module.exports = { registrarRotasAnaliseIa };
