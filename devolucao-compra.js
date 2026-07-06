'use strict';

/**
 * devolucao-compra.js — Devolução de COMPRA (espelho da NF-e de entrada).
 *
 * Distinta da devolução de VENDA (devolucoes-routes.js / RMA de cliente). Aqui a gente
 * devolve mercadoria ao FORNECEDOR: NF-e de SAÍDA (tpNF=1, finNFe=4), CFOP 5xxx/6xxx,
 * refNFe = chave da entrada, destinatário = fornecedor, ESPELHANDO os impostos que o
 * fornecedor destacou (pra ele creditar de volta). Suporta total e parcial.
 *
 * FASE 1 (este arquivo, por enquanto): só dados + extração —
 *   - migrarSchema(db): colunas de espelho em faturas/fatura_itens + tabela cfops_devolucao_map (seed)
 *   - parseEspelhoEntrada(xmlOriginal): imposto completo por item a partir do XML da entrada
 *   - cfopDevolucao(db, cfopEntrada, mesmaUF): CFOP de devolução espelhando a entrada
 *   - montarItensEspelho(...): casa itens da entrada (nfe_entrada_itens) com o parse do XML
 * A emissão (motor tpNF=1) e os endpoints/UI vêm nas Fases 2-4.
 *
 * O regime do 1bit é Simples Nacional (CRT=1). O tratamento fiscal exato do ICMS/IPI
 * reproduzido no Simples (CSOSN 900 c/ destaque vs. informações complementares) está em
 * confirmação com o contador — por isso a Fase 1 só EXTRAI os valores; não emite.
 */

// ─── Helpers de XML (mesmo estilo regex do nfe-entrada-routes.js) ────────────
function tag(str, t) {
  const re = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'i');
  const m = str && str.match(re);
  return m ? m[1].trim() : null;
}
function tagAll(str, t) {
  const re = new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, 'gi');
  const out = []; let m;
  while ((m = re.exec(str)) !== null) out.push(m[1]);
  return out;
}
function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* idempotente */ } }

// ─── Schema ──────────────────────────────────────────────────────────────────
function migrarSchema(db) {
  // Vínculo da fatura de devolução com a entrada de origem + tipo de devolução.
  // (isDevolucao / devolucaoId / refNFeOriginal / tipoOperacaoId já são criados por
  //  devolucoes-routes.js; aqui só somamos o que falta pra devolução de COMPRA.)
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN nfeEntradaId INTEGER");
  alterSafe(db, "ALTER TABLE faturas ADD COLUMN tipoDevolucao TEXT"); // 'venda' | 'compra'

  // Impostos espelhados por item (o fatura_itens original não guarda CST/base/alíquota).
  // fatura_itens.origem já existe. Demais são idempotentes via alterSafe.
  const colsItem = [
    'nfeEntradaItemId INTEGER', // rastreia qual item da entrada originou (p/ saldo parcial)
    'cstIcms TEXT', 'csosn TEXT', 'modBCIcms TEXT',
    'vBCIcms REAL', 'pIcms REAL', 'vIcms REAL',
    'vBCST REAL', 'pIcmsST REAL', 'vIcmsST REAL',
    'cstIpi TEXT', 'vBCIpi REAL', 'pIpi REAL', 'vIpi REAL',
    'cstPis TEXT', 'vBCPis REAL', 'pPis REAL', 'vPis REAL',
    'cstCofins TEXT', 'vBCCofins REAL', 'pCofins REAL', 'vCofins REAL',
  ];
  for (const c of colsItem) alterSafe(db, `ALTER TABLE fatura_itens ADD COLUMN ${c}`);

  // De/Para de CFOP: entrada (nossa) → devolução de saída. O 5xxx (mesma UF) vs 6xxx
  // (outra UF) é resolvido em cfopDevolucao() pela UF do fornecedor; a tabela guarda a
  // família por sufixo. Ex.: compra p/ comercialização 1102/2102 → devolução 5202/6202.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cfops_devolucao_map (
      cfopEntrada TEXT PRIMARY KEY,   -- CFOP da entrada (nossa): 1xxx ou 2xxx
      sufixoDevolucao TEXT NOT NULL,  -- 3 últimos dígitos do CFOP de devolução (prefixo 5/6 é por UF)
      descricao TEXT
    );
  `);
  const seed = [
    // entradaCFOP, sufixoDevolucao, descrição
    ['1101', '201', 'Devolução de compra para industrialização'],
    ['2101', '201', 'Devolução de compra para industrialização'],
    ['1102', '202', 'Devolução de compra para comercialização'],
    ['2102', '202', 'Devolução de compra para comercialização'],
    ['1116', '202', 'Devolução de compra p/ comercialização (encomenda entrega futura)'],
    ['2116', '202', 'Devolução de compra p/ comercialização (encomenda entrega futura)'],
    ['1118', '202', 'Devolução de compra p/ comercialização (mercadoria pelo vendedor)'],
    ['1401', '410', 'Devolução de compra p/ industrialização em operação com ST'],
    ['2401', '410', 'Devolução de compra p/ industrialização em operação com ST'],
    ['1403', '411', 'Devolução de compra p/ comercialização em operação com ST'],
    ['2403', '411', 'Devolução de compra p/ comercialização em operação com ST'],
    ['1551', '553', 'Devolução de compra de bem para o ativo imobilizado'],
    ['2551', '553', 'Devolução de compra de bem para o ativo imobilizado'],
    ['1556', '556', 'Devolução de compra de material de uso ou consumo'],
    ['2556', '556', 'Devolução de compra de material de uso ou consumo'],
  ];
  const ins = db.prepare('INSERT OR IGNORE INTO cfops_devolucao_map (cfopEntrada, sufixoDevolucao, descricao) VALUES (?, ?, ?)');
  for (const s of seed) ins.run(...s);
}

// Resolve o CFOP de devolução espelhando a entrada. mesmaUF = fornecedor na mesma UF do
// emitente (1bit) → prefixo 5; senão 6. Retorna { cfop, doMapa } — doMapa=false sinaliza
// fallback (a UI/contador deve revisar CFOPs não mapeados).
function cfopDevolucao(db, cfopEntrada, mesmaUF) {
  const prefixo = mesmaUF ? '5' : '6';
  const row = db.prepare('SELECT sufixoDevolucao FROM cfops_devolucao_map WHERE cfopEntrada = ?').get(String(cfopEntrada || '').trim());
  if (row) return { cfop: prefixo + row.sufixoDevolucao, doMapa: true };
  // Fallback conservador: devolução de compra p/ comercialização (mais comum).
  return { cfop: prefixo + '202', doMapa: false };
}

// ─── Parser de espelho: imposto COMPLETO por item, do XML da entrada ─────────
// Extrai o que o motor precisa pra reproduzir a tributação (não confia nas colunas
// resumidas de nfe_entrada_itens). Cobre ICMS (normal e SN), ST, IPI, PIS, COFINS.
function parseImpostoItem(body) {
  const imp = tagAll(body, 'imposto')[0] || '';
  const icmsGrp = tagAll(imp, 'ICMS')[0] || '';       // wrapper que contém ICMS00/10/.../ICMSSNxxx
  const ipiGrp = tagAll(imp, 'IPI')[0] || '';
  const pisGrp = tagAll(imp, 'PIS')[0] || '';
  const cofinsGrp = tagAll(imp, 'COFINS')[0] || '';

  return {
    origem: tag(icmsGrp, 'orig') || '0',
    cstIcms: tag(icmsGrp, 'CST'),      // null se for Simples (usa CSOSN)
    csosn: tag(icmsGrp, 'CSOSN'),
    modBCIcms: tag(icmsGrp, 'modBC'),
    vBCIcms: num(tag(icmsGrp, 'vBC')),
    pIcms: num(tag(icmsGrp, 'pICMS')),
    vIcms: num(tag(icmsGrp, 'vICMS')),
    // Substituição tributária (quando houver)
    vBCST: num(tag(icmsGrp, 'vBCST')),
    pIcmsST: num(tag(icmsGrp, 'pICMSST')),
    vIcmsST: num(tag(icmsGrp, 'vICMSST')),
    // IPI (destaque em IPITrib; IPINT/IPINT só tem CST)
    cstIpi: tag(ipiGrp, 'CST'),
    vBCIpi: num(tag(ipiGrp, 'vBC')),
    pIpi: num(tag(ipiGrp, 'pIPI')),
    vIpi: num(tag(ipiGrp, 'vIPI')),
    // PIS/COFINS
    cstPis: tag(pisGrp, 'CST'),
    vBCPis: num(tag(pisGrp, 'vBC')),
    pPis: num(tag(pisGrp, 'pPIS')),
    vPis: num(tag(pisGrp, 'vPIS')),
    cstCofins: tag(cofinsGrp, 'CST'),
    vBCCofins: num(tag(cofinsGrp, 'vBC')),
    pCofins: num(tag(cofinsGrp, 'pCOFINS')),
    vCofins: num(tag(cofinsGrp, 'vCOFINS')),
  };
}

// Retorna um item por <det> do XML da entrada, com prod + imposto completo espelhado.
// Atenção: `cfopFornecedorXml` é o CFOP do EMITENTE (fornecedor, 5xxx) — NÃO usar pra
// devolução. O CFOP de devolução deriva do NOSSO CFOP de entrada (nfe_entrada_itens.cfop,
// já convertido no import via cfops_entrada_map). Ver montarItensEspelho().
function parseEspelhoEntrada(xmlOriginal) {
  const out = [];
  const regex = /<det\s+nItem="(\d+)"[^>]*>([\s\S]*?)<\/det>/g;
  let m;
  while ((m = regex.exec(xmlOriginal)) !== null) {
    const numero = Number(m[1]);
    const body = m[2];
    const prod = tagAll(body, 'prod')[0] || '';
    out.push({
      numero,
      codigoProduto: tag(prod, 'cProd'),
      descricao: tag(prod, 'xProd'),
      ncm: tag(prod, 'NCM'),
      cfopFornecedorXml: tag(prod, 'CFOP'), // CFOP do fornecedor (saída dele) — não é o nosso
      unidade: tag(prod, 'uCom'),
      quantidade: num(tag(prod, 'qCom')),
      valorUnitario: num(tag(prod, 'vUnCom')),
      valorTotal: num(tag(prod, 'vProd')),
      valorDesconto: num(tag(prod, 'vDesc')),
      valorFrete: num(tag(prod, 'vFrete')),
      imposto: parseImpostoItem(body),
    });
  }
  return out;
}

// Monta o "espelho" de UMA entrada: junta os itens gravados (nfe_entrada_itens — nosso CFOP,
// produtoId, qtd recebida) com os impostos parseados do XML (casados por número do item).
// Retorna, por item: nosso CFOP de entrada, CFOP de devolução espelhado, produtoId,
// quantidade recebida e o bloco de imposto a reproduzir. NÃO grava nada (Fase 1 = leitura).
function montarItensEspelho(db, nfeId, opts = {}) {
  const ent = db.prepare('SELECT id, emitenteUf, xmlOriginal FROM nfe_entrada WHERE id = ?').get(nfeId);
  if (!ent) throw new Error('Entrada não encontrada: ' + nfeId);
  const nossaUf = (opts.nossaUf || '').toUpperCase();
  const mesmaUF = nossaUf ? (String(ent.emitenteUf || '').toUpperCase() === nossaUf) : true;

  const impostoPorNumero = new Map();
  for (const it of parseEspelhoEntrada(ent.xmlOriginal)) impostoPorNumero.set(it.numero, it);

  const itensDb = db.prepare(
    'SELECT id, numero, codigoProduto, descricao, ncm, cfop, unidade, quantidade, valorUnitario, valorTotal, produtoId FROM nfe_entrada_itens WHERE nfeId = ? ORDER BY numero'
  ).all(nfeId);

  return itensDb.map(dbi => {
    const xml = impostoPorNumero.get(dbi.numero) || null;
    const dev = cfopDevolucao(db, dbi.cfop, mesmaUF); // nosso CFOP de entrada → devolução
    return {
      nfeEntradaItemId: dbi.id,
      numero: dbi.numero,
      produtoId: dbi.produtoId,
      codigoProduto: dbi.codigoProduto,
      descricao: dbi.descricao,
      ncm: dbi.ncm,
      unidade: dbi.unidade,
      quantidadeRecebida: dbi.quantidade,
      valorUnitario: dbi.valorUnitario,
      valorTotal: dbi.valorTotal,
      cfopEntradaNosso: dbi.cfop,
      cfopDevolucao: dev.cfop,
      cfopDevolucaoDoMapa: dev.doMapa,
      imposto: xml ? xml.imposto : null, // valores a espelhar (parcial = rateio proporcional na Fase 3)
    };
  });
}

// Registra as ROTAS (chamado pelo route-registry 1x no boot com o db PROXY).
// A migration NÃO roda aqui: contra o proxy (fora de contexto de tenant) seria no-op.
// migrarSchema(tdb) é aplicado por-tenant no boot loop do server.js (padrão boleto-orchestrator).
function registrar(app, db) {
  // ─── Preview do espelho de devolução (READ-ONLY — não emite nada) ─────────
  // Base da UI de seleção de itens. Retorna, por item da entrada: nosso CFOP de
  // entrada, CFOP de devolução espelhado, saldo disponível (recebido − já devolvido)
  // e o bloco de imposto a reproduzir (valores da qtd cheia; o rateio parcial é feito
  // no cliente proporcional à qtd selecionada). Seguro: independe das decisões fiscais.
  app.get('/api/nfe-entrada/:id/devolucao/preview', (req, res) => {
    try {
      const nfeId = Number(req.params.id);
      const ent = db.prepare(
        'SELECT id, numero, serie, chaveAcesso, emitenteRazaoSocial, emitenteCnpj, emitenteUf, fornecedorId, valorProdutos, valorTotal, statusEstoque, statusFinanceiro FROM nfe_entrada WHERE id = ?'
      ).get(nfeId);
      if (!ent) return res.status(404).json({ success: false, error: 'Entrada não encontrada' });

      let nossaUf = '';
      try { const emit = db.prepare('SELECT uf FROM fornecedor ORDER BY id DESC LIMIT 1').get(); nossaUf = (emit && emit.uf) || ''; } catch {}

      const itens = montarItensEspelho(db, nfeId, { nossaUf });

      // Saldo já devolvido por item (Fase 3 grava as faturas de devolução; hoje = 0).
      const jaDev = db.prepare(
        `SELECT fi.nfeEntradaItemId AS iid, SUM(fi.quantidade) AS q
           FROM fatura_itens fi JOIN faturas f ON f.id = fi.faturaId
          WHERE f.tipoDevolucao = 'compra' AND f.nfeEntradaId = ? AND IFNULL(f.excluida,0) = 0
          GROUP BY fi.nfeEntradaItemId`
      ).all(nfeId);
      const devMap = new Map(jaDev.map(r => [r.iid, r.q || 0]));
      for (const it of itens) {
        const dev = devMap.get(it.nfeEntradaItemId) || 0;
        it.quantidadeDevolvida = dev;
        it.saldoDisponivel = Math.max(0, (it.quantidadeRecebida || 0) - dev);
      }

      res.json({
        success: true,
        entrada: {
          id: ent.id, numero: ent.numero, serie: ent.serie, chave: ent.chaveAcesso,
          fornecedor: ent.emitenteRazaoSocial, cnpj: ent.emitenteCnpj, uf: ent.emitenteUf,
          valorTotal: ent.valorTotal, statusEstoque: ent.statusEstoque, statusFinanceiro: ent.statusFinanceiro,
        },
        nossaUf,
        natOp: 'Devolução de compra',
        itens,
        avisos: { cfopsForaDoMapa: itens.filter(i => !i.cfopDevolucaoDoMapa).length },
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // TODO Fase 3: POST /api/nfe-entrada/:id/devolucao (efetiva + emite via motor espelho)
}

module.exports = {
  registrar,
  migrarSchema,
  cfopDevolucao,
  parseEspelhoEntrada,
  parseImpostoItem,
  montarItensEspelho,
  // helpers expostos p/ teste
  _internal: { tag, tagAll, num },
};
