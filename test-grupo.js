const http = require('http');

http.get('http://localhost:3000/api/grupos-palavras/1/pesquisar', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log('Success:', json.success);
    console.log('Total resultados:', json.data?.length);
    console.log('Total palavras:', json.totalPalavras);

    const pouso = json.data?.find(l => l.nomeUnidade?.includes('Pouso'));
    console.log('Pouso Novo encontrado:', pouso ? 'SIM' : 'NAO');
    if (pouso) {
      console.log('  ->', pouso.sequencialCompra + '/' + pouso.anoCompra, pouso.nomeUnidade);
    }

    console.log('\nPrimeiros 5 resultados:');
    json.data?.slice(0, 5).forEach(l => {
      console.log(' -', l.sequencialCompra + '/' + l.anoCompra, l.nomeUnidade?.substring(0, 50));
    });
  });
}).on('error', e => console.log('Erro:', e.message));
