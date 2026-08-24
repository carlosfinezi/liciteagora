/**
 * comissoes-routes.js — Comissões de vendedores.
 *
 * Modelo:
 *   pedidos.vendedorId (FK users) — quem vendeu
 *   comissoes_regras   — regras: vendedor + escopo (produto/categoria/cliente) + tipo + valor
 *   comissoes_apuracao — linhas geradas ao apurar um período (1 linha por item de pedido)
 *
 * Tipos de regra:
 *   percentual_venda  — valor% × item.valorTotal
 *   percentual_lucro  — valor% × (item.valorTotal − item.custo)
 *   fixo_por_unidade  — valor × item.quantidade
 *
 * Critério de elegibilidade do pedido: status = 'confirmado' ou statusPagamento = 'pago'.
 *
 * Match de regra (mais específica vence):
 *   1. vendedor+produto      (specificity 4)
 *   2. vendedor+categoria    (3)
 *   3. vendedor+cliente      (3)
 *   4. vendedor (qualquer)   (2)
 *   5. produto/categoria/cliente sem vendedor (1)
 *   6. regra geral (todos null) (0)
 */

const { logAction } = require('./audit-log');
const { lancarMovimentacao } = require('./contas-financeiras-routes');
const { escopoSqlHerdado, escopoUsuario, noEscopo, guardEscopo } = require('./estabelecimentos-routes');
const calc = require('./comissoes-calculo');
const { E_FORNECEDOR } = require('./pessoas-fornecedor');

const TIPOS_REGRA = ['percentual_venda', 'percentual_lucro', 'fixo_por_unidade'];

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

function migrarDB(db) {
  alterSafe(db, 'ALTER TABLE pedidos ADD COLUMN vendedorId INTEGER');
  // Plano de comissão de verdade tem gatilho e acelerador de meta; sem eles a
  // regra é uma taxa fixa que ignora se o vendedor bateu o número.
  alterSafe(db, 'ALTER TABLE comissoes_regras ADD COLUMN metaMinimaPercentual REAL');
  alterSafe(db, 'ALTER TABLE comissoes_regras ADD COLUMN valorAcelerado REAL');
  // Rastro do pagamento, para o estorno saber o que desfazer.
  alterSafe(db, 'ALTER TABLE comissoes_apuracao ADD COLUMN contaPagarId INTEGER');
  alterSafe(db, 'ALTER TABLE comissoes_apuracao ADD COLUMN movimentacaoId INTEGER');
  alterSafe(db, 'ALTER TABLE comissoes_apuracao ADD COLUMN motivoSemComissao TEXT');
  alterSafe(db, 'ALTER TABLE comissoes_apuracao ADD COLUMN baseApuracao TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS comissoes_regras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      vendedorId INTEGER,
      produtoId INTEGER,
      categoriaProduto TEXT,
      clienteId INTEGER,
      tipo TEXT NOT NULL,
      valor REAL NOT NULL,
      dataInicio TEXT,
      dataFim TEXT,
      ativo INTEGER DEFAULT 1,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendedorId) REFERENCES users(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (clienteId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_regras_ativo ON comissoes_regras(ativo, vendedorId);

    CREATE TABLE IF NOT EXISTS comissoes_apuracao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      periodo TEXT NOT NULL,
      vendedorId INTEGER NOT NULL,
      pedidoId INTEGER NOT NULL,
      pedidoItemId INTEGER NOT NULL,
      regraId INTEGER,
      tipo TEXT,
      baseCalculo REAL NOT NULL,
      percentual REAL,
      valorComissao REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      dataPagamento TEXT,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vendedorId) REFERENCES users(id),
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id),
      FOREIGN KEY (pedidoItemId) REFERENCES pedido_itens(id),
      FOREIGN KEY (regraId) REFERENCES comissoes_regras(id)
    );
    CREATE INDEX IF NOT EXISTS idx_apur_periodo_vendedor ON comissoes_apuracao(periodo, vendedorId);
    CREATE INDEX IF NOT EXISTS idx_apur_status ON comissoes_apuracao(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apur_pedido_item ON comissoes_apuracao(periodo, pedidoItemId);
  `);
}

// Escolha de regra, custo e cálculo migraram para comissoes-calculo.js — a
// versão local desempatava pela ordem que o SQLite devolvesse e usava o custo
// de hoje para apurar lucro de meses fechados.


// Erro bloqueia; aviso vai junto na resposta. Regra sombreada e percentual
// incomum não devem impedir a gravação — só precisam ser ditos.
function separar(problemas) {
  return {
    erros: problemas.filter((p) => p.nivel === 'erro'),
    avisos: problemas.filter((p) => p.nivel === 'aviso'),
  };
}

function registrarRotasComissoes(app, db) {
  // RBAC: a apuração herda a unidade do vendedor.
  app.use('/api/comissoes/apuracao/:id', guardEscopo(db, 'comissoes_apuracao', { fk: 'vendedorId', pai: 'users' }));

  migrarDB(db);

  // ==================== REGRAS CRUD ====================

  app.get('/api/comissoes/regras', (req, res) => {
    try {
      const regras = db.prepare(`
        SELECT r.*, u.username AS vendedorNome, p.sku AS produtoSku, p.descricao AS produtoDescricao,
               cli.razaoSocial AS clienteNome
        FROM comissoes_regras r
        LEFT JOIN users u ON u.id = r.vendedorId
        LEFT JOIN produtos p ON p.id = r.produtoId
        LEFT JOIN pessoas cli ON cli.id = r.clienteId
        ORDER BY r.ativo DESC, r.id DESC
      `).all();
      res.json({ success: true, regras, tipos: TIPOS_REGRA });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/comissoes/regras', (req, res) => {
    try {
      const { nome, vendedorId, produtoId, categoriaProduto, clienteId, tipo, valor,
              dataInicio, dataFim, observacoes, metaMinimaPercentual, valorAcelerado } = req.body;

      const { erros, avisos } = separar(calc.validarRegra(db, req.body));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const r = db.prepare(`
        INSERT INTO comissoes_regras (nome, vendedorId, produtoId, categoriaProduto, clienteId, tipo, valor,
                                      dataInicio, dataFim, observacoes, metaMinimaPercentual, valorAcelerado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(nome, vendedorId || null, produtoId || null, categoriaProduto || null, clienteId || null,
              tipo, Number(valor), dataInicio || null, dataFim || null, observacoes || null,
              metaMinimaPercentual != null && metaMinimaPercentual !== '' ? Number(metaMinimaPercentual) : null,
              valorAcelerado != null && valorAcelerado !== '' ? Number(valorAcelerado) : null);
      logAction(db, req, 'criar', 'comissao-regra', r.lastInsertRowid, { nome, tipo, valor });
      // avisos vao junto: regra sombreada nasce funcionando, mas inutil.
      res.json({ success: true, avisos, regra: db.prepare('SELECT * FROM comissoes_regras WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/comissoes/regras/:id', (req, res) => {
    try {
      const camposValidos = ['nome','vendedorId','produtoId','categoriaProduto','clienteId','tipo','valor',
                             'dataInicio','dataFim','ativo','observacoes','metaMinimaPercentual','valorAcelerado'];

      const atual = db.prepare('SELECT * FROM comissoes_regras WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Regra nao encontrada' });

      // Valida o estado final: quem muda so o percentual ainda precisa resultar
      // numa regra coerente.
      const final = { ...atual, ...req.body };
      const { erros, avisos } = separar(calc.validarRegra(db, final, { id: Number(req.params.id) }));
      if (erros.length) return res.status(400).json({ success: false, error: erros[0].mensagem, problemas: erros });

      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) {
          sets.push(`${c} = ?`);
          vals.push(c === 'ativo' ? (req.body[c] ? 1 : 0) : (req.body[c] === '' ? null : req.body[c]));
        }
      }
      if (!sets.length) return res.json({ success: true });
      vals.push(req.params.id);
      db.prepare(`UPDATE comissoes_regras SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      logAction(db, req, 'editar', 'comissao-regra', req.params.id, req.body);
      res.json({ success: true, avisos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/comissoes/regras/:id', (req, res) => {
    try {
      db.prepare('UPDATE comissoes_regras SET ativo = 0 WHERE id = ?').run(req.params.id);
      logAction(db, req, 'desativar', 'comissao-regra', req.params.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== APURAÇÃO ====================
  // POST /api/comissoes/apurar?periodo=YYYY-MM[&vendedorId=]
  // Reapura: apaga linhas pendentes do período e regenera (linhas pagas são preservadas)

  app.post('/api/comissoes/apurar', (req, res) => {
    try {
      const periodo = req.query.periodo || req.body?.periodo;
      const vendedorFiltro = req.query.vendedorId || req.body?.vendedorId;
      const base = req.query.base || req.body?.base || 'confirmado';
      const simular = req.query.simular === '1' || req.body?.simular === true;
      if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
        return res.status(400).json({ success: false, error: 'periodo no formato YYYY-MM obrigatório' });
      }
      if (!calc.BASES[base]) {
        return res.status(400).json({ success: false,
          error: `base inválida: use ${Object.keys(calc.BASES).join(', ')}` });
      }
      const ini = `${periodo}-01`;
      // Date.UTC para o último dia não escorregar de fuso.
      const [y, m] = periodo.split('-').map(Number);
      const fim = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);

      const regras = db.prepare('SELECT * FROM comissoes_regras WHERE ativo = 1').all();

      let pedidosSql = calc.sqlPedidosElegiveis(base);
      const params = [ini, fim];
      if (vendedorFiltro) { pedidosSql += ' AND p.vendedorId = ?'; params.push(Number(vendedorFiltro)); }
      const pedidos = db.prepare(pedidosSql).all(...params);

      // Meta por vendedor, calculada uma vez — gatilho e acelerador precisam
      // dela e recalcular por item seria N consultas à toa.
      const metaPorVendedor = new Map();
      const cadastroPorVendedor = new Map();
      for (const ped of pedidos) {
        if (!metaPorVendedor.has(ped.vendedorId)) {
          metaPorVendedor.set(ped.vendedorId, calc.situacaoMeta(db, ped.vendedorId, periodo, base));
          cadastroPorVendedor.set(ped.vendedorId, calc.regraDoCadastro(db, ped.vendedorId));
        }
      }

      // Apaga apurações pendentes do período (não toca em pagas)
      const delSql = `DELETE FROM comissoes_apuracao WHERE periodo = ? AND status = 'pendente'${vendedorFiltro?' AND vendedorId = ?':''}`;
      const delParams = vendedorFiltro ? [periodo, Number(vendedorFiltro)] : [periodo];
      if (!simular) db.prepare(delSql).run(...delParams);

      const stmtItens = db.prepare(`
        SELECT pi.*, pr.categoria, pr.descricao AS produtoDescricao
        FROM pedido_itens pi
        LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.pedidoId = ?
      `);

      const stmtJaPago = db.prepare(`SELECT id FROM comissoes_apuracao WHERE periodo = ? AND pedidoItemId = ? AND status = 'paga'`);
      const stmtInsert = db.prepare(`
        INSERT INTO comissoes_apuracao (periodo, vendedorId, pedidoId, pedidoItemId, regraId, tipo,
                                        baseCalculo, percentual, valorComissao, status, baseApuracao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)
      `);

      let geradas = 0, total = 0, porCadastro = 0;
      const semRegra = [];
      const semValor = [];
      const ambiguos = [];
      const previa = [];

      const trx = db.transaction(() => {
        for (const ped of pedidos) {
          const meta = metaPorVendedor.get(ped.vendedorId);
          for (const it of stmtItens.all(ped.id)) {
            if (stmtJaPago.get(periodo, it.id)) continue;   // já pago: preserva

            let { regra, empatadas } = calc.escolherRegra(regras, it, ped, { categoria: it.categoria });
            if (!regra) {
              // Antes de desistir, o percentual da ficha do vendedor.
              regra = cadastroPorVendedor.get(ped.vendedorId) || null;
              if (regra) porCadastro++;
            }
            if (!regra) {
              semRegra.push({ pedidoId: ped.id, pedidoNumero: ped.numero, itemId: it.id,
                              descricao: it.descricao, valor: Number(it.valorTotal) || 0 });
              continue;
            }
            if (empatadas.length) {
              ambiguos.push({ pedidoId: ped.id, itemId: it.id, aplicada: regra.id,
                              empatadas: empatadas.map((r) => ({ id: r.id, nome: r.nome })) });
            }

            const c = calc.custoNaData(db, it.produtoId, (ped.dataPedido || '').slice(0, 10));
            const r = calc.calcularComissao(regra, it,
              { meta, custoUnitario: c.custo, custoEncontrado: c.encontrado });

            if (!(r.valor > 0)) {
              // Antes isto era um `continue` mudo: o item saía do relatório sem
              // dizer que existiu nem por que valeu zero.
              semValor.push({ pedidoId: ped.id, pedidoNumero: ped.numero, itemId: it.id,
                              descricao: it.descricao, regraId: regra.id, regraNome: regra.nome,
                              motivo: r.motivo || 'comissão calculada em zero' });
              continue;
            }

            previa.push({ pedidoId: ped.id, pedidoNumero: ped.numero, itemId: it.id,
                          descricao: it.descricao, vendedorId: ped.vendedorId, regraId: regra.id,
                          regraNome: regra.nome, base: r.base, percentual: r.percentual,
                          valor: r.valor, acelerado: !!r.acelerado });
            if (!simular) {
              stmtInsert.run(periodo, ped.vendedorId, ped.id, it.id, regra.id || null, regra.tipo,
                             r.base, r.percentual, r.valor, base);
            }
            geradas++;
            total += r.valor;
          }
        }
      });
      trx();

      const metas = Array.from(metaPorVendedor.entries())
        .filter(([, v]) => v).map(([vendedorId, v]) => ({ vendedorId, ...v }));

      if (!simular) {
        logAction(db, req, 'apurar', 'comissao', null,
          { periodo, base, geradas, total, semRegra: semRegra.length, pedidos: pedidos.length });
      }
      res.json({
        success: true, periodo, base, simulacao: simular,
        pedidos: pedidos.length, geradas, total: Number(total.toFixed(2)),
        // Quantas linhas vieram do percentual da ficha do vendedor, e não de
        // uma regra escrita: é bom saber que o plano de comissão está implícito.
        geradasPorCadastro: porCadastro,
        // Contagem sozinha não conserta nada: quem apura precisa saber QUAIS
        // itens ficaram de fora para escrever a regra que falta.
        ignoradasSemRegra: semRegra.length,
        itensSemRegra: semRegra,
        valorSemRegra: Number(semRegra.reduce((a, x) => a + x.valor, 0).toFixed(2)),
        itensSemValor: semValor,
        itensAmbiguos: ambiguos,
        metas,
        previa: simular ? previa : undefined,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Lista apurações (filtros)
  app.get('/api/comissoes/apuracao', (req, res) => {
    try {
      const { periodo, vendedorId, status } = req.query;
      let sql = `
        SELECT a.*, u.username AS vendedorNome, u.nome AS vendedorNomeExibicao,
               p.numero AS pedidoNumero, p.dataPedido,
               cli.razaoSocial AS clienteNome,
               pi.descricao AS itemDescricao, pi.quantidade AS itemQuantidade
        FROM comissoes_apuracao a
        JOIN users u ON u.id = a.vendedorId
        JOIN pedidos p ON p.id = a.pedidoId
        LEFT JOIN pessoas cli ON cli.id = p.clienteId
        JOIN pedido_itens pi ON pi.id = a.pedidoItemId
        WHERE 1=1
      `;
      const params = [];
      // RBAC: a comissão pertence à unidade do vendedor (users.estabelecimentoId).
      const rbac = escopoSqlHerdado(req, 'a.vendedorId', 'users');
      sql += rbac.sql; params.push(...rbac.params);
      if (periodo)    { sql += ' AND a.periodo = ?';    params.push(periodo); }
      if (vendedorId) { sql += ' AND a.vendedorId = ?'; params.push(Number(vendedorId)); }
      if (status)     { sql += ' AND a.status = ?';     params.push(status); }
      sql += ' ORDER BY a.vendedorId, a.id DESC LIMIT 2000';
      const apuracoes = db.prepare(sql).all(...params);

      // Agrega totais por vendedor
      const totaisMap = new Map();
      for (const a of apuracoes) {
        const cur = totaisMap.get(a.vendedorId) || { vendedorId: a.vendedorId, vendedorNome: a.vendedorNomeExibicao || a.vendedorNome, pendente: 0, paga: 0, qtdLinhas: 0 };
        if (a.status === 'pendente') cur.pendente += a.valorComissao;
        if (a.status === 'paga')     cur.paga     += a.valorComissao;
        cur.qtdLinhas++;
        totaisMap.set(a.vendedorId, cur);
      }
      res.json({ success: true, apuracoes, totais: Array.from(totaisMap.values()) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Marcar como paga (lote ou individual) — COM-01 (2026-04-18): além de mudar
  // status, agora gera uma conta_a_pagar + baixa + movimentação financeira para
  // que o pagamento efetivamente reflita no caixa/banco. Antes era puro update
  // de status e vendedor recebia comissão "fora do sistema" sem rastreio.
  app.post('/api/comissoes/apuracao/pagar', (req, res) => {
    try {
      const { ids, dataPagamento, observacao, contaFinanceiraId, fornecedorId } = req.body;
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ success: false, error: 'ids obrigatórios' });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório — qual conta paga a comissão?' });
      const data = dataPagamento || new Date().toISOString().slice(0, 10);

      const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin || !noEscopo(req, contaFin.estabelecimentoId)) {
        return res.status(404).json({ success: false, error: 'Conta financeira não encontrada ou inativa' });
      }
      // Os ids vêm no corpo: barra pagar comissão de vendedor de outra unidade.
      const escopoUser = escopoUsuario(req);
      if (escopoUser) {
        const fora = db.prepare(`SELECT COUNT(*) AS n FROM comissoes_apuracao a
          JOIN users u ON u.id = a.vendedorId
          WHERE a.id IN (${ids.map(() => '?').join(',')})
            AND u.estabelecimentoId IS NOT NULL AND u.estabelecimentoId != ?`).get(...ids, escopoUser).n;
        if (fora) return res.status(404).json({ success: false, error: 'Apuração não encontrada' });
      }

      // contas_a_pagar.fornecedorId é NOT NULL. A rota mandava `|| null` e o
      // pagamento morria com um erro cru do SQLite. Resolve pelo CPF/CNPJ do
      // vendedor e, quando não dá, diz o que falta em vez de estourar.
      function resolverFornecedor(vendedorId) {
        if (fornecedorId) return Number(fornecedorId);
        try {
          const u = db.prepare('SELECT cpfCnpj FROM users WHERE id = ?').get(vendedorId);
          const doc = String((u && u.cpfCnpj) || '').replace(/\D/g, '');
          if (!doc) return null;
          const forn = db.prepare(`SELECT id FROM pessoas
            WHERE ${E_FORNECEDOR}
              AND REPLACE(REPLACE(REPLACE(COALESCE(cpfCnpj,''),'.',''),'-',''),'/','') = ?`).get(doc);
          return forn ? forn.id : null;
        } catch { return null; }
      }

      // Agrega por vendedor e valida cada apuração
      const placeholders = ids.map(() => '?').join(',');
      const apuracoes = db.prepare(`SELECT a.*, u.nome as vendedorNome
        FROM comissoes_apuracao a
        LEFT JOIN users u ON u.id = a.vendedorId
        WHERE a.id IN (${placeholders}) AND a.status = 'pendente'`).all(...ids);
      if (!apuracoes.length) return res.status(400).json({ success: false, error: 'Nenhuma apuração pendente encontrada para os ids' });

      const porVendedor = new Map();
      for (const a of apuracoes) {
        const key = a.vendedorId || 0;
        if (!porVendedor.has(key)) porVendedor.set(key, { vendedorId: a.vendedorId, vendedorNome: a.vendedorNome, ids: [], total: 0, periodo: a.periodo });
        const agg = porVendedor.get(key);
        agg.ids.push(a.id);
        // A coluna é `valorComissao`. Somar `a.valor` dava NaN -> 0, o total
        // ficava zero, o `continue` abaixo pulava todo mundo e a rota devolvia
        // "sucesso" sem pagar nada, sem criar conta a pagar e sem marcar as
        // apurações. O vendedor não recebia e ninguém via.
        agg.total += Number(a.valorComissao) || 0;
      }

      const resultados = [];
      const semValor = [];
      let marcadas = 0;
      const tx = db.transaction(() => {
        for (const agg of porVendedor.values()) {
          const vPago = Number(agg.total.toFixed(2));
          if (vPago <= 0) { semValor.push({ vendedorId: agg.vendedorId, apuracoes: agg.ids }); continue; }

          const fornDoVendedor = resolverFornecedor(agg.vendedorId);
          if (!fornDoVendedor) {
            throw new Error(
              `Vendedor ${agg.vendedorNome || '#' + agg.vendedorId} não tem fornecedor vinculado. `
              + 'Cadastre o CPF/CNPJ dele em Usuários e um fornecedor com o mesmo documento, '
              + 'ou informe fornecedorId na requisição — a conta a pagar exige um credor.');
          }
          // 1) cria conta_a_pagar (documento do passivo)
          const cp = db.prepare(`INSERT INTO contas_a_pagar
            (fornecedorId, descricao, valor, dataEmissao, dataVencimento, dataPagamento,
             status, valorPago, contaFinanceiraId, formaPagamento, observacoes)
            VALUES (?, ?, ?, ?, ?, ?, 'paga', ?, ?, 'comissao', ?)`).run(
            fornDoVendedor,
            `Comissão ${agg.periodo || ''} — ${agg.vendedorNome || 'vendedor id ' + agg.vendedorId}`,
            vPago, data, data, data, vPago, contaFinanceiraId,
            observacao || `apuracoes: ${agg.ids.join(',')}`
          );
          // 2) lança saída na conta financeira
          const movId = lancarMovimentacao(db, {
            contaId: contaFinanceiraId,
            tipo: 'saida', valor: vPago, data,
            descricao: `Comissão vendedor #${agg.vendedorId || '?'} (apuracoes ${agg.ids.join(',')})`,
            origem: 'comissao_pagamento', origemId: cp.lastInsertRowid,
            categoria: 'comissoes',
            usuario: req.user?.username || null
          });
          // 3) marca apurações como pagas, guardando o rastro em COLUNA — o
          // estorno precisa saber qual conta a pagar e qual movimentação
          // desfazer, e texto livre em `observacao` não serve para isso.
          const ph = agg.ids.map(() => '?').join(',');
          const upd = db.prepare(`UPDATE comissoes_apuracao
             SET status = 'paga', dataPagamento = ?, contaPagarId = ?, movimentacaoId = ?,
                 observacao = COALESCE(?, observacao)
             WHERE id IN (${ph})`)
            .run(data, cp.lastInsertRowid, movId, observacao || null, ...agg.ids);
          marcadas += upd.changes;
          resultados.push({ vendedorId: agg.vendedorId, apuracoes: agg.ids, contaPagarId: cp.lastInsertRowid, movimentacaoId: movId, valor: vPago });
        }
      });
      tx();

      logAction(db, req, 'pagar', 'comissao', null, { ids, dataPagamento: data, resultados });
      // `marcadas` conta o que foi efetivamente pago, não o que foi encontrado.
      res.json({ success: true, marcadas, encontradas: apuracoes.length,
        total: Number(resultados.reduce((t, r) => t + r.valor, 0).toFixed(2)),
        pagamentos: resultados, semValor });
    } catch (err) {
      // Falta de cadastro é erro do usuário, não do servidor.
      const doUsuario = /fornecedor vinculado/.test(err.message);
      if (!doUsuario) console.error('[pagar comissao]', err);
      res.status(doUsuario ? 400 : 500).json({ success: false, error: err.message });
    }
  });

  // Estorno desfaz o pagamento inteiro, não só o status.
  //
  // Antes voltava a apuração para 'pendente' e deixava a conta a pagar quitada
  // e o dinheiro fora da conta. A comissão podia ser paga de novo — o mesmo
  // valor saía duas vezes e o caixa nunca fechava.
  app.post('/api/comissoes/apuracao/:id/estornar', (req, res) => {
    try {
      const a = db.prepare("SELECT * FROM comissoes_apuracao WHERE id = ? AND status = 'paga'").get(req.params.id);
      if (!a) return res.status(400).json({ success: false, error: 'Apuração não está paga' });

      // O pagamento foi feito em lote por vendedor: estornar uma linha sozinha
      // deixaria a conta a pagar com valor que não corresponde a nada. Ou
      // desfaz o lote todo, ou não desfaz.
      const irmas = a.contaPagarId
        ? db.prepare("SELECT * FROM comissoes_apuracao WHERE contaPagarId = ? AND status = 'paga'").all(a.contaPagarId)
        : [a];

      const desfeito = { contaPagarId: a.contaPagarId || null, movimentacaoId: a.movimentacaoId || null, linhas: irmas.length };

      const tx = db.transaction(() => {
        if (a.movimentacaoId) {
          const mov = db.prepare('SELECT * FROM movimentacoes_financeiras WHERE id = ?').get(a.movimentacaoId);
          if (mov) {
            // Contra-lançamento em vez de DELETE: extrato conciliado não se
            // reescreve, e a entrada tem que aparecer na data em que ocorreu.
            lancarMovimentacao(db, {
              contaId: mov.contaId, tipo: 'entrada', valor: mov.valor,
              descricao: `Estorno de comissão — ${mov.descricao}`,
              origem: 'comissao_estorno', origemId: a.contaPagarId || a.id,
              categoria: 'comissoes', usuario: req.user?.username || null,
            });
          }
        }
        if (a.contaPagarId) {
          db.prepare(`UPDATE contas_a_pagar
            SET status = 'cancelada', valorPago = 0, dataPagamento = NULL,
                observacoes = COALESCE(observacoes, '') || ' | estornada em ' || DATE('now')
            WHERE id = ?`).run(a.contaPagarId);
        }
        const ids = irmas.map((x) => x.id);
        const ph = ids.map(() => '?').join(',');
        db.prepare(`UPDATE comissoes_apuracao
          SET status = 'pendente', dataPagamento = NULL, contaPagarId = NULL, movimentacaoId = NULL
          WHERE id IN (${ph})`).run(...ids);
      });
      tx();

      logAction(db, req, 'estornar-pagamento', 'comissao', req.params.id, desfeito);
      res.json({ success: true, desfeito });
    } catch (err) {
      console.error('[estornar comissao]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== INTELIGÊNCIA ====================

  // Por que a apuração ficou assim: itens sem regra, itens com regra ambígua,
  // regras que nunca casaram e pedidos que a base escolhida deixou de fora.
  app.get('/api/comissoes/diagnostico', (req, res) => {
    try {
      const { periodo, base } = req.query;
      if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
        return res.status(400).json({ success: false, error: 'periodo no formato YYYY-MM obrigatório' });
      }
      res.json({ success: true, diagnostico: calc.diagnosticoRegras(db, periodo, { base: base || 'confirmado' }) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Quanto cada vendedor vendeu contra a meta — é o que decide gatilho e
  // acelerador, então precisa ser visível antes de apurar.
  app.get('/api/comissoes/metas', (req, res) => {
    try {
      const { periodo, base } = req.query;
      if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
        return res.status(400).json({ success: false, error: 'periodo no formato YYYY-MM obrigatório' });
      }
      const vendedores = db.prepare(`SELECT DISTINCT p.vendedorId AS id, u.nome, u.username
        FROM pedidos p JOIN users u ON u.id = p.vendedorId
        WHERE p.vendedorId IS NOT NULL AND p.dataPedido LIKE ?`).all(periodo + '-%');
      const metas = vendedores.map((v) => ({
        vendedorId: v.id, nome: v.nome || v.username,
        meta: calc.situacaoMeta(db, v.id, periodo, base || 'confirmado'),
      }));
      res.json({ success: true, metas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasComissoes };
