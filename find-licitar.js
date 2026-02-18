const Database = require('better-sqlite3');
const db = new Database('C:/Users/User/pncp-licitacoes/pncp.db');

// Buscar licitações do Licitar Digital
const lics = db.prepare(`
    SELECT id, objetoCompra, razaoSocial, ufSigla, dataEncerramentoProposta, linkSistemaOrigem
    FROM licitacoes
    WHERE linkSistemaOrigem LIKE '%licitardigital%'
       OR linkSistemaOrigem LIKE '%app2-compras.licita%'
    ORDER BY dataEncerramentoProposta DESC
    LIMIT 10
`).all();

console.log('Licitações do Licitar Digital encontradas:', lics.length);
console.log('');

lics.forEach(l => {
    console.log('ID:', l.id);
    console.log('Objeto:', l.objetoCompra?.substring(0, 100));
    console.log('Órgão:', l.razaoSocial);
    console.log('UF:', l.ufSigla);
    console.log('Encerramento:', l.dataEncerramentoProposta);
    console.log('Link:', l.linkSistemaOrigem);
    console.log('---');
});

// Verificar total
const total = db.prepare(`
    SELECT COUNT(*) as total FROM licitacoes
    WHERE linkSistemaOrigem LIKE '%licitardigital%'
       OR linkSistemaOrigem LIKE '%app2-compras.licita%'
`).get();

console.log('Total no banco:', total.total);

db.close();
