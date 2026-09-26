/**
 * guarda-dados.js — nenhuma suíte do verify escreve em data/.
 *
 * O verify.js carrega este arquivo em cada suíte por NODE_OPTIONS
 * (`--require`), que passa também aos processos node que a suíte abrir. Ele
 * recusa, com erro que nomeia o arquivo:
 *   - abrir banco better-sqlite3 dentro de data/ sem `readonly: true`;
 *   - escrever, renomear, copiar para ou apagar arquivo dentro de data/.
 * Ler continua livre: schema-de-tenant.js e banco-de-teste.js leem a produção
 * em modo somente leitura, e é isso que eles devem fazer.
 *
 * Por que aqui, e não comparando os bancos antes e depois da rodada: a
 * produção está viva. O -wal do 1bit muda a cada minuto por uso real e pelos
 * schedulers, e uma comparação reprovaria toda rodada sem dizer quem escreveu.
 * Aqui a recusa acontece na hora, dentro da suíte culpada.
 *
 * O que ela NÃO vê: escrita feita por processo que não é node (o binário
 * `sqlite3`, por exemplo). As suítes usam o sqlite3 só com `?mode=ro`.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const RAIZ = path.join(__dirname, '..');
const PRODUCAO = '/home/carlosfinezi/web/liciteagora.com.br/private';

function real(p) {
  try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); }
}
const PROTEGIDOS = [...new Set([path.join(RAIZ, 'data'), path.join(PRODUCAO, 'data')].map(real))];

function protegido(alvo) {
  if (typeof alvo !== 'string' && !(alvo instanceof URL) && !Buffer.isBuffer(alvo)) return false;
  let p = alvo instanceof URL ? alvo.pathname : String(alvo);
  if (!p || p === ':memory:' || p.startsWith('file::memory:')) return false;
  if (p.startsWith('file:')) p = p.slice(5).split('?')[0];
  // O diretório pode ainda não existir (arquivo novo): resolve pelo pai.
  const abs = path.resolve(p);
  let r;
  try { r = fs.realpathSync(abs); } catch (_) { r = path.join(real(path.dirname(abs)), path.basename(abs)); }
  return PROTEGIDOS.some((d) => r === d || r.startsWith(d + path.sep));
}

function recusar(o_que, alvo) {
  const e = new Error(`[guarda-dados] FALHA suíte tentou ${o_que} em data/: ${alvo}`);
  // Vai também para o stderr: um `try/catch` da suíte não pode engolir isto calado.
  process.stderr.write(e.message + '\n');
  process.exitCode = 1;
  throw e;
}

// ── better-sqlite3 ────────────────────────────────────────────────────────
// Qualquer caminho que resolva para o mesmo arquivo do pacote (relativo,
// `BASE + '/node_modules/…'`, ou o link do node_modules num worktree) cai no
// mesmo módulo; o embrulho é aplicado no carregamento, uma vez por arquivo.
const embrulhados = new WeakSet();
const carregarOriginal = Module._load;
Module._load = function (pedido, pai, eMain) {
  const exp = carregarOriginal.apply(this, arguments);
  if (typeof exp === 'function' && /better-sqlite3/.test(String(pedido)) && !embrulhados.has(exp)) {
    const Original = exp;
    const Guardado = function Database(arquivo, opcoes) {
      if (protegido(arquivo) && !(opcoes && opcoes.readonly)) recusar('abrir banco para escrita', arquivo);
      return new Original(arquivo, opcoes);
    };
    Guardado.prototype = Original.prototype;
    Object.setPrototypeOf(Guardado, Original);
    embrulhados.add(Guardado);
    embrulhados.add(Original);
    // Troca no cache para que os próximos `require` recebam a versão guardada.
    for (const k of Object.keys(require.cache)) {
      if (require.cache[k] && require.cache[k].exports === Original) require.cache[k].exports = Guardado;
    }
    return Guardado;
  }
  return exp;
};

// ── fs ────────────────────────────────────────────────────────────────────
const ESCRITA = ['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile',
  'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'mkdirSync', 'mkdir',
  'truncateSync', 'truncate'];
for (const nome of ESCRITA) {
  const orig = fs[nome];
  if (typeof orig !== 'function') continue;
  fs[nome] = function (alvo) {
    if (protegido(alvo)) recusar(nome, alvo);
    return orig.apply(this, arguments);
  };
}
for (const nome of ['renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp']) {
  const orig = fs[nome];
  if (typeof orig !== 'function') continue;
  fs[nome] = function (de, para) {
    if (protegido(para)) recusar(nome, para);
    if (/^rename/.test(nome) && protegido(de)) recusar(nome, de);
    return orig.apply(this, arguments);
  };
}
const openOrig = fs.openSync;
fs.openSync = function (alvo, flags) {
  if (protegido(alvo) && flags !== undefined && !/^r$|^rs$|^sr$/.test(String(flags)) && flags !== fs.constants.O_RDONLY) {
    recusar(`abrir para escrita (${flags})`, alvo);
  }
  return openOrig.apply(this, arguments);
};
const streamOrig = fs.createWriteStream;
fs.createWriteStream = function (alvo) {
  if (protegido(alvo)) recusar('createWriteStream', alvo);
  return streamOrig.apply(this, arguments);
};
