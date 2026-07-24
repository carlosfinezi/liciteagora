// chat-mensagens-ingest.js
//
// Captura server-side de mensagens do chat do Comprasnet, off o Bearer
// (endpoint /comprasnet-mensagem/v1/mensagens aceita só Bearer — sem captcha).
//
// Extraído do handler POST /api/sync/mensagens-global (sniper-lance-routes.js)
// para ser reaproveitado pela rota (worker) e por um job periódico no
// scheduler.js (master), que busca as mensagens e as ingere sem depender do
// Electron. Mantém dedup, palavras-chave e alertas Telegram idênticos.

const https = require('https');
const crypto = require('crypto');
const axios = require('axios');
const { buildCompraId } = require('./sniper-lance');

const BASE_URL = 'https://cnetmobile.estaleiro.serpro.gov.br';
const API_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'x-device-platform': 'web',
  'x-version-number': '6.0.2',
  'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
};
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });

// Decodifica o `exp` (epoch s) do payload de um JWT; null se não der.
function _jwtExp(token) {
  try {
    const raw = token.startsWith('Bearer ') ? token.slice(7) : token;
    const payload = JSON.parse(Buffer.from(raw.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch (_) { return null; }
}

/**
 * Busca a caixa global de mensagens do Comprasnet usando SÓ o Bearer.
 * Pagina até uma página vir com <50 itens ou até maxPages.
 * @returns {Promise<{ ok:boolean, status:(number|string), mensagens:Array, expired?:boolean, error?:string }>}
 */
async function fetchMensagensGlobais(bearerToken, { maxPages = 5 } = {}) {
  if (!bearerToken) return { ok: false, status: 0, mensagens: [] };

  const exp = _jwtExp(bearerToken);
  if (exp && exp * 1000 < Date.now()) return { ok: false, status: 401, mensagens: [], expired: true };

  const auth = bearerToken.startsWith('Bearer ') ? bearerToken : `Bearer ${bearerToken}`;
  const todas = [];
  for (let page = 0; page < maxPages; page++) {
    let resp;
    try {
      resp = await axios.get(
        `${BASE_URL}/comprasnet-mensagem/v1/mensagens?size=50&page=${page}`,
        { headers: { ...API_HEADERS, Authorization: auth }, timeout: 12000, validateStatus: () => true, httpsAgent: keepAliveAgent }
      );
    } catch (e) {
      return { ok: todas.length > 0, status: 'ERR', mensagens: todas, error: e.message };
    }
    // API responde 206 Partial Content com paginação
    if ((resp.status === 200 || resp.status === 206) && Array.isArray(resp.data)) {
      if (resp.data.length === 0) break;
      todas.push(...resp.data);
      if (resp.data.length < 50) break;
    } else {
      if (page === 0) return { ok: false, status: resp.status, mensagens: [] };
      break;
    }
  }
  return { ok: true, status: 200, mensagens: todas };
}

/**
 * Ingere um lote de mensagens globais no tenant: dedup, insert (schema correto),
 * avaliação de motivos e alertas Telegram. Idempotente (INSERT OR IGNORE + dedup
 * por mensagemIdComprasnet/hash).
 * @returns {Promise<{ novas:number, alertas:Array }>}
 */
async function ingerirMensagensGlobais(db, mensagens, { origemCaptura = 'extensao-v1', alertar = true } = {}) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) return { novas: 0, alertas: [] };

  // Obter CNPJ do fornecedor para detectar mensagens direcionadas
  let meuCnpj = '';
  try {
    const fornConfig = db.prepare('SELECT cnpj FROM fornecedor WHERE id = 1').get();
    meuCnpj = (fornConfig?.cnpj || '').replace(/\D/g, '');
    if (!meuCnpj) {
      const configVal = db.prepare("SELECT valor FROM config WHERE chave = 'fornecedor_cnpj'").get();
      meuCnpj = (configVal?.valor || '').replace(/\D/g, '');
    }
  } catch (e) {}

  let novas = 0;
  const alertas = [];

  // Carregar palavras-chave ativas do tenant uma vez (caches na ingestão do batch)
  let palavrasChaveAtivas = [];
  try {
    palavrasChaveAtivas = db.prepare("SELECT palavra FROM chat_palavras_chave WHERE ativo = 1").all()
      .map(r => String(r.palavra || '').toLowerCase()).filter(p => p.length >= 2);
  } catch (e) { /* tabela pode não existir */ }

  // Pregões silenciados pelo usuário — não geram alerta Telegram (captura segue normal)
  let silenciados = new Set();
  try {
    silenciados = new Set(db.prepare('SELECT compraId FROM chat_pregoes_silenciados').all().map(r => r.compraId));
  } catch (e) { /* tabela pode não existir */ }

  // Categorias do Comprasnet consideradas "importantes" para alerta Telegram.
  // 810 = impugnação / pedido esclarecimento
  // 820 = resposta / aviso do pregoeiro
  // 830 = convocação formal (anexos, propostas)
  // 840 = mensagem do agente de contratação (pregoeiro conduzindo a sessão)
  // 850 = ata / julgamento
  const CATEGORIAS_ALERTA = new Set(['810', '820', '830', '840', '850']);

  // Normaliza CNPJ (só dígitos). Também prepara variação formatada para busca.
  const meuCnpjDigits = meuCnpj; // já vem limpo acima
  const meuCnpjFormatado = meuCnpjDigits.length === 14
    ? `${meuCnpjDigits.substring(0,2)}.${meuCnpjDigits.substring(2,5)}.${meuCnpjDigits.substring(5,8)}/${meuCnpjDigits.substring(8,12)}-${meuCnpjDigits.substring(12,14)}`
    : '';

  const insertStmt = db.prepare(`INSERT OR IGNORE INTO chat_mensagens
    (compraId, cnpjOrgao, ano, sequencial, dataHoraMensagem,
     remetente, mensagem, hashMensagem, titulo, categoria,
     origemMensagem, lidaComprasnet, tipoCompra, excluida,
     vinculadaADiligencia, descricaoModalidade, numeroCompraFormatado,
     identificadorItem, mensagemIdComprasnet, origemCaptura, notificado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);

  for (const msg of mensagens) {
    // Montar compraId via helper centralizado (SNIPER-C01)
    const compraId = buildCompraId(msg);
    if (!compraId || compraId.length < 10) continue;
    const uasg = String(msg.numeroUasg || '').padStart(6, '0');

    const conteudo = msg.texto || '';
    const remetente = msg.remetente || '';
    const dataHora = msg.dataHoraPublicacao || new Date().toISOString();

    // Hash para deduplicação (fallback se não tiver id do Comprasnet)
    const hashMensagem = crypto.createHash('md5')
      .update(compraId + '|' + dataHora + '|' + remetente + '|' + conteudo)
      .digest('hex');

    // Se já temos pelo ID do Comprasnet, skip
    if (msg.id) {
      const existe = db.prepare('SELECT id FROM chat_mensagens WHERE mensagemIdComprasnet = ?').get(msg.id);
      if (existe) continue;
    }

    try {
      insertStmt.run(
        compraId,
        uasg,                               // cnpjOrgao (aqui é UASG, não CNPJ)
        parseInt(msg.anoCompra) || 0,        // ano
        parseInt(msg.numeroCompra) || 0,     // sequencial
        dataHora,
        remetente,
        conteudo,
        hashMensagem,
        msg.titulo || '',
        msg.categoria || '',
        msg.origemMensagem || '',
        msg.lida ? 1 : 0,
        msg.tipoCompra || '',
        msg.excluida ? 1 : 0,
        msg.vinculadaADiligencia ? 1 : 0,
        msg.descricaoModalidade || '',
        msg.numeroCompraFormatado || '',
        msg.identificadorItem || '',
        msg.id || null,
        origemCaptura
      );
      novas++;

      // Avalia motivos de alerta (qualquer match já qualifica)
      const motivos = [];
      const tituloMsg = msg.titulo || '';
      const conteudoLower = String(conteudo).toLowerCase();
      const tituloLower = tituloMsg.toLowerCase();
      const textoCombinado = conteudoLower + ' ' + tituloLower;

      if (CATEGORIAS_ALERTA.has(String(msg.categoria))) {
        motivos.push(`categoria ${msg.categoria}`);
      }
      if (msg.identificadorParticipante && meuCnpjDigits) {
        motivos.push('direcionada ao fornecedor');
      }
      if (meuCnpjDigits && (textoCombinado.includes(meuCnpjDigits) ||
          (meuCnpjFormatado && textoCombinado.includes(meuCnpjFormatado.toLowerCase())))) {
        motivos.push('menção ao CNPJ');
      }
      const palavrasMatch = palavrasChaveAtivas.filter(p => textoCombinado.includes(p));
      if (palavrasMatch.length) {
        motivos.push('palavra-chave');
      }

      if (motivos.length > 0 && !silenciados.has(compraId)) {
        alertas.push({
          conteudo, dataHora, compraId,
          titulo: tituloMsg,
          categoria: msg.categoria || '',
          motivos,
          palavrasMatch,
          mensagemId: msg.id || null,
          hashMensagem,
        });
      }
    } catch (e) {
      // Duplicate hash ou id — skip
    }
  }

  if (novas > 0) {
    console.log(`[Sync] Mensagens global: ${novas} novas (de ${mensagens.length})`);
  }

  // Enviar alertas Telegram para mensagens que bateram critérios.
  // alertar=false é usado no backfill inicial (catch-up) para não disparar
  // enxurrada de alertas de mensagens antigas — só daqui pra frente notifica.
  if (alertar && alertas.length > 0) {
    try {
      const telegramConfig = db.prepare('SELECT botToken, chatId FROM telegram_config WHERE id = 1 AND ativo = 1').get();
      if (telegramConfig?.botToken && telegramConfig?.chatId) {
        const stmtMarcarNotificado = db.prepare(
          `UPDATE chat_mensagens SET notificado = 1
           WHERE (mensagemIdComprasnet = ? AND ? IS NOT NULL)
              OR hashMensagem = ?`
        );
        for (const alerta of alertas) {
          const participacao = db.prepare('SELECT orgao, objeto FROM participacoes_comprasnet WHERE compraId = ?').get(alerta.compraId);
          const orgao = participacao?.orgao || alerta.compraId;
          const objeto = participacao?.objeto || '';

          const conteudoLimitado = alerta.conteudo.length > 500
            ? alerta.conteudo.substring(0, 500) + '…'
            : alerta.conteudo;

          const linhasExtras = [];
          if (alerta.palavrasMatch?.length) {
            linhasExtras.push(`🔔 <b>Palavras-chave:</b> ${alerta.palavrasMatch.join(', ')}`);
          }
          if (alerta.motivos?.length) {
            linhasExtras.push(`🏷️ <b>Motivos:</b> ${alerta.motivos.join(' · ')}`);
          }

          const texto = `🚨 <b>${alerta.titulo || 'MENSAGEM IMPORTANTE'}</b>\n\n` +
            `📋 <b>Compra:</b> ${alerta.compraId}\n` +
            `🏢 <b>Órgão:</b> ${orgao}\n` +
            (objeto ? `📝 <b>Objeto:</b> ${objeto.substring(0, 100)}${objeto.length > 100 ? '…' : ''}\n` : '') +
            `⏰ <b>Hora:</b> ${alerta.dataHora}\n` +
            (linhasExtras.length ? linhasExtras.join('\n') + '\n' : '') +
            `\n💬 ${conteudoLimitado}\n\n` +
            `⚠️ <b>VERIFIQUE NO COMPRASNET!</b>`;

          try {
            await axios.post(`https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`, {
              chat_id: telegramConfig.chatId,
              text: texto,
              parse_mode: 'HTML'
            });
            // Marca como notificado para evitar reenvio se Electron repostar
            try { stmtMarcarNotificado.run(alerta.mensagemId, alerta.mensagemId, alerta.hashMensagem); }
            catch (_) {}
            console.log(`[ALERTA] Telegram enviado: ${alerta.motivos.join('+')} em ${alerta.compraId}`);
          } catch (axiosErr) {
            console.error(`[ALERTA] Telegram falhou em ${alerta.compraId}: ${axiosErr.message}`);
          }
        }
      } else {
        console.log(`[ALERTA] ${alertas.length} alerta(s) candidatos mas Telegram não configurado/ativo neste tenant`);
      }
    } catch (telegramErr) {
      console.error('[ALERTA] Erro Telegram:', telegramErr.message);
    }
  }

  return { novas, alertas };
}

module.exports = { fetchMensagensGlobais, ingerirMensagensGlobais };
