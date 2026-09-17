#!/usr/bin/env node
/**
 * migrar-os-tipo-operacao.js
 *
 * Liga cada Tipo de OS ao Tipo de Operação que passa a reger o comportamento
 * fiscal e financeiro da OS (emiteNFe / geraFinanceiro), e migra as OS que
 * usavam o antigo checkbox `naoEmitirNFe` para a operação equivalente.
 *
 * Regra do mapeamento (deriva do que já estava declarado no tipo):
 *   nome = 'Garantia'        -> OS-GARANTIA  (sem nota, sem cobrança)
 *   modoFiscal = 'interno'   -> OS-INTERNA   (sem nota, com cobrança)
 *   demais                   -> OS-NORMAL    (nota + cobrança)
 *
 * Os ids de tipos_operacao mudam de tenant para tenant, então a resolução é
 * sempre pelo `codigo`, nunca por id fixo.
 *
 * Uso:  node scripts/migrar-os-tipo-operacao.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');
const RAIZ = path.join(__dirname, '..');
const TENANTS = path.join(RAIZ, 'data', 'tenants');

function opDe(db, codigo) {
  return db.prepare('SELECT id, codigo, emiteNFe, geraFinanceiro FROM tipos_operacao WHERE codigo = ? AND ativo = 1').get(codigo);
}

let totalTipos = 0, totalOS = 0, tenantsOk = 0, avisos = [];

for (const tenant of fs.readdirSync(TENANTS).sort()) {
  const arq = path.join(TENANTS, tenant, 'pncp.db');
  if (!fs.existsSync(arq)) continue;
  const db = new Database(arq);
  try {
    const temTipos = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='os_tipos'").get();
    if (!temTipos) continue;

    const normal = opDe(db, 'OS-NORMAL');
    const interna = opDe(db, 'OS-INTERNA');
    const garantia = opDe(db, 'OS-GARANTIA');
    if (!normal || !interna || !garantia) {
      avisos.push(`${tenant}: faltam tipos de operação de OS (NORMAL/INTERNA/GARANTIA) — pulado`);
      continue;
    }

    const tipos = db.prepare('SELECT id, nome, modoFiscal, tipoOperacaoPadraoId FROM os_tipos').all();
    const linhas = [];
    for (const t of tipos) {
      if (t.tipoOperacaoPadraoId) continue; // já ligado: não sobrescreve escolha existente
      const alvo = /garantia/i.test(t.nome || '') ? garantia
        : (t.modoFiscal === 'interno' ? interna : normal);
      linhas.push({ id: t.id, nome: t.nome, codigo: alvo.codigo, opId: alvo.id });
    }

    // OS que usavam o checkbox: passam a apontar para OS-INTERNA (sem nota,
    // com cobrança) — é o que `naoEmitirNFe = 1` significava na prática.
    // Tenant pode ter os_tipos (semeado) sem nunca ter aberto OS.
    const temOrdens = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='os_ordens'").get();
    const osLegado = temOrdens ? db.prepare(
      'SELECT id, numero FROM os_ordens WHERE naoEmitirNFe = 1 AND (tipoOperacaoId IS NULL OR tipoOperacaoId <> ?)'
    ).all(interna.id) : [];

    console.log(`\n=== ${tenant} ===`);
    for (const l of linhas) console.log(`  tipo "${l.nome}" -> ${l.codigo}`);
    for (const o of osLegado) console.log(`  OS ${o.numero} (naoEmitirNFe=1) -> ${interna.codigo}`);
    if (!linhas.length && !osLegado.length) console.log('  nada a fazer');

    if (!DRY) {
      const trx = db.transaction(() => {
        const up = db.prepare('UPDATE os_tipos SET tipoOperacaoPadraoId = ? WHERE id = ?');
        for (const l of linhas) up.run(l.opId, l.id);
        // prepare só quando há o que migrar: a tabela pode não existir aqui.
        if (osLegado.length) {
          const upOs = db.prepare('UPDATE os_ordens SET tipoOperacaoId = ? WHERE id = ?');
          for (const o of osLegado) upOs.run(interna.id, o.id);
        }
      });
      trx();
    }
    totalTipos += linhas.length;
    totalOS += osLegado.length;
    tenantsOk++;
  } finally {
    db.close();
  }
}

console.log(`\n${DRY ? '[DRY-RUN] ' : ''}${tenantsOk} tenant(s) · ${totalTipos} tipo(s) de OS ligado(s) · ${totalOS} OS migrada(s)`);
for (const a of avisos) console.log(`AVISO: ${a}`);
