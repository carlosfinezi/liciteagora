// ia-modelos.js (2026-09-17)
//
// Qual ID de modelo cada provider da cadeia de IA usa, por tenant.
//
// Antes disto os cinco IDs estavam cravados no analise-ia.js e no chat-ia.js,
// e o hardcode quebrou quatro vezes em quatro meses: qwen-3-235b (06/2026),
// zai-glm-4.7 e llama-3.3-70b (01/09) e gemini-2.5-flash (17/09, com 404
// "no longer available to new users" em chave nova e 429 na antiga). Toda vez
// o conserto passava por editar código e reiniciar produção, com o tenant
// parado no meio.
//
// Agora o ID mora na tabela `config` do tenant, na chave `<provider>_modelo`.
// Vazio ou ausente significa "use o padrão abaixo", e o padrão continua no
// código de propósito: um tenant que nunca abriu a tela segue funcionando.

'use strict';

const { createConfigHelpers } = require('./config-helpers');

// O que o código usa quando o tenant não escolheu nada.
//
// O do deepseek mudou aqui, e vale o registro: o `deepseek-chat` que estava
// cravado saiu do catálogo da conta, que em 17/09/2026 lista só
// `deepseek-flash` e `deepseek-v4-pro`. A troca NÃO pôde ser testada contra o
// provider, porque a conta responde 402 (sem saldo) em qualquer modelo. O que
// se sabe é que o ID antigo não existe mais.
const PADRAO = {
  cerebras:  'gpt-oss-120b',
  gemini:    'gemini-3.6-flash',
  deepseek:  'deepseek-flash',
  groq:      'openai/gpt-oss-120b',
  anthropic: 'claude-haiku-4-5-20251001',
};

const PROVIDERS = Object.keys(PADRAO);

// O ID viaja para dentro da URL no Gemini
// (.../v1beta/models/<id>:generateContent) e para o corpo JSON nos outros.
// Sem guarda, um valor com '..', uma barra a mais ou um '?' aponta a chamada
// para outro endpoint. A validação fica aqui porque este é o ponto em que o
// texto digitado na tela deixa de ser texto e vira parte de uma requisição.
const RE_MODELO = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

function modeloValido(id) {
  return typeof id === 'string' && RE_MODELO.test(id) && !id.includes('..');
}

function chaveConfig(provider) {
  return `${provider}_modelo`;
}

/** ID em uso por um provider neste tenant. Cai no padrão quando não há escolha. */
function resolverModelo(db, provider) {
  const padrao = PADRAO[provider];
  if (!padrao) throw new Error(`provider desconhecido: ${provider}`);
  try {
    const { getConfigValue } = createConfigHelpers(db);
    const salvo = getConfigValue(chaveConfig(provider));
    // Salvo mas inválido não derruba a análise: volta ao padrão, e o painel de
    // saúde mostra o erro real assim que a chamada acontecer.
    if (salvo && modeloValido(salvo)) return salvo;
  } catch (_) { /* tenant sem a tabela config ainda: o padrão serve */ }
  return padrao;
}

/** Os cinco de uma vez, no formato que o analise-ia.js consome. */
function resolverModelos(db) {
  const out = {};
  for (const p of PROVIDERS) out[p] = resolverModelo(db, p);
  return out;
}

// ==================== CATÁLOGO REAL DA CONTA ====================

// Cada provider expõe o próprio catálogo, e é ele que decide o que a chave
// alcança: a mesma conta lista modelos diferentes conforme a idade dela. Foi
// assim que se viu o `deepseek-chat` sumir. Listar não consome cota de geração.
async function listarModelos(provider, apiKey) {
  if (!PADRAO[provider]) throw new Error(`provider desconhecido: ${provider}`);
  if (!apiKey) return [];

  const ctrl = new AbortController();
  const prazo = setTimeout(() => ctrl.abort(), 15000);
  try {
    if (provider === 'gemini') {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      // Só o que sabe gerar conteúdo. A lista sai como o Google entrega,
      // inclusive os de imagem e áudio: filtrar por nome seria adivinhação, e
      // o botão "Testar agora" do painel acusa a escolha errada na hora.
      return (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''))
        .filter(Boolean);
    }

    if (provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/models', {
        signal: ctrl.signal,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return (j.data || []).map(m => m.id).filter(Boolean);
    }

    // Cerebras, Groq e DeepSeek falam o dialeto OpenAI em /models.
    const URL_OPENAI = {
      cerebras: 'https://api.cerebras.ai/v1/models',
      groq:     'https://api.groq.com/openai/v1/models',
      deepseek: 'https://api.deepseek.com/models',
    };
    const r = await fetch(URL_OPENAI[provider], {
      signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    return (j.data || []).map(m => m.id).filter(Boolean);
  } finally {
    clearTimeout(prazo);
  }
}

module.exports = { PADRAO, PROVIDERS, modeloValido, chaveConfig, resolverModelo, resolverModelos, listarModelos };
