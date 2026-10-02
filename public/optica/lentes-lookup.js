// Página genérica de cadastro de lookups de lente (tipos, materiais, índices, tratamentos).
// Cada HTML chama initLookupPage({ tipo, codigoPlaceholder, labelPlaceholder }).

let LOOKUP_TIPO = null;
let itens = [];
let editandoId = null;

function showAlert(m, t='success') {
  const e = document.getElementById('alertGlobal');
  e.className = 'alert ' + t;
  e.textContent = m;
  e.style.display = 'block';
  setTimeout(() => e.style.display = 'none', 5000);
}
function escTxt(s) { const d = document.createElement('div'); d.textContent = String(s||''); return d.innerHTML; }

async function initLookupPage(config) {
  LOOKUP_TIPO = config.tipo;
  if (config.codigoPlaceholder) document.getElementById('fCodigo').placeholder = config.codigoPlaceholder;
  if (config.labelPlaceholder) document.getElementById('fLabel').placeholder = config.labelPlaceholder;
  try {
    const r = await fetch('/api/optica/status');
    if (r.status === 401) { window.location.href = '/login.html'; return; }
    const d = await r.json();
    if (!d.enabled) {
      document.getElementById('moduleOff').style.display = '';
      return;
    }
    document.getElementById('conteudo').style.display = '';
    await carregar();
  } catch (e) {
    showAlert('Erro: ' + e.message, 'error');
  }
}

async function carregar() {
  try {
    const r = await fetch('/api/optica/lentes-lookup/' + LOOKUP_TIPO + '?todos=1');
    const d = await r.json();
    if (!d.success) throw new Error(d.error || 'falha');
    itens = d.itens || [];
    renderTabela();
  } catch (e) {
    showAlert('Erro ao carregar: ' + e.message, 'error');
    document.getElementById('tb').innerHTML = '<tr><td colspan="5" class="empty">Falha ao carregar</td></tr>';
  }
}

function renderTabela() {
  const tb = document.getElementById('tb');
  if (!itens.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">Nenhum item cadastrado</td></tr>';
    return;
  }
  tb.innerHTML = itens.map(i => `<tr style="${i.ativo?'':'opacity:0.5;'}">
    <td>${i.ordem}</td>
    <td><code>${escTxt(i.codigo)}</code></td>
    <td>${escTxt(i.label)}</td>
    <td>${i.ativo ? '<span class="badge success">ativo</span>' : '<span class="badge">inativo</span>'}</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-ghost btn-sm" onclick="editar(${i.id})">Editar</button>
      ${i.ativo
        ? `<button class="btn btn-ghost btn-sm" onclick="inativar(${i.id})">Inativar</button>`
        : `<button class="btn btn-ghost btn-sm" onclick="reativar(${i.id})">Reativar</button>`}
      <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="excluir(${i.id})">Excluir</button>
    </td>
  </tr>`).join('');
}

async function reativar(id) {
  try {
    const r = await fetch(`/api/optica/lentes-lookup/${LOOKUP_TIPO}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ativo: true }),
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error || 'falha');
    showAlert('Item reativado');
    await carregar();
  } catch (e) { showAlert('Erro: ' + e.message, 'error'); }
}

async function excluir(id) {
  const item = itens.find(x => x.id === id);
  const nome = item ? `"${item.label}"` : `#${id}`;
  if (!confirm(`Excluir ${nome} permanentemente?\n\nIsso remove o item da base. Lentes que já usam este código continuarão exibindo o código (sem o rótulo bonito).`)) return;
  try {
    const r = await fetch(`/api/optica/lentes-lookup/${LOOKUP_TIPO}/${id}?hard=1`, { method: 'DELETE' });
    const d = await r.json();
    if (!d.success) throw new Error(d.error || 'falha');
    showAlert('Item excluído');
    await carregar();
  } catch (e) { showAlert('Erro: ' + e.message, 'error'); }
}

function novo() {
  editandoId = null;
  document.getElementById('formTitulo').textContent = 'Adicionar item';
  document.getElementById('btnSalvar').textContent = 'Adicionar';
  document.getElementById('btnCancelar').style.display = 'none';
  document.getElementById('fCodigo').value = '';
  document.getElementById('fLabel').value = '';
  document.getElementById('fOrdem').value = '999';
  document.getElementById('fCodigo').focus();
}

function editar(id) {
  const item = itens.find(x => x.id === id);
  if (!item) return;
  editandoId = id;
  document.getElementById('formTitulo').textContent = 'Editando #' + id;
  document.getElementById('btnSalvar').textContent = 'Salvar alterações';
  document.getElementById('btnCancelar').style.display = '';
  document.getElementById('fCodigo').value = item.codigo;
  document.getElementById('fLabel').value = item.label;
  document.getElementById('fOrdem').value = item.ordem;
  document.getElementById('fCodigo').focus();
}

async function salvar() {
  const body = {
    codigo: document.getElementById('fCodigo').value.trim(),
    label: document.getElementById('fLabel').value.trim(),
    ordem: document.getElementById('fOrdem').value || 999,
  };
  if (!body.codigo || !body.label) return showAlert('Código e rótulo obrigatórios', 'error');
  const url = editandoId
    ? `/api/optica/lentes-lookup/${LOOKUP_TIPO}/${editandoId}`
    : `/api/optica/lentes-lookup/${LOOKUP_TIPO}`;
  try {
    const r = await fetch(url, {
      method: editandoId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error || 'falha');
    showAlert(editandoId ? 'Item atualizado' : 'Item adicionado');
    novo();
    await carregar();
  } catch (e) { showAlert('Erro: ' + e.message, 'error'); }
}

async function inativar(id) {
  if (!confirm('Inativar este item? Lentes que já o usam continuam exibindo o código.')) return;
  try {
    const r = await fetch(`/api/optica/lentes-lookup/${LOOKUP_TIPO}/${id}`, { method: 'DELETE' });
    const d = await r.json();
    if (!d.success) throw new Error(d.error || 'falha');
    showAlert('Item inativado');
    await carregar();
  } catch (e) { showAlert('Erro: ' + e.message, 'error'); }
}
