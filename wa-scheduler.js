/**
 * wa-scheduler.js — disparo AGENDADO de campanhas de WhatsApp (roda no worker).
 * A cada tick varre os tenants; para os que têm WhatsApp habilitado e conectado,
 * dispara as campanhas 'agendada' cuja hora já chegou — tanto o subsistema próprio
 * (wa_campanhas) quanto as do comm (canal whatsapp). Reusa os runners + o dedup
 * (running Map) do mesmo processo, então nunca duplica um envio manual em curso.
 */
'use strict';

const { runCampaign } = require('./wa-campaigns-routes');
const { dispararCommWhatsApp } = require('./comm-routes');
const { loadProviderConfig } = require('./whatsapp-adapter');
const { localDate } = require('./wa-m1-utils');

const TICK_MS = 120000; // 2 min
const TZ = 'America/Belem';

// Dia da semana (mon..sun) e hora (HH:MM) no fuso, para a agenda recorrente.
function nowTz() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date()).map(x => [x.type, x.value])
  );
  const wd = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' }[p.weekday];
  const hh = p.hour === '24' ? '00' : p.hour;
  return { wd, hm: `${hh}:${p.minute}` };
}

function whatsappOn(tdb) {
  try { const r = tdb.prepare("SELECT valor FROM config WHERE chave = 'whatsapp_enabled'").get(); return !!(r && String(r.valor) === '1'); }
  catch (_) { return false; }
}

function tick(tenantManager) {
  let tenants;
  try { tenants = tenantManager.listAll(); } catch (_) { return; }
  for (const t of tenants) {
    let tdb;
    try { tdb = tenantManager.getDb(t.slug); } catch (_) { continue; }
    if (!whatsappOn(tdb)) continue;
    const cfg = loadProviderConfig(tdb);
    if (!cfg || cfg.provider !== 'evolution' || !cfg.instance) continue; // sem WhatsApp conectado: não dispara

    // wa_campanhas agendadas (data no config JSON)
    try {
      const due = tdb.prepare(`
        SELECT id FROM wa_campanhas
        WHERE status = 'agendada'
          AND json_extract(config, '$.agendadaPara') IS NOT NULL
          AND julianday(json_extract(config, '$.agendadaPara')) <= julianday('now')
      `).all();
      for (const c of due) {
        try { runCampaign(tdb, t.slug, c.id).catch(() => {}); } catch (_) {}
      }
    } catch (_) { /* tenant sem tabela wa_campanhas */ }

    // comm campanhas whatsapp agendadas
    try {
      const due = tdb.prepare(`
        SELECT c.id FROM comm_campanhas c JOIN comm_templates tpl ON tpl.id = c.templateId
        WHERE c.status = 'agendada' AND tpl.canal = 'whatsapp'
          AND c.agendadaPara IS NOT NULL
          AND julianday(c.agendadaPara) <= julianday('now')
      `).all();
      for (const c of due) {
        try { dispararCommWhatsApp(tdb, t.slug, c.id); } catch (_) {}
      }
    } catch (_) { /* tenant sem tabelas comm */ }

    // Agenda RECORRENTE (dias da semana + hora, 1x/dia) — subsistema wa_campanhas.
    try {
      const { wd, hm } = nowTz();
      const hojeLocal = localDate(Date.now(), TZ);
      for (const a of tdb.prepare("SELECT * FROM wa_agenda WHERE enabled = 1").all()) {
        let dias = [];
        try { dias = JSON.parse(a.dias || '[]'); } catch (_) {}
        if (!dias.includes(wd)) continue;
        if (hm < (a.hora || '99:99')) continue;      // ainda não chegou a hora hoje
        if (a.ultimo_disparo === hojeLocal) continue; // já disparou hoje
        tdb.prepare("UPDATE wa_agenda SET ultimo_disparo = ? WHERE id = ?").run(hojeLocal, a.id);
        try { runCampaign(tdb, t.slug, a.campanha_id).catch(() => {}); } catch (_) {}
      }
    } catch (_) { /* tenant sem tabela wa_agenda */ }
  }
}

function iniciarScheduler(tenantManager) {
  setInterval(() => {
    try { tick(tenantManager); } catch (e) { console.error('[wa-scheduler]', e.message); }
  }, TICK_MS);
  console.log('[wa-scheduler] iniciado (tick ' + (TICK_MS / 1000) + 's)');
}

module.exports = { iniciarScheduler, tick };
