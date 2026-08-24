/**
 * plano-categorias-padrao.js — categorias padrão de contas a receber e a pagar,
 * já ligadas ao plano de contas gerencial.
 *
 * Por que existe: o orçamento só soma título classificado, e a classificação
 * vinha da categoria. Os tenants nasciam com categorias e com plano de contas,
 * mas sem vínculo entre os dois — então o previsto × realizado ficava zerado
 * para todo mundo, e caía no colo do cliente montar o de-para.
 *
 * Tudo aqui é ponto de partida. O tenant renomeia, apaga, cria e remapeia à
 * vontade: nada é sobrescrito depois de definido (ver `aplicarPadrao`).
 */

// Conta que faltava: existia 3.2 "Custo dos Serviços Prestados" sem nenhuma
// conta de receita correspondente, então serviço entrava como venda.
const CONTAS_FALTANTES = [
  { codigo: '1.3', nome: 'Receita de Serviços', tipo: 'receita', pai: '1', ordem: 30 },
];

// Cada categoria aponta para uma conta ANALÍTICA (nível 2). Apontar para conta
// sintética (a de nível 1) faz o orçamento somar no cabeçalho do grupo e o
// relatório perder a quebra por natureza.
const CATEGORIAS_CR = [
  { nome: 'Vendas',            icone: '🛒', conta: '1.1' },
  { nome: 'Serviços',          icone: '🔧', conta: '1.3' },
  { nome: 'Licitações',        icone: '📑', conta: '1.1' },
  { nome: 'Assinaturas',       icone: '🔁', conta: '1.2' },
  { nome: 'Aluguel recebido',  icone: '🏠', conta: '1.2' },
  { nome: 'Juros/Rendimentos', icone: '📈', conta: '5.1' },
  { nome: 'Juros recebidos',   icone: '📈', conta: '5.1' },
  { nome: 'Multa recebida',    icone: '⚖️', conta: '5.1' },
  { nome: 'Outros',            icone: '📦', conta: '1.2' },
];

const CATEGORIAS_CP = [
  { nome: 'Fornecedores',           icone: '📦', conta: '3.1' },
  { nome: 'Serviços de terceiros',  icone: '🔨', conta: '3.2' },
  { nome: 'Salário/Pró-labore',     icone: '👥', conta: '4.1' },
  { nome: 'Energia',                icone: '💡', conta: '4.2' },
  { nome: 'Água',                   icone: '💧', conta: '4.2' },
  { nome: 'Telefone/Internet',      icone: '📞', conta: '4.2' },
  { nome: 'Aluguel',                icone: '🏢', conta: '4.2' },
  { nome: 'Manutenção',             icone: '🛠️', conta: '4.2' },
  { nome: 'Marketing/Publicidade',  icone: '📣', conta: '4.3' },
  { nome: 'Comissões',              icone: '🤝', conta: '4.3' },
  { nome: 'Frete/Logística',        icone: '🚚', conta: '4.3' },
  { nome: 'Software e TI',          icone: '💻', conta: '4.4' },
  { nome: 'Impostos',               icone: '🧾', conta: '2.1' },
  { nome: 'Tarifas bancárias',      icone: '🏦', conta: '5.2' },
  { nome: 'Juros e multas pagos',   icone: '⚠️', conta: '5.2' },
  { nome: 'Imobilizado',            icone: '🏗️', conta: '6.1' },
  { nome: 'Serviços',               icone: '🔧', conta: '4.5' },
  { nome: 'Outros',                 icone: '📄', conta: '4.5' },
];

// 2.2 (Devoluções) e 9.1 (Transferências) ficam de fora de propósito: não
// nascem de título de cliente ou fornecedor, vêm da devolução e da
// transferência entre contas.

/** Conta pelo código, exigindo que seja analítica (sem filhos). */
function contaAnalitica(db, codigo) {
  const c = db.prepare('SELECT id, codigo, nome, nivel FROM plano_contas WHERE codigo = ? AND ativo = 1').get(codigo);
  if (!c) return null;
  const filhos = db.prepare('SELECT COUNT(*) n FROM plano_contas WHERE parentId = ?').get(c.id).n;
  return filhos > 0 ? null : c;
}

function garantirContasFaltantes(db) {
  const criadas = [];
  for (const c of CONTAS_FALTANTES) {
    if (db.prepare('SELECT 1 FROM plano_contas WHERE codigo = ?').get(c.codigo)) continue;
    const pai = db.prepare('SELECT id FROM plano_contas WHERE codigo = ?').get(c.pai);
    db.prepare(`INSERT INTO plano_contas (codigo, nome, tipo, parentId, nivel, ordem, ativo)
      VALUES (?, ?, ?, ?, 2, ?, 1)`).run(c.codigo, c.nome, c.tipo, pai ? pai.id : null, c.ordem);
    criadas.push(c.codigo);
  }
  return criadas;
}

/**
 * Aplica o padrão. Cria o que falta e liga o que está solto — nunca reescreve
 * vínculo já definido, porque a partir do primeiro ajuste do cliente o padrão
 * deixa de ser a verdade.
 *
 * @param {object} opts.forcar  remapeia até o que já tem conta (só para
 *                              reverter uma bagunça, a pedido do usuário)
 */
function aplicarPadrao(db, { forcar = false } = {}) {
  const res = { contasCriadas: [], categoriasCriadas: [], vinculadas: 0, remapeadas: 0, semConta: [] };

  const temTabela = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(t);
  if (!temTabela('plano_contas')) return res;

  res.contasCriadas = garantirContasFaltantes(db);

  const lados = [
    { tabela: 'categorias_cr', lista: CATEGORIAS_CR },
    { tabela: 'categorias_cp', lista: CATEGORIAS_CP },
  ];

  for (const { tabela, lista } of lados) {
    if (!temTabela(tabela)) continue;
    for (const cat of lista) {
      const conta = contaAnalitica(db, cat.conta);
      if (!conta) { res.semConta.push(`${cat.nome} → ${cat.conta}`); continue; }

      const existente = db.prepare(`SELECT id, planoContaId FROM ${tabela} WHERE nome = ?`).get(cat.nome);
      if (!existente) {
        db.prepare(`INSERT INTO ${tabela} (nome, icone, planoContaId, ativo) VALUES (?, ?, ?, 1)`)
          .run(cat.nome, cat.icone, conta.id);
        res.categoriasCriadas.push(`${tabela}:${cat.nome}`);
        continue;
      }
      if (existente.planoContaId == null) {
        db.prepare(`UPDATE ${tabela} SET planoContaId = ? WHERE id = ?`).run(conta.id, existente.id);
        res.vinculadas++;
      } else if (forcar && existente.planoContaId !== conta.id) {
        db.prepare(`UPDATE ${tabela} SET planoContaId = ? WHERE id = ?`).run(conta.id, existente.id);
        res.remapeadas++;
      }
    }
  }

  // Categoria apontando para conta sintética soma no cabeçalho do grupo e
  // esconde a natureza da despesa. Corrige para a analítica de mesmo prefixo.
  for (const tabela of ['categorias_cr', 'categorias_cp']) {
    if (!temTabela(tabela)) continue;
    const sinteticas = db.prepare(`SELECT c.id, c.nome, pc.codigo
      FROM ${tabela} c JOIN plano_contas pc ON pc.id = c.planoContaId
      WHERE (SELECT COUNT(*) FROM plano_contas f WHERE f.parentId = pc.id) > 0`).all();
    for (const s of sinteticas) {
      const filha = db.prepare(`SELECT id FROM plano_contas
        WHERE parentId = (SELECT id FROM plano_contas WHERE codigo = ?) AND ativo = 1
        ORDER BY codigo LIMIT 1`).get(s.codigo);
      if (filha) {
        db.prepare(`UPDATE ${tabela} SET planoContaId = ? WHERE id = ?`).run(filha.id, s.id);
        res.remapeadas++;
      }
    }
  }

  return res;
}

/** O que ainda não tem para onde apontar — para a tela dizer o que falta. */
function diagnostico(db) {
  const out = { semConta: { receber: [], pagar: [] }, contasSemCategoria: [] };
  try {
    for (const [lado, tabela] of [['receber', 'categorias_cr'], ['pagar', 'categorias_cp']]) {
      out.semConta[lado] = db.prepare(
        `SELECT id, nome FROM ${tabela} WHERE ativo = 1 AND planoContaId IS NULL ORDER BY nome`).all();
    }
    out.contasSemCategoria = db.prepare(`
      SELECT pc.codigo, pc.nome, pc.tipo FROM plano_contas pc
      WHERE pc.ativo = 1
        AND (SELECT COUNT(*) FROM plano_contas f WHERE f.parentId = pc.id) = 0
        AND pc.id NOT IN (SELECT planoContaId FROM categorias_cr WHERE planoContaId IS NOT NULL
                          UNION SELECT planoContaId FROM categorias_cp WHERE planoContaId IS NOT NULL)
      ORDER BY pc.codigo`).all();
  } catch { /* tenant sem financeiro */ }
  return out;
}

module.exports = {
  CONTAS_FALTANTES, CATEGORIAS_CR, CATEGORIAS_CP,
  contaAnalitica, aplicarPadrao, diagnostico,
};
