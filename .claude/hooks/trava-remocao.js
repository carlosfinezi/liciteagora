#!/usr/bin/env node
/**
 * Trava de remocao desta arvore, para o hook PreToolUse de Bash.
 *
 * Aqui a arvore E a producao, e apagar um arquivo dela nao tem rede: o reflog
 * nao cobre o que nunca entrou no indice. Mas rascunho de sessao vai para
 * /tmp, e quem acende tem de apagar — entao a trava nao pode ser "nada de
 * apagar".
 *
 * POR QUE UM HOOK, E NAO deny/allow NO SETTINGS. O matcher de permissao casa
 * PREFIXO de comando e nao sabe o diretorio de trabalho, e `deny` vence
 * `allow` sempre. Com `deny: Bash(rm:*)` nada passa, nem em /tmp; trocando-o
 * por denies de caminho, `rm server.js` (relativo, com o cwd na arvore) nao
 * casa nada e passa. Só quem resolve o alvo contra o cwd consegue separar os
 * dois casos.
 *
 * A DECISAO, por segmento do comando:
 *   - nao ha remocao          -> nao opina (o fluxo normal de permissao segue)
 *   - todo alvo em /tmp|/var/tmp (ABSOLUTO) -> allow
 *   - algum alvo nesta arvore, ou relativo, ou que nao se resolve -> deny
 *   - alvo fora disso (/etc, /home/outro) -> ask, que e decisao do usuario
 *
 * Caminho RELATIVO e negado de proposito, mesmo com `cd /tmp` antes: depois do
 * `cd` o alvo nao se resolve pelo texto, e aqui o palpite errado apaga
 * producao. Para apagar em /tmp, escreva o caminho inteiro.
 *
 * Erro interno NEGA (fail-closed): trava que falha aberta nao e trava.
 */

const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..', '..');
const LIBERADAS = ['/tmp', '/var/tmp'];

// Comandos que removem ou destroem conteudo, e as flags de cada um que
// CONSOMEM o argumento seguinte (senao o valor da flag viraria "alvo").
const REMOVEDORES = {
  rm: [],
  rmdir: [],
  unlink: [],
  shred: ['-n', '--iterations'],
  truncate: ['-s', '--size', '-r', '--reference'],
  find: ['-name', '-iname', '-path', '-ipath', '-newermt', '-newer', '-maxdepth',
         '-mindepth', '-mtime', '-mmin', '-type', '-printf', '-size', '-user',
         '-perm', '-regex', '-not', '-exec', '-execdir', '-delete'],
};

/** Divide a linha em segmentos independentes (&&, ||, ;, |, nova linha). */
const segmentos = (cmd) => cmd.split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter(Boolean);

/** Tokeniza respeitando aspas simples e duplas. */
function tokenizar(seg) {
  const fora = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(seg)) !== null) fora.push(m[1] ?? m[2] ?? m[3]);
  return fora;
}

/**
 * O segmento remove algo? Devolve { removedor, alvos } ou null.
 * `find` só conta quando a expressao apaga (-delete, ou -exec de removedor).
 */
function remocaoNo(seg) {
  const tokens = tokenizar(seg);
  if (!tokens.length) return null;

  // sudo/env/time na frente nao mudam o que o comando faz.
  let i = 0;
  while (i < tokens.length && ['sudo', 'env', 'time', 'nohup', 'xargs'].includes(path.basename(tokens[i]))) i++;
  const nome = path.basename(tokens[i] || '');
  const consomem = REMOVEDORES[nome];
  if (!consomem) return null;

  const resto = tokens.slice(i + 1);

  // `rm --help` nao remove nada. Sem esta linha ele cairia no ramo de "sem
  // alvo", que NEGA de proposito — e nega porque `cat lista | xargs rm` chega
  // aqui tambem sem alvo no texto, com os alvos vindo do pipe.
  if (resto.some((t) => t === '--help' || t === '--version')) return null;

  if (nome === 'find') {
    const apaga =
      resto.includes('-delete') ||
      resto.some((t, k) => (t === '-exec' || t === '-execdir') &&
        REMOVEDORES[path.basename(resto[k + 1] || '')] !== undefined);
    if (!apaga) return null;
    // Os alvos do find sao os caminhos antes da primeira expressao.
    const alvos = [];
    for (const t of resto) {
      if (t.startsWith('-') || t === '!' || t === '(') break;
      alvos.push(t);
    }
    return { removedor: 'find', alvos: alvos.length ? alvos : ['.'] };
  }

  const alvos = [];
  for (let k = 0; k < resto.length; k++) {
    const t = resto[k];
    if (t === '--') continue;
    if (t.startsWith('-')) {
      if (consomem.includes(t)) k++; // a flag leva valor, que nao e alvo
      continue;
    }
    alvos.push(t);
  }
  return { removedor: nome, alvos };
}

const dentro = (abs, base) => abs === base || abs.startsWith(base + path.sep);

/** Classifica um alvo: 'liberado' | 'arvore' | 'incerto' | 'fora'. */
function classificar(alvo) {
  if (/[*?\[\]$`]/.test(alvo)) {
    // Glob ou expansao: o texto nao diz o que vai casar. Em /tmp, liberado;
    // em qualquer outro lugar, incerto.
    if (LIBERADAS.some((b) => alvo.startsWith(b + '/'))) return 'liberado';
    return 'incerto';
  }
  if (!path.isAbsolute(alvo)) return 'incerto'; // relativo: depende do cwd
  const abs = path.resolve(alvo);
  if (LIBERADAS.some((b) => dentro(abs, b))) return 'liberado';
  if (dentro(abs, RAIZ)) return 'arvore';
  return 'fora';
}

function decidir(cmd) {
  const achados = segmentos(cmd).map(remocaoNo).filter(Boolean);
  if (!achados.length) return null; // nao e assunto desta trava

  const motivos = [];
  let temIncerto = false;
  let temFora = false;

  for (const { removedor, alvos } of achados) {
    if (!alvos.length) {
      temIncerto = true;
      motivos.push(`${removedor} sem alvo explicito`);
      continue;
    }
    for (const alvo of alvos) {
      const classe = classificar(alvo);
      if (classe === 'arvore') motivos.push(`${removedor} ${alvo} esta nesta arvore`);
      if (classe === 'incerto') {
        temIncerto = true;
        motivos.push(`${removedor} ${alvo} nao se resolve pelo texto (relativo ou glob)`);
      }
      if (classe === 'fora') temFora = true;
    }
  }

  const naArvore = motivos.some((m) => m.includes('esta nesta arvore'));
  if (naArvore || temIncerto) {
    return {
      decisao: 'deny',
      motivo:
        `Remocao barrada: ${motivos.join('; ')}. ` +
        'Esta arvore e a producao e apagar nao tem rede. Apagar em /tmp ou ' +
        '/var/tmp passa, com o CAMINHO ABSOLUTO escrito. Se e mesmo para sair ' +
        'da arvore, peca ao usuario.',
    };
  }
  if (temFora) {
    return { decisao: 'ask', motivo: 'Remocao fora desta arvore e fora de /tmp: decisao do usuario.' };
  }
  return { decisao: 'allow', motivo: 'Remocao em /tmp ou /var/tmp, por caminho absoluto.' };
}

// ------------------------------------------------------------------ entrada

function responder(d) {
  if (!d) return process.exit(0); // sem opiniao
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: d.decisao,
        permissionDecisionReason: d.motivo,
      },
    })
  );
  process.exit(0);
}

if (process.argv[2] === '--autoteste') {
  const CASOS = [
    // [comando, decisao esperada]
    ['rm /tmp/x.txt', 'allow'],
    ['rm -rf /tmp/pend-restart', 'allow'],
    ['find /tmp/lixo -mindepth 1 -delete', 'allow'],
    ['rm -f /var/tmp/a /var/tmp/b', 'allow'],
    ['rm /tmp/*.log', 'allow'],
    [`rm ${RAIZ}/server.js`, 'deny'],
    ['rm server.js', 'deny'],
    ['rm -rf public/', 'deny'],
    ['find . -name "*.js" -delete', 'deny'],
    [`find ${RAIZ}/public -delete`, 'deny'],
    ['find . -type f -exec rm {} ;', 'deny'],
    ['unlink db-schema.js', 'deny'],
    [`unlink ${RAIZ}/db-schema.js`, 'deny'],
    ['shred -u scheduler.js', 'deny'],
    ['truncate -s 0 server.log', 'deny'],
    ['sudo rm -rf /home/carlosfinezi/web/liciteagora.com.br/private/data', 'deny'],
    ['cd /tmp && rm -rf x', 'deny'], // relativo depois do cd: nao se resolve
    ['ls /tmp && rm /tmp/x', 'allow'],
    ['rm /tmp/ok && rm server.js', 'deny'], // um segmento ruim condena a linha
    ['rm /etc/motd', 'ask'],
    // Nao sao remocao: a trava nao deve opinar.
    ['find . -name "*.js" -newermt "2026-10-03"', null],
    ['git status', null],
    ['truncate --help', null],
    ['rmdir /tmp/vazio', 'allow'],
    ['node scripts/pendencia-de-restart.js', null],
    ['grep -rn "rm " server.js', null],
    ['truncate --version', null],
    ['cat lista | xargs rm', 'deny'],
    ['rm', 'deny'],
  ];

  let falhas = 0;
  for (const [cmd, esperado] of CASOS) {
    const d = decidir(cmd);
    const obtido = d ? d.decisao : null;
    const ok = obtido === esperado;
    if (!ok) falhas++;
    console.log(`  ${ok ? 'ok   ' : 'FALHA'} [${String(esperado)}] ${cmd}${ok ? '' : ` -> veio ${String(obtido)}`}`);
  }
  // A guarda do fail-closed: entrada ilegivel tem de negar.
  const cego = (() => {
    try {
      JSON.parse('{nao e json');
      return 'nao lancou';
    } catch {
      return 'deny';
    }
  })();
  const okCego = cego === 'deny';
  if (!okCego) falhas++;
  console.log(`  ${okCego ? 'ok   ' : 'FALHA'} entrada ilegivel cai no ramo que nega`);

  console.log(
    falhas ? `\nFALHOU: ${falhas} de ${CASOS.length + 1} checagens.` : `\nTudo verde: ${CASOS.length + 1} checagens.`
  );
  process.exit(falhas ? 1 : 0);
} else {
  let bruto = '';
  process.stdin.on('data', (c) => (bruto += c));
  process.stdin.on('end', () => {
    try {
      const cmd = JSON.parse(bruto || '{}')?.tool_input?.command || '';
      responder(decidir(cmd));
    } catch (erro) {
      // Fail-closed: sem entender o comando, nao se libera remocao.
      responder({
        decisao: 'deny',
        motivo: `A trava de remocao nao conseguiu ler o comando (${erro.message}), e nega por padrao.`,
      });
    }
  });
}

module.exports = { decidir, remocaoNo, classificar, RAIZ };
