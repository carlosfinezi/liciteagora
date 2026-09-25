/**
 * Módulo de Verificação e Correção de Lacunas
 * Importado pelo server.js para garantir dados completos
 *
 * Duas funções principais:
 * - verificarECorrigirLacunas: verificação rápida (após cada sync)
 * - verificacaoCompletaDiaria: verificação completa (uma vez por dia)
 */

const axios = require('axios');

// NFSE-M06 onda 6.45 (2026-04-20): PNCP_API_BASE/PNCP_API_ITENS
// migrados para require('./config') -- unica fonte de verdade.
const { PNCP_API_BASE, PNCP_API_ITENS } = require('./config');

// Modalidades a verificar. Os nomes estavam trocados entre 6 e 8 — conferido
// contra a coluna `modalidadeNome` do catálogo, que traz "Pregão - Eletrônico"
// para 6 e "Dispensa" para 8. O rótulo só aparece no log, mas o log é o que se
// lê quando algo quebra, e ele apontava a modalidade errada.
const MODALIDADES = [
  { id: 6, nome: 'Pregão Eletrônico' },
  { id: 8, nome: 'Dispensa' },
  { id: 1, nome: 'Leilão' },
  { id: 7, nome: 'Inexigibilidade' }
];

// Teto de licitações gravadas por rodada de verificação. Sem ele, uma lacuna
// real de dezenas de milhares faz a rodada baixar o catálogo inteiro e o PNCP
// estrangula o IP — foi o que aconteceu em 22/09/2026, com 69 rodadas num dia,
// 2.380 timeouts e 856 respostas 429. A lacuna é fechada em várias rodadas,
// que é o que a janela de verificação permite.
const TETO_POR_RODADA = 800;

// Quanto tempo ficar quieto depois que a API sinalizou excesso. Parar a rodada
// não basta: a próxima começa 5 minutos depois e o bloqueio nunca expira,
// porque cada tentativa o renova. Este é o degrau que falta para o sistema sair
// sozinho do estado em que entrou em 22/09/2026.
//
// O estado do silêncio vive DENTRO de `criarVerificador`, e não no módulo: como
// variável de módulo ele seria compartilhado por todos os verificadores criados
// no processo, e um tenant em cooldown calaria os outros.
const COOLDOWN_APOS_EXCESSO_MS = 20 * 60 * 1000;

/**
 * Os pares (modalidade × dia) a visitar, com o ponto de partida girando a cada
 * passada.
 *
 * Sem o rodízio a varredura começava SEMPRE no mesmo alvo — pregão, dia de hoje
 * — e, como ela para no primeiro sinal de excesso, os alvos do fim da fila
 * nunca eram alcançados. Em 23/09/2026 isso deixou 21 e 22/09 parados em 323 e
 * 3.603 enquanto cada passada gastava os 50 registros que a API concedia no dia
 * corrente. Girando a partida, todos os alvos recebem sua vez ao longo das
 * passadas, e a lacuna fecha por igual em vez de só na frente da fila.
 */
function alvosComRodizio(dias, contador) {
  const alvos = [];
  for (const mod of MODALIDADES) for (const dia of dias) alvos.push({ mod, dia });
  if (alvos.length === 0) return alvos;
  const corte = contador % alvos.length;
  return alvos.slice(corte).concat(alvos.slice(0, corte));
}

// Parar de vez quando a API sinaliza excesso. 429 é a resposta explícita, e o
// timeout repetido é o mesmo recado sem status: insistir depois disso só
// aprofunda o bloqueio.
function eSinalDeExcesso(err) {
  const st = err && err.response && err.response.status;
  if (st === 429 || st === 503 || st === 502) return true;
  const code = err && err.code;
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
}

/**
 * Busca licitações de um dia específico
 */
const PAGINA_TAM = 50;

/**
 * Uma página do dia/modalidade. Devolve `{ licitacoes, fim, excesso }`.
 *
 * A paginação passou a ser consumida PÁGINA A PÁGINA por quem corrige (ver
 * `corrigirLacuna`) em vez de juntar o dia inteiro numa lista antes de gravar.
 * O motivo é aritmética: com teto de 800 gravações por rodada, baixar as 200
 * páginas possíveis significaria pedir 10.000 licitações à API para usar 800, e
 * repetir o mesmo download na rodada seguinte. Parando de pedir quando o teto
 * chega, a rodada custa o que ela realmente aproveita.
 */
async function buscarPaginaDoDia(dia, modalidade, pagina) {
  const diaAPI = dia.replace(/-/g, '');
  try {
    const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
      params: {
        dataInicial: diaAPI,
        dataFinal: diaAPI,
        codigoModalidadeContratacao: modalidade,
        pagina,
        tamanhoPagina: PAGINA_TAM
      },
      timeout: 20000
    });
    const dados = response.data && response.data.data ? response.data.data : [];
    return { licitacoes: dados, fim: dados.length < PAGINA_TAM, excesso: false };
  } catch (err) {
    if (err.response && (err.response.status === 404 || err.response.status === 400)) {
      return { licitacoes: [], fim: true, excesso: false };
    }
    if (eSinalDeExcesso(err)) {
      // Antes daqui saía `paginaAtual++`, que PULAVA a página recusada e seguia
      // batendo: a página nunca era relida e a pressão continuava contra um IP
      // que a API já estava recusando.
      return { licitacoes: [], fim: true, excesso: true };
    }
    // Erro transitório de uma página: segue para a próxima, como antes.
    return { licitacoes: [], fim: false, excesso: false };
  }
}

/**
 * Busca itens de uma licitação
 */
async function buscarItensModulo(cnpj, ano, sequencial) {
  try {
    const response = await axios.get(
      `${PNCP_API_ITENS}/orgaos/${cnpj}/compras/${ano}/${sequencial}/itens`,
      { params: { pagina: 1, tamanhoPagina: 500 }, timeout: 20000 }
    );
    return response.data || [];
  } catch (err) {
    // O `catch` daqui engolia TUDO, inclusive o 429. Como esta função é chamada
    // uma vez por licitação dentro do loop de correção, era por ela que o freio
    // vazava: a API já recusava e a rodada seguia pedindo itens licitação após
    // licitação. Erro individual continua virando lista vazia; só o sinal de
    // excesso sobe, para quem chamou poder parar. Sem `timeout` explícito o
    // axios espera indefinidamente, e uma conexão pendurada segura a rodada
    // inteira — foi o que os `HTTP 000` de 40s mostraram.
    if (eSinalDeExcesso(err)) throw err;
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

// ─── Onde o catálogo realmente mora ────────────────────────────────────────
//
// As ESCRITAS vão para o Postgres desde `CATALOG_BACKEND_PG=1`, mas estas
// leituras continuavam no SQLite, cuja última licitação é de 23/05/2026. O
// efeito é o pior possível: a verificação conclui que faltam TODAS as
// licitações de TODOS os dias, refaz o download completo a cada rodada, e o
// PNCP passa a recusar as chamadas. A lacuna nunca fecha porque nunca foi lida
// do lugar certo.
const USE_PG = () => process.env.CATALOG_BACKEND_PG === '1';

async function contarNoBanco(db, dia, modalidadeId) {
  if (USE_PG()) {
    const r = await require('./catalog-pg').queryOne(
      `SELECT COUNT(*)::int AS total FROM licitacoes
        WHERE date("dataPublicacaoPncp") = $1 AND "modalidadeId" = $2`,
      [dia, modalidadeId]);
    return Number(r?.total || 0);
  }
  return db.prepare(`
    SELECT COUNT(*) as total FROM licitacoes
    WHERE date(dataPublicacaoPncp) = ? AND modalidadeId = ?
  `).get(dia, modalidadeId).total;
}

async function listarExistentes(db, dia, modalidadeId) {
  if (USE_PG()) {
    return require('./catalog-pg').query(
      `SELECT "cnpj", "anoCompra", "sequencialCompra" FROM licitacoes
        WHERE date("dataPublicacaoPncp") = $1 AND "modalidadeId" = $2`,
      [dia, modalidadeId]);
  }
  return db.prepare(`
    SELECT cnpj, anoCompra, sequencialCompra FROM licitacoes
    WHERE date(dataPublicacaoPncp) = ? AND modalidadeId = ?
  `).all(dia, modalidadeId);
}

/**
 * Corrige lacunas de um dia/modalidade específico.
 *
 * Devolve `{ corrigidas, excesso }`: `excesso` avisa quem chamou que a API
 * pediu para parar, e é o que impede a rodada seguinte de insistir contra um
 * IP já bloqueado.
 */
async function corrigirLacuna(db, salvarLicitacao, salvarItens, dia, modalidade, faltando, teto = TETO_POR_RODADA, maxPaginas = 200) {
  const existentes = await listarExistentes(db, dia, modalidade.id);
  const existentesSet = new Set(existentes.map(e => `${e.cnpj}-${e.anoCompra}-${e.sequencialCompra}`));

  let corrigidas = 0;

  // Onde começar a paginar. Sempre da página 1 era um poço: com 500 registros
  // já gravados, as dez primeiras páginas voltam inteiras conhecidas, o filtro
  // de existentes descarta tudo, e a passada gasta dez requisições SEM GRAVAR
  // NADA antes de alcançar a primeira página útil. Com a API concedendo poucas
  // chamadas por vez, ela nunca chegava lá: em 23/09/2026 uma passada fechou
  // com "2 lacunas encontradas, 0 licitações corrigidas".
  //
  // A premissa é que a ordem da API dentro de um MESMO dia é estável — o
  // intervalo é fechado (`dataInicial = dataFinal`), então não há registro
  // novo empurrando os antigos para a frente. Uma página de recuo cobre o
  // desalinhamento comum. Se a premissa falhar, o custo é uma passada que
  // grava menos: a contagem continua acusando a diferença e o rodízio traz o
  // dia de volta.
  const jaTemos = existentesSet.size;
  const paginaInicial = Math.max(1, Math.floor(jaTemos / PAGINA_TAM) - 1);

  for (let pagina = paginaInicial; pagina <= maxPaginas; pagina++) {
    if (corrigidas >= teto) break;

    const p = await buscarPaginaDoDia(dia, modalidade.id, pagina);
    if (p.excesso) return { corrigidas, excesso: true };

    for (const lic of p.licitacoes) {
      if (corrigidas >= teto) break;
      const key = `${lic.orgaoEntidade?.cnpj}-${lic.anoCompra}-${lic.sequencialCompra}`;
      if (existentesSet.has(key)) continue;

      try {
        // `await`: em modo Postgres `salvarLicitacao` é async, e sem esperar o
        // contador virava ficção — em 19/09/2026 ele reportou 110.219
        // corrigidas enquanto o catálogo ganhava zero licitações daquele dia.
        // Pior que o número errado: centenas de promises soltas contra o pool
        // ao mesmo tempo.
        const ok = await salvarLicitacao(lic);
        if (ok === false) continue;
        corrigidas++;
        existentesSet.add(key);

        const itens = await buscarItensModulo(
          lic.orgaoEntidade?.cnpj,
          lic.anoCompra,
          lic.sequencialCompra
        );

        if (itens.length > 0) {
          await salvarItens(lic.numeroControlePNCP, itens);
        }
      } catch (e) {
        if (eSinalDeExcesso(e)) return { corrigidas, excesso: true };
        // Erro individual de uma licitação não derruba o resto do dia.
      }
    }

    if (p.fim) break;
  }

  return { corrigidas, excesso: false };
}

/**
 * Cria as funções de verificação e correção
 */
function criarVerificador(db, salvarLicitacao, salvarItens) {

  // Um silêncio POR ROTINA, e não um só compartilhado.
  //
  // Compartilhado, a verificação rápida — que roda de 5 em 5 minutos — rearmava
  // os 20 minutos antes de toda tentativa da varredura de 45 dias, e esta
  // encontrava o cooldown sempre armado: `Em silêncio por mais 17 min`, depois
  // `por mais 14 min`, indefinidamente. Em 23/09/2026 a rápida corrigiu o dia
  // corrente (1.489 licitações em 23/09) enquanto 21 e 22/09 ficaram parados
  // em 323 e 3.603, porque só a varredura de 45 dias os alcança e ela nunca
  // chegou a rodar. Repetir a diária mais vezes não resolveria: o problema não
  // era a frequência dela, era a rápida calando-a.
  // Ponto de partida do rodízio, um por rotina: elas varrem listas de tamanhos
  // diferentes (3 dias contra 45) e não devem compartilhar a posição.
  let rodizioRapida = 0;
  let rodizioDiaria = 0;

  const silencioAte = { rapida: 0, diaria: 0 };
  const emCooldown = (quem) => Date.now() < silencioAte[quem];
  const marcarExcesso = (quem) => { silencioAte[quem] = Date.now() + COOLDOWN_APOS_EXCESSO_MS; };
  const minutosDeSilencioRestantes = (quem) => Math.max(0, Math.ceil((silencioAte[quem] - Date.now()) / 60000));

  /**
   * Corrige itens faltantes para licitações recentes
   * Busca licitações sem itens e tenta sincronizar da API
   */
  async function corrigirItensFaltantes(diasRecentes = 14, limite = 100, quem = 'rapida') {
    if (emCooldown(quem)) {
      console.log(`[ITENS] Em silêncio por mais ${minutosDeSilencioRestantes(quem)} min`);
      return 0;
    }
    console.log(`[ITENS] Verificando licitações sem itens (últimos ${diasRecentes} dias)...`);

    const dataLimite = new Date();
    dataLimite.setDate(dataLimite.getDate() - diasRecentes);
    const dataLimiteStr = dataLimite.toISOString().split('T')[0];

    // Mesma correção da contagem: o dado está no Postgres, e ler no SQLite
    // congelado devolvia lista vazia — daí o "Todas as licitações recentes têm
    // itens sincronizados" que aparecia no log com o catálogo sem itens.
    const semItens = USE_PG()
      ? await require('./catalog-pg').query(`
          SELECT l."id", l."cnpj", l."anoCompra", l."sequencialCompra", l."numeroControlePNCP"
            FROM licitacoes l
           WHERE NOT EXISTS (SELECT 1 FROM itens i WHERE i."licitacaoId" = l."id")
             AND date(l."dataPublicacaoPncp") >= $1
           ORDER BY l."dataPublicacaoPncp" DESC
           LIMIT $2`, [dataLimiteStr, limite])
      : db.prepare(`
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
          await salvarItens(l.numeroControlePNCP, itens);
          totalItens += itens.length;
          corrigidas++;
        }

        await new Promise(r => setTimeout(r, 100));
      } catch (e) {
        if (eSinalDeExcesso(e)) {
          // Este ponto também entra em silêncio: a busca de itens é uma chamada
          // POR LICITAÇÃO e roda ao fim de toda rodada de verificação, então
          // deixá-la de fora do cooldown manteria a pressão pela porta dos
          // fundos, que é exatamente como o freio vazou da primeira vez.
          marcarExcesso(quem);
          console.log(`[ITENS] API do PNCP recusando chamadas; silêncio por ${minutosDeSilencioRestantes(quem)} min`);
          break;
        }
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
    if (emCooldown('rapida')) {
      console.log(`[VERIFICAÇÃO] Em silêncio por mais ${minutosDeSilencioRestantes('rapida')} min — a API do PNCP sinalizou excesso`);
      return 0;
    }
    console.log(`[VERIFICAÇÃO] Verificando lacunas dos últimos ${diasVerificar} dias...`);

    const dias = gerarDias(diasVerificar);
    let totalCorrigido = 0;
    let parouPorExcesso = false;

    for (const { mod, dia } of alvosComRodizio(dias, rodizioRapida++)) {
      {
        if (parouPorExcesso) break;
        if (totalCorrigido >= TETO_POR_RODADA) {
          console.log(`[VERIFICAÇÃO] Teto de ${TETO_POR_RODADA} por rodada atingido; o resto fica para a próxima`);
          parouPorExcesso = true;
          break;
        }
        try {
          const diaAPI = dia.replace(/-/g, '');
          const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
            params: {
              dataInicial: diaAPI,
              dataFinal: diaAPI,
              codigoModalidadeContratacao: mod.id,
              pagina: 1,
              tamanhoPagina: 10
            },
            timeout: 20000
          });

          const naAPI = response.data.totalRegistros || 0;
          const noBanco = await contarNoBanco(db, dia, mod.id);

          const faltando = naAPI - noBanco;

          // Corrige se faltar mais de 5 (threshold reduzido)
          if (faltando > 5) {
            console.log(`[VERIFICAÇÃO] ${dia} ${mod.nome}: faltam ${faltando} (API ${naAPI}, banco ${noBanco}), corrigindo...`);
            const r = await corrigirLacuna(db, salvarLicitacao, salvarItens, dia, mod,
                                           faltando, TETO_POR_RODADA - totalCorrigido);
            totalCorrigido += r.corrigidas;
            if (r.excesso) {
              marcarExcesso('rapida');
              console.log(`[VERIFICAÇÃO] API do PNCP recusando chamadas; parando e ficando em silêncio por ${minutosDeSilencioRestantes('rapida')} min`);
              parouPorExcesso = true;
            }
          }

          await new Promise(r => setTimeout(r, 100));
        } catch (e) {
          if (eSinalDeExcesso(e)) {
            marcarExcesso('rapida');
            console.log(`[VERIFICAÇÃO] API do PNCP recusando chamadas; parando e ficando em silêncio por ${minutosDeSilencioRestantes('rapida')} min`);
            parouPorExcesso = true;
          }
          // Demais erros de API: segue para o próximo dia.
        }
      }
    }

    if (totalCorrigido > 0) {
      console.log(`[VERIFICAÇÃO] Corrigidas ${totalCorrigido} licitações faltantes`);
    } else {
      console.log(`[VERIFICAÇÃO] Nenhuma lacuna significativa encontrada`);
    }

    // Também corrige itens faltantes de licitações recentes
    await corrigirItensFaltantes(7, 50, 'rapida');

    return totalCorrigido;
  }

  /**
   * Verificação completa diária - executada uma vez por dia
   * Verifica últimos 45 dias para garantir cobertura total
   * Corrige qualquer lacuna (threshold = 0)
   */
  async function verificacaoCompletaDiaria() {
    if (emCooldown('diaria')) {
      // Sem esta guarda a diária gastava uma chamada durante o silêncio, tomava
      // 429 e chamava `marcarExcesso()` de novo — ou seja, ela mesma REARMAVA o
      // cooldown a cada repetição, e a verificação rápida ficava calada para
      // sempre. Devolver `incompleta` mantém a repetição sem tocar na API.
      console.log(`[VERIFICAÇÃO DIÁRIA] Em silêncio por mais ${minutosDeSilencioRestantes('diaria')} min; adiando a varredura`);
      return { corrigidas: 0, lacunas: 0, incompleta: true };
    }
    console.log(`[VERIFICAÇÃO DIÁRIA] Iniciando verificação completa (45 dias)...`);

    const dias = gerarDias(45);
    let totalCorrigido = 0;
    let lacunasEncontradas = 0;
    let parouPorExcesso = false;
    // A diária varre 45 dias e pode fechar um buraco grande, mas continua com
    // teto: 45 dias × 4 modalidades × o dia inteiro é exatamente o volume que
    // derruba o IP.
    const tetoDiaria = TETO_POR_RODADA * 5;

    for (const { mod, dia } of alvosComRodizio(dias, rodizioDiaria++)) {
      {
        if (parouPorExcesso || totalCorrigido >= tetoDiaria) { parouPorExcesso = true; break; }
        try {
          const diaAPI = dia.replace(/-/g, '');
          const response = await axios.get(`${PNCP_API_BASE}/contratacoes/publicacao`, {
            params: {
              dataInicial: diaAPI,
              dataFinal: diaAPI,
              codigoModalidadeContratacao: mod.id,
              pagina: 1,
              tamanhoPagina: 10
            },
            timeout: 20000
          });

          const naAPI = response.data.totalRegistros || 0;
          const noBanco = await contarNoBanco(db, dia, mod.id);

          const faltando = naAPI - noBanco;

          // Corrige QUALQUER lacuna (não apenas > 10)
          if (faltando > 0) {
            lacunasEncontradas++;
            console.log(`[VERIFICAÇÃO DIÁRIA] ${dia} ${mod.nome}: faltam ${faltando} (API ${naAPI}, banco ${noBanco}), corrigindo...`);
            const r = await corrigirLacuna(db, salvarLicitacao, salvarItens, dia, mod,
                                           faltando, tetoDiaria - totalCorrigido);
            totalCorrigido += r.corrigidas;
            if (r.excesso) {
              marcarExcesso('diaria');
              console.log('[VERIFICAÇÃO DIÁRIA] API do PNCP recusando chamadas; parando por aqui');
              parouPorExcesso = true;
            }
          }

          await new Promise(r => setTimeout(r, 50));
        } catch (e) {
          if (eSinalDeExcesso(e)) {
            marcarExcesso('diaria');
            console.log('[VERIFICAÇÃO DIÁRIA] API do PNCP recusando chamadas; parando por aqui');
            parouPorExcesso = true;
          }
        }
      }
    }

    console.log(`[VERIFICAÇÃO DIÁRIA] Concluída: ${lacunasEncontradas} lacunas encontradas, ${totalCorrigido} licitações corrigidas`);

    // Verificação completa de itens faltantes (últimos 45 dias, até 500 licitações)
    await corrigirItensFaltantes(45, 500, 'diaria');

    // `incompleta` diz a quem agendou que esta passada NÃO fechou o serviço:
    // ou a API recusou, ou o teto foi atingido com lacuna ainda aberta. Sem
    // esse retorno o agendador marcava a próxima para as 3h do DIA SEGUINTE, e
    // a varredura de 45 dias — a única que recompõe histórico — perdia 24h por
    // ter sido recusada em uma chamada. Foi o que aconteceu em 23/09/2026, com
    // o catálogo ainda faltando milhares de licitações de 21 e 22/09.
    const incompleta = parouPorExcesso || totalCorrigido >= tetoDiaria;
    return { corrigidas: totalCorrigido, lacunas: lacunasEncontradas, incompleta };
  }

  return {
    verificarECorrigirLacunas,
    verificacaoCompletaDiaria,
    corrigirItensFaltantes
  };
}

// `eSinalDeExcesso` sai daqui para o `pncp-sync-scheduler.js` usar a MESMA
// regra: duas definições de "a API pediu para parar" divergiriam com o tempo, e
// uma rotina passaria a martelar exatamente o que a outra está poupando.
module.exports = { criarVerificador, eSinalDeExcesso };
