async function initMe(){
  const r = await fetch('/portal/api/me');
  if (!r.ok) { window.location.href='/portal/login.html'; return false; }
  const d = await r.json();
  if (!d.success) { window.location.href='/portal/login.html'; return false; }
  const el = document.getElementById('razao'); if (el) el.textContent = d.cliente.razaoSocial;
  return true;
}
async function logout(){ await fetch('/portal/api/logout',{method:'POST'}); window.location.href='/portal/login.html'; }
