/**
 * planejamento-routes.js — Item 3.4:
 *  - Provisões: lançamentos previstos manuais que entram no fluxo de caixa projetado;
 *  - Orçamento: previsto × realizado por conta do plano gerencial;
 *  - Metas de vendas: por vendedor × competência, com atingimento.
 *
 * Metas BI (2026-07-31): o atingimento deixou de ser um número só.
 *  - "Realizado" agora é receita reconhecida (entregue + faturado). Antes era
 *    tudo fora de rascunho/cancelado, o que somava pipeline com receita.
 *  - Carteira (confirmado/em_separacao) e funil (orçamentos abertos) saem
 *    separados, então dá para ver se a meta ainda é alcançável.
 *  - Projeção por run-rate em dias úteis: no dia 12 o gestor precisa saber se
 *    VAI bater, não só quanto já fez.
 *  - Margem por vendedor, com cobertura declarada — margem calculada sobre
 *    metade da receita não pode ser apresentada como se fosse a margem toda.
 *  - Conversão e perdas (vendas_perdidas) por vendedor: motivo dominante da
 *    perda é coaching acionável; "atingiu 62%" não é.
 */

const { logAction } = require('./audit-log');

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

// Receita reconhecida × carteira × funil. Rascunho e cancelado ficam fora
// dos dois primeiros; orçamento é contado à parte, nunca como venda.
const STATUS_REALIZADO = ['entregue', 'faturado'];
const STATUS_CARTEIRA = ['confirmado', 'em_separacao'];

const marks = arr => arr.map(() => '?').join(',');

// ==================== CALENDÁRIO DE DIAS ÚTEIS ====================
//
// A projeção por run-rate divide pelo número de dias úteis. Contar só
// seg-sex inflava o denominador em meses com feriado — dezembro e abril
// pareciam ter mais dias de venda do que têm, e a projeção saía baixa.
//
// Feriados nacionais fixos + móveis (derivados da Páscoa). A tabela
// `feriados` cobre o que é municipal ou específico da empresa.

const FERIADOS_FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];

/** Domingo de Páscoa pelo algoritmo de Meeus/Butcher. */
function domingoPascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const iso = d => d.toISOString().slice(0, 10);
function somarDias(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }

/** Feriados nacionais do ano (fixos + móveis), em YYYY-MM-DD. */
function feriadosNacionais(ano) {
  const pascoa = domingoPascoa(ano);
  return new Set([
    ...FERIADOS_FIXOS.map(md => `${ano}-${md}`),
    iso(somarDias(pascoa, -48)),  // segunda de carnaval
    iso(somarDias(pascoa, -47)),  // terça de carnaval
    iso(somarDias(pascoa, -2)),   // sexta-feira santa
    iso(somarDias(pascoa, 60)),   // corpus christi
  ]);
}

/**
 * Feriados aplicáveis ao ano, somando os cadastrados pela empresa.
 * A tabela é opcional: sem ela, valem só os nacionais.
 */
function feriadosDoAno(db, ano) {
  const set = feriadosNacionais(ano);
  try {
    for (const r of db.prepare(
      "SELECT data FROM feriados WHERE ativo = 1 AND substr(data,1,4) = ?").all(String(ano))) {
      set.add(r.data);
    }
  } catch { /* tenant sem a tabela — só nacionais */ }
  return set;
}

/** Dias úteis (seg-sex, fora feriados) no intervalo. */
function diasUteis(inicio, fim, feriados) {
  let n = 0;
  const d = new Date(inicio.getTime());
  while (d <= fim) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6 && !(feriados && feriados.has(iso(d)))) n++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return n;
}

/**
 * Progresso temporal da competência. Para meses passados o mês está
 * fechado (progresso 1) — projetar o passado não faz sentido.
 */
function progressoCompetencia(comp, hojeISO, feriados) {
  const [ano, mes] = comp.split('-').map(Number);
  const primeiro = new Date(Date.UTC(ano, mes - 1, 1));
  const ultimo = new Date(Date.UTC(ano, mes, 0));
  const hoje = new Date(hojeISO + 'T00:00:00Z');

  const uteisTotal = diasUteis(primeiro, ultimo, feriados);
  let corte = hoje;
  if (hoje > ultimo) corte = ultimo;          // competência fechada
  if (hoje < primeiro) corte = null;           // competência futura

  const uteisDecorridos = corte ? diasUteis(primeiro, corte, feriados) : 0;
  return {
    inicio: primeiro.toISOString().slice(0, 10),
    fim: ultimo.toISOString().slice(0, 10),
    uteisTotal,
    uteisDecorridos,
    uteisRestantes: Math.max(0, uteisTotal - uteisDecorridos),
    emAndamento: !!corte && hoje >= primeiro && hoje <= ultimo,
    fechada: hoje > ultimo,
    progresso: uteisTotal > 0 ? Number((uteisDecorridos / uteisTotal).toFixed(4)) : 0,
  };
}

function dataBrasiliaISO() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const round2 = v => Number((Number(v) || 0).toFixed(2));

/**
 * Margem por vendedor na competência, sobre a receita reconhecida.
 *
 * O custo do item não é gravado no pedido, então a fonte é, em ordem:
 *   1) custoMedioPosterior da saída de estoque daquele pedido+produto
 *      (o custo real no momento da venda);
 *   2) custoUnitario da mesma saída;
 *   3) último custoMedioPosterior conhecido do produto;
 *   4) produtos.precoCusto.
 * Item sem nenhuma dessas fontes entra como custo desconhecido e sai da
 * base de margem — daí `cobertura`: margem calculada sobre 40% da receita
 * não pode ser exibida como se fosse a margem inteira.
 */
function margemPorVendedor(db, comp) {
  const itens = db.prepare(`
    SELECT p.vendedorId,
           i.produtoId, i.quantidade, i.valorTotal,
           (SELECT m.custoMedioPosterior FROM movimentacoes_estoque m
             WHERE m.origem = 'pedido' AND m.origemId = p.id AND m.produtoId = i.produtoId
               AND m.tipo = 'saida' AND m.estornada = 0 AND m.custoMedioPosterior IS NOT NULL
             ORDER BY m.id DESC LIMIT 1) AS custoMovMedio,
           (SELECT m.custoUnitario FROM movimentacoes_estoque m
             WHERE m.origem = 'pedido' AND m.origemId = p.id AND m.produtoId = i.produtoId
               AND m.tipo = 'saida' AND m.estornada = 0 AND m.custoUnitario IS NOT NULL
             ORDER BY m.id DESC LIMIT 1) AS custoMovUnit,
           (SELECT m.custoMedioPosterior FROM movimentacoes_estoque m
             WHERE m.produtoId = i.produtoId AND m.custoMedioPosterior IS NOT NULL
             ORDER BY m.data DESC, m.id DESC LIMIT 1) AS custoUltimo,
           pr.precoCusto
    FROM pedidos p
    JOIN pedido_itens i ON i.pedidoId = p.id
    LEFT JOIN produtos pr ON pr.id = i.produtoId
    WHERE p.vendedorId IS NOT NULL
      AND substr(p.dataPedido,1,7) = ?
      AND p.modoDocumento = 'pedido'
      AND p.status IN (${marks(STATUS_REALIZADO)})`).all(comp, ...STATUS_REALIZADO);

  const porVendedor = new Map();
  for (const it of itens) {
    const custoUnit = [it.custoMovMedio, it.custoMovUnit, it.custoUltimo, it.precoCusto]
      .find(v => v != null && Number(v) > 0);
    const acc = porVendedor.get(it.vendedorId)
      || { receitaComCusto: 0, receitaSemCusto: 0, custo: 0, itensSemCusto: 0 };
    const receita = Number(it.valorTotal) || 0;
    if (custoUnit == null) {
      acc.receitaSemCusto += receita;
      acc.itensSemCusto++;
    } else {
      acc.receitaComCusto += receita;
      acc.custo += Number(custoUnit) * (Number(it.quantidade) || 0);
    }
    porVendedor.set(it.vendedorId, acc);
  }

  const out = new Map();
  for (const [vid, a] of porVendedor) {
    const base = a.receitaComCusto;
    const margem = base - a.custo;
    const total = a.receitaComCusto + a.receitaSemCusto;
    out.set(vid, {
      margemValor: round2(margem),
      margemPct: base > 0 ? Number((margem / base * 100).toFixed(1)) : null,
      custoTotal: round2(a.custo),
      receitaComCusto: round2(base),
      itensSemCusto: a.itensSemCusto,
      // 1 = todo o faturamento tem custo conhecido.
      cobertura: total > 0 ? Number((base / total).toFixed(3)) : null,
    });
  }
  return out;
}

/**
 * Perdas do vendedor na competência. O vínculo vem do pedido de origem
 * (vendas_perdidas.pedidoId), então só conta perda rastreada até o pedido —
 * perda avulsa não tem vendedor e fica fora, por construção.
 */
/**
 * Expressão do vendedor da perda. Tenant ainda sem a coluna cai no caminho
 * antigo (só via pedido) em vez de perder o bloco inteiro num catch —
 * antes qualquer erro aqui zerava perdas e conversão sem avisar.
 */
function colunaVendedorPerda(db) {
  try {
    const tem = db.prepare('PRAGMA table_info(vendas_perdidas)').all().some(c => c.name === 'vendedorUserId');
    return tem ? 'COALESCE(vp.vendedorUserId, p.vendedorId)' : 'p.vendedorId';
  } catch { return 'p.vendedorId'; }
}

function perdasPorVendedor(db, comp) {
  const out = new Map();
  let linhas = [];
  const vendedorSQL = colunaVendedorPerda(db);
  try {
    // vendedorUserId (perda avulsa) tem prioridade; senão herda do pedido.
    // Antes só o caminho do pedido existia, e a perda avulsa não entrava
    // na conversão de ninguém.
    linhas = db.prepare(`
      SELECT ${vendedorSQL} AS vendedorId,
             COUNT(*) AS registros,
             COALESCE(SUM(vp.quantidade * COALESCE(vp.precoAlvo,0)),0) AS valor
      FROM vendas_perdidas vp
      LEFT JOIN pedidos p ON p.id = vp.pedidoId
      WHERE ${vendedorSQL} IS NOT NULL
        AND substr(vp.data,1,7) = ?
      GROUP BY ${vendedorSQL}`).all(comp);
  } catch { return out; }   // tenant sem o módulo de vendas perdidas

  const motivos = db.prepare(`
    SELECT ${vendedorSQL} AS vendedorId, vp.motivo, COUNT(*) n,
           COALESCE(SUM(vp.quantidade * COALESCE(vp.precoAlvo,0)),0) valor
    FROM vendas_perdidas vp
    LEFT JOIN pedidos p ON p.id = vp.pedidoId
    WHERE ${vendedorSQL} IS NOT NULL
      AND substr(vp.data,1,7) = ?
    GROUP BY ${vendedorSQL}, vp.motivo`).all(comp);

  const topPorVendedor = new Map();
  for (const m of motivos) {
    const cur = topPorVendedor.get(m.vendedorId);
    if (!cur || m.valor > cur.valor) topPorVendedor.set(m.vendedorId, m);
  }
  for (const l of linhas) {
    const top = topPorVendedor.get(l.vendedorId);
    out.set(l.vendedorId, {
      registros: l.registros,
      valor: round2(l.valor),
      motivoTop: top ? top.motivo : null,
      motivoTopValor: top ? round2(top.valor) : 0,
    });
  }
  return out;
}

function migrarPlanejamentoDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provisoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      descricao TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'saida',
      valor REAL NOT NULL,
      dataPrevista TEXT NOT NULL,
      planoContaId INTEGER,
      status TEXT NOT NULL DEFAULT 'ativa',
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_prov_data ON provisoes(status, dataPrevista);

    CREATE TABLE IF NOT EXISTS orcamento_plano_contas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planoContaId INTEGER NOT NULL,
      competencia TEXT NOT NULL,
      valorPrevisto REAL NOT NULL,
      UNIQUE (planoContaId, competencia)
    );

    CREATE TABLE IF NOT EXISTS metas_vendas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendedorUserId INTEGER NOT NULL,
      competencia TEXT NOT NULL,
      valorMeta REAL NOT NULL,
      UNIQUE (vendedorUserId, competencia)
    );

    -- Meta da empresa/equipe: não é a soma das individuais (nem todo
    -- vendedor tem meta, e a régua da empresa costuma ser outra).
    -- Feriados municipais / recesso da empresa. Os nacionais são
    -- calculados em código (fixos + móveis pela Páscoa) e não ficam aqui.
    CREATE TABLE IF NOT EXISTS feriados (
      data TEXT PRIMARY KEY,
      descricao TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS metas_equipe (
      competencia TEXT PRIMARY KEY,
      valorMeta REAL NOT NULL DEFAULT 0,
      valorMetaMargem REAL,
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Meta de margem por vendedor: bater meta de receita dando desconto
  // destrói margem, e sem esta coluna isso fica invisível.
  alterSafe(db, 'ALTER TABLE metas_vendas ADD COLUMN valorMetaMargem REAL');
  alterSafe(db, 'ALTER TABLE metas_vendas ADD COLUMN metaPedidos INTEGER');
}

const clas = require('./orcamento-classificacao');
const padrao = require('./plano-categorias-padrao');

function registrarRotasPlanejamento(app, db) {
  clas.migrarClassificacaoDB(db);
  // Categorias padrão já ligadas ao plano de contas: sem isso o tenant nasce
  // com o orçamento zerado e precisa montar o de-para na mão.
  try { padrao.aplicarPadrao(db); } catch (e) { console.warn('[orcamento padrao]', e.message); }
  migrarPlanejamentoDB(db);

  // ==================== PROVISÕES ====================

  app.get('/api/provisoes', (req, res) => {
    try {
      const { status, inicio, fim } = req.query;
      let sql = `SELECT p.*, pc.nome AS planoContaNome FROM provisoes p
        LEFT JOIN plano_contas pc ON pc.id = p.planoContaId WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND p.status = ?'; params.push(status); }
      if (inicio) { sql += ' AND p.dataPrevista >= ?'; params.push(inicio); }
      if (fim)    { sql += ' AND p.dataPrevista <= ?'; params.push(fim); }
      sql += ' ORDER BY p.dataPrevista, p.id LIMIT 300';
      res.json({ success: true, provisoes: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/provisoes', (req, res) => {
    try {
      const { descricao, tipo, valor, dataPrevista, planoContaId, observacao, repetirMeses } = req.body || {};
      if (!descricao || !(Number(valor) > 0) || !dataPrevista) {
        return res.status(400).json({ success: false, error: 'descricao, valor > 0 e dataPrevista obrigatórios' });
      }
      const t = tipo === 'entrada' ? 'entrada' : 'saida';
      const n = Math.min(Math.max(Number(repetirMeses) || 1, 1), 60);
      const usuario = req.session?.username || null;
      const ids = [];
      const tx = db.transaction(() => {
        for (let i = 0; i < n; i++) {
          const d = new Date(dataPrevista + 'T12:00:00');
          d.setMonth(d.getMonth() + i);
          const r = db.prepare(`INSERT INTO provisoes (descricao, tipo, valor, dataPrevista, planoContaId, observacao, usuario)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            descricao.trim(), t, Number(valor), d.toISOString().slice(0, 10),
            planoContaId || null, observacao || null, usuario);
          ids.push(r.lastInsertRowid);
        }
      });
      tx();
      logAction(db, req, 'criar', 'provisao', ids[0], { parcelas: n });
      res.json({ success: true, ids });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/provisoes/:id', (req, res) => {
    try {
      const { status, valor, dataPrevista } = req.body || {};
      if (status && !['ativa', 'realizada', 'cancelada'].includes(status)) {
        return res.status(400).json({ success: false, error: 'status: ativa|realizada|cancelada' });
      }
      const r = db.prepare(`UPDATE provisoes SET status = COALESCE(?, status),
        valor = COALESCE(?, valor), dataPrevista = COALESCE(?, dataPrevista) WHERE id = ?`).run(
        status || null, valor != null ? Number(valor) : null, dataPrevista || null, req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Provisão não encontrada' });
      logAction(db, req, 'editar', 'provisao', req.params.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ORÇAMENTO (previsto × realizado) ====================

  // Aplica a herança categoria -> plano de contas no que já existe.
  // O que ainda não tem para onde apontar.
  app.get('/api/orcamento/diagnostico-classificacao', (req, res) => {
    try { res.json({ success: true, ...padrao.diagnostico(db) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Reaplica o padrão. `forcar` remapeia até o que já tem conta — só para
  // desfazer bagunça, e por isso não é o comportamento normal.
  app.post('/api/orcamento/aplicar-padrao', (req, res) => {
    try {
      const r = padrao.aplicarPadrao(db, { forcar: req.body?.forcar === true });
      const cls = clas.classificarPendentes(db);
      res.json({ success: true, ...r, titulosClassificados: (cls.receber || 0) + (cls.pagar || 0) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/orcamento/classificar-pendentes', (req, res) => {
    try { res.json({ success: true, ...clas.classificarPendentes(db) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/orcamento', (req, res) => {
    try {
      const { planoContaId, competencia, valorPrevisto } = req.body || {};
      if (!planoContaId || !/^\d{4}-\d{2}$/.test(competencia || '') || valorPrevisto == null) {
        return res.status(400).json({ success: false, error: 'planoContaId, competencia (YYYY-MM) e valorPrevisto obrigatórios' });
      }
      db.prepare(`INSERT INTO orcamento_plano_contas (planoContaId, competencia, valorPrevisto)
        VALUES (?, ?, ?)
        ON CONFLICT(planoContaId, competencia) DO UPDATE SET valorPrevisto = excluded.valorPrevisto`)
        .run(Number(planoContaId), competencia, Number(valorPrevisto));
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Previsto × realizado do ano: realizado = pagamentos efetivos (CR entra, CP sai)
  // agregados pela conta do plano gerencial do título, competência = mês do pagamento.
  app.get('/api/orcamento/previsto-realizado', (req, res) => {
    try {
      const ano = String(req.query.ano || new Date().getFullYear());
      if (!/^\d{4}$/.test(ano)) return res.status(400).json({ success: false, error: 'ano YYYY' });

      const previsto = db.prepare(`SELECT o.planoContaId, o.competencia, o.valorPrevisto,
          pc.codigo, pc.nome, pc.tipo
        FROM orcamento_plano_contas o JOIN plano_contas pc ON pc.id = o.planoContaId
        WHERE o.competencia LIKE ?`).all(ano + '-%');

      const realizadoCR = db.prepare(`SELECT c.planoContaId, substr(p.dataPagamento,1,7) AS competencia,
          SUM(p.valorPago) AS valor
        FROM contas_receber_pagamentos p JOIN contas_a_receber c ON c.id = p.contaReceberId
        WHERE p.estornado = 0 AND c.planoContaId IS NOT NULL AND p.dataPagamento LIKE ?
        GROUP BY c.planoContaId, competencia`).all(ano + '-%');
      const realizadoCP = db.prepare(`SELECT c.planoContaId, substr(p.dataPagamento,1,7) AS competencia,
          SUM(p.valorPago) AS valor
        FROM contas_pagar_pagamentos p JOIN contas_a_pagar c ON c.id = p.contaPagarId
        WHERE p.estornado = 0 AND c.planoContaId IS NOT NULL AND p.dataPagamento LIKE ?
        GROUP BY c.planoContaId, competencia`).all(ano + '-%');

      const chave = (pcId, comp) => pcId + ':' + comp;
      const mapa = new Map();
      for (const p of previsto) {
        mapa.set(chave(p.planoContaId, p.competencia), {
          planoContaId: p.planoContaId, codigo: p.codigo, nome: p.nome, tipo: p.tipo,
          competencia: p.competencia, previsto: p.valorPrevisto, realizado: 0
        });
      }
      const acumula = (rows) => {
        for (const r of rows) {
          const k = chave(r.planoContaId, r.competencia);
          if (!mapa.has(k)) {
            const pc = db.prepare('SELECT codigo, nome, tipo FROM plano_contas WHERE id = ?').get(r.planoContaId) || {};
            mapa.set(k, { planoContaId: r.planoContaId, codigo: pc.codigo, nome: pc.nome, tipo: pc.tipo,
              competencia: r.competencia, previsto: 0, realizado: 0 });
          }
          mapa.get(k).realizado += r.valor;
        }
      };
      acumula(realizadoCR); acumula(realizadoCP);

      // O que ainda vai acontecer: título aberto no período já é compromisso.
      // Orçamento que só olha o pago descobre o estouro depois dele.
      for (const r of clas.aRealizar(db, ano)) {
        const k = chave(r.planoContaId, r.competencia);
        if (!mapa.has(k)) {
          const pc = db.prepare('SELECT codigo, nome, tipo FROM plano_contas WHERE id = ?').get(r.planoContaId) || {};
          mapa.set(k, { planoContaId: r.planoContaId, codigo: pc.codigo, nome: pc.nome, tipo: pc.tipo,
            competencia: r.competencia, previsto: 0, realizado: 0 });
        }
        const l = mapa.get(k);
        l.aRealizar = Number(((l.aRealizar || 0) + r.valor).toFixed(2));
      }

      const linhas = [...mapa.values()].map(l => ({
        ...l, realizado: Number(l.realizado.toFixed(2)),
        aRealizar: Number((l.aRealizar || 0).toFixed(2)),
        projetado: Number((l.realizado + (l.aRealizar || 0)).toFixed(2)),
        desvio: Number((l.realizado - l.previsto).toFixed(2))
      })).sort((a, b) => (a.codigo || '').localeCompare(b.codigo || '') || a.competencia.localeCompare(b.competencia));

      // Sem isto o relatório mente por omissão: mostra realizado zerado para
      // quem movimentou o ano inteiro sem classificar nada.
      const fora = clas.semClassificacao(db, ano);
      const foraTotal = Number((fora.receber.valorPago + fora.pagar.valorPago).toFixed(2));

      res.json({ success: true, ano, linhas,
        semClassificacao: { ...fora, valorPagoTotal: foraTotal },
        cobertura: (() => {
          const dentro = linhas.reduce((t, l) => t + l.realizado, 0);
          const tudo = dentro + foraTotal;
          return { classificado: Number(dentro.toFixed(2)), naoClassificado: foraTotal,
                   percentual: tudo > 0 ? Number((dentro / tudo * 100).toFixed(1)) : null };
        })(),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== METAS DE VENDAS ====================

  app.post('/api/metas', (req, res) => {
    try {
      const { vendedorUserId, competencia, valorMeta, valorMetaMargem, metaPedidos } = req.body || {};
      if (!vendedorUserId || !/^\d{4}-\d{2}$/.test(competencia || '') || !(Number(valorMeta) >= 0)) {
        return res.status(400).json({ success: false, error: 'vendedorUserId, competencia (YYYY-MM) e valorMeta obrigatórios' });
      }
      db.prepare(`INSERT INTO metas_vendas (vendedorUserId, competencia, valorMeta, valorMetaMargem, metaPedidos)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(vendedorUserId, competencia) DO UPDATE SET
          valorMeta = excluded.valorMeta,
          valorMetaMargem = excluded.valorMetaMargem,
          metaPedidos = excluded.metaPedidos`)
        .run(Number(vendedorUserId), competencia, Number(valorMeta),
          valorMetaMargem != null && valorMetaMargem !== '' ? Number(valorMetaMargem) : null,
          metaPedidos != null && metaPedidos !== '' ? Number(metaPedidos) : null);
      logAction(db, req, 'salvar', 'meta-vendas', Number(vendedorUserId), { competencia, valorMeta });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Feriados: nacionais calculados + os cadastrados pela empresa.
  app.get('/api/feriados', (req, res) => {
    try {
      const ano = Number(req.query.ano) || Number(dataBrasiliaISO().slice(0, 4));
      const nacionais = [...feriadosNacionais(ano)].sort();
      let empresa = [];
      try { empresa = db.prepare("SELECT * FROM feriados WHERE substr(data,1,4) = ? ORDER BY data").all(String(ano)); }
      catch { /* tabela nova */ }
      res.json({ success: true, ano, nacionais, empresa });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/feriados', (req, res) => {
    try {
      const { data, descricao, ativo } = req.body || {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) {
        return res.status(400).json({ success: false, error: 'data no formato YYYY-MM-DD obrigatória' });
      }
      db.prepare(`INSERT INTO feriados (data, descricao, ativo) VALUES (?, ?, ?)
        ON CONFLICT(data) DO UPDATE SET descricao = excluded.descricao, ativo = excluded.ativo`)
        .run(data, (descricao || '').trim() || null, ativo === 0 ? 0 : 1);
      logAction(db, req, 'salvar', 'feriado', data, { descricao });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/feriados/:data', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM feriados WHERE data = ?').run(req.params.data);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Feriado não encontrado' });
      logAction(db, req, 'excluir', 'feriado', req.params.data, {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/metas/equipe', (req, res) => {
    try {
      const { competencia, valorMeta, valorMetaMargem, observacao } = req.body || {};
      if (!/^\d{4}-\d{2}$/.test(competencia || '') || !(Number(valorMeta) >= 0)) {
        return res.status(400).json({ success: false, error: 'competencia (YYYY-MM) e valorMeta obrigatórios' });
      }
      db.prepare(`INSERT INTO metas_equipe (competencia, valorMeta, valorMetaMargem, observacao, dataAtualizacao)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(competencia) DO UPDATE SET
          valorMeta = excluded.valorMeta,
          valorMetaMargem = excluded.valorMetaMargem,
          observacao = excluded.observacao,
          dataAtualizacao = CURRENT_TIMESTAMP`)
        .run(competencia, Number(valorMeta),
          valorMetaMargem != null && valorMetaMargem !== '' ? Number(valorMetaMargem) : null,
          (observacao || '').trim() || null);
      logAction(db, req, 'salvar', 'meta-equipe', competencia, { valorMeta });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Atingimento com projeção, estágios, margem e perdas.
   *
   * "Realizado" = entregue + faturado (receita reconhecida). A definição
   * anterior era `status NOT IN ('rascunho','cancelado')`, que somava
   * pedido confirmado — pipeline — dentro da receita.
   */
  app.get('/api/metas/atingimento', (req, res) => {
    try {
      const comp = req.query.competencia;
      if (!/^\d{4}-\d{2}$/.test(comp || '')) return res.status(400).json({ success: false, error: 'competencia YYYY-MM' });

      const feriados = feriadosDoAno(db, Number(comp.slice(0, 4)));
      const tempo = progressoCompetencia(comp, dataBrasiliaISO(), feriados);
      // Quantos feriados caíram em dia útil nesta competência — explica
      // por que o denominador da projeção mudou.
      tempo.feriadosNoMes = [...feriados].filter(f => f.slice(0, 7) === comp
        && ![0, 6].includes(new Date(f + 'T00:00:00Z').getUTCDay())).sort();
      const vendedores = db.prepare('SELECT id, username, nome FROM users WHERE ativo = 1').all();
      const metas = new Map(db.prepare('SELECT * FROM metas_vendas WHERE competencia = ?').all(comp)
        .map(m => [m.vendedorUserId, m]));
      const metaEquipe = db.prepare('SELECT * FROM metas_equipe WHERE competencia = ?').get(comp) || null;

      // Receita reconhecida + contagens, por vendedor.
      const realizados = new Map(db.prepare(`
        SELECT vendedorId,
               COALESCE(SUM(valorTotal),0) valor,
               COUNT(*) pedidos,
               COUNT(DISTINCT clienteId) clientes
        FROM pedidos
        WHERE vendedorId IS NOT NULL AND substr(dataPedido,1,7) = ?
          AND modoDocumento = 'pedido' AND status IN (${marks(STATUS_REALIZADO)})
        GROUP BY vendedorId`).all(comp, ...STATUS_REALIZADO).map(r => [r.vendedorId, r]));

      // Carteira: já é venda fechada, ainda não entregue.
      const carteiras = new Map(db.prepare(`
        SELECT vendedorId, COALESCE(SUM(valorTotal),0) valor, COUNT(*) pedidos
        FROM pedidos
        WHERE vendedorId IS NOT NULL AND substr(dataPedido,1,7) = ?
          AND modoDocumento = 'pedido' AND status IN (${marks(STATUS_CARTEIRA)})
        GROUP BY vendedorId`).all(comp, ...STATUS_CARTEIRA).map(r => [r.vendedorId, r]));

      // Funil: orçamento vivo (nem cancelado, nem já convertido em pedido).
      const funis = new Map(db.prepare(`
        SELECT vendedorId, COALESCE(SUM(valorTotal),0) valor, COUNT(*) pedidos
        FROM pedidos
        WHERE vendedorId IS NOT NULL AND substr(dataPedido,1,7) = ?
          AND modoDocumento = 'orcamento' AND status NOT IN ('cancelado')
        GROUP BY vendedorId`).all(comp).map(r => [r.vendedorId, r]));

      // Devoluções efetivadas na competência, atribuídas ao vendedor do
      // pedido de origem. Descontam do realizado: venda desfeita não é
      // venda. A competência é a da EFETIVAÇÃO, não a da venda — reescrever
      // um mês já fechado mudaria a meta de quem já foi avaliado.
      let devolucoes = new Map();
      try {
        devolucoes = new Map(db.prepare(`
          SELECT p.vendedorId, COALESCE(SUM(d.valorTotal),0) valor, COUNT(*) qtd
          FROM devolucoes d
          JOIN pedidos p ON p.id = d.pedidoId
          WHERE d.status = 'efetivada' AND p.vendedorId IS NOT NULL
            AND substr(d.dataEfetivacao,1,7) = ?
          GROUP BY p.vendedorId`).all(comp).map(r => [r.vendedorId, r]));
      } catch { /* tenant sem o módulo de devoluções */ }

      const margens = margemPorVendedor(db, comp);
      const perdas = perdasPorVendedor(db, comp);

      const linhas = vendedores.map(v => {
        const m = metas.get(v.id) || {};
        const meta = m.valorMeta || 0;
        const metaMargem = m.valorMetaMargem != null ? m.valorMetaMargem : null;
        const r = realizados.get(v.id) || { valor: 0, pedidos: 0, clientes: 0 };
        const c = carteiras.get(v.id) || { valor: 0, pedidos: 0 };
        const f = funis.get(v.id) || { valor: 0, pedidos: 0 };
        const dv = devolucoes.get(v.id) || { valor: 0, qtd: 0 };
        const realizadoBruto = round2(r.valor);
        const devolvido = round2(dv.valor);
        // O que conta para a meta é o líquido.
        const realizado = round2(realizadoBruto - devolvido);
        const carteira = round2(c.valor);
        const funil = round2(f.valor);

        // Run-rate: extrapola o ritmo dos dias úteis já decorridos. Mês
        // fechado não se projeta — a projeção é o próprio realizado.
        const projecao = tempo.emAndamento && tempo.uteisDecorridos > 0
          ? round2(realizado / tempo.uteisDecorridos * tempo.uteisTotal)
          : realizado;
        // O que já está contratado e ainda pode entrar até o fim do mês.
        const projecaoComCarteira = round2(projecao + carteira);

        const atingimento = meta > 0 ? Number((realizado / meta * 100).toFixed(1)) : null;
        const projecaoPct = meta > 0 ? Number((projecao / meta * 100).toFixed(1)) : null;

        // Semáforo pela tendência, não pelo % de hoje: 40% no dia 10 é
        // saudável, 40% no dia 28 não é.
        let tendencia = null;
        if (meta > 0) {
          if (!tempo.emAndamento) tendencia = atingimento >= 100 ? 'batida' : 'nao_batida';
          else if (projecaoPct >= 100) tendencia = 'no_ritmo';
          else if (projecaoComCarteira >= meta) tendencia = 'depende_carteira';
          else if (projecaoPct >= 80) tendencia = 'risco';
          else tendencia = 'abaixo';
        }

        const mg = margens.get(v.id) || null;
        const pd = perdas.get(v.id) || null;
        // Conversão em valor: ganho ÷ (ganho + perdido) no mês.
        const conversao = pd && (realizado + pd.valor) > 0
          ? Number((realizado / (realizado + pd.valor) * 100).toFixed(1)) : null;

        return {
          vendedorUserId: v.id, vendedor: v.nome || v.username, competencia: comp,
          meta, metaMargem, metaPedidos: m.metaPedidos != null ? m.metaPedidos : null,
          semMeta: !(meta > 0),
          realizado, realizadoBruto, devolvido, devolucoes: dv.qtd,
          carteira, funil,
          pedidos: r.pedidos, pedidosCarteira: c.pedidos, pedidosFunil: f.pedidos,
          clientes: r.clientes,
          ticketMedio: r.pedidos > 0 ? round2(realizado / r.pedidos) : null,
          atingimento, projecao, projecaoPct, projecaoComCarteira, tendencia,
          margemValor: mg ? mg.margemValor : null,
          margemPct: mg ? mg.margemPct : null,
          margemCobertura: mg ? mg.cobertura : null,
          margemItensSemCusto: mg ? mg.itensSemCusto : 0,
          atingimentoMargem: mg && metaMargem > 0
            ? Number((mg.margemValor / metaMargem * 100).toFixed(1)) : null,
          perdaValor: pd ? pd.valor : 0,
          perdaRegistros: pd ? pd.registros : 0,
          perdaMotivoTop: pd ? pd.motivoTop : null,
          conversaoPct: conversao,
        };
      })
      // devolvido entra no filtro: vendedor que só teve devolução no mês
      // fica com realizado <= 0 e sumiria do painel justamente na hora em
      // que o gestor precisa vê-lo.
      .filter(l => l.meta > 0 || l.realizado > 0 || l.carteira > 0 || l.funil > 0 || l.devolvido > 0)
      .sort((a, b) => b.realizado - a.realizado);

      linhas.forEach((l, i) => { l.posicao = i + 1; });

      // Pedidos sem vendedor: até 2026-07-31 nenhum caminho gravava
      // vendedorId, então o histórico fica de fora do rateio. Melhor
      // dizer isso na cara do que exibir meta zerada sem explicação.
      const semVendedor = db.prepare(`
        SELECT COUNT(*) pedidos, COALESCE(SUM(valorTotal),0) valor
        FROM pedidos
        WHERE vendedorId IS NULL AND substr(dataPedido,1,7) = ?
          AND modoDocumento = 'pedido' AND status IN (${marks(STATUS_REALIZADO)})`)
        .get(comp, ...STATUS_REALIZADO);

      const soma = (campo) => round2(linhas.reduce((s, l) => s + (l[campo] || 0), 0));
      const realizadoEquipe = soma('realizado');
      const metaEquipeValor = metaEquipe ? metaEquipe.valorMeta : soma('meta');
      const projecaoEquipe = tempo.emAndamento && tempo.uteisDecorridos > 0
        ? round2(realizadoEquipe / tempo.uteisDecorridos * tempo.uteisTotal)
        : realizadoEquipe;
      const margemEquipe = soma('margemValor');

      res.json({
        success: true, competencia: comp, tempo,
        equipe: {
          meta: metaEquipeValor,
          metaDefinida: !!metaEquipe,
          metaSomaIndividuais: soma('meta'),
          metaMargem: metaEquipe ? metaEquipe.valorMetaMargem : null,
          observacao: metaEquipe ? metaEquipe.observacao : null,
          realizado: realizadoEquipe,
          carteira: soma('carteira'),
          funil: soma('funil'),
          realizadoBruto: soma('realizadoBruto'),
          devolvido: soma('devolvido'),
          margemValor: margemEquipe,
          margemPct: realizadoEquipe > 0 ? Number((margemEquipe / realizadoEquipe * 100).toFixed(1)) : null,
          perdaValor: soma('perdaValor'),
          pedidos: linhas.reduce((s, l) => s + l.pedidos, 0),
          atingimento: metaEquipeValor > 0 ? Number((realizadoEquipe / metaEquipeValor * 100).toFixed(1)) : null,
          projecao: projecaoEquipe,
          projecaoPct: metaEquipeValor > 0 ? Number((projecaoEquipe / metaEquipeValor * 100).toFixed(1)) : null,
          vendedoresSemMeta: linhas.filter(l => l.semMeta).length,
        },
        semVendedor: { pedidos: semVendedor.pedidos, valor: round2(semVendedor.valor) },
        linhas,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Série histórica para tendência e comparação ano a ano.
   * GET /api/metas/historico?meses=12[&vendedorUserId=N]
   */
  app.get('/api/metas/historico', (req, res) => {
    try {
      const meses = Math.min(36, Math.max(3, Number(req.query.meses) || 12));
      const vendedorUserId = req.query.vendedorUserId ? Number(req.query.vendedorUserId) : null;
      const fim = req.query.ate && /^\d{4}-\d{2}$/.test(req.query.ate)
        ? req.query.ate : dataBrasiliaISO().slice(0, 7);

      const comps = [];
      const [ano, mes] = fim.split('-').map(Number);
      for (let i = meses - 1; i >= 0; i--) {
        const d = new Date(Date.UTC(ano, mes - 1 - i, 1));
        comps.push(d.toISOString().slice(0, 7));
      }

      const filtro = vendedorUserId ? ' AND vendedorId = ?' : ' AND vendedorId IS NOT NULL';
      const par = vendedorUserId ? [vendedorUserId] : [];

      const vendas = new Map(db.prepare(`
        SELECT substr(dataPedido,1,7) comp, COALESCE(SUM(valorTotal),0) valor, COUNT(*) pedidos
        FROM pedidos
        WHERE modoDocumento = 'pedido' AND status IN (${marks(STATUS_REALIZADO)})
          AND substr(dataPedido,1,7) >= ? AND substr(dataPedido,1,7) <= ?${filtro}
        GROUP BY comp`).all(...STATUS_REALIZADO, comps[0], comps[comps.length - 1], ...par)
        .map(r => [r.comp, r]));

      const metasSql = vendedorUserId
        ? 'SELECT competencia comp, SUM(valorMeta) meta FROM metas_vendas WHERE vendedorUserId = ? GROUP BY competencia'
        : 'SELECT competencia comp, SUM(valorMeta) meta FROM metas_vendas GROUP BY competencia';
      const metas = new Map(db.prepare(metasSql).all(...par).map(r => [r.comp, r.meta]));

      // Mesma regra do atingimento: a série mostra o líquido de devoluções.
      let devolucoesHist = new Map();
      try {
        devolucoesHist = new Map(db.prepare(`
          SELECT substr(d.dataEfetivacao,1,7) comp, COALESCE(SUM(d.valorTotal),0) valor
          FROM devolucoes d
          JOIN pedidos p ON p.id = d.pedidoId
          WHERE d.status = 'efetivada'
            AND substr(d.dataEfetivacao,1,7) >= ? AND substr(d.dataEfetivacao,1,7) <= ?
            ${vendedorUserId ? 'AND p.vendedorId = ?' : 'AND p.vendedorId IS NOT NULL'}
          GROUP BY comp`).all(comps[0], comps[comps.length - 1], ...par).map(r => [r.comp, r.valor]));
      } catch { /* tenant sem devoluções */ }

      let perdas = new Map();
      try {
        perdas = new Map(db.prepare(`
          SELECT substr(vp.data,1,7) comp, COALESCE(SUM(vp.quantidade * COALESCE(vp.precoAlvo,0)),0) valor
          FROM vendas_perdidas vp
          LEFT JOIN pedidos p ON p.id = vp.pedidoId
          WHERE substr(vp.data,1,7) >= ? AND substr(vp.data,1,7) <= ?
            ${vendedorUserId ? `AND ${colunaVendedorPerda(db)} = ?` : ''}
          GROUP BY comp`).all(comps[0], comps[comps.length - 1], ...par).map(r => [r.comp, r.valor]));
      } catch { /* tenant sem vendas perdidas */ }

      const serie = comps.map(c => {
        const v = vendas.get(c) || { valor: 0, pedidos: 0 };
        const meta = metas.get(c) || 0;
        // Mesma competência do ano anterior, para leitura de sazonalidade.
        const [a, m] = c.split('-').map(Number);
        const anoAnterior = `${a - 1}-${String(m).padStart(2, '0')}`;
        const va = vendas.get(anoAnterior);
        const devolvido = round2(devolucoesHist.get(c) || 0);
        const realizado = round2(v.valor - devolvido);
        return {
          competencia: c, realizado, realizadoBruto: round2(v.valor), devolvido,
          pedidos: v.pedidos, meta: round2(meta),
          atingimento: meta > 0 ? Number((realizado / meta * 100).toFixed(1)) : null,
          ticketMedio: v.pedidos > 0 ? round2(realizado / v.pedidos) : null,
          perdaValor: round2(perdas.get(c) || 0),
          realizadoAnoAnterior: va ? round2(va.valor) : null,
          variacaoAnualPct: va && va.valor > 0
            ? Number(((realizado - va.valor) / va.valor * 100).toFixed(1)) : null,
        };
      });

      const comValor = serie.filter(s => s.realizado > 0);
      res.json({
        success: true, serie,
        resumo: {
          mediaMensal: comValor.length ? round2(comValor.reduce((s, x) => s + x.realizado, 0) / comValor.length) : 0,
          melhorMes: comValor.length ? comValor.reduce((a, b) => b.realizado > a.realizado ? b : a) : null,
          totalPeriodo: round2(serie.reduce((s, x) => s + x.realizado, 0)),
          totalPerdido: round2(serie.reduce((s, x) => s + x.perdaValor, 0)),
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasPlanejamento, migrarPlanejamentoDB };
