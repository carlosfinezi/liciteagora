/* politica-prazo.js — condições de pagamento do cliente, para as telas.
 *
 * Cinco telas perguntam a mesma coisa ao servidor (pedido, OS, PDV, contas a
 * receber e o detalhe dela): que meios este cliente aceita, em que prazo, e sob
 * qual política. Antes cada uma tinha a sua cópia do fetch e mostrava só a
 * whitelist de meios, sem dizer de onde a regra vinha — quem via "cliente
 * aceita somente boleto" não tinha como saber que política mudar.
 *
 * `window.PoliticaPrazo.carregar()` é o fetch único; `avisoHTML()` é o bloco que
 * nomeia a política e leva até ela. Quem manda continua sendo o servidor: a
 * tela esconde o que não cabe, mas é o PUT que recusa.
 */
(function () {
  const LINK = '/financeiro/politicas-prazo.html';
  const cache = new Map();

  /**
   * Condições do cliente: `{ permitidos, prazo, politica }`.
   * `permitidos` null = sem restrição; `prazo` null = sem prazo definido.
   * Identifica o cliente por `pessoaId` ou por `cpfCnpj` (o PDV só tem esse).
   * `onde`: 'vendas' (padrão) | 'compras' | 'pdv'.
   */
  async function carregar({ pessoaId = null, cpfCnpj = null, onde = 'vendas', semCache = false } = {}) {
    const vazio = { permitidos: null, prazo: null, politica: null };
    if (!pessoaId && !cpfCnpj) return vazio;
    const chave = `${pessoaId || ''}|${cpfCnpj || ''}|${onde}`;
    if (!semCache && cache.has(chave)) return cache.get(chave);
    const qs = new URLSearchParams({ onde });
    if (pessoaId) qs.set('pessoaId', pessoaId);
    if (cpfCnpj) qs.set('cpfCnpj', cpfCnpj);
    let cond = vazio;
    try {
      const d = await fetch('/api/pessoas/condicoes-pagamento?' + qs).then(r => r.json());
      if (d.success) cond = { permitidos: d.permitidos, prazo: d.prazo, politica: d.politica || null };
    } catch { /* rede fora: segue sem restrição, o servidor ainda valida */ }
    cache.set(chave, cond);
    return cond;
  }

  /** Esquece o que foi lido — usar quando a política pode ter mudado. */
  function limparCache() { cache.clear(); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /** Uma linha com o que a política determina. '' quando não há política. */
  function resumo(politica, rotulos) {
    if (!politica) return '';
    const partes = [];
    if (politica.tipo === 'vista') {
      partes.push('à vista');
    } else {
      const dias = String(politica.prazoDias || '').split('/').filter(Boolean);
      if (dias.length) partes.push(`${dias.length}× em ${dias.join('/')} dias`);
    }
    let meios = [];
    try { meios = politica.meiosPermitidos ? JSON.parse(politica.meiosPermitidos) : []; } catch { /* vazio */ }
    if (meios.length) {
      partes.push('só ' + meios.map(c => (rotulos && rotulos[c]) || c).join(', '));
    }
    if (politica.valorMinimoParcela > 0) {
      partes.push(`parcela mín. R$ ${Number(politica.valorMinimoParcela).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`);
    }
    if (politica.ignoraLimiteCredito) partes.push('ignora limite de crédito');
    return partes.join(' · ');
  }

  /**
   * Bloco de aviso para colar na tela. Vazio quando o cliente não tem política
   * nem restrição — nesse caso não há o que explicar.
   * `rotulos`: mapa tPag → nome, do próprio /api/pessoas/condicoes-pagamento.
   */
  function avisoHTML(cond, rotulos) {
    if (!cond) return '';
    if (cond.politica) {
      return `<span class="pol-chip" title="Regra vinda da política de prazo do cliente">`
        + `<strong>${esc(cond.politica.nome)}</strong>`
        + (resumo(cond.politica, rotulos) ? ` — ${esc(resumo(cond.politica, rotulos))}` : '')
        + ` <a href="${LINK}" target="_blank" rel="noopener">ver políticas</a></span>`;
    }
    if (cond.permitidos && cond.permitidos.length) {
      // Cliente ainda no formato antigo: restrição existe, política não.
      const nomes = cond.permitidos.map(c => (rotulos && rotulos[c]) || c).join(', ');
      return `<span class="pol-chip pol-chip-legado" title="Restrição gravada na ficha do cliente, sem política">`
        + `Aceita somente: ${esc(nomes)} <a href="${LINK}" target="_blank" rel="noopener">criar política</a></span>`;
    }
    return '';
  }

  // Estilo do chip junto do helper: as cinco telas não compartilham CSS além do
  // app-modern, e uma regra a mais lá pesaria em 140 páginas que não a usam.
  const css = `.pol-chip{display:inline-block;padding:3px 9px;border-radius:12px;`
    + `background:var(--bg-2,#eef2f7);color:var(--text-2,#4a5568);font-size:0.84em;line-height:1.5;}`
    + `.pol-chip a{margin-left:6px;color:var(--accent,#1971c2);text-decoration:none;}`
    + `.pol-chip a:hover{text-decoration:underline;}`
    + `.pol-chip-legado{background:var(--warn-bg,#fff4e0);color:var(--warn,#b26b00);}`;
  const tag = document.createElement('style');
  tag.textContent = css;
  document.head.appendChild(tag);

  window.PoliticaPrazo = { carregar, limparCache, resumo, avisoHTML, LINK };
})();
