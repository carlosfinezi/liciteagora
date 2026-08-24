/**
 * boleto-orchestrator.js — Orquestrador unificado de emissão/consulta de boletos.
 *
 * Ponto único que abstrai provedores (Sicredi, MP, BB, Manual, etc.) por trás
 * de uma API comum:
 *
 *   emitirBoletoParaCR(db, contaReceberId) → { sucesso, boletoId, provedor, nossoNumero, ... }
 *   consultarBoleto(db, boletoId)
 *   processarWebhook(db, nomeProvedor, req)
 *
 * Resolve o provedor a partir da conta financeira vinculada à CR. Cada provedor
 * mora em /boleto-provedores/<nome>.js.
 */

const path = require('path');
const Database = require('better-sqlite3');
const provedores = require('./boleto-provedores');
const { permitidosDaPessoa, mensagemBloqueio } = require('./meios-pagamento');

// Cliente com whitelist de meios de recebimento: emitir boleto/PIX fora dela é
// recusado aqui, no ponto único por onde passam loja, NFS-e, faturamento
// automático e a geração manual na tela de contas a receber.
function bloqueioPorMeio(db, pessoaId, meio) {
  const permitidos = permitidosDaPessoa(db, pessoaId);
  if (!permitidos || permitidos.includes(meio === 'pix' ? '17' : '15')) return null;
  return { skipped: true, motivo: mensagemBloqueio(permitidos, meio) };
}

// ==================== SPLIT DA PLATAFORMA (Asaas) ====================
// Forçado server-side. Tenant não vê nem edita — quem configura é o super
// admin em admin.liciteagora.app, e o valor mora no control.db:
//   config.asaas_split_ativo        — '1' | '0'
//   config.asaas_split_wallet_id    — wallet de destino (ex.: wallet 1bit)
//   config.asaas_split_percentual   — % aplicada em cada cobrança (ex.: 0.5)
//   tenants.split_asaas_modo        — 'padrao' | 'isento' | 'proprio'
//   tenants.split_asaas_percentual  — % do tenant quando modo = 'proprio'
//
// Enquanto uma chave global não for gravada pelo admin, vale o env da unit
// (ASAAS_PLATFORM_WALLET_ID / ASAAS_PLATFORM_FEE_PERCENT) — assim o
// comportamento não muda até alguém salvar a primeira vez no painel.

const CONTROL_DB_PATH = process.env.CONTROL_DB_PATH
  || path.join(__dirname, 'data', 'control.db');

let _controlDb = null;
function getControlDbReadonly() {
  if (_controlDb) return _controlDb;
  try {
    _controlDb = new Database(CONTROL_DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.warn('[boleto-orchestrator] control.db indisponível:', e.message);
    _controlDb = null;
  }
  return _controlDb;
}

const _slugCache = new Map();
function getTenantSlugFromDb(db) {
  const dbPath = db && db.name;
  if (!dbPath) return null;
  if (_slugCache.has(dbPath)) return _slugCache.get(dbPath);
  const ctrl = getControlDbReadonly();
  if (!ctrl) return null;
  try {
    const row = ctrl.prepare('SELECT slug FROM tenants WHERE db_path = ?').get(dbPath);
    const slug = row ? row.slug : null;
    _slugCache.set(dbPath, slug);
    return slug;
  } catch (e) {
    console.warn('[boleto-orchestrator] lookup slug falhou:', e.message);
    return null;
  }
}

// Teto do split por BOLETO, em reais. Acima dele a taxa deixa de ser
// percentual e vira valor fixo — a tarifa do Asaas por boleto emitido já é
// alta e o split não deve crescer junto com o valor do título. Vale só para
// boleto: o PIX não tem essa tarifa e segue percentual puro.
const TETO_BOLETO_PADRAO = 2.00;

// Config global do split, com o env como fallback de cada campo.
// Sem cache: emissão de cobrança é rara e mudança no admin tem de valer já.
function lerSplitGlobal() {
  let ativo = true;
  let walletId = process.env.ASAAS_PLATFORM_WALLET_ID || '';
  let pct = Number(process.env.ASAAS_PLATFORM_FEE_PERCENT);
  let tetoBoleto = TETO_BOLETO_PADRAO;
  const ctrl = getControlDbReadonly();
  if (ctrl) {
    try {
      const rows = ctrl.prepare(`
        SELECT chave, valor FROM config
         WHERE chave IN ('asaas_split_ativo', 'asaas_split_wallet_id',
                         'asaas_split_percentual', 'asaas_split_teto_boleto')
      `).all();
      for (const r of rows) {
        if (r.valor == null || r.valor === '') continue;
        if (r.chave === 'asaas_split_ativo') ativo = r.valor === '1';
        else if (r.chave === 'asaas_split_wallet_id') walletId = r.valor;
        else if (r.chave === 'asaas_split_percentual') pct = Number(r.valor);
        else if (r.chave === 'asaas_split_teto_boleto') tetoBoleto = Number(r.valor);
      }
    } catch (e) {
      console.warn('[boleto-orchestrator] leitura do split global falhou:', e.message);
    }
  }
  return { ativo, walletId: String(walletId).trim(), pct, tetoBoleto };
}

// Escolha do tenant: { modo, percentual }. NULL/ausente → segue o global.
function lerSplitDoTenant(tenantSlug) {
  if (!tenantSlug) return null;
  const ctrl = getControlDbReadonly();
  if (!ctrl) return null;
  try {
    const row = ctrl.prepare(
      'SELECT split_asaas_modo AS modo, split_asaas_percentual AS percentual FROM tenants WHERE slug = ?'
    ).get(tenantSlug);
    return row || null;
  } catch (e) {
    console.warn('[boleto-orchestrator] leitura do split do tenant falhou:', e.message);
    return null;
  }
}

function aplicarSplitPlataforma(modulo, cfg, tenantSlug) {
  if (!modulo || modulo.nome !== 'asaas') return;
  const global = lerSplitGlobal();
  if (!global.ativo || !global.walletId) return;

  const doTenant = lerSplitDoTenant(tenantSlug);
  if (doTenant && doTenant.modo === 'isento') return;

  let pct = global.pct;
  if (doTenant && doTenant.modo === 'proprio') pct = Number(doTenant.percentual);
  if (!Number.isFinite(pct) || pct <= 0) return;

  // server tem palavra final — sobrescreve qualquer valor que viesse do tenant
  cfg.splitWalletId = global.walletId;
  cfg.splitPercentual = pct;
  cfg.splitTetoBoleto = global.tetoBoleto;
}

// ==================== MIGRAÇÃO DE SCHEMA (idempotente) ====================

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ok */ } }

function migrarSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contas_financeiras_boleto (
      contaFinanceiraId INTEGER PRIMARY KEY,
      provedor TEXT NOT NULL,
      ambiente TEXT DEFAULT 'homologacao',
      ativo INTEGER DEFAULT 0,
      configJson TEXT,
      certificadoBase64 TEXT,
      certificadoSenhaCripto TEXT,
      proximoNossoNumero INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contaFinanceiraId) REFERENCES contas_financeiras(id) ON DELETE CASCADE
    );
  `);
  alterSafe(db, 'ALTER TABLE boletos ADD COLUMN provedor TEXT');
  alterSafe(db, 'ALTER TABLE boletos ADD COLUMN contaFinanceiraId INTEGER');
  alterSafe(db, 'ALTER TABLE boletos ADD COLUMN nossoNumero TEXT');
  alterSafe(db, 'ALTER TABLE boletos ADD COLUMN linhaDigitavel TEXT');
  alterSafe(db, "ALTER TABLE boletos ADD COLUMN tipoCobranca TEXT DEFAULT 'boleto'");
  alterSafe(db, 'ALTER TABLE boletos ADD COLUMN pixPayload TEXT');
  alterSafe(db, 'ALTER TABLE boletos ADD COLUMN pixQrImage TEXT');
  alterSafe(db, `CREATE INDEX IF NOT EXISTS idx_boletos_provedor ON boletos(provedor)`);
  alterSafe(db, `CREATE INDEX IF NOT EXISTS idx_boletos_nosso_numero ON boletos(nossoNumero)`);
  alterSafe(db, 'ALTER TABLE contas_financeiras_boleto ADD COLUMN ehPadrao INTEGER DEFAULT 0');
}

// Retorna a conta financeira marcada como padrão para emissão de boletos
// (ou null se não houver). Single source of truth pra quem emite sem especificar.
function getContaFinanceiraPadraoBoleto(db) {
  const row = db.prepare(`SELECT contaFinanceiraId FROM contas_financeiras_boleto
    WHERE ativo = 1 AND ehPadrao = 1 LIMIT 1`).get();
  if (row) return row.contaFinanceiraId;
  // Fallback: primeira ativa
  const row2 = db.prepare(`SELECT contaFinanceiraId FROM contas_financeiras_boleto
    WHERE ativo = 1 ORDER BY contaFinanceiraId LIMIT 1`).get();
  return row2 ? row2.contaFinanceiraId : null;
}

// ==================== HELPERS ====================

function parseConfigJson(cfgRow) {
  if (!cfgRow) return null;
  let configJson = {};
  try { configJson = JSON.parse(cfgRow.configJson || '{}'); } catch {}
  return {
    contaFinanceiraId: cfgRow.contaFinanceiraId,
    provedor: cfgRow.provedor,
    ambiente: cfgRow.ambiente,
    ativo: !!cfgRow.ativo,
    proximoNossoNumero: Number(cfgRow.proximoNossoNumero) || 1,
    certificadoBase64: cfgRow.certificadoBase64,
    certificadoSenha: cfgRow.certificadoSenhaCripto
      ? Buffer.from(cfgRow.certificadoSenhaCripto, 'base64').toString('utf-8')
      : null,
    ...configJson,
  };
}

function getProvedorConfig(db, contaFinanceiraId) {
  const row = db.prepare(`SELECT * FROM contas_financeiras_boleto WHERE contaFinanceiraId = ?`)
    .get(contaFinanceiraId);
  if (!row || !row.ativo) return null;
  const modulo = provedores.get(row.provedor);
  if (!modulo) return null;
  return { modulo, cfg: parseConfigJson(row) };
}

function consumirProximoNossoNumero(db, contaFinanceiraId) {
  const trx = db.transaction(() => {
    const row = db.prepare('SELECT proximoNossoNumero FROM contas_financeiras_boleto WHERE contaFinanceiraId = ?').get(contaFinanceiraId);
    const atual = row ? (Number(row.proximoNossoNumero) || 1) : 1;
    db.prepare('UPDATE contas_financeiras_boleto SET proximoNossoNumero = ? WHERE contaFinanceiraId = ?')
      .run(atual + 1, contaFinanceiraId);
    return atual;
  });
  return trx();
}

// ==================== EMISSÃO ====================

/**
 * Emite boleto para uma conta a receber usando o provedor da conta financeira
 * vinculada. Retorna null se não houver provedor ativo (caller pode cair em
 * fluxo alternativo, ex.: PIX manual ou deixar pendente).
 */
async function emitirBoletoParaCR(db, contaReceberId) {
  const cr = db.prepare(`
    SELECT c.*, p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaDoc, p.email AS pessoaEmail,
      p.endereco, p.numero, p.bairro, p.cidade, p.uf, p.cep
    FROM contas_a_receber c
    LEFT JOIN pessoas p ON p.id = c.pessoaId
    WHERE c.id = ?
  `).get(contaReceberId);
  if (!cr) throw new Error(`CR #${contaReceberId} não encontrada`);

  const bloqueio = bloqueioPorMeio(db, cr.pessoaId, 'boleto');
  if (bloqueio) return bloqueio;

  // Se a CR não tem conta financeira vinculada, usa a padrão de boleto (se existir)
  let contaFinanceiraId = cr.contaFinanceiraId;
  if (!contaFinanceiraId) {
    contaFinanceiraId = getContaFinanceiraPadraoBoleto(db);
    if (!contaFinanceiraId) return { skipped: true, motivo: 'Sem conta financeira padrão para emissão de boletos' };
    // Atualiza CR pra refletir a escolha — facilita auditoria e conciliação
    try { db.prepare('UPDATE contas_a_receber SET contaFinanceiraId = ? WHERE id = ?').run(contaFinanceiraId, cr.id); } catch {}
  }

  const resolvido = getProvedorConfig(db, contaFinanceiraId);
  if (!resolvido) return { skipped: true, motivo: 'Conta financeira sem provedor de boleto ativo' };

  const { modulo, cfg } = resolvido;
  aplicarSplitPlataforma(modulo, cfg, getTenantSlugFromDb(db));
  const nossoNumero = consumirProximoNossoNumero(db, contaFinanceiraId);

  const payload = {
    valor: Number(cr.valor),
    dataVencimento: cr.dataVencimento,
    nossoNumero: String(nossoNumero),
    seuNumero: `CR-${cr.id}`,
    descricao: cr.descricao || `Cobrança CR #${cr.id}`,
    pagador: {
      documento: cr.pessoaDoc || '',
      nome: cr.pessoaNome || '',
      email: cr.pessoaEmail || '',
      endereco: {
        logradouro: cr.endereco, numero: cr.numero, bairro: cr.bairro,
        cidade: cr.cidade, uf: cr.uf, cep: cr.cep,
      },
    },
  };

  const resp = await modulo.criarBoleto(db, cfg, payload);

  // Grava em `boletos` — preserva compat com colunas antigas (mpId, etc.)
  const boletoId = db.prepare(`
    INSERT INTO boletos (
      contaReceberId, contaFinanceiraId, provedor, nossoNumero,
      linhaDigitavel, writableLine, barcode, externalUrl,
      amount, expirationDate, status, mpId,
      customerDocument, customerName
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registrado', ?, ?, ?)
  `).run(
    contaReceberId, contaFinanceiraId, modulo.nome, resp.nossoNumero,
    resp.linhaDigitavel, resp.linhaDigitavel, resp.codigoBarras, resp.urlBoleto,
    Math.round(Number(cr.valor) * 100), cr.dataVencimento,
    resp.nossoNumero, // mpId: preserva compat — MP grava aqui o payment id
    cr.pessoaDoc || '', cr.pessoaNome || ''
  ).lastInsertRowid;

  return {
    sucesso: true,
    boletoId,
    provedor: modulo.nome,
    nossoNumero: resp.nossoNumero,
    linhaDigitavel: resp.linhaDigitavel,
    codigoBarras: resp.codigoBarras,
    urlBoleto: resp.urlBoleto,
  };
}

// Cria uma cobrança PIX (QR dinâmico + link) para uma CR, gravando em `boletos`
// com tipoCobranca='pix'. Reusa toda a infra de provedor/webhook do boleto.
async function emitirCobrancaPixParaCR(db, contaReceberId) {
  const cr = db.prepare(`
    SELECT c.*, p.razaoSocial AS pessoaNome, p.cpfCnpj AS pessoaDoc, p.email AS pessoaEmail,
      p.endereco, p.numero, p.bairro, p.cidade, p.uf, p.cep
    FROM contas_a_receber c
    LEFT JOIN pessoas p ON p.id = c.pessoaId
    WHERE c.id = ?
  `).get(contaReceberId);
  if (!cr) throw new Error(`CR #${contaReceberId} não encontrada`);

  const bloqueio = bloqueioPorMeio(db, cr.pessoaId, 'pix');
  if (bloqueio) return bloqueio;

  let contaFinanceiraId = cr.contaFinanceiraId;
  if (!contaFinanceiraId) {
    contaFinanceiraId = getContaFinanceiraPadraoBoleto(db);
    if (!contaFinanceiraId) return { skipped: true, motivo: 'Sem conta financeira padrão para cobranças' };
    try { db.prepare('UPDATE contas_a_receber SET contaFinanceiraId = ? WHERE id = ?').run(contaFinanceiraId, cr.id); } catch {}
  }

  const resolvido = getProvedorConfig(db, contaFinanceiraId);
  if (!resolvido) return { skipped: true, motivo: 'Conta financeira sem provedor ativo' };

  const { modulo, cfg } = resolvido;
  if (typeof modulo.criarPix !== 'function') return { skipped: true, motivo: `Provedor ${modulo.nome} não suporta PIX` };
  aplicarSplitPlataforma(modulo, cfg, getTenantSlugFromDb(db));
  const nossoNumero = consumirProximoNossoNumero(db, contaFinanceiraId);

  const payload = {
    valor: Number(cr.valor),
    dataVencimento: cr.dataVencimento,
    nossoNumero: String(nossoNumero),
    seuNumero: `CR-${cr.id}`,
    descricao: cr.descricao || `Cobrança PIX CR #${cr.id}`,
    pagador: {
      documento: cr.pessoaDoc || '',
      nome: cr.pessoaNome || '',
      email: cr.pessoaEmail || '',
      endereco: {
        logradouro: cr.endereco, numero: cr.numero, bairro: cr.bairro,
        cidade: cr.cidade, uf: cr.uf, cep: cr.cep,
      },
    },
  };

  const resp = await modulo.criarPix(db, cfg, payload);

  const boletoId = db.prepare(`
    INSERT INTO boletos (
      contaReceberId, contaFinanceiraId, provedor, nossoNumero,
      externalUrl, amount, expirationDate, status, mpId,
      customerDocument, customerName, tipoCobranca, pixPayload, pixQrImage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'registrado', ?, ?, ?, 'pix', ?, ?)
  `).run(
    contaReceberId, contaFinanceiraId, modulo.nome, resp.nossoNumero,
    resp.invoiceUrl || '', Math.round(Number(cr.valor) * 100), cr.dataVencimento,
    resp.nossoNumero, cr.pessoaDoc || '', cr.pessoaNome || '',
    resp.pixPayload || null, resp.pixQrImage || null
  ).lastInsertRowid;

  return {
    sucesso: true, boletoId, provedor: modulo.nome, nossoNumero: resp.nossoNumero,
    invoiceUrl: resp.invoiceUrl, pixPayload: resp.pixPayload, pixQrImage: resp.pixQrImage,
  };
}

async function consultarBoleto(db, boletoId) {
  const b = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);
  if (!b) throw new Error('Boleto não encontrado');
  if (!b.provedor || !b.contaFinanceiraId) return { status: b.status, mensagem: 'Boleto legado (sem provedor ou conta vinculada)' };
  const resolvido = getProvedorConfig(db, b.contaFinanceiraId);
  if (!resolvido) return { status: b.status, mensagem: 'Provedor desativado' };
  return await resolvido.modulo.consultarBoleto(db, resolvido.cfg, b.nossoNumero);
}

async function baixarBoleto(db, boletoId, motivo) {
  const b = db.prepare('SELECT * FROM boletos WHERE id = ?').get(boletoId);
  if (!b) throw new Error('Boleto não encontrado');
  const resolvido = getProvedorConfig(db, b.contaFinanceiraId);
  if (!resolvido) throw new Error('Provedor desativado');
  return await resolvido.modulo.baixarBoleto(db, resolvido.cfg, b.nossoNumero, motivo);
}

async function processarWebhook(db, nomeProvedor, req) {
  const modulo = provedores.get(nomeProvedor);
  if (!modulo) throw new Error(`Provedor desconhecido: ${nomeProvedor}`);
  // Webhook precisa achar a config — em multi-tenant já estamos no contexto do tenant.
  // Sem configuração ativa, ignoramos (não é erro: webhook pode chegar depois da desativação).
  const cfgRow = db.prepare(`SELECT * FROM contas_financeiras_boleto WHERE provedor = ? AND ativo = 1`).get(nomeProvedor);
  if (!cfgRow) return { skipped: true };
  const cfg = parseConfigJson(cfgRow);
  const evento = await modulo.processarWebhook(req, db, cfg);
  if (!evento || !evento.contaReceberId) return { skipped: true };
  // Atualiza CR e boleto
  if (evento.status === 'pago') {
    // Baixa completa (registra pagamento + lança movimentação no caixa), igual ao
    // polling do MercadoPago. Idempotente: webhook pode reentregar, então só baixa
    // CR ainda aberta/parcial.
    const cr = db.prepare('SELECT status, contaFinanceiraId FROM contas_a_receber WHERE id = ?').get(evento.contaReceberId);
    if (cr && cr.status !== 'paga' && cr.status !== 'cancelada') {
      let contaFinanceiraId = cr.contaFinanceiraId;
      if (evento.boletoId) {
        const b = db.prepare('SELECT contaFinanceiraId FROM boletos WHERE id = ?').get(evento.boletoId);
        if (b && b.contaFinanceiraId) contaFinanceiraId = b.contaFinanceiraId;
      }
      try {
        const { registrarBaixaCR } = require('./contas-receber-routes');
        registrarBaixaCR(db, {
          contaReceberId: evento.contaReceberId,
          dataPagamento: evento.dataPagamento || undefined,
          contaFinanceiraId,
          formaPagamento: 'boleto',
          origem: `webhook_${nomeProvedor}`,
          observacoes: `Baixa automática via webhook ${nomeProvedor}${evento.boletoId ? ` (boleto #${evento.boletoId})` : ''}`,
        });
      } catch (e) {
        console.error(`[Webhook ${nomeProvedor}] erro baixando CR ${evento.contaReceberId}:`, e.message);
      }
    }
    if (evento.boletoId) {
      db.prepare(`UPDATE boletos SET status = 'pago', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(evento.boletoId);
    }
  }
  return { aplicado: true, evento };
}

/**
 * Conciliação Asaas (rede de segurança do webhook). Varre as cobranças Asaas
 * ainda 'registrado', consulta o status real no Asaas e dá baixa completa nas
 * pagas — cobrindo eventos perdidos (fila do webhook interrompida, app fora na
 * entrega, etc.).
 *
 * Dois ciclos, porque a expectativa do pagador é diferente em cada forma:
 *
 *   PIX    — a cada 2 min, só cobranças PIX das últimas 48h. O pagador vê o
 *            dinheiro sair na hora e espera a baixa quase imediata; meia hora
 *            de atraso passa por sistema quebrado. A janela de 48h existe para
 *            o ciclo curto não varrer PIX velho que já venceu e nunca vai ser
 *            pago — o custo por chamada é do plano de API do Asaas.
 *   BOLETO — a cada 30 min. Liquidação bancária é D+1 útil de qualquer jeito,
 *            então ciclo curto só gastaria chamada sem antecipar nada.
 *
 * Nenhum dos dois é o caminho principal: com o webhook em pé a baixa sai em
 * segundos e estes ciclos não acham nada para fazer.
 */
function agendarPollingBoletosAsaas(db) {
  const INTERVALO_BOLETO = 30 * 60 * 1000; // 30 min
  const INTERVALO_PIX = 2 * 60 * 1000;     // 2 min

  async function verificar({ apenasPix = false } = {}) {
    const tag = apenasPix ? '[Polling Asaas PIX]' : '[Polling Asaas]';
    let cfgRow;
    try {
      cfgRow = db.prepare(`SELECT * FROM contas_financeiras_boleto WHERE provedor = 'asaas' AND ativo = 1`).get();
    } catch { return; }
    if (!cfgRow) return;
    const modulo = provedores.get('asaas');
    if (!modulo) return;
    const cfg = parseConfigJson(cfgRow);

    // O ciclo de 30 min continua sendo a rede completa: varre TUDO que está
    // registrado, PIX incluído. O de 2 min é só um acelerador por cima do PIX
    // recente. A sobreposição é de propósito — excluir o PIX do ciclo lento
    // deixaria o PIX pago depois de 48h sem nenhuma varredura. Consultar a
    // mesma cobrança duas vezes a cada 30 min é barato; perder a baixa não é.
    // Baixa dupla não acontece: a leitura do status da CR e o registro da
    // baixa são síncronos, sem await no meio.
    const filtro = apenasPix
      ? `AND tipoCobranca = 'pix' AND dataCriacao >= datetime('now', '-2 days')`
      : '';

    let cobrancas;
    try {
      cobrancas = db.prepare(`SELECT id, nossoNumero, contaReceberId, contaFinanceiraId,
          COALESCE(tipoCobranca, 'boleto') AS tipoCobranca
        FROM boletos
        WHERE provedor = 'asaas' AND status = 'registrado' AND nossoNumero IS NOT NULL
        ${filtro}`).all();
    } catch { return; }
    if (!cobrancas.length) return;

    const { registrarBaixaCR } = require('./contas-receber-routes');
    let baixados = 0;
    for (const b of cobrancas) {
      try {
        const r = await modulo.consultarBoleto(db, cfg, b.nossoNumero);
        const sit = String((r && r.situacao) || '').toUpperCase();
        const pago = sit === 'RECEIVED' || sit === 'CONFIRMED' || sit === 'RECEIVED_IN_CASH';
        if (!pago) continue;
        const cr = b.contaReceberId
          ? db.prepare('SELECT status FROM contas_a_receber WHERE id = ?').get(b.contaReceberId)
          : null;
        if (cr && cr.status !== 'paga' && cr.status !== 'cancelada') {
          registrarBaixaCR(db, {
            contaReceberId: b.contaReceberId,
            dataPagamento: r.dataPagamento || undefined,
            contaFinanceiraId: b.contaFinanceiraId,
            // Antes era 'boleto' fixo: cobrança PIX baixava como boleto e a
            // conciliação por forma de pagamento saía errada.
            formaPagamento: b.tipoCobranca === 'pix' ? 'pix' : 'boleto',
            origem: 'polling_asaas',
            observacoes: `Conciliação Asaas (${b.tipoCobranca} #${b.id} / ${b.nossoNumero})`,
          });
        }
        db.prepare(`UPDATE boletos SET status = 'pago', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(b.id);
        baixados++;
        console.log(`${tag} ${b.tipoCobranca} #${b.id} (${b.nossoNumero}): registrado -> pago`);
      } catch (e) {
        console.error(`${tag} erro ${b.tipoCobranca} #${b.id}:`, e.message);
      }
    }
    if (baixados) console.log(`${tag} ${baixados} baixa(s) de ${cobrancas.length} consultado(s)`);
  }

  setInterval(() => { verificar().catch(() => {}); }, INTERVALO_BOLETO);
  setTimeout(() => { verificar().catch(() => {}); }, 90 * 1000); // 1ª passada após o boot

  setInterval(() => { verificar({ apenasPix: true }).catch(() => {}); }, INTERVALO_PIX);
  setTimeout(() => { verificar({ apenasPix: true }).catch(() => {}); }, 20 * 1000);

  console.log('[Polling Asaas] Agendado: boleto a cada 30 min, PIX a cada 2 min');
}

module.exports = {
  migrarSchema,
  emitirBoletoParaCR,
  emitirCobrancaPixParaCR,
  consultarBoleto,
  baixarBoleto,
  processarWebhook,
  agendarPollingBoletosAsaas,
  getContaFinanceiraPadraoBoleto,
  _internal: { getProvedorConfig, parseConfigJson, consumirProximoNossoNumero, aplicarSplitPlataforma },
};
