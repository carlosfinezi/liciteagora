/**
 * habilitacao-routes.js — Certidões & Habilitação da empresa.
 *
 * Gerencia todos os documentos de habilitação usados nas licitações
 * (Lei 14.133/2021), agrupados por categoria:
 *   - juridica              (art. 66) — contrato social, CNPJ, etc.
 *   - fiscal                (art. 68) — CND Federal, CRF FGTS, CNDT, estadual, municipal
 *   - economico-financeira  (art. 69) — balanço, certidão de falência
 *   - tecnica               (art. 67) — atestados, registros em conselhos
 *
 * Cada documento guarda órgão emissor, número, datas de emissão/validade e
 * o arquivo (PDF/imagem) em disco. O status (vigente / a-vencer / vencido /
 * sem-validade) é DERIVADO da dataValidade — nunca persistido.
 *
 * Fase 2 (automação): POST /:id/buscar dispara a busca automática nos portais
 * fiscais. Hoje é um stub com camada de provedores plugável — cada portal
 * (Receita/PGFN, FGTS, TST) entra como um conector próprio depois.
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');

const CATEGORIAS = ['juridica', 'fiscal', 'economico-financeira', 'tecnica'];

// Janela (dias) para um documento entrar no status "a-vencer".
const DIAS_A_VENCER = 30;

// Catálogo de tipos padrão por categoria. `esfera`/`orgao` pré-preenchem o
// formulário; `validade` indica se o documento normalmente tem prazo (só UI).
// `auto` marca os tipos que a Fase 2 (busca automática) pretende cobrir.
const CATALOGO = {
  juridica: [
    { tipo: 'Ato constitutivo / Contrato social', orgao: 'Junta Comercial', validade: false },
    { tipo: 'Cartão CNPJ', orgao: 'Receita Federal', validade: false },
    { tipo: 'Certidão simplificada da Junta Comercial', orgao: 'Junta Comercial', validade: true },
    { tipo: 'Documentos dos sócios/administradores', orgao: '', validade: false },
  ],
  fiscal: [
    { tipo: 'CND Federal (Receita/PGFN)', esfera: 'federal', orgao: 'Receita Federal / PGFN', validade: true, auto: true },
    { tipo: 'CRF FGTS', esfera: 'federal', orgao: 'Caixa Econômica Federal', validade: true, auto: true },
    { tipo: 'CNDT (Débitos Trabalhistas)', esfera: 'federal', orgao: 'TST', validade: true, auto: true },
    { tipo: 'Certidão Negativa Estadual', esfera: 'estadual', orgao: 'Secretaria da Fazenda Estadual', validade: true },
    { tipo: 'Certidão Negativa Municipal', esfera: 'municipal', orgao: 'Prefeitura Municipal', validade: true },
  ],
  'economico-financeira': [
    { tipo: 'Balanço patrimonial e DRE', orgao: 'Contabilidade', validade: false },
    { tipo: 'Certidão negativa de falência/recuperação judicial', orgao: 'TJ / Distribuidor', validade: true },
    { tipo: 'Índices contábeis (LG / SG / LC)', orgao: 'Contabilidade', validade: false },
  ],
  tecnica: [
    { tipo: 'Atestado de capacidade técnica', orgao: '', validade: false },
    { tipo: 'Registro/inscrição no conselho (CREA/CRC/etc.)', orgao: 'Conselho de classe', validade: true },
    { tipo: 'CAT — Certidão de Acervo Técnico', orgao: 'Conselho de classe', validade: true },
  ],
};

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS habilitacao_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      categoria TEXT NOT NULL,
      tipo TEXT NOT NULL,
      esfera TEXT,
      orgaoEmissor TEXT,
      numero TEXT,
      dataEmissao TEXT,
      dataValidade TEXT,
      arquivo TEXT,
      arquivoNome TEXT,
      arquivoMime TEXT,
      arquivoTamanho INTEGER,
      origem TEXT NOT NULL DEFAULT 'manual',
      ultimaBuscaAuto TEXT,
      observacoes TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_habilitacao_cat ON habilitacao_documentos(categoria, ativo);
    CREATE INDEX IF NOT EXISTS idx_habilitacao_validade ON habilitacao_documentos(dataValidade);
  `);
}

// ---------- helpers ----------

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

// Deriva o status a partir da validade. Datas em 'YYYY-MM-DD' comparam
// lexicograficamente, então basta comparar strings.
function statusDoc(dataValidade) {
  if (!dataValidade) return 'sem-validade';
  const hoje = hojeISO();
  if (dataValidade < hoje) return 'vencido';
  const limite = new Date();
  limite.setDate(limite.getDate() + DIAS_A_VENCER);
  const limiteISO = limite.toISOString().slice(0, 10);
  if (dataValidade <= limiteISO) return 'a-vencer';
  return 'vigente';
}

function decorar(doc) {
  return { ...doc, status: statusDoc(doc.dataValidade), temArquivo: !!doc.arquivo };
}

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'habilitacao');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploadArquivo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
      cb(null, `${Date.now()}-${safe}${ext.startsWith('.') ? '' : '.'}${ext}`.replace(/\.+/g, '.'));
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /pdf|image|octet-stream/i.test(file.mimetype) ||
      /\.(pdf|png|jpg|jpeg|webp)$/i.test(file.originalname);
    cb(ok ? null : new Error('Apenas PDF ou imagens'), ok);
  },
});

function registrarRotasHabilitacao(app, db) {
  migrarDB(db);

  // Catálogo de tipos padrão (para popular selects no frontend). `provedores`
  // = tipos com busca automática (o frontend mostra o botão 🔎 só nesses).
  app.get('/api/habilitacao/catalogo', (req, res) => {
    res.json({ success: true, categorias: CATEGORIAS, catalogo: CATALOGO, diasAVencer: DIAS_A_VENCER, provedores: Object.keys(PROVEDORES) });
  });

  // Listagem + KPIs. Filtros: q, categoria, status.
  app.get('/api/habilitacao', (req, res) => {
    try {
      const { q, categoria, status } = req.query;
      const cond = ['ativo = 1'];
      const args = [];
      if (categoria && CATEGORIAS.includes(categoria)) { cond.push('categoria = ?'); args.push(categoria); }
      if (q) {
        cond.push('(tipo LIKE ? OR orgaoEmissor LIKE ? OR numero LIKE ?)');
        const like = `%${q}%`;
        args.push(like, like, like);
      }
      const rows = db.prepare(
        `SELECT * FROM habilitacao_documentos WHERE ${cond.join(' AND ')}
         ORDER BY categoria, dataValidade IS NULL, dataValidade ASC`
      ).all(...args);

      let docs = rows.map(decorar);
      if (status) docs = docs.filter((d) => d.status === status);

      const kpis = { total: 0, vigente: 0, 'a-vencer': 0, vencido: 0, 'sem-validade': 0 };
      for (const d of rows.map(decorar)) { kpis.total++; kpis[d.status]++; }

      res.json({ success: true, documentos: docs, kpis });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/habilitacao/:id', (req, res) => {
    try {
      const d = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ? AND ativo = 1').get(req.params.id);
      if (!d) return res.status(404).json({ success: false, error: 'Documento não encontrado' });
      res.json({ success: true, documento: decorar(d) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/habilitacao', (req, res) => {
    try {
      const b = req.body || {};
      if (!CATEGORIAS.includes(b.categoria)) return res.status(400).json({ success: false, error: 'categoria inválida' });
      if (!b.tipo || !String(b.tipo).trim()) return res.status(400).json({ success: false, error: 'tipo obrigatório' });
      const r = db.prepare(
        `INSERT INTO habilitacao_documentos
         (categoria, tipo, esfera, orgaoEmissor, numero, dataEmissao, dataValidade, observacoes, estabelecimentoId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        b.categoria, String(b.tipo).trim(), b.esfera || null, b.orgaoEmissor || null,
        b.numero || null, b.dataEmissao || null, b.dataValidade || null, b.observacoes || null,
        b.estabelecimentoId || null
      );
      const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(r.lastInsertRowid);
      res.json({ success: true, documento: decorar(doc) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/habilitacao/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ? AND ativo = 1').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Documento não encontrado' });
      const b = req.body || {};
      if (b.categoria && !CATEGORIAS.includes(b.categoria)) return res.status(400).json({ success: false, error: 'categoria inválida' });
      db.prepare(
        `UPDATE habilitacao_documentos SET
           categoria = ?, tipo = ?, esfera = ?, orgaoEmissor = ?, numero = ?,
           dataEmissao = ?, dataValidade = ?, observacoes = ?, estabelecimentoId = ?, dataAtualizacao = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(
        b.categoria || atual.categoria,
        b.tipo != null ? String(b.tipo).trim() : atual.tipo,
        b.esfera != null ? b.esfera : atual.esfera,
        b.orgaoEmissor != null ? b.orgaoEmissor : atual.orgaoEmissor,
        b.numero != null ? b.numero : atual.numero,
        b.dataEmissao != null ? b.dataEmissao : atual.dataEmissao,
        b.dataValidade != null ? b.dataValidade : atual.dataValidade,
        b.observacoes != null ? b.observacoes : atual.observacoes,
        b.estabelecimentoId !== undefined ? b.estabelecimentoId : atual.estabelecimentoId,
        req.params.id
      );
      const doc = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(req.params.id);
      res.json({ success: true, documento: decorar(doc) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/habilitacao/:id', (req, res) => {
    try {
      const d = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(req.params.id);
      if (!d) return res.status(404).json({ success: false, error: 'Documento não encontrado' });
      // Remove o arquivo em disco, se houver.
      if (d.arquivo) {
        const abs = path.join(__dirname, 'public', d.arquivo);
        try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignora */ }
      }
      db.prepare('DELETE FROM habilitacao_documentos WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---------- ARQUIVO (PDF/imagem) ----------
  // multer roda fora do contexto ALS de tenant → usar req.tenantDb.
  app.post('/api/habilitacao/:id/arquivo', uploadArquivo.single('arquivo'), (req, res) => {
    const tdb = req.tenantDb || db;
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'arquivo obrigatório' });
      const doc = tdb.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(req.params.id);
      if (!doc) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignora */ }
        return res.status(404).json({ success: false, error: 'Documento não encontrado' });
      }
      // Se já havia um arquivo, apaga o antigo.
      if (doc.arquivo) {
        const antigo = path.join(__dirname, 'public', doc.arquivo);
        try { if (fs.existsSync(antigo)) fs.unlinkSync(antigo); } catch { /* ignora */ }
      }
      const rel = path.relative(path.join(__dirname, 'public'), req.file.path).replace(/\\/g, '/');
      tdb.prepare(
        `UPDATE habilitacao_documentos SET arquivo = ?, arquivoNome = ?, arquivoMime = ?,
           arquivoTamanho = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(rel, req.file.originalname, req.file.mimetype, req.file.size, req.params.id);
      const upd = tdb.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(req.params.id);
      res.json({ success: true, documento: decorar(upd) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/habilitacao/:id/arquivo', (req, res) => {
    try {
      const d = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(req.params.id);
      if (!d || !d.arquivo) return res.status(404).json({ success: false, error: 'Sem arquivo' });
      const abs = path.join(__dirname, 'public', d.arquivo);
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, error: 'Arquivo ausente no disco' });
      if (req.query.download) return res.download(abs, d.arquivoNome || 'documento');
      res.sendFile(abs);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/habilitacao/:id/arquivo', (req, res) => {
    try {
      const d = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(req.params.id);
      if (!d) return res.status(404).json({ success: false, error: 'Documento não encontrado' });
      if (d.arquivo) {
        const abs = path.join(__dirname, 'public', d.arquivo);
        try { if (fs.existsSync(abs)) fs.unlinkSync(abs); } catch { /* ignora */ }
      }
      db.prepare(
        `UPDATE habilitacao_documentos SET arquivo = NULL, arquivoNome = NULL, arquivoMime = NULL,
           arquivoTamanho = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ---------- FASE 2: busca automática nos portais (stub) ----------
  // Camada de provedores plugável. Cada portal fiscal entra como um conector
  // próprio (à semelhança de bnc/bll/comprasnet). Enquanto não há conector,
  // responde 501 com mensagem clara — o botão da UI já fica pronto.
  const { cnpjIeParaCertidao } = require('./habilitacao-cnpj');
  const PROVEDORES = {
    'CNDT (Débitos Trabalhistas)': require('./habilitacao-provedores/cndt'),
    'CRF FGTS': require('./habilitacao-provedores/crf'),
    'CND Federal (Receita/PGFN)': require('./habilitacao-provedores/cndfed'),
    'Certidão Negativa Estadual': require('./habilitacao-provedores/sefa'),
    'Certidão Negativa Municipal': require('./habilitacao-provedores/mrb'),
  };

  app.post('/api/habilitacao/:id/buscar', async (req, res) => {
    try {
      const d = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ? AND ativo = 1').get(req.params.id);
      if (!d) return res.status(404).json({ success: false, error: 'Documento não encontrado' });
      db.prepare('UPDATE habilitacao_documentos SET ultimaBuscaAuto = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
      const provedor = PROVEDORES[d.tipo];
      if (!provedor) {
        return res.status(501).json({
          success: false,
          error: `Busca automática ainda não disponível para "${d.tipo}". Faça o upload manual do documento.`,
        });
      }
      const tenantSlug = (req.tenant && req.tenant.slug) || process.env.TENANT || null;
      // Multi-loja: CNPJ/IE do estabelecimento do documento (herança matriz↔filial).
      const cnpjCtx = cnpjIeParaCertidao(db, d.estabelecimentoId, d.esfera);
      const resultado = await provedor.buscar(d, { db, tenantSlug, cnpjCtx });
      // o robô grava direto no tenant DB; relê o documento atualizado
      const atualizado = db.prepare('SELECT * FROM habilitacao_documentos WHERE id = ?').get(req.params.id);
      res.json({ success: true, ...resultado, documento: atualizado ? decorar(atualizado) : null });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasHabilitacao, migrarDB, statusDoc, CATALOGO, CATEGORIAS };
