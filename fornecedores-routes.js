/**
 * fornecedores-routes.js — o lado "fornecedor" do cadastro único `pessoas`.
 *
 * Até 2026-08-20 existia uma tabela `fornecedores` separada, com tela própria
 * em Compras. Era um cadastro paralelo ao de `pessoas`: quem marcava a
 * categoria "fornecedor" numa pessoa não aparecia no Contas a Pagar, porque o
 * autocomplete de lá lia a outra tabela. A unificação juntou os dois (ver
 * migracao-fornecedores-pessoas.js) e o cadastro passou a ser um só, em
 * Comercial > Pessoas.
 *
 * O que sobrou aqui é o que continua fazendo sentido como recorte:
 *   - LEITURA filtrada por categoria (lista, autocomplete, ficha) — é o que
 *     as telas de compra, estoque, OS e financeiro usam para escolher um
 *     fornecedor sem varrer a base inteira de clientes;
 *   - certidões com validade (`pessoas_documentos`), que `pessoas_anexos` não
 *     cobre: anexo é arquivo, certidão tem tipo e vencimento;
 *   - histórico de compras e situação documental, que só existem do lado do
 *     fornecedor.
 *
 * O CRUD do cadastro NÃO está mais aqui — é /api/pessoas. Para criar
 * fornecedor pelo código, use pessoas-fornecedor.garantirFornecedor().
 *
 * NÃO confundir com `fornecedor-routes.js` (singular) — aquele é o cadastro
 * da empresa DONA do sistema (tenant), usado em emissão fiscal.
 *
 * Uso no server.js:
 *   const { registrarRotasFornecedores } = require('./fornecedores-routes');
 *   registrarRotasFornecedores(app, db);
 */

const { E_FORNECEDOR } = require('./pessoas-fornecedor');

const PORTES = ['ME','EPP','demais'];
const FRETES = ['CIF','FOB','terceiros','sem_frete'];
const STATUS_HOMOLOGACAO = ['nao_avaliado','em_analise','homologado','bloqueado'];
// Tipos de documento que costumam vencer e travar uma compra ou uma
// habilitação. A lista fica no backend para a tela não divergir dela.
const TIPOS_DOCUMENTO = [
  { codigo: 'cnd_federal',   nome: 'CND Federal (Receita/PGFN)' },
  { codigo: 'cnd_estadual',  nome: 'CND Estadual' },
  { codigo: 'cnd_municipal', nome: 'CND Municipal' },
  { codigo: 'fgts',          nome: 'CRF / FGTS' },
  { codigo: 'trabalhista',   nome: 'CNDT (Trabalhista)' },
  { codigo: 'falencia',      nome: 'Certidão de Falência/Concordata' },
  { codigo: 'contrato_social', nome: 'Contrato Social / Estatuto' },
  { codigo: 'alvara',        nome: 'Alvará de Funcionamento' },
  { codigo: 'licenca',       nome: 'Licença (ambiental, sanitária…)' },
  { codigo: 'simples',       nome: 'Declaração de Optante pelo Simples' },
  { codigo: 'outro',         nome: 'Outro' },
];

// Busca insensível a acento e a máscara de CNPJ. O SQLite não tem
// unaccent nem regex, então a normalização das colunas vira REPLACE
// aninhado — montado aqui para a query continuar legível.
const ACENTOS = [['á','a'],['à','a'],['â','a'],['ã','a'],['ä','a'],['é','e'],['ê','e'],['è','e'],
  ['í','i'],['î','i'],['ó','o'],['ô','o'],['õ','o'],['ö','o'],['ú','u'],['û','u'],['ü','u'],['ç','c']];
const SQL_SEM_ACENTO = (col) => ACENTOS.reduce((sql, [de, para]) => `REPLACE(${sql},'${de}','${para}')`, col);
const SQL_SO_DIGITOS = (col) => [['.',''],['-',''],['/',''],[' ',''],['(',''],[')','']]
  .reduce((sql, [de, para]) => `REPLACE(${sql},'${de}','${para}')`, col);
const semAcento = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

function dataBrasilia() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function temTabela(db, nome) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(nome);
}

/**
 * Situação dos documentos da pessoa. `diasAviso` define o que conta como
 * "a vencer" — o ponto é avisar antes de travar a compra, não depois.
 */
function situacaoDocumentos(db, pessoaId, diasAviso = 30) {
  if (!temTabela(db, 'pessoas_documentos')) return { total: 0, vencidos: [], aVencer: [], semValidade: 0 };
  const docs = db.prepare('SELECT * FROM pessoas_documentos WHERE pessoaId = ? ORDER BY dataValidade').all(pessoaId);
  const hoje = dataBrasilia();
  const limite = new Date(Date.now() + diasAviso * 86400000 - 3 * 3600000).toISOString().slice(0, 10);
  const vencidos = docs.filter(d => d.dataValidade && d.dataValidade < hoje);
  const aVencer = docs.filter(d => d.dataValidade && d.dataValidade >= hoje && d.dataValidade <= limite);
  return {
    total: docs.length,
    vencidos, aVencer,
    semValidade: docs.filter(d => !d.dataValidade).length,
  };
}

/**
 * O que o cadastro não conta: quanto já se comprou, com que pontualidade o
 * fornecedor entrega e quando foi a última compra.
 */
function historicoCompras(db, fornecedorId) {
  const vazio = { pedidos: 0, valorTotal: 0, ticketMedio: 0, ultimoPedido: null,
                  recebidos: 0, entregasNoPrazo: 0, atrasoMedioDias: null };
  // Só o tenant sem o módulo de compras degrada em silêncio. Erro de consulta
  // tem de estourar: um catch largo aqui devolvia "0 pedidos" para um nome de
  // coluna errado, e o histórico aparecia vazio sem ninguém desconfiar.
  if (!temTabela(db, 'pedidos_compra')) return vazio;

  const r = db.prepare(`SELECT COUNT(*) pedidos, COALESCE(SUM(valorTotal),0) valorTotal,
      MAX(dataEmissao) ultimoPedido
    FROM pedidos_compra WHERE fornecedorId = ? AND status <> 'cancelado'`).get(fornecedorId);
  if (!r || !r.pedidos) return vazio;

  // Pontualidade: compara a data prevista com a do recebimento.
  const prazos = db.prepare(`SELECT dataPrevistaEntrega, dataRecebimento
    FROM pedidos_compra
    WHERE fornecedorId = ? AND status <> 'cancelado'
      AND dataPrevistaEntrega IS NOT NULL AND dataRecebimento IS NOT NULL`).all(fornecedorId);
  let noPrazo = 0, somaAtraso = 0;
  for (const p of prazos) {
    const dias = Math.round((new Date(p.dataRecebimento) - new Date(p.dataPrevistaEntrega)) / 86400000);
    if (dias <= 0) noPrazo++; else somaAtraso += dias;
  }
  return {
    pedidos: r.pedidos,
    valorTotal: Number(r.valorTotal.toFixed(2)),
    ticketMedio: Number((r.valorTotal / r.pedidos).toFixed(2)),
    ultimoPedido: r.ultimoPedido,
    recebidos: prazos.length,
    entregasNoPrazo: noPrazo,
    atrasoMedioDias: prazos.length > noPrazo ? Number((somaAtraso / (prazos.length - noPrazo)).toFixed(1)) : 0,
  };
}

function registrarRotasFornecedores(app, db) {
  // Listas do domínio servidas pelo backend — a tela repetia opções em HTML e
  // elas divergiam do que o servidor aceita. `regimes` saiu daqui: o regime
  // tributário agora é o de `pessoas`, numérico (CRT), escolhido na tela de
  // Pessoas.
  app.get('/api/fornecedores/opcoes', (req, res) => {
    res.json({ success: true, portes: PORTES, fretes: FRETES,
               statusHomologacao: STATUS_HOMOLOGACAO, tiposDocumento: TIPOS_DOCUMENTO });
  });

  app.get('/api/fornecedores', (req, res) => {
    try {
      const { q, ativo, statusHomologacao, uf, pendencia } = req.query;
      let sql = `SELECT * FROM pessoas WHERE ${E_FORNECEDOR}`;
      const params = [];
      if (ativo !== undefined) { sql += ' AND ativo = ?'; params.push(Number(ativo)); }
      else { sql += ' AND ativo = 1'; }
      if (statusHomologacao) { sql += ' AND COALESCE(statusHomologacao,\'nao_avaliado\') = ?'; params.push(statusHomologacao); }
      if (uf) { sql += ' AND uf = ?'; params.push(uf.toUpperCase()); }
      if (q) {
        // A busca só olhava CNPJ/razão/fantasia: quem procurava pela cidade
        // não achava ninguém.
        sql += ` AND (cpfCnpj LIKE ? OR razaoSocial LIKE ? OR nomeFantasia LIKE ?
                  OR cidade LIKE ? OR email LIKE ?)`;
        const like = `%${q}%`;
        params.push(like, like, like, like, like);
      }
      sql += ' ORDER BY razaoSocial ASC';
      let fornecedores = db.prepare(sql).all(...params);

      // Situação documental vai junto: sem isso a lista não distingue um
      // fornecedor pronto para comprar de um com certidão vencida.
      fornecedores = fornecedores.map(f => {
        const doc = situacaoDocumentos(db, f.id);
        return { ...f, docsVencidos: doc.vencidos.length, docsAVencer: doc.aVencer.length, docsTotal: doc.total };
      });
      if (pendencia === '1') fornecedores = fornecedores.filter(f => f.docsVencidos > 0);

      res.json({ success: true, fornecedores,
        resumo: {
          total: fornecedores.length,
          homologados: fornecedores.filter(f => f.statusHomologacao === 'homologado').length,
          bloqueados: fornecedores.filter(f => f.statusHomologacao === 'bloqueado').length,
          comDocVencido: fornecedores.filter(f => f.docsVencidos > 0).length,
        } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fornecedores/autocomplete', (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (q.length < 2) return res.json({ success: true, fornecedores: [] });
      // O cpfCnpj e gravado so com digitos e o LIKE do SQLite ignora caixa
      // apenas em ASCII, nunca acento: CNPJ colado com mascara
      // ("45.907.050/0001-95") e nome com acento nao achavam nada.
      const digitos = q.replace(/\D/g, '');
      const likeNome = `%${semAcento(q.toLowerCase())}%`;
      const cond = [`${SQL_SEM_ACENTO('LOWER(razaoSocial)')} LIKE ?`,
                    `${SQL_SEM_ACENTO('LOWER(nomeFantasia)')} LIKE ?`,
                    // documento sem dígito nenhum (importado do exterior grava
                    // um código, ex. "EX-NICSRS") continua achável por texto
                    `LOWER(cpfCnpj) LIKE ?`];
      const params = [likeNome, likeNome, likeNome];
      if (digitos.length >= 2) {
        cond.unshift(`${SQL_SO_DIGITOS('cpfCnpj')} LIKE ?`);
        params.unshift(`%${digitos}%`);
      }
      const fornecedores = db.prepare(
        `SELECT id, cpfCnpj, razaoSocial, nomeFantasia FROM pessoas
         WHERE ativo = 1 AND ${E_FORNECEDOR} AND (${cond.join(' OR ')})
         ORDER BY razaoSocial ASC LIMIT 15`
      ).all(...params);
      res.json({ success: true, fornecedores });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/fornecedores/:id', (req, res) => {
    try {
      const f = db.prepare(`SELECT * FROM pessoas WHERE id = ? AND ${E_FORNECEDOR}`).get(req.params.id);
      if (!f) return res.status(404).json({ success: false, error: 'Fornecedor nao encontrado' });
      const contatos = db.prepare('SELECT * FROM pessoas_contatos WHERE pessoaId = ? ORDER BY principal DESC, nome').all(f.id);
      const documentos = temTabela(db, 'pessoas_documentos')
        ? db.prepare('SELECT * FROM pessoas_documentos WHERE pessoaId = ? ORDER BY dataValidade IS NULL, dataValidade').all(f.id)
        : [];
      res.json({
        success: true, fornecedor: f, contatos, documentos,
        situacaoDocumentos: situacaoDocumentos(db, f.id),
        historico: historicoCompras(db, f.id),
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ==================== DOCUMENTOS / CERTIDÕES ====================
  // Ficam sob /api/pessoas porque valem para qualquer pessoa — um cliente
  // também tem certidão — e é a tela de Pessoas que os edita agora.

  app.get('/api/pessoas/:id/documentos', (req, res) => {
    try {
      const documentos = temTabela(db, 'pessoas_documentos')
        ? db.prepare('SELECT * FROM pessoas_documentos WHERE pessoaId = ? ORDER BY dataValidade IS NULL, dataValidade').all(req.params.id)
        : [];
      res.json({ success: true, documentos, situacao: situacaoDocumentos(db, req.params.id),
                 tiposDocumento: TIPOS_DOCUMENTO });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/pessoas/:id/documentos', (req, res) => {
    try {
      const p = db.prepare('SELECT id FROM pessoas WHERE id = ?').get(req.params.id);
      if (!p) return res.status(404).json({ success: false, error: 'Pessoa nao encontrada' });
      const b = req.body || {};
      if (!b.tipo) return res.status(400).json({ success: false, error: 'tipo do documento é obrigatório' });
      if (!TIPOS_DOCUMENTO.some(t => t.codigo === b.tipo)) {
        return res.status(400).json({ success: false, error: `tipo inválido: ${b.tipo}` });
      }
      if (b.dataEmissao && b.dataValidade && b.dataValidade < b.dataEmissao) {
        return res.status(400).json({ success: false, error: 'Validade anterior à emissão' });
      }
      const id = db.prepare(`INSERT INTO pessoas_documentos
        (pessoaId, tipo, numero, dataEmissao, dataValidade, observacao)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(p.id, b.tipo, b.numero || null, b.dataEmissao || null, b.dataValidade || null, b.observacao || null)
        .lastInsertRowid;
      res.json({ success: true, id });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.delete('/api/pessoas/:id/documentos/:docId', (req, res) => {
    try {
      const r = db.prepare('DELETE FROM pessoas_documentos WHERE id = ? AND pessoaId = ?')
        .run(req.params.docId, req.params.id);
      if (!r.changes) return res.status(404).json({ success: false, error: 'Documento nao encontrado' });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Painel de vencimentos: quem está com certidão vencida ou vencendo.
  app.get('/api/fornecedores-documentos/vencimentos', (req, res) => {
    try {
      const dias = Math.max(0, Math.min(365, Number(req.query.dias) || 30));
      const linhas = [];
      const forns = db.prepare(
        `SELECT id, razaoSocial, cpfCnpj FROM pessoas WHERE ativo = 1 AND ${E_FORNECEDOR}`
      ).all();
      for (const f of forns) {
        const sit = situacaoDocumentos(db, f.id, dias);
        for (const d of sit.vencidos) linhas.push({ ...d, fornecedor: f.razaoSocial, cpfCnpj: f.cpfCnpj, situacao: 'vencido' });
        for (const d of sit.aVencer) linhas.push({ ...d, fornecedor: f.razaoSocial, cpfCnpj: f.cpfCnpj, situacao: 'a_vencer' });
      }
      linhas.sort((a, b) => (a.dataValidade || '').localeCompare(b.dataValidade || ''));
      res.json({ success: true, dias, documentos: linhas,
        vencidos: linhas.filter(l => l.situacao === 'vencido').length,
        aVencer: linhas.filter(l => l.situacao === 'a_vencer').length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasFornecedores,
  PORTES, FRETES, STATUS_HOMOLOGACAO, TIPOS_DOCUMENTO,
  situacaoDocumentos, historicoCompras };
