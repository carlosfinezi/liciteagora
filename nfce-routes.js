/**
 * nfce-routes.js — Emissão de NFC-e modelo 65 (varejo · consumidor final).
 *
 * Reaproveita certificado + emitente + lib node-sped-nfe de nfe-emit-routes.
 * NFC-e tem particularidades:
 *   - modelo 65, tpImp 4 (DANFCE)
 *   - indPres 1 (presencial), indFinal 1 (consumidor final)
 *   - tag <pag> obrigatória
 *   - CSC + CSCid obrigatórios para geração do QR code
 *   - destinatário opcional até R$ 200 (com CPF acima disso)
 *
 * Schema novo:
 *   nfce_config    — série/próximo número/CSC/CSCid (separado da NF-e mod 55)
 *   nfce           — NFC-e emitida
 *   nfce_itens     — itens da venda
 *   nfce_pagamentos — formas de pagamento
 *
 * Endpoints:
 *   GET  /api/nfce/config
 *   PUT  /api/nfce/config
 *   POST /api/nfce/emitir
 *   GET  /api/nfce
 *   GET  /api/nfce/:id
 *   GET  /api/nfce/:id/xml
 *   POST /api/nfce/:id/cancelar
 */

const { codigoUF, gerarCNF } = require('./nfe-ibge');
const { montarNFeProc } = require('./nfe-proc');
const { resolverEstab, serieAtual, avancarSerie } = require('./nfe-emit-routes');
const { getEstabelecimentoAtivo } = require('./estabelecimentos-routes');

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ok */ } }

// Critérios padrão para decisão automática NFC-e vs NFe (modelo 65 vs 55).
// Editáveis por tenant via coluna limiteNFCe em nfce_config. Cliente PJ,
// venda interestadual, parcelamento múltiplo e valor acima do limite disparam NFe.
function avaliarModeloFiscal(db, payload) {
  const cfg = db.prepare('SELECT limiteNFCe FROM nfce_config WHERE id = 1').get() || {};
  const limite = Number(cfg.limiteNFCe) || 10000;
  const forn = db.prepare('SELECT uf FROM fornecedor WHERE id = 1').get() || {};
  const ufEmitente = (forn.uf || '').toUpperCase();

  const cpfDigits = String(payload.consumidorCpfCnpj || '').replace(/\D/g, '');
  const ehPJ = cpfDigits.length === 14;
  const valorTotal = Number(payload.valorTotal) ||
    (Array.isArray(payload.itens) ? payload.itens.reduce((s, it) => s + Number(it.valorTotal || 0), 0) - Number(payload.valorDesconto || 0) : 0);

  // Detectar UF do destinatário (se cliente já cadastrado em pessoas)
  let ufDestinatario = '';
  if (cpfDigits) {
    const p = db.prepare('SELECT uf FROM pessoas WHERE cpfCnpj = ?').get(cpfDigits);
    if (p && p.uf) ufDestinatario = String(p.uf).toUpperCase();
  }
  const ehInterUF = ufDestinatario && ufEmitente && ufDestinatario !== ufEmitente;

  // Parcelamento complexo: múltiplos pagamentos OU cartão crédito (que costuma ter nParc no payload)
  const pagamentos = Array.isArray(payload.pagamentos) ? payload.pagamentos : [];
  const parcelamentoComplexo = pagamentos.length > 1 ||
    pagamentos.some(p => Number(p.nParc) > 1);

  const motivos = [];
  if (ehPJ) motivos.push('cliente PJ (CNPJ) exige NFe');
  if (ehInterUF) motivos.push(`venda interestadual (${ufEmitente} → ${ufDestinatario})`);
  if (parcelamentoComplexo) motivos.push('pagamento parcelado/múltiplo');
  if (valorTotal > limite) motivos.push(`valor acima do limite NFC-e (R$ ${limite.toFixed(2)})`);

  const modelo = motivos.length > 0 ? '55' : '65';
  return { modelo, motivos, limiteNFCe: limite, valorTotal, ufEmitente, ufDestinatario, ehPJ };
}

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfce_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tpAmb INTEGER DEFAULT 2,
      serie INTEGER DEFAULT 1,
      proximoNumero INTEGER DEFAULT 1,
      cscId TEXT,
      csc TEXT,
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS nfce (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero INTEGER,
      serie INTEGER,
      chaveAcesso TEXT UNIQUE,
      protocoloAutorizacao TEXT,
      tpAmb INTEGER,
      dataEmissao TEXT DEFAULT CURRENT_TIMESTAMP,
      valorProdutos REAL DEFAULT 0,
      valorDesconto REAL DEFAULT 0,
      valorTotal REAL DEFAULT 0,
      consumidorCpfCnpj TEXT,
      consumidorNome TEXT,
      xmlAssinado TEXT,
      qrCodeUrl TEXT,
      urlChave TEXT,
      statusSefaz TEXT DEFAULT 'pendente',
      rejeicaoMotivo TEXT,
      motivoCancelamento TEXT,
      dataCancelamento TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nfce_status ON nfce(statusSefaz);
    CREATE INDEX IF NOT EXISTS idx_nfce_emissao ON nfce(dataEmissao);

    CREATE TABLE IF NOT EXISTS nfce_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfceId INTEGER NOT NULL,
      produtoId INTEGER,
      sku TEXT,
      descricao TEXT NOT NULL,
      ncm TEXT,
      cfop TEXT,
      unidade TEXT DEFAULT 'UN',
      quantidade REAL NOT NULL,
      precoUnitario REAL NOT NULL,
      valorTotal REAL NOT NULL,
      FOREIGN KEY (nfceId) REFERENCES nfce(id)
    );

    CREATE TABLE IF NOT EXISTS nfce_pagamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfceId INTEGER NOT NULL,
      tPag TEXT NOT NULL,
      valor REAL NOT NULL,
      FOREIGN KEY (nfceId) REFERENCES nfce(id)
    );
  `);
  db.prepare('INSERT OR IGNORE INTO nfce_config (id, tpAmb, serie, proximoNumero) VALUES (1, 2, 1, 1)').run();
  alterSafe(db, 'ALTER TABLE nfce_config ADD COLUMN limiteNFCe REAL DEFAULT 10000');
  alterSafe(db, `ALTER TABLE nfce_config ADD COLUMN pdvModeloPadrao TEXT DEFAULT ''`);          // '' auto, '65', '55'
  alterSafe(db, `ALTER TABLE nfce_config ADD COLUMN pdvFormaPagamentoPadrao TEXT DEFAULT '01'`);
  alterSafe(db, 'ALTER TABLE nfce_config ADD COLUMN pdvExigirCpfSempre INTEGER DEFAULT 0');
  alterSafe(db, 'ALTER TABLE nfce_config ADD COLUMN pdvExigirClienteCadastrado INTEGER DEFAULT 0');
  alterSafe(db, `ALTER TABLE nfce_config ADD COLUMN pdvModoImpressao TEXT DEFAULT 'nenhum'`);   // 'nenhum' | 'termico-58' | 'termico-80' | 'a4' | 'email'
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

function carregarEmitente(db, estab = null) {
  const f = (estab && !estab.matriz)
    ? estab
    : db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get();
  if (!f) throw new Error('Emitente não cadastrado');
  if (!f.cnpj) throw new Error('Emitente sem CNPJ');
  if (!f.uf) throw new Error('Emitente sem UF');
  if (!f.inscricaoEstadual) throw new Error('Emitente sem Inscrição Estadual');
  return f;
}

function carregarCert(db, estab = null) {
  const cert = (estab && !estab.matriz)
    ? db.prepare('SELECT certificadoBase64, senhaCriptografada FROM certificado_digital WHERE estabelecimentoId = ?').get(estab.id)
    : db.prepare('SELECT certificadoBase64, senhaCriptografada FROM certificado_digital WHERE id = 1').get();
  if (!cert) throw new Error('Certificado digital não cadastrado');
  return {
    pfx: Buffer.from(cert.certificadoBase64, 'base64'),
    senha: Buffer.from(cert.senhaCriptografada, 'base64').toString('utf-8')
  };
}

async function getTools(db, estab = null) {
  const mod = await import('node-sped-nfe');
  const { Tools } = mod;
  const cfg = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
  // CSC é por-CNPJ: matriz usa o nfce_config; filial usa o CSC da própria linha.
  const csc = (estab && !estab.matriz) ? estab.csc : cfg.csc;
  const cscId = (estab && !estab.matriz) ? estab.cscId : cfg.cscId;
  if (!csc || !cscId) throw new Error('CSC e CSCid obrigatórios para NFC-e — cadastre na configuração (ou no estabelecimento)');
  const f = carregarEmitente(db, estab);
  const cert = carregarCert(db, estab);
  return new Tools(
    { mod: '65', tpAmb: cfg.tpAmb, UF: f.uf, versao: '4.00', CNPJ: f.cnpj.replace(/\D/g, ''), CSC: csc, CSCid: cscId },
    { pfx: cert.pfx, senha: cert.senha }
  );
}

async function emitirNFCe(db, payload) {
  const { Make } = await import('node-sped-nfe');
  // Multi-loja: estabelecimento emissor (payload.estabelecimentoId; NULL = matriz).
  const estab = resolverEstab(db, payload.estabelecimentoId);
  const tools = await getTools(db, estab);
  const cfg = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
  const emit = carregarEmitente(db, estab);

  const itens = payload.itens || [];
  if (!itens.length) throw new Error('Informe ao menos 1 item');

  const pagamentos = payload.pagamentos || [];
  if (!pagamentos.length) throw new Error('Informe a forma de pagamento');

  const cpfCnpjCons = (payload.consumidorCpfCnpj || '').replace(/\D/g, '');
  const valorProdTot = itens.reduce((s, it) => s + Number(it.valorTotal || (it.quantidade * it.precoUnitario) || 0), 0);
  const valorDesc = Number(payload.valorDesconto || 0);
  const vNF = +(valorProdTot - valorDesc).toFixed(2);

  // NFC-e acima de R$ 200 exige CPF/CNPJ identificado
  if (vNF > 200 && !cpfCnpjCons) {
    throw new Error('CPF/CNPJ do consumidor obrigatório para NFC-e acima de R$ 200,00');
  }
  const vPag = pagamentos.reduce((s, p) => s + Number(p.valor || 0), 0);
  if (Math.abs(vPag - vNF) > 0.02) {
    throw new Error(`Soma dos pagamentos (${vPag.toFixed(2)}) não bate com o total (${vNF.toFixed(2)})`);
  }

  const _res = serieAtual(db, estab, cfg, '65');
  const nNF = _res.proximoNumero;
  const serie = _res.serie;
  const cUF = codigoUF(emit.uf);
  if (!cUF) throw new Error(`UF inválida: ${emit.uf}`);

  const NFe = new Make();
  NFe.tagInfNFe({ Id: null, versao: '4.00' });

  NFe.tagIde({
    cUF: String(cUF),
    cNF: gerarCNF(),
    natOp: 'VENDA AO CONSUMIDOR',
    mod: '65',
    serie: String(serie),
    nNF: String(nNF),
    dhEmi: NFe.formatData(),
    tpNF: '1',
    idDest: '1',
    cMunFG: String(emit.codigoMunicipio || '0').padStart(7, '0'),
    tpImp: '4',       // DANFCE retrato
    tpEmis: '1',      // normal
    cDV: '0',
    tpAmb: String(cfg.tpAmb),
    finNFe: '1',
    indFinal: '1',    // consumidor final
    indPres: '1',     // presencial
    indIntermed: '0',
    procEmi: '0',
    verProc: 'LiciteAgora1.0'
  });

  NFe.tagEmit({
    CNPJ: emit.cnpj.replace(/\D/g, ''),
    xNome: emit.razaoSocial,
    xFant: emit.nomeFantasia || emit.razaoSocial,
    IE: emit.inscricaoEstadual.replace(/\D/g, ''),
    CRT: '1'
  });
  NFe.tagEnderEmit({
    xLgr: emit.endereco || 'NAO INFORMADO',
    nro: emit.numero || 'SN',
    xBairro: emit.bairro || 'NAO INFORMADO',
    cMun: String(emit.codigoMunicipio || '0').padStart(7, '0'),
    xMun: emit.cidade || 'NAO INFORMADO',
    UF: emit.uf,
    CEP: (emit.cep || '').replace(/\D/g, ''),
    cPais: '1058',
    xPais: 'BRASIL',
    fone: (emit.telefone || '').replace(/\D/g, '') || undefined
  });

  // Destinatário é opcional em NFC-e quando sem CPF
  if (cpfCnpjCons) {
    const destTag = {};
    if (cpfCnpjCons.length === 14) destTag.CNPJ = cpfCnpjCons;
    else if (cpfCnpjCons.length === 11) destTag.CPF = cpfCnpjCons;
    destTag.xNome = payload.consumidorNome || 'CONSUMIDOR';
    destTag.indIEDest = '9';
    if (payload.consumidorEmail) destTag.email = payload.consumidorEmail;
    NFe.tagDest(destTag);
  }

  // Produtos
  const prodList = itens.map(it => ({
    cProd: String(it.sku || it.produtoId || ('ITEM-' + (itens.indexOf(it) + 1))),
    cEAN: it.codigoBarras || 'SEM GTIN',
    xProd: (it.descricao || '').substring(0, 120),
    NCM: (it.ncm || '00000000').replace(/\D/g, '').padStart(8, '0'),
    CFOP: it.cfop || '5102',
    uCom: (it.unidade || 'UN').substring(0, 6),
    qCom: Number(it.quantidade).toFixed(4),
    vUnCom: Number(it.precoUnitario).toFixed(4),
    vProd: Number(it.valorTotal || (it.quantidade * it.precoUnitario)).toFixed(2),
    cEANTrib: it.codigoBarras || 'SEM GTIN',
    uTrib: (it.unidade || 'UN').substring(0, 6),
    qTrib: Number(it.quantidade).toFixed(4),
    vUnTrib: Number(it.precoUnitario).toFixed(4),
    indTot: '1'
  }));
  NFe.tagProd(prodList);

  // ICMS Simples Nacional + PIS/COFINS (mesma lógica de nfe-emit)
  const produtoIds = [...new Set(itens.map(it => it.produtoId).filter(Boolean))];
  const produtosPor = new Map();
  if (produtoIds.length) {
    const rows = db.prepare(`SELECT id, csosn, cstPIS, cstCOFINS, origem FROM produtos WHERE id IN (${produtoIds.map(() => '?').join(',')})`).all(...produtoIds);
    for (const r of rows) produtosPor.set(r.id, r);
  }
  itens.forEach((it, i) => {
    const prod = it.produtoId ? produtosPor.get(it.produtoId) : null;
    const csosn = (prod?.csosn || '102').trim();
    const cstPIS = (prod?.cstPIS || '49').trim();
    const cstCOFINS = (prod?.cstCOFINS || '49').trim();
    const origem = String(prod?.origem || it.origem || '0');
    if (csosn === '101' || csosn === '201') {
      NFe.tagProdICMSSN(i, { orig: origem, CSOSN: csosn, pCredSN: '0.00', vCredICMSSN: '0.00' });
    } else if (csosn === '500') {
      NFe.tagProdICMSSN(i, { orig: origem, CSOSN: csosn, vBCSTRet: '0.00', vICMSSTRet: '0.00', vBCSTDest: '0.00', vICMSSTDest: '0.00' });
    } else {
      NFe.tagProdICMSSN(i, { orig: origem, CSOSN: csosn });
    }
    NFe.tagProdPIS(i, { CST: cstPIS, vBC: '0.00', pPIS: '0.00', vPIS: '0.00' });
    NFe.tagProdCOFINS(i, { CST: cstCOFINS, vBC: '0.00', pCOFINS: '0.00', vCOFINS: '0.00' });
  });

  NFe.tagTotal({ ICMSTot: {
    vDesc: valorDesc.toFixed(2),
    vNF: vNF.toFixed(2)
  }});
  NFe.tagTransp({ modFrete: 9 }); // 9 = sem transporte (NFC-e presencial)

  // Pagamentos — um detPag por forma
  NFe.tagDetPag(pagamentos.map(p => ({
    indPag: 0,
    tPag: String(p.tPag).padStart(2, '0'),
    vPag: Number(p.valor).toFixed(2)
  })));

  const xmlRaw = NFe.xml();
  const xmlAssinado = await tools.xmlSign(xmlRaw);

  const resposta = await tools.sefazEnviaLote(xmlAssinado, { indSinc: 1 });
  const respStr = typeof resposta === 'string' ? resposta : JSON.stringify(resposta);

  const cStatLote = tag(respStr, 'cStat');
  const xMotivoLote = tag(respStr, 'xMotivo');
  const protNFeMatch = respStr.match(/<protNFe[^>]*>([\s\S]*?)<\/protNFe>/);
  const protInner = protNFeMatch ? protNFeMatch[1] : '';
  const cStat = tag(protInner, 'cStat') || cStatLote;
  const xMotivo = tag(protInner, 'xMotivo') || xMotivoLote;
  const protocolo = tag(protInner, 'nProt');
  const chave = tag(protInner, 'chNFe') || (xmlAssinado.match(/Id="NFe(\d{44})"/)?.[1] || null);

  const qrMatch = xmlAssinado.match(/<qrCode[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/qrCode>/);
  const qrCodeUrl = qrMatch ? qrMatch[1].trim() : null;
  const urlChMatch = xmlAssinado.match(/<urlChave[^>]*>([\s\S]*?)<\/urlChave>/);
  const urlChave = urlChMatch ? urlChMatch[1].trim() : null;

  let id;
  const tx = db.transaction(() => {
    const autorizada = cStat === '100' || cStat === '150';
    const xmlFinal = autorizada ? montarNFeProc(xmlAssinado, respStr) : xmlAssinado;

    const r = db.prepare(`INSERT INTO nfce
      (numero, serie, chaveAcesso, protocoloAutorizacao, tpAmb, valorProdutos, valorDesconto, valorTotal,
       consumidorCpfCnpj, consumidorNome, xmlAssinado, qrCodeUrl, urlChave,
       statusSefaz, rejeicaoMotivo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nNF, serie, chave, protocolo, cfg.tpAmb,
      valorProdTot, valorDesc, vNF,
      cpfCnpjCons || null, payload.consumidorNome || null,
      xmlFinal, qrCodeUrl, urlChave,
      autorizada ? 'autorizada' : 'rejeitada',
      autorizada ? null : `cStat=${cStat} · ${xMotivo}`
    );
    id = r.lastInsertRowid;

    const insItem = db.prepare(`INSERT INTO nfce_itens
      (nfceId, produtoId, sku, descricao, ncm, cfop, unidade, quantidade, precoUnitario, valorTotal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of itens) {
      insItem.run(id, it.produtoId || null, it.sku || null, it.descricao,
        it.ncm || null, it.cfop || null, it.unidade || 'UN',
        Number(it.quantidade), Number(it.precoUnitario),
        Number(it.valorTotal || (it.quantidade * it.precoUnitario)));
    }

    const insPag = db.prepare('INSERT INTO nfce_pagamentos (nfceId, tPag, valor) VALUES (?, ?, ?)');
    for (const p of pagamentos) insPag.run(id, String(p.tPag).padStart(2, '0'), Number(p.valor));

    if (autorizada) {
      avancarSerie(db, estab, '65', nNF + 1, 'nfce_config');
    }
  });
  tx();

  return { id, cStat, xMotivo, chave, protocolo, nNF, serie, qrCodeUrl, urlChave };
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/nfce/config', (req, res) => {
    try {
      const cfg = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
      // Não expor CSC no GET — só retornar um flag se existe
      res.json({ success: true, config: {
        id: cfg.id, tpAmb: cfg.tpAmb, serie: cfg.serie, proximoNumero: cfg.proximoNumero,
        cscId: cfg.cscId || null, cscCadastrado: !!cfg.csc, observacao: cfg.observacao,
        dataAtualizacao: cfg.dataAtualizacao
      }});
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/nfce/config', (req, res) => {
    try {
      const b = req.body || {};
      const atual = db.prepare('SELECT * FROM nfce_config WHERE id = 1').get();
      const novoTpAmb = b.tpAmb != null ? Number(b.tpAmb) : atual.tpAmb;
      let proximoNumero = b.proximoNumero != null ? Number(b.proximoNumero) : atual.proximoNumero;
      const trocouAmb = novoTpAmb !== atual.tpAmb;
      if (trocouAmb && b.proximoNumero == null) proximoNumero = 1;
      db.prepare(`UPDATE nfce_config SET
        tpAmb = ?, serie = ?, proximoNumero = ?, cscId = ?, csc = ?, observacao = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = 1`).run(
        novoTpAmb,
        b.serie != null ? Number(b.serie) : atual.serie,
        proximoNumero,
        b.cscId != null ? b.cscId : atual.cscId,
        b.csc ? b.csc : atual.csc,  // Vazio mantém atual
        b.observacao != null ? b.observacao : atual.observacao
      );
      const atualizado = db.prepare('SELECT id, tpAmb, serie, proximoNumero, cscId, (csc IS NOT NULL) AS cscCadastrado, observacao, dataAtualizacao FROM nfce_config WHERE id = 1').get();
      res.json({ success: true, trocouAmbiente: trocouAmb, config: atualizado });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Busca de produto para PDV (inclui código de barras, exclusivo do NFC-e)
  app.get('/api/nfce/produtos/buscar', (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ success: true, produtos: [] });
      const like = `%${q.toLowerCase()}%`;
      // Primeiro tenta match exato por código de barras ou SKU (caso de leitor de código)
      const exato = db.prepare(`SELECT id, sku, descricao, unidade, precoVenda, codigoBarras, ncm, cfopPadrao AS cfop
        FROM produtos WHERE ativo = 1 AND (codigoBarras = ? OR sku = ?) LIMIT 1`).get(q, q);
      if (exato) return res.json({ success: true, produtos: [exato], matchExato: true });

      const produtos = db.prepare(`SELECT id, sku, descricao, unidade, precoVenda, codigoBarras, ncm, cfopPadrao AS cfop
        FROM produtos
        WHERE ativo = 1 AND (LOWER(sku) LIKE ? OR LOWER(descricao) LIKE ? OR codigoBarras LIKE ?)
        ORDER BY descricao ASC LIMIT 20`).all(like, like, `%${q}%`);
      res.json({ success: true, produtos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfce/emitir', async (req, res) => {
    try {
      const _payload = req.body || {};
      const _e = getEstabelecimentoAtivo(db, req);
      if (_e && !_e.matriz) _payload.estabelecimentoId = _e.id;
      const r = await emitirNFCe(db, _payload);
      res.json({ success: true, ...r });
    } catch (err) {
      console.error('[nfce emitir]', err);
      res.status(400).json({ success: false, error: String(err.message || err) });
    }
  });

  // Avaliação do modelo fiscal (NFC-e 65 vs NFe 55) baseada no payload — sem emissão
  app.post('/api/pdv/avaliar-modelo', (req, res) => {
    try {
      const avaliacao = avaliarModeloFiscal(db, req.body || {});
      res.json({ success: true, ...avaliacao });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Configurações de comportamento do PDV (lê/salva sobre nfce_config id=1)
  app.get('/api/pdv/config', (req, res) => {
    try {
      const c = db.prepare(`SELECT limiteNFCe, pdvModeloPadrao, pdvFormaPagamentoPadrao,
        pdvExigirCpfSempre, pdvExigirClienteCadastrado, pdvModoImpressao FROM nfce_config WHERE id = 1`).get() || {};
      res.json({
        success: true,
        config: {
          limiteNFCe: Number(c.limiteNFCe) || 10000,
          pdvModeloPadrao: c.pdvModeloPadrao || '',
          pdvFormaPagamentoPadrao: c.pdvFormaPagamentoPadrao || '01',
          pdvExigirCpfSempre: c.pdvExigirCpfSempre ? 1 : 0,
          pdvExigirClienteCadastrado: c.pdvExigirClienteCadastrado ? 1 : 0,
          pdvModoImpressao: c.pdvModoImpressao || 'nenhum',
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pdv/config', (req, res) => {
    try {
      const b = req.body || {};
      const modelo = String(b.pdvModeloPadrao || '').trim();
      const modeloValido = modelo === '' || modelo === '65' || modelo === '55';
      if (!modeloValido) return res.status(400).json({ success: false, error: 'Modelo inválido (use vazio, 65 ou 55)' });

      const modosImpressao = new Set(['nenhum', 'termico-58', 'termico-80', 'a4', 'email']);
      const modoImp = String(b.pdvModoImpressao || 'nenhum');
      const modoImpValido = modosImpressao.has(modoImp) ? modoImp : 'nenhum';

      db.prepare(`UPDATE nfce_config SET
        limiteNFCe = ?,
        pdvModeloPadrao = ?,
        pdvFormaPagamentoPadrao = ?,
        pdvExigirCpfSempre = ?,
        pdvExigirClienteCadastrado = ?,
        pdvModoImpressao = ?,
        dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = 1`)
      .run(
        Math.max(0, Number(b.limiteNFCe) || 10000),
        modelo,
        String(b.pdvFormaPagamentoPadrao || '01').trim() || '01',
        b.pdvExigirCpfSempre ? 1 : 0,
        b.pdvExigirClienteCadastrado ? 1 : 0,
        modoImpValido,
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Finalizador unificado do PDV — decide NFC-e ou NFe e dispara o fluxo correto
  app.post('/api/pdv/finalizar', async (req, res) => {
    try {
      const payload = req.body || {};
      // Multi-loja: carimba o estabelecimento ativo da sessão no PDV (NULL = matriz).
      const _e = getEstabelecimentoAtivo(db, req);
      if (_e && !_e.matriz) payload.estabelecimentoId = _e.id;
      const modeloForcado = String(payload.modeloForcado || '').trim(); // '65' | '55' | '' (auto)

      const avaliacao = avaliarModeloFiscal(db, payload);
      const modelo = modeloForcado === '65' || modeloForcado === '55'
        ? modeloForcado
        : avaliacao.modelo;

      if (modelo === '65') {
        // Fluxo NFC-e tradicional
        const r = await emitirNFCe(db, payload);
        return res.json({ success: true, modelo: '65', avaliacao, ...r });
      }

      // Fluxo NFe — cria/obtém pessoa, cria pedido PDV, fatura e emite NFe 55
      const cpfDigits = String(payload.consumidorCpfCnpj || '').replace(/\D/g, '');
      if (!cpfDigits) throw new Error('NFe exige CPF/CNPJ do consumidor');

      // 1. Obter/criar pessoa (respeita pdvExigirClienteCadastrado)
      let pessoa = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(cpfDigits);
      if (!pessoa) {
        const cfg = db.prepare('SELECT pdvExigirClienteCadastrado FROM nfce_config WHERE id = 1').get() || {};
        if (cfg.pdvExigirClienteCadastrado) {
          throw new Error(`Cliente CPF/CNPJ ${cpfDigits} não encontrado. Cadastre em /pessoas antes de emitir NFe.`);
        }
        const tipo = cpfDigits.length === 14 ? 'PJ' : 'PF';
        const nome = String(payload.consumidorNome || '').trim() || `Cliente ${cpfDigits}`;
        db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial) VALUES (?, ?, ?)`).run(cpfDigits, tipo, nome);
        pessoa = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(cpfDigits);
      }

      // 2. Criar pedido PDV já em status=entregue (baixa estoque) para permitir faturar
      const forn = db.prepare('SELECT uf FROM fornecedor WHERE id = 1').get() || {};
      const ufEmit = String(forn.uf || '').toUpperCase();
      const ufDest = String(pessoa.uf || '').toUpperCase();
      const indestinatario = ufDest && ufDest !== ufEmit ? 'interestadual' : 'interna';

      const itens = Array.isArray(payload.itens) ? payload.itens : [];
      if (!itens.length) throw new Error('Venda sem itens');
      const valorBruto = itens.reduce((s, it) => s + Number(it.valorTotal || 0), 0);
      const valorDesc = Number(payload.valorDesconto || 0);
      const valorTotal = Number((valorBruto - valorDesc).toFixed(2));
      const meioPrincipal = (Array.isArray(payload.pagamentos) && payload.pagamentos[0]?.tPag) || null;

      const ultimo = db.prepare("SELECT numero FROM pedidos ORDER BY id DESC LIMIT 1").get();
      let numPed = 1;
      if (ultimo) { const m = String(ultimo.numero).match(/(\d+)/); if (m) numPed = parseInt(m[1],10) + 1; }
      const numeroPedido = String(numPed).padStart(6, '0');
      const dataHoje = new Date().toISOString().slice(0,10);

      const trx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO pedidos (numero, tipo, clienteId, status, dataPedido, valorTotal, meioPagamento, observacao)
          VALUES (?, 'pdv', ?, 'entregue', ?, ?, ?, ?)
        `).run(numeroPedido, pessoa.id, dataHoje, valorTotal, meioPrincipal,
          `PDV — venda direta ${indestinatario}. Motivos NFe: ${avaliacao.motivos.join(', ') || 'forçado manual'}`);
        const pedidoId = r.lastInsertRowid;
        const stmtItem = db.prepare(`
          INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const it of itens) {
          stmtItem.run(pedidoId, it.produtoId || null, it.descricao,
            Number(it.quantidade) || 1, Number(it.precoUnitario) || 0, Number(it.valorTotal) || 0);
        }
        return pedidoId;
      });
      const pedidoId = trx();

      // 3. Faturar — reusa a rota HTTP via chamada interna seria complexo; chama diretamente o stmt
      // que é quase o mesmo do faturas-routes. Para manter comportamento idêntico, faço POST
      // interno na própria app via função auxiliar.
      const axios = require('axios');
      const port = process.env.PORT || 3000;
      const faturaResp = await axios.post(`http://127.0.0.1:${port}/api/pedidos/${pedidoId}/faturar`, {
        valorDesconto: valorDesc,
        observacao: `Originado do PDV`,
      }, {
        headers: { Cookie: req.headers.cookie || '' },
        validateStatus: () => true,
      });
      if (!faturaResp.data?.success) {
        throw new Error('Falha ao criar fatura: ' + (faturaResp.data?.error || `HTTP ${faturaResp.status}`));
      }
      const faturaId = faturaResp.data.fatura?.id;

      // 4. Emitir NFe SEFAZ
      const { emitirNFe } = require('./nfe-emit-routes');
      const emissao = await emitirNFe(db, faturaId);

      res.json({
        success: true,
        modelo: '55',
        avaliacao,
        pedidoId,
        faturaId,
        sefaz: emissao,
      });
    } catch (err) {
      console.error('[pdv/finalizar]', err);
      res.status(400).json({ success: false, error: String(err.message || err) });
    }
  });

  app.get('/api/nfce', (req, res) => {
    try {
      const { status, busca, limit } = req.query;
      let sql = `SELECT id, numero, serie, chaveAcesso, dataEmissao, valorTotal, consumidorCpfCnpj, consumidorNome, qrCodeUrl, statusSefaz, rejeicaoMotivo FROM nfce WHERE 1=1`;
      const p = [];
      if (status) { sql += ' AND statusSefaz = ?'; p.push(status); }
      if (busca) { sql += ' AND (consumidorNome LIKE ? OR consumidorCpfCnpj LIKE ? OR chaveAcesso LIKE ?)'; const t = '%' + busca + '%'; p.push(t, t, t); }
      sql += ' ORDER BY dataEmissao DESC LIMIT ?'; p.push(Number(limit) || 100);
      const items = db.prepare(sql).all(...p);
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/nfce/:id', (req, res) => {
    try {
      const n = db.prepare('SELECT * FROM nfce WHERE id = ?').get(req.params.id);
      if (!n) return res.status(404).json({ success: false, error: 'NFC-e não encontrada' });
      const itens = db.prepare('SELECT * FROM nfce_itens WHERE nfceId = ? ORDER BY id ASC').all(req.params.id);
      const pagamentos = db.prepare('SELECT * FROM nfce_pagamentos WHERE nfceId = ? ORDER BY id ASC').all(req.params.id);
      res.json({ success: true, nfce: n, itens, pagamentos });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/nfce/:id/xml', (req, res) => {
    try {
      const n = db.prepare('SELECT chaveAcesso, xmlAssinado FROM nfce WHERE id = ?').get(req.params.id);
      if (!n || !n.xmlAssinado) return res.status(404).json({ success: false, error: 'XML não disponível' });
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${n.chaveAcesso || 'nfce'}.xml"`);
      res.send(n.xmlAssinado);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfce/:id/cancelar', async (req, res) => {
    try {
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 15) return res.status(400).json({ success: false, error: 'Motivo deve ter pelo menos 15 caracteres' });
      const n = db.prepare('SELECT * FROM nfce WHERE id = ?').get(req.params.id);
      if (!n) return res.status(404).json({ success: false, error: 'NFC-e não encontrada' });
      if (n.statusSefaz !== 'autorizada') return res.status(400).json({ success: false, error: 'NFC-e não está autorizada' });

      const tools = await getTools(db);
      const resp = await tools.sefazEvento({
        chNFe: n.chaveAcesso,
        tpEvento: '110111',
        nSeqEvento: 1,
        xJust: motivo,
        nProt: n.protocoloAutorizacao
      });
      const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
      const retEv = (str.match(/<retEvento[^>]*>([\s\S]*?)<\/retEvento>/) || [])[1] || '';
      const cStat = tag(retEv, 'cStat') || tag(str, 'cStat');
      const xMotivo = tag(retEv, 'xMotivo') || tag(str, 'xMotivo');
      const nProt = tag(retEv, 'nProt');

      if (cStat === '135' || cStat === '155') {
        db.prepare(`UPDATE nfce SET statusSefaz='cancelada', motivoCancelamento=?, dataCancelamento=CURRENT_TIMESTAMP, dataAtualizacao=CURRENT_TIMESTAMP WHERE id = ?`)
          .run(`${motivo} (protocolo ${nProt || '—'})`, req.params.id);
        res.json({ success: true, cStat, xMotivo, nProt });
      } else {
        res.status(400).json({ success: false, cStat, xMotivo, raw: str.slice(0, 2000) });
      }
    } catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });

  console.log('[nfce] Rotas registradas');
}

module.exports = { registrarRotasNFCe: registrarRotas };
