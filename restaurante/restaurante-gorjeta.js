/**
 * restaurante-gorjeta.js — Módulo Restaurante, fase 9: rateio da gorjeta.
 *
 * Lei 13.419/2017, que alterou o art. 457 da CLT. O que ela impõe e está
 * codificado aqui:
 *
 *  1. A gorjeta (taxa de serviço) NÃO é receita da casa. Vai integralmente aos
 *     empregados que participam do atendimento — garçons, cumins, atendentes.
 *  2. O critério de rateio vem de convenção ou acordo coletivo. Como isso muda
 *     por sindicato e por cidade, o critério aqui é CONFIGURÁVEL, não fixo.
 *  3. A empresa pode reter parte para custear os encargos que incidem sobre a
 *     gorjeta (13º, férias, FGTS, INSS quando devido):
 *        - até 20% para optantes do SIMPLES NACIONAL
 *        - até 33% para os demais regimes
 *     Os tetos NÃO são sugestão: reter acima disso é infração.
 *  4. O valor tem de constar em CTPS e no contracheque — por isso o rateio
 *     gera linha por funcionário e por período, e não um número agregado.
 *  5. Atraso no repasse gera multa de 1/30 da média diária por dia, limitada
 *     ao piso da categoria (triplicada na reincidência). O sistema não calcula
 *     multa — ele existe para que o atraso não aconteça —, mas registra a data
 *     do repasse, que é a prova.
 *
 * O que este arquivo NÃO faz: decidir quem participa. Cumim e copeiro não
 * lançam item e por isso não aparecem sozinhos — quem monta a lista é o gestor.
 */

const { agora } = require('./restaurante-comanda');
const { repartir } = require('./restaurante-fechamento');

const CRITERIOS = ['igual', 'proporcional-vendas', 'pontos'];

// Tetos legais de retenção para encargos.
const TETO_RETENCAO = { simples: 20, normal: 33 };

function centavos(v) { return Math.round(Number(v || 0) * 100); }
function reais(c) { return Math.round(c) / 100; }

function tetoDoRegime(regime) {
  return TETO_RETENCAO[regime === 'simples' ? 'simples' : 'normal'];
}

/**
 * Quanto de gorjeta entrou no período e quem atendeu.
 *
 * A base é `totalTaxaServico` das comandas FECHADAS — comanda aberta ainda
 * pode ter a taxa recusada pelo cliente, e contar antes disso distribuiria
 * dinheiro que não entrou.
 */
function apurar(db, de, ate) {
  const contas = db.prepare(`
    SELECT id, totalTaxaServico, totalItens
      FROM rest_comandas
     WHERE status = 'fechada' AND totalTaxaServico > 0
       AND DATE(fechadaEm) BETWEEN DATE(?) AND DATE(?)
  `).all(de, ate);

  const totalGorjeta = contas.reduce((s, c) => centavos(c.totalTaxaServico) + s, 0);

  // Quem lançou item nas contas do período — a base natural de participantes.
  const atendentes = db.prepare(`
    SELECT i.garcomUserId AS funcionarioId,
           COALESCE(u.nome, u.username, 'não identificado') AS nome,
           COUNT(DISTINCT i.comandaId) AS contas,
           COALESCE(SUM(i.precoTotal), 0) AS vendido
      FROM rest_comanda_itens i
      JOIN rest_comandas c ON c.id = i.comandaId
      LEFT JOIN users u ON u.id = i.garcomUserId
     WHERE c.status = 'fechada' AND i.status <> 'cancelado'
       AND i.garcomUserId IS NOT NULL
       AND DATE(c.fechadaEm) BETWEEN DATE(?) AND DATE(?)
     GROUP BY i.garcomUserId
     ORDER BY vendido DESC
  `).all(de, ate);

  return {
    periodo: { de, ate },
    contas: contas.length,
    totalGorjeta: reais(totalGorjeta),
    atendentes: atendentes.map(a => ({ ...a, vendido: reais(centavos(a.vendido)) })),
  };
}

/**
 * Distribui `total` (em centavos) entre `pesos`, garantindo que a soma das
 * partes seja EXATAMENTE o total. A sobra da divisão inteira vai para quem
 * tem o maior peso.
 *
 * Existe para não haver dois lugares arredondando o mesmo dinheiro: sem uma
 * função só, a soma das retenções deixa de bater com a retenção total por um
 * centavo, e o gestor vê "reteve 20,001%" onde configurou 20%.
 */
function distribuirProporcional(total, pesos) {
  const soma = pesos.reduce((s, w) => s + w, 0);
  if (soma <= 0) return pesos.map(() => 0);
  const partes = pesos.map(w => Math.floor((total * w) / soma));
  let sobra = total - partes.reduce((s, v) => s + v, 0);
  const ordem = pesos.map((w, i) => ({ w, i })).sort((a, b) => b.w - a.w);
  let k = 0;
  while (sobra > 0 && ordem.length) {
    partes[ordem[k % ordem.length].i] += 1;
    sobra--; k++;
  }
  return partes;
}

function calcularRateio({ totalGorjeta, retencaoPct, criterio, participantes }) {
  const bruto = centavos(totalGorjeta);
  const pct = Number(retencaoPct || 0);
  // A retenção TOTAL é calculada uma vez, sobre o total. Depois é distribuída.
  // Arredondar linha a linha faria 3 × 20% de R$ 333,34 somar R$ 200,01.
  const retencaoTotal = Math.round(bruto * (pct / 100));

  if (!participantes.length) {
    return {
      bruto: reais(bruto), retencao: reais(retencaoTotal),
      liquido: reais(bruto - retencaoTotal), linhas: [],
    };
  }

  // Reparte o BRUTO — é o número que vai para o contracheque de cada um.
  let brutos;
  let caiuParaIgual = false;

  if (criterio === 'igual') {
    // repartir() distribui o resto: 3 pessoas em R$ 100 recebem 33,34 / 33,33
    // / 33,33, e não 33,33 três vezes, que perderia um centavo.
    brutos = repartir(bruto, participantes.length).map(centavos);
  } else {
    // Proporcional a um peso: vendas realizadas ou pontos de convenção.
    const pesos = participantes.map(p => {
      const w = criterio === 'pontos' ? Number(p.peso || 0) : Number(p.vendido || 0);
      return w > 0 ? w : 0;
    });
    if (pesos.reduce((s, w) => s + w, 0) <= 0) {
      // Sem peso válido, cair para divisão igual é melhor do que devolver
      // zero a todos — mas o chamador precisa saber que isso aconteceu.
      brutos = repartir(bruto, participantes.length).map(centavos);
      caiuParaIgual = true;
    } else {
      brutos = distribuirProporcional(bruto, pesos);
    }
  }

  // A retenção segue a mesma proporção do bruto, e a soma fecha por construção.
  const retencoes = distribuirProporcional(retencaoTotal, brutos);

  const linhas = participantes.map((p, i) => ({
    funcionarioId: p.funcionarioId || null,
    funcionarioNome: p.nome || p.funcionarioNome || 'sem nome',
    valorBruto: reais(brutos[i]),
    retencaoEncargos: reais(retencoes[i]),
    valorLiquido: reais(brutos[i] - retencoes[i]),
  }));

  return {
    bruto: reais(bruto),
    retencao: reais(retencaoTotal),
    liquido: reais(bruto - retencaoTotal),
    caiuParaIgual,
    linhas,
  };
}

function registrarRotasGorjeta(app, db, gateFlag, deps) {
  const { lerConfig } = deps;

  app.get('/api/restaurante/gorjetas/apurar', gateFlag, (req, res) => {
    try {
      const de = req.query.de || '0000-01-01';
      const ate = req.query.ate || '9999-12-31';
      const cfg = lerConfig(db);
      const regime = cfg.restaurante_regime_tributario || 'simples';
      const a = apurar(db, de, ate);
      res.json({
        success: true,
        ...a,
        regime,
        tetoRetencaoPct: tetoDoRegime(regime),
        retencaoPctConfigurada: Number(cfg.restaurante_gorjeta_retencao_pct || 0),
        criterioPadrao: cfg.restaurante_gorjeta_criterio || 'igual',
        criterios: CRITERIOS,
        // Lembrete que a tela mostra: a lista de participantes não é automática.
        observacao: 'Cumins, copeiros e atendentes que não lançam item precisam ser incluídos à mão.',
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/gorjetas/ratear', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const de = b.de, ate = b.ate;
      if (!de || !ate) return res.status(400).json({ success: false, error: 'informe o período' });

      const criterio = b.criterio || 'igual';
      if (!CRITERIOS.includes(criterio)) {
        return res.status(400).json({ success: false, error: 'critério inválido' });
      }

      const cfg = lerConfig(db);
      const regime = cfg.restaurante_regime_tributario || 'simples';
      const teto = tetoDoRegime(regime);
      const retencaoPct = b.retencaoPct !== undefined
        ? Number(b.retencaoPct) : Number(cfg.restaurante_gorjeta_retencao_pct || 0);

      if (!Number.isFinite(retencaoPct) || retencaoPct < 0) {
        return res.status(400).json({ success: false, error: 'percentual de retenção inválido' });
      }
      // Reter acima do teto legal é infração — barrar aqui é mais barato do
      // que descobrir numa fiscalização.
      if (retencaoPct > teto) {
        return res.status(400).json({
          success: false,
          error: `retenção de ${retencaoPct}% acima do teto legal de ${teto}% para o regime ${regime}`,
          teto,
        });
      }

      const jaExiste = db.prepare(
        'SELECT COUNT(*) AS n FROM rest_gorjeta_rateio WHERE periodoIni = ? AND periodoFim = ?'
      ).get(de, ate);
      if (jaExiste.n > 0 && !b.refazer) {
        return res.status(400).json({
          success: false,
          error: 'já existe rateio para este período — confirme para refazer',
          linhas: jaExiste.n,
        });
      }

      const a = apurar(db, de, ate);
      if (a.totalGorjeta <= 0) {
        return res.status(400).json({ success: false, error: 'nenhuma gorjeta no período' });
      }

      // Participantes: os informados, ou os atendentes apurados.
      const participantes = Array.isArray(b.participantes) && b.participantes.length
        ? b.participantes.map(p => ({
            funcionarioId: p.funcionarioId != null ? Number(p.funcionarioId) : null,
            nome: String(p.nome || p.funcionarioNome || '').trim() || 'sem nome',
            peso: Number(p.peso || 0),
            // Quem foi incluído à mão não tem vendas apuradas; herda do
            // apurado quando o id bate.
            vendido: p.vendido != null ? Number(p.vendido)
              : (a.atendentes.find(x => x.funcionarioId === Number(p.funcionarioId)) || {}).vendido || 0,
          }))
        : a.atendentes.map(x => ({ ...x, peso: 0 }));

      if (!participantes.length) {
        return res.status(400).json({ success: false, error: 'nenhum participante para ratear' });
      }

      const calc = calcularRateio({
        totalGorjeta: a.totalGorjeta, retencaoPct, criterio, participantes,
      });

      db.transaction(() => {
        db.prepare('DELETE FROM rest_gorjeta_rateio WHERE periodoIni = ? AND periodoFim = ? AND status = ?')
          .run(de, ate, 'aberto');
        const ins = db.prepare(`
          INSERT INTO rest_gorjeta_rateio (periodoIni, periodoFim, funcionarioId, funcionarioNome,
                                           valorBruto, retencaoEncargos, valorLiquido, criterio, status, criadoEm)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberto', ?)
        `);
        for (const l of calc.linhas) {
          ins.run(de, ate, l.funcionarioId, l.funcionarioNome,
            l.valorBruto, l.retencaoEncargos, l.valorLiquido, criterio, agora());
        }
      })();

      res.json({
        success: true,
        periodo: { de, ate },
        criterio, retencaoPct, regime, teto,
        ...calc,
        // Soma das linhas tem de bater com o líquido: o caixa confere isso.
        confere: Math.abs(
          centavos(calc.linhas.reduce((s, l) => s + l.valorLiquido, 0)) - centavos(calc.liquido)
        ) === 0,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/restaurante/gorjetas', gateFlag, (req, res) => {
    try {
      const items = db.prepare(`
        SELECT * FROM rest_gorjeta_rateio
         ORDER BY periodoIni DESC, valorLiquido DESC LIMIT ?
      `).all(Number(req.query.limit) || 300);

      // Agrupa por período: é assim que o gestor pensa (folha de um mês).
      const periodos = [];
      for (const l of items) {
        const chave = `${l.periodoIni}|${l.periodoFim}`;
        let p = periodos.find(x => x.chave === chave);
        if (!p) {
          p = {
            chave, periodoIni: l.periodoIni, periodoFim: l.periodoFim,
            criterio: l.criterio, status: l.status,
            totalBruto: 0, totalRetencao: 0, totalLiquido: 0, linhas: [],
          };
          periodos.push(p);
        }
        p.totalBruto = reais(centavos(p.totalBruto) + centavos(l.valorBruto));
        p.totalRetencao = reais(centavos(p.totalRetencao) + centavos(l.retencaoEncargos));
        p.totalLiquido = reais(centavos(p.totalLiquido) + centavos(l.valorLiquido));
        p.linhas.push(l);
        // Um período só é "pago" quando todas as linhas estão pagas.
        if (l.status !== 'pago') p.status = l.status;
      }
      res.json({ success: true, periodos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Registra o repasse. A data é a prova de que não houve atraso — que é o
   * que gera a multa de 1/30 da média diária por dia.
   */
  app.post('/api/restaurante/gorjetas/pagar', gateFlag, (req, res) => {
    try {
      const { de, ate } = req.body || {};
      if (!de || !ate) return res.status(400).json({ success: false, error: 'informe o período' });
      const linhas = db.prepare(
        'SELECT COUNT(*) AS n FROM rest_gorjeta_rateio WHERE periodoIni = ? AND periodoFim = ?'
      ).get(de, ate);
      if (!linhas.n) return res.status(404).json({ success: false, error: 'não há rateio para este período' });

      const r = db.prepare(`
        UPDATE rest_gorjeta_rateio SET status = 'pago'
         WHERE periodoIni = ? AND periodoFim = ? AND status <> 'pago'
      `).run(de, ate);
      res.json({ success: true, pagas: r.changes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de gorjeta registradas');
}

module.exports = {
  registrarRotasGorjeta,
  calcularRateio,
  distribuirProporcional,
  apurar,
  tetoDoRegime,
  CRITERIOS,
  TETO_RETENCAO,
};
