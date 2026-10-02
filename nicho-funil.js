/**
 * nicho-funil.js — o NICHO de cada pessoa, que é o funil do CRM dela.
 *
 * Os 9 segmentos de `segmentos.js` falam do ramo do comércio (Bebidas,
 * Vestuário, Beleza…) e ficaram com o sufixo "(L)" porque são os da campanha
 * legado. O nicho é outra coisa: é a linha de `crm_funis` em que a empresa foi
 * posta quando os 63 mil leads de propensão entraram no CRM, em 24/09/2026, e
 * fala de para quem ela vende. Uma empresa de estética é "Beleza (L)" no
 * vocabulário antigo e "Outros e fora do perfil" no do funil, e os dois estão
 * certos — por isso cada contato guarda OS DOIS, em campos separados.
 *
 * A fonte da verdade dos nichos é o próprio `crm_funis`, só os ativos: nada é
 * copiado para a tabela `segmentos`. O campo da pessoa é
 * `pessoas.nichoFunilId`.
 *
 * O MAPA de ramo para nicho não está escrito em lugar nenhum: o agrupamento
 * dos 39 setores da planilha em 10 funis foi feito à mão naquele dia, e o que
 * sobrou dele são as descrições dos cards, que guardam o `Setor:` e o `Ramo:`
 * de cada empresa. `mapaDeNicho` reconstrói o agrupamento lendo os cards, e é
 * por isso que ele não tem de-para escrito à mão aqui.
 */
'use strict';

const NICHO_PADRAO = 'outros e fora do perfil';

const normalizar = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/^"+|"+$/g, '').trim().toLowerCase();

/** O valor de um campo da descrição do card ("Ramo: Comércio varejista de…"). */
function campoDaDescricao(descricao, nome) {
  const m = String(descricao || '').match(new RegExp('^' + nome + ': (.*)$', 'm'));
  return m ? m[1].trim() : '';
}

const temTabela = (db, t) => {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t); }
  catch { return false; }
};

const temColuna = (db, tabela, coluna) => {
  try { return db.prepare(`PRAGMA table_info(${tabela})`).all().some(c => c.name === coluna); }
  catch { return false; }
};

/** `pessoas.nichoFunilId`. Só aditivo, idempotente, e não mexe em segmento. */
function migrarNicho(db) {
  if (!temTabela(db, 'pessoas')) return;
  const cols = db.prepare('PRAGMA table_info(pessoas)').all().map(c => c.name);
  if (!cols.includes('nichoFunilId')) db.exec('ALTER TABLE pessoas ADD COLUMN nichoFunilId INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS idx_pessoas_nicho ON pessoas(nichoFunilId)');
}

/**
 * Os nichos que valem: funil ATIVO, na ordem do kanban. O funil excluído
 * (soft, `ativo = 0`) sai da lista, e é o caso do "Ligação Licitações", que
 * recebeu a importação e foi fechado depois.
 */
function listarNichos(db) {
  if (!temTabela(db, 'crm_funis')) return [];
  try {
    // A contagem entra só se a coluna já existe: sem esta guarda, um banco
    // antes da migração derrubava o SELECT inteiro e a tela ficava SEM nichos,
    // em vez de mostrá-los com zero.
    const temCol = temColuna(db, 'pessoas', 'nichoFunilId');
    const conta = temCol
      ? '(SELECT COUNT(*) FROM pessoas p WHERE p.nichoFunilId = f.id AND p.ativo = 1)'
      : '0';
    return db.prepare(`SELECT f.id, f.nome, f.ordem, ${conta} AS pessoas
      FROM crm_funis f WHERE f.ativo = 1 ORDER BY f.ordem, f.id`).all();
  } catch { return []; }
}

/**
 * "Outros e fora do perfil": o nicho de quem não casou com nenhum outro, e
 * para onde vai quem perde o seu. É o equivalente do Genérico (L) do lado do
 * funil. Tenant sem esse funil fica sem padrão, e aí o nicho continua vazio em
 * vez de receber um palpite.
 */
function nichoPadrao(db) {
  return listarNichos(db).find(f => normalizar(f.nome) === NICHO_PADRAO) || null;
}

const nichoValido = (db, id) => !!Number(id) && listarNichos(db).some(f => f.id === Number(id));

/**
 * O mapa que resolve o nicho de um contato, montado de uma vez a partir dos
 * cards do CRM. Sem cache de propósito: em produção o `db` de uma rota é o
 * proxy do contexto do tenant, e guardar isto num módulo chaveado pelo banco
 * arriscaria servir o mapa de um tenant a outro. Quem precisa monta uma vez,
 * fora do laço — é uma consulta.
 *
 * `nichoDe` tenta, nesta ordem:
 *   1. o card que já é DESTA pessoa (clienteId) ou do telefone dela;
 *   2. o ramo igual ao `Ramo:` de algum card;
 *   3. o ramo como começo de um ramo de card, e só quando todos os candidatos
 *      apontam para o mesmo nicho — a importação de 24/09 truncou o texto na
 *      vírgula, e `"Lanchonetes` é o começo de `Lanchonetes, casas de chá…`;
 *   4. o nicho padrão.
 */
function mapaDeNicho(db) {
  const porCliente = new Map(), porTelefone = new Map(), porRamo = new Map();
  const padrao = nichoPadrao(db);
  if (temTabela(db, 'crm_funis') && temTabela(db, 'crm_oportunidades')) {
    // `ORDER BY o.id`: a empresa com card em dois funis (1 em 26.589 no 1bit)
    // tem de cair sempre no mesmo, e sem isto quem decide é a ordem acidental
    // do SELECT — o mesmo defeito que o scan de IA já pagou.
    const cards = db.prepare(`SELECT o.clienteId, o.clienteTelefoneLivre AS telefone, o.descricao, o.funilId
      FROM crm_oportunidades o JOIN crm_funis f ON f.id = o.funilId
      WHERE o.ativo = 1 AND f.ativo = 1 ORDER BY o.id`).all();
    const votos = new Map();   // ramo -> Map(funilId -> quantas vezes)
    for (const c of cards) {
      if (c.clienteId && !porCliente.has(c.clienteId)) porCliente.set(c.clienteId, c.funilId);
      if (c.telefone && !porTelefone.has(c.telefone)) porTelefone.set(c.telefone, c.funilId);
      const ramo = normalizar(campoDaDescricao(c.descricao, 'Ramo'));
      if (!ramo) continue;
      if (!votos.has(ramo)) votos.set(ramo, new Map());
      const v = votos.get(ramo);
      v.set(c.funilId, (v.get(c.funilId) || 0) + 1);
    }
    // O ramo que aparece em dois funis fica com o mais frequente: na planilha
    // isso é cauda de 1 card contra centenas (medido: 52 ramos de 886).
    for (const [ramo, v] of votos) porRamo.set(ramo, [...v].sort((a, b) => b[1] - a[1])[0][0]);
  }
  const ramos = [...porRamo.keys()];

  function nichoDoRamo(ramo) {
    const r = normalizar(ramo);
    if (!r) return null;
    if (porRamo.has(r)) return porRamo.get(r);
    const candidatos = new Set();
    for (const x of ramos) if (x.startsWith(r)) candidatos.add(porRamo.get(x));
    return candidatos.size === 1 ? [...candidatos][0] : null;
  }

  function nichoDe({ pessoaId, telefone, ramo } = {}) {
    const doCard = (pessoaId && porCliente.get(Number(pessoaId))) || (telefone && porTelefone.get(telefone));
    if (doCard) return { nichoId: doCard, origem: pessoaId && porCliente.get(Number(pessoaId)) ? 'card' : 'telefone' };
    const doRamo = nichoDoRamo(ramo);
    if (doRamo) return { nichoId: doRamo, origem: 'ramo' };
    return { nichoId: padrao ? padrao.id : null, origem: padrao ? 'padrao' : 'nenhum' };
  }

  return { nichoDe, nichoDoRamo, padrao, cards: porTelefone.size, ramos: porRamo.size };
}

/** O GET do cadastro, para a ficha da pessoa e para as telas de comunicação. */
function registrarRotasNicho(app, db) {
  app.get('/api/pessoas/nichos', (_req, res) => {
    try { res.json({ success: true, nichos: listarNichos(db) }); }
    catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });
}

module.exports = {
  migrarNicho, listarNichos, nichoPadrao, nichoValido, mapaDeNicho,
  registrarRotasNicho, campoDaDescricao, normalizar,
};
