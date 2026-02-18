const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// Adicionar verificação de URL pública ou acesso negado após 'Navegou para:'
const oldCode = `log('Navegou para: ' + urlAtual);
      atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Na página da licitação...');`;

const newCode = `log('Navegou para: ' + urlAtual);

      // Verifica se caiu em URL pública ou acesso negado
      if (urlAtual.includes('/public/') || urlAtual.includes('acesso-nao-autorizado')) {
        log('⚠ URL pública ou acesso negado detectado - pulando licitação');
        await chrome.storage.local.set({ licitacoesProcessadas: processadas + 1 });
        // Volta para a lista
        window.location.href = 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/seguro/fornecedor/compras';
        return;
      }

      atualizarPainelProgresso(processadas + 1, dados.totalLicitacoes, 'Na página da licitação...');`;

if (content.includes(oldCode)) {
  content = content.replace(oldCode, newCode);
  fs.writeFileSync('extensao-monitor/content.js', content);
  console.log('Verificação de URL pública adicionada!');
} else {
  console.log('Código original não encontrado - pode já ter sido modificado');
}
