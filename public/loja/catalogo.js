/**
 * catalogo.js — a aplicação do catálogo público (Fase 50).
 *
 * Saiu do `<script>` inline da página por um motivo prático: o `npm run verify`
 * parseia `public/**.js` como script do navegador, e o inline das páginas
 * públicas é pulado de propósito (verify.js:153). Num arquivo próprio, um erro
 * de sintaxe aqui reprova o verify em vez de derrubar a loja em silêncio.
 *
 * ── Três telas, uma página ──────────────────────────────────────────────────
 *
 *   #/           home: capa, categorias, destaques, seções
 *   #/p/<id>     produto: foto grande, personalizações, quantidade
 *   #/sacola     meu pedido: itens, sugestões, tipo de serviço
 *   #/montar/<id> o montador (flor, formato, quantidade, cor, adicionais)
 *   #/pagar/<t>  o Pix do pedido, com QR, copia e cola e o aviso de pago
 *
 * Roteamento por hash, e não por caminho, porque `/loja/` é servido como
 * ESTÁTICO: qualquer rota real exigiria fallback no servidor, e o combinado é
 * que o endereço público não muda.
 *
 * ── O navegador não sabe quanto as coisas custam ────────────────────────────
 *
 * O carrinho guarda REFERÊNCIA: produtoId, quantidade, ids de opção, textos e
 * comentário. Nenhum preço. Todo valor exibido vem de
 * `POST /loja/api/carrinho/calcular`, que recalcula a partir do banco e recusa
 * opção que não pertence ao produto. Adulterar o localStorage muda o que se
 * pede, nunca o que se paga.
 */

let LOJA = null;
/* O que esta loja PODE oferecer, vindo de `/loja/api/config`. Quem responde é
   o `loja-capacidades.js`, no servidor; aqui só se lê.
   Nasce vazio, e vazio quer dizer "nenhum recurso condicional": é esse o
   estado de toda loja hoje, e é o que a tela desenha quando a resposta vem de
   uma versão do servidor que ainda não manda o campo. */
let CAPACIDADES = {};
let PRODUTOS = [];
let CATEGORIAS = [];
let SACOLA = { itens: [], total: 0, quantidadeItens: 0 };
let CALCULANDO = null;

const CHAVE = 'loja-carrinho-v2';

/* ===================== estado do carrinho (só referências) ================= */

function lerCarrinho() {
  try {
    const bruto = JSON.parse(localStorage.getItem(CHAVE) || '[]');
    if (!Array.isArray(bruto)) return [];
    // Saneado na leitura: o localStorage é entrada não confiável como qualquer
    // outra. O que não couber no formato é descartado, não corrigido.
    return bruto.map((i) => ({
      produtoId: Number(i && i.produtoId),
      quantidade: Math.floor(Number(i && i.quantidade) || 0),
      opcoes: Array.isArray(i && i.opcoes) ? i.opcoes.map(Number).filter(Boolean) : [],
      textos: (i && i.textos && typeof i.textos === 'object') ? i.textos : {},
      comentario: i && i.comentario ? String(i.comentario).slice(0, 300) : null,
      montagem: lerMontagem(i && i.montagem),
    })).filter((i) => Number.isFinite(i.produtoId) && i.produtoId > 0 && i.quantidade > 0);
  } catch { return []; }
}

/* A montagem guarda só as escolhas (formato, quantidade, cor, data). O preço
   dela também é do servidor, lido da tabela do lojista. */
function lerMontagem(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    formatoId: Number(m.formatoId) || 0,
    quantidade: Math.floor(Number(m.quantidade) || 0),
    corId: Number(m.corId) || 0,
    dataDesejada: /^\d{4}-\d{2}-\d{2}$/.test(String(m.dataDesejada || '')) ? m.dataDesejada : null,
  };
}

function gravarCarrinho(itens) {
  try { localStorage.setItem(CHAVE, JSON.stringify(itens)); } catch { /* modo privado */ }
}

/** Duas linhas do mesmo produto só se fundem se as escolhas forem idênticas. */
const assinatura = (i) =>
  i.produtoId + '|' + [...i.opcoes].sort((a, b) => a - b).join(',')
  + '|' + JSON.stringify(i.textos || {}) + '|' + (i.comentario || '')
  + '|' + JSON.stringify(i.montagem || null);

function adicionar(item) {
  const itens = lerCarrinho();
  const chave = assinatura(item);
  // Montagem nunca se funde: cada uma é um presente, com quantidade 1.
  const existente = !item.montagem && itens.find((i) => assinatura(i) === chave);
  if (existente) existente.quantidade += item.quantidade;
  else itens.push(item);
  gravarCarrinho(itens);
  return recalcular();
}

function mudarQuantidade(indice, delta) {
  const itens = lerCarrinho();
  if (!itens[indice]) return recalcular();
  itens[indice].quantidade += delta;
  if (itens[indice].quantidade <= 0) itens.splice(indice, 1);
  gravarCarrinho(itens);
  return recalcular();
}

function remover(indice) {
  const itens = lerCarrinho();
  itens.splice(indice, 1);
  gravarCarrinho(itens);
  return recalcular();
}

/** Troca um item no lugar: é o que o "Editar" do buquê faz ao salvar. */
function substituirNaSacola(indice, item) {
  const itens = lerCarrinho();
  if (!itens[indice]) return adicionar(item);
  itens[indice] = item;
  gravarCarrinho(itens);
  return recalcular();
}

/* ===================== rascunho do montador ================================
   Montar um buquê leva vários passos, e até 29/09 um F5 ou o botão de voltar
   do navegador zeravam tudo: MT só existia em memória. O rascunho é por
   PRODUTO — trocar de flor e voltar reencontra o que já estava escolhido — e
   guarda só referências (ids e textos), como o carrinho. Ele morre quando o
   buquê entra na sacola.
   ========================================================================= */

const CHAVE_RASCUNHO = 'loja-montagem-v1';

function lerRascunhos() {
  try {
    const o = JSON.parse(localStorage.getItem(CHAVE_RASCUNHO) || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch { return {}; }
}

function gravarRascunho(produtoId, dados) {
  try {
    const todos = lerRascunhos();
    todos[produtoId] = dados;
    localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify(todos));
  } catch { /* modo privado: a montagem segue, só não sobrevive ao F5 */ }
}

function esquecerRascunho(produtoId) {
  try {
    const todos = lerRascunhos();
    delete todos[produtoId];
    localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify(todos));
  } catch { /* idem */ }
}

/** O servidor recalcula tudo. Só o que volta daqui é mostrado como dinheiro. */
async function recalcular() {
  const itens = lerCarrinho();
  if (!itens.length) {
    SACOLA = { itens: [], total: 0, quantidadeItens: 0 };
    pintarBarra();
    return SACOLA;
  }
  try {
    const d = await fetch('/loja/api/carrinho/calcular', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itens }),
    }).then((r) => r.json());
    if (d && d.success) {
      SACOLA = d;
      /* O servidor pode ter descartado item (produto despublicado desde a última
         visita). Reescreve o local com o que sobrou, para os índices da tela
         continuarem batendo com o que o servidor conhece. */
      if (d.itens.length !== itens.length) {
        gravarCarrinho(d.itens.map((i) => ({
          produtoId: i.produtoId, quantidade: i.quantidade,
          opcoes: i.opcoes.map((o) => o.id), textos: i.textos || {}, comentario: i.comentario,
          montagem: i.montagem || null,
        })));
      }
    }
  } catch { /* offline: mantém o que já estava calculado */ }
  pintarBarra();
  return SACOLA;
}

/* ===================== utilidades de tela ================================== */

const $ = (id) => document.getElementById(id);
const fotoDe = (p) => (p.fotos && p.fotos[0]) || null;

function precoHtml(p) {
  if (p.preco == null) return '<span class="sob">Consulte o preço</span>';
  if (p.precoAnterior) {
    const pct = Math.round((1 - p.preco / p.precoAnterior) * 100);
    return `<span class="preco">${brl(p.preco)}</span>`
      + `<span class="antes">${brl(p.precoAnterior)}</span>`
      + (pct > 0 ? `<span class="pct">-${pct}%</span>` : '');
  }
  return `<span class="preco">${brl(p.preco)}</span>`;
}

function cardHtml(p) {
  const foto = fotoDe(p);
  if (p.montavel) {
    return `<article class="card" data-montar="${p.id}" role="button" tabindex="0"
        aria-label="Montar ${esc(p.descricao)}">
      <div class="card-foto">${foto
        ? `<img src="${esc(foto)}" alt="${esc(p.descricao)}" loading="lazy">`
        : '<span class="sem-foto">sem foto</span>'}
        ${p.destaque ? '<span class="selo">★</span>' : ''}</div>
      <div class="card-txt">
        <h3>${esc(p.descricao)}</h3>
        <div class="linha-preco">${p.preco == null ? '<span class="sob">Monte o seu</span>'
          : `<span class="sob">a partir de</span><span class="preco">${brl(p.preco)}</span>`}</div>
      </div>
      <button class="mais" data-montar="${p.id}" aria-label="Montar ${esc(p.descricao)}">+</button>
    </article>`;
  }
  return `<article class="card" data-abrir="${p.id}" role="button" tabindex="0"
      aria-label="Abrir ${esc(p.descricao)}">
    <div class="card-foto">${foto
      ? `<img src="${esc(foto)}" alt="${esc(p.descricao)}" loading="lazy">`
      : '<span class="sem-foto">sem foto</span>'}
      ${p.destaque ? '<span class="selo">★</span>' : ''}
      ${p.precoAnterior ? '<span class="selo-oferta">Oferta</span>' : ''}</div>
    <div class="card-txt">
      <h3>${esc(p.descricao)}</h3>
      ${p.marca ? `<p class="marca">${esc(p.marca)}</p>` : ''}
      <div class="linha-preco">${precoHtml(p)}</div>
    </div>
    <button class="mais" data-mais="${p.id}" aria-label="Adicionar ${esc(p.descricao)}">+</button>
  </article>`;
}

/* ===================== o que falta preencher ===============================
   Uma peça só para a loja inteira: montador, página do produto, sacola e
   checkout. Quem valida diz O QUE falta e ONDE; daqui para a frente o
   tratamento é sempre o mesmo — borda no campo ou no grupo de opções, uma
   frase curta logo abaixo, a página rolando até o primeiro que falta, o foco
   nele, e a marca saindo sozinha assim que a pessoa mexe naquilo.

   O que NÃO passa por aqui é o erro que não pertence a campo nenhum (a loja
   fechou, a rede caiu, a sacola esvaziou): esse continua numa faixa no alto
   da tela, onde `faixaDeErro` o põe.
   ========================================================================= */

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

/**
 * Marca o que falta e leva a pessoa até o primeiro.
 *
 * `levar: false` serve para quem repinta a tela e precisa só repor as marcas
 * que já estavam lá — é o caso do montador, que redesenha os passos a cada
 * escolha. Sem isso, a página pularia sozinha a cada clique.
 *
 * @param {Array<{el: Element, diz: string}>} faltas
 * @returns {boolean} se havia alguma
 */
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

function marcarFaltas(faltas, { levar = true } = {}) {
  limparFaltas();
  /* Ordenadas pela posição no DOM, e não pela ordem em que quem valida as
     descobriu: a pessoa é levada ao primeiro que falta OLHANDO A TELA. */
  const validas = (faltas || []).filter((f) => f && f.el).sort((a, b) =>
    (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  for (const { el, diz } of validas) marcarFalta(el, diz);
  if (!validas.length) return false;
  if (levar) {
    const primeiro = validas[0].el;
    primeiro.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const foco = primeiro.matches('input, select, textarea') ? primeiro
      : primeiro.querySelector('input, select, textarea, button');
    if (foco) foco.focus({ preventScroll: true });
  }
  return true;
}

/** A faixa do alto: erro que não é de campo. Vazio esconde a faixa. */
function faixaDeErro(id, texto) {
  const el = $(id);
  if (!el) return;
  el.textContent = texto || '';
  el.hidden = !texto;
  if (texto) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/* A marca sai sozinha quando a pessoa mexe no que faltava. Em captura, para
   valer mesmo quando o elemento é repintado por um handler que rode depois. */
for (const evento of ['input', 'change']) {
  document.addEventListener(evento, (e) => limparFalta(e.target), true);
}
document.addEventListener('click', (e) => {
  // Grupo de opções: quem está marcado é a caixa, e quem recebe o clique é o
  // botão de dentro.
  const alvo = e.target.closest && e.target.closest('.falta');
  if (alvo) limparFalta(alvo);
}, true);

/* ===================== campos que se formatam sozinhos =====================
   A segunda metade da peça de cima: aqui o campo se arruma enquanto a pessoa
   digita, e diz o que está errado do mesmo jeito que o que falta.

   Quem liga isso é o ATRIBUTO no HTML (`data-formato="telefone"`), e não uma
   lista de ids espalhada pelo código: campo novo em qualquer formulário da
   loja nasce formatado só por declarar o formato.

   O que sai daqui para o servidor são os DÍGITOS (`digitosDe`): a máscara é
   de leitura, e o pedido não carrega ponto nem hífen.
   ========================================================================= */

const digitosDe = (v) => String(v || '').replace(/\D/g, '');

/** (94) 99176-9924 e (94) 3322-1100 — celular e fixo, pelo tamanho. */
function formatarTelefone(bruto) {
  const d = digitosDe(bruto).slice(0, 11);
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
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
            .replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  return d.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
          .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d{1,2})$/, '$1-$2');
}

const formatarCep = (bruto) => {
  const d = digitosDe(bruto).slice(0, 8);
  return d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
};

/** "1234" → "R$ 12,34": o dinheiro cresce da direita, como na maquininha. */
function formatarDinheiro(bruto) {
  const d = digitosDe(bruto).slice(0, 11);
  if (!d) return '';
  const n = Number(d) / 100;
  return 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const FORMATOS = {
  telefone: formatarTelefone, cpfcnpj: formatarCpfCnpj, cep: formatarCep, dinheiro: formatarDinheiro,
};

/** Os dígitos verificadores do CPF. Formato certo com DV errado é erro de digitação. */
function cpfValido(d) {
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  for (const [ate, pos] of [[9, 10], [10, 11]]) {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * (pos - i);
    const dv = (soma * 10) % 11 % 10;
    if (dv !== Number(d[ate])) return false;
  }
  return true;
}

function cnpjValido(d) {
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const conta = (ate) => {
    const pesos = ate === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(d[i]) * pesos[i];
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return conta(12) === Number(d[12]) && conta(13) === Number(d[13]);
}

const cpfCnpjValido = (d) => (d.length > 11 ? cnpjValido(d) : cpfValido(d));
const emailValido = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(v || '').trim());

/**
 * O que há de errado NESTE campo, ou null.
 *
 * Campo vazio não é erro aqui: quem cobra o preenchimento é a validação de
 * cada formulário, que sabe o que é obrigatório onde. Aqui só se olha o que
 * já foi digitado.
 */
function erroDoCampo(el) {
  if (!el || !el.dataset || !el.dataset.formato) return null;
  const v = String(el.value || '').trim();
  if (!v) return null;
  const d = digitosDe(v);
  switch (el.dataset.formato) {
    case 'telefone': return d.length >= 10 ? null : 'Telefone com DDD, 10 ou 11 números';
    case 'cpfcnpj':
      if (d.length !== 11 && d.length !== 14) return 'CPF tem 11 números, CNPJ tem 14';
      return cpfCnpjValido(d) ? null : (d.length === 11 ? 'CPF inválido. Confira os números' : 'CNPJ inválido. Confira os números');
    case 'cep': return d.length === 8 ? null : 'CEP tem 8 números';
    case 'email': return emailValido(v) ? null : 'E-mail inválido';
    default: return null;
  }
}

/** Todos os campos de um formulário que estão preenchidos e errados. */
function faltasDeFormato(raiz) {
  const fora = [];
  for (const el of (raiz || document).querySelectorAll('[data-formato]')) {
    if (el.offsetParent === null) continue;          // campo escondido não é cobrado
    const diz = erroDoCampo(el);
    if (diz) fora.push({ el, diz });
  }
  return fora;
}

/* A máscara é aplicada a cada tecla, e também ao COLAR — é o mesmo evento
   `input`, e por isso um número colado com pontos entra formatado igual. */
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el || !el.dataset || !el.dataset.formato) return;
  const fn = FORMATOS[el.dataset.formato];
  if (!fn) return;
  const antes = el.value;
  const fimDaDireita = antes.length - el.selectionEnd;
  const depois = fn(antes);
  if (depois === antes) return;
  el.value = depois;
  /* O cursor é reposto contando da DIREITA: com a máscara crescendo à
     esquerda (o dinheiro) ou ganhando separadores no meio (o telefone),
     guardar a posição absoluta jogaria o cursor para trás a cada pontuação. */
  if (el.selectionEnd != null) {
    const pos = Math.max(0, depois.length - fimDaDireita);
    try { el.setSelectionRange(pos, pos); } catch { /* type=email não aceita */ }
  }
});

/**
 * CEP completo busca rua, bairro e cidade.
 *
 * O mesmo ViaCEP que o cadastro de pessoas do ERP já usa
 * (`public/comercial/pessoas.html`), chamado do navegador de quem compra. Só
 * preenche campo VAZIO: quem já digitou a rua não a vê ser trocada, e tudo
 * continua editável. Falhou a consulta, nada acontece — o endereço é
 * digitável do mesmo jeito.
 */
let CEP_BUSCADO = null;
async function buscarCep(el) {
  const d = digitosDe(el.value);
  if (d.length !== 8 || d === CEP_BUSCADO) return;
  CEP_BUSCADO = d;
  try {
    const r = await fetch('https://viacep.com.br/ws/' + d + '/json/').then((x) => x.json());
    if (!r || r.erro) return;
    const por = { chkRua: r.logradouro, chkBairro: r.bairro, chkCidade: r.localidade, chkUf: r.uf };
    for (const [id, valor] of Object.entries(por)) {
      const campo = $(id);
      if (campo && !campo.value.trim() && valor) {
        campo.value = valor;
        limparFalta(campo);
        guardarCampoCheckout(campo);
      }
    }
    const numero = $('chkNumero');
    if (numero && !numero.value.trim()) numero.focus();
  } catch { /* sem internet para o ViaCEP: o endereço continua à mão */ }
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'chkCep') buscarCep(e.target);
});

/* Sair do campo é o momento de conferir: no meio da digitação todo telefone
   está incompleto, e marcar a cada tecla seria acusar quem está escrevendo. */
document.addEventListener('blur', (e) => {
  const el = e.target;
  if (!el || !el.dataset || !el.dataset.formato) return;
  const diz = erroDoCampo(el);
  // `marcarFalta`, e não `marcarFaltas`: sair de um campo não pode apagar a
  // marca dos outros.
  if (diz) marcarFalta(el, diz);
}, true);

/* ===================== HOME ================================================ */

function pintarHome() {
  const q = ($('busca') && $('busca').value || '').toLowerCase().trim();
  const casa = (p) => !q || [p.descricao, p.sku, p.marca].some((v) => String(v || '').toLowerCase().includes(q));
  const lista = PRODUTOS.filter(casa);

  const alvo = $('conteudo');
  if (!PRODUTOS.length) {
    alvo.innerHTML = '<div class="vazio-msg">Este catálogo ainda não tem produtos publicados.<br>Volte em breve.</div>';
    return;
  }
  if (!lista.length) {
    alvo.innerHTML = '<div class="vazio-msg">Nenhum produto encontrado para esta busca.</div>';
    return;
  }

  const secoes = [];
  // Ofertas no topo: é a promoção vigente (tabela de preço com vigência), a
  // mesma que dá o preço riscado. Sem oferta, a seção não existe.
  const ofertas = lista.filter((p) => p.precoAnterior);
  if (ofertas.length) {
    secoes.push(`<section class="secao" id="sec-ofertas">
      <h2>Ofertas</h2><div class="grade">${ofertas.map(cardHtml).join('')}</div></section>`);
  }
  // Destaques depois das ofertas — e só quando existem. Seção vazia é ruído.
  const destaques = lista.filter((p) => p.destaque);
  if (destaques.length) {
    secoes.push(`<section class="secao" id="sec-destaques">
      <h2>Destaques</h2><div class="grade">${destaques.map(cardHtml).join('')}</div></section>`);
  }
  for (const c of CATEGORIAS) {
    const doGrupo = lista.filter((p) => (p.categoria || '') === c);
    if (!doGrupo.length) continue;
    secoes.push(`<section class="secao" id="sec-${encodeURIComponent(c)}">
      <h2>${esc(c)}</h2><div class="grade">${doGrupo.map(cardHtml).join('')}</div></section>`);
  }
  const semCat = lista.filter((p) => !(p.categoria || '').trim());
  if (semCat.length) {
    secoes.push(`<section class="secao"><h2>Outros</h2>
      <div class="grade">${semCat.map(cardHtml).join('')}</div></section>`);
  }
  alvo.innerHTML = secoes.join('');
}

function pintarCategorias() {
  const nav = $('navCats');
  const temDestaque = PRODUTOS.some((p) => p.destaque);
  const itens = [];
  if (PRODUTOS.some((p) => p.precoAnterior)) itens.push('<button data-ir="sec-ofertas">Ofertas</button>');
  if (temDestaque) itens.push('<button data-ir="sec-destaques">Destaques</button>');
  for (const c of CATEGORIAS) itens.push(`<button data-ir="sec-${encodeURIComponent(c)}">${esc(c)}</button>`);
  nav.innerHTML = itens.join('');
  nav.hidden = !itens.length;
}

/* ===================== PRODUTO ============================================= */

let PRODUTO = null;
let ESCOLHAS = { opcoes: new Set(), textos: {}, quantidade: 1 };

async function abrirProduto(id) {
  const alvo = $('conteudo');
  alvo.innerHTML = '<div class="vazio-msg">Carregando…</div>';
  try {
    const d = await fetch('/loja/api/produtos/' + Number(id)).then((r) => r.json());
    if (!d.success) throw new Error(d.error || 'Produto não encontrado');
    /* Produto montável não tem página comum: o que ele custa depende do
       formato, da quantidade e da cor, e a página do produto mostraria o
       `precoVenda` do cadastro, que nos montáveis é zero. Link antigo,
       sugestão ou busca, todos caem no montador. */
    if (d.produto.montavel) return irPara('#/montar/' + Number(id));
    PRODUTO = d.produto;
    ESCOLHAS = { opcoes: new Set(), textos: {}, quantidade: 1 };
    pintarProduto();
  } catch (e) {
    alvo.innerHTML = `<div class="vazio-msg">${esc(e.message)}
      <br><button class="btn-linha" data-voltar="1">Voltar ao catálogo</button></div>`;
  }
}

function pintarProduto() {
  const p = PRODUTO;
  const foto = fotoDe(p);
  const grupos = (p.personalizacoes || []).map((g) => {
    if (g.tipo === 'texto') {
      return `<fieldset class="grupo" id="pGrupo${g.id}">
        <legend>${esc(g.nome)} ${g.obrigatorio ? '<span class="obrig">obrigatório</span>' : ''}</legend>
        ${g.descricao ? `<p class="ajuda">${esc(g.descricao)}</p>` : ''}
        <textarea data-texto="${g.id}" rows="2" maxlength="300"
          placeholder="Escreva aqui…">${esc(ESCOLHAS.textos[g.id] || '')}</textarea>
      </fieldset>`;
    }
    /* Caixa, e não bolinha, em todo grupo que a pessoa pode deixar em branco.
       O rádio não desmarca: quem tocava "4 unidades" só para ver o preço
       ficava com o adicional somado até recarregar a página. Só o grupo
       OBRIGATÓRIO de escolha única continua rádio, que é onde não desmarcar é
       a regra certa. A exclusividade da escolha única é mantida no handler. */
    const multi = g.maxEscolhas > 1 || !g.obrigatorio;
    return `<fieldset class="grupo" id="pGrupo${g.id}">
      <legend>${esc(g.nome)} ${g.obrigatorio ? '<span class="obrig">obrigatório</span>' : ''}</legend>
      ${g.descricao ? `<p class="ajuda">${esc(g.descricao)}</p>` : ''}
      ${g.opcoes.map((o) => `<label class="opcao">
        <input type="${multi ? 'checkbox' : 'radio'}" name="g${g.id}" value="${o.id}"
          data-grupo="${g.id}" ${ESCOLHAS.opcoes.has(o.id) ? 'checked' : ''}>
        <span class="op-nome">${esc(o.nome)}</span>
        ${o.precoAdicional > 0 ? `<span class="op-mais">+ ${brl(o.precoAdicional)}</span>` : ''}
      </label>`).join('')}
    </fieldset>`;
  }).join('');

  const desc = p.observacoes || '';
  const longa = desc.length > 220;

  $('conteudo').innerHTML = `
    <p class="chk-erro" id="erroProduto" hidden></p>
    <article class="produto">
      <div class="p-foto">${foto
        ? `<img src="${esc(foto)}" alt="${esc(p.descricao)}">`
        : '<span class="sem-foto">sem foto</span>'}</div>
      <div class="p-info">
        <h1>${esc(p.descricao)}</h1>
        ${p.marca ? `<p class="marca">${esc(p.marca)}</p>` : ''}
        <div class="linha-preco grande">${precoHtml(p)}</div>
        ${p.estoque ? `<p class="tag ${p.estoque}">${ROTULO[p.estoque] || ''}</p>` : ''}
        ${desc ? `<div class="desc ${longa ? 'cortada' : ''}" id="desc">${esc(desc)}</div>
          ${longa ? '<button class="btn-linha" id="btLer">Ler mais</button>' : ''}` : ''}
        ${grupos ? `<div class="personalizacoes"><h2>Personalizações</h2>${grupos}</div>` : ''}
        <fieldset class="grupo">
          <legend>Comentários</legend>
          <textarea id="comentario" rows="2" maxlength="300"
            placeholder="Alguma observação para a loja?"></textarea>
        </fieldset>
        <div class="qtd-linha">
          <span>Quantidade</span>
          <div class="qtd">
            <button data-q="-1" aria-label="Diminuir">−</button>
            <output id="qtd">1</output>
            <button data-q="1" aria-label="Aumentar">+</button>
          </div>
        </div>
      </div>
    </article>
    <div class="barra-produto">
      <button class="principal" id="btAdicionar">Adicionar ${brl(totalPrevia())}</button>
    </div>`;
  ligarProduto();
}

/**
 * O que falta na página do produto: grupo obrigatório sem escolha e texto
 * obrigatório em branco. A conferência do servidor continua valendo depois —
 * esta aqui existe para a pessoa ver onde falta, e não para substituí-la.
 */
function faltasDoProduto() {
  const fora = [];
  for (const g of (PRODUTO.personalizacoes || [])) {
    const el = $('pGrupo' + g.id);
    if (!el) continue;
    if (g.tipo === 'texto') {
      if (g.obrigatorio && !String(ESCOLHAS.textos[g.id] || '').trim()) {
        fora.push({ el, diz: 'Falta preencher' });
      }
      continue;
    }
    const marcadas = g.opcoes.filter((o) => ESCOLHAS.opcoes.has(o.id)).length;
    if (marcadas < g.minEscolhas) {
      fora.push({ el, diz: g.minEscolhas > 1 ? `Escolha ${g.minEscolhas}` : 'Escolha uma opção' });
    } else if (marcadas > g.maxEscolhas) {
      fora.push({ el, diz: `Escolha no máximo ${g.maxEscolhas}` });
    }
  }
  return fora;
}

/** Prévia local — o valor definitivo é o que o servidor devolve ao adicionar. */
function totalPrevia() {
  if (!PRODUTO || PRODUTO.preco == null) return 0;
  let adicional = 0;
  for (const g of (PRODUTO.personalizacoes || [])) {
    for (const o of g.opcoes) if (ESCOLHAS.opcoes.has(o.id)) adicional += o.precoAdicional;
  }
  return (PRODUTO.preco + adicional) * ESCOLHAS.quantidade;
}

function atualizarBotaoProduto() {
  const b = $('btAdicionar');
  if (b) b.textContent = PRODUTO.preco == null ? 'Adicionar ao pedido' : 'Adicionar ' + brl(totalPrevia());
  const q = $('qtd');
  if (q) q.textContent = ESCOLHAS.quantidade;
}

function ligarProduto() {
  const ler = $('btLer');
  if (ler) ler.onclick = () => {
    const d = $('desc');
    const aberta = d.classList.toggle('cortada');
    ler.textContent = aberta ? 'Ler mais' : 'Ler menos';
  };

  $('conteudo').addEventListener('change', (e) => {
    const inp = e.target.closest('input[data-grupo]');
    if (inp) {
      const grupoId = Number(inp.dataset.grupo);
      const id = Number(inp.value);
      const grupo = PRODUTO.personalizacoes.find((g) => g.id === grupoId);
      if (!inp.checked) ESCOLHAS.opcoes.delete(id);
      else {
        // Escolha única continua única, venha ela de rádio ou de caixa.
        if (grupo.maxEscolhas <= 1) {
          for (const o of grupo.opcoes) ESCOLHAS.opcoes.delete(o.id);
          for (const outro of $('conteudo').querySelectorAll(`input[data-grupo="${grupoId}"]`)) {
            if (outro !== inp) outro.checked = false;
          }
        }
        ESCOLHAS.opcoes.add(id);
      }
      atualizarBotaoProduto();
    }
    const txt = e.target.closest('textarea[data-texto]');
    if (txt) ESCOLHAS.textos[Number(txt.dataset.texto)] = txt.value;
  });

  $('conteudo').addEventListener('click', (e) => {
    const b = e.target.closest('[data-q]');
    if (!b) return;
    ESCOLHAS.quantidade = Math.max(1, ESCOLHAS.quantidade + Number(b.dataset.q));
    atualizarBotaoProduto();
  });

  $('btAdicionar').onclick = async () => {
    faixaDeErro('erroProduto', '');
    if (marcarFaltas(faltasDoProduto())) return;
    const item = {
      produtoId: PRODUTO.id,
      quantidade: ESCOLHAS.quantidade,
      opcoes: [...ESCOLHAS.opcoes],
      textos: ESCOLHAS.textos,
      comentario: ($('comentario').value || '').trim() || null,
    };
    /* Valida no SERVIDOR antes de guardar: grupo obrigatório sem escolha volta
       com o motivo, e nada entra na sacola. Validar só no navegador deixaria o
       item entrar e quebrar depois, na hora do pedido. */
    const r = await fetch('/loja/api/carrinho/calcular', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itens: [item] }),
    }).then((x) => x.json()).catch(() => null);
    if (!r || !r.success) {
      // Recusa de um grupo marca o grupo; o resto vai para a faixa do alto.
      const grupo = r && r.grupoId && $('pGrupo' + r.grupoId);
      if (grupo) marcarFaltas([{ el: grupo, diz: r.error }]);
      else faixaDeErro('erroProduto', (r && r.error) || 'Não foi possível adicionar.');
      return;
    }
    await adicionar(item);
    irPara('#/');
  };
  atualizarBotaoProduto();
}

/* ===================== SACOLA ============================================== */

/**
 * O adicional dito por inteiro: "Cartão de mensagem: Modelo 4".
 *
 * Só a opção ("Modelo 4", "12 unidades", "3 fotos") não diz de que ela é, e
 * na sacola as três aparecem em sequência. O nome do grupo vem do servidor,
 * que é quem sabe a que grupo a opção pertence. Item antigo, gravado antes
 * disso, continua mostrando só a opção em vez de uma linha vazia.
 */
const nomeDoAdicional = (o) => (o.grupoNome ? `${o.grupoNome}: ${o.nome}` : o.nome);

async function pintarSacola() {
  await recalcular();
  const alvo = $('conteudo');
  if (!SACOLA.itens.length) {
    alvo.innerHTML = `<div class="vazio-msg">Sua sacola está vazia.
      <br><button class="btn-linha" data-voltar="1">Ver o catálogo</button></div>`;
    return;
  }

  const linhas = SACOLA.itens.map((i, idx) => `
    <li class="item-sacola">
      <div class="is-foto">${i.foto
        ? `<img src="${esc(i.foto)}" alt="">` : '<span class="sem-foto">—</span>'}</div>
      <div class="is-txt">
        <strong>${esc(i.descricao)}</strong>
        ${i.opcoes.length ? `<span class="is-op">${i.opcoes.map(nomeDoAdicional).map(esc).join(', ')}</span>` : ''}
        ${(i.textosNomeados || []).map((t) => `<span class="is-op">${esc(t.nome)}: “${esc(t.texto)}”</span>`).join('')}
        ${i.comentario ? `<span class="is-op">“${esc(i.comentario)}”</span>` : ''}
        <span class="is-preco">${i.total == null ? 'a combinar' : brl(i.total)}</span>
      </div>
      <div class="is-acoes">
        ${i.montagem ? '' : `<div class="qtd">
          <button data-menos="${idx}" aria-label="Diminuir">−</button>
          <output>${i.quantidade}</output>
          <button data-mais-item="${idx}" aria-label="Aumentar">+</button>
        </div>`}
        ${i.montagem ? `<button class="excluir editar" data-editar="${idx}">Editar</button>` : ''}
        <button class="excluir" data-remover="${idx}" aria-label="Remover">Excluir</button>
      </div>
    </li>`).join('');

  alvo.innerHTML = `
    <div class="sacola-topo">
      <h1>Sua sacola</h1>
      <strong>${SACOLA.semPreco ? 'a combinar' : brl(SACOLA.total)}</strong>
    </div>
    <ul class="lista-sacola">${linhas}</ul>`;
  /* A escolha de receber e as sugestões vivem FORA do `#conteudo`, logo abaixo
     dele: esta função reescreve o innerHTML a cada mudança de quantidade, e
     quem estivesse ali dentro seria recriado junto, perdendo o foco de quem
     navega por teclado no meio de um ajuste. */
  pintarBarraAtendimento();
  carregarSugestoes();
}

/* ===================== checkout ===========================================
   Do carrinho ao pedido comercial. As etapas que o pedido pediu — como
   receber, dados, endereço, pagamento, observações, revisão — vivem numa
   página só, empilhadas: num celular, oito telas em sequência custam oito
   esperas e escondem o que já foi preenchido.

   Nada de preço, frete ou total é enviado. O corpo leva referência de produto,
   quantidade, escolhas e o que só o cliente sabe; o resto o servidor decide.
   ========================================================================= */

/** Estado do formulário. Só vive enquanto a aba está aberta. */
/* `campos` guarda o que foi digitado no checkout, por id do campo. Sem ele,
   ir à sacola trocar um item e voltar apagava nome, telefone e endereço: o
   `corpoDoPedido()` lê do DOM, e o DOM é remontado a cada entrada na tela. */
let CHECKOUT = { atendimento: null, pagamento: null, chave: null, enviando: false, campos: {} };

/* ── formas de pagamento ─────────────────────────────────────────────────
 *
 * Quem decide o que aparece é o servidor: `LOJA.metodosPagamento` já vem
 * filtrado por método ativo, atendimento e provedor no ar. Aqui só se pinta.
 * A mesma função roda de novo no `finalizar`, do lado de lá, porque uma
 * requisição montada à mão não passa por esta tela.
 *
 * A lista muda com o atendimento (uma loja pode receber cartão na entrega e
 * só dinheiro na retirada), então ela é repintada a cada troca.
 */
/* Servidor ANTERIOR a 30/09 não manda `metodosPagamento`, e este arquivo é
   estático: ele entra no ar ao ser salvo, enquanto o `loja-routes.js` só
   passa a valer no restart. Entre uma coisa e outra existe uma janela real
   em que a loja publicada seria atendida pela tela nova e pelo servidor
   velho — e sem isto o cliente veria "esta loja ainda não configurou como
   receber", com a loja funcionando.

   O que vale nessa janela é exatamente o que valia antes: Pix sozinho quando
   a loja cobrava no site, e os três de sempre quando não cobrava. */
const METODOS_LEGADO = [
  { metodo: 'pix', rotulo: 'PIX', descricao: '', modalidade: 'manual' },
  { metodo: 'dinheiro', rotulo: 'Dinheiro', descricao: '', modalidade: 'manual' },
  { metodo: 'cartao', rotulo: 'Cartão', descricao: 'na entrega/retirada', modalidade: 'manual' },
];

function metodosDoAtendimento(atend) {
  if (!atend) return [];
  const m = LOJA && LOJA.metodosPagamento;
  if (!m) {
    return LOJA && LOJA.pixNoSite
      ? [{ ...METODOS_LEGADO[0], modalidade: 'online' }]
      : METODOS_LEGADO;
  }
  return (atend === 'entrega' ? m.entrega : m.retirada) || [];
}

const metodoAtual = () =>
  metodosDoAtendimento(CHECKOUT.atendimento).find((m) => m.metodo === CHECKOUT.pagamento) || null;

const ehOnline = () => { const m = metodoAtual(); return !!(m && m.modalidade === 'online'); };

/** Grava o que a pessoa digitou, para a tela voltar como ela deixou. */
function guardarCampoCheckout(el) {
  if (!el || !el.id || !el.id.startsWith('chk')) return;
  CHECKOUT.campos[el.id] = el.type === 'checkbox' ? el.checked : el.value;
}

/** Repõe no DOM o que já tinha sido digitado. */
function reporCamposCheckout() {
  for (const [id, valor] of Object.entries(CHECKOUT.campos)) {
    const el = $(id);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!valor;
    else el.value = valor;
  }
}

/**
 * A chave da tentativa.
 *
 * Nasce quando o cliente entra no checkout e vale até o pedido sair: é isso
 * que faz duplo clique, retry e F5 convergirem para UM pedido. Gerar uma por
 * clique no botão devolveria o problema que ela existe para resolver.
 */
function chaveDaTentativa() {
  if (!CHECKOUT.chave) {
    CHECKOUT.chave = (crypto.randomUUID && crypto.randomUUID())
      || (Date.now() + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  }
  return CHECKOUT.chave;
}

async function pintarCheckout() {
  await recalcular();
  const alvo = $('conteudo');
  if (!SACOLA.itens.length) { location.hash = '#/'; return; }

  const e = (LOJA && LOJA.entrega) || {};
  const podeRetirada = !!e.retirada;
  const podeEntrega = !!e.delivery;
  if (!podeRetirada && !podeEntrega) {
    alvo.innerHTML = `<div class="vazio-msg">Esta loja não está recebendo pedidos agora.
      <br><button class="btn-linha" data-voltar="1">Ver o catálogo</button></div>`;
    return;
  }
  /* A forma de pagamento é marcada por pintarPagamentos(), que roda depois
     desta montagem: ela depende do atendimento, que pode ainda não estar
     escolhido aqui. Nada de Pix é decidido neste ponto. */
  const datas = SACOLA.itens.map((i) => i.dataDesejada).filter(Boolean).sort();
  // Serviço único não é escolha: já vem marcado.
  if (!CHECKOUT.atendimento) {
    CHECKOUT.atendimento = podeRetirada && !podeEntrega ? 'retirada'
      : (!podeRetirada && podeEntrega ? 'entrega' : null);
  }

  alvo.innerHTML = `
    <div class="chk">
      <!-- Sem isto o checkout era uma rua sem retorno: quem quisesse mexer na
           sacola só voltava pela seta do navegador, e nem toda pessoa a usa
           num site aberto pelo WhatsApp. -->
      <button type="button" class="btn-linha chk-voltar" data-voltar-sacola="1">← Voltar à sacola</button>
      <h1>Finalizar pedido</h1>
      <!-- Faixa do alto: só o erro que não é de campo (a loja fechou, a rede
           caiu, a sacola esvaziou). O que é de campo é marcado no campo. -->
      <p class="chk-erro" id="chkErro" hidden></p>

      <section class="chk-bloco">
        <h2>Como você quer receber?</h2>
        <div class="chk-opcoes" id="chkAtendOps">
          ${podeRetirada ? `<button type="button" class="chk-op" data-atend="retirada">
            <strong>Retirada</strong><span>Você busca na loja</span></button>` : ''}
          ${podeEntrega ? `<button type="button" class="chk-op" data-atend="entrega">
            <strong>Entrega</strong><span>Entregamos no seu endereço</span></button>` : ''}
        </div>
        <div id="chkRetiradaInfo" class="chk-aviso" hidden></div>
      </section>

      <section class="chk-bloco">
        <h2>Seus dados</h2>
        <div class="chk-campo">
          <label for="chkNome">Nome *</label>
          <input id="chkNome" type="text" autocomplete="name" maxlength="80" placeholder="Como devemos chamar você">
        </div>
        <div class="chk-campo">
          <label for="chkTelefone">WhatsApp / telefone *</label>
          <input id="chkTelefone" type="tel" inputmode="numeric" autocomplete="tel"
                 data-formato="telefone" maxlength="16" placeholder="(00) 00000-0000">
        </div>
        <div class="chk-campo">
          <!-- Rótulo e placeholder são trocados por pintarEscolhas(): o CPF
               vira obrigatório quando a forma escolhida é cobrada pelo site,
               e essa escolha acontece depois deste campo ser desenhado. -->
          <label for="chkDoc" id="chkDocRot">CPF ou CNPJ <span class="chk-op-txt">(opcional)</span></label>
          <input id="chkDoc" type="text" inputmode="numeric" data-formato="cpfcnpj" maxlength="18"
                 placeholder="Só se quiser na nota">
        </div>
        <div class="chk-campo">
          <label for="chkEmail">E-mail <span class="chk-op-txt">(opcional)</span></label>
          <input id="chkEmail" type="email" inputmode="email" autocomplete="email"
                 data-formato="email" maxlength="120" placeholder="voce@email.com">
        </div>
        <label class="chk-check">
          <input type="checkbox" id="chkPromocoes"> Quero receber as promoções da loja
        </label>
      </section>

      <section class="chk-bloco" id="chkEndereco" hidden>
        <h2>Endereço de entrega</h2>
        <div class="chk-linha">
          <div class="chk-campo chk-cep">
            <label for="chkCep">CEP</label>
            <input id="chkCep" type="text" inputmode="numeric" data-formato="cep"
                   autocomplete="postal-code" maxlength="9" placeholder="00000-000">
          </div>
          <div class="chk-campo chk-num">
            <label for="chkNumero">Número *</label>
            <input id="chkNumero" type="text" maxlength="20" placeholder="123">
          </div>
        </div>
        <div class="chk-campo">
          <label for="chkRua">Rua *</label>
          <input id="chkRua" type="text" autocomplete="address-line1" maxlength="200">
        </div>
        <div class="chk-campo">
          <label for="chkComplemento">Complemento</label>
          <input id="chkComplemento" type="text" maxlength="100" placeholder="Apto, bloco, casa">
        </div>
        <div class="chk-campo">
          <label for="chkBairro">Bairro *</label>
          ${(e.freteModo === 'bairro' && (e.bairros || []).length)
            ? `<select id="chkBairro">
                 <option value="">Escolha o bairro</option>
                 ${e.bairros.map((b) => `<option value="${esc(b.nome)}">${esc(b.nome)}${
                     b.taxa ? ' — ' + brl(b.taxa) : ' — grátis'}</option>`).join('')}
               </select>`
            : '<input id="chkBairro" type="text" maxlength="80">'}
        </div>
        <div class="chk-linha">
          <div class="chk-campo"><label for="chkCidade">Cidade *</label>
            <input id="chkCidade" type="text" maxlength="100"></div>
          <div class="chk-campo chk-uf"><label for="chkUf">UF *</label>
            <input id="chkUf" type="text" maxlength="2" placeholder="PA"></div>
        </div>
        <div class="chk-campo">
          <label for="chkReferencia">Ponto de referência</label>
          <input id="chkReferencia" type="text" maxlength="120" placeholder="Perto de…">
        </div>
      </section>

      <section class="chk-bloco">
        <h2>Pagamento</h2>
        <p class="chk-aviso" id="chkQuandoPaga"></p>
        <!-- Montado por pintarPagamentos(), que depende do atendimento. -->
        <div class="chk-opcoes" id="chkPagOps"></div>
        <div id="chkTroco" hidden>
          <label class="chk-check">
            <input type="checkbox" id="chkPrecisaTroco"> Precisa de troco?
          </label>
          <div class="chk-campo" id="chkTrocoValor" hidden>
            <label for="chkTrocoPara">Troco para quanto?</label>
            <input id="chkTrocoPara" type="text" inputmode="numeric" data-formato="dinheiro"
                   maxlength="16" placeholder="R$ 0,00">
          </div>
        </div>
      </section>

      <section class="chk-bloco">
        <h2>Observações</h2>
        <div class="chk-campo">
          <textarea id="chkObs" rows="3" maxlength="300"
                    placeholder="Algo que a loja precise saber"></textarea>
        </div>
      </section>

      <section class="chk-bloco chk-revisao">
        <h2>Revise seu pedido</h2>
        <ul class="chk-itens">${SACOLA.itens.map((i) => `
          <li><span>${i.quantidade}× ${esc(i.descricao)}${
            i.opcoes.length ? ` <em>(${i.opcoes.map((o) => esc(o.nome)).join(', ')})</em>` : ''}</span>
              <strong>${i.total == null ? '—' : brl(i.total)}</strong></li>`).join('')}
        </ul>
        <div class="chk-totais">
          <div><span>Subtotal</span><span id="chkSubtotal">${brl(SACOLA.total)}</span></div>
          <div id="chkLinhaFrete" hidden><span>Entrega</span><span id="chkFrete">—</span></div>
          <div class="chk-total"><span>Total</span><span id="chkTotal">${brl(SACOLA.total)}</span></div>
        </div>
        ${datas.length ? `<p class="chk-aviso">Para quando: <strong>${esc(datas[0].split('-').reverse().join('/'))}</strong></p>` : ''}
        <p class="chk-aviso" id="chkAvisoFrete" hidden></p>
      </section>

      <button type="button" class="bt-principal" id="btFinalizar">Finalizar pedido</button>
      <button type="button" class="btn-linha" data-voltar-sacola="1">Voltar à sacola</button>
    </div>`;

  reporCamposCheckout();
  pintarEscolhas();
}

/** Marca os botões escolhidos e mostra/esconde o que depende deles. */
/**
 * Redesenha as formas de pagamento do atendimento escolhido.
 *
 * Roda a cada troca de atendimento, e é aí que a escolha anterior pode deixar
 * de valer: quem marcou "cartão" para entrega e mudou para retirada numa loja
 * que só recebe dinheiro na porta não pode continuar com o cartão marcado. A
 * escolha é limpa, e não trocada em silêncio por outra — o cliente escolhe.
 */
function pintarPagamentos() {
  const caixa = $('chkPagOps');
  if (!caixa) return;
  const lista = metodosDoAtendimento(CHECKOUT.atendimento);

  if (CHECKOUT.pagamento && !lista.some((m) => m.metodo === CHECKOUT.pagamento)) {
    CHECKOUT.pagamento = null;
  }
  // Forma única não é escolha.
  if (!CHECKOUT.pagamento && lista.length === 1) CHECKOUT.pagamento = lista[0].metodo;

  if (!lista.length) {
    caixa.innerHTML = CHECKOUT.atendimento
      ? '<p class="chk-aviso">Esta loja ainda não configurou como receber neste tipo de pedido. Fale com ela pelo WhatsApp.</p>'
      : '<p class="chk-aviso">Escolha primeiro como quer receber.</p>';
    return;
  }
  caixa.innerHTML = lista.map((m) => `<button type="button" class="chk-op" data-pag="${esc(m.metodo)}">`
    + `<strong>${esc(m.rotulo)}</strong>`
    + (m.descricao ? `<span>${esc(m.descricao)}</span>` : '')
    + '</button>').join('');
}

function pintarEscolhas() {
  const e = (LOJA && LOJA.entrega) || {};
  document.querySelectorAll('[data-atend]').forEach((b) =>
    b.classList.toggle('on', b.dataset.atend === CHECKOUT.atendimento));
  pintarPagamentos();
  document.querySelectorAll('[data-pag]').forEach((b) =>
    b.classList.toggle('on', b.dataset.pag === CHECKOUT.pagamento));

  const entrega = CHECKOUT.atendimento === 'entrega';
  const end = $('chkEndereco');
  if (end) end.hidden = !entrega;

  /* Retirada: o endereço que importa é o DA LOJA, e ele já vem da
     configuração — o mesmo que o painel ⓘ mostra. */
  const info = $('chkRetiradaInfo');
  if (info) {
    if (CHECKOUT.atendimento === 'retirada' && (LOJA.endereco || LOJA.atendimento)) {
      info.hidden = false;
      info.innerHTML = [
        LOJA.endereco ? `Retire em: <strong>${esc(LOJA.endereco)}</strong>` : '',
        LOJA.atendimento && LOJA.atendimento.rotulo ? esc(LOJA.atendimento.rotulo) : '',
      ].filter(Boolean).join('<br>');
    } else { info.hidden = true; }
  }

  /* A frase segue o MÉTODO escolhido, e não mais a loja: com Pix online e
     dinheiro ativos ao mesmo tempo, as duas respostas convivem na mesma
     tela, e é a escolha do cliente que diz qual vale para ele. */
  const quando = $('chkQuandoPaga');
  if (quando) {
    if (!CHECKOUT.pagamento) {
      quando.textContent = '';
    } else if (ehOnline()) {
      quando.textContent = entrega && e.freteModo === 'combinar'
        ? 'A loja calcula a taxa de entrega e manda a cobrança do total pelo WhatsApp.'
        : 'A cobrança aparece logo depois de você confirmar o pedido.';
    } else {
      quando.textContent = `Você paga na ${entrega ? 'entrega' : 'retirada'}. Nada é cobrado agora.`;
    }
  }

  const rot = $('chkDocRot');
  const doc = $('chkDoc');
  if (rot && doc) {
    const obrig = ehOnline();
    rot.innerHTML = obrig ? 'CPF *' : 'CPF ou CNPJ <span class="chk-op-txt">(opcional)</span>';
    doc.placeholder = obrig ? 'A cobrança pelo site precisa dele' : 'Só se quiser na nota';
  }

  const troco = $('chkTroco');
  if (troco) {
    troco.hidden = CHECKOUT.pagamento !== 'dinheiro';
    if (troco.hidden) { $('chkPrecisaTroco').checked = false; $('chkTrocoValor').hidden = true; }
  }

  // Frete estimado na revisão. O valor que VALE é o que o servidor devolver.
  const linha = $('chkLinhaFrete');
  if (linha) {
    if (!entrega) { linha.hidden = true; $('chkAvisoFrete').hidden = true; atualizarTotal(0); return; }
    linha.hidden = false;
    const modo = e.freteModo;
    if (modo === 'combinar') { $('chkFrete').textContent = 'a combinar'; atualizarTotal(0); }
    else if (modo === 'gratis') { $('chkFrete').textContent = 'grátis'; atualizarTotal(0); }
    else if (modo === 'fixo') { $('chkFrete').textContent = brl(e.freteValor || 0); atualizarTotal(e.freteValor || 0); }
    else {
      const b = $('chkBairro');
      const nome = b ? (b.value || '') : '';
      const achado = (e.bairros || []).find((x) => x.nome === nome);
      if (achado) { $('chkFrete').textContent = brl(achado.taxa); atualizarTotal(achado.taxa); }
      else { $('chkFrete').textContent = 'a calcular'; atualizarTotal(0); }
    }
  }
}

function atualizarTotal(frete) {
  const t = $('chkTotal');
  if (t) t.textContent = brl((SACOLA.total || 0) + (Number(frete) || 0));
}

/** Monta o corpo: referências e intenção, nunca preço. */
function corpoDoPedido() {
  const v = (id) => { const el = $(id); return el ? el.value.trim() : ''; };
  /* A máscara é de leitura: o que viaja são os dígitos. O servidor já limpava
     o que chegasse, mas mandar "(94) 99176-9924" e deixar a limpeza para lá
     faz o mesmo valor ter duas formas conforme quem olha. */
  const so = (id) => digitosDe(v(id));
  const corpo = {
    idempotencyKey: chaveDaTentativa(),
    cliente: { nome: v('chkNome'), telefone: so('chkTelefone'), cpfCnpj: so('chkDoc') || null,
               email: v('chkEmail') || null, aceitePromocoes: !!($('chkPromocoes') && $('chkPromocoes').checked) },
    atendimento: CHECKOUT.atendimento,
    /* `metodo` é a chave de `loja_metodos_pagamento`. O código fiscal NÃO
       viaja daqui: quem o resolve é o servidor, porque é ele que vai para a
       nota.

       `pagamento` vai junto pelo motivo inverso do fallback acima: enquanto
       o servidor for o anterior a 30/09, é este campo que ele lê, e sem ele
       o pedido seria recusado com "escolha uma forma de pagamento". O
       servidor novo ignora `pagamento` quando `metodo` vem preenchido. */
    metodo: CHECKOUT.pagamento,
    pagamento: { pix_online: 'pix', pix_manual: 'pix', dinheiro: 'dinheiro',
                 credito_presencial: 'cartao', debito_presencial: 'cartao',
               }[CHECKOUT.pagamento] || CHECKOUT.pagamento,
    observacao: v('chkObs') || null,
    itens: lerCarrinho(),
  };
  if (CHECKOUT.atendimento === 'entrega') {
    corpo.endereco = {
      cep: so('chkCep'), logradouro: v('chkRua'), numero: v('chkNumero'),
      complemento: v('chkComplemento'), bairro: v('chkBairro'),
      cidade: v('chkCidade'), uf: v('chkUf'), referencia: v('chkReferencia'),
    };
  }
  if (CHECKOUT.pagamento === 'dinheiro' && $('chkPrecisaTroco') && $('chkPrecisaTroco').checked) {
    corpo.precisaTroco = true;
    // "R$ 1.234,56" → 1234.56: os centavos são os dois últimos dígitos.
    corpo.trocoPara = Number(digitosDe(v('chkTrocoPara'))) / 100;
  }
  return corpo;
}

/* Do nome que o servidor devolve em `campo` para o campo na tela. É o mesmo
   caminho para a validação daqui e para a de lá: o servidor NOMEIA o que
   recusou, e a tela sabe onde isso mora. Casar pela frase do erro seria uma
   segunda verdade, que se desfaz na primeira reescrita de mensagem. */
const CAMPO_DO_CHECKOUT = {
  nome: 'chkNome', telefone: 'chkTelefone', documento: 'chkDoc', email: 'chkEmail',
  cep: 'chkCep', numero: 'chkNumero', rua: 'chkRua', bairro: 'chkBairro',
  cidade: 'chkCidade', uf: 'chkUf', troco: 'chkTrocoPara',
  atendimento: 'chkAtendOps', pagamento: 'chkPagOps',
};

/** O que falta no checkout, na ordem da tela. */
function faltasDoCheckout() {
  const fora = [];
  const v = (id) => ($(id) ? $(id).value.trim() : '');
  const marcar = (id, diz) => { if ($(id)) fora.push({ el: $(id), diz }); };

  if (!CHECKOUT.atendimento) marcar('chkAtendOps', 'Escolha retirada ou entrega');
  if (v('chkNome').length < 2) marcar('chkNome', 'Falta preencher');
  // Só o VAZIO é cobrado aqui: número incompleto, CPF com dígito errado e
  // e-mail torto são da peça de formato, logo abaixo.
  if (!v('chkTelefone')) marcar('chkTelefone', 'Falta preencher');
  if (ehOnline() && !v('chkDoc')) marcar('chkDoc', 'A cobrança pelo site precisa do CPF');
  if (CHECKOUT.atendimento === 'entrega') {
    for (const [id, diz] of [['chkRua', 'Falta preencher'], ['chkNumero', 'Falta preencher'],
      ['chkBairro', 'Falta preencher'], ['chkCidade', 'Falta preencher'], ['chkUf', 'Falta preencher']]) {
      if (!v(id)) marcar(id, diz);
    }
  }
  if (!CHECKOUT.pagamento) marcar('chkPagOps', 'Escolha a forma de pagamento');
  // O que está preenchido e errado entra junto do que está vazio: uma lista
  // só, na ordem da tela.
  for (const f of faltasDeFormato($('conteudo'))) {
    if (!fora.some((x) => x.el === f.el)) fora.push(f);
  }
  const troco = $('chkPrecisaTroco');
  if (troco && troco.checked && !(Number(digitosDe(v('chkTrocoPara'))) > 0)) {
    marcar('chkTrocoPara', 'Para quanto precisa de troco?');
  }
  return fora;
}

async function finalizarPedido() {
  faixaDeErro('chkErro', '');
  if (marcarFaltas(faltasDoCheckout())) return;

  /* Trava de reentrada: o botão desabilitado já evita o clique repetido, e a
     chave de idempotência cobre o que passar daqui (retry, rede, F5). */
  if (CHECKOUT.enviando) return;
  CHECKOUT.enviando = true;
  const bt = $('btFinalizar');
  bt.disabled = true;
  bt.textContent = 'Enviando…';

  try {
    const d = await fetch('/loja/api/pedido/finalizar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpoDoPedido()),
    }).then((r) => r.json().catch(() => ({ success: false })));

    if (!d || !d.success) {
      // O servidor diz QUAL campo recusou; o que não é de campo vai para a faixa.
      const alvo = d && d.campo && $(CAMPO_DO_CHECKOUT[d.campo]);
      if (alvo) marcarFaltas([{ el: alvo, diz: d.error }]);
      else faixaDeErro('chkErro', (d && d.error) || 'Não conseguimos concluir seu pedido agora. Tente de novo.');
      return;
    }
    ULTIMO_PEDIDO = d;
    gravarCarrinho([]);                 // o pedido saiu: a sacola esvazia
    SACOLA = { itens: [], total: 0, quantidadeItens: 0 };
    CHECKOUT.chave = null;              // a próxima compra é outra tentativa
    /* Com cobrança no site (Pix ou boleto), a confirmação é a página de
       pagamento: ela sobrevive a recarregar, e é o mesmo link que a loja manda
       pelo WhatsApp.
       `pixNoSite` é o nome que o servidor anterior manda, e este arquivo é
       estático: ele está no ar antes do restart que publica o servidor novo. */
    const pagarNoSite = d.pagarNoSite ?? d.pixNoSite;
    location.hash = pagarNoSite && d.link
      ? '#/pagar/' + encodeURIComponent(d.link)
      : '#/pedido/' + encodeURIComponent(d.numero);
  } catch {
    faixaDeErro('chkErro', 'Não conseguimos falar com a loja. Verifique a conexão e tente de novo.');
  } finally {
    CHECKOUT.enviando = false;
    if (bt) { bt.disabled = false; bt.textContent = 'Finalizar pedido'; }
  }
}

let ULTIMO_PEDIDO = null;

function pintarSucesso(numero) {
  const d = ULTIMO_PEDIDO;
  const alvo = $('conteudo');
  const num = decodeURIComponent(numero || '');
  if (!d) {
    /* Recarregou a página de sucesso: o resumo vive na memória da aba, e
       inventar um pedido a partir do endereço seria pior que admitir. */
    alvo.innerHTML = `<div class="ok-tela">
      <h1>Pedido enviado</h1>
      <p>Seu pedido <strong>${esc(num)}</strong> foi registrado.</p>
      <button class="btn-linha" data-voltar="1">Voltar ao catálogo</button></div>`;
    pintarBarra();
    return;
  }
  const zap = d.whatsapp
    ? `https://wa.me/${d.whatsapp}?text=${encodeURIComponent(
        `Olá! Acabei de fazer o pedido nº ${num} pelo catálogo.`)}`
    : null;
  const onde = d.atendimento === 'entrega' ? 'entrega' : 'retirada';
  /* `boleto_online` saiu daqui, e não ganhou texto novo: com a cobrança
     emitida, o pedido de boleto vai para a tela de pagamento e nunca chega a
     esta. A linha que estava aqui dizia "O boleto foi gerado e o link chega
     pelo WhatsApp" num pedido em que nenhum boleto havia sido gerado. */
  const instrucao = {
    pix_manual: 'A loja vai enviar a chave PIX e conferir o comprovante.',
    dinheiro: `Separe o valor para pagar na ${onde}.`,
    credito_presencial: `A maquininha vai na ${onde}.`,
    debito_presencial: `A maquininha vai na ${onde}.`,
  }[d.pagamento && d.pagamento.codigo] || '';

  alvo.innerHTML = `
    <div class="ok-tela">
      <div class="ok-selo">✓</div>
      <h1>Pedido recebido!</h1>
      <p class="ok-num">Nº <strong>${esc(num)}</strong></p>
      <div class="chk-totais">
        <div><span>Subtotal</span><span>${brl(d.subtotal)}</span></div>
        ${d.frete ? `<div><span>Entrega</span><span>${brl(d.frete)}</span></div>` : ''}
        <div class="chk-total"><span>Total</span><span>${brl(d.total)}</span></div>
      </div>
      <p class="ok-linha"><strong>${d.atendimento === 'entrega' ? 'Entrega' : 'Retirada'}</strong>
        · ${esc((d.pagamento && d.pagamento.rotulo) || '')}</p>
      ${instrucao ? `<p class="chk-aviso">${esc(instrucao)}</p>` : ''}
      ${d.atendimento === 'retirada' && LOJA.endereco
        ? `<p class="chk-aviso">Retire em: <strong>${esc(LOJA.endereco)}</strong></p>` : ''}
      ${zap ? `<a class="bt-principal" href="${esc(zap)}" target="_blank" rel="noopener noreferrer">
                 Falar com a loja no WhatsApp</a>` : ''}
      <button class="btn-linha" data-voltar="1">Voltar ao catálogo</button>
    </div>`;
  pintarBarra();
}

async function carregarSugestoes() {
  const ids = SACOLA.itens.map((i) => i.produtoId);
  const cats = [...new Set(SACOLA.itens
    .map((i) => (PRODUTOS.find((p) => p.id === i.produtoId) || {}).categoria)
    .filter(Boolean))];
  try {
    const d = await fetch('/loja/api/sugestoes?excluir=' + ids.join(',')
      + '&categorias=' + encodeURIComponent(cats.join('|'))).then((r) => r.json());
    if (!d.success || !d.produtos.length) return;
    // O mesmo card da vitrine, e não um card só daqui: o de antes tinha outro
    // tamanho, outra fonte e o nome passando por baixo do "+".
    $('sugestoes').innerHTML = d.produtos.map(cardHtml).join('');
    $('secSugestoes').hidden = false;
  } catch { /* sugestão é extra: falhar aqui não pode estragar a sacola */ }
}

/* ===================== montador (#/montar/<id>) =============================
   O cliente monta o produto: flor, formato, quantidade da tabela, cor,
   adicionais, mensagem, data e como recebe. A prévia ganha flores e muda de
   cor, e o resumo soma. O preço exibido aqui é o da tabela que o servidor
   mandou; o que vale no pedido é recalculado lá, a partir das mesmas escolhas.
   ========================================================================= */

let MONTAVEIS = [];
let MT = null;

const plural = (m, q) => `${q} ${q === 1 ? m.unidade : m.plural}`;
const hojeIso = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

function mtFormato() { return MT.m.formatos.find((f) => f.id === MT.formatoId) || MT.m.formatos[0]; }
function mtCor() { return MT.m.cores.find((c) => c.id === MT.corId) || null; }
function mtPossivel(cor, q) { return !cor || cor.quantidades.includes(q); }
function mtPreco() {
  const l = mtFormato().precos.find((p) => p.quantidade === MT.quantidade);
  return l ? l.preco : null;
}
function mtAdicionais() {
  const fora = [];
  for (const g of MT.m.adicionais) for (const o of g.opcoes) if (MT.opcoes.has(o.id)) fora.push({ g, o });
  return fora;
}
function mtTotal() {
  const p = mtPreco();
  if (p == null) return null;
  return p + mtAdicionais().reduce((s, x) => s + (x.o.precoAdicional || 0), 0);
}

/**
 * A mensagem só faz sentido com o cartão escolhido: ela é o que vai ESCRITO
 * nele. Sem cartão, o passo não aparece, e o que já tiver sido digitado não
 * segue para o pedido — mandar para a floricultura um texto que ninguém vai
 * imprimir é pedir um cartão que não foi comprado.
 *
 * O texto fica guardado em `MT.textos` em vez de apagado: quem tira o cartão
 * por engano e volta a marcá-lo encontra o que escreveu.
 *
 * A flor que não tiver grupo de cartão nenhum segue como antes, com a
 * mensagem sempre disponível.
 */
function mtGrupoCartao() {
  return MT.m.adicionais.find((g) => g.tipo !== 'texto' && /cart[ãa]o/i.test(g.nome)) || null;
}
function mtTemCartao() {
  const g = mtGrupoCartao();
  return !g || g.opcoes.some((o) => MT.opcoes.has(o.id));
}
const mtTextos = () => (mtTemCartao() ? MT.textos : {});

/** Primeira quantidade do formato que a cor fecha, preferindo a atual. */
function mtAjustarQuantidade() {
  const f = mtFormato();
  const cor = mtCor();
  if (f.precos.some((p) => p.quantidade === MT.quantidade) && mtPossivel(cor, MT.quantidade)) return;
  const boas = f.precos.map((p) => p.quantidade).filter((q) => mtPossivel(cor, q));
  if (boas.length) {
    // A mais próxima da que estava escolhida, para a troca de cor não pular longe.
    MT.quantidade = boas.reduce((a, q) => (Math.abs(q - MT.quantidade) < Math.abs(a - MT.quantidade) ? q : a), boas[0]);
  } else {
    MT.quantidade = f.precos[0].quantidade;
  }
}

function iniciarMontagem(m, guardadas) {
  const antes = MT;
  const cores = m.cores;
  const cor = cores.find((c) => !c.mix && c.quantidades.length) || cores.find((c) => c.quantidades.length) || cores[0];
  MT = {
    m,
    formatoId: m.formatos[0].id,
    quantidade: m.formatos[0].precos[0].quantidade,
    corId: cor ? cor.id : null,
    opcoes: new Set(), textos: {},
    data: antes ? antes.data : '',
    atend: antes ? antes.atend : (SERVICO === 'delivery' ? 'entrega' : (SERVICO === 'retirada' ? 'retirada' : null)),
    faltas: new Set(), editando: null,
  };
  // Começa no primeiro formato que a cor consegue montar.
  const f = m.formatos.find((x) => x.precos.some((p) => mtPossivel(cor, p.quantidade)));
  if (f) MT.formatoId = f.id;
  if (guardadas) aplicarEscolhas(m, guardadas);
  mtAjustarQuantidade();
}

/**
 * Repõe escolhas vindas de FORA (rascunho do navegador ou item da sacola).
 *
 * Cada uma é conferida contra o montável de agora: formato, cor e opção que
 * saíram do cadastro, ou cor que perdeu o estoque, são descartadas em vez de
 * entrar como id solto. A quantidade passa pelo `mtAjustarQuantidade` depois,
 * que é quem sabe o que a cor escolhida fecha.
 */
function aplicarEscolhas(m, e) {
  if (m.formatos.some((f) => f.id === Number(e.formatoId))) MT.formatoId = Number(e.formatoId);
  if (Number(e.quantidade) > 0) MT.quantidade = Number(e.quantidade);
  const cor = m.cores.find((c) => c.id === Number(e.corId));
  if (cor && cor.quantidades.length) MT.corId = cor.id;
  const validas = new Set();
  for (const g of m.adicionais) for (const o of (g.opcoes || [])) validas.add(o.id);
  MT.opcoes = new Set((e.opcoes || []).map(Number).filter((id) => validas.has(id)));
  const textos = {};
  for (const g of m.adicionais) {
    const t = e.textos && (e.textos[g.id] ?? e.textos[String(g.id)]);
    if (t) textos[g.id] = String(t).slice(0, 300);
  }
  MT.textos = textos;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(e.data || ''))) MT.data = e.data;
  if (e.atend === 'entrega' || e.atend === 'retirada') MT.atend = e.atend;
}

/** As escolhas de agora, no formato que o rascunho e o carrinho guardam. */
function escolhasDaMontagem() {
  return {
    formatoId: MT.formatoId, quantidade: MT.quantidade, corId: MT.corId,
    opcoes: [...MT.opcoes], textos: MT.textos, data: MT.data || '', atend: MT.atend || null,
  };
}

/** O item da sacola virando escolhas do montador, para o "Editar". */
function escolhasDoItem(item) {
  const mt = item.montagem || {};
  return {
    formatoId: mt.formatoId, quantidade: mt.quantidade, corId: mt.corId,
    opcoes: item.opcoes || [], textos: item.textos || {},
    data: mt.dataDesejada || '', atend: null,
  };
}

async function abrirMontador(idTxt, indiceTxt) {
  const alvo = $('conteudo');
  alvo.innerHTML = '<div class="vazio-msg">Carregando…</div>';
  try {
    const d = await fetch('/loja/api/montagem').then((r) => r.json());
    if (!d.success) throw new Error(d.error || 'Não foi possível carregar.');
    MONTAVEIS = d.montaveis || [];
  } catch (e) {
    alvo.innerHTML = `<div class="vazio-msg">${esc(e.message)}<br><button class="btn-linha" data-voltar="1">Voltar ao catálogo</button></div>`;
    return;
  }
  if (!MONTAVEIS.length) {
    alvo.innerHTML = '<div class="vazio-msg">Nada para montar no momento.<br><button class="btn-linha" data-voltar="1">Voltar ao catálogo</button></div>';
    return;
  }
  const id = Number(idTxt);
  const indice = indiceTxt == null || indiceTxt === '' ? null : Number(indiceTxt);
  const item = indice != null ? lerCarrinho()[indice] : null;
  const m = MONTAVEIS.find((x) => x.produtoId === (item ? item.produtoId : id)) || MONTAVEIS[0];

  if (item && item.montagem) {
    // Editar um buquê da sacola: as escolhas vêm dele, não do rascunho.
    iniciarMontagem(m, escolhasDoItem(item));
    MT.editando = indice;
  } else if (!MT || MT.m.produtoId !== m.produtoId) {
    iniciarMontagem(m, lerRascunhos()[m.produtoId]);
  } else {
    MT.m = m;                 // voltou ao montador: mantém as escolhas, com o estoque de agora
  }
  pintarMontador();
}

function notaDoAtendimento() {
  const e = (LOJA && LOJA.entrega) || {};
  if (MT.atend !== 'entrega') return null;
  if (e.freteModo === 'combinar') return 'A taxa de entrega é combinada depois, e o Pix do total chega pelo WhatsApp.';
  if (e.freteModo === 'fixo' && e.freteValor != null) return `Taxa de entrega: ${brl(e.freteValor)}.`;
  if (e.freteModo === 'bairro') return 'A taxa de entrega sai pelo bairro, no fechamento do pedido.';
  if (e.freteModo === 'gratis') return 'Entrega grátis.';
  return null;
}

function pintarMontador() {
  const m = MT.m;
  const multiplosFormatos = m.formatos.length > 1;
  const temCor = m.cores.length > 1;
  const escolhas = m.adicionais.filter((g) => g.tipo !== 'texto');
  const textos = m.adicionais.filter((g) => g.tipo === 'texto');
  const servs = servicosDaLoja();
  let n = 0;
  const passo = (titulo, corpo) => `<section class="mt-passo"><div class="mt-tit">
      <span class="mt-num">${++n}</span><h2>${esc(titulo)}</h2></div>${corpo}</section>`;

  const blocos = [];
  if (MONTAVEIS.length > 1) {
    blocos.push(passo('Qual flor?', `<div class="mt-ops">${MONTAVEIS.map((x) => {
      const menor = Math.min(...x.formatos.flatMap((f) => f.precos.map((p) => p.preco)).filter((v) => v != null));
      return `<button type="button" class="mt-op ${x.produtoId === m.produtoId ? 'on' : ''}" aria-pressed="${x.produtoId === m.produtoId}" data-mt-flor="${x.produtoId}">
        <strong>${esc(x.descricao)}</strong>${Number.isFinite(menor) ? `<small>a partir de ${brl(menor)}</small>` : ''}</button>`;
    }).join('')}</div>`));
  }
  if (multiplosFormatos) {
    blocos.push(passo('Formato', `<div class="mt-ops">${m.formatos.map((f) => {
      const qs = f.precos.map((p) => p.quantidade);
      const faixa = qs.length === 1 ? plural(m, qs[0]) : `${qs[0]} a ${plural(m, qs[qs.length - 1])}`;
      const algum = qs.some((q) => mtPossivel(mtCor(), q));
      return `<button type="button" class="mt-op ${f.id === MT.formatoId ? 'on' : ''}" aria-pressed="${f.id === MT.formatoId}" data-mt-formato="${f.id}" ${algum ? '' : 'disabled'}>
        <strong>${esc(f.nome)}</strong><small>${esc(f.descricao || faixa)}</small></button>`;
    }).join('')}</div>`));
  }
  blocos.push(passo('Quantidade', `<div class="mt-qtds">${mtFormato().precos.map((p) => `
      <button type="button" class="mt-op ${p.quantidade === MT.quantidade ? 'on' : ''}" aria-pressed="${p.quantidade === MT.quantidade}" data-mt-qtd="${p.quantidade}"
        ${mtPossivel(mtCor(), p.quantidade) ? '' : 'disabled'}>
        <strong>${plural(m, p.quantidade)}</strong>${!mtPossivel(mtCor(), p.quantidade) ? '<small>Sem estoque nesta cor</small>'
          : (p.preco != null ? `<small>${brl(p.preco)}</small>` : '')}</button>`).join('')}</div>`));
  if (temCor) {
    blocos.push(passo('Cor', `<div class="mt-ops">${m.cores.map((c) => `
      <button type="button" class="mt-op ${c.id === MT.corId ? 'on' : ''}" aria-pressed="${c.id === MT.corId}" data-mt-cor="${c.id}" ${c.quantidades.length ? '' : 'disabled'}>
        <span class="amostra" style="background:${c.mix ? amostraMix(m) : esc(c.corHex || '#ccc')}"></span>
        <strong>${esc(c.nome)}</strong>${c.quantidades.length ? '' : '<small>Sem estoque agora</small>'}</button>`).join('')}</div>`));
  }
  if (escolhas.length) {
    blocos.push(passo('Adicionais', escolhas.map((g) => {
      const marcado = g.opcoes.some((o) => MT.opcoes.has(o.id));
      return `<div class="mt-grupo"><h3>${esc(g.nome)}</h3>
        <div class="mt-ops" id="mtGrupo${g.id}">${g.opcoes.map((o) => `
          <button type="button" class="mt-op ${MT.opcoes.has(o.id) ? 'on' : ''}" aria-pressed="${MT.opcoes.has(o.id)}" data-mt-op="${o.id}" data-mt-grupo="${g.id}">
            <strong>${esc(o.nome)}</strong>${o.precoAdicional > 0 ? `<small>+ ${brl(o.precoAdicional)}</small>` : ''}</button>`).join('')}</div>
        ${g.descricao ? `<p class="mt-aviso ${marcado ? 'forte' : ''}">${esc(g.descricao)}</p>` : ''}</div>`;
    }).join('')));
  }
  if (textos.length && mtTemCartao()) {
    blocos.push(passo('Mensagem', textos.map((g) => `
      <div class="mt-campo"><label for="mtT${g.id}">${esc(g.nome)}</label>
        ${g.descricao ? `<p class="mt-aviso" style="margin:0">${esc(g.descricao)}</p>` : ''}
        <textarea id="mtT${g.id}" data-mt-texto="${g.id}" rows="${textos[0] === g ? 3 : 1}"
          maxlength="300">${esc(MT.textos[g.id] || '')}</textarea></div>`).join('')));
  }
  blocos.push(passo('Quando e como?', `
    <div class="mt-campo" style="margin-top:0"><label for="mtData">Data desejada</label>
      <input type="date" id="mtData" min="${hojeIso()}" value="${esc(MT.data || '')}"></div>
    ${servs.length ? `<div class="mt-ops" id="mtAtendOps" style="margin-top:12px">${servs.map((sv) => {
      const v = sv.valor === 'delivery' ? 'entrega' : 'retirada';
      return `<button type="button" class="mt-op ${MT.atend === v ? 'on' : ''}" aria-pressed="${MT.atend === v}" data-mt-atend="${v}">
        <strong>${sv.icone} ${esc(sv.rotulo)}</strong><small>${v === 'entrega' ? 'Entregamos no endereço' : 'Você busca na loja'}</small></button>`;
    }).join('')}</div>` : ''}
    <p class="mt-aviso" id="mtNotaAtend"></p>`));

  $('conteudo').innerHTML = `
    <div class="mt">
      <div class="mt-cab"><h1>${esc(m.descricao)}</h1></div>
      <div class="mt-passos"><p class="mt-erro" id="mtErro" hidden></p>${blocos.join('')}</div>
      <aside class="mt-lado">
        <div class="mt-previa">
          <span class="mt-etq">Prévia</span>
          <div class="bq" id="bq"></div>
          <span class="mt-mais-fl" id="mtMaisFl" hidden></span>
          <div class="mt-preco"><small>Seu presente</small><strong id="mtPreco">—</strong></div>
        </div>
        <div class="mt-resumo-wrap">
          <div class="mt-resumo">
            <h2>Resumo</h2>
            <div id="mtLinhas"></div>
            <div class="mt-total"><span>Total</span><strong id="mtTotal">—</strong></div>
            <button type="button" class="mt-bt claro" id="mtSeguir">Continuar para o pagamento</button>
            <button type="button" class="mt-bt linha" id="mtSacola">Adicionar à sacola</button>
          </div>
        </div>
      </aside>
    </div>
    <div class="mt-barra"><div><span>Total</span><strong id="mtTotalBarra">—</strong></div>
      <button type="button" id="mtSeguirBarra">Continuar</button></div>`;
  document.body.classList.add('com-mt');
  montarBuque();
  atualizarMontador();
  ajustarLadoMontador();
  // O repinte não pode perder o que já estava marcado (nem pular a página).
  if (MT.faltas.size) mtMarcarFaltas({ levar: false });
}

/* Folga entre a barra do topo e o que fica preso embaixo dela, e os limites
   de altura da prévia no computador: ela encolhe para o bloco caber, mas
   abaixo de 170px o buquê deixa de ser reconhecível. */
const MT_FOLGA = 12;
const MT_PREVIA_MAX = 330;
const MT_PREVIA_MIN = 170;

/**
 * Onde a coluna da direita para ao rolar.
 *
 * São duas contas diferentes, e as duas dependem de medida real — altura da
 * barra, do bloco e da janela —, por isso vivem aqui e não no CSS.
 *
 * **No computador** a coluna é um bloco só (prévia em cima, resumo embaixo).
 * Cabendo inteiro na janela, o topo dela para logo abaixo da barra. Não
 * cabendo, o `--mt-top` fica negativo: a prévia passa por baixo da barra e o
 * FIM do bloco — o resumo, com o total e os botões — é o que fica à vista. É
 * a escolha entre os dois, e quem precisa ser alcançado é o resumo.
 *
 * **No celular** a prévia fica presa sozinha, e precisa SOLTAR quando os
 * passos terminam: presa até o fim da página, ela taparia o resumo. A troca
 * congela o deslocamento em que ela estava, medido na hora, então a prévia
 * não se move no instante em que solta.
 */
function ajustarLadoMontador() {
  const lado = document.querySelector('.mt-lado');
  const previa = document.querySelector('.mt-previa');
  const passos = document.querySelector('.mt-passos');
  if (!lado || !previa || !passos) return;

  const topo = document.querySelector('header.topo');
  const alturaTopo = topo ? topo.offsetHeight : 68;
  document.body.style.setProperty('--topo-h', alturaTopo + 'px');

  if (window.innerWidth > 900) {
    previa.classList.remove('mt-solta');
    const resumo = document.querySelector('.mt-resumo-wrap');
    const gap = parseFloat(getComputedStyle(lado).rowGap) || 14;
    const alturaResumo = resumo ? resumo.offsetHeight : 0;
    const topoDoBloco = alturaTopo + MT_FOLGA;
    // O que sobra de tela para a prévia, com o bloco encostado na barra.
    const sobra = window.innerHeight - topoDoBloco - MT_FOLGA - alturaResumo - gap;
    const h = Math.min(MT_PREVIA_MAX, Math.max(MT_PREVIA_MIN, Math.floor(sobra)));
    previa.style.setProperty('--mt-previa-h', h + 'px');
    // O buquê tem 300px de desenho: encolhendo a prévia, ele encolhe junto.
    previa.style.setProperty('--bq-escala', Math.min(1, (h - 20) / (MT_PREVIA_MAX - 20)).toFixed(3));
    const alturaBloco = h + gap + alturaResumo;
    const fim = window.innerHeight - alturaBloco - MT_FOLGA;
    lado.style.setProperty('--mt-top', Math.min(topoDoBloco, fim) + 'px');
    return;
  }

  lado.style.removeProperty('--mt-top');
  previa.style.removeProperty('--mt-previa-h');
  previa.style.removeProperty('--bq-escala');
  // O retângulo dos passos não depende da prévia, então serve de régua nos
  // dois sentidos da rolagem: a mesma conta solta e volta a prender.
  const acabou = passos.getBoundingClientRect().bottom <= alturaTopo + previa.offsetHeight;
  if (acabou === previa.classList.contains('mt-solta')) return;
  if (!acabou) { previa.classList.remove('mt-solta'); return; }
  const antes = previa.getBoundingClientRect().top;
  previa.classList.add('mt-solta');
  previa.style.setProperty('--mt-previa-parada', '0px');
  previa.style.setProperty('--mt-previa-parada',
    (antes - previa.getBoundingClientRect().top) + 'px');
}

/* O celular precisa da conta a cada rolagem — é ela que solta a prévia no fim
   dos passos. `passive` porque nada aqui cancela o gesto. */
window.addEventListener('scroll', () => {
  if (document.body.classList.contains('com-mt')) ajustarLadoMontador();
}, { passive: true });

window.addEventListener('resize', () => {
  if (document.body.classList.contains('com-mt')) ajustarLadoMontador();
});

/** Amostra do mix: as cores com estoque, em fatias. */
function amostraMix(m) {
  const cs = m.cores.filter((c) => !c.mix && c.corHex);
  if (!cs.length) return '#ccc';
  const passo = 100 / cs.length;
  return `conic-gradient(${cs.map((c, i) => `${c.corHex} ${i * passo}% ${(i + 1) * passo}%`).join(',')})`;
}

/* ---- prévia ---- */
const MAX_FLORES = 25;

/** Posições das flores: rosetas concêntricas, a de dentro primeiro. */
function posicoes(n, formato) {
  const nome = String(formato || '').toLowerCase();
  if (nome.includes('avulsa') || n === 1 && !nome.includes('cone')) return [[0, -40]];
  if (nome.includes('cone')) return [[0, -30], [-24, -6], [24, -6]].slice(0, n);
  const pts = [[0, -20]];
  const aneis = [[6, 40], [12, 76], [6, 104]];
  for (const [qtd, r] of aneis) {
    for (let i = 0; i < qtd; i++) {
      const a = (-90 + (360 / qtd) * i + (r === 76 ? 15 : 0)) * Math.PI / 180;
      pts.push([Math.round(Math.cos(a) * r * 1.05), Math.round(-20 + Math.sin(a) * r * .72)]);
    }
  }
  return pts.slice(0, n);
}

function tons(hex) {
  const h = /^#([0-9a-f]{6})$/i.exec(hex || '') ? hex : '#c6284e';
  const rgb = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mist = (alvo, f) => '#' + rgb.map((v) => Math.round(v + (alvo - v) * f).toString(16).padStart(2, '0')).join('');
  return { pe: h, cla: mist(255, .35), esc: mist(0, .28) };
}

function montarBuque() {
  const bq = $('bq');
  const hastes = [-2, 4, -7, 10, -13, 15].map((g, i) => `<div class="bq-haste" data-haste="${i}" style="transform:rotate(${g}deg)"></div>`).join('');
  bq.innerHTML = hastes
    + '<div class="bq-folha" style="left:32%;bottom:34%;transform:rotate(32deg)"></div>'
    + '<div class="bq-folha" style="right:30%;bottom:30%;transform:rotate(145deg)"></div>'
    + '<div class="bq-emb"></div>'
    + Array.from({ length: MAX_FLORES }, (_, i) => `<div class="fl fora" data-fl="${i}"></div>`).join('');
}

function pintarBuque() {
  const bq = $('bq');
  if (!bq) return;
  const f = mtFormato();
  const nomeF = String(f.nome || '').toLowerCase();
  bq.classList.toggle('cone', nomeF.includes('cone'));
  bq.classList.toggle('avulsa', nomeF.includes('avulsa') || (MT.quantidade === 1 && !nomeF.includes('cone')));
  const girassol = /girassol/i.test(MT.m.unidade + ' ' + MT.m.descricao);
  const visiveis = Math.min(MT.quantidade, MAX_FLORES);
  const pts = posicoes(visiveis, f.nome);
  const cor = mtCor();
  const paleta = cor && cor.mix
    ? MT.m.cores.filter((c) => !c.mix && c.quantidades.length && c.corHex).map((c) => c.corHex)
    : [cor && cor.corHex];
  bq.querySelectorAll('.fl').forEach((el, i) => {
    const vis = i < visiveis;
    el.classList.toggle('fora', !vis);
    el.classList.toggle('girassol', girassol);
    if (!vis) return;
    const [x, y] = pts[i] || [0, 0];
    el.style.left = `calc(50% + ${x}px)`;
    el.style.top = `calc(38% + ${y}px)`;
    const t = tons(paleta[i % (paleta.length || 1)]);
    el.style.setProperty('--pe', t.pe);
    el.style.setProperty('--pe-cla', t.cla);
    el.style.setProperty('--pe-esc', t.esc);
  });
  // Uma haste por flor, até seis: a rosa avulsa não sai de um leque de caules.
  bq.querySelectorAll('.bq-haste').forEach((h, i) => { h.hidden = i >= Math.min(visiveis, 6); });
  const mais = $('mtMaisFl');
  mais.hidden = MT.quantidade <= MAX_FLORES;
  mais.textContent = `${MT.quantidade} ${MT.m.plural}`;
}

/* ---- resumo e tabela ---- */
function atualizarMontador() {
  const m = MT.m;
  const f = mtFormato();
  const cor = mtCor();
  const total = mtTotal();
  pintarBuque();
  $('mtPreco').textContent = total == null ? 'a combinar' : brl(total);
  $('mtTotal').textContent = total == null ? 'a combinar' : brl(total);
  $('mtTotalBarra').textContent = total == null ? 'a combinar' : brl(total);

  const linhas = [];
  const linha = (a, b) => linhas.push(`<div class="mt-linha"><span>${esc(a)}</span><b>${esc(b)}</b></div>`);
  if (MONTAVEIS.length > 1) linha('Flor', m.descricao);
  if (m.formatos.length > 1) linha('Formato', f.nome);
  linha('Quantidade', plural(m, MT.quantidade) + (mtPreco() != null ? ` · ${brl(mtPreco())}` : ''));
  if (m.cores.length > 1 && cor) linha('Cor', cor.nome);
  const notas = [];
  for (const { g, o } of mtAdicionais()) {
    linha(g.nome, o.nome + (o.precoAdicional > 0 ? ` · ${brl(o.precoAdicional)}` : ''));
    if (g.descricao && !notas.includes(g.descricao)) notas.push(g.descricao);
  }
  for (const g of m.adicionais.filter((x) => x.tipo === 'texto')) {
    const t = (mtTextos()[g.id] || '').trim();
    if (t) linha(g.nome, t.length > 40 ? t.slice(0, 40) + '…' : t);
  }
  linha('Data', MT.data ? MT.data.split('-').reverse().join('/') : 'A combinar');
  if (MT.atend) linha('Receber', MT.atend === 'entrega' ? 'Entrega' : 'Retirada');
  const nAtend = notaDoAtendimento();
  $('mtLinhas').innerHTML = linhas.join('')
    + notas.map((x) => `<p class="mt-nota">${esc(x)}</p>`).join('')
    + (nAtend ? `<p class="mt-nota">${esc(nAtend)}</p>` : '');
  const nota = $('mtNotaAtend');
  if (nota) { nota.textContent = nAtend || ''; nota.hidden = !nAtend; }
  // Marcar um adicional cresce o resumo, e com ele o bloco: onde a coluna
  // para muda junto.
  ajustarLadoMontador();
  // Editando um item da sacola, as escolhas são DAQUELE buquê: gravá-las como
  // rascunho apagaria o que a pessoa tinha começado a montar do zero.
  if (MT.editando == null) gravarRascunho(m.produtoId, escolhasDaMontagem());
}

function itemDaMontagem() {
  return {
    produtoId: MT.m.produtoId, quantidade: 1,
    opcoes: [...MT.opcoes], textos: mtTextos(), comentario: null,
    montagem: { formatoId: MT.formatoId, quantidade: MT.quantidade, corId: MT.corId, dataDesejada: MT.data || null },
  };
}

/**
 * O que falta preencher, na ordem em que aparece na tela.
 *
 * Com um modelo de cartão escolhido, a mensagem e para quem é passam a ser
 * obrigatórias: o cartão é impresso com o que está escrito nelas, e um cartão
 * em branco chega à floricultura sem ninguém para perguntar o que ia nele.
 * Sem cartão, os mesmos campos não existem na tela e não são cobrados.
 *
 * Como o cadastro do lojista marca esses grupos como opcionais, quem exige é
 * ESTA tela — o servidor continua aceitando o pedido sem eles, e isso é de
 * propósito: a regra "cartão pede mensagem" é de atendimento, não de
 * integridade do pedido.
 */
function mtFaltando(seguir) {
  const fora = [];
  if (mtTemCartao()) {
    for (const g of MT.m.adicionais) {
      if (g.tipo !== 'texto') continue;
      if (!String(MT.textos[g.id] || '').trim()) fora.push('texto-' + g.id);
    }
  }
  if (seguir && servicosDaLoja().length && !MT.atend) fora.push('atend');
  return fora;
}

/**
 * As faltas do montador viram marcas na tela.
 *
 * Elas moram em `MT.faltas`, e não no DOM, porque cada escolha repinta os
 * passos inteiros: guardadas só nas classes, sumiriam ao trocar a cor.
 * `levar: false` é o repinte repondo o que já estava marcado.
 */
function mtMarcarFaltas({ levar = true } = {}) {
  const lista = [...MT.faltas].map((chave) => (chave === 'atend'
    ? { el: $('mtAtendOps'), diz: 'Escolha retirada ou entrega' }
    : { el: $('mtT' + chave.slice(6)), diz: 'Falta preencher' }));
  return marcarFaltas(lista, { levar });
}

let MT_ENVIANDO = false;
async function concluirMontagem(seguir) {
  const faltas = mtFaltando(seguir);
  MT.faltas = new Set(faltas);
  if (faltas.length) {
    pintarMontadorMantendo();      // repinta e repõe as marcas
    mtMarcarFaltas();              // agora leva até a primeira
    return;
  }
  faixaDeErro('mtErro', '');
  const erro = $('mtErro');
  // Dois toques rápidos punham dois buquês na sacola: a montagem nunca se funde.
  if (MT_ENVIANDO) return;
  MT_ENVIANDO = true;
  const bts = ['mtSeguir', 'mtSeguirBarra', 'mtSacola'].map($).filter(Boolean);
  bts.forEach((b) => { b.disabled = true; });
  try { await concluirMontagemAgora(seguir, erro); }
  finally { MT_ENVIANDO = false; bts.forEach((b) => { b.disabled = false; }); }
}

async function concluirMontagemAgora(seguir, erro) {
  const item = itemDaMontagem();
  // O servidor confere antes de entrar na sacola: estoque, tabela e adicionais.
  const r = await fetch('/loja/api/carrinho/calcular', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itens: [item] }),
  }).then((x) => x.json()).catch(() => null);
  if (!r || !r.success) {
    // Recusa de um grupo (obrigatório, mínimo, máximo) marca o grupo; o resto
    // é faixa no alto.
    const campo = r && r.grupoId && $('mtGrupo' + r.grupoId);
    if (campo) marcarFaltas([{ el: campo, diz: r.error }]);
    else faixaDeErro('mtErro', (r && r.error) || 'Não foi possível adicionar agora.');
    return;
  }
  // Editando um buquê da sacola, ele é TROCADO: somar outro igual seria o
  // contrário do que quem clicou em "Editar" pediu.
  if (MT.editando != null) await substituirNaSacola(MT.editando, item);
  else await adicionar(item);
  esquecerRascunho(MT.m.produtoId);
  if (MT.atend) { SERVICO = MT.atend === 'entrega' ? 'delivery' : 'retirada'; CHECKOUT.atendimento = MT.atend; }
  MT = null;                               // a próxima montagem começa do zero
  irPara(seguir ? '#/checkout' : '#/sacola');
}

function tratarCliqueMontador(e) {
  if (!MT || !location.hash.startsWith('#/montar')) return false;
  const flor = e.target.closest('[data-mt-flor]');
  if (flor) {
    const m = MONTAVEIS.find((x) => x.produtoId === Number(flor.dataset.mtFlor));
    if (m && m.produtoId !== MT.m.produtoId) {
      // Trocar de flor no meio de uma edição deixa de ser edição: o buquê da
      // sacola continua como está até alguém salvar outro por cima.
      iniciarMontagem(m, MT.editando == null ? lerRascunhos()[m.produtoId] : null);
      history.replaceState(null, '', '#/montar/' + m.produtoId);
      pintarMontador();
    }
    return true;
  }
  const fmt = e.target.closest('[data-mt-formato]');
  if (fmt) { MT.formatoId = Number(fmt.dataset.mtFormato); mtAjustarQuantidade(); pintarMontadorMantendo(); return true; }
  const q = e.target.closest('[data-mt-qtd]');
  if (q) { MT.quantidade = Number(q.dataset.mtQtd); pintarMontadorMantendo(); return true; }
  const cor = e.target.closest('[data-mt-cor]');
  if (cor) {
    MT.corId = Number(cor.dataset.mtCor);
    const c = mtCor();
    // A cor pode não fechar nenhuma quantidade deste formato: aí procura outro formato.
    if (!mtFormato().precos.some((p) => mtPossivel(c, p.quantidade))) {
      const outro = MT.m.formatos.find((f) => f.precos.some((p) => mtPossivel(c, p.quantidade)));
      if (outro) MT.formatoId = outro.id;
    }
    mtAjustarQuantidade();
    pintarMontadorMantendo();
    return true;
  }
  const op = e.target.closest('[data-mt-op]');
  if (op) {
    const g = MT.m.adicionais.find((x) => x.id === Number(op.dataset.mtGrupo));
    const id = Number(op.dataset.mtOp);
    if (MT.opcoes.has(id)) {
      if (!(g.obrigatorio && g.opcoes.filter((o) => MT.opcoes.has(o.id)).length <= g.minEscolhas)) MT.opcoes.delete(id);
    } else {
      if (g.maxEscolhas <= 1) for (const o of g.opcoes) MT.opcoes.delete(o.id);
      else if (g.opcoes.filter((o) => MT.opcoes.has(o.id)).length >= g.maxEscolhas) return true;
      MT.opcoes.add(id);
    }
    pintarMontadorMantendo();
    return true;
  }
  const at = e.target.closest('[data-mt-atend]');
  if (at) { MT.atend = at.dataset.mtAtend; MT.faltas.delete('atend'); pintarMontadorMantendo(); return true; }
  if (e.target.closest('#mtSeguir') || e.target.closest('#mtSeguirBarra')) { concluirMontagem(true); return true; }
  if (e.target.closest('#mtSacola')) { concluirMontagem(false); return true; }
  return false;
}

/* Repinta os passos sem perder a rolagem nem o que foi digitado: os campos de
   texto são lidos para o estado a cada tecla, e a prévia só troca classes. */
function pintarMontadorMantendo() {
  const y = window.scrollY;
  const bq = $('bq') && $('bq').innerHTML;
  const a = document.activeElement;
  const chave = a && a.attributes ? [...a.attributes].find((x) => x.name.startsWith('data-mt-')) : null;
  pintarMontador();
  if (bq) { $('bq').innerHTML = bq; }
  atualizarMontador();
  window.scrollTo(0, y);
  // Quem navega pelo teclado continua no botão que acabou de tocar.
  if (chave) {
    const volta = document.querySelector(`[${chave.name}="${CSS.escape(chave.value)}"]`);
    if (volta) volta.focus({ preventScroll: true });
  }
}

document.addEventListener('input', (e) => {
  guardarCampoCheckout(e.target);
  if (!MT) return;
  const t = e.target.closest('[data-mt-texto]');
  if (t) {
    const g = Number(t.dataset.mtTexto);
    MT.textos[g] = t.value;
    // A classe já saiu no listener da peça; aqui sai o estado, para o repinte
    // não trazer a marca de volta.
    MT.faltas.delete('texto-' + g);
    atualizarMontador();
    return;
  }
  if (e.target.id === 'mtData') { MT.data = e.target.value; atualizarMontador(); }
});

/* ===================== pagamento (#/pagar/<token>) ========================= */

let ESPERA_PIX = null;

/**
 * A cobrança deste pedido, num formato só.
 *
 * O servidor novo manda `cobranca: { tipo, … }`. O anterior mandava só `pix`,
 * e este arquivo é estático: ele entra no ar ao ser salvo, e o servidor novo só
 * no restart. Entre os dois momentos é o `pix` que chega, e quem está com o QR
 * aberto não pode ver a tela esvaziar.
 */
const cobrancaDoEstado = (p) => p.cobranca
  || (p.pix ? { tipo: 'pix', ...p.pix } : null);

async function pintarPagamento(token) {
  clearTimeout(ESPERA_PIX);
  const alvo = $('conteudo');
  const d = await fetch('/loja/api/pagamento/' + encodeURIComponent(token)).then((r) => r.json()).catch(() => null);
  if (location.hash !== '#/pagar/' + token) return;      // saiu da página enquanto carregava
  if (!d || !d.success) {
    alvo.innerHTML = `<div class="vazio-msg">${esc((d && d.error) || 'Não conseguimos falar com a loja.')}
      <br><button class="btn-linha" data-voltar="1">Voltar ao catálogo</button></div>`;
    return;
  }
  const p = d.pagamento;
  const cob = cobrancaDoEstado(p);
  const venc = (iso) => String(iso).split('-').reverse().join('/');
  const zap = linkZap(`Olá! Sobre o meu pedido nº ${p.numero}.`);
  const botaoZap = zap ? `<a class="bt-principal" href="${esc(zap)}" target="_blank" rel="noopener noreferrer">Falar com a loja no WhatsApp</a>` : '';
  const totais = `<div class="chk-totais">
      ${p.frete ? `<div><span>Entrega</span><span>${brl(p.frete)}</span></div>` : ''}
      <div class="chk-total"><span>Total</span><span>${brl(p.total)}</span></div></div>`;
  let corpo;
  if (p.cancelado) {
    corpo = `<h1>Pedido nº ${esc(p.numero)}</h1><p>Este pedido foi cancelado.</p>${botaoZap}`;
  } else if (p.pago) {
    corpo = `<div class="ok-selo" style="margin:0 auto">✓</div><h1>Pagamento recebido</h1>
      <p class="ok-num">Pedido nº <strong>${esc(p.numero)}</strong></p>${totais}
      <p class="chk-aviso">Obrigado! Seu pedido já está com a loja.</p>${botaoZap}`;
  } else if (p.aCombinar) {
    corpo = `<div class="ok-selo" style="margin:0 auto">✓</div><h1>Pedido recebido!</h1>
      <p class="ok-num">Nº <strong>${esc(p.numero)}</strong></p>
      <p class="chk-aviso">A loja vai calcular a taxa de entrega e mandar o Pix do total pelo WhatsApp.</p>${botaoZap}`;
  } else if (cob && cob.tipo === 'pix' && (cob.copiaECola || cob.qr)) {
    corpo = `<h1>Pedido nº ${esc(p.numero)}</h1>
      <p class="chk-aviso">Pague pelo Pix para confirmar.</p>
      <p class="pg-valor">${brl(cob.valor)}</p>
      ${cob.qr ? `<div class="pg-qr"><img src="data:image/png;base64,${esc(cob.qr)}" alt="QR code do Pix"></div>` : ''}
      ${cob.copiaECola ? `<textarea class="pg-cc" id="pgCC" readonly rows="3">${esc(cob.copiaECola)}</textarea>
        <button type="button" class="bt-principal" id="pgCopiar">Copiar código Pix</button>` : ''}
      <span class="pg-espera">Aguardando o pagamento</span>
      ${cob.vencimento ? `<p class="chk-aviso">Vale até ${esc(venc(cob.vencimento))}.</p>` : ''}
      ${botaoZap.replace('bt-principal', 'btn-linha')}`;
  } else if (cob && cob.tipo === 'boleto' && (cob.linhaDigitavel || cob.url)) {
    /* O boleto se paga pelo banco, então não há o que esperar na tela: o que o
       cliente precisa é a linha para colar no aplicativo, ou o documento para
       abrir. O documento é o do provedor — ele já serve o PDF com o código de
       barras e o logo do banco, e um PDF nosso seria uma segunda verdade sobre
       o mesmo título. */
    corpo = `<h1>Pedido nº ${esc(p.numero)}</h1>
      <p class="chk-aviso">Boleto gerado. Pague no aplicativo do seu banco.</p>
      <p class="pg-valor">${brl(cob.valor)}</p>
      ${cob.vencimento ? `<p class="pg-venc">Vence em ${esc(venc(cob.vencimento))}</p>` : ''}
      ${cob.linhaDigitavel ? `<textarea class="pg-cc" id="pgCC" readonly rows="2">${esc(cob.linhaDigitavel)}</textarea>
        <button type="button" class="bt-principal" id="pgCopiar">Copiar linha digitável</button>` : ''}
      ${cob.url ? `<a class="${cob.linhaDigitavel ? 'btn-linha' : 'bt-principal'}" href="${esc(cob.url)}"
        target="_blank" rel="noopener noreferrer">Abrir boleto</a>` : ''}
      <span class="pg-espera">Aguardando o pagamento</span>
      ${botaoZap.replace('bt-principal', 'btn-linha')}`;
  } else {
    corpo = `<div class="ok-selo" style="margin:0 auto">✓</div><h1>Pedido recebido!</h1>
      <p class="ok-num">Nº <strong>${esc(p.numero)}</strong></p>${totais}
      <p class="chk-aviso">A loja vai entrar em contato para combinar o pagamento.</p>${botaoZap}`;
  }
  alvo.innerHTML = `<div class="pg">${corpo}<button class="btn-linha" data-voltar="1">Voltar ao catálogo</button></div>`;
  /* Enquanto espera, confere a cada 5 s. O aviso do provedor baixa o pedido no
     servidor, e só então esta tela muda.
     Vale para o boleto também: a liquidação bancária é D+1, mas quem deixa a
     aba aberta e paga na hora pelo aplicativo vê a confirmação aqui.
     Só redesenha quando muda: repintar a cada volta apagaria o "copiado". */
  if (!p.pago && !p.cancelado && cob) {
    const conferir = async () => {
      if (location.hash !== '#/pagar/' + token) return;
      const n = await fetch('/loja/api/pagamento/' + encodeURIComponent(token)).then((r) => r.json()).catch(() => null);
      if (n && n.success && (n.pagamento.pago || n.pagamento.cancelado)) return pintarPagamento(token);
      ESPERA_PIX = setTimeout(conferir, 5000);
    };
    ESPERA_PIX = setTimeout(conferir, 5000);
  }
}

document.addEventListener('click', async (e) => {
  if (e.target.closest('#pgCopiar')) {
    const cc = $('pgCC');
    try { await navigator.clipboard.writeText(cc.value); }
    catch { cc.select(); document.execCommand('copy'); }
    e.target.closest('#pgCopiar').textContent = 'Código copiado';
  }
});

/* ===================== barra fixa ========================================== */

function pintarBarra() {
  /* A barra de atendimento acompanha as mesmas mudanças de rota e de
     quantidade que esta aqui: as duas são fixas no rodapé, e deixar uma
     delas para trás faria a sacola esvaziada continuar com o Continuar no
     ar, ou a barra sobrar por cima do checkout. */
  pintarBarraAtendimento();
  const b = $('barra');
  if (!SACOLA.quantidadeItens) { b.hidden = true; document.body.classList.remove('com-barra'); return; }
  const n = SACOLA.quantidadeItens;
  $('barraQtd').textContent = n + (n === 1 ? ' produto' : ' produtos');
  $('barraTotal').textContent = SACOLA.semPreco ? 'a combinar' : brl(SACOLA.total);
  /* A barra é um atalho PARA a sacola, e some nas telas em que o pedido já
     está sendo fechado: ali ela não tem para onde levar, e no checkout ainda
     cobre um campo — em 390px ela ocupa os últimos 73px da janela, por cima do
     rótulo e do campo Rua. */
  b.hidden = location.hash === '#/sacola'
    || location.hash === '#/checkout'
    || location.hash.startsWith('#/pedido/')
    || location.hash.startsWith('#/montar')
    || location.hash.startsWith('#/pagar/');
  document.body.classList.toggle('com-barra', !b.hidden);
}

/* ===================== roteamento ========================================== */

function irPara(hash) {
  if (location.hash === hash) rotear();
  else location.hash = hash;
}

let DESTAQUE_ATIVO = false;

/** Destaque do topo da vitrine: selo, título, texto, dois botões e a capa. */
function pintarDestaque(dq) {
  const mostrar = (id, texto) => { const el = $(id); el.hidden = !texto; if (texto) el.textContent = texto; };
  $('dqSelo').hidden = !dq.selo;
  if (dq.selo) $('dqSelo').querySelector('span').textContent = dq.selo;
  $('dqTitulo').textContent = dq.titulo;
  mostrar('dqTexto', dq.texto);
  mostrar('dqBt1', dq.botao);
  // Com produto para montar, o botão leva ao montador. Sem, rola até os
  // produtos sem trocar o hash, que é a rota da vitrine.
  $('dqBt1').onclick = (e) => {
    e.preventDefault();
    const m = PRODUTOS.find((p) => p.montavel);
    if (m) return irPara('#/montar/' + m.id);
    $('cabecalhoBusca').scrollIntoView({ behavior: 'smooth' });
  };
  // O segundo botão só existe com WhatsApp configurado: sem número, não leva a lugar nenhum.
  const zap = linkZap('Olá! Vim pelo site.');
  mostrar('dqBt2', zap ? dq.botaoWhatsapp : null);
  if (zap) $('dqBt2').href = zap;
  $('destaque').classList.toggle('sem-imagem', !LOJA.banner);
  if (LOJA.banner) {
    $('dqImg').src = LOJA.banner;
    aplicarFoco($('dqImg'), LOJA.bannerFoco);
    $('dqImagem').hidden = false;
    mostrar('dqEtiqueta', dq.etiqueta);
  }
}

async function rotear() {
  const h = location.hash || '#/';
  const topo = $('cabecalhoBusca');
  window.scrollTo(0, 0);
  // O destaque é da página inicial; nas outras telas ele sai do caminho.
  $('destaque').hidden = !(DESTAQUE_ATIVO && !/^#\/(p\/|sacola|checkout|pedido\/|montar|pagar\/)/.test(h));
  if (!h.startsWith('#/montar')) document.body.classList.remove('com-mt');

  // A busca e as categorias só fazem sentido na home; nas outras telas somem.
  // Quem volta ao início é a marca do cabeçalho, que é link.
  if (h.startsWith('#/p/')) {
    topo.hidden = true;
    await abrirProduto(h.slice(4));
  } else if (h === '#/sacola') {
    topo.hidden = true;
    await pintarSacola();
  } else if (h === '#/checkout') {
    topo.hidden = true;
    await pintarCheckout();
  } else if (h.startsWith('#/pedido/')) {
    topo.hidden = true;
    pintarSucesso(h.slice(9));
  } else if (h.startsWith('#/montar')) {
    topo.hidden = true;
    // `#/montar/<produto>` monta um novo; `#/montar/<produto>/<n>` edita o
    // item n da sacola.
    const [idTxt, indice] = h.slice(9).split('/');
    await abrirMontador(idTxt, indice);
  } else if (h.startsWith('#/pagar/')) {
    topo.hidden = true;
    await pintarPagamento(decodeURIComponent(h.slice(8)));
  } else {
    topo.hidden = false;
    pintarHome();
  }
  pintarBarra();
}

/* ===================== identidade e redes ================================== */

/**
 * Aplica o enquadramento escolhido no painel.
 *
 * O arquivo servido é o ORIGINAL — o ajuste é só de apresentação, e por isso a
 * mesma imagem pode ser reenquadrada quantas vezes for sem perder qualidade.
 * `object-position` diz que parte fica no centro; `scale` aproxima.
 *
 * Sem foco salvo, o padrão é o centro — o mesmo que o navegador já faria.
 */
function aplicarFoco(el, foco) {
  if (!el) return;
  const f = foco || { x: 50, y: 50, zoom: 1 };
  el.style.objectPosition = `${f.x}% ${f.y}%`;
  el.style.transform = f.zoom > 1 ? `scale(${f.zoom})` : '';
}

/* Ícones em SVG inline: sem requisição extra, herdam `currentColor` e escalam
   sem borrar. Traçados próprios — nenhum asset de terceiro entrou aqui. */
const ICONES = {
  whatsapp: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.04 2c-5.46 0-9.9 4.44-9.9 9.9 0 1.75.46 3.45 1.32 4.95L2 22l5.3-1.38a9.9 9.9 0 0 0 4.74 1.2h.01c5.46 0 9.9-4.44 9.9-9.9 0-2.64-1.03-5.13-2.9-7A9.82 9.82 0 0 0 12.04 2Zm0 18.05h-.01a8.2 8.2 0 0 1-4.19-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.22 8.22 0 0 1-1.26-4.39c0-4.54 3.7-8.23 8.25-8.23a8.2 8.2 0 0 1 5.82 2.42 8.17 8.17 0 0 1 2.41 5.82c0 4.54-3.7 8.24-8.24 8.24Zm4.52-6.16c-.25-.13-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.16.24-.64.8-.78.97-.15.16-.29.18-.53.06-.25-.13-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.01-.38.11-.5.11-.11.25-.29.37-.43.13-.15.17-.25.25-.41.08-.17.04-.31-.02-.44-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43h-.48c-.16 0-.43.06-.65.31-.22.25-.86.84-.86 2.05s.88 2.38 1 2.54c.12.17 1.73 2.64 4.19 3.7.59.26 1.04.4 1.4.52.59.19 1.12.16 1.54.1.47-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.15-1.18-.06-.1-.22-.16-.47-.29Z"/></svg>',
  instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none"/></svg>',
  facebook: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5.02 3.66 9.18 8.44 9.94v-7.03H7.9v-2.91h2.54V9.85c0-2.52 1.5-3.91 3.77-3.91 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.78-1.63 1.57v1.89h2.78l-.45 2.91h-2.33V22c4.78-.76 8.44-4.92 8.44-9.94Z"/></svg>',
};

/**
 * Monta os links das redes CONFIGURADAS. Rede sem valor não vira ícone —
 * um link morto no cabeçalho é pior que a ausência dele.
 *
 * Os identificadores já chegam saneados do servidor (`usuarioRede`), e a URL é
 * montada aqui com domínio fixo: nada que o lojista digite escolhe o destino.
 */
function linksSociais() {
  const fora = [];
  const zap = linkZap('Olá! Vi o catálogo de vocês.');
  if (zap) fora.push({ chave: 'whatsapp', href: zap, titulo: 'WhatsApp', externo: true });
  if (LOJA.instagram) {
    fora.push({ chave: 'instagram', href: 'https://instagram.com/' + encodeURIComponent(LOJA.instagram),
                titulo: 'Instagram', externo: true });
  }
  if (LOJA.facebook) {
    fora.push({ chave: 'facebook', href: 'https://facebook.com/' + encodeURIComponent(LOJA.facebook),
                titulo: 'Facebook', externo: true });
  }
  return fora;
}

const redesHtml = (lista) => lista.map((r) =>
  `<a class="rede" href="${esc(r.href)}" title="${esc(r.titulo)}" aria-label="${esc(r.titulo)}"`
  + `${r.externo ? ' target="_blank" rel="noopener noreferrer"' : ''}>${ICONES[r.chave]}</a>`).join('');

/**
 * Quantos ícones de rede cabem no cabeçalho, nesta largura.
 *
 * O ⓘ fica sempre: é ele que abre o painel com TODOS os contatos, e é o que
 * faz a ausência de um ícone não esconder informação nenhuma. As redes entram
 * depois, uma a uma, na ordem em que `linksSociais()` as devolve — WhatsApp
 * primeiro, que é por onde se compra.
 *
 * O limite não é uma largura escolhida a dedo, é o cabeçalho respondendo: um
 * ícone só entra enquanto o nome da loja não ficar cortado nem o cabeçalho
 * ganhar altura. Medir é o que faz a conta valer para qualquer nome, em
 * qualquer tela — uma media query fixa erraria nos dois sentidos, escondendo
 * ícone que cabia num nome curto e espremendo uma razão social inteira.
 */
function ajustarIconesTopo() {
  const nav = $('redes');
  const nome = $('nomeLoja');
  const linha = document.querySelector('header.topo .wrap');
  if (!nav || !nome || !linha) return;
  const icones = [...nav.children];
  for (const a of icones) a.hidden = true;
  const alturaBase = linha.offsetHeight;
  // `scrollHeight > clientHeight` é o corte do `-webkit-line-clamp` acontecendo.
  const cabe = () => linha.offsetHeight <= alturaBase && nome.scrollHeight <= nome.clientHeight + 1;
  for (const a of icones) {
    a.hidden = false;
    if (!cabe()) { a.hidden = true; break; }
  }
}

/* Girar o celular e arrastar a janela mudam a conta. O respiro evita refazê-la
   a cada pixel de um arrasto de borda. */
let AJUSTE_TOPO = null;
window.addEventListener('resize', () => {
  clearTimeout(AJUSTE_TOPO);
  AJUSTE_TOPO = setTimeout(ajustarIconesTopo, 120);
});

/* ===================== barra "como você quer receber" =====================
   A escolha do serviço e o Continuar, fixos no rodapé da sacola.

   `data-servico` continua valendo 'retirada' e 'delivery' — é o que o resto
   do arquivo lê, e o checkout converte 'delivery' em 'entrega' antes de
   falar com o servidor. O que mudou foi só o RÓTULO: para quem compra, a
   palavra é "Entrega".
   ========================================================================= */

/** O que a loja oferece. Serviço desligado pelo lojista não vira botão. */
function servicosDaLoja() {
  const e = (LOJA && LOJA.entrega) || {};
  const fora = [];
  if (e.retirada) fora.push({ valor: 'retirada', rotulo: 'Retirada', icone: '🏪' });
  if (e.delivery) fora.push({ valor: 'delivery', rotulo: 'Entrega', icone: '🛵' });
  return fora;
}

/**
 * A linha secundária do estado compacto.
 *
 * Reaproveita a MESMA configuração que alimentava o aviso de antes
 * (`LOJA.entrega.freteModo` / `freteValor`) — nada é recalculado aqui, e o
 * valor final do frete continua sendo decisão do servidor, no checkout.
 * Retirada não ganha linha nenhuma: não há taxa, e inventar texto para
 * preencher o espaço seria enfeite.
 */
function detalheDoServico(valor) {
  if (valor !== 'delivery') return '';
  const e = (LOJA && LOJA.entrega) || {};
  if (e.freteModo === 'combinar') return 'Taxa de entrega a combinar';
  if (e.freteModo === 'gratis') return 'Entrega grátis';
  if (e.freteModo === 'fixo' && e.freteValor != null) return `Taxa de entrega: ${brl(e.freteValor)}`;
  /* Curta porque a linha de cima já diz "Entrega selecionada": repetir
     "de entrega" aqui empurrava o texto para três linhas num celular de
     320px e levava a barra a 158px de altura. */
  return 'Taxa calculada na próxima etapa';
}

/** O serviço escolhido, ou null. Mora aqui e não no DOM — a barra é repintada. */
let SERVICO = null;

/**
 * Desenha a escolha de receber conforme o estado. Só aparece na sacola com
 * itens — e as sugestões vão junto, porque o lugar delas é logo abaixo dela.
 */
function pintarBarraAtendimento() {
  const b = $('barraAtend');
  if (!b) return;
  const naSacola = location.hash === '#/sacola' && SACOLA.itens.length > 0;
  b.hidden = !naSacola;
  if (!naSacola) {
    const s = $('secSugestoes');
    if (s) s.hidden = true;
    return;
  }

  const ops = servicosDaLoja();
  const dentro = $('barraAtendDentro');

  if (!ops.length) {
    dentro.innerHTML = '<p class="ajuda" style="margin:0">Fale com a loja para combinar a entrega.</p>';
    return;
  }

  /* Escolha única já habilitada pelo lojista continua sendo uma escolha
     explícita: o cliente vê o que vai acontecer e confirma. Marcar sozinho
     economizaria um toque e tiraria dele a informação. */
  if (SERVICO && !ops.some((o) => o.valor === SERVICO)) SERVICO = null;

  if (!SERVICO) {
    dentro.innerHTML = `
      <p class="atend-titulo">Como você quer receber?</p>
      <div class="atend-ops" id="atendOps">${ops.map((o) => `
        <button type="button" class="atend-op" data-servico="${o.valor}">
          <span class="ic" aria-hidden="true">${o.icone}</span>${o.rotulo}
        </button>`).join('')}</div>`;
    return;
  }

  const esc_ = ops.find((o) => o.valor === SERVICO);
  const detalhe = detalheDoServico(SERVICO);
  dentro.innerHTML = `
    <div class="atend-feito">
      <div class="atend-resumo">
        <span class="ic" aria-hidden="true">${esc_.icone}</span>
        <span class="atend-txt">
          <strong>${esc_.rotulo} selecionada</strong>
          ${detalhe ? `<span>${esc(detalhe)}</span>` : ''}
        </span>
      </div>
      <button type="button" class="atend-alterar" data-alterar-servico="1">Alterar</button>
      <button type="button" class="atend-seguir" id="btIrCheckout">Continuar →</button>
    </div>`;
}

/** "5594991769924" → "(94) 99176-9924", para quem lê o número na tela. */
function numeroZap(n) {
  const d = String(n || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return '';
}

/** Rodapé: só o que existe. Bloco sem dado não é desenhado. */
function pintarRodape(redes) {
  if (LOJA.logo) { const el = $('rodLogo'); el.src = LOJA.logo; el.alt = ''; el.hidden = false;
    aplicarFoco(el, LOJA.logoFoco); }
  $('rodNome').textContent = LOJA.nome || '';
  const desc = $('rodDesc');
  desc.textContent = LOJA.descricao || '';
  desc.hidden = !LOJA.descricao;

  const contato = [];
  if (LOJA.whatsapp) {
    const zap = linkZap('Olá! Vi o catálogo de vocês.');
    contato.push(`<li><a href="${esc(zap)}" target="_blank" rel="noopener noreferrer">WhatsApp ${esc(numeroZap(LOJA.whatsapp))}</a></li>`);
  }
  if (LOJA.email) contato.push(`<li><a href="mailto:${esc(LOJA.email)}">${esc(LOJA.email)}</a></li>`);
  if (LOJA.telefone && !LOJA.whatsapp) contato.push(`<li>${esc(LOJA.telefone)}</li>`);
  // O endereço só chega aqui se o lojista marcou que pode aparecer.
  if (LOJA.endereco) contato.push(`<li>${esc(LOJA.endereco)}</li>`);
  $('rodContato').innerHTML = contato.join('');
  $('rodContatoCol').hidden = !contato.length;

  $('rodRedes').innerHTML = redesHtml(redes);
  $('rodRedesCol').hidden = !redes.length;

  const ano = new Date().getFullYear();
  $('rodCopy').textContent = LOJA.rodape || `© ${ano} ${LOJA.nome || ''}`.trim();
}

/* ===================== painel Informações ================================== */

const DIAS_NOME = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

/** Dia da semana em Brasília — mesmo critério do servidor. */
function diaHojeBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).getUTCDay();
}

/**
 * Monta o painel com o que o tenant REALMENTE tem.
 *
 * Toda seção é condicional: bloco sem dado não é desenhado. Um painel com
 * "Endereço: —" e "Horário: —" faz a loja parecer abandonada, e o consumidor
 * não tem como saber se é falta de configuração ou defeito.
 *
 * O endereço só chega aqui quando `mostrarEndereco` está ligado — o servidor já
 * o omite do payload em caso contrário, então não há o que vazar nesta tela.
 */
function montarInformacoes() {
  const L = LOJA || {};
  const ent = L.entrega || {};
  const secoes = [];

  // STATUS
  if (L.atendimento && L.atendimento.rotulo) {
    secoes.push(`<section class="info-sec">
      <span class="status ${L.atendimento.aberto ? 'aberto' : ''}">${esc(L.atendimento.rotulo)}</span>
    </section>`);
  }

  // MARCA + REDES
  const redes = linksSociais();
  secoes.push(`<section class="info-sec">
    <div class="info-marca">
      ${L.logo ? `<img src="${esc(L.logo)}" alt="" id="infoLogo">` : ''}
      <strong>${esc(L.nome || 'Catálogo')}</strong>
    </div>
    ${L.descricao ? `<p class="info-linha" style="margin-top:10px;">${esc(L.descricao)}</p>` : ''}
    ${redes.length ? `<nav class="redes" style="margin-top:10px;">${redesHtml(redes)}</nav>` : ''}
  </section>`);

  // ENDEREÇO
  if (L.endereco) {
    /* Link de mapa por BUSCA, não por coordenada: não há geocodificação neste
       projeto, e depender de uma seria criar dependência de mapa que a fase
       decidiu evitar. `encodeURIComponent` fecha a porta para injeção na URL. */
    const busca = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(L.endereco);
    secoes.push(`<section class="info-sec">
      <h3>Endereço</h3>
      <p class="info-linha">${esc(L.endereco)}</p>
      <p class="info-linha"><a href="${esc(busca)}" target="_blank" rel="noopener noreferrer">Abrir no mapa</a></p>
    </section>`);
  }

  // TIPOS DE SERVIÇO — só os habilitados
  const servicos = [];
  if (ent.retirada) servicos.push('Retirada');
  if (ent.delivery) servicos.push('Entrega');
  if (servicos.length) {
    let frete = '';
    if (ent.delivery) {
      if (ent.freteModo === 'gratis') frete = '<p class="info-linha">Entrega grátis.</p>';
      else if (ent.freteModo === 'combinar') frete = '<p class="info-linha">A taxa de entrega é combinada com a loja.</p>';
      else if (ent.freteModo === 'fixo' && ent.freteValor != null) {
        frete = `<p class="info-linha">Taxa de entrega: ${brl(ent.freteValor)}.</p>`;
      }
    }
    secoes.push(`<section class="info-sec">
      <h3>Tipos de serviço</h3>
      <div class="info-tags">${servicos.map((x) => `<span class="info-tag">${esc(x)}</span>`).join('')}</div>
      ${frete}
    </section>`);
  }

  // ABRANGÊNCIA — só quando há delivery por bairro
  if (ent.delivery && ent.bairros && ent.bairros.length) {
    secoes.push(`<section class="info-sec">
      <h3>Abrangência da entrega</h3>
      <div class="info-tags">${ent.bairros.map((b) =>
        `<span class="info-tag">${esc(b.nome)}${b.taxa > 0 ? ' · ' + brl(b.taxa) : ''}</span>`).join('')}</div>
      ${ent.aceitaForaCobertura
        ? '<p class="info-linha" style="margin-top:10px;">Aceitamos pedidos fora da área de cobertura.</p>' : ''}
    </section>`);
  } else if (ent.delivery && ent.aceitaForaCobertura) {
    secoes.push(`<section class="info-sec">
      <h3>Abrangência da entrega</h3>
      <p class="info-linha">Aceitamos pedidos fora da área de cobertura.</p>
    </section>`);
  }

  // HORÁRIOS — o formato já comporta mais de uma faixa por dia
  const h = L.horarios || {};
  if (Object.keys(h).length) {
    const hoje = diaHojeBrasilia();
    const linhas = [];
    // Começa na segunda e termina no domingo: é como se lê um expediente.
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      const faixas = h[d] || h[String(d)] || [];
      const txt = faixas.length
        ? faixas.map(([i, f]) => `${i} – ${f}`).join('<br>')
        : 'Fechado';
      linhas.push(`<dt class="${d === hoje ? 'hoje' : ''}">${DIAS_NOME[d]}</dt>`
                + `<dd class="${d === hoje ? 'hoje' : ''}">${txt}</dd>`);
    }
    secoes.push(`<section class="info-sec">
      <h3>Horário de funcionamento</h3>
      <dl class="info-horarios">${linhas.join('')}</dl>
    </section>`);
  }

  // CONTATO
  const contato = [];
  if (L.email) contato.push(`<p class="info-linha"><a href="mailto:${esc(L.email)}">${esc(L.email)}</a></p>`);
  if (L.telefone) contato.push(`<p class="info-linha">${esc(L.telefone)}</p>`);
  if (contato.length) {
    secoes.push(`<section class="info-sec"><h3>Contato</h3>${contato.join('')}</section>`);
  }

  $('infoCorpo').innerHTML = secoes.join('');
  aplicarFoco($('infoLogo'), L.logoFoco);
}

function abrirInformacoes() {
  montarInformacoes();
  $('infoBg').hidden = false;
  document.body.style.overflow = 'hidden';
  $('btInfoFechar').focus();
}

function fecharInformacoes() {
  $('infoBg').hidden = true;
  document.body.style.overflow = '';
}

/* ===================== carga inicial ======================================= */

async function carregar() {
  const cfg = await fetch('/loja/api/config').then((r) => r.json()).catch(() => null);
  if (!cfg || !cfg.success) {
    document.body.innerHTML = '<div class="vazio-msg" style="padding-top:80px;">Este catálogo não está publicado.</div>';
    return;
  }
  LOJA = cfg.loja;
  CAPACIDADES = LOJA.capacidades || {};
  aplicarTema(LOJA.tema);
  aplicarFavicon(LOJA.favicon);
  document.title = LOJA.nome;
  if (LOJA.tema && LOJA.tema.faixaTexto) { $('faixa').textContent = LOJA.tema.faixaTexto; $('faixa').hidden = false; }
  const tema = LOJA.tema || {};
  $('nomeLoja').textContent = LOJA.nome;
  // Slogan curto, em caixa alta, no lugar da apresentação quando houver.
  $('descLoja').textContent = tema.slogan || LOJA.descricao || '';
  $('descLoja').classList.toggle('slogan', !!tema.slogan);
  if (LOJA.logo) { const el = $('logo'); el.src = LOJA.logo; el.alt = LOJA.nome; el.hidden = false;
    aplicarFoco(el, LOJA.logoFoco); }
  else if (tema.sigla) { $('sigla').textContent = tema.sigla; $('sigla').hidden = false; }
  // Com o destaque ligado, a capa vira a imagem dele, e não a faixa do topo.
  const dq = tema.destaque;
  DESTAQUE_ATIVO = !!(dq && dq.ativo && dq.titulo);
  if (DESTAQUE_ATIVO) pintarDestaque(dq);
  else if (LOJA.banner) {
    $('capa').innerHTML = `<img src="${esc(LOJA.banner)}" alt="">`;
    $('capa').hidden = false;
    aplicarFoco($('capa').querySelector('img'), LOJA.bannerFoco);
  }

  const redes = linksSociais();
  $('redes').innerHTML = redesHtml(redes);
  ajustarIconesTopo();
  // A fonte da marca chega depois do primeiro desenho, e com ela o nome muda
  // de largura: a conta é refeita quando ela assenta.
  if (document.fonts) document.fonts.ready.then(ajustarIconesTopo);

  // Status de atendimento: informativo, e só aparece se houver horário definido.
  // Dois lugares, um só dado: o do cabeçalho some no celular por CSS, e o da
  // linha abaixo da busca só aparece lá. Quem decide é a media query.
  for (const id of ['statusAtend', 'statusAtendMobile']) {
    const st = $(id);
    if (!st) continue;
    if (LOJA.atendimento && LOJA.atendimento.rotulo) {
      st.textContent = LOJA.atendimento.rotulo;
      st.className = 'status' + (LOJA.atendimento.aberto ? ' aberto' : '');
      st.hidden = false;
    } else { st.hidden = true; }
  }

  pintarRodape(redes);

  const d = await fetch('/loja/api/produtos').then((r) => r.json()).catch(() => null);
  if (d && d.success) { PRODUTOS = d.produtos; CATEGORIAS = d.categorias; }
  pintarCategorias();
  await recalcular();
  await rotear();
}

/* ===================== eventos globais ===================================== */

/* O troco e o frete dependem de campos que mudam sem clique. */
document.addEventListener('change', (e) => {
  guardarCampoCheckout(e.target);
  if (e.target.id === 'chkPrecisaTroco') {
    const cx = $('chkTrocoValor');
    if (cx) cx.hidden = !e.target.checked;
    return;
  }
  if (e.target.id === 'chkBairro') pintarEscolhas();
});

document.addEventListener('click', async (e) => {
  if (tratarCliqueMontador(e)) return;
  const montar = e.target.closest('[data-montar]');
  if (montar) { e.stopPropagation(); return irPara('#/montar/' + Number(montar.dataset.montar)); }
  /* ---- checkout ---- */
  const irChk = e.target.closest('#btIrCheckout');
  if (irChk) {
    /* Sem escolha não avança. A barra já não desenha o Continuar antes da
       seleção, então chegar aqui sem serviço exigiria um clique forjado —
       mas a guarda fica, porque o custo dela é uma linha e o que ela evita
       é um checkout que pergunta de novo o que a sacola devia ter resolvido.
       A validação do próprio checkout (`enviarPedido`) continua intacta como
       segunda camada. */
    /* Sem escolha não avança, e a sacola diz onde falta — o Continuar só é
       desenhado depois da escolha, então chegar aqui exigiria um clique
       forjado, mas a guarda fica e agora ela se explica. */
    if (!SERVICO) {
      marcarFaltas([{ el: $('atendOps'), diz: 'Escolha retirada ou entrega' }]);
      return;
    }
    /* O serviço escolhido na sacola entra no checkout já marcado — perguntar
       duas vezes a mesma coisa é o jeito mais rápido de a pessoa desistir. */
    CHECKOUT.atendimento = SERVICO === 'delivery' ? 'entrega' : 'retirada';
    return irPara('#/checkout');
  }
  const atend = e.target.closest('[data-atend]');
  if (atend) {
    /* `pintarEscolhas`, e não `pintarCheckout`: repintar a tela inteira apaga
       o nome e o telefone que a pessoa já digitou. Só o que depende da
       escolha é atualizado. */
    CHECKOUT.atendimento = atend.dataset.atend;
    return pintarEscolhas();
  }
  const pag = e.target.closest('[data-pag]');
  if (pag) { CHECKOUT.pagamento = pag.dataset.pag; return pintarEscolhas(); }
  if (e.target.closest('[data-voltar-sacola]')) return irPara('#/sacola');
  if (e.target.closest('#btFinalizar')) return finalizarPedido();

  const mais = e.target.closest('[data-mais]');
  if (mais) {
    e.stopPropagation();
    const id = Number(mais.dataset.mais);
    const p = PRODUTOS.find((x) => x.id === id);
    // Personalização obrigatória não se resolve com um toque: abre o produto.
    if (!p || p.temPersonalizacao) return irPara('#/p/' + id);
    await adicionar({ produtoId: id, quantidade: 1, opcoes: [], textos: {}, comentario: null });
    if (location.hash === '#/sacola') await pintarSacola();
    return;
  }
  const abrir = e.target.closest('[data-abrir]');
  if (abrir) return irPara('#/p/' + Number(abrir.dataset.abrir));

  const ir = e.target.closest('[data-ir]');
  if (ir) {
    const alvo = document.getElementById(ir.dataset.ir);
    if (alvo) alvo.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (e.target.closest('#btInfo')) return abrirInformacoes();
  if (e.target.closest('#btInfoFechar')) return fecharInformacoes();
  // Clicar no véu fecha — é o gesto que todo mundo tenta primeiro.
  if (e.target.id === 'infoBg') return fecharInformacoes();
  if (e.target.closest('[data-voltar]')) return irPara('#/');
  if (e.target.closest('#barraVer')) return irPara('#/sacola');

  const menos = e.target.closest('[data-menos]');
  if (menos) { await mudarQuantidade(Number(menos.dataset.menos), -1); return pintarSacola(); }
  const maisItem = e.target.closest('[data-mais-item]');
  if (maisItem) { await mudarQuantidade(Number(maisItem.dataset.maisItem), 1); return pintarSacola(); }
  const rem = e.target.closest('[data-remover]');
  if (rem) { await remover(Number(rem.dataset.remover)); return pintarSacola(); }
  const editar = e.target.closest('[data-editar]');
  if (editar) {
    const idx = Number(editar.dataset.editar);
    const item = lerCarrinho()[idx];
    if (item) return irPara('#/montar/' + item.produtoId + '/' + idx);
    return;
  }

  /* ---- como você quer receber (barra inferior da sacola) ---- */
  const serv = e.target.closest('[data-servico]');
  if (serv) {
    SERVICO = serv.dataset.servico;
    return pintarBarraAtendimento();
  }
  /* Alterar volta ao estado de escolha SEM tocar na sacola: só o serviço é
     esquecido, e os itens, as quantidades e as observações seguem onde
     estavam. */
  if (e.target.closest('[data-alterar-servico]')) {
    SERVICO = null;
    pintarBarraAtendimento();
    const primeiro = document.querySelector('.atend-op');
    if (primeiro) primeiro.focus();   // o teclado continua de onde parou
    return;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('infoBg').hidden) return fecharInformacoes();
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const alvo = e.target.closest('[data-abrir]');
  if (alvo && !e.target.closest('button')) { e.preventDefault(); irPara('#/p/' + Number(alvo.dataset.abrir)); }
  const mont = e.target.closest('article[data-montar]');
  if (mont && !e.target.closest('button')) { e.preventDefault(); irPara('#/montar/' + Number(mont.dataset.montar)); }
});

window.addEventListener('hashchange', rotear);
document.addEventListener('DOMContentLoaded', carregar);
