const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// Remove o código corrompido (exatamente como aparece)
const badCode = `  }
}/\${total}\`;
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
}

// Processa`;

const goodCode = `  }
}

// Processa`;

if (content.includes(badCode)) {
  content = content.replace(badCode, goodCode);
  fs.writeFileSync('extensao-monitor/content.js', content);
  console.log('✓ Código corrompido removido');
} else {
  console.log('Padrão exato não encontrado, usando regex...');

  // Usar regex para encontrar o código corrompido
  const regex = /\}\n\}\/\$\{total\}\`;[\s\S]*?textContent = `⚠ \$\{puladas\}[\s\S]*?\}\n\}/;
  if (regex.test(content)) {
    content = content.replace(regex, '}\n}');
    fs.writeFileSync('extensao-monitor/content.js', content);
    console.log('✓ Código corrompido removido (regex)');
  } else {
    console.log('Não encontrado');
  }
}
