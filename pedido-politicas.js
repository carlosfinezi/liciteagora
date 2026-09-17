/**
 * pedido-politicas.js — decisões do pedido que dependem de QUEM está chamando.
 *
 * Existe por causa do app móvel de vendas, mas não é dele: são as regras que
 * antes moravam implícitas no frontend e, por isso, valiam apenas enquanto o
 * frontend fosse a tela web. Com uma segunda interface (celular do vendedor),
 * "o cliente manda o preço" e "o cliente manda o vendedorId" deixam de ser
 * detalhes e viram buracos.
 *
 * Três decisões, uma fonte só:
 *
 *   precoDeItem()        — qual preço vale neste item (usa resolverPreco)
 *   resolverVendedor()   — de quem é o pedido
 *   escopoVendedor()     — quais pedidos este usuário enxerga
 *
 * O que NÃO muda aqui, de propósito:
 *   - chamada por X-Api-Key (sem req.user) mantém o comportamento antigo em
 *     tudo. O Electron e as integrações existentes não podem quebrar por causa
 *     de um app que ainda não existe.
 *   - loja virtual, OS e marketplaces têm INSERT próprio em pedido_itens e não
 *     passam por aqui (ver docs/auditoria-app-mobile-2026-08-26/01, §7.5).
 */

const { resolverPreco } = require('./precos-routes');
const { acessoDoUsuario } = require('./perfis-acesso');

/**
 * Origem do pedido — o vocabulário vive em `pedidos.tipo`.
 *
 * Auditado em 2026-09-10 antes de reusar a coluna (relatório 12): `pedidos.tipo`
 * **não é consumido por nenhum filtro, relatório, BI, comissão, meta,
 * faturamento ou integração**. O único consumidor é a exibição do badge em
 * `public/comercial/pedido.html:1154`, que imprime o valor cru e não tem CSS por
 * valor. Valor novo aparece como texto, sem estilo — não quebra nada.
 *
 * Por isso a origem NÃO ganhou coluna própria: `tipo` já é semanticamente o
 * lugar certo, e uma coluna a mais seria redundância com dois lugares para
 * divergir.
 *
 * Valores em produção nos 13 tenants (2026-09-10): `manual` 48, `os` 10,
 * `marketplace` 4, `licitacao` 2. Nenhum outro.
 *
 * ORIGENS_CLIENTE é o que um cliente HTTP pode DECLARAR no corpo. As demais —
 * 'licitacao', 'os', 'marketplace', 'catalogo' — são gravadas pelos caminhos
 * internos que as produzem; aceitá-las do corpo deixaria forjar procedência.
 * 'pdv' entra aqui porque o Pedidos PDV é área interna autenticada, e quem a
 * alcança já podia criar pedido manual — declarar a origem não amplia poder.
 */
const ORIGENS_CLIENTE = ['manual', 'app', 'pdv'];

// Vocabulário completo, para telas e relatórios traduzirem sem inventar rótulo.
// Não valida nada: é catálogo de exibição.
const ORIGENS_PEDIDO = {
  manual: 'ERP',
  pdv: 'Pedidos PDV',
  catalogo: 'Catálogo Online',
  app: 'App de vendas',
  marketplace: 'Marketplace',
  os: 'Ordem de Serviço',
  licitacao: 'Licitação',
};

// Páginas cujo titular administra meta e comissão — quem faz isso é quem
// legitimamente reatribui uma venda a outro vendedor. Não é permissão nova:
// sai do cadastro de perfis que já existe.
const PAGINAS_DELEGA_VENDEDOR = ['comercial-metas', 'comissoes'];

/**
 * Política de preço do tenant, em `config.preco_politica`:
 *
 *   'auditar' (padrão)  resolve o preço quando o cliente não informa; aceita o
 *                       informado, mas registra em audit_log quando ele fica
 *                       abaixo do sugerido ou do piso.
 *   'estrito'           idem, e RECUSA (422) abaixo do piso para quem não pode
 *                       furar. Ligar por tenant, depois de sanear o cadastro.
 *
 * O padrão não bloqueia porque o dado real não sustenta bloqueio hoje: no 1bit,
 * 4 dos 8 itens com piso cadastrado estão abaixo dele (todos do produto de
 * exemplo SKU-001). Em cadastro saneado — produtosbomgosto, 416 itens, todos
 * com piso — a violação é zero. Ver 04-backend-preparado-para-app.md §4.
 */
function politicaPreco(db) {
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave = 'preco_politica'").get();
    return row && row.valor === 'estrito' ? 'estrito' : 'auditar';
  } catch { return 'auditar'; }
}

/**
 * Ator irrestrito: admin, chamada de sistema (X-Api-Key) ou usuário cujo role
 * não tem perfil cadastrado — o fail-open que perfis-acesso.js:99-107 já aplica
 * ao sistema inteiro. Reproduzido aqui para não divergir dele.
 */
function atorIrrestrito(db, req) {
  if (!req || !req.user) return true;                 // X-Api-Key = sistema
  if (req.user.role === 'admin') return true;
  try {
    return !!acessoDoUsuario(db, req.user).irrestrito;
  } catch { return true; }                            // falha ao ler perfil não tranca
}

/** Quem pode gravar um pedido em nome de OUTRO vendedor. */
function podeDelegarVendedor(db, req) {
  if (atorIrrestrito(db, req)) return true;
  try {
    const paginas = acessoDoUsuario(db, req.user).paginas || [];
    return PAGINAS_DELEGA_VENDEDOR.some((p) => paginas.includes(p));
  } catch { return true; }
}

/** Quem pode vender abaixo do preço mínimo do produto. */
function podeFurarPiso(db, req) {
  return atorIrrestrito(db, req);
}

/**
 * Vendedor restrito: só enxerga e só assume os próprios pedidos.
 * É o vendedor com perfil cadastrado que não administra meta/comissão —
 * exatamente o perfil que o app vai usar.
 */
function vendedorRestrito(db, req) {
  return !!(req && req.user && req.user.ehVendedor === 1 && !podeDelegarVendedor(db, req));
}

/**
 * De quem é o pedido.
 *
 * Antes: `body.vendedorId != null ? Number(body.vendedorId) : req.session.userId`
 * — o corpo vencia a sessão, sem validação nenhuma. Um JSON bastava para lançar
 * a venda (e a comissão) na conta de outra pessoa.
 *
 * Agora o corpo só vence quando quem chama pode delegar. Para os demais o campo
 * é IGNORADO, não recusado: a tela web sempre envia `vendedorId` no PUT, mesmo
 * quando é o próprio usuário, e um 403 quebraria a tela no instante em que isto
 * subisse.
 *
 * @returns { vendedorId, delegado, ignorado }
 */
function resolverVendedor(db, req, valorInformado, valorAtual = null) {
  const daSessao = (req && req.session && req.session.userId) || null;
  const informado = valorInformado != null && valorInformado !== ''
    ? (Number(valorInformado) || null)
    : null;

  // Sem sessão (X-Api-Key): comportamento antigo, intacto.
  if (!req || !req.user) {
    return { vendedorId: informado != null ? informado : (valorAtual ?? daSessao), delegado: false, ignorado: false };
  }
  if (informado == null) {
    return { vendedorId: valorAtual != null ? valorAtual : daSessao, delegado: false, ignorado: false };
  }
  if (informado === daSessao) {
    return { vendedorId: informado, delegado: false, ignorado: false };
  }
  if (podeDelegarVendedor(db, req)) {
    return { vendedorId: informado, delegado: true, ignorado: false };
  }
  // Não pode delegar: o campo some, sem erro.
  return { vendedorId: valorAtual != null ? valorAtual : daSessao, delegado: false, ignorado: true };
}

/**
 * Recorte de pedidos que este usuário pode ver.
 *
 * `meus=1` na query pede o recorte; vendedor restrito recebe o recorte queira ou
 * não. Em nenhum dos dois casos o `vendedorId` da query amplia o acesso — ele só
 * é honrado para quem já podia ver todos.
 *
 * @returns { sql, params, escopo }
 */
function escopoVendedor(db, req, query = {}) {
  const daSessao = (req && req.session && req.session.userId) || null;
  const pediuMeus = query.meus === '1' || query.meus === 1 || query.meus === 'true';

  if (vendedorRestrito(db, req)) {
    return { sql: ' AND p.vendedorId = ?', params: [daSessao], escopo: 'proprio' };
  }
  if (pediuMeus && daSessao) {
    return { sql: ' AND p.vendedorId = ?', params: [daSessao], escopo: 'proprio' };
  }
  if (query.vendedorId) {
    return { sql: ' AND p.vendedorId = ?', params: [Number(query.vendedorId)], escopo: 'filtrado' };
  }
  return { sql: '', params: [], escopo: 'todos' };
}

/**
 * Preço oficial de um item de pedido — fonte única para qualquer canal.
 *
 * Antes: os três pontos que gravam `precoUnitario` (pedidos-routes.js:361, 719,
 * 744) inseriam o número que viesse no corpo, sem comparar com nada. Preço
 * negativo passava; preço abaixo do custo passava; `resolverPreco` só era
 * consultado pela TELA, para preencher o campo.
 *
 * Agora:
 *   - VENDEDOR RESTRITO → o corpo NUNCA decide preço. O servidor resolve, e o
 *     `precoInformado` é ignorado (não recusado — a tela web sempre manda o
 *     campo, e um 403 quebraria a tela). Vale igual em 'auditar' e 'estrito':
 *     a política de preço cuida de piso e auditoria de QUEM pode escolher
 *     preço; quem não pode, não escolhe em nenhum dos dois modos.
 *   - demais atores, `precoInformado` ausente  → o servidor resolve;
 *   - demais atores, `precoInformado` presente → vale, mas é comparado com o
 *     sugerido e com o piso do produto, e a diferença vira registro (ou recusa,
 *     no modo estrito).
 *
 * O contexto de preço (cliente e tabela) vem do PEDIDO, nunca do corpo — se
 * viesse do corpo, o cliente escolheria a tabela mais barata e a validação seria
 * teatro.
 *
 * Item sem `produtoId` (serviço, desconto de capa da OS) não tem preço a
 * resolver: passa direto, como sempre passou — menos para o vendedor restrito,
 * para quem seria o contorno óbvio da regra (um item avulso "Desconto" com
 * valor negativo derruba o total do pedido sem passar por preço nenhum). O
 * desconto de capa da OS não perde nada: ele grava em `pedido_itens` pelo
 * caminho próprio de os-routes.js, que não passa por aqui.
 *
 * @returns { ok, preco, fonte, sugerido, piso, desconto, motivo, precoIgnorado, erro }
 */
function precoDeItem(db, { pedido, produtoId, quantidade, precoInformado, req }) {
  const qtd = Number(quantidade) || 0;
  const informado = precoInformado === '' || precoInformado == null ? null : Number(precoInformado);
  const restrito = vendedorRestrito(db, req);

  // Item livre (sem produto): comportamento antigo, sem resolução.
  if (!produtoId) {
    if (restrito) {
      return { ok: false, erro: 'Item sem produto cadastrado não é permitido para vendedor.' };
    }
    if (informado == null || Number.isNaN(informado)) {
      return { ok: false, erro: 'precoUnitario obrigatorio para item sem produto' };
    }
    return { ok: true, preco: informado, fonte: 'livre', sugerido: null, piso: null, desconto: false };
  }

  let sugestao;
  try {
    sugestao = resolverPreco(db, Number(produtoId), {
      pessoaId: (pedido && pedido.clienteId) || null,
      quantidade: qtd > 0 ? qtd : 1,
      tabelaId: (pedido && pedido.tabelaPrecoId) || null,
    });
  } catch (e) {
    // Resolver falhou (tenant sem tabelas_preco, por exemplo). Para quem pode
    // informar preço, cai no informado, como antes. Para o vendedor restrito
    // não: cair no informado transformaria a falha do resolver no bypass da
    // regra — sem preço oficial, não há item.
    if (restrito) {
      return { ok: false, sugerido: null, piso: null, motivo: e.message,
        erro: 'Não foi possível determinar o preço oficial do produto — item não gravado' };
    }
    return { ok: true, preco: informado, fonte: 'indisponivel', sugerido: null, piso: null,
      desconto: false, motivo: e.message };
  }

  let piso = null;
  try {
    const p = db.prepare('SELECT precoMinimoVenda FROM produtos WHERE id = ?').get(Number(produtoId));
    piso = p && p.precoMinimoVenda != null && Number(p.precoMinimoVenda) > 0 ? Number(p.precoMinimoVenda) : null;
  } catch { /* tenant sem a coluna */ }

  const sugerido = Number(sugestao.preco) || 0;

  // Caminho do app: sem preço informado, manda o servidor. O vendedor restrito
  // cai aqui SEMPRE, tenha mandado preço ou não — `precoIgnorado` carrega o que
  // veio no corpo só para virar registro em audit_log.
  if (restrito || informado == null || Number.isNaN(informado)) {
    const ignorado = restrito && informado != null && !Number.isNaN(informado) && informado !== sugerido
      ? informado : null;
    return { ok: true, preco: sugerido, fonte: sugestao.fonte,
      sugerido, piso, desconto: false, resolvido: true, precoIgnorado: ignorado };
  }

  const abaixoDoSugerido = sugerido > 0 && informado < sugerido;
  const abaixoDoPiso = piso != null && informado < piso;

  if (abaixoDoPiso && politicaPreco(db) === 'estrito' && !podeFurarPiso(db, req)) {
    return { ok: false, sugerido, piso, fonte: sugestao.fonte,
      erro: `Preço ${informado.toFixed(2)} abaixo do mínimo ${piso.toFixed(2)} do produto` };
  }

  return { ok: true, preco: informado, fonte: sugestao.fonte, sugerido, piso,
    desconto: abaixoDoSugerido || abaixoDoPiso, abaixoDoPiso };
}

module.exports = {
  ORIGENS_CLIENTE,
  ORIGENS_PEDIDO,
  politicaPreco,
  // Exportado em 2026-09-10 para a alçada de desconto (pedido-desconto.js) usar
  // a MESMA noção de ator privilegiado que o preço e o vendedor já usam. Uma
  // segunda definição no mesmo fluxo é como nascem divergências de permissão.
  atorIrrestrito,
  podeDelegarVendedor,
  podeFurarPiso,
  vendedorRestrito,
  resolverVendedor,
  escopoVendedor,
  precoDeItem,
};
