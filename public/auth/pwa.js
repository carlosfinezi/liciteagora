/**
 * pwa.js — registra o service worker. Público, servido de `public/auth/`.
 *
 * Carregado nas DUAS portas de entrada do sistema: o login (`/login.html`) e o
 * shell (`/app.html`). As telas internas rodam dentro do shell, então quando
 * chegam nele o registro já aconteceu.
 *
 * ── Por que registrar também no login ───────────────────────────────────────
 *
 * O navegador só oferece "instalar" depois de ver manifest + service worker no
 * escopo. Quem não tem sessão cai no login antes de ver qualquer outra tela —
 * sem o registro ali, o app só ficaria instalável depois de entrar, e o convite
 * apareceria no meio do trabalho em vez de na porta.
 *
 * ── O que este arquivo deliberadamente não faz ──────────────────────────────
 *
 * Nada de `beforeinstallprompt`, banner próprio ou botão "instalar". O Chrome e
 * o Safari já oferecem instalação por conta própria, e um convite custom feito
 * antes de saber se ele faz falta é interface a mais para manter.
 *
 * E nada de `navigator.serviceWorker.controller.postMessage` ou sincronização:
 * o service worker desta fase guarda ícone e manifest, e só.
 */
(function registrarPWA() {
  if (!('serviceWorker' in navigator)) return;          // navegador antigo: segue sem PWA

  // `localhost` é tratado como origem segura pelos navegadores; em produção o
  // ERP é HTTPS. Fora desses dois casos o registro falharia — não tenta.
  var seguro = self.isSecureContext
    || location.protocol === 'https:'
    || location.hostname === 'localhost';
  if (!seguro) return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (e) {
      // Falhar aqui não pode atrapalhar quem só quer usar o sistema: sem service
      // worker o ERP funciona igual, apenas não fica instalável.
      console.warn('[pwa] service worker não registrou (o ERP segue normal):', e && e.message);
    });
  });
})();
