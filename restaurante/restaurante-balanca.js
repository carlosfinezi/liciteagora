/**
 * restaurante-balanca.js — Módulo Restaurante, fase 5: código pesável.
 *
 * Self-service por quilo e padaria não digitam peso: a balança etiquetadora
 * imprime um EAN-13 que já carrega o produto e o peso (ou o valor), e o
 * operador só bipa. Este arquivo decodifica essa etiqueta.
 *
 * Por que não integrar a balança direto: o PDV roda no navegador e não alcança
 * porta serial. A etiqueta com código de barras é o caminho que funciona sem
 * driver local — e é o que a esmagadora maioria das balanças brasileiras
 * (Toledo, Filizola, Urano) já faz.
 *
 * Layout do EAN-13 pesável no Brasil:
 *
 *   2 P P P P P P V V V V V C
 *   │ └────┬────┘ └───┬───┘ └── dígito verificador (módulo 10)
 *   │      │          └──────── 5 dígitos: valor em centavos OU peso
 *   │      └─────────────────── 6 dígitos: código interno do produto
 *   └────────────────────────── prefixo 2 = uso interno da loja
 *
 * O que os 5 dígitos significam depende de como a balança foi programada, e
 * NÃO dá para adivinhar pelo código: uma etiqueta "02000010125 0" tanto pode
 * ser R$ 1,25 quanto 1,250 kg. Por isso o layout é configuração do tenant
 * (`restaurante_pesavel_layout`), não heurística.
 */

// Dígito verificador do EAN-13 (módulo 10, pesos 1 e 3 alternados).
function dvEan13(doze) {
  let soma = 0;
  for (let i = 0; i < 12; i++) {
    soma += Number(doze[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (soma % 10)) % 10;
}

function ean13Valido(codigo) {
  const c = String(codigo || '').replace(/\D/g, '');
  if (c.length !== 13) return false;
  return dvEan13(c.slice(0, 12)) === Number(c[12]);
}

/**
 * Decodifica uma etiqueta de balança.
 *
 * @param codigo  EAN-13 lido pelo leitor
 * @param layout  'valor' (5 dígitos = centavos) | 'peso' (5 dígitos = gramas)
 * @param opts.prefixos  prefixos aceitos como "uso interno" (default ['2'])
 *
 * Devolve { pesavel:false } para código comum — quem chama trata como produto
 * normal, sem erro: o mesmo leitor bipa etiqueta de balança e código de fábrica.
 */
function decodificarPesavel(codigo, layout = 'valor', opts = {}) {
  const c = String(codigo || '').replace(/\D/g, '');
  const prefixos = opts.prefixos || ['2'];

  if (c.length !== 13 || !prefixos.includes(c[0])) {
    return { pesavel: false, codigo: c };
  }
  // DV errado em etiqueta interna é leitura suja do scanner. Aceitar levaria
  // o peso errado para a comanda, que é pior do que pedir para bipar de novo.
  if (!ean13Valido(c)) {
    return { pesavel: false, codigo: c, erro: 'dígito verificador inválido' };
  }

  const codigoProduto = c.slice(1, 7);
  const cinco = Number(c.slice(7, 12));

  if (layout === 'peso') {
    // 5 dígitos em gramas: 01250 = 1,250 kg
    return { pesavel: true, codigo: c, codigoProduto, pesoKg: cinco / 1000, valor: null, layout };
  }
  // 5 dígitos em centavos: 00125 = R$ 1,25
  return { pesavel: true, codigo: c, codigoProduto, pesoKg: null, valor: cinco / 100, layout };
}

/**
 * Acha o produto a partir do código interno da etiqueta.
 *
 * Ordem: produto_codigos (o cadastro de códigos alternativos que já existe no
 * sistema) → SKU exato → SKU sem zeros à esquerda. A balança costuma gravar o
 * código com zeros à esquerda para completar os 6 dígitos, e o SKU cadastrado
 * quase nunca os tem.
 */
function acharProdutoPorCodigo(db, codigoProduto) {
  const semZeros = String(codigoProduto).replace(/^0+/, '') || '0';

  try {
    const p = db.prepare(`
      SELECT p.* FROM produto_codigos pc
        JOIN produtos p ON p.id = pc.produtoId
       WHERE pc.ativo = 1 AND (pc.codigo = ? OR pc.codigo = ?)
       LIMIT 1
    `).get(String(codigoProduto), semZeros);
    if (p) return p;
  } catch (_) { /* tenant sem produto_codigos — segue pelo SKU */ }

  return db.prepare('SELECT * FROM produtos WHERE sku = ? OR sku = ? LIMIT 1')
    .get(String(codigoProduto), semZeros) || null;
}

function registrarRotasBalanca(app, db, gateFlag, deps) {
  const { lerConfig } = deps;

  // Diagnóstico da etiqueta, sem lançar nada. É a tela de configuração
  // descobrindo se o layout do tenant está certo.
  app.get('/api/restaurante/balanca/decodificar', gateFlag, (req, res) => {
    try {
      const cfg = lerConfig(db);
      const layout = req.query.layout || cfg.restaurante_pesavel_layout || 'valor';
      const d = decodificarPesavel(req.query.codigo, layout);
      let produto = null;
      if (d.pesavel) produto = acharProdutoPorCodigo(db, d.codigoProduto);
      res.json({ success: true, ...d, produto });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Lança item na comanda a partir de um código de barras.
   *
   * Serve os dois casos com o mesmo endpoint, porque na prática é o mesmo
   * gesto do operador: bipar. Etiqueta de balança traz peso/valor; código
   * comum cai no fluxo normal de item.
   */
  app.post('/api/restaurante/comandas/:id/itens-codigo', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });

      const cfg = lerConfig(db);
      const layout = cfg.restaurante_pesavel_layout || 'valor';
      const d = decodificarPesavel(req.body?.codigo, layout);

      if (d.erro) return res.status(400).json({ success: false, error: `etiqueta ilegível: ${d.erro}` });

      let produto = null;
      let pesoKg = null;
      let precoForcado = null;

      if (d.pesavel) {
        produto = acharProdutoPorCodigo(db, d.codigoProduto);
        if (!produto) {
          return res.status(404).json({
            success: false,
            error: `nenhum produto com o código ${d.codigoProduto} da etiqueta`,
            codigoProduto: d.codigoProduto,
          });
        }
        const pcfg = db.prepare('SELECT * FROM rest_produto_config WHERE produtoId = ?').get(produto.id);
        if (layout === 'peso') {
          pesoKg = d.pesoKg;
          if (!(pesoKg > 0)) return res.status(400).json({ success: false, error: 'etiqueta sem peso' });
          if (!pcfg || !pcfg.pesavel || !(Number(pcfg.precoPorKg) > 0)) {
            return res.status(400).json({
              success: false,
              error: `"${produto.descricao}" não está configurado como pesável com preço por kg`,
            });
          }
        } else {
          // Layout 'valor': a balança já fez a conta. Respeitar o valor da
          // etiqueta é o certo — é ele que está impresso e que o cliente viu.
          precoForcado = d.valor;
          if (!(precoForcado > 0)) return res.status(400).json({ success: false, error: 'etiqueta sem valor' });
        }
      } else {
        // Código comum: procura por código alternativo, depois por SKU.
        produto = acharProdutoPorCodigo(db, d.codigo);
        if (!produto) {
          return res.status(404).json({ success: false, error: `código ${d.codigo} não encontrado`, codigo: d.codigo });
        }
      }

      res.json({
        success: true,
        etiqueta: d,
        // Devolve o que lançar em vez de lançar direto: o POST de item já tem
        // toda a validação de cardápio, opções e disponibilidade, e duplicar
        // aquilo aqui criaria dois caminhos para a mesma regra.
        lancar: {
          produtoId: produto.id,
          descricao: produto.descricao,
          quantidade: 1,
          pesoKg,
          precoUnit: precoForcado,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de balança registradas');
}

module.exports = {
  registrarRotasBalanca,
  decodificarPesavel,
  acharProdutoPorCodigo,
  ean13Valido,
  dvEan13,
};
