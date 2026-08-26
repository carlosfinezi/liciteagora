'use strict';

/**
 * devolucao-venda.js — Devolução de VENDA (espelho da NF-e de saída).
 *
 * O cliente devolve mercadoria que nós vendemos: emitimos NF-e de ENTRADA (tpNF=0,
 * finNFe=4), CFOP 1xxx/2xxx, refNFe = chave da venda, destinatário = o próprio cliente,
 * REPRODUZINDO os impostos que destacamos na saída — é o que sustenta o crédito dele e o
 * nosso estorno. Suporta total e parcial.
 *
 * Irmão de devolucao-compra.js (devolução ao fornecedor); os dois dividem o motor em
 * espelho-fiscal.js. O que muda aqui:
 *   - a origem é uma `faturas` autorizada (xmlAssinado = nfeProc), não uma nfe_entrada;
 *   - o CFOP sai invertido do de/para que já existe em `cfops.cfopContrapartida`;
 *   - os efeitos internos (estoque, crédito ao cliente, comissão) NÃO são refeitos aqui:
 *     o módulo cria e efetiva um RMA em devolucoes-routes.js, que é quem sabe fazer isso.
 *     Um fato, um caminho — senão o mesmo retorno entraria duas vezes no estoque.
 *
 * Limitação herdada da devolução de compra: o espelho emite o grupo ICMS do Simples
 * (CSOSN). Emitente em regime normal precisa de CST — o preview avisa e o POST recusa,
 * em vez de gerar nota com o grupo errado.
 */

const espelhoFiscal = require('./espelho-fiscal');
const { crtDoEmitente, ehSimples } = require('./fiscal-tributacao');

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

// ─── Schema ──────────────────────────────────────────────────────────────────
// Aplicado por-tenant no boot loop do server.js (contra o proxy seria no-op).
function migrarSchema(db) {
  // A fatura de devolução aponta para a nota devolvida (a chave já vai em refNFeOriginal,
  // mas id resolve junção e saldo sem depender de string).
  alterSafe(db, 'ALTER TABLE faturas ADD COLUMN faturaOrigemId INTEGER');
  alterSafe(db, 'ALTER TABLE fatura_itens ADD COLUMN faturaItemOrigemId INTEGER');
  alterSafe(db, 'ALTER TABLE fatura_itens ADD COLUMN valorDesconto REAL');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_faturas_origem ON faturas(faturaOrigemId)');
  alterSafe(db, 'CREATE INDEX IF NOT EXISTS idx_fatura_itens_origem ON fatura_itens(faturaItemOrigemId)');
  // Colunas de vínculo no RMA (devolucoes/devolucao_itens). migrarDB é idempotente.
  try { require('./devolucoes-routes').migrarDB(db); } catch (e) { /* tenant sem o módulo */ }
}

// ─── CFOP: saída original → devolução de entrada ─────────────────────────────
// O de/para já existe na tabela `cfops`, só que declarado do lado da devolução:
// 1202.cfopContrapartida = 5102, 2202 = 6102, 1411 = 5403… Consultar pela contrapartida
// devolve o CFOP de entrada correspondente. O prefixo (1 interno / 2 interestadual) vem
// junto, porque o CFOP de saída já carrega essa distinção (5xxx vs 6xxx).
function cfopDevolucaoVenda(db, cfopSaida, { ufDestino, ufEmitente } = {}) {
  const cfop = String(cfopSaida || '').trim();
  if (cfop) {
    try {
      const row = db.prepare(
        `SELECT codigo FROM cfops
          WHERE cfopContrapartida = ? AND categoriaOperacao = 'devolucao_venda'
          ORDER BY codigo LIMIT 1`).get(cfop);
      if (row) return { cfop: row.codigo, doMapa: true };
    } catch { /* tabela cfops ausente em tenant antigo */ }
  }
  // Fallback conservador: devolução de venda de mercadoria adquirida — a mesma regra que o
  // emissor já usa quando não encontra contrapartida (nfe-emit-routes.js).
  if (!ufDestino || ufDestino === 'EX') return { cfop: '3202', doMapa: false };
  return { cfop: ufDestino === ufEmitente ? '1202' : '2202', doMapa: false };
}

// ─── Espelho de UMA nota de venda ────────────────────────────────────────────
// Junta os itens gravados (fatura_itens — produtoId, quantidade, valores) com os impostos
// parseados do XML autorizado. O casamento é por posição (o XML foi montado na mesma ordem,
// `ORDER BY id ASC`), conferindo o cProd; quando não bate, procura pelo código.
function montarItensEspelhoVenda(db, faturaId) {
  const f = db.prepare(`
    SELECT f.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
           p.uf AS clienteUf, p.inscricaoEstadual AS clienteIe
      FROM faturas f LEFT JOIN pessoas p ON p.id = f.clienteId
     WHERE f.id = ?`).get(faturaId);
  if (!f) throw new Error('Nota de venda não encontrada: ' + faturaId);

  let ufEmitente = '';
  try { ufEmitente = (db.prepare('SELECT uf FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}).uf || ''; } catch {}

  const doXml = f.xmlAssinado ? espelhoFiscal.parseEspelho(f.xmlAssinado) : [];
  const porCodigo = new Map(doXml.map(x => [String(x.codigoProduto || '').trim(), x]));

  const itensDb = db.prepare(
    'SELECT id, produtoId, sku, descricao, unidade, quantidade, precoUnitario, valorTotal, ncm, cfop, origem FROM fatura_itens WHERE faturaId = ? ORDER BY id ASC'
  ).all(faturaId);

  const itens = itensDb.map((dbi, idx) => {
    const porPosicao = doXml[idx];
    const codigoDb = String(dbi.sku || dbi.produtoId || '').trim();
    const xml = (porPosicao && String(porPosicao.codigoProduto || '').trim() === codigoDb)
      ? porPosicao
      : (porCodigo.get(codigoDb) || porPosicao || null);

    const cfopSaida = (xml && xml.cfopXml) || dbi.cfop;
    const dev = cfopDevolucaoVenda(db, cfopSaida, {
      ufDestino: (f.clienteUf || '').toUpperCase(),
      ufEmitente: (ufEmitente || '').toUpperCase(),
    });

    return {
      faturaItemOrigemId: dbi.id,
      numero: idx + 1,
      produtoId: dbi.produtoId,
      sku: dbi.sku,
      descricao: dbi.descricao,
      ncm: dbi.ncm || (xml ? xml.ncm : null),
      unidade: dbi.unidade || (xml ? xml.unidade : 'UN'),
      // Quantidade e valores do XML quando disponíveis: é o que foi tributado.
      quantidadeOrigem: xml ? xml.quantidade : Number(dbi.quantidade),
      valorUnitario: xml ? xml.valorUnitario : Number(dbi.precoUnitario),
      valorTotal: xml ? xml.valorTotal : Number(dbi.valorTotal),
      valorDesconto: xml ? xml.valorDesconto : 0,
      valorFrete: xml ? xml.valorFrete : 0,
      cfopSaida,
      cfopDevolucao: dev.cfop,
      cfopDevolucaoDoMapa: dev.doMapa,
      imposto: xml ? xml.imposto : null,
      ibsCbs: xml ? xml.ibsCbs : null,
      semXml: !xml,
    };
  });

  return { fatura: f, itens, ufEmitente };
}

// ─── Saldo devolvível por item da nota ───────────────────────────────────────
// Conta TODA devolução viva (aberta ou efetivada) do mesmo produto ligada àquela nota OU ao
// pedido que a originou. As duas origens entram na mesma soma justamente para que um RMA
// aberto à mão e uma devolução espelho não devolvam a mesma peça duas vezes; cada linha de
// devolucao_itens conta uma vez só (o OR não duplica).
function saldoPorItem(db, fatura, itens, { ignorarDevolucaoId = null } = {}) {
  const stmt = db.prepare(`
    SELECT COALESCE(SUM(di.quantidade), 0) AS q
      FROM devolucao_itens di
      JOIN devolucoes d ON d.id = di.devolucaoId
     WHERE di.produtoId = ?
       AND d.status IN ('aberta', 'efetivada')
       AND (? IS NULL OR d.id <> ?)
       AND (d.faturaOrigemId = ? OR (? IS NOT NULL AND d.pedidoId = ?))`);
  for (const it of itens) {
    const usado = it.produtoId
      ? Number(stmt.get(it.produtoId, ignorarDevolucaoId, ignorarDevolucaoId,
          fatura.id, fatura.pedidoId, fatura.pedidoId).q)
      : 0;
    it.quantidadeDevolvida = usado;
    it.saldoDisponivel = Math.max(0, (Number(it.quantidadeOrigem) || 0) - usado);
  }
  return itens;
}

// Item da nota → item do pedido, quando dá para amarrar sem ambiguidade. Com o
// pedidoItemId preenchido, o RMA valida o saldo pela linha do pedido (mais preciso);
// sem ele, cai na validação agregada por produto — que também barra excesso.
function pedidoItemDe(db, fatura, produtoId) {
  if (!fatura.pedidoId || !produtoId) return null;
  try {
    const linhas = db.prepare('SELECT id FROM pedido_itens WHERE pedidoId = ? AND produtoId = ?')
      .all(fatura.pedidoId, produtoId);
    return linhas.length === 1 ? linhas[0].id : null;
  } catch { return null; }
}

// Avisos que a tela mostra antes de emitir. Nenhum deles impede sozinho — quem impede é o
// POST, e só nos casos em que a nota sairia errada.
function avisosDe(db, fatura, itens) {
  const crt = crtDoEmitente(db);
  return {
    cfopsForaDoMapa: itens.filter(i => !i.cfopDevolucaoDoMapa).length,
    itensSemXml: itens.filter(i => i.semXml).length,
    itensSemProduto: itens.filter(i => !i.produtoId).length,
    // Cliente contribuinte emite a própria nota de devolução; a nossa entrada só vale
    // quando ele é dispensado (consumidor final, produtor rural sem IE etc.).
    clienteContribuinte: !!(fatura.clienteIe && String(fatura.clienteIe).trim()
      && String(fatura.clienteIe).trim().toUpperCase() !== 'ISENTO'),
    regimeNaoSimples: !ehSimples(crt),
    crt,
  };
}

function registrar(app, db) {
  // ─── Preview (READ-ONLY — não emite nem grava nada) ───────────────────────
  app.get('/api/faturas/:id/devolucao/preview', (req, res) => {
    try {
      const { fatura, itens } = montarItensEspelhoVenda(db, Number(req.params.id));
      saldoPorItem(db, fatura, itens);
      res.json({
        success: true,
        nota: {
          id: fatura.id, numero: fatura.numero, numeroNFe: fatura.numeroNFe, serie: fatura.serieNFe,
          chave: fatura.chaveAcesso, dataEmissao: fatura.dataEmissao, statusSefaz: fatura.statusSefaz,
          cliente: fatura.clienteNome, cpfCnpj: fatura.clienteCpfCnpj, uf: fatura.clienteUf,
          inscricaoEstadual: fatura.clienteIe, pedidoId: fatura.pedidoId,
          valorTotal: fatura.valorTotal, temXml: !!fatura.xmlAssinado,
        },
        natOp: 'Devolução de venda',
        itens,
        avisos: avisosDe(db, fatura, itens),
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─── Emitir devolução de venda ────────────────────────────────────────────
  // Ordem: valida → cria RMA → efetiva (estoque/crédito) → cria fatura espelho → emite.
  // O RMA vem antes da nota de propósito: se a SEFAZ recusar, o retorno físico já está
  // registrado e a emissão pode ser repetida sem refazer estoque.
  app.post('/api/faturas/:id/devolucao', async (req, res) => {
    try {
      const faturaId = Number(req.params.id);
      const { fatura, itens } = montarItensEspelhoVenda(db, faturaId);

      if (fatura.statusSefaz !== 'autorizada') {
        return res.status(400).json({ success: false, error: 'Só nota autorizada pode ser devolvida' });
      }
      if (!fatura.xmlAssinado) {
        return res.status(400).json({ success: false, error: 'Nota sem XML guardado — não há o que espelhar' });
      }
      const avisos = avisosDe(db, fatura, itens);
      if (avisos.regimeNaoSimples) {
        return res.status(400).json({
          success: false,
          error: 'Emitente fora do Simples: o espelho ainda só monta o grupo ICMS do Simples (CSOSN). Emita a devolução manualmente em Fiscal → NF-e manual.',
        });
      }

      // Seleção: body.total = tudo; senão body.itens [{ faturaItemOrigemId, quantidade }].
      let quantidades = null;
      if (!req.body.total) {
        const sel = Array.isArray(req.body.itens) ? req.body.itens : [];
        quantidades = new Map();
        for (const s of sel) {
          const q = Number(s.quantidade);
          if (q > 0) quantidades.set(Number(s.faturaItemOrigemId), q);
        }
        if (!quantidades.size) {
          return res.status(400).json({ success: false, error: 'Selecione itens/quantidades (ou envie total:true)' });
        }
      }

      // Trava de saldo antes de tocar em qualquer tabela.
      saldoPorItem(db, fatura, itens);
      const selecionados = [];
      for (const it of itens) {
        const pedido = quantidades ? (quantidades.get(it.faturaItemOrigemId) || 0) : it.quantidadeOrigem;
        if (!(pedido > 0)) continue;
        if (pedido > it.saldoDisponivel + 1e-6) {
          return res.status(400).json({
            success: false,
            error: `Item ${it.numero} (${it.descricao}): devolução ${pedido} > saldo disponível ${it.saldoDisponivel.toFixed(4)}`,
          });
        }
        if (!it.produtoId) {
          return res.status(400).json({
            success: false,
            error: `Item ${it.numero} (${it.descricao}) não tem produto vinculado — o retorno ao estoque exige produto cadastrado`,
          });
        }
        selecionados.push({ item: it, quantidade: pedido });
      }
      if (!selecionados.length) return res.status(400).json({ success: false, error: 'Nada a devolver' });

      const devolverFrete = !!req.body.devolverFrete;
      const { itens: tags, totais } = espelhoFiscal.calcularImpostoEspelho(itens, quantidades, {
        chaveItem: 'faturaItemOrigemId',
        devolverFrete,
      });
      if (!tags.length) return res.status(400).json({ success: false, error: 'Nada a devolver' });

      // 1) RMA: mesmo caminho do formulário de devolução (estoque, crédito, comissão).
      const { criarDevolucao, efetivarDevolucao } = require('./devolucoes-routes');
      let devolucaoId;
      try {
        devolucaoId = criarDevolucao(db, req, {
          pedidoId: fatura.pedidoId || null,
          clienteId: fatura.clienteId,
          motivo: req.body.motivo || null,
          observacoes: `Devolução espelho da NF-e ${fatura.numeroNFe || fatura.numero}`,
          tipoOperacaoId: req.body.tipoOperacaoId || null,
          faturaOrigemId: fatura.id,
          devolverFrete,
          itens: selecionados.map(s => ({
            produtoId: s.item.produtoId,
            pedidoItemId: pedidoItemDe(db, fatura, s.item.produtoId),
            faturaItemOrigemId: s.item.faturaItemOrigemId,
            descricao: s.item.descricao,
            quantidade: s.quantidade,
            valorUnitario: s.item.valorUnitario,
            motivo: req.body.motivo || null,
          })),
        });
      } catch (e) {
        return res.status(e.status || 400).json({ success: false, error: 'Devolução não registrada: ' + e.message });
      }

      let efeitos = null;
      try {
        const r = efetivarDevolucao(db, req, devolucaoId);
        efeitos = { comissoes: r.comissoes, crNegativoId: r.devolucao.crNegativoId };
      } catch (e) {
        // RMA fica aberto: o usuário resolve a pendência (lote/série/saldo) e efetiva por lá.
        return res.status(e.status || 400).json({
          success: false, devolucaoId,
          error: 'Devolução registrada, mas não efetivada: ' + e.message,
        });
      }

      // 2) Fatura espelho + emissão.
      const seq = (db.prepare(
        `SELECT COUNT(*) c FROM faturas WHERE tipoDevolucao='venda' AND faturaOrigemId=?`).get(faturaId).c) + 1;
      const numero = `DEVV-${fatura.numeroNFe || fatura.numero}/${seq}`;
      const hoje = new Date().toISOString().slice(0, 10);
      const chaveRef = (fatura.chaveAcesso || '').replace(/\D/g, '');

      // faturas.pedidoId é NOT NULL no schema antigo; devolução de nota avulsa não tem pedido.
      require('./devolucao-compra').tornarPedidoIdNulavel(db);

      const novaFaturaId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento,
            valorBruto, valorTotal, valorDesconto, valorFrete, status, observacao, isDevolucao,
            devolucaoId, refNFeOriginal, faturaOrigemId, tipoDevolucao, tipoOperacaoId)
          VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'emitida', ?, 1, ?, ?, ?, 'venda', ?)
        `).run(numero, fatura.clienteId, hoje, hoje, Number(totais.vProd), Number(totais.vNF),
          Number(totais.vDesc), Number(totais.vFrete),
          `Devolução de venda ref. NF-e ${fatura.numeroNFe || fatura.numero}${req.body.motivo ? ' · ' + req.body.motivo : ''}`,
          devolucaoId, chaveRef, fatura.id, req.body.tipoOperacaoId || null);
        const fid = r.lastInsertRowid;
        const stmt = db.prepare(`
          INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade, quantidade,
            precoUnitario, valorTotal, valorDesconto, ncm, cfop, origem, faturaItemOrigemId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const t of tags) {
          const orig = itens.find(i => i.faturaItemOrigemId === t.faturaItemOrigemId);
          stmt.run(fid, t.produtoId || null, orig?.sku || (t.produtoId ? String(t.produtoId) : ''),
            (t.descricao || '').substring(0, 120), t.unidade || 'UN', t.quantidade, t.valorUnitario,
            t.vProd, t.vDesc, t.ncm || '00000000', t.cfop, t.icms.orig, t.faturaItemOrigemId);
        }
        return fid;
      })();

      const { emitirNFe } = require('./nfe-emit-routes');
      let emissao;
      try { emissao = await emitirNFe(db, novaFaturaId); }
      catch (e) {
        return res.status(500).json({
          success: false, devolucaoId, faturaId: novaFaturaId,
          error: 'Devolução efetivada, mas a emissão falhou: ' + e.message,
        });
      }

      const fat = db.prepare('SELECT statusSefaz, chaveAcesso, rejeicaoMotivo FROM faturas WHERE id = ?').get(novaFaturaId);
      res.json({
        success: fat.statusSefaz === 'autorizada',
        devolucaoId, faturaId: novaFaturaId, numero,
        statusSefaz: fat.statusSefaz, chaveAcesso: fat.chaveAcesso,
        motivo: fat.rejeicaoMotivo || emissao?.xMotivo, cStat: emissao?.cStat,
        valorTotal: totais.vNF, avisos, efeitos,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = {
  registrar,
  migrarSchema,
  cfopDevolucaoVenda,
  montarItensEspelhoVenda,
  saldoPorItem,
  avisosDe,
};
