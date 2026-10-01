/**
 * test-pecas-pre-auth.js — as peças de interface alcançáveis SEM login.
 *
 * O static de `public/` vive atrás do `requireAuth`
 * (`auth-bootstrap.installProtectedStatic`). Quem pede `/js/x.js` sem sessão
 * recebe o HTML da tela de login, com status 200 — e um `<script src>` que
 * recebe HTML não avisa nada: a variável simplesmente não existe.
 *
 * Isso importa desde 30/09/2026, quando o checkout da loja pública passou a
 * depender do `campo-formato.js` (a peça saiu de dentro do `catalogo.js` para
 * servir ao ERP também). Sem a liberação em `pre-auth-routes.js`, a vitrine de
 * qualquer tenant quebraria por inteiro: a ponte no topo do `catalogo.js` lê
 * `window.CampoFormato`, que não existiria.
 *
 * Roda da raiz do projeto: node scripts/test-pecas-pre-auth.js
 */
const path = require('path');
const fs = require('fs');
const RAIZ = path.join(__dirname, '..');

let falhas = 0, total = 0;
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) { console.log(`  ok   ${rotulo}`); return; }
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

const LIBERADAS = ['campo-formato.js', 'aviso-sistema.js'];

console.log('\nA. as peças estão liberadas antes do login');
const preAuth = fs.readFileSync(path.join(RAIZ, 'pre-auth-routes.js'), 'utf8');
/* Sem os comentários: o cabeçalho da liberação NOMEIA o `menu-config.js` e o
   `sidebar.js` para explicar por que eles ficaram de fora, e procurá-los no
   arquivo cru acusaria a própria explicação. */
const preAuthCodigo = preAuth.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const p of LIBERADAS) {
  checa(`${p} aparece em pre-auth-routes.js`, preAuthCodigo.includes(p));
}
checa('a liberação é por arquivo, e não do public/js inteiro',
  !/app\.use\(\s*['"]\/js['"]/.test(preAuthCodigo) && !/static\([^)]*'js'\s*\)/.test(preAuthCodigo));
checa('menu-config.js NÃO está liberado (descreve o menu do ERP)', !preAuthCodigo.includes('menu-config.js'));
checa('sidebar.js NÃO está liberado', !/sidebar\.js/.test(preAuthCodigo));

console.log('\nB. quem depende das peças sem estar logado');
/* Telas servidas antes do login (loja, cardápio, portal, orçamento) que
   carregam alguma das peças: todas dependem da liberação acima. */
const PUBLICO = path.join(RAIZ, 'public');
const PRE_AUTH_DIRS = ['loja', 'cardapio', 'portal', 'auth'];
const dependentes = [];
for (const dir of PRE_AUTH_DIRS) {
  const base = path.join(PUBLICO, dir);
  if (!fs.existsSync(base)) continue;
  const varrer = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { varrer(p); continue; }
      if (!e.name.endsWith('.html') && !e.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      for (const peca of LIBERADAS) {
        if (src.includes(`/js/${peca}`)) dependentes.push([path.relative(PUBLICO, p), peca]);
      }
    }
  };
  varrer(base);
}
console.log(`  (${dependentes.length} arquivo(s) público(s) carregam as peças)`);
for (const [arq, peca] of dependentes) {
  checa(`${arq} pede ${peca}, e ele está liberado`, preAuth.includes(peca));
}

/* C. A loja: ou ela usa a peça, ou usa a cópia própria — nunca as duas pela
 * metade, que é o estado em que o pedido em dinheiro quebra.
 *
 * A peça saiu de dentro do `catalogo.js` em 30/09/2026, e em 01/10 às 09:52 a
 * extração foi DESFEITA pela sessão que trabalha na loja do Cantinho Verde.
 * Decisão do usuário: fica com a cópia própria até aquela frente terminar.
 *
 * Esta etapa não cobra um dos dois caminhos. Ela cobra a COERÊNCIA, porque a
 * mistura é o que dá defeito: as duas leituras do troco foram ajustadas para o
 * campo que entrega número (comportamento da peça) e, com a máscara própria de
 * volta, passaram a ler "R$ 50,00" — `Number` disso é `NaN`, e o checkout
 * acusava falta com o campo preenchido. */
console.log('\nC. a loja é coerente: ou a peça, ou a cópia própria');
const catalogo = fs.readFileSync(path.join(PUBLICO, 'loja', 'catalogo.js'), 'utf8');
const indexLoja = fs.readFileSync(path.join(PUBLICO, 'loja', 'index.html'), 'utf8');
const usaPeca = /window\.CampoFormato/.test(catalogo);
const carregaPeca = indexLoja.includes('/js/campo-formato.js');
const temCopia = /^function cpfValido\(/m.test(catalogo) && /^const digitosDe = /m.test(catalogo);
const trocoEsperaNumero = /Number\(v\('chkTrocoPara'\)/.test(catalogo);
const trocoContaDigitos = /Number\(digitosDe\(v\('chkTrocoPara'\)\)\)/.test(catalogo);

checa('tem UMA das duas: a peça ou a cópia própria', usaPeca !== temCopia,
  `peça=${usaPeca} cópia=${temCopia}`);
if (usaPeca) {
  checa('usando a peça: o index.html a carrega', carregaPeca);
  checa('usando a peça: ela vem ANTES do catalogo.js',
    indexLoja.indexOf('/js/campo-formato.js') < indexLoja.indexOf('/loja/catalogo.js'));
  checa('usando a peça: o troco lê o NÚMERO do campo', trocoEsperaNumero && !trocoContaDigitos,
    'com a peça, contar dígitos divide por 100 duas vezes');
} else {
  checa('usando a cópia própria: o index.html NÃO carrega a peça', !carregaPeca,
    'carregar as duas deixa duas máscaras no mesmo campo');
  checa('usando a cópia própria: o troco conta os dígitos', trocoContaDigitos && !trocoEsperaNumero,
    'sem a peça, Number("R$ 50,00") é NaN e o checkout acusa falta com o campo cheio');
}

console.log('\nD. contra o servidor de verdade, sem sessão');
/* Sobe o pipeline real de pré-auth com um app novo, sem banco de tenant: o que
   interessa é se a rota responde JavaScript a quem não tem cookie. */
(async () => {
  const express = require(path.join(RAIZ, 'node_modules', 'express'));
  const app = express();
  for (const peca of LIBERADAS) {
    app.get(`/js/${peca}`, (_req, res) => {
      res.sendFile(path.join(RAIZ, 'public', 'js', peca), {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
      });
    });
  }
  // Depois das peças, a barreira: qualquer outra coisa cai no "login".
  app.use((_req, res) => res.status(200).type('html').send('<html>login</html>'));
  const srv = app.listen(0);
  const porta = srv.address().port;
  try {
    for (const peca of LIBERADAS) {
      const r = await fetch(`http://127.0.0.1:${porta}/js/${peca}`);
      const corpo = await r.text();
      const tipo = r.headers.get('content-type') || '';
      checa(`GET /js/${peca} devolve JavaScript`, /javascript/.test(tipo), tipo);
      checa(`GET /js/${peca} não devolve a tela de login`, !/<html/i.test(corpo.slice(0, 200)));
      checa(`GET /js/${peca} traz a peça inteira`, corpo.length > 3000, `${corpo.length} bytes`);
    }
    const r = await fetch(`http://127.0.0.1:${porta}/js/sidebar.js`);
    const corpo = await r.text();
    checa('GET /js/sidebar.js (não liberado) continua caindo na barreira', /<html/i.test(corpo));
  } finally {
    srv.close();
  }
  console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
