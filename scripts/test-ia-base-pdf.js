/**
 * Base da IA a partir de PDF.
 *
 * ── O que pode dar errado aqui, e por isso é testado ───────────────────────
 *
 *  1. **Truncar calado.** `ia_base.conteudo` guarda 4.000 caracteres. Um PDF
 *     grande gravado como item único perderia o resto sem avisar, e a IA
 *     responderia com meia informação — o pior defeito possível numa base de
 *     conhecimento, porque parece que funcionou.
 *  2. **PDF digitalizado.** `pdftotext` devolve vazio para imagem de página. Sem
 *     guarda, entraria um item em branco, e base em branco é IA inventando.
 *  3. **Arquivo que não é PDF.** Renomear .doc para .pdf não pode virar item com
 *     bytes binários dentro.
 *
 * O PDF de teste é gerado aqui, em bytes, sem biblioteca: é um PDF mínimo de
 * verdade, lido pelo `pdftotext` de verdade. Testar extração com um stub do
 * pdftotext provaria apenas que o stub funciona.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const DB = '/tmp/vp-ia-pdf.db';
try { fs.unlinkSync(DB); } catch {}
const db = new Database(DB);
const schema = require('./schema-de-tenant').lerSchema('/tmp/vp-ia-pdf-schema.sql');
db.exec(schema);
for (const m of schema.matchAll(/REFERENCES\s+(\w+)\s*\(/gi)) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${m[1]} (id INTEGER PRIMARY KEY AUTOINCREMENT)`);
  try { db.exec(`INSERT OR IGNORE INTO ${m[1]} (id) VALUES (1)`); } catch {}
}

let ok = 0, fail = 0;
const t = (nome, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { console.log('  OK  ' + nome); ok++; },
        (e) => { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; });
    }
    console.log('  OK  ' + nome); ok++;
  } catch (e) { console.log('FALHA ' + nome + ' -> ' + e.message); fail++; }
  return Promise.resolve();
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// ---------- um PDF de verdade, montado à mão ----------
/**
 * PDF de verdade, montado à mão, com quantas páginas o texto precisar.
 *
 * A paginação não é capricho: `pdftotext` só extrai o que está DENTRO da
 * MediaBox. A primeira versão deste teste jogava 120 linhas numa página A4 só,
 * e as ~60 que passavam do rodapé eram descartadas pelo extrator — o teste
 * acusou truncamento onde não havia. Documento real tem páginas; o de teste
 * também precisa ter.
 *
 * Sem biblioteca: o formato é simples o bastante para ser escrito aqui, e assim
 * o teste não ganha dependência para instalar nem para atualizar.
 */
const LINHAS_POR_PAGINA = 45;

function pdfComTexto(linhas) {
  const paginas = [];
  for (let i = 0; i < Math.max(1, Math.ceil(linhas.length / LINHAS_POR_PAGINA)); i++) {
    paginas.push(linhas.slice(i * LINHAS_POR_PAGINA, (i + 1) * LINHAS_POR_PAGINA));
  }

  // 1 catálogo, 2 páginas, 3 fonte, e depois um par (página, conteúdo) por página.
  const idPagina = (i) => 4 + i * 2;
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${paginas.map((_, i) => `${idPagina(i)} 0 R`).join(' ')}] /Count ${paginas.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  paginas.forEach((ls, i) => {
    const fluxo = 'BT /F1 11 Tf 40 780 Td 16 TL\n'
      + ls.map(l => `(${String(l).replace(/([()\\])/g, '\\$1')}) Tj T*`).join('\n') + '\nET';
    objetos.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + `/Contents ${idPagina(i) + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    objetos.push(`<< /Length ${Buffer.byteLength(fluxo)} >>\nstream\n${fluxo}\nendstream`);
  });

  let corpo = '%PDF-1.4\n';
  const offsets = [];
  objetos.forEach((o, i) => { offsets.push(corpo.length); corpo += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = corpo.length;
  corpo += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`
    + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  corpo += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(corpo, 'latin1');
}

// ---------- servidor e chamada multipart ----------
const app = express();
require('../conversas-routes').registrarRotasConversas(app, db);
const srv = app.listen(34155);

async function enviar(buffer, nome) {
  const fd = new FormData();
  fd.append('arquivo', new Blob([buffer], { type: 'application/pdf' }), nome);
  const r = await fetch('http://127.0.0.1:34155/api/ia/base/pdf', { method: 'POST', body: fd });
  return { status: r.status, json: await r.json() };
}

const itensDe = (origemParcial) => db.prepare(
  "SELECT titulo, conteudo FROM ia_base WHERE origem LIKE ? ORDER BY id").all('%' + origemParcial + '%');

(async () => {
  // ==================== A. o caminho feliz ====================

  await t('A1. PDF curto vira UM item, com o nome do arquivo no titulo', async () => {
    const r = await enviar(pdfComTexto(['Prazo de entrega para o Para: 12 dias uteis.',
      'Frete por conta do comprador acima de 300 km.']), 'politica-entrega.pdf');
    assert(r.json.success, 'falhou: ' + (r.json.error || ''));
    assert(r.json.itens === 1, `criou ${r.json.itens} itens`);
    const itens = itensDe('politica-entrega');
    assert(itens.length === 1, `gravou ${itens.length} itens`);
    assert(itens[0].titulo === 'politica-entrega', `título veio "${itens[0].titulo}"`);
    assert(/12 dias uteis/.test(itens[0].conteudo),
      'o texto do PDF não chegou na base: ' + itens[0].conteudo.slice(0, 80));
  });

  await t('A2. a origem diz de onde veio, para a base ser auditavel', async () => {
    const itens = db.prepare("SELECT origem FROM ia_base WHERE titulo = 'politica-entrega'").all();
    assert(/PDF: politica-entrega/.test(itens[0].origem), 'origem veio "' + itens[0].origem + '"');
  });

  // ==================== B. o defeito que importa: truncar calado ====================

  await t('B1. PDF grande vira VARIOS itens em vez de um truncado', async () => {
    // ~9.000 caracteres: passa de 4.000 com folga e precisa virar 3 itens.
    const linhas = [];
    for (let i = 0; i < 120; i++) {
      linhas.push(`Item ${i} do catalogo: descricao tecnica com medidas e aplicacao do equipamento.`);
    }
    const r = await enviar(pdfComTexto(linhas), 'catalogo-grande.pdf');
    assert(r.json.success, 'falhou: ' + (r.json.error || ''));
    assert(r.json.itens > 1, `um PDF de ~9 mil caracteres virou ${r.json.itens} item`);

    const itens = itensDe('catalogo-grande');
    const total = itens.reduce((s, i) => s + i.conteudo.length, 0);
    assert(total > 8000, `só ${total} caracteres chegaram na base — o resto foi truncado calado`);
    assert(itens.every(i => i.conteudo.length <= 4000),
      'algum item passou do limite da coluna e será cortado pelo banco');
    assert(/\(1\/\d+\)/.test(itens[0].titulo),
      `o título não numera as partes: "${itens[0].titulo}"`);
  });

  await t('B2. o comeco e o fim do documento sobrevivem', async () => {
    const itens = itensDe('catalogo-grande');
    const tudo = itens.map(i => i.conteudo).join(' ');
    assert(/Item 0 do catalogo/.test(tudo), 'o começo do PDF sumiu');
    assert(/Item 119 do catalogo/.test(tudo), 'o fim do PDF sumiu — é exatamente o truncar calado');
  });

  // ==================== C. o que precisa ser recusado ====================

  await t('C1. PDF sem texto e recusado dizendo por que', async () => {
    const r = await enviar(pdfComTexto([]), 'digitalizado.pdf');
    assert(r.status === 400, `deveria recusar (veio ${r.status})`);
    assert(/digitalizado|não tem texto/i.test(r.json.error), 'o motivo não é claro: ' + r.json.error);
    assert(itensDe('digitalizado').length === 0, 'gravou item em branco na base');
  });

  await t('C2. arquivo que nao e PDF e recusado', async () => {
    const r = await enviar(Buffer.from('isto aqui e um texto qualquer', 'utf8'), 'falso.pdf');
    assert(r.status === 400, `deveria recusar (veio ${r.status})`);
    assert(itensDe('falso').length === 0, 'gravou lixo binário como conhecimento da IA');
  });

  await t('C3. envio sem arquivo nenhum e recusado', async () => {
    const r = await fetch('http://127.0.0.1:34155/api/ia/base/pdf', { method: 'POST', body: new FormData() });
    assert(r.status === 400, `deveria recusar (veio ${r.status})`);
  });

  srv.close();
  console.log(`\n${ok} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})();
