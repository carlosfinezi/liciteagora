// chat-ia.js (2026-05-22)
//
// Motor do chat-IA do sistema (separado do chat-mensagens-routes.js, que
// trata o chat do Comprasnet com pregoeiros). Aqui o usuário conversa com
// um copiloto IA pra tirar dúvidas sobre análises, licitações, configs.
//
// Reaproveita a chain de providers do analise-ia.js (Cerebras > Gemini >
// DeepSeek > Groq > Claude), mas com prompt format multi-turn (system +
// history). Sem JSON output — só texto livre.

'use strict';

const axios = require('axios');
// Fase 3g (2026-05-23): carregarContexto lê catalog via PG quando flag ativa
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

// ===== Provider callers (chat-completion format) =====

async function chatCerebras(apiKey, messages) {
  const resp = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
    model: 'llama-3.3-70b',
    messages,
    temperature: 0.4,
    max_tokens: 1200,
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return resp.data?.choices?.[0]?.message?.content || null;
}

async function chatGemini(apiKey, messages) {
  // Gemini API espera role "user" e "model" — converte "assistant" → "model"
  const systemMsg = messages.find(m => m.role === 'system');
  const conversa = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = {
    contents: conversa,
    // thinkingBudget:0 desliga o "thinking" do 2.5-flash — senão ele consome o
    // maxOutputTokens e a resposta sai TRUNCADA (finishReason MAX_TOKENS).
    generationConfig: { temperature: 0.4, maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } },
  };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  const resp = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    body, { timeout: 30000 }
  );
  const cand = resp.data?.candidates?.[0];
  // resposta truncada/bloqueada → null, pra cair no próximo provider da chain.
  if (cand?.finishReason && cand.finishReason !== 'STOP') return null;
  return cand?.content?.parts?.[0]?.text || null;
}

async function chatDeepSeek(apiKey, messages) {
  const resp = await axios.post('https://api.deepseek.com/v1/chat/completions', {
    model: 'deepseek-chat',
    messages,
    temperature: 0.4,
    max_tokens: 1200,
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return resp.data?.choices?.[0]?.message?.content || null;
}

async function chatGroq(apiKey, messages) {
  const resp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
    model: 'llama-3.3-70b-versatile',
    messages,
    temperature: 0.4,
    max_tokens: 1200,
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  return resp.data?.choices?.[0]?.message?.content || null;
}

// ===== Fallback chain =====
async function chamarChatLLM(messages, keys) {
  const tentativas = [
    keys.cerebras  && { name: 'cerebras',  fn: () => chatCerebras(keys.cerebras, messages) },
    keys.gemini    && { name: 'gemini',    fn: () => chatGemini(keys.gemini, messages) },
    keys.deepseek  && { name: 'deepseek',  fn: () => chatDeepSeek(keys.deepseek, messages) },
    keys.groq      && { name: 'groq',      fn: () => chatGroq(keys.groq, messages) },
  ].filter(Boolean);

  let ultimoErro = null;
  for (const t of tentativas) {
    try {
      const content = await t.fn();
      if (content) return { provider: t.name, content };
    } catch (e) {
      ultimoErro = `${t.name}: ${e.response?.status || ''} ${e.message}`;
      console.warn(`[chat-ia] ${t.name} falhou:`, ultimoErro);
    }
  }
  throw new Error('Todos os providers falharam' + (ultimoErro ? ` (último: ${ultimoErro})` : ''));
}

// ===== Schema =====
function inicializarSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_ia_sessoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT,
      contextoTipo TEXT,
      contextoId TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS chat_ia_mensagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessaoId INTEGER NOT NULL,
      papel TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      provider TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sessaoId) REFERENCES chat_ia_sessoes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_ia_mensagens_sessao ON chat_ia_mensagens(sessaoId, id);
  `);
}

// ===== Contexto: carrega snapshot baseado em tipo + id =====
//
// Retorna texto pronto pra embutir no system prompt. Cada tipo busca
// no DB o que faz sentido pra IA "ver".
async function carregarContexto(db, tipo, id) {
  if (!tipo || !id) return null;

  try {
    if (tipo === 'analise') {
      // id pode ser numeroControlePNCP ou id numérico
      const a = isNaN(id)
        ? db.prepare(`SELECT * FROM licitacao_analise WHERE numeroControlePNCP = ?`).get(String(id))
        : db.prepare(`SELECT * FROM licitacao_analise WHERE id = ?`).get(Number(id));
      if (!a) return null;
      let lic = null;
      try {
        if (USE_PG) {
          lic = await catalogPg.queryOne(
            `SELECT "objetoCompra" AS "objetoCompra", "razaoSocial" AS "razaoSocial",
                    "nomeUnidade" AS "nomeUnidade", "ufSigla" AS "ufSigla", "municipioNome" AS "municipioNome",
                    "valorTotalEstimado" AS "valorTotalEstimado", COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") AS "dataEncerramentoProposta",
                    "modalidadeNome" AS "modalidadeNome", "linkSistemaOrigem" AS "linkSistemaOrigem"
               FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3`,
            [a.cnpj, a.ano, a.sequencial]
          );
        } else {
          lic = db.prepare(`SELECT objetoCompra, razaoSocial, nomeUnidade, ufSigla, municipioNome,
                                   valorTotalEstimado, dataEncerramentoProposta, modalidadeNome, linkSistemaOrigem
                              FROM licitacoes
                             WHERE cnpj=? AND anoCompra=? AND sequencialCompra=?`)
            .get(a.cnpj, a.ano, a.sequencial);
        }
      } catch (_) {}
      return [
        `## Análise da licitação ${a.cnpj}/${a.ano}/${a.sequencial}`,
        `Órgão: ${lic?.razaoSocial || lic?.nomeUnidade || '—'} (${lic?.ufSigla || ''}/${lic?.municipioNome || ''})`,
        `Modalidade: ${lic?.modalidadeNome || '—'}`,
        `Encerra: ${lic?.dataEncerramentoProposta || '—'}`,
        `Valor estimado: R$ ${Number(lic?.valorTotalEstimado || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        `Link: ${lic?.linkSistemaOrigem || '—'}`,
        ``,
        `Score IA: ${a.viabilidade_score}/100 (${a.complexidade})`,
        `Segmento: ${a.segmento || '—'}`,
        `Compatível: ${a.produto_compativel ? 'SIM' : 'NÃO'} — ${a.motivo_compativel || ''}`,
        ``,
        `Resumo IA:`,
        a.resumo || '—',
        ``,
        `Objeto:`,
        lic?.objetoCompra || '—',
        ``,
        a.itens_destaque ? `Itens destaque (JSON):\n${a.itens_destaque}` : '',
        a.requisitos ? `Requisitos:\n${a.requisitos}` : '',
        a.atencao ? `Pontos de atenção:\n${a.atencao}` : '',
        a.viabilidade_justificativa ? `Justificativa viabilidade:\n${a.viabilidade_justificativa}` : '',
      ].filter(Boolean).join('\n');
    }

    if (tipo === 'licitacao') {
      // id = cnpj-ano-sequencial
      const partes = String(id).split('-');
      if (partes.length !== 3) return null;
      const [cnpj, ano, sequencial] = partes;
      let lic;
      if (USE_PG) {
        lic = await catalogPg.queryOne(
          `SELECT *, COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") AS "dataEncerramentoProposta" FROM licitacoes WHERE "cnpj"=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3`,
          [cnpj, Number(ano), Number(sequencial)]
        );
      } else {
        lic = db.prepare(`SELECT * FROM licitacoes WHERE cnpj=? AND anoCompra=? AND sequencialCompra=?`)
          .get(cnpj, Number(ano), Number(sequencial));
      }
      if (!lic) return null;
      let itens = [];
      try {
        if (USE_PG) {
          itens = await catalogPg.query(
            `SELECT "numeroItem" AS "numeroItem", "descricao" AS descricao, "quantidade" AS quantidade,
                    "unidadeMedida" AS "unidadeMedida", "valorUnitarioEstimado" AS "valorUnitarioEstimado"
               FROM itens WHERE "licitacaoId" = $1 ORDER BY "numeroItem" LIMIT 30`,
            [lic.id]
          );
        } else {
          itens = db.prepare(`SELECT numeroItem, descricao, quantidade, unidadeMedida, valorUnitarioEstimado
                                FROM itens WHERE licitacaoId = ? ORDER BY numeroItem LIMIT 30`)
            .all(lic.id);
        }
      } catch (_) {}
      return [
        `## Licitação ${cnpj}/${ano}/${sequencial}`,
        `Órgão: ${lic.razaoSocial || lic.nomeUnidade || '—'} (${lic.ufSigla || ''}/${lic.municipioNome || ''})`,
        `Modalidade: ${lic.modalidadeNome || '—'}`,
        `Encerra: ${lic.dataEncerramentoProposta || '—'}`,
        `Valor estimado: R$ ${Number(lic.valorTotalEstimado || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`,
        `Link: ${lic.linkSistemaOrigem || '—'}`,
        ``,
        `Objeto: ${lic.objetoCompra || '—'}`,
        ``,
        `Itens (até 30):`,
        ...itens.map(i => `  ${i.numeroItem}. ${(i.descricao || '').substring(0, 200)} — ${i.quantidade} ${i.unidadeMedida || ''} — R$ ${i.valorUnitarioEstimado || 0}`),
      ].join('\n');
    }
  } catch (e) {
    console.warn('[chat-ia] carregarContexto erro:', e.message);
  }
  return null;
}

// ===== System prompt =====
function montarSystemPrompt(tenantSlug, produtosQueVendo, contextoTxt) {
  const partes = [
    `Você é o assistente IA do LiciteAgora — sistema de apoio a fornecedores em licitações públicas brasileiras (Lei 14.133/2021).`,
    `Você responde em PT-BR, de forma direta e técnica. Quando o usuário perguntar sobre uma licitação ou análise, use o contexto fornecido. Não invente dados.`,
  ];
  if (produtosQueVendo) {
    partes.push('');
    partes.push('## Perfil do tenant (o que a empresa vende/oferece):');
    partes.push(produtosQueVendo);
  }
  if (contextoTxt) {
    partes.push('');
    partes.push('## Contexto da página atual:');
    partes.push(contextoTxt);
  }
  return partes.join('\n');
}

// Pega a descrição de produtos do primeiro agendamento (qualquer grupo) — proxy do perfil
function getProdutosQueVendo(db) {
  try {
    const row = db.prepare(`SELECT produtos_que_vendo FROM analise_ia_agendamento
                             WHERE produtos_que_vendo IS NOT NULL AND produtos_que_vendo != ''
                             ORDER BY length(produtos_que_vendo) DESC LIMIT 1`).get();
    return row?.produtos_que_vendo || null;
  } catch (_) { return null; }
}

module.exports = {
  inicializarSchema,
  chamarChatLLM,
  carregarContexto,
  montarSystemPrompt,
  getProdutosQueVendo,
};
