/**
 * campo-formato.js — o campo de dado se formata, se confere e diz o que falta.
 *
 * Vinha de `public/loja/catalogo.js`, onde nasceu para o checkout da vitrine e
 * ficou sendo a ÚNICA peça do sistema que fazia isso: em 30/09/2026, das 259
 * telas, só a loja formatava campo, conferia dígito verificador de CPF/CNPJ e
 * marcava o erro no próprio campo. O ERP inteiro tinha 16 máscaras caseiras,
 * cada uma cobrindo uma tela, e 323 `alert()` no lugar da marcação.
 *
 * ── Como se liga ────────────────────────────────────────────────────────────
 *
 * Por ATRIBUTO, nunca por lista de ids:
 *
 *   <input data-formato="telefone" maxlength="16" inputmode="tel">
 *
 * Campo novo em qualquer tela nasce formatado só por declarar o formato. Não
 * há nada a registrar, e ninguém precisa lembrar de chamar função alguma.
 *
 * Formatos: telefone, cpf, cnpj, cpfcnpj, cep, dinheiro, data, hora, placa,
 * inscricao, email. Use `cpf` ou `cnpj` quando o campo admite só um dos dois —
 * aí 11 dígitos num campo de CNPJ é recusado, o que `cpfcnpj` não faz.
 *
 * ── O que vai para o servidor ───────────────────────────────────────────────
 *
 * A máscara é de LEITURA. Para dinheiro, `el.value` lido pelo JavaScript
 * devolve o NÚMERO ("1234.56") enquanto a tela mostra "R$ 1.234,56" — ver
 * `ligarDinheiro` adiante, e o porquê dessa escolha está lá. Nos outros
 * formatos o valor é o texto mascarado, que é o que o sistema já gravava antes
 * desta peça (telefone em produção está gravado como "(94) 3424-1360"), e quem
 * precisa dos dígitos usa `CampoFormato.digitos(el)`.
 *
 * ── A marcação do que falta ─────────────────────────────────────────────────
 *
 * Erro DE CAMPO é marcado no campo: borda (`.falta`), uma frase curta abaixo
 * (`.diz-falta`), `aria-invalid`, a página rolando até o primeiro e o foco
 * nele. A marca sai sozinha quando a pessoa mexe naquilo. O que NÃO é de campo
 * nenhum (a rede caiu, a sessão venceu) continua sendo assunto de quem chamou.
 */
(function campoFormato() {
  'use strict';

  const digitosDe = (v) => String(v == null ? '' : v).replace(/\D/g, '');

  /* ===================== os formatos ===================== */

  /**
   * (94) 99176-9924 e (94) 3322-1100 — celular e fixo, pelo tamanho.
   *
   * O 55 do país é descartado quando vem na frente: número copiado do WhatsApp
   * chega como 5594991769924, e sem isto ele entraria como "(55) 94991-7699".
   * A regra veio do `soDigitosTel` de `public/comercial/pessoas.html`, que
   * fazia só isso e só naquela tela.
   */
  function formatarTelefone(bruto) {
    let d = digitosDe(bruto);
    if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
    d = d.slice(0, 11);
    if (d.length <= 2) return d;
    const ddd = `(${d.slice(0, 2)}) `;
    const resto = d.slice(2);
    if (resto.length <= 4) return ddd + resto;
    // 9 dígitos = celular (5+4); 8 = fixo (4+4).
    const corte = resto.length > 8 ? 5 : 4;
    return ddd + resto.slice(0, corte) + '-' + resto.slice(corte);
  }

  /** 000.000.000-00 até 11 dígitos, 00.000.000/0000-00 daí em diante. */
  function formatarCpfCnpj(bruto) {
    const d = digitosDe(bruto).slice(0, 14);
    if (d.length <= 11) {
      return d.replace(/^(\d{3})(\d)/, '$1.$2')
        .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
        .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
    }
    return d.replace(/^(\d{2})(\d)/, '$1.$2')
      .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
      .replace(/\.(\d{3})(\d)/, '.$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }

  const formatarCpf = (bruto) => formatarCpfCnpj(digitosDe(bruto).slice(0, 11));

  /**
   * 00.000.000/0000-00, sempre.
   *
   * Num campo que só aceita CNPJ a máscara não pode passar pela de CPF no
   * caminho: com 9 dígitos o combinado mostraria "000.000.000", e a pontuação
   * mudaria de lugar na décima tecla. Aqui ela entra na posição final desde o
   * primeiro dígito.
   */
  function formatarCnpj(bruto) {
    const d = digitosDe(bruto).slice(0, 14);
    if (d.length <= 2) return d;
    let fora = d.slice(0, 2) + '.' + d.slice(2, 5);
    if (d.length > 5) fora += '.' + d.slice(5, 8);
    if (d.length > 8) fora += '/' + d.slice(8, 12);
    if (d.length > 12) fora += '-' + d.slice(12);
    return fora;
  }

  const formatarCep = (bruto) => {
    const d = digitosDe(bruto).slice(0, 8);
    return d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
  };

  /** "1234" → "R$ 12,34": o dinheiro cresce da direita, como na maquininha. */
  function formatarDinheiro(bruto) {
    const d = digitosDe(bruto).slice(0, 13);
    if (!d) return '';
    const n = Number(d) / 100;
    return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** 31/12/2026 — dia, mês e ano, com as barras entrando sozinhas. */
  function formatarData(bruto) {
    const d = digitosDe(bruto).slice(0, 8);
    if (d.length <= 2) return d;
    if (d.length <= 4) return d.slice(0, 2) + '/' + d.slice(2);
    return d.slice(0, 2) + '/' + d.slice(2, 4) + '/' + d.slice(4);
  }

  /** 23:45 */
  function formatarHora(bruto) {
    const d = digitosDe(bruto).slice(0, 4);
    return d.length <= 2 ? d : d.slice(0, 2) + ':' + d.slice(2);
  }

  /**
   * ABC1D23 — a placa Mercosul e a antiga na mesma máscara.
   *
   * Não põe hífen: a antiga é ABC-1234 e a Mercosul é ABC1D23, e um hífen que
   * aparece e desaparece conforme a quarta tecla incomoda mais do que ajuda.
   * Letra sai em maiúscula, que é como o Detran a escreve.
   */
  function formatarPlaca(bruto) {
    return String(bruto == null ? '' : bruto)
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 7);
  }

  /** Inscrição estadual: dígitos, mais o "ISENTO" que vários estados aceitam. */
  function formatarInscricao(bruto) {
    const v = String(bruto == null ? '' : bruto).toUpperCase();
    if (/^I(S(E(N(T(O)?)?)?)?)?$/.test(v.replace(/[^A-Z]/g, ''))) {
      return v.replace(/[^A-Z]/g, '');
    }
    return digitosDe(v).slice(0, 14);
  }

  const FORMATOS = {
    telefone: formatarTelefone,
    cpf: formatarCpf,
    cnpj: formatarCnpj,
    cpfcnpj: formatarCpfCnpj,
    cep: formatarCep,
    dinheiro: formatarDinheiro,
    data: formatarData,
    hora: formatarHora,
    placa: formatarPlaca,
    inscricao: formatarInscricao,
  };

  /* ===================== a conferência ===================== */

  /** Os dígitos verificadores do CPF. Formato certo com DV errado é erro de digitação. */
  function cpfValido(d) {
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    for (const [ate, pos] of [[9, 10], [10, 11]]) {
      let soma = 0;
      for (let i = 0; i < ate; i++) soma += Number(d[i]) * (pos - i);
      if ((soma * 10) % 11 % 10 !== Number(d[ate])) return false;
    }
    return true;
  }

  function cnpjValido(d) {
    if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
    const conta = (ate) => {
      const pesos = ate === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      let soma = 0;
      for (let i = 0; i < ate; i++) soma += Number(d[i]) * pesos[i];
      const r = soma % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return conta(12) === Number(d[12]) && conta(13) === Number(d[13]);
  }

  const emailValido = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(v || '').trim());

  /** Data real: recusa 31/02 e ano fora de 1900–2199. */
  function dataValida(d) {
    if (d.length !== 8) return false;
    const dia = Number(d.slice(0, 2)), mes = Number(d.slice(2, 4)), ano = Number(d.slice(4));
    if (mes < 1 || mes > 12 || ano < 1900 || ano > 2199) return false;
    const ultimo = new Date(ano, mes, 0).getDate();
    return dia >= 1 && dia <= ultimo;
  }

  /**
   * O que há de errado NESTE campo, ou null.
   *
   * Campo vazio não é erro aqui: quem cobra o preenchimento é a validação de
   * cada tela, que sabe o que é obrigatório onde. Aqui só se olha o que já foi
   * digitado.
   */
  function erroDoCampo(el) {
    if (!el || !el.dataset || !el.dataset.formato) return null;
    const v = String(el.value == null ? '' : el.value).trim();
    if (!v) return null;
    const d = digitosDe(v);
    switch (el.dataset.formato) {
      case 'telefone':
        return d.length >= 10 ? null : 'Telefone com DDD, 10 ou 11 números';
      case 'cpf':
        if (d.length !== 11) return 'CPF tem 11 números';
        return cpfValido(d) ? null : 'CPF inválido. Confira os números';
      case 'cnpj':
        if (d.length !== 14) return 'CNPJ tem 14 números';
        return cnpjValido(d) ? null : 'CNPJ inválido. Confira os números';
      case 'cpfcnpj':
        if (d.length !== 11 && d.length !== 14) return 'CPF tem 11 números, CNPJ tem 14';
        if (d.length === 11) return cpfValido(d) ? null : 'CPF inválido. Confira os números';
        return cnpjValido(d) ? null : 'CNPJ inválido. Confira os números';
      case 'cep':
        return d.length === 8 ? null : 'CEP tem 8 números';
      case 'email':
        return emailValido(v) ? null : 'E-mail inválido';
      case 'data':
        return dataValida(d) ? null : 'Data no formato dia/mês/ano';
      case 'hora': {
        if (d.length !== 4) return 'Hora no formato 00:00';
        const h = Number(d.slice(0, 2)), m = Number(d.slice(2));
        return (h < 24 && m < 60) ? null : 'Hora inválida';
      }
      case 'placa': {
        const p = formatarPlaca(v);
        if (/^[A-Z]{3}[0-9]{4}$/.test(p) || /^[A-Z]{3}[0-9][A-Z][0-9]{2}$/.test(p)) return null;
        return 'Placa como ABC1D23 ou ABC1234';
      }
      default:
        return null;
    }
  }

  /**
   * Todos os campos visíveis de um formulário que estão preenchidos e errados.
   *
   * O seletor exige `input`/`select`/`textarea` de propósito, e não só o
   * atributo: `catalogo/loja-montagem.html` usa `data-formato` num `<div>` para
   * o formato do buquê montável, que não tem nada a ver com formato de campo.
   * Um seletor largo marcaria aquelas caixas como erro.
   */
  function faltasDeFormato(raiz) {
    const fora = [];
    const seletor = 'input[data-formato], select[data-formato], textarea[data-formato]';
    for (const el of (raiz || document).querySelectorAll(seletor)) {
      if (el.offsetParent === null) continue;          // campo escondido não é cobrado
      const diz = erroDoCampo(el);
      if (diz) fora.push({ el, diz });
    }
    return fora;
  }

  /* ===================== a marcação do que falta ===================== */

  /** Tira a marca de um campo, junto da frase que veio com ela. */
  function limparFalta(el) {
    if (!el || !el.classList || !el.classList.contains('falta')) return;
    el.classList.remove('falta');
    el.removeAttribute('aria-invalid');
    const diz = el.nextElementSibling;
    if (diz && diz.classList.contains('diz-falta')) diz.remove();
  }

  function limparFaltas(raiz) {
    for (const el of (raiz || document).querySelectorAll('.falta')) limparFalta(el);
  }

  function marcarFalta(el, diz) {
    if (!el || el.classList.contains('falta')) return;
    el.classList.add('falta');
    if (el.matches('input, select, textarea')) el.setAttribute('aria-invalid', 'true');
    if (!diz) return;
    const p = document.createElement('p');
    p.className = 'diz-falta';
    p.textContent = diz;
    el.insertAdjacentElement('afterend', p);
  }

  /**
   * Marca o que falta e leva a pessoa até o primeiro.
   *
   * `levar: false` serve para quem repinta a tela e precisa só repor as marcas
   * que já estavam lá.
   *
   * @param {Array<{el: Element, diz: string}>} faltas
   * @returns {boolean} se havia alguma
   */
  function marcarFaltas(faltas, opcoes) {
    const levar = !opcoes || opcoes.levar !== false;
    limparFaltas();
    /* Ordenadas pela posição no DOM, e não pela ordem em que quem valida as
       descobriu: a pessoa é levada ao primeiro que falta OLHANDO A TELA. */
    const validas = (faltas || []).filter((f) => f && f.el).sort((a, b) =>
      (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
    for (const f of validas) marcarFalta(f.el, f.diz);
    if (!validas.length) return false;
    if (levar) {
      const primeiro = validas[0].el;
      primeiro.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const foco = primeiro.matches('input, select, textarea')
        ? primeiro
        : primeiro.querySelector('input, select, textarea, button');
      if (foco) foco.focus({ preventScroll: true });
    }
    return true;
  }

  /**
   * Cobra os obrigatórios e confere os formatos, de uma vez.
   *
   * @param {Element|string} form   o formulário (ou o id dele)
   * @param {Array<[string,string]>} [obrigatorios] pares [id, rótulo]
   * @returns {boolean} true quando está tudo certo
   */
  function validar(form, obrigatorios) {
    const raiz = typeof form === 'string' ? document.getElementById(form) : form;
    const faltas = [];
    for (const par of (obrigatorios || [])) {
      const el = document.getElementById(par[0]);
      if (!el) continue;
      const vazio = el.type === 'checkbox' ? !el.checked : !String(el.value || '').trim();
      if (vazio) faltas.push({ el, diz: `Informe ${par[1]}` });
    }
    for (const f of faltasDeFormato(raiz)) {
      if (!faltas.some((x) => x.el === f.el)) faltas.push(f);
    }
    return !marcarFaltas(faltas);
  }

  /* ===================== dinheiro: o valor que o JS lê ===================== */

  /**
   * O campo de dinheiro mostra "R$ 1.234,56" e entrega 1234.56 ao JavaScript.
   *
   * **Por que interceptar `value` em vez de trocar quem lê:** em 30/09/2026 os
   * campos de dinheiro do ERP eram 75, em 48 telas, e o código dessas telas
   * lia `.value` deles em **152 lugares** — `Number(getElementById('x').value)`
   * e parentes. Passar o campo de `type=number` para texto mascarado sem mais
   * nada faria essas 152 leituras receberem "R$ 1.234,56" e produzir `NaN`,
   * em toda tela de financeiro, pedido, contrato e caixa de uma vez.
   *
   * Definindo o acessor na INSTÂNCIA, o navegador continua exibindo a máscara
   * (é o valor real do input) e o JavaScript passa a ler o número. As 152
   * leituras seguem valendo, sem nenhuma edição, e é por isso que esta é a
   * mudança MENOR, não a mais esperta.
   *
   * Conferido antes de escolher: o sistema não usa `valueAsNumber` (0 casos)
   * nem `checkValidity` (0 casos), e nenhum `FormData` carrega campo de
   * dinheiro — os 24 que existem são upload de arquivo.
   */
  const acessorNativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

  function ligarDinheiro(el) {
    if (el.__dinheiroLigado) return;
    el.__dinheiroLigado = true;
    Object.defineProperty(el, 'value', {
      configurable: true,
      get() {
        const d = digitosDe(acessorNativo.get.call(this));
        return d ? String(Number(d) / 100) : '';
      },
      set(v) {
        // Número (ou "12.34") vira máscara; texto já mascarado é remascarado.
        const bruto = String(v == null ? '' : v);
        if (bruto === '') { acessorNativo.set.call(this, ''); return; }
        const n = Number(bruto);
        const centavos = Number.isFinite(n) && !/[R$]/.test(bruto)
          ? Math.round(n * 100)
          : Number(digitosDe(bruto));
        acessorNativo.set.call(this, formatarDinheiro(String(centavos)));
      },
    });
    // O que já estava no campo quando a tela montou entra formatado.
    const inicial = acessorNativo.get.call(el);
    if (inicial) el.value = inicial;
  }

  // Limite de tamanho por formato, para o campo não aceitar o que nunca será
  // válido. O do dinheiro conta os separadores de "R$ 999.999.999,99".
  const LIMITE = {
    telefone: 16, cpf: 14, cnpj: 18, cpfcnpj: 18, cep: 9,
    data: 10, hora: 5, placa: 7, inscricao: 14, dinheiro: 20,
  };

  /** Prepara os campos de uma raiz: teclado do celular e dinheiro interceptado. */
  function preparar(raiz) {
    for (const el of (raiz || document).querySelectorAll('input[data-formato]')) {
      const f = el.dataset.formato;
      // Teclado do celular, quando a tela não declarou um.
      if (!el.getAttribute('inputmode')) {
        if (f === 'telefone') el.setAttribute('inputmode', 'tel');
        else if (f === 'email') el.setAttribute('inputmode', 'email');
        else if (f === 'placa' || f === 'inscricao') { /* alfanumérico: teclado normal */ }
        else if (f === 'dinheiro') el.setAttribute('inputmode', 'decimal');
        else el.setAttribute('inputmode', 'numeric');
      }
      if (!el.getAttribute('maxlength') && LIMITE[f]) el.setAttribute('maxlength', LIMITE[f]);
      if (f === 'dinheiro') ligarDinheiro(el);
    }
  }

  /* ===================== a fiação ===================== */

  /* A máscara é aplicada a cada tecla, e também ao COLAR — é o mesmo evento
     `input`, e por isso um número colado com pontos entra formatado igual. */
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.formato) return;
    const fn = FORMATOS[el.dataset.formato];
    if (!fn) return;
    // Dinheiro tem acessor próprio: ler `el.value` aqui daria o número.
    const antes = el.dataset.formato === 'dinheiro'
      ? acessorNativo.get.call(el)
      : el.value;
    const fimDaDireita = antes.length - (el.selectionEnd == null ? antes.length : el.selectionEnd);
    const depois = fn(antes);
    if (depois === antes) return;
    if (el.dataset.formato === 'dinheiro') acessorNativo.set.call(el, depois);
    else el.value = depois;
    /* O cursor é reposto contando da DIREITA: com a máscara crescendo à
       esquerda (o dinheiro) ou ganhando separadores no meio (o telefone),
       guardar a posição absoluta jogaria o cursor para trás a cada pontuação. */
    if (el.selectionEnd != null) {
      const pos = Math.max(0, depois.length - fimDaDireita);
      try { el.setSelectionRange(pos, pos); } catch (err) { /* type=email não aceita */ }
    }
  });

  /* A marca sai sozinha quando a pessoa mexe no que faltava. Em captura, para
     valer mesmo quando o elemento é repintado por um handler que rode depois. */
  for (const evento of ['input', 'change']) {
    document.addEventListener(evento, (e) => limparFalta(e.target), true);
  }

  /* Sair do campo é o momento de conferir: no meio da digitação todo telefone
     está incompleto, e marcar a cada tecla seria acusar quem está escrevendo.
     Veio do checkout da loja, que já fazia assim. */
  document.addEventListener('blur', (e) => {
    const el = e.target;
    if (!el || !el.dataset || !el.dataset.formato) return;
    if (!el.matches || !el.matches('input, select, textarea')) return;
    const diz = erroDoCampo(el);
    // `marcarFalta`, e não `marcarFaltas`: sair de um campo não pode apagar a
    // marca dos outros.
    if (diz) marcarFalta(el, diz);
  }, true);
  document.addEventListener('click', (e) => {
    const alvo = e.target.closest && e.target.closest('.falta');
    if (alvo) limparFalta(alvo);
  }, true);

  /**
   * CEP completo busca rua, bairro e cidade.
   *
   * O destino vem por ATRIBUTO, e não por id fixo: na loja isto gravava direto
   * em `chkRua`/`chkBairro`/`chkCidade`/`chkUf`, o que não servia a nenhuma
   * tela do ERP, que usa outros ids.
   *
   *   <input data-formato="cep" data-cep-rua="endereco" data-cep-bairro="bairro"
   *          data-cep-cidade="cidade" data-cep-uf="uf">
   *
   * Só preenche campo VAZIO: quem já digitou a rua não a vê ser trocada, e tudo
   * continua editável. Falhou a consulta, nada acontece — o endereço é
   * digitável do mesmo jeito.
   */
  const CEP_BUSCADO = new WeakMap();
  async function buscarCep(el) {
    const d = digitosDe(el.value);
    if (d.length !== 8 || CEP_BUSCADO.get(el) === d) return;
    CEP_BUSCADO.set(el, d);
    const destino = {
      rua: el.dataset.cepRua, bairro: el.dataset.cepBairro,
      cidade: el.dataset.cepCidade, uf: el.dataset.cepUf,
    };
    if (!destino.rua && !destino.bairro && !destino.cidade && !destino.uf) return;
    try {
      const r = await fetch('https://viacep.com.br/ws/' + d + '/json/').then((x) => x.json());
      if (!r || r.erro) return;
      const por = [[destino.rua, r.logradouro], [destino.bairro, r.bairro],
        [destino.cidade, r.localidade], [destino.uf, r.uf]];
      for (const [id, valor] of por) {
        if (!id || !valor) continue;
        const campo = document.getElementById(id);
        if (campo && !String(campo.value || '').trim()) {
          campo.value = valor;
          campo.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    } catch (err) { /* endereço segue digitável */ }
  }
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el && el.dataset && el.dataset.formato === 'cep') buscarCep(el);
  });

  /* Campo que a tela criou depois (modal, linha de grade) também nasce pronto. */
  if (typeof MutationObserver === 'function') {
    new MutationObserver((mudancas) => {
      for (const m of mudancas) {
        for (const no of m.addedNodes) {
          if (no.nodeType !== 1) continue;
          if (no.matches && no.matches('input[data-formato]')) preparar(no.parentNode || document);
          else if (no.querySelector && no.querySelector('input[data-formato]')) preparar(no);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => preparar(document));
  } else {
    preparar(document);
  }

  window.CampoFormato = {
    digitos: digitosDe,
    formatar: (formato, valor) => (FORMATOS[formato] ? FORMATOS[formato](valor) : valor),
    erroDoCampo,
    faltasDeFormato,
    marcarFalta,
    marcarFaltas,
    limparFalta,
    limparFaltas,
    validar,
    preparar,
    cpfValido,
    cnpjValido,
    emailValido,
    dataValida,
  };
})();
