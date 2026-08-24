/**
 * habilitacao-renovar.js — renovação automática das certidões com busca
 * automática (CNDT, CRF FGTS) que estão perto de vencer.
 *
 * Roda via cron (diário). Para cada tipo com provider, varre todos os tenants
 * e reemite os documentos cuja validade está a <= N dias (janela por tipo,
 * pois a validade difere: CNDT 180d, CRF ~30d). Sequencial — uma emissão por
 * vez (cada robô abre um Chrome pesado). Substitui o antigo cndt-renovar.js.
 *
 * Env: DIAS_CNDT (default 15), DIAS_CRF (default 7)
 */

const path = require('path');
const net = require('net');
const Database = require('better-sqlite3');
const { cnpjIeParaCertidao } = require('./habilitacao-cnpj');
const { sendTelegram } = require('./telegram-client');

// tipo (== chave do PROVEDORES em habilitacao-routes.js) → provider + janela.
// precisaProxy: robô sai pelo SOCKS residencial (VPN loja, 127.0.0.1:1080);
// sem o proxy nem carrega o portal (ShieldSquare/datacenter bloqueado).
const RENOVAVEIS = [
  { tipo: 'CNDT (Débitos Trabalhistas)', provider: require('./habilitacao-provedores/cndt'), dias: parseInt(process.env.DIAS_CNDT || '15', 10) },
  { tipo: 'CRF FGTS', provider: require('./habilitacao-provedores/crf'), dias: parseInt(process.env.DIAS_CRF || '7', 10), precisaProxy: true },
  { tipo: 'CND Federal (Receita/PGFN)', provider: require('./habilitacao-provedores/cndfed'), dias: parseInt(process.env.DIAS_CNDFED || '15', 10) },
  { tipo: 'Certidão Negativa Estadual', provider: require('./habilitacao-provedores/sefa'), dias: parseInt(process.env.DIAS_ESTADUAL || '15', 10), precisaProxy: true },
  { tipo: 'Certidão Negativa Municipal', provider: require('./habilitacao-provedores/mrb'), dias: parseInt(process.env.DIAS_MUNICIPAL || '10', 10) },
];

function log(...a) { console.log(`[${new Date().toISOString()}]`, ...a); }
function isoMais(d) { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); }

function listarTenants() {
  const db = new Database(path.join(__dirname, 'data', 'control.db'), { readonly: true });
  try { return db.prepare('SELECT slug, db_path FROM tenants').all(); }
  finally { db.close(); }
}

// Preflight: o SOCKS residencial (VPN loja) está de pé? Basta um TCP connect
// em 127.0.0.1:1080 — foi exatamente o que faltou no incidente (microsocks
// morto, nada escutando na porta).
function socksOk(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: 1080 });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// Alerta de ops: envia para o 1º tenant com telegram_config ativo (canal admin).
async function alertarAdmin(msg) {
  for (const t of listarTenants()) {
    try {
      const db = new Database(t.db_path, { readonly: true });
      try { if (await sendTelegram(db, msg)) return true; }
      finally { db.close(); }
    } catch { /* segue p/ próximo tenant */ }
  }
  return false;
}

// Alerta no canal do próprio tenant (usa a config de telegram dele).
async function alertarTenant(dbPath, msg) {
  try {
    const db = new Database(dbPath, { readonly: true });
    try { await sendTelegram(db, msg); }
    finally { db.close(); }
  } catch { /* não-fatal */ }
}

async function main() {
  let total = 0, ok = 0, fail = 0;

  // Preflight do proxy: se estiver fora, pula CRF/Estadual (nem adianta abrir
  // o Chrome) e avisa o admin — em vez de falhar em silêncio no log.
  const proxyUp = await socksOk();
  if (proxyUp) {
    log('preflight: SOCKS 127.0.0.1:1080 OK');
  } else {
    log('⚠️ preflight: SOCKS 127.0.0.1:1080 FORA DO AR — providers via proxy (CRF/Estadual) serão pulados');
    await alertarAdmin('⚠️ <b>Renovação de certidões</b>\nProxy SOCKS (VPN loja) fora do ar em <code>127.0.0.1:1080</code>. CRF FGTS e Estadual não serão renovados neste ciclo.\nVerificar <code>liciteagora-vpn.service</code>.');
  }

  for (const { tipo, provider, dias, precisaProxy } of RENOVAVEIS) {
    if (precisaProxy && !proxyUp) { log(`[${tipo}] PULADO — proxy fora do ar`); continue; }
    const limite = isoMais(dias);
    log(`[${tipo}] alvo: validade <= ${limite} (${dias}d)`);
    for (const t of listarTenants()) {
      let docs = [];
      try {
        const db = new Database(t.db_path, { readonly: true });
        try {
          docs = db.prepare(
            `SELECT * FROM habilitacao_documentos
               WHERE ativo = 1 AND tipo = ? AND (dataValidade IS NULL OR dataValidade <= ?)`
          ).all(tipo, limite);
          // Multi-loja: resolve o CNPJ/IE de cada doc (herança matriz↔filial) com o db aberto.
          for (const d of docs) d._cnpjCtx = cnpjIeParaCertidao(db, d.estabelecimentoId, d.esfera);
        } finally { db.close(); }
      } catch (e) { continue; } // tenant sem a tabela ainda
      for (const d of docs) {
        total++;
        log(`[${t.slug}] ${tipo} doc ${d.id} ${d.dataValidade ? 'vence ' + d.dataValidade : 'nunca capturado'} → reemitindo...`);
        try {
          const r = await provider.buscar(d, { tenantSlug: t.slug, cnpjCtx: d._cnpjCtx });
          ok++; log(`[${t.slug}] doc ${d.id} ✓ ${r.mensagem}`);
        } catch (e) {
          fail++; log(`[${t.slug}] doc ${d.id} ✗ ${e.message}`);
          await alertarTenant(t.db_path, `⚠️ <b>Renovação ${tipo}</b> falhou\nTenant: ${t.slug} · doc ${d.id} · ${d.dataValidade ? 'vence ' + d.dataValidade : 'nunca capturado'}\n${e.message}`);
        }
      }
    }
  }
  log(`fim: ${total} candidato(s), ${ok} renovado(s), ${fail} falha(s)`);
}

main().then(() => process.exit(0)).catch((e) => { log('ERRO GERAL:', e.message); process.exit(1); });
