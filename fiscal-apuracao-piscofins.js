/**
 * fiscal-apuracao-piscofins.js — Apuração de PIS e COFINS.
 *
 * Diferença estrutural em relação ao ICMS: aqui existem DOIS REGIMES de apuração,
 * e o que o livro faz muda completamente entre eles.
 *
 *   CUMULATIVO (típico do Lucro Presumido)
 *     0,65% de PIS e 3% de COFINS sobre a receita. NÃO HÁ CRÉDITO. O que a
 *     empresa pagou de PIS/COFINS na compra é custo, não se recupera.
 *
 *   NÃO-CUMULATIVO (típico do Lucro Real)
 *     1,65% e 7,6%, com direito a crédito sobre aquisições — e é aí que a
 *     apuração vira um confronto de verdade.
 *
 * O regime vem de `fornecedor.regimeApuracaoPISCOFINS`, campo que já existia e
 * já era usado pelo cálculo de custo de aquisição das entradas.
 *
 * PIS e COFINS são apurados JUNTOS aqui, numa competência só: incidem sobre a
 * mesma base, nas mesmas operações, e separá-los em duas telas duplicaria o
 * trabalho de quem confere. Os saldos, porém, são independentes — cada tributo
 * tem o seu crédito a transportar.
 *
 * O direito ao crédito vem de `cfops.geraCreditoPisCofins`. Não é o mesmo da
 * flag do ICMS: uso e consumo não credita em nenhum dos dois, mas mercadoria
 * com ICMS-ST pode creditar PIS/COFINS (se não for monofásica). Por isso a
 * coluna é própria, e nasce como cópia da do ICMS só para ter um ponto de
 * partida — precisa de revisão do contador.
 */

const CUMULATIVO = 'cumulativo';
const NAO_CUMULATIVO = 'nao_cumulativo';

const FILTRO_SAIDA_VALIDA = `f.statusSefaz = 'autorizada' AND COALESCE(f.excluida, 0) = 0`;

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* já existe */ } }
function r2(n) { return Number((Number(n) || 0).toFixed(2)); }

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_apuracao_piscofins (
      competencia TEXT PRIMARY KEY,
      status TEXT DEFAULT 'aberta',
      regime TEXT,                            -- 'cumulativo' | 'nao_cumulativo'

      pisCreditoAnterior REAL DEFAULT 0,
      pisDebitos REAL DEFAULT 0,
      pisCreditos REAL DEFAULT 0,
      pisOutrosDebitos REAL DEFAULT 0,
      pisOutrosCreditos REAL DEFAULT 0,
      pisSaldo REAL DEFAULT 0,
      pisRecolher REAL DEFAULT 0,
      pisCreditoTransportar REAL DEFAULT 0,

      cofinsCreditoAnterior REAL DEFAULT 0,
      cofinsDebitos REAL DEFAULT 0,
      cofinsCreditos REAL DEFAULT 0,
      cofinsOutrosDebitos REAL DEFAULT 0,
      cofinsOutrosCreditos REAL DEFAULT 0,
      cofinsSaldo REAL DEFAULT 0,
      cofinsRecolher REAL DEFAULT 0,
      cofinsCreditoTransportar REAL DEFAULT 0,

      receitaBruta REAL DEFAULT 0,
      dataFechamento TEXT,
      usuario TEXT,
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fiscal_apuracao_piscofins_ajustes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT NOT NULL,
      tributo TEXT NOT NULL,                  -- 'pis' | 'cofins' | 'ambos'
      tipo TEXT NOT NULL,                     -- ver TIPOS_AJUSTE
      codigoAjuste TEXT,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_apur_pc_ajustes_comp
      ON fiscal_apuracao_piscofins_ajustes(competencia);
  `);

  // Direito a crédito de PIS/COFINS por CFOP de entrada. Coluna própria: as
  // regras não coincidem com as do ICMS (ver cabeçalho). O seed copia a flag do
  // ICMS apenas como PONTO DE PARTIDA — a revisão é do contador, e o livro
  // mostra separadamente o que ficou sem direito para que a conferência seja
  // possível.
  const nova = !db.prepare("SELECT COUNT(*) c FROM pragma_table_info('cfops') WHERE name = 'geraCreditoPisCofins'").get().c;
  alterSafe(db, 'ALTER TABLE cfops ADD COLUMN geraCreditoPisCofins INTEGER');
  if (nova) {
    try {
      db.prepare('UPDATE cfops SET geraCreditoPisCofins = COALESCE(geraCreditoIcms, 0) WHERE geraCreditoPisCofins IS NULL').run();
    } catch { /* tenant sem a coluna do ICMS */ }
  }
}

const TIPOS_AJUSTE = {
  outros_debitos:  { rotulo: 'Outros débitos',  sinal: +1 },
  outros_creditos: { rotulo: 'Outros créditos', sinal: -1 },
};

const ALIQUOTAS_REFERENCIA = {
  [CUMULATIVO]:     { pis: 0.65, cofins: 3.00 },
  [NAO_CUMULATIVO]: { pis: 1.65, cofins: 7.60 },
};

function validarCompetencia(c) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || '')); }

function limitesDe(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return { inicio: `${competencia}-01`, fim: `${competencia}-${String(ultimoDia).padStart(2, '0')}` };
}

function competenciaAnterior(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  return mes === 1 ? `${ano - 1}-12` : `${ano}-${String(mes - 1).padStart(2, '0')}`;
}

function regimeDe(db) {
  const f = db.prepare('SELECT regimeApuracaoPISCOFINS FROM fornecedor WHERE id = 1').get();
  const r = f && f.regimeApuracaoPISCOFINS;
  return r === NAO_CUMULATIVO ? NAO_CUMULATIVO : (r === CUMULATIVO ? CUMULATIVO : null);
}

// ─── Fontes ──────────────────────────────────────────────────────────────────

function debitosDe(db, competencia) {
  const { inicio, fim } = limitesDe(competencia);
  return db.prepare(`
    SELECT f.id AS faturaId, f.numero, f.numeroNFe, f.dataEmissao,
           p.razaoSocial AS destinatario,
           COALESCE(SUM(fi.valorTotal), 0) AS receita,
           COALESCE(SUM(fi.vPis), 0) AS vPis,
           COALESCE(SUM(fi.vCofins), 0) AS vCofins,
           GROUP_CONCAT(DISTINCT fi.cstPis) AS cstPis
      FROM faturas f
      JOIN fatura_itens fi ON fi.faturaId = f.id
      LEFT JOIN pessoas p ON p.id = f.clienteId
     WHERE ${FILTRO_SAIDA_VALIDA}
       AND f.dataEmissao BETWEEN ? AND ?
     GROUP BY f.id
     ORDER BY f.dataEmissao, f.id`).all(inicio, fim);
}

function creditosDe(db, competencia) {
  const { inicio, fim } = limitesDe(competencia);
  return db.prepare(`
    SELECT e.id AS entradaId, e.numero, e.dataEmissao,
           e.emitenteRazaoSocial AS fornecedor,
           COALESCE(SUM(CASE WHEN c.geraCreditoPisCofins = 1 THEN ei.valorPis ELSE 0 END), 0) AS vPis,
           COALESCE(SUM(CASE WHEN c.geraCreditoPisCofins = 1 THEN ei.valorCofins ELSE 0 END), 0) AS vCofins,
           COALESCE(SUM(CASE WHEN c.geraCreditoPisCofins = 1 THEN 0 ELSE ei.valorPis END), 0) AS vPisSemCredito,
           COALESCE(SUM(CASE WHEN c.geraCreditoPisCofins = 1 THEN 0 ELSE ei.valorCofins END), 0) AS vCofinsSemCredito,
           GROUP_CONCAT(DISTINCT ei.cfop) AS cfops
      FROM nfe_entrada e
      JOIN nfe_entrada_itens ei ON ei.nfeId = e.id
      LEFT JOIN cfops c ON c.codigo = ei.cfop
     WHERE COALESCE(e.excluida, 0) = 0
       AND e.dataEmissao BETWEEN ? AND ?
     GROUP BY e.id
     HAVING vPis > 0 OR vCofins > 0 OR vPisSemCredito > 0 OR vCofinsSemCredito > 0
     ORDER BY e.dataEmissao, e.id`).all(inicio, fim);
}

function ajustesDe(db, competencia) {
  return db.prepare(
    `SELECT * FROM fiscal_apuracao_piscofins_ajustes WHERE competencia = ? ORDER BY tributo, tipo, id`
  ).all(competencia);
}

function temMovimento(db, competencia) {
  if (!validarCompetencia(competencia)) return false;
  const { inicio, fim } = limitesDe(competencia);
  const s = db.prepare(`SELECT COUNT(*) c FROM faturas f
    WHERE ${FILTRO_SAIDA_VALIDA} AND f.dataEmissao BETWEEN ? AND ?`).get(inicio, fim).c;
  if (s) return true;
  const e = db.prepare(`SELECT COUNT(*) c FROM nfe_entrada
    WHERE COALESCE(excluida,0) = 0 AND dataEmissao BETWEEN ? AND ?`).get(inicio, fim).c;
  if (e) return true;
  return db.prepare('SELECT COUNT(*) c FROM fiscal_apuracao_piscofins_ajustes WHERE competencia = ?')
    .get(competencia).c > 0;
}

function creditoAnteriorDe(db, competencia) {
  const ant = db.prepare(`SELECT pisCreditoTransportar, cofinsCreditoTransportar, status
    FROM fiscal_apuracao_piscofins WHERE competencia = ?`).get(competenciaAnterior(competencia));
  if (!ant || ant.status !== 'fechada') return { pis: 0, cofins: 0 };
  return { pis: r2(ant.pisCreditoTransportar), cofins: r2(ant.cofinsCreditoTransportar) };
}

// ─── Cálculo ─────────────────────────────────────────────────────────────────

function calcularApuracao(db, competencia) {
  if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');

  const regime = regimeDe(db);
  if (!regime) {
    throw new Error('Regime de apuração de PIS/COFINS não definido. ' +
      'Informe em Minha Empresa se a apuração é cumulativa (Lucro Presumido) ou ' +
      'não-cumulativa (Lucro Real) — a conta muda inteiramente entre as duas.');
  }
  const naoCumulativo = regime === NAO_CUMULATIVO;

  const debitos = debitosDe(db, competencia);
  const creditosBrutos = creditosDe(db, competencia);
  const ajustes = ajustesDe(db, competencia);

  const receitaBruta = r2(debitos.reduce((s, d) => s + Number(d.receita || 0), 0));
  const pisDebitos = r2(debitos.reduce((s, d) => s + Number(d.vPis || 0), 0));
  const cofinsDebitos = r2(debitos.reduce((s, d) => s + Number(d.vCofins || 0), 0));

  // No regime CUMULATIVO não há crédito nenhum — o PIS/COFINS pago na compra é
  // custo. As entradas continuam listadas (para conferência), mas com valor zero
  // do lado do crédito e o total inteiro em "sem direito".
  const creditos = creditosBrutos.map(c => naoCumulativo ? c : {
    ...c,
    vPisSemCredito: r2(Number(c.vPis || 0) + Number(c.vPisSemCredito || 0)),
    vCofinsSemCredito: r2(Number(c.vCofins || 0) + Number(c.vCofinsSemCredito || 0)),
    vPis: 0, vCofins: 0,
  });

  const pisCreditos = r2(creditos.reduce((s, c) => s + Number(c.vPis || 0), 0));
  const cofinsCreditos = r2(creditos.reduce((s, c) => s + Number(c.vCofins || 0), 0));
  const pisSemCredito = r2(creditos.reduce((s, c) => s + Number(c.vPisSemCredito || 0), 0));
  const cofinsSemCredito = r2(creditos.reduce((s, c) => s + Number(c.vCofinsSemCredito || 0), 0));

  const somaAjuste = (tributo, tipo) => r2(ajustes
    .filter(a => (a.tributo === tributo || a.tributo === 'ambos') && a.tipo === tipo)
    .reduce((s, a) => s + Number(a.valor || 0), 0));

  const anterior = creditoAnteriorDe(db, competencia);

  function apurar(prefixo, vDebitos, vCreditos, creditoAnterior) {
    const outrosDebitos = somaAjuste(prefixo, 'outros_debitos');
    const outrosCreditos = somaAjuste(prefixo, 'outros_creditos');
    const totalDebitos = r2(vDebitos + outrosDebitos);
    const totalCreditos = r2(vCreditos + outrosCreditos + creditoAnterior);
    const saldo = r2(totalDebitos - totalCreditos);
    return {
      creditoAnterior, vDebitos, vCreditos, outrosDebitos, outrosCreditos,
      totalDebitos, totalCreditos, saldo,
      vRecolher: saldo > 0 ? saldo : 0,
      creditoTransportar: saldo < 0 ? r2(-saldo) : 0,
    };
  }

  const pis = apurar('pis', pisDebitos, pisCreditos, anterior.pis);
  const cofins = apurar('cofins', cofinsDebitos, cofinsCreditos, anterior.cofins);

  const aliq = ALIQUOTAS_REFERENCIA[regime];
  const memoria = [
    `REGIME: ${naoCumulativo ? 'NAO-CUMULATIVO' : 'CUMULATIVO'} ` +
      `(referencia: PIS ${aliq.pis}% / COFINS ${aliq.cofins}%)`,
    `RECEITA BRUTA DO PERIODO: ${receitaBruta.toFixed(2)} (${debitos.length} documento(s))`,
    '',
    `PIS    DEBITOS: ${pis.vDebitos.toFixed(2)} + OUTROS ${pis.outrosDebitos.toFixed(2)} = ${pis.totalDebitos.toFixed(2)}`,
    `PIS    CREDITOS: ${pis.vCreditos.toFixed(2)} + OUTROS ${pis.outrosCreditos.toFixed(2)} + ANTERIOR ${pis.creditoAnterior.toFixed(2)} = ${pis.totalCreditos.toFixed(2)}`,
    `PIS    SALDO: ${pis.saldo.toFixed(2)}`,
    '',
    `COFINS DEBITOS: ${cofins.vDebitos.toFixed(2)} + OUTROS ${cofins.outrosDebitos.toFixed(2)} = ${cofins.totalDebitos.toFixed(2)}`,
    `COFINS CREDITOS: ${cofins.vCreditos.toFixed(2)} + OUTROS ${cofins.outrosCreditos.toFixed(2)} + ANTERIOR ${cofins.creditoAnterior.toFixed(2)} = ${cofins.totalCreditos.toFixed(2)}`,
    `COFINS SALDO: ${cofins.saldo.toFixed(2)}`,
    '',
    naoCumulativo
      ? 'CREDITO SOBRE AQUISICOES: permitido pelo regime nao-cumulativo'
      : 'SEM CREDITO: no regime cumulativo o PIS/COFINS da compra e custo, nao se recupera',
  ].join('\n');

  const gravada = db.prepare('SELECT * FROM fiscal_apuracao_piscofins WHERE competencia = ?').get(competencia);

  return {
    competencia, regime, naoCumulativo,
    status: gravada ? gravada.status : 'aberta',
    dataFechamento: gravada ? gravada.dataFechamento : null,
    regimeNoFechamento: gravada ? gravada.regime : null,
    aliquotasReferencia: aliq,
    receitaBruta,
    pis, cofins,
    pisSemCredito, cofinsSemCredito,
    contagem: { saidas: debitos.length, entradas: creditos.length, ajustes: ajustes.length },
    memoria,
    divergenciaAposFechamento: (gravada && gravada.status === 'fechada'
      && (r2(gravada.pisSaldo) !== pis.saldo || r2(gravada.cofinsSaldo) !== cofins.saldo))
      ? { pisGravado: r2(gravada.pisSaldo), pisRecalculado: pis.saldo,
          cofinsGravado: r2(gravada.cofinsSaldo), cofinsRecalculado: cofins.saldo }
      : null,
    // Trocar de regime no meio do exercício muda a conta de meses já fechados.
    regimeMudouAposFechamento: (gravada && gravada.regime && gravada.regime !== regime)
      ? { fechadoComo: gravada.regime, hoje: regime } : null,
  };
}

function salvarApuracao(db, competencia, extra = {}) {
  const a = calcularApuracao(db, competencia);
  db.prepare(`
    INSERT INTO fiscal_apuracao_piscofins
      (competencia, status, regime, receitaBruta,
       pisCreditoAnterior, pisDebitos, pisCreditos, pisOutrosDebitos, pisOutrosCreditos,
       pisSaldo, pisRecolher, pisCreditoTransportar,
       cofinsCreditoAnterior, cofinsDebitos, cofinsCreditos, cofinsOutrosDebitos, cofinsOutrosCreditos,
       cofinsSaldo, cofinsRecolher, cofinsCreditoTransportar, observacao, dataAtualizacao)
    VALUES (@competencia, @status, @regime, @receitaBruta,
       @pisCreditoAnterior, @pisDebitos, @pisCreditos, @pisOutrosDebitos, @pisOutrosCreditos,
       @pisSaldo, @pisRecolher, @pisCreditoTransportar,
       @cofinsCreditoAnterior, @cofinsDebitos, @cofinsCreditos, @cofinsOutrosDebitos, @cofinsOutrosCreditos,
       @cofinsSaldo, @cofinsRecolher, @cofinsCreditoTransportar, @observacao, CURRENT_TIMESTAMP)
    ON CONFLICT(competencia) DO UPDATE SET
       regime = excluded.regime, receitaBruta = excluded.receitaBruta,
       pisCreditoAnterior = excluded.pisCreditoAnterior, pisDebitos = excluded.pisDebitos,
       pisCreditos = excluded.pisCreditos, pisOutrosDebitos = excluded.pisOutrosDebitos,
       pisOutrosCreditos = excluded.pisOutrosCreditos, pisSaldo = excluded.pisSaldo,
       pisRecolher = excluded.pisRecolher, pisCreditoTransportar = excluded.pisCreditoTransportar,
       cofinsCreditoAnterior = excluded.cofinsCreditoAnterior, cofinsDebitos = excluded.cofinsDebitos,
       cofinsCreditos = excluded.cofinsCreditos, cofinsOutrosDebitos = excluded.cofinsOutrosDebitos,
       cofinsOutrosCreditos = excluded.cofinsOutrosCreditos, cofinsSaldo = excluded.cofinsSaldo,
       cofinsRecolher = excluded.cofinsRecolher, cofinsCreditoTransportar = excluded.cofinsCreditoTransportar,
       observacao = COALESCE(excluded.observacao, fiscal_apuracao_piscofins.observacao),
       dataAtualizacao = CURRENT_TIMESTAMP
  `).run({
    competencia: a.competencia, status: a.status, regime: a.regime, receitaBruta: a.receitaBruta,
    pisCreditoAnterior: a.pis.creditoAnterior, pisDebitos: a.pis.vDebitos, pisCreditos: a.pis.vCreditos,
    pisOutrosDebitos: a.pis.outrosDebitos, pisOutrosCreditos: a.pis.outrosCreditos,
    pisSaldo: a.pis.saldo, pisRecolher: a.pis.vRecolher, pisCreditoTransportar: a.pis.creditoTransportar,
    cofinsCreditoAnterior: a.cofins.creditoAnterior, cofinsDebitos: a.cofins.vDebitos,
    cofinsCreditos: a.cofins.vCreditos, cofinsOutrosDebitos: a.cofins.outrosDebitos,
    cofinsOutrosCreditos: a.cofins.outrosCreditos, cofinsSaldo: a.cofins.saldo,
    cofinsRecolher: a.cofins.vRecolher, cofinsCreditoTransportar: a.cofins.creditoTransportar,
    observacao: extra.observacao || null,
  });
  return calcularApuracao(db, competencia);
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/fiscal/apuracao-piscofins/:competencia', (req, res) => {
    try {
      res.json({ success: true, apuracao: calcularApuracao(db, req.params.competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/fiscal/apuracao-piscofins/:competencia/detalhe', (req, res) => {
    try {
      const competencia = req.params.competencia;
      if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');
      const a = calcularApuracao(db, competencia);
      res.json({
        success: true, competencia, regime: a.regime,
        debitos: debitosDe(db, competencia),
        creditos: a.naoCumulativo ? creditosDe(db, competencia) : creditosDe(db, competencia).map(c => ({
          ...c, vPisSemCredito: r2(c.vPis + c.vPisSemCredito),
          vCofinsSemCredito: r2(c.vCofins + c.vCofinsSemCredito), vPis: 0, vCofins: 0,
        })),
        ajustes: ajustesDe(db, competencia),
        tiposAjuste: TIPOS_AJUSTE,
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/fiscal/apuracao-piscofins', (req, res) => {
    try {
      res.json({ success: true, apuracoes: db.prepare(
        'SELECT * FROM fiscal_apuracao_piscofins ORDER BY competencia DESC LIMIT ?'
      ).all(Number(req.query.limit) || 24) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-piscofins/:competencia/ajustes', (req, res) => {
    try {
      const competencia = req.params.competencia;
      if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');
      const ap = db.prepare('SELECT status FROM fiscal_apuracao_piscofins WHERE competencia = ?').get(competencia);
      if (ap && ap.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência fechada — reabra antes' });
      }
      const b = req.body || {};
      if (!TIPOS_AJUSTE[b.tipo]) {
        return res.status(400).json({ success: false,
          error: `Tipo inválido. Use: ${Object.keys(TIPOS_AJUSTE).join(', ')}` });
      }
      if (!['pis', 'cofins', 'ambos'].includes(b.tributo)) {
        return res.status(400).json({ success: false, error: 'Tributo deve ser pis, cofins ou ambos' });
      }
      if (!b.descricao || !String(b.descricao).trim()) {
        return res.status(400).json({ success: false, error: 'Descrição é obrigatória' });
      }
      const valor = Number(b.valor);
      if (!Number.isFinite(valor) || valor <= 0) {
        return res.status(400).json({ success: false,
          error: 'Valor deve ser maior que zero — o sinal vem do tipo do ajuste' });
      }
      // Crédito no regime cumulativo não existe: aceitar seria produzir número
      // que o fisco não reconhece.
      const regime = regimeDe(db);
      if (regime === CUMULATIVO && b.tipo === 'outros_creditos') {
        return res.status(400).json({ success: false,
          error: 'Regime cumulativo não admite crédito de PIS/COFINS' });
      }
      const r = db.prepare(`INSERT INTO fiscal_apuracao_piscofins_ajustes
        (competencia, tributo, tipo, codigoAjuste, descricao, valor) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(competencia, b.tributo, b.tipo, b.codigoAjuste || null, String(b.descricao).trim(), r2(valor));
      res.json({ success: true, id: r.lastInsertRowid, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-piscofins/ajustes/:id/excluir', (req, res) => {
    try {
      const aj = db.prepare('SELECT * FROM fiscal_apuracao_piscofins_ajustes WHERE id = ?').get(Number(req.params.id));
      if (!aj) return res.status(404).json({ success: false, error: 'Ajuste não encontrado' });
      const ap = db.prepare('SELECT status FROM fiscal_apuracao_piscofins WHERE competencia = ?').get(aj.competencia);
      if (ap && ap.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência fechada — reabra antes' });
      }
      db.prepare('DELETE FROM fiscal_apuracao_piscofins_ajustes WHERE id = ?').run(aj.id);
      res.json({ success: true, apuracao: calcularApuracao(db, aj.competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-piscofins/:competencia/fechar', (req, res) => {
    try {
      const competencia = req.params.competencia;
      const atual = db.prepare('SELECT status FROM fiscal_apuracao_piscofins WHERE competencia = ?').get(competencia);
      if (atual && atual.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência já está fechada' });
      }
      const ant = competenciaAnterior(competencia);
      const antRow = db.prepare('SELECT status FROM fiscal_apuracao_piscofins WHERE competencia = ?').get(ant);
      if (!(antRow && antRow.status === 'fechada') && temMovimento(db, ant)) {
        return res.status(400).json({ success: false,
          error: `A competência ${ant} está aberta e tem movimento — feche-a antes, ` +
                 'senão o crédito dela não é transportado' });
      }
      salvarApuracao(db, competencia, { observacao: req.body && req.body.observacao });
      db.prepare(`UPDATE fiscal_apuracao_piscofins
        SET status = 'fechada', dataFechamento = CURRENT_TIMESTAMP, usuario = ?
        WHERE competencia = ?`).run((req.user && req.user.username) || null, competencia);
      res.json({ success: true, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-piscofins/:competencia/reabrir', (req, res) => {
    try {
      const competencia = req.params.competencia;
      const atual = db.prepare('SELECT status FROM fiscal_apuracao_piscofins WHERE competencia = ?').get(competencia);
      if (!atual || atual.status !== 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência não está fechada' });
      }
      const seguintes = db.prepare(`SELECT competencia FROM fiscal_apuracao_piscofins
        WHERE competencia > ? AND status = 'fechada' ORDER BY competencia`).all(competencia);
      if (seguintes.length) {
        return res.status(400).json({ success: false,
          error: `Existem competências posteriores fechadas (${seguintes.map(s => s.competencia).join(', ')}). ` +
                 'Reabra da mais recente para a mais antiga.' });
      }
      db.prepare(`UPDATE fiscal_apuracao_piscofins SET status = 'aberta', dataFechamento = NULL,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE competencia = ?`).run(competencia);
      res.json({ success: true, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  console.log('[fiscal-apuracao-piscofins] Rotas registradas');
}

module.exports = {
  registrarRotasFiscalApuracaoPisCofins: registrarRotas,
  calcularApuracao, salvarApuracao, debitosDe, creditosDe, regimeDe, temMovimento,
  TIPOS_AJUSTE, ALIQUOTAS_REFERENCIA, CUMULATIVO, NAO_CUMULATIVO, migrar,
};
