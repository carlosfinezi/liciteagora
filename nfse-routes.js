/**
 * nfse-routes.js — Endpoints REST para NFS-e Nacional
 *
 * Padrão: registrarRotasNfse(app, db)
 *
 * Uso no server.js:
 *   const { registrarRotasNfse } = require('./nfse-routes');
 *   registrarRotasNfse(app, db);
 */

const { gerarIdDps, construirDPS, assinarDPS, extrairChavesCertificado } = require('./nfse-xml');
const { NfseClient } = require('./nfse-client');

/** Data atual em Brasília (UTC-3) no formato YYYY-MM-DD */
function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

/**
 * Migração inline — cria tabelas nfse e nfse_config se não existem
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

  // Valores padrão
  const insert = db.prepare('INSERT OR IGNORE INTO nfse_config (key, value) VALUES (?, ?)');
  insert.run('ambiente', '2');        // Homologação por padrão
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
 * Obtém e incrementa atomicamente o próximo número de DPS
 */
function proximoNumeroDPS(db) {
  const row = db.prepare("SELECT value FROM nfse_config WHERE key = 'proximo_numero'").get();
  const numero = parseInt(row?.value || '1', 10);
  db.prepare("UPDATE nfse_config SET value = ? WHERE key = 'proximo_numero'").run(String(numero + 1));
  return numero;
}

/**
 * Obtém valor de config NFSe
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

// ==================== REGISTRO DE ROTAS ====================

function registrarRotasNfse(app, db) {
  // Migrar banco
  migrarDB(db);

  // ---------- CONFIG ----------

  // GET /api/nfse/config — retorna configuração + status certificado + dados prestador
  app.get('/api/nfse/config', (req, res) => {
    try {
      const ambiente = getConfig(db, 'ambiente');
      const serie = getConfig(db, 'serie');
      const codMunicipio = getConfig(db, 'cod_municipio');
      const proximoNumero = getConfig(db, 'proximo_numero');

      // Status certificado
      const cert = db.prepare('SELECT titular, validade FROM certificado_digital WHERE id = 1').get();

      // Dados do fornecedor (prestador)
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

  // POST /api/nfse/config — alterar configurações
  app.post('/api/nfse/config', (req, res) => {
    try {
      const { ambiente, serie, codMunicipio } = req.body;

      if (ambiente !== undefined) {
        if (![1, 2, '1', '2'].includes(ambiente)) {
          return res.status(400).json({ success: false, error: 'Ambiente inválido (1=Produção, 2=Homologação)' });
        }
        setConfig(db, 'ambiente', ambiente);
      }
      if (serie !== undefined) setConfig(db, 'serie', serie);
      if (codMunicipio !== undefined) setConfig(db, 'cod_municipio', codMunicipio);

      res.json({ success: true, message: 'Configuração atualizada' });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // GET /api/nfse/prestador — dados do fornecedor para pré-preencher
  app.get('/api/nfse/prestador', (req, res) => {
    try {
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
      if (!fornecedor) {
        return res.json({ success: true, prestador: null, message: 'Fornecedor não cadastrado' });
      }
      res.json({ success: true, prestador: fornecedor });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- EMISSÃO ----------

  // POST /api/nfse/emitir — build → sign → gzip → POST SEFIN → salvar DB
  app.post('/api/nfse/emitir', async (req, res) => {
    try {
      const { tomador, servico, competencia } = req.body;

      // Validações
      if (!tomador || !tomador.cpfCnpj || !tomador.razaoSocial) {
        return res.status(400).json({ success: false, error: 'Dados do tomador obrigatórios (cpfCnpj, razaoSocial)' });
      }
      if (!servico || !servico.codigoTributacaoNacional || !servico.descricao || !servico.valorServico) {
        return res.status(400).json({ success: false, error: 'Dados do serviço obrigatórios (codigoTributacaoNacional, descricao, valorServico)' });
      }

      // Carregar dados
      const ambiente = parseInt(getConfig(db, 'ambiente') || '2', 10);
      const serie = getConfig(db, 'serie') || 'NFSE';
      const codMunicipio = getConfig(db, 'cod_municipio');

      if (!codMunicipio) {
        return res.status(400).json({ success: false, error: 'Código do município não configurado' });
      }

      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
      if (!fornecedor || !fornecedor.cnpj) {
        return res.status(400).json({ success: false, error: 'Dados do fornecedor não cadastrados' });
      }

      // Certificado
      const { p12Buffer, senha } = carregarCertificado(db);
      const { privateKeyPem, certDerBase64 } = extrairChavesCertificado(p12Buffer, senha);

      // Número DPS (atômico)
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
          inscricaoMunicipal: fornecedor.inscricaoMunicipal || '',
          codigoMunicipio: codMunicipio,
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
      };

      const dpsXml = construirDPS(dados);
      console.log(`[NFSe] DPS construída: ${idDps}`);

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

        res.json({
          success: true,
          nfse: {
            id: nfseId,
            idDps,
            nDPS,
            serie,
            chaveAcesso,
            nNFSe,
            status,
            resposta,
          },
        });
      } catch (sefinError) {
        console.error(`[NFSe] Erro SEFIN:`, sefinError.message);

        // Atualizar status como erro
        db.prepare(`
          UPDATE nfse SET status = 'erro', xmlRetorno = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(sefinError.message, nfseId);

        res.status(502).json({
          success: false,
          error: `Erro ao enviar para SEFIN: ${sefinError.message}`,
          nfse: { id: nfseId, idDps, nDPS, serie, status: 'erro' },
        });
      }
    } catch (error) {
      console.error('[NFSe] Erro na emissão:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- LISTAGEM ----------

  // GET /api/nfse/lista — histórico com filtros
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

  // ---------- PARÂMETROS MUNICIPAIS (antes de :id para evitar colisão) ----------

  // GET /api/nfse/parametros-municipais — consultar parâmetros (usa município da config)
  app.get('/api/nfse/parametros-municipais', async (req, res) => {
    return handleParametrosMunicipais(req, res, '');
  });

  // GET /api/nfse/parametros-municipais/:cod — consultar parâmetros de município específico
  app.get('/api/nfse/parametros-municipais/:cod', async (req, res) => {
    return handleParametrosMunicipais(req, res, req.params.cod);
  });

  async function handleParametrosMunicipais(req, res, cod) {
    try {
      cod = cod || getConfig(db, 'cod_municipio');
      if (!cod) {
        return res.status(400).json({ success: false, error: 'Código do município não informado' });
      }

      const { p12Buffer, senha } = carregarCertificado(db);
      const ambiente = parseInt(getConfig(db, 'ambiente') || '2', 10);
      const client = new NfseClient(p12Buffer, senha, ambiente);

      const parametros = await client.parametrosMunicipais(cod);

      res.json({ success: true, codMunicipio: cod, parametros });
    } catch (error) {
      console.error('[NFSe] Erro parâmetros municipais:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ---------- DETALHES ----------

  // GET /api/nfse/:id — detalhes de uma nota
  app.get('/api/nfse/:id', (req, res) => {
    try {
      const nota = db.prepare('SELECT * FROM nfse WHERE id = ?').get(req.params.id);
      if (!nota) {
        return res.status(404).json({ success: false, error: 'Nota não encontrada' });
      }
      res.json({ success: true, nota });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- DANFSE ----------

  // GET /api/nfse/:id/danfse — download PDF da DANFSE
  app.get('/api/nfse/:id/danfse', async (req, res) => {
    try {
      const nota = db.prepare('SELECT chaveAcesso, tpAmb FROM nfse WHERE id = ?').get(req.params.id);
      if (!nota) {
        return res.status(404).json({ success: false, error: 'Nota não encontrada' });
      }
      if (!nota.chaveAcesso) {
        return res.status(400).json({ success: false, error: 'Nota sem chave de acesso (não autorizada)' });
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

  // POST /api/nfse/:id/cancelar — cancelar nota
  app.post('/api/nfse/:id/cancelar', async (req, res) => {
    try {
      const { motivo } = req.body;
      if (!motivo || motivo.length < 15) {
        return res.status(400).json({ success: false, error: 'Motivo obrigatório (mínimo 15 caracteres)' });
      }

      const nota = db.prepare('SELECT id, chaveAcesso, tpAmb, status FROM nfse WHERE id = ?').get(req.params.id);
      if (!nota) {
        return res.status(404).json({ success: false, error: 'Nota não encontrada' });
      }
      if (nota.status === 'cancelada') {
        return res.status(400).json({ success: false, error: 'Nota já cancelada' });
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

module.exports = { registrarRotasNfse };
