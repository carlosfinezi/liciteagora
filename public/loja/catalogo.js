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
    })).filter((i) => Number.isFinite(i.produtoId) && i.produtoId > 0 && i.quantidade > 0);
  } catch { return []; }
}

function gravarCarrinho(itens) {
  try { localStorage.setItem(CHAVE, JSON.stringify(itens)); } catch { /* modo privado */ }
}

/** Duas linhas do mesmo produto só se fundem se as escolhas forem idênticas. */
const assinatura = (i) =>
  i.produtoId + '|' + [...i.opcoes].sort((a, b) => a - b).join(',')
  + '|' + JSON.stringify(i.textos || {}) + '|' + (i.comentario || '');

function adicionar(item) {
  const itens = lerCarrinho();
  const chave = assinatura(item);
  const existente = itens.find((i) => assinatura(i) === chave);
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
  return `<article class="card" data-abrir="${p.id}" role="button" tabindex="0"
      aria-label="Abrir ${esc(p.descricao)}">
    <div class="card-foto">${foto
      ? `<img src="${esc(foto)}" alt="${esc(p.descricao)}" loading="lazy">`
      : '<span class="sem-foto">sem foto</span>'}
      ${p.destaque ? '<span class="selo">★</span>' : ''}</div>
    <div class="card-txt">
      <h3>${esc(p.descricao)}</h3>
      ${p.marca ? `<p class="marca">${esc(p.marca)}</p>` : ''}
      <div class="linha-preco">${precoHtml(p)}</div>
    </div>
    <button class="mais" data-mais="${p.id}" aria-label="Adicionar ${esc(p.descricao)}">+</button>
  </article>`;
}

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
  // Destaques primeiro — e só quando existem. Seção vazia é ruído.
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
      return `<fieldset class="grupo">
        <legend>${esc(g.nome)} ${g.obrigatorio ? '<span class="obrig">obrigatório</span>' : ''}</legend>
        ${g.descricao ? `<p class="ajuda">${esc(g.descricao)}</p>` : ''}
        <textarea data-texto="${g.id}" rows="2" maxlength="300"
          placeholder="Escreva aqui…">${esc(ESCOLHAS.textos[g.id] || '')}</textarea>
      </fieldset>`;
    }
    const multi = g.maxEscolhas > 1;
    return `<fieldset class="grupo">
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
        <p class="erro" id="erroProduto" hidden></p>
      </div>
    </article>
    <div class="barra-produto">
      <button class="principal" id="btAdicionar">Adicionar ${brl(totalPrevia())}</button>
    </div>`;
  ligarProduto();
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
      if (inp.type === 'radio') {
        const grupo = PRODUTO.personalizacoes.find((g) => g.id === grupoId);
        for (const o of grupo.opcoes) ESCOLHAS.opcoes.delete(o.id);
        ESCOLHAS.opcoes.add(id);
      } else if (inp.checked) ESCOLHAS.opcoes.add(id);
      else ESCOLHAS.opcoes.delete(id);
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
    const erro = $('erroProduto');
    erro.hidden = true;
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
      erro.textContent = (r && r.error) || 'Não foi possível adicionar.';
      erro.hidden = false;
      return;
    }
    await adicionar(item);
    irPara('#/');
  };
  atualizarBotaoProduto();
}

/* ===================== SACOLA ============================================== */

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
        ${i.opcoes.length ? `<span class="is-op">${i.opcoes.map((o) => esc(o.nome)).join(', ')}</span>` : ''}
        ${i.comentario ? `<span class="is-op">“${esc(i.comentario)}”</span>` : ''}
        <span class="is-preco">${i.total == null ? 'a combinar' : brl(i.total)}</span>
      </div>
      <div class="is-acoes">
        <div class="qtd">
          <button data-menos="${idx}" aria-label="Diminuir">−</button>
          <output>${i.quantidade}</output>
          <button data-mais-item="${idx}" aria-label="Aumentar">+</button>
        </div>
        <button class="excluir" data-remover="${idx}" aria-label="Remover">Excluir</button>
      </div>
    </li>`).join('');

  alvo.innerHTML = `
    <div class="sacola-topo">
      <h1>Sua sacola</h1>
      <strong>${SACOLA.semPreco ? 'a combinar' : brl(SACOLA.total)}</strong>
    </div>
    <ul class="lista-sacola">${linhas}</ul>
    <!-- O tipo de serviço vem ANTES das sugestões: é a decisão que segue o
         pedido, e deixá-la depois de uma lista de recomendações a empurrava
         para fora da vista. Só os serviços HABILITADOS pelo lojista aparecem. -->
    <section class="servico">
      <h2>Selecione o tipo de serviço</h2>
      <div class="servico-botoes">${botoesServico()}</div>
      <p class="ajuda" id="avisoServico" hidden></p>
    </section>
    <section class="secao" id="secSugestoes" hidden>
      <h2>Complete seu pedido</h2>
      <div class="trilho" id="sugestoes"></div>
    </section>
    <div class="ir-checkout">
      <button class="bt-principal" id="btIrCheckout" type="button">Continuar</button>
    </div>`;
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
let CHECKOUT = { atendimento: null, pagamento: null, chave: null, enviando: false };

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
  // Serviço único não é escolha: já vem marcado.
  if (!CHECKOUT.atendimento) {
    CHECKOUT.atendimento = podeRetirada && !podeEntrega ? 'retirada'
      : (!podeRetirada && podeEntrega ? 'entrega' : null);
  }

  alvo.innerHTML = `
    <div class="chk">
      <h1>Finalizar pedido</h1>

      <section class="chk-bloco">
        <h2>Como você quer receber?</h2>
        <div class="chk-opcoes">
          ${podeRetirada ? `<button type="button" class="chk-op" data-atend="retirada">
            <strong>Retirada</strong><span>Você busca na loja</span></button>` : ''}
          ${podeEntrega ? `<button type="button" class="chk-op" data-atend="entrega">
            <strong>Delivery</strong><span>Entregamos no seu endereço</span></button>` : ''}
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
                 maxlength="20" placeholder="(00) 00000-0000">
        </div>
        <div class="chk-campo">
          <label for="chkDoc">CPF ou CNPJ <span class="chk-op-txt">(opcional)</span></label>
          <input id="chkDoc" type="text" inputmode="numeric" maxlength="20" placeholder="Só se quiser na nota">
        </div>
      </section>

      <section class="chk-bloco" id="chkEndereco" hidden>
        <h2>Endereço de entrega</h2>
        <div class="chk-linha">
          <div class="chk-campo chk-cep">
            <label for="chkCep">CEP</label>
            <input id="chkCep" type="text" inputmode="numeric" maxlength="9" placeholder="00000-000">
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
        <div class="chk-opcoes">
          <button type="button" class="chk-op" data-pag="pix"><strong>PIX</strong></button>
          <button type="button" class="chk-op" data-pag="dinheiro"><strong>Dinheiro</strong></button>
          <button type="button" class="chk-op" data-pag="cartao"><strong>Cartão</strong><span>na entrega/retirada</span></button>
        </div>
        <div id="chkTroco" hidden>
          <label class="chk-check">
            <input type="checkbox" id="chkPrecisaTroco"> Precisa de troco?
          </label>
          <div class="chk-campo" id="chkTrocoValor" hidden>
            <label for="chkTrocoPara">Troco para quanto?</label>
            <input id="chkTrocoPara" type="text" inputmode="decimal" maxlength="12" placeholder="0,00">
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
        <p class="chk-aviso" id="chkAvisoFrete" hidden></p>
      </section>

      <p class="chk-erro" id="chkErro" hidden></p>
      <button type="button" class="bt-principal" id="btFinalizar">Finalizar pedido</button>
      <button type="button" class="btn-linha" data-voltar-sacola="1">Voltar à sacola</button>
    </div>`;

  pintarEscolhas();
}

/** Marca os botões escolhidos e mostra/esconde o que depende deles. */
function pintarEscolhas() {
  const e = (LOJA && LOJA.entrega) || {};
  document.querySelectorAll('[data-atend]').forEach((b) =>
    b.classList.toggle('on', b.dataset.atend === CHECKOUT.atendimento));
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

  const quando = $('chkQuandoPaga');
  if (quando) {
    quando.textContent = CHECKOUT.atendimento
      ? `Você paga na ${entrega ? 'entrega' : 'retirada'}. Nada é cobrado agora.`
      : 'Nada é cobrado agora.';
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
    if (modo === 'gratis') { $('chkFrete').textContent = 'grátis'; atualizarTotal(0); }
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
  const corpo = {
    idempotencyKey: chaveDaTentativa(),
    cliente: { nome: v('chkNome'), telefone: v('chkTelefone'), cpfCnpj: v('chkDoc') || null },
    atendimento: CHECKOUT.atendimento,
    pagamento: CHECKOUT.pagamento,
    observacao: v('chkObs') || null,
    itens: lerCarrinho(),
  };
  if (CHECKOUT.atendimento === 'entrega') {
    corpo.endereco = {
      cep: v('chkCep'), logradouro: v('chkRua'), numero: v('chkNumero'),
      complemento: v('chkComplemento'), bairro: v('chkBairro'),
      cidade: v('chkCidade'), uf: v('chkUf'), referencia: v('chkReferencia'),
    };
  }
  if (CHECKOUT.pagamento === 'dinheiro' && $('chkPrecisaTroco') && $('chkPrecisaTroco').checked) {
    corpo.precisaTroco = true;
    corpo.trocoPara = Number(String(v('chkTrocoPara')).replace(/\./g, '').replace(',', '.'));
  }
  return corpo;
}

async function finalizarPedido() {
  const erro = $('chkErro');
  const mostrar = (msg) => { erro.hidden = false; erro.textContent = msg; erro.scrollIntoView({ block: 'center' }); };
  erro.hidden = true;

  if (!CHECKOUT.atendimento) return mostrar('Escolha se quer retirar ou receber em casa.');
  if (!CHECKOUT.pagamento) return mostrar('Escolha a forma de pagamento.');

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
      mostrar((d && d.error) || 'Não conseguimos concluir seu pedido agora. Tente de novo.');
      return;
    }
    ULTIMO_PEDIDO = d;
    gravarCarrinho([]);                 // o pedido saiu: a sacola esvazia
    SACOLA = { itens: [], total: 0, quantidadeItens: 0 };
    CHECKOUT.chave = null;              // a próxima compra é outra tentativa
    location.hash = '#/pedido/' + encodeURIComponent(d.numero);
  } catch {
    mostrar('Não conseguimos falar com a loja. Verifique a conexão e tente de novo.');
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
  const instrucao = {
    pix: 'A loja vai enviar as instruções de pagamento do PIX.',
    dinheiro: 'Separe o valor para pagar na ' + (d.atendimento === 'entrega' ? 'entrega' : 'retirada') + '.',
    cartao: 'A maquininha vai na ' + (d.atendimento === 'entrega' ? 'entrega' : 'retirada') + '.',
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
      <p class="ok-linha"><strong>${d.atendimento === 'entrega' ? 'Delivery' : 'Retirada'}</strong>
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
    $('sugestoes').innerHTML = d.produtos.map((p) => `
      <article class="sug" data-abrir="${p.id}" role="button" tabindex="0">
        <div class="sug-foto">${fotoDe(p)
          ? `<img src="${esc(fotoDe(p))}" alt="" loading="lazy">` : '<span class="sem-foto">—</span>'}</div>
        <span class="sug-nome">${esc(p.descricao)}</span>
        <span class="sug-preco">${p.preco == null ? '—' : brl(p.preco)}</span>
        <button class="mais" data-mais="${p.id}" aria-label="Adicionar ${esc(p.descricao)}">+</button>
      </article>`).join('');
    $('secSugestoes').hidden = false;
  } catch { /* sugestão é extra: falhar aqui não pode estragar a sacola */ }
}

/* ===================== barra fixa ========================================== */

function pintarBarra() {
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
    || location.hash.startsWith('#/pedido/');
  document.body.classList.toggle('com-barra', !b.hidden);
}

/* ===================== roteamento ========================================== */

function irPara(hash) {
  if (location.hash === hash) rotear();
  else location.hash = hash;
}

async function rotear() {
  const h = location.hash || '#/';
  const topo = $('cabecalhoBusca');
  window.scrollTo(0, 0);

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
 * Botões de serviço — só os habilitados em Configurações → Entrega.
 *
 * Oferecer "Delivery" numa loja que não entrega é prometer o que não existe. Se
 * o lojista não configurou nada, o padrão do schema é retirada ligada, então
 * sempre sobra ao menos um caminho.
 */
function botoesServico() {
  const e = (LOJA && LOJA.entrega) || {};
  const fora = [];
  if (e.retirada) fora.push('<button class="servico-bt" data-servico="retirada">Retirada</button>');
  if (e.delivery) fora.push('<button class="servico-bt" data-servico="delivery">Delivery</button>');
  return fora.join('') || '<p class="ajuda">Fale com a loja para combinar a entrega.</p>';
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
    contato.push(`<li><a href="${esc(zap)}" target="_blank" rel="noopener noreferrer">WhatsApp</a></li>`);
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
  $('rodCopy').textContent = `© ${ano} ${LOJA.nome || ''}`.trim();
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
  if (ent.delivery) servicos.push('Delivery');
  if (servicos.length) {
    let frete = '';
    if (ent.delivery) {
      if (ent.freteModo === 'gratis') frete = '<p class="info-linha">Entrega grátis.</p>';
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
  aplicarTema(LOJA.tema);
  document.title = LOJA.nome;
  $('nomeLoja').textContent = LOJA.nome;
  $('descLoja').textContent = LOJA.descricao || '';
  if (LOJA.logo) { const el = $('logo'); el.src = LOJA.logo; el.alt = LOJA.nome; el.hidden = false;
    aplicarFoco(el, LOJA.logoFoco); }
  if (LOJA.banner) {
    $('capa').innerHTML = `<img src="${esc(LOJA.banner)}" alt="">`;
    $('capa').hidden = false;
    aplicarFoco($('capa').querySelector('img'), LOJA.bannerFoco);
  }

  const redes = linksSociais();
  $('redes').innerHTML = redesHtml(redes);

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
  if (e.target.id === 'chkPrecisaTroco') {
    const cx = $('chkTrocoValor');
    if (cx) cx.hidden = !e.target.checked;
    return;
  }
  if (e.target.id === 'chkBairro') pintarEscolhas();
});

document.addEventListener('click', async (e) => {
  /* ---- checkout ---- */
  const irChk = e.target.closest('#btIrCheckout');
  if (irChk) {
    /* O serviço escolhido na sacola entra no checkout já marcado — perguntar
       duas vezes a mesma coisa é o jeito mais rápido de a pessoa desistir. */
    const marcado = document.querySelector('.servico-bt.on');
    if (marcado) {
      CHECKOUT.atendimento = marcado.dataset.servico === 'delivery' ? 'entrega' : 'retirada';
    }
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

  const serv = e.target.closest('[data-servico]');
  if (serv) {
    const av = $('avisoServico');
    const ent = (LOJA && LOJA.entrega) || {};
    let txt;
    if (serv.dataset.servico === 'retirada') {
      txt = 'Retirada escolhida. O endereço da loja e o horário entram na próxima etapa.';
    } else {
      txt = 'Delivery escolhido. Endereço e taxa de entrega entram na próxima etapa.';
      // Já dá para adiantar o que se sabe do frete, sem prometer cálculo final.
      if (ent.freteModo === 'gratis') txt = 'Delivery escolhido. Entrega grátis. O endereço entra na próxima etapa.';
      else if (ent.freteModo === 'fixo' && ent.freteValor != null) {
        txt = `Delivery escolhido. Taxa de ${brl(ent.freteValor)}. O endereço entra na próxima etapa.`;
      }
    }
    av.textContent = txt;
    av.hidden = false;
    document.querySelectorAll('.servico-bt').forEach((b) => b.classList.toggle('on', b === serv));
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('infoBg').hidden) return fecharInformacoes();
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const alvo = e.target.closest('[data-abrir]');
  if (alvo && !e.target.closest('button')) { e.preventDefault(); irPara('#/p/' + Number(alvo.dataset.abrir)); }
});

window.addEventListener('hashchange', rotear);
document.addEventListener('DOMContentLoaded', carregar);
