/**
 * compras-routes.js — Pedidos de compra (purchase orders) + sugestão de compra.
 *
 * Fluxo:
 *   rascunho → enviado → recebido_parcial → recebido (final)
 *   qualquer → cancelado
 *
 * Ao receber um item, gera movimentacoes_estoque tipo=entrada com origem='pedido_compra',
 * origemId=pedidoCompraId, suportando lote/serial opcional.
 *
 * Sugestão: produtos com disponivel <= pontoReposicao (fallback estoqueMinimo).
 * Quantidade sugerida: estoqueMaximo - disponivel (fallback estoqueMinimo*2 - disponivel).
 *
 * Demanda perdida (2026-07-31): vendas_perdidas com motivo='sem_estoque' nos
 * últimos 90 dias entram no cálculo — o alvo passa a cobrir o que se deixou
 * de vender, e produtos sem min/reposição configurados aparecem se houve
 * perda. Só 'sem_estoque': perder por preço/prazo/concorrente não é falha de
 * reposição. ?incluirPerdas=0 volta ao comportamento anterior, e cada item
 * traz quantidadeSugeridaBase + quantidadePorDemandaPerdida para o número
 * ser explicável.
 *
 * Uso:
 *   const { registrarRotasCompras } = require('./compras-routes');
 *   registrarRotasCompras(app, db);
 */

// `enviado_parcial`: fornecedor com integração (ver fornecedor-integracoes.js)
// em que parte dos itens foi transmitida e parte falhou — por exemplo, 2 de 3
// assinaturas compradas na NicSRS. Não se desfaz o que deu certo: a compra já
// debitou saldo do fornecedor. Mesmo espírito de `recebido_parcial`.
const STATUS_VALIDOS = ['rascunho', 'enviado', 'enviado_parcial', 'recebido_parcial', 'recebido', 'cancelado'];

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* coluna ja existe */ } }

function dataBrasilia() {
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().slice(0, 10);
}

function migrarPedidosCompraDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pedidos_compra (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL,
      fornecedorId INTEGER,
      status TEXT NOT NULL DEFAULT 'rascunho',
      dataEmissao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataPrevistaEntrega TEXT,
      dataRecebimento TEXT,
      valorTotal REAL DEFAULT 0,
      observacoes TEXT,
      nfeEntradaId INTEGER,
      usuarioCriador TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fornecedorId) REFERENCES pessoas(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pedcompra_status ON pedidos_compra(status);
    CREATE INDEX IF NOT EXISTS idx_pedcompra_fornec ON pedidos_compra(fornecedorId);

    CREATE TABLE IF NOT EXISTS pedido_compra_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedidoCompraId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      custoUnitario REAL NOT NULL,
      quantidadeRecebida REAL DEFAULT 0,
      observacoes TEXT,
      FOREIGN KEY (pedidoCompraId) REFERENCES pedidos_compra(id),
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_pcitens_pedido ON pedido_compra_itens(pedidoCompraId);
  `);

  // Origem da linha de compra: qual documento pediu este item. Mesma
  // nomenclatura de movimentacoes_estoque (origem/origemId). Hoje só
  // 'pedido_venda'; é o que faz o recebimento saber quem estava esperando.
  alterSafe(db, `ALTER TABLE pedido_compra_itens ADD COLUMN origemTipo TEXT`);
  alterSafe(db, `ALTER TABLE pedido_compra_itens ADD COLUMN origemId INTEGER`);
  alterSafe(db, `ALTER TABLE pedido_compra_itens ADD COLUMN origemItemId INTEGER`);
  alterSafe(db, `CREATE INDEX IF NOT EXISTS idx_pcitens_origem
                   ON pedido_compra_itens(origemTipo, origemId)`);
}

function proximoNumero(db) {
  const ano = new Date().getFullYear();
  const prefixo = `PC-${ano}-`;
  const ult = db.prepare(`
    SELECT numero FROM pedidos_compra
    WHERE numero LIKE ? ORDER BY id DESC LIMIT 1
  `).get(prefixo + '%');
  let n = 1;
  if (ult) {
    const m = ult.numero.match(/-(\d+)$/);
    if (m) n = parseInt(m[1]) + 1;
  }
  return prefixo + String(n).padStart(4, '0');
}

function recalcularValorTotal(db, pedidoCompraId) {
  const total = db.prepare(`
    SELECT COALESCE(SUM(quantidade * custoUnitario), 0) AS total
    FROM pedido_compra_itens WHERE pedidoCompraId = ?
  `).get(pedidoCompraId).total;
  db.prepare('UPDATE pedidos_compra SET valorTotal = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
    .run(total, pedidoCompraId);
  return total;
}

// Fase 3e (2026-05-23): sugestao-mercado migra pra PG (queries
// puramente em catalog: bi_item_sugestao_produto + itens + licitacoes + resultados_bi).
const catalogPg = require('./catalog-pg');
const USE_PG = process.env.CATALOG_BACKEND_PG === '1';

/**
 * Devolve o lastro a quem esperava: cada pedido de venda que gerou linha neste
 * recebimento ganha as reservas que faltavam e uma linha no histórico.
 *
 * A reserva só muda de fato em produto com rastreiaLote — sem lote a reserva já
 * havia sido criada pela quantidade cheia mesmo sem saldo (ver reservas-routes),
 * e a chegada apenas torna o saldo positivo. O histórico vale nos dois casos: é
 * ele que responde "por que este pedido destravou".
 *
 * Aviso por Telegram/email fica atrás de `compra_aviso_chegada` e nasce
 * DESLIGADO. Motivo: enviarAlerta não tem granularidade por tipo de aviso — é
 * tudo-ou-nada por canal, por tenant —, então ligar mais um tipo por padrão
 * despejaria isto em quem nunca pediu. O aviso in-app (histórico + tela do
 * pedido) é o default.
 */
function liberarPedidosDeVenda(db, pedidoCompra, origensAtendidas, req) {
  if (!origensAtendidas.length) return [];
  const { completarReservasPedido } = require('./reservas-routes');

  const porPedido = new Map();
  for (const o of origensAtendidas) {
    if (!porPedido.has(o.pedidoId)) porPedido.set(o.pedidoId, []);
    porPedido.get(o.pedidoId).push({ sku: o.sku, quantidade: o.quantidade });
  }

  const liberados = [];
  for (const [pedidoId, itens] of porPedido) {
    try {
      const ped = db.prepare('SELECT id, numero, status FROM pedidos WHERE id = ?').get(pedidoId);
      if (!ped) continue;
      const r = completarReservasPedido(db, pedidoId);
      db.prepare(`INSERT INTO pedido_historico
          (pedidoId, statusAnterior, statusNovo, acao, motivo, usuario, dadosExtras)
        VALUES (?, NULL, NULL, 'compra-recebida', ?, ?, ?)`).run(
        pedidoId,
        `Recebimento do ${pedidoCompra.numero}: ${itens.map(i => `${i.quantidade} ${i.sku}`).join(', ')}`,
        req?.session?.username || null,
        JSON.stringify({ pedidoCompraId: pedidoCompra.id, pcNumero: pedidoCompra.numero,
                         itens, reservasCriadas: r.reservasCriadas.length }));
      liberados.push({ pedidoId, numero: ped.numero, status: ped.status,
                       itens, reservasCriadas: r.reservasCriadas.length });
    } catch (e) {
      // Recebimento já entrou; não desfazer por causa do aviso.
      console.error('[compras] falha ao liberar pedido de venda', pedidoId, e.message);
    }
  }

  if (liberados.length) {
    let ligado = false;
    try {
      const row = db.prepare('SELECT valor FROM config WHERE chave = ?').get('compra_aviso_chegada');
      ligado = row && row.valor === '1';
    } catch { /* sem tabela config neste tenant */ }
    if (ligado) {
      const { enviarAlerta } = require('./notificacoes-dispatcher');
      enviarAlerta(db, {
        subject: `Compra recebida libera ${liberados.length} pedido(s) de venda`,
        body: `<b>${pedidoCompra.numero}</b> recebido.<br>` +
              liberados.map(l => `Pedido ${l.numero}: ${l.itens.map(i => `${i.quantidade} ${i.sku}`).join(', ')}`).join('<br>'),
        logTag: 'Compras',
      }).catch(e => console.error('[compras] aviso de chegada falhou:', e.message));
    }
  }
  return liberados;
}

function registrarRotasCompras(app, db) {
  migrarPedidosCompraDB(db);

  // ==================== SUGESTÃO DE COMPRA ====================

  // GET /api/compras/sugestao-mercado?grupoId=N&marca=TerraMaster
  //
  // Sugestão de compra baseada em DEMANDA DE MERCADO (licitações públicas),
  // não em estoque interno. Agrupa por modelo sugerido pela IA (vide
  // catalog.bi_item_sugestao_produto), calcula:
  //   - pedidos (volume bruto na janela)
  //   - vendidos / taxaVendaPct (conversão real)
  //   - ticketMedio (valor homologado médio)
  //   - capilaridade (n° de UFs distintas)
  //   - score 0-100 (média ponderada normalizada)
  //   - decisao: ESTOCAR (≥60) / SOB DEMANDA (40-59) / EVITAR (<40)
  //
  // Pesos: volume 30% + taxaVenda 30% + log(ticket) 20% + capilaridade 20%.
  // Volume e ticket são normalizados pelo máximo do recorte.
  app.get('/api/compras/sugestao-mercado', async (req, res) => {
    try {
      const grupoId = parseInt(req.query.grupoId, 10);
      const marca = String(req.query.marca || '').trim();
      const scoreMin = parseInt(req.query.scoreMin, 10) || 70;
      if (!grupoId || isNaN(grupoId)) return res.status(400).json({ error: 'grupoId obrigatório' });
      if (!marca) return res.status(400).json({ error: 'marca obrigatória' });

      const escopo = `grupo_${grupoId}`;

      let rows, hist;
      if (USE_PG) {
        // PG: tudo direto, sem cross-DB. string_agg + GREATEST + LN + to_char.
        rows = await catalogPg.query(`
          WITH base AS (
            SELECT s."modelo_sugerido" AS modelo,
                   COUNT(*) AS pedidos,
                   SUM(CASE WHEN rb."id" IS NOT NULL THEN 1 ELSE 0 END) AS vendidos,
                   AVG(COALESCE(rb."valorTotalHomologado", i."valorTotal", 0)) AS "ticketMedio",
                   SUM(COALESCE(rb."valorTotalHomologado", i."valorTotal", 0)) AS "totalVendido",
                   COUNT(DISTINCT l."ufSigla") AS capilaridade,
                   string_agg(DISTINCT l."ufSigla", ',') AS ufs
              FROM bi_item_sugestao_produto s
              JOIN itens i ON i."id" = s."itemId"
              JOIN licitacoes l ON l."id" = i."licitacaoId"
         LEFT JOIN resultados_bi rb
                ON rb."cnpj" = l."cnpj" AND rb."ano" = l."anoCompra"
               AND rb."sequencial" = l."sequencialCompra" AND rb."numeroItem" = i."numeroItem"
             WHERE s."marca" = $1 AND s."score" >= $2
               AND LOWER(s."modelo_sugerido") != 'nenhum'
             GROUP BY s."modelo_sugerido"
          ), max_vals AS (
            SELECT MAX(pedidos)::float AS "maxPedidos", MAX("ticketMedio") AS "maxTicket" FROM base
          )
          SELECT b.*,
                 (
                   (b.pedidos*100.0/m."maxPedidos")*0.3 +
                   (b.vendidos*100.0/b.pedidos)*0.3 +
                   (CASE WHEN m."maxTicket" > 0
                         THEN (LN(GREATEST(b."ticketMedio",1))/LN(m."maxTicket"+1))*100*0.2
                         ELSE 0 END) +
                   (b.capilaridade*100.0/27)*0.2
                 )::int AS score
            FROM base b, max_vals m
        ORDER BY score DESC
        `, [marca, scoreMin]);

        hist = await catalogPg.query(`
          SELECT s."modelo_sugerido" AS modelo,
                 to_char(l."dataPublicacaoPncp", 'YYYY-MM') AS mes,
                 COUNT(*)::int AS pedidos
            FROM bi_item_sugestao_produto s
            JOIN itens i ON i."id" = s."itemId"
            JOIN licitacoes l ON l."id" = i."licitacaoId"
           WHERE s."marca" = $1 AND s."score" >= $2
             AND LOWER(s."modelo_sugerido") != 'nenhum'
             AND l."dataPublicacaoPncp" >= now() - interval '6 months'
           GROUP BY s."modelo_sugerido", mes
        `, [marca, scoreMin]);
      } else {
        rows = db.prepare(`
          WITH base AS (
            SELECT s.modelo_sugerido AS modelo,
                   COUNT(*) AS pedidos,
                   SUM(CASE WHEN rb.id IS NOT NULL THEN 1 ELSE 0 END) AS vendidos,
                   -- ticketMedio e totalVendido usam a mesma fórmula (fallback p/
                   -- valorTotal do edital quando homologação não declarou valor),
                   -- garantindo total = ticket × pedidos. Representa "tamanho
                   -- potencial de mercado" (estimativa do edital + real homologado).
                   AVG(COALESCE(rb.valorTotalHomologado, i.valorTotal, 0)) AS ticketMedio,
                   SUM(COALESCE(rb.valorTotalHomologado, i.valorTotal, 0)) AS totalVendido,
                   COUNT(DISTINCT l.ufSigla) AS capilaridade,
                   GROUP_CONCAT(DISTINCT l.ufSigla) AS ufs
              FROM catalog.bi_item_sugestao_produto s
              JOIN itens i ON i.id = s.itemId
              JOIN licitacoes l ON l.id = i.licitacaoId
              LEFT JOIN catalog.resultados_bi rb ON rb.cnpj = l.cnpj AND rb.ano = l.anoCompra
                AND rb.sequencial = l.sequencialCompra AND rb.numeroItem = i.numeroItem
             WHERE s.marca = ? AND s.score >= ?
               AND LOWER(s.modelo_sugerido) != 'nenhum'
             GROUP BY s.modelo_sugerido
          ), max_vals AS (
            SELECT MAX(pedidos)*1.0 AS maxPedidos, MAX(ticketMedio) AS maxTicket FROM base
          )
          SELECT b.*,
                 CAST(
                   (b.pedidos*100.0/m.maxPedidos)*0.3 +
                   (b.vendidos*100.0/b.pedidos)*0.3 +
                   (CASE WHEN m.maxTicket > 0
                         THEN (LN(MAX(b.ticketMedio,1))/LN(m.maxTicket+1))*100*0.2
                         ELSE 0 END) +
                   (b.capilaridade*100.0/27)*0.2
                 AS INTEGER) AS score
            FROM base b, max_vals m
           ORDER BY score DESC
        `).all(marca, scoreMin);

        hist = db.prepare(`
          SELECT s.modelo_sugerido AS modelo,
                 strftime('%Y-%m', l.dataPublicacaoPncp) AS mes,
                 COUNT(*) AS pedidos
            FROM catalog.bi_item_sugestao_produto s
            JOIN itens i ON i.id = s.itemId
            JOIN licitacoes l ON l.id = i.licitacaoId
           WHERE s.marca = ? AND s.score >= ?
             AND LOWER(s.modelo_sugerido) != 'nenhum'
             AND l.dataPublicacaoPncp >= date('now','-6 months')
           GROUP BY s.modelo_sugerido, mes
        `).all(marca, scoreMin);
      }

      // Constrói lista dos últimos 6 meses (YYYY-MM, do mais antigo pro mais recente)
      const meses6 = [];
      const hoje = new Date();
      for (let i = 5; i >= 0; i--) {
        const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
        meses6.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
      const histPorModelo = {};
      for (const h of hist) {
        if (!histPorModelo[h.modelo]) histPorModelo[h.modelo] = {};
        histPorModelo[h.modelo][h.mes] = h.pedidos;
      }

      const oportunidades = rows.map(r => ({
        modelo: r.modelo,
        pedidos: r.pedidos,
        vendidos: r.vendidos,
        taxaVendaPct: r.pedidos > 0 ? Math.round(r.vendidos * 100 / r.pedidos) : 0,
        ticketMedio: r.ticketMedio || 0,
        totalVendido: r.totalVendido || 0,
        capilaridade: r.capilaridade,
        topUFs: (r.ufs || '').split(',').slice(0, 5),
        score: r.score || 0,
        decisao: r.score >= 60 ? 'ESTOCAR' : r.score >= 40 ? 'SOB_DEMANDA' : 'EVITAR',
        // historicoMensal: array de pedidos pelos últimos 6 meses, na ordem cronológica
        historicoMensal: meses6.map(m => histPorModelo[r.modelo]?.[m] || 0),
        mesesLabels: meses6,
      }));

      const resumo = {
        totalModelos: oportunidades.length,
        estocar: oportunidades.filter(o => o.decisao === 'ESTOCAR').length,
        sobDemanda: oportunidades.filter(o => o.decisao === 'SOB_DEMANDA').length,
        evitar: oportunidades.filter(o => o.decisao === 'EVITAR').length,
        valorMercadoTotal: oportunidades.reduce((s, o) => s + o.totalVendido, 0),
      };

      res.json({ success: true, marca, grupoId, oportunidades, resumo });
    } catch (err) {
      console.error('Erro sugestao-mercado:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Demanda perdida (vendas_perdidas) alimenta a sugestão. Só motivo
  // 'sem_estoque': perder por preço/prazo/concorrente não é problema de
  // reposição e não pode inflar ordem de compra.
  const JANELA_DIAS = 90;
  const MOTIVO_DEMANDA = 'sem_estoque';

  function temTabelaVendasPerdidas() {
    try {
      return db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='vendas_perdidas'").get().n > 0;
    } catch { return false; }
  }

  app.get('/api/compras/sugestao', (req, res) => {
    try {
      // ?incluirPerdas=0 volta ao comportamento anterior (só parâmetros de
      // estoque) — útil para conferir de onde veio um número.
      const comPerdas = req.query.incluirPerdas !== '0' && temTabelaVendasPerdidas();

      const colsPerda = comPerdas ? `,
          COALESCE((SELECT SUM(quantidade) FROM vendas_perdidas
                    WHERE produtoId = p.id AND motivo = ?
                      AND data >= date('now', '-${JANELA_DIAS} days')), 0) AS perdaQtd90d,
          COALESCE((SELECT SUM(quantidade * COALESCE(precoAlvo,0)) FROM vendas_perdidas
                    WHERE produtoId = p.id AND motivo = ?
                      AND data >= date('now', '-${JANELA_DIAS} days')), 0) AS perdaValor90d,
          COALESCE((SELECT COUNT(*) FROM vendas_perdidas
                    WHERE produtoId = p.id AND motivo = ?
                      AND data >= date('now', '-${JANELA_DIAS} days')), 0) AS perdaRegistros90d` : '';

      // Sem perdas o produto só aparece se alguém parametrizou min/reposição.
      // Com perdas, quem deixou de vender por falta de estoque entra mesmo
      // sem parametrização — é justamente o caso que ninguém configurou.
      const filtroPerda = comPerdas ? ` OR EXISTS (SELECT 1 FROM vendas_perdidas vp
            WHERE vp.produtoId = p.id AND vp.motivo = ?
              AND vp.data >= date('now', '-${JANELA_DIAS} days'))` : '';

      const params = comPerdas ? [MOTIVO_DEMANDA, MOTIVO_DEMANDA, MOTIVO_DEMANDA, MOTIVO_DEMANDA] : [];

      const rows = db.prepare(`
        SELECT p.id, p.sku, p.descricao, p.unidade, p.precoCusto,
          p.estoqueMinimo, p.pontoReposicao, p.estoqueMaximo, p.leadTimeDias,
          p.fornecedorId, f.razaoSocial AS fornecedorNome,
          COALESCE((SELECT SUM(CASE WHEN tipo='entrada' THEN quantidade
                                    WHEN tipo='saida' THEN -quantidade
                                    ELSE quantidade END)
                    FROM movimentacoes_estoque WHERE produtoId = p.id), 0) AS saldo,
          COALESCE((SELECT SUM(quantidade) FROM reservas_estoque
                    WHERE produtoId = p.id AND status = 'ativa'), 0) AS reservado,
          COALESCE((SELECT custoMedioPosterior FROM movimentacoes_estoque
                    WHERE produtoId = p.id AND custoMedioPosterior IS NOT NULL
                    ORDER BY data DESC, id DESC LIMIT 1), p.precoCusto) AS custoMedio,
          COALESCE((SELECT SUM(quantidade) FROM movimentacoes_estoque
                    WHERE produtoId = p.id AND tipo = 'saida'
                      AND data >= date('now', '-${JANELA_DIAS} days')), 0) AS saida90d${colsPerda}
        FROM produtos p
        LEFT JOIN pessoas f ON f.id = p.fornecedorId
        WHERE p.ativo = 1 AND (p.estoqueMinimo > 0 OR p.pontoReposicao > 0${filtroPerda})
      `).all(...params);

      const itens = rows.map(r => {
        const disponivel = r.saldo - r.reservado;
        const limite = r.pontoReposicao > 0 ? r.pontoReposicao : r.estoqueMinimo;
        const parametrizado = r.estoqueMinimo > 0 || r.pontoReposicao > 0;
        const perdaQtd = comPerdas ? (r.perdaQtd90d || 0) : 0;

        // Demanda reprimida não aparece nas saídas: se faltou estoque, a
        // venda não saiu. Somar as duas dá o consumo que de fato existiu.
        const consumoDiarioMedio = r.saida90d / JANELA_DIAS;
        const consumoDiarioAjustado = (r.saida90d + perdaQtd) / JANELA_DIAS;

        const alvoBase = r.estoqueMaximo > 0 ? r.estoqueMaximo : (r.estoqueMinimo * 2);
        const qtdSugeridaBase = Math.max(0, alvoBase - disponivel);
        // O alvo precisa cobrir também o que se deixou de vender.
        const alvo = alvoBase + perdaQtd;
        const qtdSugerida = Math.max(0, alvo - disponivel);

        const precisaPorParametro = parametrizado && disponivel <= limite;
        const precisaPorPerda = perdaQtd > 0 && disponivel < perdaQtd;
        const origemSugestao = precisaPorParametro && precisaPorPerda ? 'ambos'
          : precisaPorParametro ? 'parametro'
          : precisaPorPerda ? 'demanda_perdida' : null;

        const coberturaProjetada = consumoDiarioAjustado > 0
          ? (disponivel + qtdSugerida) / consumoDiarioAjustado : null;

        return {
          ...r,
          disponivel,
          limite,
          precisaComprar: precisaPorParametro || precisaPorPerda,
          origemSugestao,
          quantidadeSugerida: qtdSugerida,
          quantidadeSugeridaBase: qtdSugeridaBase,
          quantidadePorDemandaPerdida: Math.max(0, qtdSugerida - qtdSugeridaBase),
          custoSugerido: qtdSugerida * (r.custoMedio || r.precoCusto || 0),
          consumoDiarioMedio,
          consumoDiarioAjustado,
          perdaQtd90d: perdaQtd,
          perdaValor90d: comPerdas ? (r.perdaValor90d || 0) : 0,
          perdaRegistros90d: comPerdas ? (r.perdaRegistros90d || 0) : 0,
          coberturaProjetadaDias: coberturaProjetada
        };
      }).filter(i => i.precisaComprar && i.quantidadeSugerida > 0);

      // Perda sem produto cadastrado não vira sugestão de compra — não há
      // o que comprar. Mas é acionável: sinaliza produto a cadastrar.
      let perdasSemProduto = { registros: 0, quantidade: 0, valor: 0 };
      if (comPerdas) {
        perdasSemProduto = db.prepare(`SELECT COUNT(*) registros,
            COALESCE(SUM(quantidade),0) quantidade,
            COALESCE(SUM(quantidade * COALESCE(precoAlvo,0)),0) valor
          FROM vendas_perdidas
          WHERE produtoId IS NULL AND motivo = ?
            AND data >= date('now', '-${JANELA_DIAS} days')`).get(MOTIVO_DEMANDA);
      }

      const resumo = {
        totalItens: itens.length,
        custoTotalEstimado: itens.reduce((s, i) => s + i.custoSugerido, 0),
        fornecedoresDistintos: new Set(itens.map(i => i.fornecedorId).filter(Boolean)).size,
        incluiDemandaPerdida: comPerdas,
        janelaDias: JANELA_DIAS,
        itensPorDemandaPerdida: itens.filter(i => i.origemSugestao !== 'parametro').length,
        demandaPerdidaQtd: itens.reduce((s, i) => s + i.perdaQtd90d, 0),
        demandaPerdidaValor: itens.reduce((s, i) => s + i.perdaValor90d, 0),
        perdasSemProduto
      };

      res.json({ success: true, itens, resumo });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== LISTAR / DETALHAR ====================

  app.get('/api/pedidos-compra', (req, res) => {
    try {
      const { status, fornecedorId } = req.query;
      let sql = `SELECT pc.*, f.razaoSocial AS fornecedorNome, f.cpfCnpj AS fornecedorCnpj,
                        (SELECT COUNT(*) FROM pedido_compra_itens WHERE pedidoCompraId = pc.id) AS qtdItens
                 FROM pedidos_compra pc
                 LEFT JOIN pessoas f ON f.id = pc.fornecedorId
                 WHERE 1=1`;
      const params = [];
      if (status) { sql += ' AND pc.status = ?'; params.push(status); }
      if (fornecedorId) { sql += ' AND pc.fornecedorId = ?'; params.push(fornecedorId); }
      sql += ' ORDER BY pc.dataEmissao DESC, pc.id DESC';
      const pedidos = db.prepare(sql).all(...params);
      res.json({ success: true, pedidos });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/pedidos-compra/:id', (req, res) => {
    try {
      const pedido = db.prepare(`
        SELECT pc.*, f.razaoSocial AS fornecedorNome, f.cpfCnpj AS fornecedorCnpj,
               f.telefone AS fornecedorTelefone, f.email AS fornecedorEmail
        FROM pedidos_compra pc
        LEFT JOIN pessoas f ON f.id = pc.fornecedorId
        WHERE pc.id = ?
      `).get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido de compra nao encontrado' });

      const itens = db.prepare(`
        SELECT pci.*, p.sku, p.descricao, p.unidade, p.rastreiaLote, p.rastreiaSerial
        FROM pedido_compra_itens pci
        JOIN produtos p ON p.id = pci.produtoId
        WHERE pci.pedidoCompraId = ?
        ORDER BY p.descricao ASC
      `).all(req.params.id);

      // Como este fornecedor recebe o pedido: define o rótulo do botão, a
      // confirmação e o que ainda falta para poder transmitir.
      let integracao = null;
      try {
        integracao = require('./fornecedor-integracoes').descreverParaPedido(db, pedido, itens);
      } catch (_) {
        // Sem o módulo/tabela: a tela cai no botão genérico.
      }

      res.json({ success: true, pedido, itens, integracao });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // PDF do pedido, para enviar ao fornecedor ou arquivar.
  app.get('/api/pedidos-compra/:id/pdf', (req, res) => {
    try {
      const pedido = db.prepare(`
        SELECT pc.*, f.razaoSocial AS fornecedorNome, f.cpfCnpj AS fornecedorCnpj,
               f.telefone AS fornecedorTelefone, f.email AS fornecedorEmail,
               f.endereco AS fornecedorLogradouro, f.numero AS fornecedorNumero,
               f.bairro AS fornecedorBairro, f.cidade AS fornecedorCidade,
               f.uf AS fornecedorUf, f.cep AS fornecedorCep
        FROM pedidos_compra pc
        LEFT JOIN pessoas f ON f.id = pc.fornecedorId
        WHERE pc.id = ?
      `).get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido de compra nao encontrado' });

      const itens = db.prepare(`
        SELECT pci.*, p.sku, p.descricao, p.unidade
        FROM pedido_compra_itens pci
        LEFT JOIN produtos p ON p.id = pci.produtoId
        WHERE pci.pedidoCompraId = ?
        ORDER BY p.descricao ASC
      `).all(req.params.id);

      // Emitente é a nossa empresa: quem compra. Estabelecimento matriz, com
      // o cadastro legado como reserva.
      let emitente = {};
      try {
        emitente = db.prepare('SELECT * FROM estabelecimentos WHERE matriz = 1 LIMIT 1').get() || {};
      } catch (_) { /* tenant sem estabelecimentos */ }
      if (!emitente.razaoSocial) {
        try { emitente = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; }
        catch (_) { /* sem cadastro da empresa: sai sem cabeçalho */ }
      }
      // A logo mora só no cadastro legado `fornecedor` — `estabelecimentos` não
      // tem a coluna, então sem isto o cabeçalho sai sem logo sempre que houver matriz.
      if (!emitente.logoBase64) {
        try {
          emitente.logoBase64 = db.prepare('SELECT logoBase64 FROM fornecedor ORDER BY id DESC LIMIT 1').get()?.logoBase64 || null;
        } catch (_) { /* sem cadastro legado: segue sem logo */ }
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${pedido.numero}.pdf"`);
      require('./pedido-compra-pdf').gerar(res, pedido, itens, emitente);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CRIAR ====================

  app.post('/api/pedidos-compra', (req, res) => {
    try {
      const { fornecedorId, dataPrevistaEntrega, observacoes, itens } = req.body;
      // Rascunho pode nascer vazio: a tela cria o pedido e só depois monta os
      // itens. Exigir item já na criação impedia abrir um pedido novo. Quem
      // cobra a presença de itens é o /enviar, que é onde isso importa.
      if (itens != null && !Array.isArray(itens)) {
        return res.status(400).json({ success: false, error: 'itens deve ser um array' });
      }
      const listaItens = Array.isArray(itens) ? itens : [];
      const validos = listaItens.filter(it => it.produtoId && Number(it.quantidade) > 0);
      // Mandar itens e não sobrar nenhum válido não é um pedido vazio de
      // propósito: antes o loop descartava tudo em silêncio e criava um
      // pedido zerado que ninguém entendia.
      if (listaItens.length && !validos.length) {
        return res.status(400).json({ success: false,
          error: 'Nenhum item válido — cada item exige produtoId e quantidade > 0' });
      }

      const numero = proximoNumero(db);
      const usuarioCriador = req.session?.username || null;

      const trx = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO pedidos_compra (numero, fornecedorId, status, dataPrevistaEntrega, observacoes, usuarioCriador)
          VALUES (?, ?, 'rascunho', ?, ?, ?)
        `).run(numero, fornecedorId || null, dataPrevistaEntrega || null, observacoes || null, usuarioCriador);
        const pedidoCompraId = result.lastInsertRowid;

        const ins = db.prepare(`
          INSERT INTO pedido_compra_itens (pedidoCompraId, produtoId, quantidade, custoUnitario, observacoes)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const it of validos) {
          ins.run(pedidoCompraId, it.produtoId, Number(it.quantidade),
                  Number(it.custoUnitario) || 0, it.observacoes || null);
        }

        recalcularValorTotal(db, pedidoCompraId);
        return pedidoCompraId;
      });

      const id = trx();
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(id);
      res.json({ success: true, pedido });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== EDITAR RASCUNHO ====================

  app.put('/api/pedidos-compra/:id', (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (pedido.status !== 'rascunho') {
        return res.status(400).json({ success: false, error: 'Apenas rascunhos podem ser editados' });
      }

      const { fornecedorId, dataPrevistaEntrega, observacoes } = req.body;
      db.prepare(`
        UPDATE pedidos_compra SET
          fornecedorId = ?,
          dataPrevistaEntrega = ?,
          observacoes = ?,
          dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        fornecedorId !== undefined ? fornecedorId : pedido.fornecedorId,
        dataPrevistaEntrega !== undefined ? dataPrevistaEntrega : pedido.dataPrevistaEntrega,
        observacoes !== undefined ? observacoes : pedido.observacoes,
        req.params.id
      );

      res.json({ success: true, pedido: db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ITENS (CRUD em rascunho) ====================

  app.post('/api/pedidos-compra/:id/itens', (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (pedido.status !== 'rascunho') {
        return res.status(400).json({ success: false, error: 'Apenas rascunhos podem ter itens editados' });
      }

      const { produtoId, quantidade, custoUnitario, observacoes } = req.body;
      if (!produtoId || !(Number(quantidade) > 0)) {
        return res.status(400).json({ success: false, error: 'produtoId e quantidade>0 obrigatorios' });
      }

      const result = db.prepare(`
        INSERT INTO pedido_compra_itens (pedidoCompraId, produtoId, quantidade, custoUnitario, observacoes)
        VALUES (?, ?, ?, ?, ?)
      `).run(req.params.id, produtoId, Number(quantidade), Number(custoUnitario) || 0, observacoes || null);

      recalcularValorTotal(db, req.params.id);
      const item = db.prepare('SELECT * FROM pedido_compra_itens WHERE id = ?').get(result.lastInsertRowid);
      res.json({ success: true, item });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/pedidos-compra/:id/itens/:itemId', (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (pedido.status !== 'rascunho') {
        return res.status(400).json({ success: false, error: 'Apenas rascunhos podem ter itens editados' });
      }
      const { quantidade, custoUnitario, observacoes } = req.body;
      db.prepare(`
        UPDATE pedido_compra_itens SET
          quantidade = COALESCE(?, quantidade),
          custoUnitario = COALESCE(?, custoUnitario),
          observacoes = ?
        WHERE id = ? AND pedidoCompraId = ?
      `).run(
        quantidade != null ? Number(quantidade) : null,
        custoUnitario != null ? Number(custoUnitario) : null,
        observacoes !== undefined ? observacoes : null,
        req.params.itemId, req.params.id
      );
      recalcularValorTotal(db, req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/pedidos-compra/:id/itens/:itemId', (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (pedido.status !== 'rascunho') {
        return res.status(400).json({ success: false, error: 'Apenas rascunhos podem ter itens removidos' });
      }
      db.prepare('DELETE FROM pedido_compra_itens WHERE id = ? AND pedidoCompraId = ?')
        .run(req.params.itemId, req.params.id);
      recalcularValorTotal(db, req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== ENVIAR ====================

  app.post('/api/pedidos-compra/:id/enviar', async (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (pedido.status !== 'rascunho') return res.status(400).json({ success: false, error: 'Somente rascunho pode ser enviado' });

      // Alçada (governança): pedido de compra acima do limite exige aprovação
      const { verificarAlcada } = require('./governanca-routes');
      const alcada = verificarAlcada(db, { tipoEvento: 'pedido_compra', referenciaId: pedido.id, valor: Number(pedido.valorTotal) || 0, usuario: req.session?.username });
      if (!alcada.liberado) {
        return res.status(403).json({ success: false,
          error: alcada.status === 'reprovada'
            ? 'Pedido reprovado pela alçada'
            : `Pedido acima da alçada (R$ ${alcada.regra.limiteValor.toFixed(2)}) — aprovação #${alcada.aprovacaoId} pendente`,
          aprovacaoId: alcada.aprovacaoId, statusAprovacao: alcada.status });
      }
      const nItens = db.prepare('SELECT COUNT(*) AS n FROM pedido_compra_itens WHERE pedidoCompraId = ?').get(req.params.id).n;
      if (!nItens) return res.status(400).json({ success: false, error: 'Pedido sem itens' });

      // Fornecedor com integração: "enviar" executa algo de verdade (na NicSRS,
      // compra a assinatura). Quem sabe o quê fazer é o adaptador do
      // fornecedor — este módulo não conhece fornecedor nenhum em particular.
      const integracoes = require('./fornecedor-integracoes');
      const itens = db.prepare(`
        SELECT i.*, p.descricao
        FROM pedido_compra_itens i LEFT JOIN produtos p ON p.id = i.produtoId
        WHERE i.pedidoCompraId = ?
      `).all(req.params.id);

      let resultado = null;
      try {
        resultado = await integracoes.executarParaPedido(db, pedido, itens, req.user?.username);
      } catch (err) {
        // Integração quebrou: o pedido NÃO avança de status, para não parecer
        // transmitido quando não foi.
        return res.status(400).json({ success: false, error: `Falha na integração do fornecedor: ${err.message}` });
      }

      const status = !resultado ? 'enviado'
        : (resultado.nenhuma ? 'rascunho' : (resultado.parcial ? 'enviado_parcial' : 'enviado'));
      db.prepare(`UPDATE pedidos_compra SET status = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(status, req.params.id);

      if (resultado && resultado.nenhuma) {
        return res.status(400).json({ success: false,
          error: `Nada foi transmitido — o pedido segue em rascunho. ${(resultado.falhas || []).map(f => f.erro).join('; ')}` });
      }
      res.json({ success: true, status, ...(resultado ? { integracao: resultado } : {}) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== RECEBER ====================

  app.post('/api/pedidos-compra/:id/receber', (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (!['enviado', 'recebido_parcial'].includes(pedido.status)) {
        return res.status(400).json({ success: false, error: 'Somente pedidos enviados podem ser recebidos' });
      }

      const { itens } = req.body;
      if (!Array.isArray(itens) || itens.length === 0) {
        return res.status(400).json({ success: false, error: 'itens (array) obrigatorio — [{itemId, quantidadeRecebida, loteId?, serialIds?}]' });
      }

      const { calcularContextoMovimento, resolverDeposito } = require('./estoque-routes');
      const dataRec = req.body.dataRecebimento || dataBrasilia();
      const movimentacoesGeradas = [];
      // Pedidos de venda que esperavam esta mercadoria (origemTipo/origemId da
      // linha de compra). Coletado dentro da transação, tratado depois dela.
      const origensAtendidas = [];

      const trx = db.transaction(() => {
        for (const recItem of itens) {
          const { itemId, quantidadeRecebida, loteId, serialIds } = recItem;
          const qtd = Number(quantidadeRecebida);
          if (!(qtd > 0)) continue;

          const it = db.prepare('SELECT * FROM pedido_compra_itens WHERE id = ? AND pedidoCompraId = ?')
            .get(itemId, req.params.id);
          if (!it) throw new Error(`Item ${itemId} nao encontrado no pedido`);

          const saldoPendente = it.quantidade - it.quantidadeRecebida;
          if (qtd > saldoPendente + 0.001) {
            throw new Error(`Item ${itemId}: quantidade a receber (${qtd}) maior que pendente (${saldoPendente})`);
          }

          const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(it.produtoId);

          // Validação rastreabilidade
          if (produto.rastreiaLote && !loteId) {
            throw new Error(`Produto ${produto.sku} rastreia lote — loteId obrigatorio no item ${itemId}`);
          }
          if (produto.rastreiaSerial) {
            if (!Array.isArray(serialIds) || serialIds.length !== qtd) {
              throw new Error(`Produto ${produto.sku} rastreia serial — informe ${qtd} serialIds no item ${itemId}`);
            }
          }

          // Gerar movimentação de entrada
          const ctx = calcularContextoMovimento(db, it.produtoId, 'entrada', qtd, it.custoUnitario);
          const mov = db.prepare(`
            INSERT INTO movimentacoes_estoque
              (produtoId, tipo, quantidade, custoUnitario, origem, origemId, observacao, data,
               loteId, custoMedioAnterior, custoMedioPosterior, saldoPosterior, depositoId)
            VALUES (?, 'entrada', ?, ?, 'pedido_compra', ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            it.produtoId, qtd, it.custoUnitario, pedido.id,
            `Recebimento do PC ${pedido.numero}`, dataRec, loteId || null,
            ctx.custoMedioAnterior, ctx.custoMedioPosterior, ctx.saldoPosterior,
            // Depósito de recebimento: informado na baixa ou o padrão.
            resolverDeposito(db, { depositoId: req.body?.depositoId })
          );
          const movId = mov.lastInsertRowid;
          movimentacoesGeradas.push(movId);

          // Atualizar saldoAtual do lote
          if (loteId) {
            db.prepare('UPDATE lotes SET saldoAtual = saldoAtual + ? WHERE id = ?').run(qtd, loteId);
          }

          // Vincular seriais (com movEntradaId)
          if (Array.isArray(serialIds) && serialIds.length) {
            for (const sid of serialIds) {
              db.prepare(`UPDATE serial_numbers SET status='disponivel', movEntradaId=?, loteId=COALESCE(?, loteId) WHERE id=?`)
                .run(movId, loteId || null, sid);
            }
          }

          // Atualizar quantidadeRecebida do item
          db.prepare('UPDATE pedido_compra_itens SET quantidadeRecebida = quantidadeRecebida + ? WHERE id = ?')
            .run(qtd, itemId);

          if (it.origemTipo === 'pedido_venda' && it.origemId) {
            origensAtendidas.push({ pedidoId: Number(it.origemId), sku: produto.sku, quantidade: qtd });
          }
        }

        // Recalcular status do pedido
        const itensAtualizados = db.prepare(`
          SELECT quantidade, quantidadeRecebida FROM pedido_compra_itens WHERE pedidoCompraId = ?
        `).all(req.params.id);
        const todosRecebidos = itensAtualizados.every(i => i.quantidadeRecebida >= i.quantidade - 0.001);
        const algumRecebido = itensAtualizados.some(i => i.quantidadeRecebida > 0);
        const novoStatus = todosRecebidos ? 'recebido' : (algumRecebido ? 'recebido_parcial' : pedido.status);

        db.prepare(`
          UPDATE pedidos_compra SET status = ?, dataRecebimento = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?
        `).run(novoStatus, todosRecebidos ? dataRec : pedido.dataRecebimento, req.params.id);
      });

      trx();

      // Fecha o ciclo: quem pediu a compra por falta de saldo volta a ter
      // lastro. Fora da transação de propósito — falha em avisar não pode
      // desfazer um recebimento que já entrou no estoque.
      const pedidosVendaLiberados = liberarPedidosDeVenda(db, pedido, origensAtendidas, req);

      const atualizado = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      res.json({ success: true, pedido: atualizado, movimentacoesGeradas, pedidosVendaLiberados });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CANCELAR ====================

  app.post('/api/pedidos-compra/:id/cancelar', (req, res) => {
    try {
      const pedido = db.prepare('SELECT * FROM pedidos_compra WHERE id = ?').get(req.params.id);
      if (!pedido) return res.status(404).json({ success: false, error: 'Pedido nao encontrado' });
      if (pedido.status === 'recebido') {
        return res.status(400).json({ success: false, error: 'Pedido totalmente recebido nao pode ser cancelado — faca estorno pelas movimentacoes' });
      }
      if (pedido.status === 'cancelado') {
        return res.status(400).json({ success: false, error: 'Ja cancelado' });
      }
      db.prepare(`UPDATE pedidos_compra SET status = 'cancelado', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasCompras, migrarPedidosCompraDB, proximoNumero };
