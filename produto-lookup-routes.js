/**
 * produto-lookup-routes.js — Catálogos auxiliares de atributos de produto
 * (categoria, marca, modelo, cor, material, gênero, unidade).
 *
 * Extraído de produtos-routes.js (refatoração 2026-04-30: separação
 * Catálogo / Estoque / Compras).
 *
 * Uso no server.js:
 *   const { registrarRotasProdutoLookup } = require('./produto-lookup-routes');
 *   registrarRotasProdutoLookup(app, db);
 */

const LOOKUP_TIPOS = new Set(['categoria', 'marca', 'modelo', 'cor', 'material', 'genero', 'unidade']);

function registrarRotasProdutoLookup(app, db) {
  app.get('/api/produto-lookup/:tipo', (req, res) => {
    try {
      if (!LOOKUP_TIPOS.has(req.params.tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      const itens = db.prepare('SELECT id, valor FROM produto_lookup WHERE tipo = ? AND ativo = 1 ORDER BY valor ASC').all(req.params.tipo);
      res.json({ success: true, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/produto-lookup/:tipo', (req, res) => {
    try {
      if (!LOOKUP_TIPOS.has(req.params.tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      const valor = String(req.body.valor || '').trim();
      if (!valor) return res.status(400).json({ success: false, error: 'valor obrigatorio' });
      try {
        db.prepare('INSERT INTO produto_lookup (tipo, valor) VALUES (?, ?)').run(req.params.tipo, valor);
      } catch { /* UNIQUE — já existe */ }
      db.prepare('UPDATE produto_lookup SET ativo = 1 WHERE tipo = ? AND valor = ?').run(req.params.tipo, valor);
      res.json({ success: true, valor });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/produto-lookup/:tipo/:valor', (req, res) => {
    try {
      if (!LOOKUP_TIPOS.has(req.params.tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      db.prepare('UPDATE produto_lookup SET ativo = 0 WHERE tipo = ? AND valor = ?').run(req.params.tipo, req.params.valor);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Migração única — popula lookup com valores já presentes em produtos.
  // Idempotente via INSERT OR IGNORE.
  try {
    const existentes = db.prepare(`SELECT DISTINCT categoria FROM produtos WHERE categoria IS NOT NULL AND categoria != ''`).all();
    for (const r of existentes) registrarLookup(db, 'categoria', r.categoria);
    const marcas = db.prepare(`SELECT DISTINCT marca FROM produtos WHERE marca IS NOT NULL AND marca != ''`).all();
    for (const r of marcas) registrarLookup(db, 'marca', r.marca);
    const unidades = db.prepare(`SELECT DISTINCT unidade FROM produtos WHERE unidade IS NOT NULL AND unidade != ''`).all();
    for (const r of unidades) registrarLookup(db, 'unidade', r.unidade);
  } catch { /* ignora */ }
}

// Helper exportado: registra valor novo em lookup (idempotente).
// Consumido por produtos-routes.js ao salvar produto.
function registrarLookup(db, tipo, valor) {
  if (!valor) return;
  const v = String(valor).trim();
  if (!v) return;
  try {
    db.prepare('INSERT OR IGNORE INTO produto_lookup (tipo, valor) VALUES (?, ?)').run(tipo, v);
  } catch { /* ignora */ }
}

module.exports = { registrarRotasProdutoLookup, registrarLookup, LOOKUP_TIPOS };
