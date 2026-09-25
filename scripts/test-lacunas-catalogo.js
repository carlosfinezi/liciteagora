#!/usr/bin/env node
/**
 * test-lacunas-catalogo.js — prova as guardas da verificação de lacunas do
 * catálogo PNCP, contra uma API de mentira e um catálogo Postgres de mentira.
 *
 * O INCIDENTE QUE ISTO GUARDA (22/09/2026). O catálogo parou de receber
 * licitações: de ~5.400 publicações por dia útil para 116. A causa não foi o
 * PNCP e não foi a rede — foi esta verificação, por três defeitos que se
 * somavam:
 *
 * 1. LEITURA NO BANCO ERRADO. As escritas vão para o Postgres desde
 *    `CATALOG_BACKEND_PG=1`, mas a contagem `SELECT COUNT(*) FROM licitacoes`
 *    continuava no SQLite, cuja última licitação é de 23/05/2026. A verificação
 *    concluía que faltavam TODAS as licitações de TODOS os dias e refazia o
 *    download completo a cada rodada — 69 rodadas num dia. O PNCP respondeu com
 *    429 e depois parou de responder: os timeouts saltaram de 223 para 2.380.
 *    A lacuna nunca fechava porque nunca foi lida do lugar certo.
 *
 * 2. CONTADOR QUE CONTA O QUE NÃO ACONTECEU. `corrigirLacuna` chamava
 *    `salvarLicitacao(lic)` sem `await` — em modo Postgres essa função é async —
 *    e incrementava na linha seguinte. Em 19/09 o log reportou 110.219
 *    corrigidas enquanto o catálogo ganhava ZERO licitações daquele dia. Um
 *    contador que mente sobre sucesso é pior que nenhum: ele esconde a falha.
 *
 * 3. SEM FREIO. A paginação incrementava a página no erro e seguia batendo, e
 *    nada limitava o volume por rodada. Quanto mais bloqueado o IP, menos
 *    entrava; quanto menos entrava, maior a lacuna a corrigir.
 *
 * Uso: node scripts/test-lacunas-catalogo.js
 */

const path = require('path');
const BASE = path.resolve(__dirname, '..');
const express = require(BASE + '/node_modules/express');

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 700) : ''}`);
  }
}

// Estado da API de mentira, manipulado ao longo do teste.
const api = {
  totalRegistros: 0,
  licitacoes: [],          // devolvidas paginadas de 50
  responder429apos: null,  // nº de chamadas de página após o qual passa a 429
  chamadasPagina: 0,
  chamadasItens: 0,
  itens429apos: null,      // idem, mas no endpoint de itens
  paginasPedidas: [],      // registra QUAIS páginas foram pedidas, na ordem
  // A API real responde por modalidade. Sem isto o mock devolveria a mesma
  // massa para as quatro e todo número esperado no teste sairia multiplicado
  // por quatro, escondendo o que se quer medir.
  soModalidade: 6,
};

// Catálogo Postgres de mentira: o que ele diz que já tem.
const pgFake = {
  existentes: [],          // [{cnpj, anoCompra, sequencialCompra}]
  consultas: [],           // registra quem foi consultado
  async queryOne(sql, params) {
    pgFake.consultas.push({ sql, params, tipo: 'one' });
    if (/COUNT\(\*\)/.test(sql)) return { total: pgFake.existentes.length };
    return null;
  },
  async query(sql, params) {
    pgFake.consultas.push({ sql, params, tipo: 'many' });
    if (/NOT EXISTS/.test(sql)) return [];
    return pgFake.existentes;
  },
};

function lic(seq) {
  return {
    orgaoEntidade: { cnpj: '05067274000111' }, anoCompra: 2026, sequencialCompra: seq,
    numeroControlePNCP: `05067274000111-1-${String(seq).padStart(6, '0')}/2026`,
    objetoCompra: `Objeto ${seq}`, modalidadeId: 6,
  };
}

(async () => {
  // ── API de mentira ─────────────────────────────────────────────────────────
  const app = express();
  app.get('/api/consulta/v1/contratacoes/publicacao', (req, res) => {
    if (api.soModalidade && Number(req.query.codigoModalidadeContratacao) !== api.soModalidade) {
      return res.json({ totalRegistros: 0, data: [] });
    }
    api.chamadasPagina++;
    if (api.responder429apos !== null && api.chamadasPagina > api.responder429apos) {
      return res.status(429).json({ error: 'Too Many Requests' });
    }
    const pagina = Number(req.query.pagina || 1);
    api.paginasPedidas.push(pagina);
    const tam = Number(req.query.tamanhoPagina || 50);
    const inicio = (pagina - 1) * tam;
    res.json({ totalRegistros: api.totalRegistros, data: api.licitacoes.slice(inicio, inicio + tam) });
  });
  app.get('/api/pncp/v1/orgaos/:cnpj/compras/:ano/:seq/itens', (_q, r) => {
    api.chamadasItens++;
    if (api.itens429apos !== null && api.chamadasItens > api.itens429apos) {
      return r.status(429).json({ error: 'Too Many Requests' });
    }
    r.json([{ numeroItem: 1, descricao: 'Item de teste', quantidade: 1 }]);
  });
  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const porta = servidor.address().port;

  // ── Injeta a URL da API falsa e o catalog-pg falso ANTES do require ────────
  require.cache[require.resolve(BASE + '/config.js')] = {
    id: require.resolve(BASE + '/config.js'), filename: require.resolve(BASE + '/config.js'),
    loaded: true, exports: {
      PNCP_API_BASE: `http://127.0.0.1:${porta}/api/consulta/v1`,
      PNCP_API_ITENS: `http://127.0.0.1:${porta}/api/pncp/v1`,
    },
  };
  require.cache[require.resolve(BASE + '/catalog-pg.js')] = {
    id: require.resolve(BASE + '/catalog-pg.js'), filename: require.resolve(BASE + '/catalog-pg.js'),
    loaded: true, exports: pgFake,
  };

  process.env.CATALOG_BACKEND_PG = '1';
  const { criarVerificador } = require(BASE + '/verificacao-lacunas');

  // SQLite de mentira, que representa o catálogo CONGELADO: se alguém ler
  // daqui, devolve zero — e é exatamente esse zero que causava o incidente.
  let lidoDoSqlite = 0;
  const dbMorto = {
    prepare() {
      return {
        get() { lidoDoSqlite++; return { total: 0 }; },
        all() { lidoDoSqlite++; return []; },
      };
    },
  };

  const salvas = [];
  const novoVerificador = (opts = {}) => {
    const salvar = opts.salvar || (async (l) => { salvas.push(l); return true; });
    const salvarIt = opts.salvarItens || (async () => true);
    return criarVerificador(dbMorto, salvar, salvarIt);
  };

  // ── 1. a contagem sai do Postgres, não do SQLite congelado ────────────────
  console.log('\n── de onde vem a contagem');
  {
    salvas.length = 0; pgFake.consultas.length = 0; lidoDoSqlite = 0;
    api.chamadasPagina = 0; api.responder429apos = null;
    // A API diz 10; o Postgres já tem as 10. Não há lacuna.
    api.totalRegistros = 10;
    api.licitacoes = Array.from({ length: 10 }, (_, i) => lic(i + 1));
    pgFake.existentes = Array.from({ length: 10 }, (_, i) => ({
      cnpj: '05067274000111', anoCompra: 2026, sequencialCompra: i + 1 }));

    const v = novoVerificador();
    const corrigido = await v.verificarECorrigirLacunas(1);

    assert(pgFake.consultas.some(c => /COUNT\(\*\)/.test(c.sql)),
      'a contagem é feita no Postgres', pgFake.consultas.map(c => c.tipo));
    assert(lidoDoSqlite === 0,
      'e o SQLite congelado NÃO é consultado', { lidoDoSqlite });
    assert(corrigido === 0,
      'com o Postgres em dia, não há lacuna a corrigir — era aqui que nascia o download infinito',
      { corrigido, salvas: salvas.length });
    assert(salvas.length === 0, 'e nada é baixado à toa', salvas.length);
  }

  // ── 2. lacuna REAL é corrigida ─────────────────────────────────────────────
  console.log('\n── lacuna real');
  {
    salvas.length = 0; api.chamadasPagina = 0; api.responder429apos = null;
    api.totalRegistros = 30;
    api.licitacoes = Array.from({ length: 30 }, (_, i) => lic(i + 1));
    pgFake.existentes = [];                       // o catálogo está vazio: faltam 30

    const v = novoVerificador();
    const corrigido = await v.verificarECorrigirLacunas(1);
    assert(corrigido === 30, 'as 30 que faltavam são gravadas', corrigido);
    assert(salvas.length === 30, 'e o contador bate com o que foi salvo de fato', salvas.length);
  }

  // ── 3. o contador não conta o que falhou ──────────────────────────────────
  console.log('\n── contador honesto');
  {
    api.chamadasPagina = 0; api.responder429apos = null;
    api.totalRegistros = 20;
    api.licitacoes = Array.from({ length: 20 }, (_, i) => lic(i + 1));
    pgFake.existentes = [];

    // Metade das gravações falha, como aconteceria com o pool saturado.
    let n = 0;
    const v = novoVerificador({ salvar: async () => { n++; if (n % 2 === 0) throw new Error('pool cheio'); return true; } });
    const corrigido = await v.verificarECorrigirLacunas(1);
    assert(corrigido === 10,
      'só as que realmente gravaram entram na conta (10 de 20)', { corrigido });

    // E o caso do salvar que devolve false sem lançar.
    const v2 = novoVerificador({ salvar: async () => false });
    const c2 = await v2.verificarECorrigirLacunas(1);
    assert(c2 === 0,
      'salvar que devolve false não é contado como sucesso', { c2 });
  }

  // ── 4. a API pede para parar, e o sistema para ────────────────────────────
  console.log('\n── freio no 429');
  {
    salvas.length = 0;
    api.chamadasPagina = 0;
    api.totalRegistros = 5000;
    api.licitacoes = Array.from({ length: 200 }, (_, i) => lic(i + 1));
    api.responder429apos = 2;                     // a 3ª chamada de página já é 429
    pgFake.existentes = [];

    const v = novoVerificador();
    await v.verificarECorrigirLacunas(3);         // 3 dias × 4 modalidades = 12 alvos

    assert(api.chamadasPagina <= 6,
      `a rodada para logo após o 429, em vez de martelar (foram ${api.chamadasPagina} chamadas)`,
      api.chamadasPagina);
  }

  // ── 4b. o 429 na busca de ITENS também freia ──────────────────────────────
  console.log('\n── freio no 429 vindo da busca de itens');
  {
    // Caminho que escapava: a busca de itens engolia todo erro e devolvia [],
    // então a rodada seguia pedindo itens licitação após licitação com a API
    // já recusando. É uma chamada POR LICITAÇÃO — o maior volume da rodada.
    salvas.length = 0;
    api.chamadasPagina = 0; api.responder429apos = null;
    api.chamadasItens = 0; api.itens429apos = 3;
    api.totalRegistros = 500;
    api.licitacoes = Array.from({ length: 200 }, (_, i) => lic(i + 1));
    pgFake.existentes = [];

    const v = novoVerificador();
    await v.verificarECorrigirLacunas(3);
    assert(api.chamadasItens <= 8,
      `a rodada para quando a API recusa os ITENS (foram ${api.chamadasItens} chamadas)`,
      api.chamadasItens);
    api.itens429apos = null;
  }

  // ── 4c. depois do 429, fica quieto por um tempo ───────────────────────────
  console.log('\n── silêncio após o 429');
  {
    // Parar a rodada não basta: a próxima começa 5 minutos depois e renova o
    // bloqueio, que então nunca expira. É este degrau que permite ao sistema
    // sair sozinho do estado em que entrou em 22/09/2026.
    api.chamadasPagina = 0; api.chamadasItens = 0; api.itens429apos = null;
    api.responder429apos = 0;                     // recusa desde a primeira
    api.totalRegistros = 500;
    api.licitacoes = Array.from({ length: 50 }, (_, i) => lic(i + 1));
    pgFake.existentes = [];

    const v = novoVerificador();
    await v.verificarECorrigirLacunas(1);         // entra em cooldown
    const apos = api.chamadasPagina;

    // A rodada seguinte não deve nem tocar na API.
    const corrigido2 = await v.verificarECorrigirLacunas(1);
    assert(api.chamadasPagina === apos,
      'a rodada seguinte não faz UMA chamada sequer enquanto o silêncio dura',
      { antes: apos, depois: api.chamadasPagina });
    assert(corrigido2 === 0, 'e devolve zero sem fingir trabalho', corrigido2);

    // A busca de ITENS é a porta dos fundos: roda ao fim de toda rodada e faz
    // uma chamada por licitação. Deixá-la fora do silêncio manteria a pressão.
    const itensAntes = api.chamadasItens;
    await v.corrigirItensFaltantes(7, 50);
    assert(api.chamadasItens === itensAntes,
      'e a busca de itens também respeita o silêncio',
      { antes: itensAntes, depois: api.chamadasItens });

    api.responder429apos = null;
  }

  // ── 4c2. a paginação não recomeça do zero a cada passada ──────────────────
  console.log('\n── por onde a correção começa a paginar');
  {
    // O caso real de 23/09/2026: 500 gravados de 1.506 na API. Começando da
    // página 1, as dez primeiras voltam inteiras conhecidas e a passada gasta
    // dez requisições sem gravar nada — com a API concedendo poucas chamadas,
    // ela nunca alcançava a primeira página útil. A passada fechou com "2
    // lacunas encontradas, 0 licitações corrigidas".
    api.chamadasPagina = 0; api.responder429apos = null; api.itens429apos = null;
    api.paginasPedidas.length = 0;          // senão lemos o rastro de outro bloco
    api.totalRegistros = 1506;
    api.licitacoes = Array.from({ length: 1506 }, (_, i) => lic(i + 1));
    // As 500 primeiras já estão no catálogo.
    pgFake.existentes = Array.from({ length: 500 }, (_, i) => ({
      cnpj: '05067274000111', anoCompra: 2026, sequencialCompra: i + 1 }));

    const v = novoVerificador();
    const corrigido = await v.verificarECorrigirLacunas(1);

    assert(corrigido > 0,
      'com o catálogo meio cheio, a passada AINDA grava algo', corrigido);
    // 500 gravados = 10 páginas cheias. A correção deve entrar perto da 10,
    // não na 1: é a diferença entre gastar a cota da API relendo o que já
    // temos e gastá-la trazendo o que falta.
    const primeiraDaCorrecao = api.paginasPedidas[1];
    assert(primeiraDaCorrecao >= 8,
      `a correção começa perto do fim do que já temos (página ${primeiraDaCorrecao}, não 1)`,
      api.paginasPedidas.slice(0, 5));
    assert(!api.paginasPedidas.slice(1).includes(1),
      'e não relê a página 1, que está inteira no catálogo',
      api.paginasPedidas.slice(0, 5));
  }

  // ── 4d. o rodízio: passadas seguidas atacam dias diferentes ───────────────
  console.log('\n── rodízio do ponto de partida');
  {
    // O caso real de 23/09/2026: a API concede ~50 registros e recusa. Sem
    // rodízio a varredura começa SEMPRE no mesmo alvo, gasta ali a cota e para
    // — os dias do fim da fila nunca são alcançados. Foi o que deixou 21 e
    // 22/09 congelados em 323 e 3.603 enquanto o dia corrente avançava.
    const diasVistos = [];
    api.itens429apos = null;
    api.responder429apos = null;
    // Sem lacuna: o que se mede aqui é a ORDEM de visita, não a correção.
    api.totalRegistros = 10;
    api.licitacoes = Array.from({ length: 10 }, (_, i) => lic(i + 1));
    pgFake.existentes = Array.from({ length: 10 }, (_, i) => ({
      cnpj: '05067274000111', anoCompra: 2026, sequencialCompra: i + 1 }));

    // O MESMO verificador nas quatro passadas: o rodízio é estado dele, e é
    // assim que o scheduler o usa — um verificador vivo, chamado de 5 em 5 min.
    const v = novoVerificador();
    for (let passada = 0; passada < 4; passada++) {
      pgFake.consultas.length = 0;
      await v.verificarECorrigirLacunas(3);
      const consultado = pgFake.consultas
        .filter(c => /COUNT\(\*\)/.test(c.sql))
        .map(c => c.params[0]);
      if (consultado.length) diasVistos.push(consultado[0]);
    }

    const distintos = new Set(diasVistos);
    assert(distintos.size > 1,
      `passadas seguidas começam em alvos DIFERENTES (vistos: ${[...distintos].join(', ')})`,
      diasVistos);
  }

  // ── 5. teto por rodada ────────────────────────────────────────────────────
  console.log('\n── teto de volume por rodada');
  {
    salvas.length = 0; api.chamadasPagina = 0; api.responder429apos = null;
    api.totalRegistros = 100000;
    api.licitacoes = Array.from({ length: 2000 }, (_, i) => lic(i + 1));
    pgFake.existentes = [];

    const v = novoVerificador();
    const corrigido = await v.verificarECorrigirLacunas(7);
    assert(corrigido <= 800,
      `uma lacuna enorme não vira um download de tudo numa rodada só (parou em ${corrigido})`,
      corrigido);
    assert(corrigido > 0, 'mas a rodada ainda faz progresso', corrigido);

    // A conta que motivou consumir a paginação página a página: parar de
    // GRAVAR em 800 não adianta se a rodada já pediu 2.000 à API. Com páginas
    // de 50, 800 gravações custam ~16 páginas, e não as 40 do dia inteiro.
    assert(api.chamadasPagina <= 20,
      `e pede à API só o que vai usar (${api.chamadasPagina} páginas para 800 gravações)`,
      api.chamadasPagina);
  }

  // ── 6. os nomes das modalidades ───────────────────────────────────────────
  console.log('\n── rótulo do log');
  {
    const fonte = require('fs').readFileSync(BASE + '/verificacao-lacunas.js', 'utf8');
    const m6 = /\{\s*id:\s*6,\s*nome:\s*'([^']+)'/.exec(fonte);
    const m8 = /\{\s*id:\s*8,\s*nome:\s*'([^']+)'/.exec(fonte);
    assert(m6 && /Pregão/.test(m6[1]),
      'modalidade 6 é Pregão Eletrônico, como o catálogo registra', m6 && m6[1]);
    assert(m8 && /Dispensa/.test(m8[1]),
      'e 8 é Dispensa — estavam trocados, e o log acusava a errada', m8 && m8[1]);
  }

  // ── 7. a janela do sync incremental ───────────────────────────────────────
  console.log('\n── janela do sync incremental');
  {
    const { calcularJanelaIncremental } = require(BASE + '/pncp-sync-scheduler');
    const hoje = new Date('2026-09-22T15:00:00Z');
    const HOJE = '2026-09-22';

    // O caso real que parou o catálogo: cursor sete dias à frente.
    const futuro = calcularJanelaIncremental('2026-09-29', hoje);
    assert(futuro.fim === HOJE,
      'a janela termina HOJE, e não em hoje+7 como antes', futuro);
    assert(futuro.inicio <= HOJE,
      'e começa no passado, mesmo com o cursor contaminado ainda gravado no banco', futuro);
    assert(/futuro/.test(futuro.aviso || ''),
      'e o log avisa que o cursor estava adiantado, em vez de falhar calado', futuro.aviso);

    // Cursor normal, do dia corrente.
    const normal = calcularJanelaIncremental('2026-09-22', hoje);
    assert(normal.inicio === '2026-09-21' && normal.fim === HOJE,
      'cursor de hoje varre ontem e hoje, com a sobreposição de um dia', normal);
    assert(!normal.aviso, 'e não gera aviso nenhum', normal.aviso);

    // Sync parado há muito tempo não vira uma varredura gigante de uma vez.
    const antigo = calcularJanelaIncremental('2026-06-01', hoje);
    assert(antigo.inicio === '2026-09-17',
      'cursor muito antigo recua no máximo 5 dias: recupera em rodadas', antigo);

    // Cursor ilegível não derruba o sync nem gera Invalid Date.
    const lixo = calcularJanelaIncremental('não é data', hoje);
    assert(lixo.inicio === '2026-09-17' && lixo.fim === HOJE,
      'cursor ilegível cai na janela segura', lixo);
  }

  // ── 7b. a varredura de 45 dias avisa quando NÃO fechou o serviço ──────────
  console.log('\n── a diária diz se recompôs ou não');
  {
    // Esta é a única varredura que olha 45 dias, e portanto a única que
    // recompõe o catálogo depois de uma parada. Se ela não avisar que ficou
    // pela metade, o agendador marca a próxima para as 3h do dia seguinte e a
    // recomposição não sai do lugar — foi o que travou em 23/09/2026.
    api.chamadasPagina = 0; api.chamadasItens = 0; api.itens429apos = null;

    // Caso 1: API recusa → incompleta.
    api.responder429apos = 0;
    api.totalRegistros = 5000;
    api.licitacoes = Array.from({ length: 50 }, (_, i) => lic(i + 1));
    pgFake.existentes = [];
    const recusada = await novoVerificador().verificacaoCompletaDiaria();
    assert(recusada && recusada.incompleta === true,
      'recusada pela API, a diária se declara incompleta', recusada);

    // Caso 1a: a rápida em silêncio NÃO cala a varredura de 45 dias.
    //
    // Este é o caso que travou a recomposição em 23/09/2026. Com um silêncio
    // só, compartilhado, a rápida (que roda de 5 em 5 min) rearmava os 20
    // minutos antes de toda tentativa da diária, e esta nunca chegava a rodar:
    // `Em silêncio por mais 17 min`, depois `por mais 14 min`, indefinidamente.
    // O dia corrente era corrigido pela rápida enquanto 21 e 22/09 ficavam
    // parados, porque só a varredura de 45 dias os alcança.
    {
      const v = novoVerificador();
      api.responder429apos = 0;
      api.totalRegistros = 300;
      api.licitacoes = Array.from({ length: 50 }, (_, i) => lic(i + 1));
      pgFake.existentes = [];
      await v.verificarECorrigirLacunas(1);       // a RÁPIDA entra em silêncio

      // Agora a API volta a aceitar. A diária tem de aproveitar a janela.
      api.responder429apos = null;
      const antes = api.chamadasPagina;
      const r = await v.verificacaoCompletaDiaria();
      assert(api.chamadasPagina > antes,
        'com a rápida em silêncio, a diária ainda assim roda e chama a API',
        { antes, depois: api.chamadasPagina });
      assert(r.corrigidas > 0,
        'e recompõe de fato, em vez de adiar para sempre', r);
    }

    // Caso 1b: em silêncio, a diária NÃO toca na API.
    // Sem isto ela gastava uma chamada durante o cooldown, tomava 429 e
    // rearmava o próprio silêncio a cada repetição — a verificação rápida
    // ficaria calada indefinidamente por causa da diária.
    {
      const v = novoVerificador();
      api.responder429apos = 0;
      // É a PRÓPRIA diária que precisa ter sido recusada para entrar no seu
      // silêncio — o da rápida não a alcança mais, e é isso que o caso 1a
      // garante.
      await v.verificacaoCompletaDiaria();       // toma 429 e silencia
      const antes = api.chamadasPagina;
      const emSilencio = await v.verificacaoCompletaDiaria();
      assert(api.chamadasPagina === antes,
        'recusada, a diária não insiste na passada seguinte',
        { antes, depois: api.chamadasPagina });
      assert(emSilencio.incompleta === true,
        'e continua se declarando incompleta, para ser repetida', emSilencio);
    }

    // Caso 2: nada a fazer → completa, e o agendamento diário segue normal.
    api.responder429apos = null;
    api.totalRegistros = 10;
    api.licitacoes = Array.from({ length: 10 }, (_, i) => lic(i + 1));
    pgFake.existentes = Array.from({ length: 10 }, (_, i) => ({
      cnpj: '05067274000111', anoCompra: 2026, sequencialCompra: i + 1 }));
    const completa = await novoVerificador().verificacaoCompletaDiaria();
    assert(completa && completa.incompleta === false,
      'sem lacuna e sem recusa, ela se declara completa', completa);
    assert(completa.corrigidas === 0, 'e não inventa correção', completa);
  }

  // ── 8. o sweep não perde o dia quando colide com o sync ───────────────────
  console.log('\n── reagendamento do sweep');
  {
    const { proximoSweepEm } = require(BASE + '/pncp-sync-scheduler');
    // O caso real: são 4h em ponto, há um sync rodando, e o sweep é adiado.
    const quatroEmPonto = new Date('2026-09-22T04:00:00');

    const porColisao = proximoSweepEm(quatroEmPonto, 10);
    assert(porColisao.getDate() === quatroEmPonto.getDate(),
      'adiado por colisão, o sweep continua NO MESMO DIA', porColisao.toISOString());
    assert(porColisao - quatroEmPonto === 10 * 60 * 1000,
      'e tenta de novo em 10 minutos', (porColisao - quatroEmPonto) / 60000);

    // Sem colisão, o comportamento diário continua igual.
    const diario = proximoSweepEm(quatroEmPonto, undefined, 4);
    assert(diario.getDate() === quatroEmPonto.getDate() + 1 && diario.getHours() === 4,
      'sem colisão, segue marcando as 4h do dia seguinte', diario.toISOString());

    const antesDaHora = proximoSweepEm(new Date('2026-09-22T01:00:00'), undefined, 4);
    assert(antesDaHora.getDate() === 22 && antesDaHora.getHours() === 4,
      'e de madrugada ainda pega as 4h de hoje', antesDaHora.toISOString());
  }

  servidor.close();
  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${ok} ok, ${fail} falha(s)`);
  if (fail) { falhas.forEach(x => console.error('   - ' + x)); process.exit(1); }
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
