/**
 * Dry-run do backfill de `pedidos.valorPago` — SOMENTE LEITURA.
 *
 * Até 2026-09-10 `sincronizarPagamentoPedido` só enxergava a CR ligada por
 * `faturaId`; a CR ligada direto por `pedidoId` (loja virtual e faturamento de
 * OS) era abandonada. O pedido ficava em `valorPago = 0` com a conta paga.
 *
 * A correção vale dali para a frente: o recálculo só roda quando uma CR daquele
 * pedido sofre baixa, estorno, cancelamento ou reabertura. O que já estava
 * divergente continua divergente. Este script mede esse passivo.
 *
 * NÃO ESCREVE NADA. Os bancos são abertos com `readonly: true` — a garantia é
 * do driver, não da boa intenção do código. A correção histórica é decisão
 * separada e não está aqui.
 *
 * Uso:
 *   node scripts/auditar-pagamento-pedidos.js            todos os tenants
 *   node scripts/auditar-pagamento-pedidos.js 1bit       um tenant
 *   node scripts/auditar-pagamento-pedidos.js --json     saída em JSON
 *
 * Privacidade: nada de cliente, CPF/CNPJ, descrição ou endereço. Só id, número
 * do pedido e valores — o necessário para decidir sobre o backfill.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..', 'data', 'tenants');
const args = process.argv.slice(2);
const comoJson = args.includes('--json');
const alvo = args.find((a) => !a.startsWith('--')) || null;

// Mesma expressão da função corrigida (contas-receber-routes.js): as CRs do
// pedido pelos DOIS vínculos, sem contar duas vezes a que tem os dois.
const SQL_PAGO = `
  SELECT COALESCE(SUM(COALESCE(valorPago, 0)), 0) AS t
    FROM contas_a_receber
   WHERE status != 'cancelada'
     AND (pedidoId = ? OR faturaId IN (SELECT id FROM faturas WHERE pedidoId = ?))`;

// Pedidos que têm ao menos uma CR não cancelada por algum dos dois vínculos.
const SQL_PEDIDOS = `
  SELECT p.id, p.numero, p.status, p.valorTotal, COALESCE(p.valorPago, 0) AS valorPago,
         p.statusPagamento
    FROM pedidos p
   WHERE p.status != 'cancelado'
     AND EXISTS (
       SELECT 1 FROM contas_a_receber cr
        WHERE cr.status != 'cancelada'
          AND (cr.pedidoId = p.id OR cr.faturaId IN (SELECT id FROM faturas WHERE pedidoId = p.id))
     )
   ORDER BY p.id`;

const statusEsperado = (valorTotal, pago) => {
  if ((valorTotal || 0) > 0 && pago >= valorTotal - 0.01) return 'pago';
  return pago > 0 ? 'parcial' : 'pendente';
};

const money = (v) => Number(v || 0).toFixed(2).padStart(12);

function auditarTenant(slug) {
  const arquivo = path.join(RAIZ, slug, 'pncp.db');
  if (!fs.existsSync(arquivo)) return null;
  let db;
  try {
    db = new Database(arquivo, { readonly: true, fileMustExist: true });
  } catch (e) {
    return { slug, erro: `nao foi possivel abrir em somente-leitura: ${e.message}`, divergentes: [] };
  }
  try {
    const pedidos = db.prepare(SQL_PEDIDOS).all();
    const divergentes = [];
    for (const p of pedidos) {
      const pago = Number(db.prepare(SQL_PAGO).get(p.id, p.id).t.toFixed(2));
      const stEsperado = statusEsperado(p.valorTotal, pago);
      const difValor = Number((pago - p.valorPago).toFixed(2));
      if (Math.abs(difValor) < 0.01 && stEsperado === (p.statusPagamento || 'pendente')) continue;
      divergentes.push({
        pedidoId: p.id, numero: p.numero, statusPedido: p.status,
        valorTotal: Number(p.valorTotal || 0), valorPagoAtual: p.valorPago,
        valorPagoEsperado: pago, diferenca: difValor,
        statusPagamentoAtual: p.statusPagamento || 'pendente', statusPagamentoEsperado: stEsperado,
      });
    }
    return { slug, comCR: pedidos.length, divergentes };
  } catch (e) {
    // Tenant com schema antigo (sem `contas_a_receber.pedidoId` ou sem
    // `faturas`) não pode ter o problema: sem a coluna não há CR ligada direto
    // ao pedido. Não é erro de auditoria, é "não se aplica".
    const naoSeAplica = /no such (column|table)/i.test(e.message);
    return { slug, erro: naoSeAplica ? `nao se aplica (schema antigo: ${e.message})` : e.message,
      divergentes: [] };
  } finally {
    db.close();
  }
}

const slugs = alvo
  ? [alvo]
  : fs.readdirSync(RAIZ, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

const resultados = slugs.map(auditarTenant).filter(Boolean);

if (comoJson) {
  console.log(JSON.stringify(resultados, null, 2));
  process.exit(0);
}

console.log('Dry-run — pedidos com pagamento divergente das contas a receber');
console.log('SOMENTE LEITURA: nenhum UPDATE foi executado.\n');

let totalDiv = 0;
let somaDif = 0;
for (const r of resultados) {
  if (r.erro) { console.log(`${r.slug}: (ignorado) ${r.erro}`); continue; }
  if (!r.divergentes.length) {
    console.log(`${r.slug}: ${r.comCR} pedido(s) com CR — nenhuma divergencia`);
    continue;
  }
  console.log(`\n=== ${r.slug} — ${r.divergentes.length} de ${r.comCR} pedido(s) com CR divergem ===`);
  console.log('  pedido  numero                 total       pago atual   pago esperado     diferenca   status atual -> esperado');
  for (const d of r.divergentes) {
    totalDiv += 1;
    somaDif += d.diferenca;
    console.log(`  ${String(d.pedidoId).padStart(6)}  ${String(d.numero || '-').padEnd(18)}`
      + `${money(d.valorTotal)} ${money(d.valorPagoAtual)} ${money(d.valorPagoEsperado)} ${money(d.diferenca)}`
      + `   ${d.statusPagamentoAtual} -> ${d.statusPagamentoEsperado}`);
  }
}

console.log(`\nTotal: ${totalDiv} pedido(s) divergente(s) em ${resultados.length} tenant(s).`);
console.log(`Soma das diferencas: R$ ${somaDif.toFixed(2)} que o pedido deixou de registrar como pago.`);
console.log('\nNenhuma escrita foi feita. O backfill depende de autorizacao explicita.');
