/**
 * Script para sincronizar dadosCompletos das licitações faltantes
 */

const Database = require('better-sqlite3');
const https = require('https');

const db = new Database('pncp.db');

// Configuração
const DELAY_ENTRE_REQUISICOES = 200; // ms
const LOTE_SIZE = 100;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      timeout: 30000
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('JSON inválido: ' + data.substring(0, 100)));
        }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

async function buscarDadosLicitacao(cnpj, ano, sequencial) {
  // Formato correto da API do PNCP
  const url = `https://pncp.gov.br/api/consulta/v1/orgaos/${cnpj}/compras/${ano}/${sequencial}`;
  try {
    const dados = await fetchJSON(url);
    return dados;
  } catch (error) {
    return null;
  }
}

async function sincronizarDadosFaltantes() {
  console.log('===========================================');
  console.log('SINCRONIZAÇÃO DE DADOS COMPLETOS FALTANTES');
  console.log('===========================================\n');

  // Buscar licitações sem dadosCompletos
  const licitacoesSemDados = db.prepare(`
    SELECT id, cnpj, anoCompra, sequencialCompra, nomeUnidade
    FROM licitacoes
    WHERE dadosCompletos IS NULL OR dadosCompletos = '' OR dadosCompletos = '{}'
    ORDER BY id DESC
  `).all();

  console.log(`Total de licitações sem dadosCompletos: ${licitacoesSemDados.length}\n`);

  if (licitacoesSemDados.length === 0) {
    console.log('Nenhuma licitação para sincronizar!');
    return;
  }

  // Preparar statement de atualização
  const updateStmt = db.prepare(`
    UPDATE licitacoes
    SET dadosCompletos = ?,
        dataAtualizacao = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  let sincronizados = 0;
  let erros = 0;
  let naoEncontrados = 0;
  const inicio = Date.now();

  for (let i = 0; i < licitacoesSemDados.length; i++) {
    const lic = licitacoesSemDados[i];

    // Mostrar progresso
    if (i % 50 === 0 || i === licitacoesSemDados.length - 1) {
      const percentual = ((i + 1) / licitacoesSemDados.length * 100).toFixed(1);
      const tempoDecorrido = ((Date.now() - inicio) / 1000 / 60).toFixed(1);
      const velocidade = (i + 1) / ((Date.now() - inicio) / 1000);
      const restante = ((licitacoesSemDados.length - i - 1) / velocidade / 60).toFixed(1);

      console.log(`[${percentual}%] ${i + 1}/${licitacoesSemDados.length} | ` +
                  `OK: ${sincronizados} | Erros: ${erros} | Não encontrados: ${naoEncontrados} | ` +
                  `Tempo: ${tempoDecorrido}min | Restante: ~${restante}min`);
    }

    try {
      const dados = await buscarDadosLicitacao(lic.cnpj, lic.anoCompra, lic.sequencialCompra);

      if (dados && dados.anoCompra) {
        // Sucesso - atualizar banco
        updateStmt.run(JSON.stringify(dados), lic.id);
        sincronizados++;
      } else if (dados && dados.message) {
        // API retornou erro (licitação não existe mais)
        naoEncontrados++;
      } else {
        erros++;
      }
    } catch (error) {
      erros++;
      if (erros <= 5) {
        console.error(`  Erro em ${lic.cnpj}/${lic.anoCompra}/${lic.sequencialCompra}: ${error.message}`);
      }
    }

    // Delay entre requisições
    await sleep(DELAY_ENTRE_REQUISICOES);
  }

  const tempoTotal = ((Date.now() - inicio) / 1000 / 60).toFixed(1);

  console.log('\n===========================================');
  console.log('SINCRONIZAÇÃO CONCLUÍDA');
  console.log('===========================================');
  console.log(`Total processado: ${licitacoesSemDados.length}`);
  console.log(`Sincronizados com sucesso: ${sincronizados}`);
  console.log(`Não encontrados na API: ${naoEncontrados}`);
  console.log(`Erros: ${erros}`);
  console.log(`Tempo total: ${tempoTotal} minutos`);
  console.log('===========================================\n');

  // Verificar quantos ainda faltam
  const aindaFaltam = db.prepare(`
    SELECT COUNT(*) as count FROM licitacoes
    WHERE dadosCompletos IS NULL OR dadosCompletos = '' OR dadosCompletos = '{}'
  `).get();

  console.log(`Licitações ainda sem dadosCompletos: ${aindaFaltam.count}`);
}

// Executar
sincronizarDadosFaltantes().catch(console.error);
