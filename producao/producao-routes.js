/**
 * producao-routes.js — Módulo Produção (ordem de produção para manufatura
 * discreta).
 *
 * Serve qualquer fábrica que transforme insumo em item acabado por ordem:
 * ficha técnica com perda, agenda de recurso, apontamento por equipe, ensaio
 * que trava a liberação, pátio, expedição e medição de projeto.
 *
 * O vocabulário e as etapas vêm do PERFIL DE INDÚSTRIA (producao/perfis.js).
 * O perfil `premoldados` é o que originou o módulo e continua completo — mas é
 * uma semente em cima do núcleo, não o núcleo. Ver
 * docs/modulo-premoldados-plano-2026-08-27.md.
 *
 * Feature flag por-tenant em config('producao_enabled'). Quando off,
 * /api/producao/* devolve 403 com error:'producao_disabled' — mesmo
 * contrato dos módulos Ótica, Restaurante, Farmácia, Posto e Locação. O
 * module-gate do plano é uma segunda camada, anterior a esta.
 *
 * Config do módulo mora na tabela `config` com prefixo `pmo_`:
 *   producao_prefixo_ordem                     prefixo do número da OP ('OP')
 *   producao_prefixo_projeto                   prefixo do número da obra ('OBR')
 *   producao_prefixo_romaneio               prefixo do romaneio ('ROM')
 *   producao_custo_hora_padrao              R$/homem-hora para custear apontamento
 *   producao_permitir_liberacao_sem_ensaio  1 = permite bypass da trava de protensão
 *   producao_permitir_recurso_sobreposto      1 = deixa duas OPs na mesma forma
 *   producao_dias_alerta_patio              idade a partir da qual a peça é "parada"
 */

const { logAction } = require('../audit-log');
const { initProducaoSchema } = require('./prod-schema');
// `num` existe aqui por causa de campo "numérico" que chegava cru ao SQLite:
// a afinidade REAL guarda string malformada como TEXT, e a tela a devolvia
// dentro de um atributo HTML. Campo numérico entra como número ou como NULL.
const { gravarConfig, normalizarData, normalizarInstante, num } = require('./prod-util');
const ficha = require('./ficha');
const ordem = require('./ordem');
const apontamento = require('./apontamento');
const qualidade = require('./qualidade');
const produtividade = require('./produtividade');
const projeto = require('./projeto');
const expedicao = require('./expedicao');
const perfis = require('./perfis');

const CONFIG_DEFAULTS = {
  producao_prefixo_ordem: 'OP',
  producao_prefixo_projeto: 'OBR',
  producao_prefixo_romaneio: 'ROM',
  // Vazio = mão de obra não entra no custo da peça, e o painel avisa. Fingir
  // um valor padrão seria pior: o custo pareceria completo sem ser.
  producao_custo_hora_padrao: '0',
  // Nasce em 0 por decisão de projeto: a trava da protensão é o motivo de o
  // controle tecnológico existir. Ver qualidade.js.
  producao_permitir_liberacao_sem_ensaio: '0',
  producao_permitir_recurso_sobreposto: '0',
  producao_dias_alerta_patio: '60',
};

const CONFIG_NUMERICAS = {
  producao_custo_hora_padrao: [0, 10000],
  producao_dias_alerta_patio: [1, 3650],
};
const CONFIG_BOOLEANAS = [
  'producao_permitir_liberacao_sem_ensaio',
  'producao_permitir_recurso_sobreposto',
];
const CONFIG_PREFIXOS = ['producao_prefixo_ordem', 'producao_prefixo_projeto', 'producao_prefixo_romaneio'];

function getFlag(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'producao_enabled'").get();
    return !!(r && r.valor === '1');
  } catch (_) {
    return false;
  }
}

function lerConfig(db) {
  const out = { ...CONFIG_DEFAULTS };
  try {
    const chaves = Object.keys(CONFIG_DEFAULTS);
    const rows = db.prepare(
      `SELECT chave, valor FROM config WHERE chave IN (${chaves.map(() => '?').join(',')})`
    ).all(...chaves);
    for (const r of rows) out[r.chave] = r.valor;
  } catch (_) { /* config ausente — devolve defaults */ }
  return out;
}

function validarConfig(chave, valor) {
  if (!(chave in CONFIG_DEFAULTS)) return `chave desconhecida: ${chave}`;
  if (CONFIG_PREFIXOS.includes(chave)) {
    return /^[A-Z0-9-]{1,10}$/.test(String(valor))
      ? null : 'prefixo deve ter 1..10 caracteres A-Z, 0-9 ou hífen';
  }
  if (CONFIG_BOOLEANAS.includes(chave)) {
    return ['0', '1'].includes(String(valor)) ? null : `${chave} aceita apenas 0 ou 1`;
  }
  const faixa = CONFIG_NUMERICAS[chave];
  if (faixa) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return `${chave} deve ser numérico`;
    if (n < faixa[0] || n > faixa[1]) return `${chave} fora da faixa ${faixa[0]}..${faixa[1]}`;
  }
  return null;
}

function registrarRotasProducao(app, db) {
  initProducaoSchema(db);
  // Módulo sem etapa nenhuma abre com a tela de apontamento morta, o que é
  // indistinguível de módulo quebrado. O seed roda uma vez, por tenant.
  perfis.garantirSeed(db);

  // Em multi-tenant o db acima é o BOOT_STUB e a migração foi no-op. O schema
  // real de cada tenant vem do db-schema.js; este hook cobre o tenant que ainda
  // não passou por um boot completo (mesmo padrão de Ótica/Farmácia/Locação).
  const tenantsMigrados = new WeakSet();
  app.use('/api/producao', (req, res, next) => {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        initProducaoSchema(db);
        perfis.garantirSeed(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Read-only e SEM gate: a sidebar precisa saber se mostra o módulo.
  app.get('/api/producao/status', (req, res) => {
    res.json({ success: true, enabled: getFlag(db) });
  });

  function gateFlag(req, res, next) {
    if (!getFlag(db)) {
      return res.status(403).json({ success: false, error: 'producao_disabled' });
    }
    next();
  }

  const user = req => (req.user && req.user.username) || null;

  // Resposta padrão das funções de domínio: { erro } vira 400, o resto vira 200.
  function responder(res, resultado, status = 200) {
    if (!resultado) return res.status(404).json({ success: false, error: 'não encontrado' });
    if (resultado.erro) return res.status(400).json({ success: false, error: resultado.erro, ...resultado });
    return res.status(status).json({ success: true, ...resultado });
  }

  function wrap(fn) {
    return (req, res) => {
      try {
        fn(req, res);
      } catch (err) {
        res.status(500).json({ success: false, error: err.message });
      }
    };
  }

  // ─── Config ────────────────────────────────────────────────────────────────

  app.get('/api/producao/config', gateFlag, wrap((req, res) => {
    res.json({ success: true, config: lerConfig(db) });
  }));

  app.put('/api/producao/config', gateFlag, wrap((req, res) => {
    const body = req.body || {};
    const chaves = Object.keys(body);
    if (!chaves.length) return res.status(400).json({ success: false, error: 'nada para gravar' });
    for (const c of chaves) {
      const erro = validarConfig(c, body[c]);
      if (erro) return res.status(400).json({ success: false, error: erro });
    }
    for (const c of chaves) gravarConfig(db, c, body[c]);
    try { logAction(db, req, 'atualizar', 'producao_config', null, { chaves }); } catch (_) {}
    res.json({ success: true, config: lerConfig(db) });
  }));

  // ─── F1.1: tipos de peça ───────────────────────────────────────────────────

  app.get('/api/producao/pecas', gateFlag, wrap((req, res) => {
    const { busca, modo, exigeEnsaioLiberacao, ativo } = req.query;
    let sql = `
      SELECT pc.*, p.sku, p.descricao, p.unidade, p.precoVenda, p.precoCusto,
             f.codigo AS recursoPadraoCodigo,
             (SELECT COUNT(*) FROM prod_ficha_itens fi WHERE fi.fichaProdutoId = pc.produtoId) AS itensFicha
        FROM prod_fichas pc
        JOIN produtos p ON p.id = pc.produtoId
        LEFT JOIN prod_recursos f ON f.id = pc.recursoPadraoId
       WHERE 1 = 1`;
    const params = [];
    if (busca) { sql += ' AND (p.descricao LIKE ? OR p.sku LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
    if (modo) { sql += ' AND pc.modo = ?'; params.push(modo); }
    if (exigeEnsaioLiberacao != null && exigeEnsaioLiberacao !== '') {
      sql += ' AND pc.exigeEnsaioLiberacao = ?';
      params.push(Number(exigeEnsaioLiberacao) ? 1 : 0);
    }
    if (ativo != null && ativo !== '') { sql += ' AND pc.ativo = ?'; params.push(Number(ativo) ? 1 : 0); }
    sql += ' ORDER BY p.descricao';
    res.json({ success: true, pecas: db.prepare(sql).all(...params), modos: ficha.MODOS });
  }));

  app.get('/api/producao/pecas/:produtoId', gateFlag, wrap((req, res) => {
    const p = ficha.carregarFicha(db, req.params.produtoId);
    if (!p) return res.status(404).json({ success: false, error: 'tipo de peça não cadastrado' });
    const custo = ficha.custoDaFicha(db, req.params.produtoId);
    res.json({ success: true, ficha: p, ficha: custo.itens, custoUnitario: custo.custoTotal, avisos: custo.avisos });
  }));

  app.put('/api/producao/pecas/:produtoId', gateFlag, wrap((req, res) => {
    const r = ficha.salvarPeca(db, Number(req.params.produtoId), req.body || {});
    if (!r.erro) {
      try { logAction(db, req, 'salvar', 'producao_ficha', req.params.produtoId, req.body); } catch (_) {}
    }
    responder(res, r);
  }));

  // ─── F1.2: ficha técnica ───────────────────────────────────────────────────

  app.get('/api/producao/pecas/:produtoId/ficha', gateFlag, wrap((req, res) => {
    const r = ficha.custoDaFicha(db, Number(req.params.produtoId));
    res.json({ success: true, itens: r.itens, custoUnitario: r.custoTotal, avisos: r.avisos });
  }));

  app.post('/api/producao/pecas/:produtoId/ficha', gateFlag, wrap((req, res) => {
    const pecaId = Number(req.params.produtoId);
    if (!ficha.carregarFicha(db, pecaId)) {
      return res.status(404).json({ success: false, error: 'tipo de peça não cadastrado' });
    }
    const d = req.body || {};
    const erro = ficha.validarItemFicha(db, pecaId, d);
    if (erro) return res.status(400).json({ success: false, error: erro });

    const r = db.prepare(`
      INSERT INTO prod_ficha_itens
        (fichaProdutoId, insumoProdutoId, quantidade, unidade, perdaPercentual, grupo, ordem, observacoes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pecaId, d.insumoProdutoId, Number(d.quantidade), d.unidade || 'KG',
      Number(d.perdaPercentual || 0), d.grupo || 'outro', Number(d.ordem || 0),
      d.observacoes || null);

    const custo = ficha.custoDaFicha(db, pecaId);
    res.status(201).json({ success: true, itemId: r.lastInsertRowid, itens: custo.itens,
      custoUnitario: custo.custoTotal, avisos: custo.avisos });
  }));

  app.put('/api/producao/ficha/:itemId', gateFlag, wrap((req, res) => {
    const item = db.prepare('SELECT * FROM prod_ficha_itens WHERE id = ?').get(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, error: 'item de ficha não encontrado' });
    const d = { ...item, ...(req.body || {}) };
    const erro = ficha.validarItemFicha(db, item.fichaProdutoId, d);
    if (erro) return res.status(400).json({ success: false, error: erro });

    db.prepare(`
      UPDATE prod_ficha_itens
         SET insumoProdutoId = ?, quantidade = ?, unidade = ?, perdaPercentual = ?,
             grupo = ?, ordem = ?, observacoes = ?
       WHERE id = ?
    `).run(d.insumoProdutoId, Number(d.quantidade), d.unidade || 'KG',
      Number(d.perdaPercentual || 0), d.grupo || 'outro', Number(d.ordem || 0),
      d.observacoes || null, item.id);

    const custo = ficha.custoDaFicha(db, item.fichaProdutoId);
    res.json({ success: true, itens: custo.itens, custoUnitario: custo.custoTotal, avisos: custo.avisos });
  }));

  app.delete('/api/producao/ficha/:itemId', gateFlag, wrap((req, res) => {
    const item = db.prepare('SELECT * FROM prod_ficha_itens WHERE id = ?').get(req.params.itemId);
    if (!item) return res.status(404).json({ success: false, error: 'item de ficha não encontrado' });
    db.prepare('DELETE FROM prod_ficha_itens WHERE id = ?').run(item.id);
    const custo = ficha.custoDaFicha(db, item.fichaProdutoId);
    res.json({ success: true, itens: custo.itens, custoUnitario: custo.custoTotal, avisos: custo.avisos });
  }));

  // ─── F1.3: formas e pistas ─────────────────────────────────────────────────

  app.get('/api/producao/formas', gateFlag, wrap((req, res) => {
    const formas = db.prepare(`
      SELECT f.*,
             (SELECT COUNT(*) FROM prod_ordens o WHERE o.formaId = f.id
               AND o.status IN ('planejada','liberada','em_processo','liberada_saida')) AS opsAbertas
        FROM prod_recursos f
       ORDER BY f.codigo
    `).all();
    res.json({ success: true, formas });
  }));

  app.post('/api/producao/formas', gateFlag, wrap((req, res) => {
    const d = req.body || {};
    const codigo = String(d.codigo || '').trim();
    if (!codigo) return res.status(400).json({ success: false, error: 'codigo é obrigatório' });
    if (!String(d.descricao || '').trim()) {
      return res.status(400).json({ success: false, error: 'descricao é obrigatória' });
    }
    if (db.prepare('SELECT id FROM prod_recursos WHERE codigo = ?').get(codigo)) {
      return res.status(400).json({ success: false, error: `já existe forma com o código ${codigo}` });
    }
    const r = db.prepare(`
      INSERT INTO prod_recursos
        (codigo, descricao, tipo, comprimentoUtilM, capacidadePecas, localizacao, ativo, observacoes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(codigo, String(d.descricao).trim(), d.tipo === 'pista' ? 'pista' : 'forma',
      num(d.comprimentoUtilM, { min: 0 }), Number(d.capacidadePecas || 1), d.localizacao || null,
      d.ativo === 0 || d.ativo === '0' ? 0 : 1, d.observacoes || null);
    res.status(201).json({ success: true, forma: db.prepare('SELECT * FROM prod_recursos WHERE id = ?').get(r.lastInsertRowid) });
  }));

  app.put('/api/producao/formas/:id', gateFlag, wrap((req, res) => {
    const f = db.prepare('SELECT * FROM prod_recursos WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ success: false, error: 'forma não encontrada' });
    const d = { ...f, ...(req.body || {}) };
    db.prepare(`
      UPDATE prod_recursos
         SET descricao = ?, tipo = ?, comprimentoUtilM = ?, capacidadePecas = ?,
             localizacao = ?, ativo = ?, observacoes = ?
       WHERE id = ?
    `).run(d.descricao, d.tipo === 'pista' ? 'pista' : 'forma', num(d.comprimentoUtilM, { min: 0 }),
      Number(d.capacidadePecas || 1), d.localizacao || null,
      d.ativo === 0 || d.ativo === '0' ? 0 : 1, d.observacoes || null, f.id);
    res.json({ success: true, forma: db.prepare('SELECT * FROM prod_recursos WHERE id = ?').get(f.id) });
  }));

  /** Agenda da forma: o que a ocupa e quando ela vaga. */
  app.get('/api/producao/formas/:id/agenda', gateFlag, wrap((req, res) => {
    const ops = db.prepare(`
      SELECT o.id, o.numero, o.status, o.dataPlanejada, o.dataInicioProcesso,
             o.dataFimPrevisto, o.dataFim, o.quantidadePlanejada,
             pr.descricao AS produto
        FROM prod_ordens o
        JOIN produtos pr ON pr.id = o.produtoId
       WHERE o.formaId = ? AND o.status IN ('planejada','liberada','em_processo','liberada_saida')
       ORDER BY COALESCE(o.dataInicioProcesso, o.dataPlanejada)
    `).all(req.params.id);
    const bloqueios = db.prepare(
      "SELECT * FROM prod_recurso_bloqueios WHERE formaId = ? AND status = 'ativo' ORDER BY dataInicio"
    ).all(req.params.id);
    res.json({ success: true, ops, bloqueios });
  }));

  app.post('/api/producao/formas/:id/bloqueios', gateFlag, wrap((req, res) => {
    const d = req.body || {};
    const f = db.prepare('SELECT id FROM prod_recursos WHERE id = ?').get(req.params.id);
    if (!f) return res.status(404).json({ success: false, error: 'forma não encontrada' });
    const ini = normalizarInstante(d.dataInicio);
    const fim = normalizarInstante(d.dataFim);
    if (!ini || !fim) return res.status(400).json({ success: false, error: 'dataInicio e dataFim são obrigatórias' });
    if (fim <= ini) return res.status(400).json({ success: false, error: 'dataFim deve ser depois de dataInicio' });
    if (!String(d.motivo || '').trim()) return res.status(400).json({ success: false, error: 'motivo é obrigatório' });

    const r = db.prepare(`
      INSERT INTO prod_recurso_bloqueios (formaId, dataInicio, dataFim, motivo, usuario)
      VALUES (?, ?, ?, ?, ?)
    `).run(f.id, ini, fim, String(d.motivo).trim(), user(req));
    res.status(201).json({ success: true, bloqueioId: r.lastInsertRowid });
  }));

  // ─── F1.4: controle tecnológico ────────────────────────────────────────────

  app.get('/api/producao/lotes', gateFlag, wrap((req, res) => {
    const { de, ate, situacao } = req.query;
    let sql = `
      SELECT l.*,
             (SELECT COUNT(*) FROM prod_ensaios cp WHERE cp.loteId = l.id) AS corposProva,
             (SELECT COUNT(*) FROM prod_ordens o WHERE o.loteId = l.id) AS ops
        FROM prod_lotes l WHERE 1 = 1`;
    const params = [];
    // Normaliza: a coluna é 'YYYY-MM-DD' e um formato divergente do cliente
    // devolveria lista vazia sem erro nenhum.
    const dDe = normalizarData(de), dAte = normalizarData(ate);
    if (dDe) { sql += ' AND l.data >= ?'; params.push(dDe); }
    if (dAte) { sql += ' AND l.data <= ?'; params.push(dAte); }
    if (situacao) { sql += ' AND l.situacao = ?'; params.push(situacao); }
    sql += ' ORDER BY l.data DESC, l.id DESC';
    res.json({ success: true, lotes: db.prepare(sql).all(...params) });
  }));

  app.post('/api/producao/lotes', gateFlag, wrap((req, res) => {
    responder(res, qualidade.criarLote(db, req.body || {}, user(req)), 201);
  }));

  app.get('/api/producao/lotes/:id', gateFlag, wrap((req, res) => {
    const lote = db.prepare('SELECT * FROM prod_lotes WHERE id = ?').get(req.params.id);
    if (!lote) return res.status(404).json({ success: false, error: 'lote não encontrado' });
    res.json({
      success: true, lote,
      corposProva: qualidade.corposDoLote(db, lote.id),
      ops: db.prepare('SELECT id, numero, status FROM prod_ordens WHERE loteId = ?').all(lote.id),
    });
  }));

  app.post('/api/producao/lotes/:id/corpos-prova', gateFlag, wrap((req, res) => {
    responder(res, qualidade.criarCorpoProva(db, Number(req.params.id), req.body || {}, user(req)), 201);
  }));

  app.post('/api/producao/corpos-prova/:id/ruptura', gateFlag, wrap((req, res) => {
    const r = qualidade.registrarRuptura(db, Number(req.params.id), req.body || {}, user(req));
    if (!r.erro) {
      try { logAction(db, req, 'ruptura', 'producao_ensaio', req.params.id, req.body); } catch (_) {}
    }
    responder(res, r);
  }));

  // ─── F1.5: ordens de produção ──────────────────────────────────────────────

  app.get('/api/producao/ordens', gateFlag, wrap((req, res) => {
    const { status, produtoId, projetoId, formaId, de, ate } = req.query;
    let sql = `
      SELECT o.*, pr.descricao AS produtoDescricao, pc.modo, pc.exigeEnsaioLiberacao, pc.exigeIdentificacao,
             f.codigo AS formaCodigo, ob.numero AS projetoNumero,
             l.codigo AS loteCodigo, l.situacao AS loteSituacao
        FROM prod_ordens o
        JOIN produtos pr ON pr.id = o.produtoId
        LEFT JOIN prod_fichas pc ON pc.produtoId = o.produtoId
        LEFT JOIN prod_recursos f ON f.id = o.formaId
        LEFT JOIN prod_projetos ob ON ob.id = o.projetoId
        LEFT JOIN prod_lotes l ON l.id = o.loteId
       WHERE 1 = 1`;
    const params = [];
    if (status) { sql += ' AND o.status = ?'; params.push(status); }
    if (produtoId) { sql += ' AND o.produtoId = ?'; params.push(produtoId); }
    if (projetoId) { sql += ' AND o.projetoId = ?'; params.push(projetoId); }
    if (formaId) { sql += ' AND o.formaId = ?'; params.push(formaId); }
    const dDe = normalizarData(de), dAte = normalizarData(ate);
    if (dDe) { sql += ' AND date(COALESCE(o.dataInicioProcesso, o.dataPlanejada)) >= ?'; params.push(dDe); }
    if (dAte) { sql += ' AND date(COALESCE(o.dataInicioProcesso, o.dataPlanejada)) <= ?'; params.push(dAte); }
    sql += ' ORDER BY COALESCE(o.dataInicioProcesso, o.dataPlanejada) DESC, o.id DESC';
    res.json({ success: true, ops: db.prepare(sql).all(...params), status: ordem.STATUS });
  }));

  app.post('/api/producao/ordens', gateFlag, wrap((req, res) => {
    const r = ordem.criar(db, req.body || {}, user(req), lerConfig(db));
    if (!r.erro) {
      try { logAction(db, req, 'criar', 'prod_ordem', r.ordem.id, { numero: r.ordem.numero }); } catch (_) {}
    }
    responder(res, r, 201);
  }));

  app.get('/api/producao/ordens/:id', gateFlag, wrap((req, res) => {
    const o = ordem.carregar(db, req.params.id);
    if (!o) return res.status(404).json({ success: false, error: 'OP não encontrada' });
    res.json({ success: true, op: o, totaisApontados: apontamento.totaisApontados(db, o.id) });
  }));

  app.post('/api/producao/ordens/:id/liberar', gateFlag, wrap((req, res) => {
    responder(res, ordem.liberar(db, Number(req.params.id), user(req), lerConfig(db)));
  }));

  app.post('/api/producao/ordens/:id/iniciar-processo', gateFlag, wrap((req, res) => {
    const r = ordem.iniciarProcesso(db, Number(req.params.id), req.body || {}, user(req));
    if (!r.erro) {
      try { logAction(db, req, 'iniciar-processo', 'prod_ordem', req.params.id, req.body); } catch (_) {}
    }
    responder(res, r);
  }));

  app.post('/api/producao/ordens/:id/liberar-saida', gateFlag, wrap((req, res) => {
    const r = ordem.liberarSaida(db, Number(req.params.id), req.body || {}, user(req), lerConfig(db));
    if (!r.erro) {
      try { logAction(db, req, 'liberar-saida', 'prod_ordem', req.params.id, req.body); } catch (_) {}
    }
    responder(res, r);
  }));

  app.post('/api/producao/ordens/:id/concluir', gateFlag, wrap((req, res) => {
    const r = ordem.concluir(db, Number(req.params.id), req.body || {}, user(req));
    if (!r.erro) {
      try { logAction(db, req, 'concluir', 'prod_ordem', req.params.id, req.body); } catch (_) {}
    }
    responder(res, r);
  }));

  app.post('/api/producao/ordens/:id/cancelar', gateFlag, wrap((req, res) => {
    const r = ordem.cancelar(db, Number(req.params.id), (req.body || {}).motivo, user(req));
    if (!r.erro) {
      try { logAction(db, req, 'cancelar', 'prod_ordem', req.params.id, req.body); } catch (_) {}
    }
    responder(res, r);
  }));

  /** Custo orçado × realizado da OP. É o número que a fábrica nunca viu. */
  app.get('/api/producao/ordens/:id/custo', gateFlag, wrap((req, res) => {
    const o = ordem.carregar(db, req.params.id);
    if (!o) return res.status(404).json({ success: false, error: 'OP não encontrada' });

    const maoObra = ordem.custoMaoObraDaOp(db, o.id);
    const realizado = o.custoInsumo + maoObra;
    const boas = o.quantidadeProduzida || 0;
    res.json({
      success: true,
      numero: o.numero,
      custoTeorico: o.custoTeorico,
      custoInsumo: o.custoInsumo,
      custoMaoObra: maoObra,
      custoRealizado: realizado,
      quantidadeProduzida: boas,
      quantidadeRefugo: o.quantidadeRefugo,
      custoUnitario: boas > 0 ? realizado / boas : null,
      desvioPercentual: o.custoTeorico > 0
        ? ((realizado - o.custoTeorico) / o.custoTeorico) * 100 : null,
      insumos: o.insumos.map(i => ({
        ...i,
        desvio: i.quantidadeReal != null ? i.quantidadeReal - i.quantidadePrevista : null,
      })),
      avisoCustoHora: ordem.lerCustoHoraPadrao(db) === 0
        ? 'producao_custo_hora_padrao está em 0: a mão de obra não entra no custo da peça'
        : null,
    });
  }));

  // ─── Perfil de indústria, vocabulário e etapas ─────────────────────────────

  // Sem gate de flag: a tela precisa dos rótulos para desenhar o cabeçalho
  // mesmo antes de o módulo ser liberado.
  app.get('/api/producao/vocabulario', wrap((req, res) => {
    res.json({ success: true, vocabulario: perfis.vocabulario(db), enabled: getFlag(db) });
  }));

  app.get('/api/producao/perfis', gateFlag, wrap((req, res) => {
    res.json({
      success: true,
      atual: perfis.perfilAtual(db),
      perfis: Object.entries(perfis.PERFIS).map(([chave, p]) => ({
        chave, nome: p.nome, descricao: p.descricao, etapas: p.etapas.length,
      })),
    });
  }));

  app.post('/api/producao/perfis/:chave', gateFlag, wrap((req, res) => {
    const r = perfis.aplicarPerfil(db, req.params.chave, { usuario: user(req) });
    if (!r.erro) {
      try { logAction(db, req, 'aplicar-perfil', 'producao_perfil', null, { perfil: req.params.chave }); } catch (_) {}
    }
    responder(res, r);
  }));

  app.get('/api/producao/etapas', gateFlag, wrap((req, res) => {
    res.json({ success: true, etapas: perfis.listarEtapas(db) });
  }));

  app.post('/api/producao/etapas', gateFlag, wrap((req, res) => {
    const d = req.body || {};
    const codigo = String(d.codigo || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!codigo) return res.status(400).json({ success: false, error: 'codigo é obrigatório' });
    if (!String(d.nome || '').trim()) {
      return res.status(400).json({ success: false, error: 'nome é obrigatório' });
    }
    if (db.prepare('SELECT id FROM prod_etapas WHERE codigo = ?').get(codigo)) {
      return res.status(400).json({ success: false, error: `já existe etapa com o código ${codigo}` });
    }
    const r = db.prepare(`
      INSERT INTO prod_etapas (codigo, nome, ordem, individual, contaProducao, ativo)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(codigo, String(d.nome).trim(), Number(d.ordem || 0),
      d.individual ? 1 : 0, d.contaProducao ? 1 : 0,
      d.ativo === 0 || d.ativo === '0' ? 0 : 1);
    res.status(201).json({ success: true, etapa: db.prepare('SELECT * FROM prod_etapas WHERE id = ?').get(r.lastInsertRowid) });
  }));

  app.put('/api/producao/etapas/:id', gateFlag, wrap((req, res) => {
    const e = db.prepare('SELECT * FROM prod_etapas WHERE id = ?').get(req.params.id);
    if (!e) return res.status(404).json({ success: false, error: 'etapa não encontrada' });
    const d = { ...e, ...(req.body || {}) };

    // Desativar a última etapa que conta produção deixaria o módulo sem saber
    // quando a unidade fica pronta — e a conclusão passaria a somar zero.
    const desativando = (d.ativo === 0 || d.ativo === '0') && e.ativo === 1;
    const perdendoContagem = e.contaProducao && (desativando || !d.contaProducao);
    if (perdendoContagem) {
      const outras = db.prepare(
        'SELECT COUNT(*) n FROM prod_etapas WHERE contaProducao = 1 AND ativo = 1 AND id <> ?'
      ).get(e.id).n;
      if (outras === 0) {
        return res.status(400).json({ success: false,
          error: 'esta é a única etapa que marca a unidade como pronta: '
            + 'marque outra antes, senão a produção deixa de ser contada' });
      }
    }

    db.prepare(`
      UPDATE prod_etapas SET nome = ?, ordem = ?, individual = ?, contaProducao = ?, ativo = ?
       WHERE id = ?
    `).run(String(d.nome).trim(), Number(d.ordem || 0), d.individual ? 1 : 0,
      d.contaProducao ? 1 : 0, d.ativo === 0 || d.ativo === '0' ? 0 : 1, e.id);
    res.json({ success: true, etapa: db.prepare('SELECT * FROM prod_etapas WHERE id = ?').get(e.id) });
  }));

  app.get('/api/producao/ensaio-tipos', gateFlag, wrap((req, res) => {
    res.json({ success: true, tipos: db.prepare('SELECT * FROM prod_ensaio_tipos ORDER BY id').all() });
  }));

  // ─── F1.6: apontamento e equipes ───────────────────────────────────────────

  app.get('/api/producao/equipes', gateFlag, wrap((req, res) => {
    const equipes = db.prepare(`
      SELECT e.*, f.nome AS encarregadoNome,
             (SELECT COUNT(*) FROM prod_equipe_membros m WHERE m.equipeId = e.id AND m.ativo = 1) AS membros
        FROM prod_equipes e
        LEFT JOIN funcionarios f ON f.id = e.encarregadoFuncionarioId
       ORDER BY e.nome
    `).all();
    res.json({ success: true, equipes, especialidades: apontamento.especialidades(db) });
  }));

  app.post('/api/producao/equipes', gateFlag, wrap((req, res) => {
    responder(res, apontamento.salvarEquipe(db, null, req.body || {}), 201);
  }));

  app.put('/api/producao/equipes/:id', gateFlag, wrap((req, res) => {
    responder(res, apontamento.salvarEquipe(db, Number(req.params.id), req.body || {}));
  }));

  app.get('/api/producao/equipes/:id/membros', gateFlag, wrap((req, res) => {
    res.json({ success: true, membros: apontamento.listarMembros(db, Number(req.params.id)) });
  }));

  app.put('/api/producao/equipes/:id/membros', gateFlag, wrap((req, res) => {
    responder(res, apontamento.definirMembros(db, Number(req.params.id),
      (req.body || {}).funcionarioIds));
  }));

  app.post('/api/producao/ordens/:id/apontamentos', gateFlag, wrap((req, res) => {
    const r = apontamento.criar(db, Number(req.params.id), req.body || {}, user(req));
    if (!r.erro) {
      try { logAction(db, req, 'apontar', 'prod_ordem', req.params.id, req.body); } catch (_) {}
    }
    responder(res, r, 201);
  }));

  app.delete('/api/producao/apontamentos/:id', gateFlag, wrap((req, res) => {
    responder(res, apontamento.remover(db, Number(req.params.id)));
  }));

  app.get('/api/producao/apontamentos', gateFlag, wrap((req, res) => {
    const { de, ate, equipeId, etapa, opId } = req.query;
    let sql = `
      SELECT a.*, e.nome AS equipeNome, f.nome AS funcionarioNome,
             o.numero AS opNumero, pr.descricao AS produtoDescricao
        FROM prod_apontamentos a
        LEFT JOIN prod_equipes e ON e.id = a.equipeId
        LEFT JOIN funcionarios f ON f.id = a.funcionarioId
        JOIN prod_ordens o ON o.id = a.opId
        JOIN produtos pr ON pr.id = o.produtoId
       WHERE 1 = 1`;
    const params = [];
    const dDe = normalizarData(de), dAte = normalizarData(ate);
    if (dDe) { sql += ' AND a.data >= ?'; params.push(dDe); }
    if (dAte) { sql += ' AND a.data <= ?'; params.push(dAte); }
    if (equipeId) { sql += ' AND a.equipeId = ?'; params.push(equipeId); }
    if (etapa) { sql += ' AND a.etapa = ?'; params.push(etapa); }
    if (opId) { sql += ' AND a.opId = ?'; params.push(opId); }
    sql += ' ORDER BY a.data DESC, a.id DESC LIMIT 500';
    res.json({
      success: true,
      apontamentos: db.prepare(sql).all(...params),
      etapas: apontamento.etapasAtivas(db),
    });
  }));

  // ─── F1.9: produtividade ───────────────────────────────────────────────────

  app.get('/api/producao/produtividade/resumo', gateFlag, wrap((req, res) => {
    res.json({ success: true, ...produtividade.resumo(db, req.query) });
  }));

  app.get('/api/producao/produtividade/equipes', gateFlag, wrap((req, res) => {
    res.json({ success: true, ...produtividade.porEquipe(db, req.query) });
  }));

  app.get('/api/producao/produtividade/formas', gateFlag, wrap((req, res) => {
    res.json({ success: true, ...produtividade.porForma(db, req.query) });
  }));

  app.get('/api/producao/produtividade/cura', gateFlag, wrap((req, res) => {
    res.json({ success: true, ...produtividade.aderenciaCura(db, req.query) });
  }));

  app.get('/api/producao/produtividade/individual', gateFlag, wrap((req, res) => {
    res.json({ success: true, ...produtividade.individual(db, req.query) });
  }));

  // ─── F2.1: obras ───────────────────────────────────────────────────────────

  app.get('/api/producao/obras', gateFlag, wrap((req, res) => {
    const { status, clienteId, busca } = req.query;
    let sql = `
      SELECT o.*, COALESCE(p.nomeFantasia, p.razaoSocial) AS clienteNome,
             (SELECT COUNT(*) FROM prod_projeto_itens i WHERE i.projetoId = o.id) AS itens,
             (SELECT COUNT(*) FROM prod_ordens op2 WHERE op2.projetoId = o.id) AS ops
        FROM prod_projetos o
        LEFT JOIN pessoas p ON p.id = o.clienteId
       WHERE 1 = 1`;
    const params = [];
    if (status) { sql += ' AND o.status = ?'; params.push(status); }
    if (clienteId) { sql += ' AND o.clienteId = ?'; params.push(clienteId); }
    if (busca) { sql += ' AND (o.nome LIKE ? OR o.numero LIKE ?)'; params.push(`%${busca}%`, `%${busca}%`); }
    sql += ' ORDER BY o.dataCriacao DESC';
    res.json({ success: true, obras: db.prepare(sql).all(...params), status: projeto.STATUS_OBRA });
  }));

  app.post('/api/producao/obras', gateFlag, wrap((req, res) => {
    responder(res, projeto.criar(db, req.body || {}, user(req), lerConfig(db)), 201);
  }));

  app.get('/api/producao/obras/:id', gateFlag, wrap((req, res) => {
    const o = projeto.carregar(db, req.params.id);
    if (!o) return res.status(404).json({ success: false, error: 'obra não encontrada' });
    res.json({ success: true, obra: o });
  }));

  app.put('/api/producao/obras/:id', gateFlag, wrap((req, res) => {
    responder(res, projeto.atualizar(db, Number(req.params.id), req.body || {}));
  }));

  app.post('/api/producao/obras/:id/status', gateFlag, wrap((req, res) => {
    responder(res, projeto.mudarStatus(db, Number(req.params.id), (req.body || {}).status, user(req)));
  }));

  app.post('/api/producao/obras/:id/itens', gateFlag, wrap((req, res) => {
    responder(res, projeto.salvarItem(db, Number(req.params.id), null, req.body || {}), 201);
  }));

  app.put('/api/producao/obras/:id/itens/:itemId', gateFlag, wrap((req, res) => {
    responder(res, projeto.salvarItem(db, Number(req.params.id), Number(req.params.itemId), req.body || {}));
  }));

  app.delete('/api/producao/obras/:id/itens/:itemId', gateFlag, wrap((req, res) => {
    responder(res, projeto.removerItem(db, Number(req.params.id), Number(req.params.itemId)));
  }));

  app.get('/api/producao/obras/:id/situacao', gateFlag, wrap((req, res) => {
    responder(res, projeto.situacao(db, Number(req.params.id)));
  }));

  // ─── F2.3: medição ─────────────────────────────────────────────────────────

  app.get('/api/producao/obras/:id/medicao-previa', gateFlag, wrap((req, res) => {
    responder(res, projeto.previaMedicao(db, Number(req.params.id)));
  }));

  app.post('/api/producao/obras/:id/medicoes', gateFlag, wrap((req, res) => {
    const r = projeto.gerarMedicao(db, Number(req.params.id), req.body || {}, user(req));
    if (!r.erro) {
      try { logAction(db, req, 'medir', 'producao_projeto', req.params.id, req.body); } catch (_) {}
    }
    responder(res, r, 201);
  }));

  app.get('/api/producao/medicoes/:id', gateFlag, wrap((req, res) => {
    const m = projeto.carregarMedicao(db, Number(req.params.id));
    if (!m) return res.status(404).json({ success: false, error: 'medição não encontrada' });
    res.json({ success: true, medicao: m });
  }));

  app.post('/api/producao/medicoes/:id/cancelar', gateFlag, wrap((req, res) => {
    responder(res, projeto.cancelarMedicao(db, Number(req.params.id), (req.body || {}).motivo, user(req)));
  }));

  // ─── F2.2: pátio e romaneios ───────────────────────────────────────────────

  app.get('/api/producao/patio', gateFlag, wrap((req, res) => {
    const r = expedicao.patio(db, req.query);
    const limite = Number(lerConfig(db).producao_dias_alerta_patio || 60);
    res.json({
      success: true, ...r,
      paradas: r.identificadas.filter(p => (p.diasNoPatio || 0) >= limite),
      diasAlerta: limite,
    });
  }));

  app.put('/api/producao/pecas-produzidas/:id/posicao', gateFlag, wrap((req, res) => {
    responder(res, expedicao.moverPeca(db, Number(req.params.id), req.body || {}));
  }));

  app.get('/api/producao/romaneios', gateFlag, wrap((req, res) => {
    const { status, projetoId } = req.query;
    let sql = `
      SELECT r.*, o.numero AS projetoNumero, o.nome AS projetoNome,
             (SELECT COUNT(*) FROM prod_romaneio_itens i WHERE i.romaneioId = r.id) AS itens
        FROM prod_romaneios r
        LEFT JOIN prod_projetos o ON o.id = r.projetoId
       WHERE 1 = 1`;
    const params = [];
    if (status) { sql += ' AND r.status = ?'; params.push(status); }
    if (projetoId) { sql += ' AND r.projetoId = ?'; params.push(projetoId); }
    sql += ' ORDER BY r.data DESC, r.id DESC';
    res.json({ success: true, romaneios: db.prepare(sql).all(...params), status: expedicao.STATUS_ROMANEIO });
  }));

  app.post('/api/producao/romaneios', gateFlag, wrap((req, res) => {
    responder(res, expedicao.criarRomaneio(db, req.body || {}, user(req), lerConfig(db)), 201);
  }));

  app.get('/api/producao/romaneios/:id', gateFlag, wrap((req, res) => {
    const r = expedicao.carregarRomaneio(db, req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'romaneio não encontrado' });
    res.json({ success: true, romaneio: r });
  }));

  app.post('/api/producao/romaneios/:id/itens', gateFlag, wrap((req, res) => {
    responder(res, expedicao.adicionarItem(db, Number(req.params.id), req.body || {}), 201);
  }));

  app.delete('/api/producao/romaneios/:id/itens/:itemId', gateFlag, wrap((req, res) => {
    responder(res, expedicao.removerItem(db, Number(req.params.id), Number(req.params.itemId)));
  }));

  app.put('/api/producao/romaneios/:id/ordem', gateFlag, wrap((req, res) => {
    responder(res, expedicao.reordenar(db, Number(req.params.id), (req.body || {}).ordem));
  }));

  app.post('/api/producao/romaneios/:id/fechar', gateFlag, wrap((req, res) => {
    const r = expedicao.fecharCarga(db, Number(req.params.id));
    if (!r.erro) {
      try { logAction(db, req, 'fechar-carga', 'prod_romaneio', req.params.id, null); } catch (_) {}
    }
    responder(res, r);
  }));

  app.post('/api/producao/romaneios/:id/status', gateFlag, wrap((req, res) => {
    const body = req.body || {};
    const r = expedicao.mudarStatus(db, Number(req.params.id), body.status, body, user(req));
    if (!r.erro) {
      try { logAction(db, req, 'status', 'prod_romaneio', req.params.id, body); } catch (_) {}
    }
    responder(res, r);
  }));
}

module.exports = {
  registrarRotasProducao,
  CONFIG_DEFAULTS,
  getFlag,
  lerConfig,
  validarConfig,
};
