/**
 * analise-ia.js — Módulo de análise de licitações via IA
 * Suporta Gemini (Google) e Claude (Anthropic).
 * Prioridade: Gemini > Claude (Gemini é gratuito).
 */

const https = require('https');
const http = require('http');

// Dependências opcionais para extração de texto
let PDFParse, mammoth, AdmZip;
try { PDFParse = require('pdf-parse').PDFParse; } catch (e) {}
try { mammoth = require('mammoth'); } catch (e) {}
try { AdmZip = require('adm-zip'); } catch (e) {}

const PNCP_API = 'https://pncp.gov.br/pncp-api/v1';

/**
 * Busca lista de arquivos de uma licitação no PNCP
 */
async function buscarArquivos(cnpj, ano, sequencial) {
  const url = `${PNCP_API}/orgaos/${cnpj}/compras/${ano}/${sequencial}/arquivos`;
  try {
    const data = await httpGet(url);
    return Array.isArray(data) ? data : [];
  } catch (e) {
    console.log(`[IA] Erro ao buscar arquivos ${cnpj}/${ano}/${sequencial}: ${e.message}`);
    return [];
  }
}

/**
 * Baixa e extrai texto de um arquivo
 */
async function extrairTexto(arquivo) {
  const url = arquivo.url || arquivo.uri;
  if (!url) return '';

  try {
    const buffer = await httpGetBuffer(url);
    const nome = (arquivo.titulo || arquivo.nomeArquivo || '').toLowerCase();

    if (nome.endsWith('.pdf') || arquivo.tipoDocumento === 'pdf') {
      return await extrairPDF(buffer);
    } else if (nome.endsWith('.docx')) {
      return await extrairDOCX(buffer);
    } else if (nome.endsWith('.zip')) {
      return await extrairZIP(buffer);
    } else if (nome.endsWith('.txt') || nome.endsWith('.csv')) {
      return buffer.toString('utf-8').substring(0, 50000);
    }
    // Tenta PDF como fallback
    return await extrairPDF(buffer);
  } catch (e) {
    console.log(`[IA] Erro ao extrair texto de ${arquivo.titulo || 'arquivo'}: ${e.message}`);
    return '';
  }
}

async function extrairPDF(buffer) {
  if (!PDFParse) return '[pdf-parse não instalado]';
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  const result = await parser.getText({ first: 15 });
  const text = result.pages ? result.pages.map(p => p.text).join('\n') : '';
  parser.destroy();
  return text.substring(0, 80000);
}

async function extrairDOCX(buffer) {
  if (!mammoth) return '[mammoth não instalado]';
  const result = await mammoth.extractRawText({ buffer });
  return (result.value || '').substring(0, 80000);
}

async function extrairZIP(buffer) {
  if (!AdmZip) return '[adm-zip não instalado]';
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  let texto = '';
  for (const entry of entries.slice(0, 5)) {
    const nome = entry.entryName.toLowerCase();
    if (entry.isDirectory) continue;
    try {
      const buf = entry.getData();
      if (nome.endsWith('.pdf')) {
        texto += await extrairPDF(buf) + '\n\n';
      } else if (nome.endsWith('.docx')) {
        texto += await extrairDOCX(buf) + '\n\n';
      } else if (nome.endsWith('.txt') || nome.endsWith('.csv')) {
        texto += buf.toString('utf-8').substring(0, 30000) + '\n\n';
      }
    } catch (e) {}
    if (texto.length > 80000) break;
  }
  return texto.substring(0, 80000);
}

/**
 * Analisa uma licitação: busca documentos, extrai textos, envia à IA
 */
async function analisarLicitacao(db, cnpj, ano, sequencial, keys) {
  const pncp = `${cnpj}/${ano}/${sequencial}`;
  const numeroControlePNCP = `${cnpj}-${ano}-${sequencial}`;

  // 1. Buscar dados da licitação no banco
  const licitacao = db.prepare(`
    SELECT l.*, GROUP_CONCAT(i.descricao, ' | ') as itensDescricao,
           GROUP_CONCAT(i.valorUnitarioEstimado, ',') as itensValores
    FROM licitacoes l
    LEFT JOIN itens i ON l.id = i.licitacaoId
    WHERE l.cnpj = ? AND l.anoCompra = ? AND l.sequencialCompra = ?
    GROUP BY l.id
  `).get(cnpj, ano, sequencial);

  if (!licitacao) {
    console.log(`[IA] Licitação ${pncp} não encontrada no banco`);
    return null;
  }

  // 2. Buscar e extrair textos dos documentos
  const arquivos = await buscarArquivos(cnpj, ano, sequencial);
  let textosExtraidos = 0;
  let textoCompleto = '';

  for (const arq of arquivos.slice(0, 5)) {
    const texto = await extrairTexto(arq);
    if (texto && texto.length > 100) {
      textoCompleto += `\n--- ${arq.titulo || arq.nomeArquivo || 'Documento'} ---\n${texto}\n`;
      textosExtraidos++;
    }
  }

  // 3. Montar prompt
  const prompt = montarPrompt(licitacao, textoCompleto);

  // 4. Chamar IA (prioridade: Gemini > Claude)
  let analise = null;
  let provider = null;
  let lastError = null;

  if (keys.gemini) {
    analise = await chamarGemini(keys.gemini, prompt);
    if (analise) provider = 'gemini';
  }

  if (!analise && keys.anthropic) {
    analise = await chamarClaude(keys.anthropic, prompt);
    if (analise) provider = 'claude';
  }

  if (!analise) {
    console.log(`[IA] Nenhum provider retornou análise para ${pncp}`);
    return null;
  }

  // 5. Salvar no banco
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO licitacao_analise
    (numeroControlePNCP, cnpj, ano, sequencial, resumo, segmento,
     itens_destaque, requisitos, atencao, prazo_entrega, local_entrega,
     criterio_julgamento, vistoria_obrigatoria, exclusivo_mei_epp,
     viabilidade_score, viabilidade_justificativa, complexidade,
     arquivos_info, textos_extraidos, dataAnalise)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  stmt.run(
    numeroControlePNCP, cnpj, ano, sequencial,
    analise.resumo || '',
    analise.segmento || '',
    JSON.stringify(analise.itens_destaque || []),
    JSON.stringify(analise.requisitos || []),
    JSON.stringify(analise.atencao || []),
    analise.prazo_entrega || null,
    analise.local_entrega || null,
    analise.criterio_julgamento || null,
    analise.vistoria_obrigatoria ? 1 : 0,
    analise.exclusivo_mei_epp ? 1 : 0,
    analise.viabilidade_score || 50,
    analise.viabilidade_justificativa || '',
    analise.complexidade || 'média',
    JSON.stringify(arquivos.map(a => ({ titulo: a.titulo, tipo: a.tipoDocumento }))),
    textosExtraidos
  );

  console.log(`[IA] Análise salva (${provider}): ${pncp} — score ${analise.viabilidade_score}, ${textosExtraidos} docs`);
  return analise;
}

function montarPrompt(licitacao, textoDocumentos) {
  let contexto = `LICITAÇÃO:
- Objeto: ${licitacao.objetoCompra || 'N/A'}
- Órgão: ${licitacao.razaoSocial || licitacao.nomeUnidade || 'N/A'}
- UASG: ${licitacao.codigoUnidade || 'N/A'}
- Modalidade: ${licitacao.modalidadeNome || 'N/A'}
- Valor estimado: R$ ${licitacao.valorTotalEstimado || 'N/A'}
- Abertura: ${licitacao.dataAberturaProposta || 'N/A'}
- Encerramento: ${licitacao.dataEncerramentoProposta || 'N/A'}
- Situação: ${licitacao.situacaoCompraNome || 'N/A'}
- SRP: ${licitacao.srp ? 'Sim' : 'Não'}`;

  if (licitacao.itensDescricao) {
    contexto += `\n\nITENS:\n${licitacao.itensDescricao}`;
  }

  if (textoDocumentos) {
    contexto += `\n\nDOCUMENTOS DO EDITAL:\n${textoDocumentos.substring(0, 60000)}`;
  }

  return `Analise esta licitação pública brasileira e retorne um JSON com a seguinte estrutura exata:

{
  "resumo": "Resumo do objeto em 2-3 frases",
  "segmento": "Segmento de mercado (ex: TI, Saúde, Construção, Alimentação, etc)",
  "itens_destaque": ["Item 1 mais relevante", "Item 2"],
  "requisitos": ["Requisito técnico 1", "Requisito 2"],
  "atencao": ["Ponto de atenção 1", "Ponto 2"],
  "prazo_entrega": "Prazo informado ou null",
  "local_entrega": "Local informado ou null",
  "criterio_julgamento": "Menor preço / Técnica e preço / etc",
  "vistoria_obrigatoria": false,
  "exclusivo_mei_epp": false,
  "viabilidade_score": 70,
  "viabilidade_justificativa": "Justificativa do score em 1-2 frases",
  "complexidade": "baixa|média|alta"
}

O viabilidade_score (0-100) deve considerar: clareza do edital, complexidade dos requisitos, prazo, e se é viável para uma empresa de TI/serviços participar.

Retorne APENAS o JSON, sem texto adicional.

${contexto}`;
}

// ==================== PROVIDERS ====================

/**
 * Chama Google Gemini (2.0 Flash — gratuito) com retry em 429
 */
async function chamarGemini(apiKey, prompt, tentativa) {
  tentativa = tentativa || 1;
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 2000,
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    });

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    console.log('[IA] Gemini não retornou JSON válido');
    return null;
  } catch (e) {
    const msg = e.message || '';
    // Retry em 429 (rate limit) até 2 vezes
    if (msg.includes('429') && tentativa <= 2) {
      const wait = tentativa * 20000; // 20s, 40s
      console.log(`[IA] Gemini rate limit, retry ${tentativa}/2 em ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return chamarGemini(apiKey, prompt, tentativa + 1);
    }
    // Mensagem útil para quota zero
    if (msg.includes('429') && msg.includes('limit: 0')) {
      console.error('[IA] Gemini: chave sem cota free tier. Crie uma nova em https://aistudio.google.com/apikey');
    } else {
      console.error('[IA] Erro ao chamar Gemini:', msg.substring(0, 200));
    }
    return null;
  }
}

/**
 * Chama Anthropic Claude (Haiku)
 */
async function chamarClaude(apiKey, prompt) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    console.log('[IA] Claude não retornou JSON válido');
    return null;
  } catch (e) {
    console.error('[IA] Erro ao chamar Claude:', e.message);
    return null;
  }
}

/**
 * Processa fila de licitações sem análise
 */
async function processarFilaAnalise(db, keys, limite) {
  const pendentes = db.prepare(`
    SELECT l.cnpj, l.anoCompra as ano, l.sequencialCompra as sequencial
    FROM licitacoes l
    LEFT JOIN licitacao_analise a ON l.cnpj = a.cnpj AND l.anoCompra = a.ano AND l.sequencialCompra = a.sequencial
    WHERE a.id IS NULL
      AND l.dataEncerramentoProposta >= date('now')
    ORDER BY l.dataEncerramentoProposta ASC
    LIMIT ?
  `).all(limite || 20);

  if (pendentes.length === 0) return 0;

  console.log(`[IA] Processando ${pendentes.length} licitações pendentes...`);
  let processadas = 0;

  for (const p of pendentes) {
    try {
      await analisarLicitacao(db, p.cnpj, p.ano, p.sequencial, keys);
      processadas++;
      // Delay entre análises (respeitar rate limits — Gemini free: 15 req/min)
      await new Promise(r => setTimeout(r, 5000));
    } catch (e) {
      console.error(`[IA] Erro ao analisar ${p.cnpj}/${p.ano}/${p.sequencial}: ${e.message}`);
    }
  }

  console.log(`[IA] ${processadas}/${pendentes.length} licitações analisadas`);
  return processadas;
}

// HTTP helpers
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'Accept': 'application/json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON inválido')); }
      });
    }).on('error', reject);
  });
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGetBuffer(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

module.exports = { analisarLicitacao, processarFilaAnalise };
