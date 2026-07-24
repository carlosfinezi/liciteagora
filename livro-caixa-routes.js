/**
 * livro-caixa-routes.js — Livro Caixa digital obrigatório (LC 123/06 art. 26).
 *
 * Consolida movimentações financeiras de todas as contas ativas em formato
 * tradicional de livro caixa (data · histórico · documento · entrada · saída · saldo).
 *
 * Endpoint:
 *   GET /api/fiscal/livro-caixa?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&contas=csv&formato=json|csv
 */

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function addDias(ymd, dias) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function fmtBRL(v) {
  return (v == null || isNaN(v)) ? '0,00' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseContasParam(raw) {
  if (!raw) return null;
  const ids = String(raw).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
}

function descricaoOrigem(origem, origemId) {
  if (!origem) return '';
  const mapa = {
    baixa_cr: `Baixa CR #${origemId || ''}`.trim(),
    pagto_cp: `Pagto CP #${origemId || ''}`.trim(),
    manual: 'Lançamento manual',
    nfse: `NFSe #${origemId || ''}`.trim(),
    transferencia: 'Transferência entre contas',
    boleto_mp: `Boleto MP #${origemId || ''}`.trim(),
    backfill_v1: 'Backfill histórico'
  };
  return mapa[origem] || origem;
}

function montarLivro(db, { dataInicio, dataFim, contaIds }) {
  const contaIdSet = new Set(contaIds);
  const placeholders = contaIds.map(() => '?').join(',');

  let saldoInicial = 0;
  const contas = db.prepare(`SELECT id, nome, saldoInicial FROM contas_financeiras WHERE id IN (${placeholders})`).all(...contaIds);
  for (const c of contas) saldoInicial += Number(c.saldoInicial || 0);
  const anteriores = db.prepare(`
    SELECT tipo, valor, contraContaId
    FROM movimentacoes_financeiras
    WHERE contaId IN (${placeholders}) AND data < ?
  `).all(...contaIds, dataInicio);
  for (const m of anteriores) {
    if ((m.tipo === 'transferencia_entrada' || m.tipo === 'transferencia_saida') && m.contraContaId && contaIdSet.has(m.contraContaId)) continue;
    if (m.tipo === 'entrada' || m.tipo === 'transferencia_entrada') saldoInicial += m.valor;
    else if (m.tipo === 'saida' || m.tipo === 'transferencia_saida') saldoInicial -= m.valor;
  }

  const movs = db.prepare(`
    SELECT m.id, m.contaId, c.nome AS contaNome, m.tipo, m.valor, m.data,
           m.descricao, m.origem, m.origemId, m.contraContaId, m.categoria, m.usuario, m.dataCriacao
    FROM movimentacoes_financeiras m
    JOIN contas_financeiras c ON c.id = m.contaId
    WHERE m.contaId IN (${placeholders}) AND m.data BETWEEN ? AND ?
    ORDER BY m.data ASC, m.id ASC
  `).all(...contaIds, dataInicio, dataFim);

  let saldo = saldoInicial;
  const linhas = [];
  for (const m of movs) {
    if ((m.tipo === 'transferencia_entrada' || m.tipo === 'transferencia_saida') && m.contraContaId && contaIdSet.has(m.contraContaId)) continue;
    const entrada = (m.tipo === 'entrada' || m.tipo === 'transferencia_entrada') ? Number(m.valor) : 0;
    const saida   = (m.tipo === 'saida'   || m.tipo === 'transferencia_saida')   ? Number(m.valor) : 0;
    saldo += entrada - saida;
    linhas.push({
      data: m.data,
      historico: m.descricao || descricaoOrigem(m.origem, m.origemId),
      documento: m.origemId ? `${(m.origem || 'MOV').toUpperCase()}-${m.origemId}` : `MOV-${m.id}`,
      conta: m.contaNome,
      origem: m.origem || 'manual',
      categoria: m.categoria || null,
      entrada, saida,
      saldo: Math.round(saldo * 100) / 100,
      movimentacaoId: m.id
    });
  }

  const totalEntradas = linhas.reduce((s, l) => s + l.entrada, 0);
  const totalSaidas = linhas.reduce((s, l) => s + l.saida, 0);

  return {
    periodo: { dataInicio, dataFim },
    contasFiltradas: contas,
    saldoInicial: Math.round(saldoInicial * 100) / 100,
    linhas,
    totais: {
      entradas: Math.round(totalEntradas * 100) / 100,
      saidas: Math.round(totalSaidas * 100) / 100,
      saldoFinal: Math.round((saldoInicial + totalEntradas - totalSaidas) * 100) / 100
    }
  };
}

function registrarRotas(app, db) {
  app.get('/api/fiscal/livro-caixa', (req, res) => {
    try {
      const hoje = dataBrasilia();
      const dataInicio = (req.query.dataInicio || addDias(hoje, -30)).slice(0, 10);
      const dataFim = (req.query.dataFim || hoje).slice(0, 10);
      if (dataFim < dataInicio) return res.status(400).json({ success: false, error: 'dataFim deve ser >= dataInicio' });

      const idsParam = parseContasParam(req.query.contas);
      let contaIds;
      if (idsParam) {
        const ph = idsParam.map(() => '?').join(',');
        contaIds = db.prepare(`SELECT id FROM contas_financeiras WHERE id IN (${ph})`).all(...idsParam).map(r => r.id);
      } else {
        contaIds = db.prepare('SELECT id FROM contas_financeiras WHERE ativo = 1').all().map(r => r.id);
      }
      if (!contaIds.length) return res.status(400).json({ success: false, error: 'Nenhuma conta ativa' });

      const livro = montarLivro(db, { dataInicio, dataFim, contaIds });

      if ((req.query.formato || 'json').toLowerCase() === 'csv') {
        const head = 'data;historico;documento;conta;entrada;saida;saldo';
        const rows = livro.linhas.map(l =>
          [l.data, (l.historico||'').replace(/;/g,','), l.documento, (l.conta||'').replace(/;/g,','),
           fmtBRL(l.entrada), fmtBRL(l.saida), fmtBRL(l.saldo)].join(';'));
        const csv = [
          `Livro Caixa - ${livro.periodo.dataInicio} a ${livro.periodo.dataFim}`,
          `Saldo inicial;;;;;;${fmtBRL(livro.saldoInicial)}`,
          head, ...rows,
          `Totais;;;;${fmtBRL(livro.totais.entradas)};${fmtBRL(livro.totais.saidas)};${fmtBRL(livro.totais.saldoFinal)}`
        ].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="livro-caixa-${livro.periodo.dataInicio}_${livro.periodo.dataFim}.csv"`);
        return res.send('\uFEFF' + csv);
      }

      res.json({ success: true, ...livro });
    } catch (err) {
      console.error('[livro-caixa] erro:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[livro-caixa] Rotas registradas');
}

module.exports = { registrarRotasLivroCaixa: registrarRotas };
