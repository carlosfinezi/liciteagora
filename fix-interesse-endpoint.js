const fs = require('fs');

let server = fs.readFileSync('server.js', 'utf8');

const oldEndpoint = `/**
 * Endpoint para listar itens de interesse
 */
app.get('/api/interesse', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.query;

    let sql = 'SELECT * FROM interesse';
    let params = [];

    if (cnpj && ano && sequencial) {
      sql += ' WHERE cnpj = ? AND ano = ? AND sequencial = ?';
      params = [cnpj, ano, sequencial];
    }

    sql += ' ORDER BY dataCriacao DESC';

    const interesses = db.prepare(sql).all(...params);

    res.json({
      success: true,
      data: interesses
    });

  } catch (error) {
    console.error('Erro ao listar interesse:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao listar interesse',
      details: error.message
    });
  }
});`;

const newEndpoint = `/**
 * Endpoint para listar itens de interesse com detalhes
 */
app.get('/api/interesse', (req, res) => {
  try {
    const { cnpj, ano, sequencial } = req.query;

    let sql = \`
      SELECT
        i.id,
        i.cnpj,
        i.ano,
        i.sequencial,
        i.numeroItem,
        i.dataCriacao,
        l.objetoCompra,
        l.razaoSocial as nomeOrgao,
        l.codigoUnidade as codigoUnidadeCompradora,
        l.valorTotalEstimado as valorTotalLicitacao,
        l.dataEncerramentoProposta,
        it.descricao,
        it.quantidade,
        it.unidadeMedida,
        it.valorUnitarioEstimado,
        it.valorTotal
      FROM interesse i
      LEFT JOIN licitacoes l ON i.cnpj = l.cnpj AND i.ano = l.anoCompra AND i.sequencial = l.sequencialCompra
      LEFT JOIN itens it ON l.id = it.licitacaoId AND i.numeroItem = it.numeroItem
    \`;
    let params = [];

    if (cnpj && ano && sequencial) {
      sql += ' WHERE i.cnpj = ? AND i.ano = ? AND i.sequencial = ?';
      params = [cnpj, ano, sequencial];
    }

    sql += ' ORDER BY i.dataCriacao DESC';

    const interesses = db.prepare(sql).all(...params);

    res.json({
      success: true,
      data: interesses
    });

  } catch (error) {
    console.error('Erro ao listar interesse:', error.message);
    res.status(500).json({
      success: false,
      error: 'Erro ao listar interesse',
      details: error.message
    });
  }
});`;

server = server.replace(oldEndpoint, newEndpoint);

fs.writeFileSync('server.js', server);
console.log('Endpoint GET /api/interesse atualizado com sucesso!');
