// servicos-routes.js
// Catálogo de serviços (LC 214/2025): cada item carrega cNBS, xNBS,
// cTribNac, cListaMun. Consumido pelos itens de OS (os_itens_servicos.servicoId)
// para derivação fiscal na emissão da NFS-e.
//
// Schema vive em db-schema.js (tabela `servicos`).
//
// Validação fiscal (nível B): além do regex de formato, checa membership
// nas tabelas oficiais carregadas em data/fiscal/{nbs,ctribnac}.json:
//   - NBS 2.0  (gov.br/mdic) — 917 códigos folha (X.XXXX.XX.XX = 9 dígitos sem pontos)
//   - cTribNac (gov.br/nfse) — 335 códigos de tributação nacional (6 dígitos)

const path = require('path');
const fs = require('fs');

const RE_NBS = /^\d{9}$/;
const RE_TRIB_NAC = /^\d{6}$/;

let TABELA_NBS = {};
let TABELA_CTRIBNAC = {};
try {
  TABELA_NBS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/fiscal/nbs.json'), 'utf8'));
  TABELA_CTRIBNAC = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/fiscal/ctribnac.json'), 'utf8'));
  console.log(`[servicos] Tabelas fiscais carregadas: ${Object.keys(TABELA_NBS).length} NBS, ${Object.keys(TABELA_CTRIBNAC).length} cTribNac`);
} catch (err) {
  console.warn('[servicos] Tabelas fiscais não encontradas — validação de membership desativada:', err.message);
}

function validarFiscal(b) {
  if (b.cNBS) {
    if (!RE_NBS.test(b.cNBS)) return 'cNBS deve ter 9 dígitos numéricos';
    if (Object.keys(TABELA_NBS).length && !TABELA_NBS[b.cNBS]) {
      return `cNBS ${b.cNBS} não consta na tabela oficial NBS 2.0`;
    }
  }
  if (b.codigoTributacaoNacional) {
    if (!RE_TRIB_NAC.test(b.codigoTributacaoNacional)) return 'codigoTributacaoNacional deve ter 6 dígitos numéricos';
    if (Object.keys(TABELA_CTRIBNAC).length && !TABELA_CTRIBNAC[b.codigoTributacaoNacional]) {
      return `cTribNac ${b.codigoTributacaoNacional} não consta na tabela oficial NFS-e Nacional`;
    }
  }
  return null;
}

function registrarRotas(app, db) {
  // Tabelas fiscais oficiais — frontend usa para exibir descrição em tempo real
  // ao digitar cNBS / cTribNac no cadastro de serviços.
  app.get('/api/fiscal/tabelas', (_req, res) => {
    res.json({ success: true, nbs: TABELA_NBS, ctribnac: TABELA_CTRIBNAC });
  });

  app.get('/api/servicos', (req, res) => {
    try {
      const { ativo, q, categoria, todos } = req.query;
      let sql = 'SELECT * FROM servicos WHERE 1=1';
      const p = [];
      if (todos === '1') {
        // sem filtro de ativo — usado pela tela de cadastro
      } else if (ativo === '0' || ativo === '1') {
        sql += ' AND ativo = ?'; p.push(Number(ativo));
      } else {
        sql += ' AND ativo = 1';
      }
      if (categoria) { sql += ' AND categoria = ?'; p.push(categoria); }
      if (q) {
        sql += ' AND (nome LIKE ? OR descricao LIKE ? OR codigo LIKE ?)';
        const like = `%${q}%`;
        p.push(like, like, like);
      }
      sql += ' ORDER BY nome ASC';
      res.json({ success: true, servicos: db.prepare(sql).all(...p) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/servicos/:id', (req, res) => {
    try {
      const s = db.prepare('SELECT * FROM servicos WHERE id = ?').get(req.params.id);
      if (!s) return res.status(404).json({ success: false, error: 'Serviço não encontrado' });
      res.json({ success: true, servico: s });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/servicos', (req, res) => {
    try {
      const b = req.body || {};
      if (!b.nome || !String(b.nome).trim()) {
        return res.status(400).json({ success: false, error: 'nome obrigatório' });
      }
      const erroFiscal = validarFiscal(b);
      if (erroFiscal) return res.status(400).json({ success: false, error: erroFiscal });
      const r = db.prepare(`INSERT INTO servicos
        (codigo, nome, descricao, categoria, unidade, valorPadrao,
         cNBS, xNBS, codigoTributacaoNacional, codigoListaServico)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        b.codigo ? String(b.codigo).trim().toUpperCase() : null,
        String(b.nome).trim(),
        b.descricao ? String(b.descricao).trim() : null,
        b.categoria || null,
        b.unidade || 'serviço',
        b.valorPadrao != null && b.valorPadrao !== '' ? Number(b.valorPadrao) : null,
        b.cNBS ? String(b.cNBS).trim() : null,
        b.xNBS ? String(b.xNBS).trim() : null,
        b.codigoTributacaoNacional ? String(b.codigoTributacaoNacional).trim() : null,
        b.codigoListaServico ? String(b.codigoListaServico).trim() : null
      );
      res.json({ success: true, servico: db.prepare('SELECT * FROM servicos WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/servicos/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM servicos WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Serviço não encontrado' });
      const b = req.body || {};
      const erroFiscal = validarFiscal(b);
      if (erroFiscal) return res.status(400).json({ success: false, error: erroFiscal });
      db.prepare(`UPDATE servicos SET
        codigo = ?, nome = ?, descricao = ?, categoria = ?, unidade = ?,
        valorPadrao = ?, cNBS = ?, xNBS = ?,
        codigoTributacaoNacional = ?, codigoListaServico = ?,
        ativo = ?, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = ?`).run(
        b.codigo !== undefined ? (b.codigo ? String(b.codigo).trim().toUpperCase() : null) : atual.codigo,
        b.nome !== undefined ? String(b.nome).trim() : atual.nome,
        b.descricao !== undefined ? (b.descricao || null) : atual.descricao,
        b.categoria !== undefined ? (b.categoria || null) : atual.categoria,
        b.unidade !== undefined ? (b.unidade || 'serviço') : atual.unidade,
        b.valorPadrao !== undefined
          ? (b.valorPadrao === '' || b.valorPadrao == null ? null : Number(b.valorPadrao))
          : atual.valorPadrao,
        b.cNBS !== undefined ? (b.cNBS || null) : atual.cNBS,
        b.xNBS !== undefined ? (b.xNBS || null) : atual.xNBS,
        b.codigoTributacaoNacional !== undefined ? (b.codigoTributacaoNacional || null) : atual.codigoTributacaoNacional,
        b.codigoListaServico !== undefined ? (b.codigoListaServico || null) : atual.codigoListaServico,
        b.ativo != null ? (b.ativo ? 1 : 0) : atual.ativo,
        req.params.id
      );
      res.json({ success: true, servico: db.prepare('SELECT * FROM servicos WHERE id = ?').get(req.params.id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.delete('/api/servicos/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const usado = db.prepare(
        'SELECT COUNT(*) AS c FROM os_itens_servicos WHERE servicoId = ?'
      ).get(id);
      if (usado && usado.c > 0) {
        return res.status(409).json({
          success: false,
          error: `Serviço usado em ${usado.c} item(ns) de OS — desativando em vez de excluir`,
          desativado: true
        });
      }
      const r = db.prepare('UPDATE servicos SET ativo = 0 WHERE id = ? AND ativo = 1').run(id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Serviço não encontrado ou já inativo' });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  console.log('[servicos] Rotas registradas');
}

module.exports = {
  registrarRotasServicos: registrarRotas
};
