/**
 * marcar-clientes.js — acrescenta a categoria "cliente" a quem já estava no
 * cadastro de pessoas antes da unificação com `fornecedores` (2026-08-20).
 *
 * Contexto: até a unificação, `pessoas` ERA a tela "Clientes" — quem estava
 * ali era cliente, mesmo sem a categoria marcada (a coluna `categorias` é
 * recente e ficou vazia na maioria). Depois da migração a lista passou a
 * misturar clientes e fornecedores, e sem a categoria ninguém aparece no
 * filtro. Este script preenche o passado; o presente já nasce marcado pelo
 * default do formulário.
 *
 * Quem NÃO é cliente: só quem nasceu da migração — cpfCnpj que estava na
 * tabela `fornecedores` do backup e NÃO estava em `pessoas` (SEFAZ,
 * distribuidoras). Todo o resto ganha a categoria, inclusive quem foi
 * cadastrado depois do backup e quem já era pessoa E fornecedor (fica com as
 * duas, que é o correto).
 *
 * Identificar o migrado pela origem, e não por "estava em pessoas no backup",
 * importa: entre o backup e a execução alguém cadastrou um cliente de verdade
 * (SHPS, no josecarloscostafilho), e o critério ingênuo o deixaria de fora.
 *
 * Uso:
 *   node scripts/marcar-clientes.js <dir-do-backup>            # simula
 *   node scripts/marcar-clientes.js <dir-do-backup> --aplicar  # grava
 *
 * Idempotente: só toca em quem ainda não tem a categoria.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TENANTS = path.join(ROOT, 'data', 'tenants');

const backupDir = process.argv[2];
const aplicar = process.argv.includes('--aplicar');

if (!backupDir || !fs.existsSync(backupDir)) {
  console.error('uso: node scripts/marcar-clientes.js <dir-do-backup> [--aplicar]');
  process.exit(1);
}

function comCliente(valorAtual) {
  let cats = [];
  try { cats = JSON.parse(valorAtual || '[]'); } catch (_) { cats = []; }
  if (!Array.isArray(cats)) cats = [];
  if (cats.some(c => String(c).toLowerCase() === 'cliente')) return null;  // já tem
  cats.push('cliente');
  return JSON.stringify(cats);
}

let totalMarcadas = 0;
let totalPuladas = 0;

for (const slug of fs.readdirSync(TENANTS).sort()) {
  const dbPath = path.join(TENANTS, slug, 'pncp.db');
  const bkpPath = path.join(backupDir, `${slug}.db`);
  if (!fs.existsSync(dbPath) || !fs.existsSync(bkpPath)) continue;

  const bkp = new Database(bkpPath, { readonly: true });
  const ler = (sql) => { try { return bkp.prepare(sql).all().map(r => r.cpfCnpj); } catch (_) { return []; } };
  const pessoasAntes = new Set(ler('SELECT cpfCnpj FROM pessoas'));
  // Nasceu da migração = era fornecedor e ainda não era pessoa.
  const daMigracao = new Set(ler('SELECT cpfCnpj FROM fornecedores').filter(d => !pessoasAntes.has(d)));
  bkp.close();

  const db = new Database(dbPath);
  const pessoas = db.prepare('SELECT id, cpfCnpj, razaoSocial, categorias FROM pessoas').all();
  const alvo = [];
  let jaTinha = 0;
  let novasDaMigracao = 0;

  for (const p of pessoas) {
    if (daMigracao.has(p.cpfCnpj)) { novasDaMigracao++; continue; }
    const novas = comCliente(p.categorias);
    if (novas === null) { jaTinha++; continue; }
    alvo.push({ ...p, novas });
  }

  if (pessoas.length) {
    console.log(`${slug}: ${pessoas.length} pessoa(s) | marcar ${alvo.length} | ` +
      `já era cliente ${jaTinha} | veio da migração de fornecedores ${novasDaMigracao}`);
  }

  if (aplicar && alvo.length) {
    const upd = db.prepare(
      'UPDATE pessoas SET categorias = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?'
    );
    db.transaction(() => { for (const p of alvo) upd.run(p.novas, p.id); })();
  }
  totalMarcadas += alvo.length;
  totalPuladas += novasDaMigracao;
  db.close();
}

console.log(`\n${aplicar ? 'MARCADAS' : 'a marcar (simulação)'}: ${totalMarcadas} pessoa(s)`);
console.log(`fora, por terem vindo da migração de fornecedores: ${totalPuladas}`);
if (!aplicar) console.log('nada foi gravado — rode com --aplicar para valer');
