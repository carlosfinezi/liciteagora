/**
 * O montador de payload de NFC-e a partir de pedido do Catálogo Online.
 *
 * Roda contra uma CÓPIA descartável de um tenant real, escreve só nela, e não
 * fala com a SEFAZ nem gera documento. O que está sob prova é a tradução
 * pedido → payload: quem é o destinatário, o que acontece quando o cliente
 * não tem CPF, onde entra o frete, quando a entrega é recusada.
 *
 * Roda da raiz do projeto:  node scripts/test-nfce-payload.js
 */

const path = require('path');
const Database = require('better-sqlite3');
const { copiaDoTenant } = require('./banco-de-teste');
const { payloadDeNFCeDePedido, injetarEntrega, codigoMunicipioDaEntrega } =
  require(path.join(__dirname, '..', 'nfce-payload'));

let falhas = 0;
let total = 0;
function ok(nome, condicao, detalhe) {
  total++;
  if (condicao) console.log(`  ok   ${nome}`);
  else { falhas++; console.log(`  FALHA ${nome}${detalhe ? ' — ' + detalhe : ''}`); }
}
/** Espera que a montagem seja RECUSADA, e que a mensagem diga por quê. */
function recusa(nome, fn, trecho) {
  total++;
  try {
    fn();
    falhas++;
    console.log(`  FALHA ${nome} — não recusou`);
  } catch (e) {
    const msg = e.message || String(e);
    if (msg.includes(trecho)) console.log(`  ok   ${nome}`);
    else { falhas++; console.log(`  FALHA ${nome} — recusou por outro motivo: ${msg}`); }
  }
}

const db = new Database(copiaDoTenant('produtosbomgosto'));

// O emitente real da cópia: é dele que sai o município que a entrega compara.
const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get();
if (!emitente) { console.log('FALHA: tenant de origem sem emitente cadastrado'); process.exit(1); }
console.log(`  (emitente: ${emitente.cidade}/${emitente.uf}, IBGE ${emitente.codigoMunicipio})`);

// ── fábrica de cenários ─────────────────────────────────────────────────────
let seq = 0;
function criarProduto(campos = {}) {
  seq++;
  const c = Object.assign({
    sku: `T${seq}`, descricao: `PRODUTO TESTE ${seq}`, unidade: 'UN',
    ncm: '09109900', codigoBarras: '7891234567895', origem: '0',
    csosn: '102', cstPIS: '49', cstCOFINS: '49', cfopPadrao: '5102',
    precoVenda: 25, ativo: 1,
  }, campos);
  return db.prepare(`INSERT INTO produtos
      (sku, descricao, unidade, ncm, codigoBarras, origem, csosn, cstPIS, cstCOFINS,
       cfopPadrao, precoVenda, ativo)
    VALUES (@sku, @descricao, @unidade, @ncm, @codigoBarras, @origem, @csosn, @cstPIS,
            @cstCOFINS, @cfopPadrao, @precoVenda, @ativo)`).run(c).lastInsertRowid;
}

function criarPessoa(campos = {}) {
  seq++;
  const c = Object.assign({
    cpfCnpj: String(10000000000 + seq), tipo: 'PF', razaoSocial: `CLIENTE ${seq}`,
    telefone: '94999990000', semDocumento: 0,
  }, campos);
  return db.prepare(`INSERT INTO pessoas
      (cpfCnpj, tipo, razaoSocial, telefone, celular, ativo, semDocumento, origem)
    VALUES (@cpfCnpj, @tipo, @razaoSocial, @telefone, @telefone, 1, @semDocumento, 'catalogo')`)
    .run(c).lastInsertRowid;
}

/** Um pedido de catálogo completo. `itens` é [{produtoId, qtd, preco}]. */
function criarPedido(campos, itens) {
  seq++;
  const c = Object.assign({
    numero: `TST-${Date.now()}-${seq}`, tipo: 'catalogo', modoDocumento: 'pedido',
    status: 'entregue', dataPedido: '2026-09-28', meioPagamento: '17',
    tipoAtendimento: 'retirada', valorFrete: 0, descontoAplicado: 0,
    enderecoEntrega: null, numeroEntrega: null, complementoEntrega: null,
    bairroEntrega: null, cidadeEntrega: null, ufEntrega: null, cepEntrega: null,
    codigoMunicipioEntrega: null, clienteId: null, tipoOperacaoId: null,
  }, campos);
  const somaItens = itens.reduce((s, i) => s + i.qtd * i.preco, 0);
  c.valorTotal = Math.round((somaItens + (c.valorFrete || 0) - (c.descontoAplicado || 0)) * 100) / 100;
  if (campos.valorTotal !== undefined) c.valorTotal = campos.valorTotal;
  const id = db.prepare(`INSERT INTO pedidos
      (numero, tipo, modoDocumento, clienteId, status, dataPedido, meioPagamento,
       tipoAtendimento, valorFrete, descontoAplicado, valorTotal, tipoOperacaoId,
       enderecoEntrega, numeroEntrega, complementoEntrega, bairroEntrega,
       cidadeEntrega, ufEntrega, cepEntrega, codigoMunicipioEntrega)
    VALUES (@numero, @tipo, @modoDocumento, @clienteId, @status, @dataPedido, @meioPagamento,
            @tipoAtendimento, @valorFrete, @descontoAplicado, @valorTotal, @tipoOperacaoId,
            @enderecoEntrega, @numeroEntrega, @complementoEntrega, @bairroEntrega,
            @cidadeEntrega, @ufEntrega, @cepEntrega, @codigoMunicipioEntrega)`)
    .run(c).lastInsertRowid;
  const ins = db.prepare(`INSERT INTO pedido_itens
      (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const i of itens) {
    const p = db.prepare('SELECT descricao FROM produtos WHERE id = ?').get(i.produtoId);
    ins.run(id, i.produtoId, i.descricao || p.descricao, i.qtd, i.preco,
      Math.round(i.qtd * i.preco * 100) / 100);
  }
  return id;
}

const montar = (id, ctx) => payloadDeNFCeDePedido(db, id, Object.assign({ emitente }, ctx));

// ── A. retirada, cliente com CPF ────────────────────────────────────────────
{
  const prod = criarProduto({ sku: 'TEMP-1', ncm: '09109900', unidade: 'KG' });
  const pess = criarPessoa({ cpfCnpj: '52998224725', razaoSocial: 'MARIA DE SOUZA' });
  const ped = criarPedido({ clienteId: pess, tipoAtendimento: 'retirada', meioPagamento: '17' },
    [{ produtoId: prod, qtd: 2, preco: 25 }]);
  const { payload } = montar(ped);

  ok('A1 o pedido de origem vai no payload', payload.pedidoId === ped);
  ok('A2 CPF do cliente vira o consumidor', payload.consumidorCpfCnpj === '52998224725');
  ok('A3 o nome do cliente vai junto', payload.consumidorNome === 'MARIA DE SOUZA');
  ok('A4 um item, com a quantidade do pedido', payload.itens.length === 1 && payload.itens[0].quantidade === 2);
  ok('A5 NCM e unidade vieram do PRODUTO, não do pedido_itens',
    payload.itens[0].ncm === '09109900' && payload.itens[0].unidade === 'KG');
  ok('A6 um pagamento, no código SEFAZ do PIX', payload.pagamentos.length === 1 && payload.pagamentos[0].tPag === '17');
  ok('A7 o valor do pagamento é o total', payload.pagamentos[0].valor === 50);
  ok('A8 retirada não gera grupo de entrega', payload.entrega === null);
  ok('A9 retirada não tem frete', payload.frete === null);
  ok('A10 indPres é 2 (venda pela internet)', payload.indPres === '2');
  ok('A11 efeitosJaAplicados vem LIGADO — o pedido já baixou estoque e faturou',
    payload.efeitosJaAplicados === true);
}

// ── B. cliente sem documento (SD-*) ─────────────────────────────────────────
// A regra que mais importa: o identificador interno NUNCA pode virar CPF.
{
  const prod = criarProduto();
  const semdoc = require(path.join(__dirname, '..', 'pessoa-sem-documento'));
  const pess = criarPessoa({
    cpfCnpj: semdoc.gerarIdentificadorSemDocumento(), semDocumento: 1,
    razaoSocial: 'CONSUMIDOR DO BALCAO',
  });
  const ped = criarPedido({ clienteId: pess }, [{ produtoId: prod, qtd: 1, preco: 30 }]);
  const { payload } = montar(ped);
  ok('B1 cliente SD-* não vira CPF no documento fiscal', payload.consumidorCpfCnpj === null);
  ok('B2 o nome continua indo (o cupom identifica quem comprou)',
    payload.consumidorNome === 'CONSUMIDOR DO BALCAO');

  // A barreira tem de valer também para os identificadores legados do ERP,
  // que já moram nesta coluna e passariam por CPF num replace(/\D/g,'').
  const legado = criarPessoa({ cpfCnpj: 'UASG-12345678901', semDocumento: 0, razaoSocial: 'ORGAO' });
  const ped2 = criarPedido({ clienteId: legado }, [{ produtoId: prod, qtd: 1, preco: 30 }]);
  ok('B3 identificador legado UASG-* também não vira CPF',
    montar(ped2).payload.consumidorCpfCnpj === null);
}

// ── C. pedido sem cliente ───────────────────────────────────────────────────
{
  const prod = criarProduto();
  const ped = criarPedido({ clienteId: null }, [{ produtoId: prod, qtd: 1, preco: 40 }]);
  const { payload } = montar(ped);
  ok('C1 pedido sem cliente monta sem destinatário', payload.consumidorCpfCnpj === null
    && payload.consumidorNome === null);
}

// ── D. entrega na mesma cidade do emitente ──────────────────────────────────
{
  const prod = criarProduto();
  const pess = criarPessoa({ cpfCnpj: '12345678909' });
  const ped = criarPedido({
    clienteId: pess, tipoAtendimento: 'entrega', valorFrete: 12,
    enderecoEntrega: 'RUA DAS FLORES', numeroEntrega: '250', bairroEntrega: 'NOVO HORIZONTE',
    cidadeEntrega: emitente.cidade, ufEntrega: emitente.uf, cepEntrega: '68500-000',
  }, [{ produtoId: prod, qtd: 2, preco: 25 }]);
  const { payload } = montar(ped);

  ok('D1 o grupo de entrega foi montado', !!payload.entrega);
  ok('D2 o cMun saiu do emitente, porque a cidade é a mesma',
    payload.entrega.cMun === String(emitente.codigoMunicipio),
    `veio ${payload.entrega && payload.entrega.cMun}`);
  ok('D3 o CEP saiu só com dígitos', payload.entrega.CEP === '68500000');
  ok('D4 o frete entra separado, com modFrete 0 (conta do emitente)',
    payload.frete && payload.frete.valor === 12 && payload.frete.modFrete === '0');
  ok('D5 o total do pagamento inclui o frete', payload.pagamentos[0].valor === 62);
}

// ── E. entrega que NÃO pode virar NFC-e ─────────────────────────────────────
// As duas recusas existem para o defeito aparecer aqui, e não como rejeição da
// SEFAZ depois de a numeração ter sido consumida.
{
  const prod = criarProduto();
  const pess = criarPessoa({ cpfCnpj: '98765432100' });
  const base = {
    clienteId: pess, tipoAtendimento: 'entrega', valorFrete: 0,
    enderecoEntrega: 'RUA X', numeroEntrega: '1', bairroEntrega: 'CENTRO',
  };

  const outraCidade = criarPedido(Object.assign({}, base, {
    cidadeEntrega: 'CIDADE QUE NAO EXISTE', ufEntrega: emitente.uf,
  }), [{ produtoId: prod, qtd: 1, preco: 20 }]);
  recusa('E1 cidade desconhecida é recusada por falta de código IBGE',
    () => montar(outraCidade), 'código IBGE');

  const outraUF = criarPedido(Object.assign({}, base, {
    cidadeEntrega: 'SAO PAULO', ufEntrega: emitente.uf === 'SP' ? 'RJ' : 'SP',
    codigoMunicipioEntrega: '3550308',
  }), [{ produtoId: prod, qtd: 1, preco: 20 }]);
  recusa('E2 entrega em outra UF é recusada (NFC-e é interna)',
    () => montar(outraUF), 'dentro do estado');

  // Com o código gravado no pedido, a entrega passa mesmo em cidade que o
  // montador não conheceria sozinho.
  const comCodigo = criarPedido(Object.assign({}, base, {
    cidadeEntrega: 'PARAUAPEBAS', ufEntrega: emitente.uf, codigoMunicipioEntrega: '1505502',
  }), [{ produtoId: prod, qtd: 1, preco: 20 }]);
  ok('E3 codigoMunicipioEntrega gravado no pedido é respeitado',
    montar(comCodigo).payload.entrega.cMun === '1505502');
}

// ── F. o que impede a nota de sair ──────────────────────────────────────────
{
  const prod = criarProduto();
  const semItem = criarPedido({}, []);
  recusa('F1 pedido sem itens é recusado', () => montar(semItem), 'não tem itens');

  const semPag = criarPedido({ meioPagamento: null }, [{ produtoId: prod, qtd: 1, preco: 10 }]);
  recusa('F2 pedido sem meio de pagamento é recusado', () => montar(semPag), 'meio de pagamento');

  const totalErrado = criarPedido({ valorTotal: 999 }, [{ produtoId: prod, qtd: 1, preco: 10 }]);
  recusa('F3 total gravado que não bate com os itens é recusado',
    () => montar(totalErrado), 'não confere');

  recusa('F4 pedido inexistente é recusado', () => montar(99999999), 'não encontrado');
}

// ── G. desconto ─────────────────────────────────────────────────────────────
{
  const prod = criarProduto();
  const ped = criarPedido({ descontoAplicado: 5 }, [{ produtoId: prod, qtd: 2, preco: 25 }]);
  const { payload } = montar(ped);
  ok('G1 o desconto vai como valorDesconto', payload.valorDesconto === 5);
  ok('G2 o pagamento é o líquido', payload.pagamentos[0].valor === 45);
}

// ── H. a injeção do grupo <entrega> no XML ──────────────────────────────────
// A node-sped-nfe não implementa tagEntrega, então o grupo é injetado entre a
// montagem e a assinatura. O que se prova aqui é a POSIÇÃO: fora de ordem, o
// XML é rejeitado pelo schema (215) mesmo com o conteúdo certo.
{
  /* O `<det nItem="1">` com atributo é a forma REAL que a lib produz —
     conferido no XML de fixture. Um recorte por `'<det>'` literal não casaria
     nunca e o grupo iria parar no fim do arquivo. O `<detPag>` está aqui de
     propósito: ele também começa por `<det` e fica depois de <total>, então
     casar com ele jogaria a entrega para dentro de <pag>. */
  const xml = '<NFe><infNFe><ide>..</ide><emit>..</emit><dest>..</dest>'
            + '<det nItem="1">..</det><det nItem="2">..</det><total>..</total>'
            + '<pag><detPag>..</detPag></pag></infNFe></NFe>';
  const end = {
    xLgr: 'RUA DAS FLORES', nro: '250', xCpl: null, xBairro: 'CENTRO',
    cMun: '1504208', xMun: 'MARABA', UF: 'PA', CEP: '68500000',
  };
  const saida = injetarEntrega(xml, end);
  ok('H1 o grupo entrega foi acrescentado', saida.includes('<entrega>'));
  ok('H2 <entrega> vem DEPOIS de <dest>', saida.indexOf('<dest>') < saida.indexOf('<entrega>'));
  ok('H3 <entrega> vem ANTES do primeiro <det nItem>',
    saida.indexOf('<entrega>') < saida.indexOf('<det nItem="1">'));
  ok('H4 campo vazio não vira tag vazia', !saida.includes('<xCpl>'));
  ok('H5 sem endereço, o XML sai intocado', injetarEntrega(xml, null) === xml);
  ok('H6 XML sem <det> é recusado em vez de gerar posição errada', (() => {
    try { injetarEntrega('<NFe><infNFe><ide>..</ide></infNFe></NFe>', end); return false; }
    catch (_) { return true; }
  })());
  ok('H7 <detPag> não é confundido com <det>', (() => {
    try { injetarEntrega('<NFe><pag><detPag>..</detPag></pag></NFe>', end); return false; }
    catch (_) { return true; }
  })());
  ok('H8 o conteúdo do grupo saiu completo',
    saida.includes('<xLgr>RUA DAS FLORES</xLgr><nro>250</nro><xBairro>CENTRO</xBairro>'
                 + '<cMun>1504208</cMun><xMun>MARABA</xMun><UF>PA</UF><CEP>68500000</CEP>'),
    (saida.match(/<entrega>[\s\S]*?<\/entrega>/) || [''])[0]);
}

// ── I. o auxiliar de município, isolado ─────────────────────────────────────
{
  const emit = { cidade: 'Marabá', uf: 'PA', codigoMunicipio: '1504208' };
  ok('I1 acento e caixa não atrapalham a comparação de cidade',
    codigoMunicipioDaEntrega({ cidadeEntrega: 'MARABA', ufEntrega: 'pa' }, emit) === '1504208');
  ok('I2 cidade diferente devolve null',
    codigoMunicipioDaEntrega({ cidadeEntrega: 'BELEM', ufEntrega: 'PA' }, emit) === null);
  ok('I3 mesma cidade em outra UF devolve null',
    codigoMunicipioDaEntrega({ cidadeEntrega: 'MARABA', ufEntrega: 'MG' }, emit) === null);
  ok('I4 código gravado com máscara é aceito só se tiver 7 dígitos',
    codigoMunicipioDaEntrega({ codigoMunicipioEntrega: '15.045-02' }, emit) === '1504502');
  ok('I5 código gravado curto é ignorado',
    codigoMunicipioDaEntrega({ codigoMunicipioEntrega: '150', cidadeEntrega: 'X' }, emit) === null);
}

console.log(`\n${total - falhas}/${total} asserts passaram`);
if (falhas) { console.log(`FALHA: ${falhas} problema(s)`); process.exit(1); }
console.log('TODOS OS ASSERTS PASSARAM');
