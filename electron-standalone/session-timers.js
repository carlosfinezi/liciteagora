'use strict';

/**
 * session-timers.js — Timers de manutenção de sessão para o Electron
 *
 * 5 timers complementares ao server-sync (2min) e lance-processor (5s):
 *   1. Mouse Simulation (20s)  — anti-idle contínuo no webview
 *   2. Session Refresh  (45s)  — detectar expiração sem reload
 *   3. Re-Login Timer   (90s)  — re-login proativo antes do token expirar
 *   4. Motor Principal  (7s)   — detectar mudanças de fase em disputas
 *   5. Chat Monitoring  (10s)  — polling rápido de mensagens (quase real-time)
 */

const TOKEN_MAX_AGE_MS = 540000;       // 9 min
const RELOGIN_THRESHOLD_MS = 480000;   // 8 min — dispara re-login
const RELOGIN_COOLDOWN_MS = 120000;    // 2 min entre tentativas

let _wv = null;           // webviewContents
let _getBearer = null;
let _getBearerTimestamp = null;
let _getActiveCompraIds = null;
let _isLanceProcessing = null;
let _log = console.log;

// Callbacks
let _onSessionExpired = null;
let _onNeedRelogin = null;
let _onChatAlert = null;

// State
const timers = {};
let lastReloginAt = 0;
let lastQtdes = {};            // motor: cache de qtdes por compraId
let lastMessageIds = new Set(); // chat: IDs já vistos
let chatFirstRun = true;        // chat: não alertar na primeira carga

// ─── Init ───────────────────────────────────────────────────────────────────

function init(opts) {
  _wv = opts.webviewContents;
  _getBearer = opts.getBearer;
  _getBearerTimestamp = opts.getBearerTimestamp;
  _getActiveCompraIds = opts.getActiveCompraIds;
  _isLanceProcessing = opts.isLanceProcessing || (() => false);
  _log = opts.log || console.log;
  _onSessionExpired = opts.onSessionExpired || (() => {});
  _onNeedRelogin = opts.onNeedRelogin || (() => {});
  _onChatAlert = opts.onChatAlert || (() => {});
}

function start() {
  _log('[Timers] Iniciando timers de sessão...');
  // DESABILITADOS: mouse simulation pode ser detectado como bot pelo hCaptcha
  // startMouseTimer();
  startRefreshTimer();
  startReLoginTimer();
  // Motor usa API HTTPS direta (não passa pelo webview) — seguro
  startMotorTimer();
  // Chat usa API HTTPS direta — seguro
  startChatTimer();
}

function stop() {
  Object.keys(timers).forEach(k => {
    clearInterval(timers[k]);
    delete timers[k];
  });
  _log('[Timers] Todos os timers parados');
}

// ─── 1. Mouse Simulation (20s) ─────────────────────────────────────────────

function startMouseTimer() {
  timers.mouse = setInterval(() => {
    if (!_wv || _wv.isDestroyed()) return;

    try {
      const url = _wv.getURL() || '';
      if (!url.includes('comprasnet') && !url.includes('serpro.gov.br')) return;

      const x = Math.floor(Math.random() * 600) + 50;
      const y = Math.floor(Math.random() * 400) + 50;

      // Variar o tipo de atividade aleatoriamente
      const acao = Math.random();

      if (acao < 0.5) {
        // Mousemove simples
        _wv.executeJavaScript(`
          document.dispatchEvent(new MouseEvent('mousemove', {
            clientX: ${x}, clientY: ${y}, bubbles: true
          }));
        `).catch(() => {});
      } else if (acao < 0.8) {
        // Scroll leve
        _wv.executeJavaScript(`
          window.scrollBy({ top: ${Math.random() > 0.5 ? 1 : -1}, behavior: 'smooth' });
          document.dispatchEvent(new MouseEvent('mousemove', {
            clientX: ${x}, clientY: ${y}, bubbles: true
          }));
        `).catch(() => {});
      } else {
        // Keypress inofensivo (Shift)
        _wv.executeJavaScript(`
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
          document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
        `).catch(() => {});
      }
    } catch {}
  }, 20000);
}

// ─── 2. Session Refresh (45s) ───────────────────────────────────────────────

function startRefreshTimer() {
  let running = false;

  timers.refresh = setInterval(async () => {
    if (running || !_wv || _wv.isDestroyed()) return;
    running = true;

    try {
      // Checkar idade do bearer
      const ts = _getBearerTimestamp();
      if (ts && (Date.now() - ts) > TOKEN_MAX_AGE_MS) {
        _log('[Timers] Bearer expirado (>9min) — sessão expirada');
        _onSessionExpired();
        return;
      }

      // Checkar HTML da página por indicadores de expiração
      const expired = await _wv.executeJavaScript(`
        (function() {
          var url = window.location.href.toLowerCase();
          var body = (document.body ? document.body.innerText : '').toLowerCase();

          // Redirecionou para login?
          if (url.includes('loginportal') || url.includes('acesso.gov.br/authorize')) return 'login_redirect';

          // Dialogs de sessão expirada?
          if (body.includes('sessão expirada') || body.includes('sessao expirada')) return 'sessao_expirada';
          if (body.includes('acesso não autorizado') || body.includes('acesso nao autorizado')) return 'nao_autorizado';

          // Input de login visível na página principal?
          var loginInput = document.querySelector('input[name="accountId"], input[name="cpf"]');
          if (loginInput && loginInput.offsetParent !== null) return 'login_form_visible';

          return null;
        })()
      `);

      if (expired) {
        _log(`[Timers] Sessão expirada detectada: ${expired}`);
        _onSessionExpired();
      }
    } catch (e) {
      // webview pode estar navegando — ignorar
    } finally {
      running = false;
    }
  }, 45000);
}

// ─── 3. Re-Login Timer (90s) ────────────────────────────────────────────────

function startReLoginTimer() {
  timers.relogin = setInterval(() => {
    const bearer = _getBearer();
    if (!bearer) return;

    const ts = _getBearerTimestamp();
    if (!ts) return;

    const elapsed = Date.now() - ts;
    if (elapsed < RELOGIN_THRESHOLD_MS) return;

    // Cooldown — não tentar se tentou recentemente
    if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return;

    _log(`[Timers] Bearer com ${Math.floor(elapsed / 60000)}min — disparando re-login proativo`);
    lastReloginAt = Date.now();
    _onNeedRelogin();
  }, 90000);
}

// ─── 4. Motor Principal (7s) ────────────────────────────────────────────────

function startMotorTimer() {
  let running = false;

  timers.motor = setInterval(async () => {
    if (running) return;
    if (!_getBearer()) return;

    // Pular se lance-processor está ativo (evita sobrecarga)
    if (_isLanceProcessing && _isLanceProcessing()) return;

    const compraIds = _getActiveCompraIds ? _getActiveCompraIds() : [];
    if (compraIds.length === 0) return;

    running = true;
    try {
      const cnet = require('./comprasnet-api');

      for (const compraId of compraIds) {
        const r = await cnet.comprasnetGet(
          `/comprasnet-disputa/v1/compras/${compraId}/itens/qtdes`
        );

        if (!r.ok && r.status !== 206) continue;

        const qtdes = r.data || {};
        const key = compraId;
        const prev = lastQtdes[key];

        if (prev) {
          // Detectar mudanças de fase
          const changed =
            prev.qtdeItensEmDisputa !== qtdes.qtdeItensEmDisputa ||
            prev.qtdeItensDisputaEncerrada !== qtdes.qtdeItensDisputaEncerrada ||
            prev.qtdeItensClassificados !== qtdes.qtdeItensClassificados;

          if (changed) {
            _log(`[Motor] Mudança detectada em ${compraId}: disputa=${qtdes.qtdeItensEmDisputa} enc=${qtdes.qtdeItensDisputaEncerrada}`);
            // Fetch completo e sync imediato
            try {
              const itensResult = await cnet.fetchItensCompra(compraId);
              if (itensResult.itens && itensResult.itens.length > 0) {
                const serverSync = require('./server-sync');
                const faseD = itensResult.fase;
                await serverSync.serverRequest('POST', '/api/sync/disputas', {
                  merge: true,
                  disputas: [{
                    compraId,
                    // Normalizar (antes mandava item cru → melhor/nosso achatados
                    // sumiam). Grupo: fallback p/ valorCalculado.
                    itens: itensResult.itens.map(i => {
                      const ehGrupo = i.tipo === 'G' || i.numero < 0;
                      const mg = i.melhorValorGeral || {};
                      const mf = i.melhorValorFornecedor || {};
                      return {
                        numero: i.numero,
                        tipo: i.tipo,
                        identificador: i.identificador ?? null,
                        descricao: i.descricao || '',
                        fase: i.fase || faseD,
                        situacao: i.situacao || '',
                        melhorValor: i.melhorLance?.valor ?? i.melhorValor ?? (ehGrupo ? (mg.valorInformado ?? mg.valorCalculado ?? null) : null),
                        nossoValor: i.valorInformado ?? i.nossoValor ?? (ehGrupo ? (mf.valorInformado ?? mf.valorCalculado ?? null) : null),
                        valorEstimado: i.valorEstimado ?? null,
                        situacaoParticipante: i.situacaoParticipante || i.situacaoParticipanteDisputa || '',
                        variacaoMinima: i.variacaoMinima ?? null,
                        podeEnviar: i.podeEnviar ?? i.podeEnviarLances ?? false,
                        fimContagem: i.fimContagem ?? null,
                        disputaPorValorUnitario: i.disputaPorValorUnitario ?? true,
                      };
                    }),
                    fase: itensResult.fase,
                  }],
                });
              }
            } catch (e) {
              _log(`[Motor] Erro sync disputa ${compraId}: ${e.message}`);
            }
          }
        }

        lastQtdes[key] = qtdes;
      }
    } catch (e) {
      _log(`[Motor] Erro: ${e.message}`);
    } finally {
      running = false;
    }
  }, 7000);
}

// ─── 5. Chat Monitoring (10s) — quase real-time ─────────────────────────────

function startChatTimer() {
  let running = false;

  timers.chat = setInterval(async () => {
    if (running) return;
    if (!_getBearer()) return;

    running = true;
    try {
      const cnet = require('./comprasnet-api');
      const result = await cnet.fetchMensagensGlobalPage0();

      if (!result.ok || result.mensagens.length === 0) return;

      const novas = [];
      for (const msg of result.mensagens) {
        if (msg.id && !lastMessageIds.has(msg.id)) {
          lastMessageIds.add(msg.id);
          if (!chatFirstRun) {
            novas.push(msg);
          }
        }
      }

      chatFirstRun = false;

      if (novas.length === 0) return;

      _log(`[Chat] ${novas.length} mensagens novas detectadas!`);

      // Enviar imediatamente ao servidor
      try {
        const serverSync = require('./server-sync');
        await serverSync.serverRequest('POST', '/api/sync/mensagens-global', {
          mensagens: novas,
        });
      } catch {}

      // Alertar para convocações e mensagens do agente
      const urgentes = novas.filter(m =>
        m.categoria === '830' ||  // convocação
        m.categoria === '840'     // mensagem do agente
      );

      if (urgentes.length > 0) {
        _log(`[Chat] ${urgentes.length} mensagens URGENTES (convocação/agente)!`);
        _onChatAlert(urgentes);
      }
    } catch (e) {
      _log(`[Chat] Erro: ${e.message}`);
    } finally {
      running = false;
    }
  }, 10000);
}

// ─── Limpar cache do motor (quando muda set de compras ativas) ──────────────

function resetMotorCache() {
  lastQtdes = {};
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  init,
  start,
  stop,
  resetMotorCache,
};
