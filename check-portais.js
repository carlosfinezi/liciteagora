const Database = require('better-sqlite3');
const db = new Database('C:/Users/User/pncp-licitacoes/pncp.db');

// Buscar todos os domínios únicos de linkSistemaOrigem
const links = db.prepare(`
    SELECT linkSistemaOrigem, COUNT(*) as qtd
    FROM licitacoes
    WHERE linkSistemaOrigem IS NOT NULL AND linkSistemaOrigem != ''
    GROUP BY linkSistemaOrigem
`).all();

const domains = {};
links.forEach(row => {
    const match = row.linkSistemaOrigem.match(/https?:\/\/([^\/]+)/i);
    if (match) {
        const domain = match[1].toLowerCase();
        domains[domain] = (domains[domain] || 0) + row.qtd;
    }
});

console.log('\n=== DOMÍNIOS DE PORTAIS NO BANCO ===\n');
const sorted = Object.entries(domains).sort((a, b) => b[1] - a[1]);
sorted.forEach(([domain, count]) => {
    console.log(`${count.toString().padStart(6)} | ${domain}`);
});

console.log('\n=== TOTAL ===');
console.log('Licitações com link:', links.reduce((sum, r) => sum + r.qtd, 0));

const semLink = db.prepare('SELECT COUNT(*) as qtd FROM licitacoes WHERE linkSistemaOrigem IS NULL OR linkSistemaOrigem = ""').get();
console.log('Licitações sem link:', semLink.qtd);

// Buscar por "licitar" ou "licitanet"
console.log('\n=== BUSCA POR "LICITAR" E "LICITANET" ===');
const licitarLinks = db.prepare(`
    SELECT DISTINCT linkSistemaOrigem
    FROM licitacoes
    WHERE linkSistemaOrigem LIKE '%licitar%' OR linkSistemaOrigem LIKE '%licitanet%'
`).all();

if (licitarLinks.length === 0) {
    console.log('Nenhum link encontrado com "licitar" ou "licitanet"');
} else {
    licitarLinks.forEach(r => console.log(r.linkSistemaOrigem));
}

db.close();
