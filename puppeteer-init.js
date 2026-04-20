// puppeteer-init.js
//
// NFSE-M06 onda 6.46 (2026-04-20): bootstrap do puppeteer-extra +
// StealthPlugin extraido do topo de server.js.
//
// Lembrete sobre puppeteer-extra: e um singleton global via cache do
// require do Node. Qualquer `require('puppeteer-extra')` no mesmo
// processo retorna a mesma instancia. Logo, basta registrar o
// StealthPlugin uma vez (aqui) para que modulos que apenas fazem
// `require('puppeteer-extra')` sem re-registrar (ex.:
// monitor-mensagens-core.js) ja recebam o plugin ativo.
//
// Outros modulos (monitor-v2.js, puppeteer-session.js, test-login.js)
// registram o plugin por conta propria -- tudo bem, o registro por
// nome em puppeteer-extra e idempotente.
//
// O valor util deste modulo e o side effect do require(). Tambem
// exportamos `puppeteer` para quem quiser consumir a instancia ja
// configurada sem re-escrever o require + use.

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

module.exports = { puppeteer };
