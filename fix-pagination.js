const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

// Corrigir a função de captura de páginas
// O problema é que marca como completa mesmo sem capturar todas as páginas

// 1. Adicionar verificação da página atual após navegação
const oldNavigation = `// ORDEM REVERSA: Vai para a ÚLTIMA página primeiro
  if (totalPaginas > 1) {
    log(\`Navegando para última página (\${totalPaginas})...\`);

    // Tenta clicar no botão "última página" (>>)
    if (ultimaPaginaBtn && !ultimaPaginaBtn.classList.contains('p-disabled')) {
      ultimaPaginaBtn.click();
      await aguardar(1500);
    } else {
      // Navega página por página até a última
      for (let p = 1; p < totalPaginas; p++) {
        const btnProximo = document.querySelector('.p-paginator-next:not(.p-disabled)');
        if (btnProximo) {
          btnProximo.click();
          await aguardar(600);
        } else {
          break;
        }
      }
    }
  }

  let paginaAtual = totalPaginas;`;

const newNavigation = `// ORDEM REVERSA: Vai para a ÚLTIMA página primeiro
  let paginaAtual = 1; // Começa na página 1, será atualizado após navegação

  if (totalPaginas > 1) {
    log(\`Navegando para última página (\${totalPaginas})...\`);

    // Tenta clicar no botão "última página" (>>)
    if (ultimaPaginaBtn && !ultimaPaginaBtn.classList.contains('p-disabled')) {
      ultimaPaginaBtn.click();
      await aguardar(2000); // Mais tempo para carregar
    } else {
      // Navega página por página até a última
      for (let p = 1; p < totalPaginas; p++) {
        const btnProximo = document.querySelector('.p-paginator-next:not(.p-disabled)');
        if (btnProximo) {
          btnProximo.click();
          await aguardar(800);
        } else {
          log('Navegação interrompida - botão próximo não disponível');
          break;
        }
      }
    }

    // VERIFICA em qual página realmente estamos após navegação
    await aguardar(1000);
    const paginaAtiva = document.querySelector('.p-paginator-page.p-highlight, .p-paginator-page[aria-current="page"]');
    if (paginaAtiva) {
      paginaAtual = parseInt(paginaAtiva.innerText) || totalPaginas;
      log(\`Navegação: agora na página \${paginaAtual}\`);
    } else {
      // Fallback: assume que navegou para a última
      paginaAtual = totalPaginas;
      log(\`Navegação: assumindo página \${paginaAtual} (fallback)\`);
    }
  }

  // Guarda a página inicial para verificar no final
  const paginaInicial = paginaAtual;`;

if (content.includes(oldNavigation)) {
  content = content.replace(oldNavigation, newNavigation);
  console.log('✓ Navegação corrigida');
} else {
  console.log('✗ Código de navegação não encontrado');
}

// 2. Corrigir a validação de captura completa
const oldComplete = `// Marca como captura completa
  if (compraId) {
    await atualizarProgresso(compraId, info, 1, totalPaginas, totalMensagensCapturadas, true);
    log(\`Captura completa! Progresso salvo.\`);
  }`;

const newComplete = `// Verifica se realmente capturou todas as páginas antes de marcar como completa
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
  }`;

if (content.includes(oldComplete)) {
  content = content.replace(oldComplete, newComplete);
  console.log('✓ Validação de captura completa corrigida');
} else {
  console.log('✗ Código de captura completa não encontrado');
}

fs.writeFileSync('extensao-monitor/content.js', content);
console.log('\nExtensão atualizada!');
