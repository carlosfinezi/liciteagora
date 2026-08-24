/**
 * tesouraria-routes.js — Item 2.4:
 *  - Lotes de pagamento de CP (manual ou PIX via Asaas transfers);
 *  - Regras de conciliação OFX (ignorar/categorizar por padrão de texto);
 *  - Agenda de recebíveis de cartão (previsto × extrato).
 *
 * Alçada: consultada no PROCESSAR (momento em que o dinheiro sai) — uma
 * aprovação por CP, consumida no uso (mesma semântica da baixa manual).
 * Asaas: transferência criada no processar; a BAIXA do CP acontece no
 * /confirmar (manual v1 — automação por webhook fica para refinamento).
 */

const { logAction } = require('./audit-log');
const boleto = require('./boleto-pagamento');
const dda = require('./dda-boletos');
const { lancarMovimentacao } = require('./contas-financeiras-routes');
const { escopoSql, escopoSqlHerdado, guardEscopo, noEscopo } = require('./estabelecimentos-routes');
const { verificarAlcada } = require('./governanca-routes');
const { garantirFornecedor, chavePixDe, guardarChavePix } = require('./pessoas-fornecedor');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function migrarTesourariaDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lotes_pagamento (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      contaFinanceiraId INTEGER NOT NULL,
      provedor TEXT NOT NULL DEFAULT 'manual',
      status TEXT NOT NULL DEFAULT 'rascunho',
      dataAgendada TEXT,
      valorTotal REAL DEFAULT 0,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS lote_pagamento_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      loteId INTEGER NOT NULL,
      contaPagarId INTEGER NOT NULL,
      formaPagamento TEXT NOT NULL DEFAULT 'pix',
      chavePix TEXT,
      valor REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      provedorRef TEXT,
      erroMensagem TEXT,
      pagamentoId INTEGER,
      FOREIGN KEY (loteId) REFERENCES lotes_pagamento(id),
      FOREIGN KEY (contaPagarId) REFERENCES contas_a_pagar(id)
    );
    CREATE INDEX IF NOT EXISTS idx_lotepag_lote ON lote_pagamento_itens(loteId);

    CREATE TABLE IF NOT EXISTS conciliacao_regras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contaFinanceiraId INTEGER,
      padraoTexto TEXT NOT NULL,
      tipoLancamento TEXT NOT NULL DEFAULT 'ambos',
      acao TEXT NOT NULL DEFAULT 'categorizar',
      categoria TEXT,
      prioridade INTEGER DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS agenda_recebiveis_cartao (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parcelaId INTEGER UNIQUE,
      pedidoId INTEGER,
      adquirenteId INTEGER,
      valorBruto REAL NOT NULL,
      taxa REAL DEFAULT 0,
      valorLiquido REAL NOT NULL,
      dataVenda TEXT,
      dataPrevistaLiquidacao TEXT,
      status TEXT NOT NULL DEFAULT 'previsto',
      transacaoBancariaId INTEGER,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_agcartao_status ON agenda_recebiveis_cartao(status);
  `);
  alterSafe(db, 'ALTER TABLE transacoes_bancarias ADD COLUMN categoriaSugerida TEXT');
  alterSafe(db, 'ALTER TABLE transacoes_bancarias ADD COLUMN regraAplicadaId INTEGER');
}

function proximoNumeroLote(db) {
  const ano = new Date().getFullYear();
  const prefixo = `LP-${ano}-`;
  const ult = db.prepare('SELECT numero FROM lotes_pagamento WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefixo + '%');
  const seq = ult ? parseInt(ult.numero.slice(prefixo.length), 10) + 1 : 1;
  return prefixo + String(seq).padStart(4, '0');
}

function saldoAbertoCP(db, contaPagarId) {
  const conta = db.prepare('SELECT * FROM contas_a_pagar WHERE id = ?').get(contaPagarId);
  if (!conta) return { conta: null };
  const pago = Number(db.prepare(`SELECT COALESCE(SUM(valorBase),0) t FROM contas_pagar_pagamentos
    WHERE contaPagarId = ? AND estornado = 0`).get(contaPagarId).t) || 0;
  return { conta, pago, saldo: Number((conta.valor - pago).toFixed(2)) };
}

// Baixa efetiva de um item do lote: pagamento + movimentação + status do CP.
function baixarItemLote(db, lote, item, usuario) {
  const { conta, pago, saldo } = saldoAbertoCP(db, item.contaPagarId);
  if (!conta || !['aberta', 'parcial'].includes(conta.status)) {
    throw new Error(`CP #${item.contaPagarId} não está aberta (${conta?.status})`);
  }
  const v = Math.min(item.valor, saldo);
  const dp = dataBrasilia();
  const movId = lancarMovimentacao(db, {
    contaId: lote.contaFinanceiraId, tipo: 'saida', valor: v, data: dp,
    descricao: `Lote ${lote.numero}: ${conta.descricao}`,
    origem: 'lote_pagamento', origemId: lote.id, usuario
  });
  // contas_pagar_pagamentos não tem coluna origem (diferente da de CR) —
  // a origem fica registrada em observacoes.
  const rp = db.prepare(`INSERT INTO contas_pagar_pagamentos
    (contaPagarId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
     formaPagamento, contaFinanceiraId, movimentacaoFinanceiraId, observacoes, usuario)
    VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`).run(
    conta.id, dp, v, v, item.formaPagamento, lote.contaFinanceiraId, movId,
    `Lote ${lote.numero}`, usuario);
  const novoPago = Number((pago + v).toFixed(2));
  const novoStatus = novoPago < conta.valor - 0.01 ? 'parcial' : 'paga';
  db.prepare(`UPDATE contas_a_pagar SET status = ?, valorPago = ?,
    dataPagamento = CASE WHEN ? = 'paga' THEN ? ELSE dataPagamento END,
    dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(novoStatus, novoPago, novoStatus, dp, conta.id);
  db.prepare(`UPDATE lote_pagamento_itens SET status = 'pago', pagamentoId = ? WHERE id = ?`).run(rp.lastInsertRowid, item.id);
  return v;
}

// ===== Asaas transfers (PIX) — usa a config de boleto da conta financeira =====
function asaasCfg(db, contaFinanceiraId) {
  const row = db.prepare(`SELECT * FROM contas_financeiras_boleto
    WHERE contaFinanceiraId = ? AND provedor = 'asaas' AND ativo = 1`).get(contaFinanceiraId);
  if (!row) return null;
  let cfg = {};
  try { cfg = JSON.parse(row.configJson || '{}'); } catch {}
  // O formulario do provedor grava 'accessToken' (boleto-provedores/asaas.js),
  // mas aqui so se procurava 'apiKey': a chave existia e esta funcao devolvia
  // null, entao o lote dizia "configure em Cobrancas" para uma integracao que
  // ja estava configurada e emitindo boleto. 'apiKey' segue aceito por
  // compatibilidade com config antiga.
  const token = cfg.accessToken || cfg.apiKey;
  if (!token) return null;
  const base = row.ambiente === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
  return { apiKey: token, base };
}

function tipoChavePix(chave) {
  const c = String(chave || '').trim();
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(c)) return 'EMAIL';
  if (/^\+?55?\d{10,11}$/.test(c.replace(/\D/g, '')) && /[()\s\-+]/.test(c)) return 'PHONE';
  const dig = c.replace(/\D/g, '');
  if (dig.length === 11 && dig === c) return 'CPF';
  if (dig.length === 14 && dig === c) return 'CNPJ';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c)) return 'EVP';
  if (dig.length === 11) return 'CPF';
  if (dig.length === 14) return 'CNPJ';
  return 'EVP';
}

/**
 * Pagamento de conta (boleto/convenio) pelo Asaas — POST /v3/bill.
 *
 * O objeto devolvido traz o valor EFETIVO (com juros, multa e desconto do
 * proprio boleto), que costuma diferir do valor do titulo. Gravar o valor do
 * titulo em vez do pago deixa a conciliacao com diferenca de centavos que
 * ninguem acha depois.
 */
async function asaasPagarBoleto(cfg, { linhaDigitavel, valor, agendarPara, descricao, referencia }) {
  const corpo = {
    identificationField: String(linhaDigitavel || '').replace(/\D/g, ''),
    description: (descricao || '').slice(0, 255),
  };
  // Boleto com valor em aberto (concessionaria com referencia) exige o valor.
  if (valor != null) corpo.value = Number(valor);
  if (agendarPara) corpo.scheduleDate = agendarPara;
  if (referencia) corpo.externalReference = String(referencia).slice(0, 100);

  const resp = await fetch(cfg.base + '/bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', access_token: cfg.apiKey },
    body: JSON.stringify(corpo),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.description || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data;
}

async function asaasConsultarBoleto(cfg, id) {
  const resp = await fetch(`${cfg.base}/bill/${encodeURIComponent(id)}`, {
    headers: { access_token: cfg.apiKey } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.errors?.[0]?.description || `HTTP ${resp.status}`);
  return data;
}

async function asaasListarBoletos(cfg, { limit = 100, offset = 0 } = {}) {
  const resp = await fetch(`${cfg.base}/bill?limit=${limit}&offset=${offset}`, {
    headers: { access_token: cfg.apiKey } });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.errors?.[0]?.description || `HTTP ${resp.status}`);
  return data;
}

// Status do Asaas -> status do item do lote. PENDING/SCHEDULED ainda nao
// sairam da conta; so BANK_PROCESSING em diante compromete dinheiro.
const STATUS_BILL = {
  PENDING: 'aguardando', SCHEDULED: 'aguardando', BANK_PROCESSING: 'enviado',
  PAID: 'pago', FAILED: 'erro', CANCELLED: 'cancelado', REFUNDED: 'cancelado',
};

async function asaasTransfer(cfg, { valor, chavePix, descricao }) {
  const resp = await fetch(cfg.base + '/transfers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'access_token': cfg.apiKey },
    body: JSON.stringify({
      value: Number(valor),
      pixAddressKey: chavePix,
      pixAddressKeyType: tipoChavePix(chavePix),
      description: (descricao || '').slice(0, 100)
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.description || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return data; // { id, status, ... }
}

// ===== Regras OFX =====

/**
 * Regra que categoriza PRECISA de conta do plano — sem ela a classificação não
 * chega ao orçamento e o trabalho de conciliar não vira informação nenhuma.
 *
 * A trava vive no banco, não só na rota: regra nasce por POST, por edição e
 * por seed, e validar em cada caminho garante que um deles escapa. O CHECK
 * permite a regra inválida existir INATIVA — assim a migração não precisa
 * apagar configuração de cliente para conseguir aplicar a restrição.
 */
function travarRegraSemConta(db) {
  const cols = db.prepare('PRAGMA table_info(conciliacao_regras)').all();
  if (!cols.length) return { desativadas: [] };
  const sql = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='conciliacao_regras'").get();
  if (sql && /categorizar_exige_conta/.test(sql.sql || '')) return { desativadas: [] };

  // Quem já está ativa e inválida sai de operação — continuar rodando seria
  // produzir classificação que não alimenta nada.
  const invalidas = db.prepare(
    "SELECT id, padraoTexto FROM conciliacao_regras WHERE ativo = 1 AND acao = 'categorizar' AND planoContaId IS NULL").all();

  const fkAntes = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN;
      UPDATE conciliacao_regras SET ativo = 0
        WHERE ativo = 1 AND acao = 'categorizar' AND planoContaId IS NULL;
      CREATE TABLE conciliacao_regras_novo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contaFinanceiraId INTEGER,
        padraoTexto TEXT NOT NULL,
        tipoLancamento TEXT NOT NULL DEFAULT 'ambos',
        acao TEXT NOT NULL DEFAULT 'categorizar',
        categoria TEXT,
        prioridade INTEGER DEFAULT 0,
        ativo INTEGER DEFAULT 1,
        dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
        planoContaId INTEGER,
        modo TEXT DEFAULT 'contem',
        valorMin REAL,
        valorMax REAL,
        vezesAplicada INTEGER DEFAULT 0,
        ultimaAplicacao TEXT,
        CONSTRAINT categorizar_exige_conta
          CHECK (ativo = 0 OR acao <> 'categorizar' OR planoContaId IS NOT NULL)
      );
      INSERT INTO conciliacao_regras_novo
        (id, contaFinanceiraId, padraoTexto, tipoLancamento, acao, categoria, prioridade,
         ativo, dataCriacao, planoContaId, modo, valorMin, valorMax, vezesAplicada, ultimaAplicacao)
      SELECT id, contaFinanceiraId, padraoTexto, tipoLancamento, acao, categoria, prioridade,
             ativo, dataCriacao, planoContaId, modo, valorMin, valorMax,
             COALESCE(vezesAplicada,0), ultimaAplicacao
        FROM conciliacao_regras;
      DROP TABLE conciliacao_regras;
      ALTER TABLE conciliacao_regras_novo RENAME TO conciliacao_regras;
      COMMIT;`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { }
    throw e;
  } finally {
    db.pragma(`foreign_keys = ${fkAntes ? 'ON' : 'OFF'}`);
  }
  return { desativadas: invalidas };
}

/**
 * Liga a agenda de recebiveis a conta a receber e prepara a taxa como despesa.
 *
 * A agenda vivia em paralelo ao contas a receber: conciliar o recebivel no
 * extrato nao baixava a CR, e baixar a CR nao fechava o recebivel. Duas
 * verdades sobre o mesmo dinheiro.
 */
function migrarAgendaCartao(db) {
  const alter = (sql) => {
    try { db.exec(sql); }
    catch (e) { if (!/duplicate column|no such table/i.test(e.message)) throw e; }
  };
  alter('ALTER TABLE agenda_recebiveis_cartao ADD COLUMN contaReceberId INTEGER');
  alter('ALTER TABLE agenda_recebiveis_cartao ADD COLUMN contaPagarTaxaId INTEGER');
  alter('ALTER TABLE agenda_recebiveis_cartao ADD COLUMN dataLiquidacao TEXT');
}

/**
 * Fornecedor que representa a adquirente, para a taxa virar despesa de
 * alguem. Sem isso a taxa nao teria onde ser lancada — contas_a_pagar exige
 * fornecedor.
 */
function fornecedorDaAdquirente(db, adq) {
  const doc = String(adq.cnpj || '').replace(/\D/g, '');
  // CNPJ e obrigatorio e unico: sem o da adquirente, usa um marcador estavel
  // e derivado do id, para nao colidir e para nao inventar documento.
  return garantirFornecedor(db, {
    cpfCnpj: doc || `ADQ-${adq.id}`,
    razaoSocial: adq.nome,
    observacoes: 'Criado automaticamente para lancar a taxa de cartao',
  });
}

/** Conta do plano onde a taxa de cartao entra: despesa financeira. */
function contaPlanoTaxaCartao(db) {
  const porCodigo = db.prepare("SELECT id FROM plano_contas WHERE codigo = '5.2' AND ativo = 1").get();
  if (porCodigo) return porCodigo.id;
  const porTipo = db.prepare(`SELECT pc.id FROM plano_contas pc
    WHERE pc.tipo = 'financeiro_despesa' AND pc.ativo = 1
      AND (SELECT COUNT(*) FROM plano_contas f WHERE f.parentId = pc.id) = 0
    ORDER BY pc.codigo LIMIT 1`).get();
  return porTipo ? porTipo.id : null;
}

function migrarRegrasConciliacao(db) {
  // A regra passa a apontar para o plano de contas. Antes ela só gravava um
  // texto solto em categoriaSugerida, que não entrava no orçamento nem em
  // relatório nenhum — categorizar não produzia efeito em lugar algum.
  alterSafe(db, 'ALTER TABLE conciliacao_regras ADD COLUMN planoContaId INTEGER');
  alterSafe(db, "ALTER TABLE conciliacao_regras ADD COLUMN modo TEXT DEFAULT 'contem'");
  alterSafe(db, 'ALTER TABLE conciliacao_regras ADD COLUMN valorMin REAL');
  alterSafe(db, 'ALTER TABLE conciliacao_regras ADD COLUMN valorMax REAL');
  alterSafe(db, 'ALTER TABLE conciliacao_regras ADD COLUMN vezesAplicada INTEGER DEFAULT 0');
  alterSafe(db, 'ALTER TABLE conciliacao_regras ADD COLUMN ultimaAplicacao TEXT');
  alterSafe(db, 'ALTER TABLE transacoes_bancarias ADD COLUMN planoContaIdSugerido INTEGER');
  try { travarRegraSemConta(db); }
  catch (e) { console.warn('[conciliacao regras] trava não aplicada:', e.message); }
}

const normalizar = (t) => String(t || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '');   // "TARIFA" casa "tarifa" e "Tarífa"

/**
 * A transação casa com a regra?
 *
 * `modo='palavra'` existe porque `includes` puro é traiçoeiro em extrato:
 * o padrão "PIX" casa "PIXEL", "TED" casa "ACREDITADO". Quem escreve a regra
 * não descobre isso — só vê o lançamento errado semanas depois.
 */
function regraCasa(regra, transacao) {
  const ehEntrada = Number(transacao.valor) > 0;
  if (regra.tipoLancamento === 'entrada' && !ehEntrada) return false;
  if (regra.tipoLancamento === 'saida' && ehEntrada) return false;

  // Faixa de valor: separa a tarifa de R$ 12 do TED de R$ 12.000 que trazem
  // o mesmo texto no extrato.
  const abs = Math.abs(Number(transacao.valor) || 0);
  if (regra.valorMin != null && abs < regra.valorMin - 0.001) return false;
  if (regra.valorMax != null && abs > regra.valorMax + 0.001) return false;

  const texto = normalizar(`${transacao.descricao || ''} ${transacao.memo || ''}`);
  const padrao = normalizar(regra.padraoTexto);
  if (!padrao) return false;
  if (regra.modo === 'palavra') {
    const escapado = padrao.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escapado}([^a-z0-9]|$)`).test(texto);
  }
  return texto.includes(padrao);
}

function regrasDaConta(db, contaFinanceiraId) {
  // A cláusula do planoContaId repete o CHECK de propósito: se por qualquer
  // caminho uma regra inválida ficar ativa, o motor ainda assim não a executa.
  return db.prepare(`SELECT * FROM conciliacao_regras
    WHERE ativo = 1 AND (contaFinanceiraId IS NULL OR contaFinanceiraId = ?)
      AND (acao <> 'categorizar' OR planoContaId IS NOT NULL)
    ORDER BY prioridade DESC, id`).all(contaFinanceiraId);
}

/**
 * @param {object} opts.reprocessar  reavalia o que já foi tocado por regra.
 *   Sem isso, corrigir uma regra não conserta o que ela errou antes: a
 *   transação ficava marcada para sempre com a classificação errada.
 */
function aplicarRegrasConciliacao(db, contaFinanceiraId, opts = {}) {
  const regras = regrasDaConta(db, contaFinanceiraId);
  if (!regras.length) return { aplicadas: 0, revertidas: 0 };

  let revertidas = 0;
  if (opts.reprocessar) {
    // Só desfaz o que foi decidido POR REGRA. Conciliação feita por pessoa é
    // intocável — reprocessar não pode apagar trabalho manual.
    const r = db.prepare(`UPDATE transacoes_bancarias
      SET conciliadaCom = CASE WHEN conciliadaCom = 'ignorada' THEN NULL ELSE conciliadaCom END,
          conciliadaEm = CASE WHEN conciliadaCom = 'ignorada' THEN NULL ELSE conciliadaEm END,
          conciliadaPor = CASE WHEN conciliadaCom = 'ignorada' THEN NULL ELSE conciliadaPor END,
          categoriaSugerida = NULL, planoContaIdSugerido = NULL, regraAplicadaId = NULL
      WHERE contaFinanceiraId = ? AND regraAplicadaId IS NOT NULL
        AND (conciliadaCom IS NULL OR conciliadaCom = 'ignorada')`).run(contaFinanceiraId);
    revertidas = r.changes;
  }

  const pendentes = db.prepare(`SELECT * FROM transacoes_bancarias
    WHERE contaFinanceiraId = ? AND conciliadaCom IS NULL AND regraAplicadaId IS NULL`).all(contaFinanceiraId);

  let aplicadas = 0;
  const marcaUso = db.prepare(`UPDATE conciliacao_regras
    SET vezesAplicada = COALESCE(vezesAplicada,0) + 1, ultimaAplicacao = CURRENT_TIMESTAMP WHERE id = ?`);

  for (const t of pendentes) {
    for (const r of regras) {
      if (!regraCasa(r, t)) continue;
      if (r.acao === 'ignorar') {
        db.prepare(`UPDATE transacoes_bancarias SET conciliadaCom = 'ignorada',
          conciliadaEm = CURRENT_TIMESTAMP, conciliadaPor = 'regra#' || ?, regraAplicadaId = ? WHERE id = ?`)
          .run(r.id, r.id, t.id);
      } else {
        db.prepare(`UPDATE transacoes_bancarias
          SET categoriaSugerida = ?, planoContaIdSugerido = ?, regraAplicadaId = ? WHERE id = ?`)
          .run(r.categoria || r.padraoTexto, r.planoContaId || null, r.id, t.id);
      }
      marcaUso.run(r.id);
      aplicadas++;
      break;
    }
  }
  return { aplicadas, revertidas };
}

/**
 * O que a regra pegaria, ANTES de salvar. Sem isto, descobrir que o padrão
 * é largo demais custa uma reclassificação em massa depois.
 */
function simularRegra(db, regra, { limite = 20 } = {}) {
  const cond = regra.contaFinanceiraId ? 'AND contaFinanceiraId = ?' : '';
  const params = regra.contaFinanceiraId ? [regra.contaFinanceiraId] : [];
  const todas = db.prepare(`SELECT * FROM transacoes_bancarias WHERE 1=1 ${cond} ORDER BY data DESC`).all(...params);
  const casam = todas.filter(t => regraCasa(regra, t));

  // Regra que casa quase tudo quase sempre é padrão curto demais.
  const pct = todas.length ? (casam.length / todas.length) * 100 : 0;
  const avisos = [];
  if (casam.length && pct > 60) {
    avisos.push(`Casa ${pct.toFixed(0)}% das transações da conta — o padrão provavelmente está curto demais.`);
  }
  if (!casam.length && todas.length) {
    avisos.push('Não casa com nenhuma transação existente. Confira o texto exatamente como aparece no extrato.');
  }
  if (regra.modo !== 'palavra' && String(regra.padraoTexto || '').length <= 4) {
    avisos.push('Padrão curto no modo "contém" casa dentro de outras palavras (PIX casa PIXEL). Considere "palavra inteira".');
  }
  if (regra.acao === 'ignorar') {
    avisos.push('Ação "ignorar" concilia sozinha: a transação some da lista de pendências sem ninguém conferir.');
  }
  return {
    total: todas.length, casam: casam.length, percentual: Number(pct.toFixed(1)), avisos,
    amostra: casam.slice(0, limite).map(t => ({ id: t.id, data: t.data, valor: t.valor,
      descricao: t.descricao, memo: t.memo, jaConciliada: !!t.conciliadaCom })),
  };
}

/** Regra que nunca pegou nada, e regra que outra de prioridade maior engole. */
function diagnosticoRegras(db) {
  const regras = db.prepare('SELECT * FROM conciliacao_regras ORDER BY prioridade DESC, id').all();
  const mortas = [], sombreadas = [];
  for (const r of regras) {
    if (r.ativo && !r.vezesAplicada) mortas.push({ id: r.id, padraoTexto: r.padraoTexto });
    // Sombreada: outra regra antes dela, no mesmo escopo, com padrão contido
    // no dela — a de baixo nunca será alcançada.
    for (const outra of regras) {
      if (outra.id === r.id || !outra.ativo || !r.ativo) continue;
      const antes = outra.prioridade > r.prioridade || (outra.prioridade === r.prioridade && outra.id < r.id);
      if (!antes) continue;
      const mesmoEscopo = !outra.contaFinanceiraId || outra.contaFinanceiraId === r.contaFinanceiraId;
      const tipoEngole = outra.tipoLancamento === 'ambos' || outra.tipoLancamento === r.tipoLancamento;
      const semFaixa = outra.valorMin == null && outra.valorMax == null;
      if (mesmoEscopo && tipoEngole && semFaixa
          && normalizar(r.padraoTexto).includes(normalizar(outra.padraoTexto))) {
        sombreadas.push({ id: r.id, padraoTexto: r.padraoTexto,
          engolidaPor: { id: outra.id, padraoTexto: outra.padraoTexto } });
        break;
      }
    }
  }
  return { total: regras.length, ativas: regras.filter(r => r.ativo).length, mortas, sombreadas };
}

/**
 * Boletos a pagar: leitura, caixa de entrada (DDA + manual) e vinculo com o
 * titulo. O lote de pagamento so sabia PIX; boleto de fornecedor e de
 * concessionaria nao tinha por onde entrar.
 */
function registrarRotasBoletos(app, db) {
  // RBAC: boleto DDA herda a unidade da conta a pagar vinculada.
  app.use('/api/boletos/:id', guardEscopo(db, 'dda_boletos', { fk: 'contaPagarId', pai: 'contas_a_pagar' }));

  // Le sem gravar: a tela mostra banco, valor e vencimento antes de aceitar.
  app.post('/api/boletos/ler', (req, res) => {
    try {
      const lido = boleto.lerBoleto(req.body?.codigo || '');
      res.json({ success: true, ...lido, bancoNome: boleto.nomeBanco(lido.banco) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Entrada manual e importacao do DDA usam o mesmo caminho: mesma validacao,
  // mesma deduplicacao. Duas portas para a mesma fila.
  app.post('/api/boletos/importar', (req, res) => {
    try {
      const b = req.body || {};
      let entradas = Array.isArray(b.boletos) ? b.boletos : [];
      // Uma LINHA = um registro. Separar tambem por ';' quebrava a linha
      // exportada em colunas: "Beneficiario;Valor;Vencimento;<codigo>" virava
      // quatro entradas em vez de uma. Varios codigos na mesma linha seguem
      // funcionando — quem separa e o extrator, que sabe o que e codigo.
      if (!entradas.length && typeof b.texto === 'string') {
        entradas = b.texto.split(/[\r\n]+/).map(x => x.trim()).filter(Boolean)
          .flatMap(linha => {
            const achados = dda.extrairCodigos(linha);
            return achados.length > 1 ? achados : [linha];
          });
      }
      if (!entradas.length) return res.status(400).json({ success: false, error: 'Informe boletos ou texto' });
      if (entradas.length > 300) return res.status(400).json({ success: false, error: 'No maximo 300 por vez' });
      const origem = b.origem === 'dda' ? 'dda' : 'manual';
      const r = dda.importarBoletos(db, entradas, { origem });
      logAction(db, req, 'importar', 'dda-boletos', null,
        { origem, novos: r.novos.length, duplicados: r.duplicados.length, invalidos: r.invalidos.length });
      res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/api/boletos', (req, res) => {
    try {
      const { status, ate } = req.query;
      let sql = `SELECT d.*, cp.descricao AS tituloDescricao, cp.status AS tituloStatus,
          f.razaoSocial AS fornecedorNome
        FROM dda_boletos d
        LEFT JOIN contas_a_pagar cp ON cp.id = d.contaPagarId
        LEFT JOIN pessoas f ON f.id = cp.fornecedorId WHERE 1=1`;
      const p = [];
      // RBAC: o boleto DDA herda a unidade da conta a pagar vinculada.
      const rbacDda = escopoSqlHerdado(req, 'd.contaPagarId', 'contas_a_pagar');
      sql += rbacDda.sql; p.push(...rbacDda.params);
      if (status) { sql += ' AND d.status = ?'; p.push(status); }
      if (ate) { sql += ' AND d.vencimento <= ?'; p.push(ate); }
      sql += ' ORDER BY d.vencimento IS NULL, d.vencimento, d.id';
      const lista = db.prepare(sql).all(...p);
      // Boleto novo vem com a sugestao de titulo junto: e a decisao seguinte.
      const comSugestao = lista.map(b => b.status === 'novo'
        ? { ...b, sugestoes: dda.sugerirContaPagar(db, b) } : b);
      res.json({ success: true, boletos: comSugestao,
        resumo: {
          novos: lista.filter(b => b.status === 'novo').length,
          vinculados: lista.filter(b => b.status === 'vinculado').length,
          semValor: lista.filter(b => b.valorEmAberto).length,
          vencidos: lista.filter(b => b.status !== 'pago' && b.vencimento
            && b.vencimento < new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)).length,
        } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/boletos/:id/vincular', (req, res) => {
    try {
      const r = dda.vincular(db, Number(req.params.id), {
        contaPagarId: req.body?.contaPagarId || null,
        criar: req.body?.criar || null,
        usuario: req.session?.username || null });
      logAction(db, req, 'vincular', 'dda-boleto', Number(req.params.id), r);
      res.json({ success: true, ...r });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Sincroniza com o Asaas: atualiza o status dos boletos que o lote mandou
   * pagar e traz para a fila os que foram pagos direto no painel do Asaas.
   *
   * Isso e o que o /v3/bill da: o historico do que a conta pagou. Nao e DDA —
   * a API do Asaas nao expoe caixa de entrada de boletos emitidos contra o
   * CNPJ (checado: /dda, /ddaBills e /bill/dda respondem 404).
   */
  app.post('/api/boletos/sincronizar-asaas', async (req, res) => {
    try {
      const contaId = Number(req.body?.contaFinanceiraId);
      if (!contaId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatorio' });
      const cfg = asaasCfg(db, contaId);
      if (!cfg) return res.status(400).json({ success: false, error: 'Conta sem integracao Asaas ativa' });

      const lista = await asaasListarBoletos(cfg, { limit: Number(req.body?.limit) || 100 });
      let atualizados = 0, importados = 0;
      const baixados = [];

      for (const b of (lista.data || [])) {
        // 1) Item de lote que aguardava resposta.
        const item = b.id
          ? db.prepare('SELECT * FROM lote_pagamento_itens WHERE provedorRef = ?').get(b.id) : null;
        if (item) {
          const novo = STATUS_BILL[b.status];
          if (novo && novo !== item.status) {
            db.prepare('UPDATE lote_pagamento_itens SET status = ?, erroMensagem = ? WHERE id = ?')
              .run(novo, b.failReasons ? String(b.failReasons).slice(0, 300) : null, item.id);
            atualizados++;
            if (novo === 'pago') baixados.push({ itemId: item.id, contaPagarId: item.contaPagarId, valor: b.value });
          }
          continue;
        }
        // 2) Boleto pago fora do ERP: entra na fila para virar titulo, senao a
        //    saida existe no extrato e nao existe no contas a pagar.
        if (!b.identificationField) continue;
        const jaTem = db.prepare('SELECT id FROM dda_boletos WHERE linhaDigitavel = ? OR codigoBarras = ?')
          .get(b.identificationField, b.identificationField);
        if (jaTem) continue;
        const r = dda.importarBoletos(db, [{
          linhaDigitavel: b.identificationField,
          valor: b.value, vencimento: b.dueDate,
          beneficiarioNome: b.beneficiaryName, beneficiarioCnpj: b.beneficiaryCpfCnpj,
        }], { origem: 'asaas' });
        if (r.novos.length) {
          importados++;
          if (b.status === 'PAID') {
            db.prepare("UPDATE dda_boletos SET status = 'pago', observacao = ? WHERE id = ?")
              .run(`Pago pelo Asaas em ${b.paymentDate || ''} — ${b.transactionReceiptUrl || ''}`.trim(), r.novos[0].id);
          }
        }
      }
      logAction(db, req, 'sincronizar', 'asaas-bill', contaId, { atualizados, importados });
      res.json({ success: true, atualizados, importados, aguardandoBaixa: baixados,
        total: lista.totalCount ?? null });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/boletos/:id/ignorar', (req, res) => {
    try {
      const r = db.prepare("UPDATE dda_boletos SET status = 'ignorado', observacao = ? WHERE id = ? AND status = 'novo'")
        .run((req.body?.motivo || '').slice(0, 300) || null, req.params.id);
      if (!r.changes) return res.status(400).json({ success: false, error: 'Boleto nao esta como novo' });
      res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

/**
 * Pagamento automatico das contas a pagar recorrentes, por PIX.
 *
 * Dinheiro saindo sozinho exige mais trava do que qualquer outra rotina. As
 * que valem aqui:
 *   - opt-in POR recorrencia, nunca global;
 *   - teto de valor: conta de consumo que dobra nao sai no automatico;
 *   - alcada de aprovacao continua valendo (e a mesma do lote manual);
 *   - so paga o que tem chave PIX no fornecedor;
 *   - nunca paga duas vezes o mesmo titulo.
 *
 * Nao cria um segundo caminho para o dinheiro: monta um lote de pagamento e
 * usa o mesmo processamento do lote manual.
 */
function migrarPagamentoAutomaticoCP(db) {
  const alter = (sql) => {
    try { db.exec(sql); }
    catch (e) { if (!/duplicate column|no such table/i.test(e.message)) throw e; }
  };
  alter('ALTER TABLE contas_pagar_recorrencias ADD COLUMN pagarAutomatico INTEGER DEFAULT 0');
  alter('ALTER TABLE contas_pagar_recorrencias ADD COLUMN contaFinanceiraId INTEGER');
  alter('ALTER TABLE contas_pagar_recorrencias ADD COLUMN limiteValorAuto REAL');
  alter('ALTER TABLE contas_pagar_recorrencias ADD COLUMN diasAntesVencimento INTEGER DEFAULT 0');
  alter('ALTER TABLE contas_pagar_recorrencias ADD COLUMN ultimoPagamentoAuto TEXT');
}

/**
 * Decide se um titulo recorrente pode ser pago sozinho.
 * Devolve o motivo quando NAO pode — recusa silenciosa aqui vira conta
 * vencida que ninguem entende.
 */
function podePagarAutomatico(db, cp, rec) {
  if (!rec || Number(rec.pagarAutomatico) !== 1) return { pode: false, motivo: 'recorrência sem pagamento automático' };
  if (!['aberta', 'parcial'].includes(cp.status)) return { pode: false, motivo: `título ${cp.status}` };

  const pago = db.prepare(`SELECT COALESCE(SUM(valorBase),0) t FROM contas_pagar_pagamentos
    WHERE contaPagarId = ? AND estornado = 0`).get(cp.id).t || 0;
  const saldo = Number((cp.valor - pago).toFixed(2));
  if (!(saldo > 0)) return { pode: false, motivo: 'sem saldo em aberto' };

  // Teto: a conta de luz que dobrou nao sai no automatico.
  if (rec.limiteValorAuto != null && saldo > Number(rec.limiteValorAuto) + 0.001) {
    return { pode: false, saldo,
      motivo: `valor R$ ${saldo.toFixed(2)} acima do teto de R$ ${Number(rec.limiteValorAuto).toFixed(2)}` };
  }

  // Nunca duas vezes: titulo ja em lote vivo fica de fora.
  const emLote = db.prepare(`SELECT l.numero FROM lote_pagamento_itens i
    JOIN lotes_pagamento l ON l.id = i.loteId
    WHERE i.contaPagarId = ? AND i.status IN ('pendente','aguardando','enviado','pago')`).get(cp.id);
  if (emLote) return { pode: false, motivo: `já está no lote ${emLote.numero}` };

  const chave = chavePixDe(db, cp.fornecedorId);
  if (!chave) return { pode: false, saldo, motivo: 'fornecedor sem chave PIX cadastrada' };

  const contaFin = rec.contaFinanceiraId;
  if (!contaFin) return { pode: false, saldo, motivo: 'recorrência sem conta financeira de origem' };
  if (!asaasCfg(db, contaFin)) return { pode: false, saldo, motivo: 'conta de origem sem integração Asaas ativa' };

  return { pode: true, saldo, chave, contaFinanceiraId: contaFin };
}

/**
 * Varre os titulos recorrentes elegiveis e paga por PIX.
 * @param {object} opts.simular  nao dispara nada, so diz o que faria
 */
async function pagarRecorrentesPorPix(db, { simular = false, log = () => {}, usuario = 'automatico' } = {}) {
  const hoje = dataBrasilia();
  let candidatos = [];
  try {
    candidatos = db.prepare(`
      SELECT cp.*, r.id AS recId, r.pagarAutomatico, r.contaFinanceiraId, r.limiteValorAuto,
             r.diasAntesVencimento, r.descricao AS recDescricao
      FROM contas_a_pagar cp
      JOIN contas_pagar_recorrencias r ON r.id = cp.recorrenciaId
      WHERE cp.origem = 'recorrente' AND cp.status IN ('aberta','parcial')
        AND r.ativo = 1 AND r.pagarAutomatico = 1
        -- Antecipa no maximo o que a recorrencia mandou; o resto espera.
        AND date(cp.dataVencimento) <= date(?, '+' || COALESCE(r.diasAntesVencimento, 0) || ' days')`).all(hoje);
  } catch (e) {
    log(`[pix-auto] consulta falhou: ${e.message}`);
    return { elegiveis: 0, pagos: 0, recusados: [], erros: [] };
  }

  const aptos = [], recusados = [];
  for (const cp of candidatos) {
    const v = podePagarAutomatico(db, cp, {
      pagarAutomatico: cp.pagarAutomatico, contaFinanceiraId: cp.contaFinanceiraId,
      limiteValorAuto: cp.limiteValorAuto });
    if (v.pode) aptos.push({ cp, ...v });
    else recusados.push({ contaPagarId: cp.id, descricao: cp.descricao, motivo: v.motivo, valor: v.saldo });
  }
  if (recusados.length) {
    for (const r of recusados) log(`[pix-auto] pulado CP #${r.contaPagarId}: ${r.motivo}`);
  }
  if (simular || !aptos.length) {
    return { elegiveis: aptos.length, pagos: 0, recusados,
      simulacao: aptos.map(a => ({ contaPagarId: a.cp.id, valor: a.saldo, chavePix: a.chave })) };
  }

  // Um lote por conta financeira de origem: o lote e a unidade que carrega
  // alcada, provedor e rastreio.
  const porConta = new Map();
  for (const a of aptos) {
    if (!porConta.has(a.contaFinanceiraId)) porConta.set(a.contaFinanceiraId, []);
    porConta.get(a.contaFinanceiraId).push(a);
  }

  let pagos = 0;
  const erros = [], lotes = [];
  for (const [contaFin, itens] of porConta) {
    const cfg = asaasCfg(db, contaFin);
    let loteId;
    try {
      const total = itens.reduce((t, x) => t + x.saldo, 0);
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO lotes_pagamento (numero, contaFinanceiraId, provedor, valorTotal, usuario)
          VALUES (?, ?, 'asaas', ?, ?)`).run(proximoNumeroLote(db), contaFin, Number(total.toFixed(2)), usuario);
        loteId = r.lastInsertRowid;
        const ins = db.prepare(`INSERT INTO lote_pagamento_itens
          (loteId, contaPagarId, formaPagamento, chavePix, valor) VALUES (?, ?, 'pix', ?, ?)`);
        for (const x of itens) ins.run(loteId, x.cp.id, x.chave, x.saldo);
      });
      tx();
      lotes.push(loteId);
    } catch (e) { erros.push({ contaFinanceiraId: contaFin, erro: e.message }); continue; }

    // Alcada primeiro: item acima do limite vira aprovacao pendente e NAO sai.
    for (const x of itens) {
      const item = db.prepare('SELECT * FROM lote_pagamento_itens WHERE loteId = ? AND contaPagarId = ?')
        .get(loteId, x.cp.id);
      const alcada = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: x.cp.id,
        valor: x.saldo, usuario });
      if (!alcada.liberado) {
        db.prepare(`UPDATE lote_pagamento_itens SET status = 'pendente', erroMensagem = ? WHERE id = ?`)
          .run(`Acima da alçada — aprovação #${alcada.aprovacaoId} pendente`, item.id);
        recusados.push({ contaPagarId: x.cp.id, descricao: x.cp.descricao, valor: x.saldo,
          motivo: `acima da alçada — aprovação #${alcada.aprovacaoId} pendente` });
        continue;
      }
      try {
        const tr = await asaasTransfer(cfg, { valor: x.saldo, chavePix: x.chave,
          descricao: `Recorrência: ${x.cp.descricao}`.slice(0, 100) });
        db.prepare(`UPDATE lote_pagamento_itens SET status = 'enviado', provedorRef = ? WHERE id = ?`)
          .run(tr.id || null, item.id);
        db.prepare(`UPDATE contas_pagar_recorrencias SET ultimoPagamentoAuto = ? WHERE id = ?`)
          .run(hoje, x.cp.recId);
        pagos++;
      } catch (e) {
        db.prepare(`UPDATE lote_pagamento_itens SET status = 'erro', erroMensagem = ? WHERE id = ?`)
          .run(String(e.message).slice(0, 300), item.id);
        erros.push({ contaPagarId: x.cp.id, erro: e.message });
      }
    }
    db.prepare(`UPDATE lotes_pagamento SET status = 'processando', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(loteId);
  }

  log(`[pix-auto] ${pagos} pagamento(s) enviado(s), ${recusados.length} pulado(s), ${erros.length} erro(s)`);
  return { elegiveis: aptos.length, pagos, recusados, erros, lotes };
}

function registrarRotasTesouraria(app, db) {
  // RBAC: lote e previsão de cartão herdam a unidade de quem os originou.
  app.use('/api/lotes-pagamento/:id', guardEscopo(db, 'lotes_pagamento', { fk: 'contaFinanceiraId', pai: 'contas_financeiras' }));
  app.use('/api/cartoes/agenda/:id', guardEscopo(db, 'agenda_recebiveis_cartao', { fk: 'contaReceberId', pai: 'contas_a_receber' }));
  app.use('/api/conciliacao/regras/:id', guardEscopo(db, 'conciliacao_regras', { fk: 'contaFinanceiraId', pai: 'contas_financeiras' }));

  migrarTesourariaDB(db);
  // Roda junto com a geracao das recorrentes (a cada 6h). Sozinho nao adianta
  // gerar a conta e deixar vencer.
  setTimeout(() => pagarRecorrentesPorPix(db, { log: console.log }).catch(e =>
    console.error('[pix-auto]', e.message)), 60000);
  setInterval(() => pagarRecorrentesPorPix(db, { log: console.log }).catch(e =>
    console.error('[pix-auto]', e.message)), 6 * 60 * 60 * 1000);
  migrarRegrasConciliacao(db);
  migrarAgendaCartao(db);
  migrarPagamentoAutomaticoCP(db);
  dda.migrarDdaDB(db);
  registrarRotasBoletos(app, db);

  // ==================== PIX AUTOMATICO DE RECORRENTES ====================

  // Simulacao antes de qualquer coisa sair: mostra o que pagaria e o que
  // pularia, com o motivo de cada recusa.
  app.get('/api/cp-recorrencias/pagamento-automatico/simular', async (req, res) => {
    try { res.json({ success: true, ...(await pagarRecorrentesPorPix(db, { simular: true, log: console.log })) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/cp-recorrencias/pagamento-automatico/executar', async (req, res) => {
    try {
      const r = await pagarRecorrentesPorPix(db, { log: console.log, usuario: req.session?.username || 'manual' });
      logAction(db, req, 'pagar-auto', 'cp-recorrencias', null,
        { pagos: r.pagos, recusados: r.recusados.length, erros: (r.erros || []).length });
      res.json({ success: true, ...r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ==================== LOTES DE PAGAMENTO ====================

  app.get('/api/lotes-pagamento', (req, res) => {
    try {
      const lotes = db.prepare(`SELECT l.*, cf.nome AS contaNome,
          (SELECT COUNT(*) FROM lote_pagamento_itens WHERE loteId = l.id) AS qtdItens,
          (SELECT COUNT(*) FROM lote_pagamento_itens WHERE loteId = l.id AND status = 'pago') AS qtdPagos
        FROM lotes_pagamento l JOIN contas_financeiras cf ON cf.id = l.contaFinanceiraId
        WHERE 1=1${escopoSql(req, 'cf.estabelecimentoId').sql}
        ORDER BY l.id DESC LIMIT 100`).all(...escopoSql(req, 'cf.estabelecimentoId').params);
      res.json({ success: true, lotes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/lotes-pagamento/:id', (req, res) => {
    try {
      const lote = db.prepare(`SELECT l.*, cf.nome AS contaNome FROM lotes_pagamento l
        JOIN contas_financeiras cf ON cf.id = l.contaFinanceiraId WHERE l.id = ?`).get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      const itens = db.prepare(`SELECT i.*, cp.descricao, cp.dataVencimento, f.razaoSocial AS fornecedorNome
        FROM lote_pagamento_itens i
        JOIN contas_a_pagar cp ON cp.id = i.contaPagarId
        LEFT JOIN pessoas f ON f.id = cp.fornecedorId
        WHERE i.loteId = ?`).all(lote.id);
      res.json({ success: true, lote, itens });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Cria lote com CPs abertas. itens: [{contaPagarId, formaPagamento?, chavePix?}]
  app.post('/api/lotes-pagamento', (req, res) => {
    try {
      const { contaFinanceiraId, provedor, dataAgendada, itens } = req.body || {};
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      const cf = db.prepare('SELECT id, estabelecimentoId FROM contas_financeiras WHERE id = ? AND ativo = 1').get(contaFinanceiraId);
      if (!cf || !noEscopo(req, cf.estabelecimentoId)) return res.status(404).json({ success: false, error: 'Conta financeira não encontrada' });
      if (!Array.isArray(itens) || !itens.length) return res.status(400).json({ success: false, error: 'Informe ao menos 1 CP' });
      const prov = provedor === 'asaas' ? 'asaas' : 'manual';
      if (prov === 'asaas' && !asaasCfg(db, contaFinanceiraId)) {
        return res.status(400).json({ success: false, error: 'Conta sem integração Asaas ativa (configure em Cobranças)' });
      }

      const resolvidos = [];
      for (const it of itens) {
        const { conta, saldo } = saldoAbertoCP(db, Number(it.contaPagarId));
        // Os CPs vêm no corpo: sem esta checagem daria para pagar título de outra unidade.
        if (!conta || !noEscopo(req, conta.estabelecimentoId)) return res.status(404).json({ success: false, error: `CP ${it.contaPagarId} não encontrada` });
        if (!['aberta', 'parcial'].includes(conta.status)) {
          return res.status(400).json({ success: false, error: `CP #${conta.id} com status ${conta.status}` });
        }
        const jaEmLote = db.prepare(`SELECT l.numero FROM lote_pagamento_itens i
          JOIN lotes_pagamento l ON l.id = i.loteId
          WHERE i.contaPagarId = ? AND i.status IN ('pendente','aguardando','enviado')`).get(conta.id);
        if (jaEmLote) return res.status(400).json({ success: false, error: `CP #${conta.id} já está no lote ${jaEmLote.numero}` });
        let chave = (it.chavePix || '').trim() || null;
        if (!chave && conta.fornecedorId) {
          chave = chavePixDe(db, conta.fornecedorId);
        }
        // Boleto usa o codigo de barras, nao chave PIX. Antes o lote so sabia
        // pagar por PIX, entao boleto de fornecedor nao tinha como entrar.
        const forma = it.formaPagamento || (conta.codigoBarras ? 'boleto' : 'pix');
        let linha = (it.linhaDigitavel || '').trim() || conta.linhaDigitavel || null;
        let barras = (it.codigoBarras || '').trim() || conta.codigoBarras || null;
        if (forma === 'boleto') {
          const lido = boleto.lerBoleto(linha || barras || '');
          if (!lido.valido) {
            return res.status(400).json({ success: false,
              error: `CP #${conta.id}: boleto invalido — ${lido.erros.join('; ')}` });
          }
          barras = lido.codigoBarras; linha = lido.linhaDigitavel || linha;
          // Pagar valor diferente do impresso no boleto e recusado pelo banco.
          if (lido.valor > 0 && Math.round(lido.valor * 100) !== Math.round(saldo * 100)) {
            return res.status(400).json({ success: false,
              error: `CP #${conta.id}: boleto e de R$ ${lido.valor.toFixed(2)} e o titulo tem saldo de R$ ${saldo.toFixed(2)}` });
          }
        } else if (prov === 'asaas' && !chave) {
          return res.status(400).json({ success: false, error: `CP #${conta.id}: fornecedor sem chave PIX (informe no item ou no cadastro)` });
        }
        resolvidos.push({ contaPagarId: conta.id, fornecedorId: conta.fornecedorId, valor: saldo,
          chavePix: chave, formaPagamento: forma, linhaDigitavel: linha, codigoBarras: barras });
      }

      const usuario = req.session?.username || null;
      let loteId;
      const tx = db.transaction(() => {
        const total = resolvidos.reduce((s, x) => s + x.valor, 0);
        const r = db.prepare(`INSERT INTO lotes_pagamento (numero, contaFinanceiraId, provedor, dataAgendada, valorTotal, usuario)
          VALUES (?, ?, ?, ?, ?, ?)`).run(proximoNumeroLote(db), Number(contaFinanceiraId), prov,
          dataAgendada || null, Number(total.toFixed(2)), usuario);
        loteId = r.lastInsertRowid;
        const ins = db.prepare(`INSERT INTO lote_pagamento_itens
            (loteId, contaPagarId, formaPagamento, chavePix, valor, linhaDigitavel, codigoBarras)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const x of resolvidos) {
          ins.run(loteId, x.contaPagarId, x.formaPagamento, x.chavePix, x.valor,
            x.linhaDigitavel || null, x.codigoBarras || null);
          if (x.chavePix && x.fornecedorId) {
            guardarChavePix(db, x.fornecedorId, x.chavePix);
          }
        }
      });
      tx();
      logAction(db, req, 'criar', 'lote-pagamento', loteId, { itens: resolvidos.length, provedor: prov });
      res.json({ success: true, id: loteId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Processa: consulta alçada por CP (consome aprovações) e dispara PIX (asaas)
  // ou marca aguardando confirmação (manual).
  app.post('/api/lotes-pagamento/:id/processar', async (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes_pagamento WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      if (lote.status !== 'rascunho') return res.status(400).json({ success: false, error: `Status atual: ${lote.status}` });
      const itens = db.prepare(`SELECT * FROM lote_pagamento_itens WHERE loteId = ? AND status = 'pendente'`).all(lote.id);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Lote sem itens pendentes' });
      const usuario = req.session?.username || null;

      // Alçada primeiro — se algum item bloquear, nada é disparado
      const bloqueados = [];
      for (const it of itens) {
        const alcada = verificarAlcada(db, { tipoEvento: 'pagamento_cp', referenciaId: it.contaPagarId, valor: it.valor, usuario });
        if (!alcada.liberado) bloqueados.push({ contaPagarId: it.contaPagarId, aprovacaoId: alcada.aprovacaoId, status: alcada.status });
      }
      if (bloqueados.length) {
        return res.status(403).json({ success: false, error: `${bloqueados.length} item(ns) acima da alçada — aprovações pendentes`, bloqueados });
      }

      const erros = [];
      if (lote.provedor === 'asaas') {
        const cfg = asaasCfg(db, lote.contaFinanceiraId);
        if (!cfg) return res.status(400).json({ success: false, error: 'Integração Asaas indisponível' });
        for (const it of itens) {
          try {
            const cp = db.prepare('SELECT descricao FROM contas_a_pagar WHERE id = ?').get(it.contaPagarId);
            const desc = `Lote ${lote.numero}: ${cp?.descricao || ''}`;
            let ref, novoStatus;
            if (it.formaPagamento === 'boleto') {
              // Boleto vai pelo /v3/bill: quem paga e o Asaas, pelo codigo de
              // barras. Sem isto o item de boleto so podia ser marcado manual.
              const linha = it.linhaDigitavel || it.codigoBarras;
              if (!linha) throw new Error('Item de boleto sem linha digitavel');
              const b = await asaasPagarBoleto(cfg, {
                linhaDigitavel: linha,
                // Valor so vai quando o codigo nao carrega o dele (concessionaria
                // com identificador de referencia); mandar valor divergente e recusado.
                valor: boleto.lerBoleto(linha).valorEmAberto ? it.valor : null,
                agendarPara: lote.dataAgendada || null,
                descricao: desc, referencia: `lote:${lote.id}:item:${it.id}`,
              });
              ref = b.id || null;
              novoStatus = STATUS_BILL[b.status] || 'enviado';
              // O valor efetivo do Asaas ja traz juros e multa do boleto; o do
              // titulo nao. Guardar o pago evita diferenca na conciliacao.
              if (b.value != null && Math.round(b.value * 100) !== Math.round(it.valor * 100)) {
                db.prepare('UPDATE lote_pagamento_itens SET valor = ? WHERE id = ?').run(Number(b.value), it.id);
              }
            } else {
              const tr = await asaasTransfer(cfg, { valor: it.valor, chavePix: it.chavePix, descricao: desc });
              ref = tr.id || null;
              novoStatus = 'enviado';
            }
            db.prepare(`UPDATE lote_pagamento_itens SET status = ?, provedorRef = ? WHERE id = ?`)
              .run(novoStatus, ref, it.id);
          } catch (e) {
            erros.push({ contaPagarId: it.contaPagarId, erro: e.message });
            db.prepare(`UPDATE lote_pagamento_itens SET status = 'erro', erroMensagem = ? WHERE id = ?`).run(String(e.message).slice(0, 300), it.id);
          }
        }
      } else {
        db.prepare(`UPDATE lote_pagamento_itens SET status = 'aguardando' WHERE loteId = ? AND status = 'pendente'`).run(lote.id);
      }
      db.prepare(`UPDATE lotes_pagamento SET status = 'processando', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(lote.id);
      logAction(db, req, 'processar', 'lote-pagamento', lote.id, { provedor: lote.provedor, erros: erros.length });
      res.json({ success: true, erros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Confirma pagamentos efetivados: baixa os CPs e lança as saídas no caixa.
  app.post('/api/lotes-pagamento/:id/confirmar', (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes_pagamento WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      // 'erro' é retentável: itens com falha na baixa voltam a ser processados
      // (itens 'erro' nunca tiveram transferência disparada — sem risco de duplo PIX)
      if (!['processando', 'erro'].includes(lote.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${lote.status}` });
      }
      const usuario = req.session?.username || null;
      const itens = db.prepare(`SELECT * FROM lote_pagamento_itens WHERE loteId = ? AND status IN ('aguardando','enviado','erro')`).all(lote.id);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Nada a confirmar' });

      let totalPago = 0;
      const erros = [];
      // Transação POR ITEM: se a baixa de um item falha, TUDO daquele item
      // (movimentação + pagamento + status) reverte junto — um catch dentro
      // de transação única deixava movimentação órfã do item que falhou.
      const itemTx = db.transaction((it) => baixarItemLote(db, lote, it, usuario));
      for (const it of itens) {
        try { totalPago += itemTx(it); }
        catch (e) {
          erros.push({ contaPagarId: it.contaPagarId, erro: e.message });
          db.prepare(`UPDATE lote_pagamento_itens SET status = 'erro', erroMensagem = ? WHERE id = ?`).run(String(e.message).slice(0, 300), it.id);
        }
      }
      const restam = db.prepare(`SELECT COUNT(*) n FROM lote_pagamento_itens
        WHERE loteId = ? AND status IN ('pendente','aguardando','enviado')`).get(lote.id).n;
      db.prepare(`UPDATE lotes_pagamento SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(restam === 0 ? (erros.length ? 'erro' : 'concluido') : 'processando', lote.id);
      logAction(db, req, 'confirmar', 'lote-pagamento', lote.id, { totalPago, erros: erros.length });
      res.json({ success: true, totalPago: Number(totalPago.toFixed(2)), erros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/lotes-pagamento/:id/cancelar', (req, res) => {
    try {
      const lote = db.prepare('SELECT * FROM lotes_pagamento WHERE id = ?').get(req.params.id);
      if (!lote) return res.status(404).json({ success: false, error: 'Lote não encontrado' });
      if (!['rascunho', 'processando'].includes(lote.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${lote.status}` });
      }
      const pagos = db.prepare(`SELECT COUNT(*) n FROM lote_pagamento_itens WHERE loteId = ? AND status = 'pago'`).get(lote.id).n;
      db.prepare(`UPDATE lote_pagamento_itens SET status = 'cancelado'
        WHERE loteId = ? AND status IN ('pendente','aguardando','erro')`).run(lote.id);
      db.prepare(`UPDATE lotes_pagamento SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(pagos > 0 ? 'concluido' : 'cancelado', lote.id);
      logAction(db, req, 'cancelar', 'lote-pagamento', lote.id, { itensJaPagos: pagos });
      res.json({ success: true, aviso: pagos > 0 ? `${pagos} item(ns) já pagos permanecem baixados` : undefined });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== REGRAS DE CONCILIAÇÃO ====================

  app.get('/api/conciliacao/regras', (req, res) => {
    try {
      const regras = db.prepare(`SELECT r.*, cf.nome AS contaNome,
          pc.codigo AS planoContaCodigo, pc.nome AS planoContaNome
        FROM conciliacao_regras r
        LEFT JOIN contas_financeiras cf ON cf.id = r.contaFinanceiraId
        LEFT JOIN plano_contas pc ON pc.id = r.planoContaId
        WHERE 1=1${escopoSqlHerdado(req, 'r.contaFinanceiraId', 'contas_financeiras').sql}
        ORDER BY r.prioridade DESC, r.id`).all(...escopoSqlHerdado(req, 'r.contaFinanceiraId', 'contas_financeiras').params);
      res.json({ success: true, regras, diagnostico: diagnosticoRegras(db) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Simula antes de gravar: mostra o que pegaria e avisa do que costuma dar errado.
  app.post('/api/conciliacao/regras/testar', (req, res) => {
    try {
      const b = req.body || {};
      const padrao = (b.padraoTexto || '').trim();
      if (padrao.length < 3) return res.status(400).json({ success: false, error: 'padraoTexto (min. 3 caracteres)' });
      res.json({ success: true, ...simularRegra(db, {
        contaFinanceiraId: b.contaFinanceiraId || null, padraoTexto: padrao,
        tipoLancamento: ['entrada', 'saida'].includes(b.tipoLancamento) ? b.tipoLancamento : 'ambos',
        acao: b.acao || 'categorizar', modo: b.modo === 'palavra' ? 'palavra' : 'contem',
        valorMin: b.valorMin != null && b.valorMin !== '' ? Number(b.valorMin) : null,
        valorMax: b.valorMax != null && b.valorMax !== '' ? Number(b.valorMax) : null,
      }) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/conciliacao/regras', (req, res) => {
    try {
      const { contaFinanceiraId, padraoTexto, tipoLancamento, acao, categoria, prioridade } = req.body || {};
      const padrao = (padraoTexto || '').trim();
      if (padrao.length < 3) return res.status(400).json({ success: false, error: 'padraoTexto (mín. 3 caracteres) obrigatório' });
      if (acao && !['categorizar', 'ignorar'].includes(acao)) {
        return res.status(400).json({ success: false, error: "acao: 'categorizar'|'ignorar'" });
      }
      const b = req.body || {};
      // Sem conta do plano, "categorizar" produz um texto que nao alimenta o
      // orcamento nem relatorio nenhum - vira etiqueta decorativa.
      if ((acao || 'categorizar') === 'categorizar' && !b.planoContaId) {
        return res.status(400).json({ success: false,
          error: 'Escolha a conta do plano de contas - sem ela a categorizacao nao entra no orcamento' });
      }
      const r = db.prepare(`INSERT INTO conciliacao_regras
          (contaFinanceiraId, padraoTexto, tipoLancamento, acao, categoria, prioridade,
           planoContaId, modo, valorMin, valorMax)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        contaFinanceiraId || null, padrao,
        ['entrada', 'saida'].includes(tipoLancamento) ? tipoLancamento : 'ambos',
        acao || 'categorizar', (categoria || '').trim() || null, Number(prioridade) || 0,
        b.planoContaId ? Number(b.planoContaId) : null,
        b.modo === 'palavra' ? 'palavra' : 'contem',
        b.valorMin != null && b.valorMin !== '' ? Number(b.valorMin) : null,
        b.valorMax != null && b.valorMax !== '' ? Number(b.valorMax) : null);
      logAction(db, req, 'criar', 'regra-conciliacao', r.lastInsertRowid, { padrao });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Antes so dava para mexer em ativo/prioridade/categoria. Padrao errado nao
  // tinha conserto - e tambem nao havia DELETE, entao a regra ruim ficava.
  app.put('/api/conciliacao/regras/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM conciliacao_regras WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Regra nao encontrada' });
      const b = req.body || {};
      const padrao = b.padraoTexto !== undefined ? String(b.padraoTexto).trim() : atual.padraoTexto;
      if (padrao.length < 3) return res.status(400).json({ success: false, error: 'padraoTexto (min. 3 caracteres)' });
      if (b.acao && !['categorizar', 'ignorar'].includes(b.acao)) {
        return res.status(400).json({ success: false, error: "acao: 'categorizar'|'ignorar'" });
      }
      const num = (v, atualV) => v === undefined ? atualV : (v === null || v === '' ? null : Number(v));
      // O POST já exigia a conta, o PUT não: dava para criar válida e depois
      // limpar a conta pela edição, deixando a regra rodando para o nada.
      const acaoFinal = b.acao || atual.acao;
      const planoFinal = num(b.planoContaId, atual.planoContaId);
      const ativoFinal = b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo;
      if (ativoFinal && acaoFinal === 'categorizar' && !planoFinal) {
        return res.status(400).json({ success: false,
          error: 'Regra ativa que categoriza precisa de conta do plano de contas — sem ela a classificação não chega ao orçamento' });
      }
      db.prepare(`UPDATE conciliacao_regras SET
          padraoTexto = ?, tipoLancamento = ?, acao = ?, categoria = ?, prioridade = ?,
          planoContaId = ?, modo = ?, valorMin = ?, valorMax = ?, ativo = ?
        WHERE id = ?`).run(
        padrao,
        ['entrada', 'saida', 'ambos'].includes(b.tipoLancamento) ? b.tipoLancamento : atual.tipoLancamento,
        acaoFinal,
        b.categoria !== undefined ? (String(b.categoria).trim() || null) : atual.categoria,
        b.prioridade != null ? Number(b.prioridade) : atual.prioridade,
        planoFinal,
        b.modo !== undefined ? (b.modo === 'palavra' ? 'palavra' : 'contem') : atual.modo,
        num(b.valorMin, atual.valorMin), num(b.valorMax, atual.valorMax),
        ativoFinal,
        atual.id);
      logAction(db, req, 'editar', 'regra-conciliacao', atual.id, { padrao });
      res.json({ success: true,
        avisoReprocessar: 'Transacoes ja classificadas por esta regra nao mudam sozinhas - use "Reaplicar" com reprocessamento.' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/conciliacao/regras/:id', (req, res) => {
    try {
      const r = db.prepare('SELECT * FROM conciliacao_regras WHERE id = ?').get(req.params.id);
      if (!r) return res.status(404).json({ success: false, error: 'Regra nao encontrada' });
      // A marca da regra nas transacoes some junto, senao elas ficam apontando
      // para um id que nao existe mais e ninguem consegue reprocessa-las.
      const tx = db.transaction(() => {
        db.prepare(`UPDATE transacoes_bancarias
          SET regraAplicadaId = NULL,
              categoriaSugerida = CASE WHEN conciliadaCom IS NULL THEN NULL ELSE categoriaSugerida END,
              planoContaIdSugerido = CASE WHEN conciliadaCom IS NULL THEN NULL ELSE planoContaIdSugerido END
          WHERE regraAplicadaId = ?`).run(r.id);
        db.prepare('DELETE FROM conciliacao_regras WHERE id = ?').run(r.id);
      });
      tx();
      logAction(db, req, 'excluir', 'regra-conciliacao', r.id, { padrao: r.padraoTexto });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Reaplica regras às transações pendentes de uma conta
  app.post('/api/conciliacao/regras/aplicar', (req, res) => {
    try {
      const contaFinanceiraId = Number(req.body?.contaFinanceiraId);
      if (!contaFinanceiraId) return res.status(400).json({ success: false, error: 'contaFinanceiraId obrigatório' });
      // reprocessar=true reavalia o que ja foi tocado por regra, para uma
      // correcao de regra tambem consertar o passado.
      const r = aplicarRegrasConciliacao(db, contaFinanceiraId,
        { reprocessar: req.body?.reprocessar === true });
      res.json({ success: true, ...r });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== AGENDA DE CARTÕES ====================

  // Gera previsões a partir das parcelas de pedido com bandeira (adquirente)
  app.post('/api/cartoes/agenda/gerar', (req, res) => {
    try {
      const parcelas = db.prepare(`
        SELECT pp.*, p.dataPedido, a.taxaPercentual, a.prazoLiquidacaoDias, a.id AS adquirenteId,
          -- A CR gerada no faturamento para esta parcela: mesmo pedido, mesma
          -- adquirente, mesmo numero de parcela. E o elo que faltava.
          (SELECT cr.id FROM contas_a_receber cr
             JOIN faturas fa ON fa.id = cr.faturaId
            WHERE fa.pedidoId = p.id AND cr.adquirenteCartaoId = a.id
              AND COALESCE(cr.parcelaNumero, 1) = pp.numeroParcela
            LIMIT 1) AS contaReceberId
        FROM pedido_parcelas pp
        JOIN pedidos p ON p.id = pp.pedidoId
        JOIN adquirentes_cartao a ON a.id = pp.bandeiraId
        WHERE pp.bandeiraId IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM agenda_recebiveis_cartao ag WHERE ag.parcelaId = pp.id)
          AND p.status NOT IN ('rascunho','cancelado')`).all();
      let geradas = 0;
      const tx = db.transaction(() => {
        const ins = db.prepare(`INSERT INTO agenda_recebiveis_cartao
          (parcelaId, pedidoId, adquirenteId, valorBruto, taxa, valorLiquido, dataVenda,
           dataPrevistaLiquidacao, contaReceberId)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const pp of parcelas) {
          const taxa = Number((pp.valor * (pp.taxaPercentual || 0) / 100).toFixed(2));
          const liquido = Number((pp.valor - taxa).toFixed(2));
          const base = pp.dataPedido || dataBrasilia();
          const prev = new Date(base + 'T12:00:00');
          prev.setDate(prev.getDate() + (pp.prazoLiquidacaoDias || 0));
          ins.run(pp.id, pp.pedidoId, pp.adquirenteId, pp.valor, taxa, liquido, base,
            prev.toISOString().slice(0, 10), pp.contaReceberId || null);
          geradas++;
        }
      });
      tx();
      logAction(db, req, 'gerar', 'agenda-cartao', null, { geradas });
      res.json({ success: true, geradas });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/cartoes/agenda', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT ag.*, a.nome AS adquirenteNome, p.numero AS pedidoNumero
        FROM agenda_recebiveis_cartao ag
        LEFT JOIN adquirentes_cartao a ON a.id = ag.adquirenteId
        LEFT JOIN pedidos p ON p.id = ag.pedidoId WHERE 1=1`;
      const params = [];
      // RBAC: a previsão de recebível herda a unidade da conta a receber.
      const rbacAg = escopoSqlHerdado(req, 'ag.contaReceberId', 'contas_a_receber');
      sql += rbacAg.sql; params.push(...rbacAg.params);
      if (status) { sql += ' AND ag.status = ?'; params.push(status); }
      sql += ' ORDER BY ag.dataPrevistaLiquidacao, ag.id LIMIT 300';
      res.json({ success: true, agenda: db.prepare(sql).all(...params) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Sugestões de match no extrato: entrada com valor ≈ líquido e data ±3 dias
  app.get('/api/cartoes/agenda/:id/sugestoes', (req, res) => {
    try {
      const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE id = ?').get(req.params.id);
      if (!ag) return res.status(404).json({ success: false, error: 'Previsão não encontrada' });
      const sugestoes = db.prepare(`SELECT * FROM transacoes_bancarias
        WHERE conciliadaCom IS NULL AND valor > 0
          AND ABS(valor - ?) <= 0.05
          AND date(data) BETWEEN date(?, '-3 days') AND date(?, '+3 days')
        ORDER BY ABS(julianday(data) - julianday(?)) LIMIT 10`)
        .all(ag.valorLiquido, ag.dataPrevistaLiquidacao, ag.dataPrevistaLiquidacao, ag.dataPrevistaLiquidacao);
      res.json({ success: true, sugestoes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cartoes/agenda/:id/conciliar', (req, res) => {
    try {
      const ag = db.prepare('SELECT * FROM agenda_recebiveis_cartao WHERE id = ?').get(req.params.id);
      if (!ag) return res.status(404).json({ success: false, error: 'Previsão não encontrada' });
      if (ag.status !== 'previsto') return res.status(400).json({ success: false, error: `Status atual: ${ag.status}` });
      const trxId = Number(req.body?.transacaoBancariaId);
      if (!trxId) return res.status(400).json({ success: false, error: 'transacaoBancariaId obrigatório' });
      const t = db.prepare(`SELECT t.*, cf.estabelecimentoId AS cfEstab FROM transacoes_bancarias t
        LEFT JOIN contas_financeiras cf ON cf.id = t.contaFinanceiraId WHERE t.id = ?`).get(trxId);
      if (!t || !noEscopo(req, t.cfEstab)) return res.status(404).json({ success: false, error: 'Transação não encontrada' });
      if (t.conciliadaCom) return res.status(400).json({ success: false, error: 'Transação já conciliada' });

      const divergente = Math.abs(Number(t.valor) - ag.valorLiquido) > 0.05;
      const usuario = req.session?.username || 'cartoes';
      const dataLiq = String(t.data || '').slice(0, 10) || dataBrasilia();
      const resultado = { divergente, crBaixada: null, taxaLancada: null, avisos: [] };

      const tx = db.transaction(() => {
        db.prepare(`UPDATE agenda_recebiveis_cartao SET status = ?, transacaoBancariaId = ?,
          dataLiquidacao = ?,
          observacao = CASE WHEN ? THEN 'Divergência: extrato R$ ' || ? || ' × previsto R$ ' || ? ELSE observacao END
          WHERE id = ?`).run(divergente ? 'divergente' : 'conciliado', t.id, dataLiq,
          divergente ? 1 : 0, t.valor, ag.valorLiquido, ag.id);
        db.prepare(`UPDATE transacoes_bancarias SET conciliadaCom = 'cartao', conciliadaId = ?,
          conciliadaEm = CURRENT_TIMESTAMP, conciliadaPor = ? WHERE id = ?`)
          .run(ag.id, usuario, t.id);

        // ===== A agenda manda na baixa =====
        // Quem sabe que o dinheiro entrou e o extrato, e quem representa isso e
        // a agenda. Antes, conciliar o recebivel deixava a CR aberta para
        // sempre — o contas a receber nunca fechava sozinho.
        if (!ag.contaReceberId) { resultado.avisos.push('Recebível sem conta a receber vinculada — a CR não foi baixada'); return; }
        const cr = db.prepare('SELECT * FROM contas_a_receber WHERE id = ?').get(ag.contaReceberId);
        if (!cr) { resultado.avisos.push('Conta a receber vinculada não existe mais'); return; }
        if (!['aberta', 'parcial'].includes(cr.status)) {
          resultado.avisos.push(`Conta a receber já está ${cr.status} — nada foi baixado`);
          return;
        }

        const adq = db.prepare('SELECT * FROM adquirentes_cartao WHERE id = ?').get(ag.adquirenteId) || {};
        const contaFin = adq.contaFinanceiraPadraoId || t.contaFinanceiraId;

        // Faturamento BRUTO: a CR e baixada pelo valor cheio e a taxa vira
        // despesa. Baixar pelo liquido encolheria a receita e esconderia o
        // custo do meio de pagamento.
        db.prepare(`INSERT INTO contas_receber_pagamentos
            (contaReceberId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
             formaPagamento, contaFinanceiraId, origem, observacoes, usuario)
          VALUES (?, ?, ?, ?, 0, 0, 0, 'cartao', ?, 'cartao_adquirente', ?, ?)`)
          .run(cr.id, dataLiq, ag.valorBruto, ag.valorBruto, contaFin,
               `Liquidação ${adq.nome || 'cartão'} — recebível #${ag.id}`, usuario);
        db.prepare(`UPDATE contas_a_receber SET status = 'paga', valorPago = ?, dataPagamento = ?,
            contaFinanceiraId = COALESCE(contaFinanceiraId, ?), dataAtualizacao = CURRENT_TIMESTAMP
          WHERE id = ?`).run(ag.valorBruto, dataLiq, contaFin, cr.id);
        resultado.crBaixada = { id: cr.id, valor: ag.valorBruto };

        // Entrada bruta + saida da taxa: o saldo da conta fica no liquido, que
        // e o que o banco creditou, e os dois lados ficam visiveis.
        if (contaFin) {
          lancarMovimentacao(db, { contaId: contaFin, tipo: 'entrada', valor: ag.valorBruto, data: dataLiq,
            descricao: `Liquidação cartão ${adq.nome || ''} — recebível #${ag.id}`.trim(),
            origem: 'cartao_liquidacao', origemId: ag.id, categoria: 'vendas', usuario });
        }

        // ===== Taxa como despesa financeira =====
        if (ag.taxa > 0) {
          const planoId = contaPlanoTaxaCartao(db);
          if (!planoId) { resultado.avisos.push('Sem conta de despesa financeira no plano — a taxa não foi lançada'); return; }
          const fornId = fornecedorDaAdquirente(db, { id: ag.adquirenteId, nome: adq.nome || 'Adquirente', cnpj: adq.cnpj });
          const cpId = db.prepare(`INSERT INTO contas_a_pagar
              (fornecedorId, descricao, valor, dataEmissao, dataVencimento, status, origem, planoContaId)
            VALUES (?, ?, ?, ?, ?, 'aberta', 'taxa_cartao', ?)`)
            .run(fornId, `Taxa ${adq.nome || 'cartão'} — recebível #${ag.id}`, ag.taxa, dataLiq, dataLiq, planoId)
            .lastInsertRowid;
          db.prepare(`INSERT INTO contas_pagar_pagamentos
              (contaPagarId, dataPagamento, valorPago, valorBase, juros, multa, desconto,
               formaPagamento, contaFinanceiraId, origem, observacoes, usuario)
            VALUES (?, ?, ?, ?, 0, 0, 0, 'desconto_adquirente', ?, 'taxa_cartao', ?, ?)`)
            .run(cpId, dataLiq, ag.taxa, ag.taxa, contaFin, 'Retida pela adquirente na liquidação', usuario);
          db.prepare(`UPDATE contas_a_pagar SET status = 'paga', valorPago = ?, dataPagamento = ?,
              dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(ag.taxa, dataLiq, cpId);
          db.prepare('UPDATE agenda_recebiveis_cartao SET contaPagarTaxaId = ? WHERE id = ?').run(cpId, ag.id);

          if (contaFin) {
            lancarMovimentacao(db, { contaId: contaFin, tipo: 'saida', valor: ag.taxa, data: dataLiq,
              descricao: `Taxa ${adq.nome || 'cartão'} — recebível #${ag.id}`,
              origem: 'taxa_cartao', origemId: ag.id, categoria: 'taxas', usuario });
          }
          resultado.taxaLancada = { contaPagarId: cpId, valor: ag.taxa, planoContaId: planoId };
        }
      });
      tx();
      logAction(db, req, 'conciliar', 'agenda-cartao', ag.id, resultado);
      res.json({ success: true, ...resultado });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasTesouraria, migrarTesourariaDB, aplicarRegrasConciliacao, tipoChavePix,
  migrarRegrasConciliacao, travarRegraSemConta, regraCasa, simularRegra, diagnosticoRegras,
  registrarRotasBoletos, asaasPagarBoleto, asaasConsultarBoleto, asaasListarBoletos, STATUS_BILL,
  migrarAgendaCartao, fornecedorDaAdquirente, contaPlanoTaxaCartao,
  migrarPagamentoAutomaticoCP, podePagarAutomatico, pagarRecorrentesPorPix };
