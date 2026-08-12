/**
 * analise-ia-scheduler.js — Agendamento diário de análise IA por grupo de
 * palavras. Roda 1× ao dia (default 6h) varrendo licitações abertas que
 * casam com cada grupo ativo da tenant, ignorando já analisadas, até o
 * `limite_diario` configurado.
 *
 * Integração: server.js chama `iniciarSchedulerAnaliseIa(db, getIAKeys)`
 * uma vez por tenant após boot. Tick de 1h verifica se já rodou hoje.
 *
 * Reuso: a função `buscarLicitacoesDoGrupo` é exportada e usada também
 * pelo endpoint de "executar agora" em analise-ia-routes.js.
 */

const { analisarLicitacao } = require('./analise-ia');
const { enviarAlerta } = require('./notificacoes-dispatcher');
// Fase 3b (2026-05-23): adapter Postgres pro catalog
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

// Duas janelas diárias: 6h pega o lote da noite, 14h pega o que o PNCP
// publica/atualiza durante a manhã (gargalo histórico era esperar 24h).
const HORAS_ALVO = [6, 14];
const MIN_GAP_HORAS = 6; // safety: nunca roda 2x dentro de 6h pro mesmo grupo
const TICK_MS = 60 * 60 * 1000; // 1h
// 3 min por licitação. Com throttle de 35s no Cerebras + retries no fallback
// chain, casos ruim podem chegar a ~2 min. 3 min dá margem de segurança.
const TIMEOUT_POR_ANALISE_MS = 300 * 1000;

// Backoff da marcação de falha (analise_ia_falha). Dias até a próxima tentativa,
// indexado pelo número de tentativas já feitas. A 4ª falha joga pra 30 dias, o
// que na prática desiste: edital que falhou 4x é ilegível ou grande demais, e
// reenviar 40k caracteres ao provider pago não se paga.
const FALHA_BACKOFF_DIAS = [1, 3, 7, 30];

function _diasDeBackoff(tentativas) {
  const i = Math.min(Math.max(tentativas, 1), FALHA_BACKOFF_DIAS.length) - 1;
  return FALHA_BACKOFF_DIAS[i];
}

/**
 * Constrói lista de licitações que se enquadram no grupo + filtros do
 * agendamento, ignorando as já analisadas. Limitado a `limite`.
 *
 * - Palavras do grupo: OR entre elas em objetoCompra OU itens.descricao
 * - Exclusões vinculadas: NOT LIKE em objetoCompra (não checa itens pra
 *   manter performance; mesma decisão do jornal)
 * - dataEncerramentoProposta >= today (só abertas)
 * - Filtros do agendamento: ufs (JSON array), modalidades (JSON array
 *   de modalidadeId), valor_minimo (valorTotalEstimado >= X)
 */
async function buscarLicitacoesDoGrupo(db, grupo, config, limite) {
  const palavras = (grupo.palavras || []).map(p => String(p).trim().toLowerCase()).filter(Boolean);
  if (palavras.length === 0) return [];

  const exclusoes = [];
  for (const exGrupo of (grupo.gruposExclusaoVinculados || [])) {
    for (const p of (exGrupo.palavras || [])) {
      const t = String(p).trim().toLowerCase();
      if (t) exclusoes.push(t);
    }
  }

  const ufs = parseJsonArray(config.ufs);
  const modalidades = parseJsonArray(config.modalidades);
  const valorMinimo = Number(config.valor_minimo) || 0;
  const lim = Math.max(1, Math.min(500, limite || 100));

  // === Postgres: usa tsvector pra busca de palavra, JOIN+filtro
  // licitacao_analise em JS (tabela tenant, não acessível via JOIN PG) ===
  if (USE_PG) {
    const params = [];
    let p = 1;
    const ph = (v) => { params.push(v); return '$' + (p++); };

    const dateCond = `COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") >= now() + interval '1 day'`;

    // Busca por palavra DIVIDIDA em duas metades unidas por UNION — cada metade
    // usa o índice mais barato pra cada lado, sempre PARTINDO das licitações
    // futuras (poucas, ~28k) — nunca varrendo a itens inteira.
    //
    // 1) objetoCompra: trigram ILIKE (BitmapOr em idx_lic_objeto_trgm, ~6k) — a
    //    licitacoes é pequena, substring é barato.
    // 2) itens (3M+ linhas, sob backfill): EXISTS por-licitação. Pra cada
    //    licitação futura, checa só os SEUS itens (via idx_itens_licitacao) com
    //    FTS 'simple' (casa idx_itens_desc_simple = to_tsvector('simple',
    //    COALESCE(descricao,''))). Trigram aqui ESTOURA (heap recheck em dezenas
    //    de milhares de tuplas → >30s). JOIN dirigido pela itens dava ~25s nos
    //    grupos grandes; EXISTS por data dá ~5s.
    //
    // Antes os dois lados estavam num OR único com EXISTS(itens trigram), o que
    // fazia o planejador descartar TODOS os índices (custo ~321M → timeout).
    // NOTA semântica: o lado itens passa de substring (ILIKE) p/ match de PALAVRA
    // (lexema 'simple', sem stemming) — mesma lógica já usada pela membership BI
    // (bi-grupo-membership.js).
    const objOr = palavras.map(pl => `l."objetoCompra" ILIKE ${ph('%' + pl + '%')}`).join(' OR ');
    const itemTsq = palavras.map(pl => `websearch_to_tsquery('simple', ${ph(pl)})`).join(' || ');
    const matchedCte = `
        SELECT l."id" FROM licitacoes l
         WHERE ${dateCond} AND (${objOr})
        UNION
        SELECT l."id" FROM licitacoes l
         WHERE ${dateCond} AND EXISTS (
                 SELECT 1 FROM itens i
                  WHERE i."licitacaoId" = l."id"
                    AND to_tsvector('simple', COALESCE(i."descricao", '')) @@ (${itemTsq}))`;

    // Filtros adicionais (exclusões/uf/modalidade/valor) aplicados uma vez no
    // SELECT externo, sobre as licitações já casadas pelo UNION.
    const outerConds = [];
    for (const e of exclusoes) {
      outerConds.push(`l."objetoCompra" NOT ILIKE ${ph('%' + e + '%')}`);
    }
    if (ufs.length > 0) {
      const phs = ufs.map(u => ph(u)).join(',');
      outerConds.push(`l."ufSigla" IN (${phs})`);
    }
    if (modalidades.length > 0) {
      const phs = modalidades.map(m => ph(Number(m) || 0)).join(',');
      outerConds.push(`l."modalidadeId" IN (${phs})`);
    }
    if (valorMinimo > 0) outerConds.push(`l."valorTotalEstimado" >= ${ph(valorMinimo)}`);
    const outerWhere = outerConds.length ? `WHERE ${outerConds.join(' AND ')}` : '';

    // Pega 3x o limite e filtra já-analisadas em JS
    const fetchN = lim * 3;
    const sql = `
      WITH matched AS (${matchedCte})
      SELECT l."cnpj", l."anoCompra" AS ano, l."sequencialCompra" AS sequencial,
             l."objetoCompra" as "objetoCompra", COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") as "dataEncerramentoProposta"
        FROM licitacoes l JOIN matched m ON m."id" = l."id"
       ${outerWhere}
       ORDER BY COALESCE(l."dataEncerramentoPortal", l."dataEncerramentoProposta") ASC
       LIMIT ${ph(fetchN)}
    `;
    const cands = await catalogPg.query(sql, params);
    const out = [];
    const stmt = db.prepare(`SELECT 1 FROM licitacao_analise WHERE cnpj=? AND ano=? AND sequencial=? LIMIT 1`);
    // Segundo portão: falha recente com backoff ainda em vigor (analise_ia_falha).
    const stmtFalha = db.prepare(`
      SELECT 1 FROM analise_ia_falha
       WHERE cnpj=? AND ano=? AND sequencial=?
         AND proximaTentativaEm IS NOT NULL
         AND proximaTentativaEm > CURRENT_TIMESTAMP
       LIMIT 1
    `);
    for (const c of cands) {
      const ano = Number(c.ano), seq = Number(c.sequencial);
      if (stmt.get(c.cnpj, ano, seq)) continue;
      if (stmtFalha.get(c.cnpj, ano, seq)) continue;
      out.push(c);
      if (out.length >= lim) break;
    }
    return out;
  }

  // === SQLite legado ===
  const params = [];
  const conditions = [];
  conditions.push("date(l.dataEncerramentoProposta) >= date('now', '+1 day')");
  const palavraConds = palavras.map(() => '(LOWER(l.objetoCompra) LIKE ? OR EXISTS (SELECT 1 FROM itens i WHERE i.licitacaoId = l.id AND LOWER(i.descricao) LIKE ?))').join(' OR ');
  conditions.push(`(${palavraConds})`);
  for (const p of palavras) {
    params.push(`%${p}%`, `%${p}%`);
  }
  for (const e of exclusoes) {
    conditions.push('LOWER(l.objetoCompra) NOT LIKE ?');
    params.push(`%${e}%`);
  }
  if (ufs.length > 0) {
    conditions.push(`l.ufSigla IN (${ufs.map(() => '?').join(',')})`);
    params.push(...ufs);
  }
  if (modalidades.length > 0) {
    conditions.push(`l.modalidadeId IN (${modalidades.map(() => '?').join(',')})`);
    params.push(...modalidades.map(m => Number(m) || 0));
  }
  if (valorMinimo > 0) {
    conditions.push('l.valorTotalEstimado >= ?');
    params.push(valorMinimo);
  }
  conditions.push('NOT EXISTS (SELECT 1 FROM licitacao_analise a WHERE a.cnpj = l.cnpj AND a.ano = l.anoCompra AND a.sequencial = l.sequencialCompra)');
  conditions.push(`NOT EXISTS (SELECT 1 FROM analise_ia_falha f
                                WHERE f.cnpj = l.cnpj AND f.ano = l.anoCompra AND f.sequencial = l.sequencialCompra
                                  AND f.proximaTentativaEm IS NOT NULL
                                  AND f.proximaTentativaEm > CURRENT_TIMESTAMP)`);

  const sql = `
    SELECT l.cnpj, l.anoCompra AS ano, l.sequencialCompra AS sequencial,
           l.objetoCompra, l.dataEncerramentoProposta
      FROM licitacoes l
     WHERE ${conditions.join(' AND ')}
     ORDER BY l.dataEncerramentoProposta ASC
     LIMIT ?
  `;
  return db.prepare(sql).all(...params, lim);
}

/**
 * Persiste as falhas de um scan em analise_ia_falha, com backoff crescente.
 *
 * REGRA CENTRAL: só marca se o scan analisou ALGUMA coisa (analisadas > 0).
 * Scan que falhou inteiro quase nunca é culpa das licitações — é provider fora
 * (saldo esgotado, chave inválida, rate limit geral). Marcar nesse caso
 * esconderia a fila toda por dias justamente quando o provider voltasse. Foi o
 * cenário real de 04/08 a 12/08/2026: DeepSeek com HTTP 402 (Insufficient
 * Balance) em ~800 chamadas/dia, todos os scans 0/N.
 *
 * Sucesso posterior limpa a marca — ver _limparFalha, chamado quando a análise
 * de uma licitação volta a dar certo.
 */
function _persistirFalhas(db, grupo, falhas, analisadas) {
  if (!falhas.length) return;
  if (analisadas === 0) {
    console.log(`[AnaliseIA-Sched] Grupo ${grupo.id}: ${falhas.length} falha(s) NÃO marcadas — scan não analisou nada, provável falha de provider (não penaliza a fila)`);
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO analise_ia_falha (cnpj, ano, sequencial, tentativas, ultimaFalhaEm, proximaTentativaEm, ultimoErro)
    VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP, datetime(CURRENT_TIMESTAMP, ?), ?)
    ON CONFLICT(cnpj, ano, sequencial) DO UPDATE SET
      tentativas = tentativas + 1,
      ultimaFalhaEm = CURRENT_TIMESTAMP,
      proximaTentativaEm = datetime(CURRENT_TIMESTAMP, ?),
      ultimoErro = excluded.ultimoErro
  `);
  const lerTentativas = db.prepare('SELECT tentativas FROM analise_ia_falha WHERE cnpj=? AND ano=? AND sequencial=?');

  let marcadas = 0;
  for (const { lic, erro } of falhas) {
    const ano = Number(lic.ano), seq = Number(lic.sequencial);
    try {
      const atual = lerTentativas.get(lic.cnpj, ano, seq);
      // A tentativa que acabou de falhar conta: 0 anteriores → 1ª falha.
      const dias = _diasDeBackoff((atual ? atual.tentativas : 0) + 1);
      const offset = `+${dias} days`;
      upsert.run(lic.cnpj, ano, seq, offset, String(erro || '').substring(0, 300), offset);
      marcadas++;
    } catch (e) {
      console.error(`[AnaliseIA-Sched] Falha ao marcar ${lic.cnpj}/${ano}/${seq}: ${e.message}`);
    }
  }
  console.log(`[AnaliseIA-Sched] Grupo ${grupo.id}: ${marcadas} falha(s) marcadas com backoff (fila não vai reenviá-las até vencer)`);
}

/**
 * Limpa a marca de falha quando a licitação volta a ser analisada com sucesso.
 * Sem isto o contador de tentativas seria cumulativo pra sempre e uma licitação
 * que falhou 3x e depois passou entraria em backoff de 30 dias na falha seguinte.
 */
function _limparFalha(db, lic) {
  try {
    db.prepare('DELETE FROM analise_ia_falha WHERE cnpj=? AND ano=? AND sequencial=?')
      .run(lic.cnpj, Number(lic.ano), Number(lic.sequencial));
  } catch (_) { /* best-effort: nunca derruba o scan por causa da limpeza */ }
}

/**
 * Executa o scan para um único grupo. Não relança — atualiza o status
 * no banco e retorna o resumo. Idempotente: já analisadas são puladas
 * pelo NOT EXISTS na query, e as que falharam recentemente pelo backoff
 * de analise_ia_falha.
 *
 * Tracking incremental: marca status='em_andamento' no início e atualiza
 * o contador `ultimo_scan_analisadas` após cada licitação. Se o processo
 * morrer no meio (restart, kill, crash), o status reflete o progresso
 * real até onde parou. Status final ('sucesso'/'parcial'/'erro') só é
 * gravado quando o loop termina.
 */
async function executarScanGrupo(db, grupo, config, keys) {
  const limite = Math.max(1, Math.min(500, Number(config.limite_diario) || 100));
  let candidatas = [];
  let total = 0;
  let analisadas = 0;
  let erros = 0;
  let mensagem = null;
  // Falhas do scan, persistidas só no fim — ver _persistirFalhas: enquanto o
  // scan não provar que os providers estão de pé, falha individual não vale
  // backoff.
  const falhasDoScan = [];

  const upsertEmAndamento = db.prepare(`
    UPDATE analise_ia_agendamento
       SET ultimo_scan_em = CURRENT_TIMESTAMP,
           ultimo_scan_total = ?,
           ultimo_scan_analisadas = ?,
           ultimo_scan_erros = ?,
           ultimo_scan_status = 'em_andamento',
           ultimo_scan_mensagem = NULL,
           dataAtualizacao = CURRENT_TIMESTAMP
     WHERE grupoId = ?
  `);

  try {
    candidatas = await buscarLicitacoesDoGrupo(db, grupo, config, limite);
    total = candidatas.length;

    // Marca status inicial — UI já mostra "em_andamento" com 0/N
    upsertEmAndamento.run(total, 0, 0, grupo.id);
    console.log(`[AnaliseIA-Sched] Grupo ${grupo.id} "${grupo.nome}": iniciando scan de ${total} licitação(ões)`);

    for (const lic of candidatas) {
      try {
        const resultado = await comTimeout(
          analisarLicitacao(db, lic.cnpj, lic.ano, lic.sequencial, keys, {
            produtosQueVendo: config.produtos_que_vendo || null,
          }),
          TIMEOUT_POR_ANALISE_MS,
          `timeout analisando ${lic.cnpj}/${lic.ano}/${lic.sequencial}`
        );
        if (resultado) {
          analisadas++;
          _limparFalha(db, lic);
          // Auto-ações: só se a IA classificou compatível com score acima do mínimo
          await aplicarAutoAcoes(db, grupo, config, lic, resultado);
        } else {
          erros++;
          falhasDoScan.push({ lic, erro: 'nenhum provider retornou análise' });
        }
      } catch (e) {
        erros++;
        falhasDoScan.push({ lic, erro: e.message });
        console.error(`[AnaliseIA-Sched] Erro ao analisar ${lic.cnpj}/${lic.ano}/${lic.sequencial}: ${e.message}`);
      }
      // Tick incremental: persiste após cada licitação. Se o processo
      // morrer no meio, o status reflete onde parou.
      upsertEmAndamento.run(total, analisadas, erros, grupo.id);
    }
  } catch (e) {
    mensagem = e.message;
    console.error(`[AnaliseIA-Sched] Falha no scan do grupo ${grupo.id}:`, e.message);
  }

  const status = mensagem ? 'erro'
              : erros > 0 && analisadas > 0 ? 'parcial'
              : erros > 0 ? 'erro'
              : 'sucesso';

  _persistirFalhas(db, grupo, falhasDoScan, analisadas);

  db.prepare(`
    UPDATE analise_ia_agendamento
       SET ultimo_scan_em = CURRENT_TIMESTAMP,
           ultimo_scan_total = ?,
           ultimo_scan_analisadas = ?,
           ultimo_scan_erros = ?,
           ultimo_scan_status = ?,
           ultimo_scan_mensagem = ?,
           dataAtualizacao = CURRENT_TIMESTAMP
     WHERE grupoId = ?
  `).run(total, analisadas, erros, status, mensagem, grupo.id);

  console.log(`[AnaliseIA-Sched] Grupo ${grupo.id} "${grupo.nome}": ${analisadas}/${total} analisadas, ${erros} erros, status=${status}`);
  return { total, analisadas, erros, status, mensagem };
}

/**
 * Auto-ações Fase 2: quando análise classifica licitação como compatível
 * (produto_compativel=true) com score >= auto_score_min, executa:
 *   1. auto_interesse_ativo → marca interesse em TODOS os itens da licitação
 *      (idempotente via UNIQUE; INSERT OR REPLACE)
 *   2. auto_telegram_ativo → despacha notificação pelos canais ativos
 *      em /configuracoes/notificacoes.html (Telegram e/ou Email). Nome da
 *      coluna mantido pra retrocompat; semântica alargada em 2026-05-21.
 *      (skip se já tinha interesse antes — evita re-notificar em re-scans)
 *
 * Nunca lança — log de falha e segue. O scan não deve quebrar por causa
 * de canal offline ou tabela faltando.
 */
async function aplicarAutoAcoes(db, grupo, config, lic, resultado) {
  if (!config.auto_interesse_ativo && !config.auto_telegram_ativo) return;
  if (resultado.produto_compativel !== true) return;
  const score = Number(resultado.viabilidade_score) || 0;
  const scoreMin = Number(config.auto_score_min) || 70;
  if (score < scoreMin) return;

  const pncp = `${lic.cnpj}/${lic.ano}/${lic.sequencial}`;

  // Verifica se já tinha interesse — usado pra evitar re-notificação Telegram
  const jaTinhaInteresse = db.prepare(
    'SELECT 1 FROM interesse WHERE cnpj = ? AND ano = ? AND sequencial = ? LIMIT 1'
  ).get(lic.cnpj, lic.ano, lic.sequencial);

  // forma_disputa_itens decide se é seguro marcar interesse só nos itens
  // flagados. Quando "por_lote"/"global", participar de UM item exige
  // cotar TODOS — então marcar só os flagados pode iludir o usuário.
  // Fase 1: marcamos mesmo assim, mas logamos warning e adicionamos
  // aviso visível no Telegram. Fase 2 (futuro): bloquear / exigir todos
  // do lote compatíveis.
  const formaDisputa = resultado.forma_disputa_itens || 'desconhecido';
  const disputaNaoPorItem = formaDisputa !== 'por_item';

  // 1. Marca interesse SÓ nos itens que a IA flagou como compatíveis.
  // A IA retorna produto_compativel/motivo_compativel por item em itens_destaque
  // (nivel item) + agregado no topo. Aqui usamos o por-item — licitações
  // mistas (poucos itens da empresa + muitos fora) ainda passam no gate
  // licitação-level, mas só os itens flagados viram interesse.
  let itensMarcados = 0;
  let itensFlagados = [];
  if (config.auto_interesse_ativo) {
    try {
      itensFlagados = (resultado.itens_destaque || [])
        .filter(it => it && it.produto_compativel === true)
        .map(it => Number(it.numero))
        .filter(n => Number.isInteger(n) && n > 0);

      if (itensFlagados.length === 0) {
        console.log(`[AnaliseIA-Sched] ${pncp}: licitação compatível mas nenhum item flagado por-item — auto-interesse pulado`);
      } else {
        // Valida que esses numeroItem existem na licitação no DB (IA pode
        // alucinar números fora do range — só marca os que confirmamos).
        let itensValidos;
        if (USE_PG) {
          itensValidos = await catalogPg.query(`
            SELECT "numeroItem" FROM itens
             WHERE "licitacaoId" = (SELECT "id" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3)
               AND "numeroItem" = ANY($4::int[])
          `, [lic.cnpj, Number(lic.ano), Number(lic.sequencial), itensFlagados.map(Number)]);
        } else {
          const placeholders = itensFlagados.map(() => '?').join(',');
          itensValidos = db.prepare(`
            SELECT numeroItem FROM itens
             WHERE licitacaoId = (SELECT id FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?)
               AND numeroItem IN (${placeholders})
          `).all(lic.cnpj, lic.ano, lic.sequencial, ...itensFlagados);
        }

        if (itensValidos.length === 0) {
          console.log(`[AnaliseIA-Sched] ${pncp}: IA flagou itens [${itensFlagados.join(',')}] mas nenhum existe no DB — skip`);
        } else {
          const insert = db.prepare(`
            INSERT OR REPLACE INTO interesse (cnpj, ano, sequencial, numeroItem, grupoId, dataCriacao)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          `);
          const insertKanban = db.prepare(`
            INSERT OR IGNORE INTO kanban_status (cnpj, ano, sequencial, status, dataAtualizacao)
            VALUES (?, ?, ?, 'analise', CURRENT_TIMESTAMP)
          `);
          const tx = db.transaction(() => {
            for (const it of itensValidos) insert.run(lic.cnpj, lic.ano, lic.sequencial, it.numeroItem, grupo.id);
            insertKanban.run(lic.cnpj, lic.ano, lic.sequencial);
          });
          tx();
          itensMarcados = itensValidos.length;
          const avisoDisputa = disputaNaoPorItem
            ? ` ⚠ disputa=${formaDisputa} (verificar se permite ofertar só os itens marcados)`
            : '';
          console.log(`[AnaliseIA-Sched] ${pncp}: auto-interesse em ${itensValidos.length}/${itensFlagados.length} item(ns) flagado(s) [${itensValidos.map(x => x.numeroItem).join(',')}] (grupo ${grupo.nome})${avisoDisputa}`);
        }
      }
    } catch (e) {
      console.error(`[AnaliseIA-Sched] Falha auto-interesse ${pncp}:`, e.message);
    }
  }

  // 2. Notificação — despacha pros canais ativos (Telegram + Email)
  // só se não tinha interesse antes (evita re-notificação em re-scans).
  if (config.auto_telegram_ativo && !jaTinhaInteresse) {
    try {
      let licit;
      if (USE_PG) {
        licit = await catalogPg.queryOne(`
          SELECT "objetoCompra", "razaoSocial", "nomeUnidade", "ufSigla", "valorTotalEstimado", COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") AS "dataEncerramentoProposta", "numeroCompra"
            FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3
        `, [lic.cnpj, Number(lic.ano), Number(lic.sequencial)]);
      } else {
        licit = db.prepare(`
          SELECT objetoCompra, razaoSocial, nomeUnidade, ufSigla, valorTotalEstimado, dataEncerramentoProposta, numeroCompra
            FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ?
        `).get(lic.cnpj, lic.ano, lic.sequencial);
      }

      const obj = (licit?.objetoCompra || '').substring(0, 250);
      const orgao = licit?.razaoSocial || licit?.nomeUnidade || '—';
      const valor = licit?.valorTotalEstimado
        ? `R$ ${Number(licit.valorTotalEstimado).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
        : '—';
      const encerra = licit?.dataEncerramentoProposta
        ? new Date(licit.dataEncerramentoProposta).toLocaleString('pt-BR')
        : '—';
      const segmento = resultado.segmento ? `\n🏷️ <i>${escapeHtml(resultado.segmento)}</i>` : '';
      const motivo = resultado.motivo_compativel ? `\n✅ ${escapeHtml(resultado.motivo_compativel)}` : '';
      const itensCompat = (resultado.itens_destaque || [])
        .filter(it => it && it.produto_compativel === true)
        .map(it => `• Item ${it.numero}: ${escapeHtml(String(it.descricao || '').substring(0, 80))}`)
        .slice(0, 5);
      const itensLinha = itensCompat.length > 0 ? `\n\n📦 <b>Itens compatíveis</b>:\n${itensCompat.join('\n')}` : '';

      // Aviso de forma de disputa: alerta visível quando NÃO é "por item"
      // (porque marcar interesse só nos itens flagados pode iludir o
      // usuário se ele tem que cotar lote/global completo).
      const formaLabel = {
        por_item: '✅ Por item (pode ofertar só o que interessa)',
        por_lote: '⚠️ <b>POR LOTE</b> — exige cotar o lote inteiro, não só o item marcado',
        global: '⚠️ <b>GLOBAL</b> — exige proposta única cobrindo TODOS os itens',
        desconhecido: '❔ Forma de disputa não identificada no edital — confirme manualmente',
      }[formaDisputa] || '';
      const justifDisp = resultado.justificativa_disputa
        ? `\n<i>${escapeHtml(String(resultado.justificativa_disputa).substring(0, 200))}</i>`
        : '';
      const disputaLinha = formaLabel ? `\n\n🗳️ <b>Disputa</b>: ${formaLabel}${justifDisp}` : '';

      const msg = `🤖 <b>Nova oportunidade IA</b> · grupo: ${escapeHtml(grupo.nome)}\n\n` +
                  `<b>${escapeHtml(obj)}</b>${segmento}\n\n` +
                  `🏢 ${escapeHtml(orgao)}\n` +
                  `💰 ${valor}\n` +
                  `⏰ Encerra: ${encerra}\n` +
                  `📊 Score IA: <b>${score}</b>${motivo}${itensLinha}${disputaLinha}\n\n` +
                  `<a href="https://1bit.liciteagora.app/licitacoes/consulta.html">Abrir no LiciteAgora</a>`;

      const subject = `Oportunidade IA · ${grupo.nome}`;
      const r = await enviarAlerta(db, { subject, body: msg, logTag: `AnaliseIA-Sched ${pncp}` });
      if (r?.skipped) {
        console.log(`[AnaliseIA-Sched] ${pncp}: notificação pulada — ${r.motivo}`);
      } else {
        console.log(`[AnaliseIA-Sched] ${pncp}: notificação despachada (score ${score})`);
      }
    } catch (e) {
      console.error(`[AnaliseIA-Sched] Falha notificação ${pncp}:`, e.message);
    }
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

/**
 * Carrega grupo completo (palavras + exclusões vinculadas) para uso no scan.
 * Retorna null se grupo não existe ou está inativo (ativo=0 em grupos_palavras).
 */
function carregarGrupoCompleto(db, grupoId) {
  const grupo = db.prepare('SELECT * FROM grupos_palavras WHERE id = ? AND ativo = 1').get(grupoId);
  if (!grupo) return null;

  grupo.palavras = db.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?').all(grupoId).map(r => r.palavra);

  const vinculos = db.prepare(`
    SELECT g.id, g.nome FROM grupos_pesquisa_exclusao v
      JOIN grupos_palavras g ON g.id = v.grupoExclusaoId AND g.ativo = 1
     WHERE v.grupoPesquisaId = ?
  `).all(grupoId);

  grupo.gruposExclusaoVinculados = vinculos.map(v => ({
    id: v.id,
    nome: v.nome,
    palavras: db.prepare('SELECT palavra FROM grupos_palavras_itens WHERE grupoId = ?').all(v.id).map(r => r.palavra),
  }));

  return grupo;
}

/**
 * Lista grupos com agendamento ativo (ativo=1 em analise_ia_agendamento).
 * Junta config + grupo completo (palavras, exclusões).
 */
function listarGruposAgendados(db) {
  const configs = db.prepare(`
    SELECT a.* FROM analise_ia_agendamento a
      JOIN grupos_palavras g ON g.id = a.grupoId AND g.ativo = 1
     WHERE a.ativo = 1
  `).all();

  const result = [];
  for (const config of configs) {
    const grupo = carregarGrupoCompleto(db, config.grupoId);
    if (grupo) result.push({ grupo, config });
  }
  return result;
}

/**
 * Tick do scheduler: roda 1× por hora. Se hora local atual está em
 * HORAS_ALVO e o último scan de cada grupo foi há mais de MIN_GAP_HORAS,
 * executa scan. Permite múltiplas janelas/dia sem rodar 2x na mesma janela.
 */
async function tick(db, getIAKeys) {
  const agora = new Date();
  if (!HORAS_ALVO.includes(agora.getHours())) return;

  const keys = getIAKeys();
  if (!keys) {
    // Sem chave IA configurada, não faz sentido tentar
    return;
  }

  const agendados = listarGruposAgendados(db);

  for (const { grupo, config } of agendados) {
    // Skip se rodou dentro da janela MIN_GAP_HORAS. SQLite CURRENT_TIMESTAMP
    // é "YYYY-MM-DD HH:MM:SS" UTC — adicionar 'Z' e trocar espaço por 'T'
    // pra parse confiável como UTC (V8 trata o formato com espaço como local).
    if (config.ultimo_scan_em) {
      const last = new Date(config.ultimo_scan_em.replace(' ', 'T') + 'Z');
      const horasDesde = (agora.getTime() - last.getTime()) / (1000 * 60 * 60);
      if (horasDesde < MIN_GAP_HORAS) continue;
    }

    console.log(`[AnaliseIA-Sched] Iniciando scan ${agora.getHours()}h do grupo ${grupo.id} "${grupo.nome}"`);
    await executarScanGrupo(db, grupo, config, keys);
  }
}

/**
 * Inicia scheduler para um tenant. Tick a cada 1h. Idempotente — guarda
 * timer em Map<db, timer> pra não duplicar (se o init é chamado 2x).
 */
const _timers = new Map();

function iniciarSchedulerAnaliseIa(db, getIAKeys) {
  if (_timers.has(db)) return;
  const t = setInterval(() => {
    tick(db, getIAKeys).catch(e => console.error('[AnaliseIA-Sched] tick falhou:', e.message));
  }, TICK_MS);
  _timers.set(db, t);
  console.log(`[AnaliseIA-Sched] Iniciado (tick a cada ${TICK_MS/60000} min, horas alvo ${HORAS_ALVO.join('h e ')}h, gap mínimo ${MIN_GAP_HORAS}h)`);
}

function pararSchedulerAnaliseIa(db) {
  const t = _timers.get(db);
  if (t) {
    clearInterval(t);
    _timers.delete(db);
  }
}

// ==================== Helpers ====================

function parseJsonArray(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s;
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function comTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); })
           .catch(e => { clearTimeout(t); reject(e); });
  });
}

module.exports = {
  iniciarSchedulerAnaliseIa,
  pararSchedulerAnaliseIa,
  executarScanGrupo,
  buscarLicitacoesDoGrupo,
  carregarGrupoCompleto,
  listarGruposAgendados,
};
