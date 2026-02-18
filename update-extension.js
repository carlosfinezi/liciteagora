const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// 1. Adicionar variável para armazenar licitações já capturadas (logo após SERVER_URL)
const afterServerUrl = "const SERVER_URL = 'http://localhost:3000';";
const newVars = `const SERVER_URL = 'http://localhost:3000';

// Lista de licitações já capturadas completamente (carregada do servidor)
let licitacoesJaCapturadas = new Set();

// Intervalo para salvar sessão no servidor (a cada 30 segundos)
let salvarSessaoInterval = null;`;

content = content.replace(afterServerUrl, newVars);

// 2. Adicionar funções de sincronização com servidor (após a função log)
const afterLogFunction = `  if (debugLogs.length % 5 === 0) {
    enviarLogsParaServidor();
  }
}`;

const newFunctions = `  if (debugLogs.length % 5 === 0) {
    enviarLogsParaServidor();
  }
}

// ==================== SINCRONIZAÇÃO COM SERVIDOR ====================

// Carrega lista de licitações já capturadas do servidor
async function carregarLicitacoesCapturadas() {
  try {
    const res = await fetch(\`\${SERVER_URL}/api/chat/captura/completas\`);
    const data = await res.json();
    if (data.success && data.data) {
      licitacoesJaCapturadas = new Set(data.data);
      log(\`[Servidor] Carregadas \${licitacoesJaCapturadas.size} licitações já capturadas\`);
    }
  } catch (e) {
    log('[Servidor] Erro ao carregar licitações capturadas: ' + e.message);
  }
}

// Verifica se uma licitação específica já foi capturada
function licitacaoJaCapturada(compraId) {
  return licitacoesJaCapturadas.has(compraId);
}

// Marca licitação como capturada localmente
function marcarLicitacaoCapturada(compraId) {
  licitacoesJaCapturadas.add(compraId);
}

// Salva progresso da sessão no servidor
async function salvarSessaoNoServidor() {
  try {
    const dados = await chrome.storage.local.get([
      'monitoramentoAtivo', 'statusAtualNome', 'paginaAtual',
      'licitacoesProcessadas', 'totalLicitacoes'
    ]);

    if (!dados.monitoramentoAtivo) return;

    await fetch(\`\${SERVER_URL}/api/chat/monitoramento/sessao\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        statusAtual: dados.statusAtualNome || 'Em andamento',
        paginaAtual: dados.paginaAtual || 1,
        indiceLicitacao: dados.licitacoesProcessadas || 0,
        totalLicitacoes: dados.totalLicitacoes || 0,
        licitacoesProcessadas: Array.from(licitacoesJaCapturadas)
      })
    });
    log('[Servidor] Sessão salva');
  } catch (e) {
    // Silencioso para não poluir logs
  }
}

// Carrega sessão anterior do servidor
async function carregarSessaoDoServidor() {
  try {
    const res = await fetch(\`\${SERVER_URL}/api/chat/monitoramento/sessao\`);
    const data = await res.json();
    if (data.success && data.data) {
      log('[Servidor] Sessão anterior encontrada: ' + data.data.statusAtual + ', lic ' + data.data.indiceLicitacao + '/' + data.data.totalLicitacoes);
      return data.data;
    }
  } catch (e) {
    log('[Servidor] Erro ao carregar sessão: ' + e.message);
  }
  return null;
}

// Limpa sessão no servidor
async function limparSessaoNoServidor() {
  try {
    await fetch(\`\${SERVER_URL}/api/chat/monitoramento/sessao\`, { method: 'DELETE' });
    log('[Servidor] Sessão encerrada');
  } catch (e) {
    // Silencioso
  }
}

// Inicia salvamento periódico da sessão
function iniciarSalvamentoPeriodicoSessao() {
  if (salvarSessaoInterval) clearInterval(salvarSessaoInterval);
  salvarSessaoInterval = setInterval(salvarSessaoNoServidor, 30000); // A cada 30 segundos
}

// Para salvamento periódico
function pararSalvamentoPeriodicoSessao() {
  if (salvarSessaoInterval) {
    clearInterval(salvarSessaoInterval);
    salvarSessaoInterval = null;
  }
}`;

content = content.replace(afterLogFunction, newFunctions);

// 3. Modificar monitorarMultiStatus para carregar licitações capturadas e sessão anterior
const monitorarStart = "log('=== INICIANDO MONITORAMENTO AUTOMÁTICO (MULTI-STATUS) ===');";
const monitorarStartNew = `log('=== INICIANDO MONITORAMENTO AUTOMÁTICO (MULTI-STATUS) ===');

  // Carrega licitações já capturadas do servidor
  await carregarLicitacoesCapturadas();

  // Verifica se há sessão anterior para retomar
  const sessaoAnterior = await carregarSessaoDoServidor();
  if (sessaoAnterior && sessaoAnterior.indiceLicitacao > 0) {
    const retomar = confirm(\`Sessão anterior encontrada:\\n\\nStatus: \${sessaoAnterior.statusAtual}\\nProgresso: \${sessaoAnterior.indiceLicitacao}/\${sessaoAnterior.totalLicitacoes}\\n\\nDeseja retomar de onde parou?\`);
    if (retomar) {
      // Encontra o índice do status
      const statusIndex = statusParaProcessar.findIndex(s =>
        s.status.toLowerCase().includes(sessaoAnterior.statusAtual.toLowerCase()) ||
        sessaoAnterior.statusAtual.toLowerCase().includes(s.status.toLowerCase())
      );
      if (statusIndex >= 0) {
        statusInicialIndex = statusIndex;
        paginaInicial = sessaoAnterior.paginaAtual || 1;
        // Calcula índice dentro da página
        const licitacoesPorPagina = 10;
        const licitacoesAntesDaPagina = (paginaInicial - 1) * licitacoesPorPagina;
        indiceInicial = Math.max(0, sessaoAnterior.indiceLicitacao - licitacoesAntesDaPagina) % licitacoesPorPagina;
        log(\`[Retomando] Status: \${statusParaProcessar[statusIndex].status}, Página: \${paginaInicial}, Índice: \${indiceInicial}\`);
      }
    } else {
      // Usuário escolheu não retomar, limpa sessão
      await limparSessaoNoServidor();
    }
  }

  // Inicia salvamento periódico
  iniciarSalvamentoPeriodicoSessao();`;

content = content.replace(monitorarStart, monitorarStartNew);

// 4. Adicionar verificação de licitação já capturada antes de processar
// Procurar onde clica no botão da licitação
const beforeClickBotao = "log(`Clicando no botão da licitação...`);";
const beforeClickBotaoNew = `// Verifica se esta licitação já foi capturada
      const compraIdAtual = extrairCompraIdDaLinha(botoesLicitacao[indice]);
      if (compraIdAtual && licitacaoJaCapturada(compraIdAtual)) {
        log(\`⏭ Pulando licitação \${compraIdAtual} (já capturada)\`);
        await chrome.storage.local.set({
          licitacoesProcessadas: processadas + 1
        });
        continue;
      }

      log(\`Clicando no botão da licitação...\`);`;

content = content.replace(beforeClickBotao, beforeClickBotaoNew);

// 5. Adicionar função para extrair compraId da linha da tabela
const afterExtrairCompraId = "// Processa todas as licitações da página atual";
const extrairCompraIdFunc = `// Extrai compraId de uma linha da tabela
function extrairCompraIdDaLinha(botao) {
  try {
    // Tenta encontrar o compraId na linha da tabela
    const row = botao.closest('tr') || botao.closest('[role="row"]');
    if (!row) return null;

    // Procura por um link ou texto que contenha o padrão do compraId
    const texto = row.innerText;
    const match = texto.match(/(\\d{8,14})/);
    if (match) return match[1];

    // Tenta extrair da URL se houver um link
    const link = row.querySelector('a[href*="compra="]');
    if (link) {
      const urlMatch = link.href.match(/compra=([\\d]+)/);
      if (urlMatch) return urlMatch[1];
    }
  } catch (e) {
    // Silencioso
  }
  return null;
}

// Processa todas as licitações da página atual`;

content = content.replace(afterExtrairCompraId, extrairCompraIdFunc);

// 6. Marcar licitação como capturada após enviar mensagens com sucesso
const afterEnviarMensagens = "[Extensão Chrome] Recebidas";
// Vamos adicionar após o envio bem sucedido das mensagens
const marcarCapturada = `// Marca como capturada localmente
          if (licitacao.compraId) {
            marcarLicitacaoCapturada(licitacao.compraId);
          }

          console.log('[Extensão Chrome] Recebidas`;

content = content.replace("console.log('[Extensão Chrome] Recebidas", marcarCapturada);

// 7. Parar salvamento e limpar sessão ao finalizar monitoramento
const finalizarMonitoramento = "log('Monitoramento finalizado');";
if (content.includes(finalizarMonitoramento)) {
  content = content.replace(finalizarMonitoramento, `pararSalvamentoPeriodicoSessao();
      await limparSessaoNoServidor();
      log('Monitoramento finalizado');`);
}

fs.writeFileSync('extensao-monitor/content.js', content);
console.log('Extensão atualizada com sucesso!');
console.log('Mudanças aplicadas:');
console.log('1. Carrega licitações já capturadas do servidor');
console.log('2. Salva sessão periodicamente (30s)');
console.log('3. Oferece retomar sessão anterior');
console.log('4. Pula licitações já capturadas');
console.log('5. Limpa sessão ao finalizar');
