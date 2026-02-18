const fs = require('fs');
let content = fs.readFileSync('extensao-monitor/content.js', 'utf8');

const oldFunc = `function extrairMensagensDoChat() {
  const mensagens = [];
  const sidebar = document.querySelector('.p-sidebar-content');
  if (!sidebar) return mensagens;

  const textoCompleto = sidebar.innerText || '';
  const blocos = textoCompleto.split(/(?=Mensagem do |Enviada em )/g);

  blocos.forEach(bloco => {
    const texto = bloco.trim();
    if (texto.length > 20) {
      const ignorar = ['Visualize aqui', 'Não há mensagens', 'Captcha', 'Tente mais tarde', 'Fechar', 'Sessão Pública'];
      if (!ignorar.some(i => texto.includes(i)) && !mensagens.some(m => m.texto === texto)) {
        // Extrair data/hora real da mensagem do Comprasnet
        // Formato: "Enviada em 27/03/2024 às 08:32:09h"
        let dataHora = new Date().toISOString();
        const matchData = texto.match(/Enviada em (\\d{2})\\/(\\d{2})\\/(\\d{4}) às (\\d{2}):(\\d{2}):(\\d{2})h?/);
        if (matchData) {
          const [, dia, mes, ano, hora, minuto, segundo] = matchData;
          const dataMsg = new Date(ano, mes - 1, dia, hora, minuto, segundo);
          if (!isNaN(dataMsg.getTime())) {
            dataHora = dataMsg.toISOString();
          }
        }

        mensagens.push({
          texto: texto,
          remetente: texto.includes('Participante') ? 'Participante' : 'Sistema',
          dataHora: dataHora
        });
      }
    }
  });

  return mensagens;`;

const newFunc = `function extrairMensagensDoChat() {
  const mensagens = [];
  const sidebar = document.querySelector('.p-sidebar-content');
  if (!sidebar) return mensagens;

  const textoCompleto = sidebar.innerText || '';

  // Split apenas em "Mensagem do" para manter "Enviada em" junto com a mensagem anterior
  const blocos = textoCompleto.split(/(?=Mensagem do )/g);

  blocos.forEach((bloco, index) => {
    const texto = bloco.trim();
    if (texto.length > 20 && texto.startsWith('Mensagem do')) {
      const ignorar = ['Visualize aqui', 'Não há mensagens', 'Captcha', 'Tente mais tarde', 'Fechar', 'Sessão Pública'];
      if (!ignorar.some(i => texto.includes(i))) {
        // Extrair data/hora real da mensagem do Comprasnet
        // Formato: "Enviada em 27/03/2024 às 08:32:09h" - pode estar neste bloco ou no próximo
        let dataHora = new Date().toISOString();

        // Primeiro tenta encontrar no próprio bloco
        let matchData = texto.match(/Enviada em (\\d{2})\\/(\\d{2})\\/(\\d{4}) às (\\d{2}):(\\d{2}):(\\d{2})h?/);

        // Se não encontrou, olha no próximo bloco (caso "Enviada em" tenha ficado separado)
        if (!matchData && blocos[index + 1]) {
          const proximoBloco = blocos[index + 1];
          if (proximoBloco.trim().startsWith('Enviada em')) {
            matchData = proximoBloco.match(/Enviada em (\\d{2})\\/(\\d{2})\\/(\\d{4}) às (\\d{2}):(\\d{2}):(\\d{2})h?/);
          }
        }

        if (matchData) {
          const [, dia, mes, ano, hora, minuto, segundo] = matchData;
          const dataMsg = new Date(ano, mes - 1, dia, hora, minuto, segundo);
          if (!isNaN(dataMsg.getTime())) {
            dataHora = dataMsg.toISOString();
          }
        }

        // Remove "Enviada em..." do texto se estiver no final
        const textoLimpo = texto.replace(/\\n?Enviada em \\d{2}\\/\\d{2}\\/\\d{4} às \\d{2}:\\d{2}:\\d{2}h?.*$/s, '').trim();

        if (!mensagens.some(m => m.texto === textoLimpo)) {
          mensagens.push({
            texto: textoLimpo,
            remetente: texto.includes('Participante') ? 'Participante' : 'Sistema',
            dataHora: dataHora
          });
        }
      }
    }
  });

  return mensagens;`;

if (content.includes(oldFunc)) {
  content = content.replace(oldFunc, newFunc);
  fs.writeFileSync('extensao-monitor/content.js', content);
  console.log('✓ Função extrairMensagensDoChat corrigida para extrair data corretamente');
} else {
  console.log('Função não encontrada exatamente - verificando...');

  // Tentar match parcial
  if (content.includes('blocos.forEach(bloco =>')) {
    console.log('A função antiga ainda existe mas com diferenças de formatação');
    console.log('Tentando substituição mais flexível...');

    // Substituir apenas a linha do split
    const oldSplit = "const blocos = textoCompleto.split(/(?=Mensagem do |Enviada em )/g);";
    const newSplit = "const blocos = textoCompleto.split(/(?=Mensagem do )/g);";

    if (content.includes(oldSplit)) {
      content = content.replace(oldSplit, newSplit);
      fs.writeFileSync('extensao-monitor/content.js', content);
      console.log('✓ Split corrigido (parcial)');
    }
  }
}
