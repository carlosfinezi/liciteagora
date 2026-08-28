/**
 * producao-vocab.js — rótulos do módulo Produção conforme o perfil de indústria.
 *
 * O núcleo do módulo é neutro de segmento, mas a tela precisa falar a língua da
 * fábrica: quem faz pré-moldado chama o recurso de "forma/pista" e o lote de
 * "betonada"; uma metalúrgica chama de "máquina" e "corrida".
 *
 * A alternativa seria duplicar as telas por segmento. Duas telas iguais
 * divergem na terceira correção — então aqui a tela é uma só e troca só o
 * texto, marcado com `data-vocab="chave"`:
 *
 *     <h1 data-vocab="recursos">Recursos produtivos</h1>
 *
 * O texto que está no HTML é o do perfil genérico e continua servindo se o
 * fetch falhar: a tela nunca fica com rótulo em branco.
 *
 * `data-vocab` troca o texto do elemento. `data-vocab-attr="placeholder:item"`
 * troca um atributo. As CHAVES (`prod_etapas.codigo`, nomes de campo) nunca
 * passam por aqui — rótulo é aparência, não identidade.
 */
(function () {
  let VOCAB = null;

  async function carregarVocabulario() {
    if (VOCAB) return VOCAB;
    try {
      const r = await fetch('/api/producao/vocabulario');
      const j = await r.json();
      VOCAB = (j && j.success && j.vocabulario) ? j.vocabulario : {};
    } catch (_) {
      // Sem rede ou sessão expirada: fica o texto que já está no HTML.
      VOCAB = {};
    }
    return VOCAB;
  }

  /** Palavra do perfil, com o texto do HTML como reserva. */
  function vocab(chave, reserva) {
    return (VOCAB && VOCAB[chave]) || reserva || chave;
  }

  function aplicarVocabulario(raiz) {
    const escopo = raiz || document;
    if (!VOCAB) return;

    escopo.querySelectorAll('[data-vocab]').forEach(el => {
      const v = VOCAB[el.dataset.vocab];
      if (v) el.textContent = v;
    });

    // "placeholder:item" → placeholder recebe o rótulo de `item`
    escopo.querySelectorAll('[data-vocab-attr]').forEach(el => {
      for (const par of el.dataset.vocabAttr.split(',')) {
        const [attr, chave] = par.split(':').map(s => s.trim());
        if (attr && chave && VOCAB[chave]) el.setAttribute(attr, VOCAB[chave]);
      }
    });

    // O título da aba também: ajuda quem trabalha com várias abas abertas.
    if (VOCAB.modulo && document.title.includes('Produção')) {
      document.title = document.title.replace('Produção', VOCAB.modulo);
    }
  }

  /** Carrega e aplica. Chamar no fim do script da tela. */
  async function iniciarVocabulario() {
    await carregarVocabulario();
    aplicarVocabulario();
    return VOCAB;
  }

  window.carregarVocabulario = carregarVocabulario;
  window.aplicarVocabulario = aplicarVocabulario;
  window.iniciarVocabulario = iniciarVocabulario;
  window.vocab = vocab;
})();
