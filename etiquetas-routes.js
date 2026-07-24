/**
 * etiquetas-routes.js — Impressão de etiquetas de produto.
 *
 * Dois formatos:
 *  - ZPL (impressoras térmicas Zebra e compatíveis): gerado aqui, texto puro.
 *  - A4/PDF: renderizado no navegador (catalogo/etiquetas.html + JsBarcode
 *    vendorizado) e impresso via window.print() — sem dependência de lib PDF.
 *
 * O código de barras usa, nesta ordem: codigoBarras (EAN) → sku (Code128).
 */

function codigoDoProduto(p) {
  const ean = (p.codigoBarras || '').replace(/\D/g, '');
  if (ean.length === 13 || ean.length === 8) return { codigo: ean, simbologia: 'ean' };
  return { codigo: p.sku, simbologia: 'code128' };
}

// Etiqueta ZPL 2 colunas (modelo comum 33x22mm em rolo duplo) ou 1 coluna.
// ^BE = EAN-13, ^BC = Code128.
function zplEtiqueta(p, x) {
  const { codigo, simbologia } = codigoDoProduto(p);
  const desc = (p.descricao || '').slice(0, 28).replace(/[\^~]/g, ' ');
  const preco = p.precoVenda != null ? `R$ ${Number(p.precoVenda).toFixed(2).replace('.', ',')}` : '';
  const barra = simbologia === 'ean'
    ? `^FO${x + 10},58^BY2^BEN,50,Y,N^FD${codigo}^FS`
    : `^FO${x + 10},58^BY2^BCN,50,Y,N,N^FD${codigo}^FS`;
  return [
    `^FO${x + 10},8^A0N,22,22^FD${desc}^FS`,
    `^FO${x + 10},32^A0N,20,20^FD${preco}^FS`,
    barra
  ].join('\n');
}

function registrarRotasEtiquetas(app, db) {
  // GET /api/etiquetas/zpl?itens=ID:COPIAS,ID:COPIAS&colunas=1|2
  app.get('/api/etiquetas/zpl', (req, res) => {
    try {
      const itensParam = (req.query.itens || '').split(',').filter(Boolean);
      if (!itensParam.length) return res.status(400).json({ success: false, error: 'itens obrigatorio (ID:COPIAS,...)' });
      const colunas = req.query.colunas === '2' ? 2 : 1;

      const fila = [];
      for (const par of itensParam) {
        const [id, copias] = par.split(':');
        const p = db.prepare('SELECT id, sku, descricao, precoVenda, codigoBarras FROM produtos WHERE id = ?').get(Number(id));
        if (!p) continue;
        for (let i = 0; i < Math.min(Number(copias) || 1, 500); i++) fila.push(p);
      }
      if (!fila.length) return res.status(404).json({ success: false, error: 'Nenhum produto encontrado' });

      const LARGURA_COL = 400; // dots (~50mm a 203dpi)
      const blocos = [];
      for (let i = 0; i < fila.length; i += colunas) {
        const linhas = [];
        for (let c = 0; c < colunas && i + c < fila.length; c++) {
          linhas.push(zplEtiqueta(fila[i + c], c * LARGURA_COL));
        }
        blocos.push(`^XA\n${linhas.join('\n')}\n^XZ`);
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="etiquetas.zpl"');
      res.send(blocos.join('\n'));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Dados para o render A4 no navegador
  app.get('/api/etiquetas/dados', (req, res) => {
    try {
      const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) return res.status(400).json({ success: false, error: 'ids obrigatorio' });
      const marks = ids.map(() => '?').join(',');
      const produtos = db.prepare(
        `SELECT id, sku, descricao, precoVenda, codigoBarras, unidade FROM produtos WHERE id IN (${marks})`
      ).all(...ids).map(p => ({ ...p, ...codigoDoProduto(p) }));
      res.json({ success: true, produtos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasEtiquetas };
