/**
 * mdfe-routes.js — MDF-e (Manifesto Eletrônico de Documentos Fiscais).
 *
 * MVP escopo realista:
 *   - CRUD do manifesto (cabeçalho + percurso + NF-e vinculadas + condutor)
 *   - Geração de XML básico (NÃO assinado) para revisão / emissor externo
 *   - Estados: rascunho → preparado → transmitido → encerrado | cancelado
 *   - Transmissão à SEFAZ é MANUAL nesta versão (usuário emite por outro sistema e
 *     volta para registrar a chave de acesso). Integração SEFAZ é uma evolução.
 *
 * Modelo:
 *   mdfe_manifestos    — cabeçalho
 *   mdfe_percurso      — UFs intermediárias (ordem, uf)
 *   mdfe_nfes          — chaves de NF-e transportadas
 */

const { logAction } = require('./audit-log');

const STATUS = ['rascunho', 'preparado', 'transmitido', 'encerrado', 'cancelado'];
const MODAIS = { '1': 'Rodoviário', '2': 'Aéreo', '3': 'Aquaviário', '4': 'Ferroviário' };
const TIPOS_EMITENTE = { '1': 'Transportador (PJ)', '2': 'Transportador autônomo' };

function migrarDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mdfe_manifestos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serie INTEGER NOT NULL DEFAULT 1,
      numero INTEGER NOT NULL,
      modal TEXT NOT NULL DEFAULT '1',
      tipoEmitente TEXT NOT NULL DEFAULT '1',
      tipoTransportador TEXT,
      ufCarregamento TEXT NOT NULL,
      ufDescarregamento TEXT NOT NULL,
      dataEmissao TEXT NOT NULL,
      dataInicioViagem TEXT,
      rntrc TEXT,
      placa TEXT,
      renavam TEXT,
      tara INTEGER,
      capacidadeKg INTEGER,
      condutorNome TEXT,
      condutorCpf TEXT,
      pesoBrutoKg REAL,
      valorCargaTotal REAL,
      observacoes TEXT,
      status TEXT NOT NULL DEFAULT 'rascunho',
      chaveAcesso TEXT,
      protocolo TEXT,
      xml TEXT,
      dataPreparacao TEXT,
      dataTransmissao TEXT,
      dataEncerramento TEXT,
      dataCancelamento TEXT,
      motivoCancelamento TEXT,
      usuarioCriacao TEXT,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(serie, numero)
    );
    CREATE INDEX IF NOT EXISTS idx_mdfe_status ON mdfe_manifestos(status, dataEmissao);

    CREATE TABLE IF NOT EXISTS mdfe_percurso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mdfeId INTEGER NOT NULL,
      uf TEXT NOT NULL,
      ordem INTEGER NOT NULL,
      FOREIGN KEY (mdfeId) REFERENCES mdfe_manifestos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_perc_mdfe ON mdfe_percurso(mdfeId);

    CREATE TABLE IF NOT EXISTS mdfe_nfes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mdfeId INTEGER NOT NULL,
      chaveNfe TEXT NOT NULL,
      numeroNfe TEXT,
      cnpjDestinatario TEXT,
      ufDescarga TEXT,
      municipioDescarga TEXT,
      valorNF REAL,
      pesoNF REAL,
      FOREIGN KEY (mdfeId) REFERENCES mdfe_manifestos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_mdfe_nfe ON mdfe_nfes(mdfeId);
  `);
}

function proximoNumero(db, serie) {
  const r = db.prepare('SELECT MAX(numero) AS n FROM mdfe_manifestos WHERE serie = ?').get(serie);
  return (r?.n || 0) + 1;
}

// XML ESTRUTURAL — sem assinatura. Útil para revisão e como base para integrar com SEFAZ depois.
function gerarXMLBasico(mdfe, percurso, nfes) {
  const fmtData = d => (d || '').slice(0, 10);
  const escapeXml = s => String(s || '').replace(/[<>&'"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
  const infPercurso = percurso.map(p => `<infPercurso><UFPer>${p.uf}</UFPer></infPercurso>`).join('');
  const infNfes = nfes.map(n => `<infNFe><chNFe>${n.chaveNfe}</chNFe></infNFe>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<MDFe xmlns="http://www.portalfiscal.inf.br/mdfe">
  <infMDFe versao="3.00">
    <ide>
      <cUF>00</cUF>
      <tpAmb>2</tpAmb>
      <tpEmit>${escapeXml(mdfe.tipoEmitente)}</tpEmit>
      <tpTransp>${escapeXml(mdfe.tipoTransportador || '')}</tpTransp>
      <mod>58</mod>
      <serie>${mdfe.serie}</serie>
      <nMDF>${mdfe.numero}</nMDF>
      <modal>${escapeXml(mdfe.modal)}</modal>
      <dhEmi>${fmtData(mdfe.dataEmissao)}T00:00:00-03:00</dhEmi>
      <UFIni>${escapeXml(mdfe.ufCarregamento)}</UFIni>
      <UFFim>${escapeXml(mdfe.ufDescarregamento)}</UFFim>
      <dhIniViagem>${fmtData(mdfe.dataInicioViagem || mdfe.dataEmissao)}T00:00:00-03:00</dhIniViagem>
    </ide>
    <emit>
      <CNPJ>00000000000000</CNPJ>
      <IE>ISENTO</IE>
      <xNome>EMITENTE — preencher via emissor</xNome>
    </emit>
    ${infPercurso}
    <infModal versaoModal="3.00">
      <rodo>
        ${mdfe.rntrc ? `<infANTT><RNTRC>${escapeXml(mdfe.rntrc)}</RNTRC></infANTT>` : ''}
        <veicTracao>
          ${mdfe.placa ? `<placa>${escapeXml(mdfe.placa)}</placa>` : ''}
          ${mdfe.renavam ? `<RENAVAM>${escapeXml(mdfe.renavam)}</RENAVAM>` : ''}
          ${mdfe.tara ? `<tara>${mdfe.tara}</tara>` : ''}
          ${mdfe.capacidadeKg ? `<capKG>${mdfe.capacidadeKg}</capKG>` : ''}
          ${mdfe.condutorNome ? `<condutor><xNome>${escapeXml(mdfe.condutorNome)}</xNome>${mdfe.condutorCpf ? `<CPF>${escapeXml(mdfe.condutorCpf.replace(/\D/g, ''))}</CPF>` : ''}</condutor>` : ''}
          <tpRod>00</tpRod>
          <tpCar>00</tpCar>
          <UF>${escapeXml(mdfe.ufCarregamento)}</UF>
        </veicTracao>
      </rodo>
    </infModal>
    <infDoc>
      <infMunDescarga>
        <cMunDescarga>9999999</cMunDescarga>
        <xMunDescarga>—</xMunDescarga>
        ${infNfes}
      </infMunDescarga>
    </infDoc>
    <tot>
      <qNFe>${nfes.length}</qNFe>
      <vCarga>${(mdfe.valorCargaTotal || 0).toFixed(2)}</vCarga>
      <cUnid>01</cUnid>
      <qCarga>${(mdfe.pesoBrutoKg || 0).toFixed(4)}</qCarga>
    </tot>
    ${mdfe.observacoes ? `<infAdic><infCpl>${escapeXml(mdfe.observacoes)}</infCpl></infAdic>` : ''}
  </infMDFe>
</MDFe>`;
}

function registrarRotasMDFe(app, db) {
  migrarDB(db);

  app.get('/api/mdfe', (req, res) => {
    try {
      const { status, q, dataIni, dataFim } = req.query;
      let sql = 'SELECT * FROM mdfe_manifestos WHERE 1=1';
      const params = [];
      if (status)  { sql += ' AND status = ?'; params.push(status); }
      if (dataIni) { sql += ' AND dataEmissao >= ?'; params.push(dataIni); }
      if (dataFim) { sql += ' AND dataEmissao <= ?'; params.push(dataFim); }
      if (q)       { sql += ' AND (placa LIKE ? OR condutorNome LIKE ? OR chaveAcesso LIKE ?)';
                     const like = `%${q}%`; params.push(like, like, like); }
      sql += ' ORDER BY id DESC LIMIT 200';
      const manifestos = db.prepare(sql).all(...params);
      res.json({ success: true, manifestos, status: STATUS, modais: MODAIS, tiposEmitente: TIPOS_EMITENTE });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/mdfe/:id', (req, res) => {
    try {
      const mdfe = db.prepare('SELECT * FROM mdfe_manifestos WHERE id = ?').get(req.params.id);
      if (!mdfe) return res.status(404).json({ success: false, error: 'MDF-e não encontrado' });
      const percurso = db.prepare('SELECT * FROM mdfe_percurso WHERE mdfeId = ? ORDER BY ordem').all(mdfe.id);
      const nfes = db.prepare('SELECT * FROM mdfe_nfes WHERE mdfeId = ?').all(mdfe.id);
      res.json({ success: true, mdfe, percurso, nfes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/mdfe', (req, res) => {
    try {
      const b = req.body;
      const obrigatorios = ['ufCarregamento','ufDescarregamento','dataEmissao'];
      for (const k of obrigatorios) {
        if (!b[k]) return res.status(400).json({ success: false, error: `${k} obrigatório` });
      }
      const serie = b.serie || 1;
      const numero = proximoNumero(db, serie);
      const trx = db.transaction(() => {
        const r = db.prepare(`
          INSERT INTO mdfe_manifestos
            (serie, numero, modal, tipoEmitente, tipoTransportador,
             ufCarregamento, ufDescarregamento, dataEmissao, dataInicioViagem,
             rntrc, placa, renavam, tara, capacidadeKg,
             condutorNome, condutorCpf, pesoBrutoKg, valorCargaTotal,
             observacoes, usuarioCriacao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(serie, numero, b.modal || '1', b.tipoEmitente || '1', b.tipoTransportador || null,
                b.ufCarregamento, b.ufDescarregamento, b.dataEmissao, b.dataInicioViagem || null,
                b.rntrc || null, b.placa || null, b.renavam || null,
                b.tara || null, b.capacidadeKg || null,
                b.condutorNome || null, b.condutorCpf || null,
                b.pesoBrutoKg || null, b.valorCargaTotal || null,
                b.observacoes || null, req.user?.username || null);
        const id = r.lastInsertRowid;
        if (Array.isArray(b.percurso)) {
          const stmt = db.prepare('INSERT INTO mdfe_percurso (mdfeId, uf, ordem) VALUES (?, ?, ?)');
          b.percurso.forEach((uf, idx) => uf && stmt.run(id, uf, idx + 1));
        }
        if (Array.isArray(b.nfes)) {
          const stmt = db.prepare('INSERT INTO mdfe_nfes (mdfeId, chaveNfe, numeroNfe, cnpjDestinatario, ufDescarga, municipioDescarga, valorNF, pesoNF) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          for (const n of b.nfes) {
            if (!n.chaveNfe) continue;
            stmt.run(id, n.chaveNfe, n.numeroNfe || null, n.cnpjDestinatario || null,
                     n.ufDescarga || null, n.municipioDescarga || null, n.valorNF || null, n.pesoNF || null);
          }
        }
        return id;
      });
      const id = trx();
      logAction(db, req, 'criar', 'mdfe', id, { serie, numero });
      res.json({ success: true, mdfe: db.prepare('SELECT * FROM mdfe_manifestos WHERE id = ?').get(id) });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.put('/api/mdfe/:id', (req, res) => {
    try {
      const m = db.prepare('SELECT * FROM mdfe_manifestos WHERE id = ?').get(req.params.id);
      if (!m) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (!['rascunho','preparado'].includes(m.status)) return res.status(400).json({ success: false, error: 'Estado não permite edição' });
      const camposValidos = ['modal','tipoEmitente','tipoTransportador','ufCarregamento','ufDescarregamento',
                             'dataEmissao','dataInicioViagem','rntrc','placa','renavam','tara','capacidadeKg',
                             'condutorNome','condutorCpf','pesoBrutoKg','valorCargaTotal','observacoes'];
      const sets = [], vals = [];
      for (const c of camposValidos) {
        if (req.body[c] !== undefined) { sets.push(`${c} = ?`); vals.push(req.body[c] === '' ? null : req.body[c]); }
      }
      const trx = db.transaction(() => {
        if (sets.length) {
          vals.push(m.id);
          db.prepare(`UPDATE mdfe_manifestos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
        }
        if (Array.isArray(req.body.percurso)) {
          db.prepare('DELETE FROM mdfe_percurso WHERE mdfeId = ?').run(m.id);
          const stmt = db.prepare('INSERT INTO mdfe_percurso (mdfeId, uf, ordem) VALUES (?, ?, ?)');
          req.body.percurso.forEach((uf, idx) => uf && stmt.run(m.id, uf, idx + 1));
        }
        if (Array.isArray(req.body.nfes)) {
          db.prepare('DELETE FROM mdfe_nfes WHERE mdfeId = ?').run(m.id);
          const stmt = db.prepare('INSERT INTO mdfe_nfes (mdfeId, chaveNfe, numeroNfe, cnpjDestinatario, ufDescarga, municipioDescarga, valorNF, pesoNF) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          for (const n of req.body.nfes) {
            if (!n.chaveNfe) continue;
            stmt.run(m.id, n.chaveNfe, n.numeroNfe || null, n.cnpjDestinatario || null,
                     n.ufDescarga || null, n.municipioDescarga || null, n.valorNF || null, n.pesoNF || null);
          }
        }
        // se já estava preparado e foi editado, volta para rascunho (force re-gen do XML)
        if (m.status === 'preparado') {
          db.prepare(`UPDATE mdfe_manifestos SET status = 'rascunho', xml = NULL, dataPreparacao = NULL WHERE id = ?`).run(m.id);
        }
      });
      trx();
      logAction(db, req, 'editar', 'mdfe', m.id, req.body);
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/mdfe/:id/preparar', (req, res) => {
    try {
      const m = db.prepare('SELECT * FROM mdfe_manifestos WHERE id = ?').get(req.params.id);
      if (!m) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (m.status !== 'rascunho') return res.status(400).json({ success: false, error: 'Estado atual não permite preparar' });
      const percurso = db.prepare('SELECT * FROM mdfe_percurso WHERE mdfeId = ? ORDER BY ordem').all(m.id);
      const nfes = db.prepare('SELECT * FROM mdfe_nfes WHERE mdfeId = ?').all(m.id);
      if (!nfes.length) return res.status(400).json({ success: false, error: 'Adicione ao menos uma NF-e' });
      const xml = gerarXMLBasico(m, percurso, nfes);
      db.prepare(`UPDATE mdfe_manifestos SET status = 'preparado', xml = ?, dataPreparacao = CURRENT_TIMESTAMP WHERE id = ?`).run(xml, m.id);
      logAction(db, req, 'preparar', 'mdfe', m.id, null);
      res.json({ success: true, xml });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.get('/api/mdfe/:id/xml', (req, res) => {
    try {
      const m = db.prepare('SELECT xml, serie, numero FROM mdfe_manifestos WHERE id = ?').get(req.params.id);
      if (!m || !m.xml) return res.status(404).json({ success: false, error: 'XML não gerado' });
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=mdfe-${m.serie}-${m.numero}.xml`);
      res.send(m.xml);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/mdfe/:id/marcar-transmitido', (req, res) => {
    try {
      const { chaveAcesso, protocolo } = req.body;
      if (!chaveAcesso || chaveAcesso.length !== 44) return res.status(400).json({ success: false, error: 'chaveAcesso de 44 dígitos obrigatória' });
      const m = db.prepare('SELECT * FROM mdfe_manifestos WHERE id = ?').get(req.params.id);
      if (!m) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (m.status !== 'preparado') return res.status(400).json({ success: false, error: 'MDF-e deve estar preparado' });
      db.prepare(`UPDATE mdfe_manifestos SET status = 'transmitido', chaveAcesso = ?, protocolo = ?, dataTransmissao = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(chaveAcesso, protocolo || null, m.id);
      logAction(db, req, 'marcar-transmitido', 'mdfe', m.id, { chaveAcesso });
      res.json({ success: true });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  app.post('/api/mdfe/:id/encerrar', (req, res) => {
    try {
      const m = db.prepare('SELECT * FROM mdfe_manifestos WHERE id = ?').get(req.params.id);
      if (!m) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (m.status !== 'transmitido') return res.status(400).json({ success: false, error: 'MDF-e deve estar transmitido' });
      db.prepare(`UPDATE mdfe_manifestos SET status = 'encerrado', dataEncerramento = CURRENT_TIMESTAMP WHERE id = ?`).run(m.id);
      logAction(db, req, 'encerrar', 'mdfe', m.id, null);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/mdfe/:id/cancelar', (req, res) => {
    try {
      const m = db.prepare('SELECT * FROM mdfe_manifestos WHERE id = ?').get(req.params.id);
      if (!m) return res.status(404).json({ success: false, error: 'Não encontrado' });
      if (m.status === 'encerrado' || m.status === 'cancelado') return res.status(400).json({ success: false, error: 'Estado não permite cancelar' });
      const motivo = (req.body?.motivo || '').trim();
      if (motivo.length < 15) return res.status(400).json({ success: false, error: 'Motivo obrigatório (mín. 15 caracteres por exigência da SEFAZ)' });
      db.prepare(`UPDATE mdfe_manifestos SET status = 'cancelado', dataCancelamento = CURRENT_TIMESTAMP, motivoCancelamento = ? WHERE id = ?`).run(motivo, m.id);
      logAction(db, req, 'cancelar', 'mdfe', m.id, { motivo });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasMDFe };
