#!/usr/bin/env node
/**
 * O que entra no ar no proximo restart de cada servico.
 *
 *   node scripts/pendencia-de-restart.js                          # as duas units
 *   node scripts/pendencia-de-restart.js liciteagora.service      # so uma
 *   node scripts/pendencia-de-restart.js --autoteste              # prova as duas contas
 *
 * Aqui a arvore E a producao: editar um .js nao o poe no ar, o processo segue
 * com a versao que leu no boot. Este script responde, sem lista escrita a mao,
 * quais arquivos CARREGADOS por cada servico sao mais novos que o boot dele.
 *
 * COMO SABE O QUE O SERVICO CARREGA. Pelo entrypoint da unit INSTALADA (as
 * copias do repo divergem; ver CLAUDE.md), seguindo os `require` de caminho
 * relativo recursivamente. Nao executa nada: a resolucao e a do proprio Node
 * (require.resolve), que acha o arquivo sem carrega-lo. O que escapa e o
 * `require` montado em variavel, e a saida diz quantos deles ficaram de fora
 * em vez de calar.
 *
 * COMO SABE QUEM ALTEROU. Pelo que a maquina de fato registra: o dono do
 * arquivo, e o autor do ultimo commit quando o arquivo esta limpo no git.
 * Arquivo modificado e nao commitado nao tem autoria em lugar nenhum, e aqui
 * ele sai marcado assim em vez de receber um nome adivinhado.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const UNITS = ['consulta-licitacoes.service', 'liciteagora.service'];

// ---------------------------------------------------------------- systemd

function propriedade(unit, nome) {
  try {
    return execFileSync('systemctl', ['show', '--value', '-p', nome, unit], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

/** Epoch em segundos do boot da unit, ou null se ela nao esta de pe. */
function bootDaUnit(unit) {
  const carimbo = propriedade(unit, 'ExecMainStartTimestamp');
  if (!carimbo || carimbo === 'n/a') return null;
  const seg = Number(execFileSync('date', ['-d', carimbo, '+%s'], { encoding: 'utf8' }).trim());
  return Number.isFinite(seg) ? seg : null;
}

/** O .js que a unit instalada manda rodar (ultimo argumento de ExecStart). */
function entradaDaUnit(unit) {
  const linha = propriedade(unit, 'ExecStart');
  const argv = /argv\[\]=([^;]+)/.exec(linha);
  if (!argv) return null;
  const alvo = argv[1]
    .trim()
    .split(/\s+/)
    .filter((a) => a.endsWith('.js'))
    .pop();
  return alvo ? path.resolve(RAIZ, alvo) : null;
}

// ------------------------------------------------- o que o processo carrega

const RE_REQUIRE_RELATIVO = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
// Literal e `require('qualquer-coisa')`, pacote incluido: o que NAO casa com
// ele e require montado em variavel, e so esse escapa da varredura. Contar
// pacote como "nao seguido" inflava o aviso em dez vezes e o tornava inutil.
const RE_REQUIRE_LITERAL = /require\(\s*['"][^'"]+['"]\s*\)/g;
const RE_REQUIRE_QUALQUER = /require\(/g;
const RE_IMPORT_RELATIVO = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/**
 * Percorre os require e os import() de caminho relativo a partir da entrada,
 * sem sair de `raiz`.
 *
 * Devolve { arquivos: Set, tardios: Set, dinamicos: n }. TARDIO e o alcancado
 * so por `import()` (o DANFe em `vendor/`, por exemplo): ele nao e lido no
 * boot, e sim na primeira chamada, entao para ele o restart nao e a unica
 * forma de entrar no ar. Deixar esses de fora esconderia o caminho fiscal
 * inteiro; trata-los como os outros afirmaria pendencia que pode nao existir.
 */
function carregadosPor(entrada, raiz = RAIZ) {
  const arquivos = new Set();
  const tardios = new Set();
  const fila = [{ abs: entrada, tardio: false }];
  let dinamicos = 0;

  while (fila.length) {
    const { abs: atual, tardio } = fila.pop();
    if (arquivos.has(atual)) {
      if (!tardio) tardios.delete(atual); // tambem chega por require: nao e tardio
      continue;
    }
    arquivos.add(atual);
    if (tardio) tardios.add(atual);
    if (!atual.endsWith('.js')) continue;

    let fonte;
    try {
      fonte = fs.readFileSync(atual, 'utf8');
    } catch {
      continue;
    }

    dinamicos +=
      (fonte.match(RE_REQUIRE_QUALQUER) || []).length -
      (fonte.match(RE_REQUIRE_LITERAL) || []).length;

    const alvos = [
      ...[...fonte.matchAll(RE_REQUIRE_RELATIVO)].map((m) => [m[1], tardio]),
      ...[...fonte.matchAll(RE_IMPORT_RELATIVO)].map((m) => [m[1], true]),
    ];

    for (const [pedido, vemTardio] of alvos) {
      let destino;
      try {
        destino = require.resolve(pedido, { paths: [path.dirname(atual)] });
      } catch {
        continue; // modulo que nao existe mais; nao e carregado
      }
      if (destino.includes(`${path.sep}node_modules${path.sep}`)) continue;
      if (!destino.startsWith(raiz + path.sep)) continue;
      fila.push({ abs: destino, tardio: vemTardio });
    }
  }

  return { arquivos, tardios, dinamicos };
}

// -------------------------------------------------------------- quem alterou

function sujosNoGit() {
  try {
    const saida = execFileSync('git', ['-C', RAIZ, 'status', '--porcelain', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return new Set(
      saida
        .split('\0')
        .filter(Boolean)
        .map((linha) => path.resolve(RAIZ, linha.slice(3)))
    );
  } catch {
    return new Set();
  }
}

function autoria(absoluto, sujos) {
  const dono = (() => {
    try {
      return execFileSync('stat', ['-c', '%U', absoluto], { encoding: 'utf8' }).trim();
    } catch {
      return '?';
    }
  })();

  if (sujos.has(absoluto)) return `modificado sem commit, dono ${dono}`;

  try {
    const log = execFileSync(
      'git',
      ['-C', RAIZ, 'log', '-1', '--format=%an, %ad', '--date=format:%d/%m %H:%M', '--', absoluto],
      { encoding: 'utf8' }
    ).trim();
    return log ? `commitado por ${log}` : `fora do git, dono ${dono}`;
  } catch {
    return `dono ${dono}`;
  }
}

// ------------------------------------------------------------------ relatorio

/** Os carregados cujo mtime (em segundos) e maior que o boot. */
function pendentes(arquivos, bootSeg) {
  const fora = [];
  for (const absoluto of arquivos) {
    let st;
    try {
      st = fs.statSync(absoluto);
    } catch {
      continue;
    }
    const mtimeSeg = Math.floor(st.mtimeMs / 1000);
    if (mtimeSeg > bootSeg) fora.push({ absoluto, mtimeSeg });
  }
  return fora.sort((a, b) => b.mtimeSeg - a.mtimeSeg);
}

const hora = (seg) =>
  new Date(seg * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

function relatar(unit, sujos) {
  const boot = bootDaUnit(unit);
  const entrada = entradaDaUnit(unit);

  console.log(`\n=== ${unit}`);
  if (boot === null) {
    console.log('  a unidade nunca subiu: nao ha boot com que comparar.');
    return 0;
  }
  // O carimbo sobrevive a parada da unidade, entao sem esta linha o script
  // diria "no ar desde" sobre um servico que nao esta rodando.
  const estado = propriedade(unit, 'ActiveState');
  if (estado !== 'active') {
    console.log(`  ATENCAO: a unidade esta ${estado}; o carimbo abaixo e do ultimo start.`);
  }
  if (!entrada || !fs.existsSync(entrada)) {
    console.log(`  nao achei o entrypoint da unit instalada (ExecStart): ${entrada || '?'}`);
    return 0;
  }

  const { arquivos, tardios, dinamicos } = carregadosPor(entrada);
  const fora = pendentes(arquivos, boot);

  console.log(`  no ar desde ${hora(boot)}, por ${path.relative(RAIZ, entrada)}`);
  console.log(`  carrega ${arquivos.size} arquivos desta arvore`);

  if (!fora.length) {
    console.log('  NADA PENDENTE: todos sao mais antigos que o boot.');
  } else {
    console.log(`  ${fora.length} alterado(s) depois do boot, o mais novo primeiro:`);
    for (const { absoluto, mtimeSeg } of fora) {
      const marca = tardios.has(absoluto) ? ' [carga tardia]' : '';
      console.log(
        `    ${path.relative(RAIZ, absoluto).padEnd(42)} ${hora(mtimeSeg)}  ${autoria(absoluto, sujos)}${marca}`
      );
    }
    if (fora.some(({ absoluto }) => tardios.has(absoluto))) {
      console.log(
        '  [carga tardia] entra por import() na primeira chamada, nao no boot:'
      );
      console.log('  pode ja estar no ar se ninguem o chamou desde o restart.');
    }
  }
  if (dinamicos > 0) {
    console.log(`  (${dinamicos} require montado em variavel nao foi seguido)`);
  }
  return fora.length;
}

// ------------------------------------------------------------------ autoteste

function autoteste() {
  const base = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pendencia-'));
  const escrever = (nome, corpo, mtimeSeg) => {
    const p = path.join(base, nome);
    fs.writeFileSync(p, corpo);
    fs.utimesSync(p, mtimeSeg, mtimeSeg);
    return p;
  };

  const BOOT = 1_000_000;
  const entrada = escrever('a.js', "require('./b');\nrequire('./c');\n", BOOT - 10);
  escrever('b.js', "const x = './d';\nrequire('./d');\nrequire(x);\n", BOOT + 5);
  escrever('c.js', "await import('./tardio.js');\n", BOOT);
  escrever('d.js', 'module.exports = 2;\n', BOOT + 1);
  escrever('tardio.js', 'module.exports = 3;\n', BOOT + 7);
  escrever('e.js', "require('./a');\n", BOOT + 999); // ninguem o requer

  const { arquivos, tardios, dinamicos } = carregadosPor(entrada, base);
  const nomes = [...arquivos].map((p) => path.basename(p)).sort();
  const falhas = [];

  const confere = (certo, oque) => {
    if (!certo) falhas.push(oque);
    console.log(`  ${certo ? 'ok  ' : 'FALHA'} ${oque}`);
  };

  confere(
    nomes.join(',') === 'a.js,b.js,c.js,d.js,tardio.js',
    `segue require e import(), e so o que e alcancado (${nomes})`
  );
  confere(dinamicos === 1, `conta o require dinamico que nao seguiu (${dinamicos})`);
  confere(
    [...tardios].map((p) => path.basename(p)).join(',') === 'tardio.js',
    'marca como tardio so o que vem de import()'
  );

  // O corte e o boot: mais novo entra, igual NAO entra.
  const fora = pendentes(arquivos, BOOT).map((f) => path.basename(f.absoluto));
  confere(
    fora.join(',') === 'tardio.js,b.js,d.js',
    `pendente e quem tem mtime > boot, e o do mesmo segundo nao (${fora})`
  );
  confere(
    pendentes(arquivos, BOOT + 10).length === 0,
    'boot depois de todas as edicoes: nada pendente'
  );

  fs.rmSync(base, { recursive: true, force: true });
  if (falhas.length) {
    console.log(`\nFALHOU: ${falhas.length} problema(s).`);
    process.exit(1);
  }
  console.log('\nTudo verde: 5 checagens.');
}

// ---------------------------------------------------------------------- main

const args = process.argv.slice(2);
if (args.includes('--autoteste')) {
  autoteste();
} else {
  const alvos = args.length ? args : UNITS;
  const sujos = sujosNoGit();
  let total = 0;
  for (const unit of alvos) total += relatar(unit, sujos);
  console.log(
    total === 0
      ? '\nNada a reiniciar: o que esta no disco ja esta no ar.'
      : `\n${total} arquivo(s) esperando restart. Reiniciar poe tudo isso no ar de uma vez.`
  );
}
