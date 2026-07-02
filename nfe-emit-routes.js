/**
 * nfe-emit-routes.js — Emissão de NF-e modelo 55 via SEFAZ.
 * Usa node-sped-nfe (ESM) via dynamic import dentro do CJS existente.
 *
 * Uso:
 *   const { registrarRotasNfeEmit } = require('./nfe-emit-routes');
 *   registrarRotasNfeEmit(app, db);
 */

const { codigoUF, modFrete, gerarCNF } = require('./nfe-ibge');
const { montarNFeProc } = require('./nfe-proc');
const { cancelarFaturaLocal } = require('./fatura-cancelamento');
const { tPagFromForma } = require('./meio-pagamento');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const XSD_ENVINFE = path.join(__dirname, 'node_modules/node-sped-nfe/schemas/PL_010b_V1.30/enviNFe_v4.00.xsd');
const XSD_NFE = path.join(__dirname, 'node_modules/node-sped-nfe/schemas/PL_010b_V1.30/nfe_v4.00.xsd');

function validarXmlLocal(xmlNfe) {
  // Valida o <NFe> isoladamente contra nfe_v4.00.xsd (traz mensagens mais legíveis que o enviNFe)
  const tmp = '/tmp/nfe-validate-' + Date.now() + '.xml';
  fs.writeFileSync(tmp, '<?xml version="1.0" encoding="UTF-8"?>' + xmlNfe);
  try {
    execSync(`xmllint --noout --schema "${XSD_NFE}" "${tmp}"`, { stdio: ['ignore','pipe','pipe'] });
    fs.unlink(tmp, () => {});
    return null; // sem erros
  } catch (err) {
    fs.unlink(tmp, () => {});
    const stderr = (err.stderr && err.stderr.toString()) || err.message;
    return stderr.slice(0, 2000);
  }
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ok */ } }

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfe_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      tpAmb INTEGER DEFAULT 2,
      serie INTEGER DEFAULT 1,
      proximoNumero INTEGER DEFAULT 1,
      cscId TEXT,
      csc TEXT,
      observacao TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT OR IGNORE INTO nfe_config (id, tpAmb, serie, proximoNumero) VALUES (1, 2, 1, 1)').run();
  alterSafe(db, 'ALTER TABLE faturas ADD COLUMN rejeicaoMotivo TEXT');
  alterSafe(db, 'ALTER TABLE produtos ADD COLUMN cstPIS TEXT');
  alterSafe(db, 'ALTER TABLE produtos ADD COLUMN cstCOFINS TEXT');
  alterSafe(db, 'ALTER TABLE produtos ADD COLUMN csosn TEXT');
  alterSafe(db, 'ALTER TABLE fornecedor ADD COLUMN codigoMunicipio TEXT');
}

function carregarEmitente(db) {
  const f = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get();
  if (!f) throw new Error('Emitente (fornecedor) não cadastrado');
  if (!f.cnpj) throw new Error('Emitente sem CNPJ');
  if (!f.uf) throw new Error('Emitente sem UF');
  if (!f.inscricaoEstadual) throw new Error('Emitente sem Inscrição Estadual');
  return f;
}

function carregarCert(db) {
  const cert = db.prepare('SELECT certificadoBase64, senhaCriptografada FROM certificado_digital WHERE id = 1').get();
  if (!cert) throw new Error('Certificado digital não cadastrado');
  return {
    pfx: Buffer.from(cert.certificadoBase64, 'base64'),
    senha: Buffer.from(cert.senhaCriptografada, 'base64').toString('utf-8')
  };
}

// Em produção, PA usa SVRS (Sefaz Virtual RS) como autorizador real — não as URLs genéricas
// `www.sefazvirtual.fazenda.gov.br` (que são SVC-AN e rejeitam NFe normal quando SEFAZ-PA está online).
const UF_ROTEIA_SVRS = new Set(['AC','AL','AP','CE','DF','ES','PA','PB','PI','RJ','RN','RO','RR','SC','SE','TO']);

// Mapa cUF → UF de roteamento (usado para forçar SVRS em produção para os estados atendidos por ele)
const CUF_TO_UF_SVRS = {
  '12':'SVRS', // AC
  '27':'SVRS', // AL
  '16':'SVRS', // AP
  '23':'SVRS', // CE
  '53':'SVRS', // DF
  '32':'SVRS', // ES
  '15':'SVRS', // PA
  '25':'SVRS', // PB
  '22':'SVRS', // PI
  '33':'SVRS', // RJ
  '24':'SVRS', // RN
  '11':'SVRS', // RO
  '14':'SVRS', // RR
  '42':'SVRS', // SC
  '28':'SVRS', // SE
  '17':'SVRS', // TO
};

async function getTools(db) {
  const mod = await import('node-sped-nfe');
  const { Tools } = mod;
  const cfg = db.prepare('SELECT * FROM nfe_config WHERE id = 1').get();
  const f = carregarEmitente(db);
  const cert = carregarCert(db);
  const ufRoteamento = (cfg.tpAmb === 1 && UF_ROTEIA_SVRS.has(f.uf)) ? 'SVRS' : f.uf;
  const cnpjLimpo = (f.cnpj || '').replace(/\D/g,'');

  // Monkey-patch cUF2UF em produção para forçar roteamento de eventos (cancelamento, CC-e) via SVRS.
  // A lib usa cUF2UF[chNFe.substring(0,2)] para decidir a URL de eventos. Sem isso, cancelamento volta
  // ao SVAN antigo que não enxerga as NF-e emitidas via SVRS.
  if (mod.cUF2UF && cfg.tpAmb === 1) {
    Object.assign(mod.cUF2UF, CUF_TO_UF_SVRS);
  }

  return new Tools(
    { mod: '55', tpAmb: cfg.tpAmb, UF: ufRoteamento, versao: '4.00', CNPJ: cnpjLimpo },
    { pfx: cert.pfx, senha: cert.senha }
  );
}

// Extrai dados do XML de retorno da SEFAZ (strings simples)
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : '';
}

async function emitirNFe(db, faturaId) {
  const { Make } = await import('node-sped-nfe');
  const tools = await getTools(db);
  const cfg = db.prepare('SELECT * FROM nfe_config WHERE id = 1').get();
  const emit = carregarEmitente(db);
  const fatura = db.prepare(`
    SELECT f.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj, p.tipo AS clienteTipo,
      p.inscricaoMunicipal AS clienteIM,
      p.inscricaoEstadual AS clienteInscricaoEstadual,
      p.endereco AS clienteEndereco, p.numero AS clienteNumero, p.complemento AS clienteComplemento,
      p.bairro AS clienteBairro, p.cidade AS clienteCidade, p.uf AS clienteUf,
      p.cep AS clienteCep, p.codigoMunicipio AS clienteCodigoMunicipio,
      p.telefone AS clienteTelefone, p.email AS clienteEmail,
      ped.numero AS pedidoNumero, ped.tipoFrete AS pedidoTipoFrete
    FROM faturas f
    LEFT JOIN pessoas p ON p.id = f.clienteId
    LEFT JOIN pedidos ped ON ped.id = f.pedidoId
    WHERE f.id = ?`).get(faturaId);
  if (!fatura) throw new Error('Fatura não encontrada');
  if (fatura.statusSefaz === 'nao_fiscal') throw new Error('Fatura marcada como documento interno (não-fiscal) — NF-e não pode ser emitida');
  if (fatura.statusSefaz === 'autorizada') throw new Error('Fatura já tem NF-e autorizada');
  if (fatura.status !== 'emitida') throw new Error('Fatura não está emitida');

  const itens = db.prepare('SELECT * FROM fatura_itens WHERE faturaId = ? ORDER BY id ASC').all(faturaId);
  if (!itens.length) throw new Error('Fatura sem itens');

  // Reservar número (transação)
  const nNF = cfg.proximoNumero;
  const serie = cfg.serie;
  const cUF = codigoUF(emit.uf);
  if (!cUF) throw new Error(`UF "${emit.uf}" inválida`);

  const NFe = new Make();
  NFe.tagInfNFe({ Id: null, versao: '4.00' });

  const cNF = gerarCNF();
  const clienteEhPJ = (fatura.clienteCpfCnpj || '').replace(/\D/g,'').length === 14;

  // NF-e de devolução: tpNF=0 (entrada), finNFe=4, natOp vêm do Tipo de Operação da fatura.
  // Legado: se não houver tipoOperacaoId, usa isDevolucao como sinal.
  const tipoOpRow = fatura.tipoOperacaoId
    ? db.prepare('SELECT * FROM tipos_operacao WHERE id = ?').get(fatura.tipoOperacaoId)
    : null;
  const ehDevolucao = tipoOpRow
    ? (tipoOpRow.finalidadeNFe === 4 || tipoOpRow.categoriaOperacao === 'devolucao_venda')
    : Number(fatura.isDevolucao) === 1;

  // Resolve CFOP final por item (converte venda→devolução quando aplicável) e carrega
  // mapa de metadados dos CFOPs envolvidos. Os CFOPs resolvidos alimentam natOp, CSOSN
  // fallback e o prodList abaixo.
  const fallbackDevolucao = (ufDest, ufEmit) => {
    if (!ufDest || ufDest === 'EX') return '3202';
    return ufDest === ufEmit ? '1202' : '2202';
  };
  const cfopMetaCache = new Map();
  const getCfopMeta = (codigo) => {
    if (!codigo) return null;
    if (cfopMetaCache.has(codigo)) return cfopMetaCache.get(codigo);
    const row = db.prepare('SELECT codigo, descricao, cfopContrapartida, csosnPadrao, cstPadrao, aliquotaPisPadrao, aliquotaCofinsPadrao, movimentaEstoque, geraFinanceiro, finalidadeNFe FROM cfops WHERE codigo = ?').get(codigo);
    cfopMetaCache.set(codigo, row || null);
    return row || null;
  };
  const cfopResolvidoPorItem = new Map();
  for (const it of itens) {
    let cf = it.cfop || '5102';
    if (ehDevolucao && /^[567]/.test(cf)) {
      cf = getCfopMeta(cf)?.cfopContrapartida || fallbackDevolucao(fatura.clienteUf, emit.uf);
    }
    cfopResolvidoPorItem.set(it.id, cf);
    getCfopMeta(cf); // pré-carrega no cache
  }

  // natOp: precedência é Tipo de Operação → descrição do primeiro CFOP → rótulo genérico.
  // Truncado a 60 chars (limite do layout NF-e) e sem diacríticos.
  const primeiroCfop = itens.length ? cfopResolvidoPorItem.get(itens[0].id) : null;
  const cfopMetaPrincipal = getCfopMeta(primeiroCfop);
  const natOpFonte = tipoOpRow?.textoPadraoNFe
    || cfopMetaPrincipal?.descricao
    || (ehDevolucao ? 'DEVOLUCAO DE VENDA' : 'VENDA DE PRODUTO');
  const natOpDinamica = natOpFonte
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toUpperCase()
    .substring(0, 60);

  // finalidadeNFe também vem do tipo (1=normal, 2=complementar, 3=ajuste, 4=devolução).
  const finalidadeNFe = tipoOpRow?.finalidadeNFe || (ehDevolucao ? 4 : 1);

  NFe.tagIde({
    cUF: String(cUF),
    cNF,
    natOp: natOpDinamica,
    mod: '55',
    serie: String(serie),
    nNF: String(nNF),
    dhEmi: NFe.formatData(),
    tpNF: ehDevolucao ? '0' : '1',  // 0 = entrada (devolução) / 1 = saída
    // 1 = mesma UF / 2 = interestadual / 3 = exterior (clienteUf 'EX')
    idDest: (fatura.clienteUf || '').toUpperCase() === 'EX' ? '3'
      : (fatura.clienteUf || '').toUpperCase() === (emit.uf || '').toUpperCase() ? '1'
      : '2',
    cMunFG: String(emit.codigoMunicipio || '0').padStart(7,'0'),
    tpImp: '1',
    // Em homologação PA a lib chega em SVC-AN → tpEmis=6 é exigido
    // Em produção PA a URL atende como SVAN normal → tpEmis=1
    tpEmis: cfg.tpAmb === 2 ? '6' : '1',
    cDV: '0',
    tpAmb: String(cfg.tpAmb),
    finNFe: String(finalidadeNFe),
    indFinal: clienteEhPJ ? '0' : '1',
    indPres: '1',
    indIntermed: '0',
    procEmi: '0',
    verProc: 'LiciteAgora1.0',
    ...(cfg.tpAmb === 2 ? {
      dhCont: (() => {
        const brt = new Date(Date.now() - 3*60*60*1000 - 5*60*1000);
        const pad = n => String(n).padStart(2,'0');
        return `${brt.getUTCFullYear()}-${pad(brt.getUTCMonth()+1)}-${pad(brt.getUTCDate())}T${pad(brt.getUTCHours())}:${pad(brt.getUTCMinutes())}:${pad(brt.getUTCSeconds())}-03:00`;
      })(),
      xJust: 'Emissao em contingencia SVC-AN - homologacao'
    } : {})
  });

  // Referência à NF-e original (obrigatório em devolução quando existe)
  if (ehDevolucao && fatura.refNFeOriginal) {
    try {
      NFe.tagRefNFe(fatura.refNFeOriginal.replace(/\D/g, ''));
    } catch (err) {
      console.warn('[NF-e devolução] Falha ao anexar refNFe:', err.message);
    }
  }

  NFe.tagEmit({
    CNPJ: emit.cnpj.replace(/\D/g,''),
    xNome: emit.razaoSocial,
    xFant: emit.nomeFantasia || emit.razaoSocial,
    IE: emit.inscricaoEstadual.replace(/\D/g,''),
    CRT: '1'  // Simples Nacional
  });
  NFe.tagEnderEmit({
    xLgr: emit.endereco || 'NAO INFORMADO',
    nro: emit.numero || 'SN',
    xBairro: emit.bairro || 'NAO INFORMADO',
    cMun: String(emit.codigoMunicipio || '0').padStart(7,'0'),
    xMun: emit.cidade || 'NAO INFORMADO',
    UF: emit.uf,
    CEP: (emit.cep || '').replace(/\D/g,''),
    cPais: '1058',
    xPais: 'BRASIL',
    fone: (emit.telefone || '').replace(/\D/g,'') || undefined
  });

  // Destinatário — ORDEM DE CAMPOS SEGUE XSD: CNPJ/CPF primeiro, depois xNome, etc.
  const destCpfCnpj = (fatura.clienteCpfCnpj || '').replace(/\D/g,'');
  const destTag = {};
  if (destCpfCnpj.length === 14) destTag.CNPJ = destCpfCnpj;
  else if (destCpfCnpj.length === 11) destTag.CPF = destCpfCnpj;
  destTag.xNome = fatura.clienteNome || 'CONSUMIDOR';
  // indIEDest (derivado automaticamente):
  //   1 = Contribuinte de ICMS (tem IE)
  //   2 = Contribuinte isento de IE (PJ sem IE)
  //   9 = Não contribuinte (PF ou sem CPF/CNPJ)
  const destIE = (fatura.clienteInscricaoEstadual || '').replace(/\D/g,'');
  if (destIE) {
    destTag.indIEDest = '1';
    destTag.IE = destIE;
  } else if (destCpfCnpj.length === 14) {
    destTag.indIEDest = '2';
  } else {
    destTag.indIEDest = '9';
  }
  if (fatura.clienteEmail) destTag.email = fatura.clienteEmail;
  NFe.tagDest(destTag);

  NFe.tagEnderDest({
    xLgr: fatura.clienteEndereco || 'NAO INFORMADO',
    nro: fatura.clienteNumero || 'SN',
    xBairro: fatura.clienteBairro || 'NAO INFORMADO',
    cMun: String(fatura.clienteCodigoMunicipio || '0').padStart(7,'0'),
    xMun: fatura.clienteCidade || 'NAO INFORMADO',
    UF: fatura.clienteUf || emit.uf,
    CEP: (fatura.clienteCep || '').replace(/\D/g,''),
    cPais: '1058',
    xPais: 'BRASIL'
  });

  // Rateio do frete entre os itens (SEFAZ 535: a soma dos vFrete por item deve
  // igualar o vFrete do total). Distribui proporcional ao vProd de cada item;
  // o resíduo de arredondamento vai no último item para fechar exatamente.
  const vFreteRatear = Number(fatura.valorFrete) || 0;
  const vProdParaRateio = itens.reduce((s, it) => s + Number(it.valorTotal || 0), 0);
  const freteRateio = new Map();
  if (vFreteRatear > 0 && vProdParaRateio > 0) {
    let acumulado = 0;
    itens.forEach((it, idx) => {
      const ehUltimo = idx === itens.length - 1;
      const v = ehUltimo
        ? Number((vFreteRatear - acumulado).toFixed(2))
        : Number((vFreteRatear * (Number(it.valorTotal || 0) / vProdParaRateio)).toFixed(2));
      if (!ehUltimo) acumulado += v;
      freteRateio.set(it.id, v);
    });
  }

  // Produtos — CFOP final vem do mapa `cfopResolvidoPorItem` já calculado acima.
  const prodList = itens.map(it => ({
    cProd: String(it.sku || it.produtoId || 'ITEM-'+it.id),
    cEAN: 'SEM GTIN',
    xProd: (it.descricao || '').substring(0, 120),
    NCM: (it.ncm || '00000000').replace(/\D/g,'').padStart(8,'0'),
    CFOP: cfopResolvidoPorItem.get(it.id),
    uCom: (it.unidade || 'UN').substring(0, 6),
    qCom: Number(it.quantidade).toFixed(4),
    vUnCom: Number(it.precoUnitario).toFixed(4),
    vProd: Number(it.valorTotal).toFixed(2),
    cEANTrib: 'SEM GTIN',
    uTrib: (it.unidade || 'UN').substring(0, 6),
    qTrib: Number(it.quantidade).toFixed(4),
    vUnTrib: Number(it.precoUnitario).toFixed(4),
    ...(freteRateio.get(it.id) ? { vFrete: freteRateio.get(it.id).toFixed(2) } : {}),
    indTot: '1'
  }));
  NFe.tagProd(prodList);

  // Impostos (Simples Nacional).
  // Precedência CSOSN/CST: produto cadastrado → CFOP (csosnPadrao/cstPadrao) → fallback 400/49.
  const produtoIds = [...new Set(itens.map(it => it.produtoId).filter(Boolean))];
  const produtosPor = new Map();
  if (produtoIds.length) {
    const rows = db.prepare(`SELECT id, csosn, cstPIS, cstCOFINS FROM produtos WHERE id IN (${produtoIds.map(()=>'?').join(',')})`).all(...produtoIds);
    for (const r of rows) produtosPor.set(r.id, r);
  }
  itens.forEach((it, i) => {
    const prod = it.produtoId ? produtosPor.get(it.produtoId) : null;
    const cfopMeta = getCfopMeta(cfopResolvidoPorItem.get(it.id));
    const csosn = (prod?.csosn || cfopMeta?.csosnPadrao || '400').trim();
    const cstPIS = (prod?.cstPIS || cfopMeta?.cstPadrao || '49').trim();
    const cstCOFINS = (prod?.cstCOFINS || cfopMeta?.cstPadrao || '49').trim();
    // CSOSN 101, 201 têm alíquotas de crédito ICMS. 102, 103, 300, 400 não tributadas. 500 ICMS-ST. 900 outros.
    if (csosn === '101' || csosn === '201') {
      NFe.tagProdICMSSN(i, { orig: String(it.origem || '0'), CSOSN: csosn, pCredSN: '0.00', vCredICMSSN: '0.00' });
    } else if (csosn === '500') {
      NFe.tagProdICMSSN(i, { orig: String(it.origem || '0'), CSOSN: csosn, vBCSTRet: '0.00', vICMSSTRet: '0.00', vBCSTDest: '0.00', vICMSSTDest: '0.00' });
    } else if (csosn === '900') {
      NFe.tagProdICMSSN(i, { orig: String(it.origem || '0'), CSOSN: csosn, modBC: '0', vBC: '0.00', pRedBC: '0.00', pICMS: '0.00', vICMS: '0.00', modBCST: '0', pMVAST: '0.00', pRedBCST: '0.00', vBCST: '0.00', pICMSST: '0.00', vICMSST: '0.00', pCredSN: '0.00', vCredICMSSN: '0.00' });
    } else {
      // 102, 103, 300, 400 — sem permissão a crédito / isenção / imune / não tributada
      NFe.tagProdICMSSN(i, { orig: String(it.origem || '0'), CSOSN: csosn });
    }
    NFe.tagProdPIS(i, { CST: cstPIS, vBC: '0.00', pPIS: '0.00', vPIS: '0.00' });
    NFe.tagProdCOFINS(i, { CST: cstCOFINS, vBC: '0.00', pCOFINS: '0.00', vCOFINS: '0.00' });
  });

  // Totais — incluindo frete da fatura no vNF
  const vProdTot = itens.reduce((s, it) => s + Number(it.valorTotal || 0), 0);
  const vFreteTot = Number(fatura.valorFrete) || 0;
  const vDescTot = Number(fatura.valorDesconto) || 0;
  const vNF = vProdTot + vFreteTot - vDescTot;
  NFe.tagTotal({ ICMSTot: {
    vFrete: vFreteTot.toFixed(2),
    vDesc: vDescTot.toFixed(2),
    vNF: vNF.toFixed(2)
  }});
  NFe.tagTransp({ modFrete: Number(modFrete(fatura.pedidoTipoFrete)) });

  // Pagamento (grupo YA) — deriva das parcelas de contas_a_receber, que são a mesma
  // fonte do financeiro (evita divergência fiscal×financeiro). Σ vPag = vNF.
  // indPag=1 (a prazo) se houver vencimento futuro; múltiplos detPag agrupados por tPag.
  const geraFinanceiro = tipoOpRow ? !!tipoOpRow.geraFinanceiro : true;
  const parcelasCR = db.prepare(
    `SELECT formaPagamento, valor, dataVencimento FROM contas_a_receber
       WHERE faturaId = ? ORDER BY dataVencimento ASC, id ASC`
  ).all(faturaId);

  // Grupo <card> p/ cartão (03/04): SEFAZ (NT 2016.002) exige tpIntegra em pagamento
  // com cartão. Emitimos tpIntegra=2 (não integrado / maquininha avulsa) — CNPJ/tBand/cAut
  // não são capturados hoje e são opcionais nesse modo.
  const cardFor = (t) => (t === '03' || t === '04') ? { tpIntegra: '2' } : undefined;

  // <cobr>/<dup> (duplicatas) é montado no branch a prazo e injetado no XML cru antes de
  // assinar (a lib node-sped-nfe não implementa tagFat/tagDup). Fica vazio p/ à vista.
  let cobrXml = '';

  if (parcelasCR.length) {
    // formaPagamento no banco mistura tPag ('15') com literais ('boleto','pix','outros')
    // → normaliza p/ tPag SEFAZ. Venda com financeiro exige meio em todas as parcelas.
    if (parcelasCR.some(p => !tPagFromForma(p.formaPagamento))) {
      throw new Error('Meio de pagamento não informado — defina o meio (tPag) no pedido antes de emitir. ' +
        'Operações genuinamente sem pagamento (bonificação/remessa) devem usar um Tipo de Operação que não gera financeiro.');
    }
    const emissaoRef = String(fatura.dataEmissao || '').substring(0, 10);
    const indPag = parcelasCR.some(p => String(p.dataVencimento || '').substring(0, 10) > emissaoRef) ? 1 : 0;
    // Agrupa por tPag (SEFAZ permite múltiplos detPag)
    const porTpag = new Map();
    for (const p of parcelasCR) {
      const t = tPagFromForma(p.formaPagamento);
      porTpag.set(t, (porTpag.get(t) || 0) + Number(p.valor || 0));
    }
    const detPag = [...porTpag.entries()].map(([tPag, v]) => ({ tPag, vPag: Number(v) }));
    // Garante Σ vPag == vNF (ajusta resíduo de arredondamento no maior detPag)
    const resid = Number((vNF - detPag.reduce((s, d) => s + d.vPag, 0)).toFixed(2));
    if (resid !== 0) {
      const maior = detPag.reduce((a, b) => (b.vPag > a.vPag ? b : a));
      maior.vPag = Number((maior.vPag + resid).toFixed(2));
    }
    NFe.tagDetPag(detPag.map(d => {
      const dp = { indPag, tPag: d.tPag, vPag: d.vPag.toFixed(2) };
      const card = cardFor(d.tPag);
      if (card) dp.card = card;
      return dp;
    }));

    // Venda a prazo → grupo <cobr> com uma <dup> por parcela. Σ vDup = vNF.
    if (indPag === 1) {
      const dups = parcelasCR.map((p, i) => ({
        nDup: String(i + 1).padStart(3, '0'),
        dVenc: String(p.dataVencimento || '').substring(0, 10),
        vDup: Number(p.valor || 0),
      }));
      const residDup = Number((vNF - dups.reduce((s, d) => s + d.vDup, 0)).toFixed(2));
      if (residDup !== 0 && dups.length) {
        const maiorD = dups.reduce((a, b) => (b.vDup > a.vDup ? b : a));
        maiorD.vDup = Number((maiorD.vDup + residDup).toFixed(2));
      }
      const escNf = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const fatXml = `<fat><nFat>${escNf(fatura.numero || String(nNF))}</nFat>` +
        `<vOrig>${vNF.toFixed(2)}</vOrig><vDesc>0.00</vDesc><vLiq>${vNF.toFixed(2)}</vLiq></fat>`;
      const dupXml = dups.map(d =>
        `<dup><nDup>${d.nDup}</nDup><dVenc>${d.dVenc}</dVenc><vDup>${d.vDup.toFixed(2)}</vDup></dup>`).join('');
      cobrXml = `<cobr>${fatXml}${dupXml}</cobr>`;
    }
  } else if (tPagFromForma(fatura.meioPagamento)) {
    // Sem parcelas de CR mas com meio informado: à vista, valor total.
    const t = tPagFromForma(fatura.meioPagamento);
    const dp = { indPag: 0, tPag: t, vPag: vNF.toFixed(2) };
    const card = cardFor(t);
    if (card) dp.card = card;
    NFe.tagDetPag([dp]);
  } else if (!geraFinanceiro) {
    // Operação genuinamente sem pagamento (bonificação/remessa/comodato): tPag 90.
    NFe.tagDetPag([{ indPag: 0, tPag: '90', vPag: '0.00' }]);
  } else {
    // Gera financeiro mas sem parcelas nem meio → inconsistência: bloquear (não emitir "sem pagamento").
    throw new Error('Fatura gera financeiro mas está sem parcelas e sem meio de pagamento. ' +
      'Informe o meio de pagamento (tPag) no pedido antes de emitir.');
  }

  // Injeta <cobr> imediatamente antes de <pag> (ordem exigida pelo schema). A lib não
  // implementa tagFat/tagDup, então montamos o grupo à mão; o XSD local (pós-assinatura) valida.
  const xmlRaw0 = NFe.xml();
  const xmlRaw = cobrXml ? xmlRaw0.replace('<pag>', cobrXml + '<pag>') : xmlRaw0;
  console.log('[NFe] XML gerado (primeiros 2000 chars):\n', xmlRaw.substring(0, 2000));

  const xmlAssinado = await tools.xmlSign(xmlRaw);

  // Validação local contra XSD v4.00 APÓS assinar (XSD exige <Signature>)
  const xsdErro = validarXmlLocal(xmlAssinado);
  if (xsdErro) {
    console.error('[NFe] XSD invalidação local:\n', xsdErro);
    throw new Error('Schema XSD local rejeitou: ' + xsdErro);
  }
  console.log('[NFe] XSD local OK, enviando à SEFAZ…');
  console.log('[NFe] XML assinado OK, enviando à SEFAZ…');
  const resposta = await tools.sefazEnviaLote(xmlAssinado, { indSinc: 1 });
  const respStr = typeof resposta === 'string' ? resposta : JSON.stringify(resposta);
  console.log('[NFe] Resposta SEFAZ:\n', respStr.substring(0, 3000));

  // Status do lote (externo) e status da NF-e (interno, dentro de protNFe/infProt)
  const cStatLote = tag(respStr, 'cStat');
  const xMotivoLote = tag(respStr, 'xMotivo');
  const protNFeMatch = respStr.match(/<protNFe[^>]*>([\s\S]*?)<\/protNFe>/);
  const protInner = protNFeMatch ? protNFeMatch[1] : '';
  const cStat = tag(protInner, 'cStat') || cStatLote;
  const xMotivo = tag(protInner, 'xMotivo') || xMotivoLote;
  const protocolo = tag(protInner, 'nProt');
  const chave = tag(protInner, 'chNFe') ||
    (xmlAssinado.match(/Id="NFe(\d{44})"/)?.[1] || null);

  const tx = db.transaction(() => {
    if (cStat === '100' || cStat === '150') {
      const xmlProc = montarNFeProc(xmlAssinado, respStr);
      db.prepare(`UPDATE faturas SET statusSefaz='autorizada', chaveAcesso=?, protocoloAutorizacao=?,
        numeroNFe=?, serieNFe=?, xmlAssinado=?, dataAutorizacaoSefaz=CURRENT_TIMESTAMP,
        rejeicaoMotivo=NULL, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`)
        .run(chave, protocolo, nNF, String(serie), xmlProc, faturaId);
      db.prepare('UPDATE nfe_config SET proximoNumero = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = 1').run(nNF + 1);
    } else {
      db.prepare(`UPDATE faturas SET statusSefaz='rejeitada', rejeicaoMotivo=?,
        dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`)
        .run(`cStat=${cStat} · ${xMotivo}`, faturaId);
    }
  });
  tx();

  // Envio automático de DANFE + XML ao cliente (best-effort — nunca bloqueia a emissão).
  if (cStat === '100' || cStat === '150') {
    enviarDocsNfeAoCliente(db, faturaId)
      .then(r => { if (!r.ok) console.log(`[NFe][email] envio pulado fatura ${faturaId}: ${r.motivo}`); })
      .catch(e => console.error(`[NFe][email] falha no envio automático fatura ${faturaId}:`, e.message));
  }

  return { cStat, xMotivo, chave, protocolo, nNF, serie };
}

// Envia DANFE (PDF) + XML da NF-e autorizada ao e-mail do cliente. Reutilizado pela
// emissão (automático) e pelo endpoint manual de reenvio. Retorna {ok, to, messageId, motivo}.
async function enviarDocsNfeAoCliente(db, faturaId, toOverride) {
  const f = db.prepare(`
    SELECT f.numero, f.chaveAcesso, f.xmlAssinado, f.statusSefaz, f.valorTotal,
      p.email AS clienteEmail, p.emailsAdicionais AS clienteEmailsAdic, p.razaoSocial AS clienteNome
    FROM faturas f LEFT JOIN pessoas p ON p.id = f.clienteId WHERE f.id = ?`).get(faturaId);
  if (!f) return { ok: false, motivo: 'Fatura não encontrada' };
  if (f.statusSefaz !== 'autorizada') return { ok: false, motivo: 'NF-e não autorizada' };
  if (!f.xmlAssinado) return { ok: false, motivo: 'Fatura sem XML' };

  const adic = String(f.clienteEmailsAdic || '').split(/[;,\s]+/).map(s => s.trim()).filter(Boolean);
  const to = (toOverride || f.clienteEmail || adic.shift() || '').trim();
  if (!to) return { ok: false, motivo: 'Cliente sem e-mail cadastrado' };
  const cc = (!toOverride && adic.length) ? adic.join(',') : undefined;

  const { DANFe } = await import('node-sped-pdf');
  const logo = db.prepare('SELECT logoBase64 FROM fornecedor WHERE id = 1').get()?.logoBase64 || undefined;
  const danfePdf = await DANFe({ xml: f.xmlAssinado, logo });

  const { enviarEmailNfe } = require('./email-client');
  const info = await enviarEmailNfe(db, {
    to, cc, numero: f.numero, chave: f.chaveAcesso, valor: f.valorTotal,
    danfePdf, xmlBuffer: Buffer.from(f.xmlAssinado, 'utf8'), clienteNome: f.clienteNome,
  });
  return { ok: true, to, messageId: info?.messageId };
}

function registrarRotas(app, db) {
  migrar(db);

  // --- CONFIG ---
  app.get('/api/nfe/config', (req, res) => {
    try {
      const cfg = db.prepare('SELECT * FROM nfe_config WHERE id = 1').get();
      res.json({ success: true, config: cfg });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/nfe/config', (req, res) => {
    try {
      const b = req.body;
      const atual = db.prepare('SELECT * FROM nfe_config WHERE id = 1').get();
      const novoTpAmb = b.tpAmb != null ? Number(b.tpAmb) : atual.tpAmb;
      // Ao trocar ambiente, resetar proximoNumero para 1 (homolog e prod usam contadores distintos)
      let proximoNumero = b.proximoNumero != null ? Number(b.proximoNumero) : atual.proximoNumero;
      const trocouAmbiente = novoTpAmb !== atual.tpAmb;
      if (trocouAmbiente && b.proximoNumero == null) proximoNumero = 1;
      db.prepare(`UPDATE nfe_config SET tpAmb = ?, serie = ?, proximoNumero = ?, observacao = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = 1`).run(
        novoTpAmb,
        b.serie != null ? Number(b.serie) : atual.serie,
        proximoNumero,
        b.observacao != null ? b.observacao : atual.observacao
      );
      res.json({ success: true, trocouAmbiente, config: db.prepare('SELECT * FROM nfe_config WHERE id = 1').get() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });


  // --- STATUS SEFAZ ---
  app.get('/api/nfe/status', async (req, res) => {
    try {
      const tools = await getTools(db);
      const resp = await tools.sefazStatus();
      const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
      res.json({
        success: true,
        cStat: tag(str, 'cStat'),
        xMotivo: tag(str, 'xMotivo'),
        tpAmb: tag(str, 'tpAmb'),
        verAplic: tag(str, 'verAplic'),
        raw: str
      });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  // --- EMITIR ---
  app.post('/api/faturas/:id/emitir-nfe', async (req, res) => {
    try {
      const r = await emitirNFe(db, Number(req.params.id));
      res.json({ success: true, ...r });
    } catch (err) {
      console.error('[NFe] emitir erro:', err);
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  // --- DOWNLOAD XML ---
  app.get('/api/faturas/:id/xml', (req, res) => {
    try {
      const f = db.prepare('SELECT numero, numeroNFe, xmlAssinado, statusSefaz FROM faturas WHERE id = ?').get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Fatura não encontrada' });
      if (!f.xmlAssinado) return res.status(400).json({ success: false, error: 'NF-e não emitida' });
      const nomeArquivo = f.numeroNFe ? `NFe-${f.numeroNFe}` : f.numero;
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.xml"`);
      res.send(f.xmlAssinado);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // --- DANFE ---
  app.get('/api/faturas/:id/danfe', async (req, res) => {
    try {
      const f = db.prepare('SELECT numero, numeroNFe, serieNFe, xmlAssinado, statusSefaz FROM faturas WHERE id = ?').get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Fatura não encontrada' });
      if (f.statusSefaz !== 'autorizada') return res.status(400).json({ success: false, error: 'NF-e não autorizada' });
      const logo = db.prepare('SELECT logoBase64 FROM fornecedor WHERE id = 1').get()?.logoBase64 || undefined;
      const { DANFe } = await import('node-sped-pdf');
      const buf = await DANFe({ xml: f.xmlAssinado, logo });
      const nomeArquivo = f.numeroNFe ? `DANFE-NFe-${f.numeroNFe}` : `DANFE-${f.numero}`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${nomeArquivo}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[DANFE] erro:', err);
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  // --- ENVIAR DANFE + XML ao cliente por e-mail (reenvio manual) ---
  app.post('/api/faturas/:id/enviar-email', async (req, res) => {
    try {
      const r = await enviarDocsNfeAoCliente(db, Number(req.params.id), (req.body && req.body.to) || undefined);
      if (!r.ok) return res.status(400).json({ success: false, error: r.motivo });
      res.json({ success: true, to: r.to, messageId: r.messageId });
    } catch (err) {
      console.error('[NFe][email] erro reenvio:', err);
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  // --- EXPORT ZIP (XMLs + DANFEs de NF-e autorizadas em um período) ---
  app.get('/api/nfe/export-zip', async (req, res) => {
    try {
      const AdmZip = require('adm-zip');
      const { dataInicio, dataFim, clienteId, status } = req.query;
      let sql = `SELECT f.id, f.numero, f.chaveAcesso, f.xmlAssinado, f.statusSefaz, f.dataEmissao, f.numeroNFe, f.serieNFe
                 FROM faturas f WHERE f.xmlAssinado IS NOT NULL AND f.chaveAcesso IS NOT NULL`;
      const params = [];
      if (dataInicio) { sql += ' AND f.dataEmissao >= ?'; params.push(dataInicio); }
      if (dataFim)    { sql += ' AND f.dataEmissao <= ?'; params.push(dataFim); }
      if (clienteId)  { sql += ' AND f.clienteId = ?';    params.push(clienteId); }
      if (status)     { sql += ' AND f.statusSefaz = ?';  params.push(status); }
      else            { sql += ` AND f.statusSefaz IN ('autorizada','cancelada_sefaz')`; }
      sql += ' ORDER BY f.dataEmissao ASC, f.id ASC';
      const faturas = db.prepare(sql).all(...params);
      if (!faturas.length) return res.status(404).json({ success: false, error: 'Nenhuma NF-e encontrada no filtro' });

      const zip = new AdmZip();
      const { DANFe } = await import('node-sped-pdf');
      const logo = db.prepare('SELECT logoBase64 FROM fornecedor WHERE id = 1').get()?.logoBase64 || undefined;

      for (const f of faturas) {
        const baseName = f.chaveAcesso || ('fatura-' + f.id);
        zip.addFile(`xml/${baseName}.xml`, Buffer.from(f.xmlAssinado, 'utf-8'));
        if (f.statusSefaz === 'autorizada') {
          try {
            const pdfBuf = await DANFe({ xml: f.xmlAssinado, logo });
            zip.addFile(`danfe/${baseName}.pdf`, Buffer.from(pdfBuf));
          } catch (e) {
            console.error('[export-zip] erro DANFE de', f.numero, e.message);
          }
        }
      }

      // Manifesto em CSV
      const lines = ['numero;numeroNFe;serie;dataEmissao;status;chaveAcesso'];
      for (const f of faturas) lines.push(`${f.numero};${f.numeroNFe||''};${f.serieNFe||''};${f.dataEmissao};${f.statusSefaz};${f.chaveAcesso||''}`);
      zip.addFile('manifesto.csv', Buffer.from(lines.join('\n'), 'utf-8'));

      const buf = zip.toBuffer();
      const filename = `nfe-${dataInicio||'todos'}_${dataFim||'todos'}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(buf);
    } catch (err) {
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  // --- CARTA DE CORREÇÃO (evento 110110) ---
  app.post('/api/faturas/:id/cce', async (req, res) => {
    try {
      const correcao = (req.body?.correcao || '').trim();
      const nSeqEvento = Number(req.body?.nSeqEvento) || 1;
      if (correcao.length < 15) return res.status(400).json({ success: false, error: 'Correção deve ter pelo menos 15 caracteres' });
      if (correcao.length > 1000) return res.status(400).json({ success: false, error: 'Correção deve ter no máximo 1000 caracteres' });
      if (nSeqEvento < 1 || nSeqEvento > 20) return res.status(400).json({ success: false, error: 'nSeqEvento deve estar entre 1 e 20' });
      const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Fatura não encontrada' });
      if (f.statusSefaz !== 'autorizada') return res.status(400).json({ success: false, error: 'NF-e não está autorizada' });
      const tools = await getTools(db);
      const resp = await tools.sefazEvento({
        chNFe: f.chaveAcesso,
        tpEvento: '110110',
        nSeqEvento,
        xCorrecao: correcao
      });
      const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
      // cStat externo = lote; cStat interno (dentro de retEvento/infEvento) = evento
      const retEvMatch = str.match(/<retEvento[^>]*>([\s\S]*?)<\/retEvento>/);
      const inner = retEvMatch ? retEvMatch[1] : '';
      const cStat = tag(inner, 'cStat') || tag(str, 'cStat');
      const xMotivo = tag(inner, 'xMotivo') || tag(str, 'xMotivo');
      const nProt = tag(inner, 'nProt');
      if (cStat === '135' || cStat === '136') {
        res.json({ success: true, cStat, xMotivo, nProt });
      } else {
        res.status(400).json({ success: false, cStat, xMotivo, raw: str });
      }
    } catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });

  // --- CANCELAMENTO ---
  app.post('/api/faturas/:id/cancelar-nfe', async (req, res) => {
    try {
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 15) return res.status(400).json({ success: false, error: 'Motivo deve ter pelo menos 15 caracteres' });
      const f = db.prepare('SELECT * FROM faturas WHERE id = ?').get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Fatura não encontrada' });
      if (f.statusSefaz !== 'autorizada') return res.status(400).json({ success: false, error: 'NF-e não está autorizada' });
      const tools = await getTools(db);
      const resp = await tools.sefazEvento({
        chNFe: f.chaveAcesso,
        tpEvento: '110111',
        nSeqEvento: 1,
        xJust: motivo,
        nProt: f.protocoloAutorizacao
      });
      const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
      const retEvMatch = str.match(/<retEvento[^>]*>([\s\S]*?)<\/retEvento>/);
      const inner = retEvMatch ? retEvMatch[1] : '';
      const cStat = tag(inner, 'cStat') || tag(str, 'cStat');
      const xMotivo = tag(inner, 'xMotivo') || tag(str, 'xMotivo');
      const nProt = tag(inner, 'nProt');
      if (cStat === '135' || cStat === '155') {
        db.prepare(`UPDATE faturas SET statusSefaz='cancelada_sefaz', rejeicaoMotivo=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`)
          .run(`Cancelada: ${motivo} (protocolo ${nProt||'—'})`, req.params.id);
        // Cancelar a NF-e também ajusta a fatura: cancela a fatura local, estorna
        // financeiro/estoque e reabre o pedido (mesma reconciliação do /cancelar).
        cancelarFaturaLocal(db, f, req.session?.username);
        res.json({ success: true, cStat, xMotivo, nProt, escopo: 'fatura+nfe', pedidoReaberto: true });
      } else {
        res.status(400).json({ success: false, cStat, xMotivo, raw: str });
      }
    } catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });
}

module.exports = { registrarRotasNfeEmit: registrarRotas, getTools, emitirNFe };
