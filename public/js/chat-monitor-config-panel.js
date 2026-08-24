/* chat-monitor-config-panel.js
 * Painel de configuração INDIVIDUAL do monitor de chat de um portal:
 * palavras-chave + Telegram próprios + "notificar todas".
 * Uso:  renderChatConfigPanel('idDoContainer', 'bll'|'bnc'|'comprasnet'|'pcp')
 * Consome /api/chat-monitor/:portal/*  (chat-monitor-routes.js).
 */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  window.renderChatConfigPanel = async function (containerId, portal) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div style="color:var(--text-3);font-size:.85em;padding:8px;">Carregando configuração…</div>';
    let cfg;
    try {
      cfg = await (await fetch(`/api/chat-monitor/${portal}/config`)).json();
      if (!cfg.success) throw new Error(cfg.error);
    } catch (e) { el.innerHTML = `<div style="color:var(--danger);font-size:.85em;">${esc(e.message)}</div>`; return; }

    const tg = cfg.telegram || {};
    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:14px;">
          <div style="font-weight:600;margin-bottom:8px;">🔔 Telegram deste portal</div>
          <div id="cmp-tg-status" style="font-size:.8em;margin-bottom:10px;color:${tg.configurado ? 'var(--success)' : 'var(--text-3)'};">${tg.configurado ? (tg.ativo ? '● Configurado e ativo' : '○ Configurado (inativo)') : '○ Não configurado'}</div>
          <label style="font-size:.72em;color:var(--text-3);text-transform:uppercase;">Bot Token</label>
          <input id="cmp-token" type="text" placeholder="${tg.botToken ? esc(tg.botToken) : '123456:ABC-...'}" style="width:100%;margin:2px 0 8px;padding:6px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg-0);color:var(--text-0);font-size:.85em;">
          <label style="font-size:.72em;color:var(--text-3);text-transform:uppercase;">Chat ID</label>
          <input id="cmp-chatid" type="text" value="${esc(tg.chatId || '')}" placeholder="-1001234567890" style="width:100%;margin:2px 0 8px;padding:6px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg-0);color:var(--text-0);font-size:.85em;">
          <label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-bottom:6px;"><input type="checkbox" id="cmp-ativo" ${tg.ativo ? 'checked' : ''}> Ativo (enviar alertas)</label>
          <label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-bottom:10px;"><input type="checkbox" id="cmp-todas" ${cfg.notifTodas ? 'checked' : ''}> Notificar <b>todas</b> as mensagens (ignorar palavras-chave)</label>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary btn-sm" id="cmp-save-tg">Salvar</button>
            <button class="btn btn-ghost btn-sm" id="cmp-test-tg">Testar</button>
            <span id="cmp-tg-msg" style="font-size:.78em;align-self:center;"></span>
          </div>
        </div>
        <div style="background:var(--bg-2);border:1px solid var(--border);border-radius:var(--r-md);padding:14px;">
          <div style="font-weight:600;margin-bottom:8px;">🔑 Palavras-chave (só notifica quando aparecem)</div>
          <div style="display:flex;gap:6px;margin-bottom:8px;">
            <input id="cmp-nova-palavra" type="text" placeholder="ex: recurso, habilitação…" style="flex:1;padding:6px 8px;border-radius:5px;border:1px solid var(--border);background:var(--bg-0);color:var(--text-0);font-size:.85em;">
            <button class="btn btn-primary btn-sm" id="cmp-add-palavra">+ Add</button>
          </div>
          <div id="cmp-palavras" style="display:flex;flex-wrap:wrap;gap:6px;"></div>
        </div>
      </div>`;

    function tgMsg(t, ok) { const m = document.getElementById('cmp-tg-msg'); m.style.color = ok ? 'var(--success)' : 'var(--danger)'; m.textContent = t; setTimeout(() => { m.textContent = ''; }, 2500); }

    document.getElementById('cmp-save-tg').onclick = async () => {
      const body = { botToken: document.getElementById('cmp-token').value.trim() || undefined, chatId: document.getElementById('cmp-chatid').value.trim(), ativo: document.getElementById('cmp-ativo').checked };
      try {
        let r = await (await fetch(`/api/chat-monitor/${portal}/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
        if (!r.success) throw new Error(r.error);
        await fetch(`/api/chat-monitor/${portal}/notif-todas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifTodas: document.getElementById('cmp-todas').checked }) });
        tgMsg('✅ salvo', true); renderChatConfigPanel(containerId, portal);
      } catch (e) { tgMsg('❌ ' + e.message, false); }
    };
    document.getElementById('cmp-test-tg').onclick = async () => {
      tgMsg('enviando…', true);
      try { const r = await (await fetch(`/api/chat-monitor/${portal}/telegram/testar`, { method: 'POST' })).json(); tgMsg(r.success ? '✅ enviado' : '❌ ' + (r.error || 'falhou'), r.success); }
      catch (e) { tgMsg('❌ ' + e.message, false); }
    };

    function renderPalavras() {
      const cont = document.getElementById('cmp-palavras');
      const ps = cfg.palavras || [];
      cont.innerHTML = ps.length ? ps.map(p => `<span style="display:inline-flex;align-items:center;gap:5px;background:var(--bg-3);border:1px solid var(--border);border-radius:12px;padding:3px 10px;font-size:.8em;">${esc(p.palavra)}<span data-id="${p.id}" class="cmp-del" style="cursor:pointer;color:var(--danger);font-weight:700;">×</span></span>`).join('') : '<span style="color:var(--text-3);font-size:.8em;">Nenhuma — este portal não notifica nada até ter palavra-chave (ou marcar "todas").</span>';
      cont.querySelectorAll('.cmp-del').forEach(x => x.onclick = async () => {
        await fetch(`/api/chat-monitor/${portal}/palavras/${x.getAttribute('data-id')}`, { method: 'DELETE' });
        cfg.palavras = cfg.palavras.filter(p => String(p.id) !== x.getAttribute('data-id')); renderPalavras();
      });
    }
    async function addPalavra() {
      const inp = document.getElementById('cmp-nova-palavra'); const v = inp.value.trim(); if (!v) return;
      try { const r = await (await fetch(`/api/chat-monitor/${portal}/palavras`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ palavra: v }) })).json(); if (!r.success) throw new Error(r.error); }
      catch (e) { return; }
      const rp = await (await fetch(`/api/chat-monitor/${portal}/palavras`)).json(); cfg.palavras = rp.palavras || []; inp.value = ''; renderPalavras();
    }
    document.getElementById('cmp-add-palavra').onclick = addPalavra;
    document.getElementById('cmp-nova-palavra').addEventListener('keydown', e => { if (e.key === 'Enter') addPalavra(); });
    renderPalavras();
  };
})();
