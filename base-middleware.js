// base-middleware.js
//
// NFSE-M06 onda 6.39 (2026-04-20): middleware base do Express --
// CORS allow-list, body parsers (JSON + urlencoded com limit 10MB)
// e o static publico da pagina de login -- extraidos de server.js
// para este modulo. applyBaseMiddleware(app) registra 4 middlewares
// em sequencia; nao e re-entrant (chamar duas vezes duplica).
//
// Politica CORS (SEC-05, 2026-04-18):
//   - Sem Origin header (curl, Electron, scripts internos) -> allow
//   - http(s)://localhost[:port] -> allow (dev local)
//   - http(s)://(app.)liciteagora.com.br[:port] -> allow
//   - http(s)://server.votoaqui.com.br[:port] -> allow
//   - Qualquer outra origem: NAO envia headers CORS. O navegador
//     bloqueia naturalmente; clientes sem Origin (curl/Electron)
//     continuam funcionando. Evita respostas 500 visiveis para
//     origens desconhecidas.
//
// Body limit 10MB (antes 50mb em 2026-04-18): rotas de upload de
// XML/PFX usam esta faixa; uploads multipart tem limites proprios
// no multer.

const path = require('path');
const cors = require('cors');
const express = require('express');

const _corsAllow = (origin, cb) => {
  if (!origin) return cb(null, true); // curl, Electron, scripts — sem Origin
  if (/(^https?:\/\/localhost(:\d+)?$)/.test(origin)) return cb(null, true);
  if (/^https?:\/\/(app\.)?liciteagora\.com\.br(:\d+)?$/.test(origin)) return cb(null, true);
  if (/^https?:\/\/server\.votoaqui\.com\.br(:\d+)?$/.test(origin)) return cb(null, true);
  // Origem desconhecida: nao envia headers CORS.
  return cb(null, false);
};

function applyBaseMiddleware(app) {
  app.use(cors({ origin: _corsAllow, credentials: true }));
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ limit: '10mb', extended: true }));
}

/* Tela de login, favicons, manifest e service worker do ERP: públicos, na
   raiz, antes da barreira de autenticação.

   Até 2026-09-27 isto era montado junto do resto, ANTES do middleware de
   tenant. Saiu daqui porque a loja pode ser a página inicial do tenant, e aí
   o visitante não pode receber o favicon nem o manifest do ERP: quem decide
   isso precisa saber o tenant e a sessão, que ainda não existiam naquele
   ponto. Agora o auth-pipeline chama esta função depois da sessão e da
   vitrine (loja-routes.vitrineAntesDoLogin). Host desconhecido, que antes
   recebia a tela de login, recebe o 404 do middleware de tenant. */
function servirTelaDeLogin(app) {
  app.use(express.static(path.join(__dirname, 'public', 'auth')));
}

module.exports = { applyBaseMiddleware, servirTelaDeLogin };
