/**
 * faturas-routes.js — Faturamento gerencial (Fase 1 de NF-e).
 * Cria tabela `faturas` + `fatura_itens`, ALTER pedidos ADD faturaId.
 * Endpoint POST /api/pedidos/:id/faturar: gera fatura + conta_a_receber + (opcional) boleto.
 *
 * Uso:
 *   const { registrarRotasFaturas } = require('./faturas-routes');
 *   registrarRotasFaturas(app, db);
 */

const faturasPdf = require('./faturas-pdf');
const { lancarMovimentacao, getContaPadrao } = require('./contas-financeiras-routes');
const { escopoSql, guardEscopo } = require('./estabelecimentos-routes');
const { cancelarFaturaLocal } = require('./fatura-cancelamento');
const { sincronizarPagamentoPedido } = require('./contas-receber-routes');
const { getEstabelecimentoAtivo } = require('./estabelecimentos-routes');
const { prazoDaPessoa, dividirValor } = require('./prazo-pagamento');

const MEIOS_AVISTA_CAIXA = new Set(['01']);      // Dinheiro
const MEIOS_AVISTA_BANCO = new Set([]);          // PIX (17) agora gera cobrança QR/link (baixa via webhook), não auto-baixa
const MEIOS_CARTAO = new Set(['03','04']);       // Cartão crédito/débito

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function addDias(dataStr, dias) {
  const d = new Date(dataStr);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function gerarNumeroFatura(db) {
  const ano = new Date().getFullYear();
  const prefixo = `FAT-${ano}-`;
  const row = db.prepare(`SELECT numero FROM faturas WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefixo + '%');
  let seq = 1;
  if (row) {
    const n = parseInt(row.numero.slice(prefixo.length), 10);
    if (!isNaN(n)) seq = n + 1;
  }
  return `${prefixo}${String(seq).padStart(5, '0')}`;
}

function migrarFaturas(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS faturas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      pedidoId INTEGER NOT NULL,
      clienteId INTEGER NOT NULL,
      dataEmissao TEXT NOT NULL,
      dataVencimento TEXT NOT NULL,
      valorBruto REAL NOT NULL,
      valorFrete REAL DEFAULT 0,
      valorDesconto REAL DEFAULT 0,
      valorTotal REAL NOT NULL,
      meioPagamento TEXT,
      observacao TEXT,
      contaReceberId INTEGER,
      status TEXT DEFAULT 'emitida',
      chaveAcesso TEXT,
      protocoloAutorizacao TEXT,
      numeroNFe INTEGER,
      serieNFe TEXT,
      xmlAssinado TEXT,
      statusSefaz TEXT,
      dataAutorizacaoSefaz TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id),
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id)
    );
    CREATE INDEX IF NOT EXISTS idx_faturas_pedido ON faturas(pedidoId);
    CREATE INDEX IF NOT EXISTS idx_faturas_cliente ON faturas(clienteId);
    CREATE INDEX IF NOT EXISTS idx_faturas_status ON faturas(status);

    CREATE TABLE IF NOT EXISTS fatura_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faturaId INTEGER NOT NULL,
      produtoId INTEGER,
      sku TEXT,
      descricao TEXT NOT NULL,
      unidade TEXT,
      quantidade REAL NOT NULL,
      precoUnitario REAL NOT NULL,
      valorTotal REAL NOT NULL,
      ncm TEXT,
      cfop TEXT,
      origem TEXT,
      FOREIGN KEY (faturaId) REFERENCES faturas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_fatura_itens_fatura ON fatura_itens(faturaId);
  `);
  alterSafe(db, 'ALTER TABLE pedidos ADD COLUMN faturaId INTEGER');

  // Soft-delete + observação interna (gestão via /notas-fiscais.html)
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN excluida INTEGER DEFAULT 0");
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN dataExclusao TEXT");
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN motivoExclusao TEXT");
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN observacaoInterna TEXT");
  alterSafe(db, "CREATE INDEX IF NOT EXISTS idx_faturas_excluida ON faturas(excluida)");
}

function carregarFaturaCompleta(db, faturaId) {
  const f = db.prepare(`
    SELECT f.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
      p.endereco AS clienteEndereco, p.numero AS clienteNumero, p.bairro AS clienteBairro,
      p.cidade AS clienteCidade, p.uf AS clienteUf, p.cep AS clienteCep,
      p.telefone AS clienteTelefone, p.email AS clienteEmail,
      p.complemento AS clienteComplemento, p.inscricaoMunicipal AS clienteInscricaoMunicipal,
      p.inscricaoEstadual AS clienteInscricaoEstadual,
      ped.numero AS pedidoNumero,
      cr.status AS contaReceberStatus
    FROM faturas f
    LEFT JOIN pessoas p ON p.id = f.clienteId
    LEFT JOIN pedidos ped ON ped.id = f.pedidoId
    LEFT JOIN contas_a_receber cr ON cr.id = f.contaReceberId
    WHERE f.id = ?
  `).get(faturaId);
  if (!f) return null;
  const itens = db.prepare('SELECT * FROM fatura_itens WHERE faturaId = ? ORDER BY id ASC').all(faturaId);
  const parcelas = db.prepare(`SELECT id, descricao, valor, valorPago, dataVencimento, dataPagamento, status
    FROM contas_a_receber WHERE faturaId = ? ORDER BY dataVencimento ASC, id ASC`).all(faturaId);
  // Pedido com múltiplas faturas (ex.: tentativa cancelada + reemissão): aponta
  // qual outra fatura carrega a NF-e autorizada, pra UI orientar o usuário.
  let nfeAtivaEmOutraFatura = null;
  if (f.pedidoId) {
    nfeAtivaEmOutraFatura = db.prepare(`SELECT id, numero, numeroNFe FROM faturas
      WHERE pedidoId = ? AND id != ? AND statusSefaz = 'autorizada' AND COALESCE(excluida, 0) = 0
      ORDER BY id DESC LIMIT 1`).get(f.pedidoId, f.id) || null;
  }
  return { ...f, itens, parcelas, nfeAtivaEmOutraFatura };
}

function registrarRotasFaturas(app, db) {
  // RBAC de estabelecimento: fecha abrir/PDF/cancelar/restaurar por id de uma vez.
  app.use('/api/faturas/:id', guardEscopo(db, 'faturas'));

  migrarFaturas(db);

  // ==================== FATURAR PEDIDO ====================

  app.post('/api/pedidos/:id/faturar', (req, res) => {
    try {
      const pedido = db.prepare(`
        SELECT p.*, pe.cpfCnpj AS clienteCpfCnpj, pe.razaoSocial AS clienteRazaoSocial
        FROM pedidos p LEFT JOIN pessoas pe ON pe.id = p.clienteId WHERE p.id = ?
      `).get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (!pedido.clienteId) return res.status(400).json({ success: false, error: 'Pedido sem cliente — impossivel faturar' });
      if (pedido.status === 'faturado') return res.status(400).json({ success: false, error: 'Pedido ja faturado' });
      if (pedido.status === 'cancelado') return res.status(400).json({ success: false, error: 'Pedido cancelado' });
      if (pedido.status !== 'entregue') {
        return res.status(400).json({
          success: false,
          error: `Só é possível faturar pedidos com status "entregue" (atual: "${pedido.status}"). Marque como entregue para baixar o estoque antes de faturar.`
        });
      }

      const itensPedido = db.prepare(`
        SELECT pi.*, pr.sku AS prodSku, pr.unidade AS prodUnidade, pr.ncm AS prodNcm,
               pr.cfopPadrao AS prodCfop, pr.origem AS prodOrigem
        FROM pedido_itens pi
        LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.pedidoId = ?
      `).all(pedido.id);
      if (!itensPedido.length) return res.status(400).json({ success: false, error: 'Pedido sem itens' });

      const b = req.body || {};
      const valorDesconto = Number(b.valorDesconto) || 0;
      const valorFrete = Number(pedido.valorFrete) || 0;
      const valorBruto = itensPedido.reduce((s, it) => s + Number(it.valorTotal), 0);
      const valorTotal = valorBruto + valorFrete - valorDesconto;
      if (valorTotal <= 0) return res.status(400).json({ success: false, error: 'Valor total da fatura deve ser > 0' });

      // Decide se a fatura gera contas a receber a partir do tipo de operação do pedido
      // (bonificação, simples remessa, transferência → geraFinanceiro=0).
      const tipoOp = pedido.tipoOperacaoId
        ? db.prepare('SELECT geraFinanceiro, movimentaEstoque, emiteNFe FROM tipos_operacao WHERE id = ?').get(pedido.tipoOperacaoId)
        : null;
      const gerarContasReceber = tipoOp ? !!tipoOp.geraFinanceiro : true;

      const dataEmissao = dataBrasilia();
      // Prazo do cadastro do cliente ("30/60/90") manda no vencimento e no número
      // de parcelas quando ninguém informou data. Sem prazo, segue o +30 de antes.
      const prazoCliente = prazoDaPessoa(db, pedido.clienteId);
      const vencInformado = b.dataVencimento || pedido.dataFaturamentoPrevista || null;
      const dataVencimento = vencInformado
        || addDias(dataEmissao, prazoCliente ? prazoCliente[0] : 30);

      const numero = gerarNumeroFatura(db);

      // ehNaoFiscal: tipoOperacao.emiteNFe=0 (preferido) ou legado pedido.naoEmitirNFe=1.
      const ehNaoFiscal = tipoOp ? !tipoOp.emiteNFe : !!pedido.naoEmitirNFe;

      // Multi-loja: carimba o estabelecimento ativo da sessão na fatura. Só vira
      // não-nulo quando uma FILIAL contratada está selecionada — matriz e "sem
      // seleção" gravam NULL (caminho legado). A emissão lê isto para escolher
      // emitente/certificado/série do CNPJ certo.
      const _estabAtivo = getEstabelecimentoAtivo(db, req);
      const estabId = (_estabAtivo && !_estabAtivo.matriz) ? _estabAtivo.id : null;

      let faturaId;
      const tx = db.transaction(() => {
        faturaId = db.prepare(`
          INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento,
            valorBruto, valorFrete, valorDesconto, valorTotal, meioPagamento, observacao, statusSefaz,
            tipoOperacaoId, estabelecimentoId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(numero, pedido.id, pedido.clienteId, dataEmissao, dataVencimento,
          valorBruto, valorFrete, valorDesconto, valorTotal,
          pedido.meioPagamento || null, b.observacao || null,
          ehNaoFiscal ? 'nao_fiscal' : null,
          pedido.tipoOperacaoId || null,
          estabId
        ).lastInsertRowid;

        for (const it of itensPedido) {
          // CFOP resolvido no pedido_itens (motor de sugestão) tem precedência sobre o
          // cfopPadrao do produto — caso contrário o CFOP calculado por contexto (UF,
          // contribuinte, finalidade) é perdido na fatura.
          const cfopItem = it.cfop || it.prodCfop || null;
          db.prepare(`
            INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade,
              quantidade, precoUnitario, valorTotal, ncm, cfop, origem)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(faturaId, it.produtoId || null, it.prodSku || null,
            it.descricao, it.prodUnidade || null,
            it.quantidade, it.precoUnitario, it.valorTotal,
            it.prodNcm || null, cfopItem, it.prodOrigem || null);
        }

        // Se a fatura toda é de CFOPs que não geram financeiro (bonificação, remessa, etc),
        // pula completamente a criação de contas_a_receber.
        if (!gerarContasReceber) {
          db.prepare(`UPDATE pedidos SET status = 'faturado', faturaId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(faturaId, pedido.id);
          return;
        }

        // Carrega parcelas do pedido (se houver). Quando vazio, fluxo clássico 1-CR.
        const parcelasPed = db.prepare(
          'SELECT * FROM pedido_parcelas WHERE pedidoId = ? ORDER BY numeroParcela ASC'
        ).all(pedido.id);

        // Se houver parcelas, valida soma; senão monta 1 "parcela virtual" com meio+venc do pedido
        let parcelas;
        if (parcelasPed.length) {
          const soma = Number(parcelasPed.reduce((s, p) => s + Number(p.valor), 0).toFixed(2));
          if (Math.abs(soma - valorTotal) > 0.01) {
            throw new Error(`Soma das parcelas (R$ ${soma.toFixed(2)}) difere do total (R$ ${valorTotal.toFixed(2)})`);
          }
          parcelas = parcelasPed.map(p => ({
            numero: p.numeroParcela, total: parcelasPed.length,
            valor: Number(p.valor), dataVencimento: p.dataVencimento,
            meioPagamento: p.meioPagamento, bandeiraId: p.bandeiraId,
            observacao: p.observacao
          }));
        } else if (!vencInformado && prazoCliente && prazoCliente.length > 1) {
          // Pedido sem parcelas + cliente com prazo parcelado: a fatura sai
          // parcelada nos vencimentos do cadastro, não numa CR só.
          const valores = dividirValor(valorTotal, prazoCliente.length);
          parcelas = prazoCliente.map((dias, i) => ({
            numero: i + 1, total: prazoCliente.length,
            valor: valores[i], dataVencimento: addDias(dataEmissao, dias),
            meioPagamento: pedido.meioPagamento,
            bandeiraId: b.bandeiraId ? Number(b.bandeiraId) : null,
            observacao: null
          }));
        } else {
          parcelas = [{
            numero: 1, total: 1,
            valor: valorTotal, dataVencimento: dataVencimento,
            meioPagamento: pedido.meioPagamento,
            bandeiraId: b.bandeiraId ? Number(b.bandeiraId) : null,
            observacao: null
          }];
        }

        // Cria uma CR por parcela
        const idsCR = [];
        const grupoParcelaId = parcelas.length > 1 ? `fat-${faturaId}` : null;

        for (const parc of parcelas) {
          // CR fica em nome do cliente final (pessoaId); se é cartão, adquirenteCartaoId
          // aponta para a adquirente que vai liquidar.
          let origemCR = 'fatura';
          let adquirenteCartaoId = null;
          if (MEIOS_CARTAO.has(parc.meioPagamento)) {
            if (!parc.bandeiraId) throw new Error(`Parcela ${parc.numero}/${parc.total}: bandeira do cartão obrigatória`);
            const adq = db.prepare('SELECT id, nome FROM adquirentes_cartao WHERE id = ? AND ativo = 1').get(parc.bandeiraId);
            if (!adq) throw new Error(`Parcela ${parc.numero}/${parc.total}: adquirente de cartão não cadastrada`);
            adquirenteCartaoId = adq.id;
            origemCR = 'cartao_adquirente';
          }

          const descParcela = parcelas.length > 1
            ? `Fatura ${numero} - Pedido ${pedido.numero} (parcela ${parc.numero}/${parc.total})`
            : `Fatura ${numero} - Pedido ${pedido.numero}`;

          const contaId = db.prepare(`
            INSERT INTO contas_a_receber (pessoaId, faturaId, descricao, valor, dataEmissao,
              dataVencimento, formaPagamento, observacoes, origem,
              parcelaNumero, totalParcelas, grupoParcelaId, adquirenteCartaoId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(pedido.clienteId, faturaId, descParcela,
            parc.valor, dataEmissao, parc.dataVencimento,
            parc.meioPagamento || null,
            parc.observacao || `Gerada automaticamente a partir da fatura ${numero}`,
            origemCR,
            parcelas.length > 1 ? parc.numero : null,
            parcelas.length > 1 ? parc.total : null,
            grupoParcelaId,
            adquirenteCartaoId
          ).lastInsertRowid;
          idsCR.push(contaId);

          // Auto-baixa para Dinheiro / PIX desta parcela
          if (MEIOS_AVISTA_CAIXA.has(parc.meioPagamento) || MEIOS_AVISTA_BANCO.has(parc.meioPagamento)) {
            const tipoPadrao = MEIOS_AVISTA_CAIXA.has(parc.meioPagamento) ? 'caixa' : 'banco';
            const contaFinanceira = getContaPadrao(db, tipoPadrao);
            if (!contaFinanceira) throw new Error(`Conta financeira padrão do tipo "${tipoPadrao}" não configurada`);

            db.prepare(`UPDATE contas_a_receber SET status = 'paga', valorPago = ?, dataPagamento = ?,
              contaFinanceiraId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
              .run(parc.valor, dataEmissao, contaFinanceira.id, contaId);

            lancarMovimentacao(db, {
              contaId: contaFinanceira.id,
              tipo: 'entrada', valor: parc.valor, data: dataEmissao,
              descricao: `Recebimento à vista - Fatura ${numero}${parcelas.length>1?' parc '+parc.numero+'/'+parc.total:''}`,
              origem: 'fatura_avista', origemId: faturaId,
              categoria: 'vendas',
              usuario: req.session?.username || null
            });
          }
        }

        // Retrocompat: faturas.contaReceberId aponta para a primeira CR (legacy)
        db.prepare('UPDATE faturas SET contaReceberId = ? WHERE id = ?').run(idsCR[0], faturaId);

        db.prepare(`UPDATE pedidos SET status = 'faturado', faturaId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(faturaId, pedido.id);
      });
      tx();

      // Reflete no pedido a eventual auto-baixa à vista (Dinheiro/PIX) feita dentro da tx.
      const crFat = db.prepare('SELECT id FROM contas_a_receber WHERE faturaId = ? LIMIT 1').get(faturaId);
      if (crFat) sincronizarPagamentoPedido(db, crFat.id);

      // Auto-cobrança ao faturar: gera + envia boleto (tPag 15) ou PIX QR/link (tPag 17)
      // para as parcelas correspondentes. Best-effort e fire-and-forget — não bloqueia o faturamento.
      try {
        const { tPagFromForma } = require('./meio-pagamento');
        const crs = db.prepare(
          "SELECT id, formaPagamento FROM contas_a_receber WHERE faturaId = ? AND status = 'aberta'"
        ).all(faturaId);
        const crsBoleto = crs.filter(c => tPagFromForma(c.formaPagamento) === '15');
        const crsPix = crs.filter(c => tPagFromForma(c.formaPagamento) === '17');
        if (crsBoleto.length || crsPix.length) {
          const { gerarEEnviarBoletoParaCR, gerarEEnviarPixParaCR } = require('./financeiro-routes');
          (async () => {
            for (const c of crsBoleto) {
              try { await gerarEEnviarBoletoParaCR(db, c.id); }
              catch (e) { console.error(`[Fatura][auto-boleto] CR ${c.id}:`, e.message); }
            }
            for (const c of crsPix) {
              try { await gerarEEnviarPixParaCR(db, c.id); }
              catch (e) { console.error(`[Fatura][auto-pix] CR ${c.id}:`, e.message); }
            }
          })();
        }
      } catch (e) { console.error('[Fatura][auto-cobranca] falha:', e.message); }

      res.json({ success: true, fatura: carregarFaturaCompleta(db, faturaId) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== LISTAR/DETALHAR ====================

  app.get('/api/faturas', (req, res) => {
    try {
      const { status, clienteId, busca, dataInicio, dataFim, incluirExcluidas } = req.query;
      let sql = `
        SELECT f.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
          ped.numero AS pedidoNumero,
          cr.status AS contaReceberStatus,
          op.emiteNFe AS tipoOperacaoEmiteNFe,
          op.codigo AS tipoOperacaoCodigo
        FROM faturas f
        LEFT JOIN pessoas p ON p.id = f.clienteId
        LEFT JOIN pedidos ped ON ped.id = f.pedidoId
        LEFT JOIN contas_a_receber cr ON cr.id = f.contaReceberId
        LEFT JOIN tipos_operacao op ON op.id = f.tipoOperacaoId
        WHERE 1=1`;
      const params = [];
      const rbac = escopoSql(req, 'f.estabelecimentoId');
      sql += rbac.sql; params.push(...rbac.params);
      if (incluirExcluidas !== '1') { sql += ' AND COALESCE(f.excluida, 0) = 0'; }
      if (status) { sql += ' AND f.status = ?'; params.push(status); }
      if (clienteId) { sql += ' AND f.clienteId = ?'; params.push(clienteId); }
      if (dataInicio) { sql += ' AND f.dataEmissao >= ?'; params.push(dataInicio); }
      if (dataFim) { sql += ' AND f.dataEmissao <= ?'; params.push(dataFim); }
      if (busca) {
        sql += ' AND (f.numero LIKE ? OR p.razaoSocial LIKE ? OR ped.numero LIKE ?)';
        const like = `%${busca}%`;
        params.push(like, like, like);
      }
      sql += ' ORDER BY f.dataEmissao DESC, f.id DESC';
      const faturas = db.prepare(sql).all(...params);
      res.json({ success: true, faturas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/faturas/:id', (req, res) => {
    try {
      const fatura = carregarFaturaCompleta(db, req.params.id);
      if (!fatura) return res.status(404).json({ success: false, error: 'Fatura nao encontrada' });
      res.json({ success: true, fatura });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/faturas/:id/pdf', (req, res) => {
    try {
      const fatura = carregarFaturaCompleta(db, req.params.id);
      if (!fatura) return res.status(404).json({ success: false, error: 'Fatura nao encontrada' });
      const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {};
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${fatura.numero}.pdf"`);
      faturasPdf.gerar(res, fatura, emitente);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===== Cancelamento — funções distintas por caso =====
  //
  // Caso 1: NF-e autorizada na SEFAZ → cancela via evento 110111
  // Caso 2: Fatura local com CRs/estoque/movimentações → estorno + reabertura
  // Caso 3: Combinação dos dois (fatura emitida + NF-e autorizada).
  //
  // Cada função é chamada isoladamente pelo dispatcher conforme o estado da
  // fatura. Falha do passo SEFAZ aborta o local — não pode haver fatura
  // cancelada com NF-e oficialmente autorizada.

  async function _cancelarNFeNaSefaz(fatura, motivo) {
    const { getTools } = require('./nfe-emit-routes');
    const tools = await getTools(db);
    const respSefaz = await tools.sefazEvento({
      chNFe: fatura.chaveAcesso,
      tpEvento: '110111',
      nSeqEvento: 1,
      xJust: motivo,
      nProt: fatura.protocoloAutorizacao,
    });
    const str = typeof respSefaz === 'string' ? respSefaz : JSON.stringify(respSefaz);
    const m = str.match(/<retEvento[^>]*>([\s\S]*?)<\/retEvento>/);
    const inner = m ? m[1] : str;
    const cStat = (inner.match(/<cStat>([^<]+)<\/cStat>/) || [])[1] || '';
    const xMotivoSefaz = (inner.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] || '';
    const nProt = (inner.match(/<nProt>([^<]+)<\/nProt>/) || [])[1] || '';
    if (cStat !== '135' && cStat !== '155') {
      const err = new Error(`SEFAZ recusou cancelamento da NF-e (${cStat}): ${xMotivoSefaz}`);
      err.cStat = cStat; err.xMotivo = xMotivoSefaz;
      throw err;
    }
    db.prepare(`UPDATE faturas SET statusSefaz='cancelada_sefaz', rejeicaoMotivo=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`)
      .run(`Cancelada: ${motivo} (protocolo ${nProt || '—'})`, fatura.id);
    return { cStat, xMotivo: xMotivoSefaz, nProt };
  }

  // Reconciliação local extraída para ./fatura-cancelamento.js (compartilhada
  // com o cancelamento fiscal da NF-e em nfe-emit-routes.js).
  function _cancelarFaturaLocal(fatura, username) {
    cancelarFaturaLocal(db, fatura, username);
  }

  app.post('/api/faturas/:id/cancelar', async (req, res) => {
    try {
      const motivo = String(req.body?.motivo || '').trim();
      const fatura = db.prepare('SELECT * FROM faturas WHERE id = ?').get(req.params.id);
      if (!fatura) return res.status(404).json({ success: false, error: 'Fatura nao encontrada' });

      const temNFe = fatura.statusSefaz === 'autorizada' && !!fatura.chaveAcesso;
      const faturaJaCancelada = fatura.status === 'cancelada';

      // Nada a fazer
      if (faturaJaCancelada && !temNFe) {
        return res.status(400).json({ success: false, error: 'Fatura já cancelada' });
      }

      // Se vai cancelar NF-e, exige motivo
      if (temNFe && motivo.length < 15) {
        return res.status(400).json({
          success: false,
          error: 'Esta fatura tem NF-e autorizada. Informe o motivo do cancelamento (mínimo 15 caracteres).',
          requerMotivo: true,
        });
      }

      // Caso 1: só NF-e (fatura local já cancelada)
      if (faturaJaCancelada && temNFe) {
        try {
          const r = await _cancelarNFeNaSefaz(fatura, motivo);
          return res.json({ success: true, escopo: 'nfe', ...r });
        } catch (e) {
          return res.status(400).json({ success: false, escopo: 'nfe', error: e.message, cStat: e.cStat, xMotivo: e.xMotivo });
        }
      }

      // Caso 2: fatura emitida + NF-e autorizada → cancela ambas
      if (!faturaJaCancelada && temNFe) {
        try {
          await _cancelarNFeNaSefaz(fatura, motivo);
          fatura.statusSefaz = 'cancelada_sefaz';
        } catch (e) {
          return res.status(400).json({ success: false, escopo: 'nfe', error: e.message, cStat: e.cStat, xMotivo: e.xMotivo });
        }
        _cancelarFaturaLocal(fatura, req.session?.username);
        return res.json({ success: true, escopo: 'fatura+nfe' });
      }

      // Caso 3: só fatura local (sem NF-e ou NF-e não autorizada)
      _cancelarFaturaLocal(fatura, req.session?.username);
      return res.json({ success: true, escopo: 'fatura' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== GESTÃO INTERNA: METADADOS / EXCLUIR / RESTAURAR ====================
  // Soft-delete do lançamento interno (não substitui cancelamento SEFAZ).
  // Consumido por /notas-fiscais.html.

  app.put('/api/faturas/:id/metadados', (req, res) => {
    try {
      const r = db.prepare(`UPDATE faturas
        SET observacaoInterna = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(req.body?.observacaoInterna || null, Number(req.params.id));
      if (!r.changes) return res.status(404).json({ success: false, error: 'Fatura não encontrada' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Faturas (NF-e de saída) são notas emitidas — permanentes no sistema por
  // exigência fiscal. Sem endpoint de exclusão. Use POST /:id/cancelar para
  // o cancelamento fiscal (evento 110111 + status local 'cancelada').
  //
  // O endpoint de restauração permanece para cobrir eventuais registros
  // legados marcados como excluídos antes desta regra.
  app.post('/api/faturas/:id/restaurar', (req, res) => {
    try {
      const r = db.prepare(`UPDATE faturas
        SET excluida = 0, dataExclusao = NULL, motivoExclusao = NULL,
        dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ? AND excluida = 1`).run(Number(req.params.id));
      if (!r.changes) return res.status(404).json({ success: false, error: 'Fatura não encontrada ou não estava excluída' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasFaturas };
