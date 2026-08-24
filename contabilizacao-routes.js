/**
 * contabilizacao-routes.js — CTB-B (item 3.2): contabilização automática +
 * exportação mensal para o contador.
 *
 * contabilizacao_eventos mapeia evento do sistema → par de contas contábeis
 * (por CÓDIGO, sobrevive a reimport do plano). O processador varre as fontes
 * do período e gera lançamentos via gravarLancamento (origem 'automatico',
 * origemRef 'evento:id' — idempotente: nunca contabiliza a mesma origem 2×).
 *
 * Eventos v1 (valor usado):
 *   nfe_saida    faturas autorizadas (valorTotal)         D recebíveis / C receita
 *   nfse         NFS-e autorizadas (valorServico)         idem
 *   recebimento  contas_receber_pagamentos vPago>0        D caixa / C recebíveis
 *   pagamento    contas_pagar_pagamentos vPago>0          D despesa/forn / C caixa
 *   nfe_entrada  nfe_entrada não excluída (valorTotal)    D estoque / C fornecedores
 */

const { logAction } = require('./audit-log');
const { gravarLancamento } = require('./contabilidade-routes');
const { escopoUsuario } = require('./estabelecimentos-routes');

const EVENTOS = {
  nfe_saida: {
    nome: 'NF-e de saída autorizada',
    fonte: (db, inicio, fim) => db.prepare(`SELECT id, ('NF-e ' || COALESCE(numeroNFe, numero)) AS descricao,
        valorTotal AS valor, dataEmissao AS data
      FROM faturas WHERE statusSefaz = 'autorizada' AND COALESCE(excluida,0) = 0
        AND dataEmissao BETWEEN ? AND ? AND valorTotal > 0`).all(inicio, fim)
  },
  nfse: {
    nome: 'NFS-e autorizada',
    fonte: (db, inicio, fim) => db.prepare(`SELECT id, ('NFS-e ' || COALESCE(nNFSe, id)) AS descricao,
        valorServico AS valor, COALESCE(dataCompetencia, substr(dataCriacao,1,10)) AS data
      FROM nfse WHERE status = 'autorizada'
        AND COALESCE(dataCompetencia, substr(dataCriacao,1,10)) BETWEEN ? AND ? AND valorServico > 0`).all(inicio, fim)
  },
  recebimento: {
    nome: 'Recebimento de título',
    fonte: (db, inicio, fim) => db.prepare(`SELECT p.id, ('Recebimento: ' || c.descricao) AS descricao,
        p.valorPago AS valor, p.dataPagamento AS data
      FROM contas_receber_pagamentos p JOIN contas_a_receber c ON c.id = p.contaReceberId
      WHERE p.estornado = 0 AND p.valorPago > 0 AND p.dataPagamento BETWEEN ? AND ?`).all(inicio, fim)
  },
  pagamento: {
    nome: 'Pagamento de título',
    fonte: (db, inicio, fim) => db.prepare(`SELECT p.id, ('Pagamento: ' || c.descricao) AS descricao,
        p.valorPago AS valor, p.dataPagamento AS data
      FROM contas_pagar_pagamentos p JOIN contas_a_pagar c ON c.id = p.contaPagarId
      WHERE p.estornado = 0 AND p.valorPago > 0 AND p.dataPagamento BETWEEN ? AND ?`).all(inicio, fim)
  },
  nfe_entrada: {
    nome: 'NF-e de entrada',
    fonte: (db, inicio, fim) => db.prepare(`SELECT id, ('NF-e entrada ' || COALESCE(numero, chaveAcesso)) AS descricao,
        valorTotal AS valor, COALESCE(dataEntrada, dataEmissao) AS data
      FROM nfe_entrada WHERE COALESCE(excluida,0) = 0
        AND COALESCE(dataEntrada, dataEmissao) BETWEEN ? AND ? AND valorTotal > 0`).all(inicio, fim)
  }
};

function migrarContabilizacaoDB(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contabilizacao_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento TEXT NOT NULL UNIQUE,
      contaDebitoCodigo TEXT NOT NULL,
      contaCreditoCodigo TEXT NOT NULL,
      ativo INTEGER DEFAULT 1,
      dataCriacao TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function registrarRotasContabilizacao(app, db) {
  migrarContabilizacaoDB(db);

  app.get('/api/contabilidade/eventos-config', (req, res) => {
    try {
      const configs = db.prepare('SELECT * FROM contabilizacao_eventos ORDER BY evento').all();
      res.json({
        success: true, configs,
        eventosDisponiveis: Object.entries(EVENTOS).map(([k, v]) => ({ evento: k, nome: v.nome }))
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.post('/api/contabilidade/eventos-config', (req, res) => {
    try {
      const { evento, contaDebitoCodigo, contaCreditoCodigo, ativo } = req.body || {};
      if (!EVENTOS[evento]) return res.status(400).json({ success: false, error: `evento: ${Object.keys(EVENTOS).join('|')}` });
      for (const cod of [contaDebitoCodigo, contaCreditoCodigo]) {
        const c = db.prepare(`SELECT tipoConta, ativo FROM contas_contabeis WHERE codigo = ?`).get((cod || '').trim());
        if (!c) return res.status(400).json({ success: false, error: `Conta ${cod} não existe no plano contábil` });
        if (c.tipoConta !== 'analitica') return res.status(400).json({ success: false, error: `Conta ${cod} é sintética` });
      }
      db.prepare(`INSERT INTO contabilizacao_eventos (evento, contaDebitoCodigo, contaCreditoCodigo, ativo)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(evento) DO UPDATE SET contaDebitoCodigo = excluded.contaDebitoCodigo,
          contaCreditoCodigo = excluded.contaCreditoCodigo, ativo = excluded.ativo`)
        .run(evento, contaDebitoCodigo.trim(), contaCreditoCodigo.trim(), ativo != null ? (ativo ? 1 : 0) : 1);
      logAction(db, req, 'configurar', 'contabilizacao-evento', null, { evento });
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Pendências: fontes do período ainda sem lançamento, por evento
  app.get('/api/contabilidade/pendencias', (req, res) => {
    try {
      // RBAC: escrituração é da pessoa jurídica inteira. Um recorte por filial
      // sairia com balancete que não fecha — pior que não exportar.
      if (escopoUsuario(req)) {
        return res.status(403).json({ success: false, error: 'Contabilidade consolidada: requer acesso a todos os estabelecimentos' });
      }
      const { inicio, fim } = req.query;
      if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });
      const jaFeito = new Set(db.prepare(`SELECT origemRef FROM lancamentos_contabeis
        WHERE origem = 'automatico' AND estornado = 0`).all().map(x => x.origemRef));
      const configurados = new Set(db.prepare(`SELECT evento FROM contabilizacao_eventos WHERE ativo = 1`).all().map(x => x.evento));
      const pendencias = [];
      for (const [evento, def] of Object.entries(EVENTOS)) {
        const rows = def.fonte(db, inicio, fim);
        const pendentes = rows.filter(r => !jaFeito.has(`${evento}:${r.id}`));
        pendencias.push({
          evento, nome: def.nome, configurado: configurados.has(evento),
          total: rows.length, pendentes: pendentes.length,
          valorPendente: Number(pendentes.reduce((s, r) => s + r.valor, 0).toFixed(2))
        });
      }
      res.json({ success: true, pendencias });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // O motor: contabiliza tudo que está pendente no período (idempotente)
  app.post('/api/contabilidade/processar', (req, res) => {
    try {
      // RBAC: escrituração é da pessoa jurídica inteira. Um recorte por filial
      // sairia com balancete que não fecha — pior que não exportar.
      if (escopoUsuario(req)) {
        return res.status(403).json({ success: false, error: 'Contabilidade consolidada: requer acesso a todos os estabelecimentos' });
      }
      const { inicio, fim } = req.body || {};
      if (!inicio || !fim) return res.status(400).json({ success: false, error: 'inicio e fim obrigatórios' });
      const configs = db.prepare(`SELECT * FROM contabilizacao_eventos WHERE ativo = 1`).all();
      if (!configs.length) return res.status(400).json({ success: false, error: 'Nenhum evento configurado' });
      const jaFeito = new Set(db.prepare(`SELECT origemRef FROM lancamentos_contabeis
        WHERE origem = 'automatico' AND estornado = 0`).all().map(x => x.origemRef));
      const usuario = req.session?.username || null;

      let gerados = 0;
      const erros = [];
      for (const cfg of configs) {
        const def = EVENTOS[cfg.evento];
        if (!def) continue;
        for (const row of def.fonte(db, inicio, fim)) {
          const ref = `${cfg.evento}:${row.id}`;
          if (jaFeito.has(ref)) continue;
          try {
            gravarLancamento(db, {
              data: row.data,
              historico: `[auto] ${row.descricao}`.slice(0, 300),
              tipo: 'normal', origem: 'automatico', origemRef: ref, usuario,
              partidas: [
                { codigo: cfg.contaDebitoCodigo, dc: 'D', valor: Number(row.valor.toFixed(2)) },
                { codigo: cfg.contaCreditoCodigo, dc: 'C', valor: Number(row.valor.toFixed(2)) }
              ]
            });
            jaFeito.add(ref);
            gerados++;
          } catch (e) {
            erros.push({ ref, erro: e.message });
            if (erros.length > 100) {
              return res.status(400).json({ success: false, error: 'Abortado: 100+ erros', gerados, erros: erros.slice(0, 10) });
            }
          }
        }
      }
      logAction(db, req, 'processar', 'contabilizacao', null, { inicio, fim, gerados, erros: erros.length });
      res.json({ success: true, gerados, erros });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ==================== EXPORTAÇÃO PARA O CONTADOR ====================
  // Zip mensal: XMLs autorizados + lançamentos + balancete + extrato financeiro.
  app.get('/api/contabilidade/exportar-contador', (req, res) => {
    try {
      // RBAC: escrituração é da pessoa jurídica inteira. Um recorte por filial
      // sairia com balancete que não fecha — pior que não exportar.
      if (escopoUsuario(req)) {
        return res.status(403).json({ success: false, error: 'Contabilidade consolidada: requer acesso a todos os estabelecimentos' });
      }
      const comp = req.query.competencia;
      if (!/^\d{4}-\d{2}$/.test(comp || '')) return res.status(400).json({ success: false, error: 'competencia YYYY-MM' });
      const inicio = comp + '-01', fim = comp + '-31';
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      const csv = (rows, cols) => cols.join(';') + '\n' +
        rows.map(r => cols.map(c => String(r[c] ?? '').replace(/;/g, ',')).join(';')).join('\n');

      // XMLs de NF-e autorizadas
      let nXml = 0;
      for (const f of db.prepare(`SELECT chaveAcesso, xmlAssinado FROM faturas
        WHERE statusSefaz = 'autorizada' AND xmlAssinado IS NOT NULL AND dataEmissao BETWEEN ? AND ?`).all(inicio, fim)) {
        zip.addFile(`nfe/${f.chaveAcesso || 'nfe-' + (++nXml)}.xml`, Buffer.from(f.xmlAssinado, 'utf8'));
        nXml++;
      }
      // Lançamentos contábeis do mês
      const lancs = db.prepare(`SELECT l.id, l.data, l.historico, l.origem, p.dc, c.codigo, c.nome, p.valor
        FROM lancamentos_contabeis l
        JOIN lancamento_partidas p ON p.lancamentoId = l.id
        JOIN contas_contabeis c ON c.id = p.contaContabilId
        WHERE l.data BETWEEN ? AND ? ORDER BY l.data, l.id`).all(inicio, fim);
      zip.addFile('lancamentos.csv', Buffer.from(csv(lancs, ['id', 'data', 'historico', 'origem', 'dc', 'codigo', 'nome', 'valor']), 'utf8'));

      // Extrato financeiro do mês
      const movs = db.prepare(`SELECT m.data, m.tipo, m.valor, m.descricao, m.origem, cf.nome AS conta
        FROM movimentacoes_financeiras m JOIN contas_financeiras cf ON cf.id = m.contaId
        WHERE m.data BETWEEN ? AND ? ORDER BY m.data, m.id`).all(inicio, fim);
      zip.addFile('extrato-financeiro.csv', Buffer.from(csv(movs, ['data', 'tipo', 'valor', 'descricao', 'origem', 'conta']), 'utf8'));

      // Balancete (movimento do mês por conta analítica)
      const bal = db.prepare(`SELECT c.codigo, c.nome,
          COALESCE(SUM(CASE WHEN p.dc='D' THEN p.valor ELSE 0 END),0) AS debitos,
          COALESCE(SUM(CASE WHEN p.dc='C' THEN p.valor ELSE 0 END),0) AS creditos
        FROM lancamento_partidas p
        JOIN lancamentos_contabeis l ON l.id = p.lancamentoId
        JOIN contas_contabeis c ON c.id = p.contaContabilId
        WHERE l.data BETWEEN ? AND ?
        GROUP BY c.id ORDER BY c.codigo`).all(inicio, fim);
      zip.addFile('balancete.csv', Buffer.from(csv(bal, ['codigo', 'nome', 'debitos', 'creditos']), 'utf8'));

      logAction(db, req, 'exportar-contador', 'contabilidade', null, { competencia: comp, xmls: nXml, lancamentos: lancs.length });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="contador-${comp}.zip"`);
      res.send(zip.toBuffer());
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

module.exports = { registrarRotasContabilizacao, migrarContabilizacaoDB, EVENTOS };
