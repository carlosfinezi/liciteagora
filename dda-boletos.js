/**
 * dda-boletos.js — caixa de entrada de boletos a pagar.
 *
 * Duas portas para o mesmo lugar:
 *   - DDA: a lista que o banco disponibiliza dos boletos emitidos contra o
 *     CNPJ da empresa. Entra por importação (arquivo/lista do banco) ou por
 *     API, quando houver credencial.
 *   - Manual: alguém cola a linha digitável do boleto que chegou por e-mail.
 *
 * Os dois caem na mesma fila, com a mesma validação e a mesma deduplicação —
 * senão o boleto que veio pelo DDA e o que o fornecedor mandou por e-mail
 * viram dois pagamentos do mesmo título.
 */

const B = require('./boleto-pagamento');

const STATUS = ['novo', 'vinculado', 'ignorado', 'pago'];

/**
 * Acha o código dentro de uma linha que veio com outras colunas.
 * "CONCESSIONARIA X;R$ 120,50;10/08/2026;23793381286000782713695000063305412345678901234"
 * precisa virar só os dígitos do boleto — senão a importação em lote exige
 * limpar cada linha à mão, que é o trabalho que ela deveria poupar.
 */
function extrairCodigos(texto) {
  const t = String(texto || '');
  // Formato impresso: dígitos separados por ponto e espaço. Junta tudo primeiro.
  const tudo = t.replace(/\D/g, '');
  if ([44, 47, 48].includes(tudo.length)) return [tudo];
  // Linha com outras colunas (ou vários códigos na mesma linha): pega todas as
  // sequências com tamanho de código de barras, tolerando ponto e espaço.
  const achados = (t.match(/[\d][\d.\s]{40,70}[\d]/g) || [])
    .map(x => x.replace(/\D/g, ''))
    .filter(x => [44, 47, 48].includes(x.length));
  return achados;
}

/** Compatibilidade: o primeiro código encontrado, ou os dígitos crus. */
function extrairCodigo(texto) {
  const achados = extrairCodigos(texto);
  return achados[0] || String(texto || '').replace(/\D/g, '');
}

function migrarDdaDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dda_boletos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigoBarras TEXT NOT NULL UNIQUE,
      linhaDigitavel TEXT,
      tipo TEXT NOT NULL DEFAULT 'cobranca',
      banco TEXT,
      bancoNome TEXT,
      valor REAL,
      valorEmAberto INTEGER DEFAULT 0,
      vencimento TEXT,
      beneficiarioNome TEXT,
      beneficiarioCnpj TEXT,
      origem TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'novo',
      contaPagarId INTEGER,
      observacao TEXT,
      dataImportacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaPagarId) REFERENCES contas_a_pagar(id)
    );
    CREATE INDEX IF NOT EXISTS idx_dda_status ON dda_boletos(status, vencimento);
  `);
  // Tabela ausente = tenant sem o módulo (há quem tenha contas a pagar sem
  // tesouraria). Coluna repetida = já aplicado. Só isso é tolerado.
  const alter = (sql) => {
    try { db.exec(sql); }
    catch (e) { if (!/duplicate column|no such table/i.test(e.message)) throw e; }
  };
  // O título passa a guardar o boleto: sem isso o pagamento sai do lote sem
  // saber qual código de barras usar.
  alter('ALTER TABLE contas_a_pagar ADD COLUMN linhaDigitavel TEXT');
  alter('ALTER TABLE contas_a_pagar ADD COLUMN codigoBarras TEXT');
  alter('ALTER TABLE lote_pagamento_itens ADD COLUMN linhaDigitavel TEXT');
  alter('ALTER TABLE lote_pagamento_itens ADD COLUMN codigoBarras TEXT');
}

/**
 * Casa o boleto com um título já lançado. Valor e vencimento iguais é forte;
 * só o valor é fraco e vai como sugestão, nunca como vínculo automático —
 * amarrar no título errado faz pagar a conta de outro fornecedor.
 */
function sugerirContaPagar(db, boleto) {
  const centavos = (v) => Math.round(Number(v || 0) * 100);
  if (!(boleto.valor > 0)) return { exatos: [], provaveis: [] };
  let abertos = [];
  try {
    abertos = db.prepare(`SELECT cp.id, cp.descricao, cp.valor, cp.dataVencimento, cp.fornecedorId,
        f.razaoSocial AS fornecedorNome, cp.linhaDigitavel
      FROM contas_a_pagar cp LEFT JOIN pessoas f ON f.id = cp.fornecedorId
      WHERE cp.status IN ('aberta','parcial')`).all();
  } catch { return { exatos: [], provaveis: [] }; }

  const mesmoValor = abertos.filter(c => centavos(c.valor) === centavos(boleto.valor));
  const exatos = boleto.vencimento
    ? mesmoValor.filter(c => String(c.dataVencimento || '').slice(0, 10) === boleto.vencimento)
    : [];
  const provaveis = mesmoValor.filter(c => !exatos.includes(c));
  return { exatos, provaveis };
}

/**
 * Entrada de boletos, venham do DDA ou da mão.
 * Cada linha é independente: uma inválida não derruba o lote inteiro, e o
 * motivo volta linha a linha para quem colou saber qual corrigir.
 */
function importarBoletos(db, entradas, { origem = 'manual', referencia = new Date() } = {}) {
  const novos = [], duplicados = [], invalidos = [];
  const ins = db.prepare(`INSERT INTO dda_boletos
      (codigoBarras, linhaDigitavel, tipo, banco, bancoNome, valor, valorEmAberto,
       vencimento, beneficiarioNome, beneficiarioCnpj, origem, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo')`);

  for (const bruto of entradas) {
    const cru = typeof bruto === 'string' ? bruto : (bruto.linhaDigitavel || bruto.codigoBarras || '');
    const extra = typeof bruto === 'string' ? {} : bruto;
    // Quem exporta a lista do banco ou do app cola a linha inteira, com
    // beneficiário e valor em volta. Extrair o código do meio do texto evita
    // obrigar a limpeza manual de dezenas de linhas.
    const texto = extrairCodigo(cru);
    const lido = B.lerBoleto(texto, { referencia });

    if (!lido.valido) {
      invalidos.push({ entrada: String(texto).slice(0, 60), erros: lido.erros });
      continue;
    }
    const jaTem = db.prepare('SELECT id, status FROM dda_boletos WHERE codigoBarras = ?').get(lido.codigoBarras);
    if (jaTem) { duplicados.push({ id: jaTem.id, codigoBarras: lido.codigoBarras, status: jaTem.status }); continue; }

    const id = ins.run(lido.codigoBarras, lido.linhaDigitavel || null, lido.tipo,
      lido.banco || null, B.nomeBanco(lido.banco),
      // Valor do arquivo do DDA prevalece quando o código não traz valor
      // (arrecadação com identificador de referência).
      lido.valor != null ? lido.valor : (extra.valor != null ? Number(extra.valor) : null),
      lido.valorEmAberto ? 1 : 0,
      lido.vencimento || extra.vencimento || null,
      extra.beneficiarioNome || null, extra.beneficiarioCnpj || null,
      origem).lastInsertRowid;

    const salvo = db.prepare('SELECT * FROM dda_boletos WHERE id = ?').get(id);
    novos.push({ ...salvo, sugestoes: sugerirContaPagar(db, salvo) });
  }
  return { novos, duplicados, invalidos };
}

/** Amarra o boleto a um título existente, ou cria o título a partir dele. */
function vincular(db, ddaId, { contaPagarId = null, criar = null, usuario = null } = {}) {
  const b = db.prepare('SELECT * FROM dda_boletos WHERE id = ?').get(ddaId);
  if (!b) throw new Error('Boleto não encontrado');
  if (b.status === 'pago') throw new Error('Boleto já pago');

  let cpId = contaPagarId ? Number(contaPagarId) : null;
  if (cpId) {
    const cp = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(cpId);
    if (!cp) throw new Error('Título não encontrado');
    if (!['aberta', 'parcial'].includes(cp.status)) throw new Error(`Título com status ${cp.status}`);
    // Um título com outro boleto já amarrado quase sempre é engano de escolha.
    if (cp.codigoBarras && cp.codigoBarras !== b.codigoBarras) {
      throw new Error('Este título já tem outro boleto vinculado');
    }
  } else {
    if (!criar) throw new Error('Informe contaPagarId ou os dados para criar o título');
    if (!(Number(b.valor) > 0) && !(Number(criar.valor) > 0)) {
      throw new Error('Boleto sem valor no código de barras — informe o valor para criar o título');
    }
    const venc = b.vencimento || criar.dataVencimento;
    if (!venc) throw new Error('Boleto sem vencimento — informe a data para criar o título');
    cpId = db.prepare(`INSERT INTO contas_a_pagar
      (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem,
       categoriaId, linhaDigitavel, codigoBarras)
      VALUES (?, ?, ?, DATE('now','-3 hours'), ?, 'aberta', 'dda', ?, ?, ?)`).run(
      criar.fornecedorId || null,
      criar.descricao || `Boleto ${b.bancoNome || b.banco || ''} venc. ${venc}`.trim(),
      Number(b.valor > 0 ? b.valor : criar.valor), venc,
      criar.categoriaId || null, b.linhaDigitavel, b.codigoBarras).lastInsertRowid;
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE contas_a_pagar SET linhaDigitavel = COALESCE(linhaDigitavel, ?),
        codigoBarras = COALESCE(codigoBarras, ?), dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(b.linhaDigitavel, b.codigoBarras, cpId);
    db.prepare(`UPDATE dda_boletos SET status = 'vinculado', contaPagarId = ? WHERE id = ?`).run(cpId, b.id);
  });
  tx();
  return { ddaId: b.id, contaPagarId: cpId };
}

module.exports = { STATUS, extrairCodigo, extrairCodigos, migrarDdaDB, sugerirContaPagar, importarBoletos, vincular };
