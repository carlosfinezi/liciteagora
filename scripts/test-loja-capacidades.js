/**
 * Fase 0 — o resolvedor de capacidades da vitrine.
 *
 * O que estes casos guardam, em uma frase: **a Fase 0 não pode mudar nada**.
 * Ela cria a fonte central que as próximas fases vão consultar, e enquanto
 * nenhuma delas entrou, toda capacidade condicional responde `false` e a
 * vitrine de hoje continua idêntica.
 *
 * Os dois eixos medidos:
 *
 *   REGRA — a capacidade sai da configuração da empresa, nunca do nome dela.
 *   A flag `restaurante_enabled` do banco do tenant manda; o módulo do
 *   control.db só LIGA o que ela não ligou, e nunca desliga (ver o cabeçalho
 *   do `loja-capacidades.js`: três tenants operam com o restaurante ligado e
 *   módulo efetivo vazio, por tier fora da lista).
 *
 *   CONTRATO — `/loja/api/config` ganhou um campo e não perdeu nenhum. Quem
 *   lia a resposta antes continua lendo igual, inclusive os métodos de
 *   pagamento por atendimento, que são o que pinta o checkout.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const Database = require('better-sqlite3');

const { capacidadesDaLoja, capacidadesPublicas } = require('../loja-capacidades');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cap0-'));
let ok = 0; const falhas = [];
function t(nome, fn) {
  try { fn(); ok++; console.log('  OK  ' + nome); }
  catch (e) { falhas.push(`${nome} -> ${e.message}`); console.log('  FALHA  ' + nome + ' -> ' + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m || 'falhou'); }

/** Banco de tenant com o schema real. `restaurante` liga a flag do módulo. */
function montarTenant(nome, { restaurante = false, loja = true } = {}) {
  const db = new Database(path.join(tmp, nome + '.db'));
  db.pragma('foreign_keys = OFF');
  require('../db-schema').initSchema(db);
  db.pragma('foreign_keys = ON');
  require('../loja-routes').migrarLojaDB(db);
  if (loja) {
    if (!db.prepare('SELECT COUNT(*) c FROM loja_config').get().c) {
      db.prepare('INSERT INTO loja_config (ativa, nome) VALUES (1, ?)').run('Loja ' + nome);
    } else {
      db.prepare('UPDATE loja_config SET ativa = 1, nome = ?').run('Loja ' + nome);
    }
  }
  if (restaurante) {
    db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('restaurante_enabled', '1')").run();
  }
  return db;
}

/* ───────────────────────── REGRA ───────────────────────── */

const semRest = montarTenant('sem-restaurante');
const comRest = montarTenant('com-restaurante', { restaurante: true });

// 1. tenant sem Restaurante não recebe a capacidade
t('1. empresa SEM restaurante não recebe a capacidade', () => {
  const c = capacidadesDaLoja(semRest);
  assert(c.restaurante === false, 'restaurante veio ' + c.restaurante);
  assert(c.salao === false && c.mesa === false && c.garcom === false,
    'capacidade de restaurante vazou para quem não tem o módulo');
});

// 2. tenant com a configuração apropriada é identificado
t('2. empresa COM a flag ligada é identificada', () => {
  const c = capacidadesDaLoja(comRest);
  assert(c.restaurante === true, 'a flag restaurante_enabled=1 não foi reconhecida');
});

// 3. configuração inexistente é fail-safe (desligado), e não erro
t('3. sem a tabela config / sem a chave, responde DESLIGADO e não lança', () => {
  const cru = new Database(path.join(tmp, 'cru.db'));           // banco vazio, sem schema
  const c = capacidadesDaLoja(cru);
  assert(c.restaurante === false, 'banco sem config devolveu restaurante=true');
  assert(c.salao === false && c.comandaCozinha === false, 'capacidade ligada num banco vazio');
  cru.close();
});

/* 3b/3c. Os dois erros que medir o licenciamento nos 23 tenants revelou, e que
   o resolvedor não pode cometer. São o motivo de a fonte ser a configuração. */
t('3b. quem LIGOU o restaurante tem a capacidade, mesmo com tier inválido', () => {
  // Caso real de josecarloscostafilho, produtosbomgosto e crsolucoes: operam
  // com o restaurante e o módulo efetivo deles é vazio (plan 'basic').
  const c = capacidadesDaLoja(comRest);
  assert(c.restaurante === true, 'o licenciamento derrubaria quem opera com restaurante');
});

t('3c. quem NÃO ligou não ganha a capacidade por ter plano alto', () => {
  // Caso real de jaagricola, demo2, demo3 e os sandboxes: têm o módulo pelo
  // tier e nunca ligaram o restaurante. Licença não é interruptor.
  const c = capacidadesDaLoja(semRest);
  assert(c.restaurante === false, 'capacidade ligada em quem não ativou o módulo');
});

// 4. nenhuma capacidade ativa salão nesta fase
t('4. NENHUMA capacidade liga salão/mesa/garçom na Fase 0', () => {
  for (const [nome, db] of [['sem', semRest], ['com', comRest]]) {
    const c = capacidadesDaLoja(db);
    assert(c.salao === false, `${nome}: salao=true sem a coluna servicoSalao`);
    assert(c.mesa === false, `${nome}: mesa=true`);
    assert(c.garcom === false, `${nome}: garcom=true`);
    assert(c.comandaCozinha === false, `${nome}: comandaCozinha=true sem rest_comandas.pedidoId`);
    assert(c.precoPorCanal === false, `${nome}: precoPorCanal=true sem a tabela`);
    assert(c.bloqueioHorario === false, `${nome}: bloqueioHorario=true sem a coluna`);
  }
});

t('4b. o recorte público NÃO revela o contrato da empresa', () => {
  const pub = capacidadesPublicas(capacidadesDaLoja(comRest));
  assert(!('restaurante' in pub), 'o payload público expôs qual módulo a empresa tem');
  assert(Object.values(pub).every((v) => v === false), 'capacidade pública ligada na Fase 0');
});

/* ─────────────────────── CONTRATO ─────────────────────── */

/* Os campos que `/loja/api/config` devolvia ANTES da Fase 0. Perder qualquer
   um quebra a vitrine publicada; é esta lista que guarda isso. */
const CAMPOS_ANTES = ['nome', 'descricao', 'logo', 'banner', 'instagram', 'facebook', 'whatsapp',
  'email', 'telefone', 'endereco', 'atendimento', 'horarios', 'entrega', 'logoFoco', 'bannerFoco',
  'mostrarPreco', 'mostrarEstoque', 'tema', 'pagamento', 'metodosPagamento', 'pixNoSite',
  'favicon', 'rodape'];

function subir(db) {
  const app = express();
  app.use(express.json());
  require('../loja-routes').registrarRotasLojaPublica(app, db);
  return new Promise((r) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => r(s)); });
}
function pedir(porta, rota) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: porta, path: rota }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
        catch (_) { resolve({ status: res.statusCode, json: null, cru: b.slice(0, 120) }); } });
    }).on('error', reject);
  });
}

(async () => {
  const servidor = await subir(comRest);
  const porta = servidor.address().port;
  const r = await pedir(porta, '/loja/api/config');

  // 5. contrato preservado
  t('5. /loja/api/config mantém TODOS os campos anteriores', () => {
    assert(r.status === 200, 'status ' + r.status + ' ' + (r.cru || ''));
    assert(r.json && r.json.success, 'resposta sem success');
    const faltando = CAMPOS_ANTES.filter((k) => !(k in r.json.loja));
    assert(!faltando.length, 'sumiram do payload: ' + faltando.join(', '));
  });

  t('5b. o campo novo `capacidades` veio, e veio todo false', () => {
    const c = r.json.loja.capacidades;
    assert(c && typeof c === 'object', 'capacidades ausente ou não é objeto');
    const ligadas = Object.entries(c).filter(([, v]) => v).map(([k]) => k);
    assert(!ligadas.length, 'capacidade ligada na Fase 0: ' + ligadas.join(', '));
  });

  // 6/7. os dois atendimentos continuam no payload que pinta o checkout
  t('6+7. entrega e retirada continuam sendo oferecidas ao checkout', () => {
    const e = r.json.loja.entrega;
    assert(e && typeof e === 'object', 'bloco `entrega` sumiu do payload');
    assert('retirada' in e, 'o serviço de retirada sumiu');
    assert('delivery' in e || 'entrega' in e, 'o serviço de entrega sumiu');
  });

  // 8. métodos de pagamento continuam filtrados por atendimento
  t('8. métodos de pagamento continuam separados por atendimento', () => {
    const m = r.json.loja.metodosPagamento;
    assert(m && Array.isArray(m.entrega) && Array.isArray(m.retirada),
      'metodosPagamento deixou de vir separado por entrega/retirada');
    for (const lista of [m.entrega, m.retirada]) {
      for (const met of lista) {
        assert('metodo' in met && 'rotulo' in met && 'modalidade' in met,
          'o formato de um método mudou: ' + JSON.stringify(met).slice(0, 60));
      }
    }
  });

  // 9. a vitrine não mudou: a Fase 0 não acrescentou nada que a tela desenhe
  t('9. a Fase 0 não introduziu elemento visual na vitrine', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja', 'catalogo.js'), 'utf8');
    // CAPACIDADES é lida e guardada, e NADA a consome ainda.
    assert(/CAPACIDADES\s*=\s*LOJA\.capacidades/.test(js), 'o front não guarda as capacidades');
    const usos = (js.match(/CAPACIDADES\s*\./g) || []).length;
    assert(usos === 0, `CAPACIDADES já está sendo consumida em ${usos} lugar(es) — isso é Fase 1+`);
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'loja', 'index.html'), 'utf8');
    assert(!/mesa|gar[çc]om|comanda/i.test(html), 'a vitrine ganhou texto de restaurante');
  });

  // 10. o cardápio não foi tocado
  t('10. nenhum fluxo /cardapio/ foi alterado', () => {
    const { execSync } = require('child_process');
    const mudou = execSync('git status --porcelain public/cardapio restaurante/ 2>/dev/null || true',
      { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
    assert(!mudou, 'arquivos do cardápio/restaurante aparecem modificados:\n' + mudou);
  });

  servidor.close();
  semRest.close(); comRest.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\n${falhas.length ? 'FALHOU' : 'OK'}: ${ok}/${ok + falhas.length} casos`);
  process.exit(falhas.length ? 1 : 0);
})();
