#!/usr/bin/env node
'use strict';
/**
 * test-suporte-telas.js — as três telas do cliente, medidas em Chrome.
 *
 *   node scripts/test-suporte-telas.js
 *
 * Mede o que renderiza, não o que o HTML promete: contar elemento no DOM não
 * prova que alguém vê. Cada checagem olha `getBoundingClientRect` e o texto
 * que apareceu.
 *
 * A API é simulada aqui; quem responde por ela é a `test-suporte-rotas`. O que
 * está sob teste é a tela — inclusive no celular, onde o desktop espremido
 * costuma deixar a conversa ilegível e o botão fora do alcance.
 *
 *  T1 lista mostra número, assunto e status   T5 conversa separa os dois lados
 *  T2 lista vazia explica, não fica em branco T6 XSS vira texto na tela
 *  T3 novo chamado NÃO oferece prioridade     T7 resolvido oferece reabrir
 *  T4 novo chamado lista as categorias        T8 encerrado não oferece resposta
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const puppeteer = require(path.join(RAIZ, 'node_modules/puppeteer-core'));

let ok = 0, fail = 0;
const t = async (nome, fn) => {
  try { await fn(); console.log('  ok    ' + nome); ok++; }
  catch (e) { console.log('  FALHA ' + nome + '\n          ' + e.message); fail++; }
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suporte-telas-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* já saiu */ } });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

const AGORA = Date.now();
const CATEGORIAS = [
  { id: 1, slug: 'duvida', nome: 'Dúvida' },
  { id: 2, slug: 'problema-tecnico', nome: 'Problema técnico' },
  { id: 3, slug: 'fiscal', nome: 'Fiscal' },
];
let LISTA = [];
let DETALHE = null;

(async () => {
  const express = require(path.join(RAIZ, 'node_modules/express'));
  const app = express();
  app.use(express.json());
  app.get('/api/suporte/categorias', (_q, rs) => rs.json({ success: true, categorias: CATEGORIAS }));
  app.get('/api/suporte/chamados', (_q, rs) => rs.json({ success: true, chamados: LISTA, escopo: 'proprios' }));
  app.get('/api/suporte/chamados/:id', (_q, rs) => (DETALHE
    ? rs.json({ success: true, ...DETALHE })
    : rs.status(404).json({ success: false, error: 'Chamado não encontrado' })));
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  app.get('/__w/:tela', (rq, rs) => rs.type('html').send(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><script>window.__liciteShell = true;</scr`
    + `ipt></head><body style="margin:0"><iframe src="/suporte/${rq.params.tela}.html${rq.query.q ? '?' + rq.query.q : ''}"`
    + ' style="display:block;width:100vw;height:100vh;border:0"></iframe></body></html>'));
  app.use(express.static(PUB));
  const srv = app.listen(0);
  const porta = srv.address().port;

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=pt-BR'],
    userDataDir: path.join(dir, 'chrome'),
  });
  const page = await browser.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e.message)));
  page.on('dialog', (d) => d.dismiss());

  const abrir = async (tela, { largura = 1440, q = '' } = {}) => {
    await page.setViewport({ width: largura, height: 900, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${porta}/__w/${tela}${q ? '?q=' + q : ''}`, { waitUntil: 'networkidle0' });
    const alvo = '/suporte/' + tela + '.html';
    for (let i = 0; i < 30; i++) {
      const cands = page.frames().filter((f) => { try { return new URL(f.url()).pathname === alvo; } catch { return false; } });
      const f = cands[cands.length - 1];
      if (f) { try { await f.waitForFunction(() => document.readyState === 'complete'); await esperar(600); return f; } catch { /* trocou */ } }
      await esperar(200);
    }
    throw new Error('a tela não abriu: ' + tela);
  };

  for (const [largura, rotulo] of [[1440, 'desktop'], [390, 'celular 390px']]) {
    console.log('\n== ' + rotulo + ' ==');
    /* Os limiares mudam com o contexto, e isso não é afrouxar: no celular o
       que importa é o alvo de TOQUE (o CSS do projeto usa 40px a partir de
       640px), e no desktop o botão padrão do design system tem 32px e é
       clicado com o mouse. Medir 40px numa tela de mouse reprovaria o próprio
       padrão do sistema. */
    const ehCelular = largura <= 640;
    const alturaMinBotao = ehCelular ? 38 : 28;
    const alturaMinCartao = ehCelular ? 80 : 48;

    // ── lista com chamados ──────────────────────────────────────────────────
    LISTA = [
      { id: 1, numero: '2026-0001', assunto: 'NF-e não autoriza', categoria: 'Fiscal',
        status: 'aguardando_cliente', criadoEm: AGORA - 86400000, atualizadoEm: AGORA - 3600000,
        reaberturas: 0, podeReabrir: false, podeResponder: true },
      { id: 2, numero: '2026-0002', assunto: 'Como cadastrar produto?', categoria: 'Dúvida',
        status: 'resolvido', criadoEm: AGORA - 172800000, atualizadoEm: AGORA - 7200000,
        reaberturas: 0, podeReabrir: true, podeResponder: false },
    ];
    let f = await abrir('chamados', { largura });

    await t('T1 a lista mostra número, assunto e status visíveis', async () => {
      const m = await f.evaluate(() => {
        const itens = [...document.querySelectorAll('.ch-item')];
        const visiveis = itens.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 80 && r.height > 30; });
        const p = visiveis[0];
        return {
          n: itens.length, visiveis: visiveis.length,
          texto: p ? p.innerText : '',
          altura: p ? Math.round(p.getBoundingClientRect().height) : 0,
          rolagemLateral: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
        };
      });
      assert.strictEqual(m.n, 2, 'a lista desenhou ' + m.n + ' itens');
      assert.strictEqual(m.visiveis, 2, 'os itens não ocupam espaço na tela');
      assert.ok(m.texto.includes('2026-0001'), 'o número não aparece: ' + m.texto);
      assert.ok(m.texto.includes('NF-e não autoriza'), 'o assunto não aparece');
      assert.ok(/Aguardando você/i.test(m.texto), 'o status não aparece em português');
      assert.ok(m.altura >= alturaMinCartao,
        'o cartão tem ' + m.altura + 'px, mínimo ' + alturaMinCartao + 'px nesta largura');
      assert.ok(m.rolagemLateral <= 2, 'a página rola ' + m.rolagemLateral + 'px de lado');
    });

    await t('T2 lista vazia explica, em vez de ficar em branco', async () => {
      LISTA = [];
      const f2 = await abrir('chamados', { largura });
      const txt = await f2.evaluate(() => document.getElementById('lista').innerText.trim());
      assert.ok(txt.length > 20, 'a lista vazia não diz nada: "' + txt + '"');
      assert.ok(/chamado/i.test(txt), 'o texto do vazio não fala de chamado');
    });

    // ── novo chamado ────────────────────────────────────────────────────────
    f = await abrir('novo', { largura });

    await t('T3 o formulário NÃO oferece prioridade', async () => {
      const m = await f.evaluate(() => ({
        temCampo: !!document.querySelector('[id*="priorid" i], [name*="priorid" i]'),
        texto: document.body.innerText,
      }));
      assert.ok(!m.temCampo, 'existe um campo de prioridade no formulário');
      assert.ok(!/urgente/i.test(m.texto), 'a palavra "urgente" aparece e convida a pedir prioridade');
    });

    await t('T4 as categorias chegam ao seletor, e os campos são utilizáveis', async () => {
      const m = await f.evaluate(() => {
        const sel = document.getElementById('categoria');
        const ass = document.getElementById('assunto');
        const des = document.getElementById('descricao');
        const bt = document.getElementById('btEnviar');
        const cx = (e) => { const r = e.getBoundingClientRect(); return { l: Math.round(r.width), a: Math.round(r.height) }; };
        return {
          opcoes: sel ? sel.options.length : 0,
          campo: cx(ass), area: cx(des), botao: cx(bt),
          rolagemLateral: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
        };
      });
      assert.strictEqual(m.opcoes, 4, 'o seletor tem ' + m.opcoes + ' opções (3 categorias + placeholder)');
      assert.ok(m.campo.l > 150, 'o campo de título tem ' + m.campo.l + 'px de largura');
      assert.ok(m.area.a > 100, 'a área de descrição tem só ' + m.area.a + 'px de altura');
      assert.ok(m.botao.a >= alturaMinBotao,
        'o botão tem ' + m.botao.a + 'px, mínimo ' + alturaMinBotao + 'px nesta largura');
      assert.ok(m.rolagemLateral <= 2, 'o formulário rola ' + m.rolagemLateral + 'px de lado');
    });

    // ── conversa ────────────────────────────────────────────────────────────
    DETALHE = {
      chamado: { id: 1, numero: '2026-0001', assunto: 'NF-e não autoriza', categoria: 'Fiscal',
        status: 'aguardando_cliente', criadoEm: AGORA - 86400000, atualizadoEm: AGORA - 3600000,
        descricao: 'Rejeição 539 desde ontem', abertoPor: 'Ana', reaberturas: 0,
        podeReabrir: false, podeResponder: true },
      mensagens: [
        { id: 9, de: 'equipe', autor: 'Suporte Licite Agora', corpo: 'Oi Ana, já estamos vendo.', em: AGORA - 7200000 },
        { id: 10, de: 'voce', autor: 'Ana', corpo: 'Obrigada!', em: AGORA - 3600000 },
      ],
    };
    f = await abrir('chamado', { largura, q: 'id=1' });

    await t('T5 a conversa separa visualmente os dois lados', async () => {
      const m = await f.evaluate(() => {
        const msgs = [...document.querySelectorAll('.cv-msg')];
        const cx = (e) => e.getBoundingClientRect();
        const eq = msgs.find((x) => x.classList.contains('equipe'));
        const vc = msgs.find((x) => x.classList.contains('voce'));
        return {
          n: msgs.length,
          equipeEsq: eq ? Math.round(cx(eq).left) : null,
          voceDir: vc ? Math.round(cx(vc).right) : null,
          equipeDir: eq ? Math.round(cx(eq).right) : null,
          corEquipe: eq ? getComputedStyle(eq.querySelector('.cv-balao')).backgroundColor : '',
          corVoce: vc ? getComputedStyle(vc.querySelector('.cv-balao')).backgroundColor : '',
          largura: window.innerWidth,
          texto: document.getElementById('conversa').innerText,
        };
      });
      // A descrição entra como primeira fala: 2 mensagens + ela = 3
      assert.strictEqual(m.n, 3, 'a conversa tem ' + m.n + ' balões, esperava 3 (descrição + 2)');
      assert.ok(m.texto.includes('Rejeição 539'), 'a descrição não virou a primeira fala');
      assert.notStrictEqual(m.corEquipe, m.corVoce, 'os dois lados têm a mesma cor de balão');
      assert.ok(m.voceDir > m.equipeDir, 'o balão do cliente não está à direita do da equipe');
    });

    await t('T6 script na mensagem aparece como texto, e não executa', async () => {
      DETALHE = JSON.parse(JSON.stringify(DETALHE));
      DETALHE.mensagens.push({ id: 11, de: 'equipe', autor: 'Suporte',
        corpo: '<script>window.__INVADIU = 1;</scr' + 'ipt><img src=x onerror="window.__INVADIU=2">', em: AGORA });
      const f2 = await abrir('chamado', { largura, q: 'id=1' });
      const m = await f2.evaluate(() => ({
        invadiu: typeof window.__INVADIU !== 'undefined',
        imgs: document.querySelectorAll('.cv-balao img, .cv-balao script').length,
        mostrouTexto: document.getElementById('conversa').innerText.includes('<script>'),
      }));
      assert.ok(!m.invadiu, 'o script da mensagem EXECUTOU');
      assert.strictEqual(m.imgs, 0, 'a mensagem virou marcação: ' + m.imgs + ' elemento(s)');
      assert.ok(m.mostrouTexto, 'o texto do script não aparece como texto na tela');
    });

    await t('T7 chamado resolvido oferece reabrir, com campo', async () => {
      DETALHE = JSON.parse(JSON.stringify(DETALHE));
      DETALHE.chamado.status = 'resolvido';
      DETALHE.chamado.podeResponder = false;
      DETALHE.chamado.podeReabrir = true;
      const f2 = await abrir('chamado', { largura, q: 'id=1' });
      const m = await f2.evaluate(() => {
        const bt = document.getElementById('btReabrir');
        const ta = document.getElementById('corpo');
        return { temBotao: !!bt, temCampo: !!ta,
          botaoVisivel: bt ? bt.getBoundingClientRect().height > 20 : false,
          texto: document.getElementById('rodape').innerText };
      });
      assert.ok(m.temBotao && m.botaoVisivel, 'o botão de reabrir não apareceu');
      assert.ok(m.temCampo, 'reabrir sem campo de justificativa');
      assert.ok(/resolvido/i.test(m.texto), 'o rodapé não explica que foi resolvido');
    });

    await t('T8 chamado encerrado não oferece resposta nem reabertura', async () => {
      DETALHE = JSON.parse(JSON.stringify(DETALHE));
      DETALHE.chamado.status = 'encerrado';
      DETALHE.chamado.podeResponder = false;
      DETALHE.chamado.podeReabrir = false;
      const f2 = await abrir('chamado', { largura, q: 'id=1' });
      const m = await f2.evaluate(() => ({
        temResponder: !!document.getElementById('btResponder'),
        temReabrir: !!document.getElementById('btReabrir'),
        texto: document.getElementById('rodape').innerText,
      }));
      assert.ok(!m.temResponder && !m.temReabrir, 'chamado encerrado ainda oferece ação');
      assert.ok(/encerrado/i.test(m.texto), 'o rodapé não explica o encerramento: "' + m.texto + '"');
    });
  }

  await t('nenhum erro de JavaScript nas telas', () => {
    assert.strictEqual(erros.length, 0, 'erros: ' + [...new Set(erros)].join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${fail === 0 ? 'TODOS OS CASOS PASSARAM' : fail + ' CASO(S) REPROVARAM'}  (${ok} ok, ${fail} falhas)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERRO:', e.stack || e.message); process.exit(1); });
