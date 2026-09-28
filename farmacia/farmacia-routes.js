/**
 * farmacia-routes.js — Módulo Farmácia (drogaria), fase 0: fundação.
 *
 * Escopo do módulo: drogaria. Manipulação (RDC 67/2007) está fora por decisão
 * de projeto — ver docs/modulo-farmacia-plano-2026-08-26.md.
 *
 * Feature flag por-tenant em config('farmacia_enabled'). Quando off,
 * /api/farmacia/* devolve 403 com error:'farmacia_disabled' — mesmo contrato
 * dos módulos Ótica e Restaurante. O module-gate do plano é uma segunda
 * camada, anterior a esta (plano não contratado nem chega aqui).
 *
 * Config do módulo mora na tabela `config` com prefixo `farmacia_`:
 *   farmacia_coluna_pmc         alíquota da coluna de PMC da CMED ('19' = PA)
 *   farmacia_uf                 UF de referência do PMC
 *   farmacia_travar_pmc         1 = recusa venda acima do PMC (regime regulado)
 *   farmacia_bloquear_vencido   1 = recusa saída de lote vencido
 *   farmacia_exigir_receita     1 = controlado/antimicrobiano exige receita
 *   farmacia_sngpc_ambiente     homologacao | producao
 *   farmacia_sngpc_cnpj         CNPJ da farmácia no SNGPC
 */

const fs = require('fs');
const { ordemPt } = require('../ordem-pt');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { logAction } = require('../audit-log');
const { initFarmaciaSchema } = require('./farmacia-schema');
const { importarCmed } = require('./cmed-import');

// A lista da CMED tem ~12 MB e ~26 mil linhas. Vai para memória e de lá para um
// arquivo temporário: o parser do xlsx trabalha por caminho, não por buffer.
const uploadCmed = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

const TARJAS_VALIDAS = ['livre', 'vermelha', 'vermelha_retencao', 'preta'];
// Listas da Portaria SVS/MS 344/1998. NULL = não sujeito a controle especial.
const LISTAS_344 = ['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2', 'C3', 'C4', 'C5', 'D1', 'D2'];

const CONFIG_DEFAULTS = {
  // 19% é a alíquota interna do Pará. Fica em config, não no código, porque é
  // a primeira coisa que muda se aparecer cliente de outro estado.
  farmacia_coluna_pmc: '19',
  farmacia_uf: 'PA',
  farmacia_travar_pmc: '1',
  farmacia_bloquear_vencido: '1',
  farmacia_exigir_receita: '1',
  farmacia_sngpc_ambiente: 'homologacao',
  farmacia_sngpc_cnpj: '',
};

// Colunas de PMC publicadas pela CMED (conferidas na lista de 11/08/2026). A
// planilha traz uma coluna por alíquota de ICMS; a farmácia usa a do seu estado.
// A notação é a do arquivo — decimal com vírgula ('17,5'), não ponto.
// As variantes "ALC" (Áreas de Livre Comércio) existem no arquivo mas não entram
// aqui: nenhum município do PA é ALC, e escolher a coluna errada baixa o teto.
const COLUNAS_PMC_VALIDAS = ['0', '12', '17', '17,5', '18', '19', '19,5', '20', '20,5', '21', '22', '22,5', '23'];

const AMBIENTES_SNGPC = ['homologacao', 'producao'];

function getFlag(db) {
  try {
    const r = db.prepare("SELECT valor FROM config WHERE chave = 'farmacia_enabled'").get();
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

function registrarRotasFarmacia(app, db) {
  initFarmaciaSchema(db);

  // Em multi-tenant o db acima é o BOOT_STUB e a migração foi no-op. O schema
  // real de cada tenant vem do db-schema.js; este hook cobre o tenant que
  // ainda não passou por um boot completo (mesmo padrão de Ótica/Restaurante).
  const tenantsMigrados = new WeakSet();
  app.use('/api/farmacia', (req, res, next) => {
    try {
      const real = db.__real;
      if (real && !tenantsMigrados.has(real)) {
        initFarmaciaSchema(db);
        tenantsMigrados.add(real);
      }
      next();
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Read-only e SEM gate: a sidebar precisa saber se mostra o módulo.
  app.get('/api/farmacia/status', (req, res) => {
    res.json({ success: true, enabled: getFlag(db) });
  });

  function gateFlag(req, res, next) {
    if (!getFlag(db)) {
      return res.status(403).json({ success: false, error: 'farmacia_disabled' });
    }
    next();
  }

  // ==================== CONFIG ====================

  app.get('/api/farmacia/config', gateFlag, (req, res) => {
    try {
      res.json({
        success: true,
        config: lerConfig(db),
        colunasPmc: COLUNAS_PMC_VALIDAS,
        ambientesSngpc: AMBIENTES_SNGPC,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.put('/api/farmacia/config', gateFlag, (req, res) => {
    try {
      const b = req.body || {};
      if (b.farmacia_coluna_pmc != null && !COLUNAS_PMC_VALIDAS.includes(String(b.farmacia_coluna_pmc))) {
        return res.status(400).json({ success: false, error: 'coluna de PMC inválida' });
      }
      if (b.farmacia_sngpc_ambiente != null && !AMBIENTES_SNGPC.includes(b.farmacia_sngpc_ambiente)) {
        return res.status(400).json({ success: false, error: 'ambiente SNGPC inválido' });
      }
      if (b.farmacia_uf != null && !/^[A-Z]{2}$/.test(String(b.farmacia_uf))) {
        return res.status(400).json({ success: false, error: 'UF inválida' });
      }
      const tx = db.transaction(() => {
        for (const chave of Object.keys(CONFIG_DEFAULTS)) {
          if (b[chave] !== undefined) gravarConfig(db, chave, b[chave]);
        }
      });
      tx();
      try { logAction(db, req, 'update', 'farmacia_config', null, b); } catch (_) { /* */ }
      res.json({ success: true, config: lerConfig(db) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== CADASTRO FARMACÊUTICO ====================

  // Lista os produtos com spec farmacêutica. `q` casa descrição, substância,
  // EAN e registro — é a busca que o balcão precisa (princípio ativo inclusive).
  app.get('/api/farmacia/medicamentos', gateFlag, (req, res) => {
    try {
      const { q, tarja, controlados, semRegistro, tarjaOrigem, limit } = req.query;
      let sql = `
        SELECT s.*, p.sku, p.descricao, p.unidade, p.precoVenda, p.ncm, p.ativo,
               p.codigoBarras, v.competencia AS cmedCompetencia
        FROM farmacia_medicamento_specs s
        JOIN produtos p ON p.id = s.produtoId
        LEFT JOIN farmacia_cmed_versoes v ON v.id = s.cmedVersaoId
        WHERE 1=1`;
      const params = [];
      if (q) {
        sql += ` AND (LOWER(p.descricao) LIKE ? OR LOWER(s.substancia) LIKE ?
                      OR s.ean LIKE ? OR s.registroAnvisa LIKE ?)`;
        const t = '%' + String(q).toLowerCase() + '%';
        params.push(t, t, '%' + q + '%', '%' + q + '%');
      }
      if (tarja) { sql += ' AND s.tarja = ?'; params.push(tarja); }
      // Fila de curadoria: 'inferida' = deduzida da substância porque a CMED
      // trouxe "- (*)"; 'desconhecida' = nem isso foi possível.
      if (tarjaOrigem) { sql += ' AND COALESCE(s.tarjaOrigem, "desconhecida") = ?'; params.push(tarjaOrigem); }
      if (controlados === '1') sql += ' AND (s.listaPortaria344 IS NOT NULL OR s.antimicrobiano = 1)';
      if (semRegistro === '1') sql += ' AND (s.registroAnvisa IS NULL OR s.registroAnvisa = "") AND s.isentoRegistro = 0';
      sql += ` ORDER BY ${ordemPt('p.descricao')}, p.descricao LIMIT ?`;
      params.push(Number(limit) || 200);
      res.json({ success: true, items: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/farmacia/medicamentos/:produtoId', gateFlag, (req, res) => {
    try {
      const item = db.prepare(`
        SELECT s.*, p.sku, p.descricao, p.unidade, p.precoVenda, p.ncm, p.codigoBarras
        FROM farmacia_medicamento_specs s
        JOIN produtos p ON p.id = s.produtoId
        WHERE s.produtoId = ?`).get(req.params.produtoId);
      if (!item) return res.status(404).json({ success: false, error: 'produto sem cadastro farmacêutico' });
      res.json({ success: true, item });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Curadoria local. Existe porque a CMED não publica tudo o que a operação
  // precisa: lista da 344 e antimicrobiano são preenchidos aqui, e a
  // reimportação da CMED não sobrescreve nenhum dos dois.
  app.put('/api/farmacia/medicamentos/:produtoId', gateFlag, (req, res) => {
    try {
      const produtoId = Number(req.params.produtoId);
      const p = db.prepare('SELECT id FROM produtos WHERE id = ?').get(produtoId);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });

      const b = req.body || {};
      if (b.tarja != null && !TARJAS_VALIDAS.includes(b.tarja)) {
        return res.status(400).json({ success: false, error: 'tarja inválida' });
      }
      if (b.listaPortaria344 != null && b.listaPortaria344 !== '' && !LISTAS_344.includes(String(b.listaPortaria344).toUpperCase())) {
        return res.status(400).json({ success: false, error: 'lista da Portaria 344 inválida' });
      }
      // A NF-e aceita cProdANVISA = 'ISENTO', mas aí exige o motivo. Recusar
      // aqui é mais barato do que descobrir na rejeição 840 da SEFAZ.
      const isento = b.isentoRegistro != null ? (Number(b.isentoRegistro) ? 1 : 0) : null;
      if (isento === 1 && !String(b.motivoIsencao || '').trim()) {
        return res.status(400).json({ success: false, error: 'isenção de registro exige o motivo (número da decisão)' });
      }

      const atual = db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(produtoId);
      if (!atual) {
        db.prepare('INSERT INTO farmacia_medicamento_specs (produtoId) VALUES (?)').run(produtoId);
      }

      const campos = ['registroAnvisa', 'isentoRegistro', 'motivoIsencao', 'ean', 'substancia',
        'classeTerapeutica', 'laboratorio', 'apresentacao', 'tarja', 'listaCmed',
        'regimePreco', 'pf', 'pmc', 'restricaoHospitalar', 'listaPortaria344',
        'antimicrobiano', 'tipoProduto'];
      // Tarja mexida à mão vira curadoria e passa a resistir à reimportação da
      // CMED — é o dado que a lista mais deixa em branco.
      if (b.tarja !== undefined) {
        db.prepare("UPDATE farmacia_medicamento_specs SET tarjaOrigem = 'manual' WHERE produtoId = ?").run(produtoId);
      }
      const sets = [], vals = [];
      for (const c of campos) {
        if (b[c] === undefined) continue;
        sets.push(`${c} = ?`);
        if (c === 'listaPortaria344') vals.push(b[c] ? String(b[c]).toUpperCase() : null);
        else if (['isentoRegistro', 'restricaoHospitalar', 'antimicrobiano'].includes(c)) vals.push(Number(b[c]) ? 1 : 0);
        else vals.push(b[c] === '' ? null : b[c]);
      }
      if (sets.length) {
        vals.push(produtoId);
        db.prepare(`UPDATE farmacia_medicamento_specs SET ${sets.join(', ')}, atualizadoEm = datetime('now') WHERE produtoId = ?`).run(...vals);
      }
      try { logAction(db, req, 'update', 'farmacia_medicamento', produtoId, b); } catch (_) { /* */ }
      res.json({
        success: true,
        item: db.prepare('SELECT * FROM farmacia_medicamento_specs WHERE produtoId = ?').get(produtoId),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== BALCÃO ====================

  // Genérico e similar da mesma substância: é a troca que o balcão oferece.
  // Ordenado por preço porque o motivo da troca, para o cliente, é esse.
  app.get('/api/farmacia/equivalentes/:produtoId', gateFlag, (req, res) => {
    try {
      const spec = db.prepare('SELECT substancia, apresentacao FROM farmacia_medicamento_specs WHERE produtoId = ?')
        .get(req.params.produtoId);
      if (!spec || !spec.substancia) {
        return res.json({ success: true, substancia: null, items: [] });
      }
      const items = db.prepare(`
        SELECT p.id AS produtoId, p.sku, p.descricao, p.precoVenda, p.unidade,
               s.tipoProduto, s.laboratorio, s.pmc, s.apresentacao, s.tarja
        FROM farmacia_medicamento_specs s
        JOIN produtos p ON p.id = s.produtoId
        WHERE s.substancia = ? AND p.ativo = 1 AND p.id <> ?
        ORDER BY p.precoVenda ASC LIMIT 20`).all(spec.substancia, Number(req.params.produtoId));
      res.json({ success: true, substancia: spec.substancia, apresentacao: spec.apresentacao, items });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Conferência de preço contra o teto da CMED. O balcão chama antes de fechar;
  // a emissão chama de novo, porque a tela pode ser contornada.
  app.post('/api/farmacia/preco/conferir', gateFlag, (req, res) => {
    try {
      const { conferirPmc } = require('./preco');
      const cfg = lerConfig(db);
      const r = conferirPmc(db, req.body?.itens || [], { travar: cfg.farmacia_travar_pmc !== '0' });
      res.json({ success: true, ...r, liberado: r.erros.length === 0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== SNGPC ====================

  app.get('/api/farmacia/sngpc/pendentes', gateFlag, (req, res) => {
    try {
      const { pendentes } = require('./sngpc-eventos');
      const { dataInicio, dataFim } = req.query;
      const eventos = pendentes(db, { dataInicio, dataFim });
      res.json({
        success: true,
        eventos,
        resumo: eventos.reduce((a, e) => { a[e.tipoMovimento] = (a[e.tipoMovimento] || 0) + 1; return a; }, {}),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/farmacia/sngpc/transmissoes', gateFlag, (req, res) => {
    try {
      res.json({
        success: true,
        items: db.prepare(`SELECT id, tipo, periodoInicio, periodoFim, ambiente, md5, status,
                                  protocolo, critica, tentativas, criadoEm, transmitidoEm
                           FROM farmacia_sngpc_transmissoes ORDER BY id DESC LIMIT 100`).all(),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/farmacia/sngpc/transmissoes/:id/xml', gateFlag, (req, res) => {
    try {
      const t = db.prepare('SELECT tipo, xml FROM farmacia_sngpc_transmissoes WHERE id = ?').get(req.params.id);
      if (!t || !t.xml) return res.status(404).json({ success: false, error: 'XML não disponível' });
      res.setHeader('Content-Type', 'application/xml; charset=iso-8859-1');
      res.setHeader('Content-Disposition', `attachment; filename="sngpc-${t.tipo}-${req.params.id}.xml"`);
      res.send(t.xml);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Gera o XML e guarda como transmissão pendente. Separado do envio de
  // propósito: o RT precisa poder conferir o arquivo antes de transmitir.
  app.post('/api/farmacia/sngpc/gerar', gateFlag, (req, res) => {
    try {
      const { montarInventario, montarMovimentacao } = require('./sngpc-xml');
      const { pendentes, marcarTransmitidos } = require('./sngpc-eventos');
      const cfg = lerConfig(db);
      const b = req.body || {};
      const tipo = b.tipo === 'inventario' ? 'inventario' : 'movimentacao';
      const cnpjEmissor = b.cnpjEmissor || cfg.farmacia_sngpc_cnpj;
      const cpfTransmissor = b.cpfTransmissor;

      let xml, periodoInicio = null, periodoFim = null, idsEventos = [];

      if (tipo === 'inventario') {
        // Fotografia do estoque de controlados: todo lote com saldo.
        const itens = db.prepare(`
          SELECT l.numero AS loteNumero, l.saldoAtual AS quantidade,
                 p.descricao, p.unidade, s.registroAnvisa, s.antimicrobiano
          FROM lotes l
          JOIN produtos p ON p.id = l.produtoId
          JOIN farmacia_medicamento_specs s ON s.produtoId = l.produtoId
          WHERE l.ativo = 1 AND l.saldoAtual > 0
            AND (s.listaPortaria344 IS NOT NULL OR s.antimicrobiano = 1)
          ORDER BY ${ordemPt('p.descricao')}, p.descricao`).all();
        periodoInicio = periodoFim = b.data || new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
        xml = montarInventario({ cnpjEmissor, cpfTransmissor, data: periodoInicio, itens });
      } else {
        periodoInicio = b.dataInicio;
        periodoFim = b.dataFim;
        const eventos = pendentes(db, { dataInicio: periodoInicio, dataFim: periodoFim });
        idsEventos = eventos.map(e => e.id);
        const receitaIds = [...new Set(eventos.map(e => e.receitaId).filter(Boolean))];
        const receitasPorId = new Map();
        for (const rid of receitaIds) {
          receitasPorId.set(rid, db.prepare('SELECT * FROM farmacia_receitas WHERE id = ?').get(rid));
        }
        xml = montarMovimentacao({
          cnpjEmissor, cpfTransmissor, dataInicio: periodoInicio, dataFim: periodoFim,
          eventos, receitasPorId,
        });
      }

      const { hashIdentificacao, compactarEBase64 } = require('./sngpc-api');
      const md5 = hashIdentificacao(compactarEBase64(xml));

      let id;
      db.transaction(() => {
        id = db.prepare(`INSERT INTO farmacia_sngpc_transmissoes
          (tipo, periodoInicio, periodoFim, ambiente, xml, md5, status)
          VALUES (?, ?, ?, ?, ?, ?, 'gerado')`).run(
          tipo, periodoInicio, periodoFim, cfg.farmacia_sngpc_ambiente, xml, md5).lastInsertRowid;
        if (idsEventos.length) marcarTransmitidos(db, idsEventos, id);
      })();

      try { logAction(db, req, 'gerar', 'farmacia_sngpc', id, { tipo, periodoInicio, periodoFim }); } catch (_) { /* */ }
      res.json({ success: true, id, tipo, md5, eventos: idsEventos.length, tamanho: xml.length });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Envia ao webservice da ANVISA. Exige credencial do RT Transmissor, que não
  // fica gravada: é digitada no momento do envio (acesso pessoal e
  // intransferível do farmacêutico responsável).
  app.post('/api/farmacia/sngpc/transmissoes/:id/enviar', gateFlag, async (req, res) => {
    try {
      const { enviarArquivo } = require('./sngpc-api');
      const { devolverAFila } = require('./sngpc-eventos');
      const cfg = lerConfig(db);
      const t = db.prepare('SELECT * FROM farmacia_sngpc_transmissoes WHERE id = ?').get(req.params.id);
      if (!t) return res.status(404).json({ success: false, error: 'transmissão não encontrada' });
      if (t.status === 'aceito') return res.status(400).json({ success: false, error: 'arquivo já aceito pela ANVISA' });

      const email = (req.body?.email || '').trim();
      const senha = req.body?.senha || '';
      if (!email || !senha) {
        return res.status(400).json({ success: false, error: 'informe e-mail e senha do RT Transmissor' });
      }

      const r = await enviarArquivo(t.ambiente || cfg.farmacia_sngpc_ambiente, {
        email, senha, xml: t.xml, nomeArquivo: `sngpc-${t.tipo}-${t.id}.xml`,
      });

      db.prepare(`UPDATE farmacia_sngpc_transmissoes
                  SET status = ?, critica = ?, md5 = ?, tentativas = tentativas + 1,
                      transmitidoEm = datetime('now')
                  WHERE id = ?`)
        .run(r.aceito ? 'aceito' : 'rejeitado', r.resposta || null, r.md5, t.id);

      // Rejeitado devolve os eventos à fila: senão a movimentação some do
      // próximo arquivo e o estoque declarado deixa de fechar.
      if (!r.aceito) devolverAFila(db, t.id);

      try { logAction(db, req, 'transmitir', 'farmacia_sngpc', t.id, { aceito: r.aceito }); } catch (_) { /* */ }
      res.json({ success: true, ...r });
    } catch (err) {
      const t = db.prepare('SELECT id FROM farmacia_sngpc_transmissoes WHERE id = ?').get(req.params.id);
      if (t) {
        db.prepare(`UPDATE farmacia_sngpc_transmissoes
                    SET status = 'erro', critica = ?, tentativas = tentativas + 1 WHERE id = ?`)
          .run(String(err.message).slice(0, 500), t.id);
        require('./sngpc-eventos').devolverAFila(db, t.id);
      }
      res.status(502).json({ success: false, error: err.message });
    }
  });

  // ==================== LOTE / FEFO ====================

  // O balcão pergunta qual lote vai sair antes de fechar a venda. Read-only:
  // quem baixa saldo é a emissão, dentro da transação da nota.
  app.get('/api/farmacia/fefo/:produtoId', gateFlag, (req, res) => {
    try {
      const { selecionarLotesFEFO, lotesDisponiveis } = require('./fefo');
      const produtoId = Number(req.params.produtoId);
      const quantidade = Number(req.query.quantidade) || 1;
      const bloquearVencido = lerConfig(db).farmacia_bloquear_vencido !== '0';

      const p = db.prepare('SELECT id, descricao, rastreiaLote FROM produtos WHERE id = ?').get(produtoId);
      if (!p) return res.status(404).json({ success: false, error: 'produto não encontrado' });
      if (!Number(p.rastreiaLote)) {
        return res.json({ success: true, rastreiaLote: false, alocacoes: [], faltante: 0, disponiveis: [] });
      }

      const { alocacoes, faltante } = selecionarLotesFEFO(db, produtoId, quantidade,
        { permitirVencido: !bloquearVencido });
      res.json({
        success: true,
        rastreiaLote: true,
        alocacoes,
        faltante,
        // Lista completa para o balcão poder trocar o lote à mão (recall, reserva).
        disponiveis: lotesDisponiveis(db, produtoId, { permitirVencido: !bloquearVencido }),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== RECEITAS ====================

  app.get('/api/farmacia/receitas', gateFlag, (req, res) => {
    try {
      const { q, tipo, limit } = req.query;
      let sql = `SELECT r.*, (SELECT COUNT(*) FROM farmacia_receita_itens i WHERE i.receitaId = r.id) AS qtdItens
                 FROM farmacia_receitas r WHERE 1=1`;
      const params = [];
      if (tipo) { sql += ' AND r.tipo = ?'; params.push(tipo); }
      if (q) {
        sql += ` AND (LOWER(r.pacienteNome) LIKE ? OR LOWER(r.prescritorNome) LIKE ? OR r.numero LIKE ?)`;
        const t = '%' + String(q).toLowerCase() + '%';
        params.push(t, t, '%' + q + '%');
      }
      sql += ' ORDER BY r.dataEmissao DESC, r.id DESC LIMIT ?';
      params.push(Number(limit) || 100);
      res.json({ success: true, items: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/farmacia/receitas/:id', gateFlag, (req, res) => {
    try {
      const { saldoDaReceita } = require('./receita');
      const receita = db.prepare('SELECT * FROM farmacia_receitas WHERE id = ?').get(req.params.id);
      if (!receita) return res.status(404).json({ success: false, error: 'receita não encontrada' });
      const itens = db.prepare(`
        SELECT i.*, p.descricao AS produtoDescricao, p.sku
        FROM farmacia_receita_itens i
        LEFT JOIN produtos p ON p.id = i.produtoId
        WHERE i.receitaId = ? ORDER BY i.id`).all(receita.id);
      // O saldo é o que impede a mesma receita de virar passe livre.
      for (const i of itens) {
        if (i.produtoId) Object.assign(i, saldoDaReceita(db, receita.id, i.produtoId));
      }
      res.json({ success: true, receita, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/farmacia/receitas', gateFlag, (req, res) => {
    try {
      const { TIPOS_RECEITA, camposObrigatorios, ehValida } = require('./receita');
      const b = req.body || {};
      if (!TIPOS_RECEITA[b.tipo]) {
        return res.status(400).json({ success: false, error: 'tipo de receita inválido' });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.dataEmissao || '').slice(0, 10))) {
        return res.status(400).json({ success: false, error: 'data de emissão obrigatória (AAAA-MM-DD)' });
      }
      const faltando = camposObrigatorios(b);
      if (faltando.length) {
        return res.status(400).json({ success: false, error: 'falta ' + faltando.join(', ') });
      }
      const venc = ehValida(b);
      if (venc) return res.status(400).json({ success: false, error: venc });

      const itens = Array.isArray(b.itens) ? b.itens : [];
      let id;
      db.transaction(() => {
        id = db.prepare(`INSERT INTO farmacia_receitas
          (tipo, numero, dataEmissao, uf, prescritorNome, prescritorConselho, prescritorConselhoUf,
           prescritorNumero, pacienteNome, pacienteDocumento, pacienteEndereco,
           compradorNome, compradorDocumento, compradorEndereco, observacoes, criadoPor)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          b.tipo, b.numero || null, String(b.dataEmissao).slice(0, 10), (b.uf || '').toUpperCase() || null,
          b.prescritorNome || null, (b.prescritorConselho || '').toUpperCase() || null,
          (b.prescritorConselhoUf || '').toUpperCase() || null, b.prescritorNumero || null,
          b.pacienteNome || null, b.pacienteDocumento || null, b.pacienteEndereco || null,
          b.compradorNome || null, b.compradorDocumento || null, b.compradorEndereco || null,
          b.observacoes || null, req.user?.username || null
        ).lastInsertRowid;

        const insItem = db.prepare(`INSERT INTO farmacia_receita_itens
          (receitaId, produtoId, descricao, quantidade, posologia) VALUES (?,?,?,?,?)`);
        for (const i of itens) {
          insItem.run(id, i.produtoId || null, i.descricao || null,
            Number(i.quantidade) || 1, i.posologia || null);
        }
      })();

      try { logAction(db, req, 'criar', 'farmacia_receita', id, { tipo: b.tipo }); } catch (_) { /* */ }
      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Simulação da dispensação: o balcão pergunta antes de fechar a venda o que
  // vai ser exigido e o que está faltando.
  app.post('/api/farmacia/dispensacao/validar', gateFlag, (req, res) => {
    try {
      const { validarDispensacao } = require('./receita');
      const b = req.body || {};
      const r = validarDispensacao(db, b.itens || [], b.receitaId || null);
      res.json({ success: true, ...r, liberado: r.erros.length === 0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== LISTA CMED ====================

  app.get('/api/farmacia/cmed/versoes', gateFlag, (req, res) => {
    try {
      res.json({
        success: true,
        items: db.prepare('SELECT * FROM farmacia_cmed_versoes ORDER BY competencia DESC').all(),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/farmacia/cmed/naocasados', gateFlag, (req, res) => {
    try {
      const { versaoId, limit } = req.query;
      let sql = 'SELECT * FROM farmacia_cmed_naocasados WHERE 1=1';
      const params = [];
      if (versaoId) { sql += ' AND cmedVersaoId = ?'; params.push(versaoId); }
      sql += ' ORDER BY produto ASC LIMIT ?';
      params.push(Number(limit) || 200);
      res.json({ success: true, items: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/farmacia/cmed/importar', gateFlag, uploadCmed.single('arquivo'), (req, res) => {
    let tmp = null;
    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({ success: false, error: 'envie a planilha da CMED no campo "arquivo"' });
      }
      const cfg = lerConfig(db);
      const colunaPmc = String(req.body?.colunaPmc || cfg.farmacia_coluna_pmc);
      const uf = String(req.body?.uf || cfg.farmacia_uf);
      const competencia = String(req.body?.competencia || '').trim() || undefined;

      tmp = path.join(os.tmpdir(), `cmed-${Date.now()}-${process.pid}.xlsx`);
      fs.writeFileSync(tmp, req.file.buffer);

      const r = importarCmed(db, tmp, {
        colunaPmc, uf, competencia,
        arquivoNome: req.file.originalname,
        usuario: req.user?.username || null,
      });
      try { logAction(db, req, 'importar', 'farmacia_cmed', r.versaoId, r); } catch (_) { /* */ }
      res.json({ success: true, ...r });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch (_) { /* */ } }
    }
  });
}

module.exports = {
  registrarRotasFarmacia,
  migrarDB: initFarmaciaSchema,
  getFlag,
  lerConfig,
  gravarConfig,
  CONFIG_DEFAULTS,
  COLUNAS_PMC_VALIDAS,
  TARJAS_VALIDAS,
  LISTAS_344,
};
