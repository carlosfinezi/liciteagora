/**
 * etiquetas-routes.js — Impressão de etiquetas de produto.
 *
 * Dois formatos:
 *  - ZPL (impressoras térmicas Zebra e compatíveis): gerado aqui, texto puro.
 *  - A4/PDF: renderizado no navegador (catalogo/etiquetas.html + JsBarcode
 *    vendorizado) e impresso via window.print() — sem dependência de lib PDF.
 *
 * O código de barras usa, nesta ordem: codigoBarras (EAN) → sku (Code128).
 *
 * 2026-07-31 — mais opções:
 *  - MODELOS: catálogo de folhas A4 e de rolos térmicos servido pelo
 *    backend, para a tela não manter uma lista paralela que diverge.
 *  - Campos configuráveis (descrição/SKU/preço/unidade/código legível) e
 *    escolha entre código de barras, QR ou nenhum.
 *  - ZPL passou a derivar as posições do tamanho em mm em vez de usar
 *    coordenadas fixas de um único modelo de rolo.
 */

// qrcode vem como dependência transitiva (node-sped-pdf). Se sumir num
// npm prune, a etiqueta cai para código de barras em vez de quebrar.
let QRCode = null;
try { QRCode = require('qrcode'); } catch { /* sem QR neste ambiente */ }

const DPI_ZPL = 203;                    // Zebra padrão
const DOTS_MM = DPI_ZPL / 25.4;         // ~8 dots/mm
const mm2dots = mm => Math.round(mm * DOTS_MM);

/**
 * Folhas A4 (210×297mm). As margens são calculadas centralizando a grade
 * na folha — mais confiável que decorar a margem de cada fabricante, e a
 * tela ainda oferece ajuste fino para corrigir desvio da impressora.
 */
const MODELOS_A4 = [
  { id: '3x11-63x25', nome: '3 × 11 · 63,5 × 25,4 mm (33/folha)', cols: 3, rows: 11, larguraMm: 63.5, alturaMm: 25.4, gapXMm: 2.5, gapYMm: 0 },
  { id: '3x10-63x25', nome: '3 × 10 · 63,5 × 25,4 mm (30/folha)', cols: 3, rows: 10, larguraMm: 63.5, alturaMm: 25.4, gapXMm: 2.5, gapYMm: 2 },
  { id: '2x7-99x38',  nome: '2 × 7 · 99,1 × 38,1 mm (14/folha)',  cols: 2, rows: 7,  larguraMm: 99.1, alturaMm: 38.1, gapXMm: 2.5, gapYMm: 0 },
  { id: '2x8-99x34',  nome: '2 × 8 · 99,1 × 33,9 mm (16/folha)',  cols: 2, rows: 8,  larguraMm: 99.1, alturaMm: 33.9, gapXMm: 2.5, gapYMm: 0 },
  { id: '3x8-63x34',  nome: '3 × 8 · 63,5 × 33,9 mm (24/folha)',  cols: 3, rows: 8,  larguraMm: 63.5, alturaMm: 33.9, gapXMm: 2.5, gapYMm: 0 },
  { id: '4x10-48x25', nome: '4 × 10 · 48,5 × 25,4 mm (40/folha)', cols: 4, rows: 10, larguraMm: 48.5, alturaMm: 25.4, gapXMm: 2,   gapYMm: 0 },
  { id: '5x13-38x21', nome: '5 × 13 · 38,1 × 21,2 mm (65/folha)', cols: 5, rows: 13, larguraMm: 38.1, alturaMm: 21.2, gapXMm: 2,   gapYMm: 0 },
  { id: '2x5-99x57',  nome: '2 × 5 · 99,1 × 57,3 mm (10/folha)',  cols: 2, rows: 5,  larguraMm: 99.1, alturaMm: 57.3, gapXMm: 2.5, gapYMm: 0 },
  { id: '1x10-190x25', nome: '1 × 10 · 190 × 25,4 mm (10/folha)', cols: 1, rows: 10, larguraMm: 190,  alturaMm: 25.4, gapXMm: 0,   gapYMm: 2 },
  { id: 'gondola-4x12', nome: 'Gôndola · 4 × 12 · 50 × 22 mm (48/folha)', cols: 4, rows: 12, larguraMm: 50, alturaMm: 22, gapXMm: 2, gapYMm: 1, destaquePreco: true },
];

/** Rolos térmicos comuns. `colunas` = etiquetas lado a lado no rolo. */
const MODELOS_ZPL = [
  { id: 'rolo-33x22-2', nome: 'Rolo 33 × 22 mm · 2 colunas', larguraMm: 33, alturaMm: 22, colunas: 2 },
  { id: 'rolo-33x22-1', nome: 'Rolo 33 × 22 mm · 1 coluna',  larguraMm: 33, alturaMm: 22, colunas: 1 },
  { id: 'rolo-50x25-1', nome: 'Rolo 50 × 25 mm · 1 coluna',  larguraMm: 50, alturaMm: 25, colunas: 1 },
  { id: 'rolo-50x30-2', nome: 'Rolo 50 × 30 mm · 2 colunas', larguraMm: 50, alturaMm: 30, colunas: 2 },
  { id: 'rolo-60x40-1', nome: 'Rolo 60 × 40 mm · 1 coluna',  larguraMm: 60, alturaMm: 40, colunas: 1 },
  { id: 'rolo-100x50-1', nome: 'Rolo 100 × 50 mm · 1 coluna', larguraMm: 100, alturaMm: 50, colunas: 1 },
];

const CAMPOS = [
  { id: 'descricao', nome: 'Descrição', padrao: true },
  { id: 'sku',       nome: 'SKU',       padrao: false },
  { id: 'preco',     nome: 'Preço',     padrao: true },
  { id: 'unidade',   nome: 'Unidade',   padrao: false },
  { id: 'codigo',    nome: 'Código legível abaixo da barra', padrao: true },
];

const TIPOS_CODIGO = [
  { id: 'barras', nome: 'Código de barras' },
  { id: 'qr',     nome: 'QR Code' },
  { id: 'nenhum', nome: 'Sem código' },
];

function codigoDoProduto(p) {
  const ean = (p.codigoBarras || '').replace(/\D/g, '');
  if (ean.length === 13 || ean.length === 8) return { codigo: ean, simbologia: 'ean' };
  return { codigo: p.sku, simbologia: 'code128' };
}

const precoFmt = v => v != null ? `R$ ${Number(v).toFixed(2).replace('.', ',')}` : '';
const limpaZpl = s => String(s || '').replace(/[\^~]/g, ' ');

/**
 * Uma etiqueta ZPL posicionada em (x,y), com as linhas empilhadas dentro
 * da altura disponível. Antes as coordenadas eram fixas e só serviam para
 * o rolo 33×22.
 */
function zplEtiqueta(p, x, y, opts) {
  const { larguraMm, alturaMm, campos, tipoCodigo } = opts;
  const { codigo, simbologia } = codigoDoProduto(p);
  const padX = x + mm2dots(1.5);
  const largura = mm2dots(larguraMm - 3);
  const partes = [];
  let cursor = y + mm2dots(1);

  // Texto: fonte proporcional à altura, para caber em rolo pequeno.
  const fonte = alturaMm >= 35 ? 26 : alturaMm >= 25 ? 22 : 18;
  const linhaTexto = (txt, tamanho) => {
    const maxChars = Math.floor((larguraMm - 3) / (tamanho * 0.45 / DOTS_MM));
    partes.push(`^FO${padX},${cursor}^A0N,${tamanho},${tamanho}^FB${largura},1,0,L,0^FD${limpaZpl(txt).slice(0, maxChars)}^FS`);
    cursor += tamanho + 3;
  };

  if (campos.descricao) linhaTexto(p.descricao, fonte);
  if (campos.sku) linhaTexto(p.sku, fonte - 4);
  if (campos.preco && p.precoVenda != null) {
    linhaTexto(precoFmt(p.precoVenda) + (campos.unidade && p.unidade ? ` / ${p.unidade}` : ''), fonte + 2);
  } else if (campos.unidade && p.unidade) {
    linhaTexto(p.unidade, fonte - 4);
  }

  // O que sobrou de altura vai para o código.
  const alturaCodigo = Math.max(mm2dots(6), (y + mm2dots(alturaMm - 1)) - cursor);
  if (tipoCodigo === 'qr') {
    // ^BQ: magnification 1..10 — escolhida pela altura disponível.
    const mag = Math.max(2, Math.min(8, Math.round(alturaCodigo / mm2dots(4))));
    partes.push(`^FO${padX},${cursor}^BQN,2,${mag}^FDLA,${limpaZpl(codigo)}^FS`);
  } else if (tipoCodigo === 'barras') {
    const legivel = campos.codigo ? 'Y' : 'N';
    partes.push(simbologia === 'ean'
      ? `^FO${padX},${cursor}^BY2^BEN,${alturaCodigo},${legivel},N^FD${codigo}^FS`
      : `^FO${padX},${cursor}^BY2^BCN,${alturaCodigo},${legivel},N,N^FD${limpaZpl(codigo)}^FS`);
  }
  return partes.join('\n');
}

function registrarRotasEtiquetas(app, db) {
  // Catálogo de modelos e campos — fonte única para a tela montar os
  // seletores sem manter uma lista paralela.
  app.get('/api/etiquetas/modelos', (req, res) => {
    res.json({
      success: true,
      a4: MODELOS_A4, zpl: MODELOS_ZPL, campos: CAMPOS, tiposCodigo: TIPOS_CODIGO,
      qrDisponivel: !!QRCode,
      folha: { larguraMm: 210, alturaMm: 297 },
    });
  });

  // GET /api/etiquetas/zpl?itens=ID:COPIAS,...&modelo=&larguraMm=&alturaMm=&colunas=&campos=&tipoCodigo=
  app.get('/api/etiquetas/zpl', (req, res) => {
    try {
      const itensParam = (req.query.itens || '').split(',').filter(Boolean);
      if (!itensParam.length) return res.status(400).json({ success: false, error: 'itens obrigatorio (ID:COPIAS,...)' });

      const modelo = MODELOS_ZPL.find(m => m.id === req.query.modelo);
      const larguraMm = Number(req.query.larguraMm) || (modelo ? modelo.larguraMm : 33);
      const alturaMm = Number(req.query.alturaMm) || (modelo ? modelo.alturaMm : 22);
      const colunas = Math.max(1, Math.min(4, Number(req.query.colunas) || (modelo ? modelo.colunas : 1)));
      const tipoCodigo = TIPOS_CODIGO.some(t => t.id === req.query.tipoCodigo) ? req.query.tipoCodigo : 'barras';
      // campos=descricao,preco,codigo — ausente usa o padrão.
      const pedidos = (req.query.campos || '').split(',').filter(Boolean);
      const campos = Object.fromEntries(CAMPOS.map(c =>
        [c.id, pedidos.length ? pedidos.includes(c.id) : c.padrao]));

      if (larguraMm < 15 || larguraMm > 200 || alturaMm < 10 || alturaMm > 200) {
        return res.status(400).json({ success: false, error: 'Tamanho fora do suportado (15-200mm × 10-200mm)' });
      }

      const fila = [];
      for (const par of itensParam) {
        const [id, copias] = par.split(':');
        const p = db.prepare('SELECT id, sku, descricao, precoVenda, codigoBarras, unidade FROM produtos WHERE id = ?').get(Number(id));
        if (!p) continue;
        for (let i = 0; i < Math.min(Number(copias) || 1, 500); i++) fila.push(p);
      }
      if (!fila.length) return res.status(404).json({ success: false, error: 'Nenhum produto encontrado' });

      const larguraCol = mm2dots(larguraMm);
      const opts = { larguraMm, alturaMm, campos, tipoCodigo };
      const blocos = [];
      for (let i = 0; i < fila.length; i += colunas) {
        const linhas = [];
        for (let c = 0; c < colunas && i + c < fila.length; c++) {
          linhas.push(zplEtiqueta(fila[i + c], c * larguraCol, 0, opts));
        }
        // ^PW/^LL declaram largura e altura do rolo — sem isso a impressora
        // usa o último tamanho configurado nela.
        blocos.push(`^XA\n^PW${larguraCol * colunas}\n^LL${mm2dots(alturaMm)}\n${linhas.join('\n')}\n^XZ`);
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="etiquetas.zpl"');
      res.send(blocos.join('\n'));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Dados para o render A4 no navegador. ?qr=1 devolve o SVG do QR pronto
  // (JsBarcode não faz QR e não há lib de QR vendorizada no front).
  app.get('/api/etiquetas/dados', async (req, res) => {
    try {
      const ids = (req.query.ids || '').split(',').map(Number).filter(Boolean);
      if (!ids.length) return res.status(400).json({ success: false, error: 'ids obrigatorio' });
      const marks = ids.map(() => '?').join(',');
      const produtos = db.prepare(
        `SELECT id, sku, descricao, precoVenda, codigoBarras, unidade FROM produtos WHERE id IN (${marks})`
      ).all(...ids).map(p => ({ ...p, ...codigoDoProduto(p) }));

      if (req.query.qr === '1') {
        if (!QRCode) return res.json({ success: true, produtos, qrDisponivel: false });
        for (const p of produtos) {
          try {
            p.qrSvg = await QRCode.toString(String(p.codigo), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
          } catch { p.qrSvg = null; }
        }
      }
      res.json({ success: true, produtos, qrDisponivel: !!QRCode });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasEtiquetas, MODELOS_A4, MODELOS_ZPL, CAMPOS, TIPOS_CODIGO };
