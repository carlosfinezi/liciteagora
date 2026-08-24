/**
 * politicas-prazo-routes.js — CRUD das políticas de prazo.
 *
 * A política é a regra de pagamento como cadastro: prazo das parcelas, meios de
 * recebimento aceitos, valor mínimo por parcela e as travas de crédito. A pessoa
 * aponta para uma (pessoas.politicaPrazoId) e todo o resto do sistema — pedido,
 * OS, fatura, PDV, contas a pagar — lê pelos resolvedores de sempre
 * (`prazo-pagamento.js` e `meios-pagamento.js`), que consultam a política antes
 * dos campos legados. Ver politicas-prazo.js.
 *
 * O schema vive em db-schema.js, e não aqui, porque tenant existente só recebe
 * initSchema no primeiro open — migração de módulo de rota só roda na criação.
 */

const { logAction } = require('./audit-log');
const { normalizarPrazo } = require('./prazo-pagamento');
const { MEIOS } = require('./meios-pagamento');

const TIPOS = ['vista', 'prazo'];

/** Valida e normaliza o corpo. Lança com mensagem de usuário. */
function normalizarCorpo(b, atual = null) {
  const nome = (b.nome != null ? String(b.nome) : (atual ? atual.nome : '')).trim();
  if (!nome) throw new Error('Nome da política é obrigatório');

  const tipo = b.tipo != null ? String(b.tipo) : (atual ? atual.tipo : 'prazo');
  if (!TIPOS.includes(tipo)) throw new Error(`Tipo inválido: use ${TIPOS.join(' ou ')}`);

  // À vista não parcela: guardar dias aqui só criaria duas fontes de verdade.
  let prazoDias = null;
  if (tipo === 'prazo') {
    const bruto = b.prazoDias !== undefined ? b.prazoDias : (atual ? atual.prazoDias : null);
    prazoDias = normalizarPrazo(bruto);       // lança em formato inválido
    if (!prazoDias) throw new Error('Política a prazo precisa dos dias das parcelas (ex.: 30 ou 30/60/90)');
  }

  let meios = null;
  const meiosBruto = b.meiosPermitidos !== undefined
    ? b.meiosPermitidos
    : (atual && atual.meiosPermitidos ? JSON.parse(atual.meiosPermitidos) : null);
  if (Array.isArray(meiosBruto) && meiosBruto.length) {
    const cods = meiosBruto.map(c => String(c).trim().padStart(2, '0'));
    const invalido = cods.find(c => !MEIOS[c]);
    if (invalido) throw new Error(`Meio de pagamento desconhecido: ${invalido}`);
    meios = JSON.stringify([...new Set(cods)]);
  }

  // Ausente mantém o que está gravado; enviado vazio LIMPA. Tratar os dois como
  // "mantém" tornaria impossível apagar um mínimo já definido pela tela, que
  // manda null quando o operador esvazia o campo.
  const num = (v, padrao) => {
    if (v === undefined) return padrao;
    if (v === null || v === '') return null;
    return Number(v);
  };
  const bool = (v, padrao) => (v === undefined || v === null ? padrao : (v ? 1 : 0));

  return {
    nome, tipo, prazoDias, meiosPermitidos: meios,
    valorMinimoParcela: num(b.valorMinimoParcela, atual ? atual.valorMinimoParcela : null),
    coeficiente: num(b.coeficiente, atual ? atual.coeficiente : 0) || 0,
    ignoraLimiteCredito: bool(b.ignoraLimiteCredito, atual ? atual.ignoraLimiteCredito : 0),
    aplicaVendas: bool(b.aplicaVendas, atual ? atual.aplicaVendas : 1),
    aplicaCompras: bool(b.aplicaCompras, atual ? atual.aplicaCompras : 0),
    aplicaPdv: bool(b.aplicaPdv, atual ? atual.aplicaPdv : 1),
    observacoes: b.observacoes !== undefined ? (b.observacoes || null) : (atual ? atual.observacoes : null),
    ativo: bool(b.ativo, atual ? atual.ativo : 1),
  };
}

function registrarRotasPoliticasPrazo(app, db) {
  // Lista, com quantos clientes cada política já rege — é o número que diz se
  // dá para inativar sem deixar cadastro órfão.
  app.get('/api/politicas-prazo', (req, res) => {
    try {
      const politicas = db.prepare(`
        SELECT pol.*, (SELECT COUNT(*) FROM pessoas WHERE politicaPrazoId = pol.id) AS qtdPessoas
        FROM politicas_prazo pol ORDER BY pol.ativo DESC, pol.nome
      `).all();
      res.json({ success: true, politicas, meios: MEIOS });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/politicas-prazo/:id', (req, res) => {
    try {
      const pol = db.prepare('SELECT * FROM politicas_prazo WHERE id = ?').get(req.params.id);
      if (!pol) return res.status(404).json({ success: false, error: 'Política não encontrada' });
      const pessoas = db.prepare(`
        SELECT id, razaoSocial, nomeFantasia, cpfCnpj FROM pessoas
        WHERE politicaPrazoId = ? ORDER BY razaoSocial
      `).all(pol.id);
      res.json({ success: true, politica: pol, pessoas });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/politicas-prazo', (req, res) => {
    try {
      const c = normalizarCorpo(req.body || {});
      const r = db.prepare(`INSERT INTO politicas_prazo
        (nome, ativo, tipo, prazoDias, meiosPermitidos, valorMinimoParcela, coeficiente,
         ignoraLimiteCredito, aplicaVendas, aplicaCompras, aplicaPdv, observacoes)
        VALUES (@nome, @ativo, @tipo, @prazoDias, @meiosPermitidos, @valorMinimoParcela, @coeficiente,
                @ignoraLimiteCredito, @aplicaVendas, @aplicaCompras, @aplicaPdv, @observacoes)`).run(c);
      logAction(db, req, 'criar', 'politica-prazo', r.lastInsertRowid, { nome: c.nome });
      res.json({ success: true, id: r.lastInsertRowid });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'Já existe política com esse nome' : err.message;
      res.status(400).json({ success: false, error: msg });
    }
  });

  app.put('/api/politicas-prazo/:id', (req, res) => {
    try {
      const atual = db.prepare('SELECT * FROM politicas_prazo WHERE id = ?').get(req.params.id);
      if (!atual) return res.status(404).json({ success: false, error: 'Política não encontrada' });
      const c = normalizarCorpo(req.body || {}, atual);
      db.prepare(`UPDATE politicas_prazo SET
        nome = @nome, ativo = @ativo, tipo = @tipo, prazoDias = @prazoDias,
        meiosPermitidos = @meiosPermitidos, valorMinimoParcela = @valorMinimoParcela,
        coeficiente = @coeficiente, ignoraLimiteCredito = @ignoraLimiteCredito,
        aplicaVendas = @aplicaVendas, aplicaCompras = @aplicaCompras, aplicaPdv = @aplicaPdv,
        observacoes = @observacoes, dataAtualizacao = CURRENT_TIMESTAMP
        WHERE id = @id`).run({ ...c, id: atual.id });
      logAction(db, req, 'editar', 'politica-prazo', atual.id, req.body);
      res.json({ success: true });
    } catch (err) {
      const msg = /UNIQUE/.test(err.message) ? 'Já existe política com esse nome' : err.message;
      res.status(400).json({ success: false, error: msg });
    }
  });

  // Excluir só quando ninguém aponta para ela. Com clientes vinculados, o
  // caminho é inativar — apagar deixaria o cadastro sem regra de pagamento.
  app.delete('/api/politicas-prazo/:id', (req, res) => {
    try {
      const pol = db.prepare('SELECT * FROM politicas_prazo WHERE id = ?').get(req.params.id);
      if (!pol) return res.status(404).json({ success: false, error: 'Política não encontrada' });
      const usos = db.prepare('SELECT COUNT(*) AS n FROM pessoas WHERE politicaPrazoId = ?').get(pol.id).n;
      if (usos) {
        return res.status(400).json({
          success: false,
          error: `${usos} cadastro(s) usam esta política. Desvincule-os ou inative a política.`,
        });
      }
      db.prepare('DELETE FROM politicas_prazo WHERE id = ?').run(pol.id);
      logAction(db, req, 'excluir', 'politica-prazo', pol.id, { nome: pol.nome });
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });
}

module.exports = { registrarRotasPoliticasPrazo, normalizarCorpo };
