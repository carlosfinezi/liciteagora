/**
 * Matriz de desconto × alçada × atendimento, executada no tenant SANDBOX.
 *
 * Diferente de `test-fase1-funcional.js`, que roda em banco descartável, este
 * exercita o BANCO REAL do sandbox — com o cadastro, os perfis e as faixas que
 * estão lá. É o ensaio mais próximo da produção que se pode fazer sem tocar em
 * tenant de cliente e sem reiniciar serviço.
 *
 *   node scripts/sandbox-fase1-matriz.js            só imprime a matriz
 *   node scripts/sandbox-fase1-matriz.js --limpar   apaga a massa que criou
 *
 * Só escreve no sandbox. Todo pedido criado leva o prefixo `FASE1-MATRIZ-` no
 * campo `observacoesInterna`, que é como `--limpar` o reconhece depois.
 */
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const RAIZ = path.join(__dirname, '..');
const DB = path.join(RAIZ, 'data', 'tenants', 'sandbox', 'pncp.db');
const MARCA = 'FASE1-MATRIZ';

const db = new Database(DB);
const { registrarRotasPedidos } = require(RAIZ + '/pedidos-routes');
const { registrarRotasProdutos } = require(RAIZ + '/produtos-routes');
const { registrarRotasReservas } = require(RAIZ + '/reservas-routes');

if (process.argv.includes('--limpar')) {
  const ids = db.prepare("SELECT id FROM pedidos WHERE observacoesInterna LIKE ?").all(`${MARCA}%`).map((r) => r.id);
  let n = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      for (const t of ['reservas_estoque', 'pedido_parcelas', 'pedido_historico', 'pedido_itens']) {
        try { db.prepare(`DELETE FROM "${t}" WHERE pedidoId = ?`).run(id); } catch {}
      }
      try { db.prepare('DELETE FROM aprovacoes WHERE tipoEvento = ? AND referenciaId = ?').run('desconto_venda', id); } catch {}
      db.prepare('DELETE FROM pedidos WHERE id = ?').run(id);
      n++;
    }
  });
  tx();
  console.log(`${n} pedido(s) de massa removido(s) do sandbox.`);
  db.close();
  process.exit(0);
}

const app = express();
registrarRotasPedidos(app, db);
registrarRotasProdutos(app, db);
registrarRotasReservas(app, db);

const achar = (p, m) => {
  const l = ((app.router || app._router).stack || [])
    .find((x) => x.route && x.route.path === p && x.route.methods[m]);
  if (!l) throw new Error(`rota ausente: ${m.toUpperCase()} ${p}`);
  return l.route.stack.at(-1).handle;
};
function chamar(p, m, o = {}) {
  let out = null, st = 200;
  achar(p, m)({ params: o.params || {}, query: {}, body: o.body || {},
                session: o.session || {}, user: o.user, ip: '127.0.0.1', headers: {} },
    { json: (x) => { out = x; return { json: (y) => { out = y; } }; },
      status: (c) => { st = c; return { json: (x) => { out = x; } }; } });
  return { out, st };
}

const u = (username) => db.prepare('SELECT * FROM users WHERE username = ?').get(username);
const ator = (username) => {
  const r = u(username);
  if (!r) throw new Error(`usuário ausente no sandbox: ${username}`);
  return { session: { userId: r.id }, user: { id: r.id, username: r.username, role: r.role, ativo: 1, ehVendedor: r.ehVendedor } };
};
const VEND = ator('vendedor'), GERENTE = ator('gerente'), ADMIN = ator('admin');

// Cliente e produto da massa: os que já existem no sandbox, sem criar cadastro novo.
const cliente = db.prepare('SELECT * FROM pessoas WHERE endereco IS NOT NULL AND TRIM(endereco) <> \'\' AND ativo = 1 ORDER BY id LIMIT 1').get()
  || db.prepare('SELECT * FROM pessoas WHERE ativo = 1 ORDER BY id LIMIT 1').get();
const produto = db.prepare('SELECT * FROM produtos WHERE ativo = 1 AND precoVenda > 0 ORDER BY id LIMIT 1').get();
if (!cliente || !produto) { console.error('sandbox sem cliente ou produto ativo'); process.exit(2); }

console.log(`### Matriz Fase 1 no SANDBOX`);
console.log(`### cliente #${cliente.id} "${cliente.razaoSocial}"  ·  produto #${produto.id} "${produto.descricao}" R$ ${Number(produto.precoVenda).toFixed(2)}`);
console.log(`### faixas: ${db.prepare("SELECT GROUP_CONCAT(limiteValor||'% -> '||papelAprovador, '  |  ') g FROM regras_alcada WHERE tipoEvento='desconto_venda' AND ativo=1").get().g}\n`);

const QTD = 5;
function montar(a, extra = {}) {
  const p = chamar('/api/pedidos', 'post', { ...a, body: { clienteId: cliente.id, ...extra } }).out.pedido;
  chamar('/api/pedidos/:id', 'put', { ...a, params: { id: p.id }, body: { observacoesInterna: `${MARCA} ${new Date().toISOString()}` } });
  chamar('/api/pedidos/:id/itens', 'post', { ...a, params: { id: p.id },
    body: { produtoId: produto.id, descricao: produto.descricao, quantidade: QTD } });
  return p.id;
}
const ler = (id) => db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
const sub = (id) => db.prepare('SELECT COALESCE(SUM(valorTotal),0) s FROM pedido_itens WHERE pedidoId = ?').get(id).s;

// ==================== DESCONTO × ALÇADA ====================
const casos = [
  ['VENDEDOR', VEND, 0], ['VENDEDOR', VEND, 3], ['VENDEDOR', VEND, 5], ['VENDEDOR', VEND, 6],
  ['GERENTE', GERENTE, 5], ['GERENTE', GERENTE, 15], ['GERENTE', GERENTE, 16],
  ['ADMIN', ADMIN, 30],
];

const l = (c, n) => String(c).padEnd(n);
const r = (c, n) => String(c).padStart(n);
console.log(l('ATOR', 10) + r('%', 5) + r('SUBTOTAL', 11) + r('DESCONTO', 10) + r('FRETE', 8)
  + r('TOTAL', 11) + '  ' + l('ALÇADA', 14) + l('APROV?', 8) + 'STATUS');
console.log('-'.repeat(96));

const criados = [];
for (const [rotulo, a, pct] of casos) {
  const id = montar(a);
  criados.push(id);
  chamar('/api/pedidos/:id', 'put', { ...a, params: { id }, body: { valorFrete: 20 } });
  const res = chamar('/api/pedidos/:id', 'put', { ...a, params: { id },
    body: { descontoPercentual: pct, descontoMotivo: 'massa de teste da matriz Fase 1' } });

  const p = ler(id);
  const d = res.out && res.out.desconto;
  // Quando vai para aprovação não há "autoridade" — é justamente a ausência
  // dela que abriu a solicitação. Rotular isso de `alcada_base` seria dizer o
  // contrário do que aconteceu.
  const alcada = res.st !== 200 ? 'RECUSADO'
    : !d ? '—'
      : d.aguardandoAprovacao ? 'sem autoridade'
        : (d.autoridade || 'alcada_base');
  const aprov = res.st !== 200 ? '—' : (d && d.aguardandoAprovacao ? `SIM (${d.papelExigido})` : 'nao');

  const conf = chamar('/api/pedidos/:id/confirmar', 'post', { ...a, params: { id }, body: {} });
  const status = conf.st === 200 ? ler(id).status : `${conf.st} rascunho`;

  console.log(l(rotulo, 10) + r(pct + '%', 5) + r(Number(sub(id)).toFixed(2), 11)
    + r(Number(p.descontoAplicado || 0).toFixed(2), 10) + r(Number(p.valorFrete || 0).toFixed(2), 8)
    + r(Number(p.valorTotal).toFixed(2), 11) + '  ' + l(alcada, 14) + l(aprov, 8) + status);
}

// ==================== ATENDIMENTO ====================
console.log('\n' + l('ORIGEM', 12) + l('ATENDIMENTO', 14) + l('ENDEREÇO', 12) + 'CONFIRMAÇÃO');
console.log('-'.repeat(70));

/**
 * Nenhum cliente do sandbox tem endereço cadastrado (conferido). Por isso o caso
 * "com endereço" usa o OVERRIDE do pedido — `enderecoEntrega`, campo que já
 * existia antes desta fase —, que é o outro caminho aceito e o que se queria
 * exercitar de qualquer forma.
 */
function casoAtend(origem, tipoAtend, comEndereco = false) {
  const body = { clienteId: cliente.id };
  if (origem === 'pdv') body.origem = 'pdv';
  if (tipoAtend) body.tipoAtendimento = tipoAtend;
  const id = montar(VEND, body);
  criados.push(id);
  if (comEndereco) {
    chamar('/api/pedidos/:id', 'put', { ...VEND, params: { id },
      body: { enderecoEntrega: 'Rua da Matriz, 100', cidadeEntrega: 'Campinas', ufEntrega: 'SP' } });
  }
  // 'catalogo' é origem reservada: não vem do corpo, a loja a grava direto.
  if (origem === 'catalogo') db.prepare("UPDATE pedidos SET tipo='catalogo' WHERE id=?").run(id);
  const c = chamar('/api/pedidos/:id/confirmar', 'post', { ...ADMIN, params: { id }, body: {} });
  console.log(l(origem, 12) + l(tipoAtend || '(nulo)', 14) + l(comEndereco ? 'no pedido' : 'nenhum', 12)
    + (c.st === 200 ? 'OK — confirmado' : `${c.st} — ${String(c.out.error).slice(0, 44)}`));
}

casoAtend('pdv', 'no_local');
casoAtend('pdv', 'retirada');
casoAtend('pdv', 'entrega', true);
casoAtend('pdv', null);
casoAtend('pdv', 'entrega', false);
casoAtend('catalogo', 'retirada');
casoAtend('catalogo', 'entrega', true);
casoAtend('catalogo', null);
casoAtend('catalogo', 'entrega', false);
casoAtend('manual', null);

console.log(`\n${criados.length} pedido(s) de massa criados no sandbox, marcados "${MARCA}".`);
console.log('Para remover:  node scripts/sandbox-fase1-matriz.js --limpar');
db.close();
