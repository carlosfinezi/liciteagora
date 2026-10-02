/**
 * aviso-sistema.js — o aviso e a confirmação com a cara do sistema.
 *
 * Substitui o `alert()` e o `confirm()` do navegador, que até 30/09/2026 eram
 * o jeito do ERP de falar: **323 `alert()` em 48 telas e 280 `confirm()` em
 * 135**. Os dois travam a aba inteira, não têm a cara do produto, e o `alert`
 * não diz a qual campo se refere — quem diz isso é o `campo-formato.js`, que
 * marca o erro no próprio campo.
 *
 * Havia ainda seis `function toast(...)` caseiras, cada uma com as suas cores,
 * em seis telas diferentes. As classes `.toast` e `.modal-bg` já estavam na
 * folha comum; o que faltava era uma peça que as usasse.
 *
 * ── Como se usa ─────────────────────────────────────────────────────────────
 *
 *   Aviso.ok('Pedido salvo');
 *   Aviso.erro('Não foi possível salvar');
 *   Aviso.erro(Aviso.mensagemDeErro(e));          // nunca sai vazio
 *   if (!await Aviso.confirmar('Excluir o pedido 123?')) return;
 *   if (!await Aviso.confirmar({ texto: 'Excluir?', botao: 'Excluir', perigo: true })) return;
 *
 * `confirmar` devolve uma PROMESSA, ao contrário do `confirm()` nativo. Quem
 * troca um pelo outro precisa do `await`, e a função que o contém precisa ser
 * `async` — é a única diferença de uso, e é de propósito: é ela que faz a
 * caixa parar de travar a aba.
 */
(function avisoSistema() {
  'use strict';

  /* ===================== o aviso que passa ===================== */

  /**
   * O estilo, para as telas que não carregam a folha comum.
   *
   * As classes `.toast`, `.modal-bg` e `.modal` vêm do `app-modern.css`, e é
   * ele que manda quando existe. Mas o painel admin, o portal do cliente, as
   * telas públicas de orçamento e o cardápio têm mundo visual próprio e não o
   * carregam — sem isto, o aviso apareceria ali sem estilo nenhum, o que é
   * pior que o `alert()` que ele substitui.
   *
   * As cores saem das variáveis quando elas existem, e caem num valor fixo
   * quando não: é o único lugar do sistema onde cor fixa se justifica, porque
   * aqui pode não haver tema para consultar.
   */
  function garantirEstilo() {
    if (document.getElementById('aviso-sistema-estilo')) return;
    // A folha comum já define `.toast`? Então ela manda, e nada é injetado.
    const sonda = document.createElement('div');
    sonda.className = 'toast';
    sonda.style.position = 'absolute';
    sonda.style.visibility = 'hidden';
    document.body.appendChild(sonda);
    const temFolha = getComputedStyle(sonda).borderLeftWidth !== '0px';
    sonda.remove();
    if (temFolha) return;

    const st = document.createElement('style');
    st.id = 'aviso-sistema-estilo';
    st.textContent = `
#toasts { position: fixed; bottom: 20px; right: 20px; z-index: 99999;
  display: flex; flex-direction: column-reverse; gap: 10px; max-width: min(380px, calc(100vw - 32px));
  pointer-events: none; }
.toast { background: var(--bg-2, #111827); border: 1px solid var(--border-strong, #334155);
  border-left: 4px solid var(--accent, #60a5fa); border-radius: 8px; padding: 12px 16px;
  color: var(--text-0, #f1f5f9); box-shadow: 0 10px 30px rgba(0,0,0,0.5);
  pointer-events: auto; cursor: pointer; font-size: 0.88em; line-height: 1.45; }
.toast.success { border-left-color: var(--success, #34d399); }
.toast.error { border-left-color: var(--danger, #f87171); }
.toast-close { float: right; margin-left: 10px; opacity: 0.5; font-weight: 700; }
.modal-bg { display: none; position: fixed; inset: 0; background: rgba(2,6,23,0.75);
  z-index: 100000; align-items: center; justify-content: center; padding: 16px; }
.modal-bg.open { display: flex; }
.modal { background: var(--bg-2, #111827); border: 1px solid var(--border, #1e293b);
  border-radius: 12px; padding: 24px; max-width: 440px; width: 100%;
  color: var(--text-0, #f1f5f9); box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
.modal-header { display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border, #1e293b); }
.modal-header h3 { margin: 0; font-size: 1.1em; }
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
.modal-actions button { padding: 9px 16px; border-radius: 8px; border: 1px solid var(--border, #1e293b);
  background: var(--bg-3, #1e293b); color: var(--text-0, #f1f5f9); cursor: pointer; font: inherit; }
.modal-actions .btn-primary { background: var(--accent, #2563eb); border-color: transparent; color: #fff; }
.modal-actions .btn-danger { background: var(--danger, #b91c1c); border-color: transparent; color: #fff; }`;
    document.head.appendChild(st);
  }

  /** A área dos avisos. Existe em 97 telas; nas outras, nasce aqui. */
  function area() {
    garantirEstilo();
    let el = document.getElementById('toasts');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toasts';
      document.body.appendChild(el);
    }
    return el;
  }

  /**
   * @param {string} texto
   * @param {'ok'|'erro'|'info'} [tom]
   * @param {number} [segundos] quanto tempo fica; erro fica mais, porque erro
   *        se lê com mais atenção do que confirmação
   */
  function mostrar(texto, tom, segundos) {
    const frase = String(texto == null ? '' : texto).trim();
    if (!frase) return;                       // aviso vazio não se mostra
    const el = document.createElement('div');
    el.className = 'toast ' + (tom === 'ok' ? 'success' : tom === 'erro' ? 'error' : 'info');
    el.setAttribute('role', tom === 'erro' ? 'alert' : 'status');
    el.textContent = frase;
    const fechar = document.createElement('span');
    fechar.className = 'toast-close';
    fechar.textContent = '×';
    fechar.setAttribute('aria-hidden', 'true');
    el.appendChild(fechar);
    el.addEventListener('click', () => el.remove());
    area().appendChild(el);
    const ms = (segundos || (tom === 'erro' ? 7 : 4)) * 1000;
    // O RELÓGIO PARA COM O MOUSE EM CIMA. Aviso que some enquanto se lê obriga
    // a repetir a ação só para ver o que ele dizia — e o X, que já existe, não
    // adianta nada se a caixa sumir antes de a mão chegar nele. Ao sair, a
    // contagem recomeça inteira: quem tirou o mouse acabou de ler.
    let relogio = setTimeout(() => el.remove(), ms);
    el.addEventListener('mouseenter', () => clearTimeout(relogio));
    el.addEventListener('mouseleave', () => { relogio = setTimeout(() => el.remove(), ms); });
    return el;
  }

  /**
   * A frase de erro que nunca sai vazia.
   *
   * Em 30/09/2026, seis telas mostravam uma caixa dizendo literalmente
   * "Erro: " — sem nada depois dos dois pontos — e uma dizendo "undefined".
   * A causa era sempre a mesma: `alert('Erro: ' + e.message)` com uma exceção
   * sem `message`, ou `(d.error || '')` com o servidor não mandando `error`.
   * Medido no navegador, com a API fora do ar: `contas-a-pagar`,
   * `contas-a-receber`, `manifestador` e `tokens` diziam "Erro: ";
   * `relatorio-lances` dizia "undefined"; `timing-analise`, "Erro: desconhecido".
   *
   * Aqui, o que não tem frase ganha uma que ao menos diz o que fazer.
   */
  function mensagemDeErro(coisa, fallback) {
    const padrao = fallback || 'Não foi possível concluir. Tente de novo; se continuar, recarregue a página.';
    if (coisa == null) return padrao;
    // Resposta de API: { error } ou { message }. String entra pelo mesmo
    // caminho, para a guarda contra "undefined" valer nos dois — o texto
    // "undefined" chega aqui de quem concatenou uma variável vazia, que é
    // justamente a origem da caixa que dizia isso em `relatorio-lances`.
    const bruto = typeof coisa === 'string'
      ? coisa
      : (coisa.error || coisa.message || coisa.erro || '');
    const frase = String(bruto).trim();
    if (!frase || frase === 'undefined' || frase === 'null' || frase === 'Erro:') return padrao;
    // "Failed to fetch" é o que o navegador diz quando a rede caiu; a frase
    // dele não ajuda ninguém.
    if (/^(Failed to fetch|NetworkError|Load failed)/i.test(frase)) {
      return 'Sem conexão com o servidor. Confira a internet e tente de novo.';
    }
    return frase;
  }

  /* ===================== a confirmação ===================== */

  let abertaAgora = null;

  /**
   * Pergunta de sim ou não, na caixa do sistema.
   *
   * @param {string|object} opcoes texto, ou { titulo, texto, botao, cancelar, perigo }
   * @returns {Promise<boolean>}
   */
  function confirmar(opcoes) {
    const o = typeof opcoes === 'string' ? { texto: opcoes } : (opcoes || {});
    const titulo = o.titulo || 'Confirmar';
    const texto = o.texto || '';
    const rotuloOk = o.botao || 'Confirmar';
    const rotuloNao = o.cancelar || 'Cancelar';
    const perigo = !!o.perigo;

    // Duas caixas ao mesmo tempo empilhariam uma sobre a outra, e a de baixo
    // ficaria sem resposta para sempre.
    if (abertaAgora) return Promise.resolve(false);

    garantirEstilo();
    return new Promise((resolve) => {
      const fundo = document.createElement('div');
      fundo.className = 'modal-bg open';
      fundo.setAttribute('role', 'dialog');
      fundo.setAttribute('aria-modal', 'true');

      const caixa = document.createElement('div');
      caixa.className = 'modal';
      caixa.style.maxWidth = '440px';

      const h = document.createElement('div');
      h.className = 'modal-header';
      const h3 = document.createElement('h3');
      h3.textContent = titulo;
      h.appendChild(h3);

      const p = document.createElement('p');
      p.textContent = texto;
      p.style.color = 'var(--text-1)';
      p.style.lineHeight = '1.5';
      p.style.margin = '0';

      const acoes = document.createElement('div');
      acoes.className = 'modal-actions';
      const btnNao = document.createElement('button');
      btnNao.type = 'button';
      btnNao.className = 'btn btn-secondary';
      btnNao.textContent = rotuloNao;
      const btnOk = document.createElement('button');
      btnOk.type = 'button';
      btnOk.className = 'btn ' + (perigo ? 'btn-danger' : 'btn-primary');
      btnOk.textContent = rotuloOk;
      acoes.appendChild(btnNao);
      acoes.appendChild(btnOk);

      caixa.appendChild(h);
      caixa.appendChild(p);
      caixa.appendChild(acoes);
      fundo.appendChild(caixa);
      document.body.appendChild(fundo);
      abertaAgora = fundo;

      const focoAntes = document.activeElement;
      /* O foco entra na caixa, e sai de propósito no botão que NÃO faz nada:
         quem aperta Enter sem ler não apaga um pedido. */
      btnNao.focus();

      const fechar = (resposta) => {
        document.removeEventListener('keydown', naTecla, true);
        fundo.remove();
        abertaAgora = null;
        if (focoAntes && focoAntes.focus) { try { focoAntes.focus(); } catch (e) { /* saiu da tela */ } }
        resolve(resposta);
      };
      const naTecla = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); fechar(false); }
        // Tab preso dentro da caixa: sair dela com o teclado deixaria a página
        // de trás acessível por baixo de um modal.
        if (e.key === 'Tab') {
          const foco = [btnNao, btnOk];
          const i = foco.indexOf(document.activeElement);
          e.preventDefault();
          foco[(i + (e.shiftKey ? -1 : 1) + foco.length) % foco.length].focus();
        }
      };
      document.addEventListener('keydown', naTecla, true);
      btnNao.addEventListener('click', () => fechar(false));
      btnOk.addEventListener('click', () => fechar(true));
      // Clique fora é o mesmo que cancelar, nunca o mesmo que confirmar.
      fundo.addEventListener('click', (e) => { if (e.target === fundo) fechar(false); });
    });
  }

  window.Aviso = {
    ok: (t, s) => mostrar(t, 'ok', s),
    erro: (t, s) => mostrar(t, 'erro', s),
    info: (t, s) => mostrar(t, 'info', s),
    mostrar,
    mensagemDeErro,
    confirmar,
  };

  /* Compatibilidade com as seis `function toast(msg, tipo)` caseiras que havia
     em seis telas: quem chamar `toast(...)` cai aqui, com as mesmas palavras de
     tipo que aquelas usavam ('sucesso', 'erro', 'success', 'error'). */
  if (typeof window.toast !== 'function') {
    window.toast = function toast(msg, tipo) {
      const t = String(tipo || '');
      return mostrar(msg, /sucesso|success/.test(t) ? 'ok' : /erro|error/.test(t) ? 'erro' : 'info');
    };
  }
})();
