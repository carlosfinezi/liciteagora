#!/usr/bin/env node
/**
 * corrigir-nome-conversas.js — tira das conversas o nome do dono da instância.
 *
 * O pushName que a Evolution manda numa mensagem ENVIADA é o de quem atende,
 * não o do contato. Como a central escolhia o nome pela última mensagem com
 * pushName, sem olhar a direção, a conversa acabava batizada com o nome do
 * próprio atendente ("Carlos Finezi", "Você"). O código já foi corrigido em
 * conversas-routes.sincronizar() e no whatsapp-webhook; isto conserta o que
 * ficou gravado antes.
 *
 * Só mexe em conversa cujo nome atual coincide com o pushName de uma mensagem
 * enviada dela — é o rastro exato do defeito, sem chutar por lista de nomes.
 * Conversa já casada com pessoa do cadastro (pessoaId) fica intocada: aquele
 * nome veio do ERP e é melhor que qualquer pushName.
 *
 * Uso:
 *   node scripts/corrigir-nome-conversas.js <tenant>            # simula
 *   node scripts/corrigir-nome-conversas.js <tenant> --aplicar  # grava
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const tenant = process.argv[2];
const aplicar = process.argv.includes('--aplicar');
if (!tenant || tenant.startsWith('--')) {
  console.error('uso: node scripts/corrigir-nome-conversas.js <tenant> [--aplicar]');
  process.exit(1);
}

const dbPath = path.join(__dirname, '..', 'data', 'tenants', tenant, 'pncp.db');
if (!fs.existsSync(dbPath)) { console.error('tenant sem banco: ' + dbPath); process.exit(1); }
const db = new Database(dbPath, { readonly: !aplicar });

// Suspeitas: nome atual bate com o pushName de alguma mensagem que SAIU.
const suspeitas = db.prepare(`
  SELECT c.id, c.jid, c.telefone, c.nome
    FROM conv_conversas c
   WHERE c.pessoaId IS NULL AND c.nome IS NOT NULL
     AND EXISTS (SELECT 1 FROM whatsapp_messages m
                  WHERE m.remote_jid = c.jid AND m.from_me = 1 AND m.push_name = c.nome)`).all();

// O nome certo é o pushName mais recente de mensagem RECEBIDA. Contato sem
// nome de perfil vem com um id numérico no lugar — isso não é nome, e na tela
// passaria por um telefone errado; nesse caso é melhor não ter nome nenhum.
const doContato = db.prepare(`
  SELECT push_name FROM whatsapp_messages
   WHERE remote_jid = ? AND from_me = 0 AND push_name IS NOT NULL
     AND trim(push_name) <> '' AND push_name GLOB '*[^0-9]*'
   ORDER BY id DESC LIMIT 1`);

const upd = db.prepare('UPDATE conv_conversas SET nome = ? WHERE id = ?');

let recuperadas = 0, limpas = 0;
const amostra = [];
const rodar = db.transaction(() => {
  for (const c of suspeitas) {
    const r = doContato.get(c.jid);
    const novo = (r && r.push_name) || null;
    if (novo) recuperadas++; else limpas++;
    if (amostra.length < 8) amostra.push(`  ${c.telefone}: "${c.nome}" -> ${novo ? `"${novo}"` : '(sem nome, mostra o telefone)'}`);
    if (aplicar) upd.run(novo, c.id);
  }
});
rodar();

console.log(`tenant=${tenant}`);
console.log(`conversas com nome do atendente : ${suspeitas.length}`);
console.log(`  nome real recuperado do contato: ${recuperadas}`);
console.log(`  sem pushName recebido, limpas  : ${limpas}`);
if (amostra.length) console.log('\namostra:\n' + amostra.join('\n'));
if (!aplicar) console.log('\n(simulação — rode com --aplicar para gravar)');
db.close();
