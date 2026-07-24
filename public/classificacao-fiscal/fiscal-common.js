// Helpers compartilhados entre classificacao.html (individual) e lote.html.
// Renderização de impostos/CEST/benefícios, UF, regime tributário, verNcm e toast.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const soDig = (s) => String(s || '').replace(/\D/g, '');
let __ultimo = null; // re-executa a última ação individual ao trocar de UF/regime

const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
(function initUf() {
  const sel = $('uf');
  if (!sel) return;
  sel.innerHTML = UFS.map((u) => `<option value="${u}"${u === 'SP' ? ' selected' : ''}>${u}</option>`).join('');
})();
const getUf = () => ($('uf') && $('uf').value) || 'SP';

// Regime tributário da empresa — define a alíquota de PIS/COFINS no regime normal.
const REGIME_OPTS = [['real', 'Lucro Real'], ['presumido', 'Lucro Presumido'], ['simples', 'Simples Nacional']];
const REGIME_PC = {
  real:      { total: 9.25, pis: 1.65, cofins: 7.60, nome: 'não-cumulativo' },
  presumido: { total: 3.65, pis: 0.65, cofins: 3.00, nome: 'cumulativo' },
  simples:   { total: null, pis: null, cofins: null, nome: 'Simples Nacional' },
};
(function initRegime() {
  const sel = $('regime');
  if (!sel) return;
  const saved = localStorage.getItem('fiscalRegime') || 'simples';
  sel.innerHTML = REGIME_OPTS.map(([v, l]) => `<option value="${v}"${v === saved ? ' selected' : ''}>${l}</option>`).join('');
})();
const getRegime = () => ($('regime') && $('regime').value) || localStorage.getItem('fiscalRegime') || 'simples';
function setRegime(v) {
  localStorage.setItem('fiscalRegime', v);
  // PIS/COFINS normal é só apresentação: cada página decide se re-renderiza ou re-busca.
  if (typeof onRegimeChange === 'function') onRegimeChange();
  else if (typeof reprocessar === 'function') reprocessar();
}

const pct = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%');
const REGIME_LABEL = { normal: 'Normal', monofasico: 'Monofásico', aliquota_zero: 'Alíquota zero', st: 'Substituição tributária' };

// Resolve PIS/COFINS: regime especial do NCM (se houver) sobrepõe; senão usa o regime da empresa.
function pisCofinsDados(pc) {
  const especial = pc && pc.regime && pc.regime !== 'normal';
  if (especial) {
    const lbl = REGIME_LABEL[pc.regime] || pc.regime;
    const det = (pc.pis != null || pc.cofins != null) ? `PIS ${pct(pc.pis)} / COFINS ${pct(pc.cofins)}` : 'regime especial do NCM';
    return { valor: lbl, detalhe: det, fonte: pc && pc.fonte };
  }
  const reg = REGIME_PC[getRegime()] || REGIME_PC.real;
  if (reg.total == null) return { valor: 'no DAS', detalhe: 'Simples Nacional — recolhido no DAS', fonte: null };
  return { valor: pct(reg.total), detalhe: `${reg.nome} · PIS ${pct(reg.pis)} / COFINS ${pct(reg.cofins)}`, fonte: null };
}

const impTile = (label, value, sub) => `<div class="kpi"><div class="label">${label}</div><div class="value" style="font-size:1.25em">${value}</div>${sub ? `<div style="font-size:.72em;color:var(--text-3);margin-top:3px">${sub}</div>` : ''}</div>`;

function blocoImpostos(imp) {
  if (!imp) return '';
  const uf = esc(imp.uf);
  const ipi = !imp.ipi ? '—' : (imp.ipi.nt ? 'NT' : pct(imp.ipi.aliquota));
  const ipiSub = imp.ipi && imp.ipi.nt ? 'não tributado' : '';
  const ii = imp.ii ? pct(imp.ii.aliquota) : '—';
  const icms = imp.icms ? pct(imp.icms.aliquota_interna) : '—';
  const icmsSub = imp.icms && imp.icms.fcp_incluido ? 'FCP incluído' : '';
  const pc = pisCofinsDados(imp.pis_cofins);
  const pcSub = pc.detalhe + (pc.fonte ? ' · ' + esc(pc.fonte) : '');

  const st = imp.icms_st;
  let stLinha;
  if (st && st.tem_st && st.mva_original != null) {
    stLinha = `<b>MVA ${pct(st.mva_original)}</b> · alíq. interna ${pct(st.aliquota_interna)} · CEST ${esc(st.cest_fmt)}${st.ato ? ` <span style="font-size:.85em;color:var(--text-3)">${esc(st.ato)}</span>` : ''}`;
  } else if (st && st.tem_st) {
    stLinha = `<span style="color:var(--text-2)">sujeito a ST · MVA no convênio/protocolo (não consolidada no RICMS)</span> <span style="font-size:.85em;color:var(--text-3)">CEST ${esc(st.cest_fmt)}${st.ato ? ' · ' + esc(st.ato) : ''}</span>`;
  } else if (st && !st.tem_st) {
    stLinha = `<span style="color:var(--text-2)">não sujeito a ST em ${uf}</span> <span style="font-size:.85em;color:var(--text-3)">(CEST ${esc(st.cest_fmt)})</span>`;
  } else {
    stLinha = `<span style="color:var(--text-3)">não disponível para ${uf} (planilha CONFAZ cobre AP, BA, MS, PE, PR, SC, SP)</span>`;
  }

  return `<div style="border-top:1px solid var(--border);padding-top:14px;margin-top:2px">
    <b style="color:var(--text-2)">Impostos — ${uf}</b>
    <div class="kpi-grid" style="margin:10px 0 0">
      ${impTile('IPI', ipi, ipiSub)}
      ${impTile('II · Importação', ii, '')}
      ${impTile('ICMS interno', icms, icmsSub)}
      ${impTile('PIS/COFINS', pc.valor, pcSub)}
    </div>
    <div style="margin-top:10px;padding:10px 14px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--bg-1)">
      <span style="color:var(--text-3);font-size:.72em;text-transform:uppercase;letter-spacing:.06em;font-weight:600">ICMS-ST</span>
      <div style="margin-top:4px">${stLinha}</div>
    </div>
    ${blocoBeneficio(imp.beneficio)}
    <div style="margin-top:8px;color:var(--text-3);font-size:.8em">IPI/II oficiais · ICMS interno com FCP embutido · PIS/COFINS conforme o regime selecionado · ICMS-ST/MVA da planilha CONFAZ (8 UFs). Confirme conforme a operação.</div>
  </div>`;
}

const BENEF_LABEL = {
  cesta_basica: 'Cesta básica',
  reducao_base_industrial: 'Máquinas/equip. industriais (Conv. 52/91)',
  reducao_base_agricola: 'Máquinas/implementos agrícolas (Conv. 52/91)',
};
function blocoBeneficio(b) {
  if (!b) return '';
  const nome = BENEF_LABEL[b.tipo] || b.tipo;
  const mecanismo = b.credito_pontos != null
    ? `crédito presumido de ${pct(b.credito_pontos)} sobre alíquota ${pct(b.aliquota_base)}`
    : 'redução de base de cálculo';
  const red = b.reducao_pp != null ? ` · <b>redução de ${pct(b.reducao_pp)}</b> vs. ICMS normal` : '';
  return `<div style="margin-top:10px;padding:10px 12px;border-radius:var(--r-md);background:var(--success-bg,#12351f);color:var(--success,#4ade80)">
    🎁 <b>Benefício fiscal (PA): ${esc(nome)}</b> — carga efetiva de ICMS <b>≈ ${pct(b.carga_efetiva)}</b> (${mecanismo})${red}
    ${b.observacao ? `<div style="margin-top:4px;font-size:.8em;color:var(--text-2)">${esc(b.observacao)}</div>` : ''}
  </div>`;
}

const BADGE = {
  alta:  'background:var(--success-bg,#12351f);color:var(--success,#4ade80);',
  exato: 'background:var(--success-bg,#12351f);color:var(--success,#4ade80);',
  media: 'background:var(--warn-bg,#3a2f12);color:var(--warn,#fbbf24);',
  baixa: 'background:var(--danger-bg,#3a1616);color:var(--danger,#f87171);',
};
const badge = (conf) => `<span style="padding:2px 10px;border-radius:999px;font-size:.78em;font-weight:600;${BADGE[conf]||BADGE.baixa}">${esc(conf)}</span>`;
const nomeFonte = (f) => f === 'busca' ? 'busca oficial' : f === 'codigo' ? 'código direto' : 'conhecimento IA';

function cestLinha(cest) {
  if (!cest || !cest.length) return '<span style="color:var(--text-3)">Sem CEST (produto pode não estar sujeito à ST).</span>';
  return cest.map((c) => `<div style="padding:6px 0;border-top:1px solid var(--border)"><b style="font-family:var(--font-mono,monospace)">${esc(c.cest_fmt)}</b> <span style="color:var(--text-2)">${esc(c.descricao)}</span> <span style="color:var(--text-3);font-size:.82em">· casa NCM ${esc(c.ncm_prefix)}</span></div>`).join('');
}

// Consulta direta de um NCM (usada pelo clique nos resultados individuais e do lote).
async function verNcm(codigo) {
  __ultimo = () => verNcm(codigo);
  try {
    const r = await fetch('/api/fiscal/ncm/' + encodeURIComponent(codigo) + '?uf=' + getUf()).then((x) => x.json());
    if (!r.success) return toast(r.error || 'NCM não encontrado', 'warn');
    const n = r.ncm;
    render(`<div class="card" style="padding:22px;display:flex;flex-direction:column;gap:12px">
      <div style="font-size:1.5em;font-weight:700;font-family:var(--font-mono,monospace)">${esc(n.codigo_fmt)}</div>
      <div style="color:var(--text-1)">${esc(n.descricao_caminho)}</div>
      <div><b style="color:var(--text-2)">CEST:</b><div style="margin-top:4px">${cestLinha(n.cest)}</div></div>
      ${blocoImpostos(n.impostos)}
    </div>`);
  } catch (e) { toast('Erro: ' + e.message, 'warn'); }
}

const errCard = (m) => `<div class="card" style="padding:18px;color:var(--danger)">${esc(m || 'Erro')}</div>`;
function render(html) { $('saida').innerHTML = html; }
function toast(msg, tipo) {
  const box = $('toasts'); const el = document.createElement('div');
  el.className = 'toast ' + (tipo || 'success'); el.textContent = msg;
  box.appendChild(el); setTimeout(() => el.remove(), 3500);
}
