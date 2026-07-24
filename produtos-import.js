/**
 * produtos-import.js — Parse + validação + commit de importação XLSX/CSV de produtos.
 *
 * Exporta:
 *   - parsePlanilha(buffer)
 *   - validarLinhas(db, linhas)   → { validas, erros, avisos, duplicatasSku }
 *   - executarImport(db, buffer, politica) → { inseridos, atualizados, pulados, fornecedoresCriados, erros }
 *   - gerarTemplate() → Buffer
 */

const XLSX = require('xlsx');

const TIPOS_SEFAZ = new Set(['00','01','02','03','04','05','06','07','99']);
const ORIGENS_SEFAZ = new Set(['0','1','2','3','4','5','6','7']);

const CAMPOS = [
  'sku','codigoInterno','referenciaInterna','codigoBarras','descricao','categoria','marca',
  'tipoProduto','unidade','precoCusto','markupMinimo','precoMinimoVenda','markupVenda','precoVenda',
  'estoqueMinimo','pesoBruto','pesoLiquido','validadeDias','ncm','cest','cfopPadrao','origem',
  'icmsAliquota','codigoFCI','escalaRelevante','observacoes','fornecedorCnpj','fornecedorRazaoSocial'
];

const CAMPOS_NUMERICOS = new Set([
  'precoCusto','markupMinimo','precoMinimoVenda','markupVenda','precoVenda',
  'estoqueMinimo','pesoBruto','pesoLiquido','icmsAliquota'
]);
const CAMPOS_INTEIROS = new Set(['validadeDias']);

// Sinônimos — cabeçalhos comuns que mapeiam para nomes canônicos.
// Chaves em minúsculas, sem acento, sem espaços extras.
const SINONIMOS = {
  'codigo':'sku', 'código':'sku', 'cod':'sku',
  'codigointerno':'codigoInterno', 'codigo interno':'codigoInterno',
  'referencia':'referenciaInterna', 'referência':'referenciaInterna',
  'referenciainterna':'referenciaInterna',
  'codigobarras':'codigoBarras', 'ean':'codigoBarras', 'gtin':'codigoBarras',
  'descricao':'descricao', 'descrição':'descricao', 'nome':'descricao',
  'categoria':'categoria',
  'marca':'marca',
  'tipo':'tipoProduto', 'tipoproduto':'tipoProduto', 'tipo produto':'tipoProduto',
  'unidade':'unidade', 'un':'unidade', 'um':'unidade',
  'precocusto':'precoCusto', 'preco de custo':'precoCusto', 'preço de custo':'precoCusto', 'custo':'precoCusto',
  'markupminimo':'markupMinimo', 'markup minimo':'markupMinimo', 'markup mínimo':'markupMinimo',
  'precominimovenda':'precoMinimoVenda', 'preco minimo venda':'precoMinimoVenda', 'preço mínimo venda':'precoMinimoVenda',
  'preco minimo de venda':'precoMinimoVenda', 'preço mínimo de venda':'precoMinimoVenda',
  'markupvenda':'markupVenda', 'markup venda':'markupVenda', 'markup de venda':'markupVenda',
  'precovenda':'precoVenda', 'preco de venda':'precoVenda', 'preço de venda':'precoVenda', 'venda':'precoVenda',
  'estoqueminimo':'estoqueMinimo', 'estoque minimo':'estoqueMinimo', 'estoque mínimo':'estoqueMinimo',
  'pesobruto':'pesoBruto', 'peso bruto':'pesoBruto',
  'pesoliquido':'pesoLiquido', 'peso liquido':'pesoLiquido', 'peso líquido':'pesoLiquido',
  'validadedias':'validadeDias', 'validade':'validadeDias', 'validade em dias':'validadeDias',
  'ncm':'ncm', 'cest':'cest', 'cfop':'cfopPadrao', 'cfoppadrao':'cfopPadrao',
  'origem':'origem',
  'icmsaliquota':'icmsAliquota', 'aliquotaicms':'icmsAliquota', 'aliquota icms':'icmsAliquota', 'icms':'icmsAliquota',
  'codigofci':'codigoFCI', 'codigo fci':'codigoFCI', 'fci':'codigoFCI',
  'escalarelevante':'escalaRelevante', 'escala relevante':'escalaRelevante',
  'observacoes':'observacoes', 'observações':'observacoes', 'obs':'observacoes',
  'fornecedorcnpj':'fornecedorCnpj', 'cnpjfornecedor':'fornecedorCnpj',
  'cnpj fornecedor':'fornecedorCnpj', 'cnpj do fornecedor':'fornecedorCnpj',
  'fornecedorrazaosocial':'fornecedorRazaoSocial', 'fornecedor':'fornecedorRazaoSocial',
  'razao social fornecedor':'fornecedorRazaoSocial',
};

function normalizarChave(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().replace(/\s+/g, ' ');
}

function mapearCabecalho(headerRaw) {
  const k = normalizarChave(headerRaw);
  if (SINONIMOS[k]) return SINONIMOS[k];
  // Se bate com um campo canônico direto (já camelCase), aceita também
  const camel = CAMPOS.find(c => normalizarChave(c) === k || c.toLowerCase() === k);
  return camel || null;
}

function parseNumero(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isNaN(n) ? null : n;
}

function parseBool(v) {
  if (v == null || v === '') return 0;
  const s = String(v).trim().toLowerCase();
  if (['1','sim','s','true','x','yes','y'].includes(s)) return 1;
  return 0;
}

function onlyDigits(s) { return String(s || '').replace(/\D/g, ''); }

function parsePlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellText: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('Planilha vazia');
  const sheet = wb.Sheets[sheetName];
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false });
  if (!aoa.length) return { cabecalhos: [], mapeamento: {}, linhas: [] };

  const headerRow = aoa[0];
  const mapeamento = {}; // colIndex → canonical key
  const cabecalhos = [];
  headerRow.forEach((h, i) => {
    const canon = mapearCabecalho(h);
    cabecalhos.push({ original: String(h || '').trim(), canonico: canon });
    if (canon) mapeamento[i] = canon;
  });

  const linhas = [];
  for (let r = 1; r < aoa.length; r++) {
    const row = aoa[r];
    if (!row || row.every(c => c === '' || c == null)) continue;
    const obj = {};
    for (const [idx, key] of Object.entries(mapeamento)) {
      const raw = row[Number(idx)];
      obj[key] = raw == null ? '' : raw;
    }
    linhas.push({ numeroLinha: r + 1, dados: obj });
  }
  return { cabecalhos, mapeamento, linhas };
}

function validarLinha(raw) {
  const erros = [];
  const avisos = [];
  const produto = {};

  const sku = String(raw.sku || '').trim();
  const descricao = String(raw.descricao || '').trim();
  if (!sku) erros.push('sku obrigatório');
  if (!descricao) erros.push('descricao obrigatória');

  for (const c of CAMPOS) {
    if (c === 'sku') { if (sku) produto.sku = sku; continue; }
    if (c === 'descricao') { if (descricao) produto.descricao = descricao; continue; }
    if (c === 'escalaRelevante') {
      produto.escalaRelevante = parseBool(raw.escalaRelevante);
      continue;
    }
    if (c === 'fornecedorCnpj') {
      const digits = onlyDigits(raw.fornecedorCnpj);
      if (digits) {
        if (digits.length !== 11 && digits.length !== 14) {
          erros.push('fornecedorCnpj deve ter 11 ou 14 dígitos');
        } else {
          produto.fornecedorCnpj = digits;
        }
      }
      continue;
    }
    if (c === 'fornecedorRazaoSocial') {
      if (raw.fornecedorRazaoSocial) produto.fornecedorRazaoSocial = String(raw.fornecedorRazaoSocial).trim();
      continue;
    }
    const v = raw[c];
    if (v === undefined || v === null || v === '') continue;
    if (CAMPOS_NUMERICOS.has(c)) {
      const n = parseNumero(v);
      if (n == null) { erros.push(`${c}: valor inválido "${v}"`); continue; }
      produto[c] = n;
    } else if (CAMPOS_INTEIROS.has(c)) {
      const n = parseNumero(v);
      if (n == null || !Number.isFinite(n)) { erros.push(`${c}: inteiro inválido "${v}"`); continue; }
      produto[c] = Math.round(n);
    } else if (c === 'tipoProduto') {
      const s = String(v).trim().padStart(2, '0');
      if (!TIPOS_SEFAZ.has(s)) { erros.push(`tipoProduto inválido "${v}" (aceitos: 00..07, 99)`); continue; }
      produto.tipoProduto = s;
    } else if (c === 'origem') {
      const s = String(v).trim();
      if (!ORIGENS_SEFAZ.has(s)) { erros.push(`origem inválida "${v}" (aceitos: 0..7)`); continue; }
      produto.origem = s;
    } else if (c === 'ncm') {
      const s = onlyDigits(v);
      if (s.length && s.length !== 8) avisos.push(`ncm "${v}" não tem 8 dígitos`);
      produto.ncm = s || String(v).trim();
    } else {
      produto[c] = String(v).trim();
    }
  }

  if (produto.fornecedorCnpj && !produto.fornecedorRazaoSocial) {
    // Se for novo fornecedor, precisa de razão social — só sabemos "novo" consultando o DB.
    // Aqui deixamos passar; validarLinhas(db,...) confere e transforma em erro se preciso.
  }

  if (produto.precoMinimoVenda != null && produto.precoVenda != null &&
      produto.precoVenda > 0 && produto.precoVenda < produto.precoMinimoVenda) {
    avisos.push(`precoVenda (${produto.precoVenda}) abaixo de precoMinimoVenda (${produto.precoMinimoVenda})`);
  }

  return { produto, erros, avisos };
}

function validarLinhas(db, linhas) {
  const validas = [];
  const erros = [];
  const avisos = [];
  const duplicatasSku = [];
  const stmtSkuExiste = db.prepare('SELECT id FROM produtos WHERE sku = ?');
  const stmtFornecedorExiste = db.prepare('SELECT id FROM fornecedores WHERE cpfCnpj = ?');

  for (const { numeroLinha, dados } of linhas) {
    const { produto, erros: errLinha, avisos: warnLinha } = validarLinha(dados);
    const todosErros = [...errLinha];

    if (produto.fornecedorCnpj) {
      const exist = stmtFornecedorExiste.get(produto.fornecedorCnpj);
      if (!exist && !produto.fornecedorRazaoSocial) {
        todosErros.push('fornecedorCnpj não cadastrado — informe fornecedorRazaoSocial para criar');
      }
    }

    if (todosErros.length) {
      erros.push({ linha: numeroLinha, sku: produto.sku, mensagem: todosErros.join('; ') });
      continue;
    }
    if (warnLinha.length) {
      avisos.push({ linha: numeroLinha, sku: produto.sku, mensagem: warnLinha.join('; ') });
    }
    if (produto.sku && stmtSkuExiste.get(produto.sku)) {
      duplicatasSku.push(produto.sku);
    }
    validas.push({ linha: numeroLinha, produto });
  }

  return { totalLinhas: linhas.length, validas, erros, avisos, duplicatasSku };
}

function executarImport(db, buffer, politicaDuplicata = 'atualizar') {
  const { linhas } = parsePlanilha(buffer);
  const { validas, erros: errosValidacao } = validarLinhas(db, linhas);

  const stmtGetBySku = db.prepare('SELECT * FROM produtos WHERE sku = ?');
  const stmtGetForn = db.prepare('SELECT id FROM fornecedores WHERE cpfCnpj = ?');
  const stmtInsertForn = db.prepare(
    `INSERT INTO fornecedores (cpfCnpj, tipo, razaoSocial) VALUES (?, ?, ?)`
  );

  const CAMPOS_INSERT = [
    'sku','codigoInterno','referenciaInterna','codigoBarras','descricao','categoria','marca',
    'tipoProduto','unidade','precoCusto','markupMinimo','precoMinimoVenda','markupVenda','precoVenda',
    'estoqueMinimo','pesoBruto','pesoLiquido','validadeDias','ncm','cest','cfopPadrao','origem',
    'icmsAliquota','codigoFCI','escalaRelevante','observacoes','fornecedorId'
  ];

  function resolverFornecedorId(produto) {
    if (!produto.fornecedorCnpj) return null;
    const exist = stmtGetForn.get(produto.fornecedorCnpj);
    if (exist) return exist.id;
    const tipo = produto.fornecedorCnpj.length <= 11 ? 'PF' : 'PJ';
    return stmtInsertForn.run(
      produto.fornecedorCnpj, tipo, produto.fornecedorRazaoSocial || 'Importado via planilha'
    ).lastInsertRowid;
  }

  let inseridos = 0, atualizados = 0, pulados = 0, fornecedoresCriados = 0;
  const errosCommit = [];

  const fornecedoresAntes = db.prepare('SELECT COUNT(*) AS n FROM fornecedores').get().n;

  const tx = db.transaction((items) => {
    for (const { linha, produto } of items) {
      try {
        const fornecedorId = resolverFornecedorId(produto);
        const rowData = { ...produto, fornecedorId };

        const existente = stmtGetBySku.get(produto.sku);
        if (existente) {
          if (politicaDuplicata === 'pular') { pulados++; continue; }
          // atualizar
          const sets = [];
          const vals = [];
          for (const c of CAMPOS_INSERT) {
            if (c === 'sku') continue;
            if (rowData[c] === undefined) continue;
            sets.push(`${c} = ?`);
            vals.push(rowData[c] == null ? null : rowData[c]);
          }
          if (sets.length) {
            sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
            vals.push(existente.id);
            db.prepare(`UPDATE produtos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
          }
          atualizados++;
        } else {
          const cols = [];
          const vals = [];
          for (const c of CAMPOS_INSERT) {
            if (rowData[c] === undefined) continue;
            cols.push(c);
            vals.push(rowData[c] == null ? null : rowData[c]);
          }
          const placeholders = cols.map(() => '?').join(',');
          db.prepare(`INSERT INTO produtos (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
          inseridos++;
        }
      } catch (err) {
        errosCommit.push({ linha, sku: produto.sku, mensagem: err.message });
      }
    }
  });
  tx(validas);

  const fornecedoresDepois = db.prepare('SELECT COUNT(*) AS n FROM fornecedores').get().n;
  fornecedoresCriados = fornecedoresDepois - fornecedoresAntes;

  return {
    inseridos, atualizados, pulados, fornecedoresCriados,
    erros: [...errosValidacao, ...errosCommit],
    totalLinhas: linhas.length,
    politicaDuplicata
  };
}

function gerarTemplate() {
  const header = [
    'sku','codigoInterno','referenciaInterna','codigoBarras','descricao','categoria','marca',
    'tipoProduto','unidade','precoCusto','markupMinimo','precoMinimoVenda','markupVenda','precoVenda',
    'estoqueMinimo','pesoBruto','pesoLiquido','validadeDias','ncm','cest','cfopPadrao','origem',
    'icmsAliquota','codigoFCI','escalaRelevante','observacoes','fornecedorCnpj','fornecedorRazaoSocial'
  ];
  const exemplo = [
    'SKU-001','INT-100','REF-A','7891234567890','Produto Exemplo','Material de Escritório','Marca X',
    '00','UN','10.00','20','12.00','30','13.00',
    '5','0.5','0.4','','12345678','','5102','0',
    '18','','NAO','Produto de demonstração','12345678000199','Fornecedor Exemplo LTDA'
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header, exemplo]);
  XLSX.utils.book_append_sheet(wb, ws, 'Produtos');

  const instr = [
    ['Instruções de Importação'],
    [''],
    ['Campos obrigatórios: sku, descricao.'],
    ['SKU é a chave única — se já existir, pode ser atualizado ou pulado (escolha na tela).'],
    [''],
    ['Tipo Produto (SEFAZ):'],
    ['00 - Mercadoria para revenda'],
    ['01 - Matéria-prima'],
    ['02 - Embalagem'],
    ['03 - Produto em processo'],
    ['04 - Produto acabado'],
    ['05 - Subproduto'],
    ['06 - Produto intermediário'],
    ['07 - Material de uso e consumo'],
    ['99 - Outros'],
    [''],
    ['Origem (SEFAZ):'],
    ['0 - Nacional'],
    ['1 - Estrangeira, importação direta'],
    ['2 - Estrangeira, mercado interno'],
    ['3 - Nacional, conteúdo importado > 40%'],
    ['4 - Nacional, PPB'],
    ['5 - Nacional, conteúdo importado ≤ 40%'],
    ['6 - Estrangeira, importação direta, sem similar nacional'],
    ['7 - Estrangeira, mercado interno, sem similar nacional'],
    [''],
    ['escalaRelevante: SIM ou NAO (ou 1/0)'],
    [''],
    ['Fornecedor:'],
    ['- Informe fornecedorCnpj (11 ou 14 dígitos, só números ou com máscara).'],
    ['- Se o CNPJ não estiver cadastrado, informe também fornecedorRazaoSocial e ele será criado automaticamente.'],
    [''],
    ['Valores numéricos aceitam vírgula ou ponto como separador decimal (ex: 12,50 ou 12.50).'],
  ];
  const wsI = XLSX.utils.aoa_to_sheet(instr);
  XLSX.utils.book_append_sheet(wb, wsI, 'Instruções');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parsePlanilha, validarLinhas, executarImport, gerarTemplate };
