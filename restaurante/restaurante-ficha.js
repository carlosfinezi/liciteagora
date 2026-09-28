/**
 * restaurante-ficha.js — Módulo Restaurante, fase 8: ficha técnica e CMV.
 *
 * CONVENÇÃO DAS QUANTIDADES (é onde toda planilha de restaurante erra):
 *
 *   quantidadeBruta  — quanto SAI DO ESTOQUE. É a quantidade como comprada,
 *                      com casca, osso e aparas. É ela que baixa e é ela que
 *                      custa.
 *   fatorCorrecao    — bruto ÷ líquido. Alface tem ~1,4: de 1 kg comprado,
 *                      sobram ~715 g aproveitáveis.
 *   quantidadeLiquida— derivada: bruta ÷ fatorCorrecao. É o que chega ao prato.
 *   fatorCoccao      — rendimento pós-cocção. Arroz cru rende ~2,5× cozido.
 *
 * Por que a baixa usa a BRUTA: o desperdício de pré-preparo é custo real do
 * prato. Baixar só o líquido deixaria a diferença "sumindo" do estoque sem
 * aparecer em lugar nenhum — que é exatamente o buraco que o CMV existe para
 * fechar. A API aceita informar líquida OU bruta e converte.
 *
 * SUB-RECEITA não tem tabela própria: o insumo é um produto, e se esse produto
 * tiver ficha, a explosão desce nele. Recursão com guarda de profundidade e
 * detecção de ciclo — molho que contém a si mesmo trava o sistema inteiro
 * sem isso.
 */

const { agora, FUSO_LOCAL_SQL } = require('./restaurante-comanda');

// Profundidade máxima da explosão. Cinco níveis cobrem qualquer cozinha real
// (prato → molho → base → fundo → tempero); além disso é erro de cadastro.
const PROFUNDIDADE_MAX = 5;

function custoUnitarioInsumo(db, produtoId) {
  const p = db.prepare('SELECT precoCusto FROM produtos WHERE id = ?').get(produtoId);
  return p ? Number(p.precoCusto || 0) : 0;
}

/**
 * Custo de uma ficha, explodindo sub-receitas.
 *
 * Devolve { custoTotal, custoPorcao, itens[], avisos[] }. Os avisos apontam o
 * que impede o número de ser confiável — insumo sem custo cadastrado é o caso
 * mais comum e faz o CMV parecer bom demais.
 */
function custoDaFicha(db, produtoId, { profundidade = 0, visitados = new Set() } = {}) {
  const avisos = [];

  if (visitados.has(produtoId)) {
    return { custoTotal: 0, custoPorcao: 0, itens: [], avisos: [`ciclo detectado no produto ${produtoId}`], ciclo: true };
  }
  if (profundidade > PROFUNDIDADE_MAX) {
    return { custoTotal: 0, custoPorcao: 0, itens: [], avisos: ['profundidade máxima de sub-receitas excedida'] };
  }

  const ficha = db.prepare('SELECT * FROM rest_fichas WHERE produtoId = ? AND ativo = 1').get(produtoId);
  if (!ficha) return { custoTotal: 0, custoPorcao: 0, itens: [], avisos: [], semFicha: true };

  const itens = db.prepare(`
    SELECT fi.*, p.descricao, p.unidade, p.precoCusto
      FROM rest_ficha_itens fi JOIN produtos p ON p.id = fi.insumoProdutoId
     WHERE fi.fichaId = ? ORDER BY fi.ordem, fi.id
  `).all(ficha.id);

  const proximosVisitados = new Set(visitados);
  proximosVisitados.add(produtoId);

  let custoTotal = 0;
  const detalhe = [];

  for (const it of itens) {
    const bruta = Number(it.quantidadeBruta || 0);
    const fc = Number(it.fatorCorrecao || 1) || 1;

    // O insumo tem ficha própria? Então o custo dele é o custo DA RECEITA
    // dele, não o preço de compra — que provavelmente nem existe, porque
    // molho da casa ninguém compra.
    const sub = custoDaFicha(db, it.insumoProdutoId, {
      profundidade: profundidade + 1, visitados: proximosVisitados,
    });

    let unitario;
    let origem;
    if (!sub.semFicha && !sub.ciclo && sub.custoPorcao > 0) {
      unitario = sub.custoPorcao;
      origem = 'sub-receita';
      avisos.push(...sub.avisos);
    } else {
      unitario = Number(it.precoCusto || 0);
      origem = 'compra';
      if (sub.ciclo) avisos.push(...sub.avisos);
      if (!(unitario > 0)) {
        avisos.push(`"${it.descricao}" está sem custo cadastrado — o CMV sai subestimado`);
      }
    }

    const custo = Math.round(bruta * unitario * 10000) / 10000;
    custoTotal += custo;
    detalhe.push({
      // id da linha da ficha: é por ele que a tela remove o insumo.
      id: it.id,
      insumoProdutoId: it.insumoProdutoId,
      descricao: it.descricao,
      unidade: it.unidade,
      quantidadeBruta: bruta,
      // Derivada, para a tela mostrar quanto realmente chega ao prato.
      quantidadeLiquida: Math.round((bruta / fc) * 10000) / 10000,
      fatorCorrecao: fc,
      fatorCoccao: Number(it.fatorCoccao || 1) || 1,
      custoUnitario: unitario,
      origemCusto: origem,
      custo: Math.round(custo * 100) / 100,
    });
  }

  const rendimento = Number(ficha.rendimento || 1) || 1;
  custoTotal = Math.round(custoTotal * 100) / 100;

  return {
    ficha,
    custoTotal,
    custoPorcao: Math.round((custoTotal / rendimento) * 10000) / 10000,
    rendimento,
    unidadeRendimento: ficha.unidadeRendimento,
    itens: detalhe,
    avisos: [...new Set(avisos)],
  };
}

/**
 * Baixa de estoque de um item vendido, explodindo a ficha.
 *
 * Chamada no FECHAMENTO da comanda, não no lançamento: item lançado ainda pode
 * ser cancelado, e baixar no lançamento faria o estoque dançar a cada
 * desistência de cliente.
 */
function baixarEstoqueDoItem(db, comandaItem, { profundidade = 0, visitados = new Set() } = {}) {
  const produtoId = comandaItem.produtoId;
  if (!produtoId) return { movimentos: 0 };          // linha de serviço (taxa)
  if (visitados.has(produtoId) || profundidade > PROFUNDIDADE_MAX) return { movimentos: 0 };

  const ficha = db.prepare('SELECT * FROM rest_fichas WHERE produtoId = ? AND ativo = 1').get(produtoId);
  const qtdVendida = Number(comandaItem.quantidade || 1);

  const insMov = db.prepare(`
    INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data)
    VALUES (?, 'saida', ?, ?, 'comanda', ?, ?, ?)
  `);

  // Sem ficha, baixa o próprio produto: é o caso da bebida de revenda.
  if (!ficha) {
    insMov.run(produtoId, qtdVendida, custoUnitarioInsumo(db, produtoId),
      comandaItem.comandaId, `Venda: ${comandaItem.descricao}`, agora());
    return { movimentos: 1 };
  }

  const rendimento = Number(ficha.rendimento || 1) || 1;
  const itens = db.prepare('SELECT * FROM rest_ficha_itens WHERE fichaId = ?').all(ficha.id);

  const proximos = new Set(visitados);
  proximos.add(produtoId);

  let movimentos = 0;
  for (const it of itens) {
    // A ficha rende N porções; uma venda consome a fração correspondente.
    const consumo = (Number(it.quantidadeBruta || 0) / rendimento) * qtdVendida;
    if (!(consumo > 0)) continue;

    const subFicha = db.prepare('SELECT id FROM rest_fichas WHERE produtoId = ? AND ativo = 1').get(it.insumoProdutoId);
    if (subFicha && !proximos.has(it.insumoProdutoId)) {
      // Sub-receita: desce em vez de baixar o "produto molho", que é abstrato
      // e normalmente não tem saldo próprio.
      const r = baixarEstoqueDoItem(db, {
        produtoId: it.insumoProdutoId,
        quantidade: consumo,
        comandaId: comandaItem.comandaId,
        descricao: `${comandaItem.descricao} › sub-receita`,
      }, { profundidade: profundidade + 1, visitados: proximos });
      movimentos += r.movimentos;
    } else {
      insMov.run(it.insumoProdutoId, Math.round(consumo * 10000) / 10000,
        custoUnitarioInsumo(db, it.insumoProdutoId), comandaItem.comandaId,
        `Ficha: ${comandaItem.descricao}`, agora());
      movimentos++;
    }
  }
  return { movimentos };
}

/**
 * Insumo das opções escolhidas no item (a embalagem, o molho à parte): cada
 * opção com `insumoProdutoId` baixa esse produto, na quantidade da opção vezes
 * a do item. Até 2026-09-27 o insumo era cadastrado na opção e ninguém o lia.
 */
function baixarInsumosDasOpcoes(db, comandaItem) {
  if (!comandaItem.id || !comandaItem.produtoId) return 0;
  const opcoes = db.prepare(`SELECT o.insumoProdutoId, o.quantidadeInsumo, o.nome
      FROM rest_comanda_item_opcoes io JOIN rest_opcoes o ON o.id = io.opcaoId
     WHERE io.comandaItemId = ? AND o.insumoProdutoId IS NOT NULL AND o.quantidadeInsumo > 0`)
    .all(comandaItem.id);
  const insMov = db.prepare(`
    INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data)
    VALUES (?, 'saida', ?, ?, 'comanda', ?, ?, ?)
  `);
  const qtdVendida = Number(comandaItem.quantidade || 1);
  for (const o of opcoes) {
    insMov.run(o.insumoProdutoId, Math.round(Number(o.quantidadeInsumo) * qtdVendida * 10000) / 10000,
      custoUnitarioInsumo(db, o.insumoProdutoId), comandaItem.comandaId,
      `Opção ${o.nome}: ${comandaItem.descricao}`, agora());
  }
  return opcoes.length;
}

/**
 * Baixa toda a comanda. Idempotente por comanda: se já houve baixa, não repete
 * — fechar a mesma conta duas vezes zeraria o estoque sem venda nenhuma.
 */
function baixarEstoqueComanda(db, comandaId) {
  const jaBaixou = db.prepare(
    "SELECT COUNT(*) AS n FROM movimentacoes_estoque WHERE origem = 'comanda' AND origemId = ?"
  ).get(comandaId);
  if (jaBaixou && jaBaixou.n > 0) return { jaBaixado: true, movimentos: 0 };

  const itens = db.prepare(
    "SELECT * FROM rest_comanda_itens WHERE comandaId = ? AND status <> 'cancelado'"
  ).all(comandaId);

  let movimentos = 0;
  const tx = db.transaction(() => {
    for (const it of itens) {
      movimentos += baixarEstoqueDoItem(db, it).movimentos;
      movimentos += baixarInsumosDasOpcoes(db, it);
    }
  });
  tx();
  return { jaBaixado: false, movimentos };
}

function registrarRotasFicha(app, db, gateFlag) {

  // ==================== FICHA TÉCNICA ====================

  app.get('/api/restaurante/fichas', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT f.*, p.sku, p.descricao, p.precoVenda,
               (SELECT COUNT(*) FROM rest_ficha_itens fi WHERE fi.fichaId = f.id) AS totalInsumos
          FROM rest_fichas f JOIN produtos p ON p.id = f.produtoId
         ORDER BY p.descricao
      `).all();
      for (const f of items) {
        const c = custoDaFicha(db, f.produtoId);
        f.custoPorcao = c.custoPorcao;
        // CMV% = custo ÷ preço de venda. Referência de mercado: 28% a 35%.
        f.cmvPct = f.precoVenda > 0 ? Math.round((c.custoPorcao / f.precoVenda) * 10000) / 100 : null;
        f.avisos = c.avisos;
      }
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/restaurante/fichas/:produtoId', gateFlag, (req, res) => {
    try {
      const p = db.prepare('SELECT id, sku, descricao, precoVenda, unidade FROM produtos WHERE id = ?')
        .get(req.params.produtoId);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      const c = custoDaFicha(db, Number(req.params.produtoId));
      res.json({
        success: true, produto: p, ficha: c.ficha || null, itens: c.itens,
        custoTotal: c.custoTotal, custoPorcao: c.custoPorcao,
        rendimento: c.rendimento, avisos: c.avisos,
        cmvPct: p.precoVenda > 0 ? Math.round((c.custoPorcao / p.precoVenda) * 10000) / 100 : null,
        margem: p.precoVenda > 0 ? Math.round((p.precoVenda - c.custoPorcao) * 100) / 100 : null,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/fichas/:produtoId', gateFlag, (req, res) => {
    try {
      const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(req.params.produtoId);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      const b = req.body || {};
      const rendimento = b.rendimento !== undefined ? Number(b.rendimento) : 1;
      if (!Number.isFinite(rendimento) || rendimento <= 0) {
        return res.status(400).json({ success: false, error: 'rendimento deve ser maior que zero' });
      }
      const atual = db.prepare('SELECT * FROM rest_fichas WHERE produtoId = ?').get(req.params.produtoId);
      if (atual) {
        db.prepare('UPDATE rest_fichas SET rendimento = ?, unidadeRendimento = ?, modoPreparo = ?, ativo = ? WHERE id = ?')
          .run(rendimento, b.unidadeRendimento || atual.unidadeRendimento,
            b.modoPreparo !== undefined ? b.modoPreparo : atual.modoPreparo,
            b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo, atual.id);
        res.json({ success: true, id: atual.id });
      } else {
        const r = db.prepare(`
          INSERT INTO rest_fichas (produtoId, rendimento, unidadeRendimento, modoPreparo, ativo)
          VALUES (?, ?, ?, ?, 1)
        `).run(req.params.produtoId, rendimento, b.unidadeRendimento || 'UN', b.modoPreparo || null);
        res.json({ success: true, id: r.lastInsertRowid });
      }
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/fichas/:produtoId/itens', gateFlag, (req, res) => {
    try {
      const ficha = db.prepare('SELECT * FROM rest_fichas WHERE produtoId = ?').get(req.params.produtoId);
      if (!ficha) return res.status(404).json({ success: false, error: 'crie a ficha antes de adicionar insumos' });

      const b = req.body || {};
      const insumoId = Number(b.insumoProdutoId);
      if (!insumoId) return res.status(400).json({ success: false, error: 'insumoProdutoId é obrigatório' });
      const insumo = db.prepare('SELECT * FROM produtos WHERE id = ?').get(insumoId);
      if (!insumo) return res.status(404).json({ success: false, error: 'insumo não encontrado' });
      // Prato que é insumo de si mesmo derruba a explosão de custo.
      if (insumoId === Number(req.params.produtoId)) {
        return res.status(400).json({ success: false, error: 'um item não pode ser insumo de si mesmo' });
      }

      const fc = b.fatorCorrecao !== undefined ? Number(b.fatorCorrecao) : 1;
      if (!Number.isFinite(fc) || fc <= 0) {
        return res.status(400).json({ success: false, error: 'fator de correção deve ser maior que zero' });
      }
      const fcoc = b.fatorCoccao !== undefined ? Number(b.fatorCoccao) : 1;
      if (!Number.isFinite(fcoc) || fcoc <= 0) {
        return res.status(400).json({ success: false, error: 'fator de cocção deve ser maior que zero' });
      }

      // Aceita informar a líquida (o que vai no prato) e converte para bruta,
      // que é o que sai do estoque. Quem pensa em receita pensa em líquido.
      let bruta;
      if (b.quantidadeLiquida !== undefined && b.quantidadeLiquida !== null && b.quantidadeLiquida !== '') {
        const liq = Number(b.quantidadeLiquida);
        if (!Number.isFinite(liq) || liq <= 0) return res.status(400).json({ success: false, error: 'quantidade inválida' });
        bruta = Math.round(liq * fc * 10000) / 10000;
      } else {
        bruta = Number(b.quantidadeBruta);
        if (!Number.isFinite(bruta) || bruta <= 0) return res.status(400).json({ success: false, error: 'quantidade inválida' });
      }

      // Cria o ciclo? Testa ANTES de gravar.
      const testeCiclo = criaCiclo(db, Number(req.params.produtoId), insumoId);
      if (testeCiclo) {
        return res.status(400).json({ success: false, error: 'esse insumo criaria um ciclo de sub-receitas' });
      }

      const r = db.prepare(`
        INSERT INTO rest_ficha_itens (fichaId, insumoProdutoId, quantidadeBruta, unidade, fatorCorrecao, fatorCoccao, ordem)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(ficha.id, insumoId, bruta, b.unidade || insumo.unidade || 'KG', fc, fcoc, Number(b.ordem) || 0);
      res.json({ success: true, id: r.lastInsertRowid, quantidadeBruta: bruta });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/ficha-itens/:id', gateFlag, (req, res) => {
    try {
      db.prepare('DELETE FROM rest_ficha_itens WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PRODUÇÃO EM LOTE ====================

  app.post('/api/restaurante/producoes', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const produtoId = Number(b.produtoId);
      const quantidade = Number(b.quantidade);
      if (!produtoId) return res.status(400).json({ success: false, error: 'produtoId é obrigatório' });
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        return res.status(400).json({ success: false, error: 'quantidade inválida' });
      }
      const ficha = db.prepare('SELECT * FROM rest_fichas WHERE produtoId = ? AND ativo = 1').get(produtoId);
      if (!ficha) return res.status(400).json({ success: false, error: 'produto sem ficha técnica ativa' });

      const c = custoDaFicha(db, produtoId);
      const custoTotal = Math.round(c.custoPorcao * quantidade * 100) / 100;

      const producaoId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO rest_producoes (produtoId, quantidade, custoTotal, data, usuario, observacao)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(produtoId, quantidade, custoTotal, agora(),
          (req.user && (req.user.nome || req.user.username)) || null, b.observacao || null);
        const id = r.lastInsertRowid;

        // Consome os insumos...
        const rendimento = Number(ficha.rendimento || 1) || 1;
        const itens = db.prepare('SELECT * FROM rest_ficha_itens WHERE fichaId = ?').all(ficha.id);
        const insMov = db.prepare(`
          INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data)
          VALUES (?, ?, ?, ?, 'producao', ?, ?, ?)
        `);
        for (const it of itens) {
          const consumo = (Number(it.quantidadeBruta || 0) / rendimento) * quantidade;
          if (consumo > 0) {
            insMov.run(it.insumoProdutoId, 'saida', Math.round(consumo * 10000) / 10000,
              custoUnitarioInsumo(db, it.insumoProdutoId), id, 'Produção em lote', agora());
          }
        }
        // ...e entra o produzido. Sem esta entrada o molho produzido não teria
        // saldo e a venda do prato baixaria os insumos de novo.
        insMov.run(produtoId, 'entrada', quantidade, c.custoPorcao, id, 'Produção em lote', agora());
        return id;
      })();

      res.json({ success: true, id: producaoId, custoTotal, custoUnitario: c.custoPorcao, avisos: c.avisos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/restaurante/producoes', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT pr.*, p.sku, p.descricao FROM rest_producoes pr
          JOIN produtos p ON p.id = pr.produtoId
         ORDER BY pr.id DESC LIMIT ?
      `).all(Number(req.query.limit) || 100);
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CMV ====================

  /**
   * CMV teórico × real.
   *   teórico = o que as fichas dizem que deveria ter sido consumido
   *   real    = o que de fato saiu do estoque no período
   * A diferença é o furo: desperdício, porção fora do padrão ou desvio.
   */
  app.get('/api/restaurante/cmv', gateFlag, (req, res) => {
    try {
      const de = req.query.de || '0000-01-01';
      const ate = req.query.ate || '9999-12-31';

      const vendas = db.prepare(`
        SELECT i.produtoId, i.descricao, SUM(i.quantidade) AS qtd, SUM(i.precoTotal) AS receita
          FROM rest_comanda_itens i JOIN rest_comandas c ON c.id = i.comandaId
         WHERE c.status = 'fechada' AND i.status <> 'cancelado'
           AND DATE(c.fechadaEm, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
         GROUP BY i.produtoId, i.descricao
      `).all(de, ate);

      let receitaTotal = 0, cmvTeorico = 0;
      const linhas = [];
      for (const v of vendas) {
        receitaTotal += Number(v.receita || 0);
        // Item sem produtoId (linha de serviço) não tem custo de ficha.
        const custoUnit = v.produtoId ? custoDaFicha(db, v.produtoId).custoPorcao : 0;
        const custo = Math.round(custoUnit * Number(v.qtd) * 100) / 100;
        cmvTeorico += custo;
        linhas.push({
          produtoId: v.produtoId, descricao: v.descricao,
          quantidade: Number(v.qtd), receita: Math.round(Number(v.receita) * 100) / 100,
          custoUnitario: custoUnit, custoTotal: custo,
          margem: Math.round((Number(v.receita) - custo) * 100) / 100,
          cmvPct: Number(v.receita) > 0 ? Math.round((custo / Number(v.receita)) * 10000) / 100 : null,
        });
      }

      const real = db.prepare(`
        SELECT COALESCE(SUM(quantidade * COALESCE(custoUnitario, 0)), 0) AS total
          FROM movimentacoes_estoque
         WHERE tipo = 'saida' AND origem IN ('comanda', 'producao')
           AND DATE(data, '${FUSO_LOCAL_SQL}') BETWEEN DATE(?) AND DATE(?)
      `).get(de, ate);

      const cmvReal = Math.round(Number(real.total || 0) * 100) / 100;
      receitaTotal = Math.round(receitaTotal * 100) / 100;
      cmvTeorico = Math.round(cmvTeorico * 100) / 100;

      res.json({
        success: true,
        periodo: { de, ate },
        receitaTotal,
        cmvTeorico,
        cmvReal,
        // A diferença é o número que o dono procura sem saber o nome.
        diferenca: Math.round((cmvReal - cmvTeorico) * 100) / 100,
        cmvTeoricoPct: receitaTotal > 0 ? Math.round((cmvTeorico / receitaTotal) * 10000) / 100 : null,
        cmvRealPct: receitaTotal > 0 ? Math.round((cmvReal / receitaTotal) * 10000) / 100 : null,
        // Faixa de referência do setor, para a tela não precisar decidir sozinha.
        referencia: { min: 28, max: 35 },
        itens: linhas.sort((a, b) => b.receita - a.receita),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Baixa manual (reprocessamento) — normalmente acontece no fechamento.
  app.post('/api/restaurante/comandas/:id/baixar-estoque', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      const r = baixarEstoqueComanda(db, c.id);
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de ficha técnica registradas');
}

/**
 * Adicionar `insumoId` à ficha de `produtoId` criaria ciclo?
 * Percorre a árvore de insumos do candidato procurando o produto de destino.
 */
function criaCiclo(db, produtoId, insumoId, profundidade = 0) {
  if (produtoId === insumoId) return true;
  if (profundidade > PROFUNDIDADE_MAX) return false;
  const ficha = db.prepare('SELECT id FROM rest_fichas WHERE produtoId = ?').get(insumoId);
  if (!ficha) return false;
  const itens = db.prepare('SELECT insumoProdutoId FROM rest_ficha_itens WHERE fichaId = ?').all(ficha.id);
  for (const it of itens) {
    if (criaCiclo(db, produtoId, it.insumoProdutoId, profundidade + 1)) return true;
  }
  return false;
}

module.exports = {
  registrarRotasFicha,
  custoDaFicha,
  baixarEstoqueComanda,
  baixarEstoqueDoItem,
  criaCiclo,
  PROFUNDIDADE_MAX,
};
