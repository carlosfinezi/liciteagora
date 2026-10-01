/**
 * test-os-sla-e-rotulos.js — as correções de 01/10/2026 no módulo de OS,
 * na cobrança e nos rótulos que o usuário lê.
 *
 * Cada bloco guarda um defeito que estava no ar e que NENHUMA suíte pegava —
 * foi por isso que o relatório de SLA viveu meses mostrando zero.
 *
 *   A. Relatório de SLA calculado pela mesma regra da lista (uma fonte só).
 *   B. os_itens_pecas com custoUnitario/desconto/situacao em todo tenant.
 *   C. KPI "faturadas sem nota" conta a NFS-e, e "rejeitadas" só para quem emite.
 *   D. Relatórios mostram o nome do técnico, não o login.
 *   E. A etapa da régua de cobrança tem nome.
 *   F. Os rótulos de status da OS e a peça que os carrega.
 *   G. As telas: colunas com piso de largura, valor que não quebra, acento,
 *      botão com rótulo, jargão fiscal fora e nome do relatório.
 *
 * Roda da raiz do projeto: `node scripts/test-os-sla-e-rotulos.js`
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const RAIZ = path.join(__dirname, '..');
const { lerSchema } = require('./schema-de-tenant');
const { registrarRotasOS } = require(path.join(RAIZ, 'os-routes'));

let ok = 0, fail = 0;
function t(nome, fn) {
  try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

// ---------------------------------------------------------------- banco
const DB = '/tmp/vp-os-sla-rotulos.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
db.exec(lerSchema());
db.exec(`CREATE TABLE IF NOT EXISTS tipos_operacao (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, ativo INTEGER DEFAULT 1);
         CREATE TABLE IF NOT EXISTS participacoes_comprasnet (id INTEGER PRIMARY KEY AUTOINCREMENT);`);

const app = express();
registrarRotasOS(app, db);
const achar = (p, metodo) => {
  const l = ((app.router || app._router).stack || [])
    .find(x => x.route && x.route.path === p && x.route.methods[metodo]);
  if (!l) throw new Error(`rota nao registrada: ${metodo.toUpperCase()} ${p}`);
  return l.route.stack[l.route.stack.length - 1].handle;
};
function chamar(handler, { params = {}, body = {}, query = {} } = {}) {
  let out = null, st = 200;
  const res = { json: o => { out = o; return res; }, status: c => { st = c; return res; } };
  handler({ params, body, query, session: { username: 'teste' }, user: { username: 'teste' } }, res);
  if (!out) throw new Error('sem resposta');
  return { out, st };
}

// ---------------------------------------------------------------- semente
const hoje = new Date();
const dia = (n) => {
  const d = new Date(hoje); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

db.prepare(`INSERT INTO pessoas (id, cpfCnpj, tipo, razaoSocial, ativo) VALUES (1, '11222333000181', 'PJ', 'CLIENTE DE TESTE', 1)`).run();
// O técnico tem NOME e login diferentes: é essa diferença que o bloco D mede.
db.prepare(`INSERT INTO users (id, username, passwordHash, nome, role, ativo, valorHora)
            VALUES (9, 'joao.silva', 'x', 'João da Silva', 'operacional', 1, 50)`).run();

const insOS = db.prepare(`INSERT INTO os_ordens
  (numero, clienteId, tecnicoId, status, titulo, dataPromessa, dataAbertura, dataConclusao, valorServicos, valorTotal)
  VALUES (?, 1, 9, ?, ?, ?, ?, ?, ?, ?)`);
// cumprida: concluída ANTES do prazo
insOS.run('OS-1', 'concluida', 'Cumprida',  dia(-5), dia(-10) + ' 09:00:00', dia(-7) + ' 16:00:00', 100, 100);
// estourada: concluída DEPOIS do prazo
insOS.run('OS-2', 'faturada',  'Estourada', dia(-9), dia(-12) + ' 09:00:00', dia(-4) + ' 16:00:00', 200, 200);
// atrasada: ainda ativa, prazo já venceu
insOS.run('OS-3', 'em-andamento', 'Atrasada', dia(-2), dia(-6) + ' 09:00:00', null, 0, 0);
// no prazo: ativa, prazo lá na frente
insOS.run('OS-4', 'aberta', 'No prazo', dia(+9), dia(-1) + ' 09:00:00', null, 0, 0);
// sem SLA: sem data de promessa
insOS.run('OS-5', 'aberta', 'Sem prazo', null, dia(-1) + ' 09:00:00', null, 0, 0);

const hSla = achar('/api/os/relatorios/sla', 'get');
const hLista = achar('/api/os', 'get');
const hPorTec = achar('/api/os/relatorios/por-tecnico', 'get');
const hLucro = achar('/api/os/relatorios/lucratividade', 'get');

// ======================================================= A. relatório de SLA
console.log('\nA. Relatório de SLA — uma fonte só, a mesma da lista');

t('A1 conta cumprido e estourado (a coluna slaStatus nunca os recebe)', () => {
  const { out } = chamar(hSla, { query: {} });
  assert(out.success, 'rota falhou: ' + out.error);
  assert(out.resumo.cumpridos === 1, 'cumpridos=' + out.resumo.cumpridos + ', esperado 1');
  assert(out.resumo.estourados === 1, 'estourados=' + out.resumo.estourados + ', esperado 1');
});

t('A2 conta atrasado, no prazo e sem SLA', () => {
  const { out } = chamar(hSla, { query: {} });
  assert(out.resumo.atrasados === 1, 'atrasados=' + out.resumo.atrasados);
  assert(out.resumo.noPrazo === 1, 'noPrazo=' + out.resumo.noPrazo);
  assert(out.resumo.semSla === 1, 'semSla=' + out.resumo.semSla);
});

t('A3 taxa de cumprimento sai sobre as que FECHARAM, não sobre o total', () => {
  const { out } = chamar(hSla, { query: {} });
  assert(out.resumo.fechadas === 2, 'fechadas=' + out.resumo.fechadas);
  assert(out.resumo.taxaCumprimento === 50, 'taxa=' + out.resumo.taxaCumprimento + ', esperado 50');
});

t('A4 a coluna slaStatus gravada NÃO manda — era o defeito', () => {
  // Põe no banco o contrário do que a regra diz. Se o relatório voltar a ler a
  // coluna, A1 passa a contar 0 cumpridos e esta checagem reprova.
  db.prepare("UPDATE os_ordens SET slaStatus = 'atrasado'").run();
  const { out } = chamar(hSla, { query: {} });
  assert(out.resumo.cumpridos === 1, 'a coluna venceu o cálculo: cumpridos=' + out.resumo.cumpridos);
  assert(out.resumo.estourados === 1, 'a coluna venceu o cálculo: estourados=' + out.resumo.estourados);
  db.prepare('UPDATE os_ordens SET slaStatus = NULL').run();
});

t('A5 a lista e o relatório contam o mesmo', () => {
  const r = chamar(hSla, { query: {} }).out.resumo;
  const l = chamar(hLista, { query: { limit: 500 } }).out.kpis;
  assert(l.atrasadas === r.atrasados, `lista=${l.atrasadas} relatório=${r.atrasados}`);
  assert(l.noPrazo === r.noPrazo, `lista=${l.noPrazo} relatório=${r.noPrazo}`);
  assert(l.cumpridas === r.cumpridos, `lista=${l.cumpridas} relatório=${r.cumpridos}`);
  assert(l.estouradas === r.estourados, `lista=${l.estouradas} relatório=${r.estourados}`);
});

// ============================================ B. colunas de os_itens_pecas
console.log('\nB. os_itens_pecas nasce completa em qualquer tenant');

t('B1 o schema recriado pelo db-schema declara as três colunas', () => {
  const src = ler('db-schema.js');
  const i = src.indexOf('CREATE TABLE os_itens_pecas_new');
  assert(i > 0, 'não achei a recriação de os_itens_pecas');
  const bloco = src.slice(i, i + 2200);
  for (const col of ['custoUnitario', 'desconto', 'situacao']) {
    assert(bloco.includes(col), `a recriação não declara ${col} — o tenant sai sem ela`);
  }
});

t('B2 há migração idempotente para quem já passou pela recriação antiga', () => {
  const src = ler('db-schema.js');
  for (const col of ['custoUnitario', 'desconto', 'situacao']) {
    assert(new RegExp(`ALTER TABLE os_itens_pecas ADD COLUMN ${col}`).test(src),
      `falta o ALTER de ${col} no db-schema.js`);
  }
});

t('B3 as duas consultas que quebravam sem as colunas respondem', () => {
  const cols = db.prepare("SELECT name FROM pragma_table_info('os_itens_pecas')").all().map(r => r.name);
  for (const c of ['custoUnitario', 'desconto', 'situacao']) {
    assert(cols.includes(c), `o banco de teste está sem ${c}`);
  }
  db.prepare("SELECT COUNT(*) n FROM os_itens_pecas WHERE osId = 1 AND situacao = 'orcado'").get();
  chamar(hLucro, { query: {} });
});

// ===================================================== C. KPIs fiscais
console.log('\nC. KPI fiscal conta a NFS-e, e "rejeitadas" só para quem emite');

t('C1 sem nota nenhuma, a faturada entra em "sem nota" e o KPI de rejeitada some', () => {
  const { out } = chamar(hLista, { query: { limit: 500 } });
  assert(out.kpis.faturadasSemNota === 1, 'faturadasSemNota=' + out.kpis.faturadasSemNota);
  assert(out.kpis.emiteNota === false, 'emiteNota deveria ser falso sem nota emitida');
});

t('C2 OS faturada com NFS-e autorizada NÃO conta como sem nota', () => {
  const osId = db.prepare("SELECT id FROM os_ordens WHERE numero = 'OS-2'").get().id;
  db.prepare(`INSERT INTO nfse (osId, status) VALUES (?, 'autorizada')`).run(osId);
  const { out } = chamar(hLista, { query: { limit: 500 } });
  assert(out.kpis.faturadasSemNota === 0,
    'a NFS-e autorizada não foi considerada: faturadasSemNota=' + out.kpis.faturadasSemNota);
  assert(out.kpis.emiteNota === true, 'com NFS-e emitida, emiteNota deveria ser verdadeiro');
});

t('C3 rascunho de fatura não faz o tenant "emitir"', () => {
  db.prepare('DELETE FROM nfse').run();
  db.prepare(`INSERT INTO faturas (numero, clienteId, dataEmissao, dataVencimento, valorBruto, valorTotal, statusSefaz)
              VALUES ('FAT-RASCUNHO', 1, '2026-10-01', '2026-10-15', 100, 100, NULL)`).run();
  const { out } = chamar(hLista, { query: { limit: 500 } });
  assert(out.kpis.emiteNota === false, 'fatura sem statusSefaz não prova emissão');
  db.prepare('DELETE FROM faturas').run();
});

t('C4 nota rejeitada é contada', () => {
  const osId = db.prepare("SELECT id FROM os_ordens WHERE numero = 'OS-2'").get().id;
  db.prepare(`INSERT INTO nfse (osId, status) VALUES (?, 'rejeitada')`).run(osId);
  const { out } = chamar(hLista, { query: { limit: 500 } });
  assert(out.kpis.rejeitadas === 1, 'rejeitadas=' + out.kpis.rejeitadas);
  db.prepare('DELETE FROM nfse').run();
});

// ================================================ D. nome do técnico
console.log('\nD. Relatórios mostram o nome, não o login');

t('D1 relatório de SLA traz "João da Silva", e não "joao.silva"', () => {
  const { out } = chamar(hSla, { query: {} });
  const linha = out.porTecnico.find(x => x.total > 0);
  assert(linha, 'nenhum técnico no relatório');
  assert(linha.tecnicoNome === 'João da Silva', 'veio: ' + linha.tecnicoNome);
});

t('D2 relatório por técnico traz o nome', () => {
  const { out } = chamar(hPorTec, { query: {} });
  assert(out.success, 'rota falhou: ' + out.error);
  const l = (out.linhas || []).find(x => x.tecnicoId === 9);
  assert(l && l.tecnicoNome === 'João da Silva', 'veio: ' + (l && l.tecnicoNome));
});

t('D3 nenhum relatório devolve o login cru', () => {
  const src = ler('os-routes.js');
  const i = src.indexOf("app.get('/api/os/relatorios/");
  const bloco = src.slice(i);
  assert(!/\bu\.username AS tecnicoNome/.test(bloco),
    'algum relatório ainda devolve u.username como nome do técnico');
});

// ================================================ E. etapa da régua
console.log('\nE. A etapa da cobrança tem nome');

t('E1 a régua padrão nomeia cada etapa', () => {
  const src = ler('cobrancas-routes.js');
  const i = src.indexOf('const DEFAULT_REGUA');
  const bloco = src.slice(i, src.indexOf('const DEFAULT_CONFIG'));
  const nomes = bloco.match(/nome: '[^']+'/g) || [];
  assert(nomes.length >= 5, 'só ' + nomes.length + ' etapas com nome');
});

t('E2 a rota devolve o nome da etapa junto do número', () => {
  const src = ler('cobrancas-routes.js');
  assert(src.includes('ultimaEtapaNome'), 'a rota não devolve ultimaEtapaNome');
  assert(src.includes('function nomeDaEtapa'), 'falta a função nomeDaEtapa');
});

t('E3 régua sem nome cai no nome padrão da etapa de mesmo número', () => {
  // Régua gravada antes do campo existir: sem `nome`, mas com o número.
  const mod = require(path.join(RAIZ, 'cobrancas-routes'));
  assert(typeof mod.nomeDaEtapa === 'function', 'nomeDaEtapa não é exportada');
  assert(mod.nomeDaEtapa({ regua: [{ etapa: 4, diasApos: 15 }] }, 4) === 'Aviso de negativação',
    'não caiu no nome padrão');
  assert(mod.nomeDaEtapa({ regua: [{ etapa: 4, nome: 'Meu nome' }] }, 4) === 'Meu nome',
    'o nome configurado não venceu');
  assert(mod.nomeDaEtapa({ regua: [] }, 9) === 'Etapa 9', 'etapa desconhecida devia virar "Etapa 9"');
});

t('E4 a tela mostra o nome, e não "Etapa 4"', () => {
  const h = ler('public/cobranca/cobrancas.html');
  assert(h.includes('c.ultimaEtapaNome'), 'a tela não usa o nome da etapa');
});

t('E5 a configuração deixa editar o nome', () => {
  const h = ler('public/cobranca/cobrancas-config.html');
  assert(/id="nome_\$\{idx\}"/.test(h), 'falta o campo de nome na régua');
  assert(/nome: document\.getElementById\('nome_'\+idx\)/.test(h), 'o nome não é salvo');
});

// ================================================ F. rótulos de status
console.log('\nF. O status da OS é escrito em português');

t('F1 a peça traduz as chaves do banco', () => {
  const src = ler('public/js/os-rotulos.js');
  const global = {};
  new Function('window', src)(global);
  const R = global.OsRotulos;
  assert(R.status('aguardando-peca') === 'Aguardando peça', 'veio: ' + R.status('aguardando-peca'));
  assert(R.status('em-andamento') === 'Em andamento', 'veio: ' + R.status('em-andamento'));
  assert(R.status('concluida') === 'Concluída', 'veio: ' + R.status('concluida'));
  assert(R.sla('no-prazo') === 'No prazo', 'veio: ' + R.sla('no-prazo'));
});

t('F2 chave desconhecida não some da tela', () => {
  const global = {};
  new Function('window', ler('public/js/os-rotulos.js'))(global);
  assert(global.OsRotulos.status('status-novo') === 'Status novo',
    'veio: ' + global.OsRotulos.status('status-novo'));
  assert(global.OsRotulos.status('') === '', 'vazio devia continuar vazio');
});

t('F3 as cinco telas de status carregam a peça e usam OsRotulos', () => {
  for (const tela of ['public/os/ordens-servico.html', 'public/os/ordem-servico.html',
                      'public/os/equipamento.html', 'public/portal/os.html', 'public/portal/os-detalhe.html']) {
    const h = ler(tela);
    assert(h.includes('/js/os-rotulos.js'), `${tela} não carrega a peça`);
    assert(h.includes('OsRotulos.status('), `${tela} ainda mostra o status cru`);
  }
});

t('F4 a peça está liberada antes do login (o portal do cliente é público)', () => {
  assert(ler('pre-auth-routes.js').includes("'os-rotulos.js'"),
    'sem isso o portal recebe o HTML do login no lugar do script');
});

t('F5 o badge com frase não vai para caixa alta', () => {
  assert(/\.badge\.badge-os\s*\{[^}]*text-transform:\s*none/.test(ler('public/css/app-modern.css')),
    'falta a regra .badge-os no design system');
});

// ================================================ G. telas
console.log('\nG. As telas: largura, valor, acento, rótulo');

t('G1 a lista de OS declara piso de largura nas colunas que cortavam', () => {
  const h = ler('public/os/ordens-servico.html');
  // É o min-width no <th> que o grid.js respeita — sem ele a coluna é medida
  // pelo CABEÇALHO e "OS-2026-0075" vira "OS-202…".
  for (const c of ['c-numero', 'c-cliente', 'c-tecnico', 'c-total', 'c-status', 'c-sla']) {
    assert(new RegExp(`th\\.${c}\\s*\\{[^}]*min-width`).test(h), `falta min-width para .${c}`);
    assert(h.includes(`cls:'${c}'`), `a coluna ${c} não leva a classe para o <th>`);
  }
});

t('G2 cliente e título quebram linha em vez de serem cortados', () => {
  const h = ler('public/os/ordens-servico.html');
  assert(/td\.q-quebra[\s\S]{0,120}white-space:\s*normal/.test(h), 'falta a regra de quebra');
  assert((h.match(/class="q-quebra"/g) || []).length >= 2, 'nenhuma célula usa a quebra');
});

// Esta checagem nasceu de um erro cometido ao corrigir o G1: os pisos somaram
// mais do que a largura disponível, e a última coluna (Total, e em Contratos o
// botão) foi para fora da vista, atrás de uma rolagem horizontal no
// `.tabela-rolagem` — que não é o `.tbl-wrap`, e por isso passou despercebida.
// O orçamento é o wrapper em 1440px: 1128px, descontados menu e respiros.
function somaDosPisos(html) {
  let soma = 60; // a coluna do lápis mede 60px, fixa
  for (const m of html.matchAll(/th\.[\w-]+\s*\{[^}]*min-width:\s*(\d+)px/g)) soma += Number(m[1]);
  return soma;
}

t('G2b os pisos declarados cabem na largura de 1440px', () => {
  for (const tela of ['public/os/ordens-servico.html', 'public/comercial/contratos.html']) {
    const soma = somaDosPisos(ler(tela));
    assert(soma <= 1128, `${tela}: os pisos somam ${soma}px e o espaço é 1128px — a última coluna sai da vista`);
  }
});

t('G3 a lista de contratos também tem piso de largura', () => {
  const h = ler('public/comercial/contratos.html');
  for (const c of ['c-numero', 'c-cliente', 'c-vigencia']) {
    assert(new RegExp(`th\\.${c}\\s*\\{[^}]*min-width`).test(h), `falta min-width para .${c}`);
  }
});

t('G4 o valor em dinheiro não quebra entre o R$ e o número', () => {
  assert(/\.cel-valor\s*\{[^}]*white-space:\s*nowrap/.test(ler('public/css/app-modern.css')),
    'falta a classe .cel-valor');
  for (const tela of ['public/financeiro/contas-a-receber.html', 'public/cobranca/cobrancas.html']) {
    assert(ler(tela).includes('cel-valor'), `${tela} não usa .cel-valor`);
  }
});

t('G5 as datas saem em dd/mm/aaaa, e a competência em mm/aaaa', () => {
  for (const tela of ['public/os/ordens-servico.html', 'public/os/ordem-servico.html',
                      'public/os/os-relatorios.html', 'public/comercial/contratos.html']) {
    assert(/function fmtData\(/.test(ler(tela)), `${tela} não tem formatador de data`);
  }
  const rec = ler('public/financeiro/recorrencias.html');
  assert(rec.includes('fmtCompetencia'), 'recorrências não formata a competência');
  assert(ler('public/comercial/contratos.html').includes('fmtData(c.dataInicio)'),
    'a vigência do contrato continua em ISO');
  assert(ler('public/comercial/contrato.html').includes('fmtData(contrato.dataProximoReajuste)'),
    'o próximo reajuste continua em ISO');
});

t('G6 cabeçalhos de Recorrências com acento', () => {
  const h = ler('public/financeiro/recorrencias.html');
  assert(h.includes('<th>Serviço</th>'), 'ainda está "Servico"');
  assert(h.includes('<th>Última emissão</th>'), 'ainda está "Ultima Emissao"');
});

t('G7 o botão que emite nota e boleto diz o que faz', () => {
  const h = ler('public/financeiro/recorrencias.html');
  assert(h.includes('Emitir agora'), 'o ▶ continua sem rótulo');
  assert(h.includes('Pausar') && h.includes('Reativar'), 'os outros botões continuam só ícone');
});

t('G7b os botões de Cobranças também têm rótulo', () => {
  const h = ler('public/cobranca/cobrancas.html');
  for (const r of ['E-mail</button>', 'WhatsApp</button>', 'Histórico</button>']) {
    assert(h.includes(r), `falta o rótulo: ${r}`);
  }
  assert(h.includes('Pausar') && h.includes('Retomar'), 'o botão de pausa continua só ícone');
});

t('G8 o jargão fiscal saiu da tela de trabalho da OS', () => {
  const h = ler('public/os/ordem-servico.html');
  for (const termo of ['vDesc', 'vDescIncond', 'cTribNac', 'cNBS']) {
    assert(!h.includes(termo), `"${termo}" ainda aparece na tela da OS`);
  }
});

t('G9 o campo de valor fechado diz o que é', () => {
  const h = ler('public/os/ordem-servico.html');
  assert(!h.includes('Total (alternativo)'), 'o rótulo antigo continua');
  assert(h.includes('Valor fechado (R$)'), 'falta o rótulo novo');
});

t('G10 a capa da OS mostra prazo e SLA', () => {
  const h = ler('public/os/ordem-servico.html');
  assert(h.includes('function prazoDaCapa'), 'falta o prazo na capa');
  assert(h.includes("campo('Prazo', prazoDaCapa(o))"), 'o prazo não entrou no grid de informações');
});

t('G11 equipamento, série e garantia só aparecem quando há', () => {
  const h = ler('public/os/ordem-servico.html');
  assert(!/campo\('Equipamento',[^)]*\|\| '—'/.test(h), 'Equipamento ainda força o travessão');
  assert(!/campo\('Nº de série', escapeHtml\(o\.numeroSerieEquipamento \|\| '—'\)/.test(h),
    'Nº de série ainda força o travessão');
  assert(h.includes("o.garantiaDias > 0 ?"), 'Garantia ainda aparece zerada');
});

t('G12 o relatório por cliente diz que é das OS, e a coluna de equipamento é condicional', () => {
  const h = ler('public/os/os-relatorios.html');
  assert(h.includes('Resultado das OS por cliente'), 'o nome antigo continua');
  assert(h.includes('const usaEquip'), 'a coluna de equipamento não é condicional');
});

// ======================================= H. o que a tela promete, ela entrega
// As sete correções de 01/10/2026, saídas do retrato de construção: a tela
// oferecia envio sem canal, explicava coluna só no balão do mouse e prometia
// variável que não tinha como preencher.
console.log('\nH. A cobrança não promete o que não consegue mandar');

const cobrancas = require(path.join(RAIZ, 'cobrancas-routes'));

t('H1 estadoDosCanais lê os três canais, e tenant limpo não tem nenhum', () => {
  assert(typeof cobrancas.estadoDosCanais === 'function', 'estadoDosCanais não é exportada');
  const c = cobrancas.estadoDosCanais(db);
  assert(c.email === false, 'sem SMTP, email devia ser false: ' + c.email);
  assert(c.whatsapp === false, 'sem instância, whatsapp devia ser false: ' + c.whatsapp);
  assert(c.boleto === false, 'sem provedor, boleto devia ser false: ' + c.boleto);
});

t('H1b com SMTP e provedor de boleto gravados, o estado vira true', () => {
  const smtp = db.prepare('INSERT OR REPLACE INTO smtp_config (key, value) VALUES (?, ?)');
  for (const [k, v] of [['host', 'smtp.exemplo.com.br'], ['port', '587'], ['user', 'envio@exemplo.com.br'], ['pass', 'x']]) smtp.run(k, v);
  db.prepare(`INSERT INTO contas_financeiras (id, nome, tipo) VALUES (91, 'Conta de teste', 'banco')`).run();
  db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo)
    VALUES (91, 'asaas', 'producao', 1)`).run();
  const c = cobrancas.estadoDosCanais(db);
  assert(c.email === true, 'com SMTP gravado, email devia ser true');
  assert(c.boleto === true, 'com provedor ativo, boleto devia ser true');
  // desfaz, para não contaminar quem rodar depois neste mesmo banco
  db.prepare('DELETE FROM smtp_config').run();
  db.prepare('DELETE FROM contas_financeiras_boleto').run();
  assert(cobrancas.estadoDosCanais(db).email === false, 'o estado não voltou depois da limpeza');
});

t('H1c provedor de boleto desativado não conta como canal', () => {
  db.prepare(`INSERT INTO contas_financeiras_boleto (contaFinanceiraId, provedor, ambiente, ativo)
    VALUES (91, 'asaas', 'producao', 0)`).run();
  assert(cobrancas.estadoDosCanais(db).boleto === false, 'provedor com ativo=0 não devia contar');
  db.prepare('DELETE FROM contas_financeiras_boleto').run();
});

t('H2 as duas rotas que a tela chama devolvem o estado dos canais', () => {
  const src = ler('cobrancas-routes.js');
  const cfg = src.slice(src.indexOf("app.get('/api/cobrancas/config'"), src.indexOf("app.post('/api/cobrancas/config'"));
  assert(/canais:\s*estadoDosCanais\(db\)/.test(cfg), 'GET /api/cobrancas/config não devolve canais');
  const venc = src.slice(src.indexOf("app.get('/api/cobrancas/contas-vencidas'"), src.indexOf("app.post('/api/cobrancas/enviar/"));
  assert(/canais:\s*estadoDosCanais\(db\)/.test(venc), 'a lista de vencidas não devolve canais');
});

t('H3 a tela de Cobranças avisa e desativa o envio quando não há canal', () => {
  const h = ler('public/cobranca/cobrancas.html');
  assert(h.includes('id="semCanal"'), 'falta a caixa de aviso');
  assert(h.includes('function aplicarCanais'), 'falta a função que aplica o estado');
  assert(/Para enviar as cobranças, configure o e-mail ou o WhatsApp/.test(h), 'falta o texto do aviso');
  assert(h.includes('id="btnRegua"'), 'o botão da régua não tem id para ser desativado');
  assert(/btn\.disabled = falta/.test(h), 'o botão não é desativado');
  assert(/aplicarCanais\(data\.canais\)/.test(h), 'a tela não usa o estado que a rota manda');
  // Os três botões de envio em massa também se desligam, cada um pelo seu canal
  for (const canal of ['email', 'whatsapp', 'ambos']) {
    assert(h.includes(`data-canal="${canal}"`), 'botão de massa sem data-canal: ' + canal);
  }
});

t('H4 a tela de Configuração traz o mesmo aviso', () => {
  const h = ler('public/cobranca/cobrancas-config.html');
  assert(h.includes('id="semCanal"'), 'falta a caixa de aviso');
  assert(/Para enviar as cobranças, configure o e-mail ou o WhatsApp/.test(h), 'falta o texto do aviso');
  assert(/canaisAtuais = data\.canais/.test(h), 'a tela não lê o estado dos canais');
});

t('H5 sem provedor de boleto, as variáveis de boleto saem marcadas e com motivo', () => {
  const h = ler('public/cobranca/cobrancas-config.html');
  // Só as tags: o seletor do JS também carrega a string, e contá-lo mascararia
  // uma variável que tivesse perdido a marca no HTML.
  const marcadas = (h.match(/<code data-exige="boleto">\{\{(\w+)\}\}<\/code>/g) || []);
  assert(marcadas.length === 2, 'as duas variáveis de boleto deviam estar marcadas, achei ' + marcadas.length);
  assert(marcadas.join().includes('linhaDigitavel') && marcadas.join().includes('linkBoleto'),
    'as marcadas não são a linha digitável e o link: ' + marcadas.join(' '));
  assert(h.includes('function marcarVariaveis'), 'falta a função que marca as variáveis');
  assert(h.includes('.variaveis-info code.indisponivel'), 'falta o estilo da variável indisponível');
  assert(/saem vazias/.test(h), 'o motivo não aparece na tela');
  assert(/Hoje elas estão no texto de/.test(h), 'a tela não diz em que etapa a variável está sendo usada');
});

t('H6 o e-mail em cópia mostra um exemplo, e não um endereço que pareça configurado', () => {
  const h = ler('public/cobranca/cobrancas-config.html');
  assert(/placeholder="exemplo: /.test(h), 'o placeholder não se anuncia como exemplo');
  assert(!/placeholder="financeiro@empresa\.com\.br"/.test(h), 'o placeholder antigo continua');
});

t('H7 Contas a Receber: título sem emoji e a coluna explicada na tela', () => {
  const h = ler('public/financeiro/contas-a-receber.html');
  assert(/<h1>Contas a Receber<\/h1>/.test(h), 'o título mudou ou ainda tem emoji');
  assert(!/<h1>[^<]*[\u{1F300}-\u{1FAFF}]/u.test(h), 'ainda há emoji no título');
  assert(/<small class="th-nota">com juros e multa<\/small>/.test(h), 'a coluna "Com atraso" não se explica na tela');
  assert(h.includes('.th-nota'), 'falta o estilo da nota de cabeçalho');
});

t('H8 o pedido remede a altura da descrição depois de preencher a coluna Disponível', () => {
  const h = ler('public/comercial/pedido.html');
  const i = h.indexOf('function aplicarFalta');
  assert(i > 0, 'aplicarFalta sumiu');
  const bloco = h.slice(i, h.indexOf('function', i + 20) > 0 ? h.indexOf("const aviso = document.getElementById('avisoFalta')", i) : h.length);
  assert(/textarea\.desc-item'\)\.forEach\(ajustarAltura\)/.test(bloco),
    'aplicarFalta não remede a altura: a descrição volta a sair cortada quando falta saldo');
});

// ---------------------------------------------------------------- fim
db.close();
try { fs.unlinkSync(DB); } catch {}
console.log(`\n${ok} OK, ${fail} FALHA(S)`);
if (fail) { console.log(`FALHOU: ${fail} problema(s)`); process.exit(1); }
console.log('PASSOU');
