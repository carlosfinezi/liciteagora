/**
 * cte-routes.js — CT-e (Conhecimento de Transporte Eletrônico).
 *
 * Para empresas que prestam SERVIÇO de transporte de cargas de terceiros.
 * MVP escopo: estrutura + geração de XML básico (sem assinatura/SEFAZ).
 * Transmissão é manual via emissor externo nesta versão.
 */

const { logAction } = require('./audit-log');

const STATUS = ['rascunho', 'preparado', 'transmitido', 'cancelado'];
const TIPOS_CTE = { '0': 'Normal', '1': 'Complemento', '2': 'Anulação', '3': 'Substituto' };
const MODAIS = { '01': 'Rodoviário', '02': 'Aéreo', '03': 'Aquaviário', '04': 'Ferroviário', '05': 'Dutoviário', '06': 'Multimodal' };
const TOMADORES = { '0': 'Remetente', '1': 'Expedidor', '2': 'Recebedor', '3': 'Destinatário', '4': 'Outros' };

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cte_conhecimentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serie INTEGER NOT NULL DEFAULT 1,
      numero INTEGER NOT NULL,
      tipoCTe TEXT NOT NULL DEFAULT '0',
      modal TEXT NOT NULL DEFAULT '01',
      tomadorTipo TEXT NOT NULL DEFAULT '0',
      cfop TEXT,
      naturezaOperacao TEXT,
      dataEmissao TEXT NOT NULL,
      ufOrigem TEXT NOT NULL,
      ufDestino TEXT NOT NULL,
      municipioOrigem TEXT,
      municipioDestino TEXT,

      remetenteCnpj TEXT,
      remetenteNome TEXT,
      destinatarioCnpj TEXT,
      destinatarioNome TEXT,

      valorPrestacao REAL DEFAULT 0,
      valorReceber REAL DEFAULT 0,
      cargaProduto TEXT,
      cargaPesoKg REAL,
      cargaValor REAL,

      nfeReferenciada TEXT,
      placaVeiculo TEXT,
      condutorNome TEXT,
      condutorCpf TEXT,

      observacoes TEXT,
      status TEXT NOT NULL DEFAULT 'rascunho',
      chaveAcesso TEXT,
      protocolo TEXT,
      xml TEXT,
      dataPreparacao TEXT,
      dataTransmissao TEXT,
      dataCancelamento TEXT,
      motivoCancelamento TEXT,
      usuarioCriacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(serie, numero)
    );
    CREATE INDEX IF NOT EXISTS idx_cte_status ON cte_conhecimentos(status, dataEmissao);
  `);
}

function proximoNumero(db, serie) {
  const r = db.prepare('SELECT MAX(numero) AS n FROM cte_conhecimentos WHERE serie = ?').get(serie);
  return (r?.n || 0) + 1;
}

function gerarXML(c) {
  const escapeXml = s => String(s || '').replace(/[<>&'"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[ch]));
  const fmt = d => (d || '').slice(0,10);
  return `<?xml version="1.0" encoding="UTF-8"?>
<CTe xmlns="http://www.portalfiscal.inf.br/cte">
  <infCte versao="4.00">
    <ide>
      <cUF>00</cUF>
      <CFOP>${escapeXml(c.cfop || '')}</CFOP>
      <natOp>${escapeXml(c.naturezaOperacao || '')}</natOp>
      <mod>57</mod>
      <serie>${c.serie}</serie>
      <nCT>${c.numero}</nCT>
      <dhEmi>${fmt(c.dataEmissao)}T00:00:00-03:00</dhEmi>
      <tpImp>1</tpImp>
      <tpEmis>1</tpEmis>
      <tpAmb>2</tpAmb>
      <tpCTe>${escapeXml(c.tipoCTe)}</tpCTe>
      <modal>${escapeXml(c.modal)}</modal>
      <tpServ>0</tpServ>
      <UFIni>${escapeXml(c.ufOrigem)}</UFIni>
      <xMunIni>${escapeXml(c.municipioOrigem || '—')}</xMunIni>
      <UFFim>${escapeXml(c.ufDestino)}</UFFim>
      <xMunFim>${escapeXml(c.municipioDestino || '—')}</xMunFim>
      <toma3><toma>${escapeXml(c.tomadorTipo)}</toma></toma3>
    </ide>
    <emit>
      <CNPJ>00000000000000</CNPJ>
      <IE>ISENTO</IE>
      <xNome>EMITENTE — preencher via emissor</xNome>
    </emit>
    ${c.remetenteCnpj ? `<rem><CNPJ>${escapeXml(c.remetenteCnpj.replace(/\D/g,''))}</CNPJ><xNome>${escapeXml(c.remetenteNome||'')}</xNome></rem>` : ''}
    ${c.destinatarioCnpj ? `<dest><CNPJ>${escapeXml(c.destinatarioCnpj.replace(/\D/g,''))}</CNPJ><xNome>${escapeXml(c.destinatarioNome||'')}</xNome></dest>` : ''}
    <vPrest>
      <vTPrest>${(c.valorPrestacao || 0).toFixed(2)}</vTPrest>
      <vRec>${(c.valorReceber || 0).toFixed(2)}</vRec>
    </vPrest>
    <infCTeNorm>
      <infCarga>
        <vCarga>${(c.cargaValor || 0).toFixed(2)}</vCarga>
        <proPred>${escapeXml(c.cargaProduto || 'Carga geral')}</proPred>
        <infQ><cUnid>01</cUnid><tpMed>PESO BRUTO</tpMed><qCarga>${(c.cargaPesoKg || 0).toFixed(4)}</qCarga></infQ>
      </infCarga>
      ${c.nfeReferenciada ? `<infDoc><infNFe><chave>${escapeXml(c.nfeReferenciada)}</chave></infNFe></infDoc>` : ''}
      <infModal versaoModal="4.00">
        <rodo>
          ${c.placaVeiculo ? `<RNTRC>00000000</RNTRC>` : `<RNTRC>00000000</RNTRC>`}
        </rodo>
      </infModal>
    </infCTeNorm>
    ${c.observacoes ? `<compl><xObs>${escapeXml(c.observacoes)}</xObs></compl>` : ''}
  </infCte>
</CTe>`;
}

function registrarRotasCTe(app, db) {
  migrarDB(db);

  app.get('/api/cte', (req, res) => {
    try {
      const { status, q, dataIni, dataFim } = req.query;
      let sql = 'SELECT * FROM cte_conhecimentos WHERE 1=1';
      const params = [];
      if (status)  { sql += ' AND status = ?'; params.push(status); }
      if (dataIni) { sql += ' AND dataEmissao >= ?'; params.push(dataIni); }
      if (dataFim) { sql += ' AND dataEmissao <= ?'; params.push(dataFim); }
      if (q)       { sql += ' AND (remetenteNome LIKE ? OR destinatarioNome LIKE ? OR placaVeiculo LIKE ? OR chaveAcesso LIKE ?)';
                     const like = `%${q}%`; params.push(like, like, like, like); }
      sql += ' ORDER BY id DESC LIMIT 200';
      const conhecimentos = db.prepare(sql).all(...params);
      res.json({ success: true, conhecimentos, status: STATUS, modais: MODAIS, tiposCTe: TIPOS_CTE, tomadores: TOMADORES });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/cte/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM cte_conhecimentos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      res.json({ success: true, cte: c });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cte', (req, res) => {
    try {
      const b = req.body;
      if (!b.ufOrigem || !b.ufDestino || !b.dataEmissao) return res.status(400).json({ success: false, error: 'UFs e data emissão obrigatórios' });
      const serie = b.serie || 1;
      const numero = proximoNumero(db, serie);
      const r = db.prepare(`
        INSERT INTO cte_conhecimentos (serie, numero, tipoCTe, modal, tomadorTipo, cfop, naturezaOperacao,
                                        dataEmissao, ufOrigem, ufDestino, municipioOrigem, municipioDestino,
                                        remetenteCnpj, remetenteNome, destinatarioCnpj, destinatarioNome,
                                        valorPrestacao, valorReceber, cargaProduto, cargaPesoKg, cargaValor,
                                        nfeReferenciada, placaVeiculo, condutorNome, condutorCpf, observacoes, usuarioCriacao)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(serie, numero, b.tipoCTe || '0', b.modal || '01', b.tomadorTipo || '0',
              b.cfop || null, b.naturezaOperacao || null,
              b.dataEmissao, b.ufOrigem, b.ufDestino, b.municipioOrigem || null, b.municipioDestino || null,
              b.remetenteCnpj || null, b.remetenteNome || null, b.destinatarioCnpj || null, b.destinatarioNome || null,
              Number(b.valorPrestacao) || 0, Number(b.valorReceber) || 0,
              b.cargaProduto || null, b.cargaPesoKg ? Number(b.cargaPesoKg) : null, b.cargaValor ? Number(b.cargaValor) : null,
              b.nfeReferenciada || null, b.placaVeiculo || null, b.condutorNome || null, b.condutorCpf || null,
              b.observacoes || null, req.user?.username || null);
      logAction(db, req, 'criar', 'cte', r.lastInsertRowid, { serie, numero });
      res.json({ success: true, cte: db.prepare('SELECT * FROM cte_conhecimentos WHERE id = ?').get(r.lastInsertRowid) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/cte/:id', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM cte_conhecimentos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (!['rascunho','preparado'].includes(c.status)) return res.status(400).json({ success: false, error: 'Estado não permite edição' });
      const camposValidos = ['tipoCTe','modal','tomadorTipo','cfop','naturezaOperacao','dataEmissao','ufOrigem','ufDestino',
                             'municipioOrigem','municipioDestino','remetenteCnpj','remetenteNome','destinatarioCnpj','destinatarioNome',
                             'valorPrestacao','valorReceber','cargaProduto','cargaPesoKg','cargaValor','nfeReferenciada',
                             'placaVeiculo','condutorNome','condutorCpf','observacoes'];
      const sets = [], vals = [];
      for (const c2 of camposValidos) {
        if (req.body[c2] !== undefined) { sets.push(`${c2} = ?`); vals.push(req.body[c2] === '' ? null : req.body[c2]); }
      }
      if (sets.length) {
        vals.push(c.id);
        db.prepare(`UPDATE cte_conhecimentos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        if (c.status === 'preparado') db.prepare(`UPDATE cte_conhecimentos SET status='rascunho', xml=NULL WHERE id=?`).run(c.id);
      }
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cte/:id/preparar', (req, res) => {
    try {
      const c = db.prepare('SELECT * FROM cte_conhecimentos WHERE id = ?').get(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (c.status !== 'rascunho') return res.status(400).json({ success: false, error: 'Já preparado' });
      const xml = gerarXML(c);
      db.prepare(`UPDATE cte_conhecimentos SET status='preparado', xml=?, dataPreparacao=CURRENT_TIMESTAMP WHERE id=?`).run(xml, c.id);
      logAction(db, req, 'preparar', 'cte', c.id, null);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.get('/api/cte/:id/xml', (req, res) => {
    try {
      const c = db.prepare('SELECT xml, serie, numero FROM cte_conhecimentos WHERE id = ?').get(req.params.id);
      if (!c || !c.xml) return res.status(404).json({ success: false, error: 'XML não gerado' });
      res.setHeader('Content-Type','application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=cte-${c.serie}-${c.numero}.xml`);
      res.send(c.xml);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cte/:id/marcar-transmitido', (req, res) => {
    try {
      const { chaveAcesso, protocolo } = req.body;
      if (!chaveAcesso || chaveAcesso.length !== 44) return res.status(400).json({ success: false, error: 'chaveAcesso de 44 dígitos obrigatória' });
      db.prepare(`UPDATE cte_conhecimentos SET status='transmitido', chaveAcesso=?, protocolo=?, dataTransmissao=CURRENT_TIMESTAMP WHERE id=? AND status='preparado'`)
        .run(chaveAcesso, protocolo || null, req.params.id);
      logAction(db, req, 'marcar-transmitido', 'cte', req.params.id, { chaveAcesso });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/cte/:id/cancelar', (req, res) => {
    try {
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 15) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín 15 chars)' });
      db.prepare(`UPDATE cte_conhecimentos SET status='cancelado', dataCancelamento=CURRENT_TIMESTAMP, motivoCancelamento=? WHERE id=? AND status != 'cancelado'`).run(motivo, req.params.id);
      logAction(db, req, 'cancelar', 'cte', req.params.id, { motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasCTe };
