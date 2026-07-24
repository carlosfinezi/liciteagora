/**
 * optica/pedido-tab.js — Aba "Receita Óptica" injetada em pedido.html
 *
 * Carregamento opcional. Self-contained: não depende de variáveis internas
 * do pedido.html (busca dados via /api/optica/pedido/:id/contexto).
 *
 * Hook points:
 *   - window.ativarAba(aba)  ← interceptado para tratar aba "receita-optica"
 *   - GET /api/optica/status ← gate da feature flag
 *   - DOM #pedTabs + .ped-painel ← layout do pedido.html
 */
(async function() {
  // 1) Feature flag — sai cedo se módulo desligado
  let cache;
  try { cache = JSON.parse(localStorage.getItem('featuresCache')||'{}'); } catch { cache = {}; }
  let opticaEnabled = cache.optica === true;
  if (!opticaEnabled) {
    try {
      const r = await fetch('/api/optica/status');
      if (!r.ok) return;
      const d = await r.json();
      if (!d.enabled) return;
      opticaEnabled = true;
    } catch { return; }
  }

  // 2) PEDIDO_ID da URL
  const params = new URLSearchParams(location.search);
  const PEDIDO_ID = params.get('id');
  if (!PEDIDO_ID) return;

  // 3) Espera pedTabs renderizar (pedido.html chama renderAbas após carregar)
  function waitFor(sel, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function tick() {
        const el = document.querySelector(sel);
        if (el && el.children.length) return resolve(el);
        if (Date.now() - start > timeoutMs) return reject(new Error('timeout'));
        setTimeout(tick, 100);
      })();
    });
  }

  let pedTabs;
  try { pedTabs = await waitFor('#pedTabs'); } catch { return; }

  // 4) Busca contexto óptico do pedido
  let ctx;
  try {
    const r = await fetch(`/api/optica/pedido/${PEDIDO_ID}/contexto`);
    if (!r.ok) return;
    const d = await r.json();
    if (!d.success || !d.itens || !d.itens.length) return; // sem item-lente, não injeta tab
    ctx = d;
  } catch { return; }

  // 5) Injeta tab e painel
  if (pedTabs.querySelector('[data-aba="receita-optica"]')) return;
  const btn = document.createElement('button');
  btn.className = 'ped-tab';
  btn.dataset.aba = 'receita-optica';
  btn.textContent = 'Receita Óptica';
  btn.onclick = () => window.ativarAba('receita-optica');
  // Insere após "Itens"
  const itensBtn = pedTabs.querySelector('[data-aba="itens"]');
  if (itensBtn && itensBtn.nextSibling) pedTabs.insertBefore(btn, itensBtn.nextSibling);
  else pedTabs.appendChild(btn);

  // Painel
  let painel = document.querySelector('.ped-painel[data-aba="receita-optica"]');
  if (!painel) {
    painel = document.createElement('div');
    painel.className = 'ped-painel';
    painel.dataset.aba = 'receita-optica';
    painel.innerHTML = '<div id="receitaOpticaConteudo" class="panel" style="margin:14px 28px;">Carregando…</div>';
    const irmao = document.querySelector('.ped-painel[data-aba="itens"]');
    if (irmao && irmao.parentNode) irmao.parentNode.insertBefore(painel, irmao.nextSibling);
    else document.body.appendChild(painel);
  }

  // 6) Hook em ativarAba pra carregar conteúdo on-demand
  if (typeof window.ativarAba === 'function' && !window.__opticaTabHooked) {
    window.__opticaTabHooked = true;
    const orig = window.ativarAba;
    window.ativarAba = async function(aba) {
      const r = await orig.apply(this, arguments);
      if (aba === 'receita-optica') renderConteudo();
      return r;
    };
  }

  function fmtData(s) { if (!s) return '—'; const p = String(s).split('-'); return p.length>=3 ? `${p[2]}/${p[1]}/${p[0]}` : s; }
  function fmtN(v) { if (v==null||v==='') return '—'; const n = Number(v); return (n>=0?'+':'') + n.toFixed(2); }
  function escTxt(s) { const d=document.createElement('div'); d.textContent=String(s||''); return d.innerHTML; }

  function statusReceita(r) {
    const hoje = new Date().toISOString().slice(0,10);
    if (r.dataValidade && String(r.dataValidade).slice(0,10) < hoje) return 'vencida';
    if (r.dataReceita) {
      const dr = new Date(r.dataReceita);
      const um_ano = new Date(); um_ano.setFullYear(um_ano.getFullYear() - 1);
      if (dr < um_ano) return 'antiga';
    }
    return 'ok';
  }

  function renderConteudo() {
    const div = document.getElementById('receitaOpticaConteudo');
    if (!div) return;
    const receitasOpts = ctx.receitas.map(r => {
      const st = statusReceita(r);
      const tag = st === 'vencida' ? ' [VENCIDA]' : st === 'antiga' ? ' [>1 ano]' : '';
      return `<option value="${r.id}">${fmtData(r.dataReceita)} · ${escTxt(r.medico||'sem médico')} · OD ${fmtN(r.od_esferico)}/${fmtN(r.od_cilindrico)} · OE ${fmtN(r.oe_esferico)}/${fmtN(r.oe_cilindrico)}${tag}</option>`;
    }).join('');
    const linkNova = ctx.clienteId
      ? `<a href="/optica/receitas.html" target="_blank">Cadastrar nova receita</a>`
      : `<span class="muted">Defina o cliente para cadastrar receitas</span>`;

    let avisoReceita = '';
    if (ctx.clienteId) {
      if (!ctx.receitas.length) {
        avisoReceita = `<div class="alert" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:8px 12px;border-radius:var(--r-sm);margin-bottom:12px;">⚠ Cliente sem receitas cadastradas. <a href="/optica/receitas.html" target="_blank" style="color:#92400e;text-decoration:underline;">Cadastrar agora</a></div>`;
      } else {
        const ordenadas = ctx.receitas.slice().sort((a,b) => String(b.dataReceita||'').localeCompare(String(a.dataReceita||'')));
        const maisRecente = ordenadas[0];
        const st = statusReceita(maisRecente);
        if (st === 'vencida') {
          avisoReceita = `<div class="alert" style="background:#fee2e2;color:#991b1b;border:1px solid #fca5a5;padding:8px 12px;border-radius:var(--r-sm);margin-bottom:12px;">⚠ Receita mais recente do cliente está <strong>vencida</strong> (${fmtData(maisRecente.dataValidade)}). Confirme se aceita ou peça nova.</div>`;
        } else if (st === 'antiga') {
          avisoReceita = `<div class="alert" style="background:#fef3c7;color:#92400e;border:1px solid #fcd34d;padding:8px 12px;border-radius:var(--r-sm);margin-bottom:12px;">⚠ Receita mais recente tem mais de 1 ano (${fmtData(maisRecente.dataReceita)}). Considere pedir uma nova.</div>`;
        }
      }
    }
    const html = ctx.itens.map(it => {
      const trats = (it.tratamentos||'').split(',').filter(Boolean).join(', ');
      const detalheLente = [it.lenteTipo, it.lenteMaterial, it.indiceRefracao, trats].filter(Boolean).join(' · ');
      const opts = `<option value="">— sem receita —</option>${receitasOpts}`;
      const sel = `<select data-item="${it.pedidoItemId}" class="optica-receita-sel" style="min-width:340px;">${opts}</select>`;
      return `<div style="border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
          <div>
            <strong>${escTxt(it.descricao)}</strong>
            <div><small class="muted">qtd ${it.quantidade} · ${escTxt(detalheLente||'lente')}</small></div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <label style="font-size:12px;">Olho:
              <select data-item-olho="${it.pedidoItemId}" style="min-width:90px;">
                <option value="">par</option>
                <option value="OD">OD</option>
                <option value="OE">OE</option>
              </select>
            </label>
            ${sel}
          </div>
        </div>
      </div>`;
    }).join('');
    const omStatusBadge = (om) => {
      const map = {
        aguardando:  { cor:'#475569', bg:'#f1f5f9', icon:'⏳', txt:'Aguardando envio' },
        laboratorio: { cor:'#1d4ed8', bg:'#dbeafe', icon:'🔵', txt:'No laboratório' },
        pronto:      { cor:'#166534', bg:'#dcfce7', icon:'🟢', txt:'OM PRONTA — avisar cliente' },
        entregue:    { cor:'#475569', bg:'#f1f5f9', icon:'✅', txt:'Entregue' },
        cancelada:   { cor:'#991b1b', bg:'#fee2e2', icon:'🔴', txt:'OM cancelada' },
      };
      const m = map[om.status] || { cor:'#475569', bg:'#f1f5f9', icon:'·', txt: om.status };
      return `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;background:${m.bg};color:${m.cor};font-weight:600;font-size:12px;margin-right:10px;">${m.icon} OM ${escTxt(om.numero)} — ${m.txt}</span>`;
    };
    const omAcoes = ctx.omAtual
      ? `${omStatusBadge(ctx.omAtual)}
         <a href="/api/optica/ordens-montagem/${ctx.omAtual.id}/pdf" target="_blank" class="btn btn-ghost">📄 PDF do laboratório</a>
         <a href="/optica/ordens-montagem.html" target="_blank" class="btn btn-ghost">Abrir OM</a>`
      : `<button class="btn btn-secondary" onclick="window.opticaPedidoTab.gerarOM()">+ Gerar Ordem de Montagem</button>`;
    div.innerHTML = `
      <h3 style="margin:0 0 6px 0;">Receita Óptica</h3>
      <p class="muted" style="margin:0 0 14px 0;">Anexe a receita correspondente a cada lente do pedido. ${linkNova}</p>
      ${avisoReceita}
      ${html}
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
        <div>${omAcoes}</div>
        <div>
          <button class="btn btn-ghost" onclick="window.opticaPedidoTab.recarregar()">Recarregar</button>
          <button class="btn btn-primary" onclick="window.opticaPedidoTab.salvar()">Salvar receitas</button>
        </div>
      </div>
    `;
    // Pré-seleciona valores atuais
    for (const it of ctx.itens) {
      const sel = div.querySelector(`select[data-item="${it.pedidoItemId}"]`);
      if (sel && it.receitaId != null) sel.value = it.receitaId;
      const oSel = div.querySelector(`select[data-item-olho="${it.pedidoItemId}"]`);
      if (oSel && it.olho) oSel.value = it.olho;
    }
  }

  async function salvar() {
    const div = document.getElementById('receitaOpticaConteudo');
    if (!div) return;
    const sels = div.querySelectorAll('select.optica-receita-sel');
    let ok = 0, erros = 0;
    for (const sel of sels) {
      const itemId = sel.dataset.item;
      const receitaId = sel.value;
      const olho = (div.querySelector(`select[data-item-olho="${itemId}"]`)||{}).value || null;
      try {
        if (!receitaId) {
          const r = await fetch(`/api/optica/pedido-item/${itemId}/receita`, { method:'DELETE' });
          // 404 (sem receita anterior) é ok aqui
          if (r.ok || r.status === 404) ok++; else erros++;
        } else {
          const r = await fetch(`/api/optica/pedido-item/${itemId}/receita`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ receitaId: Number(receitaId), olho })
          });
          const d = await r.json();
          if (d.success) ok++; else erros++;
        }
      } catch { erros++; }
    }
    if (typeof window.showAlert === 'function') {
      window.showAlert(erros ? `Salvo com ${erros} erro(s)` : 'Receitas salvas', erros ? 'error' : 'success');
    } else {
      alert(erros ? `Salvo com ${erros} erro(s)` : 'Receitas salvas');
    }
    await recarregar();
  }

  async function recarregar() {
    try {
      const r = await fetch(`/api/optica/pedido/${PEDIDO_ID}/contexto`);
      const d = await r.json();
      if (d.success) { ctx = d; renderConteudo(); }
    } catch {}
  }

  async function gerarOM() {
    if (!confirm('Gerar Ordem de Montagem para este pedido? O laboratório usará esse documento.')) return;
    try {
      const r = await fetch('/api/optica/ordens-montagem', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ pedidoId: Number(PEDIDO_ID) })
      });
      const d = await r.json();
      if (!d.success) {
        if (d.omId && confirm('Já existe OM ativa. Abrir o PDF?')) {
          window.open(`/api/optica/ordens-montagem/${d.omId}/pdf`, '_blank');
          return;
        }
        throw new Error(d.error || 'falha');
      }
      if (typeof window.showAlert === 'function') window.showAlert('OM ' + d.numero + ' criada');
      window.open(`/api/optica/ordens-montagem/${d.id}/pdf`, '_blank');
      await recarregar();
    } catch (e) {
      if (typeof window.showAlert === 'function') window.showAlert('Erro: ' + e.message, 'error');
      else alert('Erro: ' + e.message);
    }
  }

  window.opticaPedidoTab = { recarregar, salvar, gerarOM };
})();
