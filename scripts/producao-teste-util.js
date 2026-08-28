/**
 * producao-teste-util.js — boot de um banco DESCARTÁVEL para os testes do
 * módulo Pré-moldados.
 *
 * Por que não roda contra `labfiscal` como farmácia e locação: aqueles testes
 * mexem no banco real de um tenant e já petrificaram resíduo em produção uma
 * vez (ver o cabeçalho de scripts/locacao-teste-util.js). Este módulo não
 * depende de massa histórica nenhuma, então o banco novo em /tmp é mais barato
 * E mais seguro — não há o que restaurar porque não há o que sujar.
 *
 * ORDEM DE BOOT (importa, e não é óbvia):
 *   1. contas-financeiras-routes — senão initSchema estoura em `contas_financeiras`
 *   2. initSchema(db)            — o core, que já chama initProducaoSchema
 *   3. estoque-routes            — acrescenta custoMedioPosterior/saldoPosterior
 *                                  em movimentacoes_estoque; sem isso a baixa
 *                                  da OP grava sem contexto de custo
 *   4. rh-routes                 — funcionarios e funcionarios_ponto, o
 *                                  denominador do indicador de produtividade
 *   5. premoldados-routes
 *
 * Uso:
 *   const { montar, seed } = require('./producao-teste-util');
 *   const { db, app, servidor, porta } = await montar();
 */

const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');
const Database = require(BASE + '/node_modules/better-sqlite3');
const express = require(BASE + '/node_modules/express');

/** Cria o banco descartável e sobe um Express com as rotas do módulo. */
async function montar({ porta = 0, arquivo = null, usuario = 'teste' } = {}) {
  const caminho = arquivo || `/tmp/pmo-teste-${process.pid}-${Math.floor(process.uptime() * 1e6)}.db`;
  // Um teste que reencontra o banco da rodada anterior passa por motivo errado.
  for (const sufixo of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(caminho + sufixo); } catch (_) {}
  }
  const db = new Database(caminho);

  require(BASE + '/contas-financeiras-routes');
  const { initSchema } = require(BASE + '/db-schema');

  const app = express();
  app.use(express.json());
  // Middleware falso: o módulo só lê req.user.username para carimbar autoria.
  app.use((req, _res, next) => { req.user = { id: 1, username: usuario }; next(); });

  const { registrarRotasContasFinanceiras } = require(BASE + '/contas-financeiras-routes');
  registrarRotasContasFinanceiras(app, db);

  initSchema(db);

  const { registrarRotasEstoque } = require(BASE + '/estoque-routes');
  registrarRotasEstoque(app, db);

  const { registrarRotasRH } = require(BASE + '/rh-routes');
  registrarRotasRH(app, db);

  // `audit_log` não vem do initSchema — quem a cria é o boot completo do
  // server. Sem ela o logAction engole o erro e enche a saída do teste de
  // "no such table", escondendo as falhas de verdade.
  // As colunas espelham o INSERT de audit-log.js:22 — nomes diferentes fazem
  // o logAction falhar em silêncio e o teste perde a cobertura da auditoria.
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER, username TEXT, action TEXT, entity TEXT, entityId TEXT,
      payload TEXT, ip TEXT, createdAt TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const { registrarRotasProducao } = require(BASE + '/producao/producao-routes');
  registrarRotasProducao(app, db);

  // A flag nasce desligada em produção; nos testes ligamos de propósito, e o
  // primeiro caso de teste confere que desligada devolve 403.
  const servidor = await new Promise(resolve => {
    const s = app.listen(porta, '127.0.0.1', () => resolve(s));
  });

  return { db, app, servidor, porta: servidor.address().port, caminho };
}

function ligarFlag(db, ligada = true) {
  db.prepare(`
    INSERT INTO config (chave, valor) VALUES ('producao_enabled', ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `).run(ligada ? '1' : '0');
}

function setCfg(db, chave, valor) {
  db.prepare(`
    INSERT INTO config (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `).run(chave, String(valor));
}

/**
 * Massa mínima: insumos com custo, um cliente, funcionários e ponto.
 *
 * O custo dos insumos entra por movimentação de ENTRADA, não por `precoCusto`:
 * é assim que a fábrica real forma custo, e é o caminho que `custoUnitarioInsumo`
 * prefere (custo médio). Semear só o precoCusto testaria o fallback e deixaria
 * o caminho principal sem cobertura.
 */
function seed(db) {
  const prod = db.prepare(`
    INSERT INTO produtos (sku, descricao, unidade, precoCusto, precoVenda, ativo)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  const mov = db.prepare(`
    INSERT INTO movimentacoes_estoque (produtoId, tipo, quantidade, custoUnitario, origem, observacao, data)
    VALUES (?, 'entrada', ?, ?, 'seed', 'carga inicial de teste', datetime('now'))
  `);

  const ids = {};
  // Insumos: cimento (R$ 0,60/kg), areia, brita, aço CA-50, aditivo.
  ids.cimento = prod.run('CIM-50', 'Cimento CP-V ARI', 'KG', 0.60, 0).lastInsertRowid;
  ids.areia   = prod.run('ARE-M3', 'Areia média', 'M3', 90, 0).lastInsertRowid;
  ids.brita   = prod.run('BRI-M3', 'Brita 1', 'M3', 110, 0).lastInsertRowid;
  ids.aco     = prod.run('ACO-50', 'Aço CA-50 10mm', 'KG', 7.50, 0).lastInsertRowid;
  ids.aditivo = prod.run('ADT-PL', 'Aditivo plastificante', 'L', 12, 0).lastInsertRowid;
  // Insumo SEM custo: existe para provar que o aviso aparece.
  ids.semCusto = prod.run('SEM-CUS', 'Desmoldante sem custo', 'L', 0, 0).lastInsertRowid;

  mov.run(ids.cimento, 100000, 0.60);
  mov.run(ids.areia, 500, 90);
  mov.run(ids.brita, 500, 110);
  mov.run(ids.aco, 50000, 7.50);
  mov.run(ids.aditivo, 2000, 12);

  // Peças (produtos de saída).
  ids.bloco = prod.run('BLC-14', 'Bloco de concreto 14x19x39', 'UN', 0, 4.50).lastInsertRowid;
  ids.viga  = prod.run('VIG-PRO', 'Viga protendida 12m', 'UN', 0, 3800).lastInsertRowid;
  ids.pilar = prod.run('PIL-OBR', 'Pilar pré-moldado 6m', 'UN', 0, 2100).lastInsertRowid;
  ids.armacao = prod.run('ARM-VIG', 'Armação montada da viga', 'UN', 0, 0).lastInsertRowid;

  // Cliente da obra.
  ids.cliente = db.prepare(`
    INSERT INTO pessoas (razaoSocial, nomeFantasia, cpfCnpj, tipo, categorias, ativo)
    VALUES ('Construtora Teste Ltda', 'Construtora Teste', '12345678000199', 'PJ', 'cliente', 1)
  `).run().lastInsertRowid;

  // Funcionários e ponto: 4 pessoas, 8h/dia.
  const func = db.prepare(`
    INSERT INTO funcionarios (nome, cargo, dataAdmissao, salario, ativo)
    VALUES (?, ?, '2024-01-01', ?, 1)
  `);
  ids.funcionarios = [
    func.run('Armador Um', 'Armador', 2400).lastInsertRowid,
    func.run('Montador Dois', 'Montador de forma', 2200).lastInsertRowid,
    func.run('Operador Tres', 'Operador de betoneira', 2600).lastInsertRowid,
    func.run('Ajudante Quatro', 'Ajudante', 1800).lastInsertRowid,
  ];

  return ids;
}

/** Lança ponto de 8h para uma lista de funcionários numa data. */
function lancarPonto(db, funcionarioIds, data, horas = 8) {
  const ins = db.prepare(`
    INSERT INTO funcionarios_ponto (funcionarioId, data, horaEntrada, horaSaida, horasTrabalhadas)
    VALUES (?, ?, '07:00', '17:00', ?)
    ON CONFLICT(funcionarioId, data) DO UPDATE SET horasTrabalhadas = excluded.horasTrabalhadas
  `);
  for (const id of funcionarioIds) ins.run(id, data, horas);
}

/** Saldo de estoque simples, para os asserts (não depende do estoque-routes). */
function saldo(db, produtoId) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN tipo = 'entrada' THEN quantidade
                             WHEN tipo = 'saida' THEN -quantidade
                             ELSE quantidade END), 0) AS s
      FROM movimentacoes_estoque WHERE produtoId = ?
  `).get(produtoId);
  return r.s;
}

module.exports = { montar, ligarFlag, setCfg, seed, lancarPonto, saldo, BASE };
