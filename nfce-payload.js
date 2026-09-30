/**
 * Monta o payload de NFC-e a partir de um pedido do Catálogo Online.
 *
 * Existe como arquivo separado por dois motivos. O primeiro é que o
 * `emitirNFCe` do `nfce-routes.js` nasceu para o balcão, onde o operador
 * digita a venda: ele recebe itens já prontos e não sabe ler um pedido. O
 * segundo é que a tradução pedido → documento fiscal tem regras próprias
 * (quem é o destinatário, onde entra o frete, o que fazer quando o cliente
 * não tem CPF) e essas regras precisam de teste sem SEFAZ, sem certificado e
 * sem numeração queimada.
 *
 * Este módulo NÃO emite nada e NÃO escreve no banco. Ele lê o pedido e
 * devolve um objeto; quem emite continua sendo o `emitirNFCe`.
 *
 * Três campos do retorno o `emitirNFCe` ainda não consome — `entrega`,
 * `frete` e `indPres`. Estão aqui porque são a informação que o pedido tem e
 * a nota precisa; a fiação deles é a etapa seguinte, e está descrita no
 * cabeçalho de cada um.
 */

const semDoc = require('./pessoa-sem-documento');

/** Compara nome de cidade ignorando acento, caixa e espaço sobrando. */
function mesmoLugar(a, b) {
  const n = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
  return n(a) !== '' && n(a) === n(b);
}

function r2c(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/**
 * O código IBGE do município de entrega.
 *
 * O grupo <entrega> exige cMun, e o checkout do catálogo não grava
 * `codigoMunicipioEntrega` (a coluna existe, mas só o cadastro manual de
 * pedido a preenche). Sem tabela de municípios no projeto, só há duas fontes
 * honestas: a coluna, quando preenchida, e o município do emitente, quando a
 * entrega é na mesma cidade — que é o caso de toda entrega própria.
 *
 * Fora desses dois, esta função devolve null e quem chama recusa. Chutar o
 * código do emitente para uma cidade diferente trocaria uma recusa nossa,
 * legível, por uma rejeição 273 da SEFAZ depois de a numeração ter sido
 * consumida.
 */
function codigoMunicipioDaEntrega(pedido, emitente) {
  const gravado = String(pedido.codigoMunicipioEntrega || '').replace(/\D/g, '');
  if (gravado.length === 7) return gravado;
  if (mesmoLugar(pedido.cidadeEntrega, emitente.cidade)
      && mesmoLugar(pedido.ufEntrega, emitente.uf)) {
    const cod = String(emitente.codigoMunicipio || '').replace(/\D/g, '');
    if (cod.length === 7) return cod;
  }
  return null;
}

/**
 * Traduz um pedido do catálogo no payload que o emissor de NFC-e consome.
 *
 * @param {object} db            conexão do tenant
 * @param {number} pedidoId      o pedido de origem
 * @param {object} contexto      { emitente, tipoOperacaoId }
 * @returns {{ payload: object, pedido: object }}
 * @throws  {Error} com mensagem destinada a quem opera, não a quem programa
 */
function payloadDeNFCeDePedido(db, pedidoId, contexto = {}) {
  const pedido = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(Number(pedidoId));
  if (!pedido) throw new Error(`Pedido ${pedidoId} não encontrado`);

  const emitente = contexto.emitente;
  if (!emitente) throw new Error('Emitente não informado ao montador');

  const itensPedido = db.prepare(
    'SELECT * FROM pedido_itens WHERE pedidoId = ? ORDER BY id').all(pedido.id);
  if (!itensPedido.length) throw new Error(`Pedido ${pedido.numero} não tem itens`);

  // Os dados fiscais do item moram no produto, não em pedido_itens.
  const ids = [...new Set(itensPedido.map((i) => i.produtoId).filter(Boolean))];
  const produtos = new Map();
  if (ids.length) {
    const rows = db.prepare(
      `SELECT id, sku, unidade, ncm, codigoBarras, origem, csosn, cstPIS, cstCOFINS, cfopPadrao
         FROM produtos WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const r of rows) produtos.set(r.id, r);
  }

  const itens = itensPedido.map((it) => {
    const p = it.produtoId ? produtos.get(it.produtoId) : null;
    return {
      produtoId: it.produtoId || null,
      sku: (p && p.sku) || null,
      descricao: it.descricao,
      ncm: (p && p.ncm) || null,
      // CFOP do item quando gravado; senão o emissor cai no da natureza.
      cfop: it.cfop || (p && p.cfopPadrao) || null,
      unidade: (p && p.unidade) || 'UN',
      codigoBarras: (p && p.codigoBarras) || null,
      origem: p ? p.origem : null,
      quantidade: Number(it.quantidade),
      precoUnitario: Number(it.precoUnitario),
      valorTotal: r2c(it.valorTotal),
    };
  });

  // ── consumidor ────────────────────────────────────────────────────────────
  // `documentoFiscalDe` devolve null para o identificador SD-*, que é interno
  // e não é CPF. Nota sem destinatário é válida em NFC-e — até R$ 200, e desde
  // que a natureza não gere financeiro; as duas checagens já existem no
  // emissor e não são repetidas aqui.
  const cliente = pedido.clienteId
    ? db.prepare('SELECT id, razaoSocial, cpfCnpj, semDocumento FROM pessoas WHERE id = ?')
        .get(pedido.clienteId)
    : null;
  const documento = cliente ? semDoc.documentoFiscalDe(cliente) : null;

  // ── pagamento ─────────────────────────────────────────────────────────────
  // `pedidos.meioPagamento` já guarda o código da SEFAZ (o checkout grava
  // '17', '01' ou '03'). Um pedido sem meio gravado não vira nota: inventar
  // '99' aqui esconderia um pedido que não passou pelo checkout.
  const tPag = String(pedido.meioPagamento || '').replace(/\D/g, '').padStart(2, '0');
  if (!/^(0[1-9]|1[0-9]|90|99)$/.test(tPag)) {
    throw new Error(`Pedido ${pedido.numero} sem meio de pagamento válido para a nota`);
  }

  /* Troco: só existe em dinheiro, e só quando o pedido guardou quanto o
     cliente vai entregar. `valorRecebidoDinheiro` é NULL em todo o resto —
     PIX, cartão, dinheiro sem troco, pedido interno — e aí o payload sai
     exatamente como saía antes.
     O troco não é lido do banco: é derivado aqui, `recebido − total`, com o
     mesmo `r2c` que o resto do arquivo usa. Guardar o troco seria a segunda
     verdade que esta coluna existe para evitar. */
  const recebido = tPag === '01' ? r2c(pedido.valorRecebidoDinheiro) : 0;

  const frete = r2c(pedido.valorFrete);
  const somaItens = r2c(itens.reduce((s, i) => s + i.valorTotal, 0));
  const desconto = r2c(pedido.descontoAplicado);
  const total = r2c(somaItens + frete - desconto);

  // O total recalculado tem de bater com o gravado. Divergência aqui é dado
  // inconsistente no pedido, e emitir por cima dela gravaria uma nota que não
  // corresponde ao que o cliente viu.
  if (Math.abs(total - r2c(pedido.valorTotal)) > 0.02) {
    throw new Error(
      `Pedido ${pedido.numero}: total dos itens (${total.toFixed(2)}) não confere `
      + `com o total gravado (${r2c(pedido.valorTotal).toFixed(2)})`);
  }

  // ── entrega ───────────────────────────────────────────────────────────────
  // Só existe quando o pedido é de entrega. A retirada é o cliente vindo à
  // loja, e o endereço do emitente já está no <emit>.
  let entrega = null;
  if (pedido.tipoAtendimento === 'entrega') {
    const cMun = codigoMunicipioDaEntrega(pedido, emitente);
    if (!cMun) {
      throw new Error(
        `Pedido ${pedido.numero}: entrega em ${pedido.cidadeEntrega || '(sem cidade)'}`
        + ' sem código IBGE do município. Preencha o município de entrega no pedido'
        + ' antes de emitir.');
    }
    // NFC-e é documento de operação interna. Entrega em outra UF exige NF-e 55.
    if (!mesmoLugar(pedido.ufEntrega, emitente.uf)) {
      throw new Error(
        `Pedido ${pedido.numero}: entrega em ${pedido.ufEntrega || '(sem UF)'} e o emitente`
        + ` é de ${emitente.uf}. NFC-e só vale para operação dentro do estado — use NF-e.`);
    }
    entrega = {
      xLgr: String(pedido.enderecoEntrega || '').slice(0, 60) || 'NAO INFORMADO',
      nro: String(pedido.numeroEntrega || 'SN').slice(0, 60),
      xCpl: pedido.complementoEntrega ? String(pedido.complementoEntrega).slice(0, 60) : null,
      xBairro: String(pedido.bairroEntrega || '').slice(0, 60) || 'NAO INFORMADO',
      cMun,
      xMun: String(pedido.cidadeEntrega || emitente.cidade || '').slice(0, 60),
      UF: String(pedido.ufEntrega || emitente.uf),
      CEP: String(pedido.cepEntrega || '').replace(/\D/g, '') || null,
    };
  }

  return {
    pedido,
    payload: {
      // ── o que o emitirNFCe já consome hoje ──
      pedidoId: pedido.id,
      tipoOperacaoId: contexto.tipoOperacaoId || pedido.tipoOperacaoId || null,
      itens,
      /* Com troco, o que o cliente ENTREGA é o `vPag`, e a diferença é o
         `vTroco`. Sem troco — que é o caso de tudo o mais — o pagamento
         continua sendo o total, byte a byte como antes.
         `recebido > total` e não `>=`: igual ao total não é troco, e um
         `<vTroco>0.00</vTroco>` seria ruído no cupom. */
      pagamentos: [{ tPag, valor: recebido > total ? recebido : total }],
      vTroco: recebido > total ? r2c(recebido - total) : null,
      consumidorCpfCnpj: documento,
      consumidorNome: cliente ? cliente.razaoSocial : null,
      valorDesconto: desconto,
      /* O pedido do catálogo já reservou na confirmação e já baixou na
         entrega, e já tem conta a receber pelo faturamento. Repetir os efeitos
         aqui baixaria o estoque duas vezes. */
      efeitosJaAplicados: true,

      // ── o que o emitirNFCe ainda NÃO consome ──
      /* Venda pela internet. Hoje o emissor crava indPres '1' (presencial),
         que é o certo para o balcão e errado para o catálogo. */
      indPres: '2',
      /* Frete cobrado. Precisa entrar em duas casas do XML: `vFrete` no
         ICMSTot e `modFrete` 0 no <transp> (hoje o emissor crava 9). Sem as
         duas, a soma dos componentes não fecha com o vNF (rejeição 531). */
      frete: frete > 0 ? { valor: frete, modFrete: '0' } : null,
      /* Grupo <entrega>. A node-sped-nfe declara tagEntrega mas lança "Ainda
         não configurado!", então o caminho é injetar o trecho no XML entre a
         montagem e a assinatura — o mesmo que farmacia/nfe-med-rastro.js já
         faz com <med> e <rastro>. Ver injetarEntrega(), abaixo. */
      entrega,
    },
  };
}

/**
 * Injeta o grupo <entrega> no XML montado, antes da assinatura.
 *
 * A sequência do infNFe na versão 4.00 põe <entrega> depois de <dest> e
 * <retirada> e antes do primeiro <det>. Injetar em outro ponto é rejeição 215
 * (falha no schema), e o XML ainda não está assinado, então mexer aqui é
 * seguro — depois da assinatura seria adulteração.
 *
 * @param {string} xml       o XML devolvido por Make.xml()
 * @param {object} endereco  o objeto `entrega` do payload
 * @returns {string} o XML com o grupo acrescentado
 */
function injetarEntrega(xml, endereco) {
  if (!endereco) return xml;
  /* `<det[ >]` e não `<det>`: o XML real sai como `<det nItem="1">`. O recorte
     também precisa NÃO casar com `<detPag>`, que fica bem depois e levaria o
     grupo para dentro de <pag>. */
  const achado = /<det[ >]/.exec(xml);
  if (!achado) throw new Error('XML sem <det> — não é uma NFC-e montada');
  const pos = achado.index;
  const campo = (tag, valor) =>
    (valor === null || valor === undefined || valor === '') ? '' : `<${tag}>${valor}</${tag}>`;
  const grupo = '<entrega>'
    + campo('xLgr', endereco.xLgr)
    + campo('nro', endereco.nro)
    + campo('xCpl', endereco.xCpl)
    + campo('xBairro', endereco.xBairro)
    + campo('cMun', endereco.cMun)
    + campo('xMun', endereco.xMun)
    + campo('UF', endereco.UF)
    + campo('CEP', endereco.CEP)
    + '</entrega>';
  return xml.slice(0, pos) + grupo + xml.slice(pos);
}

module.exports = { payloadDeNFCeDePedido, injetarEntrega, codigoMunicipioDaEntrega };
