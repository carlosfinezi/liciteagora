/**
 * fluxo-caixa-routes.js — Fluxo de Caixa consolidado (realizado + projetado).
 *
 * Exporta:
 *   - registrarRotasFluxoCaixa(app, db)
 *
 * Endpoint:
 *   GET /api/fluxo-caixa?dataInicio=YYYY-MM-DD&dataFim=YYYY-MM-DD&contas=1,2
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

function eachDay(inicio, fim) {
  const out = [];
  let cur = inicio;
  let guard = 0;
  while (cur <= fim && guard++ < 3650) {
    out.push(cur);
    cur = addDias(cur, 1);
  }
  return out;
}

function parseContasParam(raw) {
  if (!raw) return null;
  const ids = String(raw).split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.length ? ids : null;
}

function registrarRotas(app, db) {
  app.get('/api/fluxo-caixa', (req, res) => {
    try {
      const hoje = dataBrasilia();
      const dataInicio = (req.query.dataInicio || hoje).slice(0, 10);
      const dataFim = (req.query.dataFim || addDias(dataInicio, 90)).slice(0, 10);
      if (dataFim < dataInicio) {
        return res.status(400).json({ success: false, error: 'dataFim deve ser >= dataInicio' });
      }

      const idsParam = parseContasParam(req.query.contas);
      let contas;
      if (idsParam) {
        const placeholders = idsParam.map(() => '?').join(',');
        contas = db.prepare(`SELECT * FROM contas_financeiras WHERE id IN (${placeholders})`).all(...idsParam);
      } else {
        contas = db.prepare('SELECT * FROM contas_financeiras WHERE ativo = 1').all();
      }
      if (!contas.length) {
        return res.status(400).json({ success: false, error: 'Nenhuma conta financeira ativa encontrada' });
      }
      const contaIds = contas.map(c => c.id);
      const contaIdSet = new Set(contaIds);
      const placeholders = contaIds.map(() => '?').join(',');

      // Saldo inicial: soma dos saldoInicial + soma de movs anteriores a dataInicio
      let saldoInicial = contas.reduce((s, c) => s + (c.saldoInicial || 0), 0);
      const priorRows = db.prepare(`
        SELECT contaId, tipo, valor, contraContaId
        FROM movimentacoes_financeiras
        WHERE contaId IN (${placeholders}) AND data < ?
      `).all(...contaIds, dataInicio);
      for (const m of priorRows) {
        // Transferências internas (ambas as contas filtradas) anulam no consolidado — ignora
        if (m.tipo === 'transferencia_entrada' || m.tipo === 'transferencia_saida') {
          if (m.contraContaId && contaIdSet.has(m.contraContaId)) continue;
        }
        if (m.tipo === 'entrada' || m.tipo === 'transferencia_entrada') saldoInicial += m.valor;
        else if (m.tipo === 'saida' || m.tipo === 'transferencia_saida') saldoInicial -= m.valor;
      }

      // Dias do período
      const dias = {};
      for (const d of eachDay(dataInicio, dataFim)) {
        dias[d] = {
          data: d,
          entradas: { realizado: 0, previsto: 0 },
          saidas: { realizado: 0, previsto: 0 },
          saldoFinal: 0,
          itens: []
        };
      }

      // Realizado — movimentações
      const movs = db.prepare(`
        SELECT id, contaId, tipo, valor, data, descricao, origem, origemId, contraContaId, categoria
        FROM movimentacoes_financeiras
        WHERE contaId IN (${placeholders}) AND data BETWEEN ? AND ?
        ORDER BY data ASC, id ASC
      `).all(...contaIds, dataInicio, dataFim);
      for (const m of movs) {
        if (!dias[m.data]) continue;
        let tipoFluxo = null;
        if (m.tipo === 'entrada') tipoFluxo = 'entrada';
        else if (m.tipo === 'saida') tipoFluxo = 'saida';
        else if (m.tipo === 'transferencia_entrada' || m.tipo === 'transferencia_saida') {
          if (m.contraContaId && contaIdSet.has(m.contraContaId)) continue;
          tipoFluxo = m.tipo === 'transferencia_entrada' ? 'entrada' : 'saida';
        }
        if (!tipoFluxo) continue;
        dias[m.data][tipoFluxo === 'entrada' ? 'entradas' : 'saidas'].realizado += m.valor;
        dias[m.data].itens.push({
          tipo: tipoFluxo,
          status: 'realizado',
          valor: m.valor,
          descricao: m.descricao,
          origem: m.origem || 'manual',
          origemId: m.origemId || null,
          categoria: m.categoria || null,
          movimentacaoId: m.id
        });
      }

      // Projetado — CR em aberto
      const filtroContaCR = idsParam
        ? ` AND contaFinanceiraId IN (${placeholders})`
        : '';
      const cr = db.prepare(`
        SELECT id, descricao, valor, COALESCE(valorPago, 0) AS valorPago, dataVencimento, contaFinanceiraId
        FROM contas_a_receber
        WHERE status IN ('aberta', 'parcial')
          AND dataVencimento BETWEEN ? AND ?
          ${filtroContaCR}
      `).all(...(idsParam ? [dataInicio, dataFim, ...contaIds] : [dataInicio, dataFim]));
      for (const r of cr) {
        if (!dias[r.dataVencimento]) continue;
        const saldo = (r.valor || 0) - (r.valorPago || 0);
        if (saldo <= 0) continue;
        dias[r.dataVencimento].entradas.previsto += saldo;
        dias[r.dataVencimento].itens.push({
          tipo: 'entrada',
          status: 'previsto',
          valor: saldo,
          descricao: r.descricao || `CR #${r.id}`,
          origem: 'cr',
          origemId: r.id
        });
      }

      // Projetado — CP em aberto
      const filtroContaCP = idsParam
        ? ` AND contaFinanceiraId IN (${placeholders})`
        : '';
      const cp = db.prepare(`
        SELECT id, descricao, valor, COALESCE(valorPago, 0) AS valorPago, dataVencimento, contaFinanceiraId
        FROM contas_a_pagar
        WHERE status IN ('aberta', 'parcial')
          AND dataVencimento BETWEEN ? AND ?
          ${filtroContaCP}
      `).all(...(idsParam ? [dataInicio, dataFim, ...contaIds] : [dataInicio, dataFim]));
      for (const r of cp) {
        if (!dias[r.dataVencimento]) continue;
        const saldo = (r.valor || 0) - (r.valorPago || 0);
        if (saldo <= 0) continue;
        dias[r.dataVencimento].saidas.previsto += saldo;
        dias[r.dataVencimento].itens.push({
          tipo: 'saida',
          status: 'previsto',
          valor: saldo,
          descricao: r.descricao || `CP #${r.id}`,
          origem: 'cp',
          origemId: r.id
        });
      }

      // Projetado — provisões manuais ativas (item 3.4). Não dependem de
      // conta financeira, então entram independente do filtro de contas.
      try {
        const provisoes = db.prepare(`
          SELECT id, descricao, tipo, valor, dataPrevista FROM provisoes
          WHERE status = 'ativa' AND dataPrevista BETWEEN ? AND ?
        `).all(dataInicio, dataFim);
        for (const pv of provisoes) {
          if (!dias[pv.dataPrevista]) continue;
          const alvo = pv.tipo === 'entrada' ? dias[pv.dataPrevista].entradas : dias[pv.dataPrevista].saidas;
          alvo.previsto += pv.valor;
          dias[pv.dataPrevista].itens.push({
            tipo: pv.tipo, status: 'previsto', valor: pv.valor,
            descricao: `📌 Provisão: ${pv.descricao}`, origem: 'provisao', origemId: pv.id
          });
        }
      } catch { /* tabela provisoes ainda não existe neste tenant */ }

      // Acumular saldo dia a dia
      const diasArr = Object.values(dias).sort((a, b) => a.data.localeCompare(b.data));
      let saldo = saldoInicial;
      let saldoMinimo = { data: null, valor: Infinity };
      const totais = {
        entradasRealizadas: 0, entradasPrevistas: 0,
        saidasRealizadas: 0, saidasPrevistas: 0
      };
      for (const d of diasArr) {
        const delta =
          d.entradas.realizado + d.entradas.previsto
          - d.saidas.realizado - d.saidas.previsto;
        saldo += delta;
        d.saldoFinal = Number(saldo.toFixed(2));
        totais.entradasRealizadas += d.entradas.realizado;
        totais.entradasPrevistas += d.entradas.previsto;
        totais.saidasRealizadas += d.saidas.realizado;
        totais.saidasPrevistas += d.saidas.previsto;
        if (d.saldoFinal < saldoMinimo.valor) saldoMinimo = { data: d.data, valor: d.saldoFinal };
        // Ordenar itens do dia: realizados primeiro, depois previstos; entradas antes de saídas
        d.itens.sort((a, b) => {
          if (a.status !== b.status) return a.status === 'realizado' ? -1 : 1;
          if (a.tipo !== b.tipo) return a.tipo === 'entrada' ? -1 : 1;
          return 0;
        });
      }

      res.json({
        success: true,
        periodo: { dataInicio, dataFim },
        contasFiltradas: contas.map(c => ({ id: c.id, nome: c.nome, tipo: c.tipo })),
        saldoInicial: Number(saldoInicial.toFixed(2)),
        dias: diasArr,
        totais: {
          entradasRealizadas: Number(totais.entradasRealizadas.toFixed(2)),
          entradasPrevistas: Number(totais.entradasPrevistas.toFixed(2)),
          saidasRealizadas: Number(totais.saidasRealizadas.toFixed(2)),
          saidasPrevistas: Number(totais.saidasPrevistas.toFixed(2)),
          saldoFinal: diasArr.length ? diasArr[diasArr.length - 1].saldoFinal : Number(saldoInicial.toFixed(2)),
          saldoMinimo: saldoMinimo.data ? saldoMinimo : null
        }
      });
    } catch (err) {
      console.error('[fluxo-caixa] erro:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasFluxoCaixa: registrarRotas };
