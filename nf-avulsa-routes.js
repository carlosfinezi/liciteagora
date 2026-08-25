/**
 * nf-avulsa-routes.js — NF-e manual (avulsa), com rascunho.
 *
 * O equivalente da pré-nota do Solution ERP: um documento fiscal digitado à mão,
 * que existe como rascunho editável e só vira NF-e quando alguém manda emitir.
 *
 * Reaproveita a espinha inteira da emissão que já rodava:
 *   - o documento é uma `faturas` com pedidoId NULL e origemDocumento='avulsa'
 *     (mesmo padrão da devolução de compra, que já emite sem pedido)
 *   - a emissão é o `emitirNFe` de sempre — este módulo NÃO monta XML
 *   - a tributação sai do motor (fiscal-tributacao.js), aplicado dentro do emitirNFe
 *
 * O que é próprio daqui: o rascunho, a validação antes de emitir, e os efeitos que
 * o Tipo de Operação pedir (estoque quando movimentaEstoque=1, contas a receber
 * quando geraFinanceiro=1) — que no fluxo normal vêm do ciclo do pedido e aqui
 * não teriam quem os disparasse.
 */

const { initFiscalTribSchema } = require('./fiscal-trib-schema');
const { resolverDeposito } = require('./estoque-routes');

const STATUS_RASCUNHO = 'rascunho';

function migrar(db) {
  // Em tenant NOVO o initSchema roda antes de `faturas` existir, então os ALTERs
  // do schema fiscal falham calados lá. Aqui já rodam com a tabela criada.
  // Ver comentário no topo de fiscal-trib-schema.js.
  try { initFiscalTribSchema(db); } catch (err) {
    console.warn('[nf-avulsa] migrar:', err.message);
  }
}

function dataHoje() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDias(dataISO, dias) {
  const d = new Date(dataISO + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(dias || 0));
  return d.toISOString().slice(0, 10);
}

// Numeração própria, separada da série de faturas de pedido: a NF avulsa tem de
// ser reconhecível na lista sem abrir. NFA-00001, NFA-00002…
function gerarNumero(db) {
  const row = db.prepare(
    `SELECT numero FROM faturas WHERE numero LIKE 'NFA-%' ORDER BY id DESC LIMIT 1`).get();
  const seq = row ? (parseInt(String(row.numero).replace('NFA-', ''), 10) || 0) + 1 : 1;
  return `NFA-${String(seq).padStart(5, '0')}`;
}

function carregar(db, id) {
  const f = db.prepare(`
    SELECT f.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
           p.uf AS clienteUf, p.cidade AS clienteCidade,
           t.codigo AS tipoOperacaoCodigo, t.descricao AS tipoOperacaoDescricao,
           t.movimentaEstoque, t.geraFinanceiro, t.emiteNFe, t.finalidadeNFe
      FROM faturas f
      LEFT JOIN pessoas p ON p.id = f.clienteId
      LEFT JOIN tipos_operacao t ON t.id = f.tipoOperacaoId
     WHERE f.id = ?`).get(id);
  if (!f) return null;
  f.itens = db.prepare('SELECT * FROM fatura_itens WHERE faturaId = ? ORDER BY id ASC').all(id);
  f.parcelas = db.prepare(
    'SELECT id, valor, dataVencimento, formaPagamento, status FROM contas_a_receber WHERE faturaId = ? ORDER BY dataVencimento ASC, id ASC'
  ).all(id);
  return f;
}

// Campos de tributação que a tela pode gravar por item (override manual). Quando
// vazios, o motor resolve pela matriz de regras.
const CAMPOS_TRIB_ITEM = [
  'cstIcms', 'csosnIcms', 'modBC', 'pIcms', 'pRedBC', 'pFcp', 'pDif',
  'modBCST', 'pMVAST', 'pRedBCST', 'pIcmsST',
  'cstIpi', 'pIpi', 'cstPis', 'pPis', 'cstCofins', 'pCofins',
];

function gravarItens(db, faturaId, itens) {
  db.prepare('DELETE FROM fatura_itens WHERE faturaId = ?').run(faturaId);
  const ins = db.prepare(`
    INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade, quantidade,
      precoUnitario, valorTotal, ncm, cfop, origem, infAdProd,
      ${CAMPOS_TRIB_ITEM.join(', ')})
    VALUES (@faturaId, @produtoId, @sku, @descricao, @unidade, @quantidade,
      @precoUnitario, @valorTotal, @ncm, @cfop, @origem, @infAdProd,
      ${CAMPOS_TRIB_ITEM.map(c => '@' + c).join(', ')})`);

  for (const it of itens) {
    const qtd = Number(it.quantidade) || 0;
    const pu = Number(it.precoUnitario) || 0;
    const linha = {
      faturaId,
      produtoId: it.produtoId ? Number(it.produtoId) : null,
      sku: it.sku || null,
      descricao: String(it.descricao || '').substring(0, 120),
      unidade: it.unidade || 'UN',
      quantidade: qtd,
      precoUnitario: pu,
      valorTotal: Number((qtd * pu).toFixed(2)),
      ncm: it.ncm || null,
      cfop: it.cfop || null,
      origem: it.origem != null ? String(it.origem) : '0',
      infAdProd: it.infAdProd || null,
    };
    for (const c of CAMPOS_TRIB_ITEM) {
      const v = it[c];
      linha[c] = (v === undefined || v === null || v === '') ? null : v;
    }
    ins.run(linha);
  }
}

function somarItens(itens) {
  return Number(itens.reduce((s, it) =>
    s + (Number(it.quantidade) || 0) * (Number(it.precoUnitario) || 0), 0).toFixed(2));
}

function registrarRotas(app, db) {
  migrar(db);

  // ─── Rascunho: criar ──────────────────────────────────────────────────────
  app.post('/api/nf-avulsa', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.clienteId) return res.status(400).json({ success: false, error: 'Destinatário obrigatório' });

      const itens = Array.isArray(b.itens) ? b.itens : [];
      const valorBruto = somarItens(itens);
      const valorFrete = Number(b.valorFrete) || 0;
      const valorDesconto = Number(b.valorDesconto) || 0;
      const dataEmissao = b.dataEmissao || dataHoje();

      const id = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento,
            valorBruto, valorFrete, valorDesconto, valorTotal, meioPagamento, observacao,
            status, origemDocumento, tipoOperacaoId, estabelecimentoId)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'avulsa', ?, ?)`).run(
          gerarNumero(db), Number(b.clienteId), dataEmissao,
          b.dataVencimento || addDias(dataEmissao, 30),
          valorBruto, valorFrete, valorDesconto,
          Number((valorBruto + valorFrete - valorDesconto).toFixed(2)),
          b.meioPagamento || null, b.observacao || null,
          STATUS_RASCUNHO,
          b.tipoOperacaoId ? Number(b.tipoOperacaoId) : null,
          b.estabelecimentoId ? Number(b.estabelecimentoId) : null);
        const fid = r.lastInsertRowid;
        if (itens.length) gravarItens(db, fid, itens);
        return fid;
      })();

      res.json({ success: true, id, nota: carregar(db, id) });
    } catch (error) {
      console.error('[NF avulsa] criar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Rascunho: ler ────────────────────────────────────────────────────────
  app.get('/api/nf-avulsa/:id', (req, res) => {
    const nota = carregar(db, Number(req.params.id));
    if (!nota) return res.status(404).json({ success: false, error: 'Nota não encontrada' });
    res.json({ success: true, nota });
  });

  // ─── Rascunho: listar ─────────────────────────────────────────────────────
  app.get('/api/nf-avulsa', (req, res) => {
    const filtros = ["f.origemDocumento = 'avulsa'", 'COALESCE(f.excluida, 0) = 0'];
    const params = [];
    if (req.query.status) { filtros.push('f.status = ?'); params.push(req.query.status); }
    const linhas = db.prepare(`
      SELECT f.id, f.numero, f.status, f.dataEmissao, f.valorTotal, f.chaveAcesso,
             f.statusSefaz, f.numeroNFe, f.serieNFe,
             p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
             t.codigo AS tipoOperacaoCodigo, t.descricao AS tipoOperacaoDescricao
        FROM faturas f
        LEFT JOIN pessoas p ON p.id = f.clienteId
        LEFT JOIN tipos_operacao t ON t.id = f.tipoOperacaoId
       WHERE ${filtros.join(' AND ')}
       ORDER BY f.id DESC`).all(...params);
    res.json({ success: true, notas: linhas });
  });

  // ─── Rascunho: editar ─────────────────────────────────────────────────────
  app.put('/api/nf-avulsa/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const atual = db.prepare('SELECT status, origemDocumento FROM faturas WHERE id = ?').get(id);
      if (!atual) return res.status(404).json({ success: false, error: 'Nota não encontrada' });
      if (atual.status !== STATUS_RASCUNHO) {
        return res.status(400).json({ success: false, error: 'Só rascunho pode ser editado' });
      }

      const b = req.body || {};
      const itens = Array.isArray(b.itens) ? b.itens : null;
      const valorBruto = itens ? somarItens(itens)
        : Number(db.prepare('SELECT COALESCE(SUM(valorTotal),0) v FROM fatura_itens WHERE faturaId = ?').get(id).v);
      const valorFrete = Number(b.valorFrete) || 0;
      const valorDesconto = Number(b.valorDesconto) || 0;

      db.transaction(() => {
        db.prepare(`UPDATE faturas SET
            clienteId = COALESCE(?, clienteId),
            tipoOperacaoId = ?, dataEmissao = COALESCE(?, dataEmissao),
            dataVencimento = COALESCE(?, dataVencimento),
            valorBruto = ?, valorFrete = ?, valorDesconto = ?, valorTotal = ?,
            meioPagamento = ?, observacao = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?`).run(
          b.clienteId ? Number(b.clienteId) : null,
          b.tipoOperacaoId ? Number(b.tipoOperacaoId) : null,
          b.dataEmissao || null, b.dataVencimento || null,
          valorBruto, valorFrete, valorDesconto,
          Number((valorBruto + valorFrete - valorDesconto).toFixed(2)),
          b.meioPagamento || null, b.observacao || null, id);
        if (itens) gravarItens(db, id, itens);
      })();

      res.json({ success: true, nota: carregar(db, id) });
    } catch (error) {
      console.error('[NF avulsa] editar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Rascunho: descartar ──────────────────────────────────────────────────
  // Rascunho nunca foi documento fiscal — some de vez, junto dos itens. Nota já
  // emitida usa o soft-delete de /api/faturas, que é outro caminho de propósito.
  app.post('/api/nf-avulsa/:id/excluir', (req, res) => {
    try {
      const id = Number(req.params.id);
      const f = db.prepare('SELECT status, origemDocumento FROM faturas WHERE id = ?').get(id);
      if (!f) return res.status(404).json({ success: false, error: 'Nota não encontrada' });
      if (f.status !== STATUS_RASCUNHO || f.origemDocumento !== 'avulsa') {
        return res.status(400).json({ success: false, error: 'Só rascunho de NF avulsa pode ser descartado' });
      }
      db.transaction(() => {
        db.prepare('DELETE FROM fiscal_calculo_memoria WHERE documento = ? AND documentoId = ?').run('fatura', id);
        db.prepare('DELETE FROM fatura_itens WHERE faturaId = ?').run(id);
        db.prepare('DELETE FROM faturas WHERE id = ?').run(id);
      })();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Prévia da tributação (sem emitir) ────────────────────────────────────
  // Deixa a tela mostrar o imposto de cada item ANTES de mandar para a SEFAZ —
  // é o que a aba Impostos do Solution faz, e o que evita descobrir erro de
  // alíquota por rejeição.
  app.post('/api/nf-avulsa/:id/previa-tributacao', (req, res) => {
    try {
      const nota = carregar(db, Number(req.params.id));
      if (!nota) return res.status(404).json({ success: false, error: 'Nota não encontrada' });

      const { crtDoEmitente, calcularItem, ambitoDe } = require('./fiscal-tributacao');
      const emit = db.prepare('SELECT uf FROM fornecedor WHERE id = 1').get() || {};
      const crt = crtDoEmitente(db, nota.estabelecimentoId || null);

      const itens = nota.itens.map(it => {
        const manual = {};
        for (const c of CAMPOS_TRIB_ITEM) if (it[c] !== null && it[c] !== undefined && it[c] !== '') manual[c === 'pFcp' ? 'pFCP' : c] = it[c];
        try {
          const r = calcularItem(db, {
            crt, tipoOperacaoId: nota.tipoOperacaoId, cfop: it.cfop, ncm: it.ncm,
            produtoId: it.produtoId, ufOrigem: emit.uf, ufDestino: nota.clienteUf,
            ambito: ambitoDe(emit.uf, nota.clienteUf),
            origemProduto: it.origem, vProd: it.valorTotal, vFrete: 0, vDesc: 0, vOutro: 0,
            manual,
          });
          return { itemId: it.id, descricao: it.descricao, ok: true,
            grupo: r.grupo, icms: r.icms, ipi: r.ipi, pis: r.pis, cofins: r.cofins,
            totais: r.totais, memoria: r.memoria, regraId: r.regraId, origem: r.origem };
        } catch (err) {
          return { itemId: it.id, descricao: it.descricao, ok: false, erro: err.message };
        }
      });

      res.json({ success: true, crt, itens });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Emitir ───────────────────────────────────────────────────────────────
  app.post('/api/nf-avulsa/:id/emitir', async (req, res) => {
    const id = Number(req.params.id);
    try {
      const nota = carregar(db, id);
      if (!nota) return res.status(404).json({ success: false, error: 'Nota não encontrada' });
      if (nota.status !== STATUS_RASCUNHO) {
        return res.status(400).json({ success: false, error: `Nota já está em "${nota.status}"` });
      }

      // ── Validações que a SEFAZ cobraria depois, checadas antes ──
      const faltas = [];
      if (!nota.clienteId) faltas.push('destinatário');
      if (!nota.tipoOperacaoId) faltas.push('tipo de operação');
      if (!nota.itens.length) faltas.push('ao menos um item');
      for (const it of nota.itens) {
        if (!it.cfop) faltas.push(`CFOP do item "${it.descricao}"`);
        if (!it.ncm) faltas.push(`NCM do item "${it.descricao}"`);
        if (!(Number(it.quantidade) > 0)) faltas.push(`quantidade do item "${it.descricao}"`);
      }
      if (faltas.length) {
        return res.status(400).json({ success: false, error: 'Faltando: ' + faltas.join(', ') });
      }
      if (nota.emiteNFe === 0) {
        return res.status(400).json({ success: false,
          error: `O tipo de operação "${nota.tipoOperacaoCodigo}" não emite NF-e (documento interno)` });
      }

      const geraFinanceiro = nota.geraFinanceiro === null ? true : !!nota.geraFinanceiro;
      const movimentaEstoque = nota.movimentaEstoque === null ? true : !!nota.movimentaEstoque;

      if (geraFinanceiro && !nota.meioPagamento) {
        return res.status(400).json({ success: false,
          error: 'Meio de pagamento obrigatório — o tipo de operação escolhido gera financeiro' });
      }

      // ── Promove o rascunho e dispara os efeitos, tudo numa transação ──
      // O emitirNFe exige status 'emitida' (nfe-emit-routes: "Fatura não está emitida"),
      // então a promoção acontece aqui, antes da chamada.
      const parcelasBody = Array.isArray(req.body && req.body.parcelas) ? req.body.parcelas : null;
      db.transaction(() => {
        // A data de emissão passa a ser a de HOJE, não a que o rascunho carregava.
        // Não existe emissão retroativa — o dhEmi do XML é sempre o instante da
        // transmissão. Um rascunho de dezembro emitido em janeiro precisa constar
        // como nota de janeiro, ou o documento diverge do próprio XML (e da
        // alíquota vigente, se houve virada no meio).
        const dataReal = dataHoje();
        db.prepare(`UPDATE faturas SET status = 'emitida', dataEmissao = ?,
            dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(dataReal, id);
        nota.dataEmissao = dataReal;

        if (geraFinanceiro) {
          const parcelas = (parcelasBody && parcelasBody.length) ? parcelasBody : [{
            valor: nota.valorTotal, dataVencimento: nota.dataVencimento, formaPagamento: nota.meioPagamento,
          }];
          const soma = Number(parcelas.reduce((s, p) => s + (Number(p.valor) || 0), 0).toFixed(2));
          if (Math.abs(soma - Number(nota.valorTotal)) > 0.01) {
            throw new Error(`Soma das parcelas (R$ ${soma.toFixed(2)}) difere do total (R$ ${Number(nota.valorTotal).toFixed(2)})`);
          }
          const insCR = db.prepare(`
            INSERT INTO contas_a_receber (pessoaId, faturaId, descricao, valor, dataEmissao,
              dataVencimento, formaPagamento, status, origem, estabelecimentoId,
              parcelaNumero, totalParcelas, grupoParcelaId, dataCriacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', 'fatura', ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
          const grupo = parcelas.length > 1 ? `nfa-${id}` : null;
          parcelas.forEach((p, i) => {
            insCR.run(nota.clienteId, id, `NF avulsa ${nota.numero}`,
              Number(p.valor), nota.dataEmissao,
              p.dataVencimento || nota.dataVencimento,
              p.formaPagamento || nota.meioPagamento,
              nota.estabelecimentoId || null,
              i + 1, parcelas.length, grupo);
          });
        }

        if (movimentaEstoque) {
          // Saída direta: a NF avulsa não tem reserva para consumir, ao contrário do
          // pedido (que baixa no /entregar consumindo reservas_estoque).
          const insMov = db.prepare(`
            INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, origem, origemId, observacao, data, depositoId)
            VALUES (?, 'saida', ?, 'nf_avulsa', ?, ?, ?, ?)`);
          for (const it of nota.itens) {
            if (!it.produtoId) continue;
            insMov.run(it.produtoId, Number(it.quantidade), id,
              `Saída pela NF avulsa ${nota.numero}`, nota.dataEmissao,
              resolverDeposito(db, { produtoId: it.produtoId }));
          }
        }
      })();

      // ── Emissão: o motor de sempre ──
      const { emitirNFe } = require('./nfe-emit-routes');
      const resultado = await emitirNFe(db, id);
      res.json({ success: true, resultado, nota: carregar(db, id) });

    } catch (error) {
      console.error('[NF avulsa] emitir:', error.message);
      // Devolve a nota para inspeção: se a promoção passou mas a SEFAZ recusou, ela
      // está 'emitida' com statusSefaz de rejeição — o mesmo estado das outras origens.
      res.status(500).json({ success: false, error: error.message, nota: carregar(db, id) });
    }
  });

  // ─── Memória de cálculo de uma nota já emitida (aba Auditoria) ────────────
  app.get('/api/nf-avulsa/:id/memoria-calculo', (req, res) => {
    const linhas = db.prepare(`
      SELECT m.*, fi.descricao AS itemDescricao
        FROM fiscal_calculo_memoria m
        LEFT JOIN fatura_itens fi ON fi.id = m.itemId
       WHERE m.documento = 'fatura' AND m.documentoId = ?
       ORDER BY m.itemId, m.id`).all(Number(req.params.id));
    res.json({ success: true, linhas });
  });

  console.log('[nf-avulsa] Rotas registradas');
}

module.exports = { registrarRotasNfAvulsa: registrarRotas, migrar };
