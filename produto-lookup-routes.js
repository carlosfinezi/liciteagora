/**
 * produto-lookup-routes.js — Catálogos auxiliares de atributos de produto
 * (categoria, marca, modelo, cor, material, gênero, unidade).
 *
 * Extraído de produtos-routes.js (refatoração 2026-04-30: separação
 * Catálogo / Estoque / Compras).
 *
 * Uso no server.js:
 *   const { registrarRotasProdutoLookup } = require('./produto-lookup-routes');
 *   registrarRotasProdutoLookup(app, db);
 */

const LOOKUP_TIPOS = new Set(['categoria', 'marca', 'modelo', 'cor', 'material', 'genero', 'unidade']);

/**
 * Categorias que NÃO são rótulos: são chaves que ligam comportamento.
 *
 * O módulo Ótica compara o texto exato, em minúsculas, em JavaScript e em SQL:
 *
 *   produtos-routes.js:76    AND p.categoria NOT IN ('armacao','lente')
 *   produtos-routes.js:198   if (categoria === 'armacao') { …specs óticas… }
 *   optica-routes.js:948     WHERE … p.categoria = 'lente'
 *   optica-routes.js:1041    WHERE … prod.categoria IN ('lente','armacao')
 *
 * Renomear uma delas não dá erro: o módulo simplesmente deixa de reconhecer os
 * produtos, as especificações óticas param de ser gravadas e a ordem de
 * montagem sai sem lentes. São bloqueadas SEMPRE — inclusive com a Ótica
 * desligada, porque o tenant pode ligá-la depois e aí o estrago já estaria
 * feito, silencioso e antigo.
 */
const CATEGORIAS_RESERVADAS = new Set(['armacao', 'lente']);

/**
 * Onde o TEXTO da categoria é guardado fora de `produtos`.
 *
 * Renomear precisa alcançar todos: `comissoes_regras.categoriaProduto` é
 * comparado por igualdade exata em `comissoes-calculo.js:86`
 * (`r.categoriaProduto !== produto.categoria`), então um rename que esqueça
 * dela faz a regra de comissão deixar de casar — sem erro, sem log, e a
 * comissão passa a ser calculada por outra regra ou por nenhuma.
 *
 * Nem todo tenant tem todas as tabelas (módulos são opcionais): a existência é
 * conferida antes de tocar em cada uma.
 */
const CONSUMIDORES_TEXTO_CATEGORIA = [
  { tabela: 'produtos', coluna: 'categoria' },
  { tabela: 'comissoes_regras', coluna: 'categoriaProduto' },
];

const existeTabela = (db, nome) => !!db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(nome);

/** O texto como será guardado: sem espaço nas bordas. */
const limpar = (v) => String(v == null ? '' : v).trim();

/**
 * Já existe um valor igual ignorando maiúsculas/minúsculas?
 *
 * O `UNIQUE(tipo, valor)` da tabela é case-sensitive — foi por isso que
 * `Outros` e `OUTROS` puderam coexistir no produtosbomgosto. A guarda vive
 * aqui, no servidor, e não só na tela: o botão "+" do cadastro de produto e a
 * importação de planilha passam pelo mesmo caminho.
 *
 * `ignorarId` deixa o próprio item de fora, para o rename que só muda o caso
 * das letras ("outros" → "OUTROS") não colidir consigo mesmo.
 */
function conflitoDeCaixa(db, tipo, valor, ignorarId) {
  const sql = `SELECT id, valor FROM produto_lookup
               WHERE tipo = ? AND valor = ? COLLATE NOCASE`
            + (ignorarId ? ' AND id <> ?' : '');
  const args = ignorarId ? [tipo, valor, ignorarId] : [tipo, valor];
  return db.prepare(sql).get(...args) || null;
}

function registrarRotasProdutoLookup(app, db) {
  app.get('/api/produto-lookup/:tipo', (req, res) => {
    try {
      if (!LOOKUP_TIPOS.has(req.params.tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      const tipo = req.params.tipo;

      // Sem parâmetros, a resposta é a de sempre — só os ativos, só id/valor.
      // É o que o datalist do cadastro de produto consome, e mexer nela
      // mudaria o comportamento de seis telas.
      if (!req.query.todos && !req.query.contagem) {
        const itens = db.prepare('SELECT id, valor FROM produto_lookup WHERE tipo = ? AND ativo = 1 ORDER BY valor ASC').all(tipo);
        return res.json({ success: true, itens });
      }

      const itens = db.prepare(
        `SELECT id, valor, ativo FROM produto_lookup WHERE tipo = ?
         ${req.query.todos ? '' : 'AND ativo = 1'} ORDER BY valor COLLATE NOCASE ASC`).all(tipo);

      if (req.query.contagem && tipo === 'categoria') {
        // Contagem TOTAL (ativos + inativos): é ela que importa antes de
        // renomear ou excluir — um produto inativo continua carregando o texto.
        const cont = db.prepare(
          `SELECT categoria AS v, COUNT(*) AS n, SUM(ativo = 1) AS nAtivos
             FROM produtos WHERE categoria IS NOT NULL AND TRIM(categoria) <> ''
            GROUP BY categoria`).all();
        const mapa = new Map(cont.map((c) => [c.v, c]));
        for (const it of itens) {
          const c = mapa.get(it.valor);
          it.produtos = c ? c.n : 0;
          it.produtosAtivos = c ? c.nAtivos : 0;
          it.reservada = CATEGORIAS_RESERVADAS.has(it.valor);
        }
      }
      res.json({ success: true, itens });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/produto-lookup/:tipo', (req, res) => {
    try {
      if (!LOOKUP_TIPOS.has(req.params.tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      const valor = limpar(req.body.valor);
      if (!valor) return res.status(400).json({ success: false, error: 'Informe um nome.' });

      // Duplicata ignorando maiúsculas. Vale para o botão "+" do cadastro de
      // produto e para a tela de Categorias, que passam por aqui.
      //
      // Reenviar o MESMO texto continua sendo reativação (é como as telas
      // irmãs religam um item inativo) — só muda quando difere no caso.
      const conflito = conflitoDeCaixa(db, req.params.tipo, valor);
      if (conflito && conflito.valor !== valor) {
        return res.status(409).json({
          success: false, existente: conflito.valor,
          error: `Já existe "${conflito.valor}". Para o sistema, os dois seriam a mesma coisa escrita de formas diferentes.`,
        });
      }
      try {
        db.prepare('INSERT INTO produto_lookup (tipo, valor) VALUES (?, ?)').run(req.params.tipo, valor);
      } catch { /* UNIQUE — já existe */ }
      db.prepare('UPDATE produto_lookup SET ativo = 1 WHERE tipo = ? AND valor = ?').run(req.params.tipo, valor);
      res.json({ success: true, valor });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Renomear — a operação que precisa alcançar TUDO ou não acontecer.
   *
   * `db.transaction()` do better-sqlite3 é tudo-ou-nada: uma exceção em
   * qualquer passo desfaz os anteriores. É o que impede a base de ficar com
   * metade dos produtos no nome novo e as regras de comissão no antigo — que
   * não daria erro nenhum e só apareceria no fim do mês, na comissão errada.
   */
  app.put('/api/produto-lookup/:tipo/:valor', (req, res) => {
    try {
      const { tipo } = req.params;
      if (!LOOKUP_TIPOS.has(tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      const antigo = limpar(req.params.valor);
      const novo = limpar(req.body && req.body.novo);
      if (!novo) return res.status(400).json({ success: false, error: 'Informe o novo nome.' });

      const item = db.prepare('SELECT id, valor FROM produto_lookup WHERE tipo = ? AND valor = ?').get(tipo, antigo);
      if (!item) return res.status(404).json({ success: false, error: 'Categoria não encontrada.' });
      if (novo === antigo) return res.json({ success: true, valor: novo, produtos: 0, semMudanca: true });

      if (tipo === 'categoria' && CATEGORIAS_RESERVADAS.has(antigo)) {
        return res.status(423).json({ success: false, reservada: true,
          error: `"${antigo}" é usada internamente pelo módulo Ótica e não pode ser renomeada.` });
      }
      // Renomear PARA uma reservada plantaria produtos que a Ótica passaria a
      // tratar como armação/lente sem specs — o inverso do mesmo problema.
      if (tipo === 'categoria' && CATEGORIAS_RESERVADAS.has(novo)) {
        return res.status(423).json({ success: false, reservada: true,
          error: `"${novo}" é reservada ao módulo Ótica. Escolha outro nome.` });
      }
      const conflito = conflitoDeCaixa(db, tipo, novo, item.id);
      if (conflito) {
        return res.status(409).json({ success: false, existente: conflito.valor,
          error: `Já existe "${conflito.valor}". Renomeie para um nome diferente, ou unifique as duas depois.` });
      }

      const alvos = tipo === 'categoria'
        ? CONSUMIDORES_TEXTO_CATEGORIA.filter((c) => existeTabela(db, c.tabela))
        : [];

      let tocados = {};
      db.transaction(() => {
        db.prepare('UPDATE produto_lookup SET valor = ? WHERE id = ?').run(novo, item.id);
        for (const { tabela, coluna } of alvos) {
          const r = db.prepare(`UPDATE ${tabela} SET ${coluna} = ? WHERE ${coluna} = ?`).run(novo, antigo);
          tocados[tabela] = r.changes;
        }
      })();

      res.json({ success: true, valor: novo, anterior: antigo, tocados,
                 produtos: tocados.produtos || 0 });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Excluir de verdade, com o destino dos produtos decidido por quem clicou.
   *
   * O DELETE que já existia continua sendo "inativar" (é o que as telas irmãs
   * chamam, e mudar sua semântica mexeria em cinco telas). Esta é outra
   * operação, e por isso outro caminho.
   *
   * `acao`:
   *   'mover'  + `destino` → os produtos passam para a categoria escolhida
   *   'limpar'            → os produtos ficam sem categoria (NULL)
   * Sem produtos associados, nenhuma das duas é necessária.
   */
  app.post('/api/produto-lookup/categoria/:valor/excluir', (req, res) => {
    try {
      const alvo = limpar(req.params.valor);
      const { acao, destino } = req.body || {};
      const item = db.prepare("SELECT id, valor FROM produto_lookup WHERE tipo='categoria' AND valor = ?").get(alvo);
      if (!item) return res.status(404).json({ success: false, error: 'Categoria não encontrada.' });

      if (CATEGORIAS_RESERVADAS.has(alvo)) {
        return res.status(423).json({ success: false, reservada: true,
          error: `"${alvo}" é usada internamente pelo módulo Ótica e não pode ser excluída.` });
      }

      const nProdutos = db.prepare('SELECT COUNT(*) n FROM produtos WHERE categoria = ?').get(alvo).n;
      const nRegras = existeTabela(db, 'comissoes_regras')
        ? db.prepare('SELECT COUNT(*) n FROM comissoes_regras WHERE categoriaProduto = ?').get(alvo).n : 0;

      // Nada de exclusão silenciosa: sem uma decisão explícita, a resposta diz
      // o que está em jogo e não muda nada.
      if (nProdutos > 0 && acao !== 'mover' && acao !== 'limpar') {
        return res.status(409).json({ success: false, precisaDecisao: true,
          produtos: nProdutos, regrasComissao: nRegras,
          error: `${nProdutos} produto(s) usam esta categoria. Escolha o que fazer com eles.` });
      }

      let dest = null;
      if (nProdutos > 0 && acao === 'mover') {
        dest = limpar(destino);
        if (!dest) return res.status(400).json({ success: false, error: 'Escolha a categoria de destino.' });
        if (dest === alvo) return res.status(400).json({ success: false, error: 'O destino não pode ser a própria categoria.' });
        const existe = db.prepare("SELECT 1 FROM produto_lookup WHERE tipo='categoria' AND valor = ?").get(dest);
        if (!existe) return res.status(400).json({ success: false, error: 'A categoria de destino não existe.' });
      }

      db.transaction(() => {
        if (nProdutos > 0) {
          db.prepare('UPDATE produtos SET categoria = ? WHERE categoria = ?').run(dest, alvo);
        }
        // As regras de comissão acompanham o mesmo destino. Deixá-las com o
        // texto de uma categoria que não existe mais é uma regra morta que
        // ninguém vê.
        if (nRegras > 0) {
          db.prepare('UPDATE comissoes_regras SET categoriaProduto = ? WHERE categoriaProduto = ?').run(dest, alvo);
        }
        db.prepare('DELETE FROM produto_lookup WHERE id = ?').run(item.id);
      })();

      res.json({ success: true, excluida: alvo, produtosMovidos: nProdutos,
                 destino: dest, regrasAtualizadas: nRegras });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/produto-lookup/:tipo/:valor', (req, res) => {
    try {
      if (!LOOKUP_TIPOS.has(req.params.tipo)) return res.status(400).json({ success: false, error: 'tipo inválido' });
      db.prepare('UPDATE produto_lookup SET ativo = 0 WHERE tipo = ? AND valor = ?').run(req.params.tipo, req.params.valor);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Migração única — popula lookup com valores já presentes em produtos.
  // Idempotente via INSERT OR IGNORE.
  try {
    const existentes = db.prepare(`SELECT DISTINCT categoria FROM produtos WHERE categoria IS NOT NULL AND categoria != ''`).all();
    for (const r of existentes) registrarLookup(db, 'categoria', r.categoria);
    const marcas = db.prepare(`SELECT DISTINCT marca FROM produtos WHERE marca IS NOT NULL AND marca != ''`).all();
    for (const r of marcas) registrarLookup(db, 'marca', r.marca);
    const unidades = db.prepare(`SELECT DISTINCT unidade FROM produtos WHERE unidade IS NOT NULL AND unidade != ''`).all();
    for (const r of unidades) registrarLookup(db, 'unidade', r.unidade);
  } catch { /* ignora */ }
}

// Helper exportado: registra valor novo em lookup (idempotente).
// Consumido por produtos-routes.js ao salvar produto.
function registrarLookup(db, tipo, valor) {
  if (!valor) return;
  const v = String(valor).trim();
  if (!v) return;
  try {
    db.prepare('INSERT OR IGNORE INTO produto_lookup (tipo, valor) VALUES (?, ?)').run(tipo, v);
  } catch { /* ignora */ }
}

module.exports = {
  registrarRotasProdutoLookup, registrarLookup, LOOKUP_TIPOS,
  CATEGORIAS_RESERVADAS, CONSUMIDORES_TEXTO_CATEGORIA,
};
