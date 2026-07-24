/**
 * produtos-routes.js — Catálogo de produtos + import de itens de licitação.
 * Também cria/migra tabelas compartilhadas do módulo Suprimentos:
 *   produtos, movimentacoes_estoque, pedidos, pedido_itens.
 *
 * Uso no server.js:
 *   const { registrarRotasProdutos } = require('./produtos-routes');
 *   registrarRotasProdutos(app, db);
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const produtosImport = require('./produtos-import');
const { logAction } = require('./audit-log');
const { registrarLookup } = require('./produto-lookup-routes');

const uploadPlanilha = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(xlsx|xls|csv)$/i.test(file.originalname) ||
      /spreadsheet|excel|csv/i.test(file.mimetype);
    cb(ok ? null : new Error('Apenas .xlsx, .xls ou .csv'), ok);
  }
});

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'produtos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploadProduto = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.jpg';
      cb(null, `${req.params.id}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Apenas imagens são aceitas'));
  }
});

// Multi-tenant (2026-04-22): migrarDB() e ALTERs em produtos migraram
// para db-schema.js. Roda no provisionamento de cada tenant.

// Fase 3g (2026-05-23): licitacao-itens/search vai pra PG (catalog)
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

function registrarRotasProdutos(app, db) {
  // ==================== PRODUTOS CRUD ====================

  app.get('/api/produtos', (req, res) => {
    try {
      const { q, ativo, incluirOpticos } = req.query;
      let sql = `SELECT p.*,
        f.razaoSocial AS fornecedorNome,
        COALESCE((SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade
                                  WHEN tipo='saida' THEN -quantidade
                                  ELSE quantidade END)
                  FROM movimentacoes_estoque WHERE produtoId = p.id), 0) AS saldo
        FROM produtos p
        LEFT JOIN fornecedores f ON f.id = p.fornecedorId
        WHERE 1=1`;
      const params = [];
      if (ativo !== undefined) { sql += ' AND p.ativo = ?'; params.push(Number(ativo)); }
      else { sql += ' AND p.ativo = 1'; }
      // Esconde armações/lentes por padrão quando o módulo Ótica está ativo
      // (cliente gerencia esses itens via /optica/catalogo-*). Sem o módulo,
      // não filtra nada — comportamento legado preservado.
      if (incluirOpticos !== '1') {
        const opticaOn = (db.prepare("SELECT valor FROM config WHERE chave='optica_enabled'").get() || {}).valor === '1';
        if (opticaOn) sql += ` AND (p.categoria IS NULL OR p.categoria NOT IN ('armacao','lente'))`;
      }
      if (q) {
        sql += ` AND (p.sku LIKE ? OR p.descricao LIKE ?
          OR EXISTS (SELECT 1 FROM produto_codigos pc
                     WHERE pc.produtoId = p.id AND pc.ativo = 1 AND pc.codigo LIKE ?))`;
        const like = `%${q}%`;
        params.push(like, like, like);
      }
      sql += ' ORDER BY p.descricao ASC';
      const produtos = db.prepare(sql).all(...params);
      res.json({ success: true, produtos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/produtos/autocomplete', (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ success: true, produtos: [] });
      const like = `%${q.toLowerCase()}%`;
      const filtros = [];
      const params = [like, like];
      if (req.query.rastreiaSerial === '1') filtros.push('rastreiaSerial = 1');
      if (req.query.rastreiaLote === '1')   filtros.push('rastreiaLote = 1');
      const extra = filtros.length ? ' AND ' + filtros.join(' AND ') : '';
      params.push(like);
      const produtos = db.prepare(
        `SELECT id, sku, descricao, unidade, precoVenda, rastreiaLote, rastreiaSerial
         FROM produtos
         WHERE ativo = 1 AND (LOWER(sku) LIKE ? OR LOWER(descricao) LIKE ?
           OR EXISTS (SELECT 1 FROM produto_codigos pc
                      WHERE pc.produtoId = produtos.id AND pc.ativo = 1 AND LOWER(pc.codigo) LIKE ?))${extra}
         ORDER BY descricao ASC LIMIT 20`
      ).all(...params);
      res.json({ success: true, produtos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/produtos/:id', (req, res) => {
    try {
      const p = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      const saldoRow = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                                 WHEN tipo='saida' THEN -quantidade
                                 ELSE quantidade END), 0) AS saldo
        FROM movimentacoes_estoque WHERE produtoId = ?`).get(req.params.id);
      const opticaSpecs = lerOpticaSpecs(p.id, p.categoria);
      res.json({ success: true, produto: { ...p, saldo: saldoRow.saldo, opticaSpecs } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Campos editáveis de produto (exceto sku — imutável após criação — e colunas de sistema)
  const CAMPOS_PRODUTO = [
    'descricao','unidade','categoria','marca','modelo','cor','material','genero','codigoInterno','referenciaInterna','codigoBarras','tipoProduto',
    'codigoCatmat','codigoCatser','codigoPDM',
    'fornecedorId','precoCusto','markupMinimo','precoMinimoVenda','markupVenda','precoVenda',
    'estoqueMinimo','pontoReposicao','estoqueMaximo','leadTimeDias','localizacao',
    'rastreiaLote','rastreiaSerial',
    'pesoBruto','pesoLiquido','altura','largura','profundidade',
    'validadeDias','escalaRelevante',
    'ncm','cest','cfopPadrao','origem','icmsAliquota','codigoFCI',
    'csosn','cstPIS','cstCOFINS','tipoOrigemProduto',
    'cstIBS','cstCBS','cClassTrib',
    'observacoes'
  ];

  function validarPrecoMinimo(b, existing) {
    const min = b.precoMinimoVenda ?? existing?.precoMinimoVenda;
    const venda = b.precoVenda ?? existing?.precoVenda;
    if (min != null && venda != null && Number(venda) > 0 && Number(venda) < Number(min)) {
      return `Preço de venda (R$ ${venda}) abaixo do mínimo (R$ ${min})`;
    }
    return null;
  }

  // Persiste specs óticas atomicamente quando categoria for armacao/lente.
  // Best-effort: se as tabelas não existirem (tenant sem ótica), ignora.
  function upsertOpticaSpecs(produtoId, categoria, specs) {
    if (!specs || !categoria) return;
    try {
      if (categoria === 'armacao') {
        db.prepare(`INSERT INTO optica_armacao_specs
            (produtoId, marca, modelo, cor, material, aroMm, ponteMm, hasteMm, generoAlvo, observacoes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(produtoId) DO UPDATE SET
            marca = excluded.marca, modelo = excluded.modelo, cor = excluded.cor,
            material = excluded.material, aroMm = excluded.aroMm, ponteMm = excluded.ponteMm,
            hasteMm = excluded.hasteMm, generoAlvo = excluded.generoAlvo,
            observacoes = excluded.observacoes`).run(
          produtoId,
          specs.marca || null, specs.modelo || null, specs.cor || null,
          specs.material || null,
          specs.aroMm != null && specs.aroMm !== '' ? Number(specs.aroMm) : null,
          specs.ponteMm != null && specs.ponteMm !== '' ? Number(specs.ponteMm) : null,
          specs.hasteMm != null && specs.hasteMm !== '' ? Number(specs.hasteMm) : null,
          specs.generoAlvo || null, specs.observacoes || null
        );
      } else if (categoria === 'lente') {
        db.prepare(`INSERT INTO optica_lente_specs
            (produtoId, tipo, material, indiceRefracao, tratamentos, observacoes)
            VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(produtoId) DO UPDATE SET
            tipo = excluded.tipo, material = excluded.material,
            indiceRefracao = excluded.indiceRefracao, tratamentos = excluded.tratamentos,
            observacoes = excluded.observacoes`).run(
          produtoId,
          specs.lenteTipo || specs.tipo || null,
          specs.material || null, specs.indiceRefracao || null,
          specs.tratamentos || null, specs.observacoes || null
        );
      }
    } catch { /* tabelas podem não existir num tenant sem ótica */ }
  }

  function lerOpticaSpecs(produtoId, categoria) {
    if (!categoria) return null;
    try {
      if (categoria === 'armacao') {
        return db.prepare('SELECT marca, modelo, cor, material, aroMm, ponteMm, hasteMm, generoAlvo, observacoes FROM optica_armacao_specs WHERE produtoId = ?').get(produtoId) || null;
      }
      if (categoria === 'lente') {
        return db.prepare('SELECT tipo, material, indiceRefracao, tratamentos, observacoes FROM optica_lente_specs WHERE produtoId = ?').get(produtoId) || null;
      }
    } catch { return null; }
    return null;
  }

  app.post('/api/produtos', (req, res) => {
    try {
      const b = req.body;
      if (!b.sku || !b.descricao) {
        return res.status(400).json({ success: false, error: 'sku e descricao sao obrigatorios' });
      }
      const existente = db.prepare('SELECT * FROM produtos WHERE sku = ?').get(b.sku);
      if (existente) return res.status(409).json({ success: false, error: 'SKU ja cadastrado', produto: existente });

      const erro = validarPrecoMinimo(b, null);
      if (erro) return res.status(400).json({ success: false, error: erro });

      const cols = ['sku', ...CAMPOS_PRODUTO, 'licitacaoItemId'];
      const vals = cols.map(c => {
        if (c === 'sku') return b.sku;
        if (c === 'unidade') return b.unidade || 'UN';
        if (c === 'estoqueMinimo') return b.estoqueMinimo || 0;
        if (c === 'precoCusto' || c === 'precoVenda') return b[c] || 0;
        if (c === 'escalaRelevante') return b.escalaRelevante ? 1 : 0;
        if (c === 'licitacaoItemId') return b.licitacaoItemId || null;
        const v = b[c];
        return v === undefined || v === '' ? null : v;
      });
      const placeholders = cols.map(() => '?').join(',');
      const result = db.prepare(`INSERT INTO produtos (${cols.join(',')}) VALUES (${placeholders})`).run(...vals);
      for (const t of ['categoria','marca','unidade']) if (b[t]) registrarLookup(db, t, b[t]);
      // Specs óticas (atomicidade lógica: se falhar aqui o produto fica sem specs,
      // mas o upsert é idempotente — usuário pode editar e salvar de novo).
      if (b.opticaSpecs && (b.categoria === 'armacao' || b.categoria === 'lente')) {
        upsertOpticaSpecs(result.lastInsertRowid, b.categoria, b.opticaSpecs);
      }
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, produto });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/produtos/:id', (req, res) => {
    try {
      const existing = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      const b = req.body;

      const erro = validarPrecoMinimo(b, existing);
      if (erro) return res.status(400).json({ success: false, error: erro });

      const sets = [];
      const vals = [];
      for (const c of CAMPOS_PRODUTO) {
        if (b[c] === undefined) continue;
        sets.push(`${c} = ?`);
        if (c === 'escalaRelevante') vals.push(b.escalaRelevante ? 1 : 0);
        else vals.push(b[c] === '' ? null : b[c]);
      }
      if (sets.length) {
        sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
        vals.push(req.params.id);
        db.prepare(`UPDATE produtos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      }
      for (const t of ['categoria','marca','unidade']) if (b[t]) registrarLookup(db, t, b[t]);
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
      // Specs óticas — fonte de verdade aqui agora. Quando o body trouxer
      // opticaSpecs, escreve atomicamente; senão, sincroniza marca/modelo/cor
      // (campos compartilhados que vivem em produtos e em optica_armacao_specs).
      if (b.opticaSpecs && (produto.categoria === 'armacao' || produto.categoria === 'lente')) {
        upsertOpticaSpecs(produto.id, produto.categoria, b.opticaSpecs);
      } else if (produto.categoria === 'armacao' &&
                 (b.marca !== undefined || b.modelo !== undefined || b.cor !== undefined)) {
        try {
          db.prepare(`INSERT INTO optica_armacao_specs (produtoId, marca, modelo, cor) VALUES (?, ?, ?, ?)
                      ON CONFLICT(produtoId) DO UPDATE SET
                        marca = excluded.marca, modelo = excluded.modelo, cor = excluded.cor`)
            .run(produto.id, produto.marca || null, produto.modelo || null, produto.cor || null);
        } catch { /* tabela pode não existir num tenant sem ótica */ }
      }
      res.json({ success: true, produto });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CÓDIGOS ALTERNATIVOS ====================

  const TIPOS_CODIGO = new Set(['ean', 'fornecedor', 'anterior', 'fabricante', 'outro']);

  app.get('/api/produtos/:id/codigos', (req, res) => {
    try {
      const codigos = db.prepare(`
        SELECT pc.*, f.razaoSocial AS fornecedorNome
        FROM produto_codigos pc
        LEFT JOIN fornecedores f ON f.id = pc.fornecedorId
        WHERE pc.produtoId = ? AND pc.ativo = 1
        ORDER BY pc.tipo, pc.codigo`).all(req.params.id);
      res.json({ success: true, codigos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/produtos/:id/codigos', (req, res) => {
    try {
      const produto = db.prepare('SELECT id FROM produtos WHERE id = ?').get(req.params.id);
      if (!produto) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      const { codigo, tipo, fornecedorId } = req.body || {};
      const cod = (codigo || '').toString().trim();
      if (!cod) return res.status(400).json({ success: false, error: 'codigo obrigatorio' });
      if (tipo && !TIPOS_CODIGO.has(tipo)) {
        return res.status(400).json({ success: false, error: 'tipo invalido (ean|fornecedor|anterior|fabricante|outro)' });
      }
      const r = db.prepare(`
        INSERT INTO produto_codigos (produtoId, codigo, tipo, fornecedorId)
        VALUES (?, ?, ?, ?)`).run(produto.id, cod, tipo || 'outro', fornecedorId || null);
      logAction(db, req, 'criar', 'produto-codigo', r.lastInsertRowid, { produtoId: produto.id, codigo: cod, tipo });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'Este código já está cadastrado (mesmo tipo/fornecedor)' : err.message;
      res.status(400).json({ success: false, error: msg });
    }
  });

  app.delete('/api/produtos/:id/codigos/:codigoId', (req, res) => {
    try {
      const r = db.prepare('UPDATE produto_codigos SET ativo = 0 WHERE id = ? AND produtoId = ?')
        .run(req.params.codigoId, req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Codigo nao encontrado' });
      logAction(db, req, 'excluir', 'produto-codigo', req.params.codigoId, { produtoId: req.params.id });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== KIT / COMPOSIÇÃO ====================
  // Kit não tem saldo próprio: reserva/baixa explode nos componentes
  // (reservas-routes) e movimentação manual de kit é bloqueada (estoque-routes).

  app.get('/api/produtos/:id/kit', (req, res) => {
    try {
      const itens = db.prepare(`
        SELECT k.*, p.sku, p.descricao, p.unidade, p.precoVenda, p.precoCusto
        FROM produto_kit_itens k
        JOIN produtos p ON p.id = k.produtoFilhoId
        WHERE k.produtoPaiId = ?
        ORDER BY p.descricao`).all(req.params.id);
      res.json({ success: true, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Substitui a composição inteira. itens vazio remove a marca de kit.
  app.put('/api/produtos/:id/kit', (req, res) => {
    try {
      const pai = db.prepare('SELECT id, tipoProduto FROM produtos WHERE id = ?').get(req.params.id);
      if (!pai) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      const itens = Array.isArray(req.body?.itens) ? req.body.itens : [];

      for (const it of itens) {
        if (!it.produtoFilhoId || !(Number(it.quantidade) > 0)) {
          return res.status(400).json({ success: false, error: 'Cada item exige produtoFilhoId e quantidade > 0' });
        }
        if (Number(it.produtoFilhoId) === pai.id) {
          return res.status(400).json({ success: false, error: 'Kit nao pode conter a si mesmo' });
        }
        const filho = db.prepare('SELECT id, tipoProduto FROM produtos WHERE id = ? AND ativo = 1').get(it.produtoFilhoId);
        if (!filho) return res.status(400).json({ success: false, error: `Componente ${it.produtoFilhoId} inexistente/inativo` });
        if (filho.tipoProduto === 'kit') {
          return res.status(400).json({ success: false, error: 'Kit dentro de kit nao suportado (1 nivel)' });
        }
      }
      // Kit com saldo próprio não pode virar kit (histórico de movimentação ficaria órfão)
      if (itens.length && pai.tipoProduto !== 'kit') {
        const temMov = db.prepare('SELECT 1 FROM movimentacoes_estoque WHERE produtoId = ? LIMIT 1').get(pai.id);
        if (temMov) return res.status(400).json({ success: false, error: 'Produto com movimentação de estoque não pode virar kit' });
      }

      const trx = db.transaction(() => {
        db.prepare('DELETE FROM produto_kit_itens WHERE produtoPaiId = ?').run(pai.id);
        const ins = db.prepare('INSERT INTO produto_kit_itens (produtoPaiId, produtoFilhoId, quantidade) VALUES (?, ?, ?)');
        for (const it of itens) ins.run(pai.id, Number(it.produtoFilhoId), Number(it.quantidade));
        db.prepare("UPDATE produtos SET tipoProduto = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?")
          .run(itens.length ? 'kit' : null, pai.id);
      });
      trx();
      logAction(db, req, 'editar', 'produto-kit', pai.id, { componentes: itens.length });
      res.json({ success: true, ehKit: itens.length > 0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/produtos/:id', (req, res) => {
    try {
      const produto = db.prepare('SELECT id, ativo FROM produtos WHERE id = ?').get(req.params.id);
      if (!produto || !produto.ativo) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });

      // Guardas: bloqueia inativação se houver saldo, reservas ativas ou lotes com saldo
      const saldoRow = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
                                 WHEN tipo='saida' THEN -quantidade
                                 ELSE quantidade END), 0) AS saldo
        FROM movimentacoes_estoque WHERE produtoId = ?
      `).get(produto.id);
      const saldo = Number(saldoRow?.saldo || 0);

      let reservas = 0;
      try {
        reservas = db.prepare(
          `SELECT COUNT(*) AS n FROM reservas_estoque WHERE produtoId = ? AND status = 'ativa'`
        ).get(produto.id)?.n || 0;
      } catch { /* tabela pode não existir em instalações antigas */ }

      let lotesComSaldo = 0;
      try {
        lotesComSaldo = db.prepare(
          `SELECT COUNT(*) AS n FROM lotes WHERE produtoId = ? AND ativo = 1 AND saldoAtual > 0`
        ).get(produto.id)?.n || 0;
      } catch { /* idem */ }

      if (saldo !== 0 || reservas > 0 || lotesComSaldo > 0) {
        return res.status(409).json({
          success: false,
          error: 'Produto possui saldo, reservas ou lotes ativos — não pode ser inativado',
          bloqueios: { saldo, reservas, lotesComSaldo }
        });
      }

      const motivo = (req.body?.motivo || '').toString().trim() || null;
      const usuario = req.session?.username || null;
      db.prepare(`
        UPDATE produtos
           SET ativo = 0,
               dataAtualizacao = CURRENT_TIMESTAMP,
               desativadoEm = CURRENT_TIMESTAMP,
               desativadoPor = ?,
               motivoDesativacao = ?
         WHERE id = ? AND ativo = 1
      `).run(usuario, motivo, produto.id);
      logAction(db, req, 'desativar', 'produto', produto.id, { motivo });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== IMPORTAR DE ITEM DE LICITAÇÃO ====================

  app.get('/api/produtos/licitacao-itens/search', async (req, res) => {
    // Lista itens de licitações (para modal de import). q = busca em descricao/objeto.
    try {
      const q = req.query.q || '';
      const like = `%${q}%`;
      let rows;
      if (USE_PG) {
        rows = await catalogPg.query(`
          SELECT i."id" AS "itemId", i."numeroItem" AS "numeroItem", i."descricao" AS descricao,
                 i."quantidade" AS quantidade, i."unidadeMedida" AS "unidadeMedida",
                 i."valorUnitarioEstimado" AS "valorUnitarioEstimado", i."valorTotal" AS "valorTotal",
                 l."id" AS "licitacaoId", l."objetoCompra" AS "objetoCompra",
                 l."numeroControlePNCP" AS "numeroControlePNCP", l."razaoSocial" AS orgao
            FROM itens i
       LEFT JOIN licitacoes l ON l."id" = i."licitacaoId"
           WHERE (i."descricao" ILIKE $1 OR l."objetoCompra" ILIKE $2)
        ORDER BY i."id" DESC
           LIMIT 50
        `, [like, like]);
      } else {
        rows = db.prepare(`
          SELECT i.id AS itemId, i.numeroItem, i.descricao, i.quantidade, i.unidadeMedida,
                 i.valorUnitarioEstimado, i.valorTotal,
                 l.id AS licitacaoId, l.objetoCompra, l.numeroControlePNCP, l.razaoSocial AS orgao
          FROM itens i
          LEFT JOIN licitacoes l ON l.id = i.licitacaoId
          WHERE (i.descricao LIKE ? OR l.objetoCompra LIKE ?)
          ORDER BY i.id DESC
          LIMIT 50
        `).all(like, like);
      }
      res.json({ success: true, itens: rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/produtos/importar-item-licitacao', (req, res) => {
    try {
      const { itemId, sku, precoVenda, estoqueMinimo } = req.body;
      if (!itemId || !sku) return res.status(400).json({ success: false, error: 'itemId e sku sao obrigatorios' });

      const item = db.prepare('SELECT * FROM itens WHERE id = ?').get(itemId);
      if (!item) return res.status(404).json({ success: false, error: 'Item de licitacao nao encontrado' });

      const existente = db.prepare('SELECT * FROM produtos WHERE sku = ?').get(sku);
      if (existente) return res.status(409).json({ success: false, error: 'SKU ja cadastrado', produto: existente });

      const result = db.prepare(`
        INSERT INTO produtos (sku, descricao, unidade, precoCusto, precoVenda,
          estoqueMinimo, licitacaoItemId)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sku,
        item.descricao || 'Produto importado',
        item.unidadeMedida || 'UN',
        item.valorUnitarioEstimado || 0,
        precoVenda != null ? precoVenda : (item.valorUnitarioEstimado || 0),
        estoqueMinimo || 0,
        itemId
      );
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, produto });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // FORNECEDORES e LOOKUPS extraídos para fornecedores-routes.js e
  // produto-lookup-routes.js (refatoração 2026-04-30).

  // ==================== IMPORTAR XLSX/CSV ====================

  app.get('/api/produtos/importar/template.xlsx', (req, res) => {
    try {
      const buf = produtosImport.gerarTemplate();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="modelo-produtos.xlsx"');
      res.send(buf);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/produtos/importar/preview', uploadPlanilha.single('arquivo'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo obrigatorio' });
      const { linhas, cabecalhos } = produtosImport.parsePlanilha(req.file.buffer);
      const resultado = produtosImport.validarLinhas(db, linhas);
      const reconhecidos = cabecalhos.filter(c => c.canonico).map(c => c.canonico);
      const ignorados = cabecalhos.filter(c => !c.canonico && c.original).map(c => c.original);
      res.json({ success: true, ...resultado, cabecalhosReconhecidos: reconhecidos, cabecalhosIgnorados: ignorados });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/api/produtos/importar/confirmar', uploadPlanilha.single('arquivo'), (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo obrigatorio' });
      const politica = req.body.politicaDuplicata === 'pular' ? 'pular' : 'atualizar';
      const resultado = produtosImport.executarImport(db, req.file.buffer, politica);
      res.json({ success: true, ...resultado });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // ==================== IMAGEM DO PRODUTO ====================

  app.post('/api/produtos/:id/imagem', uploadProduto.single('imagem'), (req, res) => {
    try {
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
      if (!produto) {
        if (req.file) fs.unlink(req.file.path, () => {});
        return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      }
      if (!req.file) return res.status(400).json({ success: false, error: 'Arquivo obrigatorio' });
      // Remover imagem anterior, se houver
      if (produto.imagemPath) {
        const antigo = path.join(__dirname, 'public', produto.imagemPath);
        fs.unlink(antigo, () => {});
      }
      const rel = '/uploads/produtos/' + path.basename(req.file.path);
      db.prepare('UPDATE produtos SET imagemPath = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(rel, req.params.id);
      res.json({ success: true, imagemPath: rel });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/produtos/:id/imagem', (req, res) => {
    try {
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(req.params.id);
      if (!produto) return res.status(404).json({ success: false, error: 'Produto nao encontrado' });
      if (produto.imagemPath) {
        const abs = path.join(__dirname, 'public', produto.imagemPath);
        fs.unlink(abs, () => {});
      }
      db.prepare('UPDATE produtos SET imagemPath = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasProdutos };
