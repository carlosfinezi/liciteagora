// bll-proposta.js
//
// Envio automático de PROPOSTA na BLL Compras (bllcompras.com).
//
// Baseado no recon capturado ao vivo em 17/06/2026 (edital 003/2026):
//   POST https://bllcompras.com/Proposal/Proposal
//   - form-urlencoded, serialização do form DOM #jsonForm1 (jQuery $.ajax)
//   - autenticação só por cookie de sessão (capturado pelo Electron)
//   - SEM token antifalsificação (__RequestVerificationToken ausente)
//   - SEM captcha no salvar
//   - sucesso → resposta abre /Base/DataResult?message=Proposta%20Salva
//
// Campos do payload (jsonForm1):
//   participantId        = [gkz]<token>      (hidden)
//   IsMePortionAccepted  = False             (hidden)
//   IsMe                 = True | False      (declaração ME/EPP)
//   fkRepresentant       = <GUID>            (representante legal)
//   processId            = [gkz]<token>      (hidden)
//   proposalItems[N].idBatchItem   = [gkz]<token por item>   (hidden)
//   proposalItems[N].ProposalValue = valor (decimal pt-BR, ex "416,67")
//
// Fluxo (espelha enviarProposta do Motor A / comprasnet-api.js, nos endpoints BLL):
//   1) carregarItens()  → GET autenticado da página, parseia tokens e itens
//   2) montarPayload()  → monta o form com IsMe/representante/valores
//   3) enviarProposta() → POST /Proposal/Proposal (dryRun=true só monta/loga)
//
// SEGURANÇA: enviarProposta() roda dryRun=true por padrão — só monta o payload
// e o persiste como prévia. Para POSTar de fato é preciso passar dryRun:false
// explicitamente. Idempotente por processId (não reenvia se já 'enviada').

'use strict';

const { bllGet, bllPost } = require('./bll-client');

const PROPOSAL_PATH = '/Proposal/Proposal';

// ─── parsing de HTML (sem cheerio no projeto → regex, como bnc-client) ──────

// Extrai o objeto de atributos de uma tag (<input .../>, <option ...>).
function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    const key = m[1].toLowerCase();
    // HTML: atributo duplicado → o PRIMEIRO vence (o browser ignora a repetição).
    // O BLL põe Name="participantId" ANTES de name="idParticipant"; o jQuery .serialize()
    // usa 'participantId'. Manter o primeiro casa com o browser. (Mesmo fix do bnc-proposta.)
    if (key in attrs) continue;
    attrs[key] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
  }
  return attrs;
}

function allInputs(html) {
  const out = [];
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(parseAttrs(m[0]));
  return out;
}

function inputValueByName(html, name) {
  const lower = name.toLowerCase();
  const found = allInputs(html).find((a) => (a.name || '').toLowerCase() === lower);
  return found ? (found.value ?? '') : null;
}

// Coleta proposalItems[N].idBatchItem → [{ index, idBatchItem }] ordenado por N.
function parseProposalItems(html) {
  const itens = [];
  for (const a of allInputs(html)) {
    const nm = a.name || '';
    const mm = /^proposalItems\[(\d+)\]\.idBatchItem$/i.exec(nm);
    if (mm) itens.push({ index: parseInt(mm[1], 10), idBatchItem: a.value ?? '' });
  }
  itens.sort((x, y) => x.index - y.index);
  return itens;
}

// Opções do <select name="fkRepresentant"> → [{ value, label, selected }].
function parseRepresentantes(html) {
  const sel = /<select\b[^>]*name\s*=\s*["']?fkRepresentant["']?[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  if (!sel) return [];
  const opts = [];
  const re = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(sel[1])) !== null) {
    const a = parseAttrs('<option ' + m[1] + '>');
    const value = a.value ?? '';
    if (!value) continue; // pula placeholder "Selecione..."
    opts.push({
      value,
      label: m[2].replace(/<[^>]*>/g, '').trim(),
      selected: /\bselected\b/i.test(m[1]),
    });
  }
  return opts;
}

// IsMe radio: pega o value do radio marcado (checked); default 'True'.
// `checked` é atributo booleano (sem `=`), então testamos a tag crua.
function parseIsMe(html) {
  const re = /<input\b[^>]*\bname\s*=\s*["']?IsMe["']?[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (/\bchecked\b/i.test(m[0])) {
      const v = parseAttrs(m[0]).value;
      if (v) return v;
    }
  }
  return 'True';
}

// ─── carregar página de proposta ───────────────────────────────────────────

// urlOuToken: URL completa da página OU só o token param1 ([gkz]...).
function paginaUrl(urlOuToken) {
  if (/^https?:\/\//i.test(urlOuToken)) return urlOuToken;
  if (urlOuToken.startsWith('/')) return urlOuToken;
  return `${PROPOSAL_PATH}?param1=${encodeURIComponent(urlOuToken)}`;
}

// Documentos exigidos (tabela #tableDocumentsAttached). Cada linha tem os campos
// document[N].fkParticipantDocument / .idProcessDocument (form="jsonForm1") + ServerFileName.
// anexado = tem nome de arquivo/ServerFileName; senão o portal recusa se obrigatório.
function parseDocumentos(html) {
  const ti = html.indexOf('tableDocumentsAttached');
  if (ti < 0) return [];
  const tStart = html.lastIndexOf('<table', ti);
  const tEnd = html.indexOf('</table>', ti);
  if (tStart < 0 || tEnd < 0) return [];
  const tabela = html.slice(tStart, tEnd);
  const docs = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  const limpa = (s) => String(s || '').replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  while ((m = trRe.exec(tabela)) !== null) {
    const tr = m[0];
    const inputs = allInputs(tr);
    const ip = inputs.find((a) => /document\[\d+\]\.idProcessDocument/i.test(a.name || ''));
    if (!ip) continue;
    const idx = parseInt((ip.name.match(/\[(\d+)\]/) || [])[1] ?? '-1', 10);
    const trId = (tr.match(/<tr\b[^>]*\bid=["']?([^"'\s>]+)/i) || [])[1] || '';
    const fk = inputs.find((a) => /document\[\d+\]\.fkParticipantDocument/i.test(a.name || ''));
    const sfn = inputs.find((a) => /ServerFileName/i.test(a.name || ''));
    const tds = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => limpa(x[1]));
    const nomeArquivo = tds[1] || '';
    docs.push({
      index: idx,
      trId,
      idProcessDocument: ip.value || '',
      fkParticipantDocument: (fk && fk.value) || '',
      serverFileName: (sfn && sfn.value) || '',
      label: tds[0] || '',
      nomeArquivo,
      obrigatorio: /sim/i.test(tds[4] || ''),
      anexado: !!nomeArquivo || !!(sfn && sfn.value),
    });
  }
  docs.sort((a, b) => a.index - b.index);
  return docs;
}

async function carregarItens(db, urlOuToken) {
  const url = paginaUrl(urlOuToken);
  const resp = await bllGet(db, url, { Accept: 'text/html,application/xhtml+xml,*/*' });
  const html = resp.body || '';

  const participantId = inputValueByName(html, 'participantId');
  const processId = inputValueByName(html, 'processId');
  const isMePortionAccepted = inputValueByName(html, 'IsMePortionAccepted') ?? 'False';
  const itens = parseProposalItems(html);
  const representantes = parseRepresentantes(html);
  const isMe = parseIsMe(html);
  const documentos = parseDocumentos(html);

  if (!processId || !participantId || itens.length === 0) {
    const erro = new Error(
      'Página de proposta BLL não pôde ser parseada (processId/participantId/itens ausentes). ' +
      'Verifique a sessão (cookie) e o token param1.'
    );
    erro.code = 'BLL_PROPOSTA_PARSE';
    erro.detalhe = { temProcessId: !!processId, temParticipantId: !!participantId, qtdItens: itens.length };
    throw erro;
  }

  return {
    participantId,
    processId,
    isMePortionAccepted,
    isMe,
    representantes,
    representantePadrao: (representantes.find((r) => r.selected) || representantes[0] || null)?.value || null,
    itens, // [{ index, idBatchItem }]
    documentos, // [{ index, label, obrigatorio, anexado, fkParticipantDocument, idProcessDocument, ... }]
    finalUrl: resp.finalUrl,
  };
}

// ─── montagem do payload ────────────────────────────────────────────────────

// Decimal pt-BR com 2 casas. Aceita number (6100, 416.67) ou string já BR.
function formatValorBR(v) {
  if (typeof v === 'string') {
    // já em formato BR? normaliza milhares/centavos
    const limpo = v.trim();
    if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(limpo) || /^\d+,\d{1,2}$/.test(limpo)) {
      const n = parseFloat(limpo.replace(/\./g, '').replace(',', '.'));
      return n.toFixed(2).replace('.', ',');
    }
    const n = parseFloat(limpo.replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${v}`);
    return n.toFixed(2).replace('.', ',');
  }
  if (!Number.isFinite(v)) throw new Error(`Valor inválido: ${v}`);
  return Number(v).toFixed(2).replace('.', ',');
}

// jQuery $.serialize encoda chave e valor com encodeURIComponent e usa '+' p/
// espaço. As chaves têm colchetes/ponto literais (model-binding ASP.NET).
function encodeForm(pairs) {
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%20/g, '+')}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');
}

// dados: { participantId, processId, isMePortionAccepted, isMe, fkRepresentant, itens:[{idBatchItem, valor}] }
function montarPayload(dados) {
  const pairs = [];
  pairs.push(['participantId', dados.participantId]);
  pairs.push(['IsMePortionAccepted', dados.isMePortionAccepted ?? 'False']);
  pairs.push(['IsMe', dados.isMe ?? 'True']);
  if (dados.fkRepresentant) pairs.push(['fkRepresentant', dados.fkRepresentant]);
  pairs.push(['processId', dados.processId]);
  dados.itens.forEach((it, i) => {
    pairs.push([`proposalItems[${i}].idBatchItem`, it.idBatchItem]);
    pairs.push([`proposalItems[${i}].ProposalValue`, formatValorBR(it.valor)]);
  });
  // Documentos exigidos: o browser serializa esses campos (form="jsonForm1"); antes
  // eram omitidos → portal recusava com "documentos obrigatórios".
  (dados.documentos || []).forEach((d) => {
    pairs.push([`document[${d.index}].fkParticipantDocument`, d.fkParticipantDocument || '']);
    pairs.push([`document[${d.index}].idProcessDocument`, d.idProcessDocument || '']);
  });
  return encodeForm(pairs);
}

// ─── persistência / idempotência ────────────────────────────────────────────

function upsertProposta(db, row) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id, criadoEm, enviada FROM bll_propostas WHERE processId = ?').get(row.processId);
  if (existing) {
    db.prepare(`UPDATE bll_propostas SET
        compraId=?, participantId=?, fkRepresentant=?, isMe=?, itensJson=?, payloadJson=?,
        dryRun=?, enviada=?, status=?, httpStatus=?, respostaResumo=?, comprovanteUrl=?, atualizadoEm=?
      WHERE processId=?`).run(
      row.compraId, row.participantId, row.fkRepresentant, row.isMe ? 1 : 0, row.itensJson, row.payloadJson,
      row.dryRun ? 1 : 0, row.enviada ? 1 : 0, row.status, row.httpStatus, row.respostaResumo, row.comprovanteUrl,
      now, row.processId
    );
    return { id: existing.id, criadoEm: existing.criadoEm };
  }
  const info = db.prepare(`INSERT INTO bll_propostas
      (compraId, processId, participantId, fkRepresentant, isMe, itensJson, payloadJson,
       dryRun, enviada, status, httpStatus, respostaResumo, comprovanteUrl, criadoEm, atualizadoEm)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.compraId, row.processId, row.participantId, row.fkRepresentant, row.isMe ? 1 : 0, row.itensJson, row.payloadJson,
    row.dryRun ? 1 : 0, row.enviada ? 1 : 0, row.status, row.httpStatus, row.respostaResumo, row.comprovanteUrl, now, now
  );
  return { id: info.lastInsertRowid, criadoEm: now };
}

function extrairComprovante(html) {
  const m = /https?:\/\/[^"'\s]*ReportPage\.aspx[^"'\s]*/i.exec(html || '');
  return m ? m[0] : null;
}

// Extrai a mensagem de erro do envelope AJAX do portal ({modal:'error', html:'...'}).
function extrairMensagemErro(body) {
  try {
    const env = JSON.parse(body || '');
    if (env && String(env.modal || '').toLowerCase() === 'error') {
      const txt = String(env.html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
        .replace(/&[a-z]+;/gi, ' ')
        .replace(/\s+/g, ' ').trim();
      return txt.slice(0, 300) || 'o portal retornou erro';
    }
  } catch (e) {}
  return null;
}

// SUCESSO só se o portal confirmar. O BLL responde AJAX { html, modal, Link }:
// modal:'error' = FALHA explícita (ex.: documentos obrigatórios); Link→DataResult = ok.
function pareceSucesso(resp) {
  const body = resp.body || '';
  const finalUrl = resp.finalUrl || '';
  let env = null;
  try { env = JSON.parse(body); } catch (e) {}
  if (env && typeof env === 'object') {
    if (String(env.modal || '').toLowerCase() === 'error') return false;
    const link = String(env.Link || env.link || '');
    if (/DataResult/i.test(link) || /Proposta\s*Salva/i.test(decodeURIComponent(link))) return true;
  }
  return (
    /DataResult/i.test(finalUrl) ||
    /Proposta\s*Salva/i.test(decodeURIComponent(finalUrl)) ||
    /Proposta\s*Salva/i.test(body)   // 'sucesso' removido: dava falso-positivo no HTML de erro
  );
}

// ─── envio ───────────────────────────────────────────────────────────────────

// opts:
//   urlOuToken      (obrigatório)  — página /Proposal/Proposal ou token param1
//   valores         (obrigatório)  — array alinhado aos itens [v0, v1, ...]
//                                    OU objeto { [index]: valor } OU
//                                    { [idBatchItem]: valor }
//   isMe            (default true)  — declara ME/EPP
//   fkRepresentant  (opcional)      — sobrescreve o representante padrão da página
//   compraId        (opcional)      — 'bll:<processo>' p/ rastreio
//   dryRun          (default TRUE)  — true: só monta/persiste prévia; false: POSTa de verdade
//   force           (default false) — reenvia mesmo se já 'enviada'
async function enviarProposta(db, opts = {}) {
  const {
    urlOuToken,
    valores,
    isMe = true,
    fkRepresentant = null,
    compraId = null,
    dryRun = true,
    force = false,
  } = opts;

  if (!urlOuToken) throw new Error('urlOuToken obrigatório');
  if (valores == null) throw new Error('valores obrigatório (array ou objeto índice→valor)');

  const pagina = await carregarItens(db, urlOuToken);

  // Idempotência: se já enviada (real) e não forçado, devolve o registro.
  const prev = db.prepare('SELECT * FROM bll_propostas WHERE processId = ?').get(pagina.processId);
  if (prev && prev.enviada && !force) {
    return {
      ok: true,
      jaEnviada: true,
      dryRun: false,
      processId: pagina.processId,
      registro: prev,
      mensagem: 'Proposta já enviada anteriormente (idempotência). Use force:true pra reenviar.',
    };
  }

  // Resolve valor por item.
  const itens = pagina.itens.map((it) => {
    let valor;
    if (Array.isArray(valores)) valor = valores[it.index];
    else if (valores && typeof valores === 'object') {
      valor = valores[it.index] ?? valores[String(it.index)] ?? valores[it.idBatchItem];
    }
    if (valor == null) {
      throw new Error(`Valor ausente para item index=${it.index} (idBatchItem=${it.idBatchItem}).`);
    }
    return { idBatchItem: it.idBatchItem, valor, valorFormatado: formatValorBR(valor), index: it.index };
  });

  const dados = {
    participantId: pagina.participantId,
    processId: pagina.processId,
    isMePortionAccepted: pagina.isMePortionAccepted,
    isMe: isMe ? 'True' : 'False',
    fkRepresentant: fkRepresentant || pagina.representantePadrao,
    itens,
    documentos: pagina.documentos,
  };
  const payload = montarPayload(dados);

  // Documentos obrigatórios sem arquivo anexado → o portal recusa. Detecta antes.
  const docsFaltando = (pagina.documentos || []).filter((d) => d.obrigatorio && !d.anexado).map((d) => d.label);

  const baseRow = {
    compraId,
    processId: pagina.processId,
    participantId: pagina.participantId,
    fkRepresentant: dados.fkRepresentant,
    isMe,
    itensJson: JSON.stringify(itens.map((i) => ({ idBatchItem: i.idBatchItem, valor: i.valorFormatado }))),
    payloadJson: payload,
    comprovanteUrl: null,
  };

  if (dryRun) {
    upsertProposta(db, { ...baseRow, dryRun: true, enviada: false, status: 'previa', httpStatus: null, respostaResumo: 'dryRun: payload montado, não enviado' });
    return {
      ok: true,
      dryRun: true,
      processId: pagina.processId,
      participantId: pagina.participantId,
      fkRepresentant: dados.fkRepresentant,
      representantes: pagina.representantes,
      itens: itens.map((i) => ({ index: i.index, idBatchItem: i.idBatchItem, valor: i.valorFormatado })),
      documentos: pagina.documentos,
      docsFaltando,
      payload,
      mensagem: 'dryRun=true — nada foi enviado. Para enviar de fato, chame com dryRun:false.',
    };
  }

  // Guard: não POSTa se faltar documento obrigatório (evita a recusa do portal).
  if (docsFaltando.length) {
    const erro = new Error(`Faltam documentos obrigatórios (anexe no portal ou aguarde a função de upload): ${docsFaltando.join('; ')}`);
    erro.code = 'BLL_PROPOSTA_DOCS_FALTANDO';
    erro.docsFaltando = docsFaltando;
    throw erro;
  }

  // POST real
  const resp = await bllPost(db, PROPOSAL_PATH, payload, {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  });
  const sucesso = resp.status >= 200 && resp.status < 400 && pareceSucesso(resp);
  const comprovanteUrl = extrairComprovante(resp.body);
  const msgPortal = extrairMensagemErro(resp.body);
  const resumo = (msgPortal || (resp.body || '').replace(/\s+/g, ' ')).slice(0, 500);

  upsertProposta(db, {
    ...baseRow,
    dryRun: false,
    enviada: sucesso,
    status: sucesso ? 'enviada' : 'erro',
    httpStatus: resp.status,
    respostaResumo: resumo,
    comprovanteUrl,
  });

  if (!sucesso) {
    const erro = new Error(msgPortal ? `O BLL recusou a proposta: ${msgPortal}` : `POST /Proposal/Proposal não confirmou sucesso (HTTP ${resp.status}).`);
    erro.code = 'BLL_PROPOSTA_FALHA';
    erro.httpStatus = resp.status;
    erro.respostaResumo = resumo;
    throw erro;
  }

  return {
    ok: true,
    dryRun: false,
    enviada: true,
    processId: pagina.processId,
    httpStatus: resp.status,
    comprovanteUrl,
    finalUrl: resp.finalUrl,
    itens: itens.map((i) => ({ index: i.index, idBatchItem: i.idBatchItem, valor: i.valorFormatado })),
  };
}

module.exports = {
  carregarItens,
  montarPayload,
  formatValorBR,
  enviarProposta,
  // expostos pra teste/diagnóstico:
  _parse: { allInputs, inputValueByName, parseProposalItems, parseRepresentantes, parseIsMe },
  _resp: { pareceSucesso, extrairComprovante, extrairMensagemErro },
};
