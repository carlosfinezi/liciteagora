/**
 * fiscal-apuracao-ipi.js — Apuração do IPI.
 *
 * Só existe para CONTRIBUINTE DO IPI: indústria e equiparado a industrial.
 * Comércio puro não apura IPI — o imposto que vem na nota do fornecedor é custo,
 * e é assim que o cálculo de custo de aquisição já o trata
 * (`nfe-entrada-routes.js`, via `fornecedor.contribuinteIPI`).
 *
 * A diferença que separa este livro dos outros dois está no CRÉDITO. No ICMS,
 * comprar para revender dá crédito. No IPI, NÃO:
 *
 *   1101 / 2101  compra para INDUSTRIALIZAÇÃO   → credita (é insumo)
 *   1102 / 2102  compra para COMERCIALIZAÇÃO    → NÃO credita (é revenda)
 *   1556 / 2556  uso e consumo                  → NÃO credita
 *
 * Creditam-se matéria-prima, produto intermediário e material de embalagem
 * empregados na industrialização. Por isso `cfops.geraCreditoIpi` é coluna
 * própria e o seed NÃO copia a do ICMS — copiaria justamente o caso errado.
 *
 * Estrutura de competência, ajustes, fechamento e transporte de saldo é a mesma
 * dos livros de ICMS e PIS/COFINS, de propósito: quem aprendeu a fechar um mês
 * numa tela fecha nas três.
 */

const FILTRO_SAIDA_VALIDA = `f.statusSefaz = 'autorizada' AND COALESCE(f.excluida, 0) = 0`;

// CFOPs de entrada que dão direito a crédito de IPI: só industrialização.
const CFOPS_CREDITO_IPI = ['1101', '2101', '3101', '1111', '2111', '1116', '2116',
  '1120', '2120', '1122', '2122', '1126', '2126', '1128', '2128'];

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* já existe */ } }
function r2(n) { return Number((Number(n) || 0).toFixed(2)); }

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_apuracao_ipi (
      competencia TEXT PRIMARY KEY,
      status TEXT DEFAULT 'aberta',

      saldoCredorAnterior REAL DEFAULT 0,
      vDebitos REAL DEFAULT 0,
      vCreditos REAL DEFAULT 0,
      vOutrosDebitos REAL DEFAULT 0,
      vOutrosCreditos REAL DEFAULT 0,
      vEstornoCreditos REAL DEFAULT 0,
      vEstornoDebitos REAL DEFAULT 0,

      saldoApurado REAL DEFAULT 0,
      vRecolher REAL DEFAULT 0,
      saldoCredorTransportar REAL DEFAULT 0,

      dataFechamento TEXT,
      usuario TEXT,
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS fiscal_apuracao_ipi_ajustes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT NOT NULL,
      tipo TEXT NOT NULL,
      codigoAjuste TEXT,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_apur_ipi_ajustes_comp
      ON fiscal_apuracao_ipi_ajustes(competencia);
  `);

  // Direito a crédito de IPI por CFOP. Diferente do ICMS e do PIS/COFINS, o
  // seed é explícito — copiar a flag do ICMS marcaria "compra para revenda"
  // como creditável, que é exatamente o erro clássico do IPI.
  const nova = !db.prepare(
    "SELECT COUNT(*) c FROM pragma_table_info('cfops') WHERE name = 'geraCreditoIpi'").get().c;
  alterSafe(db, 'ALTER TABLE cfops ADD COLUMN geraCreditoIpi INTEGER');
  if (nova) {
    try {
      db.prepare('UPDATE cfops SET geraCreditoIpi = 0 WHERE geraCreditoIpi IS NULL').run();
      const ins = db.prepare('UPDATE cfops SET geraCreditoIpi = 1 WHERE codigo = ?');
      db.transaction(() => { for (const c of CFOPS_CREDITO_IPI) ins.run(c); })();
    } catch { /* tenant sem tabela de cfops ainda */ }
  }
}

const TIPOS_AJUSTE = {
  outros_debitos:  { rotulo: 'Outros débitos',      sinal: +1 },
  estorno_credito: { rotulo: 'Estorno de créditos', sinal: +1 },
  outros_creditos: { rotulo: 'Outros créditos',     sinal: -1 },
  estorno_debito:  { rotulo: 'Estorno de débitos',  sinal: -1 },
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

function ehContribuinteIpi(db) {
  const f = db.prepare('SELECT contribuinteIPI FROM fornecedor WHERE id = 1').get();
  return !!(f && Number(f.contribuinteIPI) === 1);
}

// ─── Fontes ──────────────────────────────────────────────────────────────────

function debitosDe(db, competencia) {
  const { inicio, fim } = limitesDe(competencia);
  return db.prepare(`
    SELECT f.id AS faturaId, f.numero, f.numeroNFe, f.dataEmissao,
           p.razaoSocial AS destinatario,
           COALESCE(SUM(fi.valorTotal), 0) AS baseProdutos,
           COALESCE(SUM(fi.vIpi), 0) AS vIpi,
           GROUP_CONCAT(DISTINCT fi.cstIpi) AS cstIpi
      FROM faturas f
      JOIN fatura_itens fi ON fi.faturaId = f.id
      LEFT JOIN pessoas p ON p.id = f.clienteId
     WHERE ${FILTRO_SAIDA_VALIDA}
       AND f.dataEmissao BETWEEN ? AND ?
     GROUP BY f.id
     HAVING vIpi > 0
     ORDER BY f.dataEmissao, f.id`).all(inicio, fim);
}

function creditosDe(db, competencia) {
  const { inicio, fim } = limitesDe(competencia);
  return db.prepare(`
    SELECT e.id AS entradaId, e.numero, e.dataEmissao,
           e.emitenteRazaoSocial AS fornecedor,
           COALESCE(SUM(CASE WHEN c.geraCreditoIpi = 1 THEN ei.valorIpi ELSE 0 END), 0) AS vIpi,
           COALESCE(SUM(CASE WHEN c.geraCreditoIpi = 1 THEN 0 ELSE ei.valorIpi END), 0) AS vIpiSemCredito,
           GROUP_CONCAT(DISTINCT ei.cfop) AS cfops
      FROM nfe_entrada e
      JOIN nfe_entrada_itens ei ON ei.nfeId = e.id
      LEFT JOIN cfops c ON c.codigo = ei.cfop
     WHERE COALESCE(e.excluida, 0) = 0
       AND e.dataEmissao BETWEEN ? AND ?
     GROUP BY e.id
     HAVING vIpi > 0 OR vIpiSemCredito > 0
     ORDER BY e.dataEmissao, e.id`).all(inicio, fim);
}

function ajustesDe(db, competencia) {
  return db.prepare(
    `SELECT * FROM fiscal_apuracao_ipi_ajustes WHERE competencia = ? ORDER BY tipo, id`).all(competencia);
}

function temMovimento(db, competencia) {
  if (!validarCompetencia(competencia)) return false;
  const { inicio, fim } = limitesDe(competencia);
  if (debitosDe(db, competencia).length) return true;
  const e = db.prepare(`SELECT COUNT(*) c FROM nfe_entrada
    WHERE COALESCE(excluida,0) = 0 AND dataEmissao BETWEEN ? AND ?`).get(inicio, fim).c;
  if (e) return true;
  return db.prepare('SELECT COUNT(*) c FROM fiscal_apuracao_ipi_ajustes WHERE competencia = ?')
    .get(competencia).c > 0;
}

function saldoCredorAnteriorDe(db, competencia) {
  const ant = db.prepare(`SELECT saldoCredorTransportar, status FROM fiscal_apuracao_ipi
    WHERE competencia = ?`).get(competenciaAnterior(competencia));
  if (!ant || ant.status !== 'fechada') return 0;
  return r2(ant.saldoCredorTransportar);
}

// ─── Cálculo ─────────────────────────────────────────────────────────────────

function calcularApuracao(db, competencia) {
  if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');

  if (!ehContribuinteIpi(db)) {
    throw new Error('Empresa não é contribuinte do IPI. Só indústria e equiparado apuram este ' +
      'imposto — no comércio o IPI da nota de compra é custo. Se a empresa industrializa, marque ' +
      '"contribuinte do IPI" em Minha Empresa.');
  }

  const debitos = debitosDe(db, competencia);
  const creditos = creditosDe(db, competencia);
  const ajustes = ajustesDe(db, competencia);

  const vDebitos = r2(debitos.reduce((s, d) => s + Number(d.vIpi || 0), 0));
  const vCreditos = r2(creditos.reduce((s, c) => s + Number(c.vIpi || 0), 0));
  const creditoNegado = r2(creditos.reduce((s, c) => s + Number(c.vIpiSemCredito || 0), 0));

  const porTipo = {};
  for (const t of Object.keys(TIPOS_AJUSTE)) porTipo[t] = 0;
  for (const a of ajustes) porTipo[a.tipo] = r2((porTipo[a.tipo] || 0) + Number(a.valor || 0));

  const saldoCredorAnterior = saldoCredorAnteriorDe(db, competencia);

  const totalDebitos = r2(vDebitos + porTipo.outros_debitos + porTipo.estorno_credito);
  const totalCreditos = r2(vCreditos + porTipo.outros_creditos + porTipo.estorno_debito + saldoCredorAnterior);
  const saldoApurado = r2(totalDebitos - totalCreditos);

  const memoria = [
    `DEBITOS POR SAIDA: ${vDebitos.toFixed(2)} (${debitos.length} documento(s))`,
    `OUTROS DEBITOS: ${porTipo.outros_debitos.toFixed(2)}`,
    `ESTORNO DE CREDITOS: ${porTipo.estorno_credito.toFixed(2)}`,
    `TOTAL DE DEBITOS: ${totalDebitos.toFixed(2)}`,
    `CREDITOS POR ENTRADA (insumos de industrializacao): ${vCreditos.toFixed(2)} (${creditos.length} documento(s))`,
    `OUTROS CREDITOS: ${porTipo.outros_creditos.toFixed(2)}`,
    `ESTORNO DE DEBITOS: ${porTipo.estorno_debito.toFixed(2)}`,
    `SALDO CREDOR DO PERIODO ANTERIOR: ${saldoCredorAnterior.toFixed(2)}`,
    `TOTAL DE CREDITOS: ${totalCreditos.toFixed(2)}`,
    `SALDO: TOTALDEBITOS - TOTALCREDITOS = ${saldoApurado.toFixed(2)}`,
    saldoApurado > 0
      ? `IPI A RECOLHER: ${saldoApurado.toFixed(2)}`
      : `SALDO CREDOR A TRANSPORTAR: ${(-saldoApurado).toFixed(2)}`,
    creditoNegado > 0
      ? `\nIPI SEM DIREITO A CREDITO: ${creditoNegado.toFixed(2)} (revenda, uso e consumo)`
      : '',
  ].filter(Boolean).join('\n');

  const gravada = db.prepare('SELECT * FROM fiscal_apuracao_ipi WHERE competencia = ?').get(competencia);

  return {
    competencia,
    status: gravada ? gravada.status : 'aberta',
    dataFechamento: gravada ? gravada.dataFechamento : null,
    saldoCredorAnterior, vDebitos, vCreditos,
    vOutrosDebitos: porTipo.outros_debitos,
    vEstornoCreditos: porTipo.estorno_credito,
    vOutrosCreditos: porTipo.outros_creditos,
    vEstornoDebitos: porTipo.estorno_debito,
    totalDebitos, totalCreditos, saldoApurado,
    vRecolher: saldoApurado > 0 ? saldoApurado : 0,
    saldoCredorTransportar: saldoApurado < 0 ? r2(-saldoApurado) : 0,
    creditoNegado,
    contagem: { saidas: debitos.length, entradas: creditos.length, ajustes: ajustes.length },
    memoria,
    divergenciaAposFechamento: (gravada && gravada.status === 'fechada'
      && r2(gravada.saldoApurado) !== saldoApurado)
      ? { gravado: r2(gravada.saldoApurado), recalculado: saldoApurado } : null,
  };
}

function salvarApuracao(db, competencia, extra = {}) {
  const a = calcularApuracao(db, competencia);
  db.prepare(`
    INSERT INTO fiscal_apuracao_ipi
      (competencia, status, saldoCredorAnterior, vDebitos, vCreditos, vOutrosDebitos,
       vOutrosCreditos, vEstornoCreditos, vEstornoDebitos, saldoApurado, vRecolher,
       saldoCredorTransportar, observacao, dataAtualizacao)
    VALUES (@competencia, @status, @saldoCredorAnterior, @vDebitos, @vCreditos, @vOutrosDebitos,
       @vOutrosCreditos, @vEstornoCreditos, @vEstornoDebitos, @saldoApurado, @vRecolher,
       @saldoCredorTransportar, @observacao, CURRENT_TIMESTAMP)
    ON CONFLICT(competencia) DO UPDATE SET
       saldoCredorAnterior = excluded.saldoCredorAnterior, vDebitos = excluded.vDebitos,
       vCreditos = excluded.vCreditos, vOutrosDebitos = excluded.vOutrosDebitos,
       vOutrosCreditos = excluded.vOutrosCreditos, vEstornoCreditos = excluded.vEstornoCreditos,
       vEstornoDebitos = excluded.vEstornoDebitos, saldoApurado = excluded.saldoApurado,
       vRecolher = excluded.vRecolher, saldoCredorTransportar = excluded.saldoCredorTransportar,
       observacao = COALESCE(excluded.observacao, fiscal_apuracao_ipi.observacao),
       dataAtualizacao = CURRENT_TIMESTAMP
  `).run({ ...a, observacao: extra.observacao || null });
  return calcularApuracao(db, competencia);
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/fiscal/apuracao-ipi/:competencia', (req, res) => {
    try {
      res.json({ success: true, apuracao: calcularApuracao(db, req.params.competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/fiscal/apuracao-ipi/:competencia/detalhe', (req, res) => {
    try {
      const competencia = req.params.competencia;
      if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');
      if (!ehContribuinteIpi(db)) throw new Error('Empresa não é contribuinte do IPI');
      res.json({
        success: true, competencia,
        debitos: debitosDe(db, competencia),
        creditos: creditosDe(db, competencia),
        ajustes: ajustesDe(db, competencia),
        tiposAjuste: TIPOS_AJUSTE,
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.get('/api/fiscal/apuracao-ipi', (req, res) => {
    try {
      res.json({ success: true, apuracoes: db.prepare(
        'SELECT * FROM fiscal_apuracao_ipi ORDER BY competencia DESC LIMIT ?'
      ).all(Number(req.query.limit) || 24) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-ipi/:competencia/ajustes', (req, res) => {
    try {
      const competencia = req.params.competencia;
      if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');
      const ap = db.prepare('SELECT status FROM fiscal_apuracao_ipi WHERE competencia = ?').get(competencia);
      if (ap && ap.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência fechada — reabra antes' });
      }
      const b = req.body || {};
      if (!TIPOS_AJUSTE[b.tipo]) {
        return res.status(400).json({ success: false,
          error: `Tipo inválido. Use: ${Object.keys(TIPOS_AJUSTE).join(', ')}` });
      }
      if (!b.descricao || !String(b.descricao).trim()) {
        return res.status(400).json({ success: false, error: 'Descrição é obrigatória' });
      }
      const valor = Number(b.valor);
      if (!Number.isFinite(valor) || valor <= 0) {
        return res.status(400).json({ success: false,
          error: 'Valor deve ser maior que zero — o sinal vem do tipo do ajuste' });
      }
      const r = db.prepare(`INSERT INTO fiscal_apuracao_ipi_ajustes
        (competencia, tipo, codigoAjuste, descricao, valor) VALUES (?, ?, ?, ?, ?)`)
        .run(competencia, b.tipo, b.codigoAjuste || null, String(b.descricao).trim(), r2(valor));
      res.json({ success: true, id: r.lastInsertRowid, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-ipi/ajustes/:id/excluir', (req, res) => {
    try {
      const aj = db.prepare('SELECT * FROM fiscal_apuracao_ipi_ajustes WHERE id = ?').get(Number(req.params.id));
      if (!aj) return res.status(404).json({ success: false, error: 'Ajuste não encontrado' });
      const ap = db.prepare('SELECT status FROM fiscal_apuracao_ipi WHERE competencia = ?').get(aj.competencia);
      if (ap && ap.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência fechada — reabra antes' });
      }
      db.prepare('DELETE FROM fiscal_apuracao_ipi_ajustes WHERE id = ?').run(aj.id);
      res.json({ success: true, apuracao: calcularApuracao(db, aj.competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-ipi/:competencia/fechar', (req, res) => {
    try {
      const competencia = req.params.competencia;
      const atual = db.prepare('SELECT status FROM fiscal_apuracao_ipi WHERE competencia = ?').get(competencia);
      if (atual && atual.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência já está fechada' });
      }
      const ant = competenciaAnterior(competencia);
      const antRow = db.prepare('SELECT status FROM fiscal_apuracao_ipi WHERE competencia = ?').get(ant);
      if (!(antRow && antRow.status === 'fechada') && temMovimento(db, ant)) {
        return res.status(400).json({ success: false,
          error: `A competência ${ant} está aberta e tem movimento — feche-a antes, ` +
                 'senão o saldo credor dela não é transportado' });
      }
      salvarApuracao(db, competencia, { observacao: req.body && req.body.observacao });
      db.prepare(`UPDATE fiscal_apuracao_ipi SET status = 'fechada',
        dataFechamento = CURRENT_TIMESTAMP, usuario = ? WHERE competencia = ?`)
        .run((req.user && req.user.username) || null, competencia);
      res.json({ success: true, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-ipi/:competencia/reabrir', (req, res) => {
    try {
      const competencia = req.params.competencia;
      const atual = db.prepare('SELECT status FROM fiscal_apuracao_ipi WHERE competencia = ?').get(competencia);
      if (!atual || atual.status !== 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência não está fechada' });
      }
      const seguintes = db.prepare(`SELECT competencia FROM fiscal_apuracao_ipi
        WHERE competencia > ? AND status = 'fechada' ORDER BY competencia`).all(competencia);
      if (seguintes.length) {
        return res.status(400).json({ success: false,
          error: `Existem competências posteriores fechadas (${seguintes.map(s => s.competencia).join(', ')}). ` +
                 'Reabra da mais recente para a mais antiga.' });
      }
      db.prepare(`UPDATE fiscal_apuracao_ipi SET status = 'aberta', dataFechamento = NULL,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE competencia = ?`).run(competencia);
      res.json({ success: true, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  console.log('[fiscal-apuracao-ipi] Rotas registradas');
}

module.exports = {
  registrarRotasFiscalApuracaoIpi: registrarRotas,
  calcularApuracao, salvarApuracao, debitosDe, creditosDe, ehContribuinteIpi, temMovimento,
  TIPOS_AJUSTE, CFOPS_CREDITO_IPI, migrar,
};
