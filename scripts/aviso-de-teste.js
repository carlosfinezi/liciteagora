/**
 * aviso-de-teste.js — como uma suíte lida com o aviso e a confirmação do sistema.
 *
 * Em 01/10/2026 os 323 `alert()` e 283 `confirm()` do navegador viraram o aviso
 * do sistema (`public/js/aviso-sistema.js`). Isso quebrou dez suítes de uma vez,
 * e por dois motivos diferentes:
 *
 *   1. **O `confirm()` era auto-aceito e ninguém escrevia isso.** O puppeteer
 *      dispensa o diálogo nativo sozinho, então a suíte clicava em "Excluir" e
 *      o fluxo seguia. `Aviso.confirmar` é uma PROMESSA que espera alguém
 *      clicar: sem este módulo, a suíte clica e o fluxo para, com a caixa
 *      aberta na tela. Sintoma típico: "esperava 1 envio, veio 0".
 *   2. **O texto do aviso saía do `dialog` e agora está no DOM.** Quem lia
 *      `d.message()` passou a ler vazio.
 *
 * Uso:
 *
 *     const { prepararAvisos, textoDoAviso, aceitarConfirmacao } = require('./aviso-de-teste');
 *     await prepararAvisos(page);                    // antes do goto
 *     ...
 *     const dito = await textoDoAviso(page);         // o que o sistema disse
 *
 * `prepararAvisos` responde SIM a toda confirmação, que é o que o diálogo
 * nativo fazia. Quando a suíte precisa provar que a confirmação existe (ou
 * recusá-la), use `respostaPadrao: false` e leia `window.__confirmacoes`.
 */

/**
 * Instala o auto-aceite e o registro das confirmações, antes de a página carregar.
 *
 * @param {object} page            página do puppeteer
 * @param {object} [opcoes]
 * @param {boolean} [opcoes.respostaPadrao=true]  o que responder à confirmação
 */
async function prepararAvisos(page, opcoes = {}) {
  const resposta = opcoes.respostaPadrao !== false;
  await page.evaluateOnNewDocument((resp) => {
    /* A peça é carregada por `<script src>` depois disto, então o que se faz
       aqui é esperar por ela e então embrulhar a função — substituir agora
       seria sobrescrito pela peça ao carregar. */
    window.__confirmacoes = [];
    window.__avisos = [];
    let instalado = false;
    const instalar = () => {
      if (instalado || !window.Aviso) return;
      instalado = true;
      const original = window.Aviso.confirmar;
      window.Aviso.confirmar = (o) => {
        const texto = typeof o === 'string' ? o : ((o && o.texto) || '');
        window.__confirmacoes.push(texto);
        return Promise.resolve(resp);
      };
      window.Aviso.__confirmarDeVerdade = original;
      for (const tom of ['ok', 'erro', 'info']) {
        const antes = window.Aviso[tom];
        window.Aviso[tom] = (t, s) => {
          window.__avisos.push({ tom, texto: String(t == null ? '' : t) });
          return antes(t, s);
        };
      }
    };
    /* Duas chances: a peça pode já estar lá (script síncrono antes do nosso
       hook rodar de novo) ou chegar depois. */
    const timer = setInterval(() => { instalar(); if (instalado) clearInterval(timer); }, 10);
    document.addEventListener('DOMContentLoaded', instalar);
    window.addEventListener('load', () => { instalar(); clearInterval(timer); });
  }, resposta);
}

/** O texto do último aviso que o sistema deu — do registro ou do DOM. */
async function textoDoAviso(alvo) {
  return alvo.evaluate(() => {
    const reg = window.__avisos || [];
    if (reg.length) return reg[reg.length - 1].texto;
    const toasts = document.querySelectorAll('#toasts .toast');
    if (!toasts.length) return '';
    return (toasts[toasts.length - 1].textContent || '').replace(/×$/, '').trim();
  });
}

/** Todos os avisos dados até agora, na ordem. */
async function avisosDados(alvo) {
  return alvo.evaluate(() => (window.__avisos || []).slice());
}

/** Os textos das confirmações que a tela pediu, na ordem. */
async function confirmacoesPedidas(alvo) {
  return alvo.evaluate(() => (window.__confirmacoes || []).slice());
}

/**
 * Clica no botão de confirmar da caixa do sistema, para quem quer exercitar a
 * caixa de verdade em vez de auto-aceitar.
 *
 * @returns {boolean} se havia caixa aberta
 */
async function aceitarConfirmacao(alvo, { aceitar = true } = {}) {
  return alvo.evaluate((ok) => {
    const botoes = document.querySelectorAll('.modal-bg.open .modal-actions button');
    if (botoes.length < 2) return false;
    botoes[ok ? 1 : 0].click();
    return true;
  }, aceitar);
}

module.exports = {
  prepararAvisos,
  textoDoAviso,
  avisosDados,
  confirmacoesPedidas,
  aceitarConfirmacao,
};
