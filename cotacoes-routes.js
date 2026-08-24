/**
 * cotacoes-routes.js — Cotação de compras: solicita preços a N fornecedores,
 * compara respostas e gera pedido(s) de compra do(s) vencedor(es).
 *
 * Fluxo: rascunho → (enviar: gera tokenPublico por fornecedor) enviada
 *        → (fornecedores respondem pelo link público) em_resposta
 *        → (concluir: escolhe vencedor por item → pedidos_compra) concluida
 *        | cancelada
 *
 * Rotas públicas (link do fornecedor, sem login) ficam em
 * registrarRotasCotacaoPublica — registrado no pre-auth-routes.
 * Página pública: /portal/cotacao.html?t=<token>
 */

const crypto = require('crypto');
const { logAction } = require('./audit-log');
const { E_FORNECEDOR } = require('./pessoas-fornecedor');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function migrarCotacoesDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cotacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT NOT NULL UNIQUE,
      descricao TEXT,
      status TEXT NOT NULL DEFAULT 'rascunho',
      dataLimite TEXT,
      licitacaoRef TEXT,
      observacao TEXT,
      usuario TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cotacoes_status ON cotacoes(status);

    CREATE TABLE IF NOT EXISTS cotacao_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoId INTEGER NOT NULL,
      produtoId INTEGER,
      descricao TEXT NOT NULL,
      quantidade REAL NOT NULL,
      unidade TEXT DEFAULT 'UN',
      FOREIGN KEY (cotacaoId) REFERENCES cotacoes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_cotitens_cot ON cotacao_itens(cotacaoId);

    CREATE TABLE IF NOT EXISTS cotacao_fornecedores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoId INTEGER NOT NULL,
      fornecedorId INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente',
      tokenPublico TEXT UNIQUE,
      dataEnvio TEXT,
      dataResposta TEXT,
      observacaoFornecedor TEXT,
      FOREIGN KEY (cotacaoId) REFERENCES cotacoes(id),
      FOREIGN KEY (fornecedorId) REFERENCES pessoas(id),
      UNIQUE (cotacaoId, fornecedorId)
    );
    CREATE INDEX IF NOT EXISTS idx_cotforn_token ON cotacao_fornecedores(tokenPublico);

    CREATE TABLE IF NOT EXISTS cotacao_respostas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoFornecedorId INTEGER NOT NULL,
      cotacaoItemId INTEGER NOT NULL,
      precoUnitario REAL,
      prazoEntregaDias INTEGER,
      marcaOferecida TEXT,
      observacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cotacaoFornecedorId) REFERENCES cotacao_fornecedores(id),
      FOREIGN KEY (cotacaoItemId) REFERENCES cotacao_itens(id),
      UNIQUE (cotacaoFornecedorId, cotacaoItemId)
    );

    -- Rateio do item entre fornecedores. Sem isto o item inteiro ia para um
    -- único vencedor, e não havia como dividir uma compra entre dois
    -- fornecedores nem comprar de um segundo o que o primeiro não tem.
    CREATE TABLE IF NOT EXISTS cotacao_rateios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cotacaoId INTEGER NOT NULL,
      cotacaoItemId INTEGER NOT NULL,
      cotacaoFornecedorId INTEGER NOT NULL,
      quantidade REAL NOT NULL,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cotacaoId) REFERENCES cotacoes(id),
      FOREIGN KEY (cotacaoItemId) REFERENCES cotacao_itens(id),
      FOREIGN KEY (cotacaoFornecedorId) REFERENCES cotacao_fornecedores(id),
      UNIQUE (cotacaoItemId, cotacaoFornecedorId)
    );
    CREATE INDEX IF NOT EXISTS idx_cotrateio_cot ON cotacao_rateios(cotacaoId);
  `);

  // Quanto o fornecedor consegue entregar. Sem esta coluna ele só sabia dizer
  // o preço, e o comprador dividia a quantidade no escuro.
  try { db.exec('ALTER TABLE cotacao_respostas ADD COLUMN quantidadeDisponivel REAL'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  // Origem do item: qual documento gerou esta necessidade. Espelha
  // pedido_compra_itens — a cotação é só um trecho a mais do mesmo caminho, e
  // o vínculo precisa sobreviver a ela para chegar no pedido de compra.
  for (const col of ['origemTipo TEXT', 'origemId INTEGER', 'origemItemId INTEGER']) {
    try { db.exec(`ALTER TABLE cotacao_itens ADD COLUMN ${col}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_cotitens_origem ON cotacao_itens(origemTipo, origemId)');
}

/**
 * Quanto deste item o fornecedor se comprometeu a entregar.
 * NULL = não informou, e nesse caso vale a necessidade inteira (é como o
 * sistema se comportava antes de existir a coluna). 0 = não atende.
 */
function disponivelDoItem(resposta, item) {
  if (resposta.quantidadeDisponivel == null) return item.quantidade;
  return Math.max(0, Math.min(Number(resposta.quantidadeDisponivel), item.quantidade));
}

const EPS = 1e-9;

/**
 * Disponibilidade declarada pelo fornecedor, normalizada.
 * Branco/ausente/inválido → null, que significa "atende a quantidade toda" e
 * é como o sistema se comportava antes desta coluna existir. Acima do pedido
 * é aparado: prometer 500 de uma necessidade de 100 só sujaria o rateio.
 * Zero é resposta legítima — "cotei, mas não tenho".
 */
function normalizarDisponivel(valor, quantidadePedida) {
  if (valor == null || valor === '') return null;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(n, quantidadePedida);
}

/**
 * Confere um rateio antes de gravar ou de virar pedido: item e fornecedor são
 * desta cotação, o fornecedor cotou o item, a quantidade cabe no que ele tem
 * e a soma por item não passa da necessidade. Lança Error com a mensagem que
 * vai para a tela.
 */
function validarRateio(db, cot, linhas) {
  const itens = new Map(db.prepare('SELECT * FROM cotacao_itens WHERE cotacaoId = ?').all(cot.id).map(i => [i.id, i]));
  const forns = new Map(db.prepare(`SELECT cf.*, f.razaoSocial FROM cotacao_fornecedores cf
      JOIN pessoas f ON f.id = cf.fornecedorId WHERE cf.cotacaoId = ?`).all(cot.id).map(f => [f.id, f]));
  const getResp = db.prepare('SELECT * FROM cotacao_respostas WHERE cotacaoFornecedorId = ? AND cotacaoItemId = ?');

  const normalizadas = [];
  const alocado = new Map();
  const vistos = new Set();

  for (const l of linhas) {
    const item = itens.get(Number(l.cotacaoItemId));
    if (!item) throw new Error(`Item ${l.cotacaoItemId} não é desta cotação`);
    const cf = forns.get(Number(l.cotacaoFornecedorId));
    if (!cf) throw new Error(`Fornecedor ${l.cotacaoFornecedorId} não é desta cotação`);

    const chave = item.id + ':' + cf.id;
    if (vistos.has(chave)) {
      throw new Error(`${cf.razaoSocial} aparece duas vezes no item "${item.descricao}" — some as quantidades numa linha só`);
    }
    vistos.add(chave);

    const resp = getResp.get(cf.id, item.id);
    if (!resp || !(resp.precoUnitario > 0)) {
      throw new Error(`${cf.razaoSocial} não cotou o item "${item.descricao}"`);
    }

    // Sem quantidade explícita, assume o que ainda falta do item: mantém
    // funcionando o gesto antigo de escolher um vencedor com um clique.
    const jaAlocado = alocado.get(item.id) || 0;
    const qtd = (l.quantidade == null || l.quantidade === '') ? (item.quantidade - jaAlocado) : Number(l.quantidade);
    if (!(qtd > 0)) throw new Error(`Quantidade inválida para "${item.descricao}"`);

    // A necessidade do item vem primeiro: passar dela é o limite mais forte, e
    // checar a disponibilidade antes fazia a mensagem culpar o fornecedor por
    // um teto que na verdade era o tamanho da compra.
    const total = jaAlocado + qtd;
    if (total > item.quantidade + EPS) {
      throw new Error(`"${item.descricao}": rateio soma ${total} para uma necessidade de ${item.quantidade}`);
    }
    const disp = disponivelDoItem(resp, item);
    if (qtd > disp + EPS) {
      throw new Error(`${cf.razaoSocial} só tem ${disp} ${item.unidade || ''} de "${item.descricao}" (pedido: ${qtd})`.replace(/\s+/g, ' '));
    }
    alocado.set(item.id, total);
    normalizadas.push({ item, cf, resposta: resp, quantidade: qtd });
  }

  // Item coberto só em parte não é erro (pode-se comprar o resto depois), mas
  // quem confirma precisa saber disso antes de gerar os pedidos.
  const parciais = [];
  for (const [, item] of itens) {
    const a = alocado.get(item.id) || 0;
    if (a > EPS && a < item.quantidade - EPS) {
      parciais.push({ cotacaoItemId: item.id, descricao: item.descricao, necessario: item.quantidade, alocado: a, faltando: Number((item.quantidade - a).toFixed(4)) });
    }
  }
  return { linhas: normalizadas, alocado, itens, parciais };
}

/**
 * Rateio sugerido: menor preço primeiro, respeitando o que cada fornecedor
 * disse que tem. Devolve também o que ninguém cobre, que é a informação que
 * decide se dá para fechar a compra.
 */
function sugerirRateio(db, cot) {
  const itens = db.prepare('SELECT * FROM cotacao_itens WHERE cotacaoId = ? ORDER BY id').all(cot.id);
  const ofertasDo = db.prepare(`SELECT r.*, cf.id AS cfId, f.razaoSocial
    FROM cotacao_respostas r
    JOIN cotacao_fornecedores cf ON cf.id = r.cotacaoFornecedorId
    JOIN pessoas f ON f.id = cf.fornecedorId
    WHERE cf.cotacaoId = ? AND r.cotacaoItemId = ? AND r.precoUnitario > 0
    ORDER BY r.precoUnitario ASC, COALESCE(r.prazoEntregaDias, 9999) ASC, cf.id ASC`);

  const rateios = [], descobertos = [];
  for (const item of itens) {
    let falta = item.quantidade;
    for (const o of ofertasDo.all(cot.id, item.id)) {
      if (falta <= EPS) break;
      const disp = disponivelDoItem(o, item);
      if (disp <= EPS) continue;
      const q = Math.min(falta, disp);
      rateios.push({
        cotacaoItemId: item.id, cotacaoFornecedorId: o.cfId, quantidade: Number(q.toFixed(4)),
        precoUnitario: o.precoUnitario, fornecedor: o.razaoSocial,
      });
      falta -= q;
    }
    if (falta > EPS) {
      descobertos.push({ cotacaoItemId: item.id, descricao: item.descricao, faltando: Number(falta.toFixed(4)), unidade: item.unidade });
    }
  }
  return { rateios, descobertos };
}

function proximoNumeroCotacao(db) {
  const ano = new Date().getFullYear();
  const prefixo = `COT-${ano}-`;
  const ult = db.prepare('SELECT numero FROM cotacoes WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefixo + '%');
  const seq = ult ? parseInt(ult.numero.slice(prefixo.length), 10) + 1 : 1;
  return prefixo + String(seq).padStart(4, '0');
}

function detalheCotacao(db, id) {
  const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(id);
  if (!cot) return null;
  const itens = db.prepare(`SELECT ci.*, p.sku FROM cotacao_itens ci
    LEFT JOIN produtos p ON p.id = ci.produtoId WHERE ci.cotacaoId = ? ORDER BY ci.id`).all(id);
  const fornecedores = db.prepare(`SELECT cf.*, f.razaoSocial, f.email, f.telefone
    FROM cotacao_fornecedores cf JOIN pessoas f ON f.id = cf.fornecedorId
    WHERE cf.cotacaoId = ? ORDER BY cf.id`).all(id);
  const respostas = db.prepare(`SELECT r.* FROM cotacao_respostas r
    JOIN cotacao_fornecedores cf ON cf.id = r.cotacaoFornecedorId
    WHERE cf.cotacaoId = ?`).all(id);
  // O rateio ficava só na memória do navegador: recarregar a página perdia a
  // divisão inteira, o que inviabiliza cotação grande.
  const rateios = db.prepare('SELECT * FROM cotacao_rateios WHERE cotacaoId = ?').all(id);

  // Quanto de cada item já está coberto, para a tela não ter que recalcular
  // (e divergir do que o backend aceita na hora de concluir).
  const alocado = new Map();
  for (const r of rateios) alocado.set(r.cotacaoItemId, (alocado.get(r.cotacaoItemId) || 0) + r.quantidade);
  const cobertura = itens.map(it => ({
    cotacaoItemId: it.id,
    necessario: it.quantidade,
    alocado: Number((alocado.get(it.id) || 0).toFixed(4)),
    faltando: Number(Math.max(0, it.quantidade - (alocado.get(it.id) || 0)).toFixed(4)),
  }));
  return { cotacao: cot, itens, fornecedores, respostas, rateios, cobertura };
}

function registrarRotasCotacoes(app, db) {
  migrarCotacoesDB(db);

  app.get('/api/cotacoes', (req, res) => {
    try {
      const { status } = req.query;
      let sql = `SELECT c.*,
          (SELECT COUNT(*) FROM cotacao_itens WHERE cotacaoId = c.id) AS qtdItens,
          (SELECT COUNT(*) FROM cotacao_fornecedores WHERE cotacaoId = c.id) AS qtdFornecedores,
          (SELECT COUNT(*) FROM cotacao_fornecedores WHERE cotacaoId = c.id AND status = 'respondida') AS qtdRespostas
        FROM cotacoes c`;
      const params = [];
      if (status) { sql += ' WHERE c.status = ?'; params.push(status); }
      sql += ' ORDER BY c.id DESC LIMIT 200';
      res.json({ success: true, cotacoes: db.prepare(sql).all(...params) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/cotacoes/:id', (req, res) => {
    try {
      const det = detalheCotacao(db, req.params.id);
      if (!det) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      res.json({ success: true, ...det });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cotacoes', (req, res) => {
    try {
      const { descricao, dataLimite, itens, fornecedoresIds, observacao, licitacaoRef } = req.body || {};
      if (!Array.isArray(itens) || !itens.length) {
        return res.status(400).json({ success: false, error: 'Informe ao menos 1 item' });
      }
      if (!Array.isArray(fornecedoresIds) || !fornecedoresIds.length) {
        return res.status(400).json({ success: false, error: 'Informe ao menos 1 fornecedor' });
      }
      for (const it of itens) {
        if (!it.descricao || !(Number(it.quantidade) > 0)) {
          return res.status(400).json({ success: false, error: 'Cada item exige descricao e quantidade > 0' });
        }
      }
      for (const fid of fornecedoresIds) {
        const f = db.prepare(`SELECT id FROM pessoas WHERE id = ? AND ${E_FORNECEDOR}`).get(fid);
        if (!f) return res.status(400).json({ success: false, error: `Fornecedor ${fid} não encontrado` });
      }

      const usuario = req.session?.username || null;
      let cotId;
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO cotacoes (numero, descricao, dataLimite, observacao, licitacaoRef, usuario)
          VALUES (?, ?, ?, ?, ?, ?)`).run(
          proximoNumeroCotacao(db), descricao || null, dataLimite || null,
          observacao || null, licitacaoRef || null, usuario);
        cotId = r.lastInsertRowid;
        const insItem = db.prepare(`INSERT INTO cotacao_itens (cotacaoId, produtoId, descricao, quantidade, unidade)
          VALUES (?, ?, ?, ?, ?)`);
        for (const it of itens) {
          insItem.run(cotId, it.produtoId || null, it.descricao, Number(it.quantidade), it.unidade || 'UN');
        }
        const insForn = db.prepare('INSERT INTO cotacao_fornecedores (cotacaoId, fornecedorId) VALUES (?, ?)');
        for (const fid of fornecedoresIds) insForn.run(cotId, Number(fid));
      });
      tx();
      logAction(db, req, 'criar', 'cotacao', cotId, { itens: itens.length, fornecedores: fornecedoresIds.length });
      res.json({ success: true, id: cotId });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Gera token público por fornecedor e libera as respostas.
  app.post('/api/cotacoes/:id/enviar', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (cot.status !== 'rascunho') return res.status(400).json({ success: false, error: `Status atual: ${cot.status}` });

      const hoje = dataBrasilia();
      const tx = db.transaction(() => {
        for (const cf of db.prepare('SELECT * FROM cotacao_fornecedores WHERE cotacaoId = ?').all(cot.id)) {
          if (!cf.tokenPublico) {
            db.prepare('UPDATE cotacao_fornecedores SET tokenPublico = ?, dataEnvio = ? WHERE id = ?')
              .run(crypto.randomBytes(24).toString('hex'), hoje, cf.id);
          }
        }
        db.prepare("UPDATE cotacoes SET status = 'enviada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cot.id);
      });
      tx();
      const links = db.prepare(`SELECT cf.tokenPublico, f.razaoSocial, f.email
        FROM cotacao_fornecedores cf JOIN pessoas f ON f.id = cf.fornecedorId
        WHERE cf.cotacaoId = ?`).all(cot.id)
        .map(x => ({ fornecedor: x.razaoSocial, email: x.email, url: `/portal/cotacao.html?t=${x.tokenPublico}` }));
      logAction(db, req, 'enviar', 'cotacao', cot.id, { fornecedores: links.length });
      res.json({ success: true, links });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Rateio salvo: quanto de cada item sai de cada fornecedor. Substitui o mapa
  // inteiro da cotação, então a tela manda sempre o estado completo.
  app.post('/api/cotacoes/:id/rateio', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (!['enviada', 'em_resposta'].includes(cot.status)) {
        return res.status(400).json({ success: false, error: `Cotação ${cot.status}: rateio só antes de concluir` });
      }
      const linhas = Array.isArray(req.body?.rateios) ? req.body.rateios : [];
      const v = validarRateio(db, cot, linhas);

      const tx = db.transaction(() => {
        db.prepare('DELETE FROM cotacao_rateios WHERE cotacaoId = ?').run(cot.id);
        const ins = db.prepare(`INSERT INTO cotacao_rateios (cotacaoId, cotacaoItemId, cotacaoFornecedorId, quantidade)
          VALUES (?, ?, ?, ?)`);
        for (const l of v.linhas) ins.run(cot.id, l.item.id, l.cf.id, l.quantidade);
      });
      tx();
      res.json({ success: true, gravados: v.linhas.length, parciais: v.parciais });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // Divisão sugerida (menor preço primeiro, respeitando a disponibilidade).
  // Não grava: quem decide é o comprador.
  app.get('/api/cotacoes/:id/sugerir-rateio', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      res.json({ success: true, ...sugerirRateio(db, cot) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Conclui: gera 1 pedido de compra por fornecedor, com a quantidade que
  // coube a cada um. Aceita o rateio no corpo ou usa o que está salvo.
  app.post('/api/cotacoes/:id/concluir', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (!['enviada', 'em_resposta'].includes(cot.status)) {
        return res.status(400).json({ success: false, error: `Status atual: ${cot.status}` });
      }

      // `escolhas` sem quantidade continua valendo item inteiro para um
      // fornecedor — é o formato que a tela usava antes do rateio existir.
      let linhas = Array.isArray(req.body?.rateios) ? req.body.rateios
                 : Array.isArray(req.body?.escolhas) ? req.body.escolhas
                 : db.prepare('SELECT * FROM cotacao_rateios WHERE cotacaoId = ?').all(cot.id);
      if (!linhas.length) {
        return res.status(400).json({ success: false, error: 'Nenhum item rateado — defina quem fornece o quê antes de concluir' });
      }

      let v;
      try { v = validarRateio(db, cot, linhas); }
      catch (e) { return res.status(400).json({ success: false, error: e.message }); }

      const porFornecedor = new Map();
      const semProduto = [];
      for (const l of v.linhas) {
        // Item sem produto vinculado não vira linha de pedido de compra.
        if (!l.item.produtoId) { semProduto.push(l.item.descricao); continue; }
        if (!porFornecedor.has(l.cf.id)) porFornecedor.set(l.cf.id, { fornecedorId: l.cf.fornecedorId, itens: [] });
        porFornecedor.get(l.cf.id).itens.push(l);
      }
      if (!porFornecedor.size) {
        return res.status(400).json({ success: false, error: 'Nenhuma escolha com produto vinculado — vincule produtos aos itens para gerar pedido' });
      }

      const usuario = req.session?.username || null;
      const pedidosGerados = [];
      const tx = db.transaction(() => {
        for (const [, grupo] of porFornecedor) {
          // Mesma numeração/estrutura do compras-routes
          const ano = new Date().getFullYear();
          const prefixo = `PC-${ano}-`;
          const ult = db.prepare('SELECT numero FROM pedidos_compra WHERE numero LIKE ? ORDER BY id DESC LIMIT 1').get(prefixo + '%');
          const seq = ult ? parseInt((ult.numero.match(/-(\d+)$/) || [])[1] || '0', 10) + 1 : 1;
          const numero = prefixo + String(seq).padStart(4, '0');

          const valorTotal = grupo.itens.reduce((s, x) => s + x.quantidade * x.resposta.precoUnitario, 0);
          const r = db.prepare(`INSERT INTO pedidos_compra (numero, fornecedorId, status, valorTotal, observacoes, usuarioCriador)
            VALUES (?, ?, 'rascunho', ?, ?, ?)`).run(
            numero, grupo.fornecedorId, Number(valorTotal.toFixed(2)),
            `Gerado pela cotação ${cot.numero}`, usuario);
          const pcId = r.lastInsertRowid;
          // A origem viaja do item da cotação para a linha de compra: sem
          // isso o recebimento não saberia qual pedido de venda destravar.
          const insItem = db.prepare(`INSERT INTO pedido_compra_itens
              (pedidoCompraId, produtoId, quantidade, custoUnitario, origemTipo, origemId, origemItemId)
            VALUES (?, ?, ?, ?, ?, ?, ?)`);
          for (const x of grupo.itens) {
            insItem.run(pcId, x.item.produtoId, x.quantidade, x.resposta.precoUnitario,
              x.item.origemTipo || null, x.item.origemId || null, x.item.origemItemId || null);
          }
          pedidosGerados.push({
            id: pcId, numero, fornecedorId: grupo.fornecedorId,
            itens: grupo.itens.length, valorTotal: Number(valorTotal.toFixed(2)),
          });
        }
        db.prepare("UPDATE cotacoes SET status = 'concluida', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cot.id);
      });
      tx();
      logAction(db, req, 'concluir', 'cotacao', cot.id, { pedidos: pedidosGerados.length, linhas: v.linhas.length });
      res.json({
        success: true, pedidos: pedidosGerados, itensSemProduto: semProduto,
        // Compra parcial é decisão legítima, mas some do radar se não for dita.
        itensParciais: v.parciais,
      });
    } catch (err) {
      console.error('[cotacao concluir]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cotacoes/:id/cancelar', (req, res) => {
    try {
      const cot = db.prepare('SELECT * FROM cotacoes WHERE id = ?').get(req.params.id);
      if (!cot) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (cot.status === 'concluida') return res.status(400).json({ success: false, error: 'Cotação concluída não pode ser cancelada' });
      db.prepare("UPDATE cotacoes SET status = 'cancelada', dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?").run(cot.id);
      logAction(db, req, 'cancelar', 'cotacao', cot.id, {});
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

// ==================== ROTAS PÚBLICAS (link do fornecedor) ====================
// Registradas ANTES da barreira de auth (pre-auth-routes). O token de 48 hex
// chars é a credencial; só expõe a cotação daquele fornecedor.

function registrarRotasCotacaoPublica(app, db) {
  const acharPorToken = (token) => {
    if (!token || !/^[a-f0-9]{48}$/.test(token)) return null;
    return db.prepare(`SELECT cf.*, c.numero, c.descricao AS cotDescricao, c.dataLimite, c.status AS cotStatus,
        f.razaoSocial AS fornecedorNome
      FROM cotacao_fornecedores cf
      JOIN cotacoes c ON c.id = cf.cotacaoId
      JOIN pessoas f ON f.id = cf.fornecedorId
      WHERE cf.tokenPublico = ?`).get(token);
  };

  app.get('/api/cotacao-publica/:token', (req, res) => {
    try {
      const cf = acharPorToken(req.params.token);
      if (!cf) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (!['enviada', 'em_resposta'].includes(cf.cotStatus)) {
        return res.status(410).json({ success: false, error: 'Esta cotação foi encerrada' });
      }
      if (cf.dataLimite && cf.dataLimite < dataBrasilia()) {
        return res.status(410).json({ success: false, error: `Prazo encerrado em ${cf.dataLimite}` });
      }
      const itens = db.prepare('SELECT id, descricao, quantidade, unidade FROM cotacao_itens WHERE cotacaoId = ?').all(cf.cotacaoId);
      const respostas = db.prepare(`SELECT cotacaoItemId, precoUnitario, prazoEntregaDias,
          marcaOferecida, observacao, quantidadeDisponivel
        FROM cotacao_respostas WHERE cotacaoFornecedorId = ?`).all(cf.id);
      res.json({
        success: true,
        cotacao: { numero: cf.numero, descricao: cf.cotDescricao, dataLimite: cf.dataLimite },
        fornecedor: cf.fornecedorNome,
        jaRespondeu: cf.status === 'respondida',
        itens, respostas
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/cotacao-publica/:token', (req, res) => {
    try {
      const cf = acharPorToken(req.params.token);
      if (!cf) return res.status(404).json({ success: false, error: 'Cotação não encontrada' });
      if (!['enviada', 'em_resposta'].includes(cf.cotStatus)) {
        return res.status(410).json({ success: false, error: 'Esta cotação foi encerrada' });
      }
      if (cf.dataLimite && cf.dataLimite < dataBrasilia()) {
        return res.status(410).json({ success: false, error: `Prazo encerrado em ${cf.dataLimite}` });
      }

      const { respostas, declinar, observacao } = req.body || {};
      const hoje = dataBrasilia();
      if (declinar) {
        db.prepare(`UPDATE cotacao_fornecedores SET status = 'declinada', dataResposta = ?, observacaoFornecedor = ? WHERE id = ?`)
          .run(hoje, (observacao || '').slice(0, 500), cf.id);
        return res.json({ success: true, declinada: true });
      }
      if (!Array.isArray(respostas) || !respostas.length) {
        return res.status(400).json({ success: false, error: 'Informe as respostas ou decline' });
      }
      const itensDaCotacao = db.prepare('SELECT id, quantidade FROM cotacao_itens WHERE cotacaoId = ?').all(cf.cotacaoId);
      const itensValidos = new Set(itensDaCotacao.map(x => x.id));
      const itensQtd = new Map(itensDaCotacao.map(x => [x.id, x.quantidade]));
      let gravadas = 0;
      const tx = db.transaction(() => {
        const up = db.prepare(`INSERT INTO cotacao_respostas
            (cotacaoFornecedorId, cotacaoItemId, precoUnitario, prazoEntregaDias, marcaOferecida, observacao, quantidadeDisponivel)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(cotacaoFornecedorId, cotacaoItemId) DO UPDATE SET
            precoUnitario = excluded.precoUnitario,
            prazoEntregaDias = excluded.prazoEntregaDias,
            marcaOferecida = excluded.marcaOferecida,
            observacao = excluded.observacao,
            quantidadeDisponivel = excluded.quantidadeDisponivel`);
        for (const r of respostas) {
          if (!itensValidos.has(Number(r.cotacaoItemId))) continue;
          const preco = Number(r.precoUnitario);
          if (!(preco > 0)) continue;
          // Nunca acima do que foi pedido: prometer 500 de uma necessidade de
          // 100 só sujaria o rateio.
          const disp = normalizarDisponivel(r.quantidadeDisponivel, itensQtd.get(Number(r.cotacaoItemId)));
          up.run(cf.id, Number(r.cotacaoItemId), preco,
            r.prazoEntregaDias != null ? Number(r.prazoEntregaDias) : null,
            (r.marcaOferecida || '').slice(0, 120) || null,
            (r.observacao || '').slice(0, 500) || null,
            disp);
          gravadas++;
        }
        if (gravadas > 0) {
          db.prepare(`UPDATE cotacao_fornecedores SET status = 'respondida', dataResposta = ?, observacaoFornecedor = ? WHERE id = ?`)
            .run(hoje, (observacao || '').slice(0, 500) || null, cf.id);
          db.prepare(`UPDATE cotacoes SET status = 'em_resposta', dataAtualizacao = CURRENT_TIMESTAMP
            WHERE id = ? AND status = 'enviada'`).run(cf.cotacaoId);
        }
      });
      tx();
      if (!gravadas) return res.status(400).json({ success: false, error: 'Nenhuma resposta válida (preço > 0)' });
      res.json({ success: true, gravadas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasCotacoes, registrarRotasCotacaoPublica, migrarCotacoesDB,
  validarRateio, sugerirRateio, disponivelDoItem, normalizarDisponivel, proximoNumeroCotacao };
