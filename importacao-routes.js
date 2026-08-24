/**
 * importacao-routes.js — Importação em massa via CSV.
 *
 * Tipos suportados:
 *   - pessoas          (clientes/fornecedores)
 *   - produtos
 *   - saldo-produtos   (lança entrada de estoque com custoUnitario — saldo inicial)
 *   - contas-a-pagar
 *   - contas-a-receber
 *
 * Formato: CSV com separador `;` (padrão BR). Primeira linha = cabeçalho.
 * Datas: YYYY-MM-DD ou DD/MM/YYYY. Valores: com vírgula ou ponto decimal.
 *
 * Endpoints:
 *   GET  /api/importacao/template/:tipo   — baixa CSV modelo
 *   POST /api/importacao/preview          — upload multipart (campo "arquivo") + tipo, devolve linhas validadas
 *   POST /api/importacao/confirmar        — recebe { tipo, linhas } e insere as válidas numa transação
 */

const multer = require('multer');
const { assertMeioPermitido } = require('./meios-pagamento');
// O multer quebra o contexto de tenant (AsyncLocalStorage nao atravessa
// callback de stream); este middleware o recupera antes do handler.
const { reentrarContextoTenant } = require('./tenant-middleware');
const { calcularContextoMovimento } = require('./estoque-routes');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.csv$/i.test(file.originalname) || /csv|text/i.test(file.mimetype);
    cb(ok ? null : new Error('Apenas arquivos CSV são aceitos'), ok);
  }
});

// ==================== SCHEMAS DOS TIPOS ====================
// Cada tipo tem: colunas (nome cabeçalho), campo obrigatório, parser por linha.

const TIPOS = {
  'pessoas': {
    titulo: 'Pessoas (clientes/fornecedores)',
    colunas: ['cpfCnpj', 'tipo', 'razaoSocial', 'nomeFantasia', 'email', 'telefone',
              'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'cep',
              'inscricaoEstadual', 'inscricaoMunicipal', 'observacoes'],
    exemplo: [
      ['11.222.333/0001-44', 'PJ', 'Empresa Exemplo Ltda', 'Exemplo', 'contato@exemplo.com', '(91) 3333-3333',
       'Rua A', '100', '', 'Centro', 'Belém', 'PA', '66000-000', '123456789', '', ''],
      ['123.456.789-00', 'PF', 'João da Silva', '', 'joao@email.com', '(91) 98765-4321',
       'Rua B', '200', 'Apto 10', 'Umarizal', 'Belém', 'PA', '66055-000', '', '', '']
    ]
  },
  'produtos': {
    titulo: 'Produtos',
    colunas: ['sku', 'descricao', 'unidade', 'precoCusto', 'precoVenda', 'ncm', 'cfopPadrao',
              'categoria', 'marca', 'codigoBarras', 'estoqueMinimo', 'csosn', 'cstPIS', 'cstCOFINS', 'observacoes'],
    exemplo: [
      ['SKU-001', 'Caneta Azul BIC', 'UN', '1,20', '3,50', '96081000', '5102', 'Papelaria', 'BIC', '7891234567890', '10', '102', '49', '49', ''],
      ['SKU-002', 'Caderno 100fls', 'UN', '8,00', '15,00', '48201000', '5102', 'Papelaria', 'Tilibra', '', '5', '102', '49', '49', '']
    ]
  },
  'saldo-produtos': {
    titulo: 'Saldo inicial de produtos',
    colunas: ['sku', 'quantidade', 'custoUnitario', 'data', 'observacao'],
    exemplo: [
      ['SKU-001', '150', '1,20', '2026-01-01', 'Saldo inicial do ano'],
      ['SKU-002', '80', '8,00', '2026-01-01', 'Saldo inicial do ano']
    ]
  },
  'contas-a-pagar': {
    titulo: 'Contas a pagar',
    colunas: ['fornecedorCpfCnpj', 'fornecedorNome', 'descricao', 'valor', 'dataEmissao', 'dataVencimento',
              'formaPagamento', 'categoriaNome', 'observacoes'],
    exemplo: [
      ['', 'Energia Elétrica', 'Conta de luz 04/2026', '320,50', '2026-04-05', '2026-04-15', 'boleto', 'Energia', ''],
      ['', 'Prefeitura', 'IPTU parcela 3/12', '180,00', '2026-04-01', '2026-04-20', 'pix', 'Impostos', '']
    ]
  },
  'contas-a-receber': {
    titulo: 'Contas a receber',
    colunas: ['clienteCpfCnpj', 'clienteNome', 'descricao', 'valor', 'dataEmissao', 'dataVencimento',
              'formaPagamento', 'categoriaNome', 'observacoes'],
    exemplo: [
      ['11.222.333/0001-44', '', 'Venda NF 1234', '1500,00', '2026-04-10', '2026-05-10', 'boleto', 'Vendas', ''],
      ['', 'Cliente Eventual', 'Serviço pontual', '350,00', '2026-04-12', '2026-04-27', 'pix', 'Serviços', '']
    ]
  }
};

// ==================== PARSERS ====================

function parseCSV(text) {
  // Remove BOM
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n').filter(l => l.trim().length > 0);
  if (!lines.length) return { header: [], rows: [] };
  // Detecta separador: ; vs ,
  const primeira = lines[0];
  const sep = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
  const splitLinha = (linha) => {
    const out = [];
    let cur = ''; let inQuote = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (c === '"') { if (inQuote && linha[i+1] === '"') { cur += '"'; i++; } else inQuote = !inQuote; }
      else if (c === sep && !inQuote) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  };
  const header = splitLinha(lines[0]).map(h => h.toLowerCase().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map(l => {
    const cols = splitLinha(l);
    const obj = {};
    header.forEach((h, i) => obj[h] = (cols[i] || '').replace(/^"|"$/g, ''));
    return obj;
  });
  return { header, rows };
}

function parseData(v) {
  if (!v) return null;
  v = String(v).trim();
  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  // DD/MM/YYYY
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function parseValor(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/\s/g, '').replace(/R\$/i, '');
  if (!s) return null;
  // Heurística BR: se tem vírgula, é decimal BR (1.234,56) → remove ponto, vírgula vira ponto
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return parseFloat(s);
}

function so(obj, chaves) {
  const out = {};
  for (const k of chaves) out[k] = obj[k];
  return out;
}

function digits(v) { return String(v || '').replace(/\D/g, ''); }

// ==================== VALIDAÇÃO POR TIPO ====================

function validarLinhas(db, tipo, rows) {
  const spec = TIPOS[tipo];
  if (!spec) throw new Error('Tipo inválido: ' + tipo);

  const validadas = [];
  const cache = { pessoas: new Map(), produtos: new Map(), catCp: new Map(), catCr: new Map() };

  rows.forEach((raw, idx) => {
    const linha = {};
    // normaliza keys do objeto (cabeçalho pode vir em PT com acentos)
    for (const k of Object.keys(raw)) linha[k] = raw[k];
    const result = { indiceOriginal: idx + 2, origem: linha, data: null, erros: [], avisos: [] }; // +2 porque linha 1 é header e 1-based

    switch (tipo) {
      case 'pessoas':        validarPessoa(db, linha, result, cache); break;
      case 'produtos':       validarProduto(db, linha, result, cache); break;
      case 'saldo-produtos': validarSaldoProduto(db, linha, result, cache); break;
      case 'contas-a-pagar': validarContaPagar(db, linha, result, cache); break;
      case 'contas-a-receber': validarContaReceber(db, linha, result, cache); break;
    }
    validadas.push(result);
  });

  return validadas;
}

function validarPessoa(db, l, r, cache) {
  const cpfCnpj = digits(l.cpfcnpj || l.cpfCnpj);
  const razaoSocial = (l.razaosocial || l.razaoSocial || '').trim();
  if (!cpfCnpj) r.erros.push('cpfCnpj obrigatório');
  else if (cpfCnpj.length !== 11 && cpfCnpj.length !== 14) r.erros.push('cpfCnpj deve ter 11 (CPF) ou 14 (CNPJ) dígitos');
  if (!razaoSocial) r.erros.push('razaoSocial obrigatório');

  let tipo = (l.tipo || '').trim().toUpperCase();
  if (!tipo) tipo = cpfCnpj.length === 14 ? 'PJ' : 'PF';
  if (!['PF', 'PJ'].includes(tipo)) r.erros.push('tipo deve ser PF ou PJ');

  if (r.erros.length) return;

  // Verifica se já existe
  const existente = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(cpfCnpj);
  r.data = {
    cpfCnpj, tipo, razaoSocial,
    nomeFantasia: l.nomefantasia || l.nomeFantasia || null,
    email: l.email || null,
    telefone: l.telefone || null,
    endereco: l.endereco || null,
    numero: l.numero || null,
    complemento: l.complemento || null,
    bairro: l.bairro || null,
    cidade: l.cidade || null,
    uf: (l.uf || '').toUpperCase().slice(0, 2) || null,
    cep: digits(l.cep) || null,
    inscricaoEstadual: l.inscricaoestadual || l.inscricaoEstadual || null,
    inscricaoMunicipal: l.inscricaomunicipal || l.inscricaoMunicipal || null,
    observacoes: l.observacoes || null,
    __existente: existente ? existente.id : null
  };
  if (existente) r.avisos.push(`Já existe pessoa #${existente.id} com este CPF/CNPJ — será atualizada`);
}

function validarProduto(db, l, r, cache) {
  const sku = (l.sku || '').trim();
  const descricao = (l.descricao || '').trim();
  if (!sku) r.erros.push('sku obrigatório');
  if (!descricao) r.erros.push('descricao obrigatório');
  if (r.erros.length) return;

  const existente = db.prepare('SELECT id FROM produtos WHERE sku = ?').get(sku);
  r.data = {
    sku, descricao,
    unidade: (l.unidade || 'UN').toUpperCase(),
    precoCusto: parseValor(l.precocusto || l.precoCusto) ?? 0,
    precoVenda: parseValor(l.precovenda || l.precoVenda) ?? 0,
    ncm: digits(l.ncm) || null,
    cfopPadrao: (l.cfoppadrao || l.cfopPadrao || '').trim() || null,
    categoria: l.categoria || null,
    marca: l.marca || null,
    codigoBarras: (l.codigobarras || l.codigoBarras || '').trim() || null,
    estoqueMinimo: parseValor(l.estoqueminimo || l.estoqueMinimo) ?? 0,
    csosn: (l.csosn || '').trim() || null,
    cstPIS: (l.cstpis || l.cstPIS || '').trim() || null,
    cstCOFINS: (l.cstcofins || l.cstCOFINS || '').trim() || null,
    observacoes: l.observacoes || null,
    __existente: existente ? existente.id : null
  };
  if (existente) r.avisos.push(`Já existe produto #${existente.id} com SKU ${sku} — será atualizado`);
}

function validarSaldoProduto(db, l, r, cache) {
  const sku = (l.sku || '').trim();
  const qtd = parseValor(l.quantidade);
  if (!sku) r.erros.push('sku obrigatório');
  if (qtd == null || isNaN(qtd) || qtd <= 0) r.erros.push('quantidade deve ser > 0');
  const produto = sku ? db.prepare('SELECT id, sku, descricao FROM produtos WHERE sku = ?').get(sku) : null;
  if (sku && !produto) r.erros.push(`Produto SKU "${sku}" não existe — cadastre primeiro`);
  if (r.erros.length) return;

  const data = parseData(l.data) || new Date().toISOString().slice(0, 10);
  r.data = {
    produtoId: produto.id,
    produtoDescricao: produto.descricao,
    sku,
    tipo: 'entrada',
    quantidade: qtd,
    custoUnitario: parseValor(l.custounitario || l.custoUnitario) ?? 0,
    data,
    observacao: l.observacao || 'Saldo inicial (importação)'
  };
}

function resolverPessoa(db, cpfCnpj, nome, cache) {
  const cpfC = digits(cpfCnpj);
  if (cpfC) {
    if (cache.pessoas.has(cpfC)) return cache.pessoas.get(cpfC);
    const p = db.prepare('SELECT id, razaoSocial FROM pessoas WHERE cpfCnpj = ?').get(cpfC);
    if (p) { cache.pessoas.set(cpfC, p); return p; }
    return null;
  }
  if (nome) {
    const trimmed = nome.trim();
    if (cache.pessoas.has('nome:' + trimmed)) return cache.pessoas.get('nome:' + trimmed);
    const p = db.prepare('SELECT id, razaoSocial FROM pessoas WHERE LOWER(razaoSocial) = LOWER(?) LIMIT 1').get(trimmed);
    if (p) { cache.pessoas.set('nome:' + trimmed, p); return p; }
  }
  return null;
}

function validarContaPagar(db, l, r, cache) {
  const descricao = (l.descricao || '').trim();
  const valor = parseValor(l.valor);
  const dataEmissao = parseData(l.dataemissao || l.dataEmissao);
  const dataVencimento = parseData(l.datavencimento || l.dataVencimento);
  if (!descricao) r.erros.push('descricao obrigatório');
  if (valor == null || valor <= 0) r.erros.push('valor deve ser > 0');
  if (!dataVencimento) r.erros.push('dataVencimento inválida (use YYYY-MM-DD ou DD/MM/AAAA)');
  if (!dataEmissao && !dataVencimento) r.erros.push('dataEmissao ou dataVencimento obrigatória');

  const fornecedorCpfCnpj = l.fornecedorcpfcnpj || l.fornecedorCpfCnpj;
  const fornecedorNome = l.fornecedornome || l.fornecedorNome;
  const pessoa = resolverPessoa(db, fornecedorCpfCnpj, fornecedorNome, cache);
  let fornecedorId = pessoa ? pessoa.id : null;
  if (!fornecedorId && !fornecedorNome && !fornecedorCpfCnpj) {
    r.avisos.push('Sem fornecedor identificado — será criado placeholder genérico');
  } else if (!pessoa && (fornecedorCpfCnpj || fornecedorNome)) {
    r.avisos.push(`Fornecedor "${fornecedorNome || fornecedorCpfCnpj}" não encontrado — será criado automaticamente`);
  }

  if (r.erros.length) return;

  r.data = {
    fornecedorCpfCnpj: digits(fornecedorCpfCnpj) || null,
    fornecedorNome: fornecedorNome || null,
    fornecedorId,
    descricao, valor,
    dataEmissao: dataEmissao || dataVencimento,
    dataVencimento,
    formaPagamento: (l.formapagamento || l.formaPagamento || '').toLowerCase() || null,
    categoriaNome: l.categorianome || l.categoriaNome || null,
    observacoes: l.observacoes || null
  };
}

function validarContaReceber(db, l, r, cache) {
  const descricao = (l.descricao || '').trim();
  const valor = parseValor(l.valor);
  const dataEmissao = parseData(l.dataemissao || l.dataEmissao);
  const dataVencimento = parseData(l.datavencimento || l.dataVencimento);
  if (!descricao) r.erros.push('descricao obrigatório');
  if (valor == null || valor <= 0) r.erros.push('valor deve ser > 0');
  if (!dataVencimento) r.erros.push('dataVencimento inválida (use YYYY-MM-DD ou DD/MM/AAAA)');

  const clienteCpfCnpj = l.clientecpfcnpj || l.clienteCpfCnpj;
  const clienteNome = l.clientenome || l.clienteNome;
  const pessoa = resolverPessoa(db, clienteCpfCnpj, clienteNome, cache);
  let pessoaId = pessoa ? pessoa.id : null;
  if (!pessoaId && (clienteCpfCnpj || clienteNome)) {
    r.avisos.push(`Cliente "${clienteNome || clienteCpfCnpj}" não encontrado — será criado automaticamente`);
  } else if (!pessoaId) {
    r.erros.push('clienteCpfCnpj ou clienteNome obrigatório');
  }

  if (r.erros.length) return;

  r.data = {
    clienteCpfCnpj: digits(clienteCpfCnpj) || null,
    clienteNome: clienteNome || null,
    pessoaId,
    descricao, valor,
    dataEmissao: dataEmissao || dataVencimento,
    dataVencimento,
    formaPagamento: (l.formapagamento || l.formaPagamento || '').toLowerCase() || null,
    categoriaNome: l.categorianome || l.categoriaNome || null,
    observacoes: l.observacoes || null
  };
}

// ==================== INSERÇÕES ====================

function obterOuCriarPessoa(db, linha) {
  if (linha.pessoaId) return linha.pessoaId;
  if (linha.fornecedorId) return linha.fornecedorId;
  const cpfCnpj = linha.clienteCpfCnpj || linha.fornecedorCpfCnpj || '';
  const nome = linha.clienteNome || linha.fornecedorNome || 'CONTATO IMPORTADO';
  if (cpfCnpj) {
    const existente = db.prepare('SELECT id FROM pessoas WHERE cpfCnpj = ?').get(cpfCnpj);
    if (existente) return existente.id;
    const r = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial) VALUES (?, ?, ?)`)
      .run(cpfCnpj, cpfCnpj.length === 14 ? 'PJ' : 'PF', nome);
    return r.lastInsertRowid;
  }
  // Sem CPF, cria pela razão social — usa um placeholder único
  const cpfPh = 'SEMDOC-' + Date.now() + Math.random().toString(36).slice(2, 6);
  const r = db.prepare(`INSERT INTO pessoas (cpfCnpj, tipo, razaoSocial) VALUES (?, ?, ?)`)
    .run(cpfPh, 'PJ', nome);
  return r.lastInsertRowid;
}

function obterOuCriarCategoriaCP(db, nome) {
  if (!nome) return null;
  const trimmed = nome.trim();
  if (!trimmed) return null;
  const existente = db.prepare('SELECT id FROM categorias_cp WHERE LOWER(nome) = LOWER(?)').get(trimmed);
  if (existente) return existente.id;
  try {
    const r = db.prepare('INSERT INTO categorias_cp (nome) VALUES (?)').run(trimmed);
    return r.lastInsertRowid;
  } catch { return null; }
}

function obterOuCriarCategoriaCR(db, nome) {
  if (!nome) return null;
  const trimmed = nome.trim();
  if (!trimmed) return null;
  const existente = db.prepare('SELECT id FROM categorias_cr WHERE LOWER(nome) = LOWER(?)').get(trimmed);
  if (existente) return existente.id;
  try {
    const r = db.prepare('INSERT INTO categorias_cr (nome) VALUES (?)').run(trimmed);
    return r.lastInsertRowid;
  } catch { return null; }
}

function inserirPessoa(db, d) {
  if (d.__existente) {
    db.prepare(`UPDATE pessoas SET
      tipo = ?, razaoSocial = ?, nomeFantasia = ?, email = ?, telefone = ?,
      endereco = ?, numero = ?, complemento = ?, bairro = ?, cidade = ?, uf = ?, cep = ?,
      inscricaoEstadual = ?, inscricaoMunicipal = ?, observacoes = ?, dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
      d.tipo, d.razaoSocial, d.nomeFantasia, d.email, d.telefone,
      d.endereco, d.numero, d.complemento, d.bairro, d.cidade, d.uf, d.cep,
      d.inscricaoEstadual, d.inscricaoMunicipal, d.observacoes, d.__existente
    );
    return { id: d.__existente, atualizado: true };
  }
  const r = db.prepare(`INSERT INTO pessoas
    (cpfCnpj, tipo, razaoSocial, nomeFantasia, email, telefone,
     endereco, numero, complemento, bairro, cidade, uf, cep, inscricaoEstadual, inscricaoMunicipal, observacoes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    d.cpfCnpj, d.tipo, d.razaoSocial, d.nomeFantasia, d.email, d.telefone,
    d.endereco, d.numero, d.complemento, d.bairro, d.cidade, d.uf, d.cep,
    d.inscricaoEstadual, d.inscricaoMunicipal, d.observacoes
  );
  return { id: r.lastInsertRowid, atualizado: false };
}

function inserirProduto(db, d) {
  if (d.__existente) {
    db.prepare(`UPDATE produtos SET
      descricao = ?, unidade = ?, precoCusto = ?, precoVenda = ?,
      ncm = ?, cfopPadrao = ?, categoria = ?, marca = ?, codigoBarras = ?,
      estoqueMinimo = ?, csosn = ?, cstPIS = ?, cstCOFINS = ?, observacoes = ?,
      dataAtualizacao = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
      d.descricao, d.unidade, d.precoCusto, d.precoVenda,
      d.ncm, d.cfopPadrao, d.categoria, d.marca, d.codigoBarras,
      d.estoqueMinimo, d.csosn, d.cstPIS, d.cstCOFINS, d.observacoes, d.__existente
    );
    return { id: d.__existente, atualizado: true };
  }
  const r = db.prepare(`INSERT INTO produtos
    (sku, descricao, unidade, precoCusto, precoVenda, ncm, cfopPadrao,
     categoria, marca, codigoBarras, estoqueMinimo, csosn, cstPIS, cstCOFINS, observacoes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    d.sku, d.descricao, d.unidade, d.precoCusto, d.precoVenda, d.ncm, d.cfopPadrao,
    d.categoria, d.marca, d.codigoBarras, d.estoqueMinimo, d.csosn, d.cstPIS, d.cstCOFINS, d.observacoes
  );
  return { id: r.lastInsertRowid, atualizado: false };
}

function inserirSaldoProduto(db, d) {
  const ctx = calcularContextoMovimento(db, d.produtoId, 'entrada', d.quantidade, d.custoUnitario);
  const r = db.prepare(`INSERT INTO movimentacoes_estoque
    (produtoId, tipo, quantidade, custoUnitario, origem, observacao, data,
     custoMedioAnterior, custoMedioPosterior, saldoPosterior)
    VALUES (?, 'entrada', ?, ?, 'importacao-saldo-inicial', ?, ?, ?, ?, ?)`).run(
    d.produtoId, d.quantidade, d.custoUnitario, d.observacao, d.data,
    ctx.custoMedioAntes, ctx.custoMedioDepois, ctx.saldoDepois
  );
  return { id: r.lastInsertRowid, atualizado: false, saldoFinal: ctx.saldoDepois };
}

function inserirContaPagar(db, d) {
  const fornecedorId = obterOuCriarPessoa(db, d);
  const categoriaId = obterOuCriarCategoriaCP(db, d.categoriaNome);
  const r = db.prepare(`INSERT INTO contas_a_pagar
    (fornecedorId, descricao, valor, dataEmissao, dataVencimento, formaPagamento, categoriaId, observacoes, origem, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'importacao', 'aberta')`).run(
    fornecedorId, d.descricao, d.valor, d.dataEmissao, d.dataVencimento,
    d.formaPagamento, categoriaId, d.observacoes
  );
  return { id: r.lastInsertRowid, atualizado: false };
}

function inserirContaReceber(db, d) {
  const pessoaId = d.pessoaId || obterOuCriarPessoa(db, d);
  // Linha com forma que o cliente não aceita vira erro daquela linha — o
  // confirmar já isola cada inserter num try e segue com as demais.
  assertMeioPermitido(db, pessoaId, d.formaPagamento);
  const categoriaId = obterOuCriarCategoriaCR(db, d.categoriaNome);
  const r = db.prepare(`INSERT INTO contas_a_receber
    (pessoaId, descricao, valor, dataEmissao, dataVencimento, formaPagamento, categoriaId, observacoes, origem, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'importacao', 'aberta')`).run(
    pessoaId, d.descricao, d.valor, d.dataEmissao, d.dataVencimento,
    d.formaPagamento, categoriaId, d.observacoes
  );
  return { id: r.lastInsertRowid, atualizado: false };
}

const INSERTERS = {
  'pessoas': inserirPessoa,
  'produtos': inserirProduto,
  'saldo-produtos': inserirSaldoProduto,
  'contas-a-pagar': inserirContaPagar,
  'contas-a-receber': inserirContaReceber
};

// ==================== ROTAS ====================

function registrarRotas(app, db) {
  app.get('/api/importacao/tipos', (req, res) => {
    const tipos = Object.entries(TIPOS).map(([k, v]) => ({ id: k, titulo: v.titulo, colunas: v.colunas }));
    res.json({ success: true, tipos });
  });

  app.get('/api/importacao/template/:tipo', (req, res) => {
    const spec = TIPOS[req.params.tipo];
    if (!spec) return res.status(404).json({ success: false, error: 'Tipo desconhecido' });
    const linhas = [spec.colunas.join(';'), ...spec.exemplo.map(e => e.join(';'))];
    const csv = '\uFEFF' + linhas.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="template-${req.params.tipo}.csv"`);
    res.send(csv);
  });

  app.post('/api/importacao/preview', upload.single('arquivo'), reentrarContextoTenant, (req, res) => {
    try {
      const tipo = req.body?.tipo || req.query?.tipo;
      if (!tipo || !TIPOS[tipo]) return res.status(400).json({ success: false, error: 'tipo obrigatório: ' + Object.keys(TIPOS).join(', ') });
      if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo CSV obrigatório (campo "arquivo")' });

      const texto = req.file.buffer.toString('utf-8');
      const parsed = parseCSV(texto);
      if (!parsed.header.length) return res.status(400).json({ success: false, error: 'CSV vazio ou sem cabeçalho' });

      const linhas = validarLinhas(db, tipo, parsed.rows);
      const totais = {
        total: linhas.length,
        validas: linhas.filter(l => l.erros.length === 0).length,
        comErros: linhas.filter(l => l.erros.length > 0).length,
        comAvisos: linhas.filter(l => l.avisos.length > 0 && l.erros.length === 0).length
      };
      res.json({ success: true, tipo, cabecalhoLido: parsed.header, linhas, totais });
    } catch (err) {
      console.error('[importacao preview]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/importacao/confirmar', (req, res) => {
    try {
      const { tipo, linhas } = req.body || {};
      if (!tipo || !TIPOS[tipo]) return res.status(400).json({ success: false, error: 'tipo inválido' });
      if (!Array.isArray(linhas) || !linhas.length) return res.status(400).json({ success: false, error: 'linhas obrigatório' });
      const inserter = INSERTERS[tipo];

      const resultados = [];
      const tx = db.transaction(() => {
        for (const item of linhas) {
          if (!item.data || (item.erros && item.erros.length)) {
            resultados.push({ indiceOriginal: item.indiceOriginal, status: 'pulada', motivo: 'Erros na validação' });
            continue;
          }
          try {
            const r = inserter(db, item.data);
            resultados.push({ indiceOriginal: item.indiceOriginal, status: r.atualizado ? 'atualizada' : 'inserida', id: r.id });
          } catch (e) {
            resultados.push({ indiceOriginal: item.indiceOriginal, status: 'erro', erro: e.message });
          }
        }
      });
      tx();

      const resumo = {
        inseridas: resultados.filter(r => r.status === 'inserida').length,
        atualizadas: resultados.filter(r => r.status === 'atualizada').length,
        puladas: resultados.filter(r => r.status === 'pulada').length,
        erros: resultados.filter(r => r.status === 'erro').length
      };
      res.json({ success: true, resumo, resultados });
    } catch (err) {
      console.error('[importacao confirmar]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[importacao] Rotas registradas');
}

module.exports = { registrarRotasImportacao: registrarRotas };
