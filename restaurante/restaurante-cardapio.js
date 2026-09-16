/**
 * restaurante-cardapio.js — Módulo Restaurante, fase 1: cardápio.
 *
 * O item vendável continua sendo `produtos` (herda NCM/CFOP/CST, motor de
 * tributação, estoque e NFC-e). O que este arquivo acrescenta:
 *
 *   rest_cardapios        — um por canal: salão, balcão, delivery, quilo
 *   rest_cardapio_itens   — o PREÇO mora aqui, não em produtos: o mesmo prato
 *                           custa diferente no salão e no delivery
 *   rest_cardapio_horarios— faixa de vigência (almoço, jantar, happy hour)
 *   rest_grupos_opcao     — "Ponto da carne" (1..1), "Adicionais" (0..5)
 *   rest_opcoes           — as escolhas de cada grupo, com preço adicional
 *   rest_produto_config   — setor de produção, tempo de preparo, pesável
 *
 * A resolução do cardápio vigente (canal + dia + hora) é a peça central:
 * é dela que o garçom, o cardápio público do QR e o iFood tiram o que
 * mostrar e por quanto.
 */

const CANAIS = ['salao', 'balcao', 'delivery', 'quilo'];
const TIPOS_ITEM = ['preparado', 'revenda', 'servico'];

// "HH:MM" -> minutos desde a meia-noite. Devolve null se não parsear.
function hhmmParaMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * A faixa cobre o instante? Trata a virada da meia-noite, que é o caso comum
 * de bar: 18:00–02:00 não é "início maior que fim, logo inválido" — é uma
 * faixa que atravessa o dia.
 */
function faixaCobre(horaIni, horaFim, minutoAtual) {
  const ini = hhmmParaMin(horaIni), fim = hhmmParaMin(horaFim);
  if (ini == null || fim == null) return false;
  if (ini <= fim) return minutoAtual >= ini && minutoAtual <= fim;
  return minutoAtual >= ini || minutoAtual <= fim;   // atravessa a meia-noite
}

/**
 * Cardápio vigente para um canal num instante.
 *
 * Regra: entre os cardápios ativos do canal, vence o de MENOR `ordem` que
 * tenha faixa de horário cobrindo agora. Cardápio sem nenhuma faixa vale
 * o dia inteiro (é o caso default de quem não usa horário). Se nada casar
 * por horário, cai no primeiro sem faixa; se nem isso, devolve null.
 */
function cardapioVigente(db, canal, quando) {
  const d = quando instanceof Date ? quando : new Date();
  const diaSemana = d.getDay();
  const minutoAtual = d.getHours() * 60 + d.getMinutes();

  const cardapios = db.prepare(
    'SELECT * FROM rest_cardapios WHERE canal = ? AND ativo = 1 ORDER BY ordem ASC, id ASC'
  ).all(canal);
  if (!cardapios.length) return null;

  const stmtHor = db.prepare('SELECT * FROM rest_cardapio_horarios WHERE cardapioId = ?');
  let semFaixa = null;

  for (const c of cardapios) {
    const faixas = stmtHor.all(c.id);
    if (!faixas.length) { if (!semFaixa) semFaixa = c; continue; }
    for (const f of faixas) {
      if (f.diaSemana != null && Number(f.diaSemana) !== diaSemana) continue;
      if (faixaCobre(f.horaIni, f.horaFim, minutoAtual)) return c;
    }
  }
  return semFaixa;
}

// Itens de um cardápio, já com o que a tela e o KDS precisam.
function itensDoCardapio(db, cardapioId, { soDisponiveis = false } = {}) {
  const itens = db.prepare(`
    SELECT ci.id, ci.cardapioId, ci.produtoId, ci.categoria, ci.preco, ci.ordem, ci.disponivel,
           p.sku, p.descricao, p.unidade, p.precoCusto,
           pc.setorId, pc.tempoPreparoMin, pc.tipoItem, pc.imprimeCozinha, pc.pesavel, pc.precoPorKg,
           s.nome AS setorNome, s.codigo AS setorCodigo
      FROM rest_cardapio_itens ci
      JOIN produtos p            ON p.id  = ci.produtoId
      LEFT JOIN rest_produto_config pc ON pc.produtoId = ci.produtoId
      LEFT JOIN rest_setores s   ON s.id  = pc.setorId
     WHERE ci.cardapioId = ?
       ${soDisponiveis ? 'AND ci.disponivel = 1 AND p.ativo = 1' : ''}
     ORDER BY ci.categoria IS NULL, ci.categoria ASC, ci.ordem ASC, p.descricao ASC
  `).all(cardapioId);

  // Grupos de opção por produto, numa consulta só (evita N+1 no cardápio).
  if (itens.length) {
    const ids = itens.map(i => i.produtoId);
    const grupos = db.prepare(`
      SELECT pg.produtoId, g.id, g.nome, g.minEscolhas, g.maxEscolhas, g.ordem
        FROM rest_produto_grupos pg
        JOIN rest_grupos_opcao g ON g.id = pg.grupoId
       WHERE pg.produtoId IN (${ids.map(() => '?').join(',')}) AND g.ativo = 1
       ORDER BY pg.ordem ASC, g.ordem ASC
    `).all(...ids);

    const opcoesPorGrupo = new Map();
    if (grupos.length) {
      const gids = [...new Set(grupos.map(g => g.id))];
      const opcoes = db.prepare(`
        SELECT id, grupoId, nome, precoAdicional, ordem
          FROM rest_opcoes
         WHERE grupoId IN (${gids.map(() => '?').join(',')}) AND ativo = 1
         ORDER BY ordem ASC, nome ASC
      `).all(...gids);
      for (const o of opcoes) {
        if (!opcoesPorGrupo.has(o.grupoId)) opcoesPorGrupo.set(o.grupoId, []);
        opcoesPorGrupo.get(o.grupoId).push(o);
      }
    }

    const gruposPorProduto = new Map();
    for (const g of grupos) {
      if (!gruposPorProduto.has(g.produtoId)) gruposPorProduto.set(g.produtoId, []);
      gruposPorProduto.get(g.produtoId).push({ ...g, opcoes: opcoesPorGrupo.get(g.id) || [] });
    }
    for (const it of itens) it.grupos = gruposPorProduto.get(it.produtoId) || [];
  }

  return itens;
}

function registrarRotasCardapio(app, db, gateFlag) {

  // ==================== CARDÁPIOS ====================

  app.get('/api/restaurante/cardapios', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT c.*,
               (SELECT COUNT(*) FROM rest_cardapio_itens ci WHERE ci.cardapioId = c.id) AS totalItens
          FROM rest_cardapios c ORDER BY c.ordem ASC, c.nome ASC
      `).all();
      for (const c of items) {
        c.horarios = db.prepare('SELECT * FROM rest_cardapio_horarios WHERE cardapioId = ? ORDER BY id').all(c.id);
      }
      res.json({ success: true, items, canais: CANAIS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/cardapios', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const nome = String(b.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome é obrigatório' });
      const canal = String(b.canal || 'salao');
      if (!CANAIS.includes(canal)) return res.status(400).json({ success: false, error: 'canal inválido' });
      const r = db.prepare('INSERT INTO rest_cardapios (nome, canal, ordem, ativo) VALUES (?, ?, ?, ?)')
        .run(nome, canal, Number(b.ordem) || 0, b.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/cardapios/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_cardapios WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'cardápio não encontrado' });
      const b = req.body || {};
      if (b.canal !== undefined && !CANAIS.includes(b.canal)) {
        return res.status(400).json({ success: false, error: 'canal inválido' });
      }
      db.prepare('UPDATE rest_cardapios SET nome = ?, canal = ?, ordem = ?, ativo = ? WHERE id = ?').run(
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.canal !== undefined ? b.canal : atual.canal,
        b.ordem !== undefined ? Number(b.ordem) : atual.ordem,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/cardapios/:id', gateFlag, (req, res) => {
    try {
      db.prepare('DELETE FROM rest_cardapios WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Cardápio que vale AGORA num canal — o que o garçom, o QR e o iFood leem.
  app.get('/api/restaurante/cardapio-vigente', gateFlag, (req, res) => {
    try {
      const canal = String(req.query.canal || 'salao');
      if (!CANAIS.includes(canal)) return res.status(400).json({ success: false, error: 'canal inválido' });
      // `quando` existe para teste e para pré-visualização ("como fica às 22h?").
      const quando = req.query.quando ? new Date(req.query.quando) : new Date();
      if (isNaN(quando.getTime())) return res.status(400).json({ success: false, error: 'data inválida' });
      const c = cardapioVigente(db, canal, quando);
      if (!c) return res.json({ success: true, cardapio: null, itens: [] });
      res.json({ success: true, cardapio: c, itens: itensDoCardapio(db, c.id, { soDisponiveis: true }) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ITENS DO CARDÁPIO ====================

  app.get('/api/restaurante/cardapios/:id/itens', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_cardapios WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'cardápio não encontrado' });
      res.json({ success: true, cardapio: c, items: itensDoCardapio(db, c.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/cardapios/:id/itens', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT id FROM rest_cardapios WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'cardápio não encontrado' });
      const b = req.body || {};
      const produtoId = Number(b.produtoId);
      if (!produtoId) return res.status(400).json({ success: false, error: 'produtoId é obrigatório' });
      const p = db.prepare('SELECT id, precoVenda FROM produtos WHERE id = ?').get(produtoId);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      const dup = db.prepare('SELECT id FROM rest_cardapio_itens WHERE cardapioId = ? AND produtoId = ?')
        .get(req.params.id, produtoId);
      if (dup) return res.status(400).json({ success: false, error: 'produto já está neste cardápio' });
      // Sem preço informado, herda o do cadastro — o preço do cardápio só
      // precisa ser digitado quando difere do padrão.
      const preco = b.preco !== undefined && b.preco !== '' ? Number(b.preco) : Number(p.precoVenda || 0);
      if (!Number.isFinite(preco) || preco < 0) return res.status(400).json({ success: false, error: 'preço inválido' });
      const r = db.prepare(`
        INSERT INTO rest_cardapio_itens (cardapioId, produtoId, categoria, preco, ordem, disponivel)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.params.id, produtoId, b.categoria || null, preco,
        Number(b.ordem) || 0, b.disponivel === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid, preco });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/cardapio-itens/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_cardapio_itens WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'item não encontrado' });
      const b = req.body || {};
      if (b.preco !== undefined) {
        const preco = Number(b.preco);
        if (!Number.isFinite(preco) || preco < 0) return res.status(400).json({ success: false, error: 'preço inválido' });
      }
      db.prepare(`
        UPDATE rest_cardapio_itens SET categoria = ?, preco = ?, ordem = ?, disponivel = ? WHERE id = ?
      `).run(
        b.categoria !== undefined ? (b.categoria || null) : atual.categoria,
        b.preco !== undefined ? Number(b.preco) : atual.preco,
        b.ordem !== undefined ? Number(b.ordem) : atual.ordem,
        b.disponivel !== undefined ? (b.disponivel ? 1 : 0) : atual.disponivel,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/cardapio-itens/:id', gateFlag, (req, res) => {
    try {
      db.prepare('DELETE FROM rest_cardapio_itens WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Botão "acabou": 86 no jargão de cozinha. É a operação mais usada do dia.
  app.post('/api/restaurante/cardapio-itens/:id/disponibilidade', gateFlag, (req, res) => {
    try {
      const it = db.prepare('SELECT id FROM rest_cardapio_itens WHERE id = ?').get(req.params.id);
      if (!it) return res.status(404).json({ success: false, error: 'item não encontrado' });
      const disponivel = req.body?.disponivel ? 1 : 0;
      db.prepare('UPDATE rest_cardapio_itens SET disponivel = ? WHERE id = ?').run(disponivel, req.params.id);
      res.json({ success: true, disponivel });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== HORÁRIOS ====================

  app.post('/api/restaurante/cardapios/:id/horarios', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT id FROM rest_cardapios WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'cardápio não encontrado' });
      const b = req.body || {};
      if (hhmmParaMin(b.horaIni) == null || hhmmParaMin(b.horaFim) == null) {
        return res.status(400).json({ success: false, error: 'horário inválido (use HH:MM)' });
      }
      let dia = null;
      if (b.diaSemana !== undefined && b.diaSemana !== null && b.diaSemana !== '') {
        dia = Number(b.diaSemana);
        if (!Number.isInteger(dia) || dia < 0 || dia > 6) {
          return res.status(400).json({ success: false, error: 'diaSemana deve ser 0..6' });
        }
      }
      const r = db.prepare(
        'INSERT INTO rest_cardapio_horarios (cardapioId, diaSemana, horaIni, horaFim) VALUES (?, ?, ?, ?)'
      ).run(req.params.id, dia, String(b.horaIni), String(b.horaFim));
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/cardapio-horarios/:id', gateFlag, (req, res) => {
    try {
      db.prepare('DELETE FROM rest_cardapio_horarios WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== GRUPOS DE OPÇÃO ====================

  app.get('/api/restaurante/grupos-opcao', gateFlag, (req, res) => {
    try {
      const items = db.prepare('SELECT * FROM rest_grupos_opcao ORDER BY ordem ASC, nome ASC').all();
      for (const g of items) {
        g.opcoes = db.prepare('SELECT * FROM rest_opcoes WHERE grupoId = ? ORDER BY ordem ASC, nome ASC').all(g.id);
      }
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/grupos-opcao', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const nome = String(b.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome é obrigatório' });
      const min = b.minEscolhas !== undefined ? Number(b.minEscolhas) : 0;
      const max = b.maxEscolhas !== undefined ? Number(b.maxEscolhas) : 1;
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1) {
        return res.status(400).json({ success: false, error: 'min/max inválidos' });
      }
      if (min > max) return res.status(400).json({ success: false, error: 'mínimo não pode ser maior que o máximo' });
      const r = db.prepare(
        'INSERT INTO rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ordem, ativo) VALUES (?, ?, ?, ?, ?)'
      ).run(nome, min, max, Number(b.ordem) || 0, b.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/grupos-opcao/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_grupos_opcao WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'grupo não encontrado' });
      const b = req.body || {};
      const min = b.minEscolhas !== undefined ? Number(b.minEscolhas) : atual.minEscolhas;
      const max = b.maxEscolhas !== undefined ? Number(b.maxEscolhas) : atual.maxEscolhas;
      if (min > max) return res.status(400).json({ success: false, error: 'mínimo não pode ser maior que o máximo' });
      db.prepare('UPDATE rest_grupos_opcao SET nome = ?, minEscolhas = ?, maxEscolhas = ?, ordem = ?, ativo = ? WHERE id = ?')
        .run(
          b.nome !== undefined ? String(b.nome).trim() : atual.nome,
          min, max,
          b.ordem !== undefined ? Number(b.ordem) : atual.ordem,
          b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
          req.params.id,
        );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/grupos-opcao/:id', gateFlag, (req, res) => {
    try {
      const emUso = db.prepare('SELECT COUNT(*) AS n FROM rest_produto_grupos WHERE grupoId = ?').get(req.params.id);
      if (emUso && emUso.n > 0) {
        return res.status(400).json({ success: false, error: `grupo usado por ${emUso.n} produto(s)` });
      }
      db.prepare('DELETE FROM rest_grupos_opcao WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== OPÇÕES ====================

  app.post('/api/restaurante/grupos-opcao/:id/opcoes', gateFlag, (req, res) => {
    try {
      const g = db.prepare('SELECT id FROM rest_grupos_opcao WHERE id = ?').get(req.params.id);
      if (!g) return res.status(404).json({ success: false, error: 'grupo não encontrado' });
      const b = req.body || {};
      const nome = String(b.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome é obrigatório' });
      const preco = b.precoAdicional !== undefined ? Number(b.precoAdicional) : 0;
      if (!Number.isFinite(preco)) return res.status(400).json({ success: false, error: 'preço adicional inválido' });
      if (b.insumoProdutoId) {
        const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(Number(b.insumoProdutoId));
        if (!p) return res.status(404).json({ success: false, error: 'insumo não encontrado' });
      }
      const r = db.prepare(`
        INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, insumoProdutoId, quantidadeInsumo, ordem, ativo)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, nome, preco,
        b.insumoProdutoId ? Number(b.insumoProdutoId) : null,
        b.quantidadeInsumo != null ? Number(b.quantidadeInsumo) : null,
        Number(b.ordem) || 0, b.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/opcoes/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_opcoes WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'opção não encontrada' });
      const b = req.body || {};
      db.prepare(`
        UPDATE rest_opcoes SET nome = ?, precoAdicional = ?, insumoProdutoId = ?, quantidadeInsumo = ?, ordem = ?, ativo = ?
         WHERE id = ?
      `).run(
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.precoAdicional !== undefined ? Number(b.precoAdicional) : atual.precoAdicional,
        b.insumoProdutoId !== undefined ? (b.insumoProdutoId ? Number(b.insumoProdutoId) : null) : atual.insumoProdutoId,
        b.quantidadeInsumo !== undefined ? (b.quantidadeInsumo != null ? Number(b.quantidadeInsumo) : null) : atual.quantidadeInsumo,
        b.ordem !== undefined ? Number(b.ordem) : atual.ordem,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/opcoes/:id', gateFlag, (req, res) => {
    try {
      db.prepare('DELETE FROM rest_opcoes WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CONFIG DO PRODUTO (setor, tempo, pesável) ====================

  app.get('/api/restaurante/produtos/:id/config', gateFlag, (req, res) => {
    try {
      const p = db.prepare('SELECT id, sku, descricao, unidade, precoVenda, precoCusto FROM produtos WHERE id = ?')
        .get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      const cfg = db.prepare('SELECT * FROM rest_produto_config WHERE produtoId = ?').get(req.params.id) || null;
      const grupos = db.prepare(`
        SELECT g.*, pg.ordem AS ordemVinculo FROM rest_produto_grupos pg
          JOIN rest_grupos_opcao g ON g.id = pg.grupoId
         WHERE pg.produtoId = ? ORDER BY pg.ordem ASC
      `).all(req.params.id);
      res.json({ success: true, produto: p, config: cfg, grupos, tiposItem: TIPOS_ITEM });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/produtos/:id/config', gateFlag, (req, res) => {
    try {
      const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      const b = req.body || {};
      if (b.tipoItem !== undefined && !TIPOS_ITEM.includes(b.tipoItem)) {
        return res.status(400).json({ success: false, error: 'tipoItem inválido' });
      }
      if (b.setorId) {
        const s = db.prepare('SELECT id FROM rest_setores WHERE id = ?').get(Number(b.setorId));
        if (!s) return res.status(404).json({ success: false, error: 'setor não encontrado' });
      }
      // Item pesável (self-service por quilo) precisa de preço por kg: sem ele
      // a balança manda peso e o PDV não sabe por quanto multiplicar.
      const pesavel = b.pesavel ? 1 : 0;
      const precoPorKg = b.precoPorKg != null && b.precoPorKg !== '' ? Number(b.precoPorKg) : null;
      if (pesavel && !(precoPorKg > 0)) {
        return res.status(400).json({ success: false, error: 'item pesável exige preço por kg' });
      }
      const atual = db.prepare('SELECT * FROM rest_produto_config WHERE produtoId = ?').get(req.params.id);
      if (atual) {
        db.prepare(`
          UPDATE rest_produto_config SET setorId = ?, tempoPreparoMin = ?, tipoItem = ?,
                 imprimeCozinha = ?, pesavel = ?, precoPorKg = ? WHERE produtoId = ?
        `).run(
          b.setorId !== undefined ? (b.setorId ? Number(b.setorId) : null) : atual.setorId,
          b.tempoPreparoMin !== undefined ? Number(b.tempoPreparoMin) : atual.tempoPreparoMin,
          b.tipoItem !== undefined ? b.tipoItem : atual.tipoItem,
          b.imprimeCozinha !== undefined ? (b.imprimeCozinha ? 1 : 0) : atual.imprimeCozinha,
          pesavel, precoPorKg, req.params.id,
        );
      } else {
        db.prepare(`
          INSERT INTO rest_produto_config (produtoId, setorId, tempoPreparoMin, tipoItem, imprimeCozinha, pesavel, precoPorKg)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          req.params.id,
          b.setorId ? Number(b.setorId) : null,
          Number(b.tempoPreparoMin) || 0,
          b.tipoItem || 'preparado',
          b.imprimeCozinha === 0 ? 0 : 1,
          pesavel, precoPorKg,
        );
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Vínculo produto ↔ grupos de opção (substitui o conjunto inteiro).
  app.put('/api/restaurante/produtos/:id/grupos', gateFlag, (req, res) => {
    try {
      const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      const ids = Array.isArray(req.body?.grupoIds) ? req.body.grupoIds.map(Number) : null;
      if (!ids) return res.status(400).json({ success: false, error: 'grupoIds deve ser uma lista' });
      for (const gid of ids) {
        const g = db.prepare('SELECT id FROM rest_grupos_opcao WHERE id = ?').get(gid);
        if (!g) return res.status(404).json({ success: false, error: `grupo ${gid} não encontrado` });
      }
      const tx = db.transaction(() => {
        db.prepare('DELETE FROM rest_produto_grupos WHERE produtoId = ?').run(req.params.id);
        const ins = db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId, ordem) VALUES (?, ?, ?)');
        ids.forEach((gid, i) => ins.run(req.params.id, gid, i));
      });
      tx();
      res.json({ success: true, vinculados: ids.length });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de cardápio registradas');
}

module.exports = {
  registrarRotasCardapio,
  cardapioVigente,
  itensDoCardapio,
  faixaCobre,
  hhmmParaMin,
  CANAIS,
  TIPOS_ITEM,
};
