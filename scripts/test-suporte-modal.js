#!/usr/bin/env node
'use strict';
/**
 * test-suporte-modal.js — a porta de entrada do Suporte, medida em Chrome.
 *
 *   node scripts/test-suporte-modal.js
 *
 * Guarda a experiência decidida em 07/10/2026: o Suporte deixou de ser item
 * do menu lateral e virou botão permanente na topbar, que abre um modal
 * SOBRE a tela atual. Quem fecha continua exatamente onde estava.
 *
 * O que estes casos protegem, e que se perde fácil numa refatoração:
 *   - o botão não pode voltar a navegar direto para "Meus chamados";
 *   - a entrada no menu lateral não pode voltar;
 *   - os blocos que ainda não existem (Central de ajuda, Comunidade) não
 *     podem ganhar link para página inexistente nem canal inventado;
 *   - no celular o modal não pode ser o desktop encolhido.
 *
 *  M1 o botão existe na topbar e é visível   M6 fechar devolve a tela intacta
 *  M2 Suporte saiu do menu lateral           M7 "em breve" sem link falso
 *  M3 clicar abre modal, não navega          M8 nada de canal inventado
 *  M4 os três blocos, na ordem               M9 celular: folha, não desktop
 *  M5 chamados ligam às telas que existem    M10 teclado: Esc e foco preso
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suporte-modal-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* já saiu */ } });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── o que não precisa de browser ──────────────────────────────────────────
  console.log('\n== estrutura ==');
  await t('M2 Suporte NÃO está mais no menu lateral', () => {
    const menu = fs.readFileSync(path.join(PUB, 'js/menu-config.js'), 'utf8');
    assert.ok(!/suporte-chamados|suporte-novo/.test(menu),
      'a entrada de Suporte voltou ao menu lateral');
    assert.ok(!/titulo:\s*'Suporte'/.test(menu), 'há uma seção Suporte no menu');
  });
  await t('M2b as telas continuam alcançáveis pelo RBAC', () => {
    const acesso = fs.readFileSync(path.join(RAIZ, 'perfis-acesso.js'), 'utf8');
    assert.ok(/DIRS_ABERTOS = new Set\(\[[^\]]*'suporte'/.test(acesso),
      "sem a entrada no menu, 'suporte' precisa estar em DIRS_ABERTOS ou as telas dão 403");
    const mapa = fs.readFileSync(path.join(RAIZ, 'perfis-api-map.js'), 'utf8');
    assert.ok(/'\/api\/suporte',/.test(mapa),
      '/api/suporte precisa estar em LIBERADOS: não há página de menu para o MAPA casar');
  });

  const app = require(path.join(RAIZ, 'node_modules/express'))();
  app.get('/api/user/prefs', (_q, rs) => rs.json({ success: true, prefs: {} }));
  app.get('/api/me', (_q, rs) => rs.json({ success: true, usuario: { nome: 'Ana', username: 'ana' } }));
  app.get('/api/features', (_q, rs) => rs.json({ success: true, features: {} }));
  app.get('/favicon.ico', (_q, rs) => rs.status(204).end());
  // Uma tela qualquer do ERP: o que importa é a topbar que o sidebar.js monta.
  app.get('/tela', (_q, rs) => rs.type('html').send(
    '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<link rel="stylesheet" href="/css/sidebar.css"><link rel="stylesheet" href="/css/app-modern.css">'
    + '</head><body><div class="app-container"><nav class="sidebar" id="sidebar"></nav>'
    + '<main class="main-content"><h1>Tela de trabalho</h1>'
    + '<input id="campoDaTela" value="texto que nao pode se perder"></main></div>'
    + '<script src="/js/menu-config.js"></scr' + 'ipt>'
    + '<script src="/js/sidebar.js"></scr' + 'ipt></body></html>'));
  app.use(require(path.join(RAIZ, 'node_modules/express')).static(PUB));
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

  const irPara = async (largura) => {
    await page.setViewport({ width: largura, height: 860, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${porta}/tela`, { waitUntil: 'networkidle0' });
    await esperar(500);
  };
  const abrirModal = async () => {
    await page.click('#btnSuporte');
    await esperar(400);
  };

  for (const [largura, rotulo] of [[1440, 'desktop'], [390, 'celular 390px']]) {
    console.log('\n== ' + rotulo + ' ==');
    await irPara(largura);

    await t('M1 o botão Suporte está na topbar e é visível', async () => {
      const m = await page.evaluate(() => {
        const b = document.getElementById('btnSuporte');
        if (!b) return null;
        const r = b.getBoundingClientRect();
        const tema = document.getElementById('btnTema');
        return {
          l: Math.round(r.width), a: Math.round(r.height), topo: Math.round(r.top),
          rotulo: b.innerText.trim(),
          aria: b.getAttribute('aria-label'),
          antesDoTema: tema ? r.left < tema.getBoundingClientRect().left : null,
        };
      });
      assert.ok(m, 'o botão não existe na topbar');
      assert.ok(m.l > 24 && m.a > 24, 'o botão tem ' + m.l + 'x' + m.a + 'px');
      assert.ok(m.topo < 80, 'o botão não está no topo (top ' + m.topo + 'px)');
      assert.ok(m.antesDoTema, 'o Suporte tem de vir antes do tema e da conta');
      assert.ok(/suporte/i.test(m.aria || ''), 'sem aria-label dizendo o que é');
    });

    await t('M3 clicar ABRE O MODAL, e não navega', async () => {
      const antes = page.url();
      await abrirModal();
      const m = await page.evaluate(() => {
        const d = document.getElementById('ajuda-suporte-modal');
        if (!d) return null;
        const r = d.getBoundingClientRect();
        return { visivel: r.width > 100 && r.height > 100,
          papel: d.getAttribute('role'), modal: d.getAttribute('aria-modal'),
          titulo: (d.querySelector('h2') || {}).textContent };
      });
      assert.strictEqual(page.url(), antes, 'o clique navegou em vez de abrir o modal');
      assert.ok(m && m.visivel, 'o modal não apareceu');
      assert.strictEqual(m.papel, 'dialog');
      assert.strictEqual(m.modal, 'true');
      assert.strictEqual(m.titulo, 'Ajuda e Suporte');
    });

    await t('M4 os três blocos, na ordem decidida', async () => {
      const blocos = await page.evaluate(() => [...document.querySelectorAll('.as-bloco h3')]
        .map((h) => h.textContent.replace(/Em breve/i, '').trim()));
      assert.deepStrictEqual(blocos, ['Suporte', 'Central de ajuda', 'Comunidade e canais'],
        'blocos fora de ordem ou faltando: ' + JSON.stringify(blocos));
    });

    await t('M5 Abrir chamado e Meus chamados levam às telas que existem', async () => {
      const links = await page.evaluate(() => [...document.querySelectorAll('.as-bloco a[href]')]
        .map((a) => ({ texto: a.textContent.trim(), href: a.getAttribute('href'),
          visivel: a.getBoundingClientRect().height > 20 })));
      const novo = links.find((l) => /abrir chamado/i.test(l.texto));
      const meus = links.find((l) => /meus chamados/i.test(l.texto));
      assert.ok(novo && novo.href === '/suporte/novo.html', 'Abrir chamado não aponta para a tela');
      assert.ok(meus && meus.href === '/suporte/chamados.html', 'Meus chamados não aponta para a tela');
      assert.ok(novo.visivel && meus.visivel, 'os botões não ocupam espaço');
      for (const l of links) {
        assert.ok(fs.existsSync(path.join(PUB, l.href.replace(/^\//, ''))),
          'o modal aponta para uma página que não existe: ' + l.href);
      }
    });

    await t('M7 "em breve" não vira link para página falsa', async () => {
      const m = await page.evaluate(() => {
        const achaBloco = (t) => [...document.querySelectorAll('.as-bloco')]
          .find((b) => new RegExp(t, 'i').test(b.querySelector('h3').textContent));
        const ajuda = achaBloco('Central de ajuda');
        return {
          temTag: /em breve/i.test(ajuda.textContent),
          links: ajuda.querySelectorAll('a[href]').length,
          botaoDesabilitado: !!ajuda.querySelector('button[disabled]'),
        };
      });
      assert.ok(m.temTag, 'a Central de ajuda precisa estar marcada como Em breve');
      assert.strictEqual(m.links, 0, 'a Central de ajuda ganhou link para página que não existe');
      assert.ok(m.botaoDesabilitado, 'o botão "Abrir ajuda" tem de estar desabilitado');
    });

    await t('M8 nenhum canal, URL, telefone ou horário inventado', async () => {
      const txt = await page.evaluate(() => document.getElementById('ajuda-suporte-modal').innerText);
      for (const proibido of [/whatsapp/i, /instagram/i, /facebook/i, /youtube/i, /telegram/i,
        /\(\d{2}\)\s*\d/, /https?:\/\//, /\d{1,2}h\s*(às|as)\s*\d{1,2}h/]) {
        assert.ok(!proibido.test(txt),
          'o modal inventou um canal ou dado de contato: ' + proibido + ' em "' + txt.slice(0, 120) + '"');
      }
    });

    /* O `sidebar.js` converte a página num SHELL: o conteúdo da tela vai para
       dentro de `IFRAME#conteudo`, e a topbar e o modal ficam no pai. O estado
       "não pode se perder" é medido LÁ DENTRO, que é onde a pessoa estava
       trabalhando — e o iframe não pode ter recarregado. */
    await t('M6 fechar devolve a tela exatamente como estava', async () => {
      const quadro = page.frames().find((f) => f !== page.mainFrame());
      assert.ok(quadro, 'o shell não montou o iframe de conteúdo');
      const urlAntes = quadro.url();
      await quadro.evaluate(() => {
        const c = document.getElementById('campoDaTela');
        if (c) c.value = 'nao posso sumir';
      });

      await page.click('.as-fechar');
      await esperar(350);

      const m = await page.evaluate(() => ({
        aberto: document.getElementById('ajuda-suporte-modal').style.display !== 'none',
        rolagem: document.body.style.overflow,
      }));
      const campo = await quadro.evaluate(() => {
        const c = document.getElementById('campoDaTela');
        return c ? c.value : null;
      });
      assert.ok(!m.aberto, 'o modal continuou aberto depois do fechar');
      assert.notStrictEqual(m.rolagem, 'hidden', 'a rolagem da página ficou travada');
      assert.strictEqual(campo, 'nao posso sumir', 'a tela de trás perdeu o que estava digitado');
      assert.strictEqual(quadro.url(), urlAntes, 'a tela de trás recarregou');
    });

    if (largura <= 640) {
      await t('M9 no celular o modal é folha de baixo, não desktop encolhido', async () => {
        await abrirModal();
        const m = await page.evaluate(() => {
          const caixa = document.querySelector('.as-caixa');
          const r = caixa.getBoundingClientRect();
          const bts = [...document.querySelectorAll('.as-bloco a.as-bt')];
          const fechar = document.querySelector('.as-fechar').getBoundingClientRect();
          return {
            largura: Math.round(r.width), janela: window.innerWidth,
            coladoEmbaixo: Math.abs(Math.round(r.bottom) - window.innerHeight) <= 2,
            /* O botão ocupa a COLUNA de texto, não a janela: o bloco tem
               ícone de 42px e espaçamentos à esquerda. Medir contra a janela
               reprovava um layout correto. */
            btLargura: bts.length ? Math.round(bts[0].getBoundingClientRect().width) : 0,
            colunaLargura: bts.length
              ? Math.round(bts[0].parentElement.getBoundingClientRect().width) : 0,
            btAltura: bts.length ? Math.round(bts[0].getBoundingClientRect().height) : 0,
            fecharOk: fechar.height >= 38 && fechar.right <= window.innerWidth,
            rolagemLateral: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
          };
        });
        assert.ok(m.largura >= m.janela - 4, 'a folha tem ' + m.largura + 'px numa tela de ' + m.janela);
        assert.ok(m.coladoEmbaixo, 'a folha não está ancorada embaixo');
        assert.ok(m.btLargura >= m.colunaLargura - 2,
          'os botões não ocupam a linha da coluna: ' + m.btLargura + ' de ' + m.colunaLargura + 'px');
        assert.ok(m.colunaLargura > m.janela * 0.7,
          'a coluna de texto está estreita demais: ' + m.colunaLargura + 'px');
        assert.ok(m.btAltura >= 38, 'botão com ' + m.btAltura + 'px é pequeno para tocar');
        assert.ok(m.fecharOk, 'o fechar está pequeno ou fora da tela');
        assert.strictEqual(m.rolagemLateral, 0, 'a página rola de lado com o modal aberto');
        await page.click('.as-fechar');
        await esperar(300);
      });
    } else {
      await t('M9 no desktop o modal é central e não ocupa a tela toda', async () => {
        await abrirModal();
        const m = await page.evaluate(() => {
          const r = document.querySelector('.as-caixa').getBoundingClientRect();
          return { largura: Math.round(r.width), janela: window.innerWidth,
            centro: Math.abs((r.left + r.right) / 2 - window.innerWidth / 2) < 4 };
        });
        assert.ok(m.largura < m.janela * 0.6, 'o modal ocupa ' + m.largura + 'px de ' + m.janela);
        assert.ok(m.centro, 'o modal não está centralizado');
        await page.click('.as-fechar');
        await esperar(300);
      });

      await t('M10 Esc fecha e o foco volta para o botão', async () => {
        await abrirModal();
        const focoDentro = await page.evaluate(() =>
          !!document.getElementById('ajuda-suporte-modal').contains(document.activeElement));
        assert.ok(focoDentro, 'ao abrir, o foco tem de entrar no modal');
        await page.keyboard.press('Escape');
        await esperar(350);
        const m = await page.evaluate(() => ({
          aberto: document.getElementById('ajuda-suporte-modal').style.display !== 'none',
          focoNoBotao: document.activeElement === document.getElementById('btnSuporte'),
        }));
        assert.ok(!m.aberto, 'Esc não fechou o modal');
        assert.ok(m.focoNoBotao, 'o foco não voltou para o botão Suporte');
      });
    }
  }

  await t('nenhum erro de JavaScript', () => {
    assert.strictEqual(erros.length, 0, 'erros: ' + [...new Set(erros)].join(' | '));
  });

  await browser.close();
  srv.close();
  console.log(`\n${fail === 0 ? 'TODOS OS CASOS PASSARAM' : fail + ' CASO(S) REPROVARAM'}  (${ok} ok, ${fail} falhas)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERRO:', e.stack || e.message); process.exit(1); });
