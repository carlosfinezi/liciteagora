/**
 * test-cobranca-canais.js — a cobrança não oferece o que não consegue mandar.
 *
 * Saiu do retrato de loja de material de construção (01/10/2026): a tela de
 * Cobranças anunciava "envio por e-mail e WhatsApp" e punha "Executar régua
 * agora" em destaque com NENHUM dos dois configurado. O erro só aparecia depois
 * do clique, uma linha por conta: "SMTP nao configurado". A régua, do mesmo
 * jeito, oferecia {{linhaDigitavel}} e {{linkBoleto}} sem provedor de boleto —
 * e quem as usasse mandaria ao cliente uma mensagem com a linha em branco.
 *
 * Aqui as duas telas são abertas no Chrome contra um servidor que diz o estado
 * dos canais, nos dois sentidos: sem canal, o aviso aparece e o envio desliga;
 * com canal, tudo volta ao normal. A leitura dos canais no banco é provada no
 * bloco H de test-os-sla-e-rotulos.js.
 *
 * Roda da raiz do projeto: `node scripts/test-cobranca-canais.js`
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const puppeteer = require('puppeteer-core');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const CHROME = ['/opt/google/chrome/chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));

let ok = 0, fail = 0;
const checa = (c, m) => { if (c) { console.log('  OK  ' + m); ok++; } else { console.log('FALHA ' + m); fail++; } };

// A etapa 3 usa as duas variáveis de boleto de propósito: é ela que o aviso
// tem de nomear quando não houver provedor.
const REGUA = [
  { etapa: 1, nome: 'Lembrete', diasApos: 1, canais: ['email'], assunto: 'a', emailTexto: 'sem variavel de boleto', whatsappTexto: '' },
  { etapa: 3, nome: 'Firme', diasApos: 7, canais: ['email'], assunto: 'b', emailTexto: 'Pague por {{linhaDigitavel}}', whatsappTexto: '{{linkBoleto}}' },
];

(async () => {
  let canais = { email: false, whatsapp: false, boleto: false };
  const w = express();
  w.get('/api/cobrancas/contas-vencidas', (q, r) => r.json({ success: true, contas: [], resumo: { total: 0, totalValor: 0 }, canais }));
  w.get('/api/cobrancas/config', (q, r) => r.json({ success: true, canais,
    config: { regua: REGUA, horaExecucao: 9, executarDiasUteis: true, limitePorDia: 1, ccInterno: '' } }));
  w.get('/api/financeiro/config-juros', (q, r) => r.json({ success: true, jurosMesPct: 1, multaAtrasoPct: 2, carenciaDias: 0, jurosModo: 'simples' }));
  w.use('/api', (q, r) => r.json({ success: true }));
  // O pai se declara shell, como o app.html: a tela não desenha o próprio menu.
  w.get('/__e', (q, r) => r.type('html').send(`<!doctype html><meta charset="utf-8"><script>window.__liciteShell=true;</script><style>html,body{margin:0;height:100%}iframe{border:0;width:${q.query.w}px;height:100%;display:block}</style><iframe id="tela" src="${q.query.t}"></iframe>`));
  w.use(express.static(PUB));
  const srv = await new Promise(res => { const s = http.createServer(w).listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
    userDataDir: '/tmp/vp-cobranca-canais-chrome', protocolTimeout: 60000 });

  async function abrir(tela) {
    const p = await b.newPage();
    const erros = [];
    p.on('pageerror', e => erros.push(e.message));
    p.on('dialog', d => d.dismiss().catch(() => {}));
    await p.setViewport({ width: 1440, height: 900 });
    await p.goto(`${base}/__e?w=1340&t=${encodeURIComponent(tela)}`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 2500));
    const f = await (await p.$('#tela')).contentFrame();
    return { f, erros };
  }

  console.log('A. Sem e-mail e sem WhatsApp configurados');
  let { f, erros } = await abrir('/cobranca/cobrancas.html');
  let r = await f.evaluate(() => {
    const c = document.getElementById('semCanal');
    const btn = document.getElementById('btnRegua');
    return { visivel: getComputedStyle(c).display !== 'none', texto: c.textContent.trim(),
      links: c.querySelectorAll('a').length, btnDesativado: btn.disabled, btnTitulo: btn.title };
  });
  checa(r.visivel, 'Cobranças: o aviso aparece');
  checa(/configure o e-mail ou o WhatsApp/.test(r.texto), 'Cobranças: o aviso diz o que fazer');
  checa(r.links === 2, 'Cobranças: o aviso leva às duas configurações (achei ' + r.links + ')');
  checa(r.btnDesativado, 'Cobranças: "Executar régua agora" fica desativado');
  checa(/configure o e-mail/.test(r.btnTitulo), 'Cobranças: o botão desativado diz por quê');
  checa(!erros.length, 'Cobranças: sem erro de JS — ' + erros.join(' | '));

  ({ f, erros } = await abrir('/cobranca/cobrancas-config.html'));
  r = await f.evaluate(() => {
    const c = document.getElementById('semCanal');
    const marcadas = [...document.querySelectorAll('.variaveis-info code[data-exige="boleto"]')];
    const aviso = document.getElementById('avisoVariaveis');
    return { visivel: getComputedStyle(c).display !== 'none',
      riscadas: marcadas.filter(x => x.classList.contains('indisponivel')).length,
      titulo: marcadas[0] ? marcadas[0].title : '',
      avisoVisivel: getComputedStyle(aviso).display !== 'none', avisoTexto: aviso.textContent.trim(),
      placeholder: document.getElementById('ccInterno').placeholder };
  });
  checa(r.visivel, 'Configuração: o aviso aparece');
  checa(r.riscadas === 2, 'Configuração: as duas variáveis de boleto saem marcadas (achei ' + r.riscadas + ')');
  checa(/sai vazia/.test(r.titulo), 'Configuração: a variável marcada diz o motivo');
  checa(r.avisoVisivel && /etapa 3/.test(r.avisoTexto), 'Configuração: o aviso nomeia a etapa que usa a variável');
  checa(/^exemplo: /.test(r.placeholder), 'Configuração: o e-mail em cópia se anuncia como exemplo');
  checa(!erros.length, 'Configuração: sem erro de JS — ' + erros.join(' | '));

  console.log('\nB. Com os canais configurados, nada disso aparece');
  canais = { email: true, whatsapp: true, boleto: true };
  ({ f } = await abrir('/cobranca/cobrancas.html'));
  r = await f.evaluate(() => ({
    visivel: getComputedStyle(document.getElementById('semCanal')).display !== 'none',
    btnDesativado: document.getElementById('btnRegua').disabled,
  }));
  checa(!r.visivel, 'Cobranças: o aviso some');
  checa(!r.btnDesativado, 'Cobranças: o botão volta a funcionar');

  ({ f } = await abrir('/cobranca/cobrancas-config.html'));
  r = await f.evaluate(() => ({
    visivel: getComputedStyle(document.getElementById('semCanal')).display !== 'none',
    riscadas: [...document.querySelectorAll('.variaveis-info code[data-exige="boleto"]')].filter(x => x.classList.contains('indisponivel')).length,
    avisoVisivel: getComputedStyle(document.getElementById('avisoVariaveis')).display !== 'none',
  }));
  checa(!r.visivel, 'Configuração: o aviso some');
  checa(r.riscadas === 0, 'Configuração: nada fica riscado');
  checa(!r.avisoVisivel, 'Configuração: o aviso das variáveis some');

  await b.close(); srv.close();
  console.log(`\n${ok} OK, ${fail} FALHA(S)`);
  if (fail) { console.log(`FALHOU: ${fail} problema(s)`); process.exit(1); }
  console.log('PASSOU');
})().catch(e => { console.error('FALHOU: ' + e.message); process.exit(1); });
