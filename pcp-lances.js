// pcp-lances.js
//
// Disputa (lances) no Portal de Compras Públicas.
//
// Protocolo (engenharia reversa 2026-07-21, /4/lib/pregao.js + aba ao vivo):
//   - Estado da sala: POST /4/SessaoPublica/lances/htmlAba.asp
//       param=<aba>&ttCD_LICITACAO=<chave>&ttPagina=1&ttPaginaItemLote=1
//     → fragmento HTML <table id="tabTableSorter"> com uma <tr id="itemNNN"> por item.
//     Abas: 0=Todos 10=Seus 1=Abertos 2=Fechados 3=Suspensos 4=Desempate
//           5=Encerrados 6=Outros 11=Lances Fechados
//   - Lance: POST /4/SessaoPublica/SubmeterLance/
//       ttCD_CHAVE=<chave>&slCD_ORIGEM=<idItem>&ttUsuarioAtivo=<fornecedorId>
//       &ttPRECO_UNITARIO=<pt-BR "9.000,00">&btGravar=sim
//     → JSON { mensagem, manterValor }.
//
// O valor vai no formato da máscara maskMoney `preco2` (milhar "." decimal ",").

const { fetchPcpHtml, postPcpForm } = require('./pcp-client');

const OPERACAO_BASE = 'https://operacao.portaldecompraspublicas.com.br';
const SESSAO_BASE = `${OPERACAO_BASE}/4/SessaoPublica/`;

const ABAS = {
  todos: 0, abertos: 1, fechados: 2, suspensos: 3, desempate: 4,
  encerrados: 5, outros: 6, seus: 10, lancesFechados: 11,
};

// ----- helpers -----

function stripTags(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// "R$ 9.400,00" / "9.000,00" / "9000" → 9400 | 9000 | 9000
function parseValorBR(s) {
  if (s == null) return null;
  let t = String(s).replace(/R\$|\s|%/g, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number.parseFloat(t);
  return Number.isNaN(n) ? null : n;
}

// 8999.5 → "8.999,50" (máscara preco2 do portal)
function formatValorBR(v, casas = 2) {
  return Number(v).toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  });
}

function enc(v) {
  return encodeURIComponent(v == null ? '' : String(v));
}

// ----- parser da aba de lances -----

function parseAba(html) {
  const itens = [];
  const trs = html.match(/<tr id="item\d+"[\s\S]*?<\/tr>/gi) || [];

  for (const tr of trs) {
    const idItem = tr.match(/<tr id="item(\d+)"/i)?.[1];
    if (!idItem) continue;

    const numero = stripTags(tr.match(/<td class="td70">([\s\S]*?)<\/td>/i)?.[1] || '');
    const descricao = stripTags(
      tr.match(/<p id="produtoTexto\d+"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ''
    );

    // Form de lance só existe quando o item aceita lance nossa vez.
    const form = tr.match(/<form[^>]*action\s*=\s*"([^"]*SubmeterLance[^"]*)"[\s\S]*?<\/form>/i);
    const podeLance = !!form;
    const fornecedorId = tr.match(/name="ttUsuarioAtivo" value="(\d+)"/i)?.[1] || null;
    const acaoLance = form ? form[1] : null;
    // Sem form o portal escreve o motivo em texto ("Não Participa", "Item Fechado"…)
    const motivoSemLance = podeLance
      ? null
      : stripTags(tr.match(/<td class="td150">([\s\S]*?)<\/td>/i)?.[1] || '') || null;

    // Melhor lance corrente do item (hidden bruto + span formatado).
    const melhorLance = parseValorBR(tr.match(/name="precoItem" type="hidden" value="([^"]*)"/i)?.[1]);

    // O title do ícone de estado carrega posição e nossa melhor proposta.
    const estado = (tr.match(/class="stateIMGLink" title="([^"]*)"/i)?.[1] || '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const minhaMelhor = parseValorBR(estado.match(/Sua melhor proposta:\s*([^\n]+)/i)?.[1]);
    const posicaoTxt = estado.match(/Sua posição atual:\s*([^\n]+)/i)?.[1]?.trim() || null;
    const posicao = posicaoTxt ? (parseInt(posicaoTxt, 10) || null) : null;
    const vencendo = /icoGanhando/i.test(tr) || /melhor proposta é sua/i.test(estado);

    // Fase "Aberto e Fechado": no encerramento o lance sai por uma tela modal
    // (POST /SessaoPublica/LanceFechado/), não pelo form inline.
    const podeLanceFechado = /\/SessaoPublica\/LanceFechado\//i.test(tr);

    const status = tr.match(/data-status="([^"]*)"/i)?.[1] || null;
    const statusTitulo = tr.match(/<a title="([^"]*)" data-status=/i)?.[1] || null;
    const horaFechamento = tr.match(/name="horaFechamento" value="([^"]*)"/i)?.[1] || null;

    itens.push({
      idItem, numero, descricao,
      podeLance, podeLanceFechado, motivoSemLance, acaoLance, fornecedorId,
      melhorLance, minhaMelhor, posicao, posicaoTxt, vencendo,
      status, statusTitulo, horaFechamento,
      estado: estado || null,
    });
  }

  return {
    itens,
    horaAtual: html.match(/name="horaAtual"[^>]*value="([^"]*)"/i)?.[1] || null,
    aba: html.match(/name="tipoLicitacao"[^>]*value="([^"]*)"/i)?.[1] || null,
    chave: html.match(/name="licitacao"[^>]*value="([^"]*)"/i)?.[1] || null,
    lancesFechados: html.match(/name="lancesFechados"[^>]*value="([^"]*)"/i)?.[1] === '1',
    chatDisponivel: html.match(/name="chatDisponivel"[^>]*value="([^"]*)"/i)?.[1] === '1',
    total: parseInt(stripTags(html.match(/Total de Registros:\s*<b>(\d+)/i)?.[1] || '0'), 10) || 0,
  };
}

// ----- leitura da sala -----

// Cabeçalho da sessão (situação, objeto, casas decimais, tipo de julgamento).
async function lerCabecalho(db, chave) {
  const { body, status } = await fetchPcpHtml(db, `${SESSAO_BASE}?ttCD_CHAVE=${chave}`);
  return {
    status,
    situacao: stripTags(body.match(/<span class="operationTitle">([\s\S]*?)<\/span>/i)?.[1] || '') || null,
    processo: stripTags(body.match(/<b>Processo:<\/b>([\s\S]*?)<\/p>/i)?.[1] || '') || null,
    orgao: stripTags(body.match(/<b>Órgão:<\/b>([\s\S]*?)<\/p>/i)?.[1] || '') || null,
    modoDisputa: stripTags(body.match(/<b>Modo de Disputa:<\/b>([\s\S]*?)<\/p>/i)?.[1] || '') || null,
    tipoJulgamento: parseInt(body.match(/id="julgamentoLicitacao"[^>]*value="(\d+)"/i)?.[1] || '1', 10),
    casasDecimais: parseInt(body.match(/id="casasDecimais"[^>]*value="(\d+)"/i)?.[1] || '2', 10),
    horaAtual: body.match(/id="ultimaAtualizacao">([^<]*)</i)?.[1] || null,
  };
}

// Estado dos itens numa aba. `aba` aceita nome ("todos") ou índice.
async function lerSala(db, chave, { aba = 'todos', pagina = 1 } = {}) {
  const param = typeof aba === 'number' ? aba : (ABAS[aba] ?? 0);
  const form = `param=${param}&ttCD_LICITACAO=${enc(chave)}&ttPagina=${pagina}&ttPaginaItemLote=1`;
  const r = await postPcpForm(db, `${SESSAO_BASE}lances/htmlAba.asp`, form, {
    extraHeaders: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${SESSAO_BASE}?ttCD_CHAVE=${chave}`,
    },
  });
  if (r.body.includes('"urlRedir":')) {
    throw new Error('Sessão PCP expirada (urlRedir na aba de lances)');
  }
  return { ...parseAba(r.body), httpStatus: r.status };
}

// ----- envio de lance -----

// Envia UM lance. dryRun (default) só monta o corpo e devolve, sem POST.
async function enviarLance(db, { chave, idItem, valor, fornecedorId, casasDecimais = 2, dryRun = true }) {
  if (!chave || !idItem) throw new Error('chave e idItem são obrigatórios');
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Valor de lance inválido: ${valor}`);

  let fid = fornecedorId;
  if (!fid) {
    const sala = await lerSala(db, chave, { aba: 'todos' });
    const item = sala.itens.find((i) => i.idItem === String(idItem));
    if (!item) throw new Error(`Item ${idItem} não encontrado na sala ${chave}`);
    if (!item.podeLance) throw new Error(`Item ${idItem} não aceita lance agora: ${item.motivoSemLance || item.statusTitulo}`);
    fid = item.fornecedorId;
  }
  if (!fid) throw new Error('ttUsuarioAtivo (fornecedorId) não encontrado');

  const valorBR = formatValorBR(v, casasDecimais);
  const body =
    `ttCD_CHAVE=${enc(chave)}&slCD_ORIGEM=${enc(idItem)}&ttUsuarioAtivo=${enc(fid)}` +
    `&ttPRECO_UNITARIO=${enc(valorBR)}&btGravar=sim`;

  if (dryRun) {
    return { dryRun: true, url: `${OPERACAO_BASE}/4/SessaoPublica/SubmeterLance/`, body, valorBR, enviado: false };
  }

  const r = await postPcpForm(db, `${OPERACAO_BASE}/4/SessaoPublica/SubmeterLance/`, body, {
    extraHeaders: {
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${SESSAO_BASE}?ttCD_CHAVE=${chave}`,
    },
  });

  let retorno = null;
  try { retorno = JSON.parse(r.body); } catch (e) { /* portal às vezes devolve vazio */ }

  return {
    dryRun: false,
    enviado: true,
    httpStatus: r.status,
    valorBR,
    mensagem: retorno?.mensagem ?? (r.body ? stripTags(r.body).slice(0, 300) : null),
    manterValor: retorno?.manterValor ?? null,
    raw: retorno ? undefined : r.body?.slice(0, 500),
  };
}

// Lance FECHADO (modo de disputa "Aberto e Fechado", fase de encerramento).
// Tela modal própria — e os parâmetros vêm TROCADOS em relação a SubmeterLance:
// aqui ttCD_CHAVE = id do item e slCD_ORIGEM = id da licitação.
async function enviarLanceFechado(db, { chave, idItem, valor, casasDecimais = 2, dryRun = true }) {
  if (!chave || !idItem) throw new Error('chave e idItem são obrigatórios');
  const v = Number(valor);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Valor de lance inválido: ${valor}`);

  const valorBR = formatValorBR(v, casasDecimais);
  const url = `${SESSAO_BASE}LanceFechado/`;
  const body =
    `ttCD_CHAVE=${enc(idItem)}&slCD_ORIGEM=${enc(chave)}` +
    `&ttLANCE_FECHADO=${enc(valorBR)}&btGravar=${enc('Enviar Lance')}`;

  if (dryRun) return { dryRun: true, fechado: true, url, body, valorBR, enviado: false };

  const r = await postPcpForm(db, url, body, {
    extraHeaders: { Referer: `${url}?ttCD_CHAVE=${idItem}&slCD_ORIGEM=${chave}&slCotaReservada=2&iframe=True` },
  });

  // A tela modal responde HTML; o portal repete o form em caso de erro de validação.
  const aindaTemForm = /name="ttLANCE_FECHADO"/i.test(r.body);
  const mensagem = stripTags(
    r.body.match(/class="(?:mensagem|msgErro|alertBlock)[^"]*"[^>]*>([\s\S]*?)<\//i)?.[1] || ''
  ) || null;

  return {
    dryRun: false, fechado: true, enviado: true,
    httpStatus: r.status, valorBR,
    aceito: !aindaTemForm,
    mensagem,
    raw: r.body?.slice(0, 500),
  };
}

module.exports = {
  ABAS,
  lerCabecalho,
  lerSala,
  enviarLance,
  enviarLanceFechado,
  // expostos p/ testes
  parseAba,
  parseValorBR,
  formatValorBR,
};
