// pcp-monitor.js
//
// Scheduler por-tenant que sincroniza dados do Portal de Compras Públicas
// e dispara Telegram em mensagens novas do chat dos pregões.
//
// Ciclo a cada 5 min:
//   1) GET /4/SeusPregoes/ página 1 → upsert pcp_pregoes (captura novos);
//      marca ativo=0 pra pregões com situação "finalizado/cancelado/etc"
//   2) Pra cada pregão ativo no DB (até 30 mais recentes):
//        GET apipcp.../fornecedor/processo/<id>/chat?ultimaMsg=<ultimo_chat_id>
//        → registra mensagens novas em pcp_mensagens
//        → envia Telegram pra cada msg nova — pulando apenas o histórico
//          inicial de pregões recém-descobertos (evita spam no bootstrap)
//
// Por-tenant: timers vivem em `Map<dbName, {first, interval}>` — nunca global
// (ver memória feedback_liciteagora_scheduler_pertenant).

const pcp = require('./pcp-client');
const { migratePcpSchema } = require('./pcp-schema');

const PCP_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PCP_FIRST_DELAY_MS = 60 * 1000;
const FINALIZADAS_RE = /finalizad|cancelad|deserto|fracassad|revog|anulad/i;
const APIPCP_BASE = 'https://apipcp.portaldecompraspublicas.com.br';
const OPERACAO_BASE = 'https://operacao.portaldecompraspublicas.com.br';

const timersByDb = new Map(); // dbName → { first, interval }

function dbKey(db) {
  return db.name || db.filename || 'unknown';
}

function temCredenciais(db) {
  const r = db
    .prepare(
      "SELECT COUNT(*) c FROM config WHERE chave IN ('pcp_usuario','pcp_senha') AND valor IS NOT NULL AND valor != ''"
    )
    .get();
  return r.c >= 2;
}

function agendarPcpMonitor(db) {
  const key = dbKey(db);
  if (timersByDb.has(key)) return;

  try {
    migratePcpSchema(db);
  } catch (e) {
    console.error(`[PCP-monitor][${key}] migrate erro:`, e.message);
    return;
  }

  if (!temCredenciais(db)) {
    // tenant não usa PCP — não agenda; agendar novamente quando credenciais forem salvas
    return;
  }

  const first = setTimeout(() => {
    sincronizarPcp(db).catch((e) => console.error(`[PCP-monitor][${key}] erro:`, e.message));
  }, PCP_FIRST_DELAY_MS);

  const interval = setInterval(() => {
    sincronizarPcp(db).catch((e) => console.error(`[PCP-monitor][${key}] erro:`, e.message));
  }, PCP_SYNC_INTERVAL_MS);

  timersByDb.set(key, { first, interval });
  console.log(`[PCP-monitor][${key}] agendado a cada ${PCP_SYNC_INTERVAL_MS / 1000}s`);
}

function pararPcpMonitor(db) {
  const key = dbKey(db);
  const t = timersByDb.get(key);
  if (!t) return;
  clearTimeout(t.first);
  clearInterval(t.interval);
  timersByDb.delete(key);
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sincronizarPcp(db, opts = {}) {
  const enviarTelegram =
    opts.enviarTelegram || (() => {
      try {
        return require('./telegram-client').sendTelegram;
      } catch {
        return null;
      }
    })();

  const stats = {
    pregoesNovos: 0,
    pregoesAtualizados: 0,
    finalizados: 0,
    mensagensNovas: 0,
    telegramEnviados: 0,
    erros: 0,
  };

  const agora = new Date().toISOString();
  const bootstrapBitmap = new Set(); // chave_ids descobertos AGORA — pular Telegram no histórico

  // 1) Captura página 1 da listagem (10 mais recentes)
  let listagem;
  try {
    listagem = await pcp.listSeusPregoes(db, { pagina: 1 });
  } catch (e) {
    stats.erros++;
    console.error(`[PCP-monitor][${dbKey(db)}] listSeusPregoes falhou:`, e.message);
    return stats;
  }

  const upsertExistente = db.prepare(
    `UPDATE pcp_pregoes
     SET numero=?, numero_longo=?, unidade=?, objeto=?, tipo_sigla=?, tipo_completo=?,
         abertura=?, situacao=?, ativo=?, atualizado_em=?
     WHERE chave_id=?`
  );
  const insertNovo = db.prepare(
    `INSERT INTO pcp_pregoes
     (chave_id, numero, numero_longo, unidade, objeto, tipo_sigla, tipo_completo,
      abertura, situacao, ativo, primeiro_visto_em, atualizado_em)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );

  for (const p of listagem.pregoes) {
    if (!p.chaveId) continue;
    const existente = db
      .prepare('SELECT chave_id, ativo FROM pcp_pregoes WHERE chave_id = ?')
      .get(p.chaveId);
    const ativo = FINALIZADAS_RE.test(p.situacao) ? 0 : 1;
    if (existente) {
      upsertExistente.run(
        p.numero, p.numeroLongo, p.unidade, p.objeto, p.tipoSigla, p.tipoCompleto,
        p.abertura, p.situacao, ativo, agora, p.chaveId
      );
      if (existente.ativo === 1 && ativo === 0) stats.finalizados++;
      stats.pregoesAtualizados++;
    } else {
      insertNovo.run(
        p.chaveId, p.numero, p.numeroLongo, p.unidade, p.objeto, p.tipoSigla, p.tipoCompleto,
        p.abertura, p.situacao, ativo, agora, agora
      );
      stats.pregoesNovos++;
      bootstrapBitmap.add(p.chaveId);
    }
  }

  // 2) Pra cada pregão ATIVO, busca chat (limita a 30 mais recentes pra controlar I/O)
  const ativos = db
    .prepare(
      `SELECT chave_id, ultimo_chat_id, numero, objeto, unidade
       FROM pcp_pregoes
       WHERE ativo = 1
       ORDER BY atualizado_em DESC
       LIMIT 30`
    )
    .all();

  const insertMsg = db.prepare(
    `INSERT INTO pcp_mensagens (chave_id, mensagem_id, data, hora, nome_remetente, texto)
     VALUES (?,?,?,?,?,?)`
  );
  const marcaTgEnviado = db.prepare(
    `UPDATE pcp_mensagens SET telegram_enviado_em = CURRENT_TIMESTAMP
     WHERE chave_id = ? AND mensagem_id = ?`
  );
  const updateUltimoChat = db.prepare(
    `UPDATE pcp_pregoes SET ultimo_chat_id = ?, atualizado_em = ? WHERE chave_id = ?`
  );

  for (const preg of ativos) {
    try {
      const url = `${APIPCP_BASE}/fornecedor/processo/${preg.chave_id}/chat?ultimaMsg=${preg.ultimo_chat_id}`;
      const r = await pcp.fetchPcpHtml(db, url);
      if (r.status !== 200) {
        stats.erros++;
        continue;
      }
      let json;
      try {
        json = JSON.parse(r.body);
      } catch {
        stats.erros++;
        continue;
      }
      if (!json.success || !Array.isArray(json.mensagens)) continue;

      const novas = json.mensagens
        .map((m) => ({ ...m, idNum: parseInt(m.id, 10) }))
        .filter((m) => Number.isFinite(m.idNum) && m.idNum > preg.ultimo_chat_id)
        .sort((a, b) => a.idNum - b.idNum);

      const ehBootstrap = bootstrapBitmap.has(preg.chave_id);
      let maxId = preg.ultimo_chat_id;

      for (const m of novas) {
        try {
          insertMsg.run(preg.chave_id, m.idNum, m.data, m.hora, m.nome, m.mensagem);
          stats.mensagensNovas++;
        } catch (e) {
          if (!/UNIQUE/i.test(e.message)) throw e;
        }

        if (m.idNum > maxId) maxId = m.idNum;

        // Telegram: pula só o bootstrap (histórico de pregão recém-descoberto).
        // Mensagens "Sistema" SÃO enviadas — no PCP os avisos acionáveis do
        // pregoeiro (proposta readequada, inabilitação, arrematante, recurso,
        // sessão finalizada) chegam todos com remetente "Sistema".
        if (enviarTelegram && !ehBootstrap) {
          const texto =
            `📢 <b>PCP — ${htmlEscape(preg.numero)}</b>\n` +
            `${htmlEscape((preg.unidade || '').slice(0, 80))}\n` +
            `<i>${htmlEscape((preg.objeto || '').slice(0, 120))}</i>\n\n` +
            `<b>${htmlEscape(m.nome)}</b> (${htmlEscape(m.data)} ${htmlEscape(m.hora)}):\n` +
            `${htmlEscape(m.mensagem)}\n\n` +
            `🔗 <a href="${OPERACAO_BASE}/4/SessaoPublica/?ttCD_CHAVE=${preg.chave_id}">Abrir sessão pública</a>`;
          try {
            const ok = await enviarTelegram(db, texto);
            if (ok) {
              marcaTgEnviado.run(preg.chave_id, m.idNum);
              stats.telegramEnviados++;
            }
          } catch (e) {
            console.error(`[PCP-monitor] telegram falhou: ${e.message}`);
          }
        }
      }

      if (maxId > preg.ultimo_chat_id) {
        updateUltimoChat.run(maxId, agora, preg.chave_id);
      }
    } catch (e) {
      stats.erros++;
      console.error(`[PCP-monitor] pregão ${preg.chave_id}:`, e.message);
    }
  }

  if (stats.pregoesNovos + stats.mensagensNovas + stats.telegramEnviados + stats.finalizados > 0) {
    console.log(
      `[PCP-monitor][${dbKey(db)}] novos=${stats.pregoesNovos} atualizados=${stats.pregoesAtualizados}` +
        ` finalizados=${stats.finalizados} msgs=${stats.mensagensNovas} tg=${stats.telegramEnviados} erros=${stats.erros}`
    );
  }
  return stats;
}

module.exports = { agendarPcpMonitor, pararPcpMonitor, sincronizarPcp };
