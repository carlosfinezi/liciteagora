#!/usr/bin/env node
/**
 * importar-conversas-evolution.js — traz o histórico de WhatsApp que ficou
 * retido na Evolution API para a central de conversas do tenant.
 *
 * Por que existe: até 2026-08-17 o webhook da instância apontava para o bot
 * legado (/opt/evolution-status/bot, porta 8086) e nunca para o LiciteAgora,
 * então `whatsapp_messages` do tenant estava vazia e a tela de Conversas não
 * tinha o que listar. As mensagens sempre existiram — no Postgres da Evolution.
 *
 * Popula só `whatsapp_messages`: `conv_conversas` se monta sozinha, porque
 * conversas-routes.sincronizar() roda a cada GET /api/conversas.
 *
 * Uso:
 *   node scripts/importar-conversas-evolution.js <tenant>            # simula
 *   node scripts/importar-conversas-evolution.js <tenant> --aplicar  # grava
 *
 * Idempotente: INSERT OR IGNORE sobre o índice único de wa_message_id.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');
const { jidCanonico } = require('../whatsapp-webhook');

const EVOLUTION_ENV = '/opt/evolution-api/.env';

const tenant = process.argv[2];
const aplicar = process.argv.includes('--aplicar');
if (!tenant || tenant.startsWith('--')) {
  console.error('uso: node scripts/importar-conversas-evolution.js <tenant> [--aplicar]');
  process.exit(1);
}

function uriPostgres() {
  const env = fs.readFileSync(EVOLUTION_ENV, 'utf8');
  const m = env.match(/DATABASE_CONNECTION_URI\s*=\s*'?(postgresql:\/\/[^'\s?]+)/);
  if (!m) throw new Error('DATABASE_CONNECTION_URI não encontrada em ' + EVOLUTION_ENV);
  return m[1];
}

// Mesma extração do webhook: o que não tem texto não serve para a central.
function extractText(msg) {
  if (!msg) return null;
  return msg.conversation
    || (msg.extendedTextMessage && msg.extendedTextMessage.text)
    || (msg.imageMessage && msg.imageMessage.caption)
    || (msg.videoMessage && msg.videoMessage.caption)
    || null;
}

(async () => {
  const dbPath = path.join(__dirname, '..', 'data', 'tenants', tenant, 'pncp.db');
  if (!fs.existsSync(dbPath)) throw new Error('tenant sem banco: ' + dbPath);
  const db = new Database(dbPath, { readonly: !aplicar });

  const instancia = db.prepare("SELECT value FROM whatsapp_config WHERE key = 'instance'").get();
  if (!instancia || !instancia.value) throw new Error('tenant sem instância em whatsapp_config');
  const instance = instancia.value;

  const pg = new Client({ connectionString: uriPostgres() });
  await pg.connect();

  const inst = await pg.query('SELECT id FROM evolution_api."Instance" WHERE name = $1', [instance]);
  if (!inst.rows.length) throw new Error('instância não existe na Evolution: ' + instance);
  const instanceId = inst.rows[0].id;

  // Nem toda mensagem LID traz o número em remoteJidAlt — as anteriores a
  // 2026-05 não trazem nenhuma. Mas o mesmo contato costuma aparecer depois
  // numa mensagem que traz, então dá para recuperar boa parte do histórico
  // cruzando LID -> número pelo conjunto inteiro.
  const mapa = new Map();
  const alt = await pg.query(
    `SELECT DISTINCT "key"->>'remoteJid' lid, "key"->>'remoteJidAlt' num
       FROM evolution_api."Message"
      WHERE "instanceId" = $1
        AND "key"->>'remoteJid' LIKE '%@lid'
        AND "key"->>'remoteJidAlt' IS NOT NULL`, [instanceId]);
  for (const r of alt.rows) if (!mapa.has(r.lid)) mapa.set(r.lid, r.num);

  // Grupos e status ficam de fora: a central é atendimento 1:1, e é isso que
  // o webhook também aceita.
  const { rows } = await pg.query(
    `SELECT "key", "pushName", "messageType", "message", "messageTimestamp"
       FROM evolution_api."Message"
      WHERE "instanceId" = $1
        AND "key"->>'remoteJid' NOT LIKE '%@g.us'
        AND "key"->>'remoteJid' <> 'status@broadcast'
      ORDER BY "messageTimestamp"`, [instanceId]);
  await pg.end();

  const ins = db.prepare(
    `INSERT OR IGNORE INTO whatsapp_messages
       (wa_message_id, instance, remote_jid, from_me, push_name, texto, message_type, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  let gravadas = 0, semTexto = 0, semJid = 0;
  const jids = new Set();

  const importar = db.transaction((linhas) => {
    for (const r of linhas) {
      const key = r.key || {};
      let jid = jidCanonico(key);            // resolve o LID para o número real
      if (jid && jid.endsWith('@lid')) jid = mapa.get(jid) || jid;
      if (!jid || !jid.endsWith('@s.whatsapp.net')) { semJid++; continue; }
      const texto = extractText(r.message);
      if (!texto) { semTexto++; continue; }
      jids.add(jid);
      if (!aplicar) { gravadas++; continue; }
      const info = ins.run(
        key.id || null, instance, jid, key.fromMe ? 1 : 0,
        r.pushName || null, texto, r.messageType || null, r.messageTimestamp || null);
      gravadas += info.changes;
    }
  });
  importar(rows);

  console.log(`tenant=${tenant} instancia=${instance}`);
  console.log(`lidas na Evolution : ${rows.length}`);
  console.log(`fora do 1:1        : ${semJid} (LID sem número real, grupos residuais)`);
  console.log(`sem texto          : ${semTexto} (áudio, figurinha, reação)`);
  console.log(`${aplicar ? 'gravadas' : 'gravaria'}           : ${gravadas} em ${jids.size} conversas`);
  if (!aplicar) console.log('\n(simulação — rode com --aplicar para gravar)');
  db.close();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
