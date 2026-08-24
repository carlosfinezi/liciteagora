/**
 * contas-financeiras-routes.js — Contas Financeiras (caixa/banco) + movimentações + extrato.
 *
 * Expõe também helpers:
 *   - lancarMovimentacao(db, { contaId, tipo, valor, data, descricao, origem, origemId, categoria, usuario })
 *   - getContaPadrao(db, tipoPadrao)  // 'caixa' | 'banco'
 *   - getContaMercadoPago(db)         // conta específica ou bancoPadrao
 *
 * Uso:
 *   const { registrarRotasContasFinanceiras } = require('./contas-financeiras-routes');
 *   registrarRotasContasFinanceiras(app, db);
 */

const { escopoUsuario, escopoSql, noEscopo } = require('./estabelecimentos-routes');

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ja existe */ } }

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contas_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      banco TEXT,
      agencia TEXT,
      conta TEXT,
      saldoInicial REAL DEFAULT 0,
      ehCaixaPadrao INTEGER DEFAULT 0,
      ehBancoPadrao INTEGER DEFAULT 0,
      observacoes TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS movimentacoes_financeiras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      data TEXT NOT NULL,
      descricao TEXT NOT NULL,
      origem TEXT,
      origemId INTEGER,
      contraContaId INTEGER,
      categoria TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaId) REFERENCES contas_financeiras(id)
    );
    CREATE INDEX IF NOT EXISTS idx_movf_conta ON movimentacoes_financeiras(contaId);
    CREATE INDEX IF NOT EXISTS idx_movf_data ON movimentacoes_financeiras(data);
    CREATE INDEX IF NOT EXISTS idx_movf_origem ON movimentacoes_financeiras(origem, origemId);
  `);
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN contaFinanceiraId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN origem TEXT');
  // Multi-loja (Fase 4): dimensão de estabelecimento (NULL = consolidado/matriz).
  alterSafe(db, 'ALTER TABLE contas_financeiras ADD COLUMN estabelecimentoId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_receber ADD COLUMN estabelecimentoId INTEGER');
  alterSafe(db, 'ALTER TABLE contas_a_pagar ADD COLUMN estabelecimentoId INTEGER');
}

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function round2(v) { return Math.round(Number(v) * 100) / 100; }

function fmtBRL(v) {
  return (v == null || isNaN(v)) ? '0,00' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function limpa(s) { return String(s == null ? '' : s).replace(/[;\r\n]+/g, ' ').trim(); }

function parseIdsCsv(raw) {
  if (!raw) return null;
  const ids = String(raw).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
}

// RBAC de estabelecimento no financeiro — a regra mora em estabelecimentos-routes.
// Aqui é só o teto das contas: o filtro de unidade que o usuário escolhe na tela
// pode apertar, nunca alargar.
function escopoContas(req) { return escopoSql(req); }
function contaNoEscopo(req, conta) { return noEscopo(req, conta.estabelecimentoId); }

// Filtro de empresa/filial. 'sem-vinculo' isola as contas que não pertencem a
// nenhuma unidade (NULL = consolidado/matriz); vazio não filtra nada.
function filtroEstabelecimento(raw) {
  if (raw === 'sem-vinculo') return { sql: ' AND estabelecimentoId IS NULL', params: [] };
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return { sql: ' AND estabelecimentoId = ?', params: [id] };
  return { sql: '', params: [] };
}

function parseCsvSet(raw) {
  if (!raw) return null;
  const vals = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return vals.length ? new Set(vals) : null;
}

function saldoConta(db, contaId) {
  const c = db.prepare('SELECT saldoInicial FROM contas_financeiras WHERE id = ?').get(contaId);
  if (!c) return 0;
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE
      WHEN tipo IN ('entrada','transferencia_entrada') THEN valor
      WHEN tipo IN ('saida','transferencia_saida') THEN -valor
      ELSE 0 END), 0) AS delta
    FROM movimentacoes_financeiras WHERE contaId = ?`).get(contaId);
  return (c.saldoInicial || 0) + (row.delta || 0);
}

// ==================== HELPERS PÚBLICOS (exportados para outros módulos) ====================

function lancarMovimentacao(db, mov) {
  if (!mov.contaId || !mov.tipo || !mov.valor || !mov.descricao) {
    throw new Error('contaId, tipo, valor, descricao obrigatorios');
  }
  const r = db.prepare(`INSERT INTO movimentacoes_financeiras
    (contaId, tipo, valor, data, descricao, origem, origemId, contraContaId, categoria, usuario)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    mov.contaId, mov.tipo, Number(mov.valor),
    mov.data || dataBrasilia(), mov.descricao,
    mov.origem || null, mov.origemId || null,
    mov.contraContaId || null, mov.categoria || null, mov.usuario || null
  );
  return r.lastInsertRowid;
}

function getContaPadrao(db, tipoPadrao) {
  const col = tipoPadrao === 'caixa' ? 'ehCaixaPadrao' : 'ehBancoPadrao';
  return db.prepare(`SELECT * FROM contas_financeiras WHERE ${col} = 1 AND ativo = 1 LIMIT 1`).get();
}

function getContaMercadoPago(db) {
  const mp = db.prepare(`SELECT * FROM contas_financeiras WHERE ativo = 1 AND LOWER(nome) LIKE '%mercadopago%' LIMIT 1`).get();
  return mp || getContaPadrao(db, 'banco');
}

// ==================== ROTAS ====================

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/contas-financeiras', (req, res) => {
    try {
      const { ativo, tipo, estabelecimentoId } = req.query;
      let sql = 'SELECT * FROM contas_financeiras WHERE 1=1';
      const params = [];
      if (ativo !== undefined) { sql += ' AND ativo = ?'; params.push(Number(ativo)); }
      else { sql += ' AND ativo = 1'; }
      if (tipo) { sql += ' AND tipo = ?'; params.push(tipo); }
      const rbac = escopoContas(req);
      sql += rbac.sql; params.push(...rbac.params);
      const escopo = filtroEstabelecimento(estabelecimentoId);
      sql += escopo.sql; params.push(...escopo.params);
      sql += ' ORDER BY tipo ASC, nome ASC';
      const contas = db.prepare(sql).all(...params).map(c => ({ ...c, saldo: saldoConta(db, c.id) }));
      res.json({ success: true, contas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-financeiras/resumo', (req, res) => {
    try {
      const rbac = escopoContas(req);
      const contas = db.prepare(`SELECT * FROM contas_financeiras WHERE ativo = 1${rbac.sql}`).all(...rbac.params);
      let totalCaixa = 0, totalBanco = 0;
      for (const c of contas) {
        const s = saldoConta(db, c.id);
        if (c.tipo === 'caixa') totalCaixa += s; else totalBanco += s;
      }
      // Fluxo do mês limitado às mesmas contas: um KPI que somasse a empresa
      // inteira devolveria pela porta dos fundos o que o escopo acabou de tirar.
      const ids = contas.map(c => c.id);
      const phFluxo = ids.length ? ids.map(() => '?').join(',') : 'NULL';
      const mes = new Date().toISOString().slice(0,7);
      const fluxo = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN tipo IN ('entrada','transferencia_entrada') THEN valor END),0) AS entradas,
          COALESCE(SUM(CASE WHEN tipo IN ('saida','transferencia_saida') THEN valor END),0) AS saidas
        FROM movimentacoes_financeiras
        WHERE substr(data,1,7) = ? AND contaId IN (${phFluxo})
      `).get(mes, ...ids);
      res.json({ success: true, resumo: {
        totalCaixa, totalBanco, total: totalCaixa + totalBanco,
        entradasMes: fluxo.entradas || 0, saidasMes: fluxo.saidas || 0
      }});
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Extrato consolidado — uma ou várias contas, com filtros de relatório.
  // Precisa vir ANTES de '/:id': senão 'extrato' seria lido como id.
  app.get('/api/contas-financeiras/extrato', (req, res) => {
    try {
      const q = req.query;
      const hoje = dataBrasilia();
      const dataInicio = (q.dataInicio || '0001-01-01').slice(0, 10);
      const dataFim = (q.dataFim || hoje).slice(0, 10);
      if (dataFim < dataInicio) return res.status(400).json({ success: false, error: 'dataFim deve ser >= dataInicio' });

      // Empresa/filial: a movimentação herda o estabelecimento da conta, então
      // filtrar por unidade é restringir o conjunto de contas do extrato.
      const rbac = escopoContas(req);
      const escopo = filtroEstabelecimento(q.estabelecimentoId);
      const idsParam = parseIdsCsv(q.contas);
      const ph0 = idsParam ? idsParam.map(() => '?').join(',') : null;
      const contas = idsParam
        ? db.prepare(`SELECT id, nome, tipo, saldoInicial, estabelecimentoId FROM contas_financeiras WHERE id IN (${ph0})${rbac.sql}${escopo.sql} ORDER BY tipo, nome`).all(...idsParam, ...rbac.params, ...escopo.params)
        : db.prepare(`SELECT id, nome, tipo, saldoInicial, estabelecimentoId FROM contas_financeiras WHERE ativo = 1${rbac.sql}${escopo.sql} ORDER BY tipo, nome`).all(...rbac.params, ...escopo.params);
      if (!contas.length) return res.status(400).json({ success: false, error: 'Nenhuma conta selecionada' });

      const contaIds = contas.map(c => c.id);
      const contaIdSet = new Set(contaIds);
      const ph = contaIds.map(() => '?').join(',');

      // Saldo de abertura do período = saldo inicial das contas + tudo que se moveu antes
      let saldoInicialPeriodo = contas.reduce((s, c) => s + Number(c.saldoInicial || 0), 0);
      const anterior = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN tipo IN ('entrada','transferencia_entrada') THEN valor
                                 WHEN tipo IN ('saida','transferencia_saida') THEN -valor ELSE 0 END), 0) AS delta
        FROM movimentacoes_financeiras WHERE contaId IN (${ph}) AND data < ?`).get(...contaIds, dataInicio);
      saldoInicialPeriodo += anterior.delta || 0;

      const movs = db.prepare(`
        SELECT m.*, c.nome AS contaNome, c.tipo AS contaTipo
        FROM movimentacoes_financeiras m
        JOIN contas_financeiras c ON c.id = m.contaId
        WHERE m.contaId IN (${ph}) AND m.data >= ? AND m.data <= ?
        ORDER BY m.data ASC, m.id ASC`).all(...contaIds, dataInicio, dataFim);

      // Saldo acumulado sempre em ordem cronológica e sobre TODOS os movimentos do
      // período — assim ele continua correto mesmo com filtro de linha aplicado.
      let acumulado = saldoInicialPeriodo;
      for (const m of movs) {
        m.delta = ['entrada', 'transferencia_entrada'].includes(m.tipo) ? m.valor : -m.valor;
        acumulado = round2(acumulado + m.delta);
        m.saldoAcumulado = acumulado;
      }
      const saldoFinalPeriodo = acumulado;

      // Facetas: toda a base das contas, não só o período — senão a opção some
      // ao apertar o filtro de data e não dá pra voltar.
      const facetas = {
        origens: db.prepare(`SELECT DISTINCT COALESCE(origem,'manual') AS v FROM movimentacoes_financeiras WHERE contaId IN (${ph}) ORDER BY 1`).all(...contaIds).map(r => r.v),
        categorias: db.prepare(`SELECT DISTINCT categoria AS v FROM movimentacoes_financeiras WHERE contaId IN (${ph}) AND categoria IS NOT NULL AND categoria <> '' ORDER BY 1`).all(...contaIds).map(r => r.v),
      };

      const dc = q.dc || 'todos';
      const origensFiltro = parseCsvSet(q.origens);
      const categoriasFiltro = parseCsvSet(q.categorias);
      const busca = String(q.busca || '').trim().toLowerCase();
      const valorMin = q.valorMin ? Number(q.valorMin) : null;
      const valorMax = q.valorMax ? Number(q.valorMax) : null;
      const semTransfInternas = q.semTransferenciasInternas === '1';

      let linhas = movs.filter(m => {
        const ehTransfInterna = ['transferencia_entrada', 'transferencia_saida'].includes(m.tipo)
          && m.contraContaId && contaIdSet.has(m.contraContaId);
        if (semTransfInternas && ehTransfInterna) return false;
        if (dc === 'entrada' && m.delta < 0) return false;
        if (dc === 'saida' && m.delta > 0) return false;
        if (origensFiltro && !origensFiltro.has(m.origem || 'manual')) return false;
        if (categoriasFiltro && !categoriasFiltro.has(m.categoria || '')) return false;
        if (valorMin != null && m.valor < valorMin) return false;
        if (valorMax != null && m.valor > valorMax) return false;
        if (busca && !`${m.descricao || ''} ${m.origem || ''} ${m.categoria || ''} ${m.contaNome}`.toLowerCase().includes(busca)) return false;
        return true;
      });

      const totais = linhas.reduce((t, m) => {
        if (m.delta > 0) t.entradas += m.valor; else t.saidas += m.valor;
        return t;
      }, { entradas: 0, saidas: 0 });
      totais.entradas = round2(totais.entradas);
      totais.saidas = round2(totais.saidas);
      totais.liquido = round2(totais.entradas - totais.saidas);
      totais.qtd = linhas.length;

      // Subtotais do grupo INTEIRO (não da página): a linha de subtotal continua
      // verdadeira mesmo quando o grupo é cortado pela paginação.
      const agrupar = ['dia', 'mes'].includes(q.agrupar) ? q.agrupar : null;
      const subtotais = {};
      if (agrupar) {
        for (const m of linhas) {
          const k = agrupar === 'dia' ? m.data : m.data.slice(0, 7);
          const g = subtotais[k] || (subtotais[k] = { entradas: 0, saidas: 0, qtd: 0 });
          if (m.delta > 0) g.entradas += m.valor; else g.saidas += m.valor;
          g.qtd++;
        }
        for (const k of Object.keys(subtotais)) {
          subtotais[k].entradas = round2(subtotais[k].entradas);
          subtotais[k].saidas = round2(subtotais[k].saidas);
          subtotais[k].liquido = round2(subtotais[k].entradas - subtotais[k].saidas);
        }
      }

      if ((q.ordem || 'asc') === 'desc') linhas = linhas.slice().reverse();

      const csv = String(q.formato || 'json').toLowerCase() === 'csv';
      const porPagina = csv ? 0 : Math.max(0, Number(q.porPagina) || 200);
      const pagina = Math.max(1, Number(q.pagina) || 1);
      const total = linhas.length;
      const paginas = porPagina ? Math.max(1, Math.ceil(total / porPagina)) : 1;
      const pagLinhas = porPagina ? linhas.slice((pagina - 1) * porPagina, pagina * porPagina) : linhas;

      if (csv) {
        const rows = pagLinhas.map(m => [
          m.data,
          limpa(m.contaNome),
          m.tipo,
          limpa(m.descricao),
          m.origem || 'manual',
          limpa(m.categoria || ''),
          m.delta > 0 ? fmtBRL(m.valor) : '',
          m.delta < 0 ? fmtBRL(m.valor) : '',
          fmtBRL(m.saldoAcumulado),
        ].join(';'));
        const conteudo = [
          `Extrato ${dataInicio} a ${dataFim} - ${contas.map(c => c.nome).join(' | ')}`,
          `Saldo inicial do periodo;;;;;;;;${fmtBRL(saldoInicialPeriodo)}`,
          'data;conta;tipo;descricao;origem;categoria;entrada;saida;saldo',
          ...rows,
          `Totais;;;;;;${fmtBRL(totais.entradas)};${fmtBRL(totais.saidas)};${fmtBRL(saldoFinalPeriodo)}`,
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="extrato-${dataInicio}_${dataFim}.csv"`);
        return res.send('\uFEFF' + conteudo);
      }

      res.json({
        success: true,
        periodo: { dataInicio, dataFim },
        contas: contas.map(c => ({ ...c, saldo: saldoConta(db, c.id) })),
        saldoInicialPeriodo: round2(saldoInicialPeriodo),
        saldoFinalPeriodo,
        facetas, totais, subtotais, agrupar,
        // Sinaliza que entradas/saídas/resultado somam só o que passou no filtro —
        // o saldo continua sendo o real da conta, e os dois não fecham entre si.
        filtrado: !!(dc !== 'todos' || origensFiltro || categoriasFiltro || busca
          || valorMin != null || valorMax != null || semTransfInternas),
        paginacao: { pagina, porPagina, total, paginas },
        linhas: pagLinhas,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-financeiras/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      if (!c || !contaNoEscopo(req, c)) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      res.json({ success: true, conta: { ...c, saldo: saldoConta(db, c.id) } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras', (req, res) => {
    try {
      const b = req.body;
      if (!b.nome || !b.tipo) return res.status(400).json({ success: false, error: 'nome e tipo obrigatorios' });
      if (!['caixa','banco'].includes(b.tipo)) return res.status(400).json({ success: false, error: 'tipo invalido' });
      // Quem opera preso a uma unidade cria conta DELA — não pode plantar conta
      // em outra filial nem soltar uma conta sem vínculo (que todos veriam).
      const escopo = escopoUsuario(req);
      const estabDaConta = escopo || (b.estabelecimentoId || null);

      const tx = db.transaction(() => {
        if (b.ehCaixaPadrao) db.prepare('UPDATE contas_financeiras SET ehCaixaPadrao = 0').run();
        if (b.ehBancoPadrao) db.prepare('UPDATE contas_financeiras SET ehBancoPadrao = 0').run();

        const r = db.prepare(`INSERT INTO contas_financeiras
          (nome, tipo, banco, agencia, conta, saldoInicial, ehCaixaPadrao, ehBancoPadrao, observacoes, estabelecimentoId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          b.nome, b.tipo, b.banco||null, b.agencia||null, b.conta||null,
          Number(b.saldoInicial)||0,
          b.tipo==='caixa' && b.ehCaixaPadrao ? 1 : 0,
          b.tipo==='banco' && b.ehBancoPadrao ? 1 : 0,
          b.observacoes||null, estabDaConta);
        return r.lastInsertRowid;
      });
      const id = tx();
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(id);
      res.json({ success: true, conta: { ...conta, saldo: saldoConta(db, id) } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/contas-financeiras/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      if (!existing || !contaNoEscopo(req, existing)) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      const b = req.body;
      // Reatribuir a conta a outra unidade é privilégio de quem enxerga todas:
      // senão bastaria editar o vínculo para tirá-la de vista dos demais.
      const escopo = escopoUsuario(req);
      const novoEstab = escopo
        ? existing.estabelecimentoId
        : (b.estabelecimentoId !== undefined ? (b.estabelecimentoId || null) : existing.estabelecimentoId);

      const tx = db.transaction(() => {
        if (b.ehCaixaPadrao && existing.tipo === 'caixa') db.prepare('UPDATE contas_financeiras SET ehCaixaPadrao = 0 WHERE id != ?').run(req.params.id);
        if (b.ehBancoPadrao && existing.tipo === 'banco') db.prepare('UPDATE contas_financeiras SET ehBancoPadrao = 0 WHERE id != ?').run(req.params.id);

        db.prepare(`UPDATE contas_financeiras SET
          nome = ?, banco = ?, agencia = ?, conta = ?, saldoInicial = ?,
          ehCaixaPadrao = ?, ehBancoPadrao = ?, observacoes = ?, estabelecimentoId = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?`).run(
          b.nome ?? existing.nome,
          b.banco ?? existing.banco,
          b.agencia ?? existing.agencia,
          b.conta ?? existing.conta,
          b.saldoInicial != null ? Number(b.saldoInicial) : existing.saldoInicial,
          existing.tipo === 'caixa' ? (b.ehCaixaPadrao ? 1 : 0) : 0,
          existing.tipo === 'banco' ? (b.ehBancoPadrao ? 1 : 0) : 0,
          b.observacoes ?? existing.observacoes,
          novoEstab,
          req.params.id
        );
      });
      tx();
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      res.json({ success: true, conta: { ...conta, saldo: saldoConta(db, conta.id) } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/contas-financeiras/:id', (req, res) => {
    try {
      const alvo = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      if (!alvo || !contaNoEscopo(req, alvo)) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      const result = db.prepare('UPDATE contas_financeiras SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ? AND ativo = 1').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contas-financeiras/:id/extrato', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ?').get(req.params.id);
      if (!conta || !contaNoEscopo(req, conta)) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      const { dataInicio, dataFim, limit } = req.query;
      let sql = 'SELECT * FROM movimentacoes_financeiras WHERE contaId = ?';
      const params = [req.params.id];
      if (dataInicio) { sql += ' AND data >= ?'; params.push(dataInicio); }
      if (dataFim) { sql += ' AND data <= ?'; params.push(dataFim); }
      sql += ' ORDER BY data ASC, id ASC';
      if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
      const movs = db.prepare(sql).all(...params);

      // Saldo acumulado (considerando saldo inicial + movs anteriores ao período)
      let saldoBase = conta.saldoInicial || 0;
      if (dataInicio) {
        const anterior = db.prepare(`
          SELECT COALESCE(SUM(CASE WHEN tipo IN ('entrada','transferencia_entrada') THEN valor
                                   WHEN tipo IN ('saida','transferencia_saida') THEN -valor ELSE 0 END), 0) AS delta
          FROM movimentacoes_financeiras WHERE contaId = ? AND data < ?`).get(req.params.id, dataInicio);
        saldoBase += anterior.delta || 0;
      }
      let saldo = saldoBase;
      const extrato = movs.map(m => {
        const delta = ['entrada','transferencia_entrada'].includes(m.tipo) ? m.valor : -m.valor;
        saldo += delta;
        return { ...m, delta, saldoAcumulado: saldo };
      });
      res.json({ success: true, conta: { ...conta, saldo: saldoConta(db, conta.id) }, extrato, saldoInicialPeriodo: saldoBase });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras/:id/movimentar', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(req.params.id);
      if (!conta || !contaNoEscopo(req, conta)) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      const b = req.body;
      if (!['entrada','saida'].includes(b.tipo)) return res.status(400).json({ success: false, error: 'tipo invalido (entrada|saida)' });
      const valor = Number(b.valor);
      if (!(valor > 0)) return res.status(400).json({ success: false, error: 'valor > 0 obrigatorio' });
      if (!b.descricao) return res.status(400).json({ success: false, error: 'descricao obrigatoria' });

      const id = lancarMovimentacao(db, {
        contaId: conta.id, tipo: b.tipo, valor, data: b.data || dataBrasilia(),
        descricao: b.descricao, origem: 'manual',
        categoria: b.categoria || null,
        usuario: req.session?.username || null
      });
      const mov = db.prepare('SELECT * FROM movimentacoes_financeiras WHERE id = ?').get(id);
      res.json({ success: true, movimentacao: mov, saldoAtual: saldoConta(db, conta.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-financeiras/transferir', (req, res) => {
    try {
      const { origemId, destinoId, valor, data, descricao } = req.body;
      if (!origemId || !destinoId) return res.status(400).json({ success: false, error: 'origemId e destinoId obrigatorios' });
      if (origemId === destinoId) return res.status(400).json({ success: false, error: 'Contas origem e destino devem ser diferentes' });
      const v = Number(valor);
      if (!(v > 0)) return res.status(400).json({ success: false, error: 'valor > 0 obrigatorio' });

      const origem = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(origemId);
      const destino = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(destinoId);
      if (!origem || !destino) return res.status(404).json({ success: false, error: 'Conta origem/destino nao encontrada' });
      // Transferir é escrever nas duas pontas: as duas precisam estar no escopo.
      if (!contaNoEscopo(req, origem) || !contaNoEscopo(req, destino)) {
        return res.status(404).json({ success: false, error: 'Conta origem/destino nao encontrada' });
      }

      const desc = descricao || `Transferência ${origem.nome} → ${destino.nome}`;
      const usuario = req.session?.username || null;
      const dt = data || dataBrasilia();

      const tx = db.transaction(() => {
        const saidaId = lancarMovimentacao(db, {
          contaId: origemId, tipo: 'transferencia_saida', valor: v, data: dt,
          descricao: desc, origem: 'transferencia', contraContaId: destinoId, usuario
        });
        lancarMovimentacao(db, {
          contaId: destinoId, tipo: 'transferencia_entrada', valor: v, data: dt,
          descricao: desc, origem: 'transferencia', contraContaId: origemId, origemId: saidaId, usuario
        });
      });
      tx();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = {
  registrarRotasContasFinanceiras: registrarRotas,
  escopoContas,
  contaNoEscopo,
  lancarMovimentacao,
  getContaPadrao,
  getContaMercadoPago,
};
