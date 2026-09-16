/**
 * posto-lmc.js — Livro de Movimentação de Combustíveis (Resolução ANP 884/2022)
 * e a conciliação diária que o alimenta.
 *
 * A conta do dia, por tanque:
 *
 *   contábil = abertura + descargas − (vendas + consumo interno)
 *   físico   = medição do tanque no fim do dia
 *   perda    = físico − contábil          (negativo = falta, positivo = sobra)
 *
 * A aferição NÃO entra: os 20 L saem pelo bico e voltam ao tanque. Ela é
 * registrada em coluna própria porque a ANP quer vê-la declarada, não porque
 * mude o saldo.
 *
 * BASE DO PERCENTUAL — a resolução diz que a diferença "não poderá exceder
 * 0,6%" sem escrever sobre qual volume. A prática do setor, e o que este
 * módulo faz, é medir sobre a MOVIMENTAÇÃO DE SAÍDA do dia (o que passou pelas
 * bombas), que é o volume onde a perda fisicamente ocorre. Em dia sem venda e
 * com descarga, a base cai para as entradas — senão qualquer sobra de 1 L
 * dividiria por zero e apareceria como infinita. A base usada volta em
 * `baseCalculoL` para que o número nunca precise ser adivinhado por quem lê.
 *
 * O livro é gerado a partir dos movimentos, sempre. Fechar o dia só congela o
 * resultado (e é isso que a ANP chama de escrituração diária); reabrir apaga o
 * congelamento e deixa recalcular.
 */

const { logAction } = require('../audit-log');

function r3(n) { return Number((Number(n) || 0).toFixed(3)); }
function r4(n) { return Number((Number(n) || 0).toFixed(4)); }

function toleranciaPct(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'posto_tolerancia_perda_pct'").get();
    const n = Number(r && r.valor);
    return Number.isFinite(n) && n > 0 ? n : 0.6;
  } catch (_) {
    return 0.6;
  }
}

function diaAnterior(data) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function diaSeguinte(data) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Estoque de abertura de um tanque num dia. Três fontes, nesta ordem:
 *   1. o fechamento do dia anterior já apurado (físico, ou contábil se não houve medição)
 *   2. a última medição feita antes do dia
 *   3. zero — tanque sem história
 * A ordem importa: o livro precisa encadear, e um dia fechado é decisão tomada
 * que não deve ser reescrita por uma medição avulsa lançada depois.
 */
function aberturaDoTanque(db, tanqueId, data) {
  const ontem = diaAnterior(data);
  const lt = db.prepare(`
    SELECT lt.estoqueFisicoL, lt.estoqueContabilL
      FROM posto_lmc_tanques lt
      JOIN posto_lmc_dias d ON d.id = lt.lmcDiaId
     WHERE lt.tanqueId = ? AND d.data = ? AND d.status = 'fechado'
  `).get(tanqueId, ontem);
  if (lt) {
    return { litros: r3(lt.estoqueFisicoL != null ? lt.estoqueFisicoL : lt.estoqueContabilL), origem: 'fechamento-anterior' };
  }
  // Medição tipo 'abertura' do PRÓPRIO dia é, por definição, o estoque de
  // abertura — vem antes de qualquer medição antiga. Só não vence o fechamento
  // do dia anterior, que é decisão já congelada no livro.
  const aberturaDoDia = db.prepare(`
    SELECT litrosFisico FROM posto_medicoes
     WHERE tanqueId = ? AND data = ? AND tipo = 'abertura'
     ORDER BY dataHora ASC, id ASC LIMIT 1
  `).get(tanqueId, data);
  if (aberturaDoDia) {
    return { litros: r3(aberturaDoDia.litrosFisico), origem: 'medicao-abertura-do-dia' };
  }

  const med = db.prepare(`
    SELECT litrosFisico, data, dataHora FROM posto_medicoes
     WHERE tanqueId = ? AND data < ?
     ORDER BY dataHora DESC, id DESC LIMIT 1
  `).get(tanqueId, data);
  if (med) {
    // Se houve movimento ENTRE a medição e o dia pedido, essa abertura ignora
    // tudo o que passou no intervalo — o livro pulou dias sem fechar. Não é
    // erro de cálculo, é buraco de escrituração, e some se ninguém apontar.
    // A janela começa na HORA da medição, não no fim do dia dela: venda das
    // 18h num tanque medido às 8h da manhã do mesmo dia também fica de fora
    // desta abertura, e era justamente o que passava despercebido.
    const desde = med.dataHora || `${med.data} 00:00:00`;
    const ate = `${data} 00:00:00`;
    const meio = db.prepare(`
      SELECT (SELECT COUNT(*) FROM posto_descargas
               WHERE tanqueId = ? AND dataHora > ? AND dataHora < ?) +
             (SELECT COUNT(*) FROM posto_abastecimentos a
                JOIN posto_bicos bi ON bi.id = a.bicoId
               WHERE bi.tanqueId = ? AND a.dataHora > ? AND a.dataHora < ?) AS n
    `).get(tanqueId, desde, ate, tanqueId, desde, ate);
    return {
      litros: r3(med.litrosFisico),
      origem: 'medicao-anterior',
      comLacuna: !!(meio && meio.n > 0),
      movimentoIgnorado: meio ? meio.n : 0,
    };
  }
  return { litros: 0, origem: 'sem-historico' };
}

/**
 * Calcula o dia inteiro sem gravar nada. É a mesma função que a prévia da tela
 * e o fechamento usam — se fossem duas, divergiriam no primeiro ajuste.
 */
function calcularDia(db, data) {
  const tol = toleranciaPct(db);
  const combustiveis = db.prepare(`
    SELECT c.* FROM posto_combustiveis c
     WHERE EXISTS (SELECT 1 FROM posto_tanques t WHERE t.combustivelId = c.id)
     ORDER BY c.nome
  `).all();

  const fim = `${data} 23:59:59`;
  const ini = `${data} 00:00:00`;
  const linhas = [];

  for (const comb of combustiveis) {
    // Tanque desativado sai da conta — MAS só se não tiver movimento no dia.
    // Sem esse filtro, um tanque aposentado (que não pode ser excluído, porque
    // tem histórico) ficava para sempre em `tanquesSemMedicao`, e como a tela
    // de estoque nem o lista, não havia como medi-lo: o dia nunca mais fechava.
    // Com movimento no dia ele volta, porque aí saiu combustível de verdade.
    // Tanque desativado só sai da conta quando está VAZIO. Excluí-lo com saldo
    // fazia ele reaparecer no dia em que voltasse a se mexer, trazendo junto um
    // estoque de abertura que nunca passou por lançamento nenhum — 5.000 L
    // entrando no livro sem origem, e o dia marcado como dentro da tolerância.
    // Enquanto tiver combustível, ele é escriturado todo dia, como manda a ANP.
    // Para aposentá-lo de verdade, o posto o esvazia e mede zero.
    const tanques = db.prepare(`
      SELECT * FROM posto_tanques
       WHERE combustivelId = ?
         AND (ativo = 1
              OR COALESCE((SELECT m.litrosFisico FROM posto_medicoes m
                            WHERE m.tanqueId = posto_tanques.id AND m.data <= ?
                            ORDER BY m.dataHora DESC, m.id DESC LIMIT 1), 0) > 0.001
              OR EXISTS (SELECT 1 FROM posto_descargas d
                          WHERE d.tanqueId = posto_tanques.id AND d.dataHora BETWEEN ? AND ?)
              OR EXISTS (SELECT 1 FROM posto_abastecimentos a
                           JOIN posto_bicos bi ON bi.id = a.bicoId
                          WHERE bi.tanqueId = posto_tanques.id AND a.dataHora BETWEEN ? AND ?))
       ORDER BY codigo
    `).all(comb.id, data, `${data} 00:00:00`, `${data} 23:59:59`, `${data} 00:00:00`, `${data} 23:59:59`);
    const detalhe = [];
    let abertura = 0, entradas = 0, vendas = 0, interno = 0, afericoes = 0;
    let fisicoTotal = 0;

    for (const t of tanques) {
      const ab = aberturaDoTanque(db, t.id, data);

      const ent = db.prepare(`
        SELECT COALESCE(SUM(litrosRecebidos), 0) AS l FROM posto_descargas
         WHERE tanqueId = ? AND dataHora BETWEEN ? AND ?
      `).get(t.id, ini, fim);

      const sai = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN a.tipo = 'venda'   THEN a.litros ELSE 0 END), 0) AS venda,
          COALESCE(SUM(CASE WHEN a.tipo = 'interno' THEN a.litros ELSE 0 END), 0) AS interno
          FROM posto_abastecimentos a
          JOIN posto_bicos bi ON bi.id = a.bicoId
         WHERE bi.tanqueId = ? AND a.dataHora BETWEEN ? AND ?
      `).get(t.id, ini, fim);

      // Aferição que voltou ao tanque é neutra no saldo; a que não voltou
      // (descartada) é saída de verdade e entra como consumo interno.
      const afer = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN a.retornouAoTanque = 1 THEN a.volumeMedidoMl ELSE 0 END), 0) AS voltou,
          COALESCE(SUM(CASE WHEN a.retornouAoTanque = 0 THEN a.volumeMedidoMl ELSE 0 END), 0) AS naoVoltou
          FROM posto_afericoes a
          JOIN posto_bicos bi ON bi.id = a.bicoId
         WHERE bi.tanqueId = ? AND a.dataHora BETWEEN ? AND ?
      `).get(t.id, ini, fim);

      const aferVoltouL = r3(afer.voltou / 1000);
      const aferPerdidaL = r3(afer.naoVoltou / 1000);

      // Medição de ABERTURA do próprio dia não é estoque final: ela retrata o
      // antes. Usá-la como fechamento inventava perda do tamanho de tudo o que
      // foi vendido depois.
      //
      // MAS a abertura do dia SEGUINTE é, materialmente, o fechamento deste —
      // é o mesmo combustível no mesmo tanque, sem nada no meio. Muito posto só
      // mede de manhã; sem aceitar isso, esse posto nunca fecharia um dia e o
      // livro acumularia estoque negativo dia após dia, com o operador sendo
      // empurrado para o "fechar assim mesmo".
      let med = db.prepare(`
        SELECT litrosFisico, dataHora, tipo FROM posto_medicoes
         WHERE tanqueId = ? AND data = ? AND tipo IN ('fechamento', 'avulsa')
         ORDER BY (tipo = 'fechamento') DESC, dataHora DESC, id DESC LIMIT 1
      `).get(t.id, data);
      let fisicoDeAmanha = false;
      if (!med) {
        med = db.prepare(`
          SELECT litrosFisico, dataHora, tipo FROM posto_medicoes
           WHERE tanqueId = ? AND data = ? AND tipo = 'abertura'
           ORDER BY dataHora ASC, id ASC LIMIT 1
        `).get(t.id, diaSeguinte(data));
        if (med) fisicoDeAmanha = true;
      }

      const saidasT = r3(sai.venda + sai.interno + aferPerdidaL);
      const contabil = r3(ab.litros + ent.l - saidasT);
      const fisico = med ? r3(med.litrosFisico) : null;
      const perda = fisico != null ? r3(fisico - contabil) : null;
      const baseT = saidasT > 0 ? saidasT : r3(ab.litros + ent.l);
      const perdaPct = perda != null && baseT > 0 ? r4((perda / baseT) * 100) : null;

      detalhe.push({
        tanqueId: t.id, tanqueCodigo: t.codigo,
        estoqueAberturaL: ab.litros, aberturaOrigem: ab.origem,
        aberturaComLacuna: !!ab.comLacuna,
        movimentoIgnoradoNaAbertura: ab.movimentoIgnorado || 0,
        fisicoVeioDaAberturaSeguinte: fisicoDeAmanha,
        // Primeira medição de um tanque sem história: o volume achado é saldo
        // inicial, não sobra. Tratar como perda marcaria todo posto novo como
        // fora da tolerância no dia 1, para sempre (reabrir e refechar dá o
        // mesmo número), poluindo a lista de pendências reais.
        inventarioInicial: ab.origem === 'sem-historico' && ent.l === 0 && saidasT === 0 && !!med,
        entradasL: r3(ent.l), saidasL: saidasT,
        estoqueContabilL: contabil, estoqueFisicoL: fisico,
        perdaGanhoL: perda, perdaGanhoPct: perdaPct,
        temMedicao: !!med,
      });

      abertura += ab.litros;
      entradas += ent.l;
      vendas += sai.venda;
      interno += sai.interno + aferPerdidaL;
      afericoes += aferVoltouL;
      if (fisico != null) fisicoTotal += fisico;
    }

    // O físico do PRODUTO só existe quando TODOS os seus tanques foram medidos.
    // Somar medição de um tanque contra o contábil de dois produz uma perda
    // fantasma do tamanho do tanque que ninguém mediu — e escritura isso no
    // livro da ANP. Faltando um, o produto fica sem físico e sem veredicto,
    // que é a mesma regra do dia em que ninguém mediu nada.
    const semMedicao = detalhe.filter(t => !t.temMedicao);
    const temFisico = detalhe.length > 0 && semMedicao.length === 0;

    const saidas = r3(vendas + interno);
    const contabil = r3(abertura + entradas - saidas);
    const fisico = temFisico ? r3(fisicoTotal) : null;
    const perda = fisico != null ? r3(fisico - contabil) : null;
    const base = saidas > 0 ? saidas : r3(abertura + entradas);
    const perdaPct = perda != null && base > 0 ? r4((perda / base) * 100) : null;

    // Sem medição não há veredicto: `dentroTolerancia` fica null, e não true.
    // Dizer "dentro da tolerância" quando ninguém mediu seria a pior saída
    // possível — é exatamente o dado que o fiscal cobra.
    //
    // Caso à parte: base ZERO com diferença real (tanque sem histórico que
    // aparece medido com 5.000 L). Não dá para dizer que 5.000 L cabem em 0,6%
    // de nada — antes isso saía com pct nulo e o dia fechava sem alerta, que é
    // o pior dos mundos. Sem base, diferença é sempre para investigar.
    // Inventário inicial não é perda nem sobra: é o saldo entrando no livro
    // pela primeira vez. Sem esta exceção, todo posto que estreia o módulo
    // nasce com o dia 1 marcado FORA e um "ganho" do tamanho do tanque.
    const inventarioInicial = detalhe.length > 0 && detalhe.every(t => t.inventarioInicial);

    let dentro;
    if (inventarioInicial) dentro = null;
    else if (perdaPct != null) dentro = Math.abs(perdaPct) <= tol ? 1 : 0;
    else if (fisico != null && perda != null && Math.abs(perda) > 0.001) dentro = 0;
    else dentro = null;

    // Produto que não se moveu no dia não trava o fechamento por falta de
    // medição: sem entrada, saída nem estoque de abertura, não há o que
    // conferir. A linha continua sendo escriturada — a ANP exige registro
    // diário mesmo em dia sem movimento.
    const houveMovimento = entradas > 0 || saidas > 0 || abertura > 0;

    const gravado = db.prepare('SELECT * FROM posto_lmc_dias WHERE data = ? AND combustivelId = ?').get(data, comb.id);

    linhas.push({
      data,
      combustivelId: comb.id,
      combustivelNome: comb.nome,
      combustivelCodigo: comb.codigo,
      cProdANP: comb.cProdANP,
      estoqueAberturaL: r3(abertura),
      entradasL: r3(entradas),
      vendasL: r3(vendas),
      afericoesL: r3(afericoes),
      consumoInternoL: r3(interno),
      estoqueContabilL: contabil,
      estoqueFisicoL: fisico,
      perdaGanhoL: perda,
      perdaGanhoPct: perdaPct,
      baseCalculoL: base,
      dentroTolerancia: dentro,
      toleranciaPct: tol,
      medicaoPendente: !temFisico && houveMovimento,
      semMovimento: !houveMovimento,
      inventarioInicial,
      // Perda declarada só quando há o que comparar: no inventário inicial o
      // número existe (físico − contábil), mas não significa perda.
      perdaGanhoEhSaldoInicial: inventarioInicial,
      tanquesSemMedicao: semMedicao.map(t => t.tanqueCodigo),
      // Abertura tirada de medição antiga com movimento no meio: o livro pulou
      // dias e a abertura não reflete o que aconteceu no intervalo.
      lacunaAbertura: detalhe.filter(t => t.aberturaComLacuna).map(t => t.tanqueCodigo),
      status: gravado ? gravado.status : 'aberto',
      tanques: detalhe,
    });
  }

  return { data, toleranciaPct: tol, linhas };
}

function registrarRotasPostoLmc(app, db, gateFlag) {

  // Prévia do dia: calcula na hora, não grava. É a tela de conciliação.
  app.get('/api/posto/lmc', gateFlag, (req, res) => {
    try {
      const data = String(req.query.data || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        return res.status(400).json({ success: false, error: 'data inválida (use YYYY-MM-DD)' });
      }
      res.json({ success: true, ...calcularDia(db, data) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fecha o dia: congela o cálculo. Exige medição de todos os tanques do
  // produto — fechar sem medir produziria um livro que só repete o contábil e
  // esconderia justamente a diferença que ele existe para revelar.
  app.post('/api/posto/lmc/fechar', gateFlag, (req, res) => {
    try {
      const data = String(req.body?.data || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        return res.status(400).json({ success: false, error: 'data inválida (use YYYY-MM-DD)' });
      }
      const calc = calcularDia(db, data);
      if (!calc.linhas.length) {
        return res.status(400).json({ success: false, error: 'nenhum combustível com tanque cadastrado' });
      }

      const jaFechado = calc.linhas.filter(l => l.status === 'fechado');
      if (jaFechado.length && !req.body?.reprocessar) {
        return res.status(400).json({
          success: false,
          error: `dia ${data} já fechado para: ${jaFechado.map(l => l.combustivelNome).join(', ')}`,
          sugestao: 'reabrir',
        });
      }

      const semMedicao = calc.linhas.filter(l => l.medicaoPendente);
      if (semMedicao.length && !req.body?.forcar) {
        return res.status(400).json({
          success: false,
          error: `sem medição de tanque em: ${semMedicao.map(l =>
            `${l.combustivelNome} (${l.tanquesSemMedicao.join(', ') || 'sem tanque medido'})`).join('; ')}`,
          detalhe: 'lance a medição do dia ou envie forcar=true para fechar assim mesmo',
          combustiveisSemMedicao: semMedicao.map(l => l.combustivelId),
        });
      }

      const fechadoEm = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      const usuario = req.user?.nome || req.user?.username || null;
      const foraTolerancia = [];

      const tx = db.transaction(() => {
        for (const l of calc.linhas) {
          db.prepare(`
            INSERT INTO posto_lmc_dias
              (data, combustivelId, estoqueAberturaL, entradasL, vendasL, afericoesL, consumoInternoL,
               estoqueContabilL, estoqueFisicoL, perdaGanhoL, perdaGanhoPct, dentroTolerancia,
               status, fechadoEm, fechadoPor, observacao)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fechado', ?, ?, ?)
            ON CONFLICT(data, combustivelId) DO UPDATE SET
              estoqueAberturaL = excluded.estoqueAberturaL,
              entradasL        = excluded.entradasL,
              vendasL          = excluded.vendasL,
              afericoesL       = excluded.afericoesL,
              consumoInternoL  = excluded.consumoInternoL,
              estoqueContabilL = excluded.estoqueContabilL,
              estoqueFisicoL   = excluded.estoqueFisicoL,
              perdaGanhoL      = excluded.perdaGanhoL,
              perdaGanhoPct    = excluded.perdaGanhoPct,
              dentroTolerancia = excluded.dentroTolerancia,
              status           = 'fechado',
              fechadoEm        = excluded.fechadoEm,
              fechadoPor       = excluded.fechadoPor,
              observacao       = COALESCE(excluded.observacao, posto_lmc_dias.observacao)
          `).run(
            data, l.combustivelId, l.estoqueAberturaL, l.entradasL, l.vendasL, l.afericoesL,
            l.consumoInternoL, l.estoqueContabilL, l.estoqueFisicoL, l.perdaGanhoL, l.perdaGanhoPct,
            l.dentroTolerancia, fechadoEm, usuario,
            req.body?.observacao ? String(req.body.observacao).trim() : null,
          );

          const dia = db.prepare('SELECT id FROM posto_lmc_dias WHERE data = ? AND combustivelId = ?')
            .get(data, l.combustivelId);

          for (const t of l.tanques) {
            db.prepare(`
              INSERT INTO posto_lmc_tanques
                (lmcDiaId, tanqueId, estoqueAberturaL, entradasL, saidasL, estoqueContabilL,
                 estoqueFisicoL, perdaGanhoL, perdaGanhoPct)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(lmcDiaId, tanqueId) DO UPDATE SET
                estoqueAberturaL = excluded.estoqueAberturaL,
                entradasL        = excluded.entradasL,
                saidasL          = excluded.saidasL,
                estoqueContabilL = excluded.estoqueContabilL,
                estoqueFisicoL   = excluded.estoqueFisicoL,
                perdaGanhoL      = excluded.perdaGanhoL,
                perdaGanhoPct    = excluded.perdaGanhoPct
            `).run(
              dia.id, t.tanqueId, t.estoqueAberturaL, t.entradasL, t.saidasL,
              t.estoqueContabilL, t.estoqueFisicoL, t.perdaGanhoL, t.perdaGanhoPct,
            );
          }

          if (l.dentroTolerancia === 0) {
            foraTolerancia.push({
              combustivel: l.combustivelNome,
              perdaGanhoL: l.perdaGanhoL,
              perdaGanhoPct: l.perdaGanhoPct,
              // Aponta o tanque de maior desvio: é por onde a investigação começa.
              tanqueSuspeito: (l.tanques || [])
                .filter(t => t.perdaGanhoL != null)
                .sort((a, b) => Math.abs(b.perdaGanhoL) - Math.abs(a.perdaGanhoL))[0] || null,
            });
          }
        }
      });
      tx();

      try { logAction(db, req, 'create', 'posto_lmc_fechamento', null, { data, foraTolerancia: foraTolerancia.length }); } catch (_) { /* */ }
      res.json({
        success: true,
        data,
        linhas: calc.linhas.length,
        foraTolerancia,
        // A ANP manda o próprio revendedor apurar a diferença acima de 0,6%.
        // O alerta aqui é o gatilho dessa apuração, não um bloqueio.
        alerta: foraTolerancia.length
          ? `${foraTolerancia.length} produto(s) fora da tolerância de ${calc.toleranciaPct}% — apure a diferença (Resolução ANP 884/2022)`
          : null,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/posto/lmc/reabrir', gateFlag, (req, res) => {
    try {
      const data = String(req.body?.data || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        return res.status(400).json({ success: false, error: 'data inválida (use YYYY-MM-DD)' });
      }
      // Reabrir um dia com dias fechados depois dele quebraria o encadeamento:
      // a abertura do dia seguinte veio do fechamento deste.
      const posterior = db.prepare(`
        SELECT COUNT(*) AS n FROM posto_lmc_dias WHERE data > ? AND status = 'fechado'
      `).get(data);
      if (posterior && posterior.n > 0 && !req.body?.forcar) {
        return res.status(400).json({
          success: false,
          error: `existem ${posterior.n} dia(s) fechado(s) depois de ${data} — reabra do mais recente para o mais antigo`,
        });
      }
      const alvo = req.body?.combustivelId
        ? db.prepare("UPDATE posto_lmc_dias SET status = 'aberto', fechadoEm = NULL WHERE data = ? AND combustivelId = ?")
            .run(data, req.body.combustivelId)
        : db.prepare("UPDATE posto_lmc_dias SET status = 'aberto', fechadoEm = NULL WHERE data = ?").run(data);
      try { logAction(db, req, 'update', 'posto_lmc_fechamento', null, { data, reaberto: alvo.changes }); } catch (_) { /* */ }
      res.json({ success: true, reabertos: alvo.changes });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // O livro propriamente dito: o que se imprime ou se entrega à fiscalização.
  // A ANP recomenda organizar por produto e o revendedor tem de guardar os
  // últimos 6 meses no estabelecimento.
  app.get('/api/posto/lmc/livro', gateFlag, (req, res) => {
    try {
      const de = String(req.query.de || '').trim();
      const ate = String(req.query.ate || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(de) || !/^\d{4}-\d{2}-\d{2}$/.test(ate)) {
        return res.status(400).json({ success: false, error: 'informe de/até no formato YYYY-MM-DD' });
      }
      // Intervalo invertido devolveria 200 com lista vazia — indistinguível de
      // um período realmente sem escrituração, num documento que é prova fiscal.
      if (de > ate) {
        return res.status(400).json({ success: false, error: `período invertido: ${de} é depois de ${ate}` });
      }
      const params = [de, ate];
      let filtro = '';
      if (req.query.combustivelId) { filtro = 'AND d.combustivelId = ?'; params.push(req.query.combustivelId); }
      const items = db.prepare(`
        SELECT d.*, c.nome AS combustivelNome, c.codigo AS combustivelCodigo, c.cProdANP
          FROM posto_lmc_dias d
          JOIN posto_combustiveis c ON c.id = d.combustivelId
         WHERE d.data BETWEEN ? AND ? ${filtro}
         ORDER BY c.nome ASC, d.data ASC
      `).all(...params);

      const totais = items.reduce((acc, l) => ({
        entradasL: r3(acc.entradasL + (l.entradasL || 0)),
        vendasL: r3(acc.vendasL + (l.vendasL || 0)),
        perdaGanhoL: r3(acc.perdaGanhoL + (l.perdaGanhoL || 0)),
        diasForaTolerancia: acc.diasForaTolerancia + (l.dentroTolerancia === 0 ? 1 : 0),
        diasSemMedicao: acc.diasSemMedicao + (l.estoqueFisicoL == null ? 1 : 0),
      }), { entradasL: 0, vendasL: 0, perdaGanhoL: 0, diasForaTolerancia: 0, diasSemMedicao: 0 });

      res.json({ success: true, de, ate, items, totais, toleranciaPct: toleranciaPct(db) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Painel: o que o gerente olha de manhã.
  app.get('/api/posto/lmc/pendencias', gateFlag, (req, res) => {
    try {
      // `dias` é janela de tempo, não quantidade de linhas. Mas janela que
      // ESCONDE pendência é troca ruim: uma quebra de tolerância de 45 dias
      // atrás continua sendo obrigação não apurada. Por isso o que fica fora da
      // janela é CONTADO e devolvido — some da lista, não do radar.
      const dias = Math.min(Math.max(Number(req.query.dias) || 90, 1), 730);
      const desde = new Date(Date.now() - 3 * 3600 * 1000 - dias * 86400 * 1000)
        .toISOString().slice(0, 10);
      const foraTolerancia = db.prepare(`
        SELECT d.data, d.perdaGanhoL, d.perdaGanhoPct, c.nome AS combustivelNome
          FROM posto_lmc_dias d
          JOIN posto_combustiveis c ON c.id = d.combustivelId
         WHERE d.dentroTolerancia = 0 AND d.data >= ?
         ORDER BY d.data DESC LIMIT 500
      `).all(desde);
      const anteriores = db.prepare(
        'SELECT COUNT(*) AS n FROM posto_lmc_dias WHERE dentroTolerancia = 0 AND data < ?').get(desde);
      // Dia fechado à força (sem medição) não entra em `dentroTolerancia = 0`,
      // porque não tem veredicto — mas é exatamente a pendência que some.
      // Dia sem movimento nenhum fecha sem medição por decisão de projeto (não
      // há o que conferir) — listá-lo como pendência criaria uma fila infinita
      // de falso positivo para todo produto parado.
      const semMedicaoFechados = db.prepare(`
        SELECT d.data, c.nome AS combustivelNome
          FROM posto_lmc_dias d
          JOIN posto_combustiveis c ON c.id = d.combustivelId
         WHERE d.status = 'fechado' AND d.estoqueFisicoL IS NULL AND d.data >= ?
           AND (d.entradasL > 0 OR d.vendasL > 0 OR d.consumoInternoL > 0 OR d.estoqueAberturaL > 0)
         ORDER BY d.data DESC LIMIT 500
      `).all(desde);
      const turnosAbertos = db.prepare("SELECT COUNT(*) AS n FROM posto_turnos WHERE status = 'aberto'").get();
      const tanquesBaixos = db.prepare(`
        SELECT t.codigo, t.estoqueMinimoLitros,
               (SELECT m.litrosFisico FROM posto_medicoes m WHERE m.tanqueId = t.id
                 ORDER BY m.dataHora DESC LIMIT 1) AS ultimoL
          FROM posto_tanques t
         WHERE t.ativo = 1 AND t.estoqueMinimoLitros > 0
      `).all().filter(t => t.ultimoL != null && t.ultimoL < t.estoqueMinimoLitros);

      res.json({
        success: true,
        foraTolerancia,
        desde,
        foraToleranciaAnteriores: anteriores ? anteriores.n : 0,
        diasFechadosSemMedicao: semMedicaoFechados,
        turnosAbertos: turnosAbertos ? turnosAbertos.n : 0,
        tanquesAbaixoDoMinimo: tanquesBaixos,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasPostoLmc, calcularDia };
