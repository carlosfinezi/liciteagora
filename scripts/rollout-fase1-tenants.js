/**
 * rollout-fase1-tenants.js — aplica a migration da Fase 1 nos tenants restantes,
 * um por vez, provando antes e depois que nenhum dado comercial mudou.
 *
 * Validado primeiro no tenant `labfiscal` (relatório 17). Este script existe
 * porque repetir aquela operação 17 vezes na mão é onde o erro entra.
 *
 *   node scripts/rollout-fase1-tenants.js                    dry-run, ordem padrão
 *   node scripts/rollout-fase1-tenants.js --aplicar          rollout real
 *   node scripts/rollout-fase1-tenants.js --tenants=a,b      só estes
 *   node scripts/rollout-fase1-tenants.js --arquivo=/tmp/x.db --aplicar
 *
 * ── Três decisões de desenho que valem explicação ───────────────────────────
 *
 * 1. **O ALTER não está aqui.** Quem escreve é `migrate-fase1-pedido.js`,
 *    chamado como subprocesso — exatamente o binário que já rodou no labfiscal.
 *    Duplicar a DDL criaria duas fontes de verdade que divergem no dia em que
 *    alguém editar uma só.
 *
 * 2. **A lista de colunas esperadas ESTÁ aqui, e é independente de propósito.**
 *    Ela não executa nada: serve para conferir o resultado. Se alguém mudar a
 *    migration, esta verificação reprova — que é o comportamento desejado, e o
 *    motivo de a duplicação ser boa neste caso e ruim no anterior.
 *
 * 3. **O hash usa as colunas de ANTES, capturadas em tempo de execução.** Um
 *    `SELECT *` mudaria de resultado só porque a migration acrescenta colunas, e
 *    a comparação estaria medindo a própria mudança de schema em vez do dado.
 *    Esse erro já aconteceu uma vez (relatório 17 §5) e devolveu "tudo igual".
 *
 * Primeiro erro em qualquer etapa = STOP TOTAL. Não segue para o próximo tenant:
 * num rollout sequencial, o segundo tenant só faz sentido se o primeiro provou
 * que o procedimento está correto.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..', 'data', 'tenants');
const MIGRATE = path.join(__dirname, 'migrate-fase1-pedido.js');

/**
 * Ordem de risco crescente, não alfabética. Internos antes de clientes; vazios
 * antes de movimentados; o maior volume por último, quando o procedimento já
 * tiver 16 confirmações.
 */
const ORDEM = [
  // internos de teste, descartáveis
  'sandbox2', 'sandbox3', 'sandbox4', 'sandbox6', 'sandbox5',
  // clientes sem nenhum pedido (SUSPENDED primeiro, ACTIVE depois)
  'crsolucoes', 'hseletricista', 'levezi', 'lojasemijoias', 'opendesk',
  'pccontabilidade', 'reimac',
  // clientes com movimento baixo
  'raeldouglas', 'jaagricola', 'josecarloscostafilho',
  // maior volume comercial, por último
  'produtosbomgosto', '1bit',
];

/** O schema final aprovado. Conferência, não execução — ver nota 2 no topo. */
const ESPERADAS = {
  pedidos: ['descontoTipo', 'descontoValor', 'descontoAplicado', 'descontoMotivo', 'tipoAtendimento'],
  pessoas: ['semDocumento'],
};
const TOTAL_ESPERADO = 6;

/** Tabelas cujo conteúdo é dado comercial e não pode mudar. */
const TABELAS = ['pedidos', 'pedido_itens', 'pessoas', 'produtos', 'faturas',
  'fatura_itens', 'contas_a_receber', 'movimentacoes_estoque'];

/** Somas monetárias, conferidas além do hash: erram de forma mais legível. */
const SOMAS = {
  pedidos: ['valorTotal', 'valorPago', 'valorFrete'],
  pedido_itens: ['quantidade', 'valorTotal'],
  faturas: ['valorTotal'],
  fatura_itens: ['quantidade'],
  contas_a_receber: ['valor', 'valorPago'],
  movimentacoes_estoque: ['quantidade'],
};

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const opt = (nome) => {
  const a = args.find((x) => x.startsWith(`--${nome}=`));
  return a ? a.slice(nome.length + 3) : null;
};
const arquivoAvulso = opt('arquivo');
const listaManual = opt('tenants');
const DIR_BACKUP = opt('backups') || '/home/carlosfinezi/backups/fase1-rollout-20260911';

// ───────────────────────── primitivas de verificação ─────────────────────────

const existeTabela = (db, t) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

const colunas = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

const db_count = (db, t) => (existeTabela(db, t) ? db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n : null);

function integridade(db) {
  const i = db.prepare('PRAGMA integrity_check').get();
  const valor = i[Object.keys(i)[0]];
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  return { integrity: valor, fk: fk.length };
}

/**
 * Impressão digital do conteúdo, restrita às colunas informadas.
 *
 * `ORDER BY rowid` e não `ORDER BY id`: nem toda tabela tem `id`, e o rowid é
 * estável para linhas que ninguém tocou — que é justamente a hipótese sob teste.
 */
function hashTabela(db, tabela, cols) {
  if (!existeTabela(db, tabela) || !cols.length) return null;
  const lista = cols.map((c) => `"${c}"`).join(',');
  const linhas = db.prepare(`SELECT ${lista} FROM ${tabela} ORDER BY rowid`).raw().all();
  const h = crypto.createHash('sha256');
  for (const linha of linhas) {
    // O \x00 distingue NULL de string vazia; sem ele os dois colidiriam.
    h.update(linha.map((v) => (v === null ? '\x00' : String(v))).join('\x1f'));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 32);
}

/**
 * Retrato completo do banco. `colsFixas` permite repetir o retrato DEPOIS da
 * migration usando exatamente as colunas de antes.
 */
function retrato(db, colsFixas) {
  const r = { counts: {}, somas: {}, hashes: {}, colunas: {} };
  for (const t of TABELAS) {
    if (!existeTabela(db, t)) continue;
    r.counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const cols = colsFixas ? colsFixas[t] : colunas(db, t);
    if (!cols) continue;
    r.colunas[t] = cols;
    r.hashes[t] = hashTabela(db, t, cols);
    for (const c of (SOMAS[t] || [])) {
      if (cols.includes(c)) {
        const v = db.prepare(`SELECT SUM("${c}") s FROM ${t}`).get().s;
        r.somas[`${t}.${c}`] = v === null ? null : Number(v.toFixed(4));
      }
    }
  }
  return r;
}

function compararRetratos(antes, depois) {
  const divergencias = [];
  const cmp = (grupo) => {
    for (const k of Object.keys(antes[grupo])) {
      const a = antes[grupo][k]; const b = depois[grupo][k];
      if (String(a) !== String(b)) divergencias.push(`${grupo}.${k}: ${a} -> ${b}`);
    }
    for (const k of Object.keys(depois[grupo])) {
      if (!(k in antes[grupo])) divergencias.push(`${grupo}.${k}: surgiu do nada`);
    }
  };
  cmp('counts'); cmp('somas'); cmp('hashes');
  return divergencias;
}

/** As colunas novas não podem ter sido preenchidas em linha nenhuma. */
function conferirColunasNovasVazias(db) {
  const problemas = [];
  if (existeTabela(db, 'pedidos')) {
    const q = db.prepare(`SELECT
        SUM(tipoAtendimento IS NOT NULL) ta,
        SUM(descontoTipo IS NOT NULL) dt,
        SUM(descontoMotivo IS NOT NULL) dm,
        SUM(COALESCE(descontoAplicado,0) <> 0) da,
        SUM(COALESCE(descontoValor,0) <> 0) dv
      FROM pedidos`).get();
    for (const [k, rotulo] of [['ta', 'tipoAtendimento preenchido'], ['dt', 'descontoTipo preenchido'],
      ['dm', 'descontoMotivo preenchido'], ['da', 'descontoAplicado <> 0'], ['dv', 'descontoValor <> 0']]) {
      if (q[k]) problemas.push(`pedidos: ${q[k]} linha(s) com ${rotulo}`);
    }
  }
  if (existeTabela(db, 'pessoas')) {
    const p = db.prepare('SELECT SUM(semDocumento = 1) marcadas, SUM(semDocumento IS NULL) nulas FROM pessoas').get();
    if (p.marcadas) problemas.push(`pessoas: ${p.marcadas} cadastro(s) marcados semDocumento=1`);
    if (p.nulas) problemas.push(`pessoas: ${p.nulas} cadastro(s) com semDocumento NULL (default não aplicou)`);
  }
  return problemas;
}

// ───────────────────────────── um tenant ─────────────────────────────────────

function processar(slug, arquivo) {
  const linhas = [];
  const diga = (marca, txt) => { const l = `  [${marca}] ${txt}`; console.log(l); linhas.push(l); };
  const falhar = (txt) => { throw new Error(txt); };

  if (!fs.existsSync(arquivo)) falhar(`banco não encontrado: ${arquivo}`);
  diga('OK', `banco ${arquivo}`);

  // ---- ANTES ----
  let antes, colsAntes, faltando;
  {
    const db = new Database(arquivo, { readonly: true });
    try {
      for (const t of Object.keys(ESPERADAS)) {
        if (!existeTabela(db, t)) falhar(`tabela ${t} não existe neste banco`);
      }
      const presentes = [];
      for (const [t, cols] of Object.entries(ESPERADAS)) {
        const atuais = colunas(db, t);
        for (const c of cols) if (atuais.includes(c)) presentes.push(`${t}.${c}`);
      }
      faltando = TOTAL_ESPERADO - presentes.length;
      if (presentes.length === TOTAL_ESPERADO) falhar('JÁ MIGRADO — as 6 colunas existem. Rollout não repete migration.');
      if (presentes.length > 0) falhar(`migração PARCIAL: ${presentes.join(', ')} já existem. Requer análise manual.`);
      diga('OK', `as ${TOTAL_ESPERADO} colunas da Fase 1 estão ausentes`);

      const i = integridade(db);
      if (i.integrity !== 'ok') falhar(`integrity_check antes = ${i.integrity}`);
      if (i.fk !== 0) falhar(`foreign_key_check antes = ${i.fk} violação(ões)`);
      diga('OK', 'integrity antes=ok  FK antes=0');

      antes = retrato(db);
      colsAntes = antes.colunas;
      diga('OK', `snapshot: ${Object.keys(antes.hashes).length} tabela(s), `
        + `${antes.counts.pedidos || 0} pedido(s), ${antes.counts.pedido_itens || 0} item(ns), `
        + `${antes.counts.pessoas || 0} pessoa(s)`);
    } finally { db.close(); }
  }

  if (!aplicar) { diga('--', 'DRY-RUN: backup e migration não executados'); return { slug, linhas, dry: true }; }

  // ---- BACKUP ----
  const destDir = path.join(DIR_BACKUP, slug);
  fs.mkdirSync(destDir, { recursive: true });
  const destDb = path.join(destDir, 'pncp.db');
  // `sqlite3 .backup` e nunca cp: o -wal de um banco vivo fica para trás.
  execFileSync('sqlite3', [arquivo, `.backup '${destDb}'`], { stdio: 'pipe' });
  {
    const b = new Database(destDb, { readonly: true });
    try {
      const i = integridade(b);
      if (i.integrity !== 'ok') falhar(`backup com integrity_check = ${i.integrity}`);
      // Backup que nunca foi lido é esperança, não garantia.
      for (const t of Object.keys(antes.counts)) {
        const n = db_count(b, t);
        if (n !== antes.counts[t]) falhar(`backup divergente em ${t}: ${n} != ${antes.counts[t]}`);
      }
      const mb = (fs.statSync(destDb).size / 1048576).toFixed(1);
      diga('OK', `backup ${mb} MB verificado (integrity=ok, contagens conferem)`);
    } finally { b.close(); }
  }
  fs.writeFileSync(path.join(destDir, 'metadata-antes.json'), JSON.stringify(antes, null, 2));

  // ---- MIGRATION ----
  const saida = execFileSync('node', [MIGRATE, slug === '(avulso)' ? '--arquivo' : slug,
    ...(slug === '(avulso)' ? [arquivo] : []), '--aplicar'], { encoding: 'utf8' });
  const criadas = (saida.match(/(\d+) coluna\(s\) criada\(s\)/) || [])[1];
  if (Number(criadas) !== faltando) falhar(`migration criou ${criadas} coluna(s), esperado ${faltando}\n${saida}`);
  diga('OK', `migration ${criadas}/${TOTAL_ESPERADO}`);

  // ---- DEPOIS ----
  {
    const db = new Database(arquivo, { readonly: true });
    try {
      const i = integridade(db);
      if (i.integrity !== 'ok') falhar(`integrity_check depois = ${i.integrity}`);
      if (i.fk !== 0) falhar(`foreign_key_check depois = ${i.fk} violação(ões)`);
      diga('OK', 'integrity depois=ok  FK depois=0');

      let achadas = 0;
      for (const [t, cols] of Object.entries(ESPERADAS)) {
        const atuais = colunas(db, t);
        for (const c of cols) {
          if (!atuais.includes(c)) falhar(`coluna ${t}.${c} não existe depois da migration`);
          achadas++;
        }
        for (const c of colsAntes[t]) {
          if (!atuais.includes(c)) falhar(`coluna ANTIGA ${t}.${c} DESAPARECEU`);
        }
      }
      if (achadas !== TOTAL_ESPERADO) falhar(`esperava ${TOTAL_ESPERADO} colunas, confirmou ${achadas}`);
      diga('OK', `schema: ${achadas}/${TOTAL_ESPERADO} colunas novas, 0 coluna antiga removida`);

      const depois = retrato(db, colsAntes);
      const div = compararRetratos(antes, depois);
      if (div.length) falhar(`DADO ALTERADO:\n    - ${div.join('\n    - ')}`);
      diga('OK', `hashes: ${Object.keys(depois.hashes).length}/${Object.keys(antes.hashes).length} iguais`);
      diga('OK', `counts e somas idênticos (${Object.keys(antes.somas).length} soma(s) conferida(s))`);

      const p = conferirColunasNovasVazias(db);
      if (p.length) falhar(`preenchimento automático detectado:\n    - ${p.join('\n    - ')}`);
      diga('OK', 'nenhum desconto, tipoAtendimento ou semDocumento preenchido automaticamente');

      fs.writeFileSync(path.join(destDir, 'metadata-depois.json'), JSON.stringify(depois, null, 2));
      fs.writeFileSync(path.join(destDir, 'hashes.txt'),
        Object.keys(antes.hashes).map((t) => `${t.padEnd(24)} ${antes.hashes[t]}  ->  ${depois.hashes[t]}  ${antes.hashes[t] === depois.hashes[t] ? 'IGUAL' : 'MUDOU'}`).join('\n') + '\n');
      fs.writeFileSync(path.join(destDir, 'integridade.txt'),
        `integrity antes=ok depois=ok\nforeign_key_check antes=0 depois=0\n`);
    } finally { db.close(); }
  }
  return { slug, linhas, criadas: Number(criadas) };
}

// ───────────────────────────── laço principal ────────────────────────────────

// As primitivas são exportadas para que `test-rollout-fase1.js` possa provar que
// elas REPROVAM quando devem. Um detector de divergência que nunca reprovou não
// é prova de nada — foi assim que um hash vazio já devolveu "tudo igual" uma vez.
module.exports = { hashTabela, retrato, compararRetratos, conferirColunasNovasVazias, ESPERADAS, ORDEM };

if (require.main !== module) return;

const alvos = arquivoAvulso
  ? [{ slug: '(avulso)', arquivo: arquivoAvulso }]
  : (listaManual ? listaManual.split(',') : ORDEM).map((s) => ({ slug: s, arquivo: path.join(RAIZ, s, 'pncp.db') }));

console.log(aplicar ? '### ROLLOUT FASE 1 — ESCRITA REAL' : '### DRY-RUN — nada será escrito');
console.log(`### ${alvos.length} tenant(s), um por vez, abort no primeiro erro\n`);

const feitos = [];
for (const [n, alvo] of alvos.entries()) {
  const t0 = new Date();
  console.log(`[${n + 1}/${alvos.length}] ${alvo.slug}  início ${t0.toTimeString().slice(0, 8)}`);
  try {
    feitos.push(processar(alvo.slug, alvo.arquivo));
    console.log(`  [OK] ${alvo.slug} concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  } catch (e) {
    console.error(`  [FALHA] ${alvo.slug}: ${e.message}`);
    console.error(`\n### STOP TOTAL — ${feitos.length} tenant(s) concluído(s) antes da falha.`);
    console.error(`### Os seguintes NÃO foram tocados: ${alvos.slice(n + 1).map((a) => a.slug).join(', ') || '(nenhum)'}`);
    process.exit(1);
  }
}

console.log(`### ${feitos.length}/${alvos.length} tenant(s) concluído(s) sem divergência.`);
if (!aplicar) console.log('### Nada foi escrito. Use --aplicar para valer.');
else console.log(`### Backups em ${DIR_BACKUP}/<tenant>/`);
