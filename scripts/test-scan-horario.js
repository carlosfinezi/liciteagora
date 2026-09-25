#!/usr/bin/env node
/**
 * test-scan-horario.js — prova que a tela de grupos de palavras exibe o horário
 * do último scan no fuso de quem lê, e não três horas à frente.
 *
 * O DEFEITO QUE ISTO GUARDA, com o número que o motivou: em 22/09/2026 a tela
 * anunciava "último scan 22/09/2026 17:08" às 16h da tarde — um scan que ainda
 * não tinha acontecido. `ultimo_scan_em` sai do `CURRENT_TIMESTAMP` do SQLite,
 * que grava em UTC no formato "YYYY-MM-DD HH:MM:SS"; entregue cru ao
 * `new Date`, o navegador lê essa string como hora LOCAL. Em -03 isso adianta
 * o relógio em três horas, e o scan das 14h vira 17h.
 *
 * Por que importa mais do que parece: data no futuro faz quem opera concluir
 * que o agendamento está quebrado, ou pior, que o scan já rodou quando ele
 * ainda vai rodar. O `analise-ia-scheduler.js:605` já convertia certo do lado
 * do servidor, e a `/configuracoes/ia.html` também — era só esta tela que lia
 * cru.
 *
 * O teste FIXA o fuso do navegador em America/Sao_Paulo. Sem isso ele passaria
 * em qualquer máquina cujo relógio já estivesse em UTC, medindo nada.
 *
 * Uso: node scripts/test-scan-horario.js
 */

const path = require('path');

const BASE = path.resolve(__dirname, '..');
const express = require(BASE + '/node_modules/express');
const puppeteer = require(BASE + '/node_modules/puppeteer-core');

const CHROME = '/usr/bin/google-chrome';

let ok = 0, fail = 0;
const falhas = [];
function assert(cond, msg, extra) {
  if (cond) { ok++; console.log(`  ✓ ${msg}`); }
  else {
    fail++; falhas.push(msg);
    console.error(`  ✗ ${msg}${extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 700) : ''}`);
  }
}

// O valor como o SQLite grava: UTC, espaço no lugar do T, sem sufixo de fuso.
const SCAN_UTC = '2026-09-22 17:08:07';
const ESPERADO_LOCAL = '14:08';       // o mesmo instante em America/Sao_Paulo

const GRUPO = { id: 20, nome: 'ANTIVIRUS / EDR', cor: '#2196F3', palavras: ['edr', 'endpoint'] };

const estado = {
  config: {
    // ufs e modalidades chegam como ARRAY: a rota faz o JSON.parse antes de
    // responder. Mandá-los como string aqui faria o `.join` da tela estourar
    // dentro do try/catch, e o teste mediria um modal vazio sem saber por quê.
    grupoId: 20, ativo: 1, ufs: [], modalidades: [], valor_minimo: null,
    limite_diario: 100, produtos_que_vendo: 'antivirus corporativo',
    auto_interesse_ativo: 1, auto_telegram_ativo: 1, auto_score_min: 70,
    ultimo_scan_em: SCAN_UTC, ultimo_scan_total: 0, ultimo_scan_analisadas: 0,
    ultimo_scan_erros: 0, ultimo_scan_status: 'sucesso', ultimo_scan_mensagem: null,
  }
};

(async () => {
  const app = express();
  app.use(express.json());
  app.get('/api/grupos-palavras', (_q, r) => r.json({ success: true, grupos: [GRUPO], data: [GRUPO] }));
  app.get('/api/analise/agendamento/:id', (_q, r) => r.json({ success: true, config: estado.config }));
  app.get('/api/perfis/meu-acesso', (_q, r) => r.json({ success: true, irrestrito: true, paginas: [] }));
  app.get('/api/features/status', (_q, r) => r.json({ success: true, features: { licitacoes: true } }));
  app.get('/api/tenant-atual', (_q, r) => r.json({ success: true, tenant: { nome: 'Teste' } }));
  app.get('/api/usuarios/me', (_q, r) => r.json({ success: true, usuario: { nome: 'Fulano' } }));
  app.use(express.static(path.join(BASE, 'public')));
  app.get('/wrap', (req, res) => res.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell=true;</script></head>
     <body style="margin:0"><iframe src="${String(req.query.p || '')}" style="width:100vw;height:100vh;border:0;display:block"></iframe></body></html>`));

  const servidor = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const porta = servidor.address().port;

  const navegador = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/scan-horario-chrome-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const errosJs = [];
  const page = await navegador.newPage();
  page.on('pageerror', e => errosJs.push(String(e.message)));
  // Fixa o fuso do navegador: sem isto o teste não mede nada numa máquina em UTC.
  await page.emulateTimezone('America/Sao_Paulo');

  await page.goto(`http://127.0.0.1:${porta}/wrap?p=/operacional/grupos-palavras.html`,
    { waitUntil: 'networkidle2', timeout: 25000 });
  const f = page.frames().find(x => x !== page.mainFrame() && x.url().includes('grupos-palavras.html'));

  console.log('\n── o fuso do navegador está fixado');
  {
    const tz = await f.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert(tz === 'America/Sao_Paulo', 'o teste roda em -03, que é onde o defeito aparece', tz);
  }

  console.log('\n── a conversão em si');
  {
    const r = await f.evaluate((v) => {
      const convertido = dataScan(v);
      return {
        iso: convertido.toISOString(),
        local: convertido.toLocaleString('pt-BR'),
        cru: new Date(v).toLocaleString('pt-BR'),
      };
    }, SCAN_UTC);

    assert(r.iso === '2026-09-22T17:08:07.000Z',
      'o valor do banco é lido como UTC, e não como hora local', r);
    assert(r.local.includes(ESPERADO_LOCAL),
      `e exibido como ${ESPERADO_LOCAL} para quem está em -03 (saiu "${r.local}")`, r);
    assert(r.cru.includes('17:08'),
      'a leitura crua, sem conversão, é que mostrava 17:08 — o defeito', r.cru);
  }

  console.log('\n── o que a tela mostra no modal');
  {
    const r = await f.evaluate(async () => {
      await abrirAgendamentoIA(20, 'ANTIVIRUS / EDR');
      return {
        quando: document.getElementById('statusQuando').textContent,
        total: document.getElementById('statusTotal').textContent,
        status: document.getElementById('statusStatus').textContent,
        visivel: !document.getElementById('agendamentoStatusBox').hidden,
      };
    });

    assert(r.visivel, 'o quadro de status do último scan aparece', r);
    assert(r.quando.includes(ESPERADO_LOCAL),
      `o horário do scan sai como ${ESPERADO_LOCAL} (saiu "${r.quando}")`, r);
    // A exigência de formato não é zelo: sem ela, um campo vazio ("—") passaria
    // nesta asserção sem conter 17:08, e o teste daria verde medindo nada.
    assert(/^\d{2}\/\d{2}\/\d{4}/.test(r.quando) && !r.quando.includes('17:08'),
      'e não mais como 17:08, que era três horas no futuro', r.quando);
  }

  console.log('\n── um scan nunca pode ser exibido no futuro');
  {
    // A guarda que fecha o buraco: seja qual for o valor, o que a tela exibe
    // não pode estar à frente do relógio de quem lê.
    const r = await f.evaluate((v) => {
      const d = dataScan(v);
      return { adiantadoMs: d.getTime() - Date.now(), exibido: d.toLocaleString('pt-BR') };
    }, SCAN_UTC);
    assert(r.adiantadoMs < 0,
      'o instante exibido já passou, como um "último scan" deve estar', r);
  }

  console.log('\n── formato ISO não é estragado pela conversão');
  {
    // A mesma coluna pode receber um valor gravado com toISOString em outro
    // caminho. Converter duas vezes moveria o relógio de novo.
    const r = await f.evaluate(() => {
      const iso = '2026-09-22T17:08:07.000Z';
      return dataScan(iso).toISOString();
    });
    assert(r === '2026-09-22T17:08:07.000Z',
      'valor já em ISO passa intacto, sem ganhar mais um deslocamento', r);
  }

  console.log('\n── "nunca" continua sendo "nunca"');
  {
    const r = await f.evaluate(() => [dataScan(null), dataScan(''), dataScan(undefined)]);
    assert(r.every(x => x === null),
      'valor ausente devolve null, e a tela segue escrevendo "nunca"', r);
  }

  console.log('\n── nenhum erro de JS');
  assert(errosJs.length === 0, 'a tela não lançou erro', errosJs);

  await navegador.close();
  servidor.close();

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${ok} ok, ${fail} falha(s)`);
  if (fail) { falhas.forEach(x => console.error('   - ' + x)); process.exit(1); }
})().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
