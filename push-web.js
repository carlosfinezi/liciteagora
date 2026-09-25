/**
 * push-web.js — notificação do navegador com o ERP fechado (Web Push).
 *
 * ── Duas decisões que explicam o resto do arquivo ──────────────────────────
 *
 * **1. Sem biblioteca.** `web-push` não está instalado e `npm install` é vedado
 * nesta árvore. O que a `web-push` faz e aqui não precisa ser feito é a
 * criptografia do CONTEÚDO (RFC 8291) — e não precisa por causa da decisão 2.
 * O que sobra é o VAPID (RFC 8292): um JWT assinado em ES256, que o `crypto` do
 * Node faz nativamente.
 *
 * **2. O push vai VAZIO.** Ele carrega um sinal, não a mensagem. Quem monta o
 * texto é o service worker, buscando `/api/push/pendentes` com a sessão do
 * próprio usuário.
 *
 * Isso não é contorno técnico, é o desenho certo para este caso: o push passa
 * pelo servidor da Google ou da Mozilla, e o conteúdo é a conversa de um cliente
 * com a empresa. Mandar "João Silva: preciso da betoneira amanhã" por um
 * intermediário seria entregar a terceiros justamente o que o sistema existe
 * para guardar. Vazio, o intermediário só sabe que ALGO chegou.
 *
 * O custo assumido: com a aba fechada e sem rede no momento do push, o service
 * worker não consegue buscar o conteúdo e mostra um aviso genérico. É o
 * comportamento correto — melhor um aviso sem detalhe do que detalhe vazando.
 *
 * ── O par de chaves mora no BANCO DO TENANT, não em arquivo ───────────────
 *
 * A primeira versão guardava em `data/vapid.json`, com 0600. Durou uma tarde: o
 * arquivo nasceu `root:root` (quem chamou primeiro foi um processo root) e o
 * servidor web, que roda como `carlosfinezi`, não conseguia LER a própria
 * chave — a rota devolvia erro e o recurso ficava morto sem nada no log.
 *
 * A causa não é permissão errada, é o lugar: dois processos com usuários
 * diferentes escrevendo o mesmo arquivo. No banco do tenant isso não acontece,
 * porque é por lá que toda configuração já passa.
 *
 * Uma chave por tenant também é mais correta do que uma global: a inscrição do
 * navegador é amarrada à ORIGEM, e cada tenant tem o seu subdomínio.
 */
const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Gera um par novo. Separado para o teste poder chamá-lo sem banco. */
function gerarPar() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  // A pública vai no formato "raw uncompressed" (65 bytes, começando em 0x04),
  // que é o que o navegador espera em `applicationServerKey`. O DER do SPKI
  // traz 26 bytes de cabeçalho antes disso, e com eles o `subscribe` recusa.
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return {
    publica: b64url(spki.subarray(spki.length - 65)),
    privadaPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * Par VAPID do tenant, criado na primeira necessidade.
 *
 * Guardado em `config`, que é onde toda configuração do tenant já vive — e onde
 * os dois processos que tocam este sistema (o servidor web como `carlosfinezi`
 * e o scheduler como root) conseguem ler e escrever sem disputa de dono.
 */
function lerOuCriarChaves(db) {
  const ler = (chave) => db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave)?.valor || '';
  const publica = ler('push_vapid_publica');
  const privadaPem = ler('push_vapid_privada');
  if (publica && privadaPem) return { publica, privadaPem };

  const par = gerarPar();
  const up = db.prepare('INSERT OR REPLACE INTO config (chave, valor, dataAtualizacao) VALUES (?,?,CURRENT_TIMESTAMP)');
  up.run('push_vapid_publica', par.publica);
  up.run('push_vapid_privada', par.privadaPem);
  return par;
}

/**
 * JWT do VAPID.
 *
 * A assinatura do Node sai em DER (sequência ASN.1 com r e s de tamanho
 * variável) e o JOSE exige r||s com 32 bytes cada. Converter é obrigatório: o
 * push é recusado com 401 quando a assinatura vem em DER, e o erro não diz isso.
 */
function montarJwt(audiencia, privadaPem, contato) {
  const cabecalho = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const corpo = b64url(JSON.stringify({
    aud: audiencia,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,   // 12h: o teto do padrão é 24h
    sub: contato,
  }));
  const entrada = `${cabecalho}.${corpo}`;
  const der = crypto.createSign('SHA256').update(entrada).sign(crypto.createPrivateKey(privadaPem));
  return `${entrada}.${b64url(derParaJose(der))}`;
}

/** DER (0x30 len 0x02 rlen r 0x02 slen s) → r||s com 32 bytes cada. */
function derParaJose(der) {
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;              // comprimento longo
  const ler = () => {
    if (der[i++] !== 0x02) throw new Error('assinatura DER inesperada');
    const n = der[i++];
    let v = der.subarray(i, i + n);
    i += n;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);   // tira o zero de sinal
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);  // e completa à esquerda
  };
  return Buffer.concat([ler(), ler()]);
}

/**
 * Manda o sinal para UMA inscrição.
 *
 * Devolve `{ ok }` ou `{ ok: false, morta }`. `morta` é 404 ou 410: o navegador
 * diz que aquela inscrição não existe mais (app desinstalado, permissão
 * revogada, perfil apagado), e quem chamou deve removê-la do banco. Insistir
 * numa inscrição morta é gastar requisição para sempre.
 */
async function enviarSinal(inscricao, chaves, contato) {
  const u = new URL(inscricao.endpoint);
  const jwt = montarJwt(`${u.protocol}//${u.host}`, chaves.privadaPem, contato);

  const r = await fetch(inscricao.endpoint, {
    method: 'POST',
    headers: {
      TTL: '600',                       // 10 min: aviso de atendimento envelhece rápido
      Urgency: 'high',
      'Content-Length': '0',
      Authorization: `vapid t=${jwt}, k=${chaves.publica}`,
    },
  });
  if (r.ok) return { ok: true, status: r.status };
  return { ok: false, status: r.status, morta: r.status === 404 || r.status === 410 };
}

module.exports = { lerOuCriarChaves, gerarPar, montarJwt, derParaJose, enviarSinal, b64url };
