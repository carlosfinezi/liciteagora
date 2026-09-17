/**
 * pedido-atendimento.js — como o cliente recebe o que comprou.
 *
 * Nasce com o balcão (Pedidos PDV) e o Catálogo Online: nos dois, "entregar" é
 * uma decisão do momento da venda, e não um dado do cadastro. No ERP tradicional
 * essa pergunta nunca foi feita — o pedido sempre supôs entrega, e o endereço
 * saía do cliente.
 *
 * ── Por que NULL continua válido ────────────────────────────────────────────
 *
 * `pedidos.tipoAtendimento` nasceu NULL em 67 pedidos históricos de 8 tenants
 * (relatório 18). NULL aqui **significa alguma coisa**: "pedido anterior a esta
 * fase, que não declarava atendimento". Não é lacuna a preencher — é informação.
 * Por isso a obrigatoriedade vale só para as origens que nasceram com o conceito
 * (`pdv`, `catalogo`), e nunca retroage.
 *
 * ── Onde a regra é cobrada ──────────────────────────────────────────────────
 *
 * O vocabulário é conferido em toda ESCRITA (criar/atualizar): valor fora da
 * lista é recusado na hora, porque gravar lixo e descobrir depois é pior.
 *
 * A obrigatoriedade é cobrada na CONFIRMAÇÃO, não na criação. Rascunho é
 * rascunho: o PDV monta o pedido item a item e só no fim escolhe o atendimento.
 * Exigir na criação impediria o rascunho de existir; exigir na confirmação
 * garante que nenhuma VENDA saia sem a informação.
 */

/**
 * O vocabulário. Três valores, e a razão de cada um:
 *
 *   no_local  consumo no balcão — não sai da loja. Ex.: lanchonete, ótica que
 *             ajusta na hora.
 *   retirada  o cliente leva depois. A mercadoria fica separada.
 *   entrega   sai para um endereço.
 */
const TIPOS_ATENDIMENTO = ['no_local', 'retirada', 'entrega'];

/** Origens (`pedidos.tipo`) que nasceram declarando atendimento. */
const ORIGENS_EXIGEM_ATENDIMENTO = ['pdv', 'catalogo'];

const ROTULOS = {
  no_local: 'No local',
  retirada: 'Retirada',
  entrega: 'Entrega',
};

/**
 * Vocabulário do valor enviado. Só isso — não julga se era obrigatório.
 *
 * Ausente (`undefined`) devolve null: não foi informado, e isso é tratado na
 * confirmação. String vazia é tratada como "limpar o campo", e é válida: um
 * pedido manual pode legitimamente voltar a não declarar atendimento.
 *
 * @returns {string|null} mensagem de erro, ou null quando serve.
 */
function erroTipoAtendimento(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  if (!TIPOS_ATENDIMENTO.includes(String(valor))) {
    return `tipoAtendimento deve ser ${TIPOS_ATENDIMENTO.join(', ')}`;
  }
  return null;
}

/**
 * A coluna existe neste banco?
 *
 * Todos os 19 tenants a têm (relatório 18) e `db-schema.js` passou a criá-la
 * para os novos. Ainda assim a checagem existe, e não é zelo excessivo: um banco
 * provisionado antes dessa mudança, ou um schema de teste montado à mão, não a
 * tem — e sem esta guarda o INSERT de um pedido estouraria com
 * "no such column", derrubando a criação de pedido inteira por causa de um
 * campo opcional.
 */
function temColuna(db) {
  try {
    return db.prepare('PRAGMA table_info(pedidos)').all().some((c) => c.name === 'tipoAtendimento');
  } catch { return false; }
}

/** A origem deste pedido obriga a declarar atendimento? */
function exigeAtendimento(origem) {
  return ORIGENS_EXIGEM_ATENDIMENTO.includes(String(origem || ''));
}

/**
 * Endereço de entrega utilizável para este pedido.
 *
 * **Reusa os campos que já existem** — `enderecoEntrega`, `cidadeEntrega`,
 * `ufEntrega` e companhia estão em `pedidos` desde antes desta fase, como
 * "override do cadastro do cliente" (`CAMPOS_PEDIDO`). Nenhum campo novo foi
 * criado.
 *
 * E o cadastro do cliente CONTA como endereço válido. Exigir o override no
 * pedido recusaria o caso mais comum e mais legítimo do ERP — cliente com
 * endereço cadastrado, entrega no endereço dele —, que é exatamente como as
 * entregas funcionam hoje. O que se exige é que exista um endereço para onde
 * entregar, não que ele tenha sido redigitado.
 *
 * @returns {{ tem: boolean, fonte: 'pedido'|'cliente'|null }}
 */
function enderecoDeEntrega(db, pedido) {
  const doPedido = String((pedido && pedido.enderecoEntrega) || '').trim();
  if (doPedido) return { tem: true, fonte: 'pedido' };
  if (!pedido || !pedido.clienteId) return { tem: false, fonte: null };
  try {
    const c = db.prepare('SELECT endereco FROM pessoas WHERE id = ?').get(pedido.clienteId);
    const doCliente = String((c && c.endereco) || '').trim();
    if (doCliente) return { tem: true, fonte: 'cliente' };
  } catch { /* tenant sem a coluna: trata como ausente */ }
  return { tem: false, fonte: null };
}

/**
 * O pedido pode virar venda, quanto ao atendimento?
 *
 * Chamado na confirmação. Três regras, e as três só olham o que a origem pede:
 *
 *   1. origem `pdv`/`catalogo` sem `tipoAtendimento` → recusa;
 *   2. `entrega` sem endereço nenhum → recusa;
 *   3. `no_local` e `retirada` → nada a exigir além do cliente, que a
 *      confirmação já cobra para todo pedido desde antes desta fase.
 *
 * O frete **não** é amarrado ao atendimento. A tentação era impor frete zero em
 * `no_local`, mas isso inventaria uma regra que ninguém pediu e quebraria casos
 * legítimos (taxa de serviço lançada como frete, por exemplo). O frete já tem a
 * sua própria invariável, que é não ser negativo (Fase 0).
 *
 * @returns {string|null} mensagem de erro, ou null quando pode seguir.
 */
function erroAtendimentoParaConfirmar(db, pedido) {
  if (!pedido) return null;
  // Sem a coluna não há como declarar atendimento — e exigir o que não se pode
  // informar travaria a confirmação de todo pedido do tenant.
  if (!temColuna(db)) return null;
  const tipo = pedido.tipoAtendimento || null;

  if (!tipo) {
    if (exigeAtendimento(pedido.tipo)) {
      return `Pedido de origem "${pedido.tipo}" exige tipoAtendimento `
        + `(${TIPOS_ATENDIMENTO.join(', ')}) antes de confirmar`;
    }
    return null;                       // ERP tradicional: segue sem declarar
  }

  if (!TIPOS_ATENDIMENTO.includes(tipo)) {
    return `tipoAtendimento "${tipo}" inválido — use ${TIPOS_ATENDIMENTO.join(', ')}`;
  }

  if (tipo === 'entrega' && !enderecoDeEntrega(db, pedido).tem) {
    return 'Atendimento "entrega" exige endereço: preencha o endereço de entrega '
      + 'no pedido ou no cadastro do cliente';
  }

  return null;
}

module.exports = {
  TIPOS_ATENDIMENTO,
  ORIGENS_EXIGEM_ATENDIMENTO,
  ROTULOS,
  temColuna,
  erroTipoAtendimento,
  exigeAtendimento,
  enderecoDeEntrega,
  erroAtendimentoParaConfirmar,
};
