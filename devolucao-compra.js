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
const { garantirFornecedor } = require('./pessoas-fornecedor');

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
    // IPI (destaque em IPITrib; IPINT só tem CST). cEnq = enquadramento legal (obrigatório).
    cstIpi: tag(ipiGrp, 'CST'),
    cEnqIpi: tag(ipiGrp, 'cEnq') || '999',
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

  // ─── Emitir devolução de compra (cria fatura espelho + emite NF-e) ────────
  app.post('/api/nfe-entrada/:id/devolucao', async (req, res) => {
    try {
      const nfeId = Number(req.params.id);
      const ent = db.prepare('SELECT * FROM nfe_entrada WHERE id = ?').get(nfeId);
      if (!ent) return res.status(404).json({ success: false, error: 'Entrada não encontrada' });

      let nossaUf = '';
      try { nossaUf = (db.prepare('SELECT uf FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}).uf || ''; } catch {}
      const espelho = montarItensEspelho(db, nfeId, { nossaUf });

      // Seleção: body.total = tudo; senão body.itens [{ nfeEntradaItemId, quantidade }].
      let quantidades = null;
      if (!req.body.total) {
        const sel = Array.isArray(req.body.itens) ? req.body.itens : [];
        quantidades = new Map();
        for (const s of sel) { const q = Number(s.quantidade); if (q > 0) quantidades.set(Number(s.nfeEntradaItemId), q); }
        if (!quantidades.size) return res.status(400).json({ success: false, error: 'Selecione itens/quantidades (ou envie total:true)' });
      }

      // Trava de saldo: qtd devolvida acumulada (devoluções não-excluídas e não-rejeitadas)
      // + esta não pode passar do recebido.
      const jaDev = db.prepare(
        `SELECT fi.nfeEntradaItemId AS iid, SUM(fi.quantidade) AS q
           FROM fatura_itens fi JOIN faturas f ON f.id = fi.faturaId
          WHERE f.tipoDevolucao='compra' AND f.nfeEntradaId=? AND IFNULL(f.excluida,0)=0
            AND IFNULL(f.statusSefaz,'') <> 'rejeitada'
          GROUP BY fi.nfeEntradaItemId`
      ).all(nfeId);
      const devMap = new Map(jaDev.map(r => [r.iid, r.q || 0]));
      for (const it of espelho) {
        const pedido = quantidades ? (quantidades.get(it.nfeEntradaItemId) || 0) : it.quantidadeRecebida;
        const saldo = (it.quantidadeRecebida || 0) - (devMap.get(it.nfeEntradaItemId) || 0);
        if (pedido > saldo + 1e-6) {
          return res.status(400).json({ success: false, error: `Item ${it.numero}: devolução ${pedido} > saldo disponível ${saldo.toFixed(4)}` });
        }
      }

      const { itens: tags, totais } = calcularImpostoEspelho(espelho, quantidades);
      if (!tags.length) return res.status(400).json({ success: false, error: 'Nada a devolver' });

      // faturas.pedidoId é NOT NULL (venda). Devolução de compra não tem pedido → torna nulável
      // (rebuild idempotente, só na 1ª vez). Destinatário = pessoa do fornecedor.
      tornarPedidoIdNulavel(db);
      const pessoaId = garantirPessoaFornecedor(db, ent);

      const seq = (db.prepare(`SELECT COUNT(*) c FROM faturas WHERE tipoDevolucao='compra' AND nfeEntradaId=?`).get(nfeId).c) + 1;
      const numero = `DEVC-${ent.numero || nfeId}/${seq}`;
      const hoje = new Date().toISOString().slice(0, 10);
      const chaveRef = (ent.chaveAcesso || '').replace(/\D/g, '');

      const faturaId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO faturas (numero, pedidoId, clienteId, dataEmissao, dataVencimento,
            valorBruto, valorTotal, status, observacao, isDevolucao, refNFeOriginal,
            nfeEntradaId, tipoDevolucao)
          VALUES (?, NULL, ?, ?, ?, ?, ?, 'emitida', ?, 1, ?, ?, 'compra')
        `).run(numero, pessoaId, hoje, hoje, Number(totais.vNF), Number(totais.vNF),
          `Devolução de compra ref. NF-e ${ent.numero || ''}${req.body.motivo ? ' · ' + req.body.motivo : ''}`,
          chaveRef, nfeId);
        const fid = r.lastInsertRowid;
        const stmt = db.prepare(`
          INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade, quantidade,
            precoUnitario, valorTotal, ncm, cfop, origem, nfeEntradaItemId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const t of tags) {
          stmt.run(fid, t.produtoId || null, t.produtoId ? String(t.produtoId) : '', (t.descricao || '').substring(0, 120),
            t.unidade || 'UN', t.quantidade, t.valorUnitario, t.vProd, t.ncm || '00000000', t.cfop,
            t.icms.orig, t.nfeEntradaItemId);
        }
        return fid;
      })();

      // Emite a NF-e (o emitirNFe detecta tipoDevolucao='compra' e usa o modo espelho).
      const { emitirNFe } = require('./nfe-emit-routes');
      let emissao;
      try { emissao = await emitirNFe(db, faturaId); }
      catch (e) { return res.status(500).json({ success: false, error: 'Falha na emissão: ' + e.message, faturaId }); }

      const fat = db.prepare('SELECT statusSefaz, chaveAcesso, rejeicaoMotivo FROM faturas WHERE id = ?').get(faturaId);

      // Efeitos colaterais SÓ na autorização (opção a do financeiro): saída de estoque dos
      // itens devolvidos + abate da conta a pagar da entrada. Best-effort: a NF-e já está
      // autorizada; se um efeito falhar, loga e reporta, mas não derruba a resposta.
      let efeitos = null;
      if (fat.statusSefaz === 'autorizada') {
        try {
          efeitos = db.transaction(() => ({
            estoque: darSaidaEstoque(db, faturaId, tags),
            financeiro: abaterContaPagar(db, nfeId, Number(totais.vNF), faturaId),
          }))();
        } catch (e) { console.error(`[devolucao-compra] efeitos fatura ${faturaId}:`, e.message); efeitos = { erro: e.message }; }
      }

      res.json({
        success: fat.statusSefaz === 'autorizada',
        faturaId, numero, statusSefaz: fat.statusSefaz,
        chaveAcesso: fat.chaveAcesso, motivo: fat.rejeicaoMotivo || emissao?.xMotivo,
        cStat: emissao?.cStat, valorTotal: totais.vNF, efeitos,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

// Destinatário da devolução. Desde a unificação (2026-08-20) o fornecedor da
// entrada JÁ É uma pessoa — esta função existia só para copiar um cadastro no
// outro, e agora se resume a casar por CNPJ normalizado (a entrada guarda o
// CNPJ com máscara em alguns XMLs) e criar quando a nota veio sem fornecedor.
function garantirPessoaFornecedor(db, ent) {
  const cnpj = (ent.emitenteCnpj || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('Entrada sem CNPJ do emitente');
  if (ent.fornecedorId) {
    const p = db.prepare('SELECT id FROM pessoas WHERE id = ?').get(ent.fornecedorId);
    if (p) return p.id;
  }
  const ex = db.prepare(
    `SELECT id FROM pessoas WHERE REPLACE(REPLACE(REPLACE(cpfCnpj,'.',''),'/',''),'-','') = ?`
  ).get(cnpj);
  if (ex) return ex.id;
  return garantirFornecedor(db, {
    cpfCnpj: cnpj,
    razaoSocial: ent.emitenteRazaoSocial || 'FORNECEDOR',
    uf: ent.emitenteUf || null,
    inscricaoEstadual: ent.emitenteIe || null,
  });
}

// Torna faturas.pedidoId NULLABLE (rebuild) — devolução de compra não tem pedido. SQLite não
// tem ALTER COLUMN DROP NOT NULL, então recria a tabela preservando tudo. Idempotente: só roda
// se pedidoId ainda for NOT NULL. Verifica contagem antes/depois; FK OFF só durante o rebuild.
function tornarPedidoIdNulavel(db) {
  const ped = db.prepare('PRAGMA table_info(faturas)').all().find(c => c.name === 'pedidoId');
  if (!ped || ped.notnull === 0) return;
  const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='faturas' AND type='table'").get().sql;
  const novo = createSql
    .replace(/CREATE TABLE faturas\b/, 'CREATE TABLE faturas__new')
    .replace(/pedidoId INTEGER NOT NULL/, 'pedidoId INTEGER');
  if (!novo.includes('faturas__new') || /pedidoId INTEGER NOT NULL/.test(novo)) {
    throw new Error('Rebuild faturas: SQL inesperado — abortado por segurança');
  }
  const idxs = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='faturas' AND type='index' AND sql IS NOT NULL").all().map(r => r.sql);
  const n0 = db.prepare('SELECT COUNT(*) c FROM faturas').get().c;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(novo);
      db.exec('INSERT INTO faturas__new SELECT * FROM faturas');
      const n1 = db.prepare('SELECT COUNT(*) c FROM faturas__new').get().c;
      if (n1 !== n0) throw new Error(`Rebuild faturas: contagem divergente ${n0}→${n1}`);
      db.exec('DROP TABLE faturas');
      db.exec('ALTER TABLE faturas__new RENAME TO faturas');
      for (const s of idxs) { try { db.exec(s); } catch {} }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// CSTs de IPI que levam valor (IPITrib); o resto é IPINT (só CST). Espelha o switch da lib.
const IPI_TRIBUTADO = new Set(['00', '49', '50', '99']);

// ─── Núcleo da Fase 2 (motor espelho) ────────────────────────────────────────
// Dado o espelho dos itens (montarItensEspelho) e as quantidades a devolver (parcial →
// rateio proporcional), devolve POR ITEM os payloads prontos das tags SEFAZ (ICMS CSOSN
// 900 c/ destaque, IPI, PIS, COFINS) + os TOTAIS (ICMSTot) já somados. Função PURA (não
// depende da lib node-sped-nfe) → testável isolada. As alíquotas NÃO são rateadas; bases
// e valores sim. vNF = produtos + IPI + ICMS-ST (contador: IPI/ST entram no total).
//
// quantidades: Map(nfeEntradaItemId → qtd) = seleção EXPLÍCITA (só os itens do mapa entram;
// ausentes ficam de fora). Sem o argumento (null/undefined) = devolução TOTAL (todos cheios).
function calcularImpostoEspelho(itensEspelho, quantidades) {
  const total = !quantidades;               // sem seleção → devolução total
  const q = quantidades || new Map();
  const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
  const itens = [];
  const tot = { vProd: 0, vBC: 0, vICMS: 0, vBCST: 0, vST: 0, vIPI: 0, vPIS: 0, vCOFINS: 0 };

  for (const it of itensEspelho) {
    let qtdDev;
    if (total) qtdDev = it.quantidadeRecebida;
    else if (q.has(it.nfeEntradaItemId)) qtdDev = Number(q.get(it.nfeEntradaItemId));
    else continue;                          // item não selecionado → fora da devolução
    if (!(qtdDev > 0)) continue;
    const rec = Number(it.quantidadeRecebida) || 0;
    const f = rec > 0 ? qtdDev / rec : 0;
    const imp = it.imposto || {};

    const vProd = r2(Number(it.valorTotal) * f);
    const vBCicms = r2((imp.vBCIcms || 0) * f);
    const vICMS = r2((imp.vIcms || 0) * f);
    const vBCST = r2((imp.vBCST || 0) * f);
    const vST = r2((imp.vIcmsST || 0) * f);
    const vBCipi = r2((imp.vBCIpi || 0) * f);
    const vIPI = r2((imp.vIpi || 0) * f);
    const vBCpis = r2((imp.vBCPis || 0) * f);
    const vPIS = r2((imp.vPis || 0) * f);
    const vBCcof = r2((imp.vBCCofins || 0) * f);
    const vCOFINS = r2((imp.vCofins || 0) * f);

    // ICMS: CSOSN 900 (opção A). Blocos ICMS/ST são CONDICIONAIS: só entram quando há valor.
    // Motivo: campos enum (modBC/modBCST) que a lib coage p/ "0.00" quando 0 quebram o XSD; e
    // sem ICMS/ST reproduzir zeros nesses grupos é fiscalmente incorreto (não havia destaque).
    const temICMS = vICMS > 0 || vBCicms > 0;
    const temST = vST > 0 || vBCST > 0;
    const icms = { orig: String(imp.origem || '0'), CSOSN: '900' };
    if (temICMS) {
      icms.modBC = String(imp.modBCIcms || '3');
      icms.vBC = vBCicms.toFixed(2);
      icms.pICMS = Number(imp.pIcms || 0).toFixed(2);
      icms.vICMS = vICMS.toFixed(2);
    }
    if (temST) {
      icms.modBCST = String(imp.modBCST || '4');
      icms.vBCST = vBCST.toFixed(2);
      icms.pICMSST = Number(imp.pIcmsST || 0).toFixed(2);
      icms.vICMSST = vST.toFixed(2);
    }

    // IPI: reproduz no grupo do item. Tributado → IPITrib c/ valor; senão IPINT só CST.
    let ipi = null;
    if (imp.cstIpi) {
      ipi = IPI_TRIBUTADO.has(String(imp.cstIpi))
        ? { cEnq: String(imp.cEnqIpi || '999'), CST: String(imp.cstIpi), vBC: vBCipi.toFixed(2), pIPI: Number(imp.pIpi || 0).toFixed(4), vIPI: vIPI.toFixed(2) }
        : { cEnq: String(imp.cEnqIpi || '999'), CST: String(imp.cstIpi) };
    }

    const pis = { CST: String(imp.cstPis || '49'), vBC: vBCpis.toFixed(2), pPIS: Number(imp.pPis || 0).toFixed(4), vPIS: vPIS.toFixed(2) };
    const cofins = { CST: String(imp.cstCofins || '49'), vBC: vBCcof.toFixed(2), pCOFINS: Number(imp.pCofins || 0).toFixed(4), vCOFINS: vCOFINS.toFixed(2) };

    itens.push({
      nfeEntradaItemId: it.nfeEntradaItemId, produtoId: it.produtoId, descricao: it.descricao,
      ncm: it.ncm, unidade: it.unidade, cfop: it.cfopDevolucao,
      quantidade: qtdDev, valorUnitario: it.valorUnitario, vProd, icms, ipi, pis, cofins,
    });
    tot.vProd = r2(tot.vProd + vProd); tot.vBC = r2(tot.vBC + vBCicms); tot.vICMS = r2(tot.vICMS + vICMS);
    tot.vBCST = r2(tot.vBCST + vBCST); tot.vST = r2(tot.vST + vST); tot.vIPI = r2(tot.vIPI + vIPI);
    tot.vPIS = r2(tot.vPIS + vPIS); tot.vCOFINS = r2(tot.vCOFINS + vCOFINS);
  }

  const vNF = r2(tot.vProd + tot.vIPI + tot.vST);
  const totais = {
    vBC: tot.vBC.toFixed(2), vICMS: tot.vICMS.toFixed(2), vBCST: tot.vBCST.toFixed(2), vST: tot.vST.toFixed(2),
    vProd: tot.vProd.toFixed(2), vFrete: '0.00', vSeg: '0.00', vDesc: '0.00', vII: '0.00',
    vIPI: tot.vIPI.toFixed(2), vPIS: tot.vPIS.toFixed(2), vCOFINS: tot.vCOFINS.toFixed(2),
    vOutro: '0.00', vNF: vNF.toFixed(2),
  };
  return { itens, totais };
}

// Saída de estoque dos itens devolvidos (custo médio inalterado — saída sai ao custo atual).
function darSaidaEstoque(db, faturaId, itensFatura) {
  let depositoId = null;
  try { depositoId = require('./estoque-routes').getDepositoPadraoId(db); } catch {}
  const hoje = new Date().toISOString().slice(0, 10);
  const movs = [];
  for (const it of itensFatura) {
    if (!it.produtoId) continue;
    const prod = db.prepare('SELECT precoCusto FROM produtos WHERE id = ?').get(it.produtoId);
    const custo = Number(prod?.precoCusto) || 0;
    const r = db.prepare(`INSERT INTO movimentacoes_estoque
      (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, depositoId)
      VALUES (?, 'saida', ?, ?, 'devolucao_compra', ?, ?, ?, ?)`).run(
      it.produtoId, Number(it.quantidade), custo, faturaId,
      `Devolução de compra (fatura ${faturaId})`, hoje, depositoId);
    movs.push({ produtoId: it.produtoId, movimentacaoId: r.lastInsertRowid, quantidade: it.quantidade });
  }
  return movs;
}

// Abate a(s) conta(s) a pagar em aberto da entrada (opção a). Reduz o `valor` pela devolução;
// zera + cancela quando quita; nota em `observacoes`. Excedente (devolução > aberto) é reportado.
function abaterContaPagar(db, nfeEntradaId, valorDevol, faturaId) {
  const abertas = db.prepare(
    `SELECT id, valor, COALESCE(valorPago,0) vp FROM contas_a_pagar
      WHERE nfeEntradaId=? AND status='aberta' ORDER BY id`).all(nfeEntradaId);
  let restante = Number(valorDevol) || 0;
  const abatidos = [];
  for (const c of abertas) {
    if (restante <= 0.005) break;
    const saldo = Number(c.valor) - Number(c.vp);
    if (saldo <= 0) continue;
    const abate = Math.min(saldo, restante);
    const novoValor = Number((Number(c.valor) - abate).toFixed(2));
    const nota = ` [Abatido R$ ${abate.toFixed(2)} — devolução de compra fatura ${faturaId}]`;
    if (novoValor <= 0.005) {
      db.prepare(`UPDATE contas_a_pagar SET valor=0, status='cancelada',
        observacoes=COALESCE(observacoes,'')||?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`).run(nota, c.id);
    } else {
      db.prepare(`UPDATE contas_a_pagar SET valor=?,
        observacoes=COALESCE(observacoes,'')||?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=?`).run(novoValor, nota, c.id);
    }
    abatidos.push({ contaId: c.id, abate: Number(abate.toFixed(2)) });
    restante -= abate;
  }
  return { abatidos, naoAbatido: Number(restante.toFixed(2)) };
}

module.exports = {
  registrar,
  migrarSchema,
  cfopDevolucao,
  parseEspelhoEntrada,
  parseImpostoItem,
  montarItensEspelho,
  calcularImpostoEspelho,
  garantirPessoaFornecedor,
  tornarPedidoIdNulavel,
  darSaidaEstoque,
  abaterContaPagar,
  // helpers expostos p/ teste
  _internal: { tag, tagAll, num },
};
