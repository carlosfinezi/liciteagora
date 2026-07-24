/**
 * os-routes.js — Ordem de Serviço (OS): assistência, manutenção, instalação.
 *
 * Modelo:
 *   os_ordens         — cabeçalho (cliente, técnico, status, equipamento, defeito, solução)
 *   os_itens_pecas    — produtos consumidos (gera saída de estoque ao concluir)
 *   os_itens_servicos — serviços/horas (linha livre)
 *   os_apontamentos   — registro de tempo de execução
 *
 * Status: aberta | em-andamento | aguardando-peca | concluida | faturada | cancelada
 *
 * Faturamento: cria um pedido vinculado com itens de peças + linhas de serviço como
 * itens (sem produtoId). NF-e/NFSe ficam manuais.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { logAction } = require('./audit-log');
const { emitirNfseInterno } = require('./nfse-routes');
const { emitirNFe } = require('./nfe-emit-routes');
const { criarReservasOS, consumirReservasOS, cancelarReservasOS } = require('./reservas-routes');
const {
  criarContaAPagar,
  atualizarContaAPagarSeAberta,
  removerContaAPagarSeAberta,
  contaAPagarTemPagamento,
} = require('./contas-pagar-routes');
const { enviarEmailCobranca } = require('./email-client');
const { enviarWhatsApp } = require('./whatsapp-adapter');
const { sendTelegram } = require('./telegram-client');
const osPdf = require('./os-pdf');

// Fase 9.1 (2026-04-22): status expandidos.
// rascunho → orcamento → (aprovado) → em-andamento → (concluida → faturada) | cancelada
const STATUS = ['rascunho', 'orcamento', 'aberta', 'em-andamento', 'aguardando-peca', 'concluida', 'faturada', 'cancelada'];

const UPLOAD_DIR_OS = path.join(__dirname, 'public', 'uploads', 'os');
try { fs.mkdirSync(UPLOAD_DIR_OS, { recursive: true }); } catch (_) { /* */ }

const uploadOSAnexo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR_OS, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
      cb(null, `${Date.now()}-${safe}${ext.startsWith('.') ? '' : '.'}${ext}`.replace(/\.+/g,'.'));
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB (aceita foto grande)
  fileFilter: (req, file, cb) => {
    const ok = /pdf|image|video|octet-stream/i.test(file.mimetype) ||
      /\.(pdf|png|jpg|jpeg|webp|heic|mp4|mov)$/i.test(file.originalname);
    cb(ok ? null : new Error('Formato não aceito (pdf, imagem ou vídeo)'), ok);
  },
});

// Helper único para registrar evento em os_eventos — viabiliza timeline.
function registrarEvento(db, osId, tipo, descricao, usuario, payload) {
  try {
    db.prepare(`
      INSERT INTO os_eventos (osId, tipo, descricao, usuario, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(osId, tipo, descricao || null, usuario || null, payload ? JSON.stringify(payload) : null);
  } catch (_) { /* tabela pode não existir em boot antigo */ }
  // Dispara notificações configuradas em os_notificacoes_config (fase 9.5).
  // Roda em background — falhas não afetam a escrita do evento.
  try {
    dispatchNotificacoes(db, osId, tipo, descricao, payload).catch(() => {});
  } catch (_) { /* */ }
}

// Fase 9.5: dispatcher de notificações configuráveis.
// Lê `os_notificacoes_config(evento, canal, template, ativo)` e envia
// via email/whatsapp/telegram. Template aceita {{placeholders}} dos
// campos da OS + descrição/payload do evento.
async function dispatchNotificacoes(db, osId, tipo, descricao, payload) {
  let configs;
  try {
    configs = db.prepare(`
      SELECT evento, canal, template FROM os_notificacoes_config
      WHERE evento = ? AND ativo = 1
    `).all(tipo);
  } catch (_) { return; }
  if (!configs || !configs.length) return;

  let os;
  try {
    os = db.prepare(`
      SELECT o.*, p.razaoSocial AS clienteNome, p.email AS clienteEmail, p.telefone AS clienteTelefone,
             u.username AS tecnicoNome, u.whatsappTecnico AS tecnicoWhatsApp
      FROM os_ordens o
      LEFT JOIN pessoas p ON p.id = o.clienteId
      LEFT JOIN users u ON u.id = o.tecnicoId
      WHERE o.id = ?
    `).get(osId);
  } catch (_) { return; }
  if (!os) return;

  const dados = {
    ...os,
    descricao: descricao || '',
    prazo: os.dataPromessa || '—',
    motivo: payload?.motivo || '',
    assinanteNome: payload?.assinanteNome || '',
  };

  function aplicaTemplate(t) {
    if (!t) return '';
    return String(t).replace(/\{\{(\w+)\}\}/g, (_m, k) => (dados[k] != null ? String(dados[k]) : ''));
  }

  for (const cfg of configs) {
    const texto = aplicaTemplate(cfg.template) ||
      `[OS ${os.numero}] ${descricao || tipo} — ${os.clienteNome || ''}`;
    try {
      if (cfg.canal === 'email' && os.clienteEmail) {
        await enviarEmailCobranca(db, {
          to: os.clienteEmail,
          assunto: `OS ${os.numero} — ${tipo}`,
          texto,
        });
      } else if (cfg.canal === 'whatsapp') {
        const tel = String(os.clienteTelefone || '').replace(/\D/g, '');
        if (tel) await enviarWhatsApp(db, { telefone: tel, texto });
      } else if (cfg.canal === 'telegram') {
        await sendTelegram(db, texto);
      }
    } catch (_) { /* falha silenciosa por canal — evento já foi persistido */ }
  }
}

// Fase 9.4 (2026-04-22): calcula o slaStatus de uma OS com base na
// dataPromessa, status atual e dataConclusao. Derivado (não persistido
// aqui — o scheduler master persiste via reconciliador SLA).
//   'cumprido'  — concluída dentro do prazo
//   'estourado' — concluída depois do prazo
//   'atrasado'  — ativa, hoje > dataPromessa
//   'risco'     — ativa, hoje + 1d >= dataPromessa (<= 24h para vencer)
//   'no-prazo'  — ativa, dentro do prazo
//   null        — sem dataPromessa (SLA não definido)
function calcSlaStatus(os) {
  if (!os.dataPromessa) return null;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const promessa = new Date(os.dataPromessa + 'T00:00:00');
  if (['concluida', 'faturada'].includes(os.status)) {
    if (!os.dataConclusao) return 'cumprido';
    const fim = new Date(os.dataConclusao.slice(0, 10) + 'T00:00:00');
    return fim.getTime() <= promessa.getTime() ? 'cumprido' : 'estourado';
  }
  if (os.status === 'cancelada') return null;
  if (hoje.getTime() > promessa.getTime()) return 'atrasado';
  const diff = (promessa.getTime() - hoje.getTime()) / (24 * 60 * 60 * 1000);
  if (diff <= 1) return 'risco';
  return 'no-prazo';
}

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS os_ordens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      clienteId INTEGER NOT NULL,
      tecnicoId INTEGER,
      status TEXT NOT NULL DEFAULT 'aberta',
      titulo TEXT NOT NULL,
      equipamento TEXT,
      marca TEXT,
      modelo TEXT,
      numeroSerieEquipamento TEXT,
      defeitoRelatado TEXT,
      diagnostico TEXT,
      solucao TEXT,
      garantiaDias INTEGER DEFAULT 0,
      observacoes TEXT,
      valorPecas REAL DEFAULT 0,
      valorServicos REAL DEFAULT 0,
      valorTotal REAL DEFAULT 0,
      pedidoId INTEGER,
      dataAbertura TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      dataInicioExecucao TEXT,
      dataConclusao TEXT,
      dataFaturamento TEXT,
      dataCancelamento TEXT,
      motivoCancelamento TEXT,
      usuarioCriacao TEXT,
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (tecnicoId) REFERENCES users(id),
      FOREIGN KEY (pedidoId) REFERENCES pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_os_status ON os_ordens(status, dataAbertura);
    CREATE INDEX IF NOT EXISTS idx_os_cliente ON os_ordens(clienteId);
    CREATE INDEX IF NOT EXISTS idx_os_tecnico ON os_ordens(tecnicoId);

    CREATE TABLE IF NOT EXISTS os_itens_pecas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      quantidade REAL NOT NULL,
      valorUnitario REAL NOT NULL,
      valorTotal REAL NOT NULL,
      loteId INTEGER,
      serialIds TEXT,
      movSaidaId INTEGER,
      FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id),
      FOREIGN KEY (loteId) REFERENCES lotes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_os_pecas_os ON os_itens_pecas(osId);

    CREATE TABLE IF NOT EXISTS os_itens_servicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osId INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      horas REAL,
      valorHora REAL,
      valorTotal REAL NOT NULL,
      FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_os_servicos_os ON os_itens_servicos(osId);

    CREATE TABLE IF NOT EXISTS os_apontamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      osId INTEGER NOT NULL,
      tecnicoId INTEGER,
      dataInicio TEXT NOT NULL,
      dataFim TEXT,
      horas REAL,
      descricao TEXT,
      FOREIGN KEY (osId) REFERENCES os_ordens(id) ON DELETE CASCADE,
      FOREIGN KEY (tecnicoId) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_os_apont_os ON os_apontamentos(osId);
  `);

  // Colunas adicionadas depois da criação original (alterSafe idempotente)
  const alterSafe = (sql) => { try { db.exec(sql); } catch { /* já existe */ } };
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN formaPagamento TEXT`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN dataVencimento TEXT`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN numeroParcelas INTEGER DEFAULT 1`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN naoEmitirNFe INTEGER DEFAULT 0`);
  alterSafe(`ALTER TABLE os_ordens ADD COLUMN statusFiscal TEXT`);
  // Colunas que vivem em db-schema.js mas precisam ser garantidas em
  // tenants que tiveram db-schema rodando antes de os_ordens existir
  // (alterSafe lá foi no-op pra coluna em tabela inexistente).
  for (const col of [
    'tipoId INTEGER', 'contratoId INTEGER', 'oportunidadeId INTEGER', 'osPaiId INTEGER',
    'enderecoExecucao TEXT', 'numeroExecucao TEXT', 'complementoExecucao TEXT',
    'bairroExecucao TEXT', 'municipioExecucao TEXT', 'ufExecucao TEXT', 'cepExecucao TEXT',
    'prazoSLADias INTEGER', 'dataPromessa TEXT',
    "slaStatus TEXT DEFAULT 'no-prazo'", "orcamentoStatus TEXT DEFAULT 'rascunho'",
    'orcamentoToken TEXT', 'dataEnvioOrcamento TEXT', 'dataRespostaOrcamento TEXT',
    'motivoRejeicao TEXT', 'assinaturaClienteDataUrl TEXT', 'assinaturaClienteData TEXT',
    'assinaturaTecnicoDataUrl TEXT', 'assinaturaTecnicoData TEXT',
    'emGarantia INTEGER DEFAULT 0', "ambienteFiscal TEXT DEFAULT 'sefaz'",
    'kmPercorrido REAL', 'valorDeslocamento REAL',
    'tipoOperacaoId INTEGER',
  ]) alterSafe(`ALTER TABLE os_ordens ADD COLUMN ${col}`);
  alterSafe(`CREATE UNIQUE INDEX IF NOT EXISTS idx_os_orcamento_token ON os_ordens(orcamentoToken) WHERE orcamentoToken IS NOT NULL`);
  alterSafe(`ALTER TABLE contas_a_receber ADD COLUMN osId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_receber ADD COLUMN pedidoId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_receber ADD COLUMN origemTipo TEXT`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_cr_os ON contas_a_receber(osId)`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_cr_pedido ON contas_a_receber(pedidoId)`);
  // Phase 2: link nfse/faturas → OS
  alterSafe(`ALTER TABLE nfse ADD COLUMN osId INTEGER`);
  alterSafe(`ALTER TABLE faturas ADD COLUMN osId INTEGER`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_nfse_os ON nfse(osId)`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_faturas_os ON faturas(osId)`);
  // Catálogo de serviços (cadastro-servicos.html): item da OS pode referenciar
  // um serviço para herdar fiscais (cNBS, cTribNac) na emissão da NFS-e.
  alterSafe(`ALTER TABLE os_itens_servicos ADD COLUMN servicoId INTEGER`);

  // Aquisição de terceiro: oficina compra peça/serviço de fora para a OS.
  // Gera contas_a_pagar vinculado ao item; CR cobrada do cliente fica intacta.
  for (const tab of ['os_itens_pecas', 'os_itens_servicos']) {
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN compradoTerceiro INTEGER DEFAULT 0`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN fornecedorId INTEGER`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN custoTerceiro REAL`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN notaFiscalTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN dataCompraTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN formaPagamentoTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN dataVencimentoTerceiro TEXT`);
    alterSafe(`ALTER TABLE ${tab} ADD COLUMN contasPagarId INTEGER`);
  }
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_osip_terceiro ON os_itens_pecas(compradoTerceiro)`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_osis_terceiro ON os_itens_servicos(compradoTerceiro)`);
  alterSafe(`ALTER TABLE contas_a_pagar ADD COLUMN osId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_pagar ADD COLUMN osItemId INTEGER`);
  alterSafe(`ALTER TABLE contas_a_pagar ADD COLUMN osItemTipo TEXT`);
  alterSafe(`CREATE INDEX IF NOT EXISTS idx_cp_os ON contas_a_pagar(osId)`);
}

function gerarNumero(db) {
  const ano = new Date().getFullYear();
  const prefix = `OS-${ano}-`;
  const u = db.prepare(`SELECT numero FROM os_ordens WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefix+'%');
  let n = 1;
  if (u) { const m = u.numero.match(/-(\d+)$/); if (m) n = parseInt(m[1],10) + 1; }
  return prefix + String(n).padStart(4, '0');
}

// Phase 3: calcula statusFiscal agregado considerando serviços + peças + estado das notas
function recalcStatusFiscal(db, osId) {
  const os = db.prepare('SELECT naoEmitirNFe, valorPecas, valorServicos FROM os_ordens WHERE id = ?').get(osId);
  if (!os) return null;
  const temServicos = (Number(os.valorServicos) || 0) > 0;
  const temPecas = (Number(os.valorPecas) || 0) > 0;
  const nfse = db.prepare(`SELECT status FROM nfse WHERE osId = ? ORDER BY id DESC LIMIT 1`).get(osId);
  const fatura = db.prepare(`SELECT statusSefaz FROM faturas WHERE osId = ? ORDER BY id DESC LIMIT 1`).get(osId);

  const nfseOk = nfse && (nfse.status === 'autorizada' || nfse.status === 'nao_fiscal');
  const nfseReje = nfse && nfse.status === 'rejeitada';
  const nfeOk = fatura && (fatura.statusSefaz === 'autorizada' || fatura.statusSefaz === 'nao_fiscal');
  const nfeReje = fatura && fatura.statusSefaz === 'rejeitada';
  const ambosInternos = nfse?.status === 'nao_fiscal' && fatura?.statusSefaz === 'nao_fiscal';

  let status;
  if (temServicos && temPecas) {
    if (nfseOk && nfeOk) status = ambosInternos ? 'nao_fiscal_mista' : 'mista_ok';
    else if (nfseOk || nfeOk) status = 'mista_parcial';
    else if (nfseReje || nfeReje) status = 'rejeitada';
    else status = 'pendente';
  } else if (temServicos) {
    if (nfseOk) status = nfse.status === 'nao_fiscal' ? 'nao_fiscal_nfse' : 'nfse_autorizada';
    else if (nfseReje) status = 'rejeitada';
    else status = 'pendente';
  } else if (temPecas) {
    if (nfeOk) status = fatura.statusSefaz === 'nao_fiscal' ? 'nao_fiscal_nfe' : 'nfe_autorizada';
    else if (nfeReje) status = 'rejeitada';
    else status = 'pendente';
  } else {
    status = 'pendente';
  }
  db.prepare(`UPDATE os_ordens SET statusFiscal = ? WHERE id = ?`).run(status, osId);
  return status;
}

function recalcTotais(db, osId) {
  const p = db.prepare('SELECT COALESCE(SUM(valorTotal),0) AS t FROM os_itens_pecas WHERE osId = ?').get(osId).t;
  const s = db.prepare('SELECT COALESCE(SUM(valorTotal),0) AS t FROM os_itens_servicos WHERE osId = ?').get(osId).t;
  db.prepare('UPDATE os_ordens SET valorPecas = ?, valorServicos = ?, valorTotal = ? WHERE id = ?').run(p, s, p+s, osId);
}

// Cria mov_entrada para peça/serviço terceiro com produtoId (catálogo).
// Origem='os_terceiro' não dispara atualização de precoCusto (regra:
// apenas NF-e formal atualiza preço de custo do produto).
function lancarEntradaTerceiroPeca(db, osId, item) {
  if (!item.compradoTerceiro || !item.produtoId) return null;
  const data = item.dataCompraTerceiro || new Date().toISOString().slice(0, 10);
  const r = db.prepare(`INSERT INTO movimentacoes_estoque
    (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, motivo, usuario)
    VALUES (?, 'entrada', ?, ?, 'os_terceiro', ?, ?, ?, 'Aquisição p/ OS', NULL)`).run(
    item.produtoId, Number(item.quantidade), Number(item.custoTerceiro),
    osId, `OS terceiro item ${item.id}`, data,
  );
  return r.lastInsertRowid;
}

// Saída para peças terceiras com produtoId no momento da conclusão da OS.
// Chamada ao lado de consumirReservasOS — terceiros não têm reserva.
function consumirTerceirosPecasOS(db, osId, dataConsumo, usuario) {
  const itens = db.prepare(`SELECT * FROM os_itens_pecas
    WHERE osId = ? AND compradoTerceiro = 1 AND produtoId IS NOT NULL AND movSaidaId IS NULL`).all(osId);
  for (const it of itens) {
    const r = db.prepare(`INSERT INTO movimentacoes_estoque
      (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, motivo, usuario)
      VALUES (?, 'saida', ?, ?, 'os', ?, 'OS terceiro consumido', ?, 'Consumo OS', ?)`).run(
      it.produtoId, Number(it.quantidade), Number(it.custoTerceiro),
      osId, dataConsumo, usuario || null,
    );
    db.prepare('UPDATE os_itens_pecas SET movSaidaId = ? WHERE id = ?').run(r.lastInsertRowid, it.id);
  }
}

// Cria/atualiza o AP vinculado a um item de OS marcado como "comprado de
// terceiro". Retorna o id do AP (novo ou existente) ou null se item não
// é terceiro. Se o item perdeu a flag, cancela/deleta o AP antigo.
//
// Pré-requisitos validados aqui:
//   - compradoTerceiro requer fornecedorId + custoTerceiro
//   - se já existe AP e está pago, lança erro pra não silenciosamente sobrescrever
function sincronizarAPDoItem(db, osId, osItemId, osItemTipo, item) {
  const apIdAtual = item.contasPagarId || null;
  if (!item.compradoTerceiro) {
    if (apIdAtual) {
      if (contaAPagarTemPagamento(db, apIdAtual)) {
        throw new Error('Item já tem AP pago — não é possível desmarcar como terceiro');
      }
      removerContaAPagarSeAberta(db, apIdAtual);
    }
    return null;
  }
  if (!item.fornecedorId || item.custoTerceiro == null) {
    throw new Error('Aquisição de terceiro exige fornecedorId e custoTerceiro');
  }
  const ordem = db.prepare('SELECT numero FROM os_ordens WHERE id = ?').get(osId);
  const descricao = `Aquisição p/ OS ${ordem.numero} — ${item.descricao || ''}`.trim();
  const venc = item.dataVencimentoTerceiro || item.dataCompraTerceiro || new Date().toISOString().slice(0,10);
  const payload = {
    fornecedorId: item.fornecedorId,
    descricao,
    valor: item.custoTerceiro,
    dataEmissao: item.dataCompraTerceiro || null,
    dataVencimento: venc,
    formaPagamento: item.formaPagamentoTerceiro || null,
    observacoes: item.notaFiscalTerceiro ? `NF/cupom: ${item.notaFiscalTerceiro}` : null,
    osId, osItemId, osItemTipo,
  };
  if (apIdAtual) {
    if (contaAPagarTemPagamento(db, apIdAtual)) {
      throw new Error('AP do item já foi pago — edite manualmente em Contas a Pagar');
    }
    const ok = atualizarContaAPagarSeAberta(db, apIdAtual, payload);
    if (!ok) {
      // AP não-aberto (cancelado por outra via): cria novo
      return criarContaAPagar(db, payload);
    }
    return apIdAtual;
  }
  return criarContaAPagar(db, payload);
}

function registrarRotasOS(app, db) {
  migrarDB(db);

  // Migração lazy por-tenant: registrarRotasOS roda em contexto BOOT
  // (proxy é no-op), então tenants provisionados antes do módulo OS podem
  // não ter as tabelas. Garante criação na 1ª chamada por-tenant.
  const tenantsMigrados = new WeakSet();
  function ensureMigrated(req, res, next) {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        migrarDB(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
  app.use('/api/os', ensureMigrated);
  app.use('/api/os-tipos', ensureMigrated);

  // ==================== LISTAGEM ====================

  app.get('/api/os', (req, res) => {
    try {
      const { clienteId, tecnicoId, status, q, dataIni, dataFim, limit } = req.query;
      let sql = `
        SELECT o.*, p.razaoSocial AS clienteNome, t.username AS tecnicoNome, t.nome AS tecnicoNomeExibicao
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users t ON t.id = o.tecnicoId
        WHERE 1=1
      `;
      const params = [];
      if (clienteId) { sql += ' AND o.clienteId = ?'; params.push(Number(clienteId)); }
      if (tecnicoId) { sql += ' AND o.tecnicoId = ?'; params.push(Number(tecnicoId)); }
      if (status)    { sql += ' AND o.status = ?';    params.push(status); }
      if (dataIni)   { sql += ' AND o.dataAbertura >= ?'; params.push(dataIni); }
      if (dataFim)   { sql += ' AND o.dataAbertura <= ?'; params.push(dataFim + ' 23:59:59'); }
      if (q)         { sql += ' AND (o.numero LIKE ? OR o.titulo LIKE ? OR p.razaoSocial LIKE ? OR o.equipamento LIKE ?)';
                       const like = `%${q}%`; params.push(like, like, like, like); }
      // Filtro SLA em risco (só aplica quando explicitamente requisitado)
      const slaFiltro = req.query.sla; // 'risco' | 'atrasado' | 'no-prazo'
      sql += ' ORDER BY o.id DESC LIMIT ?';
      params.push(Number(limit) || 200);
      let ordens = db.prepare(sql).all(...params);

      // Fase 9.4: anexa slaStatus calculado dinamicamente (não depende
      // do scheduler ter rodado ainda).
      for (const o of ordens) o.slaStatus = calcSlaStatus(o);
      if (slaFiltro) ordens = ordens.filter(o => o.slaStatus === slaFiltro);

      const kpis = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='aberta' THEN 1 ELSE 0 END) AS abertas,
          SUM(CASE WHEN status='em-andamento' THEN 1 ELSE 0 END) AS execucao,
          SUM(CASE WHEN status='aguardando-peca' THEN 1 ELSE 0 END) AS aguardandoPeca,
          SUM(CASE WHEN status='concluida' THEN 1 ELSE 0 END) AS concluidas,
          SUM(CASE WHEN status IN ('concluida','faturada') THEN valorTotal ELSE 0 END) AS receita,
          SUM(CASE WHEN status='faturada' AND (statusFiscal IS NULL OR statusFiscal='pendente') THEN 1 ELSE 0 END) AS faturadasSemNota,
          SUM(CASE WHEN status='faturada' AND statusFiscal='mista_parcial' THEN 1 ELSE 0 END) AS mistaParcial,
          SUM(CASE WHEN status='faturada' AND statusFiscal='rejeitada' THEN 1 ELSE 0 END) AS rejeitadas
        FROM os_ordens
      `).get();

      // KPIs SLA — calculados sobre dataset leve (id, status, dataPromessa, dataConclusao)
      const paraSla = db.prepare(`
        SELECT id, status, dataPromessa, dataConclusao FROM os_ordens
        WHERE status NOT IN ('cancelada') AND dataPromessa IS NOT NULL
      `).all();
      const slaKpis = { atrasadas: 0, risco: 0, noPrazo: 0, cumpridas: 0, estouradas: 0 };
      for (const r of paraSla) {
        const s = calcSlaStatus(r);
        if (s === 'atrasado') slaKpis.atrasadas++;
        else if (s === 'risco') slaKpis.risco++;
        else if (s === 'no-prazo') slaKpis.noPrazo++;
        else if (s === 'cumprido') slaKpis.cumpridas++;
        else if (s === 'estourado') slaKpis.estouradas++;
      }
      res.json({ success: true, ordens, kpis: { ...kpis, ...slaKpis }, status: STATUS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Precisa vir ANTES de /api/os/:id senão o Express casa com :id='garantia-sugestoes' e devolve 404.
  app.get('/api/os/garantia-sugestoes', (req, res) => {
    try {
      const { clienteId, numeroSerie, marca, modelo } = req.query;
      if (!clienteId) return res.status(400).json({ success: false, error: 'clienteId obrigatório' });
      const filters = [`clienteId = ?`, `status = 'faturada'`, `dataFaturamento IS NOT NULL`, `garantiaDias > 0`];
      const params = [Number(clienteId)];
      if (numeroSerie) {
        filters.push(`numeroSerieEquipamento = ?`);
        params.push(String(numeroSerie).trim());
      } else if (marca || modelo) {
        if (marca)  { filters.push(`LOWER(IFNULL(marca,'')) = ?`);  params.push(String(marca).trim().toLowerCase()); }
        if (modelo) { filters.push(`LOWER(IFNULL(modelo,'')) = ?`); params.push(String(modelo).trim().toLowerCase()); }
      } else {
        return res.json({ success: true, sugestoes: [] });
      }
      const candidatas = db.prepare(`
        SELECT id, numero, equipamento, marca, modelo, numeroSerieEquipamento,
               dataFaturamento, garantiaDias, valorTotal
        FROM os_ordens
        WHERE ${filters.join(' AND ')}
        ORDER BY dataFaturamento DESC
        LIMIT 10
      `).all(...params);

      const agora = Date.now();
      const sugestoes = candidatas
        .map(c => {
          const base = new Date(c.dataFaturamento).getTime();
          const limite = base + (c.garantiaDias * 24 * 60 * 60 * 1000);
          const diasRestantes = Math.floor((limite - agora) / (24 * 60 * 60 * 1000));
          return { ...c, diasRestantes, dentroPrazo: limite >= agora };
        })
        .filter(c => c.dentroPrazo);

      res.json({ success: true, sugestoes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/os/:id', (req, res) => {
    try {
      const os = db.prepare(`
        SELECT o.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
               p.email AS clienteEmail, p.telefone AS clienteTelefone,
               t.username AS tecnicoNome, t.nome AS tecnicoNomeExibicao
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users t ON t.id = o.tecnicoId
        WHERE o.id = ?
      `).get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });
      const pecas = db.prepare(`
        SELECT pi.*, pr.sku, pr.rastreiaLote, pr.rastreiaSerial, l.numero AS loteNumero,
               f.razaoSocial AS terceiroFornecedorNome,
               cp.status AS terceiroStatusAP, cp.valor AS terceiroValorAP
        FROM os_itens_pecas pi
        LEFT JOIN produtos pr ON pr.id = pi.produtoId
        LEFT JOIN lotes l ON l.id = pi.loteId
        LEFT JOIN fornecedores f ON f.id = pi.fornecedorId
        LEFT JOIN contas_a_pagar cp ON cp.id = pi.contasPagarId
        WHERE pi.osId = ? ORDER BY pi.id
      `).all(os.id);
      const servicos = db.prepare(`
        SELECT i.*,
               sc.codigo AS servicoCodigo, sc.nome AS servicoNome,
               sc.cNBS AS servicoCnbs, sc.xNBS AS servicoXnbs,
               sc.codigoTributacaoNacional AS servicoCtribnac,
               f.razaoSocial AS terceiroFornecedorNome,
               cp.status AS terceiroStatusAP, cp.valor AS terceiroValorAP
        FROM os_itens_servicos i
        LEFT JOIN servicos sc ON sc.id = i.servicoId
        LEFT JOIN fornecedores f ON f.id = i.fornecedorId
        LEFT JOIN contas_a_pagar cp ON cp.id = i.contasPagarId
        WHERE i.osId = ? ORDER BY i.id
      `).all(os.id);
      const apontamentos = db.prepare(`
        SELECT a.*, u.username AS tecnicoNome
        FROM os_apontamentos a
        LEFT JOIN users u ON u.id = a.tecnicoId
        WHERE a.osId = ? ORDER BY a.dataInicio DESC
      `).all(os.id);
      const contasReceber = db.prepare(`
        SELECT id, descricao, valor, dataVencimento, dataPagamento, status, origemTipo, nfseId, faturaId
        FROM contas_a_receber WHERE osId = ? ORDER BY id
      `).all(os.id);

      // Fase 9.1: inclui checklist, anexos, eventos, tipo e contagem de reservas
      // ativas — tudo em uma chamada só para a UI renderizar as tabs.
      let tipo = null;
      if (os.tipoId) {
        try { tipo = db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(os.tipoId); } catch (_) {}
      }
      let checklist = [], anexos = [], eventos = [];
      try { checklist = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem, id').all(os.id); } catch (_) {}
      try { anexos = db.prepare('SELECT * FROM os_anexos WHERE osId = ? ORDER BY dataUpload DESC').all(os.id); } catch (_) {}
      try {
        eventos = db.prepare('SELECT * FROM os_eventos WHERE osId = ? ORDER BY data DESC, id DESC LIMIT 50').all(os.id);
        eventos = eventos.map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }));
      } catch (_) {}
      let reservasAtivas = 0;
      try {
        reservasAtivas = db.prepare(`SELECT COUNT(*) c FROM reservas_estoque WHERE osId = ? AND status = 'ativa'`).get(os.id).c;
      } catch (_) {}

      // Fase 9.4: slaStatus dinâmico
      os.slaStatus = calcSlaStatus(os);

      res.json({
        success: true, os, pecas, servicos, apontamentos, contasReceber,
        tipo, checklist, anexos, eventos, reservasAtivas,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CABEÇALHO ====================

  app.post('/api/os', (req, res) => {
    try {
      const {
        clienteId, tecnicoId, titulo, equipamento, marca, modelo, numeroSerieEquipamento,
        defeitoRelatado, garantiaDias, observacoes,
        formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe,
        tipoOperacaoId,
        // Fase 9.1: novos campos
        tipoId, contratoId, oportunidadeId, osPaiId,
        enderecoExecucao, numeroExecucao, complementoExecucao, bairroExecucao,
        municipioExecucao, ufExecucao, cepExecucao,
        prazoSLADias, dataPromessa,
      } = req.body;

      if (!clienteId || !titulo) return res.status(400).json({ success: false, error: 'clienteId e titulo obrigatórios' });

      // Busca o tipo — controla status inicial, checklist padrão, ambiente fiscal.
      let tipo = null;
      if (tipoId) {
        tipo = db.prepare('SELECT * FROM os_tipos WHERE id = ? AND ativo = 1').get(tipoId);
        if (!tipo) return res.status(400).json({ success: false, error: 'tipoId inválido ou inativo' });
      }

      // Validação de endereço quando o tipo exige (ex.: OS de campo)
      if (tipo && tipo.exigeEnderecoExec && !enderecoExecucao) {
        return res.status(400).json({ success: false, error: `Tipo "${tipo.nome}" exige endereço de execução` });
      }

      // Garantia: se osPaiId e dentro do período, marca emGarantia e força ambienteFiscal='interno'
      let emGarantia = 0;
      let ambienteFiscal = tipo ? tipo.modoFiscal : 'sefaz';
      if (osPaiId) {
        const pai = db.prepare('SELECT dataFaturamento, garantiaDias FROM os_ordens WHERE id = ?').get(osPaiId);
        if (pai && pai.dataFaturamento && pai.garantiaDias > 0) {
          const limiteGarantia = new Date(pai.dataFaturamento);
          limiteGarantia.setDate(limiteGarantia.getDate() + pai.garantiaDias);
          if (Date.now() <= limiteGarantia.getTime()) {
            emGarantia = 1;
            ambienteFiscal = 'interno'; // OS de garantia não cobra
          }
        }
      }

      // Resolução do tipoOperacaoId: body > default do os_tipo > derivado das flags legado.
      //   emGarantia → OS-GARANTIA
      //   naoEmitirNFe / ambienteFiscal='interno' → OS-INTERNA
      //   caso normal → OS-NORMAL
      let tipoOperacaoFinal = tipoOperacaoId || tipo?.tipoOperacaoPadraoId || null;
      if (!tipoOperacaoFinal) {
        let codigoAlvo;
        if (emGarantia) codigoAlvo = 'OS-GARANTIA';
        else if (naoEmitirNFe || ambienteFiscal === 'interno' || ambienteFiscal === 'nenhum') codigoAlvo = 'OS-INTERNA';
        else codigoAlvo = 'OS-NORMAL';
        const t = db.prepare('SELECT id FROM tipos_operacao WHERE codigo = ? AND ativo = 1').get(codigoAlvo);
        tipoOperacaoFinal = t?.id || null;
      }

      // Status inicial: se o tipo exige orçamento aprovado → rascunho; senão → aberta.
      const statusInicial = (tipo && tipo.exigeOrcamentoAprovado) ? 'rascunho' : 'aberta';
      const orcamentoStatus = statusInicial === 'rascunho' ? 'rascunho' : null;

      // Prazo SLA: body tem prioridade, senão padrão do tipo.
      const sla = Number(prazoSLADias) || (tipo ? tipo.slaDiasPadrao : null);
      let promessa = dataPromessa || null;
      if (!promessa && sla) {
        const d = new Date();
        d.setDate(d.getDate() + Number(sla));
        promessa = d.toISOString().slice(0, 10);
      }

      const numero = gerarNumero(db);
      const newId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO os_ordens (
            numero, clienteId, tecnicoId, status, titulo, equipamento, marca, modelo, numeroSerieEquipamento,
            defeitoRelatado, garantiaDias, observacoes, usuarioCriacao,
            formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe,
            tipoId, contratoId, oportunidadeId, osPaiId,
            enderecoExecucao, numeroExecucao, complementoExecucao, bairroExecucao,
            municipioExecucao, ufExecucao, cepExecucao,
            prazoSLADias, dataPromessa,
            orcamentoStatus, emGarantia, ambienteFiscal, tipoOperacaoId
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          numero, clienteId, tecnicoId || null, statusInicial, titulo,
          equipamento || null, marca || null, modelo || null, numeroSerieEquipamento || null,
          defeitoRelatado || null, Number(garantiaDias) || 0, observacoes || null, req.user?.username || null,
          formaPagamento || null, dataVencimento || null, Number(numeroParcelas) || 1, naoEmitirNFe ? 1 : 0,
          tipoId || null, contratoId || null, oportunidadeId || null, osPaiId || null,
          enderecoExecucao || null, numeroExecucao || null, complementoExecucao || null, bairroExecucao || null,
          municipioExecucao || null, ufExecucao || null, cepExecucao || null,
          sla || null, promessa,
          orcamentoStatus, emGarantia, ambienteFiscal, tipoOperacaoFinal
        );
        const id = r.lastInsertRowid;

        // Copia checklist padrão do tipo (copy-on-create — OS fica imune a
        // mudanças futuras no template).
        if (tipo && tipo.checklistPadrao) {
          try {
            const items = JSON.parse(tipo.checklistPadrao) || [];
            const stmtChk = db.prepare('INSERT INTO os_checklist (osId, ordem, descricao, obrigatorio) VALUES (?, ?, ?, ?)');
            for (const ck of items) {
              stmtChk.run(id, Number(ck.ordem) || 0, ck.descricao, ck.obrigatorio ? 1 : 0);
            }
          } catch (_) { /* JSON inválido — ignora */ }
        }

        registrarEvento(db, id, 'abertura', `OS ${numero} aberta${tipo ? ` (tipo: ${tipo.nome})` : ''}`, req.user?.username, {
          clienteId, tipoId: tipoId || null, status: statusInicial, emGarantia,
        });
        return id;
      })();

      logAction(db, req, 'criar', 'os', newId, { numero, clienteId, titulo, tipoId: tipoId || null });
      res.json({
        success: true,
        os: db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(newId),
      });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/os/:id', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (os.status === 'faturada') return res.status(400).json({ success: false, error: 'OS faturada — não pode editar' });
      if (os.status === 'cancelada') return res.status(400).json({ success: false, error: 'OS cancelada' });
      const camposValidos = ['tecnicoId','titulo','equipamento','marca','modelo','numeroSerieEquipamento',
                             'defeitoRelatado','diagnostico','solucao','garantiaDias','observacoes',
                             'formaPagamento','dataVencimento','numeroParcelas','naoEmitirNFe','tipoOperacaoId'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) { sets.push(`${c} = ?`); vals.push(req.body[c] === '' ? null : req.body[c]); }
      }
      if (sets.length) {
        vals.push(os.id);
        db.prepare(`UPDATE os_ordens SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        logAction(db, req, 'editar', 'os', os.id, req.body);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CICLO DE VIDA ====================

  app.post('/api/os/:id/iniciar', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['aberta','aguardando-peca','orcamento'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'Estado atual não permite iniciar execução' });
      }

      // Fase 9.1: ao iniciar execução, CRIA reservas de estoque para as
      // peças já listadas. Se houver insuficiência, devolve 409 com detalhes
      // — front pode confirmar e chamar novamente com ?forcar=1 para
      // permitir reserva com saldo negativo (caso "pedido maior que estoque").
      let reservaResult = null;
      const trx = db.transaction(() => {
        reservaResult = criarReservasOS(db, os.id);
        db.prepare(`
          UPDATE os_ordens
          SET status = 'em-andamento',
              dataInicioExecucao = COALESCE(dataInicioExecucao, CURRENT_TIMESTAMP)
          WHERE id = ?
        `).run(os.id);
      });
      trx();

      registrarEvento(db, os.id, 'inicio', 'Execução iniciada — estoque reservado', req.user?.username, {
        reservasCriadas: reservaResult.reservasCriadas.length,
        insuficiencias: reservaResult.insuficiencias,
      });
      logAction(db, req, 'iniciar', 'os', os.id, { reservas: reservaResult.reservasCriadas.length });
      res.json({
        success: true,
        reservasCriadas: reservaResult.reservasCriadas.length,
        insuficiencias: reservaResult.insuficiencias,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/:id/aguardar-peca', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['em-andamento','aberta'].includes(os.status)) return res.status(400).json({ success: false, error: 'Estado atual não permite' });
      db.prepare(`UPDATE os_ordens SET status = 'aguardando-peca' WHERE id = ?`).run(os.id);
      logAction(db, req, 'aguardar-peca', 'os', os.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Concluir: consome reservas ativas (se houver) OU baixa direta (fallback
  // para OS criadas antes da Fase 9.1 sem reservas). Valida checklist
  // obrigatório e assinatura conforme o tipo exigir.
  app.post('/api/os/:id/concluir', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['em-andamento','aguardando-peca','aberta'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'Estado atual não permite concluir' });
      }
      const { solucao, baixarEstoque } = req.body || {};

      // Fase 9.1: valida checklist obrigatório 100% concluído
      const pendentes = db.prepare(
        'SELECT id, descricao FROM os_checklist WHERE osId = ? AND obrigatorio = 1 AND concluido = 0'
      ).all(os.id);
      if (pendentes.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Há ${pendentes.length} item(ns) obrigatório(s) do checklist pendente(s)`,
          checklist: pendentes,
        });
      }

      // Fase 9.1: valida assinatura do cliente se o tipo exigir
      if (os.tipoId) {
        const tipo = db.prepare('SELECT exigeAssinaturaCliente, nome FROM os_tipos WHERE id = ?').get(os.tipoId);
        if (tipo && tipo.exigeAssinaturaCliente && !os.assinaturaClienteDataUrl) {
          return res.status(400).json({
            success: false,
            error: `Tipo "${tipo.nome}" exige assinatura do cliente antes de concluir`,
          });
        }
      }

      const pecas = db.prepare(`
        SELECT pi.*, pr.sku, pr.rastreiaLote, pr.rastreiaSerial
        FROM os_itens_pecas pi
        JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ?
      `).all(os.id);

      // Validações de rastreabilidade (lote/serial)
      const baixar = baixarEstoque !== false;
      if (baixar) {
        for (const it of pecas) {
          if (it.rastreiaLote && !it.loteId) return res.status(400).json({ success: false, error: `Peça ${it.sku} rastreia lote — informe o lote` });
          if (it.rastreiaSerial) {
            const serials = it.serialIds ? JSON.parse(it.serialIds) : [];
            if (serials.length !== Number(it.quantidade)) return res.status(400).json({ success: false, error: `Peça ${it.sku} rastreia série — informe ${it.quantidade} série(s)` });
          }
        }
      }

      const dataHoje = new Date().toISOString().slice(0, 10);

      // Verifica se há reservas ativas para esta OS — se sim, consome via helper.
      const temReservas = db.prepare(
        `SELECT COUNT(*) c FROM reservas_estoque WHERE osId = ? AND status = 'ativa'`
      ).get(os.id).c > 0;

      // Peças próprias (com estoque) — terceiros têm fluxo separado mais abaixo.
      const pecasProprias = pecas.filter(p => !p.compradoTerceiro);
      const trx = db.transaction(() => {
        if (baixar && pecasProprias.length) {
          if (temReservas) {
            // Via reservas (fluxo Fase 9.1)
            consumirReservasOS(db, os.id, dataHoje);
            // Serials: ainda precisa marcar status='baixado' (reservas não fazem isso)
            for (const it of pecasProprias) {
              if (it.serialIds) {
                const movSaida = db.prepare('SELECT movSaidaId FROM os_itens_pecas WHERE id = ?').get(it.id);
                for (const sid of JSON.parse(it.serialIds)) {
                  db.prepare(`UPDATE serial_numbers SET status='baixado', movSaidaId = ? WHERE id = ?`).run(movSaida.movSaidaId, sid);
                }
              }
            }
          } else {
            // Fallback: OS antiga sem reservas — baixa direta
            const stmtMov = db.prepare(`
              INSERT INTO movimentacoes_estoque
                (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data, loteId, motivo, usuario)
              VALUES (?, 'saida', ?, NULL, 'os', ?, ?, ?, ?, NULL, ?)
            `);
            for (const it of pecasProprias) {
              const r = stmtMov.run(it.produtoId, Number(it.quantidade), os.id,
                `OS ${os.numero} (peça)`, dataHoje, it.loteId || null, req.user?.username || null);
              const movId = r.lastInsertRowid;
              db.prepare('UPDATE os_itens_pecas SET movSaidaId = ? WHERE id = ?').run(movId, it.id);
              if (it.loteId) db.prepare('UPDATE lotes SET saldoAtual = saldoAtual - ? WHERE id = ?').run(Number(it.quantidade), it.loteId);
              if (it.serialIds) {
                for (const sid of JSON.parse(it.serialIds)) {
                  db.prepare(`UPDATE serial_numbers SET status='baixado', movSaidaId = ? WHERE id = ?`).run(movId, sid);
                }
              }
            }
          }
        }
        // Saída de peças terceiras (com produtoId vinculado) — sem reserva.
        if (baixar) consumirTerceirosPecasOS(db, os.id, dataHoje, req.user?.username);
        db.prepare(`
          UPDATE os_ordens
             SET status = 'concluida', dataConclusao = CURRENT_TIMESTAMP,
                 solucao = COALESCE(?, solucao)
           WHERE id = ?
        `).run(solucao || null, os.id);
      });
      trx();

      registrarEvento(db, os.id, 'conclusao', solucao || 'OS concluída', req.user?.username, {
        pecas: pecas.length, viaReservas: temReservas, baixouEstoque: baixar,
      });
      logAction(db, req, 'concluir', 'os', os.id, { baixouEstoque: baixar, pecas: pecas.length, viaReservas: temReservas });
      res.json({ success: true, viaReservas: temReservas });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/:id/cancelar', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['faturada','cancelada'].includes(os.status)) return res.status(400).json({ success: false, error: 'Não permitido nesse estado' });
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 5) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 5 caracteres)' });

      const trx = db.transaction(() => {
        // Fase 9.1: libera reservas ativas
        cancelarReservasOS(db, os.id, `Cancelamento OS: ${motivo}`);

        // Se já houve baixa de estoque (concluída antes de cancelar), gera estornos
        const itensBaixados = db.prepare(`
          SELECT pi.*, pr.sku
          FROM os_itens_pecas pi JOIN produtos pr ON pr.id = pi.produtoId
          WHERE pi.osId = ? AND pi.movSaidaId IS NOT NULL
        `).all(os.id);
        if (itensBaixados.length > 0) {
          const stmtEstorno = db.prepare(`
            INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, origem, origemId, observacao, data, loteId, motivo, usuario)
            VALUES (?, 'entrada', ?, 'estorno_os', ?, ?, date('now'), ?, ?, ?)
          `);
          for (const it of itensBaixados) {
            stmtEstorno.run(
              it.produtoId, Number(it.quantidade), os.id,
              `Estorno OS ${os.numero} (cancelada): ${motivo}`,
              it.loteId || null,
              `Cancelamento OS ${os.numero}`,
              req.user?.username || null,
            );
            if (it.loteId) {
              db.prepare('UPDATE lotes SET saldoAtual = saldoAtual + ? WHERE id = ?').run(Number(it.quantidade), it.loteId);
            }
            if (it.serialIds) {
              for (const sid of JSON.parse(it.serialIds)) {
                db.prepare(`UPDATE serial_numbers SET status='ativo', movSaidaId = NULL WHERE id = ?`).run(sid);
              }
            }
          }
        }

        db.prepare(`
          UPDATE os_ordens
          SET status = 'cancelada', dataCancelamento = CURRENT_TIMESTAMP, motivoCancelamento = ?
          WHERE id = ?
        `).run(motivo, os.id);
      });
      trx();

      registrarEvento(db, os.id, 'cancelamento', motivo, req.user?.username, null);
      logAction(db, req, 'cancelar', 'os', os.id, { motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== HELPERS: emissão fiscal extraída ====================
  //
  // Extraídos dos handlers emitir-nfse e emitir-nfe para permitir chamada
  // automática do faturar. Retornam { success, nfseId|faturaId, naoFiscal?, error? }.
  // Fase 9.3 (2026-04-22).

  async function _emitirNfseDaOS(osId, body, usuario) {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(osId);
      if (!os) return { success: false, error: 'OS não encontrada' };
      const servicos = db.prepare('SELECT * FROM os_itens_servicos WHERE osId = ?').all(osId);
      if (!servicos.length) return { success: true, skipped: true, reason: 'sem serviços' };
      const jaEmitida = db.prepare(`SELECT id FROM nfse WHERE osId = ? AND status IN ('autorizada','processando','nao_fiscal')`).get(osId);
      if (jaEmitida) return { success: true, skipped: true, reason: 'nfse já emitida', nfseId: jaEmitida.id };

      const cliente = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(os.clienteId);
      if (!cliente) return { success: false, error: 'Cliente não encontrado' };

      const b = body || {};

      // Derivação fiscal: prioridade catálogo dominante (maior valor) > body > config global.
      // Limitação: leiaute DPS NFS-e nacional comporta um único <cServ> por nota,
      // então itens com cNBS distintos pegam o do dominante.
      const itensComCatalogo = servicos.filter(s => s.servicoId);
      let servicoFiscalDominante = null;
      if (itensComCatalogo.length) {
        const dominante = itensComCatalogo.reduce((a, b2) =>
          (Number(b2.valorTotal) || 0) > (Number(a.valorTotal) || 0) ? b2 : a
        );
        servicoFiscalDominante = db.prepare('SELECT * FROM servicos WHERE id = ?').get(dominante.servicoId);
      }

      const codigoTributacaoNacional =
        servicoFiscalDominante?.codigoTributacaoNacional
        || b.codigoTributacaoNacional
        || db.prepare("SELECT value FROM nfse_config WHERE key = 'codigo_tributacao_default'").get()?.value;
      if (!codigoTributacaoNacional) {
        return { success: false, error: 'codigoTributacaoNacional padrão não configurado em NFSe > Config' };
      }
      const codigoListaServico = servicoFiscalDominante?.codigoListaServico || b.codigoListaServico || null;
      const cNBS = servicoFiscalDominante?.cNBS || null;
      const xNBS = servicoFiscalDominante?.xNBS || null;

      const descricaoAgregada = servicos.map(s => `${s.descricao}${s.horas ? ` (${s.horas}h)` : ''}`).join(' | ').substring(0, 500);
      const valorTotalServicos = servicos.reduce((sum, s) => sum + (Number(s.valorTotal) || 0), 0);

      // Decisão: sefaz vs interno. Precedência: tipoOperacao.emiteNFe > ambienteFiscal > naoEmitirNFe.
      const tipoOp = os.tipoOperacaoId
        ? db.prepare('SELECT emiteNFe FROM tipos_operacao WHERE id = ?').get(os.tipoOperacaoId)
        : null;
      const modo = tipoOp
        ? (tipoOp.emiteNFe ? 'sefaz' : 'interno')
        : (os.ambienteFiscal || (os.naoEmitirNFe ? 'interno' : 'sefaz'));

      if (modo === 'interno' || modo === 'nenhum') {
        const stubId = db.prepare(`
          INSERT INTO nfse (osId, tomadorCpfCnpj, tomadorRazaoSocial, codigoTributacaoNacional,
            cNBS, xNBS, descricaoServico, valorServico, dataCompetencia, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'nao_fiscal')
        `).run(osId, cliente.cpfCnpj, cliente.razaoSocial, codigoTributacaoNacional,
          cNBS, xNBS,
          `OS ${os.numero} — ${descricaoAgregada}`, valorTotalServicos,
          new Date().toISOString().slice(0,10)
        ).lastInsertRowid;
        db.prepare(`UPDATE contas_a_receber SET nfseId = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE osId = ? AND origemTipo = 'os_servicos' AND nfseId IS NULL`).run(stubId, osId);
        recalcStatusFiscal(db, osId);
        registrarEvento(db, osId, 'faturamento', `NFSe marcada como interna (#${stubId})`, usuario, { modo: 'interno', nfseId: stubId });
        return { success: true, naoFiscal: true, nfseId: stubId };
      }

      // Modo sefaz
      const resultado = await emitirNfseInterno(db, {
        osId,
        tomador: {
          cpfCnpj: cliente.cpfCnpj,
          razaoSocial: cliente.razaoSocial,
          inscricaoMunicipal: cliente.inscricaoMunicipal || null,
          email: cliente.email || null,
          endereco: cliente.endereco ? {
            logradouro: cliente.endereco, numero: cliente.numero,
            complemento: cliente.complemento, bairro: cliente.bairro,
            codigoMunicipio: cliente.codigoMunicipio, uf: cliente.uf, cep: cliente.cep,
          } : null,
        },
        servico: {
          codigoTributacaoNacional,
          codigoListaServico,
          cNBS,
          xNBS,
          descricao: `OS ${os.numero} — ${descricaoAgregada}`,
          valorServico: valorTotalServicos,
          aliquota: Number(b.aliquota) || null,
        },
      });
      recalcStatusFiscal(db, osId);
      if (!resultado.success) {
        registrarEvento(db, osId, 'faturamento', `Falha NFSe: ${resultado.error}`, usuario, { modo: 'sefaz', erro: resultado.error });
        return { success: false, error: resultado.error, detalhes: resultado };
      }
      registrarEvento(db, osId, 'faturamento', `NFSe emitida #${resultado.nfse?.nNFSe || resultado.nfse?.id}`, usuario, { modo: 'sefaz', nfseId: resultado.nfse?.id });
      return { success: true, nfse: resultado.nfse, conta: resultado.conta };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async function _emitirNfeDaOS(osId, usuario) {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(osId);
      if (!os) return { success: false, error: 'OS não encontrada' };
      const pecas = db.prepare(`
        SELECT pi.*, pr.sku, pr.unidade, pr.ncm, pr.cfopPadrao AS cfop, pr.origem
        FROM os_itens_pecas pi LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ?
      `).all(osId);
      if (!pecas.length) return { success: true, skipped: true, reason: 'sem peças' };
      const jaEmitida = db.prepare(`SELECT id FROM faturas WHERE osId = ? AND statusSefaz IN ('autorizada','nao_fiscal','processando')`).get(osId);
      if (jaEmitida) return { success: true, skipped: true, reason: 'fatura já existe', faturaId: jaEmitida.id };

      const valorBruto = pecas.reduce((s, p) => s + Number(p.valorTotal), 0);
      const dataEmissao = new Date().toISOString().slice(0, 10);
      const dataVencimento = os.dataVencimento || dataEmissao;

      const ultimaFat = db.prepare(`SELECT numero FROM faturas ORDER BY id DESC LIMIT 1`).get();
      let numFat = 1;
      if (ultimaFat) { const m = String(ultimaFat.numero).match(/(\d+)/); if (m) numFat = parseInt(m[1], 10) + 1; }
      const numeroFatura = String(numFat).padStart(6, '0');

      const tipoOpPecas = os.tipoOperacaoId
        ? db.prepare('SELECT emiteNFe FROM tipos_operacao WHERE id = ?').get(os.tipoOperacaoId)
        : null;
      const modo = tipoOpPecas
        ? (tipoOpPecas.emiteNFe ? 'sefaz' : 'interno')
        : (os.ambienteFiscal || (os.naoEmitirNFe ? 'interno' : 'sefaz'));
      const statusSefazInicial = (modo === 'interno' || modo === 'nenhum') ? 'nao_fiscal' : null;

      const faturaId = db.transaction(() => {
        const fId = db.prepare(`
          INSERT INTO faturas (numero, pedidoId, osId, clienteId, dataEmissao, dataVencimento,
            valorBruto, valorFrete, valorDesconto, valorTotal, meioPagamento, observacao, statusSefaz,
            tipoOperacaoId)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
        `).run(numeroFatura, os.pedidoId, osId, os.clienteId, dataEmissao, dataVencimento,
          valorBruto, valorBruto, os.formaPagamento || null,
          `OS ${os.numero} — peças`, statusSefazInicial,
          os.tipoOperacaoId || null
        ).lastInsertRowid;
        for (const p of pecas) {
          db.prepare(`
            INSERT INTO fatura_itens (faturaId, produtoId, sku, descricao, unidade,
              quantidade, precoUnitario, valorTotal, ncm, cfop, origem)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(fId, p.produtoId || null, p.sku || null, p.descricao, p.unidade || null,
            p.quantidade, p.valorUnitario, p.valorTotal, p.ncm || null, p.cfop || null, p.origem || null);
        }
        db.prepare(`UPDATE contas_a_receber SET faturaId = ?, dataAtualizacao = CURRENT_TIMESTAMP
          WHERE osId = ? AND origemTipo = 'os_pecas' AND faturaId IS NULL`).run(fId, osId);
        return fId;
      })();

      if (statusSefazInicial === 'nao_fiscal') {
        recalcStatusFiscal(db, osId);
        registrarEvento(db, osId, 'faturamento', `Fatura #${numeroFatura} marcada como interna`, usuario, { modo: 'interno', faturaId });
        return { success: true, naoFiscal: true, faturaId };
      }

      const emit = await emitirNFe(db, faturaId);
      recalcStatusFiscal(db, osId);
      const autorizada = emit && emit.success !== false;
      registrarEvento(db, osId, 'faturamento',
        autorizada ? `NF-e #${numeroFatura} autorizada` : `Falha NF-e #${numeroFatura}: ${emit?.error || 'ver log'}`,
        usuario, { modo: 'sefaz', faturaId, resultado: emit });
      return { success: true, faturaId, sefaz: emit };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // Faturar (Fase 9.3): cria pedido + CRs + emite NFSe/NF-e conforme tipo.
  // Body opcional: { formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe,
  //                  nfseParams: { codigoTributacaoNacional, codigoListaServico, aliquota } }
  // Resposta inclui resultado de cada emissão separadamente — falhas fiscais NÃO
  // revertem o faturamento local (pedido+CRs ficam preservados; front mostra
  // botão de retry).
  app.post('/api/os/:id/faturar', async (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (os.status !== 'concluida') return res.status(400).json({ success: false, error: 'OS deve estar concluída' });
      if (os.pedidoId) return res.status(400).json({ success: false, error: 'OS já faturada (pedido #'+os.pedidoId+')' });

      const pecas = db.prepare('SELECT * FROM os_itens_pecas WHERE osId = ?').all(os.id);
      const servicos = db.prepare('SELECT * FROM os_itens_servicos WHERE osId = ?').all(os.id);
      if (!pecas.length && !servicos.length) return res.status(400).json({ success: false, error: 'OS sem peças nem serviços' });

      // Parâmetros de faturamento: body tem prioridade, depois os.campos persistidos, depois defaults
      const b = req.body || {};
      const formaPagamento = b.formaPagamento ?? os.formaPagamento ?? null;
      const dataHoje = new Date().toISOString().slice(0, 10);
      const addDias = (iso, n) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
      const dataVencimento = b.dataVencimento ?? os.dataVencimento ?? addDias(dataHoje, 30);
      const numeroParcelas = Math.max(1, Number(b.numeroParcelas ?? os.numeroParcelas) || 1);
      const naoEmitirNFe = b.naoEmitirNFe !== undefined ? (b.naoEmitirNFe ? 1 : 0) : (os.naoEmitirNFe ? 1 : 0);

      // Próximo número de pedido (mesmo padrão usado em pedidos)
      const ultimo = db.prepare(`SELECT numero FROM pedidos ORDER BY id DESC LIMIT 1`).get();
      let numPed = 1;
      if (ultimo) { const m = String(ultimo.numero).match(/(\d+)/); if (m) numPed = parseInt(m[1],10) + 1; }
      const numeroPedido = String(numPed).padStart(6, '0');

      // Cria uma ou mais parcelas de CR para um "slot" (peças ou serviços)
      const valorPecas = Number(os.valorPecas) || 0;
      const valorServicos = Number(os.valorServicos) || 0;
      const valorTotal = valorPecas + valorServicos;

      const stmtCR = db.prepare(`
        INSERT INTO contas_a_receber
          (pessoaId, osId, pedidoId, origemTipo, descricao, valor, dataEmissao, dataVencimento, status, formaPagamento)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aberta', ?)
      `);

      const criarCRs = (pedidoId, valor, origem) => {
        if (valor <= 0) return [];
        const ids = [];
        // arredondar parcelas com ajuste no último para bater o total
        const parcelaBase = Math.floor((valor * 100) / numeroParcelas) / 100;
        let acumulado = 0;
        for (let i = 1; i <= numeroParcelas; i++) {
          const venc = addDias(dataVencimento, (i - 1) * 30);
          const valorParc = (i === numeroParcelas) ? Number((valor - acumulado).toFixed(2)) : parcelaBase;
          acumulado += valorParc;
          const origemLabel = origem === 'pecas' ? 'Peças' : origem === 'servicos' ? 'Serviços' : 'Total';
          const desc = numeroParcelas > 1
            ? `OS ${os.numero} — ${origemLabel} (${i}/${numeroParcelas}): ${os.titulo}`
            : `OS ${os.numero} — ${origemLabel}: ${os.titulo}`;
          const r = stmtCR.run(os.clienteId, os.id, pedidoId, `os_${origem}`, desc, valorParc, dataHoje, venc, formaPagamento);
          ids.push(r.lastInsertRowid);
        }
        return ids;
      };

      // Mapeia tipoOperacao da OS para tipoOperacao do pedido gerado. Preserva a flag emiteNFe:
      //   OS com emiteNFe=1 → pedido VDA-NORMAL (emite NF-e das peças)
      //   OS com emiteNFe=0 (interna/garantia) → pedido VDA-NAOFISCAL (sem NF-e)
      let pedidoTipoOpId = null;
      if (os.tipoOperacaoId) {
        const tipoOpOs = db.prepare('SELECT emiteNFe FROM tipos_operacao WHERE id = ?').get(os.tipoOperacaoId);
        const codigoAlvo = tipoOpOs?.emiteNFe ? 'VDA-NORMAL' : 'VDA-NAOFISCAL';
        const alvo = db.prepare(`SELECT id FROM tipos_operacao WHERE codigo = ?`).get(codigoAlvo);
        pedidoTipoOpId = alvo?.id || null;
      }

      const trx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO pedidos (numero, tipo, clienteId, status, dataPedido, valorTotal, observacao, tipoOperacaoId)
          VALUES (?, 'os', ?, 'confirmado', ?, ?, ?, ?)
        `).run(numeroPedido, os.clienteId, dataHoje, valorTotal,
          `Originado da OS ${os.numero}: ${os.titulo}`, pedidoTipoOpId);
        const pedidoId = r.lastInsertRowid;

        const stmtItem = db.prepare(`
          INSERT INTO pedido_itens (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const it of pecas) {
          stmtItem.run(pedidoId, it.produtoId, it.descricao, it.quantidade, it.valorUnitario, it.valorTotal);
        }
        for (const sv of servicos) {
          stmtItem.run(pedidoId, null, sv.descricao + (sv.horas ? ` (${sv.horas}h)` : ''),
            sv.horas || 1, sv.valorHora || sv.valorTotal, sv.valorTotal);
        }

        // OS mista → 2 CRs (peças/serviços separados). Caso puro → 1 CR do tipo correspondente.
        let crIds = [];
        if (valorPecas > 0 && valorServicos > 0) {
          crIds = crIds.concat(criarCRs(pedidoId, valorPecas, 'pecas'));
          crIds = crIds.concat(criarCRs(pedidoId, valorServicos, 'servicos'));
        } else if (valorPecas > 0) {
          crIds = criarCRs(pedidoId, valorPecas, 'pecas');
        } else if (valorServicos > 0) {
          crIds = criarCRs(pedidoId, valorServicos, 'servicos');
        }

        db.prepare(`UPDATE os_ordens SET status = 'faturada', pedidoId = ?, dataFaturamento = CURRENT_TIMESTAMP,
          formaPagamento = ?, dataVencimento = ?, numeroParcelas = ?, naoEmitirNFe = ?,
          statusFiscal = 'pendente' WHERE id = ?`)
          .run(pedidoId, formaPagamento, dataVencimento, numeroParcelas, naoEmitirNFe, os.id);
        return { pedidoId, crIds };
      });
      const { pedidoId, crIds } = trx();

      // Fase 9.3: emissão fiscal automática.
      // Precedência: tipoOperacao.emiteNFe (novo) > ambienteFiscal (legado) > naoEmitirNFe.
      const resultadoFiscal = { nfse: null, nfe: null };
      const tipoOpFat = os.tipoOperacaoId
        ? db.prepare('SELECT emiteNFe FROM tipos_operacao WHERE id = ?').get(os.tipoOperacaoId)
        : null;
      const ambiente = tipoOpFat
        ? (tipoOpFat.emiteNFe ? 'sefaz' : 'interno')
        : (os.ambienteFiscal || (naoEmitirNFe ? 'interno' : 'sefaz'));
      if (ambiente !== 'nenhum') {
        if (valorServicos > 0) {
          resultadoFiscal.nfse = await _emitirNfseDaOS(os.id, b.nfseParams || {}, req.user?.username);
        }
        if (valorPecas > 0) {
          resultadoFiscal.nfe = await _emitirNfeDaOS(os.id, req.user?.username);
        }
      }

      registrarEvento(db, os.id, 'faturamento',
        `OS faturada (pedido #${pedidoId}, ${crIds.length} CR)`, req.user?.username,
        { pedidoId, crIds, ambienteFiscal: ambiente, fiscal: resultadoFiscal });
      logAction(db, req, 'faturar', 'os', os.id, { pedidoId, crIds, ambiente, resultadoFiscal });
      res.json({ success: true, pedidoId, crIds, ambienteFiscal: ambiente, fiscal: resultadoFiscal });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== EMISSÃO MANUAL (retry / uso avulso) ====================
  // Os dois endpoints abaixo delegam aos helpers usados também pelo faturar
  // automático — mantém API antiga e permite retry individual.

  app.post('/api/os/:id/emitir-nfse', async (req, res) => {
    const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(req.params.id);
    if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });
    if (os.status !== 'faturada') return res.status(400).json({ success: false, error: 'OS precisa estar faturada' });
    const r = await _emitirNfseDaOS(req.params.id, req.body || {}, req.user?.username);
    if (r.success) {
      logAction(db, req, r.naoFiscal ? 'emitir-nfse-interna' : 'emitir-nfse', 'os', req.params.id, r);
      return res.json(r);
    }
    res.status(400).json(r);
  });

  app.post('/api/os/:id/emitir-nfe', async (req, res) => {
    const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(req.params.id);
    if (!os) return res.status(404).json({ success: false, error: 'OS não encontrada' });
    if (os.status !== 'faturada') return res.status(400).json({ success: false, error: 'OS precisa estar faturada' });
    const r = await _emitirNfeDaOS(req.params.id, req.user?.username);
    if (r.success) {
      logAction(db, req, r.naoFiscal ? 'emitir-nfe-interna' : 'emitir-nfe', 'os', req.params.id, r);
      return res.json(r);
    }
    res.status(400).json(r);
  });

  // ==================== ITENS: PEÇAS ====================

  app.post('/api/os/:id/pecas', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['faturada','cancelada'].includes(os.status)) return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      const {
        produtoId, descricao, quantidade, valorUnitario, loteId, serialIds,
        compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
        dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro,
      } = req.body;
      const terceiro = compradoTerceiro ? 1 : 0;
      const qtd = Number(quantidade), valor = Number(valorUnitario);

      if (!quantidade || valorUnitario == null) {
        return res.status(400).json({ success: false, error: 'quantidade e valorUnitario obrigatórios' });
      }
      if (terceiro) {
        if (!descricao) return res.status(400).json({ success: false, error: 'Descrição obrigatória para peça de terceiro' });
        if (!fornecedorId || custoTerceiro == null) {
          return res.status(400).json({ success: false, error: 'Comprado de terceiro exige fornecedor e custo' });
        }
      } else if (!produtoId) {
        return res.status(400).json({ success: false, error: 'produtoId obrigatório para peça do estoque' });
      }

      const newId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO os_itens_pecas (osId, produtoId, descricao, quantidade, valorUnitario, valorTotal, loteId, serialIds,
            compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
            dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(os.id, produtoId || null, descricao || '', qtd, valor, qtd*valor,
                loteId || null, Array.isArray(serialIds) && serialIds.length ? JSON.stringify(serialIds) : null,
                terceiro,
                terceiro ? Number(fornecedorId) : null,
                terceiro ? Number(custoTerceiro) : null,
                terceiro ? (notaFiscalTerceiro || null) : null,
                terceiro ? (dataCompraTerceiro || null) : null,
                terceiro ? (formaPagamentoTerceiro || null) : null,
                terceiro ? (dataVencimentoTerceiro || null) : null);
        const id = r.lastInsertRowid;
        if (terceiro) {
          const apId = sincronizarAPDoItem(db, os.id, id, 'peca', {
            compradoTerceiro: 1,
            descricao: descricao || '',
            fornecedorId, custoTerceiro,
            notaFiscalTerceiro, dataCompraTerceiro,
            formaPagamentoTerceiro, dataVencimentoTerceiro,
            contasPagarId: null,
          });
          if (apId) db.prepare('UPDATE os_itens_pecas SET contasPagarId = ? WHERE id = ?').run(apId, id);
          // Estoque: gera mov_entrada se há produtoId vinculado
          if (produtoId) {
            const movId = lancarEntradaTerceiroPeca(db, os.id, {
              compradoTerceiro: 1, produtoId, quantidade: qtd,
              custoTerceiro, dataCompraTerceiro, id,
            });
            if (movId) db.prepare('UPDATE os_itens_pecas SET movEntradaTerceiroId = ? WHERE id = ?').run(movId, id);
          }
        }
        return id;
      })();
      recalcTotais(db, os.id);
      logAction(db, req, 'add-peca', 'os', os.id, { produtoId: produtoId || null, quantidade: qtd, terceiro });
      res.json({ success: true, peca: db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(newId) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Edita campos de aquisição de terceiro de uma peça já adicionada
  // (custo, fornecedor, NF, datas). Mantém produtoId/quantidade/valorUnitario
  // imutáveis — para mudar isso, remova e adicione de novo.
  app.put('/api/os/pecas/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(item.osId);
      if (os && ['faturada','cancelada'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      }
      const merged = {
        ...item,
        ...req.body,
        compradoTerceiro: req.body.compradoTerceiro != null ? (req.body.compradoTerceiro ? 1 : 0) : item.compradoTerceiro,
      };
      db.transaction(() => {
        const apId = sincronizarAPDoItem(db, item.osId, item.id, 'peca', merged);
        db.prepare(`UPDATE os_itens_pecas SET
            compradoTerceiro = ?, fornecedorId = ?, custoTerceiro = ?, notaFiscalTerceiro = ?,
            dataCompraTerceiro = ?, formaPagamentoTerceiro = ?, dataVencimentoTerceiro = ?,
            contasPagarId = ?
          WHERE id = ?`).run(
          merged.compradoTerceiro,
          merged.fornecedorId || null,
          merged.custoTerceiro != null ? Number(merged.custoTerceiro) : null,
          merged.notaFiscalTerceiro || null,
          merged.dataCompraTerceiro || null,
          merged.formaPagamentoTerceiro || null,
          merged.dataVencimentoTerceiro || null,
          apId,
          item.id,
        );
      })();
      logAction(db, req, 'edit-peca', 'os', item.osId, { itemId: item.id, terceiro: merged.compradoTerceiro });
      res.json({ success: true, peca: db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(item.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/pecas/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_pecas WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (item.movSaidaId) return res.status(400).json({ success: false, error: 'Peça já baixou estoque — estorne primeiro' });
      if (item.contasPagarId && contaAPagarTemPagamento(db, item.contasPagarId)) {
        return res.status(409).json({ success: false, error: 'AP do terceiro já foi pago — baixe ou cancele em Contas a Pagar antes de remover' });
      }
      db.transaction(() => {
        if (item.contasPagarId) removerContaAPagarSeAberta(db, item.contasPagarId);
        if (item.movEntradaTerceiroId) {
          // Estorno: como ainda não houve saída (validado acima), basta deletar a entrada
          db.prepare('DELETE FROM movimentacoes_estoque WHERE id = ? AND tipo = ?').run(item.movEntradaTerceiroId, 'entrada');
        }
        db.prepare('DELETE FROM os_itens_pecas WHERE id = ?').run(item.id);
      })();
      recalcTotais(db, item.osId);
      logAction(db, req, 'rem-peca', 'os', item.osId, { itemId: item.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ITENS: SERVIÇOS ====================

  app.post('/api/os/:id/servicos', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (['faturada','cancelada'].includes(os.status)) return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      const {
        servicoId, horas, valorHora, valorTotal,
        compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
        dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro,
      } = req.body;
      let { descricao } = req.body;

      // Catálogo de serviços: se servicoId vier, usa nome/descricao/valorPadrao como defaults.
      let catalogo = null;
      if (servicoId != null && servicoId !== '') {
        catalogo = db.prepare('SELECT * FROM servicos WHERE id = ? AND ativo = 1').get(Number(servicoId));
        if (!catalogo) return res.status(400).json({ success: false, error: 'Serviço de catálogo não encontrado ou inativo' });
        if (!descricao) descricao = catalogo.descricao || catalogo.nome;
      }

      if (!descricao) return res.status(400).json({ success: false, error: 'descricao obrigatória' });

      let total;
      if (valorTotal != null && valorTotal !== '') total = Number(valorTotal);
      else if (horas && valorHora) total = Number(horas) * Number(valorHora);
      else if (catalogo && catalogo.valorPadrao != null) total = Number(catalogo.valorPadrao);
      else return res.status(400).json({ success: false, error: 'Informe valorTotal, horas+valorHora ou vincule um serviço com valor padrão' });

      const terceiro = compradoTerceiro ? 1 : 0;
      if (terceiro && (!fornecedorId || custoTerceiro == null)) {
        return res.status(400).json({ success: false, error: 'Serviço de terceiro exige fornecedor e custo' });
      }

      const newId = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO os_itens_servicos (osId, descricao, horas, valorHora, valorTotal, servicoId,
            compradoTerceiro, fornecedorId, custoTerceiro, notaFiscalTerceiro,
            dataCompraTerceiro, formaPagamentoTerceiro, dataVencimentoTerceiro)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(os.id, descricao, horas != null && horas !== '' ? Number(horas) : null,
          valorHora != null && valorHora !== '' ? Number(valorHora) : null, total,
          catalogo ? catalogo.id : null,
          terceiro,
          terceiro ? Number(fornecedorId) : null,
          terceiro ? Number(custoTerceiro) : null,
          terceiro ? (notaFiscalTerceiro || null) : null,
          terceiro ? (dataCompraTerceiro || null) : null,
          terceiro ? (formaPagamentoTerceiro || null) : null,
          terceiro ? (dataVencimentoTerceiro || null) : null,
        );
        const id = r.lastInsertRowid;
        if (terceiro) {
          const apId = sincronizarAPDoItem(db, os.id, id, 'servico', {
            compradoTerceiro: 1, descricao,
            fornecedorId, custoTerceiro,
            notaFiscalTerceiro, dataCompraTerceiro,
            formaPagamentoTerceiro, dataVencimentoTerceiro,
            contasPagarId: null,
          });
          if (apId) db.prepare('UPDATE os_itens_servicos SET contasPagarId = ? WHERE id = ?').run(apId, id);
        }
        return id;
      })();

      recalcTotais(db, os.id);
      logAction(db, req, 'add-servico', 'os', os.id, { descricao, total, servicoId: catalogo?.id || null, terceiro });
      res.json({ success: true, servico: db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(newId) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Edita campos de aquisição de terceiro de um serviço já adicionado.
  app.put('/api/os/servicos/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const os = db.prepare('SELECT status FROM os_ordens WHERE id = ?').get(item.osId);
      if (os && ['faturada','cancelada'].includes(os.status)) {
        return res.status(400).json({ success: false, error: 'OS não permite alteração' });
      }
      const merged = {
        ...item,
        ...req.body,
        compradoTerceiro: req.body.compradoTerceiro != null ? (req.body.compradoTerceiro ? 1 : 0) : item.compradoTerceiro,
      };
      db.transaction(() => {
        const apId = sincronizarAPDoItem(db, item.osId, item.id, 'servico', merged);
        db.prepare(`UPDATE os_itens_servicos SET
            compradoTerceiro = ?, fornecedorId = ?, custoTerceiro = ?, notaFiscalTerceiro = ?,
            dataCompraTerceiro = ?, formaPagamentoTerceiro = ?, dataVencimentoTerceiro = ?,
            contasPagarId = ?
          WHERE id = ?`).run(
          merged.compradoTerceiro,
          merged.fornecedorId || null,
          merged.custoTerceiro != null ? Number(merged.custoTerceiro) : null,
          merged.notaFiscalTerceiro || null,
          merged.dataCompraTerceiro || null,
          merged.formaPagamentoTerceiro || null,
          merged.dataVencimentoTerceiro || null,
          apId,
          item.id,
        );
      })();
      logAction(db, req, 'edit-servico', 'os', item.osId, { itemId: item.id, terceiro: merged.compradoTerceiro });
      res.json({ success: true, servico: db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(item.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/servicos/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_itens_servicos WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (item.contasPagarId && contaAPagarTemPagamento(db, item.contasPagarId)) {
        return res.status(409).json({ success: false, error: 'AP do terceiro já foi pago — baixe ou cancele em Contas a Pagar antes de remover' });
      }
      db.transaction(() => {
        if (item.contasPagarId) removerContaAPagarSeAberta(db, item.contasPagarId);
        db.prepare('DELETE FROM os_itens_servicos WHERE id = ?').run(item.id);
      })();
      recalcTotais(db, item.osId);
      logAction(db, req, 'rem-servico', 'os', item.osId, { itemId: item.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== APONTAMENTOS ====================

  app.post('/api/os/:id/apontamentos', (req, res) => {
    try {
      const os = db.prepare('SELECT * FROM os_ordens WHERE id = ?').get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      const { dataInicio, dataFim, horas, descricao, tecnicoId } = req.body;
      if (!dataInicio) return res.status(400).json({ success: false, error: 'dataInicio obrigatória' });
      let h = horas != null ? Number(horas) : null;
      if (!h && dataFim) {
        h = (new Date(dataFim) - new Date(dataInicio)) / 3600000;
      }
      const r = db.prepare(`
        INSERT INTO os_apontamentos (osId, tecnicoId, dataInicio, dataFim, horas, descricao)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(os.id, tecnicoId || os.tecnicoId || req.user?.id || null, dataInicio, dataFim || null, h, descricao || null);
      logAction(db, req, 'apontar', 'os', os.id, { horas: h });
      res.json({ success: true, apontamento: db.prepare('SELECT * FROM os_apontamentos WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/apontamentos/:apontId', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM os_apontamentos WHERE id = ?').get(req.params.apontId);
      if (!a) return res.status(404).json({ success: false, error: 'Não encontrado' });
      db.prepare('DELETE FROM os_apontamentos WHERE id = ?').run(a.id);
      logAction(db, req, 'rem-apontamento', 'os', a.osId, { id: a.id });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== TIPOS DE OS (catálogo) ====================

  // SELECT comum: junta tipos_operacao para expor a "Natureza de Operação"
  // (textoPadraoNFe) que será mostrada em ordens-servico.html ao escolher o
  // Tipo de OS — sem precisar do usuário escolher Tipo de Operação à parte.
  const SQL_OS_TIPOS_BASE = `
    SELECT t.*,
           op.codigo       AS tipoOperacaoPadraoCodigo,
           op.textoPadraoNFe AS tipoOperacaoPadraoTexto
      FROM os_tipos t
      LEFT JOIN tipos_operacao op ON op.id = t.tipoOperacaoPadraoId
  `;

  app.get('/api/os-tipos', (req, res) => {
    try {
      const incluirInativos = req.query.todos === '1';
      const sql = SQL_OS_TIPOS_BASE +
        (incluirInativos ? ' ORDER BY t.ativo DESC, t.nome' : ' WHERE t.ativo = 1 ORDER BY t.nome');
      const rows = db.prepare(sql).all();
      res.json({ success: true, tipos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/os-tipos/:id', (req, res) => {
    try {
      const t = db.prepare(SQL_OS_TIPOS_BASE + ' WHERE t.id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      res.json({ success: true, tipo: t });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  function slugify(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  app.post('/api/os-tipos', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.nome) return res.status(400).json({ success: false, error: 'nome obrigatório' });
      const slug = (b.slug && slugify(b.slug)) || slugify(b.nome);
      if (!slug) return res.status(400).json({ success: false, error: 'slug inválido' });
      const r = db.prepare(`INSERT INTO os_tipos
        (nome, slug, descricao, modoFiscal, slaDiasPadrao, exigeEnderecoExec,
         exigeAssinaturaCliente, exigeOrcamentoAprovado, cor, tipoOperacaoPadraoId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        b.nome.trim(), slug, b.descricao || null,
        b.modoFiscal || 'sefaz',
        b.slaDiasPadrao != null && b.slaDiasPadrao !== '' ? Number(b.slaDiasPadrao) : null,
        b.exigeEnderecoExec ? 1 : 0,
        b.exigeAssinaturaCliente ? 1 : 0,
        b.exigeOrcamentoAprovado ? 1 : 0,
        b.cor || '#4dabf7',
        b.tipoOperacaoPadraoId != null && b.tipoOperacaoPadraoId !== '' ? Number(b.tipoOperacaoPadraoId) : null
      );
      logAction(db, req, 'criar', 'os-tipo', r.lastInsertRowid, { nome: b.nome, slug });
      res.json({ success: true, tipo: db.prepare(SQL_OS_TIPOS_BASE + ' WHERE t.id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/os-tipos/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM os_tipos WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Tipo não encontrado' });
      const b = req.body || {};
      const slug = b.slug ? slugify(b.slug) : atual.slug;
      db.prepare(`UPDATE os_tipos SET
        nome = ?, slug = ?, descricao = ?, modoFiscal = ?, slaDiasPadrao = ?,
        exigeEnderecoExec = ?, exigeAssinaturaCliente = ?, exigeOrcamentoAprovado = ?,
        cor = ?, ativo = ?, tipoOperacaoPadraoId = ? WHERE id = ?`).run(
        b.nome != null ? String(b.nome).trim() : atual.nome,
        slug,
        b.descricao !== undefined ? b.descricao : atual.descricao,
        b.modoFiscal || atual.modoFiscal,
        b.slaDiasPadrao !== undefined && b.slaDiasPadrao !== ''
          ? (b.slaDiasPadrao === null ? null : Number(b.slaDiasPadrao))
          : atual.slaDiasPadrao,
        b.exigeEnderecoExec != null ? (b.exigeEnderecoExec ? 1 : 0) : atual.exigeEnderecoExec,
        b.exigeAssinaturaCliente != null ? (b.exigeAssinaturaCliente ? 1 : 0) : atual.exigeAssinaturaCliente,
        b.exigeOrcamentoAprovado != null ? (b.exigeOrcamentoAprovado ? 1 : 0) : atual.exigeOrcamentoAprovado,
        b.cor || atual.cor,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        b.tipoOperacaoPadraoId !== undefined
          ? (b.tipoOperacaoPadraoId === null || b.tipoOperacaoPadraoId === '' ? null : Number(b.tipoOperacaoPadraoId))
          : atual.tipoOperacaoPadraoId,
        req.params.id
      );
      logAction(db, req, 'editar', 'os-tipo', Number(req.params.id), { nome: b.nome, slug });
      res.json({ success: true, tipo: db.prepare(SQL_OS_TIPOS_BASE + ' WHERE t.id = ?').get(req.params.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os-tipos/:id', (req, res) => {
    try {
      const r = db.prepare('UPDATE os_tipos SET ativo = 0 WHERE id = ? AND ativo = 1').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Tipo não encontrado ou já inativo' });
      logAction(db, req, 'inativar', 'os-tipo', Number(req.params.id), {});
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CHECKLIST ====================

  app.get('/api/os/:id/checklist', (req, res) => {
    try {
      const items = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem, id').all(req.params.id);
      res.json({ success: true, checklist: items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/:id/checklist', (req, res) => {
    try {
      const { descricao, obrigatorio, ordem } = req.body || {};
      if (!descricao) return res.status(400).json({ success: false, error: 'descricao obrigatória' });
      const r = db.prepare(
        'INSERT INTO os_checklist (osId, ordem, descricao, obrigatorio) VALUES (?, ?, ?, ?)'
      ).run(req.params.id, Number(ordem) || 0, descricao, obrigatorio ? 1 : 0);
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/os/checklist/:itemId', (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM os_checklist WHERE id = ?').get(req.params.itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const { concluido, descricao, obrigatorio, observacao } = req.body || {};
      const sets = [], vals = [];
      if (descricao !== undefined)  { sets.push('descricao = ?'); vals.push(descricao); }
      if (obrigatorio !== undefined){ sets.push('obrigatorio = ?'); vals.push(obrigatorio ? 1 : 0); }
      if (observacao !== undefined) { sets.push('observacao = ?'); vals.push(observacao || null); }
      if (concluido !== undefined) {
        sets.push('concluido = ?'); vals.push(concluido ? 1 : 0);
        sets.push('dataConclusao = ?'); vals.push(concluido ? new Date().toISOString() : null);
        sets.push('responsavel = ?'); vals.push(concluido ? (req.user?.username || null) : null);
      }
      if (sets.length) {
        vals.push(item.id);
        db.prepare(`UPDATE os_checklist SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/checklist/:itemId', (req, res) => {
    try {
      db.prepare('DELETE FROM os_checklist WHERE id = ?').run(req.params.itemId);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ANEXOS (fotos, PDFs) ====================

  app.get('/api/os/:id/anexos', (req, res) => {
    try {
      const rows = db.prepare('SELECT * FROM os_anexos WHERE osId = ? ORDER BY dataUpload DESC').all(req.params.id);
      res.json({ success: true, anexos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/:id/anexos', uploadOSAnexo.single('arquivo'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Nenhum arquivo recebido' });
      const { categoria = 'outro' } = req.body || {};
      const relPath = path.relative(path.join(__dirname, 'public'), req.file.path).replace(/\\/g, '/');
      const r = db.prepare(`
        INSERT INTO os_anexos (osId, categoria, mimeType, nomeOriginal, caminho, tamanho, uploadedBy)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        req.params.id, categoria, req.file.mimetype, req.file.originalname,
        relPath, req.file.size, req.user?.username || null,
      );
      registrarEvento(db, req.params.id, 'anexo', `Anexo "${req.file.originalname}" (${categoria})`, req.user?.username, { categoria, tamanho: req.file.size });
      res.json({ success: true, id: r.lastInsertRowid, caminho: relPath });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/os/anexos/:anexoId/download', (req, res) => {
    try {
      const anexo = db.prepare('SELECT * FROM os_anexos WHERE id = ?').get(req.params.anexoId);
      if (!anexo) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const abs = path.join(__dirname, 'public', anexo.caminho);
      if (!fs.existsSync(abs)) return res.status(410).json({ success: false, error: 'Arquivo removido do disco' });
      res.download(abs, anexo.nomeOriginal);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/anexos/:anexoId', (req, res) => {
    try {
      const anexo = db.prepare('SELECT * FROM os_anexos WHERE id = ?').get(req.params.anexoId);
      if (!anexo) return res.status(404).json({ success: false, error: 'Não encontrado' });
      try { fs.unlinkSync(path.join(__dirname, 'public', anexo.caminho)); } catch (_) { /* */ }
      db.prepare('DELETE FROM os_anexos WHERE id = ?').run(anexo.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== TIMELINE DE EVENTOS ====================

  app.get('/api/os/:id/eventos', (req, res) => {
    try {
      const rows = db.prepare(
        'SELECT * FROM os_eventos WHERE osId = ? ORDER BY data DESC, id DESC LIMIT 200'
      ).all(req.params.id);
      res.json({
        success: true,
        eventos: rows.map(e => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null })),
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== PDF da OS (Fase 9.5) ====================

  function _dadosOSparaPDF(osId) {
    const os = db.prepare(`
      SELECT o.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
             p.telefone AS clienteTelefone, u.username AS tecnicoNome,
             u.nome AS tecnicoNomeExibicao
      FROM os_ordens o
      JOIN pessoas p ON p.id = o.clienteId
      LEFT JOIN users u ON u.id = o.tecnicoId
      WHERE o.id = ?
    `).get(osId);
    if (!os) return null;
    const pecas = db.prepare(`
      SELECT pi.*, pr.sku FROM os_itens_pecas pi
      LEFT JOIN produtos pr ON pr.id = pi.produtoId
      WHERE pi.osId = ? ORDER BY pi.id
    `).all(osId);
    const servicos = db.prepare('SELECT * FROM os_itens_servicos WHERE osId = ? ORDER BY id').all(osId);
    const checklist = db.prepare('SELECT * FROM os_checklist WHERE osId = ? ORDER BY ordem').all(osId);
    const emitente = db.prepare('SELECT razaoSocial, cnpj, telefone, email FROM fornecedor WHERE id = 1').get() || {};
    return { os, pecas, servicos, checklist, emitente };
  }

  app.get('/api/os/:id/pdf', (req, res) => {
    const d = _dadosOSparaPDF(req.params.id);
    if (!d) return res.status(404).json({ success: false, error: 'Não encontrada' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="OS-${d.os.numero}.pdf"`);
    osPdf.gerar(res, d.os, d.emitente, d.pecas, d.servicos, d.checklist);
  });

  // ==================== ORÇAMENTO PÚBLICO (envio + aprovação) ====================

  // Fase 9.2 (2026-04-22): envia o orçamento ao cliente por email/whatsapp,
  // gera token criptográfico para que ele aprove/rejeite sem login.
  app.post('/api/os/:id/enviar-orcamento', async (req, res) => {
    try {
      const os = db.prepare(`
        SELECT o.*, p.razaoSocial AS clienteNome, p.email AS clienteEmail, p.telefone AS clienteTelefone
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        WHERE o.id = ?
      `).get(req.params.id);
      if (!os) return res.status(404).json({ success: false, error: 'Não encontrada' });
      if (!['rascunho', 'orcamento'].includes(os.orcamentoStatus || 'rascunho') && os.status !== 'rascunho') {
        return res.status(400).json({ success: false, error: 'OS já aprovada ou encerrada' });
      }
      const { canal, destinoEmail, destinoWhatsApp, mensagemExtra } = req.body || {};
      if (!['email', 'whatsapp', 'ambos'].includes(canal)) {
        return res.status(400).json({ success: false, error: 'canal deve ser email, whatsapp ou ambos' });
      }

      // Gera token (ou reusa se já existia — permite reenvio sem invalidar)
      let token = os.orcamentoToken;
      if (!token) token = crypto.randomBytes(32).toString('hex');

      // Monta link público — usa o Host atual (tenant) para manter subdomínio
      const host = req.headers.host || 'liciteagora.app';
      const link = `https://${host}/orcamento.html?token=${token}`;

      const assunto = `Orçamento OS ${os.numero} — ${os.titulo || 'Serviço'}`;
      const valorTotal = Number(os.valorTotal || 0);
      const texto = [
        `Olá ${os.clienteNome},`,
        '',
        `Seu orçamento da OS ${os.numero} está pronto:`,
        os.titulo ? `• ${os.titulo}` : null,
        os.equipamento ? `• Equipamento: ${[os.equipamento, os.marca, os.modelo].filter(Boolean).join(' ')}` : null,
        valorTotal > 0 ? `• Valor total: R$ ${valorTotal.toFixed(2).replace('.', ',')}` : null,
        os.dataPromessa ? `• Prazo estimado: ${os.dataPromessa}` : null,
        '',
        'Para aprovar ou rejeitar o orçamento, acesse:',
        link,
        '',
        mensagemExtra || '',
      ].filter(Boolean).join('\n');

      const canais = [];
      const erros = [];

      if (canal === 'email' || canal === 'ambos') {
        const to = destinoEmail || os.clienteEmail;
        if (!to) erros.push('email do cliente não cadastrado');
        else {
          try {
            await enviarEmailCobranca(db, { to, assunto, texto, valor: valorTotal });
            canais.push({ canal: 'email', destino: to, status: 'enviado' });
          } catch (e) { erros.push(`email: ${e.message}`); }
        }
      }
      if (canal === 'whatsapp' || canal === 'ambos') {
        const tel = (destinoWhatsApp || os.clienteTelefone || '').replace(/\D/g, '');
        if (!tel) erros.push('whatsapp/telefone do cliente não cadastrado');
        else {
          try {
            await enviarWhatsApp(db, { telefone: tel, texto });
            canais.push({ canal: 'whatsapp', destino: tel, status: 'enviado' });
          } catch (e) { erros.push(`whatsapp: ${e.message}`); }
        }
      }

      if (canais.length === 0) {
        return res.status(500).json({ success: false, error: 'Falha ao enviar por todos os canais', detalhes: erros });
      }

      // Persiste token + status
      db.prepare(`
        UPDATE os_ordens
        SET orcamentoToken = ?,
            orcamentoStatus = 'enviado',
            status = CASE WHEN status = 'rascunho' THEN 'orcamento' ELSE status END,
            dataEnvioOrcamento = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(token, os.id);

      registrarEvento(db, os.id, 'enviado', `Orçamento enviado via ${canais.map(c=>c.canal).join('+')}`, req.user?.username, {
        canais, link, erros,
      });
      logAction(db, req, 'enviar-orcamento', 'os', os.id, { canais, erros });
      res.json({ success: true, token, link, canais, erros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // -------- Rotas PÚBLICAS (sem auth, acesso por token) --------

  // Detecta tentativa de enumeração: token deve ser 64 chars hex.
  const TOKEN_RE = /^[a-f0-9]{64}$/i;

  function _osPorToken(token) {
    if (!TOKEN_RE.test(token)) return null;
    return db.prepare(`
      SELECT o.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj
      FROM os_ordens o
      JOIN pessoas p ON p.id = o.clienteId
      WHERE o.orcamentoToken = ?
    `).get(token);
  }

  // Dados resumidos do orçamento — para o cliente ver e decidir
  app.get('/api/orcamento/:token', (req, res) => {
    try {
      const os = _osPorToken(req.params.token);
      if (!os) return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      // Não exponho dados sensíveis do prestador nem da OS operacional.
      const pecas = db.prepare(`
        SELECT pi.descricao, pi.quantidade, pi.valorUnitario, pi.valorTotal, pr.sku
        FROM os_itens_pecas pi LEFT JOIN produtos pr ON pr.id = pi.produtoId
        WHERE pi.osId = ?
      `).all(os.id);
      const servicos = db.prepare(
        'SELECT descricao, horas, valorHora, valorTotal FROM os_itens_servicos WHERE osId = ?'
      ).all(os.id);
      const prestador = db.prepare('SELECT razaoSocial, cnpj, telefone, email FROM fornecedor WHERE id = 1').get() || null;
      res.json({
        success: true,
        orcamento: {
          numero: os.numero,
          titulo: os.titulo,
          equipamento: [os.equipamento, os.marca, os.modelo].filter(Boolean).join(' ') || null,
          defeitoRelatado: os.defeitoRelatado,
          diagnostico: os.diagnostico,
          valorPecas: os.valorPecas,
          valorServicos: os.valorServicos,
          valorTotal: os.valorTotal,
          garantiaDias: os.garantiaDias,
          dataPromessa: os.dataPromessa,
          orcamentoStatus: os.orcamentoStatus,
          dataRespostaOrcamento: os.dataRespostaOrcamento,
          motivoRejeicao: os.motivoRejeicao,
        },
        cliente: { nome: os.clienteNome, cpfCnpj: os.clienteCpfCnpj },
        prestador,
        pecas,
        servicos,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/orcamento/:token/aprovar', (req, res) => {
    try {
      const os = _osPorToken(req.params.token);
      if (!os) return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      if (os.orcamentoStatus === 'aprovado') return res.status(400).json({ success: false, error: 'Já aprovado anteriormente' });
      if (os.orcamentoStatus === 'rejeitado') return res.status(400).json({ success: false, error: 'Já rejeitado' });

      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      const ua = req.headers['user-agent'] || '';
      const assinanteNome = (req.body && req.body.assinanteNome) || os.clienteNome;

      db.prepare(`
        UPDATE os_ordens
        SET orcamentoStatus = 'aprovado',
            status = 'aberta',
            dataRespostaOrcamento = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(os.id);

      registrarEvento(db, os.id, 'aprovado', `Orçamento aprovado pelo cliente (${assinanteNome})`, null, { ip, userAgent: ua, assinanteNome });
      res.json({ success: true, numero: os.numero });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/orcamento/:token/rejeitar', (req, res) => {
    try {
      const os = _osPorToken(req.params.token);
      if (!os) return res.status(404).json({ success: false, error: 'Orçamento não encontrado' });
      if (os.orcamentoStatus === 'aprovado') return res.status(400).json({ success: false, error: 'Já aprovado — contate o prestador' });
      if (os.orcamentoStatus === 'rejeitado') return res.status(400).json({ success: false, error: 'Já rejeitado' });

      const motivo = String((req.body?.motivo || '')).trim();
      if (motivo.length < 3) return res.status(400).json({ success: false, error: 'Informe um motivo (mín. 3 chars)' });
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
      const ua = req.headers['user-agent'] || '';

      db.prepare(`
        UPDATE os_ordens
        SET orcamentoStatus = 'rejeitado',
            status = 'cancelada',
            dataRespostaOrcamento = CURRENT_TIMESTAMP,
            motivoRejeicao = ?,
            dataCancelamento = CURRENT_TIMESTAMP,
            motivoCancelamento = ?
        WHERE id = ?
      `).run(motivo, `Orçamento rejeitado pelo cliente: ${motivo}`, os.id);

      registrarEvento(db, os.id, 'rejeitado', motivo, null, { ip, userAgent: ua, motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ASSINATURAS (cliente e técnico) ====================

  app.post('/api/os/:id/assinar', (req, res) => {
    try {
      const { ator, dataUrl } = req.body || {};
      if (!['cliente', 'tecnico'].includes(ator)) {
        return res.status(400).json({ success: false, error: 'ator deve ser "cliente" ou "tecnico"' });
      }
      if (!dataUrl || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) {
        return res.status(400).json({ success: false, error: 'dataUrl inválido (esperado PNG/JPEG base64)' });
      }
      const col = ator === 'cliente' ? 'assinaturaClienteDataUrl' : 'assinaturaTecnicoDataUrl';
      const colData = ator === 'cliente' ? 'assinaturaClienteData' : 'assinaturaTecnicoData';
      db.prepare(`UPDATE os_ordens SET ${col} = ?, ${colData} = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(dataUrl, req.params.id);
      registrarEvento(db, req.params.id, 'assinatura', `Assinatura do ${ator}`, req.user?.username, { ator });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== NOTIFICAÇÕES CONFIGURÁVEIS (fase 9.5) ====================

  app.get('/api/os/notificacoes-config', (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT id, evento, canal, template, ativo
        FROM os_notificacoes_config
        ORDER BY evento, canal
      `).all();
      res.json({ success: true, configs: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/os/notificacoes-config', (req, res) => {
    try {
      const { evento, canal, template, ativo } = req.body || {};
      if (!evento || !canal) return res.status(400).json({ success: false, error: 'evento e canal são obrigatórios' });
      if (!['email', 'whatsapp', 'telegram'].includes(canal)) {
        return res.status(400).json({ success: false, error: 'canal inválido' });
      }
      const info = db.prepare(`
        INSERT INTO os_notificacoes_config (evento, canal, template, ativo)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(evento, canal) DO UPDATE SET template = excluded.template, ativo = excluded.ativo
      `).run(evento, canal, template || null, ativo ? 1 : 0);
      res.json({ success: true, id: info.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/os/notificacoes-config/:id', (req, res) => {
    try {
      db.prepare(`DELETE FROM os_notificacoes_config WHERE id = ?`).run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== RELATÓRIOS (fase 9.6) ====================
  // Todos aceitam ?de=YYYY-MM-DD&ate=YYYY-MM-DD como filtro de dataAbertura.

  function filtroPeriodo(req) {
    const { de, ate } = req.query;
    const cond = [];
    const params = [];
    if (de)  { cond.push(`date(o.dataAbertura) >= ?`); params.push(de); }
    if (ate) { cond.push(`date(o.dataAbertura) <= ?`); params.push(ate); }
    return { where: cond.length ? ' AND ' + cond.join(' AND ') : '', params };
  }

  // Por técnico: total de OS, receita de serviços, comissão devida.
  app.get('/api/os/relatorios/por-tecnico', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT u.id AS tecnicoId, u.username AS tecnicoNome,
               u.comissaoPercentual AS comissaoPercentual,
               COUNT(o.id) AS totalOS,
               SUM(CASE WHEN o.status = 'faturada' THEN 1 ELSE 0 END) AS faturadas,
               SUM(CASE WHEN o.status = 'cancelada' THEN 1 ELSE 0 END) AS canceladas,
               COALESCE(SUM(o.valorPecas), 0) AS valorPecas,
               COALESCE(SUM(o.valorServicos), 0) AS valorServicos,
               COALESCE(SUM(o.valorTotal), 0) AS valorTotal,
               COALESCE(SUM(CASE WHEN o.status = 'faturada' THEN o.valorServicos ELSE 0 END), 0) AS receitaServicosFaturada,
               COALESCE(SUM(CASE WHEN o.status = 'faturada' THEN o.valorServicos * IFNULL(u.comissaoPercentual,0) / 100.0 ELSE 0 END), 0) AS comissaoDevida
        FROM os_ordens o
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE 1=1 ${f.where}
        GROUP BY u.id, u.username, u.comissaoPercentual
        ORDER BY valorTotal DESC
      `).all(...f.params);
      res.json({ success: true, linhas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Por cliente
  app.get('/api/os/relatorios/por-cliente', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT p.id AS clienteId, p.razaoSocial AS clienteNome, p.cpfCnpj,
               COUNT(o.id) AS totalOS,
               SUM(CASE WHEN o.status = 'faturada' THEN 1 ELSE 0 END) AS faturadas,
               COALESCE(SUM(o.valorTotal), 0) AS valorTotal,
               COALESCE(SUM(CASE WHEN o.status = 'faturada' THEN o.valorTotal ELSE 0 END), 0) AS receitaFaturada,
               MAX(o.dataAbertura) AS ultimaAbertura
        FROM os_ordens o
        JOIN pessoas p ON p.id = o.clienteId
        WHERE 1=1 ${f.where}
        GROUP BY p.id, p.razaoSocial, p.cpfCnpj
        ORDER BY valorTotal DESC
        LIMIT 100
      `).all(...f.params);
      res.json({ success: true, linhas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Por equipamento (agrupado por marca + modelo)
  app.get('/api/os/relatorios/por-equipamento', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT COALESCE(o.marca, '—') AS marca,
               COALESCE(o.modelo, '—') AS modelo,
               COALESCE(o.equipamento, '—') AS equipamento,
               COUNT(o.id) AS totalOS,
               SUM(CASE WHEN o.emGarantia = 1 THEN 1 ELSE 0 END) AS emGarantia,
               COALESCE(SUM(o.valorTotal), 0) AS valorTotal
        FROM os_ordens o
        WHERE o.marca IS NOT NULL OR o.modelo IS NOT NULL ${f.where}
        GROUP BY marca, modelo, equipamento
        ORDER BY totalOS DESC
        LIMIT 100
      `).all(...f.params);
      res.json({ success: true, linhas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Lucratividade: receita - custo de peças (usando produtos.custoMedio)
  app.get('/api/os/relatorios/lucratividade', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT o.id AS osId, o.numero, o.dataAbertura, o.status,
               p.razaoSocial AS clienteNome,
               u.username AS tecnicoNome,
               o.valorPecas, o.valorServicos, o.valorTotal,
               COALESCE((
                 SELECT SUM(IFNULL(pr.custoMedio, 0) * ip.quantidade)
                 FROM os_itens_pecas ip
                 LEFT JOIN produtos pr ON pr.id = ip.produtoId
                 WHERE ip.osId = o.id
               ), 0) AS custoPecas,
               (o.valorTotal - COALESCE((
                 SELECT SUM(IFNULL(pr.custoMedio, 0) * ip.quantidade)
                 FROM os_itens_pecas ip
                 LEFT JOIN produtos pr ON pr.id = ip.produtoId
                 WHERE ip.osId = o.id
               ), 0)) AS margemBruta
        FROM os_ordens o
        LEFT JOIN pessoas p ON p.id = o.clienteId
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE o.status IN ('concluida','faturada') ${f.where}
        ORDER BY o.dataAbertura DESC
        LIMIT 500
      `).all(...f.params);
      res.json({ success: true, linhas: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // SLA: resumo de cumprimento no período
  app.get('/api/os/relatorios/sla', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const resumo = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN slaStatus = 'cumprido' THEN 1 ELSE 0 END) AS cumpridos,
          SUM(CASE WHEN slaStatus = 'estourado' THEN 1 ELSE 0 END) AS estourados,
          SUM(CASE WHEN slaStatus = 'atrasado' THEN 1 ELSE 0 END) AS atrasados,
          SUM(CASE WHEN slaStatus = 'risco' THEN 1 ELSE 0 END) AS emRisco,
          SUM(CASE WHEN slaStatus = 'no-prazo' THEN 1 ELSE 0 END) AS noPrazo,
          SUM(CASE WHEN slaStatus IS NULL THEN 1 ELSE 0 END) AS semSla
        FROM os_ordens o
        WHERE 1=1 ${f.where}
      `).get(...f.params);
      const porTecnico = db.prepare(`
        SELECT u.username AS tecnicoNome,
               COUNT(*) AS total,
               SUM(CASE WHEN o.slaStatus = 'cumprido' THEN 1 ELSE 0 END) AS cumpridos,
               SUM(CASE WHEN o.slaStatus = 'estourado' THEN 1 ELSE 0 END) AS estourados,
               SUM(CASE WHEN o.slaStatus = 'atrasado' THEN 1 ELSE 0 END) AS atrasados
        FROM os_ordens o
        LEFT JOIN users u ON u.id = o.tecnicoId
        WHERE o.slaStatus IS NOT NULL ${f.where}
        GROUP BY u.id, u.username
        ORDER BY total DESC
      `).all(...f.params);
      res.json({ success: true, resumo, porTecnico });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Comissões: detalhe por OS faturada
  app.get('/api/os/relatorios/comissoes', (req, res) => {
    try {
      const f = filtroPeriodo(req);
      const rows = db.prepare(`
        SELECT o.id AS osId, o.numero, o.dataFaturamento,
               u.id AS tecnicoId, u.username AS tecnicoNome,
               u.comissaoPercentual,
               o.valorServicos,
               (o.valorServicos * IFNULL(u.comissaoPercentual, 0) / 100.0) AS comissao
        FROM os_ordens o
        JOIN users u ON u.id = o.tecnicoId
        WHERE o.status = 'faturada' AND u.comissaoPercentual > 0 ${f.where}
        ORDER BY o.dataFaturamento DESC
      `).all(...f.params);
      const totais = rows.reduce((acc, r) => {
        acc.valorServicos += r.valorServicos || 0;
        acc.comissao += r.comissao || 0;
        return acc;
      }, { valorServicos: 0, comissao: 0 });
      res.json({ success: true, linhas: rows, totais });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasOS };
