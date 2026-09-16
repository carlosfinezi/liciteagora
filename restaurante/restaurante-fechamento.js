/**
 * restaurante-fechamento.js — Módulo Restaurante, fase 4: conta e caixa.
 *
 * Cobre três coisas que andam juntas no fim da refeição:
 *
 *  1. DIVISÃO DE CONTA — quatro modos (igual, por pessoa, por item, por valor)
 *     e fechamento PARCIAL: um paga a parte dele e sai, a comanda segue aberta
 *     para os que ficaram.
 *  2. TURNO DE CAIXA — abertura, sangria, suprimento e fechamento com apuração
 *     por meio de pagamento. Não existia nada disso no sistema antes.
 *  3. PAYLOAD FISCAL — monta os itens da NFC-e com o tratamento correto de
 *     taxa de serviço e couvert.
 *
 * O tratamento fiscal da gorjeta é a parte que mais erra na prática:
 * a taxa de serviço de até 10% fica FORA da base do ICMS, mas só se sair no
 * cupom como ITEM SEPARADO — CFOP 5.949, CSOSN 103, NCM "99". Embutir no preço
 * dos pratos joga a gorjeta para dentro da base e faz o restaurante pagar
 * imposto sobre dinheiro que é do garçom. Couvert artístico é serviço e vai
 * com CFOP 5.933.
 *
 * A transmissão à SEFAZ NÃO acontece aqui: este módulo monta o payload e o
 * entrega ao emitirNFCe do nfce-routes, que é quem fala com o fisco.
 */

const { agora, registrarEvento, recalcularTotais, comandaCompleta } = require('./restaurante-comanda');

const MODOS_DIVISAO = ['igual', 'item', 'valor'];

// Item fiscal da taxa de serviço. Os códigos abaixo não são escolha de estilo:
// é o que mantém a gorjeta fora da base do ICMS.
const FISCAL_TAXA = { ncm: '99', cfop: '5949', csosn: '103', descricao: 'Taxa de serviço' };
const FISCAL_COUVERT = { ncm: '99', cfop: '5933', csosn: '103', descricao: 'Couvert artístico' };

function centavos(v) { return Math.round(Number(v || 0) * 100); }
function reais(c) { return Math.round(c) / 100; }

function turnoAberto(db) {
  return db.prepare("SELECT * FROM rest_turnos WHERE status = 'aberto' ORDER BY id DESC LIMIT 1").get() || null;
}

/**
 * Reparte um total em N partes sem perder nem criar centavo: distribui o resto
 * da divisão nas primeiras parcelas. Somar 3 × R$ 33,33 e obter R$ 99,99 numa
 * conta de R$ 100,00 é exatamente o tipo de diferença que trava o caixa.
 */
function repartir(totalCentavos, n) {
  const base = Math.floor(totalCentavos / n);
  const resto = totalCentavos - base * n;
  return Array.from({ length: n }, (_, i) => reais(base + (i < resto ? 1 : 0)));
}

/**
 * Saldo aberto da comanda em centavos (total − já pago).
 */
function saldoCentavos(db, comandaId) {
  const c = db.prepare('SELECT totalGeral, totalPago FROM rest_comandas WHERE id = ?').get(comandaId);
  if (!c) return 0;
  return centavos(c.totalGeral) - centavos(c.totalPago);
}

function registrarRotasFechamento(app, db, gateFlag, deps) {
  const { lerConfig } = deps;

  // ==================== TURNO DE CAIXA ====================

  app.get('/api/restaurante/turnos/atual', gateFlag, (req, res) => {
    try {
      const t = turnoAberto(db);
      if (!t) return res.json({ success: true, turno: null });
      res.json({ success: true, turno: apurarTurno(db, t) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/turnos', gateFlag, (req, res) => {
    try {
      const aberto = turnoAberto(db);
      // Dois turnos abertos ao mesmo tempo tornam impossível dizer de quem é a
      // diferença no fechamento.
      if (aberto) {
        return res.status(400).json({ success: false, error: 'já existe um turno aberto', turnoId: aberto.id });
      }
      const valorAbertura = Number(req.body?.valorAbertura || 0);
      if (!Number.isFinite(valorAbertura) || valorAbertura < 0) {
        return res.status(400).json({ success: false, error: 'valor de abertura inválido' });
      }
      const r = db.prepare(`
        INSERT INTO rest_turnos (operadorUserId, operadorNome, abertoEm, valorAbertura, status)
        VALUES (?, ?, ?, ?, 'aberto')
      `).run(
        req.user ? req.user.id : null,
        (req.user && (req.user.nome || req.user.username)) || null,
        agora(), valorAbertura,
      );
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/turnos/:id/movimentos', gateFlag, (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM rest_turnos WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'turno não encontrado' });
      if (t.status !== 'aberto') return res.status(400).json({ success: false, error: 'turno já fechado' });

      const tipo = String(req.body?.tipo || '');
      if (!['sangria', 'suprimento'].includes(tipo)) {
        return res.status(400).json({ success: false, error: 'tipo deve ser sangria ou suprimento' });
      }
      const valor = Number(req.body?.valor);
      if (!Number.isFinite(valor) || valor <= 0) {
        return res.status(400).json({ success: false, error: 'valor inválido' });
      }
      // Sangria é retirada de dinheiro do caixa: sem motivo não há como auditar
      // depois de onde saiu.
      const motivo = String(req.body?.motivo || '').trim();
      if (tipo === 'sangria' && motivo.length < 3) {
        return res.status(400).json({ success: false, error: 'informe o motivo da sangria' });
      }
      db.prepare(
        'INSERT INTO rest_turno_movimentos (turnoId, tipo, valor, motivo, usuario, criadoEm) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(req.params.id, tipo, valor, motivo || null,
        (req.user && (req.user.nome || req.user.username)) || null, agora());
      res.json({ success: true, turno: apurarTurno(db, db.prepare('SELECT * FROM rest_turnos WHERE id = ?').get(req.params.id)) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/turnos/:id/fechar', gateFlag, (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM rest_turnos WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'turno não encontrado' });
      if (t.status !== 'aberto') return res.status(400).json({ success: false, error: 'turno já fechado' });

      // Fechar o caixa com mesa aberta deixa venda fora da apuração do turno.
      const abertas = db.prepare("SELECT COUNT(*) AS n FROM rest_comandas WHERE status = 'aberta'").get();
      if (abertas.n > 0 && !req.body?.forcar) {
        return res.status(400).json({
          success: false,
          error: `há ${abertas.n} comanda(s) aberta(s) — feche-as antes ou confirme para forçar`,
          comandasAbertas: abertas.n,
        });
      }

      const apurado = apurarTurno(db, t);
      const informado = req.body?.valorInformado != null ? Number(req.body.valorInformado) : null;
      if (informado != null && (!Number.isFinite(informado) || informado < 0)) {
        return res.status(400).json({ success: false, error: 'valor informado inválido' });
      }
      // A diferença é sobre o DINHEIRO em gaveta; cartão e Pix não são contados
      // à mão no fechamento.
      const diferenca = informado == null ? null
        : reais(centavos(informado) - centavos(apurado.esperadoEmDinheiro));

      db.prepare(`
        UPDATE rest_turnos SET fechadoEm = ?, valorApurado = ?, valorInformado = ?, diferenca = ?,
               status = 'fechado', observacao = ? WHERE id = ?
      `).run(agora(), apurado.esperadoEmDinheiro, informado, diferenca,
        req.body?.observacao || null, req.params.id);

      res.json({
        success: true,
        turno: db.prepare('SELECT * FROM rest_turnos WHERE id = ?').get(req.params.id),
        apurado,
        diferenca,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/restaurante/turnos/:id', gateFlag, (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM rest_turnos WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'turno não encontrado' });
      res.json({ success: true, turno: apurarTurno(db, t) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== DIVISÃO DE CONTA ====================

  app.get('/api/restaurante/comandas/:id/divisao', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });

      const modo = String(req.query.modo || 'igual');
      if (!MODOS_DIVISAO.includes(modo)) return res.status(400).json({ success: false, error: 'modo inválido' });

      const saldo = saldoCentavos(db, c.id);

      if (modo === 'igual') {
        const n = Number(req.query.pessoas) || c.numeroPessoas || 1;
        if (!Number.isInteger(n) || n < 1) return res.status(400).json({ success: false, error: 'número de pessoas inválido' });
        const partes = repartir(saldo, n);
        return res.json({
          success: true, modo, pessoas: n,
          // Somar as partes tem de devolver exatamente o saldo — o resto da
          // divisão é distribuído, não arredondado fora.
          partes: partes.map((valor, i) => ({ rotulo: `Pessoa ${i + 1}`, valor })),
          total: reais(saldo),
        });
      }

      if (modo === 'item') {
        // Por item, a taxa de serviço é rateada proporcionalmente ao consumo de
        // cada um — quem comeu mais paga mais serviço.
        const itens = db.prepare(`
          SELECT id, descricao, quantidade, precoTotal FROM rest_comanda_itens
           WHERE comandaId = ? AND status <> 'cancelado' ORDER BY id
        `).all(c.id);
        const baseItens = centavos(c.totalItens);
        const pct = baseItens > 0 ? (centavos(c.totalTaxaServico) / baseItens) : 0;
        return res.json({
          success: true, modo,
          itens: itens.map(i => ({
            ...i,
            taxaProporcional: reais(centavos(i.precoTotal) * pct),
            comTaxa: reais(centavos(i.precoTotal) * (1 + pct)),
          })),
          observacao: 'couvert e desconto não são rateados por item — lance-os como parcela à parte',
          total: reais(saldo),
        });
      }

      // modo 'valor': só informa o saldo; o caixa digita quanto cada um paga.
      return res.json({ success: true, modo, total: reais(saldo), saldo: reais(saldo) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PAGAMENTOS ====================

  app.post('/api/restaurante/comandas/:id/pagamentos', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });

      const meio = String(req.body?.meioPagamento || '').trim();
      if (!meio) return res.status(400).json({ success: false, error: 'meio de pagamento é obrigatório' });
      const valor = Number(req.body?.valor);
      if (!Number.isFinite(valor) || valor <= 0) {
        return res.status(400).json({ success: false, error: 'valor inválido' });
      }

      // Receber mais do que a conta deve vira troco, não crédito — e crédito
      // pendurado em comanda é dinheiro perdido no fechamento do caixa.
      const saldo = saldoCentavos(db, c.id);
      if (centavos(valor) > saldo + 2 && !req.body?.permitirTroco) {
        return res.status(400).json({
          success: false,
          error: `valor excede o saldo de R$ ${reais(saldo).toFixed(2)}`,
          saldo: reais(saldo),
          troco: reais(centavos(valor) - saldo),
        });
      }

      // Carimba o turno vigente: é o que amarra o pagamento ao caixa que o
      // recebeu. Pagamento fora de turno fica com turnoId NULL e não entra em
      // apuração nenhuma — o que é o comportamento certo e detectável.
      const t = turnoAberto(db);
      db.prepare(`
        INSERT INTO rest_comanda_pagamentos (comandaId, meioPagamento, valor, nomePagador, turnoId, usuario, criadoEm)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(c.id, meio, valor, req.body?.nomePagador || null, t ? t.id : null,
        (req.user && (req.user.nome || req.user.username)) || null, agora());

      const comanda = recalcularTotais(db, c.id);
      const novoSaldo = saldoCentavos(db, c.id);
      registrarEvento(db, c.id, 'pagamento',
        `${meio} R$ ${valor.toFixed(2)}${req.body?.nomePagador ? ' — ' + req.body.nomePagador : ''}`,
        (req.user && (req.user.nome || req.user.username)) || null);

      res.json({
        success: true,
        comanda,
        saldo: reais(novoSaldo),
        quitada: novoSaldo <= 2,          // tolerância de 2 centavos
        troco: centavos(valor) > saldo ? reais(centavos(valor) - saldo) : 0,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/restaurante/comanda-pagamentos/:id', gateFlag, (req, res) => {
    try {
      const p = db.prepare('SELECT * FROM rest_comanda_pagamentos WHERE id = ?').get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'pagamento não encontrado' });
      const c = db.prepare('SELECT status FROM rest_comandas WHERE id = ?').get(p.comandaId);
      if (c.status !== 'aberta') {
        return res.status(400).json({ success: false, error: 'comanda já fechada — estorne pela via fiscal' });
      }
      db.prepare('DELETE FROM rest_comanda_pagamentos WHERE id = ?').run(req.params.id);
      registrarEvento(db, p.comandaId, 'estorno-pagamento',
        `${p.meioPagamento} R$ ${Number(p.valor).toFixed(2)} removido`,
        (req.user && (req.user.nome || req.user.username)) || null);
      res.json({ success: true, comanda: recalcularTotais(db, p.comandaId) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== FECHAR COMANDA ====================

  app.post('/api/restaurante/comandas/:id/fechar', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });

      const saldo = saldoCentavos(db, c.id);
      if (saldo > 2 && !req.body?.forcar) {
        return res.status(400).json({
          success: false,
          error: `ainda faltam R$ ${reais(saldo).toFixed(2)} — registre o pagamento ou confirme para forçar`,
          saldo: reais(saldo),
        });
      }
      // Fechar com saldo aberto é decisão gerencial (cortesia, perda, acerto
      // posterior) e por isso exige justificativa.
      if (saldo > 2 && req.body?.forcar) {
        const motivo = String(req.body?.motivo || '').trim();
        if (motivo.length < 3) {
          return res.status(400).json({ success: false, error: 'fechar com saldo aberto exige motivo' });
        }
        registrarEvento(db, c.id, 'fechamento-forcado',
          `Saldo de R$ ${reais(saldo).toFixed(2)} não pago — ${motivo}`,
          (req.user && (req.user.nome || req.user.username)) || null);
      }

      // Item que ficou pendente na cozinha some da fila ao fechar; marcar como
      // entregue evita que a comanda feche deixando lixo no KDS.
      db.prepare(`
        UPDATE rest_comanda_itens SET status = 'entregue', entregueEm = ?
         WHERE comandaId = ? AND status IN ('pendente','em-preparo','pronto')
      `).run(agora(), c.id);

      const t = turnoAberto(db);
      db.prepare("UPDATE rest_comandas SET status = 'fechada', fechadaEm = ?, turnoId = ? WHERE id = ?")
        .run(agora(), t ? t.id : null, c.id);
      registrarEvento(db, c.id, 'fechamento',
        `Conta fechada — R$ ${Number(c.totalGeral).toFixed(2)}`,
        (req.user && (req.user.nome || req.user.username)) || null);

      // Baixa de estoque pela ficha técnica acontece AQUI, não no lançamento:
      // item lançado ainda pode ser cancelado, e baixar antes faria o estoque
      // dançar a cada desistência de cliente. É idempotente por comanda.
      let baixa = null;
      try {
        baixa = require('./restaurante-ficha').baixarEstoqueComanda(db, c.id);
      } catch (e) {
        // Falha de estoque não pode impedir o fechamento da conta: o cliente
        // já está de saída. Fica registrado para reprocessar.
        registrarEvento(db, c.id, 'baixa-estoque-falhou', String(e.message || e), null);
      }

      res.json({ success: true, comanda: comandaCompleta(db, c.id), baixaEstoque: baixa });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PAYLOAD FISCAL ====================

  app.get('/api/restaurante/comandas/:id/nfce-payload', gateFlag, (req, res) => {
    try {
      const payload = montarPayloadNfce(db, req.params.id, lerConfig(db));
      if (payload.erro) return res.status(400).json({ success: false, error: payload.erro });
      res.json({ success: true, payload: payload.payload, conferencia: payload.conferencia });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/comandas/:id/emitir-nfce', gateFlag, async (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });

      const montado = montarPayloadNfce(db, req.params.id, lerConfig(db), req.body || {});
      if (montado.erro) return res.status(400).json({ success: false, error: montado.erro });

      // A conversa com a SEFAZ é do módulo fiscal; aqui só entregamos o payload.
      const { emitirNFCe } = require('../nfce-routes');
      const r = await emitirNFCe(db, montado.payload);

      if (r && r.nfceId) {
        db.prepare('UPDATE rest_comanda_pagamentos SET nfceId = ? WHERE comandaId = ? AND nfceId IS NULL')
          .run(r.nfceId, c.id);
        registrarEvento(db, c.id, 'nfce', `NFC-e emitida (id ${r.nfceId})`, null);
      }
      res.json({ success: true, ...r });
    } catch (err) {
      res.status(400).json({ success: false, error: String(err.message || err) });
    }
  });

  console.log('[restaurante] Rotas de fechamento registradas');
}

/**
 * Apuração do turno: quanto entrou por meio de pagamento, mais sangrias e
 * suprimentos.
 *
 * O vínculo é a coluna `turnoId` do pagamento, carimbada no ato. Apurar por
 * janela de tempo (abertoEm → fechadoEm) parece equivalente e não é: os
 * timestamps têm precisão de segundo, então um pagamento no mesmo segundo da
 * virada de turno seria contado nos dois — e a diferença de caixa apareceria
 * no turno errado.
 */
function apurarTurno(db, t) {
  const fim = t.fechadoEm || '9999-12-31 23:59:59';
  const porMeio = db.prepare(`
    SELECT meioPagamento, COUNT(*) AS n, COALESCE(SUM(valor), 0) AS total
      FROM rest_comanda_pagamentos
     WHERE turnoId = ?
     GROUP BY meioPagamento ORDER BY total DESC
  `).all(t.id);

  const movs = db.prepare('SELECT * FROM rest_turno_movimentos WHERE turnoId = ? ORDER BY id').all(t.id);
  const sangrias = movs.filter(m => m.tipo === 'sangria').reduce((s, m) => s + Number(m.valor), 0);
  const suprimentos = movs.filter(m => m.tipo === 'suprimento').reduce((s, m) => s + Number(m.valor), 0);

  const totalRecebido = porMeio.reduce((s, p) => s + Number(p.total), 0);
  // Só o dinheiro fica na gaveta. Cartão e Pix não se conferem contando cédula.
  const emDinheiro = porMeio
    .filter(p => /dinheiro|especie|espécie/i.test(p.meioPagamento))
    .reduce((s, p) => s + Number(p.total), 0);

  const comandasFechadas = db.prepare(
    "SELECT COUNT(*) AS n FROM rest_comandas WHERE status = 'fechada' AND fechadaEm >= ? AND fechadaEm <= ?"
  ).get(t.abertoEm, fim).n;

  return {
    ...t,
    porMeio,
    movimentos: movs,
    sangrias: reais(centavos(sangrias)),
    suprimentos: reais(centavos(suprimentos)),
    totalRecebido: reais(centavos(totalRecebido)),
    comandasFechadas,
    esperadoEmDinheiro: reais(
      centavos(t.valorAbertura) + centavos(emDinheiro) + centavos(suprimentos) - centavos(sangrias)
    ),
  };
}

/**
 * Monta o payload da NFC-e a partir da comanda.
 *
 * Taxa de serviço e couvert entram como ITENS SEPARADOS, e é isso que mantém
 * a gorjeta fora da base do ICMS. O produto que representa cada um pode ser
 * configurado (restaurante_taxa_servico_prod / restaurante_couvert_prod); sem
 * configuração, vai como item sem produtoId — a nota sai correta e nada é
 * baixado do estoque, que é o comportamento certo para serviço.
 */
function montarPayloadNfce(db, comandaId, cfg, extra = {}) {
  const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(comandaId);
  if (!c) return { erro: 'comanda não encontrada' };

  const itensComanda = db.prepare(`
    SELECT i.*, p.sku, p.ncm, p.cfopPadrao
      FROM rest_comanda_itens i
      LEFT JOIN produtos p ON p.id = i.produtoId
     WHERE i.comandaId = ? AND i.status <> 'cancelado'
     ORDER BY i.id
  `).all(comandaId);

  if (!itensComanda.length) return { erro: 'comanda sem itens para faturar' };

  const itens = itensComanda.map(i => {
    // O adicional das opções está dentro de precoTotal; o unitário da nota tem
    // de refletir isso, senão quantidade × unitário não fecha com o total.
    const unit = Number(i.quantidade) > 0
      ? Math.round((Number(i.precoTotal) / Number(i.quantidade)) * 10000) / 10000
      : Number(i.precoUnit);
    return {
      produtoId: i.produtoId,
      sku: i.sku,
      descricao: i.descricao,
      ncm: i.ncm,
      cfop: i.cfopPadrao || undefined,
      quantidade: Number(i.quantidade),
      precoUnitario: unit,
      valorTotal: Number(i.precoTotal),
    };
  });

  const taxa = Number(c.totalTaxaServico || 0);
  if (taxa > 0) {
    const prodId = cfg && cfg.restaurante_taxa_servico_prod ? Number(cfg.restaurante_taxa_servico_prod) : null;
    itens.push({
      produtoId: prodId || null,
      sku: 'TAXA-SERV',
      descricao: FISCAL_TAXA.descricao,
      ncm: FISCAL_TAXA.ncm,
      cfop: FISCAL_TAXA.cfop,
      csosn: FISCAL_TAXA.csosn,
      quantidade: 1,
      precoUnitario: taxa,
      valorTotal: taxa,
    });
  }

  const couvert = Number(c.totalCouvert || 0);
  if (couvert > 0) {
    const prodId = cfg && cfg.restaurante_couvert_prod ? Number(cfg.restaurante_couvert_prod) : null;
    itens.push({
      produtoId: prodId || null,
      sku: 'COUVERT',
      descricao: FISCAL_COUVERT.descricao,
      ncm: FISCAL_COUVERT.ncm,
      cfop: FISCAL_COUVERT.cfop,
      csosn: FISCAL_COUVERT.csosn,
      quantidade: 1,
      precoUnitario: couvert,
      valorTotal: couvert,
    });
  }

  const pagamentos = db.prepare(
    'SELECT meioPagamento, valor FROM rest_comanda_pagamentos WHERE comandaId = ? ORDER BY id'
  ).all(comandaId).map(p => ({ tPag: mapearMeioPagamento(p.meioPagamento), valor: Number(p.valor) }));

  const somaItens = itens.reduce((s, i) => s + centavos(i.valorTotal), 0);
  const desconto = Number(c.totalDesconto || 0);

  return {
    payload: {
      itens,
      pagamentos,
      valorDesconto: desconto,
      consumidorCpfCnpj: extra.consumidorCpfCnpj || null,
      consumidorNome: extra.consumidorNome || null,
      origemComandaId: comandaId,
    },
    // Devolvido para a tela conferir antes de transmitir: nota rejeitada por
    // diferença de centavo queima numeração.
    conferencia: {
      somaItens: reais(somaItens),
      desconto,
      totalNota: reais(somaItens - centavos(desconto)),
      totalComanda: Number(c.totalGeral),
      bate: Math.abs((somaItens - centavos(desconto)) - centavos(c.totalGeral)) <= 2,
      taxaServicoSeparada: taxa > 0,
      couvertSeparado: couvert > 0,
    },
  };
}

// Meio de pagamento → tPag da NFC-e (tabela do layout 4.00).
function mapearMeioPagamento(meio) {
  const m = String(meio || '').toLowerCase();
  if (/dinheiro|especie|espécie/.test(m)) return '01';
  if (/cheque/.test(m)) return '02';
  if (/cr[eé]dito/.test(m)) return '03';
  if (/d[eé]bito/.test(m)) return '04';
  if (/vale.?refei|ticket|alimenta/.test(m)) return '10';
  if (/pix/.test(m)) return '17';
  return '99';   // outros
}

module.exports = {
  registrarRotasFechamento,
  montarPayloadNfce,
  mapearMeioPagamento,
  apurarTurno,
  repartir,
  FISCAL_TAXA,
  FISCAL_COUVERT,
  MODOS_DIVISAO,
};
