/**
 * loja-capacidades.js — o que esta empresa PODE oferecer na vitrine.
 *
 * A vitrine `/loja/` é uma só, para todos os segmentos. O que aparece nela não
 * se decide por nome, slug ou segmento do tenant: decide-se por CAPACIDADE, e
 * este arquivo é o único lugar que responde quais ela tem.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A fonte é a CONFIGURAÇÃO da empresa, e não o licenciamento
 *
 * Existem duas fontes sobre "esta empresa tem Restaurante":
 *
 *   1. `config.restaurante_enabled` no banco DO TENANT — é o que o ERP usa
 *      hoje, inclusive o cardápio por QR Code, e diz que alguém LIGOU;
 *   2. `module-gate.tenantHasModule()` no control.db — camada de licenciamento
 *      por tier de plano, que diz que a empresa PODERIA ligar.
 *
 * Vale a primeira, e medir as duas nos 23 tenants em 06/10/2026 mostrou que
 * usar a segunda erra nos dois sentidos:
 *
 *   - `josecarloscostafilho`, `produtosbomgosto` e `crsolucoes` OPERAM com o
 *     restaurante ligado e têm módulo efetivo vazio, porque o `plan` gravado
 *     (`basic`, `trial-14`) não está entre os tiers que o `plan-modules`
 *     conhece. Tier desconhecido devolve conjunto VAZIO — o `cantinhoverde`
 *     aparece com zero módulos. Tomar o licenciamento como verdade arrancaria
 *     o Restaurante de três empresas que o usam agora;
 *   - `jaagricola`, `demo2`, `demo3` e os seis sandboxes têm o módulo por
 *     serem de plano alto e NÃO ligaram o restaurante. Deixar o licenciamento
 *     ligar a capacidade poria mesa e garçom na vitrine de quem nunca pediu.
 *
 * Licença não é interruptor. Quem decide o que a vitrine mostra é quem ligou o
 * módulo no ERP; o tier decide se o botão de ligar existe, e essa checagem
 * pertence ao painel, não à vitrine pública. Enquanto os tiers do control.db
 * estiverem inconsistentes, consultá-los aqui só traria o defeito para dentro.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * Fail-safe: na dúvida, DESLIGADO
 *
 * Qualquer leitura que falhe devolve a capacidade desligada, e capacidade
 * desligada é exatamente a vitrine de hoje. Banco sem a tabela `config`, valor
 * ausente, erro de I/O: tudo cai no comportamento atual, nunca num recurso
 * aparecendo sozinho.
 */

/** Lê uma chave da tabela `config` do tenant. Nunca lança. */
function flag(db, chave) {
  try {
    const r = db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave);
    return !!(r && String(r.valor) === '1');
  } catch (_) {
    return false;
  }
}

/** Uma coluna existe na tabela? Usado para capacidade que só nasce com o schema. */
function temColuna(db, tabela, coluna) {
  try {
    return db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
  } catch (_) {
    return false;
  }
}

/**
 * As capacidades desta empresa.
 *
 * @param {object} db banco DO TENANT (em produção é o proxy do contexto).
 *
 * Só o banco do tenant entra: a vitrine pública responde a visitante anônimo e
 * não abre um segundo banco por requisição. É também o que mantém a resposta
 * barata o bastante para o `/loja/api/config`, que toda visita pede.
 */
function capacidadesDaLoja(db) {
  const restaurante = flag(db, 'restaurante_enabled');

  /* As capacidades de INTERFACE abaixo dependem de estrutura que ainda não
     existe. Elas não estão fixadas em `false`: cada uma pergunta pelo que a
     sua fase cria, e por isso passam a responder sozinhas quando a fase
     entrar — sem que ninguém precise voltar aqui para destravá-las. */
  const servicoSalao = temColuna(db, 'loja_config', 'servicoSalao')
    && (() => {
      try {
        const r = db.prepare('SELECT servicoSalao FROM loja_config LIMIT 1').get();
        return !!(r && r.servicoSalao);
      } catch (_) { return false; }
    })();

  return {
    /** Módulo Restaurante operante nesta empresa. Não vai ao público. */
    restaurante,
    /** Atendimento no local. Nasce com `loja_config.servicoSalao`. */
    salao: restaurante && servicoSalao,
    /** Mesa e QR da mesa. Exige salão. */
    mesa: restaurante && servicoSalao,
    /** Chamar garçom. Acompanha a mesa. */
    garcom: restaurante && servicoSalao,
    /** O pedido projeta comanda na cozinha. Nasce com `rest_comandas.pedidoId`. */
    comandaCozinha: restaurante && temColuna(db, 'rest_comandas', 'pedidoId'),
    /** Preço e disponibilidade por canal. Universal: NÃO depende de restaurante. */
    precoPorCanal: temColuna(db, 'produto_preco_canal', 'canal'),
    /** Recusar pedido fora do horário. Nasce com `loja_config.bloquearForaHorario`. */
    bloqueioHorario: temColuna(db, 'loja_config', 'bloquearForaHorario'),
  };
}

/**
 * O recorte que vai para a vitrine pública.
 *
 * `restaurante` fica de fora: a tela precisa saber se desenha "mesa", não que
 * empresa contratou o quê. Payload público não é lugar de dado de contrato.
 */
function capacidadesPublicas(caps) {
  return {
    salao: !!caps.salao,
    mesa: !!caps.mesa,
    garcom: !!caps.garcom,
    comandaCozinha: !!caps.comandaCozinha,
    precoPorCanal: !!caps.precoPorCanal,
    bloqueioHorario: !!caps.bloqueioHorario,
  };
}

module.exports = { capacidadesDaLoja, capacidadesPublicas };
