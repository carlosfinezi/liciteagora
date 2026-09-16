/**
 * ifood-routes.js — Módulo Restaurante, fase 7: integração iFood.
 *
 * Transforma evento do iFood em comanda `tipo='delivery'`, reaproveitando todo
 * o resto do módulo (KDS, fechamento, cupom). O que este arquivo garante:
 *
 *  IDEMPOTÊNCIA. O iFood REENTREGA evento não confirmado, e um pedido virando
 *  duas comandas é dinheiro e comida perdidos. Três camadas:
 *    1. UNIQUE(canal, eventoId) em rest_canal_eventos — o mesmo evento não
 *       é gravado duas vezes;
 *    2. busca por pedidoExternoId antes de criar comanda — dois eventos
 *       diferentes do MESMO pedido não criam duas;
 *    3. ACK sempre que o evento foi persistido, mesmo se o processamento
 *       falhar. Sem isso, um pedido malformado ficaria voltando para sempre,
 *       travando a fila inteira atrás dele.
 *
 *  O item do iFood NÃO vira produto do catálogo automaticamente. O pedido é
 *  gravado com o nome e o preço que vieram deles (produtoId nulo), porque
 *  casar item de marketplace com SKU interno por nome é chute — e chute aqui
 *  baixa o estoque errado. O de-para explícito fica para quem quiser fazê-lo
 *  no cadastro (campo `codigoExterno`).
 */

const cliente = require('./ifood-client');
const { agora, registrarEvento, recalcularTotais } = require('./restaurante-comanda');

const CANAL = 'ifood';

// Eventos que interessam. O iFood manda vários outros (handshake, etc.).
const EVENTOS_TRATADOS = ['PLACED', 'CONFIRMED', 'CANCELLED', 'CANCELLATION_REQUESTED', 'CONCLUDED', 'DISPATCHED'];

function lerCanal(db, canal = CANAL) {
  try {
    return db.prepare('SELECT * FROM rest_canais_integracao WHERE canal = ?').get(canal) || null;
  } catch (_) { return null; }
}

/**
 * Devolve um accessToken válido, renovando se necessário.
 */
async function tokenValido(db, cfg, baseUrl) {
  const agoraMs = Date.now();
  if (cfg.accessToken && cfg.tokenExpiraEm && cfg.tokenExpiraEm - cliente.FOLGA_TOKEN_MS > agoraMs) {
    return cfg.accessToken;
  }
  const t = await cliente.autenticar({
    clientId: cfg.clientId, clientSecret: cfg.clientSecret, baseUrl,
  });
  db.prepare('UPDATE rest_canais_integracao SET accessToken = ?, tokenExpiraEm = ? WHERE id = ?')
    .run(t.accessToken, t.expiraEm, cfg.id);
  return t.accessToken;
}

/**
 * Cria a comanda a partir de um pedido normalizado.
 * Se o pedido externo já tem comanda, devolve a existente — esta é a 2ª
 * camada de idempotência.
 */
function criarComandaDoPedido(db, pedido) {
  const existente = db.prepare(
    "SELECT * FROM rest_comandas WHERE canalExterno = ? AND pedidoExternoId = ?"
  ).get(CANAL, pedido.idExterno);
  if (existente) return { comandaId: existente.id, jaExistia: true };

  const comandaId = db.transaction(() => {
    const rotulo = pedido.numeroDisplay ? `iFood #${pedido.numeroDisplay}` : `iFood ${pedido.idExterno.slice(0, 8)}`;
    const r = db.prepare(`
      INSERT INTO rest_comandas (tipo, canal, status, numeroPessoas, abertaEm, observacao,
                                 taxaServicoPct, canalExterno, pedidoExternoId, codigo)
      VALUES ('delivery', 'delivery', 'aberta', 1, ?, ?, 0, ?, ?, ?)
    `).run(
      agora(),
      [rotulo, pedido.cliente.nome, pedido.cliente.telefone, pedido.observacao]
        .filter(Boolean).join(' · '),
      CANAL, pedido.idExterno, pedido.numeroDisplay || null,
    );
    const id = r.lastInsertRowid;

    const insIt = db.prepare(`
      INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal,
                                      observacao, status, setorId, lancadoEm)
      VALUES (?, NULL, ?, ?, ?, ?, ?, 'pendente', ?, ?)
    `);
    const insOp = db.prepare(
      'INSERT INTO rest_comanda_item_opcoes (comandaItemId, opcaoId, nome, precoAdicional) VALUES (?, NULL, ?, ?)'
    );

    for (const it of pedido.itens) {
      // Tenta achar o setor por de-para de código externo. Sem match, o item
      // cai sem setor e aparece na aba "Todos" do KDS — visível, nunca perdido.
      let setorId = null;
      if (it.codigoExterno) {
        const p = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(String(it.codigoExterno));
        if (p) {
          const c = db.prepare('SELECT setorId FROM rest_produto_config WHERE produtoId = ?').get(p.id);
          if (c) setorId = c.setorId;
        }
      }
      const itemId = insIt.run(id, it.nome, it.quantidade, it.precoUnitario, it.precoTotal,
        it.observacao, setorId, agora()).lastInsertRowid;
      for (const o of it.opcoes) insOp.run(itemId, o.nome, o.preco);
    }

    // Taxa de entrega como linha própria: o total da comanda tem de bater com
    // o total que o iFood mostrou ao cliente.
    if (pedido.taxaEntrega > 0) {
      db.prepare(`
        INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal,
                                        status, lancadoEm, entregueEm)
        VALUES (?, NULL, 'Taxa de entrega (iFood)', 1, ?, ?, 'entregue', ?, ?)
      `).run(id, pedido.taxaEntrega, pedido.taxaEntrega, agora(), agora());
    }

    db.prepare(`
      INSERT INTO rest_entregas (comandaId, endereco, numero, complemento, referencia, taxa, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pendente')
    `).run(id,
      [pedido.endereco.logradouro, pedido.endereco.bairro].filter(Boolean).join(' - ') || 'Endereço no app iFood',
      pedido.endereco.numero, pedido.endereco.complemento, pedido.endereco.referencia,
      pedido.taxaEntrega);

    return id;
  })();

  recalcularTotais(db, comandaId);

  // Confere o total montado contra o que o iFood informou. O layout deles já
  // mudou de forma entre versões (complemento dentro ou fora do totalPrice do
  // item), e uma divergência silenciosa vira diferença de caixa que ninguém
  // rastreia. O pedido ENTRA de qualquer jeito — recusar comida que já está
  // sendo esperada é pior —, mas a divergência fica registrada.
  if (pedido.total > 0) {
    const c = db.prepare('SELECT totalGeral FROM rest_comandas WHERE id = ?').get(comandaId);
    const dif = Math.round((Number(c.totalGeral) - pedido.total) * 100);
    if (Math.abs(dif) > 2) {
      registrarEvento(db, comandaId, 'ifood-divergencia',
        `Total calculado R$ ${Number(c.totalGeral).toFixed(2)} ≠ total do iFood R$ ${pedido.total.toFixed(2)}`,
        'ifood');
    }
  }

  // Pedido pago no app já entra quitado: cobrar de novo na entrega é o erro
  // mais caro que essa integração pode cometer.
  if (pedido.pagamento.online) {
    const c = db.prepare('SELECT totalGeral FROM rest_comandas WHERE id = ?').get(comandaId);
    db.prepare(`
      INSERT INTO rest_comanda_pagamentos (comandaId, meioPagamento, valor, nomePagador, criadoEm)
      VALUES (?, 'iFood (pago no app)', ?, ?, ?)
    `).run(comandaId, c.totalGeral, pedido.cliente.nome, agora());
    recalcularTotais(db, comandaId);
  }

  registrarEvento(db, comandaId, 'ifood-recebido',
    `Pedido ${pedido.numeroDisplay || pedido.idExterno} · ${pedido.itens.length} item(ns)`
    + (pedido.pagamento.online ? ' · PAGO NO APP' : ' · a receber na entrega'), 'ifood');

  return { comandaId, jaExistia: false };
}

/**
 * Processa um evento já persistido. Não lança: devolve o erro para ser
 * gravado na linha do evento — quem chama precisa dar ACK de qualquer forma.
 */
async function processarEvento(db, evento, ctx) {
  const { accessToken, baseUrl } = ctx;
  const tipo = String(evento.fullCode || evento.code || '').toUpperCase();
  const orderId = evento.orderId || evento.correlationId;

  try {
    if (!EVENTOS_TRATADOS.includes(tipo)) {
      return { ignorado: true, motivo: `evento ${tipo} não tratado` };
    }
    if (!orderId) return { erro: 'evento sem orderId' };

    if (tipo === 'PLACED' || tipo === 'CONFIRMED') {
      const bruto = await cliente.detalhesPedido({ accessToken, orderId, baseUrl });
      const pedido = cliente.normalizarPedido(bruto);
      if (!pedido || !pedido.idExterno) return { erro: 'pedido sem id' };
      const r = criarComandaDoPedido(db, pedido);
      return { comandaId: r.comandaId, jaExistia: r.jaExistia, tipo };
    }

    // Cancelamento: o pedido pode nem ter chegado a virar comanda.
    if (tipo === 'CANCELLED' || tipo === 'CANCELLATION_REQUESTED') {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE canalExterno = ? AND pedidoExternoId = ?')
        .get(CANAL, orderId);
      if (!c) return { ignorado: true, motivo: 'cancelamento de pedido que não virou comanda' };
      if (c.status === 'aberta') {
        db.transaction(() => {
          db.prepare("UPDATE rest_comanda_itens SET status='cancelado', canceladoEm=?, canceladoMotivo='cancelado no iFood' WHERE comandaId=? AND status<>'cancelado'")
            .run(agora(), c.id);
          db.prepare("UPDATE rest_entregas SET status='cancelada' WHERE comandaId=?").run(c.id);
          db.prepare("UPDATE rest_comandas SET status='cancelada', fechadaEm=? WHERE id=?").run(agora(), c.id);
        })();
        registrarEvento(db, c.id, 'ifood-cancelado', 'Pedido cancelado no iFood', 'ifood');
      }
      return { comandaId: c.id, tipo };
    }

    if (tipo === 'DISPATCHED') {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE canalExterno = ? AND pedidoExternoId = ?')
        .get(CANAL, orderId);
      if (!c) return { ignorado: true, motivo: 'despacho sem comanda' };
      db.prepare("UPDATE rest_entregas SET status='em-rota', saiuEm=? WHERE comandaId=? AND status='pendente'")
        .run(agora(), c.id);
      return { comandaId: c.id, tipo };
    }

    if (tipo === 'CONCLUDED') {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE canalExterno = ? AND pedidoExternoId = ?')
        .get(CANAL, orderId);
      if (!c) return { ignorado: true, motivo: 'conclusão sem comanda' };
      db.prepare("UPDATE rest_entregas SET status='entregue', entregueEm=? WHERE comandaId=?").run(agora(), c.id);
      if (c.status === 'aberta') {
        db.prepare("UPDATE rest_comanda_itens SET status='entregue', entregueEm=? WHERE comandaId=? AND status NOT IN ('cancelado','entregue')")
          .run(agora(), c.id);
        db.prepare("UPDATE rest_comandas SET status='fechada', fechadaEm=? WHERE id=?").run(agora(), c.id);
        registrarEvento(db, c.id, 'ifood-concluido', 'Pedido concluído no iFood', 'ifood');
      }
      return { comandaId: c.id, tipo };
    }

    return { ignorado: true, motivo: tipo };
  } catch (err) {
    return { erro: String(err.message || err) };
  }
}

/**
 * Um ciclo completo de polling. Exportado para o scheduler e para a rota
 * manual (o botão "buscar agora" da tela de configuração).
 */
async function cicloPolling(db, opts = {}) {
  const cfg = lerCanal(db);
  if (!cfg) return { ok: false, motivo: 'canal não configurado' };
  if (!cfg.ativo) return { ok: false, motivo: 'canal desativado' };
  if (!cfg.clientId || !cfg.clientSecret) return { ok: false, motivo: 'credenciais ausentes' };

  const baseUrl = opts.baseUrl || cfg.baseUrl || cliente.BASE_PADRAO;
  const resumo = { recebidos: 0, novos: 0, duplicados: 0, comandas: [], erros: [] };

  try {
    const accessToken = await tokenValido(db, cfg, baseUrl);
    const merchantIds = cfg.merchantId ? String(cfg.merchantId).split(',').map(s => s.trim()).filter(Boolean) : [];
    const eventos = await cliente.polling({ accessToken, merchantIds, baseUrl });
    resumo.recebidos = eventos.length;

    const insEv = db.prepare(`
      INSERT INTO rest_canal_eventos (canal, eventoId, tipo, pedidoExternoId, payload, recebidoEm)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const paraAck = [];
    for (const ev of eventos) {
      const eventoId = String(ev.id || '');
      if (!eventoId) continue;
      // 1ª camada de idempotência: o UNIQUE recusa o evento repetido.
      let novo = true;
      try {
        insEv.run(CANAL, eventoId, String(ev.fullCode || ev.code || ''),
          ev.orderId || null, JSON.stringify(ev), agora());
      } catch (e) {
        if (/UNIQUE/i.test(e.message)) { novo = false; resumo.duplicados++; }
        else throw e;
      }
      // O ACK vale mesmo para o duplicado: se ele voltou, é porque o ACK
      // anterior não chegou.
      paraAck.push(ev);
      if (!novo) continue;
      resumo.novos++;

      const r = await processarEvento(db, ev, { accessToken, baseUrl });
      db.prepare('UPDATE rest_canal_eventos SET processadoEm = ?, comandaId = ?, erro = ? WHERE canal = ? AND eventoId = ?')
        .run(agora(), r.comandaId || null, r.erro || null, CANAL, eventoId);
      if (r.erro) resumo.erros.push({ eventoId, erro: r.erro });
      else if (r.comandaId && !r.jaExistia) resumo.comandas.push(r.comandaId);
    }

    // 3ª camada: ACK depois de PERSISTIR, não depois de processar com sucesso.
    // Um pedido malformado que nunca processa não pode travar a fila atrás dele.
    if (paraAck.length) {
      try {
        await cliente.acknowledge({ accessToken, eventos: paraAck, baseUrl });
      } catch (e) {
        resumo.erros.push({ eventoId: '(ack)', erro: String(e.message || e) });
      }
    }

    db.prepare('UPDATE rest_canais_integracao SET ultimoPollingEm = ?, ultimoErro = NULL WHERE id = ?')
      .run(agora(), cfg.id);
    return { ok: true, ...resumo };
  } catch (err) {
    const msg = String(err.message || err);
    try {
      db.prepare('UPDATE rest_canais_integracao SET ultimoPollingEm = ?, ultimoErro = ? WHERE id = ?')
        .run(agora(), msg, cfg.id);
    } catch (_) { /* */ }
    return { ok: false, erro: msg, ...resumo };
  }
}

function registrarRotasIfood(app, db, gateFlag) {

  app.get('/api/ifood/config', gateFlag, (req, res) => {
    try {
      const c = lerCanal(db);
      if (!c) return res.json({ success: true, config: null });
      // O secret NUNCA volta inteiro: a tela só precisa saber se existe.
      res.json({
        success: true,
        config: {
          id: c.id, canal: c.canal, merchantId: c.merchantId, clientId: c.clientId,
          temSecret: !!c.clientSecret, ativo: c.ativo,
          ultimoPollingEm: c.ultimoPollingEm, ultimoErro: c.ultimoErro,
          tokenValidoAte: c.tokenExpiraEm || null,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/ifood/config', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const atual = lerCanal(db);
      const merchantId = b.merchantId !== undefined ? String(b.merchantId || '').trim() : (atual ? atual.merchantId : null);
      const clientId = b.clientId !== undefined ? String(b.clientId || '').trim() : (atual ? atual.clientId : null);
      // Secret em branco significa "não mexer", não "apagar" — senão salvar a
      // tela sem redigitar o segredo derrubaria a integração.
      const clientSecret = b.clientSecret ? String(b.clientSecret).trim() : (atual ? atual.clientSecret : null);
      const ativo = b.ativo !== undefined ? (b.ativo ? 1 : 0) : (atual ? atual.ativo : 0);

      if (ativo && (!clientId || !clientSecret)) {
        return res.status(400).json({ success: false, error: 'informe clientId e clientSecret antes de ativar' });
      }

      if (atual) {
        // Trocar credencial invalida o token guardado.
        const mudouCred = clientId !== atual.clientId || clientSecret !== atual.clientSecret;
        db.prepare(`
          UPDATE rest_canais_integracao SET merchantId = ?, clientId = ?, clientSecret = ?, ativo = ?,
                 accessToken = ?, tokenExpiraEm = ? WHERE id = ?
        `).run(merchantId, clientId, clientSecret, ativo,
          mudouCred ? null : atual.accessToken, mudouCred ? null : atual.tokenExpiraEm, atual.id);
      } else {
        db.prepare(`
          INSERT INTO rest_canais_integracao (canal, merchantId, clientId, clientSecret, ativo)
          VALUES (?, ?, ?, ?, ?)
        `).run(CANAL, merchantId, clientId, clientSecret, ativo);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Executa um ciclo agora — o botão "buscar pedidos" da tela.
  app.post('/api/ifood/polling', gateFlag, async (req, res) => {
    try {
      const r = await cicloPolling(db, { baseUrl: req.body?.baseUrl });
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/ifood/eventos', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT id, canal, eventoId, tipo, pedidoExternoId, comandaId, recebidoEm, processadoEm, erro
          FROM rest_canal_eventos WHERE canal = ? ORDER BY id DESC LIMIT ?
      `).all(CANAL, Number(req.query.limit) || 100);
      res.json({
        success: true, items,
        resumo: {
          total: db.prepare('SELECT COUNT(*) AS n FROM rest_canal_eventos WHERE canal = ?').get(CANAL).n,
          comErro: db.prepare('SELECT COUNT(*) AS n FROM rest_canal_eventos WHERE canal = ? AND erro IS NOT NULL').get(CANAL).n,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Confirmar / despachar / cancelar do nosso lado para o iFood.
  app.post('/api/ifood/comandas/:id/acao', gateFlag, async (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.canalExterno !== CANAL || !c.pedidoExternoId) {
        return res.status(400).json({ success: false, error: 'comanda não veio do iFood' });
      }
      const cfg = lerCanal(db);
      if (!cfg || !cfg.ativo) return res.status(400).json({ success: false, error: 'canal iFood inativo' });

      const baseUrl = req.body?.baseUrl || cfg.baseUrl || cliente.BASE_PADRAO;
      const accessToken = await tokenValido(db, cfg, baseUrl);
      const r = await cliente.acaoPedido({
        accessToken, orderId: c.pedidoExternoId,
        acao: req.body?.acao, motivo: req.body?.motivo, baseUrl,
      });
      registrarEvento(db, c.id, 'ifood-acao', `${req.body?.acao} enviado ao iFood`,
        (req.user && (req.user.nome || req.user.username)) || null);
      res.json({ success: true, ...r });
    } catch (err) { res.status(400).json({ success: false, error: String(err.message || err) }); }
  });

  console.log('[restaurante] Rotas do iFood registradas');
}

module.exports = {
  registrarRotasIfood,
  cicloPolling,
  processarEvento,
  criarComandaDoPedido,
  lerCanal,
  CANAL,
  EVENTOS_TRATADOS,
};
