const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// Remove bloco duplicado
const duplicateBlock = `// Contadores de licitações puladas (por motivo)
let licitacoesPuladasMotivos = {
  jaCapturada: 0,
  acessoNegado: 0,
  urlPublica: 0,
  naoNavegou: 0,
  erro: 0
};

function resetContadoresPuladas() {
  licitacoesPuladasMotivos = { jaCapturada: 0, acessoNegado: 0, urlPublica: 0, naoNavegou: 0, erro: 0 };
}

function getTotalPuladas() {
  return Object.values(licitacoesPuladasMotivos).reduce((a, b) => a + b, 0);
}

function getResumoPuladas() {
  const motivos = [];
  if (licitacoesPuladasMotivos.jaCapturada > 0) motivos.push(licitacoesPuladasMotivos.jaCapturada + ' já capturadas');
  if (licitacoesPuladasMotivos.acessoNegado > 0) motivos.push(licitacoesPuladasMotivos.acessoNegado + ' acesso negado');
  if (licitacoesPuladasMotivos.urlPublica > 0) motivos.push(licitacoesPuladasMotivos.urlPublica + ' URL pública');
  if (licitacoesPuladasMotivos.naoNavegou > 0) motivos.push(licitacoesPuladasMotivos.naoNavegou + ' não navegou');
  if (licitacoesPuladasMotivos.erro > 0) motivos.push(licitacoesPuladasMotivos.erro + ' erros');
  return motivos.join(', ') || 'nenhuma';
}

// Contadores de licitações puladas (por motivo)`;

const keepBlock = `// Contadores de licitações puladas (por motivo)`;

if (content.includes(duplicateBlock)) {
  content = content.replace(duplicateBlock, keepBlock);
  fs.writeFileSync('extensao-monitor/content.js', content);
  console.log('✓ Bloco duplicado removido');
} else {
  console.log('Bloco duplicado não encontrado');
}

// Remove linha duplicada de naoNavegou
const duplicateLine = `licitacoesPuladasMotivos.naoNavegou++;
        licitacoesPuladasMotivos.naoNavegou++;`;

const singleLine = `licitacoesPuladasMotivos.naoNavegou++;`;

if (content.includes(duplicateLine)) {
  content = content.replace(duplicateLine, singleLine);
  fs.writeFileSync('extensao-monitor/content.js', content);
  console.log('✓ Linha duplicada naoNavegou removida');
}

console.log('\n✅ Duplicatas corrigidas!');
