/**
 * whatsapp-webhook.js — recebimento (inbox) + auto-resposta IA, multi-tenant.
 *
 * Rota PÚBLICA (server-to-server) chamada pelo Evolution quando chega mensagem.
 * Mapeia instance -> tenant pela convenção 'le_<slug>', grava em whatsapp_messages
 * e (se o tenant habilitou) responde via IA reusando a chain de providers do
 * chat-ia.js com as chaves do próprio tenant. Registrada em server.js ANTES da
 * barreira de auth; path liberado no bypass do tenant-middleware.
 */
const { migrarQueue, enviarWhatsApp } = require('./whatsapp-adapter');

const OPT_OUT_RE = /^\s*(parar|sair|stop|cancelar|descadastrar|remover)\b/i;
const AI_MAX_PER_HOUR = 15;
const HIST_TURNS = 10;
const PAUSE_MANUAL_S = 4 * 3600;
const PROMPT_PADRAO = 'Você é o atendente virtual desta empresa no WhatsApp. Responda em português, de forma breve, cordial e objetiva. Se não souber algo, diga que vai encaminhar para um atendente humano. Nunca peça senha ou dado bancário.';

function extractText(msg) {
  if (!msg) return null;
  return msg.conversation
    || (msg.extendedTextMessage && msg.extendedTextMessage.text)
    || (msg.imageMessage && msg.imageMessage.caption)
    || (msg.videoMessage && msg.videoMessage.caption)
    || null;
}

function slugFromInstance(instance) {
  if (typeof instance !== 'string') return null;
  return instance.startsWith('le_') ? instance.slice(3) : null;
}

// Gera e envia a resposta da IA. Roda após o 200 do webhook (fire-and-forget).
async function autoResponder(tdb, instance, jid, incomingText) {
  const { createConfigHelpers } = require('./config-helpers');
  const { chamarChatLLM } = require('./chat-ia');
  const { getIAKeys, getConfigValue } = createConfigHelpers(tdb);
  if (getConfigValue('whatsapp_ai_enabled') !== '1') return;
  if (OPT_OUT_RE.test(incomingText)) return;
  const keys = getIAKeys();
  if (!keys) return;

  const now = Math.floor(Date.now() / 1000);
  const cnt = tdb.prepare("SELECT COUNT(*) AS n FROM whatsapp_messages WHERE remote_jid = ? AND from_bot = 1 AND timestamp >= ?").get(jid, now - 3600).n;
  if (cnt >= AI_MAX_PER_HOUR) return; // rate limit
  const manual = tdb.prepare("SELECT 1 FROM whatsapp_messages WHERE remote_jid = ? AND from_me = 1 AND COALESCE(from_bot,0) = 0 AND timestamp >= ? LIMIT 1").get(jid, now - PAUSE_MANUAL_S);
  if (manual) return; // humano assumiu a conversa nas últimas 4h

  const hist = tdb.prepare("SELECT from_me, texto FROM whatsapp_messages WHERE remote_jid = ? AND texto IS NOT NULL AND texto <> '' ORDER BY id DESC LIMIT ?").all(jid, HIST_TURNS).reverse();
  // Campanha do lead (pelo número) → system prompt via a MESMA função do simulador
  // (whatsapp-adapter.buildSystemAtendimento) — garante simulação idêntica ao real.
  let campanhaId = null;
  try {
    const num = jid.split('@')[0];
    const d = tdb.prepare("SELECT campanha_id FROM wa_campanha_dest WHERE telefone = ? OR jid = ? ORDER BY id DESC LIMIT 1").get(num, jid);
    if (d) campanhaId = d.campanha_id;
  } catch (_) {}
  const prompt = require('./whatsapp-adapter').buildSystemAtendimento(tdb, campanhaId);
  const messages = [{ role: 'system', content: prompt }, ...hist.map(m => ({ role: m.from_me ? 'assistant' : 'user', content: m.texto }))];

  // Garantia 1 (nunca silêncio): se o LLM vier vazio ou falhar, cai no fallback genérico.
  let reply = '';
  try { const out = await chamarChatLLM(messages, keys); reply = ((out && out.content) || '').trim(); }
  catch (e) { console.error('[autoResponder] LLM falhou:', e.message); }
  if (!reply) reply = require('./whatsapp-adapter').FALLBACK_SEM_RESPOSTA;

  const r = await enviarWhatsApp(tdb, { telefone: jid.split('@')[0], texto: reply });
  try {
    tdb.prepare("INSERT OR IGNORE INTO whatsapp_messages (wa_message_id, instance, remote_jid, from_me, from_bot, texto, timestamp) VALUES (?, ?, ?, 1, 1, ?, ?)")
      .run((r && r.providerMessageId) || null, instance, jid, reply, Math.floor(Date.now() / 1000));
  } catch (_) {}
}

const POSITIVE_INTENT_RE = /\b(sim|quero|topo|bora|manda|mande|pode mandar|pode enviar|me envia|me manda|tenho interesse|interessado|interessada|ok|vamos|partiu|me explica)\b/i;

function buildLeadReply(cfg, texto) {
  const isShort = texto.trim().length <= 80;
  const positive = isShort && POSITIVE_INTENT_RE.test(texto);
  if (positive) {
    const tpl = (cfg.lead_positive_msg && String(cfg.lead_positive_msg).trim()) || 'Show! Vou te passar os detalhes agora. {link}';
    const base = (cfg.lead_link_base && String(cfg.lead_link_base).trim()) || '';
    return tpl.includes('{link}') ? tpl.split('{link}').join(base).trim() : (base ? (tpl + '\n\n' + base) : tpl);
  }
  return (cfg.lead_ack_msg && String(cfg.lead_ack_msg).trim()) || 'Opa, recebido! Já te retornamos por aqui.';
}

// Opt-out de lead de campanha: registra descadastro + confirma. Preserva o comportamento
// que vivia no antigo handleCampaignLead. Retorna true se tratou (e aí não segue pra IA).
async function handleOptOut(tdb, jid, texto) {
  if (!OPT_OUT_RE.test(texto)) return false;
  const num = jid.split('@')[0];
  let lead;
  try {
    lead = tdb.prepare("SELECT id FROM wa_campanha_dest WHERE (telefone = ? OR jid = ?) ORDER BY id DESC LIMIT 1").get(num, jid);
  } catch (_) { return false; } // tenant sem tabela de campanhas
  if (!lead) return false; // não é dest de campanha → mantém fluxo antigo (IA ignora opt-out)
  try {
    tdb.prepare("INSERT OR IGNORE INTO wa_optout (telefone) VALUES (?)").run(num);
    tdb.prepare("UPDATE wa_campanha_dest SET status = 'optout' WHERE id = ?").run(lead.id);
  } catch (_) {}
  await enviarWhatsApp(tdb, { telefone: num, texto: 'Tudo certo, você não recebe mais nossas mensagens.' }).catch(() => {});
  return true;
}

// Métrica (decisão b2): marca o dest como 'respondeu' na 1ª resposta. NÃO decide roteamento
// (sem handoff) — serve só pro filtro "Responderam". Só afeta linhas ainda em 'enviado'.
function marcarRespondeu(tdb, jid) {
  const num = jid.split('@')[0];
  try {
    tdb.prepare("UPDATE wa_campanha_dest SET status = 'respondeu' WHERE status = 'enviado' AND (telefone = ? OR jid = ?)").run(num, jid);
  } catch (_) {}
}

async function handleIncoming(tdb, instance, jid, texto) {
  if (await handleOptOut(tdb, jid, texto)) return; // descadastro preservado
  marcarRespondeu(tdb, jid);                        // métrica, não roteia
  await autoResponder(tdb, instance, jid, texto);   // fluxo unificado: SEMPRE a IA (base da campanha)
}

function registrarRotaWebhook(app, { tenantManager }) {
  app.post('/api/whatsapp/webhook', (req, res) => {
    res.sendStatus(200); // responde já; Evolution reenfileira em caso de erro
    try {
      const evt = req.body || {};
      if (evt.event !== 'messages.upsert') return;

      const slug = slugFromInstance(evt.instance);
      if (!slug || !tenantManager.getTenantBySlug(slug)) return;

      const tdb = tenantManager.getDb(slug);
      migrarQueue(tdb);

      const data = evt.data || {};
      const key = data.key || {};
      const jid = key.remoteJid;
      if (!jid || jid === 'status@broadcast') return;
      const texto = extractText(data.message);

      const info = tdb.prepare(
        `INSERT OR IGNORE INTO whatsapp_messages
           (wa_message_id, instance, remote_jid, from_me, push_name, texto, message_type, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        key.id || null, evt.instance, jid, key.fromMe ? 1 : 0,
        data.pushName || null, texto, data.messageType || null,
        data.messageTimestamp || Math.floor(Date.now() / 1000)
      );

      // auto-resposta: só para mensagem NOVA (não duplicada), recebida, 1:1, com texto
      if (info.changes > 0 && !key.fromMe && jid.endsWith('@s.whatsapp.net') && texto) {
        handleIncoming(tdb, evt.instance, jid, texto)
          .catch(e => console.error('[whatsapp-webhook] handleIncoming:', e.message));
      }
    } catch (e) {
      console.error('[whatsapp-webhook]', e.message);
    }
  });

  console.log('[WhatsApp] Webhook público registrado em /api/whatsapp/webhook');
}

module.exports = { registrarRotaWebhook, buildLeadReply, handleOptOut };
