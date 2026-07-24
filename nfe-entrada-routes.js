const zlib = require('zlib');
const multer = require('multer');
const { getTools } = require('./nfe-emit-routes');
const { lancarMovimentacao } = require('./contas-financeiras-routes');

const uploadXmlNfe = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function dataBrasilia() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

/**
 * Compõe custo unitário líquido conforme CPC 16 / NBC TG 16:
 *
 *   custo = vProd + vIPI* + vFrete + vOutro − vDesc − vICMS* − vPIS* − vCOFINS*
 *
 * (* = condicional ao regime — ver abaixo)
 *
 * - vProd: valorTotal do item (vUnCom × qCom).
 * - vFrete/vOutro/vDesc: usa o valor por item se preenchido; senão ratea o
 *   total do cabeçalho pelo peso do item em valorProdutos.
 * - vIPI: somado por padrão (revenda — IPI vira custo). Quando o tenant é
 *   contribuinte do IPI (indústria, fiscalCfg.contribuinteIPI=1), IPI é
 *   recuperável e NÃO entra no custo.
 * - vICMS: deduzido apenas para regimeTributario = 'NAO_OPTANTE' (Lucro
 *   Real / Presumido com crédito). SIMPLES_NACIONAL/MEI: ICMS no custo.
 * - vPIS/vCOFINS: deduzidos apenas para regimeApuracaoPISCOFINS =
 *   'nao_cumulativo' (típico Lucro Real). Cumulativo / NULL: ficam no custo.
 *
 * fiscalCfg = {
 *   regimeTributario: 'MEI' | 'SIMPLES_NACIONAL' | 'NAO_OPTANTE' | null,
 *   contribuinteIPI: 0 | 1,
 *   regimeApuracaoPISCOFINS: 'cumulativo' | 'nao_cumulativo' | null
 * }
 */
function calcularCustoUnitarioLiquido(item, totaisNF, fiscalCfg) {
  const qtd = Number(item.quantidade) || 0;
  if (!qtd) return 0;

  const cfg = fiscalCfg || {};
  const valorBase = Number(item.valorTotal) || (Number(item.valorUnitario) * qtd) || 0;
  const totalProdutos = Number(totaisNF.valorProdutos) || 0;
  const peso = totalProdutos > 0 ? valorBase / totalProdutos : 0;

  const freteItem = Number(item.valorFrete) || 0;
  const fretePorItem = freteItem > 0 ? freteItem : (Number(totaisNF.valorFrete) || 0) * peso;
  const outrosPorItem = (Number(totaisNF.valorOutros) || 0) * peso;
  const descItem = Number(item.valorDesconto) || 0;
  const descontoPorItem = descItem > 0 ? descItem : (Number(totaisNF.valorDesconto) || 0) * peso;

  let custoTotal = valorBase + fretePorItem + outrosPorItem - descontoPorItem;

  // IPI: soma só quando NÃO é recuperável (não-contribuinte do IPI).
  if (!cfg.contribuinteIPI) {
    custoTotal += Number(item.valorIpi) || 0;
  }
  // ICMS recuperável (regime normal).
  if (cfg.regimeTributario === 'NAO_OPTANTE') {
    custoTotal -= Number(item.valorIcms) || 0;
  }
  // PIS/COFINS recuperáveis (não-cumulativo).
  if (cfg.regimeApuracaoPISCOFINS === 'nao_cumulativo') {
    custoTotal -= Number(item.valorPis) || 0;
    custoTotal -= Number(item.valorCofins) || 0;
  }
  return custoTotal / qtd;
}

function alterSafe(db, sql) {
  try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nfe_entrada_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chaveAcesso TEXT UNIQUE,
      nsu TEXT,
      schema TEXT,
      emitenteCnpj TEXT,
      emitenteRazaoSocial TEXT,
      numeroNF TEXT,
      serie TEXT,
      dataEmissao TEXT,
      valorTotal REAL,
      tpNF INTEGER,
      cStat TEXT,
      xmlResumo TEXT,
      xmlCompleto TEXT,
      situacao TEXT DEFAULT 'pendente',
      nfeEntradaId INTEGER,
      dataDescoberta TEXT DEFAULT CURRENT_TIMESTAMP,
      dataImportacao TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_situacao ON nfe_entrada_inbox(situacao);
    CREATE INDEX IF NOT EXISTS idx_inbox_nsu ON nfe_entrada_inbox(nsu);

    CREATE TABLE IF NOT EXISTS nfe_distribuicao_cursor (
      id INTEGER PRIMARY KEY DEFAULT 1,
      ultNSU TEXT DEFAULT '0',
      maxNSU TEXT,
      ultimaSincronizacao TEXT,
      CHECK (id = 1)
    );
    INSERT OR IGNORE INTO nfe_distribuicao_cursor (id, ultNSU) VALUES (1, '0');

    CREATE TABLE IF NOT EXISTS nfe_entrada (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chaveAcesso TEXT UNIQUE,
      numero TEXT,
      serie TEXT,
      dataEmissao TEXT,
      dataEntrada TEXT,
      naturezaOperacao TEXT,
      emitenteCnpj TEXT,
      emitenteRazaoSocial TEXT,
      emitenteUf TEXT,
      emitenteIe TEXT,
      fornecedorId INTEGER,
      valorProdutos REAL,
      valorFrete REAL DEFAULT 0,
      valorDesconto REAL DEFAULT 0,
      valorOutros REAL DEFAULT 0,
      valorIcms REAL DEFAULT 0,
      valorIpi REAL DEFAULT 0,
      valorTotal REAL,
      tpNF INTEGER,
      situacao TEXT DEFAULT 'recebida',
      statusEstoque TEXT DEFAULT 'pendente',
      statusFinanceiro TEXT DEFAULT 'pendente',
      contaPagarId INTEGER,
      protocoloAutorizacao TEXT,
      xmlOriginal TEXT,
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fornecedorId) REFERENCES fornecedores(id)
    );
    CREATE INDEX IF NOT EXISTS idx_nfe_ent_fornecedor ON nfe_entrada(fornecedorId);
    CREATE INDEX IF NOT EXISTS idx_nfe_ent_data ON nfe_entrada(dataEmissao);

    CREATE TABLE IF NOT EXISTS nfe_entrada_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfeId INTEGER NOT NULL,
      numero INTEGER,
      codigoProduto TEXT,
      descricao TEXT,
      ean TEXT,
      ncm TEXT,
      cfop TEXT,
      unidade TEXT,
      quantidade REAL,
      valorUnitario REAL,
      valorTotal REAL,
      valorDesconto REAL DEFAULT 0,
      valorFrete REAL DEFAULT 0,
      valorIcms REAL DEFAULT 0,
      valorIpi REAL DEFAULT 0,
      produtoId INTEGER,
      movimentacaoEstoqueId INTEGER,
      ignorado INTEGER DEFAULT 0,
      FOREIGN KEY (nfeId) REFERENCES nfe_entrada(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_nfe_ent_item_nfe ON nfe_entrada_itens(nfeId);

    CREATE TABLE IF NOT EXISTS nfe_entrada_duplicatas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nfeId INTEGER NOT NULL,
      numero TEXT,
      dataVencimento TEXT,
      valor REAL,
      contaPagarId INTEGER,
      FOREIGN KEY (nfeId) REFERENCES nfe_entrada(id)
    );
    CREATE INDEX IF NOT EXISTS idx_nfe_ent_dup_nfe ON nfe_entrada_duplicatas(nfeId);

    CREATE TABLE IF NOT EXISTS contas_a_pagar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fornecedorId INTEGER NOT NULL,
      nfeEntradaId INTEGER,
      duplicataId INTEGER,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL,
      dataEmissao TEXT NOT NULL,
      dataVencimento TEXT NOT NULL,
      dataPagamento TEXT,
      valorPago REAL,
      status TEXT DEFAULT 'aberta',
      formaPagamento TEXT,
      observacoes TEXT,
      contaFinanceiraId INTEGER,
      origem TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fornecedorId) REFERENCES fornecedores(id),
      FOREIGN KEY (nfeEntradaId) REFERENCES nfe_entrada(id),
      FOREIGN KEY (duplicataId) REFERENCES nfe_entrada_duplicatas(id),
      FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cp_status ON contas_a_pagar(status);
    CREATE INDEX IF NOT EXISTS idx_cp_fornecedor ON contas_a_pagar(fornecedorId);
    CREATE INDEX IF NOT EXISTS idx_cp_venc ON contas_a_pagar(dataVencimento);
    CREATE INDEX IF NOT EXISTS idx_cp_nfe ON contas_a_pagar(nfeEntradaId);
  `);

  // Multi-loja (Fase 4): estabelecimento da conta a pagar (NULL = consolidado/matriz).
  alterSafe(db, "ALTER TABLE contas_a_pagar ADD COLUMN estabelecimentoId INTEGER");
  alterSafe(db, "ALTER TABLE nfe_entrada_inbox ADD COLUMN statusManifestacao TEXT");
  alterSafe(db, "ALTER TABLE nfe_entrada_inbox ADD COLUMN ultimoEventoTp TEXT");
  alterSafe(db, "ALTER TABLE nfe_entrada_inbox ADD COLUMN ultimoEventoProt TEXT");
  alterSafe(db, "ALTER TABLE nfe_entrada_inbox ADD COLUMN dataUltimoEvento TEXT");

  // Soft-delete + observação interna (gestão via /notas-fiscais.html)
  alterSafe(db, "ALTER TABLE nfe_entrada ADD COLUMN excluida INTEGER DEFAULT 0");
  alterSafe(db, "ALTER TABLE nfe_entrada ADD COLUMN dataExclusao TEXT");
  alterSafe(db, "ALTER TABLE nfe_entrada ADD COLUMN motivoExclusao TEXT");
  alterSafe(db, "ALTER TABLE nfe_entrada ADD COLUMN observacaoInterna TEXT");
  alterSafe(db, "CREATE INDEX IF NOT EXISTS idx_nfe_ent_excluida ON nfe_entrada(excluida)");

  // PIS/COFINS por item (vPIS/vCOFINS no XML) — usados na composição do
  // custo líquido quando o tenant apura no regime não-cumulativo.
  alterSafe(db, "ALTER TABLE nfe_entrada_itens ADD COLUMN valorPis REAL DEFAULT 0");
  alterSafe(db, "ALTER TABLE nfe_entrada_itens ADD COLUMN valorCofins REAL DEFAULT 0");
}

function tag(str, t) {
  const re = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i');
  const m = str && str.match(re);
  return m ? m[1].trim() : null;
}

function parseDocZip(docZipB64) {
  const buf = Buffer.from(docZipB64, 'base64');
  const xml = zlib.gunzipSync(buf).toString('utf-8');
  return xml;
}

function extrairResumo(xmlResumo) {
  // <resNFe> tem os campos: chNFe, CNPJ, xNome, IE, dhEmi, tpNF, vNF, nProt, cSitNFe, etc.
  return {
    chaveAcesso: tag(xmlResumo, 'chNFe'),
    emitenteCnpj: tag(xmlResumo, 'CNPJ'),
    emitenteRazaoSocial: tag(xmlResumo, 'xNome'),
    dataEmissao: tag(xmlResumo, 'dhEmi'),
    tpNF: Number(tag(xmlResumo, 'tpNF')),
    valorTotal: Number(tag(xmlResumo, 'vNF')),
    cStat: tag(xmlResumo, 'cSitNFe')
  };
}

function tagAll(str, t) {
  const re = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'gi');
  const out = []; let m;
  while ((m = re.exec(str)) !== null) out.push(m[1]);
  return out;
}
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function parseCabecalho(xml) {
  const chave = (xml.match(/Id="NFe(\d{44})"/) || [])[1] || tag(xml, 'chNFe');
  const emitBlock = tagAll(xml, 'emit')[0] || '';
  const ender = tagAll(emitBlock, 'enderEmit')[0] || '';
  const ide   = tagAll(xml, 'ide')[0] || '';
  const total = tagAll(xml, 'total')[0] || '';
  const icmsTot = tagAll(total, 'ICMSTot')[0] || '';
  const protocolo = tag(xml, 'nProt');

  return {
    chaveAcesso: chave,
    numero: tag(ide, 'nNF'),
    serie: tag(ide, 'serie'),
    dataEmissao: tag(ide, 'dhEmi') || tag(ide, 'dEmi'),
    naturezaOperacao: tag(ide, 'natOp'),
    tpNF: Number(tag(ide, 'tpNF') || 0),
    emitenteCnpj: tag(emitBlock, 'CNPJ') || tag(emitBlock, 'CPF'),
    emitenteRazaoSocial: tag(emitBlock, 'xNome'),
    emitenteIe: tag(emitBlock, 'IE'),
    endereco: tag(ender, 'xLgr'),
    numero_ender: tag(ender, 'nro'),
    complemento: tag(ender, 'xCpl'),
    bairro: tag(ender, 'xBairro'),
    codigoMunicipio: tag(ender, 'cMun'),
    cidade: tag(ender, 'xMun'),
    uf: tag(ender, 'UF'),
    cep: tag(ender, 'CEP'),
    telefone: tag(ender, 'fone'),
    valorProdutos: num(tag(icmsTot, 'vProd')),
    valorFrete: num(tag(icmsTot, 'vFrete')),
    valorDesconto: num(tag(icmsTot, 'vDesc')),
    valorOutros: num(tag(icmsTot, 'vOutro')),
    valorIcms: num(tag(icmsTot, 'vICMS')),
    valorIpi: num(tag(icmsTot, 'vIPI')),
    valorTotal: num(tag(icmsTot, 'vNF')),
    protocolo
  };
}

function parseItens(xml) {
  const out = [];
  const regex = /<det\s+nItem="(\d+)"[^>]*>([\s\S]*?)<\/det>/g;
  let m;
  while ((m = regex.exec(xml)) !== null) {
    const numero = Number(m[1]);
    const body = m[2];
    const prod = tagAll(body, 'prod')[0] || '';
    const imp = tagAll(body, 'imposto')[0] || '';
    out.push({
      numero,
      codigoProduto: tag(prod, 'cProd'),
      descricao: tag(prod, 'xProd'),
      ean: tag(prod, 'cEAN'),
      ncm: tag(prod, 'NCM'),
      cfop: tag(prod, 'CFOP'),
      unidade: tag(prod, 'uCom'),
      quantidade: num(tag(prod, 'qCom')),
      valorUnitario: num(tag(prod, 'vUnCom')),
      valorTotal: num(tag(prod, 'vProd')),
      valorDesconto: num(tag(prod, 'vDesc')),
      valorFrete: num(tag(prod, 'vFrete')),
      valorIcms: num(tag(imp, 'vICMS')),
      valorIpi: num(tag(imp, 'vIPI')),
      valorPis: num(tag(imp, 'vPIS')),
      valorCofins: num(tag(imp, 'vCOFINS'))
    });
  }
  return out;
}

function parseDuplicatas(xml) {
  const out = [];
  const cobr = tagAll(xml, 'cobr')[0] || '';
  const regex = /<dup>([\s\S]*?)<\/dup>/g;
  let m;
  while ((m = regex.exec(cobr)) !== null) {
    out.push({
      numero: tag(m[1], 'nDup'),
      dataVencimento: tag(m[1], 'dVenc'),
      valor: num(tag(m[1], 'vDup'))
    });
  }
  return out;
}

// Auto-match de um item de NF-e de entrada → produtoId existente:
// (1) código do fornecedor já aprendido em produto_codigos, (2) EAN (codigoBarras
// ou produto_codigos), (3) SKU. Retorna null se nada casar.
function matchProdutoEntrada(db, item, fornecedorId) {
  if (item.codigoProduto && fornecedorId) {
    const porFornecedor = db.prepare(`SELECT produtoId FROM produto_codigos
      WHERE codigo = ? AND tipo = 'fornecedor' AND fornecedorId = ? AND ativo = 1`).get(item.codigoProduto, fornecedorId);
    if (porFornecedor) return porFornecedor.produtoId;
  }
  const eanValido = item.ean && item.ean !== 'SEM GTIN' && item.ean.length >= 8;
  if (eanValido) {
    const porEan = db.prepare(`SELECT id FROM produtos WHERE codigoBarras = ? AND ativo = 1`).get(item.ean)
      || db.prepare(`SELECT produtoId AS id FROM produto_codigos WHERE codigo = ? AND tipo = 'ean' AND ativo = 1`).get(item.ean);
    if (porEan) return porEan.id;
  }
  if (item.codigoProduto) {
    const porSku = db.prepare(`SELECT id FROM produtos WHERE sku = ? AND ativo = 1`).get(item.codigoProduto);
    if (porSku) return porSku.id;
  }
  return null;
}

// Próximo SKU livre da série interna MERC-#### (usado quando o item não tem GTIN).
// NÃO usa o código do fornecedor — esse fica só no produto_codigos p/ auto-vínculo.
function proximoSkuInterno(db) {
  const row = db.prepare(`SELECT MAX(CAST(substr(sku, 6) AS INTEGER)) AS m
    FROM produtos WHERE sku GLOB 'MERC-[0-9]*'`).get();
  let seq = (row && row.m ? row.m : 0) + 1;
  let sku = `MERC-${String(seq).padStart(4, '0')}`;
  while (db.prepare('SELECT 1 FROM produtos WHERE sku = ?').get(sku)) {
    seq++;
    sku = `MERC-${String(seq).padStart(4, '0')}`;
  }
  return sku;
}

// Cria um produto novo a partir dos dados de um item de NF-e de entrada.
// item precisa ter: fornecedorId, ean, codigoProduto, descricao, unidade, valorUnitario, ncm.
// SKU = GTIN quando válido; senão série interna MERC-#### (nunca o código do fornecedor).
// Retorna o id do produto criado.
function criarProdutoDeItemNfe(db, item) {
  const eanValido = item.ean && item.ean !== 'SEM GTIN' && item.ean.length >= 8;
  let sku;
  if (eanValido) {
    sku = item.ean;
    let n = 1;
    while (db.prepare('SELECT 1 FROM produtos WHERE sku = ?').get(sku)) sku = `${item.ean}-${++n}`;
  } else {
    sku = proximoSkuInterno(db);
  }
  const r = db.prepare(`INSERT INTO produtos
    (sku, descricao, unidade, precoCusto, ncm, codigoBarras, fornecedorId, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(
    sku, item.descricao || 'Produto NF-e', item.unidade || 'UN',
    item.valorUnitario || 0, item.ncm || null,
    eanValido ? item.ean : null, item.fornecedorId || null
  );
  return r.lastInsertRowid;
}

async function aplicarShimAN() {
  try {
    const path = require('path');
    const DIST_URL = {
      producao: {
        NFeDistribuicaoDFe: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
        // Eventos AN (manifestação 210210/210200/210220/210240) — NÃO confundir com SVC-AN
        NFeRecepcaoEvento: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
      },
      homologacao: {
        NFeDistribuicaoDFe: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
        NFeRecepcaoEvento: 'https://hom.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
      }
    };
    for (const modName of ['mod65', 'mod55']) {
      const abs = path.resolve(__dirname, `node_modules/node-sped-nfe/dist/utils/webservices/${modName}.js`);
      const m = await import('file://' + abs);
      if (m.default.__patchedAN) continue;
      const orig = m.default.eventos;
      m.default.eventos = function(UF) {
        let base = null;
        try { base = orig(UF); } catch (e) { base = null; }
        if (UF === 'AN') {
          const b = base || { producao: {}, homologacao: {} };
          b.producao = { ...(b.producao||{}), ...DIST_URL.producao };
          b.homologacao = { ...(b.homologacao||{}), ...DIST_URL.homologacao };
          return b;
        }
        return base;
      };
      m.default.__patchedAN = true;
    }
  } catch (e) { console.error('[nfe-entrada] shim falhou:', e.message); }
}

// Sincroniza o inbox da NF-e (distribuição DFe) para o DB do tenant informado.
// Função reutilizável: chamada pelo endpoint HTTP e pelo scheduler master.
// IMPORTANTE: apenas baixa XMLs novos — NÃO manifesta ciência automaticamente.
// Se o tenant não tem certificado A1 ou NF-e config válida, lança ou retorna skipped.
async function sincronizarInboxNfe(db) {
  await aplicarShimAN();
  const tools = await getTools(db);
  const cursor = db.prepare('SELECT * FROM nfe_distribuicao_cursor WHERE id = 1').get();
  let ultNSU = cursor?.ultNSU || '0';
  let totalNovos = 0;
  let iteracoes = 0;
  let ultimoMax = cursor?.maxNSU || '0';
  let ultimoStatus = null;
  let ultimoMotivo = null;

  while (iteracoes < 20) {
    iteracoes++;
    const resp = await tools.sefazDistDFe({ ultNSU });
    const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
    const cStat = tag(str, 'cStat');
    const xMotivo = tag(str, 'xMotivo');
    ultimoStatus = cStat; ultimoMotivo = xMotivo;
    const maxNSU = tag(str, 'maxNSU') || ultNSU;
    const ultNSUResp = tag(str, 'ultNSU') || ultNSU;
    ultimoMax = maxNSU;

    if (cStat !== '138' && cStat !== '137') {
      const err = new Error(`SEFAZ cStat ${cStat}: ${xMotivo}`);
      err.cStat = cStat; err.xMotivo = xMotivo; err.raw = str.slice(0, 2000);
      throw err;
    }

    const docRegex = /<docZip\s+NSU="(\d+)"\s+schema="([^"]+)"[^>]*>([\s\S]*?)<\/docZip>/g;
    let m;
    const insertStmt = db.prepare(`INSERT OR IGNORE INTO nfe_entrada_inbox
      (chaveAcesso, nsu, schema, emitenteCnpj, emitenteRazaoSocial, numeroNF, serie, dataEmissao, valorTotal, tpNF, cStat, xmlResumo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const updateCompleto = db.prepare(`UPDATE nfe_entrada_inbox SET xmlCompleto = ? WHERE chaveAcesso = ?`);

    while ((m = docRegex.exec(str)) !== null) {
      const nsu = m[1];
      const schema = m[2];
      const xmlInterno = parseDocZip(m[3].trim());

      if (schema.startsWith('resNFe')) {
        const r = extrairResumo(xmlInterno);
        if (r.chaveAcesso) {
          const numero = r.chaveAcesso.substring(25, 34);
          const serie = r.chaveAcesso.substring(22, 25);
          const info = insertStmt.run(
            r.chaveAcesso, nsu, schema, r.emitenteCnpj, r.emitenteRazaoSocial,
            numero, serie, r.dataEmissao, r.valorTotal, r.tpNF, r.cStat, xmlInterno
          );
          if (info.changes > 0) totalNovos++;
        }
      } else if (schema.startsWith('procNFe')) {
        const chave = tag(xmlInterno, 'chNFe') || (tag(xmlInterno, 'infNFe')?.match(/Id="NFe(\d{44})"/) || [])[1];
        if (chave) updateCompleto.run(xmlInterno, chave);
      }
    }

    ultNSU = ultNSUResp;
    if (cStat === '137') break;
    if (Number(maxNSU) <= Number(ultNSU)) break;
  }

  db.prepare(`UPDATE nfe_distribuicao_cursor SET ultNSU = ?, maxNSU = ?, ultimaSincronizacao = CURRENT_TIMESTAMP WHERE id = 1`).run(ultNSU, ultimoMax);

  return { novos: totalNovos, ultNSU, maxNSU: ultimoMax, cStat: ultimoStatus, xMotivo: ultimoMotivo };
}

function registrarRotas(app, db) {
  migrar(db);

  app.post('/api/nfe-entrada/inbox/sincronizar', async (req, res) => {
    try {
      const r = await sincronizarInboxNfe(db);
      res.json({ success: true, ...r });
    } catch (err) {
      console.error('[nfe-entrada sincronizar]', err);
      if (err.cStat) {
        return res.status(400).json({ success: false, cStat: err.cStat, xMotivo: err.xMotivo, raw: err.raw });
      }
      let msg = err.message || String(err);
      if (err.errors) {
        msg += ' | causas: ' + err.errors.map(e => e.message || String(e)).join(' ; ');
      }
      if (err.cause) msg += ' | cause: ' + (err.cause.message || String(err.cause));
      res.status(500).json({ success: false, error: msg });
    }
  });

  app.get('/api/nfe-entrada/inbox', (req, res) => {
    try {
      const { situacao, busca } = req.query;
      let sql = 'SELECT id, chaveAcesso, nsu, emitenteCnpj, emitenteRazaoSocial, numeroNF, serie, dataEmissao, valorTotal, tpNF, cStat, situacao, statusManifestacao, ultimoEventoTp, dataUltimoEvento, dataDescoberta, (xmlCompleto IS NOT NULL) AS temXmlCompleto FROM nfe_entrada_inbox WHERE 1=1';
      const p = [];
      if (situacao) { sql += ' AND situacao = ?'; p.push(situacao); }
      if (busca) { sql += ' AND (emitenteRazaoSocial LIKE ? OR emitenteCnpj LIKE ? OR numeroNF LIKE ?)'; const t = '%'+busca+'%'; p.push(t,t,t); }
      sql += ' ORDER BY dataEmissao DESC, id DESC LIMIT 500';
      const items = db.prepare(sql).all(...p);
      const cursor = db.prepare('SELECT ultNSU, maxNSU, ultimaSincronizacao FROM nfe_distribuicao_cursor WHERE id = 1').get();
      res.json({ success: true, items, cursor });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/nfe-entrada/inbox/:chave/xml', (req, res) => {
    try {
      const row = db.prepare('SELECT xmlCompleto, xmlResumo, chaveAcesso FROM nfe_entrada_inbox WHERE chaveAcesso = ?').get(req.params.chave);
      if (!row) return res.status(404).json({ success: false, error: 'Não encontrada' });
      res.setHeader('Content-Type', 'application/xml');
      res.setHeader('Content-Disposition', `attachment; filename="${row.chaveAcesso}.xml"`);
      res.send(row.xmlCompleto || row.xmlResumo || '');
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Pré-visualização parseada (funciona com xmlCompleto OU xmlResumo da consulta DFe).
  // Cabecalho/itens/duplicatas só vêm completos quando temXmlCompleto.
  app.get('/api/nfe-entrada/inbox/:chave/preview', (req, res) => {
    try {
      const row = db.prepare(`SELECT chaveAcesso, nsu, situacao, statusManifestacao,
        emitenteCnpj, emitenteRazaoSocial, numeroNF, serie, dataEmissao, valorTotal, tpNF,
        xmlCompleto, xmlResumo FROM nfe_entrada_inbox WHERE chaveAcesso = ?`).get(req.params.chave);
      if (!row) return res.status(404).json({ success: false, error: 'Não encontrada' });

      const temXmlCompleto = !!row.xmlCompleto;
      const xml = row.xmlCompleto || row.xmlResumo || '';
      let cabecalho = null, itens = [], duplicatas = [];
      if (xml) {
        try { cabecalho = parseCabecalho(xml); } catch {}
        if (temXmlCompleto) {
          try { itens = parseItens(xml); } catch {}
          try { duplicatas = parseDuplicatas(xml); } catch {}
        }
      }

      res.json({
        success: true,
        inbox: {
          chaveAcesso: row.chaveAcesso,
          nsu: row.nsu,
          situacao: row.situacao,
          statusManifestacao: row.statusManifestacao,
          emitenteCnpj: row.emitenteCnpj,
          emitenteRazaoSocial: row.emitenteRazaoSocial,
          numeroNF: row.numeroNF,
          serie: row.serie,
          dataEmissao: row.dataEmissao,
          valorTotal: row.valorTotal,
          tpNF: row.tpNF,
          temXmlCompleto
        },
        cabecalho, itens, duplicatas
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // DANFE PDF direto da inbox (antes de importar). Exige xmlCompleto.
  app.get('/api/nfe-entrada/inbox/:chave/danfe', async (req, res) => {
    try {
      const row = db.prepare('SELECT xmlCompleto, numeroNF FROM nfe_entrada_inbox WHERE chaveAcesso = ?').get(req.params.chave);
      if (!row) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!row.xmlCompleto) {
        return res.status(400).json({ success: false, error: 'XML completo ainda não recebido. Faça Ciência + XML primeiro.' });
      }
      const logo = db.prepare('SELECT logoBase64 FROM fornecedor WHERE id = 1').get()?.logoBase64 || undefined;
      const { DANFe } = await import('node-sped-pdf');
      const buf = await DANFe({ xml: row.xmlCompleto, logo });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="DANFE-${row.numeroNF || req.params.chave}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[DANFE-inbox] erro:', err);
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  app.post('/api/nfe-entrada/inbox/:chave/importar', (req, res) => {
    try {
      const inbox = db.prepare(`SELECT * FROM nfe_entrada_inbox WHERE chaveAcesso = ?`).get(req.params.chave);
      if (!inbox) return res.status(404).json({ success: false, error: 'Inbox não encontrada' });
      if (!inbox.xmlCompleto) return res.status(400).json({ success: false, error: 'XML completo ainda não recebido. Sincronize de novo.' });
      const ja = db.prepare(`SELECT id FROM nfe_entrada WHERE chaveAcesso = ?`).get(inbox.chaveAcesso);
      if (ja) return res.status(400).json({ success: false, error: 'Já importada', nfeId: ja.id });

      const xml = inbox.xmlCompleto;
      const cab = parseCabecalho(xml);
      const itens = parseItens(xml);
      const dups = parseDuplicatas(xml);

      const tx = db.transaction(() => {
        // Fornecedor (auto-criar por CNPJ se não existir)
        let fornecedorId = null;
        if (cab.emitenteCnpj) {
          const existe = db.prepare(`SELECT id FROM fornecedores WHERE cpfCnpj = ?`).get(cab.emitenteCnpj);
          if (existe) fornecedorId = existe.id;
          else {
            const r = db.prepare(`INSERT INTO fornecedores
              (cpfCnpj, tipo, razaoSocial, inscricaoEstadual, endereco, numero, complemento, bairro, codigoMunicipio, cidade, uf, cep, telefone)
              VALUES (?, 'PJ', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              cab.emitenteCnpj, cab.emitenteRazaoSocial, cab.emitenteIe,
              cab.endereco, cab.numero, cab.complemento, cab.bairro,
              cab.codigoMunicipio, cab.cidade, cab.uf, cab.cep, cab.telefone
            );
            fornecedorId = r.lastInsertRowid;
          }
        }

        const r = db.prepare(`INSERT INTO nfe_entrada
          (chaveAcesso, numero, serie, dataEmissao, dataEntrada, naturezaOperacao,
           emitenteCnpj, emitenteRazaoSocial, emitenteUf, emitenteIe, fornecedorId,
           valorProdutos, valorFrete, valorDesconto, valorOutros, valorIcms, valorIpi, valorTotal,
           tpNF, protocoloAutorizacao, xmlOriginal)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          cab.chaveAcesso, cab.numero, cab.serie, cab.dataEmissao, new Date().toISOString().slice(0,10),
          cab.naturezaOperacao, cab.emitenteCnpj, cab.emitenteRazaoSocial, cab.uf, cab.emitenteIe,
          fornecedorId, cab.valorProdutos, cab.valorFrete, cab.valorDesconto, cab.valorOutros,
          cab.valorIcms, cab.valorIpi, cab.valorTotal, cab.tpNF, cab.protocolo, xml
        );
        const nfeId = r.lastInsertRowid;

        // Aplica De/Para de CFOP: fornecedor emite em saída (5/6), convertemos em entrada (1/2).
        // cfopOriginal guarda o valor do XML; cfop recebe o mapeado. Se não há mapeamento,
        // cfop fica igual ao original e cfopPendenteMapeamento=1 para revisão.
        const { mapearCfopEntrada } = require('./cfops-entrada-map-routes');

        const insItem = db.prepare(`INSERT INTO nfe_entrada_itens
          (nfeId, numero, codigoProduto, descricao, ean, ncm, cfop, cfopOriginal, cfopPendenteMapeamento,
           unidade, quantidade, valorUnitario, valorTotal, valorDesconto, valorFrete, valorIcms, valorIpi,
           valorPis, valorCofins, produtoId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const it of itens) {
          const map = mapearCfopEntrada(db, it.cfop);
          insItem.run(nfeId, it.numero, it.codigoProduto, it.descricao, it.ean, it.ncm,
            map.cfopNosso, it.cfop, map.pendente ? 1 : 0,
            it.unidade, it.quantidade, it.valorUnitario, it.valorTotal,
            it.valorDesconto, it.valorFrete, it.valorIcms, it.valorIpi,
            it.valorPis || 0, it.valorCofins || 0, matchProdutoEntrada(db, it, fornecedorId));
        }

        const insDup = db.prepare(`INSERT INTO nfe_entrada_duplicatas (nfeId, numero, dataVencimento, valor) VALUES (?, ?, ?, ?)`);
        for (const d of dups) insDup.run(nfeId, d.numero, d.dataVencimento, d.valor);

        db.prepare(`UPDATE nfe_entrada_inbox SET situacao = 'importada', nfeEntradaId = ?, dataImportacao = CURRENT_TIMESTAMP WHERE chaveAcesso = ?`)
          .run(nfeId, cab.chaveAcesso);

        return nfeId;
      });
      const nfeId = tx();
      res.json({ success: true, nfeId, fornecedorAutoCriado: !!cab.emitenteCnpj, itens: itens.length, duplicatas: dups.length });
    } catch (err) {
      console.error('[nfe-entrada importar]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Importar NF-e a partir de um XML enviado por upload (fornecedor mandou o arquivo por fora
  // do DistDFe). Injeta na mesma caixa de entrada como 'pendente' com xmlCompleto, reaproveitando
  // o botão "Importar" (fornecedor, mapeamento CFOP, match de produto, duplicatas).
  app.post('/api/nfe-entrada/inbox/importar-xml', uploadXmlNfe.single('arquivo'), (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, error: 'Nenhum arquivo enviado.' });
      }
      const buf = req.file.buffer;
      const prolog = buf.slice(0, 200).toString('latin1');
      const enc = /encoding\s*=\s*["']?iso-8859-1["']?/i.test(prolog) ? 'latin1' : 'utf8';
      const xml = buf.toString(enc).replace(/^\uFEFF/, '').trim();

      if (!/infNFe/.test(xml) || !/<(nfeProc|NFe)[\s>]/.test(xml)) {
        return res.status(400).json({ success: false, error: 'O arquivo não é um XML de NF-e (tag infNFe não encontrada).' });
      }

      const cab = parseCabecalho(xml);
      if (!cab.chaveAcesso || !/^\d{44}$/.test(cab.chaveAcesso)) {
        return res.status(400).json({ success: false, error: 'Chave de acesso (44 dígitos) não encontrada no XML.' });
      }

      // multer consome o stream de forma assíncrona e perde o contexto de tenant
      // (AsyncLocalStorage), então o proxy `db` falha. Usa o handle concreto que o
      // tenant-middleware deixa em req.tenantDb (fallback ao proxy fora do multi-tenant).
      const tdb = req.tenantDb || db;

      const jaImportada = tdb.prepare('SELECT id FROM nfe_entrada WHERE chaveAcesso = ?').get(cab.chaveAcesso);
      if (jaImportada) {
        return res.status(400).json({ success: false, error: `Esta NF-e já foi importada (nota #${jaImportada.id}).`, nfeId: jaImportada.id });
      }

      const existe = tdb.prepare('SELECT chaveAcesso FROM nfe_entrada_inbox WHERE chaveAcesso = ?').get(cab.chaveAcesso);
      if (existe) {
        tdb.prepare(`UPDATE nfe_entrada_inbox SET
            xmlCompleto = ?, schema = 'procNFe', situacao = 'pendente',
            emitenteCnpj = COALESCE(emitenteCnpj, ?),
            emitenteRazaoSocial = COALESCE(emitenteRazaoSocial, ?),
            numeroNF = COALESCE(numeroNF, ?), serie = COALESCE(serie, ?),
            dataEmissao = COALESCE(dataEmissao, ?), valorTotal = COALESCE(valorTotal, ?),
            tpNF = COALESCE(tpNF, ?)
          WHERE chaveAcesso = ?`).run(
          xml, cab.emitenteCnpj, cab.emitenteRazaoSocial, cab.numero, cab.serie,
          cab.dataEmissao, cab.valorTotal, cab.tpNF, cab.chaveAcesso);
      } else {
        tdb.prepare(`INSERT INTO nfe_entrada_inbox
            (chaveAcesso, nsu, schema, emitenteCnpj, emitenteRazaoSocial, numeroNF, serie,
             dataEmissao, valorTotal, tpNF, xmlCompleto, situacao, dataDescoberta)
          VALUES (?, NULL, 'procNFe', ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', CURRENT_TIMESTAMP)`).run(
          cab.chaveAcesso, cab.emitenteCnpj, cab.emitenteRazaoSocial, cab.numero, cab.serie,
          cab.dataEmissao, cab.valorTotal, cab.tpNF, xml);
      }

      res.json({
        success: true,
        chaveAcesso: cab.chaveAcesso,
        emitente: cab.emitenteRazaoSocial,
        numeroNF: cab.numero,
        temProtocolo: !!cab.protocolo,
        jaNaInbox: !!existe
      });
    } catch (err) {
      console.error('[nfe-entrada importar-xml]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/nfe-entrada', (req, res) => {
    try {
      const { situacao, statusEstoque, fornecedorId, dataInicio, dataFim, busca, incluirExcluidas } = req.query;
      let sql = `SELECT n.*, f.razaoSocial AS fornecedorNome, (SELECT COUNT(*) FROM nfe_entrada_itens WHERE nfeId=n.id) AS totalItens
                 FROM nfe_entrada n LEFT JOIN fornecedores f ON f.id = n.fornecedorId WHERE 1=1`;
      const p = [];
      if (incluirExcluidas !== '1') { sql += ' AND COALESCE(n.excluida, 0) = 0'; }
      if (situacao) { sql += ' AND n.situacao = ?'; p.push(situacao); }
      if (statusEstoque) { sql += ' AND n.statusEstoque = ?'; p.push(statusEstoque); }
      if (fornecedorId) { sql += ' AND n.fornecedorId = ?'; p.push(Number(fornecedorId)); }
      if (dataInicio) { sql += ' AND n.dataEmissao >= ?'; p.push(dataInicio); }
      if (dataFim)    { sql += ' AND n.dataEmissao <= ?'; p.push(dataFim + 'T23:59:59'); }
      if (busca) { sql += ' AND (n.emitenteRazaoSocial LIKE ? OR n.emitenteCnpj LIKE ? OR n.numero LIKE ? OR n.chaveAcesso LIKE ?)'; const t = '%'+busca+'%'; p.push(t,t,t,t); }
      sql += ' ORDER BY n.dataEmissao DESC LIMIT 500';
      res.json({ success: true, notas: db.prepare(sql).all(...p) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/nfe-entrada/:id', (req, res) => {
    try {
      const nota = db.prepare(`SELECT n.*, f.razaoSocial AS fornecedorNome FROM nfe_entrada n LEFT JOIN fornecedores f ON f.id=n.fornecedorId WHERE n.id = ?`).get(req.params.id);
      if (!nota) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const itens = db.prepare(`SELECT i.*, p.sku, p.descricao AS produtoDescricao FROM nfe_entrada_itens i LEFT JOIN produtos p ON p.id=i.produtoId WHERE nfeId = ? ORDER BY numero`).all(req.params.id);
      const duplicatas = db.prepare(`SELECT * FROM nfe_entrada_duplicatas WHERE nfeId = ? ORDER BY dataVencimento`).all(req.params.id);
      res.json({ success: true, nota, itens, duplicatas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfe-entrada/inbox/:chave/manifestar', async (req, res) => {
    try {
      const tpEvento = String(req.body?.tpEvento || '210210');
      if (!['210210','210200','210220','210240'].includes(tpEvento)) {
        return res.status(400).json({ success: false, error: 'tpEvento inválido (210210|210200|210220|210240)' });
      }
      const xJust = (req.body?.xJust || req.body?.justificativa || '').trim();
      const r = await executarManifestacao(req.params.chave, tpEvento, xJust);
      res.status(r.http).json(r.body);
    } catch (err) {
      console.error('[nfe-entrada manifestar]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/nfe-entrada/inbox/:chave/baixar-xml', async (req, res) => {
    try {
      await aplicarShimAN();
      const tools = await getTools(db);
      // docZip aceita atributos em qualquer ordem (NSU/schema)
      const docRegex2 = /<docZip\b([^>]*)>([\s\S]*?)<\/docZip>/g;
      const attrSchema = /schema="([^"]+)"/;

      let baixado = false;
      let cStat = null, xMotivo = null;
      const schemasVistos = [];

      // Tenta até 3x com intervalo de 3s — procNFe pode demorar a aparecer após Ciência
      for (let tentativa = 1; tentativa <= 3 && !baixado; tentativa++) {
        const resp = await tools.sefazDistDFe({ chNFe: req.params.chave });
        const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
        cStat = tag(str, 'cStat');
        xMotivo = tag(str, 'xMotivo');

        docRegex2.lastIndex = 0;
        let mm;
        while ((mm = docRegex2.exec(str)) !== null) {
          const schema = (mm[1].match(attrSchema) || [])[1] || '';
          schemasVistos.push(schema);
          if (schema.startsWith('procNFe')) {
            const xmlInterno = parseDocZip(mm[2].trim());
            db.prepare(`UPDATE nfe_entrada_inbox SET xmlCompleto = ? WHERE chaveAcesso = ?`).run(xmlInterno, req.params.chave);
            baixado = true;
            break;
          }
        }

        if (!baixado && tentativa < 3) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      res.json({
        success: baixado,
        cStat,
        xMotivo,
        schemasEncontrados: [...new Set(schemasVistos)],
        aviso: baixado ? null : 'procNFe ainda não disponível. A Ciência foi registrada — aguarde 1-5 min e clique em "🔄 Buscar novidades" para pegar o XML completo via NSU.'
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfe-entrada/inbox/:chave/ignorar', (req, res) => {
    try {
      db.prepare(`UPDATE nfe_entrada_inbox SET situacao = 'ignorada' WHERE chaveAcesso = ?`).run(req.params.chave);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== VINCULAÇÃO ITEM → PRODUTO ====================

  app.post('/api/nfe-entrada/itens/:itemId/vincular', (req, res) => {
    try {
      const item = db.prepare(`SELECT i.*, n.fornecedorId FROM nfe_entrada_itens i
        JOIN nfe_entrada n ON n.id = i.nfeId WHERE i.id = ?`).get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Item não encontrado' });

      let produtoId = req.body?.produtoId ? Number(req.body.produtoId) : null;

      if (req.body?.novoProduto) {
        produtoId = criarProdutoDeItemNfe(db, item);
      }

      if (!produtoId) return res.status(400).json({ success: false, error: 'produtoId ou novoProduto obrigatório' });
      const produto = db.prepare('SELECT id, sku, descricao FROM produtos WHERE id = ?').get(produtoId);
      if (!produto) return res.status(404).json({ success: false, error: 'Produto não encontrado' });

      db.prepare('UPDATE nfe_entrada_itens SET produtoId = ? WHERE id = ?').run(produtoId, req.params.itemId);

      // Aprende o código deste fornecedor: próxima NF-e do mesmo fornecedor
      // com o mesmo código vincula sozinha (produto_codigos tipo 'fornecedor').
      if (item.codigoProduto && item.fornecedorId) {
        try {
          db.prepare(`INSERT OR IGNORE INTO produto_codigos (produtoId, codigo, tipo, fornecedorId)
            VALUES (?, ?, 'fornecedor', ?)`).run(produtoId, item.codigoProduto, item.fornecedorId);
        } catch { /* aprendizado é best-effort */ }
      }
      res.json({ success: true, produto });
    } catch (err) {
      console.error('[vincular item]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cria e vincula produto para TODOS os itens da nota ainda sem vínculo, de uma vez.
  // Para cada item: re-tenta o auto-match (fornecedor/EAN/SKU) e, se não casar, cria um
  // produto novo com os dados da NF-e. Aprende o código do fornecedor a cada vínculo.
  app.post('/api/nfe-entrada/:id/vincular-todos', (req, res) => {
    try {
      const nfe = db.prepare('SELECT id, fornecedorId, statusEstoque FROM nfe_entrada WHERE id = ?').get(req.params.id);
      if (!nfe) return res.status(404).json({ success: false, error: 'NF-e não encontrada' });
      if (nfe.statusEstoque && nfe.statusEstoque !== 'pendente') {
        return res.status(400).json({ success: false, error: 'Estoque já aplicado — reverta antes de alterar vínculos.' });
      }

      const itens = db.prepare('SELECT * FROM nfe_entrada_itens WHERE nfeId = ? AND produtoId IS NULL').all(nfe.id);
      if (!itens.length) {
        return res.json({ success: true, vinculadosExistente: 0, criados: 0, total: 0, semVinculo: 0 });
      }

      let vinculadosExistente = 0, criados = 0;
      const aprenderCodigo = db.prepare(`INSERT OR IGNORE INTO produto_codigos (produtoId, codigo, tipo, fornecedorId)
        VALUES (?, ?, 'fornecedor', ?)`);
      const vincular = db.prepare('UPDATE nfe_entrada_itens SET produtoId = ? WHERE id = ?');

      const tx = db.transaction(() => {
        for (const it of itens) {
          const item = { ...it, fornecedorId: nfe.fornecedorId };
          let produtoId = matchProdutoEntrada(db, item, nfe.fornecedorId);
          if (produtoId) vinculadosExistente++;
          else { produtoId = criarProdutoDeItemNfe(db, item); criados++; }
          vincular.run(produtoId, it.id);
          if (it.codigoProduto && nfe.fornecedorId) {
            try { aprenderCodigo.run(produtoId, it.codigoProduto, nfe.fornecedorId); } catch { /* best-effort */ }
          }
        }
      });
      tx();

      const semVinculo = db.prepare('SELECT COUNT(*) AS c FROM nfe_entrada_itens WHERE nfeId = ? AND produtoId IS NULL').get(nfe.id).c;
      res.json({ success: true, vinculadosExistente, criados, total: itens.length, semVinculo });
    } catch (err) {
      console.error('[vincular-todos]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== APLICAR / REVERTER ESTOQUE ====================

  app.post('/api/nfe-entrada/:id/aplicar-estoque', (req, res) => {
    try {
      const nfe = db.prepare('SELECT * FROM nfe_entrada WHERE id = ?').get(req.params.id);
      if (!nfe) return res.status(404).json({ success: false, error: 'NF-e não encontrada' });
      if (nfe.statusEstoque === 'aplicado') return res.status(400).json({ success: false, error: 'Já aplicada ao estoque' });

      const itens = db.prepare('SELECT * FROM nfe_entrada_itens WHERE nfeId = ? AND ignorado = 0').all(req.params.id);
      const semVinculo = itens.filter(i => !i.produtoId);
      if (semVinculo.length) {
        return res.status(400).json({
          success: false,
          error: `${semVinculo.length} item(ns) sem produto vinculado`,
          itensPendentes: semVinculo.map(i => ({ id: i.id, numero: i.numero, descricao: i.descricao }))
        });
      }

      const dataMov = (nfe.dataEmissao || '').slice(0, 10) || dataBrasilia();
      const obs = `NF-e ${nfe.numero}/${nfe.serie} · ${nfe.emitenteRazaoSocial || ''}`.trim();

      // Depósito de destino opcional (NULL = depósito padrão, ver estoque-routes)
      let depositoDestinoId = null;
      if (req.body && req.body.depositoId) {
        const dep = db.prepare('SELECT id FROM depositos WHERE id = ? AND ativo = 1').get(Number(req.body.depositoId));
        if (!dep) return res.status(400).json({ success: false, error: 'Depósito de destino inexistente ou inativo' });
        depositoDestinoId = dep.id;
      }

      // Configuração fiscal do tenant (única linha em fornecedor — id=1).
      // NULL/desconhecido = comportamento conservador (ICMS/PIS/COFINS no custo,
      // IPI somado).
      const tenantRow = db.prepare(
        'SELECT regimeTributario, contribuinteIPI, regimeApuracaoPISCOFINS FROM fornecedor WHERE id = 1'
      ).get();
      const fiscalCfg = {
        regimeTributario: tenantRow?.regimeTributario || null,
        contribuinteIPI: tenantRow?.contribuinteIPI ? 1 : 0,
        regimeApuracaoPISCOFINS: tenantRow?.regimeApuracaoPISCOFINS || null,
      };

      const totaisNF = {
        valorProdutos: nfe.valorProdutos,
        valorFrete: nfe.valorFrete,
        valorOutros: nfe.valorOutros,
        valorDesconto: nfe.valorDesconto,
      };

      const movimentacoes = [];
      const tx = db.transaction(() => {
        for (const it of itens) {
          const saldoRow = db.prepare(`
            SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                                      WHEN tipo='saida' THEN -quantidade
                                      ELSE quantidade END), 0) AS saldo
            FROM movimentacoes_estoque WHERE produtoId = ?`).get(it.produtoId);
          const saldoAtual = Number(saldoRow.saldo) || 0;
          const prod = db.prepare('SELECT precoCusto FROM produtos WHERE id = ?').get(it.produtoId);
          const custoAtual = Number(prod?.precoCusto) || 0;
          const custoNovo = calcularCustoUnitarioLiquido(it, totaisNF, fiscalCfg);
          const qtdNova = Number(it.quantidade) || 0;

          let novoCusto;
          if (saldoAtual <= 0 || custoAtual <= 0) {
            novoCusto = custoNovo;
          } else {
            novoCusto = (saldoAtual * custoAtual + qtdNova * custoNovo) / (saldoAtual + qtdNova);
          }

          const r = db.prepare(`INSERT INTO movimentacoes_estoque
            (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, depositoId)
            VALUES (?, 'entrada', ?, ?, 'nfe_entrada', ?, ?, ?, ?)`).run(
            it.produtoId, qtdNova, custoNovo, nfe.id, obs, dataMov, depositoDestinoId
          );
          db.prepare('UPDATE nfe_entrada_itens SET movimentacaoEstoqueId = ? WHERE id = ?')
            .run(r.lastInsertRowid, it.id);
          db.prepare('UPDATE produtos SET precoCusto = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
            .run(Number(novoCusto.toFixed(4)), it.produtoId);

          movimentacoes.push({
            itemId: it.id,
            produtoId: it.produtoId,
            qtd: qtdNova,
            custoBruto: Number(it.valorUnitario) || 0,
            custoLiquido: Number(custoNovo.toFixed(4)),
            saldoAnterior: saldoAtual,
            precoCustoNovo: Number(novoCusto.toFixed(4)),
          });
        }
        db.prepare(`UPDATE nfe_entrada SET statusEstoque = 'aplicado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(req.params.id);
      });
      tx();

      res.json({ success: true, fiscalCfg, movimentacoes });
    } catch (err) {
      console.error('[aplicar-estoque]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/nfe-entrada/:id/reverter-estoque', (req, res) => {
    try {
      const nfe = db.prepare('SELECT * FROM nfe_entrada WHERE id = ?').get(req.params.id);
      if (!nfe) return res.status(404).json({ success: false, error: 'NF-e não encontrada' });
      if (nfe.statusEstoque !== 'aplicado') return res.status(400).json({ success: false, error: 'Estoque não está aplicado' });

      const tx = db.transaction(() => {
        db.prepare(`DELETE FROM movimentacoes_estoque WHERE origem = 'nfe_entrada' AND origemId = ?`).run(nfe.id);
        db.prepare(`UPDATE nfe_entrada_itens SET movimentacaoEstoqueId = NULL WHERE nfeId = ?`).run(nfe.id);
        db.prepare(`UPDATE nfe_entrada SET statusEstoque = 'pendente', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(nfe.id);
      });
      tx();
      res.json({ success: true, aviso: 'Movimentações removidas. O preço de custo dos produtos NÃO foi revertido (histórico cumulativo).' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== GERAR / REVERTER CONTAS A PAGAR ====================

  app.post('/api/nfe-entrada/:id/gerar-contas-pagar', (req, res) => {
    try {
      const nfe = db.prepare('SELECT * FROM nfe_entrada WHERE id = ?').get(req.params.id);
      if (!nfe) return res.status(404).json({ success: false, error: 'NF-e não encontrada' });
      if (!nfe.fornecedorId) return res.status(400).json({ success: false, error: 'NF-e sem fornecedor vinculado' });
      if (nfe.statusFinanceiro === 'gerado') return res.status(400).json({ success: false, error: 'Contas a pagar já geradas' });

      const dups = db.prepare('SELECT * FROM nfe_entrada_duplicatas WHERE nfeId = ? ORDER BY dataVencimento').all(nfe.id);
      const dataEmi = (nfe.dataEmissao || '').slice(0, 10) || dataBrasilia();

      // Se não houver duplicatas, cria uma única conta com venc = dataEmissao + 30d
      let parcelas = dups;
      if (!parcelas.length) {
        const d = new Date(dataEmi + 'T00:00:00');
        d.setDate(d.getDate() + 30);
        parcelas = [{ id: null, numero: '001', dataVencimento: d.toISOString().slice(0, 10), valor: nfe.valorTotal }];
      }

      const inseridas = [];
      const tx = db.transaction(() => {
        for (const d of parcelas) {
          const desc = `NF-e ${nfe.numero}/${nfe.serie} · dup ${d.numero || '-'}`;
          const r = db.prepare(`INSERT INTO contas_a_pagar
            (fornecedorId, nfeEntradaId, duplicataId, descricao, valor,
             dataEmissao, dataVencimento, status, origem)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'aberta', 'nfe_entrada')`).run(
            nfe.fornecedorId, nfe.id, d.id || null, desc, Number(d.valor) || 0,
            dataEmi, d.dataVencimento || dataEmi
          );
          if (d.id) {
            db.prepare('UPDATE nfe_entrada_duplicatas SET contaPagarId = ? WHERE id = ?')
              .run(r.lastInsertRowid, d.id);
          }
          inseridas.push({ contaPagarId: r.lastInsertRowid, duplicataId: d.id, valor: d.valor, vencimento: d.dataVencimento });
        }
        db.prepare(`UPDATE nfe_entrada SET statusFinanceiro = 'gerado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(nfe.id);
      });
      tx();
      res.json({ success: true, contas: inseridas });
    } catch (err) {
      console.error('[gerar-contas-pagar]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/nfe-entrada/:id/reverter-contas-pagar', (req, res) => {
    try {
      const nfe = db.prepare('SELECT * FROM nfe_entrada WHERE id = ?').get(req.params.id);
      if (!nfe) return res.status(404).json({ success: false, error: 'NF-e não encontrada' });

      const temPaga = db.prepare(`SELECT COUNT(*) AS n FROM contas_a_pagar
        WHERE nfeEntradaId = ? AND status != 'aberta'`).get(nfe.id);
      if (temPaga.n > 0) {
        return res.status(400).json({ success: false, error: 'Há contas pagas ou canceladas; reversão bloqueada' });
      }

      const tx = db.transaction(() => {
        db.prepare(`UPDATE nfe_entrada_duplicatas SET contaPagarId = NULL
          WHERE contaPagarId IN (SELECT id FROM contas_a_pagar WHERE nfeEntradaId = ?)`).run(nfe.id);
        db.prepare(`DELETE FROM contas_a_pagar WHERE nfeEntradaId = ? AND status = 'aberta'`).run(nfe.id);
        db.prepare(`UPDATE nfe_entrada SET statusFinanceiro = 'pendente', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(nfe.id);
      });
      tx();
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== GESTÃO UNIFICADA NF-e (entrada + saída) ====================
  // Endpoints consumidos por /notas-fiscais.html para listar, editar metadados,
  // excluir (soft) e restaurar NFs lançadas no sistema.

  app.get('/api/notas-fiscais', (req, res) => {
    try {
      const { tipo = 'todas', busca, dataInicio, dataFim, status = 'ativa',
              cfop, tipoOperacao, statusSefaz, limite = 100, offset = 0 } = req.query;
      const params = [];

      // Para ENTRADA: tipoOperacaoId não existe (entrada classifica-se por CFOP).
      // statusSefaz é derivado de situacao: 'recebida'/'processada' → autorizada,
      // 'cancelada' → cancelada_sefaz. Pra entradas com xmlCompleto disponível,
      // o DANFE pode ser gerado pelo endpoint /api/nfe-entrada/:id/danfe.
      // Entrada: CFOP fica em nfe_entrada_itens (por item). Mesmo padrão
      // da saída — agregamos os CFOPs distintos numa string ("5102,5949").
      const sqlEntrada = `
        SELECT 'entrada' AS tipo, n.id, n.numero, n.serie, n.chaveAcesso,
               n.dataEmissao, n.valorTotal AS valor,
               n.situacao AS status, n.statusEstoque, n.statusFinanceiro,
               (SELECT GROUP_CONCAT(DISTINCT cfop) FROM nfe_entrada_itens
                  WHERE nfeId = n.id AND cfop IS NOT NULL AND cfop != '') AS cfop,
               NULL AS tipoOperacaoCodigo,
               n.naturezaOperacao AS tipoOperacaoDescricao,
               CASE
                 WHEN n.situacao IN ('recebida','processada') THEN 'autorizada'
                 WHEN n.situacao = 'cancelada' THEN 'cancelada_sefaz'
                 WHEN n.situacao = 'rejeitada' THEN 'rejeitada'
                 ELSE n.situacao
               END AS statusSefaz,
               (ib.xmlCompleto IS NOT NULL) AS temXmlCompleto,
               COALESCE(n.excluida, 0) AS excluida, n.dataExclusao, n.motivoExclusao,
               n.observacaoInterna,
               COALESCE(f.razaoSocial, n.emitenteRazaoSocial) AS pessoaNome,
               COALESCE(f.cpfCnpj, n.emitenteCnpj) AS pessoaCpfCnpj
          FROM nfe_entrada n
          LEFT JOIN fornecedores f ON f.id = n.fornecedorId
          LEFT JOIN nfe_entrada_inbox ib ON ib.chaveAcesso = n.chaveAcesso
      `;
      // Saída: CFOP fica em fatura_itens (por item). Agregamos os CFOPs
      // distintos dos itens em uma lista (ex.: "5102,5949") pra exibição
      // e filtragem por LIKE.
      const sqlSaida = `
        SELECT 'saida' AS tipo, fa.id, fa.numero, COALESCE(fa.serieNFe, '1') AS serie, fa.chaveAcesso,
               fa.dataEmissao, fa.valorTotal AS valor,
               fa.status, NULL AS statusEstoque, fa.statusSefaz AS statusFinanceiro,
               (SELECT GROUP_CONCAT(DISTINCT cfop) FROM fatura_itens
                  WHERE faturaId = fa.id AND cfop IS NOT NULL AND cfop != '') AS cfop,
               op.codigo AS tipoOperacaoCodigo,
               op.descricao AS tipoOperacaoDescricao,
               fa.statusSefaz AS statusSefaz,
               (fa.xmlAssinado IS NOT NULL) AS temXmlCompleto,
               COALESCE(fa.excluida, 0) AS excluida, fa.dataExclusao, fa.motivoExclusao,
               fa.observacaoInterna,
               p.razaoSocial AS pessoaNome,
               p.cpfCnpj AS pessoaCpfCnpj
          FROM faturas fa
          LEFT JOIN pessoas p ON p.id = fa.clienteId
          LEFT JOIN tipos_operacao op ON op.id = fa.tipoOperacaoId
      `;

      let union;
      if (tipo === 'entrada') union = sqlEntrada;
      else if (tipo === 'saida') union = sqlSaida;
      else union = `${sqlEntrada} UNION ALL ${sqlSaida}`;

      let where = '';
      if (status === 'ativa') where = ' WHERE excluida = 0';
      else if (status === 'excluida') where = ' WHERE excluida = 1';

      if (busca) {
        where += where ? ' AND' : ' WHERE';
        where += ' (chaveAcesso LIKE ? OR numero LIKE ? OR pessoaNome LIKE ? OR pessoaCpfCnpj LIKE ?)';
        const t = `%${busca}%`;
        params.push(t, t, t, t);
      }
      if (dataInicio) {
        where += where ? ' AND' : ' WHERE';
        where += ' dataEmissao >= ?';
        params.push(dataInicio);
      }
      if (dataFim) {
        where += where ? ' AND' : ' WHERE';
        where += ' dataEmissao <= ?';
        params.push(dataFim + 'T23:59:59');
      }
      if (cfop) {
        // ENTRADA tem cfop como string única; SAÍDA tem GROUP_CONCAT(itens.cfop).
        // LIKE com % cobre os dois casos.
        where += where ? ' AND' : ' WHERE';
        where += ' cfop LIKE ?';
        params.push(`%${cfop}%`);
      }
      if (tipoOperacao) {
        // Filtrar por tipo de operação só faz sentido pra saída — entradas têm
        // tipoOperacaoCodigo NULL, então automaticamente são excluídas.
        where += where ? ' AND' : ' WHERE';
        where += ' tipoOperacaoCodigo = ?';
        params.push(tipoOperacao);
      }
      if (statusSefaz) {
        where += where ? ' AND' : ' WHERE';
        where += ' statusSefaz = ?';
        params.push(statusSefaz);
      }

      const sqlFinal = `SELECT * FROM (${union})${where} ORDER BY dataEmissao DESC LIMIT ? OFFSET ?`;
      params.push(Number(limite), Number(offset));

      const rows = db.prepare(sqlFinal).all(...params);
      const notasNormalizadas = rows.map(r => ({
        ...r,
        pessoa: { nome: r.pessoaNome, cpfCnpj: r.pessoaCpfCnpj },
        links: {
          detalhe: r.tipo === 'entrada'
            ? `/fiscal/nfe-entrada-detalhe.html?chave=${encodeURIComponent(r.chaveAcesso || '')}`
            : `/fiscal/nfe-detalhe.html?id=${r.id}`,
          danfe: r.statusSefaz === 'autorizada' && r.temXmlCompleto
            ? (r.tipo === 'entrada' ? `/api/nfe-entrada/${r.id}/danfe` : `/api/faturas/${r.id}/danfe`)
            : null
        }
      }));
      res.json({ success: true, notas: notasNormalizadas });
    } catch (err) {
      console.error('[notas-fiscais]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DANFE de NF-e de entrada — renderiza a partir do XML completo capturado
  // pela manifestação de inbox (nfe_entrada_inbox.xmlCompleto). Só funciona
  // para NFs cujo XML completo já foi baixado da SEFAZ.
  app.get('/api/nfe-entrada/:id/danfe', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const nfe = db.prepare('SELECT id, numero, chaveAcesso FROM nfe_entrada WHERE id = ?').get(id);
      if (!nfe) return res.status(404).json({ success: false, error: 'NF-e de entrada não encontrada' });
      if (!nfe.chaveAcesso) return res.status(400).json({ success: false, error: 'NF-e sem chave de acesso (lançamento manual)' });
      const inbox = db.prepare('SELECT xmlCompleto FROM nfe_entrada_inbox WHERE chaveAcesso = ?').get(nfe.chaveAcesso);
      if (!inbox || !inbox.xmlCompleto) {
        return res.status(400).json({
          success: false,
          error: 'XML completo não disponível. Sincronize o inbox SEFAZ para baixar o XML completo.'
        });
      }
      const logo = db.prepare('SELECT logoBase64 FROM fornecedor WHERE id = 1').get()?.logoBase64 || undefined;
      const { DANFe } = await import('node-sped-pdf');
      const buf = await DANFe({ xml: inbox.xmlCompleto, logo });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="DANFE-entrada-${nfe.numero || nfe.id}.pdf"`);
      res.send(buf);
    } catch (err) {
      console.error('[DANFE-entrada] erro:', err);
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });

  app.put('/api/nfe-entrada/:id/metadados', (req, res) => {
    try {
      const id = Number(req.params.id);
      const r = db.prepare(`UPDATE nfe_entrada
        SET observacaoInterna = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(req.body?.observacaoInterna || null, id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Não encontrada' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/nfe-entrada/:id/excluir', (req, res) => {
    try {
      const id = Number(req.params.id);
      const motivo = String(req.body?.motivo || '').trim();
      if (!motivo) return res.status(400).json({ success: false, error: 'Motivo obrigatório' });
      const nfe = db.prepare('SELECT * FROM nfe_entrada WHERE id = ?').get(id);
      if (!nfe) return res.status(404).json({ success: false, error: 'NF-e não encontrada' });
      if (nfe.excluida) return res.status(400).json({ success: false, error: 'NF-e já está excluída' });

      // Bloqueia se houver CP paga/cancelada
      const temPaga = db.prepare(`SELECT COUNT(*) AS n FROM contas_a_pagar
        WHERE nfeEntradaId = ? AND status != 'aberta'`).get(id);
      if (temPaga.n > 0) {
        return res.status(409).json({ success: false, error: 'Há contas a pagar pagas/canceladas vinculadas; cancele-as primeiro' });
      }

      const tx = db.transaction(() => {
        if (nfe.statusEstoque === 'aplicado') {
          db.prepare(`DELETE FROM movimentacoes_estoque WHERE origem = 'nfe_entrada' AND origemId = ?`).run(id);
          db.prepare(`UPDATE nfe_entrada_itens SET movimentacaoEstoqueId = NULL WHERE nfeId = ?`).run(id);
        }
        db.prepare(`UPDATE nfe_entrada_duplicatas SET contaPagarId = NULL
          WHERE contaPagarId IN (SELECT id FROM contas_a_pagar WHERE nfeEntradaId = ?)`).run(id);
        db.prepare(`DELETE FROM contas_a_pagar WHERE nfeEntradaId = ? AND status = 'aberta'`).run(id);
        db.prepare(`UPDATE nfe_entrada SET
          excluida = 1, dataExclusao = CURRENT_TIMESTAMP, motivoExclusao = ?,
          statusEstoque = 'pendente', statusFinanceiro = 'pendente',
          dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?`).run(motivo, id);
      });
      tx();
      res.json({ success: true });
    } catch (err) {
      console.error('[nfe-entrada excluir]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/nfe-entrada/:id/restaurar', (req, res) => {
    try {
      const r = db.prepare(`UPDATE nfe_entrada
        SET excluida = 0, dataExclusao = NULL, motivoExclusao = NULL,
        dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ? AND excluida = 1`).run(Number(req.params.id));
      if (!r.changes) return res.status(404).json({ success: false, error: 'NF-e não encontrada ou não estava excluída' });
      res.json({ success: true, aviso: 'Lançamento restaurado. Estoque e contas a pagar não são reaplicados automaticamente.' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CRUD CONTAS A PAGAR — MOVIDO PARA contas-pagar-routes.js ====================
  // Endpoints /api/contas-a-pagar/** e /api/cp-* agora vivem em contas-pagar-routes.js.
  // Este bloco fica inerte aqui; mantemos somente os endpoints acoplados à NF-e (gerar/reverter-contas-pagar acima).

  /* removido — ver contas-pagar-routes.js
  app.get('/api/contas-a-pagar', (req, res) => {
    try {
      const { status, fornecedorId, vencAte, busca } = req.query;
      let sql = `SELECT cp.*, f.razaoSocial AS fornecedorNome, f.cpfCnpj AS fornecedorCnpj,
                   n.numero AS nfeNumero, n.serie AS nfeSerie
                 FROM contas_a_pagar cp
                 LEFT JOIN fornecedores f ON f.id = cp.fornecedorId
                 LEFT JOIN nfe_entrada n ON n.id = cp.nfeEntradaId
                 WHERE 1=1`;
      const p = [];
      if (status) {
        if (status === 'vencida') {
          sql += ` AND cp.status = 'aberta' AND cp.dataVencimento < DATE('now','-3 hours')`;
        } else {
          sql += ' AND cp.status = ?'; p.push(status);
        }
      }
      if (fornecedorId) { sql += ' AND cp.fornecedorId = ?'; p.push(Number(fornecedorId)); }
      if (vencAte) { sql += ' AND cp.dataVencimento <= ?'; p.push(vencAte); }
      if (busca) {
        sql += ' AND (f.razaoSocial LIKE ? OR cp.descricao LIKE ?)';
        const t = '%' + busca + '%'; p.push(t, t);
      }
      sql += ' ORDER BY cp.dataVencimento ASC, cp.id DESC LIMIT 500';
      const contas = db.prepare(sql).all(...p);
      res.json({ success: true, contas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/contas-a-pagar/:id', (req, res) => {
    try {
      const conta = db.prepare(`SELECT cp.*, f.razaoSocial AS fornecedorNome, f.cpfCnpj AS fornecedorCnpj,
          n.numero AS nfeNumero, n.serie AS nfeSerie
        FROM contas_a_pagar cp
        LEFT JOIN fornecedores f ON f.id = cp.fornecedorId
        LEFT JOIN nfe_entrada n ON n.id = cp.nfeEntradaId
        WHERE cp.id = ?`).get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Não encontrada' });
      res.json({ success: true, conta });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contas-a-pagar', (req, res) => {
    try {
      const { fornecedorId, descricao, valor, dataVencimento, dataEmissao, formaPagamento, observacoes } = req.body || {};
      if (!fornecedorId || !descricao || valor == null || !dataVencimento) {
        return res.status(400).json({ success: false, error: 'fornecedorId, descricao, valor e dataVencimento são obrigatórios' });
      }
      const fornec = db.prepare('SELECT id FROM fornecedores WHERE id = ? AND ativo = 1').get(Number(fornecedorId));
      if (!fornec) return res.status(404).json({ success: false, error: 'Fornecedor não encontrado' });

      const r = db.prepare(`INSERT INTO contas_a_pagar
        (fornecedorId, descricao, valor, dataEmissao, dataVencimento, formaPagamento, observacoes, origem, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'aberta')`).run(
        Number(fornecedorId), descricao, Number(valor),
        dataEmissao || dataBrasilia(), dataVencimento,
        formaPagamento || null, observacoes || null
      );
      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, conta });
    } catch (err) {
      console.error('[criar CP]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/contas-a-pagar/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (existing.status !== 'aberta') {
        return res.status(400).json({ success: false, error: 'Só contas abertas podem ser editadas' });
      }
      const { descricao, valor, dataVencimento, formaPagamento, observacoes, fornecedorId } = req.body || {};
      db.prepare(`UPDATE contas_a_pagar SET
          descricao = ?, valor = ?, dataVencimento = ?,
          formaPagamento = ?, observacoes = ?, fornecedorId = ?,
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        descricao || existing.descricao,
        valor != null ? Number(valor) : existing.valor,
        dataVencimento || existing.dataVencimento,
        formaPagamento ?? existing.formaPagamento,
        observacoes ?? existing.observacoes,
        fornecedorId ? Number(fornecedorId) : existing.fornecedorId,
        req.params.id
      );
      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      res.json({ success: true, conta });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contas-a-pagar/:id/baixar', (req, res) => {
    try {
      const { contaFinanceiraId, valorPago, dataPagamento, formaPagamento } = req.body || {};
      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (conta.status === 'paga') return res.status(400).json({ success: false, error: 'Conta já paga' });
      if (conta.status === 'cancelada') return res.status(400).json({ success: false, error: 'Conta cancelada' });
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });

      const contaFin = db.prepare('SELECT * FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!contaFin) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });

      const vp = Number(valorPago) || conta.valor;
      const dp = dataPagamento || dataBrasilia();

      const tx = db.transaction(() => {
        db.prepare(`UPDATE contas_a_pagar SET status = 'paga', valorPago = ?, dataPagamento = ?,
          formaPagamento = COALESCE(?, formaPagamento), contaFinanceiraId = ?,
          dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(
          vp, dp, formaPagamento || null, contaFinanceiraId, req.params.id
        );
        lancarMovimentacao(db, {
          contaId: contaFinanceiraId,
          tipo: 'saida', valor: vp, data: dp,
          descricao: `Pagto CP: ${conta.descricao}`,
          origem: 'baixa_cp', origemId: conta.id,
          categoria: 'fornecedores',
          usuario: req.session?.username || null
        });
      });
      tx();

      const updated = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      res.json({ success: true, conta: updated });
    } catch (err) {
      console.error('[baixar CP]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/contas-a-pagar/:id/cancelar', (req, res) => {
    try {
      const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(req.params.id);
      if (!conta) return res.status(404).json({ success: false, error: 'Conta não encontrada' });
      if (conta.status !== 'aberta') return res.status(400).json({ success: false, error: 'Só contas abertas podem ser canceladas' });
      db.prepare(`UPDATE contas_a_pagar SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
  */

  // ==================== MANIFESTAÇÃO DO DESTINATÁRIO ====================
  // Eventos: 210210 Ciência, 210200 Confirmação, 210220 Desconhecimento, 210240 Não realizada (com xJust)

  const MAP_EVENTO_STATUS = {
    '210210': 'ciencia',
    '210200': 'confirmada',
    '210220': 'desconhecida',
    '210240': 'nao_realizada'
  };

  async function executarManifestacao(chave, tpEvento, xJust) {
    const inbox = db.prepare('SELECT * FROM nfe_entrada_inbox WHERE chaveAcesso = ?').get(chave);
    if (!inbox) return { http: 404, body: { success: false, error: 'NF-e não encontrada no inbox' } };
    if (tpEvento === '210240' && (!xJust || xJust.trim().length < 15)) {
      return { http: 400, body: { success: false, error: 'Justificativa ≥ 15 caracteres obrigatória para operação não realizada' } };
    }

    await aplicarShimAN();
    const tools = await getTools(db);
    const args = { chNFe: chave, tpEvento, nSeqEvento: 1 };
    if (tpEvento === '210240') args.xJust = xJust.trim();

    const resp = await tools.sefazEvento(args);
    const str = typeof resp === 'string' ? resp : JSON.stringify(resp);
    const retEvMatch = str.match(/<retEvento[^>]*>([\s\S]*?)<\/retEvento>/);
    const inner = retEvMatch ? retEvMatch[1] : '';
    const cStat = tag(inner, 'cStat') || tag(str, 'cStat');
    const xMotivo = tag(inner, 'xMotivo') || tag(str, 'xMotivo');
    const nProt = tag(inner, 'nProt');

    // 135 = Evento registrado e vinculado, 136 = Registrado mas não vinculado, 155 = Registrado fora do prazo
    const ok = ['135', '136', '155'].includes(cStat);
    if (ok) {
      db.prepare(`UPDATE nfe_entrada_inbox SET
        statusManifestacao = ?, ultimoEventoTp = ?, ultimoEventoProt = ?, dataUltimoEvento = CURRENT_TIMESTAMP
        WHERE chaveAcesso = ?`).run(MAP_EVENTO_STATUS[tpEvento], tpEvento, nProt || null, chave);
    }
    return {
      http: ok ? 200 : 400,
      body: { success: ok, cStat, xMotivo, nProt, tpEvento, raw: ok ? undefined : str.slice(0, 2000) }
    };
  }

  app.post('/api/nfe-entrada/inbox/:chave/ciencia', async (req, res) => {
    try { const r = await executarManifestacao(req.params.chave, '210210'); res.status(r.http).json(r.body); }
    catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });

  app.post('/api/nfe-entrada/inbox/:chave/confirmar', async (req, res) => {
    try { const r = await executarManifestacao(req.params.chave, '210200'); res.status(r.http).json(r.body); }
    catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });

  app.post('/api/nfe-entrada/inbox/:chave/desconhecer', async (req, res) => {
    try { const r = await executarManifestacao(req.params.chave, '210220'); res.status(r.http).json(r.body); }
    catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });

  app.post('/api/nfe-entrada/inbox/:chave/nao-realizada', async (req, res) => {
    try {
      const xJust = (req.body?.justificativa || req.body?.xJust || '').trim();
      const r = await executarManifestacao(req.params.chave, '210240', xJust);
      res.status(r.http).json(r.body);
    } catch (err) { res.status(500).json({ success: false, error: String(err.message || err) }); }
  });

  // Busca ativa: manifesta Ciência da Operação (210210) em lote nas notas que só
  // têm resumo (sem XML completo) e ainda não foram manifestadas — o que libera o
  // procNFe na DistDFe — e re-sincroniza pra baixá-lo. Só o XML completo gera DANFE.
  // On-demand (ciência é evento fiscal real); o XML pode chegar nesta sync ou nas
  // próximas (a SEFAZ disponibiliza o completo após a ciência, às vezes com atraso).
  app.post('/api/nfe-entrada/inbox/buscar-xml-completos', async (req, res) => {
    try {
      // Ciência da Operação tem prazo de 10 dias após a autorização (SEFAZ rejeita
      // com cStat 596 fora disso). Só tenta as que ainda estão na janela — evita
      // martelar a SEFAZ com notas antigas que nunca serão aceitas.
      const pendentes = db.prepare(`
        SELECT chaveAcesso FROM nfe_entrada_inbox
        WHERE xmlCompleto IS NULL AND xmlResumo IS NOT NULL
          AND (statusManifestacao IS NULL OR statusManifestacao = '')
          AND julianday('now') - julianday(substr(dataEmissao, 1, 10)) <= 10
        ORDER BY dataEmissao ASC
      `).all();

      const out = { total: pendentes.length, manifestadas: 0, jaRegistradas: 0, falhas: [] };
      for (const { chaveAcesso } of pendentes) {
        try {
          const r = await executarManifestacao(chaveAcesso, '210210');
          if (r.body?.success) out.manifestadas++;
          else if (r.body?.cStat === '573') out.jaRegistradas++; // 573 = evento já registrado
          else {
            // 596 = fora do prazo: marca pra não re-tentar em runs futuros
            if (r.body?.cStat === '596') {
              db.prepare(`UPDATE nfe_entrada_inbox SET statusManifestacao = 'prazo_expirado' WHERE chaveAcesso = ?`).run(chaveAcesso);
            }
            out.falhas.push({ chave: chaveAcesso, cStat: r.body?.cStat, xMotivo: r.body?.xMotivo });
          }
        } catch (e) {
          out.falhas.push({ chave: chaveAcesso, erro: String(e.message || e) });
        }
      }

      let sync = null;
      if (out.manifestadas > 0 || out.jaRegistradas > 0) {
        try { sync = await sincronizarInboxNfe(db); } catch (e) { sync = { erro: String(e.message || e) }; }
      }
      const comXmlCompleto = db.prepare(`SELECT COUNT(*) n FROM nfe_entrada_inbox WHERE xmlCompleto IS NOT NULL`).get().n;
      res.json({ success: true, ...out, sync, totalComXmlCompleto: comXmlCompleto });
    } catch (err) {
      console.error('[nfe-entrada buscar-xml-completos]', err);
      res.status(500).json({ success: false, error: String(err.message || err) });
    }
  });
}

module.exports = { registrarRotasNfeEntrada: registrarRotas, sincronizarInboxNfe, aplicarShimAN };
