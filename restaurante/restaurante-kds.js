/**
 * restaurante-kds.js — Módulo Restaurante, fase 3: painel de cozinha (KDS).
 *
 * A fila da cozinha é uma VISÃO dos itens de comanda, não uma tabela nova: o
 * item já carrega `setorId` (de rest_produto_config) e `status`. O KDS só
 * filtra, ordena por antiguidade e calcula atraso.
 *
 * Fluxo do item:
 *   pendente → em-preparo → pronto → entregue
 *   (qualquer um → cancelado, pela rota de cancelamento da comanda)
 *
 * Tempo real SEM WebSocket: o servidor não tem SSE nem ws, e a decisão do
 * projeto foi não introduzir. O painel faz polling curto contra
 * /api/restaurante/kds/versao, que é uma consulta barata (COUNT + MAX) e só
 * baixa a fila inteira quando a versão muda. Com 2–5 telas por tenant isso
 * custa menos do que manter conexões vivas.
 */

const { agora, registrarEvento, minutosDesde } = require('./restaurante-comanda');

// Só estes dois estados ocupam a cozinha. 'entregue' sai da fila.
const STATUS_FILA = ['pendente', 'em-preparo', 'pronto'];

// Para onde cada estado pode ir. Pular etapa esconde tempo de preparo real,
// que é justamente o que o painel existe para medir.
const TRANSICOES = {
  pendente: ['em-preparo', 'pronto'],   // item simples pode ir direto a pronto
  'em-preparo': ['pronto'],
  pronto: ['entregue'],
  entregue: [],
  cancelado: [],
};

const CAMPO_DATA = {
  'em-preparo': 'preparoEm',
  pronto: 'prontoEm',
  entregue: 'entregueEm',
};

/**
 * Fila da cozinha. Cada item ganha o tempo em fila e a marca de atraso,
 * comparada com o tempo de preparo configurado no produto.
 */
function filaKds(db, { setorId = null, incluirProntos = true } = {}) {
  const status = incluirProntos ? STATUS_FILA : ['pendente', 'em-preparo'];
  const params = [...status];
  let sql = `
    SELECT i.id, i.comandaId, i.produtoId, i.descricao, i.quantidade, i.observacao,
           i.status, i.setorId, i.lancadoEm, i.preparoEm, i.prontoEm, i.pesoKg,
           s.nome AS setorNome, s.codigo AS setorCodigo,
           c.tipo AS comandaTipo, c.codigo AS comandaCodigo, c.senhaChamada, c.canal,
           m.numero AS mesaNumero,
           pc.tempoPreparoMin
      FROM rest_comanda_itens i
      JOIN rest_comandas c        ON c.id = i.comandaId
      LEFT JOIN rest_mesas m      ON m.id = c.mesaId
      LEFT JOIN rest_setores s    ON s.id = i.setorId
      LEFT JOIN rest_produto_config pc ON pc.produtoId = i.produtoId
     WHERE i.status IN (${status.map(() => '?').join(',')})
       AND c.status = 'aberta'
  `;
  if (setorId != null) { sql += ' AND i.setorId = ?'; params.push(setorId); }
  // Mais antigo primeiro: a cozinha trabalha por ordem de chegada.
  sql += ' ORDER BY i.lancadoEm ASC, i.id ASC';

  const itens = db.prepare(sql).all(...params);

  for (const it of itens) {
    it.minutosEmFila = minutosDesde(it.lancadoEm);
    it.minutosNoPreparo = it.preparoEm ? minutosDesde(it.preparoEm) : null;
    // Atraso é medido contra o tempo configurado; sem configuração não há
    // promessa a cumprir e o item nunca aparece como atrasado.
    const alvo = Number(it.tempoPreparoMin || 0);
    it.atrasado = alvo > 0 && it.status !== 'pronto' && (it.minutosEmFila || 0) > alvo;
    it.opcoes = db.prepare('SELECT nome, precoAdicional FROM rest_comanda_item_opcoes WHERE comandaItemId = ?').all(it.id);
    it.identificacao = it.mesaNumero ? `Mesa ${it.mesaNumero}`
      : it.senhaChamada ? `Senha #${it.senhaChamada}`
      : it.comandaCodigo ? `Cartão ${it.comandaCodigo}`
      : `${it.comandaTipo} #${it.comandaId}`;
  }
  return itens;
}

function registrarRotasKds(app, db, gateFlag) {

  // Sinal barato para o polling: muda quando qualquer coisa da fila muda.
  // A tela só baixa a fila inteira quando este número se mexe.
  app.get('/api/restaurante/kds/versao', gateFlag, (req, res) => {
    try {
      const r = db.prepare(`
        SELECT COUNT(*) AS n,
               COALESCE(MAX(i.id), 0) AS maxId,
               COALESCE(SUM(CASE i.status WHEN 'pendente' THEN 1 WHEN 'em-preparo' THEN 2 ELSE 3 END), 0) AS soma
          FROM rest_comanda_itens i
          JOIN rest_comandas c ON c.id = i.comandaId
         WHERE i.status IN ('pendente','em-preparo','pronto') AND c.status = 'aberta'
      `).get();
      res.json({ success: true, versao: `${r.n}.${r.maxId}.${r.soma}`, total: r.n });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/restaurante/kds', gateFlag, (req, res) => {
    try {
      let setorId = null;
      if (req.query.setor) {
        // Aceita id ou código ('chapa') — a tela usa o código, que é estável.
        const s = /^\d+$/.test(String(req.query.setor))
          ? db.prepare('SELECT * FROM rest_setores WHERE id = ?').get(Number(req.query.setor))
          : db.prepare('SELECT * FROM rest_setores WHERE codigo = ?').get(String(req.query.setor));
        if (!s) return res.status(404).json({ success: false, error: 'setor não encontrado' });
        setorId = s.id;
      }
      const itens = filaKds(db, { setorId, incluirProntos: req.query.prontos !== '0' });
      const setores = db.prepare('SELECT * FROM rest_setores WHERE ativo = 1 ORDER BY ordem ASC').all();

      // Contagem por setor: alimenta as abas do painel sem uma 2ª chamada.
      const porSetor = {};
      for (const s of setores) porSetor[s.codigo] = 0;
      for (const it of filaKds(db, { incluirProntos: false })) {
        if (it.setorCodigo) porSetor[it.setorCodigo] = (porSetor[it.setorCodigo] || 0) + 1;
      }

      res.json({
        success: true,
        itens,
        setores,
        porSetor,
        resumo: {
          pendentes: itens.filter(i => i.status === 'pendente').length,
          emPreparo: itens.filter(i => i.status === 'em-preparo').length,
          prontos: itens.filter(i => i.status === 'pronto').length,
          atrasados: itens.filter(i => i.atrasado).length,
          semSetor: itens.filter(i => !i.setorId).length,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Transição de status do item — o botão do painel.
  app.post('/api/restaurante/comanda-itens/:id/status', gateFlag, (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM rest_comanda_itens WHERE id = ?').get(req.params.id);
      if (!item) return res.status(404).json({ success: false, error: 'item não encontrado' });

      const destino = String(req.body?.status || '');
      const permitidos = TRANSICOES[item.status];
      if (!permitidos) return res.status(400).json({ success: false, error: `status atual inválido: ${item.status}` });
      if (!permitidos.includes(destino)) {
        return res.status(400).json({
          success: false,
          error: `não dá para ir de "${item.status}" para "${destino || '—'}"`,
          permitidos,
        });
      }

      const comanda = db.prepare('SELECT status FROM rest_comandas WHERE id = ?').get(item.comandaId);
      if (comanda.status !== 'aberta') {
        return res.status(400).json({ success: false, error: 'comanda não está aberta' });
      }

      const campo = CAMPO_DATA[destino];
      // Ir direto de pendente para pronto deixaria preparoEm nulo e o tempo de
      // preparo real ficaria sem base — carimba o início junto.
      if (destino === 'pronto' && !item.preparoEm) {
        db.prepare('UPDATE rest_comanda_itens SET preparoEm = ? WHERE id = ?').run(item.lancadoEm, req.params.id);
      }
      db.prepare(`UPDATE rest_comanda_itens SET status = ?, ${campo} = ? WHERE id = ?`)
        .run(destino, agora(), req.params.id);

      db.prepare('UPDATE rest_comandas SET versao = versao + 1 WHERE id = ?').run(item.comandaId);
      if (destino === 'pronto') {
        registrarEvento(db, item.comandaId, 'item-pronto', `${item.descricao} pronto`, 'cozinha');
      }

      const atualizado = db.prepare('SELECT * FROM rest_comanda_itens WHERE id = ?').get(req.params.id);
      res.json({ success: true, item: atualizado });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // "Sair tudo": marca todos os itens prontos de uma comanda como entregues.
  app.post('/api/restaurante/comandas/:id/entregar-prontos', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });
      const r = db.prepare(
        "UPDATE rest_comanda_itens SET status = 'entregue', entregueEm = ? WHERE comandaId = ? AND status = 'pronto'"
      ).run(agora(), req.params.id);
      db.prepare('UPDATE rest_comandas SET versao = versao + 1 WHERE id = ?').run(req.params.id);
      res.json({ success: true, entregues: r.changes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Painel de retirada (fast-food): senhas com pedido pronto. Sem gate de
  // setor — é a tela que fica virada para o cliente.
  app.get('/api/restaurante/painel-retirada', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT c.id, c.senhaChamada,
               SUM(CASE WHEN i.status IN ('pendente','em-preparo') THEN 1 ELSE 0 END) AS emPreparo,
               SUM(CASE WHEN i.status = 'pronto' THEN 1 ELSE 0 END) AS prontos
          FROM rest_comandas c
          JOIN rest_comanda_itens i ON i.comandaId = c.id AND i.status <> 'cancelado'
         WHERE c.status = 'aberta' AND c.senhaChamada IS NOT NULL
         GROUP BY c.id, c.senhaChamada
         ORDER BY CAST(c.senhaChamada AS INTEGER) ASC
      `).all();
      res.json({
        success: true,
        // Pronto = nada mais em preparo. Chamar a senha com item faltando
        // manda o cliente ao balcão para esperar de pé.
        prontas: items.filter(i => i.emPreparo === 0 && i.prontos > 0).map(i => i.senhaChamada),
        preparando: items.filter(i => i.emPreparo > 0).map(i => i.senhaChamada),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de KDS registradas');
}

module.exports = { registrarRotasKds, filaKds, TRANSICOES, STATUS_FILA };
