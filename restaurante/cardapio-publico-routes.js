/**
 * cardapio-publico-routes.js — Cardápio do cliente por QR Code (PRÉ-AUTH).
 *
 * Espelha o desenho da loja virtual (loja-routes.registrarRotasLojaPublica):
 * rotas sob `/cardapio/api/*`, registradas ANTES do app.use(requireAuth) em
 * server.js — por isso NÃO usam o prefixo /api/, que é a área protegida.
 *
 * Dois usos, com o mesmo cardápio:
 *   1. Mesa — o cliente escaneia o QR da mesa, vê o cardápio e chama o garçom.
 *      Ele NÃO fecha conta nem paga aqui; quem lança item continua sendo o
 *      salão, e é assim de propósito: pedido entrando sozinho na comanda sem
 *      ninguém conferir é o caminho mais curto para pedido trote.
 *   2. Delivery — o cliente monta o pedido e envia. Aí sim nasce uma comanda,
 *      mas em estado que exige aceite do balcão antes de ir para a cozinha.
 *
 * Nada aqui expõe custo, margem, fornecedor ou qualquer dado de outro tenant:
 * as consultas são todas escopadas no db do tenant resolvido pelo host.
 */

const { agora, registrarEvento } = require('./restaurante-comanda');

// Limite defensivo do pedido público: sem isto, um POST malicioso pode criar
// uma comanda com dez mil itens e travar a cozinha.
const MAX_ITENS_PEDIDO = 50;
const MAX_QTD_ITEM = 99;

function flagLigada(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'restaurante_enabled'").get();
    return !!(r && r.valor === '1');
  } catch (_) { return false; }
}

function cardapioPublicoLigado(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'restaurante_cardapio_publico'").get();
    // Default LIGADO seria expor o cardápio de todo tenant que ativar o módulo
    // sem ter pedido isso. Fica desligado até alguém decidir publicar.
    return !!(r && r.valor === '1');
  } catch (_) { return false; }
}

function registrarRotasCardapioPublico(app, db, deps) {
  const { cardapioVigente, itensDoCardapio } = deps;

  // Portão único das rotas públicas.
  function gatePublico(req, res, next) {
    if (!flagLigada(db)) return res.status(404).json({ success: false, error: 'não disponível' });
    if (!cardapioPublicoLigado(db)) {
      return res.status(404).json({ success: false, error: 'cardápio online não publicado' });
    }
    next();
  }

  app.get('/cardapio/api/config', gatePublico, (req, res) => {
    try {
      const nome = db.prepare("SELECT valor FROM config WHERE chave = 'restaurante_nome_publico'").get();
      const aceita = db.prepare("SELECT valor FROM config WHERE chave = 'restaurante_aceita_pedido_online'").get();
      res.json({
        success: true,
        nome: (nome && nome.valor) || 'Cardápio',
        aceitaPedidoOnline: !!(aceita && aceita.valor === '1'),
        canais: ['salao', 'delivery'],
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/cardapio/api/itens', gatePublico, (req, res) => {
    try {
      const canal = ['salao', 'delivery', 'balcao'].includes(req.query.canal) ? req.query.canal : 'salao';
      const c = cardapioVigente(db, canal, new Date());
      if (!c) return res.json({ success: true, cardapio: null, categorias: [], fechado: true });

      const itens = itensDoCardapio(db, c.id, { soDisponiveis: true });

      // Agrupa por categoria preservando a ordem que o lojista definiu.
      const categorias = [];
      for (const i of itens) {
        const nome = i.categoria || 'Outros';
        let g = categorias.find(x => x.nome === nome);
        if (!g) { g = { nome, itens: [] }; categorias.push(g); }
        g.itens.push({
          // Lista de campos explícita: SELECT * aqui publicaria precoCusto.
          produtoId: i.produtoId,
          descricao: i.descricao,
          preco: i.preco,
          pesavel: !!i.pesavel,
          precoPorKg: i.precoPorKg,
          tempoPreparoMin: i.tempoPreparoMin,
          grupos: (i.grupos || []).map(g2 => ({
            id: g2.id, nome: g2.nome, minEscolhas: g2.minEscolhas, maxEscolhas: g2.maxEscolhas,
            opcoes: (g2.opcoes || []).map(o => ({ id: o.id, nome: o.nome, precoAdicional: o.precoAdicional })),
          })),
        });
      }
      res.json({ success: true, cardapio: { id: c.id, nome: c.nome, canal: c.canal }, categorias, fechado: false });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/cardapio/api/bairros', gatePublico, (req, res) => {
    try {
      const items = db.prepare(
        'SELECT id, nome, taxa, tempoEstimadoMin FROM rest_bairros_taxa WHERE ativo = 1 ORDER BY nome'
      ).all();
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Cliente na mesa chamando o garçom pelo QR.
  app.post('/cardapio/api/chamar-garcom', gatePublico, (req, res) => {
    try {
      const numero = String(req.body?.mesa || '').trim();
      if (!numero) return res.status(400).json({ success: false, error: 'mesa não informada' });
      const mesa = db.prepare('SELECT * FROM rest_mesas WHERE numero = ? AND ativo = 1').get(numero);
      if (!mesa) return res.status(404).json({ success: false, error: 'mesa não encontrada' });

      const comanda = db.prepare("SELECT id FROM rest_comandas WHERE mesaId = ? AND status = 'aberta'").get(mesa.id);
      if (!comanda) {
        return res.status(400).json({ success: false, error: 'nenhuma conta aberta nesta mesa — chame no balcão' });
      }
      registrarEvento(db, comanda.id, 'chamada-garcom',
        `Cliente chamou pelo QR da mesa ${numero}`, 'cliente');
      db.prepare('UPDATE rest_comandas SET versao = versao + 1 WHERE id = ?').run(comanda.id);
      res.json({ success: true, mensagem: 'Garçom chamado' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Pedido de delivery feito pelo cliente.
   *
   * Nasce como comanda `tipo='delivery'` com observação marcando que veio do
   * canal público e AINDA NÃO ACEITO. O balcão precisa aceitar antes de a
   * cozinha ver — sem esse passo, qualquer um na internet enfileira pedido
   * falso na chapa.
   */
  app.post('/cardapio/api/pedido', gatePublico, (req, res) => {
    try {
      const aceita = db.prepare("SELECT valor FROM config WHERE chave = 'restaurante_aceita_pedido_online'").get();
      if (!aceita || aceita.valor !== '1') {
        return res.status(400).json({ success: false, error: 'pedidos online estão fechados no momento' });
      }

      const b = req.body || {};
      const itens = Array.isArray(b.itens) ? b.itens : [];
      if (!itens.length) return res.status(400).json({ success: false, error: 'pedido sem itens' });
      if (itens.length > MAX_ITENS_PEDIDO) {
        return res.status(400).json({ success: false, error: `máximo de ${MAX_ITENS_PEDIDO} itens por pedido` });
      }
      const nome = String(b.nome || '').trim();
      const telefone = String(b.telefone || '').replace(/\D/g, '');
      if (nome.length < 2) return res.status(400).json({ success: false, error: 'informe seu nome' });
      if (telefone.length < 10) return res.status(400).json({ success: false, error: 'informe um telefone válido' });
      if (!String(b.endereco || '').trim()) return res.status(400).json({ success: false, error: 'informe o endereço' });

      const cardapio = cardapioVigente(db, 'delivery', new Date());
      if (!cardapio) return res.status(400).json({ success: false, error: 'fora do horário de entrega' });

      // Valida tudo ANTES de criar a comanda: pedido meio criado é pior do que
      // pedido recusado.
      const preparados = [];
      for (const it of itens) {
        const produtoId = Number(it.produtoId);
        const qtd = Number(it.quantidade || 1);
        if (!produtoId) return res.status(400).json({ success: false, error: 'item sem produto' });
        if (!Number.isFinite(qtd) || qtd <= 0 || qtd > MAX_QTD_ITEM) {
          return res.status(400).json({ success: false, error: 'quantidade inválida' });
        }
        const linha = db.prepare(`
          SELECT ci.preco, ci.disponivel, p.descricao
            FROM rest_cardapio_itens ci JOIN produtos p ON p.id = ci.produtoId
           WHERE ci.cardapioId = ? AND ci.produtoId = ?
        `).get(cardapio.id, produtoId);
        // Preço vem SEMPRE do servidor. O que o cliente mandar é ignorado.
        if (!linha) return res.status(400).json({ success: false, error: 'item fora do cardápio' });
        if (!linha.disponivel) {
          return res.status(400).json({ success: false, error: `"${linha.descricao}" acabou` });
        }

        const opcaoIds = Array.isArray(it.opcaoIds) ? it.opcaoIds.map(Number).filter(Boolean) : [];
        const opcoes = opcaoIds.length ? db.prepare(`
          SELECT o.* FROM rest_opcoes o
            JOIN rest_produto_grupos pg ON pg.grupoId = o.grupoId AND pg.produtoId = ?
           WHERE o.id IN (${opcaoIds.map(() => '?').join(',')}) AND o.ativo = 1
        `).all(produtoId, ...opcaoIds) : [];
        if (opcoes.length !== opcaoIds.length) {
          return res.status(400).json({ success: false, error: 'opção inválida no pedido' });
        }
        // Grupo obrigatório vale igual no canal público.
        const grupos = db.prepare(`
          SELECT g.* FROM rest_produto_grupos pg JOIN rest_grupos_opcao g ON g.id = pg.grupoId
           WHERE pg.produtoId = ? AND g.ativo = 1
        `).all(produtoId);
        for (const g of grupos) {
          const n = opcoes.filter(o => o.grupoId === g.id).length;
          if (n < g.minEscolhas || n > g.maxEscolhas) {
            return res.status(400).json({ success: false, error: `"${g.nome}": escolha inválida` });
          }
        }

        const adicional = opcoes.reduce((s, o) => s + Number(o.precoAdicional || 0), 0);
        preparados.push({
          produtoId, descricao: linha.descricao, quantidade: qtd,
          precoUnit: Number(linha.preco),
          precoTotal: Math.round((Number(linha.preco) + adicional) * qtd * 100) / 100,
          observacao: it.observacao ? String(it.observacao).slice(0, 200) : null,
          opcoes,
        });
      }

      let bairro = null;
      if (b.bairroId) {
        bairro = db.prepare('SELECT * FROM rest_bairros_taxa WHERE id = ? AND ativo = 1').get(Number(b.bairroId));
        if (!bairro) return res.status(400).json({ success: false, error: 'não entregamos nesse bairro' });
      }

      const comandaId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO rest_comandas (tipo, canal, status, numeroPessoas, abertaEm, observacao,
                                     taxaServicoPct, canalExterno)
          VALUES ('delivery', 'delivery', 'aberta', 1, ?, ?, 0, 'cardapio-online')
        `).run(agora(), `PEDIDO ONLINE — AGUARDANDO ACEITE · ${nome} · ${telefone}`);
        const id = r.lastInsertRowid;

        const insIt = db.prepare(`
          INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal,
                                          observacao, status, setorId, lancadoEm)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)
        `);
        const insOp = db.prepare(
          'INSERT INTO rest_comanda_item_opcoes (comandaItemId, opcaoId, nome, precoAdicional) VALUES (?, ?, ?, ?)'
        );
        for (const it of preparados) {
          const cfg = db.prepare('SELECT setorId FROM rest_produto_config WHERE produtoId = ?').get(it.produtoId);
          const itemId = insIt.run(id, it.produtoId, it.descricao, it.quantidade, it.precoUnit,
            it.precoTotal, it.observacao, cfg ? cfg.setorId : null, agora()).lastInsertRowid;
          for (const o of it.opcoes) insOp.run(itemId, o.id, o.nome, o.precoAdicional);
        }

        db.prepare(`
          INSERT INTO rest_entregas (comandaId, bairroId, endereco, numero, complemento, referencia, taxa, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente')
        `).run(id, bairro ? bairro.id : null, String(b.endereco).trim(),
          b.numero || null, b.complemento || null, b.referencia || null, bairro ? Number(bairro.taxa) : 0);

        return id;
      })();

      // A taxa de entrega e os totais entram fora da transação porque
      // recalcularTotais faz suas próprias escritas.
      const { sincronizarItemTaxa } = require('./restaurante-delivery');
      const comanda = sincronizarItemTaxa(db, comandaId, bairro ? Number(bairro.taxa) : 0);
      registrarEvento(db, comandaId, 'pedido-online',
        `${nome} · ${telefone} · ${preparados.length} item(ns)`, 'cliente');

      res.json({
        success: true,
        pedidoId: comandaId,
        total: comanda.totalGeral,
        taxaEntrega: bairro ? Number(bairro.taxa) : 0,
        tempoEstimadoMin: bairro ? bairro.tempoEstimadoMin : null,
        mensagem: 'Pedido recebido — aguarde a confirmação do restaurante',
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Acompanhamento pelo cliente: devolve só o estado, nunca dados de outros.
  app.get('/cardapio/api/pedido/:id', gatePublico, (req, res) => {
    try {
      const c = db.prepare(
        "SELECT id, status, totalGeral, observacao, canalExterno FROM rest_comandas WHERE id = ? AND canalExterno = 'cardapio-online'"
      ).get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'pedido não encontrado' });
      const e = db.prepare('SELECT status, saiuEm, entregueEm FROM rest_entregas WHERE comandaId = ?').get(c.id);
      const itens = db.prepare(
        "SELECT descricao, quantidade, status FROM rest_comanda_itens WHERE comandaId = ? AND status <> 'cancelado'"
      ).all(c.id);
      const aguardando = /AGUARDANDO ACEITE/.test(c.observacao || '');
      res.json({
        success: true,
        pedido: {
          id: c.id,
          total: c.totalGeral,
          situacao: c.status === 'cancelada' ? 'recusado'
            : aguardando ? 'aguardando confirmação'
            : e && e.status === 'entregue' ? 'entregue'
            : e && e.status === 'em-rota' ? 'saiu para entrega'
            : itens.every(i => i.status === 'pronto' || i.status === 'entregue') ? 'pronto'
            : 'em preparo',
          itens: itens.map(i => ({ descricao: i.descricao, quantidade: i.quantidade })),
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Cardápio público registrado (pré-auth)');
}

/**
 * Aceite do pedido online pelo balcão — rota PROTEGIDA, registrada junto das
 * demais /api/restaurante/*. Sem o aceite o pedido não é tratado como firme.
 */
function registrarRotasAceite(app, db, gateFlag) {
  app.get('/api/restaurante/pedidos-online', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT c.*, e.endereco, e.numero, e.taxa, b.nome AS bairroNome
          FROM rest_comandas c
          LEFT JOIN rest_entregas e ON e.comandaId = c.id
          LEFT JOIN rest_bairros_taxa b ON b.id = e.bairroId
         WHERE c.canalExterno = 'cardapio-online' AND c.status = 'aberta'
           AND c.observacao LIKE '%AGUARDANDO ACEITE%'
         ORDER BY c.id DESC
      `).all();
      for (const c of items) {
        c.itens = db.prepare(
          "SELECT descricao, quantidade, precoTotal FROM rest_comanda_itens WHERE comandaId = ? AND status <> 'cancelado'"
        ).all(c.id);
      }
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/pedidos-online/:id/aceitar', gateFlag, (req, res) => {
    try {
      const c = db.prepare("SELECT * FROM rest_comandas WHERE id = ? AND canalExterno = 'cardapio-online'").get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'pedido não encontrado' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'pedido não está aberto' });
      if (!/AGUARDANDO ACEITE/.test(c.observacao || '')) {
        return res.status(400).json({ success: false, error: 'pedido já foi aceito' });
      }
      // Tirar a marca é o que libera o pedido: a cozinha já enxerga os itens
      // (eles nascem 'pendente'), mas o balcão passa a tratá-lo como firme.
      db.prepare('UPDATE rest_comandas SET observacao = ?, versao = versao + 1 WHERE id = ?')
        .run(String(c.observacao || '').replace('PEDIDO ONLINE — AGUARDANDO ACEITE', 'PEDIDO ONLINE'), c.id);
      registrarEvento(db, c.id, 'pedido-aceito', 'Pedido online aceito pelo balcão',
        (req.user && (req.user.nome || req.user.username)) || null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/pedidos-online/:id/recusar', gateFlag, (req, res) => {
    try {
      const c = db.prepare("SELECT * FROM rest_comandas WHERE id = ? AND canalExterno = 'cardapio-online'").get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'pedido não encontrado' });
      const motivo = String(req.body?.motivo || '').trim();
      if (motivo.length < 3) return res.status(400).json({ success: false, error: 'informe o motivo da recusa' });
      db.transaction(() => {
        db.prepare("UPDATE rest_comanda_itens SET status = 'cancelado', canceladoEm = ?, canceladoMotivo = ? WHERE comandaId = ?")
          .run(agora(), motivo, c.id);
        db.prepare("UPDATE rest_entregas SET status = 'cancelada' WHERE comandaId = ?").run(c.id);
        db.prepare("UPDATE rest_comandas SET status = 'cancelada', fechadaEm = ? WHERE id = ?").run(agora(), c.id);
      })();
      registrarEvento(db, c.id, 'pedido-recusado', motivo,
        (req.user && (req.user.nome || req.user.username)) || null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasCardapioPublico, registrarRotasAceite, MAX_ITENS_PEDIDO };
