/**
 * migracao-fornecedores-pessoas.js — unifica o cadastro `fornecedores`
 * dentro de `pessoas` (2026-08-20).
 *
 * Havia dois cadastros paralelos: `pessoas` (clientes/prestadores, com o
 * campo `categorias`) e `fornecedores` (tabela própria + tela em Compras).
 * Quem marcava a categoria "fornecedor" numa pessoa NÃO aparecia no Contas
 * a Pagar, porque o autocomplete de lá lia a outra tabela.
 *
 * Daqui em diante `pessoas` é o cadastro único. A coluna `fornecedorId`
 * MANTÉM o nome em todas as tabelas — só o alvo da FK muda para
 * `pessoas(id)`. Renomear a coluna dobraria o churn sem ganho.
 *
 * Idempotente: o sinal de "já rodou" é a AUSÊNCIA da tabela `fornecedores`
 * (o CREATE dela saiu do db-schema.js junto desta migração). Roda no fim do
 * initSchema, onde foreign_keys já está OFF — mas salva/restaura o pragma
 * mesmo assim, porque o módulo também pode ser chamado à mão.
 */

// Colunas que `pessoas` ganha porque só existiam no cadastro de fornecedor.
// O que já tinha equivalente em `pessoas` NÃO é duplicado — ver MAPA_COLUNAS.
const COLUNAS_NOVAS = [
  'celular TEXT',
  'emailFinanceiro TEXT',
  'site TEXT',
  'prazoEntregaDias INTEGER',
  'pedidoMinimo REAL',
  'tipoFrete TEXT',
  "statusHomologacao TEXT DEFAULT 'nao_avaliado'",
  'dataHomologacao TEXT',
  'avaliacao INTEGER',
];

// Colunas de `fornecedores` cujo equivalente em `pessoas` tem outro nome.
const MAPA_COLUNAS = {
  cnae: 'cnaePrincipal',
  condicaoPagamento: 'condicaoPagamentoPadrao',
};

// Colunas copiadas com o mesmo nome nos dois lados.
const COLUNAS_DIRETAS = [
  'cpfCnpj', 'tipo', 'razaoSocial', 'nomeFantasia',
  'inscricaoEstadual', 'inscricaoMunicipal',
  'endereco', 'numero', 'complemento', 'bairro',
  'codigoMunicipio', 'cidade', 'uf', 'cep',
  'telefone', 'email', 'observacoes', 'ativo',
  'contribuinteIcms', 'porte', 'suframa',
  'dataCriacao', 'dataAtualizacao',
  ...COLUNAS_NOVAS.map(c => c.split(' ')[0]),
];

// `fornecedores.regimeTributario` era TEXT ('simples','mei',…) e
// `pessoas.regimeTributario` é INTEGER com a semântica do CRT já em uso na
// tela (1=Simples, 2=Simples excesso, 3=Normal, 4=MEI). Fica o de pessoas.
const REGIME_PARA_CRT = {
  simples: 1, mei: 4, presumido: 3, real: 3, isento: null,
};

// Dados bancários do fornecedor viravam colunas soltas; em `pessoas` existe
// `pessoas_dados_bancarios`, que é onde eles passam a morar.
const COLUNAS_BANCARIAS = ['banco', 'agencia', 'conta', 'tipoConta', 'titularConta', 'chavePix'];

function alterSafe(db, sql) {
  try { db.exec(sql); }
  catch (e) {
    if (/duplicate column/i.test(e.message)) return;
    if (/no such table/i.test(e.message)) return;
    throw e;
  }
}

function tabelaExiste(db, nome) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(nome);
}

function colunasDe(db, tabela) {
  return db.prepare('SELECT name FROM pragma_table_info(?)').all(tabela).map(c => c.name);
}

// Recria uma tabela trocando o alvo da FK de fornecedores para pessoas.
// SQLite não altera FK por ALTER TABLE — só recriando. Índices e triggers
// morrem junto com o DROP, então são salvos e recriados. legacy_alter_table
// deixa o RENAME puramente nominal (não reescreve referências alheias).
function reapontarTabela(db, tabela) {
  const linha = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(tabela);
  if (!linha) return;
  const extras = db.prepare(
    "SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL"
  ).all(tabela).map(r => r.sql);

  const tmp = `${tabela}__mig`;
  const sqlNovo = linha.sql
    .replace(/REFERENCES\s+"?fornecedores"?\s*\(/gi, 'REFERENCES pessoas(')
    .replace(new RegExp(`^CREATE\\s+TABLE\\s+"?${tabela}"?`, 'i'), `CREATE TABLE ${tmp}`);

  const cols = colunasDe(db, tabela).map(c => `"${c}"`).join(',');
  const legado = db.pragma('legacy_alter_table', { simple: true });
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(sqlNovo);
    db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${tabela}`);
    db.exec(`DROP TABLE ${tabela}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${tabela}`);
    for (const sql of extras) db.exec(sql);
  } finally {
    db.pragma(`legacy_alter_table = ${legado ? 'ON' : 'OFF'}`);
  }
}

// Acrescenta 'fornecedor' ao JSON de categorias sem perder o que já havia.
function comCategoriaFornecedor(valorAtual) {
  let cats = [];
  try { cats = JSON.parse(valorAtual || '[]'); } catch (_) { cats = []; }
  if (!Array.isArray(cats)) cats = [];
  if (!cats.some(c => String(c).toLowerCase() === 'fornecedor')) cats.push('fornecedor');
  return JSON.stringify(cats);
}

function valoresDoFornecedor(db, f) {
  const disponiveis = new Set(colunasDe(db, 'pessoas'));
  const dados = {};
  for (const col of COLUNAS_DIRETAS) {
    if (disponiveis.has(col) && f[col] !== undefined) dados[col] = f[col];
  }
  for (const [origem, destino] of Object.entries(MAPA_COLUNAS)) {
    if (disponiveis.has(destino) && f[origem] != null && f[origem] !== '') dados[destino] = f[origem];
  }
  if (f.regimeTributario) {
    const crt = REGIME_PARA_CRT[String(f.regimeTributario).toLowerCase()];
    if (crt) dados.regimeTributario = crt;
  }
  return dados;
}

// Fornecedor que já existe como pessoa (mesmo CNPJ): a pessoa manda, o
// fornecedor só preenche o que estava vazio lá. Perder dado de cliente para
// sobrepor com um cadastro de compras seria o pior desfecho da unificação.
function completarPessoa(db, pessoa, f) {
  const dados = valoresDoFornecedor(db, f);
  const sets = [];
  const vals = [];
  for (const [col, val] of Object.entries(dados)) {
    if (val == null || val === '') continue;
    if (pessoa[col] != null && pessoa[col] !== '') continue;
    if (col === 'cpfCnpj' || col === 'ativo' || col === 'dataCriacao') continue;
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  sets.push('categorias = ?');
  vals.push(comCategoriaFornecedor(pessoa.categorias));
  vals.push(pessoa.id);
  db.prepare(`UPDATE pessoas SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

function inserirPessoa(db, f) {
  const dados = valoresDoFornecedor(db, f);
  dados.categorias = comCategoriaFornecedor(f.categorias);
  const cols = Object.keys(dados);
  const sql = `INSERT INTO pessoas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...cols.map(c => dados[c])).lastInsertRowid;
}

// banco/agencia/conta/chavePix eram colunas de `fornecedores`; viram linha
// em pessoas_dados_bancarios (marcada como padrão, que é como a tesouraria
// escolhe a conta de pagamento).
function migrarDadosBancarios(db, f, pessoaId) {
  if (!tabelaExiste(db, 'pessoas_dados_bancarios')) return;
  if (!COLUNAS_BANCARIAS.some(c => f[c] != null && f[c] !== '')) return;
  const jaTem = db.prepare('SELECT 1 FROM pessoas_dados_bancarios WHERE pessoaId = ?').get(pessoaId);
  if (jaTem) return;
  const disponiveis = new Set(colunasDe(db, 'pessoas_dados_bancarios'));
  const dados = { pessoaId };
  for (const col of COLUNAS_BANCARIAS) {
    if (disponiveis.has(col) && f[col] != null && f[col] !== '') dados[col] = f[col];
  }
  if (disponiveis.has('titular') && f.titularConta) dados.titular = f.titularConta;
  if (disponiveis.has('padrao')) dados.padrao = 1;
  const cols = Object.keys(dados);
  db.prepare(
    `INSERT INTO pessoas_dados_bancarios (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map(c => dados[c]));
}

// O campo texto `fornecedores.contato` vira contato principal — em pessoas
// contato é tabela, não coluna.
function migrarContatoTexto(db, f, pessoaId) {
  if (!f.contato || !tabelaExiste(db, 'pessoas_contatos')) return;
  const jaTem = db.prepare('SELECT 1 FROM pessoas_contatos WHERE pessoaId = ? AND nome = ?').get(pessoaId, f.contato);
  if (jaTem) return;
  db.prepare('INSERT INTO pessoas_contatos (pessoaId, nome, principal) VALUES (?, ?, 1)')
    .run(pessoaId, f.contato);
}

function migrarContatos(db, mapa) {
  if (!tabelaExiste(db, 'fornecedor_contatos') || !tabelaExiste(db, 'pessoas_contatos')) return;
  const linhas = db.prepare('SELECT * FROM fornecedor_contatos').all();
  const ins = db.prepare(`INSERT INTO pessoas_contatos
    (pessoaId, nome, cargo, area, telefone, email, principal, observacoes, dataCriacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const c of linhas) {
    const pessoaId = mapa.get(c.fornecedorId);
    if (!pessoaId) continue;
    ins.run(pessoaId, c.nome, c.cargo || null, c.setor || null, c.telefone || null,
      c.email || null, c.principal || 0, c.observacao || null, c.dataCriacao || null);
  }
}

// fornecedor_documentos (certidões com validade) não tem equivalente em
// pessoas — pessoas_anexos é arquivo, sem tipo nem dataValidade. Vira
// pessoas_documentos, com a mesma forma e pessoaId no lugar de fornecedorId.
function migrarDocumentos(db, mapa) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pessoas_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pessoaId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      numero TEXT,
      dataEmissao TEXT,
      dataValidade TEXT,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pessoaId) REFERENCES pessoas(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pessoasdoc_pessoa ON pessoas_documentos(pessoaId);
    CREATE INDEX IF NOT EXISTS idx_pessoasdoc_val ON pessoas_documentos(dataValidade);
  `);
  if (!tabelaExiste(db, 'fornecedor_documentos')) return;
  const linhas = db.prepare('SELECT * FROM fornecedor_documentos').all();
  const ins = db.prepare(`INSERT INTO pessoas_documentos
    (pessoaId, tipo, numero, dataEmissao, dataValidade, observacao, dataCriacao)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const d of linhas) {
    const pessoaId = mapa.get(d.fornecedorId);
    if (!pessoaId) continue;
    ins.run(pessoaId, d.tipo, d.numero || null, d.dataEmissao || null,
      d.dataValidade || null, d.observacao || null, d.dataCriacao || null);
  }
}

// Todo fornecedorId espalhado pelo banco (contas_a_pagar, pedidos_compra,
// produtos, lotes…) passa a valer como pessoas.id. Descobre as tabelas pelo
// pragma em vez de listar: cada tenant tem um subconjunto diferente.
function remapearReferencias(db, mapa) {
  const ignorar = new Set(['fornecedores', 'fornecedor_contatos', 'fornecedor_documentos']);
  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(t => t.name)
    .filter(t => !ignorar.has(t) && !t.startsWith('sqlite_'))
    .filter(t => colunasDe(db, t).includes('fornecedorId'));

  let total = 0;
  for (const t of tabelas) {
    const upd = db.prepare(`UPDATE ${t} SET fornecedorId = ? WHERE fornecedorId = ?`);
    for (const [antigo, novo] of mapa) {
      if (antigo === novo) continue;
      total += upd.run(novo, antigo).changes;
    }
  }
  return { tabelas, total };
}

function migrarFornecedoresParaPessoas(db) {
  if (!tabelaExiste(db, 'pessoas')) return null;

  for (const col of COLUNAS_NOVAS) alterSafe(db, `ALTER TABLE pessoas ADD COLUMN ${col}`);

  // Já migrado: o CREATE de `fornecedores` saiu do db-schema.js, então a
  // ausência da tabela é o marcador. pessoas_documentos ainda é garantida
  // aqui porque tenant novo nunca teve a tabela de origem.
  if (!tabelaExiste(db, 'fornecedores')) {
    migrarDocumentos(db, new Map());
    return null;
  }

  const fkAntes = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    const resumo = db.transaction(() => {
      const forns = db.prepare('SELECT * FROM fornecedores').all();
      const mapa = new Map();
      let criadas = 0;
      let fundidas = 0;

      for (const f of forns) {
        const existente = f.cpfCnpj
          ? db.prepare('SELECT * FROM pessoas WHERE cpfCnpj = ?').get(f.cpfCnpj)
          : null;
        let pessoaId;
        if (existente) {
          completarPessoa(db, existente, f);
          pessoaId = existente.id;
          fundidas++;
        } else {
          pessoaId = inserirPessoa(db, f);
          criadas++;
        }
        mapa.set(f.id, pessoaId);
        migrarDadosBancarios(db, f, pessoaId);
        migrarContatoTexto(db, f, pessoaId);
      }

      migrarContatos(db, mapa);
      migrarDocumentos(db, mapa);
      const refs = remapearReferencias(db, mapa);

      // A FK só pode ser reapontada depois do remapeamento — antes disso os
      // ids ainda são do mundo antigo.
      const comFk = db.prepare(`
        SELECT DISTINCT m.name FROM sqlite_master m
          JOIN pragma_foreign_key_list(m.name) p
         WHERE m.type='table' AND p."table"='fornecedores'`).all().map(r => r.name);
      for (const t of comFk) {
        if (t === 'fornecedor_contatos' || t === 'fornecedor_documentos') continue;
        reapontarTabela(db, t);
      }

      db.exec('DROP TABLE IF EXISTS fornecedor_contatos');
      db.exec('DROP TABLE IF EXISTS fornecedor_documentos');
      db.exec('DROP TABLE fornecedores');

      return { criadas, fundidas, tabelas: refs.tabelas.length, refs: refs.total };
    })();

    const problemas = db.pragma('foreign_key_check');
    if (problemas.length) {
      console.warn('[migracao-fornecedores-pessoas] foreign_key_check apontou',
        problemas.length, 'inconsistência(s):', JSON.stringify(problemas.slice(0, 5)));
    }
    console.log(`[migracao-fornecedores-pessoas] ${resumo.criadas} pessoa(s) criada(s), ` +
      `${resumo.fundidas} fundida(s) por CNPJ, ${resumo.refs} referência(s) remapeada(s) ` +
      `em ${resumo.tabelas} tabela(s)`);
    return resumo;
  } finally {
    db.pragma(`foreign_keys = ${fkAntes ? 'ON' : 'OFF'}`);
  }
}

module.exports = { migrarFornecedoresParaPessoas };
