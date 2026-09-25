/**
 * restaurante-comanda.js — Módulo Restaurante, fase 2: salão e comanda.
 *
 * Uma comanda serve as cinco operações via `tipo`:
 *   mesa       — à la carte, vinculada a uma mesa do salão
 *   individual — cartão/chaveiro numerado (bar), sem mesa fixa
 *   balcao     — fast-food e por quilo, com senha de chamada
 *   delivery   — pedido próprio ou de canal externo (iFood)
 *
 * Regras que a operação real impõe e que estão codificadas aqui:
 *
 *  - Uma mesa tem NO MÁXIMO uma comanda aberta. Duas comandas na mesma mesa é
 *    o caminho mais curto para conta trocada.
 *  - O preço do item vem do CARDÁPIO VIGENTE do canal, não do cadastro do
 *    produto — é o que faz o mesmo prato custar diferente no delivery.
 *  - Preço e nome são gravados como SNAPSHOT no item: o cardápio muda amanhã,
 *    a comanda de hoje tem de continuar contando a mesma história.
 *  - Grupo de opção obrigatório (min ≥ 1) é validado no lançamento. Deixar
 *    passar "X-Burger sem ponto da carne" empurra o problema para a cozinha.
 *  - Cancelar item já lançado exige motivo e vira evento. É onde furo de caixa
 *    aparece, e sem trilha não há como auditar.
 *  - `versao` da comanda incrementa a cada mudança: é o que o salão e o KDS
 *    usam para redesenhar sem baixar tudo de novo (não há WebSocket aqui).
 */

const TIPOS = ['mesa', 'individual', 'balcao', 'delivery'];
const STATUS_ITEM = ['pendente', 'em-preparo', 'pronto', 'entregue', 'cancelado'];

function agora() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Deslocamento do horário de Marabá (America/Belem: UTC−3 o ano todo, sem
 * horário de verão) para usar no SQL sobre o que agora() grava em UTC:
 * DATE(col, FUSO_LOCAL_SQL) e strftime('%H', col, FUSO_LOCAL_SQL).
 *
 * Sem ele, a conta fechada às 22h caía no dia seguinte, o sábado à noite
 * contava como domingo e o horário de pico saía três horas adiantado.
 */
const FUSO_LOCAL_SQL = '-3 hours';

/**
 * Converte um timestamp do módulo em epoch ms.
 *
 * Tudo aqui é gravado em UTC — tanto o CURRENT_TIMESTAMP do SQLite quanto o
 * agora() acima. Sem forçar o 'Z', o JS parseia 'YYYY-MM-DD HH:MM:SS' como
 * hora LOCAL e todo cálculo de tempo sai deslocado pelo fuso: em BRT (UTC−3)
 * o item recém-lançado nascia com −180 min em fila e nunca ficava atrasado,
 * o que esvaziava o alarme do KDS.
 */
function msDe(ts) {
  if (!ts) return null;
  const s = String(ts).trim().replace(' ', 'T');
  const comZona = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  const t = Date.parse(comZona ? s : s + 'Z');
  return isNaN(t) ? null : t;
}

// Minutos decorridos desde um timestamp do módulo. null se não parsear.
function minutosDesde(ts) {
  const t = msDe(ts);
  return t == null ? null : Math.floor((Date.now() - t) / 60000);
}

function usuarioDe(req) {
  return (req.user && (req.user.nome || req.user.username)) || 'sistema';
}

function registrarEvento(db, comandaId, tipo, descricao, usuario) {
  db.prepare(
    'INSERT INTO rest_comanda_eventos (comandaId, tipo, descricao, usuario, criadoEm) VALUES (?, ?, ?, ?, ?)'
  ).run(comandaId, tipo, descricao || null, usuario || null, agora());
}

function bumpVersao(db, comandaId) {
  db.prepare('UPDATE rest_comandas SET versao = versao + 1 WHERE id = ?').run(comandaId);
}

/**
 * Recalcula os totais da comanda a partir dos itens.
 *
 * Item cancelado NÃO entra em nada — nem no subtotal, nem na base da taxa de
 * serviço. A taxa incide só sobre o consumo; couvert é por pessoa e fica fora
 * da base da taxa (é cobrança à parte, não serviço prestado à mesa).
 */
function recalcularTotais(db, comandaId) {
  const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(comandaId);
  if (!c) return null;

  const soma = db.prepare(`
    SELECT COALESCE(SUM(precoTotal), 0) AS total
      FROM rest_comanda_itens
     WHERE comandaId = ? AND status <> 'cancelado'
  `).get(comandaId);
  const totalItens = Number(soma.total || 0);

  const pct = c.taxaServicoPct != null ? Number(c.taxaServicoPct) : 0;
  const totalTaxa = Math.round(totalItens * (pct / 100) * 100) / 100;

  const pago = db.prepare(
    'SELECT COALESCE(SUM(valor), 0) AS total FROM rest_comanda_pagamentos WHERE comandaId = ?'
  ).get(comandaId);

  const totalGeral = Math.round(
    (totalItens + totalTaxa + Number(c.totalCouvert || 0) - Number(c.totalDesconto || 0)) * 100
  ) / 100;

  db.prepare(`
    UPDATE rest_comandas SET totalItens = ?, totalTaxaServico = ?, totalGeral = ?, totalPago = ?
     WHERE id = ?
  `).run(totalItens, totalTaxa, totalGeral, Number(pago.total || 0), comandaId);

  return db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(comandaId);
}

function itensDaComanda(db, comandaId) {
  const itens = db.prepare(`
    SELECT i.*, s.nome AS setorNome, s.codigo AS setorCodigo
      FROM rest_comanda_itens i
      LEFT JOIN rest_setores s ON s.id = i.setorId
     WHERE i.comandaId = ?
     ORDER BY i.id ASC
  `).all(comandaId);
  if (itens.length) {
    const opcoes = db.prepare(`
      SELECT * FROM rest_comanda_item_opcoes
       WHERE comandaItemId IN (${itens.map(() => '?').join(',')})
    `).all(...itens.map(i => i.id));
    const porItem = new Map();
    for (const o of opcoes) {
      if (!porItem.has(o.comandaItemId)) porItem.set(o.comandaItemId, []);
      porItem.get(o.comandaItemId).push(o);
    }
    for (const i of itens) i.opcoes = porItem.get(i.id) || [];
  }
  return itens;
}

function comandaCompleta(db, comandaId) {
  const c = db.prepare(`
    SELECT c.*, m.numero AS mesaNumero, a.nome AS areaNome
      FROM rest_comandas c
      LEFT JOIN rest_mesas m ON m.id = c.mesaId
      LEFT JOIN rest_areas a ON a.id = m.areaId
     WHERE c.id = ?
  `).get(comandaId);
  if (!c) return null;
  c.itens = itensDaComanda(db, comandaId);
  c.pagamentos = db.prepare('SELECT * FROM rest_comanda_pagamentos WHERE comandaId = ? ORDER BY id').all(comandaId);
  return c;
}

/**
 * Valida as opções escolhidas contra os grupos do produto e devolve as opções
 * resolvidas (com nome e preço do momento) ou uma mensagem de erro.
 */
function resolverOpcoes(db, produtoId, opcaoIds) {
  const escolhidas = Array.isArray(opcaoIds) ? opcaoIds.map(Number).filter(Boolean) : [];

  const grupos = db.prepare(`
    SELECT g.* FROM rest_produto_grupos pg
      JOIN rest_grupos_opcao g ON g.id = pg.grupoId
     WHERE pg.produtoId = ? AND g.ativo = 1
     ORDER BY pg.ordem ASC
  `).all(produtoId);

  const resolvidas = [];
  if (escolhidas.length) {
    const rows = db.prepare(
      `SELECT * FROM rest_opcoes WHERE id IN (${escolhidas.map(() => '?').join(',')}) AND ativo = 1`
    ).all(...escolhidas);
    if (rows.length !== escolhidas.length) {
      return { erro: 'opção inválida ou inativa' };
    }
    resolvidas.push(...rows);
  }

  // Toda opção escolhida tem de pertencer a um grupo do produto — senão dá
  // para pendurar "adicional de camarão" num refrigerante.
  const idsGrupo = new Set(grupos.map(g => g.id));
  for (const o of resolvidas) {
    if (!idsGrupo.has(o.grupoId)) {
      return { erro: `opção "${o.nome}" não pertence a este item` };
    }
  }

  for (const g of grupos) {
    const n = resolvidas.filter(o => o.grupoId === g.id).length;
    if (n < g.minEscolhas) {
      return { erro: `"${g.nome}" exige no mínimo ${g.minEscolhas} escolha(s)` };
    }
    if (n > g.maxEscolhas) {
      return { erro: `"${g.nome}" aceita no máximo ${g.maxEscolhas} escolha(s)` };
    }
  }

  return { opcoes: resolvidas };
}

function registrarRotasComanda(app, db, gateFlag, deps) {
  const { cardapioVigente, lerConfig } = deps;

  // ==================== MAPA DO SALÃO ====================

  app.get('/api/restaurante/salao', gateFlag, (req, res) => {
    try {
      const mesas = db.prepare(`
        SELECT m.*, a.nome AS areaNome, a.ordem AS areaOrdem
          FROM rest_mesas m
          LEFT JOIN rest_areas a ON a.id = m.areaId
         WHERE m.ativo = 1
         ORDER BY a.ordem ASC, CAST(m.numero AS INTEGER) ASC, m.numero ASC
      `).all();

      const abertas = db.prepare(`
        SELECT id, mesaId, abertaEm, numeroPessoas, totalGeral, garcomUserId, versao
          FROM rest_comandas WHERE status = 'aberta' AND mesaId IS NOT NULL
      `).all();
      const porMesa = new Map(abertas.map(c => [c.mesaId, c]));

      for (const m of mesas) {
        const c = porMesa.get(m.id);
        if (c) {
          m.ocupada = true;
          m.comandaId = c.id;
          m.numeroPessoas = c.numeroPessoas;
          m.total = c.totalGeral;
          // Tempo sentado: é o número que o maître usa para prever giro.
          m.minutosOcupada = minutosDesde(c.abertaEm);
        } else {
          m.ocupada = false;
        }
      }

      // Comandas sem mesa (balcão, delivery, cartão) entram à parte: elas
      // existem no salão mas não têm lugar no mapa.
      const semMesa = db.prepare(`
        SELECT id, tipo, codigo, senhaChamada, totalGeral, abertaEm, numeroPessoas
          FROM rest_comandas WHERE status = 'aberta' AND mesaId IS NULL ORDER BY id DESC
      `).all();

      res.json({
        success: true,
        mesas,
        semMesa,
        resumo: {
          totalMesas: mesas.length,
          ocupadas: mesas.filter(m => m.ocupada).length,
          livres: mesas.filter(m => !m.ocupada).length,
          comandasAbertas: abertas.length + semMesa.length,
        },
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== COMANDAS ====================

  app.get('/api/restaurante/comandas', gateFlag, (req, res) => {
    try {
      const status = req.query.status || 'aberta';
      const items = db.prepare(`
        SELECT c.*, m.numero AS mesaNumero
          FROM rest_comandas c
          LEFT JOIN rest_mesas m ON m.id = c.mesaId
         WHERE c.status = ?
         ORDER BY c.id DESC
         LIMIT ?
      `).all(status, Number(req.query.limit) || 200);
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/restaurante/comandas/:id', gateFlag, (req, res) => {
    try {
      const c = comandaCompleta(db, req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      res.json({ success: true, comanda: c });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/restaurante/comandas', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const tipo = String(b.tipo || 'mesa');
      if (!TIPOS.includes(tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });

      let mesaId = null;
      if (tipo === 'mesa') {
        mesaId = Number(b.mesaId);
        if (!mesaId) return res.status(400).json({ success: false, error: 'mesaId é obrigatório para comanda de mesa' });
        const mesa = db.prepare('SELECT * FROM rest_mesas WHERE id = ?').get(mesaId);
        if (!mesa) return res.status(404).json({ success: false, error: 'mesa não encontrada' });
        if (!mesa.ativo) return res.status(400).json({ success: false, error: 'mesa inativa' });
        // Duas comandas abertas na mesma mesa = conta trocada. Barrar aqui é
        // mais barato do que descobrir no fechamento.
        const jaAberta = db.prepare(
          "SELECT id FROM rest_comandas WHERE mesaId = ? AND status = 'aberta'"
        ).get(mesaId);
        if (jaAberta) {
          return res.status(400).json({
            success: false, error: `mesa ${mesa.numero} já tem comanda aberta`, comandaId: jaAberta.id,
          });
        }
      }

      // Código do cartão/chaveiro do bar: identifica a comanda individual.
      let codigo = b.codigo ? String(b.codigo).trim() : null;
      if (tipo === 'individual') {
        if (!codigo) return res.status(400).json({ success: false, error: 'código do cartão é obrigatório' });
        const dup = db.prepare(
          "SELECT id FROM rest_comandas WHERE codigo = ? AND status = 'aberta'"
        ).get(codigo);
        if (dup) return res.status(400).json({ success: false, error: `cartão ${codigo} já está em uso`, comandaId: dup.id });
      }

      const canal = b.canal || (tipo === 'delivery' ? 'delivery' : tipo === 'balcao' ? 'balcao' : 'salao');
      const cfg = lerConfig(db);
      // Taxa de serviço só faz sentido onde houve atendimento de mesa.
      const pctPadrao = Number(cfg.restaurante_taxa_servico_pct || 0);
      const taxaPct = b.taxaServicoPct !== undefined
        ? Number(b.taxaServicoPct)
        : (tipo === 'mesa' || tipo === 'individual' ? pctPadrao : 0);

      // Senha de chamada do balcão: sequencial simples do dia.
      let senha = null;
      if (tipo === 'balcao') {
        // Os dois lados convertidos para o fuso local: `abertaEm` é UTC, e
        // comparar dia UTC com dia local faria a senha reiniciar às 21h em BRT,
        // no meio do jantar.
        const ultima = db.prepare(`
          SELECT senhaChamada FROM rest_comandas
           WHERE tipo = 'balcao' AND senhaChamada IS NOT NULL
             AND DATE(abertaEm, 'localtime') = DATE('now', 'localtime')
           ORDER BY id DESC LIMIT 1
        `).get();
        senha = String((ultima ? Number(ultima.senhaChamada) || 0 : 0) + 1);
      }

      const r = db.prepare(`
        INSERT INTO rest_comandas (tipo, mesaId, codigo, numeroPessoas, garcomUserId, clienteId,
                                   canal, status, senhaChamada, abertaEm, observacao, taxaServicoPct)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'aberta', ?, ?, ?, ?)
      `).run(
        tipo, mesaId, codigo,
        Number(b.numeroPessoas) || 1,
        b.garcomUserId ? Number(b.garcomUserId) : (req.user ? req.user.id : null),
        b.clienteId ? Number(b.clienteId) : null,
        canal, senha, agora(), b.observacao || null, taxaPct,
      );

      const id = r.lastInsertRowid;
      registrarEvento(db, id, 'abertura',
        tipo === 'mesa' ? `Mesa aberta` : `Comanda ${tipo} aberta`, usuarioDe(req));
      recalcularTotais(db, id);

      res.json({ success: true, id, senhaChamada: senha, comanda: comandaCompleta(db, id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== LANÇAR ITEM ====================

  app.post('/api/restaurante/comandas/:id/itens', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });

      const b = req.body || {};
      const produtoId = Number(b.produtoId);
      if (!produtoId) return res.status(400).json({ success: false, error: 'produtoId é obrigatório' });
      const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(produtoId);
      if (!produto) return res.status(404).json({ success: false, error: 'produto não encontrado' });

      const quantidade = b.quantidade !== undefined ? Number(b.quantidade) : 1;
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        return res.status(400).json({ success: false, error: 'quantidade inválida' });
      }

      // Preço: vem do cardápio vigente do canal da comanda. É o que separa
      // o preço de salão do preço de delivery.
      const cardapio = cardapioVigente(db, c.canal, new Date());
      let precoUnit = null;
      if (cardapio) {
        const item = db.prepare(
          'SELECT preco, disponivel FROM rest_cardapio_itens WHERE cardapioId = ? AND produtoId = ?'
        ).get(cardapio.id, produtoId);
        if (item) {
          if (!item.disponivel) {
            return res.status(400).json({ success: false, error: `"${produto.descricao}" está marcado como indisponível` });
          }
          precoUnit = Number(item.preco);
        }
      }
      // Fora do cardápio vigente, cai no preço de cadastro — mas só se o
      // caller aceitar explicitamente, senão é erro: item lançado por um preço
      // que ninguém configurou é reclamação na hora da conta.
      if (precoUnit == null) {
        if (b.permitirForaDoCardapio) {
          precoUnit = Number(produto.precoVenda || 0);
        } else {
          return res.status(400).json({
            success: false,
            error: `"${produto.descricao}" não está no cardápio vigente do canal ${c.canal}`,
          });
        }
      }
      if (b.precoUnit !== undefined && b.precoUnit !== null && b.precoUnit !== '') {
        const forcado = Number(b.precoUnit);
        if (!Number.isFinite(forcado) || forcado < 0) {
          return res.status(400).json({ success: false, error: 'preço inválido' });
        }
        precoUnit = forcado;
      }

      const cfgProduto = db.prepare('SELECT * FROM rest_produto_config WHERE produtoId = ?').get(produtoId);

      // Item pesável (self-service): o peso é que define o valor.
      let pesoKg = null;
      if (cfgProduto && cfgProduto.pesavel) {
        pesoKg = Number(b.pesoKg);
        if (!Number.isFinite(pesoKg) || pesoKg <= 0) {
          return res.status(400).json({ success: false, error: 'item pesável exige peso em kg' });
        }
        precoUnit = Math.round(Number(cfgProduto.precoPorKg) * pesoKg * 100) / 100;
      }

      const val = resolverOpcoes(db, produtoId, b.opcaoIds);
      if (val.erro) return res.status(400).json({ success: false, error: val.erro });

      const adicional = val.opcoes.reduce((s, o) => s + Number(o.precoAdicional || 0), 0);
      const precoTotal = Math.round((precoUnit + adicional) * quantidade * 100) / 100;

      const itemId = db.transaction(() => {
        const ins = db.prepare(`
          INSERT INTO rest_comanda_itens (comandaId, produtoId, descricao, quantidade, precoUnit, precoTotal,
                                          observacao, status, setorId, garcomUserId, pesoKg, lancadoEm)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?, ?, ?)
        `).run(
          c.id, produtoId, produto.descricao, quantidade, precoUnit, precoTotal,
          b.observacao || null,
          cfgProduto ? cfgProduto.setorId : null,
          req.user ? req.user.id : null,
          pesoKg, agora(),
        );
        const id = ins.lastInsertRowid;
        // Snapshot de nome e preço da opção: o cadastro pode mudar depois.
        const insOp = db.prepare(
          'INSERT INTO rest_comanda_item_opcoes (comandaItemId, opcaoId, nome, precoAdicional) VALUES (?, ?, ?, ?)'
        );
        for (const o of val.opcoes) insOp.run(id, o.id, o.nome, o.precoAdicional);
        return id;
      })();

      bumpVersao(db, c.id);
      const comanda = recalcularTotais(db, c.id);
      res.json({ success: true, id: itemId, precoUnit, precoTotal, comanda });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Cancelar item lançado — exige motivo e vira evento auditável.
  app.post('/api/restaurante/comanda-itens/:id/cancelar', gateFlag, (req, res) => {
    try {
      const item = db.prepare('SELECT * FROM rest_comanda_itens WHERE id = ?').get(req.params.id);
      if (!item) return res.status(404).json({ success: false, error: 'item não encontrado' });
      if (item.status === 'cancelado') return res.status(400).json({ success: false, error: 'item já cancelado' });

      const c = db.prepare('SELECT status FROM rest_comandas WHERE id = ?').get(item.comandaId);
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });

      const motivo = String(req.body?.motivo || '').trim();
      if (motivo.length < 3) {
        return res.status(400).json({ success: false, error: 'informe o motivo do cancelamento' });
      }

      db.prepare(
        "UPDATE rest_comanda_itens SET status = 'cancelado', canceladoEm = ?, canceladoMotivo = ? WHERE id = ?"
      ).run(agora(), motivo, req.params.id);

      registrarEvento(db, item.comandaId, 'cancelamento-item',
        `${item.descricao} (R$ ${Number(item.precoTotal).toFixed(2)}) — ${motivo}`, usuarioDe(req));
      bumpVersao(db, item.comandaId);
      const comanda = recalcularTotais(db, item.comandaId);
      res.json({ success: true, comanda });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== TRANSFERIR / JUNTAR ====================

  app.post('/api/restaurante/comandas/:id/transferir', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });

      const mesaId = Number(req.body?.mesaId);
      if (!mesaId) return res.status(400).json({ success: false, error: 'mesaId é obrigatório' });
      const mesa = db.prepare('SELECT * FROM rest_mesas WHERE id = ?').get(mesaId);
      if (!mesa) return res.status(404).json({ success: false, error: 'mesa não encontrada' });
      if (mesaId === c.mesaId) return res.status(400).json({ success: false, error: 'comanda já está nesta mesa' });

      const ocupada = db.prepare(
        "SELECT id FROM rest_comandas WHERE mesaId = ? AND status = 'aberta'"
      ).get(mesaId);
      if (ocupada) {
        return res.status(400).json({
          success: false, error: `mesa ${mesa.numero} já tem comanda aberta — use juntar`, comandaId: ocupada.id,
        });
      }

      const origem = c.mesaId
        ? db.prepare('SELECT numero FROM rest_mesas WHERE id = ?').get(c.mesaId)
        : null;

      // Transferir para mesa converte a comanda em comanda de mesa: é o caso
      // do cliente que sentou no balcão e depois foi para a mesa.
      db.prepare("UPDATE rest_comandas SET mesaId = ?, tipo = 'mesa' WHERE id = ?").run(mesaId, req.params.id);
      registrarEvento(db, c.id, 'transferencia',
        `${origem ? 'Mesa ' + origem.numero : c.tipo} → mesa ${mesa.numero}`, usuarioDe(req));
      bumpVersao(db, c.id);
      res.json({ success: true, comanda: comandaCompleta(db, c.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Junta a comanda de ORIGEM na de DESTINO: os itens migram, a origem é
   * fechada como 'cancelada' com trilha. É a mesa que virou duas e voltou a
   * ser uma — comum quando chega gente depois.
   */
  app.post('/api/restaurante/comandas/:id/juntar', gateFlag, (req, res) => {
    try {
      const destino = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!destino) return res.status(404).json({ success: false, error: 'comanda destino não encontrada' });
      if (destino.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda destino não está aberta' });

      const origemId = Number(req.body?.origemId);
      if (!origemId) return res.status(400).json({ success: false, error: 'origemId é obrigatório' });
      if (origemId === destino.id) return res.status(400).json({ success: false, error: 'não dá para juntar a comanda nela mesma' });

      const origem = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(origemId);
      if (!origem) return res.status(404).json({ success: false, error: 'comanda origem não encontrada' });
      if (origem.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda origem não está aberta' });
      // Juntar comanda que já recebeu pagamento parcial embaralharia a
      // conciliação do caixa: o valor pago ficaria órfão da conta que o gerou.
      if (Number(origem.totalPago || 0) > 0) {
        return res.status(400).json({ success: false, error: 'comanda origem já tem pagamento — feche-a antes' });
      }

      const nItens = db.prepare('SELECT COUNT(*) AS n FROM rest_comanda_itens WHERE comandaId = ?').get(origemId).n;

      db.transaction(() => {
        db.prepare('UPDATE rest_comanda_itens SET comandaId = ? WHERE comandaId = ?').run(destino.id, origemId);
        db.prepare("UPDATE rest_comandas SET status = 'cancelada', fechadaEm = ? WHERE id = ?").run(agora(), origemId);
      })();

      const desc = origem.mesaId
        ? `Comanda #${origemId} (mesa ${origem.mesaId}) juntada — ${nItens} item(ns)`
        : `Comanda #${origemId} juntada — ${nItens} item(ns)`;
      registrarEvento(db, destino.id, 'juncao', desc, usuarioDe(req));
      registrarEvento(db, origemId, 'juncao-origem', `Itens migrados para a comanda #${destino.id}`, usuarioDe(req));
      bumpVersao(db, destino.id);
      const comanda = recalcularTotais(db, destino.id);
      res.json({ success: true, itensMigrados: nItens, comanda });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== AJUSTES DA COMANDA ====================

  app.put('/api/restaurante/comandas/:id', gateFlag, (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM rest_comandas WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'comanda não encontrada' });
      if (c.status !== 'aberta') return res.status(400).json({ success: false, error: 'comanda não está aberta' });
      const b = req.body || {};

      if (b.taxaServicoPct !== undefined) {
        const pct = Number(b.taxaServicoPct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          return res.status(400).json({ success: false, error: 'percentual inválido' });
        }
      }
      if (b.totalDesconto !== undefined) {
        const d = Number(b.totalDesconto);
        if (!Number.isFinite(d) || d < 0) return res.status(400).json({ success: false, error: 'desconto inválido' });
      }

      db.prepare(`
        UPDATE rest_comandas SET numeroPessoas = ?, observacao = ?, taxaServicoPct = ?,
               totalCouvert = ?, totalDesconto = ?, clienteId = ?
         WHERE id = ?
      `).run(
        b.numeroPessoas !== undefined ? Number(b.numeroPessoas) : c.numeroPessoas,
        b.observacao !== undefined ? (b.observacao || null) : c.observacao,
        b.taxaServicoPct !== undefined ? Number(b.taxaServicoPct) : c.taxaServicoPct,
        b.totalCouvert !== undefined ? Number(b.totalCouvert) : c.totalCouvert,
        b.totalDesconto !== undefined ? Number(b.totalDesconto) : c.totalDesconto,
        b.clienteId !== undefined ? (b.clienteId ? Number(b.clienteId) : null) : c.clienteId,
        req.params.id,
      );

      // A taxa de serviço é opcional para o cliente (Lei do consumidor): a
      // recusa tem de deixar rastro, senão vira discussão no caixa.
      if (b.taxaServicoPct !== undefined && Number(b.taxaServicoPct) !== Number(c.taxaServicoPct)) {
        registrarEvento(db, c.id, 'taxa-servico',
          `Taxa de serviço ${c.taxaServicoPct}% → ${b.taxaServicoPct}%`, usuarioDe(req));
      }
      bumpVersao(db, c.id);
      res.json({ success: true, comanda: recalcularTotais(db, c.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/restaurante/comandas/:id/eventos', gateFlag, (req, res) => {
    try {
      const items = db.prepare(
        'SELECT * FROM rest_comanda_eventos WHERE comandaId = ? ORDER BY id ASC'
      ).all(req.params.id);
      res.json({ success: true, items });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[restaurante] Rotas de comanda registradas');
}

module.exports = {
  registrarRotasComanda,
  recalcularTotais,
  comandaCompleta,
  itensDaComanda,
  resolverOpcoes,
  registrarEvento,
  agora,
  msDe,
  minutosDesde,
  FUSO_LOCAL_SQL,
  TIPOS,
  STATUS_ITEM,
};
