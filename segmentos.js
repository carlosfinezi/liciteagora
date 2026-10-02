/**
 * segmentos.js — o segmento de cada pessoa do cadastro.
 *
 * Até 2026-09-28 o "segmento" de um contato de lista era CALCULADO a cada
 * consulta, procurando palavras num texto livre (o ramo), entre 8 segmentos
 * fixos no código. Não dava para corrigir um contato, criar segmento novo, nem
 * confiar num filtro: mudar a regra mudava quem caía onde. Agora o segmento é
 * um CADASTRO da empresa (esta tabela) e um CAMPO da ficha da pessoa
 * (`pessoas.segmentoId`), escolhido na tela; filtra-se por ele em Listas,
 * campanhas e Conversas.
 *
 * O cálculo pelo ramo ficou só como SUGESTÃO para quem chega sem segmento: a
 * importação de planilha e a migração dos contatos das listas. As palavras de
 * cada segmento semente são as do cálculo antigo (wa-m1-utils.SEGMENTOS_PADRAO);
 * segmento criado na tela não tem palavras e só entra por escolha.
 *
 * "Genérico" é o segmento de quem não casou com nenhum outro. É escolhível
 * como os outros, e é o único que não se remove: remover um segmento passa as
 * pessoas dele para o Genérico, em vez de deixá-las sem segmento.
 */
'use strict';

// Os 9 de antes, na ordem em que o cálculo os testa: a primeira palavra que
// casa decide ("distribuidora de bebidas" é Bebidas, e não Atacado).
//
// O sufixo "(L)" é de LEGADO, e entrou em 02/10/2026: desde então cada contato
// guarda também o NICHO do funil do CRM (`nicho-funil.js`), e os dois
// vocabulários aparecem no mesmo seletor. Sem a marca não se sabe qual
// "Alimentação" é qual, e o nome é UNIQUE: as duas não caberiam na tabela se um
// dia alguém copiasse o nicho para cá.
const SUFIXO_LEGADO = ' (L)';
const SEMENTE = [
  ['Bebidas', 'bebidas'], ['Vestuário', 'vestuario'], ['Material de construção', 'material de construcao'],
  ['Alimentação', 'alimentacao'], ['Beleza', 'beleza'], ['Cosméticos', 'cosmeticos'],
  ['Mercado', 'mercado'], ['Atacado', 'atacado'], ['Genérico', 'generico'],
].map(([nome, chave]) => [nome + SUFIXO_LEGADO, chave]);
const CHAVE_GENERICO = 'generico';

const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function migrarSegmentos(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS segmentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE COLLATE NOCASE,
      chave TEXT,
      palavras TEXT,
      ordem INTEGER NOT NULL DEFAULT 0,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const temPessoas = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pessoas'").get();
  if (temPessoas) {
    const cols = db.prepare('PRAGMA table_info(pessoas)').all().map(c => c.name);
    if (!cols.includes('segmentoId')) db.exec('ALTER TABLE pessoas ADD COLUMN segmentoId INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_pessoas_segmento ON pessoas(segmentoId)');
  }
  // Campanha nova que sai só para alguns segmentos da lista: JSON com os ids.
  const camp = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comm_campanhas'").get();
  if (camp && !db.prepare('PRAGMA table_info(comm_campanhas)').all().some(c => c.name === 'segmentos')) {
    db.exec('ALTER TABLE comm_campanhas ADD COLUMN segmentos TEXT');
  }
  if (!db.prepare('SELECT 1 FROM segmentos LIMIT 1').get()) {
    const palavrasDe = Object.fromEntries(require('./wa-m1-utils').SEGMENTOS_PADRAO.map(s => [s.chave, s.palavras]));
    const ins = db.prepare('INSERT INTO segmentos (nome, chave, palavras, ordem) VALUES (?, ?, ?, ?)');
    SEMENTE.forEach(([nome, chave], i) => ins.run(nome, chave, JSON.stringify(palavrasDe[chave] || []), i + 1));
  }
  marcarLegado(db);
}

/**
 * O sufixo "(L)" nos nove semeados, pela CHAVE: segmento criado na tela nasce
 * sem chave e não é legado. Roda em todo boot e não repete a marca; o id não
 * muda, e por isso quem já aponta para eles (a ficha da pessoa, os segmentos
 * gravados numa campanha, o nicho que Conversas mostra) continua apontando.
 */
function marcarLegado(db) {
  const chaves = SEMENTE.map(([, chave]) => chave);
  db.prepare(`UPDATE segmentos SET nome = nome || ?
    WHERE chave IN (${chaves.map(() => '?').join(',')}) AND nome NOT LIKE ?`)
    .run(SUFIXO_LEGADO, ...chaves, '%' + SUFIXO_LEGADO);
}

const lerPalavras = (t) => { try { const p = JSON.parse(t || '[]'); return Array.isArray(p) ? p : []; } catch { return []; } };

function listarSegmentos(db) {
  try {
    return db.prepare(`SELECT s.id, s.nome, s.chave, s.ordem,
        (SELECT COUNT(*) FROM pessoas p WHERE p.segmentoId = s.id AND p.ativo = 1) AS pessoas
      FROM segmentos s ORDER BY s.chave = '${CHAVE_GENERICO}', s.nome COLLATE NOCASE`).all();
  } catch { return []; }
}

// A busca é pela CHAVE; o nome é só a rede de quem perdeu a chave, e aceita os
// dois jeitos porque o "(L)" entrou depois.
function segmentoGenerico(db) {
  return db.prepare('SELECT id, nome FROM segmentos WHERE chave = ?').get(CHAVE_GENERICO)
    || db.prepare("SELECT id, nome FROM segmentos WHERE nome IN ('Genérico', 'Genérico (L)')").get() || null;
}

/**
 * O segmento sugerido para um ramo (texto livre, como "Comércio varejista de
 * bebidas"): o primeiro, na ordem, com uma palavra contida no ramo. Nenhum,
 * ou ramo vazio: o Genérico.
 */
function segmentoDoRamo(db, ramo) {
  const t = normalizar(ramo);
  if (t) {
    for (const s of db.prepare('SELECT id, palavras FROM segmentos ORDER BY ordem, id').all()) {
      if (lerPalavras(s.palavras).some(p => p && t.includes(normalizar(p)))) return s.id;
    }
  }
  const g = segmentoGenerico(db);
  return g ? g.id : null;
}

/**
 * O id de um segmento pelo nome, sem acento nem caixa; null se não existir.
 *
 * Aceita o nome SEM o sufixo "(L)", que entrou em 02/10: a coluna Segmento das
 * planilhas que já circulam diz "mercado", e sem isto ela passaria a cair em
 * "segmento desconhecido" e o contato iria para o Genérico. O nome exato vem
 * primeiro, para um segmento criado à mão vencer a marca do legado.
 */
function segmentoPorNome(db, nome) {
  const alvo = normalizar(nome).trim();
  if (!alvo) return null;
  const todos = db.prepare('SELECT id, nome FROM segmentos').all();
  const chaveDe = (x) => normalizar(x.nome).trim();
  const semMarca = normalizar(SUFIXO_LEGADO).trim();
  const s = todos.find(x => chaveDe(x) === alvo)
    || todos.find(x => chaveDe(x) === `${alvo} ${semMarca}`);
  return s ? s.id : null;
}

/** Os ids de segmento gravados numa campanha; ilegível ou vazio é "todos". */
function segmentosDaCampanha(camp) {
  try {
    const v = JSON.parse((camp && camp.segmentos) || '[]');
    return Array.isArray(v) ? v.map(Number).filter(Boolean) : [];
  } catch { return []; }
}

/** Os ids pedidos que existem no cadastro. Id desconhecido é recusado com erro. */
function validarSegmentos(db, pedidos) {
  if (pedidos == null || pedidos === '') return [];
  if (!Array.isArray(pedidos)) throw new Error('segmentos deve ser uma lista');
  const ids = [...new Set(pedidos.map(Number))];
  for (const id of ids) {
    if (!id || !db.prepare('SELECT 1 FROM segmentos WHERE id = ?').get(id)) throw new Error(`Segmento ${id} não existe`);
  }
  return ids;
}

function registrarRotasSegmentos(app, db) {
  const nomeValido = (n) => String(n || '').trim().slice(0, 60);

  app.get('/api/pessoas/segmentos', (_req, res) => {
    try { res.json({ success: true, segmentos: listarSegmentos(db) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  app.post('/api/pessoas/segmentos', (req, res) => {
    try {
      const nome = nomeValido(req.body?.nome);
      if (!nome) return res.status(400).json({ success: false, error: 'Dê um nome ao segmento' });
      if (segmentoPorNome(db, nome)) return res.status(400).json({ success: false, error: 'Já existe um segmento com esse nome' });
      const ordem = (db.prepare('SELECT MAX(ordem) m FROM segmentos').get().m || 0) + 1;
      const id = db.prepare("INSERT INTO segmentos (nome, palavras, ordem) VALUES (?, '[]', ?)").run(nome, ordem).lastInsertRowid;
      res.json({ success: true, segmento: { id, nome } });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  app.put('/api/pessoas/segmentos/:id', (req, res) => {
    try {
      const s = db.prepare('SELECT id FROM segmentos WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ success: false, error: 'Segmento não encontrado' });
      const nome = nomeValido(req.body?.nome);
      if (!nome) return res.status(400).json({ success: false, error: 'O nome não pode ficar vazio' });
      const outro = segmentoPorNome(db, nome);
      if (outro && outro !== s.id) return res.status(400).json({ success: false, error: 'Já existe um segmento com esse nome' });
      db.prepare('UPDATE segmentos SET nome = ? WHERE id = ?').run(nome, s.id);
      res.json({ success: true });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });

  // Remover passa as pessoas do segmento para o Genérico, que não sai.
  app.delete('/api/pessoas/segmentos/:id', (req, res) => {
    try {
      const s = db.prepare('SELECT id, chave FROM segmentos WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ success: false, error: 'Segmento não encontrado' });
      const g = segmentoGenerico(db);
      if (!g || g.id === s.id) return res.status(400).json({ success: false, error: 'O Genérico não pode ser removido' });
      const movidas = db.transaction(() => {
        const n = db.prepare('UPDATE pessoas SET segmentoId = ? WHERE segmentoId = ?').run(g.id, s.id).changes;
        db.prepare('DELETE FROM segmentos WHERE id = ?').run(s.id);
        return n;
      })();
      res.json({ success: true, movidas });
    } catch (e) { res.status(400).json({ success: false, error: e.message }); }
  });
}

module.exports = {
  SEMENTE, migrarSegmentos, listarSegmentos, segmentoGenerico, segmentoDoRamo, segmentoPorNome, registrarRotasSegmentos,
  segmentosDaCampanha, validarSegmentos,
};
