/**
 * fiscal-apuracao-icms.js — Livro de Apuração do ICMS (regime normal).
 *
 * O confronto mensal entre o que a empresa deve (débitos das saídas) e o que
 * tem a compensar (créditos das entradas), com o saldo transportado de uma
 * competência para a seguinte.
 *
 * Só faz sentido no regime NORMAL. No Simples Nacional o ICMS é recolhido no
 * DAS por faturamento e a apuração é outra — `fiscal-sn-routes.js`.
 *
 * De onde vem cada número (e é isso que torna este módulo barato de construir:
 * os dois lados já estavam gravados):
 *
 *   DÉBITOS   fatura_itens.vIcms       — destacado pelo motor de tributação
 *   CRÉDITOS  nfe_entrada_itens.valorIcms, mas SÓ quando o CFOP da entrada tem
 *             `geraCreditoIcms = 1`. Compra para uso e consumo, ou mercadoria
 *             já substituída, não geram crédito — e o cadastro de CFOP já sabe
 *             disso desde antes deste módulo.
 *
 * ST e DIFAL são apurados à PARTE: não se compensam com o ICMS próprio, têm
 * recolhimento em guia própria. Aparecem no relatório, fora da conta principal.
 *
 * Tudo é rastreável: cada total abre na lista de documentos que o compõe. Um
 * livro que só mostra o total não serve para discutir com o contador.
 */

const { crtDoEmitente, ehSimples } = require('./fiscal-tributacao');

// Documentos que NÃO entram na apuração, por motivos distintos:
//   cancelada_sefaz — o documento deixou de existir
//   nao_fiscal      — nunca foi documento fiscal
//   excluida        — soft-delete do usuário
const FILTRO_SAIDA_VALIDA = `f.statusSefaz = 'autorizada' AND COALESCE(f.excluida, 0) = 0`;

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* já existe */ } }

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fiscal_apuracao_icms (
      competencia TEXT PRIMARY KEY,          -- 'YYYY-MM'
      status TEXT DEFAULT 'aberta',          -- 'aberta' | 'fechada'

      saldoCredorAnterior REAL DEFAULT 0,
      vDebitos REAL DEFAULT 0,               -- saídas com débito
      vCreditos REAL DEFAULT 0,              -- entradas com direito a crédito
      vOutrosDebitos REAL DEFAULT 0,
      vEstornoCreditos REAL DEFAULT 0,
      vOutrosCreditos REAL DEFAULT 0,
      vEstornoDebitos REAL DEFAULT 0,
      vDeducoes REAL DEFAULT 0,

      saldoApurado REAL DEFAULT 0,           -- positivo = a recolher; negativo = credor
      vRecolher REAL DEFAULT 0,
      saldoCredorTransportar REAL DEFAULT 0,

      vIcmsST REAL DEFAULT 0,                -- apurado à parte (guia própria)
      vDifal REAL DEFAULT 0,                 -- idem
      vFcp REAL DEFAULT 0,

      dataFechamento TEXT,
      usuario TEXT,
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- Ajustes lançados à mão: o que não vem de documento (estorno, crédito
    -- extemporâneo, dedução de incentivo). O codigoAjuste segue a tabela do
    -- SPED, para o dia em que a EFD for gerada a partir daqui.
    CREATE TABLE IF NOT EXISTS fiscal_apuracao_icms_ajustes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT NOT NULL,
      tipo TEXT NOT NULL,                    -- ver TIPOS_AJUSTE
      codigoAjuste TEXT,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_apur_ajustes_comp
      ON fiscal_apuracao_icms_ajustes(competencia);
  `);
  alterSafe(db, 'ALTER TABLE fiscal_apuracao_icms ADD COLUMN vFcp REAL DEFAULT 0');
}

const TIPOS_AJUSTE = {
  outros_debitos:   { rotulo: 'Outros débitos',      sinal: +1, campo: 'vOutrosDebitos' },
  estorno_credito:  { rotulo: 'Estorno de créditos', sinal: +1, campo: 'vEstornoCreditos' },
  outros_creditos:  { rotulo: 'Outros créditos',     sinal: -1, campo: 'vOutrosCreditos' },
  estorno_debito:   { rotulo: 'Estorno de débitos',  sinal: -1, campo: 'vEstornoDebitos' },
  deducao:          { rotulo: 'Deduções',            sinal: -1, campo: 'vDeducoes' },
};

function r2(n) { return Number((Number(n) || 0).toFixed(2)); }

function validarCompetencia(c) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c || ''));
}

function limitesDe(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  const ultimoDia = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  return { inicio: `${competencia}-01`, fim: `${competencia}-${String(ultimoDia).padStart(2, '0')}` };
}

function competenciaAnterior(competencia) {
  const [ano, mes] = competencia.split('-').map(Number);
  return mes === 1 ? `${ano - 1}-12` : `${ano}-${String(mes - 1).padStart(2, '0')}`;
}

/** Saldo credor que a competência anterior deixou — só conta se ela foi FECHADA. */
function saldoCredorAnteriorDe(db, competencia) {
  const ant = db.prepare(
    `SELECT saldoCredorTransportar, status FROM fiscal_apuracao_icms WHERE competencia = ?`
  ).get(competenciaAnterior(competencia));
  if (!ant || ant.status !== 'fechada') return 0;
  return r2(ant.saldoCredorTransportar);
}

// ─── Fontes ──────────────────────────────────────────────────────────────────

function debitosDe(db, competencia) {
  const { inicio, fim } = limitesDe(competencia);
  return db.prepare(`
    SELECT f.id AS faturaId, f.numero, f.numeroNFe, f.dataEmissao, f.chaveAcesso,
           p.razaoSocial AS destinatario,
           COALESCE(SUM(fi.vIcms), 0) AS vIcms,
           COALESCE(SUM(fi.vBcIcms), 0) AS vBase,
           COALESCE(SUM(fi.vIcmsST), 0) AS vST,
           COALESCE(SUM(fi.vIcmsUFDest), 0) AS vDifal,
           COALESCE(SUM(fi.vFcp), 0) AS vFcp
      FROM faturas f
      JOIN fatura_itens fi ON fi.faturaId = f.id
      LEFT JOIN pessoas p ON p.id = f.clienteId
     WHERE ${FILTRO_SAIDA_VALIDA}
       AND f.dataEmissao BETWEEN ? AND ?
     GROUP BY f.id
     HAVING vIcms > 0 OR vST > 0 OR vDifal > 0
     ORDER BY f.dataEmissao, f.id`).all(inicio, fim);
}

function creditosDe(db, competencia) {
  const { inicio, fim } = limitesDe(competencia);
  // O direito ao crédito é do CFOP, não do valor destacado: mercadoria com ST
  // ou para uso e consumo vem com ICMS na nota e mesmo assim não credita.
  return db.prepare(`
    SELECT e.id AS entradaId, e.numero, e.chaveAcesso, e.dataEmissao,
           e.emitenteRazaoSocial AS fornecedor,
           COALESCE(SUM(CASE WHEN c.geraCreditoIcms = 1 THEN ei.valorIcms ELSE 0 END), 0) AS vIcms,
           COALESCE(SUM(CASE WHEN c.geraCreditoIcms = 1 THEN 0 ELSE ei.valorIcms END), 0) AS vIcmsSemCredito,
           GROUP_CONCAT(DISTINCT ei.cfop) AS cfops
      FROM nfe_entrada e
      JOIN nfe_entrada_itens ei ON ei.nfeId = e.id
      LEFT JOIN cfops c ON c.codigo = ei.cfop
     WHERE COALESCE(e.excluida, 0) = 0
       AND e.dataEmissao BETWEEN ? AND ?
     GROUP BY e.id
     HAVING vIcms > 0 OR vIcmsSemCredito > 0
     ORDER BY e.dataEmissao, e.id`).all(inicio, fim);
}

/**
 * A competência tem algum documento ou ajuste? Usado na trava de fechamento:
 * mês vazio não precisa ser fechado para o seguinte poder fechar.
 */
function temMovimento(db, competencia) {
  if (!validarCompetencia(competencia)) return false;
  const { inicio, fim } = limitesDe(competencia);
  const saidas = db.prepare(`SELECT COUNT(*) c FROM faturas f
    WHERE ${FILTRO_SAIDA_VALIDA} AND f.dataEmissao BETWEEN ? AND ?`).get(inicio, fim).c;
  if (saidas) return true;
  const entradas = db.prepare(`SELECT COUNT(*) c FROM nfe_entrada
    WHERE COALESCE(excluida,0) = 0 AND dataEmissao BETWEEN ? AND ?`).get(inicio, fim).c;
  if (entradas) return true;
  return db.prepare('SELECT COUNT(*) c FROM fiscal_apuracao_icms_ajustes WHERE competencia = ?')
    .get(competencia).c > 0;
}

function ajustesDe(db, competencia) {
  return db.prepare(
    `SELECT * FROM fiscal_apuracao_icms_ajustes WHERE competencia = ? ORDER BY tipo, id`
  ).all(competencia);
}

// ─── Cálculo ─────────────────────────────────────────────────────────────────

/**
 * Apura a competência a partir dos documentos. NÃO grava — quem grava é
 * `salvarApuracao` / `fecharApuracao`. Assim a tela pode mostrar o número
 * atualizado a cada consulta, sem congelar nada antes da hora.
 */
function calcularApuracao(db, competencia) {
  if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');

  const crt = crtDoEmitente(db);
  if (ehSimples(crt)) {
    throw new Error('Empresa no Simples Nacional: o ICMS é recolhido no DAS. ' +
      'Use Fiscal › Apuração SN.');
  }

  const debitos = debitosDe(db, competencia);
  const creditos = creditosDe(db, competencia);
  const ajustes = ajustesDe(db, competencia);

  const vDebitos = r2(debitos.reduce((s, d) => s + Number(d.vIcms || 0), 0));
  const vCreditos = r2(creditos.reduce((s, c) => s + Number(c.vIcms || 0), 0));
  const vIcmsST = r2(debitos.reduce((s, d) => s + Number(d.vST || 0), 0));
  const vDifal = r2(debitos.reduce((s, d) => s + Number(d.vDifal || 0), 0));
  const vFcp = r2(debitos.reduce((s, d) => s + Number(d.vFcp || 0), 0));
  const creditoNegado = r2(creditos.reduce((s, c) => s + Number(c.vIcmsSemCredito || 0), 0));

  const porTipo = {};
  for (const t of Object.keys(TIPOS_AJUSTE)) porTipo[t] = 0;
  for (const a of ajustes) porTipo[a.tipo] = r2((porTipo[a.tipo] || 0) + Number(a.valor || 0));

  const saldoCredorAnterior = saldoCredorAnteriorDe(db, competencia);

  // Fórmula do livro (RICMS):
  //   total de débitos  = débitos por saída + outros débitos + estorno de créditos
  //   total de créditos = créditos por entrada + outros créditos + estorno de débitos
  //                       + saldo credor do período anterior
  //   saldo = débitos − créditos − deduções
  const totalDebitos = r2(vDebitos + porTipo.outros_debitos + porTipo.estorno_credito);
  const totalCreditos = r2(vCreditos + porTipo.outros_creditos + porTipo.estorno_debito + saldoCredorAnterior);
  const saldoApurado = r2(totalDebitos - totalCreditos - porTipo.deducao);

  const vRecolher = saldoApurado > 0 ? saldoApurado : 0;
  const saldoCredorTransportar = saldoApurado < 0 ? r2(-saldoApurado) : 0;

  const memoria = [
    `DEBITOS POR SAIDA: ${vDebitos.toFixed(2)} (${debitos.length} documento(s))`,
    `OUTROS DEBITOS: ${porTipo.outros_debitos.toFixed(2)}`,
    `ESTORNO DE CREDITOS: ${porTipo.estorno_credito.toFixed(2)}`,
    `TOTAL DE DEBITOS: ${totalDebitos.toFixed(2)}`,
    `CREDITOS POR ENTRADA: ${vCreditos.toFixed(2)} (${creditos.length} documento(s))`,
    `OUTROS CREDITOS: ${porTipo.outros_creditos.toFixed(2)}`,
    `ESTORNO DE DEBITOS: ${porTipo.estorno_debito.toFixed(2)}`,
    `SALDO CREDOR DO PERIODO ANTERIOR: ${saldoCredorAnterior.toFixed(2)}`,
    `TOTAL DE CREDITOS: ${totalCreditos.toFixed(2)}`,
    `DEDUCOES: ${porTipo.deducao.toFixed(2)}`,
    `SALDO: TOTALDEBITOS - TOTALCREDITOS - DEDUCOES = ${saldoApurado.toFixed(2)}`,
    saldoApurado > 0
      ? `ICMS A RECOLHER: ${vRecolher.toFixed(2)}`
      : `SALDO CREDOR A TRANSPORTAR: ${saldoCredorTransportar.toFixed(2)}`,
  ].join('\n');

  const gravada = db.prepare('SELECT * FROM fiscal_apuracao_icms WHERE competencia = ?').get(competencia);

  return {
    competencia,
    status: gravada ? gravada.status : 'aberta',
    dataFechamento: gravada ? gravada.dataFechamento : null,
    crt,
    saldoCredorAnterior,
    vDebitos, vCreditos,
    vOutrosDebitos: porTipo.outros_debitos,
    vEstornoCreditos: porTipo.estorno_credito,
    vOutrosCreditos: porTipo.outros_creditos,
    vEstornoDebitos: porTipo.estorno_debito,
    vDeducoes: porTipo.deducao,
    totalDebitos, totalCreditos,
    saldoApurado, vRecolher, saldoCredorTransportar,
    vIcmsST, vDifal, vFcp,
    creditoNegado,
    contagem: { saidas: debitos.length, entradas: creditos.length, ajustes: ajustes.length },
    memoria,
    // Divergência entre o gravado no fechamento e o recalculado agora: sinal de
    // que documento do período mudou depois de a competência ser fechada.
    divergenciaAposFechamento: (gravada && gravada.status === 'fechada'
      && r2(gravada.saldoApurado) !== saldoApurado)
      ? { gravado: r2(gravada.saldoApurado), recalculado: saldoApurado }
      : null,
  };
}

function salvarApuracao(db, competencia, extra = {}) {
  const a = calcularApuracao(db, competencia);
  db.prepare(`
    INSERT INTO fiscal_apuracao_icms
      (competencia, status, saldoCredorAnterior, vDebitos, vCreditos, vOutrosDebitos,
       vEstornoCreditos, vOutrosCreditos, vEstornoDebitos, vDeducoes, saldoApurado,
       vRecolher, saldoCredorTransportar, vIcmsST, vDifal, vFcp, observacao, dataAtualizacao)
    VALUES (@competencia, @status, @saldoCredorAnterior, @vDebitos, @vCreditos, @vOutrosDebitos,
       @vEstornoCreditos, @vOutrosCreditos, @vEstornoDebitos, @vDeducoes, @saldoApurado,
       @vRecolher, @saldoCredorTransportar, @vIcmsST, @vDifal, @vFcp, @observacao, CURRENT_TIMESTAMP)
    ON CONFLICT(competencia) DO UPDATE SET
       saldoCredorAnterior = excluded.saldoCredorAnterior,
       vDebitos = excluded.vDebitos, vCreditos = excluded.vCreditos,
       vOutrosDebitos = excluded.vOutrosDebitos, vEstornoCreditos = excluded.vEstornoCreditos,
       vOutrosCreditos = excluded.vOutrosCreditos, vEstornoDebitos = excluded.vEstornoDebitos,
       vDeducoes = excluded.vDeducoes, saldoApurado = excluded.saldoApurado,
       vRecolher = excluded.vRecolher, saldoCredorTransportar = excluded.saldoCredorTransportar,
       vIcmsST = excluded.vIcmsST, vDifal = excluded.vDifal, vFcp = excluded.vFcp,
       observacao = COALESCE(excluded.observacao, fiscal_apuracao_icms.observacao),
       dataAtualizacao = CURRENT_TIMESTAMP
  `).run({ ...a, status: a.status, observacao: extra.observacao || null });
  return calcularApuracao(db, competencia);
}

function registrarRotas(app, db) {
  migrar(db);

  // ─── Apuração de uma competência ──────────────────────────────────────────
  app.get('/api/fiscal/apuracao-icms/:competencia', (req, res) => {
    try {
      res.json({ success: true, apuracao: calcularApuracao(db, req.params.competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ─── Detalhamento: os documentos por trás de cada total ───────────────────
  app.get('/api/fiscal/apuracao-icms/:competencia/detalhe', (req, res) => {
    try {
      const competencia = req.params.competencia;
      if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');
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

  // ─── Lista das competências ───────────────────────────────────────────────
  app.get('/api/fiscal/apuracao-icms', (req, res) => {
    try {
      const linhas = db.prepare(
        'SELECT * FROM fiscal_apuracao_icms ORDER BY competencia DESC LIMIT ?'
      ).all(Number(req.query.limit) || 24);
      res.json({ success: true, apuracoes: linhas });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ─── Ajustes ──────────────────────────────────────────────────────────────
  app.post('/api/fiscal/apuracao-icms/:competencia/ajustes', (req, res) => {
    try {
      const competencia = req.params.competencia;
      if (!validarCompetencia(competencia)) throw new Error('Competência inválida — use AAAA-MM');
      const fechada = db.prepare(
        `SELECT status FROM fiscal_apuracao_icms WHERE competencia = ?`).get(competencia);
      if (fechada && fechada.status === 'fechada') {
        return res.status(400).json({ success: false,
          error: 'Competência fechada — reabra antes de lançar ajustes' });
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
      const r = db.prepare(`INSERT INTO fiscal_apuracao_icms_ajustes
        (competencia, tipo, codigoAjuste, descricao, valor) VALUES (?, ?, ?, ?, ?)`)
        .run(competencia, b.tipo, b.codigoAjuste || null, String(b.descricao).trim(), r2(valor));
      res.json({ success: true, id: r.lastInsertRowid, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-icms/ajustes/:id/excluir', (req, res) => {
    try {
      const aj = db.prepare('SELECT * FROM fiscal_apuracao_icms_ajustes WHERE id = ?').get(Number(req.params.id));
      if (!aj) return res.status(404).json({ success: false, error: 'Ajuste não encontrado' });
      const ap = db.prepare('SELECT status FROM fiscal_apuracao_icms WHERE competencia = ?').get(aj.competencia);
      if (ap && ap.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência fechada — reabra antes' });
      }
      db.prepare('DELETE FROM fiscal_apuracao_icms_ajustes WHERE id = ?').run(aj.id);
      res.json({ success: true, apuracao: calcularApuracao(db, aj.competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  // ─── Fechar / reabrir ─────────────────────────────────────────────────────
  // Fechar congela os números e libera o saldo credor para a competência
  // seguinte. Sem fechar, o saldo NÃO transporta — é o que evita que um mês
  // ainda em digitação contamine o próximo.
  app.post('/api/fiscal/apuracao-icms/:competencia/fechar', (req, res) => {
    try {
      const competencia = req.params.competencia;
      const atual = db.prepare('SELECT status FROM fiscal_apuracao_icms WHERE competencia = ?').get(competencia);
      if (atual && atual.status === 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência já está fechada' });
      }
      // A anterior precisa estar fechada, senão o saldo credor dela não entrou
      // nesta conta e o número sai errado.
      //
      // Não basta checar se EXISTE linha da anterior: uma competência nunca
      // apurada não tem linha nenhuma e passaria batido, mesmo tendo movimento.
      // O que trava é ter movimento e não estar fechada. Mês sem nenhum
      // documento não interrompe a cadeia — não há saldo a transportar.
      const ant = competenciaAnterior(competencia);
      const antRow = db.prepare('SELECT status FROM fiscal_apuracao_icms WHERE competencia = ?').get(ant);
      const antFechada = antRow && antRow.status === 'fechada';
      if (!antFechada && temMovimento(db, ant)) {
        return res.status(400).json({ success: false,
          error: `A competência ${ant} está aberta e tem movimento — feche-a antes, ` +
                 'senão o saldo credor dela não é transportado' });
      }

      salvarApuracao(db, competencia, { observacao: req.body && req.body.observacao });
      db.prepare(`UPDATE fiscal_apuracao_icms
        SET status = 'fechada', dataFechamento = CURRENT_TIMESTAMP, usuario = ?
        WHERE competencia = ?`).run((req.user && req.user.username) || null, competencia);

      res.json({ success: true, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  app.post('/api/fiscal/apuracao-icms/:competencia/reabrir', (req, res) => {
    try {
      const competencia = req.params.competencia;
      const atual = db.prepare('SELECT status FROM fiscal_apuracao_icms WHERE competencia = ?').get(competencia);
      if (!atual || atual.status !== 'fechada') {
        return res.status(400).json({ success: false, error: 'Competência não está fechada' });
      }
      // Reabrir um mês invalida o saldo transportado para os seguintes.
      const seguintes = db.prepare(
        `SELECT competencia FROM fiscal_apuracao_icms
          WHERE competencia > ? AND status = 'fechada' ORDER BY competencia`).all(competencia);
      if (seguintes.length) {
        return res.status(400).json({ success: false,
          error: `Existem competências posteriores fechadas (${seguintes.map(s => s.competencia).join(', ')}). ` +
                 'Reabra da mais recente para a mais antiga.' });
      }
      db.prepare(`UPDATE fiscal_apuracao_icms SET status = 'aberta', dataFechamento = NULL,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE competencia = ?`).run(competencia);
      res.json({ success: true, apuracao: calcularApuracao(db, competencia) });
    } catch (error) {
      res.status(400).json({ success: false, error: error.message });
    }
  });

  console.log('[fiscal-apuracao-icms] Rotas registradas');
}

module.exports = {
  registrarRotasFiscalApuracaoIcms: registrarRotas,
  calcularApuracao, salvarApuracao, debitosDe, creditosDe,
  competenciaAnterior, limitesDe, temMovimento, TIPOS_AJUSTE, migrar,
};
