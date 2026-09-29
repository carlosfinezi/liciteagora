/**
 * loja-montagem.js — produto que o cliente MONTA na loja (o "monte seu buquê").
 *
 * Um produto montável é um kit sem composição fixa: quem decide o que vai
 * dentro é o cliente, na hora da compra. O lojista declara quatro coisas:
 *
 *   formatos  — Avulsa, Cone, Buquê… Cada um com a sua TABELA de preço por
 *               quantidade. O preço é o da linha da tabela, e não unidade vezes
 *               quantidade: 7 rosas custam R$ 189,90 porque a tabela diz, e
 *               quantidade que não está na tabela não se vende.
 *   cores     — cada cor aponta para o item de estoque que sai (a rosa
 *               vermelha, a branca…). A cor "mix" não tem item próprio: reparte
 *               a quantidade entre as outras cores, uma de cada em rodízio.
 *   insumos   — o que cada formato gasta além das flores (papel, fita, cone).
 *   adicionais — NÃO moram aqui: são os grupos de personalização que qualquer
 *               produto já tem (rest_grupos_opcao), com preço e insumo próprios.
 *
 * Nada disto tem tabela de pedido própria. A composição escolhida vira linhas
 * de `pedido_item_opcoes` com o insumo, e é a explosão que já existe
 * (reservas-routes.explodirItensPedido) que reserva, baixa e grava o custo de
 * cada rosa. O produto montável em si tem `tipoProduto = 'kit'` sem
 * componentes: a explosão não empurra nada além das linhas da montagem.
 */

const r2c = (v) => Math.round((Number(v) || 0) * 100) / 100;

function migrarMontagem(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS loja_montaveis (
      produtoId INTEGER PRIMARY KEY,
      unidade TEXT NOT NULL DEFAULT 'flor',
      plural TEXT NOT NULL DEFAULT 'flores',
      ordem INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1,
      criadoEm TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS loja_montavel_formatos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      ordem INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lmf_produto ON loja_montavel_formatos(produtoId);
    CREATE TABLE IF NOT EXISTS loja_montavel_precos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formatoId INTEGER NOT NULL,
      quantidade INTEGER NOT NULL,
      preco REAL NOT NULL,
      UNIQUE (formatoId, quantidade)
    );
    CREATE TABLE IF NOT EXISTS loja_montavel_insumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      formatoId INTEGER NOT NULL,
      insumoProdutoId INTEGER NOT NULL,
      quantidade REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS loja_montavel_cores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produtoId INTEGER NOT NULL,
      nome TEXT NOT NULL,
      corHex TEXT,
      insumoProdutoId INTEGER,
      mix INTEGER NOT NULL DEFAULT 0,
      ordem INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lmc_produto ON loja_montavel_cores(produtoId);
  `);
}

function ehMontavel(db, produtoId) {
  try {
    return !!db.prepare('SELECT 1 FROM loja_montaveis WHERE produtoId = ? AND ativo = 1').get(produtoId);
  } catch { return false; }   // tenant sem a tabela: nada é montável
}

/** A configuração inteira de um montável, como está no banco. */
function lerMontavel(db, produtoId) {
  const m = db.prepare('SELECT * FROM loja_montaveis WHERE produtoId = ?').get(produtoId);
  if (!m) return null;
  const formatos = db.prepare(`SELECT id, nome, descricao, ordem FROM loja_montavel_formatos
    WHERE produtoId = ? ORDER BY ordem, id`).all(produtoId);
  const precos = db.prepare('SELECT quantidade, preco FROM loja_montavel_precos WHERE formatoId = ? ORDER BY quantidade');
  const insumos = db.prepare('SELECT insumoProdutoId, quantidade FROM loja_montavel_insumos WHERE formatoId = ? ORDER BY id');
  for (const f of formatos) {
    f.precos = precos.all(f.id).map((p) => ({ quantidade: p.quantidade, preco: r2c(p.preco) }));
    f.insumos = insumos.all(f.id);
  }
  const cores = db.prepare(`SELECT id, nome, corHex, insumoProdutoId, mix, ordem FROM loja_montavel_cores
    WHERE produtoId = ? ORDER BY ordem, id`).all(produtoId)
    .map((c) => ({ ...c, mix: !!c.mix }));
  return { produtoId, unidade: m.unidade, plural: m.plural, ordem: m.ordem, ativo: !!m.ativo, formatos, cores };
}

/**
 * Reparte `n` flores entre as cores, para o "mix".
 *
 * Uma de cada cor, em rodízio, na ordem das cores, pulando a que acabou.
 * Devolve Map insumoProdutoId → quantidade, ou null se o estoque somado não
 * fecha a conta. Usa só as cores com item de estoque (o próprio mix não tem).
 */
function repartirMix(cores, n, disponivelDe) {
  const fontes = cores.filter((c) => !c.mix && c.insumoProdutoId)
    .map((c) => ({ id: c.insumoProdutoId, nome: c.nome, resta: disponivelDe(c.insumoProdutoId), usa: 0 }))
    .filter((f) => f.resta > 0);
  if (!fontes.length) return null;
  let i = 0;
  for (let colocadas = 0; colocadas < n; colocadas++) {
    let tentativas = 0;
    while (fontes[i % fontes.length].resta <= 0) {
      i++;
      if (++tentativas > fontes.length) return null;   // acabou tudo antes de fechar
    }
    const f = fontes[i % fontes.length];
    f.usa++; f.resta--; i++;
  }
  return fontes.filter((f) => f.usa > 0);
}

/**
 * As flores que a cor escolhida tira do estoque, para `n` unidades.
 * @returns {Array<{produtoId:number,nome:string,quantidade:number}>|null}
 */
function floresDaCor(cor, cores, n, disponivelDe) {
  if (cor.mix) {
    const partes = repartirMix(cores, n, disponivelDe);
    return partes ? partes.map((p) => ({ produtoId: p.id, nome: p.nome, quantidade: p.usa })) : null;
  }
  if (!cor.insumoProdutoId) return null;
  if (disponivelDe(cor.insumoProdutoId) < n) return null;
  return [{ produtoId: cor.insumoProdutoId, nome: cor.nome, quantidade: n }];
}

const nomeProduto = (db, id) => (db.prepare('SELECT descricao FROM produtos WHERE id = ?').get(id) || {}).descricao || null;

/**
 * O montável para a vitrine: formatos com a tabela, cores com as quantidades
 * que o estoque fecha, e nenhum número de estoque. Quantas rosas vermelhas há
 * é informação do lojista; o visitante recebe só o que pode escolher.
 */
function montavelPublico(db, produtoId, { mostrarPreco, disponivelDe }) {
  const m = lerMontavel(db, produtoId);
  if (!m || !m.ativo) return null;
  const todas = [...new Set(m.formatos.flatMap((f) => f.precos.map((p) => p.quantidade)))].sort((a, b) => a - b);
  return {
    produtoId,
    unidade: m.unidade, plural: m.plural,
    formatos: m.formatos.filter((f) => f.precos.length).map((f) => ({
      id: f.id, nome: f.nome, descricao: f.descricao || null,
      precos: f.precos.map((p) => ({ quantidade: p.quantidade, preco: mostrarPreco ? p.preco : null })),
    })),
    cores: m.cores.map((c) => ({
      id: c.id, nome: c.nome, corHex: c.corHex || null, mix: c.mix,
      // Cor sem estoque nenhum sai com a lista vazia, e a tela a apaga.
      quantidades: todas.filter((q) => floresDaCor(c, m.cores, q, disponivelDe)),
    })),
  };
}

/** Menor preço da tabela: é o "a partir de" do card na vitrine. */
function precoInicial(db, produtoId) {
  try {
    const r = db.prepare(`SELECT MIN(p.preco) m FROM loja_montavel_precos p
      JOIN loja_montavel_formatos f ON f.id = p.formatoId WHERE f.produtoId = ?`).get(produtoId);
    return r && r.m != null ? r2c(r.m) : null;
  } catch { return null; }
}

const DATA_OK = /^\d{4}-\d{2}-\d{2}$/;

/** A data desejada, se for uma data de hoje em diante (Brasília) até 120 dias. */
function lerDataDesejada(bruto) {
  const s = String(bruto || '').trim();
  if (!s) return null;
  if (!DATA_OK.test(s)) return false;
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const limite = new Date(Date.now() - 3 * 3600 * 1000 + 120 * 86400000).toISOString().slice(0, 10);
  const d = new Date(s + 'T12:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return false;
  if (s < hoje || s > limite) return false;
  return s;
}

const dataBr = (s) => s.split('-').reverse().join('/');

/**
 * Confere a montagem que veio do navegador contra o banco e devolve o que o
 * pedido precisa: preço da tabela, texto da linha e os componentes de estoque.
 *
 * Do navegador vêm só referências (formato, quantidade, cor, data). O preço
 * nunca vem de lá, e a quantidade só vale se estiver na tabela DAQUELE formato.
 */
function resolverMontagem(db, produtoId, entrada, { disponivelDe, mostrarPreco }) {
  const m = lerMontavel(db, produtoId);
  if (!m || !m.ativo) return { erro: 'Este produto não está disponível para montar.' };
  const e = entrada || {};
  const formato = m.formatos.find((f) => f.id === Number(e.formatoId));
  if (!formato) return { erro: 'Esta montagem mudou na loja. Monte de novo.' };
  const qtd = Math.floor(Number(e.quantidade) || 0);
  const linha = formato.precos.find((p) => p.quantidade === qtd);
  if (!linha) return { erro: `${formato.nome} não tem opção com ${qtd} ${qtd === 1 ? m.unidade : m.plural}.` };

  let cor = null;
  if (m.cores.length > 1) {
    cor = m.cores.find((c) => c.id === Number(e.corId));
    if (!cor) return { erro: 'Escolha a cor.' };
  } else if (m.cores.length === 1) {
    cor = m.cores[0];                 // uma cor só (o girassol) não é escolha
  } else {
    return { erro: 'Este produto ainda não tem flores cadastradas.' };
  }
  const flores = floresDaCor(cor, m.cores, qtd, disponivelDe);
  if (!flores) return { erro: `Não temos ${qtd} ${qtd === 1 ? m.unidade : m.plural} ${m.cores.length > 1 ? cor.nome.toLowerCase() + ' ' : ''}agora. Escolha outra ${m.cores.length > 1 ? 'cor ou ' : ''}quantidade.` };

  const data = lerDataDesejada(e.dataDesejada);
  if (data === false) return { erro: 'Escolha uma data a partir de hoje.' };

  const componentes = [
    ...flores.map((f) => ({ grupo: 'Flores', nome: nomeProduto(db, f.produtoId) || f.nome, produtoId: f.produtoId, quantidade: f.quantidade })),
    ...formato.insumos.map((i) => ({ grupo: 'Montagem', nome: nomeProduto(db, i.insumoProdutoId), produtoId: i.insumoProdutoId, quantidade: Number(i.quantidade) })),
  ];
  const partes = [formato.nome, `${qtd} ${qtd === 1 ? m.unidade : m.plural}`];
  if (m.cores.length > 1) partes.push(cor.mix ? `${cor.nome} (${flores.map((f) => `${f.quantidade} ${String(f.nome).toLowerCase()}`).join(', ')})` : cor.nome);
  if (data) partes.push(`para ${dataBr(data)}`);
  return {
    preco: mostrarPreco ? linha.preco : null,
    detalhe: partes.join(', '),
    componentes,
    dataDesejada: data,
    montagem: { formatoId: formato.id, quantidade: qtd, corId: cor.id, dataDesejada: data },
  };
}

/** Grava a composição da montagem como insumos do item. Roda na transação do pedido. */
function gravarComponentes(db, pedidoId, pedidoItemId, componentes) {
  const ins = db.prepare(`INSERT INTO pedido_item_opcoes
      (pedidoId, pedidoItemId, grupoId, grupoNome, opcaoId, nome, texto, precoAdicional, insumoProdutoId, quantidadeInsumo)
    VALUES (?, ?, NULL, ?, NULL, ?, NULL, 0, ?, ?)`);
  for (const c of componentes || []) {
    if (!(Number(c.quantidade) > 0)) continue;
    ins.run(pedidoId, pedidoItemId, c.grupo, c.nome, c.produtoId, Number(c.quantidade));
  }
}

/* ===================== painel do lojista ===================== */

const txt = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Grava a configuração inteira de um montável numa transação.
 *
 * Formato e cor que chegam com `id` são atualizados no lugar; os que somem da
 * lista são apagados. Preservar o id importa: é ele que a sacola do visitante
 * guarda, e trocar todos a cada gravação invalidaria toda sacola aberta.
 */
function gravarMontavel(db, produtoId, b) {
  const unidade = txt(b.unidade, 30) || 'flor';
  const plural = txt(b.plural, 30) || unidade + 's';
  const formatos = Array.isArray(b.formatos) ? b.formatos : [];
  const cores = Array.isArray(b.cores) ? b.cores : [];
  const existeProduto = db.prepare('SELECT id FROM produtos WHERE id = ?');

  // Validação inteira antes de gravar qualquer coisa.
  if (!formatos.length) throw new Error('Cadastre ao menos um formato.');
  if (!cores.length) throw new Error('Cadastre ao menos uma flor ou cor.');
  for (const f of formatos) {
    if (!txt(f.nome, 60)) throw new Error('Todo formato precisa de nome.');
    const precos = Array.isArray(f.precos) ? f.precos : [];
    if (!precos.length) throw new Error(`O formato "${f.nome}" está sem tabela de preço.`);
    const vistas = new Set();
    for (const p of precos) {
      const q = Math.floor(Number(p.quantidade));
      if (!(q >= 1 && q <= 999) || String(q) !== String(Number(p.quantidade))) throw new Error(`Quantidade inválida em "${f.nome}".`);
      if (vistas.has(q)) throw new Error(`A quantidade ${q} aparece duas vezes em "${f.nome}".`);
      vistas.add(q);
      if (!(Number(p.preco) > 0)) throw new Error(`Preço inválido para ${q} em "${f.nome}".`);
    }
    for (const i of (Array.isArray(f.insumos) ? f.insumos : [])) {
      if (!existeProduto.get(Number(i.insumoProdutoId))) throw new Error(`Insumo inexistente em "${f.nome}".`);
      if (!(Number(i.quantidade) > 0)) throw new Error(`Quantidade de insumo inválida em "${f.nome}".`);
    }
  }
  let mixes = 0;
  for (const c of cores) {
    if (!txt(c.nome, 40)) throw new Error('Toda cor precisa de nome.');
    if (c.corHex && !HEX.test(c.corHex)) throw new Error(`Cor inválida em "${c.nome}".`);
    if (c.mix) { mixes++; continue; }
    if (!existeProduto.get(Number(c.insumoProdutoId))) throw new Error(`Escolha o item de estoque de "${c.nome}".`);
  }
  if (mixes > 1) throw new Error('Só pode haver um mix.');
  if (mixes && cores.filter((c) => !c.mix).length < 2) throw new Error('O mix precisa de ao menos duas cores com estoque.');

  db.transaction(() => {
    db.prepare(`INSERT INTO loja_montaveis (produtoId, unidade, plural, ativo) VALUES (?, ?, ?, 1)
      ON CONFLICT(produtoId) DO UPDATE SET unidade = excluded.unidade, plural = excluded.plural, ativo = 1`)
      .run(produtoId, unidade, plural);
    // Kit sem componentes: a explosão do pedido baixa só o que a montagem gravou.
    db.prepare("UPDATE produtos SET tipoProduto = 'kit' WHERE id = ?").run(produtoId);

    const idsF = [];
    formatos.forEach((f, ordem) => {
      let id = Number(f.id) || null;
      const dono = id && db.prepare('SELECT id FROM loja_montavel_formatos WHERE id = ? AND produtoId = ?').get(id, produtoId);
      if (dono) {
        db.prepare('UPDATE loja_montavel_formatos SET nome = ?, descricao = ?, ordem = ? WHERE id = ?')
          .run(txt(f.nome, 60), txt(f.descricao, 120) || null, ordem, id);
      } else {
        id = db.prepare('INSERT INTO loja_montavel_formatos (produtoId, nome, descricao, ordem) VALUES (?, ?, ?, ?)')
          .run(produtoId, txt(f.nome, 60), txt(f.descricao, 120) || null, ordem).lastInsertRowid;
      }
      idsF.push(Number(id));
      db.prepare('DELETE FROM loja_montavel_precos WHERE formatoId = ?').run(id);
      const insP = db.prepare('INSERT INTO loja_montavel_precos (formatoId, quantidade, preco) VALUES (?, ?, ?)');
      for (const p of f.precos) insP.run(id, Math.floor(Number(p.quantidade)), r2c(p.preco));
      db.prepare('DELETE FROM loja_montavel_insumos WHERE formatoId = ?').run(id);
      const insI = db.prepare('INSERT INTO loja_montavel_insumos (formatoId, insumoProdutoId, quantidade) VALUES (?, ?, ?)');
      for (const i of (f.insumos || [])) insI.run(id, Number(i.insumoProdutoId), Number(i.quantidade));
    });
    for (const velho of db.prepare('SELECT id FROM loja_montavel_formatos WHERE produtoId = ?').all(produtoId)) {
      if (idsF.includes(velho.id)) continue;
      db.prepare('DELETE FROM loja_montavel_precos WHERE formatoId = ?').run(velho.id);
      db.prepare('DELETE FROM loja_montavel_insumos WHERE formatoId = ?').run(velho.id);
      db.prepare('DELETE FROM loja_montavel_formatos WHERE id = ?').run(velho.id);
    }

    const idsC = [];
    cores.forEach((c, ordem) => {
      let id = Number(c.id) || null;
      const dono = id && db.prepare('SELECT id FROM loja_montavel_cores WHERE id = ? AND produtoId = ?').get(id, produtoId);
      const vals = [txt(c.nome, 40), c.corHex || null, c.mix ? null : Number(c.insumoProdutoId), c.mix ? 1 : 0, ordem];
      if (dono) {
        db.prepare('UPDATE loja_montavel_cores SET nome = ?, corHex = ?, insumoProdutoId = ?, mix = ?, ordem = ? WHERE id = ?')
          .run(...vals, id);
      } else {
        id = db.prepare('INSERT INTO loja_montavel_cores (nome, corHex, insumoProdutoId, mix, ordem, produtoId) VALUES (?, ?, ?, ?, ?, ?)')
          .run(...vals, produtoId).lastInsertRowid;
      }
      idsC.push(Number(id));
    });
    for (const velho of db.prepare('SELECT id FROM loja_montavel_cores WHERE produtoId = ?').all(produtoId)) {
      if (!idsC.includes(velho.id)) db.prepare('DELETE FROM loja_montavel_cores WHERE id = ?').run(velho.id);
    }
  })();
}

function registrarRotasMontagemAdmin(app, db) {
  const erro = (res, e, status = 400) => res.status(status).json({ success: false, error: e.message || String(e) });

  // Os montáveis e os produtos que podem virar um (ativos, sem composição de kit).
  app.get('/api/loja/montagem', (req, res) => {
    try {
      const ids = db.prepare('SELECT produtoId FROM loja_montaveis WHERE ativo = 1 ORDER BY ordem, produtoId').all();
      const montaveis = ids.map((r) => ({ ...lerMontavel(db, r.produtoId), descricao: nomeProduto(db, r.produtoId) }));
      const produtos = db.prepare(`SELECT p.id, p.descricao, p.sku, p.tipoProduto,
          (SELECT COUNT(*) FROM produto_kit_itens k WHERE k.produtoPaiId = p.id) AS componentes
        FROM produtos p WHERE p.ativo = 1 ORDER BY p.descricao`).all();
      res.json({ success: true, montaveis, produtos });
    } catch (e) { erro(res, e, 500); }
  });

  app.put('/api/loja/montagem/:produtoId', (req, res) => {
    try {
      const id = Number(req.params.produtoId);
      const p = db.prepare('SELECT id FROM produtos WHERE id = ? AND ativo = 1').get(id);
      if (!p) return erro(res, new Error('Produto não encontrado.'), 404);
      const comps = db.prepare('SELECT COUNT(*) n FROM produto_kit_itens WHERE produtoPaiId = ?').get(id).n;
      if (comps) return erro(res, new Error('Este produto é um kit com composição fixa. Use um produto sem componentes.'));
      gravarMontavel(db, id, req.body || {});
      res.json({ success: true, montavel: lerMontavel(db, id) });
    } catch (e) { erro(res, e); }
  });

  // Deixa de ser montável. A configuração fica guardada, para voltar igual.
  app.delete('/api/loja/montagem/:produtoId', (req, res) => {
    try {
      db.prepare('UPDATE loja_montaveis SET ativo = 0 WHERE produtoId = ?').run(Number(req.params.produtoId));
      res.json({ success: true });
    } catch (e) { erro(res, e, 500); }
  });
}

module.exports = {
  migrarMontagem, ehMontavel, lerMontavel, montavelPublico, precoInicial,
  resolverMontagem, gravarComponentes, gravarMontavel, repartirMix, lerDataDesejada,
  registrarRotasMontagemAdmin,
};
