// pcp-proposta.js
//
// Registro de PROPOSTA no Portal de Compras Públicas (operacao.portaldecompraspublicas.com.br),
// server-side. Diferente de BNC/BLL (POST único do #jsonForm1): o PCP é um
// wizard multi-step (ASP/IIS clássico "PortalMaker"). Protocolo em memory
// project_pcp_proposta_protocol.
//
//   PASSO 1 (Declarações):  POST /4/Pregoes/RegistroProposta/   (ttPASSO=2)
//     → só depois disso o portal renderiza a tabela de itens.
//   PASSO 2 (Valor/item):   POST /4/Pregoes/RegistroProposta/RegistroItem/  (1 por item, AJAX)
//
// Auth é 100% server-side via pcp-client (cookie IIS, sem captcha).
//
// SEGURANÇA: enviarProposta() roda dryRun=true por padrão — monta os payloads
// e persiste a prévia sem tocar o portal. Só com dryRun:false é que POSTa
// (declarações + itens). Idempotente por chave (não reenvia se já 'enviada').

'use strict';

const { fetchPcpHtml, postPcpForm } = require('./pcp-client');
const { migratePcpSchema } = require('./pcp-schema');

const OPERACAO_BASE = 'https://operacao.portaldecompraspublicas.com.br';
const RP_PATH = '/4/Pregoes/RegistroProposta/';
const RI_PATH = '/4/Pregoes/RegistroProposta/RegistroItem/';
const CD_PATH = '/4/Pregoes/RegistroProposta/CriteriosDesempate/';

// ─── parsing de HTML (regex, como pcp-client/bnc-proposta) ──────────────────

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    const key = m[1].toLowerCase();
    if (key in attrs) continue; // duplicado → o 1º vence (igual browser)
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

function textareaValue(html, name) {
  const re = new RegExp('<textarea\\b[^>]*name\\s*=\\s*["\']?' + name + '["\']?[^>]*>([\\s\\S]*?)</textarea>', 'i');
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Chave (ttCD_CHAVE) a partir de: número puro, URL da tela, ou querystring.
function chaveDeUrl(urlOuChave) {
  const s = String(urlOuChave || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = /ttCD_CHAVE=(\d+)/i.exec(s);
  if (m) return m[1];
  throw new Error('Não foi possível extrair ttCD_CHAVE de: ' + s);
}

function rpUrl(chave) {
  return `${OPERACAO_BASE}${RP_PATH}?ttCD_CHAVE=${encodeURIComponent(chave)}`;
}

// Declarações da página (PASSO 1): nomes dos checkboxes + participação + moeda.
function parseDeclaracoes(html) {
  const checkboxes = [];
  let m;
  const re = /<input\b[^>]*name\s*=\s*["']?(ckDeclaracao\d+)["']?[^>]*>/gi;
  let marcados = 0;
  while ((m = re.exec(html)) !== null) {
    checkboxes.push({ name: m[1] });
    if (/\bchecked\b/i.test(m[0])) marcados += 1;
  }

  const tipoParticipacao = (allInputs(html).find((a) => (a.name || '').toLowerCase() === 'slcd_tipo_participacao') || {}).value ?? '';
  const moeda = (allInputs(html).find((a) => (a.name || '').toLowerCase() === 'slcd_moeda') || {}).value ?? '1';
  const prazoAtual = (allInputs(html).find((a) => (a.name || '').toLowerCase() === 'ttprazo_validade') || {}).value ?? '';
  // radio EPP marcado (1=Sim, 2=Não), se houver
  let eppAtual = null;
  const reR = /<input\b[^>]*name\s*=\s*["']?ttCD_BOLEANO_D_EPP["']?[^>]*>/gi;
  while ((m = reR.exec(html)) !== null) { if (/\bchecked\b/i.test(m[0])) eppAtual = parseAttrs(m[0]).value; }

  return {
    checkboxes: checkboxes.map((c) => c.name),
    temFormDeclaracoes: checkboxes.length > 0,
    // declarações já salvas quando TODAS vêm marcadas (o portal mantém o form visível
    // e preenchido depois de gravar) — evita re-postar em loop.
    marcadas: checkboxes.length > 0 && marcados === checkboxes.length,
    tipoParticipacao,
    moeda,
    prazoAtual,
    eppAtual,
  };
}

// Etapa intermediária "Informações Complementares" = critérios de desempate
// (form POST /4/Pregoes/RegistroProposta/CriteriosDesempate/). Em alguns editais
// ela aparece entre as declarações e os itens e trava a proposta até ser salva.
// Radios rd-desempate-N (1=Sim, 2=Não); mapeamos cada um pelo texto da declaração.
function parseCriteriosDesempate(html) {
  if (!/CriteriosDesempate/i.test(html)) return { presente: false, criterios: [] };
  const gStart = html.indexOf('id="GrupoComplementar"');
  const seg = gStart >= 0 ? html.slice(gStart, html.indexOf('</form>', gStart) + 7) : html;
  const nomes = [...new Set([...seg.matchAll(/name="(rd-desempate-\d+)"/gi)].map((x) => x[1]))];
  const criterios = nomes.map((name) => {
    const pos = seg.indexOf(`name="${name}"`);
    const ps = [...seg.slice(0, pos).matchAll(/<p class="formText"[^>]*>([\s\S]*?)<\/p>/gi)];
    return { name, label: ps.length ? decodeEntities(ps[ps.length - 1][1]) : '' };
  });
  return { presente: criterios.length > 0, criterios };
}

// Itens (PASSO 2): 1 form .formInsideTable por item + a linha de exibição
// correspondente (descrição/referência/quantidade/gravado), pareadas por ordem.
function parseItens(html) {
  const tbMatch = html.match(/<table[^>]*id="searchTableSorter"[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (!tbMatch) return [];
  const tbody = tbMatch[1];

  const formBlocks = [...tbody.matchAll(/<form\b[^>]*formInsideTable[\s\S]*?<\/form>/gi)].map((x) => x[0]);
  if (!formBlocks.length) return [];

  const allRows = tbody.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const displayRows = allRows.filter((r) => !/insideTableForm|formInsideTable/i.test(r));

  return formBlocks.map((form, index) => {
    const inputs = allInputs(form);
    const byName = (n) => (inputs.find((a) => (a.name || '').toLowerCase() === n.toLowerCase()) || {}).value ?? '';
    const idItem = byName('slCD_ITEM_LICITACAO');
    const disp = displayRows[index] || '';
    const tds = [...disp.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => decodeEntities(x[1]));
    // descrição: título do moreTextLink (completo) ou o texto do <p id="produtoTexto...">
    const descTitle = (disp.match(/class="moreTextLink"[^>]*title="([^"]+)"/i) || [])[1];
    const descP = (disp.match(/<p[^>]*id="produtoTexto\d+"[^>]*>([\s\S]*?)<\/p>/i) || [])[1];
    const descricao = decodeEntities(descTitle || descP || tds[1] || '');
    const valorReferencia = tds[2] || '';
    const quantidade = byName('ttQUANTIDADE') || tds[3] || '';
    const unidade = tds[4] || '';
    return {
      index,
      idItem,
      slLicitacao: byName('slCD_LICITACAO'),
      tipoJulgamento: byName('slCD_TIPO_JULGAMENTO_LICITACAO') || '1',
      usuarioAtivo: byName('ttUsuarioAtivo'),
      quantidade,
      valorUnitario: byName('ttVALOR_UNITARIO'),
      valorTotal: byName('ttVALOR_TOTAL'),
      marca: byName('ttMARCA'),
      fabricante: byName('ttFABRICANTE'),
      detalhe: textareaValue(form, 'ttDETALHE'),
      descricao,
      valorReferencia,
      unidade,
      gravado: /\bpropostaOK\b/i.test(disp),
    };
  });
}

// ─── formatação pt-BR ────────────────────────────────────────────────────────

// "4.500,00" → 4500 ; 4500.5 → 4500.5
function parseValorBR(v) {
  if (typeof v === 'number') return v;
  // remove símbolo de moeda / espaços / letras ("R$ 4.500,00" → "4.500,00")
  let t = String(v == null ? '' : v).replace(/[^\d.,-]/g, '').trim();
  if (t === '') return NaN;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return parseFloat(t);
}

// número → "4.500,00" (ponto de milhar + vírgula decimal, 2 casas)
function formatValorBR(v) {
  const n = parseValorBR(v);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${v}`);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Valor total conforme tipo de julgamento (mesma regra do JS do portal).
function calcularTotal(valorUnitario, quantidade, tipoJulgamento, valorReferencia) {
  const unit = parseValorBR(valorUnitario);
  if (String(tipoJulgamento) === '3') { // maior desconto: % sobre a referência
    const ref = parseValorBR(valorReferencia);
    return (unit / 100) * (Number.isFinite(ref) ? ref : 0);
  }
  const qtd = parseValorBR(quantidade);
  return unit * (Number.isFinite(qtd) ? qtd : 0);
}

// jQuery $.serialize: encodeURIComponent + '+' pra espaço.
function encodeForm(pairs) {
  return pairs
    .map(([k, v]) => `${encodeURIComponent(k).replace(/%20/g, '+')}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');
}

// ─── payloads ────────────────────────────────────────────────────────────────

// PASSO 1 — declarações. epp: true→1(Sim)/false→2(Não). validade em dias.
function montarPayloadDeclaracoes(chave, decl, { epp, validade }) {
  const pairs = [];
  pairs.push(['ttCD_CHAVE', chave]);
  pairs.push(['ttPASSO', '2']);
  pairs.push(['slCD_TIPO_PARTICIPACAO', decl.tipoParticipacao ?? '']);
  for (const nome of decl.checkboxes) pairs.push([nome, 'on']); // todas marcadas
  pairs.push(['ttCD_BOLEANO_D_EPP', epp ? '1' : '2']);
  pairs.push(['slCD_MOEDA', decl.moeda ?? '1']);
  pairs.push(['ttPRAZO_VALIDADE', String(validade)]);
  pairs.push(['btGravar', 'Salvar Declarações']);
  return encodeForm(pairs);
}

// Critérios de desempate. empresa: { equidadeGenero, integridade } vêm do cadastro
// (Minha Empresa). "Empresa brasileira" = Sim (fato p/ CNPJ). Demais = Não (não
// declara preferência não comprovada). Só afeta desempate em empate exato.
function montarPayloadDesempate(chave, criterios, empresa = {}) {
  const pairs = [['ttCD_CHAVE', chave]];
  const escolhas = [];
  for (const c of criterios) {
    const l = (c.label || '').toLowerCase();
    let sim = false;
    if (/equidade entre homens e mulheres/.test(l)) sim = !!empresa.equidadeGenero;
    else if (/integridade/.test(l)) sim = !!empresa.integridade;
    else if (/empresa brasileira/.test(l)) sim = true;
    pairs.push([c.name, sim ? '1' : '2']);
    escolhas.push({ label: c.label, sim });
  }
  pairs.push(['btGravar', 'Salvar Informações']);
  return { form: encodeForm(pairs), escolhas };
}

// PASSO 2 — um item. vals: { valorUnitario, marca, fabricante, detalhe }
function montarPayloadItem(item, vals) {
  const valorUnitario = formatValorBR(vals.valorUnitario);
  const total = calcularTotal(valorUnitario, item.quantidade, item.tipoJulgamento, item.valorReferencia);
  const pairs = [
    ['slCD_ITEM_LICITACAO', item.idItem],
    ['slCD_LICITACAO', item.slLicitacao],
    ['slCD_TIPO_JULGAMENTO_LICITACAO', item.tipoJulgamento],
    ['ttUsuarioAtivo', item.usuarioAtivo],
    ['ttVALOR_UNITARIO', valorUnitario],
    ['ttQUANTIDADE', item.quantidade],
    ['ttVALOR_TOTAL', formatValorBR(total)],
    ['ttMARCA', (vals.marca && String(vals.marca).trim()) || 'N/C'],
    ['ttFABRICANTE', (vals.fabricante && String(vals.fabricante).trim()) || 'N/C'],
    ['ttDETALHE', (vals.detalhe && String(vals.detalhe).trim()) || item.descricao || 'N/C'],
    ['btEnviar', 'Registrar Item'],
  ];
  return encodeForm(pairs);
}

// ─── carregar a tela (read-only) ─────────────────────────────────────────────

async function carregarItens(db, chaveOuUrl) {
  const chave = chaveDeUrl(chaveOuUrl);
  const resp = await fetchPcpHtml(db, rpUrl(chave));
  const html = resp.body || '';
  if (!/RegistroProposta/i.test(resp.finalUrl)) {
    const e = new Error('Redirect inesperado ao abrir a proposta PCP: ' + resp.finalUrl);
    e.code = 'PCP_PROPOSTA_REDIRECT';
    throw e;
  }
  const decl = parseDeclaracoes(html);
  const criterios = parseCriteriosDesempate(html);
  const itens = parseItens(html);
  // Contexto do processo (número/órgão/situação) — bloco dataInfoBlock3.
  const ctx = {};
  const nums = [...html.matchAll(/<p><b>([^<:]+):<\/b>([^<]*)<\/p>/gi)];
  for (const [, k, v] of nums) ctx[decodeEntities(k)] = decodeEntities(v);

  return {
    chave,
    declaracoesSalvas: itens.length > 0, // o portal só mostra itens após declarar (+ desempate)
    declaracoes: decl,
    criterios,
    itens,
    contexto: ctx,
    finalUrl: resp.finalUrl,
  };
}

// ─── persistência / idempotência ────────────────────────────────────────────

function upsertProposta(db, row) {
  const now = new Date().toISOString();
  const ex = db.prepare('SELECT id, criado_em FROM pcp_propostas WHERE chave_id = ?').get(row.chave);
  if (ex) {
    db.prepare(`UPDATE pcp_propostas SET
        compra_id=?, pncp=?, epp=?, validade=?, itens_json=?, payload_json=?,
        dry_run=?, enviada=?, status=?, http_status=?, resposta_resumo=?, atualizado_em=?
      WHERE chave_id=?`).run(
      row.compraId, row.pncp, row.epp ? 1 : 0, row.validade, row.itensJson, row.payloadJson,
      row.dryRun ? 1 : 0, row.enviada ? 1 : 0, row.status, row.httpStatus, row.respostaResumo, now, row.chave);
    return { id: ex.id, criadoEm: ex.criado_em };
  }
  const info = db.prepare(`INSERT INTO pcp_propostas
      (chave_id, compra_id, pncp, epp, validade, itens_json, payload_json,
       dry_run, enviada, status, http_status, resposta_resumo, criado_em, atualizado_em)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.chave, row.compraId, row.pncp, row.epp ? 1 : 0, row.validade, row.itensJson, row.payloadJson,
    row.dryRun ? 1 : 0, row.enviada ? 1 : 0, row.status, row.httpStatus, row.respostaResumo, now, now);
  return { id: info.lastInsertRowid, criadoEm: now };
}

// Mensagem de alerta do envelope AJAX do PortalMaker: { iconeOk, mensagem, alerta }.
function envelopeAjax(body) {
  const m = /\{\s*"iconeOk"[\s\S]*?\}\s*$/.exec(String(body || '').trim());
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// ─── envio ────────────────────────────────────────────────────────────────────

// opts:
//   chaveOuUrl (obrigatório) — nº da chave, URL da tela ou querystring com ttCD_CHAVE
//   itens      (obrigatório) — array alinhado por índice: [{ valorUnitario, marca, fabricante, detalhe }]
//   epp        (default false)— declara ME/EPP (Sim=true / Não=false)
//   validade   (default 60)   — validade da proposta em dias
//   pncp, compraId (opcional) — rastreio
//   dryRun     (default TRUE) — true: monta/persiste prévia; false: POSTa de verdade
//   force      (default false)— reenvia mesmo se já 'enviada'
async function enviarProposta(db, opts = {}) {
  const {
    chaveOuUrl, itens: valoresItens, epp = false, validade = 60,
    empresa = {}, pncp = null, compraId = null, dryRun = true, force = false,
  } = opts;

  if (!chaveOuUrl) throw new Error('chaveOuUrl obrigatório');
  if (!Array.isArray(valoresItens) || !valoresItens.length) throw new Error('itens obrigatório (array por índice)');

  // Garante a tabela no DB do tenant (o migrate do boot roda só no db default;
  // per-tenant o monitor migra no ciclo dele, que pode não ter rodado ainda).
  try { migratePcpSchema(db); } catch (e) {}

  const chave = chaveDeUrl(chaveOuUrl);

  // Idempotência.
  const prev = db.prepare('SELECT * FROM pcp_propostas WHERE chave_id = ?').get(chave);
  if (prev && prev.enviada && !force && !dryRun) {
    return { ok: true, jaEnviada: true, dryRun: false, chave, registro: prev,
      mensagem: 'Proposta já enviada anteriormente (idempotência). Use force:true pra reenviar.' };
  }

  let pagina = await carregarItens(db, chave);

  // ── dryRun: monta os payloads sem tocar o portal ──
  if (dryRun) {
    const itensPreview = valoresItens.map((v, i) => {
      const it = pagina.itens[i] || null;
      const total = it ? calcularTotal(v.valorUnitario, it.quantidade, it.tipoJulgamento, it.valorReferencia) : null;
      return {
        index: i,
        idItem: it ? it.idItem : null,
        valorUnitario: formatValorBR(v.valorUnitario),
        valorTotal: total != null ? formatValorBR(total) : null,
        marca: (v.marca && String(v.marca).trim()) || 'N/C',
        fabricante: (v.fabricante && String(v.fabricante).trim()) || 'N/C',
        detalhe: (v.detalhe && String(v.detalhe).trim()) || (it && it.descricao) || 'N/C',
      };
    });
    const payloadDecl = montarPayloadDeclaracoes(chave, pagina.declaracoes, { epp, validade });
    upsertProposta(db, {
      chave, compraId, pncp, epp, validade,
      itensJson: JSON.stringify(itensPreview), payloadJson: payloadDecl,
      dryRun: true, enviada: false, status: 'previa', httpStatus: null,
      respostaResumo: 'dryRun: payloads montados, não enviados',
    });
    return {
      ok: true, dryRun: true, chave,
      declaracoesSalvas: pagina.declaracoesSalvas,
      epp, validade,
      declaracoes: pagina.declaracoes.checkboxes.length,
      itens: itensPreview,
      contexto: pagina.contexto,
      payloadDeclaracoes: payloadDecl,
      mensagem: 'dryRun=true — nada foi enviado. Para enviar de fato, chame com dryRun:false (confirmar:true na rota).',
    };
  }

  // ── envio real ──
  // Avança os passos do wizard até os itens aparecerem. A ordem varia por edital:
  //   declarações (PASSO 1) → [critérios de desempate, em alguns editais] → itens.
  // Cada passo é postado só uma vez; o loop relê a página e segue pro próximo.
  const desempateEscolhas = [];
  let guard = 0;
  while (!pagina.itens.length && guard++ < 5) {
    if (pagina.declaracoes.temFormDeclaracoes && !pagina.declaracoes.marcadas) {
      await postPcpForm(db, `${OPERACAO_BASE}${RP_PATH}`, montarPayloadDeclaracoes(chave, pagina.declaracoes, { epp, validade }));
    } else if (pagina.criterios && pagina.criterios.presente) {
      const { form, escolhas } = montarPayloadDesempate(chave, pagina.criterios.criterios, empresa);
      await postPcpForm(db, `${OPERACAO_BASE}${CD_PATH}`, form);
      desempateEscolhas.push(...escolhas);
    } else {
      break; // não há passo conhecido pra avançar — cai no throw abaixo
    }
    pagina = await carregarItens(db, chave);
  }
  if (!pagina.itens.length) {
    const e = new Error('O PCP não liberou os itens da proposta (verifique validade/EPP, critérios de desempate ou se o processo aceita proposta).');
    e.code = 'PCP_PROPOSTA_DECL_FALHOU';
    throw e;
  }

  // Alinhamento por posição (igual BNC): a UI e o PCP listam na mesma ordem.
  if (valoresItens.length !== pagina.itens.length) {
    const e = new Error(`Quantidade de itens não confere: enviei ${valoresItens.length}, o PCP tem ${pagina.itens.length}. Recarregue a tela.`);
    e.code = 'PCP_PROPOSTA_ITENS_DESALINHADOS';
    throw e;
  }

  // PASSO 2: um POST por item.
  const resultadosItens = [];
  for (let i = 0; i < pagina.itens.length; i++) {
    const it = pagina.itens[i];
    const payload = montarPayloadItem(it, valoresItens[i]);
    const resp = await postPcpForm(db, `${OPERACAO_BASE}${RI_PATH}`, payload, {
      extraHeaders: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, */*; q=0.01' },
    });
    const env = envelopeAjax(resp.body);
    resultadosItens.push({
      index: i, idItem: it.idItem, httpStatus: resp.status,
      alerta: env ? decodeEntities(env.alerta || '') : '',
      mensagem: env ? decodeEntities(env.mensagem || '') : '',
    });
  }

  // Verificação robusta: re-GET e confere quantas linhas ficaram 'propostaOK'.
  const conf = await carregarItens(db, chave);
  const gravados = conf.itens.filter((x) => x.gravado).length;
  const total = conf.itens.length;
  const enviada = gravados === total && total > 0;

  const alertas = resultadosItens.map((r) => r.alerta).filter(Boolean);
  const resumo = enviada
    ? `${gravados}/${total} itens gravados`
    : (alertas[0] || `apenas ${gravados}/${total} itens gravados`);

  const itensJson = JSON.stringify(conf.itens.map((x) => ({ index: x.index, idItem: x.idItem, valorUnitario: x.valorUnitario, gravado: x.gravado })));
  upsertProposta(db, {
    chave, compraId, pncp, epp, validade,
    itensJson, payloadJson: '(enviado)',
    dryRun: false, enviada, status: enviada ? 'enviada' : 'erro',
    httpStatus: resultadosItens.length ? resultadosItens[resultadosItens.length - 1].httpStatus : null,
    respostaResumo: resumo.slice(0, 500),
  });

  if (!enviada) {
    const e = new Error('Proposta PCP não confirmada: ' + resumo);
    e.code = 'PCP_PROPOSTA_FALHA';
    e.detalhe = { gravados, total, resultadosItens };
    throw e;
  }

  return {
    ok: true, dryRun: false, enviada: true, chave,
    gravados, total,
    criteriosDesempate: desempateEscolhas.length ? desempateEscolhas : undefined,
    itens: conf.itens.map((x) => ({ index: x.index, idItem: x.idItem, valor: x.valorUnitario, gravado: x.gravado })),
  };
}

module.exports = {
  carregarItens,
  enviarProposta,
  // expostos p/ teste/diagnóstico
  chaveDeUrl,
  formatValorBR,
  parseValorBR,
  calcularTotal,
  _parse: { parseDeclaracoes, parseCriteriosDesempate, parseItens, allInputs, textareaValue },
  _payload: { montarPayloadDeclaracoes, montarPayloadDesempate, montarPayloadItem, envelopeAjax },
};
