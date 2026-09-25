/**
 * pedidos-routes.js — Gestão de pedidos (manual + importado de licitação).
 * Depende das tabelas criadas por produtos-routes.js (pedidos, pedido_itens,
 * movimentacoes_estoque, produtos) e das existentes pessoas, participacoes_comprasnet, itens.
 *
 * Uso no server.js:
 *   const { registrarRotasPedidos } = require('./pedidos-routes');
 *   registrarRotasPedidos(app, db);
 */

const crypto = require('crypto');
const pedidoPdf = require('./pedido-pdf');
const separacaoPdf = require('./separacao-pdf');
const { logAction } = require('./audit-log');
const axios = require('axios');
const { criarReservasPedido, cancelarReservasPedido, consumirReservasPedido } = require('./reservas-routes');
const { sugerirCFOP } = require('./tipos-operacao-routes');
// Depósito da movimentação: sem isto a saída da venda ia com NULL e caía
// sempre no padrão, independente de onde a mercadoria estava.
const { resolverDeposito } = require('./estoque-routes');
// Venda perdida a partir do pedido — dependência unidirecional
// (precos-routes nao requer pedidos-routes, entao nao ha ciclo).
const { registrarPerdasDePedido, estornarPerdasDePedido } = require('./precos-routes');
const { erroMeioPermitido, assertMeioPermitido } = require('./meios-pagamento');
// Quem manda no preço e de quem é o pedido — decisões que dependem do ator, e
// que antes viviam implícitas no frontend (ver pedido-politicas.js).
const politicas = require('./pedido-politicas');
// Desconto comercial com alçada, e como o cliente recebe a mercadoria (Fase 1).
// O desconto tem um único ponto de escrita — `aplicarDescontoNoPedido` — e as
// colunas dele NÃO entram em CAMPOS_PEDIDO de propósito: um segundo caminho de
// gravação seria um desconto sem alçada.
const descontos = require('./pedido-desconto');
const atendimento = require('./pedido-atendimento');
// Fase 3e (2026-05-23): orgaos_lookup no PG
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

const UASG_LOOKUP_URL = 'https://dadosabertos.compras.gov.br/modulo-uasg/1_consultarUasg';

const STATUS_VALIDOS = ['rascunho', 'confirmado', 'em_separacao', 'entregue', 'faturado', 'cancelado'];
const STATUS_PAGAMENTO = ['pendente', 'parcial', 'pago'];

/**
 * Condição de pagamento válida para o pedido. A política vinculada ao cliente
 * é obrigatória: se existe, é ela e nenhuma outra. Espelha resolverPolitica()
 * de os-routes — as duas telas seguem a mesma regra.
 */
function resolverPoliticaPedido(db, clienteId, politicaPrazoId) {
  const { politicaDaPessoa, valePara } = require('./politicas-prazo');
  const daPessoa = clienteId ? politicaDaPessoa(db, clienteId) : null;
  const obrigatoria = daPessoa && valePara(daPessoa, 'vendas') ? daPessoa : null;
  if (!politicaPrazoId) return { politica: obrigatoria, erro: null };

  const escolhida = db.prepare('SELECT * FROM politicas_prazo WHERE id = ? AND ativo = 1').get(Number(politicaPrazoId));
  if (!escolhida) return { politica: null, erro: 'Condição de pagamento inválida ou inativa' };
  if (!escolhida.aplicaVendas) return { politica: null, erro: `Condição "${escolhida.nome}" não se aplica a vendas` };
  if (obrigatoria && obrigatoria.id !== escolhida.id) {
    return { politica: null, erro: `Cliente tem condição obrigatória "${obrigatoria.nome}" — não é possível usar outra` };
  }
  return { politica: escolhida, erro: null };
}

/** Meios aceitos por uma política; null = sem restrição. */
function meiosDaPoliticaPedido(politica) {
  if (!politica || !politica.meiosPermitidos) return null;
  try {
    const l = JSON.parse(politica.meiosPermitidos);
    return Array.isArray(l) && l.length ? l : null;
  } catch { return null; }
}

// Campos do cabeçalho do pedido que podem ser atualizados via PUT
const CAMPOS_PEDIDO = [
  'clienteId', 'dataEntregaPrevista', 'dataValidade', 'dataFaturamentoPrevista',
  'codigoPedidoCliente', 'transportadoraId', 'tipoFrete', 'valorFrete',
  'meioPagamento', 'observacao', 'observacoesInterna',
  // vendedorId existia na tabela desde comissoes-routes, mas nunca era
  // gravado por nenhum caminho — metas e comissões liam sempre NULL.
  'vendedorId',
  // De qual depósito a mercadoria sai. Sem isto toda venda debitava o padrão.
  'depositoId',
  'tipoOperacaoId', 'naoEmitirNFe', 'tabelaPrecoId',
  // Condição de pagamento (politicas_prazo) — define prazo e meios aceitos.
  'politicaPrazoId',
  // Endereço de entrega (override do cadastro do cliente)
  'enderecoEntrega', 'numeroEntrega', 'complementoEntrega', 'bairroEntrega',
  'cidadeEntrega', 'ufEntrega', 'cepEntrega', 'codigoMunicipioEntrega',
  'contatoEntrega', 'telefoneEntrega',
  // Como o cliente recebe (Fase 1). O vocabulário é conferido ANTES, no PUT;
  // aqui o campo só é gravado. As colunas de desconto NÃO entram nesta lista de
  // propósito — elas têm porta própria, com alçada (`aplicarDesconto`), e
  // deixá-las passar por aqui seria um desconto sem aprovação.
  'tipoAtendimento'
];

const MODOS_DOCUMENTO = ['pedido', 'orcamento'];

// Multi-tenant (2026-04-22): migrarPedidos() e seus ALTERs/seeds
// migraram para db-schema.js. Roda no provisionamento de cada tenant.

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function gerarNumero(db, modo = 'pedido') {
  const ano = new Date().getFullYear();
  const prefixo = `${modo === 'orcamento' ? 'ORC' : 'PED'}-${ano}-`;
  const row = db.prepare(`SELECT numero FROM pedidos WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefixo + '%');
  let seq = 1;
  if (row) {
    const n = parseInt(row.numero.slice(prefixo.length), 10);
    if (!isNaN(n)) seq = n + 1;
  }
  return `${prefixo}${String(seq).padStart(5, '0')}`;
}

/**
 * Frete nunca é negativo.
 *
 * `valorFrete` compõe o total (recalcularTotal, logo abaixo) e é gravável pelo
 * PUT do pedido. Negativo, ele vira desconto sem alçada e sem registro — o
 * bypass que sobrou depois que a política de preço fechou o `precoUnitario`
 * para o vendedor restrito (2026-09-10).
 *
 * A invariável vale para TODO ator, não só para o restrito: em 2026-09-10
 * contei `valorFrete < 0` nos 13 tenants e o resultado foi zero em todos —
 * nenhum fluxo legítimo depende disso. Benefício comercial é desconto, e
 * desconto ainda não existe no pedido (ver 06-fase-0-frete-pagamento.md).
 *
 * @returns {string|null} mensagem de erro, ou null quando o valor é aceitável.
 */
function erroValorFrete(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n)) return 'valorFrete invalido';
  if (n < 0) return 'valorFrete nao pode ser negativo — frete nao e desconto';
  return null;
}

/**
 * Teto de quantidade por item.
 *
 * Escolhido a partir do dado real, não de gosto (auditoria de 2026-09-10,
 * relatório 08):
 *   - a maior quantidade em `pedido_itens` nos 13 tenants é 240;
 *   - o catálogo de licitações do PNCP — o domínio central deste ERP — tem
 *     itens de até 129.157.600 unidades numa amostra de 0,5%, e ~151 acima de
 *     1 milhão nessa mesma amostra. Um teto de 1e6 recusaria venda legítima;
 *   - com o maior preço cadastrado hoje (R$ 43.500), 1e9 × preço = 4,35e13,
 *     que ainda cabe na faixa de centavos exatos do double (~9,0e13).
 *
 * 1e9 é ~7,7× a maior quantidade observada no domínio e continua muito longe
 * de `Number.MAX_SAFE_INTEGER`. Barra o 1e308 que passava, sem estorvar
 * atacado, peso ou volume: 1e9 kg é um milhão de toneladas.
 */
const QUANTIDADE_MAXIMA = 1e9;

/**
 * Casas decimais aceitas na quantidade.
 *
 * Não é número novo: é o que a emissão fiscal já pratica. `qCom` e `qTrib`
 * saem com `toFixed(4)` na NF-e (`nfe-emit-routes.js:623`) e na NFC-e
 * (`nfce-routes.js:428`) — o padrão SEFAZ. Aceitar mais casas no pedido faria
 * a nota arredondar em silêncio e divergir do documento que a originou.
 */
const QUANTIDADE_CASAS_DECIMAIS = 4;

/**
 * Unidades que não admitem fração.
 *
 * O ERP **não tem** flag de fracionável: `produtos.unidade` é TEXT livre e não
 * existe tabela de unidades (auditado em 2026-09-10). Então a regra é por
 * código, e o desenho é deliberadamente **conservador**: só recusa fração para
 * unidade que está NESTA lista. Unidade desconhecida, vazia ou ambígua
 * **aceita** decimal.
 *
 * O inverso — exigir que a unidade esteja numa lista de fracionáveis — quebraria
 * venda legítima por causa de cadastro sujo, e há cadastro sujo: entre as
 * unidades em produção aparecem 'MES' (12 produtos) e valores numéricos soltos
 * ('2', '6', '8'…), restos de importação com coluna trocada.
 *
 * A lista sai das unidades realmente usadas (UN 220, PC 8, CX 1, KIT 1) mais as
 * variantes ortográficas e as universalmente discretas. Fora dela de propósito:
 * 'MES' (pro-rata de meio mês existe), 'RL'/'FD' (menos óbvias) e KG/G/L/ML/
 * M/M2/M3, que são fracionáveis por natureza.
 *
 * Comparação normalizada: maiúsculas, sem acento e sem pontuação — 'pç', 'PÇ'
 * e 'pc.' caem todas em 'PC'.
 */
const UNIDADES_INTEIRAS = new Set([
  'UN', 'UND', 'UNID', 'UNIDADE', 'UNIDADES',
  'PC', 'PCS', 'PECA', 'PECAS',
  'CX', 'CAIXA', 'CAIXAS',
  'KIT', 'KITS',
  'PCT', 'PACOTE',
  'PAR', 'PARES',
  'DZ', 'DUZIA',
  'JG', 'JOGO',
  'RESMA',
]);

function unidadeAceitaFracao(unidade) {
  if (unidade == null) return true;
  const u = String(unidade).trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // PÇ -> PC
    .replace(/[^A-Z0-9]/g, '');
  if (!u) return true;                                   // vazia: não restringe
  return !UNIDADES_INTEIRAS.has(u);
}

/**
 * Quantidade de item de pedido é sempre um número finito MAIOR que zero.
 *
 * A validação anterior era `if (!descricao || !quantidade)`, e `-1` é truthy:
 * passava. Reproduzido em 2026-09-10 com um vendedor restrito — 2 × R$ 100
 * mais um item de −1 × R$ 100 deixava o pedido em R$ 100. O preço unitário era
 * o oficial, resolvido pelo servidor, então a trava de preço não alcançava:
 * o que estava adulterado era a quantidade.
 *
 * O estrago passava do total. `criarReservasPedido` ignora quantidade não
 * positiva (`reservas-routes.js:154`), então o item negativo não gera reserva —
 * e é justamente por isso que ele caía no fallback da entrega
 * (`/api/pedidos/:id/entregar`), que grava movimentação de saída com a
 * quantidade crua. Saída de −1 conta como −(−1) no saldo: estoque inflado.
 *
 * Recusa, não conserta: nada de `Math.abs`, nada de virar 1. Não existe
 * quantidade não positiva legítima — contei em 2026-09-10 nos 13 tenants,
 * 0 de 542 itens. Devolução tem fluxo próprio (`devolucoes-routes.js`) e não
 * grava em `pedido_itens`.
 *
 * Quatro recusas, nesta ordem — da mais grosseira para a mais específica:
 *   1. ausente / não numérica / não finita;
 *   2. zero ou negativa;
 *   3. acima de QUANTIDADE_MAXIMA (1e308 passava por ser finito);
 *   4. mais casas decimais do que a nota fiscal comporta;
 *   5. fracionada em unidade que não admite fração — só quando a unidade do
 *      produto é conhecida E está em UNIDADES_INTEIRAS.
 *
 * Nada é truncado nem arredondado: o valor fora da regra é recusado, e quem
 * enviou fica sabendo o porquê.
 *
 * `unidade` é opcional. Item avulso (sem `produtoId`) não tem unidade a
 * consultar e por isso não sofre a regra 5 — as outras quatro valem para ele
 * igual. Ver relatório 08.
 *
 * @param {*} valor    quantidade enviada
 * @param {string} [unidade]  `produtos.unidade` do item, quando há produto
 * @returns {string|null} mensagem de erro, ou null quando a quantidade serve.
 */
function erroQuantidade(valor, unidade) {
  if (valor === undefined || valor === null || valor === '') {
    return 'quantidade obrigatoria';
  }
  const n = Number(valor);
  if (!Number.isFinite(n)) return 'quantidade invalida';
  if (n <= 0) return 'quantidade deve ser maior que zero';
  if (n > QUANTIDADE_MAXIMA) {
    return `quantidade acima do maximo permitido (${QUANTIDADE_MAXIMA.toLocaleString('pt-BR')})`;
  }
  // Comparar com o próprio arredondamento pega também a notação exponencial
  // (1e-7 vira "1e-7", e contar casas por split('.') diria zero).
  if (Number(n.toFixed(QUANTIDADE_CASAS_DECIMAIS)) !== n) {
    return `quantidade com mais de ${QUANTIDADE_CASAS_DECIMAIS} casas decimais`;
  }
  if (!Number.isInteger(n) && !unidadeAceitaFracao(unidade)) {
    return `unidade "${String(unidade).trim()}" nao aceita quantidade fracionada`;
  }
  return null;
}

/**
 * Total do pedido, com a fórmula em UM lugar só:
 *
 *     subtotal dos itens − desconto + frete
 *
 * A conta mora em `pedido-desconto.totalDoPedido`, compartilhada com quem mais
 * precisar dela; aqui ficam apenas as leituras. Antes da Fase 1 o desconto não
 * existia e a fórmula era itens + frete — com `descontoAplicado = 0`, que é o
 * estado de todo pedido histórico, o resultado é idêntico ao de antes.
 *
 * Duas guardas que não são decoração:
 *   - o frete entra com piso zero. A recusa acontece na entrada (`erroValorFrete`
 *     no PUT), mas se um negativo chegar ao banco por um caminho que ainda não
 *     existe, ele não pode reduzir o total por baixo do pano;
 *   - o desconto percentual é reprecificado antes de somar. Sem isso, "10% de
 *     R$ 1.000" continuaria valendo R$ 100 depois de o pedido encolher para
 *     R$ 200 — metade do pedido, sem passar por alçada.
 */
function recalcularTotal(db, pedidoId) {
  const row = db.prepare('SELECT COALESCE(SUM(valorTotal), 0) AS total FROM pedido_itens WHERE pedidoId = ?').get(pedidoId);
  const ped = db.prepare('SELECT valorFrete FROM pedidos WHERE id = ?').get(pedidoId);
  const desconto = descontos.reprecificarDesconto(db, pedidoId, row.total);
  const total = descontos.totalDoPedido({
    subtotalItens: row.total,
    desconto,
    frete: Number(ped && ped.valorFrete) || 0,
  });
  db.prepare('UPDATE pedidos SET valorTotal = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(total, pedidoId);
  return total;
}

function atualizarStatusPagamento(db, pedidoId) {
  const p = db.prepare('SELECT valorTotal, valorPago FROM pedidos WHERE id = ?').get(pedidoId);
  if (!p) return;
  let status = 'pendente';
  if ((p.valorPago || 0) >= (p.valorTotal || 0) && (p.valorTotal || 0) > 0) status = 'pago';
  else if ((p.valorPago || 0) > 0) status = 'parcial';
  db.prepare('UPDATE pedidos SET statusPagamento = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(status, pedidoId);
}

/**
 * Carrega o pedido inteiro, por id OU por token público.
 *
 * O `opts.token` existe para a leitura pública (`/api/orcamento-publico/:token`)
 * poder usar EXATAMENTE a mesma consulta — mesmos joins, mesmos itens, mesma
 * ordem. Duplicar a query para o caminho público seria criar dois lugares onde
 * o orçamento é montado, e mais cedo ou mais tarde eles divergiriam.
 *
 * Quem decide o que o cliente enxerga é o CHAMADOR, que monta o recorte. Esta
 * função continua devolvendo tudo.
 */
function carregarPedidoCompleto(db, pedidoId, opts) {
  const pedido = db.prepare(`
    SELECT p.*,
      pe.razaoSocial AS clienteNome, pe.cpfCnpj AS clienteCpfCnpj, pe.tipo AS clienteTipo,
      pe.nomeFantasia AS clienteNomeFantasia, pe.email AS clienteEmail, pe.telefone AS clienteTelefone,
      pe.endereco AS clienteEndereco, pe.numero AS clienteNumero, pe.complemento AS clienteComplemento,
      pe.bairro AS clienteBairro, pe.cidade AS clienteCidade, pe.uf AS clienteUf,
      pe.cep AS clienteCep, pe.codigoMunicipio AS clienteCodigoMunicipio,
      pc.objeto AS participacaoObjeto, pc.orgao AS participacaoOrgao,
      t.razaoSocial AS transportadoraNome, t.cpfCnpj AS transportadoraCpfCnpj,
      COALESCE(u.nome, u.username) AS vendedorNome
    FROM pedidos p
    LEFT JOIN pessoas pe ON pe.id = p.clienteId
    LEFT JOIN participacoes_comprasnet pc ON pc.id = p.participacaoId
    LEFT JOIN transportadoras t ON t.id = p.transportadoraId
    LEFT JOIN users u ON u.id = p.vendedorId
    WHERE ${opts && opts.token ? 'p.tokenPublico = ?' : 'p.id = ?'}`)
    .get(opts && opts.token ? opts.token : pedidoId);
  if (!pedido) return null;
  const itens = db.prepare(`
    SELECT pi.*, pr.sku, pr.unidade
    FROM pedido_itens pi
    LEFT JOIN produtos pr ON pr.id = pi.produtoId
    WHERE pi.pedidoId = ? ORDER BY pi.id ASC`).all(pedido.id);
  return { ...pedido, itens };
}

/*
 * A confirmação canônica, alcançável de fora.
 *
 * `confirmarPedidoInterno` vive dentro de `registrarRotasPedidos` porque
 * precisa do `db` do escopo — que em multi-tenant é o PROXY, resolvido por
 * requisição. O checkout público do Catálogo Online precisa confirmar pelo
 * mesmo caminho que o ERP usa, e a alternativa seria repetir as validações
 * (rascunho, cliente, itens, atendimento, alçada, estoque) numa segunda
 * versão que divergiria na primeira correção.
 *
 * Isto NÃO é uma cópia nem uma variante: é a MESMA função, guardada numa
 * referência quando as rotas são registradas. O corpo dela não mudou.
 */
let _confirmarPedidoInterno = null;

function registrarRotasPedidos(app, db) {
  function registrarHistorico(pedidoId, statusAnterior, statusNovo, acao, motivo, usuario, dadosExtras) {
    db.prepare(`INSERT INTO pedido_historico (pedidoId, statusAnterior, statusNovo, acao, motivo, usuario, dadosExtras)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      pedidoId, statusAnterior || null, statusNovo || null, acao,
      motivo || null, usuario || null,
      dadosExtras ? JSON.stringify(dadosExtras) : null
    );
  }

  /**
   * CFOP de um item, pelo motor de tipo de operação. Único ponto fiscal do
   * módulo: os dois caminhos que criam item (POST /api/pedidos com itens[] e
   * POST /api/pedidos/:id/itens) passam por aqui, para não existirem duas
   * regras fiscais que divergem com o tempo. Falha de sugestão não derruba o
   * item — vira cfop NULL, como já era antes.
   */
  function cfopDoItem(pedido, produtoId) {
    try {
      const sug = sugerirCFOP(db, {
        tipoOperacaoId: pedido ? pedido.tipoOperacaoId : null,
        clienteId: (pedido && pedido.clienteId) || null,
        produtoId: produtoId || null,
        ufEntrega: (pedido && pedido.ufEntrega) || null,
      });
      return (sug && sug.cfop) || null;
    } catch (e) {
      console.warn('[pedidos] sugestão CFOP falhou:', e.message);
      return null;
    }
  }

  /**
   * Venda abaixo do preço sugerido deixa rastro. Não bloqueia (a política
   * padrão é 'auditar'), mas deixa de ser silenciosa — que era o problema.
   */
  // Unidade de medida do produto, para a regra de quantidade fracionada.
  // Devolve null para item avulso (sem produto) e para produto inexistente —
  // e `erroQuantidade` trata null como "não restringe".
  function unidadeDoProduto(produtoId) {
    if (!produtoId) return null;
    try {
      const p = db.prepare('SELECT unidade FROM produtos WHERE id = ?').get(Number(produtoId));
      return (p && p.unidade) || null;
    } catch { return null; }
  }

  function registrarDesconto(req, pedidoId, produtoId, p) {
    if (!p) return;
    // Preço mandado por quem não decide preço. Não é erro nem recusa — o
    // servidor usou o oficial e o corpo virou rastro de que houve tentativa.
    if (p.precoIgnorado != null) {
      logAction(db, req, 'preco-manual-ignorado', 'pedido', pedidoId, {
        produtoId, enviado: p.precoIgnorado, aplicado: p.preco, fonte: p.fonte, piso: p.piso,
      });
    }
    if (!p.desconto) return;
    logAction(db, req, 'preco-abaixo-do-sugerido', 'pedido', pedidoId, {
      produtoId, aplicado: p.preco, sugerido: p.sugerido, piso: p.piso,
      fonte: p.fonte, abaixoDoPiso: !!p.abaixoDoPiso,
    });
  }

  /**
   * Desconto do pedido — porta única, usada pelo POST e pelo PUT.
   *
   * A regra inteira vive em `pedido-desconto.aplicarDescontoNoPedido`; aqui só
   * ficam a chamada e o rastro em audit_log. Ter os dois chamadores passando
   * pela MESMA função é o que impede o desconto de nascer com uma regra na
   * criação e outra na edição.
   */
  function aplicarDesconto(req, pedidoId) {
    const r = descontos.aplicarDescontoNoPedido(db, { pedidoId, body: req.body, req });
    if (!r.ok) {
      logAction(db, req, 'desconto-recusado', 'pedido', Number(pedidoId),
        { erro: r.erro, alcada: r.alcada ? r.alcada.status : null });
      return r;
    }
    if (r.gravou) {
      logAction(db, req, 'desconto-aplicado', 'pedido', Number(pedidoId), {
        tipo: r.tipo, valor: r.valor, percentual: r.percentual, aplicado: r.aplicado,
        motivo: r.motivo || null,
        autoridade: r.alcada && r.alcada.autoridade ? r.alcada.autoridade : null,
        aprovacao: r.alcada && r.alcada.status === 'pendente' ? r.alcada.aprovacaoId : null,
      });
    }
    return r;
  }

  /** O que a resposta conta sobre o desconto, sem vazar detalhe interno. */
  function resumoDesconto(r) {
    const a = r.alcada || {};
    return {
      tipo: r.tipo, valor: r.valor, percentual: r.percentual, aplicado: r.aplicado,
      autoridade: a.autoridade || null,
      aguardandoAprovacao: a.status === 'pendente',
      aprovacaoId: a.status === 'pendente' ? a.aprovacaoId : undefined,
      papelExigido: a.regra ? a.regra.papelAprovador : undefined,
    };
  }

  // Estorna movimentações de saída do pedido (cria entradas compensatórias)
  function estornarEstoque(pedidoId, motivo) {
    const saidas = db.prepare(`SELECT * FROM movimentacoes_estoque
                               WHERE origem = 'pedido' AND origemId = ? AND tipo = 'saida'
                               AND id NOT IN (
                                 SELECT origemId FROM movimentacoes_estoque
                                 WHERE origem = 'estorno_pedido' AND origemId IS NOT NULL
                               )`).all(pedidoId);
    const estornadas = [];
    const hoje = dataBrasilia();
    for (const s of saidas) {
      // Estorno volta para o depósito de onde a mercadoria saiu.
      const r = db.prepare(`INSERT INTO movimentacoes_estoque
                             (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, depositoId)
                             VALUES (?, 'entrada', ?, ?, 'estorno_pedido', ?, ?, ?, ?)`)
        .run(s.produtoId, s.quantidade, s.custoUnitario, s.id,
             `Estorno do pedido ${pedidoId} — ${motivo || 'sem motivo'}`, hoje,
             resolverDeposito(db, { movOriginalId: s.id, pedidoId, produtoId: s.produtoId }));
      estornadas.push({ movOriginalId: s.id, movEstornoId: r.lastInsertRowid, produtoId: s.produtoId, quantidade: s.quantidade });
    }
    return estornadas;
  }

  // ==================== LISTAGEM ====================

  app.get('/api/pedidos', (req, res) => {
    try {
      const { status, tipo, modoDocumento, clienteId, statusPagamento, busca } = req.query;
      let sql = `SELECT p.*,
                   pe.razaoSocial AS clienteNome, pe.cpfCnpj AS clienteCpfCnpj,
                   f.numero AS faturaNumero, f.status AS faturaStatus,
                   cr.status AS contaReceberStatus, crx.valorPagoCR AS crValorPago,
                   cr.dataPagamento AS crDataPagamento,
                   tpo.codigo AS tipoOperacaoCodigo, tpo.descricao AS tipoOperacaoDescricao,
                   tpo.emiteNFe AS tipoOperacaoEmiteNFe, tpo.categoriaOperacao AS tipoOperacaoCategoria,
                   CASE
                     WHEN crx.faturaId IS NULL OR crx.valorTotalCR <= 0 THEN p.statusPagamento
                     WHEN crx.temAberta = 0 AND crx.valorPagoCR >= crx.valorTotalCR - 0.01 THEN 'pago'
                     WHEN crx.temVencida = 1 THEN 'vencida'
                     WHEN crx.valorPagoCR > 0 THEN 'parcial'
                     ELSE 'aberta'
                   END AS statusRecebimento
                 FROM pedidos p
                 LEFT JOIN pessoas pe ON pe.id = p.clienteId
                 LEFT JOIN faturas f ON f.id = p.faturaId
                 LEFT JOIN contas_a_receber cr ON cr.id = f.contaReceberId
                 LEFT JOIN (
                   SELECT faturaId,
                          SUM(CASE WHEN status != 'cancelada' THEN valor ELSE 0 END) AS valorTotalCR,
                          SUM(CASE WHEN status != 'cancelada' THEN COALESCE(valorPago, 0) ELSE 0 END) AS valorPagoCR,
                          MAX(CASE WHEN status IN ('aberta','parcial') THEN 1 ELSE 0 END) AS temAberta,
                          MAX(CASE WHEN status IN ('aberta','parcial') AND dataVencimento < date('now','-3 hours') THEN 1 ELSE 0 END) AS temVencida
                     FROM contas_a_receber
                    WHERE faturaId IS NOT NULL
                    GROUP BY faturaId
                 ) crx ON crx.faturaId = f.id
                 LEFT JOIN tipos_operacao tpo ON tpo.id = p.tipoOperacaoId
                 WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND p.status = ?'; params.push(status); }
      if (tipo) { sql += ' AND p.tipo = ?'; params.push(tipo); }
      if (modoDocumento) { sql += ' AND p.modoDocumento = ?'; params.push(modoDocumento); }
      if (clienteId) { sql += ' AND p.clienteId = ?'; params.push(clienteId); }
      if (statusPagamento) { sql += ' AND p.statusPagamento = ?'; params.push(statusPagamento); }
      if (busca) {
        sql += ' AND (p.numero LIKE ? OR pe.razaoSocial LIKE ? OR p.compraId LIKE ?)';
        const like = `%${busca}%`;
        params.push(like, like, like);
      }

      // Recorte por vendedor. `meus=1` pede o próprio; vendedor restrito recebe
      // o próprio queira ou não. O `vendedorId` da query nunca AMPLIA acesso —
      // só é honrado para quem já enxergava todos.
      const escopo = politicas.escopoVendedor(db, req, req.query);
      sql += escopo.sql;
      params.push(...escopo.params);

      sql += ' ORDER BY p.dataPedido DESC, p.id DESC';

      // Paginação opcional: sem `page`/`limit` a resposta continua sendo a lista
      // inteira, como sempre foi — a tela de pedidos e a de metas dependem disso.
      const limitBruto = req.query.limit != null ? Number(req.query.limit) : null;
      const paginado = Number.isFinite(limitBruto) && limitBruto > 0;
      let total = null;
      if (paginado) {
        const limit = Math.min(limitBruto, 200);
        const page = Math.max(1, Number(req.query.page) || 1);
        const offset = req.query.offset != null ? Math.max(0, Number(req.query.offset) || 0) : (page - 1) * limit;
        total = db.prepare(`SELECT COUNT(*) AS n FROM (${sql})`).get(...params).n;
        sql += ' LIMIT ? OFFSET ?';
        params.push(limit, offset);
        const pedidos = db.prepare(sql).all(...params);
        return res.json({ success: true, pedidos, total, page, limit, escopo: escopo.escopo });
      }

      const pedidos = db.prepare(sql).all(...params);
      res.json({ success: true, pedidos, escopo: escopo.escopo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/pedidos/resumo', (req, res) => {
    try {
      const modo = req.query.modoDocumento;
      const whereModo = modo ? `WHERE modoDocumento = '${modo.replace(/'/g,"''")}'` : '';
      // Mesmo recorte da listagem: sem isto o vendedor restrito veria, no
      // resumo, o faturamento da empresa inteira que a lista lhe esconde.
      const esc = politicas.escopoVendedor(db, req, req.query);
      const whereVend = esc.sql ? (whereModo ? esc.sql.replace(' AND p.', ' AND ') : esc.sql.replace(' AND p.', ' WHERE ')) : '';
      const resumo = db.prepare(`
        SELECT
          COUNT(*) AS total,
          COUNT(CASE WHEN status='rascunho' THEN 1 END) AS rascunho,
          COUNT(CASE WHEN status='confirmado' THEN 1 END) AS confirmado,
          COUNT(CASE WHEN status='em_separacao' THEN 1 END) AS emSeparacao,
          COUNT(CASE WHEN status='entregue' THEN 1 END) AS entregue,
          COUNT(CASE WHEN status='faturado' THEN 1 END) AS faturado,
          COALESCE(SUM(CASE WHEN status NOT IN ('cancelado') THEN valorTotal END), 0) AS valorTotalAtivo,
          COALESCE(SUM(CASE WHEN statusPagamento='pago' THEN valorPago END), 0) AS valorRecebido,
          COALESCE(SUM(CASE WHEN statusPagamento IN ('pendente','parcial') AND status NOT IN ('cancelado')
                            THEN (valorTotal - COALESCE(valorPago,0)) END), 0) AS valorAReceber
        FROM pedidos
        ${whereModo}${whereVend}
      `).get(...esc.params);
      res.json({ success: true, resumo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/pedidos/:id', (req, res) => {
    try {
      const pedido = carregarPedidoCompleto(db, req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      /* Teto de desconto do operador, para a tela exibir ao lado do campo.
       *
       * Vai FORA de `pedido`: não é coluna, é uma resposta sobre quem está
       * pedindo — o mesmo pedido lido por outro usuário traz outro limite.
       *
       * Puramente informativo. A autoridade continua sendo a alçada no PUT, e o
       * bloco D dos testes prova que adulterar o request não a burla. */
      let descontoLimite = null;
      try { descontoLimite = descontos.limiteDescontoDisponivel(db, { pedidoId: pedido.id, req }); }
      catch (_) { /* informativo: nunca derruba a leitura do pedido */ }
      res.json({ success: true, pedido, descontoLimite });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CRIAR ====================

  /**
   * POST /api/pedidos/acao-massa — aplica uma ação à seleção da listagem.
   *
   * Cada pedido é processado por si: um que não pode (faturado no cancelar,
   * sem saldo no confirmar) não derruba o lote — volta na lista de falhas com
   * o motivo. Sem isso, um pedido travado no meio de 40 esconderia dos outros
   * 39 o que aconteceu.
   *
   * Reaproveita cancelarPedidoInterno/confirmarPedidoInterno: as regras de
   * estoque e fatura são as mesmas da ação individual.
   */
  const ACOES_MASSA_PEDIDO = ['vendedor', 'cancelar', 'excluir-rascunho', 'confirmar'];

  app.post('/api/pedidos/acao-massa', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      const acao = String(req.body?.acao || '');
      if (!ids.length) return res.status(400).json({ success: false, error: 'Selecione ao menos um pedido' });
      if (!ACOES_MASSA_PEDIDO.includes(acao)) return res.status(400).json({ success: false, error: 'Ação desconhecida' });
      if (ids.length > 500) return res.status(400).json({ success: false, error: 'No máximo 500 por vez' });

      const motivo = String(req.body?.motivo || '').trim();
      if (acao === 'cancelar' && !motivo) {
        return res.status(400).json({ success: false, error: 'Informe o motivo do cancelamento' });
      }
      const vendedorId = req.body?.vendedorId ? Number(req.body.vendedorId) : null;
      if (acao === 'vendedor' && !vendedorId) {
        return res.status(400).json({ success: false, error: 'Selecione o vendedor' });
      }
      // Reatribuir venda em massa é o caminho mais barato de mexer em comissão
      // alheia — aqui a recusa é explícita (e não silenciosa como no PUT),
      // porque a ação SÓ existe para delegar: ignorar o campo a esvaziaria.
      if (acao === 'vendedor' && !politicas.podeDelegarVendedor(db, req)) {
        return res.status(403).json({ success: false,
          error: 'Seu perfil não pode atribuir pedidos a outro vendedor' });
      }
      const usuario = req.session?.username || null;

      const okIds = [];
      const falhas = [];
      for (const id of ids) {
        const ped = db.prepare('SELECT id, numero, status FROM pedidos WHERE id = ?').get(id);
        if (!ped) { falhas.push({ id, numero: null, erro: 'Pedido não encontrado' }); continue; }
        try {
          if (acao === 'vendedor') {
            db.prepare('UPDATE pedidos SET vendedorId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
              .run(vendedorId, id);
            okIds.push(id);
          } else if (acao === 'cancelar') {
            const r = cancelarPedidoInterno(id, { motivo, usuario });
            if (r.ok) okIds.push(id); else falhas.push({ id, numero: ped.numero, erro: r.error });
          } else if (acao === 'confirmar') {
            // `req` vai junto: sem ele a alçada do desconto não sabe QUEM está
            // confirmando, e a ação em massa viraria o caminho sem autoridade.
            const r = confirmarPedidoInterno(id, { forcar: req.body?.forcar === true, req });
            if (r.ok) okIds.push(id); else falhas.push({ id, numero: ped.numero, erro: r.error });
          } else if (acao === 'excluir-rascunho') {
            const r = excluirPedidoInterno(id);
            if (r.ok) okIds.push(id); else falhas.push({ id, numero: ped.numero, erro: r.error });
          }
        } catch (e) {
          falhas.push({ id, numero: ped.numero, erro: e.message });
        }
      }

      logAction(db, req, 'acao-massa', 'pedido', null,
        { acao, selecionados: ids.length, aplicados: okIds.length, falhas: falhas.length,
          motivo: motivo || null, vendedorId });
      res.json({ success: true, aplicados: okIds.length, total: ids.length, falhas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pedidos', (req, res) => {
    try {
      const { clienteId, dataEntregaPrevista, observacao, itens, modoDocumento, vendedorId, depositoId } = req.body;
      const modo = MODOS_DOCUMENTO.includes(modoDocumento) ? modoDocumento : 'pedido';
      // clienteId é opcional no rascunho — será obrigatório para confirmar/faturar
      if (clienteId) {
        const cliente = db.prepare('SELECT * FROM pessoas WHERE id = ? AND ativo = 1').get(clienteId);
        if (!cliente) return res.status(404).json({ success: false, error: 'Cliente nao encontrado' });
      }

      // Vendedor default = quem está criando. Sem isso o campo depende de
      // alguém lembrar de preencher, e metas/comissões voltam a ficar zeradas.
      // Quem não pode delegar não assume pedido de outro: o campo é ignorado.
      const vend = politicas.resolverVendedor(db, req, vendedorId);

      // Canal de entrada. Só 'manual' e 'app' vêm do cliente — 'licitacao',
      // 'os' e 'marketplace' são gravados pelos caminhos internos que os
      // produzem, e aceitá-los aqui deixaria forjar a procedência do pedido.
      const origem = politicas.ORIGENS_CLIENTE.includes(req.body?.origem) ? req.body.origem : 'manual';

      // Vocabulário conferido na entrada; a OBRIGATORIEDADE (pdv/catalogo) é
      // cobrada na confirmação — o rascunho pode nascer sem saber ainda como o
      // cliente vai receber.
      const erroAtend = atendimento.erroTipoAtendimento(req.body?.tipoAtendimento);
      if (erroAtend) return res.status(422).json({ success: false, error: erroAtend });

      const numero = gerarNumero(db, modo);
      const pedidoId = db.prepare(`
        INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, status, dataPedido, dataEntregaPrevista, observacao, vendedorId, depositoId)
        VALUES (?, ?, ?, ?, 'rascunho', ?, ?, ?, ?, ?)`
      ).run(numero, origem, modo, clienteId || null, dataBrasilia(), dataEntregaPrevista || null, observacao || null, vend.vendedorId,
            depositoId ? Number(depositoId) : resolverDeposito(db, {})).lastInsertRowid;

      // Fora do INSERT de propósito: o campo é opcional e a coluna pode não
      // existir num banco provisionado antes da Fase 1. Incluí-lo na lista de
      // colunas faria a criação de QUALQUER pedido estourar nesses bancos —
      // derrubar o principal por causa do acessório.
      if (req.body?.tipoAtendimento && atendimento.temColuna(db)) {
        db.prepare('UPDATE pedidos SET tipoAtendimento = ? WHERE id = ?')
          .run(req.body.tipoAtendimento, pedidoId);
      }

      // Itens na criação passam a receber o MESMO tratamento do POST /itens:
      // preço pela política e CFOP pelo motor de tipo de operação. Antes iam
      // com o preço cru do corpo e cfop NULL, e a diferença só aparecia na
      // emissão da NF-e.
      const pedidoCtx = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
      const avisos = [];
      if (Array.isArray(itens)) {
        for (const it of itens) {
          if (!it.descricao) continue;
          // Quantidade inválida vira aviso, não silêncio: antes o `continue`
          // engolia o item e o cliente recebia um pedido a menos sem saber por
          // quê. O item não entra nos dois casos — a diferença é o cliente
          // ficar sabendo. Mesmo tratamento que o erro de política já recebe.
          const erroQtd = erroQuantidade(it.quantidade, unidadeDoProduto(it.produtoId));
          if (erroQtd) { avisos.push({ descricao: it.descricao, erro: erroQtd }); continue; }
          const qtd = Number(it.quantidade);
          const p = politicas.precoDeItem(db, {
            pedido: pedidoCtx, produtoId: it.produtoId || null, quantidade: qtd,
            precoInformado: it.precoUnitario, req,
          });
          if (!p.ok) { avisos.push({ descricao: it.descricao, erro: p.erro }); continue; }
          const pu = Number(p.preco);
          db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal, cfop)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(pedidoId, it.produtoId || null, it.descricao, qtd, pu, qtd * pu,
                 cfopDoItem(pedidoCtx, it.produtoId || null));
          registrarDesconto(req, pedidoId, it.produtoId || null, p);
        }
      }
      recalcularTotal(db, pedidoId);

      // Desconto só depois dos itens: a base de cálculo é o subtotal, e antes
      // dos itens ele seria zero. Recusa vira aviso em vez de 422 — o pedido já
      // foi criado, e devolver erro faria o cliente pensar que nada aconteceu.
      const desc = aplicarDesconto(req, pedidoId);
      if (!desc.ok) avisos.push({ campo: 'desconto', erro: desc.erro });
      else if (desc.gravou) recalcularTotal(db, pedidoId);

      if (vend.ignorado) {
        logAction(db, req, 'vendedor-ignorado', 'pedido', pedidoId,
          { enviado: Number(vendedorId), aplicado: vend.vendedorId });
      }
      res.json({ success: true, pedido: carregarPedidoCompleto(db, pedidoId),
        desconto: desc.ok && desc.gravou ? resumoDesconto(desc) : undefined,
        avisos: avisos.length ? avisos : undefined });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // UASG está nos 6 primeiros dígitos do compraId (formato UASG(6)+modalidade(2)+numero(5)+ano(4)).
  // Mais confiável do que participacao.cnpj, que às vezes é UASG, às vezes CNPJ, às vezes lixo ('925474.0').
  function extrairUasg(compraId) {
    const limpo = String(compraId || '').replace(/\D/g, '');
    return limpo.length >= 13 ? limpo.slice(0, 6) : null;
  }

  // Consulta a API pública Dados Abertos (compras.gov.br) para resolver UASG → órgão completo.
  // Cache permanente em orgaos_lookup (dados de UASG raramente mudam).
  async function consultarUasg(codigoUasg) {
    if (!codigoUasg) return null;
    // Fase 3e: PG retorna dados como jsonb (já parseado); SQLite retorna TEXT.
    if (USE_PG) {
      const cache = await catalogPg.queryOne('SELECT "dados" FROM orgaos_lookup WHERE "codigoUasg" = $1', [codigoUasg]);
      if (cache && cache.dados) return cache.dados;
    } else {
      const cache = db.prepare('SELECT dados FROM orgaos_lookup WHERE codigoUasg = ?').get(codigoUasg);
      if (cache) { try { return JSON.parse(cache.dados); } catch {} }
    }
    try {
      const r = await axios.get(UASG_LOOKUP_URL, {
        params: { codigoUasg, statusUasg: true, pagina: 1 },
        timeout: 5000,
      });
      const row = r.data?.resultado?.[0];
      if (!row) return null;
      if (USE_PG) {
        await catalogPg.execute(
          `INSERT INTO orgaos_lookup ("codigoUasg","dados","dataAtualizacao") VALUES ($1,$2::jsonb, now())
           ON CONFLICT ("codigoUasg") DO UPDATE SET "dados"=EXCLUDED."dados", "dataAtualizacao"=now()`,
          [codigoUasg, JSON.stringify(row)]
        );
      } else {
        db.prepare(`INSERT OR REPLACE INTO catalog.orgaos_lookup (codigoUasg, dados, dataAtualizacao)
                    VALUES (?, ?, CURRENT_TIMESTAMP)`).run(codigoUasg, JSON.stringify(row));
      }
      return row;
    } catch { return null; }
  }

  // Resolve/cria/enriquece a pessoa (cliente) a partir da participação.
  // Quando lookupData existe (Dados Abertos respondeu), usa CNPJ real + UF + município.
  // Caso contrário, grava placeholder 'UASG-{codigo}' — honesto, não finge ser CNPJ.
  // Em upsert, só preenche campos atualmente NULL (não sobrescreve dado curado pelo usuário).
  function resolverClienteDeParticipacao(participacao, lookupData) {
    const uasg = extrairUasg(participacao.compraId);
    const cnpjReal = lookupData?.cnpjCpfOrgao?.replace(/\D/g, '') || null;
    const chave = cnpjReal || `UASG-${uasg || participacao.id}`;
    const razao = (lookupData?.nomeUasg || participacao.orgao || '').trim() || 'Órgão não identificado';
    const uf = lookupData?.siglaUf || null;
    const cidade = lookupData?.nomeMunicipioIbge || null;
    const codMunicipio = lookupData?.codigoMunicipioIbge ? String(lookupData.codigoMunicipioIbge) : null;
    const obs = lookupData
      ? `UASG ${uasg} · órgão importado via licitação`
      : `Cadastro incompleto — não foi possível resolver UASG ${uasg || '?'}`;

    const existente = db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(chave);
    if (existente) {
      const upd = {};
      if (!existente.razaoSocial && razao) upd.razaoSocial = razao;
      if (!existente.uf && uf) upd.uf = uf;
      if (!existente.cidade && cidade) upd.cidade = cidade;
      if (!existente.codigoMunicipio && codMunicipio) upd.codigoMunicipio = codMunicipio;
      if (!existente.observacoes && obs) upd.observacoes = obs;
      const keys = Object.keys(upd);
      if (keys.length) {
        const sets = keys.map(k => `${k} = ?`).join(', ') + ', dataAtualizacao = CURRENT_TIMESTAMP';
        db.prepare(`UPDATE pessoas SET ${sets} WHERE id = ?`).run(...keys.map(k => upd[k]), existente.id);
      }
      return existente.id;
    }
    return db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial, uf, cidade, codigoMunicipio, observacoes, ativo)
                       VALUES (?, 'PJ', ?, ?, ?, ?, ?, 1)`)
      .run(chave, razao, uf, cidade, codMunicipio, obs).lastInsertRowid;
  }

  // Busca itens da licitação com fallback em várias fontes:
  //  1. tabela 'itens' (dados PNCP, melhor qualidade — tem quantidade e valor estimado)
  //  2. 'sniper_itens' por compraId (capturado pela extensão — sem quantidade)
  //  3. 'valores_proposta' sobrescreve o preço unitário quando selecionado=1
  function carregarItensParticipacao(participacao) {
    const licitacao = db.prepare(`
      SELECT * FROM licitacoes WHERE cnpj = ? AND anoCompra = ? AND sequencialCompra = ? LIMIT 1
    `).get(participacao.cnpj, participacao.ano, participacao.sequencial);

    const valoresProposta = db.prepare(`
      SELECT numeroItem, valorUnitario FROM valores_proposta
      WHERE cnpj = ? AND ano = ? AND sequencial = ? AND selecionado = 1
    `).all(participacao.cnpj, participacao.ano, participacao.sequencial);
    const vpMap = new Map(valoresProposta.map(v => [v.numeroItem, v.valorUnitario]));

    if (licitacao) {
      const rows = db.prepare('SELECT * FROM itens WHERE licitacaoId = ? ORDER BY numeroItem ASC').all(licitacao.id);
      if (rows.length) {
        return rows.map(it => ({
          numeroItem: it.numeroItem,
          descricao: it.descricao || `Item ${it.numeroItem}`,
          quantidade: Number(it.quantidade) || 1,
          precoUnitario: Number(vpMap.get(it.numeroItem) ?? it.valorUnitarioEstimado) || 0,
        }));
      }
    }

    const sniper = db.prepare(`
      SELECT itemNumero, descricao, valorLance, valorMinimo, valorEstimado
      FROM sniper_itens WHERE compraId = ? ORDER BY itemNumero ASC
    `).all(participacao.compraId);
    return sniper.map(it => ({
      numeroItem: it.itemNumero,
      descricao: it.descricao || `Item ${it.itemNumero}`,
      quantidade: 1,
      precoUnitario: Number(vpMap.get(it.itemNumero) ?? it.valorLance ?? it.valorMinimo ?? it.valorEstimado) || 0,
    }));
  }

  app.post('/api/pedidos/importar-participacao/:participacaoId', async (req, res) => {
    try {
      const { clienteId, dataEntregaPrevista, modoDocumento } = req.body || {};
      const modo = MODOS_DOCUMENTO.includes(modoDocumento) ? modoDocumento : 'pedido';
      const participacao = db.prepare('SELECT * FROM participacoes_comprasnet WHERE id = ?').get(req.params.participacaoId);
      if (!participacao) return res.status(404).json({ success: false, error: 'Participacao nao encontrada' });

      const lookupData = await consultarUasg(extrairUasg(participacao.compraId));
      const clienteFinal = clienteId || resolverClienteDeParticipacao(participacao, lookupData);
      const itensImportados = carregarItensParticipacao(participacao);

      const numero = gerarNumero(db, modo);
      const referencia = participacao.numero || participacao.compraId || '';
      const vendedor = politicas.resolverVendedor(db, req, req.body?.vendedorId).vendedorId;
      const pedidoId = db.prepare(`
        INSERT INTO pedidos (numero, tipo, modoDocumento, clienteId, participacaoId, compraId, status, dataPedido, dataEntregaPrevista, observacao, vendedorId)
        VALUES (?, 'licitacao', ?, ?, ?, ?, 'rascunho', ?, ?, ?, ?)`
      ).run(numero, modo, clienteFinal, participacao.id, participacao.compraId,
        dataBrasilia(), dataEntregaPrevista || null,
        `Importado de participação ${referencia} — ${participacao.orgao || ''}`,
        vendedor
      ).lastInsertRowid;

      const insertItem = db.prepare(`INSERT INTO pedido_itens (pedidoId, descricao, quantidade, precoUnitario, valorTotal)
                                     VALUES (?, ?, ?, ?, ?)`);
      for (const it of itensImportados) {
        insertItem.run(pedidoId, it.descricao, it.quantidade, it.precoUnitario, it.quantidade * it.precoUnitario);
      }
      recalcularTotal(db, pedidoId);
      res.json({
        success: true,
        pedido: carregarPedidoCompleto(db, pedidoId),
        itensImportados: itensImportados.length,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== UPDATE HEADER ====================

  app.put('/api/pedidos/:id', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (ped.status === 'cancelado' || ped.status === 'faturado') {
        return res.status(400).json({ success: false, error: 'Pedido finalizado — nao editavel' });
      }
      const b = req.body;

      // Frete negativo é recusado, não zerado: transformar em zero em silêncio
      // esconde de quem enviou que o valor não foi aplicado. Este é o único
      // caminho que grava `valorFrete` (nenhum INSERT em `pedidos` o preenche).
      const erroFrete = erroValorFrete(b.valorFrete);
      if (erroFrete) return res.status(422).json({ success: false, error: erroFrete });

      // Vocabulário do atendimento na entrada; a obrigatoriedade é da confirmação.
      const erroAtend = atendimento.erroTipoAtendimento(b.tipoAtendimento);
      if (erroAtend) return res.status(422).json({ success: false, error: erroAtend });

      // Meio de recebimento tem de caber na whitelist do cliente. Vale para o
      // par resultante: trocar o cliente de um pedido que já tem meio definido
      // também passa por aqui.
      if (b.meioPagamento !== undefined || b.clienteId !== undefined || b.politicaPrazoId !== undefined) {
        const clienteFinal = b.clienteId !== undefined ? (b.clienteId || null) : ped.clienteId;
        const meioFinal = b.meioPagamento !== undefined ? b.meioPagamento : ped.meioPagamento;

        // Condição de pagamento: a política vinculada ao cliente é obrigatória
        // quando existe — nenhuma outra é aceita. Mesma regra da OS.
        const politicaFinal = b.politicaPrazoId !== undefined ? b.politicaPrazoId : ped.politicaPrazoId;
        const { politica, erro } = resolverPoliticaPedido(db, clienteFinal, politicaFinal);
        if (erro) return res.status(400).json({ success: false, error: erro });
        const meiosOk = meiosDaPoliticaPedido(politica);
        if (meioFinal && meiosOk && !meiosOk.includes(String(meioFinal))) {
          return res.status(400).json({ success: false,
            error: `Condição "${politica.nome}" não aceita esse meio de recebimento` });
        }

        const erroMeio = erroMeioPermitido(db, clienteFinal, meioFinal);
        if (erroMeio) return res.status(400).json({ success: false, error: erroMeio });
      }

      // vendedorId não é campo comum: quem não pode delegar não reatribui a
      // venda. Ignorar (e não recusar) é deliberado — a tela web SEMPRE envia
      // este campo no PUT, mesmo quando é o próprio usuário, e um 403 quebraria
      // a tela para todo perfil restrito no instante em que isto subisse.
      let vendIgnorado = null;
      if (b.vendedorId !== undefined) {
        const vend = politicas.resolverVendedor(db, req, b.vendedorId, ped.vendedorId);
        if (vend.ignorado) { vendIgnorado = b.vendedorId; b.vendedorId = vend.vendedorId; }
      }

      const sets = [];
      const vals = [];
      for (const c of CAMPOS_PEDIDO) {
        if (b[c] === undefined) continue;
        // Banco sem a coluna (provisionado antes da Fase 1): o campo é ignorado
        // em vez de derrubar o PUT inteiro com "no such column".
        if (c === 'tipoAtendimento' && !atendimento.temColuna(db)) continue;
        sets.push(`${c} = ?`);
        vals.push(b[c] === '' ? null : b[c]);
      }
      if (sets.length) {
        sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
        vals.push(req.params.id);
        db.prepare(`UPDATE pedidos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      // Desconto NÃO passa por CAMPOS_PEDIDO: tem porta própria, com alçada.
      // Recusa aqui é 422 de verdade — diferente do POST, o pedido já existe e
      // nada mais foi prometido ao cliente nesta chamada.
      const desc = aplicarDesconto(req, Number(req.params.id));
      if (!desc.ok) {
        return res.status(desc.status || 422).json({ success: false, error: desc.erro,
          alcada: desc.alcada ? { status: desc.alcada.status,
            papelExigido: desc.alcada.regra ? desc.alcada.regra.papelAprovador : null } : undefined });
      }

      // O frete e o desconto compõem o total — recalcular quando qualquer um mudar.
      if (b.valorFrete !== undefined || desc.gravou) recalcularTotal(db, req.params.id);
      if (vendIgnorado != null) {
        logAction(db, req, 'vendedor-ignorado', 'pedido', Number(req.params.id),
          { enviado: Number(vendIgnorado), aplicado: b.vendedorId });
      }
      res.json({ success: true, pedido: carregarPedidoCompleto(db, req.params.id),
        desconto: desc.gravou ? resumoDesconto(desc) : undefined });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Exclusão de rascunho.
   *
   * Apagar só `pedido_itens` + `pedidos` não bastava: `pedido_historico`,
   * `pedido_parcelas` e `reservas_estoque` apontam para o pedido com FK sem
   * ON DELETE, e o tenant roda com `foreign_keys = ON` (tenant-manager.js:132).
   * Bastava o rascunho ter uma linha de histórico — o que acontece assim que
   * ele é reaberto ou tem status mexido — para o DELETE estourar constraint.
   *
   * As tabelas abaixo são PARTES do pedido: existem por causa dele e somem
   * junto. Qualquer outra referência é documento de vida própria (fatura,
   * devolução, OS, comissão apurada…) e vira recusa, não exclusão em cascata.
   */
  const PARTES_DO_PEDIDO = ['reservas_estoque', 'pedido_parcelas', 'pedido_historico', 'pedido_itens'];

  const ROTULOS_VINCULO_PEDIDO = {
    faturas: 'fatura', contas_a_receber: 'conta a receber', devolucoes: 'devolução',
    os_ordens: 'ordem de serviço', comissoes_apuracao: 'comissão apurada',
    optica_ordens_montagem: 'ordem de montagem', romaneio_paradas: 'parada de romaneio',
    marketplaces_pedidos: 'pedido de marketplace', tef_transacoes: 'transação TEF',
    crm_oportunidades: 'oportunidade de CRM', conv_conversas: 'conversa',
    agenda_recebiveis_cartao: 'recebível de cartão', serial_numbers: 'número de série',
    vendas_perdidas: 'venda perdida',
  };

  // Fail-closed: tabela com pedidoId que não seja parte declarada acima conta
  // como vínculo. Módulo novo passa a proteger sozinho, sem ninguém lembrar.
  function vinculosDePedido(pedId) {
    const achados = [];
    const tabelas = db.prepare(`
      SELECT m.name AS tabela, p.name AS coluna
        FROM sqlite_master m, pragma_table_info(m.name) p
       WHERE m.type = 'table' AND p.name = 'pedidoId'
       ORDER BY m.name
    `).all().filter((r) => !PARTES_DO_PEDIDO.includes(r.tabela) && r.tabela !== 'pedidos');
    for (const { tabela, coluna } of tabelas) {
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM "${tabela}" WHERE "${coluna}" = ?`).get(pedId);
        if (r && r.n) achados.push({ tabela, qtd: r.n });
      } catch (_) { /* tabela ilegível não vira bloqueio nem erro 500 */ }
    }
    return achados;
  }

  function excluirPedidoInterno(pedId) {
    const ped = db.prepare('SELECT id, numero, status FROM pedidos WHERE id = ?').get(pedId);
    if (!ped) return { ok: false, status: 404, error: 'Pedido nao encontrado' };
    if (ped.status !== 'rascunho') return { ok: false, status: 400, error: 'Somente rascunhos podem ser excluidos' };

    const vinculos = vinculosDePedido(ped.id);
    if (vinculos.length) {
      // Nome de tabela não diz nada a quem opera; o que não estiver no mapa cai
      // no fallback legível em vez de sumir da mensagem.
      const rotulo = (t) => ROTULOS_VINCULO_PEDIDO[t] || t.replace(/_/g, ' ');
      return { ok: false, status: 409, vinculos,
        error: 'Tem ' + vinculos.map((v) => `${rotulo(v.tabela)} (${v.qtd})`).join(', ') + ' vinculado(s)' };
    }

    db.transaction(() => {
      for (const t of PARTES_DO_PEDIDO) {
        try { db.prepare(`DELETE FROM "${t}" WHERE pedidoId = ?`).run(ped.id); } catch (_) { /* tenant sem o módulo */ }
      }
      db.prepare('DELETE FROM pedidos WHERE id = ?').run(ped.id);
    })();
    return { ok: true };
  }

  app.delete('/api/pedidos/:id', (req, res) => {
    try {
      const r = excluirPedidoInterno(req.params.id);
      if (!r.ok) return res.status(r.status).json({ success: false, error: r.error, vinculos: r.vinculos });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Converte modoDocumento entre 'pedido' e 'orcamento' — regera o número no novo prefixo.
  app.post('/api/pedidos/:id/converter-modo', (req, res) => {
    try {
      const destino = req.body?.modoDocumento;
      if (!MODOS_DOCUMENTO.includes(destino)) {
        return res.status(400).json({ success: false, error: 'modoDocumento invalido' });
      }
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (ped.modoDocumento === destino) {
        return res.json({ success: true, pedido: carregarPedidoCompleto(db, req.params.id) });
      }
      if (ped.status !== 'rascunho') {
        return res.status(400).json({ success: false, error: 'Somente rascunho pode mudar de modo' });
      }
      const novoNumero = gerarNumero(db, destino);
      db.prepare(`UPDATE pedidos SET modoDocumento = ?, numero = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(destino, novoNumero, req.params.id);
      // Orçamento com perda registrada virando pedido: o dado fica, mas o
      // front avisa — perda e venda do mesmo item se contradizem.
      let vendasPerdidasVinculadas = 0;
      if (destino === 'pedido') {
        try {
          vendasPerdidasVinculadas = db.prepare('SELECT COUNT(*) n FROM vendas_perdidas WHERE pedidoId = ?')
            .get(req.params.id).n;
        } catch { /* tenant sem o modulo de precos migrado ainda */ }
      }
      res.json({ success: true, vendasPerdidasVinculadas, pedido: carregarPedidoCompleto(db, req.params.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ITENS ====================

  app.post('/api/pedidos/:id/itens', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (['entregue', 'faturado', 'cancelado'].includes(ped.status)) {
        return res.status(400).json({ success: false, error: 'Pedido nao permite novos itens neste status' });
      }
      const { produtoId, descricao, quantidade, precoUnitario, cfop: cfopManual, entregaPorFabricante } = req.body;
      // precoUnitario deixou de ser obrigatório: sem ele o servidor resolve.
      // É esse o caminho do app — quem não manda preço não tem como adulterá-lo.
      if (!descricao) {
        return res.status(400).json({ success: false, error: 'descricao e quantidade obrigatorios' });
      }
      // 400 continua para a descrição (contrato antigo); a quantidade inválida
      // é 422, como os demais valores que o servidor recusa por regra.
      const erroQtd = erroQuantidade(quantidade, unidadeDoProduto(produtoId));
      if (erroQtd) return res.status(422).json({ success: false, error: erroQtd });
      const qtd = Number(quantidade);

      const p = politicas.precoDeItem(db, {
        pedido: ped, produtoId: produtoId || null, quantidade: qtd,
        precoInformado: precoUnitario, req,
      });
      if (!p.ok) return res.status(422).json({ success: false, error: p.erro,
        precoSugerido: p.sugerido, precoMinimo: p.piso, fonte: p.fonte });
      const pu = Number(p.preco);

      // CFOP pelo Tipo de Operação do pedido + cliente + UF (helper único do
      // módulo). O usuário não edita CFOP manualmente — tipo de operação manda.
      const cfopFinal = cfopDoItem(ped, produtoId || null);

      const result = db.prepare(`INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal, cfop)
                                 VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(req.params.id, produtoId || null, descricao, qtd, pu, qtd * pu, cfopFinal);
      registrarDesconto(req, Number(req.params.id), produtoId || null, p);
      recalcularTotal(db, req.params.id);
      atualizarStatusPagamento(db, req.params.id);
      const item = db.prepare('SELECT * FROM pedido_itens WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, item, precoFonte: p.fonte, precoSugerido: p.sugerido,
        pedido: carregarPedidoCompleto(db, req.params.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/pedidos/:id/itens/:itemId', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (['entregue', 'faturado', 'cancelado'].includes(ped.status)) {
        return res.status(400).json({ success: false, error: 'Pedido nao permite edicao neste status' });
      }
      const item = db.prepare('SELECT * FROM pedido_itens WHERE id = ? AND pedidoId = ?').get(req.params.itemId, req.params.id);
      if (!item) return res.status(404).json({ success: false, error: 'Item nao encontrado' });
      const b = req.body;
      // Valida a quantidade RESULTANTE, não a enviada: é ela que vai para o
      // banco e para `qtd * pu`. Editar só a descrição de um item que já tenha
      // quantidade inválida passa a exigir corrigi-la — não há nenhum item
      // assim hoje (0 de 542 nos 13 tenants), e propagar o inválido seria pior.
      const erroQtd = erroQuantidade(b.quantidade ?? item.quantidade,
        unidadeDoProduto(b.produtoId ?? item.produtoId));
      if (erroQtd) return res.status(422).json({ success: false, error: erroQtd });
      const qtd = Number(b.quantidade ?? item.quantidade);
      const produtoFinal = b.produtoId ?? item.produtoId;

      // Só passa pela política quando o preço vem no corpo. Editar apenas a
      // quantidade preserva o preço já gravado — inclusive um desconto que foi
      // concedido antes desta regra existir.
      let pu = Number(item.precoUnitario);
      let pol = null;
      if (b.precoUnitario !== undefined) {
        pol = politicas.precoDeItem(db, {
          pedido: ped, produtoId: produtoFinal || null, quantidade: qtd,
          precoInformado: b.precoUnitario, req,
        });
        if (!pol.ok) return res.status(422).json({ success: false, error: pol.erro,
          precoSugerido: pol.sugerido, precoMinimo: pol.piso, fonte: pol.fonte });
        pu = Number(pol.preco);
      }

      const cfopNovo = b.cfop !== undefined ? (b.cfop || null) : item.cfop;
      db.prepare(`UPDATE pedido_itens SET produtoId = ?, descricao = ?, quantidade = ?, precoUnitario = ?, valorTotal = ?, cfop = ?
                  WHERE id = ?`)
        .run(produtoFinal, b.descricao ?? item.descricao, qtd, pu, qtd * pu, cfopNovo, req.params.itemId);
      if (pol) registrarDesconto(req, Number(req.params.id), produtoFinal || null, pol);
      recalcularTotal(db, req.params.id);
      atualizarStatusPagamento(db, req.params.id);
      res.json({ success: true, pedido: carregarPedidoCompleto(db, req.params.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Recalcula CFOP de um item via motor de Tipo de Operação.
  // Usado quando o usuário troca o tipoOperacaoId no cabeçalho e quer propagar aos itens.
  app.post('/api/pedidos/:id/itens/:itemId/recalcular-cfop', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      const item = db.prepare('SELECT * FROM pedido_itens WHERE id = ? AND pedidoId = ?').get(req.params.itemId, req.params.id);
      if (!item) return res.status(404).json({ success: false, error: 'Item nao encontrado' });
      let cfopNovo = null;
      try {
        const sug = sugerirCFOP(db, {
          tipoOperacaoId: ped.tipoOperacaoId,
          clienteId: ped.clienteId || null,
          produtoId: item.produtoId || null,
          ufEntrega: ped.ufEntrega || null
        });
        cfopNovo = sug?.cfop || null;
      } catch(e) { return res.status(400).json({ success: false, error: e.message }); }
      db.prepare('UPDATE pedido_itens SET cfop = ? WHERE id = ?').run(cfopNovo, req.params.itemId);
      res.json({ success: true, cfop: cfopNovo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/pedidos/:id/itens/:itemId', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (['entregue', 'faturado', 'cancelado'].includes(ped.status)) {
        return res.status(400).json({ success: false, error: 'Pedido nao permite remocao neste status' });
      }
      db.prepare('DELETE FROM pedido_itens WHERE id = ? AND pedidoId = ?').run(req.params.itemId, req.params.id);
      recalcularTotal(db, req.params.id);
      atualizarStatusPagamento(db, req.params.id);
      res.json({ success: true, pedido: carregarPedidoCompleto(db, req.params.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== AÇÕES DE STATUS ====================

  /**
   * Confirmação de um pedido. Vive fora do handler porque a ação em massa
   * precisa das MESMAS regras — reserva de estoque inclusive. Duplicar isso
   * seria garantir que as duas versões divergiriam.
   * Devolve { ok, status, error, insuficiencias }.
   */
  function confirmarPedidoInterno(pedId, opts) {
    const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedId);
    if (!ped) return { ok: false, status: 404, error: 'Pedido nao encontrado' };
    if (ped.modoDocumento === 'orcamento') return { ok: false, status: 400, error: 'Converta o orcamento em pedido antes de confirmar' };
    if (ped.status !== 'rascunho') return { ok: false, status: 400, error: 'Somente rascunho pode ser confirmado' };
    if (!ped.clienteId) return { ok: false, status: 400, error: 'Informe o cliente antes de confirmar' };
    const nItens = db.prepare('SELECT COUNT(*) AS n FROM pedido_itens WHERE pedidoId = ?').get(pedId).n;
    if (!nItens) return { ok: false, status: 400, error: 'Pedido sem itens' };

    // Como o cliente recebe: obrigatório para as origens que nasceram com o
    // conceito (pdv/catalogo), e `entrega` exige endereço. O ERP tradicional
    // segue confirmando sem declarar nada, como sempre fez.
    const erroAtend = atendimento.erroAtendimentoParaConfirmar(db, ped);
    if (erroAtend) return { ok: false, status: 422, error: erroAtend };

    // Desconto acima da alçada não vira venda enquanto ninguém aprovar. O pedido
    // permanece em rascunho — não há status novo (ver `bloqueioDeConfirmacao`).
    const bloqueio = descontos.bloqueioDeConfirmacao(db, pedId, opts && opts.req);
    if (bloqueio.bloqueado) {
      return { ok: false, status: 409, error: bloqueio.motivo,
        aprovacao: { id: bloqueio.aprovacaoId, status: bloqueio.status } };
    }

    const forcar = opts && opts.forcar === true;
    let insuficiencias = [];
    const tx = db.transaction(() => {
      const resultado = criarReservasPedido(db, Number(pedId));
      insuficiencias = resultado.insuficiencias;
      if (insuficiencias.length && !forcar) throw new Error('INSUFICIENTE');
      db.prepare(`UPDATE pedidos SET status = 'confirmado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(pedId);
    });
    try {
      tx();
    } catch (e) {
      if (e.message === 'INSUFICIENTE') {
        return { ok: false, status: 409, insuficiencias,
          error: 'Saldo insuficiente para reservar. Envie { forcar: true } para confirmar mesmo assim.' };
      }
      throw e;
    }
    return { ok: true, insuficiencias };
  }
  // Guardada aqui, uma vez, quando as rotas nascem.
  _confirmarPedidoInterno = confirmarPedidoInterno;

  app.post('/api/pedidos/:id/confirmar', (req, res) => {
    try {
      const r = confirmarPedidoInterno(req.params.id, { forcar: req.body?.forcar === true, req });
      if (!r.ok) {
        return res.status(r.status).json({ success: false, error: r.error,
          insuficiencias: r.insuficiencias, aprovacao: r.aprovacao });
      }
      res.json({ success: true, pedido: carregarPedidoCompleto(db, req.params.id), insuficiencias: r.insuficiencias });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pedidos/:id/entregar', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (!['confirmado', 'em_separacao'].includes(ped.status)) {
        return res.status(400).json({ success: false, error: 'Pedido precisa estar confirmado/em_separacao' });
      }
      const dataEntrega = req.body?.dataEntrega || dataBrasilia();

      const tx = db.transaction(() => {
        // 1) Converter reservas ativas em saídas reais
        const movIdsReservas = consumirReservasPedido(db, Number(req.params.id), dataEntrega);

        // 2) Fallback: itens sem reserva (pedidos antigos confirmados antes da Fase 2)
        //    Gera saídas para itens que não tiveram reserva consumida nesta entrega
        const reservasConsumidas = db.prepare(`
          SELECT pedidoItemId FROM reservas_estoque
          WHERE pedidoId = ? AND status = 'consumida' AND movimentacaoConsumoId IN (${movIdsReservas.length ? movIdsReservas.map(()=>'?').join(',') : '0'})
        `).all(Number(req.params.id), ...movIdsReservas);
        const itensComReserva = new Set(reservasConsumidas.map(r => r.pedidoItemId));

        // Se o tipo de operação do pedido não movimenta estoque (simples remessa, bonificação
        // com tipo especial), pula completamente a criação de saídas.
        const tipoOp = ped.tipoOperacaoId
          ? db.prepare('SELECT movimentaEstoque FROM tipos_operacao WHERE id = ?').get(ped.tipoOperacaoId)
          : null;
        const movimentaEst = tipoOp ? !!tipoOp.movimentaEstoque : true;

        if (movimentaEst) {
          const itens = db.prepare('SELECT * FROM pedido_itens WHERE pedidoId = ?').all(req.params.id);
          for (const it of itens) {
            if (!it.produtoId) continue;
            if (itensComReserva.has(it.id)) continue;  // já processado via reserva
            db.prepare(`INSERT INTO movimentacoes_estoque
                        (produtoId, tipo, quantidade, origem, origemId, observacao, data, depositoId)
                        VALUES (?, 'saida', ?, 'pedido', ?, ?, ?, ?)`)
              .run(it.produtoId, Number(it.quantidade), ped.id,
                   `Saída pelo pedido ${ped.numero} (sem reserva)`, dataEntrega,
                   resolverDeposito(db, { depositoId: ped.depositoId, pedidoId: ped.id, produtoId: it.produtoId }));
          }
        }

        db.prepare(`UPDATE pedidos SET status = 'entregue', dataEntregaReal = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(dataEntrega, req.params.id);

        // Propaga pra OM ativa (módulo Ótica): pedido entregue → OM entregue.
        // Best-effort: skip se tabela não existe (tenant não-óptico) ou OM
        // já estiver em estado terminal (cancelada/entregue).
        try {
          db.prepare(`UPDATE optica_ordens_montagem
                      SET status = 'entregue',
                          dataEntrega = COALESCE(dataEntrega, ?)
                      WHERE pedidoId = ? AND ativo = 1
                        AND status NOT IN ('cancelada','entregue')`)
            .run(dataEntrega, req.params.id);
        } catch { /* tenant sem ótica */ }
      });
      tx();

      res.json({ success: true, pedido: carregarPedidoCompleto(db, req.params.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pedidos/:id/status', (req, res) => {
    try {
      const { status } = req.body;
      if (!STATUS_VALIDOS.includes(status)) {
        return res.status(400).json({ success: false, error: 'Status invalido' });
      }
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      // Proteções mínimas
      if (status === 'entregue') {
        return res.status(400).json({ success: false, error: 'Use POST /entregar para baixar estoque' });
      }

      const tx = db.transaction(() => {
        // Se está saindo de confirmado/em_separacao para rascunho → cancelar reservas
        if (['confirmado', 'em_separacao'].includes(ped.status) && status === 'rascunho') {
          cancelarReservasPedido(db, ped.id, 'voltou para rascunho');
        }
        // Se está indo para confirmado de volta (ex: reabrir) e não tem reservas ativas → criar
        if (status === 'confirmado' && ped.status !== 'confirmado') {
          const ativas = db.prepare(`SELECT COUNT(*) AS n FROM reservas_estoque WHERE pedidoId = ? AND status='ativa'`).get(ped.id).n;
          if (ativas === 0) {
            criarReservasPedido(db, ped.id);
          }
        }
        db.prepare(`UPDATE pedidos SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(status, req.params.id);
      });
      tx();

      res.json({ success: true, pedido: carregarPedidoCompleto(db, req.params.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Cancelamento de um pedido — estorno/liberação de estoque, venda perdida
   * opcional, propagação para a ótica e histórico. Fora do handler pela mesma
   * razão do confirmar: a ação em massa usa exatamente estas regras.
   * Devolve { ok, status, error, ... }.
   */
  function cancelarPedidoInterno(pedId, opts) {
    opts = opts || {};
    const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedId);
    if (!ped) return { ok: false, status: 404, error: 'Pedido nao encontrado' };
    if (ped.status === 'cancelado') return { ok: false, status: 400, error: 'Pedido ja cancelado' };
    if (ped.status === 'faturado') {
      // Só bloqueia se existe fatura emitida de verdade
      const fat = ped.faturaId ? db.prepare("SELECT id FROM faturas WHERE id = ? AND status = 'emitida'").get(ped.faturaId) : null;
      if (fat) return { ok: false, status: 400, error: 'Cancele a fatura primeiro — o pedido volta para entregue automaticamente' };
      // Pedido faturado "órfão" (sem fatura real) — permite cancelar, mas registra o caso
    }
    const motivo = String(opts.motivo || '').trim();
    if (!motivo) return { ok: false, status: 400, error: 'motivo obrigatorio' };

    // Venda perdida opcional — o cancelamento é o momento em que a
    // informação existe; registrar depois, à mão, quase nunca acontece.
    const registrarPerda = !!opts.registrarPerda;
    const usuario = opts.usuario || null;
    let estornadas = [];
    let reservasCanceladas = 0;
    let perdas = { geradas: 0, ids: [], ignorados: [] };
    const tx = db.transaction(() => {
      if (ped.status === 'entregue') {
        estornadas = estornarEstoque(ped.id, motivo);
      } else if (['confirmado', 'em_separacao'].includes(ped.status)) {
        reservasCanceladas = cancelarReservasPedido(db, ped.id, `cancelamento: ${motivo}`);
      }
      db.prepare(`UPDATE pedidos SET status = 'cancelado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(ped.id);
      // Depois do UPDATE de propósito: um pedido 'entregue' que teve o
      // estoque estornado virou perda legítima, e o helper recusa
      // status entregue/faturado.
      if (registrarPerda) {
        perdas = registrarPerdasDePedido(db, ped.id, {
          motivo: opts.motivoPerda,
          concorrente: opts.concorrente,
          observacao: `Cancelamento ${ped.numero}: ${motivo}`,
          itens: opts.itensPerda,
          origem: ped.modoDocumento === 'orcamento' ? 'orcamento_perdido' : 'pedido_cancelado',
          usuario,
        });
      }
      // Propaga pra OM ativa: pedido cancelado → OM cancelada com observação
      // automática. Skip se OM já entregue (cliente recebeu) ou já cancelada.
      try {
        db.prepare(`UPDATE optica_ordens_montagem
                    SET status = 'cancelada',
                        observacoes = COALESCE(observacoes || ' | ', '')
                                     || 'Cancelado automaticamente: pedido cancelado em '
                                     || strftime('%Y-%m-%d %H:%M:%S', 'now')
                    WHERE pedidoId = ? AND ativo = 1
                      AND status NOT IN ('entregue','cancelada')`)
          .run(ped.id);
      } catch { /* tenant sem ótica */ }
      registrarHistorico(ped.id, ped.status, 'cancelado', 'cancelar', motivo, usuario,
        (estornadas.length || reservasCanceladas || perdas.geradas)
          ? { movimentacoesEstornadas: estornadas, reservasCanceladas, vendasPerdidasGeradas: perdas.geradas }
          : null);
    });
    tx();
    return { ok: true, movimentacoesEstornadas: estornadas.length, reservasCanceladas,
      vendasPerdidasGeradas: perdas.geradas };
  }

  app.post('/api/pedidos/:id/cancelar', (req, res) => {
    try {
      const r = cancelarPedidoInterno(req.params.id, {
        motivo: req.body?.motivo,
        registrarPerda: !!req.body?.registrarPerda,
        motivoPerda: req.body?.motivoPerda,
        concorrente: req.body?.concorrente,
        itensPerda: req.body?.itensPerda,
        usuario: req.session?.username || null,
      });
      if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
      res.json({ success: true, movimentacoesEstornadas: r.movimentacoesEstornadas,
        reservasCanceladas: r.reservasCanceladas, vendasPerdidasGeradas: r.vendasPerdidasGeradas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Determina qual é o status anterior ao fazer reabrir
  const TRANSICAO_REABRIR = {
    'confirmado': 'rascunho',
    'em_separacao': 'confirmado',
    'entregue': 'em_separacao',
    'cancelado': 'rascunho',
    'faturado': 'entregue', // só cai aqui se fatura for órfã (sem registro real)
  };

  app.post('/api/pedidos/:id/reabrir', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (ped.status === 'faturado') {
        const fat = ped.faturaId ? db.prepare("SELECT id FROM faturas WHERE id = ? AND status = 'emitida'").get(ped.faturaId) : null;
        if (fat) return res.status(400).json({ success: false, error: 'Cancele a fatura primeiro para poder reabrir' });
      }
      const destino = TRANSICAO_REABRIR[ped.status];
      if (!destino) return res.status(400).json({ success: false, error: `Status "${ped.status}" nao pode ser reaberto` });

      const motivo = (req.body?.motivo || '').trim();
      if (!motivo) return res.status(400).json({ success: false, error: 'motivo obrigatorio' });

      const usuario = req.session?.username || null;
      let estornadas = [];
      let perdasEstornadas = 0;
      let reservasRecriadas = 0;
      let insuficienciasReabrir = [];
      const tx = db.transaction(() => {
        if (ped.status === 'entregue') {
          estornadas = estornarEstoque(ped.id, motivo);
        }
        // A venda voltou a existir: apaga as perdas geradas pelo
        // cancelamento, senão o BI conta perda de um pedido vivo.
        // Perdas lançadas à mão ficam — foram decisão do usuário.
        perdasEstornadas = estornarPerdasDePedido(db, ped.id);
        db.prepare(`UPDATE pedidos SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(destino, ped.id);

        // Reserva: reabrir não mexia nisso, então o pedido voltava para
        // confirmado/em_separacao SEM reserva ativa e o saldo ficava livre
        // para outro pedido consumir.
        if (['confirmado', 'em_separacao'].includes(destino)) {
          const ativas = db.prepare(
            `SELECT COUNT(*) n FROM reservas_estoque WHERE pedidoId = ? AND status = 'ativa'`).get(ped.id).n;
          if (ativas === 0) {
            const r = criarReservasPedido(db, ped.id);
            reservasRecriadas = r.reservasCriadas.length;
            insuficienciasReabrir = r.insuficiencias;
          }
        } else {
          // Voltou para rascunho: não há o que reservar.
          cancelarReservasPedido(db, ped.id, `reabertura para ${destino}: ${motivo}`);
        }
        registrarHistorico(ped.id, ped.status, destino, 'reabrir', motivo, usuario,
          (estornadas.length || perdasEstornadas)
            ? { movimentacoesEstornadas: estornadas, vendasPerdidasEstornadas: perdasEstornadas }
            : null);
      });
      tx();
      res.json({ success: true, statusNovo: destino, movimentacoesEstornadas: estornadas.length,
        vendasPerdidasEstornadas: perdasEstornadas,
        reservasRecriadas, insuficiencias: insuficienciasReabrir });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ==========================================================================
     COMPARTILHAMENTO PÚBLICO DO ORÇAMENTO
     ==========================================================================
     O problema que isto resolve: o link enviado por WhatsApp levava o cliente
     para a tela de LOGIN. Ele não tem conta — e não deve ter.

     O desenho copia o que a OS já faz em `/api/orcamento/:token`, em produção
     há tempos: token opaco na URL, rota liberada antes do auth, e uma tela
     pública que mostra só o necessário.

     O que NÃO foi feito, e é o ponto principal: a rota interna continua
     protegida. `/api/pedidos/:id` exige sessão como sempre. O que nasce público
     é um caminho NOVO, `/api/orcamento-publico/:token`, que devolve um recorte
     do orçamento — sem custo, sem margem, sem dado de outro cliente.
     ========================================================================== */

  /**
   * Gera (ou devolve) o link público. Protegida — exige sessão.
   *
   * Idempotente: chamar duas vezes devolve o mesmo token, para o link que o
   * vendedor já mandou não deixar de funcionar por ele ter clicado de novo.
   */
  app.post('/api/pedidos/:id/link-publico', (req, res) => {
    try {
      const pedido = db.prepare('SELECT id, numero, tokenPublico FROM pedidos WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });

      let token = pedido.tokenPublico;
      if (!token || String(req.body?.regerar) === 'true') {
        // 32 bytes = 64 hex. Espaço grande demais para tentativa e erro, e o
        // índice único garante que não colide.
        token = crypto.randomBytes(32).toString('hex');
        db.prepare("UPDATE pedidos SET tokenPublico = ?, tokenPublicoEm = datetime('now','-3 hours') WHERE id = ?")
          .run(token, pedido.id);
        try { logAction(db, req, 'pedido.link_publico', { pedidoId: pedido.id, regerado: !!pedido.tokenPublico }); } catch (_) {}
      }
      // A razão social vai junto porque a mensagem do WhatsApp precisa dizer de
      // que empresa é o orçamento. Sem isto ela saía sem identificação nenhuma:
      // a tela lia `window.EMITENTE_NOME`, que ninguém preenchia.
      let emitenteNome = null;
      try {
        const e = db.prepare('SELECT razaoSocial FROM fornecedor ORDER BY id DESC LIMIT 1').get();
        emitenteNome = (e && e.razaoSocial) || null;
      } catch (_) { /* instalação sem emitente cadastrado */ }

      res.json({ success: true, token, emitente: emitenteNome,
                 url: '/orcamento-comercial.html?token=' + token });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** Revoga o link. O endereço antigo passa a responder 404 imediatamente. */
  app.delete('/api/pedidos/:id/link-publico', (req, res) => {
    try {
      const r = db.prepare('UPDATE pedidos SET tokenPublico = NULL, tokenPublicoEm = NULL WHERE id = ?').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      try { logAction(db, req, 'pedido.link_publico_revogado', { pedidoId: Number(req.params.id) }); } catch (_) {}
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Leitura PÚBLICA por token. Sem sessão — é o link que o cliente recebe.
   *
   * ⚠️ O recorte é deliberado. Vai o que o cliente precisa para decidir:
   * número, data, validade, emitente, itens, valores e o total. NÃO vai nada
   * que seja da operação interna — custo, margem, depósito, vendedor, status
   * do pedido, observação interna, histórico.
   *
   * O token identifica UM orçamento. Não há listagem, não há busca, e um token
   * não dá acesso a nenhum outro registro.
   */
  app.get('/api/orcamento-publico/:token', (req, res) => {
    try {
      const tk = String(req.params.token || '');
      // Formato conferido antes de ir ao banco: 64 hex, nada além disso.
      if (!/^[a-f0-9]{64}$/.test(tk)) {
        return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      }
      const pedido = carregarPedidoCompleto(db, null, { token: tk });
      if (!pedido) return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      if (pedido.status === 'cancelado') {
        return res.status(410).json({ success: false, error: 'Este orçamento foi cancelado.' });
      }
      const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {};
      res.json({
        success: true,
        orcamento: {
          numero: pedido.numero,
          data: pedido.dataPedido,
          validade: pedido.dataValidade || null,
          cliente: pedido.clienteNome || null,
          itens: (pedido.itens || []).map((i) => ({
            sku: i.sku || null,
            descricao: i.descricao,
            unidade: i.unidade || null,
            quantidade: i.quantidade,
            precoUnitario: i.precoUnitario,
            valorTotal: i.valorTotal,
          })),
          desconto: pedido.descontoAplicado || 0,
          frete: pedido.valorFrete || 0,
          valorTotal: pedido.valorTotal,
          observacao: pedido.observacao || null,
        },
        emitente: {
          razaoSocial: emitente.razaoSocial || null,
          cnpj: emitente.cnpj || null,
          telefone: emitente.telefone || null,
          email: emitente.email || null,
          logoBase64: emitente.logoBase64 || null,
        },
      });
    } catch (err) {
      console.error('[orcamento-publico]', err);
      res.status(500).json({ success: false, error: 'Não foi possível carregar o orçamento.' });
    }
  });

  /** PDF pelo link público — mesmo gerador, mesma proteção por token. */
  app.get('/api/orcamento-publico/:token/pdf', (req, res) => {
    try {
      const tk = String(req.params.token || '');
      if (!/^[a-f0-9]{64}$/.test(tk)) return res.status(404).send('Não encontrado');
      const pedido = carregarPedidoCompleto(db, null, { token: tk });
      if (!pedido || pedido.status === 'cancelado') return res.status(404).send('Não encontrado');
      const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {};
      const nomeArq = String(pedido.numero || 'orcamento').replace(/[^\w.-]+/g, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `${String(req.query.download || '') === '1' ? 'attachment' : 'inline'}; filename="${nomeArq}.pdf"`);
      pedidoPdf.gerar(res, pedido, emitente);
    } catch (err) {
      console.error('[orcamento-publico/pdf]', err);
      res.status(500).send('Não foi possível gerar o PDF.');
    }
  });

  /**
   * Lista de separação — documento INTERNO de conferência.
   *
   * Mesma fonte de dados do PDF do pedido; o que muda é o recorte: sem imposto,
   * sem NCM/CFOP, sem preço. Ver o cabeçalho de `separacao-pdf.js`.
   *
   * `?download=1` força o salvamento; sem ele abre no visualizador, que é o que
   * "Visualizar" e "Imprimir" precisam.
   */
  app.get('/api/pedidos/:id/separacao', (req, res) => {
    try {
      const pedido = carregarPedidoCompleto(db, req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      // Número da nota, quando já emitida — é o que o conferente cruza com a
      // mercadoria que vai sair.
      if (pedido.faturaId) {
        try {
          const f = db.prepare('SELECT numero, numeroNFe FROM faturas WHERE id = ?').get(pedido.faturaId);
          if (f) pedido.notaNumero = f.numeroNFe || f.numero;
        } catch (_) { /* instalação sem faturas */ }
      }
      const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {};
      const nomeArq = 'SEPARACAO-' + String(pedido.numero || 'pedido').replace(/[^\w.-]+/g, '-');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `${String(req.query.download || '') === '1' ? 'attachment' : 'inline'}; filename="${nomeArq}.pdf"`);
      separacaoPdf.gerar(res, pedido, emitente);
    } catch (err) {
      console.error('[separacao]', err);
      res.status(500).json({ success: false, error: 'Não foi possível gerar a lista de separação.' });
    }
  });

  app.get('/api/pedidos/:id/pdf', (req, res) => {
    try {
      const pedido = carregarPedidoCompleto(db, req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (pedido.faturaId) {
        const fat = db.prepare('SELECT numero FROM faturas WHERE id = ?').get(pedido.faturaId);
        if (fat) pedido.faturaNumero = fat.numero;
      }
      const emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {};
      res.setHeader('Content-Type', 'application/pdf');
      // `?download=1` força o salvamento em vez de abrir no visualizador.
      //
      // O padrão continua `inline` — quem só quer conferir na tela não deve
      // ganhar um arquivo na pasta de downloads. Mas o botão "Baixar PDF" pede
      // o contrário, e no celular isso importa: no iOS, um PDF aberto `inline`
      // dentro de aba nova costuma cair no visualizador sem opção clara de
      // salvar, e o bloqueador de pop-up às vezes nem deixa abrir.
      //
      // O nome do arquivo é o número do documento (ORC-2026-00003.pdf), com os
      // caracteres que atrapalham sistema de arquivos trocados por "-".
      const nomeArq = String(pedido.numero || 'documento').replace(/[^\w.-]+/g, '-');
      const modo = String(req.query.download || '') === '1' ? 'attachment' : 'inline';
      res.setHeader('Content-Disposition', `${modo}; filename="${nomeArq}.pdf"`);
      pedidoPdf.gerar(res, pedido, emitente);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/pedidos/:id/historico', (req, res) => {
    try {
      const rows = db.prepare(`SELECT * FROM pedido_historico WHERE pedidoId = ? ORDER BY dataCriacao DESC, id DESC`).all(req.params.id);
      res.json({ success: true, historico: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== PARCELAS DE PAGAMENTO ====================
  // Parcelas heterogêneas (meios + vencimentos diferentes) que geram N CRs ao faturar.
  // Se não houver linhas em pedido_parcelas, usa o fluxo clássico (pedido.meioPagamento único → 1 CR).

  app.get('/api/pedidos/:id/parcelas', (req, res) => {
    try {
      const parcelas = db.prepare(`
        SELECT pp.*, a.nome AS bandeiraNome
        FROM pedido_parcelas pp
        LEFT JOIN adquirentes_cartao a ON a.id = pp.bandeiraId
        WHERE pp.pedidoId = ? ORDER BY pp.numeroParcela ASC
      `).all(req.params.id);
      res.json({ success: true, parcelas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // PUT substitui por completo a lista de parcelas do pedido (com validação)
  app.put('/api/pedidos/:id/parcelas', (req, res) => {
    try {
      const ped = db.prepare('SELECT * FROM pedidos WHERE id = ?').get(req.params.id);
      if (!ped) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (['faturado', 'cancelado'].includes(ped.status)) {
        return res.status(400).json({ success: false, error: `Pedido ${ped.status} — parcelas não podem ser alteradas` });
      }

      const parcelas = Array.isArray(req.body?.parcelas) ? req.body.parcelas : [];
      const MEIOS_CARTAO = new Set(['03', '04']);
      // Normaliza e valida cada parcela
      const norm = parcelas.map((p, i) => {
        const valor = Number(p.valor);
        if (!(valor > 0)) throw new Error(`Parcela ${i + 1}: valor inválido`);
        if (!p.dataVencimento) throw new Error(`Parcela ${i + 1}: data de vencimento obrigatória`);
        if (!p.meioPagamento) throw new Error(`Parcela ${i + 1}: meio de pagamento obrigatório`);
        if (MEIOS_CARTAO.has(p.meioPagamento) && !p.bandeiraId) {
          throw new Error(`Parcela ${i + 1}: bandeira do cartão obrigatória`);
        }
        assertMeioPermitido(db, ped.clienteId, p.meioPagamento, `Parcela ${i + 1}: `);
        return {
          numeroParcela: i + 1,
          valor: Number(valor.toFixed(2)),
          dataVencimento: p.dataVencimento,
          meioPagamento: p.meioPagamento,
          bandeiraId: p.bandeiraId ? Number(p.bandeiraId) : null,
          observacao: p.observacao || null
        };
      });

      if (norm.length) {
        // Valor mínimo da parcela vem da política de prazo do cliente. Sem essa
        // checagem aqui, a regra existiria só no aviso da tela.
        const { vinculoDaPessoa, valePara } = require('./politicas-prazo');
        const { politica } = vinculoDaPessoa(db, ped.clienteId);
        const minimo = valePara(politica, 'vendas') ? Number(politica.valorMinimoParcela) || 0 : 0;
        if (minimo > 0) {
          const i = norm.findIndex(p => p.valor < minimo);
          if (i >= 0) {
            return res.status(400).json({
              success: false,
              error: `Parcela ${i + 1} (R$ ${norm[i].valor.toFixed(2)}) abaixo do mínimo de R$ ${minimo.toFixed(2)} da política "${politica.nome}"`,
            });
          }
        }
        const soma = Number(norm.reduce((s, p) => s + p.valor, 0).toFixed(2));
        const total = Number((ped.valorTotal || 0).toFixed(2));
        if (Math.abs(soma - total) > 0.01) {
          return res.status(400).json({
            success: false,
            error: `Soma das parcelas (R$ ${soma.toFixed(2)}) difere do total do pedido (R$ ${total.toFixed(2)})`
          });
        }
      }

      const tx = db.transaction(() => {
        db.prepare('DELETE FROM pedido_parcelas WHERE pedidoId = ?').run(req.params.id);
        const ins = db.prepare(`INSERT INTO pedido_parcelas
          (pedidoId, numeroParcela, valor, dataVencimento, meioPagamento, bandeiraId, observacao)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const p of norm) {
          ins.run(req.params.id, p.numeroParcela, p.valor, p.dataVencimento,
                  p.meioPagamento, p.bandeiraId, p.observacao);
        }
      });
      tx();

      res.json({ success: true, parcelas: norm });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  /**
   * DESCONTINUADO em 2026-09-10 — responde 410 Gone e não grava nada.
   *
   * O que fazia: `pedidos.valorPago += valor`, direto. Sem criar
   * `contas_a_receber`, sem `contas_receber_pagamentos`, sem lançar
   * `movimentacoes_financeiras` e sem `audit_log`. O pedido dizia "pago" e o
   * financeiro não tinha o recebimento — nenhum relatório enxergava o dinheiro.
   *
   * E não era idempotente: `valorPago + valor` a cada chamada, sem chave e sem
   * vínculo com um evento de pagamento. Dois toques, dobro. Pior: assim que
   * qualquer CR daquele pedido sofresse baixa, `sincronizarPagamentoPedido`
   * recalculava do zero a partir das contas e apagava o lançamento manual.
   *
   * Auditoria de 2026-09-10 (relatório 07 §6, confirmada no 08 §1): NENHUM
   * consumidor no repositório — nenhuma tela, nenhum script, nenhuma integração
   * — e nenhum dos pedidos com `valorPago > 0` na base veio daqui.
   *
   * O caminho correto já existe e é o do financeiro: `contas_a_receber` com
   * `pedidoId` + `registrarBaixaCR`, que cria o pagamento, lança no caixa, tem
   * estorno, é idempotente e — desde 2026-09-10 — reflete em
   * `pedidos.valorPago` sozinho.
   *
   * 410 e não 404: o endereço existiu, a recusa é deliberada e permanente. Um
   * cliente esquecido descobre pela resposta, em vez de achar que digitou
   * errado. Nada de redirecionar em silêncio para o fluxo novo — as semânticas
   * são diferentes e o chamador precisa decidir.
   */
  app.post('/api/pedidos/:id/registrar-pagamento', (req, res) => {
    // Registra a tentativa reusando o logAction que o módulo já usa; ele exige
    // req.user, então chamada por X-Api-Key não gera linha — e é por isso que
    // o console.warn fica junto, para o caso do cliente sem sessão.
    console.warn('[pedidos] tentativa em endpoint descontinuado: registrar-pagamento, pedido', req.params.id);
    try {
      logAction(db, req, 'endpoint-descontinuado', 'pedido', Number(req.params.id) || null,
        { endpoint: 'POST /api/pedidos/:id/registrar-pagamento', valorEnviado: req.body?.valor ?? null });
    } catch { /* auditoria não pode impedir a resposta */ }
    res.status(410).json({
      success: false,
      error: 'Endpoint descontinuado. Utilize o fluxo financeiro de contas a receber.',
      alternativa: 'Crie a conta a receber com pedidoId e dê baixa por /api/contas-a-receber/:id/baixar',
    });
  });

  // ==================== LOOKUP: participações vencidas (para o modal de import) ====================

  app.get('/api/pedidos/lookup/participacoes', (req, res) => {
    try {
      // Todas as participações ativas; o cliente escolhe qual importar.
      const { q } = req.query;
      let sql = `SELECT id, compraId, cnpj, ano, sequencial, numero, orgao, objeto, etapa, situacao, dataSessao
                 FROM participacoes_comprasnet WHERE ativo = 1`;
      const params = [];
      if (q) {
        sql += ' AND (objeto LIKE ? OR orgao LIKE ? OR numero LIKE ? OR compraId LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      sql += ' ORDER BY dataSessao DESC, id DESC LIMIT 100';
      const participacoes = db.prepare(sql).all(...params);
      res.json({ success: true, participacoes });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ADQUIRENTES (BANDEIRAS) DE CARTÃO ====================

  app.get('/api/adquirentes', (req, res) => {
    try {
      const { ativo, q } = req.query;
      let sql = `SELECT a.*, cf.nome AS contaFinanceiraPadraoNome
                 FROM adquirentes_cartao a
                 LEFT JOIN contas_financeiras cf ON cf.id = a.contaFinanceiraPadraoId
                 WHERE 1=1`;
      const p = [];
      if (ativo !== undefined) { sql += ' AND a.ativo = ?'; p.push(Number(ativo)); }
      else { sql += ' AND a.ativo = 1'; }
      if (q) { sql += ' AND a.nome LIKE ?'; p.push('%' + q + '%'); }
      sql += ' ORDER BY a.nome ASC';
      res.json({ success: true, adquirentes: db.prepare(sql).all(...p) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/adquirentes/autocomplete', (req, res) => {
    try {
      const q = req.query.q || '';
      const rows = db.prepare(
        `SELECT id, nome, cnpj, taxaPercentual, prazoLiquidacaoDias
         FROM adquirentes_cartao
         WHERE ativo = 1 AND nome LIKE ? ORDER BY nome ASC LIMIT 15`
      ).all('%' + q + '%');
      res.json({ success: true, adquirentes: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/adquirentes/:id', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM adquirentes_cartao WHERE id = ?').get(req.params.id);
      if (!a) return res.status(404).json({ success: false, error: 'Adquirente não encontrado' });
      res.json({ success: true, adquirente: a });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/adquirentes', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const r = db.prepare(`INSERT INTO adquirentes_cartao
        (nome, cnpj, taxaPercentual, prazoLiquidacaoDias, contaFinanceiraPadraoId, observacoes)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        b.nome, b.cnpj || null,
        Number(b.taxaPercentual) || 0,
        Number(b.prazoLiquidacaoDias) || 0,
        b.contaFinanceiraPadraoId ? Number(b.contaFinanceiraPadraoId) : null,
        b.observacoes || null
      );
      res.json({ success: true, adquirente: db.prepare('SELECT * FROM adquirentes_cartao WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/adquirentes/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM adquirentes_cartao WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Adquirente não encontrado' });
      const b = req.body || {};
      db.prepare(`UPDATE adquirentes_cartao SET
        nome = COALESCE(?, nome),
        cnpj = ?,
        taxaPercentual = ?,
        prazoLiquidacaoDias = ?,
        contaFinanceiraPadraoId = ?,
        observacoes = ?,
        ativo = COALESCE(?, ativo),
        dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        b.nome || null,
        b.cnpj !== undefined ? (b.cnpj || null) : existing.cnpj,
        b.taxaPercentual !== undefined ? Number(b.taxaPercentual) : existing.taxaPercentual,
        b.prazoLiquidacaoDias !== undefined ? Number(b.prazoLiquidacaoDias) : existing.prazoLiquidacaoDias,
        b.contaFinanceiraPadraoId !== undefined ? (b.contaFinanceiraPadraoId ? Number(b.contaFinanceiraPadraoId) : null) : existing.contaFinanceiraPadraoId,
        b.observacoes !== undefined ? (b.observacoes || null) : existing.observacoes,
        b.ativo != null ? (b.ativo ? 1 : 0) : null,
        req.params.id
      );
      res.json({ success: true, adquirente: db.prepare('SELECT * FROM adquirentes_cartao WHERE id = ?').get(req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/adquirentes/:id', (req, res) => {
    try {
      db.prepare('UPDATE adquirentes_cartao SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
        .run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== TRANSPORTADORAS ====================

  const CAMPOS_TRANSP = [
    'cpfCnpj','razaoSocial','nomeFantasia','rntrc','placa','inscricaoEstadual',
    'endereco','numero','complemento','bairro','cidade','uf','cep','codigoMunicipio',
    'telefone','email','contato','observacoes'
  ];

  app.get('/api/transportadoras', (req, res) => {
    try {
      const { q, ativo } = req.query;
      let sql = 'SELECT * FROM transportadoras WHERE 1=1';
      const params = [];
      if (ativo !== undefined) { sql += ' AND ativo = ?'; params.push(Number(ativo)); }
      else { sql += ' AND ativo = 1'; }
      if (q) {
        sql += ' AND (cpfCnpj LIKE ? OR razaoSocial LIKE ? OR nomeFantasia LIKE ?)';
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      sql += ' ORDER BY razaoSocial ASC';
      const transportadoras = db.prepare(sql).all(...params);
      res.json({ success: true, transportadoras });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/transportadoras/autocomplete', (req, res) => {
    try {
      const q = req.query.q || '';
      if (q.length < 2) return res.json({ success: true, transportadoras: [] });
      const like = `%${q}%`;
      const transportadoras = db.prepare(
        `SELECT id, cpfCnpj, razaoSocial, nomeFantasia FROM transportadoras
         WHERE ativo = 1 AND (cpfCnpj LIKE ? OR razaoSocial LIKE ? OR nomeFantasia LIKE ?)
         ORDER BY razaoSocial ASC LIMIT 15`
      ).all(like, like, like);
      res.json({ success: true, transportadoras });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/transportadoras/:id', (req, res) => {
    try {
      const t = db.prepare('SELECT * FROM transportadoras WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Transportadora nao encontrada' });
      res.json({ success: true, transportadora: t });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/transportadoras', (req, res) => {
    try {
      const b = req.body;
      if (!b.cpfCnpj || !b.razaoSocial) {
        return res.status(400).json({ success: false, error: 'cpfCnpj e razaoSocial obrigatorios' });
      }
      const cpfLimpo = b.cpfCnpj.replace(/\D/g, '');
      const exist = db.prepare('SELECT * FROM transportadoras WHERE cpfCnpj = ?').get(cpfLimpo);
      if (exist) {
        if (!exist.ativo) {
          db.prepare('UPDATE transportadoras SET ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(exist.id);
          return res.json({ success: true, transportadora: db.prepare('SELECT * FROM transportadoras WHERE id = ?').get(exist.id) });
        }
        return res.status(409).json({ success: false, error: 'Transportadora ja cadastrada', transportadora: exist });
      }
      const vals = CAMPOS_TRANSP.map(c => {
        if (c === 'cpfCnpj') return cpfLimpo;
        const v = b[c];
        return v === undefined || v === '' ? null : v;
      });
      const placeholders = CAMPOS_TRANSP.map(() => '?').join(',');
      const result = db.prepare(`INSERT INTO transportadoras (${CAMPOS_TRANSP.join(',')}) VALUES (${placeholders})`).run(...vals);
      const transportadora = db.prepare('SELECT * FROM transportadoras WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, transportadora });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/transportadoras/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM transportadoras WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Transportadora nao encontrada' });
      const b = req.body;
      const sets = [];
      const vals = [];
      for (const c of CAMPOS_TRANSP) {
        if (c === 'cpfCnpj') continue;
        if (b[c] === undefined) continue;
        sets.push(`${c} = ?`);
        vals.push(b[c] === '' ? null : b[c]);
      }
      if (sets.length) {
        sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
        vals.push(req.params.id);
        db.prepare(`UPDATE transportadoras SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      const transportadora = db.prepare('SELECT * FROM transportadoras WHERE id = ?').get(req.params.id);
      res.json({ success: true, transportadora });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/transportadoras/:id', (req, res) => {
    try {
      const result = db.prepare('UPDATE transportadoras SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ? AND ativo = 1').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ success: false, error: 'Transportadora nao encontrada' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

// gerarNumero e recalcularTotal saem daqui para a loja virtual criar pedido
// pelo mesmo caminho. Duplicar a numeração noutro módulo produziria número
// repetido assim que dois pedidos nascessem juntos.
module.exports = {
  registrarRotasPedidos, gerarNumero, recalcularTotal, erroValorFrete, erroQuantidade,
  /**
   * Confirma um pedido pelo caminho canônico. Mesma função que
   * `POST /api/pedidos/:id/confirmar` usa — validações, alçada, reserva de
   * estoque e transação inclusive.
   *
   * A guarda não é formalidade: chamada antes do registro das rotas, a
   * referência é `null`, e falhar dizendo o motivo é melhor que um
   * `TypeError` a três camadas de distância.
   */
  confirmarPedidoInterno(pedId, opts) {
    if (!_confirmarPedidoInterno) {
      throw new Error('confirmarPedidoInterno: rotas de pedidos ainda não foram registradas');
    }
    return _confirmarPedidoInterno(pedId, opts);
  },
};
