/**
 * Desconto em REAIS na Venda rápida + comprovante de recebimento na Fatura.
 *
 * Dois blocos, e os dois medem a mesma coisa de formas diferentes:
 *
 *   A. DESCONTO. A entrada mudou de percentual para reais, mas a ALÇADA continua
 *      em percentual — e continua sendo do servidor. Estes casos provam que
 *      mudar a unidade do campo não abriu porta: quem manda R$ 25 onde o teto é
 *      R$ 20 é recusado, mesmo adulterando o request.
 *
 *   B. FATURA. O PDF é gerado de verdade e lido com `pdftotext`. Conferir a
 *      string no fonte provaria só que o código tem a letra certa; o que
 *      interessa é o que sai no papel — inclusive em que página sai.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desc48-'));
const abertos = [];

// ============================================================================
// Banco + rotas reais de pedidos
// ============================================================================

function montar({ faixas = [{ limiteValor: 10, papelAprovador: 'gerente-comercial' }] } = {}) {
  const db = new Database(path.join(tmp, 'p' + abertos.length + '.db'));
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
  abertos.push(db);

  /* `regras_alcada` nao nasce no initSchema — vem de `migrarGovernancaDB`, que
     roda no provisionamento. A tabela EXISTE nos tenants reais (conferido em
     produtosbomgosto), entao cria-la aqui aproxima o harness do que ha em
     producao, em vez de inventar um schema que ninguem tem. */
  require('../governanca-routes').migrarGovernancaDB(db);

  /* Perfil 'vendedor' CADASTRADO e ativo.
   *
   * Sem esta linha o teste nao mede nada: `acessoDoUsuario` devolve
   * `irrestrito: true` para todo role sem perfil (perfis-acesso.js:106), o
   * vendedor de mentira viraria ator privilegiado e passaria por cima da
   * alcada — exatamente o contrario do que estes casos querem provar. */
  try {
    db.prepare(`INSERT OR REPLACE INTO perfis_acesso (slug, nome, paginas, ativo)
                VALUES ('vendedor', 'Vendedor', ?, 1)`).run(JSON.stringify(['pedidos-pdv']));
    db.prepare(`INSERT OR REPLACE INTO perfis_acesso (slug, nome, paginas, ativo)
                VALUES ('vendedor-turbo', 'Vendedor Turbo', ?, 1)`).run(JSON.stringify(['pedidos-pdv']));
    db.prepare(`INSERT OR REPLACE INTO perfis_acesso (slug, nome, paginas, ativo)
                VALUES ('gerente-comercial', 'Gerente Comercial', ?, 1)`).run(JSON.stringify(['pedidos-pdv']));
  } catch (e) { throw new Error('perfis_acesso indisponivel: ' + e.message); }

  // Governança: as faixas de desconto_venda. Sem elas o limite é 0% (fail-closed).
  try {
    for (const f of faixas) {
      db.prepare(`INSERT INTO regras_alcada (tipoEvento, limiteValor, papelAprovador, ativo)
                  VALUES ('desconto_venda', ?, ?, 1)`).run(f.limiteValor, f.papelAprovador);
    }
  } catch (e) { throw new Error('governanca indisponivel no schema: ' + e.message); }

  return db;
}

/** Pedido com itens somando `subtotal`, criado direto — o foco aqui é o desconto. */
function pedidoCom(db, subtotal) {
  const num = 'PV-' + Math.random().toString(36).slice(2, 8);
  const id = db.prepare(`INSERT INTO pedidos (numero, tipo, status, dataPedido, dataCriacao)
                         VALUES (?, 'manual', 'rascunho', DATE('now'), CURRENT_TIMESTAMP)`)
    .run(num).lastInsertRowid;
  db.prepare(`INSERT INTO pedido_itens (pedidoId, descricao, quantidade, precoUnitario, valorTotal)
              VALUES (?, 'PRODUTO TESTE', 1, ?, ?)`).run(id, subtotal, subtotal);
  return id;
}

const descontos = require('../pedido-desconto');

/** Requisição fingida, com o papel do operador — é o que a alçada consulta. */
const reqDe = (role, username = 'vendedor1') => ({ user: { role, username }, session: { username } });

// ============================================================================
// A. Desconto em reais
// ============================================================================

t('A1. desconto em R$ é aceito e grava o valor digitado', () => {
  const db = montar();
  const id = pedidoCom(db, 200);
  const r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 20, descontoTipo: 'valor' }, req: reqDe('vendedor'),
  });
  assert(r.ok, 'recusou desconto dentro da alçada: ' + r.erro);
  assert(r.aplicado === 20, `aplicado veio ${r.aplicado}, esperava 20`);
  const p = db.prepare('SELECT descontoTipo, descontoValor, descontoAplicado FROM pedidos WHERE id=?').get(id);
  assert(p.descontoTipo === 'valor', 'gravou tipo ' + p.descontoTipo);
  assert(p.descontoAplicado === 20, 'gravou aplicado ' + p.descontoAplicado);
});

t('A2. R$ 20 em subtotal R$ 200 resulta em total R$ 180', () => {
  const db = montar();
  const id = pedidoCom(db, 200);
  descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 20, descontoTipo: 'valor' }, req: reqDe('vendedor'),
  });
  const total = descontos.totalDoPedido({
    subtotalItens: descontos.subtotalItens(db, id),
    desconto: descontos.descontoDoPedido(db, id),
    frete: 0,
  });
  assert(total === 180, `total ${total}, esperava 180`);
});

t('A3. o backend converte para percentual e é ELE que a alçada vê', () => {
  const db = montar();
  const id = pedidoCom(db, 200);
  // R$ 20 sobre R$ 200 = 10%, exatamente no teto da faixa.
  const c = descontos.calcularDesconto({ subtotal: 200, tipo: 'valor', valor: 20 });
  assert(c.percentual === 10, `percentual convertido ${c.percentual}, esperava 10`);
  const r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 20, descontoTipo: 'valor' }, req: reqDe('vendedor'),
  });
  assert(r.ok && r.percentual === 10, 'a alçada não recebeu o percentual convertido: ' + JSON.stringify(r));
});

t('A4. R$ 25 sobre R$ 200 (12,5%) passa do teto e é RECUSADO', () => {
  const db = montar();
  const id = pedidoCom(db, 200);
  const r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 25, descontoTipo: 'valor' }, req: reqDe('vendedor'),
  });
  assert(!r.ok, 'ACEITOU desconto acima da alçada — o teto de 10% foi burlado pela unidade em reais');
  const p = db.prepare('SELECT descontoAplicado FROM pedidos WHERE id=?').get(id);
  assert(!(Number(p.descontoAplicado) > 0), 'gravou o desconto recusado: ' + p.descontoAplicado);
});

t('A5. sem nenhuma faixa cadastrada, o limite é R$ 0,00 (fail-closed)', () => {
  const db = montar({ faixas: [] });
  const id = pedidoCom(db, 200);
  const r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 1, descontoTipo: 'valor' }, req: reqDe('vendedor'),
  });
  assert(!r.ok, 'sem alçada configurada o desconto passou — deveria ser 0');
  const lim = descontos.limiteDescontoDisponivel(db, { pedidoId: id, req: reqDe('vendedor') });
  assert(lim.valor === 0 && lim.percentual === 0, 'limite informado não é zero: ' + JSON.stringify(lim));
});

t('A6. request adulterado não burla a alçada', () => {
  const db = montar();

  // (a) percentual mentindo sobre o valor: os dois juntos e inconsistentes.
  let id = pedidoCom(db, 200);
  let r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoPercentual: 5, descontoValor: 100 }, req: reqDe('vendedor'),
  });
  assert(!r.ok, 'aceitou percentual e valor contraditórios (5% de 200 = 10, veio 100)');

  // (b) tipo 'percentual' com número de reais: 25 viraria 25%, não R$ 25.
  id = pedidoCom(db, 200);
  r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 25, descontoTipo: 'percentual' }, req: reqDe('vendedor'),
  });
  assert(!r.ok, 'aceitou 25% disfarçado de R$ 25');

  // (c) papel inventado no request não vale nada: quem confere é a faixa.
  id = pedidoCom(db, 200);
  r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 60, descontoTipo: 'valor' }, req: reqDe('vendedor-turbo'),
  });
  assert(!r.ok, 'um role desconhecido passou pela alçada');
});

t('A7. desconto nunca torna o total negativo', () => {
  const db = montar();
  const id = pedidoCom(db, 200);
  // Maior que o subtotal: recusado na entrada.
  const r = descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 300, descontoTipo: 'valor' }, req: reqDe('admin'),
  });
  assert(!r.ok, 'aceitou desconto maior que o subtotal');
  // E mesmo que o subtotal encolha depois, o total é limitado a zero.
  assert(descontos.totalDoPedido({ subtotalItens: 50, desconto: 500, frete: 0 }) === 0,
    'total ficou negativo quando o desconto passou do subtotal');
  assert(descontos.totalDoPedido({ subtotalItens: 50, desconto: 500, frete: 10 }) === 10,
    'o frete deixou de ser somado depois do desconto');
});

t('A8. pedido salvo e relido preserva exatamente o desconto', () => {
  const db = montar();
  const id = pedidoCom(db, 200);
  descontos.aplicarDescontoNoPedido(db, {
    pedidoId: id, body: { descontoValor: 17.35, descontoTipo: 'valor' }, req: reqDe('admin'),
  });
  const lido = descontos.descontoDoPedido(db, id);
  assert(lido === 17.35, `releu ${lido}, gravou 17.35`);
  // Reprecificar (chamado a cada mudança de item) NÃO mexe em desconto de valor.
  descontos.reprecificarDesconto(db, id, 200);
  assert(descontos.descontoDoPedido(db, id) === 17.35, 'reprecificar alterou um desconto em reais');
});

t('A9. o limite informado bate com a faixa, e é só informativo', () => {
  const db = montar();
  const id = pedidoCom(db, 200);
  const vend = descontos.limiteDescontoDisponivel(db, { pedidoId: id, req: reqDe('vendedor') });
  assert(vend.percentual === 10 && vend.valor === 20,
    'limite do vendedor errado: ' + JSON.stringify(vend));
  // Quem TEM o papel da faixa não esbarra nela.
  const ger = descontos.limiteDescontoDisponivel(db, { pedidoId: id, req: reqDe('gerente-comercial') });
  assert(ger.ilimitado, 'o gerente ficou preso à própria faixa: ' + JSON.stringify(ger));
  // Admin idem.
  assert(descontos.limiteDescontoDisponivel(db, { pedidoId: id, req: reqDe('admin') }).ilimitado,
    'admin ficou com teto');
});

t('A10. a tela envia REAIS e não calcula alçada nenhuma', () => {
  const html = fs.readFileSync(path.join(RAIZ, 'public/comercial/pedidos-pdv.html'), 'utf8');
  const semComentarios = html.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  assert(/descontoValor/.test(semComentarios), 'a tela não envia descontoValor');
  assert(!/descontoPercentual/.test(semComentarios), 'a tela ainda envia descontoPercentual');
  assert(/Desconto \(R\$\)/.test(semComentarios), 'o rótulo em reais não aparece');
  assert(/inputmode="decimal"/.test(semComentarios), 'falta inputmode decimal para o teclado do celular');
  assert(/font-size:16px/.test(semComentarios), 'o campo perdeu os 16px que evitam o zoom do iOS');
  // A decisão de alçada não pode viver no navegador.
  assert(!/regras_alcada|papelAprovador|limiteValor/.test(semComentarios),
    'a tela passou a conhecer faixas de alçada — a decisão tem de ficar no servidor');
});

// ============================================================================
// B. Fatura comercial
// ============================================================================

const faturasPdf = require('../faturas-pdf');

const EMITENTE = { razaoSocial: 'EMPRESA TESTE LTDA', cnpj: '11222333000181',
  endereco: 'RUA A', numero: '1', bairro: 'CENTRO', cidade: 'MARINGA', uf: 'PR', cep: '87000000' };

function faturaCom(n) {
  return {
    numero: 'FAT-0001', dataEmissao: '2026-09-14', dataVencimento: '2026-09-21',
    clienteNome: 'CLIENTE TESTE', clienteCpfCnpj: '12345678901',
    clienteEndereco: 'RUA B', clienteCidade: 'MARINGA', clienteUf: 'PR',
    meioPagamento: '17', pedidoNumero: 'PV-1',
    observacao: 'Entrega conforme combinado.',
    valorBruto: 100 * n, valorDesconto: 0, valorFrete: 0, valorTotal: 100 * n,
    itens: Array.from({ length: n }, (_, i) => ({
      sku: 'SKU-' + (i + 1), descricao: 'PRODUTO DE TESTE NUMERO ' + (i + 1),
      unidade: 'UN', quantidade: 1, precoUnitario: 100, valorTotal: 100,
    })),
  };
}

function gerarTexto(fatura, nome) {
  const arq = path.join(tmp, nome + '.pdf');
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(arq);
    ws.on('finish', () => {
      try {
        // -layout preserva a posição; sem ele, colunas viram sopa de palavras.
        const txt = execFileSync('pdftotext', ['-layout', arq, '-'], { encoding: 'utf8' });
        const paginas = txt.split('\f').filter((p) => p.trim());
        resolve({ txt, paginas, arq });
      } catch (e) { reject(e); }
    });
    ws.on('error', reject);
    faturasPdf.gerar(ws, fatura, EMITENTE);
  });
}

t('B10/B11. o PDF traz COMPROVANTE DE RECEBIMENTO, Data, Hora e Assinatura', async () => {
  const { txt } = await gerarTexto(faturaCom(3), 'pequeno');
  assert(/COMPROVANTE DE RECEBIMENTO/.test(txt), 'falta o título do comprovante');
  assert(/Declaro que recebi os produtos relacionados neste documento em conformidade/.test(txt),
    'falta a declaração de recebimento');
  assert(/Data:\s*___\/___\/______/.test(txt), 'o campo de data não saiu no formato ___/___/______');
  assert(/Hora:\s*___:___/.test(txt), 'o campo de hora não saiu no formato ___:___');
  assert(/Assinatura:/.test(txt), 'falta a linha de assinatura');
});

t('B12. o PDF NÃO pede "Recebido por", CPF nem RG', async () => {
  const { txt } = await gerarTexto(faturaCom(3), 'semdados');
  assert(!/Recebido por/i.test(txt), 'voltou o campo "Recebido por"');
  // O CPF do CLIENTE é legítimo e vive no bloco CLIENTE; o proibido é pedir
  // documento de quem RECEBE. Olha-se só o trecho do comprovante.
  const trecho = txt.slice(txt.indexOf('COMPROVANTE DE RECEBIMENTO'));
  assert(!/\bCPF\b/i.test(trecho), 'o comprovante pede CPF de quem recebe');
  assert(!/\bRG\b/i.test(trecho), 'o comprovante pede RG de quem recebe');
});

t('B13. sem duplicação de separadores: nada de // nem ::', async () => {
  const { txt } = await gerarTexto(faturaCom(3), 'separadores');
  const trecho = txt.slice(txt.indexOf('COMPROVANTE DE RECEBIMENTO'));
  assert(!/__\/\/__/.test(trecho) && !/\/\/\//.test(trecho), 'barras duplicadas na data: ' + trecho.slice(0, 200));
  assert(!/__::__/.test(trecho) && !/:::/.test(trecho), 'dois-pontos duplicados na hora: ' + trecho.slice(0, 200));
});

t('B14/B15. a faixa laranja saiu, o aviso discreto ficou', async () => {
  const { txt } = await gerarTexto(faturaCom(3), 'rodape');
  assert(/DOCUMENTO INTERNO — SEM VALOR FISCAL/.test(txt), 'o aviso sem valor fiscal SUMIU');

  // A faixa era um retângulo preenchido de #ffa94d. O texto não denuncia cor,
  // então a checagem é no fonte — é o único lugar onde a cor existe.
  const fonte = fs.readFileSync(path.join(RAIZ, 'faturas-pdf.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert(!/ffa94d/i.test(fonte), 'a faixa laranja continua no código');
  assert(!/DOCUMENTO SEM VALOR FISCAL/.test(fonte), 'sobrou o texto antigo do rodapé');
});

t('B16. o bloco de assinatura não é dividido entre páginas', async () => {
  // Vários tamanhos, incluindo os que terminam perto do fim da folha.
  for (const n of [1, 3, 12, 22, 24, 26, 28, 30, 31, 45]) {
    const { paginas } = await gerarTexto(faturaCom(n), 'quebra' + n);
    const comTitulo = paginas.filter((p) => /COMPROVANTE DE RECEBIMENTO/.test(p));
    assert(comTitulo.length === 1, `${n} itens: o comprovante aparece em ${comTitulo.length} páginas`);

    // Título, declaração, data, hora e assinatura têm de estar na MESMA página.
    const p = comTitulo[0];
    assert(/Declaro que recebi/.test(p), `${n} itens: a declaração caiu em outra página`);
    assert(/Data:\s*___\/___\/______/.test(p), `${n} itens: a data caiu em outra página`);
    assert(/Hora:\s*___:___/.test(p), `${n} itens: a hora caiu em outra página`);
    assert(/Assinatura:/.test(p), `${n} itens: a assinatura caiu em outra página`);
  }
});

t('B17. fatura com mais de 30 itens continua paginando, e todos os itens saem', async () => {
  const { txt, paginas } = await gerarTexto(faturaCom(34), 'grande');
  assert(paginas.length >= 2, 'uma fatura de 34 itens saiu numa página só');
  for (const i of [1, 17, 34]) {
    assert(txt.includes('PRODUTO DE TESTE NUMERO ' + i), 'sumiu o item ' + i);
  }
  // O aviso discreto sai em TODAS as folhas — o documento é entregue folha a folha.
  for (const [i, p] of paginas.entries()) {
    assert(/DOCUMENTO INTERNO — SEM VALOR FISCAL/.test(p),
      `a página ${i + 1} de ${paginas.length} saiu sem o aviso`);
  }
  assert(/Página 1 de /.test(paginas[0]), 'sumiu a numeração de páginas');
});

t('B18. o total e os blocos de pagamento/informações continuam saindo', async () => {
  const { txt } = await gerarTexto(faturaCom(5), 'blocos');
  assert(/PAGAMENTO/.test(txt), 'sumiu o bloco PAGAMENTO');
  assert(/INFORMAÇÕES ADICIONAIS/.test(txt), 'sumiu o bloco INFORMAÇÕES ADICIONAIS');
  assert(/TOTAL:/.test(txt), 'sumiu o TOTAL');
  assert(/Entrega conforme combinado/.test(txt), 'sumiu a observação');
  // Ordem: o comprovante vem DEPOIS das informações adicionais.
  assert(txt.indexOf('INFORMAÇÕES ADICIONAIS') < txt.indexOf('COMPROVANTE DE RECEBIMENTO'),
    'o comprovante saiu antes das informações adicionais');
});

/* Filtro por prefixo: `node test-desconto-reais-fatura.js A4` roda só o A4.
 *
 * Existe para a SABOTAGEM. Cada defeito plantado precisa de uma rodada inteira,
 * e o B16 sozinho gera dez PDFs — com a suíte completa, quinze sabotagens
 * estouram qualquer janela de tempo, e uma execução interrompida no meio deixa
 * um arquivo de produção sabotado em disco. Já aconteceu uma vez hoje.
 *
 * Sem argumento, roda tudo: é assim que o verify a chama. */
const FILTRO = process.argv[2] || null;

(async () => {
  for (const [nome, fn] of fila.filter(([n]) => !FILTRO || n.startsWith(FILTRO))) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  for (const db of abertos) { try { db.close(); } catch (_) {} }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
