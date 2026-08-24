#!/usr/bin/env node
// migrar-listas-legado.js — traz os destinatários das campanhas legado
// (wa_campanha_dest) para listas do módulo novo (comm_listas).
//
// Cada campanha legado vira uma lista, e cada telefone vira membro avulso
// (destinoManual/nomeManual) — os contatos não estão no cadastro de pessoas,
// e forçá-los para lá encheria o cadastro de lead frio.
//
// O que NÃO é migrado, de propósito:
//   - o histórico de envio (fica no legado, que é onde ele aconteceu)
//   - quem está em opt-out: entra na lista, mas o envio já o descarta pelo
//     comm_optout — que confere com o wa_optout do legado
//
// Uso:
//   node scripts/migrar-listas-legado.js            (simula)
//   node scripts/migrar-listas-legado.js --aplicar  (executa)

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');

const APLICAR = process.argv.includes('--aplicar');
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

const tenants = createTenantManager({ initSchema }).listAll();
console.log(`[migrar-listas] ${tenants.length} tenant(s) · modo: ${APLICAR ? 'APLICAR' : 'simulação'}`);

let totalMembros = 0;
for (const t of tenants) {
  const db = new Database(t.db_path);
  try {
    const tem = (n) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n);
    if (!tem('wa_campanha_dest') || !tem('comm_listas')) continue;

    const camps = db.prepare(`SELECT c.id, c.nome, COUNT(d.id) n
      FROM wa_campanhas c JOIN wa_campanha_dest d ON d.campanha_id = c.id
      GROUP BY c.id HAVING n > 0`).all();
    if (!camps.length) continue;

    console.log(`\n  ${t.slug}:`);
    for (const c of camps) {
      const nomeLista = `${c.nome || 'campanha ' + c.id} (legado)`;
      const existente = db.prepare('SELECT id FROM comm_listas WHERE nome = ?').get(nomeLista);
      if (existente) {
        const n = db.prepare('SELECT COUNT(*) n FROM comm_lista_membros WHERE listaId = ?').get(existente.id).n;
        console.log(`    "${nomeLista}": já existe (${n} membro(s))`);
        continue;
      }

      // Normaliza e deduplica antes de gravar: a mesma pessoa pode estar em
      // mais de uma linha do legado.
      //
      // Quem JÁ foi contatado vai para uma lista separada. Numa lista só, o
      // primeiro disparo repetiria a abordagem para quem já a recebeu — que é
      // o tipo de erro que gera denúncia e derruba número.
      const linhas = db.prepare('SELECT telefone, nome, status FROM wa_campanha_dest WHERE campanha_id = ?').all(c.id);
      const grupos = { novos: new Map(), contatados: new Map() };
      let invalidos = 0;
      for (const l of linhas) {
        const d = soDigitos(l.telefone);
        if (d.length < 10) { invalidos++; continue; }
        const destino = d.startsWith('55') ? d : '55' + d;
        const alvo = ['enviado', 'respondeu', 'optout'].includes(String(l.status)) ? 'contatados' : 'novos';
        if (!grupos.novos.has(destino) && !grupos.contatados.has(destino)) grupos[alvo].set(destino, l.nome || null);
      }

      console.log(`    ${c.nome}: ${linhas.length} linha(s) → ${grupos.novos.size} não contatado(s)`
        + (grupos.contatados.size ? ` · ${grupos.contatados.size} já contatado(s)` : '')
        + (invalidos ? ` · ${invalidos} sem telefone válido` : ''));
      totalMembros += grupos.novos.size + grupos.contatados.size;
      if (!APLICAR) continue;

      for (const [grupo, mapa] of Object.entries(grupos)) {
        if (!mapa.size) continue;
        const nome = grupo === 'novos' ? nomeLista : `${c.nome || 'campanha ' + c.id} (legado — já contatados)`;
        const listaId = db.prepare('INSERT INTO comm_listas (nome, descricao) VALUES (?, ?)')
          .run(nome, `Importada da campanha legado #${c.id}`
            + (grupo === 'contatados' ? ' — pessoas que já receberam a abordagem' : '')).lastInsertRowid;
        const ins = db.prepare('INSERT OR IGNORE INTO comm_lista_membros (listaId, destinoManual, nomeManual) VALUES (?,?,?)');
        db.transaction(() => { for (const [destino, n] of mapa) ins.run(listaId, destino, n); })();
        const gravados = db.prepare('SELECT COUNT(*) n FROM comm_lista_membros WHERE listaId = ?').get(listaId).n;
        console.log(`      "${nome}" → lista #${listaId}, ${gravados} membro(s)`);
      }
    }
  } catch (e) {
    console.error(`  ${t.slug}: FALHOU — ${e.message}`);
  } finally {
    db.close();
  }
}
console.log(`\n[migrar-listas] ${totalMembros} contato(s) ${APLICAR ? 'importados' : 'a importar'}`);
if (!APLICAR) console.log('[migrar-listas] simulação — rode com --aplicar para executar');
