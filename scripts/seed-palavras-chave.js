// Seed de palavras-chave por tenant.
// - Insere um conjunto padrão de palavras (termos recorrentes em pregão).
// - Para cada tenant com fornecedor cadastrado, adiciona 2 palavras personalizadas:
//     * raiz formatada do CNPJ (ex: "19.884.430")
//     * primeiros 2 tokens da razão social (ex: "1 bit")
// Idempotente: INSERT OR IGNORE por palavra.

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const TENANTS_DIR = '/home/carlosfinezi/web/liciteagora.com.br/private/data/tenants';

const PALAVRAS_PADRAO = [
  'habilitação',
  'recurso',
  'diligência',
  'impugnação',
  'convocação',
  'anexo',
  'aceitação',
  'julgamento',
  'habilitacao',    // sem acento — redundância defensiva
  'diligencia',
  'impugnacao',
  'convocacao',
  'aceitacao',
];

function derivarPersonalizadas(cnpj, razaoSocial) {
  const out = [];
  if (cnpj) {
    const digits = String(cnpj).replace(/\D/g, '');
    if (digits.length >= 8) {
      const raiz = `${digits.substring(0,2)}.${digits.substring(2,5)}.${digits.substring(5,8)}`;
      out.push(raiz.toLowerCase());
    }
  }
  if (razaoSocial) {
    const tokens = String(razaoSocial).trim().split(/\s+/).slice(0, 2);
    const inicio = tokens.join(' ').toLowerCase();
    if (inicio.length >= 2) out.push(inicio);
  }
  return out;
}

const tenants = fs.readdirSync(TENANTS_DIR);
for (const slug of tenants) {
  const dbPath = path.join(TENANTS_DIR, slug, 'pncp.db');
  if (!fs.existsSync(dbPath)) continue;
  const db = new Database(dbPath);

  // Lê fornecedor (pode não existir)
  let forn = null;
  try { forn = db.prepare('SELECT cnpj, razaoSocial FROM fornecedor WHERE id = 1').get(); } catch (_) {}

  const personalizadas = forn ? derivarPersonalizadas(forn.cnpj, forn.razaoSocial) : [];
  const todas = [...PALAVRAS_PADRAO, ...personalizadas];

  let inseridas = 0, existiam = 0;
  const stmt = db.prepare('INSERT OR IGNORE INTO chat_palavras_chave (palavra) VALUES (?)');
  for (const p of todas) {
    try {
      const r = stmt.run(p);
      if (r.changes > 0) inseridas++; else existiam++;
    } catch (_) { /* skip */ }
  }

  console.log(`[${slug}] inseridas=${inseridas} existiam=${existiam} personalizadas=[${personalizadas.join(', ') || 'sem fornecedor'}]`);
  db.close();
}
