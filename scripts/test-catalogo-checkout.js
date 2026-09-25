/**
 * Checkout público do Catálogo Online — o pedido que entra pelo fluxo normal.
 *
 * O que estes casos guardam, e por quê:
 *
 *   AUTORIDADE. Preço, frete, total e origem são do servidor. O corpo manda
 *   referência e intenção; se um dia passar a mandar preço e o servidor
 *   aceitar, é aqui que reprova.
 *
 *   ATOMICIDADE. Falhou qualquer etapa, não sobra pessoa, pedido, item nem
 *   reserva. O caminho que mais importa é o do estoque insuficiente, porque é
 *   o que acontece de verdade: o balcão vende enquanto o cliente decide.
 *
 *   IDEMPOTÊNCIA. Uma tentativa, no máximo um pedido — inclusive com duas
 *   requisições ao mesmo tempo. A garantia é o UNIQUE de
 *   `pedidos.idempotenciaChave`, não a consulta prévia.
 *
 *   NADA DE PARALELO. O pedido nasce em `pedidos`/`pedido_itens`, confirmado
 *   pela MESMA `confirmarPedidoInterno` do ERP.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };
const FILTRO = process.argv[2] || null;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkout-'));
const abertos = [];
/* Schema do TENANT REAL: `initSchema` sozinho é migration incremental e para
   em `contas_financeiras` num banco vazio (ver scripts/schema-de-tenant.js). */
const SCHEMA = require('./schema-de-tenant').schemaDeTenant();

function montar(nome, cfg = {}) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA);
  require('../db-schema').initSchema(db);
  require('../loja-routes').migrarLojaDB(db);
  /* As naturezas de operação não vêm do `initSchema`: quem as semeia é o
     `migrar` do tipos-operacao-routes, que só roda no PROVISIONAMENTO do
     tenant (applyRouteMigrations). Chamado à mão aqui para o banco descartável
     representar um tenant provisionado de verdade. */
  try { require('../tipos-operacao-routes').migrar(db); } catch (_) {}
  db.pragma('foreign_keys = ON');
  abertos.push(db);
  db.exec(`CREATE TABLE IF NOT EXISTS produto_imagens (id INTEGER PRIMARY KEY AUTOINCREMENT,
    produtoId INTEGER NOT NULL, caminho TEXT, urlOrigem TEXT, origem TEXT DEFAULT 'outra',
    autorizadoPor TEXT, autorizadoEm TEXT, largura INTEGER, altura INTEGER, bytes INTEGER,
    ordem INTEGER DEFAULT 0, dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const ins = db.prepare(`INSERT INTO produtos (sku, descricao, categoria, ativo, publicadoNaLoja, precoVenda)
    VALUES (?,?,?,1,1,?)`);
  ins.run('S1', 'CESTA CAFE DA MANHA', 'CESTAS', 100);
  ins.run('S2', 'CANECA', 'BRINDES', 20);
  const mov = db.prepare(`INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, data)
    VALUES (?, 'entrada', ?, date('now'))`);
  mov.run(1, cfg.estoque == null ? 20 : cfg.estoque);
  mov.run(2, 20);
  db.prepare(`UPDATE loja_config SET ativa=?, nome='LOJA PROVA', whatsapp='44999990000',
      servicoRetirada=?, servicoDelivery=?, freteModo=?, freteValor=?, aceitaForaCobertura=?,
      mostrarPreco=1, tema='{"corPrimaria":"#0E6B63","fundo":"claro","fonte":"neutra","raio":10}'
    WHERE id=1`).run(cfg.ativa === 0 ? 0 : 1, cfg.retirada === 0 ? 0 : 1,
      cfg.delivery === 0 ? 0 : 1, cfg.freteModo || 'bairro', cfg.freteValor || 0,
      cfg.aceitaFora ? 1 : 0);
  if ((cfg.freteModo || 'bairro') === 'bairro') {
    db.prepare(`INSERT INTO rest_bairros_taxa (nome, taxa, tempoEstimadoMin, ativo)
      VALUES ('CENTRO', 7.5, 30, 1)`).run();
  }

  /* ── A loja deste arquivo é uma loja CONFIGURADA ────────────────────────
   *
   * Desde a fundação fiscal (2026-09-21) o checkout exige que o lojista tenha
   * escolhido a natureza de operação dos pedidos do catálogo, e recusa com 409
   * enquanto não houver uma. Sem esta linha, os 26 casos daqui passariam a
   * medir a recusa em vez do que cada um se propõe a medir — foi o que
   * aconteceu em 22/09: 21 falhas, todas por `status 409`.
   *
   * A natureza é ESCOLHIDA, não inventada: `VDA-NORMAL` é a de venda comum,
   * semeada pelo próprio ERP, e é o que uma loja de verdade selecionaria na
   * tela de Regras Fiscais. `usarEmPedido = 1` é o mesmo filtro que a tela
   * aplica ao montar o select.
   *
   * O caso contrário — catálogo SEM natureza — continua provado, e em outro
   * lugar de propósito: `test-catalogo-fiscal.js`, casos A1, A2 e A3, que
   * cobrem nada configurado, id inexistente e natureza inativa. Cada arquivo
   * guarda um cenário, e nenhum dos dois esconde o outro. */
  const natureza = db.prepare(`SELECT id FROM tipos_operacao
    WHERE codigo = 'VDA-NORMAL' AND ativo = 1 AND usarEmPedido = 1`).get()
    || db.prepare(`SELECT id FROM tipos_operacao
         WHERE ativo = 1 AND usarEmPedido = 1 AND movimentaEstoque = 1 ORDER BY id LIMIT 1`).get();
  if (!natureza) {
    throw new Error('o banco de prova nasceu sem natureza de operação — '
      + 'o seed do tipos-operacao-routes não rodou, e sem ele nenhum caso deste '
      + 'arquivo mede o que promete');
  }
  db.prepare('UPDATE loja_config SET tipoOperacaoPedidoId = ? WHERE id = 1').run(natureza.id);

  return db;
}

/** App falso que registra as rotas REAIS — as mesmas que o servidor usa. */
function montarApp(db) {
  const rotas = new Map();
  const reg = (m) => (url, ...fns) => rotas.set(m + ' ' + url, fns[fns.length - 1]);
  const app = {
    get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'), use() {},
    chamar(m, url, body) {
      const fn = rotas.get(m + ' ' + url);
      if (!fn) throw new Error('rota não registrada: ' + m + ' ' + url);
      let saida = null, status = 200;
      const res = { json: (d) => { saida = d; return res; },
                    status: (s) => { status = s; return res; },
                    setHeader() { return res; }, end() { return res; } };
      fn({ body: body || {}, query: {}, params: (body && body.__params) || {},
           session: {}, protocol: 'https', get: () => 'loja.local' }, res);
      return { status, body: saida };
    },
  };
  require('../reservas-routes').registrarRotasReservas(app, db);
  require('../pedidos-routes').registrarRotasPedidos(app, db);
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  return app;
}

const FINALIZAR = '/loja/api/pedido/finalizar';
const pedido = (extra) => ({
  idempotencyKey: crypto.randomUUID(),
  cliente: { nome: 'MARIA DA SILVA', telefone: '44999887766' },
  atendimento: 'retirada', pagamento: 'pix',
  itens: [{ produtoId: 1, quantidade: 2 }],
  ...extra,
});
const contar = (db) => ({
  pedidos: db.prepare('SELECT COUNT(*) c FROM pedidos').get().c,
  itens: db.prepare('SELECT COUNT(*) c FROM pedido_itens').get().c,
  pessoas: db.prepare('SELECT COUNT(*) c FROM pessoas').get().c,
  reservas: db.prepare('SELECT COUNT(*) c FROM reservas_estoque').get().c,
});

// ============================================================================
// A. O pedido entra no fluxo NORMAL
// ============================================================================

t('A1. o pedido nasce em `pedidos`, com origem catalogo e confirmado', () => {
  const db = montar('a1'); const app = montarApp(db);
  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 200, 'não finalizou: ' + JSON.stringify(r.body));

  const p = db.prepare('SELECT * FROM pedidos ORDER BY id DESC LIMIT 1').get();
  /* `tipo = 'catalogo'` é o vocabulário que `pedido-politicas.js` já tinha
     previsto, e NÃO está em `ORIGENS_CLIENTE` — justamente para que a
     procedência não possa vir do corpo. */
  assert(p.tipo === 'catalogo', `tipo gravado: ${p.tipo}`);
  assert(p.status === 'confirmado', `status: ${p.status}`);
  assert(p.modoDocumento === 'pedido', `modoDocumento: ${p.modoDocumento}`);
  assert(/^PED-/.test(p.numero), `numeração fora do padrão: ${p.numero}`);
  assert(p.tipoAtendimento === 'retirada', `atendimento: ${p.tipoAtendimento}`);
  assert(p.meioPagamento === '17', `meio de pagamento: ${p.meioPagamento}`);
  assert(p.clienteId, 'pedido sem cliente');

  const itens = db.prepare('SELECT * FROM pedido_itens WHERE pedidoId = ?').all(p.id);
  assert(itens.length === 1, `${itens.length} itens`);
  assert(itens[0].precoUnitario === 100, `preço do servidor: ${itens[0].precoUnitario}`);
  assert(Number(p.valorTotal) === 200, `total: ${p.valorTotal}`);
  // Reserva pelo caminho canônico: quem a cria é a confirmação.
  assert(db.prepare("SELECT COUNT(*) c FROM reservas_estoque WHERE status='ativa'").get().c === 1,
    'a confirmação não reservou estoque');
});

t('A2. NENHUMA tabela paralela de pedido é criada', () => {
  const db = montar('a2'); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, pedido());
  const proibidas = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND (name LIKE 'loja_pedido%' OR name LIKE 'catalogo_pedido%' OR name='rest_comandas')`)
    .all().map((x) => x.name);
  /* `rest_comandas` pode existir no schema do tenant (é do módulo restaurante);
     o que não pode é o checkout ESCREVER nela. */
  const comanda = proibidas.includes('rest_comandas')
    ? db.prepare('SELECT COUNT(*) c FROM rest_comandas').get().c : 0;
  assert(!proibidas.some((n) => /^(loja|catalogo)_pedido/.test(n)),
    'tabela paralela de pedidos: ' + proibidas.join(', '));
  assert(comanda === 0, 'o checkout escreveu em rest_comandas');
});

t('A3. a origem NÃO pode ser forjada pelo corpo', () => {
  const db = montar('a3'); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, pedido({ origem: 'manual', tipo: 'pdv', origemLoja: 0 }));
  const p = db.prepare('SELECT tipo FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(p.tipo === 'catalogo', `o corpo conseguiu mudar a origem para ${p.tipo}`);
});

// ============================================================================
// B. Autoridade do servidor
// ============================================================================

t('B1. preço vem do cadastro, não do corpo', () => {
  const db = montar('b1'); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, pedido({
    itens: [{ produtoId: 1, quantidade: 1, precoUnitario: 1, preco: 1, total: 1 }],
    subtotal: 1, total: 1, valorTotal: 1,
  }));
  const i = db.prepare('SELECT * FROM pedido_itens ORDER BY id DESC LIMIT 1').get();
  const p = db.prepare('SELECT valorTotal FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(i.precoUnitario === 100, `o corpo ditou o preço: ${i.precoUnitario}`);
  assert(Number(p.valorTotal) === 100, `o corpo ditou o total: ${p.valorTotal}`);
});

t('B2. produto despublicado ou de fora não entra', () => {
  const db = montar('b2'); const app = montarApp(db);
  db.prepare('UPDATE produtos SET publicadoNaLoja = 0 WHERE id = 1').run();
  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 409, `status: ${r.status}`);
  assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 0, 'criou pedido mesmo assim');
});

t('B3. frete é do servidor, e o corpo não o escolhe', () => {
  const db = montar('b3'); const app = montarApp(db);
  const r = app.chamar('POST', FINALIZAR, pedido({
    atendimento: 'entrega', itens: [{ produtoId: 1, quantidade: 1 }],
    valorFrete: 0, frete: 0,     // tentativa de zerar o frete
    endereco: { logradouro: 'RUA A', numero: '10', bairro: 'CENTRO',
                cidade: 'MARABA', uf: 'PA', cep: '68500000' },
  }));
  assert(r.status === 200, 'não finalizou: ' + JSON.stringify(r.body));
  const p = db.prepare('SELECT valorFrete, valorTotal, bairroEntrega FROM pedidos ORDER BY id DESC LIMIT 1').get();
  assert(Number(p.valorFrete) === 7.5, `frete gravado: ${p.valorFrete} (a taxa do bairro é 7,50)`);
  assert(p.bairroEntrega === 'CENTRO', `bairro: ${p.bairroEntrega}`);
});

t('B4. bairro fora da cobertura é recusado — sem inventar preço', () => {
  for (const aceitaFora of [0, 1]) {
    const db = montar('b4' + aceitaFora, { aceitaFora }); const app = montarApp(db);
    const r = app.chamar('POST', FINALIZAR, pedido({
      atendimento: 'entrega', itens: [{ produtoId: 1, quantidade: 1 }],
      endereco: { logradouro: 'RUA B', numero: '20', bairro: 'NAO CADASTRADO',
                  cidade: 'MARABA', uf: 'PA', cep: '68500000' },
    }));
    /* Mesmo com `aceitaForaCobertura`, a configuração não diz QUANTO cobrar de
       quem está fora. Arbitrar 0 daria entrega grátis a quem mora longe. */
    assert(r.status === 422, `aceitaFora=${aceitaFora}: status ${r.status}`);
    assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 0,
      `aceitaFora=${aceitaFora}: criou pedido sem saber o frete`);
  }
});

// ============================================================================
// C. Atomicidade — falhou, não sobra nada
// ============================================================================

t('C1. estoque insuficiente: nem pessoa, nem pedido, nem item, nem reserva', () => {
  const db = montar('c1', { estoque: 1 }); const app = montarApp(db);
  const antes = contar(db);
  const r = app.chamar('POST', FINALIZAR, pedido({ itens: [{ produtoId: 1, quantidade: 99 }] }));
  const depois = contar(db);
  assert(r.status === 409, `status: ${r.status}`);
  /* O rollback precisa alcançar a PESSOA: ela é criada no começo da mesma
     transação, e um cadastro órfão por tentativa fracassada encheria a base
     de gente que nunca comprou. */
  assert(JSON.stringify(antes) === JSON.stringify(depois),
    `sobrou lixo: antes ${JSON.stringify(antes)} depois ${JSON.stringify(depois)}`);
});

t('C2. a mensagem de estoque diz o que revisar, sem vazar interno', () => {
  const db = montar('c2', { estoque: 1 }); const app = montarApp(db);
  const r = app.chamar('POST', FINALIZAR, pedido({ itens: [{ produtoId: 1, quantidade: 99 }] }));
  const msg = r.body.error || '';
  assert(/quantidade|disponív/i.test(msg), 'mensagem não explica o problema: ' + msg);
  assert(!/SQLITE|SELECT|INSERT|constraint|pedidos\.|undefined/i.test(msg),
    'a mensagem vaza detalhe interno: ' + msg);
});

// ============================================================================
// D. Idempotência
// ============================================================================

t('D1. mesma chave e mesma intenção devolvem o MESMO pedido', () => {
  const db = montar('d1'); const app = montarApp(db);
  const corpo = pedido();
  const a = app.chamar('POST', FINALIZAR, corpo);
  const b = app.chamar('POST', FINALIZAR, corpo);
  assert(a.status === 200 && b.status === 200, `status: ${a.status} e ${b.status}`);
  assert(a.body.numero === b.body.numero, `números diferentes: ${a.body.numero} e ${b.body.numero}`);
  assert(b.body.repetido === true, 'a segunda resposta não se declara repetida');
  assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 1, 'criou dois pedidos');
  assert(db.prepare('SELECT COUNT(*) c FROM reservas_estoque').get().c === 1, 'reservou duas vezes');
});

t('D2. mesma chave com OUTRA intenção é 409, e não devolve o pedido antigo', () => {
  const db = montar('d2'); const app = montarApp(db);
  const corpo = pedido();
  app.chamar('POST', FINALIZAR, corpo);
  /* Mesmo cliente, mesmo total, mesma contagem de itens — e produto diferente.
     Comparar só total e cliente deixaria passar. */
  const outro = { ...corpo, itens: [{ produtoId: 2, quantidade: 10 }] };
  const r = app.chamar('POST', FINALIZAR, outro);
  assert(r.status === 409, `status: ${r.status}`);
  assert(!r.body.numero, 'devolveu o pedido antigo como se fosse o novo');
  assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 1, 'criou um segundo pedido');
});

t('D3. a chave é exigida, e não vaza para o cliente', () => {
  const db = montar('d3'); const app = montarApp(db);
  const sem = app.chamar('POST', FINALIZAR, { ...pedido(), idempotencyKey: '' });
  assert(sem.status === 422, `sem chave: status ${sem.status}`);

  const r = app.chamar('POST', FINALIZAR, pedido());
  const corpo = JSON.stringify(r.body);
  assert(!/idempot/i.test(corpo), 'a chave aparece na resposta pública: ' + corpo);
});

t('D4. o UNIQUE do banco é a autoridade, não a consulta prévia', () => {
  const db = montar('d4');
  /* A consulta prévia serve ao retry comum. Sob concorrência ela não vale
     nada — entre o SELECT e o INSERT cabe a outra requisição —, e é a
     constraint que segura. Aqui se prova que ela existe e morde. */
  const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index'
    AND name='idx_pedidos_idempotencia'`).get();
  assert(idx, 'o índice de idempotência não existe');
  assert(/UNIQUE/i.test(idx.sql), 'o índice não é UNIQUE: ' + idx.sql);
  assert(/WHERE\s+idempotenciaChave\s+IS\s+NOT\s+NULL/i.test(idx.sql),
    'o índice não é parcial — pedidos internos com NULL colidiriam: ' + idx.sql);

  const app = montarApp(db);
  app.chamar('POST', FINALIZAR, { ...pedido(), idempotencyKey: 'chave-fixa-de-teste' });
  let barrou = false;
  try {
    db.prepare(`INSERT INTO pedidos (numero, tipo, status, dataPedido, idempotenciaChave)
      VALUES ('X-1','manual','rascunho','2026-09-20','chave-fixa-de-teste')`).run();
  } catch (e) { barrou = /UNIQUE/i.test(e.message); }
  assert(barrou, 'o banco aceitou a chave repetida');
});

// ============================================================================
// E. Cliente sem login
// ============================================================================

t('E1. sem documento: cadastro canônico com identificador interno', () => {
  const db = montar('e1'); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, pedido());
  const p = db.prepare(`SELECT pe.* FROM pessoas pe JOIN pedidos pd ON pd.clienteId = pe.id
    ORDER BY pd.id DESC LIMIT 1`).get();
  assert(p, 'não criou cliente');
  assert(Number(p.semDocumento) === 1, 'não marcou semDocumento');
  assert(/^SD-/.test(p.cpfCnpj), `identificador inesperado: ${p.cpfCnpj}`);
  /* É a função do módulo que já existia, e ela garante que o identificador
     nunca é lido como documento fiscal. */
  assert(require('../pessoa-sem-documento').documentoFiscalDe(p) === null,
    'o identificador interno está passando por documento fiscal');
  assert(p.razaoSocial === 'MARIA DA SILVA', `nome: ${p.razaoSocial}`);
  assert(p.telefone === '44999887766', `telefone: ${p.telefone}`);
});

t('E2. CPF válido reusa a pessoa', () => {
  const db = montar('e2'); const app = montarApp(db);
  const cpf = '52998224725';
  app.chamar('POST', FINALIZAR, pedido({ cliente: { nome: 'JOAO', telefone: '44988887777', cpfCnpj: cpf } }));
  const n1 = db.prepare('SELECT COUNT(*) c FROM pessoas').get().c;
  app.chamar('POST', FINALIZAR, pedido({ cliente: { nome: 'JOAO', telefone: '44988887777', cpfCnpj: cpf } }));
  assert(db.prepare('SELECT COUNT(*) c FROM pessoas').get().c === n1, 'criou pessoa duplicada para o mesmo CPF');
});

/* Este caso nasceu de uma sabotagem que PASSOU: trocar `documentoValido` por
   `soDigitos` não reprovava nada. O antigo E2 mandava `nome: 'X'` junto do CPF
   inválido, e o 422 que ele media vinha de 'Informe seu nome.', que é checado
   antes. Medir o status sozinho não prova qual regra recusou — daí a mensagem
   entrar na asserção. */
t('E2b. documento inválido é recusado PELO documento, e nada é gravado', () => {
  const db = montar('e2b'); const app = montarApp(db);
  const invalidos = [
    ['11111111111', 'CPF de dígitos repetidos'],
    ['52998224724', 'CPF com DV errado'],
    ['123456789', 'CPF curto'],
    ['11222333000180', 'CNPJ com DV errado'],
    ['00000000000000', 'CNPJ de dígitos repetidos'],
  ];
  for (const [doc, porque] of invalidos) {
    const r = app.chamar('POST', FINALIZAR, pedido({
      cliente: { nome: 'CLIENTE DE VERDADE', telefone: '44988887777', cpfCnpj: doc } }));
    assert(r.status === 422, `${porque} (${doc}) passou: status ${r.status}`);
    assert(/CPF\/CNPJ inválido/.test(r.body && r.body.error),
      `${porque} (${doc}) recusado por OUTRA regra: ${r.body && r.body.error}`);
  }
  const n = contar(db);
  assert(n.pedidos === 0 && n.pessoas === 0, `documento inválido deixou rastro: ${JSON.stringify(n)}`);

  /* A recusa não pode ser por rigor cego: CNPJ válido e CPF com pontuação
     precisam continuar entrando. */
  for (const bom of ['52998224725', '529.982.247-25', '11222333000181']) {
    const r = app.chamar('POST', FINALIZAR, pedido({
      cliente: { nome: 'CLIENTE DE VERDADE', telefone: '44988887777', cpfCnpj: bom } }));
    assert(r.status === 200, `documento válido ${bom} foi recusado: ${JSON.stringify(r.body)}`);
  }
});

t('E3. telefone igual NÃO une cadastros', () => {
  const db = montar('e3'); const app = montarApp(db);
  app.chamar('POST', FINALIZAR, pedido({ cliente: { nome: 'PESSOA UM', telefone: '44911112222' },
                                         itens: [{ produtoId: 1, quantidade: 1 }] }));
  app.chamar('POST', FINALIZAR, pedido({ cliente: { nome: 'PESSOA DOIS', telefone: '44911112222' },
                                         itens: [{ produtoId: 1, quantidade: 1 }] }));
  /* Dois clientes dividem um número com frequência — casal, empresa, recado.
     Unir por telefone misturaria o histórico de compra de gente diferente. */
  const n = db.prepare("SELECT COUNT(*) c FROM pessoas WHERE telefone = '44911112222'").get().c;
  assert(n === 2, `uniu cadastros por telefone: ${n} pessoa(s)`);
});

// ============================================================================
// F. Pagamento é INTENÇÃO nesta fase
// ============================================================================

t('F1. os três meios viram código SEFAZ, sem baixa financeira', () => {
  for (const [escolha, codigo] of [['pix', '17'], ['dinheiro', '01'], ['cartao', '03']]) {
    const db = montar('f1' + escolha); const app = montarApp(db);
    const r = app.chamar('POST', FINALIZAR, pedido({ pagamento: escolha,
      itens: [{ produtoId: 1, quantidade: 1 }] }));
    assert(r.status === 200, `${escolha}: ${JSON.stringify(r.body)}`);
    const p = db.prepare('SELECT * FROM pedidos ORDER BY id DESC LIMIT 1').get();
    assert(p.meioPagamento === codigo, `${escolha} gravou ${p.meioPagamento}`);
    /* Escolher como vai pagar não é ter pago. Conta a receber e baixa são de
       uma fase posterior, e criá-las aqui daria o pedido como quitado. */
    assert(!Number(p.valorPago), `${escolha}: marcou valorPago`);
    assert(db.prepare('SELECT COUNT(*) c FROM contas_a_receber').get().c === 0,
      `${escolha}: criou conta a receber`);
  }
});

t('F2. troco: validado contra o total e registrado em texto', () => {
  const db = montar('f2'); const app = montarApp(db);
  const curto = app.chamar('POST', FINALIZAR, pedido({ pagamento: 'dinheiro',
    precisaTroco: true, trocoPara: 10 }));
  assert(curto.status === 422, `troco menor que o total passou: ${curto.status}`);

  const r = app.chamar('POST', FINALIZAR, pedido({ pagamento: 'dinheiro',
    precisaTroco: true, trocoPara: 500 }));
  assert(r.status === 200, 'não finalizou: ' + JSON.stringify(r.body));
  const p = db.prepare('SELECT observacao FROM pedidos ORDER BY id DESC LIMIT 1').get();
  // Sem coluna nova: quem precisa da informação é quem entrega, e ele lê isto.
  assert(/Troco para/i.test(p.observacao), 'o troco não foi registrado: ' + p.observacao);
  assert(/Dinheiro/i.test(p.observacao), 'a forma de pagamento não aparece: ' + p.observacao);
});

// ============================================================================
// G. Personalizações
// ============================================================================

t('G1. a opção escolhida entra na descrição do item, pelo nome do servidor', () => {
  const db = montar('g1'); const app = montarApp(db);
  const gid = db.prepare(`INSERT INTO rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ativo)
    VALUES ('Brinde', 0, 1, 1)`).run().lastInsertRowid;
  const oid = db.prepare(`INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, ativo)
    VALUES (?, 'Caneca personalizada', 5, 1)`).run(gid).lastInsertRowid;
  db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId) VALUES (1, ?)').run(gid);

  const r = app.chamar('POST', FINALIZAR, pedido({
    // O nome vem do corpo ERRADO de propósito: quem manda é `rest_opcoes`.
    itens: [{ produtoId: 1, quantidade: 1, opcoes: [oid], nome: 'NOME FORJADO' }],
  }));
  assert(r.status === 200, 'não finalizou: ' + JSON.stringify(r.body));
  const i = db.prepare('SELECT * FROM pedido_itens ORDER BY id DESC LIMIT 1').get();
  assert(/Caneca personalizada/.test(i.descricao), `descrição: ${i.descricao}`);
  assert(!/FORJADO/.test(i.descricao), 'o texto do corpo entrou na descrição: ' + i.descricao);
  assert(i.precoUnitario === 105, `o adicional não entrou no preço: ${i.precoUnitario}`);
  /* A descrição do PRODUTO não muda: o que foi personalizado é aquele item
     daquele pedido. */
  assert(db.prepare('SELECT descricao FROM produtos WHERE id = 1').get().descricao === 'CESTA CAFE DA MANHA',
    'a descrição canônica do produto foi alterada');
});

t('G2. opção que não pertence ao produto é recusada', () => {
  const db = montar('g2'); const app = montarApp(db);
  const gid = db.prepare(`INSERT INTO rest_grupos_opcao (nome, minEscolhas, maxEscolhas, ativo)
    VALUES ('Brinde', 0, 1, 1)`).run().lastInsertRowid;
  const oid = db.prepare(`INSERT INTO rest_opcoes (grupoId, nome, precoAdicional, ativo)
    VALUES (?, 'Só da CANECA', 5, 1)`).run(gid).lastInsertRowid;
  db.prepare('INSERT INTO rest_produto_grupos (produtoId, grupoId) VALUES (2, ?)').run(gid);

  const r = app.chamar('POST', FINALIZAR, pedido({ itens: [{ produtoId: 1, quantidade: 1, opcoes: [oid] }] }));
  assert(r.status === 422, `opção de outro produto foi aceita: ${r.status}`);
  assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 0, 'criou pedido mesmo assim');
});

// ============================================================================
// H. Entrada e serviços
// ============================================================================

t('H1. campos obrigatórios e vocabulários fechados', () => {
  const db = montar('h1'); const app = montarApp(db);
  const casos = [
    ['sem nome', pedido({ cliente: { nome: '', telefone: '44999887766' } })],
    ['telefone curto', pedido({ cliente: { nome: 'ANA', telefone: '123' } })],
    ['atendimento inválido', pedido({ atendimento: 'teletransporte' })],
    ['pagamento inválido', pedido({ pagamento: 'bitcoin' })],
    ['sacola vazia', pedido({ itens: [] })],
    ['entrega sem endereço', pedido({ atendimento: 'entrega' })],
  ];
  for (const [nome, corpo] of casos) {
    const r = app.chamar('POST', FINALIZAR, corpo);
    assert(r.status === 422, `${nome}: status ${r.status}`);
    assert(r.body.error && !/SQLITE|undefined|null/i.test(r.body.error),
      `${nome}: mensagem ruim "${r.body.error}"`);
  }
  assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 0, 'algum inválido criou pedido');
});

t('H2. serviço desligado na configuração recusa o pedido', () => {
  const semRetirada = montar('h2a', { retirada: 0 });
  assert(montarApp(semRetirada).chamar('POST', FINALIZAR, pedido()).status === 422,
    'aceitou retirada com o serviço desligado');

  const semEntrega = montar('h2b', { delivery: 0 });
  const r = montarApp(semEntrega).chamar('POST', FINALIZAR, pedido({
    atendimento: 'entrega', endereco: { logradouro: 'R', numero: '1', bairro: 'CENTRO',
                                        cidade: 'C', uf: 'PA', cep: '68500000' } }));
  assert(r.status === 422, 'aceitou entrega com o delivery desligado');
});

t('H3. catálogo despublicado não recebe pedido', () => {
  const db = montar('h3', { ativa: 0 }); const app = montarApp(db);
  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 404, `status: ${r.status}`);
  assert(db.prepare('SELECT COUNT(*) c FROM pedidos').get().c === 0, 'criou pedido em loja fechada');
});

t('H4. carrinho gigante é recusado', () => {
  const db = montar('h4'); const app = montarApp(db);
  const muitos = Array.from({ length: 300 }, () => ({ produtoId: 1, quantidade: 1 }));
  const r = app.chamar('POST', FINALIZAR, pedido({ itens: muitos }));
  assert(r.status === 422, `status: ${r.status}`);
});

/* Segunda sabotagem que PASSOU: trocar a mensagem genérica do 500 por
   `e.message` não reprovava nada, porque nenhum caso forçava erro INESPERADO —
   os outros exercitam recusas previstas, que nunca chegam ao `catch`.
   O gatilho quebra a inserção do item DEPOIS de o cabeçalho existir, que é o
   pior instante: prova a mensagem e o rollback no mesmo caso. */
t('H5. erro interno não vaza detalhe e não deixa pedido pela metade', () => {
  const db = montar('h5'); const app = montarApp(db);
  db.exec(`CREATE TRIGGER quebra_item BEFORE INSERT ON pedido_itens BEGIN
    SELECT RAISE(ABORT, 'DETALHE-INTERNO: pedido_itens.precoUnitario'); END`);

  const r = app.chamar('POST', FINALIZAR, pedido());
  assert(r.status === 500, `status: ${r.status}`);

  const msg = String((r.body && r.body.error) || '');
  for (const vazamento of ['DETALHE-INTERNO', 'pedido_itens', 'precoUnitario', 'SQLITE', 'RAISE']) {
    assert(!msg.includes(vazamento), `o erro interno vazou "${vazamento}": ${msg}`);
  }
  assert(msg === 'Não conseguimos concluir seu pedido agora. Tente de novo em instantes.',
    `mensagem inesperada no 500: ${msg}`);

  const n = contar(db);
  assert(n.pedidos === 0 && n.itens === 0 && n.pessoas === 0 && n.reservas === 0,
    `erro inesperado deixou rastro: ${JSON.stringify(n)}`);
});

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
