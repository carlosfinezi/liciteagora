#!/usr/bin/env node
/**
 * test-nf-avulsa.js — ciclo da NF manual: rascunho → prévia → emissão.
 *
 * Sobe um Express só com as rotas da NF avulsa, apontado para o tenant de
 * laboratório `labfiscal`, numa porta alta. Não encosta na porta de produção.
 *
 * A emissão de verdade (assinar + SEFAZ) não roda aqui: o lab não tem certificado.
 * O que se prova é tudo que vem ANTES e AO REDOR dela — validações, promoção de
 * status, contas a receber, estoque, prévia de tributação, memória de cálculo —
 * e que a falha na transmissão não deixa o documento em estado inconsistente.
 *
 * Uso: node scripts/test-nf-avulsa.js
 */
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const express = require(BASE + '/node_modules/express');
const Database = require(BASE + '/node_modules/better-sqlite3');
const { registrarRotasNfAvulsa } = require(BASE + '/nf-avulsa-routes');

const PORTA = 34117;
const DB_PATH = BASE + '/data/tenants/labfiscal/pncp.db';
const db = new Database(DB_PATH);

let ok = 0, fail = 0;
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.error(`  ✗ ${msg}${extra ? '\n      ' + extra : ''}`); }
}
function secao(t) { console.log(`\n── ${t}`); }

// ─── Massa de teste no lab ───────────────────────────────────────────────────
function prepararMassa() {
  // Ordem importa: contas_a_receber e fatura_itens têm FK para faturas.
  db.exec(`
    DELETE FROM contas_a_receber WHERE faturaId IN (SELECT id FROM faturas WHERE origemDocumento = 'avulsa');
    DELETE FROM fiscal_calculo_memoria WHERE documento = 'fatura'
       AND documentoId IN (SELECT id FROM faturas WHERE origemDocumento = 'avulsa');
    DELETE FROM fatura_itens WHERE faturaId IN (SELECT id FROM faturas WHERE origemDocumento = 'avulsa');
    DELETE FROM faturas WHERE origemDocumento = 'avulsa';
    DELETE FROM fiscal_regras_trib;
    DELETE FROM movimentacoes_estoque WHERE origem = 'nf_avulsa';
  `);

  const temForn = db.prepare('SELECT COUNT(*) c FROM fornecedor WHERE id = 1').get().c;
  if (!temForn) db.prepare("INSERT INTO fornecedor (id, razaoSocial) VALUES (1, 'Lab Fiscal')").run();
  db.prepare("UPDATE fornecedor SET regimeTributario = 'NAO_OPTANTE', uf = 'TO' WHERE id = 1").run();

  db.prepare(`INSERT INTO fiscal_regras_trib
      (descricao, prioridade, ativo, regimeEmitente, ncmPrefixo, cstIcms, modBC, pIcms, pRedBC,
       cstPis, pPis, cstCofins, pCofins)
    VALUES ('Fertilizante 3105 c/ reducao', 10, 1, 3, '3105', '20', 3, 12, 78.95, '01', 1.65, '01', 7.6)`).run();

  let cli = db.prepare("SELECT id FROM pessoas WHERE cpfCnpj = '11444777000161'").get();
  if (!cli) {
    const r = db.prepare(`INSERT INTO pessoas (razaoSocial, cpfCnpj, tipo, uf, cidade, endereco, numero, bairro, cep, codigoMunicipio)
      VALUES ('CLIENTE LAB LTDA', '11444777000161', 'juridica', 'TO', 'PALMAS', 'AV TESTE', '100', 'CENTRO', '77000000', '1721000')`).run();
    cli = { id: r.lastInsertRowid };
  }

  let prod = db.prepare("SELECT id FROM produtos WHERE sku = 'LAB-FERT-01'").get();
  if (!prod) {
    const r = db.prepare(`INSERT INTO produtos (sku, descricao, ncm, unidade, precoVenda, origem)
      VALUES ('LAB-FERT-01', 'FERTILIZANTE LAB 10L', '31051000', 'UN', 100, '0')`).run();
    prod = { id: r.lastInsertRowid };
  }
  // Saldo inicial para poder observar a baixa
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, origem, origemId, observacao, data)
    VALUES (?, 'entrada', 100, 'ajuste', 0, 'saldo inicial do teste', date('now'))`).run(prod.id);

  const tipoVenda = db.prepare(`SELECT id, codigo FROM tipos_operacao WHERE codigo = 'VDA-NORMAL'`).get();
  const tipoBonif = db.prepare(`SELECT id, codigo FROM tipos_operacao
     WHERE categoriaOperacao = 'bonificacao' OR codigo LIKE 'BON%' LIMIT 1`).get();
  const tipoNaoFiscal = db.prepare(`SELECT id, codigo FROM tipos_operacao WHERE emiteNFe = 0 LIMIT 1`).get();
  return { clienteId: cli.id, produtoId: prod.id, tipoVenda, tipoBonif, tipoNaoFiscal };
}

const M = prepararMassa();

// ─── Servidor isolado ────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, username: 'admin', role: 'admin' }; next(); });
registrarRotasNfAvulsa(app, db);
const server = app.listen(PORTA);

const API = (p) => `http://127.0.0.1:${PORTA}${p}`;
async function post(p, body) {
  const r = await fetch(API(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json() };
}
async function put(p, body) {
  const r = await fetch(API(p), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json() };
}
async function get(p) {
  const r = await fetch(API(p));
  return { status: r.status, json: await r.json() };
}

const itemFert = (qtd = 2, preco = 50) => ({
  produtoId: M.produtoId, sku: 'LAB-FERT-01', descricao: 'FERTILIZANTE LAB 10L',
  unidade: 'UN', quantidade: qtd, precoUnitario: preco, ncm: '31051000', cfop: '5102', origem: '0',
  infAdProd: 'LOTE 2508-29116 FABR 13.08.2025 VALID 13.08.2027',
});

(async () => {
  // ─── 1. Rascunho: criar, ler, editar ──────────────────────────────────────
  secao('Rascunho — ciclo de vida');
  const c = await post('/api/nf-avulsa', {
    clienteId: M.clienteId, tipoOperacaoId: M.tipoVenda && M.tipoVenda.id,
    meioPagamento: '15', itens: [itemFert()],
  });
  assert(c.json.success, 'rascunho criado', c.json.error);
  const id = c.json.id;
  assert(/^NFA-\d{5}$/.test(c.json.nota.numero), `numeração própria (${c.json.nota.numero})`);
  assert(c.json.nota.status === 'rascunho', 'nasce como rascunho');
  assert(c.json.nota.pedidoId === null, 'sem pedido vinculado');
  assert(c.json.nota.origemDocumento === 'avulsa', 'marcado como avulsa');
  assert(Number(c.json.nota.valorTotal) === 100, `total 100,00 (veio ${c.json.nota.valorTotal})`);
  assert(c.json.nota.itens[0].infAdProd.includes('LOTE'), 'texto fiscal do item gravado');

  const e = await put(`/api/nf-avulsa/${id}`, {
    clienteId: M.clienteId, tipoOperacaoId: M.tipoVenda && M.tipoVenda.id,
    meioPagamento: '15', valorFrete: 20, itens: [itemFert(3, 50)],
  });
  assert(e.json.success && Number(e.json.nota.valorTotal) === 170, `edição recalcula total: 170,00 (veio ${e.json.nota && e.json.nota.valorTotal})`);
  assert(e.json.nota.itens.length === 1, 'itens substituídos, não duplicados');

  const lista = await get('/api/nf-avulsa?status=rascunho');
  assert(lista.json.success && lista.json.notas.some(n => n.id === id), 'aparece na lista de rascunhos');

  // ─── 2. Rascunho não vaza para os relatórios fiscais ──────────────────────
  secao('Isolamento — rascunho não é documento fiscal');
  {
    const emFaturas = db.prepare(`SELECT COUNT(*) c FROM faturas WHERE id = ? AND status = 'emitida'`).get(id).c;
    assert(emFaturas === 0, 'não conta como fatura emitida');
    const cr = db.prepare('SELECT COUNT(*) c FROM contas_a_receber WHERE faturaId = ?').get(id).c;
    assert(cr === 0, 'não gerou contas a receber');
    const mov = db.prepare(`SELECT COUNT(*) c FROM movimentacoes_estoque WHERE origem = 'nf_avulsa' AND origemId = ?`).get(id).c;
    assert(mov === 0, 'não movimentou estoque');
    const comChave = db.prepare('SELECT COUNT(*) c FROM faturas WHERE id = ? AND chaveAcesso IS NOT NULL').get(id).c;
    assert(comChave === 0, 'sem chave de acesso — invisível para DRE/apuração/arquivamento');
  }

  // ─── 3. Prévia de tributação (aba Impostos, antes de emitir) ──────────────
  secao('Prévia de tributação');
  {
    const p = await post(`/api/nf-avulsa/${id}/previa-tributacao`);
    assert(p.json.success && p.json.crt === 3, `CRT 3 lido do cadastro (veio ${p.json.crt})`);
    const i0 = p.json.itens[0];
    assert(i0.ok, 'item calculado', i0.erro);
    assert(i0.grupo === 'ICMS' && i0.icms.CST === '20', `CST 20 (veio ${i0.icms && i0.icms.CST})`);
    // 150,00 × (1 − 78,95%) = 31,58 ; × 12% = 3,79
    assert(i0.icms.vBC === '31.58', `base reduzida 31,58 (veio ${i0.icms.vBC})`);
    assert(i0.icms.vICMS === '3.79', `ICMS 3,79 (veio ${i0.icms.vICMS})`);
    assert(i0.memoria.some(m => /REDUCAOBASE/.test(m.formula || '')), 'memória mostra a fórmula');
  }

  // ─── 4. Validações antes de mandar para a SEFAZ ───────────────────────────
  secao('Validação na emissão');
  {
    const semCfop = await post('/api/nf-avulsa', {
      clienteId: M.clienteId, tipoOperacaoId: M.tipoVenda && M.tipoVenda.id, meioPagamento: '15',
      itens: [{ ...itemFert(), cfop: null }],
    });
    const r = await post(`/api/nf-avulsa/${semCfop.json.id}/emitir`);
    assert(r.status === 400 && /CFOP/.test(r.json.error), 'recusa item sem CFOP antes de transmitir', r.json.error);
    const st = db.prepare('SELECT status FROM faturas WHERE id = ?').get(semCfop.json.id).status;
    assert(st === 'rascunho', 'recusa NÃO promove o rascunho');
    await post(`/api/nf-avulsa/${semCfop.json.id}/excluir`);
  }
  if (M.tipoNaoFiscal) {
    const naoFiscal = await post('/api/nf-avulsa', {
      clienteId: M.clienteId, tipoOperacaoId: M.tipoNaoFiscal.id, meioPagamento: '15', itens: [itemFert()],
    });
    const r = await post(`/api/nf-avulsa/${naoFiscal.json.id}/emitir`);
    assert(r.status === 400 && /não emite NF-e/.test(r.json.error),
      `tipo de operação não-fiscal (${M.tipoNaoFiscal.codigo}) é recusado`, r.json.error);
    await post(`/api/nf-avulsa/${naoFiscal.json.id}/excluir`);
  }
  {
    const semMeio = await post('/api/nf-avulsa', {
      clienteId: M.clienteId, tipoOperacaoId: M.tipoVenda && M.tipoVenda.id, itens: [itemFert()],
    });
    const r = await post(`/api/nf-avulsa/${semMeio.json.id}/emitir`);
    assert(r.status === 400 && /Meio de pagamento/.test(r.json.error),
      'venda sem meio de pagamento é recusada (o XML exigiria detPag)', r.json.error);
    await post(`/api/nf-avulsa/${semMeio.json.id}/excluir`);
  }

  // ─── 5. Emissão: efeitos colaterais acontecem ─────────────────────────────
  secao('Emissão — financeiro e estoque');
  {
    const saldoAntes = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END), 0) s
        FROM movimentacoes_estoque WHERE produtoId = ?`).get(M.produtoId).s;

    // Sem certificado no lab, a transmissão falha — é o esperado. O que interessa
    // é o estado do documento e os efeitos, que rodam ANTES da transmissão.
    const r = await post(`/api/nf-avulsa/${id}/emitir`);
    assert(!r.json.success, 'transmissão falha no lab (sem certificado) — esperado');

    const f = db.prepare('SELECT status FROM faturas WHERE id = ?').get(id);
    assert(f.status === 'emitida', 'documento foi promovido de rascunho para emitida');

    const crs = db.prepare('SELECT * FROM contas_a_receber WHERE faturaId = ?').all(id);
    assert(crs.length === 1, `1 conta a receber criada (veio ${crs.length})`);
    assert(crs.length && Number(crs[0].valor) === 170, `CR de 170,00 (veio ${crs.length && crs[0].valor})`);

    const movs = db.prepare(`SELECT * FROM movimentacoes_estoque WHERE origem = 'nf_avulsa' AND origemId = ?`).all(id);
    assert(movs.length === 1 && movs[0].tipo === 'saida', 'saída de estoque registrada');
    assert(movs.length && Number(movs[0].quantidade) === 3, `baixou 3 unidades (veio ${movs.length && movs[0].quantidade}`);

    const saldoDepois = db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade ELSE -quantidade END), 0) s
        FROM movimentacoes_estoque WHERE produtoId = ?`).get(M.produtoId).s;
    assert(saldoDepois === saldoAntes - 3, `saldo caiu 3 (${saldoAntes} → ${saldoDepois})`);

    const r2 = await post(`/api/nf-avulsa/${id}/emitir`);
    assert(r2.status === 400 && /já está/.test(r2.json.error), 'não deixa emitir duas vezes', r2.json.error);
  }

  // ─── 5b. Rascunho antigo emitido hoje vira nota de hoje ───────────────────
  secao('Data de emissão — não existe nota retroativa');
  {
    const antigo = await post('/api/nf-avulsa', {
      clienteId: M.clienteId, tipoOperacaoId: M.tipoVenda && M.tipoVenda.id,
      meioPagamento: '15', dataEmissao: '2026-01-15', itens: [itemFert(1, 50)],
    });
    const noRascunho = db.prepare('SELECT dataEmissao FROM faturas WHERE id = ?').get(antigo.json.id);
    assert(noRascunho.dataEmissao === '2026-01-15', 'rascunho guarda a data que foi informada');

    await post(`/api/nf-avulsa/${antigo.json.id}/emitir`);
    const emitida = db.prepare('SELECT dataEmissao, status FROM faturas WHERE id = ?').get(antigo.json.id);
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    assert(emitida.dataEmissao === hoje,
      `ao emitir, a data passa a ser a de hoje (${emitida.dataEmissao}) — o dhEmi do XML é sempre agora`);
    assert(emitida.status === 'emitida', 'e o documento foi promovido');
  }

  // ─── 6. Bonificação: sem financeiro ───────────────────────────────────────
  if (M.tipoBonif) {
    secao(`Bonificação (${M.tipoBonif.codigo}) — não gera financeiro`);
    const b = await post('/api/nf-avulsa', {
      clienteId: M.clienteId, tipoOperacaoId: M.tipoBonif.id, itens: [itemFert(1, 50)],
    });
    const r = await post(`/api/nf-avulsa/${b.json.id}/emitir`);
    assert(!/Meio de pagamento/.test(String(r.json.error)), 'não exige meio de pagamento');
    const cr = db.prepare('SELECT COUNT(*) c FROM contas_a_receber WHERE faturaId = ?').get(b.json.id).c;
    assert(cr === 0, 'nenhuma conta a receber criada');
  }

  // ─── 7. Descarte de rascunho ──────────────────────────────────────────────
  secao('Descarte');
  {
    const d = await post('/api/nf-avulsa', { clienteId: M.clienteId, itens: [itemFert(1, 10)] });
    const r = await post(`/api/nf-avulsa/${d.json.id}/excluir`);
    assert(r.json.success, 'rascunho descartado');
    const n = db.prepare('SELECT COUNT(*) c FROM faturas WHERE id = ?').get(d.json.id).c;
    const ni = db.prepare('SELECT COUNT(*) c FROM fatura_itens WHERE faturaId = ?').get(d.json.id).c;
    assert(n === 0 && ni === 0, 'sumiu junto com os itens');
    const r2 = await post(`/api/nf-avulsa/${id}/excluir`);
    assert(r2.status === 400, 'nota já emitida NÃO pode ser descartada por aqui');
  }

  server.close();
  db.close();
  console.log(`\n${'─'.repeat(56)}`);
  console.log(fail === 0 ? `TODOS OS ${ok} ASSERTS PASSARAM` : `${ok} OK · ${fail} FALHARAM`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  console.error('ERRO FATAL:', err);
  try { server.close(); } catch {}
  process.exit(1);
});
