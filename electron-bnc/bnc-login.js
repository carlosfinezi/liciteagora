// bnc-login.js — gera o snippet JS que roda DENTRO do webview de bnccompras.com.
//
// Por que injetar em vez de simular cliques via CDP: o teclado virtual do BNC
// sorteia os pares "X ou Y" a cada sessão. Precisamos LER o DOM atualizado
// pra mapear digito→token, e isso é mais robusto fazendo no contexto da página.
//
// Fluxo do snippet:
//   1) Espera ProcessUserSession completar (botões do teclado renderizados)
//   2) Lê os 5 botões, monta dicionário digito→token (0 codificado como *)
//   3) Para cada dígito da senha, clica no botão correspondente
//   4) Chama doLogin() (que dispara ExecuteCaptcha e POST /Home/Login)
//   5) Aguarda resposta — sinaliza "ok" ou "erro" via window.__bncLoginResult
//
// O main process polla window.__bncLoginResult via executeJavaScript a cada 1s
// até obter resultado ou timeout.

'use strict';

function buildAutoLoginSnippet({ email, senha }) {
  // senha tem 6 dígitos numéricos cleartext. O usuário pode ter armazenado
  // alguma versão com asteriscos — limpamos primeiro pra segurança.
  const senhaLimpa = String(senha).replace(/\D/g, '').slice(0, 6);
  if (senhaLimpa.length !== 6) {
    return `window.__bncLoginResult = { ok: false, etapa: 'senha-invalida', error: 'Senha BNC deve ter 6 dígitos' };`;
  }

  // Escapa pra string literal JS
  const emailJs = JSON.stringify(String(email).trim());
  const senhaJs = JSON.stringify(senhaLimpa);

  return `(function () {
    // resetar marker
    window.__bncLoginResult = null;
    window.__bncLoginStatus = 'iniciando';

    const EMAIL = ${emailJs};
    const SENHA = ${senhaJs}; // 6 dígitos

    function setResult(r) { window.__bncLoginResult = r; }
    function setStatus(s) { window.__bncLoginStatus = s; }

    function readPares() {
      // botões inputs "5 ou 8" etc. Filtramos por onclick que chama soma().
      const inputs = document.querySelectorAll('input[onclick]');
      const pares = [];
      inputs.forEach((el) => {
        const oc = el.getAttribute('onclick') || '';
        const m = oc.match(/soma\\(['"]([^'"]+)['"]\\)/);
        if (!m) return;
        const token = m[1];
        // O name é "X ou Y"; extrai os 2 chars (dígitos ou *).
        const name = el.getAttribute('name') || '';
        const digitos = (name.match(/\\d|\\*/g) || []);
        // Fallback: extrai dígitos do próprio token (raríssimo o name vir vazio).
        const dgs = digitos.length ? digitos : (token.match(/\\d|\\*/g) || []);
        pares.push({ token, digitos: dgs });
      });
      return pares;
    }

    function montarMapaDigitoToken(pares) {
      const map = {};
      for (const p of pares) {
        for (const d of p.digitos) {
          // 0 é representado como * no token
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

    async function aguardarResultadoLogin(maxMs = 30000) {
      // doLogin() abre #loadingModal e ao concluir mostra #errorModal/#warningModal
      // ou redireciona via data.Link. Detecta os 3 cenários.
      const inicio = Date.now();
      while (Date.now() - inicio < maxMs) {
        // 1) Redirect (página mudou de /Home/Login)
        if (!location.pathname.toLowerCase().startsWith('/home/login')) {
          return { ok: true, etapa: 'redirect', url: location.href };
        }
        // 2) Modal de erro visível
        const errModal = document.querySelector('#errorModal.show, #errorModal[style*="block"]');
        if (errModal) {
          const txt = (errModal.innerText || '').trim().slice(0, 400);
          return { ok: false, etapa: 'erro-bnc', error: txt };
        }
        // 3) Modal de escolha de perfil (multi-perfil) → o BNC abre #modalContent com html do servidor
        const perfilModal = document.querySelector('#modalContent .modal-title');
        if (perfilModal && /perfil/i.test(perfilModal.textContent || '')) {
          return { ok: true, etapa: 'escolha-perfil', precisaInteracao: true };
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
        // Sanity: garantir que todos os dígitos da senha têm botão
        for (const d of SENHA) {
          const key = d === '0' ? '*' : d;
          if (!mapa[key]) {
            setResult({ ok: false, etapa: 'sem-botao-para-digito', error: 'Dígito ' + d + ' não tem botão (pares: ' + JSON.stringify(pares) + ')' });
            return;
          }
        }

        // Preenche email + RememberMe(off) + zera senha
        const emailEl = document.querySelector('#Email');
        if (!emailEl) {
          setResult({ ok: false, etapa: 'sem-campo-email', error: '#Email não encontrado' });
          return;
        }
        emailEl.value = EMAIL;
        emailEl.dispatchEvent(new Event('input', { bubbles: true }));

        // CleanLoginFields existe na página — usar pra zerar tudo
        if (typeof window.CleanLoginFields === 'function') window.CleanLoginFields();

        setStatus('clicando-teclado');
        // Clica os 6 botões (chama soma() na ordem dos dígitos)
        if (typeof window.soma !== 'function') {
          setResult({ ok: false, etapa: 'sem-funcao-soma', error: 'window.soma não está definida' });
          return;
        }
        for (const d of SENHA) {
          const key = d === '0' ? '*' : d;
          window.soma(mapa[key]);
          // Mini-delay pra deixar UI responder
          await new Promise(r => setTimeout(r, 80));
        }

        setStatus('disparando-doLogin');
        if (typeof window.doLogin !== 'function') {
          setResult({ ok: false, etapa: 'sem-funcao-doLogin', error: 'window.doLogin não está definida' });
          return;
        }
        // doLogin() chama ExecuteCaptcha (reCAPTCHA invisible) e POST /Home/Login
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

module.exports = { buildAutoLoginSnippet };
