/**
 * Pop-up de mensagem nova — VAPID, inscrição e o que o aviso mostra.
 *
 * ── Por que esta suíte existe ──────────────────────────────────────────────
 *
 * O Web Push foi escrito à mão, sem biblioteca (`npm install` é vedado nesta
 * árvore). Isso concentra o risco em dois pontos que não dão erro legível
 * quando estão errados:
 *
 *  1. **A assinatura do VAPID.** O Node assina em DER e o padrão JOSE exige
 *     r||s com 32 bytes cada. Em DER, o servidor de push devolve 401 sem dizer
 *     por quê. O teste A3 verifica a assinatura com a chave pública, que é o
 *     mesmo que o Google faz do outro lado.
 *  2. **A chave pública.** Precisa sair em "raw uncompressed" de 65 bytes
 *     começando em 0x04 — não no DER do SPKI. Errado, o navegador recusa a
 *     inscrição com `InvalidAccessError`, e a mensagem não ajuda ninguém.
 *
 * ── E o que importa antes da criptografia ──────────────────────────────────
 *
 * Que o conteúdo da conversa NÃO passe pelo servidor de push, que a empresa
 * consiga calar tudo de uma vez, e que inscrição morta seja removida em vez de
 * consumir requisição para sempre.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const P = require('../push-web');

const DB = '/tmp/vp-push.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = require('./schema-de-tenant').lerSchema('/tmp/vp-push-schema.sql');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

/**
 * `push_inscricoes` vem do `db-schema.js`, e não do schema extraído do tenant.
 *
 * O schema de teste sai do banco de produção, onde a tabela só aparece depois do
 * primeiro boot com a migration — ou seja, entre escrever a migration e
 * reiniciar o servidor, a suíte rodaria contra um banco sem a tabela e reprovaria
 * sem haver defeito nenhum.
 *
 * Ler a definição do `db-schema.js` resolve isso e ainda amarra o teste à FONTE:
 * se alguém mudar a tabela lá, é essa a versão que passa a ser testada; se
 * alguém a apagar, este trecho reprova antes de qualquer outra coisa.
 */
{
  const fonte = fs.readFileSync(path.join(RAIZ, 'db-schema.js'), 'utf8');
  const i = fonte.indexOf('CREATE TABLE IF NOT EXISTS push_inscricoes');
  if (i < 0) { console.log('FALHA push_inscricoes não está no db-schema.js'); process.exit(1); }
  const fim = fonte.indexOf(');', i) + 2;
  db.exec(fonte.slice(i, fim));
  db.exec('CREATE INDEX IF NOT EXISTS idx_push_usuario ON push_inscricoes(usuarioId)');
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { console.log('  OK  ' + nome); ok++; },
        (e) => { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; });
    }
    console.log('  OK  ' + nome); ok++;
  } catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  return Promise.resolve();
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const b64urlParaBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

(async () => {
  // ==================== A. VAPID ====================

  const chaves = P.lerOuCriarChaves(db);

  await t('A1. a chave publica sai em raw de 65 bytes, comecando em 0x04', () => {
    const raw = b64urlParaBuf(chaves.publica);
    assert(raw.length === 65, `a chave tem ${raw.length} bytes — o navegador recusa o que não for 65`);
    assert(raw[0] === 0x04, `começa em 0x${raw[0].toString(16)} — deveria ser 0x04 (ponto não comprimido)`);
  });

  await t('A2. a chave mora no BANCO do tenant, nao em arquivo', () => {
    // Em arquivo, ela durou uma tarde: nasceu root:root e o servidor web, que
    // roda como carlosfinezi, não conseguia ler a própria chave — a rota
    // devolvia erro e o recurso ficava morto, sem nada no log.
    const guardada = db.prepare("SELECT valor FROM config WHERE chave = 'push_vapid_privada'").get();
    assert(guardada && /BEGIN PRIVATE KEY/.test(guardada.valor), 'a chave privada não foi guardada no banco');
    // Sem os comentários: o cabeçalho do módulo CONTA essa história, e contar a
    // história não pode reprovar o teste que a guarda.
    const fonte = fs.readFileSync(path.join(RAIZ, 'push-web.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert(!/writeFileSync|vapid\.json/.test(fonte),
      'o módulo voltou a gravar a chave em arquivo — dois processos com donos diferentes disputam esse arquivo');
  });

  await t('A3. a assinatura do JWT confere com a chave publica', () => {
    // É o mesmo que o servidor de push faz. Em DER, isto reprova — e em produção
    // o sintoma seria um 401 silencioso, sem push e sem erro em log nenhum.
    const jwt = P.montarJwt('https://fcm.googleapis.com', chaves.privadaPem, 'mailto:x@y.z');
    const [h, c, s] = jwt.split('.');
    const assinatura = b64urlParaBuf(s);
    assert(assinatura.length === 64, `assinatura com ${assinatura.length} bytes — JOSE exige 64 (r||s)`);

    const raw = b64urlParaBuf(chaves.publica);
    const pub = crypto.createPublicKey({
      key: Buffer.concat([
        Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), raw]),
      format: 'der', type: 'spki',
    });
    const valido = crypto.createVerify('SHA256').update(`${h}.${c}`)
      .verify({ key: pub, dsaEncoding: 'ieee-p1363' }, assinatura);
    assert(valido, 'a assinatura não confere com a chave pública');
  });

  await t('A4. o JWT diz para QUEM vale e por quanto tempo', () => {
    const jwt = P.montarJwt('https://updates.push.services.mozilla.com', chaves.privadaPem, 'mailto:x@y.z');
    const corpo = JSON.parse(b64urlParaBuf(jwt.split('.')[1]).toString());
    assert(corpo.aud === 'https://updates.push.services.mozilla.com',
      `a audiência veio "${corpo.aud}" — errada, o push é recusado`);
    const horas = (corpo.exp - Math.floor(Date.now() / 1000)) / 3600;
    assert(horas > 0 && horas <= 24, `validade de ${horas.toFixed(1)}h — o padrão recusa acima de 24h`);
    assert(/^mailto:/.test(corpo.sub), 'o `sub` precisa ser mailto: ou https:');
  });

  await t('A5. o par e reaproveitado, nao recriado a cada chamada', () => {
    // Recriar invalidaria todas as inscrições existentes a cada boot: os
    // navegadores passariam a recusar com 403 e ninguém receberia mais nada.
    const outra = P.lerOuCriarChaves(db);
    assert(outra.publica === chaves.publica, 'a chave pública mudou entre duas leituras');
  });

  // ==================== B. o envio ====================

  // Servidor de push de mentira: responde o que o teste mandar e guarda o que
  // recebeu. É aqui que se confirma que o corpo vai VAZIO.
  const recebidos = [];
  let resposta = 201;
  const push = express();
  push.use((rq, rs) => {
    const pedacos = [];
    rq.on('data', (d) => pedacos.push(d));
    rq.on('end', () => {
      recebidos.push({ url: rq.url, headers: rq.headers, corpo: Buffer.concat(pedacos) });
      rs.status(resposta).end();
    });
  });
  const srvPush = push.listen(34161);
  const ENDPOINT = 'http://127.0.0.1:34161/push/abc';

  await t('B1. o push vai SEM corpo — o conteudo nao passa por terceiros', async () => {
    const r = await P.enviarSinal({ endpoint: ENDPOINT }, chaves, 'mailto:x@y.z');
    assert(r.ok, `o envio falhou com ${r.status}`);
    const ult = recebidos[recebidos.length - 1];
    assert(ult.corpo.length === 0,
      `foram ${ult.corpo.length} bytes de corpo — a conversa do cliente estaria trafegando pelo servidor de push`);
  });

  await t('B2. o cabecalho leva o VAPID e o prazo de validade', async () => {
    const ult = recebidos[recebidos.length - 1];
    assert(/^vapid t=.+, k=.+/.test(ult.headers.authorization || ''),
      'Authorization veio "' + (ult.headers.authorization || '') + '"');
    assert(Number(ult.headers.ttl) > 0 && Number(ult.headers.ttl) <= 3600,
      `TTL ${ult.headers.ttl} — aviso de atendimento não pode ficar dias na fila`);
  });

  await t('B3. 410 e reconhecido como inscricao MORTA', async () => {
    resposta = 410;
    const r = await P.enviarSinal({ endpoint: ENDPOINT }, chaves, 'mailto:x@y.z');
    assert(!r.ok && r.morta, 'um 410 precisa ser tratado como inscrição a remover');
    resposta = 500;
    const r2 = await P.enviarSinal({ endpoint: ENDPOINT }, chaves, 'mailto:x@y.z');
    assert(!r2.ok && !r2.morta, 'um 500 é falha temporária e NÃO pode apagar a inscrição de ninguém');
    resposta = 201;
  });

  // ==================== C. as rotas e a chave da empresa ====================

  const app = express();
  app.use(express.json());
  app.use((rq, _rs, nx) => { rq.user = { id: 10, username: 'ana' }; nx(); });
  require('../push-routes').registrarRotasPush(app, db);

  function call(metodo, caminho, { body = {}, user = { id: 10 } } = {}) {
    let h = null;
    for (const c of app.router.stack) {
      if (c.route && c.route.path === caminho && c.route.methods[metodo]) {
        h = c.route.stack[c.route.stack.length - 1].handle;
      }
    }
    if (!h) throw new Error('rota não registrada: ' + metodo + ' ' + caminho);
    let resp = null, status = 200;
    h({ body, params: {}, query: {}, user }, { json(o) { resp = o; return this; },
      status(s) { status = s; return this; } });
    return { status, json: resp };
  }

  await t('C1. inscrever guarda o aparelho, e reinscrever NAO duplica', () => {
    call('post', '/api/push/inscrever', { body: { endpoint: 'https://push.example/1', aparelho: 'Chrome' } });
    call('post', '/api/push/inscrever', { body: { endpoint: 'https://push.example/1', aparelho: 'Chrome' } });
    const n = db.prepare('SELECT COUNT(*) n FROM push_inscricoes').get().n;
    assert(n === 1, `${n} linhas para o mesmo aparelho — a pessoa receberia o aviso repetido`);
  });

  await t('C2. endpoint que nao e https e recusado', () => {
    const r = call('post', '/api/push/inscrever', { body: { endpoint: 'http://inseguro/1' } });
    assert(r.status === 400, `deveria recusar (veio ${r.status})`);
  });

  await t('C3. sem usuario na sessao, nao inscreve', () => {
    const r = call('post', '/api/push/inscrever', { body: { endpoint: 'https://push.example/9' }, user: null });
    assert(r.status === 401, `deveria recusar sem sessão (veio ${r.status})`);
  });

  await t('C4. desinscrever remove so aquele aparelho', () => {
    call('post', '/api/push/inscrever', { body: { endpoint: 'https://push.example/2' } });
    call('post', '/api/push/desinscrever', { body: { endpoint: 'https://push.example/2' } });
    const restam = db.prepare('SELECT endpoint FROM push_inscricoes').all().map(x => x.endpoint);
    assert(restam.length === 1 && restam[0] === 'https://push.example/1',
      'sobraram: ' + JSON.stringify(restam));
  });

  await t('C5. com a chave da empresa DESLIGADA, ninguem e avisado', async () => {
    db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('whatsapp_popup_ativo','0')").run();
    db.prepare('DELETE FROM push_inscricoes').run();
    db.prepare("INSERT INTO push_inscricoes (usuarioId, endpoint) VALUES (10, ?)").run(ENDPOINT);
    const antes = recebidos.length;
    const n = await require('../push-routes').avisarInscritos(db);
    assert(n === 0 && recebidos.length === antes,
      'saiu push com o aviso desligado na empresa — desligar tem de calar tudo de uma vez');
  });

  await t('C6. com a chave LIGADA, o aparelho inscrito recebe', async () => {
    db.prepare("INSERT OR REPLACE INTO config (chave, valor) VALUES ('whatsapp_popup_ativo','1')").run();
    const antes = recebidos.length;
    const n = await require('../push-routes').avisarInscritos(db);
    assert(n === 1, `avisou ${n} aparelho(s)`);
    assert(recebidos.length === antes + 1, 'o servidor de push não recebeu nada');
  });

  await t('C7. inscricao morta some sozinha depois do 410', async () => {
    resposta = 410;
    await require('../push-routes').avisarInscritos(db);
    const n = db.prepare('SELECT COUNT(*) n FROM push_inscricoes').get().n;
    assert(n === 0, 'a inscrição morta continuou no banco e seria tentada para sempre');
    resposta = 201;
  });

  // ==================== D. o que o aviso mostra ====================

  await t('D1. pendentes traz nome e trecho, so de mensagem RECEBIDA', () => {
    const agora = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO conv_conversas (canal, jid, telefone, nome, estado)
      VALUES ('whatsapp','5511988887777@s.whatsapp.net','5511988887777','João Silva','aberta')`).run();
    db.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, timestamp)
      VALUES ('m1','i','5511988887777@s.whatsapp.net',0,'Preciso da betoneira amanhã',?)`).run(agora - 60);
    db.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, from_bot, texto, timestamp)
      VALUES ('m2','i','5511988887777@s.whatsapp.net',1,1,'Claro! Posso ajudar?',?)`).run(agora - 30);

    const r = call('get', '/api/push/pendentes');
    assert(r.json.success, 'a rota falhou');
    assert(r.json.itens.length === 1, `veio ${r.json.itens.length} item(ns) — a resposta da IA não é mensagem nova`);
    assert(r.json.itens[0].quem === 'João Silva', `quem veio "${r.json.itens[0].quem}"`);
    assert(/betoneira/.test(r.json.itens[0].trecho), 'o trecho não é o da mensagem');
  });

  await t('D2. mensagem velha nao vira aviso', () => {
    db.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, timestamp)
      VALUES ('m3','i','5511988887777@s.whatsapp.net',0,'mensagem de ontem',?)`)
      .run(Math.floor(Date.now() / 1000) - 86400);
    const r = call('get', '/api/push/pendentes');
    assert(!r.json.itens.some(i => /ontem/.test(i.trecho)),
      'um push atrasado mostraria a conversa de ontem como se fosse agora');
  });

  await t('D3. o trecho e cortado no SERVIDOR', () => {
    const agora = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, texto, timestamp)
      VALUES ('m4','i','5511988887777@s.whatsapp.net',0,?,?)`).run('x'.repeat(4000), agora - 5);
    const r = call('get', '/api/push/pendentes');
    assert(r.json.itens[0].trecho.length <= 90,
      `o trecho veio com ${r.json.itens[0].trecho.length} caracteres — o que não sai do servidor não precisa ser escondido na tela`);
  });

  await t('D4. sem sessao, pendentes nao devolve conversa nenhuma', () => {
    const r = call('get', '/api/push/pendentes', { user: null });
    assert(r.status === 401, `deveria recusar (veio ${r.status})`);
  });

  // ==================== E. a fiação ====================

  await t('E1. o webhook avisa APENAS em mensagem nova e recebida', () => {
    const fonte = fs.readFileSync(path.join(RAIZ, 'whatsapp-webhook.js'), 'utf8');
    const i = fonte.indexOf('avisarInscritos');
    assert(i > 0, 'o webhook não chama o aviso');
    const bloco = fonte.slice(fonte.lastIndexOf('if (', i), i);
    assert(/info\.changes > 0/.test(bloco) && /!key\.fromMe/.test(bloco),
      'o aviso saiu da guarda de mensagem nova e recebida: eco e duplicata acordariam a equipe');
  });

  await t('E2. o aviso nao segura a resposta do webhook', () => {
    // Um servidor de push lento não pode atrasar o 200 para a Evolution: o
    // recebimento da mensagem é a única parte deste caminho que não se recupera.
    const fonte = fs.readFileSync(path.join(RAIZ, 'whatsapp-webhook.js'), 'utf8');
    const i = fonte.indexOf('avisarInscritos');
    assert(!/await\s*$/.test(fonte.slice(i - 40, i).trim()),
      'o webhook dá await no push');
  });

  await t('E3. a tabela de inscricoes nasce no db-schema, nao numa rota', () => {
    // Migration em *-routes.js é no-op para tenant que já existe: a tabela
    // apareceria só em tenant novo, e o recurso ficaria quebrado calado nos
    // outros onze.
    const schema = fs.readFileSync(path.join(RAIZ, 'db-schema.js'), 'utf8');
    assert(/CREATE TABLE IF NOT EXISTS push_inscricoes/.test(schema),
      'push_inscricoes não está no db-schema.js');
  });

  srvPush.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
