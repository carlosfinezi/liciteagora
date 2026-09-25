/**
 * Ciclo de reemissão SSL: a janela e o aviso de véspera.
 *
 * O que está em jogo: a assinatura é o que se paga (1 ano ou mais) e o arquivo
 * é o que se instala. Hoje o arquivo vale ~200 dias, então uma assinatura anual
 * consome duas emissões; quando o teto das CAs cair para 47 dias, passa a
 * consumir oito. Reissue é gratuito e automático — só que DCV por e-mail não é
 * automático coisa nenhuma: a CA escreve para o aprovador do domínio, que é do
 * CLIENTE, e a reemissão fica parada até alguém clicar.
 *
 * Em 17/09/2026 esta conta tinha 10 certificados assim, todos de órgãos
 * públicos. A 47 dias, cada um vira oito esperas por ano.
 *
 * Banco descartável; nada aqui chama a NicSRS.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const Database = require(path.join(RAIZ, 'node_modules/better-sqlite3'));
const { antecedenciaReissue } = require(path.join(RAIZ, 'ssl-certificados-routes.js'));

let okN = 0, falhas = 0;
const t = (n, f) => { try { f(); console.log('  OK  ' + n); okN++; } catch (e) { falhas++; console.log('FALHA ' + n + ' -> ' + e.message); } };
const ok = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`); };

// db mínimo: antecedenciaReissue só lê a config da antecedência.
const dbCfg = (valor) => ({ prepare: () => ({ get: () => (valor == null ? undefined : { valor: String(valor) }) }) });
const DB = dbCfg(15);   // o padrão do tenant 1bit

// ---- a janela acompanha a validade ----
//
// É o que mantém a regra correta quando o teto cair de 200 para 47 dias, sem
// ninguém reconfigurar nada.
t('1. janela proporcional à validade, com teto da config', () => {
  eq(antecedenciaReissue(DB, 398), 15, 'validade anual usa o teto');
  eq(antecedenciaReissue(DB, 200), 15, 'validade de hoje usa o teto');
  eq(antecedenciaReissue(DB, 47), 12, 'validade futura encolhe a janela (25%)');
  eq(antecedenciaReissue(DB, 8), 3, 'piso de 3 dias, para caber tentativas do scheduler (12/12h)');
});

t('2. sem saber a validade, vale o teto', () => {
  eq(antecedenciaReissue(DB, null), 15, 'validade desconhecida');
  eq(antecedenciaReissue(DB, 0), 15, 'validade zero é desconhecida, não zero');
});

// ---- DCV por e-mail: a janela dobra ----
t('3. DCV por e-mail ganha o dobro de janela', () => {
  eq(antecedenciaReissue(DB, 200, 'EMAIL'), 30, '200 dias: 15 -> 30');
  eq(antecedenciaReissue(DB, 47, 'EMAIL'), 19, '47 dias: 12 -> 24, limitado a 40% de 47');
  ok(antecedenciaReissue(DB, 47, 'EMAIL') > antecedenciaReissue(DB, 47, 'CNAME_CSR_HASH'),
     'e-mail precisa de MAIS tempo que CNAME');
});

t('4. a janela não engole o ciclo', () => {
  // Reemitir cedo demais desperdiça arquivo válido e multiplica as reemissões.
  for (const v of [47, 90, 200, 398]) {
    const ant = antecedenciaReissue(DB, v, 'EMAIL');
    ok(ant <= Math.round(v * 0.4), `validade ${v}: janela ${ant} passou de 40%`);
    ok(ant > 0, `validade ${v}: janela zerada`);
  }
});

t('5. métodos automáticos NÃO ganham janela extra', () => {
  // CNAME e HTTP revalidam sozinhos; alargar a janela só desperdiçaria arquivo.
  for (const m of ['CNAME_CSR_HASH', 'HTTP_CSR_HASH', 'HTTPS_CSR_HASH', 'DNS_TXT', null, '']) {
    eq(antecedenciaReissue(DB, 200, m), 15, 'método ' + m);
  }
  // A comparação não pode depender de caixa.
  eq(antecedenciaReissue(DB, 200, 'email'), 30, 'minúsculo');
});

// ---- o aviso de véspera ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ssl-reissue-'));
const db = new Database(path.join(TMP, 'teste.db'));
const logReal = console.log;
console.log = () => {};
// foreign_keys OFF durante o initSchema: há seeds que referenciam tabelas ainda
// não criadas. Mesmo caminho de scripts/test-catalogo-fase52.js.
db.pragma('foreign_keys = OFF');
require(path.join(RAIZ, 'db-schema')).initSchema(db);
require(path.join(RAIZ, 'ssl-certificados-routes')).migrarDB(db);
console.log = logReal;

const sched = require(path.join(RAIZ, 'ssl-certificados-scheduler.js'));

const emDias = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const inserir = (id, dcvMethod, proximoReissueEm, status = 'emitido') => db.prepare(`
  INSERT INTO ssl_certificados (id, commonName, productCode, status, dcvMethod, dcvEmail,
                                endDate, cobertoAte, proximoReissueEm, reissuesFeitos)
  VALUES (?,?,?,?,?,?,?,?,?,0)
`).run(id, `d${id}.exemplo.gov.br`, 'certum-dv-ssl', status, dcvMethod,
       dcvMethod === 'EMAIL' ? `admin@d${id}.exemplo.gov.br` : null,
       emDias(20), emDias(300), proximoReissueEm);

inserir(1, 'EMAIL', emDias(3));              // dentro da janela de aviso
inserir(2, 'CNAME_CSR_HASH', emDias(3));     // automático: não avisa
inserir(3, 'EMAIL', emDias(30));             // ainda longe
inserir(4, 'EMAIL', null);                   // sem reemissão agendada
inserir(5, 'EMAIL', emDias(2), 'cancelado'); // não está emitido

(async () => {
  const enviados = await sched.alertarReissueManual(db, 7);

  t('6. avisa só o que depende de clique e está perto', () => {
    eq(enviados, 1, 'alertas enviados');
    const avisados = db.prepare(`
      SELECT certificadoId FROM ssl_certificados_eventos
      WHERE tipo LIKE 'alerta-dcv-manual-%' ORDER BY certificadoId
    `).all().map((r) => r.certificadoId);
    eq(avisados.join(','), '1', 'só o #1 deveria ter sido avisado');
  });

  const segunda = await sched.alertarReissueManual(db, 7);
  t('7. rodar de novo não duplica o aviso', () => {
    eq(segunda, 0, 'o scheduler roda de 12 em 12h: repetir viraria spam');
  });

  // `reissuesFeitos` é a marca do ciclo — reemitido, o aviso é devido de novo.
  db.prepare('UPDATE ssl_certificados SET reissuesFeitos = 1 WHERE id = 1').run();
  const terceira = await sched.alertarReissueManual(db, 7);
  t('8. ciclo novo, aviso novo', () => {
    eq(terceira, 1, 'depois de reemitir, o próximo ciclo precisa avisar outra vez');
  });

  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n  ${okN} ok, ${falhas} falha(s)\n`);
  process.exit(falhas ? 1 : 0);
})();
