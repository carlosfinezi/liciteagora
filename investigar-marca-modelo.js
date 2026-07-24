#!/usr/bin/env node
/**
 * Investigar fontes de dados de marca/modelo de vencedores
 * 
 * Testa 3 APIs diferentes para descobrir onde encontrar marca/fabricante/modelo:
 * 1. PNCP API (pncp.gov.br/api/pncp/v1) - já usada no BI
 * 2. Dados Abertos Compras (dadosabertos.compras.gov.br) - nova API oficial
 * 3. Comprasnet Fase Externa (cnetmobile) - API interna (requer sessão)
 * 
 * Uso: node investigar-marca-modelo.js
 */

const axios = require('axios');

const PNCP_API = 'https://pncp.gov.br/api/pncp/v1';
const PNCP_CONSULTA = 'https://pncp.gov.br/api/consulta/v1';
const DADOS_ABERTOS = 'https://dadosabertos.compras.gov.br';

// Licitação de teste - usar uma já encerrada com resultado homologado
// Ajuste conforme necessário
const TESTES = [
  // Formato: { cnpj, ano, sequencial, item, descricao }
  // Vamos buscar automaticamente uma licitação com resultado
];

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function logFields(obj, prefix = '') {
  if (!obj) return;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      console.log(`${prefix}${key}:`);
      logFields(value, prefix + '  ');
    } else {
      const strVal = JSON.stringify(value);
      const highlight = /marca|modelo|fabricante|versao|brand|descricao.*proposta/i.test(key)
        ? ' ⭐⭐⭐'
        : '';
      console.log(`${prefix}${key}: ${strVal.substring(0, 120)}${highlight}`);
    }
  }
}

// ============================================================
// 1. PNCP API - Resultados
// ============================================================
async function testePNCP() {
  logSection('1. PNCP API - Buscar licitação com resultado homologado');

  try {
    // Buscar licitações recentes encerradas
    const busca = await axios.get(`${PNCP_CONSULTA}/contratacoes/publicacao`, {
      params: {
        dataInicial: '20250101',
        dataFinal: '20250201',
        codigoModalidadeContratacao: 8, // Pregão
        pagina: 1,
        tamanhoPagina: 5
      },
      timeout: 15000
    });

    const licitacoes = busca.data?.data || [];
    console.log(`Encontradas ${licitacoes.length} licitações para teste`);

    for (const lic of licitacoes.slice(0, 2)) {
      const cnpj = lic.orgaoEntidade?.cnpj;
      const ano = lic.anoCompra;
      const seq = lic.sequencialCompra;
      console.log(`\n--- Testando: ${cnpj}/${ano}/${seq} (${lic.objetoCompra?.substring(0, 60)})`);

      // Buscar itens
      try {
        const itensResp = await axios.get(`${PNCP_API}/orgaos/${cnpj}/compras/${ano}/${seq}/itens`, {
          params: { pagina: 1, tamanhoPagina: 3 },
          timeout: 10000
        });
        const itens = itensResp.data || [];
        console.log(`  ${itens.length} itens encontrados`);

        for (const item of itens.slice(0, 2)) {
          const numItem = item.numeroItem;
          console.log(`\n  Item ${numItem}: ${item.descricao?.substring(0, 60)}`);
          console.log(`  Campos do item:`);
          logFields(item, '    ');

          // Buscar resultado do item
          try {
            const resResp = await axios.get(
              `${PNCP_API}/orgaos/${cnpj}/compras/${ano}/${seq}/itens/${numItem}/resultados`,
              { timeout: 10000 }
            );
            const resultados = resResp.data || [];
            console.log(`\n  ${resultados.length} resultado(s) para item ${numItem}:`);

            for (const r of resultados.slice(0, 2)) {
              console.log(`\n  --- Resultado (sequencial ${r.sequencialResultado || '?'}):`);
              logFields(r, '    ');
            }
          } catch (e) {
            console.log(`  Resultado: ${e.response?.status || e.message}`);
          }
          await sleep(200);
        }
      } catch (e) {
        console.log(`  Itens: ${e.response?.status || e.message}`);
      }
      await sleep(300);
    }
  } catch (e) {
    console.log(`Erro PNCP: ${e.response?.status || e.message}`);
  }
}

// ============================================================
// 2. Dados Abertos Compras.gov.br
// ============================================================
async function testeDadosAbertos() {
  logSection('2. Dados Abertos (dadosabertos.compras.gov.br)');

  // Testar endpoint de resultado de itens de contratações PNCP 14133
  // Seção 10.7 do manual v2.0
  const endpoints = [
    '/modulo-contratacao/3_consultarResultadoItemContratacaoPncp14133?pagina=1&tamanhoPagina=2',
    '/modulo-contratacao/2_consultarItemContratacaoPncp14133?pagina=1&tamanhoPagina=2',
    '/modulo-contratacao/1_consultarContratacaoPncp14133?pagina=1&tamanhoPagina=2',
  ];

  for (const endpoint of endpoints) {
    console.log(`\n--- GET ${endpoint.substring(0, 80)}...`);
    try {
      const resp = await axios.get(`${DADOS_ABERTOS}${endpoint}`, {
        headers: { 'Accept': 'application/json' },
        timeout: 15000
      });
      const data = resp.data;
      console.log(`  Status: ${resp.status}`);
      console.log(`  Total registros: ${data.totalRegistros || '?'}`);

      const resultados = data.resultado || [];
      for (const r of resultados.slice(0, 1)) {
        console.log('\n  Campos retornados:');
        logFields(r, '    ');
      }
    } catch (e) {
      console.log(`  Erro: ${e.response?.status || e.message}`);
      if (e.response?.data) {
        console.log(`  Body: ${JSON.stringify(e.response.data).substring(0, 200)}`);
      }
    }
    await sleep(300);
  }

  // Testar pesquisa de preço (pode ter marca/modelo)
  console.log('\n--- Testando Módulo Pesquisa de Preço (pode ter marca)');
  try {
    const resp = await axios.get(`${DADOS_ABERTOS}/modulo-pesquisa-preco/1_consultarPesquisaPrecoMaterial?pagina=1&tamanhoPagina=2`, {
      headers: { 'Accept': 'application/json' },
      timeout: 15000
    });
    const data = resp.data;
    console.log(`  Status: ${resp.status}, Total: ${data.totalRegistros || '?'}`);
    const resultados = data.resultado || [];
    for (const r of resultados.slice(0, 1)) {
      console.log('\n  Campos Pesquisa Preço:');
      logFields(r, '    ');
    }
  } catch (e) {
    console.log(`  Erro: ${e.response?.status || e.message}`);
  }

  // Testar itens de pregão legado (historicamente tem marca)
  console.log('\n--- Testando Módulo Legado - Itens de Pregões');
  try {
    const resp = await axios.get(`${DADOS_ABERTOS}/modulo-legado/4_consultarItensPregoes?pagina=1&tamanhoPagina=2`, {
      headers: { 'Accept': 'application/json' },
      timeout: 15000
    });
    const data = resp.data;
    console.log(`  Status: ${resp.status}, Total: ${data.totalRegistros || '?'}`);
    const resultados = data.resultado || [];
    for (const r of resultados.slice(0, 1)) {
      console.log('\n  Campos Item Pregão Legado:');
      logFields(r, '    ');
    }
  } catch (e) {
    console.log(`  Erro: ${e.response?.status || e.message}`);
  }
}

// ============================================================
// 3. Comprasnet Fase Externa - Endpoints públicos
// ============================================================
async function testeComprasnet() {
  logSection('3. Comprasnet Fase Externa (endpoints públicos)');

  const BASE = 'https://cnetmobile.estaleiro.serpro.gov.br';

  // Tentar endpoints que podem ser públicos (sem auth)
  // O acompanhamento de compra é público
  const endpointsPublicos = [
    // Detalhamento público do item (já sabemos que funciona sem auth para consulta)
    '/comprasnet-fase-externa/v1/compras/07001206000152026/itens/1/detalhamento',
    // Tentar classificação (ranking de propostas)
    '/comprasnet-fase-externa/v1/compras/07001206000152026/itens/1/classificacao',
    // Tentar propostas
    '/comprasnet-fase-externa/v1/compras/07001206000152026/itens/1/propostas',
    // Tentar resultado
    '/comprasnet-fase-externa/v1/compras/07001206000152026/itens/1/resultado',
    // Tentar detalhamento com propostas
    '/comprasnet-fase-externa/v1/compras/07001206000152026/itens/1/detalhamento-completo',
    // Compra completa
    '/comprasnet-fase-externa/v1/compras/07001206000152026',
    // Acompanhamento público
    '/comprasnet-web/public/compras/acompanhamento-compra/07001206000152026',
    // API de disputa (pode ter classificação com marca)
    '/comprasnet-disputa/v1/compras/07001206000152026/itens/1/classificacao',
    '/comprasnet-disputa/v1/compras/07001206000152026/itens/1/lances',
  ];

  for (const path of endpointsPublicos) {
    console.log(`\n--- GET ${path}`);
    try {
      const resp = await axios.get(`${BASE}${path}`, {
        headers: {
          'Accept': 'application/json',
          'x-device-platform': 'web',
          'x-version-number': '5.5.2'
        },
        timeout: 10000,
        maxRedirects: 0,
        validateStatus: s => s < 500
      });
      console.log(`  Status: ${resp.status}`);
      if (resp.status === 200) {
        const data = resp.data;
        if (typeof data === 'object') {
          if (Array.isArray(data)) {
            console.log(`  Array com ${data.length} elementos`);
            if (data.length > 0) {
              console.log('  Primeiro elemento:');
              logFields(data[0], '    ');
            }
          } else {
            console.log('  Campos:');
            logFields(data, '    ');
          }
        } else {
          console.log(`  Resposta: ${String(data).substring(0, 200)}`);
        }
      }
    } catch (e) {
      const status = e.response?.status;
      const msg = e.message;
      console.log(`  ${status || msg}`);
      if (status === 401) console.log('  → Requer autenticação');
      if (status === 403) console.log('  → Requer hCaptcha ou sessão');
    }
    await sleep(200);
  }
}

// ============================================================
// 4. PNCP Consulta API - resultado com mais detalhes
// ============================================================
async function testePNCPConsulta() {
  logSection('4. PNCP Consulta API - endpoints alternativos');

  // Tentar endpoint de consulta de resultado que pode ter mais campos
  const testUrls = [
    // Endpoint padrão já conhecido
    `${PNCP_CONSULTA}/contratacoes/publicacao?dataInicial=20250101&dataFinal=20250115&codigoModalidadeContratacao=8&pagina=1&tamanhoPagina=1`,
    // Atas de registro de preço (costumam ter marca)
    `${PNCP_CONSULTA}/atas?dataInicial=20250101&dataFinal=20250115&pagina=1&tamanhoPagina=1`,
  ];

  for (const url of testUrls) {
    console.log(`\n--- ${url.substring(url.indexOf('/v1'))}`);
    try {
      const resp = await axios.get(url, { timeout: 10000 });
      console.log(`  Status: ${resp.status}`);
      const items = resp.data?.data || [];
      if (items.length > 0) {
        console.log('  Primeiro resultado:');
        logFields(items[0], '    ');
      }
    } catch (e) {
      console.log(`  Erro: ${e.response?.status || e.message}`);
    }
    await sleep(200);
  }
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  INVESTIGAÇÃO: Fontes de Marca/Modelo de Vencedores        ║');
  console.log('║  Procurando campos: marca, fabricante, modelo, versao      ║');
  console.log('║  Campos marcados com ⭐⭐⭐ são os que procuramos          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  await testePNCP();
  await testeDadosAbertos();
  await testeComprasnet();
  await testePNCPConsulta();

  logSection('RESUMO');
  console.log(`
Campos a procurar nos resultados:
- marcaFabricante / marca / fabricante
- modeloVersao / modelo / versao  
- descricaoProposta / descricaoDetalhada

Se nenhum endpoint público retornar marca/modelo, 
as alternativas são:
1. Extrair do Electron Standalone (webview logado no Comprasnet)
2. Scrape do PDF da ata/resultado publicado no PNCP
3. Usar descrição do item + fornecedor como proxy
  `);
}

main().catch(console.error);
