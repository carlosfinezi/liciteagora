const fs = require('fs');

// 1. Update HTML - add exclusion field
let html = fs.readFileSync('public/index.html', 'utf8');

const oldField = `<div class="form-group">
                        <label for="palavraChave">Palavra-chave</label>
                        <input type="text" id="palavraChave" name="palavraChave"
                               placeholder="Ex: computador, obra, serviço...">
                    </div>`;

const newField = `<div class="form-group">
                        <label for="palavraChave">Palavra-chave</label>
                        <input type="text" id="palavraChave" name="palavraChave"
                               placeholder="Ex: computador, obra, serviço...">
                    </div>

                    <div class="form-group">
                        <label for="palavraExclusao">Excluir palavras</label>
                        <input type="text" id="palavraExclusao" name="palavraExclusao"
                               placeholder="Ex: manutenção, reforma..." style="border-color: #ffcdd2;">
                        <small style="color: #888; font-size: 11px;">Separe múltiplas palavras por vírgula</small>
                    </div>`;

if (html.includes(oldField)) {
    html = html.replace(oldField, newField);
    console.log('Campo de exclusão adicionado ao HTML!');
} else {
    console.log('AVISO: Campo de palavra-chave não encontrado no HTML');
}

fs.writeFileSync('public/index.html', html);

// 2. Update server.js - add exclusion logic
let server = fs.readFileSync('server.js', 'utf8');

// Add palavraExclusao to query params
const oldParams = `let {
      dataAberturaInicial,
      dataAberturaFinal,
      palavraChave,
      codigoModalidadeContratacao,
      buscaDetalhada,
      pagina = 1,
      tamanhoPagina = 50
    } = req.query;`;

const newParams = `let {
      dataAberturaInicial,
      dataAberturaFinal,
      palavraChave,
      palavraExclusao,
      codigoModalidadeContratacao,
      buscaDetalhada,
      pagina = 1,
      tamanhoPagina = 50
    } = req.query;`;

if (server.includes(oldParams)) {
    server = server.replace(oldParams, newParams);
    console.log('Parâmetro palavraExclusao adicionado!');
} else {
    console.log('AVISO: Parâmetros não encontrados no server.js');
}

// Add exclusion filter after getting results
const oldGetResults = `const todasLicitacoes = db.prepare(sql).all(...params);

    const licitacoesFormatadas = todasLicitacoes.map(row => {`;

const newGetResults = `let todasLicitacoes = db.prepare(sql).all(...params);

    // Filtrar exclusões
    if (palavraExclusao) {
      const exclusoes = palavraExclusao.toLowerCase().split(',').map(p => p.trim()).filter(p => p);
      if (exclusoes.length > 0) {
        todasLicitacoes = todasLicitacoes.filter(lic => {
          const texto = (
            (lic.objetoCompra || '') + ' ' +
            (lic.informacaoComplementar || '') + ' ' +
            (lic.razaoSocial || '') + ' ' +
            (lic.nomeUnidade || '')
          ).toLowerCase();
          return !exclusoes.some(exc => texto.includes(exc));
        });
      }
    }

    const licitacoesFormatadas = todasLicitacoes.map(row => {`;

if (server.includes(oldGetResults)) {
    server = server.replace(oldGetResults, newGetResults);
    console.log('Filtro de exclusão adicionado ao servidor!');
} else {
    console.log('AVISO: Código de resultados não encontrado no server.js');
}

fs.writeFileSync('server.js', server);

// 3. Update app.js - add exclusion to search params
let appJs = fs.readFileSync('public/app.js', 'utf8');

// Find where search params are built and add exclusion
const oldSearchParams = `const params = new URLSearchParams();

    if (palavraChave) params.append('palavraChave', palavraChave);`;

const newSearchParams = `const params = new URLSearchParams();

    const palavraExclusao = document.getElementById('palavraExclusao')?.value?.trim();

    if (palavraChave) params.append('palavraChave', palavraChave);
    if (palavraExclusao) params.append('palavraExclusao', palavraExclusao);`;

if (appJs.includes(oldSearchParams)) {
    appJs = appJs.replace(oldSearchParams, newSearchParams);
    console.log('Parâmetro de exclusão adicionado ao app.js!');
} else {
    // Try alternative pattern
    const altPattern = /const params = new URLSearchParams\(\);\s*\n\s*if \(palavraChave\)/;
    if (altPattern.test(appJs)) {
        appJs = appJs.replace(altPattern, `const params = new URLSearchParams();

    const palavraExclusao = document.getElementById('palavraExclusao')?.value?.trim();

    if (palavraExclusao) params.append('palavraExclusao', palavraExclusao);
    if (palavraChave)`);
        console.log('Parâmetro de exclusão adicionado ao app.js (padrão alternativo)!');
    } else {
        console.log('AVISO: Código de busca não encontrado no app.js');
    }
}

// Add limpar for exclusion field
const oldLimpar = `function limparFiltros() {
    document.getElementById('searchForm').reset();`;

const newLimpar = `function limparFiltros() {
    document.getElementById('searchForm').reset();
    document.getElementById('palavraExclusao').value = '';`;

if (appJs.includes(oldLimpar)) {
    appJs = appJs.replace(oldLimpar, newLimpar);
    console.log('Limpar exclusão adicionado!');
}

fs.writeFileSync('public/app.js', appJs);

console.log('\\nTodas as alterações concluídas!');
