/**
 * inserir-theme-boot.js — põe o anti-flash do tema no <head> das telas.
 *
 *   node scripts/inserir-theme-boot.js            relatório, não escreve
 *   node scripts/inserir-theme-boot.js --aplicar  grava
 *
 * O `theme-boot.js` precisa rodar ANTES do CSS para o primeiro paint já sair no
 * tema certo (ver o cabeçalho daquele arquivo). Como são 212 telas, fazer isso à
 * mão seria uma linha esquecida em algum lugar — e a tela esquecida é justamente
 * a que pisca.
 *
 * Regras de segurança do mutirão, todas necessárias:
 *   - só toca em .html de public/ que carreguem `/js/sidebar.js` (é o conjunto
 *     das telas autenticadas do ERP; login e páginas públicas ficam de fora);
 *   - **idempotente**: quem já tem a linha é pulado, então rodar duas vezes não
 *     duplica nada;
 *   - insere ANTES do primeiro <link rel="stylesheet">, que é o que garante a
 *     ordem correta;
 *   - arquivo sem <link rel="stylesheet"> no <head> é PULADO e relatado, em vez
 *     de receber a linha num lugar adivinhado.
 */
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const PUB = path.join(RAIZ, 'public');
const LINHA = '<script src="/js/theme-boot.js"></script>';
const aplicar = process.argv.includes('--aplicar');

function varrer(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) varrer(p, acc);
    else if (e.isFile() && e.name.endsWith('.html')) acc.push(p);
  }
  return acc;
}

const alvos = varrer(PUB).filter((f) => {
  const s = fs.readFileSync(f, 'utf8');
  return s.includes('/js/sidebar.js');
});

let inseridos = 0, jaTinha = 0, semAncora = [];

for (const f of alvos) {
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('/js/theme-boot.js')) { jaTinha++; continue; }

  const m = /([ \t]*)<link\s+rel="stylesheet"/i.exec(src);
  if (!m) { semAncora.push(path.relative(RAIZ, f)); continue; }

  const indent = m[1] || '';
  const novo = src.slice(0, m.index) + indent + LINHA + '\n' + src.slice(m.index);
  if (aplicar) fs.writeFileSync(f, novo);
  inseridos++;
}

console.log(aplicar ? '### APLICANDO\n' : '### DRY-RUN — nada foi escrito\n');
console.log(`  telas com sidebar.js : ${alvos.length}`);
console.log(`  já tinham a linha    : ${jaTinha}`);
console.log(`  ${aplicar ? 'inseridas' : 'a inserir'}            : ${inseridos}`);
if (semAncora.length) {
  console.log(`  SEM <link rel="stylesheet"> (puladas): ${semAncora.length}`);
  semAncora.forEach((f) => console.log(`    ${f}`));
}
if (!aplicar) console.log('\n  Use --aplicar para gravar.');
