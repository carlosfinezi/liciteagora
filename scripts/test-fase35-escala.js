/**
 * Fase 3.5 — a escala tipográfica consumida pelos componentes.
 *
 * ── Por que esta suíte mede em Chrome ──────────────────────────────────────
 *
 * Porque `em` MULTIPLICA em cascata, e o resultado não está escrito em lugar
 * nenhum do CSS. Antes desta fase, `.btn` em `0.88em` com `.btn-sm` em `0.8em`
 * dentro dele produzia **9,86px** de texto — um número que não aparece no
 * fonte, que nenhuma leitura de arquivo encontra e que a estimativa de papel da
 * Fase 3.1 errou (ela previu 11,2px).
 *
 * ── O que ela protege, agora que a escala JÁ está no global ────────────────
 *
 * A suíte nasceu comparando o global com um delta em avaliação. Promovido o
 * delta (2026-09-17), comparar deixou de fazer sentido: o "antes" não existe
 * mais. Ela passou a afirmar sobre o ESTADO, que é o que protege contra
 * regressão — alguém devolver um `em` a um componente, ou criar um degrau novo
 * fora da escala.
 *
 * Os valores de antes ficam aqui como registro histórico, não como medição:
 *
 *     componente          antes da 3.5   depois
 *     botão                  12,32px      14px
 *     botão pequeno           9,86px      13px
 *     marcador (.badge)       8,87px      11px → 12px em 2026-10-01
 *     cabeçalho de tabela    10,08px      11px → 12px em 2026-10-01
 *     célula                 12,32px      14px
 *     rótulo de campo        11,48px      13px
 *     campo de texto/lista   12,60px      14px
 *     linha da tabela           50px    53,9px   (+7,8% — o custo em densidade)
 *
 * O teste A6 de `test-tema-global.js` exige que esta suíte exista e esteja no
 * verify. As duas coisas se seguram: lá se garante que a medição existe, aqui
 * se garante que o resultado dela continua valendo.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const PORTA = 34151;

let ok = 0, fail = 0;
const t = (nome, fn) => { try { fn(); console.log('  OK  ' + nome); ok++; }
  catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; } };
const assert = (c, m) => { if (!c) throw new Error(m); };

/** A escala declarada na Fase 3.1, em px, com o root em 16px.
 *  O degrau de baixo passou de 11 para 12px em 2026-10-01: 11px era legível de
 *  perto num monitor e não era em celular, e o cabeçalho de tabela do ERP inteiro
 *  vivia nele. O custo foi medido: a linha da tabela não mudou (50px), porque
 *  quem manda nela é a célula, que está em 14px. */
const ESCALA = { 12: '--text-xs', 13: '--text-sm', 14: '--text-base', 16: '--text-md',
  18: '--text-lg', 22: '--text-xl', 28: '--text-2xl' };
/** O piso: nenhum texto que a pessoa precise ler fica abaixo disto. */
const PISO = 12;

const ALVOS = {
  'botão':            '#a .btn',
  'botão pequeno':    '#a .btn-sm',
  'rótulo de campo':  '#a .form-group label',
  'campo de texto':   '#a input',
  'campo de lista':   '#a select',
  'célula':           '#a tbody td',
  'cabeçalho':        '#a thead th',
  'aba':              '#a .tab',
  'texto de apoio':   '#a small',
  'vazio':            '#a .empty',
  'marcador':         '#a .badge',
  'título':           '#a h1',
};

/**
 * Amostra com a marcação REAL das telas (`page-header`, `panel`, `tbl-wrap`,
 * `form-group`): o que está sob teste é a cascata que essas classes produzem, e
 * marcação inventada mediria outra coisa. Sem API e sem banco de propósito —
 * dado que muda sozinho não serve de régua.
 */
const AMOSTRA = `
<div id="a" class="layout"><main class="main-content">
  <div class="page-header"><div><h1>Amostra</h1><small>texto de apoio da tela</small></div>
    <div class="actions"><button class="btn btn-primary">Ação principal</button></div></div>
  <div class="tabs"><div class="tab active">Primeira</div><div class="tab">Segunda</div></div>
  <div class="panel">
    <div class="form-row"><div class="form-group"><label>Rótulo do campo</label>
      <input type="text" value="conteúdo"></div>
      <div class="form-group"><label>Lista</label><select><option>opção</option></select></div></div>
    <div class="tbl-wrap"><table class="tabela"><thead><tr><th>Coluna</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        <tr><td>Primeira linha da tabela</td><td><span class="badge">ativo</span></td>
            <td><button class="btn btn-ghost btn-sm">Editar</button></td></tr>
        <tr><td>Segunda linha da tabela</td><td><span class="badge">ativo</span></td>
            <td><button class="btn btn-ghost btn-sm">Editar</button></td></tr>
        <tr><td colspan="3" class="empty">Nada por aqui ainda</td></tr>
      </tbody></table></div>
  </div>
</main></div>`;

const PAGINA = (tema) => `<!DOCTYPE html><html lang="pt-BR" data-theme="${tema}"><head><meta charset="utf-8">
  <link rel="stylesheet" href="/css/app-modern.css"></head><body>${AMOSTRA}</body></html>`;

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));
  const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));

  const app = express();
  app.get('/claro', (_q, r) => r.type('html').send(PAGINA('claro')));
  app.get('/escuro', (_q, r) => r.type('html').send(PAGINA('escuro')));
  app.use(express.static(PUB));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    userDataDir: '/tmp/chrome-test-fase35',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  /** Mede do primeiro paint. Sem injeção de folha e sem reaproveitar aba: os
   *  dois produzem número inconsistente (relatório 40, §5). */
  async function medir(rota) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`http://127.0.0.1:${PORTA}/${rota}`, { waitUntil: 'networkidle0' });
    const out = await page.evaluate((alvos) => {
      const r = { fontes: {}, alturas: {} };
      for (const [nome, sel] of Object.entries(alvos)) {
        const el = document.querySelector(sel);
        r.fontes[nome] = el ? Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100 : null;
        if (el) r.alturas[nome] = Math.round(el.getBoundingClientRect().height * 10) / 10;
      }
      r.alturas['linha da tabela'] =
        Math.round(document.querySelector('#a tbody tr').getBoundingClientRect().height * 10) / 10;
      return r;
    }, ALVOS);
    await page.close();
    return out;
  }

  const claro = await medir('claro');
  const escuro = await medir('escuro');

  await browser.close();
  srv.close();

  console.log('\n  componente            tamanho    altura');
  console.log('  ' + '-'.repeat(40));
  for (const nome of Object.keys(ALVOS)) {
    const f = claro.fontes[nome];
    if (f == null) { console.log(`  ${nome.padEnd(20)} (ausente na amostra)`); continue; }
    console.log(`  ${nome.padEnd(20)} ${String(f + 'px').padEnd(10)} ${claro.alturas[nome]}px`);
  }
  console.log(`  ${'linha da tabela'.padEnd(20)} ${''.padEnd(10)} ${claro.alturas['linha da tabela']}px\n`);

  // ==================== as afirmações ====================

  t(`1. nenhum componente fica abaixo de ${PISO}px, o piso da escala`, () => {
    const abaixo = Object.entries(claro.fontes).filter(([, v]) => v != null && v < PISO);
    assert(abaixo.length === 0,
      'texto menor que o piso: ' + abaixo.map(([k, v]) => `${k}=${v}px`).join(', ')
      + ' — provável `em` novo multiplicando em cascata');
  });

  t('2. todo tamanho medido pertence a um degrau da escala', () => {
    const fora = Object.entries(claro.fontes).filter(([, v]) => v != null && !ESCALA[Math.round(v)]);
    assert(fora.length === 0,
      'fora da escala: ' + fora.map(([k, v]) => `${k}=${v}px`).join(', ')
      + ' — degraus: ' + Object.keys(ESCALA).join('/') + 'px');
  });

  t('3. campo de texto e campo de lista tem o mesmo tamanho', () => {
    assert(claro.fontes['campo de texto'] === claro.fontes['campo de lista'],
      `input=${claro.fontes['campo de texto']}px e select=${claro.fontes['campo de lista']}px `
      + '— eram diferentes no mesmo formulário até a Fase 3.5');
  });

  t('4. o botao pequeno nao volta a multiplicar em cascata', () => {
    const d = claro.fontes['botão pequeno'];
    assert(d >= 13, `botão pequeno em ${d}px — era 9,86px antes da 3.5, e só volta a isso `
      + 'se alguém devolver um valor em `em` a `.btn-sm` ou a `.btn`');
  });

  t('5. a linha da tabela nao passa de 56px', () => {
    const h = claro.alturas['linha da tabela'];
    assert(h <= 56, `linha em ${h}px — o custo medido da 3.5 foi 53,9px, e acima de 56 `
      + 'a densidade da tabela deixa de caber no que o ERP precisa mostrar');
  });

  t('6. o botao mantem alvo de toque de 32px', () => {
    const h = claro.alturas['botão'];
    assert(h >= 32, `botão com ${h}px de altura — alvo de toque é acessibilidade, não estética`);
  });

  t('7. a amostra usa no maximo 5 degraus distintos', () => {
    const n = new Set(Object.values(claro.fontes).filter(v => v != null)).size;
    assert(n <= 5, `${n} tamanhos distintos em 12 componentes — a escala tem 7 degraus `
      + 'para o ERP inteiro, não para uma tela');
    console.log(`       (degraus em uso na amostra: ${n})`);
  });

  t('8. o tema escuro mede exatamente o mesmo que o claro', () => {
    // Tamanho não pode depender de tema. Se depender, alguém pendurou tipografia
    // num seletor de tema, e a tela muda de altura ao trocar o botão da topbar.
    const dif = Object.keys(ALVOS).filter(k => claro.fontes[k] !== escuro.fontes[k]);
    assert(dif.length === 0,
      'tamanho muda com o tema em: ' + dif.map(k => `${k} (${claro.fontes[k]} vs ${escuro.fontes[k]})`).join(', '));
  });

  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERRO: ' + e.stack); process.exit(1); });
