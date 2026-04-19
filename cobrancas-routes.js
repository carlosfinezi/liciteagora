/**
 * cobrancas-routes.js — Cobrança recorrente de títulos vencidos
 *
 * Régua padrão (editável via /api/cobrancas/config):
 *   Etapa 1: D+1  — lembrete educado (e-mail)
 *   Etapa 2: D+3  — amigável (e-mail + WhatsApp)
 *   Etapa 3: D+7  — firme (e-mail + WhatsApp)
 *   Etapa 4: D+15 — aviso de negativação (e-mail + WhatsApp)
 *   Etapa 5: D+30 — parar
 */

const { enviarEmailCobranca, loadSmtpConfig } = require('./email-client');
const { enviarWhatsApp } = require('./whatsapp-adapter');

const DEFAULT_REGUA = [
  {
    etapa: 1, diasApos: 1, canais: ['email'],
    assunto: 'Lembrete: fatura {{descricao}} venceu ontem',
    emailTexto: 'Olá {{nome}},\n\nPassando para lembrar que a fatura abaixo venceu ontem:\n\n{{descricao}}\nValor: {{valor}}\nVencimento: {{vencimento}}\n\nSe o pagamento já foi realizado, desconsidere este e-mail.\n\nAtenciosamente.',
    whatsappTexto: 'Oi {{nome}}, tudo bem? Passando para lembrar que a fatura "{{descricao}}" no valor de {{valor}} venceu em {{vencimento}}. Se já pagou, desconsidere!',
  },
  {
    etapa: 2, diasApos: 3, canais: ['email', 'whatsapp'],
    assunto: 'Fatura em atraso: {{descricao}} ({{diasAtraso}} dias)',
    emailTexto: 'Olá {{nome}},\n\nIdentificamos que a fatura abaixo está em atraso há {{diasAtraso}} dias:\n\n{{descricao}}\nValor: {{valor}}\nVencimento: {{vencimento}}\n\nPara regularizar, utilize os dados abaixo:\nLinha digitável: {{linhaDigitavel}}\nBoleto: {{linkBoleto}}\n\nCaso já tenha efetuado o pagamento, desconsidere.',
    whatsappTexto: 'Olá {{nome}}, a fatura "{{descricao}}" no valor de {{valor}} está em atraso há {{diasAtraso}} dias. Pague pelo link: {{linkBoleto}}',
  },
  {
    etapa: 3, diasApos: 7, canais: ['email', 'whatsapp'],
    assunto: 'URGENTE — Fatura em atraso há {{diasAtraso}} dias',
    emailTexto: 'Prezado(a) {{nome}},\n\nA fatura "{{descricao}}" no valor de {{valor}} está em atraso há {{diasAtraso}} dias (vencimento {{vencimento}}).\n\nPedimos o pagamento com urgência para evitar medidas adicionais.\n\nLinha digitável: {{linhaDigitavel}}\nBoleto: {{linkBoleto}}\n\nEm caso de dúvidas ou negociação, entre em contato.',
    whatsappTexto: '{{nome}}, a fatura "{{descricao}}" ({{valor}}) está vencida há {{diasAtraso}} dias. Pedimos pagamento urgente: {{linkBoleto}}',
  },
  {
    etapa: 4, diasApos: 15, canais: ['email', 'whatsapp'],
    assunto: 'Último aviso antes de negativação — {{descricao}}',
    emailTexto: 'Prezado(a) {{nome}},\n\nEste é um último aviso referente à fatura "{{descricao}}" ({{valor}}), vencida em {{vencimento}} — {{diasAtraso}} dias de atraso.\n\nCaso o pagamento não seja realizado, o débito poderá ser encaminhado para negativação junto aos órgãos de proteção ao crédito.\n\nLinha digitável: {{linhaDigitavel}}\nBoleto: {{linkBoleto}}\n\nEvite transtornos. Em caso de dificuldade, entre em contato para negociação.',
    whatsappTexto: '{{nome}}, último aviso antes de negativação: fatura "{{descricao}}" ({{valor}}), {{diasAtraso}} dias de atraso. Regularize: {{linkBoleto}}',
  },
  {
    etapa: 5, diasApos: 30, canais: [],
    assunto: '', emailTexto: '', whatsappTexto: '',
  },
];

const DEFAULT_CONFIG = {
  regua: DEFAULT_REGUA,
  horaExecucao: 9, // 9h BRT
  executarDiasUteis: true, // pular sab/dom/feriado
  limitePorDia: 1, // max 1 disparo por canal/conta/dia
  remetenteNome: '', // usa do smtp_config se vazio
  ccInterno: '', // e-mail interno em cópia (para acompanhamento)
};

// Feriados nacionais fixos + móveis 2026-2027 (BRT, YYYY-MM-DD)
const FERIADOS_NACIONAIS = new Set([
  // 2026
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-04-03', '2026-04-21',
  '2026-05-01', '2026-06-04', '2026-09-07', '2026-10-12', '2026-11-02',
  '2026-11-15', '2026-11-20', '2026-12-25',
  // 2027
  '2027-01-01', '2027-02-08', '2027-02-09', '2027-03-26', '2027-04-21',
  '2027-05-01', '2027-05-27', '2027-09-07', '2027-10-12', '2027-11-02',
  '2027-11-15', '2027-11-20', '2027-12-25',
]);

function dataBrasilia() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function isDiaUtil(dataYMD) {
  const d = new Date(dataYMD + 'T12:00:00Z');
  const dow = d.getUTCDay(); // 0=dom, 6=sab
  if (dow === 0 || dow === 6) return false;
  if (FERIADOS_NACIONAIS.has(dataYMD)) return false;
  return true;
}

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cobrancas_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS cobrancas_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaReceberId INTEGER NOT NULL,
      pessoaId INTEGER NOT NULL,
      etapa INTEGER NOT NULL,
      canal TEXT NOT NULL,
      destinatario TEXT,
      assunto TEXT,
      mensagem TEXT,
      status TEXT NOT NULL DEFAULT 'enviado',
      erro TEXT,
      dataEnvio TEXT DEFAULT CURRENT_TIMESTAMP,
      origem TEXT DEFAULT 'regua',
      FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id),
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id)
    );

    CREATE INDEX IF NOT EXISTS idx_cobrancas_log_conta ON cobrancas_log(contaReceberId);
    CREATE INDEX IF NOT EXISTS idx_cobrancas_log_data ON cobrancas_log(dataEnvio);
  `);

  const cols = db.prepare("PRAGMA table_info(pessoas)").all();
  if (!cols.find(c => c.name === 'cobrancaAtiva')) {
    db.exec('ALTER TABLE pessoas ADD COLUMN cobrancaAtiva INTEGER DEFAULT 1');
  }

  // Config inicial
  const configAtual = db.prepare('SELECT value FROM cobrancas_config WHERE key = ?').get('config');
  if (!configAtual) {
    db.prepare('INSERT INTO cobrancas_config (key, value) VALUES (?, ?)').run('config', JSON.stringify(DEFAULT_CONFIG));
  }

  console.log('[Cobrancas] Schema verificado');
}

function getConfig(db) {
  const row = db.prepare('SELECT value FROM cobrancas_config WHERE key = ?').get('config');
  if (!row) return DEFAULT_CONFIG;
  try {
    const cfg = JSON.parse(row.value);
    return { ...DEFAULT_CONFIG, ...cfg };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function setConfig(db, cfg) {
  db.prepare('INSERT OR REPLACE INTO cobrancas_config (key, value) VALUES (?, ?)').run('config', JSON.stringify(cfg));
}

function formatarValor(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatarData(ymd) {
  if (!ymd) return '';
  const parts = ymd.split('-');
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return ymd;
}

function diffDiasVencimento(dataVencYMD) {
  const hoje = new Date(dataBrasilia() + 'T12:00:00Z');
  const venc = new Date(dataVencYMD + 'T12:00:00Z');
  return Math.floor((hoje - venc) / (1000 * 60 * 60 * 24));
}

function substituirVariaveis(template, ctx) {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] !== undefined && ctx[k] !== null ? String(ctx[k]) : '');
}

/**
 * Determina qual etapa da régua se aplica AGORA para uma conta vencida,
 * considerando limitePorDia e último envio.
 *
 * @returns {number|null} Número da etapa a disparar, ou null se nada a fazer.
 */
function etapaAplicavel(db, conta, regua, limitePorDia) {
  const dias = diffDiasVencimento(conta.dataVencimento);
  if (dias < 1) return null;

  // Maior etapa cujo diasApos <= dias (régua ordenada)
  const etapasAtivas = regua.filter(e => e.canais && e.canais.length > 0);
  const candidata = etapasAtivas.slice().reverse().find(e => dias >= e.diasApos);
  if (!candidata) return null;

  // COB-02 (2026-04-18): considera status 'fila' além de 'enviado' para evitar
  // re-disparo enquanto o envio anterior ainda não concluiu (pendente ou em re-tentativa).
  const jaEnviouEtapa = db.prepare(
    `SELECT 1 FROM cobrancas_log WHERE contaReceberId = ? AND etapa = ? AND status IN ('fila','enviado') LIMIT 1`
  ).get(conta.id, candidata.etapa);
  if (jaEnviouEtapa) return null;

  // Disparamos algo hoje para essa conta? (limitePorDia)
  if (limitePorDia) {
    const hoje = dataBrasilia();
    const hojeEnvios = db.prepare(
      `SELECT COUNT(*) as n FROM cobrancas_log WHERE contaReceberId = ? AND status IN ('fila','enviado') AND substr(dataEnvio, 1, 10) = ?`
    ).get(conta.id, hoje);
    if (hojeEnvios.n >= limitePorDia) return null;
  }

  return candidata.etapa;
}

function montarContexto(conta, pessoa, boleto) {
  const diasAtraso = diffDiasVencimento(conta.dataVencimento);
  return {
    nome: pessoa?.razaoSocial || '',
    nomeFantasia: pessoa?.nomeFantasia || pessoa?.razaoSocial || '',
    descricao: conta.descricao || '',
    valor: formatarValor(conta.valor),
    vencimento: formatarData(conta.dataVencimento),
    diasAtraso: String(diasAtraso),
    linhaDigitavel: boleto?.writableLine || '',
    linkBoleto: boleto?.externalUrl || '',
    nfseNumero: conta.nNFSe || '',
    contaId: String(conta.id),
  };
}

async function enviarEtapa(db, contaId, etapaNum, opts = {}) {
  const cfg = getConfig(db);
  const etapa = cfg.regua.find(e => e.etapa === etapaNum);
  if (!etapa) return { success: false, error: 'Etapa nao encontrada' };
  if (!etapa.canais || etapa.canais.length === 0) return { success: false, error: 'Etapa sem canais' };

  const conta = db.prepare(`
    SELECT cr.*, n.nNFSe
    FROM contas_a_receber cr
    LEFT JOIN nfse n ON n.id = cr.nfseId
    WHERE cr.id = ?
  `).get(contaId);
  if (!conta) return { success: false, error: 'Conta nao encontrada' };
  if (conta.status === 'paga' || conta.status === 'cancelada') {
    return { success: false, error: `Conta ${conta.status}` };
  }

  const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(conta.pessoaId);
  if (!pessoa) return { success: false, error: 'Pessoa nao encontrada' };
  if (pessoa.cobrancaAtiva === 0 && !opts.forcar) {
    return { success: false, error: 'Cobranca pausada para este cliente' };
  }

  const boleto = db.prepare(
    'SELECT writableLine, externalUrl FROM boletos WHERE contaReceberId = ? ORDER BY id DESC LIMIT 1'
  ).get(contaId);

  const ctx = montarContexto(conta, pessoa, boleto);
  const canaisSolicitados = opts.canais || etapa.canais;
  const resultados = {};

  for (const canal of canaisSolicitados) {
    if (canal === 'email') {
      if (!pessoa.email) {
        resultados.email = { success: false, error: 'Pessoa sem e-mail' };
        continue;
      }
      if (!loadSmtpConfig(db)) {
        resultados.email = { success: false, error: 'SMTP nao configurado' };
        continue;
      }
      const assunto = substituirVariaveis(etapa.assunto, ctx);
      const texto = substituirVariaveis(etapa.emailTexto, ctx);
      const cc = [pessoa.emailsAdicionais, cfg.ccInterno].filter(Boolean).join(', ') || undefined;

      // COB-01 (2026-04-18): INSERT antes do send para reservar a tentativa. Se
      // o processo cair entre envio e UPDATE, a linha fica em 'fila' e o
      // etapaAplicavel bloqueia re-disparo (idempotência de envio).
      const reservaId = db.prepare(`INSERT INTO cobrancas_log
        (contaReceberId, pessoaId, etapa, canal, destinatario, assunto, mensagem, status, origem)
        VALUES (?, ?, ?, 'email', ?, ?, ?, 'fila', ?)`
      ).run(contaId, pessoa.id, etapaNum, pessoa.email, assunto, texto, opts.origem || 'manual').lastInsertRowid;
      try {
        await enviarEmailCobranca(db, {
          to: pessoa.email, cc, assunto, texto,
          valor: conta.valor,
          boletoWritableLine: boleto?.writableLine,
          boletoUrl: boleto?.externalUrl,
        });
        db.prepare(`UPDATE cobrancas_log SET status='enviado' WHERE id = ?`).run(reservaId);
        resultados.email = { success: true };
      } catch (err) {
        db.prepare(`UPDATE cobrancas_log SET status='erro', erro=? WHERE id = ?`).run(err.message, reservaId);
        resultados.email = { success: false, error: err.message };
      }
    } else if (canal === 'whatsapp') {
      if (!pessoa.telefone) {
        resultados.whatsapp = { success: false, error: 'Pessoa sem telefone' };
        continue;
      }
      const texto = substituirVariaveis(etapa.whatsappTexto, ctx);
      // COB-01: reserva a linha em 'fila' antes do disparo para idempotência.
      const reservaWaId = db.prepare(`INSERT INTO cobrancas_log
        (contaReceberId, pessoaId, etapa, canal, destinatario, assunto, mensagem, status, origem)
        VALUES (?, ?, ?, 'whatsapp', ?, ?, ?, 'fila', ?)`
      ).run(contaId, pessoa.id, etapaNum, pessoa.telefone, null, texto, opts.origem || 'manual').lastInsertRowid;
      try {
        const r = await enviarWhatsApp(db, { telefone: pessoa.telefone, texto });
        const status = r.success ? 'enviado' : (r.queued ? 'fila' : 'erro');
        db.prepare(`UPDATE cobrancas_log SET status=?, erro=? WHERE id = ?`)
          .run(status, r.error || null, reservaWaId);
        resultados.whatsapp = r;
      } catch (err) {
        db.prepare(`UPDATE cobrancas_log SET status='erro', erro=? WHERE id = ?`).run(err.message, reservaWaId);
        resultados.whatsapp = { success: false, error: err.message };
      }
    }
  }

  return { success: true, etapa: etapaNum, canais: resultados };
}

/**
 * Processa a régua para todas as contas vencidas hoje.
 * Usado pelo scheduler diário e pelo botão "Executar agora".
 */
async function executarRegua(db, opts = {}) {
  const cfg = getConfig(db);
  const dryRun = opts.dryRun === true;

  const contas = db.prepare(`
    SELECT cr.*, p.razaoSocial, p.email, p.telefone, p.cobrancaAtiva
    FROM contas_a_receber cr
    JOIN pessoas p ON p.id = cr.pessoaId
    WHERE cr.status = 'aberta' AND cr.dataVencimento < ?
    ORDER BY cr.dataVencimento ASC
  `).all(dataBrasilia());

  const resultados = [];
  for (const conta of contas) {
    if (conta.cobrancaAtiva === 0) continue;
    const etapa = etapaAplicavel(db, conta, cfg.regua, cfg.limitePorDia);
    if (!etapa) continue;

    if (dryRun) {
      resultados.push({ contaId: conta.id, pessoa: conta.razaoSocial, valor: conta.valor, vencimento: conta.dataVencimento, etapa });
    } else {
      const r = await enviarEtapa(db, conta.id, etapa, { origem: 'regua' });
      resultados.push({ contaId: conta.id, pessoa: conta.razaoSocial, ...r });
    }
  }

  return { total: resultados.length, dryRun, resultados };
}

// ==================== REGISTRO DE ROTAS ====================

function registrarRotasCobrancas(app, db) {
  migrarDB(db);

  app.get('/api/cobrancas/contas-vencidas', (req, res) => {
    try {
      const { busca, minDias, maxDias } = req.query;
      const hoje = dataBrasilia();

      let sql = `
        SELECT cr.id, cr.descricao, cr.valor, cr.dataVencimento, cr.status, cr.pessoaId, cr.nfseId,
          p.razaoSocial, p.email, p.telefone, p.cobrancaAtiva,
          n.nNFSe,
          b.writableLine, b.externalUrl,
          (SELECT MAX(etapa) FROM cobrancas_log WHERE contaReceberId = cr.id AND status = 'enviado') AS ultimaEtapa,
          (SELECT MAX(dataEnvio) FROM cobrancas_log WHERE contaReceberId = cr.id AND status = 'enviado') AS ultimoEnvio,
          (SELECT COUNT(*) FROM cobrancas_log WHERE contaReceberId = cr.id AND status = 'enviado') AS totalEnvios
        FROM contas_a_receber cr
        JOIN pessoas p ON p.id = cr.pessoaId
        LEFT JOIN nfse n ON n.id = cr.nfseId
        LEFT JOIN boletos b ON b.id = (SELECT MAX(id) FROM boletos WHERE contaReceberId = cr.id)
        WHERE cr.status = 'aberta' AND cr.dataVencimento < ?
      `;
      const params = [hoje];

      if (busca) {
        sql += ' AND (p.razaoSocial LIKE ? OR cr.descricao LIKE ?)';
        params.push('%' + busca + '%', '%' + busca + '%');
      }

      sql += ' ORDER BY cr.dataVencimento ASC';

      const rows = db.prepare(sql).all(...params);
      const contas = rows.map(r => ({
        ...r,
        diasAtraso: diffDiasVencimento(r.dataVencimento),
      })).filter(r => {
        if (minDias !== undefined && r.diasAtraso < Number(minDias)) return false;
        if (maxDias !== undefined && r.diasAtraso > Number(maxDias)) return false;
        return true;
      });

      const totalValor = contas.reduce((s, c) => s + (c.valor || 0), 0);
      res.json({ success: true, contas, resumo: { total: contas.length, totalValor } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cobrancas/enviar/:contaId', async (req, res) => {
    try {
      const etapa = Number(req.body?.etapa);
      const canais = req.body?.canais; // opcional: subset de ['email','whatsapp']
      if (!etapa) return res.status(400).json({ success: false, error: 'etapa obrigatoria' });
      const r = await enviarEtapa(db, Number(req.params.contaId), etapa, {
        canais, origem: 'manual', forcar: !!req.body?.forcar,
      });
      res.json(r);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cobrancas/enviar-massa', async (req, res) => {
    try {
      const { contas, etapa, canais, forcar } = req.body || {};
      if (!Array.isArray(contas) || !contas.length) return res.status(400).json({ success: false, error: 'contas: array vazio' });
      const resultados = [];
      for (const contaId of contas) {
        // Se etapa nao for informada, usa a aplicavel
        const cfg = getConfig(db);
        const row = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(contaId);
        const etapaUsar = etapa || (row ? etapaAplicavel(db, row, cfg.regua, 0) : null);
        if (!etapaUsar) {
          resultados.push({ contaId, success: false, error: 'Nenhuma etapa aplicavel' });
          continue;
        }
        const r = await enviarEtapa(db, contaId, etapaUsar, { canais, forcar: !!forcar, origem: 'massa' });
        resultados.push({ contaId, etapa: etapaUsar, ...r });
      }
      res.json({ success: true, total: resultados.length, resultados });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cobrancas/executar-regua', async (req, res) => {
    try {
      const r = await executarRegua(db, { dryRun: !!req.body?.dryRun });
      res.json({ success: true, ...r });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/cobrancas/config', (req, res) => {
    try {
      res.json({ success: true, config: getConfig(db) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cobrancas/config', (req, res) => {
    try {
      const atual = getConfig(db);
      const novo = { ...atual, ...req.body };
      if (!Array.isArray(novo.regua) || novo.regua.length === 0) {
        return res.status(400).json({ success: false, error: 'regua invalida' });
      }
      setConfig(db, novo);
      res.json({ success: true, config: novo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/cobrancas/log', (req, res) => {
    try {
      const { contaId, busca, canal, status, limite } = req.query;
      const lim = Math.min(parseInt(limite) || 200, 1000);

      let sql = `
        SELECT l.*, p.razaoSocial, cr.descricao AS contaDescricao, cr.valor AS contaValor
        FROM cobrancas_log l
        JOIN pessoas p ON p.id = l.pessoaId
        JOIN contas_a_receber cr ON cr.id = l.contaReceberId
        WHERE 1=1
      `;
      const params = [];
      if (contaId) { sql += ' AND l.contaReceberId = ?'; params.push(contaId); }
      if (canal)   { sql += ' AND l.canal = ?';          params.push(canal); }
      if (status)  { sql += ' AND l.status = ?';         params.push(status); }
      if (busca)   { sql += ' AND (p.razaoSocial LIKE ? OR cr.descricao LIKE ?)'; params.push('%'+busca+'%', '%'+busca+'%'); }
      sql += ' ORDER BY l.id DESC LIMIT ?';
      params.push(lim);

      const logs = db.prepare(sql).all(...params);
      res.json({ success: true, logs, total: logs.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cobrancas/pessoa/:id/pausar', (req, res) => {
    try {
      const ativo = req.body?.ativa === true ? 1 : 0;
      db.prepare('UPDATE pessoas SET cobrancaAtiva = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(ativo, req.params.id);
      res.json({ success: true, cobrancaAtiva: ativo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[Cobrancas] Rotas registradas');
}

module.exports = { registrarRotasCobrancas, executarRegua, enviarEtapa, getConfig, migrarDB, isDiaUtil, dataBrasilia };
