const fs = require('fs');
let content = fs.readFileSync('server.js', 'utf8');

// Código dos novos endpoints
const newEndpoints = `
// ==================== SESSÃO DE MONITORAMENTO (EXTENSÃO) ====================

// Obter sessão de monitoramento ativa
app.get('/api/chat/monitoramento/sessao', (req, res) => {
  try {
    const sessao = db.prepare('SELECT * FROM monitoramento_sessao WHERE ativo = 1 ORDER BY dataAtualizacao DESC LIMIT 1').get();
    if (sessao) {
      sessao.licitacoesProcessadas = JSON.parse(sessao.licitacoesProcessadas || '[]');
    }
    res.json({ success: true, data: sessao || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Salvar progresso da sessão de monitoramento
app.post('/api/chat/monitoramento/sessao', (req, res) => {
  try {
    const { statusAtual, paginaAtual, indiceLicitacao, totalLicitacoes, licitacoesProcessadas } = req.body;

    // Desativa sessões anteriores
    db.prepare('UPDATE monitoramento_sessao SET ativo = 0').run();

    // Insere nova sessão
    db.prepare(\`
      INSERT INTO monitoramento_sessao (statusAtual, paginaAtual, indiceLicitacao, totalLicitacoes, licitacoesProcessadas, ativo, dataAtualizacao)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    \`).run(
      statusAtual || 'Em andamento',
      paginaAtual || 1,
      indiceLicitacao || 0,
      totalLicitacoes || 0,
      JSON.stringify(licitacoesProcessadas || [])
    );

    console.log('[Sessão] Progresso salvo: ' + statusAtual + ', lic ' + indiceLicitacao + '/' + totalLicitacoes);
    res.json({ success: true, message: 'Sessão salva' });
  } catch (error) {
    console.error('[Sessão] Erro ao salvar:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Limpar sessão de monitoramento
app.delete('/api/chat/monitoramento/sessao', (req, res) => {
  try {
    db.prepare('UPDATE monitoramento_sessao SET ativo = 0').run();
    console.log('[Sessão] Sessão encerrada');
    res.json({ success: true, message: 'Sessão encerrada' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verificar se licitação já foi capturada completamente
app.get('/api/chat/captura/verificar/:compraId', (req, res) => {
  try {
    const { compraId } = req.params;
    const progresso = db.prepare('SELECT capturaCompleta, totalMensagensCapturadas FROM chat_captura_progresso WHERE compraId = ?').get(compraId);

    if (progresso && progresso.capturaCompleta) {
      res.json({ success: true, capturada: true, totalMensagens: progresso.totalMensagensCapturadas });
    } else {
      res.json({ success: true, capturada: false });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Listar licitações já capturadas (para pular)
app.get('/api/chat/captura/completas', (req, res) => {
  try {
    const completas = db.prepare('SELECT compraId FROM chat_captura_progresso WHERE capturaCompleta = 1').all();
    res.json({ success: true, data: completas.map(c => c.compraId) });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

`;

// Encontrar onde inserir (antes de ROTAS DO MONITOR DE MENSAGENS)
const marker = '// ==================== ROTAS DO MONITOR DE MENSAGENS ====================';
const markerIndex = content.indexOf(marker);

if (markerIndex === -1) {
  console.log('Marcador não encontrado!');
  process.exit(1);
}

// Inserir antes do marcador
content = content.slice(0, markerIndex) + newEndpoints + content.slice(markerIndex);

fs.writeFileSync('server.js', content);
console.log('Endpoints de sessão adicionados com sucesso!');
