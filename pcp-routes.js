// pcp-routes.js
//
// Endpoints HTTP autenticados que expõem dados do Portal de Compras Públicas
// para o tenant atual. Toda lógica de sessão/parsing vive em pcp-client.js.

const pcp = require('./pcp-client');
const pcpProposta = require('./pcp-proposta');
const pcpLances = require('./pcp-lances');
const { sincronizarPcp } = require('./pcp-monitor');
const { migratePcpSchema } = require('./pcp-schema');
const { queryOne, query } = require('./catalog-pg');
const { compararDatas } = require('./pcp-datas');

// ttCD_CHAVE (operação) = o número final do linkSistemaOrigem público do PNCP.
// Ex: .../PE-001-2026-2026-493366 → 493366.
function chaveDoLink(link) {
  const m = /-(\d+)(?:\/)?$/.exec(String(link || '').trim());
  return m ? m[1] : null;
}
function ehPcp(link, usuarioNome, objeto) {
  return /portaldecompraspublicas\.com\.br/i.test(link || '')
    || /portal de compras p[uú]blicas|ecustomize/i.test(`${usuarioNome || ''} ${objeto || ''}`);
}

// Marca a licitação como 'enviada' no kanban (agenda/kanban/interesses ficam verdes).
// Mesmo padrão do proposta-status-sync do Comprasnet. Precisa do pncp (CNPJ-ANO-SEQ).
function marcarKanbanEnviada(tdb, pncp) {
  const m = /^(\d{14})-(\d{4})-(\d+)$/.exec(String(pncp || '').trim());
  if (!m) return;
  const [, cnpj, ano, seq] = m;
  const a = parseInt(ano, 10), s = parseInt(seq, 10);
  try {
    tdb.prepare(`INSERT OR IGNORE INTO kanban_status (cnpj, ano, sequencial, status, dataAtualizacao)
                 VALUES (?, ?, ?, 'enviada', CURRENT_TIMESTAMP)`).run(cnpj, a, s);
    tdb.prepare(`UPDATE kanban_status SET status = 'enviada',
                 observacao = 'Proposta enviada via PCP',
                 dataAtualizacao = CURRENT_TIMESTAMP
                 WHERE cnpj = ? AND ano = ? AND sequencial = ?`).run(cnpj, a, s);
  } catch (e) { console.error('[PCP] marcarKanbanEnviada:', e.message); }
}

// Itens via API PÚBLICA do PCP (sem auth) — dá descrição/qtd/unidade e, quando o
// edital publica, o valorReferencia (o PNCP às vezes traz 0). Paginado (12/página).
async function fetchPcpApiItens(chave) {
  const out = [];
  for (let pagina = 1; pagina <= 50; pagina++) {
    const r = await fetch(`https://compras.api.portaldecompraspublicas.com.br/v2/licitacao/${encodeURIComponent(chave)}/itens?pagina=${pagina}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', Accept: 'application/json' },
    });
    if (!r.ok) break;
    const j = await r.json().catch(() => null);
    const arr = (j && j.itens && j.itens.result) || [];
    out.push(...arr);
    if (arr.length < 12) break;
  }
  return out;
}

// Preferências de declaração. O enquadramento ME/EPP JÁ vem do cadastro da
// empresa (tela "Minha Empresa" → fornecedor.declaracaoMeEpp); não duplicar em
// config. Validade da proposta não tem campo na empresa → config pcp_validade
// (default 60).
function prefsDeclaracao(db) {
  const get = (k) => { try { return db.prepare('SELECT valor FROM config WHERE chave=?').get(k)?.valor; } catch (e) { return undefined; } };
  let epp = false;
  let empresa = {};
  try {
    const f = db.prepare('SELECT declaracaoMeEpp, declaracaoEquidadeGenero, declaracaoProgramasIntegridade FROM fornecedor WHERE id = 1').get();
    epp = !!(f && f.declaracaoMeEpp);
    // p/ os critérios de desempate (etapa "Informações Complementares" do PCP)
    empresa = { equidadeGenero: !!(f && f.declaracaoEquidadeGenero), integridade: !!(f && f.declaracaoProgramasIntegridade) };
  } catch (e) {
    epp = ['1', 'sim', 'true', 's'].includes(String(get('pcp_epp') ?? '').trim().toLowerCase());
  }
  const validade = parseInt(get('pcp_validade'), 10) || 60;
  return { epp, validade, empresa };
}

function registrarRotasPcp(app, db) {
  // Garante que as tabelas existem mesmo se o scheduler não rodou ainda
  try { migratePcpSchema(db); } catch (e) { console.error('[PCP] migrate erro:', e.message); }

  // Suas participações (Seus Pregões)
  app.get('/api/pcp/seus-pregoes', async (req, res) => {
    try {
      const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
      const r = await pcp.listSeusPregoes(db, { pagina });
      res.json({ success: true, ...r });
    } catch (e) {
      console.error('[PCP] seus-pregoes erro:', e.message);
      res.status(e.etapa === 'sem-credenciais' ? 400 : 500).json({
        success: false,
        error: e.message,
        etapa: e.etapa,
      });
    }
  });

  // Sessões públicas (em andamento/agendadas onde participo)
  app.get('/api/pcp/sessoes-publicas', async (req, res) => {
    try {
      const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
      const r = await pcp.listSessoesPublicas(db, { pagina });
      res.json({ success: true, ...r });
    } catch (e) {
      console.error('[PCP] sessoes-publicas erro:', e.message);
      res.status(e.etapa === 'sem-credenciais' ? 400 : 500).json({
        success: false,
        error: e.message,
        etapa: e.etapa,
      });
    }
  });

  // Invalidar cache de sessão (debug / forçar re-login)
  app.post('/api/pcp/sessao/invalidar', (req, res) => {
    pcp.invalidate(db);
    res.json({ success: true });
  });

  // Mensagens persistidas (últimas N)
  app.get('/api/pcp/mensagens', (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const chaveId = req.query.chaveId ? String(req.query.chaveId) : null;
      const sql = chaveId
        ? `SELECT m.*, p.numero, p.objeto FROM pcp_mensagens m
           LEFT JOIN pcp_pregoes p ON p.chave_id = m.chave_id
           WHERE m.chave_id = ? ORDER BY m.mensagem_id DESC LIMIT ?`
        : `SELECT m.*, p.numero, p.objeto FROM pcp_mensagens m
           LEFT JOIN pcp_pregoes p ON p.chave_id = m.chave_id
           ORDER BY m.criado_em DESC LIMIT ?`;
      const params = chaveId ? [chaveId, limit] : [limit];
      const rows = db.prepare(sql).all(...params);
      res.json({ success: true, mensagens: rows });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Forçar 1 ciclo de sync agora (debug / primeira coleta antes do scheduler)
  app.post('/api/pcp/sync', async (req, res) => {
    try {
      const stats = await sincronizarPcp(db);
      res.json({ success: true, stats });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ─── PROPOSTA ────────────────────────────────────────────────────────────

  function erroProposta(res, e, ctx) {
    console.error(`[PCP proposta/${ctx}] erro:`, e.message);
    const payload = { success: false, error: e.message };
    if (e.code) payload.code = e.code;
    if (e.detalhe) payload.detalhe = e.detalhe;
    res.status(e.etapa === 'sem-credenciais' ? 400 : 500).json(payload);
  }

  // Status da sessão PCP (pro badge da tela)
  app.get('/api/pcp/session', (req, res) => {
    try { res.json({ success: true, ...pcp.getPcpSessionInfo(req.tenantDb || db) }); }
    catch (e) { erroProposta(res, e, 'session'); }
  });

  // Editais PCP dos Interesses do tenant (sem colar link).
  app.get('/api/pcp/proposta/editais', async (req, res) => {
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
           FROM licitacoes WHERE (cnpj, "anoCompra", "sequencialCompra") IN (${tuplas})`, params);
      const editais = rows
        .filter((r) => ehPcp(r.link, r.origem, r.objeto))
        .map((r) => ({ pncp: `${r.cnpj}-${r.ano}-${r.seq}`, orgao: r.orgao, objeto: r.objeto, situacao: r.situacao, encerra: r.encerra, chave: chaveDoLink(r.link) }))
        .filter((r) => r.chave)
        .sort((a, b) => String(a.encerra || '').localeCompare(String(b.encerra || '')));
      res.json({ success: true, editais });
    } catch (e) { erroProposta(res, e, 'editais'); }
  });

  // Resolve a chave a partir do id PNCP (CNPJ-ANO-SEQ) — sem colar URL.
  app.get('/api/pcp/proposta/resolver', async (req, res) => {
    try {
      const pncp = String(req.query.pncp || '').trim();
      const m = /^(\d{14})-(\d{4})-(\d+)$/.exec(pncp);
      if (!m) return res.status(400).json({ success: false, error: 'pncp inválido (esperado CNPJ-ANO-SEQ)' });
      const [, cnpj, ano, seq] = m;
      const row = await queryOne(
        'SELECT "linkSistemaOrigem","objetoCompra","razaoSocial","usuarioNome","dataAberturaProposta","dataEncerramentoProposta" FROM licitacoes WHERE cnpj=$1 AND "anoCompra"=$2 AND "sequencialCompra"=$3',
        [cnpj, parseInt(ano, 10), parseInt(seq, 10)]);
      if (!row) return res.status(404).json({ success: false, error: 'licitação não encontrada no catálogo' });
      const base = { objeto: row.objetoCompra, orgao: row.razaoSocial, portalOrigem: row.usuarioNome };
      if (!ehPcp(row.linkSistemaOrigem, row.usuarioNome, row.objetoCompra)) return res.json({ success: true, portalPcp: false, ...base, error: 'Portal de origem não é PCP' });
      const chave = chaveDoLink(row.linkSistemaOrigem);
      if (!chave) return res.json({ success: true, portalPcp: true, chave: null, linkOrigem: row.linkSistemaOrigem, ...base, error: 'não foi possível derivar a chave do link de origem' });
      const datas = await compararDatas(row);
      res.json({ success: true, portalPcp: true, chave, ...base, ...(datas ? { datas } : {}) });
    } catch (e) { erroProposta(res, e, 'resolver'); }
  });

  // Carrega os itens da proposta. Se as declarações ainda não foram salvas, o PCP
  // não mostra os itens → cai pro catálogo PNCP como prévia (o envio real salva as
  // declarações primeiro e então lê os itens de verdade).
  app.get('/api/pcp/proposta/itens', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const chaveOuUrl = req.query.chave || req.query.url || req.query.token;
      if (!chaveOuUrl) return res.status(400).json({ success: false, error: 'chave (ou url) obrigatório' });
      const dados = await pcpProposta.carregarItens(tdb, String(chaveOuUrl));

      if (dados.declaracoesSalvas) {
        const itens = dados.itens.map((it) => ({
          index: it.index, idItem: it.idItem, descricao: it.descricao,
          quantidade: it.quantidade, unidade: it.unidade,
          valorReferencia: Number.isFinite(pcpProposta.parseValorBR(it.valorReferencia)) ? pcpProposta.parseValorBR(it.valorReferencia) : null,
          valorUnitario: Number.isFinite(pcpProposta.parseValorBR(it.valorUnitario)) && pcpProposta.parseValorBR(it.valorUnitario) > 0 ? pcpProposta.parseValorBR(it.valorUnitario) : null,
          marca: it.marca && it.marca !== 'N/C' ? it.marca : '',
          fabricante: it.fabricante && it.fabricante !== 'N/C' ? it.fabricante : '',
          detalhe: it.detalhe || '', gravado: it.gravado,
        }));
        return res.json({ success: true, declaracoesSalvas: true, chave: dados.chave, contexto: dados.contexto, itens, ...prefsDeclaracao(tdb) });
      }

      // Prévia (proposta ainda não iniciada no PCP): itens vêm da API PÚBLICA do PCP
      // pela chave; a referência do PNCP entra como fallback quando o PCP não publica.
      const apiItens = await fetchPcpApiItens(dados.chave).catch(() => []);
      let pncpRefs = [];
      const mp = /^(\d{14})-(\d{4})-(\d+)$/.exec(String(req.query.pncp || '').trim());
      if (mp) {
        const [, cnpj, ano, seq] = mp;
        pncpRefs = await query(
          `SELECT i."numeroItem" AS n, i."valorUnitarioEstimado" AS valor, i.quantidade AS qtd, i."unidadeMedida" AS unidade, i.descricao AS descricao
             FROM itens i JOIN licitacoes l ON i."licitacaoId" = l.id
            WHERE l.cnpj=$1 AND l."anoCompra"=$2 AND l."sequencialCompra"=$3 ORDER BY i."numeroItem"`,
          [cnpj, parseInt(ano, 10), parseInt(seq, 10)]).catch(() => []);
      }
      const refPncp = (i) => { const p = pncpRefs[i]; return p && p.valor != null && Number(p.valor) > 0 ? Number(p.valor) : null; };
      let itens = [];
      if (apiItens.length) {
        itens = apiItens.map((it, i) => ({
          index: i, idItem: null, descricao: it.descricao,
          quantidade: it.quantidade != null ? Number(it.quantidade) : null, unidade: it.unidade,
          valorReferencia: it.valorReferencia != null ? Number(it.valorReferencia) : refPncp(i),
          valorUnitario: null, marca: '', fabricante: '', detalhe: '', gravado: false,
        }));
      } else if (pncpRefs.length) {
        itens = pncpRefs.map((r, i) => ({
          index: i, idItem: null, descricao: r.descricao, quantidade: r.qtd != null ? Number(r.qtd) : null,
          unidade: r.unidade, valorReferencia: refPncp(i),
          valorUnitario: null, marca: '', fabricante: '', detalhe: '', gravado: false,
        }));
      }
      const semRef = itens.length && itens.every((x) => x.valorReferencia == null);
      res.json({
        success: true, declaracoesSalvas: false, chave: dados.chave, contexto: dados.contexto, itens,
        avisoPreview: !itens.length
          ? 'A proposta ainda não foi iniciada no PCP — os itens serão carregados ao enviar (após salvar as declarações).'
          : (semRef ? 'Itens carregados. Este edital não publica o valor de referência (orçamento sigiloso) — informe os valores manualmente.' : null),
        ...prefsDeclaracao(tdb),
      });
    } catch (e) { erroProposta(res, e, 'itens'); }
  });

  app.post('/api/pcp/proposta/preview', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { chave, url, itens, pncp, compraId } = req.body || {};
      const alvo = chave || url;
      if (!alvo) return res.status(400).json({ success: false, error: 'chave (ou url) obrigatório' });
      const prefs = prefsDeclaracao(tdb);
      const r = await pcpProposta.enviarProposta(tdb, { chaveOuUrl: alvo, itens, pncp, compraId, ...prefs, dryRun: true });
      res.json({ success: true, ...r });
    } catch (e) { erroProposta(res, e, 'preview'); }
  });

  app.post('/api/pcp/proposta/enviar', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { chave, url, itens, pncp, compraId, confirmar, force } = req.body || {};
      const alvo = chave || url;
      if (!alvo) return res.status(400).json({ success: false, error: 'chave (ou url) obrigatório' });
      const prefs = prefsDeclaracao(tdb);
      const dryRun = confirmar !== true; // rede de segurança contra envio acidental
      const r = await pcpProposta.enviarProposta(tdb, { chaveOuUrl: alvo, itens, pncp, compraId, ...prefs, dryRun, force: force === true });
      // Envio real bem-sucedido → marca a licitação como 'enviada' no kanban
      // (deixa agenda/kanban/interesses verdes, igual ao sync do Comprasnet).
      if (r && (r.enviada || r.jaEnviada)) marcarKanbanEnviada(tdb, pncp);
      res.json({ success: true, ...r });
    } catch (e) { erroProposta(res, e, 'enviar'); }
  });

  // ── Disputa (lances na Sessão Pública) ──

  // Estado ao vivo da sala: cabeçalho + itens da aba escolhida.
  app.get('/api/pcp/lances/sala', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const chave = String(req.query.chave || '').trim();
      if (!/^\d+$/.test(chave)) return res.status(400).json({ success: false, error: 'chave inválida' });
      const aba = req.query.aba ? String(req.query.aba) : 'todos';
      const [cabecalho, sala] = await Promise.all([
        pcpLances.lerCabecalho(tdb, chave),
        pcpLances.lerSala(tdb, chave, { aba }),
      ]);
      res.json({ success: true, chave, cabecalho, ...sala });
    } catch (e) {
      console.error('[PCP] lances/sala erro:', e.message);
      res.status(e.etapa === 'sem-credenciais' ? 400 : 500).json({ success: false, error: e.message, etapa: e.etapa });
    }
  });

  // Envio de lance. Sem `confirmar:true` roda em dryRun (monta o corpo, não POSTa).
  app.post('/api/pcp/lances/enviar', async (req, res) => {
    try {
      const tdb = req.tenantDb || db;
      const { chave, idItem, valor, confirmar, casasDecimais, fechado } = req.body || {};
      if (!chave || !idItem) return res.status(400).json({ success: false, error: 'chave e idItem obrigatórios' });
      const envio = fechado === true ? pcpLances.enviarLanceFechado : pcpLances.enviarLance;
      const r = await envio(tdb, {
        chave: String(chave), idItem: String(idItem), valor,
        casasDecimais: parseInt(casasDecimais, 10) || 2,
        dryRun: confirmar !== true,
      });
      res.json({ success: true, ...r });
    } catch (e) {
      console.error('[PCP] lances/enviar erro:', e.message);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  console.log('[PCP] Rotas registradas (/api/pcp/seus-pregoes, /api/pcp/sessoes-publicas, /api/pcp/mensagens, /api/pcp/sync, /api/pcp/proposta/*, /api/pcp/lances/*)');
}

module.exports = { registrarRotasPcp };
