/* landing.js — Licite Agora landing common scripts (Plano 11) */
(function() {
  // Injeta o sprite SVG de ícones se ainda não existir na página.
  // Permite que outras páginas (planos/recursos/contato/trial/aguardando)
  // reusem os ícones sem duplicar as defs.
  if (!document.getElementById('lct-icons-sprite')) {
    const sprite = document.createElement('div');
    sprite.id = 'lct-icons-sprite';
    sprite.style.display = 'none';
    sprite.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <symbol id="i-zap" viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></symbol>
      <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></symbol>
      <symbol id="i-sparkles" viewBox="0 0 24 24"><path d="M12 3v2m0 14v2M5.22 5.22l1.42 1.42m10.72 10.72l1.42 1.42M3 12h2m14 0h2M5.22 18.78l1.42-1.42m10.72-10.72l1.42-1.42"/><path d="M12 8l1.5 3L16 12.5 13.5 14 12 17l-1.5-3L8 12.5 10.5 11 12 8z"/></symbol>
      <symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></symbol>
      <symbol id="i-trophy" viewBox="0 0 24 24"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2z"/></symbol>
      <symbol id="i-file-text" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></symbol>
      <symbol id="i-receipt" viewBox="0 0 24 24"><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1-2-1z"/><path d="M16 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/></symbol>
      <symbol id="i-wallet" viewBox="0 0 24 24"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z"/></symbol>
      <symbol id="i-edit" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></symbol>
      <symbol id="i-briefcase" viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></symbol>
      <symbol id="i-box" viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></symbol>
      <symbol id="i-store" viewBox="0 0 24 24"><path d="M4 4h16l-1 6a4 4 0 0 1-4 3H9a4 4 0 0 1-4-3L4 4z"/><path d="M6 13v8h12v-8"/><path d="M10 16h4"/></symbol>
      <symbol id="i-users" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
      <symbol id="i-megaphone" viewBox="0 0 24 24"><path d="M3 11l18-5v12L3 13v-2z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></symbol>
      <symbol id="i-globe" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></symbol>
      <symbol id="i-building" viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="9" y1="22" x2="9" y2="18"/><line x1="15" y1="22" x2="15" y2="18"/></symbol>
      <symbol id="i-code" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></symbol>
      <symbol id="i-wrench" viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></symbol>
      <symbol id="i-cart" viewBox="0 0 24 24"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></symbol>
      <symbol id="i-trending-up" viewBox="0 0 24 24"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></symbol>
      <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></symbol>
      <symbol id="i-check" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></symbol>
      <symbol id="i-arrow-right" viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></symbol>
      <symbol id="i-mail" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></symbol>
      <symbol id="i-phone" viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></symbol>
      <symbol id="i-map-pin" viewBox="0 0 24 24"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></symbol>
      <symbol id="i-lock" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></symbol>
    </svg>`;
    document.body.insertBefore(sprite, document.body.firstChild);
  }
  // Mobile menu toggle
  const btnMenu = document.getElementById('btnMenu');
  const navLinks = document.getElementById('navLinks');
  if (btnMenu && navLinks) {
    btnMenu.addEventListener('click', () => {
      navLinks.classList.toggle('open');
    });
  }

  // FAQ accordion
  document.querySelectorAll('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-q');
    if (!q) return;
    q.addEventListener('click', () => {
      item.classList.toggle('open');
    });
  });

  // Pricing toggle mensal/anual
  const pricingSwitch = document.getElementById('pricingSwitch');
  if (pricingSwitch) {
    pricingSwitch.addEventListener('click', () => {
      const on = pricingSwitch.classList.toggle('on');
      document.body.dataset.billing = on ? 'anual' : 'mensal';
      document.querySelectorAll('[data-price-mensal]').forEach(el => {
        el.querySelector('.amount').textContent = on ? el.dataset.priceAnual : el.dataset.priceMensal;
      });
      document.querySelectorAll('[data-billing-label-mensal]').forEach(el => {
        el.textContent = on ? el.dataset.billingLabelAnual : el.dataset.billingLabelMensal;
      });
    });
  }

  // Filtro + busca em /recursos
  const modulosGrid = document.getElementById('modulosGrid');
  if (modulosGrid) {
    fetch('/modulos.json').then(r => r.json()).then(data => {
      const SECOES_ORDEM = ['Licitações', 'Operacional', 'Comercial', 'Produtos & Estoque', 'Varejo', 'Financeiro', 'Fiscal', 'RH & Acesso', 'Comunicação', 'Configurações'];
      const todos = data.modulos;
      let filtroSecao = null;
      let filtroBusca = '';
      let modoDestaques = false;

      function render() {
        let lista = todos.slice();
        if (modoDestaques) lista = lista.filter(m => m.destaque);
        if (filtroSecao) lista = lista.filter(m => m.secao === filtroSecao);
        if (filtroBusca) {
          const q = filtroBusca.toLowerCase();
          lista = lista.filter(m =>
            m.nome.toLowerCase().includes(q) ||
            (m.descricao || '').toLowerCase().includes(q) ||
            m.secao.toLowerCase().includes(q)
          );
        }
        // Ordenar por seção
        lista.sort((a, b) => SECOES_ORDEM.indexOf(a.secao) - SECOES_ORDEM.indexOf(b.secao));

        if (lista.length === 0) {
          modulosGrid.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-3);grid-column:1/-1;">Nenhum módulo encontrado.</div>';
          return;
        }

        modulosGrid.innerHTML = lista.map(m => `
          <div class="mod-card">
            <div class="mod-secao">${m.secao}</div>
            <div class="mod-head">
              <span class="mod-icon">${m.icone}</span>
              <span class="mod-nome">${m.nome}</span>
            </div>
            <div class="mod-desc">${m.descricao || ''}</div>
          </div>
        `).join('');

        document.getElementById('modulosCount').textContent = lista.length;
      }

      // Popular chips
      const chipsContainer = document.getElementById('chips');
      const secoesUnicas = SECOES_ORDEM.filter(s => todos.some(m => m.secao === s));
      chipsContainer.innerHTML =
        `<button class="chip active" data-secao="">Todos</button>` +
        secoesUnicas.map(s => `<button class="chip" data-secao="${s}">${s}</button>`).join('');

      chipsContainer.addEventListener('click', (e) => {
        if (e.target.classList.contains('chip')) {
          chipsContainer.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
          e.target.classList.add('active');
          filtroSecao = e.target.dataset.secao || null;
          render();
        }
      });

      const searchInput = document.getElementById('moduloSearch');
      if (searchInput) {
        let timer;
        searchInput.addEventListener('input', () => {
          clearTimeout(timer);
          timer = setTimeout(() => { filtroBusca = searchInput.value.trim(); render(); }, 150);
        });
      }

      const toggleDestaques = document.getElementById('toggleDestaques');
      if (toggleDestaques) {
        toggleDestaques.addEventListener('click', () => {
          modoDestaques = !modoDestaques;
          toggleDestaques.textContent = modoDestaques ? 'Ver todos os módulos' : 'Ver só destaques';
          toggleDestaques.classList.toggle('active', modoDestaques);
          render();
        });
      }

      render();
    }).catch(err => {
      modulosGrid.innerHTML = '<div style="padding:40px;text-align:center;color:var(--red);grid-column:1/-1;">Erro ao carregar módulos.</div>';
      console.error(err);
    });
  }

  // Toast helper
  window.toast = function(msg, tipo) {
    const el = document.createElement('div');
    el.className = `toast ${tipo || ''}`;
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => {
      el.classList.remove('show');
      setTimeout(() => el.remove(), 400);
    }, 4000);
  };

  // Form AJAX helper
  window.submitForm = async function(formEl, endpoint, onSuccess) {
    const btn = formEl.querySelector('button[type="submit"]');
    const btnOrig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const body = {};
      new FormData(formEl).forEach((v, k) => { body[k] = v.trim ? v.trim() : v; });
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) {
        toast(data.error || `Erro ${r.status}`, 'error');
      } else {
        if (onSuccess) onSuccess(data);
        else toast('Recebemos! Entraremos em contato em breve.', 'success');
        formEl.reset();
      }
    } catch (err) {
      toast('Falha na rede: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = btnOrig;
    }
  };

  // Smooth scroll para anchors
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id === '#' || id.length < 2) return;
      const el = document.querySelector(id);
      if (el) {
        e.preventDefault();
        window.scrollTo({ top: el.offsetTop - 80, behavior: 'smooth' });
      }
    });
  });

  // ================== ANIMAÇÕES DINÂMICAS ==================

  // 1. Typewriter — alterna a parte final do H1 ("...que vivem de licitações")
  const tw = document.getElementById('typewriter');
  if (tw) {
    const frases = [
      'que vivem de licitações',
      'que disputam pregões',
      'que vendem ao governo',
      'que não param de crescer',
    ];
    let idx = 0, pos = 0, removendo = false;
    function tick() {
      const frase = frases[idx];
      if (!removendo) {
        pos++;
        tw.textContent = frase.slice(0, pos);
        if (pos === frase.length) {
          removendo = true;
          setTimeout(tick, 2200);
          return;
        }
        setTimeout(tick, 55);
      } else {
        pos--;
        tw.textContent = frase.slice(0, pos);
        if (pos === 0) {
          removendo = false;
          idx = (idx + 1) % frases.length;
          setTimeout(tick, 200);
          return;
        }
        setTimeout(tick, 25);
      }
    }
    tick();
  }

  // 2. Contadores animados — [data-count="322000"] conta de 0 ao target
  function animarContador(el) {
    const target = parseInt(el.dataset.count, 10);
    if (!target || isNaN(target)) return;
    const prefix = el.dataset.prefix || '';
    const suffix = el.dataset.suffix || '';
    const duracao = 1400;
    const inicio = performance.now();
    function passo(agora) {
      const t = Math.min((agora - inicio) / duracao, 1);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      const valor = Math.floor(target * eased);
      el.textContent = prefix + valor.toLocaleString('pt-BR') + suffix;
      if (t < 1) requestAnimationFrame(passo);
      else el.textContent = prefix + (el.dataset.final || target.toLocaleString('pt-BR')) + suffix;
    }
    requestAnimationFrame(passo);
  }

  // 3. IntersectionObserver — dispara animações ao entrar em viewport
  if ('IntersectionObserver' in window) {
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        if (el.classList.contains('reveal')) el.classList.add('in');
        if (el.dataset.count) animarContador(el);
        obs.unobserve(el);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -10% 0px' });

    document.querySelectorAll('.reveal, [data-count]').forEach(el => obs.observe(el));
  } else {
    // Fallback: remove classe reveal e mostra contadores como target direto
    document.querySelectorAll('.reveal').forEach(el => el.classList.add('in'));
    document.querySelectorAll('[data-count]').forEach(el => {
      const n = parseInt(el.dataset.count, 10) || 0;
      el.textContent = (el.dataset.prefix || '') + n.toLocaleString('pt-BR') + (el.dataset.suffix || '');
    });
  }

  // 4. Ticker ao vivo no mockup do hero — lances que "chegam"
  const tickerContainer = document.getElementById('lanceTicker');
  if (tickerContainer) {
    const pregoes = [
      { num: '127/2026', item: 'item 3', valor: 'R$ 14.820,00', status: 'win' },
      { num: '84/2026',  item: 'item 12', valor: 'R$ 6.450,00', status: 'active' },
      { num: '201/2026', item: 'item 5', valor: 'R$ 28.900,00', status: 'win' },
      { num: '45/2026',  item: 'item 2', valor: 'R$ 4.120,00', status: 'active' },
      { num: '76/2026',  item: 'item 9', valor: 'R$ 19.670,00', status: 'win' },
      { num: '158/2026', item: 'item 1', valor: 'R$ 52.400,00', status: 'win' },
      { num: '91/2026',  item: 'item 8', valor: 'R$ 3.180,00', status: 'active' },
    ];
    let cursor = 0;
    const MAX_ROWS = 2;

    function addLance() {
      const p = pregoes[cursor % pregoes.length];
      cursor++;
      const row = document.createElement('div');
      row.className = 'mock-row new-row';
      const dotColor = p.status === 'win' ? '#10b981' : '#f59e0b';
      const valorColor = p.status === 'win' ? 'var(--green)' : '#f59e0b';
      row.innerHTML = `
        <div class="mock-dot" style="background:${dotColor};box-shadow:0 0 8px ${dotColor};"></div>
        <div class="mock-label">Pregão ${p.num} · ${p.item}</div>
        <div class="mock-valor" style="color:${valorColor};">${p.valor}</div>
      `;
      tickerContainer.insertBefore(row, tickerContainer.firstChild);

      // Flash verde por 1.5s
      setTimeout(() => row.classList.add('flash'), 500);

      // Remove linhas excedentes (com fade-out)
      const linhas = tickerContainer.querySelectorAll('.mock-row');
      if (linhas.length > MAX_ROWS) {
        const last = linhas[linhas.length - 1];
        last.style.transition = 'all 0.4s ease-out';
        last.style.opacity = '0';
        last.style.maxHeight = '0';
        last.style.paddingTop = '0';
        last.style.paddingBottom = '0';
        last.style.marginTop = '-8px';
        setTimeout(() => last.remove(), 400);
      }
    }

    // Primeiro lance aparece 2s após load; depois a cada 4-6s aleatório
    setTimeout(function agendar() {
      addLance();
      setTimeout(agendar, 4000 + Math.random() * 2500);
    }, 2000);
  }
})();
