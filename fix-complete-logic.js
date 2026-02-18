const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// Corrigir a lógica de marcação de captura completa
const oldLogic = `  // Verifica se realmente capturou todas as páginas antes de marcar como completa
  const capturouTodas = (paginaInicial === totalPaginas && paginaAtual <= 1);

  if (compraId) {
    if (capturouTodas) {
      await atualizarProgresso(compraId, info, totalPaginas, totalPaginas, totalMensagensCapturadas, true);
      log(\`✓ Captura COMPLETA! \${totalPaginas} páginas, \${totalMensagensCapturadas} mensagens\`);
    } else {
      // Captura incompleta - NÃO marca como completa
      await atualizarProgresso(compraId, info, paginaAtual, totalPaginas, totalMensagensCapturadas, false);
      log(\`⚠ Captura INCOMPLETA: páginas \${paginaAtual}-\${paginaInicial} de \${totalPaginas}\`);
    }
  }

  log(\`Total capturado: \${todasMensagens.length} mensagens de \${totalPaginas} páginas (ordem reversa)\`);`;

const newLogic = `  // Verifica se capturou todas as páginas - se chegou na página 1, está completa
  const capturouTodas = (paginaAtual <= 1);
  // Calcula total real de páginas baseado na página inicial (que era a última)
  const totalPaginasReal = Math.max(totalPaginas, paginaInicial);

  if (compraId) {
    if (capturouTodas) {
      await atualizarProgresso(compraId, info, totalPaginasReal, totalPaginasReal, totalMensagensCapturadas, true);
      log(\`✓ Captura COMPLETA! \${totalPaginasReal} páginas, \${totalMensagensCapturadas} mensagens\`);
    } else {
      // Captura incompleta - NÃO marca como completa
      await atualizarProgresso(compraId, info, paginaAtual, totalPaginasReal, totalMensagensCapturadas, false);
      log(\`⚠ Captura INCOMPLETA: páginas \${paginaAtual}-\${paginaInicial} de \${totalPaginasReal}\`);
    }
  }

  log(\`Total capturado: \${todasMensagens.length} mensagens de \${totalPaginasReal} páginas (ordem reversa)\`);`;

if (content.includes(oldLogic)) {
  content = content.replace(oldLogic, newLogic);
  fs.writeFileSync('extensao-monitor/content.js', content);
  console.log('✓ Lógica de captura completa corrigida');
} else {
  console.log('✗ Código não encontrado - pode já ter sido corrigido');
}
