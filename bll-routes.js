// bll-routes.js — Rotas REST do conector BLL (bllcompras.com).
//
// Nesta entrega cobrem sessão + PROPOSTA (Fase 1 e 2). Lance (SignalR) vem na
// Fase 3 em módulos próprios (bll-signalr-client / bll-dispute-*).
//
// Endpoints (auth via middleware de tenant; usam req.tenantDb):
//   GET  /api/bll/session                      → status da sessão (cookie)
//   GET  /api/bll/proposta/itens?token=...      → parseia a página (read-only)
//   POST /api/bll/proposta/preview              → monta payload em dryRun (NÃO envia)
//   POST /api/bll/proposta/enviar               → envia de fato (exige confirmar:true)
//
// SEGURANÇA: /enviar só POSTa na BLL se o body trouxer `confirmar:true`.
// Sem isso, cai em dryRun (mesma resposta do /preview).

'use strict';

const { getSessionInfo, bllGet, bllPost, BllSessaoIndisponivelError, BllSessaoExpiradaError } = require('./bll-client');
const bllProposta = require('./bll-proposta');
const { queryOne, query } = require('./catalog-pg');
const { anexarDocumento } = require('./portal-doc-upload');
const multer = require('multer');
const uploadDoc = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Deriva a URL da tela de proposta BLL a partir do linkSistemaOrigem do edital.
function derivarUrlProposta(link) {
  if (!link) return null;
  if (/\/Process\/ProcessView\?/i.test(link)) return link.replace(/\/Process\/ProcessView\?/i, '/Proposal/Proposal?');
  if (/param1=/i.test(link)) return 'https://bllcompras.com/Proposal/Proposal?' + link.split('?').slice(1).join('?');
  return null;
}
function ehBll(link, usuarioNome) {
  return /bllcompras\.com/i.test(link || '') || /(^|[^a-z])bll([^a-z]|$)/i.test(usuarioNome || '');
}

function handleErro(res, e, ctx) {
  if (e instanceof BllSessaoIndisponivelError || e instanceof BllSessaoExpiradaError) {
    return res.status(400).json({ success: false, error: e.message, code: e.code });
  }
  console.error(`[BLL ${ctx}] erro:`, e.message);
  const payload = { success: false, error: e.message };
  if (e.code) payload.code = e.code;
  if (e.detalhe) payload.detalhe = e.detalhe;
  if (e.respostaResumo) payload.respostaResumo = e.respostaResumo;
  res.status(500).json(payload);
}

function registrarRotasBLL(app, db) {
  app.get('/api/bll/session', (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      res.json({ success: true, ...getSessionInfo(tdb) });
    } catch (e) {
      handleErro(res, e, 'session');
    }
  });

  // Lista os editais BLL dos INTERESSES do tenant (sem colar link).
  app.get('/api/bll/proposta/editais', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      let interesses = [];
      try { interesses = tdb.prepare('SELECT DISTINCT cnpj, ano, sequencial FROM interesse').all(); } catch (e) {}
      if (!interesses.length) return res.json({ success: true, editais: [] });
      const tuplas = interesses.map((_, i) => `($${i * 3 + 1}, $${i * 3 + 2}::int, $${i * 3 + 3}::bigint)`).join(',');
      const params = [];
      interesses.forEach((r) => { params.push(String(r.cnpj), parseInt(r.ano, 10), parseInt(r.sequencial, 10)); });
      const rows = await query(
        `SELECT cnpj, "anoCompra" AS ano, "sequencialCompra" AS seq, "razaoSocial" AS orgao, "objetoCompra" AS objeto,
                "situacaoCompraNome" AS situacao, COALESCE("dataEncerramentoPortal", "dataEncerramentoProposta") AS encerra, "linkSistemaOrigem" AS link, "usuarioNome" AS origem
           FROM licitacoes
          WHERE (cnpj, "anoCompra", "sequencialCompra") IN (${tuplas})`,
        params
      );
      const editais = rows
        .filter((r) => ehBll(r.link, r.origem))
        .map((r) => ({ pncp: `${r.cnpj}-${r.ano}-${r.seq}`, orgao: r.orgao, objeto: r.objeto, situacao: r.situacao, encerra: r.encerra, url: derivarUrlProposta(r.link) }))
        .filter((r) => r.url)
        .sort((a, b) => String(a.encerra || '').localeCompare(String(b.encerra || '')));
      res.json({ success: true, editais });
    } catch (e) {
      handleErro(res, e, 'proposta/editais');
    }
  });

  // Resolve a tela de proposta a partir do id PNCP (CNPJ-ANO-SEQ) — sem colar URL.
  app.get('/api/bll/proposta/resolver', async (req, res) => {
    try {
      const pncp = String(req.query.pncp || '').trim();
      const m = /^(\d{14})-(\d{4})-(\d+)$/.exec(pncp);
      if (!m) return res.status(400).json({ success: false, error: 'pncp inválido (esperado CNPJ-ANO-SEQ)' });
      const [, cnpj, ano, seq] = m;
      const row = await queryOne(
        'SELECT "linkSistemaOrigem","objetoCompra","razaoSocial","usuarioNome" FROM licitacoes WHERE cnpj=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3',
        [cnpj, parseInt(ano, 10), parseInt(seq, 10)]
      );
      if (!row) return res.status(404).json({ success: false, error: 'licitação não encontrada no catálogo' });
      const link = row.linkSistemaOrigem || '';
      const base = { objeto: row.objetoCompra, orgao: row.razaoSocial, portalOrigem: row.usuarioNome };
      if (!ehBll(link, row.usuarioNome)) return res.json({ success: true, portalBll: false, ...base, error: 'Portal de origem não é BLL' });
      const url = derivarUrlProposta(link);
      if (!url) return res.json({ success: true, portalBll: true, url: null, linkOrigem: link, ...base, error: 'não foi possível derivar a URL da proposta do link de origem' });
      res.json({ success: true, portalBll: true, url, ...base });
    } catch (e) {
      handleErro(res, e, 'proposta/resolver');
    }
  });

  app.get('/api/bll/proposta/itens', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const token = req.query.token || req.query.url;
      if (!token) return res.status(400).json({ success: false, error: 'token (ou url) obrigatório' });
      const dados = await bllProposta.carregarItens(tdb, String(token));
      const mp = /^(\d{14})-(\d{4})-(\d+)$/.exec(String(req.query.pncp || '').trim());
      if (mp && dados.itens && dados.itens.length) {
        const [, cnpj, ano, seq] = mp;
        const refs = await query(
          `SELECT i."numeroItem" AS n, i."valorUnitarioEstimado" AS valor, i.quantidade AS qtd, i."unidadeMedida" AS unidade, i.descricao AS descricao
             FROM itens i JOIN licitacoes l ON i."licitacaoId" = l.id
            WHERE l.cnpj=$1 AND l."anoCompra"=$2 AND l."sequencialCompra"=$3 ORDER BY i."numeroItem"`,
          [cnpj, parseInt(ano, 10), parseInt(seq, 10)]
        ).catch(() => []);
        dados.itens = dados.itens.map((it, pos) => {
          const ref = refs[pos] || refs.find((r) => r.n === it.index + 1);
          return ref ? { ...it, valorReferencia: ref.valor != null ? Number(ref.valor) : null, quantidade: ref.qtd != null ? Number(ref.qtd) : null, unidade: ref.unidade, descricao: ref.descricao } : it;
        });
      }
      res.json({ success: true, ...dados });
    } catch (e) {
      handleErro(res, e, 'proposta/itens');
    }
  });

  // Anexa um documento (upload de arquivo) a um item obrigatório da proposta.
  // multipart: campo 'arquivo' + urlOuToken + docIndex.
  app.post('/api/bll/proposta/anexar', uploadDoc.single('arquivo'), async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { urlOuToken, url, token, docIndex } = req.body || {};
      const alvo = urlOuToken || url || token;
      if (!alvo) return res.status(400).json({ success: false, error: 'urlOuToken obrigatório' });
      if (!req.file) return res.status(400).json({ success: false, error: 'arquivo obrigatório' });
      const pagina = await bllProposta.carregarItens(tdb, String(alvo));
      const doc = (pagina.documentos || []).find((d) => String(d.index) === String(docIndex));
      if (!doc) return res.status(400).json({ success: false, error: 'documento não encontrado na tela de proposta' });
      const r = await anexarDocumento({ get: bllGet, post: bllPost }, tdb, {
        doc, file: { buffer: req.file.buffer, filename: req.file.originalname, contentType: req.file.mimetype },
      });
      res.json({ success: true, ...r });
    } catch (e) {
      handleErro(res, e, 'proposta/anexar');
    }
  });

  app.post('/api/bll/proposta/preview', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { urlOuToken, url, token, valores, isMe, fkRepresentant, compraId } = req.body || {};
      const alvo = urlOuToken || url || token;
      if (!alvo) return res.status(400).json({ success: false, error: 'urlOuToken obrigatório' });
      const r = await bllProposta.enviarProposta(tdb, {
        urlOuToken: alvo, valores, isMe, fkRepresentant, compraId, dryRun: true,
      });
      res.json({ success: true, ...r });
    } catch (e) {
      handleErro(res, e, 'proposta/preview');
    }
  });

  app.post('/api/bll/proposta/enviar', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { urlOuToken, url, token, valores, isMe, fkRepresentant, compraId, confirmar, force } = req.body || {};
      const alvo = urlOuToken || url || token;
      if (!alvo) return res.status(400).json({ success: false, error: 'urlOuToken obrigatório' });
      // dryRun real só quando confirmar:true — rede de segurança contra envio acidental.
      const dryRun = confirmar !== true;
      const r = await bllProposta.enviarProposta(tdb, {
        urlOuToken: alvo, valores, isMe, fkRepresentant, compraId, dryRun, force: force === true,
      });
      res.json({ success: true, ...r });
    } catch (e) {
      handleErro(res, e, 'proposta/enviar');
    }
  });
}

module.exports = { registrarRotasBLL };
