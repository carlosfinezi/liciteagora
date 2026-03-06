/**
 * nfse-routes.js — Endpoints REST para NFS-e Nacional
 *
 * Padrão: registrarRotasNfse(app, db)
 *
 * Uso no server.js:
 *   const { registrarRotasNfse, emitirNfseInterno, carregarCertificado, getConfig, dataBrasilia } = require('./nfse-routes');
 *   registrarRotasNfse(app, db);
 */

const { gerarIdDps, construirDPS, assinarDPS, extrairChavesCertificado } = require('./nfse-xml');
const { NfseClient } = require('./nfse-client');
const { MercadoPagoClient, loadMPConfig } = require('./mercadopago-client');

/** Data atual em Brasilia (UTC-3) no formato YYYY-MM-DD */
function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

/**
 * Migracao inline — cria tabelas nfse e nfse_config se nao existem
 */
function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfse (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idDps TEXT,
      serie TEXT,
      nDPS INTEGER,
      tpAmb INTEGER DEFAULT 2,
      chaveAcesso TEXT,
      nNFSe TEXT,
      tomadorCpfCnpj TEXT,
      tomadorRazaoSocial TEXT,
      tomadorEndereco TEXT,
      codigoTributacaoNacional TEXT,
      descricaoServico TEXT,
      valorServico REAL,
      dataCompetencia TEXT,
      status TEXT DEFAULT 'processando',
      xmlEnvio TEXT,
      xmlRetorno TEXT,
      motivoCancelamento TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nfse_config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Valores padrao
  const insert = db.prepare('INSERT OR IGNORE INTO nfse_config (key, value) VALUES (?, ?)');
  insert.run('ambiente', '2');        // Homologacao por padrao
  insert.run('serie', '1');
  insert.run('cod_municipio', '');
  insert.run('proximo_numero', '1');

  console.log('[NFSe] Tabelas verificadas/criadas');
}

/**
 * Carrega certificado digital do banco de dados
 */
function carregarCertificado(db) {
  const cert = db.prepare(
    'SELECT certificadoBase64, senhaCriptografada, titular, validade FROM certificado_digital WHERE id = 1'
  ).get();

  if (!cert) {
    throw new Error('Certificado digital não configurado. Configure em Dados do Fornecedor.');
  }

  const p12Buffer = Buffer.from(cert.certificadoBase64, 'base64');
  const senha = Buffer.from(cert.senhaCriptografada, 'base64').toString();

  return { p12Buffer, senha, titular: cert.titular, validade: cert.validade };
}

/**
 * Obtem e incrementa atomicamente o proximo numero de DPS
 */
function proximoNumeroDPS(db) {
  const row = db.prepare("SELECT value FROM nfse_config WHERE key = 'proximo_numero'").get();
  const numero = parseInt(row?.value || '1', 10);
  db.prepare("UPDATE nfse_config SET value = ? WHERE key = 'proximo_numero'").run(String(numero + 1));
  return numero;
}

/**
 * Obtem valor de config NFSe
 */
function getConfig(db, key) {
  const row = db.prepare('SELECT value FROM nfse_config WHERE key = ?').get(key);
  return row?.value || '';
}

/**
 * Define valor de config NFSe
 */
function setConfig(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO nfse_config (key, value) VALUES (?, ?)').run(key, String(value));
}

// ==================== EMISSAO INTERNA (reusavel) ====================

/**
 * Emite NFSe internamente (sem HTTP). Usado pelo handler e pelo scheduler de recorrencias.
 *
 * @param {object} db - instancia better-sqlite3
 * @param {object} params - { tomador, servico, competencia, incluirIM, opSimpNac, regEspTrib, pTotTribSN, gerarBoleto, dataVencimentoBoleto }
 * @returns {object} { success, nfse: { id, idDps, nDPS, serie, chaveAcesso, nNFSe, status, resposta }, conta, boleto, error }
 */
async function emitirNfseInterno(db, params) {
  const { tomador, servico, competencia, incluirIM, opSimpNac, regEspTrib, pTotTribSN, gerarBoleto, dataVencimentoBoleto } = params;

  // Validacoes
  if (!tomador || !tomador.cpfCnpj || !tomador.razaoSocial) {
    return { success: false, error: 'Dados do tomador obrigatorios (cpfCnpj, razaoSocial)' };
  }
  if (!servico || !servico.codigoTributacaoNacional || !servico.descricao || !servico.valorServico) {
    return { success: false, error: 'Dados do servico obrigatorios (codigoTributacaoNacional, descricao, valorServico)' };
  }

  // Carregar dados
  const ambiente = parseInt(getConfig(db, 'ambiente') || '2', 10);
  const serie = getConfig(db, 'serie') || 'NFSE';
  const codMunicipio = getConfig(db, 'cod_municipio');

  if (!codMunicipio) {
    return { success: false, error: 'Codigo do municipio nao configurado' };
  }

  const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
  if (!fornecedor || !fornecedor.cnpj) {
    return { success: false, error: 'Dados do fornecedor nao cadastrados' };
  }

  // Certificado
  const { p12Buffer, senha } = carregarCertificado(db);
  const { privateKeyPem, certDerBase64 } = extrairChavesCertificado(p12Buffer, senha);

  // Numero DPS (atomico)
  const nDPS = proximoNumeroDPS(db);

  // ID da DPS
  const idDps = gerarIdDps(codMunicipio, fornecedor.cnpj, serie, nDPS);

  // Construir XML
  const dados = {
    idDps,
    tpAmb: ambiente,
    serie,
    nDPS,
    competencia: competencia || dataBrasilia(),
    prestador: {
      cnpj: fornecedor.cnpj,
      inscricaoMunicipal: (incluirIM === false) ? '' : (fornecedor.inscricaoMunicipal || ''),
      codigoMunicipio: codMunicipio,
      opSimpNac: opSimpNac || 3,
      regEspTrib: regEspTrib || 0,
    },
    tomador: {
      cpfCnpj: tomador.cpfCnpj,
      razaoSocial: tomador.razaoSocial,
      inscricaoMunicipal: tomador.inscricaoMunicipal,
      email: tomador.email,
      endereco: tomador.endereco || null,
    },
    servico: {
      codigoTributacaoNacional: servico.codigoTributacaoNacional,
      codigoListaServico: servico.codigoListaServico,
      descricao: servico.descricao,
      valorServico: servico.valorServico,
      valorDeducoes: servico.valorDeducoes,
      aliquota: servico.aliquota,
      codigoMunicipioPrestacao: servico.codigoMunicipioPrestacao || codMunicipio,
    },
    pTotTribSN: pTotTribSN || null,
  };

  const dpsXml = construirDPS(dados);
  console.log(`[NFSe] DPS construida: ${idDps}`);

  // Assinar
  const signedXml = assinarDPS(dpsXml, privateKeyPem, certDerBase64);
  console.log(`[NFSe] DPS assinada com sucesso`);

  // Salvar no banco antes de enviar (status = processando)
  const insertStmt = db.prepare(`
    INSERT INTO nfse (idDps, serie, nDPS, tpAmb, tomadorCpfCnpj, tomadorRazaoSocial,
      tomadorEndereco, codigoTributacaoNacional, descricaoServico, valorServico,
      dataCompetencia, status, xmlEnvio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processando', ?)
  `);

  const result = insertStmt.run(
    idDps, serie, nDPS, ambiente,
    tomador.cpfCnpj, tomador.razaoSocial,
    tomador.endereco ? JSON.stringify(tomador.endereco) : null,
    servico.codigoTributacaoNacional, servico.descricao,
    servico.valorServico,
    competencia || dataBrasilia(),
    signedXml
  );
  const nfseId = result.lastInsertRowid;

  // Enviar para SEFIN
  try {
    const client = new NfseClient(p12Buffer, senha, ambiente);
    const resposta = await client.emitirNfse(signedXml);

    console.log(`[NFSe] Resposta SEFIN:`, JSON.stringify(resposta).substring(0, 500));

    // Atualizar com resposta
    const chaveAcesso = resposta.chaveAcesso || resposta.chNFSe || '';
    const nNFSe = resposta.nNFSe || resposta.numero || '';
    const status = chaveAcesso ? 'autorizada' : (resposta.motivo ? 'rejeitada' : 'processando');

    db.prepare(`
      UPDATE nfse SET chaveAcesso = ?, nNFSe = ?, status = ?, xmlRetorno = ?, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(chaveAcesso, nNFSe, status, JSON.stringify(resposta), nfseId);

    // Integracao Financeiro: gerar pessoa + conta a receber + boleto
    let contaCriada = null;
    let boletoCriado = null;
    if (status === 'autorizada' && gerarBoleto) {
      try {
        const cpfLimpo = tomador.cpfCnpj.replace(/\D/g, '');
        const tipoPessoa = cpfLimpo.length <= 11 ? 'PF' : 'PJ';

        // Busca ou cria pessoa
        let pessoa = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(cpfLimpo);
        if (!pessoa) {
          const endJson = tomador.endereco || {};
          db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, inscricaoMunicipal,
            endereco, numero, complemento, bairro, codigoMunicipio, uf, cep, email)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(cpfLimpo, tipoPessoa, tomador.razaoSocial, tomador.inscricaoMunicipal || null,
            endJson.logradouro || null, endJson.numero || null, endJson.complemento || null,
            endJson.bairro || null, endJson.codigoMunicipio || null, endJson.uf || null,
            endJson.cep || null, tomador.email || null);
          pessoa = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(cpfLimpo);
        } else if (!pessoa.ativo) {
          db.prepare('UPDATE pessoas SET ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(pessoa.id);
        }

        const valor = servico.valorServico;
        const dataVenc = dataVencimentoBoleto || dataBrasilia();
        const descConta = `NFSe ${nNFSe || nDPS} - ${servico.descricao}`.substring(0, 200);

        // Criar conta a receber
        const contaId = db.prepare(`INSERT INTO contas_a_receber
          (pessoaId, nfseId, descricao, valor, dataEmissao, dataVencimento, formaPagamento)
          VALUES (?, ?, ?, ?, ?, ?, 'boleto')`
        ).run(pessoa.id, nfseId, descConta, valor, dataBrasilia(), dataVenc).lastInsertRowid;

        // Criar boleto (pendente)
        const amountCentavos = Math.round(valor * 100);
        const boletoId = db.prepare(`INSERT INTO boletos
          (contaReceberId, amount, expirationDate, customerDocument, customerName)
          VALUES (?, ?, ?, ?, ?)`
        ).run(contaId, amountCentavos, dataVenc, cpfLimpo, tomador.razaoSocial).lastInsertRowid;

        contaCriada = { id: contaId };
        boletoCriado = { id: boletoId, status: 'pendente' };

        // Tenta emitir no MercadoPago (nao-fatal)
        const mpConfig = loadMPConfig(db);
        if (mpConfig) {
          try {
            const mpClient = new MercadoPagoClient(mpConfig);
            const mpResp = await mpClient.criarBoleto({
              amount: valor, expirationDate: dataVenc,
              customerDocument: cpfLimpo, customerName: tomador.razaoSocial,
              customerEmail: tomador.email || 'pagador@email.com',
              description: descConta,
              address: { cep: pessoa.cep, endereco: pessoa.endereco, numero: pessoa.numero, bairro: pessoa.bairro, cidade: pessoa.cidade, uf: pessoa.uf },
              nfseNumero: nNFSe || nDPS, competencia,
            });
            db.prepare(`UPDATE boletos SET mpId = ?, barcode = ?, writableLine = ?,
              externalUrl = ?, status = 'registrado', mpResponse = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
            ).run(mpResp.id, mpResp.barcode, mpResp.writable_line, mpResp.external_resource_url, JSON.stringify(mpResp.raw), boletoId);
            boletoCriado.status = 'registrado';
          } catch (mpErr) {
            console.error('[NFSe->Boleto] Erro MercadoPago (nao-fatal):', mpErr.message);
            db.prepare('UPDATE boletos SET erroMensagem = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
              .run(mpErr.message, boletoId);
          }
        }

        console.log(`[NFSe->Boleto] Conta #${contaId} + Boleto #${boletoId} criados para NFSe #${nfseId}`);
      } catch (finErr) {
        console.error('[NFSe->Boleto] Erro ao criar financeiro (nao-fatal):', finErr.message);
      }
    }

    return {
      success: true,
      nfse: { id: nfseId, idDps, nDPS, serie, chaveAcesso, nNFSe, status, resposta },
      conta: contaCriada,
      boleto: boletoCriado,
    };
  } catch (sefinError) {
    console.error(`[NFSe] Erro SEFIN:`, sefinError.message);

    db.prepare(`
      UPDATE nfse SET status = 'erro', xmlRetorno = ?, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(sefinError.message, nfseId);

    return {
      success: false,
      error: `Erro ao enviar para SEFIN: ${sefinError.message}`,
      nfse: { id: nfseId, idDps, nDPS, serie, status: 'erro' },
    };
  }
}

// ==================== REGISTRO DE ROTAS ====================

function registrarRotasNfse(app, db) {
  // Migrar banco
  migrarDB(db);

  // ---------- CONFIG ----------

  // GET /api/nfse/config
  app.get('/api/nfse/config', (req, res) => {
    try {
      const ambiente = getConfig(db, 'ambiente');
      const serie = getConfig(db, 'serie');
      const codMunicipio = getConfig(db, 'cod_municipio');
      const proximoNumero = getConfig(db, 'proximo_numero');

      const cert = db.prepare('SELECT titular, validade FROM certificado_digital WHERE id = 1').get();
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();

      res.json({
        success: true,
        config: { ambiente, serie, codMunicipio, proximoNumero },
        certificado: cert ? { configurado: true, titular: cert.titular, validade: cert.validade } : { configurado: false },
        prestador: fornecedor || null,
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // POST /api/nfse/config
  app.post('/api/nfse/config', (req, res) => {
    try {
      const { ambiente, serie, codMunicipio } = req.body;

      if (ambiente !== undefined) {
        if (![1, 2, '1', '2'].includes(ambiente)) {
          return res.status(400).json({ success: false, error: 'Ambiente invalido (1=Producao, 2=Homologacao)' });
        }
        setConfig(db, 'ambiente', ambiente);
      }
      if (serie !== undefined) setConfig(db, 'serie', serie);
      if (codMunicipio !== undefined) setConfig(db, 'cod_municipio', codMunicipio);

      res.json({ success: true, message: 'Configuracao atualizada' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/nfse/prestador
  app.get('/api/nfse/prestador', (req, res) => {
    try {
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
      if (!fornecedor) {
        return res.json({ success: true, prestador: null, message: 'Fornecedor nao cadastrado' });
      }
      res.json({ success: true, prestador: fornecedor });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- EMISSAO (wrapper HTTP) ----------

  app.post('/api/nfse/emitir', async (req, res) => {
    try {
      const resultado = await emitirNfseInterno(db, {
        tomador: req.body.tomador,
        servico: req.body.servico,
        competencia: req.body.competencia,
        incluirIM: req.body.incluirIM,
        opSimpNac: req.body.opSimpNac,
        regEspTrib: req.body.regEspTrib,
        pTotTribSN: req.body.pTotTribSN,
        gerarBoleto: req.body.gerarBoleto,
        dataVencimentoBoleto: req.body.dataVencimentoBoleto,
      });

      if (!resultado.success) {
        const statusCode = resultado.nfse ? 502 : 400;
        return res.status(statusCode).json(resultado);
      }

      res.json(resultado);
    } catch (error) {
      console.error('[NFSe] Erro na emissao:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- LISTAGEM ----------

  app.get('/api/nfse/lista', (req, res) => {
    try {
      const { status, busca, limite } = req.query;
      const lim = Math.min(parseInt(limite) || 50, 200);

      let sql = 'SELECT id, idDps, serie, nDPS, tpAmb, chaveAcesso, nNFSe, tomadorCpfCnpj, tomadorRazaoSocial, codigoTributacaoNacional, descricaoServico, valorServico, dataCompetencia, status, dataCriacao, dataAtualizacao FROM nfse WHERE 1=1';
      const params = [];

      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }

      if (busca) {
        sql += ' AND (tomadorRazaoSocial LIKE ? OR tomadorCpfCnpj LIKE ? OR nNFSe LIKE ? OR descricaoServico LIKE ?)';
        const term = `%${busca}%`;
        params.push(term, term, term, term);
      }

      sql += ' ORDER BY id DESC LIMIT ?';
      params.push(lim);

      const notas = db.prepare(sql).all(...params);

      res.json({ success: true, notas, total: notas.length });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- PARAMETROS MUNICIPAIS ----------

  app.get('/api/nfse/parametros-municipais', async (req, res) => {
    return handleParametrosMunicipais(req, res, '');
  });

  app.get('/api/nfse/parametros-municipais/:cod', async (req, res) => {
    return handleParametrosMunicipais(req, res, req.params.cod);
  });

  async function handleParametrosMunicipais(req, res, cod) {
    try {
      cod = cod || getConfig(db, 'cod_municipio');
      if (!cod) {
        return res.status(400).json({ success: false, error: 'Codigo do municipio nao informado' });
      }

      const { p12Buffer, senha } = carregarCertificado(db);
      const ambiente = parseInt(getConfig(db, 'ambiente') || '2', 10);
      const client = new NfseClient(p12Buffer, senha, ambiente);

      const parametros = await client.parametrosMunicipais(cod);

      res.json({ success: true, codMunicipio: cod, parametros });
    } catch (error) {
      console.error('[NFSe] Erro parametros municipais:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ---------- DETALHES ----------

  app.get('/api/nfse/:id', (req, res) => {
    try {
      const nota = db.prepare('SELECT * FROM nfse WHERE id = ?').get(req.params.id);
      if (!nota) {
        return res.status(404).json({ success: false, error: 'Nota nao encontrada' });
      }
      res.json({ success: true, nota });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- DANFSE ----------

  app.get('/api/nfse/:id/danfse', async (req, res) => {
    try {
      const nota = db.prepare('SELECT chaveAcesso, tpAmb FROM nfse WHERE id = ?').get(req.params.id);
      if (!nota) {
        return res.status(404).json({ success: false, error: 'Nota nao encontrada' });
      }
      if (!nota.chaveAcesso) {
        return res.status(400).json({ success: false, error: 'Nota sem chave de acesso (nao autorizada)' });
      }

      const { p12Buffer, senha } = carregarCertificado(db);
      const client = new NfseClient(p12Buffer, senha, nota.tpAmb);
      const pdfBuffer = await client.downloadDanfse(nota.chaveAcesso);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="DANFSE_${nota.chaveAcesso}.pdf"`);
      res.send(pdfBuffer);
    } catch (error) {
      console.error('[NFSe] Erro ao baixar DANFSE:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- CANCELAMENTO ----------

  app.post('/api/nfse/:id/cancelar', async (req, res) => {
    try {
      const { motivo } = req.body;
      if (!motivo || motivo.length < 15) {
        return res.status(400).json({ success: false, error: 'Motivo obrigatorio (minimo 15 caracteres)' });
      }

      const nota = db.prepare('SELECT id, chaveAcesso, tpAmb, status FROM nfse WHERE id = ?').get(req.params.id);
      if (!nota) {
        return res.status(404).json({ success: false, error: 'Nota nao encontrada' });
      }
      if (nota.status === 'cancelada') {
        return res.status(400).json({ success: false, error: 'Nota ja cancelada' });
      }
      if (!nota.chaveAcesso) {
        return res.status(400).json({ success: false, error: 'Nota sem chave de acesso' });
      }

      const { p12Buffer, senha } = carregarCertificado(db);
      const client = new NfseClient(p12Buffer, senha, nota.tpAmb);

      const resposta = await client.cancelarNfse(nota.chaveAcesso, motivo);
      console.log(`[NFSe] Cancelamento resposta:`, JSON.stringify(resposta).substring(0, 300));

      db.prepare(`
        UPDATE nfse SET status = 'cancelada', motivoCancelamento = ?, xmlRetorno = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(motivo, JSON.stringify(resposta), nota.id);

      res.json({ success: true, message: 'Nota cancelada', resposta });
    } catch (error) {
      console.error('[NFSe] Erro ao cancelar:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[NFSe] Rotas registradas');
}

module.exports = { registrarRotasNfse, emitirNfseInterno, carregarCertificado, getConfig, dataBrasilia };
