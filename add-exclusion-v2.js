const fs = require('fs');

// 1. Update HTML
let html = fs.readFileSync('public/index.html', 'utf8');

const htmlOld = `<div class="form-group">
                        <label for="palavraChave">Palavra-chave</label>
                        <input type="text" id="palavraChave" name="palavraChave"
                               placeholder="Ex: computador, obra, serviço...">
                    </div>

                    <div class="form-group">
                        <label for="modalidade">Modalidade</label>`;

const htmlNew = `<div class="form-group">
                        <label for="palavraChave">Palavra-chave</label>
                        <input type="text" id="palavraChave" name="palavraChave"
                               placeholder="Ex: computador, obra, serviço...">
                    </div>

                    <div class="form-group">
                        <label for="palavraExclusao">Excluir palavras</label>
                        <input type="text" id="palavraExclusao" name="palavraExclusao"
                               placeholder="Ex: manutenção, reforma..." style="border-color: #f44336;">
                        <small style="color: #888; font-size: 11px; margin-top: 3px;">Separe por vírgula</small>
                    </div>

                    <div class="form-group">
                        <label for="modalidade">Modalidade</label>`;

html = html.replace(htmlOld, htmlNew);
fs.writeFileSync('public/index.html', html);
console.log('1. HTML atualizado!');

// 2. Update server.js
let server = fs.readFileSync('server.js', 'utf8');

// Add parameter
server = server.replace(
    /palavraChave,\s*\n\s*codigoModalidadeContratacao,/,
    `palavraChave,
      palavraExclusao,
      codigoModalidadeContratacao,`
);

// Add filter logic after getting results
server = server.replace(
    /const todasLicitacoes = db\.prepare\(sql\)\.all\(\.\.\.params\);/,
    `let todasLicitacoes = db.prepare(sql).all(...params);

    // Filtrar palavras de exclusão
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
    }`
);

fs.writeFileSync('server.js', server);
console.log('2. Server.js atualizado!');

// 3. Update app.js
let appJs = fs.readFileSync('public/app.js', 'utf8');

// Add exclusion param to search
appJs = appJs.replace(
    /const params = new URLSearchParams\(\);/,
    `const params = new URLSearchParams();
    const palavraExclusao = document.getElementById('palavraExclusao')?.value?.trim();
    if (palavraExclusao) params.append('palavraExclusao', palavraExclusao);`
);

fs.writeFileSync('public/app.js', appJs);
console.log('3. App.js atualizado!');

console.log('\\nCampo de exclusão adicionado com sucesso!');
