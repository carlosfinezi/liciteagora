const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// Atualizar função atualizarPainelProgresso para mostrar puladas
const oldFunc = `// Atualiza painel de progresso
function atualizarPainelProgresso(atual, total, status) {
  const texto = document.getElementById('progresso-texto');
  const statusEl = document.getElementById('progresso-status');
  const barra = document.getElementById('progresso-barra');

  if (texto) texto.textContent = \`Processando \${atual}/\${total}\`;
  if (statusEl) statusEl.textContent = status;
  if (barra) barra.style.width = \`\${(atual/total)*100}%\`;
}`;

const newFunc = `// Atualiza painel de progresso
function atualizarPainelProgresso(atual, total, status) {
  const texto = document.getElementById('progresso-texto');
  const statusEl = document.getElementById('progresso-status');
  const barra = document.getElementById('progresso-barra');
  let puladasEl = document.getElementById('progresso-puladas');
  const puladas = typeof getTotalPuladas === 'function' ? getTotalPuladas() : 0;

  if (texto) texto.textContent = \`Processando \${atual}/\${total}\`;
  if (statusEl) statusEl.textContent = status;
  if (barra) barra.style.width = \`\${(atual/total)*100}%\`;

  // Mostra contador de puladas se houver
  if (puladas > 0 && !puladasEl) {
    const painel = document.getElementById('monitor-progresso');
    if (painel) {
      puladasEl = document.createElement('div');
      puladasEl.id = 'progresso-puladas';
      puladasEl.style.cssText = 'font-size: 11px; color: #ff9800; margin-top: 8px;';
      const btnParar = document.getElementById('btn-parar-monitor');
      if (btnParar) {
        painel.insertBefore(puladasEl, btnParar);
      } else {
        painel.appendChild(puladasEl);
      }
    }
  }
  if (puladasEl && puladas > 0) {
    const resumo = typeof getResumoPuladas === 'function' ? getResumoPuladas() : '';
    puladasEl.textContent = \`⚠ \${puladas} puladas\${resumo ? ' (' + resumo + ')' : ''}\`;
  }
}`;

if (content.includes(oldFunc)) {
  content = content.replace(oldFunc, newFunc);
  fs.writeFileSync('extensao-monitor/content.js', content);
  console.log('✓ Painel atualizado para mostrar puladas');
} else {
  console.log('✗ Função não encontrada - formato pode ter mudado');

  // Tentar match parcial
  const regex = /\/\/ Atualiza painel de progresso\nfunction atualizarPainelProgresso\(atual, total, status\) \{[^}]+\}/;
  if (regex.test(content)) {
    content = content.replace(regex, newFunc);
    fs.writeFileSync('extensao-monitor/content.js', content);
    console.log('✓ Painel atualizado (match parcial)');
  }
}
