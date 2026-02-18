/**
 * Módulo de Verificação e Correção de Lacunas
 * Importado pelo server.js para garantir dados completos
 *
 * Duas funções principais:
 * - verificarECorrigirLacunas: verificação rápida (após cada sync)
 * - verificacaoCompletaDiaria: verificação completa (uma vez por dia)
 */

const axios = require('axios');

const PNCP_API_BASE = 'https://pncp.gov.br/api/consulta/v1';
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';

// Modalidades a verificar
const MODALIDADES = [
  { id: 8, nome: 'Pregão Eletrônico' },
  { id: 6, nome: 'Dispensa' },
  { id: 1, nome: 'Leilão' },
  { id: 7, nome: 'Inexigibilidade' }
];

/**
 * Busca licitações de um dia específico
 */
async function buscarLicitacoesDoDiaModulo(dia, modalidade) {
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
      if (err.response && (err.response.status === 404 || err.response.status === 400)) {
        temMaisPaginas = false;
      } else {
        paginaAtual++;
      }
    }
  }

  return resultados;
}

/**
 * Busca itens de uma licitação
 */
async function buscarItensModulo(cnpj, ano, sequencial) {
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

/**
 * Gera lista de dias para verificar
 */
function gerarDias(quantidade) {
  const dias = [];
  for (let i = 0; i < quantidade; i++) {
    const data = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    dias.push(data.toISOString().split('T')[0]);
  }
  return dias;
}

/**
 * Corrige lacunas de um dia/modalidade específico
 */
async function corrigirLacuna(db, salvarLicitacao, salvarItens, dia, modalidade, faltando) {
  const licitacoes = await buscarLicitacoesDoDiaModulo(dia, modalidade.id);

  const existentes = db.prepare(`
    SELECT cnpj, anoCompra, sequencialCompra FROM licitacoes
    WHERE date(dataPublicacaoPncp) = ? AND modalidadeId = ?
  `).all(dia, modalidade.id);

  const existentesSet = new Set(existentes.map(e => `${e.cnpj}-${e.anoCompra}-${e.sequencialCompra}`));

  const novas = licitacoes.filter(l => {
    const key = `${l.orgaoEntidade.cnpj}-${l.anoCompra}-${l.sequencialCompra}`;
    return !existentesSet.has(key);
  });

  let corrigidas = 0;
  for (const lic of novas) {
    try {
      salvarLicitacao(lic);
      corrigidas++;

      const itens = await buscarItensModulo(
        lic.orgaoEntidade?.cnpj,
        lic.anoCompra,
        lic.sequencialCompra
      );

      if (itens.length > 0) {
        salvarItens(lic.numeroControlePNCP, itens);
      }
    } catch (e) {
      // Ignorar erros individuais
    }
  }

  return corrigidas;
}

/**
 * Cria as funções de verificação e correção
 */
function criarVerificador(db, salvarLicitacao, salvarItens) {

  /**
   * Corrige itens faltantes para licitações recentes
   * Busca licitações sem itens e tenta sincronizar da API
   */
  async function corrigirItensFaltantes(diasRecentes = 14, limite = 100) {
    console.log(`[ITENS] Verificando licitações sem itens (últimos ${diasRecentes} dias)...`);

    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - diasRecentes);
    const dataLimiteStr = dataLimite.toISOString().split('T')[0];

    const semItens = db.prepare(`
      SELECT l.id, l.cnpj, l.anoCompra, l.sequencialCompra, l.numeroControlePNCP, l.nomeUnidade
      FROM licitacoes l
      WHERE NOT EXISTS (SELECT 1 FROM itens i WHERE i.licitacaoId = l.id)
        AND date(l.dataPublicacaoPncp) >= ?
      ORDER BY l.dataPublicacaoPncp DESC
      LIMIT ?
    `).all(dataLimiteStr, limite);

    if (semItens.length === 0) {
      console.log(`[ITENS] Todas as licitações recentes têm itens sincronizados`);
      return 0;
    }

    console.log(`[ITENS] Encontradas ${semItens.length} licitações sem itens, sincronizando...`);

    let totalItens = 0;
    let corrigidas = 0;

    for (const l of semItens) {
      try {
        const itens = await buscarItensModulo(l.cnpj, l.anoCompra, l.sequencialCompra);

        if (itens.length > 0) {
          salvarItens(l.numeroControlePNCP, itens);
          totalItens += itens.length;
          corrigidas++;
        }

        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        // Ignorar erros individuais
      }
    }

    console.log(`[ITENS] Sincronizados ${totalItens} itens para ${corrigidas} licitações`);
    return corrigidas;
  }

  /**
   * Verificação rápida - executada após cada sync incremental
   * Verifica últimos 7 dias, corrige se faltar mais de 5
   */
  async function verificarECorrigirLacunas(diasVerificar = 7) {
    console.log(`[VERIFICAÇÃO] Verificando lacunas dos últimos ${diasVerificar} dias...`);

    const dias = gerarDias(diasVerificar);
    let totalCorrigido = 0;

    for (const mod of MODALIDADES) {
      for (const dia of dias) {
        try {
          const diaAPI = dia.replace(/-/g, '');
          const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
            params: {
              dataInicial: diaAPI,
              dataFinal: diaAPI,
              codigoModalidadeContratacao: mod.id,
              pagina: 1,
              tamanhoPagina: 10
            }
          });

          const naAPI = response.data.totalRegistros || 0;
          const noBanco = db.prepare(`
            SELECT COUNT(*) as total FROM licitacoes
            WHERE date(dataPublicacaoPncp) = ? AND modalidadeId = ?
          `).get(dia, mod.id).total;

          const faltando = naAPI - noBanco;

          // Corrige se faltar mais de 5 (threshold reduzido)
          if (faltando > 5) {
            console.log(`[VERIFICAÇÃO] ${dia} ${mod.nome}: faltam ${faltando}, corrigindo...`);
            const corrigidas = await corrigirLacuna(db, salvarLicitacao, salvarItens, dia, mod, faltando);
            totalCorrigido += corrigidas;
          }

          await new Promise(r => setTimeout(r, 100));
        } catch (e) {
          // Ignorar erros de API
        }
      }
    }

    if (totalCorrigido > 0) {
      console.log(`[VERIFICAÇÃO] Corrigidas ${totalCorrigido} licitações faltantes`);
    } else {
      console.log(`[VERIFICAÇÃO] Nenhuma lacuna significativa encontrada`);
    }

    // Também corrige itens faltantes de licitações recentes
    await corrigirItensFaltantes(7, 50);

    return totalCorrigido;
  }

  /**
   * Verificação completa diária - executada uma vez por dia
   * Verifica últimos 45 dias para garantir cobertura total
   * Corrige qualquer lacuna (threshold = 0)
   */
  async function verificacaoCompletaDiaria() {
    console.log(`[VERIFICAÇÃO DIÁRIA] Iniciando verificação completa (45 dias)...`);

    const dias = gerarDias(45);
    let totalCorrigido = 0;
    let lacunasEncontradas = 0;

    for (const mod of MODALIDADES) {
      for (const dia of dias) {
        try {
          const diaAPI = dia.replace(/-/g, '');
          const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
            params: {
              dataInicial: diaAPI,
              dataFinal: diaAPI,
              codigoModalidadeContratacao: mod.id,
              pagina: 1,
              tamanhoPagina: 10
            }
          });

          const naAPI = response.data.totalRegistros || 0;
          const noBanco = db.prepare(`
            SELECT COUNT(*) as total FROM licitacoes
            WHERE date(dataPublicacaoPncp) = ? AND modalidadeId = ?
          `).get(dia, mod.id).total;

          const faltando = naAPI - noBanco;

          // Corrige QUALQUER lacuna (não apenas > 10)
          if (faltando > 0) {
            lacunasEncontradas++;
            console.log(`[VERIFICAÇÃO DIÁRIA] ${dia} ${mod.nome}: faltam ${faltando}, corrigindo...`);
            const corrigidas = await corrigirLacuna(db, salvarLicitacao, salvarItens, dia, mod, faltando);
            totalCorrigido += corrigidas;
          }

          await new Promise(r => setTimeout(r, 50));
        } catch (e) {
          // Ignorar erros de API
        }
      }
    }

    console.log(`[VERIFICAÇÃO DIÁRIA] Concluída: ${lacunasEncontradas} lacunas encontradas, ${totalCorrigido} licitações corrigidas`);

    // Verificação completa de itens faltantes (últimos 45 dias, até 500 licitações)
    await corrigirItensFaltantes(45, 500);

    return totalCorrigido;
  }

  return {
    verificarECorrigirLacunas,
    verificacaoCompletaDiaria,
    corrigirItensFaltantes
  };
}

module.exports = { criarVerificador };
