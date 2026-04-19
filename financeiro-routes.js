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

async function emitirBoletoMP(db, boleto, pessoa, throwOnError = false) {
  const mpConfig = loadMPConfig(db);
  if (!mpConfig) {
    if (throwOnError) throw new Error('MercadoPago nao configurado');
    return null;
  }

  try {
    const client = new MercadoPagoClient(mpConfig);

    // Buscar descricao da conta e NFSe vinculada
    const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(boleto.contaReceberId);
    let nfseNumero = '';
    let competencia = '';
    if (conta?.nfseId) {
      const nfse = db.prepare('SELECT nNFSe, dataCompetencia FROM nfse WHERE id = ?').get(conta.nfseId);
      if (nfse) { nfseNumero = nfse.nNFSe || ''; competencia = nfse.dataCompetencia || ''; }
    }

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

    db.prepare(`UPDATE boletos SET mpId = ?, barcode = ?, writableLine = ?, externalUrl = ?,
      status = 'registrado', mpResponse = ?, erroMensagem = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(resp.id, resp.barcode, resp.writable_line, resp.external_resource_url, JSON.stringify(resp.raw), boleto.id);

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

function registrarRotasFinanceiro(app, db) {
  migrarDB(db);

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

  app.post('/api/pessoas', (req, res) => {
    try {
      const { cpfCnpj, razaoSocial, nomeFantasia, inscricaoMunicipal,
              endereco, numero, complemento, bairro, codigoMunicipio, cidade, uf, cep,
              telefone, email, emailsAdicionais, observacoes, contribuinteIcms } = req.body;

      if (!cpfCnpj || !razaoSocial) {
        return res.status(400).json({ success: false, error: 'CPF/CNPJ e Razao Social sao obrigatorios' });
      }

      const cpfLimpo = cpfCnpj.replace(/\D/g, '');
      const tipo = detectarTipoPessoa(cpfLimpo);
      const contribIcms = contribuinteIcms ? 1 : 0;

      const existente = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(cpfLimpo);
      if (existente) {
        if (!existente.ativo) {
          db.prepare(`UPDATE pessoas SET ativo = 1, razaoSocial = ?, nomeFantasia = ?, tipo = ?,
            inscricaoMunicipal = ?, endereco = ?, numero = ?, complemento = ?, bairro = ?,
            codigoMunicipio = ?, cidade = ?, uf = ?, cep = ?, telefone = ?, email = ?,
            emailsAdicionais = ?, observacoes = ?, contribuinteIcms = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
          ).run(razaoSocial, nomeFantasia || null, tipo,
            inscricaoMunicipal || null, endereco || null, numero || null, complemento || null, bairro || null,
            codigoMunicipio || null, cidade || null, uf || null, cep || null, telefone || null, email || null,
            emailsAdicionais || null, observacoes || null, contribIcms, existente.id);
          const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(existente.id);
          return res.json({ success: true, pessoa, reativada: true });
        }
        return res.status(409).json({ success: false, error: 'Pessoa ja cadastrada com este CPF/CNPJ', pessoa: existente });
      }

      const result = db.prepare(
        `INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, nomeFantasia, inscricaoMunicipal,
          endereco, numero, complemento, bairro, codigoMunicipio, cidade, uf, cep,
          telefone, email, emailsAdicionais, observacoes, contribuinteIcms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(cpfLimpo, tipo, razaoSocial, nomeFantasia || null, inscricaoMunicipal || null,
        endereco || null, numero || null, complemento || null, bairro || null,
        codigoMunicipio || null, cidade || null, uf || null, cep || null,
        telefone || null, email || null, emailsAdicionais || null, observacoes || null, contribIcms);

      const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, pessoa });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/pessoas/:id', (req, res) => {
    try {
      const { razaoSocial, nomeFantasia, inscricaoMunicipal,
              endereco, numero, complemento, bairro, codigoMunicipio, cidade, uf, cep,
              telefone, email, emailsAdicionais, observacoes, contribuinteIcms } = req.body;

      const existing = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Pessoa nao encontrada' });

      db.prepare(`UPDATE pessoas SET razaoSocial = ?, nomeFantasia = ?, inscricaoMunicipal = ?,
        endereco = ?, numero = ?, complemento = ?, bairro = ?,
        codigoMunicipio = ?, cidade = ?, uf = ?, cep = ?,
        telefone = ?, email = ?, emailsAdicionais = ?, observacoes = ?, contribuinteIcms = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`
      ).run(
        razaoSocial || existing.razaoSocial, nomeFantasia ?? existing.nomeFantasia,
        inscricaoMunicipal ?? existing.inscricaoMunicipal,
        endereco ?? existing.endereco, numero ?? existing.numero,
        complemento ?? existing.complemento, bairro ?? existing.bairro,
        codigoMunicipio ?? existing.codigoMunicipio, cidade ?? existing.cidade,
        uf ?? existing.uf, cep ?? existing.cep,
        telefone ?? existing.telefone, email ?? existing.email,
        emailsAdicionais !== undefined ? (emailsAdicionais || null) : existing.emailsAdicionais,
        observacoes ?? existing.observacoes,
        contribuinteIcms !== undefined ? (contribuinteIcms ? 1 : 0) : existing.contribuinteIcms,
        req.params.id
      );

      const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(req.params.id);
      res.json({ success: true, pessoa });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/pessoas/:id', (req, res) => {
    try {
      const result = db.prepare('UPDATE pessoas SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ? AND ativo = 1').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ success: false, error: 'Pessoa nao encontrada' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CONTAS A RECEBER — MOVIDO PARA contas-receber-routes.js ====================
  // Endpoints /api/contas-a-receber/** (listar, resumo, detalhe, criar, editar, baixar, cancelar, reabrir, duplicar, anexos, categorias)
  // foram extraídos para contas-receber-routes.js. Aqui continuam apenas os endpoints acoplados a
  // MercadoPago / boletos. O webhook e o polling usam registrarBaixaCR para registrar baixas.


  // Gerar novo boleto para conta existente
  app.post('/api/contas-a-receber/:id/gerar-boleto', async (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta nao encontrada' });
      if (conta.status !== 'aberta') return res.status(400).json({ success: false, error: 'Conta precisa estar aberta' });

      // Verificar se ja tem boleto ativo
      const boletoAtivo = db.prepare(`SELECT * FROM boletos WHERE contaReceberId = ? AND status IN ('pendente','registrado') ORDER BY id DESC LIMIT 1`).get(req.params.id);
      if (boletoAtivo) return res.status(400).json({ success: false, error: 'Ja existe boleto ativo para esta conta' });

      const pessoa = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(conta.pessoaId);
      if (!pessoa) return res.status(400).json({ success: false, error: 'Pessoa nao encontrada' });

      const amountCentavos = Math.round(conta.valor * 100);
      const boletoId = db.prepare(`INSERT INTO boletos (contaReceberId, amount, expirationDate, customerDocument, customerName) VALUES (?, ?, ?, ?, ?)`)
        .run(req.params.id, amountCentavos, conta.dataVencimento, pessoa.cpfCnpj, pessoa.razaoSocial).lastInsertRowid;

      let boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);
      await emitirBoletoMP(db, boleto, pessoa);
      boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);

      // Atualizar forma de pagamento
      db.prepare(`UPDATE contas_a_receber SET formaPagamento = 'boleto', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);

      res.json({ success: true, boleto });
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
      const boleto = db.prepare('SELECT * FROM boletos WHERE id = ?').get(req.params.id);
      if (!boleto) return res.status(404).json({ success: false, error: 'Boleto nao encontrado' });
      if (boleto.status !== 'registrado') return res.status(400).json({ success: false, error: 'Boleto nao esta registrado' });

      const conta = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(boleto.contaReceberId);
      const pessoa = db.prepare(`
        SELECT p.* FROM pessoas p
        JOIN contas_a_receber c ON c.pessoaId = p.id
        WHERE c.id = ?
      `).get(boleto.contaReceberId);

      if (!pessoa?.email) return res.status(400).json({ success: false, error: 'Cliente nao possui email cadastrado' });

      const { enviarEmailBoleto, loadSmtpConfig } = require('./email-client');
      const smtpConfig = loadSmtpConfig(db);
      if (!smtpConfig) return res.status(400).json({ success: false, error: 'SMTP nao configurado. Configure em Recorrencias > Config. Email' });

      await enviarEmailBoleto(db, {
        to: pessoa.email,
        descricao: conta?.descricao || 'Cobrança',
        valor: (boleto.amount / 100).toFixed(2),
        vencimento: boleto.expirationDate,
        clienteNome: pessoa.razaoSocial,
        boletoWritableLine: boleto.writableLine,
        boletoUrl: boleto.externalUrl,
      });

      res.json({ success: true, message: `Email enviado para ${pessoa.email}` });
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

      let texto = `*Cobrança - ${conta?.descricao || 'Boleto'}*\n`;
      texto += `Valor: *${valorFmt}*\n`;
      texto += `Vencimento: ${vencFmt}\n`;
      if (boleto.writableLine) texto += `\nLinha Digitável:\n${boleto.writableLine}\n`;
      if (boleto.externalUrl) texto += `\nBoleto PDF:\n${boleto.externalUrl}\n`;

      res.json({
        success: true,
        texto,
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

module.exports = { registrarRotasFinanceiro, agendarPollingBoletos };
