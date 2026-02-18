const fs = require('fs');
let app = fs.readFileSync('public/app.js', 'utf8');

// Fix cnpj references - should be orgaoEntidade.cnpj
app = app.replace(/isLida\(licitacao\.cnpj,/g, 'isLida(licitacao.orgaoEntidade?.cnpj,');

// Fix the button onclick - use orgaoEntidade.cnpj
app = app.replace(
    /toggleLida\('\$\{licitacao\.cnpj\}'/g,
    "toggleLida('${licitacao.orgaoEntidade?.cnpj}'"
);

fs.writeFileSync('public/app.js', app);
console.log('CNPJ references corrigidas!');
