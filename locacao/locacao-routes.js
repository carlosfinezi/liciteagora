/**
 * locacao-routes.js — Módulo Locação (locadora de bens móveis).
 *
 * Escopo da v1: equipamentos/máquinas e artigos de festa — o núcleo comum
 * "bem móvel que sai e volta". Veículos (CNH, multa, sinistro) e imóveis
 * (repasse ao proprietário, IPTU, IGPM) estão fora por decisão de projeto —
 * ver docs/modulo-locacao-plano-2026-08-27.md.
 *
 * Feature flag por-tenant em config('locacao_enabled'). Quando off,
 * /api/locacao/* devolve 403 com error:'locacao_disabled' — mesmo contrato dos
 * módulos Ótica, Restaurante e Farmácia. O module-gate do plano é uma segunda
 * camada, anterior a esta (plano não contratado nem chega aqui).
 *
 * Config do módulo mora na tabela `config` com prefixo `locacao_`:
 *   locacao_prefixo_numero          prefixo do número do contrato ('LOC')
 *   locacao_carencia_atraso_horas   tolerância antes de multar o atraso
 *   locacao_multa_atraso_percentual % da diária cobrado por dia de atraso
 *   locacao_exigir_caucao           1 = não deixa sair sem caução definida
 *   locacao_exigir_vistoria         1 = entrega/devolução exigem OS
 *   locacao_dia_vencimento_padrao   dia de vencimento no contrato aberto
 *   locacao_permitir_overbooking    1 = deixa reservar acima do disponível
 */

const { logAction } = require('../audit-log');
const { ordemPt } = require('../ordem-pt');
const { initLocacaoSchema } = require('./locacao-schema');
const {
  FAIXAS_VALIDAS, TIPOS_EXTRA, BASES_CAUCAO, calcularTarifa, normalizarInstante,
  calcularCaucao, calcularReposicao, valorDoBem,
} = require('./tarifa');
const {
  disponibilidade, conflitos, seriaisDisponiveis, calendario,
} = require('./disponibilidade');
const {
  TIPOS, NATUREZAS, gerarNumero, registrarEvento, recalcularTotais,
  precificarItem, confirmar, cancelar, reabrir, carregar,
} = require('./contrato');
const { abrirOSVistoria, pendenciasChecklist } = require('./vistoria');
const {
  TIPOS_ACERTO, GRAVIDADES, entregar, devolver, gravarAcerto,
} = require('./apuracao');
const {
  EVENTOS_NOTIFICACAO, faturar, encerrar, receberCaucao, destinarCaucao,
  ligarContratoCore, garantirNotificacoesConfig, apurarNotificacoes,
} = require('./faturamento');
const {
  TIPOS_PLANO, leituraAtual, planosComSituacao, executarManutencao, ocupacao, ranking,
} = require('./manutencao');
const { gerar: gerarPdfLocacao } = require('./locacao-pdf');

// Espelha locacao_item_specs.medidorTipo.
const MEDIDORES_VALIDOS = ['nenhum', 'horimetro', 'km'];

const CONFIG_DEFAULTS = {
  locacao_prefixo_numero: 'LOC',
  // 3 horas: o cliente que devolve na manhã seguinte de uma retirada às 17h
  // não pode levar multa de diária inteira por 20 minutos de trânsito.
  locacao_carencia_atraso_horas: '3',
  // 100% = cada dia de atraso custa uma diária. É o padrão do mercado; quem
  // quiser punitivo sobe para 150.
  locacao_multa_atraso_percentual: '100',
  locacao_exigir_caucao: '0',
  locacao_exigir_vistoria: '1',
  locacao_dia_vencimento_padrao: '10',
  locacao_permitir_overbooking: '0',
  // Hora em que a diária vence (cláusula 1 do contrato de referência:
  // "a contagem tem início na retirada e finalização às 17:30 do mesmo dia").
  // Vazio = a diária dura 24h corridas a partir da retirada.
  locacao_hora_corte: '',
  // Limpeza como % do valor da locação (cláusula 6: "taxa de 40%"). O valor
  // fixo por item continua existindo em Preços → Cobranças avulsas.
  locacao_limpeza_percentual: '',
  // Piso em reais da locação ("*Valor Mínimo Locação: R$ 80,00").
  locacao_valor_minimo: '',
  // Sobre o que a nota promissória é emitida. No contrato de referência ela
  // garante a REPOSIÇÃO da frota (R$ 2.388,18 de promissória para R$ 230,00
  // de aluguel), não o pagamento do aluguel.
  locacao_promissoria_base: 'reposicao',
  locacao_promissoria_dias: '30',
  // Texto padrão das cláusulas, copiado para cada contrato na criação.
  locacao_clausulas_padrao: '',
  // Conta patrimonial para a caução. Vazio = a garantia entra no DRE como
  // receita, o que está errado mas fica VISÍVEL (a API avisa) em vez de
  // depender de um efeito colateral. Ver faturamento.receberCaucao.
  locacao_caucao_plano_conta_id: '',
};

// Chave numérica -> [min, max]. Fora da faixa é 400, não silencioso.
const CONFIG_NUMERICAS = {
  locacao_carencia_atraso_horas: [0, 72],
  locacao_multa_atraso_percentual: [0, 1000],
  locacao_dia_vencimento_padrao: [1, 28],
  locacao_limpeza_percentual: [0, 1000],
  locacao_valor_minimo: [0, 1000000],
  locacao_promissoria_dias: [0, 3650],
};

// Texto livre: não entra na validação numérica nem na booleana.
const CONFIG_TEXTO_LIVRE = ['locacao_clausulas_padrao'];
const BASES_PROMISSORIA = ['reposicao', 'locacao', 'total'];
const CONFIG_BOOLEANAS = [
  'locacao_exigir_caucao',
  'locacao_exigir_vistoria',
  'locacao_permitir_overbooking',
];

function getFlag(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'locacao_enabled'").get();
    return !!(r && r.valor === '1');
  } catch (_) {
    return false;
  }
}

function lerConfig(db) {
  const out = { ...CONFIG_DEFAULTS };
  try {
    const chaves = Object.keys(CONFIG_DEFAULTS);
    const rows = db.prepare(
      `SELECT chave, valor FROM config WHERE chave IN (${chaves.map(() => '?').join(',')})`
    ).all(...chaves);
    for (const r of rows) out[r.chave] = r.valor;
  } catch (_) { /* config ausente — devolve defaults */ }
  return out;
}

function gravarConfig(db, chave, valor) {
  db.prepare(`
    INSERT INTO config (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `).run(chave, String(valor));
}

function validarConfig(chave, valor) {
  if (!(chave in CONFIG_DEFAULTS)) return `chave desconhecida: ${chave}`;
  if (CONFIG_TEXTO_LIVRE.includes(chave)) {
    // As cláusulas são um contrato inteiro; 40 mil caracteres é folgado e
    // ainda impede que alguém cole um arquivo por engano.
    return String(valor).length <= 40000 ? null : 'texto longo demais (máx. 40.000 caracteres)';
  }
  if (chave === 'locacao_hora_corte') {
    if (valor === '' || valor == null) return null;
    return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(valor))
      ? null : "hora de corte deve estar no formato HH:MM (ex.: 17:30)";
  }
  if (chave === 'locacao_promissoria_base') {
    return BASES_PROMISSORIA.includes(String(valor))
      ? null : `base da promissória inválida: ${valor}`;
  }
  // Numérica opcional: vazio significa "não usar".
  if (['locacao_limpeza_percentual', 'locacao_valor_minimo'].includes(chave)
      && (valor === '' || valor == null)) return null;
  if (chave === 'locacao_prefixo_numero') {
    if (!/^[A-Z0-9-]{1,10}$/.test(String(valor))) {
      return 'prefixo deve ter 1..10 caracteres A-Z, 0-9 ou hífen';
    }
    return null;
  }
  if (CONFIG_BOOLEANAS.includes(chave)) {
    return ['0', '1'].includes(String(valor)) ? null : `${chave} aceita apenas 0 ou 1`;
  }
  const faixa = CONFIG_NUMERICAS[chave];
  if (faixa) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return `${chave} deve ser numérico`;
    if (n < faixa[0] || n > faixa[1]) return `${chave} fora da faixa ${faixa[0]}..${faixa[1]}`;
  }
  return null;
}

function registrarRotasLocacao(app, db) {
  initLocacaoSchema(db);

  // Em multi-tenant o db acima é o BOOT_STUB e a migração foi no-op. O schema
  // real de cada tenant vem do db-schema.js; este hook cobre o tenant que
  // ainda não passou por um boot completo (mesmo padrão de Ótica/Farmácia).
  const tenantsMigrados = new WeakSet();
  app.use('/api/locacao', (req, res, next) => {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        initLocacaoSchema(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Read-only e SEM gate: a sidebar precisa saber se mostra o módulo.
  app.get('/api/locacao/status', (req, res) => {
    res.json({ success: true, enabled: getFlag(db) });
  });

  function gateFlag(req, res, next) {
    if (!getFlag(db)) {
      return res.status(403).json({ success: false, error: 'locacao_disabled' });
    }
    next();
  }

  app.get('/api/locacao/config', gateFlag, (req, res) => {
    res.json({ success: true, config: lerConfig(db) });
  });

  app.put('/api/locacao/config', gateFlag, (req, res) => {
    const body = req.body || {};
    const chaves = Object.keys(body);
    if (!chaves.length) {
      return res.status(400).json({ success: false, error: 'nada para gravar' });
    }
    for (const c of chaves) {
      const erro = validarConfig(c, body[c]);
      if (erro) return res.status(400).json({ success: false, error: erro });
    }
    for (const c of chaves) gravarConfig(db, c, body[c]);
    try { logAction(db, req, 'atualizar', 'locacao_config', null, { chaves }); } catch (_) {}
    res.json({ success: true, config: lerConfig(db) });
  });

  // ─── Fase 1: catálogo alugável e tarifário ─────────────────────────────────

  // Lista o que é alugável. O produto continua sendo o do catálogo — a linha
  // em locacao_item_specs é o que o torna alugável.
  app.get('/api/locacao/itens', gateFlag, (req, res) => {
    try {
      const { busca, categoria, alugavel } = req.query;
      let sql = `
        SELECT p.id AS produtoId, p.sku, p.descricao, p.unidade, p.precoVenda, p.precoCusto,
               p.rastreiaSerial, p.ativo,
               p.categoria,
               s.alugavel, s.exigeSerie, s.caucaoPadrao, s.caucaoPercentual,
               s.caucaoPercentualBase, s.horasPreparo,
               s.medidorTipo, s.franquiaPorDia, s.valorReposicao, s.reposicaoPercentual,
               s.observacoes,
               (SELECT COUNT(*) FROM locacao_tarifas t WHERE t.produtoId = p.id AND t.ativo = 1) AS tarifas
        FROM locacao_item_specs s
        JOIN produtos p ON p.id = s.produtoId
        WHERE 1 = 1`;
      const params = [];
      if (busca) {
        sql += ' AND (p.descricao LIKE ? OR p.sku LIKE ?)';
        params.push(`%${busca}%`, `%${busca}%`);
      }
      if (categoria) { sql += ' AND p.categoria = ?'; params.push(categoria); }
      if (alugavel != null && alugavel !== '') {
        sql += ' AND s.alugavel = ?';
        params.push(Number(alugavel) ? 1 : 0);
      }
      sql += ` ORDER BY ${ordemPt('p.descricao')}, p.descricao`;
      res.json({ success: true, itens: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Categorias vêm do CADASTRO DO PRODUTO, não de um campo próprio do módulo.
  // `?apenasAlugaveis=1` restringe às que já têm item alugável — é o que o
  // filtro da tela usa, para não oferecer categoria que não devolve nada.
  app.get('/api/locacao/categorias', gateFlag, (req, res) => {
    try {
      const apenas = req.query.apenasAlugaveis === '1';
      const sql = apenas
        ? `SELECT p.categoria AS categoria, COUNT(*) AS n
           FROM locacao_item_specs s JOIN produtos p ON p.id = s.produtoId
           WHERE p.categoria IS NOT NULL AND p.categoria <> ''
           GROUP BY p.categoria ORDER BY p.categoria`
        : `SELECT categoria, COUNT(*) AS n FROM produtos
           WHERE ativo = 1 AND categoria IS NOT NULL AND categoria <> ''
           GROUP BY categoria ORDER BY categoria`;
      res.json({ success: true, categorias: db.prepare(sql).all() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Busca de produto para o cadastro de item alugável.
  //
  // Existe porque um <select> com o catálogo inteiro é impraticável: quem tem
  // centenas de produtos não acha nada rolando a lista. Busca no SERVIDOR, por
  // descrição/SKU/código de barras, com teto de 30 — e marca quem já é
  // alugável, para o operador não recadastrar sem perceber.
  app.get('/api/locacao/produtos-busca', gateFlag, (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const categoria = req.query.categoria;
      const somenteNovos = req.query.somenteNovos === '1';

      let sql = `
        SELECT p.id, p.sku, p.descricao, p.unidade, p.categoria, p.precoVenda, p.precoCusto,
               p.rastreiaSerial,
               (SELECT COUNT(*) FROM locacao_item_specs s WHERE s.produtoId = p.id) AS jaAlugavel
        FROM produtos p
        WHERE p.ativo = 1`;
      const params = [];
      if (q) {
        sql += ` AND (p.descricao LIKE ? OR p.sku LIKE ? OR p.codigoBarras LIKE ?
                      OR p.codigoInterno LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }
      if (categoria) { sql += ' AND p.categoria = ?'; params.push(categoria); }
      if (somenteNovos) {
        sql += ' AND NOT EXISTS (SELECT 1 FROM locacao_item_specs s WHERE s.produtoId = p.id)';
      }
      sql += ` ORDER BY ${ordemPt('p.descricao')}, p.descricao LIMIT 30`;

      const produtos = db.prepare(sql).all(...params);
      // O total serve para a tela dizer "refine a busca" em vez de deixar o
      // usuário achar que o catálogo tem só 30 itens.
      let total = produtos.length;
      if (produtos.length === 30) {
        const sqlTotal = sql.replace(/SELECT[\s\S]*?FROM produtos p/, 'SELECT COUNT(*) AS n FROM produtos p')
          .replace(/ ORDER BY[\s\S]*$/, '');
        try { total = db.prepare(sqlTotal).get(...params).n; } catch (_) { total = produtos.length; }
      }
      res.json({ success: true, produtos, total, truncado: total > produtos.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/locacao/itens/:produtoId', gateFlag, (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      const item = db.prepare(`
        SELECT p.id AS produtoId, p.sku, p.descricao, p.unidade, p.rastreiaSerial,
               p.categoria, p.precoVenda, p.precoCusto,
               s.*
        FROM produtos p
        LEFT JOIN locacao_item_specs s ON s.produtoId = p.id
        WHERE p.id = ?
      `).get(produtoId);
      if (!item) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      const tarifas = db.prepare(
        'SELECT * FROM locacao_tarifas WHERE produtoId = ? ORDER BY id'
      ).all(produtoId);
      const extras = db.prepare(
        'SELECT * FROM locacao_tarifa_extras WHERE produtoId = ? ORDER BY tipo'
      ).all(produtoId);
      res.json({ success: true, item, tarifas, extras });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Upsert da spec. É o que liga/desliga o produto para locação.
  app.put('/api/locacao/itens/:produtoId', gateFlag, (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      const produto = db.prepare('SELECT id, rastreiaSerial FROM produtos WHERE id = ?').get(produtoId);
      if (!produto) return res.status(404).json({ success: false, error: 'produto não encontrado' });

      const b = req.body || {};
      const medidorTipo = b.medidorTipo || 'nenhum';
      if (!MEDIDORES_VALIDOS.includes(medidorTipo)) {
        return res.status(400).json({ success: false, error: `medidorTipo inválido: ${medidorTipo}` });
      }
      const horasPreparo = Number(b.horasPreparo) || 0;
      if (horasPreparo < 0 || horasPreparo > 720) {
        return res.status(400).json({ success: false, error: 'horasPreparo fora da faixa 0..720' });
      }
      // Percentuais: aceitos junto do valor fixo. Faixa 0..1000 — acima disso
      // é quase certo erro de digitação (3000% de caução não existe), e um
      // engano aqui vira cobrança indevida no contrato.
      const pctCaucao = b.caucaoPercentual != null && b.caucaoPercentual !== ''
        ? Number(b.caucaoPercentual) : null;
      const pctReposicao = b.reposicaoPercentual != null && b.reposicaoPercentual !== ''
        ? Number(b.reposicaoPercentual) : null;
      for (const [nome, v] of [['caucaoPercentual', pctCaucao], ['reposicaoPercentual', pctReposicao]]) {
        if (v == null) continue;
        if (!Number.isFinite(v) || v < 0 || v > 1000) {
          return res.status(400).json({ success: false, error: `${nome} fora da faixa 0..1000` });
        }
      }
      const baseCaucao = b.caucaoPercentualBase || 'locacao';
      if (!BASES_CAUCAO.includes(baseCaucao)) {
        return res.status(400).json({
          success: false,
          error: `caucaoPercentualBase inválida: ${baseCaucao} (use 'locacao' ou 'bem')`,
        });
      }

      const exigeSerie = b.exigeSerie ? 1 : 0;
      // Exigir série num produto que não rastreia série deixaria toda locação
      // presa: não haveria unidade para escolher.
      if (exigeSerie && !produto.rastreiaSerial) {
        return res.status(400).json({
          success: false,
          error: 'produto não rastreia número de série — ligue rastreiaSerial no cadastro antes de exigir série',
        });
      }

      db.prepare(`
        INSERT INTO locacao_item_specs
          (produtoId, alugavel, exigeSerie, caucaoPadrao, caucaoPercentual,
           caucaoPercentualBase, horasPreparo, medidorTipo, franquiaPorDia,
           valorReposicao, reposicaoPercentual, observacoes)
        VALUES (@produtoId, @alugavel, @exigeSerie, @caucaoPadrao, @caucaoPercentual,
                @caucaoPercentualBase, @horasPreparo, @medidorTipo, @franquiaPorDia,
                @valorReposicao, @reposicaoPercentual, @observacoes)
        ON CONFLICT(produtoId) DO UPDATE SET
          alugavel = excluded.alugavel,
          exigeSerie = excluded.exigeSerie,
          caucaoPadrao = excluded.caucaoPadrao,
          caucaoPercentual = excluded.caucaoPercentual,
          caucaoPercentualBase = excluded.caucaoPercentualBase,
          horasPreparo = excluded.horasPreparo,
          medidorTipo = excluded.medidorTipo,
          franquiaPorDia = excluded.franquiaPorDia,
          valorReposicao = excluded.valorReposicao,
          reposicaoPercentual = excluded.reposicaoPercentual,
          observacoes = excluded.observacoes
      `).run({
        produtoId,
        alugavel: b.alugavel === 0 || b.alugavel === false ? 0 : 1,
        exigeSerie,
        caucaoPadrao: Number(b.caucaoPadrao) || 0,
        caucaoPercentual: pctCaucao,
        caucaoPercentualBase: baseCaucao,
        horasPreparo,
        medidorTipo,
        franquiaPorDia: b.franquiaPorDia != null && b.franquiaPorDia !== '' ? Number(b.franquiaPorDia) : null,
        valorReposicao: b.valorReposicao != null && b.valorReposicao !== '' ? Number(b.valorReposicao) : null,
        reposicaoPercentual: pctReposicao,
        observacoes: b.observacoes || null,
      });

      try { logAction(db, req, 'salvar', 'locacao_item', produtoId, { alugavel: b.alugavel }); } catch (_) {}
      const item = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?').get(produtoId);

      // Prévia com números reais: o cadastro mostra quanto dá hoje, e avisa
      // quando o percentual não tem base (produto sem preço).
      const prod = db.prepare('SELECT precoVenda, precoCusto FROM produtos WHERE id = ?').get(produtoId);
      const previa = {
        valorDoBem: valorDoBem(prod),
        reposicao: calcularReposicao(item, { produto: prod, quantidade: 1 }),
        caucaoSobreBem: calcularCaucao({ ...item, caucaoPercentualBase: 'bem' },
          { produto: prod, quantidade: 1 }),
      };
      res.json({ success: true, item, previa });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/locacao/itens/:produtoId', gateFlag, (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      // Item com locação viva não sai do catálogo: o documento perderia a
      // referência do que foi alugado.
      const emUso = db.prepare(`
        SELECT COUNT(*) AS n FROM locacao_itens i
        JOIN locacao_contratos c ON c.id = i.contratoId
        WHERE i.produtoId = ? AND c.status IN ('reservado','emAndamento')
      `).get(produtoId).n;
      if (emUso > 0) {
        return res.status(409).json({
          success: false,
          error: `produto tem ${emUso} locação(ões) em aberto — desligue "alugável" em vez de remover`,
        });
      }
      db.prepare('DELETE FROM locacao_item_specs WHERE produtoId = ?').run(produtoId);
      try { logAction(db, req, 'remover', 'locacao_item', produtoId); } catch (_) {}
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Tarifário do produto, em bloco: o front manda a tabela inteira.
  app.put('/api/locacao/itens/:produtoId/tarifas', gateFlag, (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      if (!db.prepare('SELECT id FROM produtos WHERE id = ?').get(produtoId)) {
        return res.status(404).json({ success: false, error: 'produto não encontrado' });
      }
      const linhas = Array.isArray(req.body && req.body.tarifas) ? req.body.tarifas : null;
      if (!linhas) return res.status(400).json({ success: false, error: 'tarifas deve ser uma lista' });

      const vistas = new Set();
      for (const t of linhas) {
        if (!FAIXAS_VALIDAS.includes(t.faixa)) {
          return res.status(400).json({ success: false, error: `faixa inválida: ${t.faixa}` });
        }
        if (vistas.has(t.faixa)) {
          return res.status(400).json({ success: false, error: `faixa repetida: ${t.faixa}` });
        }
        vistas.add(t.faixa);
        if (!(Number(t.valor) > 0)) {
          return res.status(400).json({ success: false, error: `valor da faixa ${t.faixa} deve ser > 0` });
        }
        if (t.minimoFaturavel != null && !(Number(t.minimoFaturavel) > 0)) {
          return res.status(400).json({ success: false, error: `mínimo faturável da faixa ${t.faixa} deve ser > 0` });
        }
      }

      const gravar = db.transaction(() => {
        db.prepare('DELETE FROM locacao_tarifas WHERE produtoId = ?').run(produtoId);
        const stmt = db.prepare(`
          INSERT INTO locacao_tarifas (produtoId, faixa, valor, minimoFaturavel, ativo)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const t of linhas) {
          stmt.run(produtoId, t.faixa, Number(t.valor),
                   Number(t.minimoFaturavel) > 0 ? Number(t.minimoFaturavel) : 1,
                   t.ativo === 0 || t.ativo === false ? 0 : 1);
        }
      });
      gravar();

      try { logAction(db, req, 'salvar', 'locacao_tarifas', produtoId, { faixas: [...vistas] }); } catch (_) {}
      res.json({
        success: true,
        tarifas: db.prepare('SELECT * FROM locacao_tarifas WHERE produtoId = ? ORDER BY id').all(produtoId),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Extras: produtoId null = padrão do tenant.
  app.get('/api/locacao/extras', gateFlag, (req, res) => {
    try {
      const produtoId = req.query.produtoId ? Number(req.query.produtoId) : null;
      // Traz a descrição do produto junto: as cobranças avulsas são geridas na
      // configuração do módulo, e lá uma exceção sem o nome do item é
      // ilegível — "produtoId 47" não diz nada a quem confere preço.
      const extras = produtoId
        ? db.prepare(`
            SELECT e.*, p.descricao AS produto, p.sku
            FROM locacao_tarifa_extras e LEFT JOIN produtos p ON p.id = e.produtoId
            WHERE e.produtoId = ? OR e.produtoId IS NULL
            ORDER BY e.produtoId, e.tipo`).all(produtoId)
        : db.prepare(`
            SELECT e.*, p.descricao AS produto, p.sku
            FROM locacao_tarifa_extras e LEFT JOIN produtos p ON p.id = e.produtoId
            ORDER BY e.produtoId IS NOT NULL, p.descricao, e.tipo`).all();
      res.json({
        success: true,
        extras,
        tipos: TIPOS_EXTRA,
        padroes: extras.filter(e => !e.produtoId),
        excecoes: extras.filter(e => e.produtoId),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/locacao/extras', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      if (!TIPOS_EXTRA.includes(b.tipo)) {
        return res.status(400).json({ success: false, error: `tipo inválido: ${b.tipo}` });
      }
      if (!(Number(b.valor) >= 0)) {
        return res.status(400).json({ success: false, error: 'valor deve ser >= 0' });
      }
      const produtoId = b.produtoId ? Number(b.produtoId) : null;
      const existente = produtoId
        ? db.prepare('SELECT id FROM locacao_tarifa_extras WHERE produtoId = ? AND tipo = ?').get(produtoId, b.tipo)
        : db.prepare('SELECT id FROM locacao_tarifa_extras WHERE produtoId IS NULL AND tipo = ?').get(b.tipo);

      if (existente) {
        db.prepare('UPDATE locacao_tarifa_extras SET valor = ?, descricao = ?, ativo = ? WHERE id = ?')
          .run(Number(b.valor), b.descricao || null, b.ativo === 0 || b.ativo === false ? 0 : 1, existente.id);
      } else {
        db.prepare(`INSERT INTO locacao_tarifa_extras (produtoId, tipo, valor, descricao, ativo)
                    VALUES (?, ?, ?, ?, ?)`)
          .run(produtoId, b.tipo, Number(b.valor), b.descricao || null,
               b.ativo === 0 || b.ativo === false ? 0 : 1);
      }
      try { logAction(db, req, 'salvar', 'locacao_extra', produtoId, { tipo: b.tipo }); } catch (_) {}
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/locacao/extras/:id', gateFlag, (req, res) => {
    try {
      db.prepare('DELETE FROM locacao_tarifa_extras WHERE id = ?').run(Number(req.params.id));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Simulador: é o que o balcão usa para responder "quanto fica?" antes de
  // existir documento nenhum.
  app.post('/api/locacao/simular', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const produtoId = Number(b.produtoId);
      const tarifas = db.prepare('SELECT * FROM locacao_tarifas WHERE produtoId = ?').all(produtoId);
      const calc = calcularTarifa(tarifas, b.inicio, b.fim, { quantidade: b.quantidade });
      if (!calc.ok) return res.status(400).json({ success: false, error: calc.erro, calculo: calc });
      res.json({ success: true, calculo: calc });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── Fase 2: disponibilidade por período ───────────────────────────────────

  // A pergunta central do módulo. Devolve o cálculo aberto (saldo, venda,
  // locação, bloqueio) porque "indisponível" sem o porquê não ajuda o balcão.
  app.get('/api/locacao/disponibilidade', gateFlag, (req, res) => {
    try {
      const { produtoId, inicio, fim, excetoContratoId, serialNumberId } = req.query;
      if (!produtoId || !inicio || !fim) {
        return res.status(400).json({ success: false, error: 'produtoId, inicio e fim são obrigatórios' });
      }
      const d = disponibilidade(db, Number(produtoId), inicio, fim, {
        excetoContratoId: excetoContratoId ? Number(excetoContratoId) : null,
        serialNumberId: serialNumberId ? Number(serialNumberId) : null,
      });
      if (!d.ok) return res.status(400).json({ success: false, error: d.erro, disponibilidade: d });
      const lista = conflitos(db, Number(produtoId), inicio, fim, {
        excetoContratoId: excetoContratoId ? Number(excetoContratoId) : null,
      });
      res.json({ success: true, disponibilidade: d, conflitos: lista });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/locacao/seriais', gateFlag, (req, res) => {
    try {
      const { produtoId, inicio, fim, excetoContratoId } = req.query;
      if (!produtoId || !inicio || !fim) {
        return res.status(400).json({ success: false, error: 'produtoId, inicio e fim são obrigatórios' });
      }
      const seriais = seriaisDisponiveis(db, Number(produtoId), inicio, fim, {
        excetoContratoId: excetoContratoId ? Number(excetoContratoId) : null,
      });
      res.json({ success: true, seriais });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/locacao/calendario', gateFlag, (req, res) => {
    try {
      const { de, ate, produtoId, categoria } = req.query;
      if (!de || !ate) {
        return res.status(400).json({ success: false, error: 'de e ate são obrigatórios' });
      }
      const grade = calendario(db, de, ate, { produtoId, categoria });
      if (!grade.ok) return res.status(400).json({ success: false, error: grade.erro });
      res.json({ success: true, ...grade });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/locacao/reservas', gateFlag, (req, res) => {
    try {
      const { produtoId, status, documentoId } = req.query;
      let sql = `
        SELECT r.*, p.descricao AS produto, sn.numero AS serie
        FROM locacao_reservas r
        JOIN produtos p ON p.id = r.produtoId
        LEFT JOIN serial_numbers sn ON sn.id = r.serialNumberId
        WHERE 1 = 1`;
      const params = [];
      if (produtoId) { sql += ' AND r.produtoId = ?'; params.push(Number(produtoId)); }
      if (status) { sql += ' AND r.status = ?'; params.push(status); }
      if (documentoId) { sql += ' AND r.documentoId = ?'; params.push(Number(documentoId)); }
      sql += ' ORDER BY r.dataInicio DESC LIMIT 500';
      res.json({ success: true, reservas: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Bloqueio manual: manutenção, quarentena, uso interno. Sai da
  // disponibilidade pelo mesmo cálculo de sobreposição das reservas.
  app.post('/api/locacao/bloqueios', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const produtoId = Number(b.produtoId);
      const inicio = normalizarInstante(b.inicio);
      const fim = normalizarInstante(b.fim);
      if (!produtoId || !inicio || !fim) {
        return res.status(400).json({ success: false, error: 'produtoId, inicio e fim são obrigatórios' });
      }
      if (!(inicio < fim)) {
        return res.status(400).json({ success: false, error: 'fim deve ser depois do início' });
      }
      if (!b.motivo) return res.status(400).json({ success: false, error: 'motivo é obrigatório' });

      const info = db.prepare(`
        INSERT INTO locacao_bloqueios
          (produtoId, serialNumberId, quantidade, dataInicio, dataFim, motivo, osId, usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(produtoId, b.serialNumberId || null, Number(b.quantidade) > 0 ? Number(b.quantidade) : 1,
             inicio, fim, b.motivo, b.osId || null, (req.user && req.user.username) || null);

      try { logAction(db, req, 'criar', 'locacao_bloqueio', info.lastInsertRowid, { produtoId, motivo: b.motivo }); } catch (_) {}
      res.json({
        success: true,
        bloqueio: db.prepare('SELECT * FROM locacao_bloqueios WHERE id = ?').get(info.lastInsertRowid),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/locacao/bloqueios/:id', gateFlag, (req, res) => {
    try {
      const n = db.prepare("UPDATE locacao_bloqueios SET status = 'encerrado' WHERE id = ? AND status = 'ativo'")
        .run(Number(req.params.id)).changes;
      if (!n) return res.status(404).json({ success: false, error: 'bloqueio não encontrado ou já encerrado' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── Fase 3: o documento de locação ────────────────────────────────────────

  // Erro de regra de negócio carrega `status`; o resto é 500.
  function falhar(res, err) {
    const st = Number(err && err.status);
    if (st >= 400 && st < 500) return res.status(st).json({ success: false, error: err.message });
    return res.status(500).json({ success: false, error: err.message });
  }

  app.get('/api/locacao/locacoes', gateFlag, (req, res) => {
    try {
      const { status, clienteId, tipo, de, ate, busca, atrasadas } = req.query;
      let sql = `
        SELECT c.*, p.razaoSocial AS clienteNome,
               (SELECT COUNT(*) FROM locacao_itens i WHERE i.contratoId = c.id) AS qtdItens
        FROM locacao_contratos c
        LEFT JOIN pessoas p ON p.id = c.clienteId
        WHERE 1 = 1`;
      const params = [];
      if (status) { sql += ' AND c.status = ?'; params.push(status); }
      if (tipo) { sql += ' AND c.tipo = ?'; params.push(tipo); }
      if (clienteId) { sql += ' AND c.clienteId = ?'; params.push(Number(clienteId)); }
      if (de) { sql += ' AND c.dataSaidaPrevista >= ?'; params.push(normalizarInstante(de)); }
      if (ate) { sql += ' AND c.dataSaidaPrevista <= ?'; params.push(normalizarInstante(ate)); }
      if (busca) {
        sql += ' AND (c.numero LIKE ? OR p.razaoSocial LIKE ?)';
        params.push(`%${busca}%`, `%${busca}%`);
      }
      // O painel do balcão: o que já devia ter voltado e não voltou.
      if (atrasadas === '1') {
        sql += ` AND c.status = 'emAndamento' AND c.dataRetornoPrevisto IS NOT NULL
                 AND c.dataRetornoPrevisto < datetime('now','localtime')`;
      }
      sql += ' ORDER BY c.dataSaidaPrevista DESC, c.id DESC LIMIT 500';
      res.json({ success: true, locacoes: db.prepare(sql).all(...params) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.get('/api/locacao/locacoes/:id', gateFlag, (req, res) => {
    try {
      const doc = carregar(db, Number(req.params.id));
      if (!doc) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      res.json({ success: true, ...doc });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/locacoes', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const clienteId = Number(b.clienteId);
      if (!clienteId || !db.prepare('SELECT id FROM pessoas WHERE id = ?').get(clienteId)) {
        return res.status(400).json({ success: false, error: 'clienteId inválido' });
      }
      const tipo = b.tipo || 'avulsa';
      if (!TIPOS.includes(tipo)) {
        return res.status(400).json({ success: false, error: `tipo inválido: ${tipo}` });
      }
      const saida = normalizarInstante(b.dataSaidaPrevista);
      if (!saida) return res.status(400).json({ success: false, error: 'dataSaidaPrevista inválida' });

      const retorno = normalizarInstante(b.dataRetornoPrevisto);
      // Avulsa é período fechado: sem retorno previsto não há o que precificar
      // nem o que reservar. Aberta não tem fim por definição.
      if (tipo === 'avulsa' && !retorno) {
        return res.status(400).json({ success: false, error: 'locação avulsa exige dataRetornoPrevisto' });
      }
      if (retorno && !(saida < retorno)) {
        return res.status(400).json({ success: false, error: 'retorno previsto deve ser depois da saída' });
      }

      const cfg = lerConfig(db);
      const numero = b.numero || gerarNumero(db, cfg.locacao_prefixo_numero, saida.slice(0, 4));
      if (db.prepare('SELECT id FROM locacao_contratos WHERE numero = ?').get(numero)) {
        return res.status(409).json({ success: false, error: `número já existe: ${numero}` });
      }

      const info = db.prepare(`
        INSERT INTO locacao_contratos
          (numero, clienteId, tipo, status, dataSaidaPrevista, dataRetornoPrevisto,
           enderecoEntrega, responsavelRetirada, documentoRetirada,
           contatoObra, telefoneObra, enderecoCobranca, tipoFrete, documentoAuxiliar,
           clausulas, caucaoValor, caucaoStatus, diaVencimento, observacoes, usuarioCriacao)
        VALUES (?, ?, ?, 'orcamento', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(numero, clienteId, tipo, saida, retorno,
             b.enderecoEntrega || null, b.responsavelRetirada || null, b.documentoRetirada || null,
             b.contatoObra || null, b.telefoneObra || null, b.enderecoCobranca || null,
             b.tipoFrete || null, b.documentoAuxiliar || null,
             // Cláusulas COPIADAS agora: o contrato assinado tem de continuar
             // dizendo o que dizia, mesmo que a locadora edite o padrão depois.
             b.clausulas != null ? b.clausulas : (cfg.locacao_clausulas_padrao || null),
             Number(b.caucaoValor) || 0,
             Number(b.caucaoValor) > 0 ? 'pendente' : 'nao_aplicavel',
             Number(b.diaVencimento) || Number(cfg.locacao_dia_vencimento_padrao) || null,
             b.observacoes || null, (req.user && req.user.username) || null);

      const id = info.lastInsertRowid;
      registrarEvento(db, id, 'criar', { statusDepois: 'orcamento', usuario: (req.user && req.user.username) });
      try { logAction(db, req, 'criar', 'locacao', id, { numero }); } catch (_) {}
      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.put('/api/locacao/locacoes/:id', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      if (['encerrado', 'cancelado'].includes(c.status)) {
        return res.status(409).json({ success: false, error: `locação ${c.status} não pode ser editada` });
      }

      const b = req.body || {};
      const saida = b.dataSaidaPrevista != null ? normalizarInstante(b.dataSaidaPrevista) : c.dataSaidaPrevista;
      const retorno = b.dataRetornoPrevisto != null
        ? normalizarInstante(b.dataRetornoPrevisto) : c.dataRetornoPrevisto;
      if (!saida) return res.status(400).json({ success: false, error: 'dataSaidaPrevista inválida' });
      if (retorno && !(saida < retorno)) {
        return res.status(400).json({ success: false, error: 'retorno previsto deve ser depois da saída' });
      }
      // Mudar o período de um documento já reservado desalinharia a agenda:
      // as reservas gravadas continuariam no período antigo.
      if (c.status !== 'orcamento' && (saida !== c.dataSaidaPrevista || retorno !== c.dataRetornoPrevisto)) {
        return res.status(409).json({
          success: false,
          error: 'reabra o orçamento para mudar o período — as reservas já foram gravadas no período atual',
        });
      }

      db.prepare(`
        UPDATE locacao_contratos SET
          dataSaidaPrevista = ?, dataRetornoPrevisto = ?, enderecoEntrega = ?,
          responsavelRetirada = ?, documentoRetirada = ?, caucaoValor = ?,
          diaVencimento = ?, observacoes = ?,
          contatoObra = ?, telefoneObra = ?, enderecoCobranca = ?, tipoFrete = ?,
          documentoAuxiliar = ?, clausulas = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(saida, retorno,
             b.enderecoEntrega !== undefined ? b.enderecoEntrega : c.enderecoEntrega,
             b.responsavelRetirada !== undefined ? b.responsavelRetirada : c.responsavelRetirada,
             b.documentoRetirada !== undefined ? b.documentoRetirada : c.documentoRetirada,
             b.caucaoValor !== undefined ? Number(b.caucaoValor) || 0 : c.caucaoValor,
             b.diaVencimento !== undefined ? Number(b.diaVencimento) || null : c.diaVencimento,
             b.observacoes !== undefined ? b.observacoes : c.observacoes,
             b.contatoObra !== undefined ? b.contatoObra : c.contatoObra,
             b.telefoneObra !== undefined ? b.telefoneObra : c.telefoneObra,
             b.enderecoCobranca !== undefined ? b.enderecoCobranca : c.enderecoCobranca,
             b.tipoFrete !== undefined ? b.tipoFrete : c.tipoFrete,
             b.documentoAuxiliar !== undefined ? b.documentoAuxiliar : c.documentoAuxiliar,
             b.clausulas !== undefined ? b.clausulas : c.clausulas,
             id);

      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.delete('/api/locacao/locacoes/:id', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      // Só orçamento some. O resto vira histórico: cancele.
      if (c.status !== 'orcamento') {
        return res.status(409).json({
          success: false,
          error: `só orçamento pode ser excluído — esta locação está "${c.status}". Use cancelar.`,
        });
      }
      db.prepare('DELETE FROM locacao_contratos WHERE id = ?').run(id);
      try { logAction(db, req, 'remover', 'locacao', id, { numero: c.numero }); } catch (_) {}
      res.json({ success: true });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Itens ──

  app.post('/api/locacao/locacoes/:id/itens', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      if (c.status !== 'orcamento') {
        return res.status(409).json({
          success: false, error: 'só dá para mexer nos itens enquanto a locação é orçamento',
        });
      }

      const b = req.body || {};
      const natureza = b.natureza || 'locacao';
      if (!NATUREZAS.includes(natureza)) {
        return res.status(400).json({ success: false, error: `natureza inválida: ${natureza}` });
      }

      const quantidade = Number(b.quantidade) > 0 ? Number(b.quantidade) : 1;
      const dataInicio = normalizarInstante(b.dataInicio) || c.dataSaidaPrevista;
      const dataFim = normalizarInstante(b.dataFim) || c.dataRetornoPrevisto;

      let produtoId = b.produtoId ? Number(b.produtoId) : null;
      let descricao = b.descricao;

      if (natureza === 'locacao') {
        if (!produtoId) {
          return res.status(400).json({ success: false, error: 'item de locação exige produtoId' });
        }
        const prod = db.prepare('SELECT id, descricao FROM produtos WHERE id = ?').get(produtoId);
        if (!prod) return res.status(404).json({ success: false, error: 'produto não encontrado' });
        const spec = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?').get(produtoId);
        if (!spec || !spec.alugavel) {
          return res.status(400).json({ success: false, error: 'produto não está marcado como alugável' });
        }
        if (spec.exigeSerie && !b.serialNumberId) {
          return res.status(400).json({
            success: false, error: 'este item exige número de série — escolha qual unidade sai',
          });
        }
        if (!dataFim) {
          return res.status(400).json({
            success: false, error: 'item de locação precisa de fim (do item ou do contrato)',
          });
        }
        descricao = descricao || prod.descricao;
      } else if (!descricao) {
        return res.status(400).json({ success: false, error: 'item de serviço exige descrição' });
      }

      const preco = precificarItem(db, {
        natureza, produtoId, quantidade, dataInicio, dataFim, valorUnitario: b.valorUnitario,
      }, lerConfig(db));
      if (!preco.ok) return res.status(400).json({ success: false, error: preco.erro });

      const info = db.prepare(`
        INSERT INTO locacao_itens
          (contratoId, produtoId, serialNumberId, descricao, natureza, tipoOperacaoId,
           quantidade, dataInicio, dataFim, tarifaFaixa, tarifaValor, unidades,
           valorUnitario, valorTotal, medidorSaida, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, produtoId, b.serialNumberId || null, descricao, natureza,
             b.tipoOperacaoId || null, quantidade, dataInicio, dataFim,
             preco.tarifaFaixa, preco.tarifaValor, preco.unidades,
             preco.valorUnitario, preco.valorTotal,
             b.medidorSaida != null ? Number(b.medidorSaida) : null, b.observacoes || null);

      const totais = recalcularTotais(db, id);
      res.json({
        success: true, itemId: info.lastInsertRowid, totais,
        composicao: preco.composicao || [], ...carregar(db, id),
      });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.put('/api/locacao/locacoes/:id/itens/:itemId', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const itemId = Number(req.params.itemId);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      if (c.status !== 'orcamento') {
        return res.status(409).json({
          success: false, error: 'só dá para mexer nos itens enquanto a locação é orçamento',
        });
      }
      const item = db.prepare('SELECT * FROM locacao_itens WHERE id = ? AND contratoId = ?').get(itemId, id);
      if (!item) return res.status(404).json({ success: false, error: 'item não encontrado' });

      const b = req.body || {};
      const quantidade = b.quantidade != null ? (Number(b.quantidade) > 0 ? Number(b.quantidade) : 1) : item.quantidade;
      const dataInicio = b.dataInicio != null ? normalizarInstante(b.dataInicio) : item.dataInicio;
      const dataFim = b.dataFim != null ? normalizarInstante(b.dataFim) : item.dataFim;
      if (dataInicio && dataFim && !(dataInicio < dataFim)) {
        return res.status(400).json({ success: false, error: 'fim do item deve ser depois do início' });
      }

      const preco = precificarItem(db, {
        natureza: item.natureza, produtoId: item.produtoId, quantidade, dataInicio, dataFim,
        valorUnitario: b.valorUnitario != null ? b.valorUnitario : item.valorUnitario,
      }, lerConfig(db));
      if (!preco.ok) return res.status(400).json({ success: false, error: preco.erro });

      db.prepare(`
        UPDATE locacao_itens SET
          quantidade = ?, dataInicio = ?, dataFim = ?, serialNumberId = ?,
          descricao = ?, tipoOperacaoId = ?, tarifaFaixa = ?, tarifaValor = ?, unidades = ?,
          valorUnitario = ?, valorTotal = ?, medidorSaida = ?, observacoes = ?
        WHERE id = ?
      `).run(quantidade, dataInicio, dataFim,
             b.serialNumberId !== undefined ? (b.serialNumberId || null) : item.serialNumberId,
             b.descricao !== undefined ? b.descricao : item.descricao,
             b.tipoOperacaoId !== undefined ? (b.tipoOperacaoId || null) : item.tipoOperacaoId,
             preco.tarifaFaixa, preco.tarifaValor, preco.unidades,
             preco.valorUnitario, preco.valorTotal,
             b.medidorSaida !== undefined ? (b.medidorSaida != null ? Number(b.medidorSaida) : null) : item.medidorSaida,
             b.observacoes !== undefined ? b.observacoes : item.observacoes,
             itemId);

      const totais = recalcularTotais(db, id);
      res.json({ success: true, totais, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.delete('/api/locacao/locacoes/:id/itens/:itemId', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      if (c.status !== 'orcamento') {
        return res.status(409).json({
          success: false, error: 'só dá para mexer nos itens enquanto a locação é orçamento',
        });
      }
      const n = db.prepare('DELETE FROM locacao_itens WHERE id = ? AND contratoId = ?')
        .run(Number(req.params.itemId), id).changes;
      if (!n) return res.status(404).json({ success: false, error: 'item não encontrado' });
      const totais = recalcularTotais(db, id);
      res.json({ success: true, totais });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Transições ──

  app.post('/api/locacao/locacoes/:id/confirmar', gateFlag, (req, res) => {
    try {
      const cfg = lerConfig(db);
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      // A trava de caução é do tenant: quem liga não quer bem na rua sem
      // garantia definida.
      if (cfg.locacao_exigir_caucao === '1' && !(Number(c.caucaoValor) > 0)) {
        return res.status(400).json({
          success: false, error: 'a configuração exige caução definida antes de reservar',
        });
      }
      confirmar(db, id, {
        usuario: (req.user && req.user.username),
        permitirOverbooking: cfg.locacao_permitir_overbooking === '1',
      });
      try { logAction(db, req, 'confirmar', 'locacao', id, { numero: c.numero }); } catch (_) {}
      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/locacoes/:id/cancelar', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      cancelar(db, id, { usuario: (req.user && req.user.username), motivo: (req.body || {}).motivo });
      try { logAction(db, req, 'cancelar', 'locacao', id); } catch (_) {}
      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/locacoes/:id/reabrir', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      reabrir(db, id, { usuario: (req.user && req.user.username) });
      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ─── Fase 4: saída, retorno e avaria (vistoria via OS) ─────────────────────

  // Abre a OS de vistoria sem mudar o status da locação. Serve para preparar a
  // conferência antes de o cliente chegar.
  app.post('/api/locacao/locacoes/:id/vistoria', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });
      const momento = (req.body || {}).momento;
      if (!['entrega', 'devolucao'].includes(momento)) {
        return res.status(400).json({ success: false, error: "momento deve ser 'entrega' ou 'devolucao'" });
      }
      const jaTem = momento === 'entrega' ? c.osEntregaId : c.osDevolucaoId;
      if (jaTem) {
        return res.status(409).json({ success: false, error: `já existe OS de ${momento} (#${jaTem})` });
      }
      const os = abrirOSVistoria(db, c, momento, { usuario: (req.user && req.user.username) });
      const campo = momento === 'entrega' ? 'osEntregaId' : 'osDevolucaoId';
      db.prepare(`UPDATE locacao_contratos SET ${campo} = ? WHERE id = ?`).run(os.id, id);
      registrarEvento(db, id, 'vistoria', {
        descricao: `OS de ${momento} ${os.numero} aberta`, usuario: (req.user && req.user.username),
      });
      res.json({ success: true, os, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/locacoes/:id/entregar', gateFlag, (req, res) => {
    try {
      const cfg = lerConfig(db);
      const id = Number(req.params.id);
      const b = req.body || {};
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });

      let osId = b.osEntregaId || c.osEntregaId || null;

      // Com a vistoria exigida, ou já existe OS ou ela é aberta agora — e o
      // checklist obrigatório precisa estar concluído antes de o bem sair.
      if (cfg.locacao_exigir_vistoria === '1') {
        if (!osId) {
          if (!b.abrirVistoria) {
            return res.status(400).json({
              success: false,
              error: 'a configuração exige vistoria — abra a OS de entrega antes (ou mande abrirVistoria:true)',
            });
          }
          const os = abrirOSVistoria(db, c, 'entrega', { usuario: (req.user && req.user.username) });
          osId = os.id;
          db.prepare('UPDATE locacao_contratos SET osEntregaId = ? WHERE id = ?').run(osId, id);
          return res.status(409).json({
            success: false,
            error: 'OS de entrega aberta — conclua o checklist obrigatório e chame entregar de novo',
            os,
          });
        }
        const pendentes = pendenciasChecklist(db, osId);
        if (pendentes.length) {
          return res.status(409).json({
            success: false,
            error: `há ${pendentes.length} item(ns) obrigatório(s) da vistoria pendente(s)`,
            checklist: pendentes,
          });
        }
      }

      entregar(db, id, {
        dataSaidaReal: b.dataSaidaReal,
        medidores: b.medidores,
        osEntregaId: osId,
        usuario: (req.user && req.user.username),
      });
      try { logAction(db, req, 'entregar', 'locacao', id, { numero: c.numero }); } catch (_) {}
      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/locacoes/:id/devolver', gateFlag, (req, res) => {
    try {
      const cfg = lerConfig(db);
      const id = Number(req.params.id);
      const b = req.body || {};
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });

      let osId = b.osDevolucaoId || c.osDevolucaoId || null;
      if (cfg.locacao_exigir_vistoria === '1' && c.status === 'emAndamento') {
        if (!osId) {
          if (!b.abrirVistoria) {
            return res.status(400).json({
              success: false,
              error: 'a configuração exige vistoria — abra a OS de devolução antes (ou mande abrirVistoria:true)',
            });
          }
          const os = abrirOSVistoria(db, c, 'devolucao', { usuario: (req.user && req.user.username) });
          osId = os.id;
          db.prepare('UPDATE locacao_contratos SET osDevolucaoId = ? WHERE id = ?').run(osId, id);
          return res.status(409).json({
            success: false,
            error: 'OS de devolução aberta — conclua o checklist obrigatório e chame devolver de novo',
            os,
          });
        }
        const pendentes = pendenciasChecklist(db, osId);
        if (pendentes.length) {
          return res.status(409).json({
            success: false,
            error: `há ${pendentes.length} item(ns) obrigatório(s) da vistoria pendente(s)`,
            checklist: pendentes,
          });
        }
      }

      const r = devolver(db, id, {
        dataRetornoReal: b.dataRetornoReal,
        medidores: b.medidores,
        itensDevolvidos: b.itensDevolvidos,
        // Quem faz a vistoria de retorno marca se o equipamento voltou sujo.
        exigiuLimpeza: !!b.exigiuLimpeza,
        osDevolucaoId: osId,
        config: cfg,
        usuario: (req.user && req.user.username),
      });
      try { logAction(db, req, 'devolver', 'locacao', id, { numero: c.numero }); } catch (_) {}
      res.json({ success: true, resumo: r.resumo, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Avarias ──

  app.post('/api/locacao/locacoes/:id/avarias', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });

      const b = req.body || {};
      if (!b.descricao) return res.status(400).json({ success: false, error: 'descrição é obrigatória' });
      const gravidade = b.gravidade || 'leve';
      if (!GRAVIDADES.includes(gravidade)) {
        return res.status(400).json({ success: false, error: `gravidade inválida: ${gravidade}` });
      }
      const valor = Number(b.valorCobrado) || 0;
      if (valor < 0) return res.status(400).json({ success: false, error: 'valor não pode ser negativo' });
      if (b.itemId && !db.prepare('SELECT id FROM locacao_itens WHERE id = ? AND contratoId = ?').get(Number(b.itemId), id)) {
        return res.status(404).json({ success: false, error: 'item não pertence a esta locação' });
      }

      const info = db.prepare(`
        INSERT INTO locacao_avarias
          (contratoId, itemId, descricao, gravidade, valorCobrado, osAnexoId, usuario)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, b.itemId || null, b.descricao, gravidade, valor,
             b.osAnexoId || null, (req.user && req.user.username) || null);

      registrarEvento(db, id, 'avaria', {
        descricao: `${gravidade}: ${b.descricao}`, valorDepois: valor,
        usuario: (req.user && req.user.username),
      });

      // Avaria registrada DEPOIS da devolução já vira acerto na hora — senão
      // ficaria esperando uma reapuração que não vai acontecer.
      if (c.status === 'devolvido' && valor > 0) {
        gravarAcerto(db, id, {
          itemId: b.itemId || null, tipo: 'avaria',
          descricao: `Avaria (${gravidade}): ${b.descricao}`,
          quantidade: 1, valorUnitario: valor, valorTotal: valor,
          usuario: (req.user && req.user.username),
        });
        db.prepare('UPDATE locacao_avarias SET cobrada = 1 WHERE id = ?').run(info.lastInsertRowid);
        recalcularTotais(db, id);
      }

      res.json({ success: true, avariaId: info.lastInsertRowid, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.delete('/api/locacao/locacoes/:id/avarias/:avariaId', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const avariaId = Number(req.params.avariaId);
      const a = db.prepare('SELECT * FROM locacao_avarias WHERE id = ? AND contratoId = ?').get(avariaId, id);
      if (!a) return res.status(404).json({ success: false, error: 'avaria não encontrada' });
      db.prepare('DELETE FROM locacao_avarias WHERE id = ?').run(avariaId);
      // O acerto correspondente sai junto: manter a cobrança de uma avaria
      // apagada é o tipo de resíduo que ninguém encontra depois.
      if (a.cobrada) {
        db.prepare("DELETE FROM locacao_acertos WHERE contratoId = ? AND tipo = 'avaria' AND descricao LIKE ?")
          .run(id, `%${a.descricao}%`);
        recalcularTotais(db, id);
      }
      res.json({ success: true });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Acertos manuais (desconto, limpeza, entrega) ──

  app.post('/api/locacao/locacoes/:id/acertos', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!db.prepare('SELECT id FROM locacao_contratos WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, error: 'locação não encontrada' });
      }
      const b = req.body || {};
      if (!TIPOS_ACERTO.includes(b.tipo)) {
        return res.status(400).json({ success: false, error: `tipo de acerto inválido: ${b.tipo}` });
      }
      if (!b.descricao) return res.status(400).json({ success: false, error: 'descrição é obrigatória' });
      const quantidade = Number(b.quantidade) > 0 ? Number(b.quantidade) : 1;
      const valorUnitario = Number(b.valorUnitario) || 0;
      // Desconto entra negativo; o resto, positivo. Sem isso o "desconto" somaria.
      const sinal = b.tipo === 'desconto' ? -1 : 1;

      const acertoId = gravarAcerto(db, id, {
        itemId: b.itemId || null, tipo: b.tipo, descricao: b.descricao,
        quantidade, valorUnitario: Math.abs(valorUnitario),
        valorTotal: sinal * Math.abs(valorUnitario) * quantidade,
        natureza: b.natureza === 'servico' ? 'servico' : 'locacao',
        usuario: (req.user && req.user.username),
      });
      const totais = recalcularTotais(db, id);
      res.json({ success: true, acertoId, totais, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.delete('/api/locacao/locacoes/:id/acertos/:acertoId', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const n = db.prepare('DELETE FROM locacao_acertos WHERE id = ? AND contratoId = ?')
        .run(Number(req.params.acertoId), id).changes;
      if (!n) return res.status(404).json({ success: false, error: 'acerto não encontrado' });
      const totais = recalcularTotais(db, id);
      res.json({ success: true, totais });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ─── Fase 5: financeiro e fiscal ───────────────────────────────────────────

  app.post('/api/locacao/locacoes/:id/faturar', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const r = faturar(db, id, {
        competencia: b.competencia,
        dataVencimento: b.dataVencimento,
        gerarCR: b.gerarCR,
        observacoes: b.observacoes,
        // Refaturar é decisão consciente de quem chama: sem esta flag, um
        // segundo POST devolve 409 em vez de gerar outro título cheio.
        permitirRefaturar: !!b.permitirRefaturar,
        usuario: (req.user && req.user.username),
      });
      try { logAction(db, req, 'faturar', 'locacao', id, { valorTotal: r.valorTotal }); } catch (_) {}
      res.json({ success: true, faturamento: r, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/locacoes/:id/encerrar', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      encerrar(db, id, {
        semFaturar: !!b.semFaturar,
        ignorarCaucao: !!b.ignorarCaucao,
        usuario: (req.user && req.user.username),
      });
      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Caução ──

  app.post('/api/locacao/locacoes/:id/caucao/receber', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const r = receberCaucao(db, id, {
        recebida: (req.body || {}).recebida,
        dataVencimento: (req.body || {}).dataVencimento,
        usuario: (req.user && req.user.username),
      });
      res.json({ success: true, caucao: r, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/locacoes/:id/caucao/destinar', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      destinarCaucao(db, id, b.destino, {
        valor: b.valor, motivo: b.motivo, usuario: (req.user && req.user.username),
      });
      res.json({ success: true, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Contrato de recorrência (tipo aberta) ──

  app.post('/api/locacao/locacoes/:id/contrato-core', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const b = req.body || {};
      const contrato = ligarContratoCore(db, id, {
        renovacaoAutomatica: b.renovacaoAutomatica,
        indiceReajuste: b.indiceReajuste,
        usuario: (req.user && req.user.username),
      });
      res.json({ success: true, contratoCore: contrato, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Notificações ──

  app.get('/api/locacao/notificacoes/config', gateFlag, (req, res) => {
    try {
      garantirNotificacoesConfig(db);
      res.json({
        success: true,
        eventos: EVENTOS_NOTIFICACAO,
        config: db.prepare('SELECT * FROM locacao_notificacoes_config ORDER BY evento, canal').all(),
      });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.put('/api/locacao/notificacoes/config', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      if (!EVENTOS_NOTIFICACAO.includes(b.evento)) {
        return res.status(400).json({ success: false, error: `evento inválido: ${b.evento}` });
      }
      if (!['telegram', 'email', 'whatsapp'].includes(b.canal)) {
        return res.status(400).json({ success: false, error: `canal inválido: ${b.canal}` });
      }
      db.prepare(`
        INSERT INTO locacao_notificacoes_config (evento, canal, template, ativo)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(evento, canal) DO UPDATE SET
          template = excluded.template, ativo = excluded.ativo
      `).run(b.evento, b.canal, b.template || null, b.ativo ? 1 : 0);
      res.json({ success: true });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.get('/api/locacao/notificacoes/pendentes', gateFlag, (req, res) => {
    try {
      res.json({ success: true, ...apurarNotificacoes(db, req.query.hoje) });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ─── Fase 7: contrato impresso, avalistas e promissória ────────────────────

  // Dados da locadora para o cabeçalho e a promissória. `estabelecimentos` é
  // o cadastro fiscal do tenant e já tem tudo (razão social, fantasia, CNPJ,
  // IE, endereço, telefone, e-mail).
  function lerLocadora() {
    try {
      return db.prepare(`SELECT * FROM estabelecimentos
                         WHERE ativo = 1 ORDER BY matriz DESC, id LIMIT 1`).get() || {};
    } catch (_) {
      return {};
    }
  }

  // Valor de indenização por item, para a coluna do contrato e para a base da
  // promissória. É o mesmo cálculo da devolução — fixo ou percentual do bem.
  function indenizacaoDosItens(contratoId) {
    const itens = db.prepare(`
      SELECT i.*, p.precoVenda, p.precoCusto
      FROM locacao_itens i LEFT JOIN produtos p ON p.id = i.produtoId
      WHERE i.contratoId = ? ORDER BY i.id
    `).all(contratoId);
    let total = 0;
    for (const i of itens) {
      if (i.natureza === 'servico' || !i.produtoId) { i.valorIndenizacao = null; continue; }
      const spec = db.prepare('SELECT * FROM locacao_item_specs WHERE produtoId = ?').get(i.produtoId);
      const rep = calcularReposicao(spec, {
        produto: { precoVenda: i.precoVenda, precoCusto: i.precoCusto },
        quantidade: i.quantidade,
      });
      i.valorIndenizacao = rep.valorUnitario;
      total += rep.valor;
    }
    return { itens, totalIndenizacao: Math.round(total * 100) / 100 };
  }

  app.get('/api/locacao/locacoes/:id/pdf', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const doc = carregar(db, id);
      if (!doc) return res.status(404).json({ success: false, error: 'locação não encontrada' });

      const cfg = lerConfig(db);
      const { itens } = indenizacaoDosItens(id);
      const cliente = db.prepare('SELECT * FROM pessoas WHERE id = ?').get(doc.contrato.clienteId) || {};

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition',
        `inline; filename="Contrato-${doc.contrato.numero}.pdf"`);

      gerarPdfLocacao(res, {
        contrato: doc.contrato,
        itens,
        acertos: doc.acertos,
        avalistas: doc.avalistas || [],
        cliente,
        locadora: lerLocadora(),
        config: cfg,
        usuario: (req.user && req.user.username) || null,
      });
    } catch (err) {
      // O PDF já pode ter começado a sair; nesse caso não dá para trocar o
      // status, só encerrar.
      if (res.headersSent) return res.end();
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Prepara a promissória: calcula o valor pela base configurada e grava.
  app.post('/api/locacao/locacoes/:id/promissoria', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      const c = db.prepare('SELECT * FROM locacao_contratos WHERE id = ?').get(id);
      if (!c) return res.status(404).json({ success: false, error: 'locação não encontrada' });

      const b = req.body || {};
      const cfg = lerConfig(db);
      const base = b.base || cfg.locacao_promissoria_base || 'reposicao';

      let valor = Number(b.valor);
      if (!(valor > 0)) {
        if (base === 'reposicao') valor = indenizacaoDosItens(id).totalIndenizacao;
        else if (base === 'locacao') valor = Number(c.valorLocacao) || 0;
        else valor = Number(c.valorTotal) || 0;
      }
      if (!(valor > 0)) {
        return res.status(400).json({
          success: false,
          error: base === 'reposicao'
            ? 'nenhum item tem valor de indenização cadastrado — defina "Se o item não voltar" nos itens alugáveis'
            : 'a locação ainda não tem valor',
        });
      }

      // Vencimento: o do modelo é ~30 dias após a saída.
      let venc = normalizarInstante(b.vencimento);
      if (!venc) {
        const dias = Number(cfg.locacao_promissoria_dias) || 30;
        const baseData = new Date(String(c.dataRetornoPrevisto || c.dataSaidaPrevista).replace(' ', 'T'));
        venc = normalizarInstante(new Date(baseData.getTime() + dias * 86400000));
      }

      const locadora = lerLocadora();
      db.prepare(`UPDATE locacao_contratos
                  SET promissoriaEmitir = 1, promissoriaNumero = ?, promissoriaVencimento = ?,
                      promissoriaValor = ?, promissoriaPraca = ?, dataAtualizacao = CURRENT_TIMESTAMP
                  WHERE id = ?`)
        .run(b.numero || c.numero, venc.slice(0, 10), Math.round(valor * 100) / 100,
             b.praca || [locadora.cidade, locadora.uf].filter(Boolean).join('/') || null, id);

      registrarEvento(db, id, 'promissoria', {
        descricao: `Promissória de ${valor.toFixed(2)} (base: ${base})`,
        valorDepois: valor, usuario: (req.user && req.user.username),
      });
      res.json({ success: true, base, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.delete('/api/locacao/locacoes/:id/promissoria', gateFlag, (req, res) => {
    try {
      db.prepare(`UPDATE locacao_contratos SET promissoriaEmitir = 0, promissoriaValor = NULL,
                  promissoriaVencimento = NULL WHERE id = ?`).run(Number(req.params.id));
      res.json({ success: true });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Avalistas ──

  app.post('/api/locacao/locacoes/:id/avalistas', gateFlag, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!db.prepare('SELECT id FROM locacao_contratos WHERE id = ?').get(id)) {
        return res.status(404).json({ success: false, error: 'locação não encontrada' });
      }
      const b = req.body || {};
      if (!b.nome && !b.cpfCnpj) {
        return res.status(400).json({ success: false, error: 'informe ao menos nome ou CPF/CNPJ' });
      }
      const ordem = db.prepare('SELECT COALESCE(MAX(ordem), -1) + 1 AS n FROM locacao_avalistas WHERE contratoId = ?')
        .get(id).n;
      const info = db.prepare(`
        INSERT INTO locacao_avalistas (contratoId, nome, cpfCnpj, endereco, telefone, ordem)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, b.nome || null, b.cpfCnpj || null, b.endereco || null, b.telefone || null, ordem);
      res.json({ success: true, avalistaId: info.lastInsertRowid, ...carregar(db, id) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.delete('/api/locacao/locacoes/:id/avalistas/:avalistaId', gateFlag, (req, res) => {
    try {
      const n = db.prepare('DELETE FROM locacao_avalistas WHERE id = ? AND contratoId = ?')
        .run(Number(req.params.avalistaId), Number(req.params.id)).changes;
      if (!n) return res.status(404).json({ success: false, error: 'avalista não encontrado' });
      res.json({ success: true });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ─── Fase 6: manutenção por uso e indicadores ──────────────────────────────

  app.get('/api/locacao/manutencao/planos', gateFlag, (req, res) => {
    try {
      res.json({
        success: true,
        planos: planosComSituacao(db, req.query.hoje, { produtoId: req.query.produtoId }),
      });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/manutencao/planos', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const produtoId = Number(b.produtoId);
      if (!produtoId || !db.prepare('SELECT id FROM produtos WHERE id = ?').get(produtoId)) {
        return res.status(400).json({ success: false, error: 'produtoId inválido' });
      }
      if (!TIPOS_PLANO.includes(b.tipo)) {
        return res.status(400).json({ success: false, error: `tipo inválido: ${b.tipo}` });
      }
      if (!(Number(b.intervalo) > 0)) {
        return res.status(400).json({ success: false, error: 'intervalo deve ser > 0' });
      }
      if (!b.descricao) return res.status(400).json({ success: false, error: 'descrição é obrigatória' });

      // Plano por medidor num produto que não mede nunca vencerá — é melhor
      // recusar do que deixar a manutenção silenciosamente parada.
      if (b.tipo !== 'dias') {
        const spec = db.prepare('SELECT medidorTipo FROM locacao_item_specs WHERE produtoId = ?').get(produtoId);
        if (!spec || spec.medidorTipo === 'nenhum') {
          return res.status(400).json({
            success: false,
            error: `o produto não tem medidor configurado — use tipo "dias" ou defina medidorTipo no item alugável`,
          });
        }
      }

      const info = db.prepare(`
        INSERT INTO locacao_manutencao_planos
          (produtoId, serialNumberId, descricao, tipo, intervalo, ultimoValor, ultimaData, osTipoId, ativo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(produtoId, b.serialNumberId || null, b.descricao, b.tipo, Number(b.intervalo),
             Number(b.ultimoValor) || 0, normalizarInstante(b.ultimaData), b.osTipoId || null);

      res.json({
        success: true,
        plano: db.prepare('SELECT * FROM locacao_manutencao_planos WHERE id = ?').get(info.lastInsertRowid),
      });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.delete('/api/locacao/manutencao/planos/:id', gateFlag, (req, res) => {
    try {
      const n = db.prepare('UPDATE locacao_manutencao_planos SET ativo = 0 WHERE id = ? AND ativo = 1')
        .run(Number(req.params.id)).changes;
      if (!n) return res.status(404).json({ success: false, error: 'plano não encontrado ou já inativo' });
      res.json({ success: true });
    } catch (err) {
      falhar(res, err);
    }
  });

  // Leitura avulsa: a máquina que não saiu também acumula hora.
  app.post('/api/locacao/manutencao/leitura', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const produtoId = Number(b.produtoId);
      if (!produtoId) return res.status(400).json({ success: false, error: 'produtoId é obrigatório' });
      if (!(Number(b.valor) >= 0)) {
        return res.status(400).json({ success: false, error: 'valor da leitura inválido' });
      }
      const anterior = leituraAtual(db, produtoId, b.serialNumberId || null);
      // Medidor não anda para trás. Aceitar isso apagaria horas de uso.
      if (anterior != null && Number(b.valor) < anterior) {
        return res.status(400).json({
          success: false,
          error: `leitura menor que a anterior (${anterior}) — o medidor não retrocede`,
        });
      }
      db.prepare(`INSERT INTO locacao_medidor_leituras
                    (produtoId, serialNumberId, contratoId, tipo, valor, origem, usuario)
                  VALUES (?, ?, ?, ?, ?, 'manual', ?)`)
        .run(produtoId, b.serialNumberId || null, b.contratoId || null,
             b.tipo || 'horimetro', Number(b.valor), (req.user && req.user.username) || null);
      res.json({ success: true, atual: leituraAtual(db, produtoId, b.serialNumberId || null) });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.post('/api/locacao/manutencao/planos/:id/executar', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      const r = executarManutencao(db, Number(req.params.id), {
        inicio: b.inicio, fim: b.fim, clienteId: b.clienteId,
        usuario: (req.user && req.user.username),
      });
      try { logAction(db, req, 'manutencao', 'locacao_plano', Number(req.params.id), { osId: r.os.id }); } catch (_) {}
      res.json({ success: true, ...r });
    } catch (err) {
      falhar(res, err);
    }
  });

  // ── Indicadores ──

  app.get('/api/locacao/painel/ocupacao', gateFlag, (req, res) => {
    try {
      const { de, ate, produtoId, categoria } = req.query;
      if (!de || !ate) return res.status(400).json({ success: false, error: 'de e ate são obrigatórios' });
      const r = ocupacao(db, de, ate, { produtoId, categoria });
      if (!r.ok) return res.status(400).json({ success: false, error: r.erro });
      res.json({ success: true, ...r });
    } catch (err) {
      falhar(res, err);
    }
  });

  app.get('/api/locacao/painel/ranking', gateFlag, (req, res) => {
    try {
      const { de, ate, categoria } = req.query;
      if (!de || !ate) return res.status(400).json({ success: false, error: 'de e ate são obrigatórios' });
      const r = ranking(db, de, ate, { categoria });
      if (!r.ok) return res.status(400).json({ success: false, error: r.erro });
      res.json({ success: true, ...r });
    } catch (err) {
      falhar(res, err);
    }
  });
}

module.exports = {
  registrarRotasLocacao,
  initLocacaoSchema,
  getFlag,
  lerConfig,
  gravarConfig,
  CONFIG_DEFAULTS,
};
