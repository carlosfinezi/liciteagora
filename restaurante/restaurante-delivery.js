/**
 * restaurante-delivery.js — Módulo Restaurante, fase 6: delivery próprio.
 *
 * O pedido de delivery NÃO é uma entidade nova: é uma comanda com
 * `tipo='delivery'`, o que a faz herdar de graça itens, opções, KDS,
 * fechamento e cupom fiscal. O que este arquivo acrescenta é o que só existe
 * quando a comida sai da casa:
 *
 *   rest_bairros_taxa — taxa e tempo estimado por bairro
 *   rest_entregadores — quem leva
 *   rest_entregas     — endereço, taxa cobrada, status da rota
 *
 * A taxa de entrega entra na comanda como `totalCouvert`? Não. Couvert é
 * outra coisa. A taxa vai em `rest_entregas.taxa` e é somada ao total pela
 * própria comanda via desconto negativo? Também não — gambiarra. Ela entra
 * como um ITEM de serviço na comanda, do mesmo jeito que a taxa de serviço
 * entra no cupom: assim aparece na conta, no cupom fiscal e no relatório sem
 * nenhum caminho especial.
 */

const { agora, registrarEvento, recalcularTotais } = require('./restaurante-comanda');

const STATUS_ENTREGA = ['pendente', 'em-rota', 'entregue', 'cancelada'];

const TRANSICOES_ENTREGA = {
  pendente: ['em-rota', 'cancelada'],
  'em-rota': ['entregue', 'cancelada'],
  entregue: [],
  cancelada: [],
};

// SKU do item de taxa de entrega dentro da comanda. Fixo de propósito: é por
// ele que a taxa é encontrada para atualizar ou remover quando o bairro muda.
const SKU_TAXA_ENTREGA = 'TAXA-ENTREGA';

/**
 * Sincroniza o item de taxa de entrega da comanda com o valor devido.
 * Cria, atualiza ou remove — é chamado toda vez que a entrega muda de bairro.
 */
function sincronizarItemTaxa(db, comandaId, valorTaxa) {
  const existente = db.prepare(
    "SELECT * FROM rest_comanda_itens WHERE comandaId = ? AND descricao = 'Taxa de entrega' AND status <> 'cancelado'"
  ).get(comandaId);

  const v = Math.round(Number(valorTaxa || 0) * 100) / 100;

  if (v <= 0) {
    if (existente) db.prepare('DELETE FROM rest_comanda_itens WHERE id = ?').run(existente.id);
  } else if (existente) {
    db.prepare('UPDATE rest_comanda_itens SET precoUnit = ?, precoTotal = ? WHERE id = ?')
      .run(v, v, existente.id);
  } else {
    // Sem produtoId e sem setor: é serviço, não vai para a cozinha nem baixa
    // estoque. `status='entregue'` para não poluir a fila do KDS.
    db.prepare(`
      INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal,
                                      status, lancadoEm, entregueEm)
      VALUES (?, NULL, 'Taxa de entrega', 1, ?, ?, 'entregue', ?, ?)
    `).run(comandaId, v, v, agora(), agora());
  }
  return recalcularTotais(db, comandaId);
}

function registrarRotasDelivery(app, db, gateFlag) {

  // ==================== BAIRROS E TAXAS ====================

  app.get('/api/restaurante/bairros', gateFlag, (req, res) => {
    try {
      res.json({ success: true, items: db.prepare('SELECT * FROM rest_bairros_taxa ORDER BY nome ASC').all() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/bairros', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const nome = String(b.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome é obrigatório' });
      const taxa = Number(b.taxa || 0);
      if (!Number.isFinite(taxa) || taxa < 0) return res.status(400).json({ success: false, error: 'taxa inválida' });
      const dup = db.prepare('SELECT id FROM rest_bairros_taxa WHERE LOWER(nome) = LOWER(?)').get(nome);
      if (dup) return res.status(400).json({ success: false, error: `bairro "${nome}" já cadastrado` });
      const r = db.prepare(
        'INSERT INTO rest_bairros_taxa (nome, taxa, tempoEstimadoMin, ativo) VALUES (?, ?, ?, ?)'
      ).run(nome, taxa, Number(b.tempoEstimadoMin) || 30, b.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/bairros/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_bairros_taxa WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'bairro não encontrado' });
      const b = req.body || {};
      if (b.taxa !== undefined && (!Number.isFinite(Number(b.taxa)) || Number(b.taxa) < 0)) {
        return res.status(400).json({ success: false, error: 'taxa inválida' });
      }
      db.prepare('UPDATE rest_bairros_taxa SET nome = ?, taxa = ?, tempoEstimadoMin = ?, ativo = ? WHERE id = ?').run(
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.taxa !== undefined ? Number(b.taxa) : atual.taxa,
        b.tempoEstimadoMin !== undefined ? Number(b.tempoEstimadoMin) : atual.tempoEstimadoMin,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/bairros/:id', gateFlag, (req, res) => {
    try {
      const emUso = db.prepare('SELECT COUNT(*) AS n FROM rest_entregas WHERE bairroId = ?').get(req.params.id);
      if (emUso && emUso.n > 0) {
        return res.status(400).json({ success: false, error: `bairro usado em ${emUso.n} entrega(s) — desative` });
      }
      db.prepare('DELETE FROM rest_bairros_taxa WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ENTREGADORES ====================

  app.get('/api/restaurante/entregadores', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT e.*,
               (SELECT COUNT(*) FROM rest_entregas x WHERE x.entregadorId = e.id AND x.status = 'em-rota') AS emRota
          FROM rest_entregadores e ORDER BY e.nome ASC
      `).all();
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/entregadores', gateFlag, (req, res) => {
    try {
      const nome = String(req.body?.nome || '').trim();
      if (!nome) return res.status(400).json({ success: false, error: 'nome é obrigatório' });
      const r = db.prepare('INSERT INTO rest_entregadores (nome, pessoaId, telefone, ativo) VALUES (?, ?, ?, ?)')
        .run(nome, req.body?.pessoaId ? Number(req.body.pessoaId) : null,
          req.body?.telefone || null, req.body?.ativo === 0 ? 0 : 1);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/restaurante/entregadores/:id', gateFlag, (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM rest_entregadores WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'entregador não encontrado' });
      const b = req.body || {};
      db.prepare('UPDATE rest_entregadores SET nome = ?, telefone = ?, ativo = ? WHERE id = ?').run(
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.telefone !== undefined ? (b.telefone || null) : atual.telefone,
        b.ativo !== undefined ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id,
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ENTREGAS ====================

  app.get('/api/restaurante/entregas', gateFlag, (req, res) => {
    try {
      const status = req.query.status;
      let sql = `
        SELECT e.*, c.status AS comandaStatus, c.totalGeral, c.canalExterno, c.pedidoExternoId,
               b.nome AS bairroNome, b.tempoEstimadoMin, en.nome AS entregadorNome
          FROM rest_entregas e
          JOIN rest_comandas c        ON c.id = e.comandaId
          LEFT JOIN rest_bairros_taxa b ON b.id = e.bairroId
          LEFT JOIN rest_entregadores en ON en.id = e.entregadorId
      `;
      const p = [];
      if (status) { sql += ' WHERE e.status = ?'; p.push(status); }
      sql += ' ORDER BY e.id DESC LIMIT ?'; p.push(Number(req.query.limit) || 200);
      const items = db.prepare(sql).all(...p);

      // Itens do pedido junto: a tela de delivery precisa mostrar o que sai.
      for (const e of items) {
        e.itens = db.prepare(
          "SELECT descricao, quantidade, status FROM rest_comanda_itens WHERE comandaId = ? AND status <> 'cancelado'"
        ).all(e.comandaId);
      }
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/comandas/:id/entrega', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });

      const b = req.body || {};
      let taxa = 0, bairroId = null;
      if (b.bairroId) {
        const bairro = db.prepare('SELECT * FROM rest_bairros_taxa WHERE id = ?').get(Number(b.bairroId));
        if (!bairro) return res.status(404).json({ success: false, error: 'bairro não encontrado' });
        if (!bairro.ativo) return res.status(400).json({ success: false, error: `não entregamos no bairro ${bairro.nome}` });
        bairroId = bairro.id;
        taxa = Number(bairro.taxa);
      }
      // Taxa informada à mão vence a do bairro (negociação pontual do balcão).
      if (b.taxa !== undefined && b.taxa !== null && b.taxa !== '') {
        const t = Number(b.taxa);
        if (!Number.isFinite(t) || t < 0) return res.status(400).json({ success: false, error: 'taxa inválida' });
        taxa = t;
      }

      const existente = db.prepare('SELECT * FROM rest_entregas WHERE comandaId = ?').get(c.id);
      if (existente) {
        db.prepare(`
          UPDATE rest_entregas SET bairroId = ?, endereco = ?, numero = ?, complemento = ?, referencia = ?, taxa = ?
           WHERE id = ?
        `).run(bairroId, b.endereco || existente.endereco, b.numero || existente.numero,
          b.complemento !== undefined ? b.complemento : existente.complemento,
          b.referencia !== undefined ? b.referencia : existente.referencia, taxa, existente.id);
      } else {
        if (!String(b.endereco || '').trim()) {
          return res.status(400).json({ success: false, error: 'endereço é obrigatório' });
        }
        db.prepare(`
          INSERT INTO rest_entregas (comandaId, bairroId, endereco, numero, complemento, referencia, taxa, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente')
        `).run(c.id, bairroId, String(b.endereco).trim(), b.numero || null,
          b.complemento || null, b.referencia || null, taxa);
      }

      const comanda = sincronizarItemTaxa(db, c.id, taxa);
      res.json({
        success: true,
        entrega: db.prepare('SELECT * FROM rest_entregas WHERE comandaId = ?').get(c.id),
        comanda,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/entregas/:id/status', gateFlag, (req, res) => {
    try {
      const e = db.prepare('SELECT * FROM rest_entregas WHERE id = ?').get(req.params.id);
      if (!e) return res.status(404).json({ success: false, error: 'entrega não encontrada' });

      const destino = String(req.body?.status || '');
      const permitidos = TRANSICOES_ENTREGA[e.status] || [];
      if (!permitidos.includes(destino)) {
        return res.status(400).json({
          success: false, error: `não dá para ir de "${e.status}" para "${destino || '—'}"`, permitidos,
        });
      }

      if (destino === 'em-rota') {
        const entregadorId = req.body?.entregadorId ? Number(req.body.entregadorId) : e.entregadorId;
        // Sair para entrega sem entregador deixa o pedido na rua sem dono —
        // é o dado que falta justamente quando o cliente liga perguntando.
        if (!entregadorId) return res.status(400).json({ success: false, error: 'informe o entregador' });
        const en = db.prepare('SELECT * FROM rest_entregadores WHERE id = ?').get(entregadorId);
        if (!en) return res.status(404).json({ success: false, error: 'entregador não encontrado' });
        if (!en.ativo) return res.status(400).json({ success: false, error: `${en.nome} está inativo` });
        db.prepare("UPDATE rest_entregas SET status = 'em-rota', entregadorId = ?, saiuEm = ? WHERE id = ?")
          .run(entregadorId, agora(), req.params.id);
        registrarEvento(db, e.comandaId, 'saiu-para-entrega', `Saiu com ${en.nome}`, null);
      } else if (destino === 'entregue') {
        db.prepare("UPDATE rest_entregas SET status = 'entregue', entregueEm = ? WHERE id = ?")
          .run(agora(), req.params.id);
        registrarEvento(db, e.comandaId, 'entregue', 'Pedido entregue ao cliente', null);
      } else {
        db.prepare("UPDATE rest_entregas SET status = 'cancelada' WHERE id = ?").run(req.params.id);
        registrarEvento(db, e.comandaId, 'entrega-cancelada', req.body?.motivo || 'sem motivo informado', null);
      }

      res.json({ success: true, entrega: db.prepare('SELECT * FROM rest_entregas WHERE id = ?').get(req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Acerto do entregador: quanto ele levou, quanto recebeu em dinheiro e
   * quantas entregas fez no período. É o fechamento que o motoboy faz no fim
   * do turno.
   */
  app.get('/api/restaurante/entregadores/:id/acerto', gateFlag, (req, res) => {
    try {
      const en = db.prepare('SELECT * FROM rest_entregadores WHERE id = ?').get(req.params.id);
      if (!en) return res.status(404).json({ success: false, error: 'entregador não encontrado' });

      const de = req.query.de || '0000-01-01';
      const ate = req.query.ate || '9999-12-31';

      const entregas = db.prepare(`
        SELECT e.*, c.totalGeral, c.totalPago, b.nome AS bairroNome
          FROM rest_entregas e
          JOIN rest_comandas c ON c.id = e.comandaId
          LEFT JOIN rest_bairros_taxa b ON b.id = e.bairroId
         WHERE e.entregadorId = ? AND e.status = 'entregue'
           AND DATE(e.entregueEm) BETWEEN DATE(?) AND DATE(?)
         ORDER BY e.entregueEm
      `).all(req.params.id, de, ate);

      const comandaIds = entregas.map(e => e.comandaId);
      let dinheiro = 0;
      if (comandaIds.length) {
        const r = db.prepare(`
          SELECT COALESCE(SUM(valor), 0) AS total FROM rest_comanda_pagamentos
           WHERE comandaId IN (${comandaIds.map(() => '?').join(',')})
             AND (LOWER(meioPagamento) LIKE '%dinheiro%' OR LOWER(meioPagamento) LIKE '%espécie%')
        `).get(...comandaIds);
        dinheiro = Number(r.total || 0);
      }

      res.json({
        success: true,
        entregador: en,
        periodo: { de, ate },
        entregas,
        resumo: {
          quantidade: entregas.length,
          totalTaxas: Math.round(entregas.reduce((s, e) => s + Number(e.taxa || 0), 0) * 100) / 100,
          totalPedidos: Math.round(entregas.reduce((s, e) => s + Number(e.totalGeral || 0), 0) * 100) / 100,
          // O que ele tem de devolver ao caixa.
          dinheiroARepassar: Math.round(dinheiro * 100) / 100,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de delivery registradas');
}

module.exports = {
  registrarRotasDelivery,
  sincronizarItemTaxa,
  STATUS_ENTREGA,
  TRANSICOES_ENTREGA,
  SKU_TAXA_ENTREGA,
};
