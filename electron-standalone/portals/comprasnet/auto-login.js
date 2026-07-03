'use strict';

/**
 * portals/comprasnet/auto-login.js — Login automático via SSO gov.br.
 *
 * Extraído de electron-browser.js (lines 1041-1499). Comportamento idêntico
 * ao código inline anterior — só foi modularizado.
 *
 * Inclui:
 *   - autoLogin(cpf, senha)             passos 0-11 do SSO gov.br
 *   - autoLoginFromDB()                 lê creds (DB local OU servidor) → autoLogin
 *   - attemptAutoRelogin()              cooldown 2min entre tentativas
 *   - readCredentialsFromDB()           sqlite3 CLI (legado pre-multi-tenant)
 *   - readCredentialsFromServer()       fetch /api/electron/credentials
 *
 * Cooldown: 2 min entre relogins, evita loops em falhas crônicas.
 *
 * Uso:
 *   const al = require('./auto-login').create({ ctx, utils });
 *   al.autoLogin(cpf, senha);
 *   al.autoLoginFromDB();
 *   al.attemptAutoRelogin();
 *
 * `ctx` precisa expor:
 *   log, getWebview(),
 *   getState(), setState(s, opts), getBearer(), getBearerTimestamp(),
 *   tokenFresco(), saveBearer(token), startServerIntegration(),
 *   serverSync (módulo inteiro — usa reviverSSO + marcarSSOmorto),
 *   userDataDir, dbPath, getApiKey(), setApiKey(k), getServerUrl(),
 *   startLogSync()
 */

const RELOGIN_COOLDOWN_MS = 120000; // 2 min entre tentativas

function create({ ctx, utils }) {
  const { sleep, humanDelay, humanType, humanClick, waitForURL, waitForSelector, warmupProfile } = utils;

  function getWV() {
    const wv = ctx.getWebview();
    if (!wv) throw new Error('Webview não disponível');
    return wv;
  }

  // Limpa SÓ os cookies do comprasnet.gov.br antes de um re-login (partition
  // dedicada; BNC usa sesBnc separada, não é afetada). Quando a sessão SSO
  // expira, o cookie residual do Comprasnet faz o loginPortal.asp redirecionar
  // para intro.htm — página sem o botão "Entrar com Gov.br" — e o re-login
  // falha em loop ("Botão Entrar não encontrado"). Limpar esse cookie força o
  // loginPortal.asp a exibir o formulário de login de novo.
  //
  // IMPORTANTE: NÃO usar clearStorageData({storages:['cookies']}) — aquilo
  // apaga TODOS os cookies da partition, inclusive os de acesso.gov.br, que
  // são o "device trust" do gov.br. Sem esse trust o sso.acesso.gov.br exibe
  // hCaptcha na tela de login. Removemos cookie a cookie só do comprasnet.gov.br.
  async function limparSessaoComprasnet() {
    try {
      const wv = getWV();
      const cookies = await wv.session.cookies.get({});
      for (const c of cookies) {
        const dom = (c.domain || '').replace(/^\./, '');
        if (!dom.endsWith('comprasnet.gov.br')) continue; // preserva acesso.gov.br/gov.br
        const url = `${c.secure ? 'https' : 'http'}://${dom}${c.path || '/'}`;
        try { await wv.session.cookies.remove(url, c.name); } catch (_) {}
      }
      ctx.log('Cookies do Comprasnet limpos (trust gov.br preservado)');
    } catch (e) {
      ctx.log(`Falha ao limpar sessão Comprasnet: ${e.message}`);
    }
  }

  // Recuperação de profile FLAGRADO pelo hCaptcha (gov.br exibindo o desafio
  // VISÍVEL → "campo de senha não apareceu"). Diferente do limparSessaoComprasnet
  // (cirúrgico, preserva o trust): aqui o trust já é inútil porque o gov.br está
  // desafiando de qualquer jeito. Limpamos TUDO da partition Comprasnet (cookies +
  // storages + cache) pra resetar o fingerprint/reputação — é o que faz o hCaptcha
  // invisible voltar a auto-resolver (equivale a deletar o .electron-profile).
  // BNC usa persist:bnc separada, não é afetada.
  async function resetProfileComprasnet() {
    try {
      const wv = getWV();
      await wv.session.clearStorageData(); // sem filtro: todos storages, todas origens
      try { await wv.session.clearCache(); } catch (_) {}
      ctx.log('Profile Comprasnet RESETADO (recuperação hCaptcha — fingerprint limpo)');
    } catch (e) {
      ctx.log(`Falha ao resetar profile Comprasnet: ${e.message}`);
    }
  }

  // Falhas consecutivas no hCaptcha (campo de senha nunca aparece = profile
  // flagrado). Ao atingir o limiar, o próximo autoLogin reseta o profile pra
  // recuperar o auto-resolve do hCaptcha invisible — sem exigir login manual.
  let hcaptchaFails = 0;

  // ─── autoLogin: passos 0-11 do SSO gov.br ─────────────────────────────
  async function autoLogin(cpf, senha, opts = {}) {
    const wv = getWV();
    ctx.setState('logging_in');
    ctx.log('═══ LOGIN AUTOMÁTICO (human-like) ═══');
    ctx.log(`CPF: ${cpf.substring(0, 3)}...`);

    try {
      // 0a. Recuperação automática: se as últimas tentativas travaram no hCaptcha
      // (campo de senha nunca aparece), o profile está flagrado pelo gov.br. Reset
      // total da partition → fingerprint limpo → o hCaptcha invisible volta a
      // auto-resolver, sem login manual. Supera o clearSession cirúrgico.
      if (hcaptchaFails >= 2) {
        ctx.log(`hCaptcha travou ${hcaptchaFails}x seguidas — resetando profile Comprasnet`);
        await resetProfileComprasnet();
        hcaptchaFails = 0;
      } else if (opts.clearSession) {
        // Re-login: limpar cookies da sessão morta ANTES de navegar, senão o
        // loginPortal.asp quica para intro.htm e não há botão Gov.br pra clicar.
        await limparSessaoComprasnet();
      }

      // 0. Warmup se perfil novo
      await warmupProfile(wv, ctx.userDataDir, ctx.log);

      // 1. Navegar ao loginPortal.asp
      ctx.log('Passo 1: Navegando ao loginPortal.asp...');
      wv.loadURL('https://comprasnet.gov.br/seguro/loginPortal.asp');
      await humanDelay(3000, 4000);

      const currentUrl = wv.getURL();
      if (currentUrl.includes('cnetmobile') && !currentUrl.includes('acesso-nao-autorizado')) {
        ctx.log('Já está logado! (sessão anterior válida)');
        ctx.setLoggedIn();
        return { success: true, message: 'Sessão anterior válida' };
      }

      // 2. Expandir card "Fornecedor" e clicar "Entrar com Gov.br"
      ctx.log('Passo 2: Expandindo card Fornecedor...');
      await humanDelay(1500, 2500);

      await wv.executeJavaScript(`
        (function() {
          if (typeof mudaPerfilBotao === 'function') {
            mudaPerfilBotao(1);
            return 'mudaPerfilBotao(1)';
          }
          const btn = document.querySelector('button.fornecedor, button.expand.fornecedor');
          if (btn) { btn.click(); return 'button.fornecedor'; }
          return null;
        })()
      `).catch(e => null);
      ctx.log('Card Fornecedor expandido');
      await humanDelay(1500, 2500);

      ctx.log('Clicando em Entrar com Gov.br...');
      const clicked = await wv.executeJavaScript(`
        (function() {
          const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
          const govBtn = els.find(el => {
            const text = (el.textContent || el.value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
            return (text.includes('entrar') && text.includes('gov')) || text === 'entrar';
          });
          if (govBtn) {
            govBtn.click();
            return (govBtn.textContent || govBtn.value || '').trim().substring(0, 80);
          }
          const ssoLink = document.querySelector('a[href*="acesso.gov.br"], a[href*="loginPortalFornecedor"]');
          if (ssoLink) {
            ssoLink.click();
            return 'href: ' + ssoLink.href.substring(0, 80);
          }
          const card = document.querySelector('.fornecedor-card, .card.fornecedor, [class*="fornecedor"]');
          if (card) {
            const btn = card.querySelector('a, button');
            if (btn) { btn.click(); return 'card btn: ' + (btn.textContent || btn.href || '').substring(0, 80); }
          }
          // ── DIAGNÓSTICO (temporário): o seletor falhou; dump da página real ──
          const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
          const candidatos = els.slice(0, 30).map(el =>
            el.tagName.toLowerCase()
            + ' | txt="' + clean(el.textContent || el.value).substring(0, 50) + '"'
            + ' | href="' + clean(el.getAttribute && el.getAttribute('href')).substring(0, 70) + '"'
            + ' | class="' + clean(el.className).substring(0, 50) + '"'
            + ' | id="' + clean(el.id) + '"'
          );
          const cardEl = document.querySelector('[class*="fornecedor"], .card, [class*="perfil"], [class*="login"]');
          return {
            __diag: true,
            url: location.href,
            title: clean(document.title),
            totalEls: els.length,
            candidatos: candidatos,
            cardHtml: cardEl ? clean(cardEl.outerHTML).substring(0, 600) : '(nenhum card encontrado)',
          };
        })()
      `).catch(e => ({ __diag: true, erro: String(e && e.message || e) }));

      if (clicked && typeof clicked === 'string') {
        ctx.log('Clicou em: ' + clicked);
      } else {
        ctx.log('Botão Entrar não encontrado após expandir — erro');
        // Dump diagnóstico para o heartbeat (lido via /api/electron/status).
        try {
          const d = clicked || {};
          if (d.erro) ctx.log('[DIAG] erro executeJS: ' + d.erro);
          ctx.log('[DIAG] url=' + (d.url || '?') + ' | titulo=' + (d.title || '?') + ' | totalEls=' + (d.totalEls != null ? d.totalEls : '?'));
          (d.candidatos || []).forEach((c, i) => ctx.log('[DIAG] el#' + i + ' ' + c));
          if (d.cardHtml) ctx.log('[DIAG] cardHtml: ' + d.cardHtml);
        } catch (_) { /* não bloquear o fluxo por falha de diagnóstico */ }
        ctx.setState('error');
        return { success: false, message: 'Botão Entrar com Gov.br não encontrado' };
      }

      // 3. Aguardar SSO gov.br
      ctx.log('Passo 3: Aguardando SSO gov.br...');
      await waitForURL(wv, 'acesso.gov.br', 30000);
      ctx.log('Página SSO carregada: ' + wv.getURL());

      const hcaptchaWait = 6000 + Math.random() * 2000;
      ctx.log(`Aguardando ${Math.round(hcaptchaWait / 1000)}s para hCaptcha carregar...`);
      await sleep(hcaptchaWait);

      // 4. Preencher CPF
      ctx.log('Passo 4: Digitando CPF (human-like)...');
      const cpfSelector = 'input[name="accountId"], input#accountId, input[inputmode="numeric"], input[type="text"]';
      await waitForSelector(wv, cpfSelector, 15000);

      const resolvedCpfSelector = await wv.executeJavaScript(`
        (function() {
          const selectors = ['input[name="accountId"]', 'input#accountId', 'input[inputmode="numeric"]', 'input[type="text"]'];
          for (const s of selectors) {
            if (document.querySelector(s)) return s;
          }
          return null;
        })()
      `);

      if (!resolvedCpfSelector) {
        ctx.setState('error');
        return { success: false, message: 'Campo CPF não encontrado' };
      }

      await humanClick(wv, resolvedCpfSelector);
      await humanDelay(300, 600);
      await humanType(wv, resolvedCpfSelector, cpf);
      ctx.log('CPF digitado');
      await humanDelay(800, 1500);

      // 5. Continuar
      ctx.log('Passo 5: Clicando Continuar...');
      const continuarClicked = await wv.executeJavaScript(`
        (function() {
          const btn = document.querySelector('button[type="submit"]')
            || document.querySelector('input[type="submit"]')
            || document.querySelector('.btn-primary')
            || Array.from(document.querySelectorAll('button')).find(b => {
              const t = (b.textContent || '').toLowerCase();
              return t.includes('continuar') || t.includes('avançar') || t.includes('entrar');
            });
          if (!btn) return null;
          const rect = btn.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          btn.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseover', { clientX: x, clientY: y, bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
          btn.click();
          return (btn.textContent || btn.value || 'submit').trim().substring(0, 40);
        })()
      `);
      ctx.log(`Continuar clicado: ${continuarClicked || '?'}`);

      // 6. Aguardar campo de senha
      ctx.log('Passo 6: Aguardando campo de senha...');
      let senhaEncontrada = false;
      for (let i = 0; i < 40; i++) {
        const pageState = await wv.executeJavaScript(`
          (function() {
            return {
              temSenha: !!document.querySelector('input[type="password"]'),
              url: window.location.href,
              erro: (document.querySelector('.msg-erro, .alert-danger, [class*="error"], [class*="erro"]') || {}).textContent || null,
            };
          })()
        `).catch(() => ({ temSenha: false }));

        if (pageState.temSenha) {
          senhaEncontrada = true;
          ctx.log('Campo de senha encontrado!');
          break;
        }

        // Já redirecionou ao Comprasnet (SSO válido)
        if (pageState.url && pageState.url.includes('cnetmobile') && !pageState.url.includes('acesso-nao-autorizado')) {
          ctx.log('Redirecionou direto ao Comprasnet (SSO válido)!');
          hcaptchaFails = 0;
          ctx.setLoggedIn();
          return { success: true, message: 'SSO válido, login automático' };
        }

        if (pageState.erro && i % 5 === 0) {
          ctx.log(`Info página: ${(pageState.erro || '').substring(0, 100)}`);
        }

        await sleep(1000);
      }

      if (!senhaEncontrada) {
        const url = wv.getURL();
        hcaptchaFails++;
        ctx.log(`Campo de senha não apareceu após 40s (hCaptcha #${hcaptchaFails}). URL: ${url}`);
        ctx.setState('connected');
        return { success: false, message: 'Campo de senha não apareceu', url };
      }

      // 7. Senha
      ctx.log('Passo 7: Digitando senha (human-like)...');
      await humanClick(wv, 'input[type="password"]');
      await humanDelay(300, 600);
      await humanType(wv, 'input[type="password"]', senha);
      ctx.log('Senha digitada');
      await humanDelay(800, 1500);

      // 8. Entrar
      ctx.log('Passo 8: Clicando Entrar...');
      await wv.executeJavaScript(`
        (function() {
          const btn = document.querySelector('button[type="submit"]')
            || document.querySelector('input[type="submit"]')
            || Array.from(document.querySelectorAll('button')).find(b => {
              const t = (b.textContent || '').toLowerCase();
              return t.includes('entrar') || t.includes('acessar') || t.includes('login');
            });
          if (!btn) throw new Error('Botão Entrar não encontrado');
          const rect = btn.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          btn.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
          btn.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
          btn.click();
          return true;
        })()
      `);
      ctx.log('Entrar clicado');

      // 9. Aguardar redirect pós-login
      ctx.log('Passo 9: Aguardando redirecionamento pós-login...');
      {
        const redirectStart = Date.now();
        const REDIRECT_TIMEOUT = 60000;

        while (Date.now() - redirectStart < REDIRECT_TIMEOUT) {
          const url = wv.getURL();

          if (url.includes('comprasnet.gov.br/intro') || url.includes('comprasnet.gov.br/main') ||
              (url.includes('comprasnet.gov.br/seguro/') && !url.includes('loginPortal') && !url.includes('landing_sso'))) {
            ctx.log(`Login OK — chegou em: ${url.substring(0, 80)}`);
            break;
          }

          if (url.includes('cnetmobile') && !url.includes('acesso-nao-autorizado')) {
            ctx.log('Redirecionado direto ao cnetmobile!');
            break;
          }

          await sleep(500);
        }
      }

      // 10. Abrir dispensa_eletronica.asp
      ctx.log('Passo 10: Abrindo Licitação e Dispensa via portal...');
      await sleep(3000); // Esperar popup.asp?ambiente=3

      await wv.executeJavaScript(`
        try {
          frames[1].location.href = '/assinadas/dispensa_eletronica.asp';
        } catch(e) {
          window.open('https://comprasnet.gov.br/assinadas/dispensa_eletronica.asp', '_blank');
        }
      `).catch(() => null);
      ctx.log('dispensa_eletronica.asp aberto');

      // 11. Aguardar Bearer
      ctx.log('Passo 11: Aguardando Bearer do popup cnetmobile...');
      for (let i = 0; i < 30; i++) {
        if (ctx.getState() === 'logged_in') {
          hcaptchaFails = 0;
          ctx.log('══ LOGIN CONCLUÍDO COM SUCESSO! ══');
          return { success: true, message: 'Login OK', bearerAge: 0 };
        }
        await sleep(1000);
      }

      // Se Bearer foi capturado mas state ainda não virou
      if (ctx.getBearer()) {
        hcaptchaFails = 0;
        ctx.setLoggedIn();
        ctx.log('══ LOGIN CONCLUÍDO COM SUCESSO! (Bearer detectado) ══');
        ctx.startServerIntegration();
        return { success: true, message: 'Login OK' };
      }

      ctx.setState('connected');
      ctx.log('Login aparenta OK mas Bearer não capturado. Navegue ao cnetmobile manualmente.');
      return { success: false, message: 'Bearer não capturado' };

    } catch (e) {
      ctx.log(`Erro no login automático: ${e.message}`);
      ctx.setState('error');
      return { success: false, message: e.message };
    }
  }

  // ─── Credenciais: DB local (sqlite3 CLI) ──────────────────────────────
  function readCredentialsFromDB() {
    try {
      const { execSync } = require('child_process');
      const dbPath = ctx.dbPath;
      const cpf = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave = 'comprasnet_usuario'"`, { encoding: 'utf8' }).trim();
      const senha = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave = 'comprasnet_senha'"`, { encoding: 'utf8' }).trim();
      if (cpf && senha) return { cpf, senha };
      const cpf2 = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave = 'govbr_cpf'"`, { encoding: 'utf8' }).trim();
      const senha2 = execSync(`sqlite3 "${dbPath}" "SELECT valor FROM config WHERE chave = 'govbr_senha'"`, { encoding: 'utf8' }).trim();
      if (cpf2 && senha2) return { cpf: cpf2, senha: senha2 };
      return null;
    } catch (e) {
      return null; // DB local não existe (Windows standalone)
    }
  }

  // ─── Credenciais: servidor LiciteAgora ────────────────────────────────
  async function readCredentialsFromServer() {
    try {
      const headers = {};
      const apiKey = ctx.getApiKey();
      if (apiKey) headers['X-Api-Key'] = apiKey;

      const data = await new Promise((resolve, reject) => {
        const url = `${ctx.getServerUrl()}/api/electron/credentials`;
        const mod = url.startsWith('https') ? require('https') : require('http');
        const req = mod.get(url, { timeout: 10000, headers }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      });

      if (data && data.cpf && data.senha) {
        ctx.log(`Credenciais obtidas do servidor (CPF: ${data.cpf.substring(0, 3)}...)`);
        if (data.apiKey) {
          ctx.setApiKey(data.apiKey);
          ctx.log(`API Key do servidor: ${data.apiKey.substring(0, 8)}...`);
        }
        return { cpf: data.cpf, senha: data.senha };
      }
      return null;
    } catch (e) {
      ctx.log(`Servidor não respondeu credenciais: ${e.message}`);
      return null;
    }
  }

  // ─── autoLoginFromDB: orquestrador ───────────────────────────────────
  async function autoLoginFromDB() {
    if (ctx.getState() === 'logged_in') return;

    // Ler API key do banco se não foi passada como argumento
    if (!ctx.getApiKey()) {
      try {
        const { execSync } = require('child_process');
        const key = execSync(`sqlite3 "${ctx.dbPath}" "SELECT valor FROM config WHERE chave = 'api_key'"`, { encoding: 'utf8' }).trim();
        if (key) { ctx.setApiKey(key); ctx.log(`API Key lida do banco: ${key.substring(0, 8)}...`); }
      } catch {}
    }

    let creds = readCredentialsFromDB();

    if (!creds) {
      ctx.log('DB local não encontrado — buscando credenciais do servidor...');
      creds = await readCredentialsFromServer();
    }

    if (ctx.getApiKey()) ctx.startLogSync();

    if (!creds) {
      ctx.log('Credenciais não encontradas (nem local, nem servidor). Faça login manual pela janela.');
      return;
    }

    ctx.log(`Credenciais encontradas no banco (CPF: ${creds.cpf.substring(0, 3)}...). Iniciando auto-login em 5s...`);
    await sleep(5000);

    let result = await autoLogin(creds.cpf, creds.senha);
    if (result.success) {
      ctx.log('Auto-login do banco: SUCESSO');
      return;
    }

    // Retry com recuperação AUTOMÁTICA: cada falha no hCaptcha incrementa o
    // contador; ao chegar em 2 o próprio autoLogin reseta o profile (fingerprint
    // limpo) → o hCaptcha invisible volta a auto-resolver. Sem login manual. Como
    // o re-login por timer só roda com bearer presente, o boot precisa retentar
    // sozinho aqui.
    for (let tentativa = 1; tentativa <= 4 && ctx.getState() !== 'logged_in'; tentativa++) {
      ctx.log(`Auto-login do banco: FALHA — ${result.message}. Nova tentativa (${tentativa}/4) em 60s...`);
      await sleep(60000);
      if (ctx.getState() === 'logged_in') break;
      result = await autoLogin(creds.cpf, creds.senha, { clearSession: true });
    }
    if (ctx.getState() === 'logged_in' || result.success) {
      ctx.log('Auto-login do banco: SUCESSO (após recuperação)');
    } else {
      // clearSession (limpeza PARCIAL) não zerou o hCaptcha → escalar p/ wipe TOTAL do
      // perfil + relaunch (v5.2.17). Este é o único caminho que roda no COLD BOOT — a
      // auto-recuperação do server-sync (onSSODead) NÃO dispara sem Bearer. Rate-limited.
      ctx.log(`Auto-login do banco: FALHA persistente — ${result.message}. Escalando p/ wipe total + relaunch (cold-boot self-heal).`);
      try {
        if (ctx.serverSync && ctx.serverSync.serverLog) {
          ctx.serverSync.serverLog('cold-boot-wipe-relaunch', { message: result.message }).catch(() => {});
        }
      } catch {}
      require('./profile-recovery').wipeAndRelaunch('cold-boot-hcaptcha', ctx.log);
    }
  }

  // ─── attemptAutoRelogin: cooldown 2min ───────────────────────────────
  let reloginInProgress = false;
  let lastReloginAt = 0;

  async function attemptAutoRelogin() {
    if (reloginInProgress) return;
    if (ctx.getState() === 'logged_in' && ctx.tokenFresco()) return;
    if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) {
      ctx.log('Relogin: cooldown ativo, aguardando...');
      return;
    }

    reloginInProgress = true;
    lastReloginAt = Date.now();

    try {
      let creds = readCredentialsFromDB();
      if (!creds) creds = await readCredentialsFromServer();
      if (!creds) {
        ctx.log('Relogin: sem credenciais. Aguardando login manual.');
        return;
      }

      ctx.log('═══ RE-LOGIN AUTOMÁTICO ═══');
      await sleep(3000);

      // clearSession: sessão dead → cookie residual quica loginPortal.asp para
      // intro.htm. Limpar cookies antes faz o login form reaparecer.
      const result = await autoLogin(creds.cpf, creds.senha, { clearSession: true });
      if (result.success) {
        ctx.log('Re-login: SUCESSO — sessão restaurada');
        ctx.serverSync.reviverSSO();
      } else {
        ctx.log(`Re-login: FALHA — ${result.message}`);
        ctx.serverSync.marcarSSOmorto();
      }
    } catch (e) {
      ctx.log(`Re-login erro: ${e.message}`);
      ctx.serverSync.marcarSSOmorto();
    } finally {
      reloginInProgress = false;
    }
  }

  return {
    autoLogin,
    autoLoginFromDB,
    attemptAutoRelogin,
    readCredentialsFromDB,
    readCredentialsFromServer,
  };
}

module.exports = {
  create,
  RELOGIN_COOLDOWN_MS,
};
