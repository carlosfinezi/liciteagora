const http = require('http');

const url = 'http://localhost:3000/api/licitacoes?palavraChave=ssl,certificado+digital&dataAberturaInicial=2026-01-10&dataAberturaFinal=2026-02-08&tamanhoPagina=500';

console.log('URL:', url);

http.get(url, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    console.log('\nTotal registros:', json.data.totalRegistros);
    console.log('Dados retornados:', json.data.data?.length);

    // Procurar Pouso Novo
    const pouso = json.data.data?.find(l => l.nomeUnidade?.includes('Pouso'));
    console.log('\nPouso Novo encontrado:', pouso ? 'SIM' : 'NAO');

    if (pouso) {
      console.log('  ID:', pouso.id);
      console.log('  Nome:', pouso.nomeUnidade);
      console.log('  Seq/Ano:', pouso.sequencialCompra + '/' + pouso.anoCompra);
    }

    // Verificar se ID 234848 está nos resultados
    const byId = json.data.data?.find(l => l.id === 234848);
    console.log('\nID 234848 encontrado:', byId ? 'SIM' : 'NAO');

    // Listar alguns IDs para debug
    console.log('\nPrimeiros 10 IDs:', json.data.data?.slice(0, 10).map(l => l.id));
  });
}).on('error', e => console.log('Erro:', e.message));
