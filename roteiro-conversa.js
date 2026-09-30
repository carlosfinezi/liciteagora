/**
 * roteiro-conversa.js — o roteiro de qualificação dentro da conversa.
 *
 * Decidido em 29/09: cada campanha (nova ou legado) escolhe o seu roteiro, que
 * são ETAPAS a seguir (roteiros.estado). A IA do atendimento pergunta a etapa
 * atual; a cada mensagem do lead, a IA marca sozinha as respostas, com o trecho
 * que as sustenta; no fim, o lead fica qualificado (vira filtro e oportunidade
 * no CRM) ou desqualificado (vira filtro, e a IA encerra com cordialidade).
 *
 * Qual roteiro vale numa conversa:
 *   1. o que ela já começou (roteiro_visitas.roteiroId), para uma troca de
 *      campanha no meio não embaralhar as respostas;
 *   2. senão, o da campanha mais recente que o contato RECEBEU;
 *   3. senão, nenhum. Conversa fora de campanha não tem roteiro.
 *
 * O registro da qualificação continua em `roteiro_visitas` (o nome vem das
 * visitas presenciais, que saíram em 29/09), ligado à conversa por conversaId.
 */
'use strict';

const R = require('./roteiros');

const jsonOu = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const temTabela = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const colunas = (db, t) => { try { return db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name); } catch { return []; } };

function migrar(db) {
  if (temTabela(db, 'roteiro_visitas')) {
    const c = colunas(db, 'roteiro_visitas');
    if (!c.includes('resultado')) db.exec('ALTER TABLE roteiro_visitas ADD COLUMN resultado TEXT');
    if (!c.includes('finalizadoEm')) db.exec('ALTER TABLE roteiro_visitas ADD COLUMN finalizadoEm TEXT');
    if (!c.includes('trechos')) db.exec('ALTER TABLE roteiro_visitas ADD COLUMN trechos TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_roteiro_visitas_conversa ON roteiro_visitas(conversaId)');
  }
  if (temTabela(db, 'comm_campanhas') && !colunas(db, 'comm_campanhas').includes('roteiroId')) {
    db.exec('ALTER TABLE comm_campanhas ADD COLUMN roteiroId INTEGER');
  }
  // O roteiro presencial saiu com a página de visita, a pedido, em 29/09.
  // Desativado, e não apagado: o registro fica, sem tela nenhuma.
  if (temTabela(db, 'roteiros')) db.prepare("UPDATE roteiros SET ativo = 0 WHERE canal = 'visita' AND ativo = 1").run();
}

/**
 * A campanha mais recente que o contato da conversa RECEBEU, nova ou legado:
 * { origem: 'wa'|'comm', id, roteiroId } ou null. Pelos últimos 8 dígitos: o
 * telefone da conversa vem do jid, às vezes sem o nono dígito.
 */
function campanhaDaConversa(db, conversa) {
  const tel = String(conversa.telefone || String(conversa.jid || '').split('@')[0] || '').replace(/\D/g, '');
  if (tel.length < 8) return null;
  const fim = tel.slice(-8);
  const achadas = [];
  if (temTabela(db, 'wa_campanha_dest')) {
    const d = db.prepare(`SELECT d.campanha_id AS id, d.enviado_em AS quando, c.config FROM wa_campanha_dest d
      JOIN wa_campanhas c ON c.id = d.campanha_id
      WHERE substr(d.telefone, -8) = ? AND d.enviado_em IS NOT NULL ORDER BY d.enviado_em DESC LIMIT 1`).get(fim);
    if (d) achadas.push({ origem: 'wa', id: d.id, quando: String(d.quando).replace(' ', 'T'),
      roteiroId: Number(jsonOu(d.config).roteiro_id) || null });
  }
  if (temTabela(db, 'comm_envios')) {
    const e = db.prepare(`SELECT e.campanhaId AS id, e.dataEnvio AS quando, c.roteiroId FROM comm_envios e
      JOIN comm_campanhas c ON c.id = e.campanhaId
      WHERE e.canal = 'whatsapp' AND e.status = 'enviado' AND substr(e.destino, -8) = ?
      ORDER BY e.dataEnvio DESC LIMIT 1`).get(fim);
    if (e) achadas.push({ origem: 'comm', id: e.id, quando: String(e.quando), roteiroId: e.roteiroId || null });
  }
  achadas.sort((a, b) => (a.quando < b.quando ? 1 : -1));
  return achadas[0] || null;
}

/** A qualificação já começada na conversa, ou null. */
function registroDa(db, conversaId) {
  if (!temTabela(db, 'roteiro_visitas')) return null;
  return db.prepare('SELECT * FROM roteiro_visitas WHERE conversaId = ? ORDER BY id DESC LIMIT 1').get(conversaId) || null;
}

/** O roteiro que vale na conversa (ver o topo do arquivo), ou null. */
function roteiroDaConversa(db, conversa) {
  if (!temTabela(db, 'roteiros')) return null;
  const reg = registroDa(db, conversa.id);
  if (reg && reg.roteiroId) {
    const r = db.prepare('SELECT * FROM roteiros WHERE id = ? AND ativo = 1').get(reg.roteiroId);
    if (r) return r;
  }
  const camp = campanhaDaConversa(db, conversa);
  if (camp && camp.roteiroId) return db.prepare('SELECT * FROM roteiros WHERE id = ? AND ativo = 1').get(camp.roteiroId) || null;
  return null;
}

/**
 * Cria a oportunidade no CRM a partir da conversa, se ela ainda não tem.
 * `funilId` vazio usa o primeiro funil ativo, como o botão "Criar" da ficha.
 * Devolve o id, ou null (sem funil, sem etapa, ou já ligada).
 */
function criarOportunidade(db, conversa, { funilId, titulo, descricao, usuario } = {}) {
  if (conversa.oportunidadeId) return null;
  const f = funilId
    ? db.prepare('SELECT id FROM crm_funis WHERE id = ? AND ativo = 1').get(funilId)
    : db.prepare('SELECT id FROM crm_funis WHERE ativo = 1 ORDER BY ordem LIMIT 1').get();
  if (!f) return null;
  const e = db.prepare(`SELECT id FROM crm_etapas WHERE funilId = ? AND ativo = 1 AND tipo = 'normal'
    ORDER BY ordem LIMIT 1`).get(f.id);
  if (!e) return null;
  const topo = db.prepare('SELECT COALESCE(MIN(ordemManual), 0) - 1 AS o FROM crm_oportunidades WHERE etapaId = ? AND ativo = 1').get(e.id).o;
  const opId = Number(db.prepare(`INSERT INTO crm_oportunidades
      (funilId, etapaId, clienteId, clienteNomeLivre, titulo, descricao, valor, fonte, dataAbertura, ativo, ordemManual)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 'whatsapp', date('now','-3 hours'), 1, ?)`)
    .run(f.id, e.id, conversa.pessoaId || null, conversa.pessoaId ? null : (conversa.nome || conversa.telefone),
         String(titulo || `WhatsApp — ${conversa.nome || conversa.telefone}`).slice(0, 160),
         descricao || conversa.ultimaMensagem || null, topo).lastInsertRowid);
  db.prepare('UPDATE conv_conversas SET oportunidadeId = ? WHERE id = ?').run(opId, conversa.id);
  try {
    db.prepare('INSERT INTO conv_eventos (conversaId, tipo, detalhe, usuario) VALUES (?,?,?,?)')
      .run(conversa.id, 'oportunidade', 'criada #' + opId + ' (qualificado pelo roteiro)', usuario || 'roteiro');
  } catch { /* histórico é bônus */ }
  return opId;
}

/**
 * Grava as respostas da conversa, recalcula a etapa e o resultado, e, na
 * primeira vez que o lead fica qualificado, cria a oportunidade no CRM.
 * `trechos` (da IA) ficam junto, por chave. Devolve o estado.
 */
function gravar(db, conversa, roteiro, respostas, { trechos = {}, usuario } = {}) {
  const cfg = jsonOu(roteiro.config);
  const est = R.estado(cfg, respostas);
  let reg = registroDa(db, conversa.id);
  const todosTrechos = { ...(reg ? jsonOu(reg.trechos) : {}), ...trechos };
  const resultado = est.fim ? est.resultado : null;
  if (!reg) {
    const id = Number(db.prepare(`INSERT INTO roteiro_visitas (roteiroId, conversaId, pessoaId, empresa, whatsapp,
        respostas, pontos, resultado, finalizadoEm, trechos)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(roteiro.id, conversa.id, conversa.pessoaId || null, conversa.nome || null, conversa.telefone || null,
           JSON.stringify(respostas), est.pontos, resultado, resultado ? new Date().toISOString() : null,
           JSON.stringify(todosTrechos)).lastInsertRowid);
    reg = { id, resultado: null };
  } else {
    db.prepare(`UPDATE roteiro_visitas SET respostas = ?, pontos = ?, resultado = ?, trechos = ?,
        finalizadoEm = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(finalizadoEm, ?) END,
        dataAtualizacao = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(respostas), est.pontos, resultado, JSON.stringify(todosTrechos),
           resultado, new Date().toISOString(), reg.id);
  }
  let oportunidadeId = null;
  if (resultado === 'qualificado' && reg.resultado !== 'qualificado') {
    const conv = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(conversa.id);
    try {
      oportunidadeId = criarOportunidade(db, conv, { funilId: Number(cfg.funilId) || null, usuario,
        descricao: `Qualificado pelo roteiro "${roteiro.nome}" com ${est.pontos} ponto(s).` });
    } catch (e) { console.error('[roteiro] oportunidade:', e.message); }
  }
  return { ...est, registroId: reg.id, oportunidadeId };
}

/**
 * A IA marca as respostas do lead a partir da conversa (3a). Só o que ainda
 * não tem resposta; o trecho que sustenta cada uma precisa existir na conversa
 * (roteiros.conferirExtracao), e a IA não dá nota: a pontuação é a tabela.
 *
 * `chamar(prompt)` devolve o JSON do modelo; em produção, o Gemini da empresa.
 * Devolve null quando não há o que fazer (sem roteiro, roteiro terminado,
 * conversa curta, sem IA).
 */
async function qualificarPelaIA(db, conversa, { chamar } = {}) {
  const roteiro = roteiroDaConversa(db, conversa);
  if (!roteiro) return null;
  const cfg = jsonOu(roteiro.config);
  const reg = registroDa(db, conversa.id);
  const jaTem = reg ? jsonOu(reg.respostas) : {};
  if (R.estado(cfg, jaTem).fim) return null;

  const canalId = conversa.canalId || 0;
  const doNumero = canalId ? ' AND instance = (SELECT instance FROM whatsapp_canais WHERE id = ?)' : '';
  const historico = db.prepare(`SELECT from_me AS deMim, texto FROM whatsapp_messages
    WHERE remote_jid = ?${doNumero} AND texto IS NOT NULL ORDER BY timestamp DESC LIMIT 40`)
    .all(conversa.jid || conversa.telefone, ...(canalId ? [canalId] : []))
    .reverse().map(m => ({ deMim: !!m.deMim, texto: m.texto }));
  if (!historico.some(m => !m.deMim)) return null;

  const { prompt, faltam } = R.promptExtracao(cfg, historico, jaTem);
  if (!faltam.length) return null;
  if (!chamar) {
    const chave = db.prepare("SELECT valor FROM config WHERE chave = 'gemini_api_key'").get()?.valor;
    if (!chave) return null;
    const modelo = require('./ia-modelos').resolverModelo(db, 'gemini');
    chamar = (p) => require('./analise-ia').chamarGemini(chave, p, modelo, 1);
  }
  const bruto = await chamar(prompt);
  if (!bruto) return null;
  const { aceitas, recusadas } = R.conferirExtracao(cfg, bruto, historico);
  if (!Object.keys(aceitas).length) return { mudou: false, recusadas, ...R.estado(cfg, jaTem) };
  const respostas = { ...jaTem }, trechos = {};
  for (const [k, v] of Object.entries(aceitas)) { respostas[k] = v.resposta; trechos[k] = v.trecho; }
  return { mudou: true, aceitas, recusadas, ...gravar(db, conversa, roteiro, respostas, { trechos, usuario: 'IA' }) };
}

/**
 * O pedaço do roteiro que entra no prompt da IA do atendimento: a etapa atual
 * e como perguntar; no fim, o que fazer. Vazio sem roteiro.
 */
function blocoParaIA(db, conversaId) {
  if (!conversaId) return '';
  try {
    const conversa = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(conversaId);
    if (!conversa) return '';
    const roteiro = roteiroDaConversa(db, conversa);
    if (!roteiro) return '';
    const cfg = jsonOu(roteiro.config);
    const reg = registroDa(db, conversaId);
    const est = R.estado(cfg, reg ? jsonOu(reg.respostas) : {});
    // As variáveis ({{linkTrial}}, {{empresaNome}}) são trocadas aqui, como na
    // tela do roteiro: crua, a IA mandaria o marcador ao cliente.
    let empresa = {};
    try { empresa = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; } catch { /* sem cadastro */ }
    const txt = (v) => R.render(v, { empresa, valores: cfg.valores || {} });
    const regras = Array.isArray(cfg.conducao) ? cfg.conducao.filter(Boolean).map(txt) : [];
    if (est.fim && est.resultado === 'desqualificado') {
      return '\n\nROTEIRO ENCERRADO\n- Este contato não tem o perfil procurado. Não faça mais perguntas de qualificação.'
        + '\n- Responda o que ele perguntar com cordialidade, sem insistir na venda, e encerre a conversa.';
    }
    if (est.fim) {
      return '\n\nROTEIRO CONCLUÍDO\n- Este contato está qualificado. Não faça mais perguntas de qualificação.'
        + (cfg.proximoPasso ? `\n- Próximo passo: ${txt(cfg.proximoPasso)}` : '');
    }
    return '\n\nO QUE VOCÊ PRECISA DESCOBRIR AGORA\n- ' + txt(est.etapa.texto)
      + (regras.length ? '\n\nCOMO PERGUNTAR\n' + regras.map(r => `- ${r}`).join('\n') : '');
  } catch (_) { return ''; }
}

/** O roteiro escolhido numa campanha: id conferido, ou null (sem roteiro). Lança com o motivo. */
function roteiroEscolhido(db, valor) {
  if (valor == null || valor === '') return null;
  const id = Number(valor);
  const r = Number.isInteger(id) && db.prepare("SELECT id FROM roteiros WHERE id = ? AND ativo = 1 AND canal = 'whatsapp'").get(id);
  if (!r) throw new Error('Roteiro de qualificação não encontrado');
  return id;
}

module.exports = { migrar, roteiroEscolhido, campanhaDaConversa, roteiroDaConversa, registroDa, criarOportunidade, gravar,
  qualificarPelaIA, blocoParaIA };
