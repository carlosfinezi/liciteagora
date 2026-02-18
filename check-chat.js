const db = require('better-sqlite3')('pncp.db');

// Verificar estrutura da tabela
console.log('=== ESTRUTURA DA TABELA chat_mensagens ===');
try {
    const info = db.prepare("PRAGMA table_info(chat_mensagens)").all();
    console.log(info.map(c => c.name).join(', '));
} catch (e) {
    console.log('Erro:', e.message);
}

// Contar mensagens
console.log('\n=== TOTAL DE MENSAGENS ===');
try {
    const count = db.prepare('SELECT COUNT(*) as total FROM chat_mensagens').get();
    console.log('Total:', count.total);
} catch (e) {
    console.log('Erro:', e.message);
}

// Listar últimas mensagens
console.log('\n=== ÚLTIMAS MENSAGENS DE CHAT ===');
try {
    const mensagens = db.prepare(`
        SELECT cm.*, l.objetoCompra, l.razaoSocial as orgao
        FROM chat_mensagens cm
        LEFT JOIN licitacoes l ON l.cnpj = cm.cnpj AND l.anoCompra = cm.ano AND l.sequencialCompra = cm.sequencial
        ORDER BY cm.dataHora DESC
        LIMIT 20
    `).all();

    if (mensagens.length === 0) {
        console.log('Nenhuma mensagem de chat registrada ainda.');
    } else {
        mensagens.forEach(m => {
            console.log(`\n[${m.dataHora}] ${m.cnpj}/${m.ano}/${m.sequencial}`);
            console.log(`  Órgão: ${m.orgao || 'N/A'}`);
            console.log(`  Remetente: ${m.remetente}`);
            console.log(`  Mensagem: ${m.conteudo?.substring(0, 100)}...`);
        });
    }
} catch (e) {
    console.log('Erro:', e.message);
}

// Verificar monitoramento ativo
console.log('\n=== MONITORAMENTOS REGISTRADOS ===');
try {
    const monit = db.prepare('SELECT * FROM chat_monitoramento ORDER BY ultimaVerificacao DESC LIMIT 10').all();
    if (monit.length === 0) {
        console.log('Nenhum monitoramento registrado.');
    } else {
        monit.forEach(m => {
            console.log(`${m.cnpj}/${m.ano}/${m.sequencial} - Ativo: ${m.ativo} - Última: ${m.ultimaVerificacao}`);
        });
    }
} catch (e) {
    console.log('Erro:', e.message);
}

db.close();
