/**
 * diagnostico-visual.js — inventário da camada visual do ERP. READ-ONLY.
 *
 * Não escreve nada, não toca banco, não chama API. Só lê `public/` e conta.
 *
 * Existe para responder com NÚMERO, e não com impressão, três perguntas que
 * decidem o tamanho de uma modernização visual:
 *
 *   1. quantas telas herdam de fato a camada global (e quantas escapam dela);
 *   2. o que está duplicado ou preso em CSS local, que a camada global não
 *      alcança;
 *   3. onde há cor fixa — que é o que quebra tema claro/escuro e, portanto, o
 *      que limita qualquer mudança de identidade.
 *
 *   node scripts/diagnostico-visual.js
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');

const telas = [];
(function varrer(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) varrer(p);
    else if (e.name.endsWith('.html')) telas.push(p);
  }
})(PUB);

const rel = (p) => path.relative(PUB, p);
const ler = (p) => fs.readFileSync(p, 'utf8');

// ---------- coleta por tela ----------
const dados = telas.map((p) => {
  const s = ler(p);
  const estilos = [...s.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const inline = [...s.matchAll(/style\s*=\s*"([^"]*)"/g)].map((m) => m[1]);
  return {
    arq: rel(p),
    bytes: Buffer.byteLength(s),
    appModern: s.includes('app-modern.css'),
    sidebarCss: s.includes('sidebar.css'),
    sidebarJs: s.includes('/js/sidebar.js'),
    themeBoot: s.includes('/js/theme-boot.js'),
    pageHeader: s.includes('page-header'),
    cssLocalLinhas: estilos ? estilos.split('\n').length : 0,
    cssLocalBytes: Buffer.byteLength(estilos),
    inlineCount: inline.length,
    // cor literal: o que impede tema/identidade de mudar por token
    coresLocais: (estilos.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length,
    coresInline: inline.join(';').match(/#[0-9a-fA-F]{3,8}\b/g)?.length || 0,
    tokens: (estilos.match(/var\(--/g) || []).length,
    tabela: /<table\b/.test(s),
    modal: /class="modal/.test(s),
    tabs: /class="tabs?"/.test(s),
    grid: s.includes('/js/grid.js'),
  };
});

const n = (f) => dados.filter(f).length;
const soma = (f) => dados.reduce((a, d) => a + f(d), 0);
const pct = (x) => `${((x / telas.length) * 100).toFixed(0)}%`;

const L = (r, v) => console.log('  ' + String(r).padEnd(52) + v);
const T = (t) => console.log('\n== ' + t + ' ' + '='.repeat(Math.max(0, 58 - t.length)));

console.log('DIAGNÓSTICO VISUAL — somente leitura\n');
L('telas .html em public/', telas.length);

T('HERANÇA DA CAMADA GLOBAL');
const doErp = dados.filter((d) => d.sidebarJs);
L('carregam app-modern.css', `${n((d) => d.appModern)}  (${pct(n((d) => d.appModern))})`);
L('carregam sidebar.css', `${n((d) => d.sidebarCss)}  (${pct(n((d) => d.sidebarCss))})`);
L('carregam sidebar.js  = telas do ERP autenticado', `${doErp.length}  (${pct(doErp.length)})`);
L('carregam theme-boot.js (tema claro/escuro)', `${n((d) => d.themeBoot)}  (${pct(n((d) => d.themeBoot))})`);
L('usam .page-header', `${n((d) => d.pageHeader)}  (${pct(n((d) => d.pageHeader))})`);
L('FORA do ERP (sem sidebar.js)', telas.length - doErp.length);
console.log('     ' + dados.filter((d) => !d.sidebarJs).map((d) => d.arq).join(', ').slice(0, 400));

T('CSS LOCAL — o que a camada global NÃO alcança');
L('telas com <style> próprio', `${n((d) => d.cssLocalLinhas > 0)}  (${pct(n((d) => d.cssLocalLinhas > 0))})`);
L('total de linhas de CSS local', soma((d) => d.cssLocalLinhas).toLocaleString('pt-BR'));
L('total de KB de CSS local', (soma((d) => d.cssLocalBytes) / 1024).toFixed(0) + ' KB');
L('telas com CSS local > 100 linhas', n((d) => d.cssLocalLinhas > 100));
console.log('\n  As 12 telas com mais CSS próprio (as que mais resistem ao global):');
dados.slice().sort((a, b) => b.cssLocalLinhas - a.cssLocalLinhas).slice(0, 12)
  .forEach((d) => console.log(`    ${String(d.cssLocalLinhas).padStart(5)} linhas  ${d.arq}`));

T('ESTILO INLINE (style="...")');
L('total de atributos style=', soma((d) => d.inlineCount).toLocaleString('pt-BR'));
L('telas com algum style=', `${n((d) => d.inlineCount > 0)}  (${pct(n((d) => d.inlineCount > 0))})`);
L('média por tela', (soma((d) => d.inlineCount) / telas.length).toFixed(0));
console.log('\n  As 10 telas com mais estilo inline:');
dados.slice().sort((a, b) => b.inlineCount - a.inlineCount).slice(0, 10)
  .forEach((d) => console.log(`    ${String(d.inlineCount).padStart(4)} style=  ${d.arq}`));

T('COR FIXA — o que limita tema e identidade');
L('cores literais em <style> local', soma((d) => d.coresLocais).toLocaleString('pt-BR'));
L('cores literais em style= inline', soma((d) => d.coresInline).toLocaleString('pt-BR'));
L('usos de var(--token) em CSS local', soma((d) => d.tokens).toLocaleString('pt-BR'));
const totalCor = soma((d) => d.coresLocais) + soma((d) => d.coresInline);
const totalTok = soma((d) => d.tokens);
L('proporção token : cor fixa', `${totalTok} : ${totalCor}  (${(totalTok / (totalTok + totalCor) * 100).toFixed(0)}% já é token)`);
console.log('\n  As 10 telas com mais cor fixa:');
dados.slice().sort((a, b) => (b.coresLocais + b.coresInline) - (a.coresLocais + a.coresInline)).slice(0, 10)
  .forEach((d) => console.log(`    ${String(d.coresLocais + d.coresInline).padStart(4)} cores  ${d.arq}`));

T('COMPONENTES EM USO');
L('telas com <table>', `${n((d) => d.tabela)}  (${pct(n((d) => d.tabela))})`);
L('telas com modal', `${n((d) => d.modal)}  (${pct(n((d) => d.modal))})`);
L('telas com abas (.tabs)', `${n((d) => d.tabs)}  (${pct(n((d) => d.tabs))})`);
L('telas com grid.js (grid configurável)', `${n((d) => d.grid)}  (${pct(n((d) => d.grid))})`);

T('CAMADA GLOBAL — tamanho dos arquivos');
for (const f of ['css/app-modern.css', 'css/sidebar.css', 'js/sidebar.js', 'js/theme-boot.js',
                 'js/menu-config.js', 'js/grid.js', 'js/icons.js', 'app.html']) {
  const p = path.join(PUB, f);
  if (!fs.existsSync(p)) { L(f, '(ausente)'); continue; }
  const s = ler(p);
  L(f, `${String(s.split('\n').length).padStart(5)} linhas   ${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`);
}

T('CLASSES GLOBAIS MAIS USADAS (candidatas a virar componente)');
const classes = {};
for (const p of telas) {
  for (const m of ler(p).matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) {
      if (!c || c.includes('${')) continue;
      classes[c] = (classes[c] || 0) + 1;
    }
  }
}
Object.entries(classes).sort((a, b) => b[1] - a[1]).slice(0, 26)
  .forEach(([c, q]) => console.log(`    ${String(q).padStart(5)}×  .${c}`));

T('VARIANTES DE BOTÃO EM USO');
const btns = {};
for (const p of telas) {
  for (const m of ler(p).matchAll(/class\s*=\s*"([^"]*\bbtn\b[^"]*)"/g)) {
    const v = m[1].split(/\s+/).filter((c) => c.startsWith('btn')).sort().join(' ');
    if (v) btns[v] = (btns[v] || 0) + 1;
  }
}
const listaBtn = Object.entries(btns).sort((a, b) => b[1] - a[1]);
L('combinações distintas de classe .btn', listaBtn.length);
listaBtn.slice(0, 14).forEach(([v, q]) => console.log(`    ${String(q).padStart(5)}×  ${v}`));

T('TIPOGRAFIA E TOKENS DECLARADOS');
const app = ler(path.join(PUB, 'css/app-modern.css'));
const fontes = [...new Set([...app.matchAll(/font-family:\s*([^;!]+)/g)].map((m) => m[1].trim().slice(0, 60)))];
L('famílias de fonte declaradas em app-modern.css', fontes.length);
fontes.slice(0, 4).forEach((f) => console.log(`    ${f}`));
const tamanhos = [...new Set([...app.matchAll(/font-size:\s*([\d.]+(?:px|rem|em))/g)].map((m) => m[1]))];
L('tamanhos de fonte distintos no CSS global', tamanhos.length);
console.log('    ' + tamanhos.sort().join('  '));
const tokensDef = [...new Set([...app.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))];
L('tokens declarados em app-modern.css', tokensDef.length);
console.log('    ' + tokensDef.join('  '));

T('LOGO — onde aparece e em que formatos');
const imgs = {};
for (const p of telas.concat([path.join(PUB, 'js/sidebar.js'), path.join(PUB, 'js/menu-config.js')])) {
  if (!fs.existsSync(p)) continue;
  for (const m of ler(p).matchAll(/["'(]([^"'()]*\/(?:img|imagens|assets)\/[^"'()]*\.(?:png|jpe?g|svg|ico|webp))["')]/gi)) {
    const a = m[1];
    if (/logo|marca|brand|favicon|icon/i.test(a)) imgs[a] = (imgs[a] || 0) + 1;
  }
}
Object.entries(imgs).sort((a, b) => b[1] - a[1]).forEach(([a, q]) => {
  const f = path.join(PUB, a.replace(/^\//, ''));
  let info = '(não encontrado no disco)';
  if (fs.existsSync(f)) {
    const st = fs.statSync(f);
    info = `${(st.size / 1024).toFixed(1)} KB`;
  }
  console.log(`    ${String(q).padStart(4)}×  ${a.padEnd(40)} ${info}`);
});
const dirImg = path.join(PUB, 'img');
if (fs.existsSync(dirImg)) {
  console.log('\n  Arquivos em public/img/ com cara de marca:');
  for (const f of fs.readdirSync(dirImg)) {
    if (!/logo|marca|favicon|icon|brand/i.test(f)) continue;
    const st = fs.statSync(path.join(dirImg, f));
    console.log(`    ${f.padEnd(34)} ${(st.size / 1024).toFixed(1)} KB`);
  }
}
const fav = [...new Set(telas.flatMap((p) =>
  [...ler(p).matchAll(/<link[^>]+rel="[^"]*icon[^"]*"[^>]*href="([^"]+)"/gi)].map((m) => m[1])))];
L('\n  favicons referenciados', fav.length ? fav.join(', ') : 'NENHUM');

console.log('\n(diagnóstico read-only — nada foi alterado)');
