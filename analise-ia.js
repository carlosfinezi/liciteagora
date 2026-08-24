/**
 * analise-ia.js — Módulo de análise de licitações via IA
 * Suporta 5 providers em cadeia de fallback:
 *   Cerebras → Gemini → DeepSeek → Groq → Claude
 *
 * Cerebras (free generoso, ~1M tok/dia, Llama 3.3 70B, velocidade insana) primário.
 * Gemini (free+billing) como fallback de qualidade superior PT-BR.
 * DeepSeek V3 (pago, mais barato do mercado, ~$0.003/análise) como reserva paga.
 * Groq (free 100k tok/dia) e Claude Haiku (pago último recurso) completam.
 */

const https = require('https');
const http = require('http');
const { matchProdutos } = require('./produto-match');
// Fase 3b (2026-05-23): adapter Postgres pro catalog
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

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
// Detecta tipo real do arquivo pelos magic bytes — PNCP frequentemente
// devolve titulo numérico sem extensão e Content-Type application/octet-stream.
function detectarTipo(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // PDF: %PDF
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return 'pdf';
  // ZIP (e DOCX, que é ZIP): PK\x03\x04
  if (buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04) return 'zip';
  // DOC antigo (OLE): D0 CF 11 E0
  if (buffer[0] === 0xD0 && buffer[1] === 0xCF && buffer[2] === 0x11 && buffer[3] === 0xE0) return 'doc-ole';
  return null;
}

async function extrairTexto(arquivo) {
  const url = arquivo.url || arquivo.uri;
  if (!url) return '';

  try {
    const buffer = await httpGetBuffer(url);
    const nome = (arquivo.titulo || arquivo.nomeArquivo || '').toLowerCase();
    const tipo = detectarTipo(buffer);

    // Magic bytes têm prioridade sobre extensão — PNCP devolve nomes sem
    // extensão e às vezes arquivo "Edital" é ZIP/DOCX.
    if (tipo === 'pdf') return priorizarTermoReferencia(await extrairPDF(buffer));
    if (tipo === 'zip') return await extrairZIP(buffer); // pode ser ZIP puro ou DOCX
    if (tipo === 'doc-ole') {
      console.log(`[IA] Arquivo ${arquivo.titulo || ''} é DOC antigo (OLE) — não suportado, ignorando`);
      return '';
    }

    // Fallback por extensão quando magic bytes não bateram
    if (nome.endsWith('.pdf')) return priorizarTermoReferencia(await extrairPDF(buffer));
    if (nome.endsWith('.docx')) return await extrairDOCX(buffer);
    if (nome.endsWith('.zip')) return await extrairZIP(buffer);
    if (nome.endsWith('.txt') || nome.endsWith('.csv')) return buffer.toString('utf-8').substring(0, 50000);

    // Último recurso: tenta PDF (já vimos editais sem extensão que são PDFs)
    return priorizarTermoReferencia(await extrairPDF(buffer));
  } catch (e) {
    console.log(`[IA] Erro ao extrair texto de ${arquivo.titulo || 'arquivo'}: ${e.message}`);
    return '';
  }
}

// Padrões que indicam início do Termo de Referência / specs técnicas.
// Usado tanto para reordenar texto extraído quanto para early-stop na
// leitura incremental de PDFs grandes.
const PADROES_TERMO_REFERENCIA = [
  /ANEXO\s+I\s*[-–:.]\s*Termo\s+de\s+Refer[êe]ncia/i,
  /TERMO\s+DE\s+REFER[ÊE]NCIA\s+n[º°]/i,
  /OBJETO\s+E\s+ESPECIFICA[ÇC][AÃ]O\s+DO\s+PRODUTO/i,
  /ESPECIFICA[ÇC][ÕO]ES\s+T[ÉE]CNICAS/i,
];

function acharTermoReferencia(texto) {
  if (!texto || texto.length < 1000) return -1;
  for (const padrao of PADROES_TERMO_REFERENCIA) {
    const m = texto.match(padrao);
    // Só conta se a ocorrência estiver depois de uma boa parte do texto
    // (evita cortar pela primeira menção, que pode ser no sumário/índice).
    if (m && m.index > 2000) return m.index;
  }
  return -1;
}

// Leitura incremental: bate o PDF em batches de PASSO páginas, parando
// assim que detectar o início do Termo de Referência. Cap em maxPages
// (200 cobre 99% dos editais; raros monstros >200 págs ficam truncados).
const PDF_PASSO = 30;
const PDF_CAP = 200;

async function extrairPDF(buffer) {
  if (!PDFParse) return '[pdf-parse não instalado]';
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    let texto = '';
    let paginasLidas = 0;
    let encontrouTR = false;

    while (paginasLidas < PDF_CAP) {
      const proximoLimite = Math.min(paginasLidas + PDF_PASSO, PDF_CAP);
      const result = await parser.getText({ first: proximoLimite });
      const novoTexto = result.pages ? result.pages.map(p => p.text).join('\n') : '';

      // Se o texto não cresceu, chegamos ao fim do PDF
      if (novoTexto.length <= texto.length) break;
      texto = novoTexto;
      paginasLidas = proximoLimite;

      if (acharTermoReferencia(texto) >= 0) {
        encontrouTR = true;
        // Lê só mais um lote pra capturar specs após o cabeçalho do TR
        const limiteFinal = Math.min(paginasLidas + PDF_PASSO, PDF_CAP);
        if (limiteFinal > paginasLidas) {
          const r2 = await parser.getText({ first: limiteFinal });
          texto = r2.pages ? r2.pages.map(p => p.text).join('\n') : texto;
          paginasLidas = limiteFinal;
        }
        break;
      }
    }
    if (!encontrouTR && paginasLidas >= PDF_CAP) {
      console.log(`[IA] PDF não tem TR claro nas primeiras ${PDF_CAP} páginas — texto pode estar incompleto`);
    }
    return texto.substring(0, 200000);
  } finally {
    parser.destroy();
  }
}

// Reordena texto extraído para começar pelo Termo de Referência se encontrado.
function priorizarTermoReferencia(texto) {
  const idx = acharTermoReferencia(texto);
  return idx >= 0 ? texto.substring(idx) : texto;
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

  // Se o ZIP tem [Content_Types].xml + word/document.xml, é um DOCX disfarçado.
  const ehDocx = entries.some(e => e.entryName === '[Content_Types].xml')
              && entries.some(e => e.entryName.toLowerCase().startsWith('word/'));
  if (ehDocx) return await extrairDOCX(buffer);

  // Itera arquivos do ZIP (até 10 entries, priorizando PDF/DOCX por tamanho)
  const candidatos = entries
    .filter(e => !e.isDirectory)
    .filter(e => /\.(pdf|docx|txt|csv)$/i.test(e.entryName))
    .sort((a, b) => b.header.size - a.header.size)
    .slice(0, 10);

  let texto = '';
  for (const entry of candidatos) {
    const nome = entry.entryName.toLowerCase();
    try {
      const buf = entry.getData();
      const tipo = detectarTipo(buf);
      let extraido = '';
      if (tipo === 'pdf' || nome.endsWith('.pdf')) extraido = priorizarTermoReferencia(await extrairPDF(buf));
      else if (tipo === 'zip' || nome.endsWith('.docx')) extraido = await extrairDOCX(buf);
      else if (nome.endsWith('.txt') || nome.endsWith('.csv')) extraido = buf.toString('utf-8').substring(0, 30000);
      if (extraido) texto += `\n--- ${entry.entryName} ---\n${extraido}\n\n`;
    } catch (e) {
      console.log(`[IA] Falha ao extrair ${entry.entryName} do ZIP: ${e.message}`);
    }
    if (texto.length > 80000) break;
  }
  return texto.substring(0, 80000);
}

/**
 * Mapeia valor da IA pra um dos 4 valores aceitos no DB.
 * Tolerante a variações (case, espaços, sinônimos) que IAs costumam devolver.
 */
function normalizarFormaDisputa(v) {
  if (!v) return null;
  const s = String(v).toLowerCase().trim().replace(/[-\s]+/g, '_');
  if (s === 'por_item' || s === 'item' || s === 'porItem'.toLowerCase()) return 'por_item';
  if (s === 'por_lote' || s === 'lote' || s === 'por_grupo' || s === 'grupo') return 'por_lote';
  if (s === 'global' || s === 'lote_unico' || s === 'unico' || s === 'objeto_unico') return 'global';
  if (s === 'desconhecido' || s === 'unknown' || s === 'nao_identificado') return 'desconhecido';
  return null;
}

/**
 * Analisa uma licitação: busca documentos, extrai textos, envia à IA
 */
async function analisarLicitacao(db, cnpj, ano, sequencial, keys, opts = {}) {
  const pncp = `${cnpj}/${ano}/${sequencial}`;
  const numeroControlePNCP = `${cnpj}-${ano}-${sequencial}`;

  // 1. Buscar dados da licitação no banco (catalog — PG ou SQLite)
  let licitacao;
  if (USE_PG) {
    // Postgres: STRING_AGG substitui GROUP_CONCAT
    licitacao = await catalogPg.queryOne(`
      SELECT l.*,
             string_agg(i."descricao", ' | ')                            AS "itensDescricao",
             string_agg(coalesce(i."valorUnitarioEstimado"::text, ''), ',') AS "itensValores"
        FROM licitacoes l
        LEFT JOIN itens i ON l."id" = i."licitacaoId"
       WHERE l."cnpj" = $1 AND l."anoCompra" = $2 AND l."sequencialCompra" = $3
       GROUP BY l."id"
    `, [cnpj, Number(ano), Number(sequencial)]);
  } else {
    licitacao = db.prepare(`
      SELECT l.*, GROUP_CONCAT(i.descricao, ' | ') as itensDescricao,
             GROUP_CONCAT(i.valorUnitarioEstimado, ',') as itensValores
      FROM licitacoes l
      LEFT JOIN itens i ON l.id = i.licitacaoId
      WHERE l.cnpj = ? AND l.anoCompra = ? AND l.sequencialCompra = ?
      GROUP BY l.id
    `).get(cnpj, ano, sequencial);
  }

  if (!licitacao) {
    console.log(`[IA] Licitação ${pncp} não encontrada no banco`);
    return null;
  }

  // 2. Buscar e extrair textos dos documentos
  const arquivos = await buscarArquivos(cnpj, ano, sequencial);
  let textosExtraidos = 0;
  let textoCompleto = '';

  // SEQUENCIAL — NÃO paralelizar: o PNCP tem WAF que trava downloads simultâneos
  // do mesmo IP (a conexão abre mas não manda dados → idle timeout). Testado:
  // sequencial cada doc baixa em <1s; paralelo (5 de uma vez) = todos travam.
  // O idle-timeout+retry do httpGetBuffer cobre travas genuínas pontuais.
  for (const arq of arquivos.slice(0, 5)) {
    const texto = await extrairTexto(arq);
    if (texto && texto.length > 100) {
      textoCompleto += `\n--- ${arq.titulo || arq.nomeArquivo || 'Documento'} ---\n${texto}\n`;
      textosExtraidos++;
    }
  }

  // 3. Chamar IA (prioridade: Cerebras > Gemini > DeepSeek > Groq > Claude).
  // Prompt é remontado por provider para respeitar o limite de tokens
  // de cada free tier.
  let analise = null;
  let provider = null;

  if (keys.cerebras) {
    const prompt = montarPrompt(licitacao, textoCompleto, LIMITE_DOCS_POR_PROVIDER.cerebras, opts.produtosQueVendo);
    analise = await chamarCerebras(keys.cerebras, prompt);
    if (analise) provider = 'cerebras';
  }

  if (!analise && keys.gemini) {
    const prompt = montarPrompt(licitacao, textoCompleto, LIMITE_DOCS_POR_PROVIDER.gemini, opts.produtosQueVendo);
    analise = await chamarGemini(keys.gemini, prompt);
    if (analise) provider = 'gemini';
  }

  if (!analise && keys.deepseek) {
    const prompt = montarPrompt(licitacao, textoCompleto, LIMITE_DOCS_POR_PROVIDER.deepseek, opts.produtosQueVendo);
    analise = await chamarDeepSeek(keys.deepseek, prompt);
    if (analise) provider = 'deepseek';
  }

  if (!analise && keys.groq) {
    const prompt = montarPrompt(licitacao, textoCompleto, LIMITE_DOCS_POR_PROVIDER.groq, opts.produtosQueVendo);
    analise = await chamarGroq(keys.groq, prompt);
    if (analise) provider = 'groq';
  }

  if (!analise && keys.anthropic) {
    const prompt = montarPrompt(licitacao, textoCompleto, LIMITE_DOCS_POR_PROVIDER.anthropic, opts.produtosQueVendo);
    analise = await chamarClaude(keys.anthropic, prompt);
    if (analise) provider = 'claude';
  }

  if (!analise) {
    console.log(`[IA] Nenhum provider retornou análise para ${pncp}`);
    return null;
  }

  // 4.5. Augmenta itens_destaque com match no catálogo de produtos da tenant.
  // Server-side, sem custo de IA. Cada item recebe `produto_match` com o
  // melhor candidato (sku, descricao, precoCusto, score). Usado pela
  // /operacional/lances.html (sugestão de custo) e /operacional/analises-ia.html.
  if (Array.isArray(analise.itens_destaque)) {
    for (const it of analise.itens_destaque) {
      try {
        const matches = matchProdutos(db, it.descricao || '', {
          marcaHint: it.marca_referencia || null,
          limite: 1,
          scoreMin: 0.4,
        });
        it.produto_match = matches[0] || null;
      } catch (e) {
        console.error(`[IA] matchProdutos falhou no item ${it.numero}:`, e.message);
      }
    }
  }

  // 5. Salvar no banco — licitacao_analise no DB do tenant (2026-04-23).
  // Análises IA são privadas: cada tenant tem suas próprias, com contexto
  // próprio (grupos de palavras, catálogo, perfil).
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO licitacao_analise
    (numeroControlePNCP, cnpj, ano, sequencial, resumo, segmento,
     itens_destaque, requisitos, atencao, prazo_entrega, local_entrega,
     criterio_julgamento, vistoria_obrigatoria, exclusivo_mei_epp,
     viabilidade_score, viabilidade_justificativa, complexidade,
     arquivos_info, textos_extraidos, produto_compativel, motivo_compativel,
     forma_disputa_itens, justificativa_disputa, dataAnalise)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);

  const compativelValor = analise.produto_compativel === true ? 1
                       : analise.produto_compativel === false ? 0
                       : null;
  // Normaliza forma_disputa_itens: aceita variantes case-insensitive e
  // mapeamentos comuns. IA às vezes devolve "Por Item", "por item",
  // "global", "lote único", etc.
  const formaDisputa = normalizarFormaDisputa(analise.forma_disputa_itens);
  if (analise.forma_disputa_itens && !formaDisputa) {
    console.log(`[IA] forma_disputa_itens fora do enum (descartado): ${JSON.stringify(analise.forma_disputa_itens).substring(0, 100)}`);
  }

  // IA às vezes devolve campos de lista como string única; normaliza para array
  const toArr = (v) => Array.isArray(v) ? v : v == null || v === '' ? [] : [v];

  stmt.run(
    numeroControlePNCP, cnpj, ano, sequencial,
    analise.resumo || '',
    analise.segmento || '',
    JSON.stringify(toArr(analise.itens_destaque)),
    JSON.stringify(toArr(analise.requisitos)),
    JSON.stringify(toArr(analise.atencao)),
    analise.prazo_entrega || null,
    analise.local_entrega || null,
    analise.criterio_julgamento || null,
    analise.vistoria_obrigatoria ? 1 : 0,
    analise.exclusivo_mei_epp ? 1 : 0,
    analise.viabilidade_score || 50,
    analise.viabilidade_justificativa || '',
    analise.complexidade || 'média',
    JSON.stringify(arquivos.map(a => ({ titulo: a.titulo, tipo: a.tipoDocumento }))),
    textosExtraidos,
    compativelValor,
    analise.motivo_compativel || null,
    formaDisputa,
    analise.justificativa_disputa || null
  );

  const compatLog = compativelValor === 1 ? ' [✓ compat]' : compativelValor === 0 ? ' [✗ incompat]' : '';
  console.log(`[IA] Análise salva (${provider}): ${pncp} — score ${analise.viabilidade_score}, ${textosExtraidos} docs${compatLog}`);
  return analise;
}

// Limites de texto do edital por provider, baseado em context window e
// TPM/TPD de cada free tier:
// - cerebras: 128k context, free ~1M tok/dia → folga total
// - gemini: 1M context, free 250k tok/dia → mesma folga
// - deepseek: 64k context window apertado → cortar mais
// - groq: 128k context mas TPM 6000 free → prompt enxuto
// - claude: 200k context, pago → sem aperto
const LIMITE_DOCS_POR_PROVIDER = {
  cerebras: 60000,
  gemini: 60000,
  deepseek: 40000,
  groq: 8000,
  anthropic: 60000,
};

// Gap mínimo entre chamadas de cada provider (ms). Garante que o free tier
// não bate rate limit (TPM) quando o scheduler dispara várias análises em
// sequência. Valores conservadores para ficar dentro do free tier.
const PROVIDER_MIN_GAP_MS = {
  cerebras: 35000,   // TPM ~30k, prompt ~16k tokens → 2 req/min seguros
  gemini: 5000,      // 15 RPM free = 1 req/4s
  deepseek: 1000,    // pago, sem aperto
  groq: 30000,       // TPM 6000 + TPD 100k apertados
  anthropic: 1000,   // pago, sem aperto
};

const _ultimaChamada = {};

// Circuit-breaker por provider: ao receber 429 (rate/quota), o provider entra em
// cooldown e é PULADO nas chamadas seguintes — em vez dos retries futéis que
// estouravam o timeout de 180s/análise. A cadeia cai direto num provider vivo
// (ex: Cerebras/Gemini sem cota diária → vai pro DeepSeek). Aplicado aos providers
// free/quota-prone (cerebras, gemini, groq); deepseek/claude (pagos) seguem com retry.
const _cooldownAte = {};
const COOLDOWN_429_MS = 15 * 60 * 1000;
function _emCooldown(provider) {
  return Date.now() < (_cooldownAte[provider] || 0);
}
function _cooldown429(provider, msg) {
  _cooldownAte[provider] = Date.now() + COOLDOWN_429_MS;
  console.log(`[IA] ${provider} → cooldown ${COOLDOWN_429_MS / 60000}min (429): ${String(msg || '').substring(0, 90)}`);
}

async function aguardarGapProvider(provider) {
  const ultimo = _ultimaChamada[provider] || 0;
  const gap = PROVIDER_MIN_GAP_MS[provider] || 0;
  const espera = ultimo + gap - Date.now();
  if (espera > 0) {
    await new Promise(r => setTimeout(r, espera));
  }
  _ultimaChamada[provider] = Date.now();
}

function montarPrompt(licitacao, textoDocumentos, maxChars, produtosQueVendo) {
  const limite = maxChars || 60000;
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
    contexto += `\n\nDOCUMENTOS DO EDITAL:\n${textoDocumentos.substring(0, limite)}`;
  }

  return `Analise esta licitação pública brasileira e retorne um JSON com a seguinte estrutura exata:

{
  "resumo": "Resumo do objeto em 2-3 frases",
  "segmento": "Segmento de mercado (ex: TI, Saúde, Construção, Alimentação, etc)",
  "itens_destaque": [
    {
      "numero": 1,
      "descricao": "Descrição resumida do item",
      "especificacoes_tecnicas": "Specs detalhadas extraídas do edital (dimensões, materiais, normas, capacidades, etc) — string longa, sem omitir detalhe relevante",
      "quantidade": "valor numérico ou texto como informado",
      "unidade": "UN, CX, KG, SERVIÇO, etc",
      "marca_referencia": "marca/modelo citado como referência ou null",
      "garantia": "prazo de garantia exigido ou null",
      "observacoes": "demais observações relevantes (entrega, montagem, treinamento, etc) ou null",
      "sugestao_cotacao": "Sugestão CONCRETA de marca/modelo/configuração que atende às specs — para o fornecedor cotar. Cite 1-3 opções comparáveis. Ex: 'Dell PowerEdge R750 (2x Xeon Silver 4310, 64GB DDR4, 2x SSD 480GB RAID1); HPE ProLiant DL380 Gen10 equivalente; Lenovo ThinkSystem SR650 V2 equivalente'. Para certificados SSL: indique tipo (DV/OV/EV), CA sugerida (DigiCert, Sectigo, GoDaddy) e validade. Para serviços: configuração técnica recomendada.",
      "produto_compativel": true,
      "motivo_compativel": "Breve frase explicando por que ESTE item específico é (ou não é) compatível com PRODUTOS DA EMPRESA — só preencha se a seção PRODUTOS DA EMPRESA estiver no contexto. Senão null."
    }
  ],
  "requisitos": ["Documento de habilitação 1 (ex: CND federal, atestado de capacidade técnica, declaração de ME/EPP, alvará sanitário, registro CRC/CREA, etc)", "Documento 2"],
  "atencao": ["Ponto de atenção 1", "Ponto 2"],
  "prazo_entrega": "Prazo informado ou null",
  "local_entrega": "Local informado ou null",
  "criterio_julgamento": "Menor preço / Técnica e preço / etc",
  "vistoria_obrigatoria": false,
  "exclusivo_mei_epp": false,
  "viabilidade_score": 70,
  "viabilidade_justificativa": "Justificativa do score em 1-2 frases",
  "complexidade": "baixa|média|alta",
  "produto_compativel": true,
  "motivo_compativel": "Breve justificativa (1 frase) — só preencha se a seção PRODUTOS DA EMPRESA estiver no contexto. Senão deixe null.",
  "forma_disputa_itens": "por_item|por_lote|global|desconhecido",
  "justificativa_disputa": "1 frase citando o trecho do edital que decidiu (ex.: 'item 9.2: julgamento por item, adjudicação por menor preço unitário'). Se não achou nenhuma menção, valor 'desconhecido' e justificativa null."
}

REGRAS PARA itens_destaque:
- Extraia as especificações DOS DOCUMENTOS DO EDITAL (não invente).
- Se o edital tem muitos itens, foque nos até 10 mais relevantes em valor/quantidade/criticidade.
- especificacoes_tecnicas deve ser FIEL ao texto do edital — preserve normas (ABNT, INMETRO), dimensões, materiais, tolerâncias.
- Se um campo não aparece no edital, retorne null (não invente valores).
- sugestao_cotacao é o ÚNICO campo onde você PODE sugerir marca/modelo concretos baseado no seu conhecimento de mercado — pra ajudar o fornecedor a saber o que cotar. Sempre cite 2-3 opções comparáveis (não fique preso a uma marca só).

REGRAS PARA requisitos:
- Liste APENAS documentos/exigências de HABILITAÇÃO (não specs de produto, que vão em itens_destaque).
- Inclui: certidões (CND federal/estadual/municipal/trabalhista/FGTS), atestados de capacidade técnica, registro em órgão de classe (CRC, CREA, CRM, etc), alvarás, declarações exigidas (ME/EPP, idoneidade, menor de idade), balanço patrimonial, CNPJ, contrato social, comprovação de regularidade fiscal e trabalhista.
- Mantenha mesmo se foco maior estiver no produto — habilitação é eliminatória.

O viabilidade_score (0-100) deve considerar: clareza do edital, complexidade dos requisitos, prazo, e se é viável para uma empresa de TI/serviços participar.

REGRAS PARA forma_disputa_itens (PNCP não expõe esse campo — só está no edital):
- "por_item": cada item é julgado e adjudicado separadamente; bidder pode ofertar só nos itens que interessam. Sinais no edital: "julgamento por item", "adjudicação por item", "menor preço por item", "item exclusivo".
- "por_lote": itens agrupados em lotes; bidder oferta no lote inteiro (vence o lote como pacote). Sinais: "julgamento por lote/grupo", "menor preço global do lote", "adjudicação por lote".
- "global": uma única proposta cobre TODOS os itens da licitação. Sinais: "lote único", "menor preço global", "objeto único e indivisível".
- "desconhecido": se o edital não deixa claro ou texto extraído não cobre essa seção. Não chute.
- justificativa_disputa: cite o trecho/seção do edital que decidiu (preferencialmente número da cláusula). Se valor for "desconhecido", null.

⚠ IMPORTANTE: esse campo é crítico — quando "por_lote"/"global", participar de UM item exige cotar TODOS os itens do lote/licitação, mesmo os incompatíveis com a empresa.


${produtosQueVendo ? `REGRAS PARA produto_compativel (por item E no nível da licitação):
- Esta empresa vende EXATAMENTE: ${produtosQueVendo}

POR ITEM (dentro de cada elemento de itens_destaque):
- produto_compativel = true SOMENTE se o item específico encaixa na lista de produtos da empresa.
- Itens que estão na lista NEGATIVA (ex.: hardware quando a empresa vende só software) → false, mesmo que o edital cite a marca/produto da empresa em outro item da mesma licitação.
- motivo_compativel: 1 frase justificando por que ESTE item bate ou não. Cite a palavra-chave do item que decidiu (ex.: "câmera IP — empresa não vende hardware" ou "licença Digifort Enterprise — produto direto").
- Seja RIGOROSO — em dúvida, classifique como false.

NÍVEL DA LICITAÇÃO (campo produto_compativel no topo):
- true se AO MENOS UM item de itens_destaque tem produto_compativel=true.
- false se NENHUM item é compatível.
- motivo_compativel: cite quantos/quais itens batem (ex.: "1 item compatível: licença Digifort Enterprise, item 5") ou justifique o false.
- Licitações mistas (poucos itens da empresa + muitos itens fora) DEVEM ser true no nível licitação — o filtro por-item garante que só os itens certos vão pra interesse.

` : '⚠ O contexto NÃO inclui produtos da empresa — deixe produto_compativel e motivo_compativel como null (TANTO por item quanto no nível da licitação).\n\n'}Retorne APENAS o JSON, sem texto adicional.

${produtosQueVendo ? `PRODUTOS DA EMPRESA:\n${produtosQueVendo}\n\n` : ''}${contexto}`;
}

// ==================== PROVIDERS ====================

/**
 * Chama Cerebras (Qwen 3 235B A22B Instruct) via API OpenAI-compatível.
 * Free tier ~1M tokens/dia. Velocidade ~900-2000 tok/s — mais rápido do mercado.
 * Qwen 3 235B é MoE multilíngue (PT-BR forte) e qualidade comparável a GPT-4o.
 */
async function chamarCerebras(apiKey, prompt, tentativa) {
  if (_emCooldown('cerebras')) return null;
  tentativa = tentativa || 1;
  await aguardarGapProvider('cerebras');
  try {
    const resp = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // 2026-06-08: qwen-3-235b-a22b-instruct-2507 foi descontinuado pela Cerebras
        // (404 em todas as chaves). zai-glm-4.7 é o modelo disponível, não-reasoning
        // (gasta menos token que gpt-oss-120b → a cota diária dura mais) e retorna JSON.
        model: 'zai-glm-4.7',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const erroTexto = await resp.text();
      const err = new Error(`HTTP ${resp.status}: ${erroTexto.substring(0, 200)}`);
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const finishReason = data.choices?.[0]?.finish_reason;
    try {
      // Tenta parse direto (JSON mode garante {...})
      return JSON.parse(text);
    } catch (parseErr) {
      // Fallback: extrai bloco {...} mais externo
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]); } catch {}
      }
      console.log(`[IA] Cerebras JSON inválido (finish_reason=${finishReason}, len=${text.length}). Erro: ${parseErr.message}. Início: ${text.substring(0, 200)}`);
      return null;
    }
  } catch (e) {
    if (e.status === 429) { _cooldown429('cerebras', e.message); return null; }
    console.error('[IA] Erro ao chamar Cerebras:', (e.message || '').substring(0, 200));
    return null;
  }
}

/**
 * Chama DeepSeek V3 (deepseek-chat) via API OpenAI-compatível. Pago — sem
 * free tier viável. Custo ~$0.27/M input + $1.10/M output (~$0.005/análise).
 * Context window 64k (apertado pra editais grandes — texto cortado a 40k chars).
 */
async function chamarDeepSeek(apiKey, prompt, tentativa, opts) {
  tentativa = tentativa || 1;
  opts = opts || {};
  await aguardarGapProvider('deepseek');
  try {
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: opts.max_tokens || 6000,
        temperature: opts.temperature ?? 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const erroTexto = await resp.text();
      const err = new Error(`HTTP ${resp.status}: ${erroTexto.substring(0, 200)}`);
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    console.log('[IA] DeepSeek não retornou JSON válido');
    return null;
  } catch (e) {
    if (e.status === 429 && tentativa <= 2) {
      const wait = tentativa * 10000;
      console.log(`[IA] DeepSeek rate limit, retry ${tentativa}/2 em ${wait/1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return chamarDeepSeek(apiKey, prompt, tentativa + 1, opts);
    }
    console.error('[IA] Erro ao chamar DeepSeek:', (e.message || '').substring(0, 200));
    return null;
  }
}

/**
 * Chama Groq (Llama 3.3 70B Versatile) via API OpenAI-compatível, com retry em 429.
 */
async function chamarGroq(apiKey, prompt, tentativa) {
  if (_emCooldown('groq')) return null;
  tentativa = tentativa || 1;
  await aguardarGapProvider('groq');
  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 3000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!resp.ok) {
      const erroTexto = await resp.text();
      const err = new Error(`HTTP ${resp.status}: ${erroTexto.substring(0, 200)}`);
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    console.log('[IA] Groq não retornou JSON válido');
    return null;
  } catch (e) {
    const msg = e.message || '';
    if (e.status === 429) { _cooldown429('groq', msg); return null; }
    console.error('[IA] Erro ao chamar Groq:', msg.substring(0, 200));
    return null;
  }
}

/**
 * Chama Google Gemini (2.0 Flash — gratuito) com retry em 429
 */
async function chamarGemini(apiKey, prompt, tentativa) {
  if (_emCooldown('gemini')) return null;
  tentativa = tentativa || 1;
  await aguardarGapProvider('gemini');
  try {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        // Gemini 2.5 Flash tem thinking habilitado por default e consome
        // tokens internos antes de responder — pode estourar maxOutputTokens
        // sem entregar nada. Desligamos thinking e damos folga no output.
        // 16k cobre licitações com muitos itens; 8k truncava JSON no meio.
        maxOutputTokens: 16000,
        temperature: 0.2,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const text = result.response.text();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        console.log(`[IA] Gemini JSON parse falhou: ${parseErr.message}. Início do texto: ${text.substring(0, 200)}`);
        return null;
      }
    }
    console.log(`[IA] Gemini não retornou JSON válido. finishReason=${result.response.candidates?.[0]?.finishReason}, len=${text.length}. Início: ${text.substring(0, 200)}`);
    return null;
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('429')) {
      _cooldown429('gemini', msg);
      if (msg.includes('limit: 0')) {
        console.error('[IA] Gemini: chave sem cota free tier. Crie uma nova em https://aistudio.google.com/apikey');
      }
      return null;
    }
    console.error('[IA] Erro ao chamar Gemini:', msg.substring(0, 200));
    return null;
  }
}

/**
 * Chama Anthropic Claude (Haiku)
 */
async function chamarClaude(apiKey, prompt) {
  await aguardarGapProvider('anthropic');
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
  // catalog (PG ou SQLite) + tenant (SQLite). Em PG, JOIN entre DBs não
  // é possível direto — busca candidatas no catalog, filtra já-analisadas
  // em JS contra licitacao_analise do tenant.
  let pendentes;
  if (USE_PG) {
    const cap = (limite || 20) * 5; // pega 5x mais e filtra
    const cands = await catalogPg.query(`
      SELECT "cnpj", "anoCompra" AS ano, "sequencialCompra" AS sequencial
        FROM licitacoes
       WHERE COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") >= now()
       ORDER BY COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") ASC
       LIMIT $1
    `, [cap]);
    const filt = [];
    const stmt = db.prepare(`SELECT 1 FROM licitacao_analise WHERE cnpj=? AND ano=? AND sequencial=? LIMIT 1`);
    for (const c of cands) {
      if (!stmt.get(c.cnpj, Number(c.ano), Number(c.sequencial))) {
        filt.push(c);
        if (filt.length >= (limite || 20)) break;
      }
    }
    pendentes = filt;
  } else {
    pendentes = db.prepare(`
      SELECT l.cnpj, l.anoCompra as ano, l.sequencialCompra as sequencial
      FROM licitacoes l
      LEFT JOIN licitacao_analise a ON l.cnpj = a.cnpj AND l.anoCompra = a.ano AND l.sequencialCompra = a.sequencial
      WHERE a.id IS NULL
        AND l.dataEncerramentoProposta >= date('now')
      ORDER BY l.dataEncerramentoProposta ASC
      LIMIT ?
    `).all(limite || 20);
  }

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
// Download do PNCP via curl (processo separado), NÃO via https.get do Node.
// Dentro do processo de longa duração o https.get TRAVA no PNCP (idle, sem
// dados): o WAF tarpita a assinatura TLS/HTTP do Node e/ou o event-loop sob
// carga não lê o socket a tempo. curl baixa de forma confiável do mesmo servidor
// (testado, ~0.4s) por ser um processo à parte. Flags: --connect-timeout limita
// o connect, --max-time o total, -L segue redirect, -A manda User-Agent. Sem -f:
// corpo de erro é tratado adiante por detectarTipo/JSON.parse (igual ao antigo).
const { execFile } = require('child_process');
const HTTP_MAX_RETRY = 2;

function _curlGet(url, json, maxTime) {
  // Bug do PNCP: o endpoint pncp-api/v1 (.../arquivos) retorna as URLs de download
  // com uma PORTA de backend injetada (ex: pncp.gov.br:46994/...) — monta a URL
  // absoluta com a porta da instância atrás do LB em vez da :443 pública; varia
  // por request e não é acessível de fora → download trava. O arquivo É servido
  // no mesmo path na :443, então removemos qualquer porta de URLs do pncp.gov.br.
  // (--noproxy '*' é defensivo contra proxy de env/.curlrc no curl spawnado.)
  url = String(url).replace(/^(https?:\/\/pncp\.gov\.br):\d+/i, '$1');
  return new Promise((resolve, reject) => {
    const args = ['-sSL', '--noproxy', '*', '--connect-timeout', '15', '--max-time', String(maxTime),
      '-A', 'Mozilla/5.0 (compatible; LiciteAgora/1.0)'];
    if (json) args.push('-H', 'Accept: application/json');
    args.push('--', url);
    execFile('/usr/bin/curl', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`curl: ${(err.message || '').substring(0, 60)} ${stderr ? stderr.toString('utf-8').substring(0, 100) : ''}`));
      resolve(stdout);
    });
  });
}

async function _httpRetry(url, json, maxTime, tentativa) {
  tentativa = tentativa || 1;
  try {
    return await _curlGet(url, json, maxTime);
  } catch (e) {
    if (tentativa <= HTTP_MAX_RETRY) {
      console.log(`[IA] Download ${tentativa}/${HTTP_MAX_RETRY} falhou (${(e.message || '').substring(0, 80)}), re-tentando...`);
      await new Promise(r => setTimeout(r, 1500 * tentativa));
      return _httpRetry(url, json, maxTime, tentativa + 1);
    }
    throw e;
  }
}

function httpGet(url) {
  return _httpRetry(url, true, 30).then(buf => {
    try { return JSON.parse(buf.toString('utf-8')); }
    catch (e) { throw new Error('JSON inválido'); }
  });
}

function httpGetBuffer(url) {
  return _httpRetry(url, false, 90);
}

// Os chamadores de provider são genéricos (apiKey, prompt) -> JSON e já
// trazem cooldown de 429 e rate-limit. Exportados para outros módulos usarem
// a MESMA cadeia, em vez de cada um reimplementar a sua.
module.exports = { analisarLicitacao, processarFilaAnalise,
  chamarCerebras, chamarGemini, chamarDeepSeek, chamarGroq, chamarClaude };
