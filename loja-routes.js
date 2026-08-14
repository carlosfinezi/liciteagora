/**
 * loja-routes.js — vitrine pública do cliente (módulo Varejo).
 *
 * Fase 1: catálogo somente leitura. O lojista escolhe o que publicar, ajusta
 * marca e cores, e recebe o contato pelo WhatsApp com o item já preenchido.
 * Não há carrinho, login de comprador nem pagamento — isso é fase 2, e o
 * pedido nascerá pela API de pedidos que o ERP já usa.
 *
 * A vitrine lê o MESMO catálogo que abastece o Mercado Livre: os mesmos
 * produtos, as mesmas fotos de produto_imagens. Publicar aqui não interfere
 * em anúncio nenhum — são duas saídas do mesmo dado.
 *
 * Duas famílias de rota, e a separação é de segurança, não de organização:
 *   - registrarRotasLojaPublica  -> pre-auth-routes, SEM login. Só devolve
 *     produto publicado e ativo, e nunca custo, margem ou fornecedor.
 *   - registrarRotasLojaAdmin    -> route-registry, atrás da barreira.
 */

const path = require('path');
const multer = require('multer');
const imgs = require('./produto-imagens');
const { requirePortalAuth } = require('./portal-routes');
const { resolverPreco } = require('./precos-routes');
const { gerarNumero, recalcularTotal } = require('./pedidos-routes');
const { resolverDeposito } = require('./estoque-routes');
const { criarReservasPedido } = require('./reservas-routes');

const RAIZ_PUBLICA = path.join(__dirname, 'public');
const SUBDIR_LOJA = 'uploads/loja';

// Tema padrão. Poucos valores, todos viram variável CSS na página — o lojista
// escolhe valores, o layout continua sendo nosso.
const TEMA_PADRAO = {
  preset: 'neutro',
  corPrimaria: '#0E6B63',
  fundo: 'claro',        // claro | escuro
  fonte: 'neutra',       // neutra | tecnica | editorial
  raio: 10,
};

const PRESETS = {
  neutro:     { corPrimaria: '#0E6B63', fundo: 'claro',  fonte: 'neutra',    raio: 10 },
  industrial: { corPrimaria: '#B4531A', fundo: 'escuro', fonte: 'tecnica',   raio: 4 },
  vivo:       { corPrimaria: '#1D4ED8', fundo: 'claro',  fonte: 'editorial', raio: 16 },
};

const alterSafe = (db, sql) => {
  try { db.exec(sql); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
};

// Modos de cobrança. 'nenhum' mantém o comportamento B2B: o pedido vai para
// conferência e a cobrança sai pela régua do financeiro, como sempre.
const MODOS_PAGAMENTO = ['nenhum', 'pix', 'boleto', 'pix-ou-boleto'];

function migrarLojaDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loja_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ativa INTEGER NOT NULL DEFAULT 0,
      nome TEXT,
      descricao TEXT,
      logoPath TEXT,
      whatsapp TEXT,
      email TEXT,
      telefone TEXT,
      mostrarPreco INTEGER NOT NULL DEFAULT 0,
      mostrarEstoque INTEGER NOT NULL DEFAULT 1,
      tema TEXT,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  // Cobrança no checkout é opt-in e por loja: em B2B o normal é o lojista
  // conferir antes de cobrar; em venda avulsa, cobrar na hora é o que fecha.
  alterSafe(db, "ALTER TABLE loja_config ADD COLUMN pagamentoModo TEXT DEFAULT 'nenhum'");
  alterSafe(db, 'ALTER TABLE loja_config ADD COLUMN pagamentoVencimentoDias INTEGER DEFAULT 3');
  db.prepare('INSERT OR IGNORE INTO loja_config (id, tema) VALUES (1, ?)')
    .run(JSON.stringify(TEMA_PADRAO));
  // Publicar é opt-in: catálogo inteiro no ar por engano é vazamento de
  // preço e de linha de produto.
  try { db.exec('ALTER TABLE produtos ADD COLUMN publicadoNaLoja INTEGER DEFAULT 0'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  // Carrinho no servidor, não no navegador: o comprador monta no celular e
  // fecha no computador, e o lojista consegue ver carrinho abandonado.
  db.exec(`
    CREATE TABLE IF NOT EXISTS loja_carrinho (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pessoaId INTEGER NOT NULL,
      produtoId INTEGER NOT NULL,
      quantidade REAL NOT NULL DEFAULT 1,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pessoaId, produtoId)
    );
    CREATE INDEX IF NOT EXISTS idx_loja_carrinho_pessoa ON loja_carrinho(pessoaId);
  `);
  // Marca a origem sem mexer em `tipo`, que já tem consumidores esperando
  // 'manual' e 'licitacao'.
  try { db.exec('ALTER TABLE pedidos ADD COLUMN origemLoja INTEGER DEFAULT 0'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

const jsonOu = (t, padrao) => { try { return t ? JSON.parse(t) : padrao; } catch { return padrao; } };

function lerConfig(db) {
  const c = db.prepare('SELECT * FROM loja_config WHERE id = 1').get() || {};
  return { ...c, tema: { ...TEMA_PADRAO, ...jsonOu(c.tema, {}) } };
}

/**
 * Saldo que o comprador pode contar: entradas menos saídas, menos o que já
 * está reservado para outro pedido. Mostrar o saldo cru é como vender assento
 * já ocupado — a mesma conta do resto do ERP.
 */
function disponivelDe(db, produtoId) {
  try {
    const s = db.prepare(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN quantidade
        WHEN tipo='saida' THEN -quantidade ELSE quantidade END), 0) s
      FROM movimentacoes_estoque WHERE produtoId = ?`).get(produtoId).s;
    const r = db.prepare(`SELECT COALESCE(SUM(quantidade),0) q FROM reservas_estoque
      WHERE produtoId = ? AND status = 'ativa'`).get(produtoId).q;
    return Math.max(0, Number(s) - Number(r));
  } catch { return 0; }
}

// Quantidade exata é inteligência de negócio: o concorrente também abre a
// vitrine. O comprador precisa saber se dá para comprar, não quanto existe.
function rotuloEstoque(qtd) {
  if (qtd <= 0) return 'sob-consulta';
  if (qtd <= 3) return 'ultimas';
  return 'disponivel';
}

// O comprador escolhe entre o que a loja aceita; fora disso, manda a loja.
function escolherForma(modo, pedida) {
  if (modo === 'pix' || modo === 'boleto') return modo;
  return pedida === 'boleto' ? 'boleto' : 'pix';
}

const somaDias = (n) => {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000 + (Number(n) || 0) * 86400000);
  return d.toISOString().slice(0, 10);
};

/**
 * Gera a conta a receber do pedido e emite Pix ou boleto por ela.
 *
 * Reusa a régua do financeiro inteira: a CR fica amarrada ao pedido, a emissão
 * passa pelo provedor configurado (Asaas, Sicredi, Mercado Pago) e a baixa vem
 * pelo webhook que já existe. Nada de um caminho de pagamento paralelo.
 */
async function emitirCobranca(db, { pedidoId, pessoaId, valor, numero, forma, vencimentoDias }) {
  const orq = require('./boleto-orchestrator');
  const hoje = somaDias(0);
  const crId = db.prepare(`INSERT INTO contas_a_receber
      (pessoaId, descricao, valor, valorPago, dataEmissao, dataVencimento, status, origem,
       origemTipo, pedidoId, dataAtualizacao)
    VALUES (?, ?, ?, 0, ?, ?, 'aberta', 'loja', 'pedido', ?, CURRENT_TIMESTAMP)`)
    .run(pessoaId, `Pedido ${numero} — loja virtual`, valor, hoje,
         somaDias(vencimentoDias ?? 3), pedidoId).lastInsertRowid;

  const r = forma === 'boleto'
    ? await orq.emitirBoletoParaCR(db, crId)
    : await orq.emitirCobrancaPixParaCR(db, crId);

  // skipped = falta conta financeira ou provedor sem suporte. A CR fica de pé
  // para o financeiro cobrar do jeito de sempre.
  if (r?.skipped) return { contaReceberId: crId, forma, pendente: true, motivo: r.motivo };
  return {
    contaReceberId: crId, forma,
    pixPayload: r?.pixPayload || null, pixQrImage: r?.pixQrImage || null,
    linhaDigitavel: r?.linhaDigitavel || r?.codigoBarras || null,
    url: r?.invoiceUrl || r?.urlBoleto || r?.linkPagamento || null,
    vencimento: somaDias(vencimentoDias ?? 3),
  };
}

// ==================== PÚBLICO (sem login) ====================

function registrarRotasLojaPublica(app, db) {
  // Sem migrarLojaDB aqui: no boot o `db` é o proxy com stubs, e criar tabela
  // nesse contexto é no-op silencioso. O schema vem de applyRouteMigrations
  // (tenant novo) e de scripts/migrate-loja.js (tenants existentes).

  // A sessão do portal pode ou não existir numa rota pública — daí a leitura
  // direta em vez do middleware, que responderia 401 ao visitante.
  const pessoaLogada = (req) => {
    if (!req.session?.clienteLoginId) return null;
    try {
      const c = db.prepare('SELECT pessoaId FROM cliente_logins WHERE id = ? AND ativo = 1')
        .get(req.session.clienteLoginId);
      return c ? c.pessoaId : null;
    } catch { return null; }
  };

  const precoVisivel = (cfg, produto, pessoaId) => {
    if (pessoaId) return resolverPreco(db, produto.id, { pessoaId, quantidade: 1 }).preco;
    return cfg.mostrarPreco ? Number(produto.precoVenda) || 0 : null;
  };

  const fotosDe = (produtoId, imagemPath) => {
    try {
      const g = db.prepare('SELECT caminho FROM produto_imagens WHERE produtoId = ? ORDER BY ordem').all(produtoId);
      if (g.length) return g.map(x => x.caminho);
    } catch { /* instalação sem a tabela de imagens */ }
    return imagemPath ? [imagemPath] : [];
  };

  app.get('/loja/api/config', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });
      // Só o que a página precisa: nada de e-mail interno ou flags de gestão.
      res.json({ success: true, loja: {
        nome: c.nome || 'Catálogo', descricao: c.descricao || null, logo: c.logoPath || null,
        whatsapp: c.whatsapp || null, email: c.email || null, telefone: c.telefone || null,
        mostrarPreco: !!c.mostrarPreco, mostrarEstoque: !!c.mostrarEstoque, tema: c.tema,
        pagamento: c.pagamentoModo || 'nenhum',
      } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/loja/api/produtos', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });

      const q = String(req.query.q || '').trim().toLowerCase();
      const categoria = String(req.query.categoria || '').trim();
      // Lista de colunas explícita: SELECT * aqui publicaria precoCusto e
      // markup para a internet inteira.
      let sql = `SELECT id, sku, descricao, marca, modelo, categoria, unidade, precoVenda, imagemPath
        FROM produtos WHERE ativo = 1 AND publicadoNaLoja = 1`;
      const args = [];
      if (categoria) { sql += ' AND categoria = ?'; args.push(categoria); }
      sql += ' ORDER BY descricao';
      let linhas = db.prepare(sql).all(...args);
      if (q) {
        linhas = linhas.filter(p => ['descricao', 'sku', 'marca', 'modelo']
          .some(k => String(p[k] || '').toLowerCase().includes(q)));
      }

      // Cliente logado sempre vê preço, e o preço DELE: é a razão de existir
      // login numa vitrine B2B. Visitante anônimo depende da chave do lojista.
      const pessoaId = pessoaLogada(req);
      const produtos = linhas.map(p => {
        const disp = disponivelDe(db, p.id);
        return {
          id: p.id, sku: p.sku, descricao: p.descricao, marca: p.marca, modelo: p.modelo,
          categoria: p.categoria, unidade: p.unidade,
          preco: precoVisivel(c, p, pessoaId),
          estoque: c.mostrarEstoque ? rotuloEstoque(disp) : null,
          fotos: fotosDe(p.id, p.imagemPath),
        };
      });
      const categorias = [...new Set(linhas.map(p => (p.categoria || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'pt-BR'));
      res.json({ success: true, total: produtos.length, categorias, produtos });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ---------- área do comprador (login do portal) ----------
  // O comprador da vitrine é o mesmo cliente do portal: mesma tabela de
  // login, mesma sessão. Um segundo cadastro de senha seria mais uma senha
  // para o cliente esquecer e mais um lugar para revogar acesso.
  const compradorAuth = requirePortalAuth(db);

  const itensDoCarrinho = (pessoaId) => {
    const linhas = db.prepare(`SELECT c.produtoId, c.quantidade, p.sku, p.descricao, p.unidade, p.imagemPath
      FROM loja_carrinho c JOIN produtos p ON p.id = c.produtoId
      WHERE c.pessoaId = ? AND p.ativo = 1 AND p.publicadoNaLoja = 1
      ORDER BY p.descricao`).all(pessoaId);
    return linhas.map(l => {
      // Preço resolvido item a item: a faixa de quantidade muda o valor, e
      // congelar o preço na entrada do carrinho esconderia isso do comprador.
      const r = resolverPreco(db, l.produtoId, { pessoaId, quantidade: l.quantidade });
      const disp = disponivelDe(db, l.produtoId);
      return {
        produtoId: l.produtoId, sku: l.sku, descricao: l.descricao, unidade: l.unidade,
        foto: l.imagemPath || null, quantidade: l.quantidade,
        preco: r.preco, total: Number((r.preco * l.quantidade).toFixed(2)),
        fontePreco: r.fonte, tabelaNome: r.tabelaNome || null,
        disponivel: disp, suficiente: disp >= l.quantidade,
      };
    });
  };

  app.get('/loja/api/eu', compradorAuth, (req, res) => {
    res.json({ success: true, cliente: { nome: req.cliente.razaoSocial, email: req.cliente.email } });
  });

  app.get('/loja/api/carrinho', compradorAuth, (req, res) => {
    try {
      const itens = itensDoCarrinho(req.cliente.pessoaId);
      res.json({ success: true, itens, total: Number(itens.reduce((s, i) => s + i.total, 0).toFixed(2)) });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/loja/api/carrinho', compradorAuth, (req, res) => {
    try {
      const produtoId = Number(req.body?.produtoId);
      const qtd = Number(req.body?.quantidade);
      const p = db.prepare('SELECT id FROM produtos WHERE id = ? AND ativo = 1 AND publicadoNaLoja = 1').get(produtoId);
      if (!p) return res.status(404).json({ success: false, error: 'Produto não está na vitrine' });
      if (!(qtd > 0)) {
        db.prepare('DELETE FROM loja_carrinho WHERE pessoaId = ? AND produtoId = ?').run(req.cliente.pessoaId, produtoId);
      } else {
        db.prepare(`INSERT INTO loja_carrinho (pessoaId, produtoId, quantidade) VALUES (?,?,?)
          ON CONFLICT(pessoaId, produtoId) DO UPDATE SET quantidade = excluded.quantidade,
            dataAtualizacao = CURRENT_TIMESTAMP`).run(req.cliente.pessoaId, produtoId, qtd);
      }
      const itens = itensDoCarrinho(req.cliente.pessoaId);
      res.json({ success: true, itens, total: Number(itens.reduce((s, i) => s + i.total, 0).toFixed(2)) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  /**
   * Fecha o carrinho como pedido do ERP. Nasce em rascunho, com reserva de
   * estoque — o lojista confirma na tela de pedidos que já usa. Não é um
   * registro paralelo: mesma tabela, mesma numeração, mesmo fluxo.
   */
  app.post('/loja/api/pedido', compradorAuth, async (req, res) => {
    try {
      const pessoaId = req.cliente.pessoaId;
      const itens = itensDoCarrinho(pessoaId);
      if (!itens.length) return res.status(400).json({ success: false, error: 'Seu carrinho está vazio' });

      // Conferência no fechamento, não na exibição: entre montar o carrinho e
      // enviar, o balcão pode ter vendido a mesma peça.
      const faltando = itens.filter(i => !i.suficiente);
      if (faltando.length) {
        return res.status(409).json({ success: false, semEstoque: faltando.map(i => ({
          descricao: i.descricao, pedido: i.quantidade, disponivel: i.disponivel })),
          error: 'Alguns itens não têm mais a quantidade pedida' });
      }

      const observacao = ['[Loja virtual]', String(req.body?.observacao || '').trim()].filter(Boolean).join(' ');
      const pedidoId = db.transaction(() => {
        const numero = gerarNumero(db, 'pedido');
        const id = db.prepare(`INSERT INTO pedidos
            (numero, tipo, modoDocumento, clienteId, status, dataPedido, observacao, depositoId, origemLoja)
          VALUES (?, 'manual', 'pedido', ?, 'rascunho', date('now','-3 hours'), ?, ?, 1)`)
          .run(numero, pessoaId, observacao.slice(0, 500), resolverDeposito(db, {})).lastInsertRowid;
        const ins = db.prepare(`INSERT INTO pedido_itens
            (pedidoId, produtoId, descricao, quantidade, precoUnitario, valorTotal) VALUES (?,?,?,?,?,?)`);
        for (const i of itens) ins.run(id, i.produtoId, i.descricao, i.quantidade, i.preco, i.total);
        recalcularTotal(db, id);
        db.prepare('DELETE FROM loja_carrinho WHERE pessoaId = ?').run(pessoaId);
        return id;
      })();

      // A reserva é o que impede vender a mesma peça duas vezes. Se falhar, o
      // pedido continua válido — e o lojista vê a falta na conferência.
      let reserva = null;
      try { reserva = criarReservasPedido(db, pedidoId); }
      catch (e) { reserva = { erro: e.message }; }

      const p = db.prepare('SELECT numero, valorTotal FROM pedidos WHERE id = ?').get(pedidoId);

      // Cobrança, quando o lojista pediu. Falhar aqui não invalida o pedido:
      // ele já existe e o financeiro cobra depois — o comprador precisa saber
      // disso em vez de ver um erro e achar que não comprou.
      const c = lerConfig(db);
      let cobranca = null;
      if (c.pagamentoModo && c.pagamentoModo !== 'nenhum' && p.valorTotal > 0) {
        const forma = escolherForma(c.pagamentoModo, req.body?.formaPagamento);
        try { cobranca = await emitirCobranca(db, { pedidoId, pessoaId, valor: p.valorTotal,
          numero: p.numero, forma, vencimentoDias: c.pagamentoVencimentoDias }); }
        catch (e) { cobranca = { erro: e.message }; }
      }

      res.json({ success: true, pedidoId, numero: p.numero, valorTotal: p.valorTotal,
                 reservado: !reserva?.erro, insuficiencias: reserva?.insuficiencias || [],
                 cobranca });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.get('/loja/api/meus-pedidos', compradorAuth, (req, res) => {
    try {
      // Traz o estado da cobrança junto: "meu pedido" e "meu boleto" são a
      // mesma pergunta para quem comprou.
      const linhas = db.prepare(`SELECT p.id, p.numero, p.status, p.dataPedido, p.valorTotal,
          (SELECT cr.status FROM contas_a_receber cr WHERE cr.pedidoId = p.id ORDER BY cr.id DESC LIMIT 1) AS pagamento
        FROM pedidos p WHERE p.clienteId = ? AND COALESCE(p.origemLoja,0) = 1
        ORDER BY p.id DESC LIMIT 20`).all(req.cliente.pessoaId);
      res.json({ success: true, pedidos: linhas });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // Reabrir a cobrança: o comprador fecha a aba antes de pagar o Pix, e o QR
  // tem que estar em algum lugar que ele alcance sozinho.
  app.get('/loja/api/pedido/:id/cobranca', compradorAuth, (req, res) => {
    try {
      const p = db.prepare(`SELECT id, numero FROM pedidos
        WHERE id = ? AND clienteId = ? AND COALESCE(origemLoja,0) = 1`)
        .get(req.params.id, req.cliente.pessoaId);
      if (!p) return res.status(404).json({ success: false, error: 'Pedido não encontrado' });
      const cr = db.prepare(`SELECT id, status, valor, dataVencimento FROM contas_a_receber
        WHERE pedidoId = ? ORDER BY id DESC LIMIT 1`).get(p.id);
      if (!cr) return res.json({ success: true, cobranca: null });
      let b = null;
      try {
        b = db.prepare(`SELECT tipoCobranca, pixPayload, pixQrImage, linhaDigitavel, externalUrl, status
          FROM boletos WHERE contaReceberId = ? ORDER BY id DESC LIMIT 1`).get(cr.id);
      } catch { /* instalação sem o módulo de boletos */ }
      res.json({ success: true, cobranca: {
        numero: p.numero, valor: cr.valor, vencimento: cr.dataVencimento,
        pago: cr.status === 'paga',
        forma: b?.tipoCobranca || null, pixPayload: b?.pixPayload || null,
        pixQrImage: b?.pixQrImage || null, linhaDigitavel: b?.linhaDigitavel || null,
        url: b?.externalUrl || null,
      } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.get('/loja/api/produtos/:id', (req, res) => {
    try {
      const c = lerConfig(db);
      if (!c.ativa) return res.status(404).json({ success: false, error: 'Loja não publicada' });
      const p = db.prepare(`SELECT id, sku, descricao, marca, modelo, categoria, unidade,
          precoVenda, imagemPath, observacoes, pesoBruto, altura, largura, profundidade
        FROM produtos WHERE id = ? AND ativo = 1 AND publicadoNaLoja = 1`).get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'Produto não encontrado' });
      const disp = disponivelDe(db, p.id);
      res.json({ success: true, produto: {
        ...p, precoVenda: undefined,
        preco: precoVisivel(c, p, pessoaLogada(req)),
        estoque: c.mostrarEstoque ? rotuloEstoque(disp) : null,
        fotos: fotosDe(p.id, p.imagemPath),
      } });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

// ==================== ADMIN (dentro do ERP) ====================

const uploadLogo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

function registrarRotasLojaAdmin(app, db) {
  migrarLojaDB(db);

  app.get('/api/loja/config', (req, res) => {
    try {
      const c = lerConfig(db);
      const publicados = db.prepare('SELECT COUNT(*) n FROM produtos WHERE ativo = 1 AND publicadoNaLoja = 1').get().n;
      const semFoto = db.prepare(`SELECT COUNT(*) n FROM produtos p WHERE p.ativo = 1 AND p.publicadoNaLoja = 1
        AND COALESCE(p.imagemPath,'') = ''
        AND NOT EXISTS (SELECT 1 FROM produto_imagens i WHERE i.produtoId = p.id)`).get().n;
      // Pedido da loja nasce em rascunho e fica esperando conferência: se
      // ninguém olhar, o comprador espera e o estoque segue reservado.
      let aguardando = 0;
      try {
        aguardando = db.prepare(`SELECT COUNT(*) n FROM pedidos
          WHERE COALESCE(origemLoja,0) = 1 AND status = 'rascunho'`).get().n;
      } catch { /* base ainda sem a coluna */ }
      res.json({ success: true, config: c, presets: PRESETS,
                 resumo: { publicados, semFoto, aguardando },
                 url: `${req.protocol}://${req.get('host')}/loja/` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.put('/api/loja/config', (req, res) => {
    try {
      const b = req.body || {};
      const atual = lerConfig(db);
      const tema = { ...atual.tema, ...(b.tema || {}) };
      if (!/^#[0-9a-f]{6}$/i.test(String(tema.corPrimaria || ''))) {
        return res.status(400).json({ success: false, error: 'Cor principal deve estar no formato #RRGGBB' });
      }
      tema.raio = Math.max(0, Math.min(24, Number(tema.raio) || 0));
      if (!['claro', 'escuro'].includes(tema.fundo)) tema.fundo = 'claro';
      if (!['neutra', 'tecnica', 'editorial'].includes(tema.fonte)) tema.fonte = 'neutra';

      const modo = MODOS_PAGAMENTO.includes(b.pagamentoModo) ? b.pagamentoModo : (atual.pagamentoModo || 'nenhum');
      const venc = Math.max(0, Math.min(60, Number(b.pagamentoVencimentoDias ?? atual.pagamentoVencimentoDias ?? 3)));
      db.prepare('UPDATE loja_config SET pagamentoModo=?, pagamentoVencimentoDias=? WHERE id=1').run(modo, venc);

      const txt = (v, max) => v == null ? null : String(v).trim().slice(0, max) || null;
      db.prepare(`UPDATE loja_config SET ativa=?, nome=?, descricao=?, whatsapp=?, email=?, telefone=?,
          mostrarPreco=?, mostrarEstoque=?, tema=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1`)
        .run(b.ativa ? 1 : 0, txt(b.nome, 80), txt(b.descricao, 300),
             // Só dígitos no WhatsApp: o link do wa.me não aceita máscara.
             b.whatsapp != null ? String(b.whatsapp).replace(/\D/g, '').slice(0, 15) || null : atual.whatsapp,
             txt(b.email, 120), txt(b.telefone, 40),
             b.mostrarPreco ? 1 : 0, b.mostrarEstoque ? 1 : 0, JSON.stringify(tema));
      res.json({ success: true, config: lerConfig(db) });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.post('/api/loja/logo', uploadLogo.single('logo'), (req, res) => {
    try {
      if (!req.file?.buffer) return res.status(400).json({ success: false, error: 'Envie o arquivo do logotipo' });
      // Assinatura do arquivo, não o content-type declarado — mesma regra da
      // foto de produto. Extensão mente; os primeiros bytes, não.
      const ext = imgs.tipoReal(req.file.buffer);
      if (!ext) return res.status(400).json({ success: false, error: 'O arquivo não é uma imagem JPEG, PNG, WEBP ou GIF' });
      const fs = require('fs');
      const dir = path.join(RAIZ_PUBLICA, SUBDIR_LOJA);
      fs.mkdirSync(dir, { recursive: true });
      const nome = 'logo-' + Date.now() + ext;
      fs.writeFileSync(path.join(dir, nome), req.file.buffer);
      const caminho = '/' + SUBDIR_LOJA + '/' + nome;
      db.prepare('UPDATE loja_config SET logoPath=?, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run(caminho);
      res.json({ success: true, logo: caminho });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.delete('/api/loja/logo', (req, res) => {
    try {
      db.prepare('UPDATE loja_config SET logoPath=NULL, dataAtualizacao=CURRENT_TIMESTAMP WHERE id=1').run();
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Lista para o lojista escolher o que vai ao ar. Traz o que decide a
  // escolha: tem foto? tem preço? tem saldo?
  app.get('/api/loja/produtos', (req, res) => {
    try {
      const filtro = String(req.query.filtro || '');
      let sql = `SELECT p.id, p.sku, p.descricao, p.marca, p.categoria, p.precoVenda,
          COALESCE(p.publicadoNaLoja,0) AS publicado, p.imagemPath,
          (SELECT COUNT(*) FROM produto_imagens i WHERE i.produtoId = p.id) AS nFotos
        FROM produtos p WHERE p.ativo = 1`;
      if (filtro === 'publicados') sql += ' AND COALESCE(p.publicadoNaLoja,0) = 1';
      if (filtro === 'fora') sql += ' AND COALESCE(p.publicadoNaLoja,0) = 0';
      sql += ' ORDER BY p.descricao LIMIT 500';
      const produtos = db.prepare(sql).all().map(p => ({
        ...p, publicado: !!p.publicado,
        temFoto: !!(p.nFotos || p.imagemPath),
        disponivel: disponivelDe(db, p.id),
      }));
      res.json({ success: true, produtos });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/loja/produtos/publicar', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ success: false, error: 'Selecione os produtos' });
      const publicado = req.body?.publicado ? 1 : 0;
      const stmt = db.prepare('UPDATE produtos SET publicadoNaLoja = ?, dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?');
      const tx = db.transaction((lista) => { for (const id of lista) stmt.run(publicado, id); });
      tx(ids);
      res.json({ success: true, alterados: ids.length, publicado: !!publicado });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });
}

module.exports = {
  migrarLojaDB, registrarRotasLojaPublica, registrarRotasLojaAdmin,
  disponivelDe, rotuloEstoque, TEMA_PADRAO, PRESETS, SUBDIR_LOJA,
};
