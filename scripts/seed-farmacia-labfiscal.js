#!/usr/bin/env node
/**
 * seed-farmacia-labfiscal.js — massa de demonstração do módulo Farmácia.
 *
 * Cria no tenant `labfiscal` um punhado de medicamentos REAIS (nome, EAN e
 * registro tirados da lista de preços da CMED), com lotes, e importa só as
 * linhas da CMED correspondentes. Assim o módulo fica clicável sem despejar as
 * 26 mil linhas da lista inteira num tenant que tem meia dúzia de produtos —
 * a importação completa é um upload na tela "Lista CMED".
 *
 * Idempotente: reexecutar atualiza no lugar de duplicar.
 *
 * Uso: node scripts/seed-farmacia-labfiscal.js [caminho-da-lista-cmed.xlsx]
 */
const fs = require('fs');
const BASE = '/home/carlosfinezi/web/liciteagora.com.br/private';
const Database = require(BASE + '/node_modules/better-sqlite3');
const XLSX = require(BASE + '/node_modules/xlsx');

const { initFarmaciaSchema } = require(BASE + '/farmacia/farmacia-schema');
const { importarCmed, detectarCabecalho, mapearColunas, normalizarTexto } = require(BASE + '/farmacia/cmed-import');

const ARQUIVO = process.argv[2] || '/tmp/cmed-pmc.xlsx';
if (!fs.existsSync(ARQUIVO)) {
  console.error(`lista da CMED não encontrada em ${ARQUIVO}`);
  console.error('baixe em https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/cmed/precos ("PMC - XLS")');
  process.exit(2);
}

const db = new Database(BASE + '/data/tenants/labfiscal/pncp.db');
initFarmaciaSchema(db);

// Substâncias escolhidas para a demo cobrirem os quatro comportamentos do
// módulo: venda livre, tarja vermelha, antimicrobiano e controlado tarja preta.
// Os nomes são os da coluna SUBSTÂNCIA da CMED, sem acento (a comparação passa
// por normalizarTexto). "DIPIRONA MONOIDRATADA" é como a lista escreve.
const ALVOS = [
  { substancia: 'DIPIRONA MONOIDRATADA', sku: 'FARM-DEMO-DIPIRONA' },
  { substancia: 'LOSARTANA POTASSICA', sku: 'FARM-DEMO-LOSARTANA' },
  { substancia: 'AMOXICILINA', sku: 'FARM-DEMO-AMOXICILINA' },
  { substancia: 'CLONAZEPAM', sku: 'FARM-DEMO-CLONAZEPAM' },
];

console.log('lendo a lista da CMED…');
const wb = XLSX.readFile(ARQUIVO);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: '' });
const iH = detectarCabecalho(rows);
const cols = mapearColunas(rows[iH], '19');
const val = (r, i) => (i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : '');

// Uma linha por alvo: a primeira com EAN de 13 dígitos e PMC preenchido.
const escolhidas = [];
for (const alvo of ALVOS) {
  // normalizarTexto tira o acento: a CMED escreve "LOSARTANA POTÁSSICA", e um
  // startsWith cru não casa. Substâncias compostas vêm separadas por ';', então
  // a comparação é por linha que COMEÇA com a substância — evita pegar
  // associações ("BESILATO DE ANLODIPINO;LOSARTANA POTÁSSICA").
  const linha = rows.slice(iH + 1).find(r => {
    const s = normalizarTexto(val(r, cols.substancia));
    const ean = val(r, cols.ean1).replace(/\D/g, '');
    return s.startsWith(alvo.substancia) && ean.length === 13 && val(r, cols.pmc);
  });
  if (!linha) { console.warn(`  ! sem linha na CMED para ${alvo.substancia}`); continue; }
  escolhidas.push({
    ...alvo,
    linha,
    produto: val(linha, cols.produto),
    ean: val(linha, cols.ean1).replace(/\D/g, ''),
    apresentacao: val(linha, cols.apresentacao),
  });
}

const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
const dia = (n) => new Date(Date.parse(hoje + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

console.log('criando produtos e lotes…');
for (const e of escolhidas) {
  let p = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(e.sku);
  if (!p) {
    const id = db.prepare(`INSERT INTO produtos
      (sku, descricao, unidade, precoCusto, precoVenda, ncm, codigoBarras, ativo, rastreiaLote, estoqueMinimo)
      VALUES (?, ?, 'UN', 0, 0, '30049099', ?, 1, 1, 5)`)
      .run(e.sku, `${e.produto} · ${e.apresentacao}`.slice(0, 120), e.ean).lastInsertRowid;
    p = { id };
  } else {
    db.prepare('UPDATE produtos SET codigoBarras = ?, rastreiaLote = 1, ativo = 1 WHERE id = ?').run(e.ean, p.id);
  }
  e.produtoId = p.id;

  // Dois lotes por produto, de validades diferentes — é o que dá o que ver no
  // FEFO: o segundo lote entra depois e vence antes.
  const lotes = [
    { numero: 'L' + String(e.produtoId) + 'A', validade: dia(400), qtd: 30 },
    { numero: 'L' + String(e.produtoId) + 'B', validade: dia(45), qtd: 10 },
  ];
  for (const l of lotes) {
    const existe = db.prepare('SELECT id FROM lotes WHERE produtoId = ? AND numero = ?').get(e.produtoId, l.numero);
    if (existe) continue;
    db.prepare(`INSERT INTO lotes
      (produtoId, numero, dataFabricacao, dataValidade, quantidadeInicial, saldoAtual, ativo)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(e.produtoId, l.numero, dia(-120), l.validade, l.qtd, l.qtd);
  }
  console.log(`  · ${e.sku} → ${e.produto} (EAN ${e.ean})`);
}

// A planilha de recorte leva TODAS as linhas das substâncias escolhidas, não
// só a que casou. Motivo concreto: a tarja de muitas linhas vem "- (*)" e o
// importador a infere das outras linhas da MESMA substância — com uma linha só,
// a inferência não teria de onde tirar e a tarja ficaria desconhecida.
const substanciasAlvo = new Set(escolhidas.map(e => normalizarTexto(val(e.linha, cols.substancia))));
const linhasDasSubstancias = rows.slice(iH + 1)
  .filter(r => substanciasAlvo.has(normalizarTexto(val(r, cols.substancia))));
const aoa = [...rows.slice(0, iH + 1), ...linhasDasSubstancias];
const tmp = '/tmp/cmed-demo-labfiscal.xlsx';
const wbT = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbT, XLSX.utils.aoa_to_sheet(aoa), 'Planilha1');
XLSX.writeFile(wbT, tmp);

console.log('importando as linhas da CMED…');
const r = importarCmed(db, tmp, {
  colunaPmc: '19', uf: 'PA', competencia: '2026-08',
  arquivoNome: 'demo — recorte da lista CMED de 11/08/2026', usuario: 'seed',
});
console.log(`  lidas ${r.lidas} · casadas ${r.casadas} · não casadas ${r.naoCasadas}`);

// Curadoria que a CMED não publica: lista da 344 do clonazepam.
const clona = db.prepare("SELECT id FROM produtos WHERE sku = 'FARM-DEMO-CLONAZEPAM'").get();
if (clona) {
  db.prepare("UPDATE farmacia_medicamento_specs SET listaPortaria344 = 'B1' WHERE produtoId = ?").run(clona.id);
  console.log('  · clonazepam marcado na lista B1 da Portaria 344 (curadoria local)');
}

console.log('\nEstado do labfiscal:');
for (const row of db.prepare(`
  SELECT p.sku, p.descricao, s.substancia, s.tarja, s.listaPortaria344, s.antimicrobiano, s.pmc,
         (SELECT COUNT(*) FROM lotes l WHERE l.produtoId = p.id AND l.saldoAtual > 0) AS lotes
  FROM produtos p JOIN farmacia_medicamento_specs s ON s.produtoId = p.id
  WHERE p.sku LIKE 'FARM-DEMO-%' ORDER BY p.sku`).all()) {
  const exige = row.listaPortaria344 || (row.antimicrobiano ? 'antimicrobiano' : '—');
  console.log(`  ${row.sku.padEnd(22)} PMC ${String(row.pmc).padStart(7)} · tarja ${String(row.tarja).padEnd(18)} · receita: ${String(exige).padEnd(14)} · ${row.lotes} lote(s)`);
}
try { fs.unlinkSync(tmp); } catch (_) { /* */ }
