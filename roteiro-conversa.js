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

/**
 * O que o modelo devolveu, virado objeto. Devolve null quando não há JSON.
 *
 * Até 30/09 o valor de `chamar` ia direto para `roteiros.conferirExtracao`, que
 * o indexa por nome de chave (`bruto[p.chave]`). A suíte injetava um objeto
 * pronto e passava; a cadeia de IA devolve TEXTO, e indexar uma string por nome
 * dá `undefined` em toda chave. Resultado: nenhuma resposta aceita e nenhuma
 * recusada, ou seja, nada gravado e nada no log — o roteiro do 1bit ficou preso
 * na primeira etapa a tarde inteira, repetindo a mesma pergunta.
 *
 * O recorte entre chaves existe porque a groq, que é a primeira da cadeia,
 * devolve o JSON cercado de ```json e às vezes com uma linha de conversa antes.
 */
function objetoDaIA(bruto) {
  if (!bruto) return null;
  if (typeof bruto === 'object') return bruto;
  const s = String(bruto);
  const corpo = s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1);
  if (!corpo) return null;
  try { const o = JSON.parse(corpo); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
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
 * Campanha RECEBIDA conta pelo NÚMERO por onde ela saiu.
 *
 * Até 05/10/2026 o casamento era só pelo telefone, e isso fazia o escopo "só
 * quem recebeu campanha" vazar entre os números do tenant: no 1bit, a campanha
 * ao contato saiu pelo número Principal em 30/09, o contato mandou "oi" para o
 * número pessoal do atendente e a IA respondeu lá com a primeira etapa do
 * roteiro. Eram 4 conversas assim. Campanha que saiu por outro número não é
 * abordagem DESTE número.
 *
 * Envio sem canal (coluna nula, ou 0) é do canal PADRÃO: antes de haver vários
 * números, todo disparo saía pelo número único, e exigir igualdade crua
 * descartaria de uma vez as campanhas de um banco anterior aos canais.
 */
const MESMO_CANAL = (col) => `COALESCE(NULLIF(${col}, 0), ?) = ?`;

/** O número da conversa e o padrão do tenant, os dois já normalizados. */
function canaisDa(db, conversa) {
  let padrao = 0;
  try {
    const p = require('./whatsapp-canais').canalPadrao(db);
    padrao = (p && p.id) || 0;
  } catch (_) { /* tenant sem a tabela de números */ }
  return [padrao, Number(conversa && conversa.canalId) || padrao];
}

/**
 * A campanha mais recente que o contato da conversa RECEBEU por este número,
 * nova ou legado: { origem: 'wa'|'comm', id, roteiroId } ou null. Pelos últimos
 * 8 dígitos: o telefone da conversa vem do jid, às vezes sem o nono dígito.
 */
function campanhaDaConversa(db, conversa) {
  const tel = String(conversa.telefone || String(conversa.jid || '').split('@')[0] || '').replace(/\D/g, '');
  if (tel.length < 8) return null;
  const fim = tel.slice(-8);
  const canais = canaisDa(db, conversa);
  const achadas = [];
  if (temTabela(db, 'wa_campanha_dest')) {
    const d = db.prepare(`SELECT d.campanha_id AS id, d.enviado_em AS quando, c.config FROM wa_campanha_dest d
      JOIN wa_campanhas c ON c.id = d.campanha_id
      WHERE substr(d.telefone, -8) = ? AND d.enviado_em IS NOT NULL
        AND ${MESMO_CANAL('d.canalId')} ORDER BY d.enviado_em DESC LIMIT 1`).get(fim, ...canais);
    if (d) achadas.push({ origem: 'wa', id: d.id, quando: String(d.quando).replace(' ', 'T'),
      roteiroId: Number(jsonOu(d.config).roteiro_id) || null });
  }
  if (temTabela(db, 'comm_envios')) {
    const e = db.prepare(`SELECT e.campanhaId AS id, e.dataEnvio AS quando, c.roteiroId FROM comm_envios e
      JOIN comm_campanhas c ON c.id = e.campanhaId
      WHERE e.canal = 'whatsapp' AND e.status = 'enviado' AND substr(e.destino, -8) = ?
        AND ${MESMO_CANAL('e.canalId')} ORDER BY e.dataEnvio DESC LIMIT 1`).get(fim, ...canais);
    if (e) achadas.push({ origem: 'comm', id: e.id, quando: String(e.quando), roteiroId: e.roteiroId || null });
  }
  achadas.sort((a, b) => (a.quando < b.quando ? 1 : -1));
  return achadas[0] || null;
}

/**
 * Os pares "final de 8 dígitos + nosso número" que já receberam campanha.
 *
 * Uma consulta só, para a lista de conversas poder dizer em qual delas a IA
 * responde sem perguntar por linha: com o escopo em 'campanha', a marca verde
 * prometia atendimento automático em 683 conversas do 1bit que a IA nunca
 * atenderia. O critério de número é o mesmo do `campanhaDaConversa`.
 */
function abordadosPorCampanha(db) {
  const [padrao] = canaisDa(db, null);
  const set = new Set();
  const juntar = (linhas) => { for (const r of linhas) set.add(r.f + '|' + r.c); };
  if (temTabela(db, 'wa_campanha_dest')) {
    juntar(db.prepare(`SELECT substr(telefone, -8) AS f, COALESCE(NULLIF(canalId, 0), ?) AS c
      FROM wa_campanha_dest WHERE enviado_em IS NOT NULL AND telefone IS NOT NULL`).all(padrao));
  }
  if (temTabela(db, 'comm_envios')) {
    juntar(db.prepare(`SELECT substr(destino, -8) AS f, COALESCE(NULLIF(canalId, 0), ?) AS c
      FROM comm_envios WHERE canal = 'whatsapp' AND status = 'enviado' AND destino IS NOT NULL`).all(padrao));
  }
  return { set, padrao, tem: (conversa) => {
    const tel = String(conversa.telefone || String(conversa.jid || '').split('@')[0] || '').replace(/\D/g, '');
    if (tel.length < 8) return false;
    return set.has(tel.slice(-8) + '|' + (Number(conversa.canalId) || padrao));
  } };
}

/** Um instante em epoch, aceitando o ISO do envio e o `CURRENT_TIMESTAMP` do SQLite (que é UTC). */
function instante(v) {
  const s = String(v || '').trim();
  if (!s) return NaN;
  return Date.parse(/[TZ]|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

/**
 * A qualificação já começada na conversa, ou null.
 *
 * `desde` descarta registro ANTERIOR a esse instante, e é o que faz uma RODADA
 * NOVA da campanha recomeçar o roteiro: quem recebe a mensagem outra vez responde
 * de novo, e as respostas da rodada passada não valem mais.
 *
 * Sem isso, em 30/09, o reenvio da campanha 5 para o mesmo contato (rodada 18,
 * às 17:33) retomou na etapa 3, porque `preco_prato` e `custo_prato` estavam
 * gravados da rodada 17. O registro antigo NÃO é apagado: ele fica como
 * histórico, e o novo nasce na primeira resposta da rodada.
 */
function registroDa(db, conversaId, { desde } = {}) {
  if (!temTabela(db, 'roteiro_visitas')) return null;
  const reg = db.prepare('SELECT * FROM roteiro_visitas WHERE conversaId = ? ORDER BY id DESC LIMIT 1').get(conversaId);
  if (!reg) return null;
  const corte = instante(desde), nasceu = instante(reg.criadoEm);
  if (Number.isFinite(corte) && Number.isFinite(nasceu) && nasceu < corte) return null;
  return reg;
}

/** O instante do último envio de campanha ao contato, para cortar registro de rodada passada. */
function ultimoEnvioA(db, conversa) {
  const camp = campanhaDaConversa(db, conversa);
  return camp ? camp.quando : null;
}

/** O roteiro que vale na conversa (ver o topo do arquivo), ou null. */
function roteiroDaConversa(db, conversa) {
  if (!temTabela(db, 'roteiros')) return null;
  const camp = campanhaDaConversa(db, conversa);
  const reg = registroDa(db, conversa.id, { desde: camp && camp.quando });
  if (reg && reg.roteiroId) {
    const r = db.prepare('SELECT * FROM roteiros WHERE id = ? AND ativo = 1').get(reg.roteiroId);
    if (r) return r;
  }
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
function gravar(db, conversa, roteiro, respostas, { trechos = {}, usuario, desde } = {}) {
  const cfg = jsonOu(roteiro.config);
  const est = R.estado(cfg, respostas);
  // O mesmo corte de rodada da leitura: sem ele, a primeira resposta da rodada
  // nova daria UPDATE no registro da anterior, e o reinício não teria efeito.
  let reg = registroDa(db, conversa.id, { desde });
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

const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * A última fala do contato como escolha pelo NÚMERO da opção, gravada na hora.
 *
 * A guarda é a mensagem que veio ANTES dela: ela precisa conter o rótulo da
 * opção que o número aponta, ou seja, nós oferecemos aquela lista. Sem isso um
 * "2" qualquer — o número de pratos, a quantidade de caixas, um "2" de outro
 * assunto — viraria resposta do roteiro. Não achando, devolve null e a conversa
 * segue para a IA, como antes.
 */
function resolverNumero(db, conversa, roteiro, cfg, jaTem, historico, desde) {
  const etapa = R.estado(cfg, jaTem).etapa;
  if (!etapa) return null;
  const ultimaDoContato = [...historico].reverse().findIndex(m => !m.deMim);
  if (ultimaDoContato < 0) return null;
  const i = historico.length - 1 - ultimaDoContato;
  const id = R.respostaNumerica(etapa, historico[i].texto);
  if (!id) return null;
  const nossaAntes = historico.slice(0, i).reverse().find(m => m.deMim);
  const rotulo = (etapa.opcoes || []).find(o => o.id === id)?.rotulo;
  if (!nossaAntes || !rotulo || !semAcento(nossaAntes.texto).includes(semAcento(rotulo))) return null;
  const respostas = { ...jaTem, [etapa.chave]: id };
  return { mudou: true, porNumero: { chave: etapa.chave, resposta: id }, recusadas: [],
           ...gravar(db, conversa, roteiro, respostas,
                    { trechos: { [etapa.chave]: historico[i].texto }, usuario: 'numero', desde }) };
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
  // Rodada nova da campanha zera o que a anterior apurou (ver `registroDa`). O
  // corte vem ANTES da checagem de `fim`: um roteiro já concluído precisa poder
  // recomeçar quando o contato recebe a campanha outra vez.
  const desde = ultimoEnvioA(db, conversa);
  const reg = registroDa(db, conversa.id, { desde });
  const jaTem = reg ? jsonOu(reg.respostas) : {};
  if (R.estado(cfg, jaTem).fim) return null;

  const canalId = conversa.canalId || 0;
  const doNumero = canalId ? ' AND instance = (SELECT instance FROM whatsapp_canais WHERE id = ?)' : '';
  // O histórico também é cortado pela rodada, e sem isso o reinício não serve de
  // nada: zerar as respostas e continuar lendo as falas da rodada passada faz o
  // extrator reconstruir tudo na primeira mensagem. No ensaio de 30/09 um "sim"
  // marcou três etapas de uma vez e pulou para a quarta, lendo o que o contato
  // havia respondido nas rodadas anteriores.
  const inicio = instante(desde);
  const daRodada = Number.isFinite(inicio) ? ' AND timestamp >= ?' : '';
  // O `id DESC` desempata, e não é detalhe: o extrator lê a conversa EM PARES
  // (pergunta do atendente → resposta do contato), e o `timestamp` tem resolução
  // de segundo. Duas mensagens no mesmo segundo saíam em ordem arbitrária, os
  // pares se desfaziam e uma resposta curta como "nao" deixava de ter pergunta
  // acima dela. O `id` é autoincremento, logo é a ordem de chegada.
  const historico = db.prepare(`SELECT from_me AS deMim, texto FROM whatsapp_messages
    WHERE remote_jid = ?${doNumero}${daRodada} AND texto IS NOT NULL ORDER BY timestamp DESC, id DESC LIMIT 40`)
    .all(conversa.jid || conversa.telefone, ...(canalId ? [canalId] : []),
         ...(daRodada ? [Math.floor(inicio / 1000)] : []))
    .reverse().map(m => ({ deMim: !!m.deMim, texto: m.texto }));
  if (!historico.some(m => !m.deMim)) return null;

  // A escolha pelo NÚMERO da opção, resolvida aqui e sem gastar chamada: a
  // posição na lista é dado do roteiro, e não interpretação (ver
  // `roteiros.respostaNumerica`). Vem antes do prompt para a etapa já sair de
  // `faltam` — senão o extrator veria o "2" e tentaria explicá-lo.
  const porNumero = resolverNumero(db, conversa, roteiro, cfg, jaTem, historico, desde);
  if (porNumero) return porNumero;

  const { prompt, faltam } = R.promptExtracao(cfg, historico, jaTem);
  if (!faltam.length) return null;
  if (!chamar) {
    // A CADEIA (groq, gemini, cerebras, deepseek), e não o Gemini direto: até
    // 30/09 a qualificação só chamava `analise-ia.chamarGemini`, então bastava o
    // Gemini estar em 429 ou 503 — como ficou hoje — para o roteiro nunca marcar
    // resposta nenhuma, calado. O atendimento já usa esta cadeia.
    const { getIAKeys } = require('./config-helpers').createConfigHelpers(db);
    const keys = getIAKeys();
    if (!keys) return null;
    const modelos = require('./ia-modelos').resolverModelos(db);
    chamar = async (p) => {
      const out = await require('./chat-ia').chamarChatLLM([{ role: 'user', content: p }], keys, modelos);
      return (out && out.content) || '';
    };
  }
  const bruto = objetoDaIA(await chamar(prompt));
  if (!bruto) return null;
  const { aceitas, recusadas } = R.conferirExtracao(cfg, bruto, historico);
  // O trecho vai no log junto do motivo: sem ele, "trecho não está no que o
  // contato escreveu" não diz se o modelo inventou, parafraseou ou só copiou a
  // linha com o rótulo na frente — foi o que aconteceu em 30/09 às 16:58, e
  // descobrir exigiu refazer a chamada à mão.
  if (recusadas.length) console.warn('[roteiro] recusadas na conversa', conversa.id + ':',
    recusadas.map(r => `${r.chave} (${r.motivo}${r.valor ? `: ${JSON.stringify(String(r.valor).slice(0, 120))}` : ''})`).join(', '));
  if (!Object.keys(aceitas).length) return { mudou: false, recusadas, ...R.estado(cfg, jaTem) };
  const respostas = { ...jaTem }, trechos = {};
  for (const [k, v] of Object.entries(aceitas)) { respostas[k] = v.resposta; trechos[k] = v.trecho; }
  return { mudou: true, aceitas, recusadas, ...gravar(db, conversa, roteiro, respostas, { trechos, usuario: 'IA', desde }) };
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
    const reg = registroDa(db, conversaId, { desde: ultimoEnvioA(db, conversa) });
    const est = R.estado(cfg, reg ? jsonOu(reg.respostas) : {});
    // As variáveis ({{linkTrial}}, {{empresaNome}}) são trocadas aqui, como na
    // tela do roteiro: crua, a IA mandaria o marcador ao cliente.
    let empresa = {};
    try { empresa = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; } catch { /* sem cadastro */ }
    const txt = (v) => R.render(v, { empresa, valores: cfg.valores || {} });
    const regras = Array.isArray(cfg.conducao) ? cfg.conducao.filter(Boolean).map(txt) : [];
    // "qualificado", "desqualificado" e "roteiro" são palavras NOSSAS, e o
    // contato não pode lê-las: em 30/09 a IA abriu a mensagem com "Ótimo, como o
    // contato está qualificado, você pode iniciar o teste", que expõe ao cliente
    // que ele passou por uma triagem. O modelo parafraseia o que recebe, então a
    // proibição precisa vir escrita nos dois desfechos.
    const SEM_JARGAO = '\n- NUNCA escreva "qualificado", "desqualificado", "roteiro", "etapa" nem'
      + ' "triagem" na mensagem. São palavras internas, e ele não pode ler nenhuma delas.';
    if (est.fim && est.resultado === 'desqualificado') {
      return '\n\nROTEIRO ENCERRADO\n- Este contato não tem o perfil procurado. Não faça mais perguntas de qualificação.'
        + '\n- Responda o que ele perguntar com cordialidade, sem insistir na venda, e encerre a conversa.'
        + SEM_JARGAO;
    }
    if (est.fim) {
      // Com a mensagem de fim configurada, o `proximoPasso` NÃO vai ao prompt:
      // ela já foi enviada literal quando o roteiro fechou, e repetir a ordem
      // aqui faria a IA oferecer o link outra vez na mensagem seguinte.
      const temFim = !!R.mensagemDeFim(cfg, est.resultado);
      return '\n\nROTEIRO CONCLUÍDO\n- Este contato está qualificado. Não faça mais perguntas de qualificação.'
        + (!temFim && cfg.proximoPasso ? `\n- Próximo passo: ${txt(cfg.proximoPasso)}` : '')
        + SEM_JARGAO;
    }
    // A precedência precisa estar ESCRITA. As instruções da empresa mandam
    // coletar nome, CNPJ e número de usuários quando o contato demonstra
    // interesse, e em 30/09 a IA obedeceu essa linha em vez de perguntar a etapa
    // do roteiro: eram duas ordens imperativas e nada dizia qual vale.
    // A proibição é NOMEADA. "Esta pergunta vem antes" não bastou: em 30/09 a IA
    // continuou pedindo nome da empresa e número de usuários, porque as
    // instruções da empresa mandam justamente isso e ordem específica vence
    // pedido genérico. Nomear o que não fazer é o que muda o comportamento.
    // O link do teste grátis entrou na lista pelo mesmo motivo, e depois: as
    // instruções do canal do 1bit mandam "SEMPRE que o contato manifestar
    // interesse... ofereça o link de teste grátis". Um "Sim" à campanha É
    // interesse manifesto, então às 16:27 de 30/09 a IA mandou o trial em vez da
    // etapa 1. A proibição de coletar dados não alcançava esse caso, porque
    // oferecer link não é coletar nada.
    // A pergunta vai entre aspas e com o verbo NA SUA FRENTE ("faça ao
    // contato"). Solta no topo do prompt, ela era lida como pergunta dirigida
    // ao modelo: em 30/09, às 15:57, a IA EXPLICOU como se calcula o preço de um
    // prato pela ficha técnica e só então devolveu a pergunta reescrita.
    // As RESPOSTAS ACEITAS vão junto, e é o que faz a etapa destravar. Em 30/09,
    // às 17:15, o lead respondeu "o gerente, de uma em uma semana" a "Quem
    // controla o estoque?": não cabe em ninguem/caderno/sistema, a extração
    // recusou o id inventado "gerente", e a IA, sem saber que existiam três
    // caminhos, INVENTOU uma pergunta sobre ficha técnica, fora do roteiro.
    // Sabendo as opções, ela repete a pergunta oferecendo-as, e a resposta
    // seguinte casa.
    // As opções vão NUMERADAS, e a numeração é a ordem do roteiro (01/10): quem
    // está no celular responde "2" em vez de copiar o rótulo, e o número é
    // resolvido pelo Node, sem o modelo no meio (ver `resolverNumero`). Por isso
    // a ordem precisa ser sempre esta, e não a que o modelo achar melhor.
    const ops = R.opcoesNumeradas(est.etapa, txt);
    return '\n\nFAÇA ESTA PERGUNTA AO CONTATO, E ELA VEM ANTES DE QUALQUER OUTRA COISA\n'
      + `- Pergunta: "${txt(est.etapa.texto)}"\n`
      + '- Copie-a com ESTAS PALAVRAS. Ela é para o contato responder, e NÃO para você responder.\n'
      + '- Precisa reconhecer o que ele acabou de dizer? Uma frase curta antes, e a pergunta'
      + ' logo depois, sem mudar o que ela quer saber. Nunca dê a resposta dela no lugar dele.\n'
      + '- NÃO invente outra pergunta, nem desdobre esta em várias. É esta, e só esta.'
      + (ops.length ? '\n\nOFEREÇA ESTAS RESPOSTAS, UMA POR LINHA, COM O NÚMERO NA FRENTE\n'
        + ops.map(o => `${o.numero}) ${o.rotulo}`).join('\n')
        + '\n- Copie os números e os rótulos COMO ESTÃO, nesta ordem. Não reordene, não renumere,'
        + ' não junte duas numa linha e não reescreva o rótulo: é por esse número que a resposta dele'
        + ' é reconhecida, e um número fora de lugar grava a resposta errada.\n'
        + '- Feche dizendo que ele pode responder o número ou escrever com as palavras dele.\n'
        + '- A resposta dele não encaixou em nenhuma delas? Repita a pergunta com a mesma lista.'
        + ' Não siga adiante sem encaixar em uma.' : '')
      + '\n\nENQUANTO ESTA PERGUNTA NÃO FOR RESPONDIDA\n'
      + '- NÃO peça nome da empresa, CNPJ, e-mail, número de usuários, número de sites,'
      + ' nem qualquer dado para montar proposta ou orçamento, mesmo que as instruções'
      + ' mais abaixo mandem coletá-los.\n'
      + '- NÃO ofereça link de teste grátis, trial, demonstração, vídeo nem material,'
      + ' e não mande endereço nenhum. Vale inclusive quando ele disser que tem interesse,'
      + ' e inclusive contra a instrução mais abaixo que manda oferecer SEMPRE nesse caso.\n'
      + '- NÃO prometa que alguém vai retornar com proposta.\n'
      + '- Ele PEDIU o link, o preço ou uma explicação? Diga numa frase que já manda,'
      + ' e faça a pergunta na mesma mensagem. O link vai depois que ele responder.\n'
      + '- TODA mensagem sua termina com essa pergunta, sem exceção.\n'
      + '- Nada disso é recusa: é ordem. Tudo entra depois de o roteiro terminar.'
      + (regras.length ? '\n\nCOMO PERGUNTAR\n' + regras.map(r => `- ${r}`).join('\n') : '');
  } catch (_) { return ''; }
}

/**
 * A etapa pendente da conversa, ou null (sem roteiro, ou roteiro terminado).
 * Serve para quem precisa decidir fora do prompt, como a guarda abaixo.
 */
function etapaPendente(db, conversaId) {
  if (!conversaId) return null;
  try {
    const conversa = db.prepare('SELECT * FROM conv_conversas WHERE id = ?').get(conversaId);
    if (!conversa) return null;
    const roteiro = roteiroDaConversa(db, conversa);
    if (!roteiro) return null;
    const cfg = jsonOu(roteiro.config);
    const reg = registroDa(db, conversaId, { desde: ultimoEnvioA(db, conversa) });
    const est = R.estado(cfg, reg ? jsonOu(reg.respostas) : {});
    if (est.fim || !est.etapa) return null;
    let empresa = {};
    try { empresa = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; } catch { /* sem cadastro */ }
    return R.render(est.etapa.texto, { empresa, valores: cfg.valores || {} });
  } catch (_) { return null; }
}

/**
 * O desvio do roteiro (01/10): o contato pediu uma PESSOA, ou pediu o material.
 * Devolve `{ tipo, texto, desligarIA }`, ou null quando não é o caso.
 *
 * A redação é NOSSA e não da IA. Nos dois casos há efeito fora do texto — um
 * chama gente e pausa o atendimento automático, o outro manda um endereço que
 * a guarda `semLinkNoRoteiro` arrancaria durante o roteiro — e efeito não pode
 * depender de o modelo ter obedecido a instrução daquela vez.
 *
 * **As duas mensagens são do NÚMERO, e não do roteiro** (02/10/2026). Quem vê
 * um anúncio e pergunta o link nunca passou por campanha: o desvio tem de valer
 * para ele também. O roteiro só entra para saber qual pergunta recolocar depois
 * do material, quando há uma pendente.
 *
 * O pedido de material repete a pergunta da etapa junto, como a IA já faz quando
 * alguém pergunta o preço: a conversa não para para entregar um link. Sem
 * roteiro, ou com ele terminado, vai só o material.
 */
function desvioDaMensagem(db, conversa, texto) {
  try {
    const getter = require('./whatsapp-adapter').configDoAtendimento(db, conversa.canalId || null);
    const mensagens = { atendente: (getter('whatsapp_ai_resp_pessoa') || '').trim(),
                        material: (getter('whatsapp_ai_resp_material') || '').trim() };
    const tipo = R.desvioPedido(mensagens, texto);
    if (!tipo) return null;
    const roteiro = roteiroDaConversa(db, conversa);
    const cfg = roteiro ? jsonOu(roteiro.config) : {};
    let empresa = {};
    try { empresa = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; } catch { /* sem cadastro */ }
    const txt = (v) => R.render(v, { empresa, valores: cfg.valores || {} });
    const msg = txt(mensagens[tipo]).trim();
    if (!msg) return null;
    if (tipo === 'atendente') return { tipo, texto: msg, pausarIA: true };
    if (!roteiro) return { tipo, texto: msg, pausarIA: false };
    const reg = registroDa(db, conversa.id, { desde: ultimoEnvioA(db, conversa) });
    const est = R.estado(cfg, reg ? jsonOu(reg.respostas) : {});
    if (est.fim || !est.etapa) return { tipo, texto: msg, pausarIA: false };
    const ops = R.opcoesNumeradas(est.etapa, txt).map(o => `${o.numero}) ${o.rotulo}`);
    return { tipo, pausarIA: false,
             texto: [msg, '', txt(est.etapa.texto), ...ops].join('\n').trim() };
  } catch (e) { console.error('[roteiro] desvio:', e.message); return null; }
}

/**
 * A mensagem literal que fecha o roteiro, ou '' (02/10/2026).
 *
 * Quem pede uma pessoa e quem termina o roteiro qualificado ouvem a mesma
 * promessa — "alguém da equipe já está vindo" —, e por isso os dois pausam a
 * IA. O desqualificado é despedida: a mensagem sai e o atendimento automático
 * continua, porque não há ninguém para chamar.
 */
function mensagemDeTermino(db, conversa, resultado) {
  try {
    const roteiro = roteiroDaConversa(db, conversa);
    if (!roteiro) return '';
    const cfg = jsonOu(roteiro.config);
    const bruta = R.mensagemDeFim(cfg, resultado);
    if (!bruta) return '';
    let empresa = {};
    try { empresa = db.prepare('SELECT * FROM fornecedor ORDER BY id DESC LIMIT 1').get() || {}; } catch { /* sem cadastro */ }
    return R.render(bruta, { empresa, valores: cfg.valores || {} }).trim();
  } catch (e) { console.error('[roteiro] termino:', e.message); return ''; }
}

const RE_URL = /(https?:\/\/|\bwww\.)\S+/i;

/**
 * Tira o link da resposta da IA enquanto o roteiro estiver em andamento, e
 * garante que a pergunta da etapa esteja lá. Devolve o texto como deve sair.
 *
 * Por que uma guarda de CÓDIGO, e não mais uma linha de prompt: as instruções do
 * canal mandam "SEMPRE que o contato manifestar interesse... ofereça o link de
 * teste grátis", e um "sim" É interesse. A proibição no prompt foi escrita, e
 * reescrita, e em 30/09 às 17:33 e 17:34 a IA mandou o trial no meio do roteiro
 * do mesmo jeito, duas vezes seguidas. Pedido não vence pedido; o que vence é
 * não deixar passar.
 *
 * O corte é por FRASE, para não deixar texto truncado, e a pergunta da etapa é
 * recolocada quando o corte a levou junto.
 *
 * Duas coisas que ela NÃO fazia, e que custaram a conversa de 01/10 às 15:20:
 *
 * - **só agia quando havia link.** A resposta sem link que não fazia a pergunta
 *   da etapa passava inteira, e a IA perguntou "você tem interesse em conhecer o
 *   LiciteAgora?", que não existe em roteiro nenhum. A conversa ficou sem saída:
 *   a etapa seguia pendente e nada na mensagem pedia o que destravaria.
 * - **deixava órfã a frase que anunciava o link.** Tirada a linha do endereço,
 *   sobrou "Você pode testar 14 dias grátis agora pelo link abaixo:" sem link
 *   nenhum embaixo, o que é pior que não falar de link: promete e não entrega.
 */
const RE_ANUNCIA_LINK = /\b(link|endere[çc]o|acesse|clique|baixe)\b/i;

function semLinkNoRoteiro(db, conversaId, texto) {
  const original = String(texto || '');
  if (!original) return original;
  const etapa = etapaPendente(db, conversaId);
  if (!etapa) return original;                       // roteiro terminado: o link é o próximo passo
  const temLink = RE_URL.test(original);
  // Nada a fazer é o caso comum, e ele sai INTACTO: a reconstrução abaixo junta as
  // linhas com um \n só, e passar por ela acharia a linha em branco que o modelo
  // põe entre parágrafos — no WhatsApp isso vira um bloco de texto corrido.
  if (!temLink && semAcento(original).includes(semAcento(etapa))) return original;
  // Sobra com menos de três palavras é descartada: tirar a frase do link deixava
  // um "Claro!" sozinho na frente da pergunta, que é enchimento e não informa
  // nada a quem lê.
  const limpo = original.split(/\n+/)
    .map(linha => linha.split(/(?<=[.!?])\s+/)
      .filter(f => !RE_URL.test(f) && !(temLink && RE_ANUNCIA_LINK.test(f)))
      .join(' ').trim())
    .filter(l => l.split(/\s+/).filter(Boolean).length >= 3).join('\n').trim();
  if (limpo && semAcento(limpo).includes(semAcento(etapa))) return limpo;
  return limpo ? `${limpo}\n\n${etapa}` : etapa;
}

/** O roteiro escolhido numa campanha: id conferido, ou null (sem roteiro). Lança com o motivo. */
function roteiroEscolhido(db, valor) {
  if (valor == null || valor === '') return null;
  const id = Number(valor);
  const r = Number.isInteger(id) && db.prepare("SELECT id FROM roteiros WHERE id = ? AND ativo = 1 AND canal = 'whatsapp'").get(id);
  if (!r) throw new Error('Roteiro de qualificação não encontrado');
  return id;
}

module.exports = { migrar, roteiroEscolhido, campanhaDaConversa, abordadosPorCampanha, roteiroDaConversa, registroDa, criarOportunidade, gravar,
  qualificarPelaIA, blocoParaIA, etapaPendente, semLinkNoRoteiro, desvioDaMensagem, mensagemDeTermino };
