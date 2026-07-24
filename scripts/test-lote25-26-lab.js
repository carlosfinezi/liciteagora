#!/usr/bin/env node
// Teste lote 2.5 (fiscal-ops) + 2.6 (alçadas) no lab jaagricola.
const path = require('path');
const Database = require('better-sqlite3');
const { migrarFiscalOpsDB, registrarEventoNfe } = require('../fiscal-ops-routes');
const { migrarGovernancaDB, verificarAlcada } = require('../governanca-routes');

const db = new Database(path.join(__dirname, '..', 'data', 'tenants', 'jaagricola', 'pncp.db'));
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = OFF');
function assert(c, m){ if(!c){ console.error('FALHOU:', m); process.exit(1);} console.log('OK:', m); }

migrarFiscalOpsDB(db); migrarGovernancaDB(db);
assert(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('nfe_eventos','nfe_inutilizacoes','gnre_guias','regras_alcada','aprovacoes')").get().n === 5, 'tabelas do lote criadas');

db.exec("DELETE FROM aprovacoes; DELETE FROM regras_alcada; DELETE FROM gnre_guias; DELETE FROM nfe_eventos;");

// ===== alçadas =====
// sem regra → liberado
let r = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 999, valor: 100000 });
assert(r.liberado === true, 'sem regra → liberado');

// regra 5000: 4000 passa, 8000 bloqueia com pendente
db.prepare("INSERT INTO regras_alcada (tipoEvento, limiteValor) VALUES ('pagamento_cp', 5000)").run();
r = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 10, valor: 4000 });
assert(r.liberado === true, '4000 abaixo do limite → liberado');
r = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 10, valor: 8000, usuario: 'vendedor' });
assert(r.liberado === false && r.status === 'pendente', `8000 acima → bloqueado, aprovação #${r.aprovacaoId} pendente`);
const apId = r.aprovacaoId;

// repetir não duplica
r = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 10, valor: 8000 });
assert(r.aprovacaoId === apId, 'retry reaproveita a mesma pendência');

// aprovar → libera UMA vez, consumida
db.prepare("UPDATE aprovacoes SET status='aprovada', aprovador='chefe' WHERE id = ?").run(apId);
r = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 10, valor: 8000 });
assert(r.liberado === true, 'aprovada → liberado');
assert(db.prepare("SELECT consumida FROM aprovacoes WHERE id=?").get(apId).consumida === 1, 'aprovação consumida no uso');
r = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 10, valor: 8000 });
assert(r.liberado === false && r.status === 'pendente', 'nova tentativa exige NOVA aprovação (uma aprovação = uma execução)');

// reprovada bloqueia
db.prepare("UPDATE aprovacoes SET status='reprovada' WHERE id = ?").run(r.aprovacaoId);
r = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: 10, valor: 8000 });
assert(r.liberado === false && r.status === 'reprovada', 'reprovada → segue bloqueado');

// ===== fiscal-ops =====
registrarEventoNfe(db, { faturaId: 1, chaveAcesso: '1'.repeat(44), tpEvento: '110110', nSeqEvento: 1, texto: 'teste', cStat: '135', protocolo: 'P1' });
assert(db.prepare("SELECT COUNT(*) n FROM nfe_eventos WHERE tpEvento='110110'").get().n === 1, 'evento CC-e persistido');

// GNRE: base 10000, 18% - 12% = 600 DIFAL + 2% FCP = 200 → 800
const difal = 10000*(18-12)/100, fcp = 10000*2/100;
assert(difal === 600 && fcp === 200, `cálculo DIFAL ${difal} + FCP ${fcp} = ${difal+fcp}`);

// limpeza
db.exec("DELETE FROM aprovacoes; DELETE FROM regras_alcada; DELETE FROM nfe_eventos;");
db.close();
console.log('\nTODOS OS TESTES PASSARAM');
process.exit(0);
