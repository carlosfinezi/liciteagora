/**
 * Alinha o schema do SANDBOX ao de um tenant de referência.
 *
 * ⚠️ Existe por causa de um defeito do provisionamento, não por capricho.
 *
 * Um tenant novo não nasce com o schema completo. Duas causas, as duas medidas
 * em 2026-09-11 ao criar o sandbox (relatório 14 §1):
 *
 *   1. **Abort da cadeia de registro.** `applyRouteMigrations` chama
 *      `registerProtectedRoutes` dentro de UM try/catch. Se um módulo lança,
 *      os seguintes não registram — e as migrations deles não rodam. Foi o que
 *      aconteceu: `db-schema.js:2402` faz `alterSafe` de `faturas.isDevolucao`
 *      antes de `faturas` existir (ela nasce em faturas-routes), o erro é
 *      engolido, e depois `tipos-operacao-routes.js:245` usa a coluna e
 *      **lança**. Resultado: comissões, metas, CRM e óptica ficaram sem tabela
 *      — e `pedidos.vendedorId` sem coluna, o que derruba `POST /api/pedidos`
 *      com 500 num tenant recém-criado.
 *   2. **`alterSafe` silencioso.** Vários módulos fazem
 *      `ALTER TABLE x ADD COLUMN` numa tabela que ainda não existe naquele
 *      ponto da ordem. O erro é engolido de propósito (idempotência), e a
 *      coluna simplesmente não nasce.
 *
 * Este script NÃO corrige o provisionamento — corrigir aquilo afeta todo
 * tenant novo e é tarefa própria, com sua aprovação. Aqui ele só deixa o
 * sandbox fiel o bastante para servir de ambiente de teste.
 *
 * Só adiciona colunas. Nunca remove, nunca altera tipo, nunca toca em dado.
 *
 *   node scripts/sandbox-completar-schema.js            dry-run
 *   node scripts/sandbox-completar-schema.js --aplicar
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const ALVO = path.join(RAIZ, 'data', 'tenants', 'sandbox', 'pncp.db');
const REFERENCIA = path.join(RAIZ, 'data', 'tenants', '1bit', 'pncp.db');
const aplicar = process.argv.includes('--aplicar');

// Trava dura: o alvo só pode ser o sandbox.
if (!ALVO.includes(`${path.sep}sandbox${path.sep}`)) {
  console.error('RECUSADO: alvo não é o sandbox.');
  process.exit(2);
}
if (!fs.existsSync(ALVO) || !fs.existsSync(REFERENCIA)) {
  console.error('RECUSADO: banco alvo ou de referência não encontrado.');
  process.exit(2);
}

// Tabelas do núcleo comercial/financeiro que os testes da Fase 1 exercitam.
// Não alinho o banco inteiro: verticais (restaurante, farmácia…) dependem de
// flag e não fazem parte desta validação.
const TABELAS = [
  'pedidos', 'pedido_itens', 'pedido_parcelas', 'pedido_historico',
  'pessoas', 'pessoas_enderecos_adicionais',
  'produtos', 'movimentacoes_estoque', 'reservas_estoque',
  'faturas', 'fatura_itens',
  'contas_a_receber', 'contas_receber_pagamentos',
  'regras_alcada', 'aprovacoes', 'perfis_acesso', 'users', 'tipos_operacao', 'audit_log',
];

const ref = new Database(REFERENCIA, { readonly: true });
const alvo = new Database(ALVO, { readonly: !aplicar });

console.log(aplicar ? '### ALINHANDO o schema do sandbox\n' : '### DRY-RUN — nada será escrito. Use --aplicar.\n');

const colunasDe = (db, tabela) => {
  try { return db.prepare(`PRAGMA table_info(${tabela})`).all(); }
  catch { return null; }
};

let totalFaltando = 0, totalCriadas = 0;
for (const tabela of TABELAS) {
  const cRef = colunasDe(ref, tabela);
  const cAlvo = colunasDe(alvo, tabela);
  if (!cRef) { console.log(`  ${tabela.padEnd(28)} (não existe na referência — ignorado)`); continue; }
  if (!cAlvo) { console.log(`  ${tabela.padEnd(28)} ⚠ TABELA AUSENTE no sandbox`); continue; }

  const nomesAlvo = new Set(cAlvo.map((c) => c.name));
  const faltando = cRef.filter((c) => !nomesAlvo.has(c.name));
  if (!faltando.length) { console.log(`  ${tabela.padEnd(28)} ok (${cAlvo.length} colunas)`); continue; }

  totalFaltando += faltando.length;
  console.log(`  ${tabela.padEnd(28)} ${faltando.length} faltando: ${faltando.map((c) => c.name).join(', ')}`);
  if (!aplicar) continue;

  for (const c of faltando) {
    // Sem NOT NULL e sem DEFAULT da referência: a coluna nasce NULL, como
    // nasceria num ALTER de migração normal. Copiar NOT NULL quebraria o ALTER
    // em tabela com linhas.
    const ddl = `ALTER TABLE ${tabela} ADD COLUMN ${c.name} ${c.type || 'TEXT'}`;
    try { alvo.exec(ddl); totalCriadas++; }
    catch (e) { console.log(`      ✗ ${c.name}: ${e.message}`); }
  }
  console.log(`      ✔ ${faltando.length} coluna(s) criada(s)`);
}

console.log(`\n${totalFaltando} coluna(s) faltando; ${totalCriadas} criada(s).`);
if (aplicar) console.log('integrity_check:', alvo.prepare('PRAGMA integrity_check').get().integrity_check);
else console.log('Nada foi escrito.');
