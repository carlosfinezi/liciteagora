/**
 * test-contraste-tema.js — os quatro níveis de texto contra todos os fundos.
 *
 * Nasceu de um defeito medido em 30/09/2026: o `--text-3` do tema ESCURO era
 * #64748b, que dá 3,73:1 sobre `--bg-2` e 2,74:1 sobre `--bg-hover`, contra os
 * 4,5:1 que o WCAG AA pede. O tema claro tinha esse cálculo feito e anotado nos
 * comentários do CSS; o escuro não, e o detector acusava 171 telas.
 *
 * Lê as variáveis do `app-modern.css` direto — sem navegador, em milissegundos.
 *
 * Roda da raiz do projeto: node scripts/test-contraste-tema.js
 */
const fs = require('fs');
const path = require('path');
const RAIZ = path.join(__dirname, '..');

const MINIMO = 4.5;
let falhas = 0, total = 0;

function luminancia(hex) {
  const h = hex.replace('#', '');
  const canais = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = canais.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function razao(a, b) {
  const la = luminancia(a), lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * As variáveis de cada tema.
 *
 * O `:root` traz o tema escuro; `[data-theme="claro"]` sobrescreve o que muda.
 * Ler assim, e não com uma lista fixa aqui dentro, é o que faz este teste
 * acompanhar o CSS em vez de medir uma cópia velha dele.
 */
function variaveis(css, seletor) {
  const i = css.indexOf(seletor);
  if (i < 0) throw new Error(`não achei ${seletor} no app-modern.css`);
  const abre = css.indexOf('{', i);
  const fecha = css.indexOf('}', abre);
  const bloco = css.slice(abre, fecha);
  const out = {};
  for (const m of bloco.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) out['--' + m[1]] = m[2];
  return out;
}

const css = fs.readFileSync(path.join(RAIZ, 'public', 'css', 'app-modern.css'), 'utf8');
const escuro = variaveis(css, ':root');
const claro = { ...escuro, ...variaveis(css, '[data-theme="claro"]') };

const TEXTOS = ['--text-0', '--text-1', '--text-2', '--text-3'];
const FUNDOS = ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-hover', '--bg-input'];

for (const [nomeTema, tema] of [['escuro', escuro], ['claro', claro]]) {
  console.log(`\ntema ${nomeTema}`);
  for (const t of TEXTOS) {
    if (!tema[t]) { console.log(`  (sem ${t})`); continue; }
    const linha = [];
    let pior = Infinity, piorFundo = '';
    for (const f of FUNDOS) {
      if (!tema[f]) continue;
      const r = razao(tema[t], tema[f]);
      linha.push(`${f.replace('--bg-', '')}=${r.toFixed(2)}`);
      if (r < pior) { pior = r; piorFundo = f; }
    }
    total++;
    const ok = pior >= MINIMO;
    if (!ok) falhas++;
    console.log(`  ${ok ? 'ok  ' : 'FALHA'} ${t} (${tema[t]}): pior ${pior.toFixed(2)}:1 em ${piorFundo}  [${linha.join(' ')}]`);
  }
}

/* A hierarquia tem de continuar existindo: cada nível mais apagado que o de
   cima. Contraste alto demais no --text-3 apagaria a diferença entre os
   níveis, e aí eles deixariam de significar algo. */
console.log('\nhierarquia (cada nível mais apagado que o anterior, sobre --bg-2)');
for (const [nomeTema, tema] of [['escuro', escuro], ['claro', claro]]) {
  const rs = TEXTOS.filter((t) => tema[t]).map((t) => ({ t, r: razao(tema[t], tema['--bg-2']) }));
  let ordenado = true;
  for (let i = 1; i < rs.length; i++) if (rs[i].r > rs[i - 1].r) ordenado = false;
  total++;
  if (!ordenado) falhas++;
  console.log(`  ${ordenado ? 'ok  ' : 'FALHA'} ${nomeTema}: ${rs.map((x) => `${x.t}=${x.r.toFixed(2)}`).join(' > ')}`);
}

/* A cor da marca de campo errado precisa ser legível nos dois temas: é ela que
   diz o que está errado, em `campo-formato.js`. */
console.log('\na marca de campo errado (--danger, usada pelo .diz-falta)');
for (const [nomeTema, tema] of [['escuro', escuro], ['claro', claro]]) {
  const r = razao(tema['--danger'], tema['--bg-1']);
  total++;
  const ok = r >= 4.5;
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} ${nomeTema}: --danger (${tema['--danger']}) sobre --bg-1 = ${r.toFixed(2)}:1`);
}

console.log(`\n${falhas ? 'FALHOU' : 'OK'}: ${total - falhas}/${total} checagens (mínimo ${MINIMO}:1)`);
process.exit(falhas ? 1 : 0);
