/**
 * DANFE legível + lista de separação (2026-09-12).
 *
 * Os dois PDFs são GERADOS de verdade e o texto é extraído do resultado. Não é
 * leitura de código: um PDF pode ser produzido sem erro e ainda assim sair com
 * linhas sobrepostas, que foi o defeito relatado.
 *
 * O teste que mais importa é o B3: a lista de separação circula pelo estoque e
 * pelo balcão. Se um preço de custo ou uma margem vazar para ela, ninguém
 * percebe — a folha continua parecendo certa.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const TMP = '/tmp/test-separacao';

let ok = 0, fail = 0;
const fila = [];
const t = (nome, fn) => fila.push([nome, fn]);
const assert = (c, m) => { if (!c) throw new Error(m); };

fs.mkdirSync(TMP, { recursive: true });

/** 36 produtos, com as descrições longas que causaram o problema. */
function itensDeTeste(n = 36) {
  const descs = [
    'BICARBONATO DE SÓDIO - FD 20 UN 40G',
    'CHIMICHURRY C/ PIMENTA FD - 20 UNID 18G',
    'TEMPERO COMPLETO COM AÇAFRÃO - FD 24 UN 400G',
    'MOLHO DE PIMENTA ARTESANAL EXTRA FORTE COM ALHO E ERVAS FINAS SELECIONADAS FD 12UN',
    'SAL',
  ];
  return Array.from({ length: n }, (_, i) => ({
    sku: String(3000 + i), descricao: descs[i % descs.length],
    unidade: 'UN', quantidade: (i % 7) + 1,
    precoUnitario: 18.9, valorTotal: 18.9 * ((i % 7) + 1),
  }));
}

function gerarSeparacao(itens, extra = {}) {
  const sep = require(path.join(RAIZ, 'separacao-pdf.js'));
  const arq = path.join(TMP, 'sep.pdf');
  return new Promise((resolve) => {
    const out = fs.createWriteStream(arq);
    sep.gerar(out, {
      numero: 'PED-2026-00177', notaNumero: 177,
      clienteNome: 'Supermecado Guerra Laranjeiras',
      dataPedido: '2026-09-12', itens, ...extra,
    }, { razaoSocial: 'VALDIRENE DOS SANTOS LIMA DA SILVA LTDA' });
    out.on('finish', () => resolve(arq));
  });
}

const texto = (pdf) => {
  const txt = pdf.replace(/\.pdf$/, '.txt');
  execFileSync('pdftotext', ['-layout', pdf, txt]);
  return fs.readFileSync(txt, 'utf8');
};
const paginas = (pdf) => {
  const info = execFileSync('pdfinfo', [pdf]).toString();
  return Number(/Pages:\s+(\d+)/.exec(info)[1]);
};

// ============================================================================
// A. DANFE — o patch está aplicado e a lib local é a que roda
// ============================================================================

t('A1. o codigo usa a copia local, nao a lib do node_modules', () => {
  const rotas = fs.readFileSync(path.join(RAIZ, 'nfe-emit-routes.js'), 'utf8');
  assert(!/await import\('node-sped-pdf'\)/.test(rotas),
    'ainda há chamada à lib original — o patch de legibilidade não valeria');
  assert(/vendor\/node-sped-pdf\/index\.js/.test(rotas), 'não aponta para o vendor');
  assert(fs.existsSync(path.join(RAIZ, 'vendor/node-sped-pdf/index.js')), 'o vendor sumiu');
});

t('A2. o patch de separacao esta no vendor', () => {
  const v = fs.readFileSync(path.join(RAIZ, 'vendor/node-sped-pdf/index.js'), 'utf8');
  assert(/PADDING_PROD/.test(v), 'o respiro entre produtos sumiu');
  assert(/thickness: 0\.4/.test(v), 'a linha separadora entre produtos sumiu');
  assert(/fmt\(prod\.qCom\).*fontStyle: "negrito"/.test(v), 'a quantidade deixou de ser destacada');
  assert(/ALTURA_UTIL/.test(v), 'a paginação por pontos sumiu');
});

t('A3. NENHUMA coluna fiscal foi removida do DANFE', () => {
  // O pedido era melhorar a legibilidade "sem remover nem alterar informações
  // fiscais obrigatórias". As 14 colunas têm de continuar lá.
  const v = fs.readFileSync(path.join(RAIZ, 'vendor/node-sped-pdf/index.js'), 'utf8');
  for (const campo of ['prod.cProd', 'prod.NCM', 'prod.CFOP', 'prod.uCom', 'prod.qCom',
                       'prod.vUnCom', 'prod.vProd', 'prod.vDesc', 'prod.vBC',
                       'prod.vICMS', 'prod.vIPI', 'ICMS.pICMS', 'IPI.pIPI']) {
    assert(v.includes(campo), `a coluna ${campo} sumiu do DANFE`);
  }
  assert(/CSOSN \|\| ICMS\.CST/.test(v), 'a coluna O/CSOSN sumiu');
});

t('A4. a versao da lib original esta registrada', () => {
  // Sem isto, ninguém sabe de qual versão o vendor saiu — e uma atualização
  // futura da lib passaria despercebida.
  const ver = fs.readFileSync(path.join(RAIZ, 'vendor/node-sped-pdf/VERSAO.txt'), 'utf8');
  assert(/node-sped-pdf@\d+\.\d+\.\d+/.test(ver), 'VERSAO.txt sem a versão de origem');
  const atual = require(path.join(RAIZ, 'node_modules/node-sped-pdf/package.json')).version;
  assert(ver.includes(atual),
    `o node_modules está em ${atual} e o vendor saiu de outra versão — reveja o patch`);
});

// ============================================================================
// B. Lista de separação
// ============================================================================

t('B1. gera em A4 e usa mais de uma pagina com 36 itens', async () => {
  const pdf = await gerarSeparacao(itensDeTeste(36));
  const info = execFileSync('pdfinfo', [pdf]).toString();
  assert(/595\.28 x 841\.89/.test(info), 'não é A4: ' + (/Page size:.*/.exec(info) || [''])[0]);
  assert(paginas(pdf) >= 2, 'comprimiu 36 itens numa página só — era para usar duas');
});

t('B2. tem tudo o que a conferencia precisa', async () => {
  const txt = texto(await gerarSeparacao(itensDeTeste(36)));
  for (const [termo, oque] of [
    ['LISTA DE SEPARAÇÃO', 'título'],
    ['PED-2026-00177', 'número do pedido'],
    ['177', 'número da nota'],
    ['Supermecado Guerra Laranjeiras', 'cliente'],
    ['12/09/2026', 'data'],
    ['CÓDIGO', 'coluna de código'],
    ['DESCRIÇÃO DO PRODUTO', 'coluna de descrição'],
    ['UN', 'coluna de unidade'],
    ['QTD', 'coluna de quantidade'],
    ['OBSERVAÇÕES', 'espaço de observações'],
    ['Separado por', 'campo Separado por'],
    ['Conferido por', 'campo Conferido por'],
    ['Data e hora da conferência', 'campo de data/hora'],
  ]) {
    assert(txt.includes(termo), `falta ${oque} ("${termo}")`);
  }
});

t('B3. NAO expoe nada fiscal nem financeiro', async () => {
  const txt = texto(await gerarSeparacao(itensDeTeste(36)));
  for (const proibido of ['NCM', 'CFOP', 'CST', 'CSOSN', 'ICMS', 'IPI', 'PIS', 'COFINS',
                          'R$', 'Valor unit', 'VALOR UNIT', 'Base de cálculo', 'Alíquota']) {
    assert(!txt.includes(proibido),
      `a lista de separação expõe "${proibido}" — ela circula pelo estoque`);
  }
});

t('B4. os totais conferem', async () => {
  const itens = itensDeTeste(36);
  const txt = texto(await gerarSeparacao(itens));
  const unidades = itens.reduce((s, i) => s + i.quantidade, 0);
  assert(txt.includes('36 produtos diferentes'), 'total de produtos errado ou ausente');
  assert(new RegExp('Total de unidades: ' + unidades).test(txt),
    `total de unidades deveria ser ${unidades}`);
});

t('B5. assinaturas e numeracao em TODAS as paginas', async () => {
  const pdf = await gerarSeparacao(itensDeTeste(36));
  const txt = texto(pdf);
  const n = paginas(pdf);
  const cont = (s) => (txt.match(new RegExp(s, 'g')) || []).length;
  assert(cont('Separado por') === n, `"Separado por" em ${cont('Separado por')} de ${n} páginas`);
  assert(cont('Conferido por') === n, 'campo de conferência não está em todas as páginas');
  assert(cont('USO INTERNO — SEM VALOR FISCAL') === n, 'o aviso não está em todas as páginas');
  for (let p = 1; p <= n; p++) {
    assert(txt.includes(`Página ${p} de ${n}`), `falta a numeração da página ${p}`);
  }
});

t('B6. o aviso do rodape nao sai cortado', async () => {
  // Ele divide a linha com "Emitido em" e "Página" — um texto longo demais
  // seria truncado pelo PDFKit, e o leitor veria "SEM VALOR" sem o "FISCAL".
  const txt = texto(await gerarSeparacao(itensDeTeste(6)));
  assert(txt.includes('USO INTERNO — SEM VALOR FISCAL'),
    'o aviso saiu truncado — encurte o texto ou alargue a coluna');
});

t('B7. descricao longa nao e truncada nem invade a linha seguinte', async () => {
  const longa = 'MOLHO DE PIMENTA ARTESANAL EXTRA FORTE COM ALHO E ERVAS FINAS SELECIONADAS FD 12UN';
  const txt = texto(await gerarSeparacao([
    { sku: 'X1', descricao: longa, unidade: 'UN', quantidade: 3 },
    { sku: 'X2', descricao: 'SAL', unidade: 'UN', quantidade: 1 },
  ]));
  // ⚠️ `pdftotext -layout` preserva a POSIÇÃO das colunas, então uma descrição
  // que quebra em duas linhas sai intercalada com as células vizinhas — juntar
  // os espaços não reconstrói a frase. Foi o que fez este teste reprovar um PDF
  // correto na primeira versão.
  //
  // O que prova que nada foi truncado é o FIM da descrição estar lá: se o
  // PDFKit tivesse cortado, "SELECIONADAS FD 12UN" seria a parte perdida.
  const plano = txt.replace(/\s+/g, ' ');
  for (const pedaco of ['MOLHO DE PIMENTA ARTESANAL', 'EXTRA FORTE', 'SELECIONADAS FD 12UN']) {
    assert(plano.includes(pedaco), `a descrição longa perdeu "${pedaco}"`);
  }
  assert(!plano.includes('…') && !plano.includes('...'),
    'apareceu reticência de truncamento na descrição');
  assert(plano.includes('SAL'), 'o produto seguinte sumiu');
});

t('B8. cabecalho da tabela repete nas paginas seguintes', async () => {
  const pdf = await gerarSeparacao(itensDeTeste(36));
  const txt = texto(pdf);
  const n = paginas(pdf);
  const cab = (txt.match(/DESCRIÇÃO DO PRODUTO/g) || []).length;
  assert(cab === n, `cabeçalho em ${cab} de ${n} páginas`);
});

t('B9. lista pequena continua cabendo numa pagina', async () => {
  const pdf = await gerarSeparacao(itensDeTeste(5));
  assert(paginas(pdf) === 1, 'uma lista de 5 itens virou mais de uma página');
});

t('B10. nota nao emitida aparece como tal, sem inventar numero', async () => {
  const txt = texto(await gerarSeparacao(itensDeTeste(3), { notaNumero: null }));
  assert(/não emitida/.test(txt), 'pedido sem nota deveria dizer que ela não foi emitida');
});

// ============================================================================
// C. Rotas
// ============================================================================

t('C1. as rotas de separacao existem, no pedido e na nota', () => {
  const ped = fs.readFileSync(path.join(RAIZ, 'pedidos-routes.js'), 'utf8');
  const fat = fs.readFileSync(path.join(RAIZ, 'faturas-routes.js'), 'utf8');
  assert(/app\.get\('\/api\/pedidos\/:id\/separacao'/.test(ped), 'rota do pedido ausente');
  assert(/app\.get\('\/api\/faturas\/:id\/separacao'/.test(fat), 'rota da nota ausente');
  // A da nota delega, em vez de ter um gerador próprio — senão seriam duas
  // listas que um dia divergiriam.
  assert(/res\.redirect\(302, `\/api\/pedidos\/\$\{f\.pedidoId\}\/separacao/.test(fat),
    'a rota da nota não delega para a do pedido');
});

t('C2. a tela oferece as tres acoes', () => {
  const tela = fs.readFileSync(path.join(RAIZ, 'public/comercial/pedido.html'), 'utf8');
  for (const acao of ['Visualizar lista de separação', 'Baixar lista de separação',
                      'Imprimir lista de separação']) {
    assert(tela.includes(acao), `falta a ação "${acao}"`);
  }
  assert(/function verSeparacao/.test(tela) && /function baixarSeparacao/.test(tela)
      && /function imprimirSeparacao/.test(tela), 'alguma função de separação sumiu');
});

t('C3. o download usa Blob (funciona no iPhone)', () => {
  // As três ações passaram a compartilhar `entregarPdf` com o PDF do pedido —
  // é lá que o Blob vive agora.
  const tela = fs.readFileSync(path.join(RAIZ, 'public/comercial/pedido.html'), 'utf8');
  const fn = /async function entregarPdf[\s\S]*?\n\}/.exec(tela);
  assert(fn, 'a função de entrega de PDF sumiu');
  assert(/URL\.createObjectURL/.test(fn[0]), 'o download não usa Blob');
  assert(/mensagemDeRede/.test(fn[0]), 'falha de rede voltaria a mostrar "Load failed"');
  for (const nome of ['verSeparacao', 'baixarSeparacao', 'imprimirSeparacao']) {
    assert(new RegExp(`function ${nome}\\([^)]*\\)\\s*\\{\\s*return entregarPdf`).test(tela),
      `${nome} não passa por entregarPdf — perderia o Blob e a folha nativa do iOS`);
  }
});

t('C4. a lista de separacao NAO e oferecida em orcamento', () => {
  // Uma folha "LISTA DE SEPARAÇÃO" chegando ao estoque antes de o cliente
  // aprovar a proposta faz separar mercadoria de venda que ainda não existe.
  const tela = fs.readFileSync(path.join(RAIZ, 'public/comercial/pedido.html'), 'utf8');
  const bloco = /const separacaoItems = ([\s\S]*?)\n\n/.exec(tela);
  assert(bloco, 'o bloco separacaoItems sumiu — a separação voltou a ser incondicional');
  assert(/ehOrcamento \? \[\]/.test(bloco[1]),
    'a lista de separação deixou de ser condicionada ao documento já ser pedido');
});

(async () => {
  for (const [nome, fn] of fila) {
    try { await fn(); console.log('  OK  ' + nome); ok++; }
    catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  }
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
