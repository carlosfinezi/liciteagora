/**
 * Script de Verificação e Correção de Sincronização
 *
 * Verifica lacunas entre o banco local e a API do PNCP
 * e sincroniza automaticamente os dados faltantes.
 *
 * Uso: node verificar-e-corrigir-sync.js [--dias N] [--corrigir]
 *   --dias N    : Verificar últimos N dias (padrão: 14)
 *   --corrigir  : Corrigir automaticamente as lacunas encontradas
 */

const Database = require('better-sqlite3');
const axios = require('axios');
const path = require('path');

const dbPath = path.join(__dirname, 'pncp.db');
const db = new Database(dbPath);

// NFSE-M06 onda 6.45 (2026-04-20): PNCP_API_BASE/PNCP_API_ITENS
// migrados para require('./config') -- unica fonte de verdade.
const { PNCP_API_BASE, PNCP_API_ITENS } = require('./config');

// Modalidades a verificar
const MODALIDADES = [
  { id: 8, nome: 'Pregão Eletrônico' },
  { id: 6, nome: 'Dispensa de Licitação' },
  { id: 1, nome: 'Leilão' },
  { id: 7, nome: 'Inexigibilidade' }
];

// Parsear argumentos
const args = process.argv.slice(2);
const diasVerificar = parseInt(args.find(a => a.startsWith('--dias='))?.split('=')[1]) || 14;
const deveCorrigir = args.includes('--corrigir');

async function contarNaAPI(dia, modalidade) {
  const diaAPI = dia.replace(/-/g, '');
  try {
    const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
      params: {
        dataInicial: diaAPI,
        dataFinal: diaAPI,
        codigoModalidadeContratacao: modalidade,
        pagina: 1,
        tamanhoPagina: 10
      }
    });
    return response.data.totalRegistros || 0;
  } catch {
    return -1; // Erro
  }
}

function contarNoBanco(dia, modalidade) {
  const result = db.prepare(`
    SELECT COUNT(*) as total FROM licitacoes
    WHERE date(dataPublicacaoPncp) = ? AND modalidadeId = ?
  `).get(dia, modalidade);
  return result.total;
}

async function buscarLicitacoesDoDia(dia, modalidade) {
  const resultados = [];
  let paginaAtual = 1;
  let temMaisPaginas = true;
  const diaAPI = dia.replace(/-/g, '');

  while (temMaisPaginas && paginaAtual <= 200) {
    try {
      const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
        params: {
          dataInicial: diaAPI,
          dataFinal: diaAPI,
          codigoModalidadeContratacao: modalidade,
          pagina: paginaAtual,
          tamanhoPagina: 50
        }
      });

      const dados = response.data;
      if (dados.data && dados.data.length > 0) {
        resultados.push(...dados.data);
        paginaAtual++;
        temMaisPaginas = dados.data.length === 50;
      } else {
        temMaisPaginas = false;
      }
    } catch (err) {
      if (err.response && err.response.status === 404) {
        temMaisPaginas = false;
      } else {
        paginaAtual++;
      }
    }
  }

  return resultados;
}

async function buscarItensDaLicitacao(cnpj, ano, sequencial) {
  try {
    const response = await axios.get(
      `${PNCP_API_ITENS}/orgaos/${cnpj}/compras/${ano}/${sequencial}/itens`,
      { params: { pagina: 1, tamanhoPagina: 500 } }
    );
    return response.data || [];
  } catch {
    return [];
  }
}

async function corrigirLacuna(dia, modalidade, modalidadeNome) {
  console.log(`\n  [CORRIGINDO] ${dia} - ${modalidadeNome}...`);

  const licitacoes = await buscarLicitacoesDoDia(dia, modalidade);
  console.log(`    API retornou: ${licitacoes.length} licitações`);

  // Verificar quais já existem
  const existentes = db.prepare(`
    SELECT cnpj, anoCompra, sequencialCompra FROM licitacoes
    WHERE date(dataPublicacaoPncp) = ? AND modalidadeId = ?
  `).all(dia, modalidade);

  const existentesSet = new Set(existentes.map(e => `${e.cnpj}-${e.anoCompra}-${e.sequencialCompra}`));

  const novas = licitacoes.filter(l => {
    const key = `${l.orgaoEntidade.cnpj}-${l.anoCompra}-${l.sequencialCompra}`;
    return !existentesSet.has(key);
  });

  if (novas.length === 0) {
    console.log(`    Nenhuma nova para inserir.`);
    return { licitacoes: 0, itens: 0 };
  }

  console.log(`    Novas para inserir: ${novas.length}`);

  const insertLicitacao = db.prepare(`
    INSERT OR REPLACE INTO licitacoes (
      numeroControlePNCP, cnpj, razaoSocial, ufSigla, municipioNome, nomeUnidade, codigoUnidade,
      anoCompra, sequencialCompra, numeroCompra, processo, modalidadeId, modalidadeNome,
      objetoCompra, informacaoComplementar, valorTotalEstimado, dataPublicacaoPncp,
      dataAberturaProposta, dataEncerramentoProposta, situacaoCompraNome, linkSistemaOrigem,
      srp, dataAtualizacao, usuarioNome
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
  `);

  const insertItem = db.prepare(`
    INSERT OR REPLACE INTO itens (
      licitacaoId, numeroItem, descricao, quantidade, unidadeMedida,
      valorUnitarioEstimado, valorTotal
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let inseridas = 0;
  let itensInseridos = 0;

  for (const lic of novas) {
    try {
      const result = insertLicitacao.run(
        lic.numeroControlePNCP,
        lic.orgaoEntidade?.cnpj,
        lic.orgaoEntidade?.razaoSocial,
        lic.unidadeOrgao?.ufSigla,
        lic.unidadeOrgao?.municipioNome,
        lic.unidadeOrgao?.nomeUnidade,
        lic.unidadeOrgao?.codigoUnidade,
        lic.anoCompra,
        lic.sequencialCompra,
        lic.numeroCompra,
        lic.processo,
        lic.modalidadeId,
        lic.modalidadeNome,
        lic.objetoCompra,
        lic.informacaoComplementar,
        lic.valorTotalEstimado,
        lic.dataPublicacaoPncp,
        lic.dataAberturaProposta,
        lic.dataEncerramentoProposta,
        lic.situacaoCompraNome,
        lic.linkSistemaOrigem,
        lic.srp ? 1 : 0,
        lic.usuarioNome
      );

      const licitacaoId = result.lastInsertRowid;
      inseridas++;

      const itens = await buscarItensDaLicitacao(
        lic.orgaoEntidade?.cnpj,
        lic.anoCompra,
        lic.sequencialCompra
      );

      for (const item of itens) {
        insertItem.run(
          licitacaoId,
          item.numeroItem,
          item.descricao,
          item.quantidade,
          item.unidadeMedida,
          item.valorUnitarioEstimado,
          item.valorTotal
        );
        itensInseridos++;
      }
    } catch (err) {
      // Ignorar erros individuais
    }
  }

  console.log(`    Inseridas: ${inseridas} licitações, ${itensInseridos} itens`);
  return { licitacoes: inseridas, itens: itensInseridos };
}

async function main() {
  console.log('='.repeat(70));
  console.log('VERIFICAÇÃO E CORREÇÃO DE SINCRONIZAÇÃO');
  console.log('='.repeat(70));
  console.log(`Data atual: ${new Date().toISOString().split('T')[0]}`);
  console.log(`Verificando últimos ${diasVerificar} dias`);
  console.log(`Modo: ${deveCorrigir ? 'VERIFICAR E CORRIGIR' : 'APENAS VERIFICAR'}`);
  console.log('');

  const lacunas = [];
  let totalFaltando = 0;

  // Gerar lista de dias
  const dias = [];
  for (let i = 0; i < diasVerificar; i++) {
    const data = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dias.push(data.toISOString().split('T')[0]);
  }

  // Verificar cada dia e modalidade
  for (const mod of MODALIDADES) {
    console.log(`\n[${mod.nome}] (modalidade ${mod.id})`);

    for (const dia of dias) {
      const naAPI = await contarNaAPI(dia, mod.id);
      const noBanco = contarNoBanco(dia, mod.id);

      if (naAPI === -1) {
        console.log(`  ${dia}: ERRO na API`);
        continue;
      }

      const diff = naAPI - noBanco;

      if (diff > 0) {
        console.log(`  ${dia}: API=${naAPI}, Banco=${noBanco} [FALTAM ${diff}]`);
        lacunas.push({ dia, modalidade: mod.id, modalidadeNome: mod.nome, faltando: diff });
        totalFaltando += diff;
      } else if (diff < 0) {
        console.log(`  ${dia}: API=${naAPI}, Banco=${noBanco} [+${Math.abs(diff)} extras]`);
      } else {
        console.log(`  ${dia}: ${naAPI} OK`);
      }

      // Pequena pausa
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Resumo
  console.log('\n' + '='.repeat(70));
  console.log('RESUMO');
  console.log('='.repeat(70));

  if (lacunas.length === 0) {
    console.log('Nenhuma lacuna encontrada! Banco está sincronizado.');
  } else {
    console.log(`Lacunas encontradas: ${lacunas.length}`);
    console.log(`Total de licitações faltando: ${totalFaltando}`);
    console.log('');

    if (deveCorrigir) {
      console.log('Iniciando correção...');

      let totalLicitacoes = 0;
      let totalItens = 0;

      for (const lacuna of lacunas) {
        const resultado = await corrigirLacuna(lacuna.dia, lacuna.modalidade, lacuna.modalidadeNome);
        totalLicitacoes += resultado.licitacoes;
        totalItens += resultado.itens;
      }

      console.log('\n' + '='.repeat(70));
      console.log('CORREÇÃO CONCLUÍDA');
      console.log('='.repeat(70));
      console.log(`Licitações inseridas: ${totalLicitacoes}`);
      console.log(`Itens inseridos: ${totalItens}`);
    } else {
      console.log('\nPara corrigir, execute com: node verificar-e-corrigir-sync.js --corrigir');
    }
  }

  db.close();
}

main().catch(err => {
  console.error('Erro:', err);
  db.close();
});
