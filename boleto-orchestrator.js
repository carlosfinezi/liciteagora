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

// ==================== SPLIT DA PLATAFORMA (Asaas) ====================
// Forçado server-side via env. Tenant não vê nem edita.
//   ASAAS_PLATFORM_WALLET_ID    — wallet de destino (ex.: wallet 1bit)
//   ASAAS_PLATFORM_FEE_PERCENT  — % aplicada em cada boleto (ex.: 0.5)
//   ASAAS_PLATFORM_TENANT_SLUG  — slug isento (ex.: 1bit) — não recebe split

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

function aplicarSplitPlataforma(modulo, cfg, tenantSlug) {
  if (!modulo || modulo.nome !== 'asaas') return;
  const walletId = process.env.ASAAS_PLATFORM_WALLET_ID;
  const pct = Number(process.env.ASAAS_PLATFORM_FEE_PERCENT);
  if (!walletId || !Number.isFinite(pct) || pct <= 0) return;
  const exemptSlug = process.env.ASAAS_PLATFORM_TENANT_SLUG;
  if (exemptSlug && tenantSlug && tenantSlug === exemptSlug) return;
  // server tem palavra final — sobrescreve qualquer valor que viesse do tenant
  cfg.splitWalletId = walletId;
  cfg.splitPercentual = pct;
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
 * Conciliação Asaas (rede de segurança do webhook). Varre os boletos Asaas ainda
 * 'registrado', consulta o status real no Asaas e dá baixa completa nos pagos —
 * cobrindo eventos perdidos (fila do webhook interrompida, app fora na entrega, etc.).
 * Roda a cada 30 min, espelhando agendarPollingBoletos (MercadoPago).
 */
function agendarPollingBoletosAsaas(db) {
  const INTERVALO = 30 * 60 * 1000; // 30 min

  async function verificar() {
    let cfgRow;
    try {
      cfgRow = db.prepare(`SELECT * FROM contas_financeiras_boleto WHERE provedor = 'asaas' AND ativo = 1`).get();
    } catch { return; }
    if (!cfgRow) return;
    const modulo = provedores.get('asaas');
    if (!modulo) return;
    const cfg = parseConfigJson(cfgRow);

    let boletos;
    try {
      boletos = db.prepare(`SELECT id, nossoNumero, contaReceberId, contaFinanceiraId
        FROM boletos WHERE provedor = 'asaas' AND status = 'registrado' AND nossoNumero IS NOT NULL`).all();
    } catch { return; }
    if (!boletos.length) return;

    const { registrarBaixaCR } = require('./contas-receber-routes');
    let baixados = 0;
    for (const b of boletos) {
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
            formaPagamento: 'boleto',
            origem: 'polling_asaas',
            observacoes: `Conciliação Asaas (boleto #${b.id} / ${b.nossoNumero})`,
          });
        }
        db.prepare(`UPDATE boletos SET status = 'pago', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(b.id);
        baixados++;
        console.log(`[Polling Asaas] boleto #${b.id} (${b.nossoNumero}): registrado -> pago`);
      } catch (e) {
        console.error(`[Polling Asaas] erro boleto #${b.id}:`, e.message);
      }
    }
    if (baixados) console.log(`[Polling Asaas] ${baixados} baixa(s) de ${boletos.length} consultado(s)`);
  }

  setInterval(() => { verificar().catch(() => {}); }, INTERVALO);
  setTimeout(() => { verificar().catch(() => {}); }, 90 * 1000); // 1ª passada após o boot
  console.log('[Polling Asaas] Agendado a cada 30 minutos');
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
  _internal: { getProvedorConfig, parseConfigJson, consumirProximoNossoNumero },
};
