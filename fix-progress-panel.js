const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// 1. Adicionar contador de licitações puladas (após as variáveis globais iniciais)
const afterKeepAlive = "let keepAliveTimer = null;";
const addCounters = `let keepAliveTimer = null;

// Contadores de licitações puladas (por motivo)
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
}`;

if (content.includes(afterKeepAlive)) {
  content = content.replace(afterKeepAlive, addCounters);
  console.log('✓ Contadores de puladas adicionados');
}

// 2. Corrigir o status "Finalizado" para mostrar informação correta
const oldFinish = `} else {
      log(\`Todos os status processados. \${dados.licitacoesProcessadas}/\${dados.totalLicitacoes} licitações.\`);
      atualizarPainelProgresso(dados.licitacoesProcessadas, dados.totalLicitacoes, 'Finalizado');
      await chrome.storage.local.set({ monitoramentoAtivo: false });
    }`;

const newFinish = `} else {
      const puladas = dados.totalLicitacoes - dados.licitacoesProcessadas;
      log(\`Todos os status processados. \${dados.licitacoesProcessadas}/\${dados.totalLicitacoes} licitações.\`);
      log(\`Puladas: \${puladas} (\${getResumoPuladas()})\`);
      atualizarPainelProgresso(dados.licitacoesProcessadas, dados.totalLicitacoes, \`Parcial - \${puladas} puladas\`);
      await chrome.storage.local.set({ monitoramentoAtivo: false });
      alert(\`Monitoramento finalizado!\\n\\nProcessadas: \${dados.licitacoesProcessadas}/\${dados.totalLicitacoes}\\nPuladas: \${puladas}\\n\\nMotivos: \${getResumoPuladas()}\`);
    }`;

if (content.includes(oldFinish)) {
  content = content.replace(oldFinish, newFinish);
  console.log('✓ Status de finalização corrigido');
}

// 3. Incrementar contador quando pula por URL pública/acesso negado
const oldPublicUrl = `log('⚠ URL pública ou acesso negado detectado - pulando licitação');
        await chrome.storage.local.set({ licitacoesProcessadas: processadas + 1 });`;

const newPublicUrl = `log('⚠ URL pública ou acesso negado detectado - pulando licitação');
        if (urlAtual.includes('/public/')) {
          licitacoesPuladasMotivos.urlPublica++;
        } else {
          licitacoesPuladasMotivos.acessoNegado++;
        }
        await chrome.storage.local.set({ licitacoesProcessadas: processadas + 1 });`;

if (content.includes(oldPublicUrl)) {
  content = content.replace(oldPublicUrl, newPublicUrl);
  console.log('✓ Contador para URL pública/acesso negado');
}

// 4. Incrementar contador quando não navegou
const oldNaoNavegou = `log('Não navegou para a página da licitação');`;
const newNaoNavegou = `log('Não navegou para a página da licitação');
        licitacoesPuladasMotivos.naoNavegou++;`;

if (content.includes(oldNaoNavegou)) {
  content = content.replace(oldNaoNavegou, newNaoNavegou);
  console.log('✓ Contador para não navegou');
}

// 5. Reset contadores ao iniciar monitoramento
const oldMonitorStart = "log('=== INICIANDO MONITORAMENTO AUTOMÁTICO (MULTI-STATUS) ===');";
const newMonitorStart = `log('=== INICIANDO MONITORAMENTO AUTOMÁTICO (MULTI-STATUS) ===');
  resetContadoresPuladas();`;

if (content.includes(oldMonitorStart)) {
  content = content.replace(oldMonitorStart, newMonitorStart);
  console.log('✓ Reset de contadores ao iniciar');
}

// 6. Melhorar função atualizarPainelProgresso para mostrar puladas
const oldPainelUpdate = `function atualizarPainelProgresso(atual, total, status) {
  const painel = document.getElementById('pncp-progress-panel');
  if (!painel) return;

  const percent = total > 0 ? Math.round((atual / total) * 100) : 0;
  const barra = painel.querySelector('.progress-bar');
  const texto = painel.querySelector('.progress-text');
  const statusEl = painel.querySelector('.progress-status');

  if (barra) barra.style.width = percent + '%';
  if (texto) texto.textContent = \`\${atual}/\${total}\`;
  if (statusEl) statusEl.textContent = status || '';
}`;

const newPainelUpdate = `function atualizarPainelProgresso(atual, total, status) {
  const painel = document.getElementById('pncp-progress-panel');
  if (!painel) return;

  const puladas = getTotalPuladas();
  const percent = total > 0 ? Math.round((atual / total) * 100) : 0;
  const barra = painel.querySelector('.progress-bar');
  const texto = painel.querySelector('.progress-text');
  const statusEl = painel.querySelector('.progress-status');
  let puladasEl = painel.querySelector('.progress-puladas');

  if (barra) barra.style.width = percent + '%';
  if (texto) texto.textContent = \`\${atual}/\${total}\`;
  if (statusEl) statusEl.textContent = status || '';

  // Mostra contador de puladas se houver
  if (puladas > 0) {
    if (!puladasEl) {
      puladasEl = document.createElement('div');
      puladasEl.className = 'progress-puladas';
      puladasEl.style.cssText = 'font-size: 10px; color: #ff9800; margin-top: 4px;';
      painel.appendChild(puladasEl);
    }
    puladasEl.textContent = \`⚠ \${puladas} puladas\`;
  }
}`;

if (content.includes(oldPainelUpdate)) {
  content = content.replace(oldPainelUpdate, newPainelUpdate);
  console.log('✓ Painel atualizado para mostrar puladas');
}

fs.writeFileSync('extensao-monitor/content.js', content);
console.log('\n✅ Extensão atualizada com tracking de licitações puladas!');
