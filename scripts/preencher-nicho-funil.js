#!/usr/bin/env node
'use strict';
/**
 * Preenche `pessoas.nichoFunilId` dos contatos que estão nas listas de
 * comunicação, pela cascata do `nicho-funil.js`: o card do CRM da própria
 * pessoa ou do telefone dela, depois o ramo igual ao `Ramo:` de um card, depois
 * o ramo como começo desse texto (a importação de 24/09 truncou o ramo na
 * vírgula) e, por fim, o nicho padrão ("Outros e fora do perfil").
 *
 * O segmento legado NÃO é tocado: os dois vocabulários convivem na ficha.
 *
 *   node scripts/preencher-nicho-funil.js --tenant 1bit             # simulação
 *   node scripts/preencher-nicho-funil.js --tenant 1bit --aplicar
 *   node scripts/preencher-nicho-funil.js --tenant 1bit --desfazer <csv>
 *
 * Grava só onde o nicho está VAZIO: rodar de novo não mexe em nada, e escolha
 * feita à mão na ficha não é sobrescrita.
 *
 * O de-para vai para um CSV FORA da árvore (`~/nicho-funil/`), porque leva id
 * de pessoa, e é ele que o `--desfazer` lê. Rodar como carlosfinezi, dono dos
 * bancos: um `-wal` criado pelo root tranca o servidor fora do banco.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const nichoFunil = require('../nicho-funil');

const ARGS = process.argv.slice(2);
const valor = (nome) => { const i = ARGS.indexOf(nome); return i >= 0 ? ARGS[i + 1] : undefined; };
const slug = valor('--tenant');
const aplicar = ARGS.includes('--aplicar');
const desfazer = valor('--desfazer');
if (!slug) { console.error('uso: --tenant <slug> [--aplicar] [--desfazer <csv>]'); process.exit(1); }

const DB = path.join(__dirname, '..', 'data', 'tenants', slug, 'pncp.db');
if (!fs.existsSync(DB)) { console.error(`banco não encontrado: ${DB}`); process.exit(1); }
const PASTA_CSV = path.join(os.homedir(), 'nicho-funil');

const db = new Database(DB);
db.pragma('busy_timeout = 15000');
nichoFunil.migrarNicho(db);   // a coluna, se o boot ainda não passou por aqui

const nomeDoNicho = new Map(nichoFunil.listarNichos(db).map(f => [f.id, f.nome]));
const rotulo = (id) => (id ? (nomeDoNicho.get(Number(id)) || `#${id}`) : '(vazio)');

// ---------- desfazer ----------
if (desfazer) {
  const linhas = fs.readFileSync(desfazer, 'utf8').trim().split('\n').slice(1)
    .map(l => l.split(',')).filter(c => c.length >= 3);
  if (!linhas.length) { console.error('CSV sem linhas de de-para'); process.exit(1); }
  const upd = db.prepare('UPDATE pessoas SET nichoFunilId = ? WHERE id = ? AND nichoFunilId = ?');
  let voltaram = 0, divergentes = 0;
  // `.immediate()`: o servidor grava neste banco ao mesmo tempo, e a transação
  // diferida morreria com SQLITE_BUSY_SNAPSHOT no primeiro UPDATE.
  db.transaction(() => {
    for (const [pessoaId, antes, depois] of linhas) {
      const r = upd.run(antes === '' ? null : Number(antes), Number(pessoaId), Number(depois));
      if (r.changes) voltaram++; else divergentes++;
    }
  }).immediate();
  console.log(`desfeito: ${voltaram} ficha(s) voltaram ao valor anterior`);
  if (divergentes) console.log(`${divergentes} não voltaram: o nicho de agora não é o que este CSV gravou (alguém mudou depois)`);
  process.exit(0);
}

// ---------- classificar ----------
const t0 = Date.now();
const mapa = nichoFunil.mapaDeNicho(db);
if (!mapa.padrao) {
  console.error('este tenant não tem o funil "Outros e fora do perfil" ativo — sem ele não há nicho padrão');
  process.exit(1);
}
console.log(`mapa dos cards: ${mapa.cards} telefone(s), ${mapa.ramos} ramo(s), em ${Date.now() - t0}ms`);

// Uma decisão por PESSOA, e não por linha de lista: o mesmo contato está em
// mais de uma lista (três, no 1bit), e cada linha traz o seu telefone e o seu
// ramo. Juntá-los antes evita gravar duas vezes a mesma ficha e deixa o ramo de
// uma lista salvar o que o da outra não classifica.
const linhas = db.prepare(`SELECT m.pessoaId, m.destinoManual, COALESCE(m.ramo, p.cnaeDescricao) AS ramo,
       p.nichoFunilId
  FROM comm_lista_membros m JOIN pessoas p ON p.id = m.pessoaId ORDER BY m.id`).all();
const contatos = new Map();
for (const l of linhas) {
  if (!contatos.has(l.pessoaId)) {
    contatos.set(l.pessoaId, { pessoaId: l.pessoaId, nichoFunilId: l.nichoFunilId, telefones: [], ramos: [] });
  }
  const c = contatos.get(l.pessoaId);
  if (l.destinoManual && !c.telefones.includes(l.destinoManual)) c.telefones.push(l.destinoManual);
  if (l.ramo && !c.ramos.includes(l.ramo)) c.ramos.push(l.ramo);
}

const porOrigem = new Map(), porNicho = new Map(), mudancas = [];
let jaTinham = 0;
for (const c of contatos.values()) {
  if (c.nichoFunilId) { jaTinham++; continue; }
  let achado = null;
  for (const telefone of (c.telefones.length ? c.telefones : [null])) {
    for (const ramo of (c.ramos.length ? c.ramos : [null])) {
      const r = mapa.nichoDe({ pessoaId: c.pessoaId, telefone, ramo });
      // O padrão é a última palavra: um ramo adiante pode classificar melhor.
      if (r.nichoId && r.origem !== 'padrao') { achado = r; break; }
      if (r.nichoId && !achado) achado = r;
    }
    if (achado && achado.origem !== 'padrao') break;
  }
  if (!achado || !achado.nichoId) continue;
  porOrigem.set(achado.origem, (porOrigem.get(achado.origem) || 0) + 1);
  porNicho.set(achado.nichoId, (porNicho.get(achado.nichoId) || 0) + 1);
  mudancas.push({ pessoaId: c.pessoaId, antes: c.nichoFunilId, depois: achado.nichoId, origem: achado.origem });
}

console.log(`contatos em lista: ${contatos.size} | já tinham nicho: ${jaTinham} | a gravar: ${mudancas.length}`);
console.log('origem: ' + [...porOrigem].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} ${n}`).join(' | '));
for (const [id, n] of [...porNicho].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${rotulo(id)}`);

if (!aplicar) { console.log('\nsimulação — use --aplicar para gravar'); process.exit(0); }
if (!mudancas.length) { console.log('nada a gravar'); process.exit(0); }

fs.mkdirSync(PASTA_CSV, { recursive: true });
const csv = path.join(PASTA_CSV, `${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
fs.writeFileSync(csv, 'pessoaId,antes,depois,origem\n'
  + mudancas.map(m => `${m.pessoaId},${m.antes ?? ''},${m.depois},${m.origem}`).join('\n') + '\n');

const upd = db.prepare('UPDATE pessoas SET nichoFunilId = ? WHERE id = ? AND nichoFunilId IS NULL');
let gravadas = 0;
db.transaction(() => {
  for (const m of mudancas) gravadas += upd.run(m.depois, m.pessoaId).changes;
}).immediate();

console.log(`\ngravadas: ${gravadas} ficha(s)`);
console.log(`de-para: ${csv}`);
console.log(`desfazer: node scripts/preencher-nicho-funil.js --tenant ${slug} --desfazer ${csv}`);
