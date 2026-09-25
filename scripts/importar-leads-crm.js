#!/usr/bin/env node
'use strict';
/**
 * Importa a planilha "LEADS_PARA_PROPENSAO_LICITEAGORA" (as mesmas 72.606
 * empresas do Pará, pontuadas pela propensão a contratar o LiciteAgora) para o
 * funil "Ligação Licitações" do CRM do 1bit, em LOTES de 1.000 na ordem da
 * planilha, que vem da maior para a menor propensão. A tela do funil mostra no
 * máximo 1.000 cards (LIMIT em crm-routes.js), por isso a lista entra aos poucos.
 *
 * Substituiu, em 24/09/2026, a planilha "LEADS_PARA_TELEFONES_VALIDADOS", cujo
 * lote 1 foi apagado do funil (controle antigo em
 * validados-importados-DESFEITO-2026-09-24.csv). Antes dela, em 23/09, a
 * "LEADS EMPRESAS PARÁ" (importados-DESFEITO-2026-09-23.csv).
 *
 * A planilha entrou inteira em 24/09/2026, e no mesmo dia os cards saíram do
 * funil "Ligação Licitações" (excluído) para 10 funis, um por nicho, que
 * agrupam o "Setor" da planilha. Como está, o script aborta ao não achar o
 * funil: uma lista nova precisa decidir antes para qual funil cada lead vai.
 *
 * Os cards entram SEM cadastro em `pessoas`: nome em clienteNomeLivre e
 * telefone em clienteTelefoneLivre.
 *
 * Regras do telefone:
 *   - vale a coluna "Melhor Telefone" da planilha, escolhida pela validação;
 *     empresa sem ele (probabilidade "Inapto") fica de fora, e o número ainda
 *     passa pela mesma checagem de formato e de enchimento;
 *   - nenhum número se repete no funil: um telefone que aparece em várias
 *     empresas entra uma vez só, com a primeira delas na planilha. A regra vale
 *     sobre a planilha inteira, e não por lote.
 *
 * Quem já entrou fica no arquivo de controle (CONTROLE), uma linha por card.
 * Ele fica fora do repositório porque carrega nome e telefone. O próximo lote
 * pula quem está nele.
 *
 *   node scripts/importar-leads-crm.js              # só mostra o próximo lote
 *   node scripts/importar-leads-crm.js --aplicar    # grava 1.000
 *   node scripts/importar-leads-crm.js --lote 500 --aplicar
 *
 * Rodar como carlosfinezi (dono do banco e do controle). Ler a planilha leva
 * ~40s.
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

const ORIGEM = path.join(__dirname, '..', 'Downloads', 'LEADS_PARA_PROPENSAO_LICITEAGORA.xlsx');
const ABA = 'Leads por Propensão';
const CONTROLE = '/home/carlosfinezi/leads-para-crm/propensao-importados.csv';
const DB = path.join(__dirname, '..', 'data', 'tenants', '1bit', 'pncp.db');
const FUNIL = 'Ligação Licitações';
const ETAPA = 'Leads';
const FONTE = 'Leads Propensão';

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const iLote = args.indexOf('--lote');
const tamLote = iLote >= 0 ? Number(args[iLote + 1]) : 1000;
if (!Number.isInteger(tamLote) || tamLote <= 0) { console.error('--lote precisa ser inteiro positivo'); process.exit(1); }

// CSV com aspas duplas opcionais — só para ler o controle que este script escreve.
function lerCSV(texto) {
  const linhas = [];
  let campo = '', linha = [], aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
    else campo += c;
  }
  if (campo !== '' || linha.length) { linha.push(campo); linhas.push(linha); }
  const [cab, ...resto] = linhas.filter(l => l.some(v => v.trim() !== ''));
  return resto.map(l => Object.fromEntries(cab.map((k, j) => [k, l[j] || ''])));
}
const csvCampo = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

const soDigitos = v => String(v || '').replace(/\D/g, '');
const valido = t => (t.length === 10 || t.length === 11) && t[0] !== '0' && !/(\d)\1{6}$/.test(t);
// "Melhor Telefone" vem como +55DDDNUMERO.
function escolherTelefone(r) {
  const t = soDigitos(r['Melhor Telefone']).replace(/^55(?=\d{10,11}$)/, '');
  return valido(t) ? t : null;
}
// MEI vem com o CNPJ na frente da razão social ("60.033.247 ATILIO ...").
const semPrefixoMei = s => String(s || '').replace(/^\d{2}\.\d{3}\.\d{3}\s+/, '').trim();

const wb = XLSX.readFile(ORIGEM, { dense: true });
if (!wb.Sheets[ABA]) { console.error(`aba "${ABA}" ausente em ${ORIGEM}`); process.exit(1); }
const planilha = XLSX.utils.sheet_to_json(wb.Sheets[ABA], { defval: '', raw: false });
for (const col of ['Propensão', 'Pontuação Propensão', 'Motivos', 'Setor', 'CNPJ', 'Razao Social', 'Nome Fantasia', 'Municipio', 'Porte', 'Ramo de Atividade', 'Melhor Telefone', 'Probabilidade de Atender', 'E-mail', 'Socio(s)']) {
  if (!(col in planilha[0])) { console.error(`coluna "${col}" ausente na planilha`); process.exit(1); }
}

// Elegíveis na ordem da planilha: telefone válido e ainda não usado.
const vistos = new Set();
let semTelefone = 0, repetidos = 0;
const elegiveis = [];
for (const r of planilha) {
  const tel = escolherTelefone(r);
  if (!tel) { semTelefone++; continue; }
  if (vistos.has(tel)) { repetidos++; continue; }
  vistos.add(tel);
  elegiveis.push({ ...r, cnpj: soDigitos(r.CNPJ), tel: '55' + tel });
}

const controle = fs.existsSync(CONTROLE) ? lerCSV(fs.readFileSync(CONTROLE, 'utf8')) : [];
const jaEntrou = new Set(controle.map(r => r.cnpj));

const db = new Database(DB);
db.pragma('busy_timeout = 10000');

const funil = db.prepare('SELECT id FROM crm_funis WHERE nome = ? AND ativo = 1').all(FUNIL);
if (funil.length !== 1) { console.error(`esperava 1 funil "${FUNIL}", achei ${funil.length}`); process.exit(1); }
const etapa = db.prepare('SELECT id FROM crm_etapas WHERE funilId = ? AND nome = ? AND ativo = 1').all(funil[0].id, ETAPA);
if (etapa.length !== 1) { console.error(`esperava 1 etapa "${ETAPA}" no funil, achei ${etapa.length}`); process.exit(1); }
const funilId = funil[0].id, etapaId = etapa[0].id;

// Controle e banco têm de contar a mesma coisa. Se divergirem (card apagado à
// mão, gravação no controle que falhou), o "quem já entrou" deixou de ser
// confiável e o lote seguinte duplicaria ou pularia gente.
const noBanco = db.prepare('SELECT COUNT(*) AS n FROM crm_oportunidades WHERE funilId = ? AND fonte = ?').get(funilId, FONTE).n;
if (noBanco !== controle.length) {
  console.error(`DIVERGÊNCIA: ${noBanco} cards com fonte "${FONTE}" no banco, ${controle.length} linhas em ${CONTROLE}. Nada foi gravado.`);
  process.exit(1);
}

const lote = elegiveis.filter(r => !jaEntrou.has(r.cnpj)).slice(0, tamLote);
const numLote = controle.length ? Math.max(...controle.map(r => Number(r.lote) || 0)) + 1 : 1;
console.log(`planilha: ${planilha.length} | sem telefone válido: ${semTelefone} | telefone repetido: ${repetidos} | elegíveis: ${elegiveis.length}`);
console.log(`já no funil: ${controle.length} | lote ${numLote}: ${lote.length} | restam depois: ${elegiveis.length - controle.length - lote.length}`);
if (!lote.length) { console.log('nada a importar'); process.exit(0); }
console.log(`primeiro: ${semPrefixoMei(lote[0]['Razao Social'])} (${lote[0].cnpj}) | último: ${semPrefixoMei(lote[lote.length - 1]['Razao Social'])} (${lote[lote.length - 1].cnpj})`);
if (!aplicar) { console.log('simulação — use --aplicar para gravar'); process.exit(0); }

const agora = new Date().toISOString();
const ins = db.prepare(`
  INSERT INTO crm_oportunidades
    (funilId, etapaId, clienteNomeLivre, clienteTelefoneLivre, titulo, descricao, valor, fonte, ordemManual)
  VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`);
const criados = db.transaction(() => {
  // Abaixo dos cards que já estão na etapa, na ordem da planilha.
  const base = db.prepare('SELECT COALESCE(MAX(ordemManual), 0) AS m FROM crm_oportunidades WHERE etapaId = ? AND ativo = 1').get(etapaId).m;
  return lote.map((r, i) => {
    const razao = semPrefixoMei(r['Razao Social']);
    const fantasia = String(r['Nome Fantasia'] || '').trim();
    const descricao = [
      `CNPJ: ${r.cnpj}`,
      fantasia && `Nome fantasia: ${fantasia}`,
      `Município: ${r.Municipio}`,
      `Porte: ${r.Porte}`,
      `Setor: ${r.Setor}`,
      `Ramo: ${r['Ramo de Atividade']}`,
      `Propensão: ${r['Propensão']} (${r['Pontuação Propensão']})`,
      String(r.Motivos).trim() && `Motivos: ${String(r.Motivos).trim()}`,
      `Probabilidade de atender: ${r['Probabilidade de Atender']}`,
      String(r['Socio(s)']).trim() && `Sócio(s): ${String(r['Socio(s)']).trim()}`,
      String(r['E-mail']).trim() && `E-mail: ${String(r['E-mail']).trim()}`,
    ].filter(Boolean).join('\n');
    const id = ins.run(funilId, etapaId, fantasia || razao, r.tel, razao, descricao, FONTE, base + 1 + i).lastInsertRowid;
    return { cnpj: r.cnpj, tel: r.tel, razao, id };
  });
})();

fs.mkdirSync(path.dirname(CONTROLE), { recursive: true });
const cab = 'lote,importadoEm,oportunidadeId,cnpj,telefone,razao_social\n';
const corpo = criados.map(r => [numLote, agora, r.id, r.cnpj, r.tel, r.razao].map(csvCampo).join(',')).join('\n') + '\n';
fs.appendFileSync(CONTROLE, (fs.existsSync(CONTROLE) ? '' : cab) + corpo);

const total = db.prepare('SELECT COUNT(*) AS n FROM crm_oportunidades WHERE funilId = ? AND fonte = ?').get(funilId, FONTE).n;
console.log(`gravados ${criados.length} cards (ids ${criados[0].id}–${criados[criados.length - 1].id}) | total no funil: ${total} | controle: ${CONTROLE}`);
