/**
 * contratos-routes.js — Contratos com clientes (vigência, renovação, reajuste).
 *
 * Modelo:
 *   contratos        — cabeçalho (cliente, valor mensal, vigência, renovação, reajuste, status)
 *   contratos_eventos — histórico (criação/renovação/reajuste/suspensão/encerramento/aditivo)
 *   contratos_itens  — o que o contrato cobre (informativo)
 *   contratos_anexos — o documento assinado, aditivos, procurações
 *
 * Status: ativo | suspenso | encerrado | em-renovacao
 */

const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { logAction } = require('./audit-log');
const { reentrarContextoTenant } = require('./tenant-middleware');
const { comTratamentoDeErro, nomeOriginalUtf8 } = require('./upload-anexos');

const STATUS = ['ativo', 'suspenso', 'encerrado', 'em-renovacao'];
// `correcao` é o conserto de um cadastro errado — digitou 900 mensal onde era
// anual. NÃO é reajuste: o valor não mudou no mundo real, só a linha estava
// errada. Ficam separados porque o reajuste conta a história comercial do
// contrato e a correção contaria uma história falsa.
const TIPOS_EVENTO = ['criacao', 'renovacao', 'reajuste', 'suspensao', 'reativacao', 'encerramento', 'aditivo', 'correcao'];
// Espelham os eventos do contrato: o aditivo registrado no histórico costuma
// ter um PDF correspondente, e é útil achá-lo pelo tipo.
const TIPOS_ANEXO = ['contrato', 'aditivo', 'distrato', 'proposta', 'procuracao', 'outro'];

// Nem todo contrato é mensal (2026-08-20). `valorMensal` passa a significar
// "valor do período": num contrato anual é o valor do ano. Só o cálculo de
// receita recorrente normaliza para mês — o resto usa o valor como está.
const PERIODICIDADES = ['mensal', 'anual'];
const MESES_POR_PERIODO = { mensal: 1, anual: 12 };

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contratos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      clienteId INTEGER NOT NULL,
      descricao TEXT NOT NULL,
      valorMensal REAL NOT NULL,
      diaVencimento INTEGER DEFAULT 10,
      dataInicio TEXT NOT NULL,
      dataFim TEXT,
      renovacaoAutomatica INTEGER DEFAULT 1,
      prazoRenovacaoMeses INTEGER DEFAULT 12,
      indiceReajuste TEXT,
      percentualReajuste REAL,
      dataProximoReajuste TEXT,
      recorrenciaNfseId INTEGER,
      status TEXT NOT NULL DEFAULT 'ativo',
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (clienteId) REFERENCES pessoas(id),
      FOREIGN KEY (recorrenciaNfseId) REFERENCES nfse_recorrencias(id)
    );
    CREATE INDEX IF NOT EXISTS idx_contratos_cliente ON contratos(clienteId);
    CREATE INDEX IF NOT EXISTS idx_contratos_status ON contratos(status, dataFim);

    CREATE TABLE IF NOT EXISTS contratos_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      descricao TEXT,
      valorAntes REAL,
      valorDepois REAL,
      dataFimAntes TEXT,
      dataFimDepois TEXT,
      usuario TEXT,
      FOREIGN KEY (contratoId) REFERENCES contratos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_eventos_contrato ON contratos_eventos(contratoId, data);

    -- Itens do contrato: o que ele cobre, por produto do catálogo. São
    -- INFORMATIVOS por decisão de projeto — não recalculam valorMensal, que
    -- continua digitado à mão (há desconto de pacote que a soma não expressa).
    CREATE TABLE IF NOT EXISTS contratos_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      produtoId INTEGER,
      descricao TEXT NOT NULL,
      quantidade REAL NOT NULL DEFAULT 1,
      valorUnitario REAL,
      periodicidade TEXT DEFAULT 'mensal',
      observacoes TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contratoId) REFERENCES contratos(id) ON DELETE CASCADE,
      FOREIGN KEY (produtoId) REFERENCES produtos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_contratos_itens ON contratos_itens(contratoId);

    -- O contrato assinado, o aditivo, a procuração: o documento que prova o
    -- que está cadastrado aqui. Mesmo formato dos anexos de CP/CR/OS —
    -- arquivo em public/uploads/contratos/<id>/ e a linha aponta o caminho
    -- relativo.
    CREATE TABLE IF NOT EXISTS contratos_anexos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contratoId INTEGER NOT NULL,
      nomeOriginal TEXT NOT NULL,
      caminho TEXT NOT NULL,
      mimeType TEXT,
      tamanho INTEGER,
      tipo TEXT,
      dataUpload TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contratoId) REFERENCES contratos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_contratos_anexos ON contratos_anexos(contratoId);
  `);

  // Coluna acrescentada depois: bases antigas precisam do ALTER.
  try {
    db.exec("ALTER TABLE contratos ADD COLUMN periodicidade TEXT NOT NULL DEFAULT 'mensal'");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  // De qual item de contrato veio a compra. Sem isso, o pedido de compra não
  // sabe qual necessidade ele atende, e o contador de emissões do contrato não
  // teria como acompanhar o que foi comprado.
  try {
    db.exec('ALTER TABLE pedidos_compra ADD COLUMN contratoItemId INTEGER');
  } catch (err) {
    if (!/duplicate column|no such table/i.test(err.message)) throw err;
  }
}

// ==================== MULTER (anexos) ====================
// Mesmo desenho do anexo de CP: um diretório por contrato, nome de arquivo
// higienizado e prefixado por timestamp (dois PDFs com o mesmo nome não se
// sobrescrevem), teto de 10 MB.

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'contratos');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const uploadAnexo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, String(req.params.id));
      // O erro TEM de ir pelo callback. Um throw aqui não é pego por
      // ninguém — vira uncaughtException e derruba o servidor inteiro, e foi
      // o que aconteceu em 2026-08-20 com o diretório de upload pertencendo a
      // outro usuário (EACCES no mkdir).
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return cb(err);
      }
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
      const safe = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40);
      cb(null, `${Date.now()}-${safe}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    // Contrato assinado costuma vir em PDF, mas foto de página assinada e
    // .docx do jurídico também aparecem.
    //
    // Quem decide é a EXTENSÃO, não o mimetype. O mimetype vem do cliente e
    // não é confiável: navegador e curl mandam application/octet-stream para
    // qualquer coisa, então aceitá-lo deixava passar um .exe.
    const ok = /\.(pdf|png|jpg|jpeg|webp|doc|docx)$/i.test(file.originalname);
    cb(ok ? null : new Error('Apenas PDF, imagem ou documento do Word'), ok);
  }
});

// Quantos arquivos por envio. Contrato assinado + aditivos + procuração numa
// tacada só é o caso comum; o teto existe para um clique errado em "selecionar
// tudo" não virar 400 uploads.
const MAX_ARQUIVOS = 20;

function gerarNumero(db) {
  const ano = new Date().getFullYear();
  const prefixo = `CT-${ano}-`;
  const ultimo = db.prepare(`SELECT numero FROM contratos WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(prefixo + '%');
  let n = 1;
  if (ultimo) {
    const m = ultimo.numero.match(/-(\d+)$/);
    if (m) n = parseInt(m[1], 10) + 1;
  }
  return prefixo + String(n).padStart(4, '0');
}

function addMeses(dataIso, meses) {
  if (!dataIso) return null;
  const [y, m, d] = dataIso.split('-').map(Number);
  const novaData = new Date(y, m - 1 + meses, d);
  return novaData.toISOString().slice(0, 10);
}

/**
 * O tenant contratou o módulo de certificados SSL?
 *
 * A tabela existir não basta: o schema é aplicado igual em todos os tenants,
 * então `ssl_certificados` existe até para quem nunca contratou o add-on.
 * A fonte de verdade é a feature, a mesma que o menu usa.
 */
function temModuloSsl(db) {
  try {
    const row = db.prepare("SELECT valor FROM config WHERE chave = 'ssl_enabled'").get();
    return !!(row && row.valor === '1');
  } catch (_) {
    return false;
  }
}

/**
 * Meses de vigência do contrato. Prefere as datas; sem dataFim, cai no prazo
 * de renovação (que é o ciclo que o contrato repete).
 */
function mesesDeVigencia(contrato) {
  if (contrato.dataInicio && contrato.dataFim) {
    const [ay, am] = contrato.dataInicio.split('-').map(Number);
    const [by, bm] = contrato.dataFim.split('-').map(Number);
    const meses = (by - ay) * 12 + (bm - am);
    if (meses > 0) return meses;
  }
  return Number(contrato.prazoRenovacaoMeses) || 12;
}

/**
 * Quantas vezes cada item precisa ser comprado ao longo da vigência, e quantas
 * já foram.
 *
 * Isto NÃO é a quantidade digitada. `quantidade` é quantos certificados
 * coexistem (dois domínios distintos = 2); as repetições ao longo do tempo
 * saem da vigência dividida pela periodicidade do item. Um contrato de 36
 * meses com item anual são 3 compras — digitar 3 na quantidade contaria o
 * custo de três anos como se fosse de um só.
 *
 * Vale para SSL porque cada compra cobre uma assinatura; os reissues dentro
 * dela (o teto de ~200 dias) são gratuitos e não contam como emissão nova.
 */
function itensComEmissoes(db, contrato) {
  const meses = mesesDeVigencia(contrato);
  // O módulo SSL é add-on por tenant. As tabelas ssl_* existem em todos (o
  // schema é aplicado igual para todo mundo), então a presença delas NÃO diz
  // se o tenant contratou o módulo — quem diz é a feature. Sem ela, a tela de
  // contrato não deve sequer saber que "emitir certificado" existe.
  const sslAtivo = temModuloSsl(db);

  let itens;
  if (sslAtivo) {
    itens = db.prepare(`
      SELECT i.*, p.sku AS produtoSku, p.precoCusto AS produtoCusto,
             s.code AS sslProductCode, s.maxYear AS sslMaxYear
      FROM contratos_itens i
      LEFT JOIN produtos p ON p.id = i.produtoId
      LEFT JOIN ssl_produtos_nicsrs s ON s.produtoId = i.produtoId
      WHERE i.contratoId = ? ORDER BY i.id
    `).all(contrato.id);
  } else {
    itens = db.prepare(`
      SELECT i.*, p.sku AS produtoSku, p.precoCusto AS produtoCusto
      FROM contratos_itens i
      LEFT JOIN produtos p ON p.id = i.produtoId
      WHERE i.contratoId = ? ORDER BY i.id
    `).all(contrato.id);
  }

  // Conta COMPRAS, não registros.
  //
  // `cancelado` sai porque a compra foi estornada. `substituido` também sai, e
  // esse é o caso sutil: são os registros que a NicSRS mantém de cada reissue
  // anterior, trazidos pela importação. Um domínio reemitido duas vezes chega
  // como 3 linhas (1 vigente + 2 substituídas) vindas de UMA única compra —
  // contá-las infla o consumo do contrato. Reissue feito por aqui não cria
  // linha nova (atualiza o certId da existente), então este filtro serve aos
  // dois casos.
  let porItem = new Map();
  if (sslAtivo) {
    try {
      const linhas = db.prepare(`
        SELECT contratoItemId, COUNT(*) AS total
        FROM ssl_certificados
        WHERE contratoId = ? AND contratoItemId IS NOT NULL
          AND status NOT IN ('cancelado', 'substituido')
        GROUP BY contratoItemId
      `).all(contrato.id);
      porItem = new Map(linhas.map(l => [l.contratoItemId, l.total]));
    } catch (_) {
      // Base sem as tabelas do módulo: segue sem contagem.
    }
  }

  return itens.map(i => {
    const mesesItem = i.periodicidade === 'anual' ? 12 : (i.periodicidade === 'unico' ? null : 1);
    const ciclos = mesesItem ? Math.ceil(meses / mesesItem) : 1;
    const previstas = ciclos * (Number(i.quantidade) || 1);
    const realizadas = porItem.get(i.id) || 0;
    return {
      ...i,
      ciclosNaVigencia: ciclos,
      // Sem o módulo, a contagem de emissões não faz sentido nenhum e a tela
      // não deve montar a coluna.
      emissoesPrevistas: sslAtivo ? previstas : null,
      emissoesRealizadas: sslAtivo ? realizadas : null,
      emissoesRestantes: sslAtivo ? Math.max(0, previstas - realizadas) : null,
    };
  });
}

function registrarRotasContratos(app, db) {
  migrarDB(db);

  // ==================== LISTAGEM ====================

  app.get('/api/contratos', (req, res) => {
    try {
      const { clienteId, status, q, limit } = req.query;
      let sql = `
        SELECT c.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj
        FROM contratos c
        JOIN pessoas p ON p.id = c.clienteId
        WHERE 1=1
      `;
      const params = [];
      if (clienteId) { sql += ' AND c.clienteId = ?'; params.push(Number(clienteId)); }
      if (status)    { sql += ' AND c.status = ?';    params.push(status); }
      if (q) { sql += ' AND (c.numero LIKE ? OR c.descricao LIKE ? OR p.razaoSocial LIKE ?)'; const like = `%${q}%`; params.push(like, like, like); }
      sql += ' ORDER BY c.id DESC LIMIT ?';
      params.push(Number(limit) || 200);
      const contratos = db.prepare(sql).all(...params);
      // KPIs
      const totais = db.prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status='ativo' THEN 1 ELSE 0 END) AS ativos,
          -- Contrato anual guarda o valor do ANO: somá-lo cru inflaria o MRR
          -- em 12x. Normaliza para mês antes de somar.
          SUM(CASE WHEN status='ativo'
                   THEN valorMensal / (CASE WHEN periodicidade='anual' THEN 12.0 ELSE 1.0 END)
                   ELSE 0 END) AS receitaMensalRecorrente,
          SUM(CASE WHEN status='ativo' AND dataFim IS NOT NULL AND date(dataFim) <= date('now', '+30 days') THEN 1 ELSE 0 END) AS vencendo30d
        FROM contratos
      `).get();
      res.json({ success: true, contratos, kpis: totais, status: STATUS });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Detalhe + eventos
  app.get('/api/contratos/:id', (req, res) => {
    try {
      const c = db.prepare(`
        SELECT c.*, p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj
        FROM contratos c
        JOIN pessoas p ON p.id = c.clienteId
        WHERE c.id = ?
      `).get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Contrato não encontrado' });
      const eventos = db.prepare('SELECT * FROM contratos_eventos WHERE contratoId = ? ORDER BY data DESC, id DESC').all(c.id);
      // Integração (4): retorna a recorrência vinculada para o front
      // mostrar bloco "Faturamento" sem fazer 2ª chamada.
      let recorrencia = null;
      if (c.recorrenciaNfseId) {
        // nfse_recorrencias_log não tem coluna dataEmissao e o status
        // gravado é 'sucesso' (não 'emitida') — a query antiga estourava
        // e o catch devolvia null, então o bloco Faturamento nunca
        // aparecia mesmo com recorrência vinculada. Mesmos critérios de
        // GET /api/recorrencias, para os dois painéis não divergirem.
        try {
          recorrencia = db.prepare(`
            SELECT r.*,
              (SELECT competencia FROM nfse_recorrencias_log
                WHERE recorrenciaId = r.id AND status = 'sucesso'
                ORDER BY competencia DESC LIMIT 1) AS ultimaEmissao,
              (SELECT COUNT(*) FROM nfse_recorrencias_log
                WHERE recorrenciaId = r.id AND status = 'sucesso') AS totalEmissoes
            FROM nfse_recorrencias r WHERE r.id = ?
          `).get(c.recorrenciaNfseId);
        } catch (_) {
          // Tenant sem a tabela de log: devolve a recorrência sem os
          // agregados em vez de sumir com ela da tela.
          try {
            recorrencia = db.prepare('SELECT * FROM nfse_recorrencias WHERE id = ?').get(c.recorrenciaNfseId);
          } catch (__) { /* tenant sem o módulo de recorrências */ }
        }
      }
      const itens = itensComEmissoes(db, c);
      res.json({ success: true, contrato: c, eventos, recorrencia, itens, mesesVigencia: mesesDeVigencia(c) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== ITENS DO CONTRATO ====================
  //
  // O que o contrato cobre, por produto do catálogo. Informativo: não altera
  // valorMensal — o valor cobrado continua sendo decisão de quem fecha o
  // contrato, inclusive quando há desconto de pacote.

  app.get('/api/contratos/:id/itens', (req, res) => {
    try {
      const contrato = db.prepare('SELECT * FROM contratos WHERE id = ?').get(Number(req.params.id));
      if (!contrato) return res.status(404).json({ success: false, error: 'Contrato não encontrado' });
      const itens = itensComEmissoes(db, contrato);
      const soma = itens.reduce((t, i) => t + (Number(i.valorUnitario) || 0) * (Number(i.quantidade) || 0), 0);
      res.json({ success: true, itens, somaItens: Number(soma.toFixed(2)), mesesVigencia: mesesDeVigencia(contrato) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/itens', (req, res) => {
    try {
      const contratoId = Number(req.params.id);
      const contrato = db.prepare('SELECT id, numero FROM contratos WHERE id = ?').get(contratoId);
      if (!contrato) return res.status(404).json({ success: false, error: 'Contrato não encontrado' });

      const { produtoId, quantidade, valorUnitario, periodicidade, observacoes } = req.body;
      let descricao = req.body.descricao;
      // Com produto do catálogo, a descrição vem dele — evita item órfão
      // descrito de um jeito no contrato e de outro no catálogo.
      if (produtoId) {
        const p = db.prepare('SELECT id, descricao, precoVenda FROM produtos WHERE id = ?').get(Number(produtoId));
        if (!p) return res.status(404).json({ success: false, error: `Produto #${produtoId} não encontrado` });
        if (!descricao) descricao = p.descricao;
      }
      if (!descricao) return res.status(400).json({ success: false, error: 'Informe um produto ou uma descrição' });

      const r = db.prepare(`
        INSERT INTO contratos_itens (contratoId, produtoId, descricao, quantidade, valorUnitario, periodicidade, observacoes)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(contratoId, produtoId ? Number(produtoId) : null, descricao,
             Number(quantidade) || 1,
             valorUnitario != null ? Number(valorUnitario) : null,
             periodicidade || 'mensal', observacoes || null);
      logAction(db, req, 'adicionar-item', 'contrato', contratoId, { itemId: r.lastInsertRowid, descricao });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  /**
   * Gera um pedido de compra a partir de um item do contrato.
   *
   * A compra nasce da necessidade registrada no contrato e segue pelo fluxo
   * normal de Compras (rascunho -> enviar, com alçada). Vale para qualquer
   * produto do item, não só certificados — o item é que diz o que comprar.
   */
  app.post('/api/contratos/:id/itens/:itemId/pedido-compra', (req, res) => {
    try {
      const item = db.prepare(`
        SELECT i.*, c.numero AS contratoNumero, p.descricao AS produtoDescricao, p.precoCusto
        FROM contratos_itens i
        JOIN contratos c ON c.id = i.contratoId
        LEFT JOIN produtos p ON p.id = i.produtoId
        WHERE i.id = ? AND i.contratoId = ?
      `).get(Number(req.params.itemId), Number(req.params.id));
      if (!item) return res.status(404).json({ success: false, error: 'Item de contrato não encontrado' });
      if (!item.produtoId) {
        return res.status(400).json({ success: false, error: 'Item sem produto do catálogo — não há o que comprar' });
      }

      // Fornecedor: o do produto. Sem ele o pedido não tem para quem ir.
      const produto = db.prepare('SELECT fornecedorId FROM produtos WHERE id = ?').get(item.produtoId);
      const fornecedorId = produto && produto.fornecedorId;
      if (!fornecedorId) {
        return res.status(400).json({ success: false, error: 'Produto sem fornecedor cadastrado' });
      }

      const quantidade = Number(req.body.quantidade) || 1;
      const custoUnitario = req.body.custoUnitario != null
        ? Number(req.body.custoUnitario)
        : (Number(item.valorUnitario) || Number(item.precoCusto) || 0);

      const ano = new Date().getFullYear();
      const ultimo = db.prepare(`SELECT numero FROM pedidos_compra WHERE numero LIKE ? ORDER BY id DESC LIMIT 1`).get(`PC-${ano}-%`);
      let seq = 1;
      if (ultimo) {
        const m = String(ultimo.numero).match(/-(\d+)$/);
        if (m) seq = parseInt(m[1], 10) + 1;
      }
      const numero = `PC-${ano}-${String(seq).padStart(4, '0')}`;

      let pedidoId;
      db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO pedidos_compra
            (numero, fornecedorId, status, dataEmissao, valorTotal, observacoes, usuarioCriador, contratoItemId)
          VALUES (?, ?, 'rascunho', ?, ?, ?, ?, ?)
        `).run(numero, fornecedorId, new Date().toISOString().slice(0, 10),
               Number((custoUnitario * quantidade).toFixed(2)),
               `Contrato ${item.contratoNumero} · item: ${item.descricao}`,
               req.user?.username || null, item.id);
        pedidoId = r.lastInsertRowid;
        db.prepare(`
          INSERT INTO pedido_compra_itens (pedidoCompraId, produtoId, quantidade, custoUnitario, observacoes)
          VALUES (?, ?, ?, ?, ?)
        `).run(pedidoId, item.produtoId, quantidade, custoUnitario,
               `Contrato ${item.contratoNumero} — ${item.descricao}`);
      })();

      logAction(db, req, 'gerar-pedido-compra', 'contrato', Number(req.params.id),
        { itemId: item.id, pedidoCompraId: pedidoId, numero });
      res.json({ success: true, pedidoCompraId: pedidoId, numero, quantidade, custoUnitario });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/contratos/:id/itens/:itemId', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM contratos_itens WHERE id = ? AND contratoId = ?')
        .run(Number(req.params.itemId), Number(req.params.id));
      if (!r.changes) return res.status(404).json({ success: false, error: 'Item não encontrado' });
      logAction(db, req, 'remover-item', 'contrato', Number(req.params.id), { itemId: Number(req.params.itemId) });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ========== ANEXOS ==========

  app.get('/api/contratos/:id/anexos', (req, res) => {
    try {
      const anexos = db.prepare(
        'SELECT * FROM contratos_anexos WHERE contratoId = ? ORDER BY dataUpload DESC'
      ).all(Number(req.params.id));
      res.json({ success: true, anexos, tipos: TIPOS_ANEXO });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Aceita vários arquivos num envio só. O tipo vale para todos: quem manda
  // o contrato e dois aditivos de uma vez faz dois envios, e é mais rápido do
  // que responder o tipo arquivo por arquivo.
  // reentrarContextoTenant é obrigatório depois do multer: o busboy lê o corpo
  // por evento de stream e o AsyncLocalStorage não atravessa isso, então o
  // proxy do db estoura "currentDb() fora de contexto de tenant". Ver a nota
  // em tenant-middleware.js.
  app.post('/api/contratos/:id/anexos',
    comTratamentoDeErro(uploadAnexo.array('arquivo', MAX_ARQUIVOS), { rotulo: 'contrato-anexo', limiteMb: 10, maxArquivos: MAX_ARQUIVOS }),
    reentrarContextoTenant, (req, res) => {
    const arquivos = req.files || [];
    try {
      if (!arquivos.length) return res.status(400).json({ success: false, error: 'arquivo obrigatório' });
      const contratoId = Number(req.params.id);
      const contrato = db.prepare('SELECT id FROM contratos WHERE id = ?').get(contratoId);
      if (!contrato) {
        // Sem contrato não há a que anexar: apaga o que o multer já gravou em
        // disco, senão sobra órfão a cada tentativa.
        for (const f of arquivos) fs.unlink(f.path, () => {});
        return res.status(404).json({ success: false, error: 'Contrato não encontrado' });
      }
      const tipo = TIPOS_ANEXO.includes(req.body.tipo) ? req.body.tipo : 'outro';
      const ins = db.prepare(`INSERT INTO contratos_anexos
        (contratoId, nomeOriginal, caminho, mimeType, tamanho, tipo)
        VALUES (?, ?, ?, ?, ?, ?)`);
      // Tudo ou nada: se um INSERT falhar, nenhum anexo fica registrado — e o
      // catch abaixo apaga os arquivos, para não sobrar arquivo sem linha.
      const ids = db.transaction(() => arquivos.map(f => {
        const rel = path.relative(path.join(__dirname, 'public'), f.path).replace(/\\/g, '/');
        return ins.run(contratoId, nomeOriginalUtf8(f.originalname), rel, f.mimetype, f.size, tipo).lastInsertRowid;
      }))();

      logAction(db, req, 'anexar', 'contrato', contratoId,
        { anexoIds: ids, nomes: arquivos.map(f => nomeOriginalUtf8(f.originalname)), tipo });
      const anexos = ids.map(anexoId =>
        db.prepare('SELECT * FROM contratos_anexos WHERE id = ?').get(anexoId));
      // `anexo` no singular continua na resposta para quem só mandou um.
      res.json({ success: true, anexos, anexo: anexos[0] });
    } catch (err) {
      console.error('[contratos upload anexo]', err);
      for (const f of arquivos) fs.unlink(f.path, () => {});
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/contratos/anexos/:anexoId/download', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM contratos_anexos WHERE id = ?').get(Number(req.params.anexoId));
      if (!a) return res.status(404).json({ success: false, error: 'Anexo não encontrado' });
      const abs = path.join(__dirname, 'public', a.caminho);
      if (!fs.existsSync(abs)) return res.status(404).json({ success: false, error: 'Arquivo não está mais no disco' });
      res.download(abs, a.nomeOriginal);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/contratos/anexos/:anexoId', (req, res) => {
    try {
      const a = db.prepare('SELECT * FROM contratos_anexos WHERE id = ?').get(Number(req.params.anexoId));
      if (!a) return res.status(404).json({ success: false, error: 'Anexo não encontrado' });
      const abs = path.join(__dirname, 'public', a.caminho);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
      db.prepare('DELETE FROM contratos_anexos WHERE id = ?').run(a.id);
      logAction(db, req, 'remover-anexo', 'contrato', a.contratoId, { anexoId: a.id, nome: a.nomeOriginal });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Vencendo (alerta)
  app.get('/api/contratos/alerta/vencendo', (req, res) => {
    try {
      const dias = Number(req.query.dias) || 30;
      const lista = db.prepare(`
        SELECT c.*, p.razaoSocial AS clienteNome
        FROM contratos c
        JOIN pessoas p ON p.id = c.clienteId
        WHERE c.status = 'ativo' AND c.dataFim IS NOT NULL
          AND date(c.dataFim) <= date('now', '+' || ? || ' days')
        ORDER BY c.dataFim
      `).all(dias);
      res.json({ success: true, contratos: lista });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== CRIAR ====================

  app.post('/api/contratos', (req, res) => {
    try {
      const { clienteId, descricao, valorMensal, diaVencimento, periodicidade,
              dataInicio, dataFim, renovacaoAutomatica, prazoRenovacaoMeses,
              indiceReajuste, percentualReajuste, dataProximoReajuste,
              recorrenciaNfseId, observacoes,
              // Integração recorrência (2026-04-22): quando criarRecorrencia=true,
              // o backend gera um row em nfse_recorrencias vinculado ao contrato.
              // Os campos dentro de recorrencia são opcionais — defaults razoáveis.
              criarRecorrencia, recorrencia } = req.body;
      if (!clienteId || !descricao || valorMensal == null || !dataInicio) {
        return res.status(400).json({ success: false, error: 'clienteId, descricao, valorMensal e dataInicio obrigatórios' });
      }
      const periodo = periodicidade || 'mensal';
      if (!PERIODICIDADES.includes(periodo)) {
        return res.status(400).json({ success: false, error: `periodicidade inválida (use ${PERIODICIDADES.join(' ou ')})` });
      }
      if (criarRecorrencia && recorrenciaNfseId) {
        return res.status(400).json({ success: false, error: 'Passe criarRecorrencia OU recorrenciaNfseId, não ambos' });
      }
      // Mesma regra 1:1 da rota de vínculo — senão dava para roubar a
      // recorrência de outro contrato criando um novo.
      if (recorrenciaNfseId) {
        const ocupada = db.prepare('SELECT numero FROM contratos WHERE recorrenciaNfseId = ?').get(Number(recorrenciaNfseId));
        if (ocupada) {
          return res.status(409).json({ success: false,
            error: `Recorrência #${recorrenciaNfseId} já está vinculada ao contrato ${ocupada.numero}` });
        }
      }
      const numero = gerarNumero(db);
      const trx = db.transaction(() => {
        let recIdFinal = recorrenciaNfseId || null;

        // 1) Se pediu para criar recorrência junto, cria primeiro (precisa do ID
        //    para referenciar em contratos.recorrenciaNfseId).
        if (criarRecorrencia) {
          const rec = recorrencia || {};
          if (!rec.codigoTributacaoNacional) {
            throw new Error('recorrencia.codigoTributacaoNacional é obrigatório para criar recorrência');
          }
          const insRec = db.prepare(`
            INSERT INTO nfse_recorrencias
              (pessoaId, ativo, gerarBoleto, enviarEmail, diaVencimentoBoleto,
               codigoTributacaoNacional, codigoListaServico, descricao, valorServico,
               valorDeducoes, aliquota, codigoMunicipioPrestacao, opSimpNac, regEspTrib,
               pTotTribSN, incluirIM, observacoes)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            clienteId,
            rec.gerarBoleto ? 1 : 0,
            rec.enviarEmail ? 1 : 0,
            Number(rec.diaVencimentoBoleto || diaVencimento) || 10,
            rec.codigoTributacaoNacional,
            rec.codigoListaServico || null,
            rec.descricao || descricao,
            Number(rec.valorServico != null ? rec.valorServico : valorMensal),
            rec.valorDeducoes != null ? Number(rec.valorDeducoes) : null,
            rec.aliquota != null ? Number(rec.aliquota) : null,
            rec.codigoMunicipioPrestacao || null,
            Number(rec.opSimpNac != null ? rec.opSimpNac : 3),
            Number(rec.regEspTrib || 0),
            rec.pTotTribSN != null ? Number(rec.pTotTribSN) : null,
            rec.incluirIM != null ? (rec.incluirIM ? 1 : 0) : 1,
            rec.observacoes || null,
          );
          recIdFinal = insRec.lastInsertRowid;
        }

        const r = db.prepare(`
          INSERT INTO contratos
            (numero, clienteId, descricao, valorMensal, diaVencimento, periodicidade,
             dataInicio, dataFim, renovacaoAutomatica, prazoRenovacaoMeses,
             indiceReajuste, percentualReajuste, dataProximoReajuste,
             recorrenciaNfseId, observacoes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          numero, clienteId, descricao, Number(valorMensal), Number(diaVencimento) || 10, periodo,
          dataInicio, dataFim || null,
          renovacaoAutomatica ? 1 : 0, Number(prazoRenovacaoMeses) || 12,
          indiceReajuste || null, percentualReajuste != null ? Number(percentualReajuste) : null,
          dataProximoReajuste || null,
          recIdFinal, observacoes || null
        );
        const id = r.lastInsertRowid;
        db.prepare(`
          INSERT INTO contratos_eventos (contratoId, tipo, descricao, valorDepois, dataFimDepois, usuario)
          VALUES (?, 'criacao', ?, ?, ?, ?)
        `).run(id, `Contrato ${numero} criado${recIdFinal ? ` (recorrência #${recIdFinal} vinculada)` : ''}`,
               Number(valorMensal), dataFim || null, req.user?.username || null);
        return id;
      });
      const id = trx();
      logAction(db, req, 'criar', 'contrato', id, { numero, clienteId, valorMensal });
      res.json({ success: true, contrato: db.prepare('SELECT * FROM contratos WHERE id = ?').get(id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ==================== VÍNCULO COM RECORRÊNCIA EXISTENTE ====================
  //
  // A recorrência é a fonte do faturamento do contrato: reajustar o
  // contrato reescreve nfse_recorrencias.valorServico, e suspender o
  // contrato desativa a recorrência. Por isso o vínculo é 1:1 — duas
  // amarras no mesmo registro fariam um contrato mexer no faturamento
  // do outro sem ninguém perceber.

  /** Recorrências que este contrato pode assumir, já classificadas. */
  app.get('/api/contratos/:id/recorrencias-disponiveis', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Contrato não encontrado' });

      let rows = [];
      try {
        rows = db.prepare(`
          SELECT r.id, r.pessoaId, r.descricao, r.valorServico, r.ativo,
                 r.diaVencimentoBoleto, r.gerarBoleto, r.enviarEmail,
                 p.razaoSocial AS clienteNome, p.cpfCnpj AS clienteCpfCnpj,
                 ct.id AS contratoVinculadoId, ct.numero AS contratoVinculadoNumero
          FROM nfse_recorrencias r
          JOIN pessoas p ON p.id = r.pessoaId
          LEFT JOIN contratos ct ON ct.recorrenciaNfseId = r.id AND ct.id <> ?
          ORDER BY r.ativo DESC, p.razaoSocial`).all(c.id);
      } catch { /* tenant sem o módulo de recorrências */ }

      const lista = rows.map(r => {
        const mesmoCliente = r.pessoaId === c.clienteId;
        const ocupada = !!r.contratoVinculadoId;
        // Divergência de valor não bloqueia: o contrato pode ter reajuste
        // pendente. Mas o usuário precisa ver antes de confirmar.
        const difValor = Math.abs((r.valorServico || 0) - (c.valorMensal || 0));
        return {
          ...r,
          mesmoCliente,
          ocupada,
          jaVinculadaAqui: c.recorrenciaNfseId === r.id,
          valorDivergente: difValor > 0.01,
          diferencaValor: Number(difValor.toFixed(2)),
          // Só o mesmo cliente é vinculável sem confirmação explícita:
          // NFSe de recorrência de outro CNPJ sai no nome errado.
          vinculavel: !ocupada,
        };
      }).sort((a, b) =>
        (b.mesmoCliente - a.mesmoCliente) || (a.ocupada - b.ocupada) || a.id - b.id);

      res.json({
        success: true,
        contrato: { id: c.id, numero: c.numero, clienteId: c.clienteId,
                    valorMensal: c.valorMensal, recorrenciaNfseId: c.recorrenciaNfseId },
        recorrencias: lista,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/vincular-recorrencia', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Contrato não encontrado' });

      const recId = Number(req.body?.recorrenciaNfseId);
      if (!recId) return res.status(400).json({ success: false, error: 'recorrenciaNfseId obrigatório' });

      const rec = db.prepare(`SELECT r.*, p.razaoSocial AS clienteNome
        FROM nfse_recorrencias r JOIN pessoas p ON p.id = r.pessoaId WHERE r.id = ?`).get(recId);
      if (!rec) return res.status(404).json({ success: false, error: 'Recorrência não encontrada' });

      const ocupada = db.prepare('SELECT id, numero FROM contratos WHERE recorrenciaNfseId = ? AND id <> ?')
        .get(recId, c.id);
      if (ocupada) {
        return res.status(409).json({ success: false,
          error: `Recorrência #${recId} já está vinculada ao contrato ${ocupada.numero}. Desvincule lá antes.` });
      }

      // Cliente diferente emitiria NFSe no CNPJ errado — exige confirmação
      // explícita em vez de acontecer por descuido.
      if (rec.pessoaId !== c.clienteId && !req.body?.permitirClienteDiferente) {
        return res.status(409).json({ success: false,
          clienteDivergente: true,
          error: `A recorrência é do cliente "${rec.clienteNome}" e o contrato é de outro cliente. `
               + 'A NFSe sairia no CNPJ da recorrência. Confirme se é isso mesmo.' });
      }

      db.transaction(() => {
        db.prepare('UPDATE contratos SET recorrenciaNfseId = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
          .run(recId, c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario)
          VALUES (?, 'aditivo', ?, ?)`)
          .run(c.id, `Recorrência #${recId} vinculada (${rec.descricao || 'sem descrição'})`,
               req.user?.username || req.session?.username || null);
      })();

      logAction(db, req, 'vincular', 'contrato', c.id, { recorrenciaNfseId: recId });
      res.json({
        success: true,
        recorrenciaNfseId: recId,
        avisoValor: Math.abs((rec.valorServico || 0) - (c.valorMensal || 0)) > 0.01
          ? `Contrato R$ ${(c.valorMensal || 0).toFixed(2)}/mês × recorrência R$ ${(rec.valorServico || 0).toFixed(2)}/mês — o próximo reajuste alinha os dois.`
          : null,
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/contratos/:id/vincular-recorrencia', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Contrato não encontrado' });
      if (!c.recorrenciaNfseId) {
        return res.status(400).json({ success: false, error: 'Contrato não tem recorrência vinculada' });
      }
      const anterior = c.recorrenciaNfseId;

      // Só desfaz o vínculo. A recorrência continua ativa e faturando —
      // desativá-la aqui cortaria o faturamento do cliente por um efeito
      // colateral de uma ação que só falava de vínculo.
      db.transaction(() => {
        db.prepare('UPDATE contratos SET recorrenciaNfseId = NULL, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?')
          .run(c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario)
          VALUES (?, 'aditivo', ?, ?)`)
          .run(c.id, `Recorrência #${anterior} desvinculada (segue ativa no financeiro)`,
               req.user?.username || req.session?.username || null);
      })();

      logAction(db, req, 'desvincular', 'contrato', c.id, { recorrenciaNfseId: anterior });
      res.json({ success: true, recorrenciaNfseId: anterior });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Editar dados básicos (não muda valor — use reajuste)
  app.put('/api/contratos/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });

      // recorrenciaNfseId sai daqui: passou a ter rota própria, com as
      // checagens de 1:1 e de cliente. Deixar no PUT genérico permitiria
      // furar as duas.
      //
      // valorMensal, periodicidade e dataInicio entraram em 2026-08-20: sem
      // eles, um contrato cadastrado errado não tinha conserto. "Reajustar"
      // não serve para isso — ele registra uma mudança comercial que não
      // aconteceu (ver TIPOS_EVENTO.correcao).
      const camposValidos = ['descricao','valorMensal','periodicidade','diaVencimento',
                             'dataInicio','dataFim','renovacaoAutomatica','prazoRenovacaoMeses',
                             'indiceReajuste','percentualReajuste','dataProximoReajuste','observacoes'];

      if (req.body.periodicidade !== undefined && !PERIODICIDADES.includes(req.body.periodicidade)) {
        return res.status(400).json({ success: false, error: `Periodicidade inválida: ${req.body.periodicidade}` });
      }
      if (req.body.valorMensal !== undefined && !(Number(req.body.valorMensal) > 0)) {
        return res.status(400).json({ success: false, error: 'Valor deve ser maior que zero' });
      }
      const dia = req.body.diaVencimento;
      if (dia !== undefined && !(Number(dia) >= 1 && Number(dia) <= 28)) {
        return res.status(400).json({ success: false, error: 'Dia de vencimento deve ficar entre 1 e 28' });
      }
      // Fim antes do início deixaria a vigência sem sentido e o alerta de
      // vencimento maluco.
      const ini = req.body.dataInicio !== undefined ? req.body.dataInicio : c.dataInicio;
      const fim = req.body.dataFim !== undefined ? req.body.dataFim : c.dataFim;
      if (ini && fim && fim < ini) {
        return res.status(400).json({ success: false, error: 'Fim da vigência é anterior ao início' });
      }

      const sets = [], vals = [];
      for (const k of camposValidos) {
        if (req.body[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(k === 'renovacaoAutomatica' ? (req.body[k] ? 1 : 0) : (req.body[k] === '' ? null : req.body[k]));
        }
      }
      if (!sets.length) return res.json({ success: true, semMudanca: true });

      // O que mudou em valor ou periodicidade vira evento: o histórico é o
      // que explica por que a fatura de amanhã não bate com a de ontem.
      const valorNovo = req.body.valorMensal !== undefined ? Number(req.body.valorMensal) : c.valorMensal;
      const periodoNovo = req.body.periodicidade !== undefined ? req.body.periodicidade : c.periodicidade;
      const mudouValor = valorNovo !== c.valorMensal;
      const mudouPeriodo = periodoNovo !== c.periodicidade;

      db.transaction(() => {
        sets.push('dataAtualizacao = CURRENT_TIMESTAMP');
        vals.push(c.id);
        db.prepare(`UPDATE contratos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

        if (mudouValor || mudouPeriodo) {
          const partes = [];
          if (mudouValor) partes.push(`valor R$ ${Number(c.valorMensal).toFixed(2)} → R$ ${valorNovo.toFixed(2)}`);
          if (mudouPeriodo) partes.push(`periodicidade ${c.periodicidade} → ${periodoNovo}`);
          db.prepare(`
            INSERT INTO contratos_eventos (contratoId, tipo, descricao, valorAntes, valorDepois, usuario)
            VALUES (?, 'correcao', ?, ?, ?, ?)
          `).run(c.id, 'Correção de cadastro: ' + partes.join('; '),
                 mudouValor ? c.valorMensal : null, mudouValor ? valorNovo : null,
                 req.user?.username || null);
        }
      })();

      logAction(db, req, 'editar', 'contrato', c.id, req.body);
      // A recorrência de faturamento NÃO é tocada aqui de propósito: quem
      // muda o valor dela é o reajuste. Uma correção de digitação não deve
      // mexer sozinha no que já está programado para faturar — a tela avisa.
      res.json({ success: true, recorrenciaNfseId: c.recorrenciaNfseId || null,
                 valorAlterado: mudouValor || mudouPeriodo });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== AÇÕES DE CICLO DE VIDA ====================

  app.post('/api/contratos/:id/renovar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const meses = Number(req.body?.meses) || c.prazoRenovacaoMeses || 12;
      const baseFim = c.dataFim || c.dataInicio;
      const novaFim = addMeses(baseFim, meses);
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET dataFim = ?, status = 'ativo', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(novaFim, c.id);
        db.prepare(`
          INSERT INTO contratos_eventos (contratoId, tipo, descricao, dataFimAntes, dataFimDepois, usuario)
          VALUES (?, 'renovacao', ?, ?, ?, ?)
        `).run(c.id, `Renovação por ${meses} meses`, c.dataFim, novaFim, req.user?.username || null);
      });
      trx();
      logAction(db, req, 'renovar', 'contrato', c.id, { meses, dataFim: novaFim });
      res.json({ success: true, dataFim: novaFim });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/reajustar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const { percentual, novoValor, dataProximoReajuste, descricao } = req.body || {};
      if (percentual == null && novoValor == null) {
        return res.status(400).json({ success: false, error: 'Informe percentual ou novoValor' });
      }
      const valorAntes = c.valorMensal;
      const valorDepois = novoValor != null ? Number(novoValor) : valorAntes * (1 + Number(percentual) / 100);
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET valorMensal = ?, dataProximoReajuste = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(valorDepois, dataProximoReajuste || null, c.id);
        db.prepare(`
          INSERT INTO contratos_eventos (contratoId, tipo, descricao, valorAntes, valorDepois, usuario)
          VALUES (?, 'reajuste', ?, ?, ?, ?)
        `).run(c.id, descricao || (percentual != null ? `Reajuste de ${percentual}%` : `Reajuste para R$ ${valorDepois.toFixed(2)}`),
                valorAntes, valorDepois, req.user?.username || null);
        // Integração (2): propaga valor para a recorrência vinculada.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET valorServico = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`)
            .run(valorDepois, c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'reajustar', 'contrato', c.id, { de: valorAntes, para: valorDepois, percentual, recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, valorAnterior: valorAntes, valorNovo: valorDepois, recorrenciaAtualizada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/suspender', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (c.status !== 'ativo') return res.status(400).json({ success: false, error: 'Só contratos ativos podem ser suspensos' });
      const motivo = (req.body?.motivo || '').trim();
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET status = 'suspenso', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'suspensao', ?, ?)`)
          .run(c.id, motivo || 'Contrato suspenso', req.user?.username || null);
        // Integração (3): cascateia para a recorrência — para de emitir NFSe.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'suspender', 'contrato', c.id, { motivo, recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, recorrenciaDesativada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/reativar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (c.status === 'encerrado') return res.status(400).json({ success: false, error: 'Contrato encerrado — crie um novo' });
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET status = 'ativo', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'reativacao', ?, ?)`)
          .run(c.id, 'Contrato reativado', req.user?.username || null);
        // Integração (3): cascateia para a recorrência — volta a emitir NFSe.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET ativo = 1, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'reativar', 'contrato', c.id, { recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, recorrenciaReativada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/encerrar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 5) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 5 caracteres)' });
      const trx = db.transaction(() => {
        db.prepare(`UPDATE contratos SET status = 'encerrado', dataFim = COALESCE(dataFim, date('now')), dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
        db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'encerramento', ?, ?)`)
          .run(c.id, motivo, req.user?.username || null);
        // Integração (3): cascateia para a recorrência — para definitivamente.
        if (c.recorrenciaNfseId) {
          db.prepare(`UPDATE nfse_recorrencias SET ativo = 0, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(c.recorrenciaNfseId);
        }
      });
      trx();
      logAction(db, req, 'encerrar', 'contrato', c.id, { motivo, recorrenciaNfseId: c.recorrenciaNfseId });
      res.json({ success: true, recorrenciaDesativada: !!c.recorrenciaNfseId });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contratos/:id/aditivo', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM contratos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      const { descricao } = req.body || {};
      if (!descricao || descricao.length < 5) return res.status(400).json({ success: false, error: 'Descrição do aditivo obrigatória' });
      db.prepare(`INSERT INTO contratos_eventos (contratoId, tipo, descricao, usuario) VALUES (?, 'aditivo', ?, ?)`)
        .run(c.id, descricao, req.user?.username || null);
      logAction(db, req, 'aditivo', 'contrato', c.id, { descricao });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = {
  registrarRotasContratos, migrarDB, PERIODICIDADES, MESES_POR_PERIODO,
  temModuloSsl, mesesDeVigencia, itensComEmissoes,
};
