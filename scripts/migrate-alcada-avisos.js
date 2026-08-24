// migrate-alcada-avisos.js — colunas de controle do aviso de aprovação.
//
// `avisoCriacaoEm` e `avisoExpiracaoEm` marcam que o aprovador já foi avisado.
// Sem elas, marcarAvisada() falha em silêncio (o catch existe para banco em
// migração) e o mesmo alerta sairia a cada tentativa de pagamento — alerta
// repetido é alerta ignorado.
//
// Roda como script porque migração dentro de registrarRotasGovernanca(app, db)
// é no-op no boot multi-tenant: as rotas são registradas uma vez, não uma por
// tenant.

const Database = require('better-sqlite3');
const { createTenantManager } = require('../tenant-manager');
const { initSchema } = require('../db-schema');
const { migrarAvisosDB } = require('../governanca-avisos');

const DRY = process.argv.includes('--dry-run');
const log = (m) => console.log('[migrate-alcada-avisos] ' + m);

// listAll, não listActive: tenant suspenso que voltar a ativo não reaplica
// migração nenhuma e ficaria sem as colunas.
const tenants = createTenantManager({ initSchema }).listAll();
log(`tenants: ${tenants.length}${DRY ? ' (DRY-RUN)' : ''}`);

let ok = 0, pulados = 0, erro = 0;
for (const t of tenants) {
  let db;
  try {
    db = new Database(t.db_path);
    const temTabela = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='aprovacoes'").get();
    if (!temTabela) { log(`${t.slug}: sem tabela aprovacoes — pulado`); pulados++; continue; }

    const antes = db.prepare('PRAGMA table_info(aprovacoes)').all().map((c) => c.name);
    const faltando = ['avisoCriacaoEm', 'avisoExpiracaoEm'].filter((c) => !antes.includes(c));
    if (!faltando.length) { log(`${t.slug}: já tinha as colunas`); ok++; continue; }
    if (DRY) { log(`${t.slug}: adicionaria ${faltando.join(', ')}`); ok++; continue; }

    migrarAvisosDB(db);
    const depois = db.prepare('PRAGMA table_info(aprovacoes)').all().map((c) => c.name);
    const aindaFalta = ['avisoCriacaoEm', 'avisoExpiracaoEm'].filter((c) => !depois.includes(c));
    if (aindaFalta.length) throw new Error('colunas não criadas: ' + aindaFalta.join(', '));

    // Aprovações que já existiam não devem gerar enxurrada de aviso retroativo
    // na primeira varredura: o que está pendente hoje o usuário já viu na tela.
    const marcadas = db.prepare(
      "UPDATE aprovacoes SET avisoCriacaoEm = 'retroativo' WHERE avisoCriacaoEm IS NULL").run().changes;
    log(`${t.slug}: +${faltando.join(', ')} (${marcadas} aprovação(ões) existente(s) marcada(s) como já vista(s))`);
    ok++;
  } catch (e) {
    log(`${t.slug}: ERRO ${e.message}`);
    erro++;
  } finally {
    try { if (db) db.close(); } catch {}
  }
}
log(`fim: ${ok} ok, ${pulados} pulados, ${erro} erro(s)`);
process.exit(erro ? 1 : 0);
