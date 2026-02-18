const Database = require('better-sqlite3');
const axios = require('axios');

const db = new Database('pncp.db');
const PNCP_API_ITENS = 'https://pncp.gov.br/api/pncp/v1';

// Prepared statements
const getLicitacaoId = db.prepare('SELECT id FROM licitacoes WHERE numeroControlePNCP = ?');
const deleteItens = db.prepare('DELETE FROM itens WHERE numeroControlePNCP = ?');
const insertItem = db.prepare(`
  INSERT INTO itens (licitacaoId, numeroControlePNCP, numeroItem, descricao, quantidade,
                     unidadeMedida, valorUnitarioEstimado, valorTotal, dadosCompletos)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function salvarItens(numeroControlePNCP, itens) {
  try {
    const licitacaoRow = getLicitacaoId.get(numeroControlePNCP);
    if (!licitacaoRow) return false;

    deleteItens.run(numeroControlePNCP);

    for (const item of itens) {
      insertItem.run(
        licitacaoRow.id,
        numeroControlePNCP,
        item.numeroItem,
        item.descricao,
        item.quantidade,
        item.unidadeMedida,
        item.valorUnitarioEstimado,
        item.valorTotal,
        JSON.stringify(item)
      );
    }
    return true;
  } catch (err) {
    console.error('Erro ao salvar itens:', err.message);
    return false;
  }
}

async function buscarItensLicitacao(cnpj, ano, sequencial, retries = 3) {
  for (let tentativa = 1; tentativa <= retries; tentativa++) {
    try {
      const todosItens = [];
      let pagina = 1;
      let temMais = true;

      while (temMais) {
        const response = await axios.get(
          `${PNCP_API_ITENS}/orgaos/${cnpj}/compras/${ano}/${sequencial}/itens`,
          {
            params: { pagina, tamanhoPagina: 100 },
            headers: { 'Accept': 'application/json' },
            timeout: 30000
          }
        );

        const itens = response.data || [];
        if (itens.length > 0) {
          todosItens.push(...itens);
          pagina++;
          if (itens.length < 100) temMais = false;
          await new Promise(r => setTimeout(r, 100));
        } else {
          temMais = false;
        }
      }

      return todosItens;
    } catch (err) {
      if (tentativa < retries) {
        console.log(`    Tentativa ${tentativa} falhou, aguardando retry...`);
        await new Promise(r => setTimeout(r, 2000 * tentativa));
      } else {
        console.log(`    Falha após ${retries} tentativas: ${err.message}`);
        return [];
      }
    }
  }
  return [];
}

async function sincronizarItensFaltantes() {
  console.log('======================================================================');
  console.log('SINCRONIZAÇÃO DE ITENS FALTANTES');
  console.log('======================================================================');
  console.log(`Data: ${new Date().toISOString()}\n`);

  // Buscar licitações sem itens
  const semItens = db.prepare(`
    SELECT l.id, l.cnpj, l.anoCompra, l.sequencialCompra, l.numeroControlePNCP,
           l.nomeUnidade, l.modalidadeNome, l.dataPublicacaoPncp
    FROM licitacoes l
    WHERE NOT EXISTS (SELECT 1 FROM itens i WHERE i.licitacaoId = l.id)
    ORDER BY l.dataPublicacaoPncp DESC
  `).all();

  console.log(`Total de licitações sem itens: ${semItens.length}\n`);

  let totalItensInseridos = 0;
  let licitacoesCorrigidas = 0;
  let licitacoesSemItensAPI = 0;
  let erros = 0;

  for (let i = 0; i < semItens.length; i++) {
    const l = semItens[i];

    process.stdout.write(`[${i + 1}/${semItens.length}] ${l.nomeUnidade?.substring(0, 40)}...`);

    const itens = await buscarItensLicitacao(l.cnpj, l.anoCompra, l.sequencialCompra);

    if (itens.length > 0) {
      const salvou = salvarItens(l.numeroControlePNCP, itens);
      if (salvou) {
        console.log(` ${itens.length} itens`);
        totalItensInseridos += itens.length;
        licitacoesCorrigidas++;
      } else {
        console.log(' ERRO ao salvar');
        erros++;
      }
    } else {
      console.log(' 0 itens na API');
      licitacoesSemItensAPI++;
    }

    // Pequeno delay para não sobrecarregar a API
    await new Promise(r => setTimeout(r, 150));

    // Progresso a cada 100
    if ((i + 1) % 100 === 0) {
      console.log(`\n--- Progresso: ${i + 1}/${semItens.length} | Corrigidas: ${licitacoesCorrigidas} | Itens: ${totalItensInseridos} ---\n`);
    }
  }

  console.log('\n======================================================================');
  console.log('RESUMO');
  console.log('======================================================================');
  console.log(`Licitações processadas: ${semItens.length}`);
  console.log(`Licitações corrigidas: ${licitacoesCorrigidas}`);
  console.log(`Licitações sem itens na API: ${licitacoesSemItensAPI}`);
  console.log(`Total de itens inseridos: ${totalItensInseridos}`);
  console.log(`Erros: ${erros}`);

  db.close();
}

sincronizarItensFaltantes().catch(err => {
  console.error('Erro geral:', err);
  db.close();
});
