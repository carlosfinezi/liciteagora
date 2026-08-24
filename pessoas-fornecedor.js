/**
 * pessoas-fornecedor.js — o lado "fornecedor" do cadastro único `pessoas`.
 *
 * Depois da unificação (ver migracao-fornecedores-pessoas.js) não existe mais
 * tabela `fornecedores`: fornecedor é uma pessoa com "fornecedor" dentro do
 * JSON da coluna `categorias`. Este módulo concentra as duas coisas que todo
 * mundo precisava fazer e fazia de um jeito diferente:
 *
 *   - filtrar pessoas que são fornecedor  → E_FORNECEDOR
 *   - achar-ou-criar fornecedor por CNPJ  → garantirFornecedor()
 *
 * O achar-ou-criar existe porque quatro fluxos criam fornecedor sozinhos:
 * importação de XML de NF-e de entrada, importação de planilha de produtos,
 * adquirente de cartão na tesouraria e apuração fiscal. Antes cada um dava um
 * INSERT direto na tabela; agora todos passam por aqui, senão a pessoa nasce
 * sem a categoria e some das telas de compra.
 */

// Predicado SQL de "é fornecedor". As aspas fazem parte do LIKE de propósito:
// `categorias` guarda JSON (["cliente","fornecedor"]), e sem elas um valor
// futuro como "fornecedor-homologado" casaria junto.
const E_FORNECEDOR = `categorias LIKE '%"fornecedor"%'`;

function categoriasComFornecedor(valorAtual) {
  let cats = [];
  try { cats = JSON.parse(valorAtual || '[]'); } catch (_) { cats = []; }
  if (!Array.isArray(cats)) cats = [];
  if (!cats.some(c => String(c).toLowerCase() === 'fornecedor')) cats.push('fornecedor');
  return JSON.stringify(cats);
}

// Marca uma pessoa já existente como fornecedor, preservando as categorias
// que ela já tinha (um cliente que passa a fornecer continua cliente).
function marcarComoFornecedor(db, pessoaId) {
  const p = db.prepare('SELECT categorias FROM pessoas WHERE id = ?').get(pessoaId);
  if (!p) return;
  const novas = categoriasComFornecedor(p.categorias);
  if (novas === p.categorias) return;
  db.prepare('UPDATE pessoas SET categorias = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
    .run(novas, pessoaId);
}

/**
 * Acha a pessoa pelo documento (ou, sem documento, pela razão social) e
 * garante que ela esteja marcada como fornecedor. Cria se não existir.
 * Devolve o id — é o que os chamadores gravam em `fornecedorId`.
 *
 * `dados` aceita qualquer coluna de `pessoas`; o que não for coluna é
 * ignorado. Isso existe porque a importação de XML de NF-e traz o endereço
 * inteiro do emitente e seria perda gravar só o nome.
 *
 * Só cria com razaoSocial: é NOT NULL na tabela.
 */
function garantirFornecedor(db, dados = {}) {
  const doc = String(dados.cpfCnpj || '').trim() || null;
  const nome = String(dados.razaoSocial || '').trim();

  let achada = null;
  if (doc) achada = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(doc);
  if (!achada && nome) achada = db.prepare('SELECT id FROM pessoas WHERE razaoSocial = ?').get(nome);

  if (achada) {
    marcarComoFornecedor(db, achada.id);
    return achada.id;
  }
  if (!nome) return null;

  const colunas = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all('pessoas').map(c => c.name));
  const campos = { tipo: 'PJ' };
  for (const [k, v] of Object.entries(dados)) {
    if (k === 'id' || k === 'categorias') continue;
    if (colunas.has(k) && v !== undefined) campos[k] = v;
  }
  campos.cpfCnpj = doc;
  campos.razaoSocial = nome;
  campos.categorias = categoriasComFornecedor(null);
  if (campos.ativo === undefined) campos.ativo = 1;

  const cols = Object.keys(campos);
  const info = db.prepare(
    `INSERT INTO pessoas (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map(c => campos[c]));
  return info.lastInsertRowid;
}

// Chave PIX do fornecedor. Deixou de ser coluna do cadastro e passou a viver
// em pessoas_dados_bancarios, onde já morava a das demais pessoas — a conta
// marcada como padrão é a que a tesouraria usa para pagar.
function chavePixDe(db, pessoaId) {
  if (!pessoaId) return null;
  const linha = db.prepare(`SELECT chavePix FROM pessoas_dados_bancarios
     WHERE pessoaId = ? AND chavePix IS NOT NULL AND chavePix <> ''
     ORDER BY padrao DESC, id ASC LIMIT 1`).get(pessoaId);
  return linha ? linha.chavePix : null;
}

// Grava a chave PIX descoberta em outro lugar (ex.: retorno do banco na
// conciliação) sem sobrepor a que o usuário já tenha cadastrado.
function guardarChavePix(db, pessoaId, chavePix) {
  if (!pessoaId || !chavePix) return;
  if (chavePixDe(db, pessoaId)) return;
  const existente = db.prepare(
    'SELECT id FROM pessoas_dados_bancarios WHERE pessoaId = ? ORDER BY padrao DESC, id ASC LIMIT 1'
  ).get(pessoaId);
  if (existente) {
    db.prepare('UPDATE pessoas_dados_bancarios SET chavePix = ? WHERE id = ?').run(chavePix, existente.id);
  } else {
    db.prepare('INSERT INTO pessoas_dados_bancarios (pessoaId, chavePix, padrao) VALUES (?, ?, 1)')
      .run(pessoaId, chavePix);
  }
}

module.exports = {
  E_FORNECEDOR,
  categoriasComFornecedor,
  marcarComoFornecedor,
  garantirFornecedor,
  chavePixDe,
  guardarChavePix,
};
