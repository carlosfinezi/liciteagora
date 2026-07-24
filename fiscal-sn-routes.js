/**
 * fiscal-sn-routes.js — Apuração mensal do Simples Nacional e cálculo do DAS.
 *
 * Tabelas:
 *   - tabelas_sn_aliquotas — seed com LC 123/06 art.18 (anexos I-V, 6 faixas, partilha por tributo)
 *   - apuracoes_sn — uma linha por competência (YYYY-MM)
 *
 * Colunas adicionadas:
 *   - produtos.anexoSN — 'I' | 'II'
 *   - nfse_recorrencias.anexoSN — 'III' | 'IV' | 'V'
 *
 * Endpoints:
 *   GET  /api/fiscal/tabelas-aliquotas
 *   PUT  /api/fiscal/tabelas-aliquotas/:anexo/:faixa
 *   GET  /api/fiscal/rbt12?referencia=YYYY-MM
 *   GET  /api/fiscal/apuracao/:competencia
 *   POST /api/fiscal/apuracao/:competencia/gerar
 *   PUT  /api/fiscal/apuracao/:competencia
 *   POST /api/fiscal/apuracao/:competencia/fechar
 *   POST /api/fiscal/apuracao/:competencia/reabrir
 *   GET  /api/fiscal/apuracoes?limit=12
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* já existe */ } }

const ANEXO_TRIBUTOS = {
  I:   ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ICMS'],
  II:  ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ICMS', 'IPI'],
  III: ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ISS'],
  IV:  ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ISS'],
  V:   ['IRPJ', 'CSLL', 'COFINS', 'PIS', 'CPP', 'ISS']
};

// LC 123/06 art.18 — vigente desde 2018 (valores iniciais; contador pode editar via UI)
const SEED_ALIQUOTAS = {
  I: {
    faixas: [
      { faixa: 1, receitaMin: 0,         receitaMax: 180000,   aliquotaNominal: 4.00,  parcelaDeduzir: 0 },
      { faixa: 2, receitaMin: 180000.01, receitaMax: 360000,   aliquotaNominal: 7.30,  parcelaDeduzir: 5940 },
      { faixa: 3, receitaMin: 360000.01, receitaMax: 720000,   aliquotaNominal: 9.50,  parcelaDeduzir: 13860 },
      { faixa: 4, receitaMin: 720000.01, receitaMax: 1800000,  aliquotaNominal: 10.70, parcelaDeduzir: 22500 },
      { faixa: 5, receitaMin: 1800000.01,receitaMax: 3600000,  aliquotaNominal: 14.30, parcelaDeduzir: 87300 },
      { faixa: 6, receitaMin: 3600000.01,receitaMax: 4800000,  aliquotaNominal: 19.00, parcelaDeduzir: 378000 }
    ],
    partilha: [
      { faixa: 1, pct: { IRPJ: 5.50,  CSLL: 3.50,  COFINS: 12.74, PIS: 2.76, CPP: 41.50, ICMS: 34.00 } },
      { faixa: 2, pct: { IRPJ: 5.50,  CSLL: 3.50,  COFINS: 12.74, PIS: 2.76, CPP: 41.50, ICMS: 34.00 } },
      { faixa: 3, pct: { IRPJ: 5.50,  CSLL: 3.50,  COFINS: 12.74, PIS: 2.76, CPP: 42.00, ICMS: 33.50 } },
      { faixa: 4, pct: { IRPJ: 5.50,  CSLL: 3.50,  COFINS: 12.74, PIS: 2.76, CPP: 42.00, ICMS: 33.50 } },
      { faixa: 5, pct: { IRPJ: 5.50,  CSLL: 3.50,  COFINS: 12.74, PIS: 2.76, CPP: 42.00, ICMS: 33.50 } },
      { faixa: 6, pct: { IRPJ: 13.50, CSLL: 10.00, COFINS: 28.27, PIS: 6.13, CPP: 42.10, ICMS: 0 } }
    ]
  },
  II: {
    faixas: [
      { faixa: 1, receitaMin: 0,         receitaMax: 180000,   aliquotaNominal: 4.50,  parcelaDeduzir: 0 },
      { faixa: 2, receitaMin: 180000.01, receitaMax: 360000,   aliquotaNominal: 7.80,  parcelaDeduzir: 5940 },
      { faixa: 3, receitaMin: 360000.01, receitaMax: 720000,   aliquotaNominal: 10.00, parcelaDeduzir: 13860 },
      { faixa: 4, receitaMin: 720000.01, receitaMax: 1800000,  aliquotaNominal: 11.20, parcelaDeduzir: 22500 },
      { faixa: 5, receitaMin: 1800000.01,receitaMax: 3600000,  aliquotaNominal: 14.70, parcelaDeduzir: 85500 },
      { faixa: 6, receitaMin: 3600000.01,receitaMax: 4800000,  aliquotaNominal: 30.00, parcelaDeduzir: 720000 }
    ],
    partilha: [
      { faixa: 1, pct: { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, ICMS: 32.00, IPI: 7.50 } },
      { faixa: 2, pct: { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, ICMS: 32.00, IPI: 7.50 } },
      { faixa: 3, pct: { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, ICMS: 32.00, IPI: 7.50 } },
      { faixa: 4, pct: { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, ICMS: 32.00, IPI: 7.50 } },
      { faixa: 5, pct: { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, ICMS: 32.00, IPI: 7.50 } },
      { faixa: 6, pct: { IRPJ: 8.50, CSLL: 7.50, COFINS: 20.96, PIS: 4.54, CPP: 23.50, ICMS: 0,     IPI: 35.00 } }
    ]
  },
  III: {
    faixas: [
      { faixa: 1, receitaMin: 0,         receitaMax: 180000,   aliquotaNominal: 6.00,  parcelaDeduzir: 0 },
      { faixa: 2, receitaMin: 180000.01, receitaMax: 360000,   aliquotaNominal: 11.20, parcelaDeduzir: 9360 },
      { faixa: 3, receitaMin: 360000.01, receitaMax: 720000,   aliquotaNominal: 13.50, parcelaDeduzir: 17640 },
      { faixa: 4, receitaMin: 720000.01, receitaMax: 1800000,  aliquotaNominal: 16.00, parcelaDeduzir: 35640 },
      { faixa: 5, receitaMin: 1800000.01,receitaMax: 3600000,  aliquotaNominal: 21.00, parcelaDeduzir: 125640 },
      { faixa: 6, receitaMin: 3600000.01,receitaMax: 4800000,  aliquotaNominal: 33.00, parcelaDeduzir: 648000 }
    ],
    partilha: [
      { faixa: 1, pct: { IRPJ: 4.00,  CSLL: 3.50,  COFINS: 12.82, PIS: 2.78, CPP: 43.40, ISS: 33.50 } },
      { faixa: 2, pct: { IRPJ: 4.00,  CSLL: 3.50,  COFINS: 14.05, PIS: 3.05, CPP: 43.40, ISS: 32.00 } },
      { faixa: 3, pct: { IRPJ: 4.00,  CSLL: 3.50,  COFINS: 13.64, PIS: 2.96, CPP: 43.40, ISS: 32.50 } },
      { faixa: 4, pct: { IRPJ: 4.00,  CSLL: 3.50,  COFINS: 13.64, PIS: 2.96, CPP: 43.40, ISS: 32.50 } },
      { faixa: 5, pct: { IRPJ: 4.00,  CSLL: 3.50,  COFINS: 12.82, PIS: 2.78, CPP: 43.40, ISS: 33.50 } },
      { faixa: 6, pct: { IRPJ: 35.00, CSLL: 15.00, COFINS: 16.03, PIS: 3.47, CPP: 30.50, ISS: 0 } }
    ]
  },
  IV: {
    faixas: [
      { faixa: 1, receitaMin: 0,         receitaMax: 180000,   aliquotaNominal: 4.50,  parcelaDeduzir: 0 },
      { faixa: 2, receitaMin: 180000.01, receitaMax: 360000,   aliquotaNominal: 9.00,  parcelaDeduzir: 8100 },
      { faixa: 3, receitaMin: 360000.01, receitaMax: 720000,   aliquotaNominal: 10.20, parcelaDeduzir: 12420 },
      { faixa: 4, receitaMin: 720000.01, receitaMax: 1800000,  aliquotaNominal: 14.00, parcelaDeduzir: 39780 },
      { faixa: 5, receitaMin: 1800000.01,receitaMax: 3600000,  aliquotaNominal: 22.00, parcelaDeduzir: 183780 },
      { faixa: 6, receitaMin: 3600000.01,receitaMax: 4800000,  aliquotaNominal: 33.00, parcelaDeduzir: 828000 }
    ],
    partilha: [
      { faixa: 1, pct: { IRPJ: 18.80, CSLL: 15.20, COFINS: 17.67, PIS: 3.83, CPP: 0, ISS: 44.50 } },
      { faixa: 2, pct: { IRPJ: 19.80, CSLL: 15.20, COFINS: 20.55, PIS: 4.45, CPP: 0, ISS: 40.00 } },
      { faixa: 3, pct: { IRPJ: 20.80, CSLL: 15.20, COFINS: 19.73, PIS: 4.27, CPP: 0, ISS: 40.00 } },
      { faixa: 4, pct: { IRPJ: 17.80, CSLL: 19.20, COFINS: 18.90, PIS: 4.10, CPP: 0, ISS: 40.00 } },
      { faixa: 5, pct: { IRPJ: 18.80, CSLL: 19.20, COFINS: 18.08, PIS: 3.92, CPP: 0, ISS: 40.00 } },
      { faixa: 6, pct: { IRPJ: 53.50, CSLL: 21.50, COFINS: 20.55, PIS: 4.45, CPP: 0, ISS: 0 } }
    ]
  },
  V: {
    faixas: [
      { faixa: 1, receitaMin: 0,         receitaMax: 180000,   aliquotaNominal: 15.50, parcelaDeduzir: 0 },
      { faixa: 2, receitaMin: 180000.01, receitaMax: 360000,   aliquotaNominal: 18.00, parcelaDeduzir: 4500 },
      { faixa: 3, receitaMin: 360000.01, receitaMax: 720000,   aliquotaNominal: 19.50, parcelaDeduzir: 9900 },
      { faixa: 4, receitaMin: 720000.01, receitaMax: 1800000,  aliquotaNominal: 20.50, parcelaDeduzir: 17100 },
      { faixa: 5, receitaMin: 1800000.01,receitaMax: 3600000,  aliquotaNominal: 23.00, parcelaDeduzir: 62100 },
      { faixa: 6, receitaMin: 3600000.01,receitaMax: 4800000,  aliquotaNominal: 30.50, parcelaDeduzir: 540000 }
    ],
    partilha: [
      { faixa: 1, pct: { IRPJ: 25.00, CSLL: 15.00, COFINS: 14.10, PIS: 3.05, CPP: 28.85, ISS: 14.00 } },
      { faixa: 2, pct: { IRPJ: 23.00, CSLL: 15.00, COFINS: 14.10, PIS: 3.05, CPP: 27.85, ISS: 17.00 } },
      { faixa: 3, pct: { IRPJ: 24.00, CSLL: 15.00, COFINS: 14.92, PIS: 3.23, CPP: 23.85, ISS: 19.00 } },
      { faixa: 4, pct: { IRPJ: 21.00, CSLL: 15.00, COFINS: 15.74, PIS: 3.41, CPP: 23.85, ISS: 21.00 } },
      { faixa: 5, pct: { IRPJ: 23.00, CSLL: 12.50, COFINS: 14.10, PIS: 3.05, CPP: 23.85, ISS: 23.50 } },
      { faixa: 6, pct: { IRPJ: 35.00, CSLL: 15.50, COFINS: 16.44, PIS: 3.56, CPP: 29.50, ISS: 0 } }
    ]
  }
};

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tabelas_sn_aliquotas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      anexo TEXT NOT NULL,
      faixa INTEGER NOT NULL,
      receitaMin REAL NOT NULL,
      receitaMax REAL NOT NULL,
      aliquotaNominal REAL NOT NULL,
      parcelaDeduzir REAL NOT NULL,
      partilhaTributos TEXT NOT NULL,
      UNIQUE (anexo, faixa)
    );
    CREATE INDEX IF NOT EXISTS idx_tab_sn_anexo_faixa ON tabelas_sn_aliquotas(anexo, faixa);

    CREATE TABLE IF NOT EXISTS apuracoes_sn (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      competencia TEXT NOT NULL UNIQUE,
      rbt12 REAL DEFAULT 0,
      receitaAnexoI REAL DEFAULT 0,
      receitaAnexoII REAL DEFAULT 0,
      receitaAnexoIII REAL DEFAULT 0,
      receitaAnexoIV REAL DEFAULT 0,
      receitaAnexoV REAL DEFAULT 0,
      folha12m REAL DEFAULT 0,
      fatorR REAL DEFAULT 0,
      anexoVMigradoIII INTEGER DEFAULT 0,
      aliquotasEfetivas TEXT,
      dasTotal REAL DEFAULT 0,
      dasPorTributo TEXT,
      dasPorAnexo TEXT,
      status TEXT DEFAULT 'rascunho',
      dataVencimento TEXT,
      dataPagamento TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_apur_status ON apuracoes_sn(status);
  `);

  alterSafe(db, "ALTER TABLE produtos ADD COLUMN anexoSN TEXT");
  alterSafe(db, "ALTER TABLE nfse_recorrencias ADD COLUMN anexoSN TEXT");

  const count = db.prepare('SELECT COUNT(*) AS c FROM tabelas_sn_aliquotas').get();
  if (count.c === 0) {
    const ins = db.prepare(`INSERT INTO tabelas_sn_aliquotas
      (anexo, faixa, receitaMin, receitaMax, aliquotaNominal, parcelaDeduzir, partilhaTributos)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const anexo of Object.keys(SEED_ALIQUOTAS)) {
        const cfg = SEED_ALIQUOTAS[anexo];
        for (const f of cfg.faixas) {
          const p = cfg.partilha.find(x => x.faixa === f.faixa);
          ins.run(anexo, f.faixa, f.receitaMin, f.receitaMax, f.aliquotaNominal, f.parcelaDeduzir, JSON.stringify(p.pct));
        }
      }
    });
    tx();
    console.log('[fiscal-sn] Seed de alíquotas SN inserida (LC 123/06)');
  }
}

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function competenciaAnterior(comp, meses = 1) {
  const [y, m] = comp.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - meses, 1));
  return d.toISOString().slice(0, 7);
}

function periodo12mAnteriores(comp) {
  const fim = competenciaAnterior(comp, 1);
  const inicio = competenciaAnterior(comp, 12);
  return { inicio, fim };
}

function vigenciaDatas(comp) {
  const [y, m] = comp.split('-').map(Number);
  const inicio = `${comp}-01`;
  const proxMes = new Date(Date.UTC(y, m, 1));
  const ultimoDia = new Date(Date.UTC(y, m, 0));
  const fim = ultimoDia.toISOString().slice(0, 10);
  const venc = new Date(Date.UTC(y, m, 20));
  return { inicio, fim, vencimento: venc.toISOString().slice(0, 10) };
}

function faixaAtual(db, anexo, rbt12) {
  const faixas = db.prepare('SELECT * FROM tabelas_sn_aliquotas WHERE anexo = ? ORDER BY faixa ASC').all(anexo);
  for (const f of faixas) {
    if (rbt12 >= f.receitaMin && rbt12 <= f.receitaMax) return f;
  }
  return faixas[faixas.length - 1];
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function aliquotaEfetiva(rbt12, aliquotaNominal, parcelaDeduzir) {
  if (rbt12 <= 0) return aliquotaNominal / 100;
  const efetiva = ((rbt12 * aliquotaNominal / 100) - parcelaDeduzir) / rbt12;
  return Math.max(0, efetiva);
}

function calcularReceitasAutomaticas(db, inicio, fim) {
  const receitas = { I: 0, II: 0, III: 0, IV: 0, V: 0 };

  try {
    const nfseAut = db.prepare(`
      SELECT COALESCE(SUM(CAST(json_extract(nfse.xmlRetorno, '$.valorServico') AS REAL)), 0) AS total
      FROM nfse
      WHERE nfse.status = 'autorizada' AND nfse.dataCompetencia = ?
    `).get(fim.slice(0, 7));
    // Fallback mais simples: coluna valorServico se existir
  } catch { /* ignora */ }

  try {
    const nfse = db.prepare(`
      SELECT nfse.id, nfse.valorServico, rec.anexoSN
      FROM nfse
      LEFT JOIN nfse_recorrencias_log log ON log.nfseId = nfse.id
      LEFT JOIN nfse_recorrencias rec ON rec.id = log.recorrenciaId
      WHERE nfse.status = 'autorizada' AND nfse.dataCompetencia = ?
    `).all(fim.slice(0, 7));
    for (const n of nfse) {
      const anexo = n.anexoSN || 'III';
      receitas[anexo] = (receitas[anexo] || 0) + (Number(n.valorServico) || 0);
    }
  } catch (e) {
    console.warn('[fiscal-sn] Falha lendo NFSe para receitas:', e.message);
  }

  try {
    const faturas = db.prepare(`
      SELECT f.id, f.valorTotal
      FROM faturas f
      WHERE f.statusSefaz = 'autorizada'
        AND substr(f.dataEmissao, 1, 10) BETWEEN ? AND ?
    `).all(inicio, fim);
    for (const f of faturas) {
      const itens = db.prepare(`
        SELECT fi.valorTotal, p.anexoSN
        FROM fatura_itens fi
        LEFT JOIN produtos p ON p.id = fi.produtoId
        WHERE fi.faturaId = ?
      `).all(f.id);
      let total = 0;
      const porAnexo = { I: 0, II: 0 };
      for (const it of itens) {
        const a = it.anexoSN === 'II' ? 'II' : 'I';
        porAnexo[a] += Number(it.valorTotal) || 0;
        total += Number(it.valorTotal) || 0;
      }
      if (total === 0) {
        receitas.I += Number(f.valorTotal) || 0;
      } else {
        receitas.I += porAnexo.I;
        receitas.II += porAnexo.II;
      }
    }
  } catch (e) {
    console.warn('[fiscal-sn] Falha lendo faturas para receitas:', e.message);
  }

  return receitas;
}

function calcularRbt12(db, comp) {
  const { inicio, fim } = periodo12mAnteriores(comp);
  const inicioData = inicio + '-01';
  const [yf, mf] = fim.split('-').map(Number);
  const ultimoFim = new Date(Date.UTC(yf, mf, 0)).toISOString().slice(0, 10);

  let total = 0;
  try {
    const nfse = db.prepare(`
      SELECT COALESCE(SUM(valorServico), 0) AS t
      FROM nfse
      WHERE status = 'autorizada' AND dataCompetencia BETWEEN ? AND ?
    `).get(inicio, fim);
    total += Number(nfse.t) || 0;
  } catch {}

  try {
    const fat = db.prepare(`
      SELECT COALESCE(SUM(valorTotal), 0) AS t
      FROM faturas
      WHERE statusSefaz = 'autorizada'
        AND substr(dataEmissao, 1, 10) BETWEEN ? AND ?
    `).get(inicioData, ultimoFim);
    total += Number(fat.t) || 0;
  } catch {}

  return total;
}

function gerarApuracao(db, comp, opts = {}) {
  const { inicio, fim, vencimento } = vigenciaDatas(comp);
  const existing = db.prepare('SELECT * FROM apuracoes_sn WHERE competencia = ?').get(comp);
  if (existing && existing.status === 'fechada' && !opts.force) {
    throw new Error('Apuração já fechada. Reabra antes de regenerar.');
  }

  const rbt12 = opts.rbt12 != null ? Number(opts.rbt12) : calcularRbt12(db, comp);
  const receitas = opts.receitas || calcularReceitasAutomaticas(db, inicio, fim);
  const folha12m = Number(opts.folha12m || (existing?.folha12m) || 0);
  const fatorR = rbt12 > 0 ? folha12m / rbt12 : 0;
  const anexoVMigradoIII = fatorR >= 0.28 && (receitas.V || 0) > 0;

  const receitaFinal = {
    I: Number(receitas.I || 0),
    II: Number(receitas.II || 0),
    III: Number(receitas.III || 0) + (anexoVMigradoIII ? Number(receitas.V || 0) : 0),
    IV: Number(receitas.IV || 0),
    V: anexoVMigradoIII ? 0 : Number(receitas.V || 0)
  };

  const aliquotasEfetivas = {};
  const dasPorAnexo = {};
  const dasPorTributo = { IRPJ: 0, CSLL: 0, COFINS: 0, PIS: 0, CPP: 0, ICMS: 0, IPI: 0, ISS: 0 };
  let dasTotal = 0;

  for (const anexo of ['I', 'II', 'III', 'IV', 'V']) {
    const rec = receitaFinal[anexo];
    if (rec <= 0) { aliquotasEfetivas[anexo] = 0; dasPorAnexo[anexo] = 0; continue; }
    const faixa = faixaAtual(db, anexo, rbt12);
    const ef = aliquotaEfetiva(rbt12, faixa.aliquotaNominal, faixa.parcelaDeduzir);
    aliquotasEfetivas[anexo] = { faixa: faixa.faixa, nominal: faixa.aliquotaNominal, parcelaDeduzir: faixa.parcelaDeduzir, efetiva: ef };
    const dasAnexo = rec * ef;
    dasPorAnexo[anexo] = dasAnexo;
    dasTotal += dasAnexo;

    const partilha = JSON.parse(faixa.partilhaTributos);
    for (const trib of ANEXO_TRIBUTOS[anexo]) {
      const pct = (partilha[trib] || 0) / 100;
      dasPorTributo[trib] = (dasPorTributo[trib] || 0) + dasAnexo * pct;
    }
  }

  dasTotal = round2(dasTotal);
  for (const k of Object.keys(dasPorAnexo)) dasPorAnexo[k] = round2(dasPorAnexo[k]);
  for (const k of Object.keys(dasPorTributo)) dasPorTributo[k] = round2(dasPorTributo[k]);

  const payload = {
    competencia: comp,
    rbt12, folha12m, fatorR,
    anexoVMigradoIII: anexoVMigradoIII ? 1 : 0,
    receitaAnexoI: round2(receitaFinal.I),
    receitaAnexoII: round2(receitaFinal.II),
    receitaAnexoIII: round2(receitaFinal.III),
    receitaAnexoIV: round2(receitaFinal.IV),
    receitaAnexoV: round2(receitaFinal.V),
    aliquotasEfetivas: JSON.stringify(aliquotasEfetivas),
    dasTotal, dasPorTributo: JSON.stringify(dasPorTributo), dasPorAnexo: JSON.stringify(dasPorAnexo),
    dataVencimento: vencimento,
    observacoes: opts.observacoes ?? existing?.observacoes ?? null
  };

  if (existing) {
    db.prepare(`UPDATE apuracoes_sn SET
      rbt12 = ?, folha12m = ?, fatorR = ?, anexoVMigradoIII = ?,
      receitaAnexoI = ?, receitaAnexoII = ?, receitaAnexoIII = ?, receitaAnexoIV = ?, receitaAnexoV = ?,
      aliquotasEfetivas = ?, dasTotal = ?, dasPorTributo = ?, dasPorAnexo = ?,
      dataVencimento = ?, observacoes = ?, dataAtualizacao = CURRENT_TIMESTAMP,
      status = CASE WHEN status='fechada' THEN 'fechada' ELSE 'rascunho' END
      WHERE competencia = ?`).run(
      payload.rbt12, payload.folha12m, payload.fatorR, payload.anexoVMigradoIII,
      payload.receitaAnexoI, payload.receitaAnexoII, payload.receitaAnexoIII, payload.receitaAnexoIV, payload.receitaAnexoV,
      payload.aliquotasEfetivas, payload.dasTotal, payload.dasPorTributo, payload.dasPorAnexo,
      payload.dataVencimento, payload.observacoes, comp
    );
  } else {
    db.prepare(`INSERT INTO apuracoes_sn
      (competencia, rbt12, folha12m, fatorR, anexoVMigradoIII,
       receitaAnexoI, receitaAnexoII, receitaAnexoIII, receitaAnexoIV, receitaAnexoV,
       aliquotasEfetivas, dasTotal, dasPorTributo, dasPorAnexo,
       dataVencimento, observacoes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'rascunho')`).run(
      comp, payload.rbt12, payload.folha12m, payload.fatorR, payload.anexoVMigradoIII,
      payload.receitaAnexoI, payload.receitaAnexoII, payload.receitaAnexoIII, payload.receitaAnexoIV, payload.receitaAnexoV,
      payload.aliquotasEfetivas, payload.dasTotal, payload.dasPorTributo, payload.dasPorAnexo,
      payload.dataVencimento, payload.observacoes
    );
  }

  return db.prepare('SELECT * FROM apuracoes_sn WHERE competencia = ?').get(comp);
}

function hidratar(a) {
  if (!a) return null;
  return {
    ...a,
    aliquotasEfetivas: a.aliquotasEfetivas ? JSON.parse(a.aliquotasEfetivas) : {},
    dasPorTributo: a.dasPorTributo ? JSON.parse(a.dasPorTributo) : {},
    dasPorAnexo: a.dasPorAnexo ? JSON.parse(a.dasPorAnexo) : {}
  };
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/fiscal/tabelas-aliquotas', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM tabelas_sn_aliquotas ORDER BY anexo ASC, faixa ASC').all();
      const out = {};
      for (const r of rows) {
        if (!out[r.anexo]) out[r.anexo] = [];
        out[r.anexo].push({ ...r, partilhaTributos: JSON.parse(r.partilhaTributos) });
      }
      res.json({ success: true, tabelas: out });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/fiscal/tabelas-aliquotas/:anexo/:faixa', (req, res) => {
    try {
      const { anexo, faixa } = req.params;
      const b = req.body || {};
      const existing = db.prepare('SELECT * FROM tabelas_sn_aliquotas WHERE anexo = ? AND faixa = ?').get(anexo, faixa);
      if (!existing) return res.status(404).json({ success: false, error: 'Faixa não encontrada' });
      db.prepare(`UPDATE tabelas_sn_aliquotas SET
        receitaMin = ?, receitaMax = ?, aliquotaNominal = ?, parcelaDeduzir = ?, partilhaTributos = ?
        WHERE anexo = ? AND faixa = ?`).run(
        Number(b.receitaMin ?? existing.receitaMin),
        Number(b.receitaMax ?? existing.receitaMax),
        Number(b.aliquotaNominal ?? existing.aliquotaNominal),
        Number(b.parcelaDeduzir ?? existing.parcelaDeduzir),
        b.partilhaTributos ? JSON.stringify(b.partilhaTributos) : existing.partilhaTributos,
        anexo, faixa
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fiscal/rbt12', (req, res) => {
    try {
      const ref = (req.query.referencia || dataBrasilia().slice(0, 7)).slice(0, 7);
      const { inicio, fim } = periodo12mAnteriores(ref);
      const rbt12 = calcularRbt12(db, ref);
      res.json({ success: true, referencia: ref, periodo: { inicio, fim }, rbt12 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fiscal/apuracao/:competencia', (req, res) => {
    try {
      const comp = req.params.competencia;
      const a = db.prepare('SELECT * FROM apuracoes_sn WHERE competencia = ?').get(comp);
      if (!a) return res.status(404).json({ success: false, error: 'Apuração não encontrada', existe: false });
      res.json({ success: true, apuracao: hidratar(a) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/fiscal/apuracao/:competencia/gerar', (req, res) => {
    try {
      const comp = req.params.competencia;
      const b = req.body || {};
      const a = gerarApuracao(db, comp, {
        rbt12: b.rbt12,
        receitas: b.receitas,
        folha12m: b.folha12m,
        observacoes: b.observacoes,
        force: b.force
      });
      res.json({ success: true, apuracao: hidratar(a) });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.put('/api/fiscal/apuracao/:competencia', (req, res) => {
    try {
      const comp = req.params.competencia;
      const a = db.prepare('SELECT * FROM apuracoes_sn WHERE competencia = ?').get(comp);
      if (!a) return res.status(404).json({ success: false, error: 'Apuração não encontrada' });
      if (a.status === 'fechada') return res.status(400).json({ success: false, error: 'Apuração fechada; reabra antes de editar' });
      const b = req.body || {};
      const receitas = {
        I: b.receitaAnexoI ?? a.receitaAnexoI,
        II: b.receitaAnexoII ?? a.receitaAnexoII,
        III: b.receitaAnexoIII ?? a.receitaAnexoIII,
        IV: b.receitaAnexoIV ?? a.receitaAnexoIV,
        V: b.receitaAnexoV ?? a.receitaAnexoV
      };
      const ap = gerarApuracao(db, comp, {
        rbt12: b.rbt12 ?? a.rbt12,
        receitas,
        folha12m: b.folha12m ?? a.folha12m,
        observacoes: b.observacoes ?? a.observacoes
      });
      res.json({ success: true, apuracao: hidratar(ap) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/fiscal/apuracao/:competencia/fechar', (req, res) => {
    try {
      const comp = req.params.competencia;
      const r = db.prepare(`UPDATE apuracoes_sn SET status = 'fechada', dataAtualizacao = CURRENT_TIMESTAMP
        WHERE competencia = ? AND status IN ('rascunho', 'reaberta')`).run(comp);
      if (r.changes === 0) return res.status(400).json({ success: false, error: 'Apuração inexistente ou já fechada' });
      const a = db.prepare('SELECT * FROM apuracoes_sn WHERE competencia = ?').get(comp);
      res.json({ success: true, apuracao: hidratar(a) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/fiscal/apuracao/:competencia/reabrir', (req, res) => {
    try {
      const comp = req.params.competencia;
      const r = db.prepare(`UPDATE apuracoes_sn SET status = 'reaberta', dataAtualizacao = CURRENT_TIMESTAMP
        WHERE competencia = ? AND status IN ('fechada', 'paga')`).run(comp);
      if (r.changes === 0) return res.status(400).json({ success: false, error: 'Apuração não encontrada ou já em rascunho' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/fiscal/apuracao/:competencia/marcar-paga', (req, res) => {
    try {
      const comp = req.params.competencia;
      const dataPagamento = (req.body?.dataPagamento || dataBrasilia()).slice(0, 10);
      const r = db.prepare(`UPDATE apuracoes_sn SET status = 'paga', dataPagamento = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE competencia = ? AND status = 'fechada'`).run(dataPagamento, comp);
      if (r.changes === 0) return res.status(400).json({ success: false, error: 'Apuração precisa estar fechada para ser marcada como paga' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fiscal/sublimite', (req, res) => {
    try {
      const hoje = dataBrasilia();
      const ref = (req.query.referencia || hoje.slice(0, 7)).slice(0, 7);
      const rbt12 = calcularRbt12(db, ref);

      const [y, m] = ref.split('-').map(Number);
      const anoAtual = y;
      const inicioAno = `${anoAtual}-01-01`;
      const fimRef = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      let rbaAno = 0;
      try {
        const nfse = db.prepare(`SELECT COALESCE(SUM(valorServico),0) AS t FROM nfse
          WHERE status='autorizada' AND dataCompetencia BETWEEN ? AND ?`).get(`${anoAtual}-01`, ref);
        rbaAno += Number(nfse.t) || 0;
      } catch {}
      try {
        const fat = db.prepare(`SELECT COALESCE(SUM(valorTotal),0) AS t FROM faturas
          WHERE statusSefaz='autorizada' AND substr(dataEmissao,1,10) BETWEEN ? AND ?`).get(inicioAno, fimRef);
        rbaAno += Number(fat.t) || 0;
      } catch {}

      const mesesDecorridos = m;
      const projecaoAnual = mesesDecorridos > 0 ? (rbaAno / mesesDecorridos) * 12 : 0;

      const LIMITE_NACIONAL = 4800000;
      const SUBLIMITE_ESTADUAL = 3600000;
      const LIMITE_MEI = 81000;

      const pctRbt12 = (rbt12 / LIMITE_NACIONAL) * 100;
      const pctProjecao = (projecaoAnual / LIMITE_NACIONAL) * 100;

      let nivel = 'ok', mensagem = 'Dentro dos limites do SN';
      if (rbt12 > LIMITE_NACIONAL) { nivel = 'desenquadrado'; mensagem = 'RBT12 excedeu o limite nacional (R$ 4.800.000) — empresa pode ter sido desenquadrada do SN'; }
      else if (rbt12 > LIMITE_NACIONAL * 0.95) { nivel = 'critico'; mensagem = 'RBT12 acima de 95% do limite nacional — desenquadramento iminente'; }
      else if (rbt12 > SUBLIMITE_ESTADUAL) { nivel = 'sublimite'; mensagem = 'RBT12 excedeu o sublimite estadual (R$ 3.600.000) — ICMS/ISS podem passar a ser recolhidos fora do DAS'; }
      else if (projecaoAnual > LIMITE_NACIONAL) { nivel = 'projecao_estourou'; mensagem = 'Projeção anual acima do limite nacional — ajuste o ritmo de vendas ou prepare migração de regime'; }
      else if (projecaoAnual > SUBLIMITE_ESTADUAL) { nivel = 'projecao_sublimite'; mensagem = 'Projeção anual acima do sublimite estadual'; }
      else if (rbt12 > LIMITE_NACIONAL * 0.8) { nivel = 'aviso'; mensagem = 'RBT12 acima de 80% do limite — acompanhe de perto'; }

      res.json({
        success: true,
        referencia: ref,
        rbt12: round2(rbt12),
        rbaAnoAtual: round2(rbaAno),
        projecaoAnual: round2(projecaoAnual),
        mesesDecorridos,
        limites: {
          mei: LIMITE_MEI,
          sublimiteEstadual: SUBLIMITE_ESTADUAL,
          nacional: LIMITE_NACIONAL
        },
        pctRbt12: Math.round(pctRbt12 * 100) / 100,
        pctProjecao: Math.round(pctProjecao * 100) / 100,
        nivel,
        mensagem
      });
    } catch (err) {
      console.error('[fiscal-sn sublimite]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fiscal/apuracoes', (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 12, 120);
      const rows = db.prepare(`SELECT * FROM apuracoes_sn ORDER BY competencia DESC LIMIT ?`).all(limit);
      res.json({ success: true, apuracoes: rows.map(hidratar) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[fiscal-sn] Rotas registradas');
}

module.exports = { registrarRotasFiscalSN: registrarRotas };
