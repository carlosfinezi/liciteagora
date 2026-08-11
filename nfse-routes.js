/**
 * nfse-routes.js — Endpoints REST para NFS-e Nacional
 *
 * Padrão: registrarRotasNfse(app, db)
 *
 * Uso no server.js (worker — HTTP):
 *   const { registrarRotasNfse } = require('./nfse-routes');
 *   registrarRotasNfse(app, db);
 *
 * Uso no master (scheduler / NFSE-M06):
 *   const { iniciarReconciliadorS6 } = require('./nfse-routes');
 *   iniciarReconciliadorS6(db);
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { gerarIdDps, construirDPS, assinarDPS, construirEventoCancelamento, assinarEvento, extrairChavesCertificado } = require('./nfse-xml');
const { tag } = require('./danfse-pdf');
const { NfseClient } = require('./nfse-client');
const { resolverEstab } = require('./nfe-emit-routes');
const { getEstabelecimentoAtivo } = require('./estabelecimentos-routes');
const { MercadoPagoClient, loadMPConfig } = require('./mercadopago-client');
const { enviarEmailCancelamento, enviarEmailNfse, loadSmtpConfig } = require('./email-client');

// NFSE-C03: idempotency em memória para evitar double-click / retry rápido
// na mesma emissão lógica. Chave = hash(cnpj_tomador|descricao|valor|competencia).
// TTL implícito = duração de uma emissão (concluída sucesso ou erro).
// Nao substitui solução completa (INSERT pendente_envio + reconciliação),
// mas fecha a porta mais frequente: usuário clicando duas vezes em "Emitir".
const _emissoesEmAndamento = new Map();

function _hashEmissao(params) {
  const raw = [
    (params.tomador?.cpfCnpj || '').replace(/\D/g, ''),
    (params.servico?.descricao || '').trim().slice(0, 120),
    Number(params.servico?.valorServico || 0).toFixed(2),
    params.competencia || '',
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/** Data atual em Brasilia (UTC-3) no formato YYYY-MM-DD */
function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

/**
 * Migracao inline — cria tabelas nfse e nfse_config se nao existem
 */
// Multi-tenant (2026-04-22): migrarDB() e seed de nfse_config migraram
// para db-schema.js (ambas idempotentes, rodam no provisionamento).
function migrarDB(_db) { /* no-op (ver db-schema.js) */ }

/**
 * Carrega certificado digital do banco de dados
 */
function carregarCertificado(db, estab = null) {
  const cert = (estab && !estab.matriz)
    ? db.prepare('SELECT certificadoBase64, senhaCriptografada, titular, validade FROM certificado_digital WHERE estabelecimentoId = ?').get(estab.id)
    : db.prepare('SELECT certificadoBase64, senhaCriptografada, titular, validade FROM certificado_digital WHERE id = 1').get();

  if (!cert) {
    throw new Error('Certificado digital não configurado. Configure em Dados do Fornecedor.');
  }

  const p12Buffer = Buffer.from(cert.certificadoBase64, 'base64');
  const senha = Buffer.from(cert.senhaCriptografada, 'base64').toString();

  return { p12Buffer, senha, titular: cert.titular, validade: cert.validade };
}

/**
 * Obtem e incrementa atomicamente o proximo numero de DPS (NFSE-C01)
 * Envolvido em transaction para evitar race condition entre SELECT e UPDATE
 * que produziria nDPS duplicado ou gap na numeracao fiscal.
 */
function proximoNumeroDPS(db, estab = null) {
  const fn = db.transaction(() => {
    // Matriz: nfse_config key/value (legado). Filial: estabelecimento_serie modelo 'NFSE'.
    if (!estab || estab.matriz) {
      const row = db.prepare("SELECT value FROM nfse_config WHERE key = 'proximo_numero'").get();
      const numero = parseInt(row?.value || '1', 10);
      db.prepare("UPDATE nfse_config SET value = ? WHERE key = 'proximo_numero'").run(String(numero + 1));
      return numero;
    }
    let r = db.prepare("SELECT proximoNumero FROM estabelecimento_serie WHERE estabelecimentoId = ? AND modelo = 'NFSE'").get(estab.id);
    if (!r) {
      db.prepare("INSERT INTO estabelecimento_serie (estabelecimentoId, modelo, serie, proximoNumero) VALUES (?, 'NFSE', 1, 1)").run(estab.id);
      r = { proximoNumero: 1 };
    }
    const numero = r.proximoNumero;
    db.prepare("UPDATE estabelecimento_serie SET proximoNumero = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE estabelecimentoId = ? AND modelo = 'NFSE'").run(numero + 1, estab.id);
    return numero;
  });
  return fn();
}

/**
 * Envia DANFSE + boleto (se houver) por email ao tomador de uma NFSe autorizada.
 * Reutilizável: usado tanto na emissão avulsa (passando client+boleto já em mãos)
 * quanto no reenvio manual (busca tudo do banco). Não-fatal — o caller trata erro.
 */
async function enviarEmailDaNfse(db, nfseId, opts = {}) {
  const nota = db.prepare('SELECT * FROM nfse WHERE id = ?').get(nfseId);
  if (!nota) return { success: false, error: 'NFSe não encontrada' };
  if (nota.status !== 'autorizada' || !nota.chaveAcesso) return { success: false, error: 'NFSe não autorizada (sem chave)' };

  const cpfLimpo = (nota.tomadorCpfCnpj || '').replace(/\D/g, '');
  const pessoa = db.prepare('SELECT email, emailsAdicionais FROM pessoas WHERE cpfCnpj = ?').get(cpfLimpo);
  const to = pessoa && pessoa.email;
  if (!to) return { success: false, error: 'Tomador sem email cadastrado' };
  const cc = (pessoa.emailsAdicionais
    ? pessoa.emailsAdicionais.split(',').map(e => e.trim()).filter(Boolean).join(', ')
    : '') || undefined;

  // DANFSE (reusa o client da emissão se veio; senão instancia com o certificado)
  let pdfBuffer = null;
  try {
    let client = opts.client;
    if (!client) {
      const { p12Buffer, senha } = carregarCertificado(db);
      client = new NfseClient(p12Buffer, senha, nota.tpAmb);
    }
    pdfBuffer = await client.downloadDanfse(nota.chaveAcesso);
  } catch (e) {
    console.error('[NFSe email] Erro baixando DANFSE:', e.message);
  }

  // Boleto vinculado à conta a receber da NFSe (linha digitável + url)
  let boletoWritableLine = (opts.boleto && (opts.boleto.linhaDigitavel || opts.boleto.writableLine)) || null;
  let boletoUrl = (opts.boleto && opts.boleto.externalUrl) || null;
  if (!boletoWritableLine || !boletoUrl) {
    try {
      const conta = db.prepare('SELECT id FROM contas_a_receber WHERE nfseId = ? ORDER BY id DESC LIMIT 1').get(nfseId);
      if (conta) {
        const bol = db.prepare('SELECT writableLine, linhaDigitavel, externalUrl FROM boletos WHERE contaReceberId = ? ORDER BY id DESC LIMIT 1').get(conta.id);
        if (bol) {
          boletoWritableLine = boletoWritableLine || bol.linhaDigitavel || bol.writableLine || null;
          boletoUrl = boletoUrl || bol.externalUrl || null;
        }
      }
    } catch (e) {}
  }

  await enviarEmailNfse(db, {
    to, cc,
    nfseNumero: nota.nNFSe || '',
    descricao: nota.descricaoServico,
    valor: nota.valorServico,
    competencia: nota.dataCompetencia,
    pdfBuffer,
    boletoWritableLine,
    boletoUrl,
  });
  return { success: true, to, cc, temPdf: !!pdfBuffer, temBoleto: !!boletoWritableLine };
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

// ==================== STATUS DE HABILITACAO DO MUNICIPIO ====================
//
// Cache informativo: marca o município como habilitado quando uma emissão
// é autorizada pela SEFIN. Usado pelo badge no UI de nfse.html.
//
// Não bloqueamos emissão por cache negativo: o erro E0039 da SEFIN é
// genérico ("município não parametrizado") e na prática cobre várias
// causas (IM inválida, opSimpNac errado, etc.). Bloquear cego mascararia
// erros corrigíveis. Aprendemos só com sucesso.

const MUNICIPIO_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function lerCacheMunicipio(db, codMunicipio) {
  if (!codMunicipio) return { ok: null };
  const raw = getConfig(db, `municipio_habilitado_${codMunicipio}`);
  if (!raw) return { ok: null };
  try {
    const c = JSON.parse(raw);
    if (c.ts && (Date.now() - c.ts) < MUNICIPIO_CACHE_TTL_MS) {
      return { ok: c.ok, ts: c.ts };
    }
  } catch { /* cache corrompido */ }
  return { ok: null };
}

function marcarCacheMunicipio(db, codMunicipio, ok) {
  if (!codMunicipio) return;
  setConfig(db, `municipio_habilitado_${codMunicipio}`, JSON.stringify({
    ok,
    ts: Date.now(),
  }));
}

function limparCacheMunicipio(db, codMunicipio) {
  if (!codMunicipio) return;
  db.prepare('DELETE FROM nfse_config WHERE key = ?').run(`municipio_habilitado_${codMunicipio}`);
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
  const { tomador, servico, competencia, incluirIM, opSimpNac, regEspTrib, pTotTribSN, gerarBoleto, dataVencimentoBoleto, osId, contaFinanceiraId } = params;

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

  // Multi-loja: prestador emissor (params.estabelecimentoId; NULL = matriz).
  // Para filial, o "fornecedor" (prestador) é a linha de estabelecimentos, que
  // carrega cnpj, inscricaoMunicipal, codigoMunicipio e regimeTributario.
  const estab = resolverEstab(db, params.estabelecimentoId);
  const fornecedor = (estab && !estab.matriz)
    ? estab
    : db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
  if (!fornecedor || !fornecedor.cnpj) {
    return { success: false, error: 'Dados do fornecedor nao cadastrados' };
  }

  // Código IBGE do município: fonte primária é o cadastro do fornecedor
  // (preenchido automaticamente pela busca de CNPJ em minha-empresa.html).
  // `nfse_config.cod_municipio` permanece como override manual avançado.
  const codMunicipio = fornecedor.codigoMunicipio || getConfig(db, 'cod_municipio');

  if (!codMunicipio) {
    return { success: false, error: 'Codigo IBGE do municipio nao configurado em Minha Empresa' };
  }

  // NFSE-C03: idempotency check — bloqueia emissões lógicas duplicadas
  // concorrentes (mesmo tomador + descrição + valor + competência) antes
  // de consumir nDPS. Fecha a janela de double-click sem a solução completa.
  const idempKey = _hashEmissao({
    tomador,
    servico,
    competencia: competencia || dataBrasilia(),
  });
  if (_emissoesEmAndamento.has(idempKey)) {
    return {
      success: false,
      code: 'EMISSAO_EM_ANDAMENTO',
      error: 'Emissao identica ja esta em andamento. Aguarde a conclusao antes de reenviar.',
    };
  }
  _emissoesEmAndamento.set(idempKey, Date.now());

  try { // NFSE-C03: try/finally garante liberacao da chave em qualquer caminho

  // Certificado
  const { p12Buffer, senha } = carregarCertificado(db, estab);
  const { privateKeyPem, certDerBase64 } = extrairChavesCertificado(p12Buffer, senha);

  const client = new NfseClient(p12Buffer, senha, ambiente);

  // Numero DPS (atomico) — por estabelecimento
  const nDPS = proximoNumeroDPS(db, estab);

  // ID da DPS
  const idDps = gerarIdDps(codMunicipio, fornecedor.cnpj, serie, nDPS);

  // Construir XML
  const dados = {
    idDps,
    tpAmb: ambiente,
    serie,
    nDPS,
    competencia: competencia || dataBrasilia(),
    prestador: (() => {
      // Deriva opSimpNac/regApTribSN/incluirIM do regime tributário cadastrado
      // em Minha Empresa. Parâmetros explícitos (opSimpNac/incluirIM) ainda
      // têm prioridade — útil pra cenários ad-hoc (recorrência, etc).
      const regime = fornecedor.regimeTributario || ''; // '' = comportamento legado
      let opSimpNacDef = 3, regApTribSNDef = 1, incluirIMDef = true;
      if (regime === 'MEI') {
        opSimpNacDef = 2; regApTribSNDef = null; incluirIMDef = false;
      } else if (regime === 'NAO_OPTANTE') {
        opSimpNacDef = 1; regApTribSNDef = null; incluirIMDef = true;
      } else if (regime === 'SIMPLES_NACIONAL') {
        opSimpNacDef = 3; regApTribSNDef = 1; incluirIMDef = true;
      }
      const opEffective = opSimpNac || opSimpNacDef;
      const incluirEffective = (incluirIM === false || incluirIM === true) ? incluirIM : incluirIMDef;
      return {
        cnpj: fornecedor.cnpj,
        inscricaoMunicipal: incluirEffective ? (fornecedor.inscricaoMunicipal || '') : '',
        codigoMunicipio: codMunicipio,
        opSimpNac: opEffective,
        regApTribSN: regApTribSNDef,
        regEspTrib: regEspTrib || 0,
      };
    })(),
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
      cNBS: servico.cNBS,
      xNBS: servico.xNBS,
      descricao: servico.descricao,
      valorServico: servico.valorServico,
      valorDeducoes: servico.valorDeducoes,
      aliquota: servico.aliquota,
      // SEFIN aceita só código IBGE de 7 dígitos no cLocPrestacao. Se o caller
      // mandou algo não-numérico (ex: "Maceio" digitado no input), descarta e
      // cai pro código do prestador. Evita rejeição com erro E1235 no schema.
      codigoMunicipioPrestacao: /^\d{7}$/.test(String(servico.codigoMunicipioPrestacao || '').trim())
        ? String(servico.codigoMunicipioPrestacao).trim()
        : codMunicipio,
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
      tomadorEndereco, codigoTributacaoNacional, cNBS, xNBS, descricaoServico, valorServico,
      dataCompetencia, status, xmlEnvio)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processando', ?)
  `);

  const result = insertStmt.run(
    idDps, serie, nDPS, ambiente,
    tomador.cpfCnpj, tomador.razaoSocial,
    tomador.endereco ? JSON.stringify(tomador.endereco) : null,
    servico.codigoTributacaoNacional,
    servico.cNBS || null,
    servico.xNBS || null,
    servico.descricao,
    servico.valorServico,
    competencia || dataBrasilia(),
    signedXml
  );
  const nfseId = result.lastInsertRowid;

  // Phase 2: quando emitido a partir de uma OS, liga a nota à OS
  if (osId) {
    try { db.prepare('UPDATE nfse SET osId = ? WHERE id = ?').run(osId, nfseId); }
    catch (_) {}
  }

  // Enviar para SEFIN (reusa client criado no pre-check)
  try {
    const resposta = await client.emitirNfse(signedXml, idDps);

    console.log(`[NFSe] Resposta SEFIN:`, JSON.stringify(resposta).substring(0, 500));

    // Atualizar com resposta
    const chaveAcesso = resposta.chaveAcesso || resposta.chNFSe || '';
    // SEFIN não devolve nNFSe direto na resposta JSON; está dentro do XML
    // autorizado em `nfseXmlGZipB64`. Falha silenciosa preserva chaveAcesso.
    let nNFSe = resposta.nNFSe || resposta.numero || '';
    if (!nNFSe && resposta.nfseXmlGZipB64) {
      try {
        const xmlAutorizado = zlib.gunzipSync(Buffer.from(resposta.nfseXmlGZipB64, 'base64')).toString('utf-8');
        nNFSe = tag(xmlAutorizado, 'nNFSe') || '';
      } catch (e) {
        console.warn('[NFSe] Falha extraindo nNFSe do XML autorizado:', e.message);
      }
    }
    const status = chaveAcesso ? 'autorizada' : (resposta.motivo ? 'rejeitada' : 'processando');

    // Marca município como habilitado quando SEFIN aceita (chave gerada).
    if (chaveAcesso) {
      marcarCacheMunicipio(db, codMunicipio, true);
    }

    db.prepare(`
      UPDATE nfse SET chaveAcesso = ?, nNFSe = ?, status = ?, xmlRetorno = ?, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(chaveAcesso, nNFSe, status, JSON.stringify(resposta), nfseId);

    // Integracao Financeiro: sempre gerar pessoa + conta a receber; boleto so se pedido
    let contaCriada = null;
    let boletoCriado = null;
    if (status === 'autorizada') {
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

        let contaId;
        if (osId) {
          // Phase 2: OS já possui CRs do tipo 'os_servicos' (criadas no faturamento).
          // Liga a NFSe nelas em vez de criar uma nova CR duplicada.
          db.prepare(`UPDATE contas_a_receber SET nfseId = ?, dataAtualizacao = CURRENT_TIMESTAMP
            WHERE osId = ? AND origemTipo = 'os_servicos' AND nfseId IS NULL`)
            .run(nfseId, osId);
          const cr = db.prepare(`SELECT id FROM contas_a_receber WHERE osId = ? AND origemTipo = 'os_servicos' ORDER BY id LIMIT 1`).get(osId);
          contaId = cr?.id;
          console.log(`[NFSe->OS #${osId}] NFSe #${nfseId} ligada a CR(s) existentes`);
        } else {
          // Fluxo padrão (emissão manual NFSe sem OS): cria CR nova.
          const formaPgto = gerarBoleto ? 'boleto' : 'outros';
          contaId = db.prepare(`INSERT INTO contas_a_receber
            (pessoaId, nfseId, descricao, valor, dataEmissao, dataVencimento, formaPagamento, contaFinanceiraId)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(pessoa.id, nfseId, descConta, valor, dataBrasilia(), dataVenc, formaPgto, contaFinanceiraId || null).lastInsertRowid;
          console.log(`[NFSe->Financeiro] Conta #${contaId} criada para NFSe #${nfseId}${contaFinanceiraId ? ' (contaFinanceira #'+contaFinanceiraId+')' : ''}`);
        }

        contaCriada = contaId ? { id: contaId } : null;

        // Emissão de boleto: delegada ao orquestrador de provedores (provider registry)
        // Se a conta financeira vinculada à CR tiver provedor ativo (MP, Sicredi, etc.),
        // o orquestrador resolve qual provedor usar. Sem config ativa, retorna skipped
        // e não gera boleto. Fluxo não-fatal: falha não bloqueia a emissão da NFSe.
        if (gerarBoleto && contaId) {
          try {
            const { emitirBoletoParaCR } = require('./boleto-orchestrator');
            const rBol = await emitirBoletoParaCR(db, contaId);
            if (rBol.sucesso) {
              boletoCriado = {
                id: rBol.boletoId,
                status: 'registrado',
                provedor: rBol.provedor,
                nossoNumero: rBol.nossoNumero,
                linhaDigitavel: rBol.linhaDigitavel,
              };
              console.log(`[NFSe->Boleto] Boleto #${rBol.boletoId} emitido via ${rBol.provedor} (nossoNumero=${rBol.nossoNumero})`);
            } else {
              console.log(`[NFSe->Boleto] Skipped: ${rBol.motivo}`);
            }
          } catch (bolErr) {
            console.error('[NFSe->Boleto] Erro (não-fatal):', bolErr.message);
          }
        }
      } catch (finErr) {
        console.error('[NFSe->Financeiro] Erro ao criar financeiro (nao-fatal):', finErr.message);
      }

      // Envia DANFSE + boleto por email ao tomador (mesmo fluxo da recorrência).
      // A emissão avulsa NÃO fazia isso — só a recorrência enviava (gap corrigido 2026-07-01).
      // Não-fatal: falha de email não invalida a emissão.
      try {
        const rEmail = await enviarEmailDaNfse(db, nfseId, { client, boleto: boletoCriado });
        if (rEmail && !rEmail.success) console.warn(`[NFSe->Email] NFSe #${nfseId} não enviada:`, rEmail.error);
        else console.log(`[NFSe->Email] NFSe #${nfseId} enviada ao tomador (pdf=${rEmail?.temPdf}, boleto=${rEmail?.temBoleto})`);
      } catch (emailErr) {
        console.error('[NFSe->Email] Erro (não-fatal):', emailErr.message);
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

    // E0039 NÃO marca município como bloqueado: SEFIN reusa esse código pra
    // várias condições (IM inválida, opSimpNac errado, etc.). Manaus emite
    // 100% e Maceió tem nota REAL autorizada pelo portal — bloqueio cego
    // por E0039 mascararia erros corrigíveis. O cache só ganha entrada
    // POSITIVA (ok=true) ao emitir com sucesso, virando badge verde no UI.

    return {
      success: false,
      error: `Erro ao enviar para SEFIN: ${sefinError.message}`,
      nfse: { id: nfseId, idDps, nDPS, serie, status: 'erro' },
    };
  }

  } finally {
    // NFSE-C03: libera a chave de idempotencia em qualquer caminho
    _emissoesEmAndamento.delete(idempKey);
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
      const codMunicipioOverride = getConfig(db, 'cod_municipio');
      const proximoNumero = getConfig(db, 'proximo_numero');

      const cert = db.prepare('SELECT titular, validade FROM certificado_digital WHERE id = 1').get();
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();

      // Fonte primária: fornecedor.codigoMunicipio (cadastro). Override: nfse_config.
      const codMunicipio = (fornecedor && fornecedor.codigoMunicipio) || codMunicipioOverride;

      // Status de habilitação SEFIN (lê só cache; null se nunca consultado).
      let municipioHabilitado = null;
      let municipioHabilitadoTs = null;
      if (codMunicipio) {
        const raw = getConfig(db, `municipio_habilitado_${codMunicipio}`);
        if (raw) {
          try {
            const c = JSON.parse(raw);
            municipioHabilitado = c.ok;
            municipioHabilitadoTs = c.ts || null;
          } catch { /* ignora cache corrompido */ }
        }
      }

      res.json({
        success: true,
        config: {
          ambiente, serie, codMunicipio, codMunicipioOverride, proximoNumero,
          municipioHabilitado, municipioHabilitadoTs,
        },
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

  // POST /api/nfse/revalidar-municipio — limpa o cache de habilitação para
  // permitir nova tentativa real de emissão. Útil após o cliente fazer
  // a "Adesão" no portal SEFIN: limpa o veto antigo, próxima emissão testa.
  app.post('/api/nfse/revalidar-municipio', (req, res) => {
    try {
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
      const codMunicipio = (fornecedor && fornecedor.codigoMunicipio) || getConfig(db, 'cod_municipio');
      if (!codMunicipio) {
        return res.status(400).json({ success: false, error: 'Código IBGE não configurado em Minha Empresa' });
      }

      limparCacheMunicipio(db, codMunicipio);
      res.json({
        success: true,
        codMunicipio,
        message: 'Cache de habilitação limpo. A próxima tentativa de emissão vai testar o município novamente na SEFIN.',
      });
    } catch (error) {
      console.error('[NFSe] Erro limpando cache de município:', error.message);
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
      const _e = getEstabelecimentoAtivo(db, req);
      const resultado = await emitirNfseInterno(db, {
        estabelecimentoId: (_e && !_e.matriz) ? _e.id : null,
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

  // Reenvia (ou envia pela 1ª vez) a DANFSE + boleto de uma NFSe já autorizada.
  // Serve p/ NFSe avulsa antiga que não recebeu email, e p/ reenvio manual.
  app.post('/api/nfse/:id/enviar-email', async (req, res) => {
    try {
      const r = await enviarEmailDaNfse(db, parseInt(req.params.id));
      if (!r.success) return res.status(400).json(r);
      res.json({ ...r, message: `Email enviado para ${r.to}` });
    } catch (error) {
      console.error('[NFSe] Erro no reenvio de email:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------- LISTAGEM ----------

  app.get('/api/nfse/lista', (req, res) => {
    try {
      const { status, busca, limite, dataInicio, dataFim } = req.query;
      const lim = Math.min(parseInt(limite) || 50, 200);

      let sql = 'SELECT id, idDps, serie, nDPS, tpAmb, chaveAcesso, nNFSe, tomadorCpfCnpj, tomadorRazaoSocial, codigoTributacaoNacional, descricaoServico, valorServico, dataCompetencia, status, dataCriacao, dataAtualizacao FROM nfse WHERE 1=1';
      const params = [];

      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }

      if (dataInicio) {
        sql += ' AND dataCompetencia >= ?';
        params.push(dataInicio);
      }

      if (dataFim) {
        sql += ' AND dataCompetencia <= ?';
        params.push(dataFim);
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

      const resultado = await client.parametrosMunicipais(cod);

      if (!resultado.ok) {
        return res.status(resultado.status === 404 ? 404 : 502).json({
          success: false,
          codMunicipio: cod,
          error: resultado.status === 404
            ? 'Município não habilitado no Padrão Nacional NFS-e (sem convênio cadastrado).'
            : `SEFIN retornou ${resultado.status}`,
          parametros: resultado.data,
        });
      }

      res.json({ success: true, codMunicipio: cod, parametros: resultado.data });
    } catch (error) {
      console.error('[NFSe] Erro parametros municipais:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  }

  // ---------- DETALHES ----------

  app.get('/api/nfse/:id', (req, res) => {
    try {
      // NFSE-H04: whitelist de colunas — nao expor xmlEnvio (payload assinado
      // completo, inclui certificado publico) nem outros campos sensiveis.
      // xmlRetorno eh incluido porque o frontend exibe "Resposta SEFIN" nos
      // detalhes; se desejar endurecer mais, criar rota separada com ACL.
      const nota = db.prepare(`SELECT
        id, idDps, serie, nDPS, tpAmb, chaveAcesso, nNFSe,
        tomadorCpfCnpj, tomadorRazaoSocial, tomadorEndereco,
        codigoTributacaoNacional, descricaoServico, valorServico,
        dataCompetencia, status, xmlRetorno, motivoCancelamento,
        dataCriacao, dataAtualizacao
      FROM nfse WHERE id = ?`).get(req.params.id);
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
      const nota = db.prepare('SELECT chaveAcesso, tpAmb, tomadorCpfCnpj, xmlRetorno FROM nfse WHERE id = ?').get(req.params.id);
      if (!nota) {
        return res.status(404).json({ success: false, error: 'Nota nao encontrada' });
      }
      if (!nota.chaveAcesso) {
        return res.status(400).json({ success: false, error: 'Nota sem chave de acesso (nao autorizada)' });
      }

      const { p12Buffer, senha } = carregarCertificado(db);
      const client = new NfseClient(p12Buffer, senha, nota.tpAmb);

      // Buscar dados complementares do banco para preencher campos vazios no PDF
      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
      const cpfLimpo = (nota.tomadorCpfCnpj || '').replace(/\D/g, '');
      const pessoa = cpfLimpo ? db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(cpfLimpo) : null;
      const dadosComplementares = { fornecedor, pessoa };

      // Gerar PDF local a partir do XML da SEFIN (com dados complementados)
      const { gerarDanfseDeGzipB64 } = require('./danfse-pdf');

      // Preferir XML já armazenado na emissão (evita depender da SEFIN, que pode dar ECONNRESET)
      let gzipB64 = null;
      if (nota.xmlRetorno) {
        try {
          gzipB64 = JSON.parse(nota.xmlRetorno).nfseXmlGZipB64 || null;
        } catch (_) { /* xmlRetorno nao-JSON: ignora e consulta SEFIN */ }
      }

      // Sem XML salvo: buscar na SEFIN
      if (!gzipB64) {
        const xmlResp = await client.consultarNfse(nota.chaveAcesso);
        gzipB64 = (xmlResp && xmlResp.nfseXmlGZipB64) || null;
      }

      if (gzipB64) {
        const pdfBuffer = await gerarDanfseDeGzipB64(gzipB64, dadosComplementares);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="DANFSE_${nota.chaveAcesso}.pdf"`);
        return res.send(pdfBuffer);
      }

      // Fallback: tentar PDF oficial da SEFIN
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
    let nota; // visível no catch para eventual rollback de status
    try {
      const { motivo, codigoMotivo } = req.body;
      if (!motivo || motivo.length < 15) {
        return res.status(400).json({ success: false, error: 'Motivo obrigatorio (minimo 15 caracteres)' });
      }

      // NFSE-C04: lock atômico — uma única transação valida status e move
      // para 'cancelamento_pendente'. Dois cliques concorrentes: segundo
      // recebe 409 Conflict e nao chega a chamar SEFIN.
      const lockFn = db.transaction((id) => {
        const n = db.prepare('SELECT id, chaveAcesso, tpAmb, status, nNFSe, nDPS, descricaoServico, valorServico, dataCompetencia, tomadorCpfCnpj FROM nfse WHERE id = ?').get(id);
        if (!n) return { err: 'nao_encontrada' };
        if (n.status === 'cancelada') return { err: 'ja_cancelada' };
        if (n.status === 'cancelamento_pendente') return { err: 'em_andamento' };
        if (n.status !== 'autorizada') return { err: 'status_invalido', status: n.status };
        if (!n.chaveAcesso) return { err: 'sem_chave' };
        db.prepare("UPDATE nfse SET status='cancelamento_pendente', dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?").run(id);
        return { nota: n };
      });
      const lock = lockFn(req.params.id);
      if (lock.err) {
        const msgs = {
          nao_encontrada:   { code: 404, msg: 'Nota nao encontrada' },
          ja_cancelada:     { code: 400, msg: 'Nota ja cancelada' },
          em_andamento:     { code: 409, msg: 'Cancelamento ja em andamento para esta nota' },
          status_invalido:  { code: 400, msg: `Status invalido para cancelamento: ${lock.status}` },
          sem_chave:        { code: 400, msg: 'Nota sem chave de acesso' },
        };
        const r = msgs[lock.err];
        return res.status(r.code).json({ success: false, error: r.msg });
      }
      nota = lock.nota;

      const { p12Buffer, senha } = carregarCertificado(db);
      const { privateKeyPem, certDerBase64 } = extrairChavesCertificado(p12Buffer, senha);

      const fornecedor = db.prepare('SELECT * FROM fornecedor WHERE id = 1').get();
      if (!fornecedor || !fornecedor.cnpj) {
        db.prepare("UPDATE nfse SET status='autorizada', dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?").run(nota.id);
        return res.status(400).json({ success: false, error: 'Dados do fornecedor nao cadastrados' });
      }

      // Construir e assinar XML do evento de cancelamento (tpEvento=101101).
      // SEFIN Nacional exige XML assinado (XMLDSIG) entregue como gzip+base64
      // dentro de JSON {eventoXmlGZipB64} — análogo à emissão da DPS.
      const codMotivo = parseInt(codigoMotivo) || 1;
      const eventoXml = construirEventoCancelamento({
        chaveAcesso: nota.chaveAcesso,
        tpAmb: nota.tpAmb,
        nSeqEvento: 1,
        codigoMotivo: codMotivo,
        justificativa: motivo,
        cnpjAutor: fornecedor.cnpj,
        codMunicipio: fornecedor.codigoMunicipio,
      });
      console.log('[NFSe] Evento cancelamento XML construído');

      const signedEventoXml = assinarEvento(eventoXml, privateKeyPem, certDerBase64);
      console.log('[NFSe] Evento cancelamento assinado');

      const client = new NfseClient(p12Buffer, senha, nota.tpAmb);
      const resposta = await client.cancelarNfse(nota.chaveAcesso, signedEventoXml);
      console.log(`[NFSe] Cancelamento resposta:`, JSON.stringify(resposta).substring(0, 300));

      // NFSE-C04: finalização atômica — três UPDATEs (nfse + conta + boleto)
      // em uma única transação. Se falhar, estado permanece consistente e
      // worker futuro (S6) pode reconciliar via consultarNfse.
      const finalizar = db.transaction(() => {
        db.prepare(`
          UPDATE nfse SET status='cancelada', motivoCancelamento=?, xmlRetorno=?, dataAtualizacao=CURRENT_TIMESTAMP
          WHERE id=?
        `).run(motivo, JSON.stringify(resposta), nota.id);

        const conta = db.prepare('SELECT id FROM contas_a_receber WHERE nfseId = ? AND status != ?').get(nota.id, 'cancelada');
        let contaId = null, boletoId = null;
        if (conta) {
          db.prepare("UPDATE contas_a_receber SET status='cancelada', observacoes=COALESCE(observacoes || ' | ', '') || 'Cancelada por cancelamento NFSe', dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?")
            .run(conta.id);
          contaId = conta.id;
          const boleto = db.prepare('SELECT id FROM boletos WHERE contaReceberId = ? AND status != ?').get(conta.id, 'cancelado');
          if (boleto) {
            db.prepare("UPDATE boletos SET status='cancelado', dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?").run(boleto.id);
            boletoId = boleto.id;
          }
        }
        return { contaId, boletoId };
      });
      const resultFin = finalizar();
      if (resultFin.contaId) console.log(`[NFSe] Conta a receber #${resultFin.contaId} cancelada`);
      if (resultFin.boletoId) console.log(`[NFSe] Boleto #${resultFin.boletoId} cancelado`);

      // Enviar email de cancelamento ao tomador
      let emailStatus = 'nao';
      try {
        const cpfLimpo = (nota.tomadorCpfCnpj || '').replace(/\D/g, '');
        const pessoa = cpfLimpo ? db.prepare('SELECT email, emailsAdicionais FROM pessoas WHERE cpfCnpj = ?').get(cpfLimpo) : null;

        if (pessoa && pessoa.email && loadSmtpConfig(db)) {
          const ccList = pessoa.emailsAdicionais
            ? pessoa.emailsAdicionais.split(',').map(e => e.trim()).filter(Boolean)
            : [];

          await enviarEmailCancelamento(db, {
            to: pessoa.email,
            cc: ccList.length ? ccList.join(', ') : undefined,
            nfseNumero: nota.nNFSe || nota.nDPS || '',
            descricao: nota.descricaoServico || '',
            valor: nota.valorServico,
            competencia: nota.dataCompetencia || '',
            motivo,
          });
          emailStatus = 'sim';
        }
      } catch (emailErr) {
        console.error(`[NFSe] Erro email cancelamento:`, emailErr.message);
        emailStatus = 'erro';
      }

      res.json({ success: true, message: 'Nota cancelada com sucesso', emailEnviado: emailStatus, resposta });
    } catch (error) {
      console.error('[NFSe] Erro ao cancelar:', error.message);
      // NFSE-C04: se tínhamos lock em 'cancelamento_pendente' e falhou
      // antes de finalizar, volta para 'autorizada' para nao deixar a nota
      // travada. Erros transientes poderão ser reprocessados pelo worker S6.
      try {
        if (nota && nota.id) {
          const atual = db.prepare("SELECT status FROM nfse WHERE id=?").get(nota.id);
          if (atual && atual.status === 'cancelamento_pendente') {
            db.prepare("UPDATE nfse SET status='autorizada', dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?").run(nota.id);
            console.log(`[NFSe] Rollback lock cancelamento nota #${nota.id} → autorizada`);
          }
        }
      } catch (rbErr) {
        console.error('[NFSe] Rollback lock cancelamento falhou:', rbErr.message);
      }
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // NFSE-M06 (2026-04-20): reconciliador S6 foi extraído para módulo-level.
  // server.js master chama iniciarReconciliadorS6(db) explicitamente dentro
  // de _iniciarSchedulersMaster. Esta função aqui só registra as rotas HTTP.
  console.log('[NFSe] Rotas registradas');
}


// ==================== NFSE-M05/M06: Reconciliador S6 ====================
// Reprocessa automaticamente notas em status 'processando' consultando a SEFIN.
// Movido para módulo-level em NFSE-M06 para permitir start explícito pelo
// scheduler master (server.js / scheduler.js futuro), desacoplado do ciclo
// de vida das rotas HTTP.
//
// Política:
//   - rows com chaveAcesso + >5min: consulta SEFIN para decidir autorizada|rejeitada
//   - rows sem chaveAcesso + >1h:  marca erro_timeout (bloqueia para reemissão manual)
//   - Intervalo: 15min; primeira execução 30s após start.
function _reconciliarNotasPendentesImpl(db) {
  try {
    const notas = db.prepare(`
      SELECT id, chaveAcesso, tpAmb, nNFSe, dataCriacao
      FROM nfse
      WHERE status = 'processando'
        AND datetime(dataCriacao) < datetime('now', '-5 minutes')
      ORDER BY id ASC
      LIMIT 50
    `).all();

    if (!notas.length) return;
    console.log(`[NFSe][reconciler] ${notas.length} nota(s) pendente(s)...`);

    let cert;
    try { cert = carregarCertificado(db); }
    catch (e) {
      console.error('[NFSe][reconciler] Sem certificado — abortando ciclo:', e.message);
      return;
    }

    (async () => {
      for (const n of notas) {
        try {
          if (!n.chaveAcesso) {
            const idadeMs = Date.now() - new Date(n.dataCriacao).getTime();
            if (idadeMs > 60 * 60 * 1000) {
              db.prepare(`
                UPDATE nfse
                SET status = 'erro_timeout',
                    xmlRetorno = 'NFSE-M05: sem chaveAcesso por >1h — marcada como timeout',
                    dataAtualizacao = CURRENT_TIMESTAMP
                WHERE id = ?
              `).run(n.id);
              console.log(`[NFSe][reconciler] nota ${n.id}: erro_timeout (sem chave >1h)`);
            }
            continue;
          }

          const client = new NfseClient(cert.p12Buffer, cert.senha, n.tpAmb || 2);
          const resp = await client.consultarNfse(n.chaveAcesso);

          if (resp && (resp.nfseXmlGZipB64 || resp.chaveAcesso)) {
            let nNFSe = resp.nNFSe || resp.numero || n.nNFSe || '';
            if (!nNFSe && resp.nfseXmlGZipB64) {
              try {
                const xmlAutorizado = zlib.gunzipSync(Buffer.from(resp.nfseXmlGZipB64, 'base64')).toString('utf-8');
                nNFSe = tag(xmlAutorizado, 'nNFSe') || '';
              } catch { /* mantém vazio se decode falhar */ }
            }
            db.prepare(`
              UPDATE nfse
              SET status = 'autorizada',
                  nNFSe = COALESCE(NULLIF(?, ''), nNFSe),
                  xmlRetorno = ?,
                  dataAtualizacao = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'processando'
            `).run(nNFSe, JSON.stringify(resp).substring(0, 10000), n.id);
            console.log(`[NFSe][reconciler] nota ${n.id}: autorizada (chave ${n.chaveAcesso})`);
          } else if (resp && resp.motivo) {
            db.prepare(`
              UPDATE nfse
              SET status = 'rejeitada',
                  xmlRetorno = ?,
                  dataAtualizacao = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'processando'
            `).run(JSON.stringify(resp).substring(0, 10000), n.id);
            console.log(`[NFSe][reconciler] nota ${n.id}: rejeitada`);
          }
        } catch (errRec) {
          console.error(`[NFSe][reconciler] nota ${n.id} falhou:`, errRec.message);
        }
      }
    })().catch(err => console.error('[NFSe][reconciler] loop erro:', err.message));
  } catch (err) {
    console.error('[NFSe][reconciler] ciclo erro:', err.message);
  }
}

// Idempotente por db: múltiplas chamadas para o mesmo tenant não iniciam
// timers duplicados, mas cada tenant tem o seu próprio par de timers. Antes
// era um único `_reconcilerState` global, o que fazia a primeira chamada
// "ganhar" e todos os demais tenants serem ignorados (NFSe pendentes nunca
// reconciliadas em multi-tenant).
// Respeita NFSE_RECONCILER_DISABLED=1 como kill switch.
const _reconcilerStates = new Map();
function iniciarReconciliadorS6(db, opts = {}) {
  if (_reconcilerStates.has(db)) {
    console.log('[NFSe] Reconciliador S6 já está rodando para este tenant — chamada ignorada');
    return false;
  }
  if (process.env.NFSE_RECONCILER_DISABLED === '1') {
    console.log('[NFSe] Reconciliador S6 desabilitado via NFSE_RECONCILER_DISABLED=1');
    return false;
  }
  const bootDelayMs = opts.bootDelayMs || 30 * 1000;
  const loopIntervalMs = opts.loopIntervalMs || 15 * 60 * 1000;
  const state = {
    bootTimer: setTimeout(() => _reconciliarNotasPendentesImpl(db), bootDelayMs),
    loopInterval: setInterval(() => _reconciliarNotasPendentesImpl(db), loopIntervalMs),
  };
  _reconcilerStates.set(db, state);
  console.log(`[NFSe] Reconciliador S6 ativo (bootDelay=${Math.round(bootDelayMs/1000)}s, loop=${Math.round(loopIntervalMs/60000)}min)`);
  return true;
}

function pararReconciliadorS6(db) {
  if (db !== undefined) {
    const s = _reconcilerStates.get(db);
    if (!s) return false;
    if (s.bootTimer) clearTimeout(s.bootTimer);
    if (s.loopInterval) clearInterval(s.loopInterval);
    _reconcilerStates.delete(db);
    console.log('[NFSe] Reconciliador S6 parado para este tenant');
    return true;
  }
  // Sem argumento: para todos
  for (const s of _reconcilerStates.values()) {
    if (s.bootTimer) clearTimeout(s.bootTimer);
    if (s.loopInterval) clearInterval(s.loopInterval);
  }
  _reconcilerStates.clear();
  console.log('[NFSe] Reconciliador S6 parado (todos tenants)');
  return true;
}

module.exports = {
  registrarRotasNfse,
  emitirNfseInterno,
  carregarCertificado,
  proximoNumeroDPS,
  getConfig,
  dataBrasilia,
  iniciarReconciliadorS6,
  pararReconciliadorS6,
};
