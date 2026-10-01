/**
 * test-campo-formato.js — a peça de campo (`public/js/campo-formato.js`).
 *
 * Monta um formulário com UM campo de cada formato, no Chrome, e prova o que a
 * peça promete: máscara enquanto se digita, limite de tamanho, teclado do
 * celular, dígito verificador, marcação no próprio campo, e o valor numérico
 * que o dinheiro entrega ao JavaScript.
 *
 * Esse último é o que protege as 152 leituras de `.value` que as 48 telas de
 * dinheiro já fazem: se o campo passasse a devolver "R$ 1.234,56", todas elas
 * receberiam NaN.
 *
 * Roda da raiz do projeto: node scripts/test-campo-formato.js
 */
const path = require('path');
const fs = require('fs');
const RAIZ = path.join(__dirname, '..');
const express = require(path.join(RAIZ, 'node_modules', 'express'));
const puppeteer = require(path.join(RAIZ, 'node_modules', 'puppeteer-core'));

const PORTA = Number(process.env.PORTA_TESTE || 39911);
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';

let falhas = 0, total = 0;
function checa(rotulo, condicao, detalhe = '') {
  total++;
  if (condicao) { console.log(`  ok   ${rotulo}`); return; }
  falhas++;
  console.log(`  FALHA ${rotulo}${detalhe ? ' — ' + detalhe : ''}`);
}

const PAGINA = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/app-modern.css">
</head><body>
<form id="f">
  <div class="form-group"><label for="tel">Telefone</label>
    <input id="tel" data-formato="telefone"></div>
  <div class="form-group"><label for="doc">CPF/CNPJ</label>
    <input id="doc" data-formato="cpfcnpj"></div>
  <div class="form-group"><label for="cpf">CPF</label>
    <input id="cpf" data-formato="cpf"></div>
  <div class="form-group"><label for="cnpj">CNPJ</label>
    <input id="cnpj" data-formato="cnpj"></div>
  <div class="form-group"><label for="cep">CEP</label>
    <input id="cep" data-formato="cep" data-cep-rua="rua" data-cep-bairro="bairro"
           data-cep-cidade="cidade" data-cep-uf="uf"></div>
  <div class="form-group"><label for="rua">Rua</label><input id="rua"></div>
  <div class="form-group"><label for="bairro">Bairro</label><input id="bairro"></div>
  <div class="form-group"><label for="cidade">Cidade</label><input id="cidade"></div>
  <div class="form-group"><label for="uf">UF</label><input id="uf"></div>
  <div class="form-group"><label for="din">Valor</label>
    <input id="din" data-formato="dinheiro"></div>
  <div class="form-group"><label for="dt">Data</label>
    <input id="dt" data-formato="data"></div>
  <div class="form-group"><label for="hr">Hora</label>
    <input id="hr" data-formato="hora"></div>
  <div class="form-group"><label for="pl">Placa</label>
    <input id="pl" data-formato="placa"></div>
  <div class="form-group"><label for="ie">Inscrição estadual</label>
    <input id="ie" data-formato="inscricao"></div>
  <div class="form-group"><label for="em">E-mail</label>
    <input id="em" type="email" data-formato="email"></div>
  <div class="form-group"><label for="nome">Nome</label><input id="nome"></div>
</form>
<div id="depois"></div>
<script src="/js/campo-formato.js"></script>
</body></html>`;

(async () => {
  const app = express();
  app.get('/teste', (_q, s) => s.type('html').send(PAGINA));
  app.use(express.static(path.join(RAIZ, 'public')));
  const srv = app.listen(PORTA);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    userDataDir: `/tmp/campo-formato-${process.pid}`,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
  });

  try {
    const page = await browser.newPage();
    const errosJs = [];
    page.on('pageerror', (e) => errosJs.push(String(e.message)));
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`http://127.0.0.1:${PORTA}/teste`, { waitUntil: 'domcontentloaded' });
    await new Promise((r) => setTimeout(r, 400));

    /* ---------- A. a máscara enquanto se digita ---------- */
    console.log('\nA. a máscara sai sozinha, tecla por tecla');
    const digitar = async (id, texto) => {
      await page.click(`#${id}`, { clickCount: 3 });
      await page.$eval(`#${id}`, (el) => { el.value = ''; });
      await page.type(`#${id}`, texto, { delay: 2 });
      // o valor VISÍVEL, que é o do input (o de dinheiro tem acessor próprio)
      return page.$eval(`#${id}`, (el) => el.getAttribute('value') === null
        ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(el)
        : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get.call(el));
    };
    const casos = [
      ['tel', '94991769924', '(94) 99176-9924', 'celular'],
      ['tel', '9433221100', '(94) 3322-1100', 'fixo'],
      ['doc', '52998224725', '529.982.247-25', 'CPF no campo combinado'],
      ['doc', '11222333000181', '11.222.333/0001-81', 'CNPJ no campo combinado'],
      ['cpf', '52998224725', '529.982.247-25', 'CPF'],
      ['cnpj', '11222333000181', '11.222.333/0001-81', 'CNPJ'],
      ['cep', '68506640', '68506-640', 'CEP'],
      ['dt', '31122026', '31/12/2026', 'data'],
      ['hr', '2345', '23:45', 'hora'],
      ['pl', 'abc1d23', 'ABC1D23', 'placa Mercosul em maiúscula'],
      ['din', '123456', 'R$ 1.234,56', 'dinheiro crescendo da direita'],
      ['din', '5', 'R$ 0,05', 'dinheiro de um dígito'],
    ];
    for (const [id, entra, esperado, rotulo] of casos) {
      const saiu = await digitar(id, entra);
      checa(`${rotulo}: "${entra}" → "${esperado}"`, saiu === esperado, `saiu "${saiu}"`);
    }

    /* ---------- B. colar também entra formatado ---------- */
    console.log('\nB. colar entra formatado igual');
    const colado = await page.evaluate(() => {
      const el = document.getElementById('doc');
      el.value = '';
      el.value = '529.982.247-25';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.value;
    });
    checa('documento colado com pontuação', colado === '529.982.247-25', `ficou "${colado}"`);

    /* ---------- C. limite e teclado do celular ---------- */
    console.log('\nC. limite de tamanho e teclado do celular');
    const atributos = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('input[data-formato]')) {
        out[el.id] = { max: el.getAttribute('maxlength'), modo: el.getAttribute('inputmode') };
      }
      return out;
    });
    checa('telefone: maxlength 16 e inputmode tel', atributos.tel.max === '16' && atributos.tel.modo === 'tel', JSON.stringify(atributos.tel));
    checa('cpfcnpj: maxlength 18 e teclado numérico', atributos.doc.max === '18' && atributos.doc.modo === 'numeric', JSON.stringify(atributos.doc));
    checa('cep: maxlength 9 e teclado numérico', atributos.cep.max === '9' && atributos.cep.modo === 'numeric', JSON.stringify(atributos.cep));
    checa('dinheiro: teclado decimal', atributos.din.modo === 'decimal', JSON.stringify(atributos.din));
    checa('data: maxlength 10 e teclado numérico', atributos.dt.max === '10' && atributos.dt.modo === 'numeric', JSON.stringify(atributos.dt));
    checa('e-mail: teclado de e-mail', atributos.em.modo === 'email', JSON.stringify(atributos.em));

    /* ---------- D. o dinheiro entrega NÚMERO ao JavaScript ---------- */
    console.log('\nD. dinheiro: a tela mostra máscara, o JavaScript lê número');
    const dinheiro = await page.evaluate(() => {
      const el = document.getElementById('din');
      const nativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      el.value = '';
      nativo.set.call(el, '1234,56');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const visivel = nativo.get.call(el);
      const lido = el.value;
      const numeroLido = Number(el.value);
      // e o caminho inverso: gravar número formata a tela
      el.value = 98765.43;
      return { visivel, lido, numeroLido, depoisDeGravarNumero: nativo.get.call(el) };
    });
    checa('a tela mostra "R$ 1.234,56"', dinheiro.visivel === 'R$ 1.234,56', `mostrou "${dinheiro.visivel}"`);
    checa('el.value devolve "1234.56"', dinheiro.lido === '1234.56', `devolveu "${dinheiro.lido}"`);
    checa('Number(el.value) dá 1234.56 (as 152 leituras seguem valendo)', dinheiro.numeroLido === 1234.56, `deu ${dinheiro.numeroLido}`);
    checa('gravar 98765.43 mostra "R$ 98.765,43"', dinheiro.depoisDeGravarNumero === 'R$ 98.765,43', `mostrou "${dinheiro.depoisDeGravarNumero}"`);
    const vazio = await page.evaluate(() => {
      const el = document.getElementById('din');
      el.value = '';
      return { lido: el.value, numero: Number(el.value) };
    });
    checa('campo vazio devolve "" e não NaN', vazio.lido === '' && vazio.numero === 0, JSON.stringify(vazio));

    /* ---------- E. o dígito verificador ---------- */
    console.log('\nE. dígito verificador de CPF e CNPJ');
    const dv = await page.evaluate(() => ({
      cpfBom: CampoFormato.cpfValido('52998224725'),
      cpfRuim: CampoFormato.cpfValido('52998224726'),
      cpfRepetido: CampoFormato.cpfValido('11111111111'),
      cnpjBom: CampoFormato.cnpjValido('11222333000181'),
      cnpjRuim: CampoFormato.cnpjValido('11222333000182'),
      erroCpfRuim: (() => {
        const el = document.getElementById('doc');
        el.value = '529.982.247-26';
        return CampoFormato.erroDoCampo(el);
      })(),
      erroCnpjNoCampoDeCnpj: (() => {
        const el = document.getElementById('cnpj');
        el.value = '529.982.247-25';   // CPF válido num campo de CNPJ
        return CampoFormato.erroDoCampo(el);
      })(),
      dataImpossivel: (() => {
        const el = document.getElementById('dt');
        el.value = '31/02/2026';
        return CampoFormato.erroDoCampo(el);
      })(),
      horaImpossivel: (() => {
        const el = document.getElementById('hr');
        el.value = '25:00';
        return CampoFormato.erroDoCampo(el);
      })(),
      placaRuim: (() => {
        const el = document.getElementById('pl');
        el.value = 'AB1';
        return CampoFormato.erroDoCampo(el);
      })(),
      isento: (() => {
        const el = document.getElementById('ie');
        el.value = 'ISENTO';
        return { valor: el.value, erro: CampoFormato.erroDoCampo(el) };
      })(),
    }));
    checa('CPF bom passa', dv.cpfBom === true);
    checa('CPF com dígito errado reprova', dv.cpfRuim === false);
    checa('CPF repetido reprova', dv.cpfRepetido === false);
    checa('CNPJ bom passa', dv.cnpjBom === true);
    checa('CNPJ com dígito errado reprova', dv.cnpjRuim === false);
    checa('erro do CPF errado tem frase', /inválido/i.test(String(dv.erroCpfRuim)), String(dv.erroCpfRuim));
    checa('CPF num campo de CNPJ é recusado', /14 n/i.test(String(dv.erroCnpjNoCampoDeCnpj)), String(dv.erroCnpjNoCampoDeCnpj));
    checa('31/02 é recusado', /data/i.test(String(dv.dataImpossivel)), String(dv.dataImpossivel));
    checa('25:00 é recusado', /hora/i.test(String(dv.horaImpossivel)), String(dv.horaImpossivel));
    checa('placa incompleta é recusada', /placa/i.test(String(dv.placaRuim)), String(dv.placaRuim));
    checa('ISENTO passa na inscrição estadual', dv.isento.erro === null, JSON.stringify(dv.isento));

    /* ---------- F. a marcação no próprio campo ---------- */
    console.log('\nF. a marcação vai no campo, e não numa caixa');
    const marcou = await page.evaluate(() => {
      const doc = document.getElementById('doc');
      const nome = document.getElementById('nome');
      doc.value = '529.982.247-26';
      nome.value = '';
      const ok = CampoFormato.validar('f', [['nome', 'o nome']]);
      const frase = doc.nextElementSibling;
      return {
        validouFalso: ok === false,
        docTemClasse: doc.classList.contains('falta'),
        docTemAria: doc.getAttribute('aria-invalid') === 'true',
        temFrase: !!(frase && frase.classList.contains('diz-falta')),
        fraseTexto: frase ? frase.textContent : '',
        nomeMarcado: nome.classList.contains('falta'),
        fraseDoNome: nome.nextElementSibling ? nome.nextElementSibling.textContent : '',
        focoNoPrimeiro: document.activeElement && document.activeElement.id,
      };
    });
    checa('validar devolve false quando há falta', marcou.validouFalso);
    checa('campo errado recebe .falta', marcou.docTemClasse);
    checa('campo errado recebe aria-invalid', marcou.docTemAria);
    checa('a frase aparece abaixo do campo', marcou.temFrase && /inválido/i.test(marcou.fraseTexto), marcou.fraseTexto);
    checa('obrigatório vazio também é marcado', marcou.nomeMarcado && /Informe o nome/.test(marcou.fraseDoNome), marcou.fraseDoNome);
    checa('o foco vai ao primeiro que falta na TELA', marcou.focoNoPrimeiro === 'doc', `foi para ${marcou.focoNoPrimeiro}`);

    const saiuSozinha = await page.evaluate(() => {
      const doc = document.getElementById('doc');
      doc.value = '529.982.247-25';
      doc.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        classe: doc.classList.contains('falta'),
        aria: doc.getAttribute('aria-invalid'),
        frase: !!(doc.nextElementSibling && doc.nextElementSibling.classList.contains('diz-falta')),
      };
    });
    checa('a marca sai sozinha quando a pessoa mexe no campo',
      !saiuSozinha.classe && !saiuSozinha.aria && !saiuSozinha.frase, JSON.stringify(saiuSozinha));

    /* ---------- G. a marca é visível, e vermelha, nos dois temas ---------- */
    console.log('\nG. a marca aparece de verdade, nos dois temas');
    for (const tema of ['escuro', 'claro']) {
      await page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t);
        const doc = document.getElementById('doc');
        CampoFormato.limparFaltas();
        CampoFormato.marcarFalta(doc, 'CPF inválido. Confira os números');
      }, tema);
      // `input` tem `transition: border-color 0.15s`: medir na hora pega a cor
      // no meio do caminho, e foi o que reprovou esta etapa da primeira vez.
      await new Promise((r) => setTimeout(r, 300));
      const visual = await page.evaluate(() => {
        const doc = document.getElementById('doc');
        const cs = getComputedStyle(doc);
        const frase = doc.nextElementSibling;
        const fcs = frase ? getComputedStyle(frase) : null;
        const rect = frase ? frase.getBoundingClientRect() : null;
        return {
          borda: cs.borderTopColor,
          fraseCor: fcs ? fcs.color : '',
          fraseVisivel: !!(rect && rect.width > 30 && rect.height > 8),
        };
      });
      const vermelho = (c) => {
        const m = String(c).match(/(\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return false;
        const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
        return r > 120 && r > g * 1.6 && r > b * 1.6;
      };
      checa(`tema ${tema}: a borda do campo fica vermelha`, vermelho(visual.borda), visual.borda);
      checa(`tema ${tema}: a frase fica vermelha`, vermelho(visual.fraseCor), visual.fraseCor);
      checa(`tema ${tema}: a frase ocupa espaço na tela`, visual.fraseVisivel, JSON.stringify(visual));
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'escuro'));

    /* ---------- H. campo criado depois nasce pronto ---------- */
    console.log('\nH. campo que a tela cria depois (modal, linha de grade)');
    const criado = await page.evaluate(async () => {
      document.getElementById('depois').innerHTML =
        '<input id="novo" data-formato="telefone"><input id="novoDin" data-formato="dinheiro">';
      await new Promise((r) => setTimeout(r, 60));
      const el = document.getElementById('novo');
      el.value = '94991769924';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const din = document.getElementById('novoDin');
      const nativo = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      nativo.set.call(din, '7777');
      din.dispatchEvent(new Event('input', { bubbles: true }));
      return { tel: el.value, max: el.getAttribute('maxlength'), dinLido: din.value, dinVisivel: nativo.get.call(din) };
    });
    checa('campo novo já mascara', criado.tel === '(94) 99176-9924', criado.tel);
    checa('campo novo já tem limite', criado.max === '16', String(criado.max));
    checa('dinheiro novo entrega número', criado.dinLido === '77.77', criado.dinLido);
    checa('dinheiro novo mostra máscara', criado.dinVisivel === 'R$ 77,77', criado.dinVisivel);

    /* ---------- I. a busca de CEP não usa id fixo ---------- */
    console.log('\nI. a busca de CEP escreve nos ids que a tela declarou');
    const fonte = fs.readFileSync(path.join(RAIZ, 'public', 'js', 'campo-formato.js'), 'utf8');
    // Sem os comentários: o cabeçalho da função CITA os ids antigos para
    // explicar por que saíram, e procurá-los no arquivo cru acusaria a própria
    // explicação.
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    checa('a peça não usa mais os ids do checkout da loja',
      !/chkRua|chkBairro|chkCidade|chkUf/.test(codigo));
    checa('a peça lê o destino de data-cep-*', /dataset\.cepRua/.test(fonte) && /dataset\.cepCidade/.test(fonte));

    /* ---------- J. nenhum erro de JavaScript ---------- */
    console.log('\nJ. nenhum erro de JavaScript no caminho');
    checa('nenhum pageerror', errosJs.length === 0, errosJs.join(' | '));

  } finally {
    await browser.close();
    srv.close();
  }

  console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens`);
  process.exit(falhas ? 1 : 0);
})();
