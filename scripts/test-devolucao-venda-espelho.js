/**
 * Devolução de venda como espelho da NF-e de saída (devolucao-venda.js).
 *
 * A devolução de venda existia só como RMA + emissão que RECALCULAVA imposto; agora ela
 * parte da nota, reproduz o que foi destacado e controla saldo por linha do documento.
 * Estes testes travam o que sustenta isso: o casamento item↔XML, o de/para de CFOP, o
 * saldo que enxerga RMA manual e devolução espelho na mesma conta, e as recusas que
 * impedem a nota de sair errada.
 *
 * Banco descartável a partir do schema real do tenant (só leitura da origem). A emissão
 * SEFAZ é substituída por um stub — o que se testa aqui é o que acontece ANTES dela.
 *
 * Uso: node scripts/test-devolucao-venda-espelho.js
 *   (precisa de /tmp/vp-devvenda-schema.sql: sqlite3 data/tenants/<t>/pncp.db .schema > ele)
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

process.chdir(path.join(__dirname, '..'));

const DB = '/tmp/vp-dev-venda.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
// sqlite_sequence é criada pelo próprio SQLite — vem no dump e não pode ser recriada.
db.exec(fs.readFileSync('/tmp/vp-devvenda-schema.sql', 'utf8')
  .split('\n').filter(l => !/sqlite_sequence/.test(l)).join('\n'));

// Fila em vez de execução imediata: metade dos testes é async (chamam handlers de rota) e
// precisam rodar em ordem — o saldo de um é o estado inicial do seguinte.
let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
async function rodar() {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (String(a) !== String(b)) throw new Error(`${m}: esperado ${b}, veio ${a}`); };

// ==================== CENÁRIO ====================
// Venda autorizada de 2 itens (10 parafusos + 4 caixas de arruela), com desconto no item 1.

const XML_VENDA = `<nfeProc><NFe><infNFe>
<det nItem="1"><prod>
  <cProd>PAR-001</cProd><xProd>PARAFUSO SEXTAVADO</xProd><NCM>73181500</NCM><CFOP>5102</CFOP>
  <uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>25.0000</vUnCom><vProd>250.00</vProd><vDesc>25.00</vDesc>
</prod><imposto>
  <ICMS><ICMSSN101><orig>0</orig><CSOSN>101</CSOSN></ICMSSN101></ICMS>
  <PIS><PISAliq><CST>01</CST><vBC>250.00</vBC><pPIS>1.6500</pPIS><vPIS>4.13</vPIS></PISAliq></PIS>
  <COFINS><COFINSAliq><CST>01</CST><vBC>250.00</vBC><pCOFINS>7.6000</pCOFINS><vCOFINS>19.00</vCOFINS></COFINSAliq></COFINS>
</imposto></det>
<det nItem="2"><prod>
  <cProd>ARR-002</cProd><xProd>ARRUELA LISA</xProd><NCM>73182100</NCM><CFOP>5403</CFOP>
  <uCom>CX</uCom><qCom>4.0000</qCom><vUnCom>100.0000</vUnCom><vProd>400.00</vProd>
</prod><imposto>
  <ICMS><ICMS10><orig>0</orig><CST>10</CST><modBC>3</modBC><vBC>400.00</vBC><pICMS>18.00</pICMS><vICMS>72.00</vICMS>
    <modBCST>4</modBCST><vBCST>520.00</vBCST><pICMSST>18.00</pICMSST><vICMSST>21.60</vICMSST></ICMS10></ICMS>
  <PIS><PISNT><CST>07</CST></PISNT></PIS><COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>
</imposto></det>
</infNFe></NFe></nfeProc>`;

function seed() {
  db.prepare(`INSERT INTO fornecedor (id, razaoSocial, cnpj, uf, regimeTributario)
              VALUES (1, 'EMITENTE TESTE', '11222333000181', 'PA', 'SIMPLES_NACIONAL')`).run();
  db.prepare(`INSERT INTO pessoas (id, razaoSocial, cpfCnpj, uf, cidade, inscricaoEstadual)
              VALUES (1, 'CLIENTE CONSUMIDOR', '52998224725', 'PA', 'Redenção', NULL)`).run();
  db.prepare(`INSERT INTO pessoas (id, razaoSocial, cpfCnpj, uf, cidade, inscricaoEstadual)
              VALUES (2, 'CLIENTE CONTRIBUINTE LTDA', '11444777000161', 'SP', 'São Paulo', '123456789')`).run();
  for (const [id, sku, desc] of [[10, 'PAR-001', 'PARAFUSO SEXTAVADO'], [20, 'ARR-002', 'ARRUELA LISA']]) {
    db.prepare(`INSERT INTO produtos (id, sku, descricao, unidade, precoCusto, precoVenda)
                VALUES (?, ?, ?, 'UN', 10, 25)`).run(id, sku, desc);
  }
  // De/para de CFOP (o seed real vem de cfops-routes.js)
  for (const [cod, contra, dest] of [['1202', '5102', 'interno'], ['2202', '6102', 'interestadual'], ['1411', '5403', 'interno']]) {
    db.prepare(`INSERT INTO cfops (codigo, descricao, tipoOperacao, destino, categoriaOperacao, cfopContrapartida, finalidadeNFe)
                VALUES (?, 'Devolução de venda', 'entrada', ?, 'devolucao_venda', ?, 4)`).run(cod, dest, contra);
  }
  db.prepare(`INSERT INTO tipos_operacao (id, codigo, descricao, categoriaOperacao, finalidadeNFe,
              geraFinanceiro, movimentaEstoque, emiteNFe)
              VALUES (1, 'DEV-DEFEITO', 'Devolução de venda — defeito', 'devolucao_venda', 4, 1, 1, 1)`).run();

  // Pedido entregue + nota autorizada em cima dele.
  db.prepare(`INSERT INTO pedidos (id, numero, clienteId, status, valorTotal, dataPedido)
              VALUES (1, 'PED-001', 1, 'entregue', 650, '2026-08-01')`).run();
  db.prepare(`INSERT INTO pedido_itens (id, pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
              VALUES (1, 1, 10, 'PARAFUSO SEXTAVADO', 10, 25, 250)`).run();
  db.prepare(`INSERT INTO pedido_itens (id, pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
              VALUES (2, 1, 20, 'ARRUELA LISA', 4, 100, 400)`).run();

  db.prepare(`INSERT INTO faturas (id, numero, pedidoId, clienteId, dataEmissao, dataVencimento,
                valorBruto, valorTotal, valorDesconto, status, statusSefaz, chaveAcesso, numeroNFe,
                serieNFe, xmlAssinado)
              VALUES (1, 'FAT-001', 1, 1, '2026-08-02', '2026-08-02', 650, 625, 25, 'emitida',
                'autorizada', '15260819884430001234550010000004111000004118', '411', '1', ?)`).run(XML_VENDA);
  db.prepare(`INSERT INTO fatura_itens (id, faturaId, produtoId, sku, descricao, unidade, quantidade,
                precoUnitario, valorTotal, ncm, cfop)
              VALUES (1, 1, 10, 'PAR-001', 'PARAFUSO SEXTAVADO', 'UN', 10, 25, 250, '73181500', '5102')`).run();
  db.prepare(`INSERT INTO fatura_itens (id, faturaId, produtoId, sku, descricao, unidade, quantidade,
                precoUnitario, valorTotal, ncm, cfop)
              VALUES (2, 1, 20, 'ARR-002', 'ARRUELA LISA', 'CX', 4, 100, 400, '73182100', '5403')`).run();

  // Nota sem XML (emitida por outro caminho) e nota não autorizada, para as recusas.
  db.prepare(`INSERT INTO faturas (id, numero, pedidoId, clienteId, dataEmissao, dataVencimento,
                valorBruto, valorTotal, status, statusSefaz)
              VALUES (2, 'FAT-002', 1, 2, '2026-08-03', '2026-08-03', 100, 100, 'emitida', 'rejeitada')`).run();
  db.prepare(`INSERT INTO fatura_itens (id, faturaId, produtoId, sku, descricao, quantidade, precoUnitario, valorTotal, cfop)
              VALUES (3, 2, 10, 'PAR-001', 'PARAFUSO SEXTAVADO', 1, 100, 100, '5102')`).run();

  // Estoque inicial para o retorno ter contra o que somar.
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, data)
              VALUES (10, 'entrada', 100, 10, 'ajuste', '2026-07-01')`).run();
  db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, data)
              VALUES (20, 'entrada', 50, 40, 'ajuste', '2026-07-01')`).run();
}
seed();

const dv = require('../devolucao-venda');
dv.migrarSchema(db);

// ==================== ESPELHO ====================

t('itens da nota casam com os <det> do XML', () => {
  const { fatura, itens } = dv.montarItensEspelhoVenda(db, 1);
  eq(fatura.numero, 'FAT-001', 'nota');
  eq(itens.length, 2, 'itens');
  eq(itens[0].descricao, 'PARAFUSO SEXTAVADO', 'item 1');
  eq(itens[0].quantidadeOrigem, 10, 'quantidade da origem');
  eq(itens[0].valorDesconto, 25, 'desconto veio do XML');
  eq(itens[1].imposto.vIcmsST, 21.6, 'ST do item 2 veio do XML');
  assert(!itens[0].semXml, 'item 1 deveria ter casado com o XML');
});

t('CFOP de saída vira CFOP de devolução pelo de/para da tabela cfops', () => {
  const { itens } = dv.montarItensEspelhoVenda(db, 1);
  eq(itens[0].cfopSaida, '5102', 'CFOP de saída item 1');
  eq(itens[0].cfopDevolucao, '1202', 'CFOP de devolução item 1');
  assert(itens[0].cfopDevolucaoDoMapa, 'item 1 deveria vir do mapa');
  eq(itens[1].cfopDevolucao, '1411', 'CFOP de devolução item 2 (ST)');
});

t('nota sem XML não quebra o preview — marca os itens', () => {
  const { itens } = dv.montarItensEspelhoVenda(db, 2);
  assert(itens[0].semXml, 'item sem XML deveria ser sinalizado');
  eq(itens[0].quantidadeOrigem, 1, 'cai para a quantidade da fatura');
  eq(itens[0].cfopDevolucao, '1202', 'CFOP vem do cfop gravado na fatura');
});

t('saldo começa cheio', () => {
  const { fatura, itens } = dv.montarItensEspelhoVenda(db, 1);
  dv.saldoPorItem(db, fatura, itens);
  eq(itens[0].saldoDisponivel, 10, 'saldo item 1');
  eq(itens[1].saldoDisponivel, 4, 'saldo item 2');
});

t('avisos: cliente sem IE não dispara contribuinte; regime Simples passa', () => {
  const { fatura, itens } = dv.montarItensEspelhoVenda(db, 1);
  const a = dv.avisosDe(db, fatura, itens);
  assert(!a.clienteContribuinte, 'consumidor não é contribuinte');
  assert(!a.regimeNaoSimples, 'emitente é Simples');
  eq(a.cfopsForaDoMapa, 0, 'CFOPs mapeados');
  eq(a.itensSemProduto, 0, 'itens com produto');
});

t('avisos: cliente com IE é sinalizado (quem emite a devolução é ele)', () => {
  const { fatura, itens } = dv.montarItensEspelhoVenda(db, 2);
  assert(dv.avisosDe(db, fatura, itens).clienteContribuinte, 'deveria sinalizar contribuinte');
});

// ==================== FLUXO COMPLETO (com emissão stubada) ====================

// A emissão real exige certificado e SEFAZ. O stub deixa passar o que interessa aqui:
// tudo que o handler faz antes — RMA, efetivação, fatura espelho.
require.cache[require.resolve('../nfe-emit-routes')] = {
  id: require.resolve('../nfe-emit-routes'),
  filename: require.resolve('../nfe-emit-routes'),
  loaded: true,
  exports: {
    emitirNFe: async (dbArg, faturaId) => {
      dbArg.prepare(`UPDATE faturas SET statusSefaz='autorizada', chaveAcesso='99999999999999999999999999999999999999999999' WHERE id=?`).run(faturaId);
      return { cStat: '100', xMotivo: 'Autorizado o uso da NF-e' };
    },
  },
};

// Mini-app: registra as rotas e chama os handlers direto, sem subir servidor.
const rotas = { get: new Map(), post: new Map() };
const appFalso = {
  get: (p, h) => rotas.get.set(p, h),
  post: (p, h) => rotas.post.set(p, h),
};
dv.registrar(appFalso, db);

function chamar(metodo, rota, { params = {}, body = {} } = {}) {
  const handler = rotas[metodo].get(rota);
  if (!handler) throw new Error('rota não registrada: ' + rota);
  let statusCode = 200, payload = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(p) { payload = p; return this; },
  };
  const r = handler({ params, body, user: { username: 'teste' } }, res);
  return Promise.resolve(r).then(() => ({ status: statusCode, body: payload }));
}

let resultado;

t('preview responde com nota, itens e avisos', async () => {
  const r = await chamar('get', '/api/faturas/:id/devolucao/preview', { params: { id: '1' } });
  eq(r.status, 200, 'status');
  assert(r.body.success, 'success');
  eq(r.body.itens.length, 2, 'itens');
  eq(r.body.nota.numero, 'FAT-001', 'nota');
  eq(r.body.natOp, 'Devolução de venda', 'natureza');
});

t('recusa nota não autorizada', async () => {
  const r = await chamar('post', '/api/faturas/:id/devolucao', { params: { id: '2' }, body: { total: true } });
  eq(r.status, 400, 'status');
  assert(/autorizada/i.test(r.body.error), 'motivo: ' + r.body.error);
});

t('recusa quantidade acima do saldo', async () => {
  const r = await chamar('post', '/api/faturas/:id/devolucao', {
    params: { id: '1' }, body: { itens: [{ faturaItemOrigemId: 1, quantidade: 999 }] },
  });
  eq(r.status, 400, 'status');
  assert(/saldo/i.test(r.body.error), 'motivo: ' + r.body.error);
});

t('devolução parcial: cria RMA efetivado + fatura espelho e emite', async () => {
  const r = await chamar('post', '/api/faturas/:id/devolucao', {
    params: { id: '1' },
    body: { itens: [{ faturaItemOrigemId: 1, quantidade: 4 }], motivo: 'peça errada' },
  });
  assert(r.body.success, 'falhou: ' + JSON.stringify(r.body));
  resultado = r.body;
  const dev = db.prepare('SELECT * FROM devolucoes WHERE id = ?').get(r.body.devolucaoId);
  eq(dev.status, 'efetivada', 'RMA efetivado');
  eq(dev.faturaOrigemId, 1, 'RMA aponta para a nota');
  eq(dev.valorTotal, 100, 'valor do RMA (4 × 25)');
  const fat = db.prepare('SELECT * FROM faturas WHERE id = ?').get(r.body.faturaId);
  eq(fat.tipoDevolucao, 'venda', 'tipo da fatura espelho');
  eq(fat.faturaOrigemId, 1, 'fatura espelho aponta para a origem');
  eq(fat.isDevolucao, 1, 'marcada como devolução');
  eq(fat.refNFeOriginal, '15260819884430001234550010000004111000004118', 'refNFe da venda');
  eq(fat.devolucaoId, dev.id, 'fatura ligada ao RMA');
});

t('a fatura espelho leva CFOP de devolução, desconto rateado e vínculo com a linha de origem', () => {
  const itens = db.prepare('SELECT * FROM fatura_itens WHERE faturaId = ? ORDER BY id').all(resultado.faturaId);
  eq(itens.length, 1, 'só o item devolvido');
  eq(itens[0].cfop, '1202', 'CFOP de devolução');
  eq(itens[0].quantidade, 4, 'quantidade devolvida');
  eq(itens[0].valorTotal, 100, 'vProd rateado (4 de 10 × 250)');
  eq(itens[0].valorDesconto, 10, 'desconto rateado (4 de 10 × 25)');
  eq(itens[0].faturaItemOrigemId, 1, 'aponta para a linha da venda');
});

t('o retorno entrou no estoque pelo pipeline do RMA', () => {
  const mov = db.prepare(`SELECT * FROM movimentacoes_estoque WHERE origem='devolucao' AND produtoId=10`).get();
  assert(mov, 'movimentação de entrada não foi criada');
  eq(mov.tipo, 'entrada', 'tipo');
  eq(mov.quantidade, 4, 'quantidade');
  eq(mov.custoUnitario, 10, 'custo da saída original, não o preço de venda');
});

t('crédito ao cliente foi criado como CR negativo', () => {
  const cr = db.prepare(`SELECT * FROM contas_a_receber WHERE origem='devolucao'`).get();
  assert(cr, 'CR não criado');
  eq(cr.valor, -100, 'valor negativo');
});

t('o saldo da linha cai depois da devolução', () => {
  const { fatura, itens } = dv.montarItensEspelhoVenda(db, 1);
  dv.saldoPorItem(db, fatura, itens);
  eq(itens[0].saldoDisponivel, 6, 'saldo restante do item 1');
  eq(itens[1].saldoDisponivel, 4, 'item 2 intocado');
});

t('devolver o restante é permitido; passar disso não', async () => {
  const excede = await chamar('post', '/api/faturas/:id/devolucao', {
    params: { id: '1' }, body: { itens: [{ faturaItemOrigemId: 1, quantidade: 7 }] },
  });
  eq(excede.status, 400, 'deveria recusar 7 com saldo 6');
  const ok2 = await chamar('post', '/api/faturas/:id/devolucao', {
    params: { id: '1' }, body: { itens: [{ faturaItemOrigemId: 1, quantidade: 6 }] },
  });
  assert(ok2.body.success, 'devolver o saldo restante falhou: ' + JSON.stringify(ok2.body));
  const { fatura, itens } = dv.montarItensEspelhoVenda(db, 1);
  dv.saldoPorItem(db, fatura, itens);
  eq(itens[0].saldoDisponivel, 0, 'linha zerada');
});

t('numeração da devolução espelho é sequencial por nota', () => {
  const nums = db.prepare(`SELECT numero FROM faturas WHERE tipoDevolucao='venda' ORDER BY id`).all().map(r => r.numero);
  eq(nums[0], 'DEVV-411/1', 'primeira');
  eq(nums[1], 'DEVV-411/2', 'segunda');
});

t('RMA aberto à mão consome o mesmo saldo (não devolve duas vezes)', () => {
  const { criarDevolucao } = require('../devolucoes-routes');
  // Item 2 ainda tem 4; um RMA manual de 3 pelo pedido tem de derrubar o saldo da nota.
  criarDevolucao(db, { user: { username: 'teste' } }, {
    pedidoId: 1, clienteId: 1,
    itens: [{ produtoId: 20, pedidoItemId: 2, descricao: 'ARRUELA LISA', quantidade: 3, valorUnitario: 100 }],
  });
  const { fatura, itens } = dv.montarItensEspelhoVenda(db, 1);
  dv.saldoPorItem(db, fatura, itens);
  eq(itens[1].saldoDisponivel, 1, 'saldo do item 2 após RMA manual');
});

rodar();
