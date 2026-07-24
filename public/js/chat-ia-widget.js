// chat-ia-widget.js (2026-05-22)
// Widget flutuante de chat com IA. Auto-injetado em todas as páginas via
// sidebar.js. Detecta contexto pela URL e por window.__chatContext setado
// pelas páginas (ex: ao clicar num card de análise).
//
// API:
//   window.__chatContext = { tipo: 'analise', id: 42 }  ← seta antes/durante interação
//   window.chatIA.abrir()                                ← força abrir
//   window.chatIA.fechar()
//   window.chatIA.novaConversa()

(function () {
  if (window.chatIA) return; // evita carregar 2×

  const STATE = {
    aberto: false,
    sessaoId: null,
    mensagens: [],
    enviando: false,
  };

  // ===== CSS injetado =====
  const css = `
    #chat-ia-btn{position:fixed;bottom:20px;right:20px;padding:10px 16px 10px 12px;border-radius:999px;background:var(--accent,#1a5f7a);background:linear-gradient(135deg,var(--accent,#1a5f7a),var(--accent-strong,#0f4359));color:#fff;border:none;cursor:pointer;font-family:inherit;font-size:0.85em;font-weight:500;letter-spacing:.01em;box-shadow:0 2px 8px rgba(0,0,0,.12),0 6px 20px rgba(26,95,122,.25);z-index:9998;display:inline-flex;align-items:center;gap:7px;line-height:1;transition:transform .15s ease,box-shadow .15s ease}
    #chat-ia-btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.16),0 8px 24px rgba(26,95,122,.35)}
    #chat-ia-btn:active{transform:translateY(0)}
    #chat-ia-btn svg{width:18px;height:18px;flex:none}
    #chat-ia-btn .lbl{display:inline}
    @media (max-width:640px){#chat-ia-btn{padding:0;width:48px;height:48px;justify-content:center}#chat-ia-btn .lbl{display:none}}
    #chat-ia-panel{position:fixed;top:0;right:0;width:min(480px,100vw);height:100vh;background:var(--bg-1,#fff);box-shadow:-4px 0 16px rgba(0,0,0,.15);z-index:9999;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .25s;color:var(--text-0,#222)}
    #chat-ia-panel.aberto{transform:translateX(0)}
    #chat-ia-header{padding:14px 16px;border-bottom:1px solid var(--border,#ddd);display:flex;align-items:center;gap:8px;background:var(--bg-2,#f5f5f5)}
    #chat-ia-header h3{margin:0;font-size:0.95em;flex:1;color:var(--text-0,#222)}
    #chat-ia-header button{background:none;border:none;cursor:pointer;color:var(--text-2,#666);font-size:18px;padding:4px 8px;border-radius:4px}
    #chat-ia-header button:hover{background:var(--bg-3,#eee)}
    #chat-ia-ctx{padding:6px 16px;background:var(--accent-soft,#e8f0f5);color:var(--accent,#1a5f7a);font-size:0.8em;border-bottom:1px solid var(--border,#ddd);display:none}
    #chat-ia-ctx.ativo{display:block}
    #chat-ia-msgs{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:var(--bg-0,#fafafa)}
    .chat-ia-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:0.9em;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}
    .chat-ia-msg.user{background:var(--accent,#1a5f7a);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
    .chat-ia-msg.assistant{background:var(--bg-1,#fff);color:var(--text-0,#222);align-self:flex-start;border:1px solid var(--border,#ddd);border-bottom-left-radius:4px}
    .chat-ia-msg.system{align-self:center;background:transparent;color:var(--text-3,#999);font-size:0.78em;font-style:italic;padding:4px 10px;text-align:center}
    .chat-ia-msg .provider{display:block;font-size:0.7em;color:var(--text-3,#999);margin-top:4px;font-style:italic}
    #chat-ia-form{padding:12px 14px;border-top:1px solid var(--border,#ddd);background:var(--bg-1,#fff);display:flex;gap:8px}
    #chat-ia-input{flex:1;padding:10px 12px;border:1px solid var(--border,#ddd);border-radius:8px;font-family:inherit;font-size:0.9em;resize:none;max-height:120px;background:var(--bg-1,#fff);color:var(--text-0,#222)}
    #chat-ia-input:focus{outline:none;border-color:var(--accent,#1a5f7a)}
    #chat-ia-send{padding:10px 16px;background:var(--accent,#1a5f7a);color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:500}
    #chat-ia-send:disabled{opacity:.4;cursor:not-allowed}
    #chat-ia-empty{text-align:center;color:var(--text-2,#666);padding:40px 20px;font-size:0.9em}
    #chat-ia-empty .ex{margin-top:14px;text-align:left;display:flex;flex-direction:column;gap:6px}
    #chat-ia-empty .ex button{text-align:left;padding:8px 12px;background:var(--bg-1,#fff);border:1px solid var(--border,#ddd);border-radius:8px;cursor:pointer;font-size:0.85em;color:var(--text-1,#444)}
    #chat-ia-empty .ex button:hover{border-color:var(--accent,#1a5f7a);color:var(--accent,#1a5f7a)}
    @media (prefers-color-scheme:dark){#chat-ia-panel{background:#1f2937;color:#f3f4f6}.chat-ia-msg.assistant{background:#374151;color:#f3f4f6;border-color:#4b5563}#chat-ia-input,#chat-ia-form{background:#1f2937;color:#f3f4f6;border-color:#4b5563}}
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ===== DOM =====
  const btn = document.createElement('button');
  btn.id = 'chat-ia-btn';
  btn.title = 'Pergunte ao copiloto IA';
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
    </svg>
    <span class="lbl">Copiloto IA</span>`;
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'chat-ia-panel';
  panel.innerHTML = `
    <div id="chat-ia-header">
      <h3>💬 Copiloto IA</h3>
      <button id="chat-ia-nova" title="Nova conversa">✨</button>
      <button id="chat-ia-close" title="Fechar">✕</button>
    </div>
    <div id="chat-ia-ctx"></div>
    <div id="chat-ia-msgs">
      <div id="chat-ia-empty">
        <div style="font-size:1.4em;margin-bottom:8px">👋</div>
        Como posso ajudar?
        <div class="ex" id="chat-ia-sugestoes"></div>
      </div>
    </div>
    <form id="chat-ia-form">
      <textarea id="chat-ia-input" rows="1" placeholder="Pergunte algo..." autocomplete="off"></textarea>
      <button type="submit" id="chat-ia-send">Enviar</button>
    </form>
  `;
  document.body.appendChild(panel);

  const els = {
    btn,
    panel,
    close: panel.querySelector('#chat-ia-close'),
    nova: panel.querySelector('#chat-ia-nova'),
    msgs: panel.querySelector('#chat-ia-msgs'),
    empty: panel.querySelector('#chat-ia-empty'),
    sugestoes: panel.querySelector('#chat-ia-sugestoes'),
    form: panel.querySelector('#chat-ia-form'),
    input: panel.querySelector('#chat-ia-input'),
    send: panel.querySelector('#chat-ia-send'),
    ctx: panel.querySelector('#chat-ia-ctx'),
  };

  // ===== Detector de contexto =====
  function detectarContexto() {
    if (window.__chatContext && window.__chatContext.tipo) return window.__chatContext;
    const p = location.pathname;
    if (p.includes('/operacional/analises-ia.html')) return { tipo: 'pagina', id: 'analises-ia', titulo: 'Análises IA' };
    if (p.includes('/licitacoes/interesse.html'))     return { tipo: 'pagina', id: 'interesses', titulo: 'Meus Interesses' };
    if (p.includes('/operacional/inteligencia.html')) return { tipo: 'pagina', id: 'inteligencia', titulo: 'Inteligência' };
    if (p.includes('/operacional/lances.html'))       return { tipo: 'pagina', id: 'lances', titulo: 'Sala de Lances' };
    if (p.includes('/operacional/grupos-palavras.html')) return { tipo: 'pagina', id: 'grupos', titulo: 'Grupos de Palavras' };
    return null;
  }

  function atualizarContextoUI() {
    const ctx = detectarContexto();
    if (ctx && (ctx.tipo === 'analise' || ctx.tipo === 'licitacao')) {
      els.ctx.textContent = `📍 Conversando sobre: ${ctx.tipo} ${ctx.id}`;
      els.ctx.classList.add('ativo');
    } else if (ctx && ctx.titulo) {
      els.ctx.textContent = `📍 ${ctx.titulo}`;
      els.ctx.classList.add('ativo');
    } else {
      els.ctx.classList.remove('ativo');
    }
  }

  function sugestoesPorContexto() {
    const ctx = detectarContexto();
    const base = {
      analise: ['Por que essa análise deu esse score?', 'Quais documentos preciso pra essa licitação?', 'Vale a pena enviar proposta?', 'Quais riscos eu vejo?'],
      licitacao: ['Resumo dessa licitação', 'Preciso de algum atestado técnico?', 'Quais itens valem a pena?', 'Vejo concorrência por preço?'],
      'analises-ia': ['Como funciona o score?', 'Como configurar grupos de palavras?', 'Como ativar notificação por email?'],
      interesses: ['Como envio proposta automaticamente?', 'Como vincular grupo?', 'Como ver minhas propostas enviadas?'],
      lances: ['Como configurar auto-lance?', 'Qual o melhor momento pra dar lance?', 'Como funciona blitz?'],
      grupos: ['Como criar um grupo eficiente?', 'O que são palavras de exclusão?', 'Como funciona o score min?'],
      inteligencia: ['Como pesquisar concorrentes?', 'Como ver preços históricos?'],
    };
    const arr = ctx ? (base[ctx.tipo] || base[ctx.id] || []) : [];
    if (arr.length === 0) {
      arr.push('Como funciona o LiciteAgora?', 'Como criar meu primeiro grupo de palavras?');
    }
    els.sugestoes.innerHTML = arr.map(p => `<button onclick="window.chatIA.enviar(${JSON.stringify(p)})">${p}</button>`).join('');
  }

  // ===== Render =====
  function renderMensagens() {
    if (STATE.mensagens.length === 0) {
      els.empty.style.display = 'block';
      sugestoesPorContexto();
      // Limpa qualquer msg ant
      [...els.msgs.children].forEach(c => { if (c !== els.empty) c.remove(); });
      return;
    }
    els.empty.style.display = 'none';
    els.msgs.innerHTML = '';
    for (const m of STATE.mensagens) {
      const div = document.createElement('div');
      div.className = 'chat-ia-msg ' + m.papel;
      div.textContent = m.conteudo;
      if (m.provider) {
        const p = document.createElement('span');
        p.className = 'provider';
        p.textContent = `via ${m.provider}`;
        div.appendChild(p);
      }
      els.msgs.appendChild(div);
    }
    if (STATE.enviando) {
      const wait = document.createElement('div');
      wait.className = 'chat-ia-msg assistant';
      wait.textContent = '...';
      wait.style.opacity = '0.6';
      wait.id = 'chat-ia-wait';
      els.msgs.appendChild(wait);
    }
    els.msgs.scrollTop = els.msgs.scrollHeight;
  }

  // ===== Lógica =====
  async function enviar(texto) {
    if (STATE.enviando) return;
    const msg = String(texto || '').trim();
    if (!msg) return;

    STATE.mensagens.push({ papel: 'user', conteudo: msg });
    STATE.enviando = true;
    renderMensagens();
    els.input.value = '';
    els.send.disabled = true;

    try {
      const ctx = detectarContexto();
      const resp = await fetch('/api/chat-ia/mensagem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessaoId: STATE.sessaoId,
          mensagem: msg,
          contextoTipo: ctx?.tipo || null,
          contextoId: ctx?.id || null,
        }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Erro');
      STATE.sessaoId = data.sessaoId;
      localStorage.setItem('chat_ia_sessao', String(STATE.sessaoId));
      STATE.mensagens.push({ papel: 'assistant', conteudo: data.resposta, provider: data.provider });
    } catch (e) {
      STATE.mensagens.push({ papel: 'system', conteudo: 'Erro: ' + e.message });
    } finally {
      STATE.enviando = false;
      els.send.disabled = false;
      renderMensagens();
      els.input.focus();
    }
  }

  async function carregarSessao(id) {
    try {
      const r = await fetch('/api/chat-ia/sessao/' + id);
      const d = await r.json();
      if (d.success) {
        STATE.sessaoId = id;
        STATE.mensagens = d.mensagens.map(m => ({ papel: m.papel, conteudo: m.conteudo, provider: m.provider }));
        renderMensagens();
      }
    } catch (_) { /* ok */ }
  }

  function novaConversa() {
    STATE.sessaoId = null;
    STATE.mensagens = [];
    localStorage.removeItem('chat_ia_sessao');
    renderMensagens();
    els.input.focus();
  }

  function abrir() {
    panel.classList.add('aberto');
    STATE.aberto = true;
    btn.style.display = 'none';
    atualizarContextoUI();
    setTimeout(() => els.input.focus(), 250);
  }
  function fechar() {
    panel.classList.remove('aberto');
    STATE.aberto = false;
    btn.style.display = 'flex';
  }

  // ===== Wire events =====
  btn.addEventListener('click', abrir);
  els.close.addEventListener('click', fechar);
  els.nova.addEventListener('click', () => { if (confirm('Iniciar nova conversa? O histórico fica salvo.')) novaConversa(); });
  els.form.addEventListener('submit', (e) => { e.preventDefault(); enviar(els.input.value); });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(els.input.value); }
  });
  els.input.addEventListener('input', () => {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(120, els.input.scrollHeight) + 'px';
  });

  // ===== API global =====
  window.chatIA = { abrir, fechar, enviar, novaConversa };

  // ===== Auto-restore última sessão =====
  const ultimaId = localStorage.getItem('chat_ia_sessao');
  if (ultimaId) {
    carregarSessao(Number(ultimaId)).catch(() => { /* sessão pode ter sido apagada */ });
  }
})();
