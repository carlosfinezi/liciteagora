/**
 * cfops-entrada-map-routes.js — De/Para de CFOP para entrada de XML (2026-04-23).
 *
 * Quando o fornecedor emite uma NF-e, o CFOP dele é de SAÍDA (5xxx/6xxx).
 * Ao importar o XML em `nfe_entrada_itens`, o CFOP precisa ser convertido para
 * o equivalente de ENTRADA nosso (1xxx/2xxx). Ex.:
 *   Fornecedor 5102 (venda revenda interna)  → Meu 1102 (compra comercialização)
 *   Fornecedor 6102 (venda revenda inter.)   → Meu 2102 (compra comercialização)
 *   Fornecedor 5910 (bonificação saída)      → Meu 1910 (bonificação entrada)
 *
 * A coluna `nfe_entrada_itens.cfopOriginal` guarda o que veio no XML, e
 * `nfe_entrada_itens.cfop` passa a guardar o CFOP convertido (útil para SPED,
 * conciliação de crédito ICMS e relatórios).
 *
 * Se não houver mapeamento, o CFOP original é mantido e o item fica com
 * `cfopPendenteMapeamento=1` para o usuário revisar.
 */

function alterSafe(db, sql) { try { db.exec(sql); } catch { /* ok */ } }

// Seed de De/Para — cobre os casos mais comuns de compra (CFOPs espelhados 5xxx↔1xxx / 6xxx↔2xxx).
// Para devoluções o sentido inverte: fornecedor devolve compra nossa via 1201/2201 (ele emite
// entrada, não saída), então não mapeiam aqui — a lógica fica só pra saídas do fornecedor.
const SEED_MAP = [
  // Compra para industrialização
  { cfopFornecedor: '5101', cfopNosso: '1101', descricao: 'Compra para industrialização (interno)' },
  { cfopFornecedor: '6101', cfopNosso: '2101', descricao: 'Compra para industrialização (interestadual)' },
  // Compra para revenda
  { cfopFornecedor: '5102', cfopNosso: '1102', descricao: 'Compra para revenda (interno)' },
  { cfopFornecedor: '6102', cfopNosso: '2102', descricao: 'Compra para revenda (interestadual)' },
  // Venda a não-contribuinte — nossa entrada é igual a revenda
  { cfopFornecedor: '5103', cfopNosso: '1101', descricao: 'Compra produção a não-contrib (interno)' },
  { cfopFornecedor: '5104', cfopNosso: '1102', descricao: 'Compra mercadoria a não-contrib (interno)' },
  { cfopFornecedor: '6107', cfopNosso: '2101', descricao: 'Compra produção a não-contrib (interestadual)' },
  { cfopFornecedor: '6108', cfopNosso: '2102', descricao: 'Compra mercadoria a não-contrib (interestadual)' },
  // Compra ST
  { cfopFornecedor: '5401', cfopNosso: '1403', descricao: 'Compra produção ST (interno)' },
  { cfopFornecedor: '5403', cfopNosso: '1403', descricao: 'Compra revenda ST (interno)' },
  { cfopFornecedor: '5405', cfopNosso: '1403', descricao: 'Compra ST consumidor final (interno)' },
  { cfopFornecedor: '6401', cfopNosso: '2403', descricao: 'Compra produção ST (interestadual)' },
  { cfopFornecedor: '6403', cfopNosso: '2403', descricao: 'Compra revenda ST (interestadual)' },
  // Bonificação / doação
  { cfopFornecedor: '5910', cfopNosso: '1910', descricao: 'Bonificação recebida (interno)' },
  { cfopFornecedor: '6910', cfopNosso: '2910', descricao: 'Bonificação recebida (interestadual)' },
  // Remessa e outras
  { cfopFornecedor: '5949', cfopNosso: '1949', descricao: 'Outra entrada (interno)' },
  { cfopFornecedor: '6949', cfopNosso: '2949', descricao: 'Outra entrada (interestadual)' },
  // Devolução que o fornecedor nos envia (ele devolveu venda nossa, para nós é entrada por devolução)
  { cfopFornecedor: '5201', cfopNosso: '1201', descricao: 'Devolução de venda recebida do cliente (interno)' },
  { cfopFornecedor: '5202', cfopNosso: '1202', descricao: 'Devolução de venda recebida do cliente (interno)' },
  { cfopFornecedor: '6201', cfopNosso: '2201', descricao: 'Devolução de venda recebida do cliente (interestadual)' },
  { cfopFornecedor: '6202', cfopNosso: '2202', descricao: 'Devolução de venda recebida do cliente (interestadual)' },
];

function migrar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cfops_entrada_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cfopFornecedor TEXT NOT NULL UNIQUE,
      cfopNosso TEXT NOT NULL,
      descricao TEXT,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      dataAtualizacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cfops_map_ativo ON cfops_entrada_map(ativo);
  `);

  // Rastreabilidade em nfe_entrada_itens: cfopOriginal guarda o CFOP do XML,
  // cfop mantém o CFOP resolvido (mapeado). Flag aponta itens sem mapping.
  alterSafe(db, 'ALTER TABLE nfe_entrada_itens ADD COLUMN cfopOriginal TEXT');
  alterSafe(db, 'ALTER TABLE nfe_entrada_itens ADD COLUMN cfopPendenteMapeamento INTEGER DEFAULT 0');

  const ins = db.prepare(`INSERT OR IGNORE INTO cfops_entrada_map
    (cfopFornecedor, cfopNosso, descricao) VALUES (?, ?, ?)`);
  const tx = db.transaction(() => {
    for (const m of SEED_MAP) ins.run(m.cfopFornecedor, m.cfopNosso, m.descricao || null);
  });
  tx();
}

/**
 * Converte CFOP do fornecedor para o CFOP nosso correspondente.
 * Retorna { cfopNosso, pendente } — se pendente=true, não achou mapa e retorna o CFOP original.
 */
function mapearCfopEntrada(db, cfopFornecedor) {
  if (!cfopFornecedor) return { cfopNosso: null, pendente: false };
  const row = db.prepare('SELECT cfopNosso FROM cfops_entrada_map WHERE cfopFornecedor = ? AND ativo = 1').get(cfopFornecedor);
  if (row?.cfopNosso) return { cfopNosso: row.cfopNosso, pendente: false };
  return { cfopNosso: cfopFornecedor, pendente: true };
}

function registrarRotas(app, db) {
  migrar(db);

  app.get('/api/cfops-entrada-map', (req, res) => {
    try {
      const rows = db.prepare(`SELECT m.*,
        cf.descricao AS cfopFornecedorDescricao,
        cn.descricao AS cfopNossoDescricao
        FROM cfops_entrada_map m
        LEFT JOIN cfops cf ON cf.codigo = m.cfopFornecedor
        LEFT JOIN cfops cn ON cn.codigo = m.cfopNosso
        WHERE m.ativo = 1 ORDER BY m.cfopFornecedor ASC`).all();
      res.json({ success: true, mapeamentos: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cfops-entrada-map', (req, res) => {
    try {
      const { cfopFornecedor, cfopNosso, descricao } = req.body || {};
      if (!cfopFornecedor || !cfopNosso) {
        return res.status(400).json({ success: false, error: 'cfopFornecedor e cfopNosso obrigatórios' });
      }
      const r = db.prepare(`INSERT INTO cfops_entrada_map
        (cfopFornecedor, cfopNosso, descricao) VALUES (?, ?, ?)`)
        .run(cfopFornecedor.trim(), cfopNosso.trim(), descricao || null);
      res.json({ success: true, mapeamento: db.prepare('SELECT * FROM cfops_entrada_map WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.put('/api/cfops-entrada-map/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM cfops_entrada_map WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Mapeamento não encontrado' });
      const b = req.body || {};
      db.prepare(`UPDATE cfops_entrada_map SET
        cfopFornecedor = ?, cfopNosso = ?, descricao = ?, ativo = ?,
        dataAtualizacao = CURRENT_TIMESTAMP WHERE id = ?`).run(
        b.cfopFornecedor ?? atual.cfopFornecedor,
        b.cfopNosso ?? atual.cfopNosso,
        b.descricao ?? atual.descricao,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id
      );
      res.json({ success: true, mapeamento: db.prepare('SELECT * FROM cfops_entrada_map WHERE id = ?').get(req.params.id) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.delete('/api/cfops-entrada-map/:id', (req, res) => {
    try {
      const r = db.prepare('UPDATE cfops_entrada_map SET ativo = 0 WHERE id = ? AND ativo = 1').run(req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Mapeamento não encontrado' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Listagem de CFOPs pendentes (não mapeados) observados em NF-es de entrada importadas.
  app.get('/api/cfops-entrada-map/pendentes', (req, res) => {
    try {
      const rows = db.prepare(`SELECT cfopOriginal AS cfopFornecedor, COUNT(*) AS ocorrencias,
        GROUP_CONCAT(DISTINCT descricao) AS exemplosProdutos
        FROM nfe_entrada_itens
        WHERE cfopPendenteMapeamento = 1
        GROUP BY cfopOriginal ORDER BY ocorrencias DESC`).all();
      res.json({ success: true, pendentes: rows });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[cfops-entrada-map] Rotas registradas');
}

module.exports = {
  registrarRotasCfopsEntradaMap: registrarRotas,
  mapearCfopEntrada,
  migrar
};
