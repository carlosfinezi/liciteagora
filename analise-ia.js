'use strict';

/**
 * analise-ia.js
 * Módulo de análise inteligente de licitações com IA (Claude)
 * Integrado ao LiciteAgora — chamado automaticamente durante a sincronização
 */

const axios = require('axios');
const PNCP_ARQUIVOS = 'https://pncp.gov.br/pncp-api/v1';

// Tenta importar pdf-parse e mammoth de forma opcional
let pdfParse = null;
let mammoth = null;
let AdmZip = null;

try { pdfParse = require('pdf-parse'); } catch(e) {}
try { mammoth = require('mammoth'); } catch(e) {}
try { AdmZip = require('adm-zip'); } catch(e) {}

// ─── Extração de texto ───────────────────────────────────────────────────────

async function extrairTextoPDF(buffer) {
  if (!pdfParse) return null;
  try {
    const data = await pdfParse(buffer, { max: 15 }); // max 15 páginas
    return data.text?.trim() || null;
  } catch(e) {
    return null;
  }
}

async function extrairTextoDOCX(buffer) {
  if (!mammoth) return null;
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value?.trim() || null;
  } catch(e) {
    return null;
  }
}

async function extrairTextoZIP(buffer) {
  if (!AdmZip) return [];
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    const textos = [];
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const nome = entry.entryName.toLowerCase();
      const conteudo = entry.getData();
      if (nome.endsWith('.pdf')) {
        const t = await extrairTextoPDF(conteudo);
        if (t) textos.push({ nome: entry.entryName, texto: t });
      } else if (nome.endsWith('.docx')) {
        const t = await extrairTextoDOCX(conteudo);
        if (t) textos.push({ nome: entry.entryName, texto: t });
      } else if (nome.endsWith('.txt')) {
        textos.push({ nome: entry.entryName, texto: conteudo.toString('utf8') });
      }
    }
    return textos;
  } catch(e) {
    return [];
  }
}

async function baixarEExtrairArquivos(cnpj, ano, sequencial) {
  const textos = [];
  const arquivosInfo = [];

  // 1. Listar arquivos
  let arquivos = [];
  try {
    const resp = await axios.get(
      `${PNCP_ARQUIVOS}/orgaos/${cnpj}/compras/${ano}/${sequencial}/arquivos`,
      { timeout: 15000, headers: { Accept: 'application/json' } }
    );
    arquivos = resp.data || [];
  } catch(e) {
    console.log(`[ANALISE-IA] Sem arquivos para ${cnpj}/${ano}/${sequencial}: ${e.message}`);
    return { textos, arquivosInfo };
  }

  if (!Array.isArray(arquivos) || arquivos.length === 0) return { textos, arquivosInfo };

  // 2. Baixar e extrair (máx 5 arquivos)
  const limite = Math.min(arquivos.length, 5);
  for (let i = 0; i < limite; i++) {
    const arq = arquivos[i];
    const seqDoc = arq.sequencialDocumento || (i + 1);
    const nome = arq.nome || arq.titulo || `arquivo_${seqDoc}`;
    const ext = nome.split('.').pop().toLowerCase();
    arquivosInfo.push({ nome, ext });

    try {
      const resp = await axios.get(
        `${PNCP_ARQUIVOS}/orgaos/${cnpj}/compras/${ano}/${sequencial}/arquivos/${seqDoc}`,
        { responseType: 'arraybuffer', timeout: 30000 }
      );
      const buffer = Buffer.from(resp.data);

      if (ext === 'pdf') {
        const t = await extrairTextoPDF(buffer);
        if (t) textos.push({ nome, texto: t.substring(0, 12000) });
      } else if (ext === 'docx') {
        const t = await extrairTextoDOCX(buffer);
        if (t) textos.push({ nome, texto: t.substring(0, 12000) });
      } else if (ext === 'zip') {
        const inner = await extrairTextoZIP(buffer);
        for (const item of inner) {
          textos.push({ nome: `${nome} → ${item.nome}`, texto: item.texto.substring(0, 8000) });
        }
      } else if (ext === 'txt') {
        textos.push({ nome, texto: buffer.toString('utf8').substring(0, 12000) });
      }

      await new Promise(r => setTimeout(r, 200));
    } catch(e) {
      console.log(`[ANALISE-IA] Erro ao baixar ${nome}: ${e.message}`);
    }
  }

  return { textos, arquivosInfo };
}

// ─── Chamada Claude API ──────────────────────────────────────────────────────

async function analisarComClaude(apiKey, licitacao, itens, textos) {
  const itensTexto = itens.slice(0, 20).map(it =>
    `- Item ${it.numeroItem}: ${it.descricao} | Qtd: ${it.quantidade} ${it.unidadeMedida || ''} | Valor unit. estimado: ${it.valorUnitarioEstimado ? 'R$ ' + Number(it.valorUnitarioEstimado).toFixed(2) : 'N/A'}`
  ).join('\n');

  const docsTexto = textos.slice(0, 4).map(t =>
    `=== ${t.nome} ===\n${t.texto.substring(0, 6000)}`
  ).join('\n\n');

  const prompt = `Você é especialista em licitações públicas brasileiras. Analise esta licitação do PNCP e retorne SOMENTE um JSON válido, sem markdown nem explicações.

DADOS DA LICITAÇÃO:
- Objeto: ${licitacao.objetoCompra || 'N/A'}
- Órgão: ${licitacao.razaoSocial || licitacao.nomeUnidade || 'N/A'} (${licitacao.municipioNome || ''} - ${licitacao.ufSigla || ''})
- Modalidade: ${licitacao.modalidadeNome || 'N/A'}
- Valor Estimado: ${licitacao.valorTotalEstimado ? 'R$ ' + Number(licitacao.valorTotalEstimado).toLocaleString('pt-BR') : 'Sigiloso'}
- Abertura Propostas: ${licitacao.dataAberturaProposta || 'N/A'}
- Encerramento: ${licitacao.dataEncerramentoProposta || 'N/A'}
- Informações Complementares: ${(licitacao.informacaoComplementar || '').substring(0, 500)}

ITENS (${itens.length} total):
${itensTexto || 'Sem itens listados'}

${docsTexto ? `DOCUMENTOS EXTRAÍDOS:\n${docsTexto}` : '(documentos não disponíveis — análise baseada nos dados da API)'}

Retorne SOMENTE este JSON:
{
  "resumo": "resumo do objeto em 2-3 frases diretas",
  "segmento": "segmento principal (ex: TI, Saúde, Obras, Serviços, Material de Escritório, etc.)",
  "itens_destaque": ["item principal 1", "item principal 2"],
  "requisitos": ["requisito de habilitação 1", "requisito 2"],
  "atencao": ["ponto de atenção 1"],
  "prazo_entrega": "prazo mencionado ou 'Não especificado'",
  "local_entrega": "local mencionado ou 'Não especificado'",
  "criterio_julgamento": "Menor Preço ou Melhor Técnica e Preço ou outro",
  "vistoria_obrigatoria": false,
  "exclusivo_mei_epp": false,
  "viabilidade_score": 65,
  "viabilidade_justificativa": "breve justificativa em 1 frase",
  "complexidade": "baixa"
}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      timeout: 30000
    }
  );

  const raw = response.data?.content?.[0]?.text || '{}';
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── Função principal ────────────────────────────────────────────────────────

/**
 * Analisa uma licitação com IA e salva no banco.
 * @param {object} db - instância better-sqlite3
 * @param {string} apiKey - chave Anthropic
 * @param {object} licitacao - dados da licitação (linha do banco)
 * @param {array}  itens     - itens da licitação
 */
async function analisarLicitacao(db, apiKey, licitacao, itens = []) {
  const { cnpj, anoCompra: ano, sequencialCompra: sequencial, numeroControlePNCP } = licitacao;

  // Verifica se já foi analisada
  const existente = db.prepare('SELECT id FROM licitacao_analise WHERE numeroControlePNCP = ?').get(numeroControlePNCP);
  if (existente) return null; // já processada

  console.log(`[ANALISE-IA] Analisando ${numeroControlePNCP}…`);

  try {
    // Tenta baixar arquivos (falha graciosamente)
    const { textos, arquivosInfo } = await baixarEExtrairArquivos(cnpj, ano, sequencial);

    // Chama Claude
    const analise = await analisarComClaude(apiKey, licitacao, itens, textos);

    // Salva no banco
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO licitacao_analise
        (numeroControlePNCP, cnpj, ano, sequencial, resumo, segmento,
         itens_destaque, requisitos, atencao, prazo_entrega, local_entrega,
         criterio_julgamento, vistoria_obrigatoria, exclusivo_mei_epp,
         viabilidade_score, viabilidade_justificativa, complexidade,
         arquivos_info, textos_extraidos, dataAnalise)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
    `);

    stmt.run(
      numeroControlePNCP, cnpj, ano, sequencial,
      analise.resumo || '',
      analise.segmento || '',
      JSON.stringify(analise.itens_destaque || []),
      JSON.stringify(analise.requisitos || []),
      JSON.stringify(analise.atencao || []),
      analise.prazo_entrega || '',
      analise.local_entrega || '',
      analise.criterio_julgamento || '',
      analise.vistoria_obrigatoria ? 1 : 0,
      analise.exclusivo_mei_epp ? 1 : 0,
      analise.viabilidade_score || 50,
      analise.viabilidade_justificativa || '',
      analise.complexidade || 'média',
      JSON.stringify(arquivosInfo),
      textos.length
    );

    console.log(`[ANALISE-IA] ✅ ${numeroControlePNCP} — score: ${analise.viabilidade_score}`);
    return analise;

  } catch(e) {
    console.warn(`[ANALISE-IA] ⚠️ Erro ao analisar ${numeroControlePNCP}: ${e.message}`);
    return null;
  }
}

/**
 * Processa fila de licitações não analisadas (chamado após sync)
 * @param {object} db - instância better-sqlite3
 * @param {string} apiKey - chave Anthropic
 * @param {number} limite - quantas analisar por vez (default 20)
 */
async function processarFilaAnalise(db, apiKey, limite = 20) {
  if (!apiKey) {
    console.log('[ANALISE-IA] API key não configurada — pulando análise automática');
    return;
  }

  // Busca licitações sem análise (as mais recentes primeiro)
  const pendentes = db.prepare(`
    SELECT l.* FROM licitacoes l
    LEFT JOIN licitacao_analise la ON la.numeroControlePNCP = l.numeroControlePNCP
    WHERE la.id IS NULL
      AND l.dataEncerramentoProposta >= date('now')
    ORDER BY l.dataPublicacaoPncp DESC
    LIMIT ?
  `).all(limite);

  if (pendentes.length === 0) {
    console.log('[ANALISE-IA] Nenhuma licitação pendente de análise');
    return;
  }

  console.log(`[ANALISE-IA] Processando ${pendentes.length} licitações na fila…`);

  for (const lic of pendentes) {
    // Busca itens do banco
    const itens = db.prepare('SELECT * FROM itens WHERE numeroControlePNCP = ?').all(lic.numeroControlePNCP);

    await analisarLicitacao(db, apiKey, lic, itens);

    // Delay para não sobrecarregar a API
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('[ANALISE-IA] Fila processada');
}

module.exports = { analisarLicitacao, processarFilaAnalise };
