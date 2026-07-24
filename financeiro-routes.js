/**
 * financeiro-routes.js — Rotas para Pessoas, Contas a Receber, Boletos e MercadoPago Config
 *
 * Uso no server.js:
 *   const { registrarRotasFinanceiro } = require('./financeiro-routes');
 *   registrarRotasFinanceiro(app, db);
 */

const { MercadoPagoClient, loadMPConfig } = require('./mercadopago-client');
const { lancarMovimentacao, getContaMercadoPago } = require('./contas-financeiras-routes');
const { registrarBaixaCR } = require('./contas-receber-routes');

// ==================== MIGRAÇÃO ====================

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pessoas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cpfCnpj TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'PJ',
      razaoSocial TEXT NOT NULL,
      nomeFantasia TEXT,
      inscricaoMunicipal TEXT,
      endereco TEXT, numero TEXT, complemento TEXT, bairro TEXT,
      codigoMunicipio TEXT, cidade TEXT, uf TEXT, cep TEXT,
      telefone TEXT, email TEXT, observacoes TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pessoas_cpfcnpj ON pessoas(cpfCnpj);

    CREATE TABLE IF NOT EXISTS contas_a_receber (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pessoaId INTEGER NOT NULL,
      nfseId INTEGER,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL,
      dataEmissao TEXT NOT NULL,
      dataVencimento TEXT NOT NULL,
      dataPagamento TEXT,
      valorPago REAL,
      status TEXT DEFAULT 'aberta',
      formaPagamento TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id),
      FOREIGN KEY (nfseId) REFERENCES nfse(id)
    );

    CREATE TABLE IF NOT EXISTS boletos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaReceberId INTEGER NOT NULL,
      mpId TEXT,
      barcode TEXT,
      writableLine TEXT,
      externalUrl TEXT,
      amount INTEGER NOT NULL,
      expirationDate TEXT NOT NULL,
      status TEXT DEFAULT 'pendente',
      customerDocument TEXT NOT NULL,
      customerName TEXT NOT NULL,
      mpResponse TEXT,
      webhookPayload TEXT,
      erroMensagem TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaReceberId) REFERENCES contas_a_receber(id)
    );

    CREATE TABLE IF NOT EXISTS mp_config (key TEXT PRIMARY KEY, value TEXT);
  `);

  // Vincula CR à fatura e permite múltiplas CRs por fatura (parcelamento misto)
  try { db.exec(`ALTER TABLE contas_a_receber ADD COLUMN faturaId INTEGER`); } catch { /* ja existe */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_cr_fatura ON contas_a_receber(faturaId)`); } catch {}

  // Migrar colunas se tabela boletos ja existia com schema Stone
  try {
    db.exec(`ALTER TABLE boletos ADD COLUMN mpId TEXT`);
  } catch { /* ja existe */ }
  try {
    db.exec(`ALTER TABLE boletos ADD COLUMN externalUrl TEXT`);
  } catch { /* ja existe */ }
  try {
    db.exec(`ALTER TABLE boletos ADD COLUMN mpResponse TEXT`);
  } catch { /* ja existe */ }

  // Migrar: campo emailsAdicionais em pessoas (CC para envio de email)
  try {
    db.exec(`ALTER TABLE pessoas ADD COLUMN emailsAdicionais TEXT`);
  } catch { /* ja existe */ }

  // Migrar: Inscrição Estadual do destinatário (essencial para NF-e B2B —
  // indIEDest=1 exige IE informada). Adicionada 2026-04-23.
  try {
    db.exec(`ALTER TABLE pessoas ADD COLUMN inscricaoEstadual TEXT`);
  } catch { /* ja existe */ }

  // Defaults mp_config
  const upsert = db.prepare('INSERT OR IGNORE INTO mp_config (key, value) VALUES (?, ?)');
  upsert.run('access_token', '');
}

// ==================== HELPERS ====================

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function detectarTipoPessoa(cpfCnpj) {
  const nums = (cpfCnpj || '').replace(/\D/g, '');
  return nums.length <= 11 ? 'PF' : 'PJ';
}

// Resolve o provedor de boleto da CR/conta financeira (orquestrador).
// Retorna { provedor, modulo, cfg, contaFinanceiraId } ou null se não houver config ativa.
function resolverProvedorBoleto(db, contaReceberId) {
  const provedores = require('./boleto-provedores');
  const orch = require('./boleto-orchestrator');
  const cr = db.prepare('SELECT contaFinanceiraId FROM contas_a_receber WHERE id = ?').get(contaReceberId);
  let contaFinId = cr?.contaFinanceiraId;
  if (!contaFinId) contaFinId = orch.getContaFinanceiraPadraoBoleto(db);
  if (!contaFinId) return null;
  const row = db.prepare('SELECT * FROM contas_financeiras_boleto WHERE contaFinanceiraId = ? AND ativo = 1').get(contaFinId);
  if (!row) return null;
  const modulo = provedores.get(row.provedor);
  if (!modulo) return null;
  return { modulo, cfg: orch._internal.parseConfigJson(row), contaFinanceiraId: contaFinId };
}

async function emitirBoletoMP(db, boleto, pessoa, throwOnError = false) {
  // 1. Tenta via registry de provedores (MP, Sicredi, etc. configurados na conta financeira)
  const resolvido = resolverProvedorBoleto(db, boleto.contaReceberId);
  const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(boleto.contaReceberId);
  let nfseNumero = '';
  let competencia = '';
  if (conta?.nfseId) {
    const nfse = db.prepare('SELECT nNFSe, dataCompetencia FROM nfse WHERE id = ?').get(conta.nfseId);
    if (nfse) { nfseNumero = nfse.nNFSe || ''; competencia = nfse.dataCompetencia || ''; }
  }

  if (resolvido) {
    try {
      const { _internal } = require('./boleto-orchestrator');
      const nossoNumero = _internal.consumirProximoNossoNumero(db, resolvido.contaFinanceiraId);
      const payload = {
        valor: boleto.amount / 100,
        dataVencimento: boleto.expirationDate,
        nossoNumero: String(nossoNumero),
        seuNumero: `CR-${boleto.contaReceberId}`,
        descricao: conta?.descricao || 'Boleto',
        pagador: {
          documento: pessoa?.cpfCnpj || boleto.customerDocument,
          nome: pessoa?.razaoSocial || boleto.customerName,
          email: pessoa?.email,
          endereco: pessoa ? { cep: pessoa.cep, logradouro: pessoa.endereco, numero: pessoa.numero, bairro: pessoa.bairro, cidade: pessoa.cidade, uf: pessoa.uf } : {},
        },
        referencia: { nfseNumero, competencia },
      };
      const resp = await resolvido.modulo.criarBoleto(db, resolvido.cfg, payload);
      db.prepare(`UPDATE boletos SET
        provedor = ?, contaFinanceiraId = ?, nossoNumero = ?,
        mpId = ?, barcode = ?, writableLine = ?, linhaDigitavel = ?, externalUrl = ?,
        status = 'registrado', mpResponse = ?, erroMensagem = NULL, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`
      ).run(
        resolvido.modulo.nome, resolvido.contaFinanceiraId, resp.nossoNumero,
        resp.nossoNumero, resp.codigoBarras, resp.linhaDigitavel, resp.linhaDigitavel, resp.urlBoleto,
        JSON.stringify(resp.raw || { nossoNumero: resp.nossoNumero }), boleto.id
      );
      return { id: resp.nossoNumero, barcode: resp.codigoBarras, writable_line: resp.linhaDigitavel, external_resource_url: resp.urlBoleto, raw: resp };
    } catch (err) {
      console.error(`[Financeiro] Erro provedor ${resolvido.modulo.nome}:`, err.message);
      db.prepare('UPDATE boletos SET status = \'erro\', erroMensagem = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
        .run(err.message, boleto.id);
      if (throwOnError) throw err;
      return null;
    }
  }

  // 2. Fallback legado: mp_config global (compatibilidade com instalações sem registry configurado)
  const mpConfig = loadMPConfig(db);
  if (!mpConfig) {
    if (throwOnError) throw new Error('Nenhum provedor de boleto configurado. Configure em Contas Financeiras → Emissão de Boletos.');
    return null;
  }

  try {
    const client = new MercadoPagoClient(mpConfig);

    const resp = await client.criarBoleto({
      amount: boleto.amount / 100, // centavos -> reais
      description: conta?.descricao || 'Boleto',
      expirationDate: boleto.expirationDate,
      customerDocument: pessoa?.cpfCnpj || boleto.customerDocument,
      customerName: pessoa?.razaoSocial || boleto.customerName,
      customerEmail: pessoa?.email,
      address: pessoa ? { cep: pessoa.cep, endereco: pessoa.endereco, numero: pessoa.numero, bairro: pessoa.bairro, cidade: pessoa.cidade, uf: pessoa.uf } : null,
      nfseNumero, competencia,
    });

    db.prepare(`UPDATE boletos SET provedor = 'mercadopago', mpId = ?, barcode = ?, writableLine = ?, linhaDigitavel = ?, externalUrl = ?,
      status = 'registrado', mpResponse = ?, erroMensagem = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(resp.id, resp.barcode, resp.writable_line, resp.writable_line, resp.external_resource_url, JSON.stringify(resp.raw), boleto.id);

    return resp;
  } catch (err) {
    console.error('[Financeiro] Erro MercadoPago ao criar boleto:', err.message);
    db.prepare('UPDATE boletos SET status = \'erro\', erroMensagem = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
      .run(err.message, boleto.id);
    if (throwOnError) throw err;
    return null;
  }
}

// ==================== REGISTRO DE ROTAS ====================

// Envia o boleto (linha digitável + link) ao e-mail do cliente. Best-effort.
// Reutilizado pela geração (auto) e pelo reenvio manual. Retorna {ok, to, motivo}.
async function enviarBoletoAoCliente(db, boletoId, toOverride) {
  const boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);
  if (!boleto) return { ok: false, motivo: 'Boleto não encontrado' };
  if (boleto.status !== 'registrado') return { ok: false, motivo: 'Boleto não está registrado' };
  const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(boleto.contaReceberId);
  const pessoa = db.prepare(
    'SELECT p.* FROM pessoas p JOIN contas_a_receber c ON c.pessoaId = p.id WHERE c.id = ?'
  ).get(boleto.contaReceberId);
  const to = (toOverride || (pessoa && pessoa.email) || '').trim();
  if (!to) return { ok: false, motivo: 'Cliente não possui email cadastrado' };
  const { enviarEmailBoleto, loadSmtpConfig } = require('./email-client');
  if (!loadSmtpConfig(db)) return { ok: false, motivo: 'SMTP não configurado' };
  await enviarEmailBoleto(db, {
    to,
    descricao: (conta && conta.descricao) || 'Cobrança',
    valor: (boleto.amount / 100).toFixed(2),
    vencimento: boleto.expirationDate,
    clienteNome: pessoa && pessoa.razaoSocial,
    boletoWritableLine: boleto.writableLine,
    boletoUrl: boleto.externalUrl,
  });
  return { ok: true, to };
}

// Gera o boleto de uma CR (se ainda não houver) e o envia ao cliente. Idempotente
// (pula se já existe boleto ativo). Usado no auto-boleto ao faturar. {ok, boletoId, envio, motivo}.
async function gerarEEnviarBoletoParaCR(db, contaReceberId) {
  const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(contaReceberId);
  if (!conta || conta.status !== 'aberta') return { ok: false, motivo: 'Conta não está aberta' };
  const jaTem = db.prepare(
    "SELECT id FROM boletos WHERE contaReceberId = ? AND status IN ('pendente','registrado') LIMIT 1"
  ).get(contaReceberId);
  if (jaTem) return { ok: false, motivo: 'Boleto ativo já existe' };
  const { emitirBoletoParaCR } = require('./boleto-orchestrator');
  const r = await emitirBoletoParaCR(db, contaReceberId);
  if (r && r.skipped) return { ok: false, motivo: r.motivo || 'Sem provedor de boleto ativo' };
  if (!r || !r.sucesso) return { ok: false, motivo: 'Falha ao emitir boleto' };
  db.prepare("UPDATE contas_a_receber SET formaPagamento = 'boleto', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(contaReceberId);
  let envio = null;
  try { envio = await enviarBoletoAoCliente(db, r.boletoId); }
  catch (e) { envio = { ok: false, motivo: e.message }; }
  return { ok: true, boletoId: r.boletoId, envio };
}

// Envia a cobrança PIX (QR + copia-e-cola + link) ao e-mail do cliente. Best-effort.
async function enviarPixAoCliente(db, cobrancaId, toOverride) {
  const cob = db.prepare('SELECT * FROM boletos WHERE id = ?').get(cobrancaId);
  if (!cob) return { ok: false, motivo: 'Cobrança não encontrada' };
  if (cob.status !== 'registrado') return { ok: false, motivo: 'Cobrança não está registrada' };
  const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(cob.contaReceberId);
  const pessoa = db.prepare(
    'SELECT p.* FROM pessoas p JOIN contas_a_receber c ON c.pessoaId = p.id WHERE c.id = ?'
  ).get(cob.contaReceberId);
  const descricao = (conta && conta.descricao) || 'Cobrança PIX';
  const valorFmt = 'R$ ' + Number((cob.amount / 100).toFixed(2)).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  const canais = {};
  let ok = false;

  // WhatsApp (preferencial) — enfileira link + copia-e-cola quando há telefone.
  if (pessoa && pessoa.telefone) {
    try {
      const { enviarWhatsApp } = require('./whatsapp-adapter');
      const partes = [`Cobrança PIX - ${descricao} - ${valorFmt}.`];
      if (cob.externalUrl) partes.push('', 'Link de pagamento: ' + cob.externalUrl);
      if (cob.pixPayload) partes.push('', 'PIX copia e cola:', cob.pixPayload);
      canais.whatsapp = await enviarWhatsApp(db, { telefone: pessoa.telefone, texto: partes.join('\n') });
      if (canais.whatsapp && (canais.whatsapp.success || canais.whatsapp.queued)) ok = true;
    } catch (e) { canais.whatsapp = { error: e.message }; }
  }

  // E-mail (registro + QR inline) — quando há e-mail e SMTP configurado.
  const to = (toOverride || (pessoa && pessoa.email) || '').trim();
  if (to) {
    try {
      const { enviarEmailPix, loadSmtpConfig } = require('./email-client');
      if (loadSmtpConfig(db)) {
        await enviarEmailPix(db, {
          to, descricao, valor: (cob.amount / 100).toFixed(2), vencimento: cob.expirationDate,
          clienteNome: pessoa && pessoa.razaoSocial, pixPayload: cob.pixPayload,
          pixQrImage: cob.pixQrImage, pixUrl: cob.externalUrl,
        });
        canais.email = { to };
        ok = true;
      } else {
        canais.email = { error: 'SMTP não configurado' };
      }
    } catch (e) { canais.email = { error: e.message }; }
  }

  if (!ok) return { ok: false, motivo: 'Cliente sem WhatsApp/e-mail cadastrado (ou falha no envio)', canais };
  return { ok: true, to: to || undefined, canais };
}

// Gera a cobrança PIX de uma CR (se ainda não houver) e a envia. Idempotente.
async function gerarEEnviarPixParaCR(db, contaReceberId) {
  const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(contaReceberId);
  if (!conta || conta.status !== 'aberta') return { ok: false, motivo: 'Conta não está aberta' };
  const jaTem = db.prepare(
    "SELECT id FROM boletos WHERE contaReceberId = ? AND status IN ('pendente','registrado') LIMIT 1"
  ).get(contaReceberId);
  if (jaTem) return { ok: false, motivo: 'Cobrança ativa já existe' };
  const { emitirCobrancaPixParaCR } = require('./boleto-orchestrator');
  const r = await emitirCobrancaPixParaCR(db, contaReceberId);
  if (r && r.skipped) return { ok: false, motivo: r.motivo || 'Sem provedor PIX ativo' };
  if (!r || !r.sucesso) return { ok: false, motivo: 'Falha ao emitir cobrança PIX' };
  db.prepare("UPDATE contas_a_receber SET formaPagamento = 'pix', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(contaReceberId);
  let envio = null;
  try { envio = await enviarPixAoCliente(db, r.boletoId); }
  catch (e) { envio = { ok: false, motivo: e.message }; }
  return { ok: true, boletoId: r.boletoId, envio };
}

function registrarRotasFinanceiro(app, db) {
  migrarDB(db);

  // ==================== CONSULTA CNPJ (proxy BrasilAPI) ====================
  // Proxy backend pra evitar bloqueio de CORS no Cloudflare quando o navegador
  // do cliente bate na BrasilAPI direto (Bot Fight Mode / rate limit por IP
  // residencial retornam respostas sem o header Access-Control-Allow-Origin).
  app.get('/api/cnpj/:cnpj', async (req, res) => {
    const cnpj = String(req.params.cnpj || '').replace(/\D/g, '');
    if (cnpj.length !== 14) {
      return res.status(400).json({ success: false, error: 'CNPJ deve ter 14 dígitos' });
    }
    try {
      const upstream = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + cnpj, {
        headers: { 'User-Agent': 'liciteagora/1.0' }
      });
      const text = await upstream.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { message: text }; }
      if (!upstream.ok) {
        return res.status(upstream.status).json({
          success: false,
          error: body.message || `BrasilAPI ${upstream.status}`
        });
      }
      res.json({ success: true, data: body });
    } catch (err) {
      console.error('[/api/cnpj]', err.message);
      res.status(502).json({ success: false, error: 'Falha ao consultar BrasilAPI: ' + err.message });
    }
  });

  // ==================== PESSOAS ====================

  app.get('/api/pessoas', (req, res) => {
    try {
      const { q, ativo } = req.query;
      let sql = 'SELECT * FROM pessoas WHERE 1=1';
      const params = [];

      if (ativo !== undefined) {
        sql += ' AND ativo = ?';
        params.push(Number(ativo));
      } else {
        sql += ' AND ativo = 1';
      }

      if (q) {
        sql += ' AND (cpfCnpj LIKE ? OR razaoSocial LIKE ? OR nomeFantasia LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like);
      }

      sql += ' ORDER BY razaoSocial ASC';
      const pessoas = db.prepare(sql).all(...params);
      res.json({ success: true, pessoas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/pessoas/autocomplete', (req, res) => {
    try {
      const q = req.query.q || '';
      if (q.length < 2) return res.json({ success: true, pessoas: [] });

      const like = `%${q}%`;
      const pessoas = db.prepare(
        `SELECT id, cpfCnpj, tipo, razaoSocial, nomeFantasia, inscricaoMunicipal,
                endereco, numero, complemento, bairro, codigoMunicipio, cidade, uf, cep, telefone, email
         FROM pessoas WHERE ativo = 1 AND (cpfCnpj LIKE ? OR razaoSocial LIKE ? OR nomeFantasia LIKE ?)
         ORDER BY razaoSocial ASC LIMIT 10`
      ).all(like, like, like);

      res.json({ success: true, pessoas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/pessoas/:id', (req, res) => {
    try {
      const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(req.params.id);
      if (!pessoa) return res.status(404).json({ success: false, error: 'Pessoa nao encontrada' });
      res.json({ success: true, pessoa });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Campos escalares aceitos em POST/PUT. `cpfCnpj` e `tipo` são tratados
  // à parte (cpfCnpj é a chave de dedupe, tipo é derivado do tamanho).
  // Campos booleanos vão como 0/1; JSON arrays (categorias, tags) são
  // normalizados antes de gravar.
  const PESSOAS_CAMPOS = [
    'razaoSocial', 'nomeFantasia', 'inscricaoMunicipal', 'inscricaoEstadual',
    'indicadorIE', 'suframa',
    'cnaePrincipal', 'cnaeDescricao',
    'naturezaJuridicaCodigo', 'naturezaJuridicaDescricao',
    'porte', 'regimeTributario', 'optanteSimples',
    'dataAberturaNascimento', 'capitalSocial',
    'situacaoCadastralReceita', 'dataUltimaConsultaReceita', 'logo',
    'endereco', 'numero', 'complemento', 'bairro',
    'codigoMunicipio', 'cidade', 'uf', 'cep',
    'telefone', 'email', 'emailsAdicionais', 'observacoes',
    'contribuinteIcms', 'cobrancaAtiva',
    // PF
    'rg', 'rgOrgaoEmissor', 'rgDataExpedicao', 'dataNascimento',
    'sexo', 'estadoCivil', 'profissao', 'nomeMae', 'nomePai', 'nacionalidade',
    // Comercial
    'categorias', 'origem', 'vendedorId', 'tabelaPrecoId',
    'limiteCredito', 'prazoMedioDias', 'condicaoPagamentoPadrao', 'tags',
    // LGPD
    'lgpdConsentimento', 'lgpdDataConsentimento', 'lgpdFonte',
    'aceitaEmailMarketing', 'aceitaWhatsappMarketing',
    // Admin
    'dataInativacao', 'motivoInativacao',
  ];
  const PESSOAS_CAMPOS_BOOL = new Set([
    'optanteSimples', 'contribuinteIcms', 'cobrancaAtiva',
    'lgpdConsentimento', 'aceitaEmailMarketing', 'aceitaWhatsappMarketing',
  ]);
  const PESSOAS_CAMPOS_JSON = new Set(['categorias', 'tags']);

  function normalizarPessoaPayload(body) {
    const out = {};
    for (const k of PESSOAS_CAMPOS) {
      if (!(k in body)) continue;
      let v = body[k];
      if (v === '' || v === undefined) v = null;
      if (PESSOAS_CAMPOS_BOOL.has(k)) v = v ? 1 : 0;
      if (PESSOAS_CAMPOS_JSON.has(k) && v != null && typeof v !== 'string') {
        try { v = JSON.stringify(v); } catch { v = null; }
      }
      out[k] = v;
    }
    return out;
  }

  app.post('/api/pessoas', (req, res) => {
    try {
      const { cpfCnpj, razaoSocial } = req.body;
      if (!cpfCnpj || !razaoSocial) {
        return res.status(400).json({ success: false, error: 'CPF/CNPJ e Razao Social sao obrigatorios' });
      }

      const cpfLimpo = cpfCnpj.replace(/\D/g, '');
      const tipo = detectarTipoPessoa(cpfLimpo);
      const dados = normalizarPessoaPayload(req.body);

      const existente = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(cpfLimpo);
      if (existente) {
        if (!existente.ativo) {
          // reativa e atualiza
          const campos = Object.keys(dados);
          const setSql = campos.map(c => `${c} = ?`).join(', ');
          const valores = campos.map(c => dados[c]);
          db.prepare(
            `UPDATE pessoas SET ativo = 1, tipo = ?, ${setSql}, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
          ).run(tipo, ...valores, existente.id);
          const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(existente.id);
          return res.json({ success: true, pessoa, reativada: true });
        }
        return res.status(409).json({ success: false, error: 'Pessoa ja cadastrada com este CPF/CNPJ', pessoa: existente });
      }

      // INSERT dinâmico
      const campos = ['cpfCnpj', 'tipo', ...Object.keys(dados)];
      const placeholders = campos.map(() => '?').join(', ');
      const valores = [cpfLimpo, tipo, ...Object.keys(dados).map(c => dados[c])];
      const result = db.prepare(
        `INSERT INTO pessoas (${campos.join(', ')}) VALUES (${placeholders})`
      ).run(...valores);

      const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, pessoa });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/pessoas/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Pessoa nao encontrada' });

      const dados = normalizarPessoaPayload(req.body);
      if (Object.keys(dados).length === 0) {
        return res.json({ success: true, pessoa: existing, skipped: true });
      }

      const setSql = Object.keys(dados).map(c => `${c} = ?`).join(', ');
      const valores = Object.keys(dados).map(c => dados[c]);
      db.prepare(
        `UPDATE pessoas SET ${setSql}, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(...valores, req.params.id);

      const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(req.params.id);
      res.json({ success: true, pessoa });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/pessoas/:id', (req, res) => {
    try {
      const motivo = req.body?.motivo || null;
      const result = db.prepare(`UPDATE pessoas SET ativo = 0,
        dataInativacao = CURRENT_TIMESTAMP, motivoInativacao = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ? AND ativo = 1`
      ).run(motivo, req.params.id);
      if (result.changes === 0) return res.status(404).json({ success: false, error: 'Pessoa nao encontrada' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== PESSOAS: Contatos múltiplos ====================

  app.get('/api/pessoas/:id/contatos', (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT * FROM pessoas_contatos WHERE pessoaId = ? AND ativo = 1 ORDER BY principal DESC, nome ASC`
      ).all(req.params.id);
      res.json({ success: true, contatos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/pessoas/:id/contatos', (req, res) => {
    try {
      const { nome, cargo, area, telefone, celular, email, whatsapp, principal, observacoes } = req.body;
      if (!nome) return res.status(400).json({ success: false, error: 'Nome obrigatório' });
      const r = db.prepare(
        `INSERT INTO pessoas_contatos (pessoaId, nome, cargo, area, telefone, celular, email, whatsapp, principal, observacoes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(req.params.id, nome, cargo || null, area || null, telefone || null, celular || null,
            email || null, whatsapp || null, principal ? 1 : 0, observacoes || null);
      const contato = db.prepare('SELECT * FROM pessoas_contatos WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, contato });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/pessoas/:id/contatos/:contatoId', (req, res) => {
    try {
      const campos = ['nome','cargo','area','telefone','celular','email','whatsapp','principal','observacoes'];
      const sets = [], vals = [];
      for (const c of campos) {
        if (!(c in req.body)) continue;
        let v = req.body[c];
        if (v === '' || v === undefined) v = null;
        if (c === 'principal') v = v ? 1 : 0;
        sets.push(`${c} = ?`); vals.push(v);
      }
      if (!sets.length) return res.json({ success: true, skipped: true });
      vals.push(req.params.contatoId, req.params.id);
      db.prepare(`UPDATE pessoas_contatos SET ${sets.join(', ')}, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ? AND pessoaId = ?`).run(...vals);
      const contato = db.prepare('SELECT * FROM pessoas_contatos WHERE id = ?').get(req.params.contatoId);
      res.json({ success: true, contato });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/pessoas/:id/contatos/:contatoId', (req, res) => {
    try {
      db.prepare('UPDATE pessoas_contatos SET ativo = 0 WHERE id = ? AND pessoaId = ?')
        .run(req.params.contatoId, req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PESSOAS: Endereços adicionais ====================

  app.get('/api/pessoas/:id/enderecos', (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT * FROM pessoas_enderecos_adicionais WHERE pessoaId = ? AND ativo = 1 ORDER BY padrao DESC, id ASC`
      ).all(req.params.id);
      res.json({ success: true, enderecos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/pessoas/:id/enderecos', (req, res) => {
    try {
      const { tipo, apelido, endereco, numero, complemento, bairro, cidade, uf, cep,
              codigoMunicipio, pais, padrao } = req.body;
      if (!tipo) return res.status(400).json({ success: false, error: 'Tipo (entrega/cobranca/outro) obrigatório' });
      const r = db.prepare(
        `INSERT INTO pessoas_enderecos_adicionais
         (pessoaId, tipo, apelido, endereco, numero, complemento, bairro, cidade, uf, cep, codigoMunicipio, pais, padrao)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(req.params.id, tipo, apelido || null, endereco || null, numero || null,
            complemento || null, bairro || null, cidade || null, uf || null, cep || null,
            codigoMunicipio || null, pais || 'BR', padrao ? 1 : 0);
      const endr = db.prepare('SELECT * FROM pessoas_enderecos_adicionais WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, endereco: endr });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/pessoas/:id/enderecos/:enderecoId', (req, res) => {
    try {
      const campos = ['tipo','apelido','endereco','numero','complemento','bairro','cidade','uf','cep','codigoMunicipio','pais','padrao'];
      const sets = [], vals = [];
      for (const c of campos) {
        if (!(c in req.body)) continue;
        let v = req.body[c];
        if (v === '' || v === undefined) v = null;
        if (c === 'padrao') v = v ? 1 : 0;
        sets.push(`${c} = ?`); vals.push(v);
      }
      if (!sets.length) return res.json({ success: true, skipped: true });
      vals.push(req.params.enderecoId, req.params.id);
      db.prepare(`UPDATE pessoas_enderecos_adicionais SET ${sets.join(', ')} WHERE id = ? AND pessoaId = ?`).run(...vals);
      const endr = db.prepare('SELECT * FROM pessoas_enderecos_adicionais WHERE id = ?').get(req.params.enderecoId);
      res.json({ success: true, endereco: endr });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/pessoas/:id/enderecos/:enderecoId', (req, res) => {
    try {
      db.prepare('UPDATE pessoas_enderecos_adicionais SET ativo = 0 WHERE id = ? AND pessoaId = ?')
        .run(req.params.enderecoId, req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PESSOAS: Dados bancários + PIX ====================

  app.get('/api/pessoas/:id/dados-bancarios', (req, res) => {
    try {
      const rows = db.prepare(
        `SELECT * FROM pessoas_dados_bancarios WHERE pessoaId = ? AND ativo = 1 ORDER BY padrao DESC, id ASC`
      ).all(req.params.id);
      res.json({ success: true, contas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/pessoas/:id/dados-bancarios', (req, res) => {
    try {
      const { banco, codigoBanco, agencia, agenciaDv, conta, contaDv, tipoConta,
              titular, cpfCnpjTitular, chavePix, tipoChavePix, padrao, observacoes } = req.body;
      const r = db.prepare(
        `INSERT INTO pessoas_dados_bancarios
         (pessoaId, banco, codigoBanco, agencia, agenciaDv, conta, contaDv, tipoConta,
          titular, cpfCnpjTitular, chavePix, tipoChavePix, padrao, observacoes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(req.params.id, banco || null, codigoBanco || null, agencia || null, agenciaDv || null,
            conta || null, contaDv || null, tipoConta || null, titular || null,
            cpfCnpjTitular || null, chavePix || null, tipoChavePix || null,
            padrao ? 1 : 0, observacoes || null);
      const cb = db.prepare('SELECT * FROM pessoas_dados_bancarios WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, conta: cb });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/pessoas/:id/dados-bancarios/:contaId', (req, res) => {
    try {
      const campos = ['banco','codigoBanco','agencia','agenciaDv','conta','contaDv','tipoConta','titular','cpfCnpjTitular','chavePix','tipoChavePix','padrao','observacoes'];
      const sets = [], vals = [];
      for (const c of campos) {
        if (!(c in req.body)) continue;
        let v = req.body[c];
        if (v === '' || v === undefined) v = null;
        if (c === 'padrao') v = v ? 1 : 0;
        sets.push(`${c} = ?`); vals.push(v);
      }
      if (!sets.length) return res.json({ success: true, skipped: true });
      vals.push(req.params.contaId, req.params.id);
      db.prepare(`UPDATE pessoas_dados_bancarios SET ${sets.join(', ')} WHERE id = ? AND pessoaId = ?`).run(...vals);
      const cb = db.prepare('SELECT * FROM pessoas_dados_bancarios WHERE id = ?').get(req.params.contaId);
      res.json({ success: true, conta: cb });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/pessoas/:id/dados-bancarios/:contaId', (req, res) => {
    try {
      db.prepare('UPDATE pessoas_dados_bancarios SET ativo = 0 WHERE id = ? AND pessoaId = ?')
        .run(req.params.contaId, req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PESSOAS: Anexos (arquivos em disco) ====================

  const multer = require('multer');
  const path = require('path');
  const fs = require('fs');
  const PESSOAS_UPLOAD_ROOT = path.join(__dirname, 'public', 'uploads', 'pessoas');
  fs.mkdirSync(PESSOAS_UPLOAD_ROOT, { recursive: true });

  const uploadPessoa = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(PESSOAS_UPLOAD_ROOT, String(req.params.id));
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
        cb(null, `${Date.now()}-${safe}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  });

  app.get('/api/pessoas/:id/anexos', (req, res) => {
    try {
      const rows = db.prepare('SELECT id, nome, tipo, caminho, tamanhoBytes, mimeType, descricao, dataUpload FROM pessoas_anexos WHERE pessoaId = ? ORDER BY dataUpload DESC').all(req.params.id);
      res.json({ success: true, anexos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/pessoas/:id/anexos', uploadPessoa.single('arquivo'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado' });
      const caminho = `/uploads/pessoas/${req.params.id}/${req.file.filename}`;
      const r = db.prepare(
        `INSERT INTO pessoas_anexos (pessoaId, nome, tipo, caminho, tamanhoBytes, mimeType, descricao, uploadUserId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(req.params.id, req.file.originalname, req.body.tipo || null, caminho,
            req.file.size, req.file.mimetype, req.body.descricao || null,
            req.session?.userId || null);
      const anexo = db.prepare('SELECT * FROM pessoas_anexos WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, anexo });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/pessoas/:id/anexos/:anexoId', (req, res) => {
    try {
      const anexo = db.prepare('SELECT * FROM pessoas_anexos WHERE id = ? AND pessoaId = ?').get(req.params.anexoId, req.params.id);
      if (!anexo) return res.status(404).json({ success: false, error: 'Anexo não encontrado' });
      try {
        const filePath = path.join(__dirname, 'public', anexo.caminho);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (_) { /* arquivo pode já ter sido removido */ }
      db.prepare('DELETE FROM pessoas_anexos WHERE id = ?').run(req.params.anexoId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CONTAS A RECEBER — MOVIDO PARA contas-receber-routes.js ====================
  // Endpoints /api/contas-a-receber/** (listar, resumo, detalhe, criar, editar, baixar, cancelar, reabrir, duplicar, anexos, categorias)
  // foram extraídos para contas-receber-routes.js. Aqui continuam apenas os endpoints acoplados a
  // MercadoPago / boletos. O webhook e o polling usam registrarBaixaCR para registrar baixas.


  // Gerar novo boleto para conta existente — usa orquestrador (multi-provedor + split plataforma)
  app.post('/api/contas-a-receber/:id/gerar-boleto', async (req, res) => {
    try {
      const { emitirBoletoParaCR } = require('./boleto-orchestrator');

      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      if (conta.status !== 'aberta') return res.status(400).json({ success: false, error: 'Conta precisa estar aberta' });

      const boletoAtivo = db.prepare(`SELECT * FROM boletos WHERE contaReceberId = ? AND status IN ('pendente','registrado') ORDER BY id DESC LIMIT 1`).get(req.params.id);
      if (boletoAtivo) return res.status(400).json({ success: false, error: 'Ja existe boleto ativo para esta conta' });

      const r = await emitirBoletoParaCR(db, Number(req.params.id));
      if (r && r.skipped) return res.status(400).json({ success: false, error: r.motivo || 'Sem provedor de boleto ativo' });
      if (!r || !r.sucesso) return res.status(500).json({ success: false, error: 'Falha ao emitir boleto' });

      db.prepare(`UPDATE contas_a_receber SET formaPagamento = 'boleto', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);

      const boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(r.boletoId);

      // Envio automático do boleto ao cliente (best-effort — não bloqueia a resposta).
      enviarBoletoAoCliente(db, r.boletoId)
        .then(er => { if (!er.ok) console.log(`[Boleto][email] envio pulado boleto ${r.boletoId}: ${er.motivo}`); })
        .catch(e => console.error(`[Boleto][email] falha no envio automático boleto ${r.boletoId}:`, e.message));

      res.json({ success: true, boleto });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Gerar cobrança PIX (QR + link) para uma CR e enviar ao cliente
  app.post('/api/contas-a-receber/:id/gerar-pix', async (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      if (conta.status !== 'aberta') return res.status(400).json({ success: false, error: 'Conta precisa estar aberta' });
      const r = await gerarEEnviarPixParaCR(db, Number(req.params.id));
      if (!r.ok) return res.status(400).json({ success: false, error: r.motivo });
      const cobranca = db.prepare('SELECT * FROM boletos WHERE id = ?').get(r.boletoId);
      res.json({ success: true, cobranca, envio: r.envio });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Reenviar cobrança PIX ao cliente
  app.post('/api/cobrancas/:id/enviar-pix', async (req, res) => {
    try {
      const r = await enviarPixAoCliente(db, Number(req.params.id), (req.body && req.body.to) || undefined);
      if (!r.ok) return res.status(r.motivo === 'Cobrança não encontrada' ? 404 : 400).json({ success: false, error: r.motivo });
      res.json({ success: true, to: r.to, canais: r.canais });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== BOLETOS ====================

  // Emitir boleto no MercadoPago
  app.post('/api/boletos/:id/emitir', async (req, res) => {
    try {
      const boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(req.params.id);
      if (!boleto) return res.status(404).json({ success: false, error: 'Boleto nao encontrado' });
      if (boleto.status !== 'pendente' && boleto.status !== 'erro') {
        return res.status(400).json({ success: false, error: `Boleto com status "${boleto.status}" nao pode ser emitido` });
      }

      const mpConfig = loadMPConfig(db);
      if (!mpConfig) {
        return res.status(400).json({ success: false, error: 'MercadoPago nao configurado. Adicione o Access Token.' });
      }

      const pessoa = db.prepare(`
        SELECT p.* FROM pessoas p
        JOIN contas_a_receber c ON c.pessoaId = p.id
        JOIN boletos b ON b.contaReceberId = c.id
        WHERE b.id = ?
      `).get(req.params.id);

      const resp = await emitirBoletoMP(db, boleto, pessoa, true);

      const updated = db.prepare('SELECT * FROM boletos WHERE id = ?').get(req.params.id);
      res.json({ success: true, boleto: updated });
    } catch (err) {
      db.prepare(`UPDATE boletos SET status = 'erro', erroMensagem = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(err.message, req.params.id);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Consultar boleto no MercadoPago
  app.post('/api/boletos/:id/consultar', async (req, res) => {
    try {
      const boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(req.params.id);
      if (!boleto) return res.status(404).json({ success: false, error: 'Boleto nao encontrado' });
      if (!boleto.mpId) return res.status(400).json({ success: false, error: 'Boleto nao registrado no MercadoPago' });

      const mpConfig = loadMPConfig(db);
      if (!mpConfig) return res.status(400).json({ success: false, error: 'MercadoPago nao configurado' });

      const client = new MercadoPagoClient(mpConfig);
      const resp = await client.consultarBoleto(boleto.mpId);

      const newStatus = resp.status === 'approved' ? 'pago' :
                        resp.status === 'cancelled' ? 'cancelado' :
                        resp.status === 'rejected' ? 'rejeitado' : boleto.status;

      db.prepare(`UPDATE boletos SET status = ?, mpResponse = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(newStatus, JSON.stringify(resp), req.params.id);

      if (newStatus === 'pago' && boleto.contaReceberId) {
        const contaCR = db.prepare('SELECT status FROM contas_a_receber WHERE id = ?').get(boleto.contaReceberId);
        if (contaCR && contaCR.status !== 'paga' && contaCR.status !== 'cancelada') {
          const contaMP = getContaMercadoPago(db);
          if (contaMP) {
            try {
              registrarBaixaCR(db, {
                contaReceberId: boleto.contaReceberId,
                contaFinanceiraId: contaMP.id,
                formaPagamento: 'boleto',
                origem: 'boleto_mp',
                observacoes: `Baixa via consulta MP (boleto ${boleto.mpId})`
              });
            } catch (e) { console.error('[MP consultar] erro baixando CR:', e.message); }
          } else {
            console.warn('[MP consultar] Sem conta MP/banco padrão — CR não baixada automaticamente');
          }
        }
      }

      const updated = db.prepare('SELECT * FROM boletos WHERE id = ?').get(req.params.id);
      res.json({ success: true, boleto: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cancelar boleto
  app.post('/api/boletos/:id/cancelar', async (req, res) => {
    try {
      const boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(req.params.id);
      if (!boleto) return res.status(404).json({ success: false, error: 'Boleto nao encontrado' });

      if (boleto.mpId) {
        const mpConfig = loadMPConfig(db);
        if (mpConfig) {
          try {
            const client = new MercadoPagoClient(mpConfig);
            await client.cancelarBoleto(boleto.mpId);
          } catch (mpErr) {
            console.error('[Financeiro] Erro ao cancelar boleto no MP:', mpErr.message);
          }
        }
      }

      db.prepare(`UPDATE boletos SET status = 'cancelado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(req.params.id);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Enviar boleto por email
  app.post('/api/boletos/:id/enviar-email', async (req, res) => {
    try {
      const r = await enviarBoletoAoCliente(db, Number(req.params.id), (req.body && req.body.to) || undefined);
      if (!r.ok) {
        return res.status(r.motivo === 'Boleto não encontrado' ? 404 : 400).json({ success: false, error: r.motivo });
      }
      res.json({ success: true, message: `Email enviado para ${r.to}` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Dados do boleto para compartilhamento (WhatsApp, etc)
  app.get('/api/boletos/:id/compartilhar', (req, res) => {
    try {
      const boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(req.params.id);
      if (!boleto) return res.status(404).json({ success: false, error: 'Boleto nao encontrado' });

      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(boleto.contaReceberId);
      const pessoa = db.prepare(`
        SELECT p.* FROM pessoas p
        JOIN contas_a_receber c ON c.pessoaId = p.id
        WHERE c.id = ?
      `).get(boleto.contaReceberId);

      const valorFmt = 'R$ ' + Number((boleto.amount / 100).toFixed(2)).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
      const vencFmt = boleto.expirationDate ? boleto.expirationDate.split('-').reverse().join('/') : '';
      const isPix = boleto.tipoCobranca === 'pix';

      let texto = `*Cobrança - ${conta?.descricao || (isPix ? 'PIX' : 'Boleto')}*\n`;
      texto += `Valor: *${valorFmt}*\n`;
      texto += `Vencimento: ${vencFmt}\n`;
      if (isPix) {
        if (boleto.externalUrl) texto += `\nLink de pagamento:\n${boleto.externalUrl}\n`;
        if (boleto.pixPayload) texto += `\nPIX copia e cola:\n${boleto.pixPayload}\n`;
      } else {
        if (boleto.writableLine) texto += `\nLinha Digitável:\n${boleto.writableLine}\n`;
        if (boleto.externalUrl) texto += `\nBoleto PDF:\n${boleto.externalUrl}\n`;
      }

      // Link wa.me pré-preenchido (o frontend abre direto o WhatsApp do cliente).
      let telNorm = String(pessoa?.telefone || '').replace(/\D/g, '');
      if (telNorm && !telNorm.startsWith('55')) telNorm = '55' + telNorm;
      const whatsapp = telNorm ? `https://wa.me/${telNorm}?text=${encodeURIComponent(texto)}` : '';

      res.json({
        success: true,
        texto,
        whatsapp,
        telefone: pessoa?.telefone || '',
        pessoaNome: pessoa?.razaoSocial || '',
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== MERCADOPAGO CONFIG ====================

  app.get('/api/mp/config', (req, res) => {
    try {
      const rows = db.prepare('SELECT key, value FROM mp_config').all();
      const config = {};
      for (const row of rows) {
        if (row.key === 'access_token' && row.value) {
          config[row.key] = row.value.substring(0, 15) + '...***';
        } else {
          config[row.key] = row.value;
        }
      }
      config._configured = rows.some(r => r.key === 'access_token' && r.value);
      res.json({ success: true, config });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/mp/config', (req, res) => {
    try {
      const { access_token } = req.body;
      if (access_token !== undefined) {
        db.prepare('INSERT INTO mp_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
          .run('access_token', access_token, access_token);
      }
      res.json({ success: true, message: 'Configuracao MercadoPago salva' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/mp/status', async (req, res) => {
    try {
      const config = loadMPConfig(db);
      if (!config) {
        return res.json({ success: true, connected: false, message: 'Access Token nao configurado' });
      }

      const client = new MercadoPagoClient(config);
      const user = await client.testarConexao();
      res.json({ success: true, connected: true, message: `Conectado: ${user.nickname || user.email || user.id}`, user: { id: user.id, nickname: user.nickname, email: user.email } });
    } catch (err) {
      res.json({ success: true, connected: false, message: `Erro: ${err.message}` });
    }
  });

  // ==================== WEBHOOK MERCADOPAGO ====================

  app.post('/api/webhooks/mercadopago', async (req, res) => {
    try {
      const payload = req.body;
      console.log('[MP Webhook]', JSON.stringify(payload).substring(0, 500));

      // MP envia notificacao com type e data.id
      if (payload.type !== 'payment' || !payload.data?.id) {
        return res.json({ ok: true });
      }

      const paymentId = String(payload.data.id);
      const boleto = db.prepare('SELECT * FROM boletos WHERE mpId = ?').get(paymentId);
      if (!boleto) {
        console.warn('[MP Webhook] Boleto nao encontrado para mpId:', paymentId);
        return res.json({ ok: true });
      }

      // Consultar status atual no MP
      const mpConfig = loadMPConfig(db);
      if (mpConfig) {
        try {
          const client = new MercadoPagoClient(mpConfig);
          const payment = await client.consultarBoleto(paymentId);

          let newStatus = boleto.status;
          if (payment.status === 'approved') newStatus = 'pago';
          else if (payment.status === 'cancelled') newStatus = 'cancelado';
          else if (payment.status === 'rejected') newStatus = 'rejeitado';

          db.prepare(`UPDATE boletos SET status = ?, webhookPayload = ?, mpResponse = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(newStatus, JSON.stringify(payload), JSON.stringify(payment), boleto.id);

          if (newStatus === 'pago' && boleto.contaReceberId) {
            const contaCR = db.prepare('SELECT status FROM contas_a_receber WHERE id = ?').get(boleto.contaReceberId);
            if (contaCR && contaCR.status !== 'paga' && contaCR.status !== 'cancelada') {
              const contaMP = getContaMercadoPago(db);
              if (contaMP) {
                try {
                  registrarBaixaCR(db, {
                    contaReceberId: boleto.contaReceberId,
                    contaFinanceiraId: contaMP.id,
                    formaPagamento: 'boleto',
                    origem: 'webhook_mp',
                    observacoes: `Webhook MP (boleto ${boleto.mpId})`
                  });
                } catch (e) { console.error('[MP Webhook] erro baixando CR:', e.message); }
              } else {
                console.warn('[MP Webhook] Sem conta MP/banco padrão — CR não baixada automaticamente');
              }
            }
          }
        } catch (err) {
          console.error('[MP Webhook] Erro ao consultar payment:', err.message);
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[MP Webhook] Erro:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * Polling: consulta boletos registrados no MercadoPago e dá baixa automática nos pagos.
 * Roda a cada 30 minutos.
 */
function agendarPollingBoletos(db) {
  const INTERVALO = 30 * 60 * 1000; // 30 min

  async function verificarBoletos() {
    try {
      const boletos = db.prepare("SELECT * FROM boletos WHERE status = 'registrado' AND mpId IS NOT NULL").all();
      if (!boletos.length) return;

      const mpConfig = loadMPConfig(db);
      if (!mpConfig) return;

      const client = new MercadoPagoClient(mpConfig);
      let atualizados = 0;

      for (const boleto of boletos) {
        try {
          const payment = await client.consultarBoleto(boleto.mpId);

          let newStatus = boleto.status;
          if (payment.status === 'approved') newStatus = 'pago';
          else if (payment.status === 'cancelled') newStatus = 'cancelado';
          else if (payment.status === 'rejected') newStatus = 'rejeitado';

          if (newStatus !== boleto.status) {
            db.prepare('UPDATE boletos SET status = ?, mpResponse = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
              .run(newStatus, JSON.stringify(payment), boleto.id);

            if (newStatus === 'pago' && boleto.contaReceberId) {
              const contaCR = db.prepare("SELECT status FROM contas_a_receber WHERE id = ?").get(boleto.contaReceberId);
              if (contaCR && contaCR.status !== 'paga' && contaCR.status !== 'cancelada') {
                const contaMP = getContaMercadoPago(db);
                if (contaMP) {
                  try {
                    registrarBaixaCR(db, {
                      contaReceberId: boleto.contaReceberId,
                      contaFinanceiraId: contaMP.id,
                      formaPagamento: 'boleto',
                      origem: 'polling_mp',
                      observacoes: `Polling MP (boleto ${boleto.mpId})`
                    });
                  } catch (e) { console.error('[Polling Boletos] erro baixando CR:', e.message); }
                } else {
                  console.warn('[Polling Boletos] Sem conta MP/banco padrão — CR não baixada automaticamente');
                }
              }
            }
            atualizados++;
            console.log(`[Polling Boletos] #${boleto.id} (MP ${boleto.mpId}): ${boleto.status} -> ${newStatus}`);
          }
        } catch (err) {
          console.error(`[Polling Boletos] Erro boleto #${boleto.id}:`, err.message);
        }
      }

      if (atualizados > 0) {
        console.log(`[Polling Boletos] ${atualizados} boleto(s) atualizado(s) de ${boletos.length} consultado(s)`);
      }
    } catch (err) {
      console.error('[Polling Boletos] Erro geral:', err.message);
    }
  }

  setInterval(verificarBoletos, INTERVALO);
  // Primeira execução após 1 minuto (dar tempo do server subir)
  setTimeout(verificarBoletos, 60 * 1000);
  console.log('[Polling Boletos] Agendado a cada 30 minutos');
}

module.exports = { registrarRotasFinanceiro, agendarPollingBoletos, gerarEEnviarBoletoParaCR, enviarBoletoAoCliente, gerarEEnviarPixParaCR, enviarPixAoCliente };
