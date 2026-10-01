/**
 * os-rotulos.js — o nome que o status da OS tem na tela.
 *
 * As chaves do banco ('aguardando-peca', 'em-andamento') chegavam cruas ao
 * usuário: sem acento, com hífen e em caixa alta dentro do badge, viravam
 * "AGUARDANDO-PECA". Quem lê não é quem escreveu o schema.
 *
 * Mora aqui, e não em cada tela, porque são cinco que mostram status de OS
 * (lista, ficha, equipamento e as duas do portal do cliente) e um mapa
 * repetido cinco vezes diverge na primeira chave nova.
 *
 * Carregue antes do script da página:
 *   <script src="/js/os-rotulos.js"></script>
 */
(function (global) {
  'use strict';

  var STATUS = {
    'rascunho':        'Rascunho',
    'orcamento':       'Orçamento',
    'aberta':          'Aberta',
    'em-andamento':    'Em andamento',
    'aguardando-peca': 'Aguardando peça',
    'concluida':       'Concluída',
    'faturada':        'Faturada',
    'cancelada':       'Cancelada',
  };

  // O que a OS tem de documento fiscal. Aparece em letra miúda sob o status.
  var FISCAL = {
    'pendente':       'sem nota',
    'emitida':        'com nota',
    'autorizada':     'com nota',
    'mista_parcial':  'nota parcial',
    'rejeitada':      'nota rejeitada',
    'cancelada':      'nota cancelada',
  };

  var SLA = {
    'atrasado':  'Atrasado',
    'risco':     'Em risco',
    'no-prazo':  'No prazo',
    'cumprido':  'Cumprido',
    'estourado': 'Fora do prazo',
  };

  // Chave desconhecida não pode sumir da tela: vira texto legível
  // ('aguardando-peca' → 'Aguardando peca'), que é melhor do que vazio.
  function humanizar(chave) {
    if (!chave) return '';
    var t = String(chave).replace(/[-_]+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  global.OsRotulos = {
    STATUS: STATUS,
    SLA: SLA,
    status: function (s) { return STATUS[s] || humanizar(s); },
    fiscal: function (s) { return s ? (FISCAL[s] || humanizar(s)) : ''; },
    sla: function (s) { return SLA[s] || humanizar(s); },
  };
})(window);
