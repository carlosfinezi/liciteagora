#!/usr/bin/env node
// migrate-politicas-prazo.js — converte a regra de pagamento que vivia solta na
// ficha (pessoas.condicaoPagamentoPadrao + meiosPagamentoPermitidos) em
// Políticas de Prazo, e aponta cada pessoa para a sua.
//
// Uma política por combinação distinta (prazo, meios) encontrada no tenant —
// clientes com a mesma regra passam a compartilhar o mesmo cadastro, que é o
// ponto de existir a política. Os campos legados NÃO são apagados: eles seguem
// como fallback em prazo-pagamento.js/meios-pagamento.js e são a única forma de
// refazer a migração se o agrupamento sair errado.
//
// listAll e não listActive: applyRouteMigrations só roda na criação do tenant.
const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const DRY = process.argv.includes('--dry-run');

const MEIOS = {
  '01': 'Dinheiro', '02': 'Cheque', '03': 'Cartão de crédito', '04': 'Cartão de débito',
  '15': 'Boleto', '16': 'Depósito', '17': 'PIX', '18': 'Transferência', '19': 'Carteira digital',
};

/** Nome legível para a combinação — é o que aparece na tela e no select da ficha. */
function nomeDaCombinacao(prazo, meios) {
  const partes = [];
  partes.push(prazo ? `${prazo} dias` : 'À vista');
  if (meios.length === 1) partes.push(MEIOS[meios[0]] || meios[0]);
  else if (meios.length > 1) partes.push(`${meios.length} meios`);
  return partes.join(' · ');
}

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrate-politicas-prazo] tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let criadas = 0, vinculadas = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const cols = db.prepare('PRAGMA table_info(pessoas)').all().map(c => c.name);
    if (!cols.includes('politicaPrazoId')) {
      console.log(`  ${t.slug}: sem politicaPrazoId — rode o server uma vez para o initSchema criar`);
      continue;
    }

    const pessoas = db.prepare(`
      SELECT id, razaoSocial, condicaoPagamentoPadrao, meiosPagamentoPermitidos
      FROM pessoas
      WHERE politicaPrazoId IS NULL
        AND ((condicaoPagamentoPadrao IS NOT NULL AND condicaoPagamentoPadrao <> '')
          OR (meiosPagamentoPermitidos IS NOT NULL AND meiosPagamentoPermitidos NOT IN ('', '[]')))
    `).all();

    if (!pessoas.length) { console.log(`  ${t.slug}: nada a migrar`); continue; }

    // Agrupa por (prazo, meios) — a chave é o que define uma política.
    const grupos = new Map();
    for (const p of pessoas) {
      const prazo = (p.condicaoPagamentoPadrao || '').trim() || null;
      // Prazo legado que não é prazo ("À vista", "Boleto 30d") não vira política:
      // inventar dias a partir de texto livre seria adivinhar vencimento.
      if (prazo && !/^\d{1,4}([/,;+]\s*\d{1,4})*$/.test(prazo)) {
        console.log(`  ${t.slug}: pessoa ${p.id} tem prazo não estruturado ("${prazo}") — deixada sem política`);
        continue;
      }
      let meios = [];
      try { meios = p.meiosPagamentoPermitidos ? JSON.parse(p.meiosPagamentoPermitidos) : []; } catch {}
      if (!Array.isArray(meios)) meios = [];
      meios = meios.map(c => String(c).trim().padStart(2, '0')).filter(c => MEIOS[c]).sort();
      const prazoNorm = prazo ? prazo.split(/[/,;+]/).map(s => s.trim()).join('/') : null;
      const chave = `${prazoNorm || ''}|${meios.join(',')}`;
      if (!grupos.has(chave)) grupos.set(chave, { prazo: prazoNorm, meios, pessoas: [] });
      grupos.get(chave).pessoas.push(p.id);
    }

    for (const g of grupos.values()) {
      const nome = nomeDaCombinacao(g.prazo, g.meios);
      if (DRY) {
        console.log(`  ${t.slug}: criaria "${nome}" para ${g.pessoas.length} cadastro(s)`);
        continue;
      }
      const existente = db.prepare('SELECT id FROM politicas_prazo WHERE nome = ?').get(nome);
      let polId = existente ? existente.id : null;
      if (!polId) {
        polId = db.prepare(`INSERT INTO politicas_prazo
          (nome, tipo, prazoDias, meiosPermitidos, aplicaVendas, aplicaCompras, aplicaPdv, observacoes)
          VALUES (?, ?, ?, ?, 1, 0, 1, 'Criada na migração dos campos da ficha (2026-08-21)')`).run(
          nome,
          g.prazo ? 'prazo' : 'vista',
          g.prazo,
          g.meios.length ? JSON.stringify(g.meios) : null
        ).lastInsertRowid;
        criadas++;
      }
      const upd = db.prepare('UPDATE pessoas SET politicaPrazoId = ? WHERE id = ?');
      for (const pid of g.pessoas) { upd.run(polId, pid); vinculadas++; }
      console.log(`  ${t.slug}: "${nome}" → ${g.pessoas.length} cadastro(s)`);
    }
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
    process.exitCode = 1;
  } finally { db.close(); }
}
console.log(`\n${criadas} política(s) criada(s), ${vinculadas} cadastro(s) vinculado(s).`);
