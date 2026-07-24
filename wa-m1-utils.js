/**
 * wa-m1-utils.js — motor de geração/validação da M1 de campanha WhatsApp.
 * Porta CommonJS do m1-utils.js do status-bot (campaigns), pra reuso no liciteagora
 * multi-tenant. Sem dependências externas (só Intl). O caller injeta o LLM
 * (chamarChatLLM do chat-ia.js) via gerarM1({..., callLLM}).
 */
'use strict';

const TZ_PADRAO = 'America/Belem';
const DIACRITICOS = /[̀-ͯ]/g;
const PARTICULAS = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du']);

function titleCase(nome) {
  if (!nome) return '';
  return String(nome).trim().toLocaleLowerCase('pt-BR').split(/\s+/)
    .map((p, i) => {
      if (i > 0 && PARTICULAS.has(p)) return p;
      return p.split('-').map(s => (s ? s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1) : s)).join('-');
    }).join(' ');
}

function primeiroNome(nome) {
  return titleCase(nome).split(' ').filter(Boolean)[0] || '';
}

function agoraLocal(tz = TZ_PADRAO, data = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
      .formatToParts(data).map(p => [p.type, p.value])
  );
  return { hora: parseInt(partes.hour, 10) % 24 };
}

function saudacao(tz = TZ_PADRAO, data = new Date()) {
  const { hora } = agoraLocal(tz, data);
  if (hora < 12) return 'Bom dia';
  if (hora < 18) return 'Boa tarde';
  return 'Boa noite';
}

function localDate(ts, tz = TZ_PADRAO) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

function ensureOptOutTrailer(text) {
  const trailer = 'Responda PARAR para nao receber mais.';
  if (text.toLowerCase().includes('parar')) return text;
  return text.trimEnd() + '\n\n' + trailer;
}

// ===== Mapeamento de ramo (texto livre do CSV) -> chave de dores_por_ramo =====
// Espelha o MAPA_RAMO do prompt.js de referencia. Ordem importa: a 1a regra que casa
// vence (ex.: "distribuidora de bebidas" -> bebidas, nao atacado). Texto ja normalizado.
const RAMO_REGRAS = [
  ['bebidas', /bebida|distribuidora de bebida|deposito de bebida/],
  ['vestuario', /vestuario|roupa|confec|moda|boutique/],
  ['material de construcao', /material de constru|constru|ferragem|deposito/],
  ['alimentacao', /restaurante|lanchonete|pizzaria|alimenta|acai|padaria|bar e/],
  ['beleza', /salao|beleza|estetica|barbearia|cabeleireiro|manicure/],
  ['cosmeticos', /cosmetico|perfumaria|higiene pessoal/],
  // Desvio proposital do prompt.js: stems (mercad*, supermerc*, minimerc*) p/ pegar
  // "mercadinho"/"supermercado", que a regex original (mercado exato) deixava passar.
  ['mercado', /mercad|mercearia|supermerc|minimerc|conveniencia/],
  ['atacado', /atacad|distribuidora|representa/],
];

// Normaliza (acentos + caixa) e mapeia o ramo por regex para uma chave de dores_por_ramo.
// Fallback: 'generico' (ou a 1a chave nao-vazia se nao houver generico).
function chaveDoRamo(ramo, dores = {}) {
  const t = normalizar(ramo || '');
  if (t) {
    for (const [chave, re] of RAMO_REGRAS) {
      if (re.test(t) && Array.isArray(dores[chave]) && dores[chave].length) return chave;
    }
  }
  if (Array.isArray(dores.generico) && dores.generico.length) return 'generico';
  return Object.keys(dores).find(k => Array.isArray(dores[k]) && dores[k].length) || 'generico';
}

function sortear(arr) {
  if (!Array.isArray(arr) || !arr.length) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

// M1 dirigida por ramo: sorteio (dor + pergunta) no Node e injetados como valores FIXOS.
// O modelo so redige as frases de ligacao — saudacao, nome, ramo, dor e pergunta ja vem prontos.
function buildM1MessagesRamo(config, row) {
  const tz = config.timezone || TZ_PADRAO;
  const primeiro = primeiroNome(row.nome || row.name || row.cliente || '');
  const saud = saudacao(tz);
  const ramoTxt = String(row.ramo || row.segmento || row.setor || '').trim();
  const cidade = String(row.cidade || row.municipio || '').trim();
  const dores = config.dores_por_ramo || {};
  const ramoKey = chaveDoRamo(ramoTxt, dores);
  const dor = sortear(dores[ramoKey]);
  const pergunta = sortear(config.variantes_pergunta_final || []);

  const system = [
    config.persona || '',
    '',
    'REGRAS DE LINGUAGEM:',
    ...((config.linguagem || []).map(l => `- ${l}`)),
    '',
    'REGRAS DE ESTRUTURA:',
    ...((config.regras || []).map(r => `- ${r}`)),
    '',
    'EXEMPLOS DO QUE FAZER:',
    ...((config.exemplos_bons || []).map((e, i) => `[BOM ${i + 1}]\n${e}`)),
    '',
    'EXEMPLOS DO QUE NUNCA FAZER:',
    ...((config.exemplos_ruins || []).map(e => `- ${e}`)),
  ].join('\n');

  // Tudo resolvido no codigo. Nada para o modelo inventar: so as frases do meio.
  const user = [
    'Escreva a mensagem M1 para este contato.',
    '',
    `saudacao (use EXATAMENTE esta): ${saud}`,
    `primeiro_nome (use EXATAMENTE assim): ${primeiro || '(desconhecido)'}`,
    `ramo (use EXATAMENTE assim, nao reinterprete): ${ramoTxt || '(nao informado)'}`,
    `cidade: ${cidade || '(nao informada)'}`,
    '',
    'DOR A USAR (obrigatoria, nao substitua, nao invente outra):',
    `"${dor}"`,
    '',
    'PERGUNTA FINAL (use exatamente esta):',
    `"${pergunta}"`,
    '',
    'Formato de saida: apenas a mensagem, sem aspas, sem comentario.',
    'A primeira linha deve comecar com a saudacao e o primeiro nome.',
    'A ultima linha deve ser exatamente: Responda PARAR para nao receber mais.',
  ].join('\n');

  return {
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    contact: { primeiro, saudacao: saud, ramo: ramoTxt, cidade, ramoKey, dor, pergunta, ramoDriven: true },
  };
}

function buildM1Messages(config, row) {
  if (config && config.dores_por_ramo && Object.keys(config.dores_por_ramo).length) {
    return buildM1MessagesRamo(config, row);
  }
  const tz = config.timezone || TZ_PADRAO;
  const rawName = row.nome || row.name || row.cliente || '';
  const primeiro = primeiroNome(rawName);
  const saud = saudacao(tz);
  const extra = Object.entries(row)
    .filter(([k]) => !['nome', 'name', 'cliente', 'telefone', 'phone', 'fone', 'celular', 'whatsapp'].includes(k.toLowerCase()))
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const system = [
    config.persona || '', '', 'Briefing da oferta:', config.briefing || '', '',
    'Regras OBRIGATORIAS:', ...((config.regras || []).map(r => `- ${r}`)),
  ].join('\n');
  const user = [
    'Gere a mensagem para este contato:',
    `- Primeiro nome (use EXATAMENTE assim, nunca em CAIXA ALTA): ${primeiro || '(desconhecido)'}`,
    extra ? `Extras:\n${extra}` : '',
    '',
    `Se cumprimentar com saudacao de horario, use EXATAMENTE "${saud}". Nao invente outra (nao escreva "Boa noite" de manha).`,
    'Devolva SOMENTE o texto da mensagem, sem aspas ou explicacoes.',
  ].filter(Boolean).join('\n');
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], contact: { primeiro, saudacao: saud } };
}

function normalizar(s) { return String(s).normalize('NFD').replace(DIACRITICOS, '').toLowerCase(); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const SAUDACOES = ['bom dia', 'boa tarde', 'boa noite'];
const PITCH_TERMOS = ['liciteagora', 'erp', 'sistema completo', 'solucao', 'demo', 'apresenta', 'promocao'];
const OPTOUT_TXT = 'Responda PARAR para nao receber mais.';

// Lista fixa de termos proibidos (espelha o TERMOS_PROIBIDOS do prompt.js): jargao de
// varejo, nome do produto e aberturas batidas. Match por substring em texto normalizado.
const TERMOS_PROIBIDOS = [
  'arara', 'encalhad', 'giro de estoque', 'ruptura', 'ficha tecnica',
  'margem de contribuicao', 'ticket medio', 'markup', 'curva abc',
  'liciteagora', 'erp', 'sistema completo', 'solucao', 'otimizar',
  'centralizar', 'agendar', 'demo', 'apresenta', 'promocao',
  'voce sabia', 'sabia que', 'tudo bem?', 'espero que esteja bem',
];

// normaliza + tira pontuacao, pra checar a dor injetada ignorando virgula/ponto.
function achatar(s) { return normalizar(s).replace(/[.,;:!?]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Validacao da M1 dirigida por ramo (espelha validar() do prompt.js). Reprova => regenera.
function validarM1Ramo(msg, contact) {
  const erros = [];
  const t = normalizar(msg);
  // opt-out: exigido como ULTIMA linha, mas tolerante a acento/caixa — o modelo escreve
  // "para não receber mais." (com acento) e o OPTOUT_TXT canonico é sem acento.
  const corpo = msg.split('\n').filter(l => !normalizar(l).includes('responda parar')).join('\n').trim();

  if (!t.trim().endsWith(normalizar(OPTOUT_TXT))) erros.push('falta linha de opt-out exata');
  if (corpo.length > 480) erros.push(`corpo com ${corpo.length} chars (max 480)`);
  // A saudacao tem que ser a que o codigo calculou.
  if (contact.saudacao && !msg.startsWith(contact.saudacao)) erros.push(`saudacao errada: esperado "${contact.saudacao}"`);
  // Bug do slot de saudacao virar "Carlos, ...".
  if (/^carlos\s*,/i.test(msg)) erros.push('slot de saudacao preenchido com "Carlos"');
  // O nome tem que vir normalizado, nunca em caixa alta.
  if (contact.primeiro && contact.primeiro.length > 1 &&
      new RegExp(`\\b${escapeRe(contact.primeiro.toLocaleUpperCase('pt-BR'))}\\b`).test(msg)) {
    erros.push('nome em CAIXA ALTA');
  }
  // Uma pergunta. Uma.
  const perguntas = (corpo.match(/\?/g) || []).length;
  if (perguntas !== 1) erros.push(`${perguntas} perguntas (esperado 1)`);
  for (const termo of TERMOS_PROIBIDOS) if (t.includes(termo)) erros.push(`termo proibido: "${termo}"`);
  if ((t.match(/aqui e o carlos/g) || []).length > 1) erros.push('apresentacao duplicada');
  // Extra (nao esta no prompt.js): garante que a dor sorteada foi usada ao pé da letra —
  // "controle de estoque" nao esta na lista de proibidos e passaria batido sem isto.
  if (contact.dor && !achatar(msg).includes(achatar(contact.dor))) erros.push('dor injetada ausente/reescrita');
  return erros;
}

function validarM1(msg, contact, config = {}) {
  if (contact && contact.ramoDriven) return validarM1Ramo(msg, contact);
  const erros = [];
  const t = normalizar(msg);
  const maxChars = config.m1_max_chars ?? 600;
  if (msg.trim().length > maxChars) erros.push(`corpo com ${msg.trim().length} chars (max ${maxChars})`);
  const correta = normalizar(contact.saudacao || '');
  for (const s of SAUDACOES) {
    if (s !== correta && t.includes(s)) { erros.push(`saudacao errada: usou "${s}", agora e "${contact.saudacao}"`); break; }
  }
  if (/^\s*carlos\s*,/i.test(msg)) erros.push('comeca com "Carlos,"');
  if (contact.primeiro && contact.primeiro.length > 1) {
    const up = contact.primeiro.toLocaleUpperCase('pt-BR');
    if (up !== contact.primeiro && new RegExp(`\\b${escapeRe(up)}\\b`).test(msg)) erros.push('nome em CAIXA ALTA');
  }
  const maxPerguntas = config.m1_max_perguntas ?? 2;
  const perguntas = (msg.match(/\?/g) || []).length;
  if (perguntas > maxPerguntas) erros.push(`${perguntas} perguntas (max ${maxPerguntas})`);
  const banidos = [];
  if (config.m1_proibir_pitch) banidos.push(...PITCH_TERMOS);
  if (Array.isArray(config.m1_termos_proibidos)) banidos.push(...config.m1_termos_proibidos.map(x => normalizar(x)));
  for (const termo of banidos) if (termo && t.includes(termo)) erros.push(`termo proibido: "${termo}"`);
  return erros;
}

// callLLM(messages) -> Promise<{ ok, text, err }>
async function gerarM1({ config, row, callLLM, tentativas }) {
  const max = tentativas ?? config.m1_tentativas ?? 3;
  let ultimoTexto = null, ultimosErros = ['sem tentativa'], ultimoContact = {};
  for (let i = 1; i <= max; i++) {
    const { messages, contact } = buildM1Messages(config, row);
    ultimoContact = contact;
    const r = await callLLM(messages);
    if (!r || !r.ok) { ultimosErros = [`ia: ${r && r.err || 'falha'}`]; continue; }
    const erros = validarM1(r.text, contact, config);
    if (erros.length === 0) return { ok: true, text: r.text, tentativas: i, ramoKey: contact.ramoKey, dor: contact.dor, pergunta: contact.pergunta };
    ultimoTexto = r.text; ultimosErros = erros;
  }
  return { ok: false, text: ultimoTexto, erros: ultimosErros, tentativas: max, ramoKey: ultimoContact.ramoKey, dor: ultimoContact.dor, pergunta: ultimoContact.pergunta };
}

module.exports = { titleCase, primeiroNome, saudacao, agoraLocal, localDate, ensureOptOutTrailer, chaveDoRamo, buildM1Messages, validarM1, gerarM1 };
