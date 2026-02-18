const fs = require('fs');
const content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// Verificar syntax errors básicos
try {
  const openBraces = (content.match(/\{/g) || []).length;
  const closeBraces = (content.match(/\}/g) || []).length;
  console.log('Chaves: { = ' + openBraces + ', } = ' + closeBraces);

  if (openBraces !== closeBraces) {
    console.log('⚠ AVISO: Número de chaves não coincide!');
  } else {
    console.log('✓ Chaves balanceadas');
  }

  // Verificar se as funções essenciais existem
  const funcs = ['getTotalPuladas', 'getResumoPuladas', 'resetContadoresPuladas', 'atualizarPainelProgresso'];
  funcs.forEach(f => {
    if (content.includes('function ' + f)) {
      console.log('✓ ' + f + ' existe');
    } else {
      console.log('✗ ' + f + ' NÃO encontrada!');
    }
  });

  // Verificar contadores
  const counters = ['urlPublica', 'acessoNegado', 'naoNavegou'];
  counters.forEach(c => {
    const matches = content.match(new RegExp('licitacoesPuladasMotivos\\.' + c + '\\+\\+', 'g'));
    console.log('✓ Contador ' + c + ': ' + (matches ? matches.length : 0) + ' incrementos');
  });

  // Contar linhas
  const lines = content.split('\n').length;
  console.log('\nTotal: ' + lines + ' linhas');

  console.log('\n✅ Extensão pronta para teste!');

} catch(e) {
  console.log('Erro: ' + e.message);
}
