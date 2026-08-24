// alertas-disputa-vigilancia.js
//
// Serviço server-side (roda no master / scheduler.js) que vigia licitações
// EM DISPUTA e alerta no Telegram quando um item está aceitando lances mas
// (a) não há preço/piso configurado, ou (b) não temos lance efetivo
// (não lançamos, ou estamos perdendo).
//
// MOTIVAÇÃO: o alerta equivalente existente (`scanAlertas` em
// sniper-lance-routes.js) roda dentro do server.js e só cobre compras que já
// estão em `sniper_itens` — ou seja, itens já parcialmente preparados. O caso
// mais perigoso (proposta enviada, entrou em disputa, e ninguém configurou
// nada) passava despercebido e, na prática, só era notado ao ABRIR a página
// operacional/lances.html — que reidrata o estado ao vivo do Comprasnet.
// Este serviço fecha a lacuna: itera `participacoes_comprasnet` (proposta
// enviada) direto, sem depender de página aberta nem de sniper_itens.
//
// BEARER: lido do store durável `config.bearer_token` do pncp.db do tenant
// (escrito pelo server.js via _persistirToken, alimentado pelo
// govbr-bearer.service). Guard de frescor de 540s (TOKEN_SAFE_MARGIN_S). O
// scheduler é apenas leitor — não toca no SniperLance do server.js.
//
// Por-tenant: timers em Map<dbName, {...}> — nunca global
// (ver memória feedback_liciteagora_scheduler_pertenant).

const axios = require('axios');
const { tenantStorage } = require('./tenant-middleware');

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const API_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'x-device-platform': 'web',
  'x-version-number': '6.0.2',
  'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
};
const TOKEN_SAFE_MARGIN_S = 540; // idem sniper-lance.js — token mais velho não presta

const INTERVAL_MS = 60 * 1000;
const FIRST_DELAY_MS = 45 * 1000;

const timersByDb = new Map();   // dbName -> { first, interval, running }
const _alertados = new Set();   // dedup: `${slug}-${compraId}-${item}-${motivo}`

function dbKey(db) {
  return db.name || db.filename || 'unknown';
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const fmtR$ = (v) => (v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '—');

// Lê o Bearer fresco do store durável. Retorna "Bearer eyJ..." ou null.
function lerBearerFresco(db) {
  try {
    const tok = db.prepare("SELECT valor FROM config WHERE chave='bearer_token'").get();
    if (!tok || !tok.valor) return null;
    const ts = db.prepare("SELECT valor FROM config WHERE chave='bearer_timestamp'").get();
    const idadeS = ts && ts.valor ? (Date.now() - new Date(ts.valor).getTime()) / 1000 : Infinity;
    if (!(idadeS < TOKEN_SAFE_MARGIN_S)) return null;
    return tok.valor;
  } catch (_) {
    return null;
  }
}

// Canais de alerta: fonte única em notificacoes-dispatcher.js. Este arquivo
// mantinha uma cópia idêntica de lerAlertasConfig/enviarAlerta.
const { enviarAlerta } = require('./notificacoes-dispatcher');

// Preço/piso configurado para o item? Confere sniper_itens (valorMinimo) e
// config_lances (precoMinimo/desconto). Qualquer um vale como "tem preço".
function temPrecoConfigurado(db, part, itemNum) {
  try {
    const s = db.prepare(
      `SELECT valorMinimo FROM sniper_itens WHERE compraId = ? AND itemNumero = ? AND ativo = 1`
    ).get(part.compraId, itemNum);
    if (s && s.valorMinimo != null) return true;
  } catch (_) { /* schema ausente */ }
  try {
    const c = db.prepare(
      `SELECT precoMinimo, descontoPercentual, descontoFixo FROM config_lances
       WHERE cnpj = ? AND ano = ? AND sequencial = ? AND numeroItem = ? AND ativo = 1`
    ).get(part.cnpj, part.ano, part.sequencial, itemNum);
    if (c && (c.precoMinimo != null || c.descontoPercentual != null || c.descontoFixo != null)) return true;
  } catch (_) { /* schema ausente */ }
  return false;
}

// Valor do lado (nosso ou geral). Grupos/lotes usam valorCalculado; itens
// simples usam valorInformado (ver sniper-lance-routes.js:5385).
function valorDoLado(lado) {
  if (!lado) return null;
  if (lado.valorInformado != null) return lado.valorInformado;
  if (lado.valorCalculado != null) return lado.valorCalculado;
  return null;
}

async function _tick(slug, db) {
  const bearer = lerBearerFresco(db);
  if (!bearer) return; // sem token fresco não dá pra consultar disputa ao vivo

  // Escopo: participações com proposta enviada e recentes. Recência (via
  // dataAtualizacao/propostaEnviadaEm) discrimina disputa viva de histórica —
  // o Comprasnet não repopula datas de disputa nessas linhas, então não dá pra
  // filtrar por janela; recência é o sinal durável disponível.
  let participacoes;
  try {
    participacoes = db.prepare(`
      SELECT compraId, cnpj, ano, sequencial, orgao
      FROM participacoes_comprasnet
      WHERE ativo = 1
        AND propostaEnviadaEm IS NOT NULL
        AND (dataAtualizacao >= datetime('now', '-3 days')
             OR propostaEnviadaEm >= datetime('now', '-3 days'))
    `).all();
  } catch (_) {
    return; // schema ausente
  }
  if (!participacoes || participacoes.length === 0) return;

  for (const part of participacoes) {
    let resp;
    try {
      resp = await axios.get(
        `${BASE_URL}/comprasnet-disputa/v1/compras/${part.compraId}/itens/em-disputa`,
        { headers: { ...API_HEADERS, Authorization: bearer }, timeout: 10000, validateStatus: () => true }
      );
    } catch (_) {
      continue;
    }
    if (!(resp.status === 200 || resp.status === 206) || !Array.isArray(resp.data)) continue;

    for (const apiItem of resp.data) {
      if (!apiItem.podeEnviarLances) continue; // só itens realmente em disputa ao vivo
      const itemNum = apiItem.numero || apiItem.identificador;
      if (itemNum == null) continue;

      const temPreco = temPrecoConfigurado(db, part, itemNum);
      const melhorGeral = valorDoLado(apiItem.melhorValorGeral);
      const nossoValor = valorDoLado(apiItem.melhorValorFornecedor);
      const perdendo = apiItem.situacaoParticipanteDisputa === 'P';
      const semEfetividade = nossoValor == null || perdendo || (melhorGeral != null && nossoValor > melhorGeral);

      let motivo = null;
      if (!temPreco) motivo = 'sem_preco';
      else if (semEfetividade) motivo = 'sem_efetividade';
      if (!motivo) continue;

      const dedupKey = `${slug}-${part.compraId}-${itemNum}-${motivo}`;
      if (_alertados.has(dedupKey)) continue;
      _alertados.add(dedupKey);

      const fase = apiItem.fase || 'LA';
      const descrRaw = apiItem.descricao || apiItem.descricaoItem || '';
      const descr = descrRaw ? `\nDescr.: ${htmlEscape(descrRaw.slice(0, 90))}` : '';
      const orgaoLinha = part.orgao ? `\nÓrgão: ${htmlEscape(part.orgao)}` : '';

      let subject, mensagem;
      if (motivo === 'sem_preco') {
        subject = `[LiciteAgora] 🚨 Em disputa SEM preço — ${part.compraId} item ${itemNum}`;
        mensagem =
          `🚨 <b>EM DISPUTA SEM PREÇO CONFIGURADO</b>\n` +
          `Compra: <code>${part.compraId}</code>${orgaoLinha}\n` +
          `Item: <b>${itemNum}</b>${descr}\n` +
          `Fase: <b>${fase}</b>\n` +
          `Concorrente: <b>${fmtR$(melhorGeral)}</b>\n` +
          `Seu valor: <b>${fmtR$(nossoValor)}</b>\n\n` +
          `<i>O item está aceitando lances AGORA e não há preço/piso configurado. ` +
          `Configure o item ou o robô não terá como lançar.</i>`;
      } else {
        subject = `[LiciteAgora] 🚨 Em disputa sem lance efetivo — ${part.compraId} item ${itemNum}`;
        mensagem =
          `🚨 <b>EM DISPUTA SEM LANCE EFETIVO</b>\n` +
          `Compra: <code>${part.compraId}</code>${orgaoLinha}\n` +
          `Item: <b>${itemNum}</b>${descr}\n` +
          `Fase: <b>${fase}</b>\n` +
          `Concorrente: <b>${fmtR$(melhorGeral)}</b>\n` +
          `Seu valor: <b>${fmtR$(nossoValor)}</b>\n\n` +
          `<i>Você está participando mas ${nossoValor == null ? 'ainda não lançou' : 'não está com o melhor lance'}. ` +
          `Revise o piso/estratégia — sua proposta pode não estar competitiva.</i>`;
      }

      try {
        await enviarAlerta(db, { subject, body: mensagem, logTag: 'VigiaDisputa' });
        console.log(`[VigiaDisputa][${slug}] alerta ${motivo}: ${part.compraId} item ${itemNum} (melhor=${melhorGeral} nosso=${nossoValor})`);
      } catch (e) {
        console.error(`[VigiaDisputa][${slug}] enviarAlerta: ${e.message}`);
      }
    }
  }
}

// Agenda a vigilância para o tenant. Idempotente por db (Map guard). Chamado
// no boot pelo scheduler.js (ligarJobsPorTenant), dentro de tenantStorage.run.
function agendarAlertasDisputa(db, tenant) {
  const key = dbKey(db);
  if (timersByDb.has(key)) return;
  if (process.env.DISABLE_SCHEDULERS === '1') {
    timersByDb.set(key, { first: null, interval: null, running: false });
    return;
  }
  const slug = tenant && tenant.slug ? tenant.slug : key;

  const run = async () => {
    const entry = timersByDb.get(key);
    if (!entry || entry.running) return; // evita sobreposição de ticks
    entry.running = true;
    try {
      await tenantStorage.run({ kind: 'tenant', tenant: tenant || { slug }, db }, () => _tick(slug, db));
    } catch (e) {
      console.error(`[VigiaDisputa][${slug}] tick: ${e.message}`);
    } finally {
      entry.running = false;
    }
  };

  const first = setTimeout(run, FIRST_DELAY_MS);
  const interval = setInterval(run, INTERVAL_MS);
  if (first.unref) first.unref();
  if (interval.unref) interval.unref();

  timersByDb.set(key, { first, interval, running: false });
  console.log(`[VigiaDisputa][${slug}] agendado a cada ${INTERVAL_MS / 1000}s`);
}

function pararAlertasDisputa(db) {
  const key = dbKey(db);
  const t = timersByDb.get(key);
  if (!t) return;
  if (t.first) clearTimeout(t.first);
  if (t.interval) clearInterval(t.interval);
  timersByDb.delete(key);
}

module.exports = { agendarAlertasDisputa, pararAlertasDisputa };
