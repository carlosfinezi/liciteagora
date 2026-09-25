/**
 * sw.js — service worker do Licite Agora.
 *
 * ⚠️ ESTE ARQUIVO RODA FORA DA SESSÃO E VÊ TODAS AS REQUISIÇÕES DO ERP.
 * Um erro aqui não quebra uma tela: vaza dado de um tenant para o disco do
 * aparelho, ou serve resposta de um usuário para outro. Leia a política antes
 * de acrescentar qualquer coisa.
 *
 * ── O que ele faz ───────────────────────────────────────────────────────────
 *
 * Uma coisa só: guarda uma LISTA FECHADA de arquivos estáticos públicos, para
 * que o navegador reconheça o site como instalável e a moldura do app abra sem
 * depender da rede.
 *
 * ── O que ele NÃO faz, e por quê ────────────────────────────────────────────
 *
 * **Não intercepta nada que não esteja na lista.** A decisão é por allowlist,
 * não por exclusão: se um caminho não foi escrito aqui embaixo, o `fetch` nem
 * chama `respondWith` — a requisição segue para a rede como se o service worker
 * não existisse. Uma lista de exclusão ("não cacheie /api/") é o desenho errado
 * para isto, porque o dia em que alguém criar `/relatorios/` ou `/export/`, o
 * SW passaria a cachear sem ninguém decidir.
 *
 * Consequências diretas da allowlist, todas verificadas em `test-pwa.js`:
 *
 *   - `/api/*` nunca é tocado — nem lido do cache, nem gravado;
 *   - nada autenticado é gravado: as telas do ERP (`/comercial/…`, `/js/…`,
 *     `/css/…`) exigem sessão e ficam de fora da lista de propósito;
 *   - resposta com `Set-Cookie`, redirecionamento de login e qualquer coisa que
 *     não seja 200 nunca entram no cache;
 *   - requisição que não é GET passa direto.
 *
 * **Não faz offline de dados.** Não há fila, não há banco local, não há pedido
 * criado sem rede. Sem conexão, o app abre e as telas falham como falhariam no
 * navegador — que é o comportamento honesto enquanto não houver sincronização
 * pensada.
 *
 * ── Multi-tenant ────────────────────────────────────────────────────────────
 *
 * O cache do navegador já é separado por origem, e cada tenant é um subdomínio
 * (`<slug>.liciteagora.app`). Dois tenants nunca compartilham este cache. Ainda
 * assim, a lista só tem arquivo que é igual para todos — marca e ícone.
 */

const VERSAO = 'licite-v1';

/**
 * A lista fechada. Todos são públicos (servidos por `public/auth/`, antes da
 * barreira de autenticação) e iguais para qualquer usuário de qualquer tenant.
 *
 * `/` NÃO entra: ela responde 302 para o login ou 200 com o shell, conforme a
 * sessão — exatamente o tipo de resposta que não pode ser congelada.
 */
const ESTATICOS = [
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icone-192.png',
  '/icone-512.png',
  '/icone-maskable-192.png',
  '/icone-maskable-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  // `addAll` falha inteiro se um arquivo faltar; aqui cada um é opcional, para
  // que um 404 isolado não impeça a instalação do app.
  e.waitUntil(
    caches.open(VERSAO)
      .then((c) => Promise.all(ESTATICOS.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  // Cache de versão antiga não fica para trás: é o que evita servir um ícone
  // ou um manifest velho depois de uma troca de identidade.
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Só GET. POST/PUT/DELETE mudam estado e não têm o que ser servido de cache.
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Outra origem (Google Fonts, CDN do Lucide): não é nosso, não gerenciamos.
  if (url.origin !== self.location.origin) return;

  // A ALLOWLIST. Fora dela, o service worker não existe para esta requisição.
  if (!ESTATICOS.includes(url.pathname)) return;

  e.respondWith(
    caches.match(req).then((cacheado) => {
      if (cacheado) return cacheado;
      return fetch(req).then((resp) => {
        // Só 200 simples entra. `type: 'basic'` exclui opaque/CORS; o teste de
        // Set-Cookie é cinto e suspensório — um estático não deveria ter um,
        // e se tiver, alguma coisa está errada o bastante para não cachear.
        if (!resp || resp.status !== 200 || resp.type !== 'basic') return resp;
        if (resp.headers.get('Set-Cookie')) return resp;
        const copia = resp.clone();
        caches.open(VERSAO).then((c) => c.put(req, copia)).catch(() => {});
        return resp;
      });
    })
  );
});

/* ==========================================================================
   Pop-up de mensagem nova (Web Push) — 2026-09-17
   ==========================================================================

   A allowlist acima continua valendo: nada disto cacheia nada, e o `fetch`
   daqui é sempre de rede.

   O push chega VAZIO, de propósito — o conteúdo da conversa não passa pelo
   servidor de push da Google nem da Mozilla (ver `push-web.js`). Quem monta o
   texto é este arquivo, buscando `/api/push/pendentes` com a sessão da própria
   pessoa. Sem sessão válida, não há o que mostrar além do aviso genérico, e é
   assim que tem de ser: o service worker não tem privilégio nenhum que o
   usuário já não tenha.
*/

const PUSH_TAG = 'liciteagora-mensagem';

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let itens = [];
    try {
      const r = await fetch('/api/push/pendentes', { credentials: 'include', cache: 'no-store' });
      if (r.ok) itens = (await r.json()).itens || [];
    } catch (_) { /* sem rede ou sem sessão: cai no aviso genérico abaixo */ }

    // Com o ERP ABERTO na frente da pessoa, a notificação do sistema é ruído em
    // cima de uma tela que já vai mostrar o aviso. Manda-se o recado para a aba
    // e não se notifica — a menos que ela esteja aberta mas escondida.
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visivel = abas.find((c) => c.visibilityState === 'visible');
    if (visivel) {
      for (const c of abas) c.postMessage({ tipo: 'mensagem-nova', itens });
      return;
    }

    const primeiro = itens[0];
    const titulo = primeiro ? primeiro.quem : 'Mensagem nova';
    const corpo = primeiro
      ? (primeiro.trecho || 'Mandou uma mensagem')
        + (itens.length > 1 ? ` · e mais ${itens.length - 1}` : '')
      : 'Chegou mensagem no WhatsApp';

    await self.registration.showNotification(titulo, {
      body: corpo,
      icon: '/icone-192.png',
      badge: '/icone-192.png',
      // `tag` igual faz a notificação SUBSTITUIR a anterior. Sem isso, meia hora
      // de ausência devolve uma pilha de avisos para fechar um a um.
      tag: PUSH_TAG,
      renotify: true,
      data: { conversaId: primeiro ? primeiro.conversaId : null },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const destino = '/app.html#/comunicacao/conversas.html';
  e.waitUntil((async () => {
    // Reaproveita uma aba do ERP se já houver uma: abrir a segunda faria a
    // pessoa perder o que estava fazendo na primeira.
    const abas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const doErp = abas.find((c) => c.url.includes('/app.html'));
    if (doErp) {
      await doErp.focus();
      doErp.postMessage({ tipo: 'abrir-conversas', conversaId: e.notification.data?.conversaId || null });
      return;
    }
    await self.clients.openWindow(destino);
  })());
});
