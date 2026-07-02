'use strict';

/**
 * portals/bnc/auto-login.js — Auto-login no BNC (bnccompras.com).
 *
 * Combina:
 *   - buildAutoLoginSnippet (porta de electron-bnc/bnc-login.js): JS
 *     injetado no webview que opera o teclado virtual + dispara reCAPTCHA
 *     invisible + POST /Home/Login.
 *   - createTrigger (porta de triggerAutoLogin de electron-bnc/electron-bnc.js):
 *     orquestra busca de credenciais via serverBridge, navegação pra
 *     /Home/Login se preciso, injeção do snippet, polling de resultado.
 *
 * O snippet preenche window.__bncLoginResult / __bncLoginStatus que o
 * main process lê via executeJavaScript a cada 1s (até 45s timeout).
 *
 * Uso:
 *   const al = require('./auto-login').create({ ctx, serverBridge, cookieSyncHandle });
 *   al.trigger({ manual: true });   // dispara on-demand
 *   al.trigger({ manual: false });  // dispara automático (no did-finish-load)
 *
 * `ctx` precisa expor: log, getWebview()
 * cookieSyncHandle.forceSync() é chamado após login OK (sync de cookies).
 */

const BNC_LOGIN_URL = 'https://bnccompras.com/Home/Login';
const POLL_MAX_MS = 45000;

// ─── Snippet builder (porta de electron-bnc/bnc-login.js) ──────────────────
function buildAutoLoginSnippet({ email, senha, perfilPreferido }) {
  const senhaLimpa = String(senha).replace(/\D/g, '').slice(0, 6);
  if (senhaLimpa.length !== 6) {
    return `window.__bncLoginResult = { ok: false, etapa: 'senha-invalida', error: 'Senha BNC deve ter 6 dígitos' };`;
  }

  const emailJs = JSON.stringify(String(email).trim());
  const senhaJs = JSON.stringify(senhaLimpa);
  const perfilPrefJs = JSON.stringify(perfilPreferido ? String(perfilPreferido).trim() : '');

  return `(function () {
    window.__bncLoginResult = null;
    window.__bncLoginStatus = 'iniciando';

    const EMAIL = ${emailJs};
    const SENHA = ${senhaJs};
    const PERFIL_PREFERIDO = ${perfilPrefJs};

    function setResult(r) { window.__bncLoginResult = r; }
    function setStatus(s) { window.__bncLoginStatus = s; }

    function readPares() {
      const inputs = document.querySelectorAll('input[onclick]');
      const pares = [];
      inputs.forEach((el) => {
        const oc = el.getAttribute('onclick') || '';
        const m = oc.match(/soma\\(['"]([^'"]+)['"]\\)/);
        if (!m) return;
        const token = m[1];
        const name = el.getAttribute('name') || '';
        const digitos = (name.match(/\\d|\\*/g) || []);
        const dgs = digitos.length ? digitos : (token.match(/\\d|\\*/g) || []);
        pares.push({ token, digitos: dgs });
      });
      return pares;
    }

    function montarMapaDigitoToken(pares) {
      const map = {};
      for (const p of pares) {
        for (const d of p.digitos) {
          const key = d === '0' ? '*' : d;
          if (!map[key]) map[key] = p.token;
        }
      }
      return map;
    }

    async function aguardarTeclado(maxMs = 15000) {
      const inicio = Date.now();
      while (Date.now() - inicio < maxMs) {
        const pares = readPares();
        if (pares.length >= 5) return pares;
        await new Promise(r => setTimeout(r, 250));
      }
      return null;
    }

    async function tentarSelecionarPerfil() {
      // Estratégia: detecta modal de perfil, escolhe automaticamente.
      // Preferência (em ordem): perfil contendo "operador"/email do user → primeiro perfil.
      const modal = document.querySelector('#modalContent');
      if (!modal) return null;
      const title = modal.querySelector('.modal-title');
      if (!title || !/perfil/i.test(title.textContent || '')) return null;

      // BNC renderiza cada perfil como uma linha com texto + um <a> só de ícone:
      //   <tr>
      //     <td>OPERADOR 1BIT 000141 SIM</td>
      //     <td><a href="/Home/ProfileChooser?profileId=[gkz]..."><i class="icon-check"></i></a></td>
      //   </tr>
      // O texto do <a> é VAZIO. Precisa pegar o texto do container (linha/card).
      function textoDoContainer(linkEl) {
        // Sobe até achar um TR/LI/.card/.row ou ancestral com texto substancial.
        let cur = linkEl.parentElement;
        for (let i = 0; i < 6 && cur; i++) {
          const tag = (cur.tagName || '').toLowerCase();
          const txt = (cur.innerText || cur.textContent || '').trim();
          if (tag === 'tr' || tag === 'li' || /\\b(row|card|profile|perfil|item)\\b/i.test(cur.className || '')) {
            if (txt.length > 4) return txt;
          }
          if (txt.length >= 12) return txt;  // ancestral com texto razoável
          cur = cur.parentElement;
        }
        return (linkEl.innerText || linkEl.textContent || '').trim();
      }

      const candidatos = [];
      modal.querySelectorAll('a, button, [onclick], [href]').forEach(el => {
        const oc = el.getAttribute('onclick') || '';
        const href = el.getAttribute('href') || '';
        if (/ProfileChooser/i.test(oc) || /ProfileChooser/i.test(href) || /profileId/i.test(href)) {
          const txt = textoDoContainer(el);
          candidatos.push({ el, txt, oc, href });
        }
      });
      if (!candidatos.length) {
        // Fallback: pega qualquer clicável dentro do modal-body
        modal.querySelectorAll('.modal-body a, .modal-body button').forEach(el => {
          const txt = textoDoContainer(el);
          if (txt) candidatos.push({ el, txt, oc: '', href: el.getAttribute('href') || '' });
        });
      }
      if (!candidatos.length) return { erro: 'modal de perfil sem candidatos clicáveis' };

      // Normalização AGRESSIVA: lowercase + remove tudo que não é letra/número.
      // Faz "OPERADOR 1BIT 000141 SIM" virar "operador1bit000141sim" e bate
      // contra "OPERADOR 1 BIT 000141 - SIM" / "Operador-1BIT/000141 SIM" etc.
      const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      // Expõe candidatos pra debug
      window.__bncProfileCandidates = candidatos.map(c => ({
        txt: c.txt.slice(0, 120), normalized: norm(c.txt),
      }));

      let preferido = null;
      let estrategiaMatch = null;
      if (PERFIL_PREFERIDO) {
        const alvoN = norm(PERFIL_PREFERIDO);
        // 1) match exato após normalização
        preferido = candidatos.find(c => norm(c.txt) === alvoN);
        if (preferido) estrategiaMatch = 'exato-normalizado';
        // 2) candidato contém o alvo normalizado (substring)
        if (!preferido) {
          preferido = candidatos.find(c => norm(c.txt).includes(alvoN));
          if (preferido) estrategiaMatch = 'contains-alvo';
        }
        // 3) alvo contém o candidato normalizado (caso o botão tenha só id curto)
        if (!preferido) {
          preferido = candidatos.find(c => {
            const cn = norm(c.txt);
            return cn.length >= 4 && alvoN.includes(cn);
          });
          if (preferido) estrategiaMatch = 'alvo-contains';
        }
      }
      if (!preferido) {
        preferido = candidatos.find(c => /operador|principal|comprador/i.test(c.txt)) || candidatos[0];
        estrategiaMatch = 'fallback';
      }
      try {
        preferido.el.click();
        return {
          ok: true,
          escolhido: preferido.txt.slice(0, 120),
          estrategia: estrategiaMatch,
          candidatos: window.__bncProfileCandidates.map(c => c.txt),
          alvoNorm: PERFIL_PREFERIDO ? norm(PERFIL_PREFERIDO) : null,
        };
      } catch (e) {
        return { erro: 'click falhou: ' + e.message };
      }
    }

    async function aguardarResultadoLogin(maxMs = 30000) {
      const inicio = Date.now();
      let perfilSelecionado = false;
      let infoSelecao = null;  // capturada pra anexar no resultado final
      while (Date.now() - inicio < maxMs) {
        if (!location.pathname.toLowerCase().startsWith('/home/login')) {
          return Object.assign(
            { ok: true, etapa: 'redirect', url: location.href },
            infoSelecao ? { selecao: infoSelecao } : {}
          );
        }
        const errModal = document.querySelector('#errorModal.show, #errorModal[style*="block"]');
        if (errModal) {
          const txt = (errModal.innerText || '').trim().slice(0, 400);
          return { ok: false, etapa: 'erro-bnc', error: txt };
        }
        const perfilModal = document.querySelector('#modalContent .modal-title');
        if (perfilModal && /perfil/i.test(perfilModal.textContent || '')) {
          if (!perfilSelecionado) {
            setStatus('escolhendo-perfil');
            const sel = await tentarSelecionarPerfil();
            if (sel && sel.ok) {
              perfilSelecionado = true;
              infoSelecao = {
                escolhido: sel.escolhido,
                estrategia: sel.estrategia,
                candidatos: sel.candidatos,
                alvoNorm: sel.alvoNorm,
              };
              try { localStorage.setItem('__bnc_last_profile_pick', JSON.stringify(infoSelecao)); } catch (_) {}
              setStatus('aguardando-pos-perfil');
              await new Promise(r => setTimeout(r, 1500));
              continue;
            }
            if (sel && sel.erro) {
              return { ok: true, etapa: 'escolha-perfil', precisaInteracao: true, erro: sel.erro };
            }
          }
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return { ok: false, etapa: 'timeout', error: 'Sem resposta do servidor em 30s' };
    }

    (async () => {
      try {
        setStatus('aguardando-teclado');
        const pares = await aguardarTeclado();
        if (!pares) {
          setResult({ ok: false, etapa: 'sem-teclado', error: 'Botões do teclado virtual não apareceram' });
          return;
        }
        setStatus('mapeando-digitos');
        const mapa = montarMapaDigitoToken(pares);
        for (const d of SENHA) {
          const key = d === '0' ? '*' : d;
          if (!mapa[key]) {
            setResult({ ok: false, etapa: 'sem-botao-para-digito', error: 'Dígito ' + d + ' não tem botão (pares: ' + JSON.stringify(pares) + ')' });
            return;
          }
        }

        const emailEl = document.querySelector('#Email');
        if (!emailEl) {
          setResult({ ok: false, etapa: 'sem-campo-email', error: '#Email não encontrado' });
          return;
        }
        emailEl.value = EMAIL;
        emailEl.dispatchEvent(new Event('input', { bubbles: true }));

        if (typeof window.CleanLoginFields === 'function') window.CleanLoginFields();

        setStatus('clicando-teclado');
        if (typeof window.soma !== 'function') {
          setResult({ ok: false, etapa: 'sem-funcao-soma', error: 'window.soma não está definida' });
          return;
        }
        for (const d of SENHA) {
          const key = d === '0' ? '*' : d;
          window.soma(mapa[key]);
          await new Promise(r => setTimeout(r, 80));
        }

        setStatus('disparando-doLogin');
        if (typeof window.doLogin !== 'function') {
          setResult({ ok: false, etapa: 'sem-funcao-doLogin', error: 'window.doLogin não está definida' });
          return;
        }
        window.doLogin();

        setStatus('aguardando-resposta');
        const res = await aguardarResultadoLogin();
        setResult(res);
      } catch (e) {
        setResult({ ok: false, etapa: 'exception', error: e && e.message ? e.message : String(e) });
      }
    })();

    return 'autologin-disparado';
  })();`;
}

// ─── Trigger orchestrator (porta de triggerAutoLogin) ──────────────────────
function create({ ctx, serverBridge, getCookieSync }) {
  let inProgress = false;
  let currentUserEmail = null;

  function setStatus(text, kind = '') {
    const mw = ctx.getMainWindow && ctx.getMainWindow();
    if (mw && !mw.isDestroyed()) {
      mw.webContents.send('status-update', { text, kind });
    }
  }

  async function trigger({ manual = false } = {}) {
    const log = ctx.log;
    if (inProgress) {
      log('Autologin BNC já em andamento — ignorando');
      return;
    }
    const wv = ctx.getWebview();
    if (!wv || wv.isDestroyed()) {
      log('Autologin BNC: webview não pronto');
      return;
    }

    let creds;
    try {
      setStatus('Buscando credenciais...', 'warn');
      creds = await serverBridge.fetchCredentials();
    } catch (e) {
      log(`Autologin BNC: falha credenciais — ${e.message}`);
      setStatus(`Sem credenciais: ${e.message}`, 'err');
      return;
    }

    currentUserEmail = creds.usuario;
    inProgress = true;
    setStatus(`Logando como ${creds.usuario}...`, 'warn');

    // Garante página de login
    const url = wv.getURL();
    if (!/\/Home\/Login/i.test(url)) {
      log(`Navegando para ${BNC_LOGIN_URL} (estava em ${url})`);
      await wv.loadURL(BNC_LOGIN_URL);
      await new Promise(r => setTimeout(r, 1500));
    }

    const snippet = buildAutoLoginSnippet({
      email: creds.usuario,
      senha: creds.senha,
      perfilPreferido: creds.perfilPreferido || null,
    });
    try {
      await wv.executeJavaScript(snippet, true);
    } catch (e) {
      log(`Autologin BNC: erro ao injetar snippet — ${e.message}`);
      setStatus(`Erro snippet: ${e.message}`, 'err');
      inProgress = false;
      return;
    }

    // Polling do resultado
    const inicio = Date.now();
    while (Date.now() - inicio < POLL_MAX_MS) {
      await new Promise(r => setTimeout(r, 1000));
      let res;
      try {
        res = await wv.executeJavaScript('window.__bncLoginResult', true);
      } catch (e) {
        log(`Polling BNC: ${e.message}`);
        continue;
      }
      if (res === null || res === undefined) {
        try {
          const s = await wv.executeJavaScript('window.__bncLoginStatus', true);
          if (s) setStatus(`autologin: ${s}`, 'warn');
        } catch {}
        continue;
      }
      inProgress = false;
      if (res.ok) {
        log(`Autologin BNC OK: ${res.etapa} ${res.url || ''}`);
        if (res.selecao) {
          log(`[BNC perfil] estrategia=${res.selecao.estrategia} escolhido="${res.selecao.escolhido}" alvoNorm="${res.selecao.alvoNorm || ''}" candidatos=${JSON.stringify(res.selecao.candidatos || [])}`);
        }
        if (res.etapa === 'escolha-perfil') {
          setStatus('Login OK — escolha de perfil exige clique manual', 'warn');
        } else {
          setStatus(`Logado: ${creds.usuario}`, 'ok');
        }
        // Força sync de cookies após login bem-sucedido
        const cookieSync = typeof getCookieSync === 'function' ? getCookieSync() : null;
        if (cookieSync && typeof cookieSync.forceSync === 'function') {
          setTimeout(() => cookieSync.forceSync(), 2000);
        }
      } else {
        log(`Autologin BNC FALHA (${res.etapa}): ${res.error}`);
        setStatus(`Falha (${res.etapa}): ${res.error}`, 'err');
        try { await serverBridge.reportError('bnc-autologin', new Error(`${res.etapa}: ${res.error}`)); } catch {}
      }
      return;
    }

    inProgress = false;
    log('Autologin BNC: polling timeout');
    setStatus('Login timeout (45s)', 'err');
  }

  return {
    trigger,
    isInProgress: () => inProgress,
    getCurrentUserEmail: () => currentUserEmail,
  };
}

module.exports = {
  create,
  buildAutoLoginSnippet,
  BNC_LOGIN_URL,
  POLL_MAX_MS,
};
