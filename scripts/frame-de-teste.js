/**
 * frame-de-teste.js — o iframe da tela se ESPERA, não se supõe.
 *
 * As telas do ERP rodam dentro do iframe do shell (`app.html`), e a suíte pega
 * o frame com `page.frames().find(...)` depois de um `goto`. O problema é o
 * instante: `waitUntil: 'networkidle2'` olha as conexões do SHELL, e o iframe
 * pode ainda estar navegando quando ele dispara. O `find` devolve `undefined`,
 * e o que se lê no log não se parece nada com a causa — "iframe carregou"
 * reprovando com a tela intacta, ou
 * "Cannot read properties of undefined (reading 'waitForSelector')".
 *
 * Isso era latente e virou provável em 02/10/2026, quando cada tela do ERP
 * passou a carregar o `aviso-sistema.js`: medido na `producao/ordens.html`, um
 * request a mais levou a mediana do load de 373 para 446ms, com o pior caso
 * indo de 491 para 843ms. Sozinha a suíte passa; sob os quatro trabalhadores
 * do verify, reprovava uma vez a cada tantas rodadas, em suíte diferente.
 *
 * Devolve `undefined` quando o frame não aparece no prazo, igual ao `find` que
 * substitui: quem chama decide se isso é `assert` ou exceção, e a reprovação
 * continua acontecendo quando o iframe de fato não carrega.
 *
 * O predicado é o da própria suíte, repetido sem mudança: há telas em que a URL
 * do shell também casa com o nome do arquivo (ele vai no hash ou no query
 * string), e quem resolve isso é o predicado de lá, não esta função.
 */

/**
 * @param {object} page        página do puppeteer
 * @param {Function} predicado o mesmo que iria no `page.frames().find(...)`
 * @param {object} [opcoes]
 * @param {number} [opcoes.timeout=5000] prazo total, em ms
 * @param {number} [opcoes.passo=100]    intervalo entre tentativas, em ms
 */
async function esperarFrame(page, predicado, opcoes = {}) {
  const timeout = opcoes.timeout || 5000;
  const passo = opcoes.passo || 100;
  const busca = () => page.frames().find(predicado);
  let f = busca();
  for (let i = 0; !f && i * passo < timeout; i++) {
    await new Promise((r) => setTimeout(r, passo));
    f = busca();
  }
  return f;
}

module.exports = { esperarFrame };

/* Prova por execução, sem navegador: node scripts/frame-de-teste.js */
if (require.main === module) {
  const assert = require('assert');
  (async () => {
    // Acha de primeira, sem esperar.
    const jaEsta = { frames: () => [{ url: () => '/a/alvo.html' }] };
    const t0 = Date.now();
    assert.ok(await esperarFrame(jaEsta, (f) => f.url().includes('alvo.html')));
    assert.ok(Date.now() - t0 < 60, 'frame presente não deve custar espera');

    // Aparece no caminho: é este o caso que o `find` sozinho perdia.
    let n = 0;
    const atrasado = { frames: () => (++n < 4 ? [] : [{ url: () => '/a/alvo.html' }]) };
    assert.ok(await esperarFrame(atrasado, (f) => f.url().includes('alvo.html')), 'frame atrasado tem de ser achado');

    // Nunca aparece: devolve undefined e respeita o prazo.
    const nunca = { frames: () => [] };
    const t1 = Date.now();
    assert.strictEqual(await esperarFrame(nunca, () => true, { timeout: 300 }), undefined);
    const gasto = Date.now() - t1;
    assert.ok(gasto >= 250 && gasto < 1200, `prazo fora do esperado: ${gasto}ms`);

    console.log('frame-de-teste: 5 asserts OK');
  })().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
}
